// Pure helpers for actors / character sheets, shared by the characters server module and the sheet UI.
// IMPORTANT: no imports here (this file is loaded both by Node and by the browser).
// Labels stay French here (they are also stored / used by the server); the UI renders them with t(…).

/** Marker for the i18n checker (French keys rendered with t() by the UI). */
const tk = (s) => s;

/** Item lists of an Actor that can be edited with actor/addItem, actor/updateItem, actor/removeItem. */
export const ITEM_LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'contacts', 'sins', 'qualities', 'powers', 'spells', 'knowledge', 'skills', 'complexForms', 'skillGroups'];

export const LIST_LABELS = {
  weapons: tk('Armes'), armor: tk('Armures'), augmentations: tk('Augmentations'), gear: tk('Équipement'), vehicles: tk('Véhicules'), contacts: tk('Contacts'),
  sins: tk('SIN'), qualities: tk('Qualités'), powers: tk('Pouvoirs d’adepte'), spells: tk('Sorts'), knowledge: tk('Connaissances'), skills: tk('Compétences'),
  complexForms: tk('Formes complexes'), skillGroups: tk('Groupes de compétences'),
};

/** Fields a player may change on items of their own actor. */
export const PLAYER_ITEM_FIELDS = {
  armor: ['equipped'],
  gear: ['qty', 'notes'],
  contacts: ['notes'],
  weapons: ['notes', 'ammoLeft'],
};

/** Top-level actor keys a player may change on their own actor. */
export const PLAYER_ACTOR_KEYS = ['condition', 'edge', 'notes', 'bio', 'portrait', 'color', 'concept'];

/** Nested objects merged one level deep by actor/update. */
export const MERGE_KEYS = ['attributes', 'augmented', 'initiative', 'monitors', 'condition', 'edge', 'matrix', 'lifestyle', 'npc', 'vision'];

export const METATYPE_FR = { Human: 'Humain', Elf: 'Elfe', Dwarf: 'Nain', Ork: 'Ork', Troll: 'Troll', Humain: 'Humain', Elfe: 'Elfe', Nain: 'Nain', Orc: 'Ork', Orque: 'Ork' };

export const KNOWLEDGE_TYPES = { street: tk('Rue'), academic: tk('Académique'), professional: tk('Professionnelle'), interest: tk('Centre d’intérêt'), language: tk('Langue') };

/** Linked attribute of a knowledge skill (SR5: street/interest → INT, academic/professional → LOG, language → INT). */
export function knowledgeAttr(type) {
  return type === 'academic' || type === 'professional' ? 'LOG' : 'INT';
}

/** Map a Chummer weapon category / useskill to an SR5 skill id (see shared/sr5.js SKILLS). */
export function categoryToSkill(category = '', useskill = '') {
  const u = String(useskill || '').toLowerCase();
  const map = {
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

export const MELEE_SKILLS = ['blades', 'clubs', 'unarmed_combat'];

/** Evaluate a small Chummer formula like "Rating * 0.1 + 0.1" (digits/operators only, no code). */
export function evalFormula(expr, rating = 1) {
  if (typeof expr === 'number') return expr;
  if (expr === null || expr === undefined || expr === '') return null;
  let s = String(expr)
    .replace(/\{?Rating\}?/gi, String(Number(rating) || 0))
    .replace(/number\(([^)]*)\)/gi, '($1 ? 1 : 0)')
    .replace(/FixedValues\(([^)]*)\)/gi, (m, list) => {
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

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Convert a catalog entry (data/catalog/<name>.json, see ARCHITECTURE.md) into an Actor list item.
 * Returns { list, item } or null. Tolerant to missing stats (catalogs may evolve).
 */
export function catalogToItem(catalog, entry, rating) {
  if (!entry) return null;
  const s = entry.stats || {};
  const name = entry.nameFr || entry.name || 'Objet';
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
        },
      };
    }
    case 'armor': {
      const raw = s.armor ?? s.rating ?? entry.armor ?? 0;
      const stack = s.stack === true || String(raw).trim().startsWith('+') || /helmet|shield|casque|bouclier/i.test(`${entry.name} ${entry.category || ''}`);
      return { list: 'armor', item: { ...base, rating: Math.abs(num(String(raw).replace('+', ''), 0)), equipped: false, stack } };
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
    default:
      return { list: 'gear', item: { ...base, category: entry.categoryFr || entry.category || '', qty: 1 } };
  }
}

/** Status shown to players for NPCs (they never see enemy stats). */
export function healthStatus({ physical = 0, stun = 0, overflow = 0 } = {}, physMax = 10, stunMax = 10, bod = 3) {
  if (overflow > bod) return 'mort';
  if (physical >= physMax || stun >= stunMax) return 'hors de combat';
  const ratio = Math.max(physical / physMax, stun / stunMax);
  if (ratio >= 0.5) return 'grièvement blessé';
  if (physical > 0 || stun > 0) return 'blessé';
  return 'indemne';
}

export const STATUS_COLORS = { indemne: 'green', 'blessé': 'amber', 'grièvement blessé': 'red', 'hors de combat': 'magenta', mort: 'dim' };
/** Display keys of the statuses above (the stored value stays French). */
export const STATUS_LABELS = { indemne: tk('indemne'), 'blessé': tk('blessé'), 'grièvement blessé': tk('grièvement blessé'), 'hors de combat': tk('hors de combat'), mort: tk('mort') };

/** A blank actor (all SR5 attributes at 3). */
export function blankActor(type = 'npc', name = 'Nouveau personnage') {
  return {
    type, name, metatype: 'Humain', concept: '', color: type === 'pc' ? '#3fd6d0' : '#e05c5c',
    attributes: { BOD: 3, AGI: 3, REA: 3, STR: 3, WIL: 3, LOG: 3, INT: 3, CHA: 3, EDG: 2, ESS: 6 },
    condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 2 },
    skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [], contacts: [], sins: [],
    karma: 0, karmaTotal: 0, nuyen: 0, streetCred: 0, notoriety: 0, publicAwareness: 0, history: [],
    ...(type === 'npc' ? { npc: { professionalRating: 2, grunt: true, tactics: '', loot: '' } } : {}),
  };
}

/**
 * Fix up an actor in place: arrays, numbers, ids on items, condition, edge. `makeId(prefix)` creates ids.
 * Safe to call repeatedly.
 */
export function normalizeActor(a, makeId) {
  if (!a || typeof a !== 'object') return a;
  a.type = a.type === 'pc' ? 'pc' : 'npc';
  a.name = String(a.name || 'Sans nom').slice(0, 80);
  a.metatype = METATYPE_FR[a.metatype] || a.metatype || 'Humain';
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
    a[k] = a[k].filter((it) => it && typeof it === 'object');
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
  return a;
}

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'x';
}
