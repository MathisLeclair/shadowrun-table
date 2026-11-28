// SR5 character advancement: karma costs, training time, limits, and applying an advance to an actor.
// Pure ES module shared by the server (50-training.js) and the browser (training UI). No Node or DOM APIs.
//
// Sources: SR5 core p.103-107 (« Progression du personnage »), Run Faster, and Run & Gun p.128 (martial arts).
// House rules are flagged below.
//
// Request (normalized by normalizeRequest):
//   { kind, target, to, name?, spec?, attr?, ktype?, karma?, pp?, levels?, maxLevel?, extraPP?, days?,
//     instructor?, note?, catalogId?, positive?, data?: {spell fields}, options?: { group, ordeal, schooling,
//     metamagic, powerPoint }, techniques?: [{ id, name, nameFr? }] (martialArt), free? (GM only: no karma/nuyen) }
//
// Actor fields written by applyAdvance (in addition to the ARCHITECTURE.md Actor schema):
//   actor.magic = { initiation: grade, submersion: grade, metamagics: [string], echoes: [string], extraPP: n }
//     - initiation: initiate grade (raises the MAG maximum by 1 per grade)
//     - submersion: technomancer grade (raises the RES maximum by 1 per grade)
//     - extraPP: power points not coming from MAG (bought by mystic adepts, or gained via initiation by adepts)
//   actor.powers[].pp is the TOTAL power-point cost of that power (all levels included).
//   Skills of a skill group are always materialized in actor.skills (so skillPool() works);
//   actor.skillGroups keeps the intact groups only (a group is removed when it gets broken).
import { METATYPES, SKILLS, SKILL_BY_ID, SKILL_GROUPS, ATTR_LABELS, skillEn, skillKey, type AttrKeyish, type SkillDef } from './sr5.ts';
import { focusKind, focusForce, focusBondMultiplier, fociLimits } from './magic.ts';
import { slug, uid } from './util.ts';
import type {
  ActorLike, ActorMagic, AdeptPower, AdvancementRequest, AdvancementTechnique, Attributes, AttrKey, ComplexForm, I18nEntry, I18nMessage, I18nParams,
  I18nParamValue, KnowledgeSkill, KnowledgeType, MartialArt, Quality, Skill, Spell, TrainingKind, TrainingSettings,
} from './types.ts';

/** Awakened / emerged type of magicProfile(). */
export type AwakenedType = 'adept' | 'mystic' | 'magician' | 'technomancer';
/** Initiation options that each lower the karma cost by 10 %. */
export type InitiationOptions = Partial<Record<'group' | 'ordeal' | 'schooling', unknown>>;
/** Options of costFor() / timeFor(). */
export interface CostOptions {
  /** Adds a specialization. */
  spec?: boolean;
  /** Quality value / free cost. */
  karma?: number;
  /** Initiation options. */
  options?: InitiationOptions | null;
  /** Free progression: days typed by hand. */
  days?: number;
  /** Martial art: the style itself is learned too (karma = style cost). */
  style?: boolean;
}
/** withInstructor() result. */
export interface InstructorTraining {
  days: number;
  weeks: number;
  nuyen: number;
  /** ¥ per week. */
  rate: number;
}
/** magicProfile() result. */
export interface MagicProfile {
  type: AwakenedType | null;
  MAG: number;
  RES: number;
  canCast: boolean;
  hasPowers: boolean;
}
/** powerPoints() result. */
export interface PowerPointsInfo {
  total: number;
  spent: number;
  free: number;
  /** Power points not coming from MAG (actor.magic.extraPP). */
  extra: number;
}
/** groupState() result. */
export interface GroupState {
  intact: boolean;
  rating: number;
  owned: boolean;
  /** French reason the group is broken ('' when intact). */
  reason: string;
  reasonI18n: I18nEntry | null;
  members: string[];
  ratings: number[];
}
/** Full computation of a request (quote()). */
export interface AdvanceQuote {
  kind: TrainingKind | null;
  target: string;
  from: number;
  to: number;
  /** Label (UI key, older requests: French text). */
  label: string;
  labelI18n: I18nEntry;
  karmaCost: number;
  daysBase: number;
  days: number;
  nuyenCost: number;
  instructor: boolean;
  ppCost: number;
  warnings: string[];
  warningsI18n: I18nEntry[];
  /** French error, or null when the request is valid. */
  error: string | null;
  errorI18n: I18nEntry | null;
  /** Not verified against the rules ('other'): always needs the GM. */
  manual: boolean;
  req: AdvancementRequest;
}
/** Another pending request / in-progress job of the actor (TrainingRequest, TrainingJob, or a raw request). */
interface ActiveTraining {
  request?: unknown;
  label?: string;
  labelI18n?: I18nEntry | null;
}
/** quote() context. */
export interface QuoteContext {
  /** Other pending requests + in-progress jobs of this actor (TrainingRequest / TrainingJob, or raw requests). */
  active?: ReadonlyArray<object>;
  /** Karma / nuyen engaged by pending requests. */
  reservedKarma?: number;
  reservedNuyen?: number;
  /** No karma / conflict checks. */
  skipChecks?: boolean;
}
/** Catalog item / draft row read by the catalog helpers: fields vary, so they are read loosely. */
type LooseItem = { [k: string]: unknown; stats?: Record<string, unknown> | null };
/** Legacy / imported grade fields read as fallbacks (not in the Actor schema). */
type LegacyGrades = ActorLike & {
  magic?: (ActorMagic & { initiateGrade?: number }) | null;
  initiation?: number;
  resonance?: { submersion?: number } | null;
};

// i18n (see docs/i18n.md): English is the source text. Static texts are marked with tk() and
// rendered with t() by the client; dynamic texts are also returned as { key, params } (labelI18n, errorI18n,
// warningsI18n, reasonI18n) and nested translatable params use the { t: key, params } form.
function tk(s: string): string {
  return s;
}
/** English rendering of a key with {placeholders} (nested { t, params } values allowed) — same output as formatSource(). */
function render(key: string, params?: I18nParams): string {
  const val = (v: I18nParamValue | undefined): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(val).join(', ');
    if (typeof v === 'object') {
      const msg = v as Partial<I18nMessage>;
      return typeof msg.t === 'string' ? render(msg.t.includes('::') ? msg.t.slice(msg.t.indexOf('::') + 2) : msg.t, msg.params) : '';
    }
    return String(v);
  };
  return String(key ?? '').replace(/\{(\w+)\}/g, (m: string, n: string) => (params && Object.prototype.hasOwnProperty.call(params, n) ? val(params[n]) : m));
}
/** { key, params } → nested translatable param value { t, params }. */
const nested = (m: I18nEntry | null | undefined): I18nMessage | string =>
  m && typeof m === 'object' && m.key ? { t: m.key, ...(m.params ? { params: m.params } : {}) } : ((m ?? '') as I18nMessage | string);
/** Translatable param for a skill name: SR5 skills (stored French name or English name) become their English key, custom names stay as typed. */
const skillParam = (name: string, def: SkillDef | null | undefined): I18nMessage | string => (def && (!name || name === def.fr || name === skillEn(def)) ? { t: skillKey(def) } : name || '');

export const KINDS: TrainingKind[] = ['attribute', 'skill', 'skillGroup', 'specialization', 'knowledge', 'quality', 'removeQuality', 'spell', 'complexForm', 'power', 'powerPoint', 'initiation', 'martialArt', 'focus', 'other'];

export const KIND_LABELS: Record<TrainingKind, string> = {
  attribute: tk('Attribute'),
  skill: tk('Skill'),
  skillGroup: tk('Skill Group'),
  specialization: tk('Specialization'),
  knowledge: tk('Knowledge'),
  quality: tk('Quality'),
  removeQuality: tk('Quality buy-off'),
  spell: tk('Spell'),
  complexForm: tk('Complex Form'),
  power: tk('Adept Power'),
  powerPoint: tk('Power Point'),
  initiation: tk('Initiation'),
  martialArt: tk('Martial Art'),
  focus: tk('Focus bonding'),
  other: tk('Other'),
};

