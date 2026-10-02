import { describe, expect, it } from 'vitest';
import {
  addPart, addWire, deleteWireSegment, emptyDoc, makePart, mirrorParts, moveSelection, nearestAnchor, nearestSegment, nextRef, paste, copySelection,
  rotateSelection, simplifyWire,
} from '../src/builder/doc';
import { sch } from '../src/schematic/build';
import { extract, pinsOf } from '../src/schematic/extract';
import type { Pt } from '../src/schematic/geometry';
import { Cx } from '../src/core/complex';
import type { Opts, Values } from '../src/core/types';
import { TAU } from '../src/core/units';
import { Circuit } from '../src/engine/mna';
import { TOPOS } from '../src/topologies';

const divider = () => sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0])
  .R('R2', 100, 30, 90, 10e3).GND(100, 60).OUT(130, 0).build();
const errorsOf = (d: Parameters<typeof extract>[0]) => extract(d).issues.map(i => i.message);

describe('wire helpers', () => {
  it('simplifies duplicate and collinear points', () => {
    expect(simplifyWire([[0, 0], [0, 0], [10, 0], [20, 0], [20, 10], [20, 20]])).toEqual([[0, 0], [20, 0], [20, 20]]);
  });
  it('drops zero-length wires', () => {
    expect(addWire(emptyDoc(), [[5, 5], [5, 5]]).wires).toHaveLength(0);
  });
  it('snaps to nearby pins first, then wire vertices and segments', () => {
    const d = divider();
    expect(nearestAnchor(d, [12, 3], 8)).toEqual({ at: [10, 0], kind: 'pin' });
    expect(nearestAnchor(d, [118, 2], 8)?.kind).toBe('wire');
    expect(nearestAnchor(d, [300, 300], 8)).toBeNull();
  });
});

describe('moving keeps wires attached', () => {
  it('moving a part along its wire keeps the circuit intact', () => {
    const d = divider(), moved = moveSelection(d, new Set(['R1']), new Set(), 0, 0);
    expect(moved).toBe(d);
    const right = moveSelection(d, new Set(['R2']), new Set(), 10, 0);
    expect(errorsOf(right)).toEqual([]);
  });
  it('moving a part sideways adds an elbow so wires stay orthogonal', () => {
    const d = divider();
    const up = moveSelection(d, new Set(['R1']), new Set(), 0, -40);
    expect(errorsOf(up)).toEqual([]);
    for (const w of up.wires) for (let i = 1; i < w.pts.length; i++) {
      const [a, b] = [w.pts[i - 1], w.pts[i]];
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    }
  });
  it('move mode detaches the part and leaves wires and markers in place', () => {
    const d = divider(), m = moveSelection(d, new Set(['R2']), new Set(), -200, 0, false);
    expect(m.wires).toEqual(d.wires);
    expect(m.parts.find(p => p.kind === 'GND')).toEqual(d.parts.find(p => p.kind === 'GND'));
    expect(m.parts.find(p => p.id === 'R2')!.x).toBe(-100);
    expect(errorsOf(m).filter(e => e.includes('R2 pin'))).toHaveLength(2);
  });
  it('stretch mode keeps the ground marker with its part', () => {
    const m = moveSelection(divider(), new Set(['R2']), new Set(), 0, 40);
    expect(m.parts.find(p => p.kind === 'GND')!.y).toBe(100);
    expect(errorsOf(m)).toEqual([]);
  });
  it('rotating a lone part re-routes its wires to the new pins', () => {
    const r = rotateSelection(divider(), new Set(['R1']), new Set());
    const pins = pinsOf(r.parts.find(p => p.id === 'R1')!).map(p => p.at);
    expect(pins).toEqual([[40, -30], [40, 30]]);
    // Each pin is still the end of some wire.
    for (const at of pins) expect(r.wires.some(w => [w.pts[0], w.pts[w.pts.length - 1]].some((e: Pt) => e[0] === at[0] && e[1] === at[1]))).toBe(true);
  });
  it('mirroring an op-amp swaps its inputs', () => {
    const d = addPart(emptyDoc(), { id: 'u', kind: 'OA', ref: 'U1', x: 200, y: 0, rot: 0, props: { model: 'ideal' } });
    const plus = (doc: typeof d) => pinsOf(doc.parts.find(p => p.id === 'u')!).find(p => p.pin === '+')!.at;
    expect(plus(d)).toEqual([160, 20]);
    expect(plus(mirrorParts(d, new Set(['u'])))).toEqual([160, -20]);
  });
});

