import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import { reshapePart } from '../src/builder/doc';
import { dcOp } from '../src/engine/dc';
import { acModel } from '../src/engine/linearize';
import { GND, R, type Element, type Netlist } from '../src/engine/netlist';
import { toSpice } from '../src/engine/spice';
import { renderAudio } from '../src/engine/transient';
import { exportAsc } from '../src/ltspice/export';
import { sch } from '../src/schematic/build';
import { extract } from '../src/schematic/extract';
import { PARTS, opAmpPinMap, opAmpView, partPins } from '../src/schematic/library';
import type { PartProps, Schematic } from '../src/schematic/types';

/**
 * A follower on op-amp A of a dual in its 8-pin view (pins 1–4 down the left at x = −50, 8–5 down
 * the right at x = 50): IN → pin 3, pin 1 → pin 2 and OUT, pin 4 to ground, pin 8 to a `vplus` supply.
 * Op-amp B is left unconnected. Another 9 V supply sits off to the side, unconnected.
 */
function dualFollower(vplus: number, props: PartProps = {}): Schematic {
  return sch()
    .OA('U1', 0, 0, props.model ?? 'ideal', { props: { pins: 'all', ...props } })
    .IN(-120, 10).wire([-120, 10], [-50, 10])
    .wire([-50, -30], [-50, -10]).wire([-50, -30], [-120, -30]).OUT(-120, -30)
    .GND(-50, 30)
    .part('SUPPLY', undefined, 50, -30, 0, vplus, { props: { name: 'VP' } })
    .part('SUPPLY', undefined, 200, 0, 0, 9, { props: { name: '9V' } })
    .build();
}

describe('op-amp 8-pin view', () => {
  it('a dual shows 8 numbered pins; the triangle has 3', () => {
    const d = dualFollower(9);
    expect(partPins(d.parts[0]).map(p => `${p.name} ${p.label}`)).toEqual(['1 OUTA', '2 −INA', '3 +INA', '4 V−', '5 +INB', '6 −INB', '7 OUTB', '8 V+']);
    expect(partPins({ ...d.parts[0], props: { model: 'TL072' } }).map(p => p.name)).toEqual(['-', '+', 'out']);
    expect(opAmpView({ ...d.parts[0], props: { model: 'LM741', pins: 'all' } })).toBe('single');
    expect(opAmpView({ ...d.parts[0], props: { model: 'LM386' } })).toBe('lm386'); // always its package
  });

  it('uses op-amp A only, with its supply pins, and doesn’t flag the unused op-amp B', () => {
    const ex = extract(dualFollower(9));
    const oas = ex.netlist.elements.filter(e => e.type === 'OA');
    expect(oas).toEqual([{ type: 'OA', name: 'U1A', inP: 'in', inN: 'out', out: 'out', model: 'ideal', vp: 'VP', vn: GND }]);
    expect(ex.issues.filter(i => /^U1 /.test(i.message))).toEqual([]);
  });

  it('flags an unconnected supply pin by name', () => {
    const d = dualFollower(9);
    const ex = extract({ ...d, parts: d.parts.filter(p => p.props?.name !== 'VP') });
    expect(ex.issues.map(i => i.message)).toContain('U1 pin 8 (V+) is not connected.');
  });

  it('clips at the voltages on its supply pins, not the whole circuit’s', () => {
    const swing = (d: Schematic) => {
      const y = renderAudio(extract(d).netlist, Array.from({ length: 480 }, (_, i) => 8 * Math.sin(TAU * i / 48)), { fs: 48000, oversample: 2 }).out.get('out')!;
      return [Math.min(...y), Math.max(...y)].map(v => +v.toFixed(1) + 0);
    };
    expect(swing(dualFollower(5))).toEqual([0, 5]); // pin 8 at 5 V, pin 4 at ground
    // The same follower as a triangle clips at the circuit's supply span (0 … 9 V).
    const tri = sch().OA('U1', 0, 0, 'ideal')
      .IN(-120, 20).wire([-120, 20], [-40, 20]).wire([40, 0], [40, -50]).wire([40, -50], [-40, -50]).wire([-40, -50], [-40, -20])
      .wire([40, 0], [120, 0]).OUT(120, 0).part('SUPPLY', undefined, 200, 0, 0, 9).build();
    expect(swing(tri)).toEqual([0, 8]);
  });

  it('switching views keeps the wires on the matching pins', () => {
    // Triangle follower: IN → +, out → − and OUT.
    const tri = sch().OA('U1', 0, 0, 'TL072')
      .IN(-120, 20).wire([-120, 20], [-40, 20]).wire([40, 0], [40, -50]).wire([40, -50], [-40, -50]).wire([-40, -50], [-40, -20])
      .wire([40, 0], [120, 0]).OUT(120, 0).build();
    const all = reshapePart(tri, 'U1', { props: { pins: 'all' } }, opAmpPinMap('triangle', 'dual'));
    const oa = extract(all).netlist.elements.find(e => e.type === 'OA');
    expect(oa).toMatchObject({ name: 'U1A', inP: 'in', inN: 'out', out: 'out' });
    // And back again.
    const back = reshapePart(all, 'U1', { props: { pins: undefined } }, opAmpPinMap('dual', 'triangle'));
    expect(extract(back).netlist.elements.find(e => e.type === 'OA')).toMatchObject({ name: 'U1', inP: 'in', inN: 'out', out: 'out' });
    expect(extract(back).issues.filter(i => /not connected/.test(i.message))).toEqual([]);
  });
});

