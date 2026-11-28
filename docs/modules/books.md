# Rulebooks (PDF library, search, viewer)

| | |
|---|---|
| server | `server/modules/90-books.ts`, `server/lib/books/` (`offsets.ts`, `access.ts`, `jobs.ts`, `index-worker.ts`, `admin-routes.ts`) |
| client | `client/modules/books/` (BooksPage, BookViewer, BookRef, PdfReader, `pdfdoc.ts`, `pdfview.ts`, `bookcache.ts`, `store.ts`), `client/modules/admin/BooksAdmin.tsx`; French `client/i18n/fr/books.json` |
| tools | `node tools/books-setup.ts` |
| tests | `node tools/test-books.ts` (ports 3420-3439) |

The server owner's SR5 PDFs, readable by GM and players of the tables the admin allows: tab « Règles » (search, common
rules, library) and a global viewer drawer opened from anywhere. **Server-wide**, not per table, never in git. The 📖
chips on every game element: [book-refs.md](book-refs.md). Copying the books to the VPS: [deploy.md](../deploy.md).

```
<books dir> = SR_BOOKS_DIR, else <runtime>/books
  library.json        { books: [{ code (Chummer code: SR5, RG…), name, nameFr, file: '<CODE>.pdf', pages, offset, offsets?: [{ fromPrinted, offset }],
                        confidence (0..1, folio agreement), verified? (Chummer's reference sentence found on the right page), matchPdfPage?,
                        manual? (offset set by hand: a re-index keeps it), indexedAt, tables: 'all'|[tableId], size, extra? (not a Chummer book), source? }] }
  <CODE>.pdf          the PDF
  index/<CODE>.json   { v, code, pages, texts: [text of each PDF page], edges: [[numbers found in its header/footer]] }
<runtime>/books-sign.key  HMAC key of the PDF links (SR_BOOKS_KEY_FILE; per install, deliberately outside the books folder, which is copied
                          from the GM's PC to the VPS — an old books/.sign-key is deleted at first use)
```

## Page numbers

References everywhere are PRINTED pages (catalog `source`/`page`, Chummer). PDF page = printed + `offset`; `offsets`
lists changes (printed page n uses the last entry with `fromPrinted ≤ n`), for books with unnumbered inserts.
`server/lib/books/offsets.ts` (`printedToPdf`, `pdfToPrinted`, `detectOffsets`) and the same helpers client-side in
`client/modules/books/refs.ts`. `printedToPdf` returns null for a page outside the book (never clamped to the last
page: a bad reference shows « Page {page} introuvable dans ce livre »).

**Detection** (`detectOffsets`): bare numbers in the top/bottom 8.5 % of each page vote for `pdfPage − n`; numbers
printed on > 20 % of the pages are noise (kept as weak candidates that may only continue a run); each change of offset
kept for ≥ 3 pages becomes a range, starting right after the last printed page of the previous range. Cross-checked
with Chummer's reference sentence (`books.xml` `<match>`, names in `server/lib/books/book-names.json`, regenerate with
`node tools/books-setup.ts --names`).

## CLI

`node tools/books-setup.ts --from "<folder>" [--runtime <dir>|--books <dir>] [--only SR5,RG] [--map "file.pdf=CODE"]
[--foundry <world>]` copies the PDFs (code guessed from the file name, never modifies the source), extracts with
pdfjs-dist (legacy build, ≈ 20 s for 10 books), writes the index and library, prints a table (offsets, confidence,
Chummer check, Foundry pdfoundry/pdf-pager hints) and runs the checks: known references (RG 62 Heritage, SR5 240 Hack on
the Fly, SR5 310 Improved Reflexes/Kinesics, RF 221 Garage…), the « Règles » quick links
(`client/modules/books/quicklinks.ts`: each page must contain its heading) and catalog evidence (share of
`data/catalog` items whose name is on the announced page; warns when a ±1–3 shift would score better). `--reindex
[CODES]`, `--check`, `--list`, `--strict` (exit 1 on a failed check).

## Routes

Any logged-in user of the table, `requireUser`:
- `GET /api/books` → `{ books: [{ code, name, nameFr, pages, offset, offsets?, indexed, extra?, url, exp, version, size
  }], missing: [{ code, name, nameFr, de? }], ttl, now, pdfjs }` (books allowed for the requester's table whose PDF
  exists; `url` = signed PDF link; `now` = server clock in ms, the client judges expiry with it; `version` = base36
  `size-mtime` of the PDF = the reader's cache key and the file's ETag; `size` = bytes, for the progress bar; `pdfjs` =
  `/vendor/pdfjs/<pdfjs-dist version>`; `missing` = every book of `book-names.json` the table cannot read, also those
  on the server but restricted to other tables (no existence oracle), SR5 first, German-only (`de`) last, the rest by
  name, `[]` on a demo table; `90-books.ts missingBooks`). Types `BooksResponse`, `BookListEntry`, `MissingBookEntry`.
