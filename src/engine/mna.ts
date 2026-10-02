// Modified nodal analysis (MNA) for small-signal AC. Unknowns are node voltages plus one branch
// current per voltage-defined element (signal source, supplies, VCVS, op-amps, closed switches).
//
// A compiled Circuit pre-stamps everything that doesn't depend on frequency, so each solve is
// A(s) = G + s·Cm + (1/s)·Lm (+ op-amp gain terms), then one dense complex LU.
import { Cx, cx, ONE } from '../core/complex';
import { taper } from '../core/pots';
import { clamp } from '../core/units';
import { opAmpModel } from './models';
import { GND, elementNodes, type Netlist, type Node } from './netlist';

/** Conductance from every node to ground: keeps floating nodes (e.g. behind an "off" diode) solvable. */
const GMIN = 1e-15;
/** Pots never reach exactly 0 Ω: the wiper split is clamped to [1e-4, 1 − 1e-4] of the track. */
const POT_END = 1e-4;
const SRC_NODE = '#src';

export interface Drive {
  /** Ideal source voltage (default 1 V). The source sits behind `zs`, if given. */
  vin?: Cx;
  /** Source impedance between the ideal source and the input node. */
  zs?: Cx | null;
  /** Load impedance from the output node to ground. */
  zl?: Cx | null;
  /** Extra current injected into a node (used for output impedance). */
  inject?: { node: Node; i: Cx };
}

export interface Solution {
  /** Node voltage (ground and unknown nodes read as 0). */
  v(node: Node): Cx;
  /** Current the signal source delivers into the circuit. */
  iIn: Cx;
}

/** A finite-gain op-amp's frequency-dependent row: V(x) − A(s)·(V+ − V−) = 0. */
interface GainRow { row: number; p: number; n: number; a0: number; wt: number }

export class Circuit {
  private readonly idx = new Map<Node, number>();
  /** Matrix size. */
  private readonly N: number;
  private readonly G: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Lm: Float64Array;
  private readonly gainRows: GainRow[] = [];
  private readonly srcRow: number;
  private hasL = false;
  // Work arrays, reused across solves.
  private readonly Ar: Float64Array;
  private readonly Ai: Float64Array;
  private readonly br: Float64Array;
  private readonly bi: Float64Array;

