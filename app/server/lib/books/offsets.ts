// Printed page ↔ PDF page mapping. A book has a base `offset` (pdfPage = printedPage + offset) and optional
// `offsets: [{ fromPrinted, offset }]` for books whose offset changes (unnumbered full-colour inserts…):
// printed page n uses the last entry with fromPrinted ≤ n, else the base offset.
// detectOffsets() finds them from the bare numbers printed in each PDF page's header/footer (pdftext.js).

/** One offset range: from printed page `fromPrinted` on, pdfPage = printed + offset. */
export interface OffsetRange {
  fromPrinted: number;
  offset: number;
}
/** What the mapping needs of a book (library entry or detection result). */
export interface PageMapping {
  offset?: number;
  offsets?: OffsetRange[] | null;
  pages?: number;
}
/** detectOffsets() result. */
export interface OffsetDetection {
  offset: number;
  offsets: OffsetRange[] | null;
  confidence: number;
  numbered: number;
  matched: number;
}

/** Offset that applies to a printed page. */
export function offsetFor(book: PageMapping | null | undefined, printed: unknown): number {
  let off = Number(book?.offset) || 0;
  const n = Number(printed);
  for (const r of book?.offsets || []) if (Number.isFinite(r.fromPrinted) && n >= r.fromPrinted) off = Number(r.offset) || 0;
  return off;
}

/** PDF page (1-based) of a printed page, or null when unknown or outside the book (a bad reference must not open the last page). */
export function printedToPdf(book: PageMapping | null | undefined, printed: unknown): number | null {
  const n = Number(printed);
  if (!Number.isFinite(n) || n < 1) return null;
  const p = Math.round(n + offsetFor(book, n));
  const max = Number(book?.pages) || Infinity;
  return p >= 1 && p <= max ? p : null;
}

/** Printed page of a PDF page, or null (cover, inserts before page 1). */
export function pdfToPrinted(book: PageMapping | null | undefined, pdfPage: unknown): number | null {
  const p = Number(pdfPage);
  if (!Number.isFinite(p) || p < 1) return null;
  // Ranges are sorted by fromPrinted; try them from the last one: the first whose own range contains p wins.
  const ranges: OffsetRange[] = [{ fromPrinted: -Infinity, offset: Number(book?.offset) || 0 }, ...(book?.offsets || [])];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const n = p - (Number(ranges[i].offset) || 0);
    if (n >= ranges[i].fromPrinted || i === 0) return n >= 1 ? n : null;
  }
  return null;
}

/** Sanitize offsets coming from the admin page / a library file. */
export function cleanOffsets(list: unknown): OffsetRange[] | null {
  if (!Array.isArray(list)) return null;
  const out = list
    .map((r: any) => ({ fromPrinted: Math.round(Number(r?.fromPrinted)), offset: Math.round(Number(r?.offset)) }))
    .filter((r) => Number.isFinite(r.fromPrinted) && Number.isFinite(r.offset) && r.fromPrinted >= 1 && Math.abs(r.offset) < 5000)
    .sort((a, b) => a.fromPrinted - b.fromPrinted);
  const dedup: OffsetRange[] = [];
  for (const r of out) if (!dedup.length || dedup[dedup.length - 1].fromPrinted !== r.fromPrinted) dedup.push(r);
  return dedup.length ? dedup.slice(0, 50) : null;
}

/**
 * Detect the printed→PDF offset(s) from per-page header/footer numbers.
 * edges[i] = numbers found in the margins of PDF page i+1. Returns
 * { offset, offsets: null | [{ fromPrinted, offset }], confidence: 0..1, numbered: pages with a folio, matched }.
 * Method: every number n on PDF page p votes for offset p − n; offsets with enough votes are « dominant »;
 * each page takes the dominant offset it supports (preferring the previous page's), runs shorter than 3 pages are
 * noise, and each change of offset along the book becomes a range.
 */
