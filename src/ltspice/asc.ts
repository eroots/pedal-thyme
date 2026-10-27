// LTspice schematic (.asc) and symbol (.asy) files: decoding, parsing, LTspice's coordinate transforms,
// connectivity (nets) and SPICE value/parameter evaluation. Shared by the importer and exporter.
//
// File format notes (LTspice 4.x): one record per line, e.g.
//   WIRE x1 y1 x2 y2 · FLAG x y name · SYMBOL name x y R90 · SYMATTR InstName R1 · TEXT x y Left 2 !.model …
// Coordinates are integers on a 16-unit grid, y down. Orientations are R0/R90/R180/R270 (clockwise) and
// M0/M90/M180/M270 (rotate, then mirror x → −x; measured against LTspice's own netlister).

export type LPt = [number, number];

export interface AscSymbol {
  /** Symbol name as written (may include a library path such as "OpAmps\\opamp2"). */
  name: string;
  x: number; y: number;
  orient: string;
  attrs: Record<string, string>;
}
export interface AscText { x: number; y: number; text: string; directive: boolean }
export interface AscFile {
  wires: [LPt, LPt][];
  flags: { at: LPt; name: string }[];
  symbols: AscSymbol[];
  texts: AscText[];
}

/** Decode file bytes: UTF-16LE (older LTspice), UTF-8, or Latin-1 (µ in values). */
export function decodeLtspice(bytes: Uint8Array): string {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0);
  if (utf16) return new TextDecoder('utf-16le').decode(bytes).replace(/^﻿/, '');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); } catch { return new TextDecoder('latin1').decode(bytes); }
}

const num = (s: string) => Number.parseInt(s, 10);

export function parseAsc(text: string): AscFile {
  const out: AscFile = { wires: [], flags: [], symbols: [], texts: [] };
  let sym: AscSymbol | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const w = line.split(/\s+/);
    switch (w[0]) {
      case 'WIRE': out.wires.push([[num(w[1]), num(w[2])], [num(w[3]), num(w[4])]]); break;
      case 'FLAG': out.flags.push({ at: [num(w[1]), num(w[2])], name: w.slice(3).join(' ') }); break;
      case 'SYMBOL':
        sym = { name: w[1], x: num(w[2]), y: num(w[3]), orient: (w[4] || 'R0').toUpperCase(), attrs: {} };
        out.symbols.push(sym);
        break;
      case 'SYMATTR':
        if (sym) sym.attrs[w[1]] = line.replace(/^SYMATTR\s+\S+\s?/, '');
        break;
      case 'TEXT': {
        // TEXT x y align size <text>; the text starts with "!" (directive) or ";" (comment).
        const m = line.match(/^TEXT\s+(-?\d+)\s+(-?\d+)\s+\S+\s+\S+\s+(.*)$/);
        if (m) {
          const body = m[3].replace(/\\n/g, '\n');
          out.texts.push({ x: num(m[1]), y: num(m[2]), directive: body.startsWith('!'), text: body.replace(/^[!;]/, '') });
        }
        sym = null;
        break;
      }
      case 'WINDOW': case 'IOPIN': break;
      default: if (w[0] !== 'SYMATTR') sym = w[0] === 'WINDOW' ? sym : null;
    }
  }
  return out;
}

export interface AsyPin { name: string; at: LPt; order: number }
export interface AsySymbol { prefix: string; value: string; pins: AsyPin[] }

/** Parse a symbol file: its prefix (R, C, X …) and pins in SPICE order. */
export function parseAsy(text: string): AsySymbol {
  const sym: AsySymbol = { prefix: '', value: '', pins: [] };
  let cur: AsyPin | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const w = raw.trim().split(/\s+/);
    if (w[0] === 'PIN') { cur = { name: '', at: [num(w[1]), num(w[2])], order: 0 }; sym.pins.push(cur); }
    else if (w[0] === 'PINATTR' && cur) {
      if (w[1] === 'PinName') cur.name = w.slice(2).join(' ');
      if (w[1] === 'SpiceOrder') cur.order = num(w[2]);
    } else if (w[0] === 'SYMATTR' && w[1] === 'Prefix') sym.prefix = w[2] || '';
    else if (w[0] === 'SYMATTR' && w[1] === 'Value') sym.value = w.slice(2).join(' ');
  }
  sym.pins.sort((a, b) => a.order - b.order);
  return sym;
}

