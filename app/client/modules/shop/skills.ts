// Storefront « Compétence » filter: the SR5 active skill(s) linked to a catalog item, and the character's ratings.
// Pure ES module (no DOM, no i18n): unit-tested in Node by tools/test-shop.js. Labels are rendered by Storefront (skillLabel).
import { SKILLS, SKILL_BY_ID } from '../../../shared/sr5.js';
import { accessoryFit } from './rules.ts';
import type { Loose } from './rules.ts';

/** Storefront catalog: one entry per sellable item ({ ref, file, item }). */
export interface StorefrontCatalog {
  entries: { ref: string; file: string; item: Loose }[];
}
/** Map(catalog ref → skill ids). */
export type SkillIndex = Map<string, string[]>;
/** One « Compétence » filter option. */
export interface SkillOption {
  id: string;
  count: number;
  rating: number;
  label: string;
}

/** Skill id kept for items whose catalog entry links to no skill (« Sans compétence liée » option). */
export const NO_SKILL = '__none';

// Only unambiguous links (the skill used with the item, or the skill its catalog effects raise).
// Vehicles: by catalog category. Drones, hovercraft, Corpsec/Police/Military and Municipal/Construction mix several
// kinds of craft: no link.
export const VEHICLE_SKILLS: Record<string, string[]> = {
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
export const CATEGORY_SKILLS: Record<string, string[]> = {
  Cyberdecks: DECKER,
  'Hacking Programs': DECKER,
  'Advanced Programs': DECKER,
  Explosives: ['demolitions'],
  'Musical Instruments': ['performance'],
  'Alchemical Tools': ['alchemy'],
};
/** Gear by name (category, regexp on the English name, skills). First match wins. */
export const NAME_SKILLS: [string, RegExp, string[]][] = [
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

const known = (id: unknown): boolean => !!SKILL_BY_ID[id as string];
const GROUP_SKILLS = SKILLS.reduce((m: Record<string, string[]>, s) => (s.group ? ((m[s.group] ||= []).push(s.id), m) : m), {});

/** Skill ids linked to a catalog item of `file` (accessories: see accessorySkillIndex). Sorted, no duplicates. */
export function itemSkills(file: string, item: Loose): string[] {
  if (!item) return [];
  const out = new Set<string>();
  const add = (list: unknown[]) => list.forEach((id) => known(id) && out.add(id as string));
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
export function accessorySkillIndex(weapons: Loose[] | null | undefined, accessories: Loose[] | null | undefined): SkillIndex {
  const ws = (weapons || [])
    .filter((w) => known(w?.stats?.skill))
    .map((w): { skill: string; cat: Loose; stub: { name: string; kind: string } } => ({ skill: w.stats.skill, cat: w, stub: { name: w.name, kind: w.stats?.type === 'melee' ? 'melee' : 'ranged' } }));
  const idx: SkillIndex = new Map();
  for (const a of accessories || []) {
    const set = new Set<string>();
    for (const w of ws) if (!set.has(w.skill) && !accessoryFit(w.stub, w.cat, a).problem) set.add(w.skill);
    idx.set(a.id, [...set].sort());
  }
  return idx;
}

const cache = new WeakMap<StorefrontCatalog, SkillIndex>();
/** Map(catalog ref → skill ids) for a storefront catalog ({ entries: [{ ref, file, item }] }), computed once per catalog. */
export function skillIndex(catalog: StorefrontCatalog | null | undefined): SkillIndex {
  if (!catalog) return new Map();
  let idx = cache.get(catalog);
  if (idx) return idx;
  idx = new Map();
  const of = (file: string): Loose[] => catalog.entries.filter((e) => e.file === file).map((e) => e.item);
  const acc = accessorySkillIndex(of('weapons'), of('accessories'));
  for (const e of catalog.entries) idx.set(e.ref, e.file === 'accessories' ? acc.get(e.item?.id) || [] : itemSkills(e.file, e.item));
  cache.set(catalog, idx);
  return idx;
}

/** Skills of a storefront entry (fixer specials borrow their catalog item's). */
export function entrySkills(entry: { ref?: string; special?: { catalogRef?: string } | null } | null | undefined, idx: SkillIndex | null | undefined): string[] {
  if (!entry || !idx) return [];
  if (entry.special) return (entry.special.catalogRef && idx.get(entry.special.catalogRef)) || [];
  return idx.get(entry.ref as string) || [];
}

/** The character's active skill ratings: Map(skill id → rating > 0). Matches SR5 skills by id, or by French / id name. */
export function actorSkillRatings(actor: { skills?: unknown } | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of Array.isArray(actor?.skills) ? actor.skills : []) {
    const r = Number(s?.rating) || 0;
    if (r <= 0) continue;
    let id: string | null = known(s.id) ? s.id : null;
    if (!id && s.name) id = SKILLS.find((k) => k.fr === s.name || k.id === s.name)?.id || null;
    if (id && r > (m.get(id) || 0)) m.set(id, r);
  }
  return m;
}

/**
 * Filter options for a list of entries: { options: [{ id, count, rating }], none: count of entries without skill }.
 * Options: the character's skills first (rating > 0), then the others; within each, the order of `label(id)`.
 */
export function skillOptions<E>(
  entries: E[],
  skillsOf: (entry: E) => string[],
  ratings: Map<string, number> | null | undefined,
  label: (id: string) => string = (id) => id,
  compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b)
): { options: SkillOption[]; none: number } {
  const counts = new Map<string, number>();
  let none = 0;
  for (const e of entries) {
    const list = skillsOf(e);
    if (!list.length) none++;
    for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const options: SkillOption[] = [...counts.entries()].map(([id, count]) => ({ id, count, rating: ratings?.get(id) || 0, label: label(id) }));
  options.sort((a, b) => Number(b.rating > 0) - Number(a.rating > 0) || compare(a.label, b.label));
  return { options, none };
}

/** Does an entry pass the filter? skill: '' (any), NO_SKILL or a skill id; mine: only skills the character has. */
export function matchSkill(list: string[], skill: string | null | undefined, mine: boolean, ratings?: Map<string, number> | null): boolean {
  if (skill === NO_SKILL) return !list.length;
  if (skill && !list.includes(skill)) return false;
  if (mine) return skill ? (ratings?.get(skill) || 0) > 0 : list.some((id) => (ratings?.get(id) || 0) > 0);
  return true;
}
