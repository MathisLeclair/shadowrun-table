// Shadowrun 5E rules shared by server and client: attributes, derived stats, dice, skills.
// Pure ES module — no Node or DOM APIs.
import type { Actor, ActorLike, ActorVision, Armor, AttrKey, DamageType, Legality, RollResult } from './types.ts';

/** Attribute key, or any string read from data (unknown keys read as 0). */
export type AttrKeyish = AttrKey | (string & {});
export type SkillCategory = 'combat' | 'physical' | 'social' | 'magic' | 'resonance' | 'technical' | 'vehicle';
/** Inherent limit of a test. */
export type LimitKey = 'physical' | 'mental' | 'social' | 'astral';
/** One SR5 active skill of SKILLS. */
export interface SkillDef {
  id: string;
  fr: string;
  attr: AttrKey;
  group?: string;
  cat: SkillCategory;
  /** Overrides the category's default limit; null = no default limit. */
  limit?: LimitKey | null;
  /** Can default (roll untrained). */
  def: boolean;
}
/** Metatype racial maximums and natural vision. */
export interface MetatypeDef {
  max: Record<'BOD' | 'AGI' | 'REA' | 'STR' | 'WIL' | 'LOG' | 'INT' | 'CHA' | 'EDG', number>;
  vision: ActorVision;
}

export const ATTRS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES', 'ESS'];
/** Attribute names: UI keys (English), shown with attrLabel() / t(). */
export const ATTR_LABELS: Record<AttrKey, string> = {
  BOD: 'Body', AGI: 'Agility', REA: 'Reaction', STR: 'Strength', WIL: 'Willpower', LOG: 'Logic',
  INT: 'Intuition', CHA: 'Charisma', EDG: 'Edge', MAG: 'Magic', RES: 'Resonance', ESS: 'Essence',
};
/** French attribute abbreviations (SR5 FR), used by attrShort() in French; English shows the key itself. */
export const ATTR_SHORT: Record<AttrKey, string> = { BOD: 'CON', AGI: 'AGI', REA: 'RÉA', STR: 'FOR', WIL: 'VOL', LOG: 'LOG', INT: 'INT', CHA: 'CHA', EDG: 'CHC', MAG: 'MAG', RES: 'RES', ESS: 'ESS' };

/** Keys are the stored metatype values (French, kept for save compatibility); shown with metatypeLabel(). */
export const METATYPES: Record<string, MetatypeDef> = {
  Humain: { max: { BOD: 6, AGI: 6, REA: 6, STR: 6, WIL: 6, LOG: 6, INT: 6, CHA: 6, EDG: 7 }, vision: {} },
  Elfe: { max: { BOD: 6, AGI: 7, REA: 6, STR: 6, WIL: 6, LOG: 6, INT: 6, CHA: 8, EDG: 6 }, vision: { lowLight: true } },
  Nain: { max: { BOD: 8, AGI: 6, REA: 5, STR: 8, WIL: 7, LOG: 6, INT: 6, CHA: 6, EDG: 6 }, vision: { thermo: true } },
  Ork: { max: { BOD: 9, AGI: 6, REA: 6, STR: 8, WIL: 6, LOG: 5, INT: 6, CHA: 5, EDG: 6 }, vision: { lowLight: true } },
  Troll: { max: { BOD: 10, AGI: 5, REA: 6, STR: 10, WIL: 6, LOG: 5, INT: 5, CHA: 4, EDG: 6 }, vision: { thermo: true } },
};

/**
 * SR5 active skills. id = stable key (English, as in Chummer/Foundry), fr = French name (shown in French, and the name
 * stored on actor skills — kept French for save compatibility; English shows the official name from the id),
 * attr = linked attribute, group = skill group, cat = category, def = can default (roll untrained).
 */
