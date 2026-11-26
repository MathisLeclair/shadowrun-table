// Augmentation side effects shared by the shop (40-shop) and the sheet editor (10-characters):
// attribute / initiative-dice bonuses recorded on the augmentation (aug.bonus) and the linked implant weapon (weapon.augId).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalFormula } from '../../client/modules/shop/rules.js';
import { bonusFromEffects, importedItem } from '../../shared/modifiers.js';
import { effectsLookup } from './modifiers.js';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');

/**
 * Apply a catalog bonus ({ attributes: { REA: 'Rating' }, initiativeDice: 'Rating', initiative: 'FixedValues(3,6,9)' }) and return
 * what was applied (same shape, numbers) — stored on the item as item.bonus so removal / rating changes reverse exactly that.
 */
export function applyBonus(actor, bonus, rating, sign = 1) {
  if (!bonus) return undefined;
  const applied = {};
  for (const [k, f] of Object.entries(bonus.attributes || {})) {
    let v = 0;
    try {
      v = Math.round(evalFormula(f, { Rating: rating ?? 1 }));
    } catch {}
    if (!v) continue;
    actor.augmented = actor.augmented || {};
    actor.augmented[k] = (Number(actor.augmented[k]) || 0) + v * sign;
    if (!actor.augmented[k]) delete actor.augmented[k];
    (applied.attributes = applied.attributes || {})[k] = v;
  }
  if (bonus.initiativeDice) {
    let v = 0;
    try {
      v = Math.round(evalFormula(bonus.initiativeDice, { Rating: rating ?? 1 }));
    } catch {}
    if (v) {
      actor.initiative = actor.initiative || { dice: 1, bonus: 0 };
      actor.initiative.dice = Math.max(1, Math.min(5, (Number(actor.initiative.dice) || 1) + v * sign));
      applied.initiativeDice = v;
    }
  }
  if (bonus.initiative) {
    let v = 0;
    try {
      v = Math.round(evalFormula(bonus.initiative, { Rating: rating ?? 1 }));
    } catch {}
    if (v) {
      actor.initiative = actor.initiative || { dice: 1, bonus: 0 };
      actor.initiative.bonus = (Number(actor.initiative.bonus) || 0) + v * sign;
      applied.initiative = v;
    }
  }
  return Object.keys(applied).length ? applied : undefined;
}

/** Reverse a bonus previously returned by applyBonus (stored on the augmentation / power / quality). */
export function removeBonus(actor, applied) {
  if (!applied) return;
  for (const [k, v] of Object.entries(applied.attributes || {})) {
    actor.augmented = actor.augmented || {};
    actor.augmented[k] = (Number(actor.augmented[k]) || 0) - v;
    if (!actor.augmented[k]) delete actor.augmented[k];
  }
  if (applied.initiativeDice && actor.initiative) actor.initiative.dice = Math.max(1, Math.min(5, (Number(actor.initiative.dice) || 1) - applied.initiativeDice));
  if (applied.initiative && actor.initiative) actor.initiative.bonus = (Number(actor.initiative.bonus) || 0) - applied.initiative;
}

const BONUS_FILES = { augmentations: ['cyberware', 'bioware'], powers: ['powers'], qualities: ['qualities'] };
/** Rating used for « Rating » in an item's bonus (powers: level). */
export const bonusRating = (list, item) => (list === 'powers' ? Number(item?.level) || 1 : Number(item?.rating ?? item?.level) || 1);

/**
 * Attribute / initiative bonus of an actor item (augmentation, adept power, quality) from its catalog effects
 * (data/catalog/effects.json, matched by catalogId or name: initiative score, « select attribute » choice included),
 * else `fallback` (the catalog's stats.bonus). Formulas, evaluated by applyBonus with the item's rating.
 */
export function itemBonusSpec(list, item, fallback) {
  const files = list === 'augmentations' && item?.kind === 'bioware' ? ['bioware', 'cyberware'] : BONUS_FILES[list] || [];
  const lookup = effectsLookup();
  for (const f of files) {
    const e = lookup(f, item?.catalogId, item?.name) || (item?.nameFr ? lookup(f, null, item.nameFr) : null);
    if (e) return bonusFromEffects(e.effects, item);
  }
  return fallback || undefined;
}

