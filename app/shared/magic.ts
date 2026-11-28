// Magic rules shared by the server (47-magic.ts) and the browser (client/modules/magic/). Pure: no Node or DOM API.
// Design and the features still to come: docs/design/magic.md. Rules: SR5 core, chapter Magic (pages cited inline);
// when a rule is ambiguous, do what Chummer5a does.
//
// Traditions (SR5 p. 279 and Street Grimoire / Forbidden Arcana): data/catalog/traditions.json, built from Chummer
// traditions.xml by tools/build-catalog.ts. An actor keeps a copy of its tradition in `actor.magic.tradition`
// (ActorTradition), so hand-made traditions and Chummer imports keep their own drain attribute and spirits.
import { attr, SKILL_BY_ID } from './sr5.ts';
import type { ActorLike, ActorTradition, AttrKey, Attributes, I18nParams, MagicState, NaturalAttack, NaturalAttackPower, Skill, SpellCategoryKey, Weapon } from './types.ts';

// i18n: labels are English dictionary keys (French in client/i18n/fr/magic.json). tk() marks them for tools/i18n-check.ts.
const tk = (s: string): string => s;

/** One entry of data/catalog/traditions.json. */
export interface TraditionDef {
  id: string;
  name: string;
  nameFr?: string;
  /** Second drain attribute (WIL + drain). Absent: chosen per character (Custom, Toxic). */
  drain?: AttrKey;
  spirits?: Partial<Record<SpellCategoryKey, string>>;
  source?: string;
  page?: number;
}

/** Attributes a tradition may pair with Willpower to resist Drain (Chummer data: LOG, CHA, INT; Draconic MAG; Romani WIL). */
export const DRAIN_ATTRS: AttrKey[] = ['LOG', 'CHA', 'INT', 'MAG', 'WIL'];
export const SPELL_CATEGORIES: SpellCategoryKey[] = ['combat', 'detection', 'health', 'illusion', 'manipulation'];

/** Values the character creator stored before it used the Chummer list → Chummer tradition names. */
export const LEGACY_CHARGEN_TRADITIONS: Record<string, string> = {
  Hermetic: 'Hermetic', Shamanic: 'Shamanic', Chaos: 'Chaos Magic', Druid: 'Druid', Buddhist: 'Buddhism', Shinto: 'Shinto',
  Wicca: 'Wicca, Gardnerian', Voodoo: 'Vodou', Other: 'Custom',
  // French values of drafts saved before 2026-11 (client/i18n/legacy-fr-keys.json)
  Hermétique: 'Hermetic', Chamanique: 'Shamanic', Druide: 'Druid', Bouddhiste: 'Buddhism', Vaudou: 'Vodou', Autre: 'Custom',
};

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** Tradition of the list by id, Chummer name, legacy creator value or French name (null when unknown). */
export function findTradition(list: readonly TraditionDef[], ref: string | null | undefined): TraditionDef | null {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const alias = LEGACY_CHARGEN_TRADITIONS[r];
  const n = norm(alias || r);
  return list.find((t) => t.id === r) || list.find((t) => norm(t.name) === n) || list.find((t) => norm(t.nameFr) === n) || null;
}

/** The copy stored on the actor (drain: the catalog's, else the given choice). */
export function traditionFromDef(def: TraditionDef, drain?: AttrKey | null): ActorTradition {
  const out: ActorTradition = { id: def.id, name: def.name, drain: def.drain || (drain && DRAIN_ATTRS.includes(drain) ? drain : null) };
  if (def.nameFr) out.nameFr = def.nameFr;
  if (def.spirits && Object.keys(def.spirits).length) out.spirits = { ...def.spirits };
  if (def.source) out.source = def.source;
  if (def.page) out.page = def.page;
  return out;
}

/** Chummer .chum5 « WIL + CHA » (or « {WIL} + {CHA} ») → 'CHA'; null when unreadable. */
export function parseDrainText(text: unknown): AttrKey | null {
  const m = String(text ?? '').toUpperCase().match(/WIL\W*\+\W*([A-Z]{3})/);
  return m && DRAIN_ATTRS.includes(m[1] as AttrKey) ? (m[1] as AttrKey) : null;
}

/** Display name of a tradition in a UI language. */
export function traditionName(t: { name: string; nameFr?: string } | null | undefined, lang: string): string {
  if (!t) return '';
  return lang === 'fr' && t.nameFr ? t.nameFr : t.name;
}

/** Traditions for a picker: Custom first, then by name in the UI language. */
export function sortTraditions<T extends { name: string; nameFr?: string }>(list: readonly T[], lang: string): T[] {
  const custom = (t: T) => (t.name === 'Custom' ? 0 : 1);
  return [...list].sort((a, b) => custom(a) - custom(b) || traditionName(a, lang).localeCompare(traditionName(b, lang), lang));
}

// ---------------------------------------------------------------------------
// Who does what
// ---------------------------------------------------------------------------

/** Skills that use a tradition (sorcery, conjuring, enchanting: SR5 p. 142-143). Adepts use none of them. */
export const TRADITION_SKILLS = [
  'spellcasting', 'ritual_spellcasting', 'counterspelling', 'summoning', 'binding', 'banishing', 'alchemy', 'artificing', 'disenchanting',
];

type MagicActor = ActorLike;

/** Has a Magic rating above 0 (magicians, mystic adepts, aspected, adepts). */
export function isAwakened(actor: MagicActor | null | undefined): boolean {
  return Number(actor?.attributes?.MAG ?? 0) > 0;
}

/** Casts, summons or enchants (needs a tradition): knows a spell or a sorcery / conjuring / enchanting skill. */
export function usesTradition(actor: MagicActor | null | undefined): boolean {
  if (!actor || !isAwakened(actor) || actor.spirit) return false; // a spirit casts with its own powers
  if ((actor.spells || []).length) return true;
  return (actor.skills || []).some((s) => TRADITION_SKILLS.includes(s.id) && Number(s.rating) > 0);
}

/** Second drain attribute of the actor's tradition (null: no tradition, or a custom one without a choice). */
export function drainAttr(actor: MagicActor | null | undefined): AttrKey | null {
  const d = actor?.magic?.tradition?.drain;
  return d && DRAIN_ATTRS.includes(d) ? d : null;
}

/**
 * Drain resistance pool before modifiers (SR5 p. 282: WIL + the tradition's attribute). The roll itself goes through
 * `dice/roll` with `test: 'drainResist'`, which adds the drain modifiers.
 */
