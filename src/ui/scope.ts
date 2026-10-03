// Oscilloscope-style plot: volts against time (ms), for the time-domain simulation.
import { cssVar } from './plot';

export interface ScopeTrace { vals: ArrayLike<number>; color: string; width?: number; label?: string; dash?: number[] }
export interface ScopeConfig {
  fs: number;
  /** First sample and number of samples shown. */
  start: number; count: number;
  traces: ScopeTrace[];
  /** Fixed volt range; auto when omitted. */
  range?: [number, number];
}

const M = { l: 44, r: 10, t: 8, b: 22 };

export function drawScope(canvas: HTMLCanvasElement, cfg: ScopeConfig): void {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const { start, count, fs } = cfg;
  // Range: the traces' extent, padded, with a nice step.
  let lo = Infinity, hi = -Infinity;
  for (const t of cfg.traces) for (let i = start; i < start + count && i < t.vals.length; i++) { lo = Math.min(lo, t.vals[i]); hi = Math.max(hi, t.vals[i]); }
  if (cfg.range) [lo, hi] = cfg.range;
  if (!isFinite(lo)) { lo = -1; hi = 1; }
  if (hi - lo < 1e-3) { lo -= 0.5e-3; hi += 0.5e-3; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const step = niceStep((hi - lo) / 5);
  const X = (i: number) => M.l + ((i - start) / Math.max(1, count - 1)) * pw;
  const Y = (v: number) => M.t + ((hi - v) / (hi - lo)) * ph;
  g.font = '11px system-ui, sans-serif';
  g.lineWidth = 1;
  // Grid and labels.
  g.strokeStyle = cssVar('--grid'); g.fillStyle = cssVar('--muted');
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Y(v);
    g.beginPath(); g.moveTo(M.l, y); g.lineTo(W - M.r, y); g.stroke();
    g.fillText(fmtV(v, step), M.l - 4, y);
  }
  // Time ticks spaced so their labels fit (about 70 px each); seconds once past 1 s.
  const ms = (count / fs) * 1000, tstep = niceStep(ms / Math.max(2, Math.floor(pw / 70)));
  g.textAlign = 'center'; g.textBaseline = 'top';
  const t0 = (start / fs) * 1000;
  const fmtT = (tm: number) => (t0 + ms >= 1000 ? `${+(tm / 1000).toFixed(tstep < 1 ? 4 : 3)} s` : `${+tm.toFixed(tstep < 1 ? 2 : 1)} ms`);
  for (let tm = Math.ceil(t0 / tstep) * tstep; tm <= t0 + ms + 1e-9; tm += tstep) {
    const x = M.l + ((tm - t0) / ms) * pw;
    g.beginPath(); g.moveTo(x, M.t); g.lineTo(x, M.t + ph); g.stroke();
    g.fillText(fmtT(tm), x, M.t + ph + 4);
  }
  if (lo < 0 && hi > 0) { g.strokeStyle = cssVar('--grid-strong'); g.beginPath(); g.moveTo(M.l, Y(0)); g.lineTo(W - M.r, Y(0)); g.stroke(); }
  // Traces (decimated to ~2 points per pixel column: min/max).
  g.save();
  g.beginPath(); g.rect(M.l, M.t, pw, ph); g.clip();
  for (const t of cfg.traces) {
    g.strokeStyle = t.color; g.lineWidth = t.width ?? 1.6; g.setLineDash(t.dash ?? []);
    g.beginPath();
    const perPx = count / pw;
    if (perPx <= 2) {
      for (let i = start; i < start + count && i < t.vals.length; i++) { const x = X(i), y = Y(t.vals[i]); if (i === start) g.moveTo(x, y); else g.lineTo(x, y); }
    } else {
      for (let px = 0; px < pw; px++) {
        const a = start + Math.floor(px * perPx), b = Math.min(t.vals.length, start + Math.floor((px + 1) * perPx));
        let mn = Infinity, mx = -Infinity;
        for (let i = a; i < b; i++) { mn = Math.min(mn, t.vals[i]); mx = Math.max(mx, t.vals[i]); }
        if (!isFinite(mn)) continue;
        if (px === 0) g.moveTo(M.l + px, Y(mx)); else g.lineTo(M.l + px, Y(mx));
        g.lineTo(M.l + px, Y(mn));
      }
    }
    g.stroke();
  }
  g.restore();
  g.setLineDash([]);
  g.strokeStyle = cssVar('--grid-strong'); g.strokeRect(M.l, M.t, pw, ph);
}

function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function fmtV(v: number, step: number): string {
  if (Math.abs(v) < step / 1e6) return '0';
  return step < 0.01 ? `${+(v * 1000).toFixed(1)} mV` : `${+v.toFixed(step < 0.1 ? 2 : 1)} V`;
}
