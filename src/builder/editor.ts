// Schematic canvas: pan/zoom, selection, moving, placing parts, drawing wires, undo/redo.
//
// Modes: 'select' (click/drag parts and wires, box-select on empty space), 'place' (a ghost part
// follows the cursor; click to drop, keep placing until Esc), 'wire' (click to start and bend,
// ending on a pin or wire finishes it; double-click or right-click also finishes).
import { renderSchematicBody } from '../schematic/render';
import { pinsOf } from '../schematic/extract';
import type { Pt } from '../schematic/geometry';
import type { PartKind, Rot, Schematic } from '../schematic/types';
import {
  addPart, addWire, copySelection, deleteSelection, isConnection, makePart, mirrorParts, moveSelection,
  nearestAnchor, partBox, paste, rotateSelection, snapPt, type Clip,
} from './doc';

export type Mode = 'select' | 'wire' | 'place';
/** Dragging either stretches attached wires (connections kept) or moves the selection on its own. */
export type DragMode = 'stretch' | 'move';

/** Single-key shortcuts that start placing a part (as in LTspice). */
export const PART_KEYS: Record<string, PartKind> = { r: 'R', c: 'C', l: 'L', d: 'D', g: 'GND', p: 'POT', o: 'OA' };

export interface EditorEvents {
  /** The document changed (committed or live during a drag). */
  change(doc: Schematic, committed: boolean): void;
  /** The selection or mode changed. */
  select(ids: Set<string>): void;
  mode(mode: Mode, placing: PartKind | null): void;
  dragMode(mode: DragMode): void;
  /** Double-click on a part: e.g. focus its value field. */
  edit(id: string): void;
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
  private view = { x: -60, y: -150, zoom: 1.4 };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private clip: Clip | null = null;
  private drag: null | { kind: 'move'; start: Pt; orig: Schematic; moved: boolean; stretch: boolean }
    | { kind: 'box'; start: Pt; now: Pt; add: boolean }
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number } = null;
  private spaceDown = false;
  /** Document state before the current run of previews, if any. */
  private base: Schematic | null = null;

  constructor(private readonly svg: SVGSVGElement, private readonly wrap: HTMLElement, doc: Schematic, private readonly on: EditorEvents) {
    this.doc = doc;
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
    this.mode = mode;
    this.draft = null;
    this.placing = mode === 'place' && kind ? { kind, rot: 0, mirror: false } : null;
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

  rotate(): void {
    if (this.placing) { this.placing.rot = ((this.placing.rot + 90) % 360) as Rot; this.render(); return; }
    if (this.sel.size) this.commit(rotateSelection(this.doc, this.selParts(), this.selWires(), this.dragMode === 'stretch'));
  }

  mirror(): void {
    if (this.placing) { this.placing.mirror = !this.placing.mirror; this.render(); return; }
    if (this.selParts().size) this.commit(mirrorParts(this.doc, this.selParts(), this.dragMode === 'stretch'));
  }

  deleteSel(): void {
    if (!this.sel.size) return;
    const doc = deleteSelection(this.doc, this.selParts(), this.selWires());
    this.sel.clear();
    this.on.select(this.sel);
    this.commit(doc);
  }

  copy(): void { if (this.sel.size) this.clip = copySelection(this.doc, this.selParts(), this.selWires()); }

  /** Paste at the mouse cursor (top-left of the copied items lands there), or offset if the cursor is away. */
  pasteClip(): void {
    if (!this.clip) return;
    const xs = [...this.clip.parts.map(p => p.x), ...this.clip.wires.flatMap(w => w.pts.map(p => p[0]))];
    const ys = [...this.clip.parts.map(p => p.y), ...this.clip.wires.flatMap(w => w.pts.map(p => p[1]))];
    if (!xs.length) return;
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    const [cx, cy] = snapPt(this.cursor);
    const W = this.wrap.clientWidth / this.view.zoom, H = this.wrap.clientHeight / this.view.zoom;
    const inView = cx >= this.view.x && cx <= this.view.x + W && cy >= this.view.y && cy <= this.view.y + H;
    const [dx, dy] = inView ? [cx - x0, cy - y0] : [40, 40];
    const r = paste(this.doc, this.clip, dx, dy);
    this.commit(r.doc);
    this.selectIds(r.ids);
  }

  duplicate(): void { this.copy(); this.pasteClip(); }

  /** Zoom and pan so the whole drawing is visible. */
  fit(): void {
    const { bounds } = renderSchematicBody(this.doc);
    const W = this.wrap.clientWidth || 800, H = this.wrap.clientHeight || 500;
    const bw = bounds.x1 - bounds.x0 + 80, bh = bounds.y1 - bounds.y0 + 80;
    const zoom = Math.max(0.3, Math.min(2.2, W / bw, H / bh));
    this.view = { zoom, x: (bounds.x0 + bounds.x1) / 2 - W / zoom / 2, y: (bounds.y0 + bounds.y1) / 2 - H / zoom / 2 };
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

  getView() { return { ...this.view }; }
  setView(v: { x: number; y: number; zoom: number }) { this.view = { ...v }; this.render(); }

  /* ---------- Internals ---------- */
  private selParts(): Set<string> { return new Set(this.doc.parts.filter(p => this.sel.has(p.id)).map(p => p.id)); }
  private selWires(): Set<string> { return new Set(this.doc.wires.filter(w => this.sel.has(w.id)).map(w => w.id)); }

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
    const ids = new Set([...doc.parts.map(p => p.id), ...doc.wires.map(w => w.id)]);
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.on.change(this.doc, true);
    this.render();
  }

  private afterHistory(): void {
    const ids = new Set([...this.doc.parts.map(p => p.id), ...this.doc.wires.map(w => w.id)]);
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
      const g = (e.target as Element).closest<SVGGElement>('[data-id]');
      if (g && this.mode === 'select') this.on.edit(g.dataset.id!);
    });
    svg.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (this.mode === 'wire' && this.draft) this.finishWire();
      else if (this.mode === 'place') this.rotate();
      else if (this.mode !== 'select') this.setMode('select');
    });
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), this.toWorld(e));
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
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (this.mode === 'place' && this.placing) {
      const part = makePart(this.doc, this.placing.kind, p[0], p[1], this.placing.rot, this.placing.mirror);
      // Only one input and one output jack.
      if ((part.kind === 'IN' || part.kind === 'OUT') && this.doc.parts.some(q => q.kind === part.kind)) {
        const existing = this.doc.parts.find(q => q.kind === part.kind)!;
        this.commit({ ...this.doc, parts: this.doc.parts.map(q => (q === existing ? { ...q, x: part.x, y: part.y, rot: part.rot } : q)) });
      } else this.commit(addPart(this.doc, part));
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

    // Select mode.
    const t = e.target as Element;
    const id = t.closest<SVGElement>('[data-id]')?.dataset.id ?? t.closest<SVGElement>('[data-wire]')?.dataset.wire;
    if (id) {
      if (e.shiftKey) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); }
      else if (!this.sel.has(id)) this.sel = new Set([id]);
      this.on.select(this.sel);
      this.drag = { kind: 'move', start: snapPt(p), orig: this.doc, moved: false, stretch: (this.dragMode === 'stretch') !== e.altKey };
    } else {
      if (!e.shiftKey) { this.sel.clear(); this.on.select(this.sel); }
      this.drag = { kind: 'box', start: p, now: p, add: e.shiftKey };
    }
    this.svg.setPointerCapture(e.pointerId);
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
    if (d?.kind === 'move') {
      const q = snapPt(p), dx = q[0] - d.start[0], dy = q[1] - d.start[1];
      d.moved = d.moved || dx !== 0 || dy !== 0;
      if (d.moved) this.preview(moveSelection(d.orig, this.selParts(), this.selWires(), dx, dy, d.stretch));
      return;
    }
    if (d?.kind === 'box') { d.now = p; this.render(); return; }
    this.hover = this.mode === 'wire' ? this.wireTarget(p) : null;
    if (this.mode !== 'select') this.render();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (d?.kind === 'move' && d.moved) {
      this.commit(this.doc);
    } else if (d?.kind === 'box') {
      const [x0, x1] = [Math.min(d.start[0], d.now[0]), Math.max(d.start[0], d.now[0])];
      const [y0, y1] = [Math.min(d.start[1], d.now[1]), Math.max(d.start[1], d.now[1])];
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        if (!d.add) this.sel.clear();
        for (const p of this.doc.parts) { const [a, b, c, dd] = partBox(p); if (inside(a, b) && inside(c, dd)) this.sel.add(p.id); }
        for (const w of this.doc.wires) if (w.pts.every(([x, y]) => inside(x, y))) this.sel.add(w.id);
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
    if (ctrl && k === 'c') { e.preventDefault(); this.copy(); return; }
    if (ctrl && k === 'v') { e.preventDefault(); this.pasteClip(); return; }
    if (ctrl && k === 'd') { e.preventDefault(); this.duplicate(); return; }
    if (ctrl && k === 'r') { e.preventDefault(); this.rotate(); return; }
    if (ctrl && k === 'e') { e.preventDefault(); this.mirror(); return; }
    if (ctrl && k === 'a') { e.preventDefault(); this.selectIds([...this.doc.parts.map(p => p.id), ...this.doc.wires.map(w => w.id)]); return; }
    if (ctrl || e.altKey) return;
    if (PART_KEYS[k] && !e.shiftKey) { this.setMode('place', PART_KEYS[k]); return; }
    switch (e.key) {
      case ' ': this.spaceDown = true; e.preventDefault(); break;
      case 'Escape':
        if (this.draft) { this.draft = null; this.render(); }
        else if (this.mode !== 'select') this.setMode('select');
        else { this.sel.clear(); this.on.select(this.sel); this.render(); }
        break;
      case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSel(); break;
      case 'w': case 'W': this.setMode('wire'); break;
      case 'v': case 'V': this.setMode('select'); break;
      case 's': case 'S': this.setDragMode('stretch'); break;
      case 'm': case 'M': this.setDragMode('move'); break;
      case 'f': case 'F': this.fit(); break;
      case '+': case '=': this.zoomBy(1.2); break;
      case '-': this.zoomBy(1 / 1.2); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!this.sel.size) return;
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -10 : e.key === 'ArrowRight' ? 10 : 0, dy = e.key === 'ArrowUp' ? -10 : e.key === 'ArrowDown' ? 10 : 0;
        this.commit(moveSelection(this.doc, this.selParts(), this.selWires(), dx, dy, this.dragMode === 'stretch'));
        break;
      }
      default: break;
    }
  }

  /* ---------- Rendering ---------- */
  render(): void {
    const W = this.wrap.clientWidth || 800, H = this.wrap.clientHeight || 500;
    const { x, y, zoom } = this.view;
    this.svg.setAttribute('viewBox', `${x} ${y} ${W / zoom} ${H / zoom}`);
    const body = renderSchematicBody(this.doc, { editor: true, selected: this.sel }).body;
    const over: string[] = [];

    // Unconnected pins as small rings, so you can see what still needs wiring.
    if (this.mode === 'wire') {
      for (const part of this.doc.parts) for (const r of pinsOf(part)) over.push(`<circle class="pin-mark" cx="${r.at[0]}" cy="${r.at[1]}" r="3"/>`);
    }
    if (this.placing) {
      const ghost = makePart(this.doc, this.placing.kind, this.cursor[0], this.cursor[1], this.placing.rot, this.placing.mirror);
      over.push(`<g class="schem ghost">${renderSchematicBody({ version: 1, parts: [ghost], wires: [] }).body}</g>`);
    }
    if (this.mode === 'wire') {
      const at = this.hover || snapPt(this.cursor);
      if (this.draft) {
        const pts = [...this.draft, ...this.elbow(this.draft[this.draft.length - 1], at)];
        over.push(`<polyline class="draft" points="${pts.map(p => p.join(',')).join(' ')}"/>`);
      }
      over.push(`<circle class="cursor-mark${this.hover && isConnection(this.doc, at) ? ' hot' : ''}" cx="${at[0]}" cy="${at[1]}" r="4.5"/>`);
    }
    if (this.drag?.kind === 'box') {
      const { start: s, now: n } = this.drag;
      over.push(`<rect class="rubber" x="${Math.min(s[0], n[0])}" y="${Math.min(s[1], n[1])}" width="${Math.abs(n[0] - s[0])}" height="${Math.abs(n[1] - s[1])}"/>`);
    }
    const big = 1e5;
    this.svg.innerHTML =
      `<defs><pattern id="bGrid" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.9" class="griddot"/></pattern>` +
      `<pattern id="bGridMajor" width="50" height="50" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1.4" class="griddot major"/></pattern></defs>` +
      `<rect x="${-big}" y="${-big}" width="${2 * big}" height="${2 * big}" fill="url(#bGrid)"/>` +
      `<rect x="${-big}" y="${-big}" width="${2 * big}" height="${2 * big}" fill="url(#bGridMajor)"/>` +
      `<g class="schem">${body}</g><g class="overlay">${over.join('')}</g>`;
  }
}

