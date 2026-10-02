// Design-from-targets search: exact solution, snapped solution, and the best standard-value combos.
import { snap, seriesValues, type SeriesName } from '../core/eseries';
import type { Opts, Values } from '../core/types';
import type { Topology } from '../topologies/types';
import { evaluate, saneForSearch, valuesValid, type Evaluation } from './analysis';

export interface DesignRow extends Evaluation { v: Values; score?: number }
export interface DesignResult { exact: DesignRow | null; near: DesignRow | null; best: DesignRow[] }

export interface DesignInput {
  t: Topology;
  targets: Values;
  /** The user's preferred value for the anchor part. */
  anchor: number;
  opts: Opts;
  values: Values;
  rSeries: SeriesName;
  cSeries: SeriesName;
}

export function snapAllValues(t: Topology, v: Values, rSeries: SeriesName, cSeries: SeriesName): Values {
  const out: Values = {};
  for (const x of t.parts) out[x.key] = x.zeroOk && v[x.key] === 0 ? 0 : snap(v[x.key], x.type === 'R' ? rSeries : cSeries);
  return out;
}

/**
 * Throws an Error with a user-facing message when the targets are impossible for this topology.
 * Returns up to 10 best standard-value combinations, sweeping the anchor part across its series.
 */
export function searchDesigns({ t, targets: tg, anchor, opts, values, rSeries, cSeries }: DesignInput): DesignResult {
  const design = t.design, ap = t.parts.find(x => x.key === t.anchor);
  if (!design || !ap) throw new Error('This topology has no target-based design.');
  const ctx = { topo: t, opts, values, rSeries, cSeries };
  const res: DesignResult = { exact: null, near: null, best: [] };

  const v = design(tg, anchor, { ...ctx, exact: true });
  if (valuesValid(t, v)) res.exact = { v, ...evaluate(t, v, opts, tg) };
  const sv = snapAllValues(t, design(tg, snap(anchor, ap.type === 'R' ? rSeries : cSeries), ctx), rSeries, cSeries);
  if (valuesValid(t, sv)) res.near = { v: sv, ...evaluate(t, sv, opts, tg) };

  const cands = ap.type === 'R' ? seriesValues(rSeries, 470, 1e6) : seriesValues(cSeries, 100e-12, 4.7e-6);
  const seen = new Set<string>();
  for (const a of cands) {
    let cand: Values;
    try { cand = design(tg, a, ctx); } catch { continue; }
    if (!cand) continue;
    cand = snapAllValues(t, cand, rSeries, cSeries);
    if (!saneForSearch(t, cand)) continue;
    const key = JSON.stringify(cand);
    if (seen.has(key)) continue;
    seen.add(key);
    const ev = evaluate(t, cand, opts, tg);
    if (!isFinite(ev.worst)) continue;
    // Tie-break toward mid-range impedances and film-cap-friendly values.
    let pen = 0;
    for (const x of t.parts) {
      if (x.type === 'R') pen += Math.abs(Math.log10(cand[x.key] / 33e3));
      else if (cand[x.key] > 1e-6) pen += 1;
    }
    res.best.push({ v: cand, ...ev, score: ev.worst + 0.002 * pen });
  }
  res.best.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  res.best = res.best.slice(0, 10);
  return res;
}
