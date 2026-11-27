// Connection to the server: session token, live game state, actions and transient events.
import { io, type Socket } from 'socket.io-client';
import { useEffect, useState } from 'react';
import { toast } from './ui-store.ts';
import { t, tk, errorText, setLang, langFromGame } from './i18n.ts';
import type { GameView } from '../../shared/types.ts';

export type { GameView };
/** Props of every tab, dock and global component (see modules/registry.ts). */
export interface GameProps {
  game: GameView;
}
/** Error thrown by send()/api(): message translated, plus the server's key/params/code. */
export interface ServerError extends Error {
  key?: string;
  params?: Record<string, unknown>;
  code?: string;
  status?: number;
  serverMessage?: string;
}
/** Reply of a server action or failing route ({ ok, result } or { error, errorKey, params, code }). */
interface Reply {
  ok?: boolean;
  result?: unknown;
  error?: string;
  errorKey?: string;
  params?: Record<string, unknown>;
  code?: string;
}
type UnauthorizedInfo = { reason?: string } | undefined;

// The table this page belongs to comes from its URL: /t/<slug>/ (null on the picker / admin pages).
export const TABLE: string | null = (/^\/t\/([a-z0-9-]+)(?:\/|$)/.exec(location.pathname) || [])[1] || null;
const LEGACY_TOKEN_KEY = 'sr.token'; // single-table era: adopted by the first table that accepts it
const TOKEN_KEY = TABLE ? `sr.token.${TABLE}` : LEGACY_TOKEN_KEY;
let socket: Socket | null = null;
let state: GameView | null = null;
let connected = false;
let memToken: string | null = null; // fallback when site storage is blocked (session then lasts until reload)
let unauthorizedCb: ((info?: UnauthorizedInfo) => void) | null = null;
const stateListeners = new Set<(s: GameView | null) => void>();
const connListeners = new Set<(v: boolean) => void>();

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken ?? localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return memToken;
  }
}
/** Remember a session token for another table (admin « open as GM »). */
export function setTableToken(slug: string, t: string): boolean {
  try {
    localStorage.setItem(`sr.token.${slug}`, t);
    return true;
  } catch {
    return false;
  }
}

/** Store the token; returns false when it could only be kept in memory (blocked storage). */
export function setToken(t: string | null | undefined): boolean {
  memToken = t || null;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
    if (TOKEN_KEY !== LEGACY_TOKEN_KEY) localStorage.removeItem(LEGACY_TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

export function logout() {
  setToken(null);
  socket?.disconnect();
  location.reload();
}

/** Open the socket. Calls onUnauthorized() if the token is rejected. */
export function connect(onUnauthorized: (info?: UnauthorizedInfo) => void): Socket {
  unauthorizedCb = onUnauthorized;
  socket = io({ auth: { token: getToken(), table: TABLE }, transports: ['websocket', 'polling'] });
  socket.on('state', (s: GameView) => {
    // Language first (own choice, else the table's), so the re-render triggered below is already in it.
    setLang(langFromGame(s));
    state = s;
    for (const l of stateListeners) l(s);
  });
  socket.on('connect', () => {
    setConn(true);
    // A legacy token accepted by this table now belongs to it.
    try {
      const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
      if (TOKEN_KEY !== LEGACY_TOKEN_KEY && !localStorage.getItem(TOKEN_KEY) && legacy) setToken(legacy);
    } catch {}
  });
  socket.on('disconnect', () => setConn(false));
  socket.on('connect_error', (err: Error) => {
    setConn(false);
    if (err?.message === 'unauthorized') onUnauthorized?.();
  });
  // The server revoked this session (user removed, state imported…): back to the login screen.
  socket.on('unauthorized', (info: UnauthorizedInfo) => onUnauthorized?.(info)); // info.reason: 'demo-reset' (demo table wiped)…
  return socket;
}

function setConn(v: boolean) {
  connected = v;
  for (const l of connListeners) l(v);
}

/** Current full view (may be null before the first sync). */
export function getGame(): GameView | null {
  return state;
}

/** Hook: re-renders on every state sync. */
export function useGame(): GameView | null {
  const [s, set] = useState<GameView | null>(state);
  useEffect(() => {
    stateListeners.add(set);
    if (state !== s) set(state);
    return () => {
      stateListeners.delete(set);
    };
  }, []);
  return s;
}

export function useConnected(): boolean {
  const [c, set] = useState(connected);
  useEffect(() => {
    connListeners.add(set);
    return () => {
      connListeners.delete(set);
    };
  }, []);
  return c;
}

/** Error carrying the server's translation key: err.message is translated, err.key/err.params/err.code kept. */
function replyError(res: Reply | null | undefined, fallback: string): ServerError {
  const err: ServerError = new Error(errorText(res, fallback));
  err.key = res?.errorKey || res?.error || fallback;
  err.params = res?.params;
  err.code = res?.code;
  err.serverMessage = res?.error; // untranslated text as sent by the server
  return err;
}

/**
 * Run a server action. Resolves with the handler's return value.
 * On failure shows a toast (unless opts.silent) and rejects with an Error whose message is translated
 * (server errors carry { error, errorKey, params } — see ctx.fail).
 */
export function send<R = any>(type: string, payload: object = {}, opts: { silent?: boolean } = {}): Promise<R> {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error(t('Not connected')));
    socket.timeout(15000).emit('action', { type, payload }, (err: Error | null, res: Reply) => {
      if (err) {
        if (!opts.silent) toast(t('The server is not responding'), 'error');
        return reject(err);
      }
      if (!res?.ok) {
        if (res?.code === 'unauthorized') {
          unauthorizedCb?.();
          return reject(replyError(res, tk('Session expired')));
        }
        const e = replyError(res, tk('Error'));
        if (!opts.silent) toast(e.message, 'error');
        return reject(e);
      }
      resolve(res.result as R);
    });
  });
}

