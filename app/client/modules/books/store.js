// Rulebook client state: the library list (signed PDF links, renewed before they expire; `version` = cache key of the
// reader) and the global viewer drawer (which book / page is open). Shared by BookRef, BookViewer and BooksPage.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../../lib/net.js';
import { pruneStale } from './bookcache.js';

import { offsetFor, printedToPdf, pdfToPrinted, parseSourceRef } from './refs.js';

export { offsetFor, printedToPdf, pdfToPrinted, parseSourceRef };

// ---------------------------------------------------------------------------
// Library list
// ---------------------------------------------------------------------------
let books = null; // [{ code, name, nameFr, pages, offset, offsets?, indexed, url, exp, version, size }] | null (not loaded)
let pdfjs = null; // base URL of the app's pdf.js copy (/vendor/pdfjs/<version>), from /api/books
let loading = null;
let loadError = null;
let skew = 0; // server clock − this browser's clock (ms): link expiry is judged on the server's clock
let renewTimer = null;
const RENEW_BEFORE = 10 * 60 * 1000; // links are renewed 10 min before they expire
const libListeners = new Set();
const emitLib = () => {
  for (const l of libListeners) l(books);
};

/** Current time on the server's clock (ms). */
export const serverNow = () => Date.now() + skew;
/** True when a signed link of the list expires within 10 minutes (or already did). */
const isStale = () => !!books && books.some((b) => b.exp * 1000 - serverNow() < RENEW_BEFORE);

/** Renew the links before they expire, while someone uses them (a drawer left open for hours keeps working). */
function scheduleRenew() {
  clearTimeout(renewTimer);
  renewTimer = null;
  if (!books || !books.length) return;
  const first = Math.min(...books.map((b) => b.exp * 1000));
  const delay = Math.max(60 * 1000, first - RENEW_BEFORE - serverNow() + 1000);
  renewTimer = setTimeout(() => {
    renewTimer = null;
    if (libListeners.size || viewer.open) loadBooks();
  }, Math.min(delay, 2 ** 31 - 1));
}

/** Load (or refresh) the list. Links are renewed when they expire within 10 minutes. */
export function loadBooks(force = false) {
  if (books && !force && !isStale() && !loadError) return Promise.resolve(books);
  if (loading) return loading;
  const t0 = Date.now();
  loading = api('/api/books')
    .then((r) => {
      const t1 = Date.now();
      if (Number(r.now) > 0) skew = Number(r.now) - (t0 + t1) / 2;
      books = r.books || [];
      if (r.pdfjs) pdfjs = r.pdfjs;
      loadError = null;
      pruneStale(books); // cached copies of replaced PDFs are dropped
      return books;
    })
    .catch((err) => {
      loadError = err;
      books = books || [];
      return books;
    })
    .finally(() => {
      loading = null;
      scheduleRenew();
      emitLib();
    });
  return loading;
}
export const getBooks = () => books;
export const pdfjsBase = () => pdfjs;
export const booksError = () => loadError;
export const findBook = (code) => (books || []).find((b) => b.code === String(code || '').toUpperCase()) || null;

/** Hook: the library list (null while loading). */
export function useBooks() {
  const [list, setList] = useState(books);
  useEffect(() => {
    libListeners.add(setList);
    loadBooks().then(setList);
    return () => libListeners.delete(setList);
  }, []);
  return list;
}

// ---------------------------------------------------------------------------
// Viewer drawer
// ---------------------------------------------------------------------------
// { open, code, pdfPage (null = not known yet / book unknown here / badPage), printed (requested printed page),
//   badPage (the requested printed page is outside the book), searchQ, raise (bumped by every openBook*: the drawer
//   comes back in front of modals opened before), nav (bumped by every navigation REQUEST: the reader scrolls to
//   pdfPage; a page change reported by the reader's own scrolling does not bump it), hl ({ q, pdfPage }: search terms
//   to highlight on that page, set by a search hit) }
let viewer = { open: false, code: null, pdfPage: null, printed: null, badPage: false, searchQ: '', raise: 0, nav: 0, hl: null };
const viewListeners = new Set();
function setViewer(patch) {
  viewer = { ...viewer, ...patch };
  for (const l of viewListeners) l(viewer);
}
export const getViewer = () => viewer;
export function useViewer() {
  const [v, setV] = useState(viewer);
  useEffect(() => {
    viewListeners.add(setV);
    if (v !== viewer) setV(viewer);
    return () => viewListeners.delete(setV);
  }, []);
  return v;
}

/** Where a printed reference lands in the loaded list: { pdfPage, badPage }. */
function pageOf(ref) {
  const b = findBook(ref.code);
  if (!b) return { pdfPage: null, badPage: false };
  if (!ref.page) return { pdfPage: 1, badPage: false };
  const p = printedToPdf(b, ref.page);
  return p ? { pdfPage: p, badPage: false } : { pdfPage: null, badPage: true };
}

/** Open the viewer drawer at a printed page of a book (page null = first page). Accepts openBook('RG 62') too. */
export async function openBook(code, page) {
  const ref = parseSourceRef(code, page) || { code: String(code || '').toUpperCase(), page: null };
  const base = { open: true, code: ref.code, printed: ref.page, raise: viewer.raise + 1, nav: viewer.nav + 1, hl: null };
  // List loaded with fresh links: one state change, so the PDF frame mounts once, at the right page.
  if (books && !isStale() && !loadError) return setViewer({ ...base, ...pageOf(ref) });
  setViewer({ ...base, pdfPage: null, badPage: false });
  await loadBooks();
  if (viewer.code === ref.code) setViewer({ ...pageOf(ref), nav: viewer.nav + 1 });
}

/** Open the viewer at a PDF page (search hits, book list). opts.q = search query to highlight on that page. */
export async function openBookPdf(code, pdfPage, opts = {}) {
  await loadBooks();
  const b = findBook(code);
  const p = b ? Math.max(1, Math.min(b.pages || 1, Number(pdfPage) || 1)) : null;
  setViewer({ open: true, code, pdfPage: p, printed: b ? pdfToPrinted(b, pdfPage) : null, badPage: false, raise: viewer.raise + 1, nav: viewer.nav + 1, hl: opts.q && p ? { q: String(opts.q), pdfPage: p } : null });
}

/** Go to a PDF page of the open book (the reader scrolls there; the document is never reloaded). */
export async function gotoPdfPage(pdfPage) {
  if (isStale() || loadError) await loadBooks();
  const b = findBook(viewer.code);
  if (!b) return;
  const p = Math.max(1, Math.min(b.pages || 1, Number(pdfPage) || 1));
  setViewer({ pdfPage: p, printed: pdfToPrinted(b, p), badPage: false, nav: viewer.nav + 1 });
}

/** The reader scrolled to another page (no navigation request: nav unchanged). */
export function reportPdfPage(pdfPage) {
  const b = findBook(viewer.code);
  if (!b || pdfPage === viewer.pdfPage) return;
  setViewer({ pdfPage, printed: pdfToPrinted(b, pdfPage), badPage: false });
}
export const closeBook = () => setViewer({ open: false });
export const setViewerSearch = (q) => setViewer({ searchQ: q });

/** Full-text search: { hits: [{ code, page, pdfPage, snippet, marks }], total }. */
export function searchBooks(q, code) {
  const qs = new URLSearchParams({ q });
  if (code) qs.set('code', code);
  return api(`/api/books/search?${qs}`);
}
