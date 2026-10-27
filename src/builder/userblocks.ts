// The user's own blocks: pieces of schematic saved from a selection, kept in the browser's own storage
// (like amp captures) and listed under Blocks ▾. A block can be exported as a .pfl-block.json file to
// share or back up, and imported again; a saved pedal (.pfl.json) can be imported as a block too, and
// Open reads a block file as a pedal (to edit it, then select all and save it as a block again).
import { sanitizeSchematic } from '../schematic/sanitize';
import { snapPt, type Clip } from './doc';
import { BLOCK_KIND, parseProject } from './files';
import { idbGet, idbSet } from './folder';

export { BLOCK_KIND };

export interface UserBlock { id: string; name: string; description: string; clip: Clip }

const KEY = 'user-blocks';

export async function listUserBlocks(): Promise<UserBlock[]> {
  const list = await idbGet<UserBlock[]>(KEY);
  return Array.isArray(list) ? list : [];
}

/** A copy of the clip moved so its top-left grid point is at the origin (tidier files). */
export function normaliseClip(c: Clip): Clip {
  const xs = [...c.parts.map(p => p.x), ...c.wires.flatMap(w => w.pts.map(p => p[0])), ...(c.notes ?? []).map(n => n.x)];
  const ys = [...c.parts.map(p => p.y), ...c.wires.flatMap(w => w.pts.map(p => p[1])), ...(c.notes ?? []).map(n => n.y)];
  const [x0, y0] = xs.length ? snapPt([Math.min(...xs), Math.min(...ys)]) : [0, 0];
  return {
    parts: c.parts.map(p => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    wires: c.wires.map(w => ({ ...w, pts: w.pts.map(([x, y]) => [x - x0, y - y0] as [number, number]) })),
    notes: (c.notes ?? []).map(n => ({ ...n, x: n.x - x0, y: n.y - y0 })),
  };
}

/** Keep a block; one with the same name is replaced. Throws a readable error if the browser won't store it. */
export async function saveUserBlock(name: string, description: string, clip: Clip): Promise<UserBlock> {
  const list = await listUserBlocks();
  const same = list.find(b => b.name.toLowerCase() === name.toLowerCase());
  const block: UserBlock = { id: same?.id ?? `ub${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, description, clip: normaliseClip(clip) };
  await idbSet(KEY, same ? list.map(b => (b === same ? block : b)) : [...list, block]);
  // Storage can be unavailable (a private window; some browsers for a page opened from a file).
  if (!(await listUserBlocks()).some(b => b.id === block.id)) throw new Error('this browser won’t let the page keep it (storage is blocked, e.g. in a private window)');
  return block;
}

export async function removeUserBlock(id: string): Promise<void> {
  await idbSet(KEY, (await listUserBlocks()).filter(b => b.id !== id));
}

/** The block as a file (.pfl-block.json). */
export function blockFile(b: UserBlock): string {
  const { parts, wires, notes } = b.clip;
  return JSON.stringify({ kind: BLOCK_KIND, version: 1, name: b.name, description: b.description, schematic: { version: 1, parts, wires, ...(notes?.length ? { notes } : {}) } }, null, 2);
}

/** Read a block file, or a saved pedal (its whole schematic becomes the block). Throws a readable error. */
export function parseBlockFile(text: string, fileName: string): { name: string; description: string; clip: Clip } {
  let d: Record<string, unknown>;
  try { d = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const fallback = fileName.replace(/\.(pfl-block\.json|pfl\.json|json)$/i, '');
  // The schematic is rebuilt with checked types (a file is untrusted input).
  const s = d?.kind === BLOCK_KIND ? sanitizeSchematic(d.schematic) : parseProject(text).schematic;
  const name = d?.kind === BLOCK_KIND ? str(d.name, 80) : d?.kind ? str(d.name, 80) : '';
  if (!s.parts.length && !s.wires.length) throw new Error('This file has nothing in it to use as a block.');
  return { name: name.trim() || fallback, description: str(d?.description, 300), clip: { parts: s.parts, wires: s.wires, notes: s.notes ?? [] } };
}
