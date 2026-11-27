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
} from '../store.js';

export const PACKS = {
  'project-lazarus': { label: 'Project Lazarus (campagne complète)', dir: SEED_DIR },
  vierge: { label: 'Campagne vierge (bestiaire générique)', dir: path.join(PACKS_DIR, 'vierge') },
  // Public demo table content (tools/build-demo.js): the vierge pack plus pre-made PCs, maps, a Matrix host.
  demo: { label: 'Démo (vierge + prétirés, cartes, host)', dir: path.join(PACKS_DIR, 'demo'), base: 'vierge' },
};
/** Seed folders of a pack, base pack first (module inits only add what is missing, so layering is safe). */
export function packDirs(pack) {
  const p = PACKS[pack] || PACKS['project-lazarus'];
  return p.base && PACKS[p.base] ? [...packDirs(p.base), p.dir] : [p.dir];
}
export const LANGS = ['fr', 'en'];
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'api', 't', 'uploads', 'assets', 'vendor', 'shared', 'catalog', 'modules', 'lib', 'socket-io', 'tables', 'health', 'deleted', 'tmp']);

/** URL-safe slug from a display name ('Les Ombres de Paris' → 'les-ombres-de-paris'). */
export function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** French error message for an invalid slug, or null. */
export function slugError(slug) {
  if (!SLUG_RE.test(String(slug || ''))) return 'Identifiant invalide : lettres minuscules, chiffres et tirets (2 à 40 caractères)';
  if (String(slug).length < 2) return 'Identifiant trop court (2 caractères minimum)';
  if (RESERVED.has(slug)) return `Identifiant réservé : « ${slug} »`;
  return null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
export class Table {
  constructor(meta) {
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
  get id() {
    return this.meta.id;
  }
  get slug() {
    return this.meta.slug;
  }
  get name() {
    return this.meta.name;
  }
  get legacy() {
    return !!this.meta.legacy;
  }
  get state() {
    return this.store.get();
  }
  get uploadDir() {
    return path.join(this.dir, 'uploads');
  }
  /** Public URL prefix of uploads (historical /uploads for the legacy table). */
  get uploadUrl() {
    return this.legacy ? '/uploads' : `/t/${this.slug}/uploads`;
  }
  /** Where Foundry imports copy assets, and their public URL prefix. */
  get assetsDir() {
    if (this.legacy) return process.env.SR_FOUNDRY_ASSET_DIR ? path.resolve(process.env.SR_FOUNDRY_ASSET_DIR) : path.join(GLOBAL_ASSETS_DIR, 'foundry');
    return path.join(this.dir, 'assets', 'foundry');
  }
  get assetsUrl() {
    return this.legacy ? '/assets/foundry' : `/t/${this.slug}/assets/foundry`;
  }
  /** Uploaded Foundry worlds (extracted zips): <dir>/foundry/Data/worlds/<world>. */
  get foundryDir() {
    return path.join(this.dir, 'foundry');
  }
  /** Campaign markdown docs: the configured folder when it exists (../Shadowrun for the legacy table), else <dir>/docs. */
  docsDir() {
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
  get packDir() {
    return (PACKS[this.meta.pack] || PACKS['project-lazarus']).dir;
  }
  /** Seed folders, base pack first (see packDirs). */
  get packDirs() {
    return packDirs(this.meta.pack);
  }
  get demo() {
    return !!this.meta.demo;
  }
  /** What the client may know about the table. */
  info() {
    return { id: this.id, slug: this.slug, name: this.name, lang: this.state?.config?.lang || this.meta.lang || 'fr', ...(this.meta.demo ? { demo: true } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Registry (server.json)
// ---------------------------------------------------------------------------
let registry = { version: 1, tables: [], adminPasswordHash: null, adminPasswordEnv: null };

export function getRegistry() {
  return registry;
}
export function saveRegistry() {
  try {
    writeJsonAtomic(SERVER_FILE, registry);
  } catch (err) {
    console.error('[tables] cannot write server.json', err);
  }
}
export const listMetas = () => registry.tables;
export const getMeta = (id) => registry.tables.find((t) => t.id === id) || null;

function cleanMeta(m, fallbackId) {
  const id = String(m?.id || fallbackId || '');
  return {
    id,
    slug: id,
    name: String(m?.name || id).slice(0, 80),
    createdAt: Number(m?.createdAt) || Date.now(),
    archived: !!m?.archived,
    hidden: !!m?.hidden,
    pack: PACKS[m?.pack] ? m.pack : 'vierge',
    lang: LANGS.includes(m?.lang) ? m.lang : 'fr',
    ...(m?.legacy ? { legacy: true } : {}),
    ...(typeof m?.docsDir === 'string' && m.docsDir ? { docsDir: m.docsDir } : {}),
    ...(m?.migratedAt ? { migratedAt: m.migratedAt } : {}),
    // Never on the legacy table (a reset would wipe the real campaign).
    ...(m?.demo && !m?.legacy ? { demo: true } : {}),
  };
}

/** Write <dir>/table.json (portable copy of the meta). */
export function writeTableJson(meta) {
  try {
    const dir = path.join(TABLES_DIR, meta.id);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, 'table.json'), meta);
  } catch (err) {
    console.error('[tables] cannot write table.json', err);
  }
}

export function addMeta(meta) {
  const m = cleanMeta(meta);
  if (m.legacy && registry.tables.some((t) => t.legacy && t.id !== m.id)) delete m.legacy;
  registry.tables = registry.tables.filter((t) => t.id !== m.id);
  registry.tables.push(m);
  saveRegistry();
  writeTableJson(m);
  return m;
}
export function updateMeta(id, patch) {
  const m = getMeta(id);
  if (!m) return null;
  Object.assign(m, patch);
  saveRegistry();
  writeTableJson(m);
  return m;
}
export function removeMeta(id) {
  registry.tables = registry.tables.filter((t) => t.id !== id);
  saveRegistry();
}

function moveDirContents(from, to) {
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
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_STATE_FILE)) return null;
  const id = 'lazarus';
  const dir = path.join(TABLES_DIR, id);
  if (getMeta(id) || fs.existsSync(path.join(dir, 'state.json'))) {
    console.warn(`[tables] ${LEGACY_STATE_FILE} existe encore mais la table « ${id} » aussi : fichier laissé tel quel (ignoré).`);
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
      console.warn(`[tables] impossible de retirer ${LEGACY_STATE_FILE} (verrouillé ?) — supprime-le à la main.`);
    }
  }
  try {
    fs.rmSync(LEGACY_STATE_FILE + '.tmp', { force: true });
  } catch {}
  const meta = addMeta({
    id, name: legacy?.config?.campaignName || 'Project Lazarus', createdAt: Date.now(), pack: 'project-lazarus',
    lang: LANGS.includes(legacy?.config?.lang) ? legacy.config.lang : 'fr', legacy: true, docsDir: '../Shadowrun', migratedAt: Date.now(),
  });
  console.log(`[tables] partie existante migrée dans la table « ${id} » (${backups} sauvegarde(s), ${uploads} fichier(s) téléversé(s) déplacés ; original gardé : ${keep})`);
  return meta;
}

/** Folders in tables/ that hold a state.json but are not registered (copied by hand, or restored): adopt them. */
function adoptOrphans() {
  let dirs = [];
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
    console.log(`[tables] dossier « ${d.name} » adopté comme table${meta.legacy ? ' (URL historiques)' : ''}`);
  }
}

/** Fresh install: one table so `npm start` behaves as before (disable with SR_BOOTSTRAP_TABLE=none). */
function bootstrap() {
  const id = process.env.SR_BOOTSTRAP_TABLE === undefined ? 'lazarus' : String(process.env.SR_BOOTSTRAP_TABLE).trim();
  if (!id || id === 'none' || slugError(id)) return null;
  const meta = addMeta({ id, name: 'Project Lazarus', pack: 'project-lazarus', lang: 'fr', legacy: true, docsDir: '../Shadowrun' });
  console.log(`[tables] première installation : table « ${id} » créée (mot de passe MJ par défaut « lazarus » — change-le dans Réglages)`);
  return meta;
}

/** Load server.json, migrate the single-table layout, adopt orphan folders, bootstrap a fresh install. */
export function bootRegistry() {
  const r = readJson(SERVER_FILE, null);
  if (r && typeof r === 'object') {
    registry = { version: 1, tables: [], adminPasswordHash: null, adminPasswordEnv: null, ...r };
    registry.tables = (Array.isArray(r.tables) ? r.tables : []).filter((t) => t?.id && !slugError(t.id)).map((t) => cleanMeta(t));
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
    console.error(`[tables] server.json illisible : copie gardée (${keep}), registre reconstruit depuis les dossiers de tables.`);
  }
  migrateLegacy();
  adoptOrphans();
  if (!registry.tables.length) bootstrap();
  saveRegistry();
  return registry;
}

/** Create the folder + initial state of a new table (modules seed it when it is opened). */
export function createTableFiles({ id, name, pack, lang, gmPassword, hidden = false, demo = false }) {
  const dir = path.join(TABLES_DIR, id);
  if (fs.existsSync(path.join(dir, 'state.json'))) throw new Error('Ce dossier de table existe déjà sur le disque');
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
export function ensureDemoTable() {
  const id = String(process.env.SR_DEMO_TABLE || '').trim().toLowerCase();
  if (!id || id === 'none') return null;
  const bad = slugError(id);
  if (bad) {
    console.error(`[demo] SR_DEMO_TABLE=« ${id} » ignoré : ${bad}`);
    return null;
  }
  const m = getMeta(id);
  if (m && !m.demo) {
    console.error(`[demo] la table « ${id} » existe déjà et n’est pas une table de démo : laissée telle quelle (choisis un autre SR_DEMO_TABLE).`);
    return null;
  }
  if (m) return m.archived ? updateMeta(id, { archived: false }) : m;
  const dir = path.join(TABLES_DIR, id);
  if (fs.existsSync(path.join(dir, 'state.json'))) {
    console.error(`[demo] un dossier tables/${id} non enregistré existe déjà : table de démo non créée.`);
    return null;
  }
  const lang = LANGS.includes(process.env.SR_DEMO_LANG) ? process.env.SR_DEMO_LANG : 'fr';
  const name = String(process.env.SR_DEMO_NAME || '').trim().slice(0, 80) || (lang === 'en' ? 'Demo table' : 'Table de démonstration');
  const meta = createTableFiles({ id, name, pack: 'demo', lang, gmPassword: crypto.randomBytes(12).toString('hex'), demo: true });
  console.log(`[demo] table publique de démonstration créée : /t/${id}/`);
  return meta;
}

// ---------------------------------------------------------------------------
// Admin password (scrypt). SR_ADMIN_PASSWORD wins whenever it changes; otherwise the stored hash is kept
// (so a password changed in the admin page survives restarts). Without either, one is generated and printed once.
// ---------------------------------------------------------------------------
export function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [kind, salt, hex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const a = Buffer.from(hex, 'hex');
  const b = crypto.scryptSync(String(pw ?? ''), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function setAdminPassword(pw) {
  registry.adminPasswordHash = hashPassword(pw);
  saveRegistry();
}

export function setupAdminPassword() {
  const env = process.env.SR_ADMIN_PASSWORD;
  if (env) {
    const fp = registry.adminPasswordEnv;
    if (!fp || !verifyPassword(env, fp)) {
      registry.adminPasswordHash = hashPassword(env);
      registry.adminPasswordEnv = hashPassword(env); // fingerprint: detects a later change of the variable
      saveRegistry();
      console.log('[admin] mot de passe administrateur défini depuis SR_ADMIN_PASSWORD');
    }
    return;
  }
  if (registry.adminPasswordHash) return;
  const pw = crypto.randomBytes(9).toString('base64url');
  registry.adminPasswordHash = hashPassword(pw);
  saveRegistry();
  console.log('\n  ┌────────────────────────────────────────────────────────────┐');
  console.log(`  │ Mot de passe ADMINISTRATEUR généré : ${pw.padEnd(22)}│`);
  console.log('  │ (affiché une seule fois — page /admin ; ou fixe-le avec    │');
  console.log('  │  la variable SR_ADMIN_PASSWORD puis redémarre)             │');
  console.log('  └────────────────────────────────────────────────────────────┘\n');
}

export { RUNTIME_DIR, TABLES_DIR };
