// Rulebook library tests (ports 3420-3439): pure helpers (server + the reader's cache / layout / highlight rules), a hand-made PDF fixture indexed by tools/books-setup.ts
// (offset detection with an unnumbered insert), HTTP auth of /api/books* (401/403, signed links, expiry, Range 206),
// search, page text, and the /api/admin/books routes (permissions, upload, offsets, tables, delete).
// Review regressions: fold() memory, memory guard of indexing jobs, links bound to the session, signing key outside the
// books folder, error/416 headers of /file, printed page outside the book, same 404 for restricted books, detect preview.
// Reader cache: `version` in the list, ETag / 304 / If-Range, links stable for a day, pdf.js served from /vendor/pdfjs/<v>/.
//   node tools/test-books.ts
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login } from './test-client.ts';
import { detectOffsets, printedToPdf, pdfToPrinted, cleanOffsets } from '../server/lib/books/offsets.ts';
import { parseQuery, fold, searchPages } from '../server/lib/books/search.ts';
import { parseSourceRef, printedToPdf as clientPrintedToPdf, pdfToPrinted as clientPdfToPrinted } from '../client/modules/books/refs.ts';
import type { PagedBook } from '../client/modules/books/refs.ts';
import type { LibBook, MissingBook, SearchHit } from '../client/modules/books/types.ts';
import type { Library, LibraryBook } from '../server/lib/books/library.ts';
import type { JobInfo } from '../server/lib/books/jobs.ts';
import { memoryVerdict } from '../server/lib/books/jobs.ts';
import { readBytes } from '../server/lib/books/pdftext.ts';
import { cacheKey, parseCacheKey, planEviction, staleEntries, cachedByCode, pickBackendName, downloadOptions, MAX_BOOKS, MAX_BYTES } from '../client/modules/books/cachepolicy.ts';
import type { CacheBook } from '../client/modules/books/cachepolicy.ts';
import { queryTerms, findMatches, splitByRanges, computeTops, pageAt, scaleFor, zoomStep, outputScale, clampScale } from '../client/modules/books/readerlib.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3420 + (process.pid % 10);
const PORT2 = 3430 + (process.pid % 10); // memory-guard server (env SR_MEMORY_LIMIT_BYTES)
let failed = 0;
let passed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗', msg);
  }
}
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// Minimal PDF writer (Helvetica, WinAnsi): pages = [[{ x, y, size, text }]]
// ---------------------------------------------------------------------------
function pdfString(s: string) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c > 126) out += '\\' + c.toString(8).padStart(3, '0'); // WinAnsi = Latin-1 for é, à…
    else out += ch;
  }
  return `(${out})`;
}
/** A text item of the minimal PDF writer. */
interface PdfItem { x: number; y: number; size?: number; text: string }
export function makePdf(pages: PdfItem[][], { width = 612, height = 792 } = {}) {
  const objs: Array<string | null> = [];
  const add = (body: string | null) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const items of pages) {
    const ops = items.map((it) => `BT /F1 ${it.size || 11} Tf ${it.x} ${it.y} Td ${pdfString(it.text)} Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** 9 PDF pages: cover, printed 1-4, unnumbered colour insert, printed 5-7; constant « 3 » in every footer (noise). */
function fixtureBook() {
  const folio = (n: number) => (n ? [{ x: 300, y: 30, size: 9, text: String(n) }] : []);
  const noise = [{ x: 60, y: 30, size: 9, text: 'TEST HEAVEN' }, { x: 140, y: 30, size: 9, text: '3' }];
  const body = (t: string) => [{ x: 72, y: 700, size: 12, text: t }];
  return makePdf([
    [...body('TEST BOOK COVER')],
    [...body('Welcome to the test book. Introduction to the rules.'), ...noise, ...folio(1)],
    [...body('HERITAGE Zoé couture armor for the discerning runner'), ...noise, ...folio(2)],
    [...body('Edge and other special attributes'), ...noise, ...folio(3)],
    [...body('Lifestyles and their costs'), ...noise, ...folio(4)],
    [...body('COLOR INSERT full page art'), ...noise],
    [...body('Combat turn sequence and initiative'), ...noise, ...folio(5)],
    [...body('IMPROVED REFLEXES adept power, and the Garage lifestyle quality'), ...noise, ...folio(6)],
    [...body('Spellcasting and drain resistance'), ...noise, ...folio(7)],
  ]);
}

// ---------------------------------------------------------------------------
console.log('Pure functions…');
{
  // cover, printed 1-4, unnumbered insert, printed 5-7; « 3 » in every footer (noise, but also the real folio of p. 3)
  const edges = [[], [1, 3], [2, 3], [3], [4, 3], [3], [5, 3], [6, 3], [7, 3]];
  const d = detectOffsets(edges);
  eq(d.offset, 1, 'base offset');
  eq(d.offsets, [{ fromPrinted: 5, offset: 2 }], 'range after the insert');
  ok(d.confidence > 0.95, `confidence ${d.confidence}`);
  const book = { offset: 1, offsets: d.offsets, pages: 9 };
  eq([1, 2, 3, 4, 5, 6, 7].map((n) => printedToPdf(book, n)), [2, 3, 4, 5, 7, 8, 9], 'printed → PDF');
  eq([2, 3, 4, 5, 7, 8, 9].map((p) => pdfToPrinted(book, p)), [1, 2, 3, 4, 5, 6, 7], 'PDF → printed');
  eq(pdfToPrinted(book, 1), null, 'unnumbered cover');
  // The client's PagedBook has no `offsets: null`, which the server sends for books without an insert
  eq([1, 5, 7].map((n) => clientPrintedToPdf(book as PagedBook, n)), [2, 7, 9], 'client: printed → PDF');
  eq(clientPdfToPrinted(book as PagedBook, 8), 6, 'client: PDF → printed');
  const flat = detectOffsets(Array.from({ length: 40 }, (_, i) => (i < 2 ? [] : [i - 1])));
  eq([flat.offset, flat.offsets], [2, null], 'constant offset');
  eq(detectOffsets([[], []]).confidence, 0, 'no folio');
  eq(cleanOffsets([{ fromPrinted: 'x' }, { fromPrinted: 10, offset: 3 }]), [{ fromPrinted: 10, offset: 3 }], 'cleanOffsets');
  eq(parseQuery('Zoé "Hack on the fly" a').map((t) => t.text), ['hack on the fly', 'zoe'], 'parseQuery');
  eq(fold('Élan-Vital').length, 'Élan-Vital'.length, 'fold keeps positions');
  const doc = { texts: ['Something about HERITAGE armor', 'The Heritage line by Zoé', 'heritages? no: inheritance'], folded: [] as string[] };
  doc.folded = doc.texts.map(fold);
  const hits = searchPages(doc, parseQuery('heritage'));
  eq(hits.map((h) => h.pdfPage).sort(), [1, 2, 3], 'word start (heritages counts, inheritance does not)');
  ok(hits.find((h) => h.pdfPage === 1)!.score > hits.find((h) => h.pdfPage === 2)!.score, 'all-caps title ranked first');
  eq(searchPages(doc, parseQuery('inheritance')).length, 1, 'whole word');
  eq(parseSourceRef('RG 62'), { code: 'RG', page: 62 }, 'parseSourceRef RG 62');
  eq(parseSourceRef('SR5 p. 240'), { code: 'SR5', page: 240 }, 'parseSourceRef SR5 p. 240');
  eq(parseSourceRef('sr5 p.240'), { code: 'SR5', page: 240 }, 'parseSourceRef sr5 p.240');
  eq(parseSourceRef({ source: 'RG', page: '62' }), { code: 'RG', page: 62 }, 'parseSourceRef object');
  eq(parseSourceRef('RF 221, SR5 12'), { code: 'RF', page: 221 }, 'parseSourceRef list');
  eq(parseSourceRef('GH3'), { code: 'GH3', page: null }, 'parseSourceRef code only');
  eq(parseSourceRef(''), null, 'parseSourceRef empty');

  // A printed page outside the book is unknown (null), never clamped to the last page.
  eq([printedToPdf(book, 7), printedToPdf(book, 8), printedToPdf(book, 999)], [9, null, null], 'printed page outside the book → null');
  eq([clientPrintedToPdf(book as PagedBook, 8), clientPrintedToPdf({ offset: -5, pages: 9 }, 3)], [null, null], 'client: page outside the book → null');

  // fold(): same output as the per-char reference, without retaining a rope of one-char strings (≈ 300 MB for a library).
  const refCache = new Map<string, string>();
  const refChar = (c: string) => {
    let x = refCache.get(c);
    if (x === undefined) {
      x = c.normalize('NFD')[0].toLowerCase()[0] || c;
      if (/[‐‑‒–—\-_’'`´]/.test(x)) x = x === '’' || x === "'" || x === '`' || x === '´' ? "'" : ' ';
      refCache.set(c, x);
    }
    return x;
  };
  const refFold = (str: string | null) => String(str || '').split('').map(refChar).join('');
  for (const sample of ['Élan-Vital — Zoé’s « HACK » on_the`fly', 'ÆØ ß İ ﬁ 😀 ½ ２ Ⅻ', 'plain ascii 123', '', null])
    eq(fold(sample), refFold(sample), `fold identical (${sample})`);
  const bigPages = Array.from({ length: 1000 }, (_, i) => `PAGE ${i} Les règles d’Édge — ${'Zoé hack on the fly, réflexes améliorés. '.repeat(100)}`);
  const heap0 = process.memoryUsage().heapUsed;
  const foldedPages = bigPages.map(fold);
  const grown = (process.memoryUsage().heapUsed - heap0) / 1e6;
  ok(grown < 70 && foldedPages[999].length === bigPages[999].length, `fold: ${grown.toFixed(1)} MB retained for 4 M characters (before: ≈ 140 MB)`);

  // Memory guard of indexing jobs: 6 × the PDF must fit in the container limit minus the server's RSS.
  eq(memoryVerdict(40e6, { limit: 512e6, rss: 150e6 }).ok, true, 'memory: SR5 (40 MB) fits');
  eq(memoryVerdict(100e6, { limit: 512e6, rss: 150e6 }), { ok: false, need: 600, free: 362 }, 'memory: 100 MB PDF refused');
  eq(memoryVerdict(1e9, { limit: null, rss: 1 }).ok, true, 'memory: unknown limit → accepted');

  // readBytes(): the file's bytes (view over the Buffer, no second copy), small pooled files too.
  const bytesFile = path.join(os.tmpdir(), `sr-books-bytes-${process.pid}.bin`);
  for (const size of [10, 300000]) {
    const data = crypto.randomBytes(size);
    fs.writeFileSync(bytesFile, data);
    const u = readBytes(bytesFile);
    ok(u instanceof Uint8Array && Buffer.compare(Buffer.from(u.buffer, u.byteOffset, u.byteLength), data) === 0, `readBytes ${size} bytes`);
  }
  fs.rmSync(bytesFile, { force: true });
}

