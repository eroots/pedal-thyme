// Pedalboard: an ordered set of pedals (open Builder tabs), each switched on or off, between a source
// (guitar) and a load (amp). The signal only runs through the pedals that are on; the others are true
// bypass. A board file lists its pedals' schematic files (plus a copy of each, used only when a file
// can't be found), so the schematics stay separate files.
import { termActive, type Term } from '../core/termination';
import type { Netlist } from '../engine/netlist';
import { parseProject, type Project } from './files';

export interface BoardPedal { tab: string; on: boolean }

export interface Board {
  name: string;
  pedals: BoardPedal[];
  /** Source and load presets (keys of SRC_PRESETS / LOAD_PRESETS, or 'ideal' / 'none'). */
  src: string;
  load: string;
  dirty: boolean;
}

export const emptyBoard = (): Board => ({ name: '', pedals: [], src: 'single', load: 'amp', dirty: false });

type Preset = { R?: number; L?: number; C?: number };

/** The board's source and load as a termination (null if both are ideal). */
export function boardTerm(b: Pick<Board, 'src' | 'load'>, srcPresets: Record<string, Preset>, loadPresets: Record<string, Preset>): Term | null {
  const s = srcPresets[b.src], l = loadPresets[b.load];
  const t: Term = {
    src: s?.R !== undefined ? { on: true, preset: b.src, R: s.R, L: s.L ?? 0, C: s.C ?? 0 } : { on: false, preset: 'single', R: 6e3, L: 2.5, C: 470e-12 },
    load: l?.R !== undefined ? { on: true, preset: b.load, R: l.R, C: l.C ?? 0 } : { on: false, preset: 'pedal', R: 1e6, C: 0 },
  };
  return termActive(t) ? t : null;
}

/** With every pedal off: a straight wire from guitar to amp. */
export const BYPASS: Netlist = { input: 'in', output: 'in', elements: [{ type: 'R', name: 'Rleak', a: 'in', b: '0', value: 1e9 }] };

/* ---------- Session (the board in use survives reloads) ---------- */
const LS_KEY = 'pedal-filter-lab.board.v1';

export function loadBoardSession(): Board {
  try {
    const b = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (b && Array.isArray(b.pedals)) {
      return {
        name: String(b.name ?? ''), src: String(b.src ?? 'single'), load: String(b.load ?? 'amp'), dirty: !!b.dirty,
        pedals: b.pedals.filter((p: BoardPedal) => p && typeof p.tab === 'string').map((p: BoardPedal) => ({ tab: p.tab, on: p.on !== false })),
      };
    }
  } catch { /* ignore */ }
  return emptyBoard();
}

export function saveBoardSession(b: Board): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(b)); } catch { /* ignore */ }
}

/* ---------- Board files ---------- */
export const BOARD_KIND = 'pedal-filter-lab-board';
export const BOARD_EXT = '.pfl-board.json';

export interface BoardFile {
  kind: typeof BOARD_KIND;
  version: 1;
  name: string;
  saved: string;
  src: string;
  load: string;
  pedals: {
    /** Display name. */
    name: string;
    /** Schematic file name (in the same folder as the board), if the pedal was saved to one. */
    file: string | null;
    on: boolean;
    /** A copy of the schematic, used when the file isn't found. */
    project: Project;
  }[];
}

export function makeBoardFile(b: Pick<Board, 'name' | 'src' | 'load'>, pedals: BoardFile['pedals']): BoardFile {
  return { kind: BOARD_KIND, version: 1, name: b.name || 'Untitled board', saved: new Date().toISOString(), src: b.src, load: b.load, pedals };
}

/** Is this file's text a pedalboard (rather than a single schematic)? */
export function isBoardText(text: string): boolean {
  try { return JSON.parse(text)?.kind === BOARD_KIND; } catch { return false; }
}

/** Parse a board file. Throws a readable error. */
export function parseBoard(text: string): BoardFile {
  let d: Partial<BoardFile>;
  try { d = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (d.kind !== BOARD_KIND || !Array.isArray(d.pedals)) throw new Error('This file isn’t a pedalboard.');
  const pedals = d.pedals.map((p, i) => {
    if (!p || typeof p !== 'object' || !p.project) throw new Error(`Pedal ${i + 1} in the board is incomplete.`);
    const project = parseProject(JSON.stringify(p.project));
    return { name: String(p.name || project.name), file: typeof p.file === 'string' && p.file ? p.file : null, on: p.on !== false, project };
  });
  return { kind: BOARD_KIND, version: 1, name: String(d.name ?? ''), saved: String(d.saved ?? ''), src: String(d.src ?? 'single'), load: String(d.load ?? 'amp'), pedals };
}
