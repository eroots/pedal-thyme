// Playground state, persistence (localStorage) and pot-sweep definitions.
import type { SeriesName } from '../core/eseries';
import { taper, type TaperKey } from '../core/pots';
import type { Term } from '../core/termination';
import type { Opts, Values } from '../core/types';
import { clamp, fmtEng } from '../core/units';
import { TOPOS, topoById } from '../topologies';
import type { PartType, Topology } from '../topologies/types';

const LS_KEY = 'pedal-filter-lab.v1';
export const COMPARE_COLORS = ['#1c7ed6', '#2f9e44', '#9c36b5', '#0c8599', '#c2255c', '#74b816', '#e67700', '#495057'];

export interface Settings {
  rSeries: SeriesName; cSeries: SeriesName; rTol: number; cTol: number;
  /** "fmin-fmax" in Hz. */
  range: string; showTol: boolean; showPhase: boolean;
}
const DEFAULT_SETTINGS: Settings = { rSeries: 'E24', cSeries: 'E12', rTol: 5, cTol: 10, range: '10-50000', showTol: true, showPhase: true };

export type SweepTaper = 'L' | TaperKey;
export interface SweepState { key: string; steps: number; taper: SweepTaper; min: number | null; max: number | null }
export interface TopoState { values: Values; opts: Opts; targets: Values; anchor?: number; sweep: SweepState }
export interface CompareItem { id: string; name: string; topoId: string; values: Values; opts: Opts; term: Term | null; color: string; visible: boolean }
export interface SavedDesign { id: string; name: string; topoId: string; values: Values; opts?: Opts; targets?: Values; term?: Term; date?: string }
export interface AppState {
  topoId: string;
  per: Record<string, TopoState>;
  settings: Settings;
  compare: CompareItem[];
  saved: SavedDesign[];
  term: Term;
}

interface SourcePreset { label: string; R?: number; L?: number; C?: number }
export const SRC_PRESETS: Record<string, SourcePreset> = {
  buffer: { label: 'Op-amp / buffer output (100 Ω)', R: 100, L: 0, C: 0 },
  stage: { label: 'Previous pedal stage (10 kΩ)', R: 10e3, L: 0, C: 0 },
  tube: { label: 'Tube gain stage (≈38 kΩ)', R: 38e3, L: 0, C: 0 },
  single: { label: 'Single-coil pickup + cable (6 kΩ, 2.5 H, 470 pF)', R: 6e3, L: 2.5, C: 470e-12 },
  humbucker: { label: 'Humbucker + cable (8 kΩ, 4 H, 470 pF)', R: 8e3, L: 4, C: 470e-12 },
  custom: { label: 'Custom' },
};
export const LOAD_PRESETS: Record<string, SourcePreset> = {
  pedal: { label: 'Pedal input (1 MΩ)', R: 1e6, C: 0 },
  amp: { label: 'Amp input + cable (1 MΩ ∥ 470 pF)', R: 1e6, C: 470e-12 },
  stage100: { label: 'Next stage (100 kΩ)', R: 100e3, C: 0 },
  stage10: { label: 'Low-impedance stage (10 kΩ)', R: 10e3, C: 0 },
  custom: { label: 'Custom' },
};
const DEFAULT_TERM: Term = {
  src: { on: false, preset: 'single', R: 6e3, L: 2.5, C: 470e-12 },
  load: { on: false, preset: 'pedal', R: 1e6, C: 0 },
};
export const cloneTerm = (term?: Term | null): Term => JSON.parse(JSON.stringify(term || DEFAULT_TERM));

function loadState(): AppState {
  const def: AppState = { topoId: TOPOS[0].id, per: {}, settings: { ...DEFAULT_SETTINGS }, compare: [], saved: [], term: cloneTerm(DEFAULT_TERM) };
  let s: Partial<AppState> | null = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* storage unavailable */ }
  if (!s || typeof s !== 'object') return def;
  const term: Partial<Term> = s.term || {};
  return {
    ...def, ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    term: { src: { ...DEFAULT_TERM.src, ...(term.src || {}) }, load: { ...DEFAULT_TERM.load, ...(term.load || {}) } },
  };
}

/** The single mutable app state. */
export const S: AppState = loadState();
if (!topoById(S.topoId)) S.topoId = TOPOS[0].id;

