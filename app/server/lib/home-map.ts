// Table map of a lifestyle's home (level 1 « Homes », shared/home.ts): created when the flat is picked, linked by
// lifestyle.home.mapId, archived as a « former home » on a move, rebuilt on request when the lifestyle's add-ons changed.
// Used by 40-shop.ts (shop/move, shop/homeMap, init) — the map itself is an ordinary table map the GM can edit and show.
import { buildHome, homeAddons, homeLayout } from '../../shared/home.ts';
import { uid } from '../../shared/util.ts';
import { normalizeMap } from '../modules/20-maps.ts';
import { t as tr } from './i18n.ts';
import type { Actor, GameMap, Lifestyle, TableState } from '../../shared/types.ts';

/** Add-ons the map was built with (to tell when it is out of date). */
export const addonsSignature = (l: Lifestyle): string => homeAddons(l).map((a) => a.key).sort().join(',');

/** The lifestyle's linked map, if it still exists. */
export const homeMapOf = (state: TableState, l: Lifestyle | null | undefined): GameMap | null => {
  const id = l?.home?.mapId;
  return (id && state.maps?.[id]) || null;
};

/** Build the home's map content (tiles, walls, doors, rooms, lights) in the table language. */
function built(state: TableState, l: Lifestyle) {
  const lang = state.config?.lang;
  return buildHome(l, null, { tr: (s) => tr(lang, s) });
}

/** Create the map of the lifestyle's current flat and link it. Returns it, or null when there is no flat. */
export function createHomeMap(state: TableState, actor: Actor, l: Lifestyle): GameMap | null {
  const b = built(state, l);
  const lay = homeLayout(l);
  if (!b || !lay || !l.home) return null;
  const lang = state.config?.lang;
  const m = {
    ...b.map,
    id: uid('map'),
    name: tr(lang, 'Home of {actor} — {name}', { actor: actor.name, name: tr(lang, lay.name) }),
    folder: tr(lang, 'Homes'),
    fog: false,
    explored: {},
    tokens: [],
    notes: [],
    home: { actorId: actor.id, lifestyleId: l.id },
  };
  // a map still tagged for this lifestyle (its `home` was cleared by a GM edit) becomes a former home
  for (const old of Object.values(state.maps)) if (old.home?.actorId === actor.id && old.home.lifestyleId === l.id) retire(state, old);
  const map = normalizeMap(m);
  state.maps[map.id] = map;
  l.home.mapId = map.id;
  l.home.addons = addonsSignature(l);
  return map;
}

/** Rebuild the linked map after the add-ons changed: new walls and rooms, tokens and notes kept (clamped). */
export function rebuildHomeMap(state: TableState, actor: Actor, l: Lifestyle): GameMap | null {
  const old = homeMapOf(state, l);
  if (!old) return createHomeMap(state, actor, l);
  const b = built(state, l);
  if (!b || !l.home) return null;
  const { width, height, tiles, walls, doors, regions, lights } = b.map;
  Object.assign(old, { width, height, tiles, walls, doors, regions, lights, explored: {} });
  old.notes = old.notes.filter((n) => n.x < width && n.y < height);
  old.tokens = old.tokens.filter((tk) => tk.x < width && tk.y < height);
  normalizeMap(old);
  l.home.addons = addonsSignature(l);
  return old;
}

/** Rename a map as a former home and drop its link. */
function retire(state: TableState, map: GameMap): void {
  const lang = state.config?.lang;
  map.name = tr(lang, '{name} (former)', { name: map.name }).slice(0, 80);
  map.folder = tr(lang, 'Former homes');
  delete map.home;
}

/** Moving out: the old map stays (the GM may have used it) but is renamed, filed under « Former homes » and unlinked. */
export function archiveHomeMap(state: TableState, l: Lifestyle): void {
  const map = homeMapOf(state, l);
  if (l.home) delete l.home.mapId;
  if (map) retire(state, map);
}

/** Boot: flats picked before home maps existed get theirs (once: a map the GM deleted is not recreated). */
export function ensureHomeMaps(state: TableState): void {
  for (const a of Object.values(state.actors || {})) {
    if (a?.type !== 'pc') continue;
    for (const l of a.lifestyles || []) {
      if (l?.home && homeLayout(l) && l.home.mapId === undefined) createHomeMap(state, a, l);
    }
  }
}

/** A player's copy of a home map: no GM notes, GM regions, hidden tokens or description; guests don't see closed secret doors. */
function playerHomeMap(map: GameMap, owner: boolean): GameMap {
  const m: GameMap = { ...map, notes: [], explored: {}, regions: map.regions.filter((r) => !r.gmOnly), tokens: map.tokens.filter((tk) => !tk.hidden) };
  delete m.description;
  if (!owner) {
    const hidden = new Set(map.doors.filter((d) => d.kind === 'secret' && d.state !== 'open').map((d) => d.y * map.width + d.x));
    if (hidden.size) {
      m.tiles = map.tiles.map((row, y) => [...row].map((c, x) => (hidden.has(y * map.width + x) ? '#' : c)).join(''));
      m.doors = map.doors.filter((d) => !hidden.has(d.y * map.width + d.x));
    }
    m.doors = m.doors.map((d) => (d.state === 'locked' ? { ...d, state: 'closed' } : d));
  }
  return m;
}

/** Maps of the homes a player may open: their runners' homes, and the homes one of their runners was invited to. */
export function homeMapsFor(state: TableState, characterIds: readonly string[]): Record<string, GameMap> {
  const mine = new Set(characterIds);
  const out: Record<string, GameMap> = {};
  for (const a of Object.values(state.actors || {})) {
    if (a?.type !== 'pc') continue;
    for (const l of a.lifestyles || []) {
      const map = homeMapOf(state, l);
      if (!map) continue;
      const own = mine.has(a.id);
      if (own || l.place?.guests?.some((g) => mine.has(g))) out[map.id] = playerHomeMap(map, own);
    }
  }
  return out;
}
