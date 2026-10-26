import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import type { Opts, Values } from '../src/core/types';
import { TAU } from '../src/core/units';
import { Circuit } from '../src/engine/mna';
import { sch } from '../src/schematic/build';
import { extract } from '../src/schematic/extract';
import { toWorld } from '../src/schematic/geometry';
import { renderSchematic } from '../src/schematic/render';
import { TOPOS } from '../src/topologies';

const s = (f: number) => new Cx(0, TAU * f);
const gain = (x: ReturnType<typeof extract>, f = 1000) => new Circuit(x.netlist).transfer(s(f)).abs();
const messages = (x: ReturnType<typeof extract>) => x.issues.map(i => `${i.severity}: ${i.message}`);

describe('geometry', () => {
  it('rotates clockwise and mirrors before rotating', () => {
    const p = { x: 100, y: 50 };
    expect(toWorld({ ...p, rot: 0 }, [-30, 0])).toEqual([70, 50]);
    expect(toWorld({ ...p, rot: 90 }, [-30, 0])).toEqual([100, 20]);
    expect(toWorld({ ...p, rot: 180 }, [-30, 0])).toEqual([130, 50]);
    expect(toWorld({ ...p, rot: 270 }, [-30, 0])).toEqual([100, 80]);
    expect(toWorld({ ...p, rot: 0, mirror: true }, [0, -30])).toEqual([100, 80]);
    expect(toWorld({ ...p, rot: 90, mirror: true }, [0, -30])).toEqual([70, 50]);
  });
});

describe('connectivity', () => {
  // IN — R1 — node — R2 — GND, OUT at node: a 50% divider.
  const divider = () => sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0])
    .R('R2', 100, 30, 90, 10e3).GND(100, 60).OUT(130, 0);

  it('pins on a wire, wire ends on pins and ground symbols connect', () => {
    const x = extract(divider().build());
    expect(x.issues).toEqual([]);
    expect(gain(x)).toBeCloseTo(0.5, 9);
  });

  it('wires that cross without an end at the crossing do not connect', () => {
    // A vertical wire crossing the node wire mid-segment, tied to a second ground-referenced resistor.
    const x = extract(divider().wire([90, -40], [90, 40]).R('R3', 90, 70, 90, 1).GND(90, 100).build());
    expect(gain(x)).toBeCloseTo(0.5, 9); // R3 (1 Ω to ground) would kill the signal if it connected
    expect(messages(x).some(m => m.includes('Wire end is not connected'))).toBe(true);
  });

  it('a wire end on another wire forms a T-junction', () => {
    const x = extract(divider().wire([120, 0], [120, 40]).R('R3', 120, 70, 90, 10e3).GND(120, 100).build());
    expect(gain(x)).toBeCloseTo(1 / 3, 9);
  });

  it('net labels with the same name join nets', () => {
    const b = sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3)
      .part('LABEL', undefined, 70, 0, 0, undefined, { props: { name: 'MID' } })
      .part('LABEL', undefined, 200, 0, 0, undefined, { props: { name: 'MID' } })
      .wire([200, 0], [200, 30]).R('R2', 200, 60, 90, 10e3).GND(200, 90)
      .wire([200, 0], [260, 0]).OUT(260, 0);
    const x = extract(b.build());
    expect(x.issues).toEqual([]);
    expect(gain(x)).toBeCloseTo(0.5, 9);
    expect(x.nets.has('out')).toBe(true);
  });
});

describe('electrical rule check', () => {
  it('requires exactly one input and one output', () => {
    const x = extract(sch().R('R1', 0, 0, 0, 1e3).build());
    expect(messages(x)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^error: No input jack/), expect.stringMatching(/^error: No output jack/),
    ]));
  });
  it('flags unconnected pins', () => {
    const x = extract(sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 1e3).R('R9', 40, 100, 0, 1e3).OUT(70, 0).build());
    expect(messages(x).filter(m => m.includes('R9 pin'))).toHaveLength(2);
  });
  it('flags nets with no DC path to ground', () => {
    // IN — C1 — node — C2 — GND: the middle node only sees capacitors.
    const x = extract(sch().IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 1e-8).wire([70, 0], [130, 0])
      .C('C2', 100, 30, 90, 1e-8).GND(100, 60).OUT(130, 0).build());
    expect(messages(x)).toEqual([expect.stringMatching(/^warning: Net out \(C1, C2\) has no DC path/)]);
  });
  it('flags a supply shorted to ground and bad values', () => {
    const x = extract(divider2().part('SUPPLY', undefined, 300, 0, 0, 9).wire([300, 0], [300, 40]).GND(300, 40)
      .R('R5', 300, 100, 0, -5).build());
    expect(messages(x)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^error: Supply .*shorted to ground/), expect.stringMatching(/^error: R5 needs a valid value/),
    ]));
  });
  it('flags input shorted to output', () => {
    const x = extract(sch().IN(0, 0).wire([0, 0], [50, 0]).OUT(50, 0).build());
    expect(messages(x)).toContain('error: Input and output are on the same net.');
  });
});
const divider2 = () => sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0])
  .R('R2', 100, 30, 90, 10e3).GND(100, 60).OUT(130, 0);

