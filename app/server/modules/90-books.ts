// Rulebooks (see ARCHITECTURE.md « Rulebooks »): the server owner's SR5 PDFs, shared by every table that is allowed
// to read them. Any logged-in user (GM or player) can list them, search their text and open a page.
// The PDF itself is downloaded by the in-app reader (pdf.js, client/modules/books/PdfReader.js) or opened in a new tab,
// neither of which sends our Authorization header: it carries a signed key instead (?k=…, HMAC of table + user +
// session + book + expiry, see server/lib/books/access.js), stable for a day so caches hit.
// The reader keeps each book in the browser (Cache Storage / IndexedDB) keyed by code + `version` (size + mtime).
// pdf.js itself is served from node_modules under /vendor/pdfjs/<version>/ (immutable, no CDN).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { errorBody } from '../lib/i18n.ts';
import { BOOKS_DIR, signLink, verifyLink, sessionTag, sessionAlive, LINK_TTL } from '../lib/books/access.ts';
import { readLibrary, loadIndex, allowedFor, cleanCode, pdfFile, type LibraryBook } from '../lib/books/library.ts';
import { parseQuery, searchPages, queryHeadline } from '../lib/books/search.ts';
import { pdfToPrinted, printedToPdf } from '../lib/books/offsets.ts';
import type { ServerModule } from '../../shared/types.ts';

// No Express types in the app yet (@types/express arrives with the server-core conversion): loose local aliases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Express app / request / response
type HttpApp = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = any;

/** Cached content version of a book's PDF. */
interface BookVersion {
  mtimeMs: number;
  size: number;
  version: string;
}

const MAX_HITS = 50;
const NOT_HERE = 'Livre non disponible sur ce serveur';
const BAD_LINK = 'Lien expiré ou invalide : rouvre le livre';

/** Session token of the request (same rules as the core's bearer()). */
const tokenOf = (req: Req): string => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
};

/** A syntactically valid HTTP Range header (« bytes=0-99 », « bytes=-500 », lists). Anything else is ignored (RFC 9110). */
const RANGE_RE = /^bytes=\s*(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))*\s*$/;

// ---------------------------------------------------------------------------
// pdf.js (pdfjs-dist browser builds), served from the app: /vendor/pdfjs/<version>/{build,legacy/build,cmaps,standard_fonts}/…
// The version is in the URL, so the files are immutable for the browser.
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
let PDFJS_DIR: string | null = null;
let PDFJS_VERSION: string | null = null;
try {
  const pkg = require.resolve('pdfjs-dist/package.json');
  PDFJS_DIR = path.dirname(pkg);
  PDFJS_VERSION = String(JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '0').replace(/[^0-9A-Za-z.-]/g, '');
} catch {}
export const PDFJS_BASE = PDFJS_VERSION ? `/vendor/pdfjs/${PDFJS_VERSION}` : null;
/** Only these files of the package are public (the two browser builds, CMaps, standard fonts). */
const PDFJS_PUBLIC = /^\/(?:build|legacy\/build)\/pdf(?:\.worker)?\.min\.mjs$|^\/cmaps\/[\w.-]+\.bcmap$|^\/standard_fonts\/[\w.-]+\.(?:pfb|ttf)$/;

/** Content version of a book's PDF (changes when the file is replaced): base36 size + mtime. Also its strong ETag. */
const statCache = new Map<string, BookVersion>(); // code -> { mtimeMs, size, version }
export function bookVersion(code: string): BookVersion | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(pdfFile(BOOKS_DIR, code));
  } catch {
    return null;
  }
  const prev = statCache.get(code);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev;
  const v = { mtimeMs: st.mtimeMs, size: st.size, version: `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}` };
  statCache.set(code, v);
  return v;
}