export function drainPool(actor: MagicActor | null | undefined, second: AttrKey | null = drainAttr(actor)): { attrs: [AttrKey, AttrKey]; base: number } | null {
  if (!actor || !second) return null;
  return { attrs: ['WIL', second], base: attr(actor, 'WIL') + attr(actor, second) };
}

/** Spells the actor sustains itself (each one is −2 dice on every test, SR5 p. 282). */
export function sustainedBy(magic: Pick<MagicState, 'sustained'> | null | undefined, actorId: string): number {
  return Object.values(magic?.sustained || {}).filter((s) => s.casterId === actorId).length;
}
export const SUSTAIN_PENALTY = 2;

// ---------------------------------------------------------------------------
// Spellcasting (SR5 pp. 281-283)
// ---------------------------------------------------------------------------

/** Reckless Spellcasting: Simple Action instead of Complex, +3 Drain Value (SR5 p. 281). */
export const RECKLESS_DV = 3;
/** Drain Value never goes below 2 (SR5 p. 282). */
export const MIN_DRAIN = 2;

/** Highest Force a caster may choose: twice their Magic (SR5 p. 281). */
export const maxForce = (actor: MagicActor | null | undefined): number => Math.max(0, 2 * attr(actor, 'MAG'));

/**
 * Offset of a drain formula relative to the Force: 'F-3' / 'F−3' / 'F+1' / 'F' → -3 / -3 / 1 / 0. Null when the formula
 * is not « F ± n » (« Special », « 0 », empty): the caster gives the Drain Value.
 */
export function drainOffset(formula: unknown): number | null {
  const m = String(formula ?? '').replace(/\s+/g, '').replace(/[−–]/g, '-').match(/^F([+-]\d+)?$/i);
  return m ? Number(m[1] || 0) : null;
}

/** Drain Value of a spell at a Force (min 2, +3 when reckless); null when the formula cannot be computed. */
export function drainValue(formula: unknown, force: number, { reckless = false }: { reckless?: boolean } = {}): number | null {
  const off = drainOffset(formula);
  if (off === null) return null;
  return Math.max(MIN_DRAIN, force + off) + (reckless ? RECKLESS_DV : 0);
}

/** Drain is Physical when the hits (after the limit) exceed the caster's Magic, else Stun (SR5 p. 281). */
export const spellDrainType = (hits: number, magic: number): 'P' | 'S' => (hits > magic ? 'P' : 'S');

/** How a spell reaches its target, from its range: 'los' (Line of Sight), 'touch', 'self', or 'special'. */
export function spellReach(range: unknown): 'los' | 'touch' | 'self' | 'special' {
  const r = String(range ?? '').toUpperCase().replace(/\s*\(A\)\s*/, '').trim();
  if (r === 'LOS' || r === 'LDV' || r === 'LOS/T') return 'los';
  if (r === 'T' || r === 'C') return 'touch';
  if (r === 'S' || r === 'P') return 'self';
  return 'special';
}
/** Area spell: range noted « (A) » — a sphere of radius Force metres unless the spell says otherwise (SR5 p. 281). */
export const isAreaSpell = (range: unknown): boolean => /\(A\)/i.test(String(range ?? ''));

/**
 * Sustained spells whose effect is a plain number the app can apply to the target as a modifier. Keys: English and French
 * names, lower case. Others stay a text for the GM.
 */
export const SPELL_EFFECTS: Record<string, { page: number; effects: (hits: number) => Array<{ type: 'armor' | 'stat'; target?: string; value: number }> }> = {
  // Armor: Armor equal to the hits, cumulative with other armor (SR5 p. 293).
  armor: { page: 293, effects: (hits) => [{ type: 'armor', value: hits }] },
  armure: { page: 293, effects: (hits) => [{ type: 'armor', value: hits }] },
  // Combat Sense: +1 die per hit to defend against ranged and melee attacks (SR5 p. 288; surprise: GM).
  'combat sense': { page: 288, effects: (hits) => [{ type: 'stat', target: 'defense', value: hits }] },
  'sens du combat': { page: 288, effects: (hits) => [{ type: 'stat', target: 'defense', value: hits }] },
};
/** Numeric effects of a sustained spell with these hits ([] when the app does not apply it). */
export function spellEffects(spell: { name?: string; nameEn?: string; nameFr?: string } | null | undefined, hits: number): Array<{ type: 'armor' | 'stat'; target?: string; value: number }> {
  if (!spell || hits <= 0) return [];
  for (const n of [spell.nameEn, spell.name, spell.nameFr]) {
    const def = n ? SPELL_EFFECTS[String(n).trim().toLowerCase()] : null;
    if (def) return def.effects(hits);
  }
  return [];
}
/** Duration that can be sustained: Sustained (S), or Permanent (P) until it sets (SR5 p. 283). */
export const isSustainable = (duration: unknown): boolean => /^(S|P)$/i.test(String(duration ?? '').trim());

// ---------------------------------------------------------------------------
// Combat spells (SR5 p. 283): Direct = resisted with BOD (physical) / WIL (mana), net hits are the damage, no soak;
// Indirect = dodged like a ranged attack (REA + INT), DV = Force + net hits, AP = −Force, soaked with BOD + armor.
// ---------------------------------------------------------------------------

/** What the spells catalog says of a spell (data/catalog/spells.json: stats.descriptor, stats.damage). */
export interface SpellCatalogInfo {
  descriptor: string;
  damage: string;
}
export type SpellElement = 'fire' | 'acid' | 'electricity' | 'cold';
/** Elemental damage of indirect spells: the extra effect is the GM's (SR5 pp. 170-171). */
export const ELEMENTS: Record<SpellElement, { name: string; page: number; re: RegExp }> = {
  fire: { name: tk('Fire'), page: 171, re: /fire|flame|incendi|feu|flamme/i },
  acid: { name: tk('Acid'), page: 170, re: /acid|toxic wave|acide|vague toxique/i },
  electricity: { name: tk('Electricity'), page: 170, re: /lightning|electr|électr|foudre/i },
  cold: { name: tk('Cold'), page: 170, re: /\bice\b|frost|cold|glace|givre|froid/i },
};