// Optional `limit` on a skill overrides the category default: 'physical'|'mental'|'social'|'astral',
// or null = no default limit (Force / level / Handling, typed by the GM).
export const SKILLS: SkillDef[] = [
  // Combat
  { id: 'archery', fr: 'Archerie', attr: 'AGI', cat: 'combat', def: true },
  { id: 'automatics', fr: 'Armes automatiques', attr: 'AGI', group: 'firearms', cat: 'combat', def: true },
  { id: 'blades', fr: 'Armes tranchantes', attr: 'AGI', group: 'close_combat', cat: 'combat', def: true },
  { id: 'clubs', fr: 'Armes contondantes', attr: 'AGI', group: 'close_combat', cat: 'combat', def: true },
  { id: 'heavy_weapons', fr: 'Armes lourdes', attr: 'AGI', cat: 'combat', def: true },
  { id: 'longarms', fr: 'Armes d’épaule', attr: 'AGI', group: 'firearms', cat: 'combat', def: true },
  { id: 'pistols', fr: 'Pistolets', attr: 'AGI', group: 'firearms', cat: 'combat', def: true },
  { id: 'throwing_weapons', fr: 'Armes de jet', attr: 'AGI', cat: 'combat', def: true },
  { id: 'unarmed_combat', fr: 'Combat à mains nues', attr: 'AGI', group: 'close_combat', cat: 'combat', def: true },
  { id: 'exotic_weapon', fr: 'Arme exotique', attr: 'AGI', cat: 'combat', def: false },
  // Physical
  { id: 'disguise', fr: 'Déguisement', attr: 'INT', group: 'stealth', cat: 'physical', def: true },
  { id: 'diving', fr: 'Plongée', attr: 'BOD', cat: 'physical', def: true },
  { id: 'escape_artist', fr: 'Évasion', attr: 'AGI', cat: 'physical', def: true },
  { id: 'free_fall', fr: 'Chute libre', attr: 'BOD', cat: 'physical', def: true },
  { id: 'gymnastics', fr: 'Gymnastique', attr: 'AGI', group: 'athletics', cat: 'physical', def: true },
  { id: 'palming', fr: 'Escamotage', attr: 'AGI', group: 'stealth', cat: 'physical', def: false },
  { id: 'perception', fr: 'Perception', attr: 'INT', cat: 'physical', limit: 'mental', def: true },
  { id: 'running', fr: 'Course', attr: 'STR', group: 'athletics', cat: 'physical', def: true },
  { id: 'sneaking', fr: 'Furtivité', attr: 'AGI', group: 'stealth', cat: 'physical', def: true },
  { id: 'survival', fr: 'Survie', attr: 'WIL', group: 'outdoors', cat: 'physical', def: true },
  { id: 'swimming', fr: 'Natation', attr: 'STR', group: 'athletics', cat: 'physical', def: true },
  { id: 'tracking', fr: 'Pistage', attr: 'INT', group: 'outdoors', cat: 'physical', def: true },
  { id: 'navigation', fr: 'Navigation', attr: 'INT', group: 'outdoors', cat: 'physical', def: true },
  // Social
  { id: 'con', fr: 'Escroquerie', attr: 'CHA', group: 'acting', cat: 'social', def: true },
  { id: 'etiquette', fr: 'Étiquette', attr: 'CHA', group: 'influence', cat: 'social', def: true },
  { id: 'impersonation', fr: 'Imposture', attr: 'CHA', group: 'acting', cat: 'social', def: true },
  { id: 'instruction', fr: 'Enseignement', attr: 'CHA', cat: 'social', def: true },
  { id: 'intimidation', fr: 'Intimidation', attr: 'CHA', cat: 'social', def: true },
  { id: 'leadership', fr: 'Leadership', attr: 'CHA', group: 'influence', cat: 'social', def: true },
  { id: 'negotiation', fr: 'Négociation', attr: 'CHA', group: 'influence', cat: 'social', def: true },
  { id: 'performance', fr: 'Représentation', attr: 'CHA', group: 'acting', cat: 'social', def: true },
  // Magic
  { id: 'alchemy', fr: 'Alchimie', attr: 'MAG', group: 'enchanting', cat: 'magic', limit: null, def: false },
  { id: 'arcana', fr: 'Arcanes', attr: 'LOG', cat: 'magic', def: false },
  { id: 'artificing', fr: 'Artisanat magique', attr: 'MAG', group: 'enchanting', cat: 'magic', limit: null, def: false },
  { id: 'assensing', fr: 'Observation astrale', attr: 'INT', cat: 'magic', limit: 'astral', def: false },
  { id: 'astral_combat', fr: 'Combat astral', attr: 'WIL', cat: 'magic', limit: 'astral', def: false },
  { id: 'banishing', fr: 'Bannissement', attr: 'MAG', group: 'conjuring', cat: 'magic', limit: 'astral', def: false },
  { id: 'binding', fr: 'Lien', attr: 'MAG', group: 'conjuring', cat: 'magic', limit: null, def: false },
  { id: 'counterspelling', fr: 'Contresort', attr: 'MAG', group: 'sorcery', cat: 'magic', limit: null, def: false },
  { id: 'disenchanting', fr: 'Désenchantement', attr: 'MAG', group: 'enchanting', cat: 'magic', limit: 'astral', def: false },
  { id: 'ritual_spellcasting', fr: 'Rituels', attr: 'MAG', group: 'sorcery', cat: 'magic', limit: null, def: false },
  { id: 'spellcasting', fr: 'Lancement de sorts', attr: 'MAG', group: 'sorcery', cat: 'magic', limit: null, def: false },
  { id: 'summoning', fr: 'Invocation', attr: 'MAG', group: 'conjuring', cat: 'magic', limit: null, def: false },
  // Resonance
  { id: 'compiling', fr: 'Compilation', attr: 'RES', group: 'tasking', cat: 'resonance', limit: null, def: false },
  { id: 'decompiling', fr: 'Décompilation', attr: 'RES', group: 'tasking', cat: 'resonance', limit: null, def: false },
  { id: 'registering', fr: 'Inscription', attr: 'RES', group: 'tasking', cat: 'resonance', limit: null, def: false },
  // Technical
  { id: 'aeronautics_mechanic', fr: 'Mécanique aéronautique', attr: 'LOG', group: 'engineering', cat: 'technical', def: false },
  { id: 'animal_handling', fr: 'Dressage', attr: 'CHA', cat: 'technical', def: true },
  { id: 'armorer', fr: 'Armurerie', attr: 'LOG', cat: 'technical', def: true },
  { id: 'artisan', fr: 'Artisanat', attr: 'INT', cat: 'technical', def: false },
  { id: 'automotive_mechanic', fr: 'Mécanique automobile', attr: 'LOG', group: 'engineering', cat: 'technical', def: false },
  { id: 'biotechnology', fr: 'Biotechnologie', attr: 'LOG', group: 'biotech', cat: 'technical', def: false },
  { id: 'chemistry', fr: 'Chimie', attr: 'LOG', cat: 'technical', def: false },
  { id: 'computer', fr: 'Informatique', attr: 'LOG', group: 'electronics', cat: 'technical', def: true },
  { id: 'cybercombat', fr: 'Cybercombat', attr: 'LOG', group: 'cracking', cat: 'technical', def: true },
  { id: 'cybertechnology', fr: 'Cybertechnologie', attr: 'LOG', group: 'biotech', cat: 'technical', def: false },
  { id: 'demolitions', fr: 'Démolition', attr: 'LOG', cat: 'technical', def: true },
  { id: 'electronic_warfare', fr: 'Guerre électronique', attr: 'LOG', group: 'cracking', cat: 'technical', def: false },
  { id: 'first_aid', fr: 'Premiers soins', attr: 'LOG', group: 'biotech', cat: 'technical', def: true },
  { id: 'forgery', fr: 'Contrefaçon', attr: 'LOG', cat: 'technical', def: true },
  { id: 'hacking', fr: 'Hacking', attr: 'LOG', group: 'cracking', cat: 'technical', def: true },
  { id: 'hardware', fr: 'Hardware', attr: 'LOG', group: 'electronics', cat: 'technical', def: false },
  { id: 'industrial_mechanic', fr: 'Mécanique industrielle', attr: 'LOG', group: 'engineering', cat: 'technical', def: false },
  { id: 'locksmith', fr: 'Serrurerie', attr: 'AGI', cat: 'technical', limit: 'physical', def: false },
  { id: 'medicine', fr: 'Médecine', attr: 'LOG', group: 'biotech', cat: 'technical', def: false },
  { id: 'nautical_mechanic', fr: 'Mécanique nautique', attr: 'LOG', group: 'engineering', cat: 'technical', def: false },
  { id: 'software', fr: 'Software', attr: 'LOG', group: 'electronics', cat: 'technical', def: false },
  // Vehicle
  { id: 'gunnery', fr: 'Artillerie', attr: 'AGI', cat: 'vehicle', def: true },
  { id: 'pilot_aerospace', fr: 'Pilotage (aérospatial)', attr: 'REA', cat: 'vehicle', limit: null, def: false },
  { id: 'pilot_aircraft', fr: 'Pilotage (aéronefs)', attr: 'REA', cat: 'vehicle', limit: null, def: false },
  { id: 'pilot_walker', fr: 'Pilotage (marcheurs)', attr: 'REA', cat: 'vehicle', limit: null, def: false },
  { id: 'pilot_ground_craft', fr: 'Pilotage (véhicules terrestres)', attr: 'REA', cat: 'vehicle', limit: null, def: true },
  { id: 'pilot_watercraft', fr: 'Pilotage (bateaux)', attr: 'REA', cat: 'vehicle', limit: null, def: true },
];
export const SKILL_BY_ID: Record<string, SkillDef> = Object.fromEntries(SKILLS.map((s) => [s.id, s]));
/** Official English names that are not the title-cased id. */
const SKILL_EN_EXCEPTIONS: Record<string, string> = { free_fall: 'Free-Fall', exotic_weapon: 'Exotic Weapon' };
/** Dictionary keys of skills whose plain English name translates differently elsewhere (context key, docs/i18n.md). */
const SKILL_KEY_EXCEPTIONS: Record<string, string> = { spellcasting: 'pl::Spellcasting' };
/** Official English name of an SR5 active skill ('pistols' → 'Pistols'; a SKILLS entry or its id). */
export function skillEn(skill: SkillDef | string): string {
  const id = typeof skill === 'string' ? skill : skill.id;
  return SKILL_EN_EXCEPTIONS[id] || String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
/** Dictionary key of an SR5 active skill name, for stored texts and nested translatable params ({ t: skillKey(def) }). */
export function skillKey(skill: SkillDef | string): string {
  const id = typeof skill === 'string' ? skill : skill.id;
  return SKILL_KEY_EXCEPTIONS[id] || skillEn(id);
}
/** Skill group names: UI keys (English), shown with skillGroupLabel() / t(). */
export const SKILL_GROUPS: Record<string, string> = {
  acting: 'Acting', athletics: 'Athletics', biotech: 'Biotech', close_combat: 'Close Combat', conjuring: 'Conjuring',
  cracking: 'Cracking', electronics: 'Electronics', enchanting: 'Enchanting', engineering: 'Engineering', firearms: 'Firearms',
  influence: 'Influence', outdoors: 'Outdoors', sorcery: 'Sorcery', stealth: 'Stealth', tasking: 'Tasking',
};
/** Skill category names: UI keys (English), shown with skillCategoryLabel() / t(). */
export const SKILL_CATEGORIES: Record<SkillCategory, string> = { combat: 'Combat', physical: 'pl::Physical', social: 'Social', magic: 'Magical', resonance: 'Resonance', technical: 'Technical', vehicle: 'Vehicles' };

/** Result of skillPool(). */
export interface SkillPool {
  pool: number;
  defaulting: boolean;
  /** Untrained and the skill cannot default. */
  impossible?: boolean;
}

/** Options of rollDice(). */
export interface RollOptions {
  limit?: number | string | null;
  /** Rule of Six (Push the Limit): sixes explode, the limit is ignored. */
  explode?: boolean;
  rng?: () => number;
}

/** Derived numbers of a sheet (derive()). */
export type Derived = ReturnType<typeof derive>;

/** Effective (augmented) attribute value. Augmentation bonus is capped at +4 (SR5). */
export function attr(actor: ActorLike | null | undefined, key: AttrKeyish): number {
  const base = Number((actor?.attributes as Record<string, number> | null | undefined)?.[key] ?? 0);
  if (key === 'ESS') return base;
  const aug = Math.min(4, Number((actor?.augmented as Record<string, number> | null | undefined)?.[key] ?? 0));
  return base + aug;
}

/** Armor points added by an armor's installed modifications (armor.mods[].effects.armor: Gel Packs +2…; unequipped mods excluded). */
export function armorModBonus(a: Partial<Armor> | null | undefined): number {
  return (Array.isArray(a?.mods) ? a.mods : []).reduce((s, m) => s + (m && typeof m === 'object' && m.equipped !== false ? Number(m.effects?.armor) || 0 : 0), 0);
}

/** Armor value of one piece: rating + its modifications' armor bonus. */
export function armorValue(a: Partial<Armor> | null | undefined): number {
  return (Number(a?.rating) || 0) + armorModBonus(a);
}

/** Armor value: highest non-stacking equipped armor + all equipped stacking pieces (helmets, shields…), mods included. */
export function armorTotal(actor: ActorLike | null | undefined): number {
  const eq = (actor?.armor || []).filter((a) => a && a.equipped);
  const base = Math.max(0, ...eq.filter((a) => !a.stack).map(armorValue));
  const extra = eq.filter((a) => a.stack).reduce((s, a) => s + armorValue(a), 0);
  return base + extra;
}

/** All derived numbers for a sheet, initiative and combat. */
export function derive(actor: ActorLike | null | undefined) {
  const A = (k: AttrKey) => attr(actor, k);
  const ess = Number(actor?.attributes?.ESS ?? 6);
  const physicalMonitor = actor?.monitors?.physical ?? 8 + Math.ceil(A('BOD') / 2);
  const stunMonitor = actor?.monitors?.stun ?? 8 + Math.ceil(A('WIL') / 2);
  const c: Partial<Actor['condition']> = actor?.condition || {};
  const woundModifier = -(Math.floor((c.physical || 0) / 3) + Math.floor((c.stun || 0) / 3));
  const initDice = Math.max(1, Math.min(5, Number(actor?.initiative?.dice ?? 1)));
  const initBase = A('REA') + A('INT') + Number(actor?.initiative?.bonus ?? 0);
  const armor = armorTotal(actor);
  return {
    physicalMonitor,
    stunMonitor,
    overflowMax: A('BOD'),
    woundModifier,
    initiative: { base: initBase, dice: initDice, text: `${initBase} + ${initDice}D6` },
    astralInitiative: { base: A('INT') * 2, dice: 2 },
    matrixInitiative: {
      ar: { base: initBase, dice: 1 },
      cold: { base: Number(actor?.matrix?.dataProcessing ?? 0) + A('INT'), dice: 3 },
      hot: { base: Number(actor?.matrix?.dataProcessing ?? 0) + A('INT'), dice: 4 },
    },
    limits: {
      physical: Math.ceil((A('STR') * 2 + A('BOD') + A('REA')) / 3),
      mental: Math.ceil((A('LOG') * 2 + A('INT') + A('WIL')) / 3),
      social: Math.ceil((A('CHA') * 2 + A('WIL') + Math.ceil(ess)) / 3),
      astral: actor?.attributes?.MAG ? Math.max(Math.ceil((A('LOG') * 2 + A('INT') + A('WIL')) / 3), Math.ceil((A('CHA') * 2 + A('WIL') + Math.ceil(ess)) / 3)) : null,
    },
    composure: A('CHA') + A('WIL'),
    judgeIntentions: A('CHA') + A('INT'),
    memory: A('LOG') + A('WIL'),
    liftCarry: A('BOD') + A('STR'),
    movement: { walk: A('AGI') * 2, run: A('AGI') * 4 },
    defense: A('REA') + A('INT'),
    armor,
    soak: A('BOD') + armor,
    edgeMax: A('EDG'),
    essence: ess,
  };
}

/** Dice pool for an active skill (rating + linked attribute, +2 with spec, defaulting = attr − 1). */
export function skillPool(
  actor: ActorLike | null | undefined,
  skillId: string,
  { useSpec = false, attrOverride }: { useSpec?: boolean; attrOverride?: AttrKeyish | null } = {},
): SkillPool {
  const def = SKILL_BY_ID[skillId];
  const sk = (actor?.skills || []).find((s) => s.id === skillId || s.name === skillId);
  const key = attrOverride || sk?.attr || def?.attr || 'AGI';
  const a = attr(actor, key);
  if (!sk || !sk.rating) {
    if (def && !def.def) return { pool: 0, defaulting: true, impossible: true };
    return { pool: Math.max(0, a - 1), defaulting: true };
  }
  return { pool: sk.rating + a + (useSpec && sk.spec ? 2 : 0), defaulting: false };
}

/**
 * Roll a SR5 pool. opts: { limit, explode (Rule of Six / Push the Limit), rng () => [0,1) }
 * Returns { pool, dice, hits, rawHits, ones, glitch, critGlitch, limit, limited }
 */
export function rollDice(pool: number, opts: RollOptions = {}): RollResult {
  const rng = opts.rng || Math.random;
  const n = Math.max(0, Math.min(100, Math.floor(pool)));
  const d6 = () => 1 + Math.floor(rng() * 6);
  const dice: number[] = [];
  for (let i = 0; i < n; i++) dice.push(d6());
  const extra: number[] = [];
  if (opts.explode) {
    let sixes = dice.filter((d) => d === 6).length;
    while (sixes > 0 && extra.length < 100) {
      const batch: number[] = [];
      for (let i = 0; i < sixes; i++) batch.push(d6());
      extra.push(...batch);
      sixes = batch.filter((d) => d === 6).length;
    }
  }
  const all = dice.concat(extra);
  const rawHits = all.filter((d) => d >= 5).length;
  const ones = dice.filter((d) => d === 1).length;
  const glitch = n > 0 && ones > n / 2;
  const limit = opts.limit && !opts.explode ? Number(opts.limit) : null;
  const hits = limit ? Math.min(rawHits, limit) : rawHits;
  return { pool: n, dice, extra, hits, rawHits, ones, glitch, critGlitch: glitch && rawHits === 0, limit, limited: limit !== null && rawHits > limit };
}

/** Initiative roll: base + N d6. */
export function rollInitiative(base: number, dice: number, rng: () => number = Math.random): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < dice; i++) rolls.push(1 + Math.floor(rng() * 6));
  return { total: base + rolls.reduce((a, b) => a + b, 0), rolls };
}