// ---------------------------------------------------------------------------
console.log('Reader: cache and layout (pure functions)…');
{
  // Cache key = code + version, never the signed URL.
  eq(cacheKey({ code: 'rg', version: 'abc-12', url: '/api/books/RG/file?k=x' } as CacheBook), 'RG@abc-12', 'cache key = code@version');
  eq([cacheKey({ code: 'RG' }), cacheKey({ code: 'RG', version: 'a/b' }), cacheKey({ code: '../x', version: 'a' })], [null, null, null], 'invalid cache key → null');
  eq(parseCacheKey('SR5@1a-2b'), { code: 'SR5', version: '1a-2b' }, 'parseCacheKey');
  eq(parseCacheKey('bad'), null, 'parseCacheKey invalid');
  const MB = 1024 * 1024;
  const e = (key: string, size: number, usedAt: number) => ({ key, size: size * MB, usedAt });
  // Another version of the book being stored goes first; then the least recently used, until the budget fits.
  let plan = planEviction([e('RG@old', 30, 900), e('SR5@v', 40, 100), e('SG@v', 20, 50)], { key: 'RG@new', size: 30 * MB }, { maxBytes: 100 * MB });
  eq(plan, { evict: ['RG@old'], store: true }, 'old version of the book evicted');
  plan = planEviction([e('SR5@v', 40, 100), e('SG@v', 20, 50), e('CF@v', 30, 300)], { key: 'RG@new', size: 30 * MB }, { maxBytes: 100 * MB });
  eq(plan, { evict: ['SG@v'], store: true }, 'least recently read evicted (byte budget)');
  plan = planEviction([e('A@1', 1, 3), e('B@1', 1, 1), e('C@1', 1, 2)], { key: 'D@1', size: MB }, { maxBooks: 2, maxBytes: 100 * MB });
  eq(plan, { evict: ['B@1', 'C@1'], store: true }, 'number of books capped (LRU)');
  plan = planEviction([e('A@1', 1, 3)], { key: 'D@1', size: 700 * MB });
  eq(plan, { evict: [], store: false }, 'book bigger than the budget: read without being kept');
  plan = planEviction([e('A@1', 50, 1), e('B@1', 50, 2)], { key: 'C@1', size: 60 * MB }, { maxBytes: 100 * MB, keep: ['A@1'] });
  eq(plan, { evict: ['B@1'], store: false }, 'protected key never evicted');
  eq(planEviction([e('RG@v', 30, 1)], { key: 'RG@v', size: 30 * MB }).evict, [], 'same key: nothing to evict');
  eq([MAX_BOOKS, MAX_BYTES / MB], [12, 600], 'default caps (12 books / 600 MB)');
  const books = [{ code: 'RG', version: 'new' }, { code: 'SR5', version: 'v' }];
  eq(staleEntries([e('RG@old', 1, 1), e('SR5@v', 1, 1), e('XX@1', 1, 1), { key: 'junk' }], books), ['RG@old', 'junk'], 'replaced versions evicted, unknown books kept');
  eq([...cachedByCode([e('RG@old', 1, 1), e('SR5@v', 2, 1)], books).keys()], ['SR5'], '« cached » only for the current version');
  eq(
    [pickBackendName({ secure: true, hasCaches: true, hasIdb: true }), pickBackendName({ secure: false, hasCaches: true, hasIdb: true }), pickBackendName({ secure: false, hasCaches: false, hasIdb: false })],
    ['cache', 'idb', 'none'],
    'Cache Storage in a secure context, IndexedDB on http://<ip> (production), else nothing'
  );
  // Regression: with a persistent cache the HTTP cache must not keep a second copy of the PDF; the download is abortable.
  const sig = { aborted: false };
  // Stand-in signal: only its identity is checked
  eq(downloadOptions({ persistent: true, signal: sig as unknown as AbortSignal }), { credentials: 'same-origin', signal: sig, cache: 'no-store' }, 'persistent cache: no-store download, abortable');
  eq(downloadOptions({ persistent: false }), { credentials: 'same-origin' }, 'no persistent cache: browser HTTP cache');

  // Highlight of the search terms in a page's text layer.
  eq(queryTerms('"Hack on the fly" Zoé a'), ['hack', 'the', 'fly', 'zoe', 'on'], 'terms to highlight');
  eq(findMatches('Zoé: Heritage line, HERITAGES and inheritance', ['heritage', 'zoe']), [[0, 3], [5, 13], [20, 28]], 'highlight at word start, ignoring accents and case');
  eq(splitByRanges('Edge rules', [[0, 4]]), [{ text: 'Edge', hit: true }, { text: ' rules', hit: false }], 'text split');
  eq(findMatches('hacking', ['hack', 'hacking']), [[0, 7]], 'merged ranges');

  // Continuous-scroll layout.
  const { tops, total } = computeTops([100, 200, 100], 10);
  eq([tops, total], [[10, 120, 330], 440], 'page tops');
  eq([pageAt(tops, 0), pageAt(tops, 119), pageAt(tops, 120), pageAt(tops, 5000)], [1, 1, 2, 3], 'page under a position');
  eq(scaleFor('width', { width: 612, height: 792 }, { width: 612, height: 400 }), 1, 'page width');
  ok(Math.abs(scaleFor('page', { width: 612, height: 792 }, { width: 612, height: 396 }) - 0.5) < 1e-9, 'whole page');
  eq([scaleFor(9, { width: 1, height: 1 }, { width: 1, height: 1 }), clampScale(0.01)], [5, 0.25], 'zoom clamped');
  eq([zoomStep(1, 1), zoomStep(1, -1), zoomStep(1.05, 1), zoomStep(5, 1), zoomStep(0.25, -1)], [1.1, 0.9, 1.1, 5, 0.25], 'zoom steps');
  eq([outputScale(800, 1000, 2), outputScale(800, 1000, 3), outputScale(800, 1000, 1)], [2, 2, 1], 'HiDPI canvas (max density 2)');
  ok(outputScale(4000, 5000, 2) ** 2 * 4000 * 5000 <= 16e6 + 1, 'canvas capped at 16 Mpx');
}

