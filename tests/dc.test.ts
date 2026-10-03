import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU, db } from '../src/core/units';
import { dcOp } from '../src/engine/dc';
import { acModel, linearize } from '../src/engine/linearize';
import { DIODE_MODELS } from '../src/engine/models';
import { C, GND, OA, R, type Element, type Netlist } from '../src/engine/netlist';
import { BJT_MODELS, JFET_MODELS, MOS_MODELS, VT, bjtIV, jfetIV } from '../src/engine/semis';
import { toSpice } from '../src/engine/spice';

const s = (f: number) => new Cx(0, TAU * f);
const V = (name: string, p: string, dc: number): Element => ({ type: 'V', name, p, n: GND, dc });
const D = (name: string, a: string, k: string, model = '1N4148'): Element => ({ type: 'D', name, a, k, model });
const Q = (name: string, c: string, b: string, e: string, model = '2N3904'): Element => ({ type: 'Q', name, c, b, e, model });
const J = (name: string, d: string, g: string, s: string, model = 'J201'): Element => ({ type: 'J', name, d, g, s, model });
const nl = (elements: Element[], input = 'in', output = 'out'): Netlist => ({ elements, input, output });

/** LPB-1 style common-emitter booster. */
const lpb1 = (model = '2N3904', vcc = 9) => nl([
  V('V1', 'vcc', vcc),
  C('C1', 'in', 'b', 100e-9),
  R('R1', 'vcc', 'b', 430e3), R('R2', 'b', GND, 43e3),
  Q('Q1', 'c', 'b', 'e', model),
  R('RC', 'vcc', 'c', 10e3), R('RE', 'e', GND, 390),
  C('C2', 'c', 'out', 100e-9), R('RV', 'out', GND, 100e3),
]);

describe('device equations', () => {
  it('BJT derivatives match finite differences', () => {
    const m = BJT_MODELS['2N3904'], h = 1e-7;
    for (const [vbe, vbc] of [[0.65, -4], [0.7, 0.6], [-0.2, -5]]) {
      const r = bjtIV(vbe, vbc, m);
      const fd = (f: (x: ReturnType<typeof bjtIV>) => number, dv: [number, number]) =>
        (f(bjtIV(vbe + dv[0], vbc + dv[1], m)) - f(bjtIV(vbe - dv[0], vbc - dv[1], m))) / (2 * h);
      const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-4 * Math.abs(b) + 1e-12);
      near(r.dic_dvbe, fd(x => x.ic, [h, 0])); near(r.dic_dvbc, fd(x => x.ic, [0, h]));
      near(r.dib_dvbe, fd(x => x.ib, [h, 0])); near(r.dib_dvbc, fd(x => x.ib, [0, h]));
    }
  });
  it('JFET derivatives match finite differences in every region, including vds < 0', () => {
    const m = JFET_MODELS.J201, h = 1e-7;
    for (const [vgs, vds] of [[-0.3, 4], [-0.2, 0.2], [-0.2, -0.3], [-1, 3]]) {
      const r = jfetIV(vgs, vds, m);
      const gm = (jfetIV(vgs + h, vds, m).id - jfetIV(vgs - h, vds, m).id) / (2 * h);
      const gds = (jfetIV(vgs, vds + h, m).id - jfetIV(vgs, vds - h, m).id) / (2 * h);
      expect(Math.abs(r.gm - gm)).toBeLessThan(1e-6);
      expect(Math.abs(r.gds - gds)).toBeLessThan(1e-6);
    }
  });
});

