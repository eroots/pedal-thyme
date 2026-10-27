// Pedal Builder UI: palette, toolbar, properties and ERC list; wires up the simulation panel and front panel,
// and the tabs (several schematics open at once; see tabs.ts).
import { stepSeries } from '../core/eseries';
import { TAPERS, type TaperKey } from '../core/pots';
import { fmtEng, parseEng } from '../core/units';
import { dcOp, type DeviceOp, type OpPoint } from '../engine/dc';
import { DIODE_MODELS, OPAMP_MODELS, opAmpModel } from '../engine/models';
import { BJT_MODELS, JFET_MODELS, MOS_MODELS } from '../engine/semis';
import { extract, type Extraction } from '../schematic/extract';
import { PARTS, opAmpPinMap, opAmpView } from '../schematic/library';
import { onSegment, samePt, type Pt } from '../schematic/geometry';
import { renderSchematic, renderSchematicBody } from '../schematic/render';
import type { PartKind, SchNote, SchPart, Schematic } from '../schematic/types';
import { S } from '../playground/state';
import { canGang, gangOf, partBox, reshapePart, setGang, updateNote, updatePart } from './doc';
import { Editor, PART_KEYS, type DragMode, type Mode } from './editor';
import { initFileBar, type FileBar, type FileHost } from './filebar';
import { canWriteFolders, idbGet, idbSet } from './folder';
import { fileKey, isBlank, loadSession, newTab, renderStrip, saveSession, tabTitle, traceKey, upstreamOf, type Tab } from './tabs';
import { joinChain } from '../engine/chain';
import type { Upstream } from './simpanel';
import { initBoard, type BoardUi } from './boardui';
import { makeProject } from './files';
import type { DocHost } from './frontpanel';
import { initFrontPanel } from './frontpanel';
import { initSimPanel } from './simpanel';
import { initSoundPanel } from './sound';
import { termActive } from '../core/termination';
import { initTrace, takeLegacyTrace, type Trace } from './trace';
import { SWEEPABLE_KINDS, biasOf } from './sim';

/** Signed volts with two decimals (one above 10 V). */
const fmtVolts = (x: number): string => `${Math.abs(x) < 0.005 ? "0.00" : Math.abs(x) < 10 ? x.toFixed(2) : x.toFixed(1)} V`;
/** Prefix for the Builder's small UI preferences (drag mode, bias overlay). */
const LS_KEY = 'pedal-filter-lab.builder.v1';
const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PALETTE: { group: string; kinds: PartKind[] }[] = [
  { group: 'Passive', kinds: ['R', 'C', 'L'] },
  { group: 'Controls', kinds: ['POT', 'RHEO', 'SW', 'SPDT', 'ONOFFON'] },
  { group: 'Diodes', kinds: ['D', 'LED'] },
  { group: 'Transistors', kinds: ['NPN', 'PNP', 'NJF', 'PJF', 'NMOS', 'PMOS'] },
  { group: 'Active', kinds: ['OA', 'BUF'] },
  { group: 'Connections', kinds: ['IN', 'OUT', 'GND', 'SUPPLY', 'LABEL'] },
];

export interface BuilderApi {
  /** Replace the document (undoable) and fit it in view. */
  load(doc: Schematic): void;
  /** Called when the Builder section becomes visible (sizes the canvas). */
  shown(): void;
  /** Called when the Pedalboard section becomes visible. */
  boardShown(): void;
  /** Names of what has changes not saved to a file: tabs, and "the pedalboard". */
  unsaved(): string[];
}

