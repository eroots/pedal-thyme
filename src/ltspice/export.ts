// Export a Builder schematic as an LTspice schematic (.asc), keeping the layout.
//
// Coordinates are scaled ×1.6 (our 10-unit grid → LTspice's 16). LTspice symbols have different pin
// spacings, so each symbol is placed where its pins best match ours and short wires bridge the gap; a
// pin that can't be wired cleanly gets a net-name flag instead. Every net carries its name from our
// extraction, so jacks, rails and labels become LTspice flags, and the signal source and supplies are
// voltage sources drawn to the left of the circuit. Models and op-amp macromodels go in a directive.
import { taper } from '../core/pots';
import { clamp } from '../core/units';
import { modelLines, opAmpSubcktName, spiceNum, type UsedModels } from '../engine/spice';
import { extract } from '../schematic/extract';
import { toWorld, type Pt } from '../schematic/geometry';
import { PARTS } from '../schematic/library';
import type { PartKind, SchPart, Schematic } from '../schematic/types';
import { MODEL_SUFFIX, ORIENTS, ltTransform, onSeg, type LPt } from './asc';

export interface AscExportOptions {
  title?: string; fmin?: number; fmax?: number; notes?: string[];
  /** Add .meas lines reporting |V(out)| at these frequencies (for cross-checking). */
  measure?: number[];
}

/** `bulk`: a 4-terminal MOSFET's body pin, tied to its source by a net flag. */
interface LtSym { name: string; pins: Record<string, LPt>; bulk?: LPt }
const RES: LtSym = { name: 'res', pins: { '1': [16, 16], '2': [16, 96] } };
const SYMS: Partial<Record<PartKind, LtSym>> = {
  R: RES, RHEO: RES,
  C: { name: 'cap', pins: { '1': [16, 0], '2': [16, 64] } },
  L: { name: 'ind', pins: { '1': [16, 16], '2': [16, 96] } },
  D: { name: 'diode', pins: { a: [16, 0], k: [16, 64] } },
  LED: { name: 'LED', pins: { a: [16, 0], k: [16, 64] } },
  NPN: { name: 'npn', pins: { c: [64, 0], b: [0, 48], e: [64, 96] } },
  PNP: { name: 'pnp', pins: { c: [64, 0], b: [0, 48], e: [64, 96] } },
  NJF: { name: 'njf', pins: { d: [48, 0], g: [0, 64], s: [48, 96] } },
  PJF: { name: 'pjf', pins: { d: [48, 0], g: [0, 64], s: [48, 96] } },
  // LTspice's 3-pin nmos/pmos symbols are for VDMOS models; level-1 models need the 4-pin ones.
  NMOS: { name: 'nmos4', pins: { d: [48, 0], g: [0, 80], s: [48, 96] }, bulk: [48, 48] },
  PMOS: { name: 'pmos4', pins: { d: [48, 0], g: [0, 80], s: [48, 96] }, bulk: [48, 48] },
  OA: { name: 'OpAmps\\\\opamp', pins: { '+': [-32, 80], '-': [-32, 48], out: [32, 64] } },
  BUF: { name: 'e', pins: { out: [0, 16], in: [-48, 32] } },
};
/** Pins of the VCVS used for a buffer that go to ground. */
const E_GROUNDS: LPt[] = [[0, 96], [-48, 80]];

const K = 1.6;
const g16 = (v: number) => Math.round(v / 16) * 16;
const up = ([x, y]: Pt): LPt => [Math.round(x * K), Math.round(y * K)];
const key = ([x, y]: LPt) => `${x},${y}`;
const same = (a: LPt, b: LPt) => a[0] === b[0] && a[1] === b[1];
const man = (a: LPt, b: LPt) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** LTspice-safe net name; our automatic names (N001…) are renamed so they can't clash with LTspice's. */
function ltNetName(n: string): string {
  if (n === '0') return '0';
  if (/^N\d+$/.test(n)) return `n_${n.slice(1)}`;
  return n.replace(/[^\w+\-.]/g, '_') || 'net';
}

