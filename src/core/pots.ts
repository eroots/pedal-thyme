// Potentiometer tapers: rotation r (0..1) → fraction of the track resistance.
import { clamp } from './units';

export type TaperKey = 'A' | 'B' | 'C' | 'W';

const A_K = 2 * Math.log(9); // audio taper ≈ 10% at mid-rotation
// W: an S-curve, steep at both ends and flat around the middle (reverse log up to half-way, log after).
// Each half is a gentler log curve, 25% of the way at its own midpoint, so W(0.25) = 37.5%, W(0.5) = 50%.
const W_K = 2 * Math.log(3);
const halfLog = (x: number) => (Math.exp(W_K * x) - 1) / (Math.exp(W_K) - 1);

export const TAPERS: Record<TaperKey, { label: string; f: (r: number) => number }> = {
  B: { label: 'Linear (B)', f: r => r },
  A: { label: 'Audio / log (A)', f: r => (Math.exp(A_K * r) - 1) / (Math.exp(A_K) - 1) },
  C: { label: 'Reverse log (C)', f: r => 1 - (Math.exp(A_K * (1 - r)) - 1) / (Math.exp(A_K) - 1) },
  W: { label: 'S-curve (W)', f: r => (r < 0.5 ? 0.5 - 0.5 * halfLog(1 - 2 * r) : 0.5 + 0.5 * halfLog(2 * r - 1)) },
};

export const taper = (r: number, k: string): number => (TAPERS[k as TaperKey] || TAPERS.B).f(clamp(r, 0, 1));

/**
 * Fraction of the track between pin 1 and the wiper. Reversed = lugs 1 and 3 swapped in the wiring (or a
 * variable resistor on lugs 2+3): the taper stays with the track, so it's 1 − taper(r), not taper(1 − r).
 */
export const potFraction = (r: number, k: string, reverse?: boolean): number => (reverse ? 1 - taper(r, k) : taper(r, k));

/** Split a track of resistance R at fraction `frac` (clamped away from 0/1 to keep solves finite). */
export const potSplit = (R: number, frac: number): [number, number] => {
  const f = clamp(frac, 1e-4, 1 - 1e-4);
  return [R * f, R * (1 - f)];
};
