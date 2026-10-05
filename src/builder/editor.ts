// Schematic canvas: pan/zoom, selection, moving, placing parts, drawing wires, undo/redo.
//
// Modes: 'select' (click/drag parts and wires, box-select on empty space), 'place' (a ghost part
// follows the cursor; click to drop, keep placing until Esc), 'wire' (click to start and bend,
// ending on a pin or wire finishes it; double-click or right-click also finishes), 'delete' (each
// click deletes the part or wire segment under the cursor, a dragged box deletes everything inside;
// stays on until Esc or right-click, like LTspice), 'copy' (click an item, or start with a selection,
// and a copy follows the cursor; click to drop copies, right-click to pick something else, Esc to stop).
import { renderSchematicBody } from '../schematic/render';
import { traceTransform, type Trace } from './trace';
import { pinsOf } from '../schematic/extract';
import type { Pt } from '../schematic/geometry';
import type { PartKind, Rot, Schematic } from '../schematic/types';
import {
  addNote, addPart, addWire, copySelection, cutWiresUnder, deleteSelection, deleteWireSegment, isConnection, makePart, mirrorParts, moveNotes, moveSelection,
  nearestAnchor, partBox, paste, rotateSelection, snapPt, wireSegmentAt, type Clip,
} from './doc';

export type Mode = 'select' | 'wire' | 'place' | 'delete' | 'text' | 'copy';
/** Dragging either stretches attached wires (connections kept) or moves the selection on its own. */
export type DragMode = 'stretch' | 'move';
export interface View { x: number; y: number; zoom: number }
/** A document's editing state, kept per tab. History entries are JSON snapshots. */
export interface EditorState { doc: Schematic; view: View; undo: string[]; redo: string[] }

/** Single-key shortcuts that start placing a part (as in LTspice). */
export const PART_KEYS: Record<string, PartKind> = { r: 'R', c: 'C', l: 'L', d: 'D', g: 'GND', p: 'POT', o: 'OA', q: 'NPN', j: 'NJF', x: 'PROBE' };

export interface EditorEvents {
  /** The document changed (committed or live during a drag). */
  change(doc: Schematic, committed: boolean): void;
  /** The selection or mode changed. */
  select(ids: Set<string>): void;
  mode(mode: Mode, placing: PartKind | null): void;
  dragMode(mode: DragMode): void;
  /** Double-click on a part: e.g. focus its value field. */
  edit(id: string): void;
  /** B key: toggle the DC bias overlay. */
  bias?(): void;
}

const HISTORY_MAX = 200;
const SNAP_PX = 9; // anchor snapping radius in screen pixels

export class Editor {
  doc: Schematic;
  sel = new Set<string>();
  mode: Mode = 'select';
  dragMode: DragMode = 'stretch';
  private placing: { kind: PartKind; rot: Rot; mirror: boolean } | null = null;
  private draft: Pt[] | null = null;
  private cursor: Pt = [0, 0];
  private hover: Pt | null = null;
  /** Delete mode: the part id or wire id under the cursor. */
  private delHover: string | null = null;
  private view = { x: -60, y: -150, zoom: 1.4 };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private clip: Clip | null = null;
  /** Copy mode: what's being carried, and the point of it that sits under the cursor. */
  private carry: { clip: Clip; at: Pt } | null = null;
  private drag: null | { kind: 'move'; start: Pt; orig: Schematic; moved: boolean; stretch: boolean }
    | { kind: 'box'; start: Pt; now: Pt; add: boolean; del?: boolean }
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | { kind: 'trace'; start: Pt; x0: number; y0: number } = null;
  private spaceDown = false;
  /** Document state before the current run of previews, if any. */
  private base: Schematic | null = null;
  /** Trace picture under the drawing, and whether pointer input moves/scales it. */
  trace: Trace | null = null;
  traceAdjust = false;
  /** Called when the trace changes (to persist it) and when adjust mode toggles. */
  onTrace?: () => void;
  onTraceAdjust?: (on: boolean) => void;
  private readonly traceLayer: SVGGElement;
  private readonly content: SVGGElement;
  private traceTimer = 0;
  /** Parts/point being pointed out (e.g. from the Checks list), drawn as pulsing outlines for a moment. */
  private flash: { parts: string[]; at?: Pt; cls: string } | null = null;
  private flashTimer = 0;
  private viewAnim = 0;

