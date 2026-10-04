// Builder "Sound" panel: run a signal through the circuit in the time domain (in a worker), then show
// the waveform and spectrum (with THD for a sine) and play the result against the bypassed signal.
import type { Term } from '../core/termination';
import { harmonics, peakOf, rmsOf, spectrum, wav } from '../audio/analysis';
import RenderWorker from '../audio/render.worker?worker&inline';
import type { RenderMessage, RenderRequest } from '../audio/render.worker';
import { E_MAJOR, normalize, pluck, sine } from '../audio/signals';
import type { Node } from '../engine/netlist';
import type { Extraction } from '../schematic/extract';
import type { Schematic } from '../schematic/types';
import { download } from '../ui/download';
import { cssVar, drawPlot, type PlotMarker, type PlotSeries } from '../ui/plot';
import { drawScope, type ScopeTrace } from '../ui/scope';
import { probesOf } from './sim';

const FS = 48000;
const $ = <T extends HTMLElement = HTMLSelectElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface SoundContext {
  ex: Extraction; doc: Schematic; term: Term | null; name: string;
  /** Extra nets to show (default: the document's probes). */
  probes?: { ref: string; color: string; net: Node }[];
}

interface Result {
  input: Float64Array;
  out: Float64Array;
  probes: { ref: string; color: string; y: Float64Array }[];
  sineHz: number | null;
  label: string;
  unconverged: number;
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
  let worker: Worker | null = null;
  let fileSignal: { name: string; x: Float64Array } | null = null;
  let audio: AudioContext | null = null;
  let playing: AudioBufferSourceNode | null = null;

  const msg = (html: string) => { $(`#${P}Msg`).innerHTML = html; };
  const syncSource = () => {
    const s = $(`#${P}Source`).value;
    $(`#${P}FreqL`).hidden = s !== 'sine';
    $(`#${P}NoteL`).hidden = s !== 'note';
    $(`#${P}FileL`).hidden = s !== 'file';
  };
  $(`#${P}Source`).addEventListener('change', syncSource);
  syncSource();

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

