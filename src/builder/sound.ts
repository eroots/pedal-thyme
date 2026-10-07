// Builder "Sound" panel: run a signal through the circuit in the time domain (in workers), then show
// the waveform and spectrum (with THD for a sine) and play the result against the bypassed signal.
// A sweep renders several versions at once (input level, a pot, a part value, a switch position) and
// overlays them, with a table of swing, gain and THD per step.
import type { Term } from '../core/termination';
import { fmtEng } from '../core/units';
import { harmonics, peakOf, rmsOf, spectrum, wav } from '../audio/analysis';
import RenderWorker from '../audio/render.worker?worker&inline';
import type { RenderMessage, RenderRequest } from '../audio/render.worker';
import { E_MAJOR, fadingSine, normalize, pluck, sine } from '../audio/signals';
import type { Netlist, Node } from '../engine/netlist';
import { sweepColor } from '../playground/state';
import { extract, type Extraction } from '../schematic/extract';
import type { Schematic } from '../schematic/types';
import { download } from '../ui/download';
import { cssVar, drawPlot, type PlotMarker, type PlotSeries } from '../ui/plot';
import { drawScope, type ScopeTrace } from '../ui/scope';
import { probesOf, sweepTargets, sweepVariants } from './sim';

const FS = 48000;
/** Input-level sweep range (volts peak): clean to well into clipping for most pedals. */
const LEVEL_SWEEP: [number, number] = [0.025, 2];
const $ = <T extends HTMLElement = HTMLSelectElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface SoundContext {
  ex: Extraction; doc: Schematic; term: Term | null; name: string;
  /** Extra nets to show (default: the document's probes). */
  probes?: { ref: string; color: string; net: Node }[];
  /** How a swept version of `doc` is simulated (e.g. with the pedals feeding it); default: on its own. */
  wrap?: (ex: Extraction) => Extraction;
}

/** One rendered version (a sweep has several). */
interface Run {
  label: string;
  /** Position in the sweep, 0…1 (for its colour). */
  r: number;
  input: Float64Array;
  out: Float64Array;
  probes: { ref: string; color: string; y: Float64Array }[];
  unconverged: number;
}

interface Result {
  runs: Run[];
  sweep: string;
  sineHz: number | null;
  /** Samples at the end that are steady state (whole cycles of a sine), for THD and the spectrum. */
  tail: number;
  /** A steady sine rendered by cycles: the spectrum repeats its cycles (sharper than a short FFT). */
  periodic: boolean;
  fading: boolean;
  label: string;
  rails: [number, number];
  ms: number;
}

/** A tab's rendered sound (kept per tab, so each pedal can be listened to after switching). */
export interface SoundState { res: unknown; stale: boolean }

export interface SoundPanel {
  invalidate(): void;
  redraw(): void;
  state(): SoundState;
  /** Show another tab's render (cancelling one in progress). */
  restore(s: SoundState | null): void;
}

