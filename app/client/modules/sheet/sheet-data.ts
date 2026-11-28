// Pure helpers for actors / character sheets, shared by the characters server module and the sheet UI.
// IMPORTANT: only relative imports of pure modules here (this file is loaded both by Node and by the browser).
// Labels are English UI keys here, rendered with t(…) by the UI. Stored values (metatypes, health statuses) stay French
// for save compatibility and are translated where they are shown.
import { normalizeInventory } from './inventory.ts';
import type { MakeId, RawData } from './inventory.ts';
import type { Accessory, ActorType, Armor, ArmorMod, HealthStatus, ItemListName, SubListName, Vehicle, Weapon } from '../../../shared/types.ts';

export type { MakeId, RawData };
/** Catalog entry (data/catalog/<name>.json) as read here: fields vary by catalog file and version, so it is read loosely. */
export type CatalogEntryData = RawData;
/** An actor list item built from a catalog entry (shape depends on the list). */
export type BuiltItem = Record<string, RawData>;
/** catalogToItem / subFromCatalog result: target list, nested list for upgrades, item. */
export interface ItemFromCatalog {
  list: ItemListName;
  sub?: SubListName;
  item: BuiltItem;
}

/** Marker for the i18n checker (UI keys rendered with t() by the UI). */
const tk = (s: string): string => s;

/** Item lists of an Actor that can be edited with actor/addItem, actor/updateItem, actor/removeItem. */
export const ITEM_LISTS: ItemListName[] = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'contacts', 'sins', 'qualities', 'powers', 'spells', 'knowledge', 'skills', 'complexForms', 'skillGroups', 'lifestyles', 'martialArts'];

export const LIST_LABELS: Record<ItemListName, string> = {
  weapons: tk('Weapons'), armor: tk('pl::Armor'), augmentations: tk('Augmentations'), gear: tk('Gear'), vehicles: tk('Vehicles'), contacts: tk('Contacts'),
  sins: tk('SIN'), qualities: tk('Qualities'), powers: tk('Adept Powers'), spells: tk('Spells'), knowledge: tk('pl::Knowledge'), skills: tk('Skills'),
  complexForms: tk('Complex Forms'), skillGroups: tk('Skill Groups'), lifestyles: tk('Lifestyles'), martialArts: tk('Martial arts'),
};

/** Nested item list of each list item (actor/addSubItem, updateSubItem, removeSubItem): weapon accessories, armor/vehicle mods… */
export const SUB_LISTS: Partial<Record<ItemListName, SubListName>> = { weapons: 'accessories', armor: 'mods', vehicles: 'mods', lifestyles: 'qualities', martialArts: 'techniques' };
export const SUB_LABELS: Record<SubListName, string> = { accessories: tk('Accessories'), mods: tk('Modifications'), qualities: tk('Lifestyle options'), techniques: tk('martial::Techniques') };

/** Chummer base lifestyles (stored in English) → French display keys and SR5/RF base cost per month. */
export const LIFESTYLE_BASES: Record<string, { label: string; cost: number }> = {
  Street: { label: tk('Street'), cost: 0 }, Squatter: { label: tk('Squatter'), cost: 500 }, Low: { label: tk('Low'), cost: 2000 },
  Medium: { label: tk('Medium'), cost: 5000 }, High: { label: tk('High'), cost: 10000 }, Luxury: { label: tk('Luxury'), cost: 100000 },
  'Bolt Hole': { label: tk('Bolt Hole'), cost: 1000 }, Traveler: { label: tk('Traveler'), cost: 3000 }, Commercial: { label: tk('Commercial'), cost: 8000 },
  Hospitalized: { label: tk('Hospitalized'), cost: 500 },
};
const LIFESTYLE_WORDS: [RegExp, string][] = [
  [/luxe|luxu|luxury/i, 'Luxury'], [/haut|élevé|eleve|high/i, 'High'], [/moyen|middle|medium/i, 'Medium'], [/bas\b|low/i, 'Low'], [/squat/i, 'Squatter'],
  [/\brue\b|street/i, 'Street'], [/planque|bolt.?hole|trou à rat/i, 'Bolt Hole'], [/nomade|voyageur|traveler/i, 'Traveler'], [/commercial/i, 'Commercial'], [/hospital/i, 'Hospitalized'],
];
/** Guess the Chummer base lifestyle from a free name ("Best Home (Moyen)" → 'Medium'), or ''. */
export function guessLifestyleBase(name: unknown): string {
  const s = String(name || '');
  for (const [re, base] of LIFESTYLE_WORDS) if (re.test(s)) return base;
  return '';
}

