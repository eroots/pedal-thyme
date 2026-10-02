// DC operating point: real-valued MNA with Newton–Raphson for diodes, BJTs and JFETs.
// Capacitors are open, inductors are shorts, the signal input is tied to 0 V and supplies are at
// their DC value. Op-amps have no output rails (a real op-amp uses its DC gain A0).
//
// If plain Newton fails, the solver retries with gmin stepping (a shrinking shunt from every node
// to ground), then with source stepping (supplies ramped up from 10%).
import { taper } from '../core/pots';
import { clamp } from '../core/units';
import { diodeModel, opAmpModel } from './models';
import { GND, elementNodes, isNonlinear, type Element, type Netlist, type Node } from './netlist';
import { VT, bjtIV, bjtModel, diodeIV, jfetIV, jfetModel, mosIV, mosModel, pnjlim, vcrit } from './semis';

const GMIN = 1e-12;
const POT_END = 1e-4;
const MAX_ITER = 200;
/** JFET gate junctions (SPICE default Is). */
const JFET_GATE_IS = 1e-14;

export type BjtRegion = 'active' | 'saturation' | 'cutoff' | 'reverse';

export type DeviceOp =
  | { type: 'D'; vd: number; id: number; gd: number }
  | { type: 'Q'; pol: 'npn' | 'pnp'; vbe: number; vbc: number; vce: number; ic: number; ib: number; beta: number; gm: number;
      region: BjtRegion; dic_dvbe: number; dic_dvbc: number; dib_dvbe: number; dib_dvbc: number }
  | { type: 'J'; pol: 'n' | 'p'; vgs: number; vds: number; id: number; gm: number; gds: number; region: 'cutoff' | 'linear' | 'saturation' }
  /** MOSFET; `id` is the channel current, `ibody` the body diode's (source → drain for N-channel). */
  | { type: 'M'; pol: 'n' | 'p'; vgs: number; vds: number; id: number; gm: number; gds: number; region: 'cutoff' | 'linear' | 'saturation'; ibody: number; gbody: number };

export interface OpPoint {
  /** False if no method converged (values are then the last iterate and unreliable). */
  ok: boolean;
  method: 'linear' | 'newton' | 'gmin' | 'source' | 'failed';
  iterations: number;
  /** Node voltage (ground and unknown nodes read 0). */
  v(node: Node): number;
  /** All named node voltages. */
  nodes: Map<Node, number>;
  /** Operating point of each nonlinear element, keyed by the element object. */
  devices: Map<Element, DeviceOp>;
}

export interface DcOptions {
  /** If set, the input sees this resistance to ground instead of a 0 V short. */
  rs?: number | null;
  /** Optional DC load from the output to ground. */
  rl?: number | null;
}

/** Solves the DC operating point of a netlist. Linear circuits converge in one step. */
export function dcOp(nl: Netlist, opt: DcOptions = {}): OpPoint {
  const sys = new DcSystem(nl, opt);
  if (!sys.nonlinear.length) {
    const x = sys.solveLinear(1, 0);
    return sys.result(x ?? new Float64Array(sys.N), x !== null, 'linear', 1);
  }
  let total = 0;
  // 1. Plain Newton from a zero start.
  let r = sys.newton(new Float64Array(sys.N), 1, 0);
  total += r.iter;
  if (r.ok) return sys.result(r.x, true, 'newton', total);
  // 2. gmin stepping.
  let x: Float64Array = new Float64Array(sys.N), ok = true;
  for (let k = 2; k <= 12; k++) {
    r = sys.newton(x, 1, 10 ** -k);
    total += r.iter;
    if (!r.ok) { ok = false; break; }
    x = r.x;
  }
  if (ok) { r = sys.newton(x, 1, 0); total += r.iter; if (r.ok) return sys.result(r.x, true, 'gmin', total); }
  // 3. Source stepping.
  x = new Float64Array(sys.N); ok = true;
  sys.resetJunctions();
  for (let k = 1; k <= 10; k++) {
    r = sys.newton(x, k / 10, 0);
    total += r.iter;
    if (!r.ok) {
      // One finer pass between the last good point and this one.
      r = sys.newton(x, (k - 0.5) / 10, 0); total += r.iter;
      if (r.ok) { r = sys.newton(r.x, k / 10, 0); total += r.iter; }
      if (!r.ok) { ok = false; break; }
    }
    x = r.x;
  }
  if (ok) return sys.result(x, true, 'source', total);
  return sys.result(r.x, false, 'failed', total);
}

