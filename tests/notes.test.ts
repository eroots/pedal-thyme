import { describe, expect, it } from 'vitest';
import { renderSchematic, noteBox, noteLines } from '../src/schematic/render';
import { sanitizeSchematic } from '../src/schematic/sanitize';
import type { SchNote } from '../src/schematic/types';

// Outside the browser text is measured at 5.2 units per character.
const note = (text: string, width?: number, anchor: SchNote['anchor'] = 'start'): SchNote => ({ id: 'n1', x: 100, y: 50, text, anchor, width });

describe('text notes', () => {
  it('without a width: one line per line of text', () => {
    expect(noteLines(note('VR1 drive · VR2 tone'))).toEqual(['VR1 drive · VR2 tone']);
    expect(noteLines(note('first\nsecond'))).toEqual(['first', 'second']);
  });

  it('with a width: words wrap to fit, line breaks are kept and long words are split', () => {
    // 60 units ≈ 11 characters.
    expect(noteLines(note('the quick brown fox jumps over', 60))).toEqual(['the quick', 'brown fox', 'jumps over']);
    expect(noteLines(note('one two\nthree', 60))).toEqual(['one two', 'three']);
    expect(noteLines(note('abcdefghijklmnopqrstuvwxyz', 60))).toEqual(['abcdefghijk', 'lmnopqrstuv', 'wxyz']);
  });

  it('its box follows the width and alignment', () => {
    expect(noteBox(note('short', 80, 'start'))).toEqual({ x0: 100, w: 80 });
    expect(noteBox(note('short', 80, 'middle'))).toEqual({ x0: 60, w: 80 });
    expect(noteBox(note('short', 80, 'end'))).toEqual({ x0: 20, w: 80 });
  });

  it('draws a line of text per wrapped line', () => {
    const svg = renderSchematic({ version: 1, parts: [], wires: [], notes: [note('the quick brown fox jumps over', 60)] });
    expect(svg.match(/<text[^>]*>[^<]*<\/text>/g)!.map(t => t.replace(/<[^>]+>/g, ''))).toEqual(['the quick', 'brown fox', 'jumps over']);
  });

  it('files keep a positive width only', () => {
    const doc = (width: unknown) => sanitizeSchematic({ version: 1, parts: [], wires: [], notes: [{ id: 'n1', x: 0, y: 0, text: 'hi', width }] }).notes![0].width;
    expect(doc(120)).toBe(120);
    expect(doc(-5)).toBeUndefined();
    expect(doc('wide')).toBeUndefined();
  });
});
