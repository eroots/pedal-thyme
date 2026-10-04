// Front panel: a knob for every pot and a toggle for every switch in the Builder document.
// Knobs: drag up/down, scroll, or use the arrow keys when focused. Changes preview live and are
// committed to history when the gesture ends.
import { clamp, fmtEng } from '../core/units';
import type { SchPart, Schematic } from '../schematic/types';
import { updatePart } from './doc';
import type { Editor } from './editor';
import { controlsOf } from './sim';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const SWEEP = 270; // degrees of knob travel
const angle = (turn: number) => -SWEEP / 2 + SWEEP * turn;
const polar = (deg: number, r: number): [number, number] => {
  const a = (deg - 90) * Math.PI / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
};
const arc = (from: number, to: number, r: number) => {
  const [x0, y0] = polar(from, r), [x1, y1] = polar(to, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export interface FrontPanel { sync(doc: Schematic): void }

export function initFrontPanel(root: HTMLElement, editor: Editor): FrontPanel {
  let signature = '';

  const knobInfo = (p: SchPart) => `${((p.props?.turn ?? 0.5) * 10).toFixed(1)} · ${fmtEng(p.value, 'Ω')} ${p.props?.taper ?? 'B'}`;
  const switchInfo = (p: SchPart) => (p.kind === 'SW' ? (p.props?.closed ? 'On' : 'Off') : p.props?.pos === 'b' ? 'B' : p.props?.pos === 'off' ? 'Off' : 'A');

  function build(doc: Schematic): void {
    const controls = controlsOf(doc);
    if (!controls.length) {
      root.innerHTML = '<p class="hint">Pots and switches in your circuit appear here as knobs and toggles.</p>';
      return;
    }
    root.innerHTML = `<div class="knobs">${controls.map(p => (p.kind === 'POT' || p.kind === 'RHEO')
      ? `<div class="knob" data-id="${esc(p.id)}">
          <svg class="dial" viewBox="-22 -22 44 44" tabindex="0" role="slider" aria-label="${esc(p.ref || 'Pot')}" aria-valuemin="0" aria-valuemax="10">
            <path class="dial-track" d="${arc(-SWEEP / 2, SWEEP / 2, 18)}"/>
            <path class="dial-value" d=""/>
            <circle class="dial-body" r="13"/>
            <line class="dial-ptr" x1="0" y1="-4" x2="0" y2="-12"/>
          </svg>
          <div class="kname">${esc(p.ref || '')}</div><div class="kval"></div>
        </div>`
      : `<div class="knob switch" data-id="${esc(p.id)}">
          <button class="toggle" aria-label="${esc(p.ref || 'Switch')}"></button>
          <div class="kname">${esc(p.ref || '')}</div><div class="kval"></div>
        </div>`).join('')}</div>`;
    refresh(doc);
  }

  function refresh(doc: Schematic): void {
    for (const el of root.querySelectorAll<HTMLElement>('.knob')) {
      const p = doc.parts.find(q => q.id === el.dataset.id);
      if (!p) continue;
      if (el.classList.contains('switch')) {
        const on = p.kind === 'SW' ? !!p.props?.closed : p.props?.pos === 'a' || (p.kind === 'SPDT' && p.props?.pos !== 'b');
        const btn = el.querySelector<HTMLButtonElement>('.toggle')!;
        btn.classList.toggle('on', on);
        btn.textContent = switchInfo(p);
        el.querySelector('.kval')!.textContent = p.kind === 'SW' ? 'on-off' : p.kind === 'SPDT' ? 'on-on' : 'on-off-on';
        continue;
      }
      const turn = p.props?.turn ?? 0.5, a = angle(turn);
      el.querySelector('.dial-ptr')!.setAttribute('transform', `rotate(${a.toFixed(1)})`);
      el.querySelector('.dial-value')!.setAttribute('d', turn > 0.001 ? arc(-SWEEP / 2, a, 18) : '');
      const svg = el.querySelector('svg')!;
      svg.setAttribute('aria-valuenow', (turn * 10).toFixed(1));
      el.querySelector('.kval')!.textContent = knobInfo(p);
    }
  }

  /** Rebuild when the set of controls changes; otherwise just update dials and labels. */
  function sync(doc: Schematic): void {
    const sig = controlsOf(doc).map(p => `${p.id}:${p.kind}:${p.ref}`).join('|');
    if (sig !== signature) { signature = sig; build(doc); } else refresh(doc);
  }

  const setTurn = (id: string, turn: number, commit: boolean) => {
    const next = updatePart(editor.doc, id, { props: { turn: clamp(turn, 0, 1) } });
    if (commit) editor.commit(next); else editor.preview(next);
  };
  const turnOf = (id: string) => editor.doc.parts.find(p => p.id === id)?.props?.turn ?? 0.5;

  // Drag a knob vertically: 150 px for the full travel (Shift for fine control).
  let drag: { id: string; y: number; turn: number } | null = null;
  root.addEventListener('pointerdown', e => {
    const dial = (e.target as Element).closest<SVGSVGElement>('.dial');
    if (!dial) return;
    const id = dial.closest<HTMLElement>('.knob')!.dataset.id!;
    drag = { id, y: e.clientY, turn: turnOf(id) };
    try { dial.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    e.preventDefault();
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    setTurn(drag.id, drag.turn + (drag.y - e.clientY) / (e.shiftKey ? 600 : 150), false);
  });
  root.addEventListener('pointerup', () => { if (drag) { drag = null; editor.commit(editor.doc); } });
  root.addEventListener('wheel', e => {
    const dial = (e.target as Element).closest<SVGSVGElement>('.dial');
    if (!dial) return;
    e.preventDefault();
    const id = dial.closest<HTMLElement>('.knob')!.dataset.id!;
    setTurn(id, turnOf(id) + (e.deltaY < 0 ? 0.05 : -0.05), true);
  }, { passive: false });
  root.addEventListener('keydown', e => {
    const dial = (e.target as Element).closest<SVGSVGElement>('.dial');
    if (!dial) return;
    const id = dial.closest<HTMLElement>('.knob')!.dataset.id!, step = e.shiftKey ? 0.01 : 0.05;
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? step : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -step : 0;
    if (e.key === 'Home') setTurn(id, 0, true);
    else if (e.key === 'End') setTurn(id, 1, true);
    else if (d) { e.preventDefault(); setTurn(id, turnOf(id) + d, true); }
  });
  root.addEventListener('click', e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.toggle');
    if (!btn) return;
    const id = btn.closest<HTMLElement>('.knob')!.dataset.id!, p = editor.doc.parts.find(q => q.id === id);
    if (!p) return;
    // Click cycles through the positions (on-off-on: A → off → B → A).
    const next = p.kind === 'ONOFFON' ? ({ a: 'off', off: 'b', b: 'a' } as const)[p.props?.pos ?? 'a'] : p.props?.pos === 'b' ? 'a' : 'b';
    editor.commit(updatePart(editor.doc, id, { props: p.kind === 'SW' ? { closed: !p.props?.closed } : { pos: next } }));
  });

  return { sync };
}
