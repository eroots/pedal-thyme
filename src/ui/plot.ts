// Log-frequency Bode plot drawn on a canvas, themed from CSS custom properties.
import { TAU, fmtEng } from '../core/units';

export const cssVar = (n: string): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export interface PlotSeries { vals: number[]; color: string; width?: number; label?: string; dash?: number[] }
export interface PlotMarker { f: number; label?: string; color: string }
export interface PlotConfig {
  freqs: number[];
  /** Visible frequency range [fmin, fmax]. */
  fr: [number, number];
  y0: number; y1: number; step: number;
  /** '' for dB, '°' for phase. */
  unit: '' | '°';
  series: PlotSeries[];
  band?: { lo: number[]; hi: number[] } | null;
  markers?: PlotMarker[];
  /** Phase plots: break lines at ±180° wraps. */
  wrap?: boolean;
  /** Frequency under the pointer, for the crosshair readout. */
  hoverF?: number | null;
}

/** Plot margins in CSS pixels; pointer handlers need them to map x → frequency. */
export const PLOT_MARGIN = { l: 46, r: 12, t: 12, b: 22 };

const fmtFreqShort = (f: number): string => (f >= 1000 ? (f / 1000) + 'k' : String(f));

export function drawPlot(canvas: HTMLCanvasElement, cfg: PlotConfig): void {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const m = PLOT_MARGIN, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const [fmin, fmax] = cfg.fr, lx0 = Math.log10(fmin), lx1 = Math.log10(fmax);
  const X = (f: number) => m.l + (Math.log10(f) - lx0) / (lx1 - lx0) * pw;
  const Y = (y: number) => m.t + (cfg.y1 - y) / (cfg.y1 - cfg.y0) * ph;
  const colGrid = cssVar('--grid'), colGridS = cssVar('--grid-strong'), colMuted = cssVar('--muted'), colInk = cssVar('--ink');
  g.font = '11px system-ui, sans-serif';

  // Frequency grid (labels are skipped where they would collide on narrow plots; decades win).
  const labelled: number[] = [];
  const fits = (x: number, w: number) => labelled.every(o => Math.abs(o - x) > w);
  for (let d = Math.floor(lx0); d <= Math.ceil(lx1); d++) {
    const f = 10 ** d;
    if (f >= fmin * 0.999 && f <= fmax * 1.001) labelled.push(X(f));
  }
  for (let d = Math.floor(lx0); d <= Math.ceil(lx1); d++) {
    for (let k = 1; k <= 9; k++) {
      const f = k * 10 ** d;
      if (f < fmin * 0.999 || f > fmax * 1.001) continue;
      const x = Math.round(X(f)) + 0.5;
      g.strokeStyle = k === 1 ? colGridS : colGrid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke();
      // Clearance: half of this label + half of a similar neighbour + a gap.
      const label = fmtFreqShort(f), w = g.measureText(label).width + 8;
      if (k === 1 || ((k === 2 || k === 5) && fits(x, w))) {
        if (k !== 1) labelled.push(x);
        g.fillStyle = colMuted; g.textAlign = 'center';
        g.fillText(label, x, H - 6);
      }
    }
  }
  // Value grid
  for (let y = Math.ceil(cfg.y0 / cfg.step) * cfg.step; y <= cfg.y1 + 1e-9; y += cfg.step) {
    const yy = Math.round(Y(y)) + 0.5;
    g.strokeStyle = y === 0 ? colGridS : colGrid;
    g.beginPath(); g.moveTo(m.l, yy); g.lineTo(m.l + pw, yy); g.stroke();
    g.fillStyle = colMuted; g.textAlign = 'right';
    g.fillText(y + cfg.unit, m.l - 6, yy + 4);
  }

  g.save();
  g.beginPath(); g.rect(m.l, m.t, pw, ph); g.clip();

  // Tolerance band
  if (cfg.band) {
    const fr = cfg.freqs, band = cfg.band;
    g.fillStyle = cssVar('--accent-soft');
    g.beginPath();
    fr.forEach((f, i) => { const x = X(f), y = Y(band.hi[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    for (let i = fr.length - 1; i >= 0; i--) g.lineTo(X(fr[i]), Y(band.lo[i]));
    g.closePath(); g.fill();
  }
  // Markers
  for (const mk of cfg.markers || []) {
    if (!(mk.f >= fmin && mk.f <= fmax)) continue;
    const x = Math.round(X(mk.f)) + 0.5;
    g.strokeStyle = mk.color; g.globalAlpha = 0.55; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    if (mk.label) { g.fillStyle = mk.color; g.textAlign = 'left'; g.fillText(mk.label, x + 4, m.t + 12); }
  }
  // Series, in order (callers put the current curve last so it's on top)
  for (const s of cfg.series) {
    g.strokeStyle = s.color; g.lineWidth = s.width || 2; g.setLineDash(s.dash || []);
    g.beginPath();
    let prev: number | null = null;
    s.vals.forEach((y, i) => {
      if (!isFinite(y)) { prev = null; return; }
      const x = X(cfg.freqs[i]), yy = Y(y);
      if (prev === null || (cfg.wrap && Math.abs(y - prev) > 180)) g.moveTo(x, yy); else g.lineTo(x, yy);
      prev = y;
    });
    g.stroke(); g.setLineDash([]);
  }
  g.restore();

  // Hover readout
  const hoverF = cfg.hoverF;
  if (hoverF && hoverF >= fmin && hoverF <= fmax) {
    const fr = cfg.freqs;
    let idx = 0, best = Infinity;
    for (let i = 0; i < fr.length; i++) { const d = Math.abs(Math.log(fr[i] / hoverF)); if (d < best) { best = d; idx = i; } }
    const x = Math.round(X(fr[idx])) + 0.5;
    g.strokeStyle = colMuted; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke();
    const lines: { text: string; color: string; label?: string }[] = [{ text: fmtEng(fr[idx], 'Hz'), color: colInk }];
    for (const s of cfg.series.slice().reverse()) {
      const y = s.vals[idx];
      if (!isFinite(y)) continue;
      g.fillStyle = s.color; g.beginPath(); g.arc(x, Y(y), 3.2, 0, TAU); g.fill();
      lines.push({ text: `${y.toFixed(cfg.unit === '°' ? 0 : 1)}${cfg.unit === '°' ? '°' : ' dB'}`, color: s.color, label: s.label });
    }
    const bw = 12 + Math.max(...lines.map(l => g.measureText((l.label ? l.label + '  ' : '') + l.text).width)) + (lines.length > 1 ? 10 : 0);
    const bh = 8 + lines.length * 15;
    let bx = x + 10; if (bx + bw > m.l + pw) bx = x - 10 - bw;
    const by = m.t + 4;
    g.fillStyle = cssVar('--panel'); g.strokeStyle = colGridS;
    g.globalAlpha = 0.94; g.fillRect(bx, by, bw, bh); g.globalAlpha = 1; g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    lines.forEach((l, i) => {
      const ty = by + 15 + i * 15;
      g.textAlign = 'left';
      if (i === 0) { g.fillStyle = colInk; g.fillText(l.text, bx + 6, ty); return; }
      g.fillStyle = l.color; g.fillRect(bx + 6, ty - 5, 8, 3);
      g.fillStyle = colInk; g.fillText(l.text, bx + 18, ty);
    });
  }
}

/** A tidy dB range (multiples of 6 dB, 18–72 dB tall) covering the given curves. */
export function magRange(arrays: number[][]): [number, number] {
  let mx = -Infinity, mn = Infinity;
  for (const a of arrays) for (const y of a) if (isFinite(y)) { if (y > mx) mx = y; if (y < mn) mn = y; }
  if (!isFinite(mx)) { mx = 0; mn = -40; }
  const top = Math.ceil((mx + 2) / 6) * 6;
  let bot = Math.floor((mn - 2) / 6) * 6;
  bot = Math.max(bot, top - 72);
  if (top - bot < 18) bot = top - 18;
  return [bot, top];
}
