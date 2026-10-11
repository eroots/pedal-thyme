// Import an LTspice schematic (.asc) as a Builder schematic.
//
// Connectivity comes from the LTspice drawing (its nets), and the layout is kept: positions are scaled
// from LTspice's 16-unit grid to ours (×10/16). Our symbols have different pin spacings, so each part is
// placed where its pins best match LTspice's and short wire stubs bridge the difference. The result is
// then extracted and compared net-for-net with the LTspice nets; any pin that doesn't match is
// reconnected with a net label instead, so the imported circuit is electrically the same.
import { TAPERS, type TaperKey } from '../core/pots';
import { DIODE_MODELS, OPAMP_MODELS } from '../engine/models';
import { BJT_MODELS, JFET_MODELS, MOS_MODELS } from '../engine/semis';
import { reattach } from '../builder/doc';
import { extract } from '../schematic/extract';
import { toWorld, type Pt } from '../schematic/geometry';
import { PARTS, boxOf, labelLen } from '../schematic/library';
import type { PartKind, PartProps, Rot, SchPart, Schematic } from '../schematic/types';
import {
  MODEL_SUFFIX, evalValue, ltNets, ltPieces, readSteps, ltTransform, onSeg, parseAsc, parseAsy, readModels, readParams, symbolBase,
  type AscSymbol, type AsySymbol, type LPt,
} from './asc';
import { OPAMP_GEOMETRIES, OPAMP_SYMBOLS } from './opamp-pins';
import { SYMBOL_PINS } from './symbol-pins';

export interface ImportResult {
  schematic: Schematic;
  /** Human-readable notes: substitutions, skipped parts, connections made with labels. */
  report: string[];
  /** Parts imported / skipped. */
  stats: { parts: number; skipped: number; labelled: number; layout: 'attached' | 'stubs'; attachIssues: string[] };
}

type Role = PartKind | 'V';
interface SymMap { kind: Role; pins: Record<string, LPt> }

const TWO_R = { '1': [16, 16] as LPt, '2': [16, 96] as LPt };
const TWO_C = { '1': [16, 0] as LPt, '2': [16, 64] as LPt };
const DIODE = { a: [16, 0] as LPt, k: [16, 64] as LPt };
const BJT = { c: [64, 0] as LPt, b: [0, 48] as LPt, e: [64, 96] as LPt };
const JFET = { d: [48, 0] as LPt, g: [0, 64] as LPt, s: [48, 96] as LPt };
const MOS = { d: [48, 0] as LPt, g: [0, 80] as LPt, s: [48, 96] as LPt };
const VSRC = { '+': [0, 16] as LPt, '-': [0, 96] as LPt };

/** Built-in LTspice symbols (pin positions from lib/sym/*.asy) → our part kinds and pin names. */
const BUILTIN: Record<string, SymMap> = {
  res: { kind: 'R', pins: TWO_R }, res2: { kind: 'R', pins: TWO_R }, europeanresistor: { kind: 'R', pins: TWO_R },
  cap: { kind: 'C', pins: TWO_C }, polcap: { kind: 'C', pins: TWO_C }, europeancap: { kind: 'C', pins: TWO_C }, europeanpolcap: { kind: 'C', pins: TWO_C },
  ind: { kind: 'L', pins: TWO_R }, ind2: { kind: 'L', pins: TWO_R },
  diode: { kind: 'D', pins: DIODE }, zener: { kind: 'D', pins: DIODE }, schottky: { kind: 'D', pins: DIODE }, varactor: { kind: 'D', pins: DIODE },
  led: { kind: 'LED', pins: DIODE },
  npn: { kind: 'NPN', pins: BJT }, npn2: { kind: 'NPN', pins: BJT }, npn3: { kind: 'NPN', pins: BJT }, npn4: { kind: 'NPN', pins: BJT },
  pnp: { kind: 'PNP', pins: BJT }, pnp2: { kind: 'PNP', pins: BJT }, pnp4: { kind: 'PNP', pins: BJT },
  njf: { kind: 'NJF', pins: JFET }, pjf: { kind: 'PJF', pins: JFET },
  nmos: { kind: 'NMOS', pins: MOS }, nmos4: { kind: 'NMOS', pins: MOS }, pmos: { kind: 'PMOS', pins: MOS }, pmos4: { kind: 'PMOS', pins: MOS },
  voltage: { kind: 'V', pins: VSRC }, signal: { kind: 'V', pins: VSRC }, battery: { kind: 'V', pins: VSRC },
  cell: { kind: 'V', pins: { '+': [0, 0], '-': [0, 64] } },
  // A VCVS imports as a unity buffer when its gain is 1 and its − and N pins are grounded.
  e: { kind: 'BUF', pins: { out: [0, 16], in: [-48, 32], gnd: [0, 96], gndc: [-48, 80] } },
};

/** Map a user-supplied symbol (.asy) by its prefix and pin names. */
function mapAsy(base: string, a: AsySymbol): SymMap | null {
  const P = a.prefix.toUpperCase(), pins = a.pins;
  const by = (re: RegExp) => pins.find(p => re.test(p.name));
  if (/pot/i.test(base) && pins.length === 3) {
    const w = by(/^(w|wiper|wip|2|middle|m)$/i) ?? pins[1];
    const ends = pins.filter(p => p !== w);
    return { kind: 'POT', pins: { '1': ends[0].at, w: w.at, '3': ends[1].at } };
  }
  const inP = by(/^(in\+|\+in|noninvin|inp|\+)$/i), inN = by(/^(in-|-in|invin|inn|-)$/i), out = by(/^(out|output|vout)$/i);
  if (inP && inN && out && (P === 'X' || P === 'U')) return { kind: 'OA', pins: { '+': inP.at, '-': inN.at, out: out.at } };
  const two = pins.length >= 2 ? { '1': pins[0].at, '2': pins[1].at } : null;
  if (P === 'R' && two) return { kind: 'R', pins: two };
  if (P === 'C' && two) return { kind: 'C', pins: two };
  if (P === 'L' && two) return { kind: 'L', pins: two };
  if (P === 'D' && two) return { kind: /led/i.test(base) ? 'LED' : 'D', pins: { a: pins[0].at, k: pins[1].at } };
  const tri = (names: [RegExp, RegExp, RegExp]) => { const r = names.map(by); return r.every(Boolean) ? r.map(p => p!.at) : null; };
  if (P.startsWith('Q')) { const r = tri([/^c$/i, /^b$/i, /^e$/i]); if (r) return { kind: P === 'QP' || /pnp/i.test(base) ? 'PNP' : 'NPN', pins: { c: r[0], b: r[1], e: r[2] } }; }
  if (P.startsWith('J')) { const r = tri([/^d$/i, /^g$/i, /^s$/i]); if (r) return { kind: P === 'JP' ? 'PJF' : 'NJF', pins: { d: r[0], g: r[1], s: r[2] } }; }
  if (P.startsWith('M')) { const r = tri([/^d$/i, /^g$/i, /^s$/i]); if (r) return { kind: P === 'MP' || /pmos|p-?ch/i.test(base) ? 'PMOS' : 'NMOS', pins: { d: r[0], g: r[1], s: r[2] } }; }
  if (P === 'V' && two) return { kind: 'V', pins: { '+': pins[0].at, '-': pins[1].at } };
  return null;
}

