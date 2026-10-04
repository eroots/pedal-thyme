import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import { joinChain, supplyRails } from '../src/engine/chain';
import { Circuit } from '../src/engine/mna';
import type { Netlist } from '../src/engine/netlist';
import { renderAudio } from '../src/engine/transient';

const at1k = (nl: Netlist) => new Circuit(nl).transfer(new Cx(0, TAU * 1000)).abs();

describe('signal chains', () => {
  // A: 1 kΩ in series (high output impedance); B: 1 kΩ to ground at its input (low input impedance).
  const A: Netlist = { input: 'in', output: 'out', elements: [{ type: 'R', name: 'R1', a: 'in', b: 'out', value: 1e3 }] };
  const B: Netlist = { input: 'in', output: 'in', elements: [{ type: 'R', name: 'R1', a: 'in', b: '0', value: 1e3 }] };

  it('loads the earlier pedal with the next one (not just multiplying responses)', () => {
    expect(at1k(A) * at1k(B)).toBeCloseTo(1, 6);
    expect(at1k(joinChain([A, B]))).toBeCloseTo(0.5, 6);
  });

  it('keeps the last pedal\'s names and prefixes the earlier ones', () => {
    const j = joinChain([A, A, B]);
    expect(j.elements.map(e => e.name)).toEqual(['u0:R1', 'u1:R1', 'R1']);
    // u0's output is u1's input, u1's output is B's input; the chain input is the first pedal's.
    expect(j.elements[0]).toMatchObject({ a: 'u0:in', b: 'u1:in' });
    expect(j.elements[1]).toMatchObject({ a: 'u1:in', b: 'in' });
    expect(j.input).toBe('u0:in');
    expect(j.output).toBe('in');
    expect(at1k(j)).toBeCloseTo(1 / 3, 6);
    expect(joinChain([B])).toBe(B);
  });

  it('gives each pedal\'s op-amps that pedal\'s own supply rails', () => {
    const buffer = (v: number): Netlist => ({
      input: 'in', output: 'out', elements: [
        { type: 'V', name: 'VCC', p: 'vcc', n: '0', dc: v },
        { type: 'R', name: 'Rb', a: 'vcc', b: 'in', value: 1e6 }, { type: 'R', name: 'Rb2', a: 'in', b: '0', value: 1e6 },
        { type: 'OA', name: 'U1', inP: 'in', inN: 'out', out: 'out', model: 'TL072' },
      ],
    });
    expect(supplyRails(buffer(18))).toEqual([0, 18]);
    const j = joinChain([buffer(9), buffer(18)]);
    expect(j.elements.filter(e => e.type === 'OA').map(e => e.type === 'OA' && e.rails)).toEqual([[0, 9], [0, 18]]);
    // The 9 V buffer clips at its own rails less headroom (≈1.5–7.5 V), though the circuit also has 18 V.
    const fs = 48000, n = 4800, x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = 8 * Math.sin(TAU * 200 * i / fs);
    const res = renderAudio(j, x, { fs, oversample: 2, probes: ['in'] }); // the 9 V buffer's output is the 18 V one's input (named as in that pedal)
    const y = res.out.get('in')!;
    expect(Math.max(...y.slice(n / 2))).toBeLessThan(7.8);
    expect(Math.min(...y.slice(n / 2))).toBeGreaterThan(1.2);
  });
});
