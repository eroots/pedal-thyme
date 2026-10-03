// Time-domain (transient) simulation, for clipping, distortion and audio.
//
// Method: the nodal DK method (state-space with nonlinear ports), as used for real-time audio circuit
// simulation. Capacitors and inductors become companion models (trapezoidal rule at the audio
// rate × oversampling); everything linear is folded, once, into a few matrices; and each time step
// is a small Newton solve in the controlling voltages of the nonlinear parts only:
//   diodes (1 port), BJTs and JFETs/MOSFETs (2 controls), op-amps (2 ports: a slew-limited input
//   stage driving an internal integrator, and an output that saturates softly at the supply rails).
// Op-amp rails are the circuit's supply span (highest and lowest DC source, including ground) minus
// each model's headroom. The run starts from the DC operating point, settled with a few large
// backward-Euler steps so the op-amp integrators and bias network are at rest.
import { taper } from '../core/pots';
import { clamp } from '../core/units';
import type { Term } from '../core/termination';
import { dcOp } from './dc';
import { diodeModel, opAmpModel } from './models';
import { GND, type Element, type Netlist, type Node } from './netlist';
import { downsample, upsample } from './resample';
import { VT, bjtIV, bjtModel, diodeIV, jfetIV, jfetModel, mosIV, mosModel, pnjlim, vcrit } from './semis';

const GMIN = 1e-12;
const POT_END = 1e-4;
/** Op-amp internal integrator node resistance; gm = A0 / RY. */
const RY = 1e3;
/** Softness of the op-amp output clamp (V). */
const CLAMP_SOFT = 0.05;
const JFET_GATE_IS = 1e-14;

export interface TransientOptions {
  /** Simulation rate (Hz): the audio rate times the oversampling factor. */
  rate: number;
  /** Source (pickup + cable) and load on the jacks, as in the AC analysis. */
  term?: Term | null;
  /** Nodes to record (the output node is always recorded). */
  probes?: Node[];
}

export interface TransientResult {
  /** Recorded node voltages, one sample per input sample. */
  out: Map<Node, Float64Array>;
  /** Steps where Newton did not fully converge (results there are approximate). */
  unconverged: number;
  /** Supply span the op-amps clip against. */
  rails: [number, number];
}

type Method = 'be' | 'trap';
/** `damped`: always integrated with backward Euler (stiff internal nodes, where the trapezoidal rule rings). */
interface Reactive { a: number; b: number; kind: 'C' | 'L'; value: number; damped?: boolean }
interface Control { terms: [number, number][]; limit?: { nvt: number; vcrit: number } | { step: number } }
interface Port { from: number; to: number }
interface Device {
  /** Global control and port indices this device owns. */
  c: number[]; p: number[];
  /** Currents for the given controls, and dI/dV (into J at [port][control]). */
  eval(v: Float64Array, i: Float64Array, J: (port: number, control: number, d: number) => void): void;
}

/** A compiled circuit ready to run sample by sample. */
export class TransientSim {
  private readonly N: number;
  private readonly G0: Float64Array;
  private readonly b0: Float64Array;
  private readonly srcRow: number;
  private readonly reactive: Reactive[] = [];
  private readonly controls: Control[] = [];
  private readonly ports: Port[] = [];
  private readonly devices: Device[] = [];
  private readonly outputs: Node[];
  private readonly outRow: number[];
  readonly rails: [number, number];
  // Per-method precomputation (rows = controls, reactive voltages, outputs).
  private M: { Wb0: Float64Array; Wu: Float64Array; WT: Float64Array; WN: Float64Array; G: Float64Array } | null = null;
  private method: Method = 'trap';

  // State.
  private vR: Float64Array; private iR: Float64Array;
  private v: Float64Array;
  unconverged = 0;

