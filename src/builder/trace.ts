// Trace overlay: a picture of a schematic (image or PDF page) shown dimmed under the Builder canvas, so
// a circuit can be redrawn on top of it. The picture lives in its own layer and is not part of the circuit.
import type { Editor } from './editor';

export interface Trace {
  /** The picture as a data: URL (PDF pages are rendered to PNG). */
  src: string;
  /** Picture size in pixels. */
  w: number; h: number;
  /** World position of the picture's top-left corner (before rotation) and world units per pixel. */
  x: number; y: number; scale: number;
  /** Rotation about the picture's centre. */
  rot: 0 | 90 | 180 | 270;
  opacity: number;
  visible: boolean;
  name: string;
}

const LS_KEY = 'pedal-filter-lab.builder.trace';
/** Longest side of a rendered PDF page, in pixels. */
const PDF_PX = 2400;

export function isTrace(t: unknown): t is Trace {
  const x = t as Trace;
  return !!x && typeof x.src === 'string' && /^data:image\//.test(x.src) && [x.w, x.h, x.x, x.y, x.scale, x.opacity].every(v => typeof v === 'number' && isFinite(v));
}

export function loadSavedTrace(): Trace | null {
  try { const t = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return isTrace(t) ? t : null; } catch { return null; }
}

/** Keep the trace across reloads; returns false if it is too big for browser storage. */
export function saveTrace(t: Trace | null): boolean {
  try {
    if (t) localStorage.setItem(LS_KEY, JSON.stringify(t)); else localStorage.removeItem(LS_KEY);
    return true;
  } catch {
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    return false;
  }
}

/** SVG transform for the picture: position, then rotation about its centre. */
export const traceTransform = (t: Trace): string =>
  `translate(${t.x} ${t.y}) rotate(${t.rot} ${(t.w * t.scale) / 2} ${(t.h * t.scale) / 2})`;

const readAsDataUrl = (blob: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result as string);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
const imageSize = (src: string) => new Promise<{ w: number; h: number }>((res, rej) => {
  const img = new Image();
  img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
  img.onerror = () => rej(new Error('This image could not be read.'));
  img.src = src;
});

/** A loaded PDF (kept in memory so another page can be picked). */
export interface PdfSource { pages: number; render(page: number): Promise<{ src: string; w: number; h: number }> }

export async function openPdf(data: ArrayBuffer): Promise<PdfSource> {
  // pdf.js is only loaded when a PDF is opened. Its worker runs on the main thread (no separate file),
  // which keeps the single-file build working; rendering one page is quick enough.
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs')]);
  (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  return {
    pages: doc.numPages,
    async render(n) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PDF_PX / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      return { src: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
    },
  };
}

/** The Trace ▾ menu: load, show/hide, opacity, page, adjust, rotate, remove. */
export function initTrace(editor: Editor, hint: (msg: string | null) => void): { set(t: Trace | null): void } {
  const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;
  let pdf: PdfSource | null = null;
  let warnedSize = false;

  const sync = () => {
    const t = editor.trace;
    $('#bTraceCtl').hidden = !t;
    $('#bTraceMenu summary').classList.toggle('on', !!t && t.visible);
    if (!t) { $('#bTraceName').textContent = 'No picture loaded.'; return; }
    $('#bTraceName').textContent = t.name;
    $('#bTraceShow').checked = t.visible;
    $('#bTraceOpacity').value = String(Math.round(t.opacity * 100));
    $('#bTracePageRow').hidden = !pdf || pdf.pages < 2;
    $('#bTraceAdjust').classList.toggle('active', editor.traceAdjust);
    $('#bTraceAdjust').textContent = editor.traceAdjust ? 'Done adjusting' : 'Move / scale';
  };
  const persist = () => {
    if (!saveTrace(editor.trace) && !warnedSize) {
      warnedSize = true;
      hint('The trace picture is too large to keep after a reload; Save the pedal to keep it with the project.');
    }
  };
  editor.onTrace = () => { persist(); sync(); };
  editor.onTraceAdjust = on => { hint(on ? 'Adjusting the trace picture: drag to move it, scroll to scale it. Esc or "Done adjusting" when it lines up.' : null); sync(); };

  // Place a new picture so it fills most of the current view.
  const place = (img: { src: string; w: number; h: number }, name: string, keep?: Trace | null) => {
    const v = editor.getView(), wrap = $('#bCanvasWrap');
    const W = wrap.clientWidth / v.zoom, H = wrap.clientHeight / v.zoom;
    const scale = keep ? keep.scale * (keep.w / img.w) : Math.min((W * 0.9) / img.w, (H * 0.9) / img.h);
    const t: Trace = keep
      ? { ...keep, src: img.src, w: img.w, h: img.h, scale, name }
      : { src: img.src, w: img.w, h: img.h, x: v.x + (W - img.w * scale) / 2, y: v.y + (H - img.h * scale) / 2, scale, rot: 0, opacity: 0.45, visible: true, name };
    editor.setTrace(t);
    if (!keep) editor.setTraceAdjust(true);
  };

  $('#bTraceFile').addEventListener('change', async e => {
    const input = e.target as HTMLInputElement, f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        pdf = await openPdf(await f.arrayBuffer());
        $('#bTracePage').innerHTML = Array.from({ length: pdf.pages }, (_, i) => `<option value="${i + 1}">${i + 1} of ${pdf!.pages}</option>`).join('');
        place(await pdf.render(1), pdf.pages > 1 ? `${f.name}, page 1` : f.name);
      } else {
        pdf = null;
        const src = await readAsDataUrl(f);
        place({ src, ...(await imageSize(src)) }, f.name);
      }
      warnedSize = false;
    } catch (err) {
      alert(`Couldn’t load ${f.name} as a trace picture: ${(err as Error).message}`);
    }
    sync();
  });
  $('#bTracePage').addEventListener('change', async e => {
    if (!pdf || !editor.trace) return;
    const n = +(e.target as HTMLSelectElement).value;
    const name = editor.trace.name.replace(/, page \d+$/, '');
    place(await pdf.render(n), `${name}, page ${n}`, editor.trace);
  });
  $('#bTraceShow').addEventListener('change', e => {
    if (editor.trace) editor.setTrace({ ...editor.trace, visible: (e.target as HTMLInputElement).checked });
  });
  $('#bTraceOpacity').addEventListener('input', e => {
    if (editor.trace) editor.setTrace({ ...editor.trace, opacity: +(e.target as HTMLInputElement).value / 100 }, false);
  });
  $('#bTraceOpacity').addEventListener('change', () => persist());
  $('#bTraceAdjust').addEventListener('click', () => editor.setTraceAdjust(!editor.traceAdjust));
  $('#bTraceRotate').addEventListener('click', () => {
    if (editor.trace) editor.setTrace({ ...editor.trace, rot: ((editor.trace.rot + 90) % 360) as Trace['rot'] });
  });
  $('#bTraceRemove').addEventListener('click', () => { pdf = null; editor.setTraceAdjust(false); editor.setTrace(null); });

  editor.setTrace(loadSavedTrace(), false);
  sync();
  return { set: t => { pdf = null; editor.setTraceAdjust(false); editor.setTrace(t); } };
}
