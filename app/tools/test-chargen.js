// Character creation test: node tools/test-chargen.js  (pure rules + isolated server on port 3711 or SR_TEST_PORT, exit code != 0 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rules from '../client/modules/shop/rules.js';
import {
  compute, buildActor, normalizeDraft, emptyDraft, magicOptions, karmaSteps, attrLimits,
  METATYPE_PRIORITY, ATTRIBUTE_POINTS, SKILL_POINTS, RESOURCES, MAGIC_TABLE,
  issueText, priorityText, magicOptionText, draftHeadline, COLUMNS, LETTERS, STEPS, MAGIC_TYPES, COLUMN_LABELS,
  KNOWLEDGE_TYPES, TRADITIONS, ASPECTS, METATYPE_TRAITS, FORM_TARGETS,
} from '../shared/chargen.js';
import { TIERS, ARCHETYPES, GRUNT_RULES } from '../shared/npcgen.js';
import { interpolate, stripContext } from '../client/i18n/format.js';
import { derive, skillPool } from '../shared/sr5.js';
import { startServer, login, client, settle } from './test-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SR_TEST_PORT) || 3711;

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗', msg);
  }
}
async function rejects(promise, re, msg) {
  try {
    await promise;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(re.test(e.message), `${msg} — got: ${e.message}`);
  }
}
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Catalog context (same shape the server builds)
// ---------------------------------------------------------------------------
const INDEX = new Map();
for (const f of ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'programs', 'lifestyles', 'qualities', 'spells', 'powers']) {
  for (const it of JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', `${f}.json`), 'utf8'))) INDEX.set(it.id, { item: it, file: f });
}
const id = (file, name) => {
  for (const e of INDEX.values()) if (e.file === file && e.item.name === name) return e.item.id;
  throw new Error(`catalog item not found: ${file}/${name}`);
};
const ctx = { lookup: (x) => INDEX.get(x) || null, rules, settings: {} };
const errorsOf = (d) => compute(d, ctx).errors.map((e) => e.text);
const hasError = (d, re) => errorsOf(d).some((t) => re.test(t));

// A legal street samurai: Ork, Metatype C / Attributes A / Magic E / Skills B / Resources D.
const legal = {
  concept: { name: 'Marc Delorme', alias: 'Rouille', concept: 'Samouraï des rues', background: 'Ancien ganger.' },
  priorities: { metatype: 'C', attributes: 'A', magic: 'E', skills: 'B', resources: 'D' },
  metatype: 'Ork',
  attributes: { BOD: 3, AGI: 5, REA: 4, STR: 2, WIL: 2, LOG: 2, INT: 4, CHA: 2, EDG: 0 },
  skills: [
    { id: 'automatics', points: 6 }, { id: 'pistols', points: 5, spec: 'Semi-automatiques' }, { id: 'perception', points: 4 },
    { id: 'sneaking', points: 4 }, { id: 'unarmed_combat', points: 4 }, { id: 'blades', points: 4 }, { id: 'running', points: 3 },
    { id: 'intimidation', points: 3 }, { id: 'first_aid', points: 2 },
  ],
  groups: [{ id: 'influence', points: 2 }, { id: 'electronics', points: 3 }],
  knowledge: [
    { name: 'Français', native: true }, { name: 'Gangs de Seattle', type: 'street', points: 4 },
    { name: 'Armes', type: 'professional', points: 4 }, { name: 'Anglais', type: 'language', points: 4 },
  ],
  qualities: [{ catalogId: id('qualities', 'Toughness') }, { catalogId: id('qualities', 'Distinctive Style') }],
  gear: [
    { ref: id('weapons', 'Ares Predator V'), file: 'weapons', qty: 1 },
    { ref: id('armor', 'Armor Jacket'), file: 'armor', qty: 1 },
    { ref: id('cyberware', 'Wired Reflexes'), file: 'cyberware', qty: 1, rating: 1, grade: 'standard' },
    { ref: id('gear', 'Ammo: Regular Ammo'), file: 'gear', qty: 2 },
  ],
  lifestyle: { catalogId: id('lifestyles', 'Low'), months: 1 },
  contacts: [{ name: 'Perrine Cabana', connection: 4, loyalty: 2 }, { name: 'Doc Hutch', connection: 2, loyalty: 2 }],
  rollStartingNuyen: true,
};

// A legal adept (Elf, Magic B adept) to exercise powers / free skill.
const adept = {
  concept: { alias: 'Lame', concept: 'Adepte au sabre' },
  priorities: { metatype: 'D', attributes: 'B', magic: 'A', skills: 'C', resources: 'E' },
  metatype: 'Elfe',
  magic: { type: 'magician', tradition: 'Hermétique', freeSkills: ['spellcasting', 'summoning'] },
  attributes: { BOD: 2, AGI: 3, REA: 3, STR: 1, WIL: 4, LOG: 4, INT: 2, CHA: 1, EDG: 0, MAG: 0 },
  skills: [{ id: 'counterspelling', points: 4 }, { id: 'perception', points: 3 }, { id: 'pistols', points: 3 }, { id: 'assensing', points: 4 }, { id: 'arcana', points: 3 }, { id: 'sneaking', points: 3 }, { id: 'etiquette', points: 3 }, { id: 'spellcasting', points: 1 }, { id: 'banishing', points: 4 }],
  knowledge: [{ name: 'Sperethiel', native: true }, { name: 'Théorie magique', type: 'academic', points: 4 }],
  spells: ['Stunbolt', 'Manabolt', 'Armor', 'Heal', 'Detect Enemies', 'Physical Barrier', 'Invisibility', 'Levitate', 'Fireball', 'Increase Reflexes'].map((n) => ({ catalogId: id('spells', n) })),
  gear: [{ ref: id('weapons', 'Ares Light Fire 70'), file: 'weapons', qty: 1 }, { ref: id('armor', 'Armor Clothing'), file: 'armor', qty: 1 }],
  lifestyle: { catalogId: id('lifestyles', 'Squatter'), months: 1 },
  contacts: [{ name: 'Mentor', connection: 2, loyalty: 3 }],
};

// ---------------------------------------------------------------------------
// i18n: English dictionaries (glossary first, like the browser) and a strict English t() that marks missing keys
// ---------------------------------------------------------------------------
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'en');
const EN = {};
for (const f of fs.readdirSync(DICT_DIR).filter((x) => x.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)))) {
  Object.assign(EN, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
}
const enT = (key, params) => (EN[key] ? interpolate(EN[key], params, enT) : `⟦${stripContext(key)}⟧`);
const enI18n = { t: enT, lang: 'en', fmtNumber: (n) => Number(n).toLocaleString('en-US') };
/** Every key of a message, nested params included. */
function msgKeys(m, out = []) {
  if (!m || typeof m !== 'object') return out;
  const k = m.t || m.key || m.errorKey;
  if (typeof k === 'string') out.push(k);
  for (const v of Object.values(m.params || {})) (Array.isArray(v) ? v : [v]).forEach((x) => msgKeys(x, out));
  return out;
}

function i18nTests() {
  console.log('• i18n');
  const vocab = [
    ...STEPS.map((s) => s.label), ...Object.values(COLUMN_LABELS), ...Object.values(MAGIC_TYPES).flatMap((m) => [m.label, m.short, m.quality].filter(Boolean)),
    ...Object.values(KNOWLEDGE_TYPES), ...TRADITIONS, ...Object.values(ASPECTS), ...Object.values(METATYPE_TRAITS).flat(), ...FORM_TARGETS,
    ...TIERS.flatMap((x) => [x.label, x.text]), ...ARCHETYPES.flatMap((a) => [a.label, a.blurb]), GRUNT_RULES,
  ];
  const missVocab = [...new Set(vocab.filter((k) => !EN[k]))];
  ok(!missVocab.length, `creation / generator vocabulary translated (missing: ${missVocab.join(' | ')})`);

  // Validation issues of many broken drafts: every key (and nested key) has an English entry.
  const broken = [];
  const b1 = clone(legal);
  b1.concept = {};
  b1.priorities = { metatype: 'A', attributes: 'A', magic: '', skills: 'B', resources: 'E' };
  b1.metatype = 'Troll';
  b1.attributes = { BOD: 9, AGI: 9, REA: 9, STR: 9, WIL: 9, LOG: 9, INT: 9, CHA: 9, EDG: 9, MAG: 2 };
  b1.skills.push({ id: 'spellcasting', points: 3 }, { id: 'pistols', points: 9, spec: 'x' }, { id: 'hacking', points: 1 });
  b1.groups = [{ id: 'sorcery', points: 9 }, { id: 'firearms', points: 2 }];
  b1.knowledge = [{ name: '', points: 9 }, { name: 'A', native: true }, { name: 'B', native: true }, { name: 'C', points: 0 }];
  b1.contacts = [{ name: '', connection: 3, loyalty: 3 }];
  b1.gear.push({ ref: 'nope', file: 'gear', name: 'Truc' }, { ref: 'nope2', file: 'gear' });
  b1.gear.push({ ref: id('cyberware', 'Wired Reflexes'), file: 'cyberware', qty: 1, rating: 3, grade: 'delta' });
  b1.qualities.push({ catalogId: id('qualities', 'Toughness') }, { catalogId: id('qualities', 'Magician') }, { catalogId: 'nope' }, { catalogId: id('qualities', 'Aptitude') }, { catalogId: id('qualities', 'Exceptional Attribute') });
  b1.spells = [{ catalogId: id('spells', 'Stunbolt') }, { catalogId: 'zz', name: 'Bidon' }];
  b1.powers = [{ catalogId: id('powers', 'Improved Reflexes'), level: 9 }, { catalogId: 'zz' }];
  b1.complexForms = [{ formId: 'cleaner' }, { formId: 'cleaner' }];
  b1.lifestyle = null;
  b1.karmaToNuyen = 12;
  broken.push(b1);
  const b2 = clone(adept);
  b2.magic = { type: 'aspected', aspect: 'conjuring', freeGroup: 'sorcery', ppKarma: 3 };
  b2.priorities.magic = 'B';
  b2.lifestyle = { catalogId: 'zz', months: 1 };
  b2.gear = [{ ref: id('cyberware', 'Wired Reflexes'), file: 'cyberware', qty: 1, rating: 3, grade: 'standard' }, { ref: id('cyberware', 'Cybereyes Basic System'), file: 'cyberware', qty: 6, rating: 4 }];
  broken.push(b2);
  const b3 = clone(adept);
  b3.magic = { type: 'technomancer', freeSkills: ['compiling', 'pistols'] };
  b3.complexForms = Array.from({ length: 9 }, (_, i) => ({ formId: ['cleaner', 'editor', 'puppeteer', 'stitches', 'tattletale', 'static_bomb', 'static_veil', 'pulse_storm', 'resonance_spike'][i] }));
  b3.attributes.RES = 2;
  broken.push(b3, clone(legal), clone(adept), emptyDraft());
  const keys = [];
  let count = 0;
  let rendered = [];
  for (const d of broken) {
    const r = compute(d, ctx);
    for (const i of [...r.errors, ...r.warnings]) {
      count++;
      ok(typeof i.key === 'string' && i.text === issueText(i), `issue has a key and its French text: ${i.text}`);
      keys.push(...msgKeys(i));
      rendered.push(issueText(i, enI18n));
    }
  }
  const miss = [...new Set(keys.filter((k) => !EN[k]))];
  ok(count > 40 && !miss.length, `validation messages translated (${count} issues, missing: ${miss.join(' | ')})`);
  const leftovers = rendered.filter((s) => /⟦/.test(s));
  ok(!leftovers.length, `English issues fully rendered (${leftovers.slice(0, 3).join(' / ')})`);
  ok(rendered.includes('Priority “Magic / Resonance” not assigned.'), 'nested column label translated');
  const budget = compute({ ...clone(legal), priorities: { ...legal.priorities, resources: 'E' } }, ctx).errors.find((e) => e.key === 'Budget dépassé de {nuyen}¥.');
  ok(budget && /^Budget dépassé de \d{1,3}( \d{3})*¥\.$/.test(budget.text) && /^Budget exceeded by \d{1,3}(,\d{3})*¥\.$/.test(issueText(budget, enI18n)), `nuyen amounts formatted per language (${budget?.text} / ${budget && issueText(budget, enI18n)})`);
  const skillIssue = compute({ ...clone(legal), skills: [{ id: 'pistols', points: 9 }] }, ctx).errors.find((e) => e.params?.skill);
  ok(skillIssue && issueText(skillIssue, enI18n).startsWith('Pistols 9'), `skill names translated in issues (${skillIssue && issueText(skillIssue, enI18n)})`);

  // Display helpers
  const texts = [];
  for (const c of COLUMNS) for (const l of LETTERS) texts.push(priorityText(c, l, enI18n));
  for (const l of LETTERS) for (const o of magicOptions(l)) texts.push(magicOptionText(o, enI18n));
  ok(texts.every((s) => !/⟦/.test(s)) && texts.includes('450,000¥') && texts.some((s) => s.startsWith('Magician: Magic 6, 2 magical skills at 5, 10 spells')), `priority table in English (${texts.filter((s) => /⟦/.test(s)).slice(0, 2).join(' / ')})`);
  ok(priorityText('resources', 'A') === '450 000¥' && priorityText('magic', 'E') === 'Profane', 'priority table still French by default');
  const h = draftHeadline({});
  ok(h.unnamed && h.name === 'Sans nom' && EN[h.name], 'unnamed draft headline is a translatable key');
  let dupOk = true;
  try {
    const r = compute({ ...clone(legal), skills: [{ id: 'pistols', points: 2 }, { id: 'pistols', points: 3 }], groups: [{ id: 'firearms', points: 1 }, { id: 'firearms', points: 2 }] }, ctx);
    dupOk = r.data.skills.length === 1 && r.data.groups.length === 1;
  } catch {
    dupOk = false;
  }
  ok(dupOk, 'duplicate skill / group rows are dropped instead of crashing compute()');
}

function unitTests() {
  console.log('• priority tables');
  ok(METATYPE_PRIORITY.A.Troll === 5 && METATYPE_PRIORITY.B.Troll === 0 && METATYPE_PRIORITY.C.Troll === undefined, 'troll available A (5) / B (0) only');
  ok(METATYPE_PRIORITY.D.Elfe === 0 && METATYPE_PRIORITY.E.Elfe === undefined && METATYPE_PRIORITY.E.Humain === 1, 'elf down to D, human only at E');
  ok(METATYPE_PRIORITY.C.Nain === 1 && METATYPE_PRIORITY.C.Ork === 0 && METATYPE_PRIORITY.A.Nain === 7, 'dwarf / ork special points');
  ok([24, 20, 16, 14, 12].every((n, i) => ATTRIBUTE_POINTS['ABCDE'[i]] === n), 'attribute points 24/20/16/14/12');
  ok(SKILL_POINTS.A[0] === 46 && SKILL_POINTS.A[1] === 10 && SKILL_POINTS.C[1] === 2 && SKILL_POINTS.E[0] === 18, 'skill points 46/10 … 18/0');
  ok(RESOURCES.A === 450000 && RESOURCES.E === 6000, 'resources 450k … 6k');
  ok(MAGIC_TABLE.A.magician.MAG === 6 && MAGIC_TABLE.A.magician.spells === 10 && MAGIC_TABLE.B.adept.MAG === 6 && MAGIC_TABLE.B.aspected.MAG === 5, 'magic column A/B');
  ok(MAGIC_TABLE.A.technomancer.RES === 6 && MAGIC_TABLE.A.technomancer.forms === 5 && MAGIC_TABLE.C.technomancer.RES === 3, 'resonance column');
  ok(magicOptions('E').length === 1 && magicOptions('D').map((o) => o.type).join() === 'none,adept,aspected', 'magic options per letter');
  ok(karmaSteps(3, 5, 5) === 45 && karmaSteps(0, 2, 2) === 6, 'karma steps (attribute ×5, skill ×2)');

  console.log('• legal builds');
  const r = compute(legal, ctx);
  ok(r.ok, `legal samurai has no error: ${r.errors.map((e) => e.text).join(' | ')}`);
  ok(r.budgets.attrPoints === 24 && r.spent.attrPoints === 24, 'attribute points spent 24/24');
  ok(r.budgets.specialPoints === 0, 'ork at C: 0 special points');
  ok(r.budgets.skillPoints === 36 && r.spent.skillPoints === 36 && r.spent.groupPoints === 5, 'skill points 36 + 5 groups');
  ok(r.budgets.knowledgePoints === (r.final.INT + r.final.LOG) * 2, 'knowledge points (INT+LOG)×2');
  ok(r.final.BOD === 7 && r.final.AGI === 6, 'final attributes from metatype minimum + points');
  ok(r.essence === 4, `essence after Wired Reflexes 1: ${r.essence}`);
  ok(r.karma.total === 30 && r.karma.parts.qualities === 9 && r.karma.parts.contacts === 1, `karma: 25 + 5 negative, 9 positive, 1 over the free contact karma (${JSON.stringify(r.karma.parts)})`);
  ok(r.karma.kept === 7 && r.warnings.some((w) => /seuls 7/.test(w.text)), 'only 7 karma kept (warning)');
  ok(r.nuyen.total === 50000 && r.nuyen.left === 50000 - r.nuyen.spent && r.nuyen.kept === 5000, 'nuyen budget and 5 000¥ carry-over');
  const ra = compute(adept, ctx);
  ok(ra.ok, `legal magician has no error: ${ra.errors.map((e) => e.text).join(' | ')}`);
  ok(ra.attrs.MAG.value === 6 && ra.budgets.freeSpells === 10, 'magician A: MAG 6, 10 free spells');
  ok(ra.skills.find((s) => s.id === 'summoning')?.rating === 5 && ra.skills.find((s) => s.id === 'spellcasting')?.rating === 6, 'free magical skills at 5 (+1 point)');

  console.log('• illegal builds');
  let d = clone(legal);
  d.priorities.skills = 'A';
  ok(hasError(d, /priorité A est utilisée plusieurs fois/), 'duplicate priority letter');
  d = clone(legal);
  d.metatype = 'Troll';
  ok(hasError(d, /Troll n’est pas disponible/), 'troll at metatype priority C');
  d = clone(legal);
  d.attributes.STR = 7;
  ok(hasError(d, /Force .* dépasse le maximum/) && hasError(d, /Points d’attributs : 29/), 'attribute over max and over budget');
  d = clone(legal);
  d.attributes.BOD = 5;
  d.attributes.AGI = 5;
  d.attributes.REA = 2;
  d.attributes.WIL = 2;
  ok(hasError(d, /Un seul attribut/), 'two attributes at natural maximum');
  d = clone(legal);
  d.skills[0].points = 7;
  ok(hasError(d, /maximum 6 à la création/), 'skill above 6 without Aptitude');
  d.qualities.push({ catalogId: id('qualities', 'Aptitude'), choice: 'automatics' });
  ok(!hasError(d, /Armes automatiques 7 : maximum/), 'Aptitude allows 7 in the chosen skill');
  d = clone(legal);
  d.skills.push({ id: 'longarms', points: 4 });
  ok(hasError(d, /Points de compétences : 40 dépensés pour 36/), 'skill points over budget');
  d = clone(legal);
  d.skills.push({ id: 'computer', points: 1 });
  ok(hasError(d, /fait partie du groupe Électronique/), 'raising a grouped skill separately');
  d = clone(legal);
  d.qualities.push({ catalogId: id('qualities', 'Exceptional Attribute'), choice: 'AGI' }, { catalogId: id('qualities', 'Lucky') });
  ok(hasError(d, /Qualités positives : 35 karma \(maximum 25\)/), 'positive qualities above 25');
  d = clone(legal);
  d.qualities.push({ catalogId: id('qualities', 'Magician') });
  ok(hasError(d, /vient de la priorité Magie/), 'magic quality bought as a quality');
  d = clone(legal);
  d.gear.push({ ref: id('weapons', 'Ares Alpha'), file: 'weapons', qty: 1 });
  ok(hasError(d, /Ares Alpha : disponibilité 11F/) === false, 'avail 11 accepted');
  d.gear.push({ ref: id('weapons', 'Yamaha Raiden'), file: 'weapons', qty: 1 });
  ok(hasError(d, /Yamaha Raiden : disponibilité 14F au-dessus de 12/), 'avail 14 refused');
  d = clone(legal);
  d.gear[2].grade = 'delta';
  ok(hasError(d, /grade delta n’est pas autorisé/), 'deltaware refused at creation');
  d = clone(legal);
  d.gear[2].rating = 3;
  ok(hasError(d, /disponibilité 20R/) && hasError(d, /Budget dépassé/), 'Wired Reflexes 3: avail 20 and over budget');
  d = clone(legal);
  d.priorities.resources = 'A';
  d.priorities.attributes = 'D';
  d.attributes = { BOD: 2, AGI: 3, REA: 3, STR: 1, WIL: 1, LOG: 1, INT: 2, CHA: 1, EDG: 0 };
  d.gear.push({ ref: id('cyberware', 'Muscle Replacement'), file: 'cyberware', qty: 1, rating: 4 }, { ref: id('cyberware', 'Wired Reflexes'), file: 'cyberware', qty: 1, rating: 2 });
  ok(hasError(d, /Essence .* ne survivrait pas/), 'essence ≤ 0 refused');
  d = clone(legal);
  d.spells = [{ catalogId: id('spells', 'Stunbolt') }];
  ok(hasError(d, /ne peut pas lancer de sorts/), 'mundane with spells');
  d = clone(adept);
  d.magic.type = 'adept';
  ok(hasError(d, /Adepte n’est pas disponible avec la priorité A/), 'adept not offered at magic A');
  d = clone(legal);
  d.qualities.push({ catalogId: id('qualities', 'Lucky') }, { catalogId: id('qualities', 'Ambidextrous') });
  d.attrKarma = { AGI: 0, CHA: 2 };
  ok(hasError(d, /Karma dépassé/), 'karma overspent');
  d = clone(legal);
  d.skills.push({ id: 'spellcasting', points: 0 });
  ok(hasError(d, /Lancement de sorts : inaccessible/), 'mundane with a magical skill');
  d = clone(legal);
  d.knowledge.push({ name: 'Japonais', native: true });
  ok(hasError(d, /2 langues maternelles/), 'two native languages without Bilingual');
  d = clone(legal);
  d.concept = { name: '', alias: '' };
  ok(hasError(d, /Donne un nom/), 'name required');

  console.log('• normalization');
  const n = normalizeDraft({ priorities: { metatype: 'Z' }, metatype: 'Dragon', skills: [{ id: 'nope' }, { id: 'pistols', points: 99 }], gear: [{ ref: '' }], concept: { portrait: 'javascript:alert(1)' } });
  ok(n.priorities.metatype === '' && n.metatype === 'Humain', 'invalid letters / metatype reset');
  ok(n.skills.length === 1 && n.skills[0].points === 12, 'unknown skills dropped, points clamped');
  ok(n.gear.length === 0 && n.concept.portrait === '', 'empty gear and unsafe portrait dropped');
  ok(emptyDraft().attributes.BOD === 0, 'empty draft');
  ok(attrLimits({ metatype: 'Troll', qualities: [] }, ctx, 'BOD').max === 10, 'troll BOD max 10');

  console.log('• actor building');
  const { actor } = buildActor(legal, ctx, {});
  ok(actor.type === 'pc' && actor.name === 'Rouille' && actor.realName === 'Marc Delorme', 'name / real name');
  ok(actor.attributes.ESS === 4 && actor.augmented?.REA === 1 && actor.initiative.dice === 2, 'wired reflexes: ESS, REA +1, +1D6');
  ok(actor.weapons.some((w) => w.name === 'Ares Predator V' && w.skill === 'pistols' && w.catalogId), 'weapon mapped like the shop');
  ok(actor.armor.find((a) => a.rating === 12)?.equipped === true, 'armor jacket equipped');
  ok(actor.gear.find((g) => g.catalogId === id('gear', 'Ammo: Regular Ammo'))?.qty === 20, 'ammo packs → 20 rounds');
  ok(actor.skills.some((s) => s.id === 'etiquette' && s.rating === 2 && s.group === 'influence'), 'group skills materialized');
  ok(actor.skillGroups?.some((g) => g.id === 'electronics' && g.rating === 3), 'intact groups listed');
  ok(skillPool(actor, 'pistols', { useSpec: true }).pool === 5 + 6 + 2, 'pistols pool with spec');
  ok(actor.knowledge.some((k) => k.native && k.name === 'Français'), 'native language');
  ok(actor.qualities.some((q) => q.name === 'Vision nocturne') && actor.vision.lowLight, 'racial trait + vision');
  ok(actor.qualities.some((q) => q.karma === -5 && q.positive === false), 'negative quality karma');
  ok(actor.contacts.length === 2 && actor.lifestyle?.monthsPaid === 1, 'contacts and lifestyle');
  ok(actor.nuyen === 5000 && actor.karma === 7, 'carried nuyen / karma');
  const dv = derive(actor);
  ok(dv.initiative.dice === 2 && dv.armor === 12, 'derive() works on the built actor');
  const { actor: mage } = buildActor(adept, ctx, {});
  ok(mage.attributes.MAG === 6 && mage.spells.length === 10 && mage.spells.every((s) => s.drain), 'magician: MAG and spells with drain');
  ok(mage.qualities.some((q) => q.name === 'Magicien' && /Hermétique/.test(q.notes)), 'magic type quality with tradition');
  // Adept with Improved Reflexes
  const adeptB = clone(adept);
  adeptB.priorities = { metatype: 'D', attributes: 'A', magic: 'B', skills: 'C', resources: 'E' };
  adeptB.magic = { type: 'adept', freeSkills: ['blades'] };
  adeptB.spells = [];
  adeptB.attributes = { BOD: 3, AGI: 4, REA: 4, STR: 2, WIL: 3, LOG: 2, INT: 3, CHA: 3, EDG: 0, MAG: 0 };
  adeptB.skills = [{ id: 'blades', points: 2 }, { id: 'perception', points: 4 }, { id: 'sneaking', points: 4 }, { id: 'gymnastics', points: 4 }, { id: 'unarmed_combat', points: 4 }, { id: 'pistols', points: 4 }, { id: 'running', points: 3 }, { id: 'etiquette', points: 3 }];
  adeptB.powers = [{ catalogId: id('powers', 'Improved Reflexes'), level: 2 }, { catalogId: id('powers', 'Killing Hands') }, { catalogId: id('powers', 'Critical Strike') }];
  const rb = compute(adeptB, ctx);
  ok(rb.ok, `legal adept: ${rb.errors.map((e) => e.text).join(' | ')}`);
  ok(rb.spent.powerPoints === 3.5 && rb.budgets.powerPoints === 6, `adept PP: ${rb.spent.powerPoints}/${rb.budgets.powerPoints}`);
  const { actor: ad } = buildActor(adeptB, ctx, {});
  ok(ad.initiative.dice === 3 && ad.augmented?.REA === 2 && ad.powers.find((p) => p.level === 2)?.bonus?.initiativeDice === 2, 'improved reflexes 2 applied and recorded');
  ok(ad.skills.find((s) => s.id === 'blades')?.rating === 6, 'adept free skill at 4 + 2 points');
}

async function serverTests() {
  console.log('• server flow (port ' + PORT + ')');
  const srv = await startServer({ port: PORT });
  try {
    const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
    const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Créatrice' }));
    const p2 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Voisin' }));
    await settle();
    ok(gm.state.chargen?.settings?.method === 'priority' && gm.state.chargen.settings.allowPlayers === true, 'slice initialized with defaults');

    const { draftId } = await p1.send('chargen/saveDraft', { data: legal });
    ok(typeof draftId === 'string', 'draft created');
    await settle();
    ok(p1.state.chargen.drafts.length === 1 && p1.state.chargen.drafts[0].status === 'draft', 'player sees own draft');
    ok(p2.state.chargen.drafts.length === 0, 'other player does not see it');
    ok(gm.state.chargen.drafts.some((d) => d.id === draftId && d.check?.errors === 0), 'GM sees it with its check');
    await rejects(p2.send('chargen/saveDraft', { draftId, data: legal }), /ne t’appartient pas/, 'cannot edit someone else’s draft');

    // Illegal submit
    const bad = clone(legal);
    bad.priorities.skills = 'A';
    const { draftId: badId } = await p1.send('chargen/saveDraft', { data: bad });
    await rejects(p1.send('chargen/submit', { draftId: badId }), /incomplet ou illégal/, 'illegal build cannot be submitted');
    const raw = await new Promise((res) => p1.socket.emit('action', { type: 'chargen/submit', payload: { draftId: badId } }, res));
    const errKeys = msgKeys(raw);
    ok(raw.errorKey === 'Personnage incomplet ou illégal : {errors}' && errKeys.length > 1 && errKeys.every((k) => EN[k]), `submit error is translatable (${errKeys.filter((k) => !EN[k]).join(' | ')})`);
    ok(!/⟦/.test(enT(raw.errorKey, raw.params)), `submit error renders in English: ${enT(raw.errorKey, raw.params)}`);

    // Submit / withdraw / submit
    await p1.send('chargen/submit', { draftId });
    await rejects(p1.send('chargen/saveDraft', { draftId, data: legal }), /retire la demande/, 'pending draft locked');
    await p1.send('chargen/withdraw', { draftId });
    await p1.send('chargen/submit', { draftId });
    await settle();
    ok(gm.state.chargen.drafts.find((d) => d.id === draftId)?.status === 'pending', 'GM queue shows pending');
    await rejects(p1.send('chargen/resolve', { draftId, approve: true }), /réservée au MJ/, 'player cannot approve');

    // Approve → actor + assignment
    const before = Object.keys(gm.state.actors).length;
    const res = await gm.send('chargen/resolve', { draftId, approve: true, note: 'Bienvenue à Seattle' });
    ok(res.status === 'approved' && res.actorId, 'approved with an actor id');
    await settle();
    const a = gm.state.actors[res.actorId];
    ok(Object.keys(gm.state.actors).length === before + 1 && a?.type === 'pc', 'PC actor created');
    ok(a?.history?.[0]?.text?.startsWith('Création'), 'history « Création »');
    ok(a?.history?.every((h) => h.i18n?.key && msgKeys(h.i18n).every((k) => EN[k])), 'history entries translatable');
    const cgLogs = gm.state.log.filter((e) => e.author === 'Création');
    ok(cgLogs.length >= 2 && cgLogs.every((e) => e.i18n?.key && msgKeys(e.i18n).every((k) => EN[k])), `creation log entries translatable (${cgLogs.map((e) => e.text).join(' | ')})`);
    ok(cgLogs.some((e) => /^Personnage validé : Rouille \(nuyen de départ : \d+¥\) — « Bienvenue à Seattle »$/.test(e.text)), 'approval log keeps its French text');
    ok(a?.player === 'Créatrice', 'player name on the actor');
    ok(a?.nuyen >= 5000 + 60 * 3 && a?.nuyen <= 5000 + 60 * 18, `starting nuyen rolled (Low: 3D6×60): ${a?.nuyen}`);
    const u1 = Object.values(gm.state.users).find((u) => u.name === 'Créatrice');
    ok(u1?.characterIds?.includes(res.actorId), 'assigned to the submitting user');
    ok(p1.state.me.characterIds.includes(res.actorId), 'player view knows the new character');
    ok(p1.state.actors[res.actorId]?.name === 'Rouille', 'player receives the actor');
    ok(p1.events.some((e) => e.ev === 'chargen:resolved' && e.data.status === 'approved'), 'player notified');
    await rejects(p1.send('chargen/saveDraft', { draftId, data: legal }), /déjà été validé/, 'approved draft read-only');

    // Reject flow
    const { draftId: d2 } = await p1.send('chargen/saveDraft', { data: adept });
    await p1.send('chargen/submit', { draftId: d2 });
    await gm.send('chargen/resolve', { draftId: d2, approve: false, note: 'Trop de sorts de combat' });
    await settle();
    const rej = p1.state.chargen.drafts.find((x) => x.id === d2);
    ok(rej?.status === 'rejected' && rej.gmNote === 'Trop de sorts de combat', 'rejected with GM note');
    await p1.send('chargen/saveDraft', { draftId: d2, data: adept });
    await settle();
    ok(p1.state.chargen.drafts.find((x) => x.id === d2)?.status === 'draft', 'editing a rejected draft makes it a draft again');

    // Delete
    await p1.send('chargen/delete', { draftId: badId });
    await settle();
    ok(!p1.state.chargen.drafts.some((x) => x.id === badId), 'draft deleted');

    // GM direct creation (NPC, no approval) and force
    const npc = await gm.send('chargen/create', { data: adept, type: 'npc' });
    await settle();
    ok(gm.state.actors[npc.actorId]?.type === 'npc' && gm.state.actors[npc.actorId].attributes.MAG === 6, 'GM creates an NPC directly');
    await rejects(gm.send('chargen/create', { data: bad, type: 'pc' }), /ne respecte pas les règles/, 'GM create refuses illegal build without force');
    const forced = await gm.send('chargen/create', { data: bad, type: 'pc', assignTo: Object.values(gm.state.users).find((u) => u.name === 'Voisin').id, force: true });
    await settle();
    ok(p2.state.me.characterIds.includes(forced.actorId), 'forced PC assigned to the chosen player');

    // Settings
    await gm.send('chargen/settings', { allowPlayers: false, startingKarmaBonus: 5 });
    await rejects(p2.send('chargen/saveDraft', { data: legal }), /fermée/, 'players blocked when creation is closed');
    await settle();
    ok(p2.state.chargen.settings.startingKarmaBonus === 5, 'settings visible to players');
    gm.close();
    p1.close();
    p2.close();
  } finally {
    srv.stop();
  }
}

unitTests();
i18nTests();
await serverTests();
console.log(failures ? `\n${failures} échec(s), ${passes} réussite(s)` : `\nOK — ${passes} vérifications`);
process.exit(failures ? 1 : 0);