  constructor(private readonly svg: SVGSVGElement, private readonly wrap: HTMLElement, doc: Schematic, private readonly on: EditorEvents) {
    this.doc = doc;
    // Static layers: grid patterns, the trace picture (under the grid dots) and the drawing.
    svg.innerHTML =
      `<defs><pattern id="bGrid" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.9" class="griddot"/></pattern>` +
      `<pattern id="bGridMajor" width="50" height="50" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1.4" class="griddot major"/></pattern></defs>` +
      '<g class="trace-layer"></g>' +
      '<rect x="-100000" y="-100000" width="200000" height="200000" fill="url(#bGrid)"/>' +
      '<rect x="-100000" y="-100000" width="200000" height="200000" fill="url(#bGridMajor)"/>' +
      '<g class="content"></g>';
    this.traceLayer = svg.querySelector<SVGGElement>('.trace-layer')!;
    this.content = svg.querySelector<SVGGElement>('.content')!;
    this.bind();
    new ResizeObserver(() => this.render()).observe(wrap);
  }

  /* ---------- Public API ---------- */
  /** Replace the document (recorded in history, so loading can be undone). */
  load(doc: Schematic, fit = true): void {
    this.commit(doc);
    this.sel.clear();
    this.on.select(this.sel);
    if (fit) this.fit();
  }

  setMode(mode: Mode, kind: PartKind | null = null): void {
    // Entering copy mode with a selection picks the selection up straight away.
    this.carry = mode === 'copy' && this.sel.size ? { clip: this.copySel(), at: this.selCorner() } : null;
    if (this.carry) this.clip = this.carry.clip;
    this.mode = mode;
    this.draft = null;
    this.placing = mode === 'place' && kind ? { kind, rot: 0, mirror: false } : null;
    this.delHover = null;
    if (mode !== 'select') { this.sel.clear(); this.on.select(this.sel); }
    this.wrap.dataset.mode = mode;
    this.on.mode(mode, this.placing?.kind ?? null);
    this.render();
    this.wrap.focus({ preventScroll: true });
  }

  setDragMode(m: DragMode): void {
    this.dragMode = m;
    this.wrap.dataset.drag = m;
    this.on.dragMode(m);
  }

