// Signal chains: several pedals' netlists joined into one, each pedal's output jack wired to the next
// one's input jack, so loading between them (the next input impedance on the previous output) is real.
// Ground is shared; everything else of an upstream pedal is prefixed, so its supplies, parts and nets
// stay its own. The last pedal keeps its own names (probes and bias readouts refer to them).
import type { OpPoint } from './dc';
import { GND, type Element, type Netlist, type Node } from './netlist';

/** Element fields that hold nodes (every other string field is a name, model or setting). */
const NODE_KEYS = ['a', 'b', 'p', 'n', 'cp', 'cn', 'inP', 'inN', 'out', 'vp', 'vn', 'w', 'com', 'k', 'c', 'e', 'd', 'g', 's'] as const;

/** The supply span of one pedal: its highest and lowest DC source, including ground. */
/**
 * The span an op-amp clips within: the DC voltages of its supply pins when it has them (and they're
 * connected, so the operating point knows them), or else its own `rails`, or else `fallback`.
 */
export function opAmpRails(e: Extract<Element, { type: 'OA' }>, fallback: [number, number], op?: Pick<OpPoint, 'v' | 'nodes'>): [number, number] {
  const known = (n?: Node): n is Node => !!n && (n === GND || !!op?.nodes.has(n));
  if (op && known(e.vp) && known(e.vn)) {
    const a = op.v(e.vn), b = op.v(e.vp);
    return [Math.min(a, b), Math.max(a, b)];
  }
  return e.rails ?? fallback;
}

export function supplyRails(nl: Netlist): [number, number] {
  const dcs = nl.elements.filter((e): e is Extract<Element, { type: 'V' }> => e.type === 'V').map(e => e.dc);
  return [Math.min(0, ...dcs), Math.max(0, ...dcs)];
}

function mapElement(e: Element, node: (n: Node) => Node, name: (n: string) => string): Element {
  const out: Record<string, unknown> = { ...e, name: name(e.name) };
  for (const k of NODE_KEYS) if (typeof out[k] === 'string' && k in e) out[k] = node(out[k] as Node);
  return out as unknown as Element;
}

/**
 * Join pedals in signal order (first one gets the source). Upstream pedal k's nodes and parts are
 * prefixed `u{k}:`; the last pedal's are left as they are. Op-amps keep their own pedal's rails.
 */
export function joinChain(stages: Netlist[]): Netlist {
  return joinStages(stages).netlist;
}

/** joinChain, also returning where each pedal's output is in the joined circuit (signal after each pedal). */
export function joinStages(stages: Netlist[]): { netlist: Netlist; outputs: Node[] } {
  if (!stages.length) throw new Error('joinChain: no stages');
  const last = stages[stages.length - 1];
  const withRails = (nl: Netlist) => (e: Element): Element => (e.type === 'OA' && !e.rails ? { ...e, rails: supplyRails(nl) } : e);
  if (stages.length === 1) return { netlist: last, outputs: [last.output] };
  const elements: Element[] = last.elements.map(withRails(last));
  const outputs: Node[] = [last.output];
  // Work back from the last pedal: each upstream output node becomes the next pedal's input node.
  let next: Node = last.input;
  for (let k = stages.length - 2; k >= 0; k--) {
    const nl = stages[k], into = next;
    const node = (n: Node): Node => (n === GND ? GND : n === nl.output ? into : `u${k}:${n}`);
    elements.unshift(...nl.elements.map(withRails(nl)).map(e => mapElement(e, node, n => `u${k}:${n}`)));
    outputs.unshift(into);
    next = node(nl.input);
  }
  return { netlist: { title: last.title, elements, input: next, output: last.output }, outputs };
}
