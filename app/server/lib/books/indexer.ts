// Index one book: extract the text of every PDF page, detect the printed→PDF page offset(s), check them against
// Chummer's reference sentence for that book (books.xml <match>), write index/<CODE>.json and the library entry.
import fs from 'node:fs';
import { extractPdf } from './pdftext.ts';
import { detectOffsets, printedToPdf } from './offsets.ts';
import type { OffsetDetection } from './offsets.ts';
import { fold } from './search.ts';
import { knownBooks, pdfFile, readLibrary, upsertBook, writeIndex } from './library.ts';
import type { IndexData, LibraryBook } from './library.ts';

/** computeOffsets() result. */
export interface ComputedOffsets extends OffsetDetection {
  verified: boolean | null;
  matchPdfPage: number | null;
}
export interface IndexBookOptions {
  onProgress?: (done: number, total: number) => void;
  /** false keeps a manual offset. */
  detect?: boolean;
  /** Extra library fields. */
  meta?: Partial<LibraryBook>;
  save?: boolean;
}

const squash = (s: string): string => fold(s).replace(/\s+/g, ' ').trim();

/** PDF pages (1-based) whose text contains the sentence. */
export function findSentence(texts: string[], sentence: string): number[] {
  const needle = squash(sentence);
  if (!needle) return [];
  const out: number[] = [];
  texts.forEach((t, i) => {
    if (squash(t).includes(needle)) out.push(i + 1);
  });
  return out;
}

/**
 * Offsets for a freshly extracted book: page-number detection, cross-checked with the Chummer sentence when known.
 * Returns { offset, offsets, confidence, numbered, verified: true|false|null, matchPdfPage }.
 */
export function computeOffsets(code: string, extracted: IndexData): ComputedOffsets {
  const det = detectOffsets(extracted.edges);
  const match = knownBooks()[code]?.match;
  let verified: boolean | null = null;
  let matchPdfPage: number | null = null;
  if (match?.text && match.page) {
    const found = findSentence(extracted.texts, match.text);
    if (found.length) {
      matchPdfPage = found[0];
      const book = { offset: det.offset, offsets: det.offsets, pages: extracted.pages };
      verified = found.includes(printedToPdf(book, match.page) as number);
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
export async function indexBook(
  dir: string,
  code: string,
  { onProgress, detect = true, meta = {}, save = true }: IndexBookOptions = {},
): Promise<Partial<LibraryBook> & { numbered: number; matchPdfPage: number | null; patch: Partial<LibraryBook> }> {
  const file = pdfFile(dir, code);
  const extracted = await extractPdf(file, { onProgress });
  writeIndex(dir, code, extracted);
  const cur: Partial<LibraryBook> = readLibrary(dir).books.find((b) => b.code === code) || {};
  const keepManual = cur.manual && !detect;
  const off = computeOffsets(code, extracted);
  const patch: Partial<LibraryBook> = {
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