  function makeInput(): { x: Float64Array; sineHz: number | null; label: string } | null {
    const level = +$(`#${P}Level`).value, dur = +$(`#${P}Dur`).value, src = $(`#${P}Source`).value;
    if (src === 'sine') { const f = +$(`#${P}Freq`).value; return { x: sine(f, level, dur, FS), sineHz: f, label: `${f} Hz sine` }; }
    if (src === 'note') { const f = +$(`#${P}Note`).value; return { x: pluck([f], level, dur, FS), sineHz: null, label: `plucked ${$(`#${P}Note`).selectedOptions[0].text}` }; }
    if (src === 'chord') return { x: pluck(E_MAJOR, level, dur, FS), sineHz: null, label: 'strummed E chord' };
    if (!fileSignal) { msg('Choose an audio file first (a DI guitar recording works best).'); return null; }
    return { x: normalize(fileSignal.x.slice(0, Math.round(dur * FS)), level), sineHz: null, label: fileSignal.name };
  }

  $(`#${P}Render`).addEventListener('click', () => {
    const c = ctx();
    if (c.ex.issues.some(i => i.severity === 'error')) { msg('Fix the errors listed under Checks first.'); return; }
    const inp = makeInput();
    if (!inp) return;
    worker?.terminate();
    worker = new RenderWorker();
    const probes = c.probes ?? probesOf(c.doc, c.ex);
    const req: RenderRequest = { netlist: c.ex.netlist, input: inp.x, fs: FS, oversample: +$(`#${P}Os`).value, term: c.term, probes: probes.map(p => p.net) };
    const prog = $<HTMLProgressElement>(`#${P}Prog`);
    prog.hidden = false; prog.value = 0;
    $<HTMLButtonElement>(`#${P}Render`).disabled = true;
    msg('Simulating…');
    worker.onmessage = (e: MessageEvent<RenderMessage>) => {
      const m = e.data;
      if (m.type === 'progress') { prog.value = m.fraction; return; }
      prog.hidden = true;
      $<HTMLButtonElement>(`#${P}Render`).disabled = false;
      worker?.terminate(); worker = null;
      if (m.type === 'error') { msg(`The simulation failed: ${esc(m.message)}`); return; }
      const out = new Map<Node, Float64Array>(m.out);
      res = {
        input: inp.x, out: out.get(c.ex.netlist.output)!, sineHz: inp.sineHz, label: inp.label,
        probes: probes.map(p => ({ ref: p.ref, color: p.color, y: out.get(p.net)! })).filter(p => p.y),
        unconverged: m.unconverged, rails: m.rails, ms: m.ms,
      };
      stale = false;
      draw();
    };
    worker.postMessage(req, [inp.x.buffer.slice(0)]);
  });

  /* ---------- Drawing ---------- */
  $(`#${P}Win`).addEventListener('change', () => draw());
  $<HTMLInputElement>(`#${P}Pos`).addEventListener('input', () => draw());
  function draw(): void {
    const scope = $<HTMLCanvasElement>(`#${P}Scope`), spec = $<HTMLCanvasElement>(`#${P}Spec`);
    if (!res) {
      for (const cv of [scope, spec]) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
      $(`#${P}Thd`).textContent = ''; $(`#${P}Legend`).innerHTML = '';
      return;
    }
    const r = res, n = r.out.length;
    // Waveform window: a few cycles of a sine at the end (steady state), otherwise a slice chosen by the slider.
    const win = $(`#${P}Win`).value;
    let count = win === 'auto' ? (r.sineHz ? Math.round((3 * FS) / r.sineHz) : Math.round(0.02 * FS)) : win === 'all' ? n : Math.round(+win * FS);
    count = Math.max(16, Math.min(n, count));
    const pos = +$<HTMLInputElement>(`#${P}Pos`).value / 1000;
    const start = Math.max(0, Math.min(n - count, Math.round(pos * (n - count))));
    const accent = cssVar('--accent'), muted = cssVar('--muted');
    const traces: ScopeTrace[] = [
      { vals: r.input, color: muted, width: 1.2, dash: [4, 3], label: 'Input' },
      ...r.probes.map(p => ({ vals: p.y, color: p.color, width: 1.5, label: p.ref })),
      { vals: r.out, color: accent, width: 2, label: 'Output' },
    ];
    drawScope(scope, { fs: FS, start, count, traces });
    // Spectrum of the last part (steady state for a sine).
    const so = spectrum(r.out, FS), si = spectrum(r.input, FS);
    const top = Math.ceil((Math.max(...so.dbv, ...si.dbv) + 5) / 10) * 10;
    const series: PlotSeries[] = [{ vals: si.dbv, color: muted, width: 1, label: 'Input' }, { vals: so.dbv, color: accent, width: 1.6, label: 'Output' }];
    const markers: PlotMarker[] = [];
    let thd = '';
    if (r.sineHz) {
      const h = harmonics(r.out, r.sineHz, FS), hin = harmonics(r.input, r.sineHz, FS, 1);
      for (let k = 2; k <= 5; k++) if (k * r.sineHz < 20000) markers.push({ f: k * r.sineHz, label: `H${k}`, color: muted });
      const rel = (k: number) => (h.levels[k - 1] > 0 ? 20 * Math.log10(h.levels[k - 1] / h.levels[0]) : -Infinity);
      const gain = 20 * Math.log10(h.levels[0] / hin.levels[0]);
      thd = `THD ${h.thd < 0.1 ? h.thd.toFixed(3) : h.thd.toFixed(1)} % · H2 ${rel(2).toFixed(0)} dB · H3 ${rel(3).toFixed(0)} dB · gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`;
    }
    drawPlot(spec, { freqs: so.freqs, fr: [20, 20000], y0: top - 120, y1: top, step: 20, unit: '', series, markers });
    $(`#${P}Thd`).textContent = thd;
    $(`#${P}Legend`).innerHTML = traces.slice().reverse().map(t => `<span><span class="sw" style="background:${t.color}"></span>${esc(t.label)}</span>`).join('');
    // Swing and DC level over the second half (after any start-up settling).
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let i = Math.floor(n / 2); i < n; i++) { lo = Math.min(lo, r.out[i]); hi = Math.max(hi, r.out[i]); sum += r.out[i]; }
    const dc = sum / (n - Math.floor(n / 2));
    const dcNote = Math.abs(dc) > 0.05 ? ` around ${dc.toFixed(2)} V DC (no output coupling capacitor?)` : '';
    const warn = r.unconverged ? ` <span class="warnc">${r.unconverged} steps didn't fully converge; treat the result as approximate.</span>` : '';
    msg(`${stale ? '<span class="warnc">The circuit has changed: Render again.</span> ' : ''}${esc(r.label)}: output swings ${(hi - lo).toFixed(2)} V peak-to-peak${dcNote}. ` +
      `Op-amps clip between ${r.rails[0].toFixed(1)} and ${r.rails[1].toFixed(1)} V less their headroom. Rendered in ${(r.ms / 1000).toFixed(1)} s.${warn}`);
  }

  /* ---------- Playback and download ---------- */
  /** Scale for listening: both at the same loudness, or both by one factor (so the pedal's gain is audible). */
  const scales = (r: Result): [number, number] => {
    if ($<HTMLInputElement>(`#${P}Match`).checked) {
      const target = 0.12;
      return [Math.min(target / Math.max(rmsOf(r.input), 1e-9), 0.95 / Math.max(peakOf(r.input), 1e-9)), Math.min(target / Math.max(rmsOf(r.out), 1e-9), 0.95 / Math.max(peakOf(r.out), 1e-9))];
    }
    const k = 0.9 / Math.max(peakOf(r.input), peakOf(r.out), 1e-9);
    return [k, k];
  };
  const play = (wet: boolean) => {
    if (!res) return;
    stop();
    audio ??= new AudioContext();
    const r = res, [kd, kw] = scales(r), x = wet ? r.out : r.input, k = wet ? kw : kd;
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
    if (!res) return;
    const k = 0.9 / Math.max(peakOf(res.out), 1e-9);
    let mean = 0;
    for (const v of res.out) mean += v;
    mean /= res.out.length;
    const base = (ctx().name || 'pedal').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'pedal';
    download(`${base}-${res.label.replace(/[^\w]+/g, '-').toLowerCase()}.wav`, wav(res.out.map(v => (v - mean) * k), FS));
  });

  return {
    invalidate: () => { if (res && !stale) { stale = true; draw(); } },
    redraw: draw,
    state: () => ({ res, stale }),
    restore: s => {
      stop();
      if (worker) {
        worker.terminate(); worker = null;
        $<HTMLProgressElement>(`#${P}Prog`).hidden = true;
        $<HTMLButtonElement>(`#${P}Render`).disabled = false;
      }
      res = (s?.res as Result | null) ?? null;
      stale = s?.stale ?? false;
      if (!res) msg('');
      draw();
    },
  };
}
