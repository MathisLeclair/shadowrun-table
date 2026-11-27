// Rulebook references of actor items (item.source / item.page, ARCHITECTURE.md « Rulebooks » › « References everywhere »).
// Catalog entries all carry { source, page }; actor items get them at creation (catalogToItem, shop, training, chargen,
// imports) and this module fills the ones still missing: catalog id › Foundry / Chummer source › « CODE page » in the
// notes › English / French name in the list's catalogs. Global read-only catalog data (shared by every table).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEM_CATALOGS, SUB_CATALOGS, REF_LISTS, itemRef, normRef, refFromNotes, parseRefText, complexFormRef, skillRef } from '../../shared/bookrefs.ts';
import { SUB_LISTS } from '../../client/modules/sheet/sheet-data.ts';

/** A rulebook reference: book code (« SR5 ») and printed page. */
export interface BookRef {
  source: string;
  page?: number;
}
/** Any actor item (or nested item): read loosely, only the name / catalog / reference fields matter here. */
type RefItem = Record<string, any>;
interface RefOptions {
  /** The import's own source text (« SR5 435 »). */
  sourceText?: string;
}
// shared/bookrefs.js is plain JS (shared with the browser): typed here for the server.
const normRefT = normRef as (source: unknown, page: unknown) => BookRef | null;
const itemRefT = itemRef as (item: RefItem) => BookRef | null;
const refFromNotesT = refFromNotes as (notes: unknown, codes: Set<string>) => BookRef | null;
const parseRefTextT = parseRefText as (text: string) => BookRef | null;
const complexFormRefT = complexFormRef as (item: RefItem) => BookRef | null;
const skillRefT = skillRef as (skill: string) => BookRef | null;
const ITEM_CATALOGS_T = ITEM_CATALOGS as Record<string, string[] | undefined>;
const SUB_CATALOGS_T = SUB_CATALOGS as Record<string, string[] | undefined>;
const SUB_LISTS_T = SUB_LISTS as Record<string, string | undefined>;

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const FILES = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'qualities', 'powers', 'spells', 'programs', 'vehicles', 'lifestyles',
  'lifestylequalities', 'accessories', 'armormods', 'vehiclemods', 'martialarts'];

export const fold = (s: unknown): string =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let cache: { byId: Map<string, BookRef>; byName: Record<string, Map<string, BookRef>>; codes: Set<string> } | null = null;
/** { byId: Map(id → { source, page }), byName: { [file]: Map(folded EN / FR name → ref) }, codes: Set } */
function load() {
  if (cache) return cache;
  const byId = new Map<string, BookRef>();
  const byName: Record<string, Map<string, BookRef>> = {};
  const codes = new Set<string>();
  // e: a catalog entry (data/catalog/*.json, generated)
  const add = (file: string, e: any) => {
    const r = normRefT(e?.source, e?.page);
    if (!r) return;
    codes.add(r.source);
    if (e.id) byId.set(String(e.id).toLowerCase(), r);
    const m = (byName[file] ||= new Map());
    for (const n of [e.name, e.nameFr]) {
      const k = fold(n);
      if (k && !m.has(k)) m.set(k, r);
    }
  };
  for (const f of FILES) {
    let list: any[] = []; // catalog file (generated JSON)
    try {
      list = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${f}.json`), 'utf8'));
    } catch {
      list = [];
    }
    for (const e of Array.isArray(list) ? list : []) {
      add(f, e);
      if (f === 'martialarts') for (const tq of [...(e.stats?.techniques || []), ...(e.techniques || [])]) add('techniques', tq);
    }
  }
  cache = { byId, byName, codes };
  return cache;
}

/** Catalog reference of a catalog id (any catalog file, techniques included): { source, page } or null. */
export function catalogRef(catalogId: unknown): BookRef | null {
  if (!catalogId) return null;
  return load().byId.get(String(catalogId).toLowerCase()) || null;
}

/**
 * Name tries: as stored, then without a trailing « (…) » / « [×2] », then without a rating suffix (« R4 », « Rating 3 »,
 * « indice 2 », « 2 »): « Cyberyeux 2 (vision nocturne) » → « Cyberyeux 2 » → « Cyberyeux ».
 */
function nameTries(name: unknown): string[] {
  const out = [String(name || '').trim()];
  const steps = [(n: string) => n.replace(/\s*[([][^)\]]*[)\]]\s*$/, ''), (n: string) => n.replace(/\s+(?:r|rating|indice)?\s*\d+$/i, '')];
  let n = out[0];
  for (const f of [...steps, ...steps]) {
    const next = f(n).trim();
    if (next && next !== n) out.push((n = next));
  }
  return out;
}

/**
 * Reference of an item of `list` (or of the nested list `sub` of `list`): { source, page } or null.
 * opts.sourceText = the import's own source (« SR5 435 », Foundry system.description.source).
 */
export function resolveItemRef(list: string, item: RefItem | null | undefined, sub: string | null = null, opts: RefOptions = {}): BookRef | null {
  if (!item || typeof item !== 'object') return null;
  const own = itemRefT(item);
  if (own) return own;
  const c = load();
  const byCat = catalogRef(item.catalogId);
  if (byCat) return byCat;
  const fromText = opts.sourceText ? parseRefTextT(opts.sourceText) : null;
  if (fromText) return fromText;
  const fromNotes = refFromNotesT(item.notes, c.codes);
  if (fromNotes) return fromNotes;
  if (list === 'complexForms') return complexFormRefT(item);
  const files = sub ? SUB_CATALOGS_T[`${list}.${sub}`] : ITEM_CATALOGS_T[list];
  for (const n of [item.name, item.nameFr, item._en, list === 'lifestyles' ? item.base : null]) {
    for (const tr of nameTries(n)) {
      const k = fold(tr);
      if (!k) continue;
      for (const f of files || []) {
        const r = c.byName[f]?.get(k);
        if (r) return r;
      }
    }
  }
  // Unarmed attack of the imports (« Mains nues », « Unarmed Attack »): the Unarmed Combat skill.
  if (list === 'weapons' && item.skill === 'unarmed_combat' && /^(mains nues|unarmed(?: attack| strike)?|poings?)$/i.test(String(item.name || '').trim())) return skillRefT('unarmed_combat');
  return null;
}

/** Set item.source / item.page when missing and resolvable. Returns true when the item changed. */
export function fillItemRef(list: string, item: RefItem | null | undefined, sub: string | null = null, opts: RefOptions = {}): boolean {
  if (!item || typeof item !== 'object' || itemRefT(item)) return false;
  const r = resolveItemRef(list, item, sub, opts);
  if (!r) return false;
  item.source = r.source;
  if (r.page) item.page = r.page;
  else delete item.page;
  return true;
}

/**
 * Fill the references of every item of an actor / bestiary template (and of their nested lists) — idempotent: items that
 * already have a source are never touched. opts.sources = { [itemId]: 'SR5 435' } (import's own source per item).
 * Returns the number of items filled.
 */
export function fillActorRefs(actor: RefItem | null | undefined, opts: { sources?: Record<string, string> } = {}): number {
  if (!actor || typeof actor !== 'object') return 0;
  const src = opts.sources || {};
  let n = 0;
  for (const list of REF_LISTS as string[]) {
    const arr = actor[list];
    if (!Array.isArray(arr)) continue;
    const sub = SUB_LISTS_T[list];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      if (fillItemRef(list, it, null, { sourceText: src[it.id] })) n++;
      if (sub && Array.isArray(it[sub])) for (const x of it[sub]) if (fillItemRef(list, x, sub, { sourceText: src[x?.id] })) n++;
    }
  }
  return n;
}
