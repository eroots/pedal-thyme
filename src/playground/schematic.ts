// Hand-drawn schematic renderer for Playground topologies (replaced by the shared renderer in Phase 2).
import { fmtEng } from '../core/units';
import type { Opts, Values } from '../core/types';
import type { LabelSide, PartType, SchematicDrawer, Topology } from '../topologies/types';

type Pt = [number, number];

export function buildSchematic(t: Topology, v: Values, o: Opts): string {
  const out: string[] = [];
  const L = (x1: number, y1: number, x2: number, y2: number, cls = '') =>
    `<line${cls ? ` class="${cls}"` : ''} x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  const poly = (pts: Pt[]) => `<polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}"/>`;

  function part(type: PartType, k: string, x1: number, y1: number, x2: number, y2: number, side?: LabelSide) {
    const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len, px = -uy, py = ux;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, half = type === 'R' ? 16 : 3.5;
    const ax = mx - ux * half, ay = my - uy * half, bx = mx + ux * half, by = my + uy * half;
    let g = L(x1, y1, ax, ay) + L(bx, by, x2, y2);
    if (type === 'R') {
      const pts: Pt[] = [[ax, ay]];
      for (let i = 1; i < 6; i++) {
        const tt = -half + 2 * half * i / 6, sg = i % 2 ? 1 : -1;
        pts.push([mx + ux * tt + px * 6 * sg, my + uy * tt + py * 6 * sg]);
      }
      pts.push([bx, by]);
      g += poly(pts);
    } else {
      for (const [cx_, cy_] of [[ax, ay], [bx, by]]) g += L(cx_ - px * 11, cy_ - py * 11, cx_ + px * 11, cy_ + py * 11, 'plate');
    }
    const horiz = Math.abs(uy) < 0.5;
    const s: LabelSide = side || (horiz ? 't' : 'r');
    const pos: Record<LabelSide, [number, number, number, string]> = {
      t: [mx, my - 27, my - 14, 'middle'], b: [mx, my + 25, my + 38, 'middle'],
      r: [mx + 15, my - 3, my + 11, 'start'], l: [mx - 15, my - 3, my + 11, 'end'],
    };
    const [tx, ty1, ty2, anchor] = pos[s];
    const val = v[k] === 0 && type === 'C' ? 'omit' : fmtEng(v[k], type === 'R' ? 'Ω' : 'F');
    g += `<text class="pn" x="${tx}" y="${ty1}" text-anchor="${anchor}">${k}</text>`;
    g += `<text class="pv" x="${tx}" y="${ty2}" text-anchor="${anchor}">${val}</text>`;
    out.push(`<g class="comp" data-part="${k}"><title>${k}: ${val}</title>${g}</g>`);
  }

  const d: SchematicDrawer = {
    w: (...pts) => { out.push(poly(pts)); },
    dot: (x, y) => { out.push(`<circle class="dot" cx="${x}" cy="${y}" r="2.7"/>`); },
    gnd: (x, y) => { out.push(L(x, y, x, y + 6) + L(x - 10, y + 6, x + 10, y + 6) + L(x - 6, y + 10, x + 6, y + 10) + L(x - 2, y + 14, x + 2, y + 14)); },
    term: (x, y, label, side = 'l') => {
      out.push(`<circle class="term" cx="${x}" cy="${y}" r="3.5"/><text class="tl" x="${side === 'l' ? x - 8 : x + 8}" y="${y + 4}" text-anchor="${side === 'l' ? 'end' : 'start'}">${label}</text>`);
    },
    amp: (x, y, plusTop) => {
      out.push(`<polygon points="${x},${y - 32} ${x},${y + 32} ${x + 64},${y}"/>` +
        `<text class="sign" x="${x + 6}" y="${y - 11}">${plusTop ? '+' : '−'}</text><text class="sign" x="${x + 6}" y="${y + 21}">${plusTop ? '−' : '+'}</text>`);
    },
    arrow: (x1, y1, x2, y2) => {
      const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const bx = x2 - ux * 8, by = y2 - uy * 8;
      out.push(L(x1, y1, bx, by) + `<polygon class="head" points="${x2},${y2} ${(bx - uy * 4).toFixed(1)},${(by + ux * 4).toFixed(1)} ${(bx + uy * 4).toFixed(1)},${(by - ux * 4).toFixed(1)}"/>`);
    },
    note: (x, y, text, anchor = 'middle') => { out.push(`<text class="tiny" x="${x}" y="${y}" text-anchor="${anchor}">${text}</text>`); },
    buf: (x, y) => { out.push(`<polygon points="${x},${y - 11} ${x},${y + 11} ${x + 22},${y}"/><text class="tiny" x="${x}" y="${y - 15}">×1</text>`); },
    R: (k, x1, y1, x2, y2, side) => part('R', k, x1, y1, x2, y2, side),
    C: (k, x1, y1, x2, y2, side) => part('C', k, x1, y1, x2, y2, side),
    // Variable resistor (pot wired as a rheostat): resistor with a diagonal arrow through it.
    Rv: (k, x1, y1, x2, y2, side) => {
      part('R', k, x1, y1, x2, y2, side);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      d.arrow(mx - 13, my + 15, mx + 13, my - 15);
    },
  };
  t.sch(d, o);
  return `<svg viewBox="${t.vb}" class="schem" role="img" aria-label="Schematic of ${t.name}">${out.join('')}</svg>`;
}
