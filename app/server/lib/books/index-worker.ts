// worker_threads entry: index one book off the main thread (pdfjs text extraction is CPU-heavy).
// workerData = { dir, code, detect, meta }. Posts { type: 'progress', done, total } and { type: 'done', patch } | { type: 'error', message }.
import { parentPort, workerData } from 'node:worker_threads';
import { indexBook } from './indexer.ts';
import type { LibraryBook } from './library.ts';
import type { WorkerMessage } from './jobs.ts';

const { dir, code, detect, meta } = workerData as { dir: string; code: string; detect: boolean; meta: Partial<LibraryBook> };
const post = (m: WorkerMessage) => parentPort!.postMessage(m);
let last = 0;
try {
  const r = await indexBook(dir, code, {
    detect,
    meta,
    save: false,
    onProgress(done, total) {
      if (done === total || Date.now() - last > 300) {
        last = Date.now();
        post({ type: 'progress', done, total });
      }
    },
  });
  post({ type: 'done', patch: r.patch });
} catch (err) {
  post({ type: 'error', message: String((err as Error)?.message || err) });
}
