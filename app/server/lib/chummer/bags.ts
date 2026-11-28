// One-off migration (2026-11-28): Chummer gear with contents became bag containers (parse.ts pushGear). Characters imported
// before that keep their bag as a plain item and its contents as « on body » gear noted « in {bag} »; this re-reads their
// stored .chum5 once and puts the contents in the bag. Flagged `chummer.bags` (new imports and exports set it).
import { parseChum5 } from './parse.ts';
import type { Actor, Container, Gear } from '../../../shared/types.ts';

/** Note written by the old import for a bag's content: « in {bag} » / « dans {bag} », then the item's own note. */
const OLD_NOTE = /^(?:in|dans) [^—]+?(?: — |$)/;

/**
 * Adopt the bags of the stored .chum5 on an actor imported before bags existed. Returns the number of items moved
 * (0 too when there is nothing to do); sets `chummer.bags` once the file was read.
 */
export function adoptChummerBags(actor: Actor): number {
  const link = actor.chummer;
  if (!link?.xml || link.bags) return 0;
  let parsed: ReturnType<typeof parseChum5>['actor'];
  let n = 0;
  try {
    parsed = parseChum5(link.xml, { keepXml: false, makeId: (p) => `${p}_mig${++n}`, lang: link.lang || 'fr' }).actor;
  } catch {
    return 0; // unreadable stored file: leave the actor alone (and retry at the next boot)
  }
  link.bags = true;
  const gear: Gear[] = Array.isArray(actor.gear) ? actor.gear : [];
  const byGuid = new Map(gear.filter((g) => g.chummerGuid).map((g) => [g.chummerGuid!, g]));
  const parsedById = new Map((parsed.gear || []).map((g) => [g.id, g]));
  const containers: Container[] = (actor.containers ||= []);
  let moved = 0;
  for (const bag of (parsed.containers || []).filter((c) => c.itemId)) {
    const bagGuid = parsedById.get(bag.itemId!)?.chummerGuid;
    const mine = bagGuid && byGuid.get(bagGuid);
    if (!mine) continue; // the bag was deleted in the app
    // The item may already have its container (a carry bag opened by normalizeInventory linkCarryBags): fill that one.
    const target = containers.find((c) => c.itemId === mine.id)?.id || bag.id;
    if (!containers.some((c) => c.id === target)) containers.push({ ...bag, itemId: mine.id });
    for (const p of parsed.gear || []) {
      if (p.location !== bag.id || !p.chummerGuid) continue;
      const it = byGuid.get(p.chummerGuid);
      if (!it || (it.location && it.location !== 'on')) continue; // moved in the app since the import: keep it there
      it.location = target;
      // Drop the old « in {bag} » prefix when the rest is still the imported note.
      if (it.notes && it.notes !== (p.notes || '') && OLD_NOTE.test(it.notes) && it.notes.replace(OLD_NOTE, '') === (p.notes || '')) {
        if (p.notes) it.notes = p.notes;
        else delete it.notes;
      }
      moved++;
    }
  }
  return moved;
}