let persistTimer: ReturnType<typeof setTimeout> | undefined;
export function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { /* ignore */ } }, 250);
}

export const topo = (): Topology => topoById(S.topoId) || TOPOS[0];

/** Per-topology state, filled with defaults for anything missing. */
export function cur(t: Topology = topo()): TopoState {
  const p = S.per[t.id] || (S.per[t.id] = {} as TopoState);
  p.values = p.values || {}; p.opts = p.opts || {}; p.targets = p.targets || {};
  for (const x of t.parts) if (!(typeof p.values[x.key] === 'number')) p.values[x.key] = x.def;
  for (const x of t.options || []) if (!(x.key in p.opts)) p.opts[x.key] = x.def;
  for (const x of t.targets) if (!(typeof p.targets[x.key] === 'number')) p.targets[x.key] = x.def;
  if (t.anchor && !((p.anchor ?? 0) > 0)) p.anchor = p.values[t.anchor];
  if (!p.sweep || typeof p.sweep !== 'object') p.sweep = { key: '', steps: 5, taper: 'L', min: null, max: null };
  if (p.sweep.key && !sweepTargets(t).some(x => x.id === p.sweep.key)) p.sweep.key = '';
  return p;
}

/* ---------- Pot sweeps ---------- */
export interface SweepTarget { id: string; kind: 'opt' | 'part'; key: string; label: string }
export interface SweepStep { r: number; v: Values; o: Opts; label: string }

/**
 * Sweepable things: range controls (knobs/sliders, swept across their travel) and any part
 * (swept as a variable resistor/cap between min and max with a chosen taper).
 */
export function sweepTargets(t: Topology): SweepTarget[] {
  return [
    ...(t.options || []).filter(o => o.type === 'range').map(o => ({ id: 'opt:' + o.key, kind: 'opt' as const, key: o.key, label: `${o.label} — knob rotation` })),
    ...t.parts.map(x => ({ id: 'part:' + x.key, kind: 'part' as const, key: x.key, label: x.pot ? `${x.key} — pot track value` : `${x.key} value (rheostat / part swap)` })),
  ];
}
export const SWEEP_TAPERS: Record<SweepTaper, string> = { L: 'Log-spaced', B: 'Linear pot (B)', A: 'Audio pot (A)', C: 'Reverse log (C)', W: 'S-curve pot (W)' };

export function sweepSteps(t: Topology, p: TopoState): SweepStep[] {
  const sw = p.sweep, tgt = sweepTargets(t).find(x => x.id === sw.key);
  if (!tgt) return [];
  const n = clamp(Math.round(sw.steps) || 5, 2, 15), out: SweepStep[] = [];
  for (let i = 0; i < n; i++) {
    const r = i / (n - 1), v = { ...p.values }, o = { ...p.opts };
    let label: string;
    if (tgt.kind === 'opt') {
      const od = t.options!.find(x => x.key === tgt.key)!;
      const pos = od.min! + (od.max! - od.min!) * r;
      o[tgt.key] = pos;
      label = `${od.label} ${od.fmt!(+pos.toFixed(2))}`;
    } else {
      const part = t.parts.find(x => x.key === tgt.key)!, lo = sw.min ?? 1, hi = sw.max ?? 1;
      let val = sw.taper === 'L' ? lo * Math.pow(hi / lo, r) : lo + (hi - lo) * taper(r, sw.taper);
      val = Math.max(val, part.type === 'R' ? 1 : 1e-13);
      v[tgt.key] = val;
      label = `${tgt.key} ${fmtEng(val, part.type === 'R' ? 'Ω' : 'F')}` + (sw.taper === 'L' ? '' : ` (${Math.round(r * 100)}%)`);
    }
    out.push({ r, v, o, label });
  }
  return out;
}

export function sweepColor(r: number): string {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `hsl(${Math.round(190 + 120 * r)}, 70%, ${dark ? 62 : 44}%)`;
}

export const seriesFor = (type: PartType): SeriesName => (type === 'R' ? S.settings.rSeries : S.settings.cSeries);
export const fRange = (): [number, number] => {
  const [a, b] = S.settings.range.split('-').map(Number);
  return [a, b];
};
