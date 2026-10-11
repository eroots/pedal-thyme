// Pure document operations for the Pedal Builder. Every function returns a new Schematic (or
// derived data) and never mutates its input, so undo/redo can keep snapshots.
import { pinsOf } from '../schematic/extract';
import { key, onSegment, samePt, type Pt } from '../schematic/geometry';
import { boxOf } from '../schematic/library';
import type { PartKind, PartProps, Rot, SchNote, SchPart, SchWire, Schematic } from '../schematic/types';
import { routeOrtho } from './route';

export const GRID = 10;
export const snap = (v: number): number => Math.round(v / GRID) * GRID;
export const snapPt = ([x, y]: Pt): Pt => [snap(x), snap(y)];

interface PartDefault { prefix?: string; value?: number; props?: PartProps }
export const PART_DEFAULTS: Record<PartKind, PartDefault> = {
  R: { prefix: 'R', value: 10e3 },
  C: { prefix: 'C', value: 100e-9 },
  L: { prefix: 'L', value: 100e-3 },
  POT: { prefix: 'VR', value: 100e3, props: { taper: 'B', turn: 0.5 } },
  RHEO: { prefix: 'VR', value: 100e3, props: { taper: 'B', turn: 0.5 } },
  D: { prefix: 'D', props: { model: '1N4148' } },
  LED: { prefix: 'LED', props: { model: 'LED_RED' } },
  NPN: { prefix: 'Q', props: { model: '2N3904' } },
  PNP: { prefix: 'Q', props: { model: '2N3906' } },
  NJF: { prefix: 'Q', props: { model: 'J201' } },
  PJF: { prefix: 'Q', props: { model: '2N5460' } },
  NMOS: { prefix: 'Q', props: { model: '2N7000' } },
  PMOS: { prefix: 'Q', props: { model: 'BS250' } },
  SW: { prefix: 'SW', props: { closed: true } },
  SPDT: { prefix: 'SW', props: { pos: 'a' } },
  ONOFFON: { prefix: 'SW', props: { pos: 'a' } },
  OA: { prefix: 'U', props: { model: 'TL072' } },
  BUF: { prefix: 'B' },
  GND: {},
  SUPPLY: { value: 9, props: { name: '9V' } },
  LABEL: { props: { name: 'VREF' } },
  IN: {},
  OUT: {},
  PROBE: { prefix: 'P' },
};

export const emptyDoc = (): Schematic => ({
  version: 1,
  parts: [
    { id: 'in', kind: 'IN', x: 0, y: 0, rot: 0 },
    { id: 'out', kind: 'OUT', x: 1000, y: 0, rot: 0 },
  ],
  wires: [],
});

const clone = (d: Schematic): Schematic => JSON.parse(JSON.stringify(d));

