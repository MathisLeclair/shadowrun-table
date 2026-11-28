// Maps module: battle maps, tokens, doors, lights, regions, GM notes, fog of war (see ARCHITECTURE.md › Maps).
// Vision / path rules live in shared/vision.js (same code runs in the browser).
import fs from 'node:fs';
import { movementRate, vehicleStats } from '../../shared/vehicles.ts';
import path from 'node:path';
import { uid, deepClone } from '../../shared/util.ts';
import { derive } from '../../shared/sr5.ts';
import { effectsLookup } from '../lib/modifiers.ts';
import { displayEyes } from '../../shared/display.ts';
import {
  isTileChar, buildGrid, findPath, pathLength, createVisionContext, visibilityForUser, viewersForUser,
  tokenInMask, encodeBits, decodeBits, orBits, remapBits, isPcToken, stepBlocked, wallMidpoint, pointSegmentDistance,
} from '../../shared/vision.ts';
import type {
  ActionContext, ActionDef, Actor, Disposition, DoorKind, DoorState, GameMap, GameView, InitOptions, Lighting, MapBackground, MapDoor,
  MapId, MapLight, MapNote, MapRegion, MapTheme, MapWall, Point, ServerModule, SessionUser, SfxId, TableState, Token, TokenVision,
  UserId, WallDoor,
} from '../../shared/types.ts';

/** Untrusted map-like objects (payloads, imports, seeds, old saves) sanitized field by field; generic CRUD payloads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
/** What the cell-bounded sanitizers need of a map. */
type MapSize = { width: number; height: number };
/** A door found by id: tile door (map.doors) or segment door (a wall with a `door`). */
type FoundDoor = { type: 'tile'; door: MapDoor; wall?: undefined } | { type: 'wall'; wall: MapWall; door: WallDoor };
type VisionCtx = ReturnType<typeof createVisionContext>;

/** Marker for the i18n checker: French error keys passed around before ctx.fail(). */
const tk = (s: string): string => s;
const MAX_DIM = 160;
const MAX_WALLS = 6000;
const WALL_DOOR_KINDS: WallDoor['kind'][] = ['door', 'secret'];
const BG_MODES: MapBackground['mode'][] = ['image', 'underlay'];
const THEMES: MapTheme[] = ['street', 'bar', 'corp', 'lab', 'industrial', 'residential', 'matrix', 'club'];
const LIGHTINGS: Lighting[] = ['bright', 'dim', 'dark'];
const DOOR_STATES: DoorState[] = ['open', 'closed', 'locked'];
const DOOR_KINDS: DoorKind[] = ['door', 'gate', 'shutter', 'secret'];
const DISPOSITIONS: Disposition[] = ['pc', 'ally', 'neutral', 'hostile'];
const ANCHORS: Record<string, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], w: [0, 0.5], c: [0.5, 0.5], center: [0.5, 0.5], e: [1, 0.5], sw: [0, 1], s: [0.5, 1], se: [1, 1] };
const PLAYER_TOKEN_FIELDS = ['color', 'img', 'status', 'light'];
// Players can only switch the standard torch on/off on their token (a custom radius would light a whole 'dark' map).
const PLAYER_TORCH = { radius: 6, color: '#fff1cc' };

/** Key of the current combat turn when a fight runs on this map (movement budget), else null. */
function combatMoveKey(state: TableState, map: GameMap): string | null {
  const c = state.combat;
  if (!c?.active || (c.mapId && c.mapId !== map.id)) return null;
  return `${c.startedAt || 0}:${c.round || 1}`;
}
const ENTRY_RE = /entr[ée]e|entry|d[ée]part|start|arriv[ée]e|spawn/i;

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------
const str = (v: unknown, max = 200): string => (v == null ? '' : String(v)).slice(0, max);
function int(v: unknown, lo: number, hi: number, def: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function num(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
const color = (v: unknown, def: string): string => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : def);
const url = (v: unknown): string => (typeof v === 'string' && v.length < 2000 && /^(\/|https?:\/\/|data:image\/)/i.test(v.trim()) ? v.trim() : '');
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);

function cleanRow(row: unknown, width: number): string {
  let s = '';
  const src = typeof row === 'string' ? row : '';
  for (let x = 0; x < width; x++) {
    const ch = src[x];
    s += ch === undefined ? ' ' : isTileChar(ch) ? ch : '.';
  }
  return s;
}

function cleanVision(v: Loose | null | undefined): TokenVision | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: TokenVision = {};
  if (typeof v.lowLight === 'boolean') out.lowLight = v.lowLight;
  if (typeof v.thermo === 'boolean') out.thermo = v.thermo;
  if (v.darkRange != null && v.darkRange !== '') out.darkRange = int(v.darkRange, 0, 60, 0);
  return Object.keys(out).length ? out : undefined;
}
function cleanTokenLight(l: Loose | null | undefined): Token['light'] {
  if (!l || typeof l !== 'object') return undefined;
  const radius = num(l.radius, 0, 40, 0);
  if (!radius) return undefined;
  return { radius, color: color(l.color, '#fff1cc') };
}

function cleanToken(t: Loose, map: MapSize): Token {
  const tok: Token = {
    id: str(t.id, 60) || uid('tok'),
    actorId: t.actorId ? str(t.actorId, 80) : null,
    name: str(t.name || 'Token', 60),
    x: int(t.x, 0, Math.max(0, map.width - 1), 0),
    y: int(t.y, 0, Math.max(0, map.height - 1), 0),
    size: int(t.size, 1, 4, 1),
    disposition: oneOf(t.disposition, DISPOSITIONS, 'neutral'),
    hidden: !!t.hidden,
  };
  const c = color(t.color, '');
  if (c) tok.color = c;
  const img = url(t.img);
  if (img) tok.img = img;
  const vision = cleanVision(t.vision);
  if (vision) tok.vision = vision;
  const light = cleanTokenLight(t.light);
  if (light) tok.light = light;
  if (Array.isArray(t.status)) tok.status = t.status.map((s: unknown) => str(s, 30)).filter(Boolean).slice(0, 12);
  if (t.lastMove && Array.isArray(t.lastMove.path)) tok.lastMove = t.lastMove;
  if (t.astral) tok.astral = true;
  if (t.vehicleId) tok.vehicleId = str(t.vehicleId, 60); // a vehicle / drone of actorId (34-vehicles)
  return tok;
}

