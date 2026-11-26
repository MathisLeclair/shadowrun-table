// Shop rules shared by the server (price authority, server/modules/40-shop.js) and the browser (previews).
// Pure ES module: no DOM, no Node APIs, no imports — keep it that way so both sides can load it.
//
// i18n: labels below are French dictionary keys (marked with tk() for tools/i18n-check.js, English in
// client/i18n/en/shop.json). Render them with t(label) on the client; never translate at module level.
const tk = (s) => s;

/** SR5 'ware grades (core rulebook p.451). */
export const GRADES = {
  standard: { label: tk('Standard'), ess: 1, cost: 1, avail: 0 },
  alpha: { label: tk('Alphaware'), ess: 0.8, cost: 1.2, avail: 2 },
  beta: { label: tk('Betaware'), ess: 0.7, cost: 1.5, avail: 4 },
  delta: { label: tk('Deltaware'), ess: 0.5, cost: 2.5, avail: 8 },
  used: { label: tk("D'occasion"), ess: 1.25, cost: 0.75, avail: -4 },
};
export const GRADE_IDS = Object.keys(GRADES);

/** Catalog files that can be sold in the shop (state.shop.categories keys). */
export const SHOP_FILES = [
  'weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'programs', 'lifestyles',
  'accessories', 'armormods', 'vehiclemods', 'lifestylequalities',
];
export const FILE_LABELS = {
  weapons: tk('Armes'), armor: tk('Armures'), gear: tk('Équipement'), cyberware: tk('Cyberware'), bioware: tk('Bioware'),
  vehicles: tk('Véhicules & drones'), programs: tk('Programmes'), lifestyles: tk('Train de vie'),
  accessories: tk('Accessoires d’armes'), armormods: tk('Modifications d’armure'), vehiclemods: tk('Modifications de véhicule'),
  lifestylequalities: tk('Options de train de vie'), martialarts: tk('Arts martiaux'),
  qualities: tk('Traits'), spells: tk('Sorts'), powers: tk('Pouvoirs d’adepte'),
};

/**
 * Upgrade catalogs: installed on something the character already owns (ARCHITECTURE.md « Upgrades »).
 * file → { list: actor list of the target, sub: nested list on the target item }.
 */
export const UPGRADE_FILES = {
  accessories: { list: 'weapons', sub: 'accessories' },
  armormods: { list: 'armor', sub: 'mods' },
  vehiclemods: { list: 'vehicles', sub: 'mods' },
  lifestylequalities: { list: 'lifestyles', sub: 'qualities' },
};
/** Martial arts: karma, not nuyen (catalog martialarts.json, not in SHOP_FILES). RG p.128: a style includes its first technique. */
export const MARTIAL_KARMA = { style: 7, technique: 5 };

/**
 * Karma for learning `newTechniques` techniques of a martial art style (catalog item; stats.karma = style cost, e.g. 15 for
 * Way of Unified Mana). known = the actor's martialArts entry of that style, or null. RG p.128: the style price includes
 * its first technique — also when the style is known but has no technique yet (bought without, imported).
 */
export function martialKarma(style, known, newTechniques) {
  const tech = Number(style?.stats?.techniqueKarma) || MARTIAL_KARMA.technique;
  const n = Math.max(0, Math.round(Number(newTechniques) || 0));
  if (!known) return (Number(style?.stats?.karma) || MARTIAL_KARMA.style) + Math.max(0, n - 1) * tech;
  const hasTech = Array.isArray(known.techniques) && known.techniques.length > 0;
  return (hasTech ? n : Math.max(0, n - 1)) * tech;
}

/** A lifestyle option (catalog item or lifestyle quality) that lowers the rent: players need the GM's approval. */
export function lowersRent(q) {
  if (!q) return false;
  const mult = q.stats ? q.stats.multiplier : q.multiplier;
  return q.category === 'Negative' || Number(mult) < 0 || Number(q.cost) < 0;
}

