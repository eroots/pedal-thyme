import type { Cx } from './complex';

/** Component values keyed by part name (Ω, F, H). */
export type Values = Record<string, number>;
/** Circuit options: switches (boolean), knob/slider positions (number) and model choices (string). */
export type Opts = Record<string, number | boolean | string>;

/**
 * Source/load terminations seen by a circuit: Thevenin source impedance `zs` in series with the
 * input and load impedance `zl` across the output. `null` means ideal (0 Ω source / open load).
 */
export interface Zterm { zs: Cx | null; zl: Cx | null }

/** Anything with a small-signal transfer function H(s) from input to output. */
export interface Transfer {
  H(v: Values, s: Cx, o: Opts, z?: Zterm | null): Cx;
}
