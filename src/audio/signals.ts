// Test signals for the time-domain simulation, in volts (a guitar pickup gives roughly 0.1–1 V peak).

/** A sine of the given peak amplitude, with a short fade-in so the circuit isn't kicked by a step. */
export function sine(f: number, peak: number, seconds: number, fs: number, fadeSeconds = 0.005): Float64Array {
  const n = Math.round(seconds * fs), fade = Math.max(1, Math.min(n, Math.round(fadeSeconds * fs)));
  return Float64Array.from({ length: n }, (_, t) => peak * Math.sin((2 * Math.PI * f * t) / fs) * (t < fade ? t / fade : 1));
}

/**
 * A sine that rings out like a plucked note: a quick attack, then an exponential decay to `floorDb`
 * (relative to the peak) at the end, so clipping can be seen easing off as the level drops.
 */
export function fadingSine(f: number, peak: number, seconds: number, fs: number, floorDb = -40): Float64Array {
  const n = Math.round(seconds * fs), attack = Math.min(n, Math.round(0.003 * fs));
  const k = Math.log(10 ** (floorDb / 20)) / Math.max(1, n - attack);
  return Float64Array.from({ length: n }, (_, t) => {
    const env = t < attack ? t / attack : Math.exp(k * (t - attack));
    return peak * env * Math.sin((2 * Math.PI * f * t) / fs);
  });
}

/**
 * A plucked string (Karplus–Strong with a decay filter), as a stand-in for a DI guitar. `notes` are
 * frequencies; several notes are strummed 25 ms apart.
 */
export function pluck(notes: number[], peak: number, seconds: number, fs: number, seed = 1): Float64Array {
  const n = Math.round(seconds * fs), out = new Float64Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  notes.forEach((f, k) => {
    const start = Math.round(k * 0.025 * fs), len = Math.max(2, Math.round(fs / f));
    const buf = Float64Array.from({ length: len }, () => rnd());
    // Soften the attack a little (a pick, not a hammer).
    for (let p = 0; p < 2; p++) for (let i = len - 1; i > 0; i--) buf[i] = 0.5 * (buf[i] + buf[i - 1]);
    let idx = 0;
    const decay = 0.996;
    for (let t = start; t < n; t++) {
      const next = (idx + 1) % len;
      const v = buf[idx];
      buf[idx] = decay * 0.5 * (buf[idx] + buf[next]);
      idx = next;
      out[t] += v;
    }
  });
  return normalize(out, peak);
}

/** Scale a signal so its peak is `peak` (volts). */
export function normalize(x: Float64Array, peak: number): Float64Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (!(m > 0)) return x;
  const g = peak / m;
  return x.map(v => v * g);
}

/** Standard tuning, low E to high E (Hz). */
export const STRINGS = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];
/** An open E major chord. */
export const E_MAJOR = [82.41, 123.47, 164.81, 207.65, 246.94, 329.63];
