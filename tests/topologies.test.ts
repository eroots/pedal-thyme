// Locks in the Playground's behaviour. Phase 1 replaces each H(s) with a netlist on the shared MNA
// engine; these closed-form oracles and physics checks must keep passing unchanged.
import { describe, expect, it } from 'vitest';
import { Cx, ONE, cx } from '../src/core/complex';
import { bell, edges, Hfull, levelAt } from '../src/core/measure';
import { termAt, type Term } from '../src/core/termination';
import type { Opts, Values } from '../src/core/types';
import { TAU, db } from '../src/core/units';
import { TOPOS, topoById } from '../src/topologies';
import type { Topology } from '../src/topologies/types';
import { evaluate } from '../src/playground/analysis';
import { searchDesigns } from '../src/playground/design';
import { LEGACY_H } from './legacy';

const defaults = (t: Topology) => ({
  v: Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values,
  o: Object.fromEntries((t.options || []).map(x => [x.key, x.def])) as Opts,
});
const topo = (id: string) => {
  const t = topoById(id);
  if (!t) throw new Error(id);
  return t;
};
const FREQS = [20, 100, 470, 1000, 3300, 10e3, 20e3];
const s = (f: number) => new Cx(0, TAU * f);

describe('exact designs hit their targets', () => {
  for (const t of TOPOS.filter(x => x.design)) {
    it(t.id, () => {
      const { v, o } = defaults(t);
      const tg = Object.fromEntries(t.targets.map(x => [x.key, x.def]));
      const d = t.design!(tg, v[t.anchor!], { topo: t, opts: o, values: v, rSeries: 'E24', cSeries: 'E12', exact: true });
      expect(evaluate(t, d, o, tg).worst).toBeLessThan(1e-3);
    });
  }
});

// Independent closed-form transfer functions (the pre-nodal formulas) used as oracles.
const ORACLES: Record<string, (v: Values, s: Cx, o: Opts) => Cx> = {
  'rc-lp': (v, s) => ONE.div(ONE.add(s.scale(v.R * v.C))),
  'rc-hp': (v, s) => { const x = s.scale(v.R * v.C); return x.div(ONE.add(x)); },
  'shelf-tc': (v, s) => ONE.add(s.scale(v.R2 * v.C)).div(ONE.add(s.scale((v.R1 + v.R2) * v.C))),
  'shelf-bc': (v, s) => { const z1 = cx(v.R1).div(ONE.add(s.scale(v.R1 * v.C))); return cx(v.R2).div(z1.add(v.R2)); },
  'opamp-shelf': (v, s) => ONE.add(s.scale(v.Rf * v.Cg).div(ONE.add(s.scale(v.Rf * v.Cf)).mul(ONE.add(s.scale(v.Rg * v.Cg))))),
  'sk-lp': (v, s) => ONE.div(ONE.add(s.scale(v.C2 * (v.R1 + v.R2))).add(s.mul(s).scale(v.R1 * v.R2 * v.C1 * v.C2))),
  'sk-hp': (v, s) => { const n = s.mul(s).scale(v.R1 * v.R2 * v.C1 * v.C2); return n.div(n.add(s.scale(v.R1 * (v.C1 + v.C2))).add(1)); },
  'mfb-lp': (v, s) => cx(-v.R2 / v.R1).div(ONE.add(s.scale(v.C2 * (v.R2 + v.R3 + v.R2 * v.R3 / v.R1))).add(s.mul(s).scale(v.C1 * v.C2 * v.R2 * v.R3))),
  'mfb-bp': (v, s) => s.scale(-v.C1 * v.R2 / v.R1).div(cx(1 / v.R1 + 1 / v.R3).add(s.scale(v.C1 + v.C2)).add(s.mul(s).scale(v.C1 * v.C2 * v.R2))),
  'scoop-bt': (v, s) => { // equal-cap bridged-T
    const C = v.C1, a = s.mul(s).scale(C * C * v.R1 * v.R2);
    return a.add(s.scale(2 * C * v.R1)).add(1).div(a.add(s.scale(C * (2 * v.R1 + v.R2))).add(1));
  },
};

describe('transfer functions match closed-form oracles', () => {
  for (const [id, H] of Object.entries(ORACLES)) {
    it(id, () => {
      const t = topo(id), { v, o } = defaults(t);
      for (const f of FREQS) {
        const a = t.H(v, s(f), o), b = H(v, s(f), o);
        expect(a.sub(b).abs() / b.abs()).toBeLessThan(1e-6);
      }
    });
  }
});