/** Gear categories that belong to the « Matrice » and « Magie » storefront sections. */
export const MATRIX_GEAR = new Set([
  'Commlinks', 'Cyberdecks', 'Rigger Command Consoles', 'Cyberterminals', 'Commlink Accessories', 'Commlink Apps',
  'Cyberdeck Modules', 'Matrix Accessories', 'Commlink/Cyberdeck Form Factors', 'Software Tweaks', 'Booster Chips',
  'Hacking Programs', 'Common Programs', 'Software', 'Autosofts', 'PI-Tac Programs',
]);
export const MAGIC_GEAR = new Set([
  'Foci', 'Magical Supplies', 'Magical Compounds', 'Formulae', 'Alchemical Preperations', 'Magical Plants', 'Alchemical Tools',
]);
/** Gear categories whose items can become the actor's Matrix device (actor.matrix). */
export const DEVICE_GEAR = new Set(['Commlinks', 'Cyberdecks', 'Rigger Command Consoles', 'Cyberterminals']);

/** Storefront sections (sidebar). `match(file, item)` says which catalog entries a section shows. `label` = French key: render t(label). */
export const SECTIONS = [
  { id: 'weapons', label: tk('Armes'), icon: '⚔', files: ['weapons'], match: (f) => f === 'weapons' },
  { id: 'armor', label: tk('Armures'), icon: '⛨', files: ['armor'], match: (f) => f === 'armor' },
  { id: 'gear', label: tk('Équipement'), icon: '⚙', files: ['gear'], match: (f, it) => f === 'gear' && !MATRIX_GEAR.has(it.category) && !MAGIC_GEAR.has(it.category) },
  { id: 'cyberware', label: tk('Cyberware'), icon: '⌬', files: ['cyberware'], match: (f) => f === 'cyberware' },
  { id: 'bioware', label: tk('Bioware'), icon: '❦', files: ['bioware'], match: (f) => f === 'bioware' },
  { id: 'vehicles', label: tk('Véhicules & drones'), icon: '⛟', files: ['vehicles'], match: (f) => f === 'vehicles' },
  { id: 'matrix', label: tk('Matrice'), icon: '⌨', files: ['gear', 'programs'], match: (f, it) => f === 'programs' || (f === 'gear' && MATRIX_GEAR.has(it.category)) },
  { id: 'magic', label: tk('Magie'), icon: '✶', files: ['gear'], match: (f, it) => f === 'gear' && MAGIC_GEAR.has(it.category) },
  { id: 'lifestyles', label: tk('Train de vie'), icon: '⌂', files: ['lifestyles', 'lifestylequalities'], match: (f) => f === 'lifestyles' || f === 'lifestylequalities' },
];

/** Storefront-only sections (upgrades installed on owned items, martial arts). Not offered by the character creator. */
export const UPGRADE_SECTIONS = [
  { id: 'accessories', label: tk('Accessoires d’armes'), icon: '⌖', files: ['accessories'], match: (f) => f === 'accessories', after: 'weapons' },
  { id: 'armormods', label: tk('Modifications d’armure'), icon: '⛉', files: ['armormods'], match: (f) => f === 'armormods', after: 'armor' },
  { id: 'vehiclemods', label: tk('Modifications de véhicule'), icon: '⚒', files: ['vehiclemods'], match: (f) => f === 'vehiclemods', after: 'vehicles' },
  { id: 'martialarts', label: tk('Arts martiaux'), icon: '☯', files: [], karma: true, match: () => false, after: 'lifestyles' },
];
/** Every storefront section in display order. */
export const STORE_SECTIONS = SECTIONS.flatMap((s) => [s, ...UPGRADE_SECTIONS.filter((u) => u.after === s.id)]);

/** Which actor list a purchase lands in. */
export function targetList(file, item) {
  const st = item?.stats || {};
  if (file === 'weapons') return st.accessory ? 'gear' : 'weapons';
  if (file === 'armor') return st.mod ? 'gear' : 'armor';
  if (file === 'cyberware' || file === 'bioware') return 'augmentations';
  if (file === 'vehicles') return 'vehicles';
  if (file === 'lifestyles') return 'lifestyles';
  if (UPGRADE_FILES[file]) return 'upgrade';
  return 'gear';
}

