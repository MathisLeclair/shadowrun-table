// Multi-table hosting: the registry of tables (independent campaigns) and their on-disk layout.
//   <runtime>/server.json                 { version, tables: [TableMeta], adminPasswordHash, adminPasswordEnv }
//   <runtime>/tables/<id>/state.json      the table's game state (+ backups/, uploads/, docs/, assets/, foundry/)
//   <runtime>/tables/<id>/table.json      copy of its TableMeta (lets a copied/restored folder be adopted)
// TableMeta = { id, slug (= id, immutable), name, createdAt, archived, hidden, pack, lang, legacy?, docsDir?, demo? }
// `demo: true`: public demo table (server/lib/demo.js) — passwordless logins, abuse limits, wiped back to its pack.
// `legacy: true` (one table at most, the migrated « Project Lazarus »): keeps the historical URLs /uploads/… and
// /assets/foundry/… and the ../Shadowrun docs folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ROOT, SEED_DIR, PACKS_DIR, RUNTIME_DIR, TABLES_DIR, SERVER_FILE, GLOBAL_ASSETS_DIR,
  LEGACY_STATE_FILE, LEGACY_UPLOAD_DIR, LEGACY_BACKUP_DIR, readJson, writeJsonAtomic, createStateStore, emptyState,
} from '../store.ts';
import type { StateStore } from '../store.ts';
import type { Lang, PackId, SessionUser, TableInfo, TableMeta, TableState } from '../../shared/types.ts';
import type { Socket } from 'socket.io';

/** A registry entry as stored. */
export type StoredMeta = TableMeta;
/** One connected socket of a table. */
export interface SocketEntry {
  socket: Socket;
  user: SessionUser;
}
/** server.json */
export interface Registry {
  version: number;
  tables: StoredMeta[];
  adminPasswordHash: string | null;
  adminPasswordEnv: string | null;
}
interface PackDef {
  label: string;
  dir: string;
  base?: PackId;
}

export const PACKS: Record<PackId, PackDef> = {
  'project-lazarus': { label: 'Project Lazarus (full campaign)', dir: SEED_DIR },
  vierge: { label: 'Blank campaign (generic bestiary)', dir: path.join(PACKS_DIR, 'vierge') },
  // Public demo table content (tools/build-demo.ts): the vierge pack plus pre-made PCs, maps, a Matrix host.
  demo: { label: 'Demo (blank + pregens, maps, host)', dir: path.join(PACKS_DIR, 'demo'), base: 'vierge' },
};
/** Seed folders of a pack, base pack first (module inits only add what is missing, so layering is safe). */
export function packDirs(pack: string): string[] {
  const p = PACKS[pack as PackId] || PACKS['project-lazarus'];
  return p.base && PACKS[p.base] ? [...packDirs(p.base), p.dir] : [p.dir];
}
export const LANGS: Lang[] = ['fr', 'en'];
const isLangValue = (v: unknown): v is Lang => LANGS.includes(v as Lang);
const isPack = (v: unknown): v is PackId => typeof v === 'string' && Object.hasOwn(PACKS, v);
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'api', 't', 'uploads', 'assets', 'vendor', 'shared', 'catalog', 'modules', 'lib', 'socket-io', 'tables', 'health', 'deleted', 'tmp']);

