// SR5 character creation — Priority system (core rulebook p.62-107).
// Pure ES module shared by the server (15-chargen.js: re-validation, actor creation) and the browser (wizard live feedback).
// No Node / DOM APIs. Catalog access and pricing are injected through `ctx` so this file stays free of client paths:
//   ctx = {
//     lookup(id) -> { item, file } | null       catalog entry by id (data/catalog/*.json)
//     rules: { quote, evalFormula, targetList, DEVICE_GEAR }   from client/modules/shop/rules.js (pure)
//     settings: { startingKarmaBonus }           state.chargen.settings
//   }
//
// Draft data (state.chargen.drafts[].data), normalized by normalizeDraft():
//   { v, concept: { name, alias, concept, gender, age, portrait, background, player, color },
//     priorities: { metatype, attributes, magic, skills, resources }   // 'A'..'E' or ''
//     metatype: 'Humain'|'Elfe'|'Nain'|'Ork'|'Troll',
//     attributes: { BOD..EDG, MAG, RES } points spent above the metatype minimum (EDG/MAG/RES: special points),
//     attrKarma: { ... } extra ratings bought with karma (after the points),
//     magic: { type, tradition, aspect, freeSkills: [skillId], freeGroup, mentor, ppKarma },
//     skills: [{ id, points, karma, spec, specKarma }], groups: [{ id, points, karma }],
//     knowledge: [{ id, name, type, points, karma, spec, native }],
//     qualities: [{ id, catalogId, name, level, choice, notes }],
//     spells: [{ id, catalogId, name }], powers: [{ id, catalogId, name, level, choice }], complexForms: [{ id, name }],
//     gear: [{ id, ref, file, name, qty, rating, grade }],
//     lifestyle: { catalogId, months }, rollStartingNuyen, karmaToNuyen,
//     contacts: [{ id, name, connection, loyalty, notes }], notes }
import { METATYPES, SKILLS, SKILL_BY_ID, SKILL_GROUPS, ATTR_LABELS } from './sr5.js';
import { spellInfo, powerInfo } from './advancement.js';
import { bonusFromEffects } from './modifiers.js';

// ---------------------------------------------------------------------------
// i18n (see ARCHITECTURE.md « i18n »). French labels are dictionary keys (client/i18n/en/chargen.json): tk() marks
// them for tools/i18n-check.js and the UI renders t(label). Validation issues carry { text (French), key, params,
// en? (English values of item names) } so the wizard shows them translated.
// ---------------------------------------------------------------------------
const tk = (s) => s;
/** French thousands (12 000) for `nuyen` params. */
const frNum = (n) => Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
/** Params whose value is a nuyen amount: formatted per language when rendered. */
export const NUYEN_PARAMS = ['nuyen'];
/** French rendering of a key + params (nested { t, params } values translated recursively, nuyen params formatted). */
export function fill(key, params) {
  const s = String(key ?? '');
  const k = s.includes('::') ? s.slice(s.indexOf('::') + 2) : s;
  if (!params) return k;
  return k.replace(/\{(\w+)\}/g, (m, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return m;
    const v = params[name];
    if (v === null || v === undefined) return '';
    if (NUYEN_PARAMS.includes(name) && typeof v === 'number') return frNum(v);
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? fill(x.t, x.params) : String(x))).join(', ');
    if (typeof v === 'object') return typeof v.t === 'string' ? fill(v.t, v.params) : '';
    return String(v);
  });
}
/** Translator used by the display helpers below: French by default, the client passes { t, fmtNumber }. */
const frI18n = { t: fill, fmtNumber: frNum };

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
export const LETTERS = ['A', 'B', 'C', 'D', 'E'];
export const COLUMNS = ['metatype', 'attributes', 'magic', 'skills', 'resources'];
export const COLUMN_LABELS = { metatype: tk('Métatype'), attributes: tk('Attributs'), magic: tk('Magie / Résonance'), skills: tk('Compétences'), resources: tk('Ressources') };

export const PHYSICAL = ['BOD', 'AGI', 'REA', 'STR'];
export const MENTAL = ['WIL', 'LOG', 'INT', 'CHA'];
export const CORE_ATTRS = [...PHYSICAL, ...MENTAL];
export const SPECIAL_ATTRS = ['EDG', 'MAG', 'RES'];

/** Special attribute points per metatype at each Metatype priority (metatypes missing = not available). */
export const METATYPE_PRIORITY = {
  A: { Humain: 9, Elfe: 8, Nain: 7, Ork: 7, Troll: 5 },
  B: { Humain: 7, Elfe: 6, Nain: 4, Ork: 4, Troll: 0 },
  C: { Humain: 5, Elfe: 3, Nain: 1, Ork: 0 },
  D: { Humain: 3, Elfe: 0 },
  E: { Humain: 1 },
};
export const METATYPE_IDS = ['Humain', 'Elfe', 'Nain', 'Ork', 'Troll'];

/** Metatype minimums (maximums come from shared/sr5.js METATYPES). */
export const METATYPE_MIN = {
  Humain: { BOD: 1, AGI: 1, REA: 1, STR: 1, WIL: 1, LOG: 1, INT: 1, CHA: 1, EDG: 2 },
  Elfe: { BOD: 1, AGI: 2, REA: 1, STR: 1, WIL: 1, LOG: 1, INT: 1, CHA: 3, EDG: 1 },
  Nain: { BOD: 3, AGI: 1, REA: 1, STR: 3, WIL: 2, LOG: 1, INT: 1, CHA: 1, EDG: 1 },
  Ork: { BOD: 4, AGI: 1, REA: 1, STR: 3, WIL: 1, LOG: 1, INT: 1, CHA: 1, EDG: 1 },
  Troll: { BOD: 5, AGI: 1, REA: 1, STR: 5, WIL: 1, LOG: 1, INT: 1, CHA: 1, EDG: 1 },
};

/** Racial traits (shown in the wizard, written as 0-karma qualities on the actor). */
export const METATYPE_TRAITS = {
  Humain: [],
  Elfe: [tk('Vision nocturne')],
  Nain: [tk('Vision thermographique'), tk('Résistance aux toxines et pathogènes (+2 dés)'), tk('Train de vie +20 %')],
  Ork: [tk('Vision nocturne')],
  Troll: [tk('Vision thermographique'), tk('Allonge +1'), tk('Armure dermique +1'), tk('Train de vie +100 %')],
};
const LIFESTYLE_MULT = { Nain: 1.2, Troll: 2 };

export const ATTRIBUTE_POINTS = { A: 24, B: 20, C: 16, D: 14, E: 12 };
export const SKILL_POINTS = { A: [46, 10], B: [36, 5], C: [28, 2], D: [22, 0], E: [18, 0] };
export const RESOURCES = { A: 450000, B: 275000, C: 140000, D: 50000, E: 6000 };

export const MAGIC_TYPES = {
  none: { label: tk('Profane'), short: tk('Profane'), quality: null },
  magician: { label: tk('Magicien'), short: tk('Magicien'), quality: tk('Magicien') },
  mystic: { label: tk('Adepte mystique'), short: tk('Adepte myst.'), quality: tk('Adepte mystique') },
  adept: { label: tk('Adepte'), short: tk('Adepte'), quality: tk('Adepte') },
  aspected: { label: tk('Magicien spécialisé'), short: tk('Spécialisé'), quality: tk('Magicien spécialisé') },
  technomancer: { label: tk('Technomancien'), short: tk('Technomancien'), quality: tk('Technomancien') },
};
/** Lower-case magic type for sentences (« inaccessible pour un adepte »). */
const MAGIC_TYPE_LC = { none: tk('profane'), magician: tk('magicien'), mystic: tk('adepte mystique'), adept: tk('adepte'), aspected: tk('magicien spécialisé'), technomancer: tk('technomancien') };
export const MAGIC_TYPE_IDS = Object.keys(MAGIC_TYPES);

/**
 * Magic / Resonance column (SR5 core p.65). skills: free active skills { n, rating, cat: 'magic'|'resonance'|'active' };
 * group: one free magical skill group at that rating (aspected magicians); spells / forms: free spells / complex forms.
 */
export const MAGIC_TABLE = {
  A: {
    magician: { MAG: 6, skills: { n: 2, rating: 5, cat: 'magic' }, spells: 10 },
    mystic: { MAG: 6, skills: { n: 2, rating: 5, cat: 'magic' }, spells: 10 },
    technomancer: { RES: 6, skills: { n: 2, rating: 5, cat: 'resonance' }, forms: 5 },
  },
  B: {
    magician: { MAG: 4, skills: { n: 2, rating: 4, cat: 'magic' }, spells: 7 },
    mystic: { MAG: 4, skills: { n: 2, rating: 4, cat: 'magic' }, spells: 7 },
    technomancer: { RES: 4, skills: { n: 2, rating: 4, cat: 'resonance' }, forms: 2 },
    adept: { MAG: 6, skills: { n: 1, rating: 4, cat: 'active' } },
    aspected: { MAG: 5, group: { rating: 4 } },
  },
  C: {
    magician: { MAG: 3, spells: 5 },
    mystic: { MAG: 3, spells: 5 },
    technomancer: { RES: 3, forms: 1 },
    adept: { MAG: 4, skills: { n: 1, rating: 2, cat: 'active' } },
    aspected: { MAG: 3, group: { rating: 2 } },
  },
  D: { adept: { MAG: 2 }, aspected: { MAG: 2 } },
  E: {},
};
export const ASPECTS = { sorcery: tk('Sorcellerie'), conjuring: tk('Conjuration'), enchanting: tk('Enchantement') };
/** Stored as the French name (data), shown with t(). */
export const TRADITIONS = [tk('Hermétique'), tk('Chamanique'), tk('Chaos'), tk('Druide'), tk('Bouddhiste'), tk('Shinto'), tk('Wicca'), tk('Vaudou'), tk('Autre')];
/** Complex form targets (COMPLEX_FORMS[].target) — French keys. */
export const FORM_TARGETS = [tk('Persona'), tk('Appareil'), tk('Fichier'), tk('Soi'), tk('Sprite')];

