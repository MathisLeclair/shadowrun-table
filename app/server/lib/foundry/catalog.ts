// Name lookup in the Chummer-derived catalog (data/catalog/*.json): English name → entry (nameFr, id, stats).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogFile, CatalogItem, Formula } from '../../../shared/types.ts';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'catalog');
const FILES: CatalogFile[] = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'qualities', 'powers', 'spells', 'programs', 'vehicles', 'lifestyles', 'lifestylequalities', 'accessories', 'armormods', 'vehiclemods', 'martialarts'];

/** The `stats` fields the Foundry converters read (any catalog file: they are optional everywhere). */
export interface CatalogHitStats {
  skill?: string;
  damage?: string;
  mode?: string;
  ammo?: string;
  accuracy?: Formula;
  rc?: number;
  mount?: unknown;
  mounts?: unknown;
  karma?: number;
  capacity?: unknown;
  multiplier?: number;
  baseOnly?: boolean;
  lp?: number;
}
/** A catalog entry as read by the converters (older files also carry `mounts` / `capacity` at the top level). */
export type CatalogHitEntry = Omit<CatalogItem, 'stats'> & { stats?: CatalogHitStats; mounts?: unknown; capacity?: unknown };
/** findCatalog() result. */
export interface CatalogHit {
  file: CatalogFile;
  entry: CatalogHitEntry;
}

export const norm = (s: unknown): string =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let cache: Partial<Record<CatalogFile, Map<string, CatalogHitEntry>>> | null = null;

function load(): Partial<Record<CatalogFile, Map<string, CatalogHitEntry>>> {
  if (cache) return cache;
  cache = {};
  for (const f of FILES) {
    let list: unknown = [];
    try {
      list = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${f}.json`), 'utf8'));
    } catch {}
    const byName = new Map<string, CatalogHitEntry>();
    for (const e of (Array.isArray(list) ? list : []) as CatalogHitEntry[]) {
      const k = norm(e.name);
      if (k && !byName.has(k)) byName.set(k, e);
    }
    cache[f] = byName;
  }
  return cache;
}

/**
 * Find a catalog entry by English name in one or several catalogs.
 * Tries the exact name, then without a parenthesised suffix ("Knife (Survival Kit)" → "Knife").
 */
export function findCatalog(name: unknown, files: CatalogFile | CatalogFile[]): CatalogHit | null {
  const c = load();
  const list = Array.isArray(files) ? files : [files];
  const tries = [norm(name), norm(String(name || '').replace(/\s*\([^)]*\)\s*$/, '')), norm(String(name || '').replace(/^(ammo|grenade|minigrenade)\s*:\s*/i, ''))];
  for (const t of tries) {
    if (!t) continue;
    for (const f of list) {
      const e = c[f]?.get(t);
      if (e) return { file: f, entry: e };
    }
  }
  return null;
}

/** French display name for an English catalog name (falls back to the original). */
export function frName(name: string, files: CatalogFile | CatalogFile[]): string {
  const hit = findCatalog(name, files);
  return hit?.entry?.nameFr || name;
}
