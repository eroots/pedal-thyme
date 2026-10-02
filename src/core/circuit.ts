// Small-signal circuit solvers: series/shunt ladders, nodal analysis and closed-form helpers.
import { Cx, cx, ONE, par } from './complex';

/**
 * Source/load terminations seen by a circuit: Thevenin source impedance `zs` in series with the
 * input and load impedance `zl` across the output. `null` means ideal (0 Ω source / open load).
 */
export interface Zterm { zs: Cx | null; zl: Cx | null }

export const addZs = (z: Zterm | null | undefined, x: Cx): Cx => (z && z.zs ? x.add(z.zs) : x);
export const parZl = (z: Zterm | null | undefined, x: Cx): Cx => (z && z.zl ? par(x, z.zl) : x);

export interface LadderStage { ser: Cx; sh: Cx }

/** Voltage transfer of a series/shunt ladder. Unbuffered: each stage loads the one before it. */
export function ladder(stages: LadderStage[], buffered: boolean, z?: Zterm | null): Cx {
  if (z && (z.zs || z.zl)) {
    stages = stages.map((st, i) => ({
      ser: i === 0 ? addZs(z, st.ser) : st.ser,
      sh: i === stages.length - 1 ? parZl(z, st.sh) : st.sh,
    }));
  }
  if (buffered) return stages.reduce((h, st) => h.mul(st.sh.div(st.ser.add(st.sh))), ONE);
  const n = stages.length, shEff: Cx[] = new Array(n);
  let zNext: Cx | null = null;
  for (let i = n - 1; i >= 0; i--) {
    shEff[i] = zNext ? par(stages[i].sh, zNext) : stages[i].sh;
    zNext = stages[i].ser.add(shEff[i]);
  }
  let h = ONE;
  for (let i = 0; i < n; i++) h = h.mul(shEff[i].div(stages[i].ser.add(shEff[i])));
  return h;
}

/** Two-terminal admittance between nodes a and b (0 = ground). */
export type Elem = [a: number, b: number, y: Cx];

/**
 * Nodal analysis. n nodes (1..n, 0 = ground); elems are admittances between node pairs. A 1 V source
 * drives node `inNode` through impedance zs (≈0 Ω when ideal). Returns node voltages [0, v1..vn].
 */
export function nodal(n: number, elems: Elem[], inNode: number, zs?: Cx | null): Cx[] {
  // Plain re/im arrays: this runs thousands of times per redraw for tone stacks.
  const Ar = new Float64Array(n * n), Ai = new Float64Array(n * n), br = new Float64Array(n), bi = new Float64Array(n);
  const add = (r: number, c: number, yr: number, yi: number) => { const k = r * n + c; Ar[k] += yr; Ai[k] += yi; };
  const stamp = (i: number, j: number, yr: number, yi: number) => {
    if (i) add(i - 1, i - 1, yr, yi);
    if (j) add(j - 1, j - 1, yr, yi);
    if (i && j) { add(i - 1, j - 1, -yr, -yi); add(j - 1, i - 1, -yr, -yi); }
  };
  for (const [i, j, y] of elems) stamp(i, j, y.re, y.im);
  const ys = ONE.div(zs || cx(1e-3));
  stamp(inNode, 0, ys.re, ys.im);
  br[inNode - 1] = ys.re; bi[inNode - 1] = ys.im;
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < n; c++) {
    let p = c, best = -1;
    for (let r = c; r < n; r++) { const k = r * n + c, m = Ar[k] * Ar[k] + Ai[k] * Ai[k]; if (m > best) { best = m; p = r; } }
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        const a = c * n + k, b = p * n + k;
        let t = Ar[a]; Ar[a] = Ar[b]; Ar[b] = t; t = Ai[a]; Ai[a] = Ai[b]; Ai[b] = t;
      }
      let t = br[c]; br[c] = br[p]; br[p] = t; t = bi[c]; bi[c] = bi[p]; bi[p] = t;
    }
    const pr = Ar[c * n + c], pi = Ai[c * n + c], pd = pr * pr + pi * pi;
    for (let r = c + 1; r < n; r++) {
      const ar = Ar[r * n + c], ai = Ai[r * n + c];
      if (ar === 0 && ai === 0) continue;
      const fr = (ar * pr + ai * pi) / pd, fi = (ai * pr - ar * pi) / pd;
      for (let k = c; k < n; k++) {
        const ck = c * n + k, rk = r * n + k;
        Ar[rk] -= fr * Ar[ck] - fi * Ai[ck]; Ai[rk] -= fr * Ai[ck] + fi * Ar[ck];
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
  const out = [new Cx(0, 0)];
  for (let r = 0; r < n; r++) out.push(new Cx(xr[r], xi[r]));
  return out;
}

/** Unity-gain Sallen-Key: Z1, Z2 in series to (+), Z3 feedback from the junction, Z4 from (+) to ground. */
export const sallenKey = (Z1: Cx, Z2: Cx, Z3: Cx, Z4: Cx): Cx =>
  Z3.mul(Z4).div(Z3.mul(Z4).add(Z3.mul(Z1.add(Z2))).add(Z1.mul(Z2)));

/** Solve [a b; c d]·[x; y] = [e; f] for complex x, y. */
export function solve2(a: Cx, b: Cx, c: Cx, d: Cx, e: Cx, f: Cx): [Cx, Cx] {
  const det = a.mul(d).sub(b.mul(c));
  return [e.mul(d).sub(b.mul(f)).div(det), a.mul(f).sub(e.mul(c)).div(det)];
}