- `GET /api/books/search?q=&code=` → `{ hits: [{ code, page (printed|null), pdfPage, snippet, marks: [[start, end]] }],
  total }` (accent/case-insensitive, every term required at a word start, "quoted phrases", capitals headings first,
  max 50; `code` of a book not allowed → 403).
- `GET /api/books/:code/page/:n[?pdf=1]` → `{ code, page, pdfPage, pages, text }` (page outside the book → 404 « Page
  introuvable »), `GET /api/books/:code/link` → fresh `{ url, exp }`. `/page` and `/link` answer the same 404 for an
  unknown book and a book not allowed for the table (no existence oracle).
- `GET /api/books/:code/file?k=…` = the PDF (`sendFile`: HTTP Range/206, `Cache-Control: private, max-age=86400`,
  strong `ETag: "<version>"` + `Last-Modified` → `If-None-Match` / `If-Modified-Since` 304 and `If-Range`, all checked
  AFTER the signature, `Content-Disposition: inline`, `nosniff`, `Referrer-Policy: no-referrer`; these PDF headers only
  on success: an error is JSON with `no-store`, an unsatisfiable Range a bare 416, a malformed Range is ignored → 200).
  `k` = base64url({ t: tableId, u: userId, s: sessionTag(token), c: code, e: expiry }) + HMAC-SHA256; expiry rounded up
  to the next UTC midnight + 24 h (`access.ts` STEP = LINK_TTL = 86400: the same URL all day, valid 24-48 h → HTTP cache
  hits). No `k` → 401; bad signature, other book, expired, table archived/unknown, user removed, **session gone**
  (logout, kick, GM password change), book not allowed for that table → 403.

## Admin

`server/lib/books/admin-routes.ts`, registered by `registerAdminRoutes`, admin bearer token: `GET /api/admin/books`
(books + `indexed`, `present`, jobs, tables, known Chummer codes, max size), `POST
/api/admin/books/upload?code=&replace=1` (body = PDF, streamed with `receiveToFile`, `%PDF-` checked, `X-Filename`
URI-encoded) → background index, `PATCH /api/admin/books/:code { name?, nameFr?, offset?, offsets?, tables?:
'all'|[ids] }` (offset → `manual`), `POST …/:code/detect[?apply=0]` (re-run detection on the stored index; `apply=0` =
preview for the edit dialog, saved only by « Enregistrer »), `POST …/:code/reindex { detect? }`, `DELETE …/:code {
confirm: code }`. Upload cap `SR_MAX_BOOK_BYTES` (120 MB).
Indexing runs in a `worker_threads` worker (`index-worker.ts`, heap `SR_BOOKS_WORKER_MB`, `SR_BOOKS_JOBS` at a time,
default 1) inside the server's process: a job (and an upload with a Content-Length) is refused with « Mémoire
insuffisante… » (`jobs.ts memoryVerdict`, error key + `errorParams`) when 6 × the PDF size exceeds the cgroup limit
(`memory.max`, `SR_MEMORY_LIMIT_BYTES`) minus the server's RSS. pdfjs reads the file through a view (no second copy).
Only the main thread writes `library.json`. Search folds texts with one regex replace (a char-by-char `+=` cost ≈ 300 MB
of heap). UI: `client/modules/admin/BooksAdmin.tsx` (panel « Livres de règles » of `/admin`).

**Missing books:** the /admin panel lists « Absents de ce serveur (n) »: every `known` book without a library entry
(German-only ones folded in a `<details>`), each with its own « Téléverser » button (a file input: picking the PDF
uploads it under that code, `BooksAdmin.tsx MissingBooks`). That is the only place where a book is added from the UI:
books are server-wide, and a table (the public one above all) must never change them. The Règles library shows the
same books greyed out from `/api/books` `missing`, without any upload; while one of its books is not indexed yet it
refreshes the list every 10 s (30 times at most).

## Client API

`import { BookRef, openBook, parseSourceRef } from '../books/BookRef.tsx'`:
- `<BookRef source="RG" page="62" label? />` (also `source="SR5 p. 240"` or `source={{ source, page }}`) renders a
  « 📖 RG 62 » chip (dashed when the book is not on the server) that opens the drawer; `<ItemRef item />`, `<RuleRef
  rule="limits" />`, `<SkillRef id="pistols" />` ([book-refs.md](book-refs.md)).
- `openBook(code, printedPage)` / `openBook('RG 62')`; `parseSourceRef('RG 62' | 'SR5 p. 240' | { source, page })` → `{
  code, page }` or null (a separator is required: « GH3 » is a code). `openBook()` with the list already loaded sets the
  page synchronously. `openBookPdf(code, pdfPage, { q })` (search hits: `q` is highlighted on that page).
- `useBooks()` (store.ts) = library list (links renewed 10 min before expiry by a timer and before any page change,
  judged on the server clock: `serverNow()` = `Date.now()` + skew from `/api/books` `now`).
- Viewer state: `nav` is bumped by every navigation request (the reader scrolls), `reportPdfPage()` = the reader's own
  scrolling (no bump).

