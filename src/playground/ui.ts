// Playground UI: rendering and event wiring. Call initPlayground() once the DOM is ready.
import { Cx } from '../core/complex';
import { stepSeries, R_SERIES, C_SERIES, type SeriesName } from '../core/eseries';
import { Hfull, edges } from '../core/measure';
import { termActive, termAt, type LoadTerm, type SourceTerm, type Term } from '../core/termination';
import { opAmpModel } from '../engine/models';
import { toSpice } from '../engine/spice';
import type { Opts, Values } from '../core/types';
import { TAU, db, fmtEng, parseEng } from '../core/units';
import { TOPOS, topoById } from '../topologies';
import type { Topology } from '../topologies/types';
import { cssVar, drawPlot, magRange, PLOT_MARGIN, type PlotMarker } from '../ui/plot';
import { freqGrid, response, toleranceCorners, valuesValid } from './analysis';
import { searchDesigns, snapAllValues, type DesignRow } from './design';
import { renderSchematic } from '../schematic/render';
import {
  S, COMPARE_COLORS, SRC_PRESETS, LOAD_PRESETS, SWEEP_TAPERS, cloneTerm, cur, fRange, persist, seriesFor,
  sweepColor, sweepSteps, sweepTargets, topo, type CompareItem, type SavedDesign, type Settings, type SweepTaper,
} from './state';

const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
/** Event target as a form control (covers input, select and their shared properties). */
const tgt = (e: Event) => e.target as HTMLInputElement;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const unitOf = (type: 'R' | 'C') => (type === 'R' ? 'Ω' : 'F');

function fmtMetric(val: number | null | undefined, unit: string): string {
  if (val == null || !isFinite(val)) return '—';
  if (unit === 'dB') return (val >= 0 ? '+' : '') + val.toFixed(1) + ' dB';
  if (unit === '') return val.toFixed(3);
  return fmtEng(val, unit);
}

/* ---------- Plot ---------- */
interface Curve { mag: number[]; ph: number[]; color: string; width: number; label: string; dash?: number[] }
interface PlotData { freqs: number[]; series: Curve[]; band: { lo: number[]; hi: number[] } | null; markers: PlotMarker[] }
let plotData: PlotData | null = null;
let hoverF: number | null = null;

function drawPlots(): void {
  if (!plotData) return;
  const { freqs, series, band, markers } = plotData;
  const [y0, y1] = magRange(series.map(s => s.mag).concat(band ? [band.hi] : []));
  drawPlot($<HTMLCanvasElement>('#magCanvas'), {
    freqs, fr: fRange(), y0, y1, step: (y1 - y0) > 48 ? 12 : 6, unit: '', band, markers, hoverF,
    series: series.map(s => ({ vals: s.mag, color: s.color, width: s.width, label: s.label, dash: s.dash })),
  });
  const pc = $<HTMLCanvasElement>('#phaseCanvas');
  pc.style.display = S.settings.showPhase ? 'block' : 'none';
  if (S.settings.showPhase) {
    drawPlot(pc, {
      freqs, fr: fRange(), y0: -180, y1: 180, step: 90, unit: '°', wrap: true, markers, hoverF,
      series: series.map(s => ({ vals: s.ph, color: s.color, width: s.width, label: s.label, dash: s.dash })),
    });
  }
}

/* ---------- Static panels ---------- */
function renderNav(): void {
  let html = '', group: string | null = null;
  for (const t of TOPOS) {
    if (t.group !== group) { group = t.group; html += `<div class="group">${esc(group)}</div>`; }
    html += `<button data-topo="${t.id}" class="${t.id === S.topoId ? 'active' : ''}">${esc(t.name)}</button>`;
  }
  $('#topoList').innerHTML = html;
}

function renderSettings(): void {
  const fill = <T,>(sel: string, opts: T[], val: T, fmt: (x: T) => string = x => String(x)) => {
    $(sel).innerHTML = opts.map(o => `<option value="${o}" ${String(o) === String(val) ? 'selected' : ''}>${fmt(o)}</option>`).join('');
  };
  fill<SeriesName>('#rSeries', R_SERIES, S.settings.rSeries);
  fill<SeriesName>('#cSeries', C_SERIES, S.settings.cSeries);
  fill('#rTol', [0.1, 1, 2, 5, 10], S.settings.rTol, x => `±${x}%`);
  fill('#cTol', [1, 2, 5, 10, 20], S.settings.cTol, x => `±${x}%`);
  $('#range').value = S.settings.range;
  $('#showTol').checked = S.settings.showTol;
  $('#showPhase').checked = S.settings.showPhase;
}

