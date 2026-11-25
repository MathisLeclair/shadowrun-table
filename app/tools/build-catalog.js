// Build the gear catalog (data/catalog/*.json) from Chummer5 SR5 data files.
//   npm run build:catalog            (or: node tools/build-catalog.js [path/to/Chummer5/data])
// Output item format (see ARCHITECTURE.md > Shop):
//   { id, name, nameFr?, category, categoryFr?, cost, costFormula?, costRange?, avail, availValue, legality,
//     availFormula?, rating?: {min,max}, essence?, grades?, source, page, stats: {...} }
// Null/empty fields are omitted to keep the files lean.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { evalFormula } from '../client/modules/shop/rules.js';

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
const stats = { dropped: {} };
const drop = (file, why) => {
  const k = `${file}: ${why}`;
  stats.dropped[k] = (stats.dropped[k] || 0) + 1;
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
const UNSUPPORTED_VARS = /Gear Cost|Parent|Armor Cost|Vehicle Cost|Weapon Cost|Body|Speed|Handling|Acceleration|Pilot|Sensor|Seats|STR|AGI|MAG|RES|CHA|INT|LOG|WIL|BOD|REA|Maximum|Minimum|Children|Capacity|Ammo/;

function normFormula(s) {
  return String(s)
    .replace(/\{([A-Za-z ]+)\}/g, '$1')
    .replace(/\[(\d+(?:\.\d+)?)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Validate a formula over the rating range; returns false if it can't be evaluated. */
function formulaOk(f, rating) {
  if (UNSUPPORTED_VARS.test(f)) return false;
  try {
    const lo = rating?.min ?? 1;
    const hi = rating?.max ?? lo;
    for (const r of new Set([lo, hi, Math.round((lo + hi) / 2)])) evalFormula(f, { Rating: r, MinRating: lo });
    return true;
  } catch {
    return false;
  }
}

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
  return { cost: Math.round(evalFormula(s, { Rating: rating?.min ?? 1, MinRating: rating?.min ?? 1 })), costFormula: s };
}

/** avail → { avail, availValue, legality, availFormula? } or null. */
function parseAvail(raw, rating) {
  let s = normFormula(txt(raw) || '0').replace(/\s+or\s+Gear$/i, '');
  if (s.startsWith('+')) s = s.slice(1).trim();
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
  if (isNum(s)) {
    const v = Number(s);
    return { avail: `${v}${legality}`, availValue: v, legality };
  }
  if (!formulaOk(s, rating) || (!rating && /Rating/.test(s))) return null;
  const v = Math.round(evalFormula(s, { Rating: rating?.min ?? 1, MinRating: rating?.min ?? 1 }));
  return { avail: `${v}${legality}`, availValue: v, legality, availFormula: s };
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

/** Common fields; returns null if the entry must be dropped. */
function base(file, x, { ratingRaw, minRaw, costRaw, availRaw, frFile = file, catOverride } = {}) {
  const name = clean(txt(x.name));
  const id = txt(x.id);
  if (!id || !name) return drop(file, 'no id/name');
  if (hidden(x)) return drop(file, 'hidden');
  if (SKIP_SOURCES.has(txt(x.source))) return drop(file, 'source 2050');
  if (/^\[?custom\b|\(custom\)|\[custom/i.test(name) || /^Custom Item$/i.test(name)) return drop(file, 'custom placeholder');
  const category = catOverride || clean(txt(x.category));
  if (/^Custom( |$)/i.test(category)) return drop(file, 'custom category');
  const { ok, rating } = parseRating(ratingRaw === undefined ? x.rating : ratingRaw, minRaw === undefined ? x.minrating : minRaw);
  if (!ok) return drop(file, 'rating formula');
  const out = { id, name, nameFr: french(frFile, id, name), category, categoryFr: frenchCat(frFile, category) };
  if (costRaw !== null) {
    const c = parseCost(costRaw === undefined ? x.cost : costRaw, rating);
    if (!c) return drop(file, 'cost formula');
    Object.assign(out, c);
  }
  if (availRaw !== null) {
    const a = parseAvail(availRaw === undefined ? x.avail : availRaw, rating);
    if (!a) return drop(file, 'avail formula');
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
      drop('weapons', 'granted by other item');
      continue;
    }
    const it = base('weapons', w);
    if (!it) continue;
    it.stats = weaponStats(w);
    out.push(it);
  }
  for (const a of arr(x.accessories?.accessory)) {
    const max = num(txt(a.rating)) || 0;
    const it = base('weapons', a, { catOverride: 'Weapon Accessories', ratingRaw: max > 0 ? String(max) : '0', minRaw: '1' });
    if (!it) continue;
    it.categoryFr = 'Accessoires d’armes';
    it.stats = {
      accessory: true,
      mount: clean(txt(a.mount)).split('/').filter(Boolean).join(', ') || undefined,
      rc: num(txt(a.rc)),
      accuracy: num(txt(a.accuracy)),
      conceal: num(txt(a.conceal)),
    };
    out.push(it);
  }
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
      drop('armor', 'armor formula without rating');
      continue;
    }
    out.push(it);
  }
  for (const m of arr(x.mods?.mod)) {
    const max = num(txt(m.maxrating)) || 0;
    const it = base('armor', m, { ratingRaw: String(max), minRaw: '1', catOverride: 'Armor Modifications' });
    if (!it) continue;
    it.categoryFr = 'Modifications d’armure';
    const raw = txt(m.armor).replace(/^\+/, '');
    it.stats = { mod: true, armor: isNum(raw) && Number(raw) ? Number(raw) : undefined, capacity: txt(m.armorcapacity) || undefined };
    out.push(it);
  }
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
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vehicles & drones
// ---------------------------------------------------------------------------
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
    };
    out.push(it);
  }
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
  for (const l of arr(x.lifestyles?.lifestyle)) {
    if (/ERROR/i.test(txt(l.name))) {
      drop('lifestyles', 'placeholder');
      continue;
    }
    const it = base('lifestyles', l, { availRaw: null, catOverride: 'Lifestyles' });
    if (!it) continue;
    it.categoryFr = 'Train de vie';
    it.avail = '0';
    it.availValue = 0;
    it.legality = '';
    it.stats = { monthly: true, startingDice: txt(l.dice) || undefined, startingMultiplier: num(txt(l.multiplier)) };
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
  armor: buildArmor(),
  gear: buildGear(programNames),
  cyberware: buildWare('cyberware', 'cyberware', 'cyberware'),
  bioware: buildWare('bioware', 'bioware', 'bioware'),
  vehicles: buildVehicles(),
  qualities: buildQualities(),
  spells: buildSpells(),
  powers: buildPowers(),
  programs,
  lifestyles: buildLifestyles(),
};

const index = { generated: new Date().toISOString(), source: path.basename(path.dirname(CHUMMER)), files: [] };
const seen = new Set();
for (const [name, list] of Object.entries(files)) {
  // Drop duplicate ids (and exact name duplicates inside a file).
  const names = new Set();
  const items = [];
  for (const it of list) {
    const key = `${it.name}|${it.category}`;
    if (seen.has(it.id) || names.has(key)) {
      drop(name, 'duplicate');
      continue;
    }
    seen.add(it.id);
    names.add(key);
    items.push(lean(it));
  }
  items.sort((a, b) => a.category.localeCompare(b.category) || (a.nameFr || a.name).localeCompare(b.nameFr || b.name, 'fr'));
  const json = JSON.stringify(items);
  fs.writeFileSync(path.join(OUT, `${name}.json`), json);
  const cats = {};
  for (const it of items) {
    cats[it.category] = cats[it.category] || { name: it.category, nameFr: it.categoryFr, count: 0 };
    cats[it.category].count++;
  }
  index.files.push({ name, count: items.length, bytes: Buffer.byteLength(json), categories: Object.values(cats).map(lean) });
  console.log(`${name.padEnd(11)} ${String(items.length).padStart(5)} items  ${(Buffer.byteLength(json) / 1024).toFixed(0).padStart(5)} KB`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log('\nDropped:');
for (const [k, v] of Object.entries(stats.dropped).sort()) console.log(`  ${k}: ${v}`);