  constructor(readonly nl: Netlist, readonly opt: TransientOptions) {
    // Elements, plus the source (pickup) and load from the termination.
    const els: Element[] = [...nl.elements];
    let drive: Node = nl.input;
    const src = opt.term?.src, load = opt.term?.load;
    if (src?.on) {
      drive = '#src';
      const mid = src.L > 0 ? '#srcL' : nl.input;
      els.push({ type: 'R', name: '#Rs', a: '#src', b: mid, value: Math.max(src.R, 1e-3) });
      if (src.L > 0) els.push({ type: 'L', name: '#Ls', a: '#srcL', b: nl.input, value: src.L });
      if (src.C > 0) els.push({ type: 'C', name: '#Cc', a: nl.input, b: GND, value: src.C });
    }
    if (load?.on) {
      if (load.R > 0) els.push({ type: 'R', name: '#RL', a: nl.output, b: GND, value: load.R });
      if (load.C > 0) els.push({ type: 'C', name: '#CL', a: nl.output, b: GND, value: load.C });
    }
    // Rails: the supply span.
    const dcs = els.filter((e): e is Extract<Element, { type: 'V' }> => e.type === 'V').map(e => e.dc);
    this.rails = [Math.min(0, ...dcs), Math.max(0, ...dcs)];

    // Unknowns: nodes, op-amp integrator nodes, then voltage-source branch currents.
    const idx = new Map<Node, number>();
    const node = (n: Node) => { if (n === GND) return -1; if (!idx.has(n)) idx.set(n, idx.size); return idx.get(n)!; };
    node(drive); node(nl.input); node(nl.output);
    for (const e of els) for (const n of nodesOf(e)) node(n);
    const yNode = new Map<Element, number>();
    els.forEach((e, k) => { if (e.type === 'OA') yNode.set(e, node(`#y${k}`)); });
    const nNodes = idx.size;
    const vrows = els.filter(e => e.type === 'V' || e.type === 'E' || e.type === 'SPDT' || (e.type === 'SW' && e.closed));
    const N = this.N = nNodes + vrows.length + 1;
    this.srcRow = N - 1;
    const G = this.G0 = new Float64Array(N * N), b0 = this.b0 = new Float64Array(N);
    const put = (r: number, c: number, x: number) => { if (r >= 0 && c >= 0) G[r * N + c] += x; };
    const cond = (a: number, b: number, g: number) => { put(a, a, g); put(b, b, g); put(a, b, -g); put(b, a, -g); };
    const vrow = (j: number, p: number, n: number) => { put(p, j, 1); put(n, j, -1); put(j, p, 1); put(j, n, -1); };
    for (let i = 0; i < nNodes; i++) put(i, i, GMIN);
    const reactive = (a: Node | number, b: Node | number, kind: 'C' | 'L', value: number, damped = false) => {
      if (value > 0) this.reactive.push({ a: typeof a === 'number' ? a : node(a), b: typeof b === 'number' ? b : node(b), kind, value, damped });
    };
    const ctrl = (terms: [number, number][], limit?: Control['limit']) => { this.controls.push({ terms: terms.filter(([i]) => i >= 0), limit }); return this.controls.length - 1; };
    const port = (from: number, to: number) => { this.ports.push({ from, to }); return this.ports.length - 1; };

    for (const e of els) {
      switch (e.type) {
        case 'R': cond(node(e.a), node(e.b), 1 / e.value); break;
        case 'POT': {
          const f = clamp(taper(e.rot, e.taper), POT_END, 1 - POT_END);
          cond(node(e.a), node(e.w), 1 / (e.value * f));
          cond(node(e.w), node(e.b), 1 / (e.value * (1 - f)));
          break;
        }
        case 'RHEO': cond(node(e.a), node(e.b), 1 / Math.max(1, e.value * taper(e.rot, e.taper))); break;
        case 'C': reactive(e.a, e.b, 'C', e.value); break;
        case 'L': reactive(e.a, e.b, 'L', e.value); break;
        case 'G': {
          const p = node(e.p), n = node(e.n), cp = node(e.cp), cn = node(e.cn);
          put(p, cp, e.gm); put(p, cn, -e.gm); put(n, cp, -e.gm); put(n, cn, e.gm);
          break;
        }
        case 'D': {
          const m = diodeModel(e.model), a = node(e.a), k = node(e.k), nvt = m.n * VT;
          reactive(a, k, 'C', m.cj);
          const c = ctrl([[a, 1], [k, -1]], { nvt, vcrit: vcrit(m.is, nvt) });
          const p = port(a, k);
          this.devices.push({ c: [c], p: [p], eval: (v, i, J) => { const r = diodeIV(v[c], m.is, m.n); i[p] = r.i; J(p, c, r.g); } });
          break;
        }
        case 'Q': {
          const m = bjtModel(e.model), s = m.pol === 'npn' ? 1 : -1;
          const C = node(e.c), B = node(e.b), E = node(e.e), lim = { nvt: VT, vcrit: vcrit(m.is, VT) };
          reactive(B, E, 'C', m.cje); reactive(B, C, 'C', m.cjc);
          const c1 = ctrl([[B, s], [E, -s]], lim), c2 = ctrl([[B, s], [C, -s]], lim);
          const pc = port(C, E), pb = port(B, E);
          this.devices.push({
            c: [c1, c2], p: [pc, pb], eval: (v, i, J) => {
              const r = bjtIV(v[c1], v[c2], m);
              i[pc] = s * r.ic; i[pb] = s * r.ib;
              J(pc, c1, s * r.dic_dvbe); J(pc, c2, s * r.dic_dvbc); J(pb, c1, s * r.dib_dvbe); J(pb, c2, s * r.dib_dvbc);
            },
          });
          break;
        }
        case 'J': {
          const m = jfetModel(e.model), s = m.pol === 'n' ? 1 : -1;
          const D = node(e.d), Gt = node(e.g), S = node(e.s);
          reactive(Gt, S, 'C', m.cgs); reactive(Gt, D, 'C', m.cgd);
          const cgs = ctrl([[Gt, s], [S, -s]], { step: 0.5 }), cds = ctrl([[D, s], [S, -s]], { step: 2 });
          const pd = port(D, S), pgs = port(Gt, S), pgd = port(Gt, D);
          this.devices.push({
            c: [cgs, cds], p: [pd, pgs, pgd], eval: (v, i, J) => {
              const vgs = v[cgs], vds = v[cds], r = jfetIV(vgs, vds, m);
              i[pd] = s * r.id; J(pd, cgs, s * r.gm); J(pd, cds, s * r.gds);
              const a = diodeIV(Math.min(vgs, 0.9), JFET_GATE_IS, 1), b = diodeIV(Math.min(vgs - vds, 0.9), JFET_GATE_IS, 1);
              i[pgs] = s * a.i; J(pgs, cgs, s * a.g);
              i[pgd] = s * b.i; J(pgd, cgs, s * b.g); J(pgd, cds, -s * b.g);
            },
          });
          break;
        }
        case 'M': {
          const m = mosModel(e.model), s = m.pol === 'n' ? 1 : -1;
          const D = node(e.d), Gt = node(e.g), S = node(e.s);
          reactive(Gt, S, 'C', m.cgs); reactive(Gt, D, 'C', m.cgd);
          const cgs = ctrl([[Gt, s], [S, -s]], { step: 0.5 }), cds = ctrl([[D, s], [S, -s]], { step: 2 });
          const pd = port(D, S), pb = port(S, D);
          this.devices.push({
            c: [cgs, cds], p: [pd, pb], eval: (v, i, J) => {
              const r = mosIV(v[cgs], v[cds], m);
              i[pd] = s * r.id; J(pd, cgs, s * r.gm); J(pd, cds, s * r.gds);
              const b = diodeIV(Math.min(-v[cds], 0.95), m.bodyIs, m.bodyN);
              i[pb] = s * b.i; J(pb, cds, -s * b.g);
            },
          });
          break;
        }
        case 'OA': {
          // Input stage: gm·(v+ − v−), limited to ±Imax (slew), into an integrator node y (RY ∥ Cy).
          // Output: a source of soft-clamped V(y) behind Rout. DC gain A0, unity gain at GBW.
          const m = opAmpModel(e.model), y = yNode.get(e)!;
          const a0 = isFinite(m.a0) ? m.a0 : 1e6, gbw = isFinite(m.gbw) ? m.gbw : 50e6, rout = Math.max(m.rout, 1e-2);
          const gm = a0 / RY, cy = gm / (2 * Math.PI * gbw), imax = isFinite(m.slew) ? m.slew * 1e6 * cy : Infinity;
          const lo = this.rails[0] + m.headroom[0], hi = this.rails[1] - m.headroom[1];
          cond(y, -1, 1 / RY);
          reactive(y, -1, 'C', cy, true);
          if (isFinite(m.rin)) cond(node(e.inP), node(e.inN), 1 / m.rin);
          const out = node(e.out);
          cond(out, -1, 1 / rout);
          const cd = ctrl([[node(e.inP), 1], [node(e.inN), -1]]), cyv = ctrl([[y, 1]]);
          const pin = port(-1, y), pout = port(-1, out);
          // Like a real op-amp's internal stages, y saturates just beyond the output range, so the
          // amplifier recovers from clipping instead of winding up to absurd voltages.
          const yLo = lo - 0.3, yHi = hi + 0.3, gLim = Math.max(100 * gm, isFinite(imax) ? imax / 0.05 : 0);
          this.devices.push({
            c: [cd, cyv], p: [pin, pout], eval: (v, i, J) => {
              const x = gm * v[cd];
              if (isFinite(imax)) { const t = Math.tanh(x / imax); i[pin] = imax * t; J(pin, cd, gm * (1 - t * t)); }
              else { i[pin] = x; J(pin, cd, gm); }
              const [ex, dex] = excess(v[cyv], yLo, yHi);
              i[pin] -= gLim * ex; J(pin, cyv, -gLim * dex);
              const [f, df] = softClamp(v[cyv], lo, hi);
              i[pout] = f / rout; J(pout, cyv, df / rout);
            },
          });
          break;
        }
        default: break; // voltage rows below
      }
    }
    vrows.forEach((e, k) => {
      const j = nNodes + k;
      switch (e.type) {
        case 'V': vrow(j, node(e.p), node(e.n)); b0[j] = e.dc; break;
        case 'E': vrow(j, node(e.p), node(e.n)); put(j, node(e.cp), -e.gain); put(j, node(e.cn), e.gain); break;
        case 'SW': vrow(j, node(e.a), node(e.b)); break;
        case 'SPDT': vrow(j, node(e.com), node(e.pos === 'a' ? e.a : e.b)); break;
        default: break;
      }
    });
    vrow(this.srcRow, node(drive), -1);

    this.outputs = [...new Set([nl.output, ...(opt.probes ?? [])])].filter(n => n === GND || idx.has(n));
    this.outRow = this.outputs.map(n => (n === GND ? -1 : idx.get(n)!));
    this.vR = new Float64Array(this.reactive.length);
    this.iR = new Float64Array(this.reactive.length);
    this.v = new Float64Array(this.controls.length);

    // Start from the DC operating point.
    const op = dcOp(nl, { rs: src?.on ? src.R : null, rl: load?.on ? load.R : null });
    const x0 = new Float64Array(N);
    for (const [n, k] of idx) if (!n.startsWith('#')) x0[k] = op.v(n);
    if (idx.has('#srcL')) x0[idx.get('#srcL')!] = op.v(nl.input);
    els.forEach(e => { if (e.type === 'OA') x0[yNode.get(e)!] = op.v(e.out); });
    const at = (k: number) => (k < 0 ? 0 : x0[k]);
    this.reactive.forEach((r, k) => { this.vR[k] = at(r.a) - at(r.b); });
    this.controls.forEach((c, k) => { this.v[k] = c.terms.reduce((s, [i, w]) => s + w * x0[i], 0); });
    this.compile('be', 5e-3);
    for (let k = 0; k < 40; k++) this.step(0);
    this.compile('trap', 1 / opt.rate);
    this.unconverged = 0;
  }

