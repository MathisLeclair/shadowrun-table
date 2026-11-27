// PDF text extraction with pdfjs-dist (Node legacy build, no worker): one entry per PDF page with its text and
// the bare numbers printed in its header/footer bands (candidate printed page numbers, see offsets.js).
import fs from 'node:fs';
import type { IndexData } from './library.ts';

/** A pdfjs text item (TextItem of pdfjs-dist; marked-content items have no `str`). */
interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * The file's bytes as a Uint8Array WITHOUT a second copy: a view over the Buffer's own memory (a PDF of 100 MB used to
 * cost 200 MB before pdfjs even started). Small files may sit in Node's shared Buffer pool, which pdfjs must not keep
 * or detach: those are copied.
 */
export function readBytes(file: string): Uint8Array {
  const buf = fs.readFileSync(file);
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) return new Uint8Array(buf.buffer, 0, buf.byteLength);
  return new Uint8Array(buf);
}

/** Edge band (fraction of the page height) where running heads and folios live. */
const EDGE = 0.085;

/**
 * Join pdfjs text items into readable text: line breaks where pdfjs reports them (or where the baseline jumps),
 * end-of-line hyphenation removed (« un-\nderstand » → « understand »), whitespace collapsed.
 */
export function joinItems(items: PdfTextItem[]): string {
  let out = '';
  let last: { y: number; xEnd: number; size: number } | null = null; // { y, xEnd, size } of the previous non-empty item
  for (const it of items) {
    const s = it.str || '';
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const size = Math.abs(tr[0]) || Math.abs(tr[3]) || 10;
    if (s && last && out && !/\s$/.test(out) && !/^\s/.test(s)) {
      if (Math.abs(y - last.y) > Math.max(2, size * 0.3)) out += '\n'; // baseline jump without EOL
      else if (x - last.xEnd > size * 0.2) out += ' '; // visible gap on the same line
    }
    out += s;
    if (it.hasEOL) out += '\n';
    if (s.trim()) last = { y, xEnd: x + (Number(it.width) || 0), size };
  }
  return cleanText(out);
}

/** Collapse whitespace and undo end-of-line hyphenation. */
export function cleanText(s: unknown): string {
  return String(s || '')
    .replace(/­/g, '')
    .replace(/([\p{L}])[-‐‑]\s*\n\s*(\p{Ll})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Numbers alone in an item of the header/footer bands: « 240 » (not « GUN H(E)AVEN 3 » words). */
export function edgeNumbers(items: PdfTextItem[], height: number): number[] {
  const nums: number[] = [];
  const loose: number[] = [];
  for (const it of items) {
    const s = (it.str || '').trim();
    if (!s || !it.transform) continue;
    const y = it.transform[5];
    if (y > height * EDGE && y < height * (1 - EDGE)) continue;
    if (/^\d{1,4}$/.test(s)) nums.push(Number(s));
    else for (const m of s.matchAll(/(?:^|\s|\|)(\d{1,4})(?=$|\s|\|)/g)) loose.push(Number(m[1]));
  }
  return nums.length ? [...new Set(nums)] : [...new Set(loose)];
}

/**
 * Extract every page of a PDF file. Returns { pages: numPages, texts: [string], edges: [[n]] } (index 0 = PDF page 1).
 * onProgress(done, total) after each page. Pages that fail to parse get empty text.
 */
export async function extractPdf(file: string, { onProgress }: { onProgress?: (done: number, total: number) => void } = {}): Promise<IndexData> {
  const { getDocument } = await pdfjs();
  const data = readBytes(file);
  const task = getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  const texts: string[] = [];
  const edges: number[][] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      try {
        const page = await doc.getPage(p);
        const { height } = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        texts.push(joinItems(tc.items as PdfTextItem[]));
        edges.push(edgeNumbers(tc.items as PdfTextItem[], height));
        page.cleanup();
      } catch {
        texts.push('');
        edges.push([]);
      }
      onProgress?.(p, doc.numPages);
    }
    return { pages: doc.numPages, texts, edges };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** Number of pages only (cheap validation of an uploaded file). */
export async function pdfPageCount(file: string): Promise<number> {
  const { getDocument } = await pdfjs();
  const data = readBytes(file);
  const doc = await getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const n = doc.numPages;
  await doc.destroy().catch(() => {});
  return n;
}