/** SR5 core complex forms (p.256). fading = Fading Value (L = level). */
export const COMPLEX_FORMS = [
  { id: 'cleaner', name: 'Nettoyeur', en: 'Cleaner', target: 'Persona', duration: 'P', fading: 'L+1' },
  { id: 'diffusion', name: 'Diffusion de [attribut]', en: 'Diffusion of [Matrix Attribute]', target: 'Appareil', duration: 'S', fading: 'L+1' },
  { id: 'editor', name: 'Éditeur', en: 'Editor', target: 'Fichier', duration: 'P', fading: 'L+2' },
  { id: 'infusion', name: 'Infusion de [attribut]', en: 'Infusion of [Matrix Attribute]', target: 'Persona', duration: 'S', fading: 'L+1' },
  { id: 'pulse_storm', name: 'Tempête d’impulsions', en: 'Pulse Storm', target: 'Persona', duration: 'I', fading: 'L+1' },
  { id: 'puppeteer', name: 'Marionnettiste', en: 'Puppeteer', target: 'Appareil', duration: 'I', fading: 'L+4' },
  { id: 'resonance_channel', name: 'Canal de résonance', en: 'Resonance Channel', target: 'Appareil', duration: 'S', fading: 'L-1' },
  { id: 'resonance_spike', name: 'Pic de résonance', en: 'Resonance Spike', target: 'Appareil', duration: 'I', fading: 'L' },
  { id: 'resonance_veil', name: 'Voile de résonance', en: 'Resonance Veil', target: 'Appareil', duration: 'S', fading: 'L+1' },
  { id: 'static_bomb', name: 'Bombe statique', en: 'Static Bomb', target: 'Soi', duration: 'I', fading: 'L+2' },
  { id: 'static_veil', name: 'Voile statique', en: 'Static Veil', target: 'Persona', duration: 'S', fading: 'L-1' },
  { id: 'stitches', name: 'Points de suture', en: 'Stitches', target: 'Sprite', duration: 'P', fading: 'L+1' },
  { id: 'tattletale', name: 'Mouchard', en: 'Tattletale', target: 'Persona', duration: 'P', fading: 'L-2' },
  { id: 'transcendent_grid', name: 'Grille transcendante', en: 'Transcendent Grid', target: 'Soi', duration: 'I', fading: 'L+3' },
];
export const COMPLEX_FORM_BY_ID = Object.fromEntries(COMPLEX_FORMS.map((f) => [f.id, f]));

export const KNOWLEDGE_TYPES = { street: tk('Rue'), academic: tk('Académique'), professional: tk('Professionnelle'), interest: tk('Centre d’intérêt'), language: tk('Langue') };
/** Qualities that come from the Magic priority (never bought separately at creation). */
export const MAGIC_QUALITY_NAMES = new Set(['Magician', 'Adept', 'Mystic Adept', 'Aspected Magician', 'Technomancer']);
export const CREATION_GRADES = ['standard', 'alpha', 'used'];
export const GEAR_FILES = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'programs', 'accessories', 'armormods'];
/** Upgrade catalogs offered at creation: installed on a weapon / armor row of the same draft (gear row `target` = that row's id). */
export const CREATION_UPGRADES = { accessories: { file: 'weapons', list: 'weapons', sub: 'accessories' }, armormods: { file: 'armor', list: 'armor', sub: 'mods' } };

export const LIMITS = {
  karma: 25, // starting karma
  positiveQualities: 25,
  negativeQualities: 25,
  karmaToNuyenMax: 10,
  nuyenPerKarma: 2000,
  keptKarma: 7,
  keptNuyen: 5000,
  maxAvail: 12,
  skillMax: 6,
  knowledgeMax: 6,
  groupMax: 6,
  contactConnectionMax: 12,
  contactLoyaltyMax: 6,
  gearLines: 200,
};

export const STEPS = [
  { id: 'concept', label: tk('Concept') },
  { id: 'priorities', label: tk('Priorités') },
  { id: 'metatype', label: tk('Métatype') },
  { id: 'attributes', label: tk('Attributs') },
  { id: 'magic', label: tk('Magie / Résonance') },
  { id: 'skills', label: tk('Compétences') },
  { id: 'qualities', label: tk('Qualités') },
  { id: 'gear', label: tk('Équipement') },
  { id: 'contacts', label: tk('Contacts & connaissances') },
  { id: 'summary', label: tk('Récapitulatif') },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d = 0, lo = -1e9, hi = 1e9) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