// ---------------------------------------------------------------------------
console.log('Setup (tools/books-setup.ts)…');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-books-test-'));
const src = path.join(tmp, 'pdfs');
const runtime = path.join(tmp, 'runtime');
fs.mkdirSync(src, { recursive: true });
const pdf = fixtureBook();
fs.writeFileSync(path.join(src, 'Shadowrun_5E_Run___Gun.pdf'), pdf);
fs.writeFileSync(path.join(src, 'House rules cheat sheet.pdf'), makePdf([[{ x: 72, y: 700, size: 12, text: 'Matrix cheat sheet house rules' }]]));
const srcBefore = fs.readFileSync(path.join(src, 'Shadowrun_5E_Run___Gun.pdf'));
const setup = spawnSync(process.execPath, [...process.execArgv.filter((a) => a === '--experimental-strip-types' || a === '--no-warnings'), 'tools/books-setup.ts', '--from', src, '--runtime', runtime], { cwd: ROOT, encoding: 'utf8' });
ok(setup.status === 0, `books-setup exit ${setup.status}: ${setup.stderr}`);
const libPath = path.join(runtime, 'books', 'library.json');
const lib = JSON.parse(fs.readFileSync(libPath, 'utf8')) as Library;
const rg = lib.books.find((b) => b.code === 'RG');
ok(!!rg, 'Run & Gun recognized by its file name (code RG)');
eq([rg?.pages, rg?.offset, rg?.offsets], [9, 1, [{ fromPrinted: 5, offset: 2 }]], 'pages + offsets detected');
eq(rg?.name, 'Run and Gun', 'Chummer name');
eq(rg?.nameFr, 'Run & Gun', 'French name');
const extra = lib.books.find((b) => b.extra);
ok(extra && extra.code === 'HRCS', `PDF outside Chummer: code from initials (${extra?.code})`);
ok(fs.existsSync(path.join(runtime, 'books', 'RG.pdf')) && fs.existsSync(path.join(runtime, 'books', 'index', 'RG.json')), 'PDF copied + index');
ok(Buffer.compare(srcBefore, fs.readFileSync(path.join(src, 'Shadowrun_5E_Run___Gun.pdf'))) === 0, 'source PDF untouched');
ok(/RG\s+9\s+\+1 p\.5→\+2/.test(setup.stdout), 'summary table');
// Copy of the installed library for the memory-guard server (startServer's stop removes the runtime).
const runtime2 = path.join(tmp, 'runtime2');
fs.cpSync(path.join(runtime, 'books'), path.join(runtime2, 'books'), { recursive: true });
// An older version kept the HMAC key in the books folder, which gets copied from the PC to the VPS: plant one.
const legacyKey = crypto.randomBytes(32);
fs.writeFileSync(path.join(runtime, 'books', '.sign-key'), legacyKey.toString('hex'));
const signWith = (key: Buffer, data: unknown) => {
  const p = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', key).update(p).digest('base64url')}`;
};

