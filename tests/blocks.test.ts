import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import { BLOCKS } from '../src/builder/blocks';
import { paste } from '../src/builder/doc';
import { dcOp } from '../src/engine/dc';
import { acModel } from '../src/engine/linearize';
import { extract } from '../src/schematic/extract';
import type { Schematic } from '../src/schematic/types';

const block = (id: string) => BLOCKS.find(b => b.id === id)!.build();

/** A block between an input and an output jack (on its "in" and "out" ends), with the bias supply below it. */
function inCircuit(id: string): Schematic {
  const clip = block(id);
  const end = (label: string) => clip.notes!.find(n => n.text === label)!;
  const i = end('in'), o = end('out');
  let d: Schematic = {
    version: 1, wires: [],
    parts: [{ id: 'in', kind: 'IN', x: i.x + 4, y: i.y + 6, rot: 0 }, { id: 'out', kind: 'OUT', x: o.x - 4, y: o.y + 6, rot: 0 }],
  };
  d = paste(d, clip, 0, 0).doc;
  return paste(d, block('bias'), 0, 1000).doc;
}

describe('circuit blocks', () => {
  it('the bias supply makes VREF at half of 9 V', () => {
    const d = paste({ version: 1, parts: [], wires: [] }, block('bias'), 0, 0).doc;
    // On its own it has no jacks: give the solver a stand-in input node.
    expect(dcOp({ ...extract(d).netlist, input: 'x', output: 'x' }).v('VREF')).toBeCloseTo(4.5, 3);
  });

  for (const b of BLOCKS.filter(x => x.id !== 'bias')) {
    it(`${b.name}: wires up cleanly, biases and passes signal`, () => {
      const ex = extract(inCircuit(b.id));
      expect(ex.issues.map(x => x.message)).toEqual([]);
      expect(dcOp(ex.netlist).ok).toBe(true);
      const h = acModel(ex.netlist).circuit.solve(new Cx(0, TAU * 1000), {}).v(ex.netlist.output).abs();
      expect(h).toBeGreaterThan(b.id === 'tstone' ? 0.05 : 0.5); // buffers ≈ 1, the TS stage gains, tone and volume cut
    });
  }

  it('dropping a block renumbers refs that are already taken', () => {
    let d = inCircuit('tsclip');
    d = paste(d, block('tsclip'), 0, 500).doc;
    const refs = d.parts.map(p => p.ref).filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
