import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/builder/doc';
import type { ProjectSim } from '../src/builder/files';
import { isBlank, loadSession, newTab, renderStrip, saveSession, tabTitle, upstreamOf } from '../src/builder/tabs';

/** A Map-backed localStorage (tests run in Node). */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(), key: () => null, length: 0,
  } as Storage;
});

const sim: ProjectSim = { term: { src: { on: false, preset: 'single', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: false, preset: 'pedal', R: 1e6, C: 0 } }, sweep: 'POT1', steps: 5 };

describe('builder tabs', () => {
  it('starts with one tab, carrying over the pre-tabs drawing and name', () => {
    const doc = { ...emptyDoc(), wires: [{ id: 'w1', pts: [[0, 0], [400, 0]] as [number, number][] }] };
    store.set('pedal-filter-lab.builder.v1', JSON.stringify({ doc, view: { x: 1, y: 2, zoom: 3 } }));
    store.set('pedal-filter-lab.builder.name', 'Fuzz');
    const s = loadSession(sim);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ name: 'Fuzz', legacy: true, needsFit: false, state: { doc, view: { x: 1, y: 2, zoom: 3 } } });
    expect(s.active).toBe(s.tabs[0].id);
  });

  it('saves and restores the open tabs (and drops the old single-document keys)', () => {
    const a = newTab(sim), b = newTab(sim);
    a.name = 'Tube Screamer'; a.dirty = true; a.compare = b.id;
    b.state.view = { x: 5, y: 6, zoom: 2 };
    store.set('pedal-filter-lab.builder.v1', '{}');
    saveSession({ active: b.id, tabs: [a, b] });
    expect(store.has('pedal-filter-lab.builder.v1')).toBe(false);
    const s = loadSession(sim);
    expect(s.active).toBe(b.id);
    expect(s.tabs.map(t => [t.id, t.name, t.dirty, t.compare])).toEqual([[a.id, 'Tube Screamer', true, b.id], [b.id, '', false, '']]);
    expect(s.tabs[1].state.view).toEqual({ x: 5, y: 6, zoom: 2 });
    // History isn't kept across reloads.
    expect(s.tabs[0].state.undo).toEqual([]);
  });

  it('a new tab keeps the source/load setup but no sweep', () => {
    const t = newTab(sim);
    expect(t.sim.sweep).toBe('');
    expect(t.sim.term).toEqual(sim.term);
    expect(t.sim.term).not.toBe(sim.term);
  });

  it('knows a blank tab (which opening a file can reuse)', () => {
    const t = newTab(sim);
    expect(isBlank({ ...t, file: null })).toBe(true);
    expect(isBlank({ ...t, file: null, name: 'Fuzz' })).toBe(false);
    expect(isBlank({ ...t, file: null, dirty: true })).toBe(false);
    expect(isBlank({ ...t, file: null, state: { ...t.state, doc: { ...emptyDoc(), parts: [...emptyDoc().parts, { id: 'r1', kind: 'R', x: 0, y: 0, rot: 0 }] } } })).toBe(false);
  });

  it('draws the strip with names, unsaved marks and a new-tab button', () => {
    const el = { innerHTML: '' } as HTMLElement;
    renderStrip(el, [{ id: 'a', name: 'Big <Muff>', dirty: true }, { id: 'b', name: '', dirty: false }], 'b');
    expect(el.innerHTML).toContain('Big &lt;Muff&gt;');
    expect(el.innerHTML).toMatch(/class="b-tab dirty"[^>]*data-tab="a"/);
    expect(el.innerHTML).toMatch(/class="b-tab active"[^>]*data-tab="b"/);
    expect(el.innerHTML).toContain('id="bTabNew"');
    expect(tabTitle({ name: '  ' })).toBe('Untitled');
  });

  it('follows a signal chain back to its first pedal, and refuses loops', () => {
    const tabs = [{ id: 'fuzz', input: '' }, { id: 'ts', input: 'fuzz' }, { id: 'rat', input: 'ts' }];
    expect(upstreamOf(tabs, tabs[2])!.map(t => t.id)).toEqual(['fuzz', 'ts']);
    expect(upstreamOf(tabs, tabs[0])).toEqual([]);
    // Feeding the fuzz from the RAT would loop.
    expect(upstreamOf(tabs, { id: 'fuzz', input: 'rat' })).toBeNull();
    expect(upstreamOf(tabs, { id: 'x', input: 'gone' })).toBeNull();
  });
});