/** Smallest unused "<prefix>N". */
export function nextRef(doc: Schematic, prefix: string, taken: Set<string> = new Set()): string {
  const used = new Set([...doc.parts.map(p => p.ref).filter(Boolean) as string[], ...taken]);
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/** Unique id with a prefix (ids are internal; refs are what users see). */
export function nextId(doc: Schematic, prefix: string, taken: Set<string> = new Set()): string {
  const used = new Set([...doc.parts.map(p => p.id), ...doc.wires.map(w => w.id), ...(doc.notes ?? []).map(n => n.id), ...taken]);
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/** A new part of `kind` with default value/props and the next free ref (not yet added). */
export function makePart(doc: Schematic, kind: PartKind, x: number, y: number, rot: Rot = 0, mirror = false): SchPart {
  const d = PART_DEFAULTS[kind];
  const p: SchPart = { id: nextId(doc, kind.toLowerCase()), kind, x: snap(x), y: snap(y), rot };
  if (d.prefix) p.ref = nextRef(doc, d.prefix);
  if (d.value !== undefined) p.value = d.value;
  if (d.props) p.props = { ...d.props };
  if (mirror) p.mirror = true;
  return p;
}

export function addPart(doc: Schematic, p: SchPart): Schematic {
  return { ...doc, parts: [...doc.parts, p] };
}

/** Remove duplicate and collinear interior points; drop zero-length wires. */
export function simplifyWire(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || !samePt(out[out.length - 1], p)) out.push(p);
  for (let i = 1; i < out.length - 1;) {
    if (onSegment(out[i], out[i - 1], out[i + 1])) out.splice(i, 1); else i++;
  }
  return out;
}

export function addWire(doc: Schematic, pts: Pt[]): Schematic {
  const clean = simplifyWire(pts);
  if (clean.length < 2) return doc;
  return { ...doc, wires: [...doc.wires, { id: nextId(doc, 'w'), pts: clean }] };
}

/**
 * Would this route touch anything it isn't meant to? A route may only connect at its two ends:
 * pins or other wires' points on its segments, or its corners landing on other wires, would create
 * accidental connections (the pin-on-wire rule).
 */
function routeClashes(parts: SchPart[], wires: SchWire[], pts: Pt[], selfId?: string): boolean {
  const a = pts[0], z = pts[pts.length - 1];
  const segs = pts.slice(1).map((b, i) => [pts[i], b] as [Pt, Pt]);
  const inside = (q: Pt) => !samePt(q, a) && !samePt(q, z) && segs.some(([p, r]) => onSegment(q, p, r));
  for (const part of parts) for (const r of pinsOf(part)) if (inside(r.at)) return true;
  for (const w of wires) {
    if (w.id === selfId) continue;
    if (w.pts.some(inside)) return true;
    for (const c of pts.slice(1, -1)) if (w.pts.slice(1).some((b, i) => onSegment(c, w.pts[i], b))) return true;
  }
  return false;
}

/** Does any segment of this route pass through a part's symbol (not just touch its edge at a pin)? */
function crossesBodies(parts: SchPart[], pts: Pt[]): boolean {
  for (const p of parts) {
    if (FOLLOWERS.has(p.kind) || p.kind === 'IN' || p.kind === 'OUT') continue;
    const [x0, y0, x1, y1] = partBox(p);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const sx0 = Math.min(a[0], b[0]), sx1 = Math.max(a[0], b[0]), sy0 = Math.min(a[1], b[1]), sy1 = Math.max(a[1], b[1]);
      if (sx1 > x0 + 3 && sx0 < x1 - 3 && sy1 > y0 + 3 && sy0 < y1 - 3) return true;
    }
  }
  return false;
}

/** Outward direction of the (non-marker) part pin at `at`, along the pin's main axis from the part's origin. */
function pinDir(parts: SchPart[], at: Pt): Pt | null {
  for (const p of parts) {
    if (FOLLOWERS.has(p.kind) || p.kind === 'IN' || p.kind === 'OUT') continue;
    const r = pinsOf(p).find(q => samePt(q.at, at));
    if (!r) continue;
    const dx = r.at[0] - p.x, dy = r.at[1] - p.y;
    if (dx === 0 && dy === 0) return null;
    return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
  }
  return null;
}

/** Orthogonal ways to move one end of a wire to `to`, best first. */
function endRoutes(pts: Pt[], atStart: boolean, to: Pt): Pt[][] {
  const P = atStart ? [...pts].reverse() : [...pts]; // the moving end is last
  const n = P.length, from = P[n - 1], nb = P[n - 2];
  const out: Pt[][] = [];
  const horiz = from[1] === nb[1], vert = from[0] === nb[0];
  if (n > 2 && horiz !== vert) {
    // Slide the neighbouring vertex so the last segment keeps its direction.
    const Q = P.map(p => [p[0], p[1]] as Pt);
    Q[n - 2] = horiz ? [nb[0], nb[1] + to[1] - from[1]] : [nb[0] + to[0] - from[0], nb[1]];
    Q[n - 1] = to;
    out.push(Q);
  }
  if (n === 2) {
    const f = P[0];
    out.push([f, [to[0], f[1]], to], [f, [f[0], to[1]], to]);
  }
  // Extend from the old end with an elbow.
  out.push([...P, [to[0], from[1]], to], [...P, [from[0], to[1]], to]);
  return out.map(Q => simplifyWire(atStart ? Q.reverse() : Q));
}

/**
 * Keep wires attached when pins move: unselected wire ends sitting on an old pin position follow it,
 * along the first orthogonal route that doesn't touch anything new.
 */
