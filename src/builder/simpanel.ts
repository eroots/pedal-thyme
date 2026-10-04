// Builder simulation panel: output and probe curves, sweeps, tolerance band, phase, source/load.
import type { OpPoint } from '../engine/dc';
import { termActive, type Term } from '../core/termination';
import { fmtEng, parseEng } from '../core/units';
import type { Extraction } from '../schematic/extract';
import type { Schematic } from '../schematic/types';
import { freqGrid } from '../playground/analysis';
import { LOAD_PRESETS, S, SRC_PRESETS, fRange, sweepColor } from '../playground/state';
import { cssVar, drawPlot, magRange, PLOT_MARGIN, type PlotSeries } from '../ui/plot';
import { band, impedances, probesOf, simulate, sweepTargets, sweepVariants, toleranceVariants, type SimResult } from './sim';
import { extract } from '../schematic/extract';
import type { ProjectSim } from './files';

const LS_KEY = 'pedal-filter-lab.builder.sim.v1';
const $ = <T extends HTMLElement = HTMLInputElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmtDb = (x: number) => (isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)} dB` : '—');

interface SimSettings {
  term: Term;
  showOut: boolean;
  showTol: boolean;
  showPhase: boolean;
  sweep: string;
  steps: number;
}
const DEFAULTS: SimSettings = {
  term: { src: { on: false, preset: 'single', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: false, preset: 'pedal', R: 1e6, C: 0 } },
  showOut: true, showTol: false, showPhase: false, sweep: '', steps: 5,
};

function loadSettings(): SimSettings {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && s.term) return { ...DEFAULTS, ...s, term: { src: { ...DEFAULTS.term.src, ...s.term.src }, load: { ...DEFAULTS.term.load, ...s.term.load } } };
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/** Other open schematics whose response can be overlaid (the tabs). */
export interface CompareSource {
  list(): { id: string; name: string }[];
  /** That tab's circuit as it simulates (with its own chain) and its source/load, or why it can't. */
  get(id: string): { ex: Extraction; term: Term | null; name: string } | { error: string; name: string } | null;
}

/** The pedals feeding this one, when its input is another tab's output. */
export interface Upstream {
  /** Pedal names, first in the chain first. */
  names: string[];
  /** The first pedal's source (guitar, cable…), which now feeds the chain. */
  src: Term['src'];
  /** This pedal's circuit with the upstream pedals joined in front of it. */
  wrap(ex: Extraction): Extraction;
  /** Set when an upstream pedal can't be simulated. */
  error?: string;
}

/** Tabs that can feed this one (the signal chain). */
export interface ChainHost {
  options(): { id: string; name: string }[];
  resolve(id: string): Upstream | null;
  /** The chain setting changed. */
  changed(): void;
}

export interface SimPanel {
  /** The document changed: recompute (cheap parts now, the tolerance band once things settle). */
  update(doc: Schematic, ex: Extraction, committed: boolean): void;
  redraw(): void;
  /** Current settings, for saving with a project. */
  settings(): ProjectSim;
  /** Apply settings loaded from a project. */
  apply(sim: ProjectSim): void;
  /** The tab overlaid for comparison ('' for none). */
  compare(): string;
  setCompare(id: string): void;
  setCompareSource(src: CompareSource): void;
  /** Tabs were opened, closed or renamed. */
  refreshCompare(): void;
  /** Tab feeding this one's input ('' for the normal source). */
  chain(): string;
  setChain(id: string): void;
  setChainHost(h: ChainHost): void;
  /** The pedals in front of this one (null when its input is the normal source). */
  upstream(): Upstream | null;
  /** Source and load as simulated (with a chain: the first pedal's source). */
  activeTerm(): Term | null;
}

export function initSimPanel(): SimPanel {
  const st = loadSettings();
  let doc: Schematic | null = null, ex: Extraction | null = null;
  let res: SimResult | null = null, ideal: SimResult | null = null;
  let sweep: { label: string; r: number; mag: number[]; ph: number[] }[] = [];
  let tolBand: { lo: number[]; hi: number[] } | null = null;
  let freqs: number[] = [];
  let compareId = '', compareSrc: CompareSource | null = null;
  let cmp: { label: string; mag: number[]; ph: number[] } | null = null;
  let hoverF: number | null = null;
  let locked: [number, number] | null = null;
  let rafId = 0, bandTimer: ReturnType<typeof setTimeout> | undefined;

  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch { /* ignore */ } };
  let chainFrom = '', chainHost: ChainHost | null = null;
  const upstream = (): Upstream | null => (chainFrom && chainHost ? chainHost.resolve(chainFrom) : null);
  /** With a chain, the source is the first pedal's (this pedal's input sees the one before it). */
  const termOf = (up: Upstream | null): Term | null => {
    const t = up ? { src: up.src, load: st.term.load } : st.term;
    return termActive(t) ? t : null;
  };
  const term = (): Term | null => termOf(upstream());

  /* ---------- Source & load controls ---------- */
  const fill = (sel: string, first: [string, string], presets: Record<string, { label: string }>, val: string) => {
    $(sel).innerHTML = [first, ...Object.entries(presets).map(([k, p]) => [k, p.label] as [string, string])]
      .map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('');
  };
  function renderTerm(): void {
    fill('#bSrc', ['ideal', 'Ideal (0 Ω)'], SRC_PRESETS, st.term.src.on ? st.term.src.preset : 'ideal');
    // Other tabs can feed this pedal (a signal chain).
    const chainOpts = chainHost?.options() ?? [];
    if (chainHost && chainFrom && !chainOpts.some(o => o.id === chainFrom)) chainFrom = '';
    if (chainOpts.length) {
      $('#bSrc').insertAdjacentHTML('beforeend', `<optgroup label="Signal chain">${chainOpts.map(o => `<option value="chain:${esc(o.id)}">Output of ${esc(o.name)}</option>`).join('')}</optgroup>`);
    }
    if (chainFrom) $<HTMLSelectElement>('#bSrc').value = `chain:${chainFrom}`;
    $('#bSrc').title = chainFrom ? 'This pedal is fed by the output of another tab (whose own source drives the chain)' : '';
    fill('#bLoad', ['none', 'None (open)'], LOAD_PRESETS, st.term.load.on ? st.term.load.preset : 'none');
    $('#bSrcFields').hidden = !st.term.src.on || !!chainFrom;
    $('#bLoadFields').hidden = !st.term.load.on;
    $('#bSrcR').value = fmtEng(st.term.src.R); $('#bSrcL').value = fmtEng(st.term.src.L); $('#bSrcC').value = fmtEng(st.term.src.C);
    $('#bLoadR').value = fmtEng(st.term.load.R); $('#bLoadC').value = fmtEng(st.term.load.C);
  }
  $('.b-term').addEventListener('change', e => {
    const el = e.target as HTMLInputElement, id = el.id;
    if (id === 'bSrc' && el.value.startsWith('chain:')) {
      chainFrom = el.value.slice(6);
      renderTerm(); schedule(true); chainHost?.changed();
      return;
    }
    const wasChained = id === 'bSrc' && !!chainFrom;
    if (id === 'bSrc') chainFrom = '';
    if (id === 'bSrc' || id === 'bLoad') {
      const box = id === 'bSrc' ? st.term.src : st.term.load;
      const pr = (id === 'bSrc' ? SRC_PRESETS : LOAD_PRESETS)[el.value];
      box.on = !!pr;
      if (pr) {
        box.preset = el.value;
        if (pr.R !== undefined) box.R = pr.R;
        if (pr.C !== undefined) box.C = pr.C;
        if (pr.L !== undefined && 'L' in box) box.L = pr.L;
      }
    } else {
      const m = id.match(/^b(Src|Load)([RLC])$/);
      if (!m) return;
      const v = parseEng(el.value), ok = isFinite(v) && v >= 0;
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      const box = (m[1] === 'Src' ? st.term.src : st.term.load) as unknown as Record<string, number | string | boolean>;
      box[m[2]] = v; box.preset = 'custom'; box.on = true;
    }
    save(); renderTerm(); schedule(true);
    if (wasChained) chainHost?.changed();
  });

  /* ---------- Toggles & sweep ---------- */
  $('#bShowOut').checked = st.showOut;
  $('#bShowOut').addEventListener('change', e => { st.showOut = (e.target as HTMLInputElement).checked; save(); draw(); });
  $('#bShowTol').checked = st.showTol;
  $('#bShowPhase').checked = st.showPhase;
  $('#bShowTol').addEventListener('change', e => { st.showTol = (e.target as HTMLInputElement).checked; save(); schedule(true); });
  $('#bShowPhase').addEventListener('change', e => { st.showPhase = (e.target as HTMLInputElement).checked; save(); draw(); });
  $('#bLockScale').addEventListener('change', e => {
    locked = (e.target as HTMLInputElement).checked ? currentRange() : null;
    draw();
  });
  $('#bSweepSteps').value = String(st.steps);
  $('#bSweep').addEventListener('change', e => { st.sweep = (e.target as HTMLSelectElement).value; save(); schedule(true); });
  $('#bSweepSteps').addEventListener('change', e => { st.steps = +(e.target as HTMLSelectElement).value; save(); schedule(true); });
  function renderSweepOptions(): void {
    if (!doc) return;
    const targets = sweepTargets(doc);
    if (st.sweep && !targets.some(t => t.id === st.sweep)) st.sweep = '';
    $('#bSweep').innerHTML = `<option value="">${targets.length ? 'Off' : 'Off (mark parts Sweepable in Properties)'}</option>` + targets.map(t => `<option value="${t.id}" ${t.id === st.sweep ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  }

  $('#bCompare').addEventListener('change', e => { compareId = (e.target as HTMLSelectElement).value; schedule(false); });
  function renderCompareOptions(): void {
    const list = compareSrc?.list() ?? [];
    if (compareSrc && compareId && !list.some(t => t.id === compareId)) compareId = '';
    const sel = $<HTMLSelectElement>('#bCompare');
    sel.disabled = !list.length;
    sel.innerHTML = `<option value="">${list.length ? 'None' : 'None (open another tab)'}</option>` + list.map(t => `<option value="${esc(t.id)}" ${t.id === compareId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  }

  /* ---------- Compute ---------- */
  function compute(): void {
    if (!doc || !ex) return;
    renderSweepOptions();
    renderCompareOptions();
    const errs = ex.issues.filter(i => i.severity === 'error');
    const msg = $('#bSimMsg');
    if (errs.length) { res = null; msg.textContent = 'Fix the errors listed under Checks to see the response.'; draw(); return; }
    const up = upstream();
    if (up?.error) { res = null; msg.innerHTML = `<span class="warnc">${esc(up.error)}</span>`; draw(); return; }
    const W = up ? up.wrap : (x: Extraction) => x;
    const sx = W(ex);
    freqs = freqGrid(...fRange(), 300);
    const probes = probesOf(doc, ex), t = termOf(up);
    res = simulate(sx, probes, freqs, t);
    ideal = t ? simulate(sx, [], freqs, null) : null;
    sweep = st.sweep ? sweepVariants(doc, st.sweep, st.steps).flatMap(v => {
      const vx = extract(v.doc);
      if (vx.issues.some(i => i.severity === 'error')) return [];
      const r = simulate(W(vx), [], freqs, t);
      return [{ label: v.label, r: v.r, mag: r.out.mag, ph: r.out.ph }];
    }) : [];
    // Another tab's output, with its own source and load.
    cmp = null;
    let cmpNote = '';
    const other = compareId ? compareSrc?.get(compareId) : null;
    if (other) {
      if ('error' in other) cmpNote = ` <span class="warnc">${esc(other.error)}</span>`;
      else {
        const r = simulate(other.ex, [], freqs, other.term);
        cmp = { label: other.name, mag: r.out.mag, ph: r.out.ph };
        const c = (f: number) => cmp!.mag[nearest(f)];
        cmpNote = ` <span class="cmpnote">${esc(other.name)}: ${fmtDb(c(100))} · ${fmtDb(c(1000))} · ${fmtDb(c(5000))}.</span>`;
      }
    }
    // Readouts.
    const at = (f: number) => res!.out.mag[nearest(f)];
    const z = impedances(sx, 1000, t);
    const zf = (x: number) => (isFinite(x) && x < 1e11 ? fmtEng(x, 'Ω') : 'open');
    msg.innerHTML = (up ? `Signal chain: ${up.names.map(esc).join(' → ')} → this pedal. ` : '') + `Output: ${fmtDb(at(100))} @ 100 Hz · ${fmtDb(at(1000))} @ 1 kHz · ${fmtDb(at(5000))} @ 5 kHz.` +
      ` At 1 kHz: Zin ${zf(z.zin)}, Zout ${zf(z.zout)}.` +
      (t ? ' Includes the source and load (ideal shown dashed).' : ' Ideal source and no load.') + (up ? ` Zin is the chain's (at ${esc(up.names[0])}).` : '') +
      biasNote(res.op) + cmpNote;
    draw();
  }
  /** Bias status: semiconductors are linearised at the DC operating point. */
  function biasNote(op: OpPoint | null): string {
    if (!op) return '';
    if (!op.ok) return ' <b class="warnc">DC bias did not converge</b>: semiconductor results are unreliable (check the supply and bias network).';
    return ' Semiconductors are linearised at their DC bias (small-signal: no clipping).';
  }
  const nearest = (f: number) => { let k = 0; for (let i = 1; i < freqs.length; i++) if (Math.abs(Math.log(freqs[i] / f)) < Math.abs(Math.log(freqs[k] / f))) k = i; return k; };

  function computeBand(): void {
    tolBand = null;
    if (!doc || !ex || !st.showTol || !res) { draw(); return; }
    const t0 = performance.now();
    const up = upstream();
    tolBand = up?.error ? null : band(toleranceVariants(doc, S.settings.rTol, S.settings.cTol), freqs, term(), up ? up.wrap : undefined);
    const ms = performance.now() - t0;
    if (ms > 1500) console.info(`Tolerance band took ${ms.toFixed(0)} ms`);
    draw();
  }

  /** committed: also refresh the (slower) tolerance band, after input settles. */
  function schedule(committed: boolean): void {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(compute);
    clearTimeout(bandTimer);
    if (committed && st.showTol) bandTimer = setTimeout(computeBand, 250);
    else if (!st.showTol) tolBand = null;
  }

  /* ---------- Draw ---------- */
  function seriesList(kind: 'mag' | 'ph'): PlotSeries[] {
    if (!res) return [];
    const out: PlotSeries[] = [];
    if (st.showOut) sweep.forEach(s => out.push({ vals: s[kind], color: sweepColor(s.r), width: 1.4, label: s.label }));
    if (ideal && st.showOut) out.push({ vals: ideal.out[kind], color: cssVar('--muted'), width: 1.4, dash: [5, 4], label: 'Ideal source/load' });
    res.probes.forEach(p => out.push({ vals: p[kind], color: p.color, width: 1.8, label: p.ref }));
    if (cmp) out.push({ vals: cmp[kind], color: cssVar('--compare'), width: 2.2, label: cmp.label });
    if (st.showOut) out.push({ vals: res.out[kind], color: cssVar('--accent'), width: 2.4, label: 'Output' });
    return out;
  }
  function currentRange(): [number, number] {
    return magRange(seriesList('mag').map(s => s.vals).concat(tolBand && st.showOut ? [tolBand.hi] : []));
  }
  function draw(): void {
    const mc = $<HTMLCanvasElement>('#bSimCanvas'), pc = $<HTMLCanvasElement>('#bSimPhase');
    pc.style.display = st.showPhase ? 'block' : 'none';
    if (!res) {
      for (const cv of [mc, pc]) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
      $('#bLegend').innerHTML = '';
      return;
    }
    const [y0, y1] = locked ?? currentRange();
    drawPlot(mc, { freqs, fr: fRange(), y0, y1, step: (y1 - y0) > 48 ? 12 : 6, unit: '', hoverF, band: st.showTol && st.showOut ? tolBand : null, series: seriesList('mag') });
    if (st.showPhase) drawPlot(pc, { freqs, fr: fRange(), y0: -180, y1: 180, step: 90, unit: '°', wrap: true, hoverF, series: seriesList('ph') });
    const items: string[] = st.showOut ? [`<span><span class="sw" style="background:${cssVar('--accent')}"></span>Output</span>`] : [];
    if (cmp) items.push(`<span><span class="sw" style="background:${cssVar('--compare')}"></span>${esc(cmp.label)} (other tab)</span>`);
    res.probes.forEach(p => items.push(`<span><span class="sw" style="background:${p.color}"></span>${esc(p.ref)}</span>`));
    if (ideal && st.showOut) items.push('<span><span class="sw" style="background:repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 7px)"></span>Ideal source/load</span>');
    // Switch positions are discrete: one swatch each. Values and rotations: a colour ramp.
    if (sweep.length && st.showOut) {
      if (st.sweep.startsWith('pos:')) sweep.forEach(s => items.push(`<span><span class="sw" style="background:${sweepColor(s.r)}"></span>${esc(s.label)}</span>`));
      else items.push(`<span><span class="ramp" style="background:linear-gradient(90deg, ${sweepColor(0)}, ${sweepColor(1)})"></span>${esc(sweep[0].label)} → ${esc(sweep[sweep.length - 1].label)}</span>`);
    }
    if (st.showTol && tolBand && st.showOut) items.push(`<span><span class="sw" style="background:var(--accent-soft);height:8px"></span>R ±${S.settings.rTol}% · C ±${S.settings.cTol}%</span>`);
    if (!res.probes.length) items.push(st.showOut ? '<span class="hint">Add probes (Probe in the toolbar, or X) to see other nets.</span>' : '<span class="hint">Output is hidden and there are no probes: add a probe or tick Output.</span>');
    $('#bLegend').innerHTML = items.join('');
  }
  for (const id of ['#bSimCanvas', '#bSimPhase']) {
    const cv = $<HTMLCanvasElement>(id);
    cv.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect(), u = (e.clientX - r.left - PLOT_MARGIN.l) / (r.width - PLOT_MARGIN.l - PLOT_MARGIN.r);
      const [a, b] = fRange();
      hoverF = u >= 0 && u <= 1 ? a * Math.pow(b / a, u) : null;
      draw();
    });
    cv.addEventListener('pointerleave', () => { hoverF = null; draw(); });
    new ResizeObserver(() => draw()).observe(cv);
  }
  // Header settings (range, tolerances) affect the plot.
  for (const id of ['#range', '#rTol', '#cTol']) document.querySelector(id)?.addEventListener('change', () => schedule(true));

  function syncControls(): void {
    $('#bShowOut').checked = st.showOut; $('#bShowTol').checked = st.showTol; $('#bShowPhase').checked = st.showPhase;
    $('#bSweepSteps').value = String(st.steps);
    renderTerm(); renderSweepOptions();
  }

  renderTerm();
  return {
    settings: () => JSON.parse(JSON.stringify({ term: st.term, showOut: st.showOut, showTol: st.showTol, showPhase: st.showPhase, sweep: st.sweep, steps: st.steps })),
    apply: sim => {
      const d = DEFAULTS;
      Object.assign(st, { showOut: sim.showOut ?? d.showOut, showTol: sim.showTol ?? d.showTol, showPhase: sim.showPhase ?? d.showPhase, sweep: sim.sweep ?? '', steps: sim.steps ?? d.steps });
      st.term = { src: { ...d.term.src, ...sim.term?.src }, load: { ...d.term.load, ...sim.term?.load } };
      save(); syncControls(); schedule(true);
    },
    update: (d, x, committed) => { doc = d; ex = x; schedule(committed); },
    compare: () => compareId,
    setCompare: id => { compareId = id; renderCompareOptions(); schedule(false); },
    setCompareSource: src => { compareSrc = src; },
    refreshCompare: () => { renderCompareOptions(); renderTerm(); schedule(false); },
    chain: () => chainFrom,
    setChain: id => { chainFrom = id; renderTerm(); schedule(true); },
    setChainHost: h => { chainHost = h; },
    upstream,
    activeTerm: term,
    redraw: draw,
  };
}