function cleanDoor(d: Loose, map: MapSize): MapDoor {
  return {
    id: str(d.id, 60) || uid('door'),
    x: int(d.x, 0, map.width - 1, 0),
    y: int(d.y, 0, map.height - 1, 0),
    state: oneOf(d.state, DOOR_STATES, 'closed'),
    kind: oneOf(d.kind, DOOR_KINDS, 'door'),
    ...(d.name ? { name: str(d.name, 60) } : {}),
  };
}
function cleanLight(l: Loose, map: MapSize): MapLight {
  return {
    id: str(l.id, 60) || uid('light'),
    x: int(l.x, 0, map.width - 1, 0),
    y: int(l.y, 0, map.height - 1, 0),
    radius: num(l.radius, 0.5, 60, 5),
    color: color(l.color, '#ffcc88'),
    on: l.on !== false,
    ...(l.name ? { name: str(l.name, 60) } : {}),
  };
}
function cleanRegion(r: Loose, map: MapSize): MapRegion {
  const x = int(r.x, 0, map.width - 1, 0);
  const y = int(r.y, 0, map.height - 1, 0);
  return {
    id: str(r.id, 60) || uid('reg'),
    name: str(r.name || 'Area', 80),
    x, y,
    w: int(r.w, 1, map.width - x, 1),
    h: int(r.h, 1, map.height - y, 1),
    ...(color(r.color, '') ? { color: color(r.color, '') } : {}),
    gmOnly: !!r.gmOnly,
    // Camera zone driven by a host device (matrix module): 'on' = filmed, 'off' = feed cut. Absent = no camera.
    ...(r.cams === 'on' || r.cams === 'off' ? { cams: r.cams } : {}),
  };
}
/** Segment wall door: null or { state, kind: 'door'|'secret', name? }. Accepts true / legacy tile kinds. */
function cleanWallDoor(d: unknown): WallDoor | null {
  if (!d) return null;
  const src: Loose = typeof d === 'object' ? d : {};
  return {
    state: oneOf(src.state, DOOR_STATES, 'closed'),
    kind: src.kind === 'secret' ? 'secret' : 'door',
    ...(src.name ? { name: str(src.name, 60) } : {}),
  };
}
/** Cell coordinate rounded to 1/1000 (keeps Foundry joints exact), bounded to a sane range. */
const coord = (v: unknown): number => {
  const n = Number(v);
  const lim = MAX_DIM * 4;
  return v !== null && v !== '' && Number.isFinite(n) ? Math.round(Math.max(-lim, Math.min(lim, n)) * 1000) / 1000 : NaN;
};
/** Segment wall in cell units. Returns null when the segment is unusable (non-numeric, zero length). */
function cleanWall(w: Loose | null | undefined): MapWall | null {
  if (!w || typeof w !== 'object') return null;
  const x1 = coord(w.x1), y1 = coord(w.y1), x2 = coord(w.x2), y2 = coord(w.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || (x1 === x2 && y1 === y2)) return null;
  const out: MapWall = { id: str(w.id, 60) || uid('wall'), x1, y1, x2, y2, move: w.move !== false, sight: w.sight !== false, door: cleanWallDoor(w.door) };
  if (w.foundry && typeof w.foundry === 'object') out.foundry = w.foundry;
  return out;
}
function cleanWalls(list: unknown): MapWall[] {
  const seen = new Set<string>();
  const out: MapWall[] = [];
  for (const w of Array.isArray(list) ? list : []) {
    const c = cleanWall(w);
    if (!c) continue;
    if (seen.has(c.id)) c.id = uid('wall');
    seen.add(c.id);
    out.push(c);
    if (out.length >= MAX_WALLS) break;
  }
  return out;
}
/** Background image: { url, opacity, mode: 'image'|'underlay', x, y, w, h } (cells). null when no valid url. */
function cleanBackground(b: Loose | null | undefined, map: MapSize): MapBackground | null {
  if (!b || typeof b !== 'object' || !url(b.url)) return null;
  const mode = oneOf(b.mode, BG_MODES, 'underlay');
  const lim = MAX_DIM * 4;
  return {
    url: url(b.url),
    opacity: num(b.opacity, 0, 1, mode === 'image' ? 1 : 0.6),
    mode,
    x: num(b.x, -lim, lim, 0),
    y: num(b.y, -lim, lim, 0),
    w: num(b.w, 0.5, lim, map.width),
    h: num(b.h, 0.5, lim, map.height),
  };
}

function cleanNote(n: Loose, map: MapSize): MapNote {
  return {
    id: str(n.id, 60) || uid('note'),
    x: int(n.x, 0, map.width - 1, 0),
    y: int(n.y, 0, map.height - 1, 0),
    text: str(n.text, 4000),
    gmOnly: true as const,
  };
}

