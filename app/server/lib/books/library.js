// Rulebook library on disk (server-wide, shared by every table — the books belong to the server owner):
//   <dir>/library.json        { books: [Book] }
//   <dir>/<CODE>.pdf          the PDF
//   <dir>/index/<CODE>.json   extracted text per PDF page { v, code, pages, texts: [..], edges: [[..]] }
// Book = { code, name, nameFr, file, pages, offset, offsets?, confidence?, verified?, indexedAt, tables: 'all'|[tableId], size, extra? }
// <dir> = SR_BOOKS_DIR, else <runtime>/books. Everything here takes the directory explicitly (the CLI has its own).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './search.js';
import { cleanOffsets } from './offsets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;

/** Upper-cased, validated book code or null. */
export function cleanCode(c) {
  const s = String(c || '').trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

let namesCache = null;
/** Known Shadowrun 5 books (from Chummer's books.xml + French data): { CODE: { name, nameFr, match? } }. */
export function knownBooks() {
  if (!namesCache) {
    try {
      namesCache = JSON.parse(fs.readFileSync(path.join(HERE, 'book-names.json'), 'utf8'));
    } catch {
      namesCache = {};
    }
  }
  return namesCache;
}

export const libraryFile = (dir) => path.join(dir, 'library.json');
export const pdfFile = (dir, code) => path.join(dir, `${code}.pdf`);
export const indexFile = (dir, code) => path.join(dir, 'index', `${code}.json`);

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Normalize one library entry (unknown fields dropped). */
export function cleanBook(b) {
  const code = cleanCode(b?.code);
  if (!code) return null;
  const known = knownBooks()[code] || {};
  const out = {
    code,
    name: String(b.name || known.name || code).slice(0, 120),
    nameFr: String(b.nameFr || known.nameFr || b.name || known.name || code).slice(0, 120),
    file: `${code}.pdf`,
    pages: Math.max(0, Math.round(Number(b.pages) || 0)),
    offset: Math.round(Number(b.offset) || 0),
    tables: Array.isArray(b.tables) ? [...new Set(b.tables.map(String).filter((x) => /^[a-z0-9-]{1,40}$/.test(x)))] : 'all',
  };
  const offs = cleanOffsets(b.offsets);
  if (offs) out.offsets = offs;
  if (Number.isFinite(Number(b.confidence))) out.confidence = Math.round(Number(b.confidence) * 1000) / 1000;
  if (typeof b.verified === 'boolean') out.verified = b.verified;
  if (Number(b.matchPdfPage) > 0) out.matchPdfPage = Number(b.matchPdfPage); // PDF page of Chummer's reference sentence
  if (b.indexedAt) out.indexedAt = Number(b.indexedAt) || null;
  if (b.size) out.size = Number(b.size) || 0;
  if (b.manual) out.manual = true; // offsets set by hand on the admin page: a re-index keeps them
  if (b.extra) out.extra = true; // not a Chummer book (cheat sheet…): no catalog reference points to it
  if (b.source) out.source = String(b.source).slice(0, 200); // original file name
  return out;
}

const libCache = new Map(); // dir -> { mtimeMs, lib }
/** Read library.json (cached by mtime, so the CLI can update it while the server runs). */
export function readLibrary(dir) {
  const file = libraryFile(dir);
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    return { books: [] };
  }
  const c = libCache.get(dir);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.lib;
  let lib = { books: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    lib = { books: (raw.books || []).map(cleanBook).filter(Boolean) };
  } catch (err) {
    console.error('[books] library.json illisible', err.message);
  }
  libCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, lib });
  return lib;
}

export function writeLibrary(dir, lib) {
  const books = (lib.books || []).map(cleanBook).filter(Boolean);
  const order = (b) => (b.code === 'SR5' ? '0' : b.extra ? '2' : '1') + b.code;
  books.sort((a, b) => order(a).localeCompare(order(b)));
  writeAtomic(libraryFile(dir), JSON.stringify({ books }, null, 2));
  libCache.delete(dir);
  return { books };
}

/** Update (or add) one entry. */
export function upsertBook(dir, code, patch) {
  const lib = readLibrary(dir);
  const books = lib.books.filter((b) => b.code !== code);
  const cur = lib.books.find((b) => b.code === code) || { code };
  books.push({ ...cur, ...patch, code });
  return writeLibrary(dir, { books }).books.find((b) => b.code === code);
}

export function removeBook(dir, code) {
  const lib = readLibrary(dir);
  writeLibrary(dir, { books: lib.books.filter((b) => b.code !== code) });
  for (const f of [pdfFile(dir, code), indexFile(dir, code)]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
  indexCache.delete(`${dir}|${code}`);
}

export function writeIndex(dir, code, data) {
  writeAtomic(indexFile(dir, code), JSON.stringify({ v: 1, code, pages: data.pages, texts: data.texts, edges: data.edges }));
  indexCache.delete(`${dir}|${code}`);
}

const indexCache = new Map(); // `${dir}|${code}` -> { mtimeMs, doc: { texts, folded, edges, pages } }
/** Index of a book with its folded texts (cached in memory by mtime), or null. */
export function loadIndex(dir, code) {
  const file = indexFile(dir, code);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${dir}|${code}`;
  const c = indexCache.get(key);
  if (c && c.mtimeMs === st.mtimeMs) return c.doc;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const texts = Array.isArray(raw.texts) ? raw.texts.map((t) => String(t || '')) : [];
    const doc = { pages: raw.pages || texts.length, texts, folded: texts.map(fold), edges: raw.edges || [] };
    indexCache.set(key, { mtimeMs: st.mtimeMs, doc });
    return doc;
  } catch (err) {
    console.error(`[books] index ${code} illisible`, err.message);
    return null;
  }
}

/** True when the book may be read from that table. */
export function allowedFor(book, tableId) {
  return !!book && (book.tables === 'all' || !Array.isArray(book.tables) || book.tables.includes(tableId));
}
