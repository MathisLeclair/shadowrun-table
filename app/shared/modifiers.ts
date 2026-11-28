// Modifiers from gear, clothing, qualities, adept powers, implants, weapon accessories and martial art techniques
// (Chummer <bonus> data normalized into catalog `effects` by tools/lib/bonus-effects.ts — see ARCHITECTURE.md « Modifiers »).
// Pure ES module shared by the server (authority: dice/roll, matrix, combat) and the browser (sheet, roll dialog preview).
//
//   const mods = collectModifiers(actor, lookupFromIndex(effectsJson));          // every modifier the actor carries
//   poolModifiers(mods, rollContext(actor, { skillId: 'con' }), { conditions: ['visible'] })   // dice pool lines of a test
//   limitFor(actor, 'social', mods, ctx, { conditions })                          // { base, total, lines }
//   derivedWithModifiers(actor, mods)                                             // derive() + monitors, armor, limits… with sources
//
// Double counting rule: attribute bonuses (specificattribute) and initiative dice / initiative score bonuses are STORED on the
// actor (actor.augmented, actor.initiative — filled by server/lib/augment.js on purchase / sheet edit / training / creation and
// recorded on the item (`item.bonus`), by the Foundry import from the active effects and by the Chummer import from <totalvalue>
// and the improvements). Those effects are only shown (`baked: true`, never added again); one the actor's stored values do not
// contain (item added before it was recorded) is flagged `unbaked: true` (« non compté », for the GM to report by hand).
// Everything else (limits, skill / category / group / linked-attribute dice, condition monitor boxes, armor of implants and
// qualities, soak, composure, memory…) is not stored anywhere and is applied here.
import { derive, attr, armorTotal, armorValue, SKILL_BY_ID, SKILLS } from './sr5.ts';
import { AFFLICTIONS } from './combat.ts';
import type { ActorLike, Actor, AttrKey, CatalogBonus, ConditionState, Effect, EffectType, Formula, Modifier, ModifierType, ItemBonus, KnowledgeType, MatrixMode, Weapon } from './types.ts';
import type { AttrKeyish, LimitKey, Derived } from './sr5.ts';

/** Marker for the i18n checker: UI keys, rendered by the client with t(label). */
const tk = (s: string): string => s;

/** Catalog effect as read here (alias of types.ts Effect). */
export type EffectIn = Effect;

/** Entry of the effects index (data/catalog/effects.json files[file][id]). */
export interface EffectsIndexEntry {
  name?: string;
  nameFr?: string;
  source?: string;
  page?: number | string;
  effects?: EffectIn[];
  /**
   * What the app does not apply by itself (tools/build-catalog.ts): 'all' = no play effect is automated (the GM handles the
   * item by hand), 'some' = some of its effects are automated, others are not. Absent = fully automated, or no play effect.
   */
  manual?: 'all' | 'some';
}

/** data/catalog/effects.json: entries by file and id, and lower-case English / French names → id. */
export interface EffectsIndex {
  files?: Record<string, Record<string, EffectsIndexEntry>>;
  names?: Record<string, Record<string, string>>;
}

/** lookup(file, catalogId, name) → effects index entry, or null (lookupFromIndex()). */
export type ModifierLookup = (file: string, id?: string | null, name?: string | null) => EffectsIndexEntry | null;

/** Where a modifier comes from. */
export type ModifierSource = Modifier['source'];
export type { ModifierType };
/** A modifier collected from an actor's items (collectModifiers): types.ts Modifier. */
export type CollectedModifier = Modifier;

/** An item that may carry effects (armor, mods, 'ware, qualities, powers, gear, techniques, accessories). */
interface SourceItem {
  id: string;
  name: string;
  nameFr?: string;
  catalogId?: string;
  choice?: string | null;
  rating?: number | null;
  level?: number;
  itemRating?: number | null;
  /** ItemBonus / CatalogBonus (armor mods: resistance bonuses, ignored here). */
  bonus?: unknown;
  chummerGuid?: string;
}

/** A condition of CONDITIONS. */
export interface ConditionDef {
  label: string;
  /** Roll-dialog switch (default: the condition key; null = automatic). */
  toggle?: string | null;
  skills?: string[];
  groups?: string[];
  exclude?: string[];
  attrs?: string[];
  knowledge?: string[];
  matrixActions?: string[];
  mode?: MatrixMode;
}

/** What a test is about (rollContext()). */
export interface RollContext {
  test?: string | null;
  actionId?: string | null;
  mode?: MatrixMode | (string & {}) | null;
  weaponId?: string | null;
  skillId?: string;
  skillName?: string;
  cat?: string | null;
  group?: string | null;
  linkedAttr?: AttrKeyish;
  knowledgeType?: KnowledgeType;
  knowledgeName?: string;
  attrs?: string[];
  /** Matrix action names (English, French) matched against matrixAction effects. */
  actionNames?: string[];
}

/** Request of rollContext(). */
export interface RollRequest {
  skillId?: string | null;
  attr?: AttrKeyish | null;
  attr2?: AttrKeyish | null;
  test?: string | null;
  actionId?: string | null;
  mode?: MatrixMode | (string & {}) | null;
  weaponId?: string | null;
}

/** Options of the modifier line functions. */
export interface LineOptions {
  /** Toggle keys turned on. */
  conditions?: string[] | Set<string> | null;
  /** Modifier ids switched off. */
  ignore?: string[] | Set<string> | null;
  isGM?: boolean;
}

export type LineState = 'applied' | 'off' | 'ignored' | 'info';
/** One modifier evaluated for a test. */
export interface ModifierLine {
  mod: CollectedModifier;
  value: number | null;
  toggles: string[];
  state: LineState;
}
/** Lines of a test, their applied total and the switches that would change something. */
export interface ModifierSummary {
  lines: ModifierLine[];
  total: number;
  toggles: Array<{ key: string; lines: ModifierLine[] }>;
}
/** limitFor() result. */
export interface LimitResult {
  name: string;
  base: number | null;
  total: number | null;
  lines: ModifierLine[];
  toggles: ModifierSummary['toggles'];
  alt: number | null;
  altConditions: string[];
}
/** weaponAccuracy() result. */
export interface WeaponAccuracy {
  base: number | null;
  total: number | null;
  lines: ModifierLine[];
  parts: Array<[string, number]>;
}
/** A source line of a derived value. */
export interface DerivedSourceLine {
  mod: CollectedModifier;
  value: number | null;
  applied: boolean;
  note?: 'baked' | 'unbaked' | 'override' | 'conditional' | 'info';
}
/** derivedWithModifiers() result. */
export type DerivedWithModifiers = Derived & {
  limitsAlt: Partial<Record<LimitKey, number>>;
  limitsAltConditions: Partial<Record<LimitKey, string[]>>;
  sources: Record<string, DerivedSourceLine[]>;
  info: CollectedModifier[];
};

/** Shape of the shared/combat.js AFFLICTIONS entries read here. */
interface AfflictionDef {
  name: string;
  en: string;
  dice?: number;
  woundFactor?: number;
}

/** Item lists → catalog files of the effects index (data/catalog/effects.json). */
export const SOURCE_FILES: Record<string, string[]> = {
  armor: ['armor'], armorMods: ['armormods'], augmentations: ['cyberware', 'bioware'], qualities: ['qualities'], powers: ['powers'],
  gear: ['gear'], techniques: ['techniques'], spells: ['spells'],
};

/** Shared toggles of the roll dialog (several conditions use the same one: every « must be visible » piece of clothing). */
export const TOGGLE_LABELS: Record<string, string> = {
  visible: tk('Outfit visible'),
  wireless: tk('Wireless bonuses on'),
  climbing: tk('Climbing'),
  naked: tk('Completely naked'),
  thermal: tk('Against thermographic vision'),
  'perception-visual': tk('Visual Perception'),
  'perception-hearing': tk('Auditory Perception'),
  'perception-scent': tk('Olfactory Perception'),
  'perception-taste': tk('Taste Perception'),
  'perception-touch': tk('Tactile Perception'),
  'in-host': tk('In a host'),
  'hot-sim': tk('In hot-sim VR'),
};