/** Bring any map-like object to the canonical shape (in place). Doors force their cell to 'D'. */
export function normalizeMap(m: Loose): GameMap {
  m.id = str(m.id, 80) || uid('map');
  m.name = str(m.name || 'Unnamed map', 80);
  if (m.folder != null) m.folder = str(m.folder, 60);
  if (m.description != null) m.description = str(m.description, 20000);
  const rows = Array.isArray(m.tiles) ? m.tiles : [];
  m.width = int(m.width ?? Math.max(0, ...rows.map((r: unknown) => (typeof r === 'string' ? r.length : 0))), 1, MAX_DIM, 30);
  m.height = int(m.height ?? rows.length, 1, MAX_DIM, 20);
  m.tiles = Array.from({ length: m.height }, (_, y: number) => cleanRow(rows[y], m.width));
  m.metersPerCell = num(m.metersPerCell, 0.25, 50, 1);
  m.lighting = oneOf(m.lighting, LIGHTINGS, 'bright');
  setWeather(m, m.weather);
  m.theme = oneOf(m.theme, THEMES, 'street');
  m.fog = m.fog !== false;
  m.sharedVision = m.sharedVision !== false;
  m.movementLocked = !!m.movementLocked;
  m.explored = m.explored && typeof m.explored === 'object' && !Array.isArray(m.explored) ? m.explored : {};
  const bg = cleanBackground(m.background, m as MapSize);
  if (bg) m.background = bg;
  else delete m.background;
  m.walls = cleanWalls(m.walls);
  const inside = (o: Loose) => o && Number(o.x) >= 0 && Number(o.y) >= 0 && Number(o.x) < m.width && Number(o.y) < m.height;
  const seen = new Set<number>();
  m.doors = (Array.isArray(m.doors) ? m.doors : []).filter(inside).map((d: Loose) => cleanDoor(d, m as MapSize)).filter((d: MapDoor) => {
    const k = d.y * m.width + d.x;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const d of m.doors) setTile(m as GameMap, d.x, d.y, 'D');
  m.lights = (Array.isArray(m.lights) ? m.lights : []).filter(inside).map((l: Loose) => cleanLight(l, m as MapSize));
  m.regions = (Array.isArray(m.regions) ? m.regions : []).filter(inside).map((r: Loose) => cleanRegion(r, m as MapSize));
  m.notes = (Array.isArray(m.notes) ? m.notes : []).filter(inside).map((n: Loose) => cleanNote(n, m as MapSize));
  m.tokens = (Array.isArray(m.tokens) ? m.tokens : []).filter((t: unknown) => t && typeof t === 'object').map((t: Loose) => cleanToken(t, m as MapSize));
  return m as GameMap;
}

function setTile(map: MapSize & { tiles: string[] }, x: number, y: number, ch: string): void {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return;
  const row = map.tiles[y];
  if (row[x] === ch) return;
  map.tiles[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

/**
 * Segment walls as a player receives them. Walls are needed client-side (path previews, door clicks) and
 * are not secret, but they carry no GM data: plain walls get anonymous ids; door segments keep their id only
 * when the player knows a cell next to them. Closed secret doors are stripped of every door attribute (sent
 * as anonymous plain walls, indistinguishable from the others, so path previews stay right without leaking).
 * Unknown closed doors become plain walls too; unknown open doors are dropped. Locked shows as closed.
 */
function playerWalls(map: GameMap, known: ArrayLike<number>): MapWall[] {
  const w = map.width, h = map.height;
  const knownNear = (wall: MapWall) => {
    const m = wallMidpoint(wall);
    for (let y = Math.floor(m.y - 0.5); y <= Math.floor(m.y + 0.5); y++)
      for (let x = Math.floor(m.x - 0.5); x <= Math.floor(m.x + 0.5); x++) if (x >= 0 && y >= 0 && x < w && y < h && known[y * w + x]) return true;
    return false;
  };
  const out: Array<Omit<MapWall, 'id'> & { id?: string }> = [];
  for (const wall of map.walls || []) {
    const seg = { x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2 };
    const d = wall.door;
    if (d) {
      const hiddenSecret = d.kind === 'secret' && d.state !== 'open';
      if (hiddenSecret || !knownNear(wall)) {
        if (d.state !== 'open') out.push({ ...seg, move: wall.move, sight: wall.sight, door: null });
        continue;
      }
      out.push({ id: wall.id, ...seg, move: wall.move, sight: wall.sight, door: { state: d.state === 'locked' ? 'closed' : d.state, kind: 'door', ...(d.name ? { name: d.name } : {}) } });
    } else out.push({ ...seg, move: wall.move, sight: wall.sight, door: null });
  }
  let k = 0;
  for (const o of out) if (!o.id) o.id = '_w' + k++;
  return out as MapWall[];
}

/** Doors whose cell is no longer a 'D' tile are removed (editor painted over them). */
function dropOrphanDoors(map: GameMap): void {
  map.doors = map.doors.filter((d) => map.tiles[d.y]?.[d.x] === 'D');
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------
function playerUsers(state: TableState): SessionUser[] {
  return Object.values(state.users || {}).map((u) => ({ id: u.id, role: 'player' as const, name: u.name, characterIds: u.characterIds || [] }));
}

// Vision contexts (blocking grids, segment index, light map, per-viewer LOS memo) are cached per map and
// rebuilt only when something that affects sight changes — the filter runs for every player on every broadcast.
const vctxCache = new WeakMap<GameMap, { sig: string; ctx: VisionCtx }>();
function visionSignature(map: GameMap): string {
  const tokLights: number[] = [];
  for (const t of map.tokens || []) if (t.light?.radius) tokLights.push(t.x, t.y, t.light.radius);
  return JSON.stringify([map.width, map.height, map.lighting, map.tiles, map.doors, map.walls, map.lights, tokLights]);
}
function visionContext(map: GameMap): VisionCtx {
  const sig = visionSignature(map);
  const hit = vctxCache.get(map);
  if (hit && hit.sig === sig) return hit.ctx;
  const ctx = createVisionContext(map);
  vctxCache.set(map, { sig, ctx });
  return ctx;
}

/** OR every player's current visibility into map.explored (only the map players currently see). */
export function refreshFog(state: TableState, map: GameMap | null | undefined): void {
  if (!map || map.fog === false || state.scene?.activeMapId !== map.id) return;
  const n = map.width * map.height;
  let vctx = null;
  for (const u of playerUsers(state)) {
    if (!viewersForUser(map, u, state.actors).length) continue;
    vctx ||= visionContext(map);
    const { visible } = visibilityForUser(map, u, state.actors, vctx, effectsLookup());
    const explored = decodeBits(map.explored[u.id], n);
    if (orBits(explored, visible) || !map.explored[u.id]) map.explored[u.id] = encodeBits(explored);
  }
}

// ---------------------------------------------------------------------------
// Helpers for handlers
// ---------------------------------------------------------------------------
function getMap(ctx: ActionContext, mapId: MapId): GameMap {
  const m = ctx.state.maps?.[mapId];
  if (!m) ctx.fail('Map not found');
  return m;
}
function getToken(ctx: ActionContext, map: GameMap, tokenId: string): Token {
  const t = map.tokens.find((x) => x.id === tokenId);
  if (!t) ctx.fail('Token not found');
  return t;
}
/** `notFound` = translatable error key ('Light not found'…). */
function findById<T extends { id: string }>(ctx: ActionContext, list: T[], id: unknown, notFound: string): T {
  const o = list.find((x) => x.id === id);
  if (!o) ctx.fail(notFound);
  return o;
}
function cellArg(ctx: ActionContext, map: GameMap, x: unknown, y: unknown): Point {
  const cx = Math.round(Number(x)), cy = Math.round(Number(y));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) ctx.fail('Cell outside the map');
  return { x: cx, y: cy };
}
const chebyshev = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function userOwnsToken(user: SessionUser, token: Token): boolean {
  return !!token.actorId && (user.characterIds || []).includes(token.actorId);
}

function tokenFromActor(actor: Actor, extra: Loose = {}): Loose {
  const t: Loose = { actorId: actor.id, name: actor.name, disposition: actor.type === 'pc' ? 'pc' : 'hostile', hidden: false, ...extra };
  if (actor.color && !t.color) t.color = actor.color;
  if (actor.portrait && !t.img) t.img = actor.portrait;
  return t;
}

/** Put an actor's token on the free cell nearest to (x, y) (47-magic: a materialized spirit next to its summoner). */
export function placeActorToken(state: TableState, map: GameMap, actor: Actor, x: number, y: number, extra: Loose = {}): Token {
  const [cell] = freeCellsNear(map, x, y, 1);
  const t = cleanToken({ ...tokenFromActor(actor, extra), x: cell ? cell.x : x, y: cell ? cell.y : y, id: undefined }, map);
  map.tokens.push(t);
  refreshFog(state, map);
  return t;
}

/** Free walkable cells near (x, y): nearest free floor (any distance), then a flood through walkable cells. */
function freeCellsNear(map: GameMap, x: number, y: number, count: number, extraOccupied: number[] = []): Point[] {
  const grid = buildGrid(map);
  const { w, h, move } = grid;
  const occupied = new Set(map.tokens.map((t) => t.y * w + t.x));
  for (const i of extraOccupied) occupied.add(i);
  const free = (i: number) => !move[i] && !occupied.has(i);
  const sx = Math.max(0, Math.min(w - 1, x | 0)), sy = Math.max(0, Math.min(h - 1, y | 0));
  // Phase 1: nearest free cell by grid distance (through anything).
  let seed = -1;
  {
    const seen = new Uint8Array(w * h);
    const q = [sy * w + sx];
    seen[q[0]] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      if (free(i)) { seed = i; break; }
      const cx = i % w, cy = (i - cx) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!seen[ni]) { seen[ni] = 1; q.push(ni); }
      }
    }
  }
  if (seed < 0) return [];
  // Phase 2: flood through walkable cells from the seed.
  const out: Point[] = [];
  const seen = new Uint8Array(w * h);
  const q = [seed];
  seen[seed] = 1;
  for (let qi = 0; qi < q.length && out.length < count; qi++) {
    const i = q[qi];
    if (free(i)) out.push({ x: i % w, y: Math.floor(i / w) });
    const cx = i % w, cy = (i - cx) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!seen[ni] && !move[ni] && !stepBlocked(grid, cx, cy, dx, dy)) { seen[ni] = 1; q.push(ni); }
    }
  }
  return out;
}

function entryPoint(map: GameMap): Point {
  const r = map.regions.find((x) => ENTRY_RE.test(x.name));
  if (r) return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
  return { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) };
}

function compactPath(path: Point[]): Array<[number, number]> {
  const p = path.map((c): [number, number] => [c.x, c.y]);
  return p.length > 200 ? [...p.slice(0, 1), ...p.slice(-199)] : p;
}