describe('exporting the 8-pin view', () => {
  it('LTspice gets an op-amp symbol for each op-amp in use; an LM386 is noted, not exported', () => {
    const asc = exportAsc(dualFollower(9));
    expect(asc.match(/^SYMATTR InstName U1\w*$/gm)).toEqual(['SYMATTR InstName U1A']);
    const d = dualFollower(9, { model: 'LM386' });
    expect(exportAsc(d)).toMatch(/U1 \(LM386\) isn't exported/);
  });

  it('SPICE netlists include the LM386 macromodel', () => {
    const d = dualFollower(9, { model: 'LM386' });
    const cir = toSpice(extract(d).netlist);
    expect(cir).toMatch(/^EU1_fp U1_a1 /m);
    // Every element has its own name.
    const names = cir.split('\n').filter(l => /^[A-Z]/.test(l)).map(l => l.split(' ')[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(cir).toMatch(/^XU1 /m);
  });
});

describe('LM386', () => {
  /** IN → pin 3, pin 2 and pin 4 grounded, 9 V on pin 6, output on pin 5; `extra` across pins 1 and 8. */
  function lm386(extra: Element[] = []): Netlist {
    const pins: Record<string, string> = { '1': 'g1', '2': GND, '3': 'in', '4': GND, '5': 'out', '6': 'vs', '7': 'byp', '8': 'g8' };
    const els = PARTS.OA.elements({ id: 'U1', ref: 'U1', kind: 'OA', x: 0, y: 0, rot: 0, props: { model: 'LM386' } }, pin => pins[pin]);
    return { elements: [...els, { type: 'V', name: 'VS', p: 'vs', n: GND, dc: 9 }, ...extra], input: 'in', output: 'out' };
  }
  const gain = (nl: Netlist) => acModel(nl).circuit.solve(new Cx(0, TAU * 1000), {}).v(nl.output).abs();

  it('sits at half the supply', () => {
    expect(dcOp(lm386()).v('out')).toBeCloseTo(4.5, 1);
  });

  it('has a gain of 20, or 200 with a capacitor across pins 1 and 8', () => {
    expect(gain(lm386())).toBeCloseTo(21, 0); // 20 from the inputs, +1 from the follower at pin 1
    expect(gain(lm386([{ type: 'C', name: 'C1', a: 'g1', b: 'g8', value: 10e-6 }]))).toBeCloseTo(201, -1);
    // A resistor in series with the capacitor sets a gain in between: 2 · 15k / (150 + 1.35k ∥ 1.2k) ≈ 38.
    expect(gain(lm386([R('R1', 'g1', 'x', 1.2e3), { type: 'C', name: 'C1', a: 'x', b: 'g8', value: 10e-6 }]))).toBeCloseTo(39, 0);
  });

  it('clips within its supply (less its headroom)', () => {
    const nl = lm386([{ type: 'C', name: 'C1', a: 'g1', b: 'g8', value: 10e-6 }]);
    const y = renderAudio(nl, Array.from({ length: 960 }, (_, i) => 0.2 * Math.sin(TAU * i / 48)), { fs: 48000, oversample: 2 }).out.get('out')!.slice(480);
    // The flat tops of the (nearly square) wave; its edges ring a little from resampling to 48 kHz.
    const s = Array.from(y).sort((a, b) => a - b), lo = s[Math.floor(s.length * 0.1)], hi = s[Math.floor(s.length * 0.9)];
    expect(lo).toBeCloseTo(0.8, 1); // 0 V + 0.8 V headroom
    expect(hi).toBeCloseTo(8, 1); // 9 V − 1 V headroom
  });
});