/** URL-safe slug from a display name ('Les Ombres de Paris' → 'les-ombres-de-paris'). */
export function slugify(name: unknown): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Error message (i18n key) for an invalid slug, or null. */
export function slugError(slug: unknown): string | null {
  if (!SLUG_RE.test(String(slug || ''))) return 'Invalid identifier: lowercase letters, digits and dashes (2 to 40 characters)';
  if (String(slug).length < 2) return 'Identifier too short (2 characters minimum)';
  if (RESERVED.has(String(slug))) return 'This identifier is reserved';
  return null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
export class Table {
  meta: StoredMeta;
  dir: string;
  store: StateStore;
  sockets: Map<string, SocketEntry>;
  broadcastTimer: NodeJS.Timeout | null;
  error: string | null;
  constructor(meta: StoredMeta) {
    this.meta = meta;
    this.dir = path.join(TABLES_DIR, meta.id);
    fs.mkdirSync(path.join(this.dir, 'uploads'), { recursive: true });
    this.store = createStateStore(this.dir, { label: meta.id });
    this.sockets = new Map(); // socket.id -> { socket, user }
    this.broadcastTimer = null;
    this.error = null; // set when the state could not be loaded
    // A demo table is rebuilt from its pack on every reset: no backups (they would only fill the disk).
    if (meta.demo) this.store.backup = () => null;
  }
  get id(): string {
    return this.meta.id;
  }
  get slug(): string {
    return this.meta.slug;
  }
  get name(): string {
    return this.meta.name;
  }
  get legacy(): boolean {
    return !!this.meta.legacy;
  }
  /** The table's state. Null only before load and on a broken table (`error` set): callers skip those (usableTable). */
  get state(): TableState {
    return this.store.get() as TableState;
  }
  get uploadDir(): string {
    return path.join(this.dir, 'uploads');
  }
  /** Public URL prefix of uploads (historical /uploads for the legacy table). */
  get uploadUrl(): string {
    return this.legacy ? '/uploads' : `/t/${this.slug}/uploads`;
  }
  /** Where Foundry imports copy assets, and their public URL prefix. */
  get assetsDir(): string {
    if (this.legacy) return process.env.SR_FOUNDRY_ASSET_DIR ? path.resolve(process.env.SR_FOUNDRY_ASSET_DIR) : path.join(GLOBAL_ASSETS_DIR, 'foundry');
    return path.join(this.dir, 'assets', 'foundry');
  }
  get assetsUrl(): string {
    return this.legacy ? '/assets/foundry' : `/t/${this.slug}/assets/foundry`;
  }
  /** Uploaded Foundry worlds (extracted zips): <dir>/foundry/Data/worlds/<world>. */
  get foundryDir(): string {
    return path.join(this.dir, 'foundry');
  }
  /** Campaign markdown docs: the configured folder when it exists (../Shadowrun for the legacy table), else <dir>/docs. */
  docsDir(): string {
    if (this.meta.docsDir) {
      const d = path.resolve(ROOT, this.meta.docsDir);
      try {
        if (fs.statSync(d).isDirectory()) return d;
      } catch {}
    }
    const own = path.join(this.dir, 'docs');
    fs.mkdirSync(own, { recursive: true });
    return own;
  }
  get packDir(): string {
    return (PACKS[this.meta.pack] || PACKS['project-lazarus']).dir;
  }
  /** Seed folders, base pack first (see packDirs). */
  get packDirs(): string[] {
    return packDirs(this.meta.pack);
  }
  get demo(): boolean {
    return !!this.meta.demo;
  }
  /** What the client may know about the table. */
  info(): TableInfo {
    return { id: this.id, slug: this.slug, name: this.name, lang: this.state?.config?.lang || this.meta.lang || 'fr', ...(this.meta.demo ? { demo: true } : {}) };
  }
}

/** Multi-table internals the server core hands to the admin routes and to modules' routes (`tableApi`). */
export interface TableApi {
  /** Open tables: id -> Table (archived tables are closed). */
  tables: Map<string, Table>;
  openTable(meta: StoredMeta): Table;
  closeTable(id: string, opts?: { reason?: string }): void;
  initModules(table: Table): void;
  /** Replace a table's whole state (import, restore). `next` is an uploaded state file (foreign JSON). */
  importInto(t: Table, next: Record<string, any>, opts?: { keepSessions?: boolean }): void;
  scheduleTableBroadcast(table: Table | null | undefined): void;
  onlineUsers(table: Table): string[];
  issueToken(table: Table, userId: string): string;
  getMeta(id: unknown): StoredMeta | null;
  usableTable(t: Table | null | undefined): Table | null;
  tableBySlug(slug: unknown): Table | null;
}

// ---------------------------------------------------------------------------
// Registry (server.json)
// ---------------------------------------------------------------------------
let registry: Registry = { version: 1, tables: [], adminPasswordHash: null, adminPasswordEnv: null };

export function getRegistry(): Registry {
  return registry;
}
export function saveRegistry(): void {
  try {
    writeJsonAtomic(SERVER_FILE, registry);
  } catch (err) {
    console.error('[tables] cannot write server.json', err);
  }
}
export const listMetas = (): StoredMeta[] => registry.tables;
export const getMeta = (id: unknown): StoredMeta | null => registry.tables.find((t) => t.id === id) || null;

// `m` is foreign data (server.json, table.json, admin input).
function cleanMeta(m: any, fallbackId?: string): StoredMeta {
  const id = String(m?.id || fallbackId || '');
  return {
    id,
    slug: id,
    name: String(m?.name || id).slice(0, 80),
    createdAt: Number(m?.createdAt) || Date.now(),
    archived: !!m?.archived,
    hidden: !!m?.hidden,
    pack: isPack(m?.pack) ? m.pack : 'vierge',
    lang: isLangValue(m?.lang) ? m.lang : 'fr',
    ...(m?.legacy ? { legacy: true } : {}),
    ...(typeof m?.docsDir === 'string' && m.docsDir ? { docsDir: m.docsDir } : {}),
    ...(m?.migratedAt ? { migratedAt: m.migratedAt } : {}),
    // Never on the legacy table (a reset would wipe the real campaign).
    ...(m?.demo && !m?.legacy ? { demo: true } : {}),
  };
}

/** Write <dir>/table.json (portable copy of the meta). */
export function writeTableJson(meta: StoredMeta): void {
  try {
    const dir = path.join(TABLES_DIR, meta.id);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, 'table.json'), meta);
  } catch (err) {
    console.error('[tables] cannot write table.json', err);
  }
}

