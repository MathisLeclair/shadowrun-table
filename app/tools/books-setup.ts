#!/usr/bin/env node
// Rulebook library setup (see ARCHITECTURE.md « Rulebooks »).
//
//   node tools/books-setup.ts --from "C:/…/PDFs" [--runtime <dir>] [--only SR5,RG] [--map "file.pdf=CODE"] [--foundry <worldDir>]
//       copy the PDFs into <books dir>/<CODE>.pdf (code guessed from the file name, Chummer book codes), extract the
//       text of every page, detect the printed→PDF page offset(s), build the search index, write library.json,
//       then run the sanity checks. Never modifies the source PDFs.
//   node tools/books-setup.ts --reindex [CODE,…]   re-extract books already in the library
//   node tools/books-setup.ts --check              sanity checks only (known references + catalog page references)
//   node tools/books-setup.ts --list               print the library
//   node tools/books-setup.ts --names [<chummer data dir>]   regenerate server/lib/books/book-names.json
//
// <books dir> = --books <dir>, else SR_BOOKS_DIR, else <runtime>/books with <runtime> = --runtime, SR_RUNTIME_DIR or data/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { cleanCode, knownBooks, readLibrary, pdfFile, loadIndex, writeLibrary } from '../server/lib/books/library.ts';
import { QUICK_LINKS } from '../client/modules/books/quicklinks.ts';
import { indexBook } from '../server/lib/books/indexer.ts';
import { printedToPdf } from '../server/lib/books/offsets.ts';
import { fold } from '../server/lib/books/search.ts';
import type { LibraryBook } from '../server/lib/books/library.ts';
import type { CatalogItem } from '../shared/types.ts';

/** A book name entry of server/lib/books/book-names.json. */
interface BookName {
  name: string;
  nameFr: string;
  /** Chummer's reference sentence (en-us) and its printed page. */
  match?: { text: string; page: number };
}
/** guessCode() result: a book code, `extra` when it is not a Chummer book (then `name` is made from the file name). */
interface GuessedCode {
  code: string;
  extra: boolean;
  name?: string;
}
/** Foundry hints: { CODE: offset | null } plus { 'file:<pdf name>': CODE }. */
type FoundryHints = Record<string, number | string | null>;
/** A row of printTable(): a library entry plus what indexing found. */
type TableRow = LibraryBook & { numbered?: number; matchPdfPage?: number | null };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const val = (n: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  if (a) return a.slice(n.length + 3);
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const vals = (n: string): string[] => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : a.startsWith(`--${n}=`) ? [a.slice(n.length + 3)] : []));

const runtime = path.resolve(val('runtime') || process.env.SR_RUNTIME_DIR || path.join(ROOT, 'data'));
const BOOKS = path.resolve(val('books') || (val('runtime') ? path.join(runtime, 'books') : process.env.SR_BOOKS_DIR || path.join(runtime, 'books')));
const only = (val('only') || '').split(',').map(cleanCode).filter(Boolean);
const quiet = has('quiet');
const log = (...a: unknown[]) => !quiet && console.log(...a);

