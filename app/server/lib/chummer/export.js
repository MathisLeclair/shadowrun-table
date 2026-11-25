// Actor → .chum5 (Chummer5a 5.226 save file).
// Two modes, one algorithm:
//  - patch:    actor.chummer.xml exists → parse it, compare the actor with what that file parses to (the
//              « base »), and apply only the differences (karma/nuyen, attribute & skill deltas, items added /
//              removed / changed, condition, street cred…). Unknown nodes, order and formatting are untouched.
//  - generate: no stored file → build an EMPTY character from the skeleton (tools/fixtures/chummer-test.chum5
//              copied to skeleton.chum5, a real Chummer 5.226 file), then apply the same patch with the empty
//              character as base. Career mode (<created>True</created>) so Chummer doesn't check build points.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml, serializeXml, Element, el } from './xml.js';
import { parseChum5, APP_ATTRS } from './parse.js';
import {
  skillsData, chummerSkillFor, metatypeData, METATYPE_EN, findDataItem, findCatalogEntry, norm,
} from './data.js';
import { KNOWLEDGE_TYPES } from '../../../client/modules/sheet/sheet-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKELETON_FILE = path.join(HERE, 'skeleton.chum5');
export const APP_VERSION = '5.226.0';
export const STANDARD_SETTINGS = '223a11ff-80e0-428b-89a9-6ef1c243b8b6';

const newGuid = () => crypto.randomUUID();
const num = (s, d = 0) => {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : d;
};
const B = (v) => (v ? 'True' : 'False');
const fmtNum = (n) => String(Math.round(Number(n) * 10000) / 10000);
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Actor list → where its items live in the file. */
export const LISTS = {
  weapons: { container: 'weapons', node: 'weapon', kind: () => 'weapons' },
  armor: { container: 'armors', node: 'armor', kind: () => 'armor' },
  augmentations: { container: 'cyberwares', node: 'cyberware', kind: (it) => (it.kind === 'bioware' ? 'bioware' : 'cyberware') },
  gear: { container: 'gears', node: 'gear', kind: () => 'gear' },
  sins: { container: 'gears', node: 'gear', kind: () => 'gear' },
  vehicles: { container: 'vehicles', node: 'vehicle', kind: () => 'vehicles' },
  contacts: { container: 'contacts', node: 'contact', kind: () => null },
  qualities: { container: 'qualities', node: 'quality', kind: () => 'qualities' },
  powers: { container: 'powers', node: 'power', kind: () => 'powers' },
  spells: { container: 'spells', node: 'spell', kind: () => 'spells' },
  complexForms: { container: 'complexforms', node: 'complexform', kind: () => 'complexforms' },
};

// ---------------------------------------------------------------------------
// Skeleton & templates (from the real Chummer file)
// ---------------------------------------------------------------------------
let skeletonText = null;
function skeleton() {
  if (skeletonText === null) skeletonText = fs.readFileSync(SKELETON_FILE, 'utf8').replace(/^﻿/, '');
  return parseXml(skeletonText);
}
let tpl = null;
function templates() {
  if (tpl) return tpl;
  const c = skeleton().root;
  const weapons = c.get('weapons').all('weapon');
  tpl = {
    weapon: weapons.find((w) => w.val('name') !== 'Unarmed Attack'),
    unarmed: weapons.find((w) => w.val('name') === 'Unarmed Attack'),
    quality: c.get('qualities').child('quality'),
    skill: c.get('newskills/skills').child('skill'),
  };
  return tpl;
}

/** Remove data-file-only elements from a cloned data node. */
const DATA_ONLY = new Set([
  'id', 'hide', 'required', 'forbidden', 'translate', 'altpage', 'altnameonpage', 'nameonpage', 'onlyprioritygiven', 'addweapon', 'subsystems',
  'allowgear', 'pairbonus', 'wirelesspairbonus', 'pairinclude', 'wirelesspairinclude', 'mods', 'weaponmounts', 'accessorymounts', 'accessories',
  'underbarrels', 'specs', 'costfor', 'adeptwayrequires', 'mutant', 'ammoforweapontype', 'ammobonus',
]);
function cloneData(dataNode, rename = {}) {
  const n = dataNode.clone();
  n.attrs = [];
  n.children = n.children.filter((ch) => {
    if (ch.type !== 'el') return false;
    if (ch.name === 'gears' && ch.child('usegear')) return false;
    return !DATA_ONLY.has(ch.name);
  });
  for (const ch of n.children) if (rename[ch.name]) ch.name = rename[ch.name];
  if (n.child('bonus')) n.child('bonus').attrs = [];
  return n;
}
/** Put sourceid + guid first, like Chummer. */
function head(n, sourceid, guid) {
  n.children = n.children.filter((ch) => !(ch.type === 'el' && (ch.name === 'sourceid' || ch.name === 'guid')));
  n.children.unshift(el('sourceid', sourceid || '00000000-0000-0000-0000-000000000000'), el('guid', guid));
  return n;
}
function setMany(n, obj) {
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) n.set(k, v === null ? '' : String(v));
  return n;
}

