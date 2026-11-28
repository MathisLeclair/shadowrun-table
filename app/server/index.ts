// Shadowrun table server: HTTP + Socket.IO, authoritative game state, per-player filtered views.
// Hosts several independent tables (campaigns) — see ARCHITECTURE.md « Multi-table hosting ».
// Feature modules live in server/modules/*.ts and are loaded automatically; they always work on ONE table's state.
import express from 'express';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import type { ViteDevServer } from 'vite';
import { ROOT, DATA_DIR, GLOBAL_ASSETS_DIR, readJson, emptyState, tableScope, currentTable } from './store.ts';
import { Table, bootRegistry, listMetas, getMeta, updateMeta, setupAdminPassword, ensureDemoTable } from './lib/tables.ts';
import type { StoredMeta, TableApi, SocketEntry } from './lib/tables.ts';
import { registerAdminRoutes, createRateLimiter } from './lib/admin.ts';
import { uid, deepClone } from '../shared/util.ts';
import { syncSpiritControl } from '../shared/magic.ts';
import { displayByToken, displayUserId } from '../shared/display.ts';
import { ActionError } from './errors.ts';
import { errorBody, normalizeLogEntry, dictionaryFiles, isLang, formatSource, cleanParams, t as translate } from './lib/i18n.ts';
import {
  isDemo, DEMO, demoHttpGuard, demoUploadError, demoActionError, demoLoginBlocked, resetDemoTable, startDemoScheduler, instrumentDemo, demoPresence,
} from './lib/demo.ts';
import type {
  ActionContext, ActionDef, ActionPayload, ActionResponse, EmitTarget, GameView, I18nParams, Lang, LogEntry, NewLogEntry, RouteHelpers,
  ServerEvents, ServerModule, SessionUser, TableState, User, UserId,
} from '../shared/types.ts';

export { ActionError };
const PORT = Number(process.env.PORT) || 3000;

/** A server module as the core sees it: Express app, Express middleware. */
export type CoreModule = ServerModule<Express, RequestHandler>;
/** The helpers given to modules' routes(). */
export type CoreRouteHelpers = RouteHelpers<RequestHandler>;
/** A registered action: its role, handler and owning module. */
interface RegisteredAction extends ActionDef {
  role: 'gm' | 'any';
  module: string;
}

// ---------------------------------------------------------------------------
// Module registry
// ---------------------------------------------------------------------------
const modules: CoreModule[] = [];
const actions: Record<string, RegisteredAction> = {}; // type -> { role, handler, module }

/** Module files (server/modules/*.ts) in load order: by file name (NN-name.ts). */
function moduleFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort((a, b) => a.slice(0, -3).localeCompare(b.slice(0, -3)));
}

