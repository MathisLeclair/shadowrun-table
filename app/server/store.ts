// Persistence: one JSON document per table (data/tables/<id>/state.json), seeded from a content pack.
// Every module owns a slice of a table's `state` (see ARCHITECTURE.md for the shape).
// The table a piece of code works on is carried by an AsyncLocalStorage scope (tableScope): HTTP handlers and
// socket actions run inside it, so getState()/currentUploadDir()… resolve to that table without extra arguments.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import type { TableState } from '../shared/types.ts';
import type { Table } from './lib/tables.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SEED_DIR = path.join(DATA_DIR, 'seed'); // pack "project-lazarus"
export const PACKS_DIR = path.join(DATA_DIR, 'packs'); // other packs: data/packs/<pack>/
// Runtime files (registry, tables, legacy state) can be redirected for isolated test servers or Docker:
// SR_RUNTIME_DIR=/some/dir
export const RUNTIME_DIR = process.env.SR_RUNTIME_DIR ? path.resolve(process.env.SR_RUNTIME_DIR) : DATA_DIR;
export const TABLES_DIR = path.join(RUNTIME_DIR, 'tables');
export const SERVER_FILE = path.join(RUNTIME_DIR, 'server.json');
export const DELETED_DIR = path.join(RUNTIME_DIR, 'deleted'); // backup zips of deleted / replaced tables
export const TMP_DIR = path.join(RUNTIME_DIR, 'tmp'); // streamed uploads, restore staging
export const GLOBAL_ASSETS_DIR = path.join(DATA_DIR, 'assets'); // served at /assets (legacy Foundry assets)
export const LEGACY_DOCS_DIR = path.resolve(ROOT, '..', 'Shadowrun');
// Legacy single-table layout (before multi-table hosting): migrated into table "lazarus" at first boot.
export const LEGACY_STATE_FILE = path.join(RUNTIME_DIR, 'state.json');
export const LEGACY_UPLOAD_DIR = path.join(RUNTIME_DIR, 'uploads');
export const LEGACY_BACKUP_DIR = path.join(RUNTIME_DIR, 'backups');

for (const d of [DATA_DIR, RUNTIME_DIR, TABLES_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

/**
 * Read a JSON file, returning `fallback` if missing or invalid.
 * The content comes from disk (foreign JSON): name the expected type (`readJson<X>(file)`), else it is `any`.
 */
export function readJson<T = any>(file: string, fallback?: null): T | null;
export function readJson<T = any>(file: string, fallback: NoInfer<T>): T;
export function readJson(file: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write a JSON file atomically (tmp + fsync + rename). Throws on failure. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    try {
      fs.fsyncSync(fd);
    } catch {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** What emptyState() holds: every other slice of TableState is created by its module's init(). */
export type BaseState = Pick<TableState, 'version' | 'config' | 'users' | 'actors' | 'log'>;

/** The base empty state. Modules fill their own slices in their `init(state)` hook. */
export function emptyState(): BaseState {
  return {
    version: 1,
    config: { gmPassword: 'lazarus', campaignName: 'Project Lazarus', lang: 'fr' },
    users: {}, // id -> { id, name, pin, characterIds: [] }
    actors: {}, // id -> PC or NPC actor (see ARCHITECTURE.md)
    log: [], // chat + dice entries
  };
}

function parseFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Persistence of one table's state (see createStateStore). Methods are plain properties: the demo table wraps them. */
export interface StateStore {
  load(): TableState;
  /** The live state (null before load() and on a table whose state could not be read). */
  get(): TableState | null;
  /** Replace the whole state (import, restore, reset); modules' init() completes a partial one. */
  replace(next: TableState | BaseState): void;
  saveNow(): boolean;
  saveSoon(): void;
  flush(): void;
  backup(kind?: string): string | null;
  dirty(): boolean;
  stateFile: string;
  backupDir: string;
  /** Set once the demo table instrumentation wrapped saveSoon/saveNow (server/lib/demo.ts). */
  __demo?: boolean;
}

/**
 * Persistence of one table's state in `dir` (state.json + backups/).
 * Returns { load, get, replace, saveNow, saveSoon, flush, backup, dirty }.
 */
export function createStateStore(dir: string, { label = path.basename(dir) }: { label?: string } = {}): StateStore {
  const STATE_FILE = path.join(dir, 'state.json');
  const BACKUP_DIR = path.join(dir, 'backups');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Until the modules' init() ran, the state may only hold the BaseState slices.
  let state: TableState | null = null;
  let saveTimer: NodeJS.Timeout | null = null;
  let firstDirtyAt = 0;
  let saveFailures = 0;
  let lastAutoBackup = '';

  /**
   * Load state.json. A missing file starts a fresh game; an unreadable one is NEVER silently replaced:
   * it is kept aside, then the newest readable copy (.tmp, then backups) is restored, or loading throws.
   */
  function load(): TableState {
    let loaded: any; // parsed from disk
    if (!fs.existsSync(STATE_FILE)) {
      loaded = emptyState();
    } else {
      loaded = parseFile(STATE_FILE);
      if (!loaded || typeof loaded !== 'object') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const corrupt = path.join(dir, `state.corrupt-${stamp}.json`);
        try {
          fs.copyFileSync(STATE_FILE, corrupt);
        } catch {}
        const candidates = [STATE_FILE + '.tmp'];
        try {
          candidates.push(...fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('state-') && f.endsWith('.json')).sort().reverse().map((f) => path.join(BACKUP_DIR, f)));
        } catch {}
        let from: string | null = null;
        for (const f of candidates) {
          const v = fs.existsSync(f) ? parseFile(f) : null;
          if (v && typeof v === 'object' && v.actors) {
            loaded = v;
            from = f;
            break;
          }
        }
        console.error(`\n  !!! [${label}] state.json is unreadable (invalid JSON). Copy kept: ${corrupt}`);
        if (!from) {
          state = null;
          throw new Error(`[${label}] state.json illisible et aucune sauvegarde lisible dans ${BACKUP_DIR}`);
        }
        console.error(`  !!! [${label}] State restored from: ${from}\n`);
      }
    }
    const base: Record<string, unknown> = emptyState();
    for (const k of Object.keys(base)) if (loaded[k] === undefined) loaded[k] = base[k];
    state = loaded as TableState;
    return state;
  }

  function replace(next: TableState | BaseState): void {
    state = next as TableState; // completed by the modules' init() right after (importInto, reset)
    saveSoon();
  }

  /** Write state.json atomically. Never throws: on an fs error (EPERM/EBUSY lock, disk full…) it logs and retries. */
  function saveNow(): boolean {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    firstDirtyAt = 0;
    if (!state) return true;
    const tmp = STATE_FILE + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(state));
        try {
          fs.fsyncSync(fd);
        } catch {}
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, STATE_FILE);
      if (saveFailures) console.error(`[store:${label}] save OK again after ${saveFailures} failure(s)`);
      saveFailures = 0;
      return true;
    } catch (err) {
      saveFailures++;
      const e = err as NodeJS.ErrnoException;
      console.error(`[store:${label}] save failed (${e.code || e.message}), retry #${saveFailures}`);
      saveTimer = setTimeout(saveNow, Math.min(5000, 250 * saveFailures));
      return false;
    }
  }

  /** Final synchronous save (exit/signal handlers, unload). */
  function flush(): void {
    try {
      saveNow();
    } catch (err) {
      console.error(`[store:${label}] final save failed`, err);
    }
  }

  /** Debounced save (400 ms), but never postponed more than 2 s by a continuous stream of actions. */
  function saveSoon(): void {
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    if (now - firstDirtyAt > 2000) return void saveNow();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  /**
   * Write a timestamped backup. Keeps the 30 newest automatic ones and, separately, the 20 newest labelled ones
   * (manual, boot, before-import…), so periodic auto copies never push out the copies you may need.
   * Returns the file name, or null on failure (never throws).
   */
  function backup(kind = 'auto'): string | null {
    if (!state) return null;
    try {
      const json = JSON.stringify(state);
      if (kind === 'auto') {
        if (json === lastAutoBackup) return null; // nothing changed since the last auto copy
        lastAutoBackup = json;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(BACKUP_DIR, `state-${stamp}-${kind}.json`);
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(file, json);
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('state-') && f.endsWith('.json')).sort();
      const autos = files.filter((f) => f.endsWith('-auto.json'));
      const others = files.filter((f) => !f.endsWith('-auto.json'));
      for (const [list, keep] of [[autos, 30], [others, 20]] as const) {
        while (list.length > keep) {
          try {
            fs.unlinkSync(path.join(BACKUP_DIR, list.shift()!));
          } catch {}
        }
      }
      return path.basename(file);
    } catch (err) {
      console.error(`[store:${label}] backup failed`, err);
      return null;
    }
  }

  return { load, get: () => state, replace, saveNow, saveSoon, flush, backup, dirty: () => !!saveTimer, stateFile: STATE_FILE, backupDir: BACKUP_DIR };
}

