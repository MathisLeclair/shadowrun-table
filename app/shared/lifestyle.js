// Lifestyle rules (SR5 p.369-373, Run Faster p.216-230). Pure module shared by the server and the browser.
//
// actor.lifestyles = [{ id, name, base, catalogId?, baseCost, monthsPaid, primary, points?, pointCost?, qualities: [Quality],
//                       monthlyCost (derived, stored for display), notes, chummerGuid? }]
// Quality = { id, catalogId?, name, nameFr?, category, cost (flat ¥/month, may be < 0), multiplier (%), baseOnly? (the % applies to the
//             base cost only: Chummer <multiplierbaseonly>, Extra Secure), lp?, notes? }
//
// i18n: static messages are French keys (tk), dynamic ones { key, params } — see ARCHITECTURE.md « i18n ».
const tk = (s) => s;

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** RF point categories bought above the base lifestyle (optional). */
export const POINT_KEYS = ['comforts', 'security', 'neighborhood', 'entertainment'];

/** Contract options (DocWagon, Pheromone Detection…) are added after the percentages (Chummer: never multiplied). */
export const isContract = (q) => String(q?.category || '') === 'Contracts';

/** Sums of a lifestyle's parts: { base, baseOnlyPct, pct, flat (non-contract options), contracts, points }. */
function parts(l) {
  const base = Math.max(0, num(l?.baseCost));
  let baseOnlyPct = 0;
  let pct = 0;
  let flat = 0;
  let contracts = 0;
  for (const q of Array.isArray(l?.qualities) ? l.qualities : []) {
    if (!q || typeof q !== 'object') continue;
    if (q.baseOnly) baseOnlyPct += num(q.multiplier);
    else pct += num(q.multiplier);
    if (isContract(q)) contracts += num(q.cost);
    else flat += num(q.cost);
  }
  let points = 0;
  if (l?.points && l?.pointCost) for (const k of POINT_KEYS) points += Math.max(0, num(l.points[k])) * Math.max(0, num(l.pointCost[k]));
  return { base, baseOnlyPct, pct, flat, contracts, points };
}

/**
 * Monthly cost of one lifestyle (Chummer's order):
 *   (baseCost × (1 + Σ base-only % / 100) + Σ option costs (non-contract) + Σ points[k] × pointCost[k] (RF, optional))
 *     × (1 + Σ other % / 100) + Σ contract costs
 * e.g. Medium 5 000 + Garage 100 + Dangerous Area −20 % = 4 080. Never negative; rounded to the nuyen.
 */
export function monthlyCost(l) {
  if (!l || typeof l !== 'object') return 0;
  const p = parts(l);
  return Math.max(0, Math.round((p.base * (1 + p.baseOnlyPct / 100) + p.flat + p.points) * (1 + p.pct / 100) + p.contracts));
}

/** Breakdown for display: { base, multiplier (Σ %), fromMultiplier, flat (all option costs), contracts, points, total }. */
export function costBreakdown(l) {
  const p = parts(l);
  const total = monthlyCost(l);
  const multiplier = p.baseOnlyPct + p.pct;
  const flat = Math.round(p.flat + p.contracts);
  return { base: p.base, multiplier, fromMultiplier: total - p.base - flat - p.points, flat, contracts: Math.round(p.contracts), points: p.points, total };
}

/** Recompute and store `monthlyCost` on every lifestyle of an actor; keeps exactly one primary. Returns the actor. */
export function settleLifestyles(actor) {
  if (!actor || !Array.isArray(actor.lifestyles)) return actor;
  let primarySeen = false;
  for (const l of actor.lifestyles) {
    if (!Array.isArray(l.qualities)) l.qualities = [];
    l.monthlyCost = monthlyCost(l);
    if (l.primary && !primarySeen) primarySeen = true;
    else l.primary = false;
  }
  if (!primarySeen && actor.lifestyles.length) actor.lifestyles[0].primary = true;
  return actor;
}

/** The primary lifestyle of an actor (or the first one, or null). */
export function primaryLifestyle(actor) {
  const list = Array.isArray(actor?.lifestyles) ? actor.lifestyles : [];
  return list.find((l) => l.primary) || list[0] || null;
}

/** Base lifestyle id of a catalog lifestyle name ('Hospitalized, Basic' → 'Hospitalized'). */
export function baseOf(name) {
  const s = String(name || '');
  if (/^Hospitalized/i.test(s)) return 'Hospitalized';
  return s;
}

