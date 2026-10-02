import type { Cx } from './complex';
import type { Zterm } from './circuit';

/** Component values keyed by part name (Ω, F, H). */
export type Values = Record<string, number>;
/** Circuit options: switches (boolean) and knob/slider positions (number). */
export type Opts = Record<string, number | boolean>;

/** Anything with a small-signal transfer function H(s) from input to output. */
export interface Transfer {
  H(v: Values, s: Cx, o: Opts, z?: Zterm | null): Cx;
}