const C = (label: string, o: Omit<ConditionDef, 'label'> = {}): ConditionDef => ({ label, ...o });
/**
 * Conditions of effects (catalog `effects[].condition`, keys made by tools/lib/bonus-effects.ts conditionKey()).
 * label = French text shown next to the value (« 11 si visible »). Restrictions make the effect apply automatically, only to:
 * skills / groups / knowledge types / linked attributes (attrs) / Matrix actions / Matrix mode; exclude = every skill but those.
 * toggle: key of the roll-dialog switch the player turns on (default: the condition key itself; null = automatic).
 */
export const CONDITIONS: Record<string, ConditionDef> = {
  visible: C(tk('if visible'), { toggle: 'visible' }),
  'intimidation-visible': C(tk('Intimidation, if visible'), { toggle: 'visible', skills: ['intimidation'] }),
  'exclude-intimidation-visible': C(tk('except Intimidation, if visible'), { toggle: 'visible', exclude: ['intimidation'] }),
  'skills-active-sneaking-visible': C(tk('Sneaking, if visible'), { toggle: 'visible', skills: ['sneaking'] }),
  'corporation-visible': C(tk('with that corporation, if visible')),
  'public-visible': C(tk('with the general public, if visible')),
  'gang-visible': C(tk('with gang members, if visible')),
  'bunker-gear-visible': C(tk('in an emergency, if visible')),
  'exclude-intimidation': C(tk('except Intimidation'), { toggle: null, exclude: ['intimidation'] }),
  intimidation: C(tk('Intimidation'), { toggle: null, skills: ['intimidation'] }),
  'exclude-fans-gangers': C(tk('except Urban Brawl fans and gangers')),
  'sports-fans': C(tk('with the team’s fans')),
  'sports-rivals': C(tk('with rival fans')),
  'shield-physical-penalty': C(tk('when the shield gets in the way')),
  'climbing-tests': C(tk('climbing'), { toggle: 'climbing', skills: ['gymnastics'] }),
  'skills-active-gymnastics-climbing': C(tk('Gymnastics (climbing)'), { toggle: 'climbing', skills: ['gymnastics'] }),
  megacorp: C(tk('with a single megacorp')),
  sprawl: C(tk('in a single sprawl')),
  'national-language-ranks': C(tk('with 4+ ranks in the national language')),
  'test-attrib-agi': C(tk('Agility tests'), { toggle: null, attrs: ['AGI'] }),
  'test-attrib-int': C(tk('Intuition tests'), { toggle: null, attrs: ['INT'] }),
  'test-attrib-log': C(tk('Logic tests'), { toggle: null, attrs: ['LOG'] }),
  'attrib-skill-int': C(tk('Intuition-linked skills'), { toggle: null, attrs: ['INT'] }),
  'attrib-skill-log': C(tk('Logic-linked skills'), { toggle: null, attrs: ['LOG'] }),
  'skills-knowledge-academic': C(tk('academic knowledge'), { toggle: null, knowledge: ['academic'] }),
  'skills-knowledge-scientific-technical': C(tk('scientific or technical knowledge'), { knowledge: ['academic', 'professional'] }),
  'skills-active-contortion': C(tk('contortion'), { skills: ['escape_artist'] }),
  'skills-active-disguise-impersonation': C(tk('Disguise and Impersonation'), { toggle: null, skills: ['disguise', 'impersonation'] }),
  'skills-active-escape-artist-grapple-loose': C(tk('Escape Artist and grappling, loosened'), { skills: ['escape_artist', 'unarmed_combat'] }),
  'skills-active-escape-artist': C(tk('Escape Artist'), { toggle: null, skills: ['escape_artist'] }),
  'skills-active-first-aid-medicine': C(tk('First Aid and Medicine'), { toggle: null, skills: ['first_aid', 'medicine'] }),
  'cyberware-balance-tail': C(tk('climbing, jumping, running, knockdown resistance'), { skills: ['gymnastics', 'running'] }),
  'cyberware-hydraulic-jacks': C(tk('jumping and sprinting'), { skills: ['gymnastics', 'running'] }),
  'skills-active-navigation': C(tk('Navigation'), { toggle: null, skills: ['navigation'] }),
  'skills-active-perception-hearing': C(tk('Auditory Perception'), { toggle: 'perception-hearing', skills: ['perception'] }),
  'skills-active-perception-visual': C(tk('Visual Perception'), { toggle: 'perception-visual', skills: ['perception'] }),
  'skills-active-perception-spatial-recognizer': C(tk('locating the source of a sound'), { skills: ['perception'] }),
  'skills-active-perception': C(tk('Perception'), { toggle: null, skills: ['perception'] }),
  'skills-active-performance-singing': C(tk('Performance (singing)'), { skills: ['performance'] }),
  'skills-active-performance-synthtrument': C(tk('Performance with a linked synthesizer'), { skills: ['performance'] }),
  'skills-active-performance': C(tk('Performance'), { toggle: null, skills: ['performance'] }),
  'skills-active-leadership': C(tk('Leadership'), { toggle: null, skills: ['leadership'] }),
  'skills-active-swimming': C(tk('Swimming'), { toggle: null, skills: ['swimming'] }),
  skillwires: C(tk('skillwires')),
  'test-sneaking-thermal': C(tk('Sneaking against thermographic vision'), { toggle: 'thermal', skills: ['sneaking'] }),
  'skills-active-sneaking': C(tk('Sneaking against thermographic vision'), { toggle: 'thermal', skills: ['sneaking'] }),
  'skills-active-sneaking-naked': C(tk('Sneaking, completely naked'), { toggle: 'naked', skills: ['sneaking'] }),
  'skill-group-stealth-naked': C(tk('Stealth group, completely naked'), { toggle: 'naked', groups: ['stealth'] }),
  'skill-group-stealth': C(tk('Stealth group'), { toggle: null, groups: ['stealth'] }),
  'knockdown-resistance-foot-anchor': C(tk('knockdown resistance, anchor engaged')),
  'cyberware-foot-anchor': C(tk('knockdown resistance, anchor engaged')),
  'cyberware-cyberfins': C(tk('repairs, striking, dancing… (activated)')),
  'gear-autopicker': C(tk('mechanical locks'), { skills: ['locksmith'] }),
  'quality-trustworthy': C(tk('situations of trust')),
  'quality-chatty': C(tk('AR or VR communication')),
  'test-speech': C(tk('tests involving speech')),
  'tests-endurance': C(tk('endurance tests (tightened)')),
  'cyberware-raptor-foot': C(tk('leg attacks'), { skills: ['unarmed_combat'] }),
  'cyberware-monkey-foot': C(tk('used as a hand')),
  'cyberware-snake-fingers': C(tk('manual dexterity')),
  'in-use': C(tk('while in use')),
  'soldier-paragon': C(tk('attack actions')),
  // Free-text conditions of the Chummer data (qualities, bioware)
  't-people-who-can-smell-you': C(tk('against those who can smell you')),
  't-visual': C(tk('Visual Perception'), { toggle: 'perception-visual', skills: ['perception'] }),
  't-hearing': C(tk('Auditory Perception'), { toggle: 'perception-hearing', skills: ['perception'] }),
  't-scent': C(tk('Olfactory Perception'), { toggle: 'perception-scent', skills: ['perception'] }),
  't-taste': C(tk('Taste Perception'), { toggle: 'perception-taste', skills: ['perception'] }),
  't-touch': C(tk('Tactile Perception'), { toggle: 'perception-touch', skills: ['perception'] }),
  't-when-in-hosts': C(tk('in a host'), { toggle: 'in-host' }),
  't-crack-file': C(tk('Crack File'), { matrixActions: ['crackFile'] }),
  't-matrix-perception': C(tk('Matrix Perception'), { matrixActions: ['matrixPerception'] }),
  't-hot-sim': C(tk('in hot-sim VR'), { toggle: 'hot-sim', mode: 'hot' }),
  't-threading-complex-forms-in-hot-sim': C(tk('threading complex forms in hot-sim VR')),
  't-meeting-people-the-first-time': C(tk('first meeting')),
  't-with-non-combat-personnel': C(tk('with non-combat personnel')),
  't-with-corporate-personnel': C(tk('with corporate personnel')),
  't-when-not-looking-your-best': C(tk('when not looking your best')),
  't-with-plausible-seeming-evidence': C(tk('with plausible-seeming evidence')),
  't-items-specifically-for-orks-and-or-trolls': C(tk('items made for orks and trolls')),
  't-crowds-of-ten-or-more-people': C(tk('crowds of ten or more people')),
  't-involving-pattern-recognition-evidence-analysis-clue-hunting': C(tk('pattern recognition, evidence analysis, clue hunting')),
  't-fault-sprite': C(tk('fault sprite')),
  't-companion-sprite': C(tk('companion sprite')),
  't-machine-sprite': C(tk('machine sprite')),
  't-generalist-sprite': C(tk('generalist sprite')),
  't-involves-a-significant-event-in-ork-or-troll-history': C(tk('a significant event of ork or troll history')),
  't-hiding-in-a-crowd': C(tk('hiding in a crowd')),
  't-combat-maneuvers': C(tk('combat maneuvers')),
  't-groups-of-exclusively-orks-and-or-trolls': C(tk('groups made only of orks and trolls')),
  't-communities-of-majority-orks-and-or-trolls': C(tk('communities of mostly orks and trolls')),
  't-non-orks-and-trolls': C(tk('against non-orks and non-trolls')),
  't-matters-of-life-or-death': C(tk('matters of life or death')),
  't-urban': C(tk('in urban areas')),
  't-not-urban': C(tk('outside urban areas')),
  't-rural': C(tk('in rural areas')),
  't-desert': C(tk('in the desert')),
  't-forest': C(tk('in forests')),
  't-jungle': C(tk('in the jungle')),
  't-mountain': C(tk('in the mountains')),
  't-polar': C(tk('in polar areas')),
  // Hand-written quality effects (tools/lib/effect-overrides.ts)
  'q-fear': C(tk('resisting fear or intimidation')),
  'q-symptoms': C(tk('while symptoms show')),
  'q-simsense': C(tk('using AR, VR or simsense (smartlink, simrig…)')),
  'q-juryrigging': C(tk('jury-rigging'), { skills: ['aeronautics_mechanic', 'automotive_mechanic', 'industrial_mechanic', 'nautical_mechanic'] }),
  'q-gearhead': C(tk('Gearhead: hard maneuvers and stunts')),
  'q-impulsive': C(tk('resisting impulsive behavior')),
  'q-allergen': C(tk('exposed to the allergen')),
  'q-target-group': C(tk('with the target group')),
  'q-black-ic': C(tk('against Black or Psychotropic IC')),
  'q-spirit-type': C(tk('the chosen spirit type'), { skills: ['summoning', 'binding'] }),
  'q-icu': C(tk('you can see the target or its owner')),
  'q-online-fame': C(tk('over the Matrix, with people who know your persona')),
  'q-not-recording': C(tk('when you cannot record (wireless off)')),
  'q-out-of-combat': C(tk('outside combat')),
  'q-nerdrage': C(tk('until you get your revenge')),
  // Spellcasting foci (spellcategory)
  'spell-combat': C(tk('combat spell'), { skills: ['spellcasting', 'ritual_spellcasting'] }),
  'spell-detection': C(tk('detection spell'), { skills: ['spellcasting', 'ritual_spellcasting'] }),
  'spell-health': C(tk('health spell'), { skills: ['spellcasting', 'ritual_spellcasting'] }),
  'spell-illusion': C(tk('illusion spell'), { skills: ['spellcasting', 'ritual_spellcasting'] }),
  'spell-manipulation': C(tk('manipulation spell'), { skills: ['spellcasting', 'ritual_spellcasting'] }),
};

