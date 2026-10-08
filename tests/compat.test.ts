// Files saved by released versions must keep opening. Each release adds its own files under
// tests/fixtures/compat/<version>/ (schematics, a pedalboard, LTspice files); this test opens every one
// of them with the current code and checks it loads, has no wiring errors and simulates.
import { describe, expect, it } from 'vitest';
import { Cx } from '../src/core/complex';
import { TAU } from '../src/core/units';
import { isBoardText, parseBoard } from '../src/builder/board';
import { parseProject, type Project } from '../src/builder/files';
import { acModel } from '../src/engine/linearize';
import { importAsc } from '../src/ltspice/import';
import { extract } from '../src/schematic/extract';

const files = import.meta.glob<string>('./fixtures/compat/*/*', { query: '?raw', import: 'default', eager: true });

/** Opens, has no wiring errors, and gives a finite response at 1 kHz. */
function works(p: Project): void {
  const ex = extract(p.schematic);
  expect(ex.issues.filter(i => i.severity === 'error').map(i => i.message)).toEqual([]);
  const h = acModel(ex.netlist).circuit.solve(new Cx(0, TAU * 1000), {}).v(ex.netlist.output);
  expect(Number.isFinite(h.abs())).toBe(true);
}

describe('files saved by earlier releases still open', () => {
  const names = Object.keys(files).sort();
  it('has fixtures for at least one release', () => expect(names.length).toBeGreaterThan(0));
  for (const path of names) {
    it(path.replace('./fixtures/compat/', ''), () => {
      const text = files[path];
      if (/\.asc$/i.test(path)) {
        const r = importAsc(text);
        expect(r.stats.parts).toBeGreaterThan(0);
        expect(extract(r.schematic).issues.filter(i => i.severity === 'error')).toEqual([]);
        return;
      }
      if (isBoardText(text)) {
        const b = parseBoard(text);
        expect(b.pedals.length).toBeGreaterThan(0);
        b.pedals.forEach(p => works(p.project));
        return;
      }
      const p = parseProject(text);
      expect(p.schematic.parts.length).toBeGreaterThan(0);
      works(p);
    });
  }
});