function symbolMap(s: AscSymbol, asy: Map<string, AsySymbol>): SymMap | null {
  const base = symbolBase(s.name);
  const user = asy.get(base);
  if (user) { const m = mapAsy(base, user); if (m) return m; }
  if (BUILTIN[base]) return BUILTIN[base];
  const g = OPAMP_SYMBOLS[base];
  if (g !== undefined) {
    const [px, py, nx, ny, ox, oy] = OPAMP_GEOMETRIES[g];
    return { kind: 'OA', pins: { '+': [px, py], '-': [nx, ny], out: [ox, oy] } };
  }
  return null;
}

/* ---------- Models ---------- */
const findKey = (keys: string[], v: string) => keys.find(k => k.toLowerCase() === v.toLowerCase());
function opAmpKey(v: string): string | null {
  const u = v.toUpperCase();
  const exact = findKey(Object.keys(OPAMP_MODELS), v);
  if (exact) return exact;
  if (/TL0[678]\d/.test(u)) return 'TL072';
  if (/4558/.test(u)) return 'JRC4558';
  if (/553[24]/.test(u)) return 'NE5532';
  if (/OPA\d*134/.test(u)) return 'OPA2134';
  if (/741/.test(u)) return 'LM741';
  if (/358|2904/.test(u)) return 'LM358';
  if (/308/.test(u)) return 'LM308';
  return null;
}

/* ---------- Geometry helpers (our coordinates) ---------- */
const S = 10 / 16;
const snap = (v: number) => Math.round(v / 10) * 10;
const sc = ([x, y]: LPt): Pt => [snap(x * S), snap(y * S)];
const pk = ([x, y]: Pt) => `${x},${y}`;
const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
const man = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const ROTS: Rot[] = [0, 90, 180, 270];

interface Seg { a: Pt; b: Pt; net: string }

