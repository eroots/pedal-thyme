import { describe, expect, it } from 'vitest';
import { BLOCKS } from '../src/builder/blocks';
import { paste } from '../src/builder/doc';
import { makeProject, parseProject } from '../src/builder/files';
import { BLOCK_KIND, blockFile, normaliseClip, parseBlockFile, type UserBlock } from '../src/builder/userblocks';

const ts = BLOCKS.find(b => b.id === 'tsclip')!.build();

describe('your own blocks', () => {
  it('a saved block is moved to the origin', () => {
    const c = normaliseClip(ts);
    const xs = [...c.parts.map(p => p.x), ...c.wires.flatMap(w => w.pts.map(p => p[0]))];
    const ys = [...c.parts.map(p => p.y), ...c.wires.flatMap(w => w.pts.map(p => p[1]))];
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeLessThan(10);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeLessThan(10);
    expect(c.parts.length).toBe(ts.parts.length);
  });

  it('a block file reads back as the same block', () => {
    const b: UserBlock = { id: 'ub1', name: 'My TS', description: 'with 1N914s', clip: normaliseClip(ts) };
    const text = blockFile(b);
    expect(JSON.parse(text).kind).toBe(BLOCK_KIND);
    const r = parseBlockFile(text, 'whatever.pfl-block.json');
    expect(r.name).toBe('My TS');
    expect(r.description).toBe('with 1N914s');
    expect(r.clip.parts.map(p => [p.kind, p.ref, p.value])).toEqual(b.clip.parts.map(p => [p.kind, p.ref, p.value]));
    expect(r.clip.wires.length).toBe(b.clip.wires.length);
    expect(r.clip.notes?.map(n => n.text)).toEqual(['in', 'out']);
  });

  it('Open reads a block file as a pedal named after the block', () => {
    const p = parseProject(blockFile({ id: 'ub1', name: 'My TS', description: '', clip: ts }));
    expect(p.name).toBe('My TS');
    expect(p.schematic.parts.length).toBe(ts.parts.length);
  });

  it('a saved pedal imports as a block named after it', () => {
    const doc = paste({ version: 1, parts: [], wires: [] }, ts, 0, 0).doc;
    const r = parseBlockFile(JSON.stringify(makeProject('Screamer', doc)), 'screamer.pfl.json');
    expect(r.name).toBe('Screamer');
    expect(r.clip.parts.length).toBe(ts.parts.length);
  });

  it('a bare schematic takes the file name', () => {
    const r = parseBlockFile(JSON.stringify({ parts: ts.parts, wires: ts.wires }), 'fuzz-core.json');
    expect(r.name).toBe('fuzz-core');
  });

  it('bad files are refused with a readable message', () => {
    expect(() => parseBlockFile('nope', 'x.json')).toThrow(/not valid JSON/);
    expect(() => parseBlockFile(JSON.stringify({ kind: BLOCK_KIND, name: 'x', schematic: { parts: [], wires: [] } }), 'x.json')).toThrow(/nothing in it/);
    expect(() => parseBlockFile(JSON.stringify({ kind: BLOCK_KIND, name: 'x' }), 'x.json')).toThrow();
  });
});