function doMove(ctx: ActionContext, map: GameMap, token: Token, x: unknown, y: unknown, { ignoreWalls = false }: { ignoreWalls?: boolean } = {}): { path: Point[]; meters: number } {
  const to = cellArg(ctx, map, x, y);
  const from = { x: token.x, y: token.y };
  let pathCells: Point[] | null;
  if (!ctx.isGM) {
    if (!userOwnsToken(ctx.user, token)) ctx.fail('This token isn\'t yours');
    if (ctx.state.scene?.activeMapId !== map.id) ctx.fail('The GM isn\'t showing this map');
    if (map.movementLocked) ctx.fail('The GM has locked movement');
    // Players may only walk through cells they know (explored or currently visible), around visible non-allied tokens.
    const n = map.width * map.height;
    const { visible } = visibilityForUser(map, ctx.user, ctx.state.actors, visionContext(map), effectsLookup());
    const known = map.fog === false ? null : decodeBits(map.explored[ctx.user.id], n);
    if (known) orBits(known, visible);
    const blockers: Point[] = [];
    const occupied: Point[] = [];
    for (const t of map.tokens) {
      if (t.id === token.id) continue;
      if (t.hidden || !tokenInMask(t, visible, map.width, map.height)) continue;
      const ally = t.disposition === 'pc' || t.disposition === 'ally';
      (ally ? occupied : blockers).push({ x: t.x, y: t.y });
    }
    pathCells = findPath(map, from, to, { blockers, occupied, allowed: known });
    if (!pathCells) ctx.fail('Destination unreachable');
  } else if (ignoreWalls) {
    pathCells = [from, to];
  } else {
    pathCells = findPath(map, from, to, {}) || [from, to];
  }
  // In combat, movement (walk AGI×2 / run AGI×4 m) is a budget for the whole combat turn, not per drag.
  const key = combatMoveKey(ctx.state, map);
  if (key && !(ctx.isGM && ignoreWalls)) {
    const meters = pathLength(pathCells, map.metersPerCell);
    const used = token.moveBudget?.key === key ? Number(token.moveBudget.meters) || 0 : 0;
    const actor = token.actorId ? ctx.state.actors?.[token.actorId] : null;
    if (!ctx.isGM && actor) {
      let run: number | null = null;
      try {
        // A vehicle token: the running rate of its Speed (Movement Rates Table, SR5 p. 202).
        const v = token.vehicleId ? (actor.vehicles || []).find((x) => x?.id === token.vehicleId) : null;
        run = v ? movementRate(vehicleStats(v).speed)[1] : derive(actor).movement.run;
      } catch {}
      if (run != null && used + meters > run) {
        ctx.fail('Too far for this turn: {step} m requested, {left} m left (max run {run} m)', { step: meters, left: Math.max(0, Math.round((run - used) * 10) / 10), run });
      }
    }
    token.moveBudget = { key, meters: Math.round((used + meters) * 100) / 100 };
  }
  token.x = to.x;
  token.y = to.y;
  token.lastMove = { path: compactPath(pathCells), ts: ctx.now };
  return { path: pathCells, meters: pathLength(pathCells, map.metersPerCell) };
}

function sfx(ctx: ActionContext, id: SfxId): void {
  ctx.emitTo('all', 'sfx', { id });
}

/** Weather of a map for the environmental modifiers (SR5 p. 175): visibility (rain / fog / smoke) and wind, 0 none … 3 heavy. */
function setWeather(map: { weather?: GameMap['weather'] }, w: Loose | null | undefined): void {
  const lvl = (v: unknown) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));
  const next = { visibility: lvl(w?.visibility), wind: lvl(w?.wind) };
  if (next.visibility || next.wind) map.weather = next;
  else delete map.weather;
}

function patchMapFields(ctx: ActionContext, map: GameMap, patch: Loose | null | undefined): void {
  if (!patch || typeof patch !== 'object') ctx.fail('Invalid change');
  if ('name' in patch) map.name = str(patch.name || ctx.t('Unnamed map'), 80); // stored in the table language
  if ('folder' in patch) map.folder = str(patch.folder, 60);
  if ('description' in patch) map.description = str(patch.description, 20000);
  if ('lighting' in patch) map.lighting = oneOf(patch.lighting, LIGHTINGS, map.lighting);
  if ('weather' in patch) setWeather(map, { ...(map.weather || {}), ...(patch.weather && typeof patch.weather === 'object' ? patch.weather : {}) });
  if ('theme' in patch) map.theme = oneOf(patch.theme, THEMES, map.theme);
  if ('fog' in patch) map.fog = !!patch.fog;
  if ('sharedVision' in patch) map.sharedVision = !!patch.sharedVision;
  if ('movementLocked' in patch) map.movementLocked = !!patch.movementLocked;
  if ('metersPerCell' in patch) map.metersPerCell = num(patch.metersPerCell, 0.25, 50, map.metersPerCell);
  if ('background' in patch) {
    const b = patch.background;
    // Partial patches merge into the current background ({ opacity } alone keeps the url, mode, placement).
    const next = b && typeof b === 'object' ? cleanBackground({ ...(map.background || {}), ...b }, map) : null;
    if (next) map.background = next;
    else delete map.background;
  }
}

// ---------------------------------------------------------------------------
// Doors (tile doors in map.doors, segment doors = walls with a `door`)
// ---------------------------------------------------------------------------
/** { type: 'tile', door } | { type: 'wall', wall, door } | null */
export function findAnyDoor(map: GameMap, doorId: unknown): FoundDoor | null {
  const d = map.doors.find((x) => x.id === doorId);
  if (d) return { type: 'tile', door: d };
  const w = (map.walls || []).find((x) => x.id === doorId && x.door);
  if (w) return { type: 'wall', wall: w, door: w.door as WallDoor };
  return null;
}
/** Player reach: a token cell centre within 1.5 cells (Chebyshev) of the door midpoint, or ≤ 1 cell from the segment. */
function tokenNearWallDoor(token: Token, wall: MapWall): boolean {
  const mid = wallMidpoint(wall);
  const s = Math.max(1, token.size | 0 || 1);
  for (let dy = 0; dy < s; dy++)
    for (let dx = 0; dx < s; dx++) {
      const cx = token.x + dx + 0.5, cy = token.y + dy + 0.5;
      if (Math.max(Math.abs(cx - mid.x), Math.abs(cy - mid.y)) <= 1.5 + 1e-9) return true;
      if (pointSegmentDistance(cx, cy, wall.x1, wall.y1, wall.x2, wall.y2) <= 1 + 1e-9) return true;
    }
  return false;
}
function doorSfxOnChange(ctx: ActionContext, before: DoorState, after: DoorState): void {
  if (before === after) return;
  if (before === 'open') sfx(ctx, 'door-close');
  else if (after === 'open') sfx(ctx, 'door-open');
}

/** Lights, regions and notes share the same add / update / remove actions. */
type CrudItem = MapLight | MapRegion | MapNote;
/** { mapId, <light|region|note>: {…} | item } / { mapId, id | <x>Id, patch }: the item key depends on the list. */
type CrudPayload = Loose;

