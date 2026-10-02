import { describe, expect, it } from 'vitest';
import { bomCsv, bomRows, makeProject, parseProject, projectSpice, schematicSvg } from '../src/builder/files';
import { simulate } from '../src/builder/sim';
import { TEMPLATES } from '../src/builder/templates';
import { extract } from '../src/schematic/extract';
import { TOPOS } from '../src/topologies';

const ts = () => TEMPLATES.find(t => t.id === 'ts')!.build();

describe('templates', () => {
  for (const t of TEMPLATES.filter(x => x.id !== 'empty')) {
    it(`${t.id} passes the electrical rule check`, () => {
      expect(extract(t.build()).issues.map(i => i.message)).toEqual([]);
    });
  }
  it('the TS-style pedal has a mid hump and real gain', () => {
    const freqs = [50, 200, 720, 2000, 8000];
    const { out } = simulate(extract(ts()), [], freqs);
    const peak = Math.max(...out.mag);
    expect(peak).toBeGreaterThan(5); // after the volume pot at 7/10
    expect(out.mag[0]).toBeLessThan(peak - 6); // bass cut by Rg·Cg and the input/coupling caps
    // Turning the tone knob down cuts treble.
    const dark = ts();
    dark.parts = dark.parts.map(p => (p.id === 'VR2' ? { ...p, props: { ...p.props, turn: 0 } } : p));
    const d = simulate(extract(dark), [], freqs).out;
    expect(out.mag[4] - d.mag[4]).toBeGreaterThan(6);
    expect(Math.abs(out.mag[1] - d.mag[1])).toBeLessThan(1.5);
  });
  it('the RAT-style pedal has lots of gain', () => {
    const { out } = simulate(extract(TEMPLATES.find(t => t.id === 'rat')!.build()), [], [1000]);
    expect(out.mag[0]).toBeGreaterThan(20);
  });
});

describe('projects', () => {
  it('round-trip through JSON', () => {
    const p = makeProject('My TS', ts(), { term: { src: { on: true, preset: 'single', R: 6e3, L: 2.5, C: 470e-12 }, load: { on: false, preset: 'pedal', R: 1e6, C: 0 } }, sweep: 'turn:VR1' });
    const back = parseProject(JSON.stringify(p));
    expect(back.name).toBe('My TS');
    expect(back.schematic).toEqual(p.schematic);
    expect(back.sim?.sweep).toBe('turn:VR1');
  });
  it('accept a bare schematic', () => {
    expect(parseProject(JSON.stringify(ts())).schematic.parts.length).toBe(ts().parts.length);
  });
  it('reject junk with a readable message', () => {
    expect(() => parseProject('nope')).toThrow(/not valid JSON/);
    expect(() => parseProject('{"a":1}')).toThrow(/doesn’t contain a pedal schematic/);
    expect(() => parseProject('{"version":1,"parts":[{"id":"x","kind":"TRANSISTOR","x":0,"y":0}],"wires":[]}')).toThrow(/Unrecognised part/);
  });
});

describe('exports', () => {
  it('parts list groups identical parts with natural ref order', () => {
    const rows = bomRows(ts());
    const r10k = rows.find(r => r.part === 'Resistor' && r.value === '10 kΩ')!;
    expect(r10k.refs).toEqual(['R2', 'R5', 'R6', 'R7']);
    expect(rows.find(r => r.part === 'Op-amp')!.qty).toBe(2);
    expect(rows.find(r => r.part === 'Diode')!.refs).toEqual(['D1', 'D2']);
    expect(rows.some(r => /Ground|label|jack|Probe/i.test(r.part))).toBe(false);
    const csv = bomCsv('My TS', ts());
    expect(csv.startsWith('﻿# My TS\nQty,References,Part,Value,Notes\n')).toBe(true);
  });
  it('SPICE export includes the supply, models and knob settings', () => {
    const text = projectSpice('My TS', ts(), null, 20, 20000);
    expect(text).toMatch(/^V\w+ 9V 0 DC 9$/m); // the 9 V rail
    expect(text).toContain('.subckt OPAMP_JRC4558');
    expect(text).toContain('.model 1N914');
    expect(text).toMatch(/\* Knobs: VR1 5\.0\/10, VR2 5\.0\/10, VR3 7\.0\/10/);
  });
  it('SVG export is standalone with embedded styles', () => {
    const { svg, width } = schematicSvg('Test', TOPOS[0].schematic({ R: 1e4, C: 1e-8 }, {}));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<style>');
    expect(width).toBeGreaterThan(100);
  });
});