/** Subscribe to a transient server event ('sfx', 'ping', …). Returns an unsubscribe function. */
export function on(event: string, cb: (...args: any[]) => void): () => void {
  socket?.on(event, cb);
  return () => {
    socket?.off(event, cb);
  };
}

/** Hook version of on(). */
export function useServerEvent(event: string, cb: (...args: any[]) => void, deps: unknown[] = []) {
  useEffect(() => on(event, cb), deps);
}

/**
 * fetch() with the session token. Returns parsed JSON (or text for text/* responses).
 * Throws an Error with a translated message (+ err.key, err.params, err.code, err.status) on HTTP errors.
 */
export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  token?: string | null;
}
export async function api<R = any>(path: string, { method = 'GET', body, headers = {}, token }: ApiOptions = {}): Promise<R> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token ?? getToken()}`, ...(TABLE ? { 'X-SR-Table': TABLE } : {}), ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body && !(body instanceof Blob) ? JSON.stringify(body) : (body as Blob | undefined),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const reply: Reply = data && typeof data === 'object' && (data.error || data.errorKey) ? data : { error: `Erreur ${res.status}`, errorKey: tk('Error {status}'), params: { status: res.status } };
    const err = replyError(reply, tk('Error'));
    err.status = res.status;
    throw err;
  }
  return data as R;
}

/**
 * Upload a big File with progress (XMLHttpRequest streams it; fetch can't report upload progress).
 * onProgress(fraction 0..1). Resolves with the JSON reply, rejects with Error(message).
 */
export function uploadWithProgress<R = any>(
  url: string,
  file: Blob,
  { onProgress, token, headers = {} }: { onProgress?: (fraction: number) => void; token?: string | null; headers?: Record<string, string> } = {}
): Promise<R> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token ?? getToken()}`);
    if (TABLE) xhr.setRequestHeader('X-SR-Table', TABLE);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: (Reply & R) | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as R);
      const err: ServerError = data?.error || data?.errorKey
        ? replyError(data, tk('Error'))
        : new Error(xhr.status === 413 ? t('File too large') : t('Error {status}', { status: xhr.status }));
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error(t('Connection lost during upload')));
    xhr.onabort = () => reject(new Error(t('Upload cancelled')));
    xhr.send(file);
  });
}

/** Upload a File/Blob; resolves to { url, name }. */
export async function upload(file: File | Blob): Promise<{ url: string; name: string }> {
  return api('/api/upload', { method: 'POST', body: file, headers: { 'X-Filename': (file as File).name || 'fichier' } });
}

const catalogCache: Record<string, Promise<any[]>> = {};
/** Load a catalog file from /catalog/<name>.json (cached). */
export function loadCatalog<T = any>(name: string): Promise<T[]> {
  if (!catalogCache[name]) {
    catalogCache[name] = fetch(`/catalog/${name}.json`).then((r) => (r.ok ? r.json() : []));
  }
  return catalogCache[name];
}

/** Hook: catalog array (empty while loading). */
export function useCatalog<T = any>(name: string): T[] {
  const [data, setData] = useState<T[]>([]);
  useEffect(() => {
    let alive = true;
    loadCatalog<T>(name).then((d) => alive && setData(d || []));
    return () => {
      alive = false;
    };
  }, [name]);
  return data;
}