describe('MNA netlists match the pre-Phase-1 transfer functions', () => {
  const pickup: Term = { src: { on: true, preset: 'x', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: true, preset: 'y', R: 100e3, C: 470e-12 } };
  // Exercise knobs and switches away from their defaults too.
  const variants: Record<string, Opts[]> = {
    'rc2-lp': [{ buf: false }, { buf: true }], 'rc2-hp': [{ buf: false }, { buf: true }], 'bp': [{ buf: false }, { buf: true }],
    'scoop-bm': [{ blend: 0 }, { blend: 35 }, { blend: 100 }],
    'gyrator': [{ pos: 100 }, { pos: -60 }, { pos: 0 }],
    'ts-fmv': [{ treble: 5, mid: 5, bass: 5 }, { treble: 0, mid: 10, bass: 2 }, { treble: 10, mid: 0, bass: 10 }],
    'ts-james': [{ treble: 5, bass: 5 }, { treble: 0, bass: 10 }, { treble: 10, bass: 0 }],
  };
  for (const t of TOPOS) {
    it(t.id, () => {
      const legacy = LEGACY_H[t.id];
      expect(legacy, `legacy oracle for ${t.id}`).toBeDefined();
      const { v, o } = defaults(t);
      for (const opts of variants[t.id] || [{}]) {
        const oo = { ...o, ...opts };
        for (const f of FREQS) {
          for (const z of [null, termAt(pickup, s(f))]) {
            const a = t.H(v, s(f), oo, z), b = legacy(v, s(f), oo, z);
            // The legacy nodal solver drove inputs through 1 mΩ; MNA uses an exact source.
            expect(a.sub(b).abs() / Math.max(b.abs(), 1e-12)).toBeLessThan(1e-6);
          }
        }
      }
    });
  }
});

describe('source and load', () => {
  const T = (src: Partial<Term['src']> | null, load: Partial<Term['load']> | null): Term => ({
    src: { on: !!src, preset: 'custom', R: 0, L: 0, C: 0, ...src },
    load: { on: !!load, preset: 'custom', R: 1e12, C: 0, ...load },
  });

  it('a near-ideal termination changes nothing', () => {
    const term = T({ R: 1e-3 }, { R: 1e12 });
    for (const t of TOPOS) {
      const { v, o } = defaults(t);
      for (const f of [20, 2000, 20e3]) {
        expect(Math.abs(db(t.H(v, s(f), o).abs()) - db(Hfull(t, v, s(f), o, term).abs()))).toBeLessThan(1e-4);
      }
    }
  });

  it('source and load resistance move an RC corner as theory says', () => {
    const t = topo('rc-lp'), v = { R: 10e3, C: 10e-9 };
    expect(edges(t, v, {}).fHi!).toBeCloseTo(1 / (TAU * 10e3 * 10e-9), 0);
    expect(edges(t, v, {}, T({ R: 10e3 }, null)).fHi!).toBeCloseTo(1 / (TAU * 20e3 * 10e-9), 0);
    const loaded = edges(t, v, {}, T(null, { R: 10e3 }));
    expect(loaded.fHi!).toBeCloseTo(1 / (TAU * 5e3 * 10e-9), 0);
    expect(loaded.peakDb).toBeCloseTo(db(0.5), 2);
  });

  it('a single-coil pickup into 1 MΩ resonates near 1/(2π√LC)', () => {
    const e = edges(topo('rc-hp'), { C: 1e-6, R: 1e6 }, {}, T({ R: 6e3, L: 2.5, C: 470e-12 }, { R: 1e6 }));
    expect(e.fPeak).toBeGreaterThan(4500);
    expect(e.fPeak).toBeLessThan(4800);
    expect(e.peakDb).toBeGreaterThan(10);
  });
});

describe('tone stacks', () => {
  it('James is flat (±0.5 dB) at −20 dB with both knobs centred', () => {
    const t = topo('ts-james'), { v } = defaults(t), o = { treble: 5, bass: 5 };
    for (const f of [30, 100, 300, 1000, 3000, 10e3]) expect(Math.abs(levelAt(t, v, o, f) + 20.5)).toBeLessThan(0.6);
  });
  it('FMV is silent with every knob at 0', () => {
    const t = topo('ts-fmv'), { v } = defaults(t);
    for (const f of [100, 1000, 5000]) expect(levelAt(t, v, { treble: 0, mid: 0, bass: 0 }, f)).toBeLessThan(-60);
  });
  it('FMV has a mid scoop with knobs centred', () => {
    const t = topo('ts-fmv'), { v, o } = defaults(t);
    const m = Object.fromEntries(t.analyze(v, o, t).map(x => [x.key, x.value]));
    expect(m.scoop).toBeGreaterThan(300);
    expect(m.scoop).toBeLessThan(2000);
    expect(m.depth).toBeLessThan(-3);
  });
});

