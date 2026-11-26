// Pure rules of the rulebook download cache (no imports, no DOM: unit-tested in Node by tools/test-books.js).
// A book is stored ONCE per browser under a stable key = code + content version (from GET /api/books `version`),
// never under its signed URL (which changes every day and per session). Old versions of a book are dropped, and the
// least recently used books are evicted to stay under MAX_BOOKS / MAX_BYTES.

export const MAX_BOOKS = 12;
export const MAX_BYTES = 600 * 1024 * 1024;

/** Stable cache key of a library book, or null when the server sent no version (nothing is cached then). */
export function cacheKey(book) {
  const code = String(book?.code || '').toUpperCase();
  const version = String(book?.version || '');
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(code) || !/^[0-9a-z-]{1,40}$/.test(version)) return null;
  return `${code}@${version}`;
}

/** 'RG@abc-def' → { code: 'RG', version: 'abc-def' } or null. */
export function parseCacheKey(key) {
  const m = /^([A-Z0-9][A-Z0-9-]{0,11})@([0-9a-z-]{1,40})$/.exec(String(key || ''));
  return m ? { code: m[1], version: m[2] } : null;
}

/**
 * Which entries to delete before storing `incoming` ({ key, size }).
 * entries = [{ key, size, usedAt }]. Order: other versions of the incoming book first, then least recently used.
 * `keep` = keys never evicted (the book being stored). Returns { evict: [keys], store: boolean }
 * (store = false when the book alone is larger than the budget: it is read from the network and not kept).
 */
export function planEviction(entries, incoming, { maxBooks = MAX_BOOKS, maxBytes = MAX_BYTES, keep = [] } = {}) {
  const inc = parseCacheKey(incoming?.key);
  const size = Math.max(0, Number(incoming?.size) || 0);
  const keepSet = new Set([...(keep || []), incoming?.key]);
  const evict = [];
  let rest = [];
  for (const e of entries || []) {
    if (!e || e.key === incoming?.key) continue;
    const p = parseCacheKey(e.key);
    if (!p || (inc && p.code === inc.code && !keepSet.has(e.key))) evict.push(e.key); // unreadable key / older version of this book
    else rest.push(e);
  }
  if (size > maxBytes || maxBooks < 1) return { evict, store: false };
  rest = rest.slice().sort((a, b) => (Number(a.usedAt) || 0) - (Number(b.usedAt) || 0)); // oldest first
  let count = rest.length + 1;
  let bytes = rest.reduce((s, e) => s + (Number(e.size) || 0), 0) + size;
  for (const e of rest) {
    if (count <= maxBooks && bytes <= maxBytes) break;
    if (keepSet.has(e.key)) continue;
    evict.push(e.key);
    count--;
    bytes -= Number(e.size) || 0;
  }
  return { evict, store: count <= maxBooks && bytes <= maxBytes };
}

/**
 * Entries made stale by the library list: same code, another version than the server's (the PDF was replaced).
 * Books absent from the list are kept (another table of this server may still read them; LRU removes them in time).
 */
export function staleEntries(entries, books) {
  const current = new Map((books || []).filter((b) => b && b.version).map((b) => [String(b.code).toUpperCase(), String(b.version)]));
  return (entries || [])
    .filter((e) => {
      const p = parseCacheKey(e?.key);
      return !p || (current.has(p.code) && current.get(p.code) !== p.version);
    })
    .map((e) => e.key);
}

/** Map code → cached entry of the CURRENT version only ({ key, size, usedAt }). */
export function cachedByCode(entries, books) {
  const out = new Map();
  for (const b of books || []) {
    const k = cacheKey(b);
    const e = k && (entries || []).find((x) => x.key === k);
    if (e) out.set(b.code, e);
  }
  return out;
}

/** Storage backend to use: Cache Storage needs a secure context (https, localhost); plain http on an IP → IndexedDB. */
export function pickBackendName({ secure, hasCaches, hasIdb }) {
  if (secure && hasCaches) return 'cache';
  if (hasIdb) return 'idb';
  return 'none';
}

/**
 * fetch() options of a book download. With a persistent cache (Cache Storage / IndexedDB) the browser's HTTP cache would keep a
 * second copy of the PDF (the file is sent with Cache-Control: private, max-age=86400): 'no-store'. Without one, the HTTP cache is
 * the only cache left. `signal` aborts the download (another book opened).
 */
export function downloadOptions({ persistent, signal } = {}) {
  return { credentials: 'same-origin', ...(signal ? { signal } : {}), ...(persistent ? { cache: 'no-store' } : {}) };
}
