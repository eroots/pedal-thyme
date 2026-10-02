// Builder file toolbar: pedal name, New (templates), Open, Save and Export.
import { termActive } from '../core/termination';
import { fRange } from '../playground/state';
import { download } from '../ui/download';
import type { Editor } from './editor';
import { decodeLtspice } from '../ltspice/asc';
import { exportAsc } from '../ltspice/export';
import { importAsc } from '../ltspice/import';
import { bomCsv, makeProject, parseProject, projectSpice, safeFileName, schematicSvg, svgToPng } from './files';
import type { Trace } from './trace';
import type { SimPanel } from './simpanel';
import { TEMPLATES } from './templates';

const NAME_KEY = 'pedal-filter-lab.builder.name';
const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** LTspice reads schematics as Latin-1; keep comments readable there. */
function latin1(text: string): Uint8Array<ArrayBuffer> {
  const t = text.replace(/Ω/g, 'ohm').replace(/[–—]/g, '-').replace(/≈/g, '~').replace(/…/g, '...').replace(/→/g, '->').replace(/×/g, 'x').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return Uint8Array.from(t, c => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
}

export function initFileBar(editor: Editor, sim: SimPanel, trace: { set(t: Trace | null): void }): void {
  const nameEl = $('#bName');
  try { nameEl.value = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }
  const name = () => nameEl.value.trim() || 'Untitled pedal';
  const setName = (n: string) => { nameEl.value = n; try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } };
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
    editor.load(t.build());
    setName(t.id === 'empty' ? '' : t.name);
  });

  // Import notes (LTspice substitutions and the like).
  const notice = $<HTMLDivElement>('#bNotice');
  const showNotice = (title: string, items: string[]) => {
    notice.hidden = false;
    notice.innerHTML = `<button class="close" aria-label="Dismiss">×</button><b>${esc(title)}</b>` +
      (items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
  };
  notice.addEventListener('click', e => { if ((e.target as Element).closest('.close')) notice.hidden = true; });

  // Open a project file, or import an LTspice schematic (with any .asy symbol files selected alongside it).
  $('#bOpen').addEventListener('change', async e => {
    const input = e.target as HTMLInputElement, files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    const asc = files.find(f => /\.asc$/i.test(f.name));
    try {
      if (asc) {
        const asy: Record<string, string> = {};
        for (const f of files.filter(f => /\.asy$/i.test(f.name))) asy[f.name] = decodeLtspice(new Uint8Array(await f.arrayBuffer()));
        const r = importAsc(decodeLtspice(new Uint8Array(await asc.arrayBuffer())), asy);
        editor.load(r.schematic);
        setName(asc.name.replace(/\.asc$/i, ''));
        const n = r.stats.parts;
        showNotice(`Imported ${asc.name}: ${n} part${n === 1 ? '' : 's'}${r.stats.skipped ? `, ${r.stats.skipped} skipped` : ''}.`, r.report);
        return;
      }
      const f = files[0];
      if (/\.asy$/i.test(f.name)) throw new Error('select the .asc schematic together with its .asy symbol files.');
      const p = parseProject(await f.text());
      editor.load(p.schematic);
      if (p.view) editor.setView(p.view);
      if (p.sim) sim.apply(p.sim);
      trace.set(p.trace ?? null);
      setName(p.name);
      notice.hidden = true;
    } catch (err) {
      alert(`Couldn’t open ${(asc ?? files[0]).name}: ${(err as Error).message}`);
    }
  });

  // Save the project.
  $('#bSave').addEventListener('click', () => {
    const p = makeProject(name(), editor.doc, sim.settings(), editor.getView(), editor.trace);
    download(`${safeFileName(name())}.pfl.json`, JSON.stringify(p, null, 2), 'application/json');
  });

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
}
