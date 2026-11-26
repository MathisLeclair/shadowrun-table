// Storefront « Compétence » filter: the SR5 active skill(s) linked to a catalog item, and the character's ratings.
// Pure ES module (no DOM, no i18n): unit-tested in Node by tools/test-shop.js. Labels are rendered by Storefront (skillLabel).
import { SKILLS, SKILL_BY_ID } from '../../../shared/sr5.js';
import { accessoryFit } from './rules.js';

/** Skill id kept for items whose catalog entry links to no skill (« Sans compétence liée » option). */
export const NO_SKILL = '__none';

// Only unambiguous links (the skill used with the item, or the skill its catalog effects raise).
// Vehicles: by catalog category. Drones, hovercraft, Corpsec/Police/Military and Municipal/Construction mix several
// kinds of craft: no link.
export const VEHICLE_SKILLS = {
  Bikes: ['pilot_ground_craft'],
  Cars: ['pilot_ground_craft'],
  Trucks: ['pilot_ground_craft'],
  Boats: ['pilot_watercraft'],
  Submarines: ['pilot_watercraft'],
  'Fixed-Wing Aircraft': ['pilot_aircraft'],
  Rotorcraft: ['pilot_aircraft'],
  'VTOL/VSTOL': ['pilot_aircraft'],
  LTAV: ['pilot_aircraft'],
};
const DECKER = ['hacking', 'cybercombat'];
/** Gear / program catalog categories → skills. */
export const CATEGORY_SKILLS = {
  Cyberdecks: DECKER,
  'Hacking Programs': DECKER,
  'Advanced Programs': DECKER,
  Explosives: ['demolitions'],
  'Musical Instruments': ['performance'],
  'Alchemical Tools': ['alchemy'],
};
/** Gear by name (category, regexp on the English name, skills). First match wins. */
export const NAME_SKILLS = [
  ['Ammunition', /^(grenade:|throwing knife|shuriken|throwing syringe)/i, ['throwing_weapons']],
  ['Ammunition', /^(minigrenade|rocket|missile):/i, ['heavy_weapons']],
  ['Ammunition', /^(arrow|bolt):/i, ['archery']],
  ['Foci', /^alchemical focus/i, ['alchemy']],
  ['Foci', /^summoning focus/i, ['summoning']],
  ['Foci', /^banishing focus/i, ['banishing']],
  ['Foci', /^binding focus/i, ['binding']],
  ['Foci', /^counterspelling focus/i, ['counterspelling']],
  ['Foci', /^disenchanting focus/i, ['disenchanting']],
  ['Foci', /^ritual spellcasting focus/i, ['ritual_spellcasting']],
  ['Foci', /^(spellcasting|sustaining|spell shaping) focus/i, ['spellcasting']],
  ['Formulae', /focus formula/i, ['artificing']],
  ['Breaking and Entering Gear', /^(lockpick set|autopicker)$/i, ['locksmith']],
  ['Biotech', /^medkit/i, ['first_aid']],
  ['Nanogear', /^savior medkit/i, ['first_aid']],
  ['Survival Gear', /^survival kit$/i, ['survival']],
  ['Tools of the Trade', /^theatrical cosmetics kit$/i, ['disguise']],
  ['Disguises', /^faceless/i, ['disguise']],
];

const known = (id) => !!SKILL_BY_ID[id];
const GROUP_SKILLS = SKILLS.reduce((m, s) => (s.group ? ((m[s.group] ||= []).push(s.id), m) : m), {});

/** Skill ids linked to a catalog item of `file` (accessories: see accessorySkillIndex). Sorted, no duplicates. */
export function itemSkills(file, item) {
  if (!item) return [];
  const out = new Set();
  const add = (list) => list.forEach((id) => known(id) && out.add(id));
  if (file === 'weapons') add([item.stats?.skill]);
  if (file === 'vehicles' && !/hover/i.test(item.name || '')) add(VEHICLE_SKILLS[item.category] || []);
  if (file === 'gear' || file === 'programs') {
    add(CATEGORY_SKILLS[item.category] || []);
    const rule = NAME_SKILLS.find(([cat, re]) => cat === item.category && re.test(item.name || ''));
    if (rule) add(rule[2]);
  }
  // Catalog effects that raise one skill or a skill group (foci, cyber/bioware, armor…). Skill categories are too broad.
  for (const e of Array.isArray(item.effects) ? item.effects : []) {
    if (e?.type === 'skill') add([e.target]);
    else if (e?.type === 'skillGroup') add(GROUP_SKILLS[e.target] || []);
  }
  return [...out].sort();
}