/** Total bonus of a weapon's accessories: { accuracy, rc, dicePool, smartgun }. RC of a same `rcGroup` does not stack (best one). */
export function weaponMods(w: Partial<Weapon> | null | undefined): { accuracy: number; rc: number; dicePool: number; smartgun: boolean } {
  let accuracy = 0;
  let rc = 0;
  let dicePool = 0;
  let smartgun = false;
  const groups: Record<number, number> = {};
  for (const a of Array.isArray(w?.accessories) ? w.accessories : []) {
    if (!a || typeof a !== 'object' || a.equipped === false) continue;
    const e: NonNullable<Accessory['effects']> = a.effects && typeof a.effects === 'object' ? a.effects : {};
    if (e.smartgun) smartgun = true;
    accuracy += num(e.accuracy);
    dicePool += num(e.dicePool);
    const r = num(e.rc);
    if (e.rcGroup) groups[e.rcGroup] = Math.max(groups[e.rcGroup] || 0, r);
    else rc += r;
  }
  for (const v of Object.values(groups)) rc += v;
  return { accuracy, rc, dicePool, smartgun };
}

/** Armor modifications: { used, total (capacity; a negative-capacity mod like YNT Softweave adds room), bonus (armor points added) }. */
export function armorMods(ar: Partial<Armor> | null | undefined): { used: number; total: number; bonus: number } {
  let used = 0;
  let extra = 0;
  let bonus = 0;
  for (const m of Array.isArray(ar?.mods) ? ar.mods : []) {
    if (!m || typeof m !== 'object' || m.equipped === false) continue;
    const c = num(m.capacity);
    if (c >= 0) used += c;
    else extra -= c;
    bonus += num(m.effects?.armor);
  }
  return { used: Math.round(used * 100) / 100, total: Math.round((num(ar?.capacity) + extra) * 100) / 100, bonus };
}

/** Vehicle modifications: total slots used. */
export function vehicleSlots(v: Partial<Vehicle> | null | undefined): number {
  return (Array.isArray(v?.mods) ? v.mods : []).reduce((s, m) => s + (m && !m.included ? num(m.slots) : 0), 0);
}

/** R5 mod categories with their own slot pool on vehicles (drones: one pool) → French display keys. */
export const VEHICLE_MOD_CATEGORIES: Record<string, string> = {
  Powertrain: tk('Powertrain'), Protection: tk('Protection'), Weapons: tk('Weapons'), Body: tk('vehicle::Body'), Electromagnetic: tk('Electromagnetic'), Cosmetic: tk('Cosmetic'),
};
/** Slots used per R5 category pool (non built-in mods of those categories): { Protection: 6, Body: 3 }. */
export function vehicleSlotsByCategory(v: Partial<Vehicle> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of Array.isArray(v?.mods) ? v.mods : []) {
    if (!m || m.included || !VEHICLE_MOD_CATEGORIES[m.category] || !num(m.slots)) continue;
    out[m.category] = (out[m.category] || 0) + num(m.slots);
  }
  return out;
}