export function importAsc(text: string, asyTexts: Record<string, string> = {}, name = 'LTspice schematic'): ImportResult {
  const asc = parseAsc(text);
  const asy = new Map(Object.entries(asyTexts).map(([n, t]) => [n.replace(/\.asy$/i, '').toLowerCase(), parseAsy(t)]));
  const params = readParams(asc.texts), models = readModels(asc.texts);
  const report: string[] = [];
  const note = (s: string) => { if (!report.includes(s)) report.push(s); };

  // Resolve symbols and their pin positions (LTspice coordinates).
  /** `preset`: value/props already worked out (pots untangled from resistor pairs). */
  interface Comp { s: AscSymbol; map: SymMap; ref: string; lt: Record<string, LPt>; preset?: Partial<SchPart> }
  const comps: Comp[] = [];
  let skipped = 0;
  for (const s of asc.symbols) {
    if (symbolBase(s.name) === 'jumper') continue; // a short: handled by jumperShorts
    const map = symbolMap(s, asy);
    const ref = s.attrs.InstName || symbolBase(s.name);
    if (!map) {
      skipped++;
      note(`Skipped ${ref} (symbol "${s.name}"): not a supported part${/pot/i.test(s.name) ? ' (add its .asy file to import a pot)' : ''}.`);
      continue;
    }
    const lt: Record<string, LPt> = {};
    for (const [pin, at] of Object.entries(map.pins)) { const o = ltTransform(s.orient, at); lt[pin] = [s.x + o[0], s.y + o[1]]; }
    comps.push({ s, map, ref, lt });
  }
  const nets = ltNets(asc.wires, asc.flags, [...comps.map(c => Object.values(c.lt)), ...otherPins(asc.symbols, asy)], jumperShorts(asc.symbols));
  const GNDNET = asc.flags.find(f => f.name === '0' || f.name === 'GND');
  const gndNet = GNDNET ? nets.netOf(GNDNET.at) : null;
  const isGnd = (p: LPt) => gndNet !== null && nets.netOf(p) === gndNet;
  // Pin groups of the parts as LTspice drew them (pots below replace resistor pairs, but LTspice's
  // wire-cutting rule applies to the resistors as drawn).
  const origGroups = comps.map(c => Object.values(c.lt));
  untanglePots();

  // Voltage sources: the signal source becomes the input jack, grounded DC sources become supply rails.
  const fixed: { kind: PartKind; at: LPt; props?: PartProps; value?: number; ref?: string }[] = [];
  let haveIn = false;
  const railNets = new Map<string, string>(asc.flags.filter(f => f.name !== '0').map(f => [f.name, nets.netOf(f.at)]));
  for (const c of comps.filter(c => c.map.kind === 'V')) {
    const v = [c.s.attrs.Value || '', c.s.attrs.Value2 || '', c.s.attrs.SpiceLine || ''].join(' ');
    const plus = c.lt['+'], minus = c.lt['-'];
    const signal = /\b(sine|sin|pulse|pwl|ac|sffm|exp|wavefile)\b/i.test(v);
    const node = isGnd(minus) ? plus : isGnd(plus) ? minus : null;
    if (!node) { note(`Skipped ${c.ref}: a floating voltage source isn't supported (one side must be grounded).`); skipped++; continue; }
    if (signal && !haveIn) { fixed.push({ kind: 'IN', at: node }); haveIn = true; continue; }
    if (signal) { note(`Skipped ${c.ref}: only one signal source is used (the first one is the input).`); skipped++; continue; }
    const m = v.match(/(?:^|\s)(?:dc\s+)?(\{[^}]*\}|[-+.\d][^\s]*)/i);
    const dc = m ? evalValue(m[1], params) : null;
    if (dc === null) { note(`Skipped ${c.ref}: couldn't read its voltage "${v.trim()}".`); skipped++; continue; }
    const volts = node === plus ? dc : -dc;
    // Same-named rails join, so an unnamed net gets a name no other net uses.
    const net = nets.netOf(node), flagName = nets.nameOf(net);
    let railName = flagName && flagName !== '0' ? flagName : `${+volts.toFixed(3)}V`;
    for (let n = 2; railNets.has(railName) && railNets.get(railName) !== net; n++) railName = `${+volts.toFixed(3)}V_${n}`;
    railNets.set(railName, net);
    fixed.push({ kind: 'SUPPLY', at: node, value: volts, props: { name: railName } });
  }

  // Flags: ground, net labels, and the output (a net named OUT/Vout …), or the input if no source.
  const outRe = /^(v?_?out|output|vo|out\d?)$/i, inRe = /^(v?_?in|input|vi)$/i;
  let outFlag = asc.flags.find(f => outRe.test(f.name)) ?? asc.flags.find(f => /out/i.test(f.name) && f.name !== '0');
  const inFlag = haveIn ? undefined : asc.flags.find(f => inRe.test(f.name));
  if (!outFlag) note('No net named OUT/Vout was found: add an Output jack where the signal leaves.');
  if (!haveIn && !inFlag) note('No signal source or IN net was found: add an Input jack where the signal enters.');
  const nameCount = new Map<string, number>();
  for (const f of asc.flags) nameCount.set(f.name, (nameCount.get(f.name) ?? 0) + 1);
  for (const f of asc.flags) {
    if (f.name === '0' || f.name === 'GND') { fixed.push({ kind: 'GND', at: f.at }); continue; }
    if (f === outFlag || f === inFlag) {
      fixed.push({ kind: f === outFlag ? 'OUT' : 'IN', at: f.at });
      if (f === inFlag) haveIn = true;
      if ((nameCount.get(f.name) ?? 0) > 1) fixed.push({ kind: 'LABEL', at: f.at, props: { name: f.name } });
      continue;
    }
    fixed.push({ kind: 'LABEL', at: f.at, props: { name: f.name } });
  }
  void outFlag;

  /* ---------- Build our drawing ---------- */
  const parts: SchPart[] = [];
  const wires: { id: string; pts: Pt[] }[] = [];
  const segs: Seg[] = [];
  const usedIds = new Set<string>();
  const newId = (base: string) => { let id = base.toLowerCase().replace(/[^\w-]/g, '') || 'p', n = 1; while (usedIds.has(id)) id = `${base.toLowerCase()}_${++n}`; usedIds.add(id); return id; };
  let wid = 0;
  const addWire = (pts: Pt[], net: string) => {
    const clean = pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
    if (clean.length < 2) return;
    wires.push({ id: `w${++wid}`, pts: clean });
    for (let i = 1; i < clean.length; i++) segs.push({ a: clean[i - 1], b: clean[i], net });
  };
  // Points that would connect to anything touching them: pins and wire ends, with their nets.
  const points = new Map<string, Set<string>>();
  const mark = (p: Pt, net: string) => { const s = points.get(pk(p)) ?? new Set(); s.add(net); points.set(pk(p), s); };
  // LTspice's wires, split at every tap (minus the bits hidden under parts), so each connection is at a wire end.
  const pinGroups = [...origGroups, ...otherPins(asc.symbols, asy)];
  for (const [a, b] of ltPieces(asc.wires, asc.flags.map(f => f.at), pinGroups)) {
    const net = nets.netOf(a), sa = sc(a), sb = sc(b);
    if (same(sa, sb)) continue;
    addWire([sa, sb], net); mark(sa, net); mark(sb, net);
  }
  // Jumpers are shorts: draw them as wires.
  for (const [a, b] of jumperShorts(asc.symbols)) {
    const net = nets.netOf(a), sa = sc(a), sb = sc(b);
    if (same(sa, sb)) continue;
    addWire(sa[0] === sb[0] || sa[1] === sb[1] ? [sa, sb] : [sa, [sb[0], sa[1]], sb], net);
    mark(sa, net); mark(sb, net);
  }
  // Targets of every part pin (where LTspice's pins were), so stubs and placements avoid foreign ones.
  for (const c of comps) for (const p of Object.values(c.lt)) mark(sc(p), nets.netOf(p));

  const foreignAt = (p: Pt, net: string) => {
    const s = points.get(pk(p));
    if (s && [...s].some(n => n !== net)) return true;
    return segs.some(g => g.net !== net && onSeg(p, g.a, g.b));
  };
  const foreignOnSeg = (a: Pt, b: Pt, net: string) => {
    for (const [key, ns] of points) {
      if (![...ns].some(n => n !== net)) continue;
      const [x, y] = key.split(',').map(Number);
      if (onSeg([x, y], a, b)) return true;
    }
    return false;
  };
  const boxes: [number, number, number, number][] = [];
  const worldBox = (p: SchPart): [number, number, number, number] => {
    const [x0, y0, x1, y1] = boxOf(p);
    const cs = [toWorld(p, [x0, y0]), toWorld(p, [x1, y1])];
    return [Math.min(cs[0][0], cs[1][0]), Math.min(cs[0][1], cs[1][1]), Math.max(cs[0][0], cs[1][0]), Math.max(cs[0][1], cs[1][1])];
  };
  const overlap = (b: [number, number, number, number]) => boxes.reduce((s, o) => s + Math.max(0, Math.min(b[2], o[2]) - Math.max(b[0], o[0])) * Math.max(0, Math.min(b[3], o[3]) - Math.max(b[1], o[1])), 0);

  // Fixed markers (jacks, rails, grounds, labels) go exactly at their LTspice points.
  const markerFor = new Map<SchPart, string>();
  for (const f of fixed) {
    const at = sc(f.at), net = nets.netOf(f.at);
    let rot: Rot = 0;
    if (f.kind === 'LABEL') {
      // Point the label away from wires leaving this point.
      const dirs = segs.filter(g => same(g.a, at) || same(g.b, at)).map(g => { const o = same(g.a, at) ? g.b : g.a; return [Math.sign(o[0] - at[0]), Math.sign(o[1] - at[1])]; });
      const free = ([[1, 0, 0], [0, 1, 90], [-1, 0, 180], [0, -1, 270]] as const).find(([dx, dy]) => !dirs.some(d => d[0] === dx && d[1] === dy));
      rot = (free ? free[2] : 0) as Rot;
    }
    const p: SchPart = { id: newId(f.kind === 'SUPPLY' ? 'vcc' : f.kind.toLowerCase()), kind: f.kind, x: at[0], y: at[1], rot, ...(f.value !== undefined ? { value: f.value } : {}), ...(f.props ? { props: f.props } : {}) };
    parts.push(p);
    markerFor.set(p, net);
    mark(at, net);
  }

  // Components: best orientation and position, then stubs.
  const pinTargets: { part: SchPart; pin: string; net: string; target: Pt }[] = [];
  for (const c of comps) {
    if (c.map.kind === 'V') continue;
    const kind = c.map.kind as PartKind;
    if (kind === 'BUF' && (evalValue(c.s.attrs.Value ?? '', params) !== 1 || !isGnd(c.lt.gnd) || !isGnd(c.lt.gndc))) {
      note(`Skipped ${c.ref}: only a grounded unity-gain VCVS (a buffer) is supported.`);
      skipped++;
      continue;
    }
    const spec = PARTS[kind];
    const names = Object.keys(c.map.pins).filter(n => spec.pins.some(p => p.name === n));
    const T = names.map(n => sc(c.lt[n])), N = names.map(n => nets.netOf(c.lt[n]));
    const cx = T.reduce((s, p) => s + p[0], 0) / T.length, cy = T.reduce((s, p) => s + p[1], 0) / T.length;
    let best: { part: SchPart; score: number } | null = null;
    for (const mirror of [false, true]) for (const rot of ROTS) {
      const O = names.map(n => toWorld({ x: 0, y: 0, rot, mirror }, spec.pins.find(p => p.name === n)!.at));
      const ox = O.reduce((s, p) => s + p[0], 0) / O.length, oy = O.reduce((s, p) => s + p[1], 0) / O.length;
      for (const dx of [0, -10, 10, -20, 20]) for (const dy of [0, -10, 10, -20, 20]) {
        const x = snap(cx - ox) + dx, y = snap(cy - oy) + dy;
        const Q = O.map(o => [o[0] + x, o[1] + y] as Pt);
        let score = Q.reduce((s, q, i) => s + man(q, T[i]), 0) + (mirror ? 1 : 0);
        Q.forEach((q, i) => { if (foreignAt(q, N[i])) score += 10000; });
        const part: SchPart = { id: '', kind, x, y, rot, ...(mirror ? { mirror: true } : {}) };
        score += overlap(worldBox(part)) * 0.5;
        if (!best || score < best.score) best = { part, score };
      }
    }
    const part = best!.part;
    part.id = newId(c.ref);
    part.ref = c.ref;
    Object.assign(part, valueOf(c, kind));
    parts.push(part);
    boxes.push(worldBox(part));
    names.forEach((n, i) => {
      const q = toWorld(part, spec.pins.find(p => p.name === n)!.at);
      mark(q, N[i]);
      pinTargets.push({ part, pin: n, net: N[i], target: T[i] });
    });
  }

  /* ---------- Connect the pins: move LTspice's wire ends onto our pins ---------- */
  // Our symbols are a different size, so each pin sits a little way from where LTspice had it (its
  // "target"). Wire ends and markers at a target follow the pin, re-routed like a stretch move. Where
  // two parts' pins met at one target, short stubs join them there instead. If that ever disagrees with
  // LTspice's nets, fall back to stubs everywhere, which keeps LTspice's wires exactly as drawn.
  const pinAt = (t: { part: SchPart; pin: string }) => toWorld(t.part, PARTS[t.part.kind].pins.find(p => p.name === t.pin)!.at);
  const byTarget = new Map<string, typeof pinTargets>();
  for (const t of pinTargets) byTarget.set(pk(t.target), [...(byTarget.get(pk(t.target)) ?? []), t]);
  const baseParts = parts.slice(), baseWires = wires.slice();
  const markerIds = new Set([...markerFor.keys()].map(p => p.id));

  function connect(attach: boolean): { parts: SchPart[]; wires: { id: string; pts: Pt[] }[]; unrouted: typeof pinTargets } {
    let ps = baseParts.map(p => ({ ...p }));
    let ws = baseWires.map(w => ({ ...w, pts: w.pts.slice() }));
    const stubs: typeof pinTargets = [];
    const moved = new Map<string, Pt>();
    for (const [key, ts] of byTarget) {
      const away = ts.filter(t => !same(pinAt(t), t.target));
      if (!away.length) continue;
      if (!attach || ts.length > 1) { stubs.push(...away); continue; }
      const q = pinAt(ts[0]), net = ts[0].net;
      const wiresAt = (p: Pt) => ws.filter(w => same(w.pts[0], p) || same(w.pts[w.pts.length - 1], p));
      const markerAt = (p: Pt) => ps.some(m => markerIds.has(m.id) && m.x === p[0] && m.y === p[1]);
      // Our pin may reach past a junction LTspice drew just off its smaller symbol (an op-amp output,
      // say): drop the wire hidden under our symbol and move the junction itself onto the pin.
      let cur: Pt = ts[0].target;
      const dropped = new Set<string>();
      for (let guard = 0; guard < 4; guard++) {
        const at = wiresAt(cur).filter(w => !dropped.has(w.id));
        if (at.length !== 1 || markerAt(cur) || at[0].pts.length !== 2) break;
        const other = same(at[0].pts[0], cur) ? at[0].pts[1] : at[0].pts[0];
        if (!onSeg(other, cur, q)) break;
        dropped.add(at[0].id);
        cur = other;
      }
      if (dropped.size) ws = ws.filter(w => !dropped.has(w.id));
      // If the pin already lands on a wire of its own net, it's connected: leave the wires alone (the
      // dead end left at the old position is trimmed later).
      const deadEnd = !markerAt(cur) && wiresAt(cur).length <= 1;
      const onOwnNet = ws.some(w => !wiresAt(cur).includes(w) && segs.some(s => s.net === net && w.pts.some(p => same(p, s.a) || same(p, s.b))) &&
        w.pts.some((p, i) => i > 0 && onSeg(q, w.pts[i - 1], p)));
      if (deadEnd && onOwnNet) continue;
      if (!same(cur, q)) moved.set(pk(cur), q);
      // Markers (ground, labels, jacks, rails) sitting on the target travel with the pin.
      ps = ps.map(p => (markerIds.has(p.id) && ((p.x === ts[0].target[0] && p.y === ts[0].target[1]) || (p.x === cur[0] && p.y === cur[1])) ? { ...p, x: q[0], y: q[1] } : p));
      void key;
    }
    if (moved.size) ws = reattach(ws, moved, new Set(), ps);
    // Stubs: an L from the pin to its target, avoiding anything foreign on the way.
    const unrouted: typeof pinTargets = [];
    for (const t of stubs) {
      const q = pinAt(t), T = t.target;
      const routes: Pt[][] = q[0] === T[0] || q[1] === T[1] ? [[q, T]] : [[q, [T[0], q[1]], T], [q, [q[0], T[1]], T]];
      const ok = routes.find(r => r.every((p, i) => i === 0 || !foreignOnSeg(r[i - 1], p, t.net)) && !foreignAt(q, t.net));
      if (ok) { ws.push({ id: `w${++wid}`, pts: ok.filter((p, i) => i === 0 || !same(p, ok[i - 1])) }); } else unrouted.push(t);
    }
    return { parts: ps, wires: ws, unrouted };
  }

  const ltName = (net: string) => nets.nameOf(net) ?? `N_${net.replace(/[^\d-]/g, '_')}`;
  const pinKeys = pinTargets.map(t => ({ key: `${t.part.id}:${t.pin}`, net: t.net, ref: t.part.ref || t.part.id, pin: t.pin }));
  const finish = (r: ReturnType<typeof connect>): { schematic: Schematic; mismatches: string[]; labelled: number } => {
    // Pins with no clean route are joined by net name (labels), on both sides.
    const extra: SchPart[] = [];
    const labelAt = (at: Pt, net: string, away: Pt) => {
      if (gndNet !== null && net === gndNet) { extra.push({ id: newId('gnd'), kind: 'GND', x: at[0], y: at[1], rot: 0 }); return; }
      const dx = Math.sign(at[0] - away[0]), dy = Math.sign(at[1] - away[1]);
      const rot: Rot = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : dy > 0 ? 90 : 270;
      extra.push({ id: newId('lbl'), kind: 'LABEL', x: at[0], y: at[1], rot, props: { name: ltName(net) } });
    };
    const nets2 = new Set<string>();
    for (const t of r.unrouted) { labelAt(pinAt(t), t.net, [t.part.x, t.part.y]); nets2.add(t.net); }
    for (const net of nets2) {
      if (gndNet !== null && net === gndNet) continue;
      const w = r.wires.find(w => segs.some(s => s.net === net && w.pts.some(p => same(p, s.a) || same(p, s.b))));
      if (w) labelAt(w.pts[0], net, w.pts[1]);
    }
    let sch: Schematic = { version: 1, parts: [...r.parts, ...extra], wires: r.wires };
    sch = pruneDangling(sch);
    sch = { ...sch, parts: sch.parts.map(p => (p.kind === 'LABEL' ? { ...p, rot: labelRot(sch, p) } : p)) };
    return { schematic: sch, mismatches: verify(sch, pinKeys), labelled: r.unrouted.length };
  };
  let result = finish(connect(true)), layout: 'attached' | 'stubs' = 'attached';
  const attachIssues = result.mismatches;
  if (result.mismatches.length) {
    const fallback = finish(connect(false));
    if (fallback.mismatches.length <= result.mismatches.length) { result = fallback; layout = 'stubs'; }
  }
  let schematic = result.schematic;
  const labelled = result.labelled;
  for (const m of result.mismatches) note(m);
  if (labelled) note(`${labelled} pin${labelled > 1 ? 's were' : ' was'} connected with net labels (no clean wire route).`);

  // Comments become text notes, one per line. Directives aren't imported, including ones that are
  // commented out (LTspice keeps disabled ".step"/".ac" lines as comments starting with a dot).
  const notes: NonNullable<Schematic['notes']> = [];
  for (const t of asc.texts.filter(t => !t.directive)) {
    const lines = t.text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() && !/^\s*[.;!]/.test(l));
    const [x, y] = sc([t.x, t.y]);
    lines.forEach((l, k) => notes.push({ id: `note${notes.length + 1}`, x, y: y + 14 * k, text: l.trim().slice(0, 160), anchor: 'start' }));
  }
  if (notes.length) schematic.notes = notes;
  const ignored = asc.texts.filter(t => t.directive).flatMap(t => t.text.split('\n')).map(l => l.trim()).filter(l => /^\.(lib|include|inc)\b/i.test(l));
  if (ignored.length) note(`Ignored ${ignored.join(', ')}: external model files aren't loaded; library models were substituted.`);
  void models; void name;
  return { schematic, report, stats: { parts: comps.filter(c => c.map.kind !== 'V').length, skipped, labelled, layout, attachIssues } };

  /* ---------- Pots drawn as resistors with a position parameter ---------- */
  /**
   * LTspice has no pot, so one is drawn as two resistors whose values depend on a position parameter
   * (e.g. {Rpot*pos} and {Rpot*(1-pos)}, with .param pos=0.5), and a two-lug pot as one such resistor.
   * A parameter counts as a knob if it sits in 0…1 and sweeping it 0 → 1 takes the resistor from about
   * zero to its full value (or back). A rising and a falling resistor on the same knob that meet at one
   * node become a pot (the rising one is lug 1 – wiper); a lone one becomes a variable resistor.
   */
  function untanglePots(): void {
    const steps = readSteps(asc.texts);
    const memo = new Map<string, Map<string, number>>();
    const paramsAt = (q: string, x: number) => {
      const k = `${q}=${x}`;
      if (!memo.has(k)) memo.set(k, readParams(asc.texts, new Map([[q, x]])));
      return memo.get(k)!;
    };
    interface Knob { c: Comp; q: string; up: boolean; total: number; at(x: number): number }
    const knobs: Knob[] = [];
    for (const c of comps) {
      if (c.map.kind !== 'R') continue;
      const v = (c.s.attrs.Value ?? '').trim();
      const ids = new Set((v.match(/[a-z_][\w.]*/gi) ?? []).map(s => s.toLowerCase()));
      for (const q of ids) {
        const pos = params.get(q);
        if (pos === undefined || pos < 0 || pos > 1) continue;
        const at = (x: number) => evalValue(v, paramsAt(q, x)) ?? NaN;
        const r0 = at(0), r1 = at(1);
        if (!isFinite(r0) || !isFinite(r1) || r0 < 0 || r1 < 0) continue;
        const total = Math.max(r0, r1), least = Math.min(r0, r1);
        if (!(total > 0) || least > 0.005 * total) continue;
        knobs.push({ c, q, up: r1 > r0, total, at });
        break;
      }
    }
    // Trimmers set by their resistance: {RTrim} or {RTrim+1} with .param RTrim=10k. Taken as a variable
    // resistor when the parameter is swept (.step) or named like a pot; the track value is the highest
    // swept value, else the next standard value at least twice the setting.
    const STD = [100, 200, 250, 500, 1e3, 2e3, 2.5e3, 5e3, 10e3, 20e3, 25e3, 50e3, 100e3, 200e3, 250e3, 500e3, 1e6, 2e6, 5e6];
    const trims: { c: Comp; q: string; setting: number; total: number; how: string }[] = [];
    for (const c of comps) {
      if (c.map.kind !== 'R' || knobs.some(k => k.c === c)) continue;
      const v = (c.s.attrs.Value ?? '').trim();
      for (const q of new Set((v.match(/[a-z_][\w.]*/gi) ?? []).map(s => s.toLowerCase()))) {
        const setting = params.get(q);
        if (setting === undefined || !(setting > 1)) continue;
        const potName = (n: string) => /trim|pot/i.test(n) || /^(vr|rv)\d/i.test(n);
        if (!steps.has(q) && !potName(q) && !potName(c.ref)) continue;
        const at = (x: number) => evalValue(v, paramsAt(q, x)) ?? NaN;
        const r1 = at(setting), r2 = at(2 * setting);
        // R must be (about) the parameter itself, plus at most a tiny guard resistance.
        if (!(Math.abs(r2 - r1 - setting) < 0.01 * setting) || !(r1 - setting < Math.max(10, 0.01 * setting))) continue;
        const swept = (steps.get(q) ?? []).filter(x => x > 0);
        const total = swept.length ? Math.max(setting, ...swept) : STD.find(s => s >= 2 * setting) ?? 2 * setting;
        trims.push({ c, q, setting, total, how: swept.length ? 'its highest .step value' : 'assumed, twice the setting' });
        break;
      }
    }
    if (!knobs.length && !trims.length) return;
    const netsOf = (c: Comp) => [nets.netOf(c.lt['1']), nets.netOf(c.lt['2'])];
    const usedRefs = new Set(comps.map(c => c.ref.toUpperCase()));
    let vr = 1;
    const freshRef = () => { while (usedRefs.has(`VR${vr}`)) vr++; usedRefs.add(`VR${vr}`); return `VR${vr}`; };
    /** The app's taper matching fraction(x) at a few points, or null. */
    const fitTaper = (fraction: (x: number) => number): TaperKey | null =>
      (['B', 'A', 'C'] as TaperKey[]).find(k => [0.25, 0.5, 0.75].every(x => Math.abs(fraction(x) - TAPERS[k].f(x)) < 0.01)) ?? null;
    const taperNote = (ref: string, k: TaperKey | null, q: string) => {
      if (!k) note(`${ref}: its "${q}" formula isn't a standard taper; imported as linear (B). Set the taper in Properties.`);
    };
    const replaced = new Set<Comp>();
    const added: Comp[] = [];
    const byParam = new Map<string, string[]>();
    for (const a of knobs.filter(k => k.up)) {
      if (replaced.has(a.c)) continue;
      // The two halves meet at exactly one node, the wiper. One half may have both ends on that node:
      // a pot used as a variable resistor with its wiper tied to lug 3 (or lug 1).
      const wiperOf = (b: Knob): string | null => {
        const sa = new Set(netsOf(a.c)), common = [...new Set(netsOf(b.c))].filter(n => sa.has(n));
        return common.length === 1 ? common[0] : null;
      };
      const b = knobs.find(k => !k.up && k.q === a.q && !replaced.has(k.c) && Math.abs(k.total - a.total) < 0.02 * a.total && wiperOf(k) !== null);
      if (!b) continue;
      const wNet = wiperOf(b)!;
      const [a1] = netsOf(a.c), [b1] = netsOf(b.c);
      const aw = a1 === wNet ? '1' : '2', aEnd = aw === '1' ? '2' : '1', bEnd = b1 === wNet ? '2' : '1';
      const reversed = /_b$/i.test(a.c.ref) && /_a$/i.test(b.c.ref);
      // Name: the resistors' shared prefix, else the next free VRn.
      let common = '';
      while (common.length < Math.min(a.c.ref.length, b.c.ref.length) && a.c.ref[common.length].toUpperCase() === b.c.ref[common.length].toUpperCase()) common += a.c.ref[common.length];
      common = common.replace(/[^a-z0-9]+$/i, '');
      // A meaningful shared name (VR1a/VR1b → VR1, RGain1/RGain2 → RGain); not a bare "R".
      const ref = (common.length >= 3 || (common.length >= 2 && /\d/.test(common))) && !usedRefs.has(common.toUpperCase()) ? common : freshRef();
      usedRefs.add(ref.toUpperCase());
      const taperKey = fitTaper(x => a.at(x) / a.total);
      taperNote(ref, taperKey, a.q);
      const turn = Math.min(1, Math.max(0, params.get(a.q)!));
      added.push({
        s: a.c.s, ref,
        map: { kind: 'POT', pins: { '1': [0, 0], w: [0, 0], '3': [0, 0] } },
        // Our own exports name the pin-1 half "_a": if that's the falling half, the pot was reversed —
        // keep its lugs where they were and mark it reversed rather than flipping the symbol.
        lt: reversed ? { '1': b.c.lt[bEnd], w: a.c.lt[aw], '3': a.c.lt[aEnd] } : { '1': a.c.lt[aEnd], w: a.c.lt[aw], '3': b.c.lt[bEnd] },
        preset: { value: +a.total.toPrecision(6), props: { taper: taperKey ?? 'B', turn, ...(reversed ? { reverse: true } : {}), ...(steps.has(a.q) ? { sweep: true } : {}) } },
      });
      replaced.add(a.c).add(b.c);
      byParam.set(a.q, [...(byParam.get(a.q) ?? []), ref]);
      note(`${ref}: pot from ${a.c.ref} + ${b.c.ref} (${a.q} = ${turn})${steps.has(a.q) ? '; .step sweeps it, so it is marked Sweepable' : ''}.`);
    }
    // Lone knob resistors: two-lug pots (variable resistors). Lugs 2+3 ({R*(1-pos)}) turn the other way.
    for (const k of knobs) {
      if (replaced.has(k.c)) continue;
      // {R*pos} is lugs 1+2; {R*(1-pos)} is lugs 2+3 (reversed), so the knob still follows pos.
      const taperKey = fitTaper(x => (k.up ? k.at(x) / k.total : 1 - k.at(x) / k.total));
      taperNote(k.c.ref, taperKey, k.q);
      const pos = Math.min(1, Math.max(0, params.get(k.q)!));
      added.push({
        s: k.c.s, ref: k.c.ref, map: { kind: 'RHEO', pins: { '1': [0, 0], '2': [0, 0] } }, lt: { ...k.c.lt },
        preset: { value: +k.total.toPrecision(6), props: { taper: taperKey ?? 'B', turn: pos, ...(k.up ? {} : { reverse: true }), ...(steps.has(k.q) ? { sweep: true } : {}) } },
      });
      replaced.add(k.c);
      byParam.set(k.q, [...(byParam.get(k.q) ?? []), k.c.ref]);
      note(`${k.c.ref}: variable resistor (${k.q} = ${pos})${steps.has(k.q) ? '; .step sweeps it, so it is marked Sweepable' : ''}.`);
    }
    for (const t of trims) {
      const turn = Math.min(1, t.setting / t.total);
      added.push({
        s: t.c.s, ref: t.c.ref, map: { kind: 'RHEO', pins: { '1': [0, 0], '2': [0, 0] } }, lt: { ...t.c.lt },
        preset: { value: t.total, props: { taper: 'B', turn: +turn.toFixed(4), ...(steps.has(t.q) ? { sweep: true } : {}) } },
      });
      replaced.add(t.c);
      note(`${t.c.ref}: trimmer set to ${fmtR(t.setting)} by "${t.q}"; track ${fmtR(t.total)} (${t.how}), so its knob is at ${(turn * 10).toFixed(1)}/10.${steps.has(t.q) ? ' Marked Sweepable (.step).' : ''}`);
    }
    // Pots that all follow one knob parameter are one shaft: a gang (dual-gang pot) here too.
    let gangs = 0;
    for (const [q, refs] of byParam) {
      if (refs.length < 2) continue;
      const g = gangs < 26 ? String.fromCharCode(65 + gangs) : `G${gangs + 1}`;
      gangs++;
      for (const a of added) if (refs.includes(a.ref) && a.preset?.props) a.preset.props = { ...a.preset.props, gang: g };
      note(`${refs.join(' and ')} all follow "${q}" in LTspice, so they are ganged here (gang ${g}) and turn together.`);
    }
    for (let i = comps.length - 1; i >= 0; i--) if (replaced.has(comps[i])) comps.splice(i, 1);
    comps.push(...added);
  }

  /* ---------- Values and models ---------- */
  function valueOf(c: Comp, kind: PartKind): Partial<SchPart> {
    if (c.preset) return c.preset;
    const a = c.s.attrs, ref = c.ref;
    const v = (a.Value ?? '').trim().replace(new RegExp(`${MODEL_SUFFIX}$`, 'i'), '');
    switch (kind) {
      case 'R': case 'C': case 'L': {
        const x = evalValue(v, params);
        if (x === null || !(x >= 0)) {
          const dflt = kind === 'R' ? 10e3 : kind === 'C' ? 100e-9 : 100e-3;
          note(`${ref}: couldn't read the value "${v}"; set to a default — please check.`);
          return { value: dflt };
        }
        return { value: x };
      }
      case 'POT': {
        const all = [a.Value, a.Value2, a.SpiceLine, a.SpiceLine2].filter(Boolean).join(' ');
        const r = all.match(/\b(?:r|rtot|rpot|value|res)\s*=\s*(\{[^}]*\}|\S+)/i);
        const t = all.match(/\b(?:t|wiper|pos|set|w|rot|turn)\s*=\s*(\{[^}]*\}|\S+)/i);
        const value = (r && evalValue(r[1], params)) || evalValue(v, params) || 100e3;
        let turn = t ? evalValue(t[1], params) ?? 0.5 : 0.5;
        if (turn > 1) turn /= 100;
        return { value, props: { taper: 'B', turn: Math.min(1, Math.max(0, turn)) } };
      }
      case 'OA': {
        const key = opAmpKey(v) ?? opAmpKey(symbolBase(c.s.name));
        if (!key && !/^(opamp|universalopamp2?|)$/i.test(v)) note(`${ref}: op-amp "${v || symbolBase(c.s.name)}" isn't in the library; simulated as ideal.`);
        return { props: { model: key ?? 'ideal' } };
      }
      case 'D': case 'LED': {
        const exact = findKey(Object.keys(DIODE_MODELS), v);
        if (exact) return { props: { model: exact } };
        const sub = kind === 'LED' || /led/i.test(v) ? 'LED_RED' : /1n34|1n60|oa9|germ|\bge\b|bat4/i.test(v) ? '1N34A' : '1N4148';
        note(`${ref}: diode "${v || 'D'}" isn't in the library; using ${sub}.`);
        return { kind: sub === 'LED_RED' && kind === 'D' ? 'D' : kind, props: { model: sub } };
      }
      case 'NPN': case 'PNP': {
        const exact = findKey(Object.keys(BJT_MODELS), v);
        if (exact && BJT_MODELS[exact].pol === kind.toLowerCase()) return { props: { model: exact } };
        const t = models.get(v.toLowerCase());
        const pnp = t ? t === 'PNP' : kind === 'PNP';
        const sub = pnp ? (/ac1|oc\d|nkt|2sb|germ/i.test(v) ? 'AC128' : '2N3906') : '2N3904';
        note(`${ref}: transistor "${v || kind}" isn't in the library; using ${sub}.`);
        return { kind: pnp ? 'PNP' : 'NPN', props: { model: sub } };
      }
      case 'NJF': case 'PJF': {
        const exact = findKey(Object.keys(JFET_MODELS), v);
        if (exact) return { props: { model: exact } };
        const sub = kind === 'NJF' ? 'J201' : '2N5460';
        note(`${ref}: JFET "${v || kind}" isn't in the library; using ${sub}.`);
        return { props: { model: sub } };
      }
      case 'NMOS': case 'PMOS': {
        const exact = findKey(Object.keys(MOS_MODELS), v);
        if (exact) return { props: { model: exact } };
        const sub = kind === 'NMOS' ? '2N7000' : 'BS250';
        note(`${ref}: MOSFET "${v || kind}" isn't in the library; using ${sub}.`);
        return { props: { model: sub } };
      }
      default: return {};
    }
  }
}

