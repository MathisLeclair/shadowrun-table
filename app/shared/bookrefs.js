// Rulebook references (📖 chips) of game rules and actor items. Pure data + helpers, shared by server and browser.
// Page numbers are PRINTED pages (ARCHITECTURE.md « Rulebooks »). Books are Chummer codes (SR5 = core rulebook).
// - SKILL_PAGES: active skill id (shared/sr5.js SKILLS) → SR5 page, from Chummer data/skills.xml <source>/<page>.
// - RULE_REFS: derived values and rules shown on the sheet / creator, checked against the SR5 text index (tools/books-setup.js).
// - ITEM_CATALOGS / SUB_CATALOGS: catalog files an actor list draws from (server/lib/bookrefs.js backfills item.source/page).
// - itemRef(item): { source, page } stored on an item (catalog / Chummer / Foundry), or null.

export const SKILL_PAGES = {
  archery: 130, automatics: 130, blades: 130, clubs: 131, exotic_weapon: 131, heavy_weapons: 132, longarms: 132, pistols: 132,
  throwing_weapons: 132, unarmed_combat: 132,
  disguise: 133, diving: 133, escape_artist: 133, free_fall: 133, gymnastics: 133, palming: 133, perception: 133, running: 133,
  sneaking: 133, survival: 133, swimming: 134, tracking: 134,
  con: 138, etiquette: 138, impersonation: 138, instruction: 138, intimidation: 139, leadership: 139, negotiation: 139, performance: 139,
  alchemy: 142, arcana: 142, artificing: 142, assensing: 142, astral_combat: 142, banishing: 142, binding: 142, counterspelling: 142,
  disenchanting: 142, ritual_spellcasting: 142, spellcasting: 143, summoning: 143,
  compiling: 143, decompiling: 143, registering: 143,
  aeronautics_mechanic: 143, animal_handling: 143, armorer: 143, artisan: 143, automotive_mechanic: 143, biotechnology: 144,
  chemistry: 144, computer: 144, cybercombat: 144, cybertechnology: 144, demolitions: 144, electronic_warfare: 144, first_aid: 144,
  forgery: 144, hacking: 145, hardware: 145, industrial_mechanic: 145, locksmith: 145, medicine: 145, nautical_mechanic: 145,
  navigation: 145, software: 145,
  gunnery: 146, pilot_aerospace: 146, pilot_aircraft: 147, pilot_walker: 147, pilot_ground_craft: 147, pilot_watercraft: 147,
};

/** SR5 core complex forms (Chummer complexforms.xml), by shared/chargen.js COMPLEX_FORMS id and English name. */
export const COMPLEX_FORM_PAGES = {
  cleaner: 252, diffusion: 252, editor: 252, infusion: 252, pulse_storm: 252, puppeteer: 252, resonance_channel: 252, static_veil: 252,
  resonance_spike: 253, resonance_veil: 253, static_bomb: 253, stitches: 253, tattletale: 253, transcendent_grid: 253,
};
const COMPLEX_FORM_NAMES = {
  cleaner: 'cleaner', 'diffusion of': 'diffusion', editor: 'editor', 'infusion of': 'infusion', 'pulse storm': 'pulse_storm', puppeteer: 'puppeteer',
  'resonance channel': 'resonance_channel', 'resonance spike': 'resonance_spike', 'resonance veil': 'resonance_veil', 'static bomb': 'static_bomb',
  'static veil': 'static_veil', stitches: 'stitches', tattletale: 'tattletale', 'transcendent grid': 'transcendent_grid',
  // French names of shared/chargen.js COMPLEX_FORMS
  nettoyeur: 'cleaner', 'diffusion de': 'diffusion', éditeur: 'editor', 'infusion de': 'infusion', 'tempête d’impulsions': 'pulse_storm',
  marionnettiste: 'puppeteer', 'canal de résonance': 'resonance_channel', 'pic de résonance': 'resonance_spike', 'voile de résonance': 'resonance_veil',
  'bombe statique': 'static_bomb', 'voile statique': 'static_veil', 'points de suture': 'stitches', mouchard: 'tattletale', 'grille transcendante': 'transcendent_grid',
};

