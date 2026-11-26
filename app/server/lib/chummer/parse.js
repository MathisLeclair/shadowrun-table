// .chum5 (Chummer5a save file) → Actor (see ARCHITECTURE.md « Actors »).
// Every imported list item keeps `chummerGuid` (the <guid> of its node) and `catalogId` (= Chummer <sourceid>),
// which lets export.js patch the original file and the 3-way merge (merge.js) match items across versions.
import crypto from 'node:crypto';
import { parseXml, XmlError } from './xml.js';
import { i18nError, errorParam, warningList } from './messages.js';
import { skillsData, appSkillId, metatypeData, METATYPE_FROM_EN, frenchName, frenchCategory, gradeTable, norm } from './data.js';
import { SKILL_BY_ID } from '../../../shared/sr5.js';
import { blankActor, categoryToSkill, evalFormula, MELEE_SKILLS } from '../../../client/modules/sheet/sheet-data.js';
import { uid } from '../../../shared/util.js';

/** User-facing import error (French message, no stack needed). */
export class ChummerError extends Error {}

export const APP_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES'];
const KNO_TYPES = { street: 'street', academic: 'academic', professional: 'professional', interest: 'interest', language: 'language' };
const MATRIX_CATS = /^(Commlinks?|Cyberdecks?|Rigger Command Consoles?|Cyberterminals?)$/i;
const PROGRAM_CATS = /programs?$/i;

const num = (s, d = 0) => {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : d;
};
const bool = (s) => /^(true|1)$/i.test(String(s ?? '').trim());
const round2 = (n) => Math.round(n * 100) / 100;

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/** Very small RTF → text converter (Chummer stores rich-text notes as RTF in some versions). */
export function rtfToText(s) {
  const str = String(s || '');
  if (!/^\s*\{\\rtf/.test(str)) return str;
  let out = str
    .replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[^]*?\}\s*\}/g, '')
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\\line\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (m, c) => String.fromCharCode((Number(c) + 65536) % 65536))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\\([{}\\])/g, '$1')
    .replace(/[{}]/g, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Clean multi-line text read from the file (line endings, RTF, HTML-ish tags). */
function longText(s) {
  let t = rtfToText(String(s || '').replace(/\r\n/g, '\n'));
  if (/^\s*<(html|p|div|span|br)/i.test(t)) t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '');
  return t.trim();
}

function guidOf(node) {
  return node.val('guid').toLowerCase() || null;
}
function sourceOf(node) {
  const s = node.val('sourceid').toLowerCase();
  return s && !/^0{8}-/.test(s) ? s : null;
}
function displayName(kind, node) {
  const fr = frenchName(kind, sourceOf(node));
  const base = fr || node.val('name');
  const extra = node.val('extra');
  return extra ? `${base} (${extra})` : base;
}
function srcNote(node) {
  const src = node.val('source');
  const page = node.val('page');
  return src ? `${src}${page ? ` p.${page}` : ''}` : '';
}

/** Enabled improvements of the file, grouped by type. */
function improvementsOf(c) {
  const out = [];
  for (const im of c.get('improvements')?.all('improvement') || []) {
    const en = im.val('enabled');
    if (en && /^(0|false)$/i.test(en)) continue;
    out.push({ type: im.val('improvementttype') || im.val('improvementtype'), name: im.val('improvedname'), val: num(im.val('val')), aug: num(im.val('aug')), source: im.val('improvementsource') });
  }
  return out;
}

/**
 * Parse a .chum5 file. Returns { actor, warnings (French), warningsI18n ([{ t, params }]), info: { created, appVersion, buildMethod, mugshot } }.
 * Throws ChummerError (French message + i18nKey/i18nParams) when the file is not a Chummer character.
 */