/** How a combat spell hits: Direct / Indirect, the resistance attribute of a direct one, its damage type and element. */
export interface CombatSpellProfile {
  mode: 'direct' | 'indirect';
  /** Direct spells: BOD (physical spell) or WIL (mana spell). */
  resist: 'BOD' | 'WIL';
  damage: 'P' | 'S';
  element: SpellElement | null;
  /** Mana spells only affect living beings and astral forms (SR5 p. 282). */
  mana: boolean;
}

/**
 * Profile of a combat spell from the catalog (descriptor, damage) or, for a hand-made spell, from its type and name:
 * mana → direct; physical → indirect when its name is elemental, else direct; Stun when the name says so.
 */
export function combatSpellProfile(spell: { type?: string; name?: string; nameEn?: string; nameFr?: string } | null | undefined, info: SpellCatalogInfo | null): CombatSpellProfile {
  const mana = /^M/i.test(String(spell?.type ?? '').trim());
  const names = [spell?.nameEn, spell?.name, spell?.nameFr].filter(Boolean).join(' ');
  const element = (Object.keys(ELEMENTS) as SpellElement[]).find((k) => ELEMENTS[k].re.test(names)) || null;
  const d = String(info?.descriptor || '');
  const mode: 'direct' | 'indirect' = /indirect/i.test(d) ? 'indirect' : /direct/i.test(d) ? 'direct' : !mana && element ? 'indirect' : 'direct';
  const dmg = String(info?.damage || '').trim().toUpperCase();
  const damage: 'P' | 'S' = dmg === 'S' ? 'S' : dmg === 'P' ? 'P' : /stun|étourdi|etourdi/i.test(names) ? 'S' : 'P';
  return { mode, resist: mana ? 'WIL' : 'BOD', damage, element: mode === 'indirect' ? element : /elemental/i.test(d) ? element : null, mana };
}
// ---------------------------------------------------------------------------
// Non-combat spells: the target's resistance (Opposed Test), from the catalog descriptor (SR5 pp. 285-292)
// ---------------------------------------------------------------------------

/** How a non-combat spell is resisted: the target's attributes, the book page, and whether an object can be targeted. */
export interface SpellResistance {
  attrs: AttrKey[];
  page: number;
  /** An object resists with its Object Resistance (SR5 p. 295). */
  objects: boolean;
  /** Text key of the rule shown in the cast modal. */
  rule: string;
}
const ATTR_CHOICE: Record<string, AttrKey> = {
  body: 'BOD', agility: 'AGI', reaction: 'REA', strength: 'STR', willpower: 'WIL', logic: 'LOG', intuition: 'INT', charisma: 'CHA',
  constitution: 'BOD', agilite: 'AGI', force: 'STR', volonte: 'WIL', logique: 'LOG', charisme: 'CHA', // French (accents stripped)
};
/** Attribute named by a spell's choice / name (« Decrease [Body] », choice « Agilité »), or null. */
export function attributeOfSpell(spell: { choice?: string | null; name?: string; nameEn?: string } | null | undefined): AttrKey | null {
  for (const raw of [spell?.choice, (spell?.nameEn || spell?.name || '').match(/\[([^\]]+)\]/)?.[1]]) {
    const k = String(raw || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!k) continue;
    if (ATTR_CHOICE[k]) return ATTR_CHOICE[k];
    const up = k.toUpperCase();
    if (['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA'].includes(up)) return up as AttrKey;
  }
  return null;
}

/**
 * Resistance of a non-combat spell (null: none, the caster's hits alone count):
 * - Detection, Active: LOG + WIL (+ counterspelling) for the living, Object Resistance for objects (SR5 p. 285); Passive: none.
 * - Health: none, but a Negative spell (Decrease [Attribute]) is opposed by that attribute + WIL (SR5 p. 288).
 * - Illusion: mana → LOG + WIL, physical → INT + LOG or Object Resistance; Obvious illusions: none (SR5 p. 290).
 * - Manipulation: Mental → LOG + WIL; Physical → BOD + STR or Object Resistance; Environmental: none (SR5 p. 292).
 */
export function spellResistance(spell: { category?: string; type?: string; choice?: string | null; name?: string; nameEn?: string; nameFr?: string } | null | undefined, info: SpellCatalogInfo | null): SpellResistance | null {
  const cat = spellCategory(spell?.category);
  const d = String(info?.descriptor || '');
  const mana = /^M/i.test(String(spell?.type ?? '').trim());
  if (cat === 'detection') return /active/i.test(d) ? { attrs: ['LOG', 'WIL'], page: 285, objects: true, rule: tk('Active detection: the target resists with Logic + Willpower (+ Counterspelling); an object with its Object Resistance') } : null;
  if (cat === 'health') {
    // Decrease [Attribute] is not tagged Negative in Chummer's data: matched by name too.
    if (!/negative/i.test(d) && !/decrease|diminu/i.test([spell?.nameEn, spell?.name, spell?.nameFr].filter(Boolean).join(' '))) return null;
    const a = attributeOfSpell(spell);
    return { attrs: a && a !== 'WIL' ? [a, 'WIL'] : ['WIL'], page: 288, objects: false, rule: tk('Negative health spell: the target resists with the attribute + Willpower') };
  }
  if (cat === 'illusion') {
    if (/obvious/i.test(d)) return null;
    return mana
      ? { attrs: ['LOG', 'WIL'], page: 290, objects: false, rule: tk('Mana illusion: the target resists with Logic + Willpower') }
      : { attrs: ['INT', 'LOG'], page: 290, objects: true, rule: tk('Physical illusion: the target resists with Intuition + Logic; a device with its Object Resistance') };
  }
  if (cat === 'manipulation') {
    if (/\bmental\b/i.test(d)) return { attrs: ['LOG', 'WIL'], page: 292, objects: false, rule: tk('Mental manipulation: the target resists with Logic + Willpower') };
    if (/\bphysical\b/i.test(d)) return { attrs: ['BOD', 'STR'], page: 292, objects: true, rule: tk('Physical manipulation: a living target resists with Body + Strength, an object with its Object Resistance') };
    return null;
  }
  return null;
}

/** Object Resistance dice pool (SR5 p. 295). */
export const OBJECT_RESISTANCE: Array<{ value: number; name: string }> = [
  { value: 3, name: tk('Natural object (3)') },
  { value: 6, name: tk('Manufactured low-tech (6)') },
  { value: 9, name: tk('Manufactured high-tech (9)') },
  { value: 15, name: tk('Highly processed: computer, drone, vehicle (15)') },
];

