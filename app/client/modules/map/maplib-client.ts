// Map library — browser side helpers: the signed key that lets <img>/<canvas> load library images
// (/api/maplib/image|thumb/<slug>?k=…, renewed before it expires) and the cached library list (GM).
// The /admin page plugs its own key source (admin session) with setLibKeySource().
import { useEffect, useState } from 'react';
import { api } from '../../lib/net.ts';
import { isLibUrl } from '/shared/maplib.ts';
import type { LibEntry, LibKeyReply, LibList } from './types.ts';

export { isLibUrl };

let key: { k: string; exp: number } | null = null; // { k, exp (s, server clock) }
let skew = 0; // server clock − browser clock (ms)
let pending: Promise<string | null> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let source: () => Promise<LibKeyReply | null | undefined> = () => api<LibKeyReply>('/api/maplib/key');
const listeners = new Set<(k: string | null) => void>();
const RENEW_BEFORE = 10 * 60 * 1000;

/** /admin: fetch the key with the admin session instead of a table session. */
export function setLibKeySource(fn: () => Promise<LibKeyReply | null | undefined>) {
  source = fn;
  key = null;
}
const fresh = () => !!key && key.exp * 1000 - (Date.now() + skew) > RENEW_BEFORE;

function schedule() {
  clearTimeout(timer);
  if (!key) return;
  const delay = Math.max(60 * 1000, key.exp * 1000 - (Date.now() + skew) - RENEW_BEFORE + 1000);
  timer = setTimeout(() => {
    if (listeners.size) ensureLibKey(true);
  }, Math.min(delay, 2 ** 31 - 1));
}

/** Resolves the current key string (fetching / renewing it when needed), or null when it cannot be had. */
export function ensureLibKey(force = false): Promise<string | null> {
  if (!force && fresh()) return Promise.resolve(key!.k);
  if (pending) return pending;
  const t0 = Date.now();
  pending = Promise.resolve()
    .then(() => source())
    .then((r) => {
      if (Number(r?.now) > 0) skew = Number(r!.now) - (t0 + Date.now()) / 2;
      key = r?.k ? { k: r.k, exp: Number(r.exp) || 0 } : null;
      schedule();
      for (const l of listeners) l(key?.k || null);
      return key?.k || null;
    })
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** URL with the signed key (library URLs only; others unchanged). null while the key is unknown. */
export function signedUrl(url: string | null | undefined, k: string | null | undefined = key?.k): string | null | undefined {
  if (!isLibUrl(url)) return url;
  if (!k) return null;
  const u = url as string;
  return `${u}${u.includes('?') ? '&' : '?'}k=${encodeURIComponent(k)}`;
}

/** Hook: the current key (re-renders when it is fetched / renewed). */
export function useLibKey(): string | null {
  const [k, setK] = useState<string | null>(fresh() ? key!.k : null);
  useEffect(() => {
    listeners.add(setK);
    ensureLibKey().then((v) => setK(v));
    return () => {
      listeners.delete(setK);
    };
  }, []);
  return k;
}

// ---------------------------------------------------------------------------
// Library list (GM)
// ---------------------------------------------------------------------------
let lib: LibList | null = null;
let libPending: Promise<LibList> | null = null;
const libListeners = new Set<(v: LibList) => void>();
export function loadLibrary(force = false): Promise<LibList> {
  if (lib && !force) return Promise.resolve(lib);
  if (libPending) return libPending;
  libPending = api<LibList>('/api/maplib')
    .then((r) => {
      lib = r;
      for (const l of libListeners) l(r);
      return r;
    })
    .finally(() => {
      libPending = null;
    });
  return libPending;
}
/** Hook: { data: { maps, settings } | null, error }, refreshed on mount (and when `enabled` turns true). */
export function useLibrary(enabled = true): { data: LibList | null; error: Error | null } {
  const [v, setV] = useState<LibList | null>(lib);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    libListeners.add(setV);
    loadLibrary(true).then(setV, setError);
    return () => {
      libListeners.delete(setV);
    };
  }, [enabled]);
  return { data: v, error };
}
export const libEntry = (slug: string): LibEntry | null => (lib?.maps || []).find((m) => m.slug === slug) || null;
