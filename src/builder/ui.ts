// Pedal Builder UI: palette, toolbar, properties, ERC list and a live response preview.
import { Cx } from '../core/complex';
import { stepSeries } from '../core/eseries';
import { TAPERS } from '../core/pots';
import { TAU, db, fmtEng, parseEng } from '../core/units';
import { Circuit } from '../engine/mna';
import { DIODE_MODELS, OPAMP_MODELS } from '../engine/models';
import { extract, type Extraction } from '../schematic/extract';
import { PARTS } from '../schematic/library';
import { renderSchematic } from '../schematic/render';
import type { PartKind, SchPart, Schematic } from '../schematic/types';
import { freqGrid } from '../playground/analysis';
import { S, fRange } from '../playground/state';
import { cssVar, drawPlot, magRange, PLOT_MARGIN } from '../ui/plot';
import { emptyDoc, updatePart } from './doc';
import { Editor, type Mode } from './editor';

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
  let hoverF: number | null = null;
  let plot: { freqs: number[]; mag: number[]; ph: number[] } | null = null;

  const editor = new Editor(document.querySelector<SVGSVGElement>('#bCanvas')!, $('#bCanvasWrap'), saved.doc, {
    change: (doc, committed) => { ex = extract(doc); renderErc(); scheduleSim(); if (committed) { save(); renderProps(); } updateToolbar(); },
    select: () => renderProps(),
    mode: (mode, kind) => renderModes(mode, kind),
    edit: () => {
      renderProps();
      const inp = document.querySelector<HTMLInputElement>(`#bProps [data-field="value"]`) || document.querySelector<HTMLInputElement>(`#bProps [data-field="ref"]`);
      inp?.focus(); inp?.select();
    },
  });
  if (saved.view) editor.setView(saved.view);

  function save(): void {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ doc: editor.doc, view: editor.getView() })); } catch { /* ignore */ }
  }

  /* ---------- Palette & toolbar ---------- */
  $('#bPalette').innerHTML = PALETTE.map(g => `<div class="group">${g.group}</div><div class="pal-grid">${g.kinds.map(k => {
    const part: SchPart = { id: 'x', kind: k, x: 0, y: 0, rot: 0, props: k === 'POT' || k === 'RHEO' ? { turn: 0.5 } : k === 'SPDT' ? { pos: 'a' } : undefined };
    return `<button class="pal" data-kind="${k}" title="${esc(PARTS[k].label)}">${renderSchematic({ version: 1, parts: [part], wires: [] }, { bare: true, title: PARTS[k].label })}<span>${esc(PARTS[k].label)}</span></button>`;
  }).join('')}</div>`).join('');
  $('#bPalette').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
    if (b) editor.setMode('place', b.dataset.kind as PartKind);
  });

  function renderModes(mode: Mode, kind: PartKind | null): void {
    document.querySelectorAll<HTMLElement>('#bPalette [data-kind]').forEach(b => b.classList.toggle('active', mode === 'place' && b.dataset.kind === kind));
    $('#bToolSelect').classList.toggle('active', mode === 'select');
    $('#bToolWire').classList.toggle('active', mode === 'wire');
    $('#bHint').textContent = mode === 'wire'
      ? 'Click to start a wire, click to bend it; it finishes on a pin or another wire (or double-click / right-click). Esc cancels.'
      : mode === 'place' ? `Click to place a ${PARTS[kind!].label.toLowerCase()}. R rotates, M mirrors, Esc stops placing.`
        : 'Drag to move (wires follow). Drag on empty space to box-select. Space+drag or middle-drag pans; wheel zooms.';
  }

  const actions: Record<string, () => void> = {
    bToolSelect: () => editor.setMode('select'),
    bToolWire: () => editor.setMode('wire'),
    bRotate: () => editor.rotate(),
    bMirror: () => editor.mirror(),
    bDelete: () => editor.deleteSel(),
    bUndo: () => editor.undo(),
    bRedo: () => editor.redo(),
    bFit: () => editor.fit(),
    bNew: () => { if (confirm('Start a new, empty pedal? (You can undo this.)')) editor.load(emptyDoc()); },
  };
  for (const [id, fn] of Object.entries(actions)) $('#' + id).addEventListener('click', fn);
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
        <table class="keys"><tr><td>W</td><td>Wire tool</td></tr><tr><td>V / Esc</td><td>Select tool</td></tr>
        <tr><td>R / M</td><td>Rotate / mirror</td></tr><tr><td>Del</td><td>Delete</td></tr>
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
    if (p.kind === 'OA') h += row('Model', `<select data-field="model">${Object.entries(OPAMP_MODELS).map(([k, m]) => `<option value="${k}" ${p.props?.model === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`);
    if (p.kind === 'D' || p.kind === 'LED') h += row('Model', `<select data-field="model">${Object.entries(DIODE_MODELS).map(([k, m]) => `<option value="${k}" ${p.props?.model === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`);
    if (p.kind === 'SW') h += row('State', `<select data-field="closed"><option value="1" ${p.props?.closed ? 'selected' : ''}>Closed</option><option value="0" ${!p.props?.closed ? 'selected' : ''}>Open</option></select>`);
    if (p.kind === 'SPDT') h += row('Position', `<select data-field="pos"><option value="a" ${p.props?.pos !== 'b' ? 'selected' : ''}>To A (upper)</option><option value="b" ${p.props?.pos === 'b' ? 'selected' : ''}>To B (lower)</option></select>`);
    if (p.kind === 'LABEL' || p.kind === 'SUPPLY') h += row('Net name', `<input type="text" data-field="name" value="${esc(p.props?.name || '')}" spellcheck="false">`);
    if (p.kind === 'SUPPLY') h += row('Voltage', `<span class="valrow"><input type="text" data-field="value" value="${esc(p.value ?? 9)}"><span class="unit">V</span></span>`);
    if (p.kind === 'D' || p.kind === 'LED') h += '<p class="hint">Diodes count as off (open) in this small-signal analysis; their clipping isn\'t simulated yet.</p>';
    if (p.kind === 'SUPPLY') h += '<p class="hint">Supplies are AC ground in the frequency response.</p>';
    h += `<div class="btnrow"><button data-act="rotate" title="R">Rotate</button><button data-act="mirror" title="M">Mirror</button><button data-act="delete">Delete</button></div>`;
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

  /* ---------- Response preview ---------- */
  let simTimer = 0;
  function scheduleSim(): void {
    cancelAnimationFrame(simTimer);
    simTimer = requestAnimationFrame(runSim);
  }
  function runSim(): void {
    const errs = ex.issues.filter(i => i.severity === 'error');
    const msg = $('#bSimMsg');
    if (errs.length) {
      plot = null;
      msg.textContent = 'Fix the errors listed under Checks to see the response.';
      drawSim();
      return;
    }
    const c = new Circuit(ex.netlist), freqs = freqGrid(...fRange(), 300);
    const mag: number[] = [], ph: number[] = [];
    for (const f of freqs) { const h = c.transfer(new Cx(0, TAU * f)); mag.push(db(h.abs())); ph.push(h.arg() * 180 / Math.PI); }
    plot = { freqs, mag, ph };
    const at = (f: number) => db(c.transfer(new Cx(0, TAU * f)).abs());
    msg.textContent = `Output level: ${fmt(at(100))} @ 100 Hz · ${fmt(at(1000))} @ 1 kHz · ${fmt(at(5000))} @ 5 kHz (small-signal, ideal source and load).`;
    drawSim();
  }
  const fmt = (x: number) => (isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)} dB` : '—');
  function drawSim(): void {
    const cv = $<HTMLCanvasElement>('#bSimCanvas');
    if (!plot) { const g = cv.getContext('2d'); g?.clearRect(0, 0, cv.width, cv.height); return; }
    const [y0, y1] = magRange([plot.mag]);
    drawPlot(cv, {
      freqs: plot.freqs, fr: fRange(), y0, y1, step: (y1 - y0) > 48 ? 12 : 6, unit: '', hoverF,
      series: [{ vals: plot.mag, color: cssVar('--accent'), width: 2.2, label: 'Output' }],
    });
  }
  const cv = $<HTMLCanvasElement>('#bSimCanvas');
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), u = (e.clientX - r.left - PLOT_MARGIN.l) / (r.width - PLOT_MARGIN.l - PLOT_MARGIN.r);
    const [a, b] = fRange();
    hoverF = u >= 0 && u <= 1 ? a * Math.pow(b / a, u) : null;
    drawSim();
  });
  cv.addEventListener('pointerleave', () => { hoverF = null; drawSim(); });
  new ResizeObserver(() => drawSim()).observe(cv);

  renderModes('select', null);
  renderProps();
  renderErc();
  updateToolbar();
  scheduleSim();

  return {
    load: doc => { editor.load(JSON.parse(JSON.stringify(doc))); editor.selectIds([]); },
    shown: () => { editor.render(); if (!saved.view) editor.fit(); drawSim(); },
  };
}

function loadSaved(): { doc: Schematic; view?: { x: number; y: number; zoom: number } } {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && s.doc && Array.isArray(s.doc.parts) && Array.isArray(s.doc.wires)) return s;
  } catch { /* ignore */ }
  return { doc: emptyDoc() };
}

