// Neural Amp Modeler (NAM) captures: load a .nam file and run it over a rendered signal (offline).
//
// Follows the WaveNet model of NeuralAmpModelerCore (https://github.com/sdatkinson/NeuralAmpModelerCore,
// MIT licence, © Steven Atkinson): the same weight layout and arithmetic, written out for whole-signal
// processing instead of streaming. Supported: WaveNet with ungated layers (any activation listed below,
// per-layer kernel sizes and dilations, bottleneck, layer 1×1, a head with any kernel size), and
// SlimmableContainer files (the full-size submodel is used). Anything else is reported, not guessed.
//
// A capture expects digital samples at the sample rate it was trained at (usually 48 kHz), scaled so
// that 0 dBFS is the level given by its "input_level_dbu" metadata; see voltsToDigital().

export interface NamInfo {
  name: string;
  /** "amp", "amp_cab", "full-rig", "pedal", … (when the file says). */
  gearType: string | null;
  /** Analogue level of digital full scale while capturing (dBu), when known. */
  inputLevelDbu: number | null;
  sampleRate: number;
  /** Size of the network (number of weights). */
  weights: number;
}

/** A typical audio interface's instrument input: what full scale is assumed when a capture doesn't say. */
export const DEFAULT_INPUT_DBU = 12;

/** Peak volts of a sine at the given level in dBu (0 dBu = 0.7746 V rms). */
export const dbuToPeakVolts = (dbu: number): number => 0.7746 * Math.SQRT2 * 10 ** (dbu / 20);

/** Is this capture an amp with its cabinet (so no cab simulation is needed)? */
export const includesCab = (gearType: string | null): boolean => !!gearType && /cab|full.?rig/i.test(gearType);

type Act = (x: number) => number;

function activation(cfg: unknown): Act {
  const c = (typeof cfg === 'string' ? { type: cfg } : cfg) as { type?: string; negative_slope?: number; min_val?: number; max_val?: number; min_slope?: number; max_slope?: number };
  switch (c?.type) {
    case 'Tanh': return Math.tanh;
    case 'Fasttanh': return x => {
      const ax = Math.abs(x), x2 = x * x;
      return (x * (2.45550750702956 + 2.45550750702956 * ax + (0.893229853513558 + 0.821226666969744 * ax) * x2))
        / (2.44506634652299 + (2.44506634652299 + x2) * Math.abs(x + 0.814642734961073 * x * ax));
    };
    case 'Hardtanh': return x => (x < -1 ? -1 : x > 1 ? 1 : x);
    case 'ReLU': return x => (x > 0 ? x : 0);
    case 'LeakyReLU': { const s = c.negative_slope ?? 0.01; return x => (x > 0 ? x : s * x); }
    case 'Sigmoid': return x => 1 / (1 + Math.exp(-x));
    case 'SiLU': return x => x / (1 + Math.exp(-x));
    case 'Hardswish': return x => { const t = x + 3; return (x * (t < 0 ? 0 : t > 6 ? 6 : t)) / 6; };
    case 'Softsign': return x => x / (1 + Math.abs(x));
    case 'LeakyHardtanh': {
      const lo = c.min_val ?? -1, hi = c.max_val ?? 1, ls = c.min_slope ?? 0.01, hs = c.max_slope ?? 0.01;
      return x => (x < lo ? (x - lo) * ls + lo : x > hi ? (x - hi) * hs + hi : x);
    }
    default: throw new Error(`activation "${c?.type ?? String(cfg)}" isn't supported yet`);
  }
}

/** Reads weights in file order. */
class Weights {
  private i = 0;
  constructor(private readonly w: number[]) {}
  next(): number {
    if (this.i >= this.w.length) throw new Error('the file has fewer weights than its layout needs');
    return this.w[this.i++];
  }
  done(): void {
    if (this.i !== this.w.length) throw new Error(`the file has ${this.w.length} weights but its layout uses ${this.i}`);
  }
}

