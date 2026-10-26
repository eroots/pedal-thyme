// Render a schematic to an SVG string. Symbols are drawn in local coordinates under a transform;
// text (refs, values, op-amp signs, jack names) is placed in world coordinates so it stays upright.
import { dirToWorld, key, onSegment, svgTransform, toWorld, type Pt } from './geometry';
import { PARTS, boxOf, labelLen, opAmpView, partPins, probeColor } from './library';
import type { LabelSide, SchNote, SchPart, Schematic } from './types';

export interface RenderOptions {
  /** Accessible name for the drawing. */
  title?: string;
  /** Part ids to highlight (e.g. ERC findings). */
  highlight?: string[];
  /** Editor mode: add wide transparent hit areas for parts and wires. */
  editor?: boolean;
  /** Selected part ids and wire ids (editor). */
  selected?: Set<string>;
  /** Symbols only: no refs, values or notes (palette icons). */
  bare?: boolean;
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/* ---------- Text notes ---------- */
/** Spacing of a note's lines (its text is 9 px). */
export const NOTE_LINE = 11;
let measurer: CanvasRenderingContext2D | null | undefined;
/** Width of a note's text in drawing units: measured in the browser, estimated elsewhere (tests). */
export function noteTextWidth(s: string): number {
  if (measurer === undefined) {
    try { measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'); } catch { measurer = null; }
    if (measurer) measurer.font = '9px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  }
  return measurer ? measurer.measureText(s).width : s.length * 5.2;
}
/** A note's lines: its own line breaks, and (with a width) words wrapped to fit, long words split. */
export function noteLines(n: SchNote): string[] {
  const paras = n.text.split('\n');
  if (!n.width) return paras;
  const width = n.width, out: string[] = [];
  const fits = (s: string) => noteTextWidth(s) <= width;
  for (const para of paras) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const joined = line ? `${line} ${word}` : word;
      if (fits(joined) || !line) line = joined;
      else { out.push(line); line = word; }
      // A word wider than the note: break it where it fills a line.
      while (!fits(line) && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && !fits(line.slice(0, k))) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}
/** A note's extent: left edge and width (its set width, or its longest line's). */
export function noteBox(n: SchNote, lines = noteLines(n)): { x0: number; w: number } {
  const w = n.width ?? Math.max(12, ...lines.map(noteTextWidth)), anchor = n.anchor || 'middle';
  return { x0: anchor === 'start' ? n.x : anchor === 'end' ? n.x - w : n.x - w / 2, w };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const LABEL_POS: Record<LabelSide, { dx: number; dy1: number; dy2: number; anchor: string }> = {
  t: { dx: 0, dy1: -27, dy2: -14, anchor: 'middle' },
  b: { dx: 0, dy1: 25, dy2: 38, anchor: 'middle' },
  r: { dx: 15, dy1: -3, dy2: 11, anchor: 'start' },
  l: { dx: -15, dy1: -3, dy2: 11, anchor: 'end' },
};

/** Where a part's ref/value text goes: explicit, or away from its wiper/output side. */
function labelSide(p: SchPart): LabelSide {
  if (p.labelSide) return p.labelSide;
  const horiz = p.rot === 0 || p.rot === 180;
  const avoid = PARTS[p.kind].avoid;
  if (avoid) {
    const [ax, ay] = dirToWorld(p, avoid);
    if (Math.abs(ay) > Math.abs(ax)) return ay < 0 ? 'b' : 't';
    return ax > 0 ? 'l' : 'r';
  }
  return horiz ? 't' : 'r';
}

export function renderSchematic(sch: Schematic, opt: RenderOptions = {}): string {
  const { body, bounds } = renderSchematicBody(sch, opt);
  const pad = 12;
  const vb = [bounds.x0 - pad, bounds.y0 - pad, bounds.x1 - bounds.x0 + 2 * pad, bounds.y1 - bounds.y0 + 2 * pad].map(n => Math.round(n));
  return `<svg viewBox="${vb.join(' ')}" class="schem" role="img" aria-label="${esc(opt.title || 'Schematic')}">${body}</svg>`;
}

/** The drawing's SVG content, its bounds and the (estimated) extent of every text label. */
export function renderSchematicBody(sch: Schematic, opt: RenderOptions = {}): { body: string; bounds: Bounds; textBoxes: [number, number, number, number][] } {
  const out: string[] = [];
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = ([x, y]: Pt, padX = 0, padY = 0) => {
    bounds.x0 = Math.min(bounds.x0, x - padX); bounds.x1 = Math.max(bounds.x1, x + padX);
    bounds.y0 = Math.min(bounds.y0, y - padY); bounds.y1 = Math.max(bounds.y1, y + padY);
  };
  const textBoxes: [number, number, number, number][] = [];
  const text = (x: number, y: number, s: string, cls: string, anchor = 'middle') => {
    if (opt.bare && cls !== 'sign') return '';
    // Rough text extent for the viewBox (≈ 6.5 units per character at 11px).
    const w = s.length * 6.5;
    grow([anchor === 'start' ? x + w : anchor === 'end' ? x - w : x + w / 2, y - 10]);
    grow([anchor === 'start' ? x : anchor === 'end' ? x : x - w / 2, y + 3]);
    const tx0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    textBoxes.push([tx0, y - 10, tx0 + w, y + 3]);
    const a = anchor === 'start' || anchor === 'end' ? anchor : 'middle';
    return `<text class="${cls}" x="${+x}" y="${+y}" text-anchor="${a}">${esc(s)}</text>`;
  };
  const hl = new Set(opt.highlight || []), sel = opt.selected || new Set<string>();

  // Wires.
  for (const w of sch.wires) {
    const pts = w.pts.map(p => p.join(',')).join(' ');
    out.push(`<polyline class="wire${sel.has(w.id) ? ' sel' : ''}" data-wire="${esc(w.id)}" points="${pts}"/>`);
    if (opt.editor) out.push(`<polyline class="wire-hit" data-wire="${esc(w.id)}" points="${pts}"/>`);
    w.pts.forEach(p => grow(p));
  }

  // Parts.
  for (const p of sch.parts) {
    const spec = PARTS[p.kind];
    const [bx0, by0, bx1, by1] = boxOf(p);
    for (const c of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]] as Pt[]) grow(toWorld(p, c));
    const hit = opt.editor ? `<rect class="hit" x="${bx0 - 4}" y="${by0 - 4}" width="${bx1 - bx0 + 8}" height="${by1 - by0 + 8}"/>` : '';
    let g = `<g transform="${svgTransform(p)}">${hit}${spec.draw(p)}</g>`;
    // Upright text.
    const view = p.kind === 'OA' ? opAmpView(p) : null;
    if (view === 'triangle') {
      for (const [sign, at] of [['−', [-23, -16]], ['+', [-23, 16]]] as [string, Pt][]) {
        const [x, y] = toWorld(p, at);
        g += text(x + (p.rot === 180 ? -2 : 2), y + 4, sign, 'sign', 'middle');
      }
    } else if (view) {
      // 8-pin package: each pin's number on its lead and its name just inside the body.
      const [ux, uy] = dirToWorld(p, [1, 0]), across = Math.abs(ux) > Math.abs(uy);
      for (const pin of partPins(p)) {
        const left = pin.at[0] < 0, ly = pin.at[1];
        const [nx, ny] = toWorld(p, [left ? -40 : 40, ly]);
        g += text(nx + (across ? 0 : 6), ny + (across ? -3 : 3), pin.name, 'pinno', across ? 'middle' : 'start');
        const [tx, ty] = toWorld(p, [left ? -27 : 27, ly]);
        // Inside the body, reading away from its edge (or centred on it when the part is turned on its side).
        const anchor = !across ? 'middle' : (ux > 0) === left ? 'start' : 'end';
        g += text(tx, ty + 3, pin.label ?? '', 'pinlbl', anchor);
      }
    }
    if (p.kind === 'IN' || p.kind === 'OUT') {
      g += p.kind === 'IN' ? text(p.x - 8, p.y + 4, 'IN', 'tl', 'end') : text(p.x + 8, p.y + 4, 'OUT', 'tl', 'start');
    } else if (p.kind === 'PROBE') {
      const [x, y] = toWorld(p, [24, -12]);
      if (p.ref) g += text(x, y, p.ref, 'pn probe-ref', 'start');
    } else if (p.kind === 'LABEL' || p.kind === 'SUPPLY') {
      const name = p.props?.name || (p.kind === 'SUPPLY' ? `${p.value ?? 9}V` : '?');
      if (p.kind === 'SUPPLY') { const [x, y] = toWorld(p, [0, -14]); g += text(x, y, name, 'pn', 'middle'); }
      else {
        // Name on top of the label's line (beside it when the line is vertical).
        const [mx, my] = toWorld(p, [labelLen(p) / 2, 0]);
        g += p.rot === 0 || p.rot === 180 ? text(mx, my - 5, name, 'pn', 'middle') : text(mx + 6, my + 4, name, 'pn', 'start');
      }
    } else if (view && view !== 'triangle') {
      // 8-pin package: ref and model centred above (or below) the body.
      const cs = [[bx0, by0], [bx1, by1]].map(c => toWorld(p, c as Pt));
      const cx = (cs[0][0] + cs[1][0]) / 2, top = Math.min(cs[0][1], cs[1][1]), bottom = Math.max(cs[0][1], cs[1][1]);
      const below = p.labelSide === 'b', val = spec.valueText!(p);
      if (p.ref) g += text(cx, below ? bottom + 14 : top - (val ? 19 : 6), p.ref, 'pn', 'middle');
      if (val) g += text(cx, below ? bottom + 27 : top - 6, val, 'pv', 'middle');
    } else if (p.kind === 'OA') {
      // Op-amps: ref and model just above (or below) the triangle, right of centre.
      const below = p.labelSide === 'b', val = spec.valueText!(p);
      if (p.ref) g += text(p.x + 8, p.y + (below ? 38 : -32), p.ref, 'pn', 'start');
      if (val) g += text(p.x + 8, p.y + (below ? 51 : -19), val, 'pv', 'start');
    } else if (p.ref || spec.valueText) {
      const side = labelSide(p), L = LABEL_POS[side], pad = spec.labelPad || 0;
      const dx = L.dx + (side === 'r' ? pad : side === 'l' ? -pad : 0), dy = side === 't' ? -pad : side === 'b' ? pad : 0;
      const val = spec.valueText ? spec.valueText(p) : '';
      if (p.ref) g += text(p.x + dx, p.y + L.dy1 + dy, p.ref, 'pn', L.anchor);
      if (val) g += text(p.x + dx, p.y + dy + (p.ref ? L.dy2 : L.dy1 + 7), val, 'pv', L.anchor);
    }
    const cls = `comp${hl.has(p.id) ? ' hl' : ''}${sel.has(p.id) ? ' sel' : ''}`;
    const title = p.ref ? `<title>${esc(p.ref)}${spec.valueText ? ': ' + esc(spec.valueText(p)) : ''}</title>` : '';
    const style = p.kind === 'PROBE' ? ` style="--probe:${probeColor(p.ref)}"` : '';
    out.push(`<g class="${cls}" data-id="${esc(p.id)}"${p.ref ? ` data-part="${esc(p.ref)}"` : ''}${style}>${title}${g}</g>`);
  }

  // Junction dots: points where three or more conductors meet.
  const ptsAt = new Map<string, { at: Pt; n: number }>();
  const bump = (at: Pt, by: number) => { const k = key(at); const e = ptsAt.get(k) || { at, n: 0 }; e.n += by; ptsAt.set(k, e); };
  for (const p of sch.parts) {
    if (p.kind === 'IN' || p.kind === 'OUT' || p.kind === 'PROBE') continue;
    for (const pin of partPins(p)) bump(toWorld(p, pin.at), 1);
  }
  for (const w of sch.wires) if (w.pts.length > 1) { bump(w.pts[0], 1); bump(w.pts[w.pts.length - 1], 1); }
  const candidates = [...ptsAt.values()].map(e => e.at);
  for (const w of sch.wires) {
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      for (const q of candidates) {
        const isEnd = (q[0] === w.pts[0][0] && q[1] === w.pts[0][1]) || (q[0] === w.pts[w.pts.length - 1][0] && q[1] === w.pts[w.pts.length - 1][1]);
        const isCorner = w.pts.slice(1, -1).some(c => c[0] === q[0] && c[1] === q[1]);
        if (isEnd) continue;
        // Interior points: count twice (the wire continues both ways); corners once per segment.
        if (onSegment(q, a, b) && !(q[0] === a[0] && q[1] === a[1]) && !(q[0] === b[0] && q[1] === b[1])) bump(q, 2);
        else if (isCorner && q[0] === b[0] && q[1] === b[1]) bump(q, 2);
      }
    }
  }
  for (const { at, n } of ptsAt.values()) if (n >= 3) out.push(`<circle class="dot" cx="${at[0]}" cy="${at[1]}" r="2.7"/>`);

  // Notes: one line per line of text, or wrapped to the note's width.
  for (const n of sch.notes || []) {
    const anchor = n.anchor || 'middle', lines = noteLines(n);
    const t = lines.map((s, i) => text(n.x, n.y + i * NOTE_LINE, s, 'tiny', anchor)).join('');
    if (!opt.editor) { out.push(t); continue; }
    // In the editor a note is an object: selectable, with a generous hit area around its text, and
    // (when selected) a handle on the side away from its alignment to drag its width.
    const { x0, w } = noteBox(n, lines), h = (lines.length - 1) * NOTE_LINE + 14;
    const cls = `note${sel.has(n.id) ? ' sel' : ''}${hl.has(n.id) ? ' hl' : ''}`;
    const hx = anchor === 'end' ? x0 - 3 : x0 + w + 3;
    const handle = sel.has(n.id) ? `<rect class="note-handle" data-note-handle="${esc(n.id)}" x="${hx - 3}" y="${n.y - 10 + h / 2 - 6}" width="6" height="12" rx="1.5"><title>Drag to set the width: the text wraps to fit</title></rect>` : '';
    out.push(`<g class="${cls}" data-note="${esc(n.id)}"><rect class="note-hit" x="${x0 - 3}" y="${n.y - 10}" width="${w + 6}" height="${h}" rx="2"/>${t}${handle}</g>`);
  }

  if (!isFinite(bounds.x0)) { bounds.x0 = 0; bounds.y0 = 0; bounds.x1 = 100; bounds.y1 = 60; }
  return { body: out.join(''), bounds, textBoxes };
}