/**
 * Trims wires with a loose end (e.g. left by a skipped part) back to their last connection — a pin or
 * another wire's end lying on them — or removes them; then drops ground/label markers touching nothing.
 */
function pruneDangling(sch: Schematic): Schematic {
  let wires = sch.wires.slice(), parts = sch.parts.slice();
  for (let pass = 0; pass < 30; pass++) {
    const pinPts = parts.flatMap(p => PARTS[p.kind].pins.map(pin => toWorld(p, pin.at)));
    const touches = (q: Pt, self: number) =>
      pinPts.some(p => same(p, q)) || wires.some((w, i) => i !== self && w.pts.some((p, j) => same(p, q) || (j > 0 && onSeg(q, w.pts[j - 1], p))));
    let changed = false;
    const keep: typeof wires = [];
    wires.forEach((w, i) => {
      const loose0 = !touches(w.pts[0], i), loose1 = !touches(w.pts[w.pts.length - 1], i);
      if (!loose0 && !loose1) { keep.push(w); return; }
      changed = true;
      if (w.pts.length !== 2) return; // stubs: drop
      // Points on this segment that something else connects to.
      const [a, b] = w.pts;
      const others = wires.filter((_, j) => j !== i).flatMap(o => [o.pts[0], o.pts[o.pts.length - 1]]);
      const hits = [...pinPts, ...others].filter(p => onSeg(p, a, b));
      if (loose0 && loose1) { if (hits.length < 2) return; }
      const far = (from: Pt) => hits.reduce<Pt | null>((best, p) => (!best || man(p, from) < man(best, from) ? p : best), null);
      const na = loose0 ? far(a) : a, nb = loose1 ? far(b) : b;
      if (na && nb && !same(na, nb)) keep.push({ ...w, pts: [na, nb] });
    });
    const wirePts = (q: Pt) => keep.some(w => w.pts.some((p, j) => same(p, q) || (j > 0 && onSeg(q, w.pts[j - 1], p))));
    const keepParts = parts.filter(p => {
      if (p.kind !== 'GND' && p.kind !== 'LABEL') return true;
      const q = toWorld(p, PARTS[p.kind].pins[0].at);
      return wirePts(q) || parts.some(o => o !== p && o.kind !== 'GND' && o.kind !== 'LABEL' && PARTS[o.kind].pins.some(pin => same(toWorld(o, pin.at), q)));
    });
    if (!changed && keepParts.length === parts.length) break;
    wires = keep; parts = keepParts;
  }
  return { ...sch, parts, wires };
}

