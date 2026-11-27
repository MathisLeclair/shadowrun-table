// Foundry worlds uploaded as zips (the server may run on a VPS that cannot read the GM's PC).
// Layout per table: <table>/foundry/Data/worlds/<worldId>/… (+ any extra Data assets: Music/, img/, …),
// i.e. the same shape as a Foundry "Data" folder, so asset paths stored in the world resolve unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZipError, listZip, safeEntryPath, extractZip, dirSize } from '../zip.ts';
import { i18nError } from './messages.ts';
import type { WorldMeta } from './world.ts';

/** The table fields used here (server/lib/tables.js table object). */
export interface UploadTable {
  /** <table>/foundry */
  foundryDir: string;
  /** The table's data folder (free space check). */
  dir: string;
}
/** An uploaded world. */
export interface UploadedWorld {
  id: string;
  title: string;
  path: string;
  system?: string;
  coreVersion?: string;
  uploaded: true;
}
/** Zip entry fields read here (server/lib/zip.js listZip). */
interface ZipEntryInfo {
  name: string;
  isDir: boolean;
  size: number;
}

export const MAX_UNZIPPED = Number(process.env.SR_MAX_UNZIPPED_BYTES) || 6e9;

export const dataDirOf = (table: UploadTable): string => path.join(table.foundryDir, 'Data');

/** Worlds already uploaded for this table: [{ id, title, path, system, coreVersion, uploaded: true }]. */
export function uploadedWorlds(table: UploadTable): UploadedWorld[] {
  const root = path.join(dataDirOf(table), 'worlds');
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    return [];
  }
  const out: UploadedWorld[] = [];
  for (const d of dirs) {
    const p = path.join(root, d.name);
    try {
      const w = JSON.parse(fs.readFileSync(path.join(p, 'world.json'), 'utf8')) as WorldMeta;
      out.push({ id: w.id || d.name, title: w.title || d.name, path: p.split(path.sep).join('/'), system: w.system, coreVersion: w.coreVersion, uploaded: true });
    } catch {}
  }
  return out;
}

/** True when `p` is inside this table's uploaded Foundry data. */
export function isInsideUploads(table: UploadTable, p: unknown): boolean {
  const root = path.resolve(table.foundryDir);
  const r = path.resolve(String(p || ''));
  return r === root || r.toLowerCase().startsWith(root.toLowerCase() + path.sep);
}

function freeBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

function checkRoom(table: UploadTable, entries: ZipEntryInfo[]): number {
  const total = entries.reduce((s, e) => s + (e.isDir ? 0 : e.size), 0);
  if (total > MAX_UNZIPPED) throw i18nError({ t: 'Archive trop volumineuse une fois décompressée ({mb} Mo)', params: { mb: Math.round(total / 1e6) } }, ZipError, 413);
  const free = freeBytes(table.dir);
  if (total + 200e6 > free) throw i18nError({ t: 'Pas assez de place sur le serveur ({need} Mo nécessaires, {free} Mo libres)', params: { need: Math.round(total / 1e6), free: Math.round(free / 1e6) } }, ZipError, 507);
  return total;
}

const cleanId = (s: unknown): string => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);

/**
 * Install a zipped world. Accepted shapes: the world folder itself (world.json at the root or in one top folder),
 * or a whole Foundry Data folder (…/worlds/<id>/world.json + other asset folders, which are installed too).
 * Replaces a previous upload of the same world. Returns the world summary.
 */