export function addMeta(meta: Partial<StoredMeta> & { id: string }): StoredMeta {
  const m = cleanMeta(meta);
  if (m.legacy && registry.tables.some((t) => t.legacy && t.id !== m.id)) delete m.legacy;
  registry.tables = registry.tables.filter((t) => t.id !== m.id);
  registry.tables.push(m);
  saveRegistry();
  writeTableJson(m);
  return m;
}
export function updateMeta(id: string, patch: Partial<StoredMeta>): StoredMeta | null {
  const m = getMeta(id);
  if (!m) return null;
  Object.assign(m, patch);
  saveRegistry();
  writeTableJson(m);
  return m;
}
export function removeMeta(id: string): void {
  registry.tables = registry.tables.filter((t) => t.id !== id);
  saveRegistry();
}

function moveDirContents(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.existsSync(dst)) continue;
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.cpSync(src, dst, { recursive: true }); // locked file (antivirus…): copy, keep the original
    }
    n++;
  }
  try {
    fs.rmdirSync(from); // only if now empty
  } catch {}
  return n;
}

/**
 * Old single-table layout (<runtime>/state.json, backups/, uploads/) → table "lazarus" (legacy URLs kept).
 * The original state.json is MOVED into tables/lazarus/backups/legacy-state-<ts>.json after a verified copy.
 */
