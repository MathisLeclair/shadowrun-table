// Server side of shared/modifiers.js: the effects index (data/catalog/effects.json, global read-only catalog data — shared by
// every table, like the shop catalog indexes) and helpers used by the characters, combat and Matrix modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectModifiers, lookupFromIndex, derivedWithModifiers } from '../../shared/modifiers.js';
import type { Actor, Modifier } from '../../shared/types.ts';

/** An effects index entry as returned by lookup(): the catalog item's effects (data/catalog/effects.json). */
export type EffectsLookup = (file: string, catalogId: string | null | undefined, name: string | null | undefined) => { effects: unknown[] } | null;

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog', 'effects.json');

let index: unknown = null; // data/catalog/effects.json (generated file)
let lookup: EffectsLookup | null = null;
/** lookup(file, catalogId, name) over data/catalog/effects.json (loaded once; an absent / broken file = no effects). */
export function effectsLookup(): EffectsLookup {
  if (!lookup) {
    try {
      index = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      index = { files: {}, names: {} };
    }
    lookup = lookupFromIndex(index) as EffectsLookup;
  }
  return lookup;
}

/** Every modifier of an actor (opts.weaponId adds that weapon's accessories). */
export function actorModifiers(actor: Actor, opts: { weaponId?: string } = {}): Modifier[] {
  return collectModifiers(actor, effectsLookup(), opts) as Modifier[];
}

/** derive() with the modifiers applied (condition monitors, armor, wound threshold…). */
// Return type: whatever shared/modifiers derivedWithModifiers() computes (typed once shared/ is converted).
export function deriveFull(actor: Actor) {
  return derivedWithModifiers(actor, actorModifiers(actor));
}