  /** Precompute the matrices for an integration method and step. */
  private compile(method: Method, h: number): void {
    this.method = method;
    const { N, reactive } = this;
    const Gk = new Float64Array(reactive.length);
    reactive.forEach((r, k) => {
      const trap = method === 'trap' && !r.damped;
      Gk[k] = r.kind === 'C' ? (trap ? 2 : 1) * r.value / h : (trap ? h / 2 : h) / r.value;
    });
    // A = G0 + companion conductances; we need rows of W·A⁻¹, i.e. solves with Aᵀ.
    const At = new Float64Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) At[c * N + r] = this.G0[r * N + c];
    const addT = (r: number, c: number, x: number) => { if (r >= 0 && c >= 0) At[c * N + r] += x; };
    reactive.forEach((e, k) => { addT(e.a, e.a, Gk[k]); addT(e.b, e.b, Gk[k]); addT(e.a, e.b, -Gk[k]); addT(e.b, e.a, -Gk[k]); });
    const lu = luFactor(N, At);
    // Rows of interest: controls, reactive voltages, outputs.
    const rows: [number, number][][] = [
      ...this.controls.map(c => c.terms),
      ...reactive.map(e => [[e.a, 1], [e.b, -1]].filter(([i]) => i >= 0) as [number, number][]),
      ...this.outRow.map(i => (i >= 0 ? [[i, 1]] : []) as [number, number][]),
    ];
    const R = rows.length, nR = reactive.length, nP = this.ports.length;
    const Wb0 = new Float64Array(R), Wu = new Float64Array(R), WT = new Float64Array(R * nR), WN = new Float64Array(R * nP);
    const w = new Float64Array(N);
    rows.forEach((terms, r) => {
      w.fill(0);
      for (const [i, c] of terms) w[i] += c;
      const z = luSolve(lu, w); // z = A⁻ᵀ w, so z·b = w·A⁻¹·b
      let s = 0;
      for (let i = 0; i < N; i++) s += z[i] * this.b0[i];
      Wb0[r] = s;
      Wu[r] = z[this.srcRow];
      reactive.forEach((e, k) => { WT[r * nR + k] = (e.a >= 0 ? z[e.a] : 0) - (e.b >= 0 ? z[e.b] : 0); });
      this.ports.forEach((p, j) => { WN[r * nP + j] = (p.to >= 0 ? z[p.to] : 0) - (p.from >= 0 ? z[p.from] : 0); });
    });
    this.M = { Wb0, Wu, WT, WN, G: Gk };
  }

  /** Advance one step with input u (volts at the source); returns the output node voltages. */
  step(u: number, out?: Float64Array): void {
    const M = this.M!, nC = this.controls.length, nR = this.reactive.length, nP = this.ports.length;
    const R = nC + nR + this.outRow.length;
    // History sources of the companion models.
    const Jh = new Float64Array(nR);
    for (let k = 0; k < nR; k++) {
      const e = this.reactive[k], g = M.G[k], v = this.vR[k], i = this.iR[k];
      const trap = this.method === 'trap' && !e.damped;
      Jh[k] = e.kind === 'C' ? (trap ? g * v + i : g * v) : (trap ? -(i + g * v) : -i);
    }
    const base = new Float64Array(R);
    for (let r = 0; r < R; r++) {
      let s = M.Wb0[r] + M.Wu[r] * u;
      const off = r * nR;
      for (let k = 0; k < nR; k++) s += M.WT[off + k] * Jh[k];
      base[r] = s;
    }
    // Newton on the controls: v = p + K·i(v), with junction limiting and a backtracking line search
    // (the op-amp's saturating input stage and output clamp can otherwise make plain Newton cycle).
    const ip = new Float64Array(nP), Jf = new Float64Array(nP * nC);
    const setJ = (p: number, c: number, d: number) => { Jf[p * nC + c] += d; };
    const v = this.v;
    const evalAt = (x: Float64Array) => { Jf.fill(0); for (const d of this.devices) d.eval(x, ip, setJ); };
    let ok = nC === 0;
    if (nC) {
      const F = new Float64Array(nC), Jm = new Float64Array(nC * nC), trial = new Float64Array(nC), step = new Float64Array(nC);
      /** Evaluate the devices at x and return the residual F = p + K·i(x) − x (and its max norm). */
      const residual = (x: Float64Array): number => {
        evalAt(x);
        let worst = 0;
        for (let a = 0; a < nC; a++) {
          let s = base[a] - x[a];
          for (let j = 0; j < nP; j++) s += M.WN[a * nP + j] * ip[j];
          F[a] = s;
          worst = Math.max(worst, Math.abs(s));
        }
        return worst;
      };
      let r = residual(v);
      for (let it = 0; it < 80; it++) {
        for (let a = 0; a < nC; a++) for (let b = 0; b < nC; b++) {
          let d = a === b ? -1 : 0;
          for (let j = 0; j < nP; j++) d += M.WN[a * nP + j] * Jf[j * nC + b];
          Jm[a * nC + b] = d;
        }
        for (let a = 0; a < nC; a++) F[a] = -F[a];
        const dv = smallSolve(nC, Jm, F);
        if (!dv) break;
        let limited = false;
        for (let a = 0; a < nC; a++) {
          const old = v[a], lim = this.controls[a].limit;
          let nv = old + dv[a];
          if (lim && 'nvt' in lim) nv = pnjlim(nv, old, lim.nvt, lim.vcrit);
          else if (lim && 'step' in lim) nv = old + clamp(nv - old, -lim.step, lim.step);
          if (nv !== old + dv[a]) limited = true;
          step[a] = nv - old;
        }
        // Backtrack while the residual doesn't improve (a junction-limited step is taken as is).
        let lambda = 1, rt = 0;
        for (let k = 0; k < 10; k++) {
          for (let a = 0; a < nC; a++) trial[a] = v[a] + lambda * step[a];
          rt = residual(trial);
          if (limited || rt < r || rt < 1e-9) break;
          lambda /= 2;
        }
        let worst = 0;
        for (let a = 0; a < nC; a++) { worst = Math.max(worst, Math.abs(trial[a] - v[a]) / (1e-6 + 1e-6 * Math.abs(trial[a]))); v[a] = trial[a]; }
        r = rt;
        if (!limited && (worst < 1 || r < 1e-9)) { ok = true; break; }
      }
      evalAt(v);
    }
    if (!ok) this.unconverged++;
    // Reactive voltages and outputs.
    for (let k = 0; k < nR; k++) {
      const r = nC + k;
      let s = base[r];
      for (let j = 0; j < nP; j++) s += M.WN[r * nP + j] * ip[j];
      this.vR[k] = s;
      this.iR[k] = M.G[k] * s - Jh[k];
    }
    if (out) for (let o = 0; o < this.outRow.length; o++) {
      const r = nC + nR + o;
      let s = base[r];
      for (let j = 0; j < nP; j++) s += M.WN[r * nP + j] * ip[j];
      out[o] = s;
    }
  }

  /** Run an input signal (volts, one sample per step) and record the outputs. */
  run(input: ArrayLike<number>, onProgress?: (fraction: number) => void): TransientResult {
    const out = new Map<Node, Float64Array>(this.outputs.map(n => [n, new Float64Array(input.length)]));
    const series = this.outputs.map(n => out.get(n)!);
    const o = new Float64Array(this.outputs.length);
    const every = Math.max(1, Math.floor(input.length / 50));
    for (let t = 0; t < input.length; t++) {
      this.step(input[t], o);
      for (let k = 0; k < o.length; k++) series[k][t] = o[k];
      if (onProgress && t % every === 0) onProgress(t / input.length);
    }
    return { out, unconverged: this.unconverged, rails: this.rails };
  }
}

