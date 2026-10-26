import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import { copySelection, deleteSelection, gangOf, paste, setGang, updatePart } from '../src/builder/doc';
import { simulate, sweepTargets, sweepVariants } from '../src/builder/sim';
import { acModel } from '../src/engine/linearize';
import { exportAsc } from '../src/ltspice/export';
import { importAsc } from '../src/ltspice/import';
import { sch } from '../src/schematic/build';
import { extract } from '../src/schematic/extract';
import type { Schematic } from '../src/schematic/types';

/** IN → VR1 (100 kΩ variable resistor) → R1 10 kΩ → OUT, with VR2 (50 kΩ, reversed) from OUT to ground. */
function twoPots(): Schematic {
  const d = sch().IN(0, 0).wire([0, 0], [10, 0]).wire([70, 0], [100, 0]).R('R1', 130, 0, 0, 10e3).wire([160, 0], [190, 0]).GND(190, 60).OUT(190, 0).build();
  return {
    ...d, parts: [...d.parts,
      { id: 'vr1', kind: 'RHEO', ref: 'VR1', x: 40, y: 0, rot: 0, value: 100e3, props: { taper: 'B', turn: 0.5, sweep: true } },
      { id: 'vr2', kind: 'RHEO', ref: 'VR2', x: 190, y: 30, rot: 90, value: 50e3, props: { taper: 'B', turn: 0.5, sweep: true, reverse: true } },
    ],
  };
}
const turns = (d: Schematic) => d.parts.filter(p => p.props?.turn !== undefined).map(p => [p.ref, p.props!.turn, p.props!.gang]);
const at1k = (d: Schematic) => { const nl = extract(d).netlist; return acModel(nl).circuit.solve(new Cx(0, TAU * 1000), {}).v(nl.output).abs(); };

describe('ganged (dual-gang) pots', () => {
  it('ganging puts two pots on one shaft: turning either turns both', () => {
    let d = updatePart(twoPots(), 'vr2', { props: { turn: 0.2 } });
    d = setGang(d, 'vr2', 'vr1');
    // Joining takes the gang's rotation.
    expect(turns(d)).toEqual([['VR1', 0.5, 'A'], ['VR2', 0.5, 'A']]);
    expect(turns(updatePart(d, 'vr1', { props: { turn: 0.9 } }))).toEqual([['VR1', 0.9, 'A'], ['VR2', 0.9, 'A']]);
    expect(turns(updatePart(d, 'vr2', { props: { turn: 0.1 } }))).toEqual([['VR1', 0.1, 'A'], ['VR2', 0.1, 'A']]);
    // A value change doesn't spread.
    expect(updatePart(d, 'vr1', { value: 20e3 }).parts.find(p => p.id === 'vr2')!.value).toBe(50e3);
  });

  it('leaving, deleting and copying keep gangs sensible', () => {
    const d = setGang(twoPots(), 'vr2', 'vr1');
    expect(gangOf(setGang(d, 'vr2', null), 'vr1').map(p => p.ref)).toEqual(['VR1']); // a gang of one is no gang
    expect(deleteSelection(d, new Set(['vr2']), new Set()).parts.find(p => p.id === 'vr1')!.props!.gang).toBeUndefined();
    // Copying the whole gang makes a new gang; copying one pot gives an ordinary pot.
    const both = paste(d, copySelection(d, new Set(['vr1', 'vr2']), new Set()), 0, 200).doc;
    expect([...new Set(both.parts.map(p => p.props?.gang).filter(Boolean))]).toEqual(['A', 'B']);
    const one = paste(d, copySelection(d, new Set(['vr1']), new Set()), 0, 200).doc;
    expect(one.parts.filter(p => p.props?.gang).length).toBe(2);
  });

  it('the response follows both pots; a sweep turns the whole gang', () => {
    const d = setGang(twoPots(), 'vr2', 'vr1');
    // VR1 (series) grows and VR2 (reversed, to ground) shrinks as the shaft turns: the output falls fast.
    const lo = at1k(updatePart(d, 'vr1', { props: { turn: 0.2 } })), hi = at1k(updatePart(d, 'vr1', { props: { turn: 0.8 } }));
    const onlyVr1 = at1k(updatePart(twoPots(), 'vr1', { props: { turn: 0.8 } }));
    expect(hi).toBeLessThan(lo);
    expect(hi).toBeLessThan(onlyVr1); // the ganged VR2 made a difference
    // One sweep entry for the gang, and its versions turn both pots.
    const targets = sweepTargets(d).filter(t => t.id.startsWith('turn:'));
    expect(targets).toEqual([{ id: 'turn:vr1', label: 'VR1+VR2 rotation' }]);
    const v = sweepVariants(d, 'turn:vr1', 3);
    expect(v.map(x => turns(x.doc).map(t => t[1]))).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
    expect(simulate(extract(v[2].doc), [], [1000]).out.mag[0]).toBeLessThan(simulate(extract(v[0].doc), [], [1000]).out.mag[0]);
  });

  it('survives an LTspice round trip (one shared knob parameter)', () => {
    const d = setGang(twoPots(), 'vr2', 'vr1');
    const asc = exportAsc(d, { title: 'gang' });
    expect(asc).toContain('gang_A_pos=0.5');
    expect(asc.match(/gang_A_pos=/g)!.length).toBe(1);
    const back = importAsc(asc).schematic;
    const pots = back.parts.filter(p => p.kind === 'RHEO' || p.kind === 'POT');
    expect(pots.length).toBe(2);
    expect(new Set(pots.map(p => p.props?.gang)).size).toBe(1);
    expect(pots[0].props?.gang).toBeTruthy();
  });
});

describe('linked (multi-pole) switches', () => {
  /** Two SPDTs and an SPST, unwired: only the gang logic matters here. */
  const switches = (): Schematic => ({
    version: 1, wires: [], parts: [
      { id: 's1', kind: 'SPDT', ref: 'S1', x: 0, y: 0, rot: 0, props: { pos: 'a', sweep: true } },
      { id: 's2', kind: 'SPDT', ref: 'S2', x: 100, y: 0, rot: 0, props: { pos: 'b', sweep: true } },
      { id: 's3', kind: 'SW', ref: 'S3', x: 200, y: 0, rot: 0, props: { closed: false } },
    ],
  });
  const pos = (d: Schematic) => d.parts.map(p => [p.ref, p.props?.pos ?? p.props?.closed, p.props?.gang]);

  it('two SPDTs linked make a DPDT: flipping either flips both', () => {
    const d = setGang(switches(), 's2', 's1');
    expect(pos(d)).toEqual([['S1', 'a', 'A'], ['S2', 'a', 'A'], ['S3', false, undefined]]); // joining takes the gang's position
    expect(pos(updatePart(d, 's2', { props: { pos: 'b' } }))).toEqual([['S1', 'b', 'A'], ['S2', 'b', 'A'], ['S3', false, undefined]]);
  });

  it('only switches of the same kind link', () => {
    expect(setGang(switches(), 's3', 's1')).toEqual(switches());
  });

  it('a linked switch is one sweep target, and its sweep moves every pole', () => {
    const d = setGang(switches(), 's2', 's1');
    const t = sweepTargets(d);
    expect(t.map(x => x.label)).toEqual(['S1+S2 position (A / B)']);
    expect(sweepVariants(d, t[0].id, 5).map(v => pos(v.doc).slice(0, 2))).toEqual([
      [['S1', 'a', 'A'], ['S2', 'a', 'A']], [['S1', 'b', 'A'], ['S2', 'b', 'A']],
    ]);
  });
});