/** A causal, dilated 1-D convolution (NAM Conv1D): out[o][t] = b[o] + Σ_k Σ_i W[k][o][i] · in[i][t − d·(K−1−k)]. */
class Conv {
  /** w[k][o][i] (zeros outside the groups' blocks). */
  readonly w: Float32Array[];
  readonly b: Float32Array | null;
  constructor(readonly cin: number, readonly cout: number, readonly k: number, bias: boolean, readonly d: number, groups: number, W: Weights) {
    if (cin % groups || cout % groups) throw new Error('channels must divide by groups');
    this.w = Array.from({ length: k }, () => new Float32Array(cout * cin));
    if (groups === cin && cin === cout) {
      // Depthwise: one weight per channel per tap, channel-major.
      for (let c = 0; c < cin; c++) for (let t = 0; t < k; t++) this.w[t][c * cin + c] = W.next();
    } else {
      const op = cout / groups, ip = cin / groups;
      for (let g = 0; g < groups; g++) for (let o = 0; o < op; o++) for (let i = 0; i < ip; i++) for (let t = 0; t < k; t++) {
        this.w[t][(g * op + o) * cin + g * ip + i] = W.next();
      }
    }
    this.b = bias ? Float32Array.from({ length: cout }, () => W.next()) : null;
  }
  /** Adds (or writes) the convolution of `input` into `out` (channels × n). */
  apply(input: Float32Array[], out: Float32Array[], n: number, add = false): void {
    for (let o = 0; o < this.cout; o++) {
      const y = out[o];
      const b = this.b ? this.b[o] : 0;
      if (!add) y.fill(b, 0, n); else if (b) for (let t = 0; t < n; t++) y[t] += b;
      for (let tap = 0; tap < this.k; tap++) {
        const lag = this.d * (this.k - 1 - tap), wrow = this.w[tap];
        for (let i = 0; i < this.cin; i++) {
          const w = wrow[o * this.cin + i];
          if (w === 0) continue;
          const x = input[i];
          for (let t = lag; t < n; t++) y[t] += w * x[t - lag];
        }
      }
    }
  }
}

interface Layer { conv: Conv; mixin: Conv; act: Act; layer1x1: Conv | null }
interface LayerArray { rechannel: Conv; layers: Layer[]; head: Conv; channels: number; bottleneck: number }

/** A WaveNet NAM model (one capture, ready to run). */
export class WaveNet {
  private readonly arrays: LayerArray[] = [];
  private readonly headScale: number;
  readonly receptiveField: number;

  constructor(config: Record<string, unknown>, weights: number[]) {
    const W = new Weights(weights);
    if (config.condition_dsp) throw new Error('captures with a condition DSP aren’t supported yet');
    if (config.head) throw new Error('captures with a post-stack head aren’t supported yet');
    let rf = 1;
    for (const lc of config.layers as Record<string, any>[]) {
      const channels: number = lc.channels, bottleneck: number = lc.bottleneck ?? channels;
      const dil: number[] = lc.dilations, n = dil.length;
      const ks: number[] = lc.kernel_sizes ?? Array(n).fill(lc.kernel_size);
      const acts: unknown[] = Array.isArray(lc.activation) ? lc.activation : Array(n).fill(lc.activation);
      const gating: unknown[] = Array.isArray(lc.gating_mode) ? lc.gating_mode : Array(n).fill(lc.gating_mode ?? (lc.gated ? 'gated' : 'none'));
      if (gating.some(g => g !== 'none')) throw new Error('gated WaveNet layers aren’t supported yet');
      for (const f of ['conv_pre_film', 'conv_post_film', 'input_mixin_pre_film', 'input_mixin_post_film', 'activation_pre_film', 'activation_post_film', 'layer1x1_post_film', 'head1x1_post_film']) {
        if (lc[f]?.active) throw new Error('FiLM conditioning isn’t supported yet');
      }
      if (lc.head1x1?.active) throw new Error('a head 1×1 isn’t supported yet');
      const l1x1Active = lc.layer1x1?.active ?? true, l1x1Groups = lc.layer1x1?.groups ?? 1;
      if (!l1x1Active && bottleneck !== channels) throw new Error('without a layer 1×1, bottleneck must equal channels');
      const head = lc.head ?? { out_channels: lc.head_size, kernel_size: 1, bias: lc.head_bias };
      const rechannel = new Conv(lc.input_size, channels, 1, false, 1, 1, W);
      const layers: Layer[] = [];
      for (let i = 0; i < n; i++) {
        const conv = new Conv(channels, bottleneck, ks[i], true, dil[i], lc.groups_input ?? 1, W);
        const mixin = new Conv(lc.condition_size, bottleneck, 1, false, 1, lc.groups_input_mixin ?? 1, W);
        const layer1x1 = l1x1Active ? new Conv(bottleneck, channels, 1, true, 1, l1x1Groups, W) : null;
        layers.push({ conv, mixin, act: activation(acts[i]), layer1x1 });
        rf += dil[i] * (ks[i] - 1);
      }
      const headConv = new Conv(bottleneck, head.out_channels, head.kernel_size, !!head.bias, head.head_dilation ?? 1, 1, W);
      rf += (head.head_dilation ?? 1) * (head.kernel_size - 1);
      this.arrays.push({ rechannel, layers, head: headConv, channels, bottleneck });
    }
    this.headScale = W.next();
    W.done();
    this.receptiveField = rf;
  }

