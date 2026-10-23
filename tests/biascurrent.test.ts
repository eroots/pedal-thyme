import { describe, expect, it } from 'vitest';
import { dcOp } from '../src/engine/dc';
import { OPAMP_MODELS } from '../src/engine/models';
import { GND, R, type Element } from '../src/engine/netlist';
import { PARTS } from '../src/schematic/library';
import type { PartProps, SchPart } from '../src/schematic/types';

/** A follower whose + input sits on 1 MΩ to ground: the bias current shows up as −Ib × 1 MΩ there. */
function follower(props: PartProps) {
  const oa: SchPart = { id: 'U1', ref: 'U1', kind: 'OA', x: 0, y: 0, rot: 0, props };
  const pins: Record<string, string> = { '+': 'p', '-': 'out', out: 'out' };
  const els: Element[] = [R('R1', 'p', GND, 1e6), ...PARTS.OA.elements(oa, pin => pins[pin])];
  return { els, op: dcOp({ elements: els, input: 'in', output: 'out' }) };
}

describe('op-amp input bias current', () => {
  it('draws the model’s typical current into the inputs (NPN 4558)', () => {
    const { op } = follower({ model: 'JRC4558' });
    expect(op.ok).toBe(true);
    expect(op.v('p')).toBeCloseTo(-OPAMP_MODELS.JRC4558.ib * 1e6, 5); // −25 mV
    expect(op.v('out')).toBeCloseTo(op.v('p'), 3);
  });

  it('flows out of PNP inputs (LM358), and is negligible for FET inputs', () => {
    expect(follower({ model: 'LM358' }).op.v('p')).toBeCloseTo(45e-3, 5);
    expect(Math.abs(follower({ model: 'TL072' }).op.v('p'))).toBeLessThan(1e-4);
  });

  it('adds nothing for the ideal op-amp, and a part can set its own value', () => {
    expect(follower({ model: 'ideal' }).els).toHaveLength(2);
    expect(follower({ model: 'ideal', ib: 200e-9 }).op.v('p')).toBeCloseTo(-0.2, 5);
    expect(follower({ model: 'JRC4558', ib: 0 }).els).toHaveLength(2);
  });

  it('is a constant current: no small-signal conductance at the inputs', () => {
    const { els } = follower({ model: 'NE5532' });
    const gs = els.filter(e => e.type === 'G');
    expect(gs).toHaveLength(2);
    // Each source is controlled by its own fixed reference, never by a circuit node.
    for (const g of gs) if (g.type === 'G') { expect(g.cn).toBe(GND); expect(g.cp).toMatch(/^#ib:/); }
  });
});
