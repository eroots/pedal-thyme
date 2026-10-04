// Builder file toolbar: pedal name, New (templates), Folder, Open, Save / Save as, and Export.
import { termActive } from '../core/termination';
import { fRange } from '../playground/state';
import { download } from '../ui/download';
import type { Editor } from './editor';
import { decodeLtspice } from '../ltspice/asc';
import { exportAsc } from '../ltspice/export';
import { importAsc } from '../ltspice/import';
import { bomCsv, makeProject, parseProject, projectSpice, safeFileName, schematicSvg, svgToPng } from './files';
import type { TraceMenu } from './trace';
import type { SimPanel } from './simpanel';
import { TEMPLATES } from './templates';
import { ProjectFolder, allowed, canSaveAs, canWriteFolders, saveAsDialog, writeHandle, type FolderEntry } from './folder';

const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** LTspice reads schematics as Latin-1; keep comments readable there. */
function latin1(text: string): Uint8Array<ArrayBuffer> {
  const t = text.replace(/Ω/g, 'ohm').replace(/[–—]/g, '-').replace(/≈/g, '~').replace(/…/g, '...').replace(/→/g, '->').replace(/×/g, 'x').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return Uint8Array.from(t, c => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
}

/** The open document's file details (kept per tab). */
export interface FileState { name: string; file: FileSystemFileHandle | null; dirty: boolean }

/** What the file bar needs from the tabs around it. */
export interface FileHost {
  /**
   * About to open or create a schematic: make room for it (a new tab, unless the current one is blank).
   * Returns false when `file` is already open in a tab, which is then shown instead.
   */
  beforeOpen(file: FileSystemFileHandle | null): Promise<boolean>;
  /** The name, file or saved state changed. */
  meta(): void;
}

export interface FileBar {
  /** The document changed (marks unsaved changes). */
  changed(): void;
  state(): FileState;
  /** Show another tab's file details. */
  setState(s: FileState): void;
}

export function initFileBar(editor: Editor, sim: SimPanel, trace: TraceMenu, host: FileHost): FileBar {
  const nameEl = $('#bName');
  const name = () => nameEl.value.trim() || 'Untitled pedal';
  const setName = (n: string) => { nameEl.value = n; host.meta(); };
  nameEl.addEventListener('input', () => host.meta());
  nameEl.addEventListener('change', () => setName(nameEl.value.trim()));

  const closeMenus = () => document.querySelectorAll<HTMLDetailsElement>('.b-filebar details[open]').forEach(d => { d.open = false; });
  document.addEventListener('click', e => { if (!(e.target as Element).closest('.b-filebar details')) closeMenus(); });

  // New from a template (undoable).
  $('#bTemplates').innerHTML = TEMPLATES.map(t =>
    `<button data-template="${t.id}"><b>${esc(t.name)}</b><span>${esc(t.description)}</span></button>`).join('');
  $('#bTemplates').addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-template]');
    if (!b) return;
    closeMenus();
    const t = TEMPLATES.find(x => x.id === b.dataset.template)!;
    void host.beforeOpen(null).then(async () => {
      editor.load(t.build());
      setName(t.id === 'empty' ? '' : t.name);
      await folder.setCurrent(null);
      dirty = t.id !== 'empty';
      showState();
    });
  });

  // Import notes (LTspice substitutions and the like).
  const notice = $<HTMLDivElement>('#bNotice');
  const showNotice = (title: string, items: string[]) => {
    notice.hidden = false;
    notice.innerHTML = `<button class="close" aria-label="Dismiss">×</button><b>${esc(title)}</b>` +
      (items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
  };
  notice.addEventListener('click', e => { if ((e.target as Element).closest('.close')) notice.hidden = true; });

  /* ---------- Opening ---------- */
  const folder = new ProjectFolder();
  let dirty = false;
  const stateEl = $<HTMLSpanElement>('#bSaveState');
  const showState = () => {
    const file = folder.current?.name;
    stateEl.textContent = dirty ? (file ? `${file} · unsaved changes` : 'Not saved') : file ? `Saved · ${file}` : '';
    stateEl.classList.toggle('dirty', dirty);
    stateEl.title = folder.name ? `Folder: ${folder.name}` : '';
    host.meta();
  };

  /** Open a schematic file: a project (.pfl.json/.json) or an LTspice .asc (with any .asy symbols). */
  async function openFile(file: File, handle: FileSystemFileHandle | null, symbols: { name: string; text: string }[] = []): Promise<void> {
    if (!(await host.beforeOpen(handle))) return;
    if (/\.asc$/i.test(file.name)) {
      const asy = Object.fromEntries(symbols.map(s => [s.name, s.text]));
      const r = importAsc(decodeLtspice(new Uint8Array(await file.arrayBuffer())), asy);
      editor.load(r.schematic);
      setName(file.name.replace(/\.asc$/i, ''));
      const n = r.stats.parts;
      showNotice(`Imported ${file.name}: ${n} part${n === 1 ? '' : 's'}${r.stats.skipped ? `, ${r.stats.skipped} skipped` : ''}. Save keeps it as a new .pfl.json; the .asc is left as it is.`, r.report);
      await folder.setCurrent(null);
      dirty = true;
    } else {
      const p = parseProject(await file.text());
      editor.load(p.schematic);
      if (p.view) editor.setView(p.view);
      if (p.sim) sim.apply(p.sim);
      trace.set(p.trace ?? null);
      setName(p.name);
      notice.hidden = true;
      await folder.setCurrent(handle);
      dirty = false;
    }
    showState();
  }

  // Open a project file, or import an LTspice schematic (with any .asy symbol files selected alongside it).
  $('#bOpen').addEventListener('change', async e => {
    const input = e.target as HTMLInputElement, files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    const main = files.find(f => /\.asc$/i.test(f.name)) ?? files.find(f => !/\.asy$/i.test(f.name));
    try {
      if (!main) throw new Error('select the .asc schematic together with its .asy symbol files.');
      const symbols = await Promise.all(files.filter(f => /\.asy$/i.test(f.name)).map(async f => ({ name: f.name, text: decodeLtspice(new Uint8Array(await f.arrayBuffer())) })));
      await openFile(main, null, symbols);
    } catch (err) {
      alert(`Couldn’t open ${(main ?? files[0]).name}: ${(err as Error).message}`);
    }
  });

  /* ---------- Folder ---------- */
  const folderEl = $<HTMLDivElement>('#bFolder');
  let listed: FolderEntry[] = [], symbolsListed: FolderEntry[] = [];
  async function renderFolder(ask = false): Promise<void> {
    const nameHtml = folder.name ? `<p class="folder-name">📁 <b>${esc(folder.name)}</b></p>` : '';
    const chooseLabel = folder.name ? 'Choose a different folder…' : 'Choose folder…';
    if (canWriteFolders && folder.dir && (await folder.needsPermission()) && !ask) {
      folderEl.innerHTML = `${nameHtml}<button data-folder="allow"><b>Open this folder again</b><span>The browser asks once per session.</span></button><button data-folder="choose">${chooseLabel}</button>`;
      return;
    }
    const { schematics, symbols } = await folder.list(ask);
    listed = schematics; symbolsListed = symbols;
    const current = folder.current?.name;
    const items = schematics.length
      ? schematics.map((e, i) => `<button data-entry="${i}" class="folder-file${e.name === current ? ' current' : ''}">${esc(e.name)}</button>`).join('')
      : folder.name ? '<p class="hint">No schematics here yet (.pfl.json or .asc).</p>' : '';
    const note = canWriteFolders
      ? (folder.name ? '' : '<p class="hint">Pick the folder where you keep your schematics. Save then writes straight into it.</p>')
      : '<p class="hint">This browser can’t save into folders (Chrome and Edge can), so Save downloads the file. You can still pick a folder to open its schematics from here.</p>';
    folderEl.innerHTML = `${nameHtml}${note}<div class="folder-list">${items}</div>` +
      `<div class="folder-actions">${folder.name ? '<button data-folder="refresh">Refresh</button>' : ''}<button data-folder="choose">${chooseLabel}</button></div>`;
  }
  $<HTMLDetailsElement>('#bFolderMenu').addEventListener('toggle', e => { if ((e.target as HTMLDetailsElement).open) void renderFolder(); });
  folderEl.addEventListener('click', async e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    try {
      if (b.dataset.folder === 'choose') {
        if (canWriteFolders) { if (await folder.choose()) await renderFolder(true); }
        else $<HTMLInputElement>('#bFolderInput').click();
      } else if (b.dataset.folder === 'allow' || b.dataset.folder === 'refresh') {
        await renderFolder(true);
      } else if (b.dataset.entry) {
        const entry = listed[+b.dataset.entry];
        closeMenus();
        const symbols = /\.asc$/i.test(entry.name)
          ? await Promise.all(symbolsListed.map(async s => ({ name: s.name, text: decodeLtspice(new Uint8Array(await (await s.read()).arrayBuffer())) })))
          : [];
        await openFile(await entry.read(), entry.handle ?? null, symbols);
      }
    } catch (err) {
      alert(`Folder: ${(err as Error).message}`);
    }
  });
  // Fallback folder picker (Firefox, Safari): read-only listing for this session.
  $<HTMLInputElement>('#bFolderInput').addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    folder.useFiles([...(input.files ?? [])]);
    input.value = '';
    $<HTMLDetailsElement>('#bFolderMenu').open = true;
    void renderFolder();
  });

  /* ---------- Saving ---------- */
  async function save(as: boolean): Promise<void> {
    const data = JSON.stringify(makeProject(name(), editor.doc, sim.settings(), editor.getView(), editor.trace), null, 2);
    const fileName = `${safeFileName(name())}.pfl.json`;
    try {
      if (!canWriteFolders && !canSaveAs) {
        download(fileName, data, 'application/json');
      } else if (!as && folder.current) {
        await writeHandle(folder.current, data);
      } else if (!as && folder.dir && (await allowed(folder.dir, 'readwrite', true))) {
        if ((await folder.has(fileName)) && !confirm(`${fileName} already exists in “${folder.name}”. Replace it?`)) return;
        await folder.setCurrent(await folder.write(fileName, data));
      } else if (canSaveAs) {
        const fh = await saveAsDialog(fileName, data, folder.dir);
        if (!fh) return;
        await folder.setCurrent(fh);
      } else {
        download(fileName, data, 'application/json');
      }
      dirty = false;
      showState();
      if ($<HTMLDetailsElement>('#bFolderMenu').open) void renderFolder();
    } catch (err) {
      alert(`Couldn’t save: ${(err as Error).message}`);
    }
  }
  $('#bSave').addEventListener('click', () => void save(false));
  $('#bSaveAs').addEventListener('click', () => void save(true));
  if (!canWriteFolders && !canSaveAs) {
    $('#bSave').title = 'Download this pedal as a .pfl.json file (Ctrl+S)';
    $('#bSaveAs').hidden = true;
  }
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$<HTMLElement>('#builder').hidden) { e.preventDefault(); void save(e.shiftKey); }
  });
  void folder.restore().then(showState);

  // Exports.
  $('#bExportMenu').addEventListener('click', async e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-export]');
    if (!b) return;
    closeMenus();
    const base = safeFileName(name());
    switch (b.dataset.export) {
      case 'asc': {
        const [fmin, fmax] = fRange();
        const blob = new Blob([latin1(exportAsc(editor.doc, { title: name(), fmin, fmax }))], { type: 'text/plain' });
        download(`${base}.asc`, blob);
        break;
      }
      case 'spice': {
        const st = sim.settings(), [fmin, fmax] = fRange();
        download(`${base}.cir`, projectSpice(name(), editor.doc, termActive(st.term) ? st.term : null, fmin, fmax));
        break;
      }
      case 'bom': download(`${base}-parts.csv`, bomCsv(name(), editor.doc), 'text/csv'); break;
      case 'svg': download(`${base}.svg`, schematicSvg(name(), editor.doc).svg, 'image/svg+xml'); break;
      case 'png': {
        const { svg, width, height } = schematicSvg(name(), editor.doc);
        try { download(`${base}.png`, await svgToPng(svg, width, height)); } catch (err) { alert((err as Error).message); }
        break;
      }
    }
  });

  return {
    changed: () => { if (!dirty) { dirty = true; showState(); } },
    state: () => ({ name: nameEl.value.trim(), file: folder.current, dirty }),
    setState: s => {
      nameEl.value = s.name;
      folder.current = s.file;
      dirty = s.dirty;
      notice.hidden = true;
      showState();
    },
  };
}
