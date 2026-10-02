// Turn a schematic's geometry into a netlist, and check it (electrical rule check, ERC).
//
// Connectivity rules (as in LTspice): a wire is one conductor; pins and wire ends connect when they
// share a point; a pin or wire end that lies anywhere on a wire connects to it; wires that merely
// cross do not connect. Labels with the same name (and every ground symbol) join their nets.
import { GND, type Element, type Netlist, type Node } from '../engine/netlist';
import { key, onSegment, samePt, toWorld, type Pt } from './geometry';
import { PARTS } from './library';
import type { SchPart, Schematic } from './types';

export type Severity = 'error' | 'warning';
export interface ErcIssue { severity: Severity; message: string; parts?: string[]; at?: Pt }

export interface PinRef { part: SchPart; pin: string; at: Pt }

export interface Extraction {
  netlist: Netlist;
  /** Net name for every pin, keyed "partId:pin". */
  pinNet: Map<string, Node>;
  /** Members of each net. */
  nets: Map<Node, PinRef[]>;
  issues: ErcIssue[];
}

class UnionFind {
  private parent = new Map<string, string>();
  find(a: string): string {
    let p = this.parent.get(a) ?? a;
    if (p !== a) { p = this.find(p); this.parent.set(a, p); }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export const pinsOf = (p: SchPart): PinRef[] => PARTS[p.kind].pins.map(pin => ({ part: p, pin: pin.name, at: toWorld(p, pin.at) }));

export function extract(sch: Schematic): Extraction {
  const uf = new UnionFind();
  const issues: ErcIssue[] = [];
  const pins = sch.parts.flatMap(pinsOf);
  const pinId = (r: PinRef) => `${r.part.id}:${r.pin}`;
  const wireId = (id: string) => `wire:${id}`;

  // Pins sharing a point.
  const byPoint = new Map<string, string[]>();
  for (const r of pins) {
    const k = key(r.at);
    byPoint.set(k, [...(byPoint.get(k) || []), pinId(r)]);
  }
  for (const ids of byPoint.values()) for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);

  // Pins and wire ends lying on a wire.
  const ends = sch.wires.flatMap(w => (w.pts.length ? [{ w, at: w.pts[0] }, { w, at: w.pts[w.pts.length - 1] }] : []));
  const touched = new Set<string>(); // wire ends that touch something
  for (const w of sch.wires) {
    const segs = w.pts.slice(1).map((b, i) => [w.pts[i], b] as [Pt, Pt]);
    const on = (q: Pt) => segs.some(([a, b]) => onSegment(q, a, b));
    for (const r of pins) if (on(r.at)) {
      uf.union(wireId(w.id), pinId(r));
      for (const e of ends) if (e.w === w && samePt(e.at, r.at)) touched.add(`${w.id}@${key(e.at)}`);
    }
    for (const e of ends) {
      if (e.w === w) continue;
      if (on(e.at)) {
        uf.union(wireId(w.id), wireId(e.w.id));
        touched.add(`${e.w.id}@${key(e.at)}`);
        for (const e2 of ends) if (e2.w === w && samePt(e2.at, e.at)) touched.add(`${w.id}@${key(e2.at)}`);
      }
    }
  }
  for (const e of ends) {
    if (!touched.has(`${e.w.id}@${key(e.at)}`)) issues.push({ severity: 'warning', message: 'Wire end is not connected to anything.', at: e.at });
  }

  // Labels and grounds join nets by name.
  const named = new Map<string, string>();
  const nameOf = (p: SchPart): string | null =>
    p.kind === 'GND' ? GND : p.kind === 'LABEL' ? (p.props?.name || null) : p.kind === 'SUPPLY' ? (p.props?.name || `${p.value ?? 9}V`) : null;
  for (const r of pins) {
    const name = nameOf(r.part);
    if (!name) continue;
    const prev = named.get(name);
    if (prev) uf.union(prev, pinId(r)); else named.set(name, pinId(r));
  }

  // Group pins by net and name the nets.
  const groups = new Map<string, PinRef[]>();
  for (const r of pins) {
    const root = uf.find(pinId(r));
    groups.set(root, [...(groups.get(root) || []), r]);
  }
  const inJacks = sch.parts.filter(p => p.kind === 'IN'), outJacks = sch.parts.filter(p => p.kind === 'OUT');
  const nets = new Map<Node, PinRef[]>(), pinNet = new Map<string, Node>();
  let auto = 0;
  for (const members of groups.values()) {
    const kinds = new Set(members.map(m => m.part.kind));
    const names = members.map(m => nameOf(m.part)).filter((x): x is string => !!x);
    let name: Node;
    if (names.includes(GND)) name = GND;
    else if (kinds.has('IN')) name = 'in';
    else if (kinds.has('OUT')) name = 'out';
    else if (names.length) name = names[0];
    else name = `N${String(++auto).padStart(3, '0')}`;
    if (kinds.has('IN') && (kinds.has('OUT') || name === GND)) {
      issues.push({ severity: 'error', message: name === GND ? 'The input is shorted to ground.' : 'Input and output are on the same net.', parts: members.map(m => m.part.id) });
    } else if (kinds.has('OUT') && name === GND) {
      issues.push({ severity: 'error', message: 'The output is shorted to ground.', parts: members.map(m => m.part.id) });
    }
    nets.set(name, members);
    for (const m of members) pinNet.set(pinId(m), name);
  }

  // Elements.
  const elements: Element[] = [];
  for (const p of sch.parts) {
    const spec = PARTS[p.kind];
    elements.push(...spec.elements(p, pin => pinNet.get(`${p.id}:${pin}`) ?? GND));
  }

  // ---------- ERC ----------
  if (inJacks.length !== 1) issues.push({ severity: 'error', message: inJacks.length ? 'More than one input jack.' : 'No input jack: add one where the signal enters.', parts: inJacks.map(p => p.id) });
  if (outJacks.length !== 1) issues.push({ severity: 'error', message: outJacks.length ? 'More than one output jack.' : 'No output jack: add one where the signal leaves.', parts: outJacks.map(p => p.id) });

  // Unconnected pins (a net with one member), except a lone label/supply/ground marker.
  for (const [name, members] of nets) {
    if (members.length > 1 || name === GND) continue;
    const m = members[0];
    if (m.part.kind === 'LABEL') continue;
    issues.push({ severity: 'warning', message: `${m.part.ref || PARTS[m.part.kind].label} pin ${m.pin} is not connected.`, parts: [m.part.id], at: m.at });
  }

  // Supplies: shorted to ground, or two different voltages on one net.
  const supplies = sch.parts.filter(p => p.kind === 'SUPPLY');
  for (const sp of supplies) {
    const net = pinNet.get(`${sp.id}:v`);
    if (net === GND) issues.push({ severity: 'error', message: `Supply ${sp.props?.name || sp.ref || ''} is shorted to ground.`, parts: [sp.id] });
    const clash = supplies.find(o => o !== sp && pinNet.get(`${o.id}:v`) === net && (o.value ?? 9) !== (sp.value ?? 9));
    if (clash && sp.id < clash.id) issues.push({ severity: 'error', message: 'Two supplies with different voltages are connected together.', parts: [sp.id, clash.id] });
  }

  // DC path to ground: every net must reach ground through conductive parts, or its DC level is
  // undefined (fine for this AC analysis, but a real circuit would float).
  const dcAdj = new Map<Node, Set<Node>>();
  const link = (a: Node, b: Node) => {
    if (!dcAdj.has(a)) dcAdj.set(a, new Set());
    if (!dcAdj.has(b)) dcAdj.set(b, new Set());
    dcAdj.get(a)!.add(b); dcAdj.get(b)!.add(a);
  };
  for (const e of elements) {
    switch (e.type) {
      case 'R': case 'L': case 'RHEO': link(e.a, e.b); break;
      case 'POT': link(e.a, e.w); link(e.w, e.b); break;
      case 'SW': if (e.closed) link(e.a, e.b); break;
      case 'SPDT': link(e.com, e.pos === 'a' ? e.a : e.b); break;
      case 'V': case 'E': link(e.p, e.n); link(e.p, GND); break;
      case 'OA': link(e.out, GND); break; // the output is driven
      case 'D': link(e.a, e.k); break;
      case 'Q': link(e.b, e.e); link(e.b, e.c); break; // both junctions conduct (or leak)
      case 'J': link(e.d, e.s); break; // the gate is a reverse-biased junction: it needs its own path
      case 'M': link(e.d, e.s); break; // the gate is insulated: it needs its own path
      case 'G': link(e.p, e.n); break;
      default: break;
    }
  }
  link('in', GND); // the signal source has a DC path (e.g. a pickup coil)
  const reached = new Set<Node>([GND]), queue: Node[] = [GND];
  while (queue.length) for (const nb of dcAdj.get(queue.shift()!) || []) if (!reached.has(nb)) { reached.add(nb); queue.push(nb); }
  for (const [name, members] of nets) {
    if (reached.has(name) || members.length < 2) continue;
    const refs = [...new Set(members.map(m => m.part.ref).filter(Boolean))];
    issues.push({
      severity: 'warning',
      message: `Net ${name}${refs.length ? ` (${refs.join(', ')})` : ''} has no DC path to ground, so its bias voltage is undefined.`,
      parts: members.map(m => m.part.id),
    });
  }

  // Reference designators must be unique among real components.
  const byRef = new Map<string, SchPart[]>();
  for (const p of sch.parts) if (p.ref && PARTS[p.kind].elements(p, () => GND).length) byRef.set(p.ref, [...(byRef.get(p.ref) || []), p]);
  for (const [ref, ps] of byRef) if (ps.length > 1) issues.push({ severity: 'error', message: `Reference ${ref} is used ${ps.length} times.`, parts: ps.map(p => p.id) });

  // Values.
  for (const p of sch.parts) {
    const spec = PARTS[p.kind];
    if (!spec.unit || p.kind === 'SUPPLY') continue;
    const v = p.value;
    const bad = v == null || !isFinite(v) || (p.kind === 'C' ? v < 0 : v <= 0);
    if (bad) issues.push({ severity: 'error', message: `${p.ref || spec.label} needs a valid value.`, parts: [p.id] });
  }

  return {
    netlist: { elements, input: inJacks.length ? 'in' : GND, output: outJacks.length ? 'out' : GND },
    pinNet, nets, issues,
  };
}
