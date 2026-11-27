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
import { parseXml, serializeXml, Element, el, type XmlDocument } from './xml.ts';
import { parseChum5, APP_ATTRS, type ParsedActor } from './parse.ts';
import { warningList } from './messages.ts';
import {
  skillsData, chummerSkillFor, metatypeData, METATYPE_EN, findDataItem, findCatalogEntry, norm, type ChummerSkillDef, type DataKind,
} from './data.ts';
import { KNOWLEDGE_TYPES } from '../../../client/modules/sheet/sheet-data.ts';
import type {
  Accessory, Actor, AdeptPower, Armor, ArmorMod, Augmentation, ComplexForm, Contact, I18nMessage, ItemBase, KnowledgeSkill, Lifestyle, LifestyleQuality, MartialArt,
  MartialArtTechnique, Quality, Sin, Spell, Vehicle, VehicleMod, Weapon,
} from '../../../shared/types.ts';

/**
 * An item of any actor list, as the generic export loop handles it (patchItem / syncSubs read the fields of every list;
 * the list name tells which ones apply). The builders take the concrete item types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyItem = ItemBase & Record<string, any>;
/** The actor (or its base parse) indexed by list name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListsRec = Record<string, any>;
/** Records the guid given to a new nested item (accessory, mod, lifestyle quality, technique). */
export type AssignSub = (x: { id?: string } | null | undefined, guid: string) => void;
/** Where an actor list lives in the file. */
export interface ListSpec {
  container: string;
  node: string;
  kind(it: AnyItem): DataKind | null;
}
/** A nested item of any kind (sub-list entry). */
type SubItem = Accessory | ArmorMod | VehicleMod | LifestyleQuality | MartialArtTechnique;
/** Nested list spec (SUB_SPECS). */
interface SubSpec {
  sub: string;
  container: string;
  node: string;
  build(x: SubItem, guid: string): Element;
}
/** Fields read by buildGear() (gear items, but also SINs, licenses, matrix devices and programs). */
interface GearInput {
  name: string;
  rating?: number;
  qty?: number;
  notes?: string;
  extra?: string;
}
/** The French warning list of an export, carrying add() and the missing item names while it runs. */
interface ExportWarnings extends Array<string> {
  add: (m: I18nMessage) => void;
  missing: string[];
}
/** Guids given to new items: assigned[list][itemId], assigned.sub[subItemId]. */
export type Assigned = Record<string, Record<string, string>>;
/** exportChum5() result. */
export interface ExportResult {
  xml: string;
  mode: 'patch' | 'generate';
  warnings: string[];
  warningsI18n: I18nMessage[];
  assigned: Assigned;
}
/** Item templates taken from the skeleton file. */
interface Templates {
  weapon: Element;
  unarmed: Element;
  quality: Element;
  skill: Element;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKELETON_FILE = path.join(HERE, 'skeleton.chum5');
export const APP_VERSION = '5.226.0';
export const STANDARD_SETTINGS = '223a11ff-80e0-428b-89a9-6ef1c243b8b6';

const newGuid = () => crypto.randomUUID();
const num = (s: unknown, d = 0): number => {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : d;
};
const B = (v: unknown): string => (v ? 'True' : 'False');
const fmtNum = (n: unknown): string => String(Math.round(Number(n) * 10000) / 10000);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Actor list → where its items live in the file. */
export const LISTS: Record<string, ListSpec> = {
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
  lifestyles: { container: 'lifestyles', node: 'lifestyle', kind: () => null },
  martialArts: { container: 'martialarts', node: 'martialart', kind: () => 'martialarts' },
};

// ---------------------------------------------------------------------------
// Skeleton & templates (from the real Chummer file)
// ---------------------------------------------------------------------------
let skeletonText: string | null = null;
function skeleton(): XmlDocument {
  if (skeletonText === null) skeletonText = fs.readFileSync(SKELETON_FILE, 'utf8').replace(/^﻿/, '');
  return parseXml(skeletonText);
}
let tpl: Templates | null = null;
function templates(): Templates {
  if (tpl) return tpl;
  const c = skeleton().root;
  const weapons = c.get('weapons')!.all('weapon');
  tpl = {
    weapon: weapons.find((w) => w.val('name') !== 'Unarmed Attack')!,
    unarmed: weapons.find((w) => w.val('name') === 'Unarmed Attack')!,
    quality: c.get('qualities')!.child('quality')!,
    skill: c.get('newskills/skills')!.child('skill')!,
  };
  return tpl;
}

/** Remove data-file-only elements from a cloned data node. */
const DATA_ONLY = new Set([
  'id', 'hide', 'required', 'forbidden', 'translate', 'altpage', 'altnameonpage', 'nameonpage', 'onlyprioritygiven', 'addweapon', 'subsystems',
  'allowgear', 'pairbonus', 'wirelesspairbonus', 'pairinclude', 'wirelesspairinclude', 'mods', 'weaponmounts', 'accessorymounts', 'accessories',
  'underbarrels', 'specs', 'costfor', 'adeptwayrequires', 'mutant', 'ammoforweapontype', 'ammobonus',
]);
function cloneData(dataNode: Element, rename: Record<string, string> = {}): Element {
  const n = dataNode.clone();
  n.attrs = [];
  n.children = n.children.filter((ch) => {
    if (ch.type !== 'el') return false;
    if (ch.name === 'gears' && ch.child('usegear')) return false;
    return !DATA_ONLY.has(ch.name);
  });
  for (const ch of n.children as Element[]) if (rename[ch.name]) ch.name = rename[ch.name];
  if (n.child('bonus')) n.child('bonus')!.attrs = [];
  return n;
}
/** Put sourceid + guid first, like Chummer. */
function head(n: Element, sourceid: string | null | undefined, guid: string): Element {
  n.children = n.children.filter((ch) => !(ch.type === 'el' && (ch.name === 'sourceid' || ch.name === 'guid')));
  n.children.unshift(el('sourceid', sourceid || '00000000-0000-0000-0000-000000000000'), el('guid', guid));
  return n;
}
function setMany(n: Element, obj: Record<string, unknown>): Element {
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) n.set(k, v === null ? '' : String(v));
  return n;
}

