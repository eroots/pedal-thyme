// Pedalboard section: the pedals (open Builder tabs) in signal order between a source and a load, each
// with a footswitch, its knobs and its problems (if any); the response stacked (one pedal into the next,
// with the signal after each) or compared (each pedal on its own); and the board's sound. Pedals can be
// added from the open tabs or straight from the project folder (they open as background tabs).
import { joinStages } from '../engine/chain';
import type { Netlist, Node } from '../engine/netlist';
import { freqGrid } from '../playground/analysis';
import { LOAD_PRESETS, SRC_PRESETS, fRange, sweepColor } from '../playground/state';
import type { Extraction } from '../schematic/extract';
import type { Schematic } from '../schematic/types';
import { download } from '../ui/download';
import { cssVar, drawPlot, magRange, PLOT_MARGIN, type PlotSeries } from '../ui/plot';
import { fmtEng } from '../core/units';
import { BOARD_EXT, BYPASS, boardTerm, isBoardText, isSilent, loadBoardSession, loadingOf, loadingText, makeBoardFile, parseBoard, pedalIssues, saveBoardSession, type Board, type BoardFile, type BoardMode, type Loading } from './board';
import { makeProject, parseProject, safeFileName, type Project } from './files';
import { allowed, canSaveAs, canWriteFolders, idbGet, idbSet, saveAsDialog, writeHandle, type FolderEntry, type ProjectFolder } from './folder';
import { decodeLtspice } from '../ltspice/asc';
import { importAsc } from '../ltspice/import';
import { initFrontPanel, type DocHost, type FrontPanel } from './frontpanel';
import { impedances, simulate } from './sim';
import { initSoundPanel } from './sound';