describe('dragging any part of any Playground circuit keeps it electrically identical', () => {
  // Moves each part far away (up and to the left) and checks the extracted circuit still behaves the same.
  for (const t of TOPOS) {
    it(t.id, () => {
      const v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
      const o = Object.fromEntries((t.options || []).map(x => [x.key, x.def])) as Opts;
      const doc = t.schematic(v, o), ref = new Circuit(extract(doc).netlist).transfer(new Cx(0, TAU * 1000));
      for (const p of doc.parts.filter(q => q.kind !== 'IN' && q.kind !== 'OUT')) {
        const moved = moveSelection(doc, new Set([p.id]), new Set(), -500, -400);
        const x = extract(moved);
        expect(x.issues.filter(i => i.severity === 'error'), `${t.id}: moving ${p.ref || p.kind}`).toEqual([]);
        const h = new Circuit(x.netlist).transfer(new Cx(0, TAU * 1000));
        expect(h.sub(ref).abs() / ref.abs(), `${t.id}: moving ${p.ref || p.kind}`).toBeLessThan(1e-9);
      }
    });
  }
});

describe('delete mode', () => {
  it('deletes only the clicked segment of a wire, keeping both sides', () => {
    const d = addWire(emptyDoc(), [[0, 0], [100, 0], [100, 100], [200, 100]]);
    const id = d.wires[0].id;
    const r = deleteWireSegment(d, id, [100, 40]); // the vertical middle segment
    expect(r.wires.map(w => w.pts)).toEqual([[[0, 0], [100, 0]], [[100, 100], [200, 100]]]);
    expect(nearestSegment(d.wires[0], [180, 98])).toBe(2);
  });
  it('treats a tap as a segment boundary (only the clicked stretch goes)', () => {
    const d = divider(); // R2 taps the node wire at (100, 0); the wire runs 70 → 130
    const w = d.wires.find(x => x.pts.some(p => p[0] === 130))!;
    const r = deleteWireSegment(d, w.id, [120, 0]);
    expect(r.wires.some(x => x.pts.some(p => p[0] === 70) && x.pts.some(p => p[0] === 100))).toBe(true);
    expect(r.wires.some(x => x.pts.some(p => p[0] === 130))).toBe(false);
    expect(errorsOf(r)).toEqual(['OUT pin io is not connected.'].map(s => s.replace('OUT', 'Output jack')));
  });
  it('removing an end segment leaves the rest', () => {
    const d = addWire(emptyDoc(), [[0, 0], [100, 0], [100, 100]]);
    expect(deleteWireSegment(d, d.wires[0].id, [10, 2]).wires.map(w => w.pts)).toEqual([[[100, 0], [100, 100]]]);
  });
});

describe('placing and pasting', () => {
  it('numbers refs per prefix', () => {
    let d = emptyDoc();
    const r1 = makePart(d, 'R', 0, 100); d = addPart(d, r1);
    const r2 = makePart(d, 'R', 0, 200); d = addPart(d, r2);
    expect([r1.ref, r2.ref]).toEqual(['R1', 'R2']);
    expect(makePart(d, 'POT', 0, 0).ref).toBe('VR1');
    expect(makePart(d, 'OA', 0, 0).props?.model).toBe('TL072');
    expect(nextRef(d, 'R')).toBe('R3');
  });
  it('pasting renumbers clashing refs and skips duplicate jacks', () => {
    const d = divider();
    const clip = copySelection(d, new Set(['R1', 'R2', d.parts.find(p => p.kind === 'IN')!.id]), new Set(['w2']));
    const r = paste(d, clip, 200, 0);
    const refs = r.doc.parts.map(p => p.ref).filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length);
    expect(r.doc.parts.filter(p => p.kind === 'IN')).toHaveLength(1);
    expect(r.doc.wires).toHaveLength(d.wires.length + 1);
  });
});
