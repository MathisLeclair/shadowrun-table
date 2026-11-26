// Shop module: gear catalog price authority, player purchases/sales, GM approval queue, fixer specials, lifestyles
// (several per actor, with upgrades), upgrades installed on owned items (weapon accessories, armor/vehicle mods),
// martial arts (karma, GM-approved).
// State slice: state.shop (see ARCHITECTURE.md > Shop & « Upgrades »). Pricing rules are shared with the client
// (client/modules/shop/rules.js), lifestyle costs with shared/lifestyle.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nuyen, deepClone } from '../../shared/util.js';
import {
  SHOP_FILES, FILE_LABELS, GRADES, DEVICE_GEAR, UPGRADE_FILES, quote, targetList, parseAvailString, itemName,
  evalFormula, magicLoss, allowedGrades, fold, accessoryFit, accessoryEffects, armorCapacity, armorModFit, vehicleVars,
  vehicleModFit, vehicleModEffects, vehicleModMaxRating, martialKarma, lowersRent, upgradeAvail,
} from '../../client/modules/shop/rules.js';
import { monthlyCost, settleLifestyles, primaryLifestyle, lifestyleFromCatalog, qualityFromCatalog, qualityProblem, baseOf } from '../../shared/lifestyle.js';
import { removeBonus, weaponFromStats, bakeItemBonus } from '../lib/augment.js';
import { formatFr } from '../lib/i18n.js';
import { fillActorRefs } from '../lib/bookrefs.js';

/** Marks a translatable key for tools/i18n-check.js (English in client/i18n/en/shop.json). */
const tk = (s) => s;

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles'];
const MAX_ORDERS = 400;
const APPROVAL_MODES = ['never', 'restricted', 'always'];
/** Nested list of each upgradable actor list. */
const SUB_OF = { weapons: 'accessories', armor: 'mods', vehicles: 'mods', lifestyles: 'qualities' };

// ---------------------------------------------------------------------------
// Catalog index (server-side price authority)
// ---------------------------------------------------------------------------
const INDEX = new Map(); // catalog id -> { item, file }
const BY_NAME = new Map(); // folded English/French name -> { item, file } (to price legacy items without catalogId)
const MARTIAL = new Map(); // martial art style id -> style (karma, data/catalog/martialarts.json)

function loadCatalogs() {
  INDEX.clear();
  BY_NAME.clear();
  MARTIAL.clear();
  for (const file of SHOP_FILES) {
    const p = path.join(CATALOG_DIR, `${file}.json`);
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.warn(`[shop] catalog ${file}.json missing or invalid (run npm run build:catalog)`);
      continue;
    }
    for (const item of list) {
      const entry = { item, file };
      INDEX.set(item.id, entry);
      if (UPGRADE_FILES[file] || file === 'lifestyles') continue; // legacy name lookup: owned items only
      for (const n of [item.name, item.nameFr]) {
        const k = fold(n);
        if (k && !BY_NAME.has(k)) BY_NAME.set(k, entry);
      }
    }
  }
  try {
    for (const m of JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'martialarts.json'), 'utf8'))) MARTIAL.set(m.id, m);
  } catch {
    console.warn('[shop] catalog martialarts.json missing or invalid (run npm run build:catalog)');
  }
}
loadCatalogs();

/** Catalog item by id (or undefined). */
const catalogItem = (id) => INDEX.get(id)?.item;

/** Catalog entry of an owned item (by catalogId, else by name), or null. */
const catalogOf = (it) => (it?.catalogId && INDEX.get(it.catalogId)) || (it?.name ? BY_NAME.get(fold(it.name)) : null) || null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaults() {
  return {
    open: true,
    markup: 0,
    sellRate: 50,
    maxAvail: 12,
    allowRestricted: true,
    allowForbidden: false,
    approval: 'restricted',
    categories: Object.fromEntries(SHOP_FILES.map((f) => [f, true])),
    specials: [],
    orders: [],
  };
}