export function detectOffsets(edges: Array<number[] | null | undefined>, { minRun = 3 }: { minRun?: number } = {}): OffsetDetection {
  const total = edges.length;
  // Numbers printed on many pages (« GUN H(E)AVEN 3 » in every footer) are not folios: a folio appears once.
  const freq = new Map<number, number>();
  for (const nums of edges) for (const n of new Set(nums || [])) freq.set(n, (freq.get(n) || 0) + 1);
  const noisy = (n: number) => (freq.get(n) as number) > Math.max(3, total * 0.2);
  // Strong candidates: non-noisy numbers. A page with only noisy numbers keeps them as weak candidates, accepted only
  // when they continue the current run (the real folio « 3 » of a book whose footer always says « … 3 »).
  const weak: boolean[] = new Array(total).fill(false);
  const perPage = edges.map((nums, i) => {
    const inRange = (nums || []).filter((n) => n >= 1 && n <= total + 50);
    const strong = inRange.filter((n) => !noisy(n));
    if (!strong.length && inRange.length) weak[i] = true;
    return new Set((strong.length ? strong : inRange).map((n) => i + 1 - n));
  });
  const numbered = perPage.filter((s) => s.size).length;
  if (numbered < 2) return { offset: 0, offsets: null, confidence: 0, numbered, matched: 0 };
  const votes = new Map<number, number>();
  perPage.forEach((s, i) => {
    if (!weak[i]) for (const d of s) votes.set(d, (votes.get(d) || 0) + 1);
  });
  if (!votes.size) perPage.forEach((s) => s.forEach((d) => votes.set(d, (votes.get(d) || 0) + 1)));
  const minVotes = Math.max(Math.min(minRun, numbered), Math.ceil(numbered * 0.03));
  const dominant = new Set([...votes].filter(([, c]) => c >= minVotes).map(([d]) => d));
  if (!dominant.size) {
    const [best] = [...votes].sort((a, b) => b[1] - a[1]);
    return { offset: best[0], offsets: null, confidence: best[1] / numbered, numbered, matched: best[1] };
  }
  // Per-page assignment, continuity first.
  const assigned: Array<number | null> = new Array(total).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < total; i++) {
    const cands = [...perPage[i]].filter((d) => dominant.has(d));
    if (!cands.length) continue;
    if (weak[i] && !cands.includes(prev as number)) continue;
    let pick: number;
    if (prev !== null && cands.includes(prev)) pick = prev;
    else if (cands.length === 1) pick = cands[0];
    else {
      // Several dominant candidates and none continues the previous run: the closest one ahead of it, else the most voted.
      const ahead = prev === null ? [] : cands.filter((d) => d > (prev as number)).sort((a, b) => a - b);
      pick = ahead.length ? ahead[0] : cands.sort((a, b) => (votes.get(b) as number) - (votes.get(a) as number))[0];
    }
    assigned[i] = pick;
    prev = pick;
  }
  // Runs of equal offsets (pages without a folio do not break a run).
  let runs: Array<{ d: number; first: number; last: number; count: number }> = [];
  for (let i = 0; i < total; i++) {
    const d = assigned[i];
    if (d === null) continue;
    const r = runs[runs.length - 1];
    if (r && r.d === d) {
      r.last = i;
      r.count++;
    } else runs.push({ d, first: i, last: i, count: 1 });
  }
  // Drop noise runs, then merge neighbours that became equal.
  const strong = runs.filter((r) => r.count >= minRun);
  if (strong.length) runs = strong;
  const merged: typeof runs = [];
  for (const r of runs) {
    const m = merged[merged.length - 1];
    if (m && m.d === r.d) {
      m.last = r.last;
      m.count += r.count;
    } else merged.push({ ...r });
  }
  const base = merged[0].d;
  // A new range starts right after the last printed page of the previous one (unnumbered inserts in between).
  const offsets = merged.slice(1).map((r, i) => ({ fromPrinted: merged[i].last + 2 - merged[i].d, offset: r.d }));
  const book: PageMapping = { offset: base, offsets: cleanOffsets(offsets), pages: total };
  // Confidence: share of numbered pages whose folio agrees with the final mapping.
  // Pages with only noise numbers (unnumbered inserts) are left out unless they were taken as part of a run.
  let matched = 0;
  let counted = 0;
  for (let i = 0; i < total; i++) {
    if (!perPage[i].size || (weak[i] && assigned[i] === null)) continue;
    counted++;
    const printed = pdfToPrinted(book, i + 1);
    if (printed !== null && perPage[i].has(i + 1 - printed)) matched++;
  }
  return { offset: base, offsets: book.offsets ?? null, confidence: counted ? matched / counted : 0, numbered: counted, matched };
}
