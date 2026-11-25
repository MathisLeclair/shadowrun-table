// Shadowrun table server: HTTP + Socket.IO, authoritative game state, per-player filtered views.
// Feature modules live in server/modules/*.js and are loaded automatically (see ARCHITECTURE.md).
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import {
  ROOT, DATA_DIR, UPLOAD_DIR, DOCS_DIR, SEED_DIR,
  loadState, getState, saveSoon, saveNow, flushState, backup, readJson, emptyState, replaceState,
} from './store.js';
import { uid, deepClone } from '../shared/util.js';

const PORT = Number(process.env.PORT) || 3000;

/** Synchronous save that never throws (saveNow retries by itself on fs errors). */
function persistNow() {
  try {
    saveNow();
  } catch (err) {
    console.error('[store] save failed', err);
  }
}

// ---------------------------------------------------------------------------
// Errors & module registry
// ---------------------------------------------------------------------------
import { ActionError } from "./errors.js";
export { ActionError };

const modules = [];
const actions = {}; // type -> { role, handler, module }

async function loadModules() {
  const dir = path.join(ROOT, 'server', 'modules');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    try {
      const mod = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!mod || !mod.name) {
        console.warn(`[modules] ${f}: no default export with a name, skipped`);
        continue;
      }
      modules.push(mod);
      for (const [type, def] of Object.entries(mod.actions || {})) {
        if (actions[type]) console.warn(`[modules] action ${type} redefined by ${mod.name}`);
        actions[type] = { role: def.role || 'gm', handler: def.handler, module: mod.name };
      }
      console.log(`[modules] ${mod.name} (${Object.keys(mod.actions || {}).length} actions)`);
    } catch (err) {
      console.error(`[modules] failed to load ${f}:`, err);
    }
  }
}

