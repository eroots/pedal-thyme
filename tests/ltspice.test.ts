import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import type { Opts, Values } from '../src/core/types';
import { TEMPLATES } from '../src/builder/templates';
import { acModel } from '../src/engine/linearize';
import { decodeLtspice, evalValue, ltNets, ltTransform, parseAsc, readParams, spiceNumber } from '../src/ltspice/asc';
import { exportAsc } from '../src/ltspice/export';
import { importAsc } from '../src/ltspice/import';
import { extract } from '../src/schematic/extract';
import type { Schematic } from '../src/schematic/types';
import { TOPOS } from '../src/topologies';

const freqs = [20, 200, 1000, 5000, 20000];
const response = (doc: Schematic) => {
  const ex = extract(doc);
  const c = acModel(ex.netlist).circuit;
  return freqs.map(f => c.transfer(new Cx(0, TAU * f)));
};
const errors = (doc: Schematic) => extract(doc).issues.filter(i => i.severity === 'error').map(i => i.message);

describe('LTspice file basics', () => {
  it('decodes UTF-16LE, UTF-8 and Latin-1 files', () => {
    const text = 'Version 4\nSYMATTR Value 4.7µ\n';
    const u16 = new Uint8Array([0xff, 0xfe, ...[...text].flatMap(c => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
    expect(decodeLtspice(u16)).toBe(text);
    expect(decodeLtspice(new TextEncoder().encode(text))).toBe(text);
    expect(decodeLtspice(new Uint8Array([...'C 4.7'].map(c => c.charCodeAt(0)).concat([0xb5])))).toBe('C 4.7µ');
  });
  it('reads SPICE numbers and .param expressions', () => {
    expect(spiceNumber('10k')).toBe(10e3);
    expect(spiceNumber('1Meg')).toBe(1e6);
    expect(spiceNumber('1m')).toBeCloseTo(1e-3, 15);
    expect(spiceNumber('4.7µF')).toBeCloseTo(4.7e-6, 15);
    expect(spiceNumber('100nF')).toBeCloseTo(100e-9, 18);
    const params = readParams(parseAsc('TEXT 0 0 Left 2 !.param Rtot=100k pos=0.25\nTEXT 0 0 Left 2 !.param Ra={Rtot*pos} f0=1e3\n').texts);
    expect(evalValue('{Ra}', params)).toBeCloseTo(25e3, 9);
    expect(evalValue('{Rtot*(1-pos)+1k}', params)).toBeCloseTo(76e3, 9);
    expect(evalValue('{1/(2*pi*f0*10n)}', params)).toBeCloseTo(1 / (2 * Math.PI * 1e3 * 10e-9), 6);
    expect(evalValue('{nope}', params)).toBeNull();
  });
  it('places pins like LTspice (rotation clockwise; mirrored = rotated, then x flipped)', () => {
    // From a real LTspice file: res at (464,48) R90 meets a wire at (368,64); cap at (512,48) R90 meets one at (512,64).
    const at = (x: number, y: number, o: string, p: [number, number]) => { const t = ltTransform(o, p); return [x + t[0], y + t[1]]; };
    expect(at(464, 48, 'R90', [16, 96])).toEqual([368, 64]);
    expect(at(512, 48, 'R90', [16, 0])).toEqual([512, 64]);
    expect(at(0, 0, 'M0', [16, 0])).toEqual([-16, 0]);
    // Measured with LTspice's netlister on an nmos4 (D at (48,0), G at (0,80)):
    expect(at(0, 0, 'M90', [48, 0])).toEqual([0, 48]);
    expect(at(0, 0, 'M90', [0, 80])).toEqual([80, 0]);
    expect(at(0, 0, 'M270', [0, 80]).map(v => v + 0)).toEqual([-80, 0]);
    expect(at(0, 0, 'M180', [48, 96]).map(v => v + 0)).toEqual([48, -96]);
  });
  it("follows LTspice's netlister: a part cuts the wire under it, pins on a wire connect", () => {
    // Measured with LTspice 24: a wire from (0,−64) to (0,160) with a resistor whose pins sit at (0,16) and
    // (0,96) on it netlists as "R1 top bot" — the resistor is in series, not shorted by the wire.
    const n = ltNets([[[0, -64], [0, 160]]], [{ at: [0, -64], name: 'top' }, { at: [0, 160], name: 'bot' }], [[[0, 16], [0, 96]]]);
    expect(n.netOf([0, 16])).toBe(n.netOf([0, -64]));
    expect(n.netOf([0, 96])).toBe(n.netOf([0, 160]));
    expect(n.netOf([0, 16])).not.toBe(n.netOf([0, 96]));
    // A jumper is a short.
    const j = ltNets([], [], [[[0, 0]], [[64, 0]]], [[[0, 0], [64, 0]]]);
    expect(j.netOf([0, 0])).toBe(j.netOf([64, 0]));
  });
  it('joins nets through wires, T-junctions and same-named flags', () => {
    const n = ltNets([[[0, 0], [100, 0]], [[50, 0], [50, 80]], [[200, 0], [300, 0]]], [{ at: [100, 0], name: 'A' }, { at: [300, 0], name: 'A' }, { at: [50, 80], name: '0' }], [[0, 0]]);
    expect(n.netOf([50, 80])).toBe(n.netOf([0, 0]));
    expect(n.netOf([200, 0])).toBe(n.netOf([0, 0]));
  });
});

// A hand-written LTspice RC low-pass with a 9 V rail, a source, ground flags and an OUT flag.
const RC_ASC = `Version 4
SHEET 1 880 680
WIRE 96 64 32 64
WIRE 224 64 176 64
WIRE 304 64 224 64
WIRE 224 96 224 64
WIRE 32 96 32 64
FLAG 32 176 0
FLAG 224 160 0
FLAG 304 64 out
SYMBOL voltage 32 80 R0
SYMATTR InstName V1
SYMATTR Value SINE(0 1 1k)
SYMATTR Value2 AC 1
SYMBOL res 192 48 R90
SYMATTR InstName R1
SYMATTR Value {Rv}
SYMBOL cap 208 96 R0
SYMATTR InstName C1
SYMATTR Value 15.9n
TEXT 0 240 Left 2 !.param Rv=10k
TEXT 0 270 Left 2 ;A plain RC low-pass
TEXT 0 300 Left 2 !.ac dec 100 10 100k
`;

describe('LTspice import', () => {
  it('imports an RC low-pass with its source, ground and output', () => {
    const r = importAsc(RC_ASC);
    expect(errors(r.schematic)).toEqual([]);
    expect(r.report.filter(x => x.startsWith('Check'))).toEqual([]);
    const R1 = r.schematic.parts.find(p => p.ref === 'R1')!, C1 = r.schematic.parts.find(p => p.ref === 'C1')!;
    expect(R1.value).toBe(10e3);
    expect(C1.value).toBeCloseTo(15.9e-9, 18);
    expect(r.schematic.parts.filter(p => p.kind === 'IN')).toHaveLength(1);
    expect(r.schematic.parts.filter(p => p.kind === 'OUT')).toHaveLength(1);
    expect(r.schematic.notes?.[0].text).toBe('A plain RC low-pass');
    // −3 dB near 1 kHz.
    const h = acModel(extract(r.schematic).netlist).circuit.transfer(new Cx(0, TAU * 1000));
    expect(h.abs()).toBeCloseTo(Math.SQRT1_2, 2);
  });
  it('turns a grounded DC source into a supply rail and maps models with substitutions noted', () => {
    const asc = `Version 4
SHEET 1 880 680
WIRE 0 0 0 -32
WIRE 0 -32 64 -32
FLAG 0 80 0
FLAG 64 160 0
SYMBOL voltage 0 -16 R0
SYMATTR InstName V2
SYMATTR Value 9
SYMBOL npn 0 64 R0
SYMATTR InstName Q1
SYMATTR Value 2N5089
SYMBOL res 48 -48 R0
SYMATTR InstName R1
SYMATTR Value 10k
`;
    const r = importAsc(asc);
    const rail = r.schematic.parts.find(p => p.kind === 'SUPPLY')!;
    expect(rail.value).toBe(9);
    const q = r.schematic.parts.find(p => p.ref === 'Q1')!;
    expect(q.kind).toBe('NPN');
    expect(q.props?.model).toBe('2N3904');
    expect(r.report.some(x => /2N5089/.test(x))).toBe(true);
  });
  it('maps a pot from its .asy symbol file', () => {
    const asy = `Version 4
SymbolType CELL
SYMATTR Prefix X
PIN 0 0 NONE 0
PINATTR PinName 1
PINATTR SpiceOrder 1
PIN 32 48 NONE 0
PINATTR PinName W
PINATTR SpiceOrder 2
PIN 0 96 NONE 0
PINATTR PinName 3
PINATTR SpiceOrder 3
`;
    const asc = `Version 4
SHEET 1 880 680
FLAG 0 96 0
SYMBOL potentiometer 0 0 R0
SYMATTR InstName VR1
SYMATTR Value R=100k T=0.3
`;
    expect(importAsc(asc).report.some(x => /Skipped VR1/.test(x))).toBe(true);
    const r = importAsc(asc, { 'potentiometer.asy': asy });
    const pot = r.schematic.parts.find(p => p.ref === 'VR1')!;
    expect(pot.kind).toBe('POT');
    expect(pot.value).toBe(100e3);
    expect(pot.props?.turn).toBeCloseTo(0.3, 9);
  });
});

describe('LTspice export → import round trip keeps every circuit identical', () => {
  const cases: [string, () => Schematic][] = [
    ...TEMPLATES.filter(t => t.id !== 'empty').map(t => [`template ${t.id}`, t.build] as [string, () => Schematic]),
    ...TOPOS.map(t => [`playground ${t.id}`, () => {
      const v = Object.fromEntries(t.parts.map(p => [p.key, p.def])) as Values;
      const o = Object.fromEntries((t.options || []).map(x => [x.key, x.def])) as Opts;
      return t.schematic(v, o);
    }] as [string, () => Schematic]),
  ];
  for (const [name, build] of cases) {
    it(name, () => {
      const doc = build();
      const asc = exportAsc(doc, { title: name });
      expect(asc).toMatch(/^Version 4\n/);
      const r = importAsc(asc);
      expect(r.report.filter(x => x.startsWith('Check') || x.startsWith('Skipped'))).toEqual([]);
      expect(errors(r.schematic)).toEqual([]);
      const a = response(doc), b = response(r.schematic);
      a.forEach((h, i) => expect(b[i].sub(h).abs() / Math.max(h.abs(), 1e-9)).toBeLessThan(1e-4)); // values are written with 6 significant digits
    });
  }
});

describe('LTspice text', () => {
  it('imports comments as movable notes, but no directives (even commented-out ones)', () => {
    const asc = `Version 4
SHEET 1 880 680
TEXT 0 0 Left 2 !.step param R 1k 10k 1k
TEXT 0 64 Left 2 ;.ac dec 100 10 100k
TEXT 0 128 Left 2 ;Tone stack\\n;.param x=1\\nBass boost
TEXT 0 192 Left 2 !.param R=1k\\n.tran 10m
`;
    const r = importAsc(asc);
    expect(r.schematic.notes?.map(n => n.text)).toEqual(['Tone stack', 'Bass boost']);
    expect(r.schematic.notes?.every(n => n.id.startsWith('note'))).toBe(true);
  });
});