// ---------------------------------------------------------------------------
// Table scope (AsyncLocalStorage): which table the running code works on.
// ---------------------------------------------------------------------------
export const tableScope = new AsyncLocalStorage<Table>();

/** The table of the running request/action (a Table from server/lib/tables.ts), or null outside any table. */
export function currentTable(): Table | null {
  return tableScope.getStore() || null;
}
export const currentTableId = (): string | null => currentTable()?.id || null;
/** State of the current table (compat with the single-table API). */
export const getState = (): TableState | null => currentTable()?.state || null;
/** Upload dir / public URL prefix of the current table (`/uploads` for the legacy table, else `/t/<slug>/uploads`). */
export const currentUploadDir = (): string => currentTable()?.uploadDir || LEGACY_UPLOAD_DIR;
export const currentUploadUrl = (): string => currentTable()?.uploadUrl || '/uploads';
/** Campaign markdown docs of the current table. */
export const currentDocsDir = (): string => currentTable()?.docsDir() || LEGACY_DOCS_DIR;

/**
 * Local file behind an app URL of the current table (uploads or imported assets), or null.
 * Accepts /uploads/…, /assets/… (legacy/global) and /t/<slug>/uploads|assets/… of the current table.
 */
export function localFileForUrl(url: unknown): string | null {
  const t = currentTable();
  let u = String(url || '').split(/[?#]/)[0];
  let base: string;
  if (t && !t.legacy && u.startsWith(`/t/${t.slug}/uploads/`)) {
    base = t.uploadDir;
    u = u.slice(`/t/${t.slug}/uploads/`.length);
  } else if (t && u.startsWith(`/t/${t.slug}/assets/`)) {
    base = path.join(t.dir, 'assets');
    u = u.slice(`/t/${t.slug}/assets/`.length);
  } else if (u.startsWith('/uploads/') && (!t || t.legacy)) {
    base = t ? t.uploadDir : LEGACY_UPLOAD_DIR;
    u = u.slice('/uploads/'.length);
  } else if (u.startsWith('/assets/')) {
    base = GLOBAL_ASSETS_DIR;
    u = u.slice('/assets/'.length);
  } else return null;
  let parts: string[];
  try {
    parts = decodeURIComponent(u).split('/');
  } catch {
    return null;
  }
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return null;
  return path.join(base, ...parts);
}
