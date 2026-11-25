// Persistent game state: one JSON document on disk, seeded from data/seed/.
// Every module owns a slice of `state` (see ARCHITECTURE.md for the shape).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SEED_DIR = path.join(DATA_DIR, 'seed');
// Runtime files (state, backups, uploads) can be redirected for isolated test servers: SR_RUNTIME_DIR=/some/dir
export const RUNTIME_DIR = process.env.SR_RUNTIME_DIR ? path.resolve(process.env.SR_RUNTIME_DIR) : DATA_DIR;
export const UPLOAD_DIR = path.join(RUNTIME_DIR, 'uploads');
export const STATE_FILE = path.join(RUNTIME_DIR, 'state.json');
export const BACKUP_DIR = path.join(RUNTIME_DIR, 'backups');
export const DOCS_DIR = path.resolve(ROOT, '..', 'Shadowrun');

for (const d of [DATA_DIR, SEED_DIR, RUNTIME_DIR, UPLOAD_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });

/** Read a JSON file, returning `fallback` if missing or invalid. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Read every *.json file in a seed sub-directory (or a single seed file) and return the parsed values. */
export function readSeedDir(sub) {
  const dir = path.join(SEED_DIR, sub);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean);
}

export function readSeed(name, fallback = null) {
  return readJson(path.join(SEED_DIR, name), fallback);
}

/** The base empty state. Modules fill their own slices in their `init(state)` hook. */
export function emptyState() {
  return {
    version: 1,
    config: { gmPassword: 'lazarus', campaignName: 'Project Lazarus' },
    users: {}, // id -> { id, name, pin, characterIds: [] }
    actors: {}, // id -> PC or NPC actor (see ARCHITECTURE.md)
    log: [], // chat + dice entries
  };
}

let state = null;
let saveTimer = null;
let firstDirtyAt = 0;
let saveFailures = 0;
let lastAutoBackup = '';

function parseFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load state.json. A missing file starts a fresh game; an unreadable one is NEVER silently replaced:
 * it is kept aside, then the newest readable copy (.tmp, then backups) is restored, or the server refuses to start.
 */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    state = emptyState();
  } else {
    state = parseFile(STATE_FILE);
    if (!state || typeof state !== 'object') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corrupt = path.join(RUNTIME_DIR, `state.corrupt-${stamp}.json`);
      try {
        fs.copyFileSync(STATE_FILE, corrupt);
      } catch {}
      const candidates = [STATE_FILE + '.tmp'];
      try {
        candidates.push(...fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('state-') && f.endsWith('.json')).sort().reverse().map((f) => path.join(BACKUP_DIR, f)));
      } catch {}
      let from = null;
      for (const f of candidates) {
        const v = fs.existsSync(f) ? parseFile(f) : null;
        if (v && typeof v === 'object' && v.actors) {
          state = v;
          from = f;
          break;
        }
      }
      console.error('\n  !!! data/state.json est illisible (JSON invalide). Copie gardée : ' + corrupt);
      if (!from) {
        console.error('  !!! Aucune sauvegarde lisible trouvée. Corrige le fichier (ou copie une sauvegarde de ' + BACKUP_DIR + ') puis relance.\n');
        process.exit(1);
      }
      console.error('  !!! État restauré depuis : ' + from + '\n');
    }
  }
  const base = emptyState();
  for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
  return state;
}

export function getState() {
  return state;
}

export function replaceState(next) {
  state = next;
  saveSoon();
}

/** Write state.json atomically. Never throws: on an fs error (EPERM/EBUSY lock, disk full…) it logs and retries. */
export function saveNow() {
  clearTimeout(saveTimer);
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
    if (saveFailures) console.error('[store] save OK again after ' + saveFailures + ' failure(s)');
    saveFailures = 0;
    return true;
  } catch (err) {
    saveFailures++;
    console.error(`[store] save failed (${err.code || err.message}), retry #${saveFailures}`);
    saveTimer = setTimeout(saveNow, Math.min(5000, 250 * saveFailures));
    return false;
  }
}

/** Final synchronous save (exit/signal handlers). */
export function flushState() {
  try {
    saveNow();
  } catch (err) {
    console.error('[store] final save failed', err);
  }
}

/** Debounced save (400 ms), but never postponed more than 2 s by a continuous stream of actions. */
export function saveSoon() {
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  if (now - firstDirtyAt > 2000) return void saveNow();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

/**
 * Write a timestamped backup. Keeps the 30 newest automatic ones and, separately, the 20 newest labelled ones
 * (manual, boot, before-import…), so periodic auto copies never push out the copies you may need.
 * Returns the file name, or null on failure (never throws).
 */
export function backup(label = 'auto') {
  if (!state) return null;
  try {
    const json = JSON.stringify(state);
    if (label === 'auto') {
      if (json === lastAutoBackup) return null; // nothing changed since the last auto copy
      lastAutoBackup = json;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `state-${stamp}-${label}.json`);
    fs.writeFileSync(file, json);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('state-') && f.endsWith('.json')).sort();
    const autos = files.filter((f) => f.endsWith('-auto.json'));
    const others = files.filter((f) => !f.endsWith('-auto.json'));
    for (const [list, keep] of [[autos, 30], [others, 20]]) {
      while (list.length > keep) {
        try {
          fs.unlinkSync(path.join(BACKUP_DIR, list.shift()));
        } catch {}
      }
    }
    return path.basename(file);
  } catch (err) {
    console.error('[store] backup failed', err);
    return null;
  }
}
