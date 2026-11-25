// Shop rules shared by the server (price authority, server/modules/40-shop.js) and the browser (previews).
// Pure ES module: no DOM, no Node APIs, no imports — keep it that way so both sides can load it.

/** SR5 'ware grades (core rulebook p.451). */
export const GRADES = {
  standard: { label: 'Standard', ess: 1, cost: 1, avail: 0 },
  alpha: { label: 'Alphaware', ess: 0.8, cost: 1.2, avail: 2 },
  beta: { label: 'Betaware', ess: 0.7, cost: 1.5, avail: 4 },
  delta: { label: 'Deltaware', ess: 0.5, cost: 2.5, avail: 8 },
  used: { label: "D'occasion", ess: 1.25, cost: 0.75, avail: -4 },
};
export const GRADE_IDS = Object.keys(GRADES);

/** Catalog files that can be sold in the shop (state.shop.categories keys). */
export const SHOP_FILES = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'programs', 'lifestyles'];
export const FILE_LABELS = {
  weapons: 'Armes', armor: 'Armures', gear: 'Équipement', cyberware: 'Cyberware', bioware: 'Bioware',
  vehicles: 'Véhicules & drones', programs: 'Programmes', lifestyles: 'Train de vie',
  qualities: 'Traits', spells: 'Sorts', powers: 'Pouvoirs d’adepte',
};

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

/** Storefront sections (sidebar). `match(file, item)` says which catalog entries a section shows. */
export const SECTIONS = [
  { id: 'weapons', label: 'Armes', icon: '⚔', files: ['weapons'], match: (f) => f === 'weapons' },
  { id: 'armor', label: 'Armures', icon: '⛨', files: ['armor'], match: (f) => f === 'armor' },
  { id: 'gear', label: 'Équipement', icon: '⚙', files: ['gear'], match: (f, it) => f === 'gear' && !MATRIX_GEAR.has(it.category) && !MAGIC_GEAR.has(it.category) },
  { id: 'cyberware', label: 'Cyberware', icon: '⌬', files: ['cyberware'], match: (f) => f === 'cyberware' },
  { id: 'bioware', label: 'Bioware', icon: '❦', files: ['bioware'], match: (f) => f === 'bioware' },
  { id: 'vehicles', label: 'Véhicules & drones', icon: '⛟', files: ['vehicles'], match: (f) => f === 'vehicles' },
  { id: 'matrix', label: 'Matrice', icon: '⌨', files: ['gear', 'programs'], match: (f, it) => f === 'programs' || (f === 'gear' && MATRIX_GEAR.has(it.category)) },
  { id: 'magic', label: 'Magie', icon: '✶', files: ['gear'], match: (f, it) => f === 'gear' && MAGIC_GEAR.has(it.category) },
  { id: 'lifestyles', label: 'Train de vie', icon: '⌂', files: ['lifestyles'], match: (f) => f === 'lifestyles' },
];

/** Which actor list a purchase lands in. */
export function targetList(file, item) {
  const st = item?.stats || {};
  if (file === 'weapons') return st.accessory ? 'gear' : 'weapons';
  if (file === 'armor') return st.mod ? 'gear' : 'armor';
  if (file === 'cyberware' || file === 'bioware') return 'augmentations';
  if (file === 'vehicles') return 'vehicles';
  if (file === 'lifestyles') return 'lifestyle';
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
    if (!m) throw new Error(`Formule invalide : ${s}`);
    toks.push(m[1]);
    i = re.lastIndex;
  }
  return toks;
}

/**
 * Evaluate a Chummer-style formula. vars: { Rating, MinRating }. Returns a number (throws on bad input).
 * FixedValues(a,b,c) picks the entry for Rating (1-based, clamped).
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
    if (toks[p] !== t) throw new Error(`Formule invalide : ${text}`);
    p++;
  };
  const env = { Rating: Number(vars.Rating ?? 1), MinRating: Number(vars.MinRating ?? 1) };

  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`Formule incomplète : ${text}`);
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
    if (t in env) return env[t];
    throw new Error(`Variable inconnue « ${t} » dans ${text}`);
  }
  function unary() {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return primary();
  }
  function mul() {
    let x = unary();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const y = unary();
      x = op === '*' ? x * y : y === 0 ? 0 : x / y;
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
  if (p !== toks.length) throw new Error(`Formule invalide : ${text}`);
  if (!Number.isFinite(out)) throw new Error(`Résultat invalide : ${text}`);
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
 * opts: { rating, grade, markup (percent), price (for Variable-cost items: wanted price, clamped to the range) }
 * → { rating, grade, base, unitCost, availValue, legality, avail: '8R', essence }
 */
export function quote(item, opts = {}) {
  const rating = clampRating(item, opts.rating);
  const vars = { Rating: rating ?? 1, MinRating: item?.rating?.min ?? 1 };
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

/** Display name (French when available). */
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

export const LEGALITY_LABEL = { '': 'Légal', R: 'Restreint', F: 'Interdit' };

/** Magic/Resonance points lost when Essence drops from `before` to `after` (SR5: 1 per started point lost). */
export function magicLoss(before, after) {
  const lost = (e) => Math.ceil(Math.max(0, 6 - e) - 1e-9);
  return Math.max(0, lost(after) - lost(before));
}
