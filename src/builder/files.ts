// Builder files: project save/load (JSON), SPICE netlist, parts list (BOM CSV), schematic SVG/PNG.
import type { Term } from '../core/termination';
import { fmtEng } from '../core/units';
import { sanitizeSchematic } from '../schematic/sanitize';
import { DIODE_MODELS, OPAMP_MODELS } from '../engine/models';
import { BJT_MODELS, JFET_MODELS, MOS_MODELS } from '../engine/semis';
import { toSpice } from '../engine/spice';
import { extract } from '../schematic/extract';
import { PARTS } from '../schematic/library';
import { renderSchematic } from '../schematic/render';
import type { SchPart, Schematic } from '../schematic/types';
import { isTrace, type Trace } from './trace';

export const PROJECT_KIND = 'pedal-filter-lab/builder-project';

/** Simulation settings saved with a project (mirrors the simulation panel). */
export interface ProjectSim {
  term: Term;
  showOut?: boolean;
  showTol?: boolean;
  showPhase?: boolean;
  sweep?: string;
  steps?: number;
  /** A second sweep, combined with the first (every combination). */
  sweep2?: string;
  steps2?: number;
}

export interface Project {
  kind: typeof PROJECT_KIND;
  version: 1;
  name: string;
  saved: string;
  schematic: Schematic;
  sim?: ProjectSim;
  view?: { x: number; y: number; zoom: number };
  /** Trace picture shown under the drawing, if any. */
  trace?: Trace;
}

export function makeProject(name: string, schematic: Schematic, sim?: ProjectSim, view?: Project['view'], trace?: Trace | null): Project {
  return { kind: PROJECT_KIND, version: 1, name: name || 'Untitled pedal', saved: new Date().toISOString(), schematic, sim, view, ...(trace ? { trace } : {}) };
}

/** Parse a project file. Accepts a bare schematic too (e.g. hand-written JSON). Throws a readable error. */
export function parseProject(text: string): Project {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  const d = data as Partial<Project> & Partial<Schematic>;
  // The schematic is rebuilt with checked types (a file is untrusted input).
  const schematic = sanitizeSchematic(d.kind === PROJECT_KIND ? d.schematic : d);
  if (d.kind !== PROJECT_KIND) return makeProject('Imported pedal', schematic);
  const v = d.view as Project['view'] | undefined;
  const view = v && [v.x, v.y, v.zoom].every(n => typeof n === 'number' && isFinite(n)) && v.zoom > 0 ? { x: v.x, y: v.y, zoom: v.zoom } : undefined;
  const sim = d.sim && typeof d.sim === 'object' && d.sim.term && typeof d.sim.term === 'object' ? d.sim : undefined;
  return {
    kind: PROJECT_KIND, version: 1, name: typeof d.name === 'string' ? d.name : 'Untitled pedal', saved: String(d.saved ?? ''),
    schematic, sim, view, trace: isTrace(d.trace) ? d.trace : undefined,
  };
}

export const safeFileName = (name: string): string => (name || 'pedal').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'pedal';

/* ---------- SPICE ---------- */
export function projectSpice(name: string, doc: Schematic, term: Term | null, fmin: number, fmax: number): string {
  const ex = extract(doc);
  const notes: string[] = [];
  const knobs = doc.parts.filter(p => (p.kind === 'POT' || p.kind === 'RHEO') && p.ref).map(p => `${p.ref} ${((p.props?.turn ?? 0.5) * 10).toFixed(1)}/10`);
  if (knobs.length) notes.push('Knobs: ' + knobs.join(', '));
  for (const p of doc.parts.filter(q => q.kind === 'PROBE')) {
    const net = ex.pinNet.get(`${p.id}:p`);
    if (net) notes.push(`Probe ${p.ref || p.id}: V(${net.replace(/[^A-Za-z0-9_]/g, '_')})`);
  }
  if (doc.parts.some(p => ['D', 'LED', 'NPN', 'PNP', 'NJF', 'PJF', 'NMOS', 'PMOS'].includes(p.kind))) notes.push('Semiconductors are included with SPICE models; the app linearises them at their DC operating point.');
  const errors = ex.issues.filter(i => i.severity === 'error');
  if (errors.length) notes.push('WARNING: the design has errors: ' + errors.map(e => e.message).join(' '));
  return toSpice(ex.netlist, { title: name, term, fmin, fmax, notes });
}

/* ---------- Parts list ---------- */
export interface BomRow { qty: number; refs: string[]; part: string; value: string; notes: string }

const COMPONENT_KINDS = new Set(['R', 'C', 'L', 'POT', 'RHEO', 'D', 'LED', 'NPN', 'PNP', 'NJF', 'PJF', 'NMOS', 'PMOS', 'SW', 'SPDT', 'ONOFFON', 'OA']);