describe('DC operating point', () => {
  it('linear circuits solve directly', () => {
    const op = dcOp(nl([V('V1', 'a', 9), R('R1', 'a', 'b', 10e3), R('R2', 'b', GND, 10e3), C('C1', 'b', 'out', 1e-6), R('R3', 'out', GND, 1e3)]));
    expect(op.ok).toBe(true);
    expect(op.method).toBe('linear');
    expect(op.v('b')).toBeCloseTo(4.5, 6);
    expect(op.v('out')).toBeCloseTo(0, 9); // behind a cap
  });

  it('diode and resistor satisfy KCL', () => {
    for (const model of Object.keys(DIODE_MODELS)) {
      const op = dcOp(nl([V('V1', 'a', 9), R('R1', 'a', 'k', 1e3), D('D1', 'k', GND, model)]));
      expect(op.ok).toBe(true);
      const m = DIODE_MODELS[model], vd = op.v('k');
      const id = m.is * (Math.exp(vd / (m.n * VT)) - 1);
      expect(Math.abs((9 - vd) / 1e3 - id)).toBeLessThan(1e-8);
    }
  });

  it('LPB-1 booster biases with Vc around mid-supply and ~25 dB gain', () => {
    const { circuit, op } = acModel(lpb1());
    expect(op!.ok).toBe(true);
    const q = [...op!.devices.values()][0];
    expect(q.type).toBe('Q');
    if (q.type !== 'Q') return;
    expect(q.region).toBe('active');
    expect(op!.v('c')).toBeGreaterThan(3.5);
    expect(op!.v('c')).toBeLessThan(5.5);
    expect(q.gm).toBeCloseTo(q.ic / VT, 2);
    const g = db(circuit.transfer(s(1000)).abs());
    expect(g).toBeGreaterThan(22);
    expect(g).toBeLessThan(29);
    // Inverting stage: phase ≈ 180° in mid-band.
    expect(circuit.transfer(s(1000)).re).toBeLessThan(0);
  });

  it('a PNP mirror image biases identically on a negative supply', () => {
    const n = dcOp(lpb1('2N3904', 9)), p = dcOp(lpb1('2N3906', -9));
    expect(p.ok).toBe(true);
    expect(p.v('c')).toBeLessThan(-2);
    expect(p.v('c')).toBeGreaterThan(-6.5);
    const qp = [...p.devices.values()][0];
    if (qp.type === 'Q') { expect(qp.ic).toBeLessThan(0); expect(qp.region).toBe('active'); }
    expect(Math.sign(n.v('c'))).toBe(1);
  });

  it('JFET common-source self-bias satisfies the square law', () => {
    const net = nl([
      V('V1', 'vcc', 9), C('C1', 'in', 'g', 100e-9), R('RG', 'g', GND, 1e6),
      J('J1', 'd', 'g', 's'), R('RD', 'vcc', 'd', 6.8e3), R('RS', 's', GND, 1e3), C('CS', 's', GND, 22e-6),
      C('C2', 'd', 'out', 100e-9), R('RV', 'out', GND, 1e6),
    ]);
    const { circuit, op } = acModel(net);
    expect(op!.ok).toBe(true);
    const m = JFET_MODELS.J201, vs = op!.v('s'), id = vs / 1e3, vgs = -vs;
    expect(Math.abs(id - m.beta * (vgs - m.vto) ** 2 * (1 + m.lambda * (op!.v('d') - vs)))).toBeLessThan(1e-7);
    expect(op!.v('d')).toBeGreaterThan(1);
    // Bypassed source: gain ≈ gm·(RD ∥ rds ∥ RV).
    const j = [...op!.devices.values()][0];
    if (j.type !== 'J') throw new Error('expected a JFET');
    const rl = 1 / (1 / 6.8e3 + j.gds + 1 / 1e6);
    expect(circuit.transfer(s(2000)).abs()).toBeCloseTo(j.gm * rl, 0);
  });

  it('diodes biased at 0 V are effectively open in AC', () => {
    const net = nl([R('R1', 'in', 'out', 10e3), D('D1', 'out', GND), D('D2', GND, 'out')]);
    const { circuit } = acModel(net);
    expect(circuit.transfer(s(1000)).abs()).toBeGreaterThan(0.99);
  });

  it('a forward-biased diode shows its dynamic resistance in AC', () => {
    // 9 V through 8.2k: ~1 mA, rd = n·VT / Id ≈ 45 Ω; AC drive through 10k into the junction.
    const net = nl([V('V1', 'a', 9), R('R1', 'a', 'k', 8.2e3), D('D1', 'k', GND), C('C1', 'in', 'x', 1e-3), R('R2', 'x', 'k', 10e3), R('R3', 'k', 'out', 1)]);
    const { circuit, op } = acModel(net);
    const d = [...op!.devices.values()][0];
    if (d.type !== 'D') throw new Error('expected a diode');
    const rd = 1 / d.gd, rpar = 1 / (1 / rd + 1 / 8.2e3);
    expect(circuit.transfer(s(1000)).abs()).toBeCloseTo(rpar / (rpar + 10e3), 4);
    expect(linearize(net, op!).elements.some(e => e.name === 'D1.rd')).toBe(true);
  });

  it('op-amp with diodes in the feedback (TS-style clipper) still converges', () => {
    const net = nl([
      V('V1', 'vref', 4.5), C('C1', 'in', 'p', 1e-6), R('R1', 'p', 'vref', 1e6),
      OA('U1', 'p', 'n', 'o', 'TL072'), R('R2', 'n', 'x', 4.7e3), C('C2', 'x', 'vref', 47e-9),
      R('R3', 'n', 'o', 51e3), D('D1', 'o', 'n'), D('D2', 'n', 'o'), C('C3', 'o', 'out', 1e-6), R('R4', 'out', GND, 100e3),
    ]);
    const op = dcOp(net);
    expect(op.ok).toBe(true);
    expect(op.v('o')).toBeCloseTo(4.5, 3);
  });

  it('Fuzz Face-style two-transistor feedback pair converges', () => {
    const net = nl([
      V('V1', 'vcc', 9), C('C1', 'in', 'b1', 2.2e-6),
      Q('Q1', 'c1', 'b1', GND), R('R1', 'vcc', 'c1', 33e3),
      Q('Q2', 'c2', 'c1', 'e2'), R('RF', 'b1', 'e2', 100e3),
      R('RC2a', 'c2', 'mid', 470), R('RC2b', 'mid', 'vcc', 8.2e3),
      R('RE2', 'e2', GND, 1e3), C('CE', 'e2', GND, 22e-6),
      C('C3', 'mid', 'out', 10e-9), R('RV', 'out', GND, 500e3),
    ]);
    const op = dcOp(net);
    expect(op.ok).toBe(true);
    expect(op.v('b1')).toBeGreaterThan(0.5);
    expect(op.v('b1')).toBeLessThan(0.75);
    expect(op.v('c2')).toBeGreaterThan(0.5);
    expect(op.v('c2')).toBeLessThan(9);
  });
});

