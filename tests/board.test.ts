import { beforeEach, describe, expect, it } from 'vitest';
import { BYPASS, boardTerm, emptyBoard, isBoardText, loadBoardSession, makeBoardFile, parseBoard, saveBoardSession } from '../src/builder/board';
import { emptyDoc } from '../src/builder/doc';
import { makeProject } from '../src/builder/files';
import { joinStages } from '../src/engine/chain';
import type { Netlist } from '../src/engine/netlist';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0,
  } as Storage;
});

describe('pedalboard', () => {
  it('writes and reads a board file (pedal files in order, on/off, with a copy of each)', () => {
    const ts = makeProject('Tube Screamer', emptyDoc()), fuzz = makeProject('Fuzz', emptyDoc());
    const text = JSON.stringify(makeBoardFile({ name: 'Main board', src: 'humbucker', load: 'amp' }, [
      { name: 'Fuzz', file: 'fuzz.pfl.json', on: false, project: fuzz },
      { name: 'Tube Screamer', file: null, on: true, project: ts },
    ]));
    expect(isBoardText(text)).toBe(true);
    expect(isBoardText(JSON.stringify(ts))).toBe(false);
    const b = parseBoard(text);
    expect(b).toMatchObject({ name: 'Main board', src: 'humbucker', load: 'amp' });
    expect(b.pedals.map(p => [p.name, p.file, p.on, p.project.name])).toEqual([['Fuzz', 'fuzz.pfl.json', false, 'Fuzz'], ['Tube Screamer', null, true, 'Tube Screamer']]);
    expect(() => parseBoard(JSON.stringify(ts))).toThrow(/isn’t a pedalboard/);
  });

  it('turns the source and load presets into a termination', () => {
    const src = { single: { R: 6e3, L: 2.5, C: 470e-12 } }, load = { amp: { R: 1e6, C: 470e-12 } };
    expect(boardTerm({ src: 'single', load: 'amp' }, src, load)).toEqual({
      src: { on: true, preset: 'single', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: true, preset: 'amp', R: 1e6, C: 470e-12 },
    });
    expect(boardTerm({ src: 'ideal', load: 'none' }, src, load)).toBeNull();
  });

  it('remembers the board in use', () => {
    expect(loadBoardSession()).toEqual(emptyBoard());
    saveBoardSession({ name: 'B', pedals: [{ tab: 't1', on: true }, { tab: 't2', on: false }], src: 'single', load: 'amp', dirty: true });
    expect(loadBoardSession().pedals).toEqual([{ tab: 't1', on: true }, { tab: 't2', on: false }]);
  });

  it('knows where the signal is after each pedal of a joined chain', () => {
    const series = (r: number): Netlist => ({ input: 'in', output: 'out', elements: [{ type: 'R', name: 'R1', a: 'in', b: 'out', value: r }] });
    const { netlist, outputs } = joinStages([series(1), series(2), series(3)]);
    expect(outputs).toEqual(['u1:in', 'in', 'out']);
    expect(netlist.output).toBe('out');
    expect(BYPASS.input).toBe(BYPASS.output);
  });
});
