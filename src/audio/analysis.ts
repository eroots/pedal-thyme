// Signal analysis: spectrum (FFT), harmonic levels and THD, and WAV encoding.

/** In-place radix-2 FFT (re, im arrays of a power-of-two length). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Magnitude spectrum of the last part of a signal (Hann window), as peak volts per bin in dBV, with
 * the bin frequencies. Uses up to 2^15 samples.
 */
export function spectrum(x: ArrayLike<number>, fs: number, maxN = 1 << 15): { freqs: number[]; dbv: number[] } {
  let n = 1;
  while (n * 2 <= Math.min(maxN, x.length)) n *= 2;
  const re = new Float64Array(n), im = new Float64Array(n), off = x.length - n;
  let wsum = 0;
  for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); re[i] = x[off + i] * w; wsum += w; }
  fft(re, im);
  const freqs: number[] = [], dbv: number[] = [];
  for (let k = 1; k < n / 2; k++) {
    freqs.push((k * fs) / n);
    dbv.push(20 * Math.log10(Math.max(1e-12, (2 * Math.hypot(re[k], im[k])) / wsum)));
  }
  return { freqs, dbv };
}

/**
 * Levels (peak volts) of harmonics 1…count of f0, measured over a whole number of cycles at the end of
 * the signal, and THD (% of the fundamental).
 */
export function harmonics(x: ArrayLike<number>, f0: number, fs: number, count = 10, seconds = 0.25): { levels: number[]; thd: number } {
  const cycles = Math.max(1, Math.floor(Math.min(seconds, x.length / fs) * f0));
  const n = Math.round((cycles * fs) / f0), start = x.length - n;
  const levels: number[] = [];
  for (let k = 1; k <= count; k++) {
    if (k * f0 >= fs / 2) { levels.push(0); continue; }
    let s = 0, c = 0;
    const w = (2 * Math.PI * k * f0) / fs;
    for (let t = start; t < x.length; t++) { s += x[t] * Math.sin(w * t); c += x[t] * Math.cos(w * t); }
    levels.push((2 * Math.hypot(s, c)) / n);
  }
  const thd = levels[0] > 0 ? (Math.sqrt(levels.slice(1).reduce((a, v) => a + v * v, 0)) / levels[0]) * 100 : 0;
  return { levels, thd };
}

export const peakOf = (x: ArrayLike<number>, from = 0): number => { let m = 0; for (let i = from; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
export const rmsOf = (x: ArrayLike<number>, from = 0): number => { let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length - from)); };

/** 16-bit PCM mono WAV of a signal already scaled to ±1. */
export function wav(x: ArrayLike<number>, fs: number): Blob {
  const n = x.length, buf = new ArrayBuffer(44 + 2 * n), d = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); d.setUint32(4, 36 + 2 * n, true); str(8, 'WAVE'); str(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, fs, true);
  d.setUint32(28, fs * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) d.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
  return new Blob([buf], { type: 'audio/wav' });
}
