// Public demo tables (TableMeta.demo, created by SR_DEMO_TABLE — see ARCHITECTURE.md « Demo table »).
// Anyone may enter as GM or player without a password, so everything that costs money, fills the disk or reaches
// outside the table is refused or capped here, and the table is rebuilt from its pack (data/packs/demo) on a schedule:
//   · at boot (a deploy brings the new pack content),
//   · when nobody has been connected for SR_DEMO_IDLE_MINUTES (default 30) after a change,
//   · every night at SR_DEMO_RESET_HOUR (server local time, default 4) — connected users are sent back to the login,
//   · at once when its state.json grows past SR_DEMO_MAX_STATE_MB (default 12).
// Limits: no GM assistant, no rulebooks, no Foundry, no state import/backup, no map-library browsing or publishing
// (library images: only those of the table's own maps); uploads =
// small images only (count and total capped); request bodies, socket action payloads, chat lines, action rate,
// logins and player accounts are capped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { emptyState } from '../store.ts';
import { errorBody } from './i18n.ts';
import type { ErrorBody } from './i18n.ts';
import { createRateLimiter } from './admin.ts';
import type { I18nParams } from '../../shared/types.ts';
import type { SocketEntry, Table, TableApi } from './tables.ts';

/** Why a demo table is reset now. */
export type ResetReason = 'idle' | 'nightly' | 'size';
/** What resetDemoTable needs of the server core. */
export type DemoResetApi = Pick<TableApi, 'initModules' | 'scheduleTableBroadcast'>;
/** What the scheduler needs of the server core. */
export type DemoSchedulerApi = Pick<TableApi, 'tables' | 'initModules' | 'scheduleTableBroadcast' | 'onlineUsers'>;

const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Limits (read once at boot; tests override them with the same environment variables). */
export const DEMO = {
  idleMs: num(process.env.SR_DEMO_IDLE_MINUTES, 30, 0.05, 24 * 60) * 60 * 1000,
  resetHour: process.env.SR_DEMO_RESET_HOUR === 'none' ? null : Math.round(num(process.env.SR_DEMO_RESET_HOUR, 4, 0, 23)),
  checkMs: num(process.env.SR_DEMO_CHECK_SECONDS, 60, 1, 3600) * 1000,
  maxStateBytes: num(process.env.SR_DEMO_MAX_STATE_MB, 12, 1, 200) * 1024 * 1024,
  uploadMaxBytes: num(process.env.SR_DEMO_UPLOAD_KB, 1024, 16, 20 * 1024) * 1024,
  uploadQuotaBytes: num(process.env.SR_DEMO_UPLOAD_QUOTA_MB, 20, 1, 500) * 1024 * 1024,
  uploadMaxFiles: 200,
  bodyMaxBytes: 2 * 1024 * 1024, // any other HTTP body (Chummer files are well under this)
  actionMaxBytes: 128 * 1024, // one socket action's payload, serialized
  chatMax: 500,
  maxUsers: Math.round(num(process.env.SR_DEMO_MAX_USERS, 40, 1, 1000)),
  actionRate: { max: 120, windowMs: 10 * 1000 }, // per socket
  loginRate: { max: Math.round(num(process.env.SR_DEMO_LOGIN_MAX, 30, 1, 10000)), windowMs: 10 * 60 * 1000 }, // per IP and table
};

export const DEMO_UPLOAD_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const isDemo = (t: Table | null | undefined): boolean => !!t?.meta?.demo;

/** Marker for the i18n checker (keys translated client-side from errorKey). */
const tk = (s: string): string => s;
const refuse = (res: Response, status: number, key: string, params?: I18nParams) => res.status(status).json(errorBody(key, params, { code: 'demo' }));

// HTTP routes a demo table never serves (prefix match). The assistant's status stays readable (the dock shows « off »).
const BLOCKED = [
  /^\/api\/assistant\/(?!status$)/,
  /^\/api\/books\/./, // search, pages, links, PDFs (the list itself answers an empty library: 90-books.js)
  /^\/api\/foundry(?:\/|$)/,
  /^\/api\/admin\/(?:import|backup)$/,
  /^\/api\/maplib(?:\/(?!key$|image\/|thumb\/)[^/]*)?$/, // library browsing (images: only the table's own maps, see 22-maplib)
];

/**
 * Express middleware, mounted after the table resolution and BEFORE the body parsers: on a demo table, refuses the
 * blocked routes and any body over its cap (bodies without a Content-Length are refused: their size is unknown).
 */