/**
 * Accessories: the skills of the catalog weapons each accessory fits (rules.js accessoryFit: requires / forbids, mount
 * points of the weapon). → Map(accessory id → skill ids).
 */
export function accessorySkillIndex(weapons, accessories) {
  const ws = (weapons || [])
    .filter((w) => known(w?.stats?.skill))
    .map((w) => ({ skill: w.stats.skill, cat: w, stub: { name: w.name, kind: w.stats?.type === 'melee' ? 'melee' : 'ranged' } }));
  const idx = new Map();
  for (const a of accessories || []) {
    const set = new Set();
    for (const w of ws) if (!set.has(w.skill) && !accessoryFit(w.stub, w.cat, a).problem) set.add(w.skill);
    idx.set(a.id, [...set].sort());
  }
  return idx;
}

const cache = new WeakMap();
/** Map(catalog ref → skill ids) for a storefront catalog ({ entries: [{ ref, file, item }] }), computed once per catalog. */
export function skillIndex(catalog) {
  if (!catalog) return new Map();
  let idx = cache.get(catalog);
  if (idx) return idx;
  idx = new Map();
  const of = (file) => catalog.entries.filter((e) => e.file === file).map((e) => e.item);
  const acc = accessorySkillIndex(of('weapons'), of('accessories'));
  for (const e of catalog.entries) idx.set(e.ref, e.file === 'accessories' ? acc.get(e.item?.id) || [] : itemSkills(e.file, e.item));
  cache.set(catalog, idx);
  return idx;
}

/** Skills of a storefront entry (fixer specials borrow their catalog item's). */
export function entrySkills(entry, idx) {
  if (!entry || !idx) return [];
  if (entry.special) return (entry.special.catalogRef && idx.get(entry.special.catalogRef)) || [];
  return idx.get(entry.ref) || [];
}

/** The character's active skill ratings: Map(skill id → rating > 0). Matches SR5 skills by id, or by French / id name. */
export function actorSkillRatings(actor) {
  const m = new Map();
  for (const s of Array.isArray(actor?.skills) ? actor.skills : []) {
    const r = Number(s?.rating) || 0;
    if (r <= 0) continue;
    let id = known(s.id) ? s.id : null;
    if (!id && s.name) id = SKILLS.find((k) => k.fr === s.name || k.id === s.name)?.id || null;
    if (id && r > (m.get(id) || 0)) m.set(id, r);
  }
  return m;
}

/**
 * Filter options for a list of entries: { options: [{ id, count, rating }], none: count of entries without skill }.
 * Options: the character's skills first (rating > 0), then the others; within each, the order of `label(id)`.
 */
export function skillOptions(entries, skillsOf, ratings, label = (id) => id, compare = (a, b) => a.localeCompare(b)) {
  const counts = new Map();
  let none = 0;
  for (const e of entries) {
    const list = skillsOf(e);
    if (!list.length) none++;
    for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const options = [...counts.entries()].map(([id, count]) => ({ id, count, rating: ratings?.get(id) || 0, label: label(id) }));
  options.sort((a, b) => (b.rating > 0) - (a.rating > 0) || compare(a.label, b.label));
  return { options, none };
}

/** Does an entry pass the filter? skill: '' (any), NO_SKILL or a skill id; mine: only skills the character has. */
export function matchSkill(list, skill, mine, ratings) {
  if (skill === NO_SKILL) return !list.length;
  if (skill && !list.includes(skill)) return false;
  if (mine) return skill ? (ratings?.get(skill) || 0) > 0 : list.some((id) => (ratings?.get(id) || 0) > 0);
  return true;
}
