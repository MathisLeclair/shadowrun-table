// Rulebook references of actor items (item.source / item.page, ARCHITECTURE.md « Rulebooks » › « References everywhere »).
// Catalog entries all carry { source, page }; actor items get them at creation (catalogToItem, shop, training, chargen,
// imports) and this module fills the ones still missing: catalog id › Foundry / Chummer source › « CODE page » in the
// notes › English / French name in the list's catalogs. Global read-only catalog data (shared by every table).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEM_CATALOGS, SUB_CATALOGS, REF_LISTS, itemRef, normRef, refFromNotes, parseRefText, complexFormRef, skillRef } from '../../shared/bookrefs.js';
import { SUB_LISTS } from '../../client/modules/sheet/sheet-data.js';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const FILES = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'qualities', 'powers', 'spells', 'programs', 'vehicles', 'lifestyles',
  'lifestylequalities', 'accessories', 'armormods', 'vehiclemods', 'martialarts'];

export const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let cache = null;
/** { byId: Map(id → { source, page }), byName: { [file]: Map(folded EN / FR name → ref) }, codes: Set } */
function load() {
  if (cache) return cache;
  const byId = new Map();
  const byName = {};
  const codes = new Set();
  const add = (file, e) => {
    const r = normRef(e?.source, e?.page);
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
    let list = [];
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
export function catalogRef(catalogId) {
  if (!catalogId) return null;
  return load().byId.get(String(catalogId).toLowerCase()) || null;
}

/**
 * Name tries: as stored, then without a trailing « (…) » / « [×2] », then without a rating suffix (« R4 », « Rating 3 »,
 * « indice 2 », « 2 »): « Cyberyeux 2 (vision nocturne) » → « Cyberyeux 2 » → « Cyberyeux ».
 */
function nameTries(name) {
  const out = [String(name || '').trim()];
  const steps = [(n) => n.replace(/\s*[([][^)\]]*[)\]]\s*$/, ''), (n) => n.replace(/\s+(?:r|rating|indice)?\s*\d+$/i, '')];
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
export function resolveItemRef(list, item, sub = null, opts = {}) {
  if (!item || typeof item !== 'object') return null;
  const own = itemRef(item);
  if (own) return own;
  const c = load();
  const byCat = catalogRef(item.catalogId);
  if (byCat) return byCat;
  const fromText = opts.sourceText ? parseRefText(opts.sourceText) : null;
  if (fromText) return fromText;
  const fromNotes = refFromNotes(item.notes, c.codes);
  if (fromNotes) return fromNotes;
  if (list === 'complexForms') return complexFormRef(item);
  const files = sub ? SUB_CATALOGS[`${list}.${sub}`] : ITEM_CATALOGS[list];
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
  if (list === 'weapons' && item.skill === 'unarmed_combat' && /^(mains nues|unarmed(?: attack| strike)?|poings?)$/i.test(String(item.name || '').trim())) return skillRef('unarmed_combat');
  return null;
}

/** Set item.source / item.page when missing and resolvable. Returns true when the item changed. */
export function fillItemRef(list, item, sub = null, opts = {}) {
  if (!item || typeof item !== 'object' || itemRef(item)) return false;
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
export function fillActorRefs(actor, opts = {}) {
  if (!actor || typeof actor !== 'object') return 0;
  const src = opts.sources || {};
  let n = 0;
  for (const list of REF_LISTS) {
    const arr = actor[list];
    if (!Array.isArray(arr)) continue;
    const sub = SUB_LISTS[list];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      if (fillItemRef(list, it, null, { sourceText: src[it.id] })) n++;
      if (sub && Array.isArray(it[sub])) for (const x of it[sub]) if (fillItemRef(list, x, sub, { sourceText: src[x?.id] })) n++;
    }
  }
  return n;
}