export function reattach(wires: SchWire[], moved: Map<string, Pt>, skip: Set<string>, parts: SchPart[]): SchWire[] {
  return wires.map(w => {
    if (skip.has(w.id) || w.pts.length < 2) return w;
    const last = w.pts.length - 1;
    const to0 = moved.get(key(w.pts[0])), to1 = moved.get(key(w.pts[last]));
    if (!to0 && !to1) return w;
    if (to0 && to1 && to0[0] - w.pts[0][0] === to1[0] - w.pts[last][0] && to0[1] - w.pts[0][1] === to1[1] - w.pts[last][1]) {
      const dx = to0[0] - w.pts[0][0], dy = to0[1] - w.pts[0][1];
      return { ...w, pts: w.pts.map(([x, y]) => [x + dx, y + dy] as Pt) };
    }
    let pts = w.pts;
    const fix = (atStart: boolean, to: Pt) => {
      const good = (c: Pt[]) => !routeClashes(parts, wires, c, w.id) && !crossesBodies(parts, c);
      const cands = endRoutes(pts, atStart, to);
      const ok = cands.find(good);
      if (ok) return ok;
      // Approach the pin from outside its symbol: route to a point just beyond it, then straight in.
      const dir = pinDir(parts, to);
      if (dir) {
        const a: Pt = [to[0] + dir[0] * 10, to[1] + dir[1] * 10];
        const via = endRoutes(pts, atStart, a).map(c => simplifyWire(atStart ? [to, ...c] : [...c, to]));
        const ok2 = via.find(good);
        if (ok2) return ok2;
      }
      // Then a routed path (kept only if it stays out of symbols), then any clash-free route.
      const end = atStart ? pts[0] : pts[pts.length - 1];
      const r = routeOrtho(end, to, parts, wires, new Set([w.id]));
      const routed = r && simplifyWire(atStart ? [...r.reverse(), ...pts.slice(1)] : [...pts.slice(0, -1), ...r]);
      if (routed && !crossesBodies(parts, routed)) return routed;
      return cands.find(c => !routeClashes(parts, wires, c, w.id)) ?? routed ?? cands[0];
    };
    if (to0 && to1 && pts.length === 2) {
      // Both ends of a straight wire move: route afresh between the new ends (approaching each pin from
      // outside its symbol), rather than one end at a time through an awkward halfway state.
      const good = (c: Pt[]) => !routeClashes(parts, wires, c, w.id) && !crossesBodies(parts, c);
      const ell = (a: Pt, b: Pt): Pt[][] => (a[0] === b[0] || a[1] === b[1] ? [[a, b]] : [[a, [b[0], a[1]], b], [a, [a[0], b[1]], b]]);
      const out = (p: Pt) => { const d = pinDir(parts, p); return d ? [p[0] + d[0] * 10, p[1] + d[1] * 10] as Pt : p; };
      const a0 = out(to0), a1 = out(to1);
      const cands = [...ell(to0, to1), ...ell(a0, a1).map(r => [to0, ...r, to1])].map(simplifyWire);
      const ok = cands.find(good);
      const r = ok ? null : routeOrtho(to0, to1, parts, wires, new Set([w.id]));
      const pick = ok ?? (r && !crossesBodies(parts, r) ? simplifyWire(r) : null) ?? cands.find(c => !routeClashes(parts, wires, c, w.id)) ?? cands[0];
      return { ...w, pts: pick };
    }
    if (to0) pts = fix(true, to0);
    // Moving the first end may collapse a short wire onto its other end; keep it as a point to route from.
    if (to1) { if (pts.length < 2) pts = [pts[0], pts[0]]; pts = fix(false, to1); }
    return { ...w, pts };
  }).filter(w => w.pts.length >= 2);
}

/** World pin positions of the given parts, keyed for lookup. */
const pinMap = (parts: SchPart[]) => new Map(parts.flatMap(p => pinsOf(p).map(r => [`${p.id}:${r.pin}`, r.at] as [string, Pt])));

/**
 * Split wires wherever a pin or another wire's end taps into their middle, so every connection to a
 * wire is at one of its ends. Connectivity is unchanged, but re-routing one piece can no longer
 * detach a tap elsewhere on the same wire. Wires in `keep` (e.g. selected, moving rigidly) are left whole.
 */