/** English name hidden in seed notes: "Low-Light Vision (SR5 p.66)." → "Low-Light Vision". */
function englishHint(notes) {
  const m = String(notes || '').match(/^([A-Z][^()\n.:;]{2,60}?)\s*\(([A-Za-z0-9 &'’]+)\s+p\.\s*\d+/);
  return m ? m[1].trim() : null;
}

/** Find the Chummer data node for an app item (catalogId → app catalog name → notes hint → name). */
export function resolveData(kind, item, extraNames = []) {
  if (!kind) return null;
  if (item.catalogId) {
    const n = findDataItem(kind, { id: item.catalogId });
    if (n) return n;
  }
  const names = [item.name, String(item.name || '').replace(/\s*\([^)]*\)\s*$/, ''), englishHint(item.notes), ...extraNames].filter(Boolean);
  for (const nm of names) {
    const e = findCatalogEntry(kind, { name: nm });
    if (e) {
      const n = findDataItem(kind, { id: e.id });
      if (n) return n;
    }
    const n = findDataItem(kind, { name: nm });
    if (n) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node builders (new items)
// ---------------------------------------------------------------------------
const GRADE_EN = { standard: 'Standard', alpha: 'Alphaware', beta: 'Betaware', delta: 'Deltaware', used: 'Used' };

const UNARMED_ID = '63dcfdb6-bbd9-4a58-bbf4-cd35f7614fdc';
const isUnarmed = (it) => String(it.catalogId || '').toLowerCase() === UNARMED_ID || /^(mains nues|unarmed attack|attaque à mains nues)$/i.test(String(it.name || '').trim());

/** Chummer weapon category for a custom (unknown) weapon, from its app skill. */
const SKILL_CATEGORY = {
  pistols: 'Heavy Pistols', automatics: 'Submachine Guns', longarms: 'Shotguns', heavy_weapons: 'Heavy Machine Guns', blades: 'Blades', clubs: 'Clubs',
  unarmed_combat: 'Unarmed', throwing_weapons: 'Throwing Weapons', archery: 'Bows', exotic_weapon: 'Exotic Ranged Weapons', gunnery: 'Assault Cannons',
};

function buildWeapon(item, data, guid) {
  const n = templates().weapon.clone();
  const d = (k, fb = '') => (data ? data.val(k) : '') || fb;
  const melee = (data ? data.val('type') === 'Melee' : item.kind === 'melee');
  const mounts = data?.get('accessorymounts')?.all('mount').map((m) => m.text) || [];
  const damage = d('damage', String(item.damage || '').replace(/\bSTR\b/g, '{STR}'));
  const builtIn = (data?.get('accessories')?.all('accessory') || []).map((a) => a.val('name')).filter(Boolean);
  const notes = [item.notes || '', builtIn.length ? `Accessoires d’origine à rajouter dans Chummer : ${builtIn.join(', ')}` : ''].filter(Boolean).join(' — ');
  setMany(n, {
    sourceid: data ? data.val('id') : '00000000-0000-0000-0000-000000000000', guid,
    name: data ? data.val('name') : item.name, category: d('category', SKILL_CATEGORY[item.skill] || (melee ? 'Blades' : 'Heavy Pistols')),
    type: melee ? 'Melee' : 'Ranged', spec: d('spec'), spec2: d('spec2'), reach: d('reach', String(item.reach ?? 0)), damage,
    ap: d('ap', String(item.ap ?? 0)), mode: d('mode', item.mode || '0'), rc: d('rc', String(item.rc ?? 0)), ammo: d('ammo', item.ammo || '0'),
    conceal: d('conceal', '0'), avail: d('avail', '0'), cost: d('cost', '0'), useskill: d('useskill'), useskillspec: d('useskillspec'),
    range: d('range'), alternaterange: d('alternaterange'), source: d('source', 'SR5'), page: d('page', '0'),
    allowaccessory: B(mounts.length > 0), weaponslots: mounts.join('/'), weaponname: data ? '' : '', equipped: 'True',
    notes, weapontype: d('weapontype', melee ? 'melee' : 'gun'), ammocategory: d('ammocategory'),
  });
  if (!data) n.set('weaponname', item.name);
  // The template holds <accuracy> twice (Chummer writes it twice): set both.
  for (const acc of n.all('accuracy')) acc.text = d('accuracy', String(item.accuracy ?? (melee ? 'Physical' : '0')));
  return n;
}

function buildQuality(item, data, guid) {
  const n = templates().quality.clone();
  const positive = data ? data.val('category') !== 'Negative' : item.positive !== false;
  const extra = data && norm(data.val('name')) !== norm(item.name) ? String(item.name || '').match(/\(([^)]*)\)\s*$/)?.[1] || '' : '';
  setMany(n, {
    sourceid: data ? data.val('id') : '00000000-0000-0000-0000-000000000000', guid, name: data ? data.val('name') : item.name, extra,
    bp: String(Math.abs(num(data ? data.val('karma') : item.karma))), contributetolimit: data?.val('contributetolimit') || 'True',
    doublecareer: data?.val('doublecareer') || 'True', qualitytype: positive ? 'Positive' : 'Negative', qualitysource: 'Selected',
    source: data?.val('source') || 'SR5', page: data?.val('page') || '0', notes: item.notes || '',
  });
  const bonus = n.child('bonus');
  const dataBonus = data?.child('bonus');
  if (bonus) {
    bonus.attrs = [];
    bonus.children = dataBonus ? dataBonus.clone().children : [];
  }
  const flb = data?.child('firstlevelbonus');
  if (flb && n.child('firstlevelbonus')) n.child('firstlevelbonus').children = flb.clone().children;
  return n;
}

function buildArmor(item, data, guid) {
  const n = data ? cloneData(data, { rating: 'maxrating' }) : el('armor', [el('name', item.name), el('category', 'Armor'), el('armor', String(item.stack ? `+${item.rating || 0}` : item.rating || 0)), el('armorcapacity', '0'), el('avail', '0'), el('cost', '0'), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  setMany(n, { rating: String(item.rating && data?.has('maxrating') ? item.rating : 0), equipped: B(item.equipped), wirelesson: 'True', extra: '', notes: item.notes || '', location: '', armormods: '', gears: '' });
  if (!data) n.set('armorname', item.name);
  return n;
}

function buildWare(item, data, guid, kind) {
  const n = data
    ? cloneData(data, { rating: 'maxrating' })
    : el('cyberware', [el('name', item.name), el('category', kind === 'bioware' ? 'Basic' : 'Bodyware'), el('ess', fmtNum(item.essence || 0)), el('capacity', '0'), el('avail', '0'), el('cost', '0'), el('source', 'SR5'), el('page', '0')]);
  n.name = 'cyberware';
  head(n, data?.val('id'), guid);
  const min = num(data?.val('minrating'), 0);
  setMany(n, {
    rating: String(item.rating || (n.has('maxrating') && num(n.val('maxrating')) > 0 ? Math.max(1, min) : 0)), grade: GRADE_EN[item.grade] || 'Standard',
    improvementsource: kind === 'bioware' ? 'Bioware' : 'Cyberware', location: '', extra: '', notes: item.notes || '', children: '', gears: '', weapons: '',
    wirelesson: 'True', isgeneware: 'False', forcegrade: '', parentid: '', discountedcost: 'False',
  });
  return n;
}

function buildGear(item, data, guid, { forceCustom = false } = {}) {
  let n;
  if (data && !forceCustom) n = cloneData(data, { rating: 'maxrating' });
  else {
    const custom = findDataItem('gear', { name: 'Custom Item' });
    n = custom ? cloneData(custom, { rating: 'maxrating' }) : el('gear', [el('name', 'Custom Item'), el('category', 'Custom'), el('avail', '0'), el('source', 'SR5'), el('page', '1')]);
    n.set('cost', '0');
    n.set('gearname', item.name);
  }
  head(n, (data && !forceCustom ? data : findDataItem('gear', { name: 'Custom Item' }))?.val('id'), guid);
  setMany(n, {
    rating: String(item.rating || 0), qty: String(item.qty ?? 1), equipped: 'True', wirelesson: 'True', bonded: 'False', homenode: 'False',
    extra: item.extra || '', location: '', notes: item.notes || '', includedinparent: 'False', matrixcmfilled: '0', children: '',
  });
  return n;
}

function buildSin(item, guid) {
  const data = findDataItem('gear', { name: 'Fake SIN' });
  const n = buildGear({ name: 'Fake SIN', rating: item.rating || 1, qty: 1, notes: item.notes, extra: item.name }, data, guid);
  const lic = findDataItem('gear', { name: 'Fake License' });
  const kids = (item.licenses || []).map((l) => buildGear({ name: 'Fake License', rating: item.rating || 1, qty: 1, extra: l }, lic, newGuid()));
  n.child('children').children = kids;
  return n;
}

function buildVehicle(item, data, guid) {
  const n = data
    ? cloneData(data)
    : el('vehicle', [el('name', item.name), el('category', 'Cars'), el('avail', '0'), el('cost', '0'), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  if (!data) setMany(n, { handling: item.handling || '0', accel: item.accel || '0', speed: item.speed || '0', pilot: item.pilot || 0, body: item.body || 0, armor: item.armor || 0, sensor: item.sensor || 0, seats: item.seats || 0 });
  setMany(n, { physicalcmfilled: '0', matrixcmfilled: '0', vehiclename: data ? '' : item.name, notes: item.notes || '', mods: '', weapons: '', gears: '', locations: '', homenode: 'False', wirelesson: 'True' });
  return n;
}

function buildContact(item, guid) {
  const enemy = /ENNEMI/.test(item.notes || '');
  return el('contact', [
    el('name', item.name), el('role', item.role || ''), el('location', ''), el('connection', String(item.connection ?? 1)), el('loyalty', String(item.loyalty ?? 1)),
    el('metatype', ''), el('gender', ''), el('age', ''), el('contacttype', ''), el('preferredpayment', ''), el('hobbiesvice', ''), el('personallife', ''),
    el('type', enemy ? 'Enemy' : 'Contact'), el('file', ''), el('relative', 'False'), el('notes', String(item.notes || '').replace(/^ENNEMI( — )?/, '')),
    el('notesColor', 'Chocolate'), el('groupname', ''), el('colour', ''), el('group', 'False'), el('family', 'False'), el('blackmail', 'False'),
    el('free', 'False'), el('readonly', 'False'), el('guid', guid), el('mainmugshotindex', '-1'), el('mugshots', ''),
  ]);
}

function buildPower(item, data, guid) {
  const n = data ? cloneData(data) : el('power', [el('name', item.name), el('points', fmtNum(item.pp || 0)), el('levels', 'False'), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  const levels = (data ? data.val('levels') : '') === 'True' || !!item.level;
  const extraCost = num(data?.val('extrapointcost'));
  const ppl = data ? num(data.val('points')) : levels && item.level ? Math.max(0, (num(item.pp) - extraCost) / item.level) : num(item.pp);
  setMany(n, {
    extra: '', pointsperlevel: fmtNum(ppl), adeptway: '0', rating: String(levels ? item.level || 1 : 1), levels: B(levels), maxlevels: data?.val('maxlevels') || '0',
    discounted: 'False', discountedgeas: 'False', extrapointcost: fmtNum(extraCost), action: data?.val('action') || '', notes: item.notes || '', enhancements: '',
  });
  return n;
}

function buildSpell(item, data, guid) {
  const n = data ? cloneData(data) : el('spell', [el('name', item.name), el('category', item.category || 'Combat'), el('type', item.type || 'M'), el('range', item.range || 'LOS'), el('duration', item.duration || 'I'), el('dv', item.drain || 'F'), el('damage', ''), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  setMany(n, { descriptors: data?.val('descriptor') || '', extra: '', limited: 'False', extended: 'False', alchemical: 'False', freebonus: 'False', usesunarmed: 'False', grade: '0', notes: item.notes || '' });
  return n;
}

function buildComplexForm(item, data, guid) {
  const n = data ? cloneData(data) : el('complexform', [el('name', item.name), el('target', item.target || ''), el('duration', item.duration || ''), el('fv', item.fading || ''), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  setMany(n, { extra: '', grade: '0', notes: item.notes || '' });
  return n;
}

const LIFESTYLE_FR = { rue: 'Street', street: 'Street', squatter: 'Squatter', bas: 'Low', low: 'Low', 'bas de gamme': 'Low', moyen: 'Medium', middle: 'Medium', medium: 'Medium', 'classe moyenne': 'Medium', haut: 'High', high: 'High', 'haut de gamme': 'High', luxe: 'Luxury', luxury: 'Luxury', luxueux: 'Luxury', commercial: 'Commercial', planque: 'Bolt Hole', 'bolt hole': 'Bolt Hole', voyageur: 'Traveler', traveler: 'Traveler' };
function buildLifestyle(ls, guid) {
  // "Best Home (Moyen)" → Medium: try the name without parentheses, then each parenthesized part, then the raw name.
  const raw = String(ls.name || '');
  const keys = [raw.replace(/\s*\([^)]*\)/g, ''), ...[...raw.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]), raw].map(norm);
  const en = keys.map((k) => LIFESTYLE_FR[k]).find(Boolean) || raw;
  const data = findDataItem('lifestyles', { name: en }) || findDataItem('lifestyles', { name: 'Medium' });
  const base = data?.val('name') || 'Medium';
  return el('lifestyle', [
    el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid), el('name', ls.name || base), el('cost', fmtNum(ls.monthlyCost ?? num(data?.val('cost')))),
    el('dice', data?.val('dice') || '0'), el('lp', data?.val('lp') || '0'), el('baselifestyle', base), el('multiplier', data?.val('multiplier') || '0'), el('months', String(ls.monthsPaid ?? 1)),
    el('roommates', '0'), el('percentage', '100'), el('splitcostwithroommates', 'False'), el('purchased', 'False'), el('area', '0'), el('comforts', '0'), el('security', '0'),
    el('basearea', '0'), el('basecomforts', '0'), el('basesecurity', '0'), el('maxarea', '0'), el('maxcomforts', '0'), el('maxsecurity', '0'),
    el('costforarea', data?.val('costforarea') || '0'), el('costforcomforts', data?.val('costforcomforts') || '0'), el('costforsecurity', data?.val('costforsecurity') || '0'),
    el('allowbonuslp', 'False'), el('bonuslp', '0'), el('trustfund', '0'), el('type', 'Standard'), el('increment', 'Month'),
    el('source', data?.val('source') || 'SR5'), el('page', data?.val('page') || '0'), el('lifestylequalities', ''), el('freegrids', ''), el('notes', ''), el('city', ''), el('district', ''), el('borough', ''),
  ]);
}

function buildSkill(def, guid) {
  const n = templates().skill.clone();
  setMany(n, {
    guid, suid: def.id, skillcategory: def.category, karma: '0', base: '0', name: def.name,
    requiresgroundmovement: B(def.name === 'Running'), requiresswimmovement: B(def.name === 'Swimming'), requiresflymovement: B(def.name === 'Flight'),
  });
  return n;
}

const KNO_EN = { street: 'Street', academic: 'Academic', professional: 'Professional', interest: 'Interest', language: 'Language' };
function buildKnowledge(k, guid) {
  const type = KNO_EN[k.type] || 'Interest';
  const def = skillsData().knoByName.get(norm(k.name));
  const n = templates().skill.clone();
  setMany(n, {
    guid, suid: def?.id || '00000000-0000-0000-0000-000000000000', isknowledge: 'True', skillcategory: type, karma: '0', base: String(k.native ? 0 : k.rating || 0),
    requiresgroundmovement: 'False', requiresswimmovement: 'False', requiresflymovement: 'False', name: k.name,
  });
  setSpecs(n, k.spec);
  n.set('type', type);
  n.set('isnativelanguage', B(!!k.native));
  return n;
}

function setSpecs(skillNode, specStr) {
  const wanted = String(specStr || '').split(',').map((s) => s.trim()).filter(Boolean);
  let specs = skillNode.child('specs');
  if (!wanted.length) {
    if (specs) specs.children = specs.children.filter((ch) => ch.type === 'el' && ch.val('free') === 'True');
    if (specs && !specs.elements.length) skillNode.remove(specs);
    return;
  }
  if (!specs) specs = skillNode.insertAfter(el('specs'), skillNode.child('buywithkarma') || skillNode.child('name'));
  const existing = specs.all('spec');
  specs.children = existing.filter((sp) => wanted.includes(sp.val('name')) || sp.val('free') === 'True');
  for (const w of wanted) if (!existing.some((sp) => sp.val('name') === w)) specs.children.push(el('spec', [el('guid', newGuid()), el('name', w), el('free', 'False'), el('expertise', 'False')]));
}

// ---------------------------------------------------------------------------
// Blank character (generate mode)
// ---------------------------------------------------------------------------
const ATTR_ORDER = ['STR', 'DEP', 'MAGAdept', 'CHA', 'INT', 'AGI', 'REA', 'RES', 'ESS', 'EDG', 'MAG', 'LOG', 'BOD', 'WIL'];
const CLEAR_CONTAINERS = ['contacts', 'spells', 'foci', 'stackedfoci', 'powers', 'spirits', 'complexforms', 'aiprograms', 'martialarts', 'limitmodifiers', 'armors',
  'cyberwares', 'qualities', 'lifestyles', 'gears', 'vehicles', 'metamagics', 'arts', 'enhancements', 'critterpowers', 'initiationgrades', 'improvements',
  'sustainedobjects', 'drugs', 'mentorspirits', 'expenses', 'gearlocations', 'armorlocations', 'vehiclelocations', 'weaponlocations', 'improvementgroups', 'calendar', 'mugshots'];

/** Empty career-mode character of the actor's metatype, built from the skeleton. */
export function blankDocument(actor) {
  const doc = skeleton();
  const c = doc.root;
  const metaEn = METATYPE_EN[actor.metatype] || 'Human';
  const meta = metatypeData(metaEn) || metatypeData('Human');
  setMany(c, {
    createdversion: APP_VERSION, appversion: APP_VERSION, settings: STANDARD_SETTINGS, metatype: meta?.name || metaEn, metatypeid: meta?.id || '',
    metatypecategory: meta?.category || 'Metahuman', metatypebp: '0', metavariant: '', walk: meta?.walk || '2/1/0', run: meta?.run || '4/0/0', sprint: meta?.sprint || '2/1/0',
    walkalt: meta?.walk || '2/1/0', runalt: meta?.run || '4/0/0', sprintalt: meta?.sprint || '2/1/0', initiativedice: '1', prioritytalent: '', essenceatspecialstart: '6',
    name: '', alias: '', gender: '', age: '', description: '', background: '', concept: '', notes: '', playername: '', gamenotes: '', mainmugshotindex: '-1',
    karma: '0', special: '0', totalspecial: '0', edgeused: '0', streetcred: '0', notoriety: '0', publicawareness: '0', burntstreetcred: '0',
    created: 'True', nuyen: '0', startingnuyen: '0', adept: 'False', magician: 'False', technomancer: 'False', ai: 'False', magenabled: 'False',
    resenabled: 'False', depenabled: 'False', initiategrade: '0', submersiongrade: '0', totaless: '6', physicalcmfilled: '0', stuncmfilled: '0',
  });
  // <priorityskills> appears twice in Chummer files (the letter, then the talent skills list): empty the list.
  for (const ps of c.all('priorityskills')) if (ps.elements.length) ps.children = [];
  for (const name of CLEAR_CONTAINERS) if (c.child(name)) c.child(name).children = [];
  const attrs = c.child('attributes');
  attrs.children = ATTR_ORDER.map((k) => {
    const lim = k === 'MAGAdept' ? meta?.attrs?.MAG : meta?.attrs?.[k];
    const min = lim?.min ?? (k === 'ESS' || k === 'DEP' ? 0 : 1);
    const max = lim?.max ?? (k === 'DEP' ? 0 : 6);
    const aug = lim?.aug ?? max;
    const special = ['DEP', 'MAGAdept', 'RES', 'ESS', 'EDG', 'MAG'].includes(k);
    return el('attribute', [el('name', k), el('metatypemin', String(min)), el('metatypemax', String(max)), el('metatypeaugmax', String(aug)), el('base', '0'), el('karma', '0'), el('metatypecategory', special ? 'Special' : 'Standard'), el('totalvalue', String(k === 'ESS' ? 6 : min))]);
  });
  for (const s of c.get('newskills/skills').all('skill')) setMany(s, { guid: newGuid(), base: '0', karma: '0' });
  c.get('newskills/skills').children = c.get('newskills/skills').all('skill');
  for (const g of c.get('newskills/groups').all('group')) setMany(g, { id: newGuid(), base: '0', karma: '0', isbroken: 'False' });
  if (c.get('newskills/knoskills')) c.get('newskills/knoskills').children = [];
  setMany(c.get('newskills'), { skillptsmax: '0', skillgrpsmax: '0' });
  const weapons = c.child('weapons');
  const unarmed = templates().unarmed.clone();
  unarmed.set('guid', newGuid());
  weapons.children = [unarmed];
  const cv = c.child('calculatedvalues');
  if (cv) cv.children = [];
  return doc;
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------
function guidIndex(root) {
  const idx = new Map();
  root.walk((n, parent) => {
    const g = n.type === 'el' && n.child('guid');
    if (g && parent && n.name !== 'character') {
      const k = g.text.trim().toLowerCase();
      if (k && !idx.has(k)) idx.set(k, { node: n, parent });
    }
  });
  return idx;
}

function container(c, name) {
  let n = c.child(name);
  if (!n) {
    n = el(name);
    const ref = c.child('improvements') || c.child('expenses');
    if (ref) c.children.splice(c.children.indexOf(ref), 0, n);
    else c.children.push(n);
  }
  return n;
}

function addInt(node, field, delta) {
  node.set(field, String(Math.round(num(node.val(field)) + delta)));
}

/** Change an attribute node's value by `delta` (karma first, then base; never below the metatype minimum). */
function shiftAttribute(node, delta) {
  let karma = num(node.val('karma')) + delta;
  let base = num(node.val('base'));
  if (karma < 0) {
    base = Math.max(0, base + karma);
    karma = 0;
  }
  node.set('karma', String(karma));
  node.set('base', String(base));
  if (node.has('totalvalue')) node.set('totalvalue', String(num(node.val('totalvalue')) + delta));
}

function groupOf(c, groupName) {
  if (!groupName) return null;
  return c.get('newskills/groups')?.all('group').find((g) => norm(g.val('name')) === norm(groupName)) || null;
}

/** Change a skill node's rating by `delta`; breaks/dissolves its group when a lower rating is required. */
function shiftSkill(c, node, def, delta) {
  if (delta > 0) return addInt(node, 'karma', delta);
  let need = -delta;
  const take = (field) => {
    const have = num(node.val(field));
    const t = Math.min(have, need);
    if (t > 0) node.set(field, String(have - t));
    need -= t;
  };
  take('karma');
  take('base');
  if (need <= 0) return;
  const g = groupOf(c, def?.group);
  if (g && (num(g.val('base')) || num(g.val('karma')))) {
    const gb = num(g.val('base'));
    const gk = num(g.val('karma'));
    const sd = skillsData();
    for (const s of c.get('newskills/skills').all('skill')) {
      const sdef = sd.byId.get(s.val('suid').toLowerCase());
      if (sdef && norm(sdef.group) === norm(def.group)) {
        s.set('base', String(Math.max(num(s.val('base')), gb)));
        addInt(s, 'karma', gk);
      }
    }
    g.set('base', '0');
    g.set('karma', '0');
    take('karma');
    take('base');
  }
}

export const STREET_ADJUST = 'Ajustement Street Cred (Shadowrun Table)';
/** Custom Chummer improvement (Bonus Street Cred) holding a negative adjustment, or null. */
function streetAdjustNode(c) {
  return c.get('improvements')?.all('improvement').find((i) => i.val('customname') === STREET_ADJUST) || null;
}

/**
 * Shift Chummer's raw street cred / notoriety / public awareness by deltas. A street cred below what Chummer
 * computes from career karma (karma / 10) is stored as a negative custom « Bonus Street Cred » improvement,
 * never as a negative raw value nor as burnt street cred (which would raise notoriety).
 */
function setStreetValues(c, dStreet, dNotoriety, dAware) {
  const adj = streetAdjustNode(c);
  const total = num(c.val('streetcred')) + (adj ? num(adj.val('val')) : 0) + dStreet;
  if (total >= 0) {
    c.set('streetcred', String(total));
    if (adj) c.get('improvements').remove(adj);
  } else {
    c.set('streetcred', '0');
    if (adj) adj.set('val', String(total));
    else {
      container(c, 'improvements').children.push(el('improvement', [
        el('target', ''), el('improvedname', ''), el('sourcename', newGuid()), el('min', '0'), el('max', '0'), el('aug', '0'), el('augmax', '0'),
        el('val', String(total)), el('rating', '1'), el('exclude', ''), el('condition', ''), el('improvementttype', 'StreetCred'), el('improvementsource', 'Custom'),
        el('custom', 'True'), el('customname', STREET_ADJUST), el('customid', 'streetcred'), el('customgroup', ''), el('addtorating', '0'), el('enabled', '1'),
        el('order', '0'), el('notes', 'Street Cred fixée par le MJ dans Shadowrun Table.'), el('notesColor', 'Chocolate'),
      ]));
    }
  }
  c.set('notoriety', String(Math.max(0, num(c.val('notoriety')) + dNotoriety)));
  c.set('publicawareness', String(Math.max(0, num(c.val('publicawareness')) + dAware)));
}

function careerKarmaOf(c) {
  let k = 0;
  for (const e of c.get('expenses')?.all('expense') || []) if (e.val('type') === 'Karma' && (num(e.val('amount')) > 0 || e.val('refund') === 'True')) k += num(e.val('amount'));
  return k;
}

function isoLocal(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function expenseNode(ts, amount, reason, type) {
  return el('expense', [
    el('guid', newGuid()), el('date', isoLocal(ts)), el('amount', String(amount)), el('reason', String(reason).slice(0, 250)),
    el('type', type), el('refund', 'False'), el('forcecareervisible', 'False'),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/**
 * Build the .chum5 text for an actor.
 * Returns { xml (no BOM), mode: 'patch'|'generate', warnings: [], assigned: { [list]: { [itemId]: guid } } }.
 */
export function exportChum5(actor, { now = Date.now(), mugshots = null } = {}) {
  const warnings = [];
  warnings.missing = [];
  const stored = actor.chummer?.xml;
  let doc;
  let base;
  let mode;
  if (stored) {
    mode = 'patch';
    doc = parseXml(stored);
    base = parseChum5(stored, { keepXml: false, makeId: () => 'base' }).actor;
  } else {
    mode = 'generate';
    doc = blankDocument(actor);
    base = parseChum5(serializeXml(doc), { keepXml: false, makeId: () => 'base' }).actor;
  }
  const c = doc.root;
  const created = c.val('created') === 'True';
  const assigned = {};
  const assign = (list, item, guid) => {
    (assigned[list] ||= {})[item.id] = guid;
  };
  const changed = (k) => !eq(actor[k], base[k]);

  // --- identity & text
  if (mode === 'generate' || changed('name')) c.set('alias', actor.name);
  if (mode === 'generate' ? actor.realName : changed('realName')) c.set('name', actor.realName || '');
  const textFields = [['gender', 'gender'], ['player', 'playername'], ['concept', 'concept']];
  for (const [k, x] of textFields) if (mode === 'generate' ? actor[k] : changed(k)) c.set(x, actor[k] || '');
  if (mode === 'generate' ? actor.age : changed('age')) c.set('age', actor.age ? String(actor.age) : '');
  if (mode === 'generate') {
    if (actor.bio) c.set('description', actor.bio);
    if (actor.notes) c.set('notes', actor.notes);
  } else if (changed('notes') && !/^\s*\{\\rtf/.test(c.val('notes'))) c.set('notes', actor.notes || '');

  // --- magic / resonance flags
  const hasMag = actor.attributes?.MAG !== undefined && actor.attributes?.MAG !== null;
  const hasRes = actor.attributes?.RES !== undefined && actor.attributes?.RES !== null;
  if (hasMag && c.val('magenabled') !== 'True') c.set('magenabled', 'True');
  if (hasRes && c.val('resenabled') !== 'True') c.set('resenabled', 'True');
  if ((actor.powers || []).length && c.val('adept') !== 'True') c.set('adept', 'True');
  if ((actor.spells || []).length && c.val('magician') !== 'True') c.set('magician', 'True');
  if ((actor.complexForms || []).length && c.val('technomancer') !== 'True') c.set('technomancer', 'True');

  // --- attributes (delta against the base parse)
  const attrNodes = c.get('attributes')?.all('attribute') || [];
  for (const k of APP_ATTRS) {
    const want = actor.attributes?.[k];
    if (want === undefined || want === null) continue;
    const node = attrNodes.find((n) => n.val('name').toUpperCase() === k);
    if (!node) {
      warnings.push(`Attribut ${k} absent du fichier : non exporté.`);
      continue;
    }
    const have = base.attributes?.[k] ?? num(node.val('metatypemin')) + num(node.val('base')) + num(node.val('karma'));
    const delta = Math.round(Number(want) - have);
    if (delta) shiftAttribute(node, delta);
    const max = num(node.val('metatypemax'));
    if (max && num(node.val('metatypemin')) + num(node.val('base')) + num(node.val('karma')) > max) warnings.push(`${k} ${want} dépasse le maximum du métatype dans Chummer (${max}) : Chummer le plafonnera (qualité Attribut exceptionnel ?).`);
  }

  // --- active skills
  const sd = skillsData();
  const skillsNode = c.get('newskills/skills');
  const nodeFor = (def) => skillsNode.all('skill').find((s) => s.val('suid').toLowerCase() === def.id) || skillsNode.all('skill').find((s) => norm(s.val('name')) === norm(def.name));
  const baseSkill = new Map((base.skills || []).map((s) => [s.id, s]));
  const appSkill = new Map((actor.skills || []).map((s) => [s.id, s]));
  for (const id of new Set([...baseSkill.keys(), ...appSkill.keys()])) {
    const want = appSkill.get(id);
    const was = baseSkill.get(id);
    const def = chummerSkillFor(id, want?.name);
    if (!def) {
      if (want?.rating) warnings.push(`Compétence « ${want.name} » inconnue de Chummer : non exportée.`);
      continue;
    }
    let node = nodeFor(def);
    if (!node) {
      if (!want?.rating) continue;
      node = buildSkill(def, newGuid());
      skillsNode.children.push(node);
    }
    const delta = Math.round((Number(want?.rating) || 0) - (Number(was?.rating) || 0));
    if (delta) shiftSkill(c, node, def, delta);
    if ((want?.spec || '') !== (was?.spec || '')) setSpecs(node, want?.spec);
  }

  // --- knowledge skills (matched by guid)
  const knoNode = c.get('newskills/knoskills') || c.get('newskills').append(el('knoskills')).child('knoskills');
  const idx = guidIndex(c);
  const baseKno = new Map((base.knowledge || []).filter((k) => k.chummerGuid).map((k) => [k.chummerGuid, k]));
  const appKnoGuids = new Set((actor.knowledge || []).map((k) => k.chummerGuid).filter(Boolean));
  for (const [g] of baseKno) if (!appKnoGuids.has(g)) idx.get(g)?.parent.remove(idx.get(g).node);
  for (const k of actor.knowledge || []) {
    const hit = k.chummerGuid && idx.get(k.chummerGuid);
    if (hit && baseKno.has(k.chummerGuid)) {
      const was = baseKno.get(k.chummerGuid);
      const delta = Math.round((Number(k.rating) || 0) - (Number(was.rating) || 0));
      if (delta && !k.native) shiftSkill(c, hit.node, null, delta);
      if ((k.spec || '') !== (was.spec || '')) setSpecs(hit.node, k.spec);
      continue;
    }
    const guid = k.chummerGuid || newGuid();
    knoNode.children.push(buildKnowledge(k, guid));
    assign('knowledge', k, guid);
  }

  // --- item lists
  for (const [list, spec] of Object.entries(LISTS)) {
    const items = Array.isArray(actor[list]) ? actor[list] : [];
    const baseItems = new Map((base[list] || []).filter((i) => i.chummerGuid).map((i) => [i.chummerGuid, i]));
    const keep = new Set(items.map((i) => i.chummerGuid).filter(Boolean));
    for (const [g] of baseItems) {
      if (keep.has(g)) continue;
      const hit = idx.get(g);
      if (hit && !(list === 'weapons' && hit.node.val('name') === 'Unarmed Attack')) hit.parent.remove(hit.node); // Chummer's built-in stays
    }
    let unarmedUsed = false;
    for (const it of items) {
      const hit = it.chummerGuid && idx.get(it.chummerGuid);
      const was = it.chummerGuid && baseItems.get(it.chummerGuid);
      if (hit && was) {
        patchItem(list, hit.node, it, was);
        continue;
      }
      if (hit) continue; // present in the file but not mapped by the parser (should not happen): leave it alone
      if (list === 'weapons' && !unarmedUsed && isUnarmed(it)) {
        // The app's « Mains nues » is Chummer's built-in Unarmed Attack: reuse that node.
        const node = c.get('weapons')?.all('weapon').find((w) => w.val('name') === 'Unarmed Attack');
        if (node) {
          unarmedUsed = true;
          assign(list, it, node.val('guid').toLowerCase());
          continue;
        }
      }
      const guid = it.chummerGuid || newGuid();
      const node = buildItem(list, spec, it, guid, warnings);
      if (!node) continue;
      container(c, spec.container).children.push(node);
      assign(list, it, guid);
    }
  }

  // --- matrix device (generate mode only: in patch mode the device already is a gear item)
  if (mode === 'generate' && actor.matrix?.device) addMatrixDevice(c, actor, warnings);

  // --- lifestyle
  const ls = actor.lifestyle;
  if (ls && ls.name) {
    const hit = ls.chummerGuid && idx.get(ls.chummerGuid);
    if (hit) {
      if (!eq(ls.monthsPaid, base.lifestyle?.monthsPaid)) hit.node.set('months', String(ls.monthsPaid ?? 0));
    } else {
      const guid = ls.chummerGuid || newGuid();
      container(c, 'lifestyles').children.push(buildLifestyle(ls, guid));
      (assigned.lifestyle ||= {}).guid = guid;
    }
  }

  // --- money, karma & the career log
  const careerBefore = careerKarmaOf(c);
  c.set('karma', String(Math.round(actor.karma || 0)));
  c.set('nuyen', String(Math.round(actor.nuyen || 0)));
  if (created) addExpenses(c, actor, base, mode, now, warnings);
  else if ((actor.karma || 0) !== (base.karma || 0) || (actor.nuyen || 0) !== (base.nuyen || 0)) {
    warnings.push('Fichier en mode création : karma et nuyens écrits tels quels, sans journal de dépenses (Chummer recalcule les points de création).');
  }
  const careerAfter = careerKarmaOf(c);
  const streetDrift = created ? Math.floor(Math.max(careerAfter, 0) / 10) - Math.floor(Math.max(careerBefore, 0) / 10) : 0;
  setStreetValues(c, (actor.streetCred || 0) - (base.streetCred || 0) - streetDrift, (actor.notoriety || 0) - (base.notoriety || 0), (actor.publicAwareness || 0) - (base.publicAwareness || 0));

  // --- condition & edge
  const cond = actor.condition || {};
  c.set('physicalcmfilled', String(Math.max(0, (cond.physical || 0) + (cond.overflow || 0))));
  c.set('stuncmfilled', String(Math.max(0, cond.stun || 0)));
  if (actor.edge && actor.attributes?.EDG !== undefined) c.set('edgeused', String(Math.max(0, Math.round(actor.attributes.EDG - (actor.edge.current ?? actor.attributes.EDG)))));

  if (mode === 'generate') {
    normalizeGenerated(c);
    const ess = Number(actor.attributes?.ESS ?? 6);
    c.set('totaless', fmtNum(ess));
  }
  // Portraits: the stored file keeps no image data (see detachMugshots); they are put back here.
  if (mugshots?.length) {
    const ms = container(c, 'mugshots');
    if (!ms.elements.length) {
      ms.children = mugshots.map((b64) => el('mugshot', b64));
      if (num(c.val('mainmugshotindex'), -1) < 0 || num(c.val('mainmugshotindex')) >= mugshots.length) c.set('mainmugshotindex', '0');
    }
  }
  const missing = warnings.missing;
  delete warnings.missing;
  if (missing.length) warnings.push(`${missing.length} élément(s) absent(s) des données Chummer, exporté(s) comme objets personnalisés : ${missing.join(', ')}.`);
  return { xml: serializeXml(doc), mode, warnings, assigned };
}

/**
 * Remove the (base64) portrait data from a .chum5 so the copy kept in the game state stays small.
 * `save(b64)` stores one image and returns its URL (or null to keep that image in the XML).
 * Returns { xml, urls, mainIndex }.
 */
export function detachMugshots(xml, save) {
  if (!/<mugshot>/.test(xml)) return { xml, urls: [], mainIndex: -1 };
  const doc = parseXml(xml);
  const ms = doc.root.child('mugshots');
  const urls = [];
  const kept = [];
  for (const m of ms?.all('mugshot') || []) {
    const url = save(m.text.trim());
    if (url) urls.push(url);
    else kept.push(m);
  }
  if (kept.length) return { xml, urls: [], mainIndex: -1 }; // unknown image format: leave the file untouched
  ms.children = [];
  return { xml: serializeXml(doc), urls, mainIndex: num(doc.root.val('mainmugshotindex'), 0) };
}

function buildItem(list, spec, it, guid, warnings) {
  const kind = spec.kind(it);
  const data = kind ? resolveData(kind, it) : null;
  if (!data && ['weapons', 'armor', 'vehicles', 'powers', 'spells', 'complexForms'].includes(list)) warnings.missing.push(it.name);
  switch (list) {
    case 'weapons':
      return buildWeapon(it, data, guid);
    case 'armor':
      return buildArmor(it, data, guid);
    case 'augmentations': {
      const d = data || resolveData(kind === 'bioware' ? 'cyberware' : 'bioware', it);
      const k = d && d.name === 'bioware' ? 'bioware' : d ? 'cyberware' : kind;
      if (!d) warnings.missing.push(it.name);
      return buildWare(it, d, guid, k);
    }
    case 'gear':
      if (!data) warnings.missing.push(it.name);
      return buildGear(it, data, guid, { forceCustom: !data });
    case 'sins':
      return buildSin(it, guid);
    case 'vehicles':
      return buildVehicle(it, data, guid);
    case 'contacts':
      return buildContact(it, guid);
    case 'qualities':
      if (!data) warnings.missing.push(it.name);
      return buildQuality(it, data, guid);
    case 'powers':
      return buildPower(it, data, guid);
    case 'spells':
      return buildSpell(it, data, guid);
    case 'complexForms':
      return buildComplexForm(it, data, guid);
    default:
      return null;
  }
}

/** Fields the app may change on an item that already exists in the file. */
function patchItem(list, node, it, was) {
  const diff = (k) => !eq(it[k], was[k]);
  if (list === 'armor' && diff('equipped')) node.set('equipped', B(it.equipped));
  if ((list === 'gear' || list === 'sins') && diff('rating')) node.set('rating', String(it.rating || 0));
  if (list === 'gear' && diff('qty')) node.set('qty', String(it.qty ?? 1));
  if (list === 'augmentations' && diff('rating')) node.set('rating', String(it.rating || 0));
  if (list === 'augmentations' && diff('grade')) node.set('grade', GRADE_EN[it.grade] || 'Standard');
  if (list === 'contacts') {
    if (diff('connection')) node.set('connection', String(it.connection ?? 1));
    if (diff('loyalty')) node.set('loyalty', String(it.loyalty ?? 1));
    if (diff('role')) node.set('role', it.role || '');
  }
  if (list === 'powers' && diff('level')) node.set('rating', String(it.level || 1));
  if (list === 'vehicles' && diff('name') && node.has('vehiclename')) node.set('vehiclename', it.name);
}

function addMatrixDevice(c, actor, warnings) {
  const m = actor.matrix;
  const devName = String(m.device).replace(/\s*\((commlink|cyberdeck|deck|console)\)\s*$/i, '').trim();
  const already = (actor.gear || []).some((g) => norm(g.name).includes(norm(devName)) || norm(devName).includes(norm(g.name)));
  if (already) return;
  const data = findDataItem('gear', { name: devName }) || resolveData('gear', { name: devName });
  const node = buildGear({ name: devName, rating: 0, qty: 1 }, data, newGuid(), { forceCustom: !data });
  if (!data) {
    node.set('category', 'Commlinks');
    node.set('devicerating', String(m.rating || 0));
    node.set('attributearray', `${m.attack || 0},${m.sleaze || 0},${m.dataProcessing || 0},${m.firewall || 0}`);
    warnings.push(`Appareil matriciel « ${m.device} » introuvable dans Chummer : exporté comme « Custom Item ».`);
  }
  const kids = [];
  for (const p of m.programs || []) {
    const pd = findDataItem('gear', { name: p }) || resolveData('gear', { name: p });
    if (pd) kids.push(buildGear({ name: p, qty: 1 }, pd, newGuid()));
  }
  node.child('children').children = kids;
  container(c, 'gears').children.push(node);
}

/** Career log: one <expense> per karma/nuyen history entry since the last sync, plus balancing entries. */
function addExpenses(c, actor, base, mode, now, warnings) {
  const since = mode === 'generate' ? -Infinity : Number(actor.chummer?.syncedAt || actor.chummer?.importedAt || 0);
  const exp = container(c, 'expenses');
  const entries = (actor.history || []).filter((h) => h && !h.chummer && Number(h.ts) > since && (Number(h.karma) || Number(h.nuyen)));
  let sumK = 0;
  let posK = 0;
  let sumN = 0;
  const add = (ts, amount, reason, type) => {
    if (!amount) return;
    exp.children.push(expenseNode(ts, amount, reason, type));
    if (type === 'Karma') {
      sumK += amount;
      if (amount > 0) posK += amount;
    } else sumN += amount;
  };
  for (const h of entries) {
    const why = `${h.text || 'Shadowrun Table'}`;
    if (Number(h.karma)) add(Number(h.ts), Math.round(Number(h.karma)), why, 'Karma');
    if (Number(h.nuyen)) add(Number(h.ts), Math.round(Number(h.nuyen)), why, 'Nuyen');
  }
  const netK = Math.round((actor.karma || 0) - (base.karma || 0));
  if (netK !== sumK) add(now, netK - sumK, 'Ajustement de karma (Shadowrun Table)', 'Karma');
  const career = Math.round((actor.karmaTotal || 0) - (base.karmaTotal || 0));
  if (career > posK) {
    const d = career - posK;
    add(now, d, 'Karma de carrière (Shadowrun Table)', 'Karma');
    add(now, -d, 'Karma dépensé (Shadowrun Table)', 'Karma');
  } else if (career < posK) warnings.push('Le karma de carrière dans Chummer sera supérieur à celui de l’app (journal des gains).');
  const netN = Math.round((actor.nuyen || 0) - (base.nuyen || 0));
  if (netN !== sumN) add(now, netN - sumN, 'Ajustement de nuyens (Shadowrun Table)', 'Nuyen');
}

/** Generated files: values bought « at creation » (base) rather than with karma, within Chummer's limits. */
function normalizeGenerated(c) {
  for (const a of c.get('attributes').all('attribute')) {
    const room = Math.max(0, num(a.val('metatypemax')) - num(a.val('metatypemin')));
    const total = num(a.val('base')) + num(a.val('karma'));
    a.set('base', String(Math.min(total, room)));
    a.set('karma', String(total - Math.min(total, room)));
    const k = a.val('name');
    if (k !== 'ESS') a.set('totalvalue', String(num(a.val('metatypemin')) + total));
  }
  for (const s of [...c.get('newskills/skills').all('skill'), ...(c.get('newskills/knoskills')?.all('skill') || [])]) {
    const total = num(s.val('base')) + num(s.val('karma'));
    s.set('base', String(Math.min(total, 6)));
    s.set('karma', String(total - Math.min(total, 6)));
  }
}

export { KNOWLEDGE_TYPES };
