// Project folder: work in a folder of schematics like LTspice. Where the browser supports the File
// System Access API (Chrome, Edge), the folder is opened once, remembered across sessions (the handle is
// kept in IndexedDB; the browser asks again for access each session) and Save writes straight to the
// files. Elsewhere (Firefox, Safari) a folder can still be picked to list and open its files for the
// session, and saving falls back to downloads.

export const canWriteFolders = typeof window !== 'undefined' && 'showDirectoryPicker' in window && 'indexedDB' in window;
export const canSaveAs = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/** A schematic in the folder: its name and a way to read it (and, with folder access, its handle). */
export interface FolderEntry { name: string; read(): Promise<File>; handle?: FileSystemFileHandle }

/** Files the Builder can open. */
export const isSchematic = (name: string) => /\.(pfl\.json|json|asc)$/i.test(name);

/* ---------- Remembered handles (IndexedDB) ---------- */
const DB = 'pedal-filter-lab', STORE = 'handles';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise<T | undefined>((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result as T | undefined);
      q.onerror = () => rej(q.error);
    });
  } catch { return undefined; }
}
/** Store a value (structured clone: file handles and big pictures are fine); undefined deletes it. */
export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (value === undefined) tx.objectStore(STORE).delete(key); else tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* storage unavailable: just don't remember */ }
}

type Mode = 'read' | 'readwrite';
interface PermissionHandle { queryPermission(o: { mode: Mode }): Promise<PermissionState>; requestPermission(o: { mode: Mode }): Promise<PermissionState> }
/** Check (and, from a click, request) access to a handle. */
export async function allowed(h: FileSystemHandle, mode: Mode, ask: boolean): Promise<boolean> {
  const p = h as unknown as PermissionHandle;
  if (!p.queryPermission) return true;
  if ((await p.queryPermission({ mode })) === 'granted') return true;
  return ask && (await p.requestPermission({ mode })) === 'granted';
}

export class ProjectFolder {
  /** Folder with write access (File System Access API). */
  dir: FileSystemDirectoryHandle | null = null;
  /** Fallback: files from a folder picked with a plain file input (read-only, this session only). */
  files: File[] | null = null;
  /** File the current schematic (tab) was opened from or last saved to (folder access only). */
  current: FileSystemFileHandle | null = null;

  get name(): string | null { return this.dir?.name ?? (this.files ? folderNameOf(this.files) : null); }

  /** Restore the folder remembered from the last session (each tab remembers its own file). */
  async restore(): Promise<void> {
    if (!canWriteFolders) return;
    this.dir = (await idbGet<FileSystemDirectoryHandle>('folder')) ?? null;
  }

  /** Ask the user for a folder (from a click). Returns false if they cancelled. */
  async choose(): Promise<boolean> {
    try {
      const pick = (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      this.dir = await pick.call(window, { id: 'pedal-filter-lab', mode: 'readwrite' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false;
      throw err;
    }
    await idbSet('folder', this.dir);
    return true;
  }

  /** Fallback folder (Firefox, Safari): files chosen with <input webkitdirectory>. */
  useFiles(files: File[]): void { this.files = files.filter(f => isSchematic(f.name) || /\.asy$/i.test(f.name)); }

  async setCurrent(h: FileSystemFileHandle | null): Promise<void> { this.current = h; }

  /** Whether the remembered folder still needs a click to grant access this session. */
  async needsPermission(): Promise<boolean> { return !!this.dir && !(await allowed(this.dir, 'readwrite', false)); }

  /** Schematics in the folder (top level), sorted by name; .asy symbol files are returned separately. */
  async list(ask = false): Promise<{ schematics: FolderEntry[]; symbols: FolderEntry[] }> {
    let all: FolderEntry[] = [];
    if (this.dir) {
      if (!(await allowed(this.dir, 'readwrite', ask))) return { schematics: [], symbols: [] };
      const entries = (this.dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
      for await (const h of entries) {
        if (h.kind !== 'file') continue;
        const fh = h as FileSystemFileHandle;
        all.push({ name: fh.name, read: () => fh.getFile(), handle: fh });
      }
    } else if (this.files) {
      all = this.files.map(f => ({ name: f.name, read: async () => f }));
    }
    all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { schematics: all.filter(e => isSchematic(e.name)), symbols: all.filter(e => /\.asy$/i.test(e.name)) };
  }

  /** Write a file into the folder (creating or replacing it) and return its handle. */
  async write(name: string, data: string | Blob): Promise<FileSystemFileHandle> {
    if (!this.dir) throw new Error('No folder chosen.');
    const fh = await this.dir.getFileHandle(name, { create: true });
    await writeHandle(fh, data);
    return fh;
  }

  /** Does the folder already contain this file name? */
  async has(name: string): Promise<boolean> {
    if (!this.dir) return false;
    try { await this.dir.getFileHandle(name); return true; } catch { return false; }
  }
}

/** Write data to a file handle (asking for write access if needed, from a click). */
export async function writeHandle(fh: FileSystemFileHandle, data: string | Blob): Promise<void> {
  if (!(await allowed(fh, 'readwrite', true))) throw new Error('Permission to write the file was not granted.');
  const w = await (fh as unknown as { createWritable(): Promise<{ write(d: string | Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
  await w.write(data);
  await w.close();
}

/** "Save as" with the browser's file dialog; null if cancelled. */
export async function saveAsDialog(suggestedName: string, data: string, startIn?: FileSystemDirectoryHandle | null): Promise<FileSystemFileHandle | null> {
  try {
    const pick = (window as unknown as { showSaveFilePicker(o: object): Promise<FileSystemFileHandle> }).showSaveFilePicker;
    const fh = await pick.call(window, {
      id: 'pedal-filter-lab', suggestedName, ...(startIn ? { startIn } : {}),
      types: [{ description: 'Pedal Filter Lab project', accept: { 'application/json': ['.json'] } }],
    });
    await writeHandle(fh, data);
    return fh;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  }
}

function folderNameOf(files: File[]): string {
  const rel = (files[0] as File & { webkitRelativePath?: string } | undefined)?.webkitRelativePath ?? '';
  return rel.split('/')[0] || 'folder';
}
