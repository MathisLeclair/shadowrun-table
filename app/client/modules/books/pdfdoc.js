// pdf.js loading and the ONE open rulebook document (kept across drawer close / reopen, so going back to a book or
// jumping to another page never reloads it). pdf.js is served by the app (/vendor/pdfjs/<version>/, see 90-books.js):
// the modern build when the browser has Promise.withResolvers, else the legacy build (older Safari / Chrome).
// State: { key, code, status: 'idle'|'loading'|'ready'|'error', stage: 'lib'|'cache'|'download'|'parse', loaded, total,
//          fromCache, doc, error } — useDocState() re-renders on every change.
import { useEffect, useState } from 'preact/hooks';
import { cacheKey } from './cachepolicy.js';
import { getBookData } from './bookcache.js';
import { loadBooks, findBook, pdfjsBase } from './store.js';

let libPromise = null;
/** The pdf.js module ({ getDocument, TextLayer, GlobalWorkerOptions… }), loaded once from the app's own origin. */
export function loadPdfjs() {
  if (!libPromise) {
    libPromise = (async () => {
      const base = pdfjsBase();
      if (!base) throw new Error('pdf.js');
      const modern = typeof Promise.withResolvers === 'function';
      const dir = `${base}/${modern ? 'build' : 'legacy/build'}`;
      const lib = await import(/* @vite-ignore */ `${dir}/pdf.min.mjs`);
      lib.GlobalWorkerOptions.workerSrc = `${dir}/pdf.worker.min.mjs`;
      return { lib, base };
    })();
    libPromise.catch(() => (libPromise = null));
  }
  return libPromise;
}

let state = { key: null, code: null, status: 'idle', stage: null, loaded: 0, total: 0, fromCache: false, doc: null, error: null };
let task = null; // pdf.js loading task of the current document
let download = null; // AbortController of the current document's download (another book opened = aborted)
let idleTimer = null;
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}
export const getDocState = () => state;

export function useDocState() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (s !== state) setS(state);
    return () => listeners.delete(setS);
  }, []);
  return s;
}

/** Destroy the open document (worker memory freed). */
export function closeDoc() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const t = task;
  task = null;
  if (t) t.destroy().catch(() => {});
  download?.abort();
  download = null;
  set({ key: null, code: null, status: 'idle', stage: null, loaded: 0, total: 0, fromCache: false, doc: null, error: null });
}

/** The drawer closed: keep the document a while (reopening is instant), then free it. */
export function releaseDocSoon(ms = 10 * 60 * 1000) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeDoc, ms);
}

/**
 * Make `book` the open document (no-op when it already is, or is loading). Bytes come from the browser cache, else
 * the network (progress in state.loaded / state.total). A refused link (403: renewed day, session) is renewed once.
 */
export function ensureDoc(book) {
  clearTimeout(idleTimer);
  idleTimer = null;
  const key = cacheKey(book) || `${book.code}@${book.url}`;
  if (state.key === key && state.status !== 'error') return;
  const prev = task;
  task = null;
  if (prev) prev.destroy().catch(() => {});
  download?.abort(); // the previous book's download: its buffer is not kept in memory beside the new one
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  download = ctrl;
  const signal = ctrl?.signal;
  const mine = { key };
  set({ key, code: book.code, status: 'loading', stage: 'lib', loaded: 0, total: Number(book.size) || 0, fromCache: false, doc: null, error: null, token: mine });
  const alive = () => state.token === mine;
  (async () => {
    const { lib, base } = await loadPdfjs();
    if (!alive()) return;
    set({ stage: 'cache' });
    const onProgress = (loaded, total) => alive() && set({ stage: 'download', loaded, total: total || state.total });
    let got;
    try {
      got = await getBookData(book, { onProgress, signal });
    } catch (err) {
      if (err?.status !== 403 && err?.status !== 401) throw err;
      await loadBooks(true);
      const fresh = findBook(book.code);
      if (!fresh || !alive()) throw err;
      got = await getBookData(fresh, { onProgress, signal });
    }
    if (download === ctrl) download = null;
    if (!alive()) return;
    set({ stage: 'parse', fromCache: got.fromCache });
    const origin = location.origin;
    const t = lib.getDocument({
      data: new Uint8Array(got.data),
      isEvalSupported: false, // CSP: no eval / new Function (font glyphs are drawn without compiled paths)
      cMapUrl: `${origin}${base}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${origin}${base}/standard_fonts/`,
      enableXfa: false,
    });
    task = t;
    const doc = await t.promise;
    if (!alive()) {
      t.destroy().catch(() => {});
      return;
    }
    set({ status: 'ready', stage: null, doc });
  })().catch((err) => {
    if (!alive()) return;
    console.warn('[books] lecteur PDF', err);
    set({ status: 'error', stage: null, error: err?.message || String(err) });
  });
}
