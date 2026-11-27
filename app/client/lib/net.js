// Connection to the server: session token, live game state, actions and transient events.
import { io } from '/socket.io/socket.io.esm.min.js';
import { useEffect, useState } from 'preact/hooks';
import { toast } from './ui-store.js';
import { t, tk, errorText, setLang, langFromGame } from './i18n.js';

// The table this page belongs to comes from its URL: /t/<slug>/ (null on the picker / admin pages).
export const TABLE = (/^\/t\/([a-z0-9-]+)(?:\/|$)/.exec(location.pathname) || [])[1] || null;
const LEGACY_TOKEN_KEY = 'sr.token'; // single-table era: adopted by the first table that accepts it
const TOKEN_KEY = TABLE ? `sr.token.${TABLE}` : LEGACY_TOKEN_KEY;
let socket = null;
let state = null;
let connected = false;
let memToken = null; // fallback when site storage is blocked (session then lasts until reload)
let unauthorizedCb = null;
const stateListeners = new Set();
const connListeners = new Set();

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken ?? localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return memToken;
  }
}
/** Remember a session token for another table (admin « open as GM »). */
export function setTableToken(slug, t) {
  try {
    localStorage.setItem(`sr.token.${slug}`, t);
    return true;
  } catch {
    return false;
  }
}

/** Store the token; returns false when it could only be kept in memory (blocked storage). */
export function setToken(t) {
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
export function connect(onUnauthorized) {
  unauthorizedCb = onUnauthorized;
  socket = io({ auth: { token: getToken(), table: TABLE }, transports: ['websocket', 'polling'] });
  socket.on('state', (s) => {
    // Language first (own choice, else the table's), so the re-render triggered below is already in it.
    setLang(langFromGame(s));
    state = s;
    for (const l of stateListeners) l(s);
  });
  socket.on('connect', () => {
    setConn(true);
    // A legacy token accepted by this table now belongs to it.
    try {
      if (TOKEN_KEY !== LEGACY_TOKEN_KEY && !localStorage.getItem(TOKEN_KEY) && localStorage.getItem(LEGACY_TOKEN_KEY)) setToken(localStorage.getItem(LEGACY_TOKEN_KEY));
    } catch {}
  });
  socket.on('disconnect', () => setConn(false));
  socket.on('connect_error', (err) => {
    setConn(false);
    if (err?.message === 'unauthorized') onUnauthorized?.();
  });
  // The server revoked this session (user removed, state imported…): back to the login screen.
  socket.on('unauthorized', (info) => onUnauthorized?.(info)); // info.reason: 'demo-reset' (demo table wiped)…
  return socket;
}

function setConn(v) {
  connected = v;
  for (const l of connListeners) l(v);
}

/** Current full view (may be null before the first sync). */
export function getGame() {
  return state;
}

/** Hook: re-renders on every state sync. */
export function useGame() {
  const [s, set] = useState(state);
  useEffect(() => {
    stateListeners.add(set);
    if (state !== s) set(state);
    return () => stateListeners.delete(set);
  }, []);
  return s;
}

export function useConnected() {
  const [c, set] = useState(connected);
  useEffect(() => {
    connListeners.add(set);
    return () => connListeners.delete(set);
  }, []);
  return c;
}

/** Error carrying the server's translation key: err.message is translated, err.key/err.params/err.code kept. */
function replyError(res, fallback) {
  const err = new Error(errorText(res, fallback));
  err.key = res?.errorKey || res?.error || fallback;
  err.params = res?.params;
  err.code = res?.code;
  err.serverMessage = res?.error; // French text as sent by the server
  return err;
}

/**
 * Run a server action. Resolves with the handler's return value.
 * On failure shows a toast (unless opts.silent) and rejects with an Error whose message is translated
 * (server errors carry { error, errorKey, params } — see ctx.fail).
 */
export function send(type, payload = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error(t('Pas connecté')));
    socket.timeout(15000).emit('action', { type, payload }, (err, res) => {
      if (err) {
        if (!opts.silent) toast(t('Le serveur ne répond pas'), 'error');
        return reject(err);
      }
      if (!res?.ok) {
        if (res?.code === 'unauthorized') {
          unauthorizedCb?.();
          return reject(replyError(res, tk('Session expirée')));
        }
        const e = replyError(res, tk('Erreur'));
        if (!opts.silent) toast(e.message, 'error');
        return reject(e);
      }
      resolve(res.result);
    });
  });
}

/** Subscribe to a transient server event ('sfx', 'ping', …). Returns an unsubscribe function. */
export function on(event, cb) {
  socket?.on(event, cb);
  return () => socket?.off(event, cb);
}

/** Hook version of on(). */
export function useServerEvent(event, cb, deps = []) {
  useEffect(() => on(event, cb), deps);
}

/**
 * fetch() with the session token. Returns parsed JSON (or text for text/* responses).
 * Throws an Error with a translated message (+ err.key, err.params, err.code, err.status) on HTTP errors.
 */
export async function api(path, { method = 'GET', body, headers = {}, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token ?? getToken()}`, ...(TABLE ? { 'X-SR-Table': TABLE } : {}), ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body && !(body instanceof Blob) ? JSON.stringify(body) : body,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const body = data && typeof data === 'object' && (data.error || data.errorKey) ? data : { error: `Erreur ${res.status}`, errorKey: tk('Erreur {status}'), params: { status: res.status } };
    const err = replyError(body, tk('Erreur'));
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Upload a big File with progress (XMLHttpRequest streams it; fetch can't report upload progress).
 * onProgress(fraction 0..1). Resolves with the JSON reply, rejects with Error(message).
 */
export function uploadWithProgress(url, file, { onProgress, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token ?? getToken()}`);
    if (TABLE) xhr.setRequestHeader('X-SR-Table', TABLE);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = data?.error || data?.errorKey
        ? replyError(data, tk('Erreur'))
        : new Error(xhr.status === 413 ? t('Fichier trop volumineux') : t('Erreur {status}', { status: xhr.status }));
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error(t('Connexion perdue pendant l’envoi')));
    xhr.onabort = () => reject(new Error(t('Envoi annulé')));
    xhr.send(file);
  });
}

/** Upload a File/Blob; resolves to { url, name }. */
export async function upload(file) {
  return api('/api/upload', { method: 'POST', body: file, headers: { 'X-Filename': file.name || 'fichier' } });
}

const catalogCache = {};
/** Load a catalog file from /catalog/<name>.json (cached). */
export function loadCatalog(name) {
  if (!catalogCache[name]) {
    catalogCache[name] = fetch(`/catalog/${name}.json`).then((r) => (r.ok ? r.json() : []));
  }
  return catalogCache[name];
}

/** Hook: catalog array (empty while loading). */
export function useCatalog(name) {
  const [data, setData] = useState([]);
  useEffect(() => {
    let alive = true;
    loadCatalog(name).then((d) => alive && setData(d || []));
    return () => (alive = false);
  }, [name]);
  return data;
}
