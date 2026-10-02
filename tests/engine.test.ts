import { describe, expect, it } from 'vitest';
import { Cx, cx } from '../src/core/complex';
import { TAU, db } from '../src/core/units';
import { Circuit } from '../src/engine/mna';
import { BUF, C, GND, L, OA, POT, R, RHEO, type Netlist } from '../src/engine/netlist';
import { toSpice } from '../src/engine/spice';

const s = (f: number) => new Cx(0, TAU * f);
const circ = (elements: Netlist['elements'], input = 'in', output = 'out') => new Circuit({ elements, input, output });
const close = (a: Cx, b: Cx | number, tol = 1e-9) => expect(a.sub(cx(b)).abs() / Math.max(cx(b).abs(), 1e-30)).toBeLessThan(tol);

describe('passive elements', () => {
  it('resistive divider', () => {
    close(circ([R('R1', 'in', 'out', 10e3), R('R2', 'out', GND, 10e3)]).transfer(s(1000)), 0.5);
  });
  it('RC low-pass matches 1/(1+sRC)', () => {
    const c = circ([R('R', 'in', 'out', 10e3), C('C', 'out', GND, 10e-9)]);
    for (const f of [10, 1592, 1e5]) close(c.transfer(s(f)), new Cx(1, 0).div(new Cx(1, TAU * f * 1e-4)));
  });
  it('LC series resonance into a resistor peaks at 1/(2π√LC)', () => {
    const c = circ([L('L', 'in', 'm', 0.1), C('C', 'm', 'out', 100e-9), R('R', 'out', GND, 10)]);
    const f0 = 1 / (TAU * Math.sqrt(0.1 * 100e-9));
    close(c.transfer(s(f0)), 1, 1e-6);
  });
  it('source and load impedances', () => {
    const c = circ([R('R1', 'in', 'out', 10e3), R('R2', 'out', GND, 10e3)]);
    close(c.transfer(s(1000), cx(10e3), null), 1 / 3);
    close(c.transfer(s(1000), null, cx(10e3)), 1 / 3);
  });
});

describe('impedances', () => {
  it('input impedance of a divider and of an RC high-pass', () => {
    close(circ([R('R1', 'in', 'out', 10e3), R('R2', 'out', GND, 22e3)]).zin(s(1000)), 32e3);
    const f = 100, zc = new Cx(0, -1 / (TAU * f * 100e-9));
    close(circ([C('C', 'in', 'out', 100e-9), R('R', 'out', GND, 1e6)]).zin(s(f)), zc.add(1e6), 1e-6);
  });
  it('output impedance of a divider is R1 ∥ R2', () => {
    close(circ([R('R1', 'in', 'out', 10e3), R('R2', 'out', GND, 10e3)]).zout(s(1000)), 5e3);
  });
  it('a real op-amp follower has a tiny output impedance', () => {
    const z = circ([OA('U1', 'in', 'out', 'out', 'TL072')]).zout(s(1000));
    expect(z.abs()).toBeLessThan(0.1);
  });
});

describe('op-amps', () => {
  const nonInv = (model: string, rf: number, rg: number) =>
    circ([OA('U1', 'in', 'n', 'out', model), R('Rf', 'n', 'out', rf), R('Rg', 'n', GND, rg)]);
  const inv = (model: string) =>
    circ([R('Ri', 'in', 'n', 10e3), R('Rf', 'n', 'out', 47e3), OA('U1', GND, 'n', 'out', model)]);

  it('ideal non-inverting gain is 1 + Rf/Rg', () => close(nonInv('ideal', 100e3, 1e3).transfer(s(1e4)), 101));
  it('ideal inverting gain is −Rf/Ri', () => close(inv('ideal').transfer(s(1e4)), -4.7));
  it('VCVS buffer copies its input', () => {
    close(circ([BUF('B', 'in', 'out'), R('RL', 'out', GND, 10)]).transfer(s(1000)), 1);
  });
  it('a finite-GBW op-amp rolls off at ≈ GBW / noise gain', () => {
    const c = nonInv('TL072', 100e3, 1e3); // noise gain 101, GBW 3 MHz → ≈ 29.7 kHz
    const fc = 3e6 / 101;
    expect(db(c.transfer(s(100)).abs())).toBeCloseTo(db(101), 1);
    expect(db(c.transfer(s(fc)).abs())).toBeCloseTo(db(101) - 3, 0);
  });
  it('finite open-loop gain lowers the closed-loop gain slightly', () => {
    // G = 101 / (1 + 101/A0) with A0 = 200k
    close(nonInv('TL072', 100e3, 1e3).transfer(s(1)), 101 / (1 + 101 / 200e3), 1e-4);
  });
});

