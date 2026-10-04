import { describe, expect, it } from 'vitest';
import {
  addPart, addWire, deleteWireSegment, emptyDoc, makePart, mirrorParts, moveSelection, nearestAnchor, nearestSegment, nextRef, paste, copySelection, splitAtTaps,
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
/** Wire count after splitting at taps (what a stretch move starts from). */
const splitCount = (d: Parameters<typeof extract>[0]) => splitAtTaps(d).doc.wires.length;

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
  it('dragging a probe never pulls wires, even in stretch mode', () => {
    const d = addPart(divider(), { id: 'pr', kind: 'PROBE', ref: 'P1', x: 70, y: 0, rot: 0 }); // on R1's pin / a wire end
    const m = moveSelection(d, new Set(['pr']), new Set(), 40, -60);
    expect(m.wires).toEqual(splitAtTaps(d).doc.wires); // only split at taps, nothing moved
    expect(errorsOf(m).filter(e => !e.includes('P1'))).toEqual([]);
  });
  it('a probe sitting on a moved pin travels with it (no new wire)', () => {
    const d = addPart(divider(), { id: 'pr', kind: 'PROBE', ref: 'P1', x: 10, y: 0, rot: 0 }); // on R1 pin 1
    const m = moveSelection(d, new Set(['R1']), new Set(), 0, -40);
    const probe = m.parts.find(p => p.id === 'pr')!;
    expect([probe.x, probe.y]).toEqual([10, -40]);
    expect(m.wires.length).toBe(splitCount(d));
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

describe('text notes', () => {
  it('are added, moved, copied and deleted like other objects', async () => {
    const { addNote, moveNotes, copySelection, paste, deleteSelection, updateNote } = await import('../src/builder/doc');
    let d = emptyDoc();
    const a = addNote(d, 13, 47, 'Gain stage');
    d = a.doc;
    expect(d.notes).toEqual([{ id: a.id, x: 10, y: 50, text: 'Gain stage', anchor: 'start' }]);
    const b = addNote(d, 0, 0);
    expect(b.id).not.toBe(a.id);
    d = moveNotes(b.doc, new Set([a.id]), 30, -10);
    expect(d.notes!.find(n => n.id === a.id)).toMatchObject({ x: 40, y: 40 });
    d = updateNote(d, a.id, { text: 'Clipping' });
    expect(d.notes!.find(n => n.id === a.id)!.text).toBe('Clipping');
    const r = paste(d, copySelection(d, new Set(), new Set(), new Set([a.id])), 20, 20);
    expect(r.doc.notes).toHaveLength(3);
    expect(new Set(r.doc.notes!.map(n => n.id)).size).toBe(3);
    d = deleteSelection(r.doc, new Set(), new Set(), new Set([a.id]));
    expect(d.notes!.map(n => n.text)).toEqual(['Text', 'Clipping']);
    // Notes are not part of the circuit.
    expect(extract(d).netlist.elements).toEqual(extract(emptyDoc()).netlist.elements);
  });
});

describe('dropping a part onto a wire', () => {
  it('inserts the part: the wire under it goes, so it is in series instead of shorted', async () => {
    const { cutWiresUnder } = await import('../src/builder/doc');
    // IN —wire— OUT with a 1k load; a 10k resistor dropped onto the middle of the wire.
    let d = sch().IN(0, 0).wire([0, 0], [200, 0]).OUT(200, 0).R('RL', 200, 30, 90, 1e3).GND(200, 60).build();
    d = addPart(d, { id: 'r9', kind: 'R', ref: 'R9', x: 100, y: 0, rot: 0, value: 10e3 });
    // Before cutting, the wire shorts R9 (both pins sit on it).
    expect(errorsOf(d)).toContain('Input and output are on the same net.');
    const cut = cutWiresUnder(d, new Set(['r9']));
    expect(cut.wires.map(w => w.pts)).toEqual([[[0, 0], [70, 0]], [[130, 0], [200, 0]]]);
    expect(new Circuit(extract(cut).netlist).transfer(new Cx(0, TAU * 1000)).abs()).toBeCloseTo(1 / 11, 6);
    expect(extract(cut).issues.filter(i => i.severity === 'error')).toEqual([]);
  });

  it('leaves wires alone when only one pin touches them, and cuts only the straight run under the part', async () => {
    const { cutWiresUnder } = await import('../src/builder/doc');
    const base = sch().IN(0, 0).wire([0, 0], [200, 0], [200, 100]).OUT(200, 100).build();
    // Vertical resistor touching the wire with one pin: nothing to cut.
    const one = addPart(base, { id: 'r1', kind: 'R', ref: 'R1', x: 100, y: 30, rot: 90, value: 1e3 });
    expect(cutWiresUnder(one, new Set(['r1'])).wires).toEqual(one.wires);
    // A resistor on the vertical leg of a bent wire: only that leg is cut.
    const leg = addPart(base, { id: 'r2', kind: 'R', ref: 'R2', x: 200, y: 50, rot: 90, value: 1e3 });
    expect(cutWiresUnder(leg, new Set(['r2'])).wires.map(w => w.pts)).toEqual([[[0, 0], [200, 0], [200, 20]], [[200, 80], [200, 100]]]);
  });

  it('cuts under pots too, even where the wire under them is two wires meeting at a junction', async () => {
    const { cutWiresUnder } = await import('../src/builder/doc');
    // IN —w1— (100,0) —w2— OUT: the joint sits under the pot's body.
    const base = sch().IN(0, 0).wire([0, 0], [100, 0]).wire([100, 0], [200, 0]).OUT(200, 0).build();
    const d = addPart(base, { id: 'p1', kind: 'POT', ref: 'VR1', x: 100, y: 0, rot: 0, value: 100e3 });
    expect(cutWiresUnder(d, new Set(['p1'])).wires.map(w => w.pts)).toEqual([[[0, 0], [70, 0]], [[130, 0], [200, 0]]]);
    // Vertical pot on a vertical wire.
    const v = addPart(sch().wire([0, 0], [0, 200]).build(), { id: 'p2', kind: 'POT', ref: 'VR2', x: 0, y: 100, rot: 90, value: 100e3 });
    expect(cutWiresUnder(v, new Set(['p2'])).wires.map(w => w.pts)).toEqual([[[0, 0], [0, 70]], [[0, 130], [0, 200]]]);
    // A gap only partly covered by wire is left alone.
    const part = addPart(sch().wire([0, 0], [100, 0]).build(), { id: 'p3', kind: 'POT', ref: 'VR3', x: 100, y: 0, rot: 0, value: 100e3 });
    expect(cutWiresUnder(part, new Set(['p3'])).wires.map(w => w.pts)).toEqual([[[0, 0], [100, 0]]]);
  });
});
