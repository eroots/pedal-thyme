import { describe, expect, it } from 'vitest';
import { HOP_R, hopPath, renderSchematicBody, wireHops } from '../src/schematic/render';
import type { SchWire } from '../src/schematic/types';

const w = (id: string, ...pts: [number, number][]): SchWire => ({ id, pts });

describe('wire hops', () => {
  it('a horizontal wire hops over a vertical one it crosses', () => {
    const h = wireHops([w('h', [0, 50], [100, 50]), w('v', [40, 0], [40, 100])]);
    expect(h.get('h')).toEqual([{ seg: 1, at: [40, 50] }]);
    expect(h.has('v')).toBe(false);
    const d = hopPath([[0, 50], [100, 50]], h.get('h')!);
    expect(d).toBe(`M0,50 L${40 - HOP_R},50 A${HOP_R},${HOP_R} 0 0 1 ${40 + HOP_R},50 L100,50`);
  });

  it('a hop bulges upwards whichever way the wire runs', () => {
    expect(hopPath([[100, 50], [0, 50]], [{ seg: 1, at: [40, 50] }])).toContain(`A${HOP_R},${HOP_R} 0 0 0 ${40 - HOP_R},50`);
  });

  it('no hop where wires connect: a T-junction or a wire ending on another', () => {
    expect(wireHops([w('h', [0, 50], [100, 50]), w('v', [40, 50], [40, 100])]).size).toBe(0);
    expect(wireHops([w('h', [40, 50], [100, 50]), w('v', [40, 0], [40, 100])]).size).toBe(0);
    expect(wireHops([w('h', [0, 50], [100, 50]), w('v', [100, 0], [100, 100])]).size).toBe(0);
  });

  it('a wire with corners hops on its horizontal runs, including over itself', () => {
    // Right, down, left, then up across its own first run.
    const loop = w('l', [0, 50], [100, 50], [100, 80], [60, 80], [60, 20]);
    expect(wireHops([loop]).get('l')).toEqual([{ seg: 1, at: [60, 50] }]);
  });

  it('crossings closer than a hop share one', () => {
    const d = hopPath([[0, 50], [100, 50]], [{ seg: 1, at: [40, 50] }, { seg: 1, at: [45, 50] }]);
    expect(d.match(/A/g)?.length).toBe(1);
    expect(d).toContain(`L${40 - HOP_R},50 A`);
    expect(d).toContain(` ${45 + HOP_R},50 L100,50`);
  });

  it('the rendered drawing draws a hopped wire as a path, others as polylines', () => {
    const body = renderSchematicBody({ version: 1, parts: [], wires: [w('h', [0, 50], [100, 50]), w('v', [40, 0], [40, 100])] }).body;
    expect(body).toMatch(/<path class="wire" data-wire="h" d="M0,50/);
    expect(body).toMatch(/<polyline class="wire" data-wire="v"/);
  });
});
