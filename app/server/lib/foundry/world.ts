// Foundry VTT world reader: locate the world, copy its LevelDB collections to a temp dir
// (Foundry may be running and holds a LOCK), read every record and assemble documents
// with their embedded collections (actor.items, scene.walls, journal.pages, …).
//
// Reading LevelDB is asynchronous (classic-level). Action handlers in this app are synchronous,
// so readWorldSync() runs the async reader in a child process (dump-child.ts) and blocks until done.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { i18nError } from './messages.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FALLBACK_WORLD = 'C:/Users/mathi/Documents/Foundry/Data/worlds/test-world';
export const COLLECTIONS = ['actors', 'scenes', 'journal', 'playlists', 'folders', 'users'];

/**
 * Foundry document data (system data, flags, embedded documents' fields…): foreign JSON written by the shadowrun5e
 * system, whose shape varies between versions. The converters read it defensively (optional chaining, num(), String()).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FoundryData = any;

/** A Foundry document as stored in the world LevelDB, embedded collections assembled (assemble()). */
export interface FoundryDoc {
  _id: string;
  name: string;
  type?: string;
  folder?: string | null;
  sort?: number;
  img?: string;
  system?: FoundryData;
  flags?: FoundryData;
  ownership?: Record<string, number>;
  /** Every other field (embedded collections: items, effects, walls, pages, sounds…; scene / page / user fields). */
  [field: string]: FoundryData;
}

/** world.json of a Foundry world (fields read here). */
export interface WorldMeta {
  id?: string;
  title?: string;
  system?: string;
  coreVersion?: string;
  systemVersion?: string;
  lastPlayed?: string;
  [field: string]: unknown;
}

/** World listed by listWorlds(). */
export interface WorldInfo {
  id: string;
  title: string;
  path: string;
  system?: string;
  coreVersion?: string;
  systemVersion?: string;
  lastPlayed: string;
}

/** Raw LevelDB records per collection: { [collection]: { key: value } }. */
export type RawRecords = Record<string, Record<string, unknown>>;
/** Assembled documents per collection. */
export type AssembledCollections = Record<string, FoundryDoc[]>;

/** A read world: metadata + assembled collections (actors, scenes, journal, playlists, folders, users). */
export interface FoundryWorld {
  meta: WorldMeta;
  path: string;
  dataRoot: string;
  fingerprint: string;
  actors?: FoundryDoc[];
  scenes?: FoundryDoc[];
  journal?: FoundryDoc[];
  playlists?: FoundryDoc[];
  folders?: FoundryDoc[];
  users?: FoundryDoc[];
  [collection: string]: unknown;
}

/** Foundry "Data" folder of a world (…/Data/worlds/<id> → …/Data). Asset paths are relative to it. */
export function dataRootOf(worldPath: string): string {
  return path.resolve(worldPath, '..', '..');
}

/** Foundry user data path from %LOCALAPPDATA%/FoundryVTT/Config/options.json (null if not found). */
export function foundryDataPath(): string | null {
  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'FoundryVTT', 'Config', 'options.json'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'FoundryVTT', 'Config', 'options.json'));
  candidates.push(path.join(os.homedir(), '.local', 'share', 'FoundryVTT', 'Config', 'options.json'));
  for (const f of candidates) {
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (o && o.dataPath) return path.join(o.dataPath, 'Data');
    } catch {}
  }
  return null;
}

/** Every shadowrun5e world found in the Foundry data folder: [{ id, title, path, system, coreVersion }]. */
export function listWorlds(): WorldInfo[] {
  const data = foundryDataPath();
  const out: WorldInfo[] = [];
  const roots = [data && path.join(data, 'worlds'), path.dirname(FALLBACK_WORLD)].filter((r): r is string => Boolean(r));
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      const key = path.resolve(p).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const w = JSON.parse(fs.readFileSync(path.join(p, 'world.json'), 'utf8')) as WorldMeta;
        out.push({ id: w.id || e.name, title: w.title || e.name, path: p.split(path.sep).join('/'), system: w.system, coreVersion: w.coreVersion, systemVersion: w.systemVersion, lastPlayed: w.lastPlayed || '' });
      } catch {}
    }
  }
  return out;
}