describe('SPICE export of transistors', () => {
  it('writes Q/J lines and their .model cards', () => {
    const net = nl([...lpb1().elements, J('J1', 'c', 'x', GND), R('RX', 'x', GND, 1e6)]);
    const deck = toSpice(net);
    expect(deck).toMatch(/^Q1 c b e 2N3904$/m);
    expect(deck).toMatch(/^J1 c x 0 J201$/m);
    expect(deck).toMatch(/^\.model 2N3904 NPN\(/m);
    expect(deck).toMatch(/^\.model J201 NJF\(Beta=1\.07m Vto=-0\.93/m);
  });
});

describe('MOSFETs', () => {
  const M = (name: string, d: string, g: string, s: string, model = '2N7000'): Element => ({ type: 'M', name, d, g, s, model });

  it('a diode-connected 2N7000 satisfies the square law (and draws no gate current)', () => {
    const op = dcOp(nl([V('V1', 'a', 9), R('R1', 'a', 'd', 10e3), M('Q1', 'd', 'd', GND)]));
    expect(op.ok).toBe(true);
    const m = MOS_MODELS['2N7000'], v = op.v('d');
    expect(v).toBeGreaterThan(m.vth);
    expect(Math.abs((9 - v) / 10e3 - m.kp / 2 * (v - m.vth) ** 2 * (1 + m.lambda * v))).toBeLessThan(1e-8);
  });

  it('reverse-biased, only the body diode conducts', () => {
    const op = dcOp(nl([V('V1', 'a', -9), R('R1', 'a', 'd', 10e3), M('Q1', 'd', 'd', GND)]));
    expect(op.ok).toBe(true);
    expect(op.v('d')).toBeLessThan(-0.5);
    expect(op.v('d')).toBeGreaterThan(-0.9);
    const d = [...op.devices.values()][0];
    if (d.type !== 'M') throw new Error('expected a MOSFET');
    expect(d.region).toBe('cutoff');
    expect(d.ibody).toBeGreaterThan(0.7e-3);
  });

  it('PMOS mirrors NMOS on a negative supply', () => {
    const op = dcOp(nl([V('V1', 'a', -9), R('R1', 'a', 'd', 10e3), M('Q1', 'd', 'd', GND, 'BS250')]));
    expect(op.ok).toBe(true);
    expect(op.v('d')).toBeLessThan(-MOS_MODELS.BS250.vth);
  });

  it('common-source gain matches gm·RD / (1 + gm·RS)', () => {
    const net = nl([
      V('V1', 'vcc', 9), C('C1', 'in', 'g', 1e-6), R('RG1', 'vcc', 'g', 1e6), R('RG2', 'g', GND, 330e3),
      M('Q1', 'd', 'g', 's'), R('RD', 'vcc', 'd', 10e3), R('RS', 's', GND, 1e3),
      C('C2', 'd', 'out', 1e-6), R('RV', 'out', GND, 10e6),
    ]);
    const { circuit, op } = acModel(net);
    expect(op!.ok).toBe(true);
    const q = [...op!.devices.values()][0];
    if (q.type !== 'M') throw new Error('expected a MOSFET');
    expect(q.region).toBe('saturation');
    const rd = 1 / (1 / 10e3 + 1 / 10e6);
    const expected = q.gm * rd / (1 + q.gm * 1e3); // rds ≫ RD, ignored
    expect(circuit.transfer(s(1000)).abs()).toBeCloseTo(expected, 1);
  });

  it('exports M lines (body tied to source, bulk junction = body diode) and model cards', () => {
    const deck = toSpice(nl([V('V1', 'a', 9), R('R1', 'a', 'd', 10e3), M('Q1', 'd', 'd', GND), R('R2', 'in', 'out', 1)]));
    expect(deck).toMatch(/^MQ1 d d 0 0 2N7000 W=1 L=1$/m);
    expect(deck).toMatch(/^\.model 2N7000 NMOS\(Level=1 .*Is=100f Cgso=20p Cgdo=5p\)/m);
    expect(deck).not.toMatch(/DBODY/);
  });
});