function initModules(state) {
  for (const m of modules) {
    if (typeof m.init === 'function') {
      try {
        m.init(state, { readSeed: (n, fb) => readJson(path.join(SEED_DIR, n), fb), seedDir: SEED_DIR });
      } catch (err) {
        console.error(`[modules] init failed for ${m.name}:`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const GM_USER = { id: 'gm', role: 'gm', name: 'MJ', characterIds: [] };

function hashPin(pin) {
  return crypto.createHash('sha256').update('sr-table:' + String(pin || '')).digest('hex');
}

function userFromToken(token) {
  const state = getState();
  const userId = state.sessions?.[token];
  if (!userId) return null;
  if (userId === 'gm') return GM_USER;
  const u = state.users[userId];
  if (!u) return null;
  return { id: u.id, role: 'player', name: u.name, characterIds: u.characterIds || [] };
}

function issueToken(userId) {
  const state = getState();
  state.sessions = state.sessions || {};
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = userId;
  persistNow(); // a fresh login must survive an immediate crash/close
  return token;
}

// ---------------------------------------------------------------------------
// Views: what each connected user is allowed to see
// ---------------------------------------------------------------------------
function buildView(user) {
  const state = getState();
  const { sessions, config, ...rest } = state;
  const view = deepClone(rest);
  view.config = { campaignName: config?.campaignName || 'Shadowrun' };
  view.me = { id: user.id, role: user.role, name: user.name, characterIds: user.characterIds };
  if (user.role === 'gm') {
    view.users = Object.fromEntries(Object.values(state.users).map((u) => [u.id, { id: u.id, name: u.name, characterIds: u.characterIds }]));
    view.online = onlineUsers();
    // Modules may trim heavy or useless data from the GM view too (e.g. raw Chummer XML).
    for (const m of modules) {
      if (typeof m.gmFilter === 'function') {
        try {
          m.gmFilter(view, user, state);
        } catch (err) {
          console.error(`[modules] gmFilter failed for ${m.name}:`, err);
        }
      }
    }
    return view;
  }
  // Players: strip private data. Modules then filter their own slices.
  view.users = Object.fromEntries(Object.values(state.users).map((u) => [u.id, { id: u.id, name: u.name, characterIds: u.characterIds }]));
  view.online = onlineUsers();
  view.log = (view.log || []).filter((e) => !e.gmOnly && (!e.to || e.to.includes(user.id) || e.userId === user.id));
  for (const m of modules) {
    if (typeof m.filter === 'function') {
      try {
        m.filter(view, user, state);
      } catch (err) {
        console.error(`[modules] filter failed for ${m.name}:`, err);
      }
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '20mb' }));

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  return token ? userFromToken(token) : null;
}
export function requireUser(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non connecté' });
  req.user = u;
  next();
}
export function requireGM(req, res, next) {
  const u = authUser(req);
  if (!u || u.role !== 'gm') return res.status(403).json({ error: 'Réservé au MJ' });
  req.user = u;
  next();
}

app.get('/api/lobby', (req, res) => {
  const state = getState();
  const pcs = Object.values(state.actors)
    .filter((a) => a.type === 'pc' && !a.retired)
    .map((a) => {
      const owner = Object.values(state.users).find((u) => (u.characterIds || []).includes(a.id));
      return { id: a.id, name: a.name, player: a.player || '', portrait: a.portrait || '', claimedBy: owner ? owner.name : null };
    });
  res.json({ campaignName: state.config.campaignName, pcs });
});

app.post('/api/login', (req, res) => {
  const state = getState();
  const { role, password, name, characterId, pin } = req.body || {};
  if (role === 'gm') {
    if (String(password || '') !== String(state.config.gmPassword)) return res.status(403).json({ error: 'Mot de passe MJ incorrect' });
    return res.json({ token: issueToken('gm'), user: GM_USER });
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) return res.status(400).json({ error: 'Indique ton nom' });
  let user = Object.values(state.users).find((u) => u.name.toLowerCase() === cleanName.toLowerCase());
  if (user) {
    if (user.pin && user.pin !== hashPin(pin)) return res.status(403).json({ error: 'Code PIN incorrect pour ce joueur' });
  } else {
    user = { id: uid('usr'), name: cleanName, pin: pin ? hashPin(pin) : null, characterIds: [] };
    state.users[user.id] = user;
  }
  if (characterId) {
    const actor = state.actors[characterId];
    if (!actor || actor.type !== 'pc') return res.status(400).json({ error: 'Personnage introuvable' });
    const owner = Object.values(state.users).find((u) => u.id !== user.id && (u.characterIds || []).includes(characterId));
    if (owner) return res.status(403).json({ error: `Ce personnage est déjà pris par ${owner.name}` });
    if (!user.characterIds.includes(characterId)) user.characterIds.push(characterId);
  }
  saveSoon();
  scheduleBroadcast();
  res.json({ token: issueToken(user.id), user: { id: user.id, role: 'player', name: user.name, characterIds: user.characterIds } });
});

app.get('/api/me', requireUser, (req, res) => res.json(req.user));

// Generic uploads (images, audio). Body = raw file bytes, header X-Filename.
app.post('/api/upload', requireUser, express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
  const original = String(req.headers['x-filename'] || 'fichier').replace(/[^\w.\-]+/g, '_').slice(-80);
  const ext = path.extname(original).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp3', '.ogg', '.wav', '.m4a', '.webm', '.pdf', '.md', '.json', '.chum5', '.xml'];
  if (!allowed.includes(ext)) return res.status(400).json({ error: `Type de fichier non supporté (${ext})` });
  const file = `${Date.now().toString(36)}-${original}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  res.json({ url: `/uploads/${file}`, name: original });
});

// Campaign documents (markdown files in ../Shadowrun), GM only.
// Lists *.md at the top level and one folder deep (e.g. "foundry/Open Book.md").
function listDocs() {
  if (!fs.existsSync(DOCS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(DOCS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(entry.name);
    else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const f of fs.readdirSync(path.join(DOCS_DIR, entry.name))) if (f.endsWith('.md')) out.push(`${entry.name}/${f}`);
    }
  }
  return out.sort((a, b) => (a.includes('/') - b.includes('/')) || a.localeCompare(b));
}
function docPath(name) {
  const clean = String(name || '').split(String.fromCharCode(92)).join('/');
  if (!clean.endsWith('.md') || clean.split('/').some((p) => !p || p === '..' || p === '.') || clean.split('/').length > 2) return null;
  const file = path.resolve(DOCS_DIR, clean);
  return file.startsWith(path.resolve(DOCS_DIR) + path.sep) && fs.existsSync(file) ? file : null;
}
app.get('/api/docs', requireGM, (req, res) => {
  res.json(listDocs().map((name) => {
    const st = fs.statSync(path.join(DOCS_DIR, name));
    return { name, folder: name.includes('/') ? name.split('/')[0] : '', size: st.size, mtime: st.mtimeMs };
  }));
});
// Name may contain one folder level: /api/docs/foundry%2FOpen%20Book.md or /api/docs/foundry/Open%20Book.md
app.get(['/api/docs/:name', '/api/docs/:folder/:name'], requireGM, (req, res) => {
  const name = req.params.folder ? `${req.params.folder}/${req.params.name}` : req.params.name;
  const file = docPath(name);
  if (!file) return res.status(404).json({ error: 'Document introuvable' });
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

// Save / backup / reset (GM)
app.post('/api/admin/backup', requireGM, (req, res) => {
  const file = backup('manual');
  if (!file) return res.status(500).json({ error: 'Sauvegarde impossible (voir la console du serveur)' });
  res.json({ file });
});
app.get('/api/admin/export', requireGM, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="shadowrun-state.json"');
  res.json(getState());
});
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
app.post('/api/admin/import', requireGM, (req, res) => {
  const next = req.body;
  if (!isObj(next) || !isObj(next.actors)) return res.status(400).json({ error: 'Fichier de sauvegarde invalide' });
  const cur = getState();
  const base = emptyState();
  for (const k of Object.keys(base)) if (next[k] === undefined) next[k] = base[k];
  if (!Array.isArray(next.log)) next.log = [];
  if (!isObj(next.users)) next.users = {};
  // Keep the live GM password/campaign settings when the file lacks them, and keep everyone logged in.
  next.config = { ...cur.config, ...(isObj(next.config) ? next.config : {}) };
  next.users = { ...cur.users, ...next.users };
  next.sessions = { ...(isObj(next.sessions) ? next.sessions : {}), ...(cur.sessions || {}) };
  for (const u of Object.values(next.users)) {
    if (!isObj(u)) continue;
    u.characterIds = (Array.isArray(u.characterIds) ? u.characterIds : []).filter((id) => next.actors[id]);
  }
  try {
    backup('before-import');
  } catch (err) {
    console.error('[import] backup failed', err);
  }
  replaceState(next);
  initModules(getState());
  persistNow();
  scheduleBroadcast();
  res.json({ ok: true });
});
app.post('/api/admin/reset', requireGM, (req, res) => {
  if (!backup('before-reset')) return res.status(500).json({ error: 'Sauvegarde préalable impossible : réinitialisation annulée' });
  const fresh = emptyState();
  fresh.config = getState().config;
  fresh.sessions = getState().sessions;
  fresh.users = getState().users;
  replaceState(fresh);
  initModules(getState());
  persistNow();
  scheduleBroadcast();
  res.json({ ok: true });
});

// Static files
const nm = path.join(ROOT, 'node_modules');
app.use('/vendor/preact', express.static(path.join(nm, 'preact')));
app.use('/vendor/htm', express.static(path.join(nm, 'htm')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
// Uploaded files (anyone logged in can upload) must never run script on our origin when opened directly:
// a sandbox CSP applies to documents only, so <img>/<audio> uses keep working; non-media types download.
const INERT_UPLOAD = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.wav', '.m4a', '.webm', '.pdf']);
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pdf') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    if (!INERT_UPLOAD.has(ext)) res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.use('/catalog', express.static(path.join(DATA_DIR, 'catalog')));
app.use('/assets', express.static(path.join(DATA_DIR, 'assets'), {
  setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); },
}));
// Content-Security-Policy for the app page: no inline scripts/handlers and no javascript: URLs (defence in depth
// against HTML injection). The only inline script is the import map, allowed by its hash (computed from the file).
function pageCsp() {
  let hash = '';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (m) hash = ` 'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`;
  } catch {}
  return [
    "default-src 'self'",
    `script-src 'self'${hash}`,
    "style-src 'self' 'unsafe-inline'",
    'img-src * data: blob:',
    'media-src * data: blob:',
    'connect-src * ws: wss: data: blob:',
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
const PAGE_CSP = pageCsp();
app.use(express.static(path.join(ROOT, 'client'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.toLowerCase().endsWith('.html')) res.setHeader('Content-Security-Policy', PAGE_CSP);
  },
}));

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
const server = http.createServer(app);
// perMessageDeflate: full-state broadcasts are large but very repetitive JSON (≈10× smaller compressed).
const io = new Server(server, { maxHttpBufferSize: 20e6, perMessageDeflate: { threshold: 2048 } });
const sockets = new Map(); // socket.id -> { socket, user }

function onlineUsers() {
  const ids = new Set();
  for (const { user } of sockets.values()) ids.add(user.id);
  return [...ids];
}

/**
 * Re-resolve every connected socket's user from its token: character (un)assignment, user removal and
 * state import take effect at once. Sockets whose session no longer exists are told and disconnected.
 */
function refreshSockets() {
  for (const [id, entry] of sockets) {
    const u = userFromToken(entry.socket.handshake.auth?.token);
    if (u) {
      entry.user = u;
      continue;
    }
    sockets.delete(id);
    try {
      entry.socket.emit('unauthorized');
      entry.socket.disconnect(true);
    } catch {}
  }
}

let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    refreshSockets();
    const cache = new Map();
    for (const { socket, user } of sockets.values()) {
      try {
        // Users with the same id (same player on two devices) share a view.
        if (!cache.has(user.id)) cache.set(user.id, buildView(user));
        socket.emit('state', cache.get(user.id));
      } catch (err) {
        console.error('[broadcast] view failed for', user.id, err);
      }
    }
  }, 30);
}

