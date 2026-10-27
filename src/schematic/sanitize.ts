// Schematics from outside the app (opened files, pedalboards, the saved session) are rebuilt field by
// field with checked types before use: unknown fields are dropped, numbers must be finite numbers and
// settings must be one of their allowed values. The drawing puts some of these into SVG attributes, so
// a file must not be able to smuggle markup (or script) in through a field that should be a number.
import { PARTS } from './library';
import type { LabelSide, PartProps, Rot, SchNote, SchPart, SchWire, Schematic } from './types';

const ROTS: Rot[] = [0, 90, 180, 270];
const SIDES: LabelSide[] = ['t', 'b', 'l', 'r'];
const TAPER_KEYS = ['A', 'B', 'C', 'W'] as const;
const ANCHORS = ['start', 'middle', 'end'] as const;

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error(`${what} is not a number.`);
  return v;
};
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
/** Drop undefined fields (so a rebuilt object looks like one the app made). */
const tidy = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function props(p: unknown): PartProps | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const q = p as Record<string, unknown>, turn = optNum(q.turn);
  const out = tidy<PartProps>({
    taper: oneOf(q.taper, TAPER_KEYS), turn: turn === undefined ? undefined : Math.min(1, Math.max(0, turn)),
    model: optStr(q.model), closed: optBool(q.closed), pos: oneOf(q.pos, ['a', 'b', 'off'] as const),
    name: optStr(q.name), knob: optStr(q.knob)?.slice(0, 40) || undefined, reverse: optBool(q.reverse), sweep: optBool(q.sweep), gang: optStr(q.gang), ib: optNum(q.ib), pins: q.pins === 'all' ? 'all' : undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

function part(p: unknown, i: number): SchPart {
  const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  if (typeof q.id !== 'string' || typeof q.kind !== 'string' || !(q.kind in PARTS)) {
    throw new Error(`Unrecognised part in file: ${JSON.stringify(p)?.slice(0, 80)}`);
  }
  return tidy<SchPart>({
    id: q.id, kind: q.kind as SchPart['kind'], ref: optStr(q.ref),
    x: num(q.x, `Part ${i + 1}'s position`), y: num(q.y, `Part ${i + 1}'s position`),
    rot: oneOf(q.rot, ROTS) ?? 0, mirror: optBool(q.mirror), value: optNum(q.value),
    props: props(q.props), labelSide: oneOf(q.labelSide, SIDES),
  });
}

function wire(w: unknown): SchWire {
  const q = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
  if (typeof q.id !== 'string' || !Array.isArray(q.pts)) throw new Error('A wire in the file is malformed.');
  const pts = q.pts.map(pt => {
    if (!Array.isArray(pt) || pt.length !== 2) throw new Error('A wire in the file is malformed.');
    return [num(pt[0], 'A wire point'), num(pt[1], 'A wire point')] as [number, number];
  });
  return { id: q.id, pts };
}

function note(n: unknown): SchNote {
  const q = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
  if (typeof q.id !== 'string') throw new Error('A text note in the file is malformed.');
  return tidy<SchNote>({ id: q.id, x: num(q.x, 'A text note position'), y: num(q.y, 'A text note position'), text: String(q.text ?? ''), anchor: oneOf(q.anchor, ANCHORS), width: (optNum(q.width) ?? 0) > 0 ? optNum(q.width) : undefined });
}

/** A schematic rebuilt from untrusted data. Throws a readable error if it isn't one. */
export function sanitizeSchematic(d: unknown): Schematic {
  const q = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  if (!Array.isArray(q.parts) || !Array.isArray(q.wires)) throw new Error('This file doesn’t contain a pedal schematic.');
  const notes = Array.isArray(q.notes) ? q.notes.map(note) : undefined;
  return { version: 1, parts: q.parts.map(part), wires: q.wires.map(wire), ...(notes?.length ? { notes } : {}) };
}
