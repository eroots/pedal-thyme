// Device models. Op-amps use a single-pole macromodel: A(s) = A0 / (1 + s·A0 / (2π·GBW)),
// with input resistance between the inputs and an open-loop output resistance.
// Values are typical datasheet figures. The small-signal (AC) analysis uses A0, GBW, Rin and Rout; the
// time-domain simulation also limits the output slew rate and swing (headroom from each supply rail).

export interface OpAmpModel {
  label: string;
  /** Open-loop DC gain (V/V); Infinity for ideal. */
  a0: number;
  /** Gain-bandwidth product (Hz). */
  gbw: number;
  /** Differential input resistance (Ω). */
  rin: number;
  /** Open-loop output resistance (Ω). */
  rout: number;
  /** Slew rate (V/µs); Infinity = none. */
  slew: number;
  /** How close the output gets to the negative and positive supply rails (V), single-supply pedal use. */
  headroom: [number, number];
  note?: string;
}

export const OPAMP_MODELS: Record<string, OpAmpModel> = {
  ideal: { label: 'Ideal', a0: Infinity, gbw: Infinity, rin: Infinity, rout: 0, slew: Infinity, headroom: [0, 0] },
  TL072: { label: 'TL072 (JFET, 3 MHz)', a0: 200e3, gbw: 3e6, rin: 1e12, rout: 100, slew: 13, headroom: [1.5, 1.5] },
  JRC4558: { label: 'JRC4558 (3 MHz)', a0: 100e3, gbw: 3e6, rin: 5e6, rout: 75, slew: 1.7, headroom: [1.2, 1.2] },
  NE5532: { label: 'NE5532 (10 MHz)', a0: 100e3, gbw: 10e6, rin: 300e3, rout: 50, slew: 9, headroom: [1.5, 1.5] },
  OPA2134: { label: 'OPA2134 (FET, 8 MHz)', a0: 1e6, gbw: 8e6, rin: 1e13, rout: 50, slew: 20, headroom: [1, 1] },
  LM741: { label: 'LM741 (1 MHz)', a0: 200e3, gbw: 1e6, rin: 2e6, rout: 75, slew: 0.5, headroom: [1.5, 1.5] },
  LM358: { label: 'LM358 (1 MHz)', a0: 100e3, gbw: 1e6, rin: 10e6, rout: 300, slew: 0.3, headroom: [0.02, 1.5] },
  LM308: { label: 'LM308, 30 pF comp. (≈1 MHz)', a0: 300e3, gbw: 1e6, rin: 40e6, rout: 100, slew: 0.3, headroom: [1, 1], note: 'Approximate: GBW depends on the compensation cap.' },
};

/** `cj`: junction capacitance (F), used as a constant in AC and transient analysis. */
export interface DiodeModel { label: string; spice: string; is: number; n: number; cj: number; approx?: boolean }

/** SPICE .model parameters (for export) and the numbers the simulator uses. */
export const DIODE_MODELS: Record<string, DiodeModel> = {
  '1N4148': { label: '1N4148 (silicon)', is: 2.52e-9, n: 1.752, cj: 4e-12, spice: 'D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p M=0.4 tt=20n)' },
  '1N914': { label: '1N914 (silicon)', is: 2.52e-9, n: 1.752, cj: 4e-12, spice: 'D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p M=0.4 tt=20n)' },
  '1N34A': { label: '1N34A (germanium)', is: 2e-6, n: 1.3, cj: 1e-12, spice: 'D(Is=2u Rs=7 N=1.3 Cjo=1p)', approx: true },
  LED_RED: { label: 'Red LED', is: 1e-19, n: 1.6, cj: 20e-12, spice: 'D(Is=1e-19 N=1.6 Rs=4 Cjo=20p)', approx: true },
};

export const diodeModel = (key: string): DiodeModel => DIODE_MODELS[key] || DIODE_MODELS['1N4148'];
export const opAmpModel = (key: string): OpAmpModel => OPAMP_MODELS[key] || OPAMP_MODELS.ideal;