/** Lower-case symbol name without its library path ("OpAmps\\opamp2" → "opamp2"). */
export const symbolBase = (name: string): string => name.split(/[\\/]+/).pop()!.toLowerCase();

/* ---------- Orientation ---------- */
export const ORIENTS = ['R0', 'R90', 'R180', 'R270', 'M0', 'M90', 'M180', 'M270'] as const;

/** Local symbol point → offset in the schematic, for an LTspice orientation. */
export function ltTransform(orient: string, [x, y]: LPt): LPt {
  let px = x, py = y;
  switch (Number.parseInt(orient.slice(1), 10) || 0) {
    case 90: [px, py] = [-y, x]; break;
    case 180: [px, py] = [-x, -y]; break;
    case 270: [px, py] = [y, -x]; break;
  }
  return orient.startsWith('M') ? [-px, py] : [px, py];
}

/* ---------- Connectivity ---------- */
const k = ([x, y]: LPt) => `${x},${y}`;
/** True if q lies on the segment a–b (axis-aligned or not), endpoints included. */
export function onSeg(q: LPt, a: LPt, b: LPt): boolean {
  const cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  if (cross !== 0) return false;
  return Math.min(a[0], b[0]) <= q[0] && q[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= q[1] && q[1] <= Math.max(a[1], b[1]);
}

class UF {
  private p = new Map<string, string>();
  find(a: string): string { let r = this.p.get(a) ?? a; if (r !== a) { r = this.find(r); this.p.set(a, r); } return r; }
  union(a: string, b: string): void { const x = this.find(a), y = this.find(b); if (x !== y) this.p.set(x, y); }
}

/**
 * Wires split at every point lying on them (other wire ends, flags, pins), so all connections are at
 * piece ends — minus the pieces that run under a part between two of its own pins, which LTspice ignores.
 */
export function ltPieces(wires: [LPt, LPt][], points: LPt[], pinGroups: LPt[][]): [LPt, LPt][] {
  const pinGroup = new Map<string, Set<number>>();
  pinGroups.forEach((g, i) => g.forEach(p => { const s = pinGroup.get(k(p)) ?? new Set(); s.add(i); pinGroup.set(k(p), s); }));
  const pts = new Map<string, LPt>();
  for (const p of [...wires.flat(), ...points, ...pinGroups.flat()]) pts.set(k(p), p);
  const pieces: [LPt, LPt][] = [];
  for (const [a, b] of wires) {
    const on = [...pts.values()].filter(p => onSeg(p, a, b)).sort((p, q) => (Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1])) - (Math.abs(q[0] - a[0]) + Math.abs(q[1] - a[1])));
    for (let i = 1; i < on.length; i++) {
      const g0 = pinGroup.get(k(on[i - 1])), g1 = pinGroup.get(k(on[i]));
      if (g0 && g1 && [...g0].some(g => g1.has(g))) continue;
      pieces.push([on[i - 1], on[i]]);
    }
  }
  return pieces;
}

/**
 * Nets of an LTspice drawing, following LTspice's netlister (checked against it):
 * - wire ends, pins and flags anywhere on a wire connect to it (T-junctions included);
 * - a part cuts the wire it sits on: the stretch of wire between two pins of the same part is ignored;
 * - flags with the same name join ("0"/GND is ground); `shorts` (e.g. jumpers) join their two points.
 * `pins` are grouped by part. Returns a point → net id function and each net's flag name, if any.
 */
