// Part library: pin positions, schematic symbols (in local coordinates), default label placement and
// the netlist elements each part becomes. Two-terminal parts have pins at (−30, 0) and (30, 0).
import { potFraction, type TaperKey } from '../core/pots';
import { clamp, fmtEng } from '../core/units';
import { OPAMP_MODELS, DIODE_MODELS } from '../engine/models';
import { BJT_MODELS, JFET_MODELS, MOS_MODELS } from '../engine/semis';
import { GND, type Element, type Node } from '../engine/netlist';
import type { Pt } from './geometry';
import type { PartKind, SchPart } from './types';

export interface PinSpec { name: string; at: Pt }

export interface PartSpec {
  /** Human-readable name for palettes. */
  label: string;
  pins: PinSpec[];
  /** Symbol drawing in local coordinates (rot 0, not mirrored). */
  draw(p: SchPart): string;
  /** Local bounding box [x0, y0, x1, y1] of the symbol. */
  box: [number, number, number, number];
  /** Size-dependent bounding box (e.g. a net label sized to its name); overrides `box`. */
  boxOf?(p: SchPart): [number, number, number, number];
  /** Unit of `value`, if the part has one. */
  unit?: 'Ω' | 'F' | 'H' | 'V';
  /** Text shown under the ref (value, model…). */
  valueText?(p: SchPart): string;
  /** Local direction the labels should avoid (e.g. a pot's wiper side). */
  avoid?: Pt;
  /** Extra clearance between the symbol and its labels (e.g. a rheostat's arrow). */
  labelPad?: number;
  /** Netlist elements; `n(pin)` gives the net of a pin. Labels/jacks/ground return none. */
  elements(p: SchPart, n: (pin: string) => Node): Element[];
}