function describe(p: SchPart): { part: string; value: string; notes: string } {
  switch (p.kind) {
    case 'R': return { part: 'Resistor', value: fmtEng(p.value, 'Ω'), notes: '' };
    case 'C': return { part: 'Capacitor', value: fmtEng(p.value, 'F'), notes: (p.value ?? 0) >= 1e-6 ? 'electrolytic or film; check polarity/voltage' : '' };
    case 'L': return { part: 'Inductor', value: fmtEng(p.value, 'H'), notes: '' };
    case 'POT': return { part: 'Potentiometer', value: fmtEng(p.value, 'Ω'), notes: `taper ${p.props?.taper ?? 'B'}` };
    case 'RHEO': return { part: 'Potentiometer (as variable resistor)', value: fmtEng(p.value, 'Ω'), notes: `taper ${p.props?.taper ?? 'B'}` };
    case 'D': return { part: 'Diode', value: p.props?.model ?? '1N4148', notes: DIODE_MODELS[p.props?.model ?? '']?.label ?? '' };
    case 'LED': return { part: 'LED', value: p.props?.model ?? 'LED_RED', notes: '' };
    case 'NPN': case 'PNP': {
      const m = p.props?.model ?? (p.kind === 'NPN' ? '2N3904' : '2N3906');
      return { part: 'Transistor (BJT)', value: m, notes: BJT_MODELS[m]?.label ?? '' };
    }
    case 'NMOS': case 'PMOS': {
      const m = p.props?.model ?? (p.kind === 'NMOS' ? '2N7000' : 'BS250');
      return { part: 'Transistor (MOSFET)', value: m, notes: MOS_MODELS[m]?.label ?? '' };
    }
    case 'NJF': case 'PJF': {
      const m = p.props?.model ?? (p.kind === 'NJF' ? 'J201' : '2N5460');
      return { part: 'Transistor (JFET)', value: m, notes: JFET_MODELS[m]?.label ?? '' };
    }
    case 'SW': return { part: 'Switch', value: 'SPST', notes: '' };
    case 'SPDT': return { part: 'Switch', value: 'SPDT on-on', notes: '' };
    case 'ONOFFON': return { part: 'Switch', value: 'SPDT on-off-on', notes: '' };
    case 'OA': {
      const m = p.props?.model ?? 'ideal';
      return { part: 'Op-amp', value: m === 'ideal' ? '(choose a part)' : m, notes: m === 'ideal' ? 'simulated as ideal' : OPAMP_MODELS[m]?.label ?? '' };
    }
    default: return { part: PARTS[p.kind].label, value: '', notes: '' };
  }
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Group identical components (same part, value and notes) with their reference designators. */
export function bomRows(doc: Schematic): BomRow[] {
  const groups = new Map<string, BomRow>();
  for (const p of doc.parts) {
    if (!COMPONENT_KINDS.has(p.kind)) continue;
    const d = describe(p), k = `${d.part}|${d.value}|${d.notes}`;
    const row = groups.get(k) || { qty: 0, refs: [], ...d };
    row.qty++; row.refs.push(p.ref || p.id);
    groups.set(k, row);
  }
  const order = ['Resistor', 'Capacitor', 'Inductor', 'Potentiometer', 'Potentiometer (as variable resistor)', 'Diode', 'LED', 'Transistor (BJT)', 'Transistor (JFET)', 'Transistor (MOSFET)', 'Op-amp', 'Switch'];
  return [...groups.values()]
    .map(r => ({ ...r, refs: r.refs.sort(natural) }))
    .sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part) || natural(a.refs[0], b.refs[0]));
}

const csvCell = (s: string | number) => {
  const t = String(s);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function bomCsv(name: string, doc: Schematic): string {
  const rows = bomRows(doc);
  const lines = [['Qty', 'References', 'Part', 'Value', 'Notes'].join(',')];
  for (const r of rows) lines.push([r.qty, r.refs.join(' '), r.part, r.value, r.notes].map(csvCell).join(','));
  // Excel opens UTF-8 CSV correctly (Ω, µ) only with a byte-order mark.
  return '﻿' + `# ${name}\n` + lines.join('\n') + '\n';
}

/* ---------- Schematic images ---------- */
// The app styles schematics with CSS; standalone files need their own (light, print-friendly) styles.
const EXPORT_CSS = `
  .schem line, .schem polyline, .schem polygon, .schem path { stroke: #222; stroke-width: 1.6; fill: none; stroke-linejoin: round; stroke-linecap: round; }
  .schem .plate { stroke-width: 2.6; }
  .schem .dot { fill: #222; }
  .schem .term, .schem .contact { fill: #fff; stroke: #222; stroke-width: 1.6; }
  .schem .qbody { fill: none; stroke: #222; stroke-width: 1.2; opacity: .7; }
  .schem .head { fill: #222; stroke: #222; stroke-width: 1; }
  .schem text { fill: #111; font: 11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .schem .tl { fill: #666; font-size: 10px; letter-spacing: .05em; }
  .schem .pn { font-weight: 700; }
  .schem .pv { fill: #555; font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 10.5px; }
  .schem .sign { font-size: 13px; font-weight: 600; }
  .schem .pinno { fill: #666; font-size: 8.5px; }
  .schem .pinlbl { font-size: 8.5px; font-family: monospace; }
  .schem .tiny { fill: #666; font-size: 9px; }
  .schem .probe-lead { stroke: var(--probe); stroke-width: 2; }
  .schem .probe-tip { fill: var(--probe); stroke: var(--probe); fill-opacity: .35; }
  .schem text.probe-ref { fill: var(--probe); }`;

/** A self-contained SVG file (white background, embedded styles). */
export function schematicSvg(name: string, doc: Schematic): { svg: string; width: number; height: number } {
  const inner = renderSchematic(doc, { title: name });
  const vb = inner.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
  const [x, y, w, h] = vb, scale = 2;
  const body = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${w * scale}" height="${h * scale}">` +
    `<title>${name.replace(/[<&]/g, '')}</title><style>${EXPORT_CSS}</style>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/><g class="schem">${body}</g></svg>`;
  return { svg, width: w * scale, height: h * scale };
}

/** Rasterise the SVG to a PNG blob (browser only). */
export function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0, width, height);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not create the PNG.'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not render the schematic image.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
