// Spells catalog (data/catalog/spells.json, built from Chummer spells.xml): what an actor's spell does not store —
// descriptor (Direct / Indirect, Elemental, Area…) and damage type. Used by the magic module for combat spells.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpellCatalogInfo } from '../../shared/magic.ts';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog', 'spells.json');

type Entry = { id: string; name: string; nameFr?: string; stats?: { descriptor?: string; damage?: string } };
let byId: Map<string, Entry> | null = null;
let byName: Map<string, Entry> | null = null;
function load(): void {
  if (byId) return;
  byId = new Map();
  byName = new Map();
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Entry[];
    for (const e of Array.isArray(list) ? list : []) {
      if (!e?.id) continue;
      byId.set(e.id, e);
      for (const n of [e.name, e.nameFr]) if (n && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), e);
    }
  } catch {
    // no catalog: every spell uses the fallback profile
  }
}

/** Catalog descriptor and damage type of an actor's spell (by catalog id, then English / French name), or null. */
export function spellCatalogInfo(spell: { catalogId?: string; name?: string; nameEn?: string; nameFr?: string } | null | undefined): SpellCatalogInfo | null {
  if (!spell) return null;
  load();
  const e = (spell.catalogId && byId!.get(spell.catalogId)) || [spell.nameEn, spell.name, spell.nameFr].map((n) => (n ? byName!.get(n.toLowerCase()) : undefined)).find(Boolean);
  return e ? { descriptor: e.stats?.descriptor || '', damage: e.stats?.damage || '' } : null;
}
