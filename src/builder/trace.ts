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

/** Where the single trace picture was kept before tabs (read once, to carry it over). */
const LS_KEY = 'pedal-filter-lab.builder.trace';
/** Longest side of a rendered PDF page, in pixels. */
const PDF_PX = 2400;
/**
 * A new picture's longer side, in world units: about a pedal schematic drawn at this app's part sizes
 * (a resistor is 60 units long; the Tube Screamer template is about 1000 wide), so traced parts come out
 * close to the size of the parts drawn over them. Move / scale fine-tunes it.
 */
const TRACE_SPAN = 1400;

export function isTrace(t: unknown): t is Trace {
  const x = t as Trace;
  return !!x && typeof x.src === 'string' && /^data:image\//.test(x.src) && [x.w, x.h, x.x, x.y, x.scale, x.opacity].every(v => typeof v === 'number' && isFinite(v))
    && [0, 90, 180, 270].includes(x.rot) && typeof x.visible === 'boolean' && typeof x.name === 'string';
}

/** The pre-tabs trace picture, removed from localStorage once read. */
export function takeLegacyTrace(): Trace | null {
  try {
    const t = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    localStorage.removeItem(LS_KEY);
    return isTrace(t) ? t : null;
  } catch { return null; }
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
  // No XFA forms, and no WebAssembly decoders (they would be fetched from a URL); this pdf.js never evaluates code from a PDF.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), enableXfa: false, useWasm: false }).promise;
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

export interface TraceMenu {
  /** Replace the picture (e.g. from an opened project); it is stored. */
  set(t: Trace | null): void;
  /** Show a tab's picture (already stored). */
  show(t: Trace | null): void;
}

/** The Trace ▾ menu: load, show/hide, opacity, page, adjust, rotate, remove. `store` keeps the picture with the tab. */
export function initTrace(editor: Editor, hint: (msg: string | null) => void, store: (t: Trace | null) => void): TraceMenu {
  const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;
  let pdf: PdfSource | null = null;

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
  const persist = () => store(editor.trace);
  editor.onTrace = () => { persist(); sync(); };
  editor.onTraceAdjust = on => { hint(on ? 'Adjusting the trace picture: drag to move it, scroll to scale it. Esc or "Done adjusting" when it lines up.' : null); sync(); };

  // Place a new picture at a typical schematic size, centred on the current view, and zoom to show it.
  const place = (img: { src: string; w: number; h: number }, name: string, keep?: Trace | null) => {
    const v = editor.getView(), wrap = $('#bCanvasWrap');
    const cx = v.x + wrap.clientWidth / v.zoom / 2, cy = v.y + wrap.clientHeight / v.zoom / 2;
    const scale = keep ? keep.scale * (keep.w / img.w) : TRACE_SPAN / Math.max(img.w, img.h);
    const t: Trace = keep
      ? { ...keep, src: img.src, w: img.w, h: img.h, scale, name }
      : { src: img.src, w: img.w, h: img.h, x: cx - (img.w * scale) / 2, y: cy - (img.h * scale) / 2, scale, rot: 0, opacity: 0.45, visible: true, name };
    editor.setTrace(t);
    if (!keep) {
      editor.fitBox({ x0: t.x, y0: t.y, x1: t.x + img.w * scale, y1: t.y + img.h * scale });
      editor.setTraceAdjust(true);
    }
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

  sync();
  return {
    set: t => { pdf = null; editor.setTraceAdjust(false); editor.setTrace(t); },
    show: t => { pdf = null; editor.setTraceAdjust(false); editor.setTrace(t, false); sync(); },
  };
}
