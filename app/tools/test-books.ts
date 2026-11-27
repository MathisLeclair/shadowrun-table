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
import { memoryVerdict } from '../server/lib/books/jobs.ts';
import { readBytes } from '../server/lib/books/pdftext.ts';
import { cacheKey, parseCacheKey, planEviction, staleEntries, cachedByCode, pickBackendName, downloadOptions, MAX_BOOKS, MAX_BYTES } from '../client/modules/books/cachepolicy.ts';
import { queryTerms, findMatches, splitByRanges, computeTops, pageAt, scaleFor, zoomStep, outputScale, clampScale } from '../client/modules/books/readerlib.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3420 + (process.pid % 10);
const PORT2 = 3430 + (process.pid % 10); // memory-guard server (env SR_MEMORY_LIMIT_BYTES)
let failed = 0;
let passed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗', msg);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// Minimal PDF writer (Helvetica, WinAnsi): pages = [[{ x, y, size, text }]]
// ---------------------------------------------------------------------------
function pdfString(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c > 126) out += '\\' + c.toString(8).padStart(3, '0'); // WinAnsi = Latin-1 for é, à…
    else out += ch;
  }
  return `(${out})`;
}
export function makePdf(pages, { width = 612, height = 792 } = {}) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
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
  const offsets = [];
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
  const folio = (n) => (n ? [{ x: 300, y: 30, size: 9, text: String(n) }] : []);
  const noise = [{ x: 60, y: 30, size: 9, text: 'TEST HEAVEN' }, { x: 140, y: 30, size: 9, text: '3' }];
  const body = (t) => [{ x: 72, y: 700, size: 12, text: t }];
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
console.log('Fonctions pures…');
{
  // cover, printed 1-4, unnumbered insert, printed 5-7; « 3 » in every footer (noise, but also the real folio of p. 3)
  const edges = [[], [1, 3], [2, 3], [3], [4, 3], [3], [5, 3], [6, 3], [7, 3]];
  const d = detectOffsets(edges);
  eq(d.offset, 1, 'offset de base');
  eq(d.offsets, [{ fromPrinted: 5, offset: 2 }], 'plage après l’encart');
  ok(d.confidence > 0.95, `confiance ${d.confidence}`);
  const book = { offset: 1, offsets: d.offsets, pages: 9 };
  eq([1, 2, 3, 4, 5, 6, 7].map((n) => printedToPdf(book, n)), [2, 3, 4, 5, 7, 8, 9], 'imprimé → PDF');
  eq([2, 3, 4, 5, 7, 8, 9].map((p) => pdfToPrinted(book, p)), [1, 2, 3, 4, 5, 6, 7], 'PDF → imprimé');
  eq(pdfToPrinted(book, 1), null, 'couverture sans numéro');
  eq([1, 5, 7].map((n) => clientPrintedToPdf(book, n)), [2, 7, 9], 'client : imprimé → PDF');
  eq(clientPdfToPrinted(book, 8), 6, 'client : PDF → imprimé');
  const flat = detectOffsets(Array.from({ length: 40 }, (_, i) => (i < 2 ? [] : [i - 1])));
  eq([flat.offset, flat.offsets], [2, null], 'décalage constant');
  eq(detectOffsets([[], []]).confidence, 0, 'pas de folio');
  eq(cleanOffsets([{ fromPrinted: 'x' }, { fromPrinted: 10, offset: 3 }]), [{ fromPrinted: 10, offset: 3 }], 'cleanOffsets');
  eq(parseQuery('Zoé "Hack on the fly" a').map((t) => t.text), ['hack on the fly', 'zoe'], 'parseQuery');
  eq(fold('Élan-Vital').length, 'Élan-Vital'.length, 'fold garde les positions');
  const doc = { texts: ['Something about HERITAGE armor', 'The Heritage line by Zoé', 'heritages? no: inheritance'], folded: [] };
  doc.folded = doc.texts.map(fold);
  const hits = searchPages(doc, parseQuery('heritage'));
  eq(hits.map((h) => h.pdfPage).sort(), [1, 2, 3], 'début de mot (heritages compte, inheritance non)');
  ok(hits.find((h) => h.pdfPage === 1).score > hits.find((h) => h.pdfPage === 2).score, 'titre en capitales classé devant');
  eq(searchPages(doc, parseQuery('inheritance')).length, 1, 'mot entier');
  eq(parseSourceRef('RG 62'), { code: 'RG', page: 62 }, 'parseSourceRef RG 62');
  eq(parseSourceRef('SR5 p. 240'), { code: 'SR5', page: 240 }, 'parseSourceRef SR5 p. 240');
  eq(parseSourceRef('sr5 p.240'), { code: 'SR5', page: 240 }, 'parseSourceRef sr5 p.240');
  eq(parseSourceRef({ source: 'RG', page: '62' }), { code: 'RG', page: 62 }, 'parseSourceRef objet');
  eq(parseSourceRef('RF 221, SR5 12'), { code: 'RF', page: 221 }, 'parseSourceRef liste');
  eq(parseSourceRef('GH3'), { code: 'GH3', page: null }, 'parseSourceRef code seul');
  eq(parseSourceRef(''), null, 'parseSourceRef vide');

  // A printed page outside the book is unknown (null), never clamped to the last page.
  eq([printedToPdf(book, 7), printedToPdf(book, 8), printedToPdf(book, 999)], [9, null, null], 'page imprimée hors du livre → null');
  eq([clientPrintedToPdf(book, 8), clientPrintedToPdf({ offset: -5, pages: 9 }, 3)], [null, null], 'client : page hors du livre → null');

  // fold(): same output as the per-char reference, without retaining a rope of one-char strings (≈ 300 MB for a library).
  const refCache = new Map();
  const refChar = (c) => {
    let x = refCache.get(c);
    if (x === undefined) {
      x = c.normalize('NFD')[0].toLowerCase()[0] || c;
      if (/[‐‑‒–—\-_’'`´]/.test(x)) x = x === '’' || x === "'" || x === '`' || x === '´' ? "'" : ' ';
      refCache.set(c, x);
    }
    return x;
  };
  const refFold = (str) => String(str || '').split('').map(refChar).join('');
  for (const sample of ['Élan-Vital — Zoé’s « HACK » on_the`fly', 'ÆØ ß İ ﬁ 😀 ½ ２ Ⅻ', 'plain ascii 123', '', null])
    eq(fold(sample), refFold(sample), `fold identique (${sample})`);
  const bigPages = Array.from({ length: 1000 }, (_, i) => `PAGE ${i} Les règles d’Édge — ${'Zoé hack on the fly, réflexes améliorés. '.repeat(100)}`);
  const heap0 = process.memoryUsage().heapUsed;
  const foldedPages = bigPages.map(fold);
  const grown = (process.memoryUsage().heapUsed - heap0) / 1e6;
  ok(grown < 70 && foldedPages[999].length === bigPages[999].length, `fold : ${grown.toFixed(1)} Mo retenus pour 4 M caractères (avant : ≈ 140 Mo)`);

  // Memory guard of indexing jobs: 6 × the PDF must fit in the container limit minus the server's RSS.
  eq(memoryVerdict(40e6, { limit: 512e6, rss: 150e6 }).ok, true, 'mémoire : SR5 (40 Mo) tient');
  eq(memoryVerdict(100e6, { limit: 512e6, rss: 150e6 }), { ok: false, need: 600, free: 362 }, 'mémoire : PDF de 100 Mo refusé');
  eq(memoryVerdict(1e9, { limit: null, rss: 1 }).ok, true, 'mémoire : limite inconnue → accepté');

  // readBytes(): the file's bytes (view over the Buffer, no second copy), small pooled files too.
  const bytesFile = path.join(os.tmpdir(), `sr-books-bytes-${process.pid}.bin`);
  for (const size of [10, 300000]) {
    const data = crypto.randomBytes(size);
    fs.writeFileSync(bytesFile, data);
    const u = readBytes(bytesFile);
    ok(u instanceof Uint8Array && Buffer.compare(Buffer.from(u.buffer, u.byteOffset, u.byteLength), data) === 0, `readBytes ${size} octets`);
  }
  fs.rmSync(bytesFile, { force: true });
}

// ---------------------------------------------------------------------------
console.log('Lecteur : cache et mise en page (fonctions pures)…');
{
  // Cache key = code + version, never the signed URL.
  eq(cacheKey({ code: 'rg', version: 'abc-12', url: '/api/books/RG/file?k=x' }), 'RG@abc-12', 'clé de cache = code@version');
  eq([cacheKey({ code: 'RG' }), cacheKey({ code: 'RG', version: 'a/b' }), cacheKey({ code: '../x', version: 'a' })], [null, null, null], 'clé de cache invalide → null');
  eq(parseCacheKey('SR5@1a-2b'), { code: 'SR5', version: '1a-2b' }, 'parseCacheKey');
  eq(parseCacheKey('bad'), null, 'parseCacheKey invalide');
  const MB = 1024 * 1024;
  const e = (key, size, usedAt) => ({ key, size: size * MB, usedAt });
  // Another version of the book being stored goes first; then the least recently used, until the budget fits.
  let plan = planEviction([e('RG@old', 30, 900), e('SR5@v', 40, 100), e('SG@v', 20, 50)], { key: 'RG@new', size: 30 * MB }, { maxBytes: 100 * MB });
  eq(plan, { evict: ['RG@old'], store: true }, 'ancienne version du livre retirée');
  plan = planEviction([e('SR5@v', 40, 100), e('SG@v', 20, 50), e('CF@v', 30, 300)], { key: 'RG@new', size: 30 * MB }, { maxBytes: 100 * MB });
  eq(plan, { evict: ['SG@v'], store: true }, 'moins récemment lu retiré (budget en octets)');
  plan = planEviction([e('A@1', 1, 3), e('B@1', 1, 1), e('C@1', 1, 2)], { key: 'D@1', size: MB }, { maxBooks: 2, maxBytes: 100 * MB });
  eq(plan, { evict: ['B@1', 'C@1'], store: true }, 'nombre de livres plafonné (LRU)');
  plan = planEviction([e('A@1', 1, 3)], { key: 'D@1', size: 700 * MB });
  eq(plan, { evict: [], store: false }, 'livre plus gros que le budget : lu sans être gardé');
  plan = planEviction([e('A@1', 50, 1), e('B@1', 50, 2)], { key: 'C@1', size: 60 * MB }, { maxBytes: 100 * MB, keep: ['A@1'] });
  eq(plan, { evict: ['B@1'], store: false }, 'clé protégée jamais retirée');
  eq(planEviction([e('RG@v', 30, 1)], { key: 'RG@v', size: 30 * MB }).evict, [], 'même clé : rien à retirer');
  eq([MAX_BOOKS, MAX_BYTES / MB], [12, 600], 'plafonds par défaut (12 livres / 600 Mo)');
  const books = [{ code: 'RG', version: 'new' }, { code: 'SR5', version: 'v' }];
  eq(staleEntries([e('RG@old', 1, 1), e('SR5@v', 1, 1), e('XX@1', 1, 1), { key: 'junk' }], books), ['RG@old', 'junk'], 'versions remplacées retirées, livres inconnus gardés');
  eq([...cachedByCode([e('RG@old', 1, 1), e('SR5@v', 2, 1)], books).keys()], ['SR5'], '« en cache » seulement pour la version actuelle');
  eq(
    [pickBackendName({ secure: true, hasCaches: true, hasIdb: true }), pickBackendName({ secure: false, hasCaches: true, hasIdb: true }), pickBackendName({ secure: false, hasCaches: false, hasIdb: false })],
    ['cache', 'idb', 'none'],
    'Cache Storage en contexte sécurisé, IndexedDB sur http://<ip> (production), sinon rien'
  );
  // Regression: with a persistent cache the HTTP cache must not keep a second copy of the PDF; the download is abortable.
  const sig = { aborted: false };
  eq(downloadOptions({ persistent: true, signal: sig }), { credentials: 'same-origin', signal: sig, cache: 'no-store' }, 'cache persistant : téléchargement en no-store, annulable');
  eq(downloadOptions({ persistent: false }), { credentials: 'same-origin' }, 'sans cache persistant : cache HTTP du navigateur');

  // Highlight of the search terms in a page's text layer.
  eq(queryTerms('"Hack on the fly" Zoé a'), ['hack', 'the', 'fly', 'zoe', 'on'], 'termes à surligner');
  eq(findMatches('Zoé: Heritage line, HERITAGES and inheritance', ['heritage', 'zoe']), [[0, 3], [5, 13], [20, 28]], 'surlignage en début de mot, sans accents ni casse');
  eq(splitByRanges('Edge rules', [[0, 4]]), [{ text: 'Edge', hit: true }, { text: ' rules', hit: false }], 'découpage du texte');
  eq(findMatches('hacking', ['hack', 'hacking']), [[0, 7]], 'plages fusionnées');

  // Continuous-scroll layout.
  const { tops, total } = computeTops([100, 200, 100], 10);
  eq([tops, total], [[10, 120, 330], 440], 'hauts des pages');
  eq([pageAt(tops, 0), pageAt(tops, 119), pageAt(tops, 120), pageAt(tops, 5000)], [1, 1, 2, 3], 'page sous une position');
  eq(scaleFor('width', { width: 612, height: 792 }, { width: 612, height: 400 }), 1, 'largeur de page');
  ok(Math.abs(scaleFor('page', { width: 612, height: 792 }, { width: 612, height: 396 }) - 0.5) < 1e-9, 'page entière');
  eq([scaleFor(9, { width: 1, height: 1 }, { width: 1, height: 1 }), clampScale(0.01)], [5, 0.25], 'zoom borné');
  eq([zoomStep(1, 1), zoomStep(1, -1), zoomStep(1.05, 1), zoomStep(5, 1), zoomStep(0.25, -1)], [1.1, 0.9, 1.1, 5, 0.25], 'paliers de zoom');
  eq([outputScale(800, 1000, 2), outputScale(800, 1000, 3), outputScale(800, 1000, 1)], [2, 2, 1], 'canvas HiDPI (densité max 2)');
  ok(outputScale(4000, 5000, 2) ** 2 * 4000 * 5000 <= 16e6 + 1, 'canvas plafonné à 16 Mpx');
}

// ---------------------------------------------------------------------------
console.log('Installation (tools/books-setup.ts)…');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-books-test-'));
const src = path.join(tmp, 'pdfs');
const runtime = path.join(tmp, 'runtime');
fs.mkdirSync(src, { recursive: true });
const pdf = fixtureBook();
fs.writeFileSync(path.join(src, 'Shadowrun_5E_Run___Gun.pdf'), pdf);
fs.writeFileSync(path.join(src, 'House rules cheat sheet.pdf'), makePdf([[{ x: 72, y: 700, size: 12, text: 'Matrix cheat sheet house rules' }]]));
const srcBefore = fs.readFileSync(path.join(src, 'Shadowrun_5E_Run___Gun.pdf'));
const setup = spawnSync(process.execPath, ['tools/books-setup.ts', '--from', src, '--runtime', runtime], { cwd: ROOT, encoding: 'utf8' });
ok(setup.status === 0, `books-setup exit ${setup.status}: ${setup.stderr}`);
const libPath = path.join(runtime, 'books', 'library.json');
const lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const rg = lib.books.find((b) => b.code === 'RG');
ok(!!rg, 'Run & Gun reconnu par son nom de fichier (code RG)');
eq([rg?.pages, rg?.offset, rg?.offsets], [9, 1, [{ fromPrinted: 5, offset: 2 }]], 'pages + décalages détectés');
eq(rg?.name, 'Run and Gun', 'nom Chummer');
eq(rg?.nameFr, 'Run & Gun', 'nom français');
const extra = lib.books.find((b) => b.extra);
ok(extra && extra.code === 'HRCS', `PDF hors Chummer : code par initiales (${extra?.code})`);
ok(fs.existsSync(path.join(runtime, 'books', 'RG.pdf')) && fs.existsSync(path.join(runtime, 'books', 'index', 'RG.json')), 'PDF copié + index');
ok(Buffer.compare(srcBefore, fs.readFileSync(path.join(src, 'Shadowrun_5E_Run___Gun.pdf'))) === 0, 'PDF source intact');
ok(/RG\s+9\s+\+1 p\.5→\+2/.test(setup.stdout), 'tableau récapitulatif');
// Copy of the installed library for the memory-guard server (startServer's stop removes the runtime).
const runtime2 = path.join(tmp, 'runtime2');
fs.cpSync(path.join(runtime, 'books'), path.join(runtime2, 'books'), { recursive: true });
// An older version kept the HMAC key in the books folder, which gets copied from the PC to the VPS: plant one.
const legacyKey = crypto.randomBytes(32);
fs.writeFileSync(path.join(runtime, 'books', '.sign-key'), legacyKey.toString('hex'));
const signWith = (key, data) => {
  const p = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', key).update(p).digest('base64url')}`;
};

// ---------------------------------------------------------------------------
console.log('Serveur…');
const srv = await startServer({
  port: PORT,
  runtime,
  tables: [{ id: 'alpha', pack: 'vierge', gmPassword: 'secret-a' }, { id: 'beta', pack: 'vierge', gmPassword: 'secret-b' }],
});
const U = srv.url;
const get = (p, { token, table, headers = {} } = {}) => fetch(U + p, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(table ? { 'X-SR-Table': table } : {}), ...headers } });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
try {
  const gmA = await login(U, { role: 'gm', password: 'secret-a', table: 'alpha' });
  const gmB = await login(U, { role: 'gm', password: 'secret-b', table: 'beta' });
  const pA = await login(U, { role: 'player', name: 'Lectrice', table: 'alpha' });
  const admin = await srv.admin();
  const adminReq = (p, { method = 'GET', body, token = admin, headers = {} } = {}) =>
    fetch(U + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/octet-stream' }), ...headers }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });

  // ----- list -----
  eq((await get('/api/books')).status, 401, 'liste sans session → 401');
  let r = await json(await get('/api/books', { token: pA, table: 'alpha' }));
  eq(r.status, 200, 'liste joueur');
  const rgA = r.body.books.find((b) => b.code === 'RG');
  ok(rgA && /^\/api\/books\/RG\/file\?k=/.test(rgA.url) && rgA.offset === 1 && rgA.offsets.length === 1, 'livre RG listé avec lien signé');
  ok(!('tables' in rgA) && !('source' in rgA), 'pas de détails serveur dans la liste');
  ok(Math.abs(r.body.now - Date.now()) < 60000, 'horloge du serveur dans la liste (now)');
  ok(!fs.existsSync(path.join(runtime, 'books', '.sign-key')), 'ancienne clé du dossier des livres supprimée');
  ok(/^[0-9a-f]{64}$/.test(fs.readFileSync(path.join(runtime, 'books-sign.key'), 'utf8')), 'clé de signature hors du dossier des livres');

  // ----- reader cache: version, stable links, pdf.js -----
  ok(/^[0-9a-z]+-[0-9a-z]+$/.test(rgA.version || '') && rgA.size === pdf.length, `version + taille dans la liste (${rgA.version} / ${rgA.size})`);
  ok(rgA.exp - Date.now() / 1000 >= 86400 - 5, 'lien valable au moins 24 h');
  const again = await json(await get('/api/books', { token: pA, table: 'alpha' }));
  eq(again.body.books.find((b) => b.code === 'RG').url, rgA.url, 'même lien d’une requête à l’autre (cache navigateur)');
  {
    process.env.SR_RUNTIME_DIR = runtime;
    const { signLink } = await import('../server/lib/books/access.ts');
    const day = Math.floor(Date.now() / 86400000) * 86400000;
    const args = [path.join(runtime, 'books'), { tableId: 'alpha', userId: 'gm', session: 'x', code: 'RG' }];
    const a = signLink(...args, { now: day + 1000 });
    const b = signLink(...args, { now: day + 23 * 3600 * 1000 });
    ok(a.k === b.k && a.exp * 1000 >= day + 23 * 3600 * 1000 + 86400 * 1000, 'signature stable sur toute la journée, valable 24 h après');
    ok(signLink(...args, { now: day + 86400 * 1000 + 1000 }).k !== a.k, 'nouveau lien le lendemain');
  }
  const base = r.body.pdfjs;
  ok(/^\/vendor\/pdfjs\/\d+\.\d+\.\d+$/.test(base || ''), `pdf.js servi par l’application (${base})`);
  for (const p of ['/build/pdf.min.mjs', '/build/pdf.worker.min.mjs', '/legacy/build/pdf.min.mjs', '/legacy/build/pdf.worker.min.mjs']) {
    const v = await fetch(U + base + p, { method: 'HEAD' });
    ok(v.status === 200 && /javascript/.test(v.headers.get('content-type') || '') && /immutable/.test(v.headers.get('cache-control') || ''), `${p} : ${v.status} ${v.headers.get('content-type')} ${v.headers.get('cache-control')}`);
  }
  for (const p of ['/cmaps/Adobe-Japan1-UCS2.bcmap', '/standard_fonts/FoxitSerif.pfb']) eq((await fetch(U + base + p, { method: 'HEAD' })).status, 200, `pdf.js ${p}`);
  for (const p of ['/package.json', '/build/pdf.mjs.map', '/web/pdf_viewer.mjs', '/build/../package.json', '/%2e%2e/package.json'])
    eq((await fetch(U + base + p)).status, 404, `pdf.js : ${p} non servi`);
  {
    const miss = await fetch(U + base + '/cmaps/Absent-Map.bcmap');
    ok(miss.status === 404 && /json/.test(miss.headers.get('content-type') || ''), 'pdf.js : fichier absent → 404 JSON (pas de pile ENOENT)');
  }

  // ----- file -----
  eq((await get('/api/books/RG/file')).status, 401, 'PDF sans clé → 401');
  let f = await get(rgA.url);
  eq(f.status, 200, 'PDF avec clé → 200');
  eq(f.headers.get('content-type'), 'application/pdf', 'type PDF');
  ok(/^inline/.test(f.headers.get('content-disposition') || ''), 'Content-Disposition inline');
  eq(f.headers.get('cache-control'), 'private, max-age=86400', 'Cache-Control private, 24 h');
  eq(f.headers.get('etag'), `"${rgA.version}"`, 'ETag = version du livre');
  const lastMod = f.headers.get('last-modified');
  ok(!!lastMod, 'Last-Modified');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': `"${rgA.version}"` } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [304, 0], 'If-None-Match → 304 sans corps');
  eq(f.headers.get('cache-control'), 'private, max-age=86400', '304 garde Cache-Control');
  f = await get(rgA.url, { headers: { 'Cache-Control': 'max-age=0', 'If-Modified-Since': lastMod } });
  eq(f.status, 304, 'If-Modified-Since → 304');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': '"autre"' } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [200, pdf.length], 'autre ETag → 200 complet');
  f = await get(rgA.url.slice(0, -3) + 'abc', { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': `"${rgA.version}"` } });
  eq(f.status, 403, 'If-None-Match ne contourne pas la signature');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { Range: 'bytes=0-9', 'If-Range': `"${rgA.version}"` } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [206, 10], 'If-Range avec l’ETag → 206');
  f = await get(rgA.url, { headers: { Range: 'bytes=0-9', 'If-Range': '"perime"' } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [200, pdf.length], 'If-Range périmé → 200 complet');
  // Replacing the PDF changes its version (the reader drops its cached copy) and its ETag.
  {
    const pdfPath = path.join(runtime, 'books', 'RG.pdf');
    const st = fs.statSync(pdfPath);
    fs.utimesSync(pdfPath, st.atime, new Date(st.mtimeMs + 5000));
    const rgNew = (await json(await get('/api/books', { token: pA, table: 'alpha' }))).body.books.find((b) => b.code === 'RG');
    ok(rgNew.version && rgNew.version !== rgA.version, `nouvelle version après remplacement (${rgA.version} → ${rgNew.version})`);
    f = await get(rgNew.url, { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': `"${rgA.version}"` } });
    ok(f.status === 200 && f.headers.get('etag') === `"${rgNew.version}"`, 'ancien ETag → 200 avec le nouvel ETag');
    await f.arrayBuffer();
    fs.utimesSync(pdfPath, st.atime, st.mtime);
  }
  f = await get(rgA.url);
  eq(f.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges');
  eq(Buffer.from(await f.arrayBuffer()).length, pdf.length, 'PDF complet');
  f = await get(rgA.url, { headers: { Range: 'bytes=0-99' } });
  eq(f.status, 206, 'Range → 206');
  eq(f.headers.get('content-range'), `bytes 0-99/${pdf.length}`, 'Content-Range');
  eq((await f.arrayBuffer()).byteLength, 100, '100 octets');
  // Errors never carry the PDF headers (no cacheable « application/pdf » JSON); a malformed Range is ignored.
  f = await get(rgA.url, { headers: { Range: `bytes=${pdf.length + 10}-` } });
  eq(f.status, 416, 'Range hors du fichier → 416');
  ok(!f.headers.get('content-disposition') && !/pdf/.test(f.headers.get('content-type') || '') && f.headers.get('cache-control') === 'no-store',
    `416 sans en-têtes PDF (${f.headers.get('content-type')} / ${f.headers.get('cache-control')} / ${f.headers.get('content-disposition')})`);
  eq(f.headers.get('content-range'), `bytes */${pdf.length}`, 'Content-Range du 416');
  await f.arrayBuffer();
  f = await get(rgA.url, { headers: { Range: 'bytes=abc' } });
  eq([f.status, (await f.arrayBuffer()).byteLength], [200, pdf.length], 'Range mal formé ignoré → 200');
  f = await get(rgA.url.slice(0, -3) + 'abc');
  ok(f.status === 403 && !f.headers.get('content-disposition') && /json/.test(f.headers.get('content-type') || '') && f.headers.get('cache-control') === 'no-store', 'erreur : JSON jamais mis en cache');
  await f.arrayBuffer();
  eq((await get(rgA.url.replace('/RG/', '/HRCS/'))).status, 403, 'clé d’un autre livre → 403');
  eq((await get(rgA.url.slice(0, -3) + 'abc')).status, 403, 'clé falsifiée → 403');

  // Forged keys signed with the server key: expired, wrong table (book restricted), unknown user.
  process.env.SR_RUNTIME_DIR = runtime;
  const { signRaw, sessionTag } = await import('../server/lib/books/access.ts');
  const kdir = path.join(runtime, 'books');
  const now = Math.floor(Date.now() / 1000);
  const fileUrl = (code, data) => `/api/books/${code}/file?k=${encodeURIComponent(signRaw(kdir, { c: code, e: now + 600, s: sessionTag(gmA), ...data }))}`;
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm' }))).status, 200, 'clé forgée valide (contrôle)');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm', s: undefined }))).status, 403, 'clé sans session → 403');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm', s: sessionTag(pA) }))).status, 403, 'session d’un autre utilisateur → 403');
  eq((await get(`/api/books/RG/file?k=${encodeURIComponent(signWith(legacyKey, { t: 'alpha', u: 'gm', s: sessionTag(gmA), c: 'RG', e: now + 600 }))}`)).status, 403, 'lien signé avec l’ancienne clé copiée → 403');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'gm', e: now - 5 }))).status, 403, 'clé expirée → 403');
  eq((await get(fileUrl('RG', { t: 'alpha', u: 'u_inconnu' }))).status, 403, 'utilisateur inconnu → 403');
  eq((await get(fileUrl('RG', { t: 'nope', u: 'gm' }))).status, 403, 'table inconnue → 403');

  // ----- admin: permissions -----
  eq((await adminReq('/api/admin/books', { token: '' })).status, 401, 'admin livres sans jeton → 401');
  eq((await adminReq('/api/admin/books', { token: gmA })).status, 401, 'admin livres avec un jeton MJ → 401');
  r = await json(await adminReq('/api/admin/books'));
  eq(r.status, 200, 'admin : liste');
  ok(r.body.books.length === 2 && r.body.tables.some((t) => t.id === 'beta') && r.body.known.some((k) => k.code === 'SR5'), 'admin : livres, tables, codes connus');

  // Restrict the extra book to table alpha.
  r = await json(await adminReq('/api/admin/books/HRCS', { method: 'PATCH', body: { tables: ['alpha', 'zzz'] } }));
  eq(r.body?.book?.tables, ['alpha'], 'tables autorisées (inconnues ignorées)');
  r = await json(await get('/api/books', { token: gmB, table: 'beta' }));
  ok(r.body.books.some((b) => b.code === 'RG') && !r.body.books.some((b) => b.code === 'HRCS'), 'table beta : livre restreint absent');
  eq((await get(fileUrl('HRCS', { t: 'beta', u: 'gm', s: sessionTag(gmB) }))).status, 403, 'mauvaise table → 403');
  // A restricted book answers exactly like an unknown one (no list of the server's books for other tables).
  for (const p of ['link', 'page/1?pdf=1']) {
    const restricted = await json(await get(`/api/books/HRCS/${p}`, { token: gmB, table: 'beta' }));
    const unknown = await json(await get(`/api/books/ZZZ/${p}`, { token: gmB, table: 'beta' }));
    eq([restricted.status, restricted.body], [404, unknown.body], `livre interdit = livre inconnu (${p})`);
  }
  eq((await get('/api/books/search?q=cheat&code=HRCS', { token: gmB, table: 'beta' })).status, 403, 'recherche dans un livre interdit → 403');
  r = await json(await get('/api/books/search?q=cheat', { token: gmB, table: 'beta' }));
  eq(r.body.hits.length, 0, 'recherche globale : rien du livre interdit');
  r = await json(await get('/api/books/HRCS/link', { token: gmA, table: 'alpha' }));
  ok(r.status === 200 && /^\/api\/books\/HRCS\/file\?k=/.test(r.body.url), 'table alpha : lien du livre restreint');
  eq((await get(r.body.url)).status, 200, 'table alpha : PDF du livre restreint');

  // ----- search -----
  r = await json(await get('/api/books/search?q=heritage', { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h) => [h.code, h.page, h.pdfPage]), [['RG', 2, 3]], 'recherche « heritage » → RG p. 2 (PDF 3)');
  ok(r.body.hits[0].marks.length >= 1 && /HERITAGE/.test(r.body.hits[0].snippet), 'extrait + surlignage');
  r = await json(await get('/api/books/search?q=ZOE', { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h) => h.page), [2], 'sans accents ni casse (Zoé)');
  r = await json(await get(`/api/books/search?q=${encodeURIComponent('"adept power"')}`, { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h) => [h.page, h.pdfPage]), [[6, 8]], 'expression exacte → p. 6 après l’encart (PDF 8)');
  r = await json(await get(`/api/books/search?q=${encodeURIComponent('"power adept"')}`, { token: pA, table: 'alpha' }));
  eq(r.body.hits.length, 0, 'expression dans le désordre : rien');
  r = await json(await get('/api/books/search?q=garage+reflexes', { token: pA, table: 'alpha' }));
  eq(r.body.hits.map((h) => h.page), [6], 'tous les mots requis');
  r = await json(await get('/api/books/search?q=x', { token: pA, table: 'alpha' }));
  eq(r.body.hits.length, 0, 'requête trop courte');
  eq((await get('/api/books/search?q=heritage')).status, 401, 'recherche sans session → 401');

  // ----- page text -----
  r = await json(await get('/api/books/RG/page/6', { token: pA, table: 'alpha' }));
  ok(r.status === 200 && r.body.pdfPage === 8 && r.body.page === 6 && /IMPROVED REFLEXES/.test(r.body.text), 'texte de la p. 6 imprimée');
  r = await json(await get('/api/books/RG/page/6?pdf=1', { token: pA, table: 'alpha' }));
  ok(r.body.pdfPage === 6 && /COLOR INSERT/.test(r.body.text), 'texte de la page PDF 6 (encart)');
  eq((await get('/api/books/XX/page/1', { token: pA, table: 'alpha' })).status, 404, 'livre absent → 404');
  eq((await get('/api/books/RG/page/99', { token: pA, table: 'alpha' })).status, 404, 'page imprimée hors du livre → 404 (pas la dernière page)');
  eq((await get('/api/books/RG/page/99?pdf=1', { token: pA, table: 'alpha' })).status, 404, 'page PDF hors du livre → 404');

  // ----- admin: upload, offsets, re-index, delete -----
  eq((await adminReq('/api/admin/books/upload?code=UP', { method: 'POST', body: pdf, token: gmA })).status, 401, 'envoi par un MJ → 401');
  eq((await adminReq('/api/admin/books/upload?code=UP', { method: 'POST', body: Buffer.from('hello, not a pdf') })).status, 400, 'pas un PDF → 400');
  eq((await adminReq('/api/admin/books/upload?code=b@d', { method: 'POST', body: pdf })).status, 400, 'code invalide → 400');
  eq((await adminReq('/api/admin/books/upload?code=RG', { method: 'POST', body: pdf })).status, 409, 'code existant sans « remplacer » → 409');
  r = await json(await adminReq('/api/admin/books/upload?code=up', { method: 'POST', body: pdf, headers: { 'X-Filename': encodeURIComponent('Mon livré.pdf') } }));
  eq(r.status, 200, 'envoi admin');
  let up = null;
  for (let i = 0; i < 100 && !up?.indexed; i++) {
    await new Promise((res) => setTimeout(res, 150));
    up = (await json(await adminReq('/api/admin/books'))).body.books.find((b) => b.code === 'UP');
  }
  ok(up?.indexed && up.pages === 9 && up.offset === 1 && up.offsets?.[0]?.fromPrinted === 5, `indexation en arrière-plan (${JSON.stringify(up)})`);
  eq(up?.source, 'Mon livré.pdf', 'nom du fichier d’origine');
  r = await json(await adminReq('/api/admin/books/UP', { method: 'PATCH', body: { offset: 5, offsets: [] } }));
  ok(r.body.book.offset === 5 && r.body.book.manual && !r.body.book.offsets, 'décalage manuel');
  r = await json(await get('/api/books', { token: pA, table: 'alpha' }));
  eq(r.body.books.find((b) => b.code === 'UP')?.offset, 5, 'nouveau décalage visible des joueurs');
  r = await json(await adminReq('/api/admin/books/UP/detect?apply=0', { method: 'POST' }));
  ok(r.body.book.offset === 1 && r.body.book.offsets?.length === 1 && r.body.applied === false, '« Détecter » en aperçu (apply=0)');
  const afterPreview = (await json(await adminReq('/api/admin/books'))).body.books.find((b) => b.code === 'UP');
  ok(afterPreview.offset === 5 && afterPreview.manual, 'l’aperçu ne change pas le livre (Annuler possible)');
  r = await json(await adminReq('/api/admin/books/UP/detect', { method: 'POST' }));
  ok(r.body.book.offset === 1 && !r.body.book.manual && r.body.book.offsets?.length === 1, '« Détecter » rétablit le décalage');
  eq((await adminReq('/api/admin/books/UP/reindex', { method: 'POST', body: {} })).status, 200, 'réindexation');
  eq((await adminReq('/api/admin/books/UP', { method: 'PATCH', body: { offset: 'abc' } })).status, 400, 'décalage invalide → 400');
  for (let i = 0; i < 100; i++) {
    const j = (await json(await adminReq('/api/admin/books'))).body.jobs.find((x) => x.code === 'UP');
    if (!j || j.state === 'done' || j.state === 'error') break;
    await new Promise((res) => setTimeout(res, 150));
  }
  eq((await adminReq('/api/admin/books/UP', { method: 'DELETE', body: {} })).status, 400, 'suppression sans confirmation → 400');
  eq((await adminReq('/api/admin/books/UP', { method: 'DELETE', body: { confirm: 'UP' }, token: gmA })).status, 401, 'suppression par un MJ → 401');
  eq((await adminReq('/api/admin/books/UP', { method: 'DELETE', body: { confirm: 'UP' } })).status, 200, 'suppression');
  ok(!fs.existsSync(path.join(runtime, 'books', 'UP.pdf')) && !fs.existsSync(path.join(runtime, 'books', 'index', 'UP.json')), 'fichiers effacés');
  eq((await get('/api/books/UP/link', { token: pA, table: 'alpha' })).status, 404, 'livre supprimé → 404');

  // ----- links die with their session -----
  r = await json(await get('/api/books', { token: gmA, table: 'alpha' }));
  const gmLink = r.body.books.find((b) => b.code === 'RG').url;
  eq((await get(gmLink)).status, 200, 'lien du MJ valide');
  eq((await adminReq('/api/admin/tables/alpha/gm-password', { method: 'POST', body: { password: 'nouveau-secret' } })).status, 200, 'mot de passe MJ changé (sessions MJ supprimées)');
  eq((await get(gmLink)).status, 403, 'lien du MJ mort avec sa session');
  eq((await get(rgA.url)).status, 200, 'lien du joueur toujours valide');
} finally {
  await srv.stopAndWait();
}