describe('measurements', () => {
  it('MFB band-pass: Q from bandwidth and peak gain', () => {
    const t = topo('mfb-bp'), { v, o } = defaults(t);
    const b = bell(t, v, o);
    const m = Object.fromEntries(t.analyze(v, o, t).map(x => [x.key, x.value]));
    expect(b.isDip).toBe(false);
    expect(b.f0!).toBeCloseTo(m.f0!, -1);
  });
  it('gyrator cut mirrors boost', () => {
    const t = topo('gyrator'), { v } = defaults(t);
    expect(bell(t, v, { pos: 100 }).gain).toBeCloseTo(-bell(t, v, { pos: -100 }).gain, 1);
    expect(bell(t, v, { pos: 0 }).f0).toBeNull();
  });
});

describe('real op-amp models', () => {
  it('gyrator boost and Q barely change with a slow op-amp', () => {
    const t = topo('gyrator'), { v } = defaults(t);
    const ideal = bell(t, v, { pos: 100, opamp: 'ideal' }), slow = bell(t, v, { pos: 100, opamp: 'LM358' });
    expect(Math.abs(slow.gain - ideal.gain)).toBeLessThan(0.3);
    expect(Math.abs(slow.Q! / ideal.Q! - 1)).toBeLessThan(0.05);
  });
  it('a TS stage at full drive loses treble to gain-bandwidth', () => {
    const t = topo('opamp-shelf'), v = { Rg: 4.7e3, Cg: 47e-9, Rf: 551e3, Cf: 0 };
    const at = (opamp: string, f: number) => levelAt(t, v, { opamp }, f);
    // At 1 kHz the loop gain is ≈ 3000/96 with a large phase angle (Cg), giving ≈ +0.16 dB by hand.
    expect(Math.abs(at('TL072', 1000) - at('ideal', 1000) - 0.16)).toBeLessThan(0.02);
    // Noise gain ≈ 118 → closed-loop corner ≈ 3 MHz / 118 ≈ 25 kHz with a TL072.
    expect(at('ideal', 25e3) - at('TL072', 25e3)).toBeGreaterThan(2);
    expect(at('ideal', 25e3) - at('TL072', 25e3)).toBeLessThan(4);
  });
});

describe('impedances and SPICE export for every topology', () => {
  it('RC low-pass: Zin = R + 1/sC, Zout = R ∥ 1/sC', () => {
    const t = topo('rc-lp'), v = { R: 10e3, C: 10e-9 }, c = t.circuit(v, {}), f = 1000;
    const zc = new Cx(0, -1 / (TAU * f * 10e-9));
    expect(c.zin(s(f)).sub(zc.add(10e3)).abs() / zc.add(10e3).abs()).toBeLessThan(1e-6);
    const par = zc.mul(10e3).div(zc.add(10e3));
    expect(c.zout(s(f)).sub(par).abs() / par.abs()).toBeLessThan(1e-6);
  });
  for (const t of TOPOS) {
    it(`${t.id} exports a complete SPICE deck`, async () => {
      const { toSpice } = await import('../src/engine/spice');
      const { v, o } = defaults(t);
      const nl = t.netlist(v, o), text = toSpice(nl, { title: t.name });
      expect(text).toContain('V_IN in 0 AC 1');
      expect(text).toMatch(/\.ac dec 100 /);
      for (const e of nl.elements) if ('name' in e) expect(text).toContain(e.name.replace(/[^A-Za-z0-9_]/g, '_'));
    });
  }
});

describe('design search', () => {
  it('finds standard-value RC low-pass designs within 5%', () => {
    const t = topo('rc-lp');
    const res = searchDesigns({ t, targets: { fc: 3000 }, anchor: 10e-9, opts: {}, values: { R: 10e3, C: 10e-9 }, rSeries: 'E24', cSeries: 'E12' });
    expect(res.exact!.worst).toBeLessThan(1e-9);
    expect(res.best.length).toBeGreaterThan(5);
    expect(res.best[0].worst).toBeLessThan(0.05);
  });
  it('reports impossible targets', () => {
    const t = topo('mfb-bp');
    expect(() => searchDesigns({ t, targets: { f0: 800, Q: 1, gain: 12 }, anchor: 10e-9, opts: {}, values: {}, rSeries: 'E24', cSeries: 'E12' }))
      .toThrow(/below 2Q²/);
  });
});