  constructor(readonly netlist: Netlist) {
    const add = (n: Node) => { if (n !== GND && !this.idx.has(n)) this.idx.set(n, this.idx.size); };
    add(netlist.input); add(netlist.output);
    for (const e of netlist.elements) elementNodes(e).forEach(add);
    const internal = new Map<string, number>(); // a real op-amp's gain-stage output (before Rout)
    for (const e of netlist.elements) {
      if (e.type === 'OA' && opAmpModel(e.model).a0 !== Infinity) { internal.set(e.name, this.idx.size); this.idx.set('#' + e.name, this.idx.size); }
    }
    add(SRC_NODE);
    const nNodes = this.idx.size;
    const voltageRows = netlist.elements.filter(e => e.type === 'V' || e.type === 'E' || e.type === 'OA' || e.type === 'SPDT' || (e.type === 'SW' && e.closed));
    const N = this.N = nNodes + 1 + voltageRows.length;
    this.srcRow = nNodes;
    this.G = new Float64Array(N * N); this.Cm = new Float64Array(N * N); this.Lm = new Float64Array(N * N);
    this.Ar = new Float64Array(N * N); this.Ai = new Float64Array(N * N); this.br = new Float64Array(N); this.bi = new Float64Array(N);

    const ix = (n: Node) => this.ix(n);
    const put = (M: Float64Array, r: number, c: number, x: number) => { if (r >= 0 && c >= 0) M[r * N + c] += x; };
    const admit = (M: Float64Array, a: number, b: number, y: number) => { put(M, a, a, y); put(M, b, b, y); put(M, a, b, -y); put(M, b, a, -y); };
    /** Branch-current unknown j enters the KCL rows of p (+) and n (−), and its row reads V(p) − V(n). */
    const vrow = (j: number, p: number, n: number) => { put(this.G, p, j, 1); put(this.G, n, j, -1); put(this.G, j, p, 1); put(this.G, j, n, -1); };

    for (let i = 0; i < nNodes; i++) put(this.G, i, i, GMIN);
    for (const e of netlist.elements) {
      switch (e.type) {
        case 'R': admit(this.G, ix(e.a), ix(e.b), 1 / e.value); break;
        case 'C': admit(this.Cm, ix(e.a), ix(e.b), e.value); break;
        case 'L': admit(this.Lm, ix(e.a), ix(e.b), 1 / e.value); this.hasL = true; break;
        case 'POT': {
          const f = clamp(taper(e.rot, e.taper), POT_END, 1 - POT_END);
          admit(this.G, ix(e.a), ix(e.w), 1 / (e.value * f));
          admit(this.G, ix(e.w), ix(e.b), 1 / (e.value * (1 - f)));
          break;
        }
        case 'RHEO': admit(this.G, ix(e.a), ix(e.b), 1 / Math.max(1, e.value * taper(e.rot, e.taper))); break;
        case 'OA': {
          const m = opAmpModel(e.model);
          if (m.a0 !== Infinity) {
            admit(this.G, internal.get(e.name)!, ix(e.out), 1 / Math.max(m.rout, 1e-6));
            if (isFinite(m.rin)) admit(this.G, ix(e.inP), ix(e.inN), 1 / m.rin);
          }
          break;
        }
        default: break; // V, E, SW, SPDT are voltage rows below; D is open in AC
      }
    }
    // Signal source row: by default it drives the input node directly (solve() moves it behind zs).
    vrow(this.srcRow, ix(netlist.input), -1);
    voltageRows.forEach((e, k) => {
      const j = nNodes + 1 + k;
      switch (e.type) {
        case 'V': vrow(j, ix(e.p), ix(e.n)); break;
        case 'E': vrow(j, ix(e.p), ix(e.n)); put(this.G, j, ix(e.cp), -e.gain); put(this.G, j, ix(e.cn), e.gain); break;
        case 'SW': vrow(j, ix(e.a), ix(e.b)); break;
        case 'SPDT': vrow(j, ix(e.com), ix(e.pos === 'a' ? e.a : e.b)); break;
        case 'OA': {
          const m = opAmpModel(e.model), p = ix(e.inP), n = ix(e.inN);
          if (m.a0 === Infinity) {
            // Nullor: the output supplies whatever current makes V+ = V−.
            put(this.G, ix(e.out), j, 1);
            put(this.G, j, p, 1); put(this.G, j, n, -1);
          } else {
            const x = internal.get(e.name)!;
            put(this.G, x, j, 1); put(this.G, j, x, 1);
            this.gainRows.push({ row: j, p, n, a0: m.a0, wt: 2 * Math.PI * m.gbw });
          }
          break;
        }
        default: break;
      }
    });
  }

  /** Node index (−1 = ground or unknown). */
  private ix(n: Node): number { return n === GND ? -1 : this.idx.get(n) ?? -1; }

  solve(s: Cx, d: Drive = {}): Solution {
    const { N, G, Cm, Lm, Ar, Ai, br, bi } = this;
    const inv = this.hasL ? ONE.div(s) : null;
    for (let k = 0; k < N * N; k++) {
      Ar[k] = G[k] + s.re * Cm[k];
      Ai[k] = s.im * Cm[k];
    }
    if (inv) for (let k = 0; k < N * N; k++) { Ar[k] += inv.re * Lm[k]; Ai[k] += inv.im * Lm[k]; }
    br.fill(0); bi.fill(0);
    const put = (r: number, c: number, re: number, im: number) => { if (r >= 0 && c >= 0) { Ar[r * N + c] += re; Ai[r * N + c] += im; } };
    const admit = (a: number, b: number, y: Cx) => { put(a, a, y.re, y.im); put(b, b, y.re, y.im); put(a, b, -y.re, -y.im); put(b, a, -y.re, -y.im); };

    // Finite-gain op-amps: V(x) − A(s)·(V+ − V−) = 0 with A(s) = A0 / (1 + s·A0/ωt).
    for (const g of this.gainRows) {
      const A = cx(g.a0).div(ONE.add(s.scale(g.a0 / g.wt)));
      put(g.row, g.p, -A.re, -A.im); put(g.row, g.n, A.re, A.im);
    }

    const inp = this.ix(this.netlist.input), out = this.ix(this.netlist.output), j = this.srcRow;
    if (d.zs) {
      // Move the source behind zs: the source row now drives the internal #src node.
      const src = this.ix(SRC_NODE);
      put(inp, j, -1, 0); put(j, inp, -1, 0); put(src, j, 1, 0); put(j, src, 1, 0);
      admit(src, inp, ONE.div(d.zs));
    }
    if (d.zl) admit(out, -1, ONE.div(d.zl));
    const vin = d.vin ?? ONE;
    br[j] = vin.re; bi[j] = vin.im;
    if (d.inject) { const k = this.ix(d.inject.node); if (k >= 0) { br[k] += d.inject.i.re; bi[k] += d.inject.i.im; } }

    const [xr, xi] = luSolve(N, Ar, Ai, br, bi);
    return {
      v: (node: Node) => { const k = this.ix(node); return k < 0 ? new Cx(0, 0) : new Cx(xr[k], xi[k]); },
      // The branch variable is the current flowing from the driven node into the source.
      iIn: new Cx(-xr[j], -xi[j]),
    };
  }

