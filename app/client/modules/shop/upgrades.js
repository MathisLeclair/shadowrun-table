// Upgrade previews (client mirror of the server checks in server/modules/40-shop.js — the server stays the authority):
// weapon accessories (mounts), armor modifications (capacity), vehicle modifications (slots), lifestyle options (monthly cost).
import { UPGRADE_FILES, quote, accessoryFit, armorCapacity, armorCapacityUsed, armorModFit, vehicleVars, vehicleModFit, vehicleModMaxRating, vehicleSlots, vehicleSlotsUsed, freeMounts, fold, upgradeAvail } from './rules.js';
import { monthlyCost, qualityFromCatalog, qualityProblem } from '/shared/lifestyle.js';
import { t, tk } from '../../lib/i18n.js';

/** A rules message (French key string or { key, params }) translated. */
export function msgText(m) {
  if (!m) return '';
  return typeof m === 'string' ? t(m) : t(m.key, m.params);
}

/** Items of the actor an upgrade file can be installed on. */
export function targetsFor(file, actor) {
  const spec = UPGRADE_FILES[file];
  if (!spec || !actor) return [];
  const list = Array.isArray(actor[spec.list]) ? actor[spec.list] : [];
  if (spec.list === 'weapons') return list.filter((w) => !w.augId);
  return list;
}

/** Catalog item of an owned item (by catalogId, else by name), or null. */
export function catalogItemOf(catalog, it) {
  if (!catalog || !it) return null;
  if (it.catalogId && catalog.byId.get(it.catalogId)) return catalog.byId.get(it.catalogId).item;
  const k = fold(it.name);
  if (!k) return null;
  const e = catalog.entries.find((x) => !UPGRADE_FILES[x.file] && x.file !== 'lifestyles' && (fold(x.item.name) === k || fold(x.item.nameFr) === k));
  return e ? e.item : null;
}

function baseValue(catalog, it) {
  if (it?.paid !== undefined && it.paid !== null && it.paid !== '' && Number.isFinite(Number(it.paid))) return Number(it.paid);
  const c = catalogItemOf(catalog, it);
  if (!c) return null;
  try {
    return quote(c, { rating: it.rating }).unitCost;
  } catch {
    return null;
  }
}

/**
 * Price & fit of an upgrade entry on one of the actor's items.
 * opts: { targetId, mount, rating }; sim: Map of simulated targets (cart: several lines on the same item).
 * → { target, targetCat, q, unitCost, problem, mount, mounts (free mount points), need, used, cap, maxRating, monthlyDelta, monthlyCost }
 */
export function upgradePreview(entry, actor, catalog, shop, opts = {}, sim = new Map()) {
  const item = entry.item;
  const spec = UPGRADE_FILES[entry.file];
  const markup = entry.file === 'lifestylequalities' ? 0 : shop?.markup || 0;
  const safeQ = (o) => {
    try {
      return quote(item, { markup, ...o });
    } catch {
      return { unitCost: Number(item.cost) || 0, availValue: Number(item.availValue) || 0, legality: item.legality || '', avail: item.avail || '0', rating: null, base: Number(item.cost) || 0 };
    }
  };
  const real = targetsFor(entry.file, actor).find((x) => x.id === opts.targetId);
  if (!real) {
    const q = safeQ({ rating: opts.rating });
    return { q, unitCost: q.unitCost, problem: tk('Choisis sur quoi installer cet article'), missingTarget: true };
  }
  const key = `${spec.list}:${real.id}`;
  if (!sim.has(key)) sim.set(key, JSON.parse(JSON.stringify(real)));
  const target = sim.get(key);
  if (!Array.isArray(target[spec.sub])) target[spec.sub] = [];
  const targetCat = spec.list === 'lifestyles' ? null : catalogItemOf(catalog, real);
  const out = { target: real, targetCat };

  if (entry.file === 'lifestylequalities') {
    const q = safeQ({});
    const problem = qualityProblem(target, item, (id) => catalog?.byId?.get(id)?.item);
    const before = monthlyCost(target);
    if (!problem) target.qualities.push(qualityFromCatalog(item, { cost: q.base }));
    const after = problem ? before + Math.round(Number(q.base) || 0) : monthlyCost(target);
    const delta = after - before;
    return { ...out, q, problem, unitCost: Math.max(0, delta) * Math.max(0, Math.round(Number(real.monthsPaid) || 0)), monthlyDelta: delta, monthlyCost: after };
  }
  const value = baseValue(catalog, real);
  // « +2R » items (availRelative) add the target's availability.
  let targetQ = null;
  try {
    targetQ = targetCat ? quote(targetCat, { rating: real.rating }) : null;
  } catch {}
  const relQ = (o) => upgradeAvail(safeQ(o), item, targetQ);
  if (entry.file === 'accessories') {
    const q = relQ({ rating: opts.rating, vars: { WeaponCost: value ?? 0 } });
    const mounts = freeMounts(target, targetCat, item);
    const fit = accessoryFit(target, targetCat, item, { mount: opts.mount });
    let problem = fit.problem;
    if (!problem && item.stats?.targetCost && value === null) problem = { key: tk('Prix de {weapon} inconnu : impossible de chiffrer {item}'), params: { weapon: real.name, item: item.nameFr || item.name } };
    if (!problem) target.accessories.push({ catalogId: item.id, mount: fit.mount });
    return { ...out, q, unitCost: q.unitCost, problem, mount: fit.mount, mounts };
  }
  if (entry.file === 'armormods') {
    const cap = armorCapacity(target, targetCat);
    const q = relQ({ rating: opts.rating, vars: { ArmorCost: value ?? 0, Capacity: cap } });
    const fit = armorModFit(target, targetCat, item, q.rating);
    if (!fit.problem) target.mods.push({ catalogId: item.id, capacity: fit.need });
    return { ...out, q, unitCost: q.unitCost, problem: fit.problem, need: fit.need, used: armorCapacityUsed(real), cap };
  }
  // vehiclemods
  const vars = vehicleVars(target, targetCat, value ?? 0);
  const maxRating = vehicleModMaxRating(item, vars);
  const wanted = opts.rating === undefined || opts.rating === null ? item.rating?.min : Math.min(Number(opts.rating) || 1, maxRating ?? (Number(opts.rating) || 1));
  const q = relQ({ rating: wanted, vars });
  const fit = vehicleModFit(target, targetCat, item, q.rating, vars);
  let problem = fit.problem;
  if (!problem && /VehicleCost/.test(item.costFormula || '') && value === null) problem = { key: tk('Prix de {weapon} inconnu : impossible de chiffrer {item}'), params: { weapon: real.name, item: item.nameFr || item.name } };
  if (!problem) target.mods.push({ catalogId: item.id, slots: fit.need, category: item.category || '' });
  // used / cap of the mod's slot pool (R5: per category on vehicles, one pool on drones; null = not limited).
  return { ...out, q, unitCost: q.unitCost, problem, need: fit.need, pool: fit.pool, used: fit.pool ? vehicleSlotsUsed(real, fit.pool) : null, cap: fit.pool ? vehicleSlots(real, targetCat, fit.pool) : null, maxRating };
}