/** Books readable from a table, as sent to clients (no file names or table lists). */
function publicBook(b: LibraryBook, req: Req) {
  const { k, exp } = signLink(BOOKS_DIR, { tableId: req.srTable.id, userId: req.user.id, session: sessionTag(tokenOf(req)), code: b.code });
  const v = bookVersion(b.code);
  return {
    code: b.code,
    name: b.name,
    nameFr: b.nameFr,
    pages: b.pages,
    offset: b.offset,
    ...(b.offsets ? { offsets: b.offsets } : {}),
    indexed: !!b.indexedAt,
    ...(b.extra ? { extra: true } : {}),
    url: `/api/books/${encodeURIComponent(b.code)}/file?k=${encodeURIComponent(k)}`,
    exp,
    // Cache key of the reader (code + version: never the signed URL) and download size (progress bar).
    ...(v ? { version: v.version, size: v.size } : {}),
  };
}

// A public demo table never sees the server owner's rulebooks (also refused by server/lib/demo.js before reaching here).
const visibleBooks = (req: Req): LibraryBook[] => (req.srTable.meta?.demo ? [] : readLibrary(BOOKS_DIR).books.filter((b: LibraryBook) => allowedFor(b, req.srTable.id) && fs.existsSync(pdfFile(BOOKS_DIR, b.code))));
/** A book readable from the request's table, or null. Unknown and not-allowed books look the same (another table must not learn which books exist). */
const tableBook = (req: Req, rawCode: unknown): LibraryBook | null => {
  const code = cleanCode(rawCode);
  if (req.srTable.meta?.demo) return null;
  return (code && readLibrary(BOOKS_DIR).books.find((x: LibraryBook) => x.code === code && allowedFor(x, req.srTable.id))) || null;
};

