// Pedal Builder UI: palette, toolbar, properties and ERC list; wires up the simulation panel and front panel.
import { stepSeries } from '../core/eseries';
import { TAPERS } from '../core/pots';
import { fmtEng, parseEng } from '../core/units';
import { DIODE_MODELS, OPAMP_MODELS } from '../engine/models';
import { extract, type Extraction } from '../schematic/extract';
import { PARTS } from '../schematic/library';
import { renderSchematic } from '../schematic/render';
import type { PartKind, SchPart, Schematic } from '../schematic/types';
import { S } from '../playground/state';
import { emptyDoc, updatePart } from './doc';
import { Editor, PART_KEYS, type DragMode, type Mode } from './editor';
import { initFrontPanel } from './frontpanel';
import { initSimPanel } from './simpanel';
import { SWEEPABLE_KINDS } from './sim';

const LS_KEY = 'pedal-filter-lab.builder.v1';
const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PALETTE: { group: string; kinds: PartKind[] }[] = [
  { group: 'Passive', kinds: ['R', 'C', 'L'] },
  { group: 'Controls', kinds: ['POT', 'RHEO', 'SW', 'SPDT'] },
  { group: 'Semiconductors', kinds: ['D', 'LED'] },
  { group: 'Active', kinds: ['OA', 'BUF'] },
  { group: 'Connections', kinds: ['IN', 'OUT', 'GND', 'SUPPLY', 'LABEL'] },
  { group: 'Measure', kinds: ['PROBE'] },
];

export interface BuilderApi {
  /** Replace the document (undoable) and fit it in view. */
  load(doc: Schematic): void;
  /** Called when the Builder section becomes visible (sizes the canvas). */
  shown(): void;
}