/** Send a transient event (sound, ping, toast…) to 'all', 'gm', 'players', or a user id / array of user ids. */
function emitTo(target, event, data) {
  refreshSockets();
  for (const { socket, user } of sockets.values()) {
    const hit =
      target === 'all' ||
      (target === 'gm' && user.role === 'gm') ||
      (target === 'players' && user.role === 'player') ||
      (Array.isArray(target) ? target.includes(user.id) : target === user.id);
    if (hit) socket.emit(event, data);
  }
}

/** Append a chat/system/roll entry to the shared log. */
function addLog(entry) {
  const state = getState();
  const e = { id: uid('log'), ts: Date.now(), kind: 'system', ...entry };
  state.log.push(e);
  if (state.log.length > 600) state.log.splice(0, state.log.length - 600);
  return e;
}

function makeCtx(user) {
  const state = getState();
  return {
    state,
    user,
    isGM: user.role === 'gm',
    /** True if the user is the GM or owns the actor. */
    owns(actorId) {
      return user.role === 'gm' || (user.characterIds || []).includes(actorId);
    },
    fail(msg) {
      throw new ActionError(msg);
    },
    log: addLog,
    emitTo,
    uid,
    now: Date.now(),
    /** Name of the user's main character (or their own name). */
    displayName() {
      if (user.role === 'gm') return 'MJ';
      const a = state.actors[user.characterIds?.[0]];
      return a ? a.name : user.name;
    },
  };
}

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const entry = { socket, user: socket.data.user };
  sockets.set(socket.id, entry);
  socket.emit('state', buildView(entry.user));
  scheduleBroadcast();

  socket.on('action', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { type, payload } = msg || {};
    // Refresh the user (character ownership may have changed since connecting).
    const user = userFromToken(socket.handshake.auth?.token);
    if (!user) {
      reply({ ok: false, error: 'Session expirée', code: 'unauthorized' });
      sockets.delete(socket.id);
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }
    entry.user = user;
    const def = actions[type];
    if (!def) return reply({ ok: false, error: `Action inconnue : ${type}` });
    if (def.role === 'gm' && user.role !== 'gm') return reply({ ok: false, error: 'Action réservée au MJ' });
    try {
      const result = def.handler(makeCtx(user), payload || {});
      saveSoon();
      scheduleBroadcast();
      reply({ ok: true, result });
    } catch (err) {
      if (!(err instanceof ActionError)) console.error(`[action ${type}]`, err);
      reply({ ok: false, error: err.message || String(err) });
    }
  });

  socket.on('disconnect', () => {
    sockets.delete(socket.id);
    scheduleBroadcast();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
await loadModules();
const state = loadState();
backup('boot'); // a copy of what was on disk before this run touches it
initModules(state);
persistNow();

for (const m of modules) {
  if (typeof m.routes === 'function') {
    try {
      m.routes(app, { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon });
    } catch (err) {
      console.error(`[modules] routes failed for ${m.name}:`, err);
    }
  }
}

// Last-resort SPA fallback.
app.use((req, res) => res.status(404).json({ error: 'Introuvable' }));

setInterval(() => {
  try {
    backup('auto');
  } catch (err) {
    console.error('[store] auto backup failed', err);
  }
}, 15 * 60 * 1000).unref();
// Flush pending changes on every way out (Ctrl+C, console window closed, kill, crash).
let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  flushState();
  try {
    backup('shutdown');
  } catch {}
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => shutdown(0));
  } catch {}
}
process.on('exit', () => flushState());
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception (server kept alive):', err);
  flushState();
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`\n  Shadowrun — ${getState().config.campaignName}`);
  console.log(`  MJ      : http://localhost:${PORT}   (mot de passe MJ : voir data/state.json > config.gmPassword, défaut "lazarus")`);
  for (const ip of ips) console.log(`  Joueurs : http://${ip}:${PORT}`);
  console.log('');
});

export { io, emitTo, addLog, scheduleBroadcast };