  /** V(output) / V(source) for a 1 V source behind zs, with load zl. */
  transfer(s: Cx, zs?: Cx | null, zl?: Cx | null): Cx {
    return this.solve(s, { zs, zl }).v(this.netlist.output);
  }

  /** Impedance looking into the input node (with the output loaded by zl). */
  zin(s: Cx, zl?: Cx | null): Cx {
    return ONE.div(this.solve(s, { zl }).iIn);
  }

  /** Impedance looking back into the output node, with the source shorted through zs. */
  zout(s: Cx, zs?: Cx | null): Cx {
    return this.solve(s, { vin: new Cx(0, 0), zs, inject: { node: this.netlist.output, i: ONE } }).v(this.netlist.output);
  }
}

/** Dense complex Gaussian elimination with partial pivoting, in place on split re/im arrays. */
function luSolve(n: number, Ar: Float64Array, Ai: Float64Array, br: Float64Array, bi: Float64Array): [Float64Array, Float64Array] {
  for (let c = 0; c < n; c++) {
    let p = c, best = -1;
    for (let r = c; r < n; r++) { const k = r * n + c, m = Ar[k] * Ar[k] + Ai[k] * Ai[k]; if (m > best) { best = m; p = r; } }
    if (p !== c) {
      for (let k = c; k < n; k++) {
        const a = c * n + k, b = p * n + k;
        let t = Ar[a]; Ar[a] = Ar[b]; Ar[b] = t; t = Ai[a]; Ai[a] = Ai[b]; Ai[b] = t;
      }
      let t = br[c]; br[c] = br[p]; br[p] = t; t = bi[c]; bi[c] = bi[p]; bi[p] = t;
    }
    const pr = Ar[c * n + c], pi = Ai[c * n + c], pd = pr * pr + pi * pi;
    if (pd === 0) continue;
    for (let r = c + 1; r < n; r++) {
      const ar = Ar[r * n + c], ai = Ai[r * n + c];
      if (ar === 0 && ai === 0) continue;
      const fr = (ar * pr + ai * pi) / pd, fi = (ai * pr - ar * pi) / pd;
      for (let k = c; k < n; k++) {
        const ck = c * n + k, rk = r * n + k, cr = Ar[ck], ci = Ai[ck];
        if (cr === 0 && ci === 0) continue;
        Ar[rk] -= fr * cr - fi * ci; Ai[rk] -= fr * ci + fi * cr;
      }
      br[r] -= fr * br[c] - fi * bi[c]; bi[r] -= fr * bi[c] + fi * br[c];
    }
  }
  const xr = new Float64Array(n), xi = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sr = br[r], si = bi[r];
    for (let k = r + 1; k < n; k++) { const rk = r * n + k; sr -= Ar[rk] * xr[k] - Ai[rk] * xi[k]; si -= Ar[rk] * xi[k] + Ai[rk] * xr[k]; }
    const dr = Ar[r * n + r], di = Ai[r * n + r], dd = dr * dr + di * di;
    xr[r] = (sr * dr + si * di) / dd; xi[r] = (si * dr - sr * di) / dd;
  }
  return [xr, xi];
}

/**
 * Memoise compiled circuits for a netlist factory. The cache key is a fingerprint of the values and
 * options (not object identity), so in-place edits to a values object are picked up.
 */
export function compiledFactory<V, O>(build: (v: V, o: O) => Netlist, size = 16): (v: V, o: O) => Circuit {
  const cache = new Map<string, Circuit>();
  return (v, o) => {
    const key = fingerprint(v) + '|' + fingerprint(o);
    let c = cache.get(key);
    if (c) { cache.delete(key); cache.set(key, c); return c; }
    c = new Circuit(build(v, o));
    cache.set(key, c);
    if (cache.size > size) cache.delete(cache.keys().next().value!);
    return c;
  };
}

function fingerprint(x: unknown): string {
  if (!x || typeof x !== 'object') return String(x);
  let s = '';
  for (const k in x as Record<string, unknown>) s += k + '=' + (x as Record<string, unknown>)[k] + ';';
  return s;
}