/** English name hidden in seed notes: "Low-Light Vision (SR5 p.66)." → "Low-Light Vision". */
function englishHint(notes: unknown): string | null {
  const m = String(notes || '').match(/^([A-Z][^()\n.:;]{2,60}?)\s*\(([A-Za-z0-9 &'’]+)\s+p\.\s*\d+/);
  return m ? m[1].trim() : null;
}

/** Find the Chummer data node for an app item (catalogId → app catalog name → notes hint → name). */
export function resolveData(kind: DataKind | null, item: { catalogId?: string | null; name?: string; notes?: string }, extraNames: string[] = []): Element | null {
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
const GRADE_EN: Record<string, string> = { standard: 'Standard', alpha: 'Alphaware', beta: 'Betaware', delta: 'Deltaware', used: 'Used' };

const UNARMED_ID = '63dcfdb6-bbd9-4a58-bbf4-cd35f7614fdc';
const isUnarmed = (it: AnyItem): boolean => String(it.catalogId || '').toLowerCase() === UNARMED_ID || /^(mains nues|unarmed attack|attaque à mains nues)$/i.test(String(it.name || '').trim());

/** Chummer weapon category for a custom (unknown) weapon, from its app skill. */
const SKILL_CATEGORY: Record<string, string> = {
  pistols: 'Heavy Pistols', automatics: 'Submachine Guns', longarms: 'Shotguns', heavy_weapons: 'Heavy Machine Guns', blades: 'Blades', clubs: 'Clubs',
  unarmed_combat: 'Unarmed', throwing_weapons: 'Throwing Weapons', archery: 'Bows', exotic_weapon: 'Exotic Ranged Weapons', gunnery: 'Assault Cannons',
};

function buildWeapon(item: Weapon, data: Element | null, guid: string, assignSub?: AssignSub): Element {
  const n = templates().weapon.clone();
  const d = (k: string, fb = ''): string => (data ? data.val(k) : '') || fb;
  const melee = (data ? data.val('type') === 'Melee' : item.kind === 'melee');
  const mounts = data?.get('accessorymounts')?.all('mount').map((m) => m.text) || [];
  const damage = d('damage', String(item.damage || '').replace(/\bSTR\b/g, '{STR}'));
  const have = new Set((item.accessories || []).map((x) => norm(x.name)));
  const builtIn = (data?.get('accessories')?.all('accessory') || []).map((a) => a.val('name')).filter((nm) => nm && !have.has(norm(nm)));
  const notes = [item.notes || '', builtIn.length ? `Accessoires d’origine à rajouter dans Chummer : ${builtIn.join(', ')}` : ''].filter(Boolean).join(' — ');
  setMany(n, {
    sourceid: data ? data.val('id') : '00000000-0000-0000-0000-000000000000', guid,
    name: data ? data.val('name') : item.name, category: d('category', SKILL_CATEGORY[item.skill] || (melee ? 'Blades' : 'Heavy Pistols')),
    type: melee ? 'Melee' : 'Ranged', spec: d('spec'), spec2: d('spec2'), reach: d('reach', String(item.reach ?? 0)), damage,
    ap: d('ap', String(item.ap ?? 0)), mode: d('mode', item.mode || '0'), rc: d('rc', String(item.rc ?? 0)), ammo: d('ammo', item.ammo || '0'),
    conceal: d('conceal', '0'), avail: d('avail', '0'), cost: d('cost', '0'), useskill: d('useskill'), useskillspec: d('useskillspec'),
    range: d('range'), alternaterange: d('alternaterange'), source: d('source', 'SR5'), page: d('page', '0'),
    allowaccessory: B(mounts.length > 0), weaponslots: mounts.join('/'), weaponname: data ? '' : '', equipped: 'True', // the app's « ready » is not Chummer's <equipped>
    notes, weapontype: d('weapontype', melee ? 'melee' : 'gun'), ammocategory: d('ammocategory'),
  });
  if (!data) n.set('weaponname', item.name);
  // The template holds <accuracy> twice (Chummer writes it twice): set both.
  for (const acc of n.all('accuracy')) acc.text = d('accuracy', String(item.accuracy ?? (melee ? 'Physical' : '0')));
  const accs = n.child('accessories') || n.insertAfter(el('accessories'), n.child('extramount') || n.child('mount'));
  accs.children = subNodes('weapons', item, assignSub);
  return n;
}

function buildQuality(item: Quality, data: Element | null, guid: string): Element {
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
  if (flb && n.child('firstlevelbonus')) n.child('firstlevelbonus')!.children = flb.clone().children;
  return n;
}

function buildArmor(item: Armor, data: Element | null, guid: string, assignSub?: AssignSub): Element {
  const n = data ? cloneData(data, { rating: 'maxrating' }) : el('armor', [el('name', item.name), el('category', 'Armor'), el('armor', String(item.stack ? `+${item.rating || 0}` : item.rating || 0)), el('armorcapacity', '0'), el('avail', '0'), el('cost', '0'), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  setMany(n, { rating: String(item.rating && data?.has('maxrating') ? item.rating : 0), equipped: B(item.equipped), wirelesson: 'True', extra: '', notes: item.notes || '', location: '', armormods: '', gears: '' });
  if (!data) n.set('armorname', item.name);
  n.child('armormods')!.children = subNodes('armor', item, assignSub);
  return n;
}

function buildWare(item: Augmentation, data: Element | null, guid: string, kind: string | null): Element {
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

function buildGear(item: GearInput, data: Element | null, guid: string, { forceCustom = false }: { forceCustom?: boolean } = {}): Element {
  let n: Element;
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

function buildSin(item: Sin, guid: string): Element {
  const data = findDataItem('gear', { name: 'Fake SIN' });
  const n = buildGear({ name: 'Fake SIN', rating: item.rating || 1, qty: 1, notes: item.notes, extra: item.name }, data, guid);
  const lic = findDataItem('gear', { name: 'Fake License' });
  const kids = (item.licenses || []).map((l) => buildGear({ name: 'Fake License', rating: item.rating || 1, qty: 1, extra: l }, lic, newGuid()));
  n.child('children')!.children = kids;
  return n;
}

function buildVehicle(item: Vehicle, data: Element | null, guid: string, assignSub?: AssignSub): Element {
  const n = data
    ? cloneData(data)
    : el('vehicle', [el('name', item.name), el('category', 'Cars'), el('avail', '0'), el('cost', '0'), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  if (!data) setMany(n, { handling: item.handling || '0', accel: item.accel || '0', speed: item.speed || '0', pilot: item.pilot || 0, body: item.body || 0, armor: item.armor || 0, sensor: item.sensor || 0, seats: item.seats || 0 });
  setMany(n, { physicalcmfilled: '0', matrixcmfilled: '0', vehiclename: data ? '' : item.name, notes: item.notes || '', mods: '', weapons: '', gears: '', locations: '', homenode: 'False', wirelesson: 'True' });
  n.child('mods')!.children = subNodes('vehicles', item, assignSub);
  return n;
}

function buildContact(item: Contact, guid: string): Element {
  const enemy = /ENNEMI/.test(item.notes || '');
  return el('contact', [
    el('name', item.name), el('role', item.role || ''), el('location', ''), el('connection', String(item.connection ?? 1)), el('loyalty', String(item.loyalty ?? 1)),
    el('metatype', ''), el('gender', ''), el('age', ''), el('contacttype', ''), el('preferredpayment', ''), el('hobbiesvice', ''), el('personallife', ''),
    el('type', enemy ? 'Enemy' : 'Contact'), el('file', ''), el('relative', 'False'), el('notes', String(item.notes || '').replace(/^ENNEMI( — )?/, '')),
    el('notesColor', 'Chocolate'), el('groupname', ''), el('colour', ''), el('group', 'False'), el('family', 'False'), el('blackmail', 'False'),
    el('free', 'False'), el('readonly', 'False'), el('guid', guid), el('mainmugshotindex', '-1'), el('mugshots', ''),
  ]);
}

function buildPower(item: AdeptPower, data: Element | null, guid: string): Element {
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

function buildSpell(item: Spell, data: Element | null, guid: string): Element {
  const n = data ? cloneData(data) : el('spell', [el('name', item.name), el('category', item.category || 'Combat'), el('type', item.type || 'M'), el('range', item.range || 'LOS'), el('duration', item.duration || 'I'), el('dv', item.drain || 'F'), el('damage', ''), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  setMany(n, { descriptors: data?.val('descriptor') || '', extra: '', limited: 'False', extended: 'False', alchemical: 'False', freebonus: 'False', usesunarmed: 'False', grade: '0', notes: item.notes || '' });
  return n;
}

function buildComplexForm(item: ComplexForm & { target?: string }, data: Element | null, guid: string): Element {
  const n = data ? cloneData(data) : el('complexform', [el('name', item.name), el('target', item.target || ''), el('duration', item.duration || ''), el('fv', item.fading || ''), el('source', 'SR5'), el('page', '0')]);
  head(n, data?.val('id'), guid);
  setMany(n, { extra: '', grade: '0', notes: item.notes || '' });
  return n;
}

const LIFESTYLE_FR: Record<string, string> = { rue: 'Street', street: 'Street', squatter: 'Squatter', bas: 'Low', low: 'Low', 'bas de gamme': 'Low', moyen: 'Medium', middle: 'Medium', medium: 'Medium', 'classe moyenne': 'Medium', haut: 'High', high: 'High', 'haut de gamme': 'High', luxe: 'Luxury', luxury: 'Luxury', luxueux: 'Luxury', commercial: 'Commercial', planque: 'Bolt Hole', 'bolt hole': 'Bolt Hole', voyageur: 'Traveler', traveler: 'Traveler' };
/** Chummer base lifestyle data node of an app lifestyle (catalogId, base, then the name: "Best Home (Moyen)" → Medium). */
function lifestyleData(ls: Lifestyle): Element | null {
  if (ls.catalogId) {
    const n = findDataItem('lifestyles', { id: ls.catalogId });
    if (n) return n;
  }
  if (ls.base) {
    const n = findDataItem('lifestyles', { name: ls.base });
    if (n) return n;
  }
  const raw = String(ls.name || '');
  const keys = [raw.replace(/\s*\([^)]*\)/g, ''), ...[...raw.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]), raw].map(norm);
  const en = keys.map((k) => LIFESTYLE_FR[k]).find(Boolean) || raw;
  return findDataItem('lifestyles', { name: en }) || findDataItem('lifestyles', { name: 'Medium' });
}
function buildLifestyle(ls: Lifestyle, guid: string, assignSub?: AssignSub): Element {
  const data = lifestyleData(ls);
  const base = data?.val('name') || 'Medium';
  const p = ls.points || null;
  return el('lifestyle', [
    el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid), el('name', ls.name || base), el('cost', fmtNum(ls.baseCost ?? num(data?.val('cost')))),
    el('dice', data?.val('dice') || '0'), el('lp', data?.val('lp') || '0'), el('baselifestyle', base), el('multiplier', data?.val('multiplier') || '0'), el('months', String(ls.monthsPaid ?? 1)),
    el('roommates', '0'), el('percentage', '100'), el('splitcostwithroommates', 'False'), el('purchased', 'False'), el('area', '0'), el('comforts', '0'), el('security', '0'),
    el('basearea', String(p?.neighborhood ?? 0)), el('basecomforts', String(p?.comforts ?? 0)), el('basesecurity', String(p?.security ?? 0)), el('maxarea', '0'), el('maxcomforts', '0'), el('maxsecurity', '0'),
    el('costforarea', data?.val('costforarea') || '0'), el('costforcomforts', data?.val('costforcomforts') || '0'), el('costforsecurity', data?.val('costforsecurity') || '0'),
    el('allowbonuslp', 'False'), el('bonuslp', '0'), el('trustfund', '0'), el('primarytenant', B(!!ls.primary)), el('type', p ? 'Advanced' : 'Standard'), el('increment', 'Month'),
    el('source', data?.val('source') || 'SR5'), el('page', data?.val('page') || '0'),
    el('lifestylequalities', subNodes('lifestyles', ls, assignSub)),
    el('freegrids', ''), el('notes', ls.notes || ''), el('city', ''), el('district', ''), el('borough', ''),
  ]);
}

/** Chummer <extra> of a nested item: "Local Bar Patron (The Jeffrey’s)" with data "Local Bar Patron" → "The Jeffrey’s". */
function extraOf(item: { name?: string }, data: Element | null): string {
  if (!data || norm(data.val('name')) === norm(item.name)) return '';
  const dn = data.val('name');
  if (String(item.name || '').startsWith(`${dn} (`)) return String(item.name).slice(dn.length + 2, -1);
  return '';
}

const QUALITY_TYPE = (cat: string): string => (/^Entertainment/i.test(cat) ? 'Entertainment' : cat || 'Positive');
function buildLifestyleQuality(q: LifestyleQuality, guid: string): Element {
  const data = resolveData('lifestylequalities', q);
  const cat = data?.val('category') || q.category || 'Positive';
  const baseMult = data ? data.val('multiplierbaseonly') || '0' : q.baseOnly ? String(q.multiplier || 0) : '0';
  const mult = data ? data.val('multiplier') || '0' : q.baseOnly ? '0' : String(q.multiplier || 0);
  const bonus = data?.child('bonus') ? data.child('bonus')!.clone() : el('bonus');
  bonus.attrs = [];
  return el('lifestylequality', [
    el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid), el('name', data ? data.val('name') : q.name), el('category', cat),
    el('extra', extraOf(q, data)), el('cost', data ? data.val('cost') : q.cost ? fmtNum(q.cost) : ''), el('multiplier', mult), el('basemultiplier', baseMult),
    el('lp', data?.val('lp') || String(q.lp ?? 0)), el('areamaximum', data?.val('areamaximum') || '0'), el('comfortsmaximum', data?.val('comfortsmaximum') || '0'),
    el('securitymaximum', data?.val('securitymaximum') || '0'), el('area', data?.val('area') || '0'), el('comforts', data?.val('comforts') || '0'), el('security', data?.val('security') || '0'),
    el('contributetolimit', 'True'), el('print', 'True'), el('lifestylequalitytype', QUALITY_TYPE(cat)), el('lifestylequalitysource', 'Selected'),
    el('source', data?.val('source') || 'SR5'), el('page', data?.val('page') || '0'), el('allowed', data?.val('allowed') || ''), bonus, el('notes', q.notes || ''),
  ]);
}

function buildAccessory(x: Accessory, guid: string): Element {
  const data = resolveData('accessories', x);
  const d = (k: string, fb = ''): string => (data ? data.val(k) : '') || fb;
  const fx: NonNullable<Accessory['effects']> = x.effects || {};
  const mount = x.mount || String(d('mount')).split('/')[0] || 'None';
  return el('accessory', [
    el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid), el('name', data ? data.val('name') : x.name), el('mount', mount || 'None'),
    el('extramount', d('extramount', 'None')), el('rc', d('rc', fx.rc ? String(fx.rc) : '')), el('maxrating', d('rating', '0')), el('rating', String(x.rating || 0)),
    el('ratinglabel', 'String_Rating'), el('rcgroup', d('rcgroup', String(fx.rcGroup || 0))), el('rcdeployable', d('rcdeployable', 'False')), el('specialmodification', d('specialmodification', 'False')),
    el('conceal', d('conceal', '0')), el('avail', d('avail', x.avail || '0')), el('cost', d('cost', fmtNum(x.cost || 0))), el('included', B(!!x.included)), el('equipped', B(x.equipped !== false)),
    el('source', d('source', 'SR5')), el('page', d('page', '0')), el('accuracy', d('accuracy', String(fx.smartgun ? 2 : fx.accuracy || 0))),
    el('ammoreplace', ''), el('ammoslots', d('ammoslots', '0')), el('modifyammocapacity', ''), el('damagetype', ''), el('damage', ''), el('damagereplace', ''), el('firemode', ''), el('firemodereplace', ''),
    el('ap', ''), el('apreplace', ''), el('notes', x.notes || ''), el('discountedcost', 'False'), el('addmode', ''), el('singleshot', '0'), el('shortburst', '0'), el('longburst', '0'),
    el('fullburst', '0'), el('suppressive', '0'), el('rangebonus', '0'), el('rangemodifier', '0'), el('extra', extraOf(x, data)), el('ammobonus', '0'), el('wirelesson', 'False'), el('wirelessbonus', ''),
    el('stolen', 'False'), el('sortorder', '0'),
  ]);
}

function buildArmorMod(m: ArmorMod & { equipped?: boolean }, guid: string): Element {
  const data = resolveData('armormods', m);
  const d = (k: string, fb = ''): string => (data ? data.val(k) : '') || fb;
  const bonus = data?.child('bonus') ? data.child('bonus')!.clone() : el('bonus');
  return el('armormod', [
    el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid), el('name', data ? data.val('name') : m.name), el('category', d('category', 'General')),
    el('armor', d('armor', String(m.effects?.armor || 0))), el('armorcapacity', m.included ? '[0]' : d('armorcapacity', `[${fmtNum(m.capacity || 0)}]`)), el('gearcapacity', ''),
    el('maxrating', d('maxrating', '0')), el('rating', String(m.rating || 0)), el('ratinglabel', 'String_Rating'), el('avail', d('avail', m.avail || '0')), el('cost', m.included ? '0' : d('cost', fmtNum(m.cost || 0))),
    bonus, el('wirelessbonus', ''), el('wirelesson', 'False'), el('source', d('source', 'SR5')), el('page', d('page', '0')), el('included', B(!!m.included)), el('equipped', B(m.equipped !== false)),
    el('extra', extraOf(m, data)), el('stolen', 'False'), el('notes', m.notes || ''), el('discountedcost', 'False'), el('sortorder', '0'),
  ]);
}

function buildVehicleMod(m: VehicleMod, guid: string): Element {
  const data = resolveData('vehiclemods', m);
  const d = (k: string, fb = ''): string => (data ? data.val(k) : '') || fb;
  const bonus = data?.child('bonus') ? data.child('bonus')!.clone() : el('bonus');
  return el('mod', [
    el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid), el('name', data ? data.val('name') : m.name), el('category', d('category', m.category || 'Body')),
    el('limit', ''), el('slots', d('slots', fmtNum(m.slots || 0))), el('capacity', ''), el('rating', String(m.rating || 0)), el('maxrating', d('rating', '0')), el('ratinglabel', 'String_Rating'),
    el('conditionmonitor', '0'), el('avail', d('avail', m.avail || '0')), el('cost', d('cost', fmtNum(m.cost || 0))), el('markup', '0'), el('extra', extraOf(m, data)), el('source', d('source', 'R5')), el('page', d('page', '0')),
    el('included', B(!!m.included)), el('equipped', 'True'), el('wirelesson', 'False'), el('subsystems', ''), el('weaponmountcategories', ''), el('ammobonus', '0'), el('ammobonuspercent', '0'),
    el('ammoreplace', ''), el('weapons', ''), bonus, el('notes', m.notes || ''), el('discountedcost', 'False'), el('sortorder', '0'), el('stolen', 'False'),
  ]);
}

function buildTechnique(t: MartialArtTechnique, guid: string): Element {
  const data = resolveData('techniques', t);
  return el('martialarttechnique', [
    el('guid', guid), el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('name', data ? data.val('name') : t.name), el('notes', t.notes || ''),
    el('notesColor', 'Chocolate'), el('source', data?.val('source') || 'RG'), el('page', data?.val('page') || '0'),
  ]);
}

function buildMartialArt(item: MartialArt, data: Element | null, guid: string, assignSub?: AssignSub): Element {
  return el('martialart', [
    el('name', data ? data.val('name') : item.name), el('sourceid', data?.val('id') || '00000000-0000-0000-0000-000000000000'), el('guid', guid),
    el('source', data?.val('source') || 'RG'), el('page', data?.val('page') || '0'), el('rating', String(item.rating || 1)), el('cost', '7'), el('isquality', 'False'),
    el('martialarttechniques', subNodes('martialArts', item, assignSub)), el('notes', item.notes || ''), el('notesColor', 'Chocolate'),
  ]);
}

/** Nested lists of list items: where they live in the item node and how to build a new one. */
const SUB_SPECS: Record<string, SubSpec> = {
  weapons: { sub: 'accessories', container: 'accessories', node: 'accessory', build: buildAccessory },
  armor: { sub: 'mods', container: 'armormods', node: 'armormod', build: buildArmorMod },
  vehicles: { sub: 'mods', container: 'mods', node: 'mod', build: buildVehicleMod },
  lifestyles: { sub: 'qualities', container: 'lifestylequalities', node: 'lifestylequality', build: buildLifestyleQuality },
  martialArts: { sub: 'techniques', container: 'martialarttechniques', node: 'martialarttechnique', build: buildTechnique },
};
/** New nodes for the nested items of a NEW item node (a sub-item keeps its guid, else gets one recorded with assignSub). */
function subNodes(list: string, it: object, assignSub: AssignSub = () => {}): Element[] {
  const spec = SUB_SPECS[list];
  const subs = (it as Record<string, unknown>)[spec.sub];
  return (Array.isArray(subs) ? subs : []).map((x: SubItem) => {
    const guid = x.chummerGuid || newGuid();
    if (!x.chummerGuid) assignSub(x, guid);
    return spec.build(x, guid);
  });
}
const noIds = (list: Array<{ id?: string }> | null | undefined) => (list || []).map(({ id, ...rest }) => rest);

/**
 * Bring the nested nodes of an item node in line with the app item: sub-items removed in the app (by guid) are deleted,
 * new ones (no node with their guid) are built and their guid recorded with assignSub(subItem, guid).
 */
function syncSubs(list: string, node: Element, it: AnyItem, was: AnyItem | undefined, assignSub: AssignSub): void {
  const spec = SUB_SPECS[list];
  if (!spec) return;
  const want = Array.isArray(it[spec.sub]) ? it[spec.sub] : [];
  const had = Array.isArray(was?.[spec.sub]) ? was[spec.sub] : [];
  if (eq(noIds(want), noIds(had))) return;
  let cont = node.child(spec.container);
  if (!cont) {
    if (!want.length) return;
    cont = node.append(el(spec.container)).child(spec.container)!;
  }
  const byGuid = new Map(cont.all(spec.node).map((n) => [n.val('guid').trim().toLowerCase(), n]));
  const keep = new Set(want.map((x: SubItem) => x.chummerGuid).filter(Boolean));
  for (const h of had) if (h.chummerGuid && !keep.has(h.chummerGuid) && byGuid.has(h.chummerGuid)) cont.remove(byGuid.get(h.chummerGuid)!);
  const hadBy = new Map<string, AnyItem>(had.filter((h: AnyItem) => h.chummerGuid).map((h: AnyItem) => [h.chummerGuid, h]));
  for (const x of want) {
    const n = x.chummerGuid && byGuid.get(x.chummerGuid);
    if (n) {
      const h = hadBy.get(x.chummerGuid);
      if (h && !eq(x.rating || 0, h.rating || 0) && n.has('rating')) n.set('rating', String(x.rating || 0));
      if (h && !eq(x.notes || '', h.notes || '') && n.has('notes') && !/^\s*\{\\rtf/.test(n.val('notes'))) n.set('notes', x.notes || '');
      continue;
    }
    const guid = newGuid();
    cont.children.push(spec.build(x, guid));
    assignSub(x, guid);
  }
}

function buildSkill(def: ChummerSkillDef, guid: string): Element {
  const n = templates().skill.clone();
  setMany(n, {
    guid, suid: def.id, skillcategory: def.category, karma: '0', base: '0', name: def.name,
    requiresgroundmovement: B(def.name === 'Running'), requiresswimmovement: B(def.name === 'Swimming'), requiresflymovement: B(def.name === 'Flight'),
  });
  return n;
}

const KNO_EN: Record<string, string> = { street: 'Street', academic: 'Academic', professional: 'Professional', interest: 'Interest', language: 'Language' };
function buildKnowledge(k: KnowledgeSkill, guid: string): Element {
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

function setSpecs(skillNode: Element, specStr: unknown): void {
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
export function blankDocument(actor: Actor): XmlDocument {
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
  for (const name of CLEAR_CONTAINERS) if (c.child(name)) c.child(name)!.children = [];
  const attrs = c.child('attributes')!;
  attrs.children = ATTR_ORDER.map((k) => {
    const lim = k === 'MAGAdept' ? meta?.attrs?.MAG : meta?.attrs?.[k];
    const min = lim?.min ?? (k === 'ESS' || k === 'DEP' ? 0 : 1);
    const max = lim?.max ?? (k === 'DEP' ? 0 : 6);
    const aug = lim?.aug ?? max;
    const special = ['DEP', 'MAGAdept', 'RES', 'ESS', 'EDG', 'MAG'].includes(k);
    return el('attribute', [el('name', k), el('metatypemin', String(min)), el('metatypemax', String(max)), el('metatypeaugmax', String(aug)), el('base', '0'), el('karma', '0'), el('metatypecategory', special ? 'Special' : 'Standard'), el('totalvalue', String(k === 'ESS' ? 6 : min))]);
  });
  for (const s of c.get('newskills/skills')!.all('skill')) setMany(s, { guid: newGuid(), base: '0', karma: '0' });
  c.get('newskills/skills')!.children = c.get('newskills/skills')!.all('skill');
  for (const g of c.get('newskills/groups')!.all('group')) setMany(g, { id: newGuid(), base: '0', karma: '0', isbroken: 'False' });
  if (c.get('newskills/knoskills')) c.get('newskills/knoskills')!.children = [];
  setMany(c.get('newskills')!, { skillptsmax: '0', skillgrpsmax: '0' });
  const weapons = c.child('weapons')!;
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
function guidIndex(root: Element): Map<string, { node: Element; parent: Element }> {
  const idx = new Map<string, { node: Element; parent: Element }>();
  root.walk((n, parent) => {
    const g = n.type === 'el' && n.child('guid');
    if (g && parent && n.name !== 'character') {
      const k = g.text.trim().toLowerCase();
      if (k && !idx.has(k)) idx.set(k, { node: n, parent });
    }
  });
  return idx;
}

function container(c: Element, name: string): Element {
  let n = c.child(name);
  if (!n) {
    n = el(name);
    const ref = c.child('improvements') || c.child('expenses');
    if (ref) c.children.splice(c.children.indexOf(ref), 0, n);
    else c.children.push(n);
  }
  return n;
}

function addInt(node: Element, field: string, delta: number): void {
  node.set(field, String(Math.round(num(node.val(field)) + delta)));
}

/** Change an attribute node's value by `delta` (karma first, then base; never below the metatype minimum). */
function shiftAttribute(node: Element, delta: number): void {
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

function groupOf(c: Element, groupName: string | null | undefined): Element | null {
  if (!groupName) return null;
  return c.get('newskills/groups')?.all('group').find((g) => norm(g.val('name')) === norm(groupName)) || null;
}

/** Change a skill node's rating by `delta`; breaks/dissolves its group when a lower rating is required. */
function shiftSkill(c: Element, node: Element, def: ChummerSkillDef | null, delta: number): void {
  if (delta > 0) return addInt(node, 'karma', delta);
  let need = -delta;
  const take = (field: string) => {
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
    for (const s of c.get('newskills/skills')!.all('skill')) {
      const sdef = sd.byId.get(s.val('suid').toLowerCase());
      if (sdef && norm(sdef.group) === norm(def!.group)) {
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
function streetAdjustNode(c: Element): Element | null {
  return c.get('improvements')?.all('improvement').find((i) => i.val('customname') === STREET_ADJUST) || null;
}

/**
 * Shift Chummer's raw street cred / notoriety / public awareness by deltas. A street cred below what Chummer
 * computes from career karma (karma / 10) is stored as a negative custom « Bonus Street Cred » improvement,
 * never as a negative raw value nor as burnt street cred (which would raise notoriety).
 */
function setStreetValues(c: Element, dStreet: number, dNotoriety: number, dAware: number): void {
  const adj = streetAdjustNode(c);
  const total = num(c.val('streetcred')) + (adj ? num(adj.val('val')) : 0) + dStreet;
  if (total >= 0) {
    c.set('streetcred', String(total));
    if (adj) c.get('improvements')!.remove(adj);
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

function careerKarmaOf(c: Element): number {
  let k = 0;
  for (const e of c.get('expenses')?.all('expense') || []) if (e.val('type') === 'Karma' && (num(e.val('amount')) > 0 || e.val('refund') === 'True')) k += num(e.val('amount'));
  return k;
}

function isoLocal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function expenseNode(ts: number, amount: number, reason: unknown, type: string): Element {
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
 * Returns { xml (no BOM), mode: 'patch'|'generate', warnings: [French], warningsI18n: [{ t, params }], assigned: { [list]: { [itemId]: guid } } }.
 */
export function exportChum5(actor: Actor, { now = Date.now(), mugshots = null }: { now?: number; mugshots?: string[] | null } = {}): ExportResult {
  // `warnings` (French strings) also carries .add({ t, params }) for the translatable copy, and .missing (item names).
  const warn = warningList();
  const warnings = warn.list as ExportWarnings;
  warnings.add = warn.add;
  warnings.missing = [];
  const stored = actor.chummer?.xml;
  let doc: XmlDocument;
  let base: ParsedActor;
  let mode: 'patch' | 'generate';
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
  const assigned: Assigned = {};
  const assign = (list: string, item: { id: string }, guid: string) => {
    (assigned[list] ||= {})[item.id] = guid;
  };
  // Nested items (accessories, mods, lifestyle qualities, techniques): assigned.sub[subItemId] = guid.
  const assignSub: AssignSub = (x, guid) => {
    if (x?.id) (assigned.sub ||= {})[x.id] = guid;
  };
  const changed = (k: keyof ParsedActor) => !eq(actor[k], base[k]);

  // --- identity & text
  if (mode === 'generate' || changed('name')) c.set('alias', actor.name);
  if (mode === 'generate' ? actor.realName : changed('realName')) c.set('name', actor.realName || '');
  const textFields = [['gender', 'gender'], ['player', 'playername'], ['concept', 'concept']] as const;
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
      warnings.add({ t: 'Attribute {attr} missing from the file: not exported.', params: { attr: k } });
      continue;
    }
    const have = base.attributes?.[k] ?? num(node.val('metatypemin')) + num(node.val('base')) + num(node.val('karma'));
    const delta = Math.round(Number(want) - have);
    if (delta) shiftAttribute(node, delta);
    const max = num(node.val('metatypemax'));
    if (max && num(node.val('metatypemin')) + num(node.val('base')) + num(node.val('karma')) > max) warnings.add({ t: '{attr} {value} exceeds the metatype maximum in Chummer ({max}): Chummer will cap it (Exceptional Attribute quality?).', params: { attr: k, value: want, max } });
  }

  // --- active skills
  const sd = skillsData();
  const skillsNode = c.get('newskills/skills')!;
  const nodeFor = (def: ChummerSkillDef) => skillsNode.all('skill').find((s) => s.val('suid').toLowerCase() === def.id) || skillsNode.all('skill').find((s) => norm(s.val('name')) === norm(def.name));
  const baseSkill = new Map((base.skills || []).map((s) => [s.id, s]));
  const appSkill = new Map((actor.skills || []).map((s) => [s.id, s]));
  for (const id of new Set([...baseSkill.keys(), ...appSkill.keys()])) {
    const want = appSkill.get(id);
    const was = baseSkill.get(id);
    const def = chummerSkillFor(id, want?.name);
    if (!def) {
      if (want?.rating) warnings.add({ t: 'Skill “{skill}” unknown to Chummer: not exported.', params: { skill: want.name } });
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
  const knoNode = c.get('newskills/knoskills') || c.get('newskills')!.append(el('knoskills')).child('knoskills')!;
  const idx = guidIndex(c);
  const baseKno = new Map((base.knowledge || []).filter((k) => k.chummerGuid).map((k) => [k.chummerGuid!, k]));
  const appKnoGuids = new Set((actor.knowledge || []).map((k) => k.chummerGuid).filter(Boolean));
  for (const [g] of baseKno) if (!appKnoGuids.has(g)) idx.get(g)?.parent.remove(idx.get(g)!.node);
  for (const k of actor.knowledge || []) {
    const hit = k.chummerGuid && idx.get(k.chummerGuid);
    if (hit && baseKno.has(k.chummerGuid!)) {
      const was = baseKno.get(k.chummerGuid!)!;
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
    const items: AnyItem[] = Array.isArray((actor as ListsRec)[list]) ? (actor as ListsRec)[list] : [];
    const baseItems = new Map<string, AnyItem>(((base as ListsRec)[list] || []).filter((i: AnyItem) => i.chummerGuid).map((i: AnyItem) => [i.chummerGuid, i]));
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
        if (LOCATION_LISTS[list] && (it.location || 'on') !== (was.location || 'on')) setItemLocation(c, list, hit.node, it, actor);
        syncSubs(list, hit.node, it, was, assignSub);
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
      const node = buildItem(list, spec, it, guid, warnings, assignSub);
      if (!node) continue;
      if (LOCATION_LISTS[list] && it.location && it.location !== 'on') setItemLocation(c, list, node, it, actor);
      container(c, spec.container).children.push(node);
      assign(list, it, guid);
    }
  }

  // --- matrix device (generate mode only: in patch mode the device already is a gear item)
  if (mode === 'generate' && actor.matrix?.device) addMatrixDevice(c, actor, warnings);

  // --- money, karma & the career log
  const careerBefore = careerKarmaOf(c);
  c.set('karma', String(Math.round(actor.karma || 0)));
  c.set('nuyen', String(Math.round(actor.nuyen || 0)));
  if (created) addExpenses(c, actor, base, mode, now, warnings);
  else if ((actor.karma || 0) !== (base.karma || 0) || (actor.nuyen || 0) !== (base.nuyen || 0)) {
    warnings.add({ t: 'File in creation mode: karma and nuyen written as is, without an expense log (Chummer recalculates creation points).' });
  }
  const careerAfter = careerKarmaOf(c);
  const streetDrift = created ? Math.floor(Math.max(careerAfter, 0) / 10) - Math.floor(Math.max(careerBefore, 0) / 10) : 0;
  setStreetValues(c, (actor.streetCred || 0) - (base.streetCred || 0) - streetDrift, (actor.notoriety || 0) - (base.notoriety || 0), (actor.publicAwareness || 0) - (base.publicAwareness || 0));

  // --- condition & edge
  const cond: Partial<Actor['condition']> = actor.condition || {};
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
  delete (warnings as { missing?: string[] }).missing;
  if (missing.length) warnings.add({ t: '{n} item(s) missing from Chummer’s data, exported as custom items: {items}.', params: { n: missing.length, items: missing.join(', ') } });
  delete (warnings as { add?: unknown }).add;
  return { xml: serializeXml(doc), mode, warnings, warningsI18n: warn.i18n, assigned };
}

/**
 * Remove the (base64) portrait data from a .chum5 so the copy kept in the game state stays small.
 * `save(b64)` stores one image and returns its URL (or null to keep that image in the XML).
 * Returns { xml, urls, mainIndex }.
 */
export function detachMugshots(xml: string, save: (b64: string) => string | null | undefined): { xml: string; urls: string[]; mainIndex: number } {
  if (!/<mugshot>/.test(xml)) return { xml, urls: [], mainIndex: -1 };
  const doc = parseXml(xml);
  const ms = doc.root.child('mugshots');
  const urls: string[] = [];
  const kept: Element[] = [];
  for (const m of ms?.all('mugshot') || []) {
    const url = save(m.text.trim());
    if (url) urls.push(url);
    else kept.push(m);
  }
  if (kept.length) return { xml, urls: [], mainIndex: -1 }; // unknown image format: leave the file untouched
  ms!.children = [];
  return { xml: serializeXml(doc), urls, mainIndex: num(doc.root.val('mainmugshotindex'), 0) };
}

function buildItem(list: string, spec: ListSpec, it: AnyItem, guid: string, warnings: ExportWarnings, assignSub: AssignSub): Element | null {
  const kind = spec.kind(it);
  const data = kind ? resolveData(kind, it) : null;
  if (!data && ['weapons', 'armor', 'vehicles', 'powers', 'spells', 'complexForms', 'martialArts'].includes(list)) warnings.missing.push(it.name);
  switch (list) {
    case 'weapons':
      return buildWeapon(it as Weapon, data, guid, assignSub);
    case 'armor':
      return buildArmor(it as Armor, data, guid, assignSub);
    case 'augmentations': {
      const d = data || resolveData(kind === 'bioware' ? 'cyberware' : 'bioware', it);
      const k = d && d.name === 'bioware' ? 'bioware' : d ? 'cyberware' : kind;
      if (!d) warnings.missing.push(it.name);
      return buildWare(it as Augmentation, d, guid, k);
    }
    case 'gear':
      if (!data) warnings.missing.push(it.name);
      return buildGear(it as GearInput, data, guid, { forceCustom: !data });
    case 'sins':
      return buildSin(it as Sin, guid);
    case 'vehicles':
      return buildVehicle(it as Vehicle, data, guid, assignSub);
    case 'contacts':
      return buildContact(it as Contact, guid);
    case 'qualities':
      if (!data) warnings.missing.push(it.name);
      return buildQuality(it as Quality, data, guid);
    case 'powers':
      return buildPower(it as AdeptPower, data, guid);
    case 'spells':
      return buildSpell(it as Spell, data, guid);
    case 'complexForms':
      return buildComplexForm(it as ComplexForm, data, guid);
    case 'lifestyles':
      return buildLifestyle(it as Lifestyle, guid, assignSub);
    case 'martialArts':
      return buildMartialArt(it as MartialArt, data, guid, assignSub);
    default:
      return null;
  }
}

/** Chummer location list of each app list (app containers ↔ Chummer locations, see parse.js locationsOf). */
const LOCATION_LISTS: Record<string, string> = { weapons: 'weaponlocations', armor: 'armorlocations', gear: 'gearlocations' };

/**
 * <location> of an item node = the guid of the Chummer location matching the item's app container (same guid for containers that came
 * from Chummer — id chum_<guid> —, else same name; created when missing). « Sur soi » / unknown container = no location.
 */
function setItemLocation(c: Element, list: string, node: Element, it: AnyItem, actor: Actor): void {
  const ct = it.location && it.location !== 'on' ? (actor.containers || []).find((x) => x && x.id === it.location) : null;
  if (!ct) {
    node.set('location', '');
    return;
  }
  const holder = container(c, LOCATION_LISTS[list]);
  const want = String(ct.id).startsWith('chum_') ? String(ct.id).slice(5).toLowerCase() : '';
  let loc = holder.all('location').find((l) => (want && l.val('guid').toLowerCase() === want) || l.val('name').trim().toLowerCase() === String(ct.name).trim().toLowerCase());
  if (!loc) {
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(want) ? want : newGuid();
    loc = el('location', [el('guid', guid), el('name', ct.name), el('notes', ct.notes || ''), el('notesColor', ''), el('sortorder', String(holder.all('location').length))]);
    holder.children.push(loc);
  }
  node.set('location', loc.val('guid'));
}

/** Fields the app may change on an item that already exists in the file. */
function patchItem(list: string, node: Element, it: AnyItem, was: AnyItem): void {
  const diff = (k: string) => !eq(it[k], was[k]);
  if (list === 'weapons' && it.ammoLoaded !== undefined && was.ammoLoaded !== undefined && diff('ammoLoaded')) {
    // Rounds in the active clip (only when the file has clips: the parse read them from there).
    const clips = node.get('clips')?.all('clip') || [];
    const slot = clips[Math.max(0, (Number(node.val('activeammoslot')) || 1) - 1)] || clips[0];
    if (slot) slot.set(slot.has('count') ? 'count' : 'ammo', String(Math.max(0, Math.round(it.ammoLoaded))));
  }
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
  if (list === 'lifestyles') {
    if (diff('monthsPaid')) node.set('months', String(it.monthsPaid ?? 0));
    if (diff('name')) node.set('name', it.name || node.val('baselifestyle'));
    if (diff('baseCost')) node.set('cost', fmtNum(Math.max(0, num(node.val('cost')) + num(it.baseCost) - num(was.baseCost))));
    if (diff('notes') && !/^\s*\{\\rtf/.test(node.val('notes'))) node.set('notes', it.notes || '');
  }
  if (list === 'martialArts' && diff('rating')) node.set('rating', String(it.rating || 1));
}

function addMatrixDevice(c: Element, actor: Actor, warnings: ExportWarnings): void {
  const m = actor.matrix!;
  const devName = String(m.device).replace(/\s*\((commlink|cyberdeck|deck|console)\)\s*$/i, '').trim();
  const already = (actor.gear || []).some((g) => norm(g.name).includes(norm(devName)) || norm(devName).includes(norm(g.name)));
  if (already) return;
  const data = findDataItem('gear', { name: devName }) || resolveData('gear', { name: devName });
  const node = buildGear({ name: devName, rating: 0, qty: 1 }, data, newGuid(), { forceCustom: !data });
  if (!data) {
    node.set('category', 'Commlinks');
    node.set('devicerating', String(m.rating || 0));
    node.set('attributearray', `${m.attack || 0},${m.sleaze || 0},${m.dataProcessing || 0},${m.firewall || 0}`);
    warnings.add({ t: 'Matrix device “{device}” not found in Chummer: exported as “Custom Item”.', params: { device: m.device } });
  }
  const kids: Element[] = [];
  for (const p of m.programs || []) {
    const pd = findDataItem('gear', { name: p }) || resolveData('gear', { name: p });
    if (pd) kids.push(buildGear({ name: p, qty: 1 }, pd, newGuid()));
  }
  node.child('children')!.children = kids;
  container(c, 'gears').children.push(node);
}

/** Career log: one <expense> per karma/nuyen history entry since the last sync, plus balancing entries. */
function addExpenses(c: Element, actor: Actor, base: ParsedActor, mode: string, now: number, warnings: ExportWarnings): void {
  const since = mode === 'generate' ? -Infinity : Number(actor.chummer?.syncedAt || actor.chummer?.importedAt || 0);
  const exp = container(c, 'expenses');
  const entries = (actor.history || []).filter((h) => h && !h.chummer && Number(h.ts) > since && (Number(h.karma) || Number(h.nuyen)));
  let sumK = 0;
  let posK = 0;
  let sumN = 0;
  const add = (ts: number, amount: number, reason: string, type: string) => {
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
  } else if (career < posK) warnings.add({ t: 'Career karma in Chummer will be higher than in the app (earnings log).' });
  const netN = Math.round((actor.nuyen || 0) - (base.nuyen || 0));
  if (netN !== sumN) add(now, netN - sumN, 'Ajustement de nuyens (Shadowrun Table)', 'Nuyen');
}

/** Generated files: values bought « at creation » (base) rather than with karma, within Chummer's limits. */
function normalizeGenerated(c: Element): void {
  for (const a of c.get('attributes')!.all('attribute')) {
    const room = Math.max(0, num(a.val('metatypemax')) - num(a.val('metatypemin')));
    const total = num(a.val('base')) + num(a.val('karma'));
    a.set('base', String(Math.min(total, room)));
    a.set('karma', String(total - Math.min(total, room)));
    const k = a.val('name');
    if (k !== 'ESS') a.set('totalvalue', String(num(a.val('metatypemin')) + total));
  }
  for (const s of [...c.get('newskills/skills')!.all('skill'), ...(c.get('newskills/knoskills')?.all('skill') || [])]) {
    const total = num(s.val('base')) + num(s.val('karma'));
    s.set('base', String(Math.min(total, 6)));
    s.set('karma', String(total - Math.min(total, 6)));
  }
}

export { KNOWLEDGE_TYPES };
