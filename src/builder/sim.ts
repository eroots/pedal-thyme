// Builder simulation: responses at the output jack and at probes, with an optional source/load,
// plus the document variants used for sweeps and tolerance bands. Pure functions (no DOM).
import { Cx } from '../core/complex';
import { potFraction } from '../core/pots';
import { termAt, type Term } from '../core/termination';
import { TAU, db, fmtEng } from '../core/units';
import type { OpPoint } from '../engine/dc';
import { acModel, type AcModel } from '../engine/linearize';
import type { Netlist, Node } from '../engine/netlist';
import { extract, type Extraction } from '../schematic/extract';
import { probeColor } from '../schematic/library';
import type { SchPart, Schematic } from '../schematic/types';
import { gangOf, updatePart } from './doc';

/** A pot's or switch's name on the front panel: its ref, or all its gang's refs ("VR1+VR2"). */
export const knobName = (doc: Schematic, p: SchPart): string => gangOf(doc, p.id).map(q => q.ref || q.id).join('+');

export interface Curve { mag: number[]; ph: number[] }
export interface ProbeCurve extends Curve { ref: string; color: string; net: Node }
export interface SimResult { out: Curve; probes: ProbeCurve[]; op: OpPoint | null }

/** Biased, linearised circuit for an extraction (cached per netlist object). */
const models = new WeakMap<Netlist, AcModel>();
export function modelOf(ex: Extraction): AcModel {
  let m = models.get(ex.netlist);
  if (!m) { m = acModel(ex.netlist); models.set(ex.netlist, m); }
  return m;
}

/** DC operating point (null if the circuit has no semiconductors). */
export const biasOf = (ex: Extraction): OpPoint | null => modelOf(ex).op;

/** Probes in the document and the nets they sit on (unconnected probes are skipped). */
export function probesOf(doc: Schematic, ex: Extraction): { ref: string; color: string; net: Node }[] {
  return doc.parts.filter(p => p.kind === 'PROBE').flatMap(p => {
    const members = [...ex.nets.entries()].find(([, ms]) => ms.some(m => m.part.id === p.id && m.pin === 'p'));
    // A probe alone on its net measures nothing.
    if (!members || members[1].length < 2) return [];
    return [{ ref: p.ref || p.id, color: probeColor(p.ref), net: members[0] }];
  });
}

/**
 * V(output) and V(probe nets) relative to the source voltage, over `freqs`. The source sits behind
 * the termination's impedance (and cable capacitance); the load hangs on the output jack.
 */
export function simulate(ex: Extraction, probes: { ref: string; color: string; net: Node }[], freqs: number[], term?: Term | null): SimResult {
  const { circuit: c, op } = modelOf(ex);
  const out: Curve = { mag: [], ph: [] };
  const pc: ProbeCurve[] = probes.map(p => ({ ...p, mag: [], ph: [] }));
  const push = (curve: Curve, h: Cx) => { curve.mag.push(db(h.abs())); curve.ph.push(h.arg() * 180 / Math.PI); };
  for (const f of freqs) {
    const s = new Cx(0, TAU * f), z = termAt(term, s);
    const sol = c.solve(s, { zs: z.zs, zl: z.zl });
    push(out, sol.v(ex.netlist.output).mul(z.g));
    pc.forEach(p => push(p, sol.v(p.net).mul(z.g)));
  }
  return { out, probes: pc, op };
}

/** Input and output impedance at frequency f (Zin sees the load, Zout sees the source). */
export function impedances(ex: Extraction, f: number, term?: Term | null): { zin: number; zout: number } {
  const c = modelOf(ex).circuit, s = new Cx(0, TAU * f), z = termAt(term, s);
  return { zin: c.zin(s, z.zl).abs(), zout: c.zout(s, z.zs).abs() };
}

/* ---------- Sweeps ---------- */
export interface SweepTarget { id: string; label: string }
export interface Variant { label: string; r: number; doc: Schematic }

/** Parts that can be swept: values, pot rotation, and switch positions. */
export const SWEEPABLE_KINDS = ['R', 'C', 'L', 'POT', 'RHEO', 'SW', 'SPDT', 'ONOFFON'];
const SWITCHES = ['SW', 'SPDT', 'ONOFFON'];

/** A switch's positions, in order, with the props for each and a short label. */
export function switchPositions(kind: string): { label: string; props: SchPart['props'] }[] {
  if (kind === 'SW') return [{ label: 'off', props: { closed: false } }, { label: 'on', props: { closed: true } }];
  if (kind === 'ONOFFON') return [{ label: 'A', props: { pos: 'a' } }, { label: 'off', props: { pos: 'off' } }, { label: 'B', props: { pos: 'b' } }];
  return [{ label: 'A', props: { pos: 'a' } }, { label: 'B', props: { pos: 'b' } }];
}

/**
 * Sweep options for parts marked Sweepable: pots sweep their rotation, and any marked R, C, L or
 * pot can sweep its value (÷3 … ×3, log-spaced).
 */