export function initBuilder(nav: { showBoard(): void; showBuilder(): void }): BuilderApi {
  const sim = initSimPanel();
  const session = loadSession(sim.settings());
  const tabs: Tab[] = session.tabs;
  let active: Tab = tabs.find(t => t.id === session.active)!;
  /** Showing another tab (its state is being loaded, not edited). */
  let switching = false;
  /** Trace pictures and file handles are still being read back from IndexedDB. */
  let restoring = true;
  let ready = false;
  /** The Pedalboard section (set up once the Builder is). */
  let board: BoardUi | null = null;
  let ex: Extraction = extract(active.state.doc);

  const editor = new Editor(document.querySelector<SVGSVGElement>('#bCanvas')!, $('#bCanvasWrap'), active.state.doc, {
    change: (doc, committed) => {
      ex = extract(doc); renderErc(); sim.update(doc, ex, committed); panel.sync(doc); renderBias();
      if (committed && !switching) { sound.invalidate(); files.changed(); }
      if (committed) { persist(); renderProps(); }
      updateToolbar();
      board?.changed(active.id);
    },
    select: () => renderProps(),
    mode: (mode, kind) => renderModes(mode, kind),
    dragMode: m => renderDragMode(m),
    bias: () => toggleBias(),
    edit: () => {
      renderProps();
      // After the click that triggered this has finished (it may move focus to the canvas).
      setTimeout(() => {
        const inp = document.querySelector<HTMLInputElement>('#bProps [data-notefield="text"]') || document.querySelector<HTMLInputElement>('#bProps [data-field="value"]') || document.querySelector<HTMLInputElement>('#bProps [data-field="ref"]');
        inp?.focus(); inp?.select();
      }, 0);
    },
  });
  if (!active.needsFit) editor.setView(active.state.view);
  sim.setCompare(active.compare);
  sim.setChain(active.input);
  sim.apply(active.sim);
  const sound = initSoundPanel(() => {
    const up = sim.upstream();
    return { ex: simEx(), doc: editor.doc, term: sim.activeTerm(), name: (document.querySelector<HTMLInputElement>('#bName')?.value || ''), wrap: up && !up.error ? up.wrap : undefined };
  });
  const panel = initFrontPanel($('#bKnobs'), editor);
  const trace = initTrace(editor, msg => { if (msg) $('#bHint').textContent = msg; else renderModes(editor.mode, null); }, t => {
    active.trace = t;
    void idbSet(traceKey(active.id), t ?? undefined);
  });

  /* ---------- Tabs ---------- */
  const host: FileHost = {
    beforeOpen: async file => {
      // Already open? Show that tab instead of opening the file twice.
      if (file) {
        for (const t of tabs) {
          const f = t === active ? files.state().file : t.file;
          try { if (f && (await f.isSameEntry(file))) { switchTo(t); return false; } } catch { /* stale handle */ }
        }
      }
      syncActive();
      if (!isBlank({ ...active, file: active.file ?? null })) addTab();
      return true;
    },
    openBoard: async (text, handle) => {
      try { await board!.open(text, handle); } catch (err) { alert(`Couldn’t open the pedalboard: ${(err as Error).message}`); }
    },
    meta: () => {
      if (!ready) return;
      board?.changed();
      const f = files.state();
      if (!restoring && f.file !== (active.file ?? null)) { active.file = f.file; void idbSet(fileKey(active.id), f.file ?? undefined); }
      active.name = f.name; active.dirty = f.dirty;
      renderTabs();
      sim.refreshCompare();
      persistSoon();
    },
  };
  const files: FileBar = initFileBar(editor, sim, trace, host);
  files.setState({ name: active.name, file: null, dirty: active.dirty });

  /* ---------- Signal chain (a tab's input fed by another tab's output) ---------- */
  const exCache = new WeakMap<Schematic, Extraction>();
  const exOf = (d: Schematic): Extraction => { let x = exCache.get(d); if (!x) { x = extract(d); exCache.set(d, x); } return x; };
  const docOf = (t: Tab): Schematic => (t === active ? editor.doc : t.state.doc);
  const inputOf = (t: Tab): string => (t === active ? sim.chain() : t.input);
  const nameOf = (t: Tab): string => (t === active ? files.state().name.trim() || 'Untitled' : tabTitle(t));
  const hasErrors = (x: Extraction) => x.issues.some(i => i.severity === 'error');
  /** Tabs feeding `tab` if its input were `from` (first pedal first); null if that loops. */
  const feeding = (tab: Tab, from: string): Tab[] | null => {
    const view = tabs.map(t => ({ id: t.id, input: t === tab ? from : inputOf(t) }));
    const ids = upstreamOf(view, { id: tab.id, input: from });
    return ids && ids.map(v => tabs.find(t => t.id === v.id)!);
  };
  let chainMemo: { key: unknown[]; up: Upstream | null } | null = null;
  /** The pedals in front of `tab` when `from` feeds it (cached while nothing in the chain changes). */
  function upstreamFor(tab: Tab, from: string): Upstream | null {
    const chain = from ? feeding(tab, from) : null;
    if (!chain?.length) return null;
    const first = chain[0], src = (first === active ? sim.settings() : first.sim).term.src;
    const key = [tab, src, ...chain.flatMap(t => [docOf(t), nameOf(t)])];
    if (chainMemo && chainMemo.key.length === key.length && chainMemo.key.every((k, i) => k === key[i])) return chainMemo.up;
    const names = chain.map(nameOf);
    const bad = chain.find(t => hasErrors(exOf(docOf(t))));
    let up: Upstream;
    if (bad) up = { names, src, wrap: x => x, error: `${nameOf(bad)} (earlier in the signal chain) has errors, so the chain can't be simulated: see its Checks.` };
    else {
      const nets = chain.map(t => exOf(docOf(t)).netlist);
      const joined = new WeakMap<Extraction, Extraction>();
      up = {
        names, src,
        wrap: x => { let j = joined.get(x); if (!j) { j = { ...x, netlist: joinChain([...nets, x.netlist]) }; joined.set(x, j); } return j; },
      };
    }
    chainMemo = { key, up };
    return up;
  }
  /** The shown pedal as it simulates: with the pedals feeding it, if any. */
  function simEx(): Extraction {
    const up = sim.upstream();
    if (!up) return ex;
    if (up.error) return { ...ex, issues: [...ex.issues, { severity: 'error', message: up.error }] };
    return up.wrap(ex);
  }
  sim.setChainHost({
    // Any other tab, unless it is (or is fed by) this one.
    options: () => tabs.filter(t => t !== active && feeding(active, t.id) !== null).map(t => ({ id: t.id, name: nameOf(t) })),
    resolve: id => upstreamFor(active, id),
    changed: () => { active.input = sim.chain(); renderBias(); sound.invalidate(); renderTabs(); persist(); },
  });

  /** Copy the live (cheap) state of the shown tab into its record. */
  function syncActive(): void {
    const f = files.state();
    active.name = f.name; active.dirty = f.dirty;
    if (!restoring) active.file = f.file;
    active.state = { ...active.state, doc: editor.doc, view: editor.getView() };
    active.sim = sim.settings();
    active.compare = sim.compare();
    active.input = sim.chain();
  }
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function persist(): void {
    if (!ready) return;
    clearTimeout(persistTimer);
    syncActive();
    saveSession({ active: active.id, tabs });
  }
  const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 400); };

  function renderTabs(): void {
    const f = ready ? files.state() : active;
    renderStrip($('#bTabs'), tabs.map(t => (t === active ? { id: t.id, name: f.name, dirty: f.dirty } : t)), active.id);
  }

  /** Show another tab: park the current one's state and load the other's. */
  function switchTo(t: Tab): void {
    if (t === active) return;
    if (tabs.includes(active)) {
      syncActive();
      active.state = editor.snapshot();
      active.sound = sound.state();
      if (!restoring) active.trace = editor.trace;
    }
    active = t;
    switching = true;
    try {
      files.setState({ name: t.name, file: t.file ?? null, dirty: t.dirty });
      sim.setCompare(t.compare);
      sim.setChain(t.input);
      sim.apply(t.sim);
      trace.show(t.trace ?? null);
      sound.restore(t.sound ?? null);
      editor.restoreState(t.state);
    } finally {
      switching = false;
    }
    if (t.needsFit) { editor.fit(); t.needsFit = false; }
    renderTabs();
    persist();
  }

  /** A new tab with an empty schematic, next to the current one. */
  function addTab(): Tab {
    syncActive();
    const t = newTab(active.sim);
    tabs.splice(tabs.indexOf(active) + 1, 0, t);
    switchTo(t);
    return t;
  }

  function closeTab(t: Tab): void {
    if (t === active) syncActive();
    if (t.dirty && !confirm(`Close “${tabTitle(t)}”? Its unsaved changes will be lost.`)) return;
    void idbSet(traceKey(t.id), undefined);
    void idbSet(fileKey(t.id), undefined);
    const i = tabs.indexOf(t);
    if (tabs.length === 1) tabs.push(newTab(t.sim));
    tabs.splice(i, 1);
    for (const o of tabs) {
      if (o.compare === t.id) o.compare = '';
      if (o.input === t.id) o.input = '';
    }
    if (t !== active && sim.chain() === t.id) sim.setChain('');
    if (t === active) switchTo(tabs[Math.min(i, tabs.length - 1)]);
    else { renderTabs(); persist(); }
    sim.refreshCompare();
    board?.changed();
  }

  $('#bTabs').addEventListener('click', e => {
    const el = e.target as HTMLElement;
    const close = el.closest<HTMLElement>('[data-close]');
    if (close) { const t = tabs.find(x => x.id === close.dataset.close); if (t) closeTab(t); return; }
    if (el.closest('#bTabNew')) { addTab(); return; }
    const tab = el.closest<HTMLElement>('[data-tab]');
    const t = tab && tabs.find(x => x.id === tab.dataset.tab);
    if (t) switchTo(t);
  });
  // Middle-click closes a tab; double-click renames it (in the name field).
  $('#bTabs').addEventListener('auxclick', e => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    const t = e.button === 1 && tab && tabs.find(x => x.id === tab.dataset.tab);
    if (t) { e.preventDefault(); closeTab(t); }
  });
  $('#bTabs').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  $('#bTabs').addEventListener('dblclick', e => {
    const el = e.target as HTMLElement;
    if (!el.closest('[data-tab]') || el.closest('[data-close]')) return;
    const n = $('#bName'); n.focus(); n.select();
  });
  // Alt+1…9 shows that tab.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || $<HTMLElement>('#builder').hidden || !/^[1-9]$/.test(e.key)) return;
    const t = tabs[+e.key - 1];
    if (t) { e.preventDefault(); switchTo(t); }
  });

  sim.setCompareSource({
    list: () => tabs.filter(t => t !== active).map(t => ({ id: t.id, name: nameOf(t) })),
    get: id => {
      const t = tabs.find(x => x.id === id && x !== active);
      if (!t) return null;
      const name = nameOf(t), x = exOf(t.state.doc);
      if (hasErrors(x)) return { error: `${name} has errors (see its Checks), so it can't be compared.`, name };
      const up = upstreamFor(t, t.input);
      if (up?.error) return { error: up.error, name };
      const tt = up ? { src: up.src, load: t.sim.term.load } : t.sim.term;
      return { ex: up ? up.wrap(x) : x, term: termActive(tt) ? tt : null, name };
    },
  });

  // Trace pictures and file handles live in IndexedDB; the pre-tabs ones are carried over.
  void (async () => {
    for (const t of tabs) {
      if (t.legacy) {
        t.trace = takeLegacyTrace();
        t.file = canWriteFolders ? ((await idbGet<FileSystemFileHandle>('current')) ?? null) : null;
        if (t.trace) void idbSet(traceKey(t.id), t.trace);
        if (t.file) void idbSet(fileKey(t.id), t.file);
        void idbSet('current', undefined);
        delete t.legacy;
      } else {
        if (t.trace === undefined) t.trace = (await idbGet<Trace>(traceKey(t.id))) ?? null;
        if (t.file === undefined) t.file = (await idbGet<FileSystemFileHandle>(fileKey(t.id))) ?? null;
      }
    }
    restoring = false;
    trace.show(active.trace ?? null);
    files.setState({ ...files.state(), file: active.file ?? null });
  })();


  /* ---------- Palette & toolbar ---------- */
  $('#bPalette').innerHTML = PALETTE.map(g => `<div class="group">${g.group}</div><div class="pal-grid">${g.kinds.map(k => {
    const part: SchPart = { id: 'x', kind: k, x: 0, y: 0, rot: 0, props: k === 'POT' || k === 'RHEO' ? { turn: 0.5 } : k === 'SPDT' || k === 'ONOFFON' ? { pos: 'a' } : undefined };
    const hk = Object.entries(PART_KEYS).find(([, kind]) => kind === k)?.[0];
    return `<button class="pal" data-kind="${k}" title="${esc(PARTS[k].label)}${hk ? ` (${hk.toUpperCase()})` : ''}">${hk ? `<kbd>${hk.toUpperCase()}</kbd>` : ''}${renderSchematic({ version: 1, parts: [part], wires: [] }, { bare: true, title: PARTS[k].label })}<span>${esc(PARTS[k].label)}</span></button>`;
  }).join('')}</div>`).join('');
  $('#bPalette').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
    if (b) editor.setMode('place', b.dataset.kind as PartKind);
  });

  function renderModes(mode: Mode, kind: PartKind | null): void {
    document.querySelectorAll<HTMLElement>('#bPalette [data-kind]').forEach(b => b.classList.toggle('active', mode === 'place' && b.dataset.kind === kind));
    $('#bToolSelect').classList.toggle('active', mode === 'select');
    $('#bToolWire').classList.toggle('active', mode === 'wire');
    $('#bToolText').classList.toggle('active', mode === 'text');
    $('#bToolProbe').classList.toggle('active', mode === 'place' && kind === 'PROBE');
    $('#bDelete').classList.toggle('active', mode === 'delete');
    $('#bCopy').classList.toggle('active', mode === 'copy');
    $('#bHint').textContent = mode === 'delete'
      ? 'Delete mode: click a part or wire segment to delete it, or drag a box to delete everything inside. Esc or right-click to stop.'
      : mode === 'wire'
      ? 'Click to start a wire, click to bend it; it finishes on a pin or another wire (or double-click / right-click). Esc cancels.'
      : mode === 'copy' && editor.placingBlock ? 'Click where the block should go (its references are renumbered to fit this circuit), then wire it into the circuit (built-in blocks mark their “in” and “out” ends). Esc cancels.'
      : mode === 'copy' ? 'Copy mode: click a part, wire or note to pick up a copy, then click to drop it (as many times as you like). Right-click to pick something else, Esc to stop.'
      : mode === 'text' ? 'Click where the text note should go, then type it in Properties. Esc cancels.'
      : mode === 'place' ? `Click to place a ${PARTS[kind!].label.toLowerCase()}. Right-click or Ctrl+R rotates, Ctrl+E mirrors, Esc stops placing.`
        : 'Drag parts to stretch (wires follow) or move (detach): see the toolbar, or hold Alt to switch for one drag. Drag on empty space to box-select. Space+drag or middle-drag pans; wheel zooms.';
  }

  const actions: Record<string, () => void> = {
    bToolSelect: () => editor.setMode('select'),
    bToolWire: () => editor.setMode('wire'),
    bToolText: () => editor.setMode('text'),
    bToolProbe: () => editor.setMode('place', 'PROBE'),
    bDragStretch: () => editor.setDragMode('stretch'),
    bDragMove: () => editor.setDragMode('move'),
    bRotate: () => editor.rotate(),
    bMirror: () => editor.mirror(),
    bDelete: () => editor.deleteOrMode(),
    bCopy: () => editor.copyMode(),
    bUndo: () => editor.undo(),
    bRedo: () => editor.redo(),
    bFit: () => editor.fit(),
    bBias: () => toggleBias(),
  };
  for (const [id, fn] of Object.entries(actions)) $('#' + id).addEventListener('click', fn);
  function renderDragMode(m: DragMode): void {
    $('#bDragStretch').classList.toggle('active', m === 'stretch');
    $('#bDragMove').classList.toggle('active', m === 'move');
    try { localStorage.setItem(LS_KEY + '.drag', m); } catch { /* ignore */ }
  }

  function updateToolbar(): void {
    $<HTMLButtonElement>('#bUndo').disabled = !editor.canUndo();
    $<HTMLButtonElement>('#bRedo').disabled = !editor.canRedo();
  }

  /* ---------- Properties ---------- */
  function renderProps(): void {
    const el = $('#bProps'), sel = [...editor.sel];
    const parts = editor.doc.parts.filter(p => editor.sel.has(p.id)), wires = editor.doc.wires.filter(w => editor.sel.has(w.id));
    const notes = (editor.doc.notes ?? []).filter(n => editor.sel.has(n.id));
    if (notes.length === 1 && !parts.length && !wires.length) {
      const n = notes[0];
      const opt = (v: string, label: string) => `<option value="${v}" ${(n.anchor || 'middle') === v ? 'selected' : ''}>${label}</option>`;
      el.innerHTML = `<h2>Text note</h2>
        <label class="prop"><span>Text</span><textarea data-notefield="text" rows="3" spellcheck="true">${esc(n.text)}</textarea></label>
        <label class="prop"><span>Align</span><select data-notefield="anchor">${opt('start', 'Left')}${opt('middle', 'Centre')}${opt('end', 'Right')}</select></label>
        <label class="prop"><span>Width</span><input type="text" data-notefield="width" value="${n.width ?? ''}" placeholder="None (no wrapping)" spellcheck="false"></label>
        <p class="hint">Drag the text to move it, and the handle on its edge to make it wider or narrower: the text wraps to fit. Clear Width to stop wrapping. Enter starts a new line; Ctrl+Enter finishes. Notes don't affect the circuit.</p>
        <div class="btnrow"><button data-act="delete">Delete</button></div>`;
      el.dataset.id = n.id;
      return;
    }
    if (!sel.length) {
      el.innerHTML = `<h2>Properties</h2><p class="hint">Select a part to edit it, or pick one from the palette to place it.</p>
        <table class="keys"><tr><td>R C L D</td><td>Resistor, capacitor, inductor, diode</td></tr>
        <tr><td>G P O</td><td>Ground, pot, op-amp</td></tr>
        <tr><td>Q J</td><td>NPN transistor, N-channel JFET</td></tr>
        <tr><td>B</td><td>Show / hide DC bias voltages</td></tr>
        <tr><td>W</td><td>Wire tool</td></tr><tr><td>T</td><td>Text note</td></tr><tr><td>X</td><td>Probe (see a net on the Response plot)</td></tr><tr><td>V / Esc</td><td>Select tool</td></tr>
        <tr><td>S / M</td><td>Drag stretches / moves (Alt flips)</td></tr>
        <tr><td>Ctrl+R / Ctrl+E</td><td>Rotate / mirror</td></tr><tr><td>Del</td><td>Delete selection, or delete mode</td></tr>
        <tr><td>Ctrl+Z / Y</td><td>Undo / redo</td></tr><tr><td>Ctrl+C</td><td>Copy mode: click an item (or start with a selection), click to drop copies</td></tr><tr><td>Ctrl+V / D</td><td>Paste last copy / duplicate</td></tr>
        <tr><td>Arrows</td><td>Nudge</td></tr><tr><td>F</td><td>Fit to view</td></tr>
        <tr><td>Alt+1…9</td><td>Switch tab (middle-click closes one)</td></tr></table>`;
      return;
    }
    if (parts.length !== 1 || wires.length || notes.length) {
      const counts = [[parts.length, 'part'], [wires.length, 'wire'], [notes.length, 'note']].filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`);
      el.innerHTML = `<h2>Properties</h2><p>${counts.join(', ')} selected.</p>
        <div class="btnrow"><button data-act="rotate">Rotate</button><button data-act="delete">Delete</button></div>`;
      return;
    }
    const p = parts[0], spec = PARTS[p.kind];
    const row = (label: string, html: string) => `<label class="prop"><span>${label}</span>${html}</label>`;
    // Gang: another pot on the same shaft, or another pole of the same switch.
    const gangRow = (q: SchPart, label: string, title: string, none: string) => {
      const others = editor.doc.parts.filter(o => canGang(q, o)), mate = gangOf(editor.doc, q.id).find(o => o.id !== q.id);
      return others.length ? row(label, `<select data-field="gang" title="${esc(title)}"><option value="">${none}</option>${others.map(o => `<option value="${esc(o.id)}" ${mate?.id === o.id ? 'selected' : ''}>${esc(o.ref || o.id)}${o.props?.gang ? ` (${o.kind === 'POT' || o.kind === 'RHEO' ? 'gang' : 'linked'} ${esc(o.props.gang)})` : ''}</option>`).join('')}</select>`) : '';
    };
    let h = `<h2>${esc(spec.label)}</h2>`;
    if (spec.elements(p, () => '0').length && p.kind !== 'SUPPLY') h += row('Reference', `<input type="text" data-field="ref" value="${esc(p.ref || '')}" spellcheck="false">`);
    if (['POT', 'RHEO', 'SW', 'SPDT', 'ONOFFON'].includes(p.kind)) h += row('Knob name', `<input type="text" data-field="knob" value="${esc(p.props?.knob || '')}" placeholder="e.g. Drive" maxlength="40" spellcheck="false" title="Shown on the front panel and beside the reference on the schematic">`);
    if (spec.unit && p.kind !== 'SUPPLY') {
      const stepper = p.kind === 'R' || p.kind === 'C' || p.kind === 'POT' || p.kind === 'RHEO';
      h += row('Value', `<span class="valrow">${stepper ? '<button data-step="-1" aria-label="Previous standard value">‹</button>' : ''}<input type="text" data-field="value" value="${esc(fmtEng(p.value))}" spellcheck="false">${stepper ? '<button data-step="1" aria-label="Next standard value">›</button>' : ''}<span class="unit">${spec.unit}</span></span>`);
    }
    if (p.kind === 'POT' || p.kind === 'RHEO') {
      h += row('Taper', `<select data-field="taper">${Object.entries(TAPERS).map(([k, t]) => `<option value="${k}" ${p.props?.taper === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`);
      const turn = Math.round((p.props?.turn ?? 0.5) * 100);
      h += row(`Rotation <output>${turn}%</output>`, `<input type="range" data-field="turn" min="0" max="100" value="${turn}">`);
      // Variable resistor: lugs 1 + 2 (unticked) or 2 + 3; pot: lugs 1 and 3 swapped. The symbol stays put.
      const rev = p.kind === 'RHEO'
        ? ['Lugs 2 + 3', 'resistance falls as the knob turns up (unticked: lugs 1 + 2)']
        : ['Reverse', 'lugs 1 and 3 swapped: turning up moves the wiper towards pin 1'];
      h += row(rev[0], `<span class="chk"><input type="checkbox" data-field="reverse" ${p.props?.reverse ? 'checked' : ''}> <span class="hint">${rev[1]}</span></span>`);
      // Dual-gang: another pot on the same shaft (they turn together; each keeps its value, taper and Reverse).
      h += gangRow(p, 'Ganged with', 'Put this pot on the same shaft as another (a dual-gang pot): they turn together', 'None (its own shaft)');
    }
    if (SWEEPABLE_KINDS.includes(p.kind)) {
      h += row('Sweepable', `<span class="chk"><input type="checkbox" data-field="sweep" ${p.props?.sweep ? 'checked' : ''}> <span class="hint">offer ${p.kind === 'POT' || p.kind === 'RHEO' ? 'its rotation and value' : ['SW', 'SPDT', 'ONOFFON'].includes(p.kind) ? 'its positions' : 'its value'} in the Sweep menu</span></span>`);
    }
    if (p.kind === 'OA') {
      h += row('Model', `<select data-field="model">${Object.entries(OPAMP_MODELS).map(([k, m]) => `<option value="${k}" ${p.props?.model === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`);
      // Input bias current: the model's typical value unless this part sets its own.
      const typ = opAmpModel(p.props?.model ?? 'ideal').ib;
      h += row('Input bias', `<span class="valrow"><input type="text" data-field="ib" value="${p.props?.ib !== undefined ? esc(fmtEng(p.props.ib)) : ''}" placeholder="${esc(fmtEng(typ))} (typical)" spellcheck="false" title="Current drawn by each input (positive: into the inputs, as in NPN-input chips like the 4558; negative: out of them, as in the LM358). Leave empty for the model's typical value; set it for a particular or unknown chip."><span class="unit">A</span></span>`);
      h += '<p class="hint">Input bias current flows through the resistors at the inputs. Through a large feedback resistance (e.g. a Drive pot) it puts a small DC offset across clipping diodes in the loop, which makes the clipping slightly asymmetric, most of all at low levels.</p>';
      // All pins: the 8-pin package (both op-amps of a dual, and the supply pins).
      const view = opAmpView(p), lm = view === 'lm386';
      h += row('All pins', `<span class="chk"><input type="checkbox" data-field="pins" ${view !== 'triangle' ? 'checked' : ''} ${lm ? 'disabled' : ''}> <span class="hint">${lm ? 'the LM386 is always shown as its 8-pin package' : 'show the 8-pin package'}</span></span>`);
      if (view !== 'triangle') {
        h += `<p class="hint">${view === 'dual' ? `Both op-amps of the chip (${esc(p.ref || 'U')}A and ${esc(p.ref || 'U')}B); one with nothing connected is left out. ` : ''}`
          + `It clips at the voltages on its supply pins (${view === 'lm386' ? '6 and 4' : view === 'single' ? '7 and 4' : '8 and 4'}), so wire them to the supplies. `
          + `${view === 'lm386' ? 'Gain is 20 with pins 1 and 8 open, up to 200 with a capacitor (e.g. 10 µF) between them; pin 7 (bypass) can be left open. ' : view === 'single' ? 'Pins 1, 5 and 8 (offset null, compensation) can be left open. ' : ''}`
          + 'Changing the model keeps each wire on the same pin number, as when swapping a chip in its socket.</p>';
      }
      const note = opAmpModel(p.props?.model ?? 'ideal').note;
      if (note) h += `<p class="hint">${esc(note)}</p>`;
    }
    const modelSelect = (models: Record<string, { label: string; approx?: boolean }>, filter: (m: any) => boolean = () => true) =>
      row('Model', `<select data-field="model">${Object.entries(models).filter(([, m]) => filter(m)).map(([k, m]) => `<option value="${k}" ${p.props?.model === k ? 'selected' : ''}>${esc(m.label)}${m.approx ? ' ≈' : ''}</option>`).join('')}</select>`);
    if (p.kind === 'D' || p.kind === 'LED') h += modelSelect(DIODE_MODELS);
    if (p.kind === 'NPN' || p.kind === 'PNP') h += modelSelect(BJT_MODELS, m => m.pol === p.kind.toLowerCase());
    if (p.kind === 'NJF' || p.kind === 'PJF') h += modelSelect(JFET_MODELS, m => m.pol === (p.kind === 'NJF' ? 'n' : 'p'));
    if (p.kind === 'NMOS' || p.kind === 'PMOS') h += modelSelect(MOS_MODELS, m => m.pol === (p.kind === 'NMOS' ? 'n' : 'p'));
    if (['D', 'LED', 'NPN', 'PNP', 'NJF', 'PJF', 'NMOS', 'PMOS'].includes(p.kind)) h += '<div data-bias></div>';
    if (p.kind === 'SW') h += row('State', `<select data-field="closed"><option value="1" ${p.props?.closed ? 'selected' : ''}>Closed</option><option value="0" ${!p.props?.closed ? 'selected' : ''}>Open</option></select>`);
    if (p.kind === 'SPDT' || p.kind === 'ONOFFON') {
      const pos = p.props?.pos ?? 'a', opt = (v: string, label: string) => `<option value="${v}" ${pos === v ? 'selected' : ''}>${label}</option>`;
      h += row('Position', `<select data-field="pos">${opt('a', 'To A (upper)')}${p.kind === 'ONOFFON' ? opt('off', 'Off (centre)') : ''}${opt('b', 'To B (lower)')}</select>`);
    }
    if (p.kind === 'SW' || p.kind === 'SPDT' || p.kind === 'ONOFFON') {
      h += gangRow(p, 'Linked with', `Make this one pole of a multi-pole switch (two ${p.kind === 'SW' ? 'SPSTs make a DPST' : p.kind === 'SPDT' ? 'SPDTs make a DPDT' : 'on-off-ons make a DPDT on-off-on'}): the poles switch together`, 'None (a switch of its own)');
    }
    if (p.kind === 'LABEL' || p.kind === 'SUPPLY') h += row('Net name', `<input type="text" data-field="name" value="${esc(p.props?.name || '')}" spellcheck="false">`);
    if (p.kind === 'SUPPLY') h += row('Voltage', `<span class="valrow"><input type="text" data-field="value" value="${esc(p.value ?? 9)}"><span class="unit">V</span></span>`);
    if (p.kind === 'NMOS' || p.kind === 'PMOS') h += '<p class="hint">Real thresholds vary a lot between samples (2N7000: about 0.8–3 V), so circuits use a trimmer or drain feedback. For a clipper, tie the gate to the drain: it then conducts above V<sub>th</sub>, and its body diode conducts the other way.</p>';
    if (['D', 'LED', 'NPN', 'PNP', 'NJF', 'PJF', 'NMOS', 'PMOS'].includes(p.kind)) h += '<p class="hint">The Response plot linearises it at its DC operating point (small-signal, so no clipping there). The Sound panel simulates it fully, clipping included. ≈ marks approximate models.</p>';
    if (p.kind === 'SUPPLY') h += '<p class="hint">Supplies are AC ground in the frequency response.</p>';
    // No Mirror for an op-amp package: it's drawn as seen from above.
    const mirror = p.kind === 'OA' && opAmpView(p) !== 'triangle' ? '' : '<button data-act="mirror" title="Ctrl+E">Mirror</button>';
    h += `<div class="btnrow"><button data-act="rotate" title="Ctrl+R">Rotate</button>${mirror}<button data-act="delete">Delete</button></div>`;
    el.innerHTML = h;
    el.dataset.id = p.id;
    fillDeviceOp();
  }

  /* ---------- DC bias ---------- */
  let showBias = (() => { try { return localStorage.getItem(LS_KEY + '.bias') === '1'; } catch { return false; } })();
  function toggleBias(): void {
    showBias = !showBias;
    try { localStorage.setItem(LS_KEY + '.bias', showBias ? '1' : '0'); } catch { /* ignore */ }
    renderBias();
  }
  const opOf = (): OpPoint | null => { const sx = simEx(); return hasErrors(sx) ? null : biasOf(sx); };
  /** Node voltages on the canvas: one tag per net, on a wire where it clears the labels and symbols. */
  function renderBias(): void {
    $('#bBias').classList.toggle('active', showBias);
    fillDeviceOp();
    const sx = simEx();
    if (!showBias || hasErrors(sx)) { editor.setAnnotations(''); return; }
    // Linear circuits have no op from biasOf; solve them too so the overlay always works.
    const pt = biasOf(sx) ?? dcOp(sx.netlist);
    const rank = (k: PartKind) => (['NPN', 'PNP', 'NJF', 'PJF', 'NMOS', 'PMOS'].includes(k) ? 0 : k === 'D' || k === 'LED' ? 1 : k === 'OA' ? 2 : ['IN', 'OUT', 'GND', 'SUPPLY', 'LABEL', 'PROBE'].includes(k) ? 9 : 3);
    type Box = [number, number, number, number];
    const taken: Box[] = [...renderSchematicBody(editor.doc).textBoxes, ...editor.doc.parts.map(partBox)];
    /** Area of overlap with labels, symbols and earlier tags. */
    const overlap = (b: Box) => taken.reduce((sum, o) => sum + Math.max(0, Math.min(b[2], o[2]) - Math.max(b[0], o[0])) * Math.max(0, Math.min(b[3], o[3]) - Math.max(b[1], o[1])), 0);
    const wireNet = wireNets();
    const tags: string[] = [];
    for (const [net, members] of ex.nets) {
      // The input is tied to 0 V for the bias calculation, so its tag would say nothing.
      if (net === '0' || net === sx.netlist.input || members.length < 2 || !pt.nodes.has(net)) continue;
      const txt = fmtVolts(pt.v(net)), w = txt.length * 5.9 + 6, h = 12;
      // Candidate spots along the net's wire segments, longest (and horizontal) first.
      const segs: { a: Pt; b: Pt; sc: number }[] = [];
      for (const wire of editor.doc.wires) {
        if (wireNet.get(wire.id) !== net) continue;
        for (let i = 1; i < wire.pts.length; i++) {
          const a = wire.pts[i - 1], b = wire.pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len >= 20) segs.push({ a, b, sc: len * (a[1] === b[1] ? 1 : 0.6) });
        }
      }
      segs.sort((p, q) => q.sc - p.sc);
      const spots: Pt[] = [];
      for (const { a, b } of segs) {
        for (const t of [0.5, 0.25, 0.75]) {
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          if (a[1] === b[1]) spots.push([x - w / 2, y - h - 3], [x - w / 2, y + 3]);
          else spots.push([x + 4, y - h / 2], [x - w - 4, y - h / 2]);
        }
      }
      const m = [...members].sort((p, q) => rank(p.part.kind) - rank(q.part.kind))[0];
      for (const [dx, dy] of [[3, -h - 3], [3, 3], [-w - 3, -h - 3], [-w - 3, 3]]) spots.push([m.at[0] + dx, m.at[1] + dy]);
      let at = spots[0], least = Infinity;
      for (const sp of spots) {
        const o = overlap([sp[0], sp[1], sp[0] + w, sp[1] + h]);
        if (o < least) { least = o; at = sp; }
        if (o === 0) break;
      }
      taken.push([at[0], at[1], at[0] + w, at[1] + h]);
      tags.push(`<g class="vbias${pt.ok ? '' : ' bad'}" transform="translate(${at[0].toFixed(1)} ${at[1].toFixed(1)})"><rect x="0" y="0" width="${w.toFixed(1)}" height="${h}" rx="3"/><text x="3" y="9">${txt}</text></g>`);
    }
    editor.setAnnotations(tags.join(''));
  }
  /** Net of each wire: from a pin it touches, or from a touching wire whose net is known. */
  function wireNets(): Map<string, string> {
    const out = new Map<string, string>();
    const touches = (pts: Pt[], q: Pt) => pts.some((p, i) => samePt(p, q) || (i > 0 && onSegment(q, pts[i - 1], p)));
    for (const [net, members] of ex.nets) for (const m of members)
      for (const wire of editor.doc.wires) if (!out.has(wire.id) && touches(wire.pts, m.at)) out.set(wire.id, net);
    for (let changed = true; changed;) {
      changed = false;
      for (const wire of editor.doc.wires) {
        if (out.has(wire.id)) continue;
        const ends = [wire.pts[0], wire.pts[wire.pts.length - 1]];
        const other = editor.doc.wires.find(o => out.has(o.id) && (ends.some(e => touches(o.pts, e)) || touches(wire.pts, o.pts[0]) || touches(wire.pts, o.pts[o.pts.length - 1])));
        if (other) { out.set(wire.id, out.get(other.id)!); changed = true; }
      }
    }
    return out;
  }
  function fillDeviceOp(): void {
    const box = document.querySelector<HTMLElement>('#bProps [data-bias]');
    const p = current();
    if (!box || !p) return;
    const op = opOf();
    const name = p.ref || p.id;
    const entry = op && [...op.devices].find(([e]) => e.name === name);
    if (!op || !entry) { box.innerHTML = '<p class="hint">No operating point (fix errors under Checks).</p>'; return; }
    box.innerHTML = (op.ok ? '' : '<p class="warnc">DC bias did not converge: these values are unreliable.</p>') + opTable(entry[1]);
  }
  function opTable(d: DeviceOp): string {
    const r = (k: string, v: string) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const A = (x: number) => fmtEng(x, 'A'), Vv = fmtVolts;
    let rows = '';
    if (d.type === 'D') rows = r('V<sub>D</sub>', Vv(d.vd)) + r('I<sub>D</sub>', A(d.id)) + r('r<sub>d</sub>', d.gd > 1e-12 ? fmtEng(1 / d.gd, 'Ω') : 'open');
    if (d.type === 'Q') rows = r('Region', d.region) + r('I<sub>C</sub>', A(d.ic)) + r('V<sub>CE</sub>', Vv(d.vce)) + r('V<sub>BE</sub>', Vv(d.vbe))
      + r('β (I<sub>C</sub>/I<sub>B</sub>)', d.beta > 0 ? d.beta.toFixed(0) : '–') + r('g<sub>m</sub>', fmtEng(d.gm, 'S'));
    if (d.type === 'M') rows = r('Region', d.region) + r('I<sub>D</sub>', A(d.id)) + r('V<sub>GS</sub>', Vv(d.vgs)) + r('V<sub>DS</sub>', Vv(d.vds)) + r('g<sub>m</sub>', fmtEng(d.gm, 'S'))
      + (Math.abs(d.ibody) > 1e-9 ? r('Body diode', A(d.ibody)) : '');
    if (d.type === 'J') rows = r('Region', d.region) + r('I<sub>D</sub>', A(d.id)) + r('V<sub>GS</sub>', Vv(d.vgs)) + r('V<sub>DS</sub>', Vv(d.vds)) + r('g<sub>m</sub>', fmtEng(d.gm, 'S'));
    return `<table class="opdata">${rows}</table>`;
  }

  const propEl = $('#bProps');
  const current = (): SchPart | undefined => editor.doc.parts.find(q => q.id === propEl.dataset.id && editor.sel.has(q.id));
  function applyField(el: HTMLInputElement, live: boolean): void {
    const p = current();
    if (!p) return;
    const f = el.dataset.field!;
    let patch: Partial<SchPart> | null = null;
    if (f === 'gang') { editor.commit(setGang(editor.doc, p.id, el.value || null)); return; }
    if (p.kind === 'OA' && (f === 'model' || f === 'pins')) {
      // An op-amp changing between its triangle and its 8-pin package keeps its wires on the same pins.
      const props = f === 'model' ? { model: el.value } : { pins: el.checked ? 'all' as const : undefined };
      const from = opAmpView(p), to = opAmpView({ ...p, props: { ...p.props, ...props } });
      // A package is drawn as seen from above (pin 1 top left), so going to it drops a mirror.
      const flip = from === 'triangle' && to !== 'triangle' && p.mirror ? { mirror: undefined } : {};
      editor.commit(reshapePart(editor.doc, p.id, { props, ...flip }, opAmpPinMap(from, to)));
      return;
    }
    if (f === 'ref') patch = { ref: el.value.trim() || p.ref };
    else if (f === 'value') {
      const v = parseEng(el.value), ok = isFinite(v) && (p.kind === 'C' ? v >= 0 : p.kind === 'SUPPLY' ? true : v > 0);
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      patch = { value: v };
      if (!live) el.value = p.kind === 'SUPPLY' ? String(v) : fmtEng(v);
    } else if (f === 'turn') {
      patch = { props: { turn: +el.value / 100 } };
      const out = el.closest('.prop')?.querySelector('output');
      if (out) out.textContent = `${el.value}%`;
    } else if (f === 'taper') patch = { props: { taper: el.value as TaperKey } };
    else if (f === 'model') patch = { props: { model: el.value } };
    else if (f === 'closed') patch = { props: { closed: el.value === '1' } };
    else if (f === 'pos') patch = { props: { pos: el.value as 'a' | 'b' | 'off' } };
    else if (f === 'name') patch = { props: { name: el.value.trim() } };
    else if (f === 'knob') patch = { props: { knob: el.value.trim() || undefined } };
    else if (f === 'sweep') patch = { props: { sweep: el.checked || undefined } };
    else if (f === 'reverse') patch = { props: { reverse: el.checked || undefined } };
    else if (f === 'ib') {
      const s = el.value.trim().replace(/a$/i, '');
      const v = s ? parseEng(s) : undefined, ok = v === undefined || (isFinite(v) && Math.abs(v) < 1e-3);
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      patch = { props: { ib: v } };
      if (!live && v !== undefined) el.value = fmtEng(v);
    }
    if (!patch) return;
    const next = updatePart(editor.doc, p.id, patch);
    if (live) editor.preview(next); else editor.commit(next);
  }
  // Text notes: live preview while typing, one undo step per edit.
  const noteEdit = (el: HTMLInputElement, live: boolean) => {
    const id = propEl.dataset.id, f = el.dataset.notefield as 'text' | 'anchor' | 'width';
    if (!id || !(editor.doc.notes ?? []).some(n => n.id === id)) return;
    let patch: Partial<SchNote>;
    if (f === 'width') {
      // Empty: no wrapping. Otherwise a width in drawing units (the grid is 10).
      const s = el.value.trim(), v = s ? Number(s) : undefined, ok = v === undefined || (isFinite(v) && v >= 10);
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      patch = { width: v === undefined ? undefined : Math.round(v) };
    } else patch = f === 'text' ? { text: el.value } : { anchor: el.value as 'start' | 'middle' | 'end' };
    const next = updateNote(editor.doc, id, patch);
    if (live) editor.preview(next); else editor.commit(next);
  };
  propEl.addEventListener('input', e => { const el = e.target as HTMLInputElement; if (el.dataset.notefield === 'text') noteEdit(el, true); });
  propEl.addEventListener('change', e => { const el = e.target as HTMLInputElement; if (el.dataset.notefield) noteEdit(el, false); });
  propEl.addEventListener('input', e => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.field && (el.type === 'range' || el.dataset.field === 'value')) applyField(el, true);
  });
  propEl.addEventListener('change', e => { const el = e.target as HTMLInputElement; if (el.dataset.field) applyField(el, false); });
  propEl.addEventListener('keydown', e => {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter' && el.dataset.field) { applyField(el, false); editor.commit(editor.doc); }
    if (e.key === 'Enter' && el.dataset.notefield && (el.tagName !== 'TEXTAREA' || e.ctrlKey)) { noteEdit(el, false); $('#bCanvasWrap').focus(); }
  });
  propEl.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.act === 'rotate') editor.rotate();
    if (b.dataset.act === 'mirror') editor.mirror();
    if (b.dataset.act === 'delete') editor.deleteSel();
    if (b.dataset.step) {
      const p = current();
      if (!p || !(p.value! > 0)) return;
      const nv = stepSeries(p.value!, p.kind === 'C' ? S.settings.cSeries : S.settings.rSeries, +b.dataset.step);
      editor.commit(updatePart(editor.doc, p.id, { value: nv }));
      const inp = propEl.querySelector<HTMLInputElement>('[data-field="value"]');
      if (inp) inp.value = fmtEng(nv);
    }
  });

  /* ---------- ERC ---------- */
  function renderErc(): void {
    const errs = ex.issues.filter(i => i.severity === 'error').length, warns = ex.issues.length - errs;
    $('#bErcStatus').innerHTML = errs ? `<span class="e-bad">${errs} error${errs > 1 ? 's' : ''}</span>` + (warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : '')
      : warns ? `<span class="warnc">${warns} warning${warns > 1 ? 's' : ''}</span>` : '<span class="e-good">No problems</span>';
    $('#bErc').innerHTML = ex.issues.length
      ? `<ul class="erc">${ex.issues.map((i, k) => `<li class="${i.severity}${i.parts?.length || i.at ? '' : ' static'}" data-k="${k}"${i.parts?.length || i.at ? ' title="Show on the schematic"' : ''}>${i.severity === 'error' ? '✕' : '!'} ${esc(i.message)}</li>`).join('')}</ul>`
      : '<p class="hint">The circuit is complete: every pin is connected and every net has a DC path to ground.</p>';
  }
  $('#bErc').addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-k]');
    const issue = li && ex.issues[+li.dataset.k!];
    if (!issue || !editor.focusOn(issue.parts ?? [], issue.at, issue.severity)) return;
    document.querySelectorAll('#bErc li.active').forEach(x => x.classList.remove('active'));
    li!.classList.add('active');
    // On narrow screens the canvas may be scrolled away; bring it into view.
    const r = $('#bCanvasWrap').getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) $('#bCanvasWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  /* ---------- Schematic height (drag handle under the canvas) ---------- */
  {
    const wrap = $<HTMLElement>('#bCanvasWrap'), handle = $<HTMLElement>('#bResize');
    const MIN = 160, MAX = 2400, KEY = LS_KEY + '.height';
    const setHeight = (h: number | null, keep = true) => {
      wrap.style.height = h === null ? '' : `${Math.round(Math.min(MAX, Math.max(MIN, h)))}px`;
      if (keep) try { if (h === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(wrap.offsetHeight)); } catch { /* ignore */ }
    };
    try { const h = Number(localStorage.getItem(KEY)); if (h > 0) setHeight(h, false); } catch { /* ignore */ }
    let drag: { y: number; h: number } | null = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { y: e.clientY, h: wrap.offsetHeight };
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', e => { if (drag) setHeight(drag.h + e.clientY - drag.y, false); });
    const end = () => { if (!drag) return; drag = null; handle.classList.remove('dragging'); setHeight(wrap.offsetHeight); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => setHeight(null));
    handle.addEventListener('keydown', e => {
      const step = e.shiftKey ? 100 : 20;
      if (e.key === 'ArrowUp') { e.preventDefault(); setHeight(wrap.offsetHeight - step); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setHeight(wrap.offsetHeight + step); }
    });
  }

  let initialDrag: DragMode = 'stretch';
  try { if (localStorage.getItem(LS_KEY + '.drag') === 'move') initialDrag = 'move'; } catch { /* ignore */ }
  editor.setDragMode(initialDrag);
  renderModes('select', null);
  renderProps();
  renderErc();
  updateToolbar();
  sim.update(editor.doc, ex, true);
  renderBias();
  panel.sync(editor.doc);

  /* ---------- Pedalboard (its pedals are the tabs) ---------- */
  /** Knob edits on a pedal: through the editor when it is the shown tab, else into that tab's own history. */
  const hostCache = new Map<string, DocHost>();
  function docHost(id: string): DocHost {
    let h = hostCache.get(id);
    if (h) return h;
    let base: Schematic | null = null;
    const tab = () => tabs.find(t => t.id === id);
    h = {
      get doc() { const t = tab(); return t ? docOf(t) : { version: 1 as const, parts: [], wires: [] }; },
      preview: d => {
        const t = tab();
        if (!t) return;
        if (t === active) { editor.preview(d); return; }
        base ??= t.state.doc;
        t.state = { ...t.state, doc: d };
        board?.changed(id);
      },
      commit: d => {
        const t = tab();
        if (!t) return;
        if (t === active) { editor.commit(d); return; }
        const prev = base ?? t.state.doc;
        base = null;
        if (d !== prev) {
          t.state = { ...t.state, doc: d, undo: [...t.state.undo, JSON.stringify(prev)].slice(-200), redo: [] };
          t.dirty = true;
          t.sound = null;
        } else t.state = { ...t.state, doc: d };
        renderTabs(); persist(); board?.changed(id);
      },
    };
    hostCache.set(id, h!);
    return h!;
  }
  const fileOf = (t: Tab) => (t === active ? files.state().file : t.file ?? null);
  board = initBoard({
    tabs: () => tabs.map(t => ({ id: t.id, name: nameOf(t), file: fileOf(t)?.name ?? null })),
    doc: id => { const t = tabs.find(x => x.id === id); return t ? docOf(t) : null; },
    ex: id => { const t = tabs.find(x => x.id === id); return t ? exOf(docOf(t)) : null; },
    docHost,
    edit: id => { const t = tabs.find(x => x.id === id); if (t) { switchTo(t); nav.showBuilder(); } },
    openPedal: ({ project, handle, fileName }) => {
      const open = tabs.find(t => (fileName ? fileOf(t)?.name === fileName : !fileOf(t) && nameOf(t) === project.name));
      if (open) return open.id;
      const t = newTab(project.sim ?? sim.settings(), project.schematic);
      if (project.sim) t.sim = JSON.parse(JSON.stringify(project.sim));
      t.name = project.name;
      t.file = handle;
      t.trace = project.trace ?? null;
      if (project.view) { t.state.view = project.view; t.needsFit = false; }
      tabs.push(t);
      if (handle) void idbSet(fileKey(t.id), handle);
      if (t.trace) void idbSet(traceKey(t.id), t.trace);
      renderTabs(); persist(); sim.refreshCompare();
      return t.id;
    },
    pedalFile: id => {
      const t = tabs.find(x => x.id === id)!;
      const sims = t === active ? sim.settings() : t.sim;
      return { file: fileOf(t)?.name ?? null, project: makeProject(nameOf(t), docOf(t), sims, t === active ? editor.getView() : t.state.view) };
    },
    folder: files.folder,
  }, nav.showBoard);

  ready = true;
  renderTabs();
  persist();

  return {
    // From the Playground: into a new tab (unless the current one is blank).
    load: doc => {
      void host.beforeOpen(null).then(() => { editor.load(JSON.parse(JSON.stringify(doc))); editor.selectIds([]); });
    },
    boardShown: () => board?.shown(),
    // Tabs with changes not saved to a file (the active tab's state lives in the file bar), and the board.
    unsaved: () => [
      ...tabs.filter(t => (t === active ? files.state().dirty : t.dirty)).map(nameOf),
      ...(board?.unsaved() ? ['the pedalboard'] : []),
    ],
    shown: () => {
      editor.render();
      if (active.needsFit) { editor.fit(); active.needsFit = false; }
      sim.redraw(); sound.redraw();
    },
  };
}

