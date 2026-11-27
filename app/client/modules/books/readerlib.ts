// Pure helpers of the in-app PDF reader (no imports, no DOM: unit-tested in Node by tools/test-books.ts):
// search-term highlighting in a page's text layer, and the continuous-scroll layout math (page tops, current page,
// fit-width / fit-page scale, zoom steps).

// ---------------------------------------------------------------------------
// Highlight (same folding rules as server/lib/books/search.js: one char → one char, so positions stay aligned)
// ---------------------------------------------------------------------------
const foldCache = new Map<string, string>();
function foldChar(c: string): string {
  let f = foldCache.get(c);
  if (f === undefined) {
    f = c.normalize('NFD')[0].toLowerCase()[0] || c;
    if (/[‐‑‒–—\-_’'`´]/.test(f)) f = f === '’' || f === "'" || f === '`' || f === '´' ? "'" : ' ';
    if (foldCache.size < 5000) foldCache.set(c, f);
  }
  return f;
}
/** Lowercase, no accents, dashes → spaces; same length as the input. */
export const fold = (s: unknown): string => String(s ?? '').replace(/[^a-z0-9 ]/g, foldChar);

/** Words to highlight for a search query (quotes dropped: a phrase is highlighted word by word), longest first. */
export function queryTerms(q: unknown): string[] {
  const seen = new Set<string>();
  return fold(String(q || '').slice(0, 200).replace(/["«»]/g, ' '))
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => (w.length >= 2 || /^\d$/.test(w)) && !seen.has(w) && seen.add(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);
}

const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);
/** Ranges [[start, end]] of `terms` in `text`, each starting at a word boundary, sorted, never overlapping. */
export type Range = [number, number];

export function findMatches(text: unknown, terms: string[] | null | undefined): Range[] {
  const hay = fold(text);
  const out: Range[] = [];
  for (const term of terms || []) {
    if (!term) continue;
    let i = hay.indexOf(term);
    while (i !== -1) {
      if (!isWordChar(hay[i - 1])) out.push([i, i + term.length]);
      i = hay.indexOf(term, i + 1);
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Split `text` by ranges: [{ text, hit }] (empty parts dropped). */
export function splitByRanges(text: string, ranges: Range[] | null | undefined): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let i = 0;
  for (const [a, b] of ranges || []) {
    if (a > i) parts.push({ text: text.slice(i, a), hit: false });
    parts.push({ text: text.slice(a, b), hit: true });
    i = b;
  }
  if (i < text.length) parts.push({ text: text.slice(i), hit: false });
  return parts.filter((p) => p.text);
}

// ---------------------------------------------------------------------------
// Layout (continuous scroll): pages stacked vertically, `gap` px between them and around them.
// ---------------------------------------------------------------------------
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;
export const clampScale = (s: unknown): number => Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(s) || 1));

/** Top (px) of each page and total height, for page heights in px. */
export function computeTops(heights: number[], gap: number): { tops: number[]; total: number } {
  const tops: number[] = new Array(heights.length);
  let y = gap;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += heights[i] + gap;
  }
  return { tops, total: y };
}

/** 1-based page under the vertical position y (binary search over tops). */
export function pageAt(tops: number[], y: number): number {
  if (!tops.length) return 1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * CSS scale for a zoom setting: 'width' (page width fills the view), 'page' (whole page visible) or a number.
 * page = { width, height } in PDF units at scale 1; view = { width, height } available px (gutters removed).
 */
export type Zoom = 'width' | 'page' | number;

export function scaleFor(zoom: Zoom | string, page: { width: number; height: number }, view: { width: number; height: number }): number {
  if (typeof zoom === 'number') return clampScale(zoom);
  const w = Math.max(50, view.width) / Math.max(1, page.width);
  if (zoom === 'page') return clampScale(Math.min(w, Math.max(50, view.height) / Math.max(1, page.height)));
  return clampScale(w);
}

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
/** Next zoom step up (dir > 0) or down from the current scale. */
export function zoomStep(scale: unknown, dir: number): number {
  const s = Number(scale) || 1;
  if (dir > 0) return STEPS.find((x) => x > s + 0.001) ?? MAX_SCALE;
  for (let i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] < s - 0.001) return STEPS[i];
  return MIN_SCALE;
}

/** Device pixels per CSS pixel for a page canvas: devicePixelRatio (max 2), lowered so the canvas stays under maxPixels. */
export function outputScale(cssWidth: number, cssHeight: number, dpr: unknown, maxPixels = 16e6): number {
  let s = Math.min(2, Math.max(1, Number(dpr) || 1));
  const area = cssWidth * cssHeight;
  if (area * s * s > maxPixels) s = Math.sqrt(maxPixels / Math.max(1, area));
  return Math.max(0.25, s);
}