export function splitAtTaps(doc: Schematic, keep: Set<string> = new Set()): { doc: Schematic; ids: Map<string, string[]> } {
  const taps: Pt[] = [...doc.parts.flatMap(p => pinsOf(p).map(r => r.at)), ...doc.wires.flatMap(w => [w.pts[0], w.pts[w.pts.length - 1]])];
  const ids = new Map<string, string[]>(), taken = new Set<string>();
  const wires: SchWire[] = [];
  for (const w of doc.wires) {
    if (keep.has(w.id)) { wires.push(w); continue; }
    // Walk the polyline, cutting at interior points that carry a tap.
    const pieces: Pt[][] = [[w.pts[0]]];
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      const cuts = taps.filter(t => onSegment(t, a, b) && !samePt(t, a) && !samePt(t, b))
        .sort((p, q) => Math.hypot(p[0] - a[0], p[1] - a[1]) - Math.hypot(q[0] - a[0], q[1] - a[1]));
      const uniq = cuts.filter((c, k) => k === 0 || !samePt(c, cuts[k - 1]));
      for (const c of uniq) { pieces[pieces.length - 1].push(c); pieces.push([c]); }
      // A vertex (corner) that carries a tap is also a cut point.
      const isLast = i === w.pts.length - 1;
      pieces[pieces.length - 1].push(b);
      if (!isLast && taps.some(t => samePt(t, b))) pieces.push([b]);
    }
    if (pieces.length === 1) { wires.push(w); continue; }
    const out: string[] = [];
    pieces.forEach((pts, k) => {
      const id = k === 0 ? w.id : nextId(doc, 'w', taken);
      taken.add(id);
      out.push(id);
      wires.push({ id, pts });
    });
    ids.set(w.id, out);
  }
  return { doc: { ...doc, wires }, ids };
}

/**
 * A part dropped onto a wire is inserted into it, as in LTspice: wherever the gap between two of one
 * part's pins (in a straight line) is fully covered by wire, that wire (under the part) is removed.
 * Without this the wire would short the part out, since a pin on a wire connects to it. The covering
 * may be several wires, e.g. two meeting at a junction under the part's body.
 */
export function cutWiresUnder(doc: Schematic, partIds: Set<string>): Schematic {
  let wires = doc.wires;
  for (const part of doc.parts.filter(p => partIds.has(p.id))) {
    const pins = pinsOf(part).map(r => r.at);
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const p = pins[i], q = pins[j];
        const k = Math.abs(p[1] - q[1]) < 1e-6 ? 0 : Math.abs(p[0] - q[0]) < 1e-6 ? 1 : null;
        if (k === null || samePt(p, q)) continue; // only straight horizontal / vertical gaps
        const gap: Gap = { k, c: p[1 - k], lo: Math.min(p[k], q[k]), hi: Math.max(p[k], q[k]) };
        if (gapCovered(wires, gap)) wires = removeGap(doc, wires, gap);
      }
    }
  }
  return wires === doc.wires ? doc : { ...doc, wires };
}

/** The stretch lo..hi along axis k (0 = x, 1 = y) of the line where the other coordinate is c. */
interface Gap { k: 0 | 1; c: number; lo: number; hi: number }

const onGapLine = (g: Gap, a: Pt, b: Pt) => Math.abs(a[1 - g.k] - g.c) < 1e-6 && Math.abs(b[1 - g.k] - g.c) < 1e-6;

/** Is the whole gap covered by wire segments lying on its line? */
function gapCovered(wires: SchWire[], g: Gap): boolean {
  const spans: [number, number][] = [];
  for (const w of wires) {
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      if (onGapLine(g, a, b)) spans.push([Math.min(a[g.k], b[g.k]), Math.max(a[g.k], b[g.k])]);
    }
  }
  spans.sort((s, t) => s[0] - t[0]);
  let reach = g.lo;
  for (const [s, e] of spans) {
    if (s > reach + 1e-6) break;
    reach = Math.max(reach, e);
    if (reach >= g.hi - 1e-6) return true;
  }
  return false;
}

