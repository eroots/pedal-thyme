// Op-amp rail clipping: an op-amp whose output reaches its supply rails squares the signal off, so any
// diode clipping after it only sees a square wave. Used to point this out after a Sound render.
import { supplyRails } from '../engine/chain';
import { opAmpModel } from '../engine/models';
import type { Netlist, Node } from '../engine/netlist';

/** An op-amp's output net and how far it can swing (its rails less the model's headroom). */
export interface OpAmpSwing { name: string; net: Node; lo: number; hi: number }

export function opAmpSwings(nl: Netlist): OpAmpSwing[] {
  const supply = supplyRails(nl);
  return nl.elements.flatMap(e => {
    if (e.type !== 'OA') return [];
    const m = opAmpModel(e.model), rails = e.rails ?? supply;
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