/**
 * New lifestyle from a catalog lifestyle item (data/catalog/lifestyles.json).
 * opts: { id, name?, months, primary }
 */
export function lifestyleFromCatalog(item, opts = {}) {
  const st = item?.stats || {};
  const l = {
    id: opts.id,
    name: String(opts.name || item?.nameFr || item?.name || 'Train de vie').slice(0, 120),
    base: baseOf(item?.name),
    catalogId: item?.id,
    baseCost: Math.max(0, Math.round(num(item?.cost))),
    monthsPaid: Math.max(0, Math.round(num(opts.months))),
    primary: !!opts.primary,
    qualities: [],
    notes: '',
  };
  if (st.pointCost && Object.keys(st.pointCost).length) l.pointCost = { ...st.pointCost };
  l.monthlyCost = monthlyCost(l);
  return l;
}

/**
 * Lifestyle quality (upgrade) from a catalog item (data/catalog/lifestylequalities.json).
 * cost = the catalog monthly cost already priced by the caller (rules.js quote) or the item cost.
 */
export function qualityFromCatalog(item, opts = {}) {
  const st = item?.stats || {};
  const q = {
    id: opts.id,
    catalogId: item?.id,
    name: item?.name || 'Option',
    category: item?.category || '',
    cost: Math.round(num(opts.cost ?? item?.cost)),
    multiplier: num(st.multiplier),
  };
  if (st.baseOnly) q.baseOnly = true;
  if (item?.nameFr) q.nameFr = item.nameFr;
  if (st.lp !== undefined) q.lp = num(st.lp);
  if (opts.notes) q.notes = String(opts.notes).slice(0, 500);
  return q;
}

/**
 * Can this catalog quality be added to this lifestyle? → null, or a message: French string (static) or { key, params }.
 * Checks the allowed base lifestyles (Chummer <allowed>, <required><lifestyle>), duplicates (unless <allowmultiple>) and
 * the other options of the lifestyle (<forbidden>/<required> <oneof><lifestylequality>). lookup(catalogId) → catalog item
 * (optional) also catches an option already there that forbids this one.
 */
export function qualityProblem(l, item, lookup) {
  if (!l || !item) return tk('Option inconnue');
  const st = item.stats || {};
  if (Array.isArray(st.allowed) && st.allowed.length && l.base && !st.allowed.includes(l.base)) {
    return { key: tk('{item} : réservé aux trains de vie {allowed}'), params: { item: item.nameFr || item.name, allowed: st.allowed.join(', ') } };
  }
  if (!st.multiple && (l.qualities || []).some((q) => q.catalogId && q.catalogId === item.id)) {
    return { key: tk('{item} est déjà sur ce train de vie'), params: { item: item.nameFr || item.name } };
  }
  if (Array.isArray(st.requiresLifestyle) && st.requiresLifestyle.length && l.base && !st.requiresLifestyle.includes(l.base)) {
    return { key: tk('{item} : réservé aux trains de vie {allowed}'), params: { item: item.nameFr || item.name, allowed: st.requiresLifestyle.join(', ') } };
  }
  // Options of the same lifestyle: Chummer <forbidden>/<required> <oneof><lifestylequality> (by English name).
  const names = new Set((l.qualities || []).map((q) => String(q?.name || '')));
  const clash = (Array.isArray(st.forbids) ? st.forbids : []).find((n) => names.has(n));
  if (clash) return { key: tk('{item} est incompatible avec {other}'), params: { item: item.nameFr || item.name, other: clash } };
  // …and the reverse: an option already there whose catalog entry forbids this one (lookup(catalogId) → catalog item).
  const reverse = typeof lookup === 'function' ? (l.qualities || []).find((q) => q?.catalogId && (lookup(q.catalogId)?.stats?.forbids || []).includes(item.name)) : null;
  if (reverse) return { key: tk('{item} est incompatible avec {other}'), params: { item: item.nameFr || item.name, other: reverse.nameFr || reverse.name } };
  if (Array.isArray(st.requiresOneOf) && st.requiresOneOf.length && !st.requiresOneOf.some((n) => names.has(n))) {
    return { key: tk('{item} demande d’abord : {list}'), params: { item: item.nameFr || item.name, list: st.requiresOneOf.join(', ') } };
  }
  return null;
}
