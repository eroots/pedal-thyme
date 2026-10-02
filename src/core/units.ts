// Engineering notation, decibels and small numeric helpers.

export const TAU = 2 * Math.PI;

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, r: 1, R: 1 };

/** Parse values like `4.7k`, `4k7`, `22n`, `2n2`, `1u`, `1M`, `1meg`, `1e-9`, `10kΩ`. Returns NaN when unparseable. */
export function parseEng(str: string | number): number {
  if (typeof str === 'number') return str;
  const s = String(str).trim().replace(/\s+/g, '').replace(/(ohms?|Ω|F|Hz)$/i, '').replace(/meg/i, 'M');
  let m = s.match(/^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)([pnuµμmkKMGrR]?)$/);
  if (m) return parseFloat(m[1]) * (m[2] ? PREFIX[m[2]] : 1);
  m = s.match(/^(\d+)([pnuµμmkKMGrR])(\d+)$/); // 4k7, 2n2, 4R7
  if (m) return parseFloat(m[1] + '.' + m[3]) * PREFIX[m[2]];
  return NaN;
}

/** Format with an SI prefix and 3 significant figures: `4.7 kΩ`, `22 nF`, or `4.7k` without a unit. */
export function fmtEng(v: number | null | undefined, unit = ''): string {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return unit ? '0 ' + unit : '0';
  const steps: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
  const a = Math.abs(v);
  for (const [f, p] of steps) {
    if (a >= f * 0.9995 || f === 1e-12) {
      const s = String(parseFloat((v / f).toPrecision(3)));
      return unit ? `${s} ${p}${unit}` : s + p;
    }
  }
  return String(v);
}

export const db = (x: number): number => 20 * Math.log10(x);
export const undb = (x: number): number => Math.pow(10, x / 20);
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
