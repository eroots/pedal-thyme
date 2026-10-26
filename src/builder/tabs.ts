// Builder tabs: several schematics open at once. Each tab keeps its own drawing, view, undo history,
// file, name, unsaved state, simulation settings, trace picture and sound render. The session (all
// open tabs) survives reloads: drawings and settings in localStorage, trace pictures and file handles
// (too big, or not storable as JSON) in IndexedDB, keyed by tab id.
import type { Schematic } from '../schematic/types';
import { emptyDoc } from './doc';
import { sanitizeSchematic } from '../schematic/sanitize';
import type { EditorState, View } from './editor';
import type { ProjectSim } from './files';
import type { SoundState } from './sound';
import type { Trace } from './trace';

export interface Tab {
  id: string;
  name: string;
  dirty: boolean;
  state: EditorState;
  sim: ProjectSim;
  /** Tab whose response is overlaid on this tab's plot ('' for none). */
  compare: string;
  /** Tab whose output feeds this tab's input, chaining the pedals ('' = the normal source). */
  input: string;
  /** undefined until restored from IndexedDB. */
  trace?: Trace | null;
  file?: FileSystemFileHandle | null;
  sound?: SoundState | null;
  /** Zoom to fit when first shown (no saved view). */
  needsFit?: boolean;
  /** Carried over from the pre-tabs single-document storage. */
  legacy?: boolean;
}

export interface Session { active: string; tabs: Tab[] }

const SESSION_KEY = 'pedal-filter-lab.builder.tabs.v1';
/** Pre-tabs storage: one document and its name. */
const LEGACY_DOC_KEY = 'pedal-filter-lab.builder.v1';
const LEGACY_NAME_KEY = 'pedal-filter-lab.builder.name';
export const DEFAULT_VIEW: View = { x: -60, y: -150, zoom: 1.4 };

export const traceKey = (id: string) => `tab-trace:${id}`;
export const fileKey = (id: string) => `tab-file:${id}`;

let counter = 0;
export const newTabId = (): string => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newTab(sim: ProjectSim, doc: Schematic = emptyDoc()): Tab {
  return {
    id: newTabId(), name: '', dirty: false, compare: '', input: '', trace: null, file: null, sound: null, needsFit: true,
    state: { doc, view: { ...DEFAULT_VIEW }, undo: [], redo: [] },
    // A new tab keeps the source/load setup but starts without a sweep.
    sim: { ...JSON.parse(JSON.stringify(sim)), sweep: '', sweep2: '' },
  };
}

const isDoc = (d: unknown): d is Schematic => !!d && Array.isArray((d as Schematic).parts) && Array.isArray((d as Schematic).wires);

/** Open tabs from the last session, or one tab carried over from the pre-tabs storage. */
export function loadSession(defaultSim: ProjectSim): Session {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && Array.isArray(s.tabs)) {
      // Rebuilt with checked types, like an opened file (a schematic opened earlier may have been hostile).
      const safe = (d: unknown) => { try { return sanitizeSchematic(d); } catch { return null; } };
      const tabs: Tab[] = s.tabs.filter((t: { doc?: unknown }) => safe(t.doc)).map((t: Record<string, unknown>) => ({
        id: String(t.id || newTabId()), name: String(t.name ?? ''), dirty: !!t.dirty, compare: String(t.compare ?? ''), input: String(t.input ?? ''),
        state: { doc: safe(t.doc)!, view: (t.view as View) ?? { ...DEFAULT_VIEW }, undo: [], redo: [] },
        sim: (t.sim as ProjectSim) ?? defaultSim, needsFit: !t.view,
      }));
      if (tabs.length) return { active: tabs.some(t => t.id === s.active) ? s.active : tabs[0].id, tabs };
    }
  } catch { /* fall through */ }
  const tab = newTab(defaultSim);
  tab.legacy = true;
  tab.sim = defaultSim;
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_DOC_KEY) || 'null');
    if (old && isDoc(old.doc)) {
      tab.state.doc = sanitizeSchematic(old.doc);
      if (old.view) { tab.state.view = old.view; tab.needsFit = false; }
    }
    tab.name = localStorage.getItem(LEGACY_NAME_KEY) || '';
  } catch { /* ignore */ }
  return { active: tab.id, tabs: [tab] };
}

/** Store the open tabs (not their history, pictures or file handles). */
export function saveSession(s: Session): void {
  const data = {
    active: s.active,
    tabs: s.tabs.map(t => ({ id: t.id, name: t.name, dirty: t.dirty, compare: t.compare, input: t.input, doc: t.state.doc, view: t.state.view, sim: t.sim })),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    localStorage.removeItem(LEGACY_DOC_KEY);
    localStorage.removeItem(LEGACY_NAME_KEY);
  } catch { /* storage full or unavailable */ }
}

/**
 * The tabs feeding `tab`, first pedal first (following each one's input), or null if they loop or a
 * tab is missing.
 */
export function upstreamOf(tabs: Pick<Tab, 'id' | 'input'>[], tab: Pick<Tab, 'id' | 'input'>): Pick<Tab, 'id' | 'input'>[] | null {
  const chain: Pick<Tab, 'id' | 'input'>[] = [];
  const seen = new Set([tab.id]);
  for (let id = tab.input; id; ) {
    const t = tabs.find(x => x.id === id);
    if (!t || seen.has(id)) return null;
    seen.add(id);
    chain.unshift(t);
    id = t.input;
  }
  return chain;
}

/** A tab nobody has used yet (opening a file can take it over instead of adding a tab). */
export function isBlank(t: Pick<Tab, 'name' | 'dirty' | 'file' | 'state'>): boolean {
  const d = t.state.doc;
  return !t.dirty && !t.file && !t.name && !d.wires.length && !(d.notes ?? []).length && d.parts.every(p => p.kind === 'IN' || p.kind === 'OUT');
}

export const tabTitle = (t: Pick<Tab, 'name'>): string => t.name.trim() || 'Untitled';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The tab strip: one button per tab (name, unsaved dot, close ×) and + for a new tab. */
export function renderStrip(el: HTMLElement, tabs: Pick<Tab, 'id' | 'name' | 'dirty'>[], active: string): void {
  el.innerHTML = tabs.map((t, i) => {
    const title = tabTitle(t);
    return `<div class="b-tab${t.id === active ? ' active' : ''}${t.dirty ? ' dirty' : ''}" role="tab" aria-selected="${t.id === active}" data-tab="${esc(t.id)}" title="${esc(title)}${t.dirty ? ' (unsaved changes)' : ''}${i < 9 ? ` · Alt+${i + 1}` : ''}">` +
      `<span class="b-tab-name">${esc(title)}</span><span class="b-tab-dot" aria-hidden="true"></span>` +
      `<button class="b-tab-close" data-close="${esc(t.id)}" aria-label="Close ${esc(title)}" title="Close">×</button></div>`;
  }).join('') + '<button class="b-tab-new" id="bTabNew" title="New tab (empty schematic)" aria-label="New tab">+</button>';
}
