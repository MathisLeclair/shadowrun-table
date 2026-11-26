// Build the gear catalog (data/catalog/*.json) from Chummer5 SR5 data files.
//   npm run build:catalog            (or: node tools/build-catalog.js [path/to/Chummer5/data])
// Output item format (see ARCHITECTURE.md > Shop):
//   { id, name, nameFr?, category, categoryFr?, cost, costFormula?, costRange?, avail, availValue, legality,
//     availFormula?, rating?: {min,max}, essence?, grades?, source, page, stats: {...} }
// Null/empty fields are omitted to keep the files lean.
// Upgrade catalogs (installed on something the character owns, see ARCHITECTURE.md > Upgrades): lifestylequalities,
// accessories (weapon accessories), armormods, vehiclemods; martialarts (karma, styles with their techniques).
// Also writes data/catalog/coverage.md: items per source book, Chummer XML vs catalog.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { evalFormula } from '../client/modules/shop/rules.js';
import { entryEffects, conditionKey } from './lib/bonus-effects.js';
import { CONDITIONS, conditionToggle } from '../shared/modifiers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUMMER = path.resolve(process.argv[2] || path.join(ROOT, '..', 'Chummer5.226.0', 'data'));
const LANG = path.join(CHUMMER, '..', 'lang', 'fr-fr_data.xml');
const OUT = path.join(ROOT, 'data', 'catalog');

if (!fs.existsSync(CHUMMER)) {
  console.error(`Chummer data folder not found: ${CHUMMER}`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true });
const readXml = (file) => parser.parse(fs.readFileSync(file, 'utf8')).chummer;
const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();
const clean = (s) => String(s || '').replace(/[​­]/g, '').replace(/\s+/g, ' ').trim();
const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());
const num = (s) => (isNum(s) ? Number(s) : undefined);

// Sourcebooks we never sell (Shadowrun 2050 era conversions).
const SKIP_SOURCES = new Set(['2050']);
const stats = { dropped: {}, droppedItems: [] };
/** Record a dropped XML entry (x = the XML node when known, for the coverage report). */
const drop = (file, why, x) => {
  const k = `${file}: ${why}`;
  stats.dropped[k] = (stats.dropped[k] || 0) + 1;
  if (x && typeof x === 'object') stats.droppedItems.push({ file, why, name: clean(txt(x.name)), source: txt(x.source) || '?' });
  return null;
};

// ---------------------------------------------------------------------------
// French translations: per file, id -> name, English name -> name, category -> category.
// ---------------------------------------------------------------------------
const FR = {};
function loadFrench() {
  if (!fs.existsSync(LANG)) {
    console.warn('French translation file not found, names stay in English:', LANG);
    return;
  }
  const doc = parser.parse(fs.readFileSync(LANG, 'utf8')).chummer;
  for (const sec of arr(doc.chummer)) {
    const file = String(sec['@file'] || '').replace(/\.xml$/, '');
    if (!file) continue;
    const t = (FR[file] = { byId: {}, byName: {}, cats: {} });
    const walk = (node, key) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, key));
      if (!node || typeof node !== 'object') return;
      if (/categor/i.test(key || '') && node['@translate'] && node['#text']) {
        t.cats[clean(node['#text'])] = clean(node['@translate']);
        return;
      }
      if (node.translate !== undefined && node.name !== undefined) {
        const fr = clean(txt(node.translate));
        if (fr) {
          if (node.id) t.byId[txt(node.id)] = fr;
          t.byName[clean(txt(node.name))] = fr;
        }
      }
      for (const [k, v] of Object.entries(node)) if (!k.startsWith('@') && k !== '#text') walk(v, k);
    };
    walk(sec, '');
  }
}

