// Rulebook download cache: each PDF is downloaded ONCE per browser and kept, under a stable key = code + content
// version (GET /api/books `version`), never under its signed URL. Rules (keys, eviction) live in cachepolicy.js.
// Backends:
//   'cache' = Cache Storage (caches.open('sr-books')) — only in a secure context (https, localhost);
//   'idb'   = IndexedDB (database 'sr-books': stores 'meta' + 'data') — works on plain http (the VPS at http://<ip>:8095);
//   'none'  = nothing persistent (private mode, storage blocked): the open document stays in memory for the session.
// API: getBookData(book, { onProgress, signal }) → { data: ArrayBuffer, fromCache }, pruneStale(books), clearBookCache(),
// useBookCache() → { backend, entries, bytes, ready }.
import { useEffect, useState } from 'preact/hooks';
import { errorText } from '../../lib/i18n.js';
import { cacheKey, parseCacheKey, planEviction, staleEntries, pickBackendName, downloadOptions } from './cachepolicy.js';

const CACHE_NAME = 'sr-books';
const KEY_PREFIX = '/__sr-books/'; // request URLs used as Cache Storage keys (never fetched)
const USED_KEY = 'sr.books.used'; // localStorage { key: last use (ms) } for the Cache Storage backend
const DB_NAME = 'sr-books';

// ---------------------------------------------------------------------------
// Cache Storage backend
// ---------------------------------------------------------------------------
const readUsed = () => {
  try {
    return JSON.parse(localStorage.getItem(USED_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
const writeUsed = (m) => {
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(m));
  } catch {}
};
const reqUrl = (key) => new URL(KEY_PREFIX + encodeURIComponent(key), location.origin).href;

const cacheBackend = {
  name: 'cache',
  async init() {
    await caches.open(CACHE_NAME);
  },
  async list() {
    const c = await caches.open(CACHE_NAME);
    const used = readUsed();
    const out = [];
    for (const req of await c.keys()) {
      const path = new URL(req.url).pathname;
      if (!path.startsWith(KEY_PREFIX)) continue;
      const key = decodeURIComponent(path.slice(KEY_PREFIX.length));
      const res = await c.match(req);
      out.push({ key, size: Number(res?.headers.get('X-SR-Size')) || 0, usedAt: used[key] || Number(res?.headers.get('X-SR-Stored')) || 0 });
    }
    return out;
  },
  async get(key) {
    const res = await (await caches.open(CACHE_NAME)).match(reqUrl(key));
    return res ? res.arrayBuffer() : null;
  },
  async put(key, blob) {
    const res = new Response(blob, { headers: { 'Content-Type': 'application/pdf', 'X-SR-Size': String(blob.size), 'X-SR-Stored': String(Date.now()) } });
    await (await caches.open(CACHE_NAME)).put(reqUrl(key), res);
    await this.touch(key);
  },
  async delete(key) {
    await (await caches.open(CACHE_NAME)).delete(reqUrl(key));
    const used = readUsed();
    delete used[key];
    writeUsed(used);
  },
  async touch(key) {
    const used = readUsed();
    used[key] = Date.now();
    writeUsed(used);
  },
  async clear() {
    await caches.delete(CACHE_NAME);
    writeUsed({});
  },
};

// ---------------------------------------------------------------------------
// IndexedDB backend (works without a secure context)
// ---------------------------------------------------------------------------
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      r.onerror = () => reject(r.error || new Error('IndexedDB'));
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}
/** Run fn(stores…) in one transaction; resolves with fn's request result once the transaction completes. */
async function tx(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    let result;
    const req = fn(...names.map((n) => t.objectStore(n)));
    if (req && 'onsuccess' in req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('IndexedDB'));
    t.onabort = () => reject(t.error || new Error('IndexedDB abort'));
  });
}

const idbBackend = {
  name: 'idb',
  async init() {
    await openDb();
  },
  async list() {
    const all = (await tx(['meta'], 'readonly', (m) => m.getAll())) || [];
    return all.map((e) => ({ key: e.key, size: e.size || 0, usedAt: e.usedAt || 0 }));
  },
  async get(key) {
    const v = await tx(['data'], 'readonly', (d) => d.get(key));
    if (!v) return null;
    return v instanceof ArrayBuffer ? v : typeof v.arrayBuffer === 'function' ? v.arrayBuffer() : null;
  },
  async put(key, blob) {
    const p = parseCacheKey(key);
    // Store a Blob (browsers keep large blobs as files, not in the database's heap).
    await tx(['meta', 'data'], 'readwrite', (m, d) => {
      d.put(blob, key);
      m.put({ key, code: p?.code, version: p?.version, size: blob.size, usedAt: Date.now() });
    });
  },
  async delete(key) {
    await tx(['meta', 'data'], 'readwrite', (m, d) => {
      d.delete(key);
      m.delete(key);
    });
  },
  async touch(key) {
    await tx(['meta'], 'readwrite', (m) => {
      const r = m.get(key);
      r.onsuccess = () => r.result && m.put({ ...r.result, usedAt: Date.now() });
    });
  },
  async clear() {
    await tx(['meta', 'data'], 'readwrite', (m, d) => {
      m.clear();
      d.clear();
    });
  },
};