export function exportAsc(doc: Schematic, opt: AscExportOptions = {}): string {
  const ex = extract(doc);
  const netAt = (p: SchPart, pin: string) => ex.pinNet.get(`${p.id}:${pin}`) ?? '0';
  const out: string[] = ['Version 4', 'SHEET 1 1600 1000'];
  const wires: { a: LPt; b: LPt; net: string }[] = [];
  const flags: { at: LPt; name: string }[] = [];
  const symbols: string[] = [];

  // Our wires, split wherever a pin or another wire's end lies inside a segment (so every LTspice
  // connection is end-to-end), each tagged with its net.
  const pinPts: { at: LPt; net: string }[] = doc.parts.flatMap(p => PARTS[p.kind].pins.map(pin => ({ at: up(toWorld(p, pin.at)), net: netAt(p, pin.name) })));
  const wireNet = (pts: LPt[]): string => {
    for (const q of pinPts) if (pts.some((p, i) => same(p, q.at) || (i > 0 && onSeg(q.at, pts[i - 1], p)))) return q.net;
    return '';
  };
  const ourWires = doc.wires.map(w => ({ pts: w.pts.map(up), net: '' }));
  ourWires.forEach(w => { w.net = wireNet(w.pts); });
  // Wires touching no pin take the net of a wire they touch.
  for (let pass = 0; pass < 5; pass++) for (const w of ourWires) {
    if (w.net) continue;
    const o = ourWires.find(o => o.net && o !== w && (o.pts.some(p => w.pts.some((q, i) => i > 0 && onSeg(p, w.pts[i - 1], q))) || w.pts.some(p => o.pts.some((q, i) => i > 0 && onSeg(p, o.pts[i - 1], q)))));
    if (o) w.net = o.net;
  }
  const cuts = [...pinPts.map(p => p.at), ...ourWires.flatMap(w => [w.pts[0], w.pts[w.pts.length - 1]])];
  for (const w of ourWires) {
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      const inner = cuts.filter(c => onSeg(c, a, b) && !same(c, a) && !same(c, b))
        .sort((p, q) => man(p, a) - man(q, a));
      let prev = a;
      for (const c of [...inner, b]) { if (!same(prev, c)) wires.push({ a: prev, b: c, net: w.net }); prev = c; }
    }
  }

  // Occupied points (wire ends, flag points, symbol pins), by net, to keep new symbols and stubs clean.
  const points = new Map<string, Set<string>>();
  const mark = (p: LPt, net: string) => { const s = points.get(key(p)) ?? new Set(); s.add(net); points.set(key(p), s); };
  wires.forEach(w => { mark(w.a, w.net); mark(w.b, w.net); });
  pinPts.forEach(p => mark(p.at, p.net));
  const foreignAt = (p: LPt, net: string) => [...(points.get(key(p)) ?? [])].some(n => n !== net) || wires.some(w => w.net !== net && onSeg(p, w.a, w.b));
  const foreignOnSeg = (a: LPt, b: LPt, net: string) => {
    for (const [k, ns] of points) {
      if (![...ns].some(n => n !== net)) continue;
      const [x, y] = k.split(',').map(Number);
      if (onSeg([x, y], a, b)) return true;
    }
    return false;
  };
  const flag = (at: LPt, net: string) => { flags.push({ at, name: ltNetName(net) }); mark(at, net); };

  // Place an LTspice symbol whose pins should reach `targets` (our pin points, scaled), then wire them.
  function place(sym: LtSym, inst: string, attrs: [string, string][], targets: Record<string, { at: LPt; net: string }>, grounded: LPt[] = []): void {
    const names = Object.keys(targets);
    const T = names.map(n => targets[n].at);
    const cx = T.reduce((s, p) => s + p[0], 0) / T.length, cy = T.reduce((s, p) => s + p[1], 0) / T.length;
    let best: { o: string; x: number; y: number; score: number } | null = null;
    for (const o of ORIENTS) {
      const O = names.map(n => ltTransform(o, sym.pins[n]));
      const ox = O.reduce((s, p) => s + p[0], 0) / O.length, oy = O.reduce((s, p) => s + p[1], 0) / O.length;
      for (const dx of [0, -16, 16, -32, 32]) for (const dy of [0, -16, 16, -32, 32]) {
        const x = g16(cx - ox) + dx, y = g16(cy - oy) + dy;
        let score = O.reduce((s, p, i) => s + man([p[0] + x, p[1] + y], T[i]), 0) + (o.startsWith('M') ? 1 : 0);
        O.forEach((p, i) => { if (foreignAt([p[0] + x, p[1] + y], targets[names[i]].net)) score += 1e5; });
        for (const gp of grounded) { const p = ltTransform(o, gp); if (foreignAt([p[0] + x, p[1] + y], '0')) score += 1e5; }
        if (!best || score < best.score) best = { o, x, y, score };
      }
    }
    const { o, x, y } = best!;
    symbols.push(`SYMBOL ${sym.name} ${x} ${y} ${o}`, `SYMATTR InstName ${inst}`, ...attrs.map(([k, v]) => `SYMATTR ${k} ${v}`));
    names.forEach(n => {
      const lp = ltTransform(o, sym.pins[n]), p: LPt = [lp[0] + x, lp[1] + y], { at, net } = targets[n];
      mark(p, net);
      if (same(p, at)) return;
      const routes: LPt[][] = p[0] === at[0] || p[1] === at[1] ? [[p, at]] : [[p, [at[0], p[1]], at], [p, [p[0], at[1]], at]];
      const ok = routes.find(r => r.every((q, i) => i === 0 || !foreignOnSeg(r[i - 1], q, net)));
      if (ok) for (let i = 1; i < ok.length; i++) { wires.push({ a: ok[i - 1], b: ok[i], net }); mark(ok[i], net); }
      else { flag(p, net); flag(at, net); }
    });
    for (const gp of grounded) { const lp = ltTransform(o, gp); flag([lp[0] + x, lp[1] + y], '0'); }
    // LTspice ignores a wire drawn between two pins of one symbol, so the body joins its source by name.
    if (sym.bulk) {
      const b = ltTransform(o, sym.bulk), sp = ltTransform(o, sym.pins.s);
      flag([b[0] + x, b[1] + y], targets.s.net);
      flag([sp[0] + x, sp[1] + y], targets.s.net);
    }
  }

  const used: UsedModels = { opamps: new Set(), diodes: new Set(), bjts: new Set(), jfets: new Set(), mosfets: new Set() };
  const sources: { inst: string; net: string; value: string; value2?: string }[] = [];
  const knobs: string[] = [];
  const inst = (p: SchPart) => (p.ref || p.id).replace(/[^\w]/g, '_');
  const tgt = (p: SchPart, pin: string) => ({ at: up(toWorld(p, PARTS[p.kind].pins.find(q => q.name === pin)!.at)), net: netAt(p, pin) });
  const supplyNets = new Set<string>();
  for (const p of doc.parts) {
    const name = inst(p);
    switch (p.kind) {
      case 'GND': case 'LABEL': case 'OUT': flag(tgt(p, PARTS[p.kind].pins[0].name).at, tgt(p, PARTS[p.kind].pins[0].name).net); break;
      case 'IN': {
        const t = tgt(p, 'io');
        flag(t.at, t.net);
        sources.push({ inst: 'V_IN', net: t.net, value: 'SINE(0 100m 1k)', value2: 'AC 1' });
        break;
      }
      case 'SUPPLY': {
        const t = tgt(p, 'v');
        flag(t.at, t.net);
        if (!supplyNets.has(t.net)) { supplyNets.add(t.net); sources.push({ inst: `V_${name}`, net: t.net, value: spiceNum(p.value ?? 9) }); }
        break;
      }
      case 'PROBE': break;
      case 'SW': case 'SPDT': {
        // A closed switch joins its pins' nets, which our extraction already merged: flag both ends.
        const pins = p.kind === 'SW' ? (p.props?.closed ? ['1', '2'] : []) : ['c', p.props?.pos === 'b' ? 'b' : 'a'];
        for (const pin of pins) { const t = tgt(p, pin); flag(t.at, t.net); }
        knobs.push(`${p.ref || p.id}: ${p.kind === 'SW' ? (p.props?.closed ? 'closed' : 'open') : `to ${p.props?.pos ?? 'a'}`}`);
        break;
      }
      case 'POT': {
        const turn = p.props?.turn ?? 0.5, tp = p.props?.taper ?? 'B', R = p.value ?? 100e3;
        const f = clamp(taper(turn, tp), 1e-4, 1 - 1e-4);
        place(RES, `${name}_a`, [['Value', spiceNum(R * f)]], { '1': tgt(p, '1'), '2': tgt(p, 'w') });
        place(RES, `${name}_b`, [['Value', spiceNum(R * (1 - f))]], { '1': tgt(p, 'w'), '2': tgt(p, '3') });
        knobs.push(`${p.ref || p.id}: ${spiceNum(R)} ${tp} pot at ${(turn * 10).toFixed(1)}/10 (two resistors)`);
        break;
      }
      case 'RHEO': {
        const turn = p.props?.turn ?? 0.5, tp = p.props?.taper ?? 'B', R = p.value ?? 100e3;
        place(RES, name, [['Value', spiceNum(Math.max(1, R * taper(turn, tp)))]], { '1': tgt(p, '1'), '2': tgt(p, '2') });
        knobs.push(`${p.ref || p.id}: ${spiceNum(R)} ${tp} variable resistor at ${(turn * 10).toFixed(1)}/10`);
        break;
      }
      default: {
        const sym = SYMS[p.kind];
        if (!sym) break;
        const targets = Object.fromEntries(Object.keys(sym.pins).map(pin => [pin, tgt(p, pin)]));
        const attrs: [string, string][] = [];
        const model = p.props?.model;
        if (p.kind === 'R' || p.kind === 'C' || p.kind === 'L') attrs.push(['Value', spiceNum(p.value ?? 0)]);
        else if (p.kind === 'OA') { used.opamps.add(model ?? 'ideal'); attrs.push(['Value', opAmpSubcktName(model ?? 'ideal')]); }
        else if (p.kind === 'BUF') attrs.push(['Value', '1']);
        else if (model) {
          attrs.push(['Value', model + MODEL_SUFFIX]);
          if (p.kind === 'NMOS' || p.kind === 'PMOS') attrs.push(['SpiceLine', 'W=1 L=1']); // see MosModel
          (p.kind === 'D' || p.kind === 'LED' ? used.diodes : p.kind === 'NPN' || p.kind === 'PNP' ? used.bjts : p.kind === 'NJF' || p.kind === 'PJF' ? used.jfets : used.mosfets).add(model);
        }
        place(sym, name, attrs, targets, p.kind === 'BUF' ? E_GROUNDS : []);
      }
    }
  }

  // Sources to the left of the drawing: + to the net (by flag), − to ground.
  const xs = [...wires.flatMap(w => [w.a[0], w.b[0]]), ...flags.map(f => f.at[0]), ...pinPts.map(p => p.at[0])];
  const ys = [...wires.flatMap(w => [w.a[1], w.b[1]]), ...flags.map(f => f.at[1]), ...pinPts.map(p => p.at[1])];
  const x0 = g16(Math.min(0, ...xs)) - 160, y0 = g16(Math.min(0, ...ys)), y1 = g16(Math.max(0, ...ys));
  sources.forEach((s, i) => {
    const x = x0 - i * 128, y = y0;
    symbols.push(`SYMBOL voltage ${x} ${y} R0`, `SYMATTR InstName ${s.inst}`, `SYMATTR Value ${s.value}`, ...(s.value2 ? [`SYMATTR Value2 ${s.value2}`] : []));
    flags.push({ at: [x, y + 16], name: ltNetName(s.net) }, { at: [x, y + 96], name: '0' });
  });

  for (const w of wires) out.push(`WIRE ${w.a[0]} ${w.a[1]} ${w.b[0]} ${w.b[1]}`);
  for (const f of flags) out.push(`FLAG ${f.at[0]} ${f.at[1]} ${f.name}`);
  out.push(...symbols);
  // Directives and comments under the drawing.
  const lib = modelLines(used, 'n-p', MODEL_SUFFIX);
  const meas = (opt.measure ?? []).map(f => `.meas AC g${Math.round(f)} FIND mag(V(out)) AT ${spiceNum(f)}`);
  const directive = [`.ac dec 100 ${spiceNum(opt.fmin ?? 10)} ${spiceNum(opt.fmax ?? 100e3)}`, ...meas, ...lib].join('\\n');
  out.push(`TEXT ${x0} ${y1 + 64} Left 2 !${directive}`);
  const comments = [opt.title ? `${opt.title} (exported from Pedal Filter Lab)` : 'Exported from Pedal Filter Lab', ...(knobs.length ? ['Knobs: ' + knobs.join('; ')] : []), ...(opt.notes ?? [])];
  comments.forEach((c, i) => out.push(`TEXT ${x0} ${y0 - 64 - 32 * (comments.length - 1 - i)} Left 2 ;${c.replace(/\n/g, ' ')}`));
  for (const n of doc.notes ?? []) { const [x, y] = up([n.x, n.y]); out.push(`TEXT ${x} ${y} Left 2 ;${n.text.replace(/\n/g, ' ')}`); }
  return out.join('\n') + '\n';
}
