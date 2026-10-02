import type { Cx } from '../core/complex';
import type { SeriesName } from '../core/eseries';
import type { TaperKey } from '../core/pots';
import type { Opts, Values, Zterm } from '../core/types';
import type { Circuit } from '../engine/mna';
import type { Netlist } from '../engine/netlist';
import type { Schematic } from '../schematic/types';

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

/** A topology as authored. The schematic is the circuit; its netlist and H(s) are derived. */
export interface TopologyDef {
  id: string;
  group: string;
  name: string;
  blurb: string;
  parts: PartDef[];
  options?: OptionDef[];
  presets?: Preset[];
  /** The circuit drawing for given values and options; part refs match `parts` keys. */
  schematic(v: Values, o: Opts): Schematic;
  analyze(v: Values, o: Opts, t: Topology): Metric[];
  targets: TargetDef[];
  /** The part the design search sweeps over standard values. */
  anchor?: string;
  design?(t: Values, a: number, ctx: DesignCtx): Values;
}

export interface Topology extends TopologyDef {
  /** Netlist extracted from the schematic (input node "in", output node "out"). */
  netlist(v: Values, o: Opts): Netlist;
  /** Small-signal transfer V(out)/V(source) with optional source/load impedances. */
  H(v: Values, s: Cx, o: Opts, z?: Zterm | null): Cx;
  /** The compiled circuit (cached), for impedances and node probes. */
  circuit(v: Values, o: Opts): Circuit;
}