const mod: ServerModule<HttpApp> = {
  name: 'books',
  init() {},
  routes(app, { requireUser, tableApi }) {
    if (PDFJS_DIR) {
      // fallthrough: a missing file answers the same JSON 404 (no ENOENT stack in the server log).
      const serve = express.static(PDFJS_DIR, { index: false, dotfiles: 'deny', immutable: true, maxAge: 365 * 86400 * 1000, fallthrough: true,
        setHeaders: (res: Res) => res.setHeader('X-Content-Type-Options', 'nosniff') });
      const notFound = (res: Res) => res.status(404).json(errorBody('Introuvable'));
      app.use(PDFJS_BASE, (req: Req, res: Res) => (PDFJS_PUBLIC.test(req.path) ? serve(req, res, () => notFound(res)) : notFound(res)));
    }

    app.get('/api/books', requireUser, (req: Req, res: Res) => {
      res.setHeader('Cache-Control', 'no-store');
      // now = server clock (ms): clients judge link expiry with it, not with their own clock.
      res.json({ books: visibleBooks(req).map((b) => publicBook(b, req)), ttl: LINK_TTL, now: Date.now(), pdfjs: PDFJS_BASE });
    });

    app.get('/api/books/search', requireUser, (req: Req, res: Res) => {
      const q = String(req.query.q || '').trim();
      const terms = parseQuery(q);
      if (!terms.length) return res.json({ q, hits: [], total: 0 });
      const want = String(req.query.code || '')
        .split(',')
        .map(cleanCode)
        .filter(Boolean);
      const books = visibleBooks(req).filter((b) => !want.length || want.includes(b.code));
      if (want.length && !books.length) return res.status(403).json(errorBody('Livre non disponible sur cette table'));
      let hits: Array<{ code: string; page: number | null; pdfPage: number; snippet: string; marks: unknown; score?: number }> = [];
      for (const b of books) {
        const idx = loadIndex(BOOKS_DIR, b.code);
        if (!idx) continue;
        for (const h of searchPages(idx, terms, { headline: queryHeadline(q) })) hits.push({ code: b.code, page: pdfToPrinted(b, h.pdfPage), pdfPage: h.pdfPage, snippet: h.snippet, marks: h.marks, score: h.score });
      }
      const order = new Map(books.map((b, i) => [b.code, i]));
      hits.sort((a, b) => b.score! - a.score! || order.get(a.code)! - order.get(b.code)! || a.pdfPage - b.pdfPage);
      const total = hits.length;
      hits = hits.slice(0, MAX_HITS).map(({ score, ...h }) => h);
      res.json({ q, hits, total });
    });

    /** Text of one page: /api/books/RG/page/62 (printed page) or /api/books/RG/page/64?pdf=1 (PDF page). Out of the book → 404. */
    app.get('/api/books/:code/page/:n', requireUser, (req: Req, res: Res) => {
      const b = tableBook(req, req.params.code);
      if (!b) return res.status(404).json(errorBody(NOT_HERE));
      const n = Math.round(Number(req.params.n));
      const pdfPage = req.query.pdf === '1' ? (n >= 1 && n <= (b.pages || 1) ? n : null) : printedToPdf(b, n);
      const idx = loadIndex(BOOKS_DIR, b.code);
      if (!pdfPage || !idx) return res.status(404).json(errorBody('Page introuvable'));
      res.json({ code: b.code, page: pdfToPrinted(b, pdfPage), pdfPage, pages: b.pages, text: idx.texts[pdfPage - 1] || '' });
    });

    /** Fresh signed URL for one book (the list already carries one; this renews it). */
    app.get('/api/books/:code/link', requireUser, (req: Req, res: Res) => {
      const b = tableBook(req, req.params.code);
      if (!b) return res.status(404).json(errorBody(NOT_HERE));
      const { url, exp } = publicBook(b, req);
      res.json({ url, exp });
    });

    /** The PDF (HTTP Range, conditional GET: strong ETag "<version>" → 304). Auth = ?k= signed key only (checked first). */
    app.get('/api/books/:code/file', (req: Req, res: Res) => {
      res.setHeader('Cache-Control', 'no-store'); // errors are never cached; a successful send replaces it
      const code = cleanCode(req.params.code);
      const v = verifyLink(BOOKS_DIR, typeof req.query.k === 'string' ? req.query.k : '');
      if (!v.ok) return v.reason === 'missing' ? res.status(401).json(errorBody('Non connecté')) : res.status(403).json(errorBody(BAD_LINK));
      if (v.c !== code) return res.status(403).json(errorBody(BAD_LINK));
      const t = tableApi.tables.get(v.t);
      const live = t && tableApi.usableTable(t) === t && !t.meta?.archived && !t.meta?.demo;
      // The session that asked for the link must still exist (logout, kick, removed player, GM password change → dead link).
      const userOk = live && (v.u === 'gm' || !!t.state?.users?.[v.u]) && sessionAlive(t.state?.sessions, v.u, v.s);
      if (!userOk) return res.status(403).json(errorBody(BAD_LINK));
      const b: LibraryBook | undefined = readLibrary(BOOKS_DIR).books.find((x: LibraryBook) => x.code === code);
      if (!b || !allowedFor(b, v.t)) return res.status(403).json(errorBody('Livre non disponible sur cette table'));
      const file = pdfFile(BOOKS_DIR, code);
      if (!fs.existsSync(file)) return res.status(404).json(errorBody(NOT_HERE));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // A malformed Range is ignored (200 with the whole file), not answered with 416.
      if (req.headers.range && !RANGE_RE.test(req.headers.range)) delete req.headers.range;
      // root + relative name: only the file name is checked for dotfiles (the books dir itself may sit under a dot folder).
      // The PDF headers go through `headers` (applied by send once the file is found)…
      // Strong ETag = the book's version (also valid for If-Range); send() answers If-None-Match / If-Modified-Since with 304.
      const ver = bookVersion(code as string);
      const headers = { 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': `inline; filename="${code}.pdf"`, 'Content-Type': 'application/pdf', ...(ver ? { ETag: `"${ver.version}"` } : {}) };
      res.sendFile(`${code}.pdf`, { root: BOOKS_DIR, cacheControl: false, acceptRanges: true, dotfiles: 'deny', headers }, (err: (Error & { status?: number }) | undefined) => {
        if (!err || res.headersSent) return;
        // …but send applies them before checking the Range, so an error answer must drop them: never a cacheable « PDF » error.
        for (const h of ['Content-Disposition', 'Content-Type', 'ETag', 'Last-Modified', 'Accept-Ranges']) res.removeHeader(h);
        res.setHeader('Cache-Control', 'no-store');
        if (err.status === 416) return res.status(416).end(); // Content-Range: bytes */<size> is kept
        res.status(err.status || 500).json(errorBody(err.status === 404 ? NOT_HERE : 'Erreur du serveur'));
      });
    });
  },
};

export default mod;