// ---------------------------------------------------------------------------
// Formula evaluation (Chummer expressions: "Rating * 500", "(Rating*Rating)*500",
// "FixedValues(2,3,5)", "4000 * Rating - 2000 * number(Rating > 1)", "Variable(20-100)")
// Safe recursive-descent parser: numbers, Rating, MinRating, + - * / ( ), comparisons, number(), FixedValues().
// ---------------------------------------------------------------------------
function tokenize(src) {
  const toks = [];
  const re = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|>=|<=|==|[-+*/(),<>=\[\]])/y;
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`Formule invalide : ${s}`); // i18n-ignore (catalog formula error, developer-facing)
    toks.push(m[1]);
    i = re.lastIndex;
  }
  return toks;
}

/**
 * Evaluate a Chummer-style formula. vars: { Rating, MinRating, ...extra numeric variables (Body, Speed, Handling,
 * Acceleration, Seats, VehicleCost, WeaponCost, ArmorCost…) }. Returns a number (throws on bad input).
 * FixedValues(a,b,c) picks the entry for Rating (1-based, clamped). `a div b` = a / b, `a mod b` = remainder.
 */
export function evalFormula(src, vars = {}) {
  if (typeof src === 'number') return src;
  const text = String(src).replace(/\{([A-Za-z]+)\}/g, '$1').trim();
  const v = text.match(/^Variable\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\)$/i);
  if (v) return Number(v[1]);
  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => {
    if (toks[p] !== t) throw new Error(`Formule invalide : ${text}`); // i18n-ignore (catalog formula error, developer-facing)
    p++;
  };
  const env = { Rating: Number(vars.Rating ?? 1), MinRating: Number(vars.MinRating ?? 1) };
  for (const [k, v] of Object.entries(vars)) if (/^[A-Za-z][A-Za-z0-9]*$/.test(k) && k !== 'number' && Number.isFinite(Number(v)) && v !== null && v !== '') env[k] = Number(v);

  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`Formule incomplète : ${text}`); // i18n-ignore (catalog formula error, developer-facing)
    if (t === '(') { const x = cmp(); expect(')'); return x; }
    if (t === '[') { const x = cmp(); expect(']'); return x; }
    if (/^\d/.test(t)) return Number(t);
    if (t === 'number') { expect('('); const x = cmp(); expect(')'); return x ? 1 : 0; }
    if (t === 'FixedValues') {
      expect('(');
      const args = [cmp()];
      while (peek() === ',') { next(); args.push(cmp()); }
      expect(')');
      const idx = Math.max(0, Math.min(args.length - 1, Math.round(env.Rating) - 1));
      return args[idx];
    }
    if (Object.prototype.hasOwnProperty.call(env, t)) return env[t];
    throw new Error(`Variable inconnue « ${t} » dans ${text}`); // i18n-ignore (catalog formula error, developer-facing)
  }
  function unary() {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return primary();
  }
  function mul() {
    let x = unary();
    while (peek() === '*' || peek() === '/' || peek() === 'div' || peek() === 'mod') {
      const op = next();
      const y = unary();
      if (op === '*') x = x * y;
      else if (op === 'mod') x = y === 0 ? 0 : x % y;
      else x = y === 0 ? 0 : x / y;
    }
    return x;
  }
  function add() {
    let x = mul();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const y = mul();
      x = op === '+' ? x + y : x - y;
    }
    return x;
  }
  function cmp() {
    const x = add();
    const op = peek();
    if (['>', '<', '>=', '<=', '=', '=='].includes(op)) {
      next();
      const y = add();
      if (op === '>') return x > y ? 1 : 0;
      if (op === '<') return x < y ? 1 : 0;
      if (op === '>=') return x >= y ? 1 : 0;
      if (op === '<=') return x <= y ? 1 : 0;
      return x === y ? 1 : 0;
    }
    return x;
  }
  const out = cmp();
  if (p !== toks.length) throw new Error(`Formule invalide : ${text}`); // i18n-ignore (catalog formula error, developer-facing)
  if (!Number.isFinite(out)) throw new Error(`Résultat invalide : ${text}`); // i18n-ignore (catalog formula error, developer-facing)
  return out;
}