/** Human-readable rules, used as tooltips in the UI. */
export const RULE_TEXT: Record<TrainingKind | 'instructor', string> = {
  attribute: tk('Attribute: new rating × 5 karma (sum of each rating) · Time: new rating × 1 week'),
  skill: tk('Active skill: new rating × 2 karma (new skill: 2) · Time: ratings 1–4 = rating in days, 5–8 = rating in weeks, 9+ = rating × 2 weeks'),
  focus: tk('Focus bonding: Force × 2 karma (spell, spirit, qi foci), × 3 (weapon, enchanting, metamagic), × 6 (power) · at most Magic foci, total Force ≤ Magic × 5 · Time: Force hours (SR5 p. 318)'),
  skillGroup: tk('Skill group: new rating × 5 karma (new group: 5) · Time: new rating × 2 weeks · Impossible if the group is broken'),
  specialization: tk('Specialization: 7 karma · Time: 1 month'),
  knowledge: tk('Knowledge / language: new rating × 1 karma (new: 1) · Time: ratings 1–4 = rating in days, 5+ = rating in weeks'),
  quality: tk('Positive quality: quality cost × 2 karma · Time (house rule): 1 week per 5 karma of the quality'),
  removeQuality: tk('Buy off a negative quality: quality bonus × 2 karma · Time (house rule): 1 week per 5 karma'),
  spell: tk('Spell, ritual or alchemical preparation: 5 karma · Time: 1 day'),
  complexForm: tk('Complex form: 4 karma · Time: 1 day'),
  power: tk('Adept power: paid with free Power Points (no karma), immediate'),
  powerPoint: tk('Power Point (mystic adept): 5 karma, maximum = Magic'),
  initiation: tk('Initiation / submersion: 10 + (new grade × 3) karma, −10% per option (group, ordeal, schooling) · Time: 1 month'),
  martialArt: tk('Martial art (Run & Gun p.128): new style 7 karma (some styles more), first technique included · Time: 1 month · Further technique: 5 karma, 2 weeks · Instructor: 2,500¥ per style, 1,500¥ per technique'),
  other: tk('Free advancement: cost and time set by hand (always approved by the GM)'),
  instructor: tk('Instructor: an Instruction test reduces the training time (reduction set by the GM) — cost in nuyen per week'),
};

export const DEFAULT_SETTINGS: TrainingSettings = {
  approval: 'always', // 'always' = every request waits for the GM, 'never' = auto-approved (manual entries still wait)
  useTime: true, // false = advances apply immediately on approval
  instructorTimeReduction: 25, // percent
  instructorCostPerWeek: { attribute: 1000, skill: 500, knowledge: 250, other: 500 },
};

export const KNOWLEDGE_TYPES: Record<KnowledgeType, string> = {
  street: tk('Street'),
  academic: tk('Academic'),
  professional: tk('Professional'),
  interest: tk('Interest'),
  language: tk('Language'),
};

/**
 * Martial arts (Run & Gun p.128, « Learning martial arts » table): a new style costs its catalog karma (7; Way of Unified
 * Mana 15) and takes 1 month, its first technique included; each further technique costs 5 karma and takes 2 weeks.
 * Instruction costs 2,500¥ for a style and 1,500¥ per technique (the instructor also cuts the time like any training).
 */
export const MARTIAL_RULES = { styleKarma: 7, techniqueKarma: 5, styleDays: 30, techniqueDays: 14, styleNuyen: 2500, techniqueNuyen: 1500 };

export const SKILL_MAX = 12; // in play (13 with Aptitude)
export const KNOWLEDGE_MAX = 12;
export const GROUP_MAX = 12;
export const TRAINABLE_ATTRS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES'];

const ATTR_WORDS: Record<string, string[]> = {
  BOD: ['constitution', 'body'], AGI: ['agilite', 'agility'], REA: ['reaction'], STR: ['force', 'strength'],
  WIL: ['volonte', 'willpower'], LOG: ['logique', 'logic'], INT: ['intuition'], CHA: ['charisme', 'charisma'],
  EDG: ['chance', 'edge'], MAG: ['magie', 'magic'], RES: ['resonance'],
};

class RuleError extends Error {
  key: string;
  params: I18nParams | undefined;
  constructor(key: string, params?: I18nParams) {
    super(render(key, params));
    this.key = key;
    this.params = params;
  }
}
/** Throw a rule violation: bad(tk('Text {x}'), { x }) — source message + i18n key/params. */
function bad(key: string, params?: I18nParams): never {
  throw new RuleError(key, params);
}