// ---------------------------------------------------------------------------
// --names: book names from Chummer (books.xml + lang/fr-fr_data.xml)
// ---------------------------------------------------------------------------
function buildNames(dataDir: string): Record<string, BookName> {
  const parser = new XMLParser({ ignoreAttributes: true, isArray: (n) => ['book', 'match'].includes(n) });
  // Parsed Chummer XML: dynamic shape.
  const xml: any = parser.parse(fs.readFileSync(path.join(dataDir, 'books.xml'), 'utf8'));
  const frFile = path.join(dataDir, '..', 'lang', 'fr-fr_data.xml');
  const frById: Record<string, string> = {};
  if (fs.existsSync(frFile)) {
    const fr: any = parser.parse(fs.readFileSync(frFile, 'utf8'));
    const list = fr?.chummer?.chummer?.find?.((c: any) => c?.books)?.books?.book || findBooks(fr);
    for (const b of list || []) if (b?.id) frById[b.id] = String(b.translate || '').replace(/[\u200b\u200c\u200d]/g, '');
  }
  const out: Record<string, BookName> = {};
  for (const b of xml.chummer.books.book) {
    const code = cleanCode(b.code);
    if (!code) continue;
    const m = (b.matches?.match || []).find((x: any) => x.language === 'en-us');
    out[code] = { name: String(b.name), nameFr: frById[b.id] || String(b.name), ...(m ? { match: { text: String(m.text), page: Number(m.page) } } : {}) };
  }
  return out;
}
/** Parsed XML tree (dynamic) → the <book> list, or null. */
function findBooks(node: any): any[] | null {
  // fr-fr_data.xml: <chummer><chummer file="books.xml"><books><book>… — search the tree for it.
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findBooks(n);
      if (r) return r;
    }
    return null;
  }
  if (node.books?.book && Array.isArray(node.books.book) && node.books.book[0]?.altcode !== undefined) return node.books.book;
  for (const v of Object.values(node)) {
    const r = findBooks(v);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File name → book code
// ---------------------------------------------------------------------------
const normName = (s: string) =>
  fold(s)
    .replace(/\.pdf$/i, '')
    .replace(/[()[\]]/g, '')
    .replace(/\bshadowrun\b|\b5e\b|\b5th\s*edition\b|\bfifth edition\b/g, ' ')
    .replace(/&|\band\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const ALIASES: Array<[RegExp, string]> = [
  [/core ?rules|corerulebook|^\s*$/, 'SR5'],
];
export function guessCode(fileName: string, known = knownBooks()): GuessedCode {
  const raw = path.basename(fileName);
  const n = normName(raw.replace(/^\[Shadowrun\]\s*5thEdition/i, 'core rules'));
  for (const [re, code] of ALIASES) if (re.test(n)) return { code, extra: false };
  let best: { code: string; len: number } | null = null;
  for (const [code, b] of Object.entries(known)) {
    const kn = normName(b.name);
    if (!kn) continue;
    if (n === kn || n.startsWith(kn + ' ')) if (!best || kn.length > best.len) best = { code, len: kn.length };
  }
  if (best) return { code: best.code, extra: false };
  // Not a Chummer book (cheat sheet…): initials.
  const words = n.split(' ').filter(Boolean);
  const code = cleanCode(words.map((w) => w[0]).join('').slice(0, 6)) || 'DOC';
  return { code, extra: true, name: words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') };
}

// ---------------------------------------------------------------------------
// Foundry world hints (pdfoundry / pdf-pager journal flags): { CODE: offset|null }
// ---------------------------------------------------------------------------
async function foundryHints(worldDir: string): Promise<FoundryHints> {
  const hints: FoundryHints = {};
  // A Foundry journal document (raw JSON).
  const add = (doc: any) => {
    const pd = doc?.flags?.pdfoundry?.PDFData;
    const pp = doc?.flags?.['pdf-pager'];
    for (const [code, off, url] of [[pd?.code, pd?.offset, pd?.url], [pp?.code, pp?.pageOffset, null]]) {
      if (!code) continue;
      const c = cleanCode(code === 'GH' ? 'GH3' : code);
      if (c && (hints[c] === undefined || hints[c] === null)) hints[c] = off ?? null;
      if (url && c) hints[`file:${decodeURIComponent(path.basename(url))}`] = c;
    }
  };
  const ldb = path.join(worldDir, 'data', 'journal');
  if (fs.existsSync(ldb)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-books-journal-'));
    try {
      fs.cpSync(ldb, tmp, { recursive: true });
      fs.rmSync(path.join(tmp, 'LOCK'), { force: true });
      const { ClassicLevel } = await import('classic-level');
      const db = new ClassicLevel(tmp, { valueEncoding: 'utf8' });
      for await (const [, v] of db.iterator()) {
        try {
          add(JSON.parse(v));
        } catch {}
      }
      await db.close();
    } catch (err) {
      log(`  (journal LevelDB illisible : ${(err as Error).message})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const nedb = path.join(worldDir, 'data', 'journal.db');
  if (fs.existsSync(nedb)) for (const line of fs.readFileSync(nedb, 'utf8').split('\n')) {
    try {
      add(JSON.parse(line));
    } catch {}
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------
/** Known references (printed pages) that must contain a word. */
export const REFERENCES = [
  { code: 'RG', page: 62, text: 'Heritage', what: 'Zoé: Heritage (armor)' },
  { code: 'SR5', page: 240, text: 'Hack on the Fly', what: 'Hack on the Fly (Matrix action)' },
  { code: 'SR5', page: 309, text: 'Improved Reflexes', what: 'Improved Reflexes (adept power, p. 309-310)', alt: [310] },
  { code: 'SR5', page: 310, text: 'Kinesics', what: 'Kinesics (adept power, powers.xml: SR5 310)' },
  { code: 'RF', page: 221, text: 'Garage', what: 'Garage (lifestyle quality, lifestyles.xml: RF 221)' },
  { code: 'SR5', page: 56, text: 'Edge', what: 'Edge' },
  { code: 'SR5', page: 158, text: 'Combat', what: 'Combat' },
  { code: 'SR5', page: 237, text: 'Matrix Actions', what: 'Matrix Actions' },
  { code: 'SR5', page: 281, text: 'Spellcasting', what: 'Spellcasting' },
];

function pageHas(dir: string, book: LibraryBook, printed: number, text: string) {
  const idx = loadIndex(dir, book.code);
  if (!idx) return null;
  const p = printedToPdf(book, printed);
  return !!p && fold(idx.texts[p - 1] || '').includes(fold(text));
}

/** Catalog evidence: share of catalog items (source=code, page) whose name is on the mapped PDF page, per candidate shift. */
function catalogEvidence(dir: string, book: LibraryBook) {
  const idx = loadIndex(dir, book.code);
  if (!idx) return null;
  const catDir = path.join(ROOT, 'data', 'catalog');
  const found: CatalogItem[] = [];
  for (const f of fs.existsSync(catDir) ? fs.readdirSync(catDir) : []) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(catDir, f), 'utf8'));
      found.push(...(Array.isArray(j) ? j : j.items || []).filter((x: CatalogItem) => x && x.source === book.code && Number(x.page) > 0 && x.name));
    } catch {}
  }
  // Use the first words of the name (catalog names carry ratings / variants: « Zoé: Heritage 4 »).
  const items = found.map((x) => ({ page: Number(x.page), needle: fold(String(x.name).replace(/\(.*?\)|\b\d+\b/g, ' ')).replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ') }))
    .filter((x) => x.needle.length >= 4);
  if (!items.length) return null;
  const score = (shift: number) => {
    let ok = 0;
    for (const it of items) {
      const p = printedToPdf(book, it.page);
      if (p && fold(idx.texts[p - 1 + shift] || '').replace(/\s+/g, ' ').includes(it.needle)) ok++;
    }
    return ok / items.length;
  };
  const res = { items: items.length, current: score(0) };
  let best = { shift: 0, rate: res.current };
  for (const s of [-3, -2, -1, 1, 2, 3]) {
    const r = score(s);
    if (r > best.rate + 0.02) best = { shift: s, rate: r };
  }
  return { ...res, best };
}

function runChecks(dir: string) {
  const lib = readLibrary(dir);
  const byCode = Object.fromEntries(lib.books.map((b) => [b.code, b]));
  let failures = 0;
  console.log('\nKnown references:');
  for (const r of REFERENCES) {
    const b = byCode[r.code];
    if (!b) {
      console.log(`  -    ${r.code} p.${r.page} « ${r.text} »: book missing`);
      continue;
    }
    const pages = [r.page, ...(r.alt || [])];
    const okAt = pages.find((p) => pageHas(dir, b, p, r.text));
    if (okAt === undefined) failures++;
    console.log(`  ${okAt !== undefined ? 'OK  ' : 'FAIL'} ${r.code} p.${r.page}${okAt !== undefined && okAt !== r.page ? ` (found p.${okAt})` : ''} → PDF ${printedToPdf(b, r.page)} « ${r.text} » — ${r.what}`);
  }
  console.log('\nQuick links of the Rules tab (heading present on the page):');
  for (const q of QUICK_LINKS.flatMap((g) => g.items)) {
    const b = byCode[q.code];
    if (!b) {
      console.log(`  -    ${q.code} p.${q.page} ${q.heading}: book missing`);
      continue;
    }
    const idx = loadIndex(dir, b.code);
    const ok = !!idx && (idx.texts[(printedToPdf(b, q.page) ?? 0) - 1] || '').includes(q.heading);
    if (!ok) failures++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${q.code} p.${q.page} « ${q.heading} »`);
  }
  console.log('\nCatalog pages (item name present on the announced printed page):');
  for (const b of lib.books) {
    const ev = catalogEvidence(dir, b);
    if (!ev) continue;
    const warn = ev.best.shift !== 0;
    if (warn) failures++;
    console.log(`  ${warn ? 'WARN' : 'OK  '} ${b.code.padEnd(5)} ${String(Math.round(ev.current * 100)).padStart(3)} % of ${ev.items} items${warn ? ` — a shift of ${ev.best.shift > 0 ? '+' : ''}${ev.best.shift} would give ${Math.round(ev.best.rate * 100)} %` : ''}`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
function printTable(rows: TableRow[], hints: FoundryHints = {}) {
  const head = ['code', 'pages', 'offset(s)', 'confidence', 'Chummer', 'Foundry', 'name'];
  const lines = rows.map((b) => [
    b.code,
    String(b.pages),
    [`${b.offset >= 0 ? '+' : ''}${b.offset}`, ...(b.offsets || []).map((r) => `p.${r.fromPrinted}→${r.offset >= 0 ? '+' : ''}${r.offset}`)].join(' '),
    b.confidence === undefined ? '-' : `${Math.round(b.confidence * 100)} %${b.numbered !== undefined ? ` (${b.numbered} folios)` : ''}`,
    b.verified === true ? 'ok' : b.verified === false ? (b.matchPdfPage ? `mismatch (sentence on PDF page ${b.matchPdfPage})` : 'sentence missing') : '-',
    hints[b.code] === undefined ? '-' : hints[b.code] === null ? 'null' : `+${hints[b.code]}`,
    b.name + (b.extra ? ' (extra)' : ''),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (l: string[]) => l.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(fmt(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const l of lines) console.log(fmt(l));
}

async function indexOne(code: string, meta: Partial<LibraryBook>) {
  const t0 = Date.now();
  let last = 0;
  const r = await indexBook(BOOKS, code, {
    meta,
    detect: !has('keep-offsets'),
    onProgress: (d, n) => {
      if (!quiet && process.stdout.isTTY && Date.now() - last > 500) {
        last = Date.now();
        process.stdout.write(`\r  ${code} ${d}/${n} pages…   `);
      }
    },
  });
  if (!quiet && process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(40) + '\r');
  log(`  ${code} indexed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return r;
}

async function main() {
  if (has('names')) {
    const dir = val('names') || path.resolve(ROOT, '..', 'Chummer5.226.0', 'data');
    const names = buildNames(dir);
    const out = path.join(ROOT, 'server', 'lib', 'books', 'book-names.json');
    fs.writeFileSync(out, JSON.stringify(names, null, 1) + '\n');
    console.log(`${Object.keys(names).length} books → ${path.relative(ROOT, out)}`);
    return;
  }
  fs.mkdirSync(BOOKS, { recursive: true });
  log(`Library: ${BOOKS}`);
  const hints = val('foundry') ? await foundryHints(path.resolve(val('foundry')!)) : {};
  const rows: Array<Awaited<ReturnType<typeof indexOne>>> = [];

  if (val('from')) {
    const from = path.resolve(val('from')!);
    const overrides = Object.fromEntries(vals('map').map((m) => m.split('=')).filter((p) => p.length === 2).map(([f, c]) => [f.toLowerCase(), cleanCode(c)]));
    const files = fs.readdirSync(from).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
    if (!files.length) throw new Error(`No PDF in ${from}`);
    const used = new Set<string>();
    for (const f of files) {
      const override = overrides[f.toLowerCase()];
      const hinted = hints[`file:${f}`] as string | null | undefined;
      const g: GuessedCode = override ? { code: override, extra: !knownBooks()[override] } : hinted ? { code: hinted, extra: !knownBooks()[hinted] } : guessCode(f);
      if (!g.code || used.has(g.code)) {
        console.warn(`  ! ${f}: code ${g.code || '?'} already taken or unknown — use --map "${f}=CODE"`);
        continue;
      }
      used.add(g.code);
      if (only.length && !only.includes(g.code)) continue;
      const src = path.join(from, f);
      const dest = pdfFile(BOOKS, g.code);
      const st = fs.statSync(src);
      const same = fs.existsSync(dest) && fs.statSync(dest).size === st.size;
      if (!same) fs.copyFileSync(src, dest); // copy only: the source PDF is never touched
      log(`${g.code.padEnd(5)} ← ${f}${same ? ' (already copied)' : ''}`);
      const known = knownBooks()[g.code];
      const meta = { source: f, ...(g.extra ? { extra: true, name: g.name || f.replace(/\.pdf$/i, '').replace(/_/g, ' '), nameFr: g.name || f.replace(/\.pdf$/i, '').replace(/_/g, ' ') } : { name: known?.name, nameFr: known?.nameFr }) };
      rows.push(await indexOne(g.code, meta));
    }
  } else if (has('reindex')) {
    const lib = readLibrary(BOOKS);
    const want = (val('reindex') || '').split(',').map(cleanCode).filter(Boolean);
    for (const b of lib.books) if (!want.length || want.includes(b.code)) rows.push(await indexOne(b.code, {}));
  } else if (!has('check') && !has('list')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  // Tidy the library (sort, normalize) and print it.
  const lib = writeLibrary(BOOKS, readLibrary(BOOKS));
  const printed: Array<Partial<LibraryBook> & { numbered?: number; matchPdfPage?: number | null }> = rows.length ? rows : lib.books;
  console.log('');
  printTable(printed.map((r) => ({ ...lib.books.find((b) => b.code === r.code), numbered: r.numbered, matchPdfPage: r.matchPdfPage })) as TableRow[], hints);
  if (has('list')) return;
  const failures = runChecks(BOOKS);
  if (failures) console.log(`\n${failures} check(s) to review.`);
  process.exitCode = failures && has('strict') ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