/** Junction state remembered between Newton iterations (for limiting). */
interface DevState { el: Element; i: number; v1: number; v2: number; v3: number }

class DcSystem {
  readonly idx = new Map<Node, number>();
  readonly N: number;
  readonly nNodes: number;
  /** Linear part of the matrix (excluding source-scaled RHS). */
  private readonly A0: Float64Array;
  /** RHS entries from voltage sources (scaled by the source-stepping factor). */
  private readonly b0: Float64Array;
  readonly nonlinear: DevState[] = [];

  constructor(readonly nl: Netlist, opt: DcOptions) {
    const add = (n: Node) => { if (n !== GND && !this.idx.has(n)) this.idx.set(n, this.idx.size); };
    add(nl.input); add(nl.output);
    for (const e of nl.elements) elementNodes(e).forEach(add);
    const internal = new Map<Element, number>();
    nl.elements.forEach((e, i) => {
      if (e.type === 'OA' && opAmpModel(e.model).a0 !== Infinity) { internal.set(e, this.idx.size); this.idx.set(`#oa${i}`, this.idx.size); }
    });
    this.nNodes = this.idx.size;
    const vrows = nl.elements.filter(e => e.type === 'V' || e.type === 'E' || e.type === 'OA' || e.type === 'SPDT' || e.type === 'L' || (e.type === 'SW' && e.closed));
    const srcShort = !(opt.rs && opt.rs > 0);
    const N = this.N = this.nNodes + vrows.length + (srcShort ? 1 : 0);
    const A = this.A0 = new Float64Array(N * N);
    const b = this.b0 = new Float64Array(N);
    const ix = (n: Node) => this.ix(n);
    const put = (r: number, c: number, x: number) => { if (r >= 0 && c >= 0) A[r * N + c] += x; };
    const cond = (a: number, c: number, g: number) => { put(a, a, g); put(c, c, g); put(a, c, -g); put(c, a, -g); };
    const vrow = (j: number, p: number, n: number) => { put(p, j, 1); put(n, j, -1); put(j, p, 1); put(j, n, -1); };

    for (let i = 0; i < this.nNodes; i++) put(i, i, GMIN);
    nl.elements.forEach((e, i) => {
      switch (e.type) {
        case 'R': cond(ix(e.a), ix(e.b), 1 / e.value); break;
        case 'POT': {
          const f = clamp(taper(e.rot, e.taper), POT_END, 1 - POT_END);
          cond(ix(e.a), ix(e.w), 1 / (e.value * f));
          cond(ix(e.w), ix(e.b), 1 / (e.value * (1 - f)));
          break;
        }
        case 'RHEO': cond(ix(e.a), ix(e.b), 1 / Math.max(1, e.value * taper(e.rot, e.taper))); break;
        case 'OA': {
          const m = opAmpModel(e.model);
          if (m.a0 !== Infinity) {
            cond(internal.get(e)!, ix(e.out), 1 / Math.max(m.rout, 1e-6));
            if (isFinite(m.rin)) cond(ix(e.inP), ix(e.inN), 1 / m.rin);
          }
          break;
        }
        case 'G': {
          const p = ix(e.p), n = ix(e.n), cp = ix(e.cp), cn = ix(e.cn);
          put(p, cp, e.gm); put(p, cn, -e.gm); put(n, cp, -e.gm); put(n, cn, e.gm);
          break;
        }
        default:
          if (isNonlinear(e)) this.nonlinear.push({ el: e, i, v1: 0, v2: 0, v3: 0 });
          break; // C is open; voltage rows below
      }
    });
    vrows.forEach((e, k) => {
      const j = this.nNodes + k;
      switch (e.type) {
        case 'V': vrow(j, ix(e.p), ix(e.n)); b[j] = e.dc; break;
        case 'L': vrow(j, ix(e.a), ix(e.b)); break;
        case 'E': vrow(j, ix(e.p), ix(e.n)); put(j, ix(e.cp), -e.gain); put(j, ix(e.cn), e.gain); break;
        case 'SW': vrow(j, ix(e.a), ix(e.b)); break;
        case 'SPDT': vrow(j, ix(e.com), ix(e.pos === 'a' ? e.a : e.b)); break;
        case 'OA': {
          const m = opAmpModel(e.model), p = ix(e.inP), n = ix(e.inN);
          if (m.a0 === Infinity) { put(ix(e.out), j, 1); put(j, p, 1); put(j, n, -1); }
          else { const x = internal.get(e)!; put(x, j, 1); put(j, x, 1); put(j, p, -m.a0); put(j, n, m.a0); }
          break;
        }
        default: break;
      }
    });
    const inp = ix(nl.input), out = ix(nl.output);
    if (srcShort) vrow(N - 1, inp, -1);
    else cond(inp, -1, 1 / opt.rs!);
    if (opt.rl && opt.rl > 0) cond(out, -1, 1 / opt.rl);
  }

