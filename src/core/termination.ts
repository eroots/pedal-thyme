// Source and load models: a Thevenin source of (Rs + sLs) with optional shunt cable capacitance,
// and a load of RL ∥ CL.
import { Cx, cx, ONE } from './complex';
import type { Zterm } from './circuit';

export interface SourceTerm { on: boolean; preset: string; R: number; L: number; C: number }
export interface LoadTerm { on: boolean; preset: string; R: number; C: number }
export interface Term { src: SourceTerm; load: LoadTerm }

/** Termination at complex frequency s: open-circuit source gain g plus the Zterm impedances. */
export interface TermAt extends Zterm { g: Cx }

export function termAt(term: Term | null | undefined, s: Cx): TermAt {
  const out: TermAt = { g: ONE, zs: null, zl: null };
  if (!term) return out;
  const src = term.src, ld = term.load;
  if (src && src.on) {
    let zser = cx(src.R || 0).add(s.scale(src.L || 0));
    if (zser.abs() < 1e-9) zser = cx(1e-9);
    if (src.C > 0) {
      const yc = s.scale(src.C);
      out.g = ONE.div(ONE.add(yc.mul(zser)));
      out.zs = zser.mul(out.g); // zser ∥ 1/(sC)
    } else out.zs = zser;
  }
  if (ld && ld.on) {
    const y = (ld.R > 0 ? cx(1 / ld.R) : cx(0)).add(s.scale(ld.C || 0));
    if (y.abs() > 0) out.zl = ONE.div(y);
  }
  return out;
}

export const termActive = (term: Term | null | undefined): term is Term =>
  !!(term && ((term.src && term.src.on) || (term.load && term.load.on)));
