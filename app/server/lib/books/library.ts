// Rulebook library on disk (server-wide, shared by every table — the books belong to the server owner):
//   <dir>/library.json        { books: [Book] }
//   <dir>/<CODE>.pdf          the PDF
//   <dir>/index/<CODE>.json   extracted text per PDF page { v, code, pages, texts: [..], edges: [[..]] }
// Book = { code, name, nameFr, file, pages, offset, offsets?, confidence?, verified?, indexedAt, tables: 'all'|[tableId], size, extra? }
// <dir> = SR_BOOKS_DIR, else <runtime>/books. Everything here takes the directory explicitly (the CLI has its own).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './search.ts';
import { cleanOffsets } from './offsets.ts';
import type { OffsetRange } from './offsets.ts';
import type { BookDoc } from './search.ts';

/** One entry of library.json (see the header). */
export interface LibraryBook {
  code: string;
  name: string;
  nameFr: string;
  file: string;
  pages: number;
  offset: number;
  /** 'all' or the ids of the tables allowed to read it. */
  tables: 'all' | string[];
  offsets?: OffsetRange[] | null;
  confidence?: number;
  /** null in an indexing patch when the book has no reference sentence (cleanBook drops it). */
  verified?: boolean | null;
  /** PDF page of Chummer's reference sentence. */
  matchPdfPage?: number | null;
  indexedAt?: number | null;
  size?: number;
  /** Offsets set by hand on the admin page. */
  manual?: boolean;
  /** Not a Chummer book. */
  extra?: boolean;
  /** Original file name. */
  source?: string;
}
export interface Library {
  books: LibraryBook[];
}
/** Known book (book-names.json): Chummer's reference sentence `match` lets the indexer check its offset. */
export interface KnownBook {
  name: string;
  nameFr?: string;
  match?: { text: string; page: number };
}
/** A book's index with folded texts (loadIndex). */
export interface BookIndex extends BookDoc {
  pages: number;
  edges: number[][];
}
/** Extracted text of a book, as written to index/<CODE>.json. */
export interface IndexData {
  pages: number;
  texts: string[];
  edges: number[][];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;

/** Upper-cased, validated book code or null. */
export function cleanCode(c: unknown): string | null {
  const s = String(c || '').trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

let namesCache: Record<string, KnownBook> | null = null;
/** Known Shadowrun 5 books (from Chummer's books.xml + French data): { CODE: { name, nameFr, match? } }. */
export function knownBooks(): Record<string, KnownBook> {
  if (!namesCache) {
    try {
      namesCache = JSON.parse(fs.readFileSync(path.join(HERE, 'book-names.json'), 'utf8'));
    } catch {
      namesCache = {};
    }
  }
  return namesCache!;
}

export const libraryFile = (dir: string): string => path.join(dir, 'library.json');
export const pdfFile = (dir: string, code: string): string => path.join(dir, `${code}.pdf`);
export const indexFile = (dir: string, code: string): string => path.join(dir, 'index', `${code}.json`);

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Normalize one library entry (unknown fields dropped). */
// `b` is foreign data (library.json, admin input, patches).
export function cleanBook(b: any): LibraryBook | null {
  const code = cleanCode(b?.code);
  if (!code) return null;
  const known: Partial<KnownBook> = knownBooks()[code] || {};
  const out: LibraryBook = {
    code,
    name: String(b.name || known.name || code).slice(0, 120),
    nameFr: String(b.nameFr || known.nameFr || b.name || known.name || code).slice(0, 120),
    file: `${code}.pdf`,
    pages: Math.max(0, Math.round(Number(b.pages) || 0)),
    offset: Math.round(Number(b.offset) || 0),
    tables: Array.isArray(b.tables) ? [...new Set<string>(b.tables.map(String).filter((x: string) => /^[a-z0-9-]{1,40}$/.test(x)))] : 'all',
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

const libCache = new Map<string, { mtimeMs: number; size: number; lib: Library }>(); // dir -> { mtimeMs, lib }
/** Read library.json (cached by mtime, so the CLI can update it while the server runs). */
export function readLibrary(dir: string): Library {
  const file = libraryFile(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { books: [] };
  }
  const c = libCache.get(dir);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.lib;
  let lib: Library = { books: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    lib = { books: (raw.books || []).map(cleanBook).filter(Boolean) as LibraryBook[] };
  } catch (err) {
    console.error('[books] library.json illisible', (err as Error).message);
  }
  libCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, lib });
  return lib;
}

export function writeLibrary(dir: string, lib: { books?: Array<Partial<LibraryBook>> }): Library {
  const books = (lib.books || []).map(cleanBook).filter(Boolean) as LibraryBook[];
  const order = (b: LibraryBook) => (b.code === 'SR5' ? '0' : b.extra ? '2' : '1') + b.code;
  books.sort((a, b) => order(a).localeCompare(order(b)));
  writeAtomic(libraryFile(dir), JSON.stringify({ books }, null, 2));
  libCache.delete(dir);
  return { books };
}

/** Update (or add) one entry. */
export function upsertBook(dir: string, code: string, patch: Partial<LibraryBook>): LibraryBook | undefined {
  const lib = readLibrary(dir);
  const books: Array<Partial<LibraryBook>> = lib.books.filter((b) => b.code !== code);
  const cur: Partial<LibraryBook> = lib.books.find((b) => b.code === code) || { code };
  books.push({ ...cur, ...patch, code });
  return writeLibrary(dir, { books }).books.find((b) => b.code === code);
}

export function removeBook(dir: string, code: string): void {
  const lib = readLibrary(dir);
  writeLibrary(dir, { books: lib.books.filter((b) => b.code !== code) });
  for (const f of [pdfFile(dir, code), indexFile(dir, code)]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
  indexCache.delete(`${dir}|${code}`);
}

export function writeIndex(dir: string, code: string, data: IndexData): void {
  writeAtomic(indexFile(dir, code), JSON.stringify({ v: 1, code, pages: data.pages, texts: data.texts, edges: data.edges }));
  indexCache.delete(`${dir}|${code}`);
}

const indexCache = new Map<string, { mtimeMs: number; doc: BookIndex }>(); // `${dir}|${code}` -> { mtimeMs, doc: { texts, folded, edges, pages } }
/** Index of a book with its folded texts (cached in memory by mtime), or null. */
export function loadIndex(dir: string, code: string): BookIndex | null {
  const file = indexFile(dir, code);
  let st: fs.Stats;
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
    const texts: string[] = Array.isArray(raw.texts) ? raw.texts.map((t: unknown) => String(t || '')) : [];
    const doc: BookIndex = { pages: raw.pages || texts.length, texts, folded: texts.map(fold), edges: raw.edges || [] };
    indexCache.set(key, { mtimeMs: st.mtimeMs, doc });
    return doc;
  } catch (err) {
    console.error(`[books] index ${code} illisible`, (err as Error).message);
    return null;
  }
}

/** True when the book may be read from that table. */
export function allowedFor(book: Pick<LibraryBook, 'tables'> | null | undefined, tableId: string): boolean {
  return !!book && (book.tables === 'all' || !Array.isArray(book.tables) || book.tables.includes(tableId));
}
