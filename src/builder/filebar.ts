// Builder file toolbar: pedal name, New (templates), Open, Save and Export.
import { termActive } from '../core/termination';
import { fRange } from '../playground/state';
import { download } from '../ui/download';
import type { Editor } from './editor';
import { bomCsv, makeProject, parseProject, projectSpice, safeFileName, schematicSvg, svgToPng } from './files';
import type { SimPanel } from './simpanel';
import { TEMPLATES } from './templates';

const NAME_KEY = 'pedal-filter-lab.builder.name';
const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function initFileBar(editor: Editor, sim: SimPanel): void {
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

  // Open a project file.
  $('#bOpen').addEventListener('change', async e => {
    const input = e.target as HTMLInputElement, f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const p = parseProject(await f.text());
      editor.load(p.schematic);
      if (p.view) editor.setView(p.view);
      if (p.sim) sim.apply(p.sim);
      setName(p.name);
    } catch (err) {
      alert(`Couldn’t open ${f.name}: ${(err as Error).message}`);
    }
  });

  // Save the project.
  $('#bSave').addEventListener('click', () => {
    const p = makeProject(name(), editor.doc, sim.settings(), editor.getView());
    download(`${safeFileName(name())}.pfl.json`, JSON.stringify(p, null, 2), 'application/json');
  });

  // Exports.
  $('#bExportMenu').addEventListener('click', async e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-export]');
    if (!b) return;
    closeMenus();
    const base = safeFileName(name());
    switch (b.dataset.export) {
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
