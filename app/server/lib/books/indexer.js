// Index one book: extract the text of every PDF page, detect the printed→PDF page offset(s), check them against
// Chummer's reference sentence for that book (books.xml <match>), write index/<CODE>.json and the library entry.
import fs from 'node:fs';
import { extractPdf } from './pdftext.js';
import { detectOffsets, printedToPdf } from './offsets.js';
import { fold } from './search.js';
import { knownBooks, pdfFile, readLibrary, upsertBook, writeIndex } from './library.js';

const squash = (s) => fold(s).replace(/\s+/g, ' ').trim();

/** PDF pages (1-based) whose text contains the sentence. */
export function findSentence(texts, sentence) {
  const needle = squash(sentence);
  if (!needle) return [];
  const out = [];
  texts.forEach((t, i) => {
    if (squash(t).includes(needle)) out.push(i + 1);
  });
  return out;
}

/**
 * Offsets for a freshly extracted book: page-number detection, cross-checked with the Chummer sentence when known.
 * Returns { offset, offsets, confidence, numbered, verified: true|false|null, matchPdfPage }.
 */
export function computeOffsets(code, extracted) {
  const det = detectOffsets(extracted.edges);
  const match = knownBooks()[code]?.match;
  let verified = null;
  let matchPdfPage = null;
  if (match?.text && match.page) {
    const found = findSentence(extracted.texts, match.text);
    if (found.length) {
      matchPdfPage = found[0];
      const book = { offset: det.offset, offsets: det.offsets, pages: extracted.pages };
      verified = found.includes(printedToPdf(book, match.page));
      // Weak detection (few folios): trust Chummer's sentence instead.
      if (!verified && (det.confidence < 0.5 || det.numbered < 10)) {
        det.offset = matchPdfPage - match.page;
        det.offsets = null;
        verified = true;
      }
    } else verified = false;
  }
  return { ...det, verified, matchPdfPage };
}

/**
 * Index <dir>/<CODE>.pdf. opts: { onProgress(done, total), detect: true (false keeps a manual offset), meta: extra fields, save }.
 * Returns the library entry plus { numbered, matchPdfPage, patch }.
 */
export async function indexBook(dir, code, { onProgress, detect = true, meta = {}, save = true } = {}) {
  const file = pdfFile(dir, code);
  const extracted = await extractPdf(file, { onProgress });
  writeIndex(dir, code, extracted);
  const cur = readLibrary(dir).books.find((b) => b.code === code) || {};
  const keepManual = cur.manual && !detect;
  const off = computeOffsets(code, extracted);
  const patch = {
    ...meta,
    pages: extracted.pages,
    size: fs.statSync(file).size,
    indexedAt: Date.now(),
    confidence: off.confidence,
    verified: off.verified,
    matchPdfPage: off.matchPdfPage,
  };
  if (!keepManual) Object.assign(patch, { offset: off.offset, offsets: off.offsets, manual: false });
  // save=false (indexing worker): the caller writes the library entry itself (single writer of library.json).
  const book = save ? upsertBook(dir, code, patch) : { ...cur, ...patch, code };
  return { ...book, numbered: off.numbered, matchPdfPage: off.matchPdfPage, patch };
}