const ref = (source, page) => ({ source, page });
/** Rules of the sheet, the creator and the dice (printed pages checked in the SR5 text). */
export const RULE_REFS = {
  limits: ref('SR5', 46), // TESTS AND LIMITS (inherent limits p. 47, formulas p. 101)
  derived: ref('SR5', 101), // FINAL CALCULATIONS TABLE: initiative, limits, condition monitors
  initiative: ref('SR5', 159), // INITIATIVE
  matrixInitiative: ref('SR5', 231), // USER MODES TABLE
  conditionMonitor: ref('SR5', 169), // condition monitor boxes + WOUND MODIFIERS
  woundModifiers: ref('SR5', 169),
  armor: ref('SR5', 169), // ARMOR AND ENCUMBRANCE
  defense: ref('SR5', 188), // DEFENDING IN COMBAT
  soak: ref('SR5', 173), // COMBAT SEQUENCE: defend, then resist the damage (Body + Armor)
  attributeTests: ref('SR5', 152), // USING ATTRIBUTES: composure, judge intentions, memory, lift / carry
  movement: ref('SR5', 161), // MOVEMENT
  edge: ref('SR5', 56), // EDGE effects
  drain: ref('SR5', 282), // RESIST DRAIN
  powerPoints: ref('SR5', 278), // POWER POINTS
  adeptPowers: ref('SR5', 308), // ADEPT POWERS
  spellcasting: ref('SR5', 281), // SPELLCASTING
  complexForms: ref('SR5', 252), // COMPLEX FORMS
  matrixDamage: ref('SR5', 228), // MATRIX DAMAGE
  biofeedback: ref('SR5', 229), // BIOFEEDBACK DAMAGE
  matrixActions: ref('SR5', 237), // MATRIX ACTIONS
  programs: ref('SR5', 245), // PROGRAMS (common + hacking)
  ic: ref('SR5', 248), // INTRUSION COUNTERMEASURES
  overwatch: ref('SR5', 231), // OVERWATCH SCORE AND CONVERGENCE
  hosts: ref('SR5', 246), // HOSTS
  knowledgeSkills: ref('SR5', 147), // KNOWLEDGE SKILLS
  skillGroups: ref('SR5', 129), // SKILL GROUPS, SPECIALIZATIONS
  specializations: ref('SR5', 129),
  qualities: ref('SR5', 71), // QUALITIES (character creation)
  lifestyles: ref('SR5', 369), // LIFESTYLES
  fakeSin: ref('SR5', 364), // CHECKING A FAKE SIN (Fake SIN Details p. 363, SIN Verification Details p. 364)
  martialArts: ref('RG', 128), // MARTIAL ARTS (Run & Gun)
  priorityTable: ref('SR5', 65), // PRIORITY TABLE
  metatypes: ref('SR5', 66), // METATYPE ATTRIBUTE TABLE
  karmaAdvancement: ref('SR5', 103), // CHARACTER ADVANCEMENT (karma costs, training times)
  initiation: ref('SR5', 324), // INITIATION, metamagics
  submersion: ref('SR5', 257), // SUBMERSION, echoes
};

/** Character creator steps (shared/chargen.js STEPS) → SR5 « Creating a shadowrunner » pages. */
export const CHARGEN_STEP_REFS = {
  concept: ref('SR5', 62), priorities: ref('SR5', 65), metatype: ref('SR5', 65), attributes: ref('SR5', 66), magic: ref('SR5', 68),
  skills: ref('SR5', 88), qualities: ref('SR5', 71), gear: ref('SR5', 94), contacts: ref('SR5', 98), summary: ref('SR5', 100),
};

/** { source: 'SR5', page } of an active skill id, or null (custom skills, knowledge skills). */
export function skillRef(id) {
  const p = SKILL_PAGES[String(id || '')];
  return p ? ref('SR5', p) : null;
}

/** { source, page } of a rule key of RULE_REFS, or null. */
export const ruleRef = (key) => RULE_REFS[key] || null;

