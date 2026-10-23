// Runs a NAM capture over signals off the main thread (one worker per job), reporting progress.
import { parseNam } from './nam';

export interface NamRequest { text: string; signals: Float32Array[] }
export type NamMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; outputs: Float32Array[] }
  | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<NamRequest>) => {
  const post = (m: NamMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const { net } = parseNam(e.data.text);
    const outputs = e.data.signals.map((s, i, all) => {
      const y = net.process(s);
      post({ type: 'progress', fraction: (i + 1) / all.length });
      return y;
    });
    post({ type: 'done', outputs }, outputs.map(o => o.buffer));
  } catch (err) {
    post({ type: 'error', message: (err as Error).message || String(err) });
  }
};
