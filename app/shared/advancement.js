// SR5 character advancement: karma costs, training time, limits, and applying an advance to an actor.
// Pure ES module shared by the server (50-training.js) and the browser (training UI). No Node or DOM APIs.
//
// Sources: SR5 core p.103-107 (« Progression du personnage ») and Run Faster. House rules are flagged below.
//
// Request (normalized by normalizeRequest):
//   { kind, target, to, name?, spec?, attr?, ktype?, karma?, pp?, levels?, maxLevel?, extraPP?, days?,
//     instructor?, note?, catalogId?, positive?, data?: {spell fields}, options?: { group, ordeal, schooling,
//     metamagic, powerPoint }, free? (GM only: no karma/nuyen) }
//
// Actor fields written by applyAdvance (in addition to the ARCHITECTURE.md Actor schema):
//   actor.magic = { initiation: grade, submersion: grade, metamagics: [string], echoes: [string], extraPP: n }
//     - initiation: initiate grade (raises the MAG maximum by 1 per grade)
//     - submersion: technomancer grade (raises the RES maximum by 1 per grade)
//     - extraPP: power points not coming from MAG (bought by mystic adepts, or gained via initiation by adepts)
//   actor.powers[].pp is the TOTAL power-point cost of that power (all levels included).
//   Skills of a skill group are always materialized in actor.skills (so skillPool() works);
//   actor.skillGroups keeps the intact groups only (a group is removed when it gets broken).
import { METATYPES, SKILLS, SKILL_BY_ID, SKILL_GROUPS, ATTR_LABELS } from './sr5.js';
import { slug, uid } from './util.js';

export const KINDS = ['attribute', 'skill', 'skillGroup', 'specialization', 'knowledge', 'quality', 'removeQuality', 'spell', 'complexForm', 'power', 'powerPoint', 'initiation', 'other'];

export const KIND_LABELS = {
  attribute: 'Attribut',
  skill: 'Compétence',
  skillGroup: 'Groupe de compétences',
  specialization: 'Spécialisation',
  knowledge: 'Connaissance',
  quality: 'Qualité',
  removeQuality: 'Rachat de qualité',
  spell: 'Sort',
  complexForm: 'Forme complexe',
  power: 'Pouvoir d’adepte',
  powerPoint: 'Point de pouvoir',
  initiation: 'Initiation',
  other: 'Autre',
};

/** Human-readable rules, used as tooltips in the UI. */
export const RULE_TEXT = {
  attribute: 'Attribut : nouveau rang × 5 karma (somme de chaque rang) · Durée : nouveau rang × 1 semaine',
  skill: 'Compétence active : nouveau rang × 2 karma (nouvelle compétence : 2) · Durée : rangs 1–4 = rang en jours, 5–8 = rang en semaines, 9+ = rang × 2 semaines',
  skillGroup: 'Groupe de compétences : nouveau rang × 5 karma (nouveau groupe : 5) · Durée : nouveau rang × 2 semaines · Impossible si le groupe est rompu',
  specialization: 'Spécialisation : 7 karma · Durée : 1 mois',
  knowledge: 'Connaissance / langue : nouveau rang × 1 karma (nouvelle : 1) · Durée : rangs 1–4 = rang en jours, 5+ = rang en semaines',
  quality: 'Qualité positive : coût de la qualité × 2 karma · Durée (règle maison) : 1 semaine par tranche de 5 karma de la qualité',
  removeQuality: 'Racheter une qualité négative : bonus de la qualité × 2 karma · Durée (règle maison) : 1 semaine par tranche de 5 karma',
  spell: 'Sort, rituel ou préparation alchimique : 5 karma · Durée : 1 jour',
  complexForm: 'Forme complexe : 4 karma · Durée : 1 jour',
  power: 'Pouvoir d’adepte : se paie en points de pouvoir libres (pas de karma), immédiat',
  powerPoint: 'Point de pouvoir (adepte mystique) : 5 karma, maximum = Magie',
  initiation: 'Initiation / submersion : 10 + (nouveau grade × 3) karma, −10 % par option (groupe, ordalie, école) · Durée : 1 mois',
  other: 'Progression libre : coût et durée fixés à la main (toujours validée par le MJ)',
  instructor: 'Instructeur : un test d’Enseignement réduit le temps d’entraînement (réduction fixée par le MJ) — coût en nuyens par semaine',
};

export const DEFAULT_SETTINGS = {
  approval: 'always', // 'always' = every request waits for the GM, 'never' = auto-approved (manual entries still wait)
  useTime: true, // false = advances apply immediately on approval
  instructorTimeReduction: 25, // percent
  instructorCostPerWeek: { attribute: 1000, skill: 500, knowledge: 250, other: 500 },
};

