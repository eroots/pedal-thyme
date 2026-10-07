import { describe, expect, it } from 'vitest';
import { parseProject } from '../src/builder/files';
import { sanitizeSchematic } from '../src/schematic/sanitize';
import { renderSchematic } from '../src/schematic/render';

const EVIL = '"><img src=x onerror=alert(1)>';

describe('schematics from files are rebuilt with checked types', () => {
  it('drops unknown fields and settings that are not one of their allowed values', () => {
    const s = sanitizeSchematic({
      parts: [{ id: 'r1', kind: 'R', x: 0, y: 0, rot: EVIL, labelSide: EVIL, value: EVIL, extra: EVIL, props: { taper: EVIL, pos: EVIL, turn: 7, sweep: 'yes', name: 'VREF' } }],
      wires: [{ id: 'w1', pts: [[0, 0], [10, 0]], color: EVIL }],
      notes: [{ id: 'n1', x: 0, y: 0, text: EVIL, anchor: EVIL }],
      script: EVIL,
    });
    expect(s).toEqual({
      version: 1,
      parts: [{ id: 'r1', kind: 'R', x: 0, y: 0, rot: 0, props: { turn: 1, name: 'VREF' } }],
      wires: [{ id: 'w1', pts: [[0, 0], [10, 0]] }],
      notes: [{ id: 'n1', x: 0, y: 0, text: EVIL }],
    });
  });

  it('refuses text where a position should be, and unknown part kinds', () => {
    expect(() => sanitizeSchematic({ parts: [], wires: [{ id: 'w', pts: [[EVIL, 0], [1, 1]] }] })).toThrow(/not a number/);
    expect(() => sanitizeSchematic({ parts: [{ id: 'x', kind: 'R', x: EVIL, y: 0, rot: 0 }], wires: [] })).toThrow(/not a number/);
    expect(() => sanitizeSchematic({ parts: [{ id: 'x', kind: 'SCRIPT', x: 0, y: 0, rot: 0 }], wires: [] })).toThrow(/Unrecognised part/);
  });

  it('a hostile project opens with all its text escaped in the drawing', () => {
    const p = parseProject(JSON.stringify({
      kind: 'pedal-filter-lab/builder-project', version: 1, name: EVIL, saved: '', view: { x: EVIL, y: 0, zoom: 1 },
      schematic: { parts: [{ id: 'r1', kind: 'R', x: 0, y: 0, rot: 0, ref: EVIL, props: { model: EVIL } }, { id: 'l', kind: 'LABEL', x: 0, y: 50, rot: 0, props: { name: EVIL } }], wires: [], notes: [{ id: 'n', x: 0, y: 0, text: EVIL, anchor: EVIL }] },
    }));
    expect(p.view).toBeUndefined();
    const svg = renderSchematic(p.schematic);
    // The text is there, but only escaped (it can't close an attribute or open a tag).
    expect(svg).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(svg).not.toContain(EVIL);
    expect(svg).not.toContain('<img');
  });
});