/** Clamp a requested rating to the item's range (null when the item has no rating). */
export function clampRating(item, rating) {
  if (!item?.rating) return null;
  const { min = 1, max = min } = item.rating;
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r)) return min;
  return Math.max(min, Math.min(max, r));
}

/** Grades allowed for a cyberware/bioware catalog item ([] = grade does not apply). */
export function allowedGrades(item) {
  if (Array.isArray(item?.grades)) return item.grades;
  return GRADE_IDS;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Full price sheet of one unit of a catalog item.
 * opts: { rating, grade, markup (percent), price (for Variable-cost items: wanted price, clamped to the range), vars (extra formula variables) }
 * → { rating, grade, base, unitCost, availValue, legality, avail: '8R', essence }
 */
export function quote(item, opts = {}) {
  const rating = clampRating(item, opts.rating);
  // opts.vars: extra formula variables of the target (vehicle Body/Speed…, WeaponCost, ArmorCost, VehicleCost).
  const vars = { ...(opts.vars || {}), Rating: rating ?? 1, MinRating: item?.rating?.min ?? 1 };
  const grades = allowedGrades(item);
  const isWare = item?.essence !== undefined || Array.isArray(item?.grades);
  let grade = null;
  if (isWare) grade = grades.includes(opts.grade) ? opts.grade : grades.includes('standard') ? 'standard' : grades[0] || null;
  const g = GRADES[grade] || GRADES.standard;

  let base;
  if (item.costRange) {
    const [lo, hi] = item.costRange;
    const want = Number(opts.price);
    base = Number.isFinite(want) && opts.price !== undefined && opts.price !== null && opts.price !== '' ? Math.max(lo, Math.min(hi, want)) : lo;
  } else if (item.costFormula) base = evalFormula(item.costFormula, vars);
  else base = Number(item.cost) || 0;
  const markup = Number(opts.markup) || 0;
  const unitCost = Math.max(0, Math.round(base * g.cost * (1 + markup / 100)));

  let availValue = item.availFormula ? evalFormula(item.availFormula, vars) : Number(item.availValue) || 0;
  availValue = Math.max(0, Math.round(availValue + (grade ? g.avail : 0)));
  const legality = item.legality || '';

  let essence;
  if (item.essence !== undefined) {
    const e = typeof item.essence === 'number' ? item.essence : evalFormula(item.essence, vars);
    essence = round4(Math.max(0, e) * g.ess);
  }
  return { rating, grade, base: round2(base), unitCost, availValue, legality, avail: `${availValue}${legality}`, essence };
}

/** "8R" → { value: 8, legality: 'R' } */
export function parseAvailString(avail) {
  const m = String(avail ?? '').match(/(\d+)\s*([RF])?/i);
  return { value: m ? Number(m[1]) : 0, legality: m && m[2] ? m[2].toUpperCase() : '' };
}

/** French display name (stored on the actor / server side). The client shows catalog items with itemName() of lib/i18n.js. */
export function itemName(item) {
  return item?.nameFr || item?.name || '?';
}

/** Lowercase, accent-free text for searching. */
export function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export const LEGALITY_LABEL = { '': tk('Légal'), R: tk('Restreint'), F: tk('Interdit') };

/** Magic/Resonance points lost when Essence drops from `before` to `after` (SR5: 1 per started point lost). */
export function magicLoss(before, after) {
  const lost = (e) => Math.ceil(Math.max(0, 6 - e) - 1e-9);
  return Math.max(0, lost(after) - lost(before));
}

// ---------------------------------------------------------------------------
// Upgrades: weapon accessories (mounts), armor modifications (capacity), vehicle modifications (slots).
// Fit checks return { problem: null } when OK, else a message: French key string (static) or { key, params } (dynamic).
// Target items keep the schema of ARCHITECTURE.md « Upgrades »: weapon.mounts/accessories, armor.capacity/mods, vehicle.mods.
// ---------------------------------------------------------------------------
const n0 = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
/** Standard SR5 mount points, used for ranged weapons that predate weapon.mounts and have no catalog entry. */
export const STANDARD_MOUNTS = ['Top', 'Under', 'Barrel', 'Stock', 'Side'];
export const MOUNT_LABELS = { Top: tk('Dessus'), Under: tk('Dessous'), Barrel: tk('Canon'), Stock: tk('Crosse'), Side: tk('Flanc'), Internal: tk('Interne'), '': tk('Sans montage') };

/**
 * Mount points of a weapon: its own list, else its catalog item's (none when the catalog lists no <accessorymounts>:
 * bows, holdouts, crossbows…), else standard ones for ranged weapons without a catalog entry.
 */
export function weaponMounts(weapon, catItem) {
  let base;
  if (Array.isArray(weapon?.mounts)) base = weapon.mounts;
  else if (catItem) base = Array.isArray(catItem.stats?.mounts) ? catItem.stats.mounts : [];
  else base = weapon?.kind === 'melee' ? [] : STANDARD_MOUNTS;
  // Accessories like a slide mount add mount points (catalog stats.extraMount, copied on the accessory as extraMount).
  const extra = (weapon?.accessories || []).flatMap((a) => (Array.isArray(a?.extraMount) ? a.extraMount : []));
  return [...new Set([...base, ...extra])];
}

/** Mount points already taken by installed accessories (included ones sit on « Internal »). */
export function usedMounts(weapon) {
  return (weapon?.accessories || []).filter((a) => a && a.mount && a.mount !== 'Internal' && !a.included).map((a) => a.mount);
}

/** Free mount points of the weapon accepted by this accessory (catalog item). [''] = needs no mount. */
export function freeMounts(weapon, weaponCat, accItem) {
  const wants = Array.isArray(accItem?.stats?.mount) ? accItem.stats.mount : [];
  if (!wants.length) return [''];
  const have = weaponMounts(weapon, weaponCat);
  const used = usedMounts(weapon);
  return wants.filter((m) => have.includes(m) && !used.includes(m));
}

const lowerList = (l) => (Array.isArray(l) ? l.map((x) => String(x).toLowerCase()) : []);
/** Does a catalog requirement (build-catalog detailsOf: names / namesContains / categories / categoriesContains / types) list anything? */
const hasDetails = (det) => !!det && ['names', 'namesContains', 'categories', 'categoriesContains', 'types'].some((k) => Array.isArray(det[k]) && det[k].length);
/** Any listed value matches (exact, or substring for the *Contains lists). names / cat / type: the item's lower-cased values. */
function detailsMatch(det, names, cat, type) {
  if (!hasDetails(det)) return false;
  const eqNames = lowerList(det.names);
  const inNames = lowerList(det.namesContains);
  const eqCats = lowerList(det.categories);
  const inCats = lowerList(det.categoriesContains);
  const types = lowerList(det.types);
  return (
    names.some((x) => eqNames.includes(x) || inNames.some((p) => x.includes(p))) ||
    (!!cat && (eqCats.includes(cat) || inCats.some((p) => cat.includes(p)))) ||
    (!!type && types.includes(type))
  );
}
function matchDetails(det, weapon, weaponCat) {
  const wNames = [weapon?.name, weaponCat?.name, weaponCat?.nameFr].filter(Boolean).map((x) => String(x).toLowerCase());
  const wCat = String(weaponCat?.category || weapon?.category || '').toLowerCase();
  const wType = weapon?.kind === 'melee' || weaponCat?.stats?.type === 'melee' ? 'melee' : 'ranged';
  return detailsMatch(det, wNames, wCat, wType);
}

/**
 * Can this accessory (catalog item) go on this weapon? opts: { mount } (wanted mount point).
 * → { mount, problem } — mount = the mount point it will use ('' = none), problem = null or a message.
 */
export function accessoryFit(weapon, weaponCat, accItem, opts = {}) {
  const st = accItem?.stats || {};
  const params = { item: accItem?.nameFr || accItem?.name || '?', weapon: weapon?.name || '?' };
  if (hasDetails(st.requires) && !matchDetails(st.requires, weapon, weaponCat)) return { mount: null, problem: { key: tk('{item} ne s’adapte pas sur {weapon}'), params } };
  if (hasDetails(st.forbids) && matchDetails(st.forbids, weapon, weaponCat)) return { mount: null, problem: { key: tk('{item} ne s’adapte pas sur {weapon}'), params } };
  if ((weapon?.accessories || []).some((a) => a.catalogId && a.catalogId === accItem?.id)) return { mount: null, problem: { key: tk('{item} est déjà installé sur {weapon}'), params } };
  const free = freeMounts(weapon, weaponCat, accItem);
  if (!free.length) return { mount: null, problem: { key: tk('Aucun emplacement libre ({mounts}) sur {weapon}'), params: { mounts: (st.mount || []).join(' / '), weapon: params.weapon } } };
  const mount = opts.mount !== undefined && opts.mount !== null && free.includes(opts.mount) ? opts.mount : free[0];
  return { mount, problem: null };
}

/** Accessory effects stored on weapon.accessories[].effects (sheet: weaponMods()). */
export function accessoryEffects(accItem) {
  const st = accItem?.stats || {};
  const e = {};
  if (st.accuracy) e.accuracy = n0(st.accuracy);
  if (st.rc) e.rc = n0(st.rc);
  if (st.rcGroup) e.rcGroup = n0(st.rcGroup);
  if (st.smartgun) e.smartgun = true;
  return e;
}

const LEGALITY_RANK = { '': 0, R: 1, F: 2 };
/**
 * Availability of an upgrade on its target: catalog items flagged `availRelative` (Chummer « +2R »: Smartgun System,
 * Internal; YNT Softweave…) add the target's availability (targetQuote = quote() of the target's catalog item, or null)
 * and keep the stricter legality. Returns a new quote-like object.
 */
export function upgradeAvail(q, item, targetQuote) {
  if (!item?.availRelative || !targetQuote) return q;
  const availValue = Math.max(0, Math.round(n0(q.availValue) + n0(targetQuote.availValue)));
  const a = q.legality || '';
  const b = targetQuote.legality || '';
  const legality = (LEGALITY_RANK[b] || 0) > (LEGALITY_RANK[a] || 0) ? b : a;
  return { ...q, availValue, legality, avail: `${availValue}${legality}` };
}

/** Armor capacity: armor.capacity, else the catalog's, else the armor rating (SR5 p.436: capacity = armor rating). */
export function armorCapacity(armor, armorCat) {
  if (armor?.capacity !== undefined && armor.capacity !== null && armor.capacity !== '') return n0(armor.capacity);
  if (armorCat?.stats?.capacity !== undefined) return n0(armorCat.stats.capacity);
  return n0(armor?.rating);
}
/** Capacity used by installed mods (negative capacity, e.g. YNT Softweave, adds space). */
export function armorCapacityUsed(armor) {
  return Math.round((armor?.mods || []).reduce((s, m) => s + (m && m.equipped !== false ? n0(m.capacity) : 0), 0) * 100) / 100;
}
/** Capacity an armor mod (catalog item) takes at this rating on an armor of this capacity. */
export function armorModCapacity(modItem, rating, capacity) {
  const c = modItem?.stats?.capacity ?? 0;
  if (typeof c === 'number') return c;
  try {
    return Math.round(evalFormula(c, { Rating: rating ?? 1, Capacity: capacity }) * 100) / 100;
  } catch {
    return 0;
  }
}
export function armorModFit(armor, armorCat, modItem, rating) {
  const cap = armorCapacity(armor, armorCat);
  const need = armorModCapacity(modItem, rating, cap);
  const used = armorCapacityUsed(armor);
  const params = { item: modItem?.nameFr || modItem?.name || '?', armor: armor?.name || '?' };
  if ((armor?.mods || []).some((m) => m.catalogId && m.catalogId === modItem?.id)) return { need, used, cap, problem: { key: tk('{item} est déjà installé sur {armor}'), params } };
  if (need > 0 && used + need > cap) {
    return { need, used, cap, problem: { key: tk('Capacité insuffisante sur {armor} : {need} requis, {free} libre(s)'), params: { armor: params.armor, need, free: Math.max(0, Math.round((cap - used) * 100) / 100) } } };
  }
  return { need, used, cap, problem: null };
}

/** First number of a vehicle stat ('5/3' → 5). */
const statNum = (v) => n0(String(v ?? '').split('/')[0]);
/** Formula variables of a vehicle for mod prices/slots (R5). */
export function vehicleVars(vehicle, vehicleCat, vehicleCost) {
  const st = vehicleCat?.stats || {};
  const pick = (k) => (vehicle?.[k] !== undefined && vehicle[k] !== null && vehicle[k] !== '' ? statNum(vehicle[k]) : statNum(st[k]));
  return {
    Body: pick('body'), Speed: pick('speed'), Handling: pick('handling'), Acceleration: pick('accel'), Pilot: pick('pilot'),
    Sensor: pick('sensor'), Seats: pick('seats'), Armor: pick('armor'), VehicleCost: n0(vehicleCost),
  };
}
/** R5 modification categories with their own slot pool on (non-drone) vehicles. */
export const VEHICLE_SLOT_CATEGORIES = ['Powertrain', 'Protection', 'Weapons', 'Body', 'Electromagnetic', 'Cosmetic'];
/** One slot pool for every mod: drones, and vehicles without a catalog entry (their type is unknown). */
export function singleSlotPool(vehicle, vehicleCat) {
  return !vehicleCat || !!vehicleCat.stats?.drone || /^Drones/i.test(vehicleCat.category || '');
}
/**
 * Slot pool a mod category uses on this vehicle: 'all' (drones: single « Mod Slots » pool), a VEHICLE_SLOT_CATEGORIES
 * entry, or null (« All », « Model-Specific », drone-attribute categories: no category pool on a vehicle).
 */
export function vehicleSlotPool(vehicle, vehicleCat, category) {
  if (singleSlotPool(vehicle, vehicleCat)) return 'all';
  return VEHICLE_SLOT_CATEGORIES.includes(category) ? category : null;
}
/**
 * Modification slots of a vehicle (R5). Drones: Body + <modslots>. Other vehicles: one pool per category = Body +
 * <xxxmodslots> of the model (catalog stats.slotBonus[pool]). vehicle.slots overrides.
 */
export function vehicleSlots(vehicle, vehicleCat, pool) {
  if (vehicle?.slots !== undefined && vehicle.slots !== null && vehicle.slots !== '') return n0(vehicle.slots);
  const body = vehicleVars(vehicle, vehicleCat).Body;
  if (singleSlotPool(vehicle, vehicleCat)) return body + n0(vehicleCat?.stats?.modSlots);
  return Math.max(0, body + n0(vehicleCat?.stats?.slotBonus?.[pool]));
}
/** Slots used by installed (non built-in) mods of one pool ('all' / undefined = every mod). */
export function vehicleSlotsUsed(vehicle, pool) {
  return (vehicle?.mods || []).reduce((s, m) => s + (m && !m.included && (!pool || pool === 'all' || m.category === pool) ? n0(m.slots) : 0), 0);
}
/** Slots a vehicle mod (catalog item) takes at this rating on this vehicle (vars = vehicleVars()). */
export function vehicleModSlots(modItem, rating, vars) {
  const s = modItem?.stats?.slots ?? 0;
  if (typeof s === 'number') return s;
  try {
    return Math.round(evalFormula(s, { ...(vars || {}), Rating: rating ?? 1 }));
  } catch {
    return 0;
  }
}
/** Max rating of a vehicle mod on this vehicle (stats.ratingVar: Body / Seats), or the catalog max. */
export function vehicleModMaxRating(modItem, vars) {
  const v = modItem?.stats?.ratingVar;
  if (v === 'Body' || v === 'Seats') return Math.max(1, n0(vars?.[v]));
  return modItem?.rating?.max ?? null;
}
/**
 * Can this vehicle mod (catalog item) go on this vehicle? → { need, used, cap, pool, problem }: cap / used of the mod's
 * slot pool (vehicleSlotPool); a mod without a pool (null: « All », « Model-Specific »… on a vehicle) is not limited.
 */
export function vehicleModFit(vehicle, vehicleCat, modItem, rating, vars) {
  const pool = vehicleSlotPool(vehicle, vehicleCat, modItem?.category);
  const cap = pool ? vehicleSlots(vehicle, vehicleCat, pool) : null;
  const used = pool ? vehicleSlotsUsed(vehicle, pool) : 0;
  const need = vehicleModSlots(modItem, rating, vars);
  const st = modItem?.stats || {};
  const params = { item: modItem?.nameFr || modItem?.name || '?', vehicle: vehicle?.name || '?' };
  const vNames = [vehicle?.name, vehicleCat?.name, vehicleCat?.nameFr].filter(Boolean).map((x) => String(x).toLowerCase());
  const vCat = String(vehicleCat?.category || '').toLowerCase();
  if ((hasDetails(st.requires) && !detailsMatch(st.requires, vNames, vCat, '')) || (hasDetails(st.forbids) && detailsMatch(st.forbids, vNames, vCat, ''))) {
    return { need, used, cap, pool, problem: { key: tk('{item} ne s’adapte pas sur {vehicle}'), params } };
  }
  if ((vehicle?.mods || []).some((m) => m.catalogId && m.catalogId === modItem?.id)) return { need, used, cap, pool, problem: { key: tk('{item} est déjà installé sur {vehicle}'), params } };
  if (pool && need > 0 && used + need > cap) {
    return { need, used, cap, pool, problem: { key: tk('Emplacements insuffisants sur {vehicle} : {need} requis, {free} libre(s)'), params: { vehicle: params.vehicle, need, free: Math.max(0, cap - used) } } };
  }
  return { need, used, cap, pool, problem: null };
}
/** Numeric bonuses of a vehicle mod at a rating ({ handling: 1, … }), stored as vehicle.mods[].effects. */
export function vehicleModEffects(modItem, rating, vars) {
  const out = {};
  for (const [k, f] of Object.entries(modItem?.stats?.bonus || {})) {
    try {
      const v = Math.round(evalFormula(f, { ...(vars || {}), Rating: rating ?? 1 }));
      if (v) out[k] = v;
    } catch {}
  }
  return out;
}

/**
 * Target-dependent fields of an upgrade picked from a catalog for one owned item (sheet nested editor; the shop prices
 * with the same rules). parent = the weapon / armor / vehicle, parentCat = its catalog item (or null), parentValue = its
 * price (« Weapon Cost »…, or null when unknown). → { cost?, capacity?, slots? } (cost left out when it cannot be priced).
 */
export function upgradeFields(file, entry, parent, { rating, parentCat = null, parentValue = null } = {}) {
  const out = {};
  const price = (vars) => {
    if (!entry?.costFormula) return;
    if (parentValue === null && /(Weapon|Armor|Vehicle)Cost/.test(entry.costFormula)) return;
    try {
      out.cost = quote(entry, { rating, vars }).unitCost;
    } catch {}
  };
  if (file === 'armormods') {
    const cap = armorCapacity(parent, parentCat);
    out.capacity = armorModCapacity(entry, rating, cap);
    price({ ArmorCost: parentValue ?? 0, Capacity: cap });
  } else if (file === 'vehiclemods') {
    const vars = vehicleVars(parent, parentCat, parentValue ?? 0);
    out.slots = vehicleModSlots(entry, rating, vars);
    price(vars);
  } else if (file === 'accessories') price({ WeaponCost: parentValue ?? 0 });
  return out;
}