function crudList(
  listKey: 'lights' | 'regions' | 'notes', cleaner: (o: Loose, map: MapSize) => CrudItem, notFound: string, { refresh = false }: { refresh?: boolean } = {},
): Record<'add' | 'update' | 'remove', ActionDef> {
  const listOf = (map: GameMap): CrudItem[] => map[listKey];
  return {
    add: {
      role: 'gm',
      handler(ctx: ActionContext, p: CrudPayload) {
        const map = getMap(ctx, p.mapId);
        const src = p[listKey.slice(0, -1)] || p.item || p;
        const item = cleaner({ ...src, id: undefined }, map);
        listOf(map).push(item);
        if (refresh) refreshFog(ctx.state, map);
        return item.id;
      },
    },
    update: {
      role: 'gm',
      handler(ctx: ActionContext, p: CrudPayload) {
        const map = getMap(ctx, p.mapId);
        const id = p.id ?? p[listKey.slice(0, -1) + 'Id'];
        const cur = findById(ctx, listOf(map), id, notFound);
        const next = cleaner({ ...cur, ...(p.patch || {}), id: cur.id }, map);
        Object.keys(cur).forEach((k) => delete (cur as Loose)[k]);
        Object.assign(cur, next);
        if (refresh) refreshFog(ctx.state, map);
        return cur.id;
      },
    },
    remove: {
      role: 'gm',
      handler(ctx: ActionContext, p: CrudPayload) {
        const map = getMap(ctx, p.mapId);
        const id = p.id ?? p[listKey.slice(0, -1) + 'Id'];
        findById(ctx, listOf(map), id, notFound);
        (map as unknown as Loose)[listKey] = listOf(map).filter((x) => x.id !== id);
        if (refresh) refreshFog(ctx.state, map);
      },
    },
  };
}
const lightsCrud = crudList('lights', cleanLight, tk('Light not found'), { refresh: true });
const regionsCrud = crudList('regions', cleanRegion, tk('Area not found'));
const notesCrud = crudList('notes', cleanNote, tk('Note not found'));