/** Remove the wire lying inside the gap, splitting wires that run through it. */
function removeGap(doc: Schematic, wires: SchWire[], g: Gap): SchWire[] {
  const ends: Pt[] = [g.lo, g.hi].map(v => (g.k === 0 ? [v, g.c] : [g.c, v]) as Pt);
  const inGap = (a: Pt, b: Pt) => {
    const m = (a[g.k] + b[g.k]) / 2;
    return onGapLine(g, a, b) && m > g.lo + 1e-6 && m < g.hi - 1e-6;
  };
  const out: SchWire[] = [];
  for (const w of wires) {
    // Split each segment at the gap's ends, then drop the pieces inside the gap.
    const pieces: Pt[][] = [];
    let cur: Pt[] = [w.pts[0]], cut = false;
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      const d = (q: Pt) => Math.hypot(q[0] - a[0], q[1] - a[1]);
      const stops = ends.filter(q => onSegment(q, a, b) && !samePt(q, a) && !samePt(q, b)).sort((p, q) => d(p) - d(q));
      let s = a;
      for (const e of [...stops, b]) {
        if (inGap(s, e)) { cut = true; pieces.push(cur); cur = [e]; } else cur.push(e);
        s = e;
      }
    }
    pieces.push(cur);
    if (!cut) { out.push(w); continue; }
    let first = true;
    for (const pts of pieces.map(simplifyWire).filter(pts => pts.length >= 2)) {
      out.push({ id: first ? w.id : nextId({ ...doc, wires: [...wires, ...out] }, 'w'), pts });
      first = false;
    }
  }
  return out;
}

/** Single-pin markers that should travel with whatever they sit on. */
const FOLLOWERS = new Set(['GND', 'SUPPLY', 'LABEL', 'PROBE']);

/**
 * Apply a transform to selected parts (and selected wire points), keeping connections:
 * wire ends on moved pins follow them; ground/supply/label markers sitting directly on a moved pin
 * travel with it; any other part touching a moved pin pin-to-pin gets a short connecting wire.
 */
function transformSelection(doc0: Schematic, partIds: Set<string>, wireIds: Set<string>,
  partFn: (p: SchPart) => SchPart, ptFn: (p: Pt) => Pt, stretch = true): Schematic {
  if (!stretch) {
    // Move: only the selection moves; everything else (wires, markers) stays where it is.
    return {
      ...doc0,
      parts: doc0.parts.map(p => (partIds.has(p.id) ? partFn({ ...p }) : p)),
      wires: doc0.wires.map(w => (wireIds.has(w.id) ? { ...w, pts: w.pts.map(ptFn) } : w)),
    };
  }
  const doc = splitAtTaps(doc0, wireIds).doc;
  // Probes always move on their own: their pins never drag wires (they only observe a net).
  const pulls = (p: SchPart) => partIds.has(p.id) && p.kind !== 'PROBE';
  const before = pinMap(doc.parts.filter(pulls));
  let parts = doc.parts.map(p => (partIds.has(p.id) ? partFn({ ...p }) : p));
  const after = pinMap(parts.filter(pulls));
  const moved = new Map<string, Pt>();
  for (const [k, at] of before) { const to = after.get(k)!; if (!samePt(at, to)) moved.set(key(at), to); }
  // Markers sitting on moved pins travel with them; other pin-to-pin contacts are noted for a new wire.
  const contacts: [Pt, Pt][] = [];
  parts = parts.map(p => {
    if (partIds.has(p.id)) return p;
    for (const r of pinsOf(p)) {
      const to = moved.get(key(r.at));
      if (!to) continue;
      if (FOLLOWERS.has(p.kind)) return { ...p, x: p.x + to[0] - r.at[0], y: p.y + to[1] - r.at[1] };
      contacts.push([r.at, to]);
    }
    return p;
  });

  let wires = doc.wires.map(w => (wireIds.has(w.id) ? { ...w, pts: w.pts.map(ptFn) } : w));
  wires = reattach(wires, moved, wireIds, parts);

  const extra = contacts.map(([from, to]) => {
    const cands: Pt[][] = from[0] === to[0] || from[1] === to[1] ? [[from, to]] : [[from, [to[0], from[1]], to], [from, [from[0], to[1]], to]];
    return cands.find(c => !routeClashes(parts, wires, c)) ?? routeOrtho(from, to, parts, wires) ?? cands[0];
  });
  let out: Schematic = { ...doc, parts, wires };
  for (const pts of extra) out = addWire(out, pts);
  return out;
}

/**
 * Translate the selection. `stretch` (default) keeps connections: attached wires stretch and markers
 * follow. With stretch = false the selection detaches and moves on its own.
 */
export function moveSelection(doc: Schematic, partIds: Set<string>, wireIds: Set<string>, dx: number, dy: number, stretch = true): Schematic {
  if (!dx && !dy) return doc;
  return transformSelection(doc, partIds, wireIds, p => ({ ...p, x: p.x + dx, y: p.y + dy }), ([x, y]) => [x + dx, y + dy], stretch);
}