export function parseChum5(xml, { fileName = '', now = Date.now(), makeId = uid, keepXml = true } = {}) {
  let doc;
  try {
    doc = parseXml(xml);
  } catch (err) {
    if (err instanceof XmlError) throw i18nError({ t: 'Fichier .chum5 illisible — {error}', params: { error: errorParam(err) } }, ChummerError);
    throw err;
  }
  const c = doc.root;
  if (c.name !== 'character') throw i18nError({ t: 'Ce fichier n’est pas une fiche Chummer5 (.chum5)' }, ChummerError);
  const warn = warningList();
  const warnings = warn.list;
  const v = (n) => c.val(n).trim();
  const imps = improvementsOf(c);

  const alias = v('alias');
  const realName = v('name');
  const a = blankActor('pc', (alias || realName || 'Runner importé').slice(0, 80));
  if (alias && realName && realName !== alias) a.realName = realName.slice(0, 120);
  const metaEn = v('metatype') || 'Human';
  a.metatype = METATYPE_FROM_EN[metaEn] || metaEn;
  if (!METATYPE_FROM_EN[metaEn]) warn.add({ t: 'Métatype « {metatype} » inconnu de l’app (gardé tel quel).', params: { metatype: metaEn } });
  const gender = v('gender') || v('sex');
  a.gender = { Male: 'Homme', Female: 'Femme' }[gender] || gender;
  const age = v('age');
  if (/^\d{1,3}$/.test(age)) a.age = Number(age);
  a.player = v('playername');
  a.concept = longText(v('concept')).split('\n')[0].slice(0, 200);

  // Free text
  const look = [['Yeux', 'eyes'], ['Cheveux', 'hair'], ['Taille', 'height'], ['Poids', 'weight'], ['Peau', 'skin']]
    .map(([fr, k]) => (v(k) ? `${fr} : ${v(k)}` : ''))
    .filter(Boolean)
    .join(' · ');
  const bio = [];
  const desc = longText(c.val('description'));
  if (desc) bio.push(desc);
  if (look) bio.push(`**Apparence** — ${look}`);
  if (age && !/^\d{1,3}$/.test(age)) bio.push(`**Âge** — ${age}`);
  const bg = longText(c.val('background'));
  if (bg) bio.push(`### Passé\n\n${bg}`);
  const concept = longText(c.val('concept'));
  if (concept.includes('\n')) bio.push(`### Concept\n\n${concept}`);
  a.bio = bio.join('\n\n');
  const notes = [longText(c.val('notes')), longText(c.val('gamenotes')) ? `### Notes de partie\n\n${longText(c.val('gamenotes'))}` : ''].filter(Boolean);
  a.notes = notes.join('\n\n');
  if (v('metavariant')) a.metavariant = v('metavariant');

  // Mode & money
  const created = bool(v('created'));
  let careerKarma = 0;
  let hasKarmaExpenses = false;
  for (const e of c.get('expenses')?.all('expense') || []) {
    if (e.val('type') !== 'Karma') continue;
    hasKarmaExpenses = true;
    const amt = num(e.val('amount'));
    if (amt > 0 || bool(e.val('refund'))) careerKarma += amt;
  }
  a.karma = Math.round(num(v('karma')));
  a.karmaTotal = Math.max(a.karma, c.has('totalkarma') ? Math.round(num(v('totalkarma'))) : hasKarmaExpenses ? Math.round(careerKarma) : a.karma);
  a.nuyen = Math.round(num(v('nuyen')));
  const streetBase = created ? Math.floor(Math.max(careerKarma, 0) / 10) : 0;
  const impSum = (type) => imps.filter((i) => i.type === type).reduce((t, i) => t + i.val, 0);
  a.streetCred = Math.max(0, streetBase + impSum('StreetCred') + Math.round(num(v('streetcred'))) - Math.round(num(v('burntstreetcred'))));
  a.notoriety = Math.max(0, Math.round(num(v('notoriety')) + impSum('Notoriety') + num(v('burntstreetcred'))));
  a.publicAwareness = Math.max(0, Math.round(num(v('publicawareness')) + impSum('PublicAwareness')));
  if (!created) warn.add({ t: 'Personnage encore en mode création dans Chummer : karma et nuyens restants peuvent différer de ce qu’affiche Chummer.' });

  // Attributes: value = metatype min + base + karma; totalvalue (when present) includes augmentations.
  const magEnabled = bool(v('magenabled'));
  const resEnabled = bool(v('resenabled'));
  a.augmented = {};
  const seen = new Set();
  for (const at of c.get('attributes')?.all('attribute') || []) {
    const k = at.val('name').toUpperCase();
    if (!APP_ATTRS.includes(k) || seen.has(k)) continue;
    seen.add(k);
    if (k === 'MAG' && !magEnabled) continue;
    if (k === 'RES' && !resEnabled) continue;
    const natural = num(at.val('metatypemin')) + num(at.val('base')) + num(at.val('karma'));
    let value = natural;
    if (at.has('totalvalue')) {
      const total = num(at.val('totalvalue'), natural);
      if (k === 'MAG' || k === 'RES') value = Math.min(natural, total); // essence loss lowers the rating
      else if (total > natural) a.augmented[k] = total - natural;
    }
    a.attributes[k] = value;
  }
  if (!Object.keys(a.augmented).length) delete a.augmented;
  a.edge.current = Math.max(0, a.attributes.EDG - Math.round(num(v('edgeused'))));

  // Initiative dice / bonus from improvements (wired reflexes, improved reflexes, synaptic booster…)
  const extraDice = imps.filter((i) => /^InitiativeDice|^InitiativePass/i.test(i.type)).reduce((s, i) => s + (i.val || i.aug), 0);
  const initBonus = imps.filter((i) => i.type === 'Initiative').reduce((s, i) => s + (i.val || i.aug), 0);
  const baseDice = num(v('initiativedice'), 1) || 1;
  if (extraDice || initBonus || baseDice !== 1) a.initiative = { dice: Math.max(1, Math.min(5, baseDice + extraDice)), bonus: initBonus };

  // Skills
  const sd = skillsData();
  const groups = {};
  for (const g of c.get('newskills/groups')?.all('group') || []) groups[norm(g.val('name'))] = { base: num(g.val('base')), karma: num(g.val('karma')), broken: bool(g.val('isbroken')) };
  const freeBase = {};
  for (const im of imps) if (im.type === 'SkillBase' && im.name) freeBase[norm(im.name)] = (freeBase[norm(im.name)] || 0) + im.val;
  const knoNodes = [...(c.get('newskills/knoskills')?.all('skill') || [])];
  for (const s of c.get('newskills/skills')?.all('skill') || []) {
    if (bool(s.val('isknowledge'))) {
      knoNodes.push(s);
      continue;
    }
    const def = sd.byId.get(s.val('suid').toLowerCase()) || sd.byName.get(norm(s.val('name')));
    const name = s.val('name') || def?.name;
    if (!name) continue;
    const g = groups[norm(def?.group || s.val('skillgroup'))] || { base: 0, karma: 0 };
    const rating = Math.max(num(s.val('base')), g.base) + (freeBase[norm(name)] || 0) + num(s.val('karma')) + g.karma;
    if (!rating) continue;
    const id = appSkillId(name);
    const app = SKILL_BY_ID[id];
    const specific = s.val('specific');
    const specs = (s.get('specs')?.all('spec') || []).map((sp) => sp.val('name')).filter(Boolean);
    a.skills.push({
      id: id === 'exotic_weapon' && a.skills.some((x) => x.id === id) ? `${id}_${a.skills.length}` : id,
      name: (app ? app.fr : name) + (specific ? ` (${specific})` : ''),
      attr: app ? app.attr : String(def?.attr || s.val('attribute') || 'AGI').toUpperCase(),
      rating,
      ...(specs.length ? { spec: specs.join(', ') } : {}),
      ...(app?.group ? { group: app.group } : {}),
    });
  }
  for (const s of knoNodes) {
    const name = s.val('name');
    if (!name) continue;
    const type = KNO_TYPES[norm(s.val('type') || s.val('skillcategory'))] || 'interest';
    const native = bool(s.val('isnativelanguage'));
    const specs = (s.get('specs')?.all('spec') || []).map((sp) => sp.val('name')).filter(Boolean);
    a.knowledge.push({
      id: makeId('kno'), name, rating: native ? 0 : num(s.val('base')) + num(s.val('karma')) + (freeBase[norm(name)] || 0), type,
      ...(native ? { native: true } : {}), ...(specs.length ? { spec: specs.join(', ') } : {}), ...(guidOf(s) ? { chummerGuid: guidOf(s) } : {}),
    });
  }

  // Qualities
  for (const q of c.get('qualities')?.all('quality') || []) {
    if (!q.val('name')) continue;
    const positive = q.val('qualitytype') !== 'Negative';
    const karma = Math.abs(num(q.val('bp'))) * (positive ? 1 : -1);
    const src = q.val('qualitysource');
    const note = [srcNote(q), /^Metatype/.test(src) ? 'trait du métatype' : '', longText(q.val('notes'))].filter(Boolean).join(' — ');
    a.qualities.push(withRef({ id: makeId('itm'), name: displayName('qualities', q), karma, positive, ...(note ? { notes: note } : {}) }, q));
  }

  // Weapons. Chummer's built-in Unarmed Attack becomes the app's « Mains nues » (accuracy = physical limit).
  let unarmedDone = false;
  for (const w of c.get('weapons')?.all('weapon') || []) {
    const name = w.val('name');
    if (!name) continue;
    if (name === 'Unarmed Attack') {
      if (unarmedDone) continue;
      unarmedDone = true;
      const A = (k) => (a.attributes[k] || 1) + (a.augmented?.[k] || 0);
      const physical = Math.ceil((A('STR') * 2 + A('BOD') + A('REA')) / 3);
      a.weapons.push(withRef({
        id: makeId('itm'), name: 'Mains nues', category: 'Corps à corps', kind: 'melee', skill: 'unarmed_combat', accuracy: physical,
        damage: w.val('damage').replace(/\{STR\}/g, 'STR') || '(STR)S', ap: 0, mode: '', rc: 0, ammo: '', reach: num(w.val('reach')), notes: 'Unarmed Attack (SR5 132)',
      }, w));
      continue;
    }
    a.weapons.push(weaponFromNode(w, makeId));
  }

  // Armor
  for (const ar of c.get('armors')?.all('armor') || []) {
    if (!ar.val('name')) continue;
    const raw = ar.val('armoroverride') || ar.val('armor');
    const rating = /^[+-]?\d+$/.test(raw.trim()) ? Math.abs(num(raw.replace('+', ''))) : Math.max(0, num(evalFormula(raw.replace(/^\+/, ''), num(ar.val('rating'), 1)), 0));
    const mods = (ar.get('armormods')?.all('armormod') || []).map((m) => m.val('name') + (num(m.val('rating')) ? ` ${m.val('rating')}` : '')).filter(Boolean);
    const note = [srcNote(ar), mods.length ? `Modifications : ${mods.join(', ')}` : '', longText(ar.val('notes'))].filter(Boolean).join(' — ');
    a.armor.push(withRef({ id: makeId('itm'), name: displayName('armor', ar), rating, equipped: bool(ar.val('equipped')), ...(raw.trim().startsWith('+') ? { stack: true } : {}), ...(note ? { notes: note } : {}) }, ar));
    for (const g of ar.get('gears')?.all('gear') || []) pushGear(g, `dans ${ar.val('name')}`);
  }

  // Cyberware / bioware (children flattened, flagged as included)
  const grades = { ...gradeTable('cyberware'), ...gradeTable('bioware') };
  let essLoss = 0;
  const pushWare = (cw, parentName) => {
    if (!cw.val('name')) return;
    const rating = num(cw.val('rating'));
    const kind = /bioware/i.test(cw.val('improvementsource')) ? 'bioware' : 'cyberware';
    const gradeName = cw.val('grade') || 'Standard';
    const mult = grades[gradeName]?.ess ?? (/alpha/i.test(gradeName) ? 0.8 : /beta/i.test(gradeName) ? 0.7 : /delta/i.test(gradeName) ? 0.5 : /used/i.test(gradeName) ? 1.25 : 1);
    const rawEss = cw.val('ess');
    const base = /^[\d.,\s]+$/.test(rawEss) ? num(rawEss) : evalFormula(rawEss.replace(/\[|\]/g, ''), rating || 1);
    const ess = Math.round((base || 0) * mult * 10000) / 10000;
    essLoss += ess;
    const g = gradeName.toLowerCase();
    const note = [parentName ? `Sous-système de ${parentName}` : '', cw.val('location') ? `côté ${cw.val('location') === 'Left' ? 'gauche' : cw.val('location') === 'Right' ? 'droit' : cw.val('location')}` : '', srcNote(cw), longText(cw.val('notes'))].filter(Boolean).join(' — ');
    a.augmentations.push(withRef({
      id: makeId('itm'), name: displayName(kind, cw), kind,
      grade: g.includes('alpha') ? 'alpha' : g.includes('beta') ? 'beta' : g.includes('delta') ? 'delta' : g.includes('used') ? 'used' : 'standard',
      ...(rating ? { rating } : {}), essence: ess, ...(note ? { notes: note } : {}),
    }, cw));
    for (const ch of cw.get('children')?.all('cyberware') || []) pushWare(ch, cw.val('name'));
    for (const gg of cw.get('gears')?.all('gear') || []) pushGear(gg, `dans ${cw.val('name')}`);
    for (const ww of cw.get('weapons')?.all('weapon') || []) a.weapons.push(weaponFromNode(ww, makeId, `intégrée à ${cw.val('name')}`));
  };
  for (const cw of c.get('cyberwares')?.all('cyberware') || []) pushWare(cw, null);
  const totEss = v('totaless');
  a.attributes.ESS = totEss ? round2(num(totEss, 6)) : Math.max(0, round2(6 - essLoss));

  // Gear (commlinks/decks feed the matrix block, SINs feed `sins`, programs feed matrix.programs)
  function pushGear(g, where) {
    const name = g.val('name');
    if (!name) return;
    if (bool(g.val('includedinparent'))) return;
    const category = g.val('category');
    if (PROGRAM_CATS.test(category) && a.matrix) {
      a.matrix.programs.push(g.val('extra') ? `${name} (${g.val('extra')})` : name);
      return;
    }
    if (/^ID\/Credsticks$/i.test(category) && /\bSIN\b/i.test(name)) {
      const licenses = (g.get('children')?.all('gear') || []).filter((x) => /license/i.test(x.val('name'))).map((x) => x.val('extra') || x.val('name'));
      a.sins.push(withRef({ id: makeId('itm'), name: g.val('extra') || name, rating: num(g.val('rating')), licenses }, g));
      for (const ch of g.get('children')?.all('gear') || []) if (!/license/i.test(ch.val('name'))) pushGear(ch, `avec ${g.val('extra') || name}`);
      return;
    }
    if (MATRIX_CATS.test(category) && !a.matrix) {
      const array = g.val('attributearray').split(',').map((x) => num(x));
      const dr = num(g.val('devicerating'));
      a.matrix = {
        device: name, rating: dr,
        attack: num(g.val('attack'), array[0] || 0), sleaze: num(g.val('sleaze'), array[1] || 0),
        dataProcessing: num(g.val('dataprocessing'), array[2] || dr), firewall: num(g.val('firewall'), array[3] || dr),
        programs: [],
      };
    }
    const rating = num(g.val('rating'));
    const note = [where || '', g.val('location') ? `emplacement : ${g.val('location')}` : '', srcNote(g), longText(g.val('notes'))].filter(Boolean).join(' — ');
    const custom = g.val('gearname');
    a.gear.push(withRef({
      id: makeId('itm'), name: custom || displayName('gear', g), category: frenchCategory('gear', sourceOf(g)) || category, ...(rating ? { rating } : {}), qty: num(g.val('qty'), 1) || 1, ...(note ? { notes: note } : {}),
    }, g));
    for (const ch of g.get('children')?.all('gear') || []) pushGear(ch, `dans ${custom || name}`);
  }
  for (const g of c.get('gears')?.all('gear') || []) pushGear(g, '');

  // Vehicles & drones
  for (const vh of c.get('vehicles')?.all('vehicle') || []) {
    if (!vh.val('name')) continue;
    const mods = (vh.get('mods')?.all('mod') || []).map((m) => m.val('name')).filter(Boolean);
    const weapons = [];
    vh.walk((n) => {
      if (n.name === 'weapon' && n.val('name')) weapons.push(n.val('name'));
    });
    const note = [srcNote(vh), mods.length ? `Modifications : ${mods.join(', ')}` : '', weapons.length ? `Armes : ${weapons.join(', ')}` : '', longText(vh.val('notes'))].filter(Boolean).join(' — ');
    a.vehicles.push(withRef({
      id: makeId('itm'), name: vh.val('vehiclename') || displayName('vehicles', vh), handling: vh.val('handling'), speed: vh.val('speed'), accel: vh.val('accel'),
      body: num(vh.val('body')), armor: num(vh.val('armor')), pilot: num(vh.val('pilot')), sensor: num(vh.val('sensor')), seats: num(vh.val('seats')),
      ...(note ? { notes: note } : {}),
    }, vh));
  }

  // Contacts (enemies are kept, flagged in the notes)
  for (const ct of c.get('contacts')?.all('contact') || []) {
    if (!ct.val('name')) continue;
    const enemy = ct.val('type') === 'Enemy';
    const note = [enemy ? 'ENNEMI' : '', ct.val('location') ? `Lieu : ${ct.val('location')}` : '', longText(ct.val('notes'))].filter(Boolean).join(' — ');
    a.contacts.push(withRef({ id: makeId('itm'), name: ct.val('name'), role: ct.val('role'), connection: num(ct.val('connection'), 1), loyalty: num(ct.val('loyalty'), 1), ...(note ? { notes: note } : {}) }, ct));
  }

  // Adept powers
  for (const p of c.get('powers')?.all('power') || []) {
    if (!p.val('name')) continue;
    const level = num(p.val('rating'));
    const levels = p.has('levels') ? bool(p.val('levels')) : level > 1;
    const ppl = num(p.val('pointsperlevel'));
    const pp = round2(Math.max(0, (levels ? ppl * (level || 1) : ppl) + num(p.val('extrapointcost')) - (bool(p.val('discounted')) ? 0.25 : 0)));
    const note = srcNote(p);
    a.powers.push(withRef({ id: makeId('itm'), name: displayName('powers', p), ...(levels && level ? { level } : {}), pp, ...(note ? { notes: note } : {}) }, p));
  }

  // Spells & complex forms
  for (const s of c.get('spells')?.all('spell') || []) {
    if (!s.val('name')) continue;
    const flags = [bool(s.val('alchemical')) ? 'alchimique' : '', bool(s.val('extended')) ? 'étendu' : '', bool(s.val('limited')) ? 'limité' : ''].filter(Boolean);
    const note = [srcNote(s), flags.join(', ')].filter(Boolean).join(' — ');
    a.spells.push(withRef({ id: makeId('itm'), name: displayName('spells', s), category: s.val('category'), type: s.val('type'), range: s.val('range'), duration: s.val('duration'), drain: s.val('dv'), ...(note ? { notes: note } : {}) }, s));
  }
  const forms = (c.get('complexforms')?.all('complexform') || []).filter((f) => f.val('name'));
  if (forms.length) a.complexForms = forms.map((f) => withRef({ id: makeId('itm'), name: f.val('name') + (f.val('extra') ? ` (${f.val('extra')})` : ''), target: f.val('target'), duration: f.val('duration'), fading: f.val('fv') }, f));

  // Lifestyle: the most expensive one
  const lifestyles = (c.get('lifestyles')?.all('lifestyle') || []).filter((l) => l.val('name') || l.val('baselifestyle'));
  if (lifestyles.length) {
    const ls = lifestyles.sort((x, y) => num(y.val('totalmonthlycost') || y.val('cost')) - num(x.val('totalmonthlycost') || x.val('cost')))[0];
    const base = ls.val('baselifestyle');
    const nm = ls.val('name') || base;
    a.lifestyle = { name: nm, monthlyCost: num(ls.val('totalmonthlycost') || ls.val('cost')), monthsPaid: num(ls.val('months')), chummerGuid: guidOf(ls) };
  }

  // Extras that the app has no dedicated place for: summarized in the notes.
  const extras = [];
  const grade = num(v('initiategrade'));
  const metamagics = (c.get('metamagics')?.all('metamagic') || []).map((m) => m.val('name')).filter(Boolean);
  if (grade) extras.push(`Initié de grade ${grade}${metamagics.length ? ` — métamagies : ${metamagics.join(', ')}` : ''}`);
  const sub = num(v('submersiongrade'));
  if (sub) extras.push(`Submergé de grade ${sub}${metamagics.length ? ` — échos : ${metamagics.join(', ')}` : ''}`);
  const arts = (c.get('martialarts')?.all('martialart') || []).map((m) => {
    const tech = (m.get('martialarttechniques')?.all('martialarttechnique') || m.get('techniques')?.all('technique') || []).map((t) => t.val('name')).filter(Boolean);
    return m.val('name') + (tech.length ? ` (${tech.join(', ')})` : '');
  });
  if (arts.length) extras.push(`Arts martiaux : ${arts.join(' ; ')}`);
  const foci = (c.get('foci')?.all('focus') || []).map((f) => f.val('name')).filter(Boolean);
  if (foci.length) extras.push(`Focus liés : ${foci.join(', ')}`);
  const spirits = (c.get('spirits')?.all('spirit') || []).map((s) => `${s.val('name')}${s.val('force') ? ` (Puissance ${s.val('force')})` : ''}${s.val('services') ? `, ${s.val('services')} service(s)` : ''}`).filter((x) => x.trim());
  if (spirits.length) extras.push(`Esprits / sprites : ${spirits.join(' ; ')}`);
  const mentor = (c.get('mentorspirits')?.all('mentorspirit') || []).map((m) => m.val('name')).filter(Boolean);
  if (mentor.length) extras.push(`Mentor : ${mentor.join(', ')}`);
  const tradition = c.get('tradition');
  if (tradition?.val('name')) extras.push(`Tradition : ${tradition.val('name')}`);
  if (extras.length) a.bio = [a.bio, `### Données Chummer\n\n${extras.map((x) => `- ${x}`).join('\n')}`].filter(Boolean).join('\n\n');

  // Condition monitor (Chummer stores overflow inside physicalcmfilled)
  const bodTotal = (a.attributes.BOD || 1) + (a.augmented?.BOD || 0);
  const wilTotal = (a.attributes.WIL || 1) + (a.augmented?.WIL || 0);
  const physCm = num(c.get('calculatedvalues')?.val('physicalcm'), 8 + Math.ceil(bodTotal / 2)) || 8 + Math.ceil(bodTotal / 2);
  const stunCm = num(c.get('calculatedvalues')?.val('stuncm'), 8 + Math.ceil(wilTotal / 2)) || 8 + Math.ceil(wilTotal / 2);
  const physFilled = Math.round(num(v('physicalcmfilled')));
  a.condition = { physical: Math.min(physFilled, physCm), stun: Math.min(Math.round(num(v('stuncmfilled'))), stunCm), overflow: Math.max(0, physFilled - physCm) };

  // Vision from metatype / qualities (map module)
  const qn = a.qualities.map((q) => norm(q.name)).join('|');
  if (/low-light|nyctalopie|vision nocturne/.test(qn) || ['Elfe', 'Ork'].includes(a.metatype)) a.vision = { ...(a.vision || {}), lowLight: true };
  if (/thermographic|thermographique/.test(qn) || ['Nain', 'Troll'].includes(a.metatype)) a.vision = { ...(a.vision || {}), thermo: true };

  const mugshots = c.get('mugshots')?.all('mugshot') || [];
  const mainIdx = Math.max(0, num(v('mainmugshotindex'), 0));
  const mugshot = (mugshots[mainIdx] || mugshots[0])?.text?.trim() || null;

  a.history = [{ ts: now, chummer: true, text: `Import Chummer5${fileName ? ` (${fileName})` : ''}`, karma: a.karma, nuyen: a.nuyen }];
  const meta = metatypeData(metaEn);
  if (!meta && METATYPE_FROM_EN[metaEn]) warn.add({ t: 'Données de métatype Chummer introuvables.' });
  if (keepXml) {
    a.chummer = {
      xml: String(xml).replace(/^﻿/, ''), fileName: String(fileName || '').slice(0, 200), importedAt: now, syncedAt: now, sourceHash: sha1(xml),
      created, appVersion: v('appversion'),
    };
  }
  return { actor: a, warnings, warningsI18n: warn.i18n, info: { created, appVersion: v('appversion'), buildMethod: v('buildmethod'), mugshot } };
}