/** NPC kinds a mana spell cannot affect (no aura: drones, IC, hosts). */
export const NO_AURA_KINDS = ['drone', 'ic', 'host'];

/** Spell category (stored English or French) → its key ('combat', 'detection'…), null when unknown. */
export function spellCategory(category: unknown): SpellCategoryKey | null {
  const c = String(category ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (c.startsWith('combat')) return 'combat';
  if (c.startsWith('detect')) return 'detection';
  if (c.startsWith('health') || c.startsWith('sante')) return 'health';
  if (c.startsWith('illusion')) return 'illusion';
  if (c.startsWith('manipulation')) return 'manipulation';
  return null;
}

// ---------------------------------------------------------------------------
// Spirits (SR5 pp. 300-304): data/catalog/spirits.json, built from Chummer critters.xml (category Spirits)
// ---------------------------------------------------------------------------

/** A power of a spirit (Chummer name, French name, the choice « Fire » of Elemental Attack…). */
export interface SpiritPower {
  name: string;
  nameFr?: string;
  select?: string;
}
/** One entry of data/catalog/spirits.json: attributes and initiative are Force formulas (« F+1 », « (F*2)+3 », « F/2 »). */
export interface SpiritDef {
  id: string;
  name: string;
  nameFr?: string;
  attrs: Record<string, string>;
  initiative?: string;
  /** Physical initiative dice (SR5 spirits: 2D6). */
  initiativeDice?: number;
  powers: SpiritPower[];
  optionalPowers: SpiritPower[];
  skills: Array<{ name: string; rating: string; spec?: string }>;
  movement?: { walk?: string; run?: string; sprint?: string };
  source?: string;
  page?: number;
}

/**
 * A Force formula of the spirits data at a Force: F, F+n, F-n, F/2, (F*2)+3, numbers. Only digits, F, + − × ÷ and
 * parentheses are accepted (anything else → 0); results are rounded down, never below 0.
 */
export function evalForce(formula: unknown, force: number): number {
  const src = String(formula ?? '').replace(/\s+/g, '').toUpperCase();
  if (!src) return 0;
  if (!/^[0-9F+\-*/().]+$/.test(src)) return 0;
  // Recursive descent over + - * / and parentheses (no eval).
  let i = 0;
  const peek = () => src[i];
  const num = (): number => {
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() === ')') i++;
      return v;
    }
    if (peek() === 'F') {
      i++;
      return force;
    }
    if (peek() === '-') {
      i++;
      return -num();
    }
    let j = i;
    while (j < src.length && /[0-9.]/.test(src[j])) j++;
    const v = Number(src.slice(i, j));
    i = j;
    return Number.isFinite(v) ? v : 0;
  };
  const term = (): number => {
    let v = num();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = num();
      v = op === '*' ? v * r : r ? v / r : 0;
    }
    return v;
  };
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  return Math.max(0, Math.floor(v));
}

/** Spirit skill names of the Chummer data that are not the app's id once lower-cased with underscores. */
const SPIRIT_SKILL_ALIASES: Record<string, string> = { 'exotic ranged weapon': 'exotic_weapon', 'exotic melee weapon': 'exotic_weapon' };
/** Critter skills the app does not list: kept as custom skills (Flight: SR5 p. 401, linked to Agility). */
const CRITTER_SKILLS: Record<string, { name: string; attr: AttrKey }> = { flight: { name: 'Flight', attr: 'AGI' } };

/** Optional powers a spirit may take: one per 3 full points of Force (SR5 p. 300). */
export const optionalPowerCount = (force: number): number => Math.max(0, Math.floor(force / 3));

/**
 * A spirit of this Force as actor fields (SR5 pp. 303-304): attributes, physical initiative (the formula's base: the
 * bonus over REA + INT, and its dice), astral initiative (F × 2 + 3D6), skills at their rating, powers.
 */
export function spiritStats(def: SpiritDef, force: number): {
  attributes: Attributes;
  initiative: { dice: number; bonus: number };
  initiativeBase: number;
  astralInitiative: { base: number; dice: number };
  skills: Skill[];
  powers: SpiritPower[];
  optionalPowers: number;
} {
  const F = Math.max(1, Math.round(force));
  const v = (k: string) => evalForce(def.attrs[k] ?? '0', F);
  const attributes: Attributes = {
    BOD: Math.max(1, v('BOD')), AGI: Math.max(1, v('AGI')), REA: Math.max(1, v('REA')), STR: Math.max(1, v('STR')),
    WIL: Math.max(1, v('WIL')), LOG: Math.max(1, v('LOG')), INT: Math.max(1, v('INT')), CHA: Math.max(1, v('CHA')),
    EDG: v('EDG'), MAG: v('MAG') || F, ESS: v('ESS') || F,
  };
  const base = def.initiative ? evalForce(def.initiative, F) : attributes.REA + attributes.INT;
  const skills: Skill[] = [];
  for (const s of def.skills || []) {
    const key = s.name.trim().toLowerCase();
    const id = SPIRIT_SKILL_ALIASES[key] || key.replace(/[^a-z]+/g, '_');
    const sk = SKILL_BY_ID[id];
    const custom = CRITTER_SKILLS[id];
    if (!sk && !custom) continue;
    if (skills.some((x) => x.id === id)) continue;
    skills.push({ id, name: sk ? sk.fr : custom.name, attr: (sk ? sk.attr : custom.attr) as AttrKey, rating: evalForce(s.rating || 'F', F), ...(s.spec ? { spec: s.spec } : {}) });
  }
  return {
    attributes,
    initiative: { dice: Math.max(0, (def.initiativeDice || 1) - 1), bonus: base - attributes.REA - attributes.INT },
    initiativeBase: base,
    astralInitiative: { base: F * 2, dice: 3 },
    skills,
    powers: def.powers || [],
    optionalPowers: optionalPowerCount(F),
  };
}

// ---------------------------------------------------------------------------
// Natural attacks of spirits (SR5 pp. 187, 396-399): weapons derived from the powers, so the attack pipeline handles them
// ---------------------------------------------------------------------------