export function ltNets(wires: [LPt, LPt][], flags: { at: LPt; name: string }[], pins: LPt[][] | LPt[], shorts: [LPt, LPt][] = []): { netOf(p: LPt): string; nameOf(net: string): string | undefined } {
  const uf = new UF();
  const groups: LPt[][] = pins.length && typeof pins[0][0] === 'number' ? (pins as LPt[]).map(p => [p]) : pins as LPt[][];
  const pieces = ltPieces(wires, flags.map(f => f.at), groups);
  for (const p of [...wires.flat(), ...flags.map(f => f.at), ...groups.flat()]) uf.find(k(p));
  for (const [a, b] of pieces) uf.union(k(a), k(b));
  for (const [a, b] of shorts) uf.union(k(a), k(b));
  const byName = new Map<string, string>();
  for (const f of flags) {
    const name = f.name === 'GND' ? '0' : f.name;
    const prev = byName.get(name);
    if (prev) uf.union(prev, k(f.at)); else byName.set(name, k(f.at));
  }
  const names = new Map<string, string>();
  for (const [name, at] of byName) names.set(uf.find(at), name);
  return { netOf: p => uf.find(k(p)), nameOf: net => names.get(uf.find(net)) };
}

/* ---------- Values ---------- */
const SUFFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12, mil: 25.4e-6 };

/** A SPICE number with an optional scale suffix; trailing unit letters are ignored ("4.7kΩ", "100nF"). */
export function spiceNumber(s: string): number | null {
  const m = s.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|mil|[fpnuµμmkgt])?/i);
  if (!m) return null;
  const v = Number.parseFloat(m[1]);
  return m[2] ? v * SUFFIX[m[2].toLowerCase()] : v;
}

/** Evaluates "{expr}" or a plain number using .param values. Returns null if it can't. */
export function evalValue(s: string, params: Map<string, number>): number | null {
  const t = s.trim();
  const m = t.match(/^\{(.*)\}$/) || t.match(/^'(.*)'$/);
  if (!m) {
    const n = spiceNumber(t);
    if (n !== null) return n;
    return params.get(t.toLowerCase()) ?? null;
  }
  try { return new Expr(m[1], params).parse(); } catch { return null; }
}

/** Recursive-descent evaluator for .param expressions: + − * / ** ^, comparisons, parentheses, params and a few functions (if() too). */
class Expr {
  private i = 0;
  constructor(private readonly s: string, private readonly params: Map<string, number>) {}
  parse(): number { const v = this.cmp(); this.ws(); if (this.i < this.s.length) throw new Error('trailing'); return v; }
  private ws() { while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++; }
  /** a < b, a > b, a <= b, a >= b: 1 or 0 (LTspice's true and false). */
  private cmp(): number {
    const v = this.sum(); this.ws();
    const op = this.s.slice(this.i).match(/^(<=|>=|<|>)/)?.[1];
    if (!op) return v;
    this.i += op.length;
    const w = this.sum();
    return +(op === '<' ? v < w : op === '>' ? v > w : op === '<=' ? v <= w : v >= w);
  }
  private sum(): number {
    let v = this.prod();
    for (;;) { this.ws(); const c = this.s[this.i]; if (c === '+') { this.i++; v += this.prod(); } else if (c === '-') { this.i++; v -= this.prod(); } else return v; }
  }
  private prod(): number {
    let v = this.pow();
    for (;;) {
      this.ws(); const c = this.s[this.i];
      if (c === '*' && this.s[this.i + 1] !== '*') { this.i++; v *= this.pow(); } else if (c === '/') { this.i++; v /= this.pow(); } else return v;
    }
  }
  private pow(): number {
    const b = this.unary(); this.ws();
    if (this.s.startsWith('**', this.i)) { this.i += 2; return b ** this.pow(); }
    if (this.s[this.i] === '^') { this.i++; return b ** this.pow(); }
    return b;
  }
  private unary(): number {
    this.ws();
    if (this.s[this.i] === '-') { this.i++; return -this.unary(); }
    if (this.s[this.i] === '+') { this.i++; return this.unary(); }
    return this.atom();
  }
  private atom(): number {
    this.ws();
    if (this.s[this.i] === '(') { this.i++; const v = this.cmp(); this.ws(); if (this.s[this.i++] !== ')') throw new Error(')'); return v; }
    const rest = this.s.slice(this.i);
    const n = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:meg|mil|[fpnuµμmkgt])?[a-z]*/i);
    if (n) { this.i += n[0].length; return spiceNumber(n[0])!; }
    const id = rest.match(/^[a-z_][\w.]*/i);
    if (!id) throw new Error('syntax');
    this.i += id[0].length;
    const name = id[0].toLowerCase();
    this.ws();
    if (this.s[this.i] === '(') {
      this.i++;
      const args = [this.cmp()];
      for (this.ws(); this.s[this.i] === ','; this.ws()) { this.i++; args.push(this.cmp()); }
      if (this.s[this.i++] !== ')') throw new Error(')');
      const f: Record<string, (...a: number[]) => number> = {
        sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10,
        min: Math.min, max: Math.max, pow: Math.pow, pwr: Math.pow, sin: Math.sin, cos: Math.cos,
        if: (c, a, b) => (c ? a : b),
        limit: (x, a, b) => Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b)),
      };
      if (!f[name]) throw new Error('fn');
      return f[name](...args);
    }
    if (name === 'pi') return Math.PI;
    const v = this.params.get(name);
    if (v === undefined) throw new Error('param');
    return v;
  }
}