/** Complex form → SR5 page (by chargen id, English or French name). */
export function complexFormRef(form) {
  if (!form) return null;
  const direct = COMPLEX_FORM_PAGES[form.formId || form.id];
  if (direct) return ref('SR5', direct);
  const n = String(form.name || form.en || '').toLowerCase().replace(/[’']/g, '’').replace(/\s*[[(].*$/, '').trim();
  const key = COMPLEX_FORM_NAMES[n] || COMPLEX_FORM_NAMES[n.replace(/’/g, "'")] ||
    // « Diffusion of Firewall », « Infusion de Corruption »: the prefix names the form
    Object.entries(COMPLEX_FORM_NAMES).find(([k]) => / (of|de)$/.test(k) && n.startsWith(`${k} `))?.[1];
  return key ? ref('SR5', COMPLEX_FORM_PAGES[key]) : null;
}

/** Catalog files each actor list draws from (data/catalog/<file>.json). Nested lists: SUB_CATALOGS[`${list}.${sub}`]. */
export const ITEM_CATALOGS = {
  weapons: ['weapons', 'gear', 'armor'], armor: ['armor'], augmentations: ['cyberware', 'bioware'], gear: ['gear', 'programs'], vehicles: ['vehicles'],
  qualities: ['qualities'], powers: ['powers'], spells: ['spells'], lifestyles: ['lifestyles'], martialArts: ['martialarts'], sins: ['gear'],
};
export const SUB_CATALOGS = {
  'weapons.accessories': ['accessories'], 'armor.mods': ['armormods'], 'vehicles.mods': ['vehiclemods'], 'lifestyles.qualities': ['lifestylequalities'],
  'martialArts.techniques': ['techniques'], // inside martialarts.json entries (stats.techniques)
};
/** Lists whose items may carry a rulebook reference (contacts / knowledge / skills: no). */
export const REF_LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'qualities', 'powers', 'spells', 'complexForms', 'lifestyles', 'martialArts'];

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
/**
 * Parse a « book page » text: 'SR5 435', 'SR5 p. 435', 'SR5 p.435', 'RG:62', 'SR5 435, RG 12' (first one).
 * A separator is required between the code and the page (« GH3 » is a code). Returns { source, page } or null.
 */
export function parseRefText(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,11})(?:\s+|\s*[:,]\s*|\s*(?=p))(?:p(?:age|g)?\.?\s*)?(\d{1,4})\b/i);
  if (m) {
    const page = parseInt(m[2], 10);
    return page > 0 ? ref(m[1].toUpperCase(), page) : null;
  }
  return null;
}

/** Normalize a stored { source, page } pair: code upper-case, page > 0 (else page null). Accepts « SR5 435 » in `source`. */
export function normRef(source, page) {
  const code = String(source ?? '').trim();
  if (!code) return null;
  const n = parseInt(String(page ?? '').replace(/^p\.?\s*/i, ''), 10);
  if (CODE_RE.test(code.toUpperCase()) && !/\s/.test(code)) return ref(code.toUpperCase(), n > 0 ? n : null); // page unknown (Chummer « 0 ») → the book
  return parseRefText(code);
}

/** Reference stored on an actor item: { source, page } or null. */
export function itemRef(item) {
  if (!item || typeof item !== 'object') return null;
  return normRef(item.source, item.page);
}

/**
 * Reference written in an item's notes by the imports (« Low-Light Vision · SR5 66 », « SR5 p.66 — … »): the last
 * « CODE page » segment that names a book of `knownCodes` (a Set; any code when absent). Returns { source, page } or null.
 */
export function refFromNotes(notes, knownCodes) {
  const parts = String(notes || '').split(/\s*(?:·|—|\n)\s*/).reverse();
  for (const p of parts) {
    // Book codes are upper-case (SR5, RG, CF…): « Indice 4 », « Contact 3 » are not references.
    const r = /^[A-Z0-9][A-Z0-9-]{0,11}\s+(?:p\.?\s*)?\d{1,4}$/.test(p.trim()) ? parseRefText(p) : null;
    if (r && (!knownCodes || knownCodes.has(r.source))) return r;
  }
  return null;
}