export function demoHttpGuard(req: Request, res: Response, next: NextFunction) {
  const t = req.srTable;
  if (!isDemo(t)) return next();
  if (BLOCKED.some((re) => re.test(req.path))) return refuse(res, 403, tk('Désactivé sur la table de démonstration'));
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const max = req.path === '/api/upload' ? DEMO.uploadMaxBytes : DEMO.bodyMaxBytes;
    const len = req.headers['content-length'];
    if (len === undefined && req.headers['transfer-encoding']) return refuse(res, 411, tk('Taille de l’envoi inconnue'));
    if (Number(len) > max) return refuse(res, 413, tk('Fichier trop volumineux pour la démo ({max} Ko max)'), { max: Math.round(max / 1024) });
  }
  next();
}

/** Files and bytes in a table's uploads folder. */
function uploadsUsage(t: Table): { total: number; count: number } {
  let total = 0;
  let count = 0;
  try {
    for (const f of fs.readdirSync(t.uploadDir)) {
      total += fs.statSync(path.join(t.uploadDir, f)).size;
      count++;
    }
  } catch {}
  return { total, count };
}

/** Extra checks of an upload to a demo table: images only, file count and total size capped. Error key or null. */
export function demoUploadError(t: Table, ext: string, bytes: number): { key: string; params?: I18nParams } | null {
  if (!DEMO_UPLOAD_EXTS.includes(ext)) return { key: tk('Sur la démo, seules les images (PNG, JPEG, WebP, GIF) sont acceptées') };
  if (bytes > DEMO.uploadMaxBytes) return { key: tk('Fichier trop volumineux pour la démo ({max} Ko max)'), params: { max: Math.round(DEMO.uploadMaxBytes / 1024) } };
  const { total, count } = uploadsUsage(t);
  if (count >= DEMO.uploadMaxFiles || total + bytes > DEMO.uploadQuotaBytes) return { key: tk('Espace d’envoi de la démo plein : il sera vidé à la prochaine remise à zéro') };
  return null;
}