async function loadModules(): Promise<void> {
  const dir = path.join(ROOT, 'server', 'modules');
  for (const f of moduleFiles(dir)) {
    try {
      const mod = (await import(pathToFileURL(path.join(dir, f)).href)).default as CoreModule | undefined;
      if (!mod || !mod.name) {
        console.warn(`[modules] ${f}: no default export with a name, skipped`);
        continue;
      }
      if (modules.some((m) => m.name === mod.name)) {
        console.warn(`[modules] ${f}: module ${mod.name} already loaded, skipped`);
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

/**
 * Run every module's init on a table's state, with that table's content pack as seed source. A pack built on a base
 * pack (demo = blank + extras) runs the inits once per folder, base first: inits only add what is missing.
 */
function initModules(table: Table): void {
  tableScope.run(table, () => {
    for (const seedDir of table.packDirs) {
      for (const m of modules) {
        if (typeof m.init !== 'function') continue;
        try {
          m.init(table.state, { readSeed: (n, fb) => readJson(path.join(seedDir, n), fb), seedDir, tableId: table.id, table: table.info() });
        } catch (err) {
          console.error(`[modules] init failed for ${m.name} (table ${table.id}):`, err);
        }
      }
    }
    const c = table.state.config || (table.state.config = {} as TableState['config']);
    if (!['fr', 'en'].includes(c.lang)) c.lang = table.meta.lang || 'fr';
    if (!c.campaignName) c.campaignName = table.meta.name;
  });
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
const tables = new Map<string, Table>(); // id -> Table (open = loaded in memory; archived tables are closed)

/** Load a table (state + seeds) and keep it open. Returns the Table (with .error set if its state is unreadable). */
function openTable(meta: StoredMeta): Table {
  const open = tables.get(meta.id);
  if (open) return open;
  const t = new Table(meta);
  instrumentDemo(t);
  try {
    tableScope.run(t, () => {
      t.store.load();
      t.store.backup('boot'); // a copy of what was on disk before this run touches it
    });
    initModules(t);
    t.store.saveNow();
    syncMetaFromState(t);
  } catch (err) {
    t.error = (err as Error).message || String(err);
    console.error(`[tables] table "${meta.id}" unavailable:`, t.error);
  }
  tables.set(meta.id, t);
  return t;
}

/** Flush and unload a table; its connected users are sent back to the login screen. */
function closeTable(id: string, { reason = 'closed' }: { reason?: string } = {}): void {
  const t = tables.get(id);
  if (!t) return;
  if (t.broadcastTimer) clearTimeout(t.broadcastTimer);
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

/** The GM renamed the campaign / changed its language: the table's registry entry follows (not on a demo table). */
function syncMetaFromState(t: Table): void {
  if (isDemo(t)) return;
  const name = t.state?.config?.campaignName;
  const lang = t.state?.config?.lang;
  const patch: Partial<StoredMeta> = {};
  if (name && name !== t.meta.name) patch.name = String(name).slice(0, 80);
  if (isLang(lang) && lang !== t.meta.lang) patch.lang = lang;
  if (Object.keys(patch).length) updateMeta(t.id, patch);
}

const usableTable = (t: Table | null | undefined): Table | null => (t && !t.error && !t.meta.archived ? t : null);
function tableBySlug(slug: unknown): Table | null {
  const meta = listMetas().find((m) => m.slug === String(slug || '').toLowerCase());
  return meta ? usableTable(tables.get(meta.id)) : null;
}
/** Table used by requests that don't name one (old clients, tests): the legacy table, else the only table. */
function defaultTable(): Table | null {
  const open = [...tables.values()].filter(usableTable);
  return open.find((t) => t.legacy) || (open.length === 1 ? open[0] : null);
}

// ---------------------------------------------------------------------------
// Auth (sessions live in each table's state: state.sessions[token] = userId)
// ---------------------------------------------------------------------------
// 'MJ' is a stored value (log authors, order.by…): the client shows it as t('GM'). Keep it.
const GM_USER: SessionUser = { id: 'gm', role: 'gm', name: 'MJ', characterIds: [] };

/** Language chosen by a user (null = follow the table's language). The GM's choice lives in config.gmLang. */
function userLang(state: TableState, userId: UserId): Lang | null {
  const l = userId === 'gm' ? state.config?.gmLang : state.users?.[userId]?.lang;
  return isLang(l) ? l : null;
}
function setUserLang(state: TableState, userId: UserId, lang: unknown): void {
  const l = isLang(lang) ? lang : null;
  if (userId === 'gm') state.config.gmLang = l;
  else if (state.users?.[userId]) state.users[userId].lang = l;
}

function hashPin(pin: unknown): string {
  return crypto.createHash('sha256').update('sr-table:' + String(pin || '')).digest('hex');
}

function userFromToken(table: Table | null | undefined, token: unknown): SessionUser | null {
  const state = table?.state;
  if (!state || !token) return null;
  const userId = state.sessions?.[token as string];
  if (!userId) {
    // A table display link (96-display): read-only, sees the table like a player without characters.
    const d = displayByToken(state, token);
    return d ? { id: displayUserId(d.id), role: 'display', name: d.name, characterIds: [], display: d.id } : null;
  }
  if (userId === 'gm') return GM_USER;
  const u = state.users?.[userId];
  if (!u) return null;
  return { id: u.id, role: 'player', name: u.name, characterIds: u.characterIds || [] };
}

/** Table holding this session token (restricted to `hint` when the client names its table). */
function tableForToken(token: unknown, hint: Table | null): Table | null {
  if (!token || typeof token !== 'string') return null;
  if (hint) return userFromToken(hint, token) ? hint : null;
  for (const t of tables.values()) if (usableTable(t) && (t.state.sessions?.[token] || displayByToken(t.state, token))) return t;
  return null;
}

function issueToken(table: Table, userId: UserId): string {
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
/** Connected people (GM and players): table displays are not people, see onlineDisplays(). */
function onlineUsers(table: Table): UserId[] {
  const ids = new Set<UserId>();
  for (const { user } of table.sockets.values()) if (user.role !== 'display') ids.add(user.id);
  return [...ids];
}
/** Display links with at least one screen connected. */
function onlineDisplays(table: Table): string[] {
  const ids = new Set<string>();
  for (const { user } of table.sockets.values()) if (user.role === 'display' && user.display) ids.add(user.display);
  return [...ids];
}

function buildView(table: Table, user: SessionUser): GameView {
  const state = table.state;
  // notes: built per user by the notes module (filter/gmFilter) from the live state, never deep-cloned whole.
  // displays: the links' tokens are secrets, only the GM gets them.
  const { sessions, config, notes, displays, ...rest } = state;
  // The clone has the state's slices; config/me/users/online are set below, notes by the notes module.
  const view = deepClone(rest) as unknown as GameView;
  view.config = { campaignName: config?.campaignName || 'Shadowrun', lang: config?.lang || 'fr', table: table.info() };
  view.me = { id: user.id, role: user.role, name: user.name, characterIds: user.characterIds, lang: userLang(state, user.id) };
  view.users = Object.fromEntries(Object.values(state.users).map((u) => [u.id, { id: u.id, name: u.name, characterIds: u.characterIds }]));
  view.online = onlineUsers(table);
  if (user.role === 'gm') {
    view.displays = deepClone(displays || {});
    view.displaysOnline = onlineDisplays(table);
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
  // Players and table displays (a display is a player without characters): strip private data. Modules then filter
  // their own slices (20-maps gives a display the party's eyes, 96-display adds its settings).
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
function refreshSockets(table: Table): void {
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

function broadcastTable(table: Table): void {
  if (!usableTable(table) || tables.get(table.id) !== table) return;
  tableScope.run(table, () => {
    refreshSockets(table);
    const cache = new Map<UserId, GameView>();
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
function scheduleTableBroadcast(table: Table | null | undefined): void {
  if (!table || table.broadcastTimer) return;
  table.broadcastTimer = setTimeout(() => {
    table.broadcastTimer = null;
    broadcastTable(table);
  }, 30);
}

/** Send a transient event (sound, ping, toast…) to 'all', 'gm', 'players', or a user id / array of user ids — at this table only. */
function emitToTable<E extends keyof ServerEvents>(table: Table | null | undefined, target: EmitTarget, event: E, data: ServerEvents[E]): void {
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
function addLogTo(table: Table, entry: NewLogEntry): LogEntry {
  const state = table.state;
  // id/ts/kind are set here and text is filled from i18n: the stored entry is a full LogEntry.
  const e = normalizeLogEntry({ id: uid('log'), ts: Date.now(), kind: 'system', ...entry }) as LogEntry;
  state.log.push(e);
  if (state.log.length > 600) state.log.splice(0, state.log.length - 600);
  return e;
}

// Table-aware helpers for modules: they act on the table of the running request/action (tableScope),
// or on req's table when a request is passed (getState(req), scheduleBroadcast(req)).
const scopeOf = (req?: unknown): Table | null => ((req as Request | undefined)?.srTable) || currentTable();
function noScope(what: string): void {
  console.error(`[tables] ${what} called outside any table`, new Error().stack?.split('\n').slice(2, 4).join(' | '));
}
const getState = (req?: unknown): TableState | null => scopeOf(req)?.state || null;
const scheduleBroadcast = (req?: unknown): void => {
  const t = scopeOf(req);
  if (t) scheduleTableBroadcast(t);
  else noScope('scheduleBroadcast');
};
const emitTo = <E extends keyof ServerEvents>(target: EmitTarget, event: E, data: ServerEvents[E]): void => {
  const t = currentTable();
  if (t) emitToTable(t, target, event, data);
  else noScope('emitTo');
};
const addLog = (entry: NewLogEntry): LogEntry | null => {
  const t = currentTable();
  if (t) return addLogTo(t, entry);
  noScope('addLog');
  return null;
};
const saveSoon = (): void => {
  const t = currentTable();
  if (t) t.store.saveSoon();
  else noScope('saveSoon');
};

function makeCtx(table: Table, user: SessionUser): ActionContext {
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
      const err = new ActionError(formatSource(msg, p));
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
      if (user.role === 'gm') return 'MJ'; // stored as log author: the client shows it as t('GM')
      const a = state.actors[user.characterIds?.[0]];
      return a ? a.name : user.name;
    },
  };
}

/** i18n fields of a failed action's reply (ActionError thrown by ctx.fail). */
function errorI18n(err: unknown): { errorKey?: string; params?: I18nParams } {
  return err instanceof ActionError && err.i18nKey ? { errorKey: err.i18nKey, ...(err.i18nParams ? { params: err.i18nParams } : {}) } : {};
}

/**
 * Run one action for a user on a table: role check, handler inside the table scope, then save + broadcast.
 * The single path for socket actions and for server-side callers (the GM assistant's « Appliquer »).
 * Returns { ok: true, result } | { ok: false, error, errorKey?, params? } — never throws.
 */
function runAction(t: Table, user: SessionUser, type: string, payload: ActionPayload | null | undefined): ActionResponse {
  const def = actions[type];
  if (!def) return { ok: false, ...errorBody('Unknown action: {type}', { type: String(type).slice(0, 80) }) };
  if (user.role === 'display') return { ok: false, ...errorBody('A table display is read-only') };
  if (def.role === 'gm' && user.role !== 'gm') return { ok: false, ...errorBody('GM-only action') };
  try {
    const result = tableScope.run(t, () => def.handler(makeCtx(t, user), payload || {}));
    t.store.saveSoon();
    scheduleTableBroadcast(t);
    syncMetaFromState(t);
    return { ok: true, result };
  } catch (err) {
    if (!(err instanceof ActionError)) console.error(`[action ${type} @${t.id}]`, err);
    return { ok: false, error: (err as Error).message || String(err), ...errorI18n(err) };
  }
}

/**
 * Run an action handler on a throwaway deep copy of the table state (nothing saved, logged, emitted or broadcast).
 * Used to validate and preview a change exactly as the real action would make it. Returns { ok, result, state }.
 */
function simulateAction(
  t: Table, user: SessionUser, type: string, payload: ActionPayload | null | undefined, state: TableState = deepClone(t.state),
): ActionResponse & { state: TableState } {
  const def = actions[type];
  if (!def) return { ok: false, ...errorBody('Unknown action: {type}', { type: String(type).slice(0, 80) }), state };
  const fake: Table = Object.create(t, { state: { value: state } }); // same table (id, info…), copied state
  const ctx: ActionContext = { ...makeCtx(fake, user), log: (e) => e as LogEntry, emitTo: () => {} };
  try {
    const result = tableScope.run(t, () => def.handler(ctx, payload || {}));
    return { ok: true, result, state };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err), ...errorI18n(err), state };
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.SR_TRUST_PROXY === '1' ? 1 : false);

const bearer = (req: Request): string => {
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
// Demo tables: blocked routes and body caps, checked before any body is read.
app.use(demoHttpGuard);
app.use(express.json({ limit: '20mb' }));

/** The user of an HTTP request. Table displays have no HTTP access: everything they show comes with their view. */
function authUser(req: Request): SessionUser | null {
  const u = req.srTable ? userFromToken(req.srTable, bearer(req)) : null;
  return u && u.role !== 'display' ? u : null;
}
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const u = authUser(req);
  if (!u) return res.status(401).json(errorBody('Not logged in'));
  req.user = u;
  tableScope.run(req.srTable!, next);
}
export function requireGM(req: Request, res: Response, next: NextFunction) {
  const u = authUser(req);
  if (!u || u.role !== 'gm') return res.status(403).json(errorBody('GM only'));
  req.user = u;
  tableScope.run(req.srTable!, next);
}
/** Request that went through requireUser / requireGM: its table and user are set. */
type AuthedRequest = Request & { srTable: Table; user: SessionUser };
const authed = (req: Request) => req as AuthedRequest;

/**
 * Express app given to modules: every handler they register runs inside the request's table scope
 * (body parsers lose AsyncLocalStorage context, so each handler re-enters it).
 */
function scopedApp(target: Express): Express {
  type Handler = (...args: any[]) => unknown; // any Express handler / error handler
  const wrap = (h: unknown): unknown => {
    if (Array.isArray(h)) return h.map(wrap);
    if (typeof h !== 'function') return h;
    const fn = h as Handler;
    if (fn.length === 4) {
      return (err: unknown, req: Request, res: Response, next: NextFunction) =>
        req.srTable ? tableScope.run(req.srTable, () => fn(err, req, res, next)) : fn(err, req, res, next);
    }
    return (req: Request, res: Response, next: NextFunction) => (req.srTable ? tableScope.run(req.srTable, () => fn(req, res, next)) : fn(req, res, next));
  };
  const VERBS = new Set<string | symbol>(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
  return new Proxy(target, {
    get(t, k) {
      const methods = t as unknown as Record<string | symbol, Handler>;
      if (VERBS.has(k)) return (...args: unknown[]) => (k === 'get' && args.length === 1 ? t.get(args[0] as string) : methods[k](...args.map(wrap)));
      const v = Reflect.get(t, k);
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
        const t = tables.get(m.id)!;
        return { slug: m.slug, name: m.name, lang: t.info().lang, online: onlineUsers(t).length, ...(m.demo ? { demo: true } : {}) };
      }),
  });
});

const noTable = (req: Request, res: Response) => {
  const meta = req.srHint ? listMetas().find((m) => m.slug === req.srHint) : null;
  if (meta?.archived) return res.status(410).json(errorBody('This table is archived', null, { code: 'archived' }));
  if (meta && tables.get(meta.id)?.error) return res.status(503).json(errorBody('Table temporarily unavailable (see the server logs)', null, { code: 'broken' }));
  return res.status(404).json(errorBody(req.srHint ? 'Table not found' : 'Choose a table', null, { code: 'no-table' }));
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
  const { role, password, name, characterId } = body;
  const demo = isDemo(t);
  // Demo table: no PINs (a name cannot be locked), PCs can be shared, logins throttled per IP.
  const pin = demo ? '' : body.pin;
  if (demo && demoLoginBlocked(t, req.ip)) return res.status(429).json(errorBody('Too many attempts: try again in a few minutes'));
  if (role === 'gm' && demo) {
    if (isLang(body.lang)) setUserLang(state, 'gm', body.lang);
    return res.json({ token: issueToken(t, 'gm'), user: { ...GM_USER, lang: userLang(state, 'gm') }, table: t.info() });
  }
  if (role === 'gm') {
    const key = `gm|${t.id}|${req.ip}`;
    if (loginLimiter.blocked(key)) return res.status(429).json(errorBody('Too many attempts: try again in a few minutes'));
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(String(state.config.gmPassword));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      loginLimiter.fail(key);
      return res.status(403).json(errorBody('Wrong GM password'));
    }
    loginLimiter.reset(key);
    if (isLang(body.lang)) setUserLang(state, 'gm', body.lang); // language picked on the login screen
    return res.json({ token: issueToken(t, 'gm'), user: { ...GM_USER, lang: userLang(state, 'gm') }, table: t.info() });
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) return res.status(400).json(errorBody('Enter your name'));
  let user: User | undefined = Object.values(state.users).find((u) => u.name.toLowerCase() === cleanName.toLowerCase());
  if (user) {
    if (user.pin && !demo) {
      const key = `pin|${t.id}|${user.id}|${req.ip}`;
      if (loginLimiter.blocked(key)) return res.status(429).json(errorBody('Too many attempts: try again in a few minutes'));
      if (user.pin !== hashPin(pin)) {
        loginLimiter.fail(key);
        return res.status(403).json(errorBody('Wrong PIN for this player'));
      }
    }
  } else {
    if (demo && Object.keys(state.users).length >= DEMO.maxUsers) return res.status(429).json(errorBody('The demo table is full: try again later'));
    user = { id: uid('usr'), name: cleanName, pin: pin ? hashPin(pin) : null, characterIds: [] };
    state.users[user.id] = user;
  }
  const player: User = user;
  if (characterId) {
    const actor = state.actors[characterId];
    if (!actor || actor.type !== 'pc') return res.status(400).json(errorBody('Character not found'));
    const owner = Object.values(state.users).find((u) => u.id !== player.id && (u.characterIds || []).includes(characterId));
    if (owner && !demo) return res.status(403).json(errorBody('This character is already taken by {name}', { name: owner.name }));
    if (!player.characterIds.includes(characterId)) player.characterIds.push(characterId);
    syncSpiritControl(state); // the summoner's spirits come with it (47-magic)
  }
  if (isLang(body.lang)) player.lang = body.lang; // language picked on the login screen
  t.store.saveSoon();
  scheduleTableBroadcast(t);
  res.json({ token: issueToken(t, player.id), user: { id: player.id, role: 'player', name: player.name, characterIds: player.characterIds, lang: userLang(state, player.id) }, table: t.info() });
});

app.get('/api/me', requireUser, (req, res) => {
  const r = authed(req);
  res.json({ ...r.user, lang: userLang(r.srTable.state, r.user.id), table: r.srTable.info() });
});

// Generic uploads (images, audio). Body = raw file bytes, header X-Filename. Stored in the table's uploads folder.
app.post('/api/upload', requireUser, express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
  const t = authed(req).srTable;
  const original = String(req.headers['x-filename'] || 'fichier').replace(/[^\w.\-]+/g, '_').slice(-80);
  const ext = path.extname(original).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp3', '.ogg', '.wav', '.m4a', '.webm', '.pdf', '.md', '.json', '.chum5', '.xml'];
  if (!allowed.includes(ext)) return res.status(400).json(errorBody('Unsupported file type ({ext})', { ext }));
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json(errorBody('Empty file'));
  if (isDemo(t)) {
    const bad = demoUploadError(t, ext, req.body.length);
    if (bad) return res.status(bad.params ? 413 : 400).json(errorBody(bad.key, bad.params, { code: 'demo' }));
  }
  const file = `${Date.now().toString(36)}-${original}`;
  try {
    fs.mkdirSync(t.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(t.uploadDir, file), req.body);
  } catch (err) {
    console.error('[upload]', err);
    const e = err as NodeJS.ErrnoException;
    return res.status(500).json(errorBody('Could not write on the server ({reason})', { reason: e.code || e.message }));
  }
  res.json({ url: `${t.uploadUrl}/${file}`, name: original });
});

// Campaign documents (markdown files of the table's docs folder), GM only.
// Lists *.md at the top level and one folder deep (e.g. "foundry/Open Book.md").
function listDocs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(entry.name);
    else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const f of fs.readdirSync(path.join(dir, entry.name))) if (f.endsWith('.md')) out.push(`${entry.name}/${f}`);
    }
  }
  return out.sort((a, b) => (Number(a.includes('/')) - Number(b.includes('/'))) || a.localeCompare(b));
}
function docPath(dir: string, name: unknown): string | null {
  const clean = String(name || '').split(String.fromCharCode(92)).join('/');
  if (!clean.endsWith('.md') || clean.split('/').some((p) => !p || p === '..' || p === '.') || clean.split('/').length > 2) return null;
  const file = path.resolve(dir, clean);
  return file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file) ? file : null;
}
app.get('/api/docs', requireGM, (req, res) => {
  const dir = authed(req).srTable.docsDir();
  res.json(listDocs(dir).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, folder: name.includes('/') ? name.split('/')[0] : '', size: st.size, mtime: st.mtimeMs };
  }));
});
// Name may contain one folder level: /api/docs/foundry%2FOpen%20Book.md or /api/docs/foundry/Open%20Book.md
app.get(['/api/docs/:name', '/api/docs/:folder/:name'], requireGM, (req, res) => {
  const params = req.params as { name: string; folder?: string };
  const name = params.folder ? `${params.folder}/${params.name}` : params.name;
  const file = docPath(authed(req).srTable.docsDir(), name);
  if (!file) return res.status(404).json(errorBody('Document not found'));
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

// Save / backup / reset of the GM's own table.
app.post('/api/admin/backup', requireGM, (req, res) => {
  const file = authed(req).srTable.store.backup('manual');
  if (!file) return res.status(500).json(errorBody('Backup failed (see the server console)'));
  res.json({ file });
});
app.get('/api/admin/export', requireGM, (req, res) => {
  const t = authed(req).srTable;
  res.setHeader('Content-Disposition', `attachment; filename="shadowrun-${t.slug}.json"`);
  // Players' private notes stay private: unshared ones are left out of the GM's download (server backups keep them).
  const st = t.state;
  const pages = st.notes?.pages || {};
  const hidden = new Set(Object.values(pages).filter((p) => p && p.scope === 'private' && p.ownerId !== 'gm' && !p.shareWithGM).map((p) => p.id));
  if (!hidden.size) return res.json(st);
  const notes = { ...st.notes, pages: Object.fromEntries(Object.entries(pages).filter(([id]) => !hidden.has(id))) };
  if (st.notes.comments) notes.comments = Object.fromEntries(Object.entries(st.notes.comments).filter(([id]) => !hidden.has(id)));
  res.json({ ...st, notes });
});
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Replace a table's whole state (import, restore): keeps the live GM password/settings when missing and everyone logged in. */
function importInto(t: Table, next: Record<string, any>, { keepSessions = true }: { keepSessions?: boolean } = {}): void {
  // `next` is an uploaded state file (foreign JSON): completed here, then by the modules' init().
  const cur = t.state;
  const base: Record<string, unknown> = emptyState();
  for (const k of Object.keys(base)) if (next[k] === undefined) next[k] = base[k];
  if (!Array.isArray(next.log)) next.log = [];
  if (!isObj(next.users)) next.users = {};
  next.config = { ...cur.config, ...(isObj(next.config) ? next.config : {}) };
  if (keepSessions) {
    next.users = { ...cur.users, ...next.users };
    next.sessions = { ...(isObj(next.sessions) ? next.sessions : {}), ...(cur.sessions || {}) };
    next.displays = { ...(isObj(next.displays) ? next.displays : {}), ...(cur.displays || {}) };
  }
  for (const u of Object.values(next.users)) {
    if (!isObj(u)) continue;
    u.characterIds = (Array.isArray(u.characterIds) ? u.characterIds : []).filter((id: string) => next.actors[id]);
  }
  t.store.backup('before-import');
  t.store.replace(next as TableState);
  initModules(t);
  t.store.saveNow();
  syncMetaFromState(t);
  scheduleTableBroadcast(t);
}
app.post('/api/admin/import', requireGM, (req, res) => {
  const next = req.body;
  if (!isObj(next) || !isObj(next.actors)) return res.status(400).json(errorBody('Invalid save file'));
  importInto(authed(req).srTable, next);
  res.json({ ok: true });
});
app.post('/api/admin/reset', requireGM, (req, res) => {
  const t = authed(req).srTable;
  // Demo table: « reset » brings back the demo content (and logs everyone out, this GM included).
  if (isDemo(t)) {
    resetDemoTable(t, { initModules, scheduleTableBroadcast }, { reason: 'gm' });
    return res.json({ ok: true, demo: true });
  }
  if (!t.store.backup('before-reset')) return res.status(500).json(errorBody('Could not back up first: reset cancelled'));
  const fresh: Partial<TableState> = emptyState();
  fresh.config = t.state.config;
  fresh.sessions = t.state.sessions;
  fresh.users = t.state.users;
  if (t.state.displays) fresh.displays = t.state.displays; // the screens around the table stay connected
  t.store.replace(fresh as TableState); // completed by the modules' init() just below
  initModules(t);
  t.store.saveNow();
  scheduleTableBroadcast(t);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const nm = path.join(ROOT, 'node_modules');
app.use('/shared', express.static(path.join(ROOT, 'shared')));
// Translation dictionaries: client/i18n/<lang>/*.json are served by the client static handler below; the
// index listing them is generated from the folder so adding a file needs no code change.
app.get('/i18n/:lang/index.json', (req, res) => {
  if (!isLang(req.params.lang)) return res.status(404).json(errorBody('Not found'));
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
type StaticOptions = NonNullable<Parameters<typeof express.static>[1]>;
const uploadHeaders: StaticOptions = {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pdf') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    if (!INERT_UPLOAD.has(ext)) res.setHeader('Content-Disposition', 'attachment');
  },
};
const assetHeaders: StaticOptions = { setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); } };
const staticCache = new Map<string, RequestHandler>(); // dir -> express.static handler
const staticFor = (dir: string, opts: StaticOptions): RequestHandler => {
  if (!staticCache.has(dir)) staticCache.set(dir, express.static(dir, { ...opts, index: false, dotfiles: 'deny' }));
  return staticCache.get(dir)!;
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

// Client delivery, two modes (AGENTS.md « Commands »):
//  - `npm run dev` (--vite): Vite runs as middleware on this server (hot reload, sources transformed on the fly);
//  - dist/client/index.html exists (`npm run build`): the production bundle.
// Without either, the page routes answer 503 (the page is client/app.tsx: browsers cannot run it unbuilt).
// client/ is served as a fallback in every mode: module stylesheets (loadCss) and the i18n dictionaries live there.
const CLIENT_DIR = path.join(ROOT, 'client');
const DIST_DIR = path.join(ROOT, 'dist', 'client');
const VITE_DEV = process.argv.includes('--vite');
const BUILT = !VITE_DEV && fs.existsSync(path.join(DIST_DIR, 'index.html'));
let vite: ViteDevServer | null = null; // Vite dev server (middleware mode), created once the HTTP server exists (HMR shares its port)

// Content-Security-Policy for the app page: no inline scripts/handlers and no javascript: URLs (defence in depth
// against HTML injection). An inline import map, if the page has one, is allowed by its hash (computed from the file).
const INDEX_FILE = path.join(BUILT ? DIST_DIR : CLIENT_DIR, 'index.html');
function pageCsp(): string {
  let hash = '';
  try {
    const html = fs.readFileSync(INDEX_FILE, 'utf8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (m) hash = ` 'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`;
  } catch {}
  return [
    "default-src 'self'",
    // Dev only (npm run dev): Vite injects an inline React Refresh preamble and runs workers from blob: URLs.
    VITE_DEV ? "script-src 'self' 'unsafe-inline' blob:" : `script-src 'self'${hash}`,
    ...(VITE_DEV ? ["worker-src 'self' blob:"] : []),
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
function sendPage(req: Request, res: Response, next: NextFunction) {
  if (!vite && !BUILT) return res.status(503).type('text/plain; charset=utf-8').send('Client not built: run npm run build');
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('Cache-Control', 'no-cache');
  if (!vite) return res.sendFile(INDEX_FILE);
  vite.transformIndexHtml(req.originalUrl, fs.readFileSync(INDEX_FILE, 'utf8'))
    .then((html) => res.type('html').send(html))
    .catch(next);
}
if (!VITE_DEV && !BUILT) console.log('[client] dist/client/ not found: run "npm run build" (or "npm run dev") to serve the app page.');
// The same page serves the table picker (/), the admin page (/admin) and every table (/t/<slug>/).
app.get('/', (req, res, next) => {
  const listed = listMetas().filter((m) => !m.archived && !m.hidden && usableTable(tables.get(m.id)));
  // Old bookmarks: with a single table, / goes straight to it (/?choisir shows the picker anyway).
  if (listed.length === 1 && req.query.choisir === undefined) return res.redirect(302, `/t/${listed[0].slug}/`);
  sendPage(req, res, next);
});
app.get(['/admin', '/admin/'], sendPage);
// (non-strict routing: '/t/:slug' also matches '/t/x/')
app.get('/t/:slug', (req, res, next) => (req.path.endsWith('/') ? sendPage(req, res, next) : res.redirect(301, `/t/${encodeURIComponent(req.params.slug)}/`)));
app.use((req, res, next) => (vite ? vite.middlewares(req, res, next) : next()));
if (BUILT) {
  app.use(express.static(DIST_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.toLowerCase().endsWith('.html')) res.setHeader('Content-Security-Policy', PAGE_CSP);
      else if (filePath.includes(`${path.sep}build${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // hashed names
    },
  }));
}
app.use(express.static(CLIENT_DIR, {
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
if (VITE_DEV) {
  const { createServer } = await import('vite'); // dev dependency: only loaded by `npm run dev`
  vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.js'),
    appType: 'custom',
    server: { middlewareMode: true, hmr: { server } },
  });
}

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
  const t: Table = socket.data.table;
  const entry: SocketEntry = { socket, user: socket.data.user };
  t.sockets.set(socket.id, entry);
  socket.join(`table:${t.id}`);
  tableScope.run(t, () => socket.emit('state', buildView(t, entry.user)));
  scheduleTableBroadcast(t);
  demoPresence(t);

  // msg: raw client data ({ type, payload }), validated by the action handlers
  socket.on('action', (msg: any, ack: unknown) => {
    const reply = typeof ack === 'function' ? (ack as (r: unknown) => void) : () => {};
    const { type, payload } = msg || {};
    // Refresh the user (character ownership may have changed since connecting).
    const live = usableTable(tables.get(t.id)) === t ? t : null;
    const user = live ? userFromToken(t, socket.handshake.auth?.token) : null;
    if (!user) {
      reply({ ok: false, ...errorBody('Session expired'), code: 'unauthorized' });
      t.sockets.delete(socket.id);
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }
    entry.user = user;
    if (user.role === 'display') return reply({ ok: false, ...errorBody('A table display is read-only'), code: 'read-only' });
    if (isDemo(t)) {
      const bad = demoActionError(entry, type, payload);
      if (bad) return reply({ ok: false, ...bad });
    }
    reply(runAction(t, user, type, payload));
  });

  socket.on('disconnect', () => {
    t.sockets.delete(socket.id);
    demoPresence(t);
    scheduleTableBroadcast(t);
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
await loadModules();
bootRegistry();
ensureDemoTable();
setupAdminPassword();
for (const meta of listMetas()) if (!meta.archived) openTable(meta);
startDemoScheduler({ tables, initModules, scheduleTableBroadcast, onlineUsers });

const tableApi: TableApi = {
  tables, openTable, closeTable, initModules, importInto, scheduleTableBroadcast, onlineUsers, issueToken, getMeta, usableTable, tableBySlug,
};
registerAdminRoutes(app, tableApi);

const scoped = scopedApp(app);
const routeHelpers: CoreRouteHelpers = { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon, tableApi, runAction, simulateAction, actions };
for (const m of modules) {
  if (typeof m.routes !== 'function') continue;
  try {
    m.routes(scoped, routeHelpers);
  } catch (err) {
    console.error(`[modules] routes failed for ${m.name}:`, err);
  }
}

// Last resort: JSON 404 (API) — and a JSON error instead of an HTML stack trace.
app.use((req, res) => res.status(404).json(errorBody('Not found')));
// eslint-disable-next-line no-unused-vars
app.use((err: any, req: Request, res: Response, next: NextFunction) => { // err: whatever a handler threw (body-parser errors carry type/status/expose)
  if (err?.type === 'entity.too.large') return res.status(413).json(errorBody('File too large'));
  if (err?.type === 'entity.parse.failed') return res.status(400).json(errorBody('Invalid request (JSON)'));
  console.error('[http]', req.method, req.path, err);
  if (!res.headersSent) res.status(err?.status || 500).json(err?.expose ? { error: err.message } : errorBody('Server error'));
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
function shutdown(code = 0): void {
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
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
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
    .map((i) => i!.address);
  console.log(`\n  Shadowrun — ${tables.size} table(s): ${[...tables.values()].map((t) => `${t.name} (/t/${t.slug}/)`).join(', ') || 'none'}`);
  console.log(`  Home     : http://localhost:${PORT}/        Admin: http://localhost:${PORT}/admin`);
  for (const ip of ips) console.log(`  Players  : http://${ip}:${PORT}/`);
  console.log('');
});

export { io, emitTo, addLog, scheduleBroadcast };
