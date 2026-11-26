// Map library helpers shared by the server (server/lib/maplib.js, server/modules/22-maplib.js) and the browser
// (client/modules/map/LibraryBrowser.js preview). Pure ES module: no Node or DOM APIs.
// A library version = { walls, lights, regions, entry?, geometry } in CELL units (origin = the grid origin of the image).
// See ARCHITECTURE.md « Map library ».

export const LIB_URL_PREFIX = '/api/maplib/';
/** URL a table map uses for a library image (the browser adds the signed ?k= key when it loads it). */
export const libImageUrl = (slug) => `${LIB_URL_PREFIX}image/${encodeURIComponent(slug)}`;
export const libThumbUrl = (slug) => `${LIB_URL_PREFIX}thumb/${encodeURIComponent(slug)}`;
/** True for a library image / thumbnail URL (needs the signed key). */
export const isLibUrl = (url) => typeof url === 'string' && (url.startsWith(LIB_URL_PREFIX + 'image/') || url.startsWith(LIB_URL_PREFIX + 'thumb/'));

export const LIB_THEMES = ['street', 'bar', 'corp', 'lab', 'industrial', 'residential', 'matrix', 'club'];
export const LIB_LIGHTINGS = ['bright', 'dim', 'dark'];
export const LIB_SOURCES = ['fragmap', 'fragmaps-free'];
/** Id prefix of the GM-only « Entrée » region made from a library entry point (rebuilt on every update, never published). */
export const ENTRY_REGION_PREFIX = 'libentry';

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const r2 = (v) => Math.round(Number(v) * 100) / 100;

/** Geometry of a library entry → background placement + grid size of a table map (cells). */
export function libGeometry(e) {
  const gridPx = Number(e.gridPx) > 0 ? Number(e.gridPx) : 100;
  const imageW = Number(e.imageW) > 0 ? Number(e.imageW) : (Number(e.width) || 30) * gridPx;
  const imageH = Number(e.imageH) > 0 ? Number(e.imageH) : (Number(e.height) || 20) * gridPx;
  const offsetX = Number(e.offsetX) || 0;
  const offsetY = Number(e.offsetY) || 0;
  const width = Math.max(1, Math.round(Number(e.width)) || Math.ceil((imageW - offsetX) / gridPx));
  const height = Math.max(1, Math.round(Number(e.height)) || Math.ceil((imageH - offsetY) / gridPx));
  return { gridPx, imageW, imageH, offsetX, offsetY, width, height, bgX: r3(-offsetX / gridPx), bgY: r3(-offsetY / gridPx), bgW: r3(imageW / gridPx), bgH: r3(imageH / gridPx) };
}

/** Stable geometric key of a wall (direction-independent), for diffs and door-state matching. */
export function wallGeoKey(w) {
  const a = [r2(w.x1), r2(w.y1)], b = [r2(w.x2), r2(w.y2)];
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  return `${p[0]},${p[1]},${q[0]},${q[1]}`;
}
const wallKey = (w) => `${wallGeoKey(w)}|${w.move !== false ? 1 : 0}${w.sight !== false ? 1 : 0}|${w.door ? (w.door.kind === 'secret' ? 's' : 'd') : '-'}`;
const lightKey = (l) => `${r2(l.x)},${r2(l.y)},${r2(l.radius)}`;
const regionKey = (r) => `${String(r.name || '').trim()}|${r.x},${r.y},${r.w},${r.h}`;

/** Regions of a table map that belong to the library (not GM-only, not the generated entry region). */
export const publicRegions = (regions) => (regions || []).filter((r) => !r.gmOnly && !String(r.id || '').startsWith(ENTRY_REGION_PREFIX));

function countDiff(cur, next, key) {
  const a = new Map();
  for (const o of cur) a.set(key(o), (a.get(key(o)) || 0) + 1);
  let add = 0;
  for (const o of next) {
    const k = key(o);
    const n = a.get(k) || 0;
    if (n > 0) a.set(k, n - 1);
    else add++;
  }
  let remove = 0;
  for (const n of a.values()) remove += n;
  return { add, remove };
}

/**
 * Summary of what « Mettre à jour depuis la bibliothèque » would change on a table map:
 * { walls: { add, remove }, doors: { add, remove }, lights, regions, resized, keptDoorStates, same }.
 * `version` = the library version ({ walls, lights, regions, geometry }).
 */
