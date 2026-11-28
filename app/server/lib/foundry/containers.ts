// Foundry inventories (system.inventories → containers fvtt_inv_<slug>) on an app actor that already exists: the merge
// re-import (importer.ts buildPc) and the boot migration from the table's seed pack (10-characters init) share this.
import { deepClone } from '../../../shared/util.ts';
import type { Actor } from '../../../shared/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- actor / converted sheet walked list by list
type FieldRec = Record<string, any>;

const LISTS = ['weapons', 'armor', 'gear'];
const isFoundryInv = (c: unknown): boolean => typeof (c as FieldRec | null)?.id === 'string' && (c as FieldRec).id.startsWith('fvtt_inv_');

/**
 * Containers the app does not have yet are added (same stable fvtt_inv_ ids), and the app items `fresh` puts in them are
 * moved there when they are still « Sur soi » (a live actor created before inventories existed adopts Foundry's bags).
 * Containers the app already has, and items moved in the app, are kept. Returns the number of containers added.
 */
export function mergeContainers(a: FieldRec, fresh: FieldRec): number {
  a.containers = Array.isArray(a.containers) ? a.containers : [];
  const have = new Set(a.containers.map((c: FieldRec | null) => c?.id));
  const added = new Set<string>();
  for (const c of fresh.containers || []) {
    if (!c?.id || have.has(c.id)) continue;
    a.containers.push(deepClone(c));
    added.add(c.id);
  }
  if (!added.size) return 0;
  for (const l of LISTS) {
    const freshLoc = new Map<string, string>((fresh[l] || []).filter((x: FieldRec) => added.has(x?.location)).map((x: FieldRec) => [x.id, x.location]));
    for (const it of a[l] || []) {
      const loc = freshLoc.get(it?.id);
      if (loc && (!it.location || it.location === 'on')) {
        it.location = loc;
        if (l === 'gear') it.active = false;
        else it.equipped = false;
      }
    }
  }
  return added.size;
}

/**
 * One-off migration (2026-11-28): a table seeded before the Foundry import read `system.inventories` keeps its PCs
 * without containers (everything « Sur soi ») — only a merge re-import from Foundry used to add them, and a VPS table
 * often has no Foundry world to re-import from. The table's seed pack has the same actor (same id, same Foundry
 * document) with its containers and item locations: adopt them once, flagged `foundry.containers`. An actor that
 * already has Foundry containers (imported since) is only flagged. Returns the number of containers added.
 */
export function adoptSeedContainers(actor: Actor, seed: Actor | null | undefined): number {
  const link = actor.foundry;
  if (!link?.id || link.containers || !seed || seed.foundry?.id !== link.id) return 0;
  link.containers = true;
  if ((actor.containers || []).some(isFoundryInv)) return 0;
  const fromSeed = (seed.containers || []).filter(isFoundryInv);
  if (!fromSeed.length) return 0;
  return mergeContainers(actor as unknown as FieldRec, { ...(seed as unknown as FieldRec), containers: fromSeed });
}