/** Rotate 90° clockwise: a lone part turns in place; a group turns about its (grid-snapped) centre. */
export function rotateSelection(doc: Schematic, partIds: Set<string>, wireIds: Set<string>, stretch = true): Schematic {
  const parts = doc.parts.filter(p => partIds.has(p.id)), wires = doc.wires.filter(w => wireIds.has(w.id));
  if (!parts.length && !wires.length) return doc;
  const pts: Pt[] = [...parts.map(p => [p.x, p.y] as Pt), ...wires.flatMap(w => w.pts)];
  const cx = parts.length === 1 && !wires.length ? parts[0].x : snap((Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[0]))) / 2);
  const cy = parts.length === 1 && !wires.length ? parts[0].y : snap((Math.min(...pts.map(p => p[1])) + Math.max(...pts.map(p => p[1]))) / 2);
  const rot = ([x, y]: Pt): Pt => [cx - (y - cy), cy + (x - cx)];
  return transformSelection(doc, partIds, wireIds, p => {
    const [x, y] = rot([p.x, p.y]);
    return { ...p, x, y, rot: ((p.rot + 90) % 360) as Rot };
  }, rot, stretch);
}

/** Flip parts across their own horizontal axis (e.g. swap an op-amp's + and − inputs). */
export function mirrorParts(doc: Schematic, partIds: Set<string>, stretch = true): Schematic {
  return transformSelection(doc, partIds, new Set(), p => ({ ...p, mirror: !p.mirror || undefined }), p => p, stretch);
}

export function deleteSelection(doc: Schematic, partIds: Set<string>, wireIds: Set<string>, noteIds: Set<string> = new Set()): Schematic {
  const out: Schematic = { ...doc, parts: doc.parts.filter(p => !partIds.has(p.id)), wires: doc.wires.filter(w => !wireIds.has(w.id)) };
  if (doc.notes && noteIds.size) out.notes = doc.notes.filter(n => !noteIds.has(n.id));
  return partIds.size ? tidyGangs(out) : out;
}

/* ---------- Text notes ---------- */
/** Add a text note (left-aligned at x, y); returns the new note's id. */
export function addNote(doc: Schematic, x: number, y: number, text = 'Text'): { doc: Schematic; id: string } {
  const id = nextId(doc, 'note');
  return { doc: { ...doc, notes: [...(doc.notes ?? []), { id, x: snap(x), y: snap(y), text, anchor: 'start' }] }, id };
}

export function moveNotes(doc: Schematic, ids: Set<string>, dx: number, dy: number): Schematic {
  if (!ids.size || !doc.notes) return doc;
  return { ...doc, notes: doc.notes.map(n => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) };
}

export function updateNote(doc: Schematic, id: string, patch: Partial<SchNote>): Schematic {
  return { ...doc, notes: (doc.notes ?? []).map(n => (n.id === id ? { ...n, ...patch } : n)) };
}

/** Distance from point p to segment a–b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Index of the segment of `w` nearest to point `p`. */
export function nearestSegment(w: SchWire, p: Pt): number {
  let best = 0, bd = Infinity;
  for (let i = 1; i < w.pts.length; i++) {
    const d = segDist(p, w.pts[i - 1], w.pts[i]);
    if (d < bd) { bd = d; best = i - 1; }
  }
  return best;
}

/** The stretch of wire `wireId` nearest `p`, bounded by corners and taps (what delete mode removes). */
export function wireSegmentAt(doc: Schematic, wireId: string, p: Pt): [Pt, Pt] | null {
  const split = splitAtTaps(doc);
  const pieces = (split.ids.get(wireId) ?? [wireId]).map(id => split.doc.wires.find(x => x.id === id)!).filter(Boolean);
  let best: [Pt, Pt] | null = null, bd = Infinity;
  for (const w of pieces) {
    const i = nearestSegment(w, p), seg: [Pt, Pt] = [w.pts[i], w.pts[i + 1]], d = segDist(p, ...seg);
    if (d < bd) { bd = d; best = seg; }
  }
  return best;
}

/**
 * Delete one segment of a wire (the one nearest `p`), keeping the pieces on either side. Taps
 * (pins or wire ends touching the middle of a wire) count as segment boundaries, as in LTspice.
 */
