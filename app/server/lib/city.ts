// City map data shared by 72-city.ts (state, view, GM settings) and 40-shop.ts (shop/move places a home).
// District shapes are static files traced from a map image (data/city/<id>.json, tools/city-districts.ts); a table's
// `state.city` stores which map is the city and its own copy of the districts (the GM may rename them).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson } from '../store.ts';
import type { CityDistrict, CityShapes, GameMap, TableState } from '../../shared/types.ts';

export const CITY_DIR = path.join(DATA_DIR, 'city');

let cache: CityShapes[] | null = null;
/** Every shapes file (read once). */
export function cityShapes(): CityShapes[] {
  if (cache) return cache;
  cache = [];
  try {
    for (const f of fs.readdirSync(CITY_DIR).filter((x) => x.endsWith('.json')).sort()) {
      const s = readJson<CityShapes>(path.join(CITY_DIR, f));
      if (s?.id && s.background && Array.isArray(s.districts)) cache.push(s);
    }
  } catch {}
  return cache;
}

/** Shapes traced from this map's background image, if any. */
export const shapesForMap = (map: GameMap | null | undefined): CityShapes | null =>
  (map?.background?.url && cityShapes().find((s) => s.background === map.background!.url)) || null;

/** First table map whose background has traced shapes (the default city map). */
export function guessCityMap(state: TableState): GameMap | null {
  for (const m of Object.values(state.maps || {})) if (shapesForMap(m)) return m;
  return null;
}

/** The city as in use: the chosen (or guessed) map and its districts. Null when the table has no city map. */
export function activeCity(state: TableState): { map: GameMap; districts: CityDistrict[]; width: number; height: number } | null {
  const c = state.city;
  const map = (c?.mapId && state.maps?.[c.mapId]) || (!c?.mapId ? guessCityMap(state) : null);
  if (!map) return null;
  const districts = c?.districts?.length && c.shapes && shapesForMap(map)?.id === c.shapes ? c.districts : shapesForMap(map)?.districts || [];
  return { map, districts, width: map.width, height: map.height };
}