// Socket actions refused on a demo table: anything that reads the server's files or writes outside the table.
const DENIED_ACTIONS = [/^foundry\//, /^maps\/(?:publishToLibrary|fromLibrary)$/];
const actionLimiters = new WeakMap<SocketEntry, { n: number; first: number }>(); // socket entry -> { n, first }

/**
 * Checks of one socket action on a demo table (before it runs). Returns an error body or null.
 * `entry` is the socket's table entry (per-socket rate limit).
 */
export function demoActionError(entry: SocketEntry, type: unknown, payload: any): ErrorBody | null { // payload: raw socket data
  const ty = String(type || '');
  if (DENIED_ACTIONS.some((re) => re.test(ty))) return errorBody('Désactivé sur la table de démonstration', null, { code: 'demo' });
  const now = Date.now();
  let h = actionLimiters.get(entry);
  if (!h || now - h.first > DEMO.actionRate.windowMs) actionLimiters.set(entry, (h = { n: 0, first: now }));
  if (++h.n > DEMO.actionRate.max) return errorBody('Trop d’actions d’un coup : ralentis un peu', null, { code: 'demo' });
  let size = 0;
  try {
    size = JSON.stringify(payload ?? null).length;
  } catch {
    return errorBody('Requête invalide (JSON)', null, { code: 'demo' });
  }
  if (size > DEMO.actionMaxBytes) return errorBody('Action trop volumineuse pour la démo', null, { code: 'demo' });
  if (ty === 'chat/send' && String(payload?.text ?? '').trim().length > DEMO.chatMax) return errorBody('Message trop long pour la démo ({max} caractères max)', { max: DEMO.chatMax }, { code: 'demo' });
  return null;
}

const loginLimiter = createRateLimiter(DEMO.loginRate);
/** Login throttle of a demo table (every login counts, not only failures). True when this IP must wait. */
export function demoLoginBlocked(t: Table, ip: string | undefined): boolean {
  const key = `demo|${t.id}|${ip}`;
  if (loginLimiter.blocked(key)) return true;
  loginLimiter.fail(key);
  return false;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
interface DemoInfo {
  lastReset: number;
  lastActivity: number;
  dirty: boolean;
  resetting?: boolean;
}
const info = new WeakMap<Table, DemoInfo>(); // Table -> { lastReset, lastActivity, dirty }
const track = (t: Table): DemoInfo => {
  let s = info.get(t);
  if (!s) info.set(t, (s = { lastReset: 0, lastActivity: Date.now(), dirty: true }));
  return s;
};
/** Reset bookkeeping of a demo table (tests, admin listing). */
export const demoStatus = (t: Table): DemoInfo => ({ ...track(t) });

/** Mark a demo table as changed (every save goes through here, see instrumentDemo). */
export function touchDemo(t: Table): void {
  const s = track(t);
  s.dirty = true;
  s.lastActivity = Date.now();
}

/** Every save of a demo table marks it changed, so the idle reset knows there is something to wipe. */
export function instrumentDemo(t: Table): void {
  if (!isDemo(t) || t.store.__demo) return;
  t.store.__demo = true;
  const { saveSoon, saveNow } = t.store;
  t.store.saveSoon = () => {
    if (!track(t).resetting) touchDemo(t);
    return saveSoon();
  };
  t.store.saveNow = () => {
    if (!track(t).resetting) touchDemo(t);
    return saveNow();
  };
}

/**
 * Rebuild a demo table from its pack: everyone connected is sent back to the login screen, the state is replaced by
 * a fresh one seeded from the pack, and the table's files (uploads, imported assets, docs, assistant chats) are removed.
 * api = { initModules, scheduleTableBroadcast }.
 */
export function resetDemoTable(t: Table, api: DemoResetApi, { reason = 'manual' }: { reason?: string } = {}): boolean {
  if (!isDemo(t) || t.error) return false;
  const s = track(t);
  s.resetting = true;
  try {
    if (t.broadcastTimer) clearTimeout(t.broadcastTimer);
    t.broadcastTimer = null;
    for (const { socket } of t.sockets.values()) {
      try {
        socket.emit('unauthorized', { reason: 'demo-reset' });
        socket.disconnect(true);
      } catch {}
    }
    t.sockets.clear();
    for (const sub of ['uploads', 'assets', 'foundry', 'docs', 'backups']) {
      try {
        fs.rmSync(path.join(t.dir, sub), { recursive: true, force: true });
      } catch (err) {
        console.error(`[demo] ${t.id}: ${sub} non vidé`, (err as Error).message);
      }
    }
    try {
      fs.rmSync(path.join(t.dir, 'assistant.json'), { force: true });
    } catch {}
    fs.mkdirSync(t.uploadDir, { recursive: true });
    const fresh = emptyState();
    // The GM password is never asked on a demo table; a random one keeps the field meaningful if the flag is removed.
    fresh.config = { gmPassword: crypto.randomBytes(12).toString('hex'), campaignName: t.meta.name, lang: t.meta.lang || 'fr' };
    t.store.replace(fresh);
    api.initModules(t);
    t.store.saveNow();
  } finally {
    s.resetting = false;
  }
  s.lastReset = Date.now();
  s.lastActivity = s.lastReset;
  s.dirty = false;
  console.log(`[demo] table « ${t.id} » remise à zéro (${reason})`);
  return true;
}

/** Most recent past occurrence of the nightly reset hour (ms), or 0 when there is none. */
export function lastNightlyBoundary(now: number = Date.now(), hour: number | null | undefined = DEMO.resetHour): number {
  if (hour === null || hour === undefined) return 0;
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** Why a demo table should be reset now ('idle' | 'nightly' | 'size'), or null. Size = state.json too big, or the
 *  uploads folder (also fed by Chummer portraits, which skip /api/upload) at twice its quota. */
export function resetReason(t: Table, { online = 0, now = Date.now() }: { online?: number; now?: number } = {}): ResetReason | null {
  const s = track(t);
  try {
    if (fs.statSync(t.store.stateFile).size > DEMO.maxStateBytes) return 'size';
  } catch {}
  if (t.uploadDir && uploadsUsage(t).total > 2 * DEMO.uploadQuotaBytes) return 'size';
  if (!s.dirty) return null;
  if (online === 0 && now - s.lastActivity >= DEMO.idleMs) return 'idle';
  if (s.lastReset < lastNightlyBoundary(now)) return 'nightly';
  return null;
}

/** Reset every demo table now (boot), then check them every DEMO.checkMs. api = { tables, initModules, scheduleTableBroadcast, onlineUsers }. */
export function startDemoScheduler(api: DemoSchedulerApi): NodeJS.Timeout {
  const demos = () => [...api.tables.values()].filter((t) => isDemo(t) && !t.error && !t.meta.archived);
  for (const t of demos()) {
    instrumentDemo(t);
    resetDemoTable(t, api, { reason: 'boot' });
  }
  const timer = setInterval(() => {
    for (const t of demos()) {
      instrumentDemo(t);
      const why = resetReason(t, { online: api.onlineUsers(t).length });
      if (why) {
        try {
          resetDemoTable(t, api, { reason: why });
        } catch (err) {
          console.error(`[demo] remise à zéro de « ${t.id} » impossible`, err);
        }
      }
    }
  }, DEMO.checkMs);
  timer.unref();
  return timer;
}

/** A user left or arrived: the idle countdown starts from the last moment someone was there. */
export function demoPresence(t: Table): void {
  if (isDemo(t)) track(t).lastActivity = Date.now();
}