/** Legacy single `actor.lifestyle` ({ name, monthlyCost, monthsPaid }) → one lifestyles[] entry. */
export function legacyLifestyle(ls: { name?: string; monthlyCost?: unknown; monthsPaid?: unknown; chummerGuid?: string }, makeId: MakeId): BuiltItem {
  const base = guessLifestyleBase(ls.name) || 'Medium';
  const cost = LIFESTYLE_BASES[base]?.cost || 0; // fixed per level; the old total rent is kept in the notes
  const old = Math.max(0, Math.round(num(ls.monthlyCost, cost)));
  return {
    id: makeId('ls'), name: String(ls.name || base).slice(0, 120), base, baseCost: cost, monthsPaid: Math.max(0, Math.round(num(ls.monthsPaid))), primary: true,
    qualities: [], monthlyCost: cost, notes: old !== cost ? `Ancien loyer : ${old} ¥` : '', ...(ls.chummerGuid ? { chummerGuid: ls.chummerGuid } : {}),
  };
}

/** Fields a player may change on items of their own actor. */
export const PLAYER_ITEM_FIELDS: Partial<Record<ItemListName, string[]>> = {
  armor: ['equipped', 'location'],
  gear: ['qty', 'notes', 'active', 'location'],
  contacts: ['notes'],
  // ammoLoaded / ammoLeft (legacy): lower only — rounds come back with weapon/reload.
  weapons: ['notes', 'equipped', 'location', 'ammoLoaded', 'ammoLeft'],
};

/** Top-level actor keys a player may change on their own actor. */
export const PLAYER_ACTOR_KEYS: string[] = ['condition', 'edge', 'notes', 'bio', 'portrait', 'color', 'concept'];

/** Nested objects merged one level deep by actor/update. */
export const MERGE_KEYS: string[] = ['attributes', 'augmented', 'initiative', 'monitors', 'condition', 'edge', 'matrix', 'npc', 'vision'];

/** Metatype names (English, French, imports) → stored metatype value (French, kept for save compatibility). */
export const METATYPE_FR: Record<string, string> = { Human: 'Humain', Elf: 'Elfe', Dwarf: 'Nain', Ork: 'Ork', Troll: 'Troll', Humain: 'Humain', Elfe: 'Elfe', Nain: 'Nain', Orc: 'Ork', Orque: 'Ork' };

export const KNOWLEDGE_TYPES: Record<string, string> = { street: tk('Street'), academic: tk('Academic'), professional: tk('Professional'), interest: tk('Interest'), language: tk('Language') };

/** Linked attribute of a knowledge skill (SR5: street/interest → INT, academic/professional → LOG, language → INT). */
export function knowledgeAttr(type: unknown): 'LOG' | 'INT' {
  return type === 'academic' || type === 'professional' ? 'LOG' : 'INT';
}

/** Map a Chummer weapon category / useskill to an SR5 skill id (see shared/sr5.js SKILLS). */
export function categoryToSkill(category: unknown = '', useskill: unknown = ''): string {
  const u = String(useskill || '').toLowerCase();
  const map: Record<string, string> = {
    'unarmed combat': 'unarmed_combat', blades: 'blades', clubs: 'clubs', pistols: 'pistols', automatics: 'automatics', longarms: 'longarms',
    'heavy weapons': 'heavy_weapons', 'throwing weapons': 'throwing_weapons', archery: 'archery', 'exotic ranged weapon': 'exotic_weapon',
    'exotic melee weapon': 'exotic_weapon', gunnery: 'gunnery',
  };
  if (u && map[u]) return map[u];
  const c = String(category || '').toLowerCase();
  if (/blade|sword|knife|knives/.test(c)) return 'blades';
  if (/club|improvised|stun baton|staff/.test(c)) return 'clubs';
  if (/unarmed|cyberweapon|cyber weapon/.test(c)) return 'unarmed_combat';
  if (/taser|hold-out|holdout|light pistol|heavy pistol|machine pistol|pistol/.test(c)) return 'pistols';
  if (/submachine|smg|assault rifle|carbine/.test(c)) return 'automatics';
  if (/shotgun|sniper|sporting|rifle/.test(c)) return 'longarms';
  if (/machine gun|lmg|mmg|hmg|cannon|launcher|missile|grenade launcher/.test(c)) return 'heavy_weapons';
  if (/bow/.test(c)) return 'archery';
  if (/crossbow/.test(c)) return 'archery';
  if (/throw|gear|grenade/.test(c)) return 'throwing_weapons';
  if (/exotic/.test(c)) return 'exotic_weapon';
  return 'exotic_weapon';
}

