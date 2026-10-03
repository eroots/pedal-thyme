import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import { TEMPLATES } from '../src/builder/templates';
import { acModel } from '../src/engine/linearize';
import { C, GND, OA, R, type Element, type Netlist } from '../src/engine/netlist';
import { renderAudio, TransientSim } from '../src/engine/transient';
import { extract } from '../src/schematic/extract';

const FS = 48000;
const nl = (elements: Element[]): Netlist => ({ elements, input: 'in', output: 'out' });
const sine = (f: number, amp: number, seconds: number, fs = FS) => Float64Array.from({ length: Math.round(seconds * fs) }, (_, t) => amp * Math.sin(TAU * f * t / fs));
/** Amplitude and phase (vs sin) of the f component over the last `cycles` whole cycles. */
function tone(y: ArrayLike<number>, f: number, fs = FS, cycles = 20): { amp: number; phase: number } {
  const n = Math.round(cycles * fs / f), start = y.length - n;
  let s = 0, c = 0;
  for (let t = start; t < y.length; t++) { s += y[t] * Math.sin(TAU * f * t / fs); c += y[t] * Math.cos(TAU * f * t / fs); }
  return { amp: 2 * Math.hypot(s, c) / n, phase: Math.atan2(c, s) };
}
const peak = (y: ArrayLike<number>, from = 0) => { let lo = Infinity, hi = -Infinity; for (let t = from; t < y.length; t++) { lo = Math.min(lo, y[t]); hi = Math.max(hi, y[t]); } return [lo, hi]; };

describe('transient simulation', () => {
  it('an RC low-pass matches 1/(1+jωRC) in gain and phase', () => {
    const net = nl([R('R1', 'in', 'out', 10e3), C('C1', 'out', GND, 15.9e-9)]);
    for (const f of [200, 1000, 5000]) {
      const r = renderAudio(net, sine(f, 1, 0.1), { fs: FS, oversample: 4 });
      const h = new Cx(1, 0).div(new Cx(1, TAU * f * 10e3 * 15.9e-9));
      const got = tone(r.out.get('out')!, f);
      expect(got.amp).toBeCloseTo(h.abs(), 3);
      expect(got.phase).toBeCloseTo(h.arg(), 2);
    }
  });

  it('small signals through every template match the AC analysis', () => {
    for (const t of TEMPLATES.filter(x => x.id !== 'empty')) {
      const ex = extract(t.build());
      const ac = acModel(ex.netlist).circuit.transfer(new Cx(0, TAU * 1000)).abs();
      const r = renderAudio(ex.netlist, sine(1000, 1e-4, 0.25), { fs: FS, oversample: 4 });
      const got = tone(r.out.get(ex.netlist.output)!, 1000).amp / 1e-4;
      expect(Math.abs(20 * Math.log10(got / ac)), t.id).toBeLessThan(0.25);
      expect(r.unconverged, t.id).toBe(0);
    }
  });

  it('a diode clipper limits to about a diode drop', () => {
    const net = nl([R('R1', 'in', 'out', 10e3),
      { type: 'D', name: 'D1', a: 'out', k: GND, model: '1N4148' }, { type: 'D', name: 'D2', a: GND, k: 'out', model: '1N4148' }]);
    const y = renderAudio(net, sine(500, 5, 0.04), { fs: FS, oversample: 4 }).out.get('out')!;
    const [lo, hi] = peak(y, y.length / 2);
    expect(hi).toBeGreaterThan(0.5); expect(hi).toBeLessThan(0.7); // 1N4148 at ~0.45 mA: n·VT·ln(I/Is) ≈ 0.55 V
    expect(lo).toBeLessThan(-0.5); expect(lo).toBeGreaterThan(-0.7);
  });

  it('op-amps clip at the supply rails minus their headroom', () => {
    // Non-inverting gain of 101 around a 4.5 V reference, TL072 on 9 V: swings 1.5 … 7.5 V.
    const net = nl([
      { type: 'V', name: 'V1', p: 'vcc', n: GND, dc: 9 }, { type: 'V', name: 'V2', p: 'vref', n: GND, dc: 4.5 },
      C('C1', 'in', 'p', 1e-6), R('R1', 'p', 'vref', 1e6),
      OA('U1', 'p', 'n', 'out', 'TL072'), R('Rf', 'out', 'n', 100e3), R('Rg', 'n', 'x', 1e3), C('Cg', 'x', 'vref', 10e-6),
    ]);
    const y = renderAudio(net, sine(200, 0.5, 0.2), { fs: FS, oversample: 4 }).out.get('out')!;
    const [lo, hi] = peak(y, y.length / 2);
    expect(hi).toBeGreaterThan(7.3); expect(hi).toBeLessThan(7.6);
    expect(lo).toBeLessThan(1.7); expect(lo).toBeGreaterThan(1.4);
  });

  it('a slow op-amp is slew-rate limited', () => {
    // LM308 (0.3 V/µs) as a follower of a fast 4 V step-like square: the edge takes ≥ 13 µs.
    const net = nl([OA('U1', 'in', 'out', 'out', 'LM308'), { type: 'V', name: 'V1', p: 'vcc', n: GND, dc: 9 }]);
    const rate = 4 * FS, sim = new TransientSim(net, { rate });
    const x = Float64Array.from({ length: 400 }, (_, t) => (t > 100 ? 6 : 2));
    const y = sim.run(x).out.get('out')!;
    let maxSlope = 0;
    for (let t = 1; t < y.length; t++) maxSlope = Math.max(maxSlope, Math.abs(y[t] - y[t - 1]) * rate);
    expect(maxSlope / 1e6).toBeLessThan(0.33);
    expect(maxSlope / 1e6).toBeGreaterThan(0.2);
    expect(y[y.length - 1]).toBeCloseTo(6, 2);
  });

  it('renders a second of the TS-style pedal at 4× oversampling in reasonable time', () => {
    const ex = extract(TEMPLATES.find(t => t.id === 'ts')!.build());
    const t0 = performance.now();
    const r = renderAudio(ex.netlist, sine(220, 0.3, 1), { fs: FS, oversample: 4 });
    const ms = performance.now() - t0;
    console.info(`TS: 1 s of audio in ${ms.toFixed(0)} ms`);
    expect(r.unconverged).toBe(0);
    expect(ms).toBeLessThan(20000);
  });
});

