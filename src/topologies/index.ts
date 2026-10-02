// The Playground's circuit catalogue. Each topology defines its parts, its schematic (the single
// source of truth for the circuit), measurements and design-from-targets solver. The netlist is
// extracted from the schematic and H(s) comes from the shared MNA engine.
import { snap, snapUp } from '../core/eseries';
import { bell, edges } from '../core/measure';
import type { Opts, Values } from '../core/types';
import { TAU, db, undb } from '../core/units';
import { compiledFactory } from '../engine/mna';
import { OPAMP_MODELS } from '../engine/models';
import { sch } from '../schematic/build';
import { extract } from '../schematic/extract';
import { M, P, T, num, toneStackMetrics } from './helpers';
import type { OptionDef, Topology, TopologyDef } from './types';

/** Op-amp model choice offered by every active topology. */
const OPAMP_OPT: OptionDef = {
  key: 'opamp', label: 'Op-amp model', type: 'select', def: 'ideal',
  choices: Object.entries(OPAMP_MODELS).map(([value, m]) => ({ value, label: m.label })),
};
const opamp = (o: Opts) => String(o.opamp ?? 'ideal');

const DEFS: TopologyDef[] = [
  {
    id: 'rc-lp', group: 'Passive · 1st order', name: 'RC low-pass',
    blurb: 'Series resistor into a cap to ground: the basic treble roll-off (−6 dB/oct above fc). Tone caps, post-clipping fizz filters and input RF suppression are all this circuit.',
    parts: [P('R', 'R', 10e3), P('C', 'C', 10e-9)],
    schematic: v => sch().IN(0, 0).wire([0, 0], [10, 0]).R('R', 40, 0, 0, v.R).wire([70, 0], [160, 0])
      .C('C', 100, 30, 90, v.C).GND(100, 60).OUT(160, 0).build(),
    analyze: v => [M('fc', 'Cutoff (−3 dB)', 1 / (TAU * v.R * v.C), 'Hz')],
    targets: [T('fc', 'Cutoff frequency', 'freq', 3000)],
    anchor: 'C',
    design: (t, a) => ({ C: a, R: 1 / (TAU * t.fc * a) }),
  },
  {
    id: 'rc-hp', group: 'Passive · 1st order', name: 'RC high-pass',
    blurb: 'Series cap into a resistor to ground (+6 dB/oct below fc). Every coupling cap plus the next stage’s input resistance forms one; a small coupling cap before a gain stage is the classic way to tighten bass.',
    parts: [P('C', 'C', 47e-9), P('R', 'R', 100e3)],
    schematic: v => sch().IN(0, 0).wire([0, 0], [10, 0]).C('C', 40, 0, 0, v.C).wire([70, 0], [160, 0])
      .R('R', 100, 30, 90, v.R).GND(100, 60).OUT(160, 0).build(),
    analyze: v => [M('fc', 'Cutoff (−3 dB)', 1 / (TAU * v.R * v.C), 'Hz')],
    targets: [T('fc', 'Cutoff frequency', 'freq', 100)],
    anchor: 'C',
    design: (t, a) => ({ C: a, R: 1 / (TAU * t.fc * a) }),
  },
  {
    id: 'rc2-lp', group: 'Passive · cascaded', name: '2-stage RC low-pass',
    blurb: 'Two RC low-passes in series for −12 dB/oct. Unbuffered, stage 2 loads stage 1 and softens the knee; scaling stage 2’s impedance up by the ratio k reduces that interaction. Toggle the buffer to compare.',
    parts: [P('R1', 'R', 10e3), P('C1', 'C', 6.8e-9), P('R2', 'R', 100e3), P('C2', 'C', 680e-12)],
    options: [{ key: 'buf', label: 'Buffer between stages', def: false }],
    schematic: (v, o) => {
      const b = sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, v.R1).C('C1', 100, 30, 90, v.C1).GND(100, 60);
      if (o.buf) b.wire([70, 0], [130, 0]).part('BUF', undefined, 150, 0); else b.wire([70, 0], [170, 0]);
      return b.R('R2', 200, 0, 0, v.R2).wire([230, 0], [320, 0]).C('C2', 260, 30, 90, v.C2).GND(260, 60).OUT(320, 0).build();
    },
    analyze: (v, o, t) => [
      M('fc', 'Cutoff (−3 dB)', edges(t, v, o).fHi, 'Hz'),
      M('f1', 'Stage 1 corner (R1·C1)', 1 / (TAU * v.R1 * v.C1), 'Hz', { noMark: true }),
      M('f2', 'Stage 2 corner (R2·C2)', 1 / (TAU * v.R2 * v.C2), 'Hz', { noMark: true }),
    ],
    targets: [T('fc', 'Overall −3 dB cutoff', 'freq', 2000), T('k', 'Stage-2 impedance ratio k', 'param', 10)],
    anchor: 'R1',
    design: (t, a, ctx) => {
      if (!(t.k > 0)) throw new Error('Impedance ratio k must be > 0.');
      const f1 = t.fc / 0.6436, v: Values = { R1: a, R2: a * t.k };
      v.C1 = 1 / (TAU * v.R1 * f1); v.C2 = 1 / (TAU * v.R2 * f1);
      for (let i = 0; i < 2; i++) { // scaling both caps scales the whole response in frequency
        const e = edges(ctx.topo, v, ctx.opts); if (!e.fHi) break;
        const k = e.fHi / t.fc; v.C1 *= k; v.C2 *= k;
      }
      return v;
    },
  },
  {
    id: 'rc2-hp', group: 'Passive · cascaded', name: '2-stage RC high-pass',
    blurb: 'Two CR high-passes in series for +12 dB/oct below the cutoff: a steeper bass cut than a single coupling cap. Same loading caveat as the 2-stage low-pass.',
    parts: [P('C1', 'C', 100e-9), P('R1', 'R', 10e3), P('C2', 'C', 10e-9), P('R2', 'R', 100e3)],
    options: [{ key: 'buf', label: 'Buffer between stages', def: false }],
    schematic: (v, o) => {
      const b = sch().IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, v.C1).R('R1', 100, 30, 90, v.R1).GND(100, 60);
      if (o.buf) b.wire([70, 0], [130, 0]).part('BUF', undefined, 150, 0); else b.wire([70, 0], [170, 0]);
      return b.C('C2', 200, 0, 0, v.C2).wire([230, 0], [320, 0]).R('R2', 260, 30, 90, v.R2).GND(260, 60).OUT(320, 0).build();
    },
    analyze: (v, o, t) => [
      M('fc', 'Cutoff (−3 dB)', edges(t, v, o).fLo, 'Hz'),
      M('f1', 'Stage 1 corner (R1·C1)', 1 / (TAU * v.R1 * v.C1), 'Hz', { noMark: true }),
      M('f2', 'Stage 2 corner (R2·C2)', 1 / (TAU * v.R2 * v.C2), 'Hz', { noMark: true }),
    ],
    targets: [T('fc', 'Overall −3 dB cutoff', 'freq', 150), T('k', 'Stage-2 impedance ratio k', 'param', 10)],
    anchor: 'R1',
    design: (t, a, ctx) => {
      if (!(t.k > 0)) throw new Error('Impedance ratio k must be > 0.');
      const f1 = t.fc * 1.5538, v: Values = { R1: a, R2: a * t.k };
      v.C1 = 1 / (TAU * v.R1 * f1); v.C2 = 1 / (TAU * v.R2 * f1);
      for (let i = 0; i < 2; i++) {
        const e = edges(ctx.topo, v, ctx.opts); if (!e.fLo) break;
        const k = e.fLo / t.fc; v.C1 *= k; v.C2 *= k;
      }
      return v;
    },
  },
  {
    id: 'bp', group: 'Passive · cascaded', name: 'RC band-pass (HP → LP)',
    blurb: 'A high-pass followed by a low-pass: the simplest way to band-limit a signal, e.g. to voice what hits a clipping stage. Close corners interact and lose level when unbuffered; the design search compensates for loading.',
    parts: [P('C1', 'C', 100e-9), P('R1', 'R', 10e3), P('R2', 'R', 100e3), P('C2', 'C', 470e-12)],
    options: [{ key: 'buf', label: 'Buffer between stages', def: false }],
    schematic: (v, o) => {
      const b = sch().IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, v.C1).R('R1', 100, 30, 90, v.R1).GND(100, 60);
      if (o.buf) b.wire([70, 0], [130, 0]).part('BUF', undefined, 150, 0); else b.wire([70, 0], [170, 0]);
      return b.R('R2', 200, 0, 0, v.R2).wire([230, 0], [320, 0]).C('C2', 260, 30, 90, v.C2).GND(260, 60).OUT(320, 0).build();
    },
    analyze: (v, o, t) => {
      const e = edges(t, v, o);
      return [
        M('fL', 'Lower −3 dB', e.fLo, 'Hz'),
        M('fH', 'Upper −3 dB', e.fHi, 'Hz'),
        M('fPeak', 'Peak frequency', e.fPeak, 'Hz', { noMark: true }),
        M('peak', 'Peak gain', e.peakDb, 'dB'),
      ];
    },
    targets: [T('fL', 'Lower −3 dB', 'freq', 150), T('fH', 'Upper −3 dB', 'freq', 3000), T('k', 'LP impedance ratio k (R2/R1)', 'param', 10)],
    anchor: 'R1',
    design: (t, a, ctx) => {
      if (!(t.fH > t.fL)) throw new Error('Upper −3 dB must be above the lower one.');
      if (!(t.k > 0)) throw new Error('Impedance ratio k must be > 0.');
      const v: Values = { R1: a, R2: a * t.k };
      v.C1 = 1 / (TAU * v.R1 * t.fL); v.C2 = 1 / (TAU * v.R2 * t.fH);
      for (let i = 0; i < 10; i++) {
        const e = edges(ctx.topo, v, ctx.opts); if (!e.fLo || !e.fHi) break;
        v.C1 *= e.fLo / t.fL; v.C2 *= e.fHi / t.fH;
      }
      return v;
    },
  },
  {
    id: 'shelf-tc', group: 'Shelving', name: 'Passive treble-cut shelf',
    blurb: 'Highs are attenuated by a fixed amount instead of rolling off forever: R2 in series with the cap sets the shelf floor. Used for de-emphasis and gentle “darken” switches.',
    parts: [P('R1', 'R', 10e3), P('R2', 'R', 3.3e3), P('C', 'C', 22e-9)],
    schematic: v => sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, v.R1).wire([70, 0], [160, 0])
      .R('R2', 100, 30, 90, v.R2).C('C', 100, 90, 90, v.C).GND(100, 120).OUT(160, 0).build(),
    analyze: v => {
      const fp = 1 / (TAU * (v.R1 + v.R2) * v.C), fz = 1 / (TAU * v.R2 * v.C);
      return [
        M('depth', 'Shelf depth (HF)', db(v.R2 / (v.R1 + v.R2)), 'dB'),
        M('fmid', 'Mid-point (half depth)', Math.sqrt(fp * fz), 'Hz', { noMark: true }),
        M('fp', 'Shelf starts (pole)', fp, 'Hz'),
        M('fz', 'Shelf ends (zero)', fz, 'Hz'),
      ];
    },
    targets: [T('depth', 'Shelf depth', 'db', -12), T('fmid', 'Mid-point frequency', 'freq', 2000)],
    anchor: 'R1',
    design: (t, a) => {
      if (!(t.depth < 0)) throw new Error('Shelf depth must be negative (a cut).');
      const g = undb(t.depth), R2 = g * a / (1 - g), fp = t.fmid * Math.sqrt(g);
      return { R1: a, R2, C: 1 / (TAU * (a + R2) * fp) };
    },
  },
  {
    id: 'shelf-bc', group: 'Shelving', name: 'Passive bass-cut shelf',
    blurb: 'A cap bypasses the series resistor at high frequencies, so lows are reduced by a fixed amount rather than removed. A common “bright” switch or pre-gain bass trim network.',
    parts: [P('R1', 'R', 22e3), P('C', 'C', 10e-9), P('R2', 'R', 10e3)],
    schematic: v => sch().IN(0, 40).wire([0, 40], [20, 40]).R('R1', 50, 40, 0, v.R1, { label: 'b' }).C('C', 50, 0, 0, v.C)
      .wire([20, 0], [20, 40]).wire([80, 0], [80, 40]).wire([80, 40], [180, 40])
      .R('R2', 130, 70, 90, v.R2).GND(130, 100).OUT(180, 40).build(),
    analyze: v => {
      const fz = 1 / (TAU * v.R1 * v.C), fp = 1 / (TAU * (v.R1 * v.R2 / (v.R1 + v.R2)) * v.C);
      return [
        M('depth', 'Shelf depth (LF)', db(v.R2 / (v.R1 + v.R2)), 'dB'),
        M('fmid', 'Mid-point (half depth)', Math.sqrt(fp * fz), 'Hz', { noMark: true }),
        M('fz', 'Shelf ends (zero)', fz, 'Hz'),
        M('fp', 'Full level from (pole)', fp, 'Hz'),
      ];
    },
    targets: [T('depth', 'Shelf depth', 'db', -9), T('fmid', 'Mid-point frequency', 'freq', 800)],
    anchor: 'R2',
    design: (t, a) => {
      if (!(t.depth < 0)) throw new Error('Shelf depth must be negative (a cut).');
      const g = undb(t.depth), R1 = a * (1 - g) / g, fz = t.fmid * Math.sqrt(g);
      return { R1, R2: a, C: 1 / (TAU * R1 * fz) };
    },
  },
  {
    id: 'opamp-shelf', group: 'Shelving', name: 'Op-amp gain shelf (TS-style)',
    blurb: 'Non-inverting gain stage with frequency-dependent gain, as in Tube Screamer-style overdrives: Rg·Cg sets where bass stops being amplified, Rf·Cf rolls off the top. Gain never falls below unity (0 dB).',
    parts: [P('Rg', 'R', 4.7e3), P('Cg', 'C', 47e-9), P('Rf', 'R', 51e3), P('Cf', 'C', 51e-12, { zeroOk: true })],
    presets: [
      { name: 'TS808 — drive at minimum (Rf = 51k)', values: { Rg: 4.7e3, Cg: 47e-9, Rf: 51e3, Cf: 51e-12 } },
      { name: 'TS808 — drive at maximum (Rf = 51k + 500k)', values: { Rg: 4.7e3, Cg: 47e-9, Rf: 551e3, Cf: 51e-12 } },
    ],
    options: [OPAMP_OPT],
    schematic: (v, o) => sch().IN(0, -20).wire([0, -20], [80, -20]).OA('U1', 120, 0, opamp(o), { mirror: true })
      .wire([80, 20], [60, 20], [60, 70], [80, 70]).R('Rf', 110, 70, 0, v.Rf).wire([140, 70], [180, 70], [180, 0])
      .wire([160, 0], [220, 0]).wire([60, 70], [60, 110], [80, 110]).C('Cf', 110, 110, 0, v.Cf, { label: 'b' })
      .wire([140, 110], [180, 110], [180, 70]).R('Rg', 30, 70, 0, v.Rg).C('Cg', 0, 100, 90, v.Cg, { label: 'l' })
      .GND(0, 130).OUT(220, 0).build(),
    analyze: (v, o, t) => [
      M('gain', 'Mid-band gain (1 + Rf/Rg)', db(1 + v.Rf / v.Rg), 'dB'),
      M('peak', 'Actual peak gain', edges(t, v, o).peakDb, 'dB'),
      M('fL', 'Bass corner (Rg·Cg)', 1 / (TAU * v.Rg * v.Cg), 'Hz'),
      M('fH', 'Treble corner (Rf·Cf)', v.Cf > 0 ? 1 / (TAU * v.Rf * v.Cf) : null, 'Hz'),
    ],
    targets: [T('gain', 'Mid-band gain', 'db', 20), T('fL', 'Bass corner', 'freq', 720), T('fH', 'Treble corner', 'freq', 6000)],
    anchor: 'Rg',
    design: (t, a) => {
      if (!(t.gain > 0)) throw new Error('A non-inverting stage needs gain above 0 dB.');
      const G = undb(t.gain), Rf = a * (G - 1);
      return { Rg: a, Rf, Cg: 1 / (TAU * a * t.fL), Cf: 1 / (TAU * Rf * t.fH) };
    },
  },
  {
    id: 'scoop-bm', group: 'Scoop (band-reject)', name: 'LP + HP blend scoop (Big Muff-style)',
    blurb: 'The signal splits into a low-pass (R1·C1) and a high-pass (C2·R2), and the tone pot blends the two. With the LP corner below the HP corner, the mids fall in the gap: a broad scoop. Wider corner spacing gives a deeper scoop, and the pot tilts bass vs treble. The pot loads both halves, so the response is solved exactly.',
    parts: [P('R1', 'R', 22e3), P('C1', 'C', 10e-9), P('C2', 'C', 3.9e-9), P('R2', 'R', 22e3), P('VR', 'R', 100e3, { pot: 'B' })],
    presets: [
      { name: 'Typical Big Muff tone (22k/10n LP, 3.9n/22k HP, 100k)', values: { R1: 22e3, C1: 10e-9, C2: 3.9e-9, R2: 22e3, VR: 100e3 } },
    ],
    options: [{ key: 'blend', label: 'Tone (bass ← → treble)', type: 'range', min: 0, max: 100, step: 1, def: 50, fmt: x => `${x}%` }],
    schematic: (v, o) => sch().IN(0, 0).wire([0, 0], [20, 0]).R('R1', 50, 0, 0, v.R1).wire([80, 0], [160, 0], [160, 20])
      .C('C1', 100, 30, 90, v.C1, { label: 'l' }).GND(100, 60)
      .wire([20, 0], [20, 100]).C('C2', 50, 100, 0, v.C2).wire([80, 100], [160, 100], [160, 80])
      .R('R2', 100, 130, 90, v.R2).GND(100, 160)
      .POT('VR', 160, 50, 90, v.VR, num(o, 'blend') / 100, 'B').wire([190, 50], [240, 50]).OUT(240, 50)
      .note(168, 16, 'bass', 'start').note(168, 92, 'treble', 'start').build(),
    analyze: (v, o, t) => {
      const b = bell(t, v, o), dip = b.isDip && b.f0;
      return [
        M('fc', 'Scoop centre', dip ? b.f0 : null, 'Hz'),
        M('depth', 'Scoop depth (vs. avg of bass & treble)', dip ? b.gain : null, 'dB'),
        M('Q', 'Width Q (half-depth points)', dip ? b.Q : null, ''),
        M('tilt', 'Treble vs bass level', isFinite(b.hi - b.lo) ? b.hi - b.lo : null, 'dB'),
        M('flp', 'LP corner (R1·C1)', 1 / (TAU * v.R1 * v.C1), 'Hz', { noMark: true }),
        M('fhp', 'HP corner (R2·C2)', 1 / (TAU * v.R2 * v.C2), 'Hz', { noMark: true }),
      ];
    },
    targets: [T('fc', 'Scoop centre', 'freq', 1000), T('depth', 'Scoop depth', 'db', -8)],
    anchor: 'R1',
    design: (t, a, ctx) => {
      if (!(t.depth < 0)) throw new Error('Scoop depth must be negative.');
      const VR = ctx.values?.VR || 100e3;
      const build = (r: number): Values => ({ R1: a, R2: a, VR, C1: Math.sqrt(r) / (TAU * a * t.fc), C2: 1 / (TAU * a * t.fc * Math.sqrt(r)) });
      const depthOf = (v: Values) => { const b = bell(ctx.topo, v, ctx.opts); return b.isDip && b.f0 ? b.gain : 0; };
      if (depthOf(build(1e4)) > t.depth)
        throw new Error('That depth is out of reach at this tone setting and pot value. Try a shallower scoop, a tone setting nearer 50%, or a larger pot.');
      let lo = 0, hi = 4; // log10 of the HP/LP corner ratio
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (depthOf(build(10 ** mid)) > t.depth) lo = mid; else hi = mid; }
      const v = build(10 ** ((lo + hi) / 2)), b = bell(ctx.topo, v, ctx.opts);
      if (b.f0) { const k = b.f0 / t.fc; v.C1 *= k; v.C2 *= k; } // caps scale the whole response in frequency
      return v;
    },
  },
  {
    id: 'scoop-bt', group: 'Scoop (band-reject)', name: 'Bridged-T scoop',
    blurb: 'A classic passive mid scoop with no pot loading issues: two caps in series with R1 to ground, bridged by R2. The R2/R1 ratio sets the depth, and the width follows from it (deeper = narrower). Both ends sit at 0 dB, so it removes mids without changing overall level.',
    parts: [P('C1', 'C', 10e-9), P('C2', 'C', 10e-9), P('R1', 'R', 4.7e3), P('R2', 'R', 47e3)],
    schematic: v => sch().IN(0, 50).wire([0, 50], [20, 50]).C('C1', 50, 50, 0, v.C1).C('C2', 110, 50, 0, v.C2)
      .wire([140, 50], [180, 50]).R('R1', 80, 80, 90, v.R1).GND(80, 110)
      .wire([20, 50], [20, 0], [50, 0]).R('R2', 80, 0, 0, v.R2).wire([110, 0], [140, 0], [140, 50]).OUT(180, 50).build(),
    analyze: (v, o, t) => {
      const b = bell(t, v, o), dip = b.isDip && b.f0;
      return [
        M('f0', 'Scoop centre', dip ? b.f0 : null, 'Hz'),
        M('depth', 'Scoop depth', dip ? b.gain : null, 'dB'),
        M('Q', 'Width Q (half-depth points)', dip ? b.Q : null, ''),
      ];
    },
    targets: [T('f0', 'Scoop centre', 'freq', 1000), T('depth', 'Scoop depth', 'db', -12)],
    anchor: 'C1',
    design: (t, a) => {
      if (!(t.depth < 0)) throw new Error('Scoop depth must be negative.');
      const g = undb(t.depth), w = TAU * t.f0;
      const R1 = Math.sqrt(g / (2 * (1 - g))) / (w * a);
      return { C1: a, C2: a, R1, R2: 2 * R1 * (1 - g) / g };
    },
  },
  {
    id: 'gyrator', group: 'Gyrator EQ', name: 'Gyrator boost/cut band',
    blurb: 'Single EQ band as used in graphic-EQ pedals. The gyrator (op-amp follower + C2, R3, R4) simulates an inductor L = R3·R4·C2, which resonates with C1 at f0. The slider moves the pot wiper: toward the − input it boosts, toward the + input it cuts, and centred it is flat. R4 sets Q and the boost range (1 + R2/R4). Targets refer to full boost; cut mirrors it when R1 = R2.',
    parts: [P('R1', 'R', 4.7e3), P('R2', 'R', 4.7e3), P('VR', 'R', 22e3, { pot: 'B' }), P('C1', 'C', 47e-9), P('C2', 'C', 5.6e-9), P('R3', 'R', 100e3), P('R4', 'R', 1.5e3)],
    options: [OPAMP_OPT, { key: 'pos', label: 'Cut ← → Boost', type: 'range', min: -100, max: 100, step: 1, def: 100, fmt: x => (x > 0 ? `+${x}% boost` : x < 0 ? `${-x}% cut` : 'flat') }],
    schematic: (v, o) => sch()
      // Main stage: input to (+), feedback to (−); the pot spans (+) → (−) with the wiper on the branch.
      .IN(0, -20).wire([0, -20], [20, -20]).R('R1', 50, -20, 0, v.R1).wire([80, -20], [160, -20])
      .OA('U1', 200, 0, opamp(o), { mirror: true })
      .wire([90, -20], [90, 10]).POT('VR', 90, 40, 90, v.VR, (num(o, 'pos') + 100) / 200, 'B', { mirror: true })
      .wire([160, 20], [150, 20], [150, 100]).wire([90, 70], [90, 100], [160, 100])
      .R('R2', 190, 100, 0, v.R2).wire([220, 100], [260, 100], [260, 0]).wire([240, 0], [300, 0]).OUT(300, 0)
      .note(100, 14, 'cut', 'start').note(100, 82, 'boost', 'start')
      // Series-resonant branch: C1 + gyrator (simulated inductor L = R3·R4·C2).
      .wire([60, 40], [40, 40], [40, 90]).C('C1', 40, 120, 90, v.C1, { label: 'l' })
      .C('C2', 70, 150, 0, v.C2).wire([100, 150], [140, 150]).R('R3', 100, 180, 90, v.R3, { label: 'l' }).GND(100, 210)
      .OA('U2', 180, 170, opamp(o), { mirror: true })
      .wire([140, 190], [130, 190], [130, 230], [240, 230], [240, 170])
      .wire([220, 170], [260, 170], [260, 260], [170, 260]).R('R4', 140, 260, 0, v.R4, { label: 'b' })
      .wire([110, 260], [40, 260], [40, 150])
      .note(280, 215, 'gyrator: L = R3·R4·C2', 'start').build(),
    analyze: (v, o, t) => {
      const full = bell(t, v, { ...o, pos: 100 }), cut = bell(t, v, { ...o, pos: -100 });
      const now = num(o, 'pos') === 100 ? full : num(o, 'pos') === -100 ? cut : bell(t, v, o);
      return [
        M('f0', 'Centre f0 (full boost)', full.f0, 'Hz'),
        M('boost', 'Max boost', full.f0 ? full.gain : null, 'dB'),
        M('Q', 'Q at full boost (half-gain BW)', full.Q, ''),
        M('cut', 'Max cut', cut.f0 ? cut.gain : null, 'dB'),
        M('now', 'Gain at current setting', now.f0 ? now.gain : 0, 'dB'),
        M('Qnow', 'Q at current setting', now.Q, ''),
        M('L', 'Simulated inductance (R3·R4·C2)', v.R3 * v.R4 * v.C2, 'H'),
      ];
    },
    targets: [T('f0', 'Centre frequency', 'freq', 800), T('Q', 'Q at full boost', 'q', 1.5), T('boost', 'Max boost', 'db', 12)],
    anchor: 'C1',
    design: (t, a, ctx) => {
      if (!(t.boost > 0)) throw new Error('Max boost must be above 0 dB.');
      if (!(t.Q > 0)) throw new Error('Q must be > 0.');
      const G = undb(t.boost), w = TAU * t.f0;
      // Closed form for an ideal inductor (series RLC branch)...
      let R4 = 1 / (w * t.Q * a * Math.sqrt(G)), L = 1 / (w * w * a), R12 = R4 * (G - 1);
      const C2 = ctx.exact ? L / (R4 * 100e3) : snap(L / (R4 * 100e3), ctx.cSeries);
      const build = () => ({ C1: a, R4, R1: R12, R2: R12, C2, R3: L / (R4 * C2), VR: ctx.values?.VR || 22e3 });
      // ...then correct numerically: a real gyrator adds series loss that lowers boost and Q.
      for (let i = 0; i < 12; i++) {
        const b = bell(ctx.topo, build(), { ...ctx.opts, pos: 100 });
        if (!b.f0 || !b.Q || !(b.gain > 0)) break;
        L *= (b.f0 / t.f0) ** 2;
        R4 *= b.Q / t.Q;
        R12 *= (G - 1) / (undb(b.gain) - 1);
      }
      return build();
    },
  },
  {
    id: 'ts-fmv', group: 'Tone stacks', name: 'FMV (Fender / Marshall / Vox)',
    blurb: 'The classic passive treble/mid/bass stack from tube amps, also used in many amp-in-a-box pedals. R1 (the “slope” resistor) and the caps set the voicing; the controls interact, and the mid scoop never fully goes away. Its output impedance is high, so try a load (e.g. 1 MΩ or 100 kΩ) and a realistic source (≈38 kΩ for a tube gain stage).',
    parts: [P('R1', 'R', 100e3), P('C1', 'C', 250e-12), P('C2', 'C', 100e-9), P('C3', 'C', 47e-9),
            P('RT', 'R', 250e3, { pot: 'A' }), P('RB', 'R', 250e3, { pot: 'A' }), P('RM', 'R', 10e3, { pot: 'B' })],
    options: [
      { key: 'treble', label: 'Treble', type: 'range', min: 0, max: 10, step: 0.1, def: 5, fmt: x => (+x).toFixed(1), pot: 'RT' },
      { key: 'mid', label: 'Mid', type: 'range', min: 0, max: 10, step: 0.1, def: 5, fmt: x => (+x).toFixed(1), pot: 'RM' },
      { key: 'bass', label: 'Bass', type: 'range', min: 0, max: 10, step: 0.1, def: 5, fmt: x => (+x).toFixed(1), pot: 'RB' },
    ],
    presets: [
      { name: 'Fender (AB763-style)', values: { R1: 100e3, C1: 250e-12, C2: 100e-9, C3: 47e-9, RT: 250e3, RB: 250e3, RM: 10e3 } },
      { name: 'Marshall (JCM800-style)', values: { R1: 33e3, C1: 470e-12, C2: 22e-9, C3: 22e-9, RT: 220e3, RB: 1e6, RM: 25e3 } },
      { name: 'Fender Bassman 5F6-A-style', values: { R1: 56e3, C1: 250e-12, C2: 20e-9, C3: 20e-9, RT: 250e3, RB: 1e6, RM: 25e3 } },
    ],
    schematic: (v, o) => sch().IN(0, 0).wire([0, 0], [40, 0]).C('C1', 70, 0, 0, v.C1).wire([100, 0], [160, 0])
      .POT('RT', 160, 30, 270, v.RT, num(o, 'treble') / 10, 'A', { mirror: true }).wire([190, 30], [240, 30]).OUT(240, 30)
      .wire([40, 0], [40, 30]).R('R1', 40, 60, 90, v.R1, { label: 'l' })
      .wire([40, 90], [70, 90]).C('C2', 100, 90, 0, v.C2).wire([130, 90], [160, 90], [160, 60])
      .wire([40, 90], [40, 150], [70, 150]).C('C3', 100, 150, 0, v.C3, { label: 'b' }).wire([130, 150], [160, 150])
      .RHEO('RB', 160, 120, 90, v.RB, num(o, 'bass') / 10, 'A').RHEO('RM', 160, 180, 90, v.RM, num(o, 'mid') / 10, 'B')
      .GND(160, 210).build(),
    analyze: (v, o, t) => toneStackMetrics(t, v, o),
    targets: [],
  },
  {
    id: 'ts-james', group: 'Tone stacks', name: 'James (passive Baxandall)',
    blurb: 'Independent bass and treble controls with a genuinely flat setting at mid-rotation, at the cost of ≈20 dB insertion loss (make it up with a gain stage). The 10:1 ratios (R1:R2, C4:C3, C2:C1) keep it flat when centred; R3 isolates the bass wiper from the treble network.',
    parts: [P('C1', 'C', 2.2e-9), P('RT', 'R', 100e3, { pot: 'A' }), P('C2', 'C', 22e-9),
            P('R1', 'R', 10e3), P('RB', 'R', 100e3, { pot: 'A' }), P('C3', 'C', 22e-9), P('C4', 'C', 220e-9), P('R2', 'R', 1e3), P('R3', 'R', 10e3)],
    options: [
      { key: 'treble', label: 'Treble', type: 'range', min: 0, max: 10, step: 0.1, def: 5, fmt: x => (+x).toFixed(1), pot: 'RT' },
      { key: 'bass', label: 'Bass', type: 'range', min: 0, max: 10, step: 0.1, def: 5, fmt: x => (+x).toFixed(1), pot: 'RB' },
    ],
    presets: [
      { name: 'Balanced 10:1 (100k pots)', values: { C1: 2.2e-9, RT: 100e3, C2: 22e-9, R1: 10e3, RB: 100e3, C3: 22e-9, C4: 220e-9, R2: 1e3, R3: 10e3 } },
      { name: 'Darker treble, deeper bass', values: { C1: 1e-9, RT: 100e3, C2: 10e-9, R1: 10e3, RB: 100e3, C3: 47e-9, C4: 470e-9, R2: 1e3, R3: 10e3 } },
    ],
    schematic: (v, o) => sch().IN(0, 0).wire([0, 0], [40, 0]).C('C1', 70, 0, 0, v.C1).wire([100, 0], [180, 0])
      // Treble: C1 → RT (wiper = output) → C2 to ground.
      .POT('RT', 180, 30, 270, v.RT, num(o, 'treble') / 10, 'A', { mirror: true }).C('C2', 180, 90, 90, v.C2, { label: 'l' }).GND(180, 120)
      .wire([210, 30], [280, 30]).OUT(280, 30)
      // Bass: R1 → RB (bypassed by C3/C4) → R2 to ground; R3 isolates the bass wiper from the output.
      .wire([40, 0], [40, 30]).R('R1', 40, 60, 90, v.R1, { label: 'l' }).wire([40, 90], [140, 90]).wire([80, 90], [80, 120])
      .POT('RB', 80, 150, 270, v.RB, num(o, 'bass') / 10, 'A', { mirror: true })
      .C('C3', 140, 120, 90, v.C3, { label: 'l' }).C('C4', 140, 180, 90, v.C4, { label: 'l' })
      .wire([110, 150], [230, 150]).wire([80, 180], [80, 240]).wire([140, 210], [140, 240], [80, 240])
      .R('R2', 80, 270, 90, v.R2, { label: 'l' }).GND(80, 300)
      .R('R3', 230, 120, 90, v.R3).wire([230, 90], [230, 30]).build(),
    analyze: (v, o, t) => toneStackMetrics(t, v, o),
    targets: [],
  },
  {
    id: 'sk-lp', group: 'Active · 2nd order', name: 'Sallen-Key low-pass',
    blurb: 'Unity-gain Sallen-Key low-pass (−12 dB/oct). Q sets resonance at f0: 0.707 is Butterworth (maximally flat), higher values peak. Useful for cab-sim style top-end roll-offs.',
    parts: [P('R1', 'R', 10e3), P('R2', 'R', 10e3), P('C1', 'C', 22e-9), P('C2', 'C', 10e-9)],
    options: [OPAMP_OPT],
    schematic: (v, o) => sch().IN(0, 20).wire([0, 20], [20, 20]).R('R1', 50, 20, 0, v.R1, { label: 'b' }).R('R2', 110, 20, 0, v.R2)
      .C('C1', 80, -10, 90, v.C1, { label: 'l' }).wire([140, 20], [180, 20]).C('C2', 140, 50, 90, v.C2, { label: 'l' }).GND(140, 80)
      .OA('U1', 220, 40, opamp(o), { mirror: true }).wire([80, -40], [280, -40], [280, 40]).wire([260, 40], [320, 40]).OUT(320, 40)
      .wire([180, 60], [170, 60], [170, 100], [280, 100], [280, 40]).build(),
    analyze: (v, o, t) => {
      const r = Math.sqrt(v.R1 * v.R2 * v.C1 * v.C2);
      return [
        M('f0', 'Natural frequency f0', 1 / (TAU * r), 'Hz'),
        M('Q', 'Q', r / (v.C2 * (v.R1 + v.R2)), ''),
        M('fc', '−3 dB point', edges(t, v, o).fHi, 'Hz', { noMark: true }),
      ];
    },
    targets: [T('f0', 'f0', 'freq', 4000), T('Q', 'Q', 'q', 0.707)],
    anchor: 'C2',
    design: (t, a, ctx) => {
      if (!(t.Q > 0)) throw new Error('Q must be > 0.');
      const w = TAU * t.f0, b = 1 / (w * w), p = 1 / (t.Q * w * a);
      const C1 = ctx.exact ? 4 * t.Q * t.Q * a : snapUp(4 * t.Q * t.Q * a * 1.02, ctx.cSeries);
      const r = Math.sqrt(Math.max(0, p * p - 4 * b / (C1 * a)));
      return { C2: a, C1, R1: (p + r) / 2, R2: (p - r) / 2 };
    },
  },
  {
    id: 'sk-hp', group: 'Active · 2nd order', name: 'Sallen-Key high-pass',
    blurb: 'Unity-gain Sallen-Key high-pass (+12 dB/oct below f0). A steep, clean bass cut: good for tightening a high-gain circuit without thinning the mids.',
    parts: [P('C1', 'C', 47e-9), P('C2', 'C', 47e-9), P('R1', 'R', 24e3), P('R2', 'R', 47e3)],
    options: [OPAMP_OPT],
    schematic: (v, o) => sch().IN(0, 20).wire([0, 20], [20, 20]).C('C1', 50, 20, 0, v.C1, { label: 'b' }).C('C2', 110, 20, 0, v.C2)
      .R('R1', 80, -10, 90, v.R1, { label: 'l' }).wire([140, 20], [180, 20]).R('R2', 140, 50, 90, v.R2, { label: 'l' }).GND(140, 80)
      .OA('U1', 220, 40, opamp(o), { mirror: true }).wire([80, -40], [280, -40], [280, 40]).wire([260, 40], [320, 40]).OUT(320, 40)
      .wire([180, 60], [170, 60], [170, 100], [280, 100], [280, 40]).build(),
    analyze: (v, o, t) => {
      const r = Math.sqrt(v.R1 * v.R2 * v.C1 * v.C2);
      return [
        M('f0', 'Natural frequency f0', 1 / (TAU * r), 'Hz'),
        M('Q', 'Q', r / (v.R1 * (v.C1 + v.C2)), ''),
        M('fc', '−3 dB point', edges(t, v, o).fLo, 'Hz', { noMark: true }),
      ];
    },
    targets: [T('f0', 'f0', 'freq', 100), T('Q', 'Q', 'q', 0.707)],
    anchor: 'C1',
    design: (t, a) => {
      if (!(t.Q > 0)) throw new Error('Q must be > 0.');
      const w = TAU * t.f0, R1 = 1 / (2 * t.Q * w * a);
      return { C1: a, C2: a, R1, R2: 1 / (w * w * R1 * a * a) };
    },
  },
  {
    id: 'mfb-lp', group: 'Active · 2nd order', name: 'MFB low-pass',
    blurb: 'Multiple-feedback 2nd-order low-pass with gain set by R2/R1. Inverting (output is phase-flipped) and less sensitive to part tolerances than Sallen-Key.',
    parts: [P('R1', 'R', 10e3), P('R2', 'R', 10e3), P('R3', 'R', 10e3), P('C1', 'C', 22e-9), P('C2', 'C', 2.2e-9)],
    options: [OPAMP_OPT],
    schematic: (v, o) => sch().IN(0, 60).wire([0, 60], [20, 60]).R('R1', 50, 60, 0, v.R1).wire([80, 60], [100, 60]).R('R3', 130, 60, 0, v.R3)
      .wire([160, 60], [200, 60]).OA('U1', 240, 80, opamp(o), { label: 'b' })
      .wire([180, 60], [180, 20], [220, 20]).C('C2', 250, 20, 0, v.C2).wire([280, 20], [320, 20], [320, 80])
      .wire([90, 60], [90, -20], [170, -20]).R('R2', 200, -20, 0, v.R2).wire([230, -20], [320, -20], [320, 20])
      .C('C1', 90, 90, 90, v.C1).GND(90, 120).wire([200, 100], [190, 100], [190, 120]).GND(190, 120)
      .wire([280, 80], [360, 80]).OUT(360, 80).build(),
    analyze: v => {
      const r = Math.sqrt(v.C1 * v.C2 * v.R2 * v.R3);
      return [
        M('f0', 'Natural frequency f0', 1 / (TAU * r), 'Hz'),
        M('Q', 'Q', r / (v.C2 * (v.R2 + v.R3 + v.R2 * v.R3 / v.R1)), ''),
        M('gain', 'Passband gain (R2/R1)', db(v.R2 / v.R1), 'dB'),
      ];
    },
    targets: [T('f0', 'f0', 'freq', 3000), T('Q', 'Q', 'q', 0.707), T('gain', 'Passband gain', 'db', 0)],
    anchor: 'C2',
    design: (t, a, ctx) => {
      if (!(t.Q > 0)) throw new Error('Q must be > 0.');
      const K = undb(t.gain), w = TAU * t.f0, b = 1 / (w * w), p = 1 / (t.Q * w * a);
      const cMin = 4 * t.Q * t.Q * (1 + K) * a;
      const C1 = ctx.exact ? cMin * 1.5 : snapUp(cMin * 1.1, ctx.cSeries);
      const r = Math.sqrt(Math.max(0, p * p - 4 * (1 + K) * b / (C1 * a)));
      const R2 = (p + r) / 2, R3 = b / (C1 * a * R2);
      return { C2: a, C1, R2, R3, R1: R2 / K };
    },
  },
  {
    id: 'mfb-bp', group: 'Active · 2nd order', name: 'MFB band-pass',
    blurb: 'Multiple-feedback band-pass: a resonant peak at f0 with bandwidth f0/Q. Think fixed-wah or mid-hump voicing. Inverting; peak gain must stay below 2Q².',
    parts: [P('R1', 'R', 15e3), P('R2', 'R', 68e3), P('R3', 'R', 2.2e3), P('C1', 'C', 10e-9), P('C2', 'C', 10e-9)],
    options: [OPAMP_OPT],
    schematic: (v, o) => sch().IN(0, 60).wire([0, 60], [20, 60]).R('R1', 50, 60, 0, v.R1).wire([80, 60], [100, 60]).C('C1', 130, 60, 0, v.C1)
      .wire([160, 60], [200, 60]).OA('U1', 240, 80, opamp(o), { label: 'b' })
      .wire([180, 60], [180, 20], [220, 20]).R('R2', 250, 20, 0, v.R2).wire([280, 20], [320, 20], [320, 80])
      .wire([90, 60], [90, -20], [170, -20]).C('C2', 200, -20, 0, v.C2).wire([230, -20], [320, -20], [320, 20])
      .R('R3', 90, 90, 90, v.R3).GND(90, 120).wire([200, 100], [190, 100], [190, 120]).GND(190, 120)
      .wire([280, 80], [360, 80]).OUT(360, 80).build(),
    analyze: v => {
      const w0 = Math.sqrt((1 / v.R1 + 1 / v.R3) / (v.C1 * v.C2 * v.R2)), Q = w0 * v.C1 * v.C2 * v.R2 / (v.C1 + v.C2);
      return [
        M('f0', 'Centre frequency f0', w0 / TAU, 'Hz'),
        M('Q', 'Q', Q, ''),
        M('gain', 'Peak gain', db(v.C1 * v.R2 / (v.R1 * (v.C1 + v.C2))), 'dB'),
        M('bw', 'Bandwidth (f0/Q)', w0 / TAU / Q, 'Hz', { noMark: true }),
      ];
    },
    targets: [T('f0', 'Centre frequency', 'freq', 800), T('Q', 'Q', 'q', 2), T('gain', 'Peak gain', 'db', 6)],
    anchor: 'C1',
    design: (t, a) => {
      const A = undb(t.gain), Q = t.Q, w = TAU * t.f0;
      if (!(Q > 0)) throw new Error('Q must be > 0.');
      if (A >= 2 * Q * Q) throw new Error(`Peak gain must be below 2Q² (${db(2 * Q * Q).toFixed(1)} dB for Q = ${Q}).`);
      return { C1: a, C2: a, R2: 2 * Q / (w * a), R1: Q / (w * a * A), R3: Q / (w * a * (2 * Q * Q - A)) };
    },
  },
];

/**
 * Attach the netlist (extracted from the schematic) and H(s) (that netlist, compiled, cached and
 * solved by the MNA engine).
 */
function withMna(def: TopologyDef): Topology {
  const netlist: Topology['netlist'] = (v, o) => extract(def.schematic(v, o)).netlist;
  const compile = compiledFactory(netlist);
  return { ...def, netlist, circuit: compile, H: (v, s, o, z) => compile(v, o).transfer(s, z?.zs, z?.zl) };
}

export const TOPOS: Topology[] = DEFS.map(withMna);
export const topoById = (id: string): Topology | undefined => TOPOS.find(t => t.id === id);