function migrateLegacy(): StoredMeta | null {
  if (!fs.existsSync(LEGACY_STATE_FILE)) return null;
  const id = 'lazarus';
  const dir = path.join(TABLES_DIR, id);
  if (getMeta(id) || fs.existsSync(path.join(dir, 'state.json'))) {
    console.warn(`[tables] ${LEGACY_STATE_FILE} still exists but so does table "${id}": file left as is (ignored).`);
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const legacy = readJson(LEGACY_STATE_FILE, null);
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.copyFileSync(LEGACY_STATE_FILE, path.join(dir, 'state.json'));
  if (fs.existsSync(LEGACY_STATE_FILE + '.tmp')) fs.copyFileSync(LEGACY_STATE_FILE + '.tmp', path.join(dir, 'state.json.tmp'));
  const backups = moveDirContents(LEGACY_BACKUP_DIR, path.join(dir, 'backups'));
  const uploads = moveDirContents(LEGACY_UPLOAD_DIR, path.join(dir, 'uploads'));
  // Keep the untouched original next to the table's backups (not loaded again).
  const keep = path.join(dir, 'backups', `legacy-state-${stamp}.json`);
  try {
    fs.renameSync(LEGACY_STATE_FILE, keep);
  } catch {
    fs.copyFileSync(LEGACY_STATE_FILE, keep);
    try {
      fs.rmSync(LEGACY_STATE_FILE);
    } catch {
      console.warn(`[tables] could not remove ${LEGACY_STATE_FILE} (locked?) — delete it by hand.`);
    }
  }
  try {
    fs.rmSync(LEGACY_STATE_FILE + '.tmp', { force: true });
  } catch {}
  const meta = addMeta({
    id, name: legacy?.config?.campaignName || 'Project Lazarus', createdAt: Date.now(), pack: 'project-lazarus',
    lang: isLangValue(legacy?.config?.lang) ? legacy.config.lang : 'fr', legacy: true, docsDir: '../Shadowrun', migratedAt: Date.now(),
  });
  console.log(`[tables] existing game migrated into table "${id}" (${backups} backup(s), ${uploads} uploaded file(s) moved; original kept: ${keep})`);
  return meta;
}

/** Folders in tables/ that hold a state.json but are not registered (copied by hand, or restored): adopt them. */
function adoptOrphans(): void {
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(TABLES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {}
  for (const d of dirs) {
    if (getMeta(d.name) || slugError(d.name)) continue;
    const dir = path.join(TABLES_DIR, d.name);
    if (!fs.existsSync(path.join(dir, 'state.json'))) continue;
    const tj = readJson(path.join(dir, 'table.json'), {}) || {};
    const st = readJson(path.join(dir, 'state.json'), {}) || {};
    const meta = addMeta({ ...tj, id: d.name, name: tj.name || st.config?.campaignName || d.name, pack: tj.pack || 'vierge', archived: false });
    console.log(`[tables] folder "${d.name}" adopted as a table${meta.legacy ? ' (legacy URLs)' : ''}`);
  }
}

/** Fresh install: one table so `npm start` behaves as before (disable with SR_BOOTSTRAP_TABLE=none). */
function bootstrap(): StoredMeta | null {
  const id = process.env.SR_BOOTSTRAP_TABLE === undefined ? 'lazarus' : String(process.env.SR_BOOTSTRAP_TABLE).trim();
  if (!id || id === 'none' || slugError(id)) return null;
  const meta = addMeta({ id, name: 'Project Lazarus', pack: 'project-lazarus', lang: 'fr', legacy: true, docsDir: '../Shadowrun' });
  console.log(`[tables] first install: table "${id}" created (default GM password "lazarus" — change it in Settings)`);
  return meta;
}

/** Load server.json, migrate the single-table layout, adopt orphan folders, bootstrap a fresh install. */
export function bootRegistry(): Registry {
  const r = readJson(SERVER_FILE, null);
  if (r && typeof r === 'object') {
    registry = { version: 1, tables: [], adminPasswordHash: null, adminPasswordEnv: null, ...r };
    registry.tables = (Array.isArray(r.tables) ? r.tables : []).filter((t: any) => t?.id && !slugError(t.id)).map((t: any) => cleanMeta(t));
    let seenLegacy = false;
    for (const t of registry.tables) {
      if (t.legacy && seenLegacy) delete t.legacy;
      if (t.legacy) seenLegacy = true;
    }
  } else if (fs.existsSync(SERVER_FILE)) {
    // Never overwrite an unreadable registry silently.
    const keep = `${SERVER_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(SERVER_FILE, keep);
    } catch {}
    console.error(`[tables] server.json unreadable: copy kept (${keep}), registry rebuilt from the table folders.`);
  }
  migrateLegacy();
  adoptOrphans();
  if (!registry.tables.length) bootstrap();
  saveRegistry();
  return registry;
}

/** Create the folder + initial state of a new table (modules seed it when it is opened). */
export function createTableFiles({ id, name, pack, lang, gmPassword, hidden = false, demo = false }: {
  id: string; name: string; pack: PackId; lang: Lang; gmPassword: string; hidden?: boolean; demo?: boolean;
}): StoredMeta {
  const dir = path.join(TABLES_DIR, id);
  if (fs.existsSync(path.join(dir, 'state.json'))) throw new Error('This table folder already exists on disk');
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const state = emptyState();
  state.config = { gmPassword: String(gmPassword), campaignName: name, lang };
  writeJsonAtomic(path.join(dir, 'state.json'), state);
  return addMeta({ id, name, pack, lang, hidden, createdAt: Date.now(), ...(demo ? { demo: true } : {}) });
}

/**
 * SR_DEMO_TABLE=<id> (e.g. « demo »): make sure that public demo table exists (pack « demo », flag `demo`).
 * Only ever CREATES it: an existing table that is not already a demo is never converted (its reset would wipe it).
 * SR_DEMO_NAME / SR_DEMO_LANG name it on creation. Returns its meta, or null.
 */
export function ensureDemoTable(): StoredMeta | null {
  const id = String(process.env.SR_DEMO_TABLE || '').trim().toLowerCase();
  if (!id || id === 'none') return null;
  const bad = slugError(id);
  if (bad) {
    console.error(`[demo] SR_DEMO_TABLE="${id}" ignored: ${bad}`);
    return null;
  }
  const m = getMeta(id);
  if (m && !m.demo) {
    console.error(`[demo] table "${id}" already exists and is not a demo table: left as is (pick another SR_DEMO_TABLE).`);
    return null;
  }
  if (m) return m.archived ? updateMeta(id, { archived: false }) : m;
  const dir = path.join(TABLES_DIR, id);
  if (fs.existsSync(path.join(dir, 'state.json'))) {
    console.error(`[demo] an unregistered tables/${id} folder already exists: demo table not created.`);
    return null;
  }
  const lang = isLangValue(process.env.SR_DEMO_LANG) ? process.env.SR_DEMO_LANG : 'fr';
  const name = String(process.env.SR_DEMO_NAME || '').trim().slice(0, 80) || (lang === 'en' ? 'Demo table' : 'Table de démonstration');
  const meta = createTableFiles({ id, name, pack: 'demo', lang, gmPassword: crypto.randomBytes(12).toString('hex'), demo: true });
  console.log(`[demo] public demo table created: /t/${id}/`);
  return meta;
}

// ---------------------------------------------------------------------------
// Admin password (scrypt). SR_ADMIN_PASSWORD wins whenever it changes; otherwise the stored hash is kept
// (so a password changed in the admin page survives restarts). Without either, one is generated and printed once.
// ---------------------------------------------------------------------------
export function hashPassword(pw: unknown, salt: string = crypto.randomBytes(16).toString('hex')): string {
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
export function verifyPassword(pw: unknown, stored: string | null | undefined): boolean {
  const [kind, salt, hex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const a = Buffer.from(hex, 'hex');
  const b = crypto.scryptSync(String(pw ?? ''), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function setAdminPassword(pw: string): void {
  registry.adminPasswordHash = hashPassword(pw);
  saveRegistry();
}

export function setupAdminPassword(): void {
  const env = process.env.SR_ADMIN_PASSWORD;
  if (env) {
    const fp = registry.adminPasswordEnv;
    if (!fp || !verifyPassword(env, fp)) {
      registry.adminPasswordHash = hashPassword(env);
      registry.adminPasswordEnv = hashPassword(env); // fingerprint: detects a later change of the variable
      saveRegistry();
      console.log('[admin] administrator password set from SR_ADMIN_PASSWORD');
    }
    return;
  }
  if (registry.adminPasswordHash) return;
  const pw = crypto.randomBytes(9).toString('base64url');
  registry.adminPasswordHash = hashPassword(pw);
  saveRegistry();
  console.log('\n  ┌────────────────────────────────────────────────────────────┐');
  console.log(`  │ Generated ADMINISTRATOR password: ${pw.padEnd(25)}│`);
  console.log('  │ (shown only once — /admin page; or set it with the         │');
  console.log('  │  SR_ADMIN_PASSWORD variable, then restart)                 │');
  console.log('  └────────────────────────────────────────────────────────────┘\n');
}

export { RUNTIME_DIR, TABLES_DIR };
