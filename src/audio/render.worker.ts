// Runs the time-domain simulation off the main thread, reporting progress.
import type { Term } from '../core/termination';
import type { Netlist, Node } from '../engine/netlist';
import { renderAudio } from '../engine/transient';

export interface RenderRequest { netlist: Netlist; input: Float64Array; fs: number; oversample: number; term: Term | null; probes: Node[] }
export type RenderMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; out: [Node, Float64Array][]; unconverged: number; rails: [number, number]; ms: number }
  | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const r = e.data, t0 = performance.now();
  const post = (m: RenderMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const res = renderAudio(r.netlist, r.input, {
      fs: r.fs, oversample: r.oversample, term: r.term, probes: r.probes,
      onProgress: fraction => post({ type: 'progress', fraction }),
    });
    const out = [...res.out];
    post({ type: 'done', out, unconverged: res.unconverged, rails: res.rails, ms: performance.now() - t0 }, out.map(([, y]) => y.buffer));
  } catch (err) {
    post({ type: 'error', message: (err as Error).message || String(err) });
  }
};