/** Compare our extracted nets with LTspice's: every pair of pins must agree on "same net or not". */
function verify(sch: Schematic, pins: { key: string; net: string; ref: string; pin: string }[]): string[] {
  const ex = extract(sch);
  const ours = (k: string) => ex.pinNet.get(k);
  const byLt = new Map<string, Set<string>>(), byOurs = new Map<string, Set<string>>();
  for (const p of pins) {
    const o = ours(p.key);
    if (o === undefined) continue;
    byLt.set(p.net, (byLt.get(p.net) ?? new Set()).add(o));
    byOurs.set(o, (byOurs.get(o) ?? new Set()).add(p.net));
  }
  const out: string[] = [];
  for (const [o, lts] of byOurs) {
    if (lts.size > 1) {
      const refs = pins.filter(p => ours(p.key) === o).map(p => `${p.ref}.${p.pin}`).slice(0, 6).join(', ');
      out.push(`Check the connection at ${refs}: nets that are separate in LTspice touch here.`);
    }
  }
  for (const [, os] of byLt) {
    if (os.size > 1) {
      const refs = pins.filter(p => os.has(ours(p.key) ?? '') && byLt.get(p.net) === os).map(p => `${p.ref}.${p.pin}`).slice(0, 6).join(', ');
      out.push(`Check the connection at ${refs}: one LTspice net came out split.`);
    }
  }
  return out;
}

