// Part library: pin positions, schematic symbols (in local coordinates), default label placement and
// the netlist elements each part becomes. Two-terminal parts have pins at (−30, 0) and (30, 0).
import { taper, type TaperKey } from '../core/pots';
import { clamp, fmtEng } from '../core/units';
import { OPAMP_MODELS, DIODE_MODELS } from '../engine/models';
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
const wiperFrac = (p: SchPart) => clamp(taper(p.props?.turn ?? 0.5, p.props?.taper ?? 'B'), 1e-4, 1 - 1e-4);
const two = (p: SchPart) => p.value ?? 0;

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
    valueText: p => `${fmtEng(p.value, 'Ω')} ${p.props?.taper ?? 'B'}`,
    elements: (p, n) => [{
      type: 'POT', name: p.ref || p.id, a: n('1'), w: n('w'), b: n('3'), value: two(p),
      taper: (p.props?.taper ?? 'B') as TaperKey, rot: p.props?.turn ?? 0.5,
    }],
  },
  RHEO: {
    label: 'Variable resistor', pins: TWO, box: [-30, -15, 30, 15], unit: 'Ω', labelPad: 9,
    draw: () => zigzag() + arrow(-13, 15, 13, -15),
    valueText: p => `${fmtEng(p.value, 'Ω')} ${p.props?.taper ?? 'B'}`,
    elements: (p, n) => [{
      type: 'RHEO', name: p.ref || p.id, a: n('1'), b: n('2'), value: two(p),
      taper: (p.props?.taper ?? 'B') as TaperKey, rot: p.props?.turn ?? 0.5,
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
  SW: {
    label: 'Switch (SPST)', pins: TWO, box: [-30, -12, 30, 3],
    draw: p => line(-30, 0, -12, 0) + line(12, 0, 30, 0) + `<circle class="contact" cx="-12" cy="0" r="2"/><circle class="contact" cx="12" cy="0" r="2"/>`
      + (p.props?.closed ? line(-12, 0, 12, -2) : line(-12, 0, 10, -11)),
    valueText: p => (p.props?.closed ? 'closed' : 'open'),
    elements: (p, n) => [{ type: 'SW', name: p.ref || p.id, a: n('1'), b: n('2'), closed: !!p.props?.closed }],
  },
  SPDT: {
    label: 'Switch (SPDT)', box: [-30, -22, 30, 22],
    pins: [{ name: 'c', at: [-30, 0] }, { name: 'a', at: [30, -20] }, { name: 'b', at: [30, 20] }],
    draw: p => line(-30, 0, -12, 0) + line(12, -20, 30, -20) + line(12, 20, 30, 20)
      + `<circle class="contact" cx="-12" cy="0" r="2"/><circle class="contact" cx="12" cy="-20" r="2"/><circle class="contact" cx="12" cy="20" r="2"/>`
      + (p.props?.pos === 'b' ? line(-12, 0, 11, 17) : line(-12, 0, 11, -17)),
    valueText: p => `to ${p.props?.pos ?? 'a'}`,
    elements: (p, n) => [{ type: 'SPDT', name: p.ref || p.id, com: n('c'), a: n('a'), b: n('b'), pos: p.props?.pos ?? 'a' }],
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
    label: 'Net label', box: [0, -6, 30, 6], pins: [{ name: 'n', at: [0, 0] }],
    draw: () => polyline([[0, 0], [6, -6], [30, -6], [30, 6], [6, 6], [0, 0]], 'flag'),
    elements: () => [],
  },
  IN: {
    label: 'Input jack', box: [-4, -4, 4, 4], pins: [{ name: 'io', at: [0, 0] }],
    draw: () => '<circle class="term" cx="0" cy="0" r="3.5"/>',
    elements: () => [],
  },
  OUT: {
    label: 'Output jack', box: [-4, -4, 4, 4], pins: [{ name: 'io', at: [0, 0] }],
    draw: () => '<circle class="term" cx="0" cy="0" r="3.5"/>',
    elements: () => [],
  },
};

export const OPAMP_KEYS = Object.keys(OPAMP_MODELS);