  ix(n: Node): number { return n === GND ? -1 : this.idx.get(n) ?? -1; }

  resetJunctions(): void { for (const d of this.nonlinear) { d.v1 = 0; d.v2 = 0; d.v3 = 0; } }

  /** Solves the linear part only (no nonlinear devices present). */
  solveLinear(scale: number, gshunt: number): Float64Array | null {
    const { A, b } = this.base(scale, gshunt);
    return realSolve(this.N, A, b);
  }

  private base(scale: number, gshunt: number): { A: Float64Array; b: Float64Array } {
    const A = this.A0.slice(), b = this.b0.slice();
    if (scale !== 1) for (let k = 0; k < this.N; k++) b[k] *= scale;
    if (gshunt) for (let i = 0; i < this.nNodes; i++) A[i * this.N + i] += gshunt;
    return { A, b };
  }

  private nodeV(x: Float64Array, n: Node): number { const k = this.ix(n); return k < 0 ? 0 : x[k]; }

  newton(x0: Float64Array, scale: number, gshunt: number): { ok: boolean; x: Float64Array; iter: number } {
    const N = this.N;
    let x: Float64Array = x0.slice();
    // Seed junction voltages from the starting point.
    for (const d of this.nonlinear) this.seed(d, x);
    for (let iter = 1; iter <= MAX_ITER; iter++) {
      const { A, b } = this.base(scale, gshunt);
      let limited = false;
      for (const d of this.nonlinear) if (this.stamp(d, x, A, b)) limited = true;
      const xn = realSolve(N, A, b);
      if (!xn) return { ok: false, x, iter };
      let conv = true;
      for (let k = 0; k < N; k++) {
        if (!isFinite(xn[k])) return { ok: false, x, iter };
        const tol = k < this.nNodes ? 1e-6 + 1e-4 * Math.abs(xn[k]) : 1e-9 + 1e-4 * Math.abs(xn[k]);
        if (Math.abs(xn[k] - x[k]) > tol) conv = false;
      }
      x = xn;
      if (conv && !limited && iter > 1) return { ok: true, x, iter };
    }
    return { ok: false, x, iter: MAX_ITER };
  }

  private seed(d: DevState, x: Float64Array): void {
    const e = d.el, V = (n: Node) => this.nodeV(x, n);
    if (e.type === 'D') d.v1 = V(e.a) - V(e.k);
    else if (e.type === 'Q') { const s = bjtModel(e.model).pol === 'npn' ? 1 : -1; d.v1 = s * (V(e.b) - V(e.e)); d.v2 = s * (V(e.b) - V(e.c)); }
    else if (e.type === 'J' || e.type === 'M') {
      const s = (e.type === 'J' ? jfetModel(e.model).pol : mosModel(e.model).pol) === 'n' ? 1 : -1;
      d.v1 = s * (V(e.g) - V(e.s)); d.v2 = s * (V(e.d) - V(e.s)); d.v3 = -d.v2;
    }
  }