/** Elements of critter powers (Chummer strings.xml « elements », plus the four elemental spirits), with their French names. */
const NATURAL_ELEMENTS: Record<string, string> = {
  fire: 'Feu', air: 'Air', water: 'Eau', earth: 'Terre', acid: 'Acide', cold: 'Froid', electricity: 'Électricité', pollutant: 'Polluant', radiation: 'Radiation',
};
const elementIn = (text: unknown): string | null => {
  const s = String(text ?? '').toLowerCase();
  return Object.keys(NATURAL_ELEMENTS).find((k) => new RegExp(`\\b${k}\\b`).test(s)) || null;
};
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const ELEMENT_LABELS: Record<string, string> = {
  fire: tk('Fire'), air: tk('Air'), water: tk('Water'), earth: tk('Earth'), acid: tk('Acid'), cold: tk('Cold'), electricity: tk('Electricity'), pollutant: tk('Pollutant'), radiation: tk('Radiation'),
};
/** Dictionary key of an element (« fire » → « Fire »), the element itself when unknown. */
export const elementLabel = (el: string): string => ELEMENT_LABELS[el] || el;

/** What spiritWeapons() reads: the actor id, its powers (English names, Chummer choice) and its spirit data. */
export interface NaturalWeaponsInput {
  id: string;
  powers?: Array<{ name: string; choice?: string | null }> | null;
  spirit?: { type: string; force: number } | null;
}
const powerOf = (a: NaturalWeaponsInput, name: string) => (a.powers || []).find((p) => String(p?.name || '').trim().toLowerCase() === name);

/**
 * Element of a spirit's powers: the choice of its Elemental Attack (« Fire »), else its type (Spirit of Fire → fire), else
 * null (a spirit of man, a plant spirit… whose Engulf has no element).
 */
export function spiritElement(a: NaturalWeaponsInput): string | null {
  return elementIn(powerOf(a, 'elemental attack')?.choice) || elementIn(powerOf(a, 'energy aura')?.choice) || elementIn(a.spirit?.type);
}

/** « DV (Force)P, AP 0 », « DV {STR}P, AP -1 » (Natural Weapon choices of the spirits data) → a damage code and AP, or null. */
export function parseNaturalWeapon(choice: unknown, force: number): { damage: string; ap: number } | null {
  const m = String(choice ?? '').match(/DV\s*\(?\s*\{?\s*(STR|Force|F|\d+)\s*\}?\s*([+-]\s*\d+)?\s*\)?\s*([PS])\s*,\s*AP\s*([+\-−–]?\s*\d+)/i);
  if (!m) return null;
  const add = Number((m[2] || '0').replace(/\s/g, ''));
  const type = m[3].toUpperCase();
  const ap = Number(m[4].replace(/[−–]/, '-').replace(/\s/g, ''));
  if (/^str$/i.test(m[1])) return { damage: `(STR${add ? (add > 0 ? '+' : '') + add : ''})${type}`, ap };
  const base = /^(force|f)$/i.test(m[1]) ? force : Number(m[1]);
  return { damage: `${Math.max(0, base + add)}${type}`, ap };
}

/**
 * The natural attacks of a spirit at its Force (Magic = Force), as sheet weapons with `natural`:
 * - unarmed attack (SR5 p. 187: Unarmed Combat + AGI [Physical], DV (STR)S); with Energy Aura (p. 396) DV (STR + Magic)P,
 *   AP −Magic, elemental;
 * - Elemental Attack (p. 396): Exotic Ranged Weapon + AGI [Physical], DV (Magic × 2)P, AP −Magic, range increments of
 *   Magic meters;
 * - Engulf (p. 396): a melee attack (Unarmed Combat), DV Magic × 2, AP −Magic; Stun for air and water, else Physical;
 * - Natural Weapon (p. 399): the DV and AP of its choice (« DV (Force)P, AP 0 »).
 * Ids are stable per actor (`<actorId>-nat-…`) so rebuilding them keeps the sheet's references.
 */
export function spiritWeapons(a: NaturalWeaponsInput): Weapon[] {
  if (!a.spirit) return [];
  const F = Math.max(1, Math.round(Number(a.spirit.force) || 1));
  const el = spiritElement(a);
  const elEn = el ? capitalize(el) : '';
  const elFr = el ? NATURAL_ELEMENTS[el] : '';
  const withEl = (en: string, fr: string) => (el ? { en: `${en} (${elEn})`, fr: `${fr} (${elFr})` } : { en, fr });
  const make = (key: string, names: { en: string; fr: string }, w: Pick<Weapon, 'kind' | 'skill' | 'damage' | 'ap' | 'page'> & { natural: NaturalAttack }): Weapon => ({
    id: `${a.id}-nat-${key}`, name: names.en, nameEn: names.en, nameFr: names.fr,
    category: 'Natural attack', categoryEn: 'Natural attack', categoryFr: 'Attaque naturelle',
    accuracy: 'Physical', mode: '', rc: 0, ammo: '', reach: 0, equipped: true, source: 'SR5', ...w,
  });
  const out: Weapon[] = [];
  const aura = !!powerOf(a, 'energy aura');
  out.push(make('unarmed', { en: 'Unarmed Attack', fr: 'Attaque à mains nues' }, aura
    ? { kind: 'melee', skill: 'unarmed_combat', damage: `(STR+${F})P`, ap: -F, page: 396, natural: { power: 'unarmed', element: el, aura: true } }
    : { kind: 'melee', skill: 'unarmed_combat', damage: '(STR)S', ap: 0, page: 187, natural: { power: 'unarmed', element: null } }));
  if (powerOf(a, 'elemental attack')) {
    out.push(make('elemental', withEl('Elemental Attack', 'Attaque élémentaire'), {
      kind: 'ranged', skill: 'exotic_weapon', damage: `${F * 2}P`, ap: -F, page: 396, natural: { power: 'elementalAttack', element: el, rangeStep: F },
    }));
  }
  if (powerOf(a, 'engulf')) {
    const stun = el === 'air' || el === 'water';
    out.push(make('engulf', withEl('Engulf', 'Engloutissement'), {
      kind: 'melee', skill: 'unarmed_combat', damage: `${F * 2}${stun ? 'S' : 'P'}`, ap: -F, page: 396, natural: { power: 'engulf', element: el },
    }));
  }
  (a.powers || []).filter((p) => String(p?.name || '').trim().toLowerCase() === 'natural weapon').forEach((p, i) => {
    const nw = parseNaturalWeapon(p.choice, F);
    if (nw) {
      out.push(make(`weapon${i ? i + 1 : ''}`, { en: 'Natural Weapon', fr: 'Arme naturelle' }, {
        kind: 'melee', skill: 'unarmed_combat', damage: nw.damage, ap: nw.ap, page: 399, natural: { power: 'naturalWeapon', element: null },
      }));
    }
  });
  return out;
}

