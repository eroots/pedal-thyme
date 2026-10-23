// The user's amp captures (NAM files), kept in the browser's own storage so they're there next time.
// Captures are loaded by the user from files they downloaded; none are bundled (their licences
// usually allow use, not redistribution).
import { idbGet, idbSet } from '../builder/folder';
import { parseNam } from './nam';

export interface AmpEntry {
  id: string;
  /** Shown in menus: the file name (a capture's own metadata name isn't always right). */
  name: string;
  gearType: string | null;
  inputLevelDbu: number | null;
  sampleRate: number;
  /** The .nam file itself. */
  text: string;
}

const KEY = 'amp-library';

export async function listAmps(): Promise<AmpEntry[]> {
  const list = await idbGet<AmpEntry[]>(KEY);
  return Array.isArray(list) ? list : [];
}

/** Check a .nam file can be played, then keep it. Throws a readable error if it can't. */
export async function addAmp(file: File): Promise<AmpEntry> {
  const text = await file.text();
  const name = file.name.replace(/\.nam$/i, '');
  const { info } = parseNam(text, name);
  if (info.sampleRate !== 48000) throw new Error(`it was captured at ${info.sampleRate} Hz; only 48 kHz captures are supported so far`);
  const entry: AmpEntry = { id: `amp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, gearType: info.gearType, inputLevelDbu: info.inputLevelDbu, sampleRate: info.sampleRate, text };
  const list = await listAmps();
  await idbSet(KEY, [...list, entry]);
  return entry;
}

export async function removeAmp(id: string): Promise<void> {
  await idbSet(KEY, (await listAmps()).filter(a => a.id !== id));
}
