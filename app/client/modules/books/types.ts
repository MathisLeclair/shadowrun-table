// Client-side types of the rulebook module (GET /api/books, viewer drawer, search, reader).

/** Offset change from a printed page on (books with unnumbered colour plates). */
export interface OffsetRange {
  fromPrinted: number;
  offset: number;
}

/** A library book as GET /api/books lists it (signed PDF link renewed before `exp`). */
export interface LibBook {
  code: string;
  name: string;
  nameFr: string;
  pages: number;
  offset: number;
  offsets?: OffsetRange[];
  indexed: boolean;
  /** Signed PDF link. */
  url: string;
  /** Link expiry (s, server clock). */
  exp: number;
  /** Content version: cache key of the reader. */
  version: string;
  size: number;
  /** Supplement outside the main list (dim badge). */
  extra?: boolean;
}

/** Highlight request of a search hit: terms of `q` on that PDF page. */
export interface ViewerHighlight {
  q: string;
  pdfPage: number;
}

/** State of the global viewer drawer (see store.ts). */
export interface ViewerState {
  open: boolean;
  code: string | null;
  pdfPage: number | null;
  printed: number | null;
  badPage: boolean;
  searchQ: string;
  raise: number;
  nav: number;
  hl: ViewerHighlight | null;
}

/** One full-text search hit. marks = [[start, end]] ranges of the snippet to highlight. */
export interface SearchHit {
  code: string;
  page: number | null;
  pdfPage: number;
  snippet: string;
  marks?: [number, number][];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  error?: string;
}

/** Entry of this browser's book cache. */
export interface CacheEntry {
  key: string;
  size: number;
  usedAt: number;
}

export type CacheBackendName = 'cache' | 'idb' | 'none';

/** useBookCache() snapshot. */
export interface CacheSnapshot {
  ready: boolean;
  backend: CacheBackendName | null;
  entries: CacheEntry[];
  bytes: number;
}

/** Reader zoom setting: fit width, whole page, or CSS px per PDF unit. */
export type Zoom = 'width' | 'page' | number;