/** Rule text of a natural attack (English dictionary key, French in magic.json), shown under the weapon on the sheet. */
export function naturalAttackRule(n: NaturalAttack | null | undefined): string | null {
  if (!n) return null;
  switch (n.power) {
    case 'unarmed':
      return n.aura
        ? tk('Energy Aura: +Magic to the DV, AP −Magic, elemental damage. A melee attacker who hits the spirit resists Magic × 2 DV, AP −Magic (SR5 p. 396).')
        : tk('Unarmed Combat + Agility [Physical], DV (STR)S (SR5 p. 187).');
    case 'elementalAttack':
      return tk('Exotic Ranged Weapon + Agility [Physical], DV Magic × 2 P, AP −Magic; range increments of Magic meters (SR5 p. 396).');
    case 'engulf':
      return n.element === 'air'
        ? tk('Melee attack, DV Magic × 2, AP −Magic. Air: resisted like an inhalation toxin, armor doesn’t protect (GM). The target is trapped: damage again on each of the spirit’s Action Phases; escape: Complex Action, STR + BOD vs MAG + BOD (SR5 p. 396).')
        : tk('Melee attack, DV Magic × 2, AP −Magic. The target is trapped: damage again on each of the spirit’s Action Phases; escape: Complex Action, STR + BOD vs MAG + BOD (SR5 p. 396).');
    case 'naturalWeapon':
      return tk('Unarmed Combat + Agility [Physical] (SR5 p. 399).');
    default:
      return null;
  }
}

/** Energy Aura of a critter (SR5 p. 396): melee attackers that hit it take Magic × 2 DV, AP −Magic. */
export function hasEnergyAura(a: { powers?: Array<{ name: string }> | null } | null | undefined): boolean {
  return !!(a?.powers || []).some((p) => String(p?.name || '').trim().toLowerCase() === 'energy aura');
}

// ---------------------------------------------------------------------------
// Foci (SR5 pp. 318-320)
// ---------------------------------------------------------------------------

export type FocusKind =
  | 'spellcasting' | 'counterspelling' | 'ritual' | 'sustaining' | 'summoning' | 'banishing' | 'binding' | 'power' | 'weapon' | 'qi'
  | 'alchemical' | 'disenchanting' | 'centering' | 'masking' | 'flexibleSignature' | 'spellShaping';
type GearLike = { name?: string; nameEn?: string; nameFr?: string; category?: string; rating?: number | null; bonded?: boolean; active?: boolean; choice?: string | null; id?: string };
const FOCUS_KINDS: Array<[FocusKind, RegExp]> = [
  ['counterspelling', /counterspelling|contresort/i], ['ritual', /ritual|rituel/i], ['sustaining', /sustaining|maintien/i], ['spellcasting', /spellcasting|lancement de sorts/i],
  ['summoning', /summoning|invocation/i], ['banishing', /banishing|bannissement/i], ['binding', /binding|\blien\b/i], ['power', /power focus|focus de puissance/i],
  ['weapon', /weapon focus|focus d.arme/i], ['qi', /qi focus|focus de qi/i], ['alchemical', /alchemical|alchimi/i], ['disenchanting', /disenchanting|désenchant|desenchant/i],
  ['centering', /centering|centrage/i], ['masking', /masking|masque/i], ['flexibleSignature', /flexible signature|signature flexible/i], ['spellShaping', /spell shaping|façonnage/i],
];
/** The kind of a focus item (gear of category Foci, or named « … Focus »), or null for any other gear. */
export function focusKind(g: GearLike | null | undefined): FocusKind | null {
  if (!g) return null;
  const names = [g.nameEn, g.name, g.nameFr].filter(Boolean).join(' ');
  if (g.category !== 'Foci' && g.category !== 'Focus' && !/\bfocus\b|\bfoci\b/i.test(names)) return null;
  for (const [k, re] of FOCUS_KINDS) if (re.test(names)) return k;
  return null;
}
/** Bonding cost multiplier (SR5 p. 318, Focus Table): Force × this in karma. */
export function focusBondMultiplier(kind: FocusKind | null): number {
  if (kind === 'power') return 6;
  if (kind === 'weapon' || kind === 'alchemical' || kind === 'disenchanting' || kind === 'centering' || kind === 'masking' || kind === 'flexibleSignature' || kind === 'spellShaping') return 3;
  return 2; // spell, spirit and qi foci
}
/** Spell category of a spell focus (« Sustaining Focus, Combat »), or null. */
export const focusCategory = (g: GearLike | null | undefined): SpellCategoryKey | null => {
  const m = [g?.nameEn, g?.name, g?.nameFr].filter(Boolean).join(' ').match(/combat|detection|détection|health|santé|illusion|manipulation/i);
  return m ? spellCategory(m[0]) : null;
};
export const focusForce = (g: GearLike | null | undefined): number => Math.max(0, Math.round(Number(g?.rating) || 0));
/** A focus counts when bonded (absent on older sheets = bonded) and active (SR5 p. 318). */
export const focusWorks = (g: GearLike | null | undefined): boolean => !!g && g.bonded !== false && !!g.active;

/**
 * Bonding limits (SR5 p. 318): no more bonded foci than Magic, their total Force ≤ Magic × 5; addiction risk when the
 * active foci's total Force exceeds Magic (p. 319).
 */
export function fociLimits(actor: MagicActor | null | undefined) {
  const mag = attr(actor, 'MAG');
  const foci = ((actor?.gear || []) as GearLike[]).filter((g) => focusKind(g));
  const bonded = foci.filter((g) => g.bonded !== false);
  const active = bonded.filter((g) => g.active);
  const sum = (l: GearLike[]) => l.reduce((s, g) => s + focusForce(g), 0);
  return { mag, bonded: bonded.length, maxBonded: mag, force: sum(bonded), maxForce: mag * 5, activeForce: sum(active), addiction: sum(active) > mag };
}

/** Spell Shaping limit (SR5 p. 326): Magic, + the Force of an active spell shaping focus (p. 319). */
export function spellShapingMax(actor: MagicActor | null | undefined): number {
  const focus = ((actor?.gear || []) as GearLike[]).filter((g) => focusKind(g) === 'spellShaping' && focusWorks(g)).reduce((m, g) => Math.max(m, focusForce(g)), 0);
  return attr(actor, 'MAG') + focus;
}

