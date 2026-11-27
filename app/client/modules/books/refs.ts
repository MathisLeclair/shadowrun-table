// Pure rulebook reference helpers (no imports: also unit-tested in Node by tools/test-books.ts).
// Page mapping follows the same rules as server/lib/books/offsets.js.

/** What the page mapping reads of a library book: offset, per-range offsets from a printed page, PDF page count. */
export interface PagedBook {
  offset?: number;
  offsets?: { fromPrinted: number; offset: number }[];
  pages?: number;
}
/** A parsed reference: book code + printed page (null: the code alone). */
export interface SourceRef {
  code: string;
  page: number | null;
}

export function offsetFor(book: PagedBook | null | undefined, printed: unknown): number {
  let off = Number(book?.offset) || 0;
  for (const r of book?.offsets || []) if (Number(printed) >= r.fromPrinted) off = Number(r.offset) || 0;
  return off;
}
export function printedToPdf(book: PagedBook | null | undefined, printed: unknown): number | null {
  const n = Number(printed);
  if (!Number.isFinite(n) || n < 1) return null;
  const p = Math.round(n + offsetFor(book, n));
  return p >= 1 && p <= (Number(book?.pages) || Infinity) ? p : null; // outside the book → null (« page introuvable »)
}
export function pdfToPrinted(book: PagedBook | null | undefined, pdfPage: unknown): number | null {
  const p = Number(pdfPage);
  const ranges = [{ fromPrinted: -Infinity, offset: Number(book?.offset) || 0 }, ...(book?.offsets || [])];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const n = p - (Number(ranges[i].offset) || 0);
    if (n >= ranges[i].fromPrinted || i === 0) return n >= 1 ? n : null;
  }
  return null;
}

/**
 * Parse a book reference: 'RG 62', 'SR5 p. 240', 'SR5 p.240', 'SR5:240', 'RF 221, SR5 12' (first one),
 * { source: 'RG', page: '62' } or { code, page }. Returns { code, page } (page = printed page number) or null.
 */
export function parseSourceRef(ref: unknown, page?: string | number | null): SourceRef | null {
  if (ref && typeof ref === 'object') {
    const o = ref as { source?: string | null; code?: string | null; page?: string | number | null };
    return parseSourceRef(o.source ?? o.code, o.page ?? page);
  }
  const s = String(ref ?? '').trim();
  if (!s) return null;
  if (page !== undefined && page !== null && page !== '') {
    const code = s.toUpperCase().match(/^[A-Z0-9][A-Z0-9-]{0,11}$/)?.[0];
    const n = parseInt(String(page).replace(/^p\.?\s*/i, ''), 10);
    return code && n > 0 ? { code, page: n } : code ? { code, page: null } : null;
  }
  // A separator is required between the code and the page: « GH3 » is a code, « GH 3 » / « GH3 p.3 » are references.
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,11})(?:\s+|\s*[:,]\s*|\s*(?=p))(?:p(?:age|g)?\.?\s*)?(\d{1,4})\b/i);
  if (m) return { code: m[1].toUpperCase(), page: parseInt(m[2], 10) };
  const only = s.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,11})$/);
  return only ? { code: only[1].toUpperCase(), page: null } : null;
}