export function deleteWireSegment(doc0: Schematic, wireId: string, p: Pt): Schematic {
  const split = splitAtTaps(doc0), doc = split.doc;
  const pieces = (split.ids.get(wireId) ?? [wireId]).map(id => doc.wires.find(x => x.id === id)!).filter(Boolean);
  const dist = (x: SchWire) => { const i = nearestSegment(x, p), [a, b] = [x.pts[i], x.pts[i + 1]]; return segDist(p, a, b); };
  const w = pieces.sort((a, b) => dist(a) - dist(b))[0];
  if (!w) return doc0;
  const i = nearestSegment(w, p);
  const before = w.pts.slice(0, i + 1), after = w.pts.slice(i + 1);
  const wires = doc.wires.filter(x => x.id !== w.id);
  if (before.length >= 2) wires.push({ id: w.id, pts: before });
  if (after.length >= 2) wires.push({ id: nextId(doc, 'w'), pts: after });
  return { ...doc, wires };
}

export function updatePart(doc: Schematic, id: string, patch: Partial<SchPart>): Schematic {
  // Turning one pot of a gang turns them all (one shaft).
  const gang = patch.props?.turn !== undefined ? doc.parts.find(p => p.id === id)?.props?.gang : undefined;
  return {
    ...doc, parts: doc.parts.map(p => {
      if (p.id === id) return { ...p, ...patch, props: patch.props ? { ...p.props, ...patch.props } : p.props };
      if (gang && p.props?.gang === gang) return { ...p, props: { ...p.props, turn: patch.props!.turn } };
      return p;
    }),
  };
}

/* ---------- Ganged pots (dual-gang: several pots or variable resistors on one shaft) ---------- */
export const GANGABLE = ['POT', 'RHEO'];
/** Pots in the same gang as `id` (including it), or just it. */
export const gangOf = (doc: Schematic, id: string): SchPart[] => {
  const p = doc.parts.find(q => q.id === id), g = p?.props?.gang;
  return g ? doc.parts.filter(q => q.props?.gang === g) : p ? [p] : [];
};
const withoutGang = (p: SchPart): SchPart => { const { gang: _, ...props } = p.props ?? {}; return { ...p, props }; };
/** Drop gangs that have only one pot left (after deleting or copying). */
export function tidyGangs(doc: Schematic): Schematic {
  const count = new Map<string, number>();
  for (const p of doc.parts) if (p.props?.gang) count.set(p.props.gang, (count.get(p.props.gang) ?? 0) + 1);
  if (![...count.values()].some(n => n < 2)) return doc;
  return { ...doc, parts: doc.parts.map(p => (p.props?.gang && count.get(p.props.gang)! < 2 ? withoutGang(p) : p)) };
}
/** The next unused gang name: A, B, … Z, then G27… */
export function nextGang(doc: Schematic, also: Set<string> = new Set()): string {
  const used = new Set([...doc.parts.map(p => p.props?.gang).filter(Boolean) as string[], ...also]);
  for (let i = 0; ; i++) { const g = i < 26 ? String.fromCharCode(65 + i) : `G${i + 1}`; if (!used.has(g)) return g; }
}
/**
 * Put pot `id` on the same shaft as `withId` (joining its gang, or starting one), or take it off its
 * shaft (`withId` null). Joining sets its rotation to the gang's.
 */
export function setGang(doc: Schematic, id: string, withId: string | null): Schematic {
  const me = doc.parts.find(p => p.id === id);
  if (!me) return doc;
  if (!withId) return tidyGangs({ ...doc, parts: doc.parts.map(p => (p.id === id ? withoutGang(p) : p)) });
  const other = doc.parts.find(p => p.id === withId);
  if (!other || other.id === id) return doc;
  const g = other.props?.gang ?? nextGang(doc);
  const turn = other.props?.turn ?? 0.5;
  return tidyGangs({
    ...doc, parts: doc.parts.map(p => (p.id === id ? { ...p, props: { ...p.props, gang: g, turn } } : p.id === withId ? { ...p, props: { ...p.props, gang: g } } : p)),
  });
}

/* ---------- Clipboard ---------- */
export interface Clip { parts: SchPart[]; wires: SchWire[]; notes?: SchNote[] }

export function copySelection(doc: Schematic, partIds: Set<string>, wireIds: Set<string>, noteIds: Set<string> = new Set()): Clip {
  const c = clone(doc);
  return { parts: c.parts.filter(p => partIds.has(p.id)), wires: c.wires.filter(w => wireIds.has(w.id)), notes: (c.notes ?? []).filter(n => noteIds.has(n.id)) };
}