/** Default world: the most recently played shadowrun5e world, else the known path. */
export function detectWorldPath(): string {
  const worlds = listWorlds().filter((w) => w.system === 'shadowrun5e');
  if (worlds.length) {
    worlds.sort((a, b) => (Date.parse(b.lastPlayed) || 0) - (Date.parse(a.lastPlayed) || 0));
    const known = worlds.find((w) => path.resolve(w.path).toLowerCase() === path.resolve(FALLBACK_WORLD).toLowerCase());
    return (known || worlds[0]).path;
  }
  return FALLBACK_WORLD;
}

/** Validate a world folder; returns its world.json (throws a French message otherwise). */
export function checkWorld(worldPath: unknown): WorldMeta {
  const wp = String(worldPath || '').trim();
  if (!wp) throw i18nError({ t: 'Foundry world path missing' });
  let meta: WorldMeta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(wp, 'world.json'), 'utf8'));
  } catch {
    throw i18nError({ t: 'No Foundry world found in “{path}” (world.json missing)', params: { path: wp } });
  }
  if (!fs.existsSync(path.join(wp, 'data', 'actors'))) throw i18nError({ t: 'The world “{world}” has no LevelDB database (Foundry v11+ required)', params: { world: meta.title || wp } });
  return meta;
}

/** Cheap fingerprint of the world's LevelDB files (names, sizes, mtimes) — changes when Foundry writes. */
export function worldFingerprint(worldPath: string, collections: string[] = COLLECTIONS): string {
  const h = crypto.createHash('sha1');
  for (const c of collections) {
    const dir = path.join(worldPath, 'data', c);
    let files: fs.Dirent[] = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== 'LOCK');
    } catch {}
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const st = fs.statSync(path.join(dir, f.name));
      h.update(`${c}/${f.name}:${st.size}:${st.mtimeMs};`);
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** Copy the collection folders (files only, no LOCK) into a fresh temp dir. Returns the temp dir. */
export function copyCollections(worldPath: string, collections: string[] = COLLECTIONS): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-foundry-'));
  for (const c of collections) {
    const src = path.join(worldPath, 'data', c);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(tmp, c);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src, { withFileTypes: true })) {
      if (!f.isFile() || f.name === 'LOCK') continue;
      fs.copyFileSync(path.join(src, f.name), path.join(dst, f.name));
    }
  }
  return tmp;
}

/** Read raw LevelDB records of the copied collections: { [collection]: { key: value } }. */
export async function readRaw(tmpDir: string, collections: string[] = COLLECTIONS): Promise<RawRecords> {
  const { ClassicLevel } = await import('classic-level');
  const raw: RawRecords = {};
  for (const c of collections) {
    const dir = path.join(tmpDir, c);
    raw[c] = {};
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(path.join(dir, 'LOCK'), { force: true });
    } catch {}
    const db = new ClassicLevel<string, unknown>(dir, { valueEncoding: 'json' });
    try {
      await db.open();
      for await (const [k, v] of db.iterator()) raw[c][k] = v;
    } finally {
      await db.close().catch(() => {});
    }
  }
  return raw;
}

/**
 * Assemble raw records ("!actors!id", "!actors.items!actorId.itemId", "!scenes.walls!sceneId.wallId"…)
 * into documents. Embedded collections replace the id arrays: actor.items = [itemDoc…].
 * Returns { actors: [], scenes: [], journal: [], playlists: [], folders: [], users: [] }.
 */