// ---------------------------------------------------------------------------
// Backend choice (tested once: Cache Storage → IndexedDB → none)
// ---------------------------------------------------------------------------
let backendPromise = null;
export function getBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      const env = { secure: !!globalThis.isSecureContext, hasCaches: typeof caches !== 'undefined', hasIdb: typeof indexedDB !== 'undefined' };
      const order = pickBackendName(env) === 'cache' ? [cacheBackend, idbBackend] : env.hasIdb ? [idbBackend] : [];
      for (const be of order) {
        try {
          await be.init();
          return be;
        } catch (err) {
          console.warn(`[books] cache ${be.name} indisponible`, err?.message || err);
        }
      }
      return null;
    })();
  }
  return backendPromise;
}

// ---------------------------------------------------------------------------
// Status listeners (Règles tab badges, viewer settings)
// ---------------------------------------------------------------------------
let snapshot = { ready: false, backend: null, entries: [], bytes: 0 };
const listeners = new Set();
let refreshing = null;
export function refreshCacheStatus() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const be = await getBackend();
    let entries = [];
    try {
      entries = be ? await be.list() : [];
    } catch {}
    snapshot = { ready: true, backend: be?.name || 'none', entries, bytes: entries.reduce((s, e) => s + (e.size || 0), 0) };
    for (const l of listeners) l(snapshot);
    return snapshot;
  })().finally(() => (refreshing = null));
  return refreshing;
}

/** Hook: { ready, backend: 'cache'|'idb'|'none', entries: [{ key, size, usedAt }], bytes }. */
export function useBookCache() {
  const [s, setS] = useState(snapshot);
  useEffect(() => {
    listeners.add(setS);
    refreshCacheStatus();
    return () => listeners.delete(setS);
  }, []);
  return s;
}

// ---------------------------------------------------------------------------
// Download with progress
// ---------------------------------------------------------------------------
/** Error of a failed download: message translated, `status` kept (403 = link expired / session gone → renew and retry). */
async function httpError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {}
  const err = new Error(body?.error ? errorText(body) : `HTTP ${res.status}`);
  err.status = res.status;
  return err;
}

async function download(url, expected, onProgress, signal, persistent = false) {
  const res = await fetch(url, downloadOptions({ persistent, signal })); // persistent cache → 'no-store' (no second copy)
  if (!res.ok) throw await httpError(res);
  const total = Number(res.headers.get('Content-Length')) || Number(expected) || 0;
  onProgress?.(0, total);
  if (!res.body?.getReader) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  let out = new Uint8Array(total || 4 * 1024 * 1024);
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.byteLength > out.byteLength) {
      const bigger = new Uint8Array(Math.max(out.byteLength * 2, got + value.byteLength));
      bigger.set(out.subarray(0, got));
      out = bigger;
    }
    out.set(value, got);
    got += value.byteLength;
    const now = Date.now();
    if (now - last > 80) {
      last = now;
      onProgress?.(got, total);
    }
  }
  onProgress?.(got, total || got);
  return got === out.byteLength ? out.buffer : out.buffer.slice(0, got);
}

/** Store a downloaded book: drop its other versions and the least recently used books, then write (quota errors tolerated). */
async function store(be, key, blob) {
  let entries = [];
  try {
    entries = await be.list();
  } catch {}
  const plan = planEviction(entries, { key, size: blob.size });
  for (const k of plan.evict) await be.delete(k).catch(() => {});
  if (!plan.store) return false;
  const left = entries.filter((e) => e.key !== key && !plan.evict.includes(e.key)).sort((a, b) => a.usedAt - b.usedAt);
  for (;;) {
    try {
      await be.put(key, blob);
      return true;
    } catch (err) {
      // Quota: make room with the oldest book and try again; give up when nothing is left.
      const victim = left.shift();
      if (!victim) {
        console.warn('[books] livre non mis en cache', err?.name || err);
        return false;
      }
      await be.delete(victim.key).catch(() => {});
    }
  }
}

/**
 * The bytes of a library book ({ code, version, size, url }): from the browser cache when present (no network),
 * else downloaded (onProgress(loaded, total)) and stored. Resolves { data: ArrayBuffer (yours, may be transferred), fromCache }.
 */
export function getBookData(book, { onProgress, signal } = {}) {
  const key = cacheKey(book);
  const run = async () => {
    const be = key ? await getBackend() : null;
    if (be) {
      try {
        const hit = await be.get(key);
        if (hit && hit.byteLength > 0) {
          be.touch(key).catch(() => {});
          return { data: hit, fromCache: true };
        }
      } catch (err) {
        console.warn('[books] lecture du cache impossible', err?.message || err);
      }
    }
    const data = await download(book.url, book.size, onProgress, signal, !!be);
    if (be) {
      // A Blob copy is written in the background: the caller may hand `data` to pdf.js (transferred to its worker).
      const blob = new Blob([data], { type: 'application/pdf' });
      store(be, key, blob)
        .catch(() => {})
        .finally(() => refreshCacheStatus());
    }
    return { data, fromCache: false };
  };
  return run();
}

/** Drop cached versions that the server replaced (called with each fresh library list). */
export async function pruneStale(books) {
  const be = await getBackend();
  if (!be) return;
  try {
    const stale = staleEntries(await be.list(), books);
    for (const k of stale) await be.delete(k);
    if (stale.length) refreshCacheStatus();
  } catch {}
}

/** « Vider le cache des livres »: removes every stored book (and the HTTP cache cannot be cleared from here). */
export async function clearBookCache() {
  const be = await getBackend();
  if (be) await be.clear();
  return refreshCacheStatus();
}
