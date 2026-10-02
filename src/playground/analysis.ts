// Pure analysis helpers for the Playground: frequency grids, responses, tolerance and design scoring.
import { Cx } from '../core/complex';
import { Hfull } from '../core/measure';
import type { Term } from '../core/termination';
import type { Opts, Values } from '../core/types';
import { TAU, undb } from '../core/units';
import type { TargetKind, Topology } from '../topologies/types';

export function freqGrid(fmin: number, fmax: number, n = 420): number[] {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fmin * Math.pow(fmax / fmin, i / (n - 1));
  return out;
}

export interface Response { mag: number[]; ph: number[] }

/** Magnitude (dB) and phase (degrees) on a frequency grid. */
export function response(t: Topology, v: Values, o: Opts, freqs: number[], term?: Term | null): Response {
  const mag: number[] = new Array(freqs.length), ph: number[] = new Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const h = Hfull(t, v, new Cx(0, TAU * freqs[i]), o, term);
    mag[i] = 20 * Math.log10(h.abs());
    ph[i] = h.arg() * 180 / Math.PI;
  }
  return { mag, ph };
}

/**
 * Value sets at the ± tolerance corners: every corner when there are ≤ 6 parts, otherwise a fixed
 * pseudo-random sample of 64 corners (always including all-low and all-high).
 */
export function toleranceCorners(t: Topology, v: Values, rTolPct: number, cTolPct: number): Values[] {
  const parts = t.parts.filter(p => v[p.key] > 0), n = parts.length, runs: Values[] = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const masks = n <= 6 ? Array.from({ length: 1 << n }, (_, i) => i)
    : Array.from({ length: 64 }, (_, i) => (i === 0 ? 0 : i === 1 ? (1 << n) - 1 : Math.floor(rnd() * (1 << n))));
  for (const mask of masks) {
    const vv = { ...v };
    parts.forEach((p, i) => {
      const tol = (p.type === 'R' ? rTolPct : cTolPct) / 100;
      vv[p.key] = v[p.key] * (1 + ((mask >> i) & 1 ? tol : -tol));
    });
    runs.push(vv);
  }
  return runs;
}

export function valuesValid(t: Topology, v: Values): boolean {
  return t.parts.every(p => {
    const x = v[p.key];
    if (p.zeroOk && x === 0) return true;
    return typeof x === 'number' && isFinite(x) && x > 0;
  });
}

/** Stricter range check used to filter design-search candidates to buildable values. */
export function saneForSearch(t: Topology, v: Values): boolean {
  return t.parts.every(p => {
    const x = v[p.key];
    if (p.zeroOk && x === 0) return true;
    if (!(x > 0) || !isFinite(x)) return false;
    return p.type === 'R' ? x >= 100 && x <= 10e6 : x >= 10e-12 && x <= 1e-3;
  });
}

/** Relative error of a design metric; dB targets compare as amplitude ratios. */
export function targetErr(kind: TargetKind, target: number, actual: number | null | undefined): number {
  if (actual == null || !isFinite(actual)) return Infinity;
  if (kind === 'db') return Math.abs(undb(actual - target) - 1);
  return Math.abs(actual / target - 1);
}

export interface TargetEval { key: string; kind: TargetKind; target: number; actual: number | null | undefined; err: number }
export interface Evaluation { per: TargetEval[]; worst: number }

export function evaluate(t: Topology, v: Values, o: Opts, tg: Values): Evaluation {
  const metrics = Object.fromEntries(t.analyze(v, o, t).map(m => [m.key, m.value]));
  let worst = 0;
  const per = t.targets.filter(x => x.kind !== 'param').map(x => {
    const actual = metrics[x.key], err = targetErr(x.kind, tg[x.key], actual);
    worst = Math.max(worst, err);
    return { key: x.key, kind: x.kind, target: tg[x.key], actual, err };
  });
  return { per, worst };
}
