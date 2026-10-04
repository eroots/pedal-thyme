// Circuit description shared by the Playground and (later) the Pedal Builder.
// Values are SI (Ω, F, H, V). Node "0" is ground.
import type { TaperKey } from '../core/pots';

export type Node = string;
export const GND: Node = '0';

export type Element =
  | { type: 'R'; name: string; a: Node; b: Node; value: number }
  | { type: 'C'; name: string; a: Node; b: Node; value: number }
  | { type: 'L'; name: string; a: Node; b: Node; value: number }
  /** Independent voltage source (supply / Vref). It's an AC short unless `ac` is set. */
  | { type: 'V'; name: string; p: Node; n: Node; dc: number; ac?: number }
  /** Voltage-controlled voltage source: V(p) − V(n) = gain · (V(cp) − V(cn)). */
  | { type: 'E'; name: string; p: Node; n: Node; cp: Node; cn: Node; gain: number }
  /**
   * Op-amp; `model` is a key of OPAMP_MODELS ('ideal' = nullor). `rails` (transient only): the supply
   * span it clips within, when it differs from the whole circuit's (pedals chained with different supplies).
   */
  | { type: 'OA'; name: string; inP: Node; inN: Node; out: Node; model: string; rails?: [number, number] }
  /**
   * Potentiometer. `a` = terminal 1 (CCW end), `w` = wiper, `b` = terminal 3 (CW end).
   * rot ∈ [0, 1] turns the wiper from a to b: R(a,w) = value · taper(rot).
   */
  | { type: 'POT'; name: string; a: Node; w: Node; b: Node; value: number; taper: TaperKey; rot: number; reverse?: boolean }
  /** Pot wired as a variable resistor: R = max(1 Ω, value · taper(rot)), or value · (1 − taper(rot)) on lugs 2+3 (reverse). */
  | { type: 'RHEO'; name: string; a: Node; b: Node; value: number; taper: TaperKey; rot: number; reverse?: boolean }
  /** SPST switch (closed = ideal short, open = absent). */
  | { type: 'SW'; name: string; a: Node; b: Node; closed: boolean }
  /** SPDT switch: `com` connects to `a` or `b`. */
  | { type: 'SPDT'; name: string; com: Node; a: Node; b: Node; pos: 'a' | 'b' }
  /** Diode (anode a, cathode k). Nonlinear: linearised at its DC operating point for AC. */
  | { type: 'D'; name: string; a: Node; k: Node; model: string }
  /** Bipolar transistor (collector, base, emitter); polarity comes from the model. */
  | { type: 'Q'; name: string; c: Node; b: Node; e: Node; model: string }
  /** JFET (drain, gate, source); polarity comes from the model. */
  | { type: 'J'; name: string; d: Node; g: Node; s: Node; model: string }
  /** Enhancement MOSFET (drain, gate, source; body tied to source); polarity comes from the model. */
  | { type: 'M'; name: string; d: Node; g: Node; s: Node; model: string }
  /** Voltage-controlled current source: gm·(V(cp) − V(cn)) flows from p through the element to n. */
  | { type: 'G'; name: string; p: Node; n: Node; cp: Node; cn: Node; gm: number };

export type ElementType = Element['type'];

/** Elements whose behaviour depends on a DC operating point. */
export const isNonlinear = (e: Element): boolean => e.type === 'D' || e.type === 'Q' || e.type === 'J' || e.type === 'M';

export interface Netlist {
  title?: string;
  elements: Element[];
  /** Node driven by the signal source (input jack). */
  input: Node;
  /** Node observed as the output (output jack). */
  output: Node;
}

/* ---------- Builders ---------- */
export const R = (name: string, a: Node, b: Node, value: number): Element => ({ type: 'R', name, a, b, value });
export const C = (name: string, a: Node, b: Node, value: number): Element => ({ type: 'C', name, a, b, value });
export const L = (name: string, a: Node, b: Node, value: number): Element => ({ type: 'L', name, a, b, value });
export const OA = (name: string, inP: Node, inN: Node, out: Node, model = 'ideal'): Element => ({ type: 'OA', name, inP, inN, out, model });
/** Unity-gain buffer: out follows `inp`. */
export const BUF = (name: string, inp: Node, out: Node): Element => ({ type: 'E', name, p: out, n: GND, cp: inp, cn: GND, gain: 1 });
export const POT = (name: string, a: Node, w: Node, b: Node, value: number, rot: number, taper: TaperKey = 'B'): Element =>
  ({ type: 'POT', name, a, w, b, value, taper, rot });
export const RHEO = (name: string, a: Node, b: Node, value: number, rot: number, taper: TaperKey = 'B'): Element =>
  ({ type: 'RHEO', name, a, b, value, taper, rot });

/** Every node an element touches (excluding internal nodes the solver may add). */
export function elementNodes(e: Element): Node[] {
  switch (e.type) {
    case 'R': case 'C': case 'L': case 'RHEO': case 'SW': return [e.a, e.b];
    case 'V': return [e.p, e.n];
    case 'E': return [e.p, e.n, e.cp, e.cn];
    case 'OA': return [e.inP, e.inN, e.out];
    case 'POT': return [e.a, e.w, e.b];
    case 'SPDT': return [e.com, e.a, e.b];
    case 'D': return [e.a, e.k];
    case 'Q': return [e.c, e.b, e.e];
    case 'J': case 'M': return [e.d, e.g, e.s];
    case 'G': return [e.p, e.n, e.cp, e.cn];
  }
}
