import { describe, expect, it } from 'vitest';
import { addPart, makePart } from '../src/builder/doc';
import { band, controlsOf, impedances, probesOf, simulate, sweepTargets, sweepVariants, toleranceVariants } from '../src/builder/sim';
import { Cx } from '../src/core/complex';
import { Hfull } from '../src/core/measure';
import type { Term } from '../src/core/termination';
import type { Opts, Values } from '../src/core/types';
import { TAU, db } from '../src/core/units';
import { sch } from '../src/schematic/build';
import { extract } from '../src/schematic/extract';
import { TOPOS, topoById } from '../src/topologies';

const divider = () => sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0])
  .R('R2', 100, 30, 90, 10e3).GND(100, 60).R('R3', 160, 0, 0, 10e3).wire([190, 0], [220, 0])
  .R('R4', 220, 30, 90, 10e3).GND(220, 60).OUT(220, 0).build();
const pickupAmp: Term = { src: { on: true, preset: 'x', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: true, preset: 'y', R: 1e6, C: 470e-12 } };

describe('probes', () => {
  it('measure the voltage on the net they touch', () => {
    // Two-stage divider: the middle node is 0.4 V, the output 0.2 V (loaded by the second stage).
    const doc = addPart(divider(), { id: 'pr', kind: 'PROBE', ref: 'P1', x: 120, y: 0, rot: 0 });
    const ex = extract(doc), probes = probesOf(doc, ex);
    expect(probes).toHaveLength(1);
    const r = simulate(ex, probes, [1000]);
    expect(r.probes[0].mag[0]).toBeCloseTo(db(0.4), 6);
    expect(r.out.mag[0]).toBeCloseTo(db(0.2), 6);
  });
  it('ignore a probe that touches nothing', () => {
    const doc = addPart(divider(), { id: 'pr', kind: 'PROBE', ref: 'P1', x: 500, y: 500, rot: 0 });
    expect(probesOf(doc, extract(doc))).toEqual([]);
  });
});

describe('source and load in the Builder', () => {
  for (const id of ['rc-lp', 'ts-fmv', 'gyrator', 'sk-lp']) {
    it(`${id}: matches the Playground's terminated response`, () => {
      const t = topoById(id)!;
      const v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
      const o = Object.fromEntries((t.options || []).map(x => [x.key, x.def])) as Opts;
      const freqs = [50, 500, 3000, 12000];
      const r = simulate(extract(t.schematic(v, o)), [], freqs, pickupAmp);
      freqs.forEach((f, i) => expect(r.out.mag[i]).toBeCloseTo(db(Hfull(t, v, new Cx(0, TAU * f), o, pickupAmp).abs()), 6));
    });
  }
  it('Zin and Zout of a simple RC low-pass', () => {
    const t = topoById('rc-lp')!, z = impedances(extract(t.schematic({ R: 10e3, C: 10e-9 }, {})), 1000);
    expect(z.zin).toBeCloseTo(Math.hypot(10e3, 1 / (TAU * 1000 * 10e-9)), 0);
  });
});

describe('sweeps', () => {
  it('only parts marked Sweepable are offered', () => {
    const t = topoById('ts-fmv')!, v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
    expect(sweepTargets(t.schematic(v, { treble: 5, mid: 5, bass: 5 }))).toEqual([]);
  });
  it('marked pots sweep rotation and value; marked parts sweep their value', () => {
    const t = topoById('ts-fmv')!, v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
    const base = t.schematic(v, { treble: 5, mid: 5, bass: 5 });
    const doc = { ...base, parts: base.parts.map(p => (['RT', 'RM', 'C2'].includes(p.id) ? { ...p, props: { ...p.props, sweep: true } } : p)) };
    const targets = sweepTargets(doc).map(x => x.id);
    expect(targets).not.toContain('turn:RB');
    expect(targets).toContain('turn:RT');
    expect(targets).toContain('value:C2');
    const vs = sweepVariants(doc, 'turn:RM', 5);
    expect(vs.map(x => x.r)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(vs[4].doc.parts.find(p => p.id === 'RM')!.props!.turn).toBe(1);
    const vv = sweepVariants(doc, 'value:C2', 3).map(x => x.doc.parts.find(p => p.id === 'C2')!.value!);
    expect(vv[0]).toBeCloseTo(100e-9 / 3, 15);
    expect(vv[2]).toBeCloseTo(300e-9, 15);
  });
});

describe('tolerance', () => {
  it('the band brackets the nominal response', () => {
    const t = topoById('sk-lp')!, v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
    const doc = t.schematic(v, { opamp: 'ideal' }), freqs = [100, 1000, 3000, 10000];
    const nominal = simulate(extract(doc), [], freqs).out.mag;
    const runs = toleranceVariants(doc, 5, 10, 24);
    expect(runs[0].parts.find(p => p.id === 'R1')!.value).toBeCloseTo(9.5e3, 6);
    expect(runs[1].parts.find(p => p.id === 'C1')!.value).toBeCloseTo(22e-9 * 1.1, 15);
    const b = band(runs, freqs);
    nominal.forEach((y, i) => { expect(b.lo[i]).toBeLessThanOrEqual(y + 1e-9); expect(b.hi[i]).toBeGreaterThanOrEqual(y - 1e-9); });
    expect(b.hi[3] - b.lo[3]).toBeGreaterThan(0.5); // above f0 the spread is real
  });
});

describe('front panel', () => {
  it('lists pots and switches in ref order', () => {
    let doc = TOPOS.find(t => t.id === 'ts-fmv')!.schematic({ R1: 1, C1: 1, C2: 1, C3: 1, RT: 1, RB: 1, RM: 1 }, { treble: 5, mid: 5, bass: 5 });
    doc = addPart(doc, makePart(doc, 'SW', 500, 500));
    expect(controlsOf(doc).map(p => p.ref)).toEqual(['RB', 'RM', 'RT', 'SW1']);
  });
});
