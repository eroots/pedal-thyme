// Integer-factor resampling for oversampled simulation: windowed-sinc (Blackman) FIR filters.
// upsample() interpolates to factor × the rate; downsample() low-passes (anti-alias) and decimates.

const TAPS_PER_PHASE = 24;

/** Low-pass FIR with cutoff `fc` (fraction of the sample rate) and `n` taps (odd). */
function lowpass(n: number, fc: number): Float64Array {
  const h = new Float64Array(n), m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

/** Interpolate by an integer factor (output length = input length × factor). */
export function upsample(x: ArrayLike<number>, factor: number): Float64Array {
  if (factor === 1) return Float64Array.from(x);
  const n = TAPS_PER_PHASE * factor + 1, h = lowpass(n, 0.45 / factor), m = (n - 1) / 2;
  const y = new Float64Array(x.length * factor);
  for (let t = 0; t < y.length; t++) {
    // y[t] = factor · Σ h[k] · z[t − k + m], where z is x zero-stuffed.
    let s = 0;
    const k0 = (t + m) % factor;
    for (let k = k0; k < n; k += factor) {
      const j = (t - k + m) / factor;
      if (j >= 0 && j < x.length) s += h[k] * x[j];
    }
    y[t] = s * factor;
  }
  return y;
}

/** Anti-alias filter and keep every `factor`-th sample. */
export function downsample(y: ArrayLike<number>, factor: number): Float64Array {
  if (factor === 1) return Float64Array.from(y);
  const n = TAPS_PER_PHASE * factor + 1, h = lowpass(n, 0.45 / factor), m = (n - 1) / 2;
  const out = new Float64Array(Math.floor(y.length / factor));
  for (let o = 0; o < out.length; o++) {
    const t = o * factor;
    let s = 0;
    for (let k = 0; k < n; k++) {
      const j = t - k + m;
      s += h[k] * (j < 0 ? y[0] : j >= y.length ? y[y.length - 1] : y[j]);
    }
    out[o] = s;
  }
  return out;
}