/**
 * Metamagic modifiers (shared/modifiers collectModifiers): Centering +grade (+ an active centering focus's Force) on Drain
 * Resistance, Shielding +grade on Counterspelling (SR5 pp. 319, 325-326).
 */
export function metamagicEffects(actor: MagicActor | null | undefined): Array<{ id: MetamagicId; name: string; page: number; effects: Array<{ type: string; target: string; value: number }> }> {
  const grade = initiateGrade(actor);
  if (!grade) return [];
  const out: ReturnType<typeof metamagicEffects> = [];
  if (hasMetamagic(actor, 'centering')) {
    const focus = ((actor?.gear || []) as GearLike[]).filter((g) => focusKind(g) === 'centering' && focusWorks(g)).reduce((m, g) => Math.max(m, focusForce(g)), 0);
    out.push({ id: 'centering', name: 'Centering', page: 325, effects: [{ type: 'stat', target: 'drainResist', value: grade + focus }] });
  }
  if (hasMetamagic(actor, 'shielding')) out.push({ id: 'shielding', name: 'Shielding', page: 326, effects: [{ type: 'skill', target: 'counterspelling', value: grade }] });
  return out;
}

/**
 * Modifiers of the foci the catalog leaves without effects (shared/modifiers collectModifiers adds them for a bonded, active
 * focus): Counterspelling +Force (same category), Summoning / Binding +Force (the spirit type), Banishing +Force limit,
 * weapon focus +Force on its weapon (`choice` = weapon id) and on Astral Combat (SR5 pp. 319-320).
 */