export function assemble(raw: RawRecords | null | undefined): AssembledCollections {
  const out: AssembledCollections = {};
  for (const [coll, records] of Object.entries(raw || {})) {
    const top = new Map<string, FoundryDoc>();
    const nested: Array<[string[], string[], FoundryDoc]> = []; // [collPath[], idPath[], doc]
    for (const [key, doc] of Object.entries(records || {})) {
      const m = /^!([^!]+)!(.+)$/.exec(key);
      if (!m || !doc || typeof doc !== 'object') continue;
      const cp = m[1].split('.');
      const ip = m[2].split('.');
      if (cp.length === 1) top.set(ip[0], doc as FoundryDoc);
      else nested.push([cp, ip, doc as FoundryDoc]);
    }
    // Index of every embedded doc by its full path, filled level by level.
    const byPath = new Map<string, FoundryDoc>();
    for (const [id, d] of top) byPath.set(`${cp0(coll)}/${id}`, d);
    nested.sort((a, b) => a[0].length - b[0].length);
    const children = new Map<string, FoundryDoc[]>(); // parentPath|field -> [docs]
    for (const [cp, ip, doc] of nested) {
      let parentPath = `${cp[0]}/${ip[0]}`;
      for (let i = 1; i < cp.length - 1; i++) parentPath += `/${cp[i]}/${ip[i]}`;
      const field = cp[cp.length - 1];
      const selfPath = `${parentPath}/${field}/${ip[ip.length - 1]}`;
      byPath.set(selfPath, doc);
      const k = `${parentPath}|${field}`;
      if (!children.has(k)) children.set(k, []);
      children.get(k)!.push(doc);
    }
    for (const [k, docs] of children) {
      const [parentPath, field] = k.split('|');
      const parent = byPath.get(parentPath);
      if (!parent) continue;
      const order: unknown[] = Array.isArray(parent[field]) ? parent[field] : [];
      const rank = new Map(order.map((id, i) => [id, i]));
      docs.sort((a, b) => (rank.get(a._id) ?? 1e9) - (rank.get(b._id) ?? 1e9) || (a.sort || 0) - (b.sort || 0));
      parent[field] = docs;
    }
    // Id arrays never filled (no embedded records) become empty arrays.
    for (const d of byPath.values()) {
      for (const f of ['items', 'effects', 'walls', 'lights', 'tokens', 'notes', 'levels', 'pages', 'sounds', 'tiles', 'drawings', 'sounds', 'regions']) {
        if (Array.isArray(d[f]) && d[f].some((x: unknown) => typeof x === 'string')) d[f] = d[f].filter((x: unknown) => x && typeof x === 'object');
      }
    }
    out[coll] = [...top.values()];
  }
  return out;
  function cp0(c: string): string {
    return c;
  }
}

/** Async read: copy → read → assemble → cleanup. */
export async function readWorld(worldPath: string, { collections = COLLECTIONS }: { collections?: string[] } = {}): Promise<FoundryWorld> {
  const meta = checkWorld(worldPath);
  const fingerprint = worldFingerprint(worldPath, collections);
  const tmp = copyCollections(worldPath, collections);
  try {
    const raw = await readRaw(tmp, collections);
    return { meta, path: worldPath, dataRoot: dataRootOf(worldPath), fingerprint, ...assemble(raw) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Node arguments for the dump child: the parent's own flags (process.execArgv), plus type stripping when this Node
 * does not strip types by default (Node < 22.18 needs --experimental-strip-types to run dump-child.ts).
 */
function childExecArgv(): string[] {
  // Code given with -e / -p (a parent started as `node -e …`) would run instead of the child script: dropped.
  const args: string[] = [];
  const src = process.execArgv;
  for (let i = 0; i < src.length; i++) {
    if (['-e', '--eval', '-p', '--print'].includes(src[i])) i++;
    else if (!/^--(eval|print)=/.test(src[i])) args.push(src[i]);
  }
  const stripping = (process.features as { typescript?: string | false }).typescript;
  if (!stripping && !args.includes('--experimental-strip-types')) args.push('--experimental-strip-types');
  return args;
}

/** Synchronous read (blocks): runs readWorld in a child Node process and returns its result. */
export function readWorldSync(worldPath: string, { collections = COLLECTIONS, timeout = 120000 }: { collections?: string[]; timeout?: number } = {}): FoundryWorld {
  checkWorld(worldPath);
  const outFile = path.join(os.tmpdir(), `sr-foundry-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync(process.execPath, [...childExecArgv(), path.join(HERE, 'dump-child.ts'), worldPath, outFile, collections.join(',')], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout,
      windowsHide: true,
    });
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown };
    const msg = String(e.stderr || e.message || err).trim().split('\n').pop();
    throw i18nError({ t: 'Could not read the Foundry world: {error}', params: { error: msg ?? '' } });
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/** Load an exploration dump ({actors,scenes,…}.json files of raw records) — used by tests and the CLI --dump. */
export function readDump(dir: string, worldPath: string = FALLBACK_WORLD): FoundryWorld {
  const raw: RawRecords = {};
  for (const c of COLLECTIONS) {
    try {
      raw[c] = JSON.parse(fs.readFileSync(path.join(dir, `${c}.json`), 'utf8'));
    } catch {
      raw[c] = {};
    }
  }
  let meta: WorldMeta = { id: path.basename(worldPath), title: path.basename(worldPath) };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(worldPath, 'world.json'), 'utf8'));
  } catch {}
  return { meta, path: worldPath, dataRoot: dataRootOf(worldPath), fingerprint: 'dump', ...assemble(raw) };
}