// ---------------------------------------------------------------------------
console.log('Server…');
const srv = await startServer({
  port: PORT,
  runtime,
  tables: [{ id: 'alpha', pack: 'blank', gmPassword: 'secret-a' }, { id: 'beta', pack: 'blank', gmPassword: 'secret-b' }],
});
const U = srv.url;
const get = (p: string, { token, table, headers = {} }: { token?: string; table?: string; headers?: Record<string, string> } = {}) => fetch(U + p, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(table ? { 'X-SR-Table': table } : {}), ...headers } });
// body: parsed JSON of whichever route was called (shapes vary per route), hence any
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
try {
  const gmA = await login(U, { role: 'gm', password: 'secret-a', table: 'alpha' });
  const gmB = await login(U, { role: 'gm', password: 'secret-b', table: 'beta' });
  const pA = await login(U, { role: 'player', name: 'Lectrice', table: 'alpha' });
  const admin = await srv.admin();
  const adminReq = (p: string, { method = 'GET', body, token = admin, headers = {} }: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) =>
    fetch(U + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/octet-stream' }), ...headers }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });

  // ----- list -----
  eq((await get('/api/books')).status, 401, 'list without session → 401');
  let r = await json(await get('/api/books', { token: pA, table: 'alpha' }));
  eq(r.status, 200, 'player list');
  const rgA = r.body.books.find((b: LibBook) => b.code === 'RG');
  ok(rgA && /^\/api\/books\/RG\/file\?k=/.test(rgA.url) && rgA.offset === 1 && rgA.offsets.length === 1, 'book RG listed with a signed link');
  ok(!('tables' in rgA) && !('source' in rgA), 'no server details in the list');
  ok(Math.abs(r.body.now - Date.now()) < 60000, 'server clock in the list (now)');
  ok(!fs.existsSync(path.join(runtime, 'books', '.sign-key')), 'old key in the books folder removed');
  ok(/^[0-9a-f]{64}$/.test(fs.readFileSync(path.join(runtime, 'books-sign.key'), 'utf8')), 'signing key outside the books folder');
  // ----- missing books: every Chummer SR5 book this table cannot read (greyed out in the Règles library) -----
  {
    const miss = (r.body.missing || []) as MissingBook[];
    ok(miss[0]?.code === 'SR5' && !miss.some((b) => b.code === 'RG' || b.code === 'HRCS'), `missing: core rules first, installed books absent (${miss.slice(0, 3).map((b) => b.code)})`);
    ok(miss.some((b) => b.code === 'SG' && b.name === 'Street Grimoire' && b.nameFr === 'Grimoire des Ombres'), 'missing: English and French names');
    const firstDe = miss.findIndex((b) => b.de);
    ok(firstDe > 0 && miss.slice(firstDe).every((b) => b.de) && miss.some((b) => b.code === 'SHB' && b.de), 'missing: German-only books last, flagged');
    const named = miss.slice(1, firstDe).map((b) => b.name);
    eq(named, [...named].sort((a, b) => a.localeCompare(b)), 'missing: sorted by name');
  }

  // ----- reader cache: version, stable links, pdf.js -----
  ok(/^[0-9a-z]+-[0-9a-z]+$/.test(rgA.version || '') && rgA.size === pdf.length, `version + size in the list (${rgA.version} / ${rgA.size})`);
  ok(rgA.exp - Date.now() / 1000 >= 86400 - 5, 'link valid for at least 24 h');
  const again = await json(await get('/api/books', { token: pA, table: 'alpha' }));
  eq(again.body.books.find((b: LibBook) => b.code === 'RG').url, rgA.url, 'same link from one request to the next (browser cache)');
  {
    process.env.SR_RUNTIME_DIR = runtime;
    const { signLink } = await import('../server/lib/books/access.ts');
    const day = Math.floor(Date.now() / 86400000) * 86400000;
    const args = [path.join(runtime, 'books'), { tableId: 'alpha', userId: 'gm', session: 'x', code: 'RG' }] as const;
    const a = signLink(...args, { now: day + 1000 });
    const b = signLink(...args, { now: day + 23 * 3600 * 1000 });
    ok(a.k === b.k && a.exp * 1000 >= day + 23 * 3600 * 1000 + 86400 * 1000, 'signature stable for the whole day, valid 24 h after');
    ok(signLink(...args, { now: day + 86400 * 1000 + 1000 }).k !== a.k, 'new link the next day');
  }
  const base = r.body.pdfjs;
  ok(/^\/vendor\/pdfjs\/\d+\.\d+\.\d+$/.test(base || ''), `pdf.js served by the app (${base})`);
  for (const p of ['/build/pdf.min.mjs', '/build/pdf.worker.min.mjs', '/legacy/build/pdf.min.mjs', '/legacy/build/pdf.worker.min.mjs']) {
    const v = await fetch(U + base + p, { method: 'HEAD' });
    ok(v.status === 200 && /javascript/.test(v.headers.get('content-type') || '') && /immutable/.test(v.headers.get('cache-control') || ''), `${p} : ${v.status} ${v.headers.get('content-type')} ${v.headers.get('cache-control')}`);
  }
  for (const p of ['/cmaps/Adobe-Japan1-UCS2.bcmap', '/standard_fonts/FoxitSerif.pfb']) eq((await fetch(U + base + p, { method: 'HEAD' })).status, 200, `pdf.js ${p}`);
  for (const p of ['/package.json', '/build/pdf.mjs.map', '/web/pdf_viewer.mjs', '/build/../package.json', '/%2e%2e/package.json'])
    eq((await fetch(U + base + p)).status, 404, `pdf.js: ${p} not served`);
  {
    const miss = await fetch(U + base + '/cmaps/Absent-Map.bcmap');
    ok(miss.status === 404 && /json/.test(miss.headers.get('content-type') || ''), 'pdf.js: missing file → 404 JSON (no ENOENT stack)');
  }

  // ----- file -----
  eq((await get('/api/books/RG/file')).status, 401, 'PDF without key → 401');
  let f = await get(rgA.url);
  eq(f.status, 200, 'PDF with key → 200');
  eq(f.headers.get('content-type'), 'application/pdf', 'PDF type');
  ok(/^inline/.test(f.headers.get('content-disposition') || ''), 'Content-Disposition inline');
  eq(f.headers.get('cache-control'), 'private, max-age=86400', 'Cache-Control private, 24 h');
  eq(f.headers.get('etag'), `"${rgA.version}"`, 'ETag = book version');
  const lastMod = f.headers.get('last-modified');
  ok(!!lastMod, 'Last-Modified');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': `"${rgA.version}"` } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [304, 0], 'If-None-Match → 304 without body');
  eq(f.headers.get('cache-control'), 'private, max-age=86400', '304 keeps Cache-Control');
  f = await get(rgA.url, { headers: { 'Cache-Control': 'max-age=0', 'If-Modified-Since': lastMod! } });
  eq(f.status, 304, 'If-Modified-Since → 304');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': '"other"' } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [200, pdf.length], 'other ETag → full 200');
  f = await get(rgA.url.slice(0, -3) + 'abc', { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': `"${rgA.version}"` } });
  eq(f.status, 403, 'If-None-Match does not bypass the signature');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { Range: 'bytes=0-9', 'If-Range': `"${rgA.version}"` } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [206, 10], 'If-Range with the ETag → 206');
  f = await get(rgA.url, { headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [200, pdf.length], 'stale If-Range → full 200');
  // Replacing the PDF changes its version (the reader drops its cached copy) and its ETag.
  {
    const pdfPath = path.join(runtime, 'books', 'RG.pdf');
    const st = fs.statSync(pdfPath);
    fs.utimesSync(pdfPath, st.atime, new Date(st.mtimeMs + 5000));
    const rgNew = (await json(await get('/api/books', { token: pA, table: 'alpha' }))).body.books.find((b: LibBook) => b.code === 'RG');
    ok(rgNew.version && rgNew.version !== rgA.version, `new version after replacement (${rgA.version} → ${rgNew.version})`);
    f = await get(rgNew.url, { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': `"${rgA.version}"` } });
    ok(f.status === 200 && f.headers.get('etag') === `"${rgNew.version}"`, 'old ETag → 200 with the new ETag');
    await f.arrayBuffer();
    fs.utimesSync(pdfPath, st.atime, st.mtime);
  }
  f = await get(rgA.url);
  eq(f.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges');
  eq(Buffer.from(await f.arrayBuffer()).length, pdf.length, 'full PDF');
  f = await get(rgA.url, { headers: { Range: 'bytes=0-99' } });
  eq(f.status, 206, 'Range → 206');
  eq(f.headers.get('content-range'), `bytes 0-99/${pdf.length}`, 'Content-Range');
  eq((await f.arrayBuffer()).byteLength, 100, '100 bytes');
  // Errors never carry the PDF headers (no cacheable « application/pdf » JSON); a malformed Range is ignored.
  f = await get(rgA.url, { headers: { Range: `bytes=${pdf.length + 10}-` } });
  eq(f.status, 416, 'Range outside the file → 416');
  ok(!f.headers.get('content-disposition') && !/pdf/.test(f.headers.get('content-type') || '') && f.headers.get('cache-control') === 'no-store',
    `416 without PDF headers (${f.headers.get('content-type')} / ${f.headers.get('cache-control')} / ${f.headers.get('content-disposition')})`);
  eq(f.headers.get('content-range'), `bytes */${pdf.length}`, 'Content-Range of the 416');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { Range: 'bytes=abc' } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [200, pdf.length], 'malformed Range ignored → 200');
  f = await get(rgA.url.slice(0, -3) + 'abc');
  ok(f.status === 403 && !f.headers.get('content-disposition') && /json/.test(f.headers.get('content-type') || '') && f.headers.get('cache-control') === 'no-store', 'error: JSON never cached');
  await f.arrayBuffer();
  eq((await get(rgA.url.replace('/RG/', '/HRCS/'))).status, 403, 'key of another book → 403');
  eq((await get(rgA.url.slice(0, -3) + 'abc')).status, 403, 'forged key → 403');

  // Forged keys signed with the server key: expired, wrong table (book restricted), unknown user.
  process.env.SR_RUNTIME_DIR = runtime;
  const { signRaw, sessionTag } = await import('../server/lib/books/access.ts');
  const kdir = path.join(runtime, 'books');
  const now = Math.floor(Date.now() / 1000);
  const fileUrl = (code: string, data: Record<string, unknown>) => `/api/books/${code}/file?k=${encodeURIComponent(signRaw(kdir, { c: code, e: now + 600, s: sessionTag(gmA), ...data }))}`;
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm' }))).status, 200, 'valid forged key (control)');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm', s: undefined }))).status, 403, 'key without session → 403');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm', s: sessionTag(pA) }))).status, 403, 'another user’s session → 403');
  eq((await get(`/api/books/RG/file?k=${encodeURIComponent(signWith(legacyKey, { t: 'alpha', u: 'gm', s: sessionTag(gmA), c: 'RG', e: now + 600 }))}`)).status, 403, 'link signed with the old copied key → 403');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm', e: now - 5 }))).status, 403, 'expired key → 403');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'u_unknown' }))).status, 403, 'unknown user → 403');
  eq((await get(fileUrl('RG', { t: 'nope', u: 'gm' }))).status, 403, 'unknown table → 403');

  // ----- admin: permissions -----
  eq((await adminReq('/api/admin/books', { token: '' })).status, 401, 'admin books without token → 401');
  eq((await adminReq('/api/admin/books', { token: gmA })).status, 401, 'admin books with a GM token → 401');
  r = await json(await adminReq('/api/admin/books'));
  eq(r.status, 200, 'admin: list');
  ok(r.body.books.length === 2 && r.body.tables.some((t: { id: string }) => t.id === 'beta') && r.body.known.some((k: { code: string }) => k.code === 'SR5'), 'admin: books, tables, known codes');

  // Restrict the extra book to table alpha.
  r = await json(await adminReq('/api/admin/books/HRCS', { method: 'PATCH', body: { tables: ['alpha', 'zzz'] } }));
  eq(r.body?.book?.tables, ['alpha'], 'allowed tables (unknown ones ignored)');
  r = await json(await get('/api/books', { token: gmB, table: 'beta' }));
  ok(r.body.books.some((b: LibBook) => b.code === 'RG') && !r.body.books.some((b: LibBook) => b.code === 'HRCS'), 'table beta: restricted book missing');
  eq((await get(fileUrl('HRCS', { t: 'beta', u: 'gm', s: sessionTag(gmB) }))).status, 403, 'wrong table → 403');
  // A known book restricted to another table is listed as missing (no hint that it exists elsewhere).
  await adminReq('/api/admin/books/RG', { method: 'PATCH', body: { tables: ['alpha'] } });
  r = await json(await get('/api/books', { token: gmB, table: 'beta' }));
  ok(!r.body.books.some((b: LibBook) => b.code === 'RG') && r.body.missing.some((b: MissingBook) => b.code === 'RG'), 'table beta: RG restricted to alpha → listed as missing');
  await adminReq('/api/admin/books/RG', { method: 'PATCH', body: { tables: 'all' } });
  // A restricted book answers exactly like an unknown one (no list of the server's books for other tables).
  for (const p of ['link', 'page/1?pdf=1']) {
    const restricted = await json(await get(`/api/books/HRCS/${p}`, { token: gmB, table: 'beta' }));
    const unknown = await json(await get(`/api/books/ZZZ/${p}`, { token: gmB, table: 'beta' }));
    eq([restricted.status, restricted.body], [404, unknown.body], `forbidden book = unknown book (${p})`);
  }
  eq((await get('/api/books/search?q=cheat&code=HRCS', { token: gmB, table: 'beta' })).status, 403, 'search in a forbidden book → 403');
  r = await json(await get('/api/books/search?q=cheat', { token: gmB, table: 'beta' }));
  eq(r.body.hits.length, 0, 'global search: nothing from the forbidden book');
  r = await json(await get('/api/books/HRCS/link', { token: gmA, table: 'alpha' }));
  ok(r.status === 200 && /^\/api\/books\/HRCS\/file\?k=/.test(r.body.url), 'table alpha: link of the restricted book');
  eq((await get(r.body.url)).status, 200, 'table alpha: PDF of the restricted book');

  // ----- search -----
  r = await json(await get('/api/books/search?q=heritage', { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h: SearchHit) => [h.code, h.page, h.pdfPage]), [['RG', 2, 3]], 'search « heritage » → RG p. 2 (PDF 3)');
  ok(r.body.hits[0].marks.length >= 1 && /HERITAGE/.test(r.body.hits[0].snippet), 'snippet + highlight');
  r = await json(await get('/api/books/search?q=ZOE', { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h: SearchHit) => h.page), [2], 'ignoring accents and case (Zoé)');
  r = await json(await get(`/api/books/search?q=${encodeURIComponent('"adept power"')}`, { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h: SearchHit) => [h.page, h.pdfPage]), [[6, 8]], 'exact phrase → p. 6 after the insert (PDF 8)');
  r = await json(await get(`/api/books/search?q=${encodeURIComponent('"power adept"')}`, { token: pA, table: 'alpha' }));
  eq(r.body.hits.length, 0, 'phrase out of order: nothing');
  r = await json(await get('/api/books/search?q=garage+reflexes', { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h: SearchHit) => h.page), [6], 'all words required');
  r = await json(await get('/api/books/search?q=x', { token: pA, table: 'alpha' }));
  eq(r.body.hits.length, 0, 'query too short');
  eq((await get('/api/books/search?q=heritage')).status, 401, 'search without session → 401');

  // ----- page text -----
  r = await json(await get('/api/books/RG/page/6', { token: pA, table: 'alpha' }));
  ok(r.status === 200 && r.body.pdfPage === 8 && r.body.page === 6 && /IMPROVED REFLEXES/.test(r.body.text), 'text of printed p. 6');
  r = await json(await get('/api/books/RG/page/6?pdf=1', { token: pA, table: 'alpha' }));
  ok(r.body.pdfPage === 6 && /COLOR INSERT/.test(r.body.text), 'text of PDF page 6 (insert)');
  eq((await get('/api/books/XX/page/1', { token: pA, table: 'alpha' })).status, 404, 'missing book → 404');
  eq((await get('/api/books/RG/page/99', { token: pA, table: 'alpha' })).status, 404, 'printed page outside the book → 404 (not the last page)');
  eq((await get('/api/books/RG/page/99?pdf=1', { token: pA, table: 'alpha' })).status, 404, 'PDF page outside the book → 404');

  // ----- admin: upload, offsets, re-index, delete -----
  eq((await adminReq('/api/admin/books/upload?code=UP', { method: 'POST', body: pdf, token: gmA })).status, 401, 'upload by a GM → 401');
  eq((await adminReq('/api/admin/books/upload?code=UP', { method: 'POST', body: Buffer.from('hello, not a pdf') })).status, 400, 'not a PDF → 400');
  eq((await adminReq('/api/admin/books/upload?code=b@d', { method: 'POST', body: pdf })).status, 400, 'invalid code → 400');
  eq((await adminReq('/api/admin/books/upload?code=RG', { method: 'POST', body: pdf })).status, 409, 'existing code without « replace » → 409');
  r = await json(await adminReq('/api/admin/books/upload?code=up', { method: 'POST', body: pdf, headers: { 'X-Filename': encodeURIComponent('Mon livré.pdf') } }));
  eq(r.status, 200, 'admin upload');
  let up = null;
  for (let i = 0; i < 100 && !up?.indexed; i++) {
    await new Promise((res) => setTimeout(res, 150));
    up = (await json(await adminReq('/api/admin/books'))).body.books.find((b: LibraryBook) => b.code === 'UP');
  }
  ok(up?.indexed && up.pages === 9 && up.offset === 1 && up.offsets?.[0]?.fromPrinted === 5, `background indexing (${JSON.stringify(up)})`);
  eq(up?.source, 'Mon livré.pdf', 'original file name');
  r = await json(await adminReq('/api/admin/books/UP', { method: 'PATCH', body: { offset: 5, offsets: [] } }));
  ok(r.body.book.offset === 5 && r.body.book.manual && !r.body.book.offsets, 'manual offset');
  r = await json(await get('/api/books', { token: pA, table: 'alpha' }));
  eq(r.body.books.find((b: LibBook) => b.code === 'UP')?.offset, 5, 'new offset visible to players');
  r = await json(await adminReq('/api/admin/books/UP/detect?apply=0', { method: 'POST' }));
  ok(r.body.book.offset === 1 && r.body.book.offsets?.length === 1 && r.body.applied === false, '« Detect » as a preview (apply=0)');
  const afterPreview = (await json(await adminReq('/api/admin/books'))).body.books.find((b: LibraryBook) => b.code === 'UP');
  ok(afterPreview.offset === 5 && afterPreview.manual, 'the preview does not change the book (Cancel possible)');
  r = await json(await adminReq('/api/admin/books/UP/detect', { method: 'POST' }));
  ok(r.body.book.offset === 1 && !r.body.book.manual && r.body.book.offsets?.length === 1, '« Detect » restores the offset');
  eq((await adminReq('/api/admin/books/UP/reindex', { method: 'POST', body: {} })).status, 200, 're-index');
  eq((await adminReq('/api/admin/books/UP', { method: 'PATCH', body: { offset: 'abc' } })).status, 400, 'invalid offset → 400');
  for (let i = 0; i < 100; i++) {
    const j = (await json(await adminReq('/api/admin/books'))).body.jobs.find((x: JobInfo) => x.code === 'UP');
    if (!j || j.state === 'done' || j.state === 'error') break;
    await new Promise((res) => setTimeout(res, 150));
  }
  eq((await adminReq('/api/admin/books/UP', { method: 'DELETE', body: {} })).status, 400, 'delete without confirmation → 400');
  eq((await adminReq('/api/admin/books/UP', { method: 'DELETE', body: { confirm: 'UP' }, token: gmA })).status, 401, 'delete by a GM → 401');
  eq((await adminReq('/api/admin/books/UP', { method: 'DELETE', body: { confirm: 'UP' } })).status, 200, 'delete');
  ok(!fs.existsSync(path.join(runtime, 'books', 'UP.pdf')) && !fs.existsSync(path.join(runtime, 'books', 'index', 'UP.json')), 'files removed');
  eq((await get('/api/books/UP/link', { token: pA, table: 'alpha' })).status, 404, 'deleted book → 404');

  // ----- links die with their session -----
  r = await json(await get('/api/books', { token: gmA, table: 'alpha' }));
  const gmLink = r.body.books.find((b: LibBook) => b.code === 'RG').url;
  eq((await get(gmLink)).status, 200, 'GM link valid');
  eq((await adminReq('/api/admin/tables/alpha/gm-password', { method: 'POST', body: { password: 'new-secret' } })).status, 200, 'GM password changed (GM sessions removed)');
  eq((await get(gmLink)).status, 403, 'GM link died with its session');
  eq((await get(rgA.url)).status, 200, 'player link still valid');
} finally {
  await srv.stopAndWait();
}