/**
 * .param definitions from directive texts, evaluated in order (later ones may use earlier ones).
 * `overrides` pin some parameters (e.g. a pot position) so the ones derived from them follow.
 */
export function readParams(texts: AscText[], overrides: Map<string, number> = new Map()): Map<string, number> {
  const params = new Map<string, number>(overrides);
  const defs: [string, string][] = [];
  for (const t of texts) {
    if (!t.directive) continue;
    for (const line of t.text.split('\n')) {
      const m = line.trim().match(/^\.param\s+(.*)$/i);
      if (!m) continue;
      // name=value pairs; values may be {expr} or contain spaces inside braces.
      for (const d of m[1].matchAll(/([a-z_][\w.]*)\s*=\s*(\{[^}]*\}|'[^']*'|\S+)/gi)) defs.push([d[1].toLowerCase(), d[2]]);
    }
  }
  // A few passes, so order of definition doesn't matter.
  for (let pass = 0; pass < 4; pass++) {
    for (const [name, expr] of defs) {
      if (params.has(name)) continue;
      const v = evalValue(expr.startsWith('{') || expr.startsWith("'") ? expr : `{${expr}}`, params);
      if (v !== null && isFinite(v)) params.set(name, v);
    }
  }
  return params;
}

/** Our models are exported with this suffix (LTspice ships some of the same names); import strips it. */
export const MODEL_SUFFIX = '_pfl';

/**
 * Parameters swept with .step, with the values swept ("list a b c" → those; "start stop step" and
 * oct/dec ranges → start and stop). E.g. ".step param pos 0 1 0.1", ".step param R list 5k 10k".
 */
export function readSteps(texts: AscText[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const t of texts) {
    if (!t.directive) continue;
    for (const line of t.text.split('\n')) {
      const m = line.trim().replace(/;.*$/, '').match(/^\.step\s+(?:oct\s+|dec\s+|lin\s+)?param\s+([a-z_][\w.]*)\s*(.*)$/i);
      if (!m) continue;
      const words = m[2].trim().split(/\s+/).filter(Boolean);
      const nums = (words[0]?.toLowerCase() === 'list' ? words.slice(1) : words.slice(0, 2)).map(spiceNumber).filter((x): x is number => x !== null);
      out.set(m[1].toLowerCase(), nums);
    }
  }
  return out;
}

/** .model cards: name → type (D, NPN, PNP, NJF, PJF, NMOS, PMOS, VDMOS …). */
export function readModels(texts: AscText[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of texts) {
    if (!t.directive) continue;
    for (const line of t.text.split('\n')) {
      const m = line.trim().match(/^\.model\s+(\S+)\s+([a-z]+)/i);
      if (m) out.set(m[1].toLowerCase(), m[2].toUpperCase());
    }
  }
  return out;
}