/**
 * The importer's view of an LTspice drawing's connectivity: every pin of each supported part with
 * its net (and whether that net is ground). Used to check the importer against LTspice's netlister.
 */
export function ltConnections(text: string, asyTexts: Record<string, string> = {}): { ref: string; kind: string; pin: string; net: string; ground: boolean }[] {
  const asc = parseAsc(text);
  const asy = new Map(Object.entries(asyTexts).map(([n, t]) => [n.replace(/\.asy$/i, '').toLowerCase(), parseAsy(t)]));
  const comps = asc.symbols.flatMap(s => {
    const map = symbolMap(s, asy);
    if (!map) return [];
    const pins = Object.entries(map.pins).map(([pin, at]) => { const o = ltTransform(s.orient, at); return { pin, at: [s.x + o[0], s.y + o[1]] as LPt }; });
    return [{ ref: s.attrs.InstName || symbolBase(s.name), kind: map.kind as string, pins }];
  });
  const nets = ltNets(asc.wires, asc.flags, [...comps.map(c => c.pins.map(p => p.at)), ...otherPins(asc.symbols, asy)], jumperShorts(asc.symbols));
  const g = asc.flags.find(f => f.name === '0' || f.name === 'GND');
  const gnd = g ? nets.netOf(g.at) : null;
  return comps.flatMap(c => c.pins.map(p => { const net = nets.netOf(p.at); return { ref: c.ref, kind: c.kind, pin: p.pin, net, ground: net === gnd }; }));
}