// ---------------------------------------------------------------------------
console.log('Garde mémoire de l’indexation…');
const srv2 = await startServer({ port: PORT2, runtime: runtime2, tables: [{ id: 'alpha', pack: 'vierge', gmPassword: 'secret-a' }], env: { SR_MEMORY_LIMIT_BYTES: '1000000' } });
try {
  const admin2 = await srv2.admin();
  const req2 = (p, { method = 'GET', body } = {}) =>
    fetch(srv2.url + p, { method, headers: { Authorization: `Bearer ${admin2}`, 'Content-Type': body instanceof Buffer ? 'application/octet-stream' : 'application/json' }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });
  let r = await json(await req2('/api/admin/books/upload?code=UP2', { method: 'POST', body: pdf }));
  ok(r.status === 507 && r.body.errorKey?.startsWith('Mémoire insuffisante') && r.body.params?.free === 0, `envoi refusé faute de mémoire (${r.status} ${r.body?.error})`);
  ok(!fs.existsSync(path.join(runtime2, 'books', 'UP2.pdf')), 'rien d’écrit');
  eq((await req2('/api/admin/books/RG/reindex', { method: 'POST', body: {} })).status, 200, 'réindexation demandée');
  let job = null;
  for (let i = 0; i < 50 && !(job && ['error', 'done'].includes(job.state)); i++) {
    await new Promise((res) => setTimeout(res, 100));
    job = (await json(await req2('/api/admin/books'))).body.jobs.find((j) => j.code === 'RG');
  }
  ok(job?.state === 'error' && job.error.startsWith('Mémoire insuffisante') && job.errorParams?.need >= 0, `tâche refusée faute de mémoire (${JSON.stringify(job)})`);
} finally {
  await srv2.stopAndWait();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(`${passed} OK, ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