export function sweepTargets(doc: Schematic): SweepTarget[] {
  const marked = doc.parts.filter(p => SWEEPABLE_KINDS.includes(p.kind) && p.ref && p.props?.sweep);
  // A gang is one knob: one rotation target for it, whichever of its pots is marked.
  const pots = marked.filter((p, i, all) => (p.kind === 'POT' || p.kind === 'RHEO') && (!p.props?.gang || all.findIndex(q => q.props?.gang === p.props!.gang) === i));
  const valued = marked.filter(p => (p.value ?? 0) > 0 && !SWITCHES.includes(p.kind));
  const switches = marked.filter((p, i, all) => SWITCHES.includes(p.kind) && (!p.props?.gang || all.findIndex(q => q.props?.gang === p.props!.gang) === i));
  return [
    ...pots.map(p => ({ id: `turn:${p.id}`, label: `${knobName(doc, p)} rotation` })),
    ...valued.map(p => ({ id: `value:${p.id}`, label: `${p.ref} value (÷3 … ×3)` })),
    ...switches.map(p => ({ id: `pos:${p.id}`, label: `${knobName(doc, p)} position (${switchPositions(p.kind).map(s => s.label).join(' / ')})` })),
  ];
}

const withPart = (doc: Schematic, id: string, patch: (p: SchPart) => SchPart): Schematic =>
  ({ ...doc, parts: doc.parts.map(p => (p.id === id ? patch(p) : p)) });

export function sweepVariants(doc: Schematic, targetId: string, steps: number): Variant[] {
  const [kind, id] = targetId.split(':');
  const part = doc.parts.find(p => p.id === id);
  if (!part) return [];
  if (kind === 'pos') {
    // One curve per switch position (the Steps setting doesn't apply); linked poles switch together.
    const pos = switchPositions(part.kind);
    return pos.map((s, i) => ({ label: `${knobName(doc, part)} ${s.label}`, r: pos.length > 1 ? i / (pos.length - 1) : 0, doc: updatePart(doc, id, { props: s.props }) }));
  }
  const n = Math.max(2, Math.min(15, Math.round(steps)));
  return Array.from({ length: n }, (_, i) => {
    const r = i / (n - 1);
    if (kind === 'turn') {
      // The whole gang turns (updatePart moves every pot on the shaft).
      const v = updatePart(doc, id, { props: { turn: r } });
      return { label: `${knobName(doc, part)} ${(r * 10).toFixed(1)}`, r, doc: v };
    }
    const value = (part.value ?? 1) / 3 * Math.pow(9, r);
    const unit = part.kind === 'C' ? 'F' : part.kind === 'L' ? 'H' : 'Ω';
    return { label: `${part.ref} ${fmtEng(value, unit)}`, r, doc: withPart(doc, id, p => ({ ...p, value })) };
  });
}

/* ---------- Tolerance ---------- */
/**
 * Value variations for a tolerance band: each run sets every R/pot/L to ±rTol and every C to ±cTol
 * at random corners (a fixed seed, so the band doesn't flicker). Run 0 is all-low, run 1 all-high.
 */
export function toleranceVariants(doc: Schematic, rTolPct: number, cTolPct: number, runs = 40): Schematic[] {
  let seed = 9876;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const out: Schematic[] = [];
  for (let k = 0; k < runs; k++) {
    out.push({
      ...doc, parts: doc.parts.map(p => {
        if (!['R', 'C', 'L', 'POT', 'RHEO'].includes(p.kind) || !(p.value! > 0)) return p;
        const tol = (p.kind === 'C' ? cTolPct : rTolPct) / 100;
        const sign = k === 0 ? -1 : k === 1 ? 1 : rnd() < 0.5 ? -1 : 1;
        return { ...p, value: p.value! * (1 + sign * tol) };
      }),
    });
  }
  return out;
}

/** Min/max envelope of the output magnitude across document variants. */
export function band(docs: Schematic[], freqs: number[], term?: Term | null, wrap: (ex: Extraction) => Extraction = x => x): { lo: number[]; hi: number[] } {
  const lo = freqs.map(() => Infinity), hi = freqs.map(() => -Infinity);
  for (const d of docs) {
    const ex = extract(d);
    if (ex.issues.some(i => i.severity === 'error')) continue;
    const { out } = simulate(wrap(ex), [], freqs, term);
    out.mag.forEach((y, i) => { if (y < lo[i]) lo[i] = y; if (y > hi[i]) hi[i] = y; });
  }
  return { lo, hi };
}

/** Front-panel controls in a document: pots and switches, in reading order. */
export function controlsOf(doc: Schematic): SchPart[] {
  return doc.parts.filter(p => ['POT', 'RHEO', 'SW', 'SPDT', 'ONOFFON'].includes(p.kind))
    .sort((a, b) => (a.ref || '').localeCompare(b.ref || '', undefined, { numeric: true }));
}

/** Fraction of the track between pin 1 and the wiper (for knob drawings). */
export const wiperFraction = (p: SchPart): number => potFraction(p.props?.turn ?? 0.5, p.props?.taper ?? 'B', p.props?.reverse);