/** Paste with an offset; refs that clash are renumbered. Returns the new doc and the pasted ids. */
export function paste(doc: Schematic, clip: Clip, dx: number, dy: number): { doc: Schematic; ids: Set<string> } {
  const ids = new Set<string>(), refs = new Set<string>();
  const parts = clip.parts.map(p => {
    const id = nextId(doc, p.kind.toLowerCase(), ids);
    ids.add(id);
    let ref = p.ref;
    const prefix = PART_DEFAULTS[p.kind].prefix;
    if (ref && prefix && (doc.parts.some(q => q.ref === ref) || refs.has(ref))) ref = nextRef(doc, prefix, refs);
    if (ref) refs.add(ref);
    // Only one input and one output jack make sense; skip duplicates.
    return { ...JSON.parse(JSON.stringify(p)), id, ref, x: p.x + dx, y: p.y + dy } as SchPart;
  }).filter(p => !((p.kind === 'IN' || p.kind === 'OUT') && doc.parts.some(q => q.kind === p.kind)));
  // Copied gangs become new gangs (a pot copied without its partner then has none: see tidyGangs).
  const gangMap = new Map<string, string>(), newGangs = new Set<string>();
  for (const p of parts) {
    const g = p.props?.gang;
    if (!g) continue;
    if (!gangMap.has(g)) { const n = nextGang(doc, newGangs); gangMap.set(g, n); newGangs.add(n); }
    p.props = { ...p.props, gang: gangMap.get(g) };
  }
  const wires = clip.wires.map(w => {
    const id = nextId(doc, 'w', ids);
    ids.add(id);
    return { id, pts: w.pts.map(([x, y]) => [x + dx, y + dy] as Pt) };
  });
  const notes = (clip.notes ?? []).map(n => {
    const id = nextId(doc, 'note', ids);
    ids.add(id);
    return { ...n, id, x: n.x + dx, y: n.y + dy };
  });
  const out: Schematic = { ...doc, parts: [...doc.parts, ...parts], wires: [...doc.wires, ...wires] };
  if (notes.length) out.notes = [...(doc.notes ?? []), ...notes];
  return { doc: tidyGangs(out), ids };
}

/* ---------- Hit testing helpers ---------- */
export interface Anchor { at: Pt; kind: 'pin' | 'vertex' | 'wire' }

/**
 * Nearest connection point to `p` within `radius`: a pin, a wire vertex, or the closest point on a
 * wire segment (snapped to the grid). Used to make wiring "stick" to things.
 */
export function nearestAnchor(doc: Schematic, p: Pt, radius: number): Anchor | null {
  let best: Anchor | null = null, bd = radius;
  const consider = (at: Pt, kind: Anchor['kind']) => {
    const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (d <= bd) { bd = d; best = { at, kind }; }
  };
  for (const part of doc.parts) for (const r of pinsOf(part)) consider(r.at, 'pin');
  if (best) return best;
  for (const w of doc.wires) w.pts.forEach(v => consider(v, 'vertex'));
  if (best) return best;
  for (const w of doc.wires) {
    for (let i = 1; i < w.pts.length; i++) {
      const g = snapPt(p);
      if (onSegment(g, w.pts[i - 1], w.pts[i])) consider(g, 'wire');
    }
  }
  return best;
}

/** True when a wire drawn to `at` would end on something (pin, wire, or vertex). */
export const isConnection = (doc: Schematic, at: Pt): boolean =>
  doc.parts.some(part => pinsOf(part).some(r => samePt(r.at, at))) ||
  doc.wires.some(w => w.pts.slice(1).some((b, i) => onSegment(at, w.pts[i], b)));

/** World-space bounding box of a part's symbol. */
export function partBox(p: SchPart): [number, number, number, number] {
  const [x0, y0, x1, y1] = boxOf(p);
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as Pt[];
  const ws = corners.map(([lx, ly]) => {
    const yy = p.mirror ? -ly : ly;
    switch (p.rot) {
      case 90: return [p.x - yy, p.y + lx];
      case 180: return [p.x - lx, p.y - yy];
      case 270: return [p.x + yy, p.y - lx];
      default: return [p.x + lx, p.y + yy];
    }
  });
  return [Math.min(...ws.map(c => c[0])), Math.min(...ws.map(c => c[1])), Math.max(...ws.map(c => c[0])), Math.max(...ws.map(c => c[1]))];
}
