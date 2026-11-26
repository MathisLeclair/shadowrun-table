// Rulebooks (see ARCHITECTURE.md « Rulebooks »): the server owner's SR5 PDFs, shared by every table that is allowed
// to read them. Any logged-in user (GM or player) can list them, search their text and open a page.
// The PDF itself is fetched by an <iframe>, which cannot send our Authorization header: it carries a short-lived
// signed key instead (?k=…, HMAC of table + user + session + book + expiry, see server/lib/books/access.js).
import fs from 'node:fs';
import { errorBody } from '../lib/i18n.js';
import { BOOKS_DIR, signLink, verifyLink, sessionTag, sessionAlive, LINK_TTL } from '../lib/books/access.js';
import { readLibrary, loadIndex, allowedFor, cleanCode, pdfFile } from '../lib/books/library.js';
import { parseQuery, searchPages, queryHeadline } from '../lib/books/search.js';
import { pdfToPrinted, printedToPdf } from '../lib/books/offsets.js';

const MAX_HITS = 50;
const NOT_HERE = 'Livre non disponible sur ce serveur';
const BAD_LINK = 'Lien expiré ou invalide : rouvre le livre';

/** Session token of the request (same rules as the core's bearer()). */
const tokenOf = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
};

/** A syntactically valid HTTP Range header (« bytes=0-99 », « bytes=-500 », lists). Anything else is ignored (RFC 9110). */
const RANGE_RE = /^bytes=\s*(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))*\s*$/;

/** Books readable from a table, as sent to clients (no file names, sizes or table lists). */
function publicBook(b, req) {
  const { k, exp } = signLink(BOOKS_DIR, { tableId: req.srTable.id, userId: req.user.id, session: sessionTag(tokenOf(req)), code: b.code });
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
  };
}

const visibleBooks = (req) => readLibrary(BOOKS_DIR).books.filter((b) => allowedFor(b, req.srTable.id) && fs.existsSync(pdfFile(BOOKS_DIR, b.code)));
/** A book readable from the request's table, or null. Unknown and not-allowed books look the same (another table must not learn which books exist). */
const tableBook = (req, rawCode) => {
  const code = cleanCode(rawCode);
  return (code && readLibrary(BOOKS_DIR).books.find((x) => x.code === code && allowedFor(x, req.srTable.id))) || null;
};

export default {
  name: 'books',
  init() {},
  routes(app, { requireUser, tableApi }) {
    app.get('/api/books', requireUser, (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      // now = server clock (ms): clients judge link expiry with it, not with their own clock.
      res.json({ books: visibleBooks(req).map((b) => publicBook(b, req)), ttl: LINK_TTL, now: Date.now() });
    });

    app.get('/api/books/search', requireUser, (req, res) => {
      const q = String(req.query.q || '').trim();
      const terms = parseQuery(q);
      if (!terms.length) return res.json({ q, hits: [], total: 0 });
      const want = String(req.query.code || '')
        .split(',')
        .map(cleanCode)
        .filter(Boolean);
      const books = visibleBooks(req).filter((b) => !want.length || want.includes(b.code));
      if (want.length && !books.length) return res.status(403).json(errorBody('Livre non disponible sur cette table'));
      let hits = [];
      for (const b of books) {
        const idx = loadIndex(BOOKS_DIR, b.code);
        if (!idx) continue;
        for (const h of searchPages(idx, terms, { headline: queryHeadline(q) })) hits.push({ code: b.code, page: pdfToPrinted(b, h.pdfPage), pdfPage: h.pdfPage, snippet: h.snippet, marks: h.marks, score: h.score });
      }
      const order = new Map(books.map((b, i) => [b.code, i]));
      hits.sort((a, b) => b.score - a.score || order.get(a.code) - order.get(b.code) || a.pdfPage - b.pdfPage);
      const total = hits.length;
      hits = hits.slice(0, MAX_HITS).map(({ score, ...h }) => h);
      res.json({ q, hits, total });
    });

    /** Text of one page: /api/books/RG/page/62 (printed page) or /api/books/RG/page/64?pdf=1 (PDF page). Out of the book → 404. */
    app.get('/api/books/:code/page/:n', requireUser, (req, res) => {
      const b = tableBook(req, req.params.code);
      if (!b) return res.status(404).json(errorBody(NOT_HERE));
      const n = Math.round(Number(req.params.n));
      const pdfPage = req.query.pdf === '1' ? (n >= 1 && n <= (b.pages || 1) ? n : null) : printedToPdf(b, n);
      const idx = loadIndex(BOOKS_DIR, b.code);
      if (!pdfPage || !idx) return res.status(404).json(errorBody('Page introuvable'));
      res.json({ code: b.code, page: pdfToPrinted(b, pdfPage), pdfPage, pages: b.pages, text: idx.texts[pdfPage - 1] || '' });
    });

    /** Fresh signed URL for one book (the list already carries one; this renews it). */
    app.get('/api/books/:code/link', requireUser, (req, res) => {
      const b = tableBook(req, req.params.code);
      if (!b) return res.status(404).json(errorBody(NOT_HERE));
      const { url, exp } = publicBook(b, req);
      res.json({ url, exp });
    });

    /** The PDF (HTTP Range supported: PDF viewers stream it). Auth = ?k= signed key only. */
    app.get('/api/books/:code/file', (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); // errors are never cached; a successful send replaces it
      const code = cleanCode(req.params.code);
      const v = verifyLink(BOOKS_DIR, typeof req.query.k === 'string' ? req.query.k : '');
      if (!v.ok) return v.reason === 'missing' ? res.status(401).json(errorBody('Non connecté')) : res.status(403).json(errorBody(BAD_LINK));
      if (v.c !== code) return res.status(403).json(errorBody(BAD_LINK));
      const t = tableApi.tables.get(v.t);
      const live = t && tableApi.usableTable(t) === t && !t.meta?.archived;
      // The session that asked for the link must still exist (logout, kick, removed player, GM password change → dead link).
      const userOk = live && (v.u === 'gm' || !!t.state?.users?.[v.u]) && sessionAlive(t.state?.sessions, v.u, v.s);
      if (!userOk) return res.status(403).json(errorBody(BAD_LINK));
      const b = readLibrary(BOOKS_DIR).books.find((x) => x.code === code);
      if (!b || !allowedFor(b, v.t)) return res.status(403).json(errorBody('Livre non disponible sur cette table'));
      const file = pdfFile(BOOKS_DIR, code);
      if (!fs.existsSync(file)) return res.status(404).json(errorBody(NOT_HERE));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // A malformed Range is ignored (200 with the whole file), not answered with 416.
      if (req.headers.range && !RANGE_RE.test(req.headers.range)) delete req.headers.range;
      // root + relative name: only the file name is checked for dotfiles (the books dir itself may sit under a dot folder).
      // The PDF headers go through `headers` (applied by send once the file is found)…
      const headers = { 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': `inline; filename="${code}.pdf"`, 'Content-Type': 'application/pdf' };
      res.sendFile(`${code}.pdf`, { root: BOOKS_DIR, cacheControl: false, acceptRanges: true, dotfiles: 'deny', headers }, (err) => {
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