export interface RenderOptions {
  /** Audio sample rate of the input and output (Hz). */
  fs: number;
  /** Simulation runs at fs × oversample (reduces aliasing from clipping). */
  oversample: number;
  term?: Term | null;
  probes?: Node[];
  onProgress?: (fraction: number) => void;
}

/** Run an audio-rate signal (volts) through the circuit; returns audio-rate node voltages. */
export function renderAudio(nl: Netlist, input: ArrayLike<number>, o: RenderOptions): TransientResult {
  const sim = new TransientSim(nl, { rate: o.fs * o.oversample, term: o.term, probes: o.probes });
  const r = sim.run(upsample(input, o.oversample), o.onProgress);
  const out = new Map<Node, Float64Array>();
  for (const [n, y] of r.out) out.set(n, downsample(y, o.oversample));
  return { ...r, out };
}

function nodesOf(e: Element): Node[] {
  switch (e.type) {
    case 'R': case 'C': case 'L': case 'RHEO': case 'SW': return [e.a, e.b];
    case 'V': return [e.p, e.n];
    case 'E': case 'G': return [e.p, e.n, e.cp, e.cn];
    case 'OA': return [e.inP, e.inN, e.out];
    case 'POT': return [e.a, e.w, e.b];
    case 'SPDT': return [e.com, e.a, e.b];
    case 'D': return [e.a, e.k];
    case 'Q': return [e.c, e.b, e.e];
    case 'J': case 'M': return [e.d, e.g, e.s];
  }
}