  selectIds(ids: Iterable<string>): void {
    this.sel = new Set(ids);
    this.on.select(this.sel);
    this.render();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(prev);
    this.afterHistory();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(next);
    this.afterHistory();
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** Everything that belongs to the open document (for tabs): drawing, view and undo history. */
  snapshot(): EditorState {
    return { doc: this.base ?? this.doc, view: this.getView(), undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  /** Switch to another document (a tab) with its own view and history; tools reset to Select. */
  restoreState(s: EditorState): void {
    this.base = null;
    this.drag = null;
    this.undoStack = [...s.undo];
    this.redoStack = [...s.redo];
    this.doc = s.doc;
    this.view = { ...s.view };
    this.sel.clear();
    if (this.traceAdjust) this.setTraceAdjust(false);
    this.setMode('select');
    this.afterHistory();
  }

  rotate(): void {
    if (this.placing) { this.placing.rot = ((this.placing.rot + 90) % 360) as Rot; this.render(); return; }
    if (this.sel.size) this.commit(cutWiresUnder(rotateSelection(this.doc, this.selParts(), this.selWires(), this.dragMode === 'stretch'), this.selParts()));
  }

  mirror(): void {
    if (this.placing) { this.placing.mirror = !this.placing.mirror; this.render(); return; }
    if (this.selParts().size) this.commit(cutWiresUnder(mirrorParts(this.doc, this.selParts(), this.dragMode === 'stretch'), this.selParts()));
  }

  /** Delete the selection, or (with nothing selected) enter delete mode. */
  deleteOrMode(): void {
    if (this.sel.size) this.deleteSel(); else this.setMode('delete');
  }

  deleteSel(): void {
    if (!this.sel.size) return;
    const doc = deleteSelection(this.doc, this.selParts(), this.selWires(), this.selNotes());
    this.sel.clear();
    this.on.select(this.sel);
    this.commit(doc);
  }

  copy(): void { if (this.sel.size) this.clip = this.copySel(); }

  /** Ctrl+C / the Copy button: copy mode (carrying the selection, if there is one). */
  copyMode(): void { this.setMode('copy'); }

  private copySel(): Clip { return copySelection(this.doc, this.selParts(), this.selWires(), this.selNotes()); }

  /** Top-left grid point of the selection, where the cursor holds a copy of it. */
  private selCorner(): Pt {
    const c = this.copySel();
    const xs = [...c.parts.map(p => p.x), ...c.wires.flatMap(w => w.pts.map(p => p[0])), ...(c.notes ?? []).map(n => n.x)];
    const ys = [...c.parts.map(p => p.y), ...c.wires.flatMap(w => w.pts.map(p => p[1])), ...(c.notes ?? []).map(n => n.y)];
    return snapPt([Math.min(...xs), Math.min(...ys)]);
  }

  /** Where the carried copy would land with the cursor at p. */
  private carryOffset(p: Pt): Pt {
    const q = snapPt(p), at = this.carry!.at;
    return [q[0] - at[0], q[1] - at[1]];
  }

  /** Paste at the mouse cursor (top-left of the copied items lands there), or offset if the cursor is away. */
  pasteClip(): void {
    if (!this.clip) return;
    const xs = [...this.clip.parts.map(p => p.x), ...this.clip.wires.flatMap(w => w.pts.map(p => p[0])), ...(this.clip.notes ?? []).map(n => n.x)];
    const ys = [...this.clip.parts.map(p => p.y), ...this.clip.wires.flatMap(w => w.pts.map(p => p[1])), ...(this.clip.notes ?? []).map(n => n.y)];
    if (!xs.length) return;
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    const [cx, cy] = snapPt(this.cursor);
    const W = this.wrap.clientWidth / this.view.zoom, H = this.wrap.clientHeight / this.view.zoom;
    const inView = cx >= this.view.x && cx <= this.view.x + W && cy >= this.view.y && cy <= this.view.y + H;
    const [dx, dy] = inView ? [cx - x0, cy - y0] : [40, 40];
    const r = paste(this.doc, this.clip, dx, dy);
    this.commit(cutWiresUnder(r.doc, r.ids));
    this.selectIds(r.ids);
  }

  duplicate(): void { this.copy(); this.pasteClip(); }

  /** Zoom and pan so the whole drawing is visible. */
  fit(): void {
    this.fitBox(renderSchematicBody(this.doc).bounds);
  }

  /** Zoom and pan so a region (world units) fills the view. */
  fitBox(b: { x0: number; y0: number; x1: number; y1: number }): void {
    const W = this.wrap.clientWidth || 800, H = this.wrap.clientHeight || 500;
    const bw = b.x1 - b.x0 + 80, bh = b.y1 - b.y0 + 80;
    const zoom = Math.max(0.25, Math.min(2.2, W / bw, H / bh));
    this.view = { zoom, x: (b.x0 + b.x1) / 2 - W / zoom / 2, y: (b.y0 + b.y1) / 2 - H / zoom / 2 };
    this.render();
  }

  zoomBy(f: number, at?: Pt): void {
    const W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    const c: Pt = at || [this.view.x + W / this.view.zoom / 2, this.view.y + H / this.view.zoom / 2];
    const z = Math.max(0.25, Math.min(5, this.view.zoom * f));
    this.view.x = c[0] - (c[0] - this.view.x) * this.view.zoom / z;
    this.view.y = c[1] - (c[1] - this.view.y) * this.view.zoom / z;
    this.view.zoom = z;
    this.render();
  }

  /** Show (or remove) the trace picture. `notify` = false for live changes (e.g. while dragging a slider). */
  setTrace(t: Trace | null, notify = true): void {
    this.trace = t;
    if (!t) this.traceAdjust = false;
    this.renderTrace(true);
    if (notify) this.onTrace?.();
  }

  setTraceAdjust(on: boolean): void {
    this.traceAdjust = on && !!this.trace;
    this.wrap.dataset.trace = this.traceAdjust ? 'adjust' : '';
    this.renderTrace(true);
    this.onTraceAdjust?.(this.traceAdjust);
    this.wrap.focus({ preventScroll: true });
  }

  /** Update the picture's placement; rebuild the <image> only when the picture itself changes. */
  private renderTrace(rebuild = false): void {
    const t = this.trace;
    if (!t || !t.visible) { this.traceLayer.innerHTML = ''; return; }
    const img = this.traceLayer.querySelector('image');
    if (rebuild || !img || img.getAttribute('href') !== t.src) {
      const w = t.w * t.scale, h = t.h * t.scale;
      this.traceLayer.innerHTML = `<g class="trace${this.traceAdjust ? ' adjust' : ''}"><image preserveAspectRatio="none" width="${w}" height="${h}"/>` +
        `<rect class="trace-frame" width="${w}" height="${h}"/></g>`;
      this.traceLayer.querySelector('image')!.setAttribute('href', t.src);
    }
    const g = this.traceLayer.firstElementChild as SVGGElement;
    g.setAttribute('transform', traceTransform(t));
    g.setAttribute('opacity', String(t.opacity));
    for (const el of g.children) { el.setAttribute('width', String(t.w * t.scale)); el.setAttribute('height', String(t.h * t.scale)); }
  }

  /**
   * Zoom and pan (animated) to show the given parts and/or point, select the parts and outline them
   * briefly. Returns false if there is nothing to show.
   */
  focusOn(parts: string[], at: Pt | undefined, cls: 'error' | 'warning'): boolean {
    const ps = this.doc.parts.filter(p => parts.includes(p.id));
    const boxes = ps.map(partBox);
    if (at) boxes.push([at[0] - 10, at[1] - 10, at[0] + 10, at[1] + 10]);
    if (!boxes.length) return false;
    const x0 = Math.min(...boxes.map(b => b[0])), y0 = Math.min(...boxes.map(b => b[1]));
    const x1 = Math.max(...boxes.map(b => b[2])), y1 = Math.max(...boxes.map(b => b[3]));
    const W = this.wrap.clientWidth || 800, H = this.wrap.clientHeight || 500, pad = 70;
    const zoom = Math.max(0.4, Math.min(2.5, W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad)));
    const to = { zoom, x: (x0 + x1) / 2 - W / zoom / 2, y: (y0 + y1) / 2 - H / zoom / 2 };
    this.sel = new Set(ps.map(p => p.id));
    this.on.select(this.sel);
    this.flash = { parts: ps.map(p => p.id), at, cls };
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => { this.flash = null; this.render(); }, 2600);
    // Ease the view over ~300 ms (zoom interpolated geometrically, centre linearly).
    cancelAnimationFrame(this.viewAnim);
    const from = { ...this.view }, t0 = performance.now();
    const cx = (v: typeof from) => v.x + W / v.zoom / 2, cy = (v: typeof from) => v.y + H / v.zoom / 2;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 300), e = 1 - (1 - t) ** 3;
      const z = from.zoom * (to.zoom / from.zoom) ** e;
      const mx = cx(from) + (cx(to) - cx(from)) * e, my = cy(from) + (cy(to) - cy(from)) * e;
      this.view = { zoom: z, x: mx - W / z / 2, y: my - H / z / 2 };
      this.render();
      if (t < 1) this.viewAnim = requestAnimationFrame(step);
    };
    this.viewAnim = requestAnimationFrame(step);
    this.wrap.focus({ preventScroll: true });
    return true;
  }

  getView() { return { ...this.view }; }
  setView(v: { x: number; y: number; zoom: number }) { this.view = { ...v }; this.render(); }

  /* ---------- Internals ---------- */
  private selParts(): Set<string> { return new Set(this.doc.parts.filter(p => this.sel.has(p.id)).map(p => p.id)); }
  private selWires(): Set<string> { return new Set(this.doc.wires.filter(w => this.sel.has(w.id)).map(w => w.id)); }
  private selNotes(): Set<string> { return new Set((this.doc.notes ?? []).filter(n => this.sel.has(n.id)).map(n => n.id)); }
  /** Part, wire or note under the pointer. */
  private hitId(t: Element): string | undefined {
    return t.closest<SVGElement>('[data-id]')?.dataset.id ?? t.closest<SVGElement>('[data-note]')?.dataset.note ?? t.closest<SVGElement>('[data-wire]')?.dataset.wire;
  }

  /**
   * Show a document without recording it (live drags, sliders). The next commit() records the
   * change relative to the state before the first preview, so a whole drag is one undo step.
   */
  preview(doc: Schematic): void {
    if (!this.base) this.base = this.doc;
    this.doc = doc;
    this.on.change(this.doc, false);
    this.render();
  }

  /** Record a new document state in history and notify. */
  commit(doc: Schematic): void {
    const prev = this.base ?? this.doc;
    this.base = null;
    if (doc === prev) { this.doc = doc; this.render(); return; }
    this.undoStack.push(JSON.stringify(prev));
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.doc = doc;
    // Drop selection entries that no longer exist.
    const ids = new Set([...doc.parts.map(p => p.id), ...doc.wires.map(w => w.id), ...(doc.notes ?? []).map(n => n.id)]);
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.on.change(this.doc, true);
    this.render();
  }

  private afterHistory(): void {
    const ids = new Set([...this.doc.parts.map(p => p.id), ...this.doc.wires.map(w => w.id), ...(this.doc.notes ?? []).map(n => n.id)]);
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.on.select(this.sel);
    this.on.change(this.doc, true);
    this.render();
  }

  private toWorld(e: { clientX: number; clientY: number }): Pt {
    const r = this.svg.getBoundingClientRect();
    return [this.view.x + (e.clientX - r.left) / this.view.zoom, this.view.y + (e.clientY - r.top) / this.view.zoom];
  }

  /** Cursor position for wiring: stick to nearby pins/wires, else the grid. */
  private wireTarget(p: Pt): Pt {
    const a = nearestAnchor(this.doc, p, SNAP_PX / this.view.zoom);
    return a ? a.at : snapPt(p);
  }

  /** L-shaped route from the last draft point to `to`: the longer axis first. */
  private elbow(from: Pt, to: Pt): Pt[] {
    if (from[0] === to[0] || from[1] === to[1]) return [to];
    return Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? [[to[0], from[1]], to] : [[from[0], to[1]], to];
  }

  private finishWire(): void {
    if (this.draft && this.draft.length >= 2) this.commit(addWire(this.doc, this.draft));
    this.draft = null;
    this.render();
  }

  private bind(): void {
    const svg = this.svg;
    svg.addEventListener('pointerdown', e => this.onDown(e));
    svg.addEventListener('pointermove', e => this.onMove(e));
    svg.addEventListener('pointerup', e => this.onUp(e));
    svg.addEventListener('pointerleave', () => { this.hover = null; this.render(); });
    svg.addEventListener('dblclick', e => {
      if (this.mode === 'wire') { this.finishWire(); return; }
      const g = (e.target as Element).closest<SVGGElement>('[data-id], [data-note]');
      if (g && this.mode === 'select') this.on.edit(g.dataset.id ?? g.dataset.note!);
    });
    svg.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (this.mode === 'wire' && this.draft) this.finishWire();
      else if (this.mode === 'place') this.rotate();
      else if (this.mode === 'copy' && this.carry) { this.carry = null; this.render(); }
      else if (this.mode !== 'select') this.setMode('select');
    });
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015), at = this.toWorld(e);
      if (this.traceAdjust && this.trace) {
        // Scale the trace picture about the cursor.
        const t = this.trace;
        this.trace = { ...t, scale: t.scale * f, x: at[0] - (at[0] - t.x) * f, y: at[1] - (at[1] - t.y) * f };
        this.renderTrace();
        clearTimeout(this.traceTimer);
        this.traceTimer = window.setTimeout(() => this.onTrace?.(), 300);
        return;
      }
      this.zoomBy(f, at);
    }, { passive: false });
    this.wrap.addEventListener('keydown', e => this.onKey(e));
    this.wrap.addEventListener('keyup', e => { if (e.key === ' ') this.spaceDown = false; });
  }

  private onDown(e: PointerEvent): void {
    this.wrap.focus({ preventScroll: true });
    const p = this.toWorld(e);
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      try { this.svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      return;
    }
    if (e.button !== 0) return;

    if (this.traceAdjust && this.trace) {
      this.drag = { kind: 'trace', start: p, x0: this.trace.x, y0: this.trace.y };
      try { this.svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      return;
    }

    if (this.mode === 'text') {
      // Place a note, select it and hand over to Properties to type its text.
      e.preventDefault(); // keep the mouse from pulling focus back to the canvas
      const r = addNote(this.doc, p[0], p[1] + 4);
      this.commit(r.doc);
      this.setMode('select');
      this.selectIds([r.id]);
      this.on.edit(r.id);
      return;
    }

    if (this.mode === 'place' && this.placing) {
      // Probes stick to the nearest pin or wire, so they land on a net.
      const at = this.placing.kind === 'PROBE' ? this.wireTarget(p) : p;
      const part = makePart(this.doc, this.placing.kind, at[0], at[1], this.placing.rot, this.placing.mirror);
      // Only one input and one output jack.
      if ((part.kind === 'IN' || part.kind === 'OUT') && this.doc.parts.some(q => q.kind === part.kind)) {
        const existing = this.doc.parts.find(q => q.kind === part.kind)!;
        this.commit({ ...this.doc, parts: this.doc.parts.map(q => (q === existing ? { ...q, x: part.x, y: part.y, rot: part.rot } : q)) });
      } else this.commit(cutWiresUnder(addPart(this.doc, part), new Set([part.id])));
      return;
    }

    if (this.mode === 'copy') {
      if (this.carry) {
        // Drop a copy; keep carrying so more can be dropped.
        const [dx, dy] = this.carryOffset(p);
        const r = paste(this.doc, this.carry.clip, dx, dy);
        this.commit(cutWiresUnder(r.doc, r.ids));
        return;
      }
      const id = this.hitId(e.target as Element);
      if (id) {
        const one = new Set([id]);
        this.carry = { clip: copySelection(this.doc, one, one, one), at: snapPt(p) };
        this.clip = this.carry.clip;
        this.render();
      }
      return;
    }

    if (this.mode === 'wire') {
      const at = this.wireTarget(p);
      if (!this.draft) { this.draft = [at]; this.render(); return; }
      const last = this.draft[this.draft.length - 1];
      if (at[0] === last[0] && at[1] === last[1]) { this.finishWire(); return; }
      this.draft.push(...this.elbow(last, at));
      if (isConnection(this.doc, at) && this.draft.length > 1) this.finishWire(); else this.render();
      return;
    }

    if (this.mode === 'delete') {
      const t = e.target as Element;
      const partId = t.closest<SVGElement>('[data-id]')?.dataset.id, wireId = t.closest<SVGElement>('[data-wire]')?.dataset.wire;
      const noteId = t.closest<SVGElement>('[data-note]')?.dataset.note;
      if (noteId) this.commit(deleteSelection(this.doc, new Set(), new Set(), new Set([noteId])));
      else if (partId) this.commit(deleteSelection(this.doc, new Set([partId]), new Set()));
      else if (wireId) this.commit(deleteWireSegment(this.doc, wireId, p));
      else { this.drag = { kind: 'box', start: p, now: p, add: false, del: true }; this.svg.setPointerCapture(e.pointerId); }
      this.delHover = null;
      this.render();
      return;
    }

    // Select mode.
    const t = e.target as Element;
    const id = this.hitId(t);
    if (id) {
      if (e.shiftKey) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); }
      else if (!this.sel.has(id)) this.sel = new Set([id]);
      this.on.select(this.sel);
      this.drag = { kind: 'move', start: snapPt(p), orig: this.doc, moved: false, stretch: (this.dragMode === 'stretch') !== e.altKey };
    } else {
      if (!e.shiftKey) { this.sel.clear(); this.on.select(this.sel); }
      this.drag = { kind: 'box', start: p, now: p, add: e.shiftKey };
    }
    try { this.svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this.render();
  }

  private onMove(e: PointerEvent): void {
    const p = this.toWorld(e);
    this.cursor = p;
    const d = this.drag;
    if (d?.kind === 'pan') {
      this.view.x = d.vx - (e.clientX - d.sx) / this.view.zoom;
      this.view.y = d.vy - (e.clientY - d.sy) / this.view.zoom;
      this.render();
      return;
    }
    if (d?.kind === 'trace' && this.trace) {
      this.trace = { ...this.trace, x: d.x0 + p[0] - d.start[0], y: d.y0 + p[1] - d.start[1] };
      this.renderTrace();
      return;
    }
    if (d?.kind === 'move') {
      const q = snapPt(p), dx = q[0] - d.start[0], dy = q[1] - d.start[1];
      d.moved = d.moved || dx !== 0 || dy !== 0;
      if (d.moved) this.preview(moveNotes(moveSelection(d.orig, this.selParts(), this.selWires(), dx, dy, d.stretch), this.selNotes(), dx, dy));
      return;
    }
    if (d?.kind === 'box') { d.now = p; this.render(); return; }
    this.hover = this.mode === 'wire' ? this.wireTarget(p) : null;
    if (this.mode === 'delete') {
      const t = e.target as Element;
      const id = this.hitId(t) ?? null;
      if (id !== this.delHover || id) { this.delHover = id; this.render(); }
      return;
    }
    if (this.mode !== 'select') this.render();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (d?.kind === 'trace') {
      this.onTrace?.();
    } else if (d?.kind === 'move' && d.moved) {
      // A part dropped onto a wire is inserted into it (the wire under it goes).
      this.commit(cutWiresUnder(this.doc, this.selParts()));
    } else if (d?.kind === 'box') {
      const [x0, x1] = [Math.min(d.start[0], d.now[0]), Math.max(d.start[0], d.now[0])];
      const [y0, y1] = [Math.min(d.start[1], d.now[1]), Math.max(d.start[1], d.now[1])];
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        if (d.del) {
          const parts = new Set(this.doc.parts.filter(p => { const [a, b, c, dd] = partBox(p); return inside(a, b) && inside(c, dd); }).map(p => p.id));
          const wires = new Set(this.doc.wires.filter(w => w.pts.every(([x, y]) => inside(x, y))).map(w => w.id));
          const notes = new Set((this.doc.notes ?? []).filter(n => inside(n.x, n.y)).map(n => n.id));
          if (parts.size || wires.size || notes.size) this.commit(deleteSelection(this.doc, parts, wires, notes));
          this.render();
          return;
        }
        if (!d.add) this.sel.clear();
        for (const p of this.doc.parts) { const [a, b, c, dd] = partBox(p); if (inside(a, b) && inside(c, dd)) this.sel.add(p.id); }
        for (const w of this.doc.wires) if (w.pts.every(([x, y]) => inside(x, y))) this.sel.add(w.id);
        for (const n of this.doc.notes ?? []) if (inside(n.x, n.y)) this.sel.add(n.id);
        this.on.select(this.sel);
      }
      this.render();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (ctrl && k === 'c') { e.preventDefault(); this.copyMode(); return; }
    if (ctrl && k === 'v') { e.preventDefault(); this.pasteClip(); return; }
    if (ctrl && k === 'd') { e.preventDefault(); this.duplicate(); return; }
    if (ctrl && k === 'r') { e.preventDefault(); this.rotate(); return; }
    if (ctrl && k === 'e') { e.preventDefault(); this.mirror(); return; }
    if (ctrl && k === 'a') { e.preventDefault(); this.selectIds([...this.doc.parts.map(p => p.id), ...this.doc.wires.map(w => w.id), ...(this.doc.notes ?? []).map(n => n.id)]); return; }
    if (ctrl || e.altKey) return;
    if (PART_KEYS[k] && !e.shiftKey) { this.setMode('place', PART_KEYS[k]); return; }
    switch (e.key) {
      case ' ': this.spaceDown = true; e.preventDefault(); break;
      case 'Escape':
        if (this.traceAdjust) { this.setTraceAdjust(false); break; }
        if (this.draft) { this.draft = null; this.render(); }
        else if (this.carry) { this.carry = null; this.render(); }
        else if (this.mode !== 'select') this.setMode('select');
        else { this.sel.clear(); this.on.select(this.sel); this.render(); }
        break;
      case 'Delete': case 'Backspace': e.preventDefault(); this.deleteOrMode(); break;
      case 'w': case 'W': this.setMode('wire'); break;
      case 'v': case 'V': this.setMode('select'); break;
      case 't': case 'T': this.setMode('text'); break;
      case 's': case 'S': this.setDragMode('stretch'); break;
      case 'm': case 'M': this.setDragMode('move'); break;
      case 'f': case 'F': this.fit(); break;
      case 'b': case 'B': this.on.bias?.(); break;
      case '+': case '=': this.zoomBy(1.2); break;
      case '-': this.zoomBy(1 / 1.2); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!this.sel.size) return;
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -10 : e.key === 'ArrowRight' ? 10 : 0, dy = e.key === 'ArrowUp' ? -10 : e.key === 'ArrowDown' ? 10 : 0;
        this.commit(cutWiresUnder(moveNotes(moveSelection(this.doc, this.selParts(), this.selWires(), dx, dy, this.dragMode === 'stretch'), this.selNotes(), dx, dy), this.selParts()));
        break;
      }
      default: break;
    }
  }

  /* ---------- Rendering ---------- */
  /** Extra SVG drawn above the schematic (e.g. DC node voltages). */
  private annotations = '';
  setAnnotations(svg: string): void {
    if (svg === this.annotations) return;
    this.annotations = svg;
    this.render();
  }

  render(): void {
    const W = this.wrap.clientWidth || 800, H = this.wrap.clientHeight || 500;
    const { x, y, zoom } = this.view;
    this.svg.setAttribute('viewBox', `${x} ${y} ${W / zoom} ${H / zoom}`);
    const delPart = this.mode === 'delete' && this.delHover && (this.doc.parts.some(p => p.id === this.delHover) || (this.doc.notes ?? []).some(n => n.id === this.delHover)) ? this.delHover : null;
    const body = renderSchematicBody(this.doc, { editor: true, selected: this.sel, highlight: delPart ? [delPart] : [] }).body;
    const over: string[] = [];

    // Unconnected pins as small rings, so you can see what still needs wiring.
    if (this.mode === 'wire') {
      for (const part of this.doc.parts) for (const r of pinsOf(part)) over.push(`<circle class="pin-mark" cx="${r.at[0]}" cy="${r.at[1]}" r="3"/>`);
    }
    if (this.placing) {
      const at = this.placing.kind === 'PROBE' ? this.wireTarget(this.cursor) : this.cursor;
      const ghost = makePart(this.doc, this.placing.kind, at[0], at[1], this.placing.rot, this.placing.mirror);
      over.push(`<g class="schem ghost">${renderSchematicBody({ version: 1, parts: [ghost], wires: [] }).body}</g>`);
    }
    if (this.carry) {
      const [dx, dy] = this.carryOffset(this.cursor), c = this.carry.clip;
      const ghost: Schematic = {
        version: 1,
        // Jacks are never duplicated by a paste, so don't show them as coming along.
        parts: c.parts.filter(p => !((p.kind === 'IN' || p.kind === 'OUT') && this.doc.parts.some(q => q.kind === p.kind)))
          .map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
        wires: c.wires.map(w => ({ ...w, pts: w.pts.map(([x, y]) => [x + dx, y + dy] as Pt) })),
        notes: (c.notes ?? []).map(n => ({ ...n, x: n.x + dx, y: n.y + dy })),
      };
      over.push(`<g class="schem ghost">${renderSchematicBody(ghost).body}</g>`);
    }
    if (this.mode === 'wire') {
      const at = this.hover || snapPt(this.cursor);
      if (this.draft) {
        const pts = [...this.draft, ...this.elbow(this.draft[this.draft.length - 1], at)];
        over.push(`<polyline class="draft" points="${pts.map(p => p.join(',')).join(' ')}"/>`);
      }
      over.push(`<circle class="cursor-mark${this.hover && isConnection(this.doc, at) ? ' hot' : ''}" cx="${at[0]}" cy="${at[1]}" r="4.5"/>`);
    }
    if (this.mode === 'delete' && this.delHover && !delPart) {
      const seg = wireSegmentAt(this.doc, this.delHover, this.cursor);
      if (seg) { const [a, b] = seg; over.push(`<line class="del-seg" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`); }
    }
    if (this.flash) {
      const f = this.flash;
      for (const p of this.doc.parts.filter(q => f.parts.includes(q.id))) {
        const [a, b, c, d] = partBox(p);
        over.push(`<rect class="flash ${f.cls}" x="${a - 6}" y="${b - 6}" width="${c - a + 12}" height="${d - b + 12}" rx="6"/>`);
      }
      if (f.at) over.push(`<circle class="flash ${f.cls}" cx="${f.at[0]}" cy="${f.at[1]}" r="9"/>`);
    }
    if (this.drag?.kind === 'box') {
      const { start: s, now: n } = this.drag;
      over.push(`<rect class="rubber${this.drag.del ? ' del' : ''}" x="${Math.min(s[0], n[0])}" y="${Math.min(s[1], n[1])}" width="${Math.abs(n[0] - s[0])}" height="${Math.abs(n[1] - s[1])}"/>`);
    }
    this.content.innerHTML = `<g class="schem">${body}</g><g class="overlay">${this.annotations}${over.join('')}</g>`;
  }
}

