import { describe, expect, it } from 'vitest';
import { hitsRails, opAmpSwings, stuckOpAmps } from '../src/audio/rails';
import { dcOp } from '../src/engine/dc';
import { TEMPLATES } from '../src/builder/templates';
import { extract } from '../src/schematic/extract';
import { sine } from '../src/audio/signals';
import type { Netlist } from '../src/engine/netlist';
import { renderAudio } from '../src/engine/transient';

describe('op-amp rail clipping', () => {
  // ×100 inverting stage on 9 V, biased at 4.5 V.
  const stage = (model: string): Netlist => ({
    input: 'in', output: 'out', elements: [
      { type: 'V', name: 'V9', p: 'v9', n: '0', dc: 9 },
      { type: 'V', name: 'Vref', p: 'vref', n: '0', dc: 4.5 },
      { type: 'C', name: 'C1', a: 'in', b: 'x', value: 1e-6 },
      { type: 'R', name: 'R1', a: 'x', b: 'm', value: 10e3 },
      { type: 'R', name: 'R2', a: 'm', b: 'out', value: 1e6 },
      { type: 'OA', name: 'U2', inP: 'vref', inN: 'm', out: 'out', model },
    ],
  });

  it('knows how far each op-amp can swing', () => {
    expect(opAmpSwings(stage('TL072'))).toEqual([{ name: 'U2', net: 'out', lo: 1.5, hi: 7.5 }]);
    expect(opAmpSwings(stage('ideal'))[0]).toMatchObject({ lo: 0, hi: 9 });
  });

  it('flags an op-amp driven into its rails, not one with headroom', () => {
    const fs = 48000, f = 1000, nl = stage('TL072'), s = opAmpSwings(nl)[0];
    const run = (level: number) => renderAudio(nl, sine(f, level, 11 / f, fs, 1 / f), { fs, oversample: 2 }).out.get('out')!;
    const tail = (y: Float64Array) => y.length - Math.round((10 * fs) / f);
    const quiet = run(0.01), hot = run(0.4);
    expect(hitsRails(quiet, s, tail(quiet))).toBe(false); // ±1 V around 4.5 V
    expect(hitsRails(hot, s, tail(hot))).toBe(true); // ±40 V wanted: squared off
  });

  it('flags an op-amp stuck at a rail by its DC bias (VREF at the full supply), not one biased at half', () => {
    const biased = (vref: number, model: string): Netlist => {
      const nl = stage(model);
      return { ...nl, elements: nl.elements.map(e => (e.name === 'Vref' ? { ...e, dc: vref } as typeof e : e)) };
    };
    for (const model of ['ideal', 'TL072']) {
      expect(stuckOpAmps(biased(4.5, model), dcOp(biased(4.5, model)))).toEqual([]);
      expect(stuckOpAmps(biased(9, model), dcOp(biased(9, model))).map(s => s.name)).toEqual(['U2']);
    }
  });

  it('no template has a stuck op-amp', () => {
    for (const t of TEMPLATES) {
      const nl = extract(t.build()).netlist;
      expect(stuckOpAmps(nl, dcOp(nl)), t.id).toEqual([]);
    }
  });
});