export async function installWorldZip(table: UploadTable, zipFile: string): Promise<UploadedWorld> {
  const entries: ZipEntryInfo[] = listZip(zipFile);
  const paths = entries.map((e) => ({ e, rel: safeEntryPath(e.name) as string | null }));
  const bad = paths.find((p) => !p.rel);
  if (bad) throw i18nError({ t: 'Chemin interdit dans l’archive : « {path} »', params: { path: String(bad.e.name).slice(0, 120) } }, ZipError);
  const worldJson = paths
    .filter((p): p is { e: ZipEntryInfo; rel: string } => !p.e.isDir && (p.rel === 'world.json' || p.rel!.endsWith('/world.json')))
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)[0];
  if (!worldJson) throw i18nError({ t: 'Aucun world.json dans cette archive : zippe le dossier du monde (Data/worlds/<monde>)' }, ZipError);
  checkRoom(table, entries);
  const prefix = worldJson.rel.slice(0, -'world.json'.length); // '' | 'mon-monde/' | 'Data/worlds/mon-monde/'
  const m = /(?:^|\/)worlds\/([^/]+)\/$/.exec(prefix);
  const dataPrefix = m ? prefix.slice(0, prefix.length - `worlds/${m[1]}/`.length) : null; // whole Data folder zipped
  const staging = path.join(table.foundryDir, `.staging-${crypto.randomBytes(4).toString('hex')}`);
  const dataDir = dataDirOf(table);
  try {
    // 1. the world itself, into a staging folder
    await extractZip(zipFile, staging, { map: (rel: string) => (rel.startsWith(prefix) ? rel.slice(prefix.length) : null), maxTotal: MAX_UNZIPPED });
    let meta: WorldMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(staging, 'world.json'), 'utf8'));
    } catch {
      throw i18nError({ t: 'world.json illisible dans l’archive' }, ZipError);
    }
    if (!fs.existsSync(path.join(staging, 'data', 'actors'))) throw i18nError({ t: 'Le monde « {world} » n’a pas de base LevelDB (dossier data/actors) : Foundry v11 ou plus récent requis', params: { world: meta.title || '?' } }, ZipError);
    if (meta.system && meta.system !== 'shadowrun5e') throw i18nError({ t: 'Ce monde utilise le système « {system} », pas shadowrun5e', params: { system: meta.system } }, ZipError);
    // Asset paths inside the world reference "worlds/<folder name>/…": keep the folder name Foundry used.
    const id = cleanId(m ? m[1] : meta.id || (prefix ? prefix.split('/').filter(Boolean).pop() : '') || 'monde') || 'monde';
    const dest = path.join(dataDir, 'worlds', id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    fs.renameSync(staging, dest);
    // 2. a whole Data folder: the other asset folders too
    if (dataPrefix !== null) {
      await extractZip(zipFile, dataDir, {
        map: (rel: string) => (rel.startsWith(dataPrefix) && !rel.startsWith(prefix) && !rel.slice(dataPrefix.length).startsWith('worlds/') ? rel.slice(dataPrefix.length) : null),
        maxTotal: MAX_UNZIPPED,
      });
    }
    return { id, title: meta.title || id, path: dest.split(path.sep).join('/'), system: meta.system, coreVersion: meta.coreVersion, uploaded: true };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Install extra Foundry Data assets (Music/, img/, modules/…): a zip of (part of) the Data folder. */
export async function installDataZip(table: UploadTable, zipFile: string): Promise<{ files: number; bytes: number }> {
  const entries: ZipEntryInfo[] = listZip(zipFile);
  checkRoom(table, entries);
  const rels = entries.map((e) => safeEntryPath(e.name) as string | null);
  const bad = rels.findIndex((r) => !r);
  if (bad >= 0) throw i18nError({ t: 'Chemin interdit dans l’archive : « {path} »', params: { path: String(entries[bad].name).slice(0, 120) } }, ZipError);
  // A zip of the "Data" folder itself: strip that top folder.
  const strip = rels.length && rels.every((r) => r === 'Data' || r!.startsWith('Data/')) ? 'Data/' : '';
  const r = await extractZip(zipFile, dataDirOf(table), { map: (rel: string) => (strip ? (rel.startsWith(strip) ? rel.slice(strip.length) || null : null) : rel), maxTotal: MAX_UNZIPPED });
  return { files: r.files, bytes: r.bytes };
}

/** Disk usage of the uploaded Foundry data. */
export const uploadsSize = (table: UploadTable): number => dirSize(table.foundryDir);

export function removeUploads(table: UploadTable): void {
  fs.rmSync(table.foundryDir, { recursive: true, force: true, maxRetries: 3 });
}
