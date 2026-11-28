// Magical traditions of data/catalog/traditions.json (built from Chummer traditions.xml by tools/build-catalog.ts).
// Used by the magic module (magic/setTradition), character creation approval and the Chummer import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTradition, parseDrainText, traditionFromDef, DRAIN_ATTRS, type TraditionDef } from '../../shared/magic.ts';
import type { ActorTradition, AttrKey, SpellCategoryKey } from '../../shared/types.ts';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog', 'traditions.json');

let cache: TraditionDef[] | null = null;
/** Every tradition of the catalog (empty when the file is missing). */
export function traditions(): TraditionDef[] {
  if (cache) return cache;
  try {
    const list: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(list) ? (list as TraditionDef[]).filter((t) => t && typeof t.name === 'string') : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Catalog tradition by id, name, legacy creator value or French name. */
export const traditionDef = (ref: string | null | undefined): TraditionDef | null => findTradition(traditions(), ref);

/** The ActorTradition for a reference (null when unknown). `drain` only counts for a tradition without one (Custom). */
export function actorTradition(ref: string | null | undefined, drain?: AttrKey | null): ActorTradition | null {
  const def = traditionDef(ref);
  return def ? traditionFromDef(def, drain) : null;
}

/** Fields of a .chum5 <tradition> element, read by the Chummer parser. */
export interface ChummerTraditionFields {
  sourceid?: string;
  name?: string;
  drain?: string;
  source?: string;
  page?: string;
  spirits?: Partial<Record<SpellCategoryKey, string>>;
}

/**
 * The tradition of a Chummer character: its own drain and spirits win (Chummer may customise them), the catalog fills
 * the French name and what is missing. Null for a technomancer stream or an empty element.
 */
export function chummerTradition(f: ChummerTraditionFields): ActorTradition | null {
  const name = String(f.name || '').trim();
  if (!name) return null;
  const def = traditionDef(f.sourceid) || traditionDef(name);
  const out: ActorTradition = def ? traditionFromDef(def) : { name, drain: null };
  if (!def) out.name = name;
  const drain = parseDrainText(f.drain);
  if (drain && DRAIN_ATTRS.includes(drain)) out.drain = drain;
  const spirits = Object.fromEntries(Object.entries(f.spirits || {}).filter(([, v]) => v && String(v).trim()));
  if (Object.keys(spirits).length) out.spirits = spirits;
  if (!def && f.source) out.source = f.source;
  if (!def && Number(f.page) > 0) out.page = Number(f.page);
  return out;
}