export const KNOWLEDGE_TYPES = {
  street: 'Rue',
  academic: 'Académique',
  professional: 'Professionnelle',
  interest: 'Centre d’intérêt',
  language: 'Langue',
};

export const SKILL_MAX = 12; // in play (13 with Aptitude)
export const KNOWLEDGE_MAX = 12;
export const GROUP_MAX = 12;
export const TRAINABLE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES'];

const ATTR_WORDS = {
  BOD: ['constitution', 'body'], AGI: ['agilite', 'agility'], REA: ['reaction'], STR: ['force', 'strength'],
  WIL: ['volonte', 'willpower'], LOG: ['logique', 'logic'], INT: ['intuition'], CHA: ['charisme', 'charisma'],
  EDG: ['chance', 'edge'], MAG: ['magie', 'magic'], RES: ['resonance'],
};

class RuleError extends Error {}
const bad = (msg) => {
  throw new RuleError(msg);
};

const int = (v, d = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : d;
};
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const norm = (s) => slug(String(s || '')).replace(/-/g, ' ');
const round2 = (n) => Math.round(n * 100) / 100;
/** Same item name, ignoring case/accents and a trailing « (extra) », in either language. */
const sameName = (have, name, alt) => {
  const h = norm(String(have || '').replace(/\s*\(.*\)\s*$/, ''));
  return !!h && (h === norm(name) || (!!alt && h === norm(alt)) || norm(have) === norm(name));
};
const truthy = (v) => v === true || v === 'True' || v === 'true' || v === 1 || v === '1';
const sumSteps = (from, to, f) => {
  let s = 0;
  for (let r = Math.max(0, from) + 1; r <= to; r++) s += f(r);
  return s;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 1 -> "1 jour", 14 -> "2 semaines", 30 -> "1 mois", 10 -> "1 semaine et 3 jours", 0 -> "immédiat". */
export function formatDays(days) {
  const d = Math.max(0, Math.round(Number(days) || 0));
  if (d === 0) return 'immédiat';
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  if (d % 30 === 0) return plural(d / 30, 'mois', 'mois');
  if (d < 7) return plural(d, 'jour', 'jours');
  const w = Math.floor(d / 7);
  const r = d % 7;
  return r ? `${plural(w, 'semaine', 'semaines')} et ${plural(r, 'jour', 'jours')}` : plural(w, 'semaine', 'semaines');
}

// ---------------------------------------------------------------------------
// Costs & times
// ---------------------------------------------------------------------------

/** Initiation discount factor from options { group, ordeal, schooling } (−10 % each). */
export function initiationFactor(options = {}) {
  const n = ['group', 'ordeal', 'schooling'].filter((k) => options && options[k]).length;
  return 1 - 0.1 * n;
}

/**
 * Karma cost of going from `from` to `to`.
 * opts: { spec (adds a specialization), karma (quality value / free cost), options (initiation) }
 */
export function costFor(kind, from = 0, to = 0, opts = {}) {
  from = int(from);
  to = int(to);
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
    case 'other':
      return Math.max(0, Math.round(num(opts.karma)));
    default:
      return 0;
  }
}

/** Training time in days (without instructor). opts: { spec, karma, days } */
export function timeFor(kind, from = 0, to = 0, opts = {}) {
  from = int(from);
  to = int(to);
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
    case 'other':
      return Math.max(0, int(opts.days));
    default:
      return 0;
  }
}

/** Which instructor price applies to a kind. */
export function instructorCategory(kind) {
  if (kind === 'attribute') return 'attribute';
  if (kind === 'skill' || kind === 'skillGroup' || kind === 'specialization') return 'skill';
  if (kind === 'knowledge') return 'knowledge';
  return 'other';
}