/** Toggle key a condition needs (null = automatic). Unknown conditions become their own toggle (never applied silently). */
export function conditionToggle(key: string): string | null {
  const c = CONDITIONS[key];
  if (!c) return key;
  return c.toggle === undefined ? key : c.toggle;
}
/** Label (UI key) of a toggle (render with t()). */
export function toggleLabel(key: string): string {
  return TOGGLE_LABELS[key] || CONDITIONS[key]?.label || key;
}
/** Label (UI key) of a condition (render with t()); unknown keys are shown as is. */
export function conditionLabel(key: string): string {
  return CONDITIONS[key]?.label || key;
}

// ---------------------------------------------------------------------------
// Values (« Rating », « -Rating », « FixedValues(3,6,9) », « Rating * 2 »…)
// ---------------------------------------------------------------------------
/** Evaluate an effect value with the item's rating; null when it cannot be evaluated. */
export function effectValue(v: unknown, rating: unknown = 1): number | null {
  if (typeof v === 'number') return v;
  if (v === undefined || v === null || v === '') return null;
  const R = Number(rating) || 1;
  const src = String(v).replace(/\{([A-Za-z]+)\}/g, '$1').trim();
  const toks = src.match(/\d+(?:\.\d+)?|[A-Za-z]+|[()+\-*/,]/g) || [];
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  function primary(): number {
    const t = next();
    if (t === undefined) throw new Error('eof');
    if (t === '(') {
      const x = add();
      if (next() !== ')') throw new Error(')');
      return x;
    }
    if (/^\d/.test(t)) return Number(t);
    if (t === 'Rating') return R;
    if (t === 'FixedValues') {
      if (next() !== '(') throw new Error('(');
      const args = [add()];
      while (peek() === ',') {
        next();
        args.push(add());
      }
      if (next() !== ')') throw new Error(')');
      return args[Math.max(0, Math.min(args.length - 1, Math.round(R) - 1))];
    }
    throw new Error(t);
  }
  function unary(): number {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return primary();
  }
  function mul(): number {
    let x = unary();
    while (peek() === '*' || peek() === '/' || peek() === 'div') {
      const op = next();
      const y = unary();
      x = op === '*' ? x * y : op === 'div' ? Math.floor(x / y) : x / y;
    }
    return x;
  }
  function add(): number {
    let x = mul();
    while (peek() === '+' || peek() === '-') x = next() === '+' ? x + mul() : x - mul();
    return x;
  }
  try {
    const x = add();
    return p === toks.length && Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catalog lookup
// ---------------------------------------------------------------------------
const norm = (s: unknown): string => String(s || '').trim().toLowerCase();
/**
 * lookup(file, catalogId, name) → effects index entry { name, nameFr?, source, page, effects } or null, from data/catalog/effects.json
 * ({ files: { [file]: { [id]: entry } }, names: { [file]: { [lowercase English or French name]: id } } }). Items without a catalog id
 * (Foundry imports) are matched by name, then by name without a trailing « (…) » / « R4 ».
 */
export function lookupFromIndex(index: EffectsIndex | null | undefined): ModifierLookup {
  return (file, id, name) => {
    const f = index?.files?.[file];
    if (!f) return null;
    if (id && f[id]) return f[id];
    if (!name) return null;
    const names = index!.names?.[file] || {};
    const n = norm(name);
    const k = names[n] || names[n.replace(/\s*\([^)]*\)\s*$/, '')] || names[n.replace(/\s+r\d+$/, '')];
    return k ? f[k] || null : null;
  };
}

// ---------------------------------------------------------------------------
// Echoes (technomancers: actor.magic.echoes, free names from training / imports)
// ---------------------------------------------------------------------------
/** An echo the app knows: name pattern (English / French), effects, book and page. */
interface EchoDef {
  re: RegExp;
  name: string;
  book: string;
  page: number;
  effects: EffectIn[];
}
/**
 * Echoes with an effect (SR5 p. 258, Data Trails p. 58-59). Living persona attributes are shown (the sheet's Matrix values are
 * the persona's, entered with the echoes); the others apply like item effects. Resonance [Program]: shared/matrix.ts
 * availablePrograms(). Others (Resonance Link, Quiet, Resonance Scream, Skinlink, Sleepwalker…): the GM's call.
 */
export const ECHOES: EchoDef[] = [
  { re: /attack\s*upgrade|am[ée]lioration.*attaque/i, name: 'Attack Upgrade', book: 'SR5', page: 258, effects: [{ type: 'personaAttribute', target: 'attack', value: 1 }] },
  { re: /sleaze\s*upgrade|am[ée]lioration.*corruption/i, name: 'Sleaze Upgrade', book: 'SR5', page: 258, effects: [{ type: 'personaAttribute', target: 'sleaze', value: 1 }] },
  { re: /data\s*processing\s*upgrade|am[ée]lioration.*traitement/i, name: 'Data Processing Upgrade', book: 'SR5', page: 258, effects: [{ type: 'personaAttribute', target: 'dataProcessing', value: 1 }] },
  { re: /firewall\s*upgrade|am[ée]lioration.*firewall/i, name: 'Firewall Upgrade', book: 'SR5', page: 258, effects: [{ type: 'personaAttribute', target: 'firewall', value: 1 }] },
  { re: /neuro\s*-?\s*filt/i, name: 'NeuroFilter', book: 'SR5', page: 258, effects: [{ type: 'stat', target: 'biofeedback', value: 1 }] },
  { re: /overclock|surcaden/i, name: 'Overclocking', book: 'SR5', page: 258, effects: [{ type: 'matrixInitiativeDice', value: 1, condition: 't-hot-sim' }] },
  { re: /mind\s*over\s*machine|esprit.*machine/i, name: 'Mind over Machine', book: 'SR5', page: 258, effects: [{ type: 'flag', target: 'controlRig', value: 1 }] },
  { re: /\bmmri\b/i, name: 'MMRI', book: 'DT', page: 59, effects: [{ type: 'flag', target: 'controlRig', value: 1 }] },
  { re: /math[ée]mag/i, name: 'Mathemagics', book: 'DT', page: 58, effects: [{ type: 'limit', target: 'mental', value: 2, condition: 'skills-knowledge-scientific-technical' }] },
  { re: /\bfff\b|fight.or.flight/i, name: 'FFF (Fight-or-Flight Filter)', book: 'DT', page: 58, effects: [{ type: 'flag', target: 'painEditor', value: 1 }] },
];
/** Echo definition of a free echo name, or null. */
export function echoDef(name: unknown): EchoDef | null {
  const n = String(name || '').trim();
  return n ? ECHOES.find((e) => e.re.test(n)) || null : null;
}

// ---------------------------------------------------------------------------
// Collecting modifiers
// ---------------------------------------------------------------------------
const BAKED = new Set<string>(['attribute', 'initiativeDice', 'initiative']);
const INFO = new Set<string>(['attributeMax', 'resist', 'flag', 'info', 'choice', 'personaAttribute']);

/** SR5 skill id from a free choice text (« Con », « con », « Escroquerie »…), or null. */
export function skillFromText(text: unknown): string | null {
  const s = norm(text);
  if (!s) return null;
  if (SKILL_BY_ID[s]) return s;
  const slug = s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (SKILL_BY_ID[slug]) return slug;
  const fr = SKILLS.find((k) => norm(k.fr) === s);
  return fr ? fr.id : null;
}

/** Rating used for « Rating » in an item's effects. */
function ratingOf(list: string, it: SourceItem): number {
  if (list === 'powers') return Number(it.level) || 1;
  if (list === 'armor') return Number(it.itemRating) || 1; // armor.rating is the armor value, not the Chummer item rating
  return Number(it.rating ?? it.level) || 1;
}

function sourceOf(list: string, it: SourceItem, entry: EffectsIndexEntry | null | undefined, sub?: SourceItem | null): ModifierSource {
  const s: ModifierSource = { list, itemId: it.id, name: (sub || it).name || entry?.name || '' };
  if (sub) {
    s.subId = sub.id;
    s.parentName = it.name;
  }
  const x = sub || it;
  if (x.nameFr) s.nameFr = x.nameFr;
  if (x.catalogId) s.catalogId = x.catalogId;
  if (entry?.source) s.book = entry.source;
  if (entry?.page !== undefined && entry?.page !== '') s.page = entry.page;
  return s;
}

/**
 * Every modifier carried by the actor. lookup(file, catalogId, name) → effects index entry (lookupFromIndex()).
 * Sources: equipped armor + its mods, augmentations, qualities, adept powers (level), gear with `active: true`, martial art
 * techniques, and (opts.weaponId) that weapon's accessories. Returns
 * [{ id, source: { list, itemId, subId?, name, nameFr?, catalogId?, book?, page? }, type, target, value (number|null), condition,
 *    wireless?, baked? (already in actor.augmented / actor.initiative), info? (shown, not applied), needsChoice?, choice? }]
 */
export function collectModifiers(actor: ActorLike | null | undefined, lookup: ModifierLookup, opts: { weaponId?: string | null } = {}): CollectedModifier[] {
  const out: CollectedModifier[] = [];
  if (!actor || typeof actor !== 'object') return out;
  const stored: BakedCandidate[] = []; // { m, it }: attribute / initiative effects, checked against the actor's stored values (settleBaked)
  const add = (list: string, it: SourceItem, entry: EffectsIndexEntry | null, sub?: SourceItem) => {
    const effects = entry?.effects || [];
    effects.forEach((e, i) => {
      if (!e || e.type === 'unsupported' || e.type === 'chargen') return;
      const x = sub || it;
      const rating = ratingOf(sub ? 'sub' : list, x);
      let target: string | null = e.target ?? null;
      let needsChoice = false;
      if (target === '$choice') {
        const ch = String(x.choice || '').trim();
        if (e.choice?.kind === 'skill') target = skillFromText(ch) || (ch ? `name:${ch}` : null);
        else if (e.choice?.kind === 'attribute') target = ch.toUpperCase() || null;
        else if (e.choice?.kind === 'limit') target = ch.toLowerCase() || null;
        else target = ch || null;
        if (!target) needsChoice = true;
      }
      const value = e.type === 'resist' && e.value === 'immune' ? null : effectValue(e.value, rating);
      const m: CollectedModifier = {
        id: `${list}:${it.id}${sub ? `:${sub.id}` : ''}:${i}`,
        source: sourceOf(list, it, entry, sub),
        type: e.type,
        target,
        value,
        condition: e.condition || null,
      };
      if (e.wireless) m.wireless = true;
      if (e.choice) m.choice = e.choice;
      if (e.exclude?.length) m.exclude = e.exclude; // « every skill of the category but … » (concernsPool)
      if (e.note) m.note = e.note;
      if (e.type === 'resist' && e.value === 'immune') m.immune = true;
      if (BAKED.has(e.type)) stored.push({ m, it: x });
      if (INFO.has(e.type) || needsChoice || value === null) m.info = true;
      if (needsChoice) m.needsChoice = true;
      out.push(m);
    });
  };
  const find = (files: string[], it: SourceItem): EffectsIndexEntry | null => {
    for (const f of files) {
      const e = lookup(f, it.catalogId, it.name) || (it.nameFr ? lookup(f, null, it.nameFr) : null);
      if (e) return e;
    }
    return null;
  };
  // Worn armor: like armorTotal(), only the best non-stacking piece counts (one outfit at a time) + the stacking ones (helmet, shield…).
  const worn = (actor.armor || []).filter((a) => a && a.equipped);
  let outfit: Actor['armor'][number] | null = null;
  for (const a of worn) if (!a.stack && (!outfit || armorValue(a) > armorValue(outfit))) outfit = a;
  for (const a of worn) {
    if (!a.stack && a !== outfit) continue;
    add('armor', a, find(SOURCE_FILES.armor, a));
    for (const m of a.mods || []) if (m && (m as { equipped?: boolean }).equipped !== false) add('armor', a, find(SOURCE_FILES.armorMods, m), m);
  }
  for (const g of actor.augmentations || []) {
    if (!g || g.disabled) continue;
    const files = g.kind === 'bioware' ? ['bioware', 'cyberware'] : ['cyberware', 'bioware'];
    add('augmentations', g, find(files, g));
  }
  for (const q of actor.qualities || []) if (q) add('qualities', q, find(SOURCE_FILES.qualities, q));
  for (const p of actor.powers || []) if (p) add('powers', p, find(SOURCE_FILES.powers, p));
  for (const g of actor.gear || []) if (g && g.active) add('gear', g, find(SOURCE_FILES.gear, g));
  for (const ma of actor.martialArts || []) for (const tq of ma?.techniques || []) if (tq) add('martialArts', ma, find(SOURCE_FILES.techniques, tq), tq);
  // Echoes: one source per echo taken (Attack Upgrade twice = two +1).
  ((actor as { magic?: { echoes?: unknown[] } }).magic?.echoes || []).forEach((name, i) => {
    const def = echoDef(name);
    if (!def) return;
    add('echoes', { id: `echo${i}`, name: String(name) }, { name: def.name, source: def.book, page: def.page, effects: def.effects });
  });
  if (opts.weaponId) {
    const w = (actor.weapons || []).find((x) => x && x.id === opts.weaponId);
    for (const acc of w?.accessories || []) {
      if (!acc || acc.equipped === false) continue;
      const e = acc.effects && typeof acc.effects === 'object' ? acc.effects : {};
      const base = { source: sourceOf('weapons', w!, null, acc), condition: null };
      if (Number(e.dicePool)) out.push({ ...base, id: `weapons:${w!.id}:${acc.id}:pool`, type: 'weaponPool', target: w!.id, value: Number(e.dicePool) });
    }
  }
  // Afflictions (toxins of gas grenades…, shared/combat.js AFFLICTIONS): −2 dice on every test, wound modifiers doubled. Those of
  // a fight are removed by the combat module; the out-of-combat ones (until.ts) end with their time.
  const now = Date.now();
  for (const a of actor.afflictions || []) {
    const def = a && (AFFLICTIONS as Record<string, AfflictionDef | undefined>)[a.kind];
    const untilTs = (a?.until as { ts?: number } | undefined)?.ts;
    if (!def || (untilTs !== undefined && now > untilTs)) continue;
    const source: ModifierSource = { list: 'afflictions', itemId: a.id, name: a.sourceEn ? `${def.en} (${a.sourceEn})` : def.en, nameFr: a.source ? `${def.name} (${a.source})` : def.name };
    if (def.dice) out.push({ id: `afflictions:${a.id}:dice`, source, type: 'allTests', target: null, value: def.dice, condition: null });
    if (def.woundFactor) out.push({ id: `afflictions:${a.id}:wounds`, source, type: 'woundFactor', target: null, value: def.woundFactor, condition: null });
  }
  settleBaked(actor, stored);
  return out;
}

/** Item whose attribute / initiative bonuses an import stored on the actor: Foundry (`fvtt_` ids) or Chummer (`chummerGuid`). */
export function importedItem(it: unknown): boolean {
  const x = it as { id?: unknown; chummerGuid?: unknown } | null | undefined;
  return !!x && typeof x === 'object' && (String(x.id || '').startsWith('fvtt_') || !!x.chummerGuid);
}
/** A baked-type modifier and the item it comes from. */
interface BakedCandidate {
  m: CollectedModifier;
  it: SourceItem;
}
const bonusKey = (m: CollectedModifier): string | null => (m.type === 'attribute' ? (m.target ? `attr:${m.target}` : null) : m.type === 'initiativeDice' || m.type === 'initiative' ? m.type : null);
function storedBonus(actor: ActorLike, k: string): number {
  if (k === 'initiativeDice') return Math.max(1, Math.min(5, Number(actor.initiative?.dice ?? 1) || 1)) - 1;
  if (k === 'initiative') return Number(actor.initiative?.bonus) || 0;
  return Number((actor.augmented as Record<string, number> | null | undefined)?.[k.slice(5)]) || 0;
}
function recordedBonus(it: SourceItem | null | undefined, k: string): number | undefined {
  const b = it?.bonus as (ItemBonus & CatalogBonus) | null | undefined;
  if (!b || typeof b !== 'object') return undefined;
  if (k === 'initiativeDice' || k === 'initiative') return b[k] === undefined ? undefined : Number(b[k]) || 0;
  const v = (b.attributes as Record<string, unknown> | undefined)?.[k.slice(5)];
  return v === undefined ? undefined : Number(v) || 0;
}

/**
 * Attribute / initiative effects are counted in the actor's stored values (actor.augmented, actor.initiative) — never added here.
 * baked = really stored: the item records it (item.bonus, written by server/lib/augment.js), it comes from an import, or the stored
 * value still has room for it once the recorded / imported ones are taken out (hand-made templates, older sheets). Otherwise
 * unbaked: shown « non compté » so the GM reports it by hand.
 */
function settleBaked(actor: ActorLike, cands: BakedCandidate[]): void {
  const byKey = new Map<string, BakedCandidate[]>();
  for (const c of cands) {
    const k = bonusKey(c.m);
    if (!k || c.m.value === null || c.m.needsChoice) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(c);
  }
  for (const [k, list] of byKey) {
    let left = storedBonus(actor, k);
    const counted = new Set<SourceItem>();
    for (const c of list) {
      const r = recordedBonus(c.it, k);
      if (r === undefined) continue;
      c.m.baked = true;
      if (!counted.has(c.it)) {
        counted.add(c.it);
        left -= r;
      }
    }
    for (const c of list) {
      if (c.m.baked || !importedItem(c.it)) continue;
      c.m.baked = true;
      left -= c.m.value!;
    }
    for (const c of list) {
      if (c.m.baked) continue;
      const v = c.m.value!;
      if (v === 0 || (v > 0 ? left >= v : left <= v)) {
        c.m.baked = true;
        left -= v;
      } else c.m.unbaked = true;
    }
  }
}

/**
 * Attribute / initiative bonus of a catalog entry's effects, in the format server/lib/augment.js applyBonus() stores
 * ({ attributes: { REA: 'Rating' }, initiativeDice: 'FixedValues(0,1,1)', initiative: 1 }: formulas evaluated with the item's
 * Rating), or undefined. Unconditional, non-wireless effects only; « select attribute » (Improved Physical Attribute) uses item.choice.
 */
export function bonusFromEffects(
  effects: Array<Partial<EffectIn> | null | undefined> | null | undefined,
  item: { choice?: string | null } | null = {},
): CatalogBonus | undefined {
  const out: CatalogBonus = {};
  const plus = (a: Formula | undefined, b: Formula): Formula => (a === undefined ? b : `(${a})+(${b})`);
  for (const e of Array.isArray(effects) ? effects : []) {
    if (!e || e.condition || e.wireless || e.value === undefined || e.value === null || e.value === '') continue;
    if (e.type === 'attribute') {
      let k = e.target as string | undefined;
      if (k === '$choice') k = String(item?.choice || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(String(k || ''))) continue;
      out.attributes ||= {};
      out.attributes[k as AttrKey] = plus(out.attributes[k as AttrKey], e.value);
    } else if (e.type === 'initiativeDice' || e.type === 'initiative') out[e.type] = plus(out[e.type], e.value);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * How much of a quality the app applies by itself: 'auto' (fully automated, or no effect at the table), 'some' (partly: the
 * GM applies the rest), 'all' (nothing automated: the GM handles it by hand), 'custom' (not in the catalog: a home-made quality).
 */
export function qualityAutomation(q: { catalogId?: string; name?: string; nameFr?: string } | null | undefined, lookup: ModifierLookup | null | undefined): 'auto' | 'some' | 'all' | 'custom' {
  if (!q || !lookup) return 'auto';
  const e = lookup('qualities', q.catalogId, q.name) || (q.nameFr ? lookup('qualities', null, q.nameFr) : null);
  if (!e) return 'custom';
  return e.manual || 'auto';
}

/** Gear items whose catalog entry has effects (they get an « actif » switch on the sheet). */
export function gearHasEffects(item: { catalogId?: string; name?: string; nameFr?: string } | null | undefined, lookup: ModifierLookup | null | undefined): boolean {
  return !!(item && lookup && (lookup('gear', item.catalogId, item.name) || (item.nameFr && lookup('gear', null, item.nameFr))));
}

// ---------------------------------------------------------------------------
// Roll context and condition states
// ---------------------------------------------------------------------------
/**
 * What a test is about, for matching modifiers: { skillId, cat, group, linkedAttr, knowledgeType, knowledgeName, test, actionId, mode, weaponId }.
 * req = { skillId?, attr? (override / attribute test), attr2?, test? ('composure'|'judgeIntentions'|'memory'|'liftCarry'|'defense'|'soak'|…),
 *         actionId? (Matrix action), mode? (Matrix mode), weaponId? }
 */
export function rollContext(actor: ActorLike | null | undefined, req: RollRequest = {}): RollContext {
  const ctx: RollContext = { test: req.test || null, actionId: req.actionId || null, mode: req.mode || null, weaponId: req.weaponId || null };
  if (req.skillId) {
    const sk = (actor?.skills || []).find((s) => s.id === req.skillId || s.name === req.skillId);
    const kno = !sk && (actor?.knowledge || []).find((k) => k.id === req.skillId);
    if (kno) {
      ctx.knowledgeType = kno.type || 'street';
      ctx.knowledgeName = kno.name;
      ctx.cat = `knowledge:${ctx.knowledgeType}`;
      ctx.linkedAttr = req.attr || (ctx.knowledgeType === 'academic' || ctx.knowledgeType === 'professional' ? 'LOG' : 'INT');
    } else {
      const id = sk?.id || req.skillId;
      const def = SKILL_BY_ID[id];
      ctx.skillId = id;
      ctx.skillName = sk?.name || def?.fr || id;
      ctx.cat = def?.cat || null;
      ctx.group = sk?.group || def?.group || null;
      ctx.linkedAttr = req.attr || sk?.attr || def?.attr || 'AGI';
    }
  } else if (req.attr) {
    ctx.attrs = [req.attr, req.attr2].filter(Boolean) as string[];
  }
  return ctx;
}

/**
 * State of a condition for a test: 'na' (does not concern this test), 'auto' (applies), 'on' / 'off' (needs a toggle,
 * turned on or not). toggles = Set of toggle keys the player turned on.
 */
export function conditionState(key: string | null | undefined, ctx: RollContext, toggles?: Set<string> | null): ConditionState {
  if (!key) return 'auto';
  const c = CONDITIONS[key];
  if (c) {
    if (c.skills && !c.skills.includes(ctx.skillId as string)) return 'na';
    if (c.groups && !c.groups.includes(ctx.group as string)) return 'na';
    if (c.exclude && c.exclude.includes(ctx.skillId as string)) return 'na';
    if (c.attrs && !c.attrs.includes(ctx.linkedAttr as string) && !(ctx.attrs || []).some((a) => c.attrs!.includes(a))) return 'na';
    if (c.knowledge && !c.knowledge.includes(ctx.knowledgeType as string)) return 'na';
    if (c.matrixActions && ctx.actionId) return c.matrixActions.includes(ctx.actionId) ? 'auto' : 'na';
    if (c.mode && ctx.mode) return ctx.mode === c.mode ? 'auto' : 'na';
  }
  const tg = conditionToggle(key);
  if (tg === null) return 'auto';
  return toggles?.has(tg) ? 'on' : 'off';
}

const asSet = (x: unknown): Set<string> => (x instanceof Set ? x : new Set(Array.isArray(x) ? x.map(String) : []));

/** Toggles a modifier line needs: its condition's toggle and 'wireless' for wireless bonuses. */
function lineToggles(m: CollectedModifier): string[] {
  const out: string[] = [];
  const tg = m.condition ? conditionToggle(m.condition) : null;
  if (tg) out.push(tg);
  if (m.wireless) out.push('wireless');
  return out;
}

/** Evaluate one modifier for a test → line { mod, value, state: 'applied'|'off'|'ignored'|'info', toggles }. null = not relevant. */
function evalLine(m: CollectedModifier, ctx: RollContext, opts: LineOptions): ModifierLine | null {
  const toggles = asSet(opts.conditions);
  let st = conditionState(m.condition, ctx, toggles);
  if (st === 'na') return null;
  if (m.wireless && st !== 'off') st = toggles.has('wireless') ? st : 'off';
  const line = { mod: m, value: m.value, toggles: lineToggles(m) } as ModifierLine;
  if (m.baked || m.info || m.value === null) line.state = 'info';
  else if (st === 'off') line.state = 'off';
  else if (asSet(opts.ignore).has(m.id) && (opts.isGM || m.value! > 0)) line.state = 'ignored';
  else line.state = 'applied';
  return line;
}

/** Does a modifier concern the dice pool of this test? */
export function concernsPool(m: CollectedModifier, ctx: RollContext): boolean {
  switch (m.type) {
    case 'skill':
      if (!m.target) return false;
      if (ctx.skillId && m.target === ctx.skillId) return true;
      if (String(m.target).startsWith('name:')) {
        const n = norm(String(m.target).slice(5));
        return !!n && (n === norm(ctx.knowledgeName) || n === norm(ctx.skillName));
      }
      return false;
    case 'skillCategory':
      return !!ctx.cat && m.target === ctx.cat && !(m.exclude || []).includes(ctx.skillId as string);
    case 'skillGroup':
      return !!ctx.group && m.target === ctx.group && !(m.exclude || []).includes(ctx.skillId as string);
    case 'skillAttribute':
      return !!(ctx.skillId || ctx.knowledgeType) && m.target === ctx.linkedAttr;
    case 'stat':
      return !!ctx.test && m.target === ctx.test;
    case 'weaponPool':
      return !!ctx.weaponId && m.target === ctx.weaponId;
    case 'allTests': // every skill / attribute test but resistance tests (afflictions)
      return !!(ctx.skillId || ctx.knowledgeType || ctx.attrs?.length || ctx.test) && !RESIST_TESTS.includes(ctx.test as string);
    case 'matrixAction': {
      if (!ctx.actionId || !m.target) return false;
      const t = norm(m.target).replace(/[^a-z0-9]/g, '');
      return t === norm(ctx.actionId).replace(/[^a-z0-9]/g, '') || (ctx.actionNames || []).some((n) => norm(n).replace(/[^a-z0-9]/g, '') === t);
    }
    default:
      return false;
  }
}

/**
 * Dice pool modifiers of a test. opts = { conditions: [toggle keys turned on], ignore: [modifier ids switched off], isGM }.
 * Returns { lines: [{ mod, value, state, toggles }], total (Σ applied), toggles: [{ key, lines }] (switches that would change something) }.
 */
export function poolModifiers(mods: CollectedModifier[] | null | undefined, ctx: RollContext, opts: LineOptions = {}): ModifierSummary {
  const lines: ModifierLine[] = [];
  for (const m of mods || []) {
    if (!concernsPool(m, ctx)) continue;
    const l = evalLine(m, ctx, opts);
    if (l) lines.push(l);
  }
  return summarize(lines);
}

function summarize(lines: ModifierLine[]): ModifierSummary {
  const total = lines.filter((l) => l.state === 'applied').reduce((s, l) => s + (Number(l.value) || 0), 0);
  const toggles: Record<string, ModifierLine[]> = {};
  for (const l of lines) if (!l.mod.baked && !l.mod.info && l.value !== null) for (const k of l.toggles) (toggles[k] ||= []).push(l);
  return { lines, total, toggles: Object.entries(toggles).map(([key, ls]) => ({ key, lines: ls })) };
}

/**
 * A limit with its modifiers for a test (ctx from rollContext; {} = no particular test: skill-restricted conditions are 'na').
 * Returns { name, base, total, lines, toggles, alt (total if every switch that concerns this test were on), altConditions: [keys] }.
 */
export function limitFor(
  actor: ActorLike | null | undefined,
  limitName: LimitKey | (string & {}),
  mods: CollectedModifier[] | null | undefined,
  ctx: RollContext = {},
  opts: LineOptions = {},
): LimitResult {
  const base = (derive(actor).limits as Record<string, number | null | undefined>)[limitName];
  if (base === null || base === undefined) return { name: limitName, base: null, total: null, lines: [], toggles: [], alt: null, altConditions: [] };
  const lines: ModifierLine[] = [];
  for (const m of mods || []) {
    if (m.type !== 'limit' || m.target !== limitName) continue;
    const l = evalLine(m, ctx, opts);
    if (l) lines.push(l);
  }
  const s = summarize(lines);
  const altLines = lines.filter((l) => l.state === 'off');
  const alt = base + s.total + altLines.reduce((sum, l) => sum + (Number(l.value) || 0), 0);
  const altConditions = [...new Set(altLines.flatMap((l) => l.toggles))];
  return { name: limitName, base, total: Math.max(0, base + s.total), lines: s.lines, toggles: s.toggles, alt: altLines.length ? Math.max(0, alt) : null, altConditions };
}

/** Accuracy modifiers (weaponskillaccuracy: chosen skill, weaponaccuracy: all weapons) of a weapon attack. */
export function accuracyModifiers(mods: CollectedModifier[] | null | undefined, ctx: RollContext, opts: LineOptions = {}): ModifierSummary {
  const lines: ModifierLine[] = [];
  for (const m of mods || []) {
    if (m.type !== 'accuracy') continue;
    if (!(m.target === 'all' || (ctx.skillId && m.target === ctx.skillId))) continue;
    const l = evalLine(m, ctx, opts);
    if (l) lines.push(l);
  }
  return summarize(lines);
}

/**
 * Limit of a weapon attack: Accuracy (a number, or « Physical » = physical limit with its modifiers) + accessories
 * (accessories[].effects.accuracy, equipped ones) + accuracy modifiers (Enhanced Accuracy…).
 * Returns { base, total (null = no limit), lines, parts: [[label, value]] }.
 */
export function weaponAccuracy(
  actor: ActorLike | null | undefined,
  w: Partial<Weapon> | null | undefined,
  mods: CollectedModifier[] | null | undefined,
  ctx: RollContext = {},
  opts: LineOptions = {},
): WeaponAccuracy {
  const s = String(w?.accuracy ?? '').trim();
  let base: number | null = null;
  if (/^-?\d+$/.test(s)) base = Number(s);
  else if (/phys/i.test(s)) {
    const m = s.match(/([+\-−])\s*(\d+)/);
    base = (limitFor(actor, 'physical', mods, ctx, opts).total as number) + (m ? (m[1] === '+' ? 1 : -1) * Number(m[2]) : 0);
  } else if (s) {
    const n = parseInt(s, 10);
    base = Number.isFinite(n) ? n : null;
  }
  if (base === null) return { base: null, total: null, lines: [], parts: [] };
  const parts: Array<[string, number]> = [[tk('Accuracy'), base]];
  let total = base;
  const accs = (Array.isArray(w?.accessories) ? w.accessories : []).filter((a) => a && typeof a === 'object' && a.equipped !== false);
  const accBonus = accs.reduce((sum, a) => sum + (Number(a.effects?.accuracy) || 0), 0);
  if (accBonus) {
    parts.push([tk('accessories'), accBonus]);
    total += accBonus;
  }
  const am = accuracyModifiers(mods, ctx, opts);
  for (const l of am.lines) {
    if (l.state !== 'applied') continue;
    parts.push([l.mod.source.name, l.value as number]);
    total += l.value as number;
  }
  return { base, total: Math.max(0, total), lines: am.lines, parts };
}

/** Attribute-only tests with modifiers of their own (stat effects) or without wound modifier: payload.test of 'dice/roll'. */
export const ROLL_TESTS: string[] = ['composure', 'judgeIntentions', 'memory', 'liftCarry', 'defense', 'soak', 'drainResist', 'biofeedback', 'toxinResist'];
/** Attributes of each test (payload.attr / attr2 must be one of these sets, in either order; drain: per tradition). */
export const TEST_ATTRS: Record<string, string[][]> = {
  composure: [['CHA', 'WIL']], judgeIntentions: [['CHA', 'INT']], memory: [['LOG', 'WIL']], liftCarry: [['BOD', 'STR']], defense: [['REA', 'INT']],
  soak: [['BOD']], drainResist: [['WIL', 'LOG'], ['WIL', 'CHA'], ['WIL', 'INT'], ['WIL', 'MAG'], ['WIL', 'WIL']], biofeedback: [['WIL']], toxinResist: [['BOD', 'WIL']],
};
/** Damage resistance tests: SR5 applies the wound modifier to every test but these. */
export const RESIST_TESTS: string[] = ['soak', 'drainResist', 'biofeedback', 'toxinResist'];
/**
 * The test key a roll may claim (null = none): an attribute-only roll (no skill, no weapon) whose attributes are the test's.
 * The server ignores any other claim (a skill roll « soak » would add the whole armor).
 */
export function checkedTest(
  test: unknown,
  { skillId, weaponId, attr: a1, attr2: a2 }: { skillId?: string | null; weaponId?: string | null; attr?: string | null; attr2?: string | null } = {},
): string | null {
  if (typeof test !== 'string' || !ROLL_TESTS.includes(test) || skillId || weaponId || !a1) return null;
  const got = [a1, a2].filter(Boolean).sort().join('+');
  return TEST_ATTRS[test].some((set) => [...set].sort().join('+') === got) ? test : null;
}
/** Does the wound modifier apply to this test? (SR5: every test but damage resistance.) */
export const woundsApply = (test: string | null | undefined): boolean => !RESIST_TESTS.includes(test as string);
/** Labels (UI keys) of the attribute-pair tests (log dock « Quick test ») → test key (soak excluded: its callers add the armor). */
export const TEST_BY_LABEL: Record<string, string> = {
  Defense: 'defense', Composure: 'composure', 'Judge Intentions': 'judgeIntentions', Memory: 'memory', 'Lift / Carry': 'liftCarry',
  'Resist toxins': 'toxinResist',
};
/** Device attributes a Matrix test from the sheet uses as its limit ('dice/roll' payload.matrixLimit). */
export const MATRIX_LIMITS: string[] = ['attack', 'sleaze', 'dataProcessing', 'firewall'];
/** Skills whose sheet tests may take a device attribute as limit (matrixLimit is ignored on any other roll). */
export const MATRIX_LIMIT_SKILLS: string[] = ['computer', 'cybercombat', 'electronic_warfare', 'hacking', 'software'];

// ---------------------------------------------------------------------------
// Derived values with modifiers (sheet, damage, combat)
// ---------------------------------------------------------------------------
const sumOf = (lines: DerivedSourceLine[]): number => lines.filter((l) => l.applied).reduce((s, l) => s + (Number(l.value) || 0), 0);

/**
 * derive(actor) + what the modifiers change, with the source lines of each value:
 *   physicalMonitor / stunMonitor / overflowMax (+ conditionmonitor boxes; an actor.monitors override wins, the bonus is then shown only),
 *   woundModifier (pain tolerance: threshold / thresholdOffset), armor (+ armor of implants, qualities, powers), soak, defense,
 *   composure, judgeIntentions, memory, liftCarry, limits (unconditional modifiers) + limitsAlt (with the « si visible »-type switches),
 *   matrixInitiative dice. sources[key] = [{ mod, value, applied, note: 'baked'|'unbaked'|'override'|'conditional'|'info' }].
 *   info = modifiers shown but not counted (resistances, reach, unarmed DV, attribute maximums, needs a choice…).
 */
export function derivedWithModifiers(actor: ActorLike | null | undefined, mods: CollectedModifier[] = []): DerivedWithModifiers {
  const d = derive(actor);
  const out: DerivedWithModifiers = { ...d, limits: { ...d.limits }, limitsAlt: {}, limitsAltConditions: {}, sources: {}, info: [] };
  const src = (k: string) => (out.sources[k] ||= []);
  const always = (m: CollectedModifier) => !m.condition && !m.wireless && !m.info && !m.baked && m.value !== null;
  const byType = (type: string, target?: string) => mods.filter((m) => m.type === type && (target === undefined || m.target === target));

  // Limits
  for (const L of ['physical', 'mental', 'social', 'astral'] as const) {
    if (d.limits[L] === null || d.limits[L] === undefined) continue;
    const lim = limitFor(actor, L, mods, {}, { conditions: [] });
    out.limits[L] = lim.total as number;
    for (const l of lim.lines) src(`limit.${L}`).push({ mod: l.mod, value: l.value, applied: l.state === 'applied', note: l.state === 'off' ? 'conditional' : l.state === 'info' ? 'info' : undefined });
    // Skill-restricted conditional bonuses (« Intimidation, si visible ») are listed too, never added to the alternative value.
    for (const m of byType('limit', L)) {
      if (lim.lines.some((l) => l.mod === m)) continue;
      src(`limit.${L}`).push({ mod: m, value: m.value, applied: false, note: 'conditional' });
    }
    if (lim.alt !== null && lim.alt !== lim.total) {
      out.limitsAlt[L] = lim.alt as number;
      out.limitsAltConditions[L] = lim.altConditions;
    }
  }

  // Condition monitors
  const mon = (target: string) => byType('monitor', target);
  const monitors = actor?.monitors as Record<string, unknown> | null | undefined;
  const tracks: Array<['physicalMonitor' | 'stunMonitor' | 'overflowMax', string, number]> = [['physicalMonitor', 'physical', d.physicalMonitor], ['stunMonitor', 'stun', d.stunMonitor], ['overflowMax', 'overflow', d.overflowMax]];
  for (const [key, target, base] of tracks) {
    const override = key !== 'overflowMax' && monitors?.[target] !== undefined && monitors?.[target] !== null && monitors?.[target] !== '';
    const lines = mon(target).map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m) && !override, note: override ? 'override' : always(m) ? undefined : 'info' }));
    if (lines.length) out.sources[key] = lines;
    // A forced value (grunts, drones, hosts) is kept as is — 0 = no such track (a grunt's stun damage goes to Physical).
    out[key] = override ? Math.max(0, Number(base) || 0) : Math.max(1, base + sumOf(lines));
  }
  // Pain tolerance: threshold = boxes per −1 (3 ± n), thresholdOffset = boxes ignored on EACH track (High Pain Tolerance, Pain
  // Resistance), sharedThresholdOffset = boxes ignored over both tracks together (Damage Compensators: Physical first, then Stun).
  const thr = mon('threshold').map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m) }));
  const off = mon('thresholdOffset').map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m) }));
  const shr = mon('sharedThresholdOffset').map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m) }));
  if (thr.length || off.length || shr.length) {
    const per = Math.max(1, 3 + sumOf(thr));
    const ignore = Math.max(0, sumOf(off));
    const shared = Math.max(0, sumOf(shr));
    const c: Partial<Actor['condition']> = actor?.condition || {};
    const p = Math.max(0, (Number(c.physical) || 0) - ignore);
    const s = Math.max(0, (Number(c.stun) || 0) - ignore);
    const fromP = Math.min(shared, p);
    const fromS = Math.min(shared - fromP, s);
    out.woundModifier = -(Math.floor((p - fromP) / per) + Math.floor((s - fromS) / per)) || 0;
    out.sources.woundModifier = [...thr, ...off, ...shr];
  }
  // Nausea (toxins): wound modifiers doubled.
  const wf = byType('woundFactor');
  if (wf.length) {
    if (out.woundModifier) out.woundModifier *= Math.max(...wf.map((m) => Number(m.value) || 1));
    out.sources.woundModifier = [...(out.sources.woundModifier || []), ...wf.map((m) => ({ mod: m, value: m.value, applied: true }))];
  }

  // Armor (implants, qualities, powers: <armor>) and the values that depend on it
  const armorLines = byType('armor').map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m), note: always(m) ? undefined : 'info' }));
  if (armorLines.length) out.sources.armor = armorLines;
  out.armor = armorTotal(actor) + sumOf(armorLines);
  const stat = (target: string) => byType('stat', target).map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m), note: always(m) ? undefined : m.info ? 'info' : 'conditional' }));
  const soakLines = stat('soak');
  if (soakLines.length) out.sources.soak = soakLines;
  out.soak = attr(actor, 'BOD') + out.armor + sumOf(soakLines);
  for (const k of ['defense', 'composure', 'judgeIntentions', 'memory', 'liftCarry'] as const) {
    const lines = stat(k);
    if (!lines.length) continue;
    out.sources[k] = lines;
    out[k] = d[k] + sumOf(lines);
  }

  // Initiative: dice and score bonuses are stored on the actor (baked) — listed for the tooltip (unbaked: not in the stored values).
  const bakedNote = (m: CollectedModifier) => (m.unbaked ? 'unbaked' : m.baked ? 'baked' : 'info');
  const ini = mods.filter((m) => m.type === 'initiativeDice' || m.type === 'initiative').map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: false, note: bakedNote(m) }));
  if (ini.length) out.sources.initiative = ini;
  const mxi = byType('matrixInitiativeDice').map((m): DerivedSourceLine => ({ mod: m, value: m.value, applied: always(m) }));
  if (mxi.length) {
    out.sources.matrixInitiative = mxi;
    const extra = sumOf(mxi);
    out.matrixInitiative = {
      ar: d.matrixInitiative.ar,
      cold: { ...d.matrixInitiative.cold, dice: Math.min(5, d.matrixInitiative.cold.dice + extra) },
      hot: { ...d.matrixInitiative.hot, dice: Math.min(5, d.matrixInitiative.hot.dice + extra) },
    };
  }
  // Attributes: baked (actor.augmented) — listed per attribute.
  for (const m of byType('attribute')) if (m.target && !m.needsChoice) src(`attr.${m.target}`).push({ mod: m, value: m.value, applied: false, note: bakedNote(m) });

  // Shown only
  for (const m of mods) {
    if (['resist', 'flag', 'attributeMax', 'info', 'choice', 'accuracy', 'matrixAction', 'personaAttribute'].includes(m.type) || m.needsChoice) out.info.push(m);
    else if (m.type === 'stat' && !['soak', 'defense', 'composure', 'judgeIntentions', 'memory', 'liftCarry'].includes(m.target as string)) out.info.push(m);
  }
  return out;
}

/** Signed value text: +2 / −1. */
export function signedValue(v: unknown): string {
  const n = Number(v) || 0;
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/** Keys of the toggles this actor's modifiers can use (server-side validation of payload.conditions). */
export function knownToggles(mods: CollectedModifier[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of mods || []) for (const k of lineToggles(m)) out.add(k);
  return out;
}

/** Keep only the toggle keys this actor's modifiers can use (anything else a client sends is dropped). */
export function cleanConditions(mods: CollectedModifier[] | null | undefined, list: unknown): string[] {
  const known = knownToggles(mods);
  return [...new Set((Array.isArray(list) ? list : []).slice(0, 40).map((x) => String(x).slice(0, 80)))].filter((k) => known.has(k));
}
