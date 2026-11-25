// Connection to the server: session token, live game state, actions and transient events.
import { io } from '/socket.io/socket.io.esm.min.js';
import { useEffect, useState } from 'preact/hooks';
import { toast } from './ui-store.js';

const TOKEN_KEY = 'sr.token';
let socket = null;
let state = null;
let connected = false;
let memToken = null; // fallback when site storage is blocked (session then lasts until reload)
let unauthorizedCb = null;
const stateListeners = new Set();
const connListeners = new Set();

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken;
  } catch {
    return memToken;
  }
}
/** Store the token; returns false when it could only be kept in memory (blocked storage). */
export function setToken(t) {
  memToken = t || null;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
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
  socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  socket.on('state', (s) => {
    state = s;
    for (const l of stateListeners) l(s);
  });
  socket.on('connect', () => setConn(true));
  socket.on('disconnect', () => setConn(false));
  socket.on('connect_error', (err) => {
    setConn(false);
    if (err?.message === 'unauthorized') onUnauthorized?.();
  });
  // The server revoked this session (user removed, state imported…): back to the login screen.
  socket.on('unauthorized', () => onUnauthorized?.());
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

/**
 * Run a server action. Resolves with the handler's return value.
 * On failure shows a toast (unless opts.silent) and rejects.
 */
export function send(type, payload = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Pas connecté'));
    socket.timeout(15000).emit('action', { type, payload }, (err, res) => {
      if (err) {
        if (!opts.silent) toast('Le serveur ne répond pas', 'error');
        return reject(err);
      }
      if (!res?.ok) {
        if (res?.code === 'unauthorized') {
          unauthorizedCb?.();
          return reject(new Error(res.error || 'Session expirée'));
        }
        if (!opts.silent) toast(res?.error || 'Erreur', 'error');
        return reject(new Error(res?.error || 'Erreur'));
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

/** fetch() with the session token. Returns parsed JSON (or text for text/* responses). */
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${getToken()}`, ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body && !(body instanceof Blob) ? JSON.stringify(body) : body,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
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
