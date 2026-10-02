import type { SchPart } from './types';

export type Pt = [number, number];

/** Local part coordinates → world: mirror (flip y), rotate clockwise by rot, then translate. */
export function toWorld(p: Pick<SchPart, 'x' | 'y' | 'rot' | 'mirror'>, [lx, ly]: Pt): Pt {
  const y0 = p.mirror ? -ly : ly;
  let x = lx, y = y0;
  switch (p.rot) {
    case 90: [x, y] = [-y0, lx]; break;
    case 180: [x, y] = [-lx, -y0]; break;
    case 270: [x, y] = [y0, -lx]; break;
    default: break;
  }
  return [round(p.x + x), round(p.y + y)];
}

/** Direction vector (no translation) in world space. */
export function dirToWorld(p: Pick<SchPart, 'rot' | 'mirror'>, v: Pt): Pt {
  const [x, y] = toWorld({ x: 0, y: 0, rot: p.rot, mirror: p.mirror }, v);
  return [x, y];
}

/** SVG transform equivalent to toWorld. */
export const svgTransform = (p: Pick<SchPart, 'x' | 'y' | 'rot' | 'mirror'>): string =>
  `translate(${p.x} ${p.y})${p.rot ? ` rotate(${p.rot})` : ''}${p.mirror ? ' scale(1 -1)' : ''}`;

const round = (n: number) => Math.round(n * 1000) / 1000;
export const key = ([x, y]: Pt): string => `${x},${y}`;

/** Is point q on segment a–b (inclusive of the ends)? Works for any direction. */
export function onSegment(q: Pt, a: Pt, b: Pt): boolean {
  const cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  if (Math.abs(cross) > 1e-6) return false;
  return q[0] >= Math.min(a[0], b[0]) - 1e-6 && q[0] <= Math.max(a[0], b[0]) + 1e-6
    && q[1] >= Math.min(a[1], b[1]) - 1e-6 && q[1] <= Math.max(a[1], b[1]) + 1e-6;
}
export const samePt = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