/** Training with an instructor: { days, weeks, nuyen }. */
export function withInstructor(days, kind, settings = DEFAULT_SETTINGS) {
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

export function hasQuality(actor, re) {
  return (actor?.qualities || []).some((q) => re.test(String(q?.name || '')));
}

function qualityMentions(q, words) {
  const text = norm(`${q?.name || ''} ${q?.notes || ''}`);
  return words.some((w) => new RegExp(`(^| )${norm(w)}( |$)`).test(text));
}

/** Exceptional Attribute applies to `key` (or is unspecified, then it may apply to any attribute). */
function hasExceptional(actor, key) {
  const qs = (actor?.qualities || []).filter((q) => /exceptional attribute|attribut exceptionnel/i.test(q?.name || ''));
  if (!qs.length) return false;
  for (const q of qs) {
    if (qualityMentions(q, [key, ...(ATTR_WORDS[key] || [])])) return true;
    const any = Object.entries(ATTR_WORDS).some(([k, w]) => qualityMentions(q, [k, ...w]));
    if (!any) return true;
  }
  return false;
}

function hasAptitude(actor, skillId, skillName) {
  const qs = (actor?.qualities || []).filter((q) => /aptitude/i.test(q?.name || ''));
  if (!qs.length) return false;
  const def = SKILL_BY_ID[skillId];
  const words = [skillId.replace(/_/g, ' '), skillName, def?.fr].filter(Boolean);
  for (const q of qs) {
    const text = norm(`${q.name} ${q.notes || ''}`).replace(/^aptitude ?/, '').trim();
    if (!text) return true; // unspecified: let the GM judge
    if (words.some((w) => text.includes(norm(w)))) return true;
  }
  return false;
}

export function initiationGrade(actor) {
  return Math.max(0, int(actor?.magic?.initiation ?? actor?.magic?.initiateGrade ?? actor?.initiation ?? 0));
}
export function submersionGrade(actor) {
  return Math.max(0, int(actor?.magic?.submersion ?? actor?.resonance?.submersion ?? 0));
}

/** Maximum natural rating of an attribute for this actor (metatype, Exceptional Attribute, Lucky, essence, grade). */
export function attrMax(actor, key) {
  if (key === 'MAG' || key === 'RES') {
    const grade = key === 'MAG' ? initiationGrade(actor) : submersionGrade(actor);
    const ess = num(actor?.attributes?.ESS, 6);
    const loss = Math.max(0, Math.ceil(6 - ess - 1e-9));
    return Math.max(0, 6 + grade - loss);
  }
  if (key === 'ESS') return 6;
  const meta = METATYPES[actor?.metatype] || METATYPES.Humain;
  let max = meta.max[key] ?? 6;
  if (hasExceptional(actor, key)) max += 1;
  if (key === 'EDG' && hasQuality(actor, /^(lucky|chanceux)/i)) max += 1;
  return max;
}

/** Awakened / emerged profile: { type: 'adept'|'mystic'|'magician'|'technomancer'|null, MAG, RES, canCast, hasPowers }. */
export function magicProfile(actor) {
  const MAG = Math.max(0, int(actor?.attributes?.MAG));
  const RES = Math.max(0, int(actor?.attributes?.RES));
  let type = null;
  if (hasQuality(actor, /mystic|mystique/i)) type = 'mystic';
  else if (hasQuality(actor, /^adepte?(\s|$|\(|:)/i)) type = 'adept';
  else if (hasQuality(actor, /^(magician|magicien|aspected|apprentice|apprenti|explorer|explorateur|enchanter|enchanteur|aware)/i)) type = 'magician';
  else if (hasQuality(actor, /technoman/i)) type = 'technomancer';
  else if (MAG > 0) type = (actor?.powers || []).length && !(actor?.spells || []).length ? 'adept' : 'magician';
  else if (RES > 0) type = 'technomancer';
  return { type, MAG, RES, canCast: type === 'magician' || type === 'mystic', hasPowers: type === 'adept' || type === 'mystic' };
}

/** Power points: { total, spent, free }. Adepts: MAG + extraPP; mystic adepts: bought (extraPP). */
export function powerPoints(actor) {
  const p = magicProfile(actor);
  const extra = Math.max(0, num(actor?.magic?.extraPP));
  const total = (p.type === 'adept' ? p.MAG : 0) + extra;
  const spent = round2((actor?.powers || []).reduce((s, x) => s + Math.max(0, num(x?.pp)), 0));
  return { total, spent, free: round2(total - spent), extra };
}

export function findSkill(actor, id) {
  if (!id) return null;
  const n = norm(id);
  return (actor?.skills || []).find((s) => s.id === id) || (actor?.skills || []).find((s) => norm(s.name) === n || norm(s.id) === n) || null;
}

export function findKnowledge(actor, idOrName) {
  if (!idOrName) return null;
  const n = norm(idOrName);
  return (actor?.knowledge || []).find((k) => k.id === idOrName) || (actor?.knowledge || []).find((k) => norm(k.name) === n) || null;
}

function intactGroupEntry(actor, groupId) {
  return (actor?.skillGroups || []).find((g) => g.id === groupId && int(g.rating) > 0) || null;
}

/** Current rating of an active skill, counting an intact skill group. */
export function skillRating(actor, id) {
  const e = findSkill(actor, id);
  const r = int(e?.rating);
  const def = SKILL_BY_ID[e?.id || id];
  const g = def?.group ? intactGroupEntry(actor, def.group) : null;
  return Math.max(r, g ? int(g.rating) : 0);
}

export function groupMembers(groupId) {
  return SKILLS.filter((s) => s.group === groupId).map((s) => s.id);
}

/** State of a skill group: { intact, rating, owned, reason }. */
export function groupState(actor, groupId) {
  const members = groupMembers(groupId);
  const grp = intactGroupEntry(actor, groupId);
  const gr = grp ? int(grp.rating) : 0;
  const ratings = members.map((id) => Math.max(int(findSkill(actor, id)?.rating), gr));
  const withSpec = members.filter((id) => String(findSkill(actor, id)?.spec || '').trim());
  const same = ratings.every((r) => r === ratings[0]);
  let reason = '';
  if (!same) reason = 'les compétences du groupe n’ont pas toutes le même indice';
  else if (withSpec.length) reason = `spécialisation sur ${withSpec.map((id) => SKILL_BY_ID[id]?.fr || id).join(', ')}`;
  return { intact: same && !withSpec.length, rating: same ? ratings[0] || 0 : 0, owned: !!grp, reason, members, ratings };
}

// ---------------------------------------------------------------------------
// Catalog helpers (catalog items come from data/catalog/*.json; fields vary, so be tolerant)
// ---------------------------------------------------------------------------

export function catalogName(item) {
  return String(item?.nameFr || item?.name || '');
}
export function qualityInfo(item) {
  const raw = item?.karma ?? item?.stats?.karma ?? item?.cost ?? 0;
  const karma = num(raw);
  const cat = String(item?.category || item?.stats?.category || '');
  const positive = item?.positive ?? item?.stats?.positive ?? (/neg/i.test(cat) ? false : karma >= 0);
  return { karma: Math.abs(karma), positive: !!positive };
}
export function powerInfo(item) {
  const s = item?.stats || {};
  const pp = num(item?.pp ?? item?.points ?? s.points ?? s.pp ?? s.powerPoints ?? item?.cost ?? 0);
  const levels = truthy(item?.levels ?? s.levels);
  const maxLevel = int(item?.maxLevel ?? s.maxLevel ?? s.maxLevels ?? s.maxlevels ?? 0) || null;
  const extraPP = num(item?.extraPP ?? s.extrapointcost ?? s.extraPointCost ?? 0);
  return { pp, levels, maxLevel, extraPP };
}
export const SPELL_CATEGORIES = { Combat: 'Combat', Detection: 'Détection', Health: 'Santé', Illusion: 'Illusion', Manipulation: 'Manipulation', Rituals: 'Rituels', Enchantments: 'Enchantements' };
export function spellInfo(item) {
  const s = item?.stats || {};
  const str = (v) => String(v ?? '').slice(0, 40);
  return {
    category: str(item?.categoryFr || SPELL_CATEGORIES[item?.category] || item?.category || s.category),
    type: str(s.type ?? item?.type),
    range: str(s.range ?? item?.range),
    duration: str(s.duration ?? item?.duration),
    drain: str(s.dv ?? s.drain ?? item?.dv ?? item?.drain),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function normalizeRequest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const o = r.options && typeof r.options === 'object' ? r.options : {};
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  const toRaw = r.to;
  const to = toRaw === undefined || toRaw === null || toRaw === '' || !Number.isFinite(Number(toRaw)) ? null : Math.trunc(Number(toRaw));
  return {
    kind: KINDS.includes(r.kind) ? r.kind : null,
    target: str(r.target, 80),
    to,
    name: str(r.name, 80),
    altName: str(r.altName, 80), // other-language name (catalog), used for duplicate checks
    spec: str(r.spec, 60),
    attr: TRAINABLE_ATTRS.includes(r.attr) ? r.attr : '',
    ktype: KNOWLEDGE_TYPES[r.ktype] ? r.ktype : '',
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
    free: !!r.free,
  };
}

/** Keys used to detect conflicting trainings (same thing twice, or two attributes at once). */
export function conflictKeys(actor, raw) {
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
    default:
      return [];
  }
}

/** Short French label for a request. */
export function describe(actor, raw) {
  const q = quote(actor, raw, { ...DEFAULT_SETTINGS, useTime: false }, { skipChecks: true });
  return q.label;
}

/**
 * Full computation for a request: from/to, label, karma, days, nuyen, warnings, error.
 * settings: training settings. ctx: {
 *   active: [request] (other pending requests + in-progress jobs of this actor, normalized or raw),
 *   reservedKarma, reservedNuyen (engaged by pending requests), skipChecks (no karma/conflict checks) }
 */
export function quote(actor, raw, settings = DEFAULT_SETTINGS, ctx = {}) {
  const req = normalizeRequest(raw);
  const st = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const out = {
    kind: req.kind, target: req.target, from: 0, to: req.to ?? 0, label: KIND_LABELS[req.kind] || 'Progression',
    karmaCost: 0, daysBase: 0, days: 0, nuyenCost: 0, instructor: false, ppCost: 0, warnings: [], error: null,
    manual: false, req,
  };
  try {
    if (!actor) bad('Personnage introuvable');
    if (!req.kind) bad('Type de progression inconnu');
    const costOpts = { spec: false, karma: 0, options: req.options, days: req.days };
    resolveKind(actor, req, out, costOpts);
    req.to = out.to; // the stored request carries the resolved target rating (used by applyAdvance)
    out.karmaCost = req.free ? 0 : costFor(req.kind, out.from, out.to, costOpts);
    out.daysBase = timeFor(req.kind, out.from, out.to, costOpts);
    out.days = st.useTime ? out.daysBase : 0;
    if (st.useTime && req.instructor && out.daysBase > 0) {
      const ins = withInstructor(out.daysBase, req.kind, st);
      out.instructor = true;
      out.days = ins.days;
      out.nuyenCost = req.free ? 0 : ins.nuyen;
    }
    if (!ctx.skipChecks) {
      const mine = conflictKeys(actor, req);
      for (const other of ctx.active || []) {
        const keys = conflictKeys(actor, other.request || other);
        if (keys.some((k) => mine.includes(k))) {
          if (mine.includes('attribute') && keys.includes('attribute')) bad('Un seul attribut à la fois : un entraînement d’attribut est déjà en cours ou en attente');
          bad(`Déjà en cours ou en attente : ${other.label || describe(actor, other.request || other)}`);
        }
      }
      const karma = num(actor.karma) - num(ctx.reservedKarma);
      if (out.karmaCost > karma) bad(`Karma insuffisant : ${out.karmaCost} requis, ${Math.max(0, karma)} disponible${karma > 1 ? 's' : ''}`);
      const nuyen = num(actor.nuyen) - num(ctx.reservedNuyen);
      if (out.nuyenCost > nuyen) bad(`Nuyens insuffisants pour l’instructeur : ${out.nuyenCost}¥ requis, ${Math.max(0, nuyen)}¥ disponibles`);
    }
  } catch (e) {
    if (e instanceof RuleError) out.error = e.message;
    else throw e;
  }
  return out;
}

/** Error message (French) or null. Same options as quote(). */
export function validate(actor, request, settings = DEFAULT_SETTINGS, ctx = {}) {
  return quote(actor, request, settings, ctx).error;
}

function targetTo(req, out, cur) {
  out.from = cur;
  out.to = req.to ?? cur + 1;
  if (out.to <= cur) bad(`Le nouveau rang doit dépasser le rang actuel (${cur})`);
}

function resolveKind(actor, req, out, costOpts) {
  const prof = magicProfile(actor);
  switch (req.kind) {
    case 'attribute': {
      const key = req.target.toUpperCase();
      if (!TRAINABLE_ATTRS.includes(key)) bad('Attribut inconnu ou non entraînable');
      req.target = key;
      out.target = key;
      const cur = Math.max(0, int(actor.attributes?.[key]));
      if (key === 'MAG' && cur <= 0) bad('Ce personnage n’est pas Éveillé (pas de Magie)');
      if (key === 'RES' && cur <= 0) bad('Ce personnage n’est pas Émergé (pas de Résonance)');
      out.label = `${ATTR_LABELS[key]} ${cur} → ${req.to ?? cur + 1}`;
      targetTo(req, out, cur);
      const max = attrMax(actor, key);
      if (out.to > max) {
        const why = key === 'MAG' || key === 'RES' ? 'essence et grade inclus' : actor.metatype || 'Humain';
        bad(`${ATTR_LABELS[key]} : maximum ${max} (${why})`);
      }
      return;
    }
    case 'skill': {
      const entry = findSkill(actor, req.target);
      const id = entry?.id || (SKILL_BY_ID[req.target] ? req.target : slug(req.name || req.target));
      if (!id) bad('Compétence inconnue');
      const def = SKILL_BY_ID[id];
      const name = entry?.name || def?.fr || req.name || req.target;
      if (!def && !entry && !req.name) bad('Indique le nom de la nouvelle compétence');
      req.target = id;
      out.target = id;
      if (def?.cat === 'magic' && prof.MAG <= 0) bad('Compétence magique : il faut être Éveillé');
      if (def?.cat === 'resonance' && prof.RES <= 0) bad('Compétence de résonance : il faut être technomancien');
      const cur = skillRating(actor, id);
      out.label = cur === 0 ? `Nouvelle compétence : ${name} ${req.to ?? 1}` : `${name} ${cur} → ${req.to ?? cur + 1}`;
      targetTo(req, out, cur);
      const max = SKILL_MAX + (hasAptitude(actor, id, name) ? 1 : 0);
      if (out.to > max) bad(`${name} : maximum ${max} en jeu`);
      if (def?.group && intactGroupEntry(actor, def.group)) out.warnings.push(`Rompt le groupe ${SKILL_GROUPS[def.group]}`);
      if (req.spec) {
        costOpts.spec = true;
        out.label += ` (spé. ${req.spec})`;
        const existing = String(entry?.spec || '');
        if (existing && norm(existing).includes(norm(req.spec))) bad('Spécialisation déjà acquise');
      }
      return;
    }
    case 'skillGroup': {
      const gid = req.target;
      if (!SKILL_GROUPS[gid]) bad('Groupe de compétences inconnu');
      const members = groupMembers(gid).map((id) => SKILL_BY_ID[id]);
      if (members.some((m) => m.cat === 'magic') && prof.MAG <= 0) bad('Groupe magique : il faut être Éveillé');
      if (members.some((m) => m.cat === 'resonance') && prof.RES <= 0) bad('Groupe de résonance : il faut être technomancien');
      const g = groupState(actor, gid);
      const name = SKILL_GROUPS[gid];
      if (!g.intact) bad(`Groupe ${name} rompu : ${g.reason}`);
      out.label = g.rating === 0 ? `Nouveau groupe : ${name} ${req.to ?? 1}` : `Groupe ${name} ${g.rating} → ${req.to ?? g.rating + 1}`;
      targetTo(req, out, g.rating);
      if (out.to > GROUP_MAX) bad(`Groupe ${name} : maximum ${GROUP_MAX}`);
      return;
    }
    case 'specialization': {
      const sk = findSkill(actor, req.target);
      const kn = sk ? null : findKnowledge(actor, req.target);
      const entry = sk || kn;
      if (!entry) bad('Compétence introuvable');
      const rating = sk ? skillRating(actor, sk.id) : int(kn.rating);
      if (rating < 1) bad('Il faut au moins 1 rang dans la compétence');
      if (!req.spec || req.spec.length < 2) bad('Indique la spécialisation');
      const existing = String(entry.spec || '');
      if (existing && norm(existing).includes(norm(req.spec))) bad('Spécialisation déjà acquise');
      req.target = entry.id;
      out.target = entry.id;
      out.from = 0;
      out.to = 1;
      out.label = `Spécialisation : ${entry.name || SKILL_BY_ID[entry.id]?.fr || entry.id} (${req.spec})`;
      const g = sk ? SKILL_BY_ID[sk.id]?.group : null;
      if (g && intactGroupEntry(actor, g)) out.warnings.push(`Rompt le groupe ${SKILL_GROUPS[g]}`);
      return;
    }
    case 'knowledge': {
      const entry = findKnowledge(actor, req.target) || (req.name ? findKnowledge(actor, req.name) : null);
      const name = entry?.name || req.name || req.target;
      if (!entry && (!name || name.length < 2)) bad('Indique le nom de la connaissance');
      if (entry?.native) bad('Langue maternelle : pas besoin de l’entraîner');
      if (entry) req.target = entry.id;
      else {
        req.name = name;
        req.ktype = req.ktype || 'street';
      }
      out.target = req.target;
      const cur = Math.max(0, int(entry?.rating));
      out.label = cur === 0 ? `Nouvelle ${(entry?.type || req.ktype) === 'language' ? 'langue' : 'connaissance'} : ${name} ${req.to ?? 1}` : `${name} ${cur} → ${req.to ?? cur + 1}`;
      targetTo(req, out, cur);
      if (out.to > KNOWLEDGE_MAX) bad(`${name} : maximum ${KNOWLEDGE_MAX}`);
      if (req.spec) {
        costOpts.spec = true;
        out.label += ` (spé. ${req.spec})`;
      }
      return;
    }
    case 'quality': {
      const name = req.name || req.target;
      if (!name) bad('Indique la qualité');
      if (!req.positive) bad('Qualité négative : on ne peut que la racheter');
      if (req.karma <= 0) bad('Indique le coût en karma de la qualité');
      if ((actor.qualities || []).some((q) => (req.catalogId && q.catalogId === req.catalogId) || sameName(q.name, name, req.altName))) bad('Qualité déjà possédée');
      req.name = name;
      costOpts.karma = req.karma;
      out.from = 0;
      out.to = 1;
      out.label = `Qualité : ${name} (${req.karma})`;
      return;
    }
    case 'removeQuality': {
      const q = (actor.qualities || []).find((x) => x.id === req.target) || (actor.qualities || []).find((x) => norm(x.name) === norm(req.target || req.name));
      if (!q) bad('Qualité introuvable sur ce personnage');
      const negative = q.positive === false || num(q.karma) < 0;
      if (!negative) bad('Seules les qualités négatives peuvent être rachetées');
      req.target = q.id;
      out.target = q.id;
      const k = Math.abs(num(q.karma)) || req.karma;
      if (!k) bad('Indique la valeur en karma de la qualité');
      req.karma = k;
      costOpts.karma = k;
      out.from = 1;
      out.to = 0;
      out.label = `Racheter : ${q.name} (${k})`;
      return;
    }
    case 'spell': {
      if (!prof.canCast) bad('Seuls les magiciens et adeptes mystiques apprennent des sorts');
      const name = req.name || req.target;
      if (!name) bad('Indique le sort');
      if ((actor.spells || []).some((s) => (req.catalogId && s.catalogId === req.catalogId) || sameName(s.name, name, req.altName))) bad('Sort déjà connu');
      req.name = name;
      out.from = 0;
      out.to = 1;
      out.label = `Sort : ${name}`;
      return;
    }
    case 'complexForm': {
      if (prof.RES <= 0) bad('Seuls les technomanciens apprennent des formes complexes');
      const name = req.name || req.target;
      if (!name) bad('Indique la forme complexe');
      if ((actor.complexForms || []).some((s) => norm(s.name) === norm(name))) bad('Forme complexe déjà connue');
      req.name = name;
      out.from = 0;
      out.to = 1;
      out.label = `Forme complexe : ${name}`;
      return;
    }
    case 'power': {
      if (!prof.hasPowers) bad('Réservé aux adeptes et adeptes mystiques');
      const name = req.name || req.target;
      if (!name) bad('Indique le pouvoir');
      req.name = name;
      if (req.pp <= 0) bad('Indique le coût en points de pouvoir');
      const existing = (req.target && (actor.powers || []).find((p) => p.id === req.target)) || (actor.powers || []).find((p) => (req.catalogId && p.catalogId === req.catalogId) || sameName(p.name, name, req.altName));
      if (existing && !req.levels) bad('Pouvoir déjà acquis');
      const cur = existing ? Math.max(1, int(existing.level, 1)) : 0;
      if (existing) {
        req.target = existing.id;
        req.name = existing.name;
      }
      if (req.levels) {
        out.label = `Pouvoir : ${name} ${cur ? `${cur} → ` : ''}${req.to ?? cur + 1}`;
        targetTo(req, out, cur);
        if (req.maxLevel && out.to > req.maxLevel) bad(`${name} : niveau maximum ${req.maxLevel}`);
        if (out.to > prof.MAG) bad(`${name} : le niveau ne peut dépasser la Magie (${prof.MAG})`);
      } else {
        out.from = 0;
        out.to = 1;
        out.label = `Pouvoir : ${name}`;
      }
      out.ppCost = round2(req.pp * (out.to - out.from) + (cur === 0 ? req.extraPP : 0));
      const pp = powerPoints(actor);
      if (out.ppCost > pp.free + 1e-9) bad(`Points de pouvoir insuffisants : ${out.ppCost} requis, ${Math.max(0, pp.free)} libre${pp.free > 1 ? 's' : ''}`);
      out.label += ` (${out.ppCost} PP)`;
      return;
    }
    case 'powerPoint': {
      if (prof.type !== 'mystic') bad('Seuls les adeptes mystiques achètent des points de pouvoir (les adeptes en gagnent avec la Magie ou l’initiation)');
      const cur = Math.max(0, int(actor.magic?.extraPP));
      out.label = `Points de pouvoir achetés ${cur} → ${req.to ?? cur + 1}`;
      targetTo(req, out, cur);
      if (out.to > prof.MAG) bad(`Points de pouvoir : maximum = Magie (${prof.MAG})`);
      return;
    }
    case 'initiation': {
      const sub = prof.MAG <= 0 && prof.RES > 0;
      if (prof.MAG <= 0 && prof.RES <= 0) bad('Il faut être Éveillé ou Émergé pour s’initier');
      const cur = sub ? submersionGrade(actor) : initiationGrade(actor);
      req.target = sub ? 'submersion' : 'initiation';
      out.target = req.target;
      out.from = cur;
      out.to = cur + 1;
      const word = sub ? 'Submersion' : 'Initiation';
      out.label = `${word} : grade ${out.to}`;
      if (req.to !== null && req.to !== out.to) bad(`${word} : un grade à la fois`);
      const att = sub ? prof.RES : prof.MAG;
      if (out.to > att) bad(`${word} : le grade ne peut dépasser ${sub ? 'la Résonance' : 'la Magie'} (${att})`);
      const opts = ['group', 'ordeal', 'schooling'].filter((k) => req.options[k]);
      if (opts.length) out.label += ` (−${opts.length * 10} %)`;
      if (req.options.metamagic) out.label += ` · ${req.options.metamagic}`;
      if (req.options.powerPoint) {
        if (!prof.hasPowers) bad('Seuls les adeptes peuvent gagner un point de pouvoir par l’initiation');
        out.label += ' · +1 PP';
      }
      return;
    }
    case 'other': {
      const name = req.name || req.target;
      if (!name) bad('Décris la progression');
      req.name = name;
      costOpts.karma = req.karma;
      costOpts.days = req.days;
      out.from = 0;
      out.to = 1;
      out.label = name;
      out.manual = true;
      return;
    }
    default:
      bad('Type de progression inconnu');
  }
}

// ---------------------------------------------------------------------------
// Applying an advance (mutates the actor). Robust: never throws, returns a French summary.
// ---------------------------------------------------------------------------

function ensureSkill(actor, id, extra = {}) {
  actor.skills = Array.isArray(actor.skills) ? actor.skills : [];
  let e = findSkill(actor, id);
  if (!e) {
    const def = SKILL_BY_ID[id];
    e = { id, name: def?.fr || extra.name || id, attr: def?.attr || extra.attr || 'AGI', rating: 0 };
    if (def?.group) e.group = def.group;
    actor.skills.push(e);
  }
  return e;
}

/** Break an intact skill group: materialize every member at the group rating, then drop the group. */
function breakGroup(actor, groupId) {
  const grp = intactGroupEntry(actor, groupId);
  if (!grp) return false;
  for (const id of groupMembers(groupId)) {
    const e = ensureSkill(actor, id);
    e.rating = Math.max(int(e.rating), int(grp.rating));
  }
  actor.skillGroups = (actor.skillGroups || []).filter((g) => g.id !== groupId);
  return true;
}

function addSpec(entry, spec) {
  if (!spec) return;
  const cur = String(entry.spec || '').trim();
  if (cur && norm(cur).includes(norm(spec))) return;
  entry.spec = cur ? `${cur}, ${spec}` : spec;
}

export function applyAdvance(actor, raw) {
  const req = normalizeRequest(raw);
  if (!actor || !req.kind) return '';
  const to = req.to ?? 1;
  const magic = () => (actor.magic = actor.magic && typeof actor.magic === 'object' ? actor.magic : {});
  switch (req.kind) {
    case 'attribute': {
      const key = req.target.toUpperCase();
      actor.attributes = actor.attributes || {};
      const before = int(actor.attributes[key]);
      actor.attributes[key] = Math.max(before, to);
      // A higher Edge rating also refills the gained points.
      if (key === 'EDG' && actor.edge && typeof actor.edge === 'object') actor.edge.current = Math.min(int(actor.edge.current) + (actor.attributes[key] - before), actor.attributes[key]);
      return `${ATTR_LABELS[key] || key} ${actor.attributes[key]}`;
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
      return `Groupe ${SKILL_GROUPS[gid] || gid} ${g.rating}`;
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
        const q = { id: uid('q'), name, karma: req.karma, positive: true };
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
    case 'spell': {
      actor.spells = Array.isArray(actor.spells) ? actor.spells : [];
      const name = req.name || req.target;
      if (!actor.spells.some((s) => sameName(s.name, name, req.altName))) {
        const s = { id: uid('sp'), name, ...req.data };
        if (req.catalogId) s.catalogId = req.catalogId;
        actor.spells.push(s);
      }
      return name;
    }
    case 'complexForm': {
      actor.complexForms = Array.isArray(actor.complexForms) ? actor.complexForms : [];
      const name = req.name || req.target;
      if (!actor.complexForms.some((s) => norm(s.name) === norm(name))) {
        const s = { id: uid('cf'), name };
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
      let p = (req.target && actor.powers.find((x) => x.id === req.target)) || actor.powers.find((x) => (req.catalogId && x.catalogId === req.catalogId) || sameName(x.name, name, req.altName));
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
      return `${m.extraPP} point(s) de pouvoir achetés`;
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
    default:
      return req.name || req.target || '';
  }
}
