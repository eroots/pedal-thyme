// IEC 60063 preferred-number series, normalised to mantissas in [1, 10).

export const E_SERIES = {
  E3: [1.0, 2.2, 4.7],
  E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
  E48: [100, 105, 110, 115, 121, 127, 133, 140, 147, 154, 162, 169, 178, 187, 196, 205, 215, 226, 237, 249, 261, 274, 287, 301,
        316, 332, 348, 365, 383, 402, 422, 442, 464, 487, 511, 536, 562, 590, 619, 649, 681, 715, 750, 787, 825, 866, 909, 953].map(x => x / 100),
  E96: [100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150, 154, 158, 162, 165, 169, 174,
        178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232, 237, 243, 249, 255, 261, 267, 274, 280, 287, 294, 301, 309,
        316, 324, 332, 340, 348, 357, 365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549,
        562, 576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866, 887, 909, 931, 953, 976].map(x => x / 100),
};
export type SeriesName = keyof typeof E_SERIES;
export const R_SERIES: SeriesName[] = ['E6', 'E12', 'E24', 'E48', 'E96'];
export const C_SERIES: SeriesName[] = ['E3', 'E6', 'E12', 'E24'];

const clean = (x: number) => parseFloat(x.toPrecision(4));

function seriesAround(v: number, ser: SeriesName): number[] {
  const d = Math.floor(Math.log10(v)), out: number[] = [];
  for (let k = d - 1; k <= d + 1; k++) for (const m of E_SERIES[ser]) out.push(clean(m * 10 ** k));
  return out;
}

/** Nearest series value (in log distance). */
export function snap(v: number, ser: SeriesName): number {
  if (!(v > 0) || !isFinite(v)) return v;
  let best = v, bd = Infinity;
  for (const c of seriesAround(v, ser)) { const d = Math.abs(Math.log(c / v)); if (d < bd) { bd = d; best = c; } }
  return best;
}

/** Smallest series value ≥ v. */
export function snapUp(v: number, ser: SeriesName): number {
  let best = Infinity;
  for (const c of seriesAround(v, ser)) if (c >= v * (1 - 1e-9) && c < best) best = c;
  return best;
}

/** Next (dir > 0) or previous (dir < 0) series value. */
export function stepSeries(v: number, ser: SeriesName, dir: number): number {
  if (!(v > 0)) return v;
  const c = seriesAround(v, ser).sort((a, b) => a - b);
  if (dir > 0) return c.find(x => x > v * (1 + 1e-6)) ?? v;
  for (let i = c.length - 1; i >= 0; i--) if (c[i] < v * (1 - 1e-6)) return c[i];
  return v;
}

/** All series values in [lo, hi]. */
export function seriesValues(ser: SeriesName, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++)
    for (const m of E_SERIES[ser]) { const x = clean(m * 10 ** d); if (x >= lo * 0.999 && x <= hi * 1.001) out.push(x); }
  return out;
}
