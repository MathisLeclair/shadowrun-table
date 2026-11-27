// Server side of shared/modifiers.js: the effects index (data/catalog/effects.json, global read-only catalog data — shared by
// every table, like the shop catalog indexes) and helpers used by the characters, combat and Matrix modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectModifiers, lookupFromIndex, derivedWithModifiers, type EffectsIndex, type ModifierLookup } from '../../shared/modifiers.ts';
import type { Actor, Modifier } from '../../shared/types.ts';

/** lookup(file, catalogId, name) → the catalog item's effects index entry (data/catalog/effects.json). */
export type EffectsLookup = ModifierLookup;

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog', 'effects.json');

let index: EffectsIndex | null = null; // data/catalog/effects.json (generated file)
let lookup: EffectsLookup | null = null;
/** lookup(file, catalogId, name) over data/catalog/effects.json (loaded once; an absent / broken file = no effects). */
export function effectsLookup(): EffectsLookup {
  if (!lookup) {
    try {
      index = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      index = { files: {}, names: {} };
    }
    lookup = lookupFromIndex(index);
  }
  return lookup;
}

/** Every modifier of an actor (opts.weaponId adds that weapon's accessories). */
export function actorModifiers(actor: Actor, opts: { weaponId?: string } = {}): Modifier[] {
  return collectModifiers(actor, effectsLookup(), opts);
}

/** derive() with the modifiers applied (condition monitors, armor, wound threshold…). */
export function deriveFull(actor: Actor) {
  return derivedWithModifiers(actor, actorModifiers(actor));
}