export function libraryDiff(map, version, meta = {}) {
  const curWalls = (map.walls || []).filter((w) => !w.door);
  const curDoors = (map.walls || []).filter((w) => w.door);
  const nextWalls = (version.walls || []).filter((w) => !w.door);
  const nextDoors = (version.walls || []).filter((w) => w.door);
  const g = libGeometry({ ...meta, ...(version.geometry || {}) });
  const walls = countDiff(curWalls, nextWalls, wallKey);
  const doors = countDiff(curDoors, nextDoors, wallKey);
  const lights = countDiff(map.lights || [], version.lights || [], lightKey);
  const regions = countDiff(publicRegions(map.regions), version.regions || [], regionKey);
  const curDoorKeys = new Map(curDoors.map((w) => [wallGeoKey(w), w.door]));
  const keptDoorStates = nextDoors.filter((w) => {
    const d = curDoorKeys.get(wallGeoKey(w));
    return d && d.state !== 'closed';
  }).length;
  const resized = g.width !== map.width || g.height !== map.height;
  const same = !resized && ![walls, doors, lights, regions].some((d) => d.add || d.remove);
  return { walls, doors, lights, regions, resized, width: g.width, height: g.height, keptDoorStates, same };
}

/**
 * Wall / light / region lists of a table map made from a library version (fresh ids from `uid`).
 * `previous` = the table map being updated: door states (and names) of doors at the same position and the on/off
 * state of lights at the same place are kept.
 */
export function instanceContent(version, uid, { previous = null } = {}) {
  const doorBy = new Map();
  for (const w of previous?.walls || []) if (w.door) doorBy.set(wallGeoKey(w), w.door);
  const lightBy = new Map();
  for (const l of previous?.lights || []) lightBy.set(lightKey(l), l);
  const walls = (version.walls || []).map((w) => {
    const prev = w.door ? doorBy.get(wallGeoKey(w)) : null;
    const door = w.door ? { state: prev?.state || w.door.state || 'closed', kind: w.door.kind === 'secret' ? 'secret' : 'door', ...(prev?.name ? { name: prev.name } : {}) } : null;
    return { id: uid('wall'), x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, move: w.move !== false, sight: w.sight !== false, door };
  });
  const lights = (version.lights || []).map((l) => {
    const prev = lightBy.get(lightKey(l));
    return { id: uid('light'), x: l.x, y: l.y, radius: l.radius, color: l.color || '#ffcc88', on: prev ? prev.on !== false : l.on !== false };
  });
  const regions = (version.regions || []).map((r) => ({ id: uid('reg'), name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, gmOnly: false }));
  const e = version.entry;
  if (e && Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y))) {
    regions.push({ id: uid(ENTRY_REGION_PREFIX), name: 'Entrée', x: Math.max(0, Math.floor(e.x)), y: Math.max(0, Math.floor(e.y)), w: 1, h: 1, gmOnly: true });
  }
  return { walls, lights, regions };
}

/**
 * Library version made from a table map (« Publier mes corrections ») — tokens, notes, fog, GM-only regions and door
 * names are never published; doors are reset to closed. `shift` = { x, y } cells to subtract (table map moved/resized
 * relative to its image).
 */
export function versionFromMap(map, { shift = { x: 0, y: 0 } } = {}) {
  const sx = Number(shift.x) || 0, sy = Number(shift.y) || 0;
  let n = 0;
  const walls = (map.walls || []).map((w) => ({
    id: `w${++n}`,
    x1: r3(w.x1 - sx), y1: r3(w.y1 - sy), x2: r3(w.x2 - sx), y2: r3(w.y2 - sy),
    move: w.move !== false, sight: w.sight !== false,
    door: w.door ? { state: 'closed', kind: w.door.kind === 'secret' ? 'secret' : 'door' } : null,
  }));
  n = 0;
  const lights = (map.lights || []).map((l) => ({ id: `l${++n}`, x: r3(l.x - sx), y: r3(l.y - sy), radius: Number(l.radius) || 5, color: l.color || '#ffcc88', on: l.on !== false }));
  n = 0;
  const regions = publicRegions(map.regions).map((r) => ({ id: `r${++n}`, name: String(r.name || 'Zone').slice(0, 80), x: Math.round(r.x - sx), y: Math.round(r.y - sy), w: r.w, h: r.h, gmOnly: false }));
  return { walls, lights, regions };
}

/** Counts shown in lists. */
export function versionCounts(v) {
  const walls = v.walls || [];
  return { walls: walls.filter((w) => !w.door).length, doors: walls.filter((w) => w.door).length, lights: (v.lights || []).length, regions: (v.regions || []).length };
}

/** Accent / case-insensitive text used by the library search (names FR/EN, tags, description). */
export function searchText(e) {
  return [e.name, e.nameFr, e.slug, ...(e.tags || []), e.description || '']
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
/** Every term of the query found in searchText(e). */
export function matchesQuery(e, q) {
  const terms = String(q || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return true;
  const hay = searchText(e);
  return terms.every((t) => hay.includes(t));
}
