// Device models. Op-amps use a single-pole macromodel: A(s) = A0 / (1 + s·A0 / (2π·GBW)),
// with input resistance between the inputs and an open-loop output resistance.
// Values are typical datasheet figures. The small-signal (AC) analysis uses A0, GBW, Rin and Rout; the
// time-domain simulation also limits the output slew rate and swing (headroom from each supply rail).
import { VT } from './semis';

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
  /**
   * Input bias current (A, typical), drawn by each input: positive flows into the inputs (NPN input
   * stage), negative out of them (PNP). Through large resistors at the inputs it becomes a DC offset,
   * e.g. across clipping diodes in a feedback loop. FET inputs: picoamps.
   */
  ib: number;
  /**
   * The 8-pin package, for the all-pins view: two op-amps (the default: 1 OUT A, 2 −IN A, 3 +IN A,
   * 4 V−, 5 +IN B, 6 −IN B, 7 OUT B, 8 V+), one (2 −IN, 3 +IN, 4 V−, 6 OUT, 7 V+; 1, 5 and 8 offset
   * null or compensation), or the LM386 power amp.
   */
  pkg?: 'single' | 'lm386';
  /** Names for the package's pins 1–8, where they differ from the package's usual ones. */
  pinNames?: string[];
  note?: string;
}

export const OPAMP_MODELS: Record<string, OpAmpModel> = {
  ideal: { label: 'Ideal', a0: Infinity, gbw: Infinity, rin: Infinity, rout: 0, slew: Infinity, headroom: [0, 0], ib: 0 },
  TL072: { label: 'TL072 (JFET, 3 MHz)', a0: 200e3, gbw: 3e6, rin: 1e12, rout: 100, slew: 13, headroom: [1.5, 1.5], ib: 30e-12 },
  JRC4558: { label: 'JRC4558 (3 MHz)', a0: 100e3, gbw: 3e6, rin: 5e6, rout: 75, slew: 1.7, headroom: [1.2, 1.2], ib: 25e-9 },
  NE5532: { label: 'NE5532 (10 MHz)', a0: 100e3, gbw: 10e6, rin: 300e3, rout: 50, slew: 9, headroom: [1.5, 1.5], ib: 200e-9 },
  OPA2134: { label: 'OPA2134 (FET, 8 MHz)', a0: 1e6, gbw: 8e6, rin: 1e13, rout: 50, slew: 20, headroom: [1, 1], ib: 5e-12 },
  LM741: { label: 'LM741 (1 MHz)', a0: 200e3, gbw: 1e6, rin: 2e6, rout: 75, slew: 0.5, headroom: [1.5, 1.5], ib: 80e-9, pkg: 'single' },
  LM358: { label: 'LM358 (1 MHz)', a0: 100e3, gbw: 1e6, rin: 10e6, rout: 300, slew: 0.3, headroom: [0.02, 1.5], ib: -45e-9 },
  LM308: { label: 'LM308, 30 pF comp. (≈1 MHz)', a0: 300e3, gbw: 1e6, rin: 40e6, rout: 100, slew: 0.3, headroom: [1, 1], ib: 1.5e-9, pkg: 'single',
    pinNames: ['COMP', '−IN', '+IN', 'V−', 'BAL', 'OUT', 'V+', 'COMP'], note: 'Approximate: GBW depends on the compensation cap (between pins 1 and 8, not simulated: 30 pF is assumed).' },
  // LM386: a power amp, not an op-amp. Its inputs are referenced to ground through 50 kΩ, its output
  // sits at half the supply, and its gain is 20, or up to 200 with a capacitor across pins 1 and 8.
  // These figures are for the output stage of its macromodel (see the OA part in the schematic library).
  LM386: { label: 'LM386 (power amp, gain 20–200)', a0: 30e3, gbw: 300e3, rin: 1e12, rout: 0.5, slew: 2, headroom: [0.8, 1], ib: -250e-9, pkg: 'lm386',
    note: 'Approximate: a macromodel of the gain stage (gain 20 with pins 1 and 8 open, 200 with a capacitor between them; 300 kHz bandwidth; output at half the supply). It only comes in its 8-pin view.' },
};

/** `cj`: junction capacitance (F), used as a constant in AC and transient analysis. */
export interface DiodeModel { label: string; spice: string; is: number; n: number; cj: number; approx?: boolean }

/** SPICE .model parameters (for export) and the numbers the simulator uses. */
export const DIODE_MODELS: Record<string, DiodeModel> = {
  '1N4148': { label: '1N4148 (silicon)', is: 2.52e-9, n: 1.752, cj: 4e-12, spice: 'D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p M=0.4 tt=20n)' },
  '1N914': { label: '1N914 (silicon)', is: 2.52e-9, n: 1.752, cj: 4e-12, spice: 'D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p M=0.4 tt=20n)' },
  // 1S1588: a Japanese 1N4148-type switching diode (Boss, Ibanez), modelled as a 1N4148 with a higher
  // forward drop (≈ 1 V at 10 mA, ≈ 0.8 V at the 0.1 mA typical of a clipping stage).
  '1S1588': { label: '1S1588 (silicon, Vf ≈ 1 V)', is: 2.58e-12, n: 1.752, cj: 3e-12, spice: 'D(Is=2.58p Rs=0.568 N=1.752 Cjo=3p M=0.4 tt=20n)', approx: true },
  // BAT41: 100 V small-signal Schottky. No maker's SPICE model; fitted to the datasheet (Vf ≤ 0.45 V at
  // 1 mA, ≈ 1 V at 200 mA, 2 pF): about 0.28 V at 0.1 mA and 0.38 V at 1 mA.
  BAT41: { label: 'BAT41 (Schottky)', is: 1.8e-7, n: 1.7, cj: 2e-12, spice: 'D(Is=180n Rs=1.4 N=1.7 Cjo=2p M=0.3 BV=100)', approx: true },
  // 1N34A: germanium, ≈ 0.25 V at 1 mA (typical of measured parts; samples vary).
  '1N34A': { label: '1N34A (germanium)', is: 5.9e-7, n: 1.3, cj: 1e-12, spice: 'D(Is=590n Rs=7 N=1.3 Cjo=1p)', approx: true },
  LED_RED: { label: 'Red LED', is: 1e-19, n: 1.6, cj: 20e-12, spice: 'D(Is=1e-19 N=1.6 Rs=4 Cjo=20p)', approx: true },
};

export const diodeModel = (key: string): DiodeModel => DIODE_MODELS[key] || DIODE_MODELS['1N4148'];

/** Forward voltage at current i (A), as the simulator models the diode (thermal voltage at 300 K). */
export const diodeVf = (m: Pick<DiodeModel, 'is' | 'n'>, i: number): number => m.n * VT * Math.log(i / m.is + 1);
export const opAmpModel = (key: string): OpAmpModel => OPAMP_MODELS[key] || OPAMP_MODELS.ideal;
