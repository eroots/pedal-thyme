import { levelAt } from '../core/measure';
import type { TaperKey } from '../core/pots';
import type { Opts, Values } from '../core/types';
import type { Metric, PartDef, PartType, TargetDef, TargetKind, Topology } from './types';

export const P = (key: string, type: PartType, def: number, extra: { zeroOk?: boolean; pot?: TaperKey } = {}): PartDef =>
  ({ key, type, def, ...extra });
export const M = (key: string, label: string, value: number | null | undefined, unit = '', extra: { noMark?: boolean } = {}): Metric =>
  ({ key, label, value, unit, ...extra });
export const T = (key: string, label: string, kind: TargetKind, def: number): TargetDef => ({ key, label, kind, def });

/** Option value as a number (knob position / slider). */
export const num = (o: Opts, k: string): number => Number(o[k]);

export function toneStackMetrics(t: Topology, v: Values, o: Opts): Metric[] {
  const N = 160, fAt = (i: number) => 20 * Math.pow(1000, i / N), m: number[] = [];
  let peak = -Infinity, fPeak: number | null = null, iMin = 0;
  for (let i = 0; i <= N; i++) {
    m[i] = levelAt(t, v, o, fAt(i));
    if (m[i] > peak) { peak = m[i]; fPeak = fAt(i); }
    if (m[i] < m[iMin]) iMin = i;
  }
  // Mid scoop: an in-band minimum at least 1 dB below the highest level on *each* side of it.
  // Depth is measured against the lower of those two shoulders.
  const left = Math.max(...m.slice(0, iMin + 1)), right = Math.max(...m.slice(iMin));
  const shoulder = Math.min(left, right), dip = iMin > 0 && iMin < N && m[iMin] < shoulder - 1;
  let fDip: number | null = null, dDip: number | null = null;
  if (dip) {
    let a = Math.log(fAt(iMin - 1)), b = Math.log(fAt(iMin + 1));
    for (let k = 0; k < 40; k++) {
      const c = b - 0.618 * (b - a), d = a + 0.618 * (b - a);
      if (levelAt(t, v, o, Math.exp(c)) < levelAt(t, v, o, Math.exp(d))) b = d; else a = c;
    }
    fDip = Math.exp((a + b) / 2); dDip = levelAt(t, v, o, fDip) - shoulder;
  }
  return [
    M('l100', 'Level @ 100 Hz', levelAt(t, v, o, 100), 'dB'),
    M('l1k', 'Level @ 1 kHz', levelAt(t, v, o, 1000), 'dB'),
    M('l5k', 'Level @ 5 kHz', levelAt(t, v, o, 5000), 'dB'),
    M('peak', 'Max level, 20 Hz–20 kHz', peak, 'dB'),
    M('fpk', 'Max level at', fPeak, 'Hz', { noMark: true }),
    M('scoop', 'Mid scoop centre', fDip, 'Hz'),
    M('depth', 'Mid scoop depth (vs. lower shoulder)', dDip, 'dB'),
  ];
}