describe('audio analysis and signals', () => {
  it('measures harmonics and THD of a known signal', async () => {
    const { harmonics, spectrum, wav } = await import('../src/audio/analysis');
    // 1 V fundamental + 0.1 V 3rd harmonic → THD 10 %.
    const x = Float64Array.from({ length: FS }, (_, t) => Math.sin(TAU * 500 * t / FS) + 0.1 * Math.sin(TAU * 1500 * t / FS));
    const h = harmonics(x, 500, FS);
    expect(h.levels[0]).toBeCloseTo(1, 4);
    expect(h.levels[2]).toBeCloseTo(0.1, 4);
    expect(h.thd).toBeCloseTo(10, 2);
    const s = spectrum(x, FS);
    const k = s.freqs.findIndex(f => f >= 500);
    expect(Math.max(...s.dbv.slice(k - 2, k + 3))).toBeGreaterThan(-1.5); // ≈ 0 dBV
    const blob = wav(x.map(v => v / 2), FS);
    expect(blob.size).toBe(44 + 2 * FS);
  });
  it('plucked notes have the right pitch and peak level', async () => {
    const { pluck } = await import('../src/audio/signals');
    const x = pluck([110], 0.3, 1, FS);
    expect(Math.max(...x.map(Math.abs))).toBeCloseTo(0.3, 9);
    // Autocorrelation peak at the period of 110 Hz.
    const lagOf = (lag: number) => { let s = 0; for (let t = 0; t < 20000; t++) s += x[t] * x[t + lag]; return s; };
    const p = Math.round(FS / 110);
    expect(lagOf(p)).toBeGreaterThan(lagOf(Math.round(p * 0.75)));
    expect(lagOf(p)).toBeGreaterThan(lagOf(Math.round(p * 1.25)));
  });
});