  /** Run the model over a whole signal (digital samples), starting from silence (NAM's prewarm). */
  process(x: Float32Array): Float32Array {
    // Prepend silence for the receptive field, so the network settles exactly as after a prewarm.
    const pre = this.receptiveField, n = pre + x.length;
    const input = new Float32Array(n);
    input.set(x, pre);
    const cond = [input];
    const buf = (c: number) => Array.from({ length: c }, () => new Float32Array(n));
    let layerIn: Float32Array[] = [input], headIn: Float32Array[] | null = null, headOut: Float32Array[] = [];
    for (const a of this.arrays) {
      let cur = buf(a.channels);
      a.rechannel.apply(layerIn, cur, n);
      // Head accumulator: zero for the first array, the previous array's head output after that.
      const acc = buf(a.bottleneck);
      if (headIn) for (let c = 0; c < a.bottleneck; c++) acc[c].set(headIn[c]);
      const z = buf(a.bottleneck);
      for (const L of a.layers) {
        L.conv.apply(cur, z, n);
        L.mixin.apply(cond, z, n, true);
        for (const zc of z) for (let t = 0; t < n; t++) zc[t] = L.act(zc[t]);
        for (let c = 0; c < a.bottleneck; c++) { const s = acc[c], zc = z[c]; for (let t = 0; t < n; t++) s[t] += zc[t]; }
        if (L.layer1x1) {
          const next = cur.map(c => c.slice());
          L.layer1x1.apply(z, next, n, true);
          cur = next;
        }
      }
      headOut = buf(a.head.cout);
      a.head.apply(acc, headOut, n);
      layerIn = cur;
      headIn = headOut;
    }
    const y = headOut[0].subarray(pre), out = new Float32Array(x.length);
    for (let t = 0; t < x.length; t++) out[t] = this.headScale * y[t];
    return out;
  }
}

/** A loaded capture: its description and its network. */
export interface NamModel { info: NamInfo; net: WaveNet }

/** Parse a .nam file. Throws a readable error for anything not supported. */
export function parseNam(text: string, fallbackName = 'Capture'): NamModel {
  let j: Record<string, any>;
  try { j = JSON.parse(text); } catch { throw new Error('this isn’t a NAM capture (not valid JSON)'); }
  if (!j || typeof j !== 'object' || typeof j.architecture !== 'string') throw new Error('this isn’t a NAM capture (no architecture)');
  const meta = (j.metadata ?? {}) as Record<string, unknown>;
  let model = j;
  if (j.architecture === 'SlimmableContainer') {
    const subs = (j.config?.submodels ?? []) as { max_value: number; model: Record<string, any> }[];
    if (!subs.length) throw new Error('this capture has no models inside');
    model = subs[subs.length - 1].model; // the full-size one (as NAM uses by default)
  }
  if (model.architecture !== 'WaveNet') throw new Error(`"${model.architecture}" captures aren’t supported yet (WaveNet captures are)`);
  if (!Array.isArray(model.weights)) throw new Error('this capture has no weights');
  const net = new WaveNet(model.config, model.weights);
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null);
  return {
    net,
    info: {
      name: typeof meta.name === 'string' && meta.name ? meta.name : fallbackName,
      gearType: typeof meta.gear_type === 'string' ? meta.gear_type : null,
      inputLevelDbu: num(meta.input_level_dbu),
      sampleRate: num(model.sample_rate) ?? num(j.sample_rate) ?? 48000,
      weights: model.weights.length,
    },
  };
}

/** Scale volts to the digital level a capture expects (its input level is digital full scale), with a trim in dB. */
export function voltsToDigital(v: ArrayLike<number>, inputLevelDbu: number | null, trimDb = 0): Float32Array {
  const k = 10 ** (trimDb / 20) / dbuToPeakVolts(inputLevelDbu ?? DEFAULT_INPUT_DBU);
  // An amp's input is AC-coupled: remove any DC the pedal leaves on its output.
  let mean = 0;
  for (let i = 0; i < v.length; i++) mean += v[i];
  mean /= Math.max(1, v.length);
  return Float32Array.from({ length: v.length }, (_, i) => (v[i] - mean) * k);
}