let rowCounter = 0;
/** Short row id for draft list items (not a game id). */
export function rowId(prefix = 'r') {
  rowCounter = (rowCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${rowCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
/** Karma for raising a rating from `from` to `to`, `mult` karma per new rating (SR5: attribute ×5, skill ×2, group ×5, knowledge ×1). */
export function karmaSteps(from, to, mult) {
  let s = 0;
  for (let r = Math.max(0, from) + 1; r <= to; r++) s += r * mult;
  return s;
}
/** Plural key: `many` above 1 (the French rule these messages always used). */
const fr = (n, one, many) => (n > 1 ? many : one);

// ---------------------------------------------------------------------------
// Draft normalization (everything coming from a client goes through here)
// ---------------------------------------------------------------------------
export function emptyDraft() {
  return normalizeDraft({});
}

function list(v, max, fix) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of v.slice(0, max)) {
    if (!isObj(raw)) continue;
    const it = fix(raw);
    if (!it) continue;
    if (!it.id || seen.has(it.id)) it.id = rowId();
    seen.add(it.id);
    out.push(it);
  }
  return out;
}
const letter = (v) => (LETTERS.includes(v) ? v : '');

export function normalizeDraft(raw) {
  const d = isObj(raw) ? raw : {};
  const c = isObj(d.concept) ? d.concept : {};
  const p = isObj(d.priorities) ? d.priorities : {};
  const m = isObj(d.magic) ? d.magic : {};
  const out = {
    v: 1,
    concept: {
      name: str(c.name, 80).trim() ? str(c.name, 80) : '',
      alias: str(c.alias, 80),
      concept: str(c.concept, 160),
      gender: str(c.gender, 40),
      age: str(c.age, 20),
      portrait: /^(\/uploads\/|\/assets\/|https?:\/\/)/.test(str(c.portrait, 500)) ? str(c.portrait, 500) : '',
      background: str(c.background, 20000),
      player: str(c.player, 80),
      color: /^#[0-9a-fA-F]{3,8}$/.test(str(c.color, 9)) ? str(c.color, 9) : '#3fd6d0',
    },
    priorities: Object.fromEntries(COLUMNS.map((k) => [k, letter(p[k])])),
    metatype: METATYPE_IDS.includes(d.metatype) ? d.metatype : 'Humain',
    attributes: {},
    attrKarma: {},
    magic: {
      type: MAGIC_TYPE_IDS.includes(m.type) ? m.type : 'none',
      tradition: str(m.tradition, 60),
      aspect: ASPECTS[m.aspect] ? m.aspect : 'sorcery',
      freeSkills: (Array.isArray(m.freeSkills) ? m.freeSkills : []).map((x) => str(x, 60)).filter((x) => SKILL_BY_ID[x]).slice(0, 2),
      freeGroup: SKILL_GROUPS[m.freeGroup] ? m.freeGroup : '',
      mentor: str(m.mentor, 80),
      ppKarma: int(m.ppKarma, 0, 0, 12),
    },
    skills: list(d.skills, 120, (s) => {
      const id = str(s.id, 60);
      if (!SKILL_BY_ID[id]) return null;
      return { id, points: int(s.points, 0, 0, 12), karma: int(s.karma, 0, 0, 12), spec: str(s.spec, 60).trim(), specKarma: !!s.specKarma };
    }).filter((s) => SKILL_BY_ID[s.id]), // list() renames duplicate ids: a skill listed twice is dropped
    groups: list(d.groups, 20, (g) => (SKILL_GROUPS[g.id] ? { id: g.id, points: int(g.points, 0, 0, 12), karma: int(g.karma, 0, 0, 12) } : null)).filter((g) => SKILL_GROUPS[g.id]),
    knowledge: list(d.knowledge, 60, (k) => ({
      id: str(k.id, 40),
      name: str(k.name, 80),
      type: KNOWLEDGE_TYPES[k.type] ? k.type : 'street',
      points: int(k.points, 0, 0, 12),
      karma: int(k.karma, 0, 0, 12),
      spec: str(k.spec, 60).trim(),
      native: !!k.native,
    })),
    qualities: list(d.qualities, 40, (q) => ({
      id: str(q.id, 40),
      catalogId: str(q.catalogId, 80),
      name: str(q.name, 120),
      level: int(q.level, 1, 1, 30),
      choice: str(q.choice, 60),
      notes: str(q.notes, 300),
    })),
    spells: list(d.spells, 60, (s) => (str(s.catalogId, 80) ? { id: str(s.id, 40), catalogId: str(s.catalogId, 80), name: str(s.name, 120) } : null)),
    powers: list(d.powers, 40, (s) =>
      str(s.catalogId, 80) ? { id: str(s.id, 40), catalogId: str(s.catalogId, 80), name: str(s.name, 120), level: int(s.level, 1, 1, 12), choice: str(s.choice, 60) } : null
    ),
    complexForms: list(d.complexForms, 30, (f) => (COMPLEX_FORM_BY_ID[f.formId] ? { id: str(f.id, 40), formId: f.formId } : null)),
    gear: list(d.gear, LIMITS.gearLines, (g) => {
      const ref = str(g.ref, 80);
      if (!ref) return null;
      return {
        id: str(g.id, 40),
        ref,
        file: GEAR_FILES.includes(g.file) ? g.file : 'gear',
        name: str(g.name, 120),
        qty: int(g.qty, 1, 1, 999),
        rating: g.rating === null || g.rating === undefined || g.rating === '' ? null : int(g.rating, 1, 0, 100),
        grade: CREATION_GRADES.includes(g.grade) || ['beta', 'delta'].includes(g.grade) ? g.grade : null,
        // Weapon accessory / armor mod: draft row it is installed on (+ accessory mount point).
        ...(str(g.target, 40) ? { target: str(g.target, 40) } : {}),
        ...(str(g.mount, 20) ? { mount: str(g.mount, 20) } : {}),
      };
    }),
    lifestyle: isObj(d.lifestyle) && str(d.lifestyle.catalogId, 80) ? { catalogId: str(d.lifestyle.catalogId, 80), months: int(d.lifestyle.months, 1, 1, 12) } : null,
    rollStartingNuyen: d.rollStartingNuyen !== false,
    karmaToNuyen: int(d.karmaToNuyen, 0, 0, LIMITS.karmaToNuyenMax),
    contacts: list(d.contacts, 30, (k) => ({
      id: str(k.id, 40),
      name: str(k.name, 80),
      connection: int(k.connection, 1, 1, LIMITS.contactConnectionMax),
      loyalty: int(k.loyalty, 1, 1, LIMITS.contactLoyaltyMax),
      notes: str(k.notes, 500),
    })),
    notes: str(d.notes, 4000),
  };
  const a = isObj(d.attributes) ? d.attributes : {};
  const ak = isObj(d.attrKarma) ? d.attrKarma : {};
  for (const k of [...CORE_ATTRS, ...SPECIAL_ATTRS]) {
    out.attributes[k] = int(a[k], 0, 0, 12);
    out.attrKarma[k] = int(ak[k], 0, 0, 12);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------
/** Magic options available at a Magic priority letter: [{ type, ...row }] (always includes 'none'). */
export function magicOptions(letterValue) {
  const row = MAGIC_TABLE[letterValue] || {};
  return [{ type: 'none' }, ...Object.entries(row).map(([type, v]) => ({ type, ...v }))];
}
export function magicRow(data) {
  const t = data?.magic?.type || 'none';
  if (t === 'none') return null;
  return MAGIC_TABLE[data?.priorities?.magic]?.[t] || null;
}
/**
 * Short explanation of what a priority letter gives in a column. French by default; the client passes
 * i18n = { t, fmtNumber } to get it in the UI language.
 */
export function priorityText(column, l, i18n = frI18n) {
  const tr = i18n.t;
  if (!LETTERS.includes(l)) return '';
  if (column === 'metatype') {
    return Object.entries(METATYPE_PRIORITY[l]).map(([m, n]) => tr(tk('{meta} ({n})'), { meta: { t: m }, n })).join(', ');
  }
  if (column === 'attributes') return tr(tk('{n} points'), { n: ATTRIBUTE_POINTS[l] });
  if (column === 'skills') return `${SKILL_POINTS[l][0]} / ${SKILL_POINTS[l][1]}`;
  if (column === 'resources') return `${i18n.fmtNumber(RESOURCES[l])}¥`;
  const opts = magicOptions(l).filter((o) => o.type !== 'none');
  if (!opts.length) return tr(tk('Profane'));
  return opts.map((o) => magicOptionText(o, i18n)).join(' · ');
}
/** What a magic option gives, without the type name: « Magie 6, 2 compétences magiques à 5, 10 sorts ». */
export function magicOptionParts(o, i18n = frI18n) {
  const tr = i18n.t;
  const parts = [];
  if (!o || o.type === 'none') return '';
  if (o.MAG) parts.push(tr(tk('Magie {n}'), { n: o.MAG }));
  if (o.RES) parts.push(tr(tk('Résonance {n}'), { n: o.RES }));
  if (o.skills) {
    const p = { n: o.skills.n, r: o.skills.rating };
    if (o.skills.cat === 'magic') parts.push(tr(tk('{n} compétences magiques à {r}'), p));
    else if (o.skills.cat === 'resonance') parts.push(tr(tk('{n} compétences de résonance à {r}'), p));
    else parts.push(tr(fr(o.skills.n, tk('{n} compétence active à {r}'), tk('{n} compétences actives à {r}')), p));
  }
  if (o.group) parts.push(tr(tk('1 groupe magique à {r}'), { r: o.group.rating }));
  if (o.spells) parts.push(tr(tk('{n} sorts'), { n: o.spells }));
  if (o.forms) parts.push(tr(fr(o.forms, tk('{n} forme complexe'), tk('{n} formes complexes')), { n: o.forms }));
  return parts.join(', ');
}
export function magicOptionText(o, i18n = frI18n) {
  if (!o || o.type === 'none') return i18n.t(tk('Profane : aucune magie'));
  return i18n.t(tk('{type} : {parts}'), { type: { t: MAGIC_TYPES[o.type].label }, parts: magicOptionParts(o, i18n) });
}

/** Skill groups an aspected magician may take for a given aspect. */
export function aspectGroup(aspect) {
  return ASPECTS[aspect] ? aspect : 'sorcery';
}

/** Can this magic type use that (magical / resonance) skill at all? */
export function skillAllowed(data, id) {
  const def = SKILL_BY_ID[id];
  if (!def) return false;
  const t = data?.magic?.type || 'none';
  if (def.cat === 'resonance') return t === 'technomancer';
  if (def.cat !== 'magic') return true;
  if (t === 'magician' || t === 'mystic') return true;
  if (t === 'aspected') return !def.group || def.group === aspectGroup(data.magic.aspect) || ['arcana', 'assensing', 'astral_combat'].includes(id);
  if (t === 'adept') return ['arcana', 'assensing', 'astral_combat'].includes(id);
  return false;
}

/** Quality info from the catalog: { name, karma (abs, per level), positive, maxLevels, chargenOnly }. */
export function qualityData(ctx, q) {
  const e = q?.catalogId ? ctx?.lookup?.(q.catalogId) : null;
  if (!e || e.file !== 'qualities') return null;
  const st = e.item.stats || {};
  return {
    item: e.item,
    name: e.item.nameFr || e.item.name,
    en: e.item.name,
    karma: Math.abs(Number(st.karma) || 0),
    positive: st.positive !== false,
    maxLevels: Number(st.maxLevels) || 1,
  };
}

function hasQualityEn(data, ctx, re) {
  return (data.qualities || []).some((q) => {
    const info = qualityData(ctx, q);
    return info ? re.test(info.en) : re.test(q.name || '');
  });
}
function qualityChoice(data, ctx, re) {
  const q = (data.qualities || []).find((x) => {
    const info = qualityData(ctx, x);
    return info ? re.test(info.en) : re.test(x.name || '');
  });
  return q ? q.choice || '' : null;
}

/** Natural limits of an attribute for this draft: { min, max }. */
export function attrLimits(data, ctx, key) {
  const meta = data.metatype || 'Humain';
  if (key === 'MAG' || key === 'RES') return { min: 0, max: 6 + (qualityChoice(data, ctx, /^Exceptional Attribute$/) === key ? 1 : 0) };
  const min = METATYPE_MIN[meta]?.[key] ?? 1;
  let max = METATYPES[meta]?.max?.[key] ?? 6;
  if (key === 'EDG' && hasQualityEn(data, ctx, /^Lucky$/)) max += 1;
  const exc = qualityChoice(data, ctx, /^Exceptional Attribute$/);
  if (exc === key) max += 1;
  return { min, max };
}

// ---------------------------------------------------------------------------
// Full computation + validation
// ---------------------------------------------------------------------------
/**
 * Compute budgets, spending, final values and validation for a draft.
 * Returns { budgets, attrs, final, skills, karma, nuyen, gearLines, essence, magic, errors, warnings, ok }.
 * errors/warnings: [{ step, text (French), key, params?, en? }] — render with issueText() client-side. `ok` = no errors.
 */
export function compute(rawData, ctx = {}) {
  const data = normalizeDraft(rawData);
  const errors = [];
  const warnings = [];
  // en = English values of params that hold catalog names ({ name: item.name }); nested { t } params are translated.
  const issue = (step, key, params, en) => ({ step, text: fill(key, params), key, ...(params ? { params } : {}), ...(en ? { en } : {}) });
  const err = (step, key, params, en) => errors.push(issue(step, key, params, en));
  const warn = (step, key, params, en) => warnings.push(issue(step, key, params, en));
  const A = (k) => ({ t: ATTR_LABELS[k] || k });
  const SK = (def) => ({ t: def.fr });
  const GRP = (id) => ({ t: SKILL_GROUPS[id] || id });
  const MT = (type) => ({ t: MAGIC_TYPE_LC[type] || type });
  /** Catalog item name: French in params, English in `en`. */
  const itemNames = (item) => [item.nameFr || item.name, item.name];
  const P = data.priorities;
  const lookup = ctx.lookup || (() => null);
  const rules = ctx.rules || {};
  const settings = ctx.settings || {};

  // ---- Concept
  if (!data.concept.name.trim() && !data.concept.alias.trim()) err('concept', tk('Donne un nom ou un nom de rue au personnage.'));
  if (!data.concept.concept.trim()) warn('concept', tk('Décris le concept du personnage en une phrase (aide le MJ à valider).'));

  // ---- Priorities
  const used = {};
  for (const col of COLUMNS) {
    const l = P[col];
    if (!l) err('priorities', tk('Priorité « {column} » non attribuée.'), { column: { t: COLUMN_LABELS[col] } });
    else (used[l] = used[l] || []).push(col);
  }
  for (const [l, cols] of Object.entries(used)) {
    if (cols.length > 1) err('priorities', tk('La priorité {letter} est utilisée plusieurs fois ({columns}).'), { letter: l, columns: cols.map((c) => ({ t: COLUMN_LABELS[c] })) });
  }

  // ---- Metatype
  const metaRow = METATYPE_PRIORITY[P.metatype] || null;
  const specialPoints = metaRow ? metaRow[data.metatype] : 0;
  if (metaRow && metaRow[data.metatype] === undefined) {
    err('metatype', tk('{meta} n’est pas disponible avec la priorité {letter} en métatype.'), { meta: { t: data.metatype }, letter: P.metatype });
  }

  // ---- Magic
  const mtype = data.magic.type;
  const mrow = magicRow(data);
  if (mtype !== 'none' && !mrow) err('magic', tk('{type} n’est pas disponible avec la priorité {letter} en magie.'), { type: { t: MAGIC_TYPES[mtype].label }, letter: P.magic || '?' });
  const awakened = ['magician', 'mystic', 'adept', 'aspected'].includes(mtype);
  const emerged = mtype === 'technomancer';
  const baseMAG = awakened ? mrow?.MAG || 0 : 0;
  const baseRES = emerged ? mrow?.RES || 0 : 0;

  // ---- Attributes
  const attrs = {};
  const final = {};
  let attrPointsSpent = 0;
  let specialSpent = 0;
  let attrKarma = 0;
  for (const k of [...CORE_ATTRS, 'EDG']) {
    const { min, max } = attrLimits(data, ctx, k);
    const points = data.attributes[k] || 0;
    const kk = data.attrKarma[k] || 0;
    const value = min + points + kk;
    attrs[k] = { min, max, points, karma: kk, value };
    final[k] = value;
    if (k === 'EDG') specialSpent += points;
    else attrPointsSpent += points;
    attrKarma += karmaSteps(min + points, value, 5);
    if (value > max) err('attributes', tk('{attr} {value} dépasse le maximum ({max}).'), { attr: A(k), value, max });
  }
  for (const k of ['MAG', 'RES']) {
    const active = k === 'MAG' ? awakened : emerged;
    const base = k === 'MAG' ? baseMAG : baseRES;
    const points = data.attributes[k] || 0;
    const kk = data.attrKarma[k] || 0;
    if (!active) {
      if (points || kk) err('attributes', k === 'MAG' ? tk('{attr} : réservé aux éveillés.') : tk('{attr} : réservé aux technomanciens.'), { attr: A(k) });
      attrs[k] = { min: 0, max: 0, points: 0, karma: 0, value: 0, inactive: true };
      continue;
    }
    const value = base + points + kk;
    const { max } = attrLimits(data, ctx, k);
    attrs[k] = { min: base, max, points, karma: kk, value };
    final[k] = value;
    specialSpent += points;
    attrKarma += karmaSteps(base + points, value, 5);
    if (value > max) err('attributes', tk('{attr} {value} dépasse le maximum de création ({max}).'), { attr: A(k), value, max });
  }
  const attrPoints = ATTRIBUTE_POINTS[P.attributes] || 0;
  if (attrPointsSpent > attrPoints) err('attributes', tk('Points d’attributs : {spent} dépensés pour {total} disponibles.'), { spent: attrPointsSpent, total: attrPoints });
  if (specialSpent > specialPoints) err('attributes', tk('Points d’attributs spéciaux : {spent} dépensés pour {total} disponibles.'), { spent: specialSpent, total: specialPoints });
  const atMax = CORE_ATTRS.filter((k) => attrs[k].value >= METATYPES[data.metatype].max[k] && attrs[k].value >= attrs[k].max);
  if (atMax.length > 1) err('attributes', tk('Un seul attribut physique ou mental peut être à son maximum naturel ({attrs}).'), { attrs: atMax.map(A) });
  if (P.attributes && attrPointsSpent < attrPoints) {
    const n = attrPoints - attrPointsSpent;
    warn('attributes', fr(n, tk('{n} point d’attribut non dépensé (perdus à la validation).'), tk('{n} points d’attributs non dépensés (perdus à la validation).')), { n });
  }
  if (P.metatype && specialSpent < specialPoints) {
    const n = specialPoints - specialSpent;
    warn('attributes', fr(n, tk('{n} point spécial non dépensé.'), tk('{n} points spéciaux non dépensés.')), { n });
  }

  // ---- Gear (needed early: essence affects Magic)
  const gearLines = [];
  /**
   * Weapon accessory / armor mod row: target = a weapon / armor row of the draft; price with the target's value (WeaponCost,
   * ArmorCost, Capacity), availability relative to the target (« +2R »), fit checked with the shop rules (mount points, capacity).
   */
  const upgradeLine = (g, e) => {
    const u = CREATION_UPGRADES[e.file];
    const [nfr, nen] = itemNames(e.item);
    const base = { row: g, item: e.item, file: e.file, name: nfr, upgrade: true };
    const tl = gearLines.find((l) => l.row.id === g.target && l.file === u.file && l.item && l.quote && (!rules.targetList || rules.targetList(l.file, l.item) === u.list));
    if (!tl) {
      err('gear', u.file === 'weapons' ? tk('{name} : choisis l’arme sur laquelle l’installer.') : tk('{name} : choisis l’armure sur laquelle l’installer.'), { name: nfr }, { name: nen });
      return base;
    }
    const tst = tl.item.stats || {};
    if (!tl.sim) {
      tl.sim = u.file === 'weapons'
        ? { name: tl.name, category: tl.item.category, ...(Array.isArray(tst.mounts) ? { mounts: [...tst.mounts] } : {}),
          accessories: (tst.included || []).map((inc) => ({ catalogId: inc.id, name: inc.name, mount: 'Internal', included: true })) }
        : { name: tl.name, rating: evalAt(rules, tst.armor ?? 0, tl.quote.rating), ...(tst.capacity !== undefined ? { capacity: tst.capacity } : {}), mods: [] };
    }
    const cap = u.file === 'armor' && rules.armorCapacity ? rules.armorCapacity(tl.sim, tl.item) : 0;
    const vars = u.file === 'weapons' ? { WeaponCost: tl.quote.unitCost || 0 } : { ArmorCost: tl.quote.unitCost || 0, Capacity: cap };
    let q = null;
    try {
      q = rules.quote ? rules.quote(e.item, { rating: g.rating, vars }) : null;
      if (q && rules.upgradeAvail) q = rules.upgradeAvail(q, e.item, tl.quote);
    } catch {
      q = null;
    }
    if (!q) return { ...base, missing: !rules.quote };
    const line = { ...base, quote: q, qty: 1, total: q.unitCost, essence: 0, target: { rowId: tl.row.id, name: tl.name } };
    const en = (params) => Object.fromEntries(Object.entries(params || {}).map(([k, v]) => [k, k === 'item' ? nen : k === 'weapon' || k === 'armor' ? tl.item.name : v]));
    if (u.file === 'weapons' && rules.accessoryFit) {
      const fit = rules.accessoryFit(tl.sim, tl.item, e.item, { mount: g.mount });
      if (fit.problem) {
        err('gear', fit.problem.key, fit.problem.params, en(fit.problem.params));
        line.misfit = true;
      }
      else {
        tl.sim.accessories.push({ catalogId: e.item.id, mount: fit.mount });
        line.mount = fit.mount;
      }
    } else if (u.file === 'armor' && rules.armorModFit) {
      const fit = rules.armorModFit(tl.sim, tl.item, e.item, q.rating);
      if (fit.problem) {
        err('gear', fit.problem.key, fit.problem.params, en(fit.problem.params));
        line.misfit = true;
      }
      else {
        tl.sim.mods.push({ catalogId: e.item.id, capacity: fit.need });
        line.capacity = fit.need;
      }
    }
    return line;
  };
  let gearCost = 0;
  let essenceCost = 0;
  // Upgrade rows (accessories, armor mods) are priced and fitted after the weapons / armors they are installed on.
  const isUpgradeRow = (g) => !!CREATION_UPGRADES[lookup(g.ref)?.file];
  for (const g of [...data.gear.filter((x) => !isUpgradeRow(x)), ...data.gear.filter(isUpgradeRow)]) {
    const e = lookup(g.ref);
    if (!e) {
      gearLines.push({ row: g, missing: true, name: g.name || g.ref });
      if (ctx.lookup) err('gear', g.name ? tk('{name} : introuvable dans le catalogue.') : tk('Objet : introuvable dans le catalogue.'), g.name ? { name: g.name } : undefined);
      continue;
    }
    if (!GEAR_FILES.includes(e.file)) {
      const [nfr, nen] = itemNames(e.item);
      err('gear', tk('{name} : ne s’achète pas ici.'), { name: nfr }, { name: nen });
      continue;
    }
    if (CREATION_UPGRADES[e.file]) {
      const line = upgradeLine(g, e);
      gearLines.push(line);
      if (line.quote) {
        gearCost += line.total;
        if (line.quote.availValue > LIMITS.maxAvail) err('gear', tk('{name} : disponibilité {avail} au-dessus de {max} (création).'), { name: line.name, avail: line.quote.avail, max: LIMITS.maxAvail }, { name: e.item.name });
      }
      continue;
    }
    const ware = e.file === 'cyberware' || e.file === 'bioware';
    let q = null;
    try {
      q = rules.quote ? rules.quote(e.item, { rating: g.rating, grade: ware ? g.grade || 'standard' : undefined }) : null;
    } catch {
      q = null;
    }
    if (!q) {
      gearLines.push({ row: g, item: e.item, file: e.file, name: e.item.nameFr || e.item.name, missing: !rules.quote });
      continue;
    }
    const name = e.item.nameFr || e.item.name;
    const line = { row: g, item: e.item, file: e.file, name, quote: q, qty: g.qty, total: q.unitCost * g.qty, essence: ware ? round3((q.essence || 0) * g.qty) : 0 };
    gearLines.push(line);
    gearCost += line.total;
    essenceCost += line.essence;
    const en = { name: e.item.name };
    if (q.availValue > LIMITS.maxAvail) err('gear', tk('{name} : disponibilité {avail} au-dessus de {max} (création).'), { name, avail: q.avail, max: LIMITS.maxAvail }, en);
    if (ware && q.grade && !CREATION_GRADES.includes(q.grade)) err('gear', tk('{name} : le grade {grade} n’est pas autorisé à la création (standard, alpha ou d’occasion).'), { name, grade: q.grade }, en);
    if (e.item.costRange) warn('gear', tk('{name} : prix variable, le MJ fixera le montant.'), { name }, en);
  }
  essenceCost = round3(essenceCost);
  const essence = round3(6 - essenceCost);
  if (essence <= 0) err('gear', tk('Essence {ess} : ce personnage ne survivrait pas à ses implants.'), { ess: essence });
  const lossFromEss = Math.max(0, Math.ceil(6 - essence - 1e-9));
  final.ESS = essence;
  if (awakened || emerged) {
    const k = awakened ? 'MAG' : 'RES';
    if (lossFromEss > 0) {
      final[k] = Math.max(0, final[k] - lossFromEss);
      if (final[k] <= 0) err('gear', tk('{attr} réduite à 0 par la perte d’Essence : le personnage perd ses capacités.'), { attr: A(k) });
      else warn('gear', k === 'MAG' ? tk('La perte d’Essence réduit la Magie de {n} ({value} effectif).') : tk('La perte d’Essence réduit la Résonance de {n} ({value} effectif).'), { n: lossFromEss, value: final[k] });
    }
  }

  // ---- Skills
  const [skillPoints, groupPoints] = SKILL_POINTS[P.skills] || [0, 0];
  const freeCfg = mrow?.skills || null;
  const freeGroupCfg = mrow?.group || null;
  const freeSkillIds = freeCfg ? data.magic.freeSkills.slice(0, freeCfg.n) : [];
  const freeGroupId = freeGroupCfg ? data.magic.freeGroup || '' : '';
  if (freeCfg) {
    if (freeSkillIds.length < freeCfg.n) warn('magic', fr(freeCfg.n, tk('Choisis ta compétence gratuite (indice {r}).'), tk('Choisis tes {n} compétences gratuites (indice {r}).')), { n: freeCfg.n, r: freeCfg.rating });
    for (const id of freeSkillIds) {
      const def = SKILL_BY_ID[id];
      const okCat = freeCfg.cat === 'active' ? def.cat !== 'magic' && def.cat !== 'resonance' : def.cat === freeCfg.cat;
      if (!okCat) err('magic', tk('{skill} ne peut pas être une compétence gratuite de ce type.'), { skill: SK(def) });
    }
    if (new Set(freeSkillIds).size !== freeSkillIds.length) err('magic', tk('Les compétences gratuites doivent être différentes.'));
  }
  if (freeGroupCfg) {
    if (!freeGroupId) warn('magic', tk('Choisis ton groupe de compétences magiques gratuit (indice {r}).'), { r: freeGroupCfg.rating });
    else if (freeGroupId !== aspectGroup(data.magic.aspect)) err('magic', tk('Le groupe gratuit doit être celui de ton aspect ({aspect}).'), { aspect: { t: ASPECTS[aspectGroup(data.magic.aspect)] } });
  }

  let skillSpent = 0;
  let groupSpent = 0;
  let skillKarma = 0;
  let specKarma = 0;
  let groupKarma = 0;
  const groupRating = {};
  for (const g of data.groups) {
    const free = g.id === freeGroupId ? freeGroupCfg.rating : 0;
    const rating = free + g.points + g.karma;
    groupSpent += g.points;
    groupKarma += karmaSteps(free + g.points, rating, 5);
    groupRating[g.id] = rating;
    if (rating > LIMITS.groupMax) err('skills', tk('Groupe {group} {rating} : maximum {max} à la création.'), { group: GRP(g.id), rating, max: LIMITS.groupMax });
    const members = SKILLS.filter((s) => s.group === g.id);
    if (members.some((s) => !skillAllowed(data, s.id))) err('skills', tk('Groupe {group} : inaccessible pour un {type}.'), { group: GRP(g.id), type: MT(mtype) });
  }
  if (freeGroupId && !groupRating[freeGroupId]) groupRating[freeGroupId] = freeGroupCfg.rating;
  const aptitude = qualityChoice(data, ctx, /^Aptitude$/);
  const skillRows = [];
  const seenSkills = new Set();
  const allSkillIds = new Set([...data.skills.map((s) => s.id), ...freeSkillIds]);
  for (const id of allSkillIds) {
    const s = data.skills.find((x) => x.id === id) || { id, points: 0, karma: 0, spec: '', specKarma: false };
    if (seenSkills.has(id)) continue;
    seenSkills.add(id);
    const def = SKILL_BY_ID[id];
    const free = freeSkillIds.includes(id) ? freeCfg.rating : 0;
    const grp = def.group && groupRating[def.group] ? groupRating[def.group] : 0;
    const base = Math.max(free, grp);
    const rating = base + s.points + s.karma;
    skillSpent += s.points;
    skillKarma += karmaSteps(base + s.points, rating, 2);
    if (s.spec) {
      if (s.specKarma) specKarma += 7;
      else skillSpent += 1;
    }
    const max = aptitude === id ? 7 : LIMITS.skillMax;
    if (rating > max) err('skills', aptitude === id ? tk('{skill} {rating} : maximum {max} à la création.') : tk('{skill} {rating} : maximum {max} à la création (7 avec la qualité Aptitude).'), { skill: SK(def), rating, max });
    if (grp && (s.points || s.karma || s.spec)) err('skills', tk('{skill} fait partie du groupe {group} : on ne peut pas l’augmenter ni la spécialiser séparément à la création.'), { skill: SK(def), group: GRP(def.group) });
    if (!skillAllowed(data, id)) err('skills', tk('{skill} : inaccessible pour un {type}.'), { skill: SK(def), type: MT(mtype) });
    if (s.spec && rating < 1) err('skills', tk('{skill} : une spécialisation demande au moins 1 point dans la compétence.'), { skill: SK(def) });
    if (rating > 0) skillRows.push({ id, name: def.fr, attr: def.attr, group: def.group || '', rating, spec: s.spec, free, fromGroup: grp });
  }
  // Group-only skills (bought through the group)
  for (const [gid, r] of Object.entries(groupRating)) {
    if (!(r > 0)) continue;
    for (const def of SKILLS.filter((x) => x.group === gid)) {
      if (seenSkills.has(def.id)) continue;
      skillRows.push({ id: def.id, name: def.fr, attr: def.attr, group: gid, rating: r, spec: '', free: 0, fromGroup: r });
    }
  }
  if (skillSpent > skillPoints) err('skills', tk('Points de compétences : {spent} dépensés pour {total} disponibles.'), { spent: skillSpent, total: skillPoints });
  if (groupSpent > groupPoints) err('skills', tk('Points de groupes : {spent} dépensés pour {total} disponibles.'), { spent: groupSpent, total: groupPoints });
  if (P.skills && skillSpent < skillPoints) {
    const n = skillPoints - skillSpent;
    warn('skills', fr(n, tk('{n} point de compétence non dépensé.'), tk('{n} points de compétences non dépensés.')), { n });
  }
  if (P.skills && groupSpent < groupPoints) {
    const n = groupPoints - groupSpent;
    warn('skills', fr(n, tk('{n} point de groupe non dépensé.'), tk('{n} points de groupes non dépensés.')), { n });
  }
  if (aptitude && !SKILL_BY_ID[aptitude]) warn('qualities', tk('Aptitude : choisis la compétence concernée.'));
  const topSkills = skillRows.filter((s) => s.rating >= 7);
  if (topSkills.length > 1) err('skills', tk('Une seule compétence peut atteindre 7 (Aptitude).'));

  // ---- Knowledge (free points = (INT + LOG) × 2, natural values)
  const knowledgePoints = (final.INT + final.LOG) * 2;
  let knowledgeSpent = 0;
  let knowledgeKarma = 0;
  let natives = 0;
  for (const k of data.knowledge) {
    if (!k.name.trim()) warn('contacts', tk('Une connaissance n’a pas de nom.'));
    if (k.native) {
      natives++;
      continue;
    }
    const r = k.points + k.karma;
    knowledgeSpent += k.points + (k.spec ? 1 : 0);
    knowledgeKarma += karmaSteps(k.points, r, 1);
    const kname = k.name || { t: tk('Connaissance') };
    if (r > LIMITS.knowledgeMax) err('contacts', tk('{name} {rating} : maximum {max} à la création.'), { name: kname, rating: r, max: LIMITS.knowledgeMax });
    if (r < 1) warn('contacts', tk('{name} : indice 0, elle sera ignorée.'), { name: kname });
  }
  const maxNatives = hasQualityEn(data, ctx, /^Bilingual$/) ? 2 : 1;
  if (!natives) warn('contacts', tk('Indique la langue maternelle du personnage (gratuite).'));
  if (natives > maxNatives) err('contacts', maxNatives === 2 ? tk('{n} langues maternelles : deux maximum avec Bilingue.') : tk('{n} langues maternelles : une seule (deux avec la qualité Bilingue).'), { n: natives });
  if (knowledgeSpent > knowledgePoints) err('contacts', tk('Points de connaissances : {spent} dépensés pour {total} disponibles (INT + LOG) × 2.'), { spent: knowledgeSpent, total: knowledgePoints });

  // ---- Qualities
  let positive = 0;
  let negative = 0;
  const qualityRows = [];
  const seenQ = new Set();
  for (const q of data.qualities) {
    const info = qualityData(ctx, q);
    if (!info) {
      if (ctx.lookup) err('qualities', tk('{name} : introuvable dans le catalogue.'), { name: q.name || { t: tk('Qualité') } });
      continue;
    }
    const qen = { name: info.en };
    if (MAGIC_QUALITY_NAMES.has(info.en)) {
      err('qualities', tk('{name} vient de la priorité Magie : ne l’achète pas comme qualité.'), { name: info.name }, qen);
      continue;
    }
    if (seenQ.has(q.catalogId)) err('qualities', tk('{name} est prise deux fois.'), { name: info.name }, qen);
    seenQ.add(q.catalogId);
    const level = Math.min(q.level, info.maxLevels);
    if (q.level > info.maxLevels) warn('qualities', tk('{name} : niveau ramené à {max}.'), { name: info.name, max: info.maxLevels }, qen);
    const cost = info.karma * level;
    if (info.positive) positive += cost;
    else negative += cost;
    qualityRows.push({ ...info, level, cost, choice: q.choice, notes: q.notes, catalogId: q.catalogId });
  }
  if (positive > LIMITS.positiveQualities) err('qualities', tk('Qualités positives : {n} karma (maximum {max}).'), { n: positive, max: LIMITS.positiveQualities });
  if (negative > LIMITS.negativeQualities) err('qualities', tk('Qualités négatives : {n} karma (maximum {max}).'), { n: negative, max: LIMITS.negativeQualities });
  if (qualityRows.some((q) => q.en === 'Exceptional Attribute' && !CORE_ATTRS.concat(['MAG', 'RES']).includes(q.choice))) warn('qualities', tk('Attribut exceptionnel : choisis l’attribut concerné.'));

  // ---- Spells / powers / complex forms
  const effMAG = awakened ? final.MAG : 0;
  const canCast = mtype === 'magician' || mtype === 'mystic' || (mtype === 'aspected' && aspectGroup(data.magic.aspect) === 'sorcery');
  const freeSpells = mrow?.spells || 0;
  const spellRows = [];
  for (const s of data.spells) {
    const e = lookup(s.catalogId);
    if (!e || e.file !== 'spells') {
      if (ctx.lookup) err('magic', tk('Sort « {name} » introuvable dans le catalogue.'), { name: s.name || '?' });
      continue;
    }
    spellRows.push({ catalogId: s.catalogId, item: e.item, name: e.item.nameFr || e.item.name, ...spellInfo(e.item) });
  }
  if (spellRows.length && !canCast) err('magic', tk('Un {type} ne peut pas lancer de sorts.'), { type: MT(mtype) });
  if (new Set(spellRows.map((s) => s.catalogId)).size !== spellRows.length) err('magic', tk('Un même sort est pris deux fois.'));
  const extraSpells = Math.max(0, spellRows.length - freeSpells);
  if (canCast && spellRows.length > effMAG * 2) err('magic', tk('{n} sorts : maximum Magie × 2 = {max} à la création.'), { n: spellRows.length, max: effMAG * 2 });
  if (canCast && spellRows.length < freeSpells) {
    const n = freeSpells - spellRows.length;
    warn('magic', fr(n, tk('{n} sort gratuit non choisi.'), tk('{n} sorts gratuits non choisis.')), { n });
  }

  const hasPowers = mtype === 'adept' || mtype === 'mystic';
  const ppTotal = mtype === 'adept' ? effMAG : mtype === 'mystic' ? data.magic.ppKarma : 0;
  if (mtype === 'mystic' && data.magic.ppKarma > effMAG) err('magic', tk('Points de pouvoir achetés ({n}) : maximum Magie ({max}).'), { n: data.magic.ppKarma, max: effMAG });
  if (mtype !== 'mystic' && data.magic.ppKarma) warn('magic', tk('Seuls les adeptes mystiques achètent des points de pouvoir.'));
  let ppSpent = 0;
  const powerRows = [];
  for (const p of data.powers) {
    const e = lookup(p.catalogId);
    if (!e || e.file !== 'powers') {
      if (ctx.lookup) err('magic', tk('Pouvoir « {name} » introuvable dans le catalogue.'), { name: p.name || '?' });
      continue;
    }
    const info = powerInfo(e.item);
    const maxLevel = info.levels ? Math.min(info.maxLevel || 99, Math.max(1, effMAG)) : 1;
    const level = info.levels ? Math.max(1, p.level) : 1;
    if (info.levels && level > maxLevel) err('magic', tk('{name} niveau {level} : maximum {max}.'), { name: e.item.nameFr || e.item.name, level, max: maxLevel }, { name: e.item.name });
    const pp = round2(info.pp * level + info.extraPP);
    ppSpent += pp;
    powerRows.push({ catalogId: p.catalogId, item: e.item, name: e.item.nameFr || e.item.name, level: info.levels ? level : undefined, pp, choice: p.choice });
  }
  ppSpent = round2(ppSpent);
  if (powerRows.length && !hasPowers) err('magic', tk('Un {type} n’a pas de pouvoirs d’adepte.'), { type: MT(mtype) });
  if (hasPowers && ppSpent > ppTotal) err('magic', tk('Pouvoirs : {spent} PP dépensés pour {total} disponibles.'), { spent: ppSpent, total: ppTotal });

  const freeForms = mrow?.forms || 0;
  const formRows = data.complexForms.map((f) => COMPLEX_FORM_BY_ID[f.formId]).filter(Boolean);
  if (formRows.length && !emerged) err('magic', tk('Seuls les technomanciens connaissent des formes complexes.'));
  if (new Set(formRows.map((f) => f.id)).size !== formRows.length) err('magic', tk('Une même forme complexe est prise deux fois.'));
  const extraForms = emerged ? Math.max(0, formRows.length - freeForms) : 0;
  if (emerged && formRows.length > final.LOG) err('magic', tk('{n} formes complexes : maximum Logique ({max}).'), { n: formRows.length, max: final.LOG });
  if (awakened && !data.magic.tradition && mtype !== 'adept') warn('magic', tk('Choisis une tradition magique.'));

  // ---- Contacts
  const contactKarmaFree = final.CHA * 3;
  const contactKarmaUsed = data.contacts.reduce((s, c) => s + c.connection + c.loyalty, 0);
  const contactOverflow = Math.max(0, contactKarmaUsed - contactKarmaFree);
  for (const c of data.contacts) if (!c.name.trim()) warn('contacts', tk('Un contact n’a pas de nom.'));

  // ---- Nuyen
  const resources = RESOURCES[P.resources] || 0;
  const fromKarma = data.karmaToNuyen * LIMITS.nuyenPerKarma;
  let lifestyleCost = 0;
  let lifestyle = null;
  if (data.lifestyle) {
    const e = lookup(data.lifestyle.catalogId);
    if (!e || e.file !== 'lifestyles') {
      if (ctx.lookup) err('gear', tk('Train de vie introuvable dans le catalogue.'));
    } else {
      const mult = LIFESTYLE_MULT[data.metatype] || 1;
      const monthly = Math.round((Number(e.item.cost) || 0) * mult);
      lifestyleCost = monthly * data.lifestyle.months;
      const st = e.item.stats || {};
      lifestyle = { item: e.item, name: e.item.nameFr || e.item.name, monthly, months: data.lifestyle.months, dice: Number(st.startingDice) || 0, multiplier: Number(st.startingMultiplier) || 0 };
    }
  } else warn('gear', tk('Choisis un train de vie (au moins un mois payé).'));
  const nuyenTotal = resources + fromKarma;
  const nuyenSpent = gearCost + lifestyleCost;
  const nuyenLeft = nuyenTotal - nuyenSpent;
  if (nuyenLeft < 0) err('gear', tk('Budget dépassé de {nuyen}¥.'), { nuyen: Math.abs(nuyenLeft) });
  const nuyenKept = Math.max(0, Math.min(LIMITS.keptNuyen, nuyenLeft));
  if (nuyenLeft > LIMITS.keptNuyen) warn('gear', tk('{nuyen}¥ seront perdus (5 000¥ maximum conservés).'), { nuyen: nuyenLeft - LIMITS.keptNuyen });

  // ---- Karma
  const karmaBase = LIMITS.karma + int(settings.startingKarmaBonus, 0, -100, 1000);
  const karmaTotal = karmaBase + negative;
  const karmaParts = {
    qualities: positive,
    attributes: attrKarma,
    skills: skillKarma,
    specializations: specKarma,
    groups: groupKarma,
    knowledge: knowledgeKarma,
    spells: extraSpells * 5,
    forms: extraForms * 4,
    powerPoints: mtype === 'mystic' ? data.magic.ppKarma * 5 : 0,
    contacts: contactOverflow,
    nuyen: data.karmaToNuyen,
  };
  const karmaSpent = Object.values(karmaParts).reduce((a, b) => a + b, 0);
  const karmaLeft = karmaTotal - karmaSpent;
  if (karmaLeft < 0) err('qualities', tk('Karma dépassé : {spent} dépensés pour {total} disponibles.'), { spent: karmaSpent, total: karmaTotal });
  if (karmaLeft > LIMITS.keptKarma) warn('summary', tk('{n} karma restants : seuls {kept} seront conservés.'), { n: karmaLeft, kept: LIMITS.keptKarma });
  if (data.karmaToNuyen > LIMITS.karmaToNuyenMax) err('gear', tk('Conversion karma → nuyen : {max} karma maximum.'), { max: LIMITS.karmaToNuyenMax });

  return {
    data,
    budgets: { attrPoints, specialPoints, skillPoints, groupPoints, knowledgePoints, contactKarma: contactKarmaFree, freeSpells, freeForms, powerPoints: ppTotal },
    spent: { attrPoints: attrPointsSpent, specialPoints: specialSpent, skillPoints: skillSpent, groupPoints: groupSpent, knowledgePoints: knowledgeSpent, contactKarma: contactKarmaUsed, spells: spellRows.length, forms: formRows.length, powerPoints: ppSpent },
    attrs,
    final,
    essence,
    essenceCost,
    magic: { type: mtype, row: mrow, awakened, emerged, canCast, hasPowers, freeSkillIds, freeGroupId, effMAG, lossFromEss },
    skills: skillRows.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name, 'fr')),
    groups: groupRating,
    qualities: qualityRows,
    spells: spellRows,
    powers: powerRows,
    forms: formRows,
    gearLines,
    lifestyle,
    karma: { base: karmaBase, negative, total: karmaTotal, parts: karmaParts, spent: karmaSpent, left: karmaLeft, kept: Math.max(0, Math.min(LIMITS.keptKarma, karmaLeft)) },
    nuyen: { resources, fromKarma, gear: gearCost, lifestyle: lifestyleCost, total: nuyenTotal, spent: nuyenSpent, left: nuyenLeft, kept: nuyenKept },
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

/** Errors / warnings grouped by step id (issue objects { text, key, params, en }). */
export function issuesByStep(result) {
  const out = {};
  for (const s of STEPS) out[s.id] = { errors: [], warnings: [] };
  for (const e of result?.errors || []) (out[e.step] || out.summary).errors.push(e);
  for (const w of result?.warnings || []) (out[w.step] || out.summary).warnings.push(w);
  return out;
}

/**
 * Text of a validation issue in a language. tr = the client's t() (French fill() by default), lang = 'fr'|'en',
 * fmtNumber formats nuyen params. A plain string (older data) is returned as-is.
 */
export function issueText(issue, i18n = {}) {
  if (!issue) return '';
  if (typeof issue === 'string') return issue;
  if (!issue.key) return issue.text || '';
  const tr = i18n.t || fill;
  const params = { ...(issue.params || {}), ...(i18n.lang === 'en' && issue.en ? issue.en : {}) };
  if (i18n.fmtNumber) for (const k of NUYEN_PARAMS) if (typeof params[k] === 'number') params[k] = i18n.fmtNumber(params[k]);
  return tr(issue.key, params);
}

// ---------------------------------------------------------------------------
// Actor building
// ---------------------------------------------------------------------------
function evalAt(rules, f, rating) {
  if (typeof f === 'number') return f;
  try {
    return Math.round(rules.evalFormula(f, { Rating: rating ?? 1 }));
  } catch {
    return 0;
  }
}

/** Same recording format as server/lib/augment.js applyBonus: returns what was applied ({ attributes, initiativeDice, initiative }). */
function applyBonusPure(actor, bonus, rating, rules) {
  if (!bonus || !rules.evalFormula) return undefined;
  const applied = {};
  for (const [k, f] of Object.entries(bonus.attributes || {})) {
    const v = evalAt(rules, f, rating);
    if (!v) continue;
    actor.augmented = actor.augmented || {};
    actor.augmented[k] = (Number(actor.augmented[k]) || 0) + v;
    if (!actor.augmented[k]) delete actor.augmented[k];
    (applied.attributes = applied.attributes || {})[k] = v;
  }
  if (bonus.initiativeDice) {
    const v = evalAt(rules, bonus.initiativeDice, rating);
    if (v) {
      actor.initiative = actor.initiative || { dice: 1, bonus: 0 };
      actor.initiative.dice = Math.max(1, Math.min(5, (Number(actor.initiative.dice) || 1) + v));
      applied.initiativeDice = v;
    }
  }
  if (bonus.initiative) {
    const v = evalAt(rules, bonus.initiative, rating);
    if (v) {
      actor.initiative = actor.initiative || { dice: 1, bonus: 0 };
      actor.initiative.bonus = (Number(actor.initiative.bonus) || 0) + v;
      applied.initiative = v;
    }
  }
  return Object.keys(applied).length ? applied : undefined;
}

/** Weapon accessory sub-item (same shape as the shop's): catalog entry from ctx.lookup(inc.id) when known. */
function accessoryFrom(makeId, ctx, inc, extra = {}, known = null) {
  const accItem = known || (inc.id && ctx.lookup ? ctx.lookup(inc.id)?.item : null);
  const a = { id: makeId('acc'), ...(accItem || inc.id ? { catalogId: accItem?.id || inc.id } : {}), name: accItem?.name || inc.name, mount: '', cost: 0, avail: accItem?.avail || '' };
  if (accItem?.nameFr) a.nameFr = accItem.nameFr;
  const effects = accItem && ctx.rules?.accessoryEffects ? ctx.rules.accessoryEffects(accItem) : {};
  if (Object.keys(effects).length) a.effects = effects;
  if (Array.isArray(accItem?.stats?.extraMount) && accItem.stats.extraMount.length) a.extraMount = [...accItem.stats.extraMount];
  return Object.assign(a, extra);
}

function weaponFrom(makeId, name, category, st, extra = {}) {
  return {
    id: makeId('wpn'),
    name,
    category: category || '',
    kind: st.type === 'melee' ? 'melee' : 'ranged',
    skill: st.skill || (st.type === 'melee' ? 'clubs' : 'pistols'),
    accuracy: st.accuracy ?? '',
    damage: st.damage || '',
    ap: st.ap ?? 0,
    mode: st.mode || '',
    rc: st.rc ?? 0,
    ammo: st.ammo || '',
    reach: st.reach || 0,
    ...extra,
  };
}

/**
 * Build an Actor (ARCHITECTURE.md schema, without `id`) from a draft. ctx as for compute(), plus:
 *   opts: { makeId(prefix), type: 'pc'|'npc', now, player }
 * Returns { actor, result } (result = compute()).
 */
export function buildActor(rawData, ctx = {}, opts = {}) {
  const result = compute(rawData, ctx);
  const data = result.data;
  const rules = ctx.rules || {};
  let n = 0;
  const makeId = opts.makeId || ((p) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`);
  const type = opts.type === 'npc' ? 'npc' : 'pc';
  const c = data.concept;
  const name = (c.alias || c.name || tk('Nouveau runner')).trim().slice(0, 80);
  const f = result.final;
  const actor = {
    type,
    name,
    metatype: data.metatype,
    concept: c.concept,
    color: c.color || (type === 'pc' ? '#3fd6d0' : '#e05c5c'),
    attributes: { BOD: f.BOD, AGI: f.AGI, REA: f.REA, STR: f.STR, WIL: f.WIL, LOG: f.LOG, INT: f.INT, CHA: f.CHA, EDG: f.EDG, ESS: 6 },
    condition: { physical: 0, stun: 0, overflow: 0 },
    edge: { current: f.EDG },
    initiative: { dice: 1, bonus: 0 },
    skills: [],
    skillGroups: [],
    knowledge: [],
    qualities: [],
    powers: [],
    spells: [],
    weapons: [],
    armor: [],
    augmentations: [],
    gear: [],
    vehicles: [],
    contacts: [],
    sins: [],
    karma: result.karma.kept,
    karmaTotal: result.karma.kept,
    nuyen: result.nuyen.kept,
    streetCred: 0,
    notoriety: 0,
    publicAwareness: 0,
    history: [],
  };
  if (c.alias && c.name && c.alias !== c.name) actor.realName = c.name.slice(0, 80);
  if (c.gender) actor.gender = c.gender;
  if (c.age) actor.age = /^\d+$/.test(c.age) ? Number(c.age) : c.age;
  if (c.portrait) actor.portrait = c.portrait;
  if (c.background) actor.bio = c.background;
  if (opts.player || c.player) actor.player = (opts.player || c.player).slice(0, 80);
  if (type === 'npc') actor.npc = { professionalRating: 0, grunt: false, tactics: '', loot: '' };
  const vis = METATYPES[data.metatype]?.vision || {};
  actor.vision = {};
  if (vis.lowLight) actor.vision.lowLight = true;
  if (vis.thermo) actor.vision.thermo = true;

  // Magic / resonance (natural value; essence loss applied below with the 'ware)
  const m = result.magic;
  if (m.awakened) actor.attributes.MAG = result.attrs.MAG.value;
  if (m.emerged) actor.attributes.RES = result.attrs.RES.value;

  // Skills: every rated skill materialized (group members too, so skillPool() works); intact groups listed.
  for (const s of result.skills) {
    const sk = { id: s.id, name: s.name, attr: s.attr, rating: s.rating };
    if (s.group) sk.group = s.group;
    if (s.spec) sk.spec = s.spec;
    actor.skills.push(sk);
  }
  for (const [gid, r] of Object.entries(result.groups)) if (r > 0) actor.skillGroups.push({ id: gid, rating: r });
  if (!actor.skillGroups.length) delete actor.skillGroups;

  for (const k of data.knowledge) {
    if (!k.name.trim()) continue;
    if (k.native) {
      actor.knowledge.push({ id: makeId('kn'), name: k.name.trim(), rating: 0, type: 'language', native: true });
      continue;
    }
    const r = k.points + k.karma;
    if (r < 1) continue;
    const kn = { id: makeId('kn'), name: k.name.trim(), rating: r, type: k.type };
    if (k.spec) kn.spec = k.spec;
    actor.knowledge.push(kn);
  }

  // Qualities: magic type + racial traits (0 karma), then the bought ones.
  const mq = MAGIC_TYPES[m.type]?.quality;
  if (mq) {
    const bits = [];
    if (data.magic.tradition && m.type !== 'adept') bits.push(`Tradition : ${data.magic.tradition}`);
    if (m.type === 'aspected') bits.push(`Aspect : ${ASPECTS[aspectGroup(data.magic.aspect)]}`);
    if (data.magic.mentor) bits.push(`Mentor : ${data.magic.mentor}`);
    actor.qualities.push({ id: makeId('q'), name: mq, karma: 0, positive: true, notes: [tk('Priorité Magie/Résonance'), ...bits].join(' — ') });
  }
  for (const t of METATYPE_TRAITS[data.metatype] || []) actor.qualities.push({ id: makeId('q'), name: t, karma: 0, positive: true, notes: fill(tk('Trait racial ({meta})'), { meta: data.metatype }) });
  for (const q of result.qualities) {
    const notes = [];
    if (q.choice) {
      const label = ATTR_LABELS[q.choice] || SKILL_BY_ID[q.choice]?.fr || q.choice;
      notes.push(label);
    }
    if (q.notes) notes.push(q.notes);
    const row = { id: makeId('q'), name: q.name + (q.maxLevels > 1 && q.level > 1 ? ` (${q.level})` : ''), karma: q.positive ? q.cost : -q.cost, positive: q.positive, catalogId: q.catalogId };
    if (notes.length) row.notes = notes.join(' — ');
    // Attribute / initiative bonus of the quality's catalog effects (Lightning Reflexes…), stored like server/lib/augment.js does.
    const qb = applyBonusPure(actor, bonusFromEffects(q.item?.effects, row), 1, rules);
    if (qb) row.bonus = qb;
    actor.qualities.push(row);
  }
  if (data.metatype === 'Troll') actor.armor.push({ id: makeId('arm'), name: tk('Armure dermique (troll)'), rating: 1, equipped: true, stack: true, notes: tk('Trait racial') });

  for (const s of result.spells) {
    const { item, catalogId, name: sname, ...rest } = s;
    actor.spells.push({ id: makeId('sp'), name: sname, ...rest, catalogId });
  }
  for (const p of result.powers) {
    const pw = { id: makeId('pw'), name: p.name, pp: p.pp, catalogId: p.catalogId };
    if (p.level) pw.level = p.level;
    if (p.choice) {
      pw.notes = p.choice;
      pw.choice = p.choice; // « select… » effects (Improved Physical Attribute, Improved Ability) — shared/modifiers.js
    }
    const bonus = (Array.isArray(p.item?.effects) ? bonusFromEffects(p.item.effects, pw) : null) || p.item?.stats?.bonus;
    if (bonus) {
      const applied = applyBonusPure(actor, bonus, p.level || 1, rules);
      if (applied) pw.bonus = applied;
    }
    actor.powers.push(pw);
  }
  if (m.type === 'mystic' && data.magic.ppKarma) actor.magic = { initiation: 0, submersion: 0, metamagics: [], echoes: [], extraPP: data.magic.ppKarma };
  if (result.forms.length) {
    actor.complexForms = result.forms.map((fm) => ({ id: makeId('cf'), name: fm.name, duration: fm.duration, fading: fm.fading, notes: `Cible : ${fm.target}` }));
  }

  // Gear (same item → actor mapping as the shop, server/modules/40-shop.js addLine)
  let device = null;
  const built = new Map(); // draft row id → first weapon / armor built from it (upgrade target)
  const DEVICE = rules.DEVICE_GEAR || new Set(['Commlinks', 'Cyberdecks', 'Rigger Command Consoles', 'Cyberterminals']);
  for (const line of result.gearLines) {
    if (!line.quote) continue;
    const { item, file, quote: q, qty } = line;
    const st = item.stats || {};
    const lname = line.name;
    const category = item.categoryFr || item.category || '';
    const listName = rules.targetList ? rules.targetList(file, item) : file === 'weapons' ? 'weapons' : 'gear';
    const base = { catalogId: item.id, paid: q.unitCost };
    if (listName === 'upgrade') continue; // installed below, once every weapon / armor exists
    if (listName === 'weapons') {
      for (let i = 0; i < qty; i++) {
        // Same as a shop purchase: mount points and the accessories delivered with the weapon.
        const w = weaponFrom(makeId, lname, category, st, base);
        if (Array.isArray(st.mounts)) w.mounts = [...st.mounts];
        const included = (st.included || []).map((inc) => accessoryFrom(makeId, ctx, inc, { mount: 'Internal', included: true, cost: 0 }));
        if (included.length) w.accessories = included;
        actor.weapons.push(w);
        if (!built.has(line.row.id)) built.set(line.row.id, w);
      }
    } else if (listName === 'armor') {
      for (let i = 0; i < qty; i++) {
        const ar = { id: makeId('arm'), name: lname, rating: evalAt(rules, st.armor ?? 0, q.rating), equipped: false, ...(st.stack ? { stack: true } : {}), ...(st.capacity !== undefined ? { capacity: evalAt(rules, st.capacity, q.rating) } : {}), ...base };
        actor.armor.push(ar);
        if (!built.has(line.row.id)) built.set(line.row.id, ar);
      }
    } else if (listName === 'augmentations') {
      for (let i = 0; i < qty; i++) {
        const aug = { id: makeId('aug'), name: lname, kind: st.kind || (file === 'bioware' ? 'bioware' : 'cyberware'), grade: q.grade || 'standard', essence: q.essence || 0, ...base };
        if (q.rating) aug.rating = q.rating;
        actor.attributes.ESS = round3(actor.attributes.ESS - aug.essence);
        const applied = applyBonusPure(actor, (Array.isArray(item.effects) ? bonusFromEffects(item.effects, aug) : null) || st.bonus, q.rating, rules);
        if (applied) aug.bonus = applied;
        if (st.weapon) actor.weapons.push(weaponFrom(makeId, lname, category, st.weapon, { augId: aug.id, catalogId: item.id }));
        actor.augmentations.push(aug);
      }
    } else if (listName === 'vehicles') {
      for (let i = 0; i < qty; i++) {
        actor.vehicles.push({
          id: makeId('veh'), name: lname, handling: st.handling ?? 0, speed: st.speed ?? 0, accel: st.accel ?? 0, body: st.body ?? 0,
          armor: st.armor ?? 0, pilot: st.pilot ?? 0, sensor: st.sensor ?? 0, seats: st.seats ?? undefined, notes: category || undefined, ...base,
        });
      }
    } else {
      const per = Number(st.costFor) || 1;
      const isDevice = DEVICE.has(item.category);
      const g = { id: makeId('gear'), name: lname, category, qty: qty * per, catalogId: item.id, paid: Math.round((q.unitCost / per) * 100) / 100 };
      if (q.rating) g.rating = q.rating;
      const same = !isDevice && actor.gear.find((x) => x.catalogId === item.id && (x.rating ?? null) === (g.rating ?? null));
      if (same) same.qty += g.qty;
      else actor.gear.push(g);
      if (isDevice && (st.deviceRating !== undefined || st.attributeArray)) {
        const rank = (item.category === 'Cyberdecks' ? 30 : item.category === 'Rigger Command Consoles' ? 20 : 10) + (Number(evalAt(rules, st.deviceRating ?? 0, q.rating)) || 0);
        if (!device || rank > device.rank) device = { rank, gear: g, st, q };
      }
      if (file === 'programs') (actor._programs = actor._programs || []).push(lname);
    }
  }
  // Weapon accessories / armor mods on their weapon / armor (fit already checked by compute())
  for (const line of result.gearLines) {
    if (!line.upgrade || !line.quote || !line.target || line.misfit) continue;
    const parent = built.get(line.target.rowId);
    const u = CREATION_UPGRADES[line.file];
    if (!parent || !u) continue;
    const { item, quote: q } = line;
    if (!Array.isArray(parent[u.sub])) parent[u.sub] = [];
    if (line.file === 'accessories') {
      parent.accessories.push(accessoryFrom(makeId, ctx, { id: item.id, name: item.name }, { mount: line.mount ?? '', cost: q.unitCost, paid: q.unitCost, ...(q.rating ? { rating: q.rating } : {}) }, item));
    } else {
      const m = { id: makeId('mod'), catalogId: item.id, name: item.name, capacity: line.capacity ?? 0, cost: q.unitCost, paid: q.unitCost, avail: item.avail || '' };
      if (item.nameFr) m.nameFr = item.nameFr;
      if (q.rating) m.rating = q.rating;
      if (item.stats?.armor) m.effects = { armor: Number(item.stats.armor) || 0 };
      if (item.stats?.bonus && Object.keys(item.stats.bonus).length) {
        m.bonus = {};
        for (const [k, v] of Object.entries(item.stats.bonus)) m.bonus[k] = typeof v === 'string' ? evalAt(rules, v, q.rating) : v;
      }
      parent.mods.push(m);
    }
  }
  // Essence loss → Magic / Resonance loss (1 per started point lost)
  const loss = Math.max(0, Math.ceil(6 - actor.attributes.ESS - 1e-9));
  if (loss) for (const k of ['MAG', 'RES']) if (actor.attributes[k] > 0) actor.attributes[k] = Math.max(0, actor.attributes[k] - loss);
  if (device) {
    const st = device.st;
    const arr = Array.isArray(st.attributeArray) ? st.attributeArray : null;
    const dr = evalAt(rules, st.deviceRating ?? 0, device.q.rating);
    actor.matrix = {
      device: device.gear.name,
      rating: dr,
      attack: arr ? arr[0] : st.attack ?? 0,
      sleaze: arr ? arr[1] : st.sleaze ?? 0,
      dataProcessing: arr ? arr[2] : st.dataProcessing ?? dr,
      firewall: arr ? arr[3] : st.firewall ?? dr,
      programs: actor._programs || [],
      gearId: device.gear.id,
    };
  }
  delete actor._programs;
  // Equip the best body armor and every stacking piece.
  const bodies = actor.armor.filter((a) => !a.stack);
  const best = bodies.reduce((b, a) => (!b || (Number(a.rating) || 0) > (Number(b.rating) || 0) ? a : b), null);
  for (const a of actor.armor) if (a.stack || a === best) a.equipped = true;

  if (result.lifestyle) {
    // Starting lifestyle → lifestyles[0] (see shared/lifestyle.js); the dwarf/troll surcharge is part of the base cost.
    const it = result.lifestyle.item || {};
    const base = /^Hospitalized/i.test(it.name || '') ? 'Hospitalized' : it.name || 'Medium';
    actor.lifestyles = [{
      id: makeId('ls'), name: result.lifestyle.name, base, ...(it.id ? { catalogId: it.id } : {}), baseCost: result.lifestyle.monthly, monthsPaid: result.lifestyle.months,
      primary: true, qualities: [], monthlyCost: result.lifestyle.monthly, notes: '',
    }];
  }
  for (const k of data.contacts) {
    if (!k.name.trim()) continue;
    const row = { id: makeId('ct'), name: k.name.trim(), connection: k.connection, loyalty: k.loyalty };
    if (k.notes) row.notes = k.notes;
    actor.contacts.push(row);
  }
  return { actor, result };
}

/**
 * Short one-line summary for lists: « Ork · Adepte · A/B/C/D/E ». French `name`/`text`; the UI rebuilds them
 * translated from `unnamed`, `metatype`, `magicType`, `concept` (headlineText() client-side).
 */
export function draftHeadline(data) {
  const d = normalizeDraft(data);
  const p = d.priorities;
  const letters = COLUMNS.map((k) => p[k] || '·').join('');
  const bits = [d.metatype];
  if (d.magic.type !== 'none') bits.push(MAGIC_TYPES[d.magic.type].label);
  if (d.concept.concept) bits.push(d.concept.concept);
  const own = (d.concept.alias || d.concept.name || '').trim();
  return {
    name: own || tk('Sans nom'), unnamed: !own, letters, text: bits.join(' · '),
    metatype: d.metatype, magicType: d.magic.type, concept: d.concept.concept,
  };
}