## Viewer and reader

- **Viewer** (`BookViewer.tsx`, in `globalComponents`, z-index 150 above the sheet modal): right drawer, resizable
  (width kept in `localStorage` `sr.books.width`), Esc closes it first (capture listener). A `.modal-backdrop` that
  appears after the drawer opened (MutationObserver; baseline reset by every `openBook*` through `viewer.raise`) puts
  the drawer behind it (`.behind`, z-index 90) and leaves Esc to that modal; book switcher, printed-page field +
  prev/next, zoom (− / % / +, the % toggles fit width ↔ fit page; kept in `localStorage` `sr.books.zoom`), « Texte »
  mode (extracted text of the page, with an « Ouvrir le PDF » link), new-tab link (browser's own viewer), search (this
  book / all books), ⚙ settings (zoom presets, mode, cache).
- **Reader** (in-app pdf.js, desktop and mobile): `PdfReader.tsx` (React shell: progress bar, errors, retry) →
  `pdfdoc.ts` (loads pdf.js from `/vendor/pdfjs/<v>/build/` — or `legacy/build/` when the browser lacks
  `Promise.withResolvers` —, ONE open document kept across drawer close for 10 min, `getDocument({ data,
  isEvalSupported: false, cMapUrl, standardFontDataUrl })`, a 403 download renews the links once) → `pdfview.ts`
  (imperative: one box per page sized from the PDF, continuous scroll, only pages within 1.5 screens drawn — HiDPI
  canvas, devicePixelRatio ≤ 2, ≤ 16 Mpx — with a pdf.js `TextLayer` (selection, search highlights `.books-hl`), pages
  further away released (canvas freed, `page.cleanup()`), ≤ 10 drawn; Ctrl+wheel and two-finger pinch zoom around the
  pointer; page jumps scroll inside the same document, nothing is reloaded). Pure helpers (Node-tested): `readerlib.ts`
  (fold/terms/matches, page tops, fit scale, zoom steps, canvas density), `cachepolicy.ts`.
- pdf.js is served by `90-books.ts` from `node_modules/pdfjs-dist` (only `{build,legacy/build}/pdf{,.worker}.min.mjs`,
  `cmaps/*.bcmap`, `standard_fonts/*.{pfb,ttf}`; `Cache-Control: immutable`, 1 year). **No CSP change**: the module
  worker is same-origin (`default-src 'self'` covers `worker-src`), fonts are `FontFace` objects, eval is disabled.

## Book cache

`bookcache.ts`, rules in `cachepolicy.ts`: each PDF is downloaded ONCE per browser (`fetch` + progress from
Content-Length / `size`) and kept under the key `<CODE>@<version>` (never the signed URL). Backend: Cache Storage
`caches.open('sr-books')` (fake request URLs `/__sr-books/<key>`, last use in `localStorage` `sr.books.used`) in a secure
context (https, localhost); **IndexedDB** `sr-books` (stores `meta` + `data` = Blob) otherwise — the production URL
`http://<ip>:8095` is not a secure context, `caches` is undefined there; nothing persistent when both fail (private
mode: the open document still stays in memory). With a persistent backend the download is `cache: 'no-store'` (no
second copy in the HTTP cache; `cachepolicy.ts downloadOptions`); opening another book aborts the running download
(`pdfdoc.ts ensureDoc` AbortController). Store: other versions of that book dropped, then least recently used books
evicted to stay ≤ 12 books / 600 MB (a bigger book is read but not kept; a quota error evicts the oldest and retries).
Every fresh `/api/books` list drops entries whose code now has another version (`pruneStale`). « Vider le cache des
livres » in ⚙ and under the Règles library (which also shows « en cache » per book, current version only). Measured
(SR5, 41 MB, 502 pages, headless Edge, local server): first open ≈ 0.6-0.7 s to the first drawn page over loopback (on
the VPS: the time to download 41 MB once), reopen from cache ≈ 0.45 s (Cache Storage and IndexedDB alike), page jump ≈
0.05-0.15 s, 0 PDF requests after the first download, also after a full page reload.

## Tests

`node tools/test-books.ts` (ports 3420-3439): hand-made 9-page PDF (cover, printed 1-4, unnumbered insert, printed 5-7,
a constant « 3 » in every footer) → CLI install, offset ranges, auth 401/403 (forged expired / other table / unknown
user keys / dead session after a GM password change), signing key outside the books folder, Range 206 / 416 /
malformed, error headers, search, page text (out of range → 404), same 404 for restricted books, admin permissions,
upload + background index, memory guard, manual offset / detect (preview `apply=0`), table restriction, delete; fold()
equivalence + speed; reader: `version` / `size` / `pdfjs` in the list, same URL on every list call and for the whole
day, ETag = version, 304 (If-None-Match, If-Modified-Since, never before the signature check), If-Range, new version +
ETag when the PDF changes, pdf.js files served (JS MIME, immutable) and nothing else of the package; pure cache key /
eviction / stale-version / backend choice, highlight matching, layout and zoom math.