function renderTopo(): void {
  const t = topo(), p = cur(t);
  $('#topoName').textContent = t.name;
  $('#topoBlurb').textContent = t.blurb;

  $('#presetRow').innerHTML = t.presets && t.presets.length
    ? `<span>Preset</span><select id="presetSel"><option value="">Choose a starting point…</option>${t.presets.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('')}</select>`
    : '';

  $('#partsEditor').innerHTML = t.parts.map(x => `
    <div class="part" data-part="${x.key}">
      <label for="p-${x.key}">${x.key}${x.pot ? `<span class="pot">pot ${x.pot}</span>` : ''}</label>
      <button class="step" data-dir="-1" title="Previous ${seriesFor(x.type)} value" aria-label="Previous standard value">‹</button>
      <input type="text" id="p-${x.key}" data-part="${x.key}" value="${esc(fmtEng(p.values[x.key]))}" spellcheck="false" autocomplete="off">
      <button class="step" data-dir="1" title="Next ${seriesFor(x.type)} value" aria-label="Next standard value">›</button>
      <span class="unit">${unitOf(x.type)}</span>
    </div>`).join('');

  $('#optsEditor').innerHTML = (t.options || []).map(o => {
    if (o.type === 'range') {
      return `<label class="opt range"><span class="rhead"><span>${esc(o.label)}</span><output>${esc(o.fmt!(Number(p.opts[o.key])))}</output></span>
        <input type="range" data-opt="${o.key}" min="${o.min}" max="${o.max}" step="${o.step}" value="${p.opts[o.key]}"></label>`;
    }
    if (o.type === 'select') {
      return `<label class="opt select"><span>${esc(o.label)}</span><select data-opt="${o.key}">${(o.choices || []).map(c =>
        `<option value="${esc(c.value)}" ${c.value === p.opts[o.key] ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>`;
    }
    return `<label class="opt"><input type="checkbox" data-opt="${o.key}" ${p.opts[o.key] ? 'checked' : ''}> ${esc(o.label)}</label>`;
  }).join('') + opAmpNote(t, p.opts);

  $('#targetsEditor').innerHTML = t.targets.map(x => {
    const unit = { freq: 'Hz', db: 'dB', q: '', param: '×' }[x.kind];
    const val = x.kind === 'freq' ? fmtEng(p.targets[x.key]) : String(p.targets[x.key]);
    return `<label>${esc(x.label)}<span class="inp"><input type="text" data-target="${x.key}" value="${esc(val)}" spellcheck="false"><span class="unit">${unit}</span></span></label>`;
  }).join('');

  const ap = t.parts.find(x => x.key === t.anchor);
  $('.design').classList.toggle('nodesign', !ap || !t.targets.length);
  $('#anchorRow').innerHTML = ap ? `<span>Anchor part <b>${ap.key}</b> =</span>
    <input type="text" id="anchorVal" value="${esc(fmtEng(p.anchor))}" spellcheck="false">
    <span class="unit">${unitOf(ap.type)}</span>
    <span class="hint">Your preferred value; the exact solution scales from it.</span>` : '';
  $('#designOut').innerHTML = '';
  renderSweepCfg();
  update();
}

/** Explains what a non-ideal op-amp model adds (and doesn't), with any model caveat. */
function opAmpNote(t: Topology, o: Opts): string {
  if (!t.options?.some(x => x.key === 'opamp')) return '';
  const key = String(o.opamp ?? 'ideal');
  if (key === 'ideal') return '<p class="opt-note">Ideal op-amp: infinite gain and bandwidth. Pick a real part to see gain-bandwidth roll-off.</p>';
  const m = opAmpModel(key);
  return `<p class="opt-note">${esc(m.label)}: A0 ${fmtEng(m.a0)}, GBW ${fmtEng(m.gbw, 'Hz')}. Small-signal only (no slew or clipping). ` +
    `Characteristics and target design still use ideal formulas; the plot and measured values use this model.${m.note ? ' ' + esc(m.note) : ''}</p>`;
}

function renderSweepCfg(): void {
  const t = topo(), p = cur(t), sw = p.sweep;
  $('#sweepKey').innerHTML = `<option value="">Off</option>` + sweepTargets(t).map(x =>
    `<option value="${x.id}" ${x.id === sw.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  const target = sweepTargets(t).find(x => x.id === sw.key);
  if (!target) { $('#sweepCfg').innerHTML = ''; return; }
  const steps = `<label>Steps <select id="swSteps">${[3, 5, 7, 9, 11].map(n => `<option ${n === sw.steps ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  if (target.kind === 'opt') { $('#sweepCfg').innerHTML = steps + '<span class="hint">across the full travel</span>'; return; }
  const part = t.parts.find(x => x.key === target.key)!, unit = unitOf(part.type);
  $('#sweepCfg').innerHTML = `
    <label>From <input type="text" id="swMin" value="${esc(fmtEng(sw.min))}" spellcheck="false">${unit}</label>
    <label>to <input type="text" id="swMax" value="${esc(fmtEng(sw.max))}" spellcheck="false">${unit}</label>
    <label>Taper <select id="swTaper">${Object.entries(SWEEP_TAPERS).map(([k, l]) => `<option value="${k}" ${k === sw.taper ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${steps}`;
}

function setSweepKey(id: string): void {
  const t = topo(), p = cur(t), target = sweepTargets(t).find(x => x.id === id);
  p.sweep.key = target ? id : '';
  if (target && target.kind === 'part') {
    // Default: ÷3 … ×3, log-spaced. For a rheostat (e.g. a gain pot in series with a resistor),
    // set From/To to the end values and pick the pot's taper.
    const val = p.values[target.key];
    p.sweep.min = val / 3; p.sweep.max = val * 3; p.sweep.taper = 'L';
  }
  renderSweepCfg(); update();
}

function renderTermUI(): void {
  const fillSel = (sel: string, presets: Record<string, { label: string }>, val: string) => {
    $(sel).innerHTML = Object.entries(presets).map(([k, x]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  };
  const { src, load } = S.term;
  fillSel('#srcPreset', SRC_PRESETS, src.preset);
  fillSel('#loadPreset', LOAD_PRESETS, load.preset);
  $('#srcOn').checked = src.on; $('#loadOn').checked = load.on;
  $('#srcBox').classList.toggle('off', !src.on); $('#loadBox').classList.toggle('off', !load.on);
  $('#srcR').value = fmtEng(src.R); $('#srcL').value = fmtEng(src.L); $('#srcC').value = fmtEng(src.C);
  $('#loadR').value = fmtEng(load.R); $('#loadC').value = fmtEng(load.C);
  for (const id of ['#srcR', '#srcL', '#srcC', '#loadR', '#loadC']) $(id).classList.remove('invalid');
}

/**
 * |Zin| (with the current load, if on) and |Zout| (with the current source, if on) at a few
 * frequencies: what the previous stage has to drive, and what the next stage sees.
 */
function impedanceTable(t: Topology, v: Values, o: Opts): string {
  const c = t.circuit(v, o), term = termActive(S.term) ? S.term : null;
  const cells = [100, 1000, 10e3].map(f => {
    const sf = new Cx(0, TAU * f), z = termAt(term, sf);
    return { f, zin: c.zin(sf, z.zl).abs(), zout: c.zout(sf, z.zs).abs() };
  });
  const fmtZ = (x: number) => (isFinite(x) && x < 1e11 ? fmtEng(x, 'Ω') : '≈ open');
  return `<table id="zTable"><caption>Impedances${term ? ' (Zin with the load, Zout with the source)' : ''}</caption>
    <tr><th></th>${cells.map(c => `<th>${fmtEng(c.f, 'Hz')}</th>`).join('')}</tr>
    <tr><td>Input |Zin|</td>${cells.map(c => `<td class="num">${fmtZ(c.zin)}</td>`).join('')}</tr>
    <tr><td>Output |Zout|</td>${cells.map(c => `<td class="num">${fmtZ(c.zout)}</td>`).join('')}</tr></table>`;
}

/** Side-by-side numbers for the ideal vs. terminated response of the current design. */
function termEffectTable(t: Topology, v: Values, o: Opts): string {
  if (!termActive(S.term)) return '<p class="hint">Turn on a source or load to see how they change this circuit’s response. Both affect the plot, the tolerance band and any sweep; characteristics and target design stay ideal.</p>';
  const lv = (f: number, term?: Term) => db(Hfull(t, v, new Cx(0, TAU * f), o, term).abs());
  const ei = edges(t, v, o), et = edges(t, v, o, S.term);
  const inBand = (f: number | null) => (f && f >= 5 && f <= 50e3 ? f : null);
  const rows: [string, number | null, number | null, string][] = [
    ['Level @ 100 Hz', lv(100), lv(100, S.term), 'dB'],
    ['Level @ 1 kHz', lv(1000), lv(1000, S.term), 'dB'],
    ['Level @ 5 kHz', lv(5000), lv(5000, S.term), 'dB'],
    ['Peak level', ei.peakDb, et.peakDb, 'dB'],
    ['Low −3 dB (re: peak)', inBand(ei.fLo), inBand(et.fLo), 'Hz'],
    ['High −3 dB (re: peak)', inBand(ei.fHi), inBand(et.fHi), 'Hz'],
  ];
  const delta = (a: number | null, b: number | null, unit: string) => {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return '';
    const d = unit === 'dB' ? b - a : (b / a - 1) * 100;
    if (Math.abs(d) < (unit === 'dB' ? 0.05 : 0.5)) return '<span class="hint">≈ same</span>';
    const txt = unit === 'dB' ? `${d > 0 ? '+' : ''}${d.toFixed(1)} dB` : `${d > 0 ? '+' : ''}${d.toFixed(0)}%`;
    return `<span class="${d < 0 ? 'delta-neg' : 'delta-pos'}">${txt}</span>`;
  };
  return `<table><tr><th></th><th>Ideal</th><th>With source/load</th><th>Change</th></tr>${rows.map(([l, a, b, u]) =>
    `<tr><td>${l}</td><td class="num">${fmtMetric(a, u)}</td><td class="num">${fmtMetric(b, u)}</td><td class="num">${delta(a, b, u)}</td></tr>`).join('')}</table>`;
}

/* ---------- Main update ---------- */
// While a slider or text field is changing, redraw just the curves; finish the expensive parts
// (tolerance spread, sweep table, source/load table) once input settles.
let fullUpdateTimer: ReturnType<typeof setTimeout> | undefined;
function updateSoon(): void {
  update('fast');
  clearTimeout(fullUpdateTimer);
  fullUpdateTimer = setTimeout(() => update(), 200);
}

function update(mode?: 'fast'): void {
  const fast = mode === 'fast';
  if (!fast) clearTimeout(fullUpdateTimer);
  const t = topo(), p = cur(t);
  const v = p.values, o = p.opts, ok = valuesValid(t, v);
  const term = termActive(S.term) ? S.term : null;

  $('#schematic').innerHTML = renderSchematic(t.schematic(v, o), { title: `Schematic of ${t.name}` });

  const freqs = freqGrid(...fRange());
  const accent = cssVar('--accent');
  const series: Curve[] = [];
  let band: PlotData['band'] = null, markers: PlotMarker[] = [];
  const steps = ok ? sweepSteps(t, p) : [];

  S.compare.forEach(c => {
    const ct = topoById(c.topoId);
    if (!c.visible || !ct || !valuesValid(ct, c.values)) return;
    const r = response(ct, c.values, c.opts || {}, freqs, termActive(c.term) ? c.term : null);
    series.push({ mag: r.mag, ph: r.ph, color: c.color, width: 1.6, label: c.name });
  });

  let rows: string[] = [];
  if (ok) {
    for (const st of steps) {
      const r = response(t, st.v, st.o, freqs, term);
      series.push({ mag: r.mag, ph: r.ph, color: sweepColor(st.r), width: 1.5, label: st.label });
    }
    if (term) {
      const ri = response(t, v, o, freqs);
      series.push({ mag: ri.mag, ph: ri.ph, color: cssVar('--muted'), width: 1.4, dash: [5, 4], label: 'Ideal source/load' });
    }
    const r = response(t, v, o, freqs, term);
    series.push({ mag: r.mag, ph: r.ph, color: accent, width: 2.4, label: 'Current' });
    const metrics = t.analyze(v, o, t);
    const spread: Record<string, { min: number; max: number }> = {};
    if (S.settings.showTol && !fast) {
      const runs = toleranceCorners(t, v, S.settings.rTol, S.settings.cTol);
      const lo = new Array<number>(freqs.length).fill(Infinity), hi = new Array<number>(freqs.length).fill(-Infinity);
      for (const vv of runs) {
        const rr = response(t, vv, o, freqs, term);
        rr.mag.forEach((y, i) => { if (y < lo[i]) lo[i] = y; if (y > hi[i]) hi[i] = y; });
        for (const m of t.analyze(vv, o, t)) {
          if (m.value == null || !isFinite(m.value)) continue;
          const sp = spread[m.key] || (spread[m.key] = { min: Infinity, max: -Infinity });
          sp.min = Math.min(sp.min, m.value); sp.max = Math.max(sp.max, m.value);
        }
      }
      if (!steps.length) band = { lo, hi }; // a sweep family is busy enough on its own
    }
    markers = metrics.filter(m => m.unit === 'Hz' && !m.noMark && m.value).map(m => ({ f: m.value as number, label: m.key, color: accent }));
    rows = metrics.map(m => {
      const sp = spread[m.key];
      let spTxt = '';
      if (sp && isFinite(sp.min)) {
        spTxt = m.unit === 'Hz'
          ? `${fmtEng(sp.min, 'Hz')} – ${fmtEng(sp.max, 'Hz')}`
          : `${fmtMetric(sp.min, m.unit)} – ${fmtMetric(sp.max, m.unit)}`;
      }
      if (fast && S.settings.showTol) spTxt = '…';
      return `<tr><td>${esc(m.label)}</td><td class="num">${fmtMetric(m.value, m.unit)}</td>${S.settings.showTol ? `<td class="spread">${spTxt}</td>` : ''}</tr>`;
    });
  }
  const head = `<tr><th>Characteristic</th><th>Nominal</th>${S.settings.showTol ? `<th>R ±${S.settings.rTol}% · C ±${S.settings.cTol}%</th>` : ''}</tr>`;
  $('#metrics').innerHTML = ok ? head + rows.join('') : '<tr><td class="hint">Enter valid values for every part.</td></tr>';

  plotData = { freqs, series, band, markers };
  drawPlots();

  const legend = [`<span><span class="sw" style="background:${accent}"></span>Current · ${esc(t.name)}${term ? ' (with source/load)' : ''}</span>`];
  if (term && ok) legend.push(`<span><span class="sw" style="background:repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 7px)"></span>Ideal source/load</span>`);
  if (steps.length) legend.push(`<span><span class="ramp" style="background:linear-gradient(90deg, ${sweepColor(0)}, ${sweepColor(1)})"></span>Sweep: ${esc(steps[0].label)} → ${esc(steps[steps.length - 1].label)}</span>`);
  S.compare.filter(c => c.visible).forEach(c => legend.push(`<span><span class="sw" style="background:${c.color}"></span>${esc(c.name)}</span>`));
  $('#legend').innerHTML = legend.join('');

  if (fast) return;

  // Sweep table: the ideal characteristics at each sweep step.
  if (steps.length) {
    const cols = t.analyze(v, o, t).slice(0, 5);
    const body = steps.map(st => {
      const ms = Object.fromEntries(t.analyze(st.v, st.o, t).map(m => [m.key, m.value]));
      return `<tr><td><span class="sw" style="background:${sweepColor(st.r)}"></span>${esc(st.label)}</td>${cols.map(c => `<td class="num">${fmtMetric(ms[c.key], c.unit)}</td>`).join('')}</tr>`;
    }).join('');
    $('#sweepTable').innerHTML = `<table><tr><th>Sweep step</th>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>${body}</table>`;
  } else $('#sweepTable').innerHTML = '';

  $('#termEffect').innerHTML = ok ? impedanceTable(t, v, o) + termEffectTable(t, v, o) : '';
  persist();
}

/* ---------- Library ---------- */
function renderLibrary(): void {
  $('#compareList').innerHTML = S.compare.length ? S.compare.map(c => `
    <li data-id="${c.id}">
      <input type="checkbox" data-act="toggle" ${c.visible ? 'checked' : ''} title="Show/hide">
      <span class="sw" style="background:${c.color}"></span>
      <span class="name" title="${esc(c.name)}">${esc(c.name)}</span>
      <button class="link" data-act="load" title="Load into editor">Load</button>
      <button class="link" data-act="rename" title="Rename">Rename</button>
      <button class="link" data-act="remove" title="Remove" aria-label="Remove">✕</button>
    </li>`).join('') : '<li class="empty">Pin the current curve to overlay it while you try alternatives.</li>';

  $('#savedList').innerHTML = S.saved.length ? S.saved.map(s => `
    <li data-id="${s.id}">
      <span class="name" title="${esc(s.name)}">${esc(s.name)} <small>· ${esc(topoById(s.topoId)?.name || s.topoId)}</small></span>
      <button class="link" data-act="load">Load</button>
      <button class="link" data-act="pin" title="Overlay on the plot">Pin</button>
      <button class="link" data-act="delete" aria-label="Delete">✕</button>
    </li>`).join('') : '<li class="empty">No saved designs yet.</li>';
}

function summaryName(t: Topology, v: Values, o: Opts): string {
  if (!valuesValid(t, v)) return t.name;
  const ms = t.analyze(v, o, t).filter(m => m.value != null && isFinite(m.value)).slice(0, 2);
  return `${t.name} · ${ms.map(m => `${m.key} ${fmtMetric(m.value, m.unit)}`).join(', ')}`;
}

function flashPart(key: string): void {
  const el = document.querySelector<HTMLElement>(`.part[data-part="${key}"]`);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function setValues(v: Values): void {
  const t = topo(), p = cur(t);
  for (const x of t.parts) if (typeof v[x.key] === 'number') {
    p.values[x.key] = v[x.key];
    const inp = $(`#p-${x.key}`);
    if (inp) { inp.value = fmtEng(v[x.key]); inp.classList.remove('invalid'); }
    flashPart(x.key);
  }
  update();
}

/* ---------- Design from targets ---------- */
let designRows: Values[] = [];

function readTargets(): Values | { error: string } {
  const t = topo(), p = cur(t), tg: Values = {};
  let bad: string | null = null;
  for (const x of t.targets) {
    const inp = document.querySelector<HTMLInputElement>(`[data-target="${x.key}"]`)!;
    const val = x.kind === 'freq' ? parseEng(inp.value) : parseFloat(inp.value);
    const valid = isFinite(val) && (x.kind === 'db' || val > 0);
    inp.classList.toggle('invalid', !valid);
    if (!valid) bad = x.label; else { tg[x.key] = val; p.targets[x.key] = val; }
  }
  return bad ? { error: `Check the value for “${bad}”.` } : tg;
}

function runDesign(): void {
  const t = topo(), p = cur(t), outEl = $('#designOut');
  const tg = readTargets();
  if ('error' in tg) { outEl.innerHTML = `<div class="msg err">${esc(tg.error)}</div>`; return; }
  const aInp = $('#anchorVal'), anchor = parseEng(aInp.value);
  aInp.classList.toggle('invalid', !(anchor > 0));
  if (!(anchor > 0)) { outEl.innerHTML = '<div class="msg err">Enter a valid anchor value.</div>'; return; }
  p.anchor = anchor;

  // Searches that iterate on numerical measurements can take a second; show progress first.
  const btn = $<HTMLButtonElement>('#runDesign');
  btn.disabled = true;
  outEl.innerHTML = '<div class="msg">Searching standard values…</div>';
  setTimeout(() => {
    try { renderDesign(t, tg, anchor); } finally { btn.disabled = false; }
  }, 20);
}

function renderDesign(t: Topology, tg: Values, anchor: number): void {
  const p = cur(t), outEl = $('#designOut');
  let res;
  try {
    res = searchDesigns({ t, targets: tg, anchor, opts: p.opts, values: p.values, rSeries: S.settings.rSeries, cSeries: S.settings.cSeries });
  } catch (e) {
    outEl.innerHTML = `<div class="msg err">${esc((e as Error).message)}</div>`;
    return;
  }
  if (!res.exact && !res.best.length) { outEl.innerHTML = '<div class="msg err">No workable design found for these targets.</div>'; return; }

  const scored = t.targets.filter(x => x.kind !== 'param');
  const errCell = (r: DesignRow['per'][number]) => {
    const e = r.err, actual = r.actual ?? NaN;
    let txt: string;
    if (!isFinite(e)) txt = '—';
    else if (r.kind === 'db') txt = `${(actual - r.target) >= 0 ? '+' : ''}${(actual - r.target).toFixed(2)} dB`;
    else txt = `${((actual / r.target - 1) * 100).toFixed(1)}%`;
    const cls = e < 0.01 ? 'e-good' : e < 0.05 ? 'e-ok' : 'e-bad';
    const unit = r.kind === 'freq' ? 'Hz' : r.kind === 'db' ? 'dB' : '';
    return `<td class="num">${fmtMetric(r.actual, unit)}<span class="err-sub ${cls}">${txt}</span></td>`;
  };
  const partsCell = (v: Values) => `<td class="parts">${t.parts.map(x => `<span>${x.key} ${fmtEng(v[x.key], unitOf(x.type))}</span>`).join('')}</td>`;
  designRows = [];
  const add = (r: DesignRow, tag: string) => {
    designRows.push(r.v);
    const id = designRows.length - 1;
    return `<tr>${partsCell(r.v)}${r.per.map(errCell).join('')}<td><button data-apply="${id}">Use</button>${tag ? `<div class="tag">${tag}</div>` : ''}</td></tr>`;
  };

  const ap = t.parts.find(x => x.key === t.anchor)!;
  let html = `<table><thead><tr><th>Components</th>${scored.map(x => `<th>${esc(x.label)}</th>`).join('')}<th></th></tr></thead><tbody>`;
  html += `<tr class="section"><td colspan="${scored.length + 2}">From your anchor (${esc(fmtEng(anchor, unitOf(ap.type)))})</td></tr>`;
  if (res.exact) html += add(res.exact, 'exact, non-standard');
  if (res.near) html += add(res.near, `snapped to ${S.settings.rSeries}/${S.settings.cSeries}`);
  if (res.best.length) {
    html += `<tr class="section"><td colspan="${scored.length + 2}">Best standard-value combinations (${S.settings.rSeries} resistors, ${S.settings.cSeries} caps)</td></tr>`;
    res.best.forEach(r => { html += add(r, ''); });
  }
  html += '</tbody></table>';
  outEl.innerHTML = html;
  persist();
}

/* ---------- Compare & save ---------- */
const newId = () => Math.random().toString(36).slice(2, 10);
const nextColor = () => COMPARE_COLORS.find(c => !S.compare.some(x => x.color === c)) || COMPARE_COLORS[S.compare.length % COMPARE_COLORS.length];

function pin(t: Topology, values: Values, opts: Opts, name?: string, term?: Term | null): void {
  const tm = term === undefined ? (termActive(S.term) ? cloneTerm(S.term) : null) : term;
  S.compare.push({
    id: newId(), name: (name || summaryName(t, values, opts)) + (tm && !name ? ' · with source/load' : ''),
    topoId: t.id, values: { ...values }, opts: { ...opts }, term: tm, color: nextColor(), visible: true,
  });
  renderLibrary(); update();
}

function loadDesign(d: CompareItem | SavedDesign): void {
  const t = topoById(d.topoId);
  if (!t) return;
  S.topoId = t.id;
  const p = cur(t);
  Object.assign(p.values, d.values);
  Object.assign(p.opts, d.opts || {});
  if ('targets' in d && d.targets) Object.assign(p.targets, d.targets);
  if (d.term) { S.term = cloneTerm(d.term); renderTermUI(); }
  renderNav(); renderTopo();
}

function saveCurrent(): void {
  const t = topo(), p = cur(t), inp = $('#saveName');
  if (!valuesValid(t, p.values)) return;
  const name = inp.value.trim() || summaryName(t, p.values, p.opts);
  S.saved.unshift({ id: newId(), name, topoId: t.id, values: { ...p.values }, opts: { ...p.opts }, targets: { ...p.targets }, term: cloneTerm(S.term), date: new Date().toISOString() });
  inp.value = '';
  renderLibrary(); persist();
}

/* ---------- Events ---------- */
function commitPartInput(inp: HTMLInputElement, reformat: boolean, typing = false): void {
  const t = topo(), p = cur(t), key = inp.dataset.part!, part = t.parts.find(x => x.key === key)!;
  const v = parseEng(inp.value);
  const valid = isFinite(v) && (v > 0 || (!!part.zeroOk && v === 0));
  inp.classList.toggle('invalid', !valid);
  if (!valid) return;
  p.values[key] = v;
  if (reformat) inp.value = fmtEng(v);
  if (typing) updateSoon(); else update();
}

function stepPart(key: string, dir: number): void {
  const t = topo(), p = cur(t), part = t.parts.find(x => x.key === key)!;
  const now = p.values[key] > 0 ? p.values[key] : part.def;
  const nv = stepSeries(now, seriesFor(part.type), dir);
  p.values[key] = nv;
  const inp = $(`#p-${key}`); inp.value = fmtEng(nv); inp.classList.remove('invalid');
  update();
}

function onOption(e: Event): void {
  const el = tgt(e), k = el.dataset.opt;
  if (!k) return;
  const p = cur();
  if (el.type === 'checkbox') {
    if (e.type !== 'change') return;
    p.opts[k] = el.checked;
  } else if (el.tagName === 'SELECT') {
    if (e.type !== 'change') return;
    p.opts[k] = el.value;
    renderTopo(); // refreshes the model note
    return;
  } else {
    p.opts[k] = +el.value;
    const def = topo().options!.find(x => x.key === k)!, outEl = el.closest('.opt')!.querySelector('output');
    if (outEl) outEl.textContent = def.fmt!(+el.value);
    if (e.type === 'input') { updateSoon(); return; }
  }
  update();
}

function onTermChange(e: Event): void {
  const el = tgt(e), id = el.id, { src, load } = S.term;
  if (id === 'srcOn') src.on = el.checked;
  else if (id === 'loadOn') load.on = el.checked;
  else if (id === 'srcPreset' || id === 'loadPreset') {
    const box: SourceTerm | LoadTerm = id === 'srcPreset' ? src : load;
    const pr = (id === 'srcPreset' ? SRC_PRESETS : LOAD_PRESETS)[el.value];
    box.preset = el.value;
    if (pr.R !== undefined) box.R = pr.R;
    if (pr.C !== undefined) box.C = pr.C;
    if (pr.L !== undefined && 'L' in box) box.L = pr.L;
    box.on = true;
  } else if (/^(src|load)[RLC]$/.test(id)) {
    const box = (id.startsWith('src') ? src : load) as unknown as Record<string, number | string | boolean>;
    const k = id.slice(-1), val = parseEng(el.value);
    const ok = isFinite(val) && val >= 0;
    el.classList.toggle('invalid', !ok);
    if (!ok) return;
    box[k] = val; box.preset = 'custom'; box.on = true;
  } else return;
  renderTermUI();
  update();
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the current circuit (values, knob positions, op-amp model, source/load) as a SPICE deck. */
function exportSpice(): void {
  const t = topo(), p = cur(t);
  if (!valuesValid(t, p.values)) return;
  const knobs = (t.options || []).map(o => {
    const val = p.opts[o.key];
    if (o.type === 'range') return `${o.label}: ${o.fmt!(Number(val))}`;
    if (o.type === 'select') return `${o.label}: ${o.choices?.find(c => c.value === val)?.label ?? val}`;
    return `${o.label}: ${val ? 'on' : 'off'}`;
  });
  const [fmin, fmax] = fRange();
  const text = toSpice(t.netlist(p.values, p.opts), {
    title: t.name, term: termActive(S.term) ? S.term : null, fmin, fmax,
    notes: knobs.length ? ['Settings: ' + knobs.join(', ')] : [],
  });
  download(`${t.id}.cir`, text, 'text/plain');
}

async function importDesigns(f: File): Promise<void> {
  try {
    const data = JSON.parse(await f.text());
    const ok = (d: unknown): d is SavedDesign & CompareItem => {
      const x = d as SavedDesign | null;
      return !!x && typeof x === 'object' && !!topoById(x.topoId) && !!x.values && typeof x.values === 'object';
    };
    const saved = ((data.saved || []) as unknown[]).filter(ok), compare = ((data.compare || []) as unknown[]).filter(ok);
    const have = new Set(S.saved.map(s => s.id));
    for (const s of saved) if (!have.has(s.id)) S.saved.push({ ...s, id: s.id || newId(), name: String(s.name || 'Imported') });
    for (const c of compare) if (!S.compare.some(x => x.id === c.id)) {
      S.compare.push({ ...c, id: c.id || newId(), name: String(c.name || 'Imported'), color: c.color || nextColor(), visible: c.visible !== false, term: c.term ?? null });
    }
    renderLibrary(); update();
    alert(`Imported ${saved.length} saved design(s) and ${compare.length} overlay(s).`);
  } catch (err) {
    alert('Could not read that file: ' + (err as Error).message);
  }
}

function wireEvents(): void {
  $('#topoList').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-topo]');
    if (!b) return;
    S.topoId = b.dataset.topo!;
    renderNav(); renderTopo();
  });

  const partsEl = $('#partsEditor');
  partsEl.addEventListener('input', e => { if (tgt(e).dataset.part) commitPartInput(tgt(e), false, true); });
  partsEl.addEventListener('change', e => { if (tgt(e).dataset.part) commitPartInput(tgt(e), true); });
  partsEl.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button.step');
    if (!b) return;
    stepPart(b.closest<HTMLElement>('.part')!.dataset.part!, +b.dataset.dir!);
  });
  partsEl.addEventListener('keydown', e => {
    const el = tgt(e);
    if (!el.dataset.part) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepPart(el.dataset.part, e.key === 'ArrowUp' ? 1 : -1); }
    if (e.key === 'Enter') commitPartInput(el, true);
  });

  $('#optsEditor').addEventListener('input', onOption);
  $('#optsEditor').addEventListener('change', onOption);
  $('#schematic').addEventListener('click', e => {
    const g = (e.target as Element).closest<SVGGElement>('.comp');
    if (!g) return;
    const key = g.dataset.part!, inp = $(`#p-${key}`);
    if (inp) { inp.focus(); inp.select(); flashPart(key); }
  });
  $('#snapAll').addEventListener('click', () => setValues(snapAllValues(topo(), cur().values, S.settings.rSeries, S.settings.cSeries)));
  $('#exportSpice').addEventListener('click', exportSpice);

  $('#presetRow').addEventListener('change', e => {
    const el = tgt(e);
    if (el.id !== 'presetSel' || el.value === '') return;
    const t = topo(), p = cur(t), pr = t.presets![+el.value];
    Object.assign(p.values, pr.values);
    if (pr.opts) Object.assign(p.opts, pr.opts);
    renderTopo();
    t.parts.forEach(x => flashPart(x.key));
  });

  $('#sweepKey').addEventListener('change', e => setSweepKey(tgt(e).value));
  $('#sweepCfg').addEventListener('change', e => {
    const el = tgt(e), sw = cur().sweep, id = el.id;
    if (id === 'swSteps') sw.steps = +el.value;
    else if (id === 'swTaper') {
      sw.taper = el.value as SweepTaper;
      if (sw.taper === 'L' && !((sw.min ?? 0) > 0)) sw.min = (sw.max ?? 1) / 100;
    } else if (id === 'swMin' || id === 'swMax') {
      const val = parseEng(el.value), ok = isFinite(val) && val >= 0 && !(sw.taper === 'L' && val === 0);
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      sw[id === 'swMin' ? 'min' : 'max'] = val;
      el.value = fmtEng(val);
    }
    update();
  });

  $('.term').addEventListener('change', onTermChange);

  for (const id of ['rSeries', 'cSeries', 'rTol', 'cTol', 'range'] as const) {
    $('#' + id).addEventListener('change', e => {
      const val = tgt(e).value;
      if (id === 'rTol' || id === 'cTol') S.settings[id] = parseFloat(val);
      else if (id === 'range') S.settings.range = val;
      else (S.settings as Settings)[id] = val as SeriesName;
      if (id === 'rSeries' || id === 'cSeries') renderTopo(); else update();
    });
  }
  $('#showTol').addEventListener('change', e => { S.settings.showTol = tgt(e).checked; update(); });
  $('#showPhase').addEventListener('change', e => { S.settings.showPhase = tgt(e).checked; drawPlots(); persist(); });

  $('#runDesign').addEventListener('click', runDesign);
  $('#targetsEditor').addEventListener('keydown', e => { if (e.key === 'Enter') runDesign(); });
  $('#anchorRow').addEventListener('keydown', e => { if (e.key === 'Enter') runDesign(); });
  $('#designOut').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-apply]');
    if (!b) return;
    const v = designRows[+b.dataset.apply!];
    if (v) setValues(v);
  });

  for (const id of ['#magCanvas', '#phaseCanvas']) {
    const c = $<HTMLCanvasElement>(id);
    c.addEventListener('pointermove', e => {
      const r = c.getBoundingClientRect(), x = e.clientX - r.left, pw = r.width - PLOT_MARGIN.l - PLOT_MARGIN.r;
      const [a, b] = fRange(), u = (x - PLOT_MARGIN.l) / pw;
      hoverF = u >= 0 && u <= 1 ? a * Math.pow(b / a, u) : null;
      drawPlots();
    });
    c.addEventListener('pointerleave', () => { hoverF = null; drawPlots(); });
  }
  new ResizeObserver(() => drawPlots()).observe($('.plot'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => update());

  $('#pinBtn').addEventListener('click', () => {
    const t = topo(), p = cur(t);
    if (!valuesValid(t, p.values)) return;
    pin(t, p.values, p.opts);
  });
  $('#compareList').addEventListener('click', e => {
    const el = tgt(e), li = el.closest<HTMLElement>('li[data-id]'), act = el.dataset.act;
    if (!li || !act) return;
    const i = S.compare.findIndex(c => c.id === li.dataset.id), c = S.compare[i];
    if (act === 'toggle') { c.visible = el.checked; update(); return; }
    if (act === 'remove') S.compare.splice(i, 1);
    if (act === 'load') { loadDesign(c); return; }
    if (act === 'rename') { const n = prompt('Overlay name', c.name); if (n && n.trim()) c.name = n.trim(); }
    renderLibrary(); update();
  });
  $('#saveBtn').addEventListener('click', saveCurrent);
  $('#saveName').addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrent(); });
  $('#savedList').addEventListener('click', e => {
    const el = tgt(e), li = el.closest<HTMLElement>('li[data-id]'), act = el.dataset.act;
    if (!li || !act) return;
    const i = S.saved.findIndex(s => s.id === li.dataset.id), s = S.saved[i];
    if (act === 'load') loadDesign(s);
    if (act === 'pin') { const t = topoById(s.topoId); if (t) pin(t, s.values, s.opts || {}, s.name, termActive(s.term) ? cloneTerm(s.term) : null); }
    if (act === 'delete' && confirm(`Delete “${s.name}”?`)) { S.saved.splice(i, 1); renderLibrary(); persist(); }
  });
  $('#exportBtn').addEventListener('click', () => {
    const data = { app: 'pedal-filter-lab', version: 1, exported: new Date().toISOString(), saved: S.saved, compare: S.compare };
    download('pedal-filter-designs.json', JSON.stringify(data, null, 2), 'application/json');
  });
  $('#importFile').addEventListener('change', e => {
    const el = tgt(e), f = el.files?.[0];
    el.value = '';
    if (f) void importDesigns(f);
  });
}

export function initPlayground(): void {
  wireEvents();
  renderSettings();
  renderTermUI();
  renderNav();
  renderTopo();
  renderLibrary();
}