function withRef(item, node) {
  const g = guidOf(node);
  const s = sourceOf(node);
  if (s) item.catalogId = s;
  if (g) item.chummerGuid = g;
  return item;
}

function weaponFromNode(w, makeId, where) {
  const category = w.val('category');
  const skill = categoryToSkill(category, w.val('useskill'));
  const melee = w.val('type') === 'Melee' || MELEE_SKILLS.includes(skill);
  const accessories = (w.get('accessories')?.all('accessory') || []).map((x) => x.val('name')).filter(Boolean);
  const mode = w.val('mode');
  const ammo = w.val('ammo');
  const note = [where || '', srcNote(w), accessories.length ? `Accessoires : ${accessories.join(', ')}` : '', longText(w.val('notes'))].filter(Boolean).join(' — ');
  const apRaw = w.val('ap');
  return withRef({
    id: makeId('itm'), name: w.val('weaponname') || displayName('weapons', w), category: frenchCategory('weapons', sourceOf(w)) || category, kind: melee ? 'melee' : 'ranged', skill,
    accuracy: w.val('accuracy'), damage: w.val('damage').replace(/\{STR\}/g, 'STR'),
    ap: /^[+-]?\d+$/.test(apRaw) ? Number(apRaw) : apRaw === '-' ? 0 : apRaw, mode: mode === '0' ? '' : mode, rc: num(w.val('rc')), ammo: ammo === '0' ? '' : ammo, reach: num(w.val('reach')),
    ...(note ? { notes: note } : {}),
  }, w);
}