export function initBuilder(): BuilderApi {
  const saved = loadSaved();
  let ex: Extraction = extract(saved.doc);

  const editor = new Editor(document.querySelector<SVGSVGElement>('#bCanvas')!, $('#bCanvasWrap'), saved.doc, {
    change: (doc, committed) => {
      ex = extract(doc); renderErc(); sim.update(doc, ex, committed); panel.sync(doc);
      if (committed) { save(); renderProps(); }
      updateToolbar();
    },
    select: () => renderProps(),
    mode: (mode, kind) => renderModes(mode, kind),
    dragMode: m => renderDragMode(m),
    edit: () => {
      renderProps();
      const inp = document.querySelector<HTMLInputElement>(`#bProps [data-field="value"]`) || document.querySelector<HTMLInputElement>(`#bProps [data-field="ref"]`);
      inp?.focus(); inp?.select();
    },
  });
  if (saved.view) editor.setView(saved.view);
  const sim = initSimPanel();
  const panel = initFrontPanel($('#bKnobs'), editor);

  function save(): void {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ doc: editor.doc, view: editor.getView() })); } catch { /* ignore */ }
  }

  /* ---------- Palette & toolbar ---------- */
  $('#bPalette').innerHTML = PALETTE.map(g => `<div class="group">${g.group}</div><div class="pal-grid">${g.kinds.map(k => {
    const part: SchPart = { id: 'x', kind: k, x: 0, y: 0, rot: 0, props: k === 'POT' || k === 'RHEO' ? { turn: 0.5 } : k === 'SPDT' ? { pos: 'a' } : undefined };
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
    $('#bDelete').classList.toggle('active', mode === 'delete');
    $('#bHint').textContent = mode === 'delete'
      ? 'Delete mode: click a part or wire segment to delete it, or drag a box to delete everything inside. Esc or right-click to stop.'
      : mode === 'wire'
      ? 'Click to start a wire, click to bend it; it finishes on a pin or another wire (or double-click / right-click). Esc cancels.'
      : mode === 'place' ? `Click to place a ${PARTS[kind!].label.toLowerCase()}. Right-click or Ctrl+R rotates, Ctrl+E mirrors, Esc stops placing.`
        : 'Drag parts to stretch (wires follow) or move (detach): see the toolbar, or hold Alt to switch for one drag. Drag on empty space to box-select. Space+drag or middle-drag pans; wheel zooms.';
  }

  const actions: Record<string, () => void> = {
    bToolSelect: () => editor.setMode('select'),
    bToolWire: () => editor.setMode('wire'),
    bDragStretch: () => editor.setDragMode('stretch'),
    bDragMove: () => editor.setDragMode('move'),
    bRotate: () => editor.rotate(),
    bMirror: () => editor.mirror(),
    bDelete: () => editor.deleteOrMode(),
    bUndo: () => editor.undo(),
    bRedo: () => editor.redo(),
    bFit: () => editor.fit(),
    bNew: () => { if (confirm('Start a new, empty pedal? (You can undo this.)')) editor.load(emptyDoc()); },
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
    if (!sel.length) {
      el.innerHTML = `<h2>Properties</h2><p class="hint">Select a part to edit it, or pick one from the palette to place it.</p>
        <table class="keys"><tr><td>R C L D</td><td>Resistor, capacitor, inductor, diode</td></tr>
        <tr><td>G P O</td><td>Ground, pot, op-amp</td></tr>
        <tr><td>W</td><td>Wire tool</td></tr><tr><td>V / Esc</td><td>Select tool</td></tr>
        <tr><td>S / M</td><td>Drag stretches / moves (Alt flips)</td></tr>
        <tr><td>Ctrl+R / Ctrl+E</td><td>Rotate / mirror</td></tr><tr><td>Del</td><td>Delete selection, or delete mode</td></tr>
        <tr><td>Ctrl+Z / Y</td><td>Undo / redo</td></tr><tr><td>Ctrl+C / V / D</td><td>Copy / paste / duplicate</td></tr>
        <tr><td>Arrows</td><td>Nudge</td></tr><tr><td>F</td><td>Fit to view</td></tr></table>`;
      return;
    }
    if (parts.length !== 1 || wires.length) {
      el.innerHTML = `<h2>Properties</h2><p>${parts.length ? `${parts.length} part${parts.length > 1 ? 's' : ''}` : ''}${parts.length && wires.length ? ', ' : ''}${wires.length ? `${wires.length} wire${wires.length > 1 ? 's' : ''}` : ''} selected.</p>
        <div class="btnrow"><button data-act="rotate">Rotate</button><button data-act="delete">Delete</button></div>`;
      return;
    }
    const p = parts[0], spec = PARTS[p.kind];
    const row = (label: string, html: string) => `<label class="prop"><span>${label}</span>${html}</label>`;
    let h = `<h2>${esc(spec.label)}</h2>`;
    if (spec.elements(p, () => '0').length && p.kind !== 'SUPPLY') h += row('Reference', `<input type="text" data-field="ref" value="${esc(p.ref || '')}" spellcheck="false">`);
    if (spec.unit && p.kind !== 'SUPPLY') {
      const stepper = p.kind === 'R' || p.kind === 'C' || p.kind === 'POT' || p.kind === 'RHEO';
      h += row('Value', `<span class="valrow">${stepper ? '<button data-step="-1" aria-label="Previous standard value">‹</button>' : ''}<input type="text" data-field="value" value="${esc(fmtEng(p.value))}" spellcheck="false">${stepper ? '<button data-step="1" aria-label="Next standard value">›</button>' : ''}<span class="unit">${spec.unit}</span></span>`);
    }
    if (p.kind === 'POT' || p.kind === 'RHEO') {
      h += row('Taper', `<select data-field="taper">${Object.entries(TAPERS).map(([k, t]) => `<option value="${k}" ${p.props?.taper === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`);
      const turn = Math.round((p.props?.turn ?? 0.5) * 100);
      h += row(`Rotation <output>${turn}%</output>`, `<input type="range" data-field="turn" min="0" max="100" value="${turn}">`);
    }
    if (SWEEPABLE_KINDS.includes(p.kind)) {
      h += row('Sweepable', `<span class="chk"><input type="checkbox" data-field="sweep" ${p.props?.sweep ? 'checked' : ''}> <span class="hint">offer ${p.kind === 'POT' || p.kind === 'RHEO' ? 'its rotation and value' : 'its value'} in the Sweep menu</span></span>`);
    }
    if (p.kind === 'OA') h += row('Model', `<select data-field="model">${Object.entries(OPAMP_MODELS).map(([k, m]) => `<option value="${k}" ${p.props?.model === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`);
    if (p.kind === 'D' || p.kind === 'LED') h += row('Model', `<select data-field="model">${Object.entries(DIODE_MODELS).map(([k, m]) => `<option value="${k}" ${p.props?.model === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`);
    if (p.kind === 'SW') h += row('State', `<select data-field="closed"><option value="1" ${p.props?.closed ? 'selected' : ''}>Closed</option><option value="0" ${!p.props?.closed ? 'selected' : ''}>Open</option></select>`);
    if (p.kind === 'SPDT') h += row('Position', `<select data-field="pos"><option value="a" ${p.props?.pos !== 'b' ? 'selected' : ''}>To A (upper)</option><option value="b" ${p.props?.pos === 'b' ? 'selected' : ''}>To B (lower)</option></select>`);
    if (p.kind === 'LABEL' || p.kind === 'SUPPLY') h += row('Net name', `<input type="text" data-field="name" value="${esc(p.props?.name || '')}" spellcheck="false">`);
    if (p.kind === 'SUPPLY') h += row('Voltage', `<span class="valrow"><input type="text" data-field="value" value="${esc(p.value ?? 9)}"><span class="unit">V</span></span>`);
    if (p.kind === 'D' || p.kind === 'LED') h += '<p class="hint">Diodes count as off (open) in this small-signal analysis; their clipping isn\'t simulated yet.</p>';
    if (p.kind === 'SUPPLY') h += '<p class="hint">Supplies are AC ground in the frequency response.</p>';
    h += `<div class="btnrow"><button data-act="rotate" title="Ctrl+R">Rotate</button><button data-act="mirror" title="Ctrl+E">Mirror</button><button data-act="delete">Delete</button></div>`;
    el.innerHTML = h;
    el.dataset.id = p.id;
  }

  const propEl = $('#bProps');
  const current = (): SchPart | undefined => editor.doc.parts.find(q => q.id === propEl.dataset.id && editor.sel.has(q.id));
  function applyField(el: HTMLInputElement, live: boolean): void {
    const p = current();
    if (!p) return;
    const f = el.dataset.field!;
    let patch: Partial<SchPart> | null = null;
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
    } else if (f === 'taper') patch = { props: { taper: el.value as 'A' | 'B' | 'C' } };
    else if (f === 'model') patch = { props: { model: el.value } };
    else if (f === 'closed') patch = { props: { closed: el.value === '1' } };
    else if (f === 'pos') patch = { props: { pos: el.value as 'a' | 'b' } };
    else if (f === 'name') patch = { props: { name: el.value.trim() } };
    else if (f === 'sweep') patch = { props: { sweep: el.checked || undefined } };
    if (!patch) return;
    const next = updatePart(editor.doc, p.id, patch);
    if (live) editor.preview(next); else editor.commit(next);
  }
  propEl.addEventListener('input', e => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.field && (el.type === 'range' || el.dataset.field === 'value')) applyField(el, true);
  });
  propEl.addEventListener('change', e => { const el = e.target as HTMLInputElement; if (el.dataset.field) applyField(el, false); });
  propEl.addEventListener('keydown', e => {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter' && el.dataset.field) { applyField(el, false); editor.commit(editor.doc); }
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
      ? `<ul class="erc">${ex.issues.map((i, k) => `<li class="${i.severity}" data-k="${k}">${i.severity === 'error' ? '✕' : '!'} ${esc(i.message)}</li>`).join('')}</ul>`
      : '<p class="hint">The circuit is complete: every pin is connected and every net has a DC path to ground.</p>';
  }
  $('#bErc').addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-k]');
    const issue = li && ex.issues[+li.dataset.k!];
    if (issue?.parts?.length) editor.selectIds(issue.parts);
  });

  let initialDrag: DragMode = 'stretch';
  try { if (localStorage.getItem(LS_KEY + '.drag') === 'move') initialDrag = 'move'; } catch { /* ignore */ }
  editor.setDragMode(initialDrag);
  renderModes('select', null);
  renderProps();
  renderErc();
  updateToolbar();
  sim.update(editor.doc, ex, true);
  panel.sync(editor.doc);

  return {
    load: doc => { editor.load(JSON.parse(JSON.stringify(doc))); editor.selectIds([]); },
    shown: () => { editor.render(); if (!saved.view) editor.fit(); sim.redraw(); },
  };
}

function loadSaved(): { doc: Schematic; view?: { x: number; y: number; zoom: number } } {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && s.doc && Array.isArray(s.doc.parts) && Array.isArray(s.doc.wires)) return s;
  } catch { /* ignore */ }
  return { doc: emptyDoc() };
}

