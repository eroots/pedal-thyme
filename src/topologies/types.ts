import type { Cx } from '../core/complex';
import type { SeriesName } from '../core/eseries';
import type { TaperKey } from '../core/pots';
import type { Opts, Values, Zterm } from '../core/types';
import type { Circuit } from '../engine/mna';
import type { Netlist } from '../engine/netlist';

export type PartType = 'R' | 'C';

export interface PartDef {
  key: string;
  type: PartType;
  def: number;
  /** A value of 0 means "omit this part" (e.g. an optional feedback cap). */
  zeroOk?: boolean;
  /** Set for potentiometers: the taper of the pot. */
  pot?: TaperKey;
}

export interface Metric {
  key: string;
  label: string;
  value: number | null | undefined;
  /** 'Hz', 'dB', 'H', or '' for unitless (Q). */
  unit: string;
  /** Don't draw a marker line on the plot for this frequency. */
  noMark?: boolean;
}

export type TargetKind = 'freq' | 'db' | 'q' | 'param';
export interface TargetDef { key: string; label: string; kind: TargetKind; def: number }

export interface OptionDef {
  key: string;
  label: string;
  def: number | boolean | string;
  /** Omitted for a checkbox; 'range' for a knob/slider; 'select' for a model choice. */
  type?: 'range' | 'select';
  /** For 'select'. */
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  fmt?: (x: number) => string;
  /** The pot part this knob drives, if any. */
  pot?: string;
}

export interface Preset { name: string; values: Values; opts?: Opts }

export interface DesignCtx {
  topo: Topology;
  opts: Opts;
  values?: Values;
  rSeries: SeriesName;
  cSeries: SeriesName;
  /** Exact mode: don't snap intermediate choices to the E-series. */
  exact?: boolean;
}

/** Drawing API handed to each topology's schematic function. Coordinates are SVG user units. */
export interface SchematicDrawer {
  w(...pts: [number, number][]): void;
  dot(x: number, y: number): void;
  gnd(x: number, y: number): void;
  term(x: number, y: number, label: string, side?: 'l' | 'r'): void;
  amp(x: number, y: number, plusTop: boolean): void;
  arrow(x1: number, y1: number, x2: number, y2: number): void;
  note(x: number, y: number, text: string, anchor?: 'start' | 'middle' | 'end'): void;
  buf(x: number, y: number): void;
  R(k: string, x1: number, y1: number, x2: number, y2: number, side?: LabelSide): void;
  C(k: string, x1: number, y1: number, x2: number, y2: number, side?: LabelSide): void;
  Rv(k: string, x1: number, y1: number, x2: number, y2: number, side?: LabelSide): void;
}
export type LabelSide = 't' | 'b' | 'l' | 'r';

/** A topology as authored: the circuit is a netlist; H(s) is derived from it by the MNA engine. */
export interface TopologyDef {
  id: string;
  group: string;
  name: string;
  blurb: string;
  parts: PartDef[];
  options?: OptionDef[];
  presets?: Preset[];
  /** The circuit for given values and options. Input node "in", output node "out". */
  netlist(v: Values, o: Opts): Netlist;
  analyze(v: Values, o: Opts, t: Topology): Metric[];
  targets: TargetDef[];
  /** The part the design search sweeps over standard values. */
  anchor?: string;
  design?(t: Values, a: number, ctx: DesignCtx): Values;
  /** SVG viewBox for the schematic. */
  vb: string;
  sch(d: SchematicDrawer, o: Opts): void;
}

export interface Topology extends TopologyDef {
  /** Small-signal transfer V(out)/V(source) with optional source/load impedances. */
  H(v: Values, s: Cx, o: Opts, z?: Zterm | null): Cx;
  /** The compiled circuit (cached), for impedances and node probes. */
  circuit(v: Values, o: Opts): Circuit;
}
