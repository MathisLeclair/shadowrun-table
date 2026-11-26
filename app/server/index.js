// Shadowrun table server: HTTP + Socket.IO, authoritative game state, per-player filtered views.
// Hosts several independent tables (campaigns) — see ARCHITECTURE.md « Multi-table hosting ».
// Feature modules live in server/modules/*.js and are loaded automatically; they always work on ONE table's state.
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { ROOT, DATA_DIR, GLOBAL_ASSETS_DIR, readJson, emptyState, tableScope, currentTable } from './store.js';
import { Table, bootRegistry, listMetas, getMeta, updateMeta, setupAdminPassword } from './lib/tables.js';
import { registerAdminRoutes, createRateLimiter } from './lib/admin.js';
import { uid, deepClone } from '../shared/util.js';
import { ActionError } from './errors.js';
import { errorBody, normalizeLogEntry, dictionaryFiles, isLang, formatFr, cleanParams, t as translate } from './lib/i18n.js';

export { ActionError };
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Module registry
// ---------------------------------------------------------------------------
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

/** Run every module's init on a table's state, with that table's content pack as seed source. */
function initModules(table) {
  const seedDir = table.packDir;
  tableScope.run(table, () => {
    for (const m of modules) {
      if (typeof m.init !== 'function') continue;
      try {
        m.init(table.state, { readSeed: (n, fb) => readJson(path.join(seedDir, n), fb), seedDir, tableId: table.id, table: table.info() });
      } catch (err) {
        console.error(`[modules] init failed for ${m.name} (table ${table.id}):`, err);
      }
    }
    const c = table.state.config || (table.state.config = {});
    if (!['fr', 'en'].includes(c.lang)) c.lang = table.meta.lang || 'fr';
    if (!c.campaignName) c.campaignName = table.meta.name;
  });
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
const tables = new Map(); // id -> Table (open = loaded in memory; archived tables are closed)

/** Load a table (state + seeds) and keep it open. Returns the Table (with .error set if its state is unreadable). */
function openTable(meta) {
  if (tables.has(meta.id)) return tables.get(meta.id);
  const t = new Table(meta);
  try {
    tableScope.run(t, () => {
      t.store.load();
      t.store.backup('boot'); // a copy of what was on disk before this run touches it
    });
    initModules(t);
    t.store.saveNow();
    syncMetaFromState(t);
  } catch (err) {
    t.error = err.message || String(err);
    console.error(`[tables] table « ${meta.id} » indisponible :`, t.error);
  }
  tables.set(meta.id, t);
  return t;
}

/** Flush and unload a table; its connected users are sent back to the login screen. */
function closeTable(id, { reason = 'closed' } = {}) {
  const t = tables.get(id);
  if (!t) return;
  clearTimeout(t.broadcastTimer);
  for (const { socket } of t.sockets.values()) {
    try {
      socket.emit('unauthorized', { reason });
      socket.disconnect(true);
    } catch {}
  }
  t.sockets.clear();
  if (!t.error) {
    t.store.flush();
    t.store.backup('shutdown');
  }
  tables.delete(id);
}

/** The GM renamed the campaign / changed its language: the table's registry entry follows. */
function syncMetaFromState(t) {
  const name = t.state?.config?.campaignName;
  const lang = t.state?.config?.lang;
  const patch = {};
  if (name && name !== t.meta.name) patch.name = String(name).slice(0, 80);
  if (isLang(lang) && lang !== t.meta.lang) patch.lang = lang;
  if (Object.keys(patch).length) updateMeta(t.id, patch);
}

const usableTable = (t) => (t && !t.error && !t.meta.archived ? t : null);
function tableBySlug(slug) {
  const meta = listMetas().find((m) => m.slug === String(slug || '').toLowerCase());
  return meta ? usableTable(tables.get(meta.id)) : null;
}
/** Table used by requests that don't name one (old clients, tests): the legacy table, else the only table. */
function defaultTable() {
  const open = [...tables.values()].filter(usableTable);
  return open.find((t) => t.legacy) || (open.length === 1 ? open[0] : null);
}

// ---------------------------------------------------------------------------
// Auth (sessions live in each table's state: state.sessions[token] = userId)
// ---------------------------------------------------------------------------
const GM_USER = { id: 'gm', role: 'gm', name: 'MJ', characterIds: [] };

/** Language chosen by a user (null = follow the table's language). The GM's choice lives in config.gmLang. */
function userLang(state, userId) {
  const l = userId === 'gm' ? state.config?.gmLang : state.users?.[userId]?.lang;
  return isLang(l) ? l : null;
}
function setUserLang(state, userId, lang) {
  const l = isLang(lang) ? lang : null;
  if (userId === 'gm') state.config.gmLang = l;
  else if (state.users?.[userId]) state.users[userId].lang = l;
}

function hashPin(pin) {
  return crypto.createHash('sha256').update('sr-table:' + String(pin || '')).digest('hex');
}

function userFromToken(table, token) {
  const state = table?.state;
  if (!state || !token) return null;
  const userId = state.sessions?.[token];
  if (!userId) return null;
  if (userId === 'gm') return GM_USER;
  const u = state.users?.[userId];
  if (!u) return null;
  return { id: u.id, role: 'player', name: u.name, characterIds: u.characterIds || [] };
}

/** Table holding this session token (restricted to `hint` when the client names its table). */
function tableForToken(token, hint) {
  if (!token || typeof token !== 'string') return null;
  if (hint) return userFromToken(hint, token) ? hint : null;
  for (const t of tables.values()) if (usableTable(t) && t.state.sessions?.[token]) return t;
  return null;
}

function issueToken(table, userId) {
  const state = table.state;
  state.sessions = state.sessions || {};
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = userId;
  table.store.saveNow(); // a fresh login must survive an immediate crash/close
  return token;
}

// ---------------------------------------------------------------------------
// Views: what each connected user is allowed to see
// ---------------------------------------------------------------------------
function onlineUsers(table) {
  const ids = new Set();
  for (const { user } of table.sockets.values()) ids.add(user.id);
  return [...ids];
}

function buildView(table, user) {
  const state = table.state;
  const { sessions, config, ...rest } = state;
  const view = deepClone(rest);
  view.config = { campaignName: config?.campaignName || 'Shadowrun', lang: config?.lang || 'fr', table: table.info() };
  view.me = { id: user.id, role: user.role, name: user.name, characterIds: user.characterIds, lang: userLang(state, user.id) };
  view.users = Object.fromEntries(Object.values(state.users).map((u) => [u.id, { id: u.id, name: u.name, characterIds: u.characterIds }]));
  view.online = onlineUsers(table);
  if (user.role === 'gm') {
    // Modules may trim heavy or useless data from the GM view too (e.g. raw Chummer XML).
    for (const m of modules) {
      if (typeof m.gmFilter !== 'function') continue;
      try {
        m.gmFilter(view, user, state);
      } catch (err) {
        console.error(`[modules] gmFilter failed for ${m.name}:`, err);
      }
    }
    return view;
  }
  // Players: strip private data. Modules then filter their own slices.
  view.log = (view.log || []).filter((e) => !e.gmOnly && (!e.to || e.to.includes(user.id) || e.userId === user.id));
  for (const m of modules) {
    if (typeof m.filter !== 'function') continue;
    try {
      m.filter(view, user, state);
    } catch (err) {
      console.error(`[modules] filter failed for ${m.name}:`, err);
    }
  }
  return view;
}

/**
 * Re-resolve every connected socket's user from its token: character (un)assignment, user removal and
 * state import take effect at once. Sockets whose session no longer exists are told and disconnected.
 */
function refreshSockets(table) {
  for (const [id, entry] of table.sockets) {
    const u = userFromToken(table, entry.socket.handshake.auth?.token);
    if (u) {
      entry.user = u;
      continue;
    }
    table.sockets.delete(id);
    try {
      entry.socket.emit('unauthorized');
      entry.socket.disconnect(true);
    } catch {}
  }
}

function broadcastTable(table) {
  if (!usableTable(table) || tables.get(table.id) !== table) return;
  tableScope.run(table, () => {
    refreshSockets(table);
    const cache = new Map();
    for (const { socket, user } of table.sockets.values()) {
      try {
        // Users with the same id (same player on two devices) share a view.
        if (!cache.has(user.id)) cache.set(user.id, buildView(table, user));
        socket.emit('state', cache.get(user.id));
      } catch (err) {
        console.error(`[broadcast] view failed for ${table.id}/${user.id}`, err);
      }
    }
  });
}

/** Debounced (30 ms) broadcast of fresh views to everyone at this table. */
function scheduleTableBroadcast(table) {
  if (!table || table.broadcastTimer) return;
  table.broadcastTimer = setTimeout(() => {
    table.broadcastTimer = null;
    broadcastTable(table);
  }, 30);
}

/** Send a transient event (sound, ping, toast…) to 'all', 'gm', 'players', or a user id / array of user ids — at this table only. */
function emitToTable(table, target, event, data) {
  if (!table) return;
  refreshSockets(table);
  for (const { socket, user } of table.sockets.values()) {
    const hit =
      target === 'all' ||
      (target === 'gm' && user.role === 'gm') ||
      (target === 'players' && user.role === 'player') ||
      (Array.isArray(target) ? target.includes(user.id) : target === user.id);
    if (hit) socket.emit(event, data);
  }
}

/** Append a chat/system/roll entry to a table's shared log. */
function addLogTo(table, entry) {
  const state = table.state;
  const e = normalizeLogEntry({ id: uid('log'), ts: Date.now(), kind: 'system', ...entry });
  state.log.push(e);
  if (state.log.length > 600) state.log.splice(0, state.log.length - 600);
  return e;
}

// Table-aware helpers for modules: they act on the table of the running request/action (tableScope),
// or on req's table when a request is passed (getState(req), scheduleBroadcast(req)).
const scopeOf = (req) => (req && req.srTable) || currentTable();
function noScope(what) {
  console.error(`[tables] ${what} appelé hors de toute table`, new Error().stack.split('\n').slice(2, 4).join(' | '));
}
const getState = (req) => scopeOf(req)?.state || null;
const scheduleBroadcast = (req) => {
  const t = scopeOf(req);
  if (t) scheduleTableBroadcast(t);
  else noScope('scheduleBroadcast');
};
const emitTo = (target, event, data) => {
  const t = currentTable();
  if (t) emitToTable(t, target, event, data);
  else noScope('emitTo');
};
const addLog = (entry) => {
  const t = currentTable();
  if (t) return addLogTo(t, entry);
  noScope('addLog');
  return null;
};
const saveSoon = () => {
  const t = currentTable();
  if (t) t.store.saveSoon();
  else noScope('saveSoon');
};

function makeCtx(table, user) {
  const state = table.state;
  return {
    state,
    user,
    isGM: user.role === 'gm',
    tableId: table.id,
    table: table.info(),
    /** True if the user is the GM or owns the actor. */
    owns(actorId) {
      return user.role === 'gm' || (user.characterIds || []).includes(actorId);
    },
    /** Throw a readable error: ctx.fail('Texte {x}', { x }) — the client shows it translated (errorKey + params). */
    fail(msg, params) {
      const p = cleanParams(params);
      const err = new ActionError(formatFr(msg, p));
      err.i18nKey = String(msg ?? '');
      err.i18nParams = p && Object.keys(p).length ? p : undefined;
      throw err;
    },
    /** The table's language, and t() rendering in it — only for texts that must be stored pre-rendered (rare). */
    lang: isLang(state.config?.lang) ? state.config.lang : 'fr',
    t: (key, params) => translate(isLang(state.config?.lang) ? state.config.lang : 'fr', key, params),
    log: (entry) => addLogTo(table, entry),
    emitTo: (target, event, data) => emitToTable(table, target, event, data),
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.SR_TRUST_PROXY === '1' ? 1 : false);
app.use(express.json({ limit: '20mb' }));

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
};

// Resolve the table of every request: URL prefix /t/<slug>/…, else the session token's table, else the named
// table (X-SR-Table header or ?table=), else the default table.
app.use((req, res, next) => {
  const m = /^\/t\/([a-z0-9-]+)(?:\/|$)/.exec(req.path);
  const hintSlug = m ? m[1] : String(req.headers['x-sr-table'] || req.query.table || '').toLowerCase();
  const hint = hintSlug ? tableBySlug(hintSlug) : null;
  req.srHint = hintSlug || '';
  const token = bearer(req);
  // A named table wins (a token of another table then simply fails authentication there).
  if (hintSlug) req.srTable = hint;
  else req.srTable = (token && tableForToken(token, null)) || defaultTable();
  next();
});

function authUser(req) {
  return req.srTable ? userFromToken(req.srTable, bearer(req)) : null;
}
export function requireUser(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json(errorBody('Non connecté'));
  req.user = u;
  tableScope.run(req.srTable, next);
}
export function requireGM(req, res, next) {
  const u = authUser(req);
  if (!u || u.role !== 'gm') return res.status(403).json(errorBody('Réservé au MJ'));
  req.user = u;
  tableScope.run(req.srTable, next);
}

/**
 * Express app given to modules: every handler they register runs inside the request's table scope
 * (body parsers lose AsyncLocalStorage context, so each handler re-enters it).
 */
function scopedApp(target) {
  const wrap = (h) => {
    if (Array.isArray(h)) return h.map(wrap);
    if (typeof h !== 'function') return h;
    if (h.length === 4) return (err, req, res, next) => (req.srTable ? tableScope.run(req.srTable, () => h(err, req, res, next)) : h(err, req, res, next));
    return (req, res, next) => (req.srTable ? tableScope.run(req.srTable, () => h(req, res, next)) : h(req, res, next));
  };
  const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
  return new Proxy(target, {
    get(t, k) {
      if (VERBS.has(k)) return (...args) => (k === 'get' && args.length === 1 ? t.get(args[0]) : t[k](...args.map(wrap)));
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

app.get('/api/health', (req, res) => {
  const open = [...tables.values()];
  res.json({ ok: open.every((t) => !t.error || t.meta.archived), tables: open.length, broken: open.filter((t) => t.error).map((t) => t.id), uptime: Math.round(process.uptime()) });
});

// Public list for the table picker (/).
app.get('/api/tables', (req, res) => {
  res.json({
    tables: listMetas()
      .filter((m) => !m.archived && !m.hidden && usableTable(tables.get(m.id)))
      .map((m) => {
        const t = tables.get(m.id);
        return { slug: m.slug, name: m.name, lang: t.info().lang, online: onlineUsers(t).length };
      }),
  });
});

const noTable = (req, res) => {
  const meta = req.srHint ? listMetas().find((m) => m.slug === req.srHint) : null;
  if (meta?.archived) return res.status(410).json(errorBody('Cette table est archivée', null, { code: 'archived' }));
  if (meta && tables.get(meta.id)?.error) return res.status(503).json(errorBody('Table momentanément indisponible (voir les journaux du serveur)', null, { code: 'broken' }));
  return res.status(404).json(errorBody(req.srHint ? 'Table introuvable' : 'Choisis une table', null, { code: 'no-table' }));
};

app.get('/api/lobby', (req, res) => {
  const t = req.srTable;
  if (!t) return noTable(req, res);
  const state = t.state;
  const pcs = Object.values(state.actors)
    .filter((a) => a.type === 'pc' && !a.retired)
    .map((a) => {
      const owner = Object.values(state.users).find((u) => (u.characterIds || []).includes(a.id));
      return { id: a.id, name: a.name, player: a.player || '', portrait: a.portrait || '', claimedBy: owner ? owner.name : null };
    });
  res.json({ campaignName: state.config.campaignName, table: t.info(), pcs });
});

// GM password guessing is throttled per IP and table (the app may face the Internet).
const loginLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });

app.post('/api/login', (req, res) => {
  const body = req.body || {};
  const t = body.table ? tableBySlug(body.table) : req.srTable;
  if (!t) {
    req.srHint = body.table ? String(body.table).toLowerCase() : req.srHint;
    return noTable(req, res);
  }
  const state = t.state;
  const { role, password, name, characterId, pin } = body;
  if (role === 'gm') {
    const key = `gm|${t.id}|${req.ip}`;
    if (loginLimiter.blocked(key)) return res.status(429).json(errorBody('Trop de tentatives : réessaie dans quelques minutes'));
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(String(state.config.gmPassword));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      loginLimiter.fail(key);
      return res.status(403).json(errorBody('Mot de passe MJ incorrect'));
    }
    loginLimiter.reset(key);
    if (isLang(body.lang)) setUserLang(state, 'gm', body.lang); // language picked on the login screen
    return res.json({ token: issueToken(t, 'gm'), user: { ...GM_USER, lang: userLang(state, 'gm') }, table: t.info() });
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) return res.status(400).json(errorBody('Indique ton nom'));
  let user = Object.values(state.users).find((u) => u.name.toLowerCase() === cleanName.toLowerCase());
  if (user) {
    if (user.pin) {
      const key = `pin|${t.id}|${user.id}|${req.ip}`;
      if (loginLimiter.blocked(key)) return res.status(429).json(errorBody('Trop de tentatives : réessaie dans quelques minutes'));
      if (user.pin !== hashPin(pin)) {
        loginLimiter.fail(key);
        return res.status(403).json(errorBody('Code PIN incorrect pour ce joueur'));
      }
    }
  } else {
    user = { id: uid('usr'), name: cleanName, pin: pin ? hashPin(pin) : null, characterIds: [] };
    state.users[user.id] = user;
  }
  if (characterId) {
    const actor = state.actors[characterId];
    if (!actor || actor.type !== 'pc') return res.status(400).json(errorBody('Personnage introuvable'));
    const owner = Object.values(state.users).find((u) => u.id !== user.id && (u.characterIds || []).includes(characterId));
    if (owner) return res.status(403).json(errorBody('Ce personnage est déjà pris par {name}', { name: owner.name }));
    if (!user.characterIds.includes(characterId)) user.characterIds.push(characterId);
  }
  if (isLang(body.lang)) user.lang = body.lang; // language picked on the login screen
  t.store.saveSoon();
  scheduleTableBroadcast(t);
  res.json({ token: issueToken(t, user.id), user: { id: user.id, role: 'player', name: user.name, characterIds: user.characterIds, lang: userLang(state, user.id) }, table: t.info() });
});

app.get('/api/me', requireUser, (req, res) => res.json({ ...req.user, lang: userLang(req.srTable.state, req.user.id), table: req.srTable.info() }));

// Generic uploads (images, audio). Body = raw file bytes, header X-Filename. Stored in the table's uploads folder.
app.post('/api/upload', requireUser, express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
  const t = req.srTable;
  const original = String(req.headers['x-filename'] || 'fichier').replace(/[^\w.\-]+/g, '_').slice(-80);
  const ext = path.extname(original).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp3', '.ogg', '.wav', '.m4a', '.webm', '.pdf', '.md', '.json', '.chum5', '.xml'];
  if (!allowed.includes(ext)) return res.status(400).json(errorBody('Type de fichier non supporté ({ext})', { ext }));
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json(errorBody('Fichier vide'));
  const file = `${Date.now().toString(36)}-${original}`;
  try {
    fs.mkdirSync(t.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(t.uploadDir, file), req.body);
  } catch (err) {
    console.error('[upload]', err);
    return res.status(500).json(errorBody('Écriture impossible sur le serveur ({reason})', { reason: err.code || err.message }));
  }
  res.json({ url: `${t.uploadUrl}/${file}`, name: original });
});

// Campaign documents (markdown files of the table's docs folder), GM only.
// Lists *.md at the top level and one folder deep (e.g. "foundry/Open Book.md").
function listDocs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(entry.name);
    else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const f of fs.readdirSync(path.join(dir, entry.name))) if (f.endsWith('.md')) out.push(`${entry.name}/${f}`);
    }
  }
  return out.sort((a, b) => (a.includes('/') - b.includes('/')) || a.localeCompare(b));
}
function docPath(dir, name) {
  const clean = String(name || '').split(String.fromCharCode(92)).join('/');
  if (!clean.endsWith('.md') || clean.split('/').some((p) => !p || p === '..' || p === '.') || clean.split('/').length > 2) return null;
  const file = path.resolve(dir, clean);
  return file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file) ? file : null;
}
app.get('/api/docs', requireGM, (req, res) => {
  const dir = req.srTable.docsDir();
  res.json(listDocs(dir).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, folder: name.includes('/') ? name.split('/')[0] : '', size: st.size, mtime: st.mtimeMs };
  }));
});
// Name may contain one folder level: /api/docs/foundry%2FOpen%20Book.md or /api/docs/foundry/Open%20Book.md
app.get(['/api/docs/:name', '/api/docs/:folder/:name'], requireGM, (req, res) => {
  const name = req.params.folder ? `${req.params.folder}/${req.params.name}` : req.params.name;
  const file = docPath(req.srTable.docsDir(), name);
  if (!file) return res.status(404).json(errorBody('Document introuvable'));
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

// Save / backup / reset of the GM's own table.
app.post('/api/admin/backup', requireGM, (req, res) => {
  const file = req.srTable.store.backup('manual');
  if (!file) return res.status(500).json(errorBody('Sauvegarde impossible (voir la console du serveur)'));
  res.json({ file });
});
app.get('/api/admin/export', requireGM, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="shadowrun-${req.srTable.slug}.json"`);
  res.json(req.srTable.state);
});
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Replace a table's whole state (import, restore): keeps the live GM password/settings when missing and everyone logged in. */
function importInto(t, next, { keepSessions = true } = {}) {
  const cur = t.state;
  const base = emptyState();
  for (const k of Object.keys(base)) if (next[k] === undefined) next[k] = base[k];
  if (!Array.isArray(next.log)) next.log = [];
  if (!isObj(next.users)) next.users = {};
  next.config = { ...cur.config, ...(isObj(next.config) ? next.config : {}) };
  if (keepSessions) {
    next.users = { ...cur.users, ...next.users };
    next.sessions = { ...(isObj(next.sessions) ? next.sessions : {}), ...(cur.sessions || {}) };
  }
  for (const u of Object.values(next.users)) {
    if (!isObj(u)) continue;
    u.characterIds = (Array.isArray(u.characterIds) ? u.characterIds : []).filter((id) => next.actors[id]);
  }
  t.store.backup('before-import');
  t.store.replace(next);
  initModules(t);
  t.store.saveNow();
  syncMetaFromState(t);
  scheduleTableBroadcast(t);
}
app.post('/api/admin/import', requireGM, (req, res) => {
  const next = req.body;
  if (!isObj(next) || !isObj(next.actors)) return res.status(400).json(errorBody('Fichier de sauvegarde invalide'));
  importInto(req.srTable, next);
  res.json({ ok: true });
});
app.post('/api/admin/reset', requireGM, (req, res) => {
  const t = req.srTable;
  if (!t.store.backup('before-reset')) return res.status(500).json(errorBody('Sauvegarde préalable impossible : réinitialisation annulée'));
  const fresh = emptyState();
  fresh.config = t.state.config;
  fresh.sessions = t.state.sessions;
  fresh.users = t.state.users;
  t.store.replace(fresh);
  initModules(t);
  t.store.saveNow();
  scheduleTableBroadcast(t);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const nm = path.join(ROOT, 'node_modules');
app.use('/vendor/preact', express.static(path.join(nm, 'preact')));
app.use('/vendor/htm', express.static(path.join(nm, 'htm')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
// Translation dictionaries: client/i18n/<lang>/*.json are served by the client static handler below; the
// index listing them is generated from the folder so adding a file needs no code change.
app.get('/i18n/:lang/index.json', (req, res) => {
  if (!isLang(req.params.lang)) return res.status(404).json(errorBody('Introuvable'));
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ lang: req.params.lang, files: dictionaryFiles(req.params.lang) });
});
app.use('/i18n', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache'); // dictionaries change while translators work: always revalidate (ETag)
  next();
});
// Uploaded files (anyone logged in can upload) must never run script on our origin when opened directly:
// a sandbox CSP applies to documents only, so <img>/<audio> uses keep working; non-media types download.
const INERT_UPLOAD = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.wav', '.m4a', '.webm', '.pdf']);
const uploadHeaders = {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pdf') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    if (!INERT_UPLOAD.has(ext)) res.setHeader('Content-Disposition', 'attachment');
  },
};
const assetHeaders = { setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); } };
const staticCache = new Map(); // dir -> express.static handler
const staticFor = (dir, opts) => {
  if (!staticCache.has(dir)) staticCache.set(dir, express.static(dir, { ...opts, index: false, dotfiles: 'deny' }));
  return staticCache.get(dir);
};
// Historical URLs (/uploads/…) belong to the legacy table (the migrated « Project Lazarus »).
app.use('/uploads', (req, res, next) => {
  const t = [...tables.values()].find((x) => x.legacy && !x.meta.archived);
  if (!t) return next();
  staticFor(t.uploadDir, uploadHeaders)(req, res, next);
});
app.use('/t/:slug/uploads', (req, res, next) => {
  const t = tableBySlug(req.params.slug);
  if (!t) return next();
  staticFor(t.uploadDir, uploadHeaders)(req, res, next);
});
app.use('/t/:slug/assets', (req, res, next) => {
  const t = tableBySlug(req.params.slug);
  if (!t) return next();
  staticFor(path.join(t.dir, 'assets'), assetHeaders)(req, res, next);
});
app.use('/catalog', express.static(path.join(DATA_DIR, 'catalog')));
app.use('/assets', express.static(GLOBAL_ASSETS_DIR, assetHeaders));

// Content-Security-Policy for the app page: no inline scripts/handlers and no javascript: URLs (defence in depth
// against HTML injection). The only inline script is the import map, allowed by its hash (computed from the file).
const INDEX_FILE = path.join(ROOT, 'client', 'index.html');
function pageCsp() {
  let hash = '';
  try {
    const html = fs.readFileSync(INDEX_FILE, 'utf8');
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
function sendPage(req, res) {
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(INDEX_FILE);
}
// The same page serves the table picker (/), the admin page (/admin) and every table (/t/<slug>/).
app.get('/', (req, res) => {
  const listed = listMetas().filter((m) => !m.archived && !m.hidden && usableTable(tables.get(m.id)));
  // Old bookmarks: with a single table, / goes straight to it (/?choisir shows the picker anyway).
  if (listed.length === 1 && req.query.choisir === undefined) return res.redirect(302, `/t/${listed[0].slug}/`);
  sendPage(req, res);
});
app.get(['/admin', '/admin/'], sendPage);
// (non-strict routing: '/t/:slug' also matches '/t/x/')
app.get('/t/:slug', (req, res) => (req.path.endsWith('/') ? sendPage(req, res) : res.redirect(301, `/t/${encodeURIComponent(req.params.slug)}/`)));
app.use(express.static(path.join(ROOT, 'client'), {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.toLowerCase().endsWith('.html')) res.setHeader('Content-Security-Policy', PAGE_CSP);
  },
}));

// ---------------------------------------------------------------------------
// Socket.IO — one room per table; views and events never cross tables.
// ---------------------------------------------------------------------------
const server = http.createServer(app);
// Big zip uploads (Foundry worlds, table restores) can take a long time on a home connection:
// Node's default 5-minute request timeout would cut them.
server.requestTimeout = 4 * 3600 * 1000;
server.headersTimeout = 60 * 1000;
// perMessageDeflate: full-state broadcasts are large but very repetitive JSON (≈10× smaller compressed).
const io = new Server(server, { maxHttpBufferSize: 20e6, perMessageDeflate: { threshold: 2048 } });

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const hintSlug = typeof auth.table === 'string' ? auth.table.toLowerCase() : '';
  const hint = hintSlug ? tableBySlug(hintSlug) : null;
  if (hintSlug && !hint) return next(new Error('unauthorized'));
  const t = tableForToken(auth.token, hint);
  const user = userFromToken(t, auth.token);
  if (!t || !user) return next(new Error('unauthorized'));
  socket.data.table = t;
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const t = socket.data.table;
  const entry = { socket, user: socket.data.user };
  t.sockets.set(socket.id, entry);
  socket.join(`table:${t.id}`);
  tableScope.run(t, () => socket.emit('state', buildView(t, entry.user)));
  scheduleTableBroadcast(t);

  socket.on('action', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { type, payload } = msg || {};
    // Refresh the user (character ownership may have changed since connecting).
    const live = usableTable(tables.get(t.id)) === t ? t : null;
    const user = live ? userFromToken(t, socket.handshake.auth?.token) : null;
    if (!user) {
      reply({ ok: false, ...errorBody('Session expirée'), code: 'unauthorized' });
      t.sockets.delete(socket.id);
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }
    entry.user = user;
    const def = actions[type];
    if (!def) return reply({ ok: false, ...errorBody('Action inconnue : {type}', { type: String(type).slice(0, 80) }) });
    if (def.role === 'gm' && user.role !== 'gm') return reply({ ok: false, ...errorBody('Action réservée au MJ') });
    try {
      const result = tableScope.run(t, () => def.handler(makeCtx(t, user), payload || {}));
      t.store.saveSoon();
      scheduleTableBroadcast(t);
      syncMetaFromState(t);
      reply({ ok: true, result });
    } catch (err) {
      if (!(err instanceof ActionError)) console.error(`[action ${type} @${t.id}]`, err);
      const i18n = err instanceof ActionError && err.i18nKey ? { errorKey: err.i18nKey, ...(err.i18nParams ? { params: err.i18nParams } : {}) } : {};
      reply({ ok: false, error: err.message || String(err), ...i18n });
    }
  });

  socket.on('disconnect', () => {
    t.sockets.delete(socket.id);
    scheduleTableBroadcast(t);
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
await loadModules();
bootRegistry();
setupAdminPassword();
for (const meta of listMetas()) if (!meta.archived) openTable(meta);

const tableApi = {
  tables, openTable, closeTable, initModules, importInto, scheduleTableBroadcast, onlineUsers, issueToken, getMeta, usableTable, tableBySlug,
};
registerAdminRoutes(app, tableApi);

const scoped = scopedApp(app);
for (const m of modules) {
  if (typeof m.routes !== 'function') continue;
  try {
    m.routes(scoped, { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon, tableApi });
  } catch (err) {
    console.error(`[modules] routes failed for ${m.name}:`, err);
  }
}

// Last resort: JSON 404 (API) — and a JSON error instead of an HTML stack trace.
app.use((req, res) => res.status(404).json(errorBody('Introuvable')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json(errorBody('Fichier trop volumineux'));
  if (err?.type === 'entity.parse.failed') return res.status(400).json(errorBody('Requête invalide (JSON)'));
  console.error('[http]', req.method, req.path, err);
  if (!res.headersSent) res.status(err?.status || 500).json(err?.expose ? { error: err.message } : errorBody('Erreur du serveur'));
});

setInterval(() => {
  for (const t of tables.values()) {
    if (t.error) continue;
    try {
      t.store.backup('auto');
    } catch (err) {
      console.error(`[store:${t.id}] auto backup failed`, err);
    }
  }
}, 15 * 60 * 1000).unref();

// Flush pending changes on every way out (Ctrl+C, console window closed, kill, crash).
let exiting = false;
const flushAll = () => {
  for (const t of tables.values()) if (!t.error) t.store.flush();
};
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  flushAll();
  for (const t of tables.values()) {
    if (t.error) continue;
    try {
      t.store.backup('shutdown');
    } catch {}
  }
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => shutdown(0));
  } catch {}
}
process.on('exit', flushAll);
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception (server kept alive):', err);
  flushAll();
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`\n  Shadowrun — ${tables.size} table(s) : ${[...tables.values()].map((t) => `${t.name} (/t/${t.slug}/)`).join(', ') || 'aucune'}`);
  console.log(`  Accueil  : http://localhost:${PORT}/        Administration : http://localhost:${PORT}/admin`);
  for (const ip of ips) console.log(`  Joueurs  : http://${ip}:${PORT}/`);
  console.log('');
});

export { io, emitTo, addLog, scheduleBroadcast };
