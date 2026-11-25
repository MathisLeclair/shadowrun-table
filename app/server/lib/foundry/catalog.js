// Name lookup in the Chummer-derived catalog (data/catalog/*.json): English name → entry (nameFr, id, stats).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'catalog');
const FILES = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'qualities', 'powers', 'spells', 'programs', 'vehicles', 'lifestyles'];

export const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  for (const f of FILES) {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${f}.json`), 'utf8'));
    } catch {}
    const byName = new Map();
    for (const e of Array.isArray(list) ? list : []) {
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
export function findCatalog(name, files) {
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
export function frName(name, files) {
  const hit = findCatalog(name, files);
  return hit?.entry?.nameFr || name;
}
