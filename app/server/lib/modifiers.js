// Server side of shared/modifiers.js: the effects index (data/catalog/effects.json, global read-only catalog data — shared by
// every table, like the shop catalog indexes) and helpers used by the characters, combat and Matrix modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectModifiers, lookupFromIndex, derivedWithModifiers } from '../../shared/modifiers.js';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog', 'effects.json');

let index = null;
let lookup = null;
/** lookup(file, catalogId, name) over data/catalog/effects.json (loaded once; an absent / broken file = no effects). */
export function effectsLookup() {
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
export function actorModifiers(actor, opts = {}) {
  return collectModifiers(actor, effectsLookup(), opts);
}

/** derive() with the modifiers applied (condition monitors, armor, wound threshold…). */
export function deriveFull(actor) {
  return derivedWithModifiers(actor, actorModifiers(actor));
}