function french(file, id, name) {
  const t = FR[file];
  if (!t) return undefined;
  const fr = t.byId[id] || t.byName[name];
  return fr && fr !== name ? fr : undefined;
}
function frenchCat(file, cat) {
  const fr = FR[file]?.cats[cat];
  return fr && fr !== cat ? fr : undefined;
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------
// Formula variables: Rating/MinRating everywhere; upgrade catalogs also use their target's values (resolved when
// the upgrade is installed: rules.js quote(item, { vars })). Sample values below only validate/preview the formula.
const BASE_VARS = new Set(['Rating', 'MinRating', 'number', 'FixedValues', 'div', 'mod']);
const SAMPLE_VARS = {
  WeaponCost: 1000, ArmorCost: 1000, VehicleCost: 20000,
  Body: 10, Speed: 4, Handling: 4, Acceleration: 2, Pilot: 3, Sensor: 3, Seats: 4, Armor: 6, Capacity: 12,
};
/** Extra variables allowed per output file. */
const FILE_VARS = {
  accessories: ['WeaponCost'],
  armormods: ['ArmorCost', 'Capacity'],
  vehiclemods: ['VehicleCost', 'Body', 'Speed', 'Handling', 'Acceleration', 'Pilot', 'Sensor', 'Seats', 'Armor'],
};
let currentVars = [];

function normFormula(s) {
  return String(s)
    .replace(/\{([A-Za-z ]+)\}/g, '$1')
    .replace(/\b(Weapon|Armor|Vehicle|Gear) Cost\b/g, '$1Cost')
    .replace(/\[(-?\d+(?:\.\d+)?)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Validate a formula over the rating range; returns false if it can't be evaluated. */
function formulaOk(f, rating) {
  const ids = String(f).match(/[A-Za-z_][A-Za-z_0-9]*/g) || [];
  if (ids.some((id) => !BASE_VARS.has(id) && !currentVars.includes(id))) return false;
  try {
    const lo = rating?.min ?? 1;
    const hi = rating?.max ?? lo;
    for (const r of new Set([lo, hi, Math.round((lo + hi) / 2)])) evalFormula(f, { ...SAMPLE_VARS, Rating: r, MinRating: lo });
    return true;
  } catch {
    return false;
  }
}
const evalSample = (f, rating) => evalFormula(f, { ...SAMPLE_VARS, Rating: rating?.min ?? 1, MinRating: rating?.min ?? 1 });
/** Formula string uses a target variable (price depends on the weapon/armor/vehicle it is installed on). */
const usesTargetVars = (f) => currentVars.some((v) => new RegExp(`\\b${v}\\b`).test(String(f || '')));

/** Parse <rating>/<minrating> into { min, max } (undefined when the item has no rating). */
function parseRating(maxRaw, minRaw) {
  const max = num(txt(maxRaw));
  if (!max || max <= 0) return { ok: !txt(maxRaw) || isNum(txt(maxRaw)), rating: undefined };
  const min = num(txt(minRaw)) ?? 1;
  return { ok: true, rating: { min: Math.max(0, Math.min(min, max)), max } };
}

/** cost → { cost, costFormula?, costRange? } or null when unusable. */
function parseCost(raw, rating) {
  let s = normFormula(txt(raw) || '0');
  if (isNum(s)) return { cost: Number(s) };
  const v = s.match(/^Variable\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)$/i);
  if (v) {
    const lo = Number(v[1]);
    const hi = Number(v[2]);
    if (lo <= 0) return null; // placeholder / free-form custom item
    return { cost: lo, costRange: [lo, hi] };
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (!formulaOk(s, rating)) return null;
  if (!rating && /Rating/.test(s)) return null;
  return { cost: Math.round(evalSample(s, rating)), costFormula: s };
}

/** Upgrade catalogs whose « +N » availability is relative to the item they are installed on (availRelative). */
const UPGRADE_CATALOGS = new Set(['accessories', 'armormods', 'vehiclemods']);
let currentFile = '';

/** avail → { avail, availValue, legality, availFormula?, availRelative? } or null. */
function parseAvail(raw, rating) {
  let s = normFormula(txt(raw) || '0').replace(/\s+or\s+Gear$/i, '');
  // « +2R » (Smartgun System, Internal; YNT Softweave…): added to the target's availability (rules.js upgradeAvail).
  const relative = s.startsWith('+');
  if (relative) s = s.slice(1).trim();
  let legality = '';
  const fixed = s.match(/^FixedValues\((.*)\)$/i);
  if (fixed) {
    const parts = fixed[1].split(',').map((x) => x.trim());
    if (parts.some((x) => /F$/i.test(x))) legality = 'F';
    else if (parts.some((x) => /R$/i.test(x))) legality = 'R';
    s = `FixedValues(${parts.map((x) => x.replace(/[RF]$/i, '')).join(',')})`;
  } else {
    const m = s.match(/^(.*?)\s*([RF])$/);
    if (m && m[1] !== '') {
      legality = m[2];
      s = m[1].trim();
    }
  }
  if (s === '' || s === '-') s = '0';
  const rel = relative && UPGRADE_CATALOGS.has(currentFile) ? { availRelative: true } : {};
  const sign = rel.availRelative ? '+' : '';
  if (isNum(s)) {
    const v = Number(s);
    return { avail: `${sign}${v}${legality}`, availValue: v, legality, ...rel };
  }
  if (!formulaOk(s, rating) || (!rating && /Rating/.test(s))) return null;
  const v = Math.round(evalSample(s, rating));
  return { avail: `${sign}${v}${legality}`, availValue: v, legality, availFormula: s, ...rel };
}

function parseEssence(raw, rating) {
  const s = normFormula(txt(raw) || '0');
  if (isNum(s)) return Number(s);
  if (!formulaOk(s, rating) || (!rating && /Rating/.test(s))) return undefined;
  return s;
}

/** Remove undefined / null / '' / empty arrays & objects (recursively for stats). */
function lean(o) {
  if (Array.isArray(o)) return o.map(lean);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    const lv = lean(v);
    if (lv && typeof lv === 'object' && !Array.isArray(lv) && !Object.keys(lv).length) continue;
    if (Array.isArray(lv) && !lv.length) continue;
    out[k] = lv;
  }
  return out;
}

const hidden = (x) => x.hide !== undefined;

/** Normalized Chummer <bonus>/<wirelessbonus> effects (tools/lib/bonus-effects.js) attached to a catalog entry as `effects`. */
function withEffects(file, it, x) {
  const eff = entryEffects(x);
  if (eff.length) it.effects = eff;
  return it;
}

/** Common fields; returns null if the entry must be dropped. */
function base(file, x, { ratingRaw, minRaw, costRaw, availRaw, frFile = file, catOverride } = {}) {
  const name = clean(txt(x.name));
  const id = txt(x.id);
  if (!id || !name) return drop(file, 'no id/name', x);
  if (hidden(x)) return drop(file, 'hidden', x);
  if (SKIP_SOURCES.has(txt(x.source))) return drop(file, 'source 2050', x);
  if (/^\[?custom\b|\(custom\)|\[custom/i.test(name) || /^Custom Item$/i.test(name)) return drop(file, 'custom placeholder', x);
  const category = catOverride || clean(txt(x.category));
  if (/^Custom( |$)/i.test(category)) return drop(file, 'custom category', x);
  const { ok, rating } = parseRating(ratingRaw === undefined ? x.rating : ratingRaw, minRaw === undefined ? x.minrating : minRaw);
  if (!ok) return drop(file, 'rating formula', x);
  const out = { id, name, nameFr: french(frFile, id, name), category, categoryFr: frenchCat(frFile, category) };
  if (costRaw !== null) {
    const c = parseCost(costRaw === undefined ? x.cost : costRaw, rating);
    if (!c) return drop(file, 'cost formula', x);
    Object.assign(out, c);
  }
  if (availRaw !== null) {
    currentFile = file;
    const a = parseAvail(availRaw === undefined ? x.avail : availRaw, rating);
    if (!a) return drop(file, 'avail formula', x);
    Object.assign(out, a);
  }
  if (rating) out.rating = rating;
  out.source = txt(x.source);
  out.page = num(txt(x.page)) ?? txt(x.page);
  return out;
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------
const SKILL_BY_CATEGORY = {
  Blades: 'blades', Clubs: 'clubs', 'Improvised Weapons': 'clubs', 'Exotic Melee Weapons': 'exotic_weapon',
  'Exotic Ranged Weapons': 'exotic_weapon', 'Bio-Weapon': 'unarmed_combat', Cyberweapon: 'blades', Unarmed: 'unarmed_combat',
  Bows: 'archery', Crossbows: 'archery', Tasers: 'pistols', Holdouts: 'pistols', 'Light Pistols': 'pistols',
  'Heavy Pistols': 'pistols', 'Machine Pistols': 'automatics', 'Submachine Guns': 'automatics', 'Assault Rifles': 'automatics',
  Carbines: 'automatics', 'Sporting Rifles': 'longarms', 'Sniper Rifles': 'longarms', Shotguns: 'longarms',
  'Light Machine Guns': 'heavy_weapons', 'Medium Machine Guns': 'heavy_weapons', 'Heavy Machine Guns': 'heavy_weapons',
  'Assault Cannons': 'heavy_weapons', 'Grenade Launchers': 'heavy_weapons', 'Missile Launchers': 'heavy_weapons',
  'Laser Weapons': 'exotic_weapon', Flamethrowers: 'exotic_weapon', 'Underbarrel Weapons': 'heavy_weapons',
  Gear: 'throwing_weapons', Quality: 'unarmed_combat',
};
const SKILL_BY_NAME = {
  'Throwing Weapons': 'throwing_weapons', 'Unarmed Combat': 'unarmed_combat', 'Exotic Ranged Weapon': 'exotic_weapon',
  'Exotic Melee Weapon': 'exotic_weapon', 'Heavy Weapons': 'heavy_weapons', Longarms: 'longarms', Archery: 'archery',
  Clubs: 'clubs', Blades: 'blades', Automatics: 'automatics', Pistols: 'pistols', Gunnery: 'gunnery',
};

function weaponStats(x) {
  const type = txt(x.type) === 'Melee' ? 'melee' : 'ranged';
  const fix = (s) => clean(txt(s)).replace(/\{STR\}/g, 'STR').replace(/\{MAG\}/g, 'MAG').replace(/\{Rating\}/g, 'Rating');
  const ap = fix(x.ap);
  const rc = fix(x.rc);
  const acc = fix(x.accuracy);
  return {
    type,
    skill: SKILL_BY_NAME[txt(x.useskill)] || SKILL_BY_CATEGORY[clean(txt(x.category))] || (type === 'melee' ? 'clubs' : 'exotic_weapon'),
    accuracy: isNum(acc) ? Number(acc) : acc.replace(/^3\+number.*$/, '3'),
    reach: num(txt(x.reach)) || undefined,
    damage: fix(x.damage),
    ap: ap === '-' || ap === '' ? 0 : isNum(ap) ? Number(ap) : ap,
    mode: ['-', '0', ''].includes(fix(x.mode)) ? undefined : fix(x.mode),
    rc: rc === '-' || rc === '' ? 0 : isNum(rc) ? Number(rc) : rc,
    ammo: fix(x.ammo) === '-' || fix(x.ammo) === '0' ? undefined : fix(x.ammo),
    conceal: num(txt(x.conceal)),
  };
}

const hiddenWeapons = new Map(); // name -> weapon stats (used by grenades & cyber implant weapons)

function buildWeapons() {
  const x = readXml(path.join(CHUMMER, 'weapons.xml'));
  const out = [];
  for (const w of arr(x.weapons?.weapon)) {
    const name = clean(txt(w.name));
    hiddenWeapons.set(name, { name, ...weaponStats(w) });
    if (['Gear', 'Quality', 'Cyberweapon', 'Bio-Weapon'].includes(clean(txt(w.category)))) {
      drop('weapons', 'granted by other item', w);
      continue;
    }
    const it = base('weapons', w);
    if (!it) continue;
    it.stats = weaponStats(w);
    // Accessory mount points (weapon.mounts) and accessories delivered with the weapon (installed as included).
    const mounts = arr(w.accessorymounts?.mount).map((m) => clean(txt(m))).filter(Boolean);
    if (mounts.length) it.stats.mounts = mounts;
    const included = arr(w.accessories?.accessory).map((a) => clean(txt(a.name))).filter(Boolean);
    if (included.length) it.stats.included = included;
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weapon accessories (installed on a weapon: weapon.accessories)
// ---------------------------------------------------------------------------
const MOUNT_FR = { Top: 'Dessus', Under: 'Dessous', Barrel: 'Canon', Stock: 'Crosse', Side: 'Flanc', Internal: 'Interne' };

/**
 * <required>/<forbidden> weapondetails / vehicledetails → { names?, namesContains?, categories?, categoriesContains?, types? }
 * (any listed value matches; values with operation="contains" match a substring). Only name / category / type are
 * understood. mode 'required': an OR group that also holds something else (conceal, ammo, useskill, NOT…) is dropped
 * — the requirement passes instead of refusing every weapon; top-level conditions not understood pass. mode
 * 'forbidden': conditions not understood never forbid.
 */
function detailsOf(wd, mode) {
  if (!wd || typeof wd !== 'object') return undefined;
  const KEYS = { name: 'names', category: 'categories', type: 'types' };
  const lists = { names: [], namesContains: [], categories: [], categoriesContains: [], types: [] };
  let unparsed = false;
  const read = (node) => {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@')) {
        if (k === '@NOT') unparsed = true;
        continue;
      }
      if (!KEYS[k]) {
        unparsed = true;
        continue;
      }
      for (const e of arr(v)) {
        const val = clean(txt(e));
        const obj = e && typeof e === 'object';
        const op = obj ? e['@operation'] : undefined;
        if (!val || (obj && e['@NOT'] !== undefined) || (op && op !== 'contains' && op !== 'equals')) {
          unparsed = true;
          continue;
        }
        lists[op === 'contains' && k !== 'type' ? `${KEYS[k]}Contains` : KEYS[k]].push(val);
      }
    }
  };
  if (wd.OR !== undefined) {
    if (Array.isArray(wd.OR) || !wd.OR || typeof wd.OR !== 'object') unparsed = true;
    else read(wd.OR);
    if (mode === 'required' && unparsed) return undefined;
  } else read(wd);
  const out = lean(lists);
  return Object.keys(out).length ? out : undefined;
}
const weaponDetails = (node, mode) => detailsOf(node?.weapondetails, mode);

function buildAccessories() {
  const x = readXml(path.join(CHUMMER, 'weapons.xml'));
  const out = [];
  currentVars = FILE_VARS.accessories;
  for (const a of arr(x.accessories?.accessory)) {
    const max = num(txt(a.rating)) || 0;
    const mounts = clean(txt(a.mount)).split('/').map((m) => m.trim()).filter(Boolean);
    const requires = weaponDetails(a.required, 'required');
    const forbids = weaponDetails(a.forbidden, 'forbidden');
    const modelSpecific = !!requires?.names?.length;
    const category = modelSpecific ? 'Model-Specific' : mounts.length ? mounts.join(' / ') : 'No Mount';
    const it = base('accessories', a, { catOverride: category, ratingRaw: max > 0 ? String(max) : '0', minRaw: '1', frFile: 'weapons' });
    if (!it) continue;
    it.categoryFr = modelSpecific ? 'Spécifique à un modèle' : mounts.length ? mounts.map((m) => MOUNT_FR[m] || m).join(' / ') : 'Sans montage';
    const smartgun = /^Smartgun System/i.test(it.name) || undefined;
    it.stats = {
      mount: mounts.length ? mounts : undefined,
      extraMount: arr(a.extramount).flatMap((m) => clean(txt(m)).split('/')).map((m) => m.trim()).filter(Boolean),
      // SR5 p.433: a smartgun gives dice (+1 wired / +2 wireless with a smartlink), not Accuracy: kept as a flag.
      accuracy: smartgun ? undefined : num(txt(a.accuracy)) || undefined,
      rc: num(txt(a.rc)) || undefined,
      rcGroup: num(txt(a.rcgroup)) || undefined,
      conceal: num(txt(a.conceal)) || undefined,
      smartgun,
      requires,
      forbids,
      targetCost: usesTargetVars(it.costFormula) || undefined,
    };
    withEffects('accessories', it, a);
    out.push(it);
  }
  currentVars = [];
  return out;
}

// ---------------------------------------------------------------------------
// Armor
// ---------------------------------------------------------------------------
function buildArmor() {
  const x = readXml(path.join(CHUMMER, 'armor.xml'));
  const out = [];
  for (const a of arr(x.armors?.armor)) {
    const it = base('armor', a);
    if (!it) continue;
    const raw = txt(a.armor);
    const stack = raw.startsWith('+');
    const val = raw.replace(/^\+/, '');
    it.stats = {
      armor: isNum(val) ? Number(val) : normFormula(val),
      stack: stack || undefined,
      capacity: isNum(txt(a.armorcapacity)) ? Number(txt(a.armorcapacity)) : undefined,
    };
    if (typeof it.stats.armor === 'string' && !it.rating) {
      drop('armor', 'armor formula without rating', a);
      continue;
    }
    withEffects('armor', it, a);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Armor modifications (installed on an armor: armor.mods, uses its capacity)
// ---------------------------------------------------------------------------
const ARMOR_BONUS = {
  firearmor: 'fire', coldarmor: 'cold', electricityarmor: 'electricity', acidarmor: 'acid', fallingarmor: 'falling',
  toxincontactresist: 'toxin', pathogencontactresist: 'pathogen', radiationresist: 'radiation',
};

function buildArmorMods() {
  const x = readXml(path.join(CHUMMER, 'armor.xml'));
  const out = [];
  currentVars = FILE_VARS.armormods;
  for (const m of arr(x.mods?.mod)) {
    const max = num(txt(m.maxrating)) || 0;
    // « Custom Liners (Rating N) » (SR5 armor liners) are real items: renamed so the generic « Custom … » placeholder filter keeps them.
    const cat = clean(txt(m.category)).replace(/^Custom Liners/, 'Armor Liners');
    const it = base('armormods', m, { ratingRaw: String(max > 1 ? max : 0), minRaw: '1', frFile: 'armor', catOverride: cat });
    if (!it) continue;
    const capRaw = normFormula(txt(m.armorcapacity) || '0');
    let capacity;
    if (isNum(capRaw)) capacity = Number(capRaw);
    else if (formulaOk(capRaw, it.rating)) capacity = capRaw;
    else {
      drop('armormods', 'capacity formula', m);
      continue;
    }
    const rawArmor = txt(m.armor).replace(/^\+/, '');
    const bonus = {};
    for (const [k, v] of Object.entries(m.bonus || {})) {
      if (!ARMOR_BONUS[k]) continue;
      const s = normFormula(txt(v));
      bonus[ARMOR_BONUS[k]] = isNum(s) ? Number(s) : s || true;
    }
    it.stats = {
      capacity,
      armor: isNum(rawArmor) && Number(rawArmor) ? Number(rawArmor) : undefined,
      bonus,
      targetCost: usesTargetVars(it.costFormula) || usesTargetVars(capacity) || undefined,
    };
    withEffects('armormods', it, m);
    out.push(it);
  }
  currentVars = [];
  return out;
}

// ---------------------------------------------------------------------------
// Gear (+ commlinks, cyberdecks, foci…)
// ---------------------------------------------------------------------------
const GEAR_SKIP_CATEGORIES = new Set(['Currency', 'Paydata', 'Custom', 'Custom Cyberdeck Attributes', 'Custom Drug']);

function buildGear(programNames) {
  const x = readXml(path.join(CHUMMER, 'gear.xml'));
  const out = [];
  for (const g of arr(x.gears?.gear)) {
    const cat = clean(txt(g.category));
    if (GEAR_SKIP_CATEGORIES.has(cat)) {
      drop('gear', `category ${cat}`);
      continue;
    }
    if (g.requireparent !== undefined) {
      drop('gear', 'requires parent');
      continue;
    }
    if (['Common Programs', 'Hacking Programs', 'Software', 'Autosofts'].includes(cat) && programNames.has(clean(txt(g.name)))) {
      drop('gear', 'duplicate of programs.json');
      continue;
    }
    const it = base('gear', g);
    if (!it) continue;
    const s = {};
    const costFor = num(txt(g.costfor));
    if (costFor && costFor > 1) s.costFor = costFor;
    const dr = txt(g.devicerating);
    if (dr) s.deviceRating = isNum(dr) ? Number(dr) : normFormula(dr);
    if (txt(g.attributearray)) s.attributeArray = txt(g.attributearray).split(',').map((n) => Number(n.trim()));
    for (const [k, key] of [['attack', 'attack'], ['sleaze', 'sleaze'], ['dataprocessing', 'dataProcessing'], ['firewall', 'firewall']]) {
      const v = txt(g[k]);
      if (v && isNum(v)) s[key] = Number(v);
    }
    const progs = num(txt(g.programs));
    if (progs) s.programs = progs;
    const cap = txt(g.capacity);
    if (cap && cap !== '0') s.capacity = cap;
    const addw = clean(txt(g.addweapon));
    if (addw && hiddenWeapons.has(addw)) {
      const { name, ...w } = hiddenWeapons.get(addw);
      s.weapon = w;
    }
    if (s.deviceRating !== undefined && typeof s.deviceRating === 'string' && !it.rating) delete s.deviceRating;
    it.stats = s;
    withEffects('gear', it, g);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cyberware / Bioware
// ---------------------------------------------------------------------------
const GRADE_KEY = { Standard: 'standard', Alphaware: 'alpha', Betaware: 'beta', Deltaware: 'delta', Used: 'used' };

function wareBonus(bonus) {
  if (!bonus || typeof bonus !== 'object') return undefined;
  const out = {};
  for (const sa of arr(bonus.specificattribute)) {
    const name = txt(sa.name);
    const val = normFormula(txt(sa.val));
    if (['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'].includes(name) && val) {
      out.attributes = out.attributes || {};
      out.attributes[name] = isNum(val) ? Number(val) : val;
    }
  }
  const ip = normFormula(txt(bonus.initiativepass));
  if (ip) out.initiativeDice = isNum(ip) ? Number(ip) : ip;
  const armor = normFormula(txt(bonus.armor));
  if (armor && isNum(armor)) out.armor = Number(armor);
  return Object.keys(out).length ? out : undefined;
}

function buildWare(file, tag, kind) {
  const x = readXml(path.join(CHUMMER, `${file}.xml`));
  const out = [];
  for (const c of arr(x[`${tag}s`]?.[tag])) {
    if (c.requireparent !== undefined) {
      drop(file, 'requires parent');
      continue;
    }
    const it = base(file, c);
    if (!it) continue;
    const ess = parseEssence(c.ess, it.rating);
    if (ess === undefined) {
      drop(file, 'essence formula');
      continue;
    }
    it.essence = ess;
    const force = txt(c.forcegrade);
    const banned = new Set(arr(c.bannedgrades?.grade).map((g) => GRADE_KEY[txt(g)]).filter(Boolean));
    if (force) it.grades = GRADE_KEY[force] ? [GRADE_KEY[force]] : [];
    else if (banned.size) it.grades = Object.values(GRADE_KEY).filter((g) => !banned.has(g));
    const capacity = txt(c.capacity);
    const s = { kind, capacity: capacity && capacity !== '0' ? capacity : undefined, bonus: wareBonus(c.bonus) };
    const addw = clean(txt(c.addweapon));
    if (addw && hiddenWeapons.has(addw)) {
      const { name, ...w } = hiddenWeapons.get(addw);
      s.weapon = { name, ...w };
    }
    if (c.isgeneware !== undefined) s.geneware = true;
    it.stats = s;
    withEffects(file, it, c);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vehicles & drones
// ---------------------------------------------------------------------------
const VEHICLE_SLOT_FIELDS = [
  ['powertrainmodslots', 'Powertrain'], ['protectionmodslots', 'Protection'], ['weaponmodslots', 'Weapons'], ['bodymodslots', 'Body'],
  ['electromagneticmodslots', 'Electromagnetic'], ['cosmeticmodslots', 'Cosmetic'],
];

function buildVehicles() {
  const x = readXml(path.join(CHUMMER, 'vehicles.xml'));
  const out = [];
  const n = (v) => {
    const s = txt(v);
    return isNum(s) ? Number(s) : s || undefined;
  };
  for (const v of arr(x.vehicles?.vehicle)) {
    const it = base('vehicles', v);
    if (!it) continue;
    it.stats = {
      handling: n(v.handling), speed: n(v.speed), accel: n(v.accel), body: n(v.body), armor: n(v.armor),
      pilot: n(v.pilot), sensor: n(v.sensor), seats: n(v.seats),
      drone: /^Drones/.test(it.category) || undefined,
      modSlots: num(txt(v.modslots)) || undefined, // drones: extra modification slots (R5), on top of Body
      // Other vehicles (R5): one slot pool per mod category = Body + <xxxmodslots> (Krime Euskaldunak Tankette: −7).
      slotBonus: lean(Object.fromEntries(VEHICLE_SLOT_FIELDS.map(([k, c]) => [c, num(txt(v[k])) || undefined]))),
    };
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vehicle modifications (installed on a vehicle: vehicle.mods, uses slots — R5: Body + modSlots)
// ---------------------------------------------------------------------------
const VEHICLE_BONUS = { handling: 'handling', speed: 'speed', accel: 'accel', armor: 'armor', body: 'body', sensor: 'sensor', pilot: 'pilot', seats: 'seats' };
const RATING_VARS = { qty: 'qty', body: 'Body', seats: 'Seats' };

function buildVehicleMods() {
  const x = readXml(path.join(CHUMMER, 'vehicles.xml'));
  const out = [];
  currentVars = FILE_VARS.vehiclemods;
  for (const m of arr(x.mods?.mod)) {
    const rRaw = txt(m.rating);
    const ratingVar = RATING_VARS[rRaw.toLowerCase()];
    const max = ratingVar ? (ratingVar === 'qty' ? 99 : 30) : num(rRaw) || 0;
    const it = base('vehiclemods', m, { ratingRaw: String(max), minRaw: txt(m.minrating) || '1', frFile: 'vehicles' });
    if (!it) continue;
    const slotsRaw = normFormula(txt(m.slots) || '0');
    let slots;
    if (isNum(slotsRaw)) slots = Number(slotsRaw);
    else if (formulaOk(slotsRaw, it.rating)) slots = slotsRaw;
    else {
      drop('vehiclemods', 'slots formula', m);
      continue;
    }
    const bonus = {};
    for (const [k, v] of Object.entries(m.bonus || {})) {
      if (!VEHICLE_BONUS[k]) continue;
      const s = normFormula(txt(v)).replace(/^\+/, '');
      if (s) bonus[VEHICLE_BONUS[k]] = isNum(s) ? Number(s) : s;
    }
    it.stats = {
      slots,
      ratingVar,
      bonus,
      requires: detailsOf(m.required?.vehicledetails, 'required'),
      forbids: detailsOf(m.forbidden?.vehicledetails, 'forbidden'),
      targetCost: usesTargetVars(it.costFormula) || usesTargetVars(it.availFormula) || usesTargetVars(slots) || undefined,
    };
    out.push(it);
  }
  currentVars = [];
  return out;
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------
function buildPrograms() {
  const x = readXml(path.join(CHUMMER, 'programs.xml'));
  const out = [];
  for (const p of arr(x.programs?.program)) {
    const it = base('programs', p);
    if (!it) continue;
    it.stats = { program: true };
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifestyles (monthly cost)
// ---------------------------------------------------------------------------
function buildLifestyles() {
  const x = readXml(path.join(CHUMMER, 'lifestyles.xml'));
  const out = [];
  // RF point grids: { [lifestyle name]: { comforts|neighborhood|security: [minimum, limit] } }
  const grid = {};
  for (const [key, list, tag] of [['comforts', 'comforts', 'comfort'], ['neighborhood', 'neighborhoods', 'neighborhood'], ['security', 'securities', 'security']]) {
    for (const g of arr(x[list]?.[tag])) (grid[clean(txt(g.name))] ||= {})[key] = [num(txt(g.minimum)) ?? 0, num(txt(g.limit)) ?? 0];
  }
  for (const l of arr(x.lifestyles?.lifestyle)) {
    if (/ERROR/i.test(txt(l.name))) {
      drop('lifestyles', 'placeholder', l);
      continue;
    }
    const it = base('lifestyles', l, { availRaw: null, catOverride: 'Lifestyles' });
    if (!it) continue;
    it.categoryFr = 'Train de vie';
    it.avail = '0';
    it.availValue = 0;
    it.legality = '';
    const name = clean(txt(l.name));
    it.stats = {
      monthly: true,
      startingDice: txt(l.dice) || undefined,
      startingMultiplier: num(txt(l.multiplier)),
      lp: num(txt(l.lp)),
      points: grid[name],
      pointCost: lean({ comforts: num(txt(l.costforcomforts)), neighborhood: num(txt(l.costforarea)), security: num(txt(l.costforsecurity)) }),
    };
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifestyle qualities / upgrades (SR5 p.370 + Run Faster p.220: Garage, Workshop, DocWagon, Extra Secure…)
// Monthly: flat cost (¥/month, may be negative) and/or a multiplier (% of the lifestyle base cost).
// ---------------------------------------------------------------------------
function buildLifestyleQualities() {
  const x = readXml(path.join(CHUMMER, 'lifestyles.xml'));
  const out = [];
  for (const q of arr(x.qualities?.quality)) {
    const it = base('lifestylequalities', q, { availRaw: null, ratingRaw: '0', frFile: 'lifestyles' });
    if (!it) continue;
    it.avail = '0';
    it.availValue = 0;
    it.legality = '';
    const mult = num(txt(q.multiplier));
    const baseOnly = num(txt(q.multiplierbaseonly));
    it.stats = {
      monthly: true,
      multiplier: mult || baseOnly || undefined,
      baseOnly: baseOnly ? true : undefined, // Chummer <multiplierbaseonly> (Extra Secure): % of the base cost only
      lp: num(txt(q.lp)),
      allowed: txt(q.allowed) ? txt(q.allowed).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      multiple: q.allowmultiple !== undefined || undefined,
      selectText: q.bonus?.selecttext !== undefined || undefined,
      comforts: num(txt(q.comforts)) || undefined,
      security: num(txt(q.security)) || undefined,
      neighborhood: num(txt(q.area)) || undefined,
      // Other options of the same lifestyle (<forbidden>/<required> <oneof><lifestylequality>) and required base lifestyles.
      forbids: arr(q.forbidden?.oneof?.lifestylequality).map((n) => clean(txt(n))).filter(Boolean),
      requiresOneOf: arr(q.required?.oneof?.lifestylequality).map((n) => clean(txt(n))).filter(Boolean),
      requiresLifestyle: arr(q.required?.lifestyle).map((n) => clean(txt(n))).filter(Boolean),
    };
    withEffects('lifestylequalities', it, q);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Martial arts (Run & Gun): styles (karma 7) with their techniques (karma 5 each) — karma, not nuyen.
// ---------------------------------------------------------------------------
function buildMartialArts() {
  const x = readXml(path.join(CHUMMER, 'martialarts.xml'));
  const tech = new Map();
  for (const t of arr(x.techniques?.technique)) {
    if (hidden(t) || SKIP_SOURCES.has(txt(t.source))) continue;
    const name = clean(txt(t.name));
    const te = lean({ id: txt(t.id), name, nameFr: french('martialarts', txt(t.id), name), source: txt(t.source), page: num(txt(t.page)) ?? txt(t.page) });
    withEffects('techniques', te, t);
    tech.set(name, te);
  }
  const out = [];
  for (const m of arr(x.martialarts?.martialart)) {
    const it = base('martialarts', m, { costRaw: null, availRaw: null, ratingRaw: '0', catOverride: 'Martial Arts' });
    if (!it) continue;
    it.categoryFr = 'Arts martiaux';
    const techniques = arr(m.techniques?.technique)
      .map((t) => tech.get(clean(txt(t.name))) || (clean(txt(t.name)) ? { name: clean(txt(t.name)) } : null))
      .filter(Boolean);
    it.stats = { karma: num(txt(m.cost)) || 7, techniqueKarma: 5, techniques };
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Qualities, spells, adept powers (karma-based, used by the training module)
// ---------------------------------------------------------------------------
function buildQualities() {
  const x = readXml(path.join(CHUMMER, 'qualities.xml'));
  const out = [];
  for (const q of arr(x.qualities?.quality)) {
    const it = base('qualities', q, { costRaw: null, availRaw: null, ratingRaw: '0' });
    if (!it) continue;
    const karma = num(txt(q.karma)) ?? 0;
    const limit = num(txt(q.limit));
    it.stats = {
      karma,
      positive: txt(q.category) === 'Positive',
      maxLevels: limit && limit > 1 ? limit : undefined,
      chargenOnly: q.chargenonly !== undefined || undefined,
      metagenic: q.metagenic !== undefined || undefined,
    };
    withEffects('qualities', it, q);
    out.push(it);
  }
  return out;
}

function buildSpells() {
  const x = readXml(path.join(CHUMMER, 'spells.xml'));
  const out = [];
  for (const s of arr(x.spells?.spell)) {
    const it = base('spells', s, { costRaw: null, availRaw: null, ratingRaw: '0' });
    if (!it) continue;
    it.stats = {
      type: txt(s.type), range: txt(s.range), damage: txt(s.damage) === '0' ? undefined : txt(s.damage),
      duration: txt(s.duration), dv: txt(s.dv), descriptor: clean(txt(s.descriptor)) || undefined,
    };
    withEffects('spells', it, s);
    out.push(it);
  }
  return out;
}

function buildPowers() {
  const x = readXml(path.join(CHUMMER, 'powers.xml'));
  const out = [];
  for (const p of arr(x.powers?.power)) {
    const it = base('powers', p, { costRaw: null, availRaw: null, ratingRaw: '0', catOverride: 'Adept Powers' });
    if (!it) continue;
    it.categoryFr = 'Pouvoirs d’adepte';
    it.stats = {
      points: num(txt(p.points)) ?? 0,
      levels: txt(p.levels) === 'True' || undefined,
      maxLevels: num(txt(p.maxlevels)),
      action: txt(p.action) || undefined,
      extrapointcost: num(txt(p.extrapointcost)) || undefined, // Improved Reflexes: +0.5 PP once (1.5/2.5/3.5)
      bonus: wareBonus(p.bonus), // applied by the training module per level (REA, initiative dice…)
    };
    withEffects('powers', it, p);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
loadFrench();
const programs = buildPrograms();
const programNames = new Set(programs.map((p) => p.name));
const weapons = buildWeapons(); // first: fills hiddenWeapons
const files = {
  weapons,
  accessories: buildAccessories(),
  armor: buildArmor(),
  armormods: buildArmorMods(),
  gear: buildGear(programNames),
  cyberware: buildWare('cyberware', 'cyberware', 'cyberware'),
  bioware: buildWare('bioware', 'bioware', 'bioware'),
  vehicles: buildVehicles(),
  vehiclemods: buildVehicleMods(),
  qualities: buildQualities(),
  spells: buildSpells(),
  powers: buildPowers(),
  programs,
  lifestyles: buildLifestyles(),
  lifestylequalities: buildLifestyleQualities(),
  martialarts: buildMartialArts(),
};

// Rulebook references: model-specific vehicle mods have no page in Chummer (« ? »: Enviroseal, Smart Tires, Drone Rail…).
// They are described with the vehicle that ships them as standard equipment: take that vehicle's page (same book).
{
  const vx = readXml(path.join(CHUMMER, 'vehicles.xml'));
  const pageOfMod = new Map();
  for (const v of arr(vx.vehicles?.vehicle)) {
    const page = num(txt(v.page));
    if (!(page > 0)) continue;
    for (const m of arr(v.mods?.name)) if (txt(m) && !pageOfMod.has(txt(m))) pageOfMod.set(txt(m), { page, source: txt(v.source) });
    for (const m of arr(v.mods?.mod)) if (txt(m?.name) && !pageOfMod.has(txt(m.name))) pageOfMod.set(txt(m.name), { page, source: txt(v.source) });
  }
  for (const m of files.vehiclemods) {
    if (Number(m.page) > 0) continue;
    const hit = pageOfMod.get(m.name);
    if (hit && (!m.source || hit.source === m.source)) m.page = hit.page;
  }
}

// Weapon accessories delivered with a weapon: resolve their names to accessory catalog ids (installed as « included »).
const accByName = new Map(files.accessories.map((a) => [a.name, a.id]));
for (const w of files.weapons) {
  if (!w.stats.included) continue;
  w.stats.included = w.stats.included.map((name) => (accByName.has(name) ? { id: accByName.get(name), name } : { name }));
}

const index = { generated: new Date().toISOString(), source: path.basename(path.dirname(CHUMMER)), files: [] };
const seen = new Set();
const written = {};
for (const [name, list] of Object.entries(files)) {
  // Drop duplicate ids (and exact name duplicates inside a file).
  const names = new Set();
  const items = [];
  for (const it of list) {
    const key = `${it.name}|${it.category}`;
    if (seen.has(it.id) || names.has(key)) {
      drop(name, 'duplicate', it);
      continue;
    }
    seen.add(it.id);
    names.add(key);
    items.push(lean(it));
  }
  items.sort((a, b) => a.category.localeCompare(b.category) || (a.nameFr || a.name).localeCompare(b.nameFr || b.name, 'fr'));
  written[name] = items;
  const json = JSON.stringify(items);
  fs.writeFileSync(path.join(OUT, `${name}.json`), json);
  const cats = {};
  for (const it of items) {
    cats[it.category] = cats[it.category] || { name: it.category, nameFr: it.categoryFr, count: 0 };
    cats[it.category].count++;
  }
  index.files.push({ name, count: items.length, bytes: Buffer.byteLength(json), categories: Object.values(cats).map(lean) });
  console.log(`${name.padEnd(18)} ${String(items.length).padStart(5)} items  ${(Buffer.byteLength(json) / 1024).toFixed(0).padStart(5)} KB`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log('\nDropped:');
for (const [k, v] of Object.entries(stats.dropped).sort()) console.log(`  ${k}: ${v}`);

// ---------------------------------------------------------------------------
// Coverage report (data/catalog/coverage.md): XML entries per source book vs catalog items.
// ---------------------------------------------------------------------------
const XML_SECTIONS = [
  ['weapons', 'weapons.xml', (x) => x.weapons?.weapon],
  ['accessories', 'weapons.xml', (x) => x.accessories?.accessory],
  ['armor', 'armor.xml', (x) => x.armors?.armor],
  ['armormods', 'armor.xml', (x) => x.mods?.mod],
  ['gear', 'gear.xml', (x) => x.gears?.gear],
  ['cyberware', 'cyberware.xml', (x) => x.cyberwares?.cyberware],
  ['bioware', 'bioware.xml', (x) => x.biowares?.bioware],
  ['vehicles', 'vehicles.xml', (x) => x.vehicles?.vehicle],
  ['vehiclemods', 'vehicles.xml', (x) => x.mods?.mod],
  ['qualities', 'qualities.xml', (x) => x.qualities?.quality],
  ['spells', 'spells.xml', (x) => x.spells?.spell],
  ['powers', 'powers.xml', (x) => x.powers?.power],
  ['programs', 'programs.xml', (x) => x.programs?.program],
  ['lifestyles', 'lifestyles.xml', (x) => x.lifestyles?.lifestyle],
  ['lifestylequalities', 'lifestyles.xml', (x) => x.qualities?.quality],
  ['martialarts', 'martialarts.xml', (x) => x.martialarts?.martialart],
];
const books = {};
try {
  for (const b of arr(readXml(path.join(CHUMMER, 'books.xml')).books?.book)) books[txt(b.code)] = clean(txt(b.name));
} catch {}
// Books the table actually used: <source> codes found in the old Chummer characters (historic view), if present.
const CHUM_DIR = path.join(ROOT, '..', 'Shadowrun_chum5_files');
const used = {};
if (fs.existsSync(CHUM_DIR)) {
  for (const f of fs.readdirSync(CHUM_DIR).filter((n) => n.endsWith('.chum5'))) {
    const s = fs.readFileSync(path.join(CHUM_DIR, f), 'utf8');
    for (const m of s.matchAll(/<source>([A-Za-z0-9]+)<\/source>/g)) used[m[1]] = (used[m[1]] || 0) + 1;
  }
}
const cov = {}; // book -> { xml, hidden, catalog, dropped, sections: { name: [xml, catalog] } }
const row = (b) => (cov[b] ||= { xml: 0, hidden: 0, catalog: 0, dropped: 0, sections: {} });
const xmlCache = {};
for (const [name, file, pick] of XML_SECTIONS) {
  const doc = (xmlCache[file] ||= readXml(path.join(CHUMMER, file)));
  for (const x of arr(pick(doc))) {
    const r = row(txt(x.source) || '?');
    r.xml++;
    if (hidden(x)) r.hidden++;
    (r.sections[name] ||= [0, 0])[0]++;
  }
  for (const it of written[name] || []) {
    const r = row(it.source || '?');
    r.catalog++;
    (r.sections[name] ||= [0, 0])[1]++;
  }
}
for (const d of stats.droppedItems) if (d.why !== 'hidden') row(d.source).dropped++;
const order = Object.keys(cov).sort((a, b) => cov[b].xml - cov[a].xml || a.localeCompare(b));
const lines = [
  '# Catalog coverage',
  '',
  `Generated by \`node tools/build-catalog.js\` from ${path.basename(path.dirname(CHUMMER))}. « XML » = entries of the Chummer data files`,
  'for the sections the app uses; « hidden » = entries Chummer itself hides (sub-items granted by another item: underbarrel',
  'weapons, implant weapons, shields, quality weapons…); « catalog » = items in data/catalog; « dropped » = other entries left',
  'out (2050 books, placeholders, items only granted by a parent, duplicates, formulas the app cannot price — see the end).',
  '« used » = occurrences of the book in the old Chummer characters (Shadowrun_chum5_files, historic).',
  '',
  '| Book | Code | used | XML | hidden | catalog | dropped | coverage | sections (catalog/XML) |',
  '|---|---|---:|---:|---:|---:|---:|---:|---|',
];
for (const b of order) {
  const r = cov[b];
  const visible = r.xml - r.hidden;
  const pct = visible > 0 ? `${Math.round((r.catalog / visible) * 100)} %` : '—';
  const secs = Object.entries(r.sections)
    .filter(([, [x, c]]) => x || c)
    .map(([n, [x, c]]) => `${n} ${c}/${x}`)
    .join(', ');
  lines.push(`| ${books[b] || b} | ${b} | ${used[b] || ''} | ${r.xml} | ${r.hidden} | ${r.catalog} | ${r.dropped} | ${pct} | ${secs} |`);
}
const tot = Object.values(cov).reduce((s, r) => ({ xml: s.xml + r.xml, hidden: s.hidden + r.hidden, catalog: s.catalog + r.catalog, dropped: s.dropped + r.dropped }), { xml: 0, hidden: 0, catalog: 0, dropped: 0 });
lines.push(`| **Total** | | | ${tot.xml} | ${tot.hidden} | ${tot.catalog} | ${tot.dropped} | ${Math.round((tot.catalog / Math.max(1, tot.xml - tot.hidden)) * 100)} % | |`);
lines.push('', '## Per catalog file', '', '| file | items | KB |', '|---|---:|---:|');
for (const f of index.files) lines.push(`| ${f.name} | ${f.count} | ${Math.round(f.bytes / 1024)} |`);
lines.push('', '## Dropped entries (excluding Chummer-hidden ones)', '');
const byReason = {};
for (const d of stats.droppedItems) if (d.why !== 'hidden') (byReason[`${d.file}: ${d.why}`] ||= []).push(`${d.name} (${d.source})`);
for (const [k, list] of Object.entries(byReason).sort()) {
  const shown = /source 2050/.test(k) ? `${list.length} items (Shadowrun 2050 conversions, never sold)` : list.slice(0, 40).join(', ') + (list.length > 40 ? `, … (+${list.length - 40})` : '');
  lines.push(`- **${k}** (${list.length}): ${shown}`);
}
lines.push('', 'Not imported on purpose: vehicle weapon mounts (vehicles.xml <weaponmounts>, composite size/visibility/control options) and drug components.', '');
fs.writeFileSync(path.join(OUT, 'coverage.md'), lines.join('\n'));
console.log(`\nCoverage report: ${path.relative(ROOT, path.join(OUT, 'coverage.md'))}`);

// ---------------------------------------------------------------------------
// Effects index (data/catalog/effects.json, read by shared/modifiers.js through server/lib/modifiers.js and the sheet)
// and effects coverage report (data/catalog/effects-coverage.md): Chummer bonus tag → effects supported / unsupported.
// ---------------------------------------------------------------------------
const EFFECT_FILES = ['armor', 'armormods', 'gear', 'cyberware', 'bioware', 'qualities', 'powers', 'accessories', 'lifestylequalities', 'spells'];
const effIndex = { generated: index.generated, files: {}, names: {} };
// Runtime index: only the effects the app uses (no unsupported tags, no free-text choices, no Chummer tag names).
const RUNTIME_SKIP = new Set(['unsupported', 'info']);
const runtimeEffect = (e) => !RUNTIME_SKIP.has(e.type) && !(e.type === 'choice' && e.choice?.kind === 'text');
const allEff = []; // [file, item] of every catalog entry with effects (coverage)
const addEff = (file, it) => {
  if (!it?.effects?.length || !it.id) return;
  allEff.push([file, it]);
  const eff = it.effects.filter(runtimeEffect).map(({ tag, ...e }) => e);
  if (!eff.length) return;
  const f = (effIndex.files[file] ||= {});
  const n = (effIndex.names[file] ||= {});
  f[it.id] = lean({ name: it.name, nameFr: it.nameFr, source: it.source, page: it.page, effects: eff });
  for (const nm of [it.name, it.nameFr]) if (nm && !n[nm.toLowerCase()]) n[nm.toLowerCase()] = it.id;
};
for (const file of EFFECT_FILES) for (const it of written[file] || []) addEff(file, it);
for (const style of written.martialarts || []) for (const tq of style.stats?.techniques || []) addEff('techniques', tq);
fs.writeFileSync(path.join(OUT, 'effects.json'), JSON.stringify(effIndex));

const tagCov = {}; // tag -> { supported, unsupported, files: Set, types: Set }
const typeCov = {};
let withEff = 0;
let withUnsupported = 0;
{
  for (const [file, it] of allEff) {
    withEff++;
    if (it.effects.some((e) => e.type === 'unsupported')) withUnsupported++;
    for (const e of it.effects) {
      const r = (tagCov[e.tag] ||= { supported: 0, unsupported: 0, files: new Set(), types: new Set() });
      r[e.type === 'unsupported' ? 'unsupported' : 'supported']++;
      r.files.add(file);
      if (e.type !== 'unsupported') {
        r.types.add(e.type);
        typeCov[e.type] = (typeCov[e.type] || 0) + 1;
      }
    }
  }
}
const totS = Object.values(tagCov).reduce((s, r) => s + r.supported, 0);
const totU = Object.values(tagCov).reduce((s, r) => s + r.unsupported, 0);
const eLines = [
  '# Effects coverage',
  '',
  `Generated by \`node tools/build-catalog.js\` from ${path.basename(path.dirname(CHUMMER))}. Chummer \`<bonus>\` / \`<wirelessbonus>\` tags of the catalog entries`,
  '(armor, armor mods, gear, cyberware, bioware, qualities, adept powers, weapon accessories, lifestyle options, spells, martial art techniques),',
  'normalized by `tools/lib/bonus-effects.js` into `effects` (see ARCHITECTURE.md « Modifiers »). « supported » = normalized into an effect',
  '(applied to rolls / limits / derived values, or shown as information: resistances, attribute maximums, `baked` attribute / initiative bonuses);',
  '« unsupported » = kept as `{ type: \'unsupported\', tag }` on the entry (chargen, karma costs, critter powers… — nothing is silently dropped).',
  '',
  `Entries with effects: ${withEff} (${withUnsupported} with at least one unsupported tag). Effects: ${totS} supported, ${totU} unsupported.`,
  '',
  '| tag | supported | unsupported | effect types | files |',
  '|---|---:|---:|---|---|',
];
for (const [tag, r] of Object.entries(tagCov).sort((a, b) => b[1].supported + b[1].unsupported - (a[1].supported + a[1].unsupported) || a[0].localeCompare(b[0]))) {
  eLines.push(`| ${tag} | ${r.supported} | ${r.unsupported} | ${[...r.types].join(', ')} | ${[...r.files].join(', ')} |`);
}
eLines.push('', '## Effect types', '', '| type | count |', '|---|---:|');
for (const [ty, n] of Object.entries(typeCov).sort((a, b) => b[1] - a[1])) eLines.push(`| ${ty} | ${n} |`);

// Conditions: every condition key the effects use, with Chummer's own strings (lang/fr-fr.xml, lang/en-us.xml: LimitCondition_*)
// and the app label (shared/modifiers.js CONDITIONS, English in client/i18n/en/sheet.json). « switch » = roll-dialog toggle key.
const langStrings = (file) => {
  const out = {};
  try {
    const doc = parser.parse(fs.readFileSync(path.join(CHUMMER, '..', 'lang', file), 'utf8')).chummer;
    for (const st of [].concat(doc?.strings?.string || [])) {
      const k = String(st?.key ?? '');
      if (k.startsWith('LimitCondition_')) out[conditionKey(k)] = { code: k, text: String(st.text ?? '').trim() };
    }
  } catch {
    /* no language file: Chummer columns stay empty */
  }
  return out;
};
const condFr = langStrings('fr-fr.xml');
const condEn = langStrings('en-us.xml');
let enDict = {};
try {
  enDict = JSON.parse(fs.readFileSync(path.join(ROOT, 'client', 'i18n', 'en', 'sheet.json'), 'utf8'));
} catch {
  /* dictionary missing */
}
const condCount = {};
for (const [, it] of allEff) for (const e of it.effects) if (e.condition) condCount[e.condition] = (condCount[e.condition] || 0) + 1;
const cell = (x) => String(x ?? '').trim().replace(/\|/g, '\\|');
eLines.push('', '## Conditions', '', 'Condition keys of the effects (`effects[].condition`). Unknown keys become their own switch (never applied silently).', '',
  '| key | effects | Chummer code | Chummer FR | Chummer EN | app label (FR) | app label (EN) | switch |', '|---|---:|---|---|---|---|---|---|');
for (const [k, n] of Object.entries(condCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  const label = CONDITIONS[k]?.label || '';
  const tg = conditionToggle(k);
  eLines.push(`| ${k} | ${n} | ${condFr[k]?.code || condEn[k]?.code || '(free text)'} | ${cell(condFr[k]?.text)} | ${cell(condEn[k]?.text)} | ${cell(label || '⚠ none')} | ${cell(label ? enDict[label] || '⚠ missing' : '')} | ${tg === null ? 'automatic' : tg} |`);
}
eLines.push('');
fs.writeFileSync(path.join(OUT, 'effects-coverage.md'), eLines.join('\n'));
console.log(`Effects: ${withEff} entries, ${totS} supported / ${totU} unsupported → ${path.relative(ROOT, path.join(OUT, 'effects-coverage.md'))}`);