/** LTspice's jumper symbol is a short between its two pins. */
function jumperShorts(symbols: AscSymbol[]): [LPt, LPt][] {
  return symbols.filter(s => symbolBase(s.name) === 'jumper').map(s => {
    const a = ltTransform(s.orient, [-32, 64]), b = ltTransform(s.orient, [32, 64]);
    return [[s.x + a[0], s.y + a[1]], [s.x + b[0], s.y + b[1]]];
  });
}

/** Pins of parts we don't import (from their .asy, or LTspice's built-ins): they still cut the wires they sit on. */
function otherPins(symbols: AscSymbol[], asy: Map<string, AsySymbol>): LPt[][] {
  return symbols.filter(s => !symbolMap(s, asy)).flatMap(s => {
    const base = symbolBase(s.name), user = asy.get(base);
    const local: LPt[] = user ? user.pins.map(p => p.at) : (SYMBOL_PINS[base] ?? []).flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]] as LPt]));
    return local.length ? [local.map(p => { const o = ltTransform(s.orient, p); return [s.x + o[0], s.y + o[1]] as LPt; })] : [];
  });
}

/**
 * Direction for a net label: one whose line doesn't run along a wire at its pin, and whose line and
 * name overlap the fewest wires and symbols (right, down, left, up break ties).
 */