describe('pots, switches and diodes', () => {
  it('a linear pot at half rotation is a 50/50 divider', () => {
    close(circ([POT('VR', 'in', 'out', GND, 100e3, 0.5, 'B')]).transfer(s(1000)), 0.5);
  });
  it('an audio pot at half rotation passes ≈ 10%', () => {
    // R(a,w) = 10% of the track, so with a = ground, b = input, the wiper sits at 10% of Vin.
    close(circ([POT('VR', GND, 'out', 'in', 100e3, 0.5, 'A')]).transfer(s(1000)), 0.1, 1e-6);
  });
  it('a rheostat never reaches 0 Ω', () => {
    const c = circ([R('R1', 'in', 'out', 1e3), RHEO('VR', 'out', GND, 10e3, 0)]);
    close(c.transfer(s(1000)), 1 / 1001, 1e-6);
  });
  it('switches route the signal', () => {
    const make = (closed: boolean) => circ([{ type: 'SW', name: 'S1', a: 'in', b: 'out', closed }, R('R', 'out', GND, 1e3)]);
    close(make(true).transfer(s(1000)), 1);
    expect(make(false).transfer(s(1000)).abs()).toBeLessThan(1e-9);
    const spdt = (pos: 'a' | 'b') => circ([
      R('Ra', 'in', 'a', 1e3), R('Rb', 'in', 'b', 3e3), R('Rg', 'out', GND, 1e3),
      { type: 'SPDT', name: 'S2', com: 'out', a: 'a', b: 'b', pos },
    ]);
    close(spdt('a').transfer(s(1000)), 0.5);
    close(spdt('b').transfer(s(1000)), 0.25);
  });
  it('a diode is open in small-signal AC, and its floating node stays solvable', () => {
    const c = circ([R('R', 'in', 'out', 1e3), { type: 'D', name: 'D1', a: 'out', k: 'x', model: '1N4148' }, R('Rx', 'x', 'y', 1e3)]);
    close(c.transfer(s(1000)), 1, 1e-9);
  });
});

describe('SPICE export', () => {
  const nl: Netlist = {
    title: 'TS gain stage',
    input: 'in', output: 'out',
    elements: [
      OA('U1', 'in', 'n', 'out', 'TL072'), R('Rf', 'n', 'out', 51e3), C('Cf', 'n', 'out', 51e-12),
      R('Rg', 'n', 'm', 4.7e3), C('Cg', 'm', GND, 47e-9), POT('VR', 'out', 'w', GND, 10e3, 0.5, 'A'),
      { type: 'D', name: 'D1', a: 'w', k: GND, model: '1N4148' },
    ],
  };
  const text = toSpice(nl, {
    fmin: 20, fmax: 20e3,
    term: { src: { on: true, preset: 'x', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: true, preset: 'y', R: 1e6, C: 0 } },
  });
  it('writes elements with exponent notation (never the ambiguous M suffix)', () => {
    expect(text).toContain('Rf n out 51000');
    expect(text).toContain('Cg m 0 4.7e-8');
    expect(text).toContain('R_LOAD out 0 1000000');
    expect(text).not.toMatch(/\d+M\b/);
  });
  it('includes the source model, op-amp subcircuit, diode model and analysis', () => {
    expect(text).toContain('V_IN src_ideal 0 AC 1');
    expect(text).toContain('L_SRC src_rl in 2.5');
    expect(text).toContain('C_CABLE in 0 4.7e-10');
    expect(text).toContain('XU1 in n out OPAMP_TL072');
    expect(text).toMatch(/\.subckt OPAMP_TL072 inp inn out[\s\S]*\.ends/);
    expect(text).toContain('.model 1N4148 D(');
    expect(text).toContain('.ac dec 100 20 20000');
    expect(text.trim().endsWith('.end')).toBe(true);
  });
  it('splits pots into two resistors at the wiper', () => {
    expect(text).toMatch(/RVR_1 out w 1000\n/);
    expect(text).toMatch(/RVR_3 w 0 9000\n/);
  });
});