/**
 * Store an item's attribute / initiative bonus on the actor (actor.augmented / actor.initiative) and record it on item.bonus,
 * replacing what the item recorded before (rating / level / choice change). Imported items are left alone: the import stored theirs.
 */
export function bakeItemBonus(actor, list, item, fallback) {
  if (!item || importedItem(item)) return;
  removeBonus(actor, item.bonus);
  delete item.bonus;
  const applied = applyBonus(actor, itemBonusSpec(list, item, fallback), bonusRating(list, item), 1);
  if (applied) item.bonus = applied;
}

export function weaponFromStats(ctx, name, category, st, extra = {}) {
  return {
    id: ctx.uid('wpn'),
    name,
    category: category || '',
    kind: st.type === 'melee' ? 'melee' : 'ranged',
    skill: st.skill || (st.type === 'melee' ? 'clubs' : 'pistols'),
    accuracy: st.accuracy ?? '',
    damage: st.damage || '',
    ap: st.ap ?? 0,
    mode: st.mode || '',
    rc: st.rc ?? 0,
    ammo: st.ammo || '',
    reach: st.reach || 0,
    ...extra,
  };
}

let wareIndex = null;
/** Catalog entry (cyberware/bioware) by id, or null. */
export function wareCatalogItem(catalogId) {
  if (!catalogId) return null;
  if (!wareIndex) {
    wareIndex = new Map();
    for (const f of ['cyberware', 'bioware']) {
      try {
        for (const it of JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${f}.json`), 'utf8'))) wareIndex.set(it.id, it);
      } catch {}
    }
  }
  return wareIndex.get(catalogId) || null;
}

/** Undo everything an augmentation brought (bonus + implant weapons). Call after removing it from the list. */
export function detachAugmentation(actor, aug) {
  if (!aug) return;
  removeBonus(actor, aug.bonus);
  if (Array.isArray(actor.weapons)) actor.weapons = actor.weapons.filter((w) => w.augId !== aug.id);
}

/** Bonus totals of a levelled catalog bonus at a given level (0 → nothing). */
function bonusTotals(bonus, level) {
  if (!bonus || !(level > 0)) return {};
  const out = {};
  for (const [k, f] of Object.entries(bonus.attributes || {})) {
    let v = 0;
    try {
      v = Math.round(evalFormula(f, { Rating: level }));
    } catch {}
    if (v) (out.attributes = out.attributes || {})[k] = v;
  }
  for (const k of ['initiativeDice', 'initiative']) {
    if (!bonus[k]) continue;
    let v = 0;
    try {
      v = Math.round(evalFormula(bonus[k], { Rating: level }));
    } catch {}
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Bring an adept power's catalog bonus (Improved Reflexes: REA + initiative dice per level) in line with its level.
 * What is applied is recorded on power.bonus so removal/level changes reverse exactly that. For a power that
 * existed before without a record, levels up to `fromLevel` are assumed already counted on the sheet by hand.
 */
export function syncPowerBonus(actor, power, bonus, fromLevel = 0) {
  if (!power || !bonus) return;
  const prev = power.bonus || bonusTotals(bonus, fromLevel);
  const next = bonusTotals(bonus, Math.max(1, Number(power.level) || 1));
  const keys = new Set([...Object.keys(prev.attributes || {}), ...Object.keys(next.attributes || {})]);
  for (const k of keys) {
    const d = (next.attributes?.[k] || 0) - (prev.attributes?.[k] || 0);
    if (!d) continue;
    actor.augmented = actor.augmented || {};
    actor.augmented[k] = (Number(actor.augmented[k]) || 0) + d;
    if (!actor.augmented[k]) delete actor.augmented[k];
  }
  const di = (next.initiativeDice || 0) - (prev.initiativeDice || 0);
  if (di) {
    actor.initiative = actor.initiative || { dice: 1, bonus: 0 };
    actor.initiative.dice = Math.max(1, Math.min(5, (Number(actor.initiative.dice) || 1) + di));
  }
  const dn = (next.initiative || 0) - (prev.initiative || 0);
  if (dn) {
    actor.initiative = actor.initiative || { dice: 1, bonus: 0 };
    actor.initiative.bonus = (Number(actor.initiative.bonus) || 0) + dn;
  }
  if (Object.keys(next).length) power.bonus = next;
  else delete power.bonus;
}