export const MELEE_SKILLS: string[] = ['blades', 'clubs', 'unarmed_combat'];

/** Evaluate a small Chummer formula like "Rating * 0.1 + 0.1" (digits/operators only, no code). */
export function evalFormula(expr: unknown, rating: unknown = 1): number | null {
  if (typeof expr === 'number') return expr;
  if (expr === null || expr === undefined || expr === '') return null;
  let s = String(expr)
    .replace(/\{?Rating\}?/gi, String(Number(rating) || 0))
    .replace(/number\(([^)]*)\)/gi, '($1 ? 1 : 0)')
    .replace(/FixedValues\(([^)]*)\)/gi, (m, list: string) => {
      const vals = list.replace(/[[\]]/g, '').split(',').map((v) => v.trim());
      return vals[Math.max(0, Math.min(vals.length - 1, (Number(rating) || 1) - 1))] || '0';
    });
  if (!/^[\d.+\-*/()\s<>=?:]+$/.test(s)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${s});`)();
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  } catch {
    return null;
  }
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Convert a catalog entry (data/catalog/<name>.json, see ARCHITECTURE.md) into an Actor list item.
 * Returns { list, item } or null. Tolerant to missing stats (catalogs may evolve).
 */
export function catalogToItem(catalog: string, entry: CatalogEntryData, rating?: number | null): ItemFromCatalog | null {
  if (!entry) return null;
  const s = entry.stats || {};
  const name = entry.nameFr || entry.name || 'Item';
  const r = rating ?? (entry.rating && entry.rating.max ? entry.rating.min || 1 : undefined);
  const base = { name, catalogId: entry.id, ...(r ? { rating: r } : {}) };
  switch (catalog) {
    case 'weapons': {
      const skill = s.skill && !/\s/.test(s.skill) ? s.skill : categoryToSkill(entry.category, s.useskill || s.skill);
      const melee = String(s.type || s.kind || '').toLowerCase() === 'melee' || MELEE_SKILLS.includes(skill);
      return {
        list: 'weapons',
        item: {
          ...base, rating: undefined, category: entry.categoryFr || entry.category || '', kind: melee ? 'melee' : 'ranged', skill,
          accuracy: s.accuracy ?? s.acc ?? '', damage: s.damage ?? s.dv ?? '', ap: s.ap ?? 0, mode: s.mode ?? '', rc: s.rc ?? 0,
          ammo: s.ammo ?? '', reach: num(s.reach, 0),
          ...(Array.isArray(s.mounts) && s.mounts.length ? { mounts: s.mounts } : {}),
          // Built-in accessories (smartgun system, silencer…) come with the weapon.
          ...(Array.isArray(s.included) && s.included.length
            ? { accessories: s.included.filter((x: RawData) => x && x.name).map((x: RawData) => ({ name: x.name, ...(x.nameFr ? { nameFr: x.nameFr } : {}), ...(x.id ? { catalogId: x.id } : {}), mount: 'Internal', cost: 0, included: true, effects: /smartgun/i.test(x.name) ? { smartgun: true } : {} })) }
            : {}),
        },
      };
    }
    case 'armor': {
      const raw = s.armor ?? s.rating ?? entry.armor ?? 0;
      const stack = s.stack === true || String(raw).trim().startsWith('+') || /helmet|shield|casque|bouclier/i.test(`${entry.name} ${entry.category || ''}`);
      return { list: 'armor', item: { ...base, rating: Math.abs(num(String(raw).replace('+', ''), 0)), equipped: false, stack, ...(num(s.capacity) ? { capacity: num(s.capacity) } : {}) } };
    }
    case 'cyberware':
    case 'bioware': {
      const ess = evalFormula(entry.essence ?? s.essence ?? s.ess ?? 0, r || 1);
      return { list: 'augmentations', item: { ...base, kind: catalog, grade: 'standard', essence: ess ?? 0, category: entry.categoryFr || entry.category || '' } };
    }
    case 'vehicles':
      return {
        list: 'vehicles',
        item: {
          ...base, handling: s.handling ?? '', speed: s.speed ?? '', accel: s.accel ?? '', body: num(s.body), armor: num(s.armor),
          pilot: num(s.pilot), sensor: num(s.sensor), seats: num(s.seats),
        },
      };
    case 'qualities': {
      const karma = num(s.karma ?? entry.karma ?? entry.cost, 0);
      const positive = s.positive !== undefined ? !!s.positive : !/negative|négative/i.test(entry.category || '') && karma >= 0;
      return { list: 'qualities', item: { name, catalogId: entry.id, karma: Math.abs(karma) * (positive ? 1 : -1), positive } };
    }
    case 'powers':
      return { list: 'powers', item: { name, catalogId: entry.id, level: s.levels ? 1 : undefined, pp: num(s.points ?? s.pp ?? entry.cost, 0) } };
    case 'spells':
      return {
        list: 'spells',
        item: { name, catalogId: entry.id, category: entry.categoryFr || entry.category || s.category || '', type: s.type || '', range: s.range || '', duration: s.duration || '', drain: s.drain || s.dv || '' },
      };
    case 'lifestyles': {
      const b = Object.keys(LIFESTYLE_BASES).find((k) => String(entry.name || '').startsWith(k)) || entry.name || 'Medium';
      const cost = num(entry.cost, LIFESTYLE_BASES[b]?.cost || 0);
      return { list: 'lifestyles', item: { name, base: b, catalogId: entry.id, baseCost: cost, monthsPaid: 0, qualities: [], monthlyCost: cost } };
    }
    case 'martialarts': // techniques are chosen one by one (actor/addSubItem)
      return { list: 'martialArts', item: { name, catalogId: entry.id, rating: 1, techniques: [] } };
    default: {
      const sub = subFromCatalog(catalog, entry, r);
      if (sub) return sub;
      return { list: 'gear', item: { ...base, category: entry.categoryFr || entry.category || '', qty: 1, ...(entry.category === 'Foci' ? { bonded: false } : {}) } };
    }
  }
}

const field = (entry: CatalogEntryData, k: string): RawData => entry?.stats?.[k] ?? entry?.[k];

/**
 * Catalog entry of a nested list (lifestylequalities, accessories, armormods, vehiclemods, techniques) → { list: null, sub, item }.
 * Sub-items keep the English `name` and the French `nameFr` (display with itemName()). Returns null for other catalogs.
 */
export function subFromCatalog(catalog: string, entry: CatalogEntryData, rating?: number | null): ItemFromCatalog | null {
  if (!entry) return null;
  const r = rating ?? (entry.rating && entry.rating.max ? entry.rating.min || 1 : undefined);
  const head = { catalogId: entry.id, name: entry.name || entry.nameFr || 'Option', ...(entry.nameFr ? { nameFr: entry.nameFr } : {}) };
  const fromFormula = entry.costFormula ? evalFormula(entry.costFormula, r || 1) : null;
  const cost = field(entry, 'targetCost') ? 0 : fromFormula ?? num(entry.cost);
  switch (catalog) {
    case 'lifestylequalities': {
      const mult = field(entry, 'multiplier') ?? field(entry, 'multiplierbaseonly');
      return {
        list: 'lifestyles', sub: 'qualities',
        item: { ...head, category: entry.category || '', cost, multiplier: num(mult), ...(field(entry, 'baseOnly') ? { baseOnly: true } : {}), ...(field(entry, 'lp') != null ? { lp: num(field(entry, 'lp')) } : {}) },
      };
    }
    case 'accessories': {
      const effects: NonNullable<Accessory['effects']> = {};
      const acc = num(field(entry, 'accuracy'));
      const rc = num(field(entry, 'rc'));
      if (field(entry, 'smartgun') || /smartgun/i.test(entry.name || '')) effects.smartgun = true;
      else if (acc) effects.accuracy = acc;
      if (rc) effects.rc = rc;
      if (num(field(entry, 'rcgroup') ?? field(entry, 'rcGroup'))) effects.rcGroup = num(field(entry, 'rcgroup') ?? field(entry, 'rcGroup'));
      const m = field(entry, 'mount');
      const mount = Array.isArray(m) ? m[0] || '' : String(m || '').split('/')[0];
      return { list: 'weapons', sub: 'accessories', item: { ...head, mount: mount === 'None' ? '' : mount, ...(r ? { rating: r } : {}), cost, avail: entry.avail || '', effects } };
    }
    case 'armormods': {
      const capRaw = field(entry, 'capacity') ?? field(entry, 'armorcapacity');
      const cap = typeof capRaw === 'number' ? capRaw : num(evalFormula(String(capRaw ?? '0').replace(/[[\]]/g, ''), r || 1));
      const armor = num(String(field(entry, 'armor') ?? 0).replace('+', ''));
      return { list: 'armor', sub: 'mods', item: { ...head, ...(r ? { rating: r } : {}), capacity: cap, cost, avail: entry.avail || '', ...(armor ? { effects: { armor } } : {}) } };
    }
    case 'vehiclemods': {
      const slotsRaw = field(entry, 'slots');
      const slots = typeof slotsRaw === 'number' ? slotsRaw : num(evalFormula(String(slotsRaw ?? '0'), r || 1));
      return { list: 'vehicles', sub: 'mods', item: { ...head, ...(r ? { rating: r } : {}), slots, category: entry.category || '', cost, avail: entry.avail || '' } };
    }
    case 'techniques':
      return { list: 'martialArts', sub: 'techniques', item: { ...head } };
    default:
      return null;
  }
}

/** Status shown to players for NPCs (they never see enemy stats). Stored French values (save compatibility), shown with STATUS_LABELS. */
export function healthStatus(
  { physical = 0, stun = 0, overflow = 0 }: { physical?: number; stun?: number; overflow?: number } = {},
  physMax = 10,
  stunMax = 10,
  bod = 3
): HealthStatus {
  if (overflow > bod) return 'mort';
  // A track of 0 boxes does not exist (grunts / drones: no stun track, hosts: no physical track).
  if ((physMax > 0 && physical >= physMax) || (stunMax > 0 && stun >= stunMax)) return 'hors de combat';
  const ratio = Math.max(physMax > 0 ? physical / physMax : 0, stunMax > 0 ? stun / stunMax : 0);
  if (ratio >= 0.5) return 'grièvement blessé';
  if (physical > 0 || stun > 0) return 'blessé';
  return 'indemne';
}

export const STATUS_COLORS: Record<HealthStatus, string> = { indemne: 'green', 'blessé': 'amber', 'grièvement blessé': 'red', 'hors de combat': 'magenta', mort: 'dim' };
/** Display keys of the statuses above (the stored value stays French). */
export const STATUS_LABELS: Record<HealthStatus, string> = { indemne: tk('unharmed'), 'blessé': tk('wounded'), 'grièvement blessé': tk('badly wounded'), 'hors de combat': tk('KO'), mort: tk('dead') };

/** A blank actor (all SR5 attributes at 3). */
export function blankActor(type: ActorType = 'npc', name = 'New character') {
  return {
    type, name, metatype: 'Humain', // stored metatype value (French) concept: '', color: type === 'pc' ? '#3fd6d0' : '#e05c5c',
    attributes: { BOD: 3, AGI: 3, REA: 3, STR: 3, WIL: 3, LOG: 3, INT: 3, CHA: 3, EDG: 2, ESS: 6 },
    condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 2 },
    skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [], contacts: [], sins: [], lifestyles: [], martialArts: [],
    karma: 0, karmaTotal: 0, nuyen: 0, streetCred: 0, notoriety: 0, publicAwareness: 0, history: [],
    ...(type === 'npc' ? { npc: { professionalRating: 2, grunt: true, tactics: '', loot: '' } } : {}),
  };
}

/**
 * Fix up an actor in place: arrays, numbers, ids on items, condition, edge. `makeId(prefix)` creates ids.
 * Safe to call repeatedly.
 */
export function normalizeActor(a: RawData, makeId: MakeId): RawData {
  if (!a || typeof a !== 'object') return a;
  a.type = a.type === 'pc' ? 'pc' : 'npc';
  a.name = String(a.name || 'Unnamed').slice(0, 80);
  a.metatype = METATYPE_FR[a.metatype] || a.metatype || 'Humain'; // stored metatype value (French)
  const attrs = (a.attributes = a.attributes && typeof a.attributes === 'object' ? a.attributes : {});
  for (const k of ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG']) attrs[k] = num(attrs[k], k === 'EDG' ? 1 : 1);
  for (const k of ['MAG', 'RES']) if (attrs[k] !== undefined && attrs[k] !== null) attrs[k] = num(attrs[k], 0);
  attrs.ESS = num(attrs.ESS, 6);
  for (const k of ITEM_LISTS) {
    if (k === 'complexForms' || k === 'skillGroups') {
      if (a[k] !== undefined && !Array.isArray(a[k])) a[k] = [];
      if (!a[k]) continue;
    } else if (!Array.isArray(a[k])) a[k] = [];
    for (const it of a[k]) {
      if (!it || typeof it !== 'object') continue;
      if (!it.id) it.id = k === 'skills' ? slugify(it.name || 'competence') : makeId('itm');
    }
    a[k] = a[k].filter((it: RawData) => it && typeof it === 'object');
  }
  // Legacy single lifestyle → lifestyles[] (once; kept chummerGuid lets the Chummer export find its node).
  if ('lifestyle' in a) {
    if (a.lifestyle && typeof a.lifestyle === 'object' && !a.lifestyles.length && (a.lifestyle.name || a.lifestyle.monthlyCost)) a.lifestyles.push(legacyLifestyle(a.lifestyle, makeId));
    delete a.lifestyle;
  }
  // Nested lists (accessories, mods, lifestyle qualities, techniques): arrays of objects with ids.
  for (const [list, sub] of Object.entries(SUB_LISTS)) {
    for (const it of a[list] || []) {
      if (it[sub] === undefined) {
        if (list === 'lifestyles' || list === 'martialArts') it[sub] = [];
        continue;
      }
      it[sub] = Array.isArray(it[sub]) ? it[sub].filter((x: RawData) => x && typeof x === 'object') : [];
      for (const x of it[sub]) if (!x.id) x.id = makeId('sub');
    }
  }
  if (a.lifestyles.length && !a.lifestyles.some((l: RawData) => l.primary)) a.lifestyles[0].primary = true;
  let primarySeen = false;
  for (const l of a.lifestyles) {
    if (l.primary && primarySeen) l.primary = false;
    else if (l.primary) primarySeen = true;
  }
  const c = (a.condition = a.condition && typeof a.condition === 'object' ? a.condition : {});
  c.physical = Math.max(0, num(c.physical));
  c.stun = Math.max(0, num(c.stun));
  c.overflow = Math.max(0, num(c.overflow));
  a.edge = a.edge && typeof a.edge === 'object' ? a.edge : {};
  a.edge.current = Math.max(0, Math.min(attrs.EDG, num(a.edge.current, attrs.EDG)));
  for (const k of ['karma', 'karmaTotal', 'nuyen', 'streetCred', 'notoriety', 'publicAwareness']) a[k] = num(a[k], 0);
  if (!Array.isArray(a.history)) a.history = [];
  if (a.type === 'npc' && (!a.npc || typeof a.npc !== 'object')) a.npc = { professionalRating: 0, grunt: false, tactics: '', loot: '' };
  normalizeInventory(a, makeId); // containers, locations, ammo, ready weapons (inventory.js)
  return a;
}

export function slugify(s: unknown): string {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'x';
}
