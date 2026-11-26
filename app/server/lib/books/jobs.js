// Background indexing jobs (one worker thread per book, at most one job per book, SR_BOOKS_JOBS at a time — default 1).
// The worker runs inside the server's process: if the container runs out of memory every table goes down, so a job
// only starts when the cgroup memory limit leaves room for it (pdfjs needs several times the PDF's size, mostly in
// ArrayBuffers that the worker's heap limit does not count).
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { upsertBook, pdfFile } from './library.js';

const jobs = new Map(); // code -> { code, state: 'queued'|'running'|'done'|'error', done, total, error?, startedAt, finishedAt? }
const queue = [];
const MAX_RUNNING = Math.max(1, Number(process.env.SR_BOOKS_JOBS) || 1);
const KEEP_MS = 10 * 60 * 1000; // finished jobs stay visible on the admin page for 10 min
/** Memory an indexing job needs, per byte of PDF (measured: SR5 ≈ 40 MB → ≈ 230 MB of RSS above the server). */
export const BYTES_PER_PDF_BYTE = 6;
export const NO_MEMORY = 'Mémoire insuffisante pour indexer ce livre ({need} Mo nécessaires, {free} Mo libres)';

/** Memory limit of the container (cgroup v2, else v1) in bytes, or null when unlimited / unknown. SR_MEMORY_LIMIT_BYTES overrides. */
export function memoryLimit() {
  const env = Number(process.env.SR_MEMORY_LIMIT_BYTES);
  if (env > 0) return env;
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(fs.readFileSync(file, 'utf8').trim()); // « max » → NaN
      if (n > 0 && n < 1e15) return n;
    } catch {}
  }
  return null;
}

/**
 * May a PDF of `size` bytes be indexed now? { ok, need, free } (MB). Unknown limit → always ok.
 * limit / rss default to the container limit and this process's resident memory.
 */
export function memoryVerdict(size, { limit = memoryLimit(), rss = process.memoryUsage().rss } = {}) {
  const need = (Number(size) || 0) * BYTES_PER_PDF_BYTE;
  if (!limit) return { ok: true, need: Math.ceil(need / 1e6), free: null };
  const free = limit - rss;
  return { ok: need <= free, need: Math.ceil(need / 1e6), free: Math.max(0, Math.floor(free / 1e6)) };
}

export function jobList() {
  const now = Date.now();
  for (const [k, j] of jobs) if (j.finishedAt && now - j.finishedAt > KEEP_MS) jobs.delete(k);
  return [...jobs.values()].map((j) => ({ code: j.code, state: j.state, done: j.done, total: j.total, error: j.error || null, ...(j.errorParams ? { errorParams: j.errorParams } : {}) }));
}
export const isBusy = (code) => ['queued', 'running'].includes(jobs.get(code)?.state);

/** Queue an indexing job. opts: { detect, meta }. Returns false when that book is already being indexed. */
export function startIndexJob(dir, code, { detect = true, meta = {} } = {}) {
  if (isBusy(code)) return false;
  jobs.set(code, { code, state: 'queued', done: 0, total: 0, startedAt: Date.now(), dir, detect, meta });
  queue.push(code);
  pump();
  return true;
}

function pump() {
  const running = [...jobs.values()].filter((j) => j.state === 'running').length;
  if (running >= MAX_RUNNING || !queue.length) return;
  const code = queue.shift();
  const job = jobs.get(code);
  if (!job || job.state !== 'queued') return pump();
  let size = 0;
  try {
    size = fs.statSync(pdfFile(job.dir, code)).size;
  } catch {}
  const mem = memoryVerdict(size);
  if (!mem.ok) {
    // Another job holds the memory: wait for it (pump runs again when it finishes). Nothing running: refuse.
    if (running > 0) return void queue.unshift(code);
    Object.assign(job, { state: 'error', error: NO_MEMORY, errorParams: { need: mem.need, free: mem.free }, finishedAt: Date.now() });
    console.error(`[books] ${code} : mémoire insuffisante pour l’indexer (${mem.need} Mo nécessaires, ${mem.free} Mo libres)`);
    return setImmediate(pump);
  }
  job.state = 'running';
  let worker;
  const finish = (err) => {
    if (job.state !== 'running') return;
    job.state = err ? 'error' : 'done';
    if (err) job.error = err;
    job.finishedAt = Date.now();
    setImmediate(pump);
  };
  try {
    worker = new Worker(new URL('./index-worker.js', import.meta.url), {
      workerData: { dir: job.dir, code, detect: job.detect, meta: job.meta },
      resourceLimits: { maxOldGenerationSizeMb: Number(process.env.SR_BOOKS_WORKER_MB) || 320 },
    });
  } catch (err) {
    return finish(String(err.message || err));
  }
  worker.on('message', (m) => {
    if (m?.type === 'progress') Object.assign(job, { done: m.done, total: m.total });
    else if (m?.type === 'done') {
      try {
        upsertBook(job.dir, code, m.patch);
        finish(null);
      } catch (err) {
        finish(String(err.message || err));
      }
    } else if (m?.type === 'error') finish(m.message);
  });
  worker.on('error', (err) => finish(String(err?.message || err)));
  worker.on('exit', (c) => finish(c ? `worker exit ${c}` : job.state === 'running' ? 'worker stopped' : null));
}
