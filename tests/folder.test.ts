import { describe, expect, it } from 'vitest';
import { ProjectFolder, isSchematic, writeHandle } from '../src/builder/folder';

/** An in-memory stand-in for a FileSystemDirectoryHandle (the browser API can't run in tests). */
function fakeDir(name: string, files: Record<string, string>, permission: PermissionState = 'granted') {
  const store = new Map(Object.entries(files));
  let perm = permission;
  const fileHandle = (n: string) => ({
    kind: 'file' as const, name: n,
    getFile: async () => new File([store.get(n) ?? ''], n),
    createWritable: async () => { let buf = ''; return { write: async (d: string) => { buf += d; }, close: async () => { store.set(n, buf); } }; },
    queryPermission: async () => perm, requestPermission: async () => (perm = 'granted'),
  });
  const dir = {
    kind: 'directory' as const, name,
    async *values() { for (const n of store.keys()) yield fileHandle(n); },
    getFileHandle: async (n: string, o?: { create?: boolean }) => {
      if (!store.has(n) && !o?.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      if (!store.has(n)) store.set(n, '');
      return fileHandle(n);
    },
    queryPermission: async () => perm, requestPermission: async () => (perm = 'granted'),
  };
  return { dir: dir as unknown as FileSystemDirectoryHandle, store };
}

describe('project folder', () => {
  it('recognises schematic files', () => {
    expect(['a.pfl.json', 'b.json', 'c.asc', 'C.ASC'].every(isSchematic)).toBe(true);
    expect(['d.asy', 'e.txt', 'f.raw'].some(isSchematic)).toBe(false);
  });

  it('lists schematics (natural order) and symbol files separately', async () => {
    const { dir } = fakeDir('Pedals', { 'Fuzz 10.pfl.json': '{}', 'Fuzz 2.pfl.json': '{}', 'Benson.asc': '', 'pot.asy': '', 'notes.txt': '' });
    const f = new ProjectFolder();
    f.dir = dir;
    const { schematics, symbols } = await f.list();
    expect(schematics.map(e => e.name)).toEqual(['Benson.asc', 'Fuzz 2.pfl.json', 'Fuzz 10.pfl.json']);
    expect(symbols.map(e => e.name)).toEqual(['pot.asy']);
    expect(f.name).toBe('Pedals');
  });

  it('writes new files and overwrites existing ones', async () => {
    const { dir, store } = fakeDir('Pedals', { 'old.pfl.json': 'v1' });
    const f = new ProjectFolder();
    f.dir = dir;
    expect(await f.has('old.pfl.json')).toBe(true);
    expect(await f.has('new.pfl.json')).toBe(false);
    const h = await f.write('new.pfl.json', '{"a":1}');
    expect(store.get('new.pfl.json')).toBe('{"a":1}');
    await writeHandle(h, '{"a":2}');
    expect(store.get('new.pfl.json')).toBe('{"a":2}');
  });

  it('waits for permission before listing a remembered folder', async () => {
    const { dir } = fakeDir('Pedals', { 'x.pfl.json': '{}' }, 'prompt');
    const f = new ProjectFolder();
    f.dir = dir;
    expect(await f.needsPermission()).toBe(true);
    expect((await f.list(false)).schematics).toEqual([]);
    expect((await f.list(true)).schematics.map(e => e.name)).toEqual(['x.pfl.json']);
    expect(await f.needsPermission()).toBe(false);
  });

  it('falls back to a read-only list of picked files', async () => {
    const f = new ProjectFolder();
    const file = (n: string) => Object.assign(new File(['{}'], n), { webkitRelativePath: `My pedals/${n}` });
    f.useFiles([file('a.pfl.json'), file('b.asc'), file('c.wav')]);
    expect(f.name).toBe('My pedals');
    expect((await f.list()).schematics.map(e => e.name)).toEqual(['a.pfl.json', 'b.asc']);
  });
});
