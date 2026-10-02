// Numerical measurements on a frequency response: −3 dB points, bells (peaks/notches), spot levels.
import { Cx } from './complex';
import { TAU, db } from './units';
import { termAt, termActive, type Term } from './termination';
import type { Opts, Transfer, Values } from './types';

/** H(s) including an optional source/load termination. */
export function Hfull(t: Transfer, v: Values, s: Cx, o: Opts, term?: Term | null): Cx {
  if (!termActive(term)) return t.H(v, s, o, null);
  const z = termAt(term, s);
  return z.g.mul(t.H(v, s, o, z));
}

/** Level in dB at frequency f (ideal termination). */
export const levelAt = (t: Transfer, v: Values, o: Opts, f: number): number => db(t.H(v, new Cx(0, TAU * f), o).abs());

export interface Edges { fPeak: number; peakDb: number; fLo: number | null; fHi: number | null }

/** Peak of the response and the −3 dB points relative to it (searched over 0.5 Hz – 2 MHz). */
export function edges(t: Transfer, v: Values, o: Opts, term?: Term | null): Edges {
  const N = 320, f0 = 0.5, f1 = 2e6, lf = (i: number) => f0 * Math.pow(f1 / f0, i / (N - 1));
  const mag = (f: number) => Hfull(t, v, new Cx(0, TAU * f), o, term).abs();
  const m: number[] = new Array(N);
  let pk = 0, pkI = 0;
  for (let i = 0; i < N; i++) { m[i] = mag(lf(i)); if (m[i] > pk * (1 + 1e-9)) { pk = m[i]; pkI = i; } }
  const thr = pk / Math.SQRT2;
  const refine = (a: number, b: number) => {
    let ma = mag(a) - thr;
    for (let k = 0; k < 40; k++) {
      const c = Math.sqrt(a * b), mc = mag(c) - thr;
      if ((mc > 0) === (ma > 0)) { a = c; ma = mc; } else b = c;
    }
    return Math.sqrt(a * b);
  };
  let fLo: number | null = null, fHi: number | null = null;
  for (let i = pkI; i > 0; i--) if (m[i - 1] < thr) { fLo = refine(lf(i - 1), lf(i)); break; }
  for (let i = pkI; i < N - 1; i++) if (m[i + 1] < thr) { fHi = refine(lf(i), lf(i + 1)); break; }
  return { fPeak: lf(pkI), peakDb: 20 * Math.log10(pk), fLo, fHi };
}

export interface Bell {
  f0: number | null; gain: number; Q: number | null; fLo: number | null; fHi: number | null;
  ref: number; lo: number; hi: number; isDip: boolean;
}

/**
 * Measure a bell-shaped deviation (scoop/notch or peak) relative to the average of the levels at
 * 0.5 Hz and 50 kHz. Q uses the EQ convention: bandwidth between half-gain (dB) points.
 * The upper reference stays at 50 kHz so real op-amps' ultrasonic roll-off or peaking doesn't skew it.
 */
export function bell(t: Transfer, v: Values, o: Opts, term?: Term | null): Bell {
  const N = 240, f0 = 0.5, f1 = 50e3, lf = (i: number) => f0 * Math.pow(f1 / f0, i / (N - 1));
  const dbAt = (f: number) => 20 * Math.log10(Hfull(t, v, new Cx(0, TAU * f), o, term).abs());
  const m: number[] = new Array(N);
  for (let i = 0; i < N; i++) m[i] = dbAt(lf(i));
  const lo = m[0], hi = m[N - 1], ref = (lo + hi) / 2;
  const none: Bell = { f0: null, gain: 0, Q: null, fLo: null, fHi: null, ref, lo, hi, isDip: false };
  if (!isFinite(ref)) return none;
  let iMax = 0, iMin = 0;
  for (let i = 1; i < N; i++) { if (m[i] > m[iMax]) iMax = i; if (m[i] < m[iMin]) iMin = i; }
  const isDip = ref - m[iMin] >= m[iMax] - ref, i0 = isDip ? iMin : iMax, sgn = isDip ? 1 : -1;
  // A real bell must sit beyond *both* end levels; otherwise it's just a slope/shelf.
  if (isDip ? m[i0] > Math.min(lo, hi) - 0.05 : m[i0] < Math.max(lo, hi) + 0.05) return { ...none, isDip };
  // Golden-section refine of the extreme in log-frequency.
  let a = Math.log(lf(Math.max(0, i0 - 1))), b = Math.log(lf(Math.min(N - 1, i0 + 1)));
  const gr = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 36; k++) {
    const c = b - gr * (b - a), d = a + gr * (b - a);
    if (sgn * dbAt(Math.exp(c)) < sgn * dbAt(Math.exp(d))) b = d; else a = c;
  }
  const fx = Math.exp((a + b) / 2), gain = dbAt(fx) - ref;
  if (Math.abs(gain) < 0.05) return { ...none, isDip };
  const half = ref + gain / 2;
  const refine = (fa: number, fb: number) => {
    let sa = dbAt(fa) - half;
    for (let k = 0; k < 40; k++) {
      const c = Math.sqrt(fa * fb), sc = dbAt(c) - half;
      if ((sc > 0) === (sa > 0)) { fa = c; sa = sc; } else fb = c;
    }
    return Math.sqrt(fa * fb);
  };
  const beyond = (y: number) => sgn * (y - half) < 0; // true once we're inside the bell
  let fLo: number | null = null, fHi: number | null = null;
  for (let i = i0; i > 0; i--) if (beyond(m[i]) && !beyond(m[i - 1])) { fLo = refine(lf(i - 1), Math.min(lf(i), fx)); break; }
  for (let i = i0; i < N - 1; i++) if (beyond(m[i]) && !beyond(m[i + 1])) { fHi = refine(Math.max(lf(i), fx), lf(i + 1)); break; }
  return { f0: fx, gain, Q: fLo && fHi ? fx / (fHi - fLo) : null, fLo, fHi, ref, lo, hi, isDip };
}