const int = (v, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const clampInt = (v, lo, hi, d) => Math.max(lo, Math.min(hi, int(v, d)));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const round3 = (n) => Math.round(n * 1000) / 1000;

/** ctx.fail with a rules message: French key string, or { key, params }. */
function failWith(ctx, m) {
  if (typeof m === 'string') ctx.fail(m);
  ctx.fail(m.key, m.params);
}

function ownersOf(state, actorId) {
  return Object.values(state.users || {})
    .filter((u) => (u.characterIds || []).includes(actorId))
    .map((u) => u.id);
}

function getActor(ctx, actorId) {
  const actor = ctx.state.actors?.[actorId];
  if (!actor) ctx.fail('Personnage introuvable');
  if (!ctx.owns(actorId)) ctx.fail("Ce n'est pas ton personnage");
  return actor;
}

function notifyOwners(ctx, actorId, event, data) {
  const targets = [...new Set([...ownersOf(ctx.state, actorId), 'gm'])];
  ctx.emitTo(targets, event, data);
}

/** Shop log entry (visible to the actor's owners and the GM): key = French text with {placeholders}, translated by the client. */
function shopLog(ctx, actorId, key, params) {
  ctx.log({ kind: 'shop', userId: ctx.user.id, author: 'Boutique', i18n: { key, params }, to: [...new Set([...ownersOf(ctx.state, actorId), 'gm'])] });
}

/** Actor history entry: { text (French), i18n: { key, params } } + nuyen / karma delta. */
function history(actor, key, params, delta, karma) {
  actor.history = Array.isArray(actor.history) ? actor.history : [];
  const h = { ts: Date.now(), text: formatFr(key, params), i18n: { key, params } };
  if (delta) h.nuyen = delta;
  if (karma) h.karma = karma;
  actor.history.push(h);
  if (actor.history.length > 500) actor.history.splice(0, actor.history.length - 500);
}

function pushOrder(shop, order) {
  shop.orders.push(order);
  if (shop.orders.length > MAX_ORDERS) {
    // Drop the oldest resolved orders first; never drop pending ones.
    let excess = shop.orders.length - MAX_ORDERS;
    shop.orders = shop.orders.filter((o) => {
      if (excess > 0 && o.status !== 'pending') {
        excess--;
        return false;
      }
      return true;
    });
  }
}

/** One order line as a translatable value: « Name (ind. 3) [Alphaware] ×2 → Target ». */
function lineText(l) {
  let v = l.name;
  if (l.rating) v = { t: tk('{name} (ind. {rating})'), params: { name: v, rating: l.rating } };
  if (l.grade && l.grade !== 'standard') v = { t: '{name} [{grade}]', params: { name: v, grade: GRADES[l.grade] ? { t: GRADES[l.grade].label } : l.grade } };
  if (l.qty > 1) v = { t: '{name} ×{n}', params: { name: v, n: l.qty } };
  if (l.target?.name) v = { t: tk('{name} → {target}'), params: { name: v, target: l.target.name } };
  return v;
}
/** Order lines as a translatable list param (rendered « a, b, c »). */
const summary = (items) => items.map(lineText);
/** Notes ({ key, params }) as a translatable list param. */
const notesParam = (notes) => notes.map((n) => ({ t: n.key, ...(n.params ? { params: n.params } : {}) }));

// ---------------------------------------------------------------------------
// Upgrade targets (weapon / armor / vehicle / lifestyle owned by the actor)
// ---------------------------------------------------------------------------
/** Full catalog value of an owned item (for « Weapon Cost » / « Armor Cost » / « Vehicle Cost » formulas), or null. */
function baseValue(it) {
  if (Number.isFinite(Number(it?.paid)) && it.paid !== null && it.paid !== '') return Number(it.paid);
  const e = catalogOf(it);
  if (!e) return null;
  try {
    return quote(e.item, { rating: it.rating }).unitCost;
  } catch {
    return null;
  }
}

/**
 * Target of an upgrade line. `sim` = Map of simulated targets (deep clones) so several lines of one order are checked together.
 * → { list, sub, target (clone), real (actor's item), cat (catalog item of the target or null) }
 */
function upgradeTarget(ctx, actor, file, raw, sim) {
  const { list, sub } = UPGRADE_FILES[file];
  const id = str(raw?.target?.itemId ?? raw?.targetId, 80);
  if (!id) ctx.fail('Choisis sur quoi installer cet article');
  const real = (Array.isArray(actor[list]) ? actor[list] : []).find((x) => x && x.id === id);
  if (!real) ctx.fail('Objet cible introuvable');
  const key = `${list}:${id}`;
  if (!sim.has(key)) sim.set(key, deepClone(real));
  const target = sim.get(key);
  if (!Array.isArray(target[sub])) target[sub] = [];
  return { list, sub, target, real, cat: list === 'lifestyles' ? null : catalogOf(real)?.item || null };
}

/** Price + fit of an upgrade line on its (simulated) target; pushes the planned sub-item on the simulated target. */
function priceUpgrade(ctx, actor, file, item, raw, sim) {
  const shop = ctx.state.shop;
  const t = upgradeTarget(ctx, actor, file, raw, sim);
  const out = { target: { list: t.list, itemId: t.real.id, name: t.real.name } };
  if (file === 'lifestylequalities') {
    const problem = qualityProblem(t.target, item, catalogItem);
    if (problem) failWith(ctx, problem);
    const q = quote(item, { markup: 0 });
    const before = monthlyCost(t.target);
    t.target.qualities.push(qualityFromCatalog(item, { cost: q.base }));
    const delta = monthlyCost(t.target) - before;
    // Upgrades are monthly; already-paid months are topped up with the difference (nothing back when it lowers the rent).
    const months = Math.max(0, int(t.real.monthsPaid));
    return { ...out, q, unitCost: Math.max(0, delta) * months, monthlyDelta: delta, monthlyCost: q.base, ...(lowersRent(item) ? { lowersRent: true } : {}) };
  }
  // « +2R » items (availRelative): availability added to the target's (SR5 p.433 Smartgun System, Internal).
  const targetQ = t.cat ? (() => {
    try {
      return quote(t.cat, { rating: t.real.rating });
    } catch {
      return null;
    }
  })() : null;
  const priced = (o) => upgradeAvail(quote(item, o), item, targetQ);
  if (file === 'accessories') {
    const value = baseValue(t.real);
    if (item.stats?.targetCost && value === null) ctx.fail('Prix de {weapon} inconnu : impossible de chiffrer {item}', { weapon: t.real.name, item: itemName(item) });
    const q = priced({ rating: raw.rating, markup: shop.markup, vars: { WeaponCost: value ?? 0 } });
    const fit = accessoryFit(t.target, t.cat, item, { mount: raw.mount === undefined ? undefined : str(raw.mount, 20) });
    if (fit.problem) failWith(ctx, fit.problem);
    t.target.accessories.push({ catalogId: item.id, mount: fit.mount });
    return { ...out, q, unitCost: q.unitCost, mount: fit.mount };
  }
  if (file === 'armormods') {
    const value = baseValue(t.real);
    if (item.stats?.targetCost && value === null && /ArmorCost/.test(item.costFormula || '')) ctx.fail('Prix de {weapon} inconnu : impossible de chiffrer {item}', { weapon: t.real.name, item: itemName(item) });
    const cap = armorCapacity(t.target, t.cat);
    const q = priced({ rating: raw.rating, markup: shop.markup, vars: { ArmorCost: value ?? 0, Capacity: cap } });
    const fit = armorModFit(t.target, t.cat, item, q.rating);
    if (fit.problem) failWith(ctx, fit.problem);
    t.target.mods.push({ catalogId: item.id, capacity: fit.need });
    return { ...out, q, unitCost: q.unitCost, capacity: fit.need };
  }
  // vehiclemods
  const value = baseValue(t.real);
  const vars = vehicleVars(t.target, t.cat, value ?? 0);
  if (/VehicleCost/.test(item.costFormula || '') && value === null) ctx.fail('Prix de {weapon} inconnu : impossible de chiffrer {item}', { weapon: t.real.name, item: itemName(item) });
  const max = vehicleModMaxRating(item, vars);
  const wanted = raw.rating === undefined || raw.rating === null ? item.rating?.min : Math.min(int(raw.rating, 1), max ?? int(raw.rating, 1));
  const q = priced({ rating: wanted, markup: shop.markup, vars });
  const fit = vehicleModFit(t.target, t.cat, item, q.rating, vars);
  if (fit.problem) failWith(ctx, fit.problem);
  t.target.mods.push({ catalogId: item.id, slots: fit.need, category: item.category || '' });
  return { ...out, q, unitCost: q.unitCost, slots: fit.need, effects: vehicleModEffects(item, q.rating, vars) };
}

// ---------------------------------------------------------------------------
// Purchase lines
// ---------------------------------------------------------------------------
/** Normalize one cart line into a priced, validated line. sim = simulated upgrade targets of the order. */
function resolveLine(ctx, raw, actor, sim = new Map()) {
  const shop = ctx.state.shop;
  const actorId = actor.id;
  const ref = str(raw?.ref, 120);
  if (!ref) ctx.fail('Article manquant');
  const qty = int(raw?.qty, 1);
  if (qty < 1) ctx.fail('Quantité invalide');
  if (qty > 999) ctx.fail('Quantité trop élevée');

  if (ref.startsWith('special:')) {
    const sp = shop.specials.find((s) => s.id === ref.slice(8));
    if (!sp || (!ctx.isGM && sp.hidden)) ctx.fail('Cette offre n’existe plus');
    if (!ctx.isGM && sp.forActorIds?.length && !sp.forActorIds.includes(actorId)) ctx.fail('Cette offre est réservée à un autre runner');
    const cat = sp.catalogRef ? INDEX.get(sp.catalogRef) : null;
    const file = SHOP_FILES.includes(sp.file) && !UPGRADE_FILES[sp.file] ? sp.file : cat?.file && !UPGRADE_FILES[cat.file] ? cat.file : 'gear';
    const av = parseAvailString(sp.avail);
    const ware = file === 'cyberware' || file === 'bioware';
    let essence;
    if (ware) {
      if (Number.isFinite(Number(sp.essence)) && sp.essence !== null && sp.essence !== '') essence = round3(Number(sp.essence));
      else if (cat) essence = quote(cat.item, { rating: sp.rating, grade: sp.grade }).essence ?? 0;
      else essence = 0;
    }
    return {
      ref, specialId: sp.id, catalogId: cat?.item.id, file, name: sp.name, category: sp.category || cat?.item.categoryFr || cat?.item.category || '',
      qty, rating: sp.rating ?? null, grade: ware ? sp.grade || 'standard' : null, unitCost: Math.max(0, int(sp.cost)), availValue: av.value,
      legality: av.legality, essence, stats: sp.stats || cat?.item.stats || undefined,
    };
  }

  const entry = INDEX.get(ref);
  if (!entry) ctx.fail('Article inconnu du catalogue');
  const { item, file } = entry;
  if (UPGRADE_FILES[file]) {
    const p = priceUpgrade(ctx, actor, file, item, raw || {}, sim);
    const line = {
      ref, catalogId: item.id, file, name: itemName(item), category: item.categoryFr || item.category, qty: 1, rating: p.q.rating,
      unitCost: p.unitCost, availValue: p.q.availValue, legality: p.q.legality, target: p.target,
    };
    for (const k of ['mount', 'capacity', 'slots', 'effects', 'monthlyDelta', 'monthlyCost', 'lowersRent']) if (p[k] !== undefined) line[k] = p[k];
    if (file !== 'lifestylequalities') line.price = p.q.unitCost; // value of the installed part (resale)
    return line;
  }
  const ware = file === 'cyberware' || file === 'bioware';
  if (ware && raw.grade && !allowedGrades(item).includes(raw.grade)) ctx.fail('Grade « {grade} » indisponible pour {item}', { grade: GRADES[raw.grade] ? { t: GRADES[raw.grade].label } : raw.grade, item: itemName(item) });
  const q = quote(item, { rating: raw.rating, grade: raw.grade, markup: file === 'lifestyles' ? 0 : shop.markup, price: raw.price });
  const line = {
    ref, catalogId: item.id, file, name: itemName(item), category: item.categoryFr || item.category, qty: file === 'lifestyles' ? Math.min(qty, 24) : qty,
    rating: q.rating, grade: ware ? q.grade || 'standard' : null,
    unitCost: q.unitCost, availValue: q.availValue, legality: q.legality, essence: ware ? q.essence ?? 0 : undefined,
    variablePrice: item.costRange ? true : undefined,
  };
  if (file === 'lifestyles') {
    const nm = str(raw.lifestyleName ?? raw.label, 120);
    if (nm) line.lifestyleName = nm;
    if (raw.primary) line.primary = true;
  }
  return line;
}

/** Resolve all lines of a cart (upgrade lines are checked together against the same simulated targets). */
function resolveLines(ctx, actor, raws) {
  const sim = new Map();
  return raws.map((raw) => {
    const l = resolveLine(ctx, raw || {}, actor, sim);
    if (raw?.setMatrix) l.setMatrix = true;
    return l;
  });
}

function lineFlags(shop, l) {
  const f = [];
  if (l.legality === 'R') f.push('restricted');
  if (l.legality === 'F') f.push('forbidden');
  if (l.availValue > shop.maxAvail) f.push('avail');
  if (l.variablePrice) f.push('price');
  if (l.lowersRent) f.push('rent');
  return f;
}

/** Player-side shop rules (the GM bypasses them). */
function checkRules(ctx, lines) {
  const shop = ctx.state.shop;
  if (!shop.open) ctx.fail('Cabana n’est pas joignable pour l’instant');
  for (const l of lines) {
    if (l.specialId) continue; // fixer deals are GM-curated
    if (shop.categories[l.file] === false) ctx.fail('{section} : rayon fermé pour l’instant', { section: FILE_LABELS[l.file] ? { t: FILE_LABELS[l.file] } : l.file });
    if (l.availValue > shop.maxAvail) ctx.fail('{item} : disponibilité {avail} au-dessus de la limite ({max}) — vois avec le MJ', { item: l.name, avail: l.availValue, max: shop.maxAvail });
    if (l.legality === 'F' && !shop.allowForbidden) ctx.fail('{item} est interdit : Cabana ne prend pas ce risque', { item: l.name });
    if (l.legality === 'R' && !shop.allowRestricted) ctx.fail('{item} est restreint : pas de vente sans licence pour l’instant', { item: l.name });
  }
}

function checkStock(ctx, lines) {
  const need = {};
  for (const l of lines) if (l.specialId) need[l.specialId] = (need[l.specialId] || 0) + l.qty;
  for (const [id, n] of Object.entries(need)) {
    const sp = ctx.state.shop.specials.find((s) => s.id === id);
    if (!sp) ctx.fail('Une offre de la commande n’existe plus');
    if (sp.stock !== null && sp.stock !== undefined && Number(sp.stock) < n) {
      if (sp.stock > 1) ctx.fail('{item} : stock insuffisant ({n} restants)', { item: sp.name, n: sp.stock });
      ctx.fail('{item} : stock insuffisant ({n} restant)', { item: sp.name, n: sp.stock });
    }
  }
}

const essenceCost = (lines) => round3(lines.reduce((s, l) => s + (l.essence ? l.essence * l.qty : 0), 0));

function checkEssence(ctx, actor, lines) {
  const cost = essenceCost(lines);
  if (cost <= 0) return;
  const ess = Number(actor.attributes?.ESS ?? 6);
  if (ess - cost <= 0) ctx.fail('Essence insuffisante : {ess} − {cost} tuerait {name}', { ess, cost, name: actor.name });
}

function checkFunds(ctx, actor, total) {
  const have = Number(actor.nuyen) || 0;
  if (have < total) ctx.fail('Fonds insuffisants : {cost} requis, {have} disponibles', { cost: nuyen(total), have: nuyen(have) });
}

// ---------------------------------------------------------------------------
// Applying purchases to the actor
// ---------------------------------------------------------------------------
// applyBonus / removeBonus / weaponFromStats live in server/lib/augment.js (shared with the sheet editor).

const evalStat = (v, rating) => {
  if (typeof v === 'number') return v;
  try {
    return Math.round(evalFormula(v, { Rating: rating ?? 1 }));
  } catch {
    return 0;
  }
};

/** Sub-item copied from an accessory catalog item (weapon.accessories[]). */
function accessoryItem(ctx, accItem, extra) {
  const a = { id: ctx.uid('acc'), catalogId: accItem.id, name: accItem.name, mount: '', cost: 0, avail: accItem.avail || '' };
  if (accItem.nameFr) a.nameFr = accItem.nameFr;
  const effects = accessoryEffects(accItem);
  if (Object.keys(effects).length) a.effects = effects;
  if (Array.isArray(accItem.stats?.extraMount) && accItem.stats.extraMount.length) a.extraMount = [...accItem.stats.extraMount];
  return Object.assign(a, extra);
}

/** Install an upgrade line on its (real) target. Re-checks the fit (a pending order may be approved later). */
function installUpgrade(ctx, actor, line, { paid }) {
  const entry = INDEX.get(line.catalogId);
  if (!entry || !UPGRADE_FILES[entry.file]) ctx.fail('Article inconnu du catalogue');
  const { item, file } = entry;
  const { list, sub } = UPGRADE_FILES[file];
  const target = (Array.isArray(actor[list]) ? actor[list] : []).find((x) => x && x.id === line.target?.itemId);
  if (!target) ctx.fail('Objet cible introuvable');
  if (!Array.isArray(target[sub])) target[sub] = [];
  const cat = list === 'lifestyles' ? null : catalogOf(target)?.item || null;
  const extra = { ...(paid !== undefined ? { paid } : {}) };
  if (file === 'lifestylequalities') {
    const problem = qualityProblem(target, item, catalogItem);
    if (problem) failWith(ctx, problem);
    target.qualities.push(qualityFromCatalog(item, { id: ctx.uid('lsq'), cost: line.monthlyCost ?? quote(item, { markup: 0 }).base }));
    settleLifestyles(actor);
  } else if (file === 'accessories') {
    if (!Array.isArray(target.mounts) && Array.isArray(cat?.stats?.mounts)) target.mounts = [...cat.stats.mounts];
    const fit = accessoryFit(target, cat, item, { mount: line.mount });
    if (fit.problem) failWith(ctx, fit.problem);
    target.accessories.push(accessoryItem(ctx, item, { mount: fit.mount, cost: line.price ?? line.unitCost, ...(line.rating ? { rating: line.rating } : {}), ...extra }));
  } else if (file === 'armormods') {
    if ((target.capacity === undefined || target.capacity === null) && cat?.stats?.capacity !== undefined) target.capacity = Number(cat.stats.capacity) || 0;
    const fit = armorModFit(target, cat, item, line.rating);
    if (fit.problem) failWith(ctx, fit.problem);
    const m = { id: ctx.uid('mod'), catalogId: item.id, name: item.name, capacity: fit.need, cost: line.price ?? line.unitCost, avail: item.avail || '', ...extra };
    if (item.nameFr) m.nameFr = item.nameFr;
    if (line.rating) m.rating = line.rating;
    if (item.stats?.armor) m.effects = { armor: Number(item.stats.armor) || 0 };
    if (item.stats?.bonus && Object.keys(item.stats.bonus).length) {
      m.bonus = {};
      for (const [k, v] of Object.entries(item.stats.bonus)) m.bonus[k] = typeof v === 'string' ? evalStat(v, line.rating) : v;
    }
    target.mods.push(m);
  } else {
    const vars = vehicleVars(target, cat, baseValue(target) ?? 0);
    const fit = vehicleModFit(target, cat, item, line.rating, vars);
    if (fit.problem) failWith(ctx, fit.problem);
    const m = { id: ctx.uid('mod'), catalogId: item.id, name: item.name, slots: fit.need, category: item.category || '', cost: line.price ?? line.unitCost, avail: item.avail || '', ...extra };
    if (item.nameFr) m.nameFr = item.nameFr;
    if (line.rating) m.rating = line.rating;
    const effects = vehicleModEffects(item, line.rating, vars);
    if (Object.keys(effects).length) m.effects = effects;
    target.mods.push(m);
  }
  return [];
}

/** Add one priced line to the actor. paid = unit price actually paid (undefined for GM gifts). Returns notes [{ key, params }]. */
function addLine(ctx, actor, line, { paid }) {
  const entry = line.catalogId ? INDEX.get(line.catalogId) : null;
  const item = entry?.item || { stats: line.stats || {} };
  const st = line.stats || item.stats || {};
  const list = targetList(line.file, { stats: st });
  const notes = [];
  const base = { catalogId: line.catalogId || undefined };
  if (paid !== undefined) base.paid = paid;

  if (list === 'upgrade') return installUpgrade(ctx, actor, line, { paid: paid !== undefined ? line.price ?? paid : undefined });
  if (list === 'lifestyles') {
    actor.lifestyles = Array.isArray(actor.lifestyles) ? actor.lifestyles : [];
    const primary = !actor.lifestyles.length || !!line.primary;
    const l = lifestyleFromCatalog(entry?.item || { name: line.name, cost: line.unitCost }, { id: ctx.uid('ls'), name: line.lifestyleName || line.name, months: line.qty, primary });
    if (primary) for (const o of actor.lifestyles) o.primary = false;
    actor.lifestyles.push(l);
    settleLifestyles(actor);
    return notes;
  }
  for (const key of ['weapons', 'armor', 'augmentations', 'gear', 'vehicles']) if (!Array.isArray(actor[key])) actor[key] = [];

  if (list === 'weapons') {
    for (let i = 0; i < line.qty; i++) {
      const w = weaponFromStats(ctx, line.name, line.category, st, base);
      if (Array.isArray(st.mounts)) w.mounts = [...st.mounts];
      // Accessories delivered with the weapon (Chummer <accessories>): installed, included in the price.
      const included = (st.included || []).map((inc) => {
        const acc = inc.id ? INDEX.get(inc.id)?.item : null;
        return acc ? accessoryItem(ctx, acc, { mount: 'Internal', included: true }) : { id: ctx.uid('acc'), name: inc.name, mount: 'Internal', included: true, cost: 0 };
      });
      if (included.length) w.accessories = included;
      actor.weapons.push(w);
    }
  } else if (list === 'armor') {
    for (let i = 0; i < line.qty; i++) {
      const a = { id: ctx.uid('arm'), name: line.name, rating: evalStat(st.armor ?? 0, line.rating), equipped: false, stack: !!st.stack || undefined, ...base };
      if (st.capacity !== undefined) a.capacity = Number(st.capacity) || 0;
      actor.armor.push(a);
    }
  } else if (list === 'augmentations') {
    for (let i = 0; i < line.qty; i++) {
      const aug = {
        id: ctx.uid('aug'),
        name: line.name,
        kind: st.kind || (line.file === 'bioware' ? 'bioware' : 'cyberware'),
        grade: line.grade || 'standard',
        essence: line.essence || 0,
        ...base,
      };
      if (line.rating) aug.rating = line.rating;
      // Essence loss (and Magic/Resonance loss for awakened/emerged characters).
      if (aug.essence > 0) {
        actor.attributes = actor.attributes || {};
        const before = Number(actor.attributes.ESS ?? 6);
        const after = round3(before - aug.essence);
        actor.attributes.ESS = after;
        const loss = magicLoss(before, after);
        for (const k of ['MAG', 'RES']) {
          if (loss && Number(actor.attributes[k]) > 0) {
            actor.attributes[k] = Math.max(0, Number(actor.attributes[k]) - loss);
            if (k === 'MAG') notes.push({ key: tk('Magie −{n}'), params: { n: loss } });
            else notes.push({ key: tk('Résonance −{n}'), params: { n: loss } });
          }
        }
      }
      // Attribute / initiative dice / initiative score bonus (catalog effects, else stats.bonus), recorded on aug.bonus.
      bakeItemBonus(actor, 'augmentations', aug, st.bonus);
      if (st.weapon) actor.weapons.push(weaponFromStats(ctx, line.name, line.category, st.weapon, { augId: aug.id, catalogId: line.catalogId || undefined }));
      actor.augmentations.push(aug);
    }
  } else if (list === 'vehicles') {
    for (let i = 0; i < line.qty; i++) {
      actor.vehicles.push({
        id: ctx.uid('veh'), name: line.name, handling: st.handling ?? 0, speed: st.speed ?? 0, accel: st.accel ?? 0, body: st.body ?? 0,
        armor: st.armor ?? 0, pilot: st.pilot ?? 0, sensor: st.sensor ?? 0, seats: st.seats ?? undefined, notes: line.category || undefined, ...base,
      });
    }
  } else {
    // Gear (stackable). Ammunition and similar are sold per pack of `costFor` units.
    const per = Number(st.costFor) || 1;
    const units = line.qty * per;
    const unitPaid = paid !== undefined ? Math.round((paid / per) * 100) / 100 : undefined;
    const isDevice = DEVICE_GEAR.has(item.category) || line.setMatrix;
    const same = !isDevice && actor.gear.find((g) => (line.catalogId ? g.catalogId === line.catalogId : !g.catalogId && g.name === line.name) && (g.rating ?? null) === (line.rating ?? null));
    let gearItem;
    if (same) {
      const oldQty = Number(same.qty) || 0;
      if (unitPaid !== undefined && same.paid !== undefined) same.paid = Math.round(((same.paid * oldQty + unitPaid * units) / (oldQty + units)) * 100) / 100;
      else if (unitPaid !== undefined && !oldQty) same.paid = unitPaid;
      same.qty = oldQty + units;
      gearItem = same;
    } else {
      gearItem = { id: ctx.uid('gear'), name: line.name, category: line.category || '', qty: units, ...base };
      if (unitPaid !== undefined) gearItem.paid = unitPaid;
      if (line.rating) gearItem.rating = line.rating;
      actor.gear.push(gearItem);
    }
    if (line.file === 'programs' && actor.matrix) {
      actor.matrix.programs = Array.isArray(actor.matrix.programs) ? actor.matrix.programs : [];
      if (!actor.matrix.programs.includes(line.name)) actor.matrix.programs.push(line.name);
    }
    if (line.setMatrix && (st.deviceRating !== undefined || st.attributeArray || st.dataProcessing !== undefined)) {
      const arr = Array.isArray(st.attributeArray) ? st.attributeArray : null;
      actor.matrix = {
        device: line.name,
        rating: evalStat(st.deviceRating ?? 0, line.rating),
        attack: arr ? arr[0] : st.attack ?? 0,
        sleaze: arr ? arr[1] : st.sleaze ?? 0,
        dataProcessing: arr ? arr[2] : st.dataProcessing ?? evalStat(st.deviceRating ?? 0, line.rating),
        firewall: arr ? arr[3] : st.firewall ?? evalStat(st.deviceRating ?? 0, line.rating),
        programs: Array.isArray(actor.matrix?.programs) ? actor.matrix.programs : [],
        gearId: gearItem.id,
      };
      notes.push({ key: tk('{item} devient l’appareil Matriciel'), params: { item: line.name } });
    }
  }
  return notes;
}

/** Apply a buy/give order to its actor (nuyen, items, stock). Returns notes [{ key, params }]. */
function applyOrder(ctx, actor, order, { free = false } = {}) {
  const notes = [];
  for (const line of order.items) {
    notes.push(...addLine(ctx, actor, line, { paid: free ? undefined : line.unitCost }));
    if (line.specialId) {
      const sp = ctx.state.shop.specials.find((s) => s.id === line.specialId);
      if (sp && sp.stock !== null && sp.stock !== undefined) sp.stock = Math.max(0, Number(sp.stock) - line.qty);
    }
  }
  fillActorRefs(actor); // 📖 source / page of the new items (catalog)
  if (!free) actor.nuyen = (Number(actor.nuyen) || 0) - order.total;
  const items = summary(order.items);
  const np = notesParam(notes);
  if (free) {
    if (notes.length) history(actor, tk('Reçu du MJ : {items} ({notes})'), { items, notes: np }, 0);
    else history(actor, tk('Reçu du MJ : {items}'), { items }, 0);
    shopLog(ctx, actor.id, tk('{actor} reçoit : {items}'), { actor: actor.name, items });
  } else {
    const cost = nuyen(order.total);
    if (notes.length) {
      history(actor, tk('Achat : {items} ({notes})'), { items, notes: np }, -order.total);
      shopLog(ctx, actor.id, tk('{actor} achète : {items} — {cost} · {notes}'), { actor: actor.name, items, cost, notes: np });
    } else {
      history(actor, tk('Achat : {items}'), { items }, -order.total);
      shopLog(ctx, actor.id, tk('{actor} achète : {items} — {cost}'), { actor: actor.name, items, cost });
    }
  }
  notifyOwners(ctx, actor.id, 'sfx', { id: 'cash' });
  return notes;
}

// ---------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------
/** Value (100%) of an installed accessory / mod: price paid, else its recorded catalog price. Included parts: 0. */
function subValue(s) {
  if (!s || s.included) return 0;
  if (Number.isFinite(Number(s.paid)) && s.paid !== null && s.paid !== '') return Number(s.paid);
  return Math.max(0, Number(s.cost) || 0);
}

/** Full (100%) unit value of an owned item (installed accessories/mods included), or null if unknown. */
function itemValue(list, it) {
  const subs = SUB_OF[list] && list !== 'lifestyles' && Array.isArray(it[SUB_OF[list]]) ? it[SUB_OF[list]].reduce((s, x) => s + subValue(x), 0) : 0;
  if (Number.isFinite(Number(it.paid)) && it.paid !== null && it.paid !== '') return Number(it.paid) + subs;
  const entry = catalogOf(it);
  if (!entry) return subs ? subs : null;
  try {
    const q = quote(entry.item, { rating: it.rating, grade: it.grade });
    const per = list === 'gear' ? Number(entry.item.stats?.costFor) || 1 : 1;
    return Math.round((q.unitCost / per) * 100) / 100 + subs;
  } catch {
    return null;
  }
}

function findOwned(ctx, actor, list, itemId) {
  if (!LISTS.includes(list)) ctx.fail('Liste invalide');
  const arr = Array.isArray(actor[list]) ? actor[list] : [];
  const it = arr.find((x) => x.id === itemId);
  if (!it) ctx.fail('Objet introuvable dans l’inventaire');
  return it;
}

/** Installed accessory / mod of an owned item. */
function findSub(ctx, it, list, subId) {
  const sub = SUB_OF[list];
  if (!sub || list === 'lifestyles') ctx.fail('Liste invalide');
  const s = (Array.isArray(it[sub]) ? it[sub] : []).find((x) => x && x.id === subId);
  if (!s) ctx.fail('Option introuvable');
  return s;
}

function applySell(ctx, actor, order) {
  const line = order.items[0];
  const it = findOwned(ctx, actor, line.list, line.itemId);
  const list = line.list;
  if (line.subId) {
    const s = findSub(ctx, it, list, line.subId);
    if (s.included) ctx.fail('Pièce d’origine de {item} : elle part avec lui', { item: it.name });
    it[SUB_OF[list]] = it[SUB_OF[list]].filter((x) => x.id !== s.id);
  } else {
    if (list === 'weapons' && it.augId) ctx.fail('Arme intégrée à un implant : revends l’implant lui-même');
    if (list === 'gear') {
      const have = Math.max(0, Number(it.qty ?? 1) || 0);
      if (have < 1) ctx.fail('Plus aucun exemplaire de {item} à revendre', { item: it.name });
      if (line.qty > have) ctx.fail('Il ne reste que {n} {item}', { n: have, item: it.name });
      if (line.qty < have) it.qty = have - line.qty;
      else actor.gear = actor.gear.filter((g) => g.id !== it.id);
    } else {
      actor[list] = actor[list].filter((x) => x.id !== it.id);
    }
    if (list === 'augmentations') {
      removeBonus(actor, it.bonus);
      if (Array.isArray(actor.weapons)) actor.weapons = actor.weapons.filter((w) => w.augId !== it.id);
    }
    if (list === 'gear' && actor.matrix?.gearId === it.id && !actor.gear.some((g) => g.id === it.id)) {
      actor.matrix = { ...actor.matrix, device: '', rating: 0, attack: 0, sleaze: 0, dataProcessing: 0, firewall: 0 };
      delete actor.matrix.gearId;
    }
  }
  actor.nuyen = (Number(actor.nuyen) || 0) + order.total;
  const item = line.subId ? lineText({ name: line.name, target: { name: it.name } }) : lineText({ name: line.name, qty: line.qty });
  history(actor, tk('Revente : {item}'), { item }, order.total);
  shopLog(ctx, actor.id, tk('{actor} revend {item} — {cost}'), { actor: actor.name, item, cost: nuyen(order.total) });
  notifyOwners(ctx, actor.id, 'sfx', { id: 'cash' });
}

// ---------------------------------------------------------------------------
// Martial arts (karma; Run & Gun p.128 — a style includes its first technique)
// ---------------------------------------------------------------------------
/** Validate a martial art request → { style, existing, techniques (new catalog techniques), karma }. */
function martialPlan(ctx, actor, styleId, techniqueIds) {
  const style = MARTIAL.get(str(styleId, 80));
  if (!style) ctx.fail('Art martial inconnu');
  const known = (Array.isArray(actor.martialArts) ? actor.martialArts : []).find((m) => m.catalogId === style.id);
  const ids = [...new Set((Array.isArray(techniqueIds) ? techniqueIds : []).map((x) => str(x, 80)).filter(Boolean))].slice(0, 20);
  const techs = ids.map((id) => {
    const t = (style.stats?.techniques || []).find((x) => x.id === id);
    if (!t) ctx.fail('Technique inconnue pour {style}', { style: itemName(style) });
    return t;
  });
  const fresh = techs.filter((t) => !(known?.techniques || []).some((k) => k.catalogId === t.id));
  if (known && !fresh.length) ctx.fail('Rien de nouveau à apprendre');
  const karma = martialKarma(style, known || null, fresh.length);
  return { style, known, techniques: fresh, karma };
}

/** Grant a martial art plan to an actor (karma deducted unless free). */
function applyMartial(ctx, actor, plan, { free }) {
  if (!free && (Number(actor.karma) || 0) < plan.karma) ctx.fail('Karma insuffisant : {cost} requis, {have} disponible(s)', { cost: plan.karma, have: Number(actor.karma) || 0 });
  actor.martialArts = Array.isArray(actor.martialArts) ? actor.martialArts : [];
  let m = actor.martialArts.find((x) => x.catalogId === plan.style.id);
  if (!m) {
    m = { id: ctx.uid('ma'), catalogId: plan.style.id, name: itemName(plan.style), rating: 1, techniques: [] };
    actor.martialArts.push(m);
  }
  if (!Array.isArray(m.techniques)) m.techniques = [];
  for (const t of plan.techniques) {
    const tech = { id: ctx.uid('tec'), catalogId: t.id, name: t.name };
    if (t.nameFr) tech.nameFr = t.nameFr;
    m.techniques.push(tech);
  }
  fillActorRefs(actor);
  const names = plan.techniques.map((t) => t.nameFr || t.name).join(', ');
  const params = { style: m.name, techniques: names || '—', karma: free ? 0 : plan.karma };
  if (!free) actor.karma = (Number(actor.karma) || 0) - plan.karma;
  history(actor, tk('Art martial : {style} ({techniques})'), params, 0, free ? 0 : -plan.karma);
  shopLog(ctx, actor.id, tk('{actor} apprend {style} ({techniques}) — {karma} karma'), { actor: actor.name, ...params });
  notifyOwners(ctx, actor.id, 'sfx', { id: 'level-up' });
  return m;
}

// ---------------------------------------------------------------------------
// Specials (fixer deals)
// ---------------------------------------------------------------------------
function sanitizeSpecial(ctx, src, prev = {}) {
  const out = { ...prev };
  const fileOk = (f) => SHOP_FILES.includes(f) && !UPGRADE_FILES[f];
  if (src.name !== undefined) out.name = str(src.name, 120) || prev.name || 'Offre sans nom';
  if (src.category !== undefined) out.category = str(src.category, 60);
  if (src.file !== undefined) out.file = fileOk(src.file) ? src.file : 'gear';
  if (src.cost !== undefined) out.cost = Math.max(0, int(src.cost));
  if (src.avail !== undefined) {
    const a = parseAvailString(src.avail);
    out.avail = `${a.value}${a.legality}`;
  }
  if (src.stock !== undefined) out.stock = src.stock === null || src.stock === '' ? null : Math.max(0, int(src.stock));
  if (src.notes !== undefined) out.notes = str(src.notes, 2000);
  if (src.gmNotes !== undefined) out.gmNotes = str(src.gmNotes, 2000);
  if (src.hidden !== undefined) out.hidden = !!src.hidden;
  if (src.forActorIds !== undefined) out.forActorIds = Array.isArray(src.forActorIds) ? src.forActorIds.filter((id) => typeof id === 'string').slice(0, 20) : [];
  if (src.rating !== undefined) out.rating = src.rating === null || src.rating === '' ? null : Math.max(0, int(src.rating));
  if (src.grade !== undefined) out.grade = GRADES[src.grade] ? src.grade : 'standard';
  if (src.essence !== undefined) out.essence = src.essence === null || src.essence === '' ? null : Math.max(0, round3(Number(src.essence) || 0));
  if (src.catalogRef !== undefined) out.catalogRef = src.catalogRef && INDEX.has(src.catalogRef) && !UPGRADE_FILES[INDEX.get(src.catalogRef).file] ? src.catalogRef : null;
  if (src.stats !== undefined && src.stats && typeof src.stats === 'object') out.stats = JSON.parse(JSON.stringify(src.stats));
  if (src.originalCost !== undefined) out.originalCost = src.originalCost === null ? null : Math.max(0, int(src.originalCost));
  if (!out.file) out.file = out.catalogRef ? INDEX.get(out.catalogRef)?.file || 'gear' : 'gear';
  if (out.stock === undefined) out.stock = null;
  if (!out.avail) out.avail = '0';
  if (out.cost === undefined) out.cost = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Historic upgrades restore (data/seed/upgrades-restore.json): lifestyle qualities, weapon accessories and armor
// mods the characters had in Chummer, lost on the way Chummer → Foundry → app. Applied once per actor.
// ---------------------------------------------------------------------------
function matchItem(list, spec) {
  if (!Array.isArray(list)) return null;
  if (spec.catalogId) {
    const byId = list.find((x) => x && x.catalogId === spec.catalogId);
    if (byId) return byId;
  }
  const m = fold(spec.match || '');
  return m ? list.find((x) => x && fold(x.name).includes(m)) || null : null;
}

/** Apply the restore spec of one actor. Returns the number of upgrades added. */
export function restoreUpgrades(actor, spec, makeId) {
  let added = 0;
  const NOTE = String(spec.note || 'Chummer').slice(0, 500);
  if (spec.lifestyleNote && Array.isArray(actor.lifestyles)) {
    // Historic lifestyle kept as a note only (e.g. a retired PC whose current lifestyle differs from the Chummer one).
    const l = primaryLifestyle(actor);
    const note = String(spec.lifestyleNote).slice(0, 1500);
    if (l && !String(l.notes || '').includes(note.slice(0, 60))) l.notes = (l.notes ? `${l.notes}

` : '') + note;
  }
  if (spec.lifestyle && Array.isArray(actor.lifestyles)) {
    const l = matchItem(actor.lifestyles, spec.lifestyle);
    if (l && !(l.qualities || []).length) {
      const baseItem = [...INDEX.values()].find((e) => e.file === 'lifestyles' && e.item.name === spec.lifestyle.base)?.item;
      if (baseItem) {
        l.base = baseOf(baseItem.name);
        l.catalogId ||= baseItem.id;
        l.baseCost = Math.round(Number(baseItem.cost) || 0);
      }
      l.qualities = [];
      for (const id of spec.lifestyle.qualities || []) {
        const it = INDEX.get(id)?.item;
        if (!it) continue;
        l.qualities.push(qualityFromCatalog(it, { id: makeId('lsq'), cost: quote(it, { markup: 0 }).base, notes: NOTE }));
        added++;
      }
      settleLifestyles(actor);
    }
  }
  const ctx = { uid: makeId };
  for (const w of spec.weapons || []) {
    const weapon = matchItem(actor.weapons, w);
    if (!weapon) continue;
    const cat = catalogOf(weapon)?.item;
    if (!Array.isArray(weapon.mounts) && Array.isArray(cat?.stats?.mounts)) weapon.mounts = [...cat.stats.mounts];
    weapon.accessories = Array.isArray(weapon.accessories) ? weapon.accessories : [];
    for (const a of w.accessories || []) {
      const it = INDEX.get(a.id)?.item;
      if (!it || weapon.accessories.some((x) => x.catalogId === it.id)) continue;
      weapon.accessories.push(accessoryItem(ctx, it, { mount: a.mount ?? '', ...(a.included ? { included: true } : { cost: Number(it.cost) || 0 }), notes: NOTE }));
      added++;
    }
  }
  for (const s of spec.armor || []) {
    const armor = matchItem(actor.armor, s);
    if (!armor) continue;
    const cat = catalogOf(armor)?.item;
    if ((armor.capacity === undefined || armor.capacity === null) && cat?.stats?.capacity !== undefined) armor.capacity = Number(cat.stats.capacity) || 0;
    armor.mods = Array.isArray(armor.mods) ? armor.mods : [];
    for (const m of s.mods || []) {
      const it = INDEX.get(m.id)?.item;
      if (!it || armor.mods.some((x) => x.catalogId === it.id)) continue;
      const cap = armorCapacity(armor, cat);
      const q = quote(it, { rating: m.rating, vars: { ArmorCost: Number(cat?.cost) || 0, Capacity: cap } });
      const mod = { id: makeId('mod'), catalogId: it.id, name: it.name, capacity: armorModFit({ ...armor, mods: [] }, cat, it, q.rating).need, cost: q.unitCost, avail: it.avail || '', notes: NOTE };
      if (it.nameFr) mod.nameFr = it.nameFr;
      if (q.rating) mod.rating = q.rating;
      // The stored armor rating came from Foundry and already counts the mod's armor bonus: no effects.armor here.
      if (it.stats?.armor && !s.ratingIncludesMods) mod.effects = { armor: Number(it.stats.armor) || 0 };
      armor.mods.push(mod);
      added++;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
export default {
  name: 'shop',

  init(state, { readSeed }) {
    const d = defaults();
    state.shop = state.shop && typeof state.shop === 'object' ? state.shop : {};
    const shop = state.shop;
    for (const [k, v] of Object.entries(d)) if (shop[k] === undefined) shop[k] = v;
    shop.categories = { ...d.categories, ...(shop.categories || {}) };
    if (!Array.isArray(shop.specials)) shop.specials = [];
    if (!Array.isArray(shop.orders)) shop.orders = [];
    if (!Array.isArray(shop.removedSeedIds)) shop.removedSeedIds = [];
    const seed = readSeed('shop.json', { specials: [] }) || {};
    for (const sp of seed.specials || []) {
      if (!sp?.id || shop.specials.some((s) => s.id === sp.id) || shop.removedSeedIds.includes(sp.id)) continue;
      shop.specials.push({ stock: null, ...JSON.parse(JSON.stringify(sp)) });
    }
    // Lifestyles: the characters module migrated actor.lifestyle → actor.lifestyles[] (normalizeActor); keep costs derived.
    for (const a of Object.values(state.actors || {})) {
      if (a && typeof a === 'object' && a.lifestyle && typeof a.lifestyle === 'object' && !Array.isArray(a.lifestyles)) {
        // Safety net when the characters module did not run its migration (e.g. module order changed).
        a.lifestyles = [{ id: `ls_${a.id}`, name: String(a.lifestyle.name || 'Train de vie').slice(0, 120), base: '', baseCost: Math.max(0, Number(a.lifestyle.monthlyCost) || 0), monthsPaid: Math.max(0, Math.round(Number(a.lifestyle.monthsPaid) || 0)), primary: true, qualities: [], notes: '' }];
        delete a.lifestyle;
      }
      if (a && Array.isArray(a.lifestyles)) {
        // Options stored before `baseOnly` existed (Extra Secure: % of the base cost only) get the catalog flag.
        for (const l of a.lifestyles) for (const q of Array.isArray(l?.qualities) ? l.qualities : []) if (q && q.baseOnly === undefined && q.catalogId && catalogItem(q.catalogId)?.stats?.baseOnly) q.baseOnly = true;
        settleLifestyles(a);
      }
    }
    // Historic upgrades (once per actor).
    const restore = readSeed('upgrades-restore.json', null);
    if (restore?.actors) {
      shop.restored = Array.isArray(shop.restored) ? shop.restored : [];
      let n = 0;
      for (const [id, spec] of Object.entries(restore.actors)) {
        const a = state.actors?.[id];
        if (!a || shop.restored.includes(id)) continue;
        // inferred = a guess, not a Chummer file (Anthony): never applied on boot, only by tools/restore-lifestyles.js --include-inferred.
        if (spec?.inferred) continue;
        let k = 0;
        const make = (p) => `${p}_r${id.replace(/\W/g, '').slice(-6)}${(k++).toString(36)}${Date.now().toString(36).slice(-4)}`;
        const added = restoreUpgrades(a, spec, make);
        fillActorRefs(a);
        shop.restored.push(id);
        if (added) {
          history(a, tk('Options restaurées depuis Chummer : {n}'), { n: added }, 0);
          n += added;
        }
      }
      if (n) console.log(`[shop] ${n} upgrade(s) restored from the Chummer files`);
    }
  },

  actions: {
    // Buy: { actorId, items: [{ ref: catalogId | 'special:<id>', qty, rating?, grade?, price? (variable-cost items), setMatrix?,
    //        target?: { itemId } (upgrades: weapon / armor / vehicle / lifestyle id), mount? (accessories),
    //        lifestyleName?, primary? (new lifestyle; qty = months paid) }] }
    // Player: own actor only, shop rules apply, may create a pending order. GM: immediate ("Vendre au PJ").
    'shop/buy': {
      role: 'any',
      handler(ctx, { actorId, items }) {
        const actor = getActor(ctx, actorId);
        if (!Array.isArray(items) || !items.length) ctx.fail('Panier vide');
        if (items.length > 50) ctx.fail('Panier trop chargé (50 lignes max)');
        const shop = ctx.state.shop;
        const lines = resolveLines(ctx, actor, items);
        if (!ctx.isGM) checkRules(ctx, lines);
        checkStock(ctx, lines);
        checkEssence(ctx, actor, lines);
        const total = lines.reduce((s, l) => s + l.unitCost * l.qty, 0);
        checkFunds(ctx, actor, total);
        const flags = [...new Set(lines.flatMap((l) => lineFlags(shop, l)))];
        // Lifestyle options that lower the rent (negative qualities: Thrifty, Dangerous Area…) always wait for the GM.
        const needsApproval =
          !ctx.isGM &&
          (shop.approval === 'always' || lines.some((l) => l.lowersRent) || (shop.approval === 'restricted' && lines.some((l) => !l.specialId && (l.legality || l.variablePrice))));
        const order = {
          id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: ctx.isGM ? 'MJ' : ctx.user.name, kind: 'buy',
          items: lines, total, status: needsApproval ? 'pending' : 'done', flags,
        };
        if (needsApproval) {
          pushOrder(shop, order);
          shopLog(ctx, actorId, tk('{actor} passe commande : {items} — {cost} (en attente du MJ)'), { actor: actor.name, items: summary(lines), cost: nuyen(total) });
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
          return { status: 'pending', orderId: order.id, total };
        }
        const notes = applyOrder(ctx, actor, order);
        pushOrder(shop, order);
        return { status: 'done', orderId: order.id, total, notes: notes.map((n) => formatFr(n.key, n.params)), notesI18n: notes };
      },
    },

    // GM gift (no cost, no rules): { actorId, ref, qty?, rating?, grade?, setMatrix?, target?, mount? } or { actorId, items: [...] }
    'shop/give': {
      role: 'gm',
      handler(ctx, { actorId, items, ...single }) {
        const actor = getActor(ctx, actorId);
        const raws = Array.isArray(items) && items.length ? items : [single];
        const lines = resolveLines(ctx, actor, raws);
        checkStock(ctx, lines);
        checkEssence(ctx, actor, lines);
        const order = { id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: 'MJ', kind: 'give', items: lines, total: 0, status: 'done', flags: [] };
        const notes = applyOrder(ctx, actor, order, { free: true });
        pushOrder(ctx.state.shop, order);
        return { status: 'done', orderId: order.id, notes: notes.map((n) => formatFr(n.key, n.params)), notesI18n: notes };
      },
    },

    // Sell: { actorId, list: 'weapons'|'armor'|'augmentations'|'gear'|'vehicles', itemId, subId? (installed accessory / mod),
    //         qty?, price? (GM: total override) }
    'shop/sell': {
      role: 'any',
      handler(ctx, { actorId, list, itemId, subId, qty, price }) {
        const actor = getActor(ctx, actorId);
        const shop = ctx.state.shop;
        if (!ctx.isGM && !shop.open) ctx.fail('Cabana n’est pas joignable pour l’instant');
        const it = findOwned(ctx, actor, list, itemId);
        let name = it.name;
        let value;
        let n = 1;
        if (subId) {
          const s = findSub(ctx, it, list, subId);
          if (s.included) ctx.fail('Pièce d’origine de {item} : elle part avec lui', { item: it.name });
          name = s.nameFr || s.name;
          value = subValue(s) || null;
        } else {
          if (list === 'weapons' && it.augId) ctx.fail('Arme intégrée à un implant : revends l’implant lui-même');
          const have = list === 'gear' ? Math.max(0, int(it.qty ?? 1, 0)) : 1;
          if (have < 1) ctx.fail('Plus aucun exemplaire à revendre');
          n = list === 'gear' ? clampInt(qty ?? have, 1, have, 1) : 1;
          value = itemValue(list, it);
        }
        const key = subId || itemId;
        if (ctx.state.shop.orders.some((o) => o.status === 'pending' && o.kind === 'sell' && (o.items[0]?.subId || o.items[0]?.itemId) === key)) ctx.fail('Une revente de cet objet attend déjà le MJ');
        let total = value === null ? null : Math.round(value * n * (Number(shop.sellRate) || 0) / 100);
        if (ctx.isGM && price !== undefined && price !== null && price !== '') total = Math.max(0, int(price));
        if (ctx.isGM && total === null) ctx.fail('Prix inconnu : indique un montant de revente');
        const line = { list, itemId, name, qty: n, rating: it.rating ?? null, unitCost: value === null ? null : Math.round(value * (Number(shop.sellRate) || 0) / 100) };
        if (subId) Object.assign(line, { subId, target: { list, itemId, name: it.name } });
        const order = {
          id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: ctx.isGM ? 'MJ' : ctx.user.name, kind: 'sell',
          items: [line], total, status: 'pending', flags: total === null ? ['price'] : [],
        };
        if (!ctx.isGM && (shop.approval === 'always' || total === null)) {
          pushOrder(shop, order);
          const item = lineText(line);
          if (total !== null) shopLog(ctx, actorId, tk('{actor} propose de revendre {item} — {cost} (en attente du MJ)'), { actor: actor.name, item, cost: nuyen(total) });
          else shopLog(ctx, actorId, tk('{actor} propose de revendre {item} (prix à fixer) (en attente du MJ)'), { actor: actor.name, item });
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
          return { status: 'pending', orderId: order.id, total };
        }
        order.status = 'done';
        applySell(ctx, actor, order);
        pushOrder(shop, order);
        return { status: 'done', orderId: order.id, total };
      },
    },

    // Remove an upgrade without selling it: { actorId, list: 'weapons'|'armor'|'vehicles'|'lifestyles', itemId, subId }.
    // Players: own actor; lifestyle options that lower the rent (negative qualities) and parts delivered with an item are GM-only.
    'shop/removeUpgrade': {
      role: 'any',
      handler(ctx, { actorId, list, itemId, subId }) {
        const actor = getActor(ctx, actorId);
        const sub = SUB_OF[list];
        if (!sub) ctx.fail('Liste invalide');
        const it = (Array.isArray(actor[list]) ? actor[list] : []).find((x) => x && x.id === itemId);
        if (!it) ctx.fail('Objet introuvable dans l’inventaire');
        const s = (Array.isArray(it[sub]) ? it[sub] : []).find((x) => x && x.id === subId);
        if (!s) ctx.fail('Option introuvable');
        if (!ctx.isGM) {
          if (list === 'lifestyles' && (s.category === 'Negative' || Number(s.multiplier) < 0 || Number(s.cost) < 0)) ctx.fail('Seul le MJ peut retirer cette option');
          if (s.included) ctx.fail('Seul le MJ peut retirer cette option');
        }
        it[sub] = it[sub].filter((x) => x.id !== subId);
        if (list === 'lifestyles') settleLifestyles(actor);
        const params = { actor: actor.name, item: s.nameFr || s.name, target: it.name };
        history(actor, tk('Option retirée : {item} ({target})'), params, 0);
        shopLog(ctx, actor.id, tk('{actor} retire {item} de {target}'), params);
        return { ok: true, monthlyCost: list === 'lifestyles' ? it.monthlyCost : undefined };
      },
    },

    // GM: approve or deny a pending order. { orderId, approve: bool, note?, total? (override, e.g. negotiated price) }
    'shop/resolve': {
      role: 'gm',
      handler(ctx, { orderId, approve, note, total }) {
        const shop = ctx.state.shop;
        const order = shop.orders.find((o) => o.id === orderId);
        if (!order) ctx.fail('Commande introuvable');
        if (order.status !== 'pending') ctx.fail('Cette commande a déjà été traitée');
        const actor = ctx.state.actors?.[order.actorId];
        if (note !== undefined) order.gmNote = str(note, 500) || undefined;
        if (!approve) {
          order.status = 'denied';
          order.resolvedTs = ctx.now;
          if (actor) {
            const p = { actor: actor.name, items: summary(order.items), note: order.gmNote || '' };
            if (order.kind === 'sell') {
              if (order.gmNote) shopLog(ctx, actor.id, tk('Commande refusée pour {actor} : revente de {items} — « {note} »'), p);
              else shopLog(ctx, actor.id, tk('Commande refusée pour {actor} : revente de {items}'), p);
            } else if (order.gmNote) shopLog(ctx, actor.id, tk('Commande refusée pour {actor} : {items} — « {note} »'), p);
            else shopLog(ctx, actor.id, tk('Commande refusée pour {actor} : {items}'), p);
          }
          notifyOwners(ctx, order.actorId, 'shop:resolved', { orderId, status: 'denied', note: order.gmNote || '' });
          return { status: 'denied' };
        }
        if (!actor) ctx.fail('Le personnage de cette commande n’existe plus');
        if (total !== undefined && total !== null && total !== '' && order.kind !== 'karma') order.total = Math.max(0, int(total));
        if (order.kind === 'sell') {
          if (order.total === null || order.total === undefined) ctx.fail('Indique le montant de la revente');
          applySell(ctx, actor, order);
        } else if (order.kind === 'karma') {
          const l = order.items[0];
          applyMartial(ctx, actor, martialPlan(ctx, actor, l.ref, l.techniqueIds), { free: false });
        } else {
          checkStock(ctx, order.items);
          checkEssence(ctx, actor, order.items);
          checkFunds(ctx, actor, order.total);
          applyOrder(ctx, actor, order);
        }
        order.status = 'approved';
        order.resolvedTs = ctx.now;
        notifyOwners(ctx, order.actorId, 'shop:resolved', { orderId, status: 'approved', note: order.gmNote || '' });
        return { status: 'approved' };
      },
    },

    // Owner (or GM) cancels a pending order: { orderId }
    'shop/cancel': {
      role: 'any',
      handler(ctx, { orderId }) {
        const order = ctx.state.shop.orders.find((o) => o.id === orderId);
        if (!order) ctx.fail('Commande introuvable');
        if (!ctx.isGM && order.userId !== ctx.user.id && !ctx.owns(order.actorId)) ctx.fail('Ce n’est pas ta commande');
        if (order.status !== 'pending') ctx.fail('Cette commande n’est plus en attente');
        order.status = 'cancelled';
        order.resolvedTs = ctx.now;
        return { status: 'cancelled' };
      },
    },

    // Martial arts (karma): { actorId, styleId, techniqueIds: [], free? (GM: no karma) }.
    // Player → pending order (kind 'karma', the GM approves and the karma is spent then). GM → granted at once.
    'shop/martialArt': {
      role: 'any',
      handler(ctx, { actorId, styleId, techniqueIds, free }) {
        const actor = getActor(ctx, actorId);
        const plan = martialPlan(ctx, actor, styleId, techniqueIds);
        if (ctx.isGM) {
          const m = applyMartial(ctx, actor, plan, { free: !!free });
          return { status: 'done', martialArtId: m.id, karma: free ? 0 : plan.karma };
        }
        if ((Number(actor.karma) || 0) < plan.karma) ctx.fail('Karma insuffisant : {cost} requis, {have} disponible(s)', { cost: plan.karma, have: Number(actor.karma) || 0 });
        if (ctx.state.shop.orders.some((o) => o.status === 'pending' && o.kind === 'karma' && o.actorId === actorId && o.items[0]?.ref === plan.style.id)) ctx.fail('Une demande pour cet art martial attend déjà le MJ');
        const names = plan.techniques.map((t) => t.nameFr || t.name);
        const line = { ref: plan.style.id, file: 'martialarts', name: itemName(plan.style), qty: 1, unitCost: 0, karma: plan.karma, techniqueIds: plan.techniques.map((t) => t.id), techniques: names };
        const order = { id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: ctx.user.name, kind: 'karma', items: [line], total: 0, karma: plan.karma, status: 'pending', flags: [] };
        pushOrder(ctx.state.shop, order);
        shopLog(ctx, actorId, tk('{actor} demande à apprendre {style} ({techniques}) — {karma} karma (en attente du MJ)'), { actor: actor.name, style: line.name, techniques: names.join(', ') || '—', karma: plan.karma });
        ctx.emitTo('gm', 'sfx', { id: 'notify' });
        return { status: 'pending', orderId: order.id, karma: plan.karma };
      },
    },

    // GM: { open?, markup?, sellRate?, maxAvail?, allowRestricted?, allowForbidden?, approval?, categories?: { file: bool } }
    'shop/updateSettings': {
      role: 'gm',
      handler(ctx, p) {
        const shop = ctx.state.shop;
        if (p.open !== undefined) shop.open = !!p.open;
        if (p.markup !== undefined) shop.markup = clampInt(p.markup, -90, 500, 0);
        if (p.sellRate !== undefined) shop.sellRate = clampInt(p.sellRate, 0, 100, 50);
        if (p.maxAvail !== undefined) shop.maxAvail = clampInt(p.maxAvail, 0, 40, 12);
        if (p.allowRestricted !== undefined) shop.allowRestricted = !!p.allowRestricted;
        if (p.allowForbidden !== undefined) shop.allowForbidden = !!p.allowForbidden;
        if (p.approval !== undefined) {
          if (!APPROVAL_MODES.includes(p.approval)) ctx.fail('Mode de validation inconnu');
          shop.approval = p.approval;
        }
        if (p.categories && typeof p.categories === 'object') {
          for (const [k, v] of Object.entries(p.categories)) if (SHOP_FILES.includes(k)) shop.categories[k] = !!v;
        }
        return { ok: true };
      },
    },

    // GM: { special: {...fields} } or { fromRef: catalogId, rating?, grade?, cost?, stock?, notes? }. Returns { id }.
    'shop/addSpecial': {
      role: 'gm',
      handler(ctx, { special, fromRef, ...rest }) {
        let src = special && typeof special === 'object' ? { ...special } : {};
        if (fromRef) {
          const entry = INDEX.get(fromRef);
          if (!entry) ctx.fail('Article inconnu du catalogue');
          if (UPGRADE_FILES[entry.file] || entry.file === 'lifestyles') ctx.fail('Cet article ne peut pas devenir une offre');
          const q = quote(entry.item, { rating: rest.rating, grade: rest.grade });
          src = {
            name: itemName(entry.item) + (q.rating ? ` (ind. ${q.rating})` : ''),
            category: entry.item.categoryFr || entry.item.category,
            file: entry.file,
            cost: q.unitCost,
            originalCost: q.unitCost,
            avail: q.avail,
            stock: 1,
            notes: '',
            rating: q.rating,
            grade: q.grade || undefined,
            essence: q.essence,
            catalogRef: entry.item.id,
            ...rest,
            ...src,
          };
          delete src.fromRef;
        }
        if (!src.name) src.name = 'Nouvelle offre';
        const sp = sanitizeSpecial(ctx, src, { id: ctx.uid('spc') });
        ctx.state.shop.specials.push(sp);
        return { id: sp.id };
      },
    },

    // GM: { id, patch: {...fields} }
    'shop/updateSpecial': {
      role: 'gm',
      handler(ctx, { id, patch }) {
        const shop = ctx.state.shop;
        const i = shop.specials.findIndex((s) => s.id === id);
        if (i < 0) ctx.fail('Offre introuvable');
        shop.specials[i] = sanitizeSpecial(ctx, patch || {}, shop.specials[i]);
        return { ok: true };
      },
    },

    // GM: { id }
    'shop/removeSpecial': {
      role: 'gm',
      handler(ctx, { id }) {
        const shop = ctx.state.shop;
        if (!shop.specials.some((s) => s.id === id)) ctx.fail('Offre introuvable');
        shop.specials = shop.specials.filter((s) => s.id !== id);
        if (!shop.removedSeedIds.includes(id)) shop.removedSeedIds.push(id);
        return { ok: true };
      },
    },

    // Pay rent in advance: { actorId, lifestyleId? (default: primary), months } — uses the lifestyle's monthly cost (upgrades included).
    'shop/payLifestyle': {
      role: 'any',
      handler(ctx, { actorId, lifestyleId, months }) {
        const actor = getActor(ctx, actorId);
        if (Array.isArray(actor.lifestyles)) settleLifestyles(actor);
        let lf;
        if (lifestyleId) {
          lf = (actor.lifestyles || []).find((l) => l.id === lifestyleId);
          if (!lf) ctx.fail('Train de vie introuvable');
        } else lf = primaryLifestyle(actor);
        if (!lf || !(Number(lf.monthlyCost) > 0)) ctx.fail('Aucun train de vie défini pour ce personnage');
        const m = int(months, 1);
        if (m < 1 || m > 24) ctx.fail('Nombre de mois invalide (1 à 24)');
        const total = Math.round(Number(lf.monthlyCost) * m);
        checkFunds(ctx, actor, total);
        actor.nuyen = (Number(actor.nuyen) || 0) - total;
        lf.monthsPaid = (Number(lf.monthsPaid) || 0) + m;
        history(actor, tk('Loyer : {name} — {n} mois'), { name: lf.name, n: m }, -total);
        shopLog(ctx, actorId, tk('{actor} paie {n} mois de train de vie ({name}) — {cost}'), { actor: actor.name, n: m, name: lf.name, cost: nuyen(total) });
        notifyOwners(ctx, actorId, 'sfx', { id: 'cash' });
        return { monthsPaid: lf.monthsPaid, total, lifestyleId: lf.id };
      },
    },

    // GM: remove resolved orders from the history (pending ones are kept).
    'shop/clearOrders': {
      role: 'gm',
      handler(ctx) {
        ctx.state.shop.orders = ctx.state.shop.orders.filter((o) => o.status === 'pending');
        return { ok: true };
      },
    },
  },

  filter(view, user) {
    if (!view.shop) return;
    const mine = new Set(user.characterIds || []);
    view.shop.orders = (view.shop.orders || []).filter((o) => o.userId === user.id || mine.has(o.actorId));
    view.shop.specials = (view.shop.specials || [])
      .filter((s) => !s.hidden && (!s.forActorIds?.length || s.forActorIds.some((id) => mine.has(id))))
      .map(({ gmNotes, ...s }) => s);
    delete view.shop.removedSeedIds;
    delete view.shop.restored;
  },
};
