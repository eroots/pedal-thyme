// Potentiometer tapers: rotation r (0..1) → fraction of the track resistance.
import { clamp } from './units';

export type TaperKey = 'A' | 'B' | 'C';

const A_K = 2 * Math.log(9); // audio taper ≈ 10% at mid-rotation

export const TAPERS: Record<TaperKey, { label: string; f: (r: number) => number }> = {
  B: { label: 'Linear (B)', f: r => r },
  A: { label: 'Audio / log (A)', f: r => (Math.exp(A_K * r) - 1) / (Math.exp(A_K) - 1) },
  C: { label: 'Reverse log (C)', f: r => 1 - (Math.exp(A_K * (1 - r)) - 1) / (Math.exp(A_K) - 1) },
};

export const taper = (r: number, k: string): number => (TAPERS[k as TaperKey] || TAPERS.B).f(clamp(r, 0, 1));

/** Split a track of resistance R at fraction `frac` (clamped away from 0/1 to keep solves finite). */
export const potSplit = (R: number, frac: number): [number, number] => {
  const f = clamp(frac, 1e-4, 1 - 1e-4);
  return [R * f, R * (1 - f)];
};