export function focusEffects(g: GearLike): Array<{ type: string; target: string | null; value: number; condition?: string }> {
  const k = focusKind(g);
  const F = focusForce(g);
  if (!k || !F) return [];
  const cat = focusCategory(g);
  switch (k) {
    case 'counterspelling':
      return [{ type: 'skill', target: 'counterspelling', value: F, ...(cat ? { condition: `spell-${cat}` } : {}) }];
    case 'ritual':
      return [{ type: 'skill', target: 'ritual_spellcasting', value: F, ...(cat ? { condition: `spell-${cat}` } : {}) }];
    case 'summoning':
      return [{ type: 'skill', target: 'summoning', value: F, condition: 'q-spirit-type' }];
    case 'binding':
      return [{ type: 'skill', target: 'binding', value: F, condition: 'q-spirit-type' }];
    case 'weapon':
      return [...(g.choice ? [{ type: 'weaponPool', target: String(g.choice), value: F }] : []), { type: 'skill', target: 'astral_combat', value: F }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Astral (SR5 pp. 312-315)
// ---------------------------------------------------------------------------

/** Astral perception: magicians, or adepts with the Astral Perception power (SR5 p. 312). */
export function canPerceiveAstral(actor: MagicActor | null | undefined): boolean {
  if (!actor || !isAwakened(actor) || actor.spirit) return false;
  if (usesTradition(actor)) return true;
  return (actor.powers || []).some((p) => /astral perception|perception astrale/i.test([p?.name, p?.nameEn, p?.nameFr].filter(Boolean).join(' ')));
}
/** Astral projection: full magicians only (SR5 p. 313). */
export const canProjectAstral = (actor: MagicActor | null | undefined): boolean => !!actor && usesTradition(actor);
/** A projecting magician's astral form uses mental attributes in place of physical ones (SR5 p. 314, Astral Attributes table). */
export const ASTRAL_ATTRIBUTES: Record<string, AttrKey> = { AGI: 'LOG', BOD: 'WIL', REA: 'INT', STR: 'CHA' };

// ---------------------------------------------------------------------------
// Metamagic (SR5 pp. 325-326): actor.magic.metamagics holds names (training); the table says what the app applies.
// ---------------------------------------------------------------------------

export type MetamagicId = 'adeptCentering' | 'centering' | 'shielding' | 'quickening' | 'spellShaping' | 'masking' | 'flexibleSignature' | 'fixation' | 'powerPoint';
export interface MetamagicDef {
  id: MetamagicId;
  re: RegExp;
  /** UI key. */
  name: string;
  page: number;
  /** 'auto' = applied by the app, 'some' = partly, 'gm' = text for the GM. */
  auto: 'auto' | 'some' | 'gm';
  /** UI key: the rule and what the app does. */
  rule: string;
}
export const METAMAGICS: MetamagicDef[] = [
  { id: 'adeptCentering', re: /adept centering|centrage d.adepte/i, name: tk('Adept Centering'), page: 325, auto: 'gm', rule: tk('Reduce negative dice pool modifiers on Physical and Combat skills by your grade while you center: applied by the GM.') },
  { id: 'centering', re: /centering|centrage/i, name: tk('Centering'), page: 325, auto: 'auto', rule: tk('+grade dice on every Drain Resistance Test (+ the Force of an active centering focus): applied.') },
  { id: 'shielding', re: /shielding|protection|bouclier/i, name: tk('Shielding'), page: 326, auto: 'auto', rule: tk('+grade dice to your spell defense: added to Counterspelling.') },
  { id: 'quickening', re: /quickening|stabilisation|vivification/i, name: tk('Quickening'), page: 326, auto: 'auto', rule: tk('Spend 1 to Force karma on a sustained spell: it becomes permanent, without the −2 (« Quicken » on the spell).') },
  { id: 'spellShaping', re: /spell shaping|façonnage/i, name: tk('Spell Shaping'), page: 326, auto: 'auto', rule: tk('−1 die per metre added to or taken from an area spell’s radius, up to your Magic (cast modal).') },
  { id: 'masking', re: /masking|masque/i, name: tk('Masking'), page: 326, auto: 'gm', rule: tk('Disguise your aura; assensing it is opposed by Magic + grade: applied by the GM.') },
  { id: 'flexibleSignature', re: /flexible signature|signature flexible/i, name: tk('Flexible Signature'), page: 326, auto: 'gm', rule: tk('Alter or forge your astral signature (+grade to the Assensing threshold): applied by the GM.') },
  { id: 'fixation', re: /fixation/i, name: tk('Fixation'), page: 325, auto: 'gm', rule: tk('Karma in an alchemical preparation slows its decay: applied by the GM.') },
  { id: 'powerPoint', re: /power point|point de pouvoir/i, name: tk('Power Point'), page: 326, auto: 'auto', rule: tk('Adepts: a Power Point instead of a metamagic (Advancement).') },
];
/** The definition of a metamagic name (English or French), or null. */
export function metamagicDef(name: unknown): MetamagicDef | null {
  const n = String(name ?? '').trim();
  return n ? METAMAGICS.find((m) => m.re.test(n)) || null : null;
}
export const initiateGrade = (actor: MagicActor | null | undefined): number => Math.max(0, Math.round(Number((actor?.magic as { initiation?: number } | null | undefined)?.initiation) || 0));
export const hasMetamagic = (actor: MagicActor | null | undefined, id: MetamagicId): boolean => ((actor?.magic as { metamagics?: string[] } | null | undefined)?.metamagics || []).some((n) => metamagicDef(n)?.id === id);

// ---------------------------------------------------------------------------
// Ritual spellcasting (SR5 pp. 295-296) and teamwork (p. 49)
// ---------------------------------------------------------------------------

/**
 * Teamwork (SR5 p. 49): each assistant hit adds a die to the leader (at most the leader's skill rating); each assistant with
 * at least one hit and no glitch raises the leader's limit by 1, none at all if an assistant critically glitched.
 */
export function teamwork(assists: Array<{ hits: number; glitch?: boolean; critGlitch?: boolean }>, leaderSkill: number): { dice: number; limit: number } {
  const dice = Math.min(Math.max(0, leaderSkill), assists.reduce((s, a) => s + Math.max(0, a.hits), 0));
  const limit = assists.some((a) => a.critGlitch) ? 0 : assists.filter((a) => a.hits > 0 && !a.glitch).length;
  return { dice, limit };
}
/** Ritual Drain (SR5 p. 296): 2 × the opposition's hits, −1 per extra (Force) drams of reagents, never below 2. */
export const ritualDrain = (oppositionHits: number, extraOfferings = 0): number => Math.max(MIN_DRAIN, 2 * oppositionHits - Math.max(0, extraOfferings));
/** A ritual is a spell of the « Rituals » category (Chummer); any spell can be woven into a Spell ritual. */
export const isRitual = (s: { category?: string } | null | undefined): boolean => /ritu/i.test(String(s?.category || ''));

/** Binding costs Force × 25 drams of reagents (SR5 p. 300). */
export const BINDING_DRAMS = 25;
/** Reagents of the gear (« Reagents », « Réactifs »…): their quantity counts as drams. */
export const isReagent = (g: { name?: string; nameFr?: string; nameEn?: string } | null | undefined): boolean => /reagent|réactif|reactif/i.test([g?.name, g?.nameEn, g?.nameFr].filter(Boolean).join(' '));
/** Drams of reagents an actor carries. */
export const reagentDrams = (actor: { gear?: Array<{ name?: string; nameFr?: string; nameEn?: string; qty?: number }> | null } | null | undefined): number =>
  (actor?.gear || []).filter(isReagent).reduce((s, g) => s + Math.max(0, Number(g.qty) || 0), 0);

/**
 * The bound spirit that can aid a spell (SR5 p. 302, Aid Sorcery): its type is the tradition's spirit of the spell's
 * category. Returns the spirit types per category of the tradition.
 */
export function aidSpiritType(tradition: ActorTradition | null | undefined, category: unknown): string | null {
  const cat = spellCategory(category);
  return cat ? tradition?.spirits?.[cat] || null : null;
}

/** Spirit types a tradition summons (its five spirits, without duplicates), or every type of the data. */
export function traditionSpiritTypes(tradition: ActorTradition | null | undefined, all: readonly SpiritDef[]): SpiritDef[] {
  const names = [...new Set(Object.values(tradition?.spirits || {}).filter(Boolean) as string[])];
  if (!names.length) return [...all];
  return names.map((n) => all.find((d) => d.name === n)).filter((d): d is SpiritDef => !!d);
}

// ---------------------------------------------------------------------------
// Next-step hints of the cockpit (players), as the Matrix « Hints »
// ---------------------------------------------------------------------------

export interface MagicHint {
  key: string;
  tone: 'info' | 'warn' | 'danger';
  params?: I18nParams;
  /** Cockpit control the hint points at. */
  action?: 'tradition' | 'drain';
}

const TONE_RANK: Record<string, number> = { danger: 0, warn: 1, info: 2 };

/** Hints for one actor, most urgent first (pure: works on the player's filtered view). */
export function magicHints({ actor, magic, spirits }: { actor: MagicActor | null | undefined; magic: Pick<MagicState, 'sustained'> | null | undefined; spirits?: MagicActor[] }): MagicHint[] {
  const out: MagicHint[] = [];
  if (!actor || !isAwakened(actor)) return out;
  const add = (key: string, extra: Partial<MagicHint> = {}) => out.push({ key, tone: 'info', ...extra });
  if (usesTradition(actor)) {
    const tr = actor.magic?.tradition;
    if (!tr) add(tk('Pick your tradition: it sets the attribute you resist Drain with (and your spirits).'), { tone: 'warn', action: 'tradition' });
    else if (!drainAttr(actor)) add(tk('Your tradition has no Drain attribute yet: choose the one you resist Drain with (Willpower + …).'), { tone: 'warn', action: 'tradition' });
    else {
      const pool = drainPool(actor);
      if (pool) add(tk('You resist Drain with Willpower + {attr}: {n} dice before modifiers.'), { params: { attr: pool.attrs[1], n: pool.base }, action: 'drain' });
    }
  }
  const n = actor.id ? sustainedBy(magic, actor.id) : 0;
  if (magic && (magic as { astral?: Record<string, { mode?: string }> }).astral?.[actor.id as string]?.mode === 'projecting') add(tk('You are projecting: your body is empty and helpless until you return.'), { tone: 'warn' });
  if (spirits?.some((s) => s.spirit && !s.spirit.bound)) add(tk('Your unbound spirit leaves at the next sunrise or sunset, with the services it still owes.'));
  if (n) add(tk('You are sustaining {n} spell(s): −{p} dice on every test. Drop the ones you no longer need.'), { tone: 'warn', params: { n, p: n * SUSTAIN_PENALTY } });
  return out.sort((a, b) => (TONE_RANK[a.tone] ?? 2) - (TONE_RANK[b.tone] ?? 2));
}
