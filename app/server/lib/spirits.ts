// Spirit types of data/catalog/spirits.json (built from Chummer critters.xml by tools/build-catalog.ts). Turned into
// actors by shared/magic.ts spiritStats(); used by the magic module (summoning).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpiritDef } from '../../shared/magic.ts';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog', 'spirits.json');

let cache: SpiritDef[] | null = null;
/** Every spirit type (empty when the file is missing). */
export function spiritDefs(): SpiritDef[] {
  if (cache) return cache;
  try {
    const list: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(list) ? (list as SpiritDef[]).filter((d) => d && typeof d.name === 'string' && d.attrs) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** A spirit type by id, English or French name (case-insensitive), or null. */
export function spiritDef(ref: string | null | undefined): SpiritDef | null {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return null;
  return spiritDefs().find((d) => d.id === ref || d.name.toLowerCase() === r || (d.nameFr || '').toLowerCase() === r) || null;
}