/* ---------- Drawing helpers ---------- */
const f = (x: number) => String(Math.round(x * 10) / 10);
export const line = (x1: number, y1: number, x2: number, y2: number, cls = '') =>
  `<line${cls ? ` class="${cls}"` : ''} x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
export const polyline = (pts: Pt[], cls = '') => `<polyline${cls ? ` class="${cls}"` : ''} points="${pts.map(p => p.map(f).join(',')).join(' ')}"/>`;
export const polygon = (pts: Pt[], cls = '') => `<polygon${cls ? ` class="${cls}"` : ''} points="${pts.map(p => p.map(f).join(',')).join(' ')}"/>`;
export function arrow(x1: number, y1: number, x2: number, y2: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const bx = x2 - ux * 8, by = y2 - uy * 8;
  return line(x1, y1, bx, by) + polygon([[x2, y2], [bx - uy * 4, by + ux * 4], [bx + uy * 4, by - ux * 4]], 'head');
}
function zigzag(): string {
  const pts: Pt[] = [[-16, 0]];
  for (let i = 1; i < 6; i++) pts.push([-16 + 32 * i / 6, i % 2 ? 6 : -6]);
  pts.push([16, 0]);
  return line(-30, 0, -16, 0) + polyline(pts) + line(16, 0, 30, 0);
}
const TWO: PinSpec[] = [{ name: '1', at: [-30, 0] }, { name: '2', at: [30, 0] }];
/** Net label line length: room for the name (≈ 6.5 units per character) plus margins. */
export const labelLen = (p: SchPart): number => Math.max(20, Math.ceil(((p.props?.name || 'NET').length * 6.5 + 10) / 10) * 10);
/** Symbol bounding box for a specific part instance. */
export const boxOf = (p: SchPart): [number, number, number, number] => PARTS[p.kind].boxOf?.(p) ?? PARTS[p.kind].box;
const wiperFrac = (p: SchPart) => clamp(potFraction(p.props?.turn ?? 0.5, p.props?.taper ?? 'B', p.props?.reverse), 1e-4, 1 - 1e-4);
const two = (p: SchPart) => p.value ?? 0;

/* Transistors: control pin at (−30, 0); collector/drain at (10, −30), emitter/source at (10, 30). */
const Q_PINS: PinSpec[] = [{ name: 'c', at: [10, -30] }, { name: 'b', at: [-30, 0] }, { name: 'e', at: [10, 30] }];
const J_PINS: PinSpec[] = [{ name: 'd', at: [10, -30] }, { name: 'g', at: [-30, 0] }, { name: 's', at: [10, 30] }];
const body = '<circle class="qbody" cx="2" cy="0" r="19"/>';
function bjtDraw(pnp: boolean): string {
  return body + line(-30, 0, -8, 0) + line(-8, -12, -8, 12, 'plate')
    + line(-8, -6, 10, -18) + line(10, -18, 10, -30)
    + (pnp ? arrow(4, 14, -6, 7.5) + line(4, 14, 10, 18) : line(-8, 6, 0, 11.3) + arrow(0, 11.3, 10, 18))
    + line(10, 18, 10, 30);
}
function jfetDraw(p: boolean): string {
  return body + line(-8, -14, -8, 14, 'plate')
    + line(-8, -10, 10, -10) + line(10, -10, 10, -30)
    + line(-8, 10, 10, 10) + line(10, 10, 10, 30)
    + (p ? arrow(-8, 0, -22, 0) + line(-22, 0, -30, 0) : arrow(-30, 0, -9, 0));
}
/** Enhancement MOSFET: insulated gate plate, broken channel, body arrow tied to the source. */
function mosDraw(p: boolean): string {
  return body + line(-30, 0, -12, 0) + line(-12, -12, -12, 12)
    + line(-6, -14, -6, -7, 'plate') + line(-6, -3, -6, 3, 'plate') + line(-6, 7, -6, 14, 'plate')
    + line(-6, -10, 10, -10) + line(10, -10, 10, -30)
    + line(-6, 10, 10, 10) + line(10, 10, 10, 30)
    + (p ? arrow(-6, 0, 9, 0) : arrow(10, 0, -5, 0)) + line(10, 0, 10, 10);
}
const modelName = (models: Record<string, { label: string }>, p: SchPart, dflt: string) =>
  (models[p.props?.model ?? dflt] ? (p.props?.model ?? dflt) : (p.props?.model ?? ''));

/* ---------- Library ---------- */
export const PARTS: Record<PartKind, PartSpec> = {
  R: {
    label: 'Resistor', pins: TWO, box: [-30, -7, 30, 7], unit: 'Ω',
    draw: () => zigzag(),
    valueText: p => fmtEng(p.value, 'Ω'),
    elements: (p, n) => [{ type: 'R', name: p.ref || p.id, a: n('1'), b: n('2'), value: two(p) }],
  },
  C: {
    label: 'Capacitor', pins: TWO, box: [-30, -11, 30, 11], unit: 'F',
    draw: () => line(-30, 0, -3.5, 0) + line(3.5, 0, 30, 0) + line(-3.5, -11, -3.5, 11, 'plate') + line(3.5, -11, 3.5, 11, 'plate'),
    valueText: p => (p.value === 0 ? 'omit' : fmtEng(p.value, 'F')),
    elements: (p, n) => [{ type: 'C', name: p.ref || p.id, a: n('1'), b: n('2'), value: two(p) }],
  },
  L: {
    label: 'Inductor', pins: TWO, box: [-30, -6, 30, 2], unit: 'H',
    draw: () => line(-30, 0, -20, 0) + `<path d="M -20 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0"/>` + line(20, 0, 30, 0),
    valueText: p => fmtEng(p.value, 'H'),
    elements: (p, n) => [{ type: 'L', name: p.ref || p.id, a: n('1'), b: n('2'), value: two(p) }],
  },
  POT: {
    label: 'Potentiometer', box: [-30, -30, 30, 7], unit: 'Ω', avoid: [0, -1],
    pins: [{ name: '1', at: [-30, 0] }, { name: '3', at: [30, 0] }, { name: 'w', at: [0, -30] }],
    draw: p => zigzag() + arrow(0, -30, -16 + 32 * wiperFrac(p), -8),
    valueText: p => `${fmtEng(p.value, 'Ω')} ${p.props?.taper ?? 'B'}${p.props?.reverse ? ' rev' : ''}`,
    elements: (p, n) => [{
      type: 'POT', name: p.ref || p.id, a: n('1'), w: n('w'), b: n('3'), value: two(p),
      taper: (p.props?.taper ?? 'B') as TaperKey, rot: p.props?.turn ?? 0.5, ...(p.props?.reverse ? { reverse: true } : {}),
    }],
  },
  RHEO: {
    label: 'Variable resistor', pins: TWO, box: [-30, -15, 30, 15], unit: 'Ω', labelPad: 9,
    draw: () => zigzag() + arrow(-13, 15, 13, -15),
    valueText: p => `${fmtEng(p.value, 'Ω')} ${p.props?.taper ?? 'B'}${p.props?.reverse ? ' rev' : ''}`,
    elements: (p, n) => [{
      type: 'RHEO', name: p.ref || p.id, a: n('1'), b: n('2'), value: two(p),
      taper: (p.props?.taper ?? 'B') as TaperKey, rot: p.props?.turn ?? 0.5, ...(p.props?.reverse ? { reverse: true } : {}),
    }],
  },
  D: {
    label: 'Diode', box: [-30, -8, 30, 8],
    pins: [{ name: 'a', at: [-30, 0] }, { name: 'k', at: [30, 0] }],
    draw: () => line(-30, 0, -8, 0) + polygon([[-8, -8], [-8, 8], [8, 0]], 'diode') + line(8, -8, 8, 8) + line(8, 0, 30, 0),
    valueText: p => DIODE_MODELS[p.props?.model ?? '']?.label.split(' ')[0] ?? (p.props?.model ?? ''),
    elements: (p, n) => [{ type: 'D', name: p.ref || p.id, a: n('a'), k: n('k'), model: p.props?.model ?? '1N4148' }],
  },
  LED: {
    label: 'LED', box: [-30, -16, 30, 8],
    pins: [{ name: 'a', at: [-30, 0] }, { name: 'k', at: [30, 0] }],
    draw: () => line(-30, 0, -8, 0) + polygon([[-8, -8], [-8, 8], [8, 0]], 'diode') + line(8, -8, 8, 8) + line(8, 0, 30, 0)
      + arrow(0, -9, 8, -17) + arrow(5, -6, 13, -14),
    valueText: () => 'LED',
    elements: (p, n) => [{ type: 'D', name: p.ref || p.id, a: n('a'), k: n('k'), model: p.props?.model ?? 'LED_RED' }],
  },
  NPN: {
    label: 'NPN transistor', pins: Q_PINS, box: [-30, -30, 21, 30], avoid: [1, 0],
    draw: () => bjtDraw(false),
    valueText: p => modelName(BJT_MODELS, p, '2N3904'),
    elements: (p, n) => [{ type: 'Q', name: p.ref || p.id, c: n('c'), b: n('b'), e: n('e'), model: p.props?.model ?? '2N3904' }],
  },
  PNP: {
    label: 'PNP transistor', pins: Q_PINS, box: [-30, -30, 21, 30], avoid: [1, 0],
    draw: () => bjtDraw(true),
    valueText: p => modelName(BJT_MODELS, p, '2N3906'),
    elements: (p, n) => [{ type: 'Q', name: p.ref || p.id, c: n('c'), b: n('b'), e: n('e'), model: p.props?.model ?? '2N3906' }],
  },
  NJF: {
    label: 'N-channel JFET', pins: J_PINS, box: [-30, -30, 21, 30], avoid: [1, 0],
    draw: () => jfetDraw(false),
    valueText: p => modelName(JFET_MODELS, p, 'J201'),
    elements: (p, n) => [{ type: 'J', name: p.ref || p.id, d: n('d'), g: n('g'), s: n('s'), model: p.props?.model ?? 'J201' }],
  },
  PJF: {
    label: 'P-channel JFET', pins: J_PINS, box: [-30, -30, 21, 30], avoid: [1, 0],
    draw: () => jfetDraw(true),
    valueText: p => modelName(JFET_MODELS, p, '2N5460'),
    elements: (p, n) => [{ type: 'J', name: p.ref || p.id, d: n('d'), g: n('g'), s: n('s'), model: p.props?.model ?? '2N5460' }],
  },
  NMOS: {
    label: 'N-channel MOSFET', pins: J_PINS, box: [-30, -30, 21, 30], avoid: [1, 0],
    draw: () => mosDraw(false),
    valueText: p => modelName(MOS_MODELS, p, '2N7000'),
    elements: (p, n) => [{ type: 'M', name: p.ref || p.id, d: n('d'), g: n('g'), s: n('s'), model: p.props?.model ?? '2N7000' }],
  },
  PMOS: {
    label: 'P-channel MOSFET', pins: J_PINS, box: [-30, -30, 21, 30], avoid: [1, 0],
    draw: () => mosDraw(true),
    valueText: p => modelName(MOS_MODELS, p, 'BS250'),
    elements: (p, n) => [{ type: 'M', name: p.ref || p.id, d: n('d'), g: n('g'), s: n('s'), model: p.props?.model ?? 'BS250' }],
  },
  SW: {
    label: 'Switch (on-off, SPST)', pins: TWO, box: [-30, -12, 30, 3],
    draw: p => line(-30, 0, -12, 0) + line(12, 0, 30, 0) + `<circle class="contact" cx="-12" cy="0" r="2"/><circle class="contact" cx="12" cy="0" r="2"/>`
      + (p.props?.closed ? line(-12, 0, 12, -2) : line(-12, 0, 10, -11)),
    valueText: p => (p.props?.closed ? 'closed' : 'open'),
    elements: (p, n) => [{ type: 'SW', name: p.ref || p.id, a: n('1'), b: n('2'), closed: !!p.props?.closed }],
  },
  SPDT: {
    label: 'Switch (on-on, SPDT)', box: [-30, -22, 30, 22],
    pins: [{ name: 'c', at: [-30, 0] }, { name: 'a', at: [30, -20] }, { name: 'b', at: [30, 20] }],
    draw: p => line(-30, 0, -12, 0) + line(12, -20, 30, -20) + line(12, 20, 30, 20)
      + `<circle class="contact" cx="-12" cy="0" r="2"/><circle class="contact" cx="12" cy="-20" r="2"/><circle class="contact" cx="12" cy="20" r="2"/>`
      + (p.props?.pos === 'b' ? line(-12, 0, 11, 17) : line(-12, 0, 11, -17)),
    valueText: p => `to ${p.props?.pos ?? 'a'}`,
    elements: (p, n) => [{ type: 'SPDT', name: p.ref || p.id, com: n('c'), a: n('a'), b: n('b'), pos: p.props?.pos === 'b' ? 'b' : 'a' }],
  },
  ONOFFON: {
    // SPDT with a centre-off position: common to A, to nothing, or to B.
    label: 'Switch (on-off-on)', box: [-30, -22, 30, 22],
    pins: [{ name: 'c', at: [-30, 0] }, { name: 'a', at: [30, -20] }, { name: 'b', at: [30, 20] }],
    draw: p => line(-30, 0, -12, 0) + line(12, -20, 30, -20) + line(12, 20, 30, 20)
      + `<circle class="contact" cx="-12" cy="0" r="2"/><circle class="contact" cx="12" cy="-20" r="2"/><circle class="contact" cx="12" cy="20" r="2"/>`
      + (p.props?.pos === 'b' ? line(-12, 0, 11, 17) : p.props?.pos === 'a' ? line(-12, 0, 11, -17) : line(-12, 0, 9, 0)),
    valueText: p => (p.props?.pos === 'a' || p.props?.pos === 'b' ? `to ${p.props.pos}` : 'off'),
    elements: (p, n) => (p.props?.pos === 'a' || p.props?.pos === 'b'
      ? [{ type: 'SPDT', name: p.ref || p.id, com: n('c'), a: n('a'), b: n('b'), pos: p.props.pos }]
      : []),
  },
  OA: {
    label: 'Op-amp', box: [-40, -40, 40, 40], avoid: [0, 1],
    pins: [{ name: '-', at: [-40, -20] }, { name: '+', at: [-40, 20] }, { name: 'out', at: [40, 0] }],
    draw: () => polygon([[-40, -40], [-40, 40], [40, 0]]),
    valueText: p => (p.props?.model && p.props.model !== 'ideal' ? p.props.model : ''),
    elements: (p, n) => [{ type: 'OA', name: p.ref || p.id, inP: n('+'), inN: n('-'), out: n('out'), model: p.props?.model ?? 'ideal' }],
  },
  BUF: {
    label: 'Unity buffer', box: [-20, -11, 20, 11],
    pins: [{ name: 'in', at: [-20, 0] }, { name: 'out', at: [20, 0] }],
    draw: () => line(-20, 0, -11, 0) + polygon([[-11, -11], [-11, 11], [11, 0]]) + line(11, 0, 20, 0),
    valueText: () => '×1',
    elements: (p, n) => [{ type: 'E', name: p.ref || p.id, p: n('out'), n: GND, cp: n('in'), cn: GND, gain: 1 }],
  },
  GND: {
    label: 'Ground', box: [-10, 0, 10, 14], pins: [{ name: 'g', at: [0, 0] }],
    draw: () => line(0, 0, 0, 6) + line(-10, 6, 10, 6) + line(-6, 10, 6, 10) + line(-2, 14, 2, 14),
    elements: () => [],
  },
  SUPPLY: {
    label: 'Supply rail', box: [-10, -12, 10, 0], unit: 'V', pins: [{ name: 'v', at: [0, 0] }],
    draw: () => line(0, 0, 0, -10) + line(-10, -10, 10, -10),
    elements: (p, n) => [{ type: 'V', name: p.ref || p.id, p: n('v'), n: GND, dc: p.value ?? 9 }],
  },
  LABEL: {
    // A short line from the pin with a tick at the end; the name sits on top of the line.
    label: 'Net label', box: [0, -14, 40, 4], pins: [{ name: 'n', at: [0, 0] }],
    boxOf: p => [0, -14, labelLen(p), 4],
    draw: p => { const L = labelLen(p); return line(0, 0, L, 0) + line(L, -4, L, 4); },
    elements: () => [],
  },
  IN: {
    label: 'Input jack', box: [-4, -4, 4, 4], pins: [{ name: 'io', at: [0, 0] }],
    draw: () => '<circle class="term" cx="0" cy="0" r="3.5"/>',
    elements: () => [],
  },
  PROBE: {
    // A voltage probe: a short lead and a coloured tip. Not an electrical part.
    label: 'Probe', box: [-2, -24, 24, 2], pins: [{ name: 'p', at: [0, 0] }],
    draw: () => line(0, 0, 10, -10, 'probe-lead') + '<circle class="probe-tip" cx="15" cy="-15" r="6"/>',
    elements: () => [],
  },
  OUT: {
    label: 'Output jack', box: [-4, -4, 4, 4], pins: [{ name: 'io', at: [0, 0] }],
    draw: () => '<circle class="term" cx="0" cy="0" r="3.5"/>',
    elements: () => [],
  },
};

export const OPAMP_KEYS = Object.keys(OPAMP_MODELS);

/** Probe colours, assigned by probe number (P1, P2, …). */
export const PROBE_COLORS = ['#1c7ed6', '#2f9e44', '#ae3ec9', '#0c8599', '#e64980', '#e67700', '#5c940d', '#7048e8'];
export const probeColor = (ref?: string): string => {
  const n = parseInt((ref || '').replace(/\D/g, ''), 10);
  return PROBE_COLORS[((n > 0 ? n : 1) - 1) % PROBE_COLORS.length];
};
