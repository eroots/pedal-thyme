// Render a schematic to an SVG string. Symbols are drawn in local coordinates under a transform;
// text (refs, values, op-amp signs, jack names) is placed in world coordinates so it stays upright.
import { dirToWorld, key, onSegment, svgTransform, toWorld, type Pt } from './geometry';
import { PARTS } from './library';
import type { LabelSide, SchPart, Schematic } from './types';

export interface RenderOptions {
  /** Accessible name for the drawing. */
  title?: string;
  /** Part ids to highlight (e.g. ERC findings, selection). */
  highlight?: string[];
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
  const out: string[] = [];
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = ([x, y]: Pt, padX = 0, padY = 0) => {
    bounds.x0 = Math.min(bounds.x0, x - padX); bounds.x1 = Math.max(bounds.x1, x + padX);
    bounds.y0 = Math.min(bounds.y0, y - padY); bounds.y1 = Math.max(bounds.y1, y + padY);
  };
  const text = (x: number, y: number, s: string, cls: string, anchor = 'middle') => {
    // Rough text extent for the viewBox (≈ 6.5 units per character at 11px).
    const w = s.length * 6.5;
    grow([anchor === 'start' ? x + w : anchor === 'end' ? x - w : x + w / 2, y - 10]);
    grow([anchor === 'start' ? x : anchor === 'end' ? x : x - w / 2, y + 3]);
    return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(s)}</text>`;
  };
  const hl = new Set(opt.highlight || []);

  // Wires.
  for (const w of sch.wires) {
    out.push(`<polyline class="wire" data-wire="${esc(w.id)}" points="${w.pts.map(p => p.join(',')).join(' ')}"/>`);
    w.pts.forEach(p => grow(p));
  }

  // Parts.
  for (const p of sch.parts) {
    const spec = PARTS[p.kind];
    const [bx0, by0, bx1, by1] = spec.box;
    for (const c of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]] as Pt[]) grow(toWorld(p, c));
    let g = `<g transform="${svgTransform(p)}">${spec.draw(p)}</g>`;
    // Upright text.
    if (p.kind === 'OA') {
      for (const [sign, at] of [['−', [-31, -20]], ['+', [-31, 20]]] as [string, Pt][]) {
        const [x, y] = toWorld(p, at);
        g += text(x + (p.rot === 180 ? -2 : 2), y + 4, sign, 'sign', 'middle');
      }
    }
    if (p.kind === 'IN' || p.kind === 'OUT') {
      g += p.kind === 'IN' ? text(p.x - 8, p.y + 4, 'IN', 'tl', 'end') : text(p.x + 8, p.y + 4, 'OUT', 'tl', 'start');
    } else if (p.kind === 'LABEL' || p.kind === 'SUPPLY') {
      const name = p.props?.name || (p.kind === 'SUPPLY' ? `${p.value ?? 9}V` : '?');
      if (p.kind === 'SUPPLY') { const [x, y] = toWorld(p, [0, -14]); g += text(x, y, name, 'pn', 'middle'); }
      else { const [x, y] = toWorld(p, [9, 4]); g += text(x, y, name, 'pn', 'start'); }
    } else if (p.kind === 'OA') {
      // Op-amps: ref and model just above (or below) the triangle, right of centre.
      const below = p.labelSide === 'b', val = spec.valueText!(p);
      if (p.ref) g += text(p.x + 12, p.y + (below ? 52 : -46), p.ref, 'pn', 'start');
      if (val) g += text(p.x + 12, p.y + (below ? 65 : -33), val, 'pv', 'start');
    } else if (p.ref || spec.valueText) {
      const side = labelSide(p), L = LABEL_POS[side], pad = spec.labelPad || 0;
      const dx = L.dx + (side === 'r' ? pad : side === 'l' ? -pad : 0), dy = side === 't' ? -pad : side === 'b' ? pad : 0;
      const val = spec.valueText ? spec.valueText(p) : '';
      if (p.ref) g += text(p.x + dx, p.y + L.dy1 + dy, p.ref, 'pn', L.anchor);
      if (val) g += text(p.x + dx, p.y + dy + (p.ref ? L.dy2 : L.dy1 + 7), val, 'pv', L.anchor);
    }
    const cls = `comp${hl.has(p.id) ? ' hl' : ''}`;
    const title = p.ref ? `<title>${esc(p.ref)}${spec.valueText ? ': ' + esc(spec.valueText(p)) : ''}</title>` : '';
    out.push(`<g class="${cls}" data-id="${esc(p.id)}"${p.ref ? ` data-part="${esc(p.ref)}"` : ''}>${title}${g}</g>`);
  }

  // Junction dots: points where three or more conductors meet.
  const ptsAt = new Map<string, { at: Pt; n: number }>();
  const bump = (at: Pt, by: number) => { const k = key(at); const e = ptsAt.get(k) || { at, n: 0 }; e.n += by; ptsAt.set(k, e); };
  for (const p of sch.parts) {
    if (p.kind === 'IN' || p.kind === 'OUT') continue;
    for (const pin of PARTS[p.kind].pins) bump(toWorld(p, pin.at), 1);
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

  // Notes.
  for (const n of sch.notes || []) out.push(text(n.x, n.y, n.text, 'tiny', n.anchor || 'middle'));

  if (!isFinite(bounds.x0)) { bounds.x0 = 0; bounds.y0 = 0; bounds.x1 = 100; bounds.y1 = 60; }
  const pad = 12;
  const vb = [bounds.x0 - pad, bounds.y0 - pad, bounds.x1 - bounds.x0 + 2 * pad, bounds.y1 - bounds.y0 + 2 * pad].map(n => Math.round(n));
  return `<svg viewBox="${vb.join(' ')}" class="schem" role="img" aria-label="${esc(opt.title || 'Schematic')}">${out.join('')}</svg>`;
}
