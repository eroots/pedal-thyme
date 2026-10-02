// Schematic document format, shared by the Playground and the Pedal Builder (saved as JSON).
// Coordinates are SVG user units on a 10-unit grid; pins land on grid points.
import type { TaperKey } from '../core/pots';

export type PartKind =
  | 'R' | 'C' | 'L' | 'POT' | 'RHEO' | 'D' | 'LED' | 'SW' | 'SPDT' | 'OA' | 'BUF'
  | 'GND' | 'SUPPLY' | 'LABEL' | 'IN' | 'OUT' | 'PROBE';

/** Rotation in degrees, clockwise on screen. */
export type Rot = 0 | 90 | 180 | 270;
export type LabelSide = 't' | 'b' | 'l' | 'r';

export interface PartProps {
  /** Pot taper. */
  taper?: TaperKey;
  /** Pot rotation 0..1 (wiper travels from pin 1 to pin 3). */
  turn?: number;
  /** Op-amp or diode model key. */
  model?: string;
  /** SPST state. */
  closed?: boolean;
  /** SPDT position. */
  pos?: 'a' | 'b';
  /** Net name for LABEL and SUPPLY parts (e.g. "VREF", "9V"). */
  name?: string;
  /** Builder: offer this part (value, and rotation for pots) in the Sweep menu. */
  sweep?: boolean;
}

export interface SchPart {
  /** Unique within the schematic. */
  id: string;
  kind: PartKind;
  /** Reference designator shown on the drawing (e.g. "R1"); the Playground also uses it as the value key. */
  ref?: string;
  x: number;
  y: number;
  rot: Rot;
  /** Flip across the part's own horizontal axis before rotating (e.g. op-amp with + on top). */
  mirror?: boolean;
  /** Ω, F, H, or V (SUPPLY). */
  value?: number;
  props?: PartProps;
  /** Where to put the ref/value text; defaults depend on orientation. */
  labelSide?: LabelSide;
}

export interface SchWire { id: string; pts: [number, number][] }
export interface SchNote { id: string; x: number; y: number; text: string; anchor?: 'start' | 'middle' | 'end' }

export interface Schematic {
  version: 1;
  parts: SchPart[];
  wires: SchWire[];
  notes?: SchNote[];
}
