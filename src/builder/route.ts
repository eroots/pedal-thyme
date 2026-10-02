// Orthogonal wire router on the 10-unit grid (A*). Finds a path between two points that never makes
// an accidental connection: it doesn't pass through any pin or wire point, and never bends on top
// of an existing wire. Crossing wires straight through is allowed (crossings don't connect).
import { pinsOf } from '../schematic/extract';
import { key, onSegment, type Pt } from '../schematic/geometry';
import type { SchPart, SchWire } from '../schematic/types';

const G = 10;
const BEND = 4;      // cost of a bend, in grid steps
const OVERLAP = 30;  // cost of running along an existing wire (confusing to read)
const MARGIN = 12;   // search area around the endpoints, in grid steps

export function routeOrtho(from: Pt, to: Pt, parts: SchPart[], wires: SchWire[], ignoreWires: Set<string> = new Set()): Pt[] | null {
  const others = wires.filter(w => !ignoreWires.has(w.id));
  const blocked = new Set<string>();
  for (const p of parts) for (const r of pinsOf(p)) blocked.add(key(r.at));
  for (const w of others) for (const v of w.pts) blocked.add(key(v));
  blocked.delete(key(from)); blocked.delete(key(to));
  const segs = others.flatMap(w => w.pts.slice(1).map((b, i) => [w.pts[i], b] as [Pt, Pt]));
  const onWire = (q: Pt) => segs.some(([a, b]) => onSegment(q, a, b));
  const along = (q: Pt, dir: number) => segs.some(([a, b]) => onSegment(q, a, b) && ((dir < 2) === (a[1] === b[1])));

  const x0 = Math.min(from[0], to[0]) - MARGIN * G, x1 = Math.max(from[0], to[0]) + MARGIN * G;
  const y0 = Math.min(from[1], to[1]) - MARGIN * G, y1 = Math.max(from[1], to[1]) + MARGIN * G;
  const DIRS: Pt[] = [[G, 0], [-G, 0], [0, G], [0, -G]]; // 0,1 horizontal; 2,3 vertical
  const h = (p: Pt) => (Math.abs(p[0] - to[0]) + Math.abs(p[1] - to[1])) / G;

  // Binary heap of [f, g, x, y, dir].
  type Node = [number, number, number, number, number];
  const heap: Node[] = [];
  const push = (n: Node) => {
    heap.push(n);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): Node => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };

  const best = new Map<string, number>(), prev = new Map<string, string>();
  const sk = (x: number, y: number, d: number) => `${x},${y},${d}`;
  for (let d = 0; d < 4; d++) { best.set(sk(from[0], from[1], d), 0); push([h(from), 0, from[0], from[1], d]); }
  let goal: string | null = null;
  let guard = 0;
  while (heap.length && guard++ < 60000) {
    const [, g, x, y, d] = pop();
    const k = sk(x, y, d);
    if (g > (best.get(k) ?? Infinity)) continue;
    if (x === to[0] && y === to[1]) { goal = k; break; }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd ^ 1) === d && g > 0) continue; // no U-turns
      const bend = nd !== d && g > 0;
      if (bend && (onWire([x, y]) || blocked.has(key([x, y])))) continue; // never turn on a wire or a pin
      const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const np: Pt = [nx, ny];
      if (blocked.has(key(np))) continue;
      const ng = g + 1 + (bend ? BEND : 0) + (along(np, nd) ? OVERLAP : 0);
      const nk = sk(nx, ny, nd);
      if (ng < (best.get(nk) ?? Infinity)) { best.set(nk, ng); prev.set(nk, k); push([ng + h(np), ng, nx, ny, nd]); }
    }
  }
  if (!goal) return null;
  const path: Pt[] = [];
  for (let k: string | undefined = goal; k; k = prev.get(k)) {
    const [x, y] = k.split(',').map(Number);
    if (!path.length || path[path.length - 1][0] !== x || path[path.length - 1][1] !== y) path.push([x, y]);
  }
  return path.reverse();
}