const int = (v: unknown, d = 0): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : d;
};
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const norm = (s: unknown): string => slug(String(s || '')).replace(/-/g, ' ');
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Same item name, ignoring case/accents and a trailing « (extra) », in either language. */
const sameName = (have: unknown, name: unknown, alt?: unknown): boolean => {
  const h = norm(String(have || '').replace(/\s*\(.*\)\s*$/, ''));
  return !!h && (h === norm(name) || (!!alt && h === norm(alt)) || norm(have) === norm(name));
};
const truthy = (v: unknown): boolean => v === true || v === 'True' || v === 'true' || v === 1 || v === '1';
const sumSteps = (from: number, to: number, f: (r: number) => number): number => {
  let s = 0;
  for (let r = Math.max(0, from) + 1; r <= to; r++) s += f(r);
  return s;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Plain English text (tests, logs): 1 -> "1 day", 14 -> "2 weeks", 30 -> "1 month", 10 -> "1 week and 3 days", 0 -> "immediate". The UI uses formatDaysI18n(). */
export function formatDays(days: unknown): string {
  const m = formatDaysI18n(days);
  return render(m.t.replace(/^[^:]*::/, ''), m.params);
}

/** formatDays() as a translatable value { t, params } (render: t(v.t, v.params)). */
export function formatDaysI18n(days: unknown): I18nMessage {
  const d = Math.max(0, Math.round(Number(days) || 0));
  if (d === 0) return { t: 'immediate' };
  const months = (n: number): I18nMessage => (n > 1 ? { t: '{n} months', params: { n } } : { t: 'a::{n} month', params: { n } });
  const dayN = (n: number): I18nMessage => (n > 1 ? { t: '{n} days', params: { n } } : { t: '{n} day', params: { n } });
  const weekN = (n: number): I18nMessage => (n > 1 ? { t: '{n} weeks', params: { n } } : { t: '{n} week', params: { n } });
  if (d % 30 === 0) return months(d / 30);
  if (d < 7) return dayN(d);
  const w = Math.floor(d / 7);
  const r = d % 7;
  return r ? { t: '{weeks} and {days}', params: { weeks: weekN(w), days: dayN(r) } } : weekN(w);
}

// ---------------------------------------------------------------------------
// Costs & times
// ---------------------------------------------------------------------------

/** Initiation discount factor from options { group, ordeal, schooling } (−10 % each). */
export function initiationFactor(options: InitiationOptions | null = {}): number {
  const n = (['group', 'ordeal', 'schooling'] as const).filter((k) => options && options[k]).length;
  return 1 - 0.1 * n;
}

/**
 * Karma cost of going from `from` to `to`.
 * opts: { spec (adds a specialization), karma (quality value / free cost), options (initiation) }
 */
export function costFor(kind: TrainingKind | null | undefined, fromRating: unknown = 0, toRating: unknown = 0, opts: CostOptions = {}): number {
  const from = int(fromRating);
  const to = int(toRating);
  switch (kind) {
    case 'attribute':
      return sumSteps(from, to, (r) => r * 5);
    case 'skill':
      return sumSteps(from, to, (r) => r * 2) + (opts.spec ? 7 : 0);
    case 'skillGroup':
      return sumSteps(from, to, (r) => r * 5);
    case 'knowledge':
      return sumSteps(from, to, (r) => r) + (opts.spec ? 7 : 0);
    case 'specialization':
      return 7;
    case 'quality':
    case 'removeQuality':
      return Math.abs(Math.round(num(opts.karma))) * 2;
    case 'spell':
      return 5;
    case 'complexForm':
      return 4;
    case 'power':
      return 0;
    case 'powerPoint':
      return sumSteps(from, to, () => 5);
    case 'initiation': {
      const f = initiationFactor(opts.options);
      return sumSteps(from, to, (g) => Math.ceil((10 + g * 3) * f));
    }
    case 'martialArt':
      return (opts.style ? Math.round(num(opts.karma)) || MARTIAL_RULES.styleKarma : 0) + martialPaidTechniques(from, to, opts) * MARTIAL_RULES.techniqueKarma;
    case 'focus':
    case 'other':
      return Math.max(0, Math.round(num(opts.karma)));
    default:
      return 0;
  }
}

/**
 * Martial art: techniques paid on their own (from = techniques already known in the style, to = after the training).
 * RG p.128: the style includes its first technique — also a known style without any technique (bought without, imported).
 */
function martialPaidTechniques(from: number, to: number, opts: CostOptions): number {
  const n = Math.max(0, to - from);
  return opts.style || from === 0 ? Math.max(0, n - 1) : n;
}

/** Martial art instruction cost in nuyen (RG p.128): 2,500¥ for a new style (first technique included), 1,500¥ per further technique. */
export function martialInstructionCost(fromTechniques: unknown, toTechniques: unknown, newStyle: boolean): number {
  return (newStyle ? MARTIAL_RULES.styleNuyen : 0) + martialPaidTechniques(int(fromTechniques), int(toTechniques), { style: newStyle }) * MARTIAL_RULES.techniqueNuyen;
}

/** Training time in days (without instructor). opts: { spec, karma, days } */
export function timeFor(kind: TrainingKind | null | undefined, fromRating: unknown = 0, toRating: unknown = 0, opts: CostOptions = {}): number {
  const from = int(fromRating);
  const to = int(toRating);
  switch (kind) {
    case 'attribute':
      return sumSteps(from, to, (r) => r * 7);
    case 'skill':
      return sumSteps(from, to, (r) => (r <= 4 ? r : r <= 8 ? r * 7 : r * 14)) + (opts.spec ? 30 : 0);
    case 'skillGroup':
      return sumSteps(from, to, (r) => r * 14);
    case 'knowledge':
      return sumSteps(from, to, (r) => (r <= 4 ? r : r * 7)) + (opts.spec ? 30 : 0);
    case 'specialization':
      return 30;
    case 'quality':
    case 'removeQuality':
      // House rule: one week per started block of 5 karma of the quality's value.
      return Math.max(1, Math.ceil(Math.abs(num(opts.karma)) / 5)) * 7;
    case 'spell':
    case 'complexForm':
      return 1;
    case 'power':
    case 'powerPoint':
      return 0;
    case 'initiation':
      return Math.max(1, to - from) * 30;
    case 'martialArt':
      return (opts.style ? MARTIAL_RULES.styleDays : 0) + martialPaidTechniques(from, to, opts) * MARTIAL_RULES.techniqueDays;
    case 'focus':
      return 0; // Force hours (SR5 p. 318): done at approval
    case 'other':
      return Math.max(0, int(opts.days));
    default:
      return 0;
  }
}

/** Which instructor price applies to a kind. */
export function instructorCategory(kind: TrainingKind | null | undefined): keyof TrainingSettings['instructorCostPerWeek'] {
  if (kind === 'attribute') return 'attribute';
  if (kind === 'skill' || kind === 'skillGroup' || kind === 'specialization') return 'skill';
  if (kind === 'knowledge') return 'knowledge';
  return 'other';
}

/** Training with an instructor: { days, weeks, nuyen }. */
export function withInstructor(
  days: unknown,
  kind: TrainingKind | null | undefined,
  settings: Partial<TrainingSettings> | null | undefined = DEFAULT_SETTINGS,
): InstructorTraining {
  const red = Math.max(0, Math.min(90, num(settings?.instructorTimeReduction, DEFAULT_SETTINGS.instructorTimeReduction)));
  const base = Math.max(0, int(days));
  const reduced = base > 0 ? Math.max(1, Math.ceil(base * (1 - red / 100))) : 0;
  const weeks = Math.ceil(reduced / 7);
  const cat = instructorCategory(kind);
  const rate = Math.max(0, num(settings?.instructorCostPerWeek?.[cat], DEFAULT_SETTINGS.instructorCostPerWeek[cat]));
  return { days: reduced, weeks, nuyen: weeks * rate, rate };
}

// ---------------------------------------------------------------------------
// Actor helpers
// ---------------------------------------------------------------------------

export function hasQuality(actor: ActorLike | null | undefined, re: RegExp): boolean {
  return (actor?.qualities || []).some((q) => re.test(String(q?.name || '')));
}

function qualityMentions(q: { name?: string; notes?: string } | null | undefined, words: string[]): boolean {
  const text = norm(`${q?.name || ''} ${q?.notes || ''}`);
  return words.some((w) => new RegExp(`(^| )${norm(w)}( |$)`).test(text));
}

/** Exceptional Attribute applies to `key` (or is unspecified, then it may apply to any attribute). */
function hasExceptional(actor: ActorLike | null | undefined, key: string): boolean {
  const qs = (actor?.qualities || []).filter((q) => /exceptional attribute|attribut exceptionnel/i.test(q?.name || ''));
  if (!qs.length) return false;
  for (const q of qs) {
    if (qualityMentions(q, [key, ...(ATTR_WORDS[key] || [])])) return true;
    const any = Object.entries(ATTR_WORDS).some(([k, w]) => qualityMentions(q, [k, ...w]));
    if (!any) return true;
  }
  return false;
}

function hasAptitude(actor: ActorLike | null | undefined, skillId: string, skillName?: string): boolean {
  const qs = (actor?.qualities || []).filter((q) => /aptitude/i.test(q?.name || ''));
  if (!qs.length) return false;
  const def = SKILL_BY_ID[skillId];
  const words = [skillId.replace(/_/g, ' '), skillName, def?.fr, def && skillEn(def)].filter(Boolean);
  for (const q of qs) {
    const text = norm(`${q.name} ${q.notes || ''}`).replace(/^aptitude ?/, '').trim();
    if (!text) return true; // unspecified: let the GM judge
    if (words.some((w) => text.includes(norm(w)))) return true;
  }
  return false;
}

export function initiationGrade(actor: ActorLike | null | undefined): number {
  const a = actor as LegacyGrades | null | undefined;
  return Math.max(0, int(a?.magic?.initiation ?? a?.magic?.initiateGrade ?? a?.initiation ?? 0));
}
export function submersionGrade(actor: ActorLike | null | undefined): number {
  const a = actor as LegacyGrades | null | undefined;
  return Math.max(0, int(a?.magic?.submersion ?? a?.resonance?.submersion ?? 0));
}

/** Maximum natural rating of an attribute for this actor (metatype, Exceptional Attribute, Lucky, essence, grade). */
export function attrMax(actor: ActorLike | null | undefined, key: AttrKeyish): number {
  if (key === 'MAG' || key === 'RES') {
    const grade = key === 'MAG' ? initiationGrade(actor) : submersionGrade(actor);
    const ess = num(actor?.attributes?.ESS, 6);
    const loss = Math.max(0, Math.ceil(6 - ess - 1e-9));
    return Math.max(0, 6 + grade - loss);
  }
  if (key === 'ESS') return 6;
  const meta = METATYPES[actor?.metatype as string] || METATYPES.Humain;
  let max = (meta.max as Record<string, number>)[key] ?? 6;
  if (hasExceptional(actor, key)) max += 1;
  if (key === 'EDG' && hasQuality(actor, /^(lucky|chanceux)/i)) max += 1;
  return max;
}

/** Awakened / emerged profile: { type: 'adept'|'mystic'|'magician'|'technomancer'|null, MAG, RES, canCast, hasPowers }. */
export function magicProfile(actor: ActorLike | null | undefined): MagicProfile {
  const MAG = Math.max(0, int(actor?.attributes?.MAG));
  const RES = Math.max(0, int(actor?.attributes?.RES));
  let type: AwakenedType | null = null;
  if (hasQuality(actor, /mystic|mystique/i)) type = 'mystic';
  else if (hasQuality(actor, /^adepte?(\s|$|\(|:)/i)) type = 'adept';
  else if (hasQuality(actor, /^(magician|magicien|aspected|apprentice|apprenti|explorer|explorateur|enchanter|enchanteur|aware)/i)) type = 'magician';
  else if (hasQuality(actor, /technoman/i)) type = 'technomancer';
  else if (MAG > 0) type = (actor?.powers || []).length && !(actor?.spells || []).length ? 'adept' : 'magician';
  else if (RES > 0) type = 'technomancer';
  return { type, MAG, RES, canCast: type === 'magician' || type === 'mystic', hasPowers: type === 'adept' || type === 'mystic' };
}

/** Power points: { total, spent, free }. Adepts: MAG + extraPP; mystic adepts: bought (extraPP). */
export function powerPoints(actor: ActorLike | null | undefined): PowerPointsInfo {
  const p = magicProfile(actor);
  const extra = Math.max(0, num(actor?.magic?.extraPP));
  const total = (p.type === 'adept' ? p.MAG : 0) + extra;
  const spent = round2((actor?.powers || []).reduce((s, x) => s + Math.max(0, num(x?.pp)), 0));
  return { total, spent, free: round2(total - spent), extra };
}

export function findSkill(actor: ActorLike | null | undefined, id: string | null | undefined): Skill | null {
  if (!id) return null;
  const n = norm(id);
  return (actor?.skills || []).find((s) => s.id === id) || (actor?.skills || []).find((s) => norm(s.name) === n || norm(s.id) === n) || null;
}

export function findKnowledge(actor: ActorLike | null | undefined, idOrName: string | null | undefined): KnowledgeSkill | null {
  if (!idOrName) return null;
  const n = norm(idOrName);
  return (actor?.knowledge || []).find((k) => k.id === idOrName) || (actor?.knowledge || []).find((k) => norm(k.name) === n) || null;
}

function intactGroupEntry(actor: ActorLike | null | undefined, groupId: string) {
  return (actor?.skillGroups || []).find((g) => g.id === groupId && int(g.rating) > 0) || null;
}

/** Current rating of an active skill, counting an intact skill group. */
export function skillRating(actor: ActorLike | null | undefined, id: string): number {
  const e = findSkill(actor, id);
  const r = int(e?.rating);
  const def = SKILL_BY_ID[e?.id || id];
  const g = def?.group ? intactGroupEntry(actor, def.group) : null;
  return Math.max(r, g ? int(g.rating) : 0);
}

export function groupMembers(groupId: string): string[] {
  return SKILLS.filter((s) => s.group === groupId).map((s) => s.id);
}

/** State of a skill group: { intact, rating, owned, reason }. */
export function groupState(actor: ActorLike | null | undefined, groupId: string): GroupState {
  const members = groupMembers(groupId);
  const grp = intactGroupEntry(actor, groupId);
  const gr = grp ? int(grp.rating) : 0;
  const ratings = members.map((id) => Math.max(int(findSkill(actor, id)?.rating), gr));
  const withSpec = members.filter((id) => String(findSkill(actor, id)?.spec || '').trim());
  const same = ratings.every((r) => r === ratings[0]);
  let reasonI18n: I18nEntry | null = null;
  if (!same) reasonI18n = { key: tk('the group\'s skills don\'t all have the same rating') };
  else if (withSpec.length) reasonI18n = { key: tk('specialization in {skills}'), params: { skills: withSpec.map((id) => (SKILL_BY_ID[id] ? { t: skillKey(id) } : id)) } };
  const reason = reasonI18n ? render(reasonI18n.key, reasonI18n.params) : '';
  return { intact: same && !withSpec.length, rating: same ? ratings[0] || 0 : 0, owned: !!grp, reason, reasonI18n, members, ratings };
}

// ---------------------------------------------------------------------------
// Catalog helpers (catalog items come from data/catalog/*.json; fields vary, so be tolerant)
// ---------------------------------------------------------------------------

export function catalogName(item: { name?: string; nameFr?: string } | null | undefined): string {
  return String(item?.nameFr || item?.name || '');
}
export function qualityInfo(it: object | null | undefined): { karma: number; positive: boolean } {
  const item = it as LooseItem | null | undefined;
  const raw = item?.karma ?? item?.stats?.karma ?? item?.cost ?? 0;
  const karma = num(raw);
  const cat = String(item?.category || item?.stats?.category || '');
  const positive = item?.positive ?? item?.stats?.positive ?? (/neg/i.test(cat) ? false : karma >= 0);
  return { karma: Math.abs(karma), positive: !!positive };
}
export function powerInfo(it: object | null | undefined): { pp: number; levels: boolean; maxLevel: number | null; extraPP: number } {
  const item = it as LooseItem | null | undefined;
  const s: Record<string, unknown> = item?.stats || {};
  const pp = num(item?.pp ?? item?.points ?? s.points ?? s.pp ?? s.powerPoints ?? item?.cost ?? 0);
  const levels = truthy(item?.levels ?? s.levels);
  const maxLevel = int(item?.maxLevel ?? s.maxLevel ?? s.maxLevels ?? s.maxlevels ?? 0) || null;
  const extraPP = num(item?.extraPP ?? s.extrapointcost ?? s.extraPointCost ?? 0);
  return { pp, levels, maxLevel, extraPP };
}
/** Catalog spell category (English) → French name. spellInfo() stores the French name in requests (kept French for save compatibility); chargen shows it in French. */
export const SPELL_CATEGORIES: Record<string, string> = { Combat: 'Combat', Detection: 'Détection', Health: 'Santé', Illusion: 'Illusion', Manipulation: 'Manipulation', Rituals: 'Rituels', Enchantments: 'Enchantements' };
export function spellInfo(it: object | null | undefined): AdvancementRequest['data'] {
  const item = it as LooseItem | null | undefined;
  const s: Record<string, unknown> = item?.stats || {};
  const str = (v: unknown) => String(v ?? '').slice(0, 40);
  return {
    category: str(item?.categoryFr || SPELL_CATEGORIES[item?.category as string] || item?.category || s.category),
    type: str(s.type ?? item?.type),
    range: str(s.range ?? item?.range),
    duration: str(s.duration ?? item?.duration),
    drain: str(s.dv ?? s.drain ?? item?.dv ?? item?.drain),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function normalizeRequest(raw: unknown): AdvancementRequest {
  // A raw player payload (or an already normalized request): every field is checked.
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const o = (r.options && typeof r.options === 'object' ? r.options : {}) as Record<string, unknown>;
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
  const toRaw = r.to;
  const to = toRaw === undefined || toRaw === null || toRaw === '' || !Number.isFinite(Number(toRaw)) ? null : Math.trunc(Number(toRaw));
  return {
    kind: (KINDS as unknown[]).includes(r.kind) ? (r.kind as TrainingKind) : null,
    target: str(r.target, 80),
    to,
    name: str(r.name, 80),
    altName: str(r.altName, 80), // other-language name (catalog), used for duplicate checks
    spec: str(r.spec, 60),
    attr: (TRAINABLE_ATTRS as unknown[]).includes(r.attr) ? (r.attr as AttrKey) : '',
    ktype: KNOWLEDGE_TYPES[r.ktype as KnowledgeType] ? (r.ktype as KnowledgeType) : '',
    karma: Math.max(0, Math.min(500, Math.round(Math.abs(num(r.karma))))),
    pp: Math.max(0, Math.min(10, round2(num(r.pp)))),
    extraPP: Math.max(0, Math.min(10, round2(num(r.extraPP)))),
    levels: truthy(r.levels),
    maxLevel: int(r.maxLevel) > 0 ? Math.min(20, int(r.maxLevel)) : null,
    days: Math.max(0, Math.min(3650, int(r.days))),
    instructor: !!r.instructor,
    note: str(r.note, 300),
    catalogId: str(r.catalogId, 120),
    positive: r.positive === false ? false : true,
    data: { category: str(d.category, 40), type: str(d.type, 40), range: str(d.range, 40), duration: str(d.duration, 40), drain: str(d.drain, 40) },
    options: { group: !!o.group, ordeal: !!o.ordeal, schooling: !!o.schooling, metamagic: str(o.metamagic, 80), powerPoint: !!o.powerPoint },
    techniques: normalizeTechniques(r.techniques),
    free: !!r.free,
  };
}

/** Techniques of a 'martialArt' request: [{ id, name, nameFr? }] (ids alone accepted), unique ids, at most 20. */
function normalizeTechniques(raw: unknown): AdvancementTechnique[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const out: AdvancementTechnique[] = [];
  for (const x of raw.slice(0, 20)) {
    const o = (x && typeof x === 'object' ? x : { id: x }) as Record<string, unknown>;
    const id = str(o.id, 80);
    if (!id || out.some((t) => t.id === id)) continue;
    const t: AdvancementTechnique = { id, name: str(o.name, 80) || id };
    if (o.nameFr) t.nameFr = str(o.nameFr, 80);
    out.push(t);
  }
  return out;
}

/** The actor's entry for a martial art style (by catalog id, else by name for entries without one). */
export function findMartialArt(actor: ActorLike | null | undefined, catalogId: string, name?: string, altName?: string): MartialArt | null {
  const list = Array.isArray(actor?.martialArts) ? actor.martialArts : [];
  return list.find((m) => catalogId && m.catalogId === catalogId) || (name ? list.find((m) => !m.catalogId && sameName(m.name, name, altName)) : null) || null;
}

/** Keys used to detect conflicting trainings (same thing twice, or two attributes at once). */
export function conflictKeys(actor: ActorLike | null | undefined, raw: unknown): string[] {
  const req = normalizeRequest(raw);
  const t = req.target;
  switch (req.kind) {
    case 'attribute':
      return ['attribute'];
    case 'skill': {
      const e = findSkill(actor, t);
      const id = e?.id || t || slug(req.name);
      const g = SKILL_BY_ID[id]?.group;
      return [`skill:${id}`, ...(g ? [`group:${g}`] : [])];
    }
    case 'skillGroup':
      return [`group:${t}`, ...groupMembers(t).map((id) => `skill:${id}`)];
    case 'specialization': {
      const e = findSkill(actor, t);
      const g = SKILL_BY_ID[e?.id || t]?.group;
      return [`spec:${e?.id || t}`, ...(g ? [`group:${g}`] : [])];
    }
    case 'knowledge': {
      const e = findKnowledge(actor, t) || findKnowledge(actor, req.name);
      return [`know:${slug(e?.name || req.name || t)}`];
    }
    case 'quality':
      return [`quality:${slug(req.name || t)}`];
    case 'removeQuality': {
      const q = (actor?.qualities || []).find((x) => x.id === t);
      return [`quality:${slug(q?.name || t)}`];
    }
    case 'spell':
      return [`spell:${slug(req.name || t)}`];
    case 'complexForm':
      return [`cf:${slug(req.name || t)}`];
    case 'power':
      return ['powers'];
    case 'powerPoint':
      return ['pp'];
    case 'initiation':
      return ['initiation'];
    case 'martialArt':
      return [`martial:${req.catalogId || slug(req.name || t)}`];
    case 'focus':
      return [`focus:${t}`];
    default:
      return [];
  }
}

/** Short label (source text) for a request. */
export function describe(actor: ActorLike | null | undefined, raw: unknown): string {
  const q = quote(actor, raw, { ...DEFAULT_SETTINGS, useTime: false }, { skipChecks: true });
  return q.label;
}

/** Translatable label of a request: { key, params } (render with t(key, params)). */
export function describeI18n(actor: ActorLike | null | undefined, raw: unknown): I18nEntry {
  const q = quote(actor, raw, { ...DEFAULT_SETTINGS, useTime: false }, { skipChecks: true });
  return q.labelI18n;
}

function setLabel(out: AdvanceQuote, key: string, params?: I18nParams): void {
  out.labelI18n = params ? { key, params } : { key };
  out.label = render(key, params);
}
/** Append to the current label: key must contain {label}. */
function addToLabel(out: AdvanceQuote, key: string, params?: I18nParams): void {
  setLabel(out, key, { label: nested(out.labelI18n), ...(params || {}) });
}
function warn(out: AdvanceQuote, key: string, params?: I18nParams): void {
  out.warnings.push(render(key, params));
  out.warningsI18n.push(params ? { key, params } : { key });
}

/**
 * Full computation for a request: from/to, label, karma, days, nuyen, warnings, error.
 * Texts are French; labelI18n / errorI18n / warningsI18n carry the same texts as { key, params } for translation.
 * settings: training settings. ctx: {
 *   active: [request] (other pending requests + in-progress jobs of this actor, normalized or raw),
 *   reservedKarma, reservedNuyen (engaged by pending requests), skipChecks (no karma/conflict checks) }
 */
export function quote(
  actor: ActorLike | null | undefined,
  raw: unknown,
  settings: Partial<TrainingSettings> | null | undefined = DEFAULT_SETTINGS,
  ctx: QuoteContext = {},
): AdvanceQuote {
  const req = normalizeRequest(raw);
  const st: TrainingSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const out: AdvanceQuote = {
    kind: req.kind, target: req.target, from: 0, to: req.to ?? 0, label: '', labelI18n: { key: '' }, // set just below
    karmaCost: 0, daysBase: 0, days: 0, nuyenCost: 0, instructor: false, ppCost: 0, warnings: [], warningsI18n: [], error: null, errorI18n: null,
    manual: false, req,
  };
  setLabel(out, KIND_LABELS[req.kind as TrainingKind] || tk('Advancement'));
  try {
    if (!actor) bad(tk('Character not found'));
    if (!req.kind) bad(tk('Unknown advancement type'));
    const costOpts: CostOptions = { spec: false, karma: 0, options: req.options, days: req.days };
    resolveKind(actor, req, out, costOpts);
    req.to = out.to; // the stored request carries the resolved target rating (used by applyAdvance)
    out.karmaCost = req.free ? 0 : costFor(req.kind, out.from, out.to, costOpts);
    out.daysBase = timeFor(req.kind, out.from, out.to, costOpts);
    out.days = st.useTime ? out.daysBase : 0;
    if (st.useTime && req.instructor && out.daysBase > 0) {
      const ins = withInstructor(out.daysBase, req.kind, st);
      out.instructor = true;
      out.days = ins.days;
      // Martial arts: the book's instruction cost (RG p.128) instead of the per-week rate.
      out.nuyenCost = req.free ? 0 : req.kind === 'martialArt' ? martialInstructionCost(out.from, out.to, !!costOpts.style) : ins.nuyen;
    }
    if (!ctx.skipChecks) {
      const mine = conflictKeys(actor, req);
      for (const o of ctx.active || []) {
        const other = o as ActiveTraining;
        const keys = conflictKeys(actor, other.request || other);
        if (keys.some((k) => mine.includes(k))) {
          if (mine.includes('attribute') && keys.includes('attribute')) bad(tk('One attribute at a time: an attribute training is already in progress or pending'));
          const label = other.labelI18n ? nested(other.labelI18n) : other.label || nested(describeI18n(actor, other.request || other));
          bad(tk('Already in progress or pending: {label}'), { label });
        }
      }
      const karma = num(actor.karma) - num(ctx.reservedKarma);
      if (out.karmaCost > karma) {
        const p = { cost: out.karmaCost, have: Math.max(0, karma) };
        if (karma > 1) bad(tk('Not enough karma: {cost} needed, {have} available'), p);
        else bad(tk('Not enough karma: {cost} needed, {have} available'), p);
      }
      const nuyen = num(actor.nuyen) - num(ctx.reservedNuyen);
      if (out.nuyenCost > nuyen) bad(tk('Not enough nuyen for the instructor: {cost}¥ needed, {have}¥ available'), { cost: out.nuyenCost, have: Math.max(0, nuyen) });
    }
  } catch (e) {
    if (e instanceof RuleError) {
      out.error = e.message;
      out.errorI18n = e.params ? { key: e.key, params: e.params } : { key: e.key };
    } else throw e;
  }
  return out;
}

/** Error message (French) or null. Same options as quote(). */
export function validate(
  actor: ActorLike | null | undefined,
  request: unknown,
  settings: Partial<TrainingSettings> | null | undefined = DEFAULT_SETTINGS,
  ctx: QuoteContext = {},
): string | null {
  return quote(actor, request, settings, ctx).error;
}

function targetTo(req: AdvancementRequest, out: AdvanceQuote, cur: number): void {
  out.from = cur;
  out.to = req.to ?? cur + 1;
  if (out.to <= cur) bad(tk('The new rating must exceed the current rating ({cur})'), { cur });
}

function resolveKind(actor: ActorLike, req: AdvancementRequest, out: AdvanceQuote, costOpts: CostOptions): void {
  const prof = magicProfile(actor);
  switch (req.kind) {
    case 'attribute': {
      const key = req.target.toUpperCase();
      if (!(TRAINABLE_ATTRS as string[]).includes(key)) bad(tk('Unknown or untrainable attribute'));
      req.target = key;
      out.target = key;
      const cur = Math.max(0, int((actor.attributes as Record<string, number> | null | undefined)?.[key]));
      if (key === 'MAG' && cur <= 0) bad(tk('This character is not Awakened (no Magic)'));
      if (key === 'RES' && cur <= 0) bad(tk('This character has not Emerged (no Resonance)'));
      const attr = { t: ATTR_LABELS[key as AttrKey] };
      setLabel(out, tk('{attr} {from} → {to}'), { attr, from: cur, to: req.to ?? cur + 1 });
      targetTo(req, out, cur);
      const max = attrMax(actor, key);
      if (out.to > max) {
        const meta = actor.metatype || 'Humain'; // stored value, French for save compatibility
        const why = key === 'MAG' || key === 'RES' ? { t: 'Essence and grade included' } : METATYPES[meta] ? { t: meta } : meta;
        bad(tk('{attr}: maximum {max} ({why})'), { attr, max, why });
      }
      return;
    }
    case 'skill': {
      const entry = findSkill(actor, req.target);
      const id = entry?.id || (SKILL_BY_ID[req.target] ? req.target : slug(req.name || req.target));
      if (!id) bad(tk('Unknown skill'));
      const def = SKILL_BY_ID[id];
      const name = entry?.name || def?.fr || req.name || req.target;
      const nameP = skillParam(name, def);
      if (!def && !entry && !req.name) bad(tk('Enter the name of the new skill'));
      req.target = id;
      out.target = id;
      if (def?.cat === 'magic' && prof.MAG <= 0) bad(tk('Magical skill: you must be Awakened'));
      if (def?.cat === 'resonance' && prof.RES <= 0) bad(tk('Resonance skill: you must be a technomancer'));
      const cur = skillRating(actor, id);
      if (cur === 0) setLabel(out, tk('New skill: {name} {to}'), { name: nameP, to: req.to ?? 1 });
      else setLabel(out, tk('{name} {from} → {to}'), { name: nameP, from: cur, to: req.to ?? cur + 1 });
      targetTo(req, out, cur);
      const max = SKILL_MAX + (hasAptitude(actor, id, name) ? 1 : 0);
      if (out.to > max) bad(tk('{name}: maximum {max} in play'), { name: nameP, max });
      if (def?.group && intactGroupEntry(actor, def.group)) warn(out, tk('Breaks the {group} group'), { group: { t: SKILL_GROUPS[def.group] } });
      if (req.spec) {
        costOpts.spec = true;
        addToLabel(out, tk('{label} (spec. {spec})'), { spec: req.spec });
        const existing = String(entry?.spec || '');
        if (existing && norm(existing).includes(norm(req.spec))) bad(tk('Specialization already learned'));
      }
      return;
    }
    case 'skillGroup': {
      const gid = req.target;
      if (!SKILL_GROUPS[gid]) bad(tk('Unknown skill group'));
      const members = groupMembers(gid).map((id) => SKILL_BY_ID[id]);
      if (members.some((m) => m.cat === 'magic') && prof.MAG <= 0) bad(tk('Magical group: you must be Awakened'));
      if (members.some((m) => m.cat === 'resonance') && prof.RES <= 0) bad(tk('Resonance group: you must be a technomancer'));
      const g = groupState(actor, gid);
      const name = { t: SKILL_GROUPS[gid] };
      if (!g.intact) bad(tk('{name} group broken: {reason}'), { name, reason: nested(g.reasonI18n) });
      if (g.rating === 0) setLabel(out, tk('New group: {name} {to}'), { name, to: req.to ?? 1 });
      else setLabel(out, tk('{name} group {from} → {to}'), { name, from: g.rating, to: req.to ?? g.rating + 1 });
      targetTo(req, out, g.rating);
      if (out.to > GROUP_MAX) bad(tk('{name} group: maximum {max}'), { name, max: GROUP_MAX });
      return;
    }
    case 'specialization': {
      const sk = findSkill(actor, req.target);
      const kn = sk ? null : findKnowledge(actor, req.target);
      const entry = sk || kn;
      if (!entry) bad(tk('Skill not found'));
      const rating = sk ? skillRating(actor, sk.id) : int(kn!.rating);
      if (rating < 1) bad(tk('The skill needs at least 1 rating'));
      if (!req.spec || req.spec.length < 2) bad(tk('Enter the specialization'));
      const existing = String(entry.spec || '');
      if (existing && norm(existing).includes(norm(req.spec))) bad(tk('Specialization already learned'));
      req.target = entry.id;
      out.target = entry.id;
      out.from = 0;
      out.to = 1;
      const def = sk ? SKILL_BY_ID[entry.id] : null;
      setLabel(out, tk('Specialization: {name} ({spec})'), { name: skillParam(entry.name || def?.fr || entry.id, def), spec: req.spec });
      const g = sk ? SKILL_BY_ID[sk.id]?.group : null;
      if (g && intactGroupEntry(actor, g)) warn(out, tk('Breaks the {group} group'), { group: { t: SKILL_GROUPS[g] } });
      return;
    }
    case 'knowledge': {
      const entry = findKnowledge(actor, req.target) || (req.name ? findKnowledge(actor, req.name) : null);
      const name = entry?.name || req.name || req.target;
      if (!entry && (!name || name.length < 2)) bad(tk('Enter the name of the knowledge skill'));
      if (entry?.native) bad(tk('Native language: no need to train it'));
      if (entry) req.target = entry.id;
      else {
        req.name = name;
        req.ktype = req.ktype || 'street';
      }
      out.target = req.target;
      const cur = Math.max(0, int(entry?.rating));
      if (cur === 0) {
        if ((entry?.type || req.ktype) === 'language') setLabel(out, tk('New language: {name} {to}'), { name, to: req.to ?? 1 });
        else setLabel(out, tk('New knowledge skill: {name} {to}'), { name, to: req.to ?? 1 });
      } else setLabel(out, tk('{name} {from} → {to}'), { name, from: cur, to: req.to ?? cur + 1 });
      targetTo(req, out, cur);
      if (out.to > KNOWLEDGE_MAX) bad(tk('{name}: maximum {max}'), { name, max: KNOWLEDGE_MAX });
      if (req.spec) {
        costOpts.spec = true;
        addToLabel(out, tk('{label} (spec. {spec})'), { spec: req.spec });
      }
      return;
    }
    case 'quality': {
      const name = req.name || req.target;
      if (!name) bad(tk('Enter the quality'));
      if (!req.positive) bad(tk('Negative quality: it can only be bought off'));
      if (req.karma <= 0) bad(tk('Enter the quality\'s karma cost'));
      if ((actor.qualities || []).some((q) => (req.catalogId && q.catalogId === req.catalogId) || sameName(q.name, name, req.altName))) bad(tk('Quality already owned'));
      req.name = name;
      costOpts.karma = req.karma;
      out.from = 0;
      out.to = 1;
      setLabel(out, tk('Quality: {name} ({karma})'), { name, karma: req.karma });
      return;
    }
    case 'removeQuality': {
      const q = (actor.qualities || []).find((x) => x.id === req.target) || (actor.qualities || []).find((x) => norm(x.name) === norm(req.target || req.name));
      if (!q) bad(tk('Quality not found on this character'));
      const negative = q.positive === false || num(q.karma) < 0;
      if (!negative) bad(tk('Only negative qualities can be bought off'));
      req.target = q.id;
      out.target = q.id;
      const k = Math.abs(num(q.karma)) || req.karma;
      if (!k) bad(tk('Enter the quality\'s karma value'));
      req.karma = k;
      costOpts.karma = k;
      out.from = 1;
      out.to = 0;
      setLabel(out, tk('Buy off: {name} ({karma})'), { name: q.name, karma: k });
      return;
    }
    case 'focus': {
      // Bond a focus the character carries (SR5 p. 318): Force × multiplier karma, at most MAG bonded foci, total Force ≤ MAG × 5.
      if (prof.MAG <= 0) bad(tk('Only the Awakened can bond foci'));
      const g = (actor.gear || []).find((x) => x && x.id === req.target);
      if (!g || !focusKind(g)) bad(tk('Choose a focus of the inventory'));
      if (g.bonded !== false) bad(tk('This focus is already bonded'));
      const force = focusForce(g);
      if (force <= 0) bad(tk('Give the focus its Force (rating) first'));
      const lim = fociLimits(actor);
      if (lim.bonded + 1 > lim.maxBonded) bad(tk('No more bonded foci than your Magic ({n})'), { n: lim.maxBonded });
      if (lim.force + force > lim.maxForce) bad(tk('The total Force of your bonded foci cannot exceed Magic × 5 ({n})'), { n: lim.maxForce });
      const k = force * focusBondMultiplier(focusKind(g));
      req.karma = k;
      req.name = g.nameFr || g.name;
      costOpts.karma = k;
      out.from = 0;
      out.to = force;
      setLabel(out, tk('Bond focus: {name} (Force {force})'), { name: g.name, force });
      return;
    }
    case 'spell': {
      if (!prof.canCast) bad(tk('Only magicians and mystic adepts learn spells'));
      const name = req.name || req.target;
      if (!name) bad(tk('Enter the spell'));
      if ((actor.spells || []).some((s) => (req.catalogId && s.catalogId === req.catalogId) || sameName(s.name, name, req.altName))) bad(tk('Spell already known'));
      req.name = name;
      out.from = 0;
      out.to = 1;
      setLabel(out, tk('Spell: {name}'), { name });
      return;
    }
    case 'complexForm': {
      if (prof.RES <= 0) bad(tk('Only technomancers learn complex forms'));
      const name = req.name || req.target;
      if (!name) bad(tk('Enter the complex form'));
      if ((actor.complexForms || []).some((s) => norm(s.name) === norm(name))) bad(tk('Complex form already known'));
      req.name = name;
      out.from = 0;
      out.to = 1;
      setLabel(out, tk('Complex form: {name}'), { name });
      return;
    }
    case 'power': {
      if (!prof.hasPowers) bad(tk('Adepts and mystic adepts only'));
      const name = req.name || req.target;
      if (!name) bad(tk('Enter the power'));
      req.name = name;
      if (req.pp <= 0) bad(tk('Enter the Power Point cost'));
      const existing = (req.target && (actor.powers || []).find((p) => p.id === req.target)) || (actor.powers || []).find((p) => (req.catalogId && p.catalogId === req.catalogId) || sameName(p.name, name, req.altName));
      if (existing && !req.levels) bad(tk('Power already learned'));
      const cur = existing ? Math.max(1, int(existing.level, 1)) : 0;
      if (existing) {
        req.target = existing.id;
        req.name = existing.name;
      }
      if (req.levels) {
        if (cur) setLabel(out, tk('Power: {name} {from} → {to}'), { name, from: cur, to: req.to ?? cur + 1 });
        else setLabel(out, tk('Power: {name} {to}'), { name, to: req.to ?? cur + 1 });
        targetTo(req, out, cur);
        if (req.maxLevel && out.to > req.maxLevel) bad(tk('{name}: maximum level {max}'), { name, max: req.maxLevel });
        if (out.to > prof.MAG) bad(tk('{name}: the level cannot exceed Magic ({mag})'), { name, mag: prof.MAG });
      } else {
        out.from = 0;
        out.to = 1;
        setLabel(out, tk('Power: {name}'), { name });
      }
      out.ppCost = round2(req.pp * (out.to - out.from) + (cur === 0 ? req.extraPP : 0));
      const pp = powerPoints(actor);
      if (out.ppCost > pp.free + 1e-9) {
        const p = { cost: out.ppCost, free: Math.max(0, pp.free) };
        if (pp.free > 1) bad(tk('pl::Not enough Power Points: {cost} needed, {free} free'), p);
        else bad(tk('Not enough Power Points: {cost} needed, {free} free'), p);
      }
      addToLabel(out, tk('{label} ({pp} PP)'), { pp: out.ppCost });
      return;
    }
    case 'powerPoint': {
      if (prof.type !== 'mystic') bad(tk('Only mystic adepts buy Power Points (adepts gain them with Magic or initiation)'));
      const cur = Math.max(0, int(actor.magic?.extraPP));
      setLabel(out, tk('Power Points bought {from} → {to}'), { from: cur, to: req.to ?? cur + 1 });
      targetTo(req, out, cur);
      if (out.to > prof.MAG) bad(tk('Power Points: maximum = Magic ({mag})'), { mag: prof.MAG });
      return;
    }
    case 'initiation': {
      const sub = prof.MAG <= 0 && prof.RES > 0;
      if (prof.MAG <= 0 && prof.RES <= 0) bad(tk('You must be Awakened or Emerged to initiate'));
      const cur = sub ? submersionGrade(actor) : initiationGrade(actor);
      req.target = sub ? 'submersion' : 'initiation';
      out.target = req.target;
      out.from = cur;
      out.to = cur + 1;
      if (sub) setLabel(out, tk('Submersion: grade {grade}'), { grade: out.to });
      else setLabel(out, tk('Initiation: grade {grade}'), { grade: out.to });
      if (req.to !== null && req.to !== out.to) {
        if (sub) bad(tk('Submersion: one grade at a time'));
        else bad(tk('Initiation: one grade at a time'));
      }
      const att = sub ? prof.RES : prof.MAG;
      if (out.to > att) {
        if (sub) bad(tk('Submersion: the grade cannot exceed Resonance ({max})'), { max: att });
        else bad(tk('Initiation: the grade cannot exceed Magic ({max})'), { max: att });
      }
      const opts = (['group', 'ordeal', 'schooling'] as const).filter((k) => req.options[k]);
      if (opts.length) addToLabel(out, tk('{label} (−{pct}%)'), { pct: opts.length * 10 });
      if (req.options.metamagic) addToLabel(out, tk('{label} · {metamagic}'), { metamagic: req.options.metamagic });
      if (req.options.powerPoint) {
        if (!prof.hasPowers) bad(tk('Only adepts can gain a Power Point through initiation'));
        addToLabel(out, tk('{label} · +1 PP'));
      }
      return;
    }
    case 'martialArt': {
      const name = req.name || req.target;
      if (!req.catalogId && !name) bad(tk('Choose a martial art style'));
      const known = findMartialArt(actor, req.catalogId, name, req.altName);
      const knownTech = known?.techniques || [];
      const fresh = req.techniques.filter((t) => !knownTech.some((k) => (k.catalogId && k.catalogId === t.id) || sameName(k.name, t.name, t.nameFr)));
      if (known && !fresh.length) bad(tk('Nothing new to learn'));
      req.techniques = fresh;
      req.name = known?.name || name;
      req.target = req.catalogId || slug(req.name);
      out.target = req.target;
      costOpts.style = !known;
      costOpts.karma = req.karma || MARTIAL_RULES.styleKarma;
      out.from = knownTech.length;
      out.to = out.from + fresh.length;
      const techniques = fresh.map((t) => t.nameFr || t.name).join(', ');
      if (!known && !techniques) setLabel(out, tk('Martial art: {style}'), { style: req.name });
      else if (!known) setLabel(out, tk('Martial art: {style} ({techniques})'), { style: req.name, techniques });
      else setLabel(out, tk('Martial art techniques: {style} ({techniques})'), { style: req.name, techniques });
      return;
    }
    case 'other': {
      const name = req.name || req.target;
      if (!name) bad(tk('Describe the advancement'));
      req.name = name;
      costOpts.karma = req.karma;
      costOpts.days = req.days;
      out.from = 0;
      out.to = 1;
      setLabel(out, '{name}', { name });
      out.manual = true;
      return;
    }
    default:
      bad(tk('Unknown advancement type'));
  }
}

// ---------------------------------------------------------------------------
// Applying an advance (mutates the actor). Robust: never throws, returns a French summary.
// ---------------------------------------------------------------------------

function ensureSkill(actor: ActorLike, id: string, extra: { name?: string; attr?: AttrKey | '' } = {}): Skill {
  actor.skills = Array.isArray(actor.skills) ? actor.skills : [];
  let e: Skill | null = findSkill(actor, id);
  if (!e) {
    const def = SKILL_BY_ID[id];
    e = { id, name: def?.fr || extra.name || id, attr: def?.attr || extra.attr || 'AGI', rating: 0 };
    if (def?.group) e.group = def.group;
    actor.skills.push(e);
  }
  return e;
}

/** Break an intact skill group: materialize every member at the group rating, then drop the group. */
function breakGroup(actor: ActorLike, groupId: string): boolean {
  const grp = intactGroupEntry(actor, groupId);
  if (!grp) return false;
  for (const id of groupMembers(groupId)) {
    const e = ensureSkill(actor, id);
    e.rating = Math.max(int(e.rating), int(grp.rating));
  }
  actor.skillGroups = (actor.skillGroups || []).filter((g) => g.id !== groupId);
  return true;
}

function addSpec(entry: { spec?: string }, spec: string): void {
  if (!spec) return;
  const cur = String(entry.spec || '').trim();
  if (cur && norm(cur).includes(norm(spec))) return;
  entry.spec = cur ? `${cur}, ${spec}` : spec;
}

export function applyAdvance(actor: ActorLike | null | undefined, raw: unknown): string {
  const req = normalizeRequest(raw);
  if (!actor || !req.kind) return '';
  const to = req.to ?? 1;
  const magic = (): ActorMagic => (actor.magic = actor.magic && typeof actor.magic === 'object' ? actor.magic : {});
  switch (req.kind) {
    case 'attribute': {
      const key = req.target.toUpperCase();
      actor.attributes = actor.attributes || ({} as Attributes);
      const attrs = actor.attributes as unknown as Record<string, number>;
      const before = int(attrs[key]);
      attrs[key] = Math.max(before, to);
      // A higher Edge rating also refills the gained points.
      if (key === 'EDG' && actor.edge && typeof actor.edge === 'object') actor.edge.current = Math.min(int(actor.edge.current) + (attrs[key] - before), attrs[key]);
      return `${ATTR_LABELS[key as AttrKey] || key} ${attrs[key]}`;
    }
    case 'skill': {
      const def = SKILL_BY_ID[req.target];
      if (def?.group) breakGroup(actor, def.group);
      const e = ensureSkill(actor, req.target, { name: req.name, attr: req.attr });
      e.rating = Math.max(int(e.rating), to);
      if (req.spec) addSpec(e, req.spec);
      return `${e.name} ${e.rating}${req.spec ? ` (${req.spec})` : ''}`;
    }
    case 'skillGroup': {
      const gid = req.target;
      actor.skillGroups = Array.isArray(actor.skillGroups) ? actor.skillGroups : [];
      let g = actor.skillGroups.find((x) => x.id === gid);
      if (!g) actor.skillGroups.push((g = { id: gid, rating: 0 }));
      g.rating = Math.max(int(g.rating), to);
      for (const id of groupMembers(gid)) {
        const e = ensureSkill(actor, id);
        e.rating = Math.max(int(e.rating), g.rating);
        e.group = gid;
      }
      return `Group ${SKILL_GROUPS[gid] || gid} ${g.rating}`;
    }
    case 'specialization': {
      const sk = findSkill(actor, req.target);
      if (sk) {
        const g = SKILL_BY_ID[sk.id]?.group;
        if (g) breakGroup(actor, g);
        addSpec(sk, req.spec);
        return `${sk.name} (${req.spec})`;
      }
      const kn = findKnowledge(actor, req.target);
      if (kn) {
        addSpec(kn, req.spec);
        return `${kn.name} (${req.spec})`;
      }
      return '';
    }
    case 'knowledge': {
      actor.knowledge = Array.isArray(actor.knowledge) ? actor.knowledge : [];
      let k = findKnowledge(actor, req.target) || (req.name ? findKnowledge(actor, req.name) : null);
      if (!k) {
        k = { id: uid('kn'), name: req.name || req.target, rating: 0, type: req.ktype || 'street' };
        actor.knowledge.push(k);
      }
      k.rating = Math.max(int(k.rating), to);
      if (req.spec) addSpec(k, req.spec);
      return `${k.name} ${k.rating}`;
    }
    case 'quality': {
      actor.qualities = Array.isArray(actor.qualities) ? actor.qualities : [];
      const name = req.name || req.target;
      if (!actor.qualities.some((q) => sameName(q.name, name, req.altName))) {
        const q: Quality = { id: uid('q'), name, karma: req.karma, positive: true };
        if (req.catalogId) q.catalogId = req.catalogId;
        if (req.note) q.notes = req.note;
        actor.qualities.push(q);
      }
      return name;
    }
    case 'removeQuality': {
      const q = (actor.qualities || []).find((x) => x.id === req.target);
      actor.qualities = (actor.qualities || []).filter((x) => x.id !== req.target);
      return q ? q.name : '';
    }
    case 'focus': {
      const g = (actor.gear || []).find((x) => x && x.id === req.target);
      if (!g) return '';
      g.bonded = true;
      return g.name;
    }
    case 'spell': {
      actor.spells = Array.isArray(actor.spells) ? actor.spells : [];
      const name = req.name || req.target;
      if (!actor.spells.some((s) => sameName(s.name, name, req.altName))) {
        const s: Spell = { id: uid('sp'), name, ...req.data };
        if (req.catalogId) s.catalogId = req.catalogId;
        actor.spells.push(s);
      }
      return name;
    }
    case 'complexForm': {
      actor.complexForms = Array.isArray(actor.complexForms) ? actor.complexForms : [];
      const name = req.name || req.target;
      if (!actor.complexForms.some((s) => norm(s.name) === norm(name))) {
        const s: ComplexForm = { id: uid('cf'), name };
        if (req.data.duration) s.duration = req.data.duration;
        if (req.data.drain) s.fading = req.data.drain;
        if (req.catalogId) s.catalogId = req.catalogId;
        actor.complexForms.push(s);
      }
      return name;
    }
    case 'power': {
      actor.powers = Array.isArray(actor.powers) ? actor.powers : [];
      const name = req.name || req.target;
      let p: AdeptPower | undefined = (req.target && actor.powers.find((x) => x.id === req.target)) || actor.powers.find((x) => (req.catalogId && x.catalogId === req.catalogId) || sameName(x.name, name, req.altName));
      const from = p ? Math.max(1, int(p.level, 1)) : 0;
      const levels = req.levels ? Math.max(0, to - from) : p ? 0 : 1;
      const cost = round2(req.pp * levels + (p ? 0 : req.extraPP));
      if (!p) {
        p = { id: uid('pw'), name, pp: 0 };
        if (req.catalogId) p.catalogId = req.catalogId;
        actor.powers.push(p);
      }
      if (req.levels) p.level = Math.max(from, to);
      p.pp = round2(num(p.pp) + cost);
      return `${name}${req.levels ? ` ${p.level}` : ''}`;
    }
    case 'powerPoint': {
      const m = magic();
      m.extraPP = Math.max(num(m.extraPP), to);
      return `${m.extraPP} power point(s) bought`;
    }
    case 'initiation': {
      const m = magic();
      const sub = req.target === 'submersion';
      if (sub) {
        m.submersion = Math.max(int(m.submersion), to);
        if (req.options.metamagic) (m.echoes = Array.isArray(m.echoes) ? m.echoes : []).push(req.options.metamagic);
        return `Submersion grade ${m.submersion}`;
      }
      m.initiation = Math.max(int(m.initiation), to);
      if (req.options.metamagic) (m.metamagics = Array.isArray(m.metamagics) ? m.metamagics : []).push(req.options.metamagic);
      if (req.options.powerPoint) m.extraPP = num(m.extraPP) + 1;
      return `Initiation grade ${m.initiation}`;
    }
    case 'martialArt': {
      actor.martialArts = Array.isArray(actor.martialArts) ? actor.martialArts : [];
      let m = findMartialArt(actor, req.catalogId, req.name, req.altName);
      if (!m) {
        m = { id: uid('ma'), name: req.name || req.target, rating: 1, techniques: [] };
        if (req.catalogId) m.catalogId = req.catalogId;
        actor.martialArts.push(m);
      }
      if (!Array.isArray(m.techniques)) m.techniques = [];
      for (const t of req.techniques) {
        if (m.techniques.some((k) => k.catalogId === t.id)) continue;
        m.techniques.push({ id: uid('tec'), catalogId: t.id, name: t.name, ...(t.nameFr ? { nameFr: t.nameFr } : {}) });
      }
      return `${m.name} (${m.techniques.map((k) => k.nameFr || k.name).join(', ')})`;
    }
    default:
      return req.name || req.target || '';
  }
}
