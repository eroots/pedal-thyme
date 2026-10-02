// The Playground's circuit catalogue. Each topology defines its parts, transfer function H(s),
// measurements, design-from-targets solver and schematic.
import { cx, ONE, Zc, Yr, Yc } from '../core/complex';
import { ladder, nodal, sallenKey, addZs, type Elem } from '../core/circuit';
import { snap, snapUp } from '../core/eseries';
import { bell, edges } from '../core/measure';
import { taper, potSplit } from '../core/pots';
import { TAU, db, undb } from '../core/units';
import { M, P, T, num, toneStackMetrics } from './helpers';
import type { Topology } from './types';
import type { Values } from '../core/types';

export const TOPOS: Topology[] = [
  {
    id: 'rc-lp', group: 'Passive · 1st order', name: 'RC low-pass',
    blurb: 'Series resistor into a cap to ground: the basic treble roll-off (−6 dB/oct above fc). Tone caps, post-clipping fizz filters and input RF suppression are all this circuit.',
    parts: [P('R', 'R', 10e3), P('C', 'C', 10e-9)],
    H: (v, s, o, z) => ladder([{ ser: cx(v.R), sh: Zc(v.C, s) }], false, z),
    analyze: v => [M('fc', 'Cutoff (−3 dB)', 1 / (TAU * v.R * v.C), 'Hz')],
    targets: [T('fc', 'Cutoff frequency', 'freq', 3000)],
    anchor: 'C',
    design: (t, a) => ({ C: a, R: 1 / (TAU * t.fc * a) }),
    vb: '0 0 310 140',
    sch: d => {
      d.R('R', 22, 50, 150, 50); d.w([150, 50], [270, 50]); d.dot(150, 50);
      d.C('C', 150, 50, 150, 105); d.gnd(150, 105);
      d.term(22, 50, 'IN'); d.term(270, 50, 'OUT', 'r');
    },
  },
  {
    id: 'rc-hp', group: 'Passive · 1st order', name: 'RC high-pass',
    blurb: 'Series cap into a resistor to ground (+6 dB/oct below fc). Every coupling cap plus the next stage’s input resistance forms one; a small coupling cap before a gain stage is the classic way to tighten bass.',
    parts: [P('C', 'C', 47e-9), P('R', 'R', 100e3)],
    H: (v, s, o, z) => ladder([{ ser: Zc(v.C, s), sh: cx(v.R) }], false, z),
    analyze: v => [M('fc', 'Cutoff (−3 dB)', 1 / (TAU * v.R * v.C), 'Hz')],
    targets: [T('fc', 'Cutoff frequency', 'freq', 100)],
    anchor: 'C',
    design: (t, a) => ({ C: a, R: 1 / (TAU * t.fc * a) }),
    vb: '0 0 310 140',
    sch: d => {
      d.C('C', 22, 50, 150, 50); d.w([150, 50], [270, 50]); d.dot(150, 50);
      d.R('R', 150, 50, 150, 105); d.gnd(150, 105);
      d.term(22, 50, 'IN'); d.term(270, 50, 'OUT', 'r');
    },
  },
  {
    id: 'rc2-lp', group: 'Passive · cascaded', name: '2-stage RC low-pass',
    blurb: 'Two RC low-passes in series for −12 dB/oct. Unbuffered, stage 2 loads stage 1 and softens the knee; scaling stage 2’s impedance up by the ratio k reduces that interaction. Toggle the buffer to compare.',
    parts: [P('R1', 'R', 10e3), P('C1', 'C', 6.8e-9), P('R2', 'R', 100e3), P('C2', 'C', 680e-12)],
    options: [{ key: 'buf', label: 'Buffer between stages', def: false }],
    H: (v, s, o, z) => ladder([{ ser: cx(v.R1), sh: Zc(v.C1, s) }, { ser: cx(v.R2), sh: Zc(v.C2, s) }], !!o.buf, z),
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
    vb: '0 0 410 140',
    sch: (d, o) => {
      d.R('R1', 22, 50, 140, 50); d.dot(140, 50); d.C('C1', 140, 50, 140, 105); d.gnd(140, 105);
      let x0 = 140;
      if (num(o, 'buf')) { d.w([140, 50], [168, 50]); d.buf(168, 50); x0 = 190; }
      d.R('R2', x0, 50, 290, 50); d.dot(290, 50); d.C('C2', 290, 50, 290, 105); d.gnd(290, 105);
      d.w([290, 50], [370, 50]);
      d.term(22, 50, 'IN'); d.term(370, 50, 'OUT', 'r');
    },
  },
  {
    id: 'rc2-hp', group: 'Passive · cascaded', name: '2-stage RC high-pass',
    blurb: 'Two CR high-passes in series for +12 dB/oct below the cutoff: a steeper bass cut than a single coupling cap. Same loading caveat as the 2-stage low-pass.',
    parts: [P('C1', 'C', 100e-9), P('R1', 'R', 10e3), P('C2', 'C', 10e-9), P('R2', 'R', 100e3)],
    options: [{ key: 'buf', label: 'Buffer between stages', def: false }],
    H: (v, s, o, z) => ladder([{ ser: Zc(v.C1, s), sh: cx(v.R1) }, { ser: Zc(v.C2, s), sh: cx(v.R2) }], !!o.buf, z),
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
    vb: '0 0 410 140',
    sch: (d, o) => {
      d.C('C1', 22, 50, 140, 50); d.dot(140, 50); d.R('R1', 140, 50, 140, 105); d.gnd(140, 105);
      let x0 = 140;
      if (num(o, 'buf')) { d.w([140, 50], [168, 50]); d.buf(168, 50); x0 = 190; }
      d.C('C2', x0, 50, 290, 50); d.dot(290, 50); d.R('R2', 290, 50, 290, 105); d.gnd(290, 105);
      d.w([290, 50], [370, 50]);
      d.term(22, 50, 'IN'); d.term(370, 50, 'OUT', 'r');
    },
  },
  {
    id: 'bp', group: 'Passive · cascaded', name: 'RC band-pass (HP → LP)',
    blurb: 'A high-pass followed by a low-pass: the simplest way to band-limit a signal, e.g. to voice what hits a clipping stage. Close corners interact and lose level when unbuffered; the design search compensates for loading.',
    parts: [P('C1', 'C', 100e-9), P('R1', 'R', 10e3), P('R2', 'R', 100e3), P('C2', 'C', 470e-12)],
    options: [{ key: 'buf', label: 'Buffer between stages', def: false }],
    H: (v, s, o, z) => ladder([{ ser: Zc(v.C1, s), sh: cx(v.R1) }, { ser: cx(v.R2), sh: Zc(v.C2, s) }], !!o.buf, z),
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
    vb: '0 0 410 140',
    sch: (d, o) => {
      d.C('C1', 22, 50, 140, 50); d.dot(140, 50); d.R('R1', 140, 50, 140, 105); d.gnd(140, 105);
      let x0 = 140;
      if (num(o, 'buf')) { d.w([140, 50], [168, 50]); d.buf(168, 50); x0 = 190; }
      d.R('R2', x0, 50, 290, 50); d.dot(290, 50); d.C('C2', 290, 50, 290, 105); d.gnd(290, 105);
      d.w([290, 50], [370, 50]);
      d.term(22, 50, 'IN'); d.term(370, 50, 'OUT', 'r');
    },
  },
  {
    id: 'shelf-tc', group: 'Shelving', name: 'Passive treble-cut shelf',
    blurb: 'Highs are attenuated by a fixed amount instead of rolling off forever: R2 in series with the cap sets the shelf floor. Used for de-emphasis and gentle “darken” switches.',
    parts: [P('R1', 'R', 10e3), P('R2', 'R', 3.3e3), P('C', 'C', 22e-9)],
    H: (v, s, o, z) => ladder([{ ser: cx(v.R1), sh: Zc(v.C, s).add(v.R2) }], false, z),
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
    vb: '0 0 310 190',
    sch: d => {
      d.R('R1', 22, 50, 150, 50); d.dot(150, 50); d.w([150, 50], [270, 50]);
      d.R('R2', 150, 50, 150, 108); d.C('C', 150, 108, 150, 160); d.gnd(150, 160);
      d.term(22, 50, 'IN'); d.term(270, 50, 'OUT', 'r');
    },
  },
  {
    id: 'shelf-bc', group: 'Shelving', name: 'Passive bass-cut shelf',
    blurb: 'A cap bypasses the series resistor at high frequencies, so lows are reduced by a fixed amount rather than removed. A common “bright” switch or pre-gain bass trim network.',
    parts: [P('R1', 'R', 22e3), P('C', 'C', 10e-9), P('R2', 'R', 10e3)],
    H: (v, s, o, z) => ladder([{ ser: cx(v.R1).div(ONE.add(s.scale(v.R1 * v.C))), sh: cx(v.R2) }], false, z),
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
    vb: '0 0 310 170',
    sch: d => {
      d.w([22, 85], [60, 85]); d.dot(60, 85); d.R('R1', 60, 85, 170, 85);
      d.w([60, 85], [60, 40]); d.C('C', 60, 40, 170, 40); d.w([170, 40], [170, 85]);
      d.dot(170, 85); d.w([170, 85], [270, 85]); d.dot(215, 85);
      d.R('R2', 215, 85, 215, 140); d.gnd(215, 140);
      d.term(22, 85, 'IN'); d.term(270, 85, 'OUT', 'r');
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
    H: (v, s) => {
      const zf = cx(v.Rf).div(ONE.add(s.scale(v.Rf * v.Cf)));
      const yg = s.scale(v.Cg).div(ONE.add(s.scale(v.Rg * v.Cg)));
      return ONE.add(zf.mul(yg));
    },
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
    vb: '0 0 400 262',
    sch: d => {
      d.w([22, 104], [170, 104]); d.amp(170, 120, true);
      d.w([170, 136], [145, 136], [145, 175]); d.dot(145, 175);
      d.R('Rf', 145, 175, 265, 175); d.w([145, 175], [145, 212]); d.C('Cf', 145, 212, 265, 212, 'b');
      d.w([265, 212], [265, 120]); d.dot(265, 175); d.dot(265, 120); d.w([234, 120], [360, 120]);
      d.R('Rg', 145, 175, 65, 175); d.C('Cg', 65, 175, 65, 222, 'l'); d.gnd(65, 222);
      d.term(22, 104, 'IN'); d.term(360, 120, 'OUT', 'r');
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
    H: (v, s, o, z) => {
      // Nodes: 1 input, 2 LP output (A), 3 HP output (B), 4 wiper.
      const [ra, rb] = potSplit(v.VR, num(o, 'blend') / 100);
      const els: Elem[] = [[1, 2, Yr(v.R1)], [2, 0, Yc(v.C1, s)], [1, 3, Yc(v.C2, s)], [3, 0, Yr(v.R2)], [2, 4, Yr(ra)], [4, 3, Yr(rb)]];
      if (z && z.zl) els.push([4, 0, ONE.div(z.zl)]);
      return nodal(4, els, 1, z && z.zs)[4];
    },
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
    vb: '0 0 400 225',
    sch: (d, o) => {
      d.w([22, 60], [60, 60]); d.dot(60, 60);
      d.R('R1', 60, 60, 170, 60); d.dot(170, 60); d.C('C1', 170, 60, 170, 115, 'r'); d.gnd(170, 115);
      d.w([60, 60], [60, 150]); d.C('C2', 60, 150, 170, 150); d.dot(170, 150); d.R('R2', 170, 150, 170, 200, 'r'); d.gnd(170, 200);
      d.w([170, 60], [270, 60]); d.w([170, 150], [270, 150]);
      d.R('VR', 270, 60, 270, 150, 'l');
      const y = 89 + 32 * num(o, 'blend') / 100;
      d.arrow(320, y, 279, y); d.w([320, y], [360, y]);
      d.note(282, 80, 'bass', 'start'); d.note(282, 140, 'treble', 'start');
      d.term(22, 60, 'IN'); d.term(360, y, 'OUT', 'r');
    },
  },
  {
    id: 'scoop-bt', group: 'Scoop (band-reject)', name: 'Bridged-T scoop',
    blurb: 'A classic passive mid scoop with no pot loading issues: two caps in series with R1 to ground, bridged by R2. The R2/R1 ratio sets the depth, and the width follows from it (deeper = narrower). Both ends sit at 0 dB, so it removes mids without changing overall level.',
    parts: [P('C1', 'C', 10e-9), P('C2', 'C', 10e-9), P('R1', 'R', 4.7e3), P('R2', 'R', 47e3)],
    H: (v, s, o, z) => {
      // Nodes: 1 input, 2 cap junction, 3 output.
      const els: Elem[] = [[1, 2, Yc(v.C1, s)], [2, 3, Yc(v.C2, s)], [2, 0, Yr(v.R1)], [1, 3, Yr(v.R2)]];
      if (z && z.zl) els.push([3, 0, ONE.div(z.zl)]);
      return nodal(3, els, 1, z && z.zs)[3];
    },
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
    vb: '0 0 330 175',
    sch: d => {
      d.w([22, 90], [60, 90]); d.dot(60, 90);
      d.C('C1', 60, 90, 150, 90); d.dot(150, 90); d.C('C2', 150, 90, 240, 90); d.dot(240, 90); d.w([240, 90], [290, 90]);
      d.R('R1', 150, 90, 150, 145, 'r'); d.gnd(150, 145);
      d.w([60, 90], [60, 40]); d.R('R2', 60, 40, 240, 40); d.w([240, 40], [240, 90]);
      d.term(22, 90, 'IN'); d.term(290, 90, 'OUT', 'r');
    },
  },
  {
    id: 'gyrator', group: 'Gyrator EQ', name: 'Gyrator boost/cut band',
    blurb: 'Single EQ band as used in graphic-EQ pedals. The gyrator (op-amp follower + C2, R3, R4) simulates an inductor L = R3·R4·C2, which resonates with C1 at f0. The slider moves the pot wiper: toward the − input it boosts, toward the + input it cuts, and centred it is flat. R4 sets Q and the boost range (1 + R2/R4). Targets refer to full boost; cut mirrors it when R1 = R2.',
    parts: [P('R1', 'R', 4.7e3), P('R2', 'R', 4.7e3), P('VR', 'R', 22e3, { pot: 'B' }), P('C1', 'C', 47e-9), P('C2', 'C', 5.6e-9), P('R3', 'R', 100e3), P('R4', 'R', 1.5e3)],
    options: [{ key: 'pos', label: 'Cut ← → Boost', type: 'range', min: -100, max: 100, step: 1, def: 100, fmt: x => (x > 0 ? `+${x}% boost` : x < 0 ? `${-x}% cut` : 'flat') }],
    H: (v, s, o, z) => {
      const [RA, RB] = potSplit(v.VR, (num(o, 'pos') + 100) / 200), Z1 = addZs(z, cx(v.R1));
      const zg = cx(v.R4).mul(ONE.add(s.scale(v.R3 * v.C2))).div(ONE.add(s.scale(v.R4 * v.C2)));
      const yb = ONE.div(Zc(v.C1, s).add(zg)), den = yb.add(1 / RA + 1 / RB);
      const vin = ONE.add(yb.mul(Z1).scale(1 / RA).div(den)), vout = ONE.add(yb.scale(v.R2 / RB).div(den));
      return vout.div(vin);
    },
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
    vb: '0 0 440 385',
    sch: (d, o) => {
      // Main stage
      d.R('R1', 22, 94, 150, 94); d.dot(150, 94); d.w([150, 94], [240, 94]);
      d.amp(240, 110, true);
      d.w([240, 126], [215, 126], [215, 200], [150, 200]); d.dot(215, 160);
      d.R('VR', 150, 94, 150, 200, 'r');
      d.R('R2', 215, 160, 340, 160, 'b'); d.w([340, 160], [340, 110]); d.dot(340, 110); d.w([304, 110], [400, 110]);
      const y = 131 + 32 * (num(o, 'pos') + 100) / 200;
      d.arrow(100, y, 141, y); d.w([100, y], [80, y], [80, 175]);
      d.note(160, 120, 'cut', 'start'); d.note(160, 188, 'boost', 'start');
      // Series-resonant branch: C1 + gyrator
      d.C('C1', 80, 175, 80, 240, 'l'); d.dot(80, 240);
      d.C('C2', 80, 240, 170, 240); d.dot(170, 240); d.w([170, 240], [200, 240]);
      d.R('R3', 170, 240, 170, 298, 'l'); d.gnd(170, 298);
      d.amp(200, 256, true);
      d.w([200, 272], [190, 272], [190, 300], [290, 300], [290, 256]); d.w([264, 256], [320, 256], [320, 330]); d.dot(290, 256);
      d.R('R4', 320, 330, 80, 330, 'b'); d.w([80, 330], [80, 240]);
      d.note(270, 228, 'gyrator  L = R3·R4·C2', 'start');
      d.term(22, 94, 'IN'); d.term(400, 110, 'OUT', 'r');
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
    H: (v, s, o, z) => {
      // Nodes: 1 input, 2 treble pot top, 3 output (treble wiper), 4 slope junction, 5 treble bottom / bass top, 6 bass bottom / mid top.
      const [tTop, tBot] = potSplit(v.RT, 1 - taper(num(o, 'treble') / 10, 'A'));
      const rb = Math.max(1, v.RB * taper(num(o, 'bass') / 10, 'A')), rm = Math.max(1, v.RM * taper(num(o, 'mid') / 10, 'B'));
      const els: Elem[] = [[1, 2, Yc(v.C1, s)], [2, 3, Yr(tTop)], [3, 5, Yr(tBot)], [1, 4, Yr(v.R1)],
                   [4, 5, Yc(v.C2, s)], [4, 6, Yc(v.C3, s)], [5, 6, Yr(rb)], [6, 0, Yr(rm)]];
      if (z && z.zl) els.push([3, 0, ONE.div(z.zl)]);
      return nodal(6, els, 1, z && z.zs)[3];
    },
    analyze: (v, o, t) => toneStackMetrics(t, v, o),
    targets: [],
    vb: '0 0 340 300',
    sch: (d, o) => {
      d.w([22, 60], [60, 60]); d.dot(60, 60);
      d.C('C1', 60, 60, 180, 60);
      d.R('RT', 180, 60, 180, 150, 'l');
      const y = 121 - 32 * taper(num(o, 'treble') / 10, 'A');
      d.arrow(230, y, 189, y); d.w([230, y], [300, y]);
      d.R('R1', 60, 60, 60, 150, 'l'); d.dot(60, 150);
      d.C('C2', 60, 150, 180, 150, 'b'); d.dot(180, 150);
      d.w([60, 150], [60, 220]); d.C('C3', 60, 220, 180, 220, 'b'); d.dot(180, 220);
      d.Rv('RB', 180, 150, 180, 220, 'r');
      d.Rv('RM', 180, 220, 180, 278, 'r'); d.gnd(180, 278);
      d.term(22, 60, 'IN'); d.term(300, y, 'OUT', 'r');
    },
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
    H: (v, s, o, z) => {
      // Nodes: 1 input, 2 treble top, 3 treble bottom, 4 output (treble wiper), 5 bass top, 6 bass bottom, 7 bass wiper.
      const [tTop, tBot] = potSplit(v.RT, 1 - taper(num(o, 'treble') / 10, 'A'));
      const [bTop, bBot] = potSplit(v.RB, 1 - taper(num(o, 'bass') / 10, 'A'));
      const els: Elem[] = [[1, 2, Yc(v.C1, s)], [2, 4, Yr(tTop)], [4, 3, Yr(tBot)], [3, 0, Yc(v.C2, s)],
                   [1, 5, Yr(v.R1)], [5, 7, Yr(bTop)], [7, 6, Yr(bBot)], [5, 7, Yc(v.C3, s)], [7, 6, Yc(v.C4, s)], [6, 0, Yr(v.R2)],
                   [7, 4, Yr(v.R3)]];
      if (z && z.zl) els.push([4, 0, ONE.div(z.zl)]);
      return nodal(7, els, 1, z && z.zs)[4];
    },
    analyze: (v, o, t) => toneStackMetrics(t, v, o),
    targets: [],
    vb: '0 0 400 365',
    sch: (d, o) => {
      d.w([22, 40], [60, 40]); d.dot(60, 40);
      d.C('C1', 60, 40, 200, 40);
      d.R('RT', 200, 40, 200, 130, 'l'); d.C('C2', 200, 130, 200, 168, 'l'); d.gnd(200, 168);
      const yt = 101 - 32 * taper(num(o, 'treble') / 10, 'A');
      d.arrow(260, yt, 209, yt); d.w([260, yt], [260, 85]); d.w([260, 85], [360, 85]); d.dot(300, 85);
      d.R('R1', 60, 40, 60, 200, 'l'); d.w([60, 200], [230, 200]); d.dot(140, 200);
      d.R('RB', 140, 200, 140, 300, 'l');
      const yb = 266 - 32 * taper(num(o, 'bass') / 10, 'A');
      d.arrow(190, yb, 149, yb); d.w([190, yb], [190, 250], [230, 250]);
      d.C('C3', 230, 200, 230, 250, 'r'); d.dot(230, 250); d.C('C4', 230, 250, 230, 300, 'r');
      d.w([140, 300], [230, 300]); d.dot(140, 300);
      d.R('R2', 140, 300, 140, 340, 'l'); d.gnd(140, 340);
      d.w([230, 250], [300, 250]); d.R('R3', 300, 250, 300, 85, 'r');
      d.term(22, 40, 'IN'); d.term(360, 85, 'OUT', 'r');
    },
  },
  {
    id: 'sk-lp', group: 'Active · 2nd order', name: 'Sallen-Key low-pass',
    blurb: 'Unity-gain Sallen-Key low-pass (−12 dB/oct). Q sets resonance at f0: 0.707 is Butterworth (maximally flat), higher values peak. Useful for cab-sim style top-end roll-offs.',
    parts: [P('R1', 'R', 10e3), P('R2', 'R', 10e3), P('C1', 'C', 22e-9), P('C2', 'C', 10e-9)],
    H: (v, s, o, z) => sallenKey(addZs(z, cx(v.R1)), cx(v.R2), Zc(v.C1, s), Zc(v.C2, s)),
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
    vb: '0 0 400 200',
    sch: d => {
      d.R('R1', 22, 94, 112, 94, 'b'); d.dot(112, 94); d.R('R2', 112, 94, 200, 94); d.dot(200, 94); d.w([200, 94], [230, 94]);
      d.C('C2', 200, 94, 200, 150, 'l'); d.gnd(200, 150);
      d.C('C1', 112, 94, 112, 34, 'l'); d.w([112, 34], [320, 34], [320, 110]);
      d.amp(230, 110, true); d.w([294, 110], [360, 110]); d.dot(320, 110);
      d.w([230, 126], [220, 126], [220, 178], [320, 178], [320, 110]);
      d.term(22, 94, 'IN'); d.term(360, 110, 'OUT', 'r');
    },
  },
  {
    id: 'sk-hp', group: 'Active · 2nd order', name: 'Sallen-Key high-pass',
    blurb: 'Unity-gain Sallen-Key high-pass (+12 dB/oct below f0). A steep, clean bass cut: good for tightening a high-gain circuit without thinning the mids.',
    parts: [P('C1', 'C', 47e-9), P('C2', 'C', 47e-9), P('R1', 'R', 24e3), P('R2', 'R', 47e3)],
    H: (v, s, o, z) => sallenKey(addZs(z, Zc(v.C1, s)), Zc(v.C2, s), cx(v.R1), cx(v.R2)),
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
    vb: '0 0 400 200',
    sch: d => {
      d.C('C1', 22, 94, 112, 94, 'b'); d.dot(112, 94); d.C('C2', 112, 94, 200, 94); d.dot(200, 94); d.w([200, 94], [230, 94]);
      d.R('R2', 200, 94, 200, 150, 'l'); d.gnd(200, 150);
      d.R('R1', 112, 94, 112, 34, 'l'); d.w([112, 34], [320, 34], [320, 110]);
      d.amp(230, 110, true); d.w([294, 110], [360, 110]); d.dot(320, 110);
      d.w([230, 126], [220, 126], [220, 178], [320, 178], [320, 110]);
      d.term(22, 94, 'IN'); d.term(360, 110, 'OUT', 'r');
    },
  },
  {
    id: 'mfb-lp', group: 'Active · 2nd order', name: 'MFB low-pass',
    blurb: 'Multiple-feedback 2nd-order low-pass with gain set by R2/R1. Inverting (output is phase-flipped) and less sensitive to part tolerances than Sallen-Key.',
    parts: [P('R1', 'R', 10e3), P('R2', 'R', 10e3), P('R3', 'R', 10e3), P('C1', 'C', 22e-9), P('C2', 'C', 2.2e-9)],
    H: (v, s, o, z) => {
      const Z1 = addZs(z, cx(v.R1)), k = cx(v.R2).div(Z1); // R2/Z1
      const d1 = k.scale(v.R3).add(v.R2 + v.R3).mul(s.scale(v.C2));
      return k.scale(-1).div(ONE.add(d1).add(s.mul(s).scale(v.C1 * v.C2 * v.R2 * v.R3)));
    },
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
    vb: '0 0 410 215',
    sch: d => {
      d.R('R1', 22, 124, 110, 124); d.dot(110, 124); d.R('R3', 110, 124, 205, 124); d.dot(205, 124); d.w([205, 124], [250, 124]);
      d.w([205, 124], [205, 84]); d.C('C2', 205, 84, 340, 84); d.w([340, 84], [340, 140]);
      d.w([110, 124], [110, 34]); d.R('R2', 110, 34, 340, 34); d.w([340, 34], [340, 84]); d.dot(340, 84);
      d.C('C1', 110, 124, 110, 180, 'r'); d.gnd(110, 180);
      d.amp(250, 140, false); d.w([250, 156], [236, 156], [236, 180]); d.gnd(236, 180);
      d.w([314, 140], [380, 140]); d.dot(340, 140);
      d.term(22, 124, 'IN'); d.term(380, 140, 'OUT', 'r');
    },
  },
  {
    id: 'mfb-bp', group: 'Active · 2nd order', name: 'MFB band-pass',
    blurb: 'Multiple-feedback band-pass: a resonant peak at f0 with bandwidth f0/Q. Think fixed-wah or mid-hump voicing. Inverting; peak gain must stay below 2Q².',
    parts: [P('R1', 'R', 15e3), P('R2', 'R', 68e3), P('R3', 'R', 2.2e3), P('C1', 'C', 10e-9), P('C2', 'C', 10e-9)],
    H: (v, s, o, z) => {
      const Y1 = ONE.div(addZs(z, cx(v.R1)));
      return s.scale(-v.C1 * v.R2).mul(Y1).div(Y1.add(1 / v.R3).add(s.scale(v.C1 + v.C2)).add(s.mul(s).scale(v.C1 * v.C2 * v.R2)));
    },
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
    vb: '0 0 410 215',
    sch: d => {
      d.R('R1', 22, 124, 110, 124); d.dot(110, 124); d.C('C1', 110, 124, 205, 124); d.dot(205, 124); d.w([205, 124], [250, 124]);
      d.w([205, 124], [205, 84]); d.R('R2', 205, 84, 340, 84); d.w([340, 84], [340, 140]);
      d.w([110, 124], [110, 34]); d.C('C2', 110, 34, 340, 34); d.w([340, 34], [340, 84]); d.dot(340, 84);
      d.R('R3', 110, 124, 110, 180, 'r'); d.gnd(110, 180);
      d.amp(250, 140, false); d.w([250, 156], [236, 156], [236, 180]); d.gnd(236, 180);
      d.w([314, 140], [380, 140]); d.dot(340, 140);
      d.term(22, 124, 'IN'); d.term(380, 140, 'OUT', 'r');
    },
  },
];
export const topoById = (id: string): Topology | undefined => TOPOS.find(t => t.id === id);

