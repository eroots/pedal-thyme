import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../src/builder/templates';
import { toWorld } from '../src/schematic/geometry';
import { boxOf } from '../src/schematic/library';
import { renderSchematicBody } from '../src/schematic/render';

type Box = [number, number, number, number];
const hit = (a: Box, b: Box, m = 0) => a[0] < b[2] - m && b[0] < a[2] - m && a[1] < b[3] - m && b[1] < a[3] - m;

/** Each part's labels (estimated like the renderer: 6.5 units a character, 13 high), by part. */
function labels(body: string): { owner: string; s: string; box: Box }[] {
  const out: { owner: string; s: string; box: Box }[] = [];
  for (const chunk of body.split('<g class="comp').slice(1)) {
    const owner = /data-id="([^"]+)"/.exec(chunk)![1], own = chunk.split(/<circle class="dot"|<text class="tiny"/)[0];
    for (const m of own.matchAll(/<text class="[^"]+" x="([-\d.]+)" y="([-\d.]+)" text-anchor="(\w+)">([^<]*)<\/text>/g)) {
      const x = +m[1], y = +m[2], w = m[4].length * 6.5, x0 = m[3] === 'start' ? x : m[3] === 'end' ? x - w : x - w / 2;
      out.push({ owner, s: m[4], box: [x0, y - 10, x0 + w, y + 3] });
    }
  }
  return out;
}

describe('template layouts', () => {
  for (const t of TEMPLATES.filter(x => x.id !== 'empty')) {
    it(`${t.name}: no label overlaps another label, a part or a wire`, () => {
      const doc = t.build(), texts = labels(renderSchematicBody(doc).body);
      const parts = doc.parts.filter(p => !['GND', 'LABEL', 'SUPPLY', 'IN', 'OUT'].includes(p.kind)).map(p => {
        const [a, b, c, d] = boxOf(p), q = [toWorld(p, [a, b]), toWorld(p, [c, d])];
        return { id: p.id, ref: p.ref, box: [Math.min(q[0][0], q[1][0]), Math.min(q[0][1], q[1][1]), Math.max(q[0][0], q[1][0]), Math.max(q[0][1], q[1][1])] as Box };
      });
      const issues: string[] = [];
      texts.forEach((a, i) => texts.slice(i + 1).forEach(b => { if (a.owner !== b.owner && hit(a.box, b.box, 1)) issues.push(`"${a.s}" × "${b.s}"`); }));
      for (const a of texts) {
        for (const p of parts) if (p.id !== a.owner && hit(a.box, p.box, 2)) issues.push(`"${a.s}" × ${p.ref}`);
        for (const w of doc.wires) for (let i = 1; i < w.pts.length; i++) {
          const [p, q] = [w.pts[i - 1], w.pts[i]];
          if (hit(a.box, [Math.min(p[0], q[0]) - 0.5, Math.min(p[1], q[1]) - 0.5, Math.max(p[0], q[0]) + 0.5, Math.max(p[1], q[1]) + 0.5], 1)) { issues.push(`"${a.s}" × wire ${w.id}`); break; }
        }
      }
      expect(issues).toEqual([]);
    });
  }

  it('every template knob has a name', () => {
    for (const t of TEMPLATES) {
      for (const p of t.build().parts.filter(q => q.kind === 'POT' || q.kind === 'RHEO')) expect(p.props?.knob, `${t.id} ${p.ref}`).toBeTruthy();
    }
  });
});