describe('rendering', () => {
  it('draws parts with refs, a junction dot at a T, and a finite viewBox', () => {
    const svg = renderSchematic(sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0])
      .R('R2', 100, 30, 90, 10e3).GND(100, 60).OUT(130, 0).build());
    expect(svg).toContain('data-part="R1"');
    expect(svg).toContain('10 kΩ');
    expect((svg.match(/class="dot"/g) || []).length).toBe(1); // only the R2 tap at (100, 0)
    const vb = svg.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
    expect(vb.every(Number.isFinite)).toBe(true);
    expect(vb[2]).toBeGreaterThan(130);
  });
});

describe('net labels', () => {
  it('put the name above the label line, and the line fits the name', () => {
    const doc = sch().part('LABEL', undefined, 100, 50, 0, undefined, { props: { name: 'VREF' } }).build();
    const svg = renderSchematic(doc);
    const y = Number(svg.match(/<text class="pn" x="[^"]+" y="([^"]+)"[^>]*>VREF</)![1]);
    expect(y).toBeLessThan(50 - 3); // baseline above the line at y = 50
    const lineEnd = Number(svg.match(/<line x1="0" y1="0" x2="([^"]+)" y2="0"\/>/)![1]);
    expect(lineEnd).toBeGreaterThanOrEqual(4 * 6.5);
  });
});

describe('Playground schematics', () => {
  const variants: Record<string, Opts[]> = {
    'rc2-lp': [{ buf: false }, { buf: true }], 'rc2-hp': [{ buf: false }, { buf: true }], 'bp': [{ buf: false }, { buf: true }],
  };
  for (const t of TOPOS) {
    it(`${t.id} passes the electrical rule check and every part is drawn`, () => {
      const v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
      const o = Object.fromEntries((t.options || []).map(x => [x.key, x.def])) as Opts;
      for (const oo of variants[t.id] || [{}]) {
        const doc = t.schematic(v, { ...o, ...oo });
        expect(messages(extract(doc))).toEqual([]);
        const svg = renderSchematic(doc);
        for (const p of t.parts) expect(svg).toContain(`data-part="${p.key}"`);
      }
    });
  }
});

describe('supplies', () => {
  it('several symbols for one supply are one source (the same 9V placed in several spots)', () => {
    // IN → R1 → OUT, with R2 from a 9V symbol to OUT and a second 9V symbol elsewhere (joined by name).
    const d = sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0]).OUT(130, 0)
      .R('R2', 100, 30, 90, 10e3).wire([100, 0], [100, 0])
      .part('SUPPLY', undefined, 100, 60, 180, 9, { props: { name: '9V' } })
      .part('SUPPLY', undefined, 300, 0, 0, 9, { props: { name: '9V' } })
      .build();
    const ex = extract(d);
    expect(ex.netlist.elements.filter(e => e.type === 'V')).toHaveLength(1);
    expect(ex.issues.filter(i => i.severity === 'error')).toEqual([]);
  });

  it('a closed switch with both ends on one net is left out (it does nothing)', () => {
    const d = sch().IN(0, 0).wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 10e3).wire([70, 0], [130, 0]).OUT(130, 0)
      .part('SW', 'S1', 200, 0, 0, undefined, { props: { closed: true } }).GND(170, 0).GND(230, 0).build();
    const ex = extract(d);
    expect(ex.netlist.elements.some(e => e.type === 'SW')).toBe(false);
    expect(Number.isFinite(new Circuit(ex.netlist).solve(new Cx(0, TAU * 1000), {}).v('out').abs())).toBe(true);
  });
});