const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmtDb = (x: number) => (isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)} dB` : '—');
const FILE_KEY = 'board-file';

/** What the board needs from the Builder (its tabs are the pedals). */
export interface BoardHost {
  /** Open tabs, in tab order, with the file each was opened from (if any). */
  tabs(): { id: string; name: string; file: string | null }[];
  /** A tab's schematic and its extraction (null if the tab is gone). */
  doc(id: string): Schematic | null;
  ex(id: string): Extraction | null;
  /** Where a pedal's knobs read and write its schematic (recorded in that tab's history). */
  docHost(id: string): DocHost;
  /** Show a pedal in the Builder. */
  edit(id: string): void;
  /** Open a schematic as a tab without showing it (or find it already open); returns the tab id. */
  openPedal(p: { project: Project; handle: FileSystemFileHandle | null; fileName: string | null }): string;
  /** A tab's file name and a copy of it, for the board file. */
  pedalFile(id: string): { file: string | null; project: Project };
  folder: ProjectFolder;
}

export interface BoardUi {
  shown(): void;
  /** A pedal's schematic, name or the set of tabs changed. */
  changed(id?: string): void;
  /** Open a board file (from the Builder's Open or Folder menu too). */
  open(text: string, handle: FileSystemFileHandle | null): Promise<void>;
  /** Does the board have changes that aren't saved to a file? */
  unsaved(): boolean;
}

export function initBoard(host: BoardHost, show: () => void): BoardUi {
  let board: Board = loadBoardSession();
  let file: FileSystemFileHandle | null = null;
  void idbGet<FileSystemFileHandle>(FILE_KEY).then(h => { file = h ?? null; showState(); });
  const visible = () => !$<HTMLElement>('#board').hidden;
  const term = () => boardTerm(board, SRC_PRESETS, LOAD_PRESETS);
  const nameOf = (id: string) => host.tabs().find(t => t.id === id)?.name ?? '?';

  /* ---------- Sound: a copy of the Builder's panel ---------- */
  $('#pbSoundSlot').outerHTML = $('#bSound').outerHTML.replace(/id="sd/g, 'id="pbsd').replace('id="bSound"', 'id="pbSound"')
    .replace('▶ Pedal', '▶ Board').replace('Time-domain simulation: clipping, distortion and how it sounds.', 'The guitar through every pedal that is on.');
  const sound = initSoundPanel(() => {
    const name = board.name || 'pedalboard', doc = { version: 1 as const, parts: [], wires: [] };
    if (board.mode === 'compare') {
      const ok = comparable();
      return {
        ex: fake(BYPASS, ok.length ? undefined : 'No pedals to compare: switch some on (and fix any that have errors).'), doc, term: term(), name,
        variants: ok.map(p => ({ label: nameOf(p.tab), netlist: host.ex(p.tab)!.netlist })),
      };
    }
    const c = chain();
    return { ex: c.ex, doc, term: term(), name, probes: c.probes };
  }, 'pbsd');

  /* ---------- The chain ---------- */
  const onPedals = () => board.pedals.filter(p => p.on && host.ex(p.tab));
  const hasErrors = (id: string) => pedalIssues(host.ex(id)!).errors.length > 0;
  /** Pedals that are on and give something to compare (no errors, and some signal gets through). */
  const comparable = () => onPedals().filter(p => !hasErrors(p.tab) && !silentOf(p.tab));
  const fake = (netlist: Netlist, error?: string): Extraction => ({ netlist, pinNet: new Map(), nets: new Map(), issues: error ? [{ severity: 'error', message: error }] : [] });
  const listNames = (ns: string[]) => (ns.length > 1 ? `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}` : ns[0] ?? '');
  /** The joined circuit of the pedals that are on, the outputs after each, and any error. */
  function chain(): { ex: Extraction; probes: { ref: string; color: string; net: Node }[]; names: string[]; error?: string } {
    const on = onPedals(), names = on.map(p => nameOf(p.tab));
    const bad = on.filter(p => hasErrors(p.tab)).map(p => nameOf(p.tab));
    if (bad.length) {
      const error = `${listNames(bad)} ${bad.length > 1 ? 'have' : 'has'} errors, so the board can't be simulated: fix them in the Builder (click the red badge to open ${bad.length > 1 ? 'one' : 'it'}), or switch ${bad.length > 1 ? 'them' : 'it'} off.`;
      return { ex: fake(BYPASS, error), probes: [], names, error };
    }
    if (!on.length) return { ex: fake(BYPASS), probes: [], names };
    const { netlist, outputs } = joinStages(on.map(p => host.ex(p.tab)!.netlist));
    const probes = outputs.slice(0, -1).map((net, i) => ({ ref: `After ${names[i]}`, color: stageColor(i, on.length), net }));
    return { ex: fake(netlist), probes, names };
  }
  const stageColor = (i: number, n: number) => sweepColor(n > 1 ? i / (n - 1) : 0);

  /* ---------- Persisting and the file bar ---------- */
  const stateEl = $<HTMLSpanElement>('#pbSaveState');
  function showState(): void {
    stateEl.textContent = board.dirty ? (file ? `${file.name} · unsaved changes` : board.pedals.length ? 'Not saved' : '') : file ? `Saved · ${file.name}` : '';
    stateEl.classList.toggle('dirty', board.dirty);
  }
  function touched(structure = true): void {
    board.dirty = true;
    saveBoardSession(board);
    showState();
    if (structure) renderStrip();
    sound.invalidate();
    schedule();
  }
  const nameEl = $('#pbName');
  nameEl.value = board.name;
  nameEl.addEventListener('change', () => { board.name = nameEl.value.trim(); touched(false); });

  async function save(as: boolean): Promise<void> {
    if (!board.pedals.length) { alert('Add some pedals to the board first.'); return; }
    const pedals: BoardFile['pedals'] = board.pedals.map(p => ({ name: nameOf(p.tab), on: p.on, ...host.pedalFile(p.tab) }));
    const data = JSON.stringify(makeBoardFile(board, pedals), null, 2);
    const fileName = `${safeFileName(board.name || 'pedalboard')}${BOARD_EXT}`;
    const folder = host.folder;
    try {
      if (!canWriteFolders && !canSaveAs) download(fileName, data, 'application/json');
      else if (!as && file) await writeHandle(file, data);
      else if (!as && folder.dir && (await allowed(folder.dir, 'readwrite', true))) {
        if ((await folder.has(fileName)) && !confirm(`${fileName} already exists in “${folder.name}”. Replace it?`)) return;
        file = await folder.write(fileName, data);
      } else if (canSaveAs) {
        const fh = await saveAsDialog(fileName, data, folder.dir);
        if (!fh) return;
        file = fh;
      } else download(fileName, data, 'application/json');
      void idbSet(FILE_KEY, file ?? undefined);
      board.dirty = false;
      saveBoardSession(board);
      showState();
      const unsaved = pedals.filter(p => !p.file).map(p => p.name);
      note(unsaved.length ? `Saved. ${unsaved.join(', ')} ${unsaved.length > 1 ? 'aren’t' : 'isn’t'} saved as ${unsaved.length > 1 ? 'files' : 'a file'} yet, so the board keeps a copy; save ${unsaved.length > 1 ? 'them' : 'it'} in the Builder (in the same folder) to link ${unsaved.length > 1 ? 'them' : 'it'} instead.` : '');
    } catch (err) {
      alert(`Couldn’t save the board: ${(err as Error).message}`);
    }
  }
  $('#pbSave').addEventListener('click', () => void save(false));
  $('#pbSaveAs').addEventListener('click', () => void save(true));
  if (!canWriteFolders && !canSaveAs) { $('#pbSave').title = 'Download this board as a file'; $('#pbSaveAs').hidden = true; }
  const note = (text: string) => { const el = $<HTMLElement>('#pbNote'); el.textContent = text; el.hidden = !text; };

  async function open(text: string, handle: FileSystemFileHandle | null): Promise<void> {
    const f = parseBoard(text);
    if (board.dirty && board.pedals.length && !confirm('Replace the current pedalboard? Its unsaved changes will be lost.')) return;
    const folder = host.folder, copies: string[] = [];
    const dir = folder.dir && (await allowed(folder.dir, 'read', true)) ? folder.dir : null;
    const pedals = [];
    for (const p of f.pedals) {
      let project = p.project, h: FileSystemFileHandle | null = null;
      if (p.file && dir) {
        try { h = await dir.getFileHandle(p.file); project = parseProject(await (await h.getFile()).text()); } catch { h = null; }
      }
      if (p.file && !h) copies.push(p.name);
      pedals.push({ tab: host.openPedal({ project, handle: h, fileName: p.file }), on: p.on });
    }
    board = { name: f.name, src: f.src, load: f.load, mode: f.mode ?? 'stack', dirty: false, pedals };
    renderMode();
    file = handle;
    void idbSet(FILE_KEY, file ?? undefined);
    nameEl.value = board.name;
    saveBoardSession(board);
    note(copies.length ? `Couldn’t find ${copies.join(', ')} next to the board${dir ? '' : ' (choose its folder in the Builder’s Folder menu)'}, so the copies saved in the board are open instead.` : '');
    show();
    showState(); renderStrip(); sound.invalidate(); schedule();
  }
  $('#pbOpen').addEventListener('change', async e => {
    const input = e.target as HTMLInputElement, f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try { await open(await f.text(), null); } catch (err) { alert(`Couldn’t open ${f.name}: ${(err as Error).message}`); }
  });
  $('#pbNew').addEventListener('click', () => {
    if (board.dirty && board.pedals.length && !confirm('Start a new, empty pedalboard? Unsaved changes to this one will be lost.')) return;
    board = { ...board, name: '', pedals: [], dirty: false };
    file = null; void idbSet(FILE_KEY, undefined);
    nameEl.value = ''; note('');
    saveBoardSession(board); showState(); renderStrip(); sound.invalidate(); schedule();
  });

  /* ---------- The strip: source → pedals → load ---------- */
  const strip = $<HTMLElement>('#pbStrip');
  const panels = new Map<string, FrontPanel>();
  const presetSelect = (kind: 'src' | 'load') => {
    const presets = kind === 'src' ? SRC_PRESETS : LOAD_PRESETS, val = board[kind];
    const first: [string, string] = kind === 'src' ? ['ideal', 'Ideal (0 Ω)'] : ['none', 'None (open)'];
    const opts = [first, ...Object.entries(presets).filter(([k]) => k !== 'custom').map(([k, p]) => [k, p.label] as [string, string])];
    return `<select data-term="${kind}">${opts.map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  };
  function renderStrip(): void {
    const tabs = host.tabs();
    const before = board.pedals.length;
    board.pedals = board.pedals.filter(p => tabs.some(t => t.id === p.tab));
    if (board.pedals.length !== before) saveBoardSession(board);
    panels.clear();
    const n = board.pedals.length;
    strip.innerHTML =
      `<div class="pb-end"><b>Guitar</b>${presetSelect('src')}</div>` +
      board.pedals.map((p, i) => `<div class="pb-pedal${p.on ? '' : ' off'}" data-i="${i}">
          <div class="pb-top"><span class="pb-grip" draggable="true" title="Drag to move this pedal">⠿</span><b class="pb-name" title="${esc(nameOf(p.tab))}">${esc(nameOf(p.tab))}</b><button class="pb-issues" data-issues hidden></button>
            <button class="pb-mv" data-mv="-1" ${i ? '' : 'disabled'} aria-label="Move earlier" title="Earlier in the chain">‹</button><button class="pb-mv" data-mv="1" ${i < n - 1 ? '' : 'disabled'} aria-label="Move later" title="Later in the chain">›</button>
            <button class="pb-x" data-remove aria-label="Remove from the board" title="Remove from the board (the schematic stays open)">×</button></div>
          <div class="pb-knobs"></div>
          <div class="pb-bottom"><button class="pb-switch" data-switch aria-pressed="${p.on}" title="Footswitch: ${p.on ? 'on (click to bypass)' : 'bypassed (click to switch on)'}"><span class="pb-led"></span>${p.on ? 'On' : 'Bypassed'}</button>
            <button class="pb-edit" data-edit title="Open this pedal in the Builder">Edit</button></div>
        </div>`).join('') +
      `<div class="pb-end"><b>Amp</b>${presetSelect('load')}</div>`;
    board.pedals.forEach((p, i) => {
      const root = strip.querySelector<HTMLElement>(`.pb-pedal[data-i="${i}"] .pb-knobs`)!;
      const panel = initFrontPanel(root, host.docHost(p.tab));
      const doc = host.doc(p.tab);
      if (doc) panel.sync(doc);
      panels.set(p.tab, panel);
    });
    renderAdd();
    updateBadges();
    $<HTMLElement>('#pbEmpty').hidden = n > 0;
  }

  /* ---------- Adding pedals: open tabs, or schematics in the project folder ---------- */
  let folderList: FolderEntry[] = [], folderSymbols: FolderEntry[] = [], folderAsk = false;
  /** Schematics in the project folder (asks for access only when `ask`, i.e. from a click). */
  async function refreshFolder(ask = false): Promise<void> {
    const f = host.folder;
    folderAsk = false;
    if (!f.dir && !f.files) { folderList = []; renderAdd(); return; }
    if (f.dir && !ask && (await f.needsPermission())) { folderList = []; folderAsk = true; renderAdd(); return; }
    const { schematics, symbols } = await f.list(ask);
    folderList = schematics.filter(e => !e.name.toLowerCase().endsWith(BOARD_EXT));
    folderSymbols = symbols;
    renderAdd();
  }
  function renderAdd(): void {
    const tabs = host.tabs();
    const free = tabs.filter(t => !board.pedals.some(p => p.tab === t.id));
    const openFiles = new Set(tabs.map(t => t.file).filter(Boolean));
    const files = folderList.map((e, i) => ({ e, i })).filter(({ e }) => !openFiles.has(e.name));
    const folderName = host.folder.name ?? 'the folder';
    let opts = '';
    if (free.length) opts += `<optgroup label="Open in the Builder">${free.map(t => `<option value="tab:${esc(t.id)}">${esc(t.name)}</option>`).join('')}</optgroup>`;
    if (files.length) opts += `<optgroup label="In “${esc(folderName)}”">${files.map(({ e, i }) => `<option value="file:${i}">${esc(e.name)}</option>`).join('')}</optgroup>`;
    if (folderAsk) opts += `<option value="folder:allow">Show the schematics in “${esc(folderName)}”… (asks for access)</option>`;
    const sel = $<HTMLSelectElement>('#pbAdd');
    sel.innerHTML = `<option value="">${opts ? 'Add a pedal…' : 'Open schematics in the Builder, or choose your folder there (Folder ▾), to add pedals'}</option>` + opts;
    sel.disabled = !opts;
  }
  /** Open a schematic from the folder as a background tab (a pedal needs one: knob edits, undo and Save live there). */
  async function openEntry(e: FolderEntry): Promise<string> {
    const file = await e.read();
    if (/\.asc$/i.test(e.name)) {
      const asy = Object.fromEntries(await Promise.all(folderSymbols.map(async s => [s.name, decodeLtspice(new Uint8Array(await (await s.read()).arrayBuffer()))])));
      const r = importAsc(decodeLtspice(new Uint8Array(await file.arrayBuffer())), asy);
      // An imported .asc gets saved as a new .pfl.json, so the tab isn't linked to the .asc file.
      return host.openPedal({ project: makeProject(e.name.replace(/\.asc$/i, ''), r.schematic), handle: null, fileName: null });
    }
    const text = await file.text();
    if (isBoardText(text)) throw new Error('that file is a pedalboard, not a pedal (open it with Open).');
    return host.openPedal({ project: parseProject(text), handle: e.handle ?? null, fileName: e.name });
  }
  $('#pbAdd').addEventListener('change', async e => {
    const sel = e.target as HTMLSelectElement, v = sel.value;
    sel.value = '';
    if (!v) return;
    if (v === 'folder:allow') { await refreshFolder(true); return; }
    if (v.startsWith('file:')) {
      const entry = folderList[+v.slice(5)];
      try { board.pedals.push({ tab: await openEntry(entry), on: true }); touched(); }
      catch (err) { alert(`Couldn’t add ${entry.name}: ${(err as Error).message}`); }
      return;
    }
    board.pedals.push({ tab: v.slice(4), on: true });
    touched();
  });
  $('#pbAdd').addEventListener('focus', () => void refreshFolder());

  /* ---------- Is each pedal complete? (badge on its card) ---------- */
  const SILENT_GRID = freqGrid(20, 20000, 40);
  const silentCache = new WeakMap<Extraction, boolean>();
  /** Nothing gets from its input jack to its output jack (only checked when it has no errors). */
  function silentOf(id: string): boolean {
    const ex = host.ex(id);
    if (!ex || hasErrors(id)) return false;
    let s = silentCache.get(ex);
    if (s === undefined) { s = isSilent(simulate(ex, [], SILENT_GRID, null).out.mag); silentCache.set(ex, s); }
    return s;
  }
  const SILENT_TEXT = 'No signal gets from its input jack to its output jack: are both jacks connected to the circuit?';
  function updateBadges(): void {
    board.pedals.forEach((p, i) => {
      const b = strip.querySelector<HTMLButtonElement>(`.pb-pedal[data-i="${i}"] [data-issues]`), ex = host.ex(p.tab);
      if (!b || !ex) return;
      const { errors, warnings } = pedalIssues(ex), silent = silentOf(p.tab);
      const list = [...errors.map(m => `✕ ${m}`), ...(silent ? [`✕ ${SILENT_TEXT}`] : []), ...warnings.map(m => `! ${m}`)];
      b.hidden = !list.length;
      b.className = `pb-issues ${errors.length || silent ? 'error' : 'warn'}`;
      b.textContent = errors.length ? `✕ ${errors.length}` : silent ? '✕ no signal' : `! ${warnings.length}`;
      b.title = `${list.join('\n')}\n\nClick to open it in the Builder (see its Checks).`;
      b.setAttribute('aria-label', `${nameOf(p.tab)}: ${list.length} problem${list.length > 1 ? 's' : ''}`);
    });
  }
  /** Readout notes for pedals that aren't complete. */
  function incompleteNotes(pedals: { tab: string }[]): string {
    return pedals.map(p => {
      const name = nameOf(p.tab), { warnings } = pedalIssues(host.ex(p.tab)!);
      if (silentOf(p.tab)) return `<span class="pb-warn">⚠ No signal gets through ${esc(name)}: nothing connects its input jack to its output jack (click its red badge to open it and see its Checks).</span>`;
      if (warnings.length) return `<span class="pb-warn">⚠ ${esc(name)} may not be complete: ${esc(warnings.slice(0, 3).join(' '))}${warnings.length > 3 ? ` (and ${warnings.length - 3} more)` : ''}</span>`;
      return '';
    }).join('');
  }
  strip.addEventListener('change', e => {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.term === 'src' || el.dataset.term === 'load') { board[el.dataset.term] = el.value; touched(false); }
  });
  strip.addEventListener('click', e => {
    const el = e.target as HTMLElement, card = el.closest<HTMLElement>('.pb-pedal');
    if (!card) return;
    const i = +card.dataset.i!, p = board.pedals[i];
    if (el.closest('[data-switch]')) { p.on = !p.on; touched(); }
    else if (el.closest('[data-remove]')) { board.pedals.splice(i, 1); touched(); }
    else if (el.closest('[data-edit]') || el.closest('[data-issues]')) host.edit(p.tab);
    else if (el.closest('[data-mv]')) move(i, i + +el.closest<HTMLElement>('[data-mv]')!.dataset.mv!);
  });
  function move(from: number, to: number): void {
    if (to < 0 || to >= board.pedals.length || to === from) return;
    const [p] = board.pedals.splice(from, 1);
    board.pedals.splice(to, 0, p);
    touched();
  }
  // Drag a pedal by its grip; drop it before or after another one.
  let dragFrom = -1;
  strip.addEventListener('dragstart', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.pb-pedal');
    if (!card) return;
    dragFrom = +card.dataset.i!;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', String(dragFrom));
    e.dataTransfer!.setDragImage(card, 20, 20);
    card.classList.add('dragging');
  });
  const dropIndex = (e: DragEvent): number | null => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.pb-pedal');
    if (!card) return null;
    const r = card.getBoundingClientRect(), i = +card.dataset.i!;
    return e.clientX > r.left + r.width / 2 ? i + 1 : i;
  };
  strip.addEventListener('dragover', e => {
    if (dragFrom < 0) return;
    const at = dropIndex(e);
    if (at === null) return;
    e.preventDefault();
    strip.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    const card = (e.target as HTMLElement).closest<HTMLElement>('.pb-pedal')!;
    card.classList.add(at > +card.dataset.i! ? 'drop-after' : 'drop-before');
  });
  strip.addEventListener('drop', e => {
    const at = dropIndex(e);
    e.preventDefault();
    if (dragFrom >= 0 && at !== null) move(dragFrom, at > dragFrom ? at - 1 : at);
  });
  strip.addEventListener('dragend', () => {
    dragFrom = -1;
    strip.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after'));
  });

  /* ---------- Response ---------- */
  let res: ReturnType<typeof simulate> | null = null, freqs: number[] = [], hoverF: number | null = null;
  let rafId = 0;
  const schedule = () => { if (!visible()) return; cancelAnimationFrame(rafId); rafId = requestAnimationFrame(compute); };
  const showStages = () => $('#pbStages').checked;
  $('#pbStages').addEventListener('change', () => schedule());
  /** Compare mode: each pedal's own response. */
  let cmp: { label: string; color: string; mag: number[] }[] | null = null;
  function renderMode(): void {
    $('#pbStack').classList.toggle('active', board.mode === 'stack');
    $('#pbCompare').classList.toggle('active', board.mode === 'compare');
    $<HTMLElement>('#pbStagesL').hidden = board.mode === 'compare';
    const hint = document.querySelector('#pbSound .plothead .hint');
    if (hint) hint.textContent = board.mode === 'compare' ? 'Each pedal that is on, rendered on its own (one version per pedal).' : 'The guitar through every pedal that is on.';
  }
  const setMode = (m: BoardMode) => { if (board.mode !== m) { board.mode = m; renderMode(); touched(false); } };
  $('#pbStack').addEventListener('click', () => setMode('stack'));
  $('#pbCompare').addEventListener('click', () => setMode('compare'));
  const k1 = (f: number) => { let k = 0; for (let i = 1; i < freqs.length; i++) if (Math.abs(Math.log(freqs[i] / f)) < Math.abs(Math.log(freqs[k] / f))) k = i; return k; };
  const at = (v: number[], f: number) => fmtDb(v[k1(f)]);
  function computeCompare(): void {
    const msg = $('#pbMsg'), on = onPedals(), ok = comparable();
    freqs = freqGrid(...fRange(), 300);
    res = null;
    cmp = ok.map((p, i) => ({ label: nameOf(p.tab), color: stageColor(i, ok.length), mag: simulate(host.ex(p.tab)!, [], freqs, term()).out.mag }));
    const bad = on.filter(p => hasErrors(p.tab)).map(p => nameOf(p.tab)), off = board.pedals.length - on.length;
    msg.innerHTML = (cmp.length ? `Each pedal on its own (guitar → pedal → amp): ${cmp.map(c => `${esc(c.label)} ${at(c.mag, 1000)} @ 1 kHz`).join(' · ')}.` : 'No pedals to compare: switch some on.') +
      (off ? ` ${off} switched-off pedal${off > 1 ? 's aren’t' : ' isn’t'} plotted.` : '') +
      (bad.length ? ` <span class="warnc">${esc(listNames(bad))} ${bad.length > 1 ? 'have' : 'has'} errors, so ${bad.length > 1 ? 'they aren’t' : 'it isn’t'} plotted.</span>` : '') +
      incompleteNotes(on.filter(p => !hasErrors(p.tab)));
    draw();
  }
  function compute(): void {
    if (board.mode === 'compare') { computeCompare(); return; }
    cmp = null;
    const c = chain(), msg = $('#pbMsg');
    if (c.error) { res = null; msg.innerHTML = `<span class="warnc">${esc(c.error)}</span>`; draw(); return; }
    freqs = freqGrid(...fRange(), 300);
    const full = simulate(c.ex, c.probes, freqs, term());
    res = showStages() ? full : { ...full, probes: [] };
    const loads = loadings(full.probes.map(p => p.mag));
    const route = ['Guitar', ...(c.names.length ? c.names : ['(all pedals bypassed)']), 'Amp'].map(esc).join(' → ');
    msg.innerHTML = `${route}. Output: ${at(res.out.mag, 100)} @ 100 Hz · ${at(res.out.mag, 1000)} @ 1 kHz · ${at(res.out.mag, 5000)} @ 5 kHz.` +
      (res.probes.length ? ' ' + res.probes.map(p => `${esc(p.ref)}: ${at(p.mag, 1000)} @ 1 kHz.`).join(' ') : '') +
      ' Small-signal (no clipping): render the Sound below to hear the drive.' +
      incompleteNotes(onPedals()) +
      loads.map(l => `<span class="pb-warn">⚠ ${esc(loadingText(l, x => fmtEng(x, 'Ω'), f => fmtEng(f, 'Hz')))}</span>`).join('');
    draw();
  }
  /**
   * Pedals whose input drags down the previous pedal's output: the output after each pedal in the whole
   * chain (`after`) against the same chain cut off after that pedal (nothing loading it).
   */
  function loadings(after: number[][]): Loading[] {
    const on = onPedals(), out: Loading[] = [];
    const t = term(), unloadedTerm = t ? { src: t.src, load: { ...t.load, on: false } } : null;
    for (let k = 0; k + 1 < on.length; k++) {
      const stages = on.slice(0, k + 1).map(p => host.ex(p.tab)!.netlist);
      const { netlist } = joinStages(stages);
      const unloaded = simulate({ netlist, pinNet: new Map(), nets: new Map(), issues: [] }, [], freqs, unloadedTerm).out.mag;
      const from = host.ex(on[k].tab)!, to = host.ex(on[k + 1].tab)!;
      const l = loadingOf(nameOf(on[k].tab), nameOf(on[k + 1].tab), freqs, after[k], unloaded, impedances(from, 1000).zout, impedances(to, 1000).zin);
      if (l) out.push(l);
    }
    return out;
  }
  function draw(): void {
    const cv = $<HTMLCanvasElement>('#pbPlot');
    if (cmp) {
      if (!cmp.length) { cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height); $('#pbLegend').innerHTML = ''; return; }
      const series: PlotSeries[] = cmp.map(c => ({ vals: c.mag, color: c.color, width: 2, label: c.label }));
      const [y0, y1] = magRange(series.map(s => s.vals));
      drawPlot(cv, { freqs, fr: fRange(), y0, y1, step: (y1 - y0) > 48 ? 12 : 6, unit: '', hoverF, series });
      $('#pbLegend').innerHTML = cmp.map(c => `<span><span class="sw" style="background:${c.color}"></span>${esc(c.label)}</span>`).join('');
      return;
    }
    if (!res) { cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height); $('#pbLegend').innerHTML = ''; return; }
    const series: PlotSeries[] = [
      ...res.probes.map(p => ({ vals: p.mag, color: p.color, width: 1.6, dash: [5, 3], label: p.ref })),
      { vals: res.out.mag, color: cssVar('--accent'), width: 2.4, label: 'Board output' },
    ];
    const [y0, y1] = magRange(series.map(s => s.vals));
    drawPlot(cv, { freqs, fr: fRange(), y0, y1, step: (y1 - y0) > 48 ? 12 : 6, unit: '', hoverF, series });
    $('#pbLegend').innerHTML = [`<span><span class="sw" style="background:${cssVar('--accent')}"></span>Board output</span>`,
      ...res.probes.map(p => `<span><span class="sw" style="background:repeating-linear-gradient(90deg, ${p.color} 0 4px, transparent 4px 7px)"></span>${esc(p.ref)}</span>`)].join('');
  }
  const cv = $<HTMLCanvasElement>('#pbPlot');
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), u = (e.clientX - r.left - PLOT_MARGIN.l) / (r.width - PLOT_MARGIN.l - PLOT_MARGIN.r);
    const [a, b] = fRange();
    hoverF = u >= 0 && u <= 1 ? a * Math.pow(b / a, u) : null;
    draw();
  });
  cv.addEventListener('pointerleave', () => { hoverF = null; draw(); });
  new ResizeObserver(() => draw()).observe(cv);
  for (const id of ['#range']) document.querySelector(id)?.addEventListener('change', () => schedule());

  showState();
  renderMode();
  renderStrip();

  return {
    shown: () => { renderStrip(); schedule(); sound.redraw(); void refreshFolder(); },
    changed: id => {
      if (!visible()) { sound.invalidate(); return; }
      const doc = id ? host.doc(id) : null;
      if (id && doc && panels.has(id)) { panels.get(id)!.sync(doc); updateBadges(); }
      else renderStrip();
      if (!id || board.pedals.some(p => p.tab === id)) { sound.invalidate(); schedule(); }
    },
    open,
    unsaved: () => board.dirty && board.pedals.length > 0,
  };
}
