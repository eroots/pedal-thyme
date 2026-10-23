import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_DBU, dbuToPeakVolts, includesCab, parseNam, voltsToDigital } from '../src/audio/nam';

/**
 * The smallest WaveNet: 1 channel, one layer (kernel 2, dilation 3), LeakyReLU with slope 1 (so it's
 * linear and the output can be worked out by hand), layer 1×1, a 1-tap head.
 * Weights in NAM's order: rechannel, conv taps (oldest first) + bias, input mixin, layer 1×1 + bias,
 * head, head scale.
 */
const tiny = (weights: number[], extra: Record<string, unknown> = {}) => ({
  version: '0.7.0', architecture: 'WaveNet', sample_rate: 48000, weights,
  metadata: { name: 'Tiny amp', gear_type: 'full-rig', input_level_dbu: 15 },
  config: {
    head: null, head_scale: 1,
    layers: [{
      input_size: 1, condition_size: 1, channels: 1, bottleneck: 1, kernel_sizes: [2], dilations: [3],
      activation: [{ type: 'LeakyReLU', negative_slope: 1 }], gating_mode: ['none'],
      head: { out_channels: 1, kernel_size: 1, bias: false }, layer1x1: { active: true, groups: 1 }, head1x1: { active: false },
      ...extra,
    }],
  },
});
// rechannel 2; conv taps 0.5 (x[t-3]) and 0.25 (x[t]), bias 0; mixin 1; layer1x1 0.7 + 0; head 1; scale 1.
// out[t] = 0.5·2x[t−3] + 0.25·2x[t] + x[t] = x[t−3] + 1.5·x[t].
const W = [2, 0.5, 0.25, 0, 1, 0.7, 0, 1, 1];

describe('NAM captures', () => {
  it('runs a WaveNet: taps, dilation, input mixin and head, oldest tap first', () => {
    const m = parseNam(JSON.stringify(tiny(W)));
    expect(m.info).toEqual({ name: 'Tiny amp', gearType: 'full-rig', inputLevelDbu: 15, sampleRate: 48000, weights: 9 });
    expect(m.net.receptiveField).toBe(4);
    const y = m.net.process(Float32Array.from([1, 0, 0, 0, 0, 0]));
    expect(Array.from(y).map(v => +v.toFixed(6))).toEqual([1.5, 0, 0, 1, 0, 0]);
  });

  it('starts from silence like NAM (a bias is already settled at the first sample)', () => {
    const biased = [...W]; biased[3] = 0.1; // conv bias
    const y = parseNam(JSON.stringify(tiny(biased))).net.process(new Float32Array(3));
    expect(Array.from(y).map(v => +v.toFixed(6))).toEqual([0.1, 0.1, 0.1]);
  });

  it('checks the weights fit the layout, and refuses what it can’t play', () => {
    expect(() => parseNam(JSON.stringify(tiny([...W, 0])))).toThrow(/10 weights but its layout uses 9/);
    expect(() => parseNam(JSON.stringify(tiny(W.slice(0, 5))))).toThrow(/fewer weights/);
    expect(() => parseNam(JSON.stringify(tiny(W, { gating_mode: ['gated'] })))).toThrow(/gated/);
    expect(() => parseNam(JSON.stringify(tiny(W, { activation: [{ type: 'Mystery' }] })))).toThrow(/Mystery/);
    expect(() => parseNam(JSON.stringify({ architecture: 'LSTM', config: {}, weights: [] }))).toThrow(/LSTM/);
    expect(() => parseNam('not json')).toThrow(/isn’t a NAM capture/);
  });

  it('uses the full-size model of a SlimmableContainer', () => {
    const small = tiny([2, 0, 0, 0, 0, 0, 0, 1, 1]); // silent
    const file = { version: '0.7.0', architecture: 'SlimmableContainer', weights: [], sample_rate: 48000, metadata: { name: 'Both', gear_type: 'amp_cab' },
      config: { submodels: [{ max_value: 0.5, model: small }, { max_value: 1, model: tiny(W) }] } };
    const m = parseNam(JSON.stringify(file));
    expect(m.info.name).toBe('Both');
    expect(m.net.process(Float32Array.from([1]))[0]).toBeCloseTo(1.5, 6);
  });

  it('turns pedal volts into the digital level the capture was made at', () => {
    expect(dbuToPeakVolts(0)).toBeCloseTo(1.0954, 4);
    // Full scale at +15 dBu is ≈ 6.16 V peak; a ±1 V signal (with 4.5 V of DC, as a pedal output might have) ≈ ±0.162.
    const d = voltsToDigital([5.5, 3.5, 5.5, 3.5], 15);
    expect(d[0]).toBeCloseTo(1 / dbuToPeakVolts(15), 6);
    expect(d[1]).toBeCloseTo(-1 / dbuToPeakVolts(15), 6);
    // Unknown level: a typical interface's; +6 dB into the amp doubles it.
    expect(voltsToDigital([1, -1], null, 6)[0]).toBeCloseTo(10 ** (6 / 20) / dbuToPeakVolts(DEFAULT_INPUT_DBU), 6);
    expect(includesCab('full-rig')).toBe(true);
    expect(includesCab('amp_cab')).toBe(true);
    expect(includesCab('amp')).toBe(false);
    expect(includesCab(null)).toBe(false);
  });
});