/** "8R" -> { value: 8, legality: 'R' }, "12F" -> F, "4" -> ''. */
export function parseAvail(avail: unknown): { value: number; legality: Legality } {
  const m = String(avail ?? '').match(/(\d+)\s*([RF])?/i);
  return { value: m ? Number(m[1]) : 0, legality: m && m[2] ? (m[2].toUpperCase() as Legality) : '' };
}

/** Parse "7P" / "10S(e)" / "(STR+3)P" -> { value, type: 'P'|'S', raw }. STR-based uses actor's STR when given. */
export function parseDamage(dmg: unknown, actor?: ActorLike | null): { value: number | null; type: DamageType; raw: string } {
  const raw = String(dmg || '');
  const type: DamageType = /S/i.test(raw.replace(/STR/gi, '')) ? 'S' : 'P';
  let value: number | null = null;
  const strM = raw.match(/STR\s*([+-]\s*\d+)?/i);
  if (strM) value = (actor ? attr(actor, 'STR') : 0) + Number((strM[1] || '0').replace(/\s/g, ''));
  else {
    const m = raw.match(/-?\d+/);
    value = m ? Number(m[0]) : null;
  }
  return { value, type, raw };
}

const CAT_DEFAULT_LIMIT: Record<string, LimitKey> = { combat: 'physical', physical: 'physical', vehicle: 'physical', technical: 'mental', magic: 'mental', resonance: 'mental', social: 'social' };
/**
 * Default limit of a skill test: the skill's own `limit` when defined (null = none), else its category's,
 * else from the linked attribute (custom skills). Shared by the server roll and the client preview.
 */
export function skillDefaultLimit(def: Partial<SkillDef> | null | undefined, at?: AttrKeyish | null): LimitKey | null {
  if (def && 'limit' in def) return def.limit ?? null;
  return CAT_DEFAULT_LIMIT[def?.cat ?? ''] || (at === 'CHA' ? 'social' : ['LOG', 'INT', 'WIL'].includes(at as string) ? 'mental' : 'physical');
}