function labelRot(sch: Schematic, p: SchPart): Rot {
  const at: Pt = [p.x, p.y];
  const dirs = sch.wires.flatMap(w => w.pts.flatMap((q, i) => {
    const out: Pt[] = [];
    if (same(q, at)) { if (i > 0) out.push(w.pts[i - 1]); if (i < w.pts.length - 1) out.push(w.pts[i + 1]); }
    return out.map(o => [Math.sign(o[0] - at[0]), Math.sign(o[1] - at[1])] as Pt);
  }));
  const L = labelLen(p), tw = (p.props?.name || 'NET').length * 7 + 4; // name width, with a little clearance
  const [x, y] = at;
  // Label footprint (line plus name) for each direction; vertical labels put the name beside the line.
  const boxes: Record<Rot, [number, number, number, number]> = {
    0: [x, y - 14, x + L, y + 4], 180: [x - L, y - 14, x, y + 4],
    90: [x - 2, y, x + 6 + tw, y + L], 270: [x - 2, y - L, x + 6 + tw, y],
  };
  const hits = (b: [number, number, number, number]) => {
    let n = 0;
    for (const w of sch.wires) for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], c = w.pts[i];
      if (Math.max(a[0], c[0]) > b[0] + 1 && Math.min(a[0], c[0]) < b[2] - 1 && Math.max(a[1], c[1]) > b[1] + 1 && Math.min(a[1], c[1]) < b[3] - 1) n++;
    }
    for (const o of sch.parts) {
      if (o === p || o.kind === 'LABEL' || o.kind === 'GND') continue;
      const [x0, y0, x1, y1] = boxOf(o), c0 = toWorld(o, [x0, y0]), c1 = toWorld(o, [x1, y1]);
      if (Math.max(c0[0], c1[0]) > b[0] && Math.min(c0[0], c1[0]) < b[2] && Math.max(c0[1], c1[1]) > b[1] && Math.min(c0[1], c1[1]) < b[3]) n += 2;
    }
    return n;
  };
  let best: Rot = p.rot, score = Infinity;
  for (const [dx, dy, rot] of [[1, 0, 0], [0, 1, 90], [-1, 0, 180], [0, -1, 270]] as const) {
    if (dirs.some(d => d[0] === dx && d[1] === dy)) continue;
    const s = hits(boxes[rot]);
    if (s < score) { score = s; best = rot; }
  }
  return best;
}

const fmtR = (r: number): string => (r >= 1e6 ? `${+(r / 1e6).toPrecision(3)}M` : r >= 1e3 ? `${+(r / 1e3).toPrecision(3)}k` : `${+r.toPrecision(3)}`) + 'Ω';