// ---------------------------------------------------------------------------
console.log('Indexing memory guard…');
const srv2 = await startServer({ port: PORT2, runtime: runtime2, tables: [{ id: 'alpha', pack: 'blank', gmPassword: 'secret-a' }], env: { SR_MEMORY_LIMIT_BYTES: '1000000' } });
try {
  const admin2 = await srv2.admin();
  const req2 = (p: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) =>
    fetch(srv2.url + p, { method, headers: { Authorization: `Bearer ${admin2}`, 'Content-Type': body instanceof Buffer ? 'application/octet-stream' : 'application/json' }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });
  let r = await json(await req2('/api/admin/books/upload?code=UP2', { method: 'POST', body: pdf }));
  ok(r.status === 507 && r.body.errorKey?.startsWith('Not enough memory') && r.body.error?.startsWith('Not enough memory to index this book (1 MB needed') && r.body.params?.free === 0, `upload refused for lack of memory (${r.status} ${r.body?.error})`);
  ok(!fs.existsSync(path.join(runtime2, 'books', 'UP2.pdf')), 'nothing written');
  eq((await req2('/api/admin/books/RG/reindex', { method: 'POST', body: {} })).status, 200, 're-index requested');
  let job = null;
  for (let i = 0; i < 50 && !(job && ['error', 'done'].includes(job.state)); i++) {
    await new Promise((res) => setTimeout(res, 100));
    job = (await json(await req2('/api/admin/books'))).body.jobs.find((j: JobInfo) => j.code === 'RG');
  }
  ok(job?.state === 'error' && job.error.startsWith('Not enough memory') && job.errorParams?.need >= 0, `job refused for lack of memory (${JSON.stringify(job)})`);
} finally {
  await srv2.stopAndWait();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(`${passed} OK, ${failed} failed`);
process.exit(failed ? 1 : 0);