// ---------------------------------------------------------------------------
// Action payloads (validated by the handlers)
// ---------------------------------------------------------------------------
type CreateMapPayload = { width?: unknown; height?: unknown; fill?: unknown; name?: unknown; folder?: unknown; theme?: unknown; lighting?: unknown };
type MapIdPayload = { mapId: MapId };
type UpdateMapPayload = { mapId: MapId; patch?: Loose | null };
type PaintPayload = { mapId: MapId; cells?: unknown };
type SetTilesPayload = { mapId: MapId; tiles?: unknown };
type ResizePayload = { mapId: MapId; width?: unknown; height?: unknown; anchor?: string };
type DuplicateMapPayload = { mapId: MapId; name?: unknown };
type ImportMapPayload = { map?: Loose | null };
type SetActivePayload = { mapId?: MapId | null };
type ResetFogPayload = { mapId: MapId; userId?: UserId };
type AddTokenPayload = { mapId: MapId; token?: Loose | null };
type UpdateTokenPayload = { mapId: MapId; tokenId: string; patch?: Loose | null };
type RemoveTokenPayload = { mapId: MapId; tokenId?: string; tokenIds?: unknown };
type MoveTokenPayload = { mapId: MapId; tokenId: string; x?: unknown; y?: unknown; ignoreWalls?: boolean };
type MoveTokensPayload = { mapId: MapId; moves?: unknown; ignoreWalls?: boolean };
type PlacePCsPayload = { mapId: MapId; x?: unknown; y?: unknown; actorIds?: unknown; move?: boolean };
type DoorPayload = { mapId: MapId; doorId: string };
type SetDoorPayload = { mapId: MapId; doorId: string; state?: unknown; kind?: unknown; name?: unknown };
type AddDoorPayload = { mapId: MapId; door?: Loose | null };
type AddWallPayload = { mapId: MapId; wall?: Loose | null };
type UpdateWallPayload = { mapId: MapId; wallId: string; patch?: Loose | null };
type RemoveWallPayload = { mapId: MapId; wallId?: string; wallIds?: unknown };
type SetWallsPayload = { mapId: MapId; walls?: unknown };
type ToggleLightPayload = { mapId: MapId; lightId: string; on?: unknown };

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
const mod: ServerModule = {
  name: 'maps',

  init(state: TableState, { seedDir }: InitOptions) {
    state.scene ||= { activeMapId: null };
    if (!state.maps || typeof state.maps !== 'object') state.maps = {};
    const dir = path.join(seedDir, 'maps');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (!m || typeof m !== 'object' || !m.id) {
            console.warn(`[maps] seed ${f}: missing id, skipped`);
            continue;
          }
          if (!state.maps[m.id]) state.maps[m.id] = m;
        } catch (err) {
          console.warn(`[maps] seed ${f}: ${(err as Error).message}`);
        }
      }
    }
    for (const [id, m] of Object.entries(state.maps)) {
      if (!m || typeof m !== 'object') {
        delete state.maps[id];
        continue;
      }
      m.id = id;
      normalizeMap(m);
    }
    if (state.scene.activeMapId && !state.maps[state.scene.activeMapId]) state.scene.activeMapId = null;
    if (!state.scene.activeMapId) {
      const first = Object.values(state.maps)[0];
      if (first) state.scene.activeMapId = first.id;
    }
  },

  actions: {
    // ---------------- maps ----------------
    'maps/create': {
      role: 'gm',
      handler(ctx: ActionContext, p: CreateMapPayload) {
        const width = int(p.width, 4, MAX_DIM, 30);
        const height = int(p.height, 4, MAX_DIM, 20);
        // fill: '.' / ',' (floor surrounded by walls), ' ' (void), 'image' (all floor, for illustrated maps with segment walls)
        const fill = p.fill === ',' || p.fill === '.' || p.fill === ' ' || p.fill === 'image' ? p.fill : '.';
        const tiles = Array.from({ length: height }, (_, y: number) =>
          Array.from({ length: width }, (_, x: number) => (fill === ' ' ? ' ' : fill === 'image' ? '.' : x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : fill)).join('')
        );
        const map = normalizeMap({
          id: uid('map'), name: p.name || ctx.t('New map'), folder: p.folder || '', theme: p.theme, lighting: p.lighting,
          width, height, tiles, metersPerCell: 1,
        });
        ctx.state.maps[map.id] = map;
        if (!ctx.state.scene.activeMapId) ctx.state.scene.activeMapId = map.id;
        return map.id;
      },
    },
    'maps/update': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, patch }: UpdateMapPayload) {
        const map = getMap(ctx, mapId);
        patchMapFields(ctx, map, patch);
        refreshFog(ctx.state, map);
      },
    },
    // cells: [{ x, y, ch }]
    'maps/paint': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, cells }: PaintPayload) {
        const map = getMap(ctx, mapId);
        if (!Array.isArray(cells)) ctx.fail('Invalid cells');
        for (const c of cells.slice(0, MAX_DIM * MAX_DIM)) {
          if (!c || !isTileChar(c.ch)) continue;
          setTile(map, c.x | 0, c.y | 0, c.ch);
        }
        dropOrphanDoors(map);
        refreshFog(ctx.state, map);
      },
    },
    // Whole replace of tiles (editor save / import). Rows are padded/truncated to the map width.
    'maps/setTiles': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, tiles }: SetTilesPayload) {
        const map = getMap(ctx, mapId);
        if (!Array.isArray(tiles)) ctx.fail('Invalid tiles');
        map.tiles = Array.from({ length: map.height }, (_, y: number) => cleanRow(tiles[y], map.width));
        dropOrphanDoors(map);
        refreshFog(ctx.state, map);
      },
    },
    // anchor: nw|n|ne|w|c|e|sw|s|se — where the existing content stays.
    'maps/resize': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, width, height, anchor = 'nw' }: ResizePayload) {
        const map = getMap(ctx, mapId);
        const W = int(width, 4, MAX_DIM, map.width);
        const H = int(height, 4, MAX_DIM, map.height);
        const [ax, ay] = ANCHORS[anchor] || ANCHORS.nw;
        const dx = Math.round((W - map.width) * ax);
        const dy = Math.round((H - map.height) * ay);
        const oldW = map.width, oldH = map.height;
        const tiles: string[] = [];
        for (let y = 0; y < H; y++) {
          let row = '';
          for (let x = 0; x < W; x++) {
            const sx = x - dx, sy = y - dy;
            row += sx >= 0 && sy >= 0 && sx < oldW && sy < oldH ? map.tiles[sy][sx] : ' ';
          }
          tiles.push(row);
        }
        const shift = <T extends Point>(o: T): T => ({ ...o, x: o.x + dx, y: o.y + dy });
        const inside = (o: Point) => o.x >= 0 && o.y >= 0 && o.x < W && o.y < H;
        for (const [uidKey, enc] of Object.entries(map.explored)) {
          map.explored[uidKey] = encodeBits(remapBits(decodeBits(enc, oldW * oldH), oldW, oldH, W, H, dx, dy));
        }
        map.width = W;
        map.height = H;
        map.tiles = tiles;
        map.doors = map.doors.map(shift).filter(inside);
        map.lights = map.lights.map(shift).filter(inside);
        map.notes = map.notes.map(shift).filter(inside);
        map.regions = map.regions.map(shift).filter(inside).map((r) => cleanRegion(r, map));
        map.tokens = map.tokens.map((t) => ({ ...shift(t), x: Math.max(0, Math.min(W - 1, t.x + dx)), y: Math.max(0, Math.min(H - 1, t.y + dy)) }));
        for (const t of map.tokens) delete t.lastMove;
        map.walls = (map.walls || []).map((w) => ({ ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }));
        if (map.background) map.background = { ...map.background, x: (map.background.x || 0) + dx, y: (map.background.y || 0) + dy };
        normalizeMap(map);
        refreshFog(ctx.state, map);
      },
    },
    'maps/duplicate': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, name }: DuplicateMapPayload) {
        const src = getMap(ctx, mapId);
        const copy: Loose = deepClone(src);
        copy.id = uid('map');
        copy.name = name ? str(name, 80) : str(ctx.t('{name} (copy)', { name: src.name }), 80); // stored in the table language
        copy.explored = {};
        for (const t of copy.tokens) { t.id = uid('tok'); delete t.lastMove; }
        for (const k of ['doors', 'lights', 'regions', 'notes']) for (const o of copy[k]) o.id = uid(k.slice(0, 3));
        for (const w of copy.walls || []) {
          w.id = uid('wall');
          delete w.foundry;
        }
        delete copy.foundry;
        ctx.state.maps[copy.id] = normalizeMap(copy);
        return copy.id;
      },
    },
    'maps/delete': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId }: MapIdPayload) {
        getMap(ctx, mapId);
        delete ctx.state.maps[mapId];
        if (ctx.state.scene.activeMapId === mapId) {
          const next = Object.values(ctx.state.maps)[0];
          ctx.state.scene.activeMapId = next ? next.id : null;
          if (next) refreshFog(ctx.state, next);
        }
      },
    },
    // Import a map JSON (export format). A new id is assigned if the id is taken.
    'maps/import': {
      role: 'gm',
      handler(ctx: ActionContext, { map }: ImportMapPayload) {
        if (!map || typeof map !== 'object' || !Array.isArray(map.tiles)) ctx.fail('Invalid map file');
        const m: Loose = deepClone(map);
        if (!m.id || ctx.state.maps[m.id]) m.id = uid('map');
        m.explored = {};
        normalizeMap(m);
        ctx.state.maps[m.id] = m as GameMap;
        return m.id;
      },
    },
    'maps/setActive': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId }: SetActivePayload) {
        if (mapId == null) {
          ctx.state.scene.activeMapId = null;
          return;
        }
        const map = getMap(ctx, mapId);
        ctx.state.scene.activeMapId = map.id;
        refreshFog(ctx.state, map);
      },
    },
    'maps/resetFog': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, userId }: ResetFogPayload) {
        const map = getMap(ctx, mapId);
        if (userId) delete map.explored[userId];
        else map.explored = {};
        refreshFog(ctx.state, map);
      },
    },

    // ---------------- tokens ----------------
    'maps/addToken': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, token }: AddTokenPayload) {
        const map = getMap(ctx, mapId);
        if (!token || typeof token !== 'object') ctx.fail('Invalid token');
        const actor = token.actorId ? ctx.state.actors?.[token.actorId] : null;
        if (token.actorId && !actor) ctx.fail('Character not found');
        const base = actor ? tokenFromActor(actor) : {};
        const t = cleanToken({ ...base, ...token, id: undefined }, map);
        map.tokens.push(t);
        refreshFog(ctx.state, map);
        return t.id;
      },
    },
    // GM: any field. Players: only color/img/status/light of their own tokens.
    'maps/updateToken': {
      role: 'any',
      handler(ctx: ActionContext, { mapId, tokenId, patch }: UpdateTokenPayload) {
        const map = getMap(ctx, mapId);
        const tok = getToken(ctx, map, tokenId);
        if (!patch || typeof patch !== 'object') ctx.fail('Invalid change');
        let p = patch;
        if (!ctx.isGM) {
          if (!userOwnsToken(ctx.user, tok)) ctx.fail('This token isn\'t yours');
          p = Object.fromEntries(Object.entries(patch).filter(([k]) => PLAYER_TOKEN_FIELDS.includes(k)));
          if (!Object.keys(p).length) ctx.fail('You can only change your token\'s appearance');
          if ('light' in p) {
            const l = p.light && typeof p.light === 'object' ? p.light : null;
            p.light = l && Number(l.radius) > 0 ? { ...PLAYER_TORCH, color: color(l.color, PLAYER_TORCH.color) } : null;
          }
        }
        const wasHidden = !!tok.hidden;
        const next = cleanToken({ ...tok, ...p, id: tok.id, x: 'x' in p ? p.x : tok.x, y: 'y' in p ? p.y : tok.y }, map);
        for (const k of ['color', 'img', 'vision', 'light', 'status'] as const) if (!(k in next)) delete tok[k];
        Object.assign(tok, next);
        // GM shows a hidden token: reveal its NPC sheet and its initiative entry too (like combat/reveal),
        // otherwise players see the token but not the actor (no health status, damage messages kept GM-only).
        if (ctx.isGM && wasHidden && !tok.hidden) {
          const actor = tok.actorId ? ctx.state.actors?.[tok.actorId] : null;
          if (actor && actor.type !== 'pc' && actor.hidden) actor.hidden = false;
          const c = ctx.state.combat;
          if (c?.active && Array.isArray(c.entries)) {
            for (const e of c.entries) {
              if (e.tokenId === tok.id && e.hidden) {
                e.hidden = false;
                ctx.log({ kind: 'combat', author: 'Initiative', userId: ctx.user.id, i18n: { key: '{name} enters the combat!', params: { name: e.name } } });
              }
            }
          }
        }
        refreshFog(ctx.state, map);
      },
    },
    'maps/removeToken': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, tokenId, tokenIds }: RemoveTokenPayload) {
        const map = getMap(ctx, mapId);
        const ids = new Set(Array.isArray(tokenIds) ? tokenIds : [tokenId]);
        const before = map.tokens.length;
        map.tokens = map.tokens.filter((t) => !ids.has(t.id));
        if (map.tokens.length === before) ctx.fail('Token not found');
        refreshFog(ctx.state, map);
        return before - map.tokens.length;
      },
    },
    // Players: own PC tokens, active map, not locked, reachable. GM: anything (ignoreWalls = teleport).
    'maps/moveToken': {
      role: 'any',
      handler(ctx: ActionContext, { mapId, tokenId, x, y, ignoreWalls }: MoveTokenPayload) {
        const map = getMap(ctx, mapId);
        const tok = getToken(ctx, map, tokenId);
        const res = doMove(ctx, map, tok, x, y, { ignoreWalls: ctx.isGM && !!ignoreWalls });
        refreshFog(ctx.state, map);
        return res;
      },
    },
    // GM: moves: [{ tokenId, x, y }]
    'maps/moveTokens': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, moves, ignoreWalls }: MoveTokensPayload) {
        const map = getMap(ctx, mapId);
        if (!Array.isArray(moves)) ctx.fail('Invalid moves');
        const out: Record<string, ReturnType<typeof doMove>> = {};
        for (const mv of moves.slice(0, 200)) {
          const tok = map.tokens.find((t) => t.id === mv?.tokenId);
          if (!tok) continue;
          out[tok.id] = doMove(ctx, map, tok, mv.x, mv.y, { ignoreWalls: !!ignoreWalls });
        }
        refreshFog(ctx.state, map);
        return out;
      },
    },
    // Drop a token for every active PC not yet on the map, near (x, y) or the entry region / map center.
    'maps/placePCs': {
      role: 'gm',
      // payload: { mapId, x?, y?, actorIds?: [pc ids] (default: every active PC), move?: bool (PCs already on the map are moved to x,y) }
      handler(ctx: ActionContext, { mapId, x, y, actorIds, move }: PlacePCsPayload) {
        const map = getMap(ctx, mapId);
        const only = Array.isArray(actorIds) ? new Set<string>(actorIds.map(String).slice(0, 50)) : null;
        const chosen = Object.values(ctx.state.actors || {}).filter((a) => a && a.type === 'pc' && !a.retired && (!only || only.has(a.id)));
        if (only && !chosen.length) ctx.fail('Character not found');
        const at = x != null && y != null && Number.isFinite(Number(x)) && Number.isFinite(Number(y)) ? { x: Number(x), y: Number(y) } : entryPoint(map);
        if (move && only) {
          // Move the chosen PCs' existing tokens first, then place the missing ones.
          const present = chosen.filter((a) => map.tokens.some((t) => t.actorId === a.id && !t.vehicleId));
          if (present.length) {
            const tokens = present.map((a) => map.tokens.find((t) => t.actorId === a.id && !t.vehicleId) as Token);
            const others = map.tokens.filter((t) => !tokens.includes(t));
            const saved = map.tokens;
            map.tokens = others; // free cells are searched ignoring the tokens being moved
            const spots = freeCellsNear(map, at.x, at.y, tokens.length);
            map.tokens = saved;
            if (!spots.length) ctx.fail('No free cell to place the characters');
            tokens.forEach((t, i) => Object.assign(t, spots[i] || spots[spots.length - 1]));
          }
        }
        const pcs = chosen.filter((a) => !map.tokens.some((t) => t.actorId === a.id && !t.vehicleId));
        if (!pcs.length) {
          refreshFog(ctx.state, map);
          return [];
        }
        const cells = freeCellsNear(map, at.x, at.y, pcs.length);
        if (!cells.length) ctx.fail('No free cell to place the characters');
        const ids: string[] = [];
        pcs.forEach((a, i) => {
          const c = cells[i] || cells[cells.length - 1];
          const t = cleanToken(tokenFromActor(a, { x: c.x, y: c.y }), map);
          map.tokens.push(t);
          ids.push(t.id);
        });
        refreshFog(ctx.state, map);
        return ids;
      },
    },

    // ---------------- doors ----------------
    // Players: unlocked doors within reach of one of their tokens on the shown map. GM: any (locked → open).
    // doorId = a tile door id (map.doors) or a segment door id (map.walls with a door).
    'maps/toggleDoor': {
      role: 'any',
      handler(ctx: ActionContext, { mapId, doorId }: DoorPayload) {
        const map = getMap(ctx, mapId);
        const found = findAnyDoor(map, doorId);
        if (!found) ctx.fail('Door not found');
        const { door } = found;
        if (!ctx.isGM) {
          if (ctx.state.scene?.activeMapId !== map.id) ctx.fail('The GM isn\'t showing this map');
          if (door.kind === 'secret' && door.state !== 'open') ctx.fail('Door not found');
          const mine = map.tokens.filter((t) => userOwnsToken(ctx.user, t));
          if (!mine.length) ctx.fail('You have no token on this map');
          const near = found.type === 'wall' ? (t: Token) => tokenNearWallDoor(t, found.wall) : (t: Token) => chebyshev(t, door as MapDoor) <= 1;
          if (!mine.some(near)) ctx.fail('Get closer to the door to open it');
          if (door.state === 'locked') {
            sfx(ctx, 'door-locked');
            ctx.fail('It\'s locked.');
          }
        }
        if (door.state === 'open') {
          if (found.type === 'tile' && map.tokens.some((t) => t.x === (door as MapDoor).x && t.y === (door as MapDoor).y)) ctx.fail('Something is blocking the door');
          door.state = 'closed';
          sfx(ctx, 'door-close');
        } else {
          door.state = 'open';
          sfx(ctx, 'door-open');
        }
        refreshFog(ctx.state, map);
        return door.state;
      },
    },
    // GM: { mapId, doorId, state?, kind?, name? }
    'maps/setDoor': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, doorId, state, kind, name }: SetDoorPayload) {
        const map = getMap(ctx, mapId);
        const found = findAnyDoor(map, doorId);
        if (!found) ctx.fail('Door not found');
        const { door } = found;
        if (state !== undefined) {
          const next = oneOf(state, DOOR_STATES, door.state);
          const before = door.state;
          door.state = next;
          doorSfxOnChange(ctx, before, next);
        }
        if (kind !== undefined) (door as MapDoor).kind = oneOf<DoorKind>(kind, found.type === 'wall' ? WALL_DOOR_KINDS : DOOR_KINDS, door.kind);
        if (name !== undefined) {
          if (name) door.name = str(name, 60);
          else delete door.name;
        }
        refreshFog(ctx.state, map);
        return found.type === 'wall' ? found.wall.id : (door as MapDoor).id;
      },
    },
    // { mapId, door: { x, y, state?, kind?, name? } } — replaces a door already on that cell; sets the tile to 'D'.
    'maps/addDoor': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, door }: AddDoorPayload) {
        const map = getMap(ctx, mapId);
        if (!door) ctx.fail('Invalid door');
        const c = cellArg(ctx, map, door.x, door.y);
        map.doors = map.doors.filter((d) => !(d.x === c.x && d.y === c.y));
        const d = cleanDoor({ ...door, ...c, id: undefined }, map);
        map.doors.push(d);
        setTile(map, c.x, c.y, 'D');
        refreshFog(ctx.state, map);
        return d.id;
      },
    },
    // Removes the door (the cell stays an open doorway 'D').
    'maps/removeDoor': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, doorId }: DoorPayload) {
        const map = getMap(ctx, mapId);
        findById(ctx, map.doors, doorId, tk('Door not found'));
        map.doors = map.doors.filter((d) => d.id !== doorId);
        refreshFog(ctx.state, map);
      },
    },

    // ---------------- segment walls ----------------
    // { mapId, wall: { x1, y1, x2, y2, move?, sight?, door?: { state, kind, name? } | null, id? } } → id
    'maps/addWall': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, wall }: AddWallPayload) {
        const map = getMap(ctx, mapId);
        if (map.walls.length >= MAX_WALLS) ctx.fail('Too many walls on this map');
        const w = cleanWall({ ...(wall || {}), id: wall?.id && !map.walls.some((x) => x.id === wall.id) ? wall.id : undefined });
        if (!w) ctx.fail('Invalid wall');
        map.walls.push(w);
        refreshFog(ctx.state, map);
        return w.id;
      },
    },
    // { mapId, wallId, patch } — patch any of x1/y1/x2/y2/move/sight/door (door: null removes the door).
    'maps/updateWall': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, wallId, patch }: UpdateWallPayload) {
        const map = getMap(ctx, mapId);
        const cur = findById(ctx, map.walls, wallId, tk('Wall not found'));
        if (!patch || typeof patch !== 'object') ctx.fail('Invalid change');
        const p: Loose = { ...patch };
        if (p.door && typeof p.door === 'object' && cur.door) p.door = { ...cur.door, ...p.door };
        const next = cleanWall({ ...cur, ...p, id: cur.id });
        if (!next) ctx.fail('Invalid wall');
        const before = cur.door?.state;
        Object.keys(cur).forEach((k) => delete (cur as Loose)[k]);
        Object.assign(cur, next);
        if (before && cur.door) doorSfxOnChange(ctx, before, cur.door.state);
        refreshFog(ctx.state, map);
        return cur.id;
      },
    },
    // { mapId, wallId } or { mapId, wallIds: [] } → number removed
    'maps/removeWall': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, wallId, wallIds }: RemoveWallPayload) {
        const map = getMap(ctx, mapId);
        const ids = new Set(Array.isArray(wallIds) ? wallIds : [wallId]);
        const before = map.walls.length;
        map.walls = map.walls.filter((w) => !ids.has(w.id));
        if (map.walls.length === before) ctx.fail('Wall not found');
        refreshFog(ctx.state, map);
        return before - map.walls.length;
      },
    },
    // Editor bulk save: replaces every wall (ids kept when valid & unique).
    'maps/setWalls': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, walls }: SetWallsPayload) {
        const map = getMap(ctx, mapId);
        if (!Array.isArray(walls)) ctx.fail('Invalid walls');
        map.walls = cleanWalls(walls);
        refreshFog(ctx.state, map);
        return map.walls.length;
      },
    },

    // ---------------- lights ----------------
    'maps/addLight': lightsCrud.add, // { mapId, light: { x, y, radius, color, on } } → id
    'maps/updateLight': lightsCrud.update, // { mapId, lightId, patch }
    'maps/removeLight': lightsCrud.remove, // { mapId, lightId }
    'maps/toggleLight': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, lightId, on }: ToggleLightPayload) {
        const map = getMap(ctx, mapId);
        const l = findById(ctx, map.lights, lightId, tk('Light not found'));
        l.on = typeof on === 'boolean' ? on : !l.on;
        refreshFog(ctx.state, map);
        return l.on;
      },
    },

    // ---------------- regions & notes ----------------
    'maps/addRegion': regionsCrud.add, // { mapId, region: { name, x, y, w, h, color?, gmOnly? } } → id
    'maps/updateRegion': regionsCrud.update, // { mapId, regionId, patch }
    'maps/removeRegion': regionsCrud.remove, // { mapId, regionId }
    'maps/addNote': notesCrud.add, // { mapId, note: { x, y, text } } → id
    'maps/updateNote': notesCrud.update, // { mapId, noteId, patch }
    'maps/removeNote': notesCrud.remove, // { mapId, noteId }
  },

  // Players only get the shown map, masked to what they know, without GM data.
  filter(view: GameView, user: SessionUser, state: TableState) {
    const id = state.scene?.activeMapId;
    const full = id ? state.maps?.[id] : null;
    const vm = full && id ? view.maps?.[id] : null;
    view.maps = {};
    if (!id || !full || !vm) return;
    view.maps[id] = vm;
    const { width: w, height: h } = full;
    const n = w * h;
    const fogOn = full.fog !== false;
    // Whose eyes: the user's own characters; a table display looks through the party or one chosen PC, with their
    // explored cells (shared/display.ts). It owns no token, so everything below treats it as any other player.
    const eyes = user.role === 'display' ? displayEyes(state, user.display) : { characterIds: user.characterIds, exploredBy: [user.id] };
    const { visible } = visibilityForUser(full, eyes, state.actors, visionContext(full), effectsLookup());
    const known = new Uint8Array(n);
    if (fogOn) for (const uid of eyes.exploredBy) orBits(known, decodeBits(full.explored?.[uid], n));
    else known.fill(1);
    orBits(known, visible);

    // Tiles: unknown cells become void; closed secret doors become walls.
    const hiddenDoors = new Set(full.doors.filter((d) => d.kind === 'secret' && d.state !== 'open').map((d) => d.y * w + d.x));
    vm.tiles = full.tiles.map((row, y) => {
      let s = '';
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        s += !known[i] ? ' ' : hiddenDoors.has(i) ? '#' : row[x];
      }
      return s;
    });
    vm.doors = full.doors
      .filter((d) => !hiddenDoors.has(d.y * w + d.x) && known[d.y * w + d.x])
      .map((d) => ({ id: d.id, x: d.x, y: d.y, state: d.state === 'locked' ? 'closed' : d.state, kind: d.kind === 'secret' ? 'door' : d.kind, ...(d.name ? { name: d.name } : {}) }));
    vm.walls = playerWalls(full, known);
    // Only lights whose glow reaches a known cell, without their (GM) names.
    vm.lights = full.lights
      .filter((l) => {
        if (l.on === false) return false;
        const r = Math.ceil(Number(l.radius) || 0) + 1;
        const lx = Math.round(Number(l.x) || 0), ly = Math.round(Number(l.y) || 0);
        for (let y = Math.max(0, ly - r); y <= Math.min(h - 1, ly + r); y++)
          for (let x = Math.max(0, lx - r); x <= Math.min(w - 1, lx + r); x++) if (known[y * w + x]) return true;
        return false;
      })
      .map(({ name, ...l }) => ({ ...l }));
    vm.regions = full.regions.filter((r) => {
      if (r.gmOnly) return false;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (known[y * w + x]) return true;
      return false;
    });
    vm.notes = [];
    delete vm.description;
    vm.tokens = vm.tokens
      .filter((t) => userOwnsToken(user, t) || (!t.hidden && tokenInMask(t, visible, w, h)))
      .map((t) => {
        if (!userOwnsToken(user, t)) {
          delete t.vision;
          if (t.lastMove?.path) {
            // Only reveal the visible tail of another token's last move.
            let k = t.lastMove.path.length;
            while (k > 0 && visible[t.lastMove.path[k - 1][1] * w + t.lastMove.path[k - 1][0]]) k--;
            t.lastMove = { ...t.lastMove, path: t.lastMove.path.slice(k) };
          }
        }
        return t;
      });
    vm.explored = { [user.id]: encodeBits(known) };
    vm.visible = encodeBits(visible);
  },
};

export default mod;