/** Smooth clamp of v to [lo, hi] (softplus corners) and its derivative. */
function softClamp(v: number, lo: number, hi: number): [number, number] {
  const s = CLAMP_SOFT;
  const sp = (x: number) => (x > 30 ? x : Math.log1p(Math.exp(x)));
  const sg = (x: number) => 1 / (1 + Math.exp(-x));
  const a = (v - hi) / s, b = (lo - v) / s;
  return [v - s * sp(a) + s * sp(b), 1 - sg(a) - sg(b)];
}

/** How far v is outside [lo, hi] (smoothly, signed), and its derivative. */
function excess(v: number, lo: number, hi: number): [number, number] {
  const s = CLAMP_SOFT;
  const sp = (x: number) => (x > 30 ? x : Math.log1p(Math.exp(x)));
  const sg = (x: number) => 1 / (1 + Math.exp(-x));
  const a = (v - hi) / s, b = (lo - v) / s;
  return [s * sp(a) - s * sp(b), sg(a) + sg(b)];
}

/* ---------- Dense linear algebra ---------- */
interface LU { n: number; a: Float64Array; piv: Int32Array }
function luFactor(n: number, A: Float64Array): LU {
  const a = A.slice(), piv = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(a[c * n + c]);
    for (let r = c + 1; r < n; r++) { const m = Math.abs(a[r * n + c]); if (m > best) { best = m; p = r; } }
    piv[c] = p;
    if (p !== c) for (let k = 0; k < n; k++) { const t = a[c * n + k]; a[c * n + k] = a[p * n + k]; a[p * n + k] = t; }
    const d = a[c * n + c] || 1e-30;
    for (let r = c + 1; r < n; r++) {
      const f = (a[r * n + c] /= d);
      if (f === 0) continue;
      for (let k = c + 1; k < n; k++) a[r * n + k] -= f * a[c * n + k];
    }
  }
  return { n, a, piv };
}
function luSolve({ n, a, piv }: LU, b: Float64Array): Float64Array {
  const x = b.slice();
  for (let c = 0; c < n; c++) { const p = piv[c]; if (p !== c) { const t = x[c]; x[c] = x[p]; x[p] = t; } }
  for (let r = 1; r < n; r++) { let s = x[r]; for (let k = 0; k < r; k++) s -= a[r * n + k] * x[k]; x[r] = s; }
  for (let r = n - 1; r >= 0; r--) { let s = x[r]; for (let k = r + 1; k < n; k++) s -= a[r * n + k] * x[k]; x[r] = s / (a[r * n + r] || 1e-30); }
  return x;
}
function smallSolve(n: number, A: Float64Array, b: Float64Array): Float64Array | null {
  const lu = luFactor(n, A);
  for (let i = 0; i < n; i++) if (!isFinite(lu.a[i * n + i]) || lu.a[i * n + i] === 0) return null;
  return luSolve(lu, b);
}
