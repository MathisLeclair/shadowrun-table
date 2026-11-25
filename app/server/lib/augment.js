// Augmentation side effects shared by the shop (40-shop) and the sheet editor (10-characters):
// attribute / initiative-dice bonuses recorded on the augmentation (aug.bonus) and the linked implant weapon (weapon.augId).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalFormula } from '../../client/modules/shop/rules.js';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');

/** Apply a catalog bonus ({ attributes: { REA: 'Rating' }, initiativeDice: 'Rating' }) and return what was applied. */
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
  return Object.keys(applied).length ? applied : undefined;
}

/** Reverse a bonus previously returned by applyBonus (stored on the augmentation / power). */
export function removeBonus(actor, applied) {
  if (!applied) return;
  for (const [k, v] of Object.entries(applied.attributes || {})) {
    actor.augmented = actor.augmented || {};
    actor.augmented[k] = (Number(actor.augmented[k]) || 0) - v;
    if (!actor.augmented[k]) delete actor.augmented[k];
  }
  if (applied.initiativeDice && actor.initiative) actor.initiative.dice = Math.max(1, Math.min(5, (Number(actor.initiative.dice) || 1) - applied.initiativeDice));
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
  if (bonus.initiativeDice) {
    let v = 0;
    try {
      v = Math.round(evalFormula(bonus.initiativeDice, { Rating: level }));
    } catch {}
    if (v) out.initiativeDice = v;
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
  if (Object.keys(next).length) power.bonus = next;
  else delete power.bonus;
}