  /** Stamps a device's Newton companion; returns true if its junction voltages were limited. */
  private stamp(d: DevState, x: Float64Array, A: Float64Array, b: Float64Array): boolean {
    const N = this.N, e = d.el, V = (n: Node) => this.nodeV(x, n);
    const put = (r: number, c: number, v: number) => { if (r >= 0 && c >= 0) A[r * N + c] += v; };
    const rhs = (r: number, v: number) => { if (r >= 0) b[r] += v; };
    if (e.type === 'D') {
      const m = diodeModel(e.model), nvt = m.n * VT;
      const raw = V(e.a) - V(e.k), vd = pnjlim(raw, d.v1, nvt, vcrit(m.is, nvt));
      d.v1 = vd;
      const { i, g } = diodeIV(vd, m.is, m.n);
      const a = this.ix(e.a), k = this.ix(e.k), ieq = i - g * vd;
      put(a, a, g); put(k, k, g); put(a, k, -g); put(k, a, -g);
      rhs(a, -ieq); rhs(k, ieq);
      return Math.abs(vd - raw) > 1e-9;
    }
    if (e.type === 'Q') {
      const m = bjtModel(e.model), s = m.pol === 'npn' ? 1 : -1, vc = vcrit(m.is, VT);
      const rbe = s * (V(e.b) - V(e.e)), rbc = s * (V(e.b) - V(e.c));
      const vbe = pnjlim(rbe, d.v1, VT, vc), vbc = pnjlim(rbc, d.v2, VT, vc);
      d.v1 = vbe; d.v2 = vbc;
      const r = bjtIV(vbe, vbc, m);
      const c = this.ix(e.c), bb = this.ix(e.b), em = this.ix(e.e);
      // Terminal currents (into the device) are linear in vbe = s·(Vb−Ve), vbc = s·(Vb−Vc);
      // s² = 1, so the Jacobian w.r.t. node voltages is the same for NPN and PNP.
      const term = (row: number, i0: number, d1: number, d2: number, sign: number) => {
        put(row, bb, sign * (d1 + d2)); put(row, em, -sign * d1); put(row, c, -sign * d2);
        rhs(row, -sign * s * (i0 - d1 * vbe - d2 * vbc));
      };
      term(c, r.ic, r.dic_dvbe, r.dic_dvbc, 1);
      term(bb, r.ib, r.dib_dvbe, r.dib_dvbc, 1);
      term(em, r.ic + r.ib, r.dic_dvbe + r.dib_dvbe, r.dic_dvbc + r.dib_dvbc, -1);
      return Math.abs(vbe - rbe) > 1e-9 || Math.abs(vbc - rbc) > 1e-9;
    }
    if (e.type === 'J' || e.type === 'M') {
      const jm = e.type === 'J' ? jfetModel(e.model) : null, mm = e.type === 'M' ? mosModel(e.model) : null;
      const s = (jm ?? mm)!.pol === 'n' ? 1 : -1;
      const rgs = s * (V(e.g) - V(e.s)), rds = s * (V(e.d) - V(e.s));
      // Square law is gentle; just cap each step.
      const vgs = d.v1 + clamp(rgs - d.v1, -0.5, 0.5), vds = d.v2 + clamp(rds - d.v2, -2, 2);
      d.v1 = vgs; d.v2 = vds;
      const r = jm ? jfetIV(vgs, vds, jm) : mosIV(vgs, vds, mm!);
      const dd = this.ix(e.d), g = this.ix(e.g), ss = this.ix(e.s);
      put(dd, g, r.gm); put(dd, dd, r.gds); put(dd, ss, -r.gm - r.gds);
      put(ss, g, -r.gm); put(ss, dd, -r.gds); put(ss, ss, r.gm + r.gds);
      const ieq = s * (r.id - r.gm * vgs - r.gds * vds);
      rhs(dd, -ieq); rhs(ss, ieq);
      let lim = Math.abs(vgs - rgs) > 1e-9 || Math.abs(vds - rds) > 1e-9;
      if (mm) {
        // Insulated gate: no gate current. Body diode from source (anode) to drain, for N-channel.
        const nvt = mm.bodyN * VT, raw = -rds, vb = pnjlim(raw, d.v3, nvt, vcrit(mm.bodyIs, nvt));
        d.v3 = vb;
        if (Math.abs(vb - raw) > 1e-9) lim = true;
        const { i, g: gb } = diodeIV(vb, mm.bodyIs, mm.bodyN);
        put(ss, ss, gb); put(dd, dd, gb); put(ss, dd, -gb); put(dd, ss, -gb);
        const ib = s * (i - gb * vb);
        rhs(ss, -ib); rhs(dd, ib);
        return lim;
      }
      // JFET gate junctions (gate–source, gate–drain), so a forward-biased gate conducts.
      for (const [other, vj] of [[ss, vgs], [dd, vgs - vds]] as const) {
        const raw = vj, vl = Math.min(raw, 0.9);
        if (vl !== raw) lim = true;
        const { i, g: gj } = diodeIV(vl, JFET_GATE_IS, 1);
        put(g, g, gj); put(other, other, gj); put(g, other, -gj); put(other, g, -gj);
        const ij = s * (i - gj * vl);
        rhs(g, -ij); rhs(other, ij);
      }
      return lim;
    }
    return false;
  }

