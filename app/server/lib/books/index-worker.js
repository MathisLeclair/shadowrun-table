// worker_threads entry: index one book off the main thread (pdfjs text extraction is CPU-heavy).
// workerData = { dir, code, detect, meta }. Posts { type: 'progress', done, total } and { type: 'done', patch } | { type: 'error', message }.
import { parentPort, workerData } from 'node:worker_threads';
import { indexBook } from './indexer.js';

const { dir, code, detect, meta } = workerData;
let last = 0;
try {
  const r = await indexBook(dir, code, {
    detect,
    meta,
    save: false,
    onProgress(done, total) {
      if (done === total || Date.now() - last > 300) {
        last = Date.now();
        parentPort.postMessage({ type: 'progress', done, total });
      }
    },
  });
  parentPort.postMessage({ type: 'done', patch: r.patch });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: String(err?.message || err) });
}