/** `P` prefixes the element ids (the Builder's panel uses "sd", the Pedalboard's a copy with its own). */
export function initSoundPanel(ctx: () => SoundContext, P = 'sd'): SoundPanel {
  let res: Result | null = null;
  let stale = false;
  const workers = new Set<Worker>();
  let busy = false;
  let fileSignal: { name: string; x: Float64Array } | null = null;
  let audio: AudioContext | null = null;
  let playing: AudioBufferSourceNode | null = null;

  const msg = (html: string) => { $(`#${P}Msg`).innerHTML = html; };
  const syncSource = () => {
    const s = $(`#${P}Source`).value;
    $(`#${P}FreqL`).hidden = s !== 'sine' && s !== 'fade';
    $(`#${P}NoteL`).hidden = s !== 'note';
    $(`#${P}FileL`).hidden = s !== 'file';
    // A steady sine is rendered by cycles (fast); everything else by time.
    $(`#${P}CyclesL`).hidden = s !== 'sine';
    $(`#${P}DurL`).hidden = s === 'sine';
    $(`#${P}StepsL`).hidden = !$(`#${P}Sweep`).value;
  };
  $(`#${P}Source`).addEventListener('change', syncSource);
  $(`#${P}Sweep`).addEventListener('change', syncSource);

  /** Sweep choices: input level, plus the parts marked Sweepable (not while setting up: ctx isn't ready yet). */
  function renderSweepOptions(parts = true): void {
    const sel = $<HTMLSelectElement>(`#${P}Sweep`), was = sel.value;
    const targets = parts ? sweepTargets(ctx().doc) : [];
    sel.innerHTML = '<option value="">Off</option>' +
      `<option value="level">Input level (${fmtEng(LEVEL_SWEEP[0], 'V')} … ${fmtEng(LEVEL_SWEEP[1], 'V')})</option>` +
      targets.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === was) ? was : '';
    syncSource();
  }
  renderSweepOptions(false);

  // Audio files: decoded with Web Audio, mixed to mono and resampled to 48 kHz.
  $(`#${P}FileBtn`).addEventListener('click', () => $<HTMLInputElement>(`#${P}File`).click());
  $<HTMLInputElement>(`#${P}File`).addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    try {
      audio ??= new AudioContext();
      const decoded = await audio.decodeAudioData(await f.arrayBuffer());
      const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * FS), FS);
      const src = off.createBufferSource();
      src.buffer = decoded; src.connect(off.destination); src.start();
      const mono = await off.startRendering();
      fileSignal = { name: f.name, x: Float64Array.from(mono.getChannelData(0)) };
      $(`#${P}FileName`).textContent = `${f.name} (${decoded.duration.toFixed(1)} s)`;
    } catch (err) {
      alert(`Couldn’t read ${f.name} as audio: ${(err as Error).message}`);
    }
  });

  /** The test signal at a given level, and how much of its end is steady state. */
  function makeInput(level: number): { x: Float64Array; sineHz: number | null; label: string; tail: number; periodic: boolean; fading: boolean } | null {
    const dur = +$(`#${P}Dur`).value, src = $(`#${P}Source`).value, f = +$(`#${P}Freq`).value;
    if (src === 'sine') {
      // The shown cycles, after one lead-in cycle (fade-in and settling).
      const cycles = +$(`#${P}Cycles`).value;
      const x = sine(f, level, (cycles + 1) / f, FS, 1 / f);
      return { x, sineHz: f, label: `${f} Hz sine, ${cycles} cycles`, tail: Math.min(x.length, Math.round((cycles * FS) / f)), periodic: true, fading: false };
    }
    if (src === 'fade') return { x: fadingSine(f, level, dur, FS), sineHz: null, label: `${f} Hz fading sine`, tail: Math.round(dur * FS), periodic: false, fading: true };
    const n = Math.round(dur * FS), base = { sineHz: null, tail: n, periodic: false, fading: false };
    if (src === 'note') { const nf = +$(`#${P}Note`).value; return { ...base, x: pluck([nf], level, dur, FS), label: `plucked ${$(`#${P}Note`).selectedOptions[0].text}` }; }
    if (src === 'chord') return { ...base, x: pluck(E_MAJOR, level, dur, FS), label: 'strummed E chord' };
    if (!fileSignal) { msg('Choose an audio file first (a DI guitar recording works best).'); return null; }
    return { ...base, x: normalize(fileSignal.x.slice(0, n), level), label: fileSignal.name };
  }

  /* ---------- Rendering (one worker per run, a few at a time) ---------- */
  interface Job { label: string; r: number; netlist: Netlist; input: Float64Array; probes: { ref: string; color: string; net: Node }[] }
  function stopWorkers(): void {
    for (const w of workers) w.terminate();
    workers.clear();
    busy = false;
    $<HTMLProgressElement>(`#${P}Prog`).hidden = true;
    $<HTMLButtonElement>(`#${P}Render`).disabled = false;
  }
  async function renderJobs(jobs: Job[], term: Term | null, onProgress: (f: number) => void): Promise<{ runs: Run[]; rails: [number, number] }> {
    const oversample = +$(`#${P}Os`).value, frac = jobs.map(() => 0);
    const runs: Run[] = new Array(jobs.length);
    let rails: [number, number] = [0, 0], next = 0;
    const one = (k: number) => new Promise<void>((resolve, reject) => {
      const j = jobs[k], w = new RenderWorker();
      workers.add(w);
      const req: RenderRequest = { netlist: j.netlist, input: j.input, fs: FS, oversample, term, probes: j.probes.map(p => p.net) };
      w.onmessage = (e: MessageEvent<RenderMessage>) => {
        const m = e.data;
        if (m.type === 'progress') { frac[k] = m.fraction; onProgress(frac.reduce((a, b) => a + b, 0) / jobs.length); return; }
        w.terminate(); workers.delete(w);
        if (m.type === 'error') { reject(new Error(m.message)); return; }
        const out = new Map<Node, Float64Array>(m.out);
        runs[k] = {
          label: j.label, r: j.r, input: j.input, out: out.get(j.netlist.output)!, unconverged: m.unconverged,
          probes: j.probes.map(p => ({ ref: p.ref, color: p.color, y: out.get(p.net)! })).filter(p => p.y),
        };
        rails = [Math.min(rails[0], m.rails[0]), Math.max(rails[1], m.rails[1])];
        resolve();
      };
      w.postMessage(req);
    });
    const lanes = Math.max(1, Math.min(jobs.length, (navigator.hardwareConcurrency || 4) - 1, 6));
    await Promise.all(Array.from({ length: lanes }, async () => { while (next < jobs.length) await one(next++); }));
    return { runs, rails };
  }

  $(`#${P}Render`).addEventListener('click', async () => {
    const c = ctx();
    if (c.ex.issues.some(i => i.severity === 'error')) { msg('Fix the errors listed under Checks first.'); return; }
    const level = +$(`#${P}Level`).value, sweepId = $(`#${P}Sweep`).value, steps = +$(`#${P}Steps`).value;
    const base = makeInput(level);
    if (!base) return;
    const probes = c.probes ?? probesOf(c.doc, c.ex);
    let jobs: Job[];
    if (sweepId === 'level') {
      jobs = Array.from({ length: steps }, (_, i) => {
        const r = steps > 1 ? i / (steps - 1) : 0, v = LEVEL_SWEEP[0] * (LEVEL_SWEEP[1] / LEVEL_SWEEP[0]) ** r;
        return { label: `${fmtEng(v, 'V')} in`, r, netlist: c.ex.netlist, input: makeInput(v)!.x, probes };
      });
    } else if (sweepId) {
      const wrap = c.wrap ?? ((x: Extraction) => x);
      jobs = [];
      for (const v of sweepVariants(c.doc, sweepId, steps)) {
        const vx = extract(v.doc);
        if (vx.issues.some(i => i.severity === 'error')) continue;
        jobs.push({ label: v.label, r: v.r, netlist: wrap(vx).netlist, input: base.x, probes: probesOf(v.doc, vx) });
      }
      if (!jobs.length) { msg('None of the swept versions can be simulated.'); return; }
    } else jobs = [{ label: 'Output', r: 0, netlist: c.ex.netlist, input: base.x, probes }];

    stopWorkers();
    busy = true;
    const prog = $<HTMLProgressElement>(`#${P}Prog`);
    prog.hidden = false; prog.value = 0;
    $<HTMLButtonElement>(`#${P}Render`).disabled = true;
    msg(jobs.length > 1 ? `Simulating ${jobs.length} versions…` : 'Simulating…');
    const t0 = performance.now();
    try {
      const { runs, rails } = await renderJobs(jobs, c.term, f => { prog.value = f; });
      if (!busy) return; // cancelled (e.g. switched tabs)
      res = { runs, sweep: sweepId, sineHz: base.sineHz, tail: base.tail, periodic: base.periodic, fading: base.fading, label: base.label, rails, ms: performance.now() - t0 };
      pick = runs.length - 1;
      stale = false;
      renderPick();
      draw();
    } catch (err) {
      if (busy) msg(`The simulation failed: ${esc((err as Error).message)}`);
    } finally {
      if (busy) stopWorkers();
    }
  });

  /* ---------- Which step of a sweep the spectrum and playback use ---------- */
  let pick = 0;
  function renderPick(): void {
    const el = $<HTMLSelectElement>(`#${P}Pick`), many = !!res && res.runs.length > 1;
    $(`#${P}PickL`).hidden = !many;
    if (!many) return;
    pick = Math.min(pick, res!.runs.length - 1);
    el.innerHTML = res!.runs.map((r, i) => `<option value="${i}" ${i === pick ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
  }
  $(`#${P}Pick`).addEventListener('change', e => { pick = +(e.target as HTMLSelectElement).value; draw(); });
  $(`#${P}Table`).addEventListener('click', e => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-i]');
    if (tr) { pick = +tr.dataset.i!; renderPick(); draw(); }
  });

  /* ---------- Drawing ---------- */
  $(`#${P}Win`).addEventListener('change', () => draw());
  $<HTMLInputElement>(`#${P}Pos`).addEventListener('input', () => draw());
  /** Steady-state stats of a run: swing, DC level, gain and THD (for a sine). */
  function stats(r: Result, run: Run) {
    const n = run.out.length, from = Math.max(0, n - r.tail);
    let lo = Infinity, hi = -Infinity, sum = 0, ilo = Infinity, ihi = -Infinity;
    for (let i = from; i < n; i++) { lo = Math.min(lo, run.out[i]); hi = Math.max(hi, run.out[i]); sum += run.out[i]; ilo = Math.min(ilo, run.input[i]); ihi = Math.max(ihi, run.input[i]); }
    const h = r.sineHz ? harmonics(run.out, r.sineHz, FS, 10, r.tail / FS) : null;
    const hin = r.sineHz ? harmonics(run.input, r.sineHz, FS, 1, r.tail / FS) : null;
    const gain = h && hin && hin.levels[0] > 0 ? 20 * Math.log10(h.levels[0] / hin.levels[0]) : 20 * Math.log10((hi - lo) / Math.max(ihi - ilo, 1e-12));
    return { pp: hi - lo, dc: sum / Math.max(1, n - from), gain, h };
  }
  function draw(): void {
    const scope = $<HTMLCanvasElement>(`#${P}Scope`), spec = $<HTMLCanvasElement>(`#${P}Spec`);
    if (!res) {
      for (const cv of [scope, spec]) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
      $(`#${P}Thd`).textContent = ''; $(`#${P}Legend`).innerHTML = ''; $(`#${P}Table`).innerHTML = '';
      $(`#${P}PickL`).hidden = true;
      return;
    }
    const r = res, many = r.runs.length > 1, run = r.runs[Math.min(pick, r.runs.length - 1)], n = run.out.length;
    // Waveform window: a few cycles of a sine at the end (steady state), a fading sine whole, otherwise a slice.
    const win = $(`#${P}Win`).value;
    let count = win === 'auto' ? (r.sineHz ? Math.round((3 * FS) / r.sineHz) : r.fading ? n : Math.round(0.02 * FS)) : win === 'all' ? n : Math.round(+win * FS);
    count = Math.max(16, Math.min(n, count));
    const pos = +$<HTMLInputElement>(`#${P}Pos`).value / 1000;
    const start = Math.max(0, Math.min(n - count, Math.round(pos * (n - count))));
    const accent = cssVar('--accent'), muted = cssVar('--muted');
    const traces: ScopeTrace[] = many
      ? [{ vals: run.input, color: muted, width: 1.2, dash: [4, 3], label: `Input (${run.label})` },
        ...r.runs.map(x => ({ vals: x.out, color: sweepColor(x.r), width: x === run ? 2.4 : 1.4, label: x.label }))]
      : [{ vals: run.input, color: muted, width: 1.2, dash: [4, 3], label: 'Input' },
        ...run.probes.map(p => ({ vals: p.y, color: p.color, width: 1.5, label: p.ref })),
        { vals: run.out, color: accent, width: 2, label: 'Output' }];
    drawScope(scope, { fs: FS, start, count, traces });
    // Spectrum of the steady part (a sine's whole cycles repeated, so a few cycles still resolve sharply).
    const steady = (x: Float64Array) => {
      const t = x.subarray(Math.max(0, x.length - r.tail));
      if (!r.periodic) return t;
      const rep = new Float64Array(1 << 15);
      for (let i = 0; i < rep.length; i++) rep[i] = t[i % t.length];
      return rep;
    };
    const so = spectrum(steady(run.out), FS), si = spectrum(steady(run.input), FS);
    const top = Math.ceil((Math.max(...so.dbv, ...si.dbv) + 5) / 10) * 10;
    const outColor = many ? sweepColor(run.r) : accent;
    const series: PlotSeries[] = [{ vals: si.dbv, color: muted, width: 1, label: 'Input' }, { vals: so.dbv, color: outColor, width: 1.6, label: many ? run.label : 'Output' }];
    const markers: PlotMarker[] = [];
    const st = stats(r, run);
    let thd = '';
    if (r.sineHz && st.h) {
      for (let k = 2; k <= 5; k++) if (k * r.sineHz < 20000) markers.push({ f: k * r.sineHz, label: `H${k}`, color: muted });
      const rel = (k: number) => (st.h!.levels[k - 1] > 0 ? 20 * Math.log10(st.h!.levels[k - 1] / st.h!.levels[0]) : -Infinity);
      thd = `${many ? esc(run.label) + ': ' : ''}THD ${st.h.thd < 0.1 ? st.h.thd.toFixed(3) : st.h.thd.toFixed(1)} % · H2 ${rel(2).toFixed(0)} dB · H3 ${rel(3).toFixed(0)} dB · gain ${st.gain >= 0 ? '+' : ''}${st.gain.toFixed(1)} dB`;
    } else if (many) thd = run.label;
    drawPlot(spec, { freqs: so.freqs, fr: [20, 20000], y0: top - 120, y1: top, step: 20, unit: '', series, markers });
    $(`#${P}Thd`).textContent = thd;
    $(`#${P}Legend`).innerHTML = many
      ? `<span><span class="ramp" style="background:linear-gradient(90deg, ${sweepColor(0)}, ${sweepColor(1)})"></span>${esc(r.runs[0].label)} → ${esc(r.runs[r.runs.length - 1].label)}</span><span><span class="sw" style="background:${muted}"></span>Input</span>`
      : traces.slice().reverse().map(t => `<span><span class="sw" style="background:${t.color}"></span>${esc(t.label)}</span>`).join('');
    // A sweep: one row per step (click a row to show that step's spectrum and play it).
    $(`#${P}Table`).innerHTML = many
      ? `<table class="sd-table"><tr><th></th><th>${r.sweep === 'level' ? 'Input' : 'Step'}</th><th>Output p-p</th><th>Gain</th><th>${r.sineHz ? 'THD' : ''}</th></tr>${r.runs.map((x, i) => {
          const s = stats(r, x);
          return `<tr data-i="${i}" class="${x === run ? 'on' : ''}"><td><span class="sw" style="background:${sweepColor(x.r)}"></span></td><td>${esc(x.label)}</td><td>${s.pp.toFixed(2)} V</td><td>${s.gain >= 0 ? '+' : ''}${s.gain.toFixed(1)} dB</td><td>${s.h ? `${s.h.thd < 0.1 ? s.h.thd.toFixed(3) : s.h.thd.toFixed(1)} %` : ''}</td></tr>`;
        }).join('')}</table>`
      : '';
    const dcNote = Math.abs(st.dc) > 0.05 ? ` around ${st.dc.toFixed(2)} V DC (no output coupling capacitor?)` : '';
    const unconverged = r.runs.reduce((a, x) => a + x.unconverged, 0);
    const warn = unconverged ? ` <span class="warnc">${unconverged} steps didn't fully converge; treat the result as approximate.</span>` : '';
    msg(`${stale ? '<span class="warnc">The circuit has changed: Render again.</span> ' : ''}${esc(r.label)}${many ? ` (${esc(run.label)})` : ''}: output swings ${st.pp.toFixed(2)} V peak-to-peak${dcNote}. ` +
      `Op-amps clip between ${r.rails[0].toFixed(1)} and ${r.rails[1].toFixed(1)} V less their headroom. Rendered in ${r.ms < 1000 ? `${Math.round(r.ms)} ms` : `${(r.ms / 1000).toFixed(1)} s`}.${warn}`);
  }

  /* ---------- Playback and download ---------- */
  const current = (): Run | null => (res ? res.runs[Math.min(pick, res.runs.length - 1)] : null);
  /** Scale for listening: both at the same loudness, or both by one factor (so the pedal's gain is audible). */
  const scales = (r: Run): [number, number] => {
    if ($<HTMLInputElement>(`#${P}Match`).checked) {
      const target = 0.12;
      return [Math.min(target / Math.max(rmsOf(r.input), 1e-9), 0.95 / Math.max(peakOf(r.input), 1e-9)), Math.min(target / Math.max(rmsOf(r.out), 1e-9), 0.95 / Math.max(peakOf(r.out), 1e-9))];
    }
    const k = 0.9 / Math.max(peakOf(r.input), peakOf(r.out), 1e-9);
    return [k, k];
  };
  const play = (wet: boolean) => {
    const r = current();
    if (!r) return;
    stop();
    audio ??= new AudioContext();
    const [kd, kw] = scales(r), x = wet ? r.out : r.input, k = wet ? kw : kd;
    // Remove the DC bias of the output (coupling caps are part of the circuit, but probes may not be).
    let mean = 0;
    for (const v of x) mean += v;
    mean /= x.length;
    const buf = audio.createBuffer(1, x.length, FS);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < x.length; i++) ch[i] = (x[i] - mean) * k;
    playing = audio.createBufferSource();
    playing.buffer = buf; playing.connect(audio.destination); playing.start();
  };
  const stop = () => { try { playing?.stop(); } catch { /* already stopped */ } playing = null; };
  $(`#${P}PlayWet`).addEventListener('click', () => play(true));
  $(`#${P}PlayDry`).addEventListener('click', () => play(false));
  $(`#${P}Stop`).addEventListener('click', stop);
  $(`#${P}Download`).addEventListener('click', () => {
    const r = current();
    if (!r || !res) return;
    const k = 0.9 / Math.max(peakOf(r.out), 1e-9);
    let mean = 0;
    for (const v of r.out) mean += v;
    mean /= r.out.length;
    const base = (ctx().name || 'pedal').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'pedal';
    const label = res.runs.length > 1 ? `${res.label}-${r.label}` : res.label;
    download(`${base}-${label.replace(/[^\w]+/g, '-').toLowerCase()}.wav`, wav(r.out.map(v => (v - mean) * k), FS));
  });

  return {
    invalidate: () => { renderSweepOptions(); if (res && !stale) { stale = true; draw(); } },
    redraw: () => { renderSweepOptions(); draw(); },
    state: () => ({ res, stale }),
    restore: s => {
      stop();
      if (busy) stopWorkers();
      res = (s?.res as Result | null) ?? null;
      // Renders from before sweeps existed hold a single run's fields.
      if (res && !Array.isArray((res as Partial<Result>).runs)) res = null;
      stale = s?.stale ?? false;
      pick = res ? res.runs.length - 1 : 0;
      if (!res) msg('');
      renderSweepOptions();
      renderPick();
      draw();
    },
  };
}