  result(x: Float64Array, ok: boolean, method: OpPoint['method'], iterations: number): OpPoint {
    const nodes = new Map<Node, number>();
    for (const [n, k] of this.idx) if (!n.startsWith('#')) nodes.set(n, x[k]);
    const V = (n: Node) => this.nodeV(x, n);
    const devices = new Map<Element, DeviceOp>();
    for (const { el: e } of this.nonlinear) {
      if (e.type === 'D') {
        const m = diodeModel(e.model), vd = V(e.a) - V(e.k), { i, g } = diodeIV(vd, m.is, m.n);
        devices.set(e, { type: 'D', vd, id: i, gd: g });
      } else if (e.type === 'Q') {
        const m = bjtModel(e.model), s = m.pol === 'npn' ? 1 : -1;
        const vbe = s * (V(e.b) - V(e.e)), vbc = s * (V(e.b) - V(e.c)), r = bjtIV(vbe, vbc, m);
        const on = (v: number) => v > 0.5 * (m.is > 1e-9 ? 0.3 : 1); // Ge junctions turn on lower
        const region: BjtRegion = on(vbe) ? (on(vbc) ? 'saturation' : 'active') : (on(vbc) ? 'reverse' : 'cutoff');
        devices.set(e, {
          type: 'Q', pol: m.pol, vbe: s * vbe, vbc: s * vbc, vce: s * (vbe - vbc), ic: s * r.ic, ib: s * r.ib,
          beta: Math.abs(r.ib) > 1e-15 ? r.ic / r.ib : 0, gm: r.dic_dvbe, region,
          dic_dvbe: r.dic_dvbe, dic_dvbc: r.dic_dvbc, dib_dvbe: r.dib_dvbe, dib_dvbc: r.dib_dvbc,
        });
      } else if (e.type === 'J') {
        const m = jfetModel(e.model), s = m.pol === 'n' ? 1 : -1;
        const vgs = s * (V(e.g) - V(e.s)), vds = s * (V(e.d) - V(e.s)), r = jfetIV(vgs, vds, m);
        devices.set(e, { type: 'J', pol: m.pol, vgs: s * vgs, vds: s * vds, id: s * r.id, gm: r.gm, gds: r.gds, region: r.region });
      } else if (e.type === 'M') {
        const m = mosModel(e.model), s = m.pol === 'n' ? 1 : -1;
        const vgs = s * (V(e.g) - V(e.s)), vds = s * (V(e.d) - V(e.s)), r = mosIV(vgs, vds, m);
        const body = diodeIV(-vds, m.bodyIs, m.bodyN);
        devices.set(e, { type: 'M', pol: m.pol, vgs: s * vgs, vds: s * vds, id: s * r.id, gm: r.gm, gds: r.gds, region: r.region, ibody: s * body.i, gbody: body.g });
      }
    }
    return { ok, method, iterations, v: (n: Node) => (n === GND ? 0 : nodes.get(n) ?? 0), nodes, devices };
  }
}

/** Dense real Gaussian elimination with partial pivoting (destroys A and b). Null if singular. */
export function realSolve(n: number, A: Float64Array, b: Float64Array): Float64Array | null {
  for (let c = 0; c < n; c++) {
    let p = c, best = 0;
    for (let r = c; r < n; r++) { const m = Math.abs(A[r * n + c]); if (m > best) { best = m; p = r; } }
    if (best === 0) return null;
    if (p !== c) {
      for (let k = c; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    const piv = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / piv;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}
