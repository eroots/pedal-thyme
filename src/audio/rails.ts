// Op-amp rail clipping: an op-amp whose output reaches its supply rails squares the signal off, so any
// diode clipping after it only sees a square wave. Used to point this out after a Sound render.
import { opAmpRails, supplyRails } from '../engine/chain';
import { dcOp, type OpPoint } from '../engine/dc';
import { opAmpModel } from '../engine/models';
import type { Netlist, Node } from '../engine/netlist';

/** An op-amp's output net and how far it can swing (its rails less the model's headroom). */
export interface OpAmpSwing { name: string; net: Node; lo: number; hi: number }

export function opAmpSwings(nl: Netlist): OpAmpSwing[] {
  const supply = supplyRails(nl);
  // Op-amps with supply pins clip within those pins' DC voltages.
  let op: OpPoint | undefined;
  if (nl.elements.some(e => e.type === 'OA' && e.vp)) op = dcOp(nl);
  return nl.elements.flatMap(e => {
    if (e.type !== 'OA') return [];
    const m = opAmpModel(e.model), rails = opAmpRails(e, supply, op);
    return [{ name: e.name, net: e.out, lo: rails[0] + m.headroom[0], hi: rails[1] - m.headroom[1] }];
  });
}

/**
 * Does this output reach its limits (within 3 % of its swing) over the samples from `from`? A clean
 * signal never gets that close, so reaching them means the op-amp is saturating.
 */
export function hitsRails(y: ArrayLike<number>, s: OpAmpSwing, from = 0): boolean {
  const tol = 0.03 * (s.hi - s.lo);
  for (let i = from; i < y.length; i++) if (y[i] >= s.hi - tol || y[i] <= s.lo + tol) return true;
  return false;
}

/**
 * Op-amps whose DC output sits at (or past) the edge of its swing: stuck against a rail, usually because
 * the input is biased at a rail (e.g. VREF set to the full supply). They pass almost no signal, which the
 * frequency plots (small-signal, around that operating point) don't show but a Sound render does.
 * `op` is the DC operating point (the DC solve treats op-amps as linear, so a stuck output reads at or past its rail).
 */
export function stuckOpAmps(nl: Netlist, op: OpPoint): (OpAmpSwing & { v: number })[] {
  if (!op.ok) return [];
  return opAmpSwings(nl).flatMap(s => {
    const v = op.v(s.net), tol = 0.03 * (s.hi - s.lo);
    return s.hi > s.lo && (v >= s.hi - tol || v <= s.lo + tol) ? [{ ...s, v }] : [];
  });
}
