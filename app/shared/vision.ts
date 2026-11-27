// Map rules shared by the server and the browser (pure ES module, no Node or DOM APIs):
// tile legend, line of sight (symmetric shadowcasting + segment walls), lighting, path finding, fog-of-war bitsets.
//
// Conventions
// - Cells are integer (x, y), index = y * width + x. Out-of-bounds cells behave as void (block everything).
// - Distances for sight/light ranges are Euclidean between cell centers, with a half-cell tolerance.
// - Movement: 8 directions, a diagonal step costs 1.5 cells (the classic "1-2-1-2" grid approximation of √2),
//   so pathLength() returns meters = (orthogonal steps + 1.5 × diagonal steps) × metersPerCell.
//   No diagonal corner-cutting: a diagonal step needs both orthogonal neighbours free of walls/obstacles.
// - Segment walls (map.walls, Foundry-style, coordinates in cell units, origin = top-left corner of the grid)
//   block sight / light when `sight` and not an open door, movement when `move` and not an open door.
//   A cell is in line of sight when it passes the tile shadowcasting AND at least one sample ray from the
//   viewer's cell centre to the target cell (centre + 4 inset corners) crosses no blocking segment.
//   A step between two adjacent cells is blocked when the centre-to-centre segment touches a blocking
//   segment (endpoints included, so walls meeting at a cell corner also stop diagonal squeezing).

import type { ActorLike, DoorState, Lighting, MapDoor, MapWall, Point, Token, TokenVision } from './types.ts';

/** One tile of the legend. */
export interface TileInfo {
  fr: string;
  blockMove: boolean;
  blockSight: boolean;
}
/** Door fields the rules read (tile doors, segment-wall doors). */
export interface VisionDoor {
  x?: number;
  y?: number;
  state?: DoorState | (string & {});
  kind?: string;
}
/** Segment wall fields the rules read (a MapWall, a library wall…). */
export interface VisionWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  move?: boolean;
  sight?: boolean;
  door?: VisionDoor | null;
}
/** Token fields the rules read. */
export type VisionToken = Pick<Token, 'x' | 'y'> & Partial<Omit<Token, 'x' | 'y'>>;
/** Light source fields the rules read. */
export interface VisionLight {
  id?: string;
  x: number;
  y: number;
  radius: number;
  color?: string;
  on?: boolean;
}
/** Map fields the rules read (a GameMap, a home map, a library version with a size…). */
export interface VisionMap {
  width: number;
  height: number;
  tiles?: string[] | null;
  doors?: Array<Pick<MapDoor, 'x' | 'y'> & VisionDoor> | null;
  walls?: VisionWall[] | null;
  lights?: VisionLight[] | null;
  tokens?: VisionToken[] | null;
  lighting?: Lighting;
  sharedVision?: boolean;
  fog?: boolean;
}
/** Actors by id, as the vision rules read them (state.actors, a view's actors). */
export type VisionActors = Record<string, ActorLike | null | undefined>;
/** Spatial index of the blocking segments (buildSegIndex). */
export interface SegIndex {
  n: number;
  /** x1, y1, x2, y2 of each segment. */
  c: Float64Array;
  /** Per cell: indices of the segments touching it. */
  cells: Array<number[] | null>;
  w: number;
  h: number;
  stamp: Uint32Array;
  mark: number;
  walls: VisionWall[];
}
/** Precomputed blocking grids of a map (buildGrid). */
export interface VisionGrid {
  w: number;
  h: number;
  n: number;
  move: Uint8Array;
  sight: Uint8Array;
  doors: Map<number, VisionDoor>;
  sightSegs: SegIndex | null;
  steps: Uint8Array | null;
}
/** Resolved vision of a token (tokenVision). */
export interface ResolvedVision {
  lowLight: boolean;
  thermo: boolean;
  darkRange: number;
}
/** A light source of a map (mapLights): a map light that is on, or a token's light. */
export interface LightSource {
  x: number;
  y: number;
  radius: number;
  color: string;
  id?: string;
  tokenId?: string;
}
/** Per-viewer-cell LOS data (tile FOV + memoised segment checks). */
interface LosEntry {
  tile: Uint8Array;
  memo: Uint8Array | null;
}
/** Viewer-independent lighting data (createVisionContext). */
export interface VisionContext {
  grid: VisionGrid;
  litRatio: Float32Array;
  lights: LightSource[];
  losCache: Map<number, LosEntry>;
}
/** Options of findPath(). */
export interface FindPathOptions {
  blockers?: Iterable<Point | number> | null;
  occupied?: Iterable<Point | number> | null;
  allowed?: ArrayLike<number> | null;
  ignoreWalls?: boolean;
  grid?: VisionGrid | null;
  maxCost?: number;
}

/** Tile legend. blockMove / blockSight follow ARCHITECTURE.md. fr = French label for editors. */
export const TILE_INFO: Record<string, TileInfo> = {
  ' ': { fr: 'Vide (hors carte)', blockMove: true, blockSight: true },
  '.': { fr: 'Sol intérieur', blockMove: false, blockSight: false },
  ',': { fr: 'Sol extérieur / rue', blockMove: false, blockSight: false },
  '#': { fr: 'Mur', blockMove: true, blockSight: true },
  D: { fr: 'Porte / passage', blockMove: false, blockSight: false }, // real state comes from doors[]
  W: { fr: 'Fenêtre', blockMove: true, blockSight: false },
  '=': { fr: 'Comptoir / muret / rambarde', blockMove: true, blockSight: false },
  T: { fr: 'Table / mobilier', blockMove: true, blockSight: false },
  c: { fr: 'Caisses / couvert', blockMove: true, blockSight: false },
  o: { fr: 'Pilier / colonne', blockMove: true, blockSight: true },
  m: { fr: 'Machines / serveurs / étagères', blockMove: true, blockSight: true },
  v: { fr: 'Véhicule', blockMove: true, blockSight: false },
  b: { fr: 'Lit / canapé', blockMove: true, blockSight: false },
  s: { fr: 'Escalier / rampe', blockMove: false, blockSight: false },
  e: { fr: 'Ascenseur', blockMove: false, blockSight: false },
  '~': { fr: 'Eau', blockMove: true, blockSight: false },
  g: { fr: 'Herbe / végétation', blockMove: false, blockSight: false },
  r: { fr: 'Gravats (terrain difficile)', blockMove: false, blockSight: false },
  x: { fr: 'Danger (feu, chimie, électricité)', blockMove: false, blockSight: false },
  t: { fr: 'Arbres / buissons denses', blockMove: false, blockSight: true },
  _: { fr: 'Tapis / scène / piste de danse', blockMove: false, blockSight: false },
};
export const TILE_CHARS = Object.keys(TILE_INFO);
export const isTileChar = (ch: string): boolean => Object.prototype.hasOwnProperty.call(TILE_INFO, ch);

/** Ambient ranges (cells). */
export const DIM_RANGE = 12;
export const DARK_TOUCH_RANGE = 1; // in total darkness you still make out adjacent cells
export const THERMO_RANGE = 10;
export const DIAGONAL_COST = 1.5;

const inBounds = (map: Pick<VisionMap, 'width' | 'height'>, x: number, y: number): boolean => x >= 0 && y >= 0 && x < (map.width | 0) && y < (map.height | 0);

export function tileAt(map: VisionMap, x: number, y: number): string {
  if (!inBounds(map, x, y)) return ' ';
  const ch = (map.tiles?.[y] || '')[x];
  return ch === undefined ? ' ' : ch;
}

export function doorAt<M extends VisionMap>(map: M, x: number, y: number): NonNullable<M['doors']>[number] | null {
  for (const d of map.doors || []) if (d.x === x && d.y === y) return d;
  return null;
}

function cellBlocks(ch: string, door: VisionDoor | null | undefined, key: 'blockMove' | 'blockSight'): boolean {
  if (door) return door.state !== 'open'; // closed / locked (secret doors included) block both
  const info = TILE_INFO[ch];
  return info ? info[key] : false;
}

/** True if (x, y) can't be walked through (walls, closed doors, furniture, void…). */
export function blocksMove(map: VisionMap, x: number, y: number): boolean {
  if (!inBounds(map, x, y)) return true;
  return cellBlocks(tileAt(map, x, y), doorAt(map, x, y), 'blockMove');
}

/** True if (x, y) blocks line of sight. */
export function blocksSight(map: VisionMap, x: number, y: number): boolean {
  if (!inBounds(map, x, y)) return true;
  return cellBlocks(tileAt(map, x, y), doorAt(map, x, y), 'blockSight');
}

// ---------------------------------------------------------------------------
// Segment walls
// ---------------------------------------------------------------------------
const SEG_EPS = 1e-7;
const SIGHT_SAMPLES: Array<[number, number]> = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]];
const STEP_E = 1, STEP_S = 2, STEP_SE = 4, STEP_SW = 8;

export const wallIsDoor = (w: VisionWall | null | undefined): w is VisionWall & { door: VisionDoor } => !!(w && w.door && typeof w.door === 'object');
export const wallIsOpenDoor = (w: VisionWall | null | undefined): boolean => wallIsDoor(w) && w.door.state === 'open';
/** Segment blocks sight / light right now (sight wall, or a door that is not open). */
export const wallBlocksSight = (w: VisionWall | null | undefined): boolean => !!w && w.sight !== false && !wallIsOpenDoor(w);
/** Segment blocks movement right now. */
export const wallBlocksMove = (w: VisionWall | null | undefined): boolean => !!w && w.move !== false && !wallIsOpenDoor(w);
export const wallMidpoint = (w: VisionWall): Point => ({ x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 });
const segOk = (w: VisionWall | null | undefined) => w && Number.isFinite(w.x1) && Number.isFinite(w.y1) && Number.isFinite(w.x2) && Number.isFinite(w.y2) && (w.x1 !== w.x2 || w.y1 !== w.y2);

/** Euclidean distance from point P to segment AB. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Closest wall to (x, y) within maxDist (cells), optionally filtered. → { wall, dist } | null */
export function nearestWall<W extends VisionWall>(
  walls: W[] | null | undefined,
  x: number,
  y: number,
  maxDist = Infinity,
  filter: ((w: W) => boolean) | null = null,
): { wall: W; dist: number } | null {
  let best: { wall: W; dist: number } | null = null;
  for (const w of walls || []) {
    if (!segOk(w) || (filter && !filter(w))) continue;
    const d = pointSegmentDistance(x, y, w.x1, w.y1, w.x2, w.y2);
    if (d <= maxDist && (!best || d < best.dist)) best = { wall: w, dist: d };
  }
  return best;
}

/**
 * True if segment A→B (restricted to parameter t ∈ [tMin, 1]) touches segment C→D, endpoints included.
 * Collinear overlapping segments count as touching.
 */
export function segmentsTouch(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, tMin = 0): boolean {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const qx = cx - ax, qy = cy - ay;
  const den = rx * sy - ry * sx;
  const scale = Math.abs(rx) + Math.abs(ry) + Math.abs(sx) + Math.abs(sy);
  if (Math.abs(den) <= 1e-12 * scale * scale) {
    // parallel: blocking only when collinear and overlapping
    if (Math.abs(qx * ry - qy * rx) > 1e-9 * scale * scale) return false;
    const rr = rx * rx + ry * ry;
    if (!rr) return false;
    const t0 = (qx * rx + qy * ry) / rr, t1 = t0 + (sx * rx + sy * ry) / rr;
    return Math.max(t0, t1) >= tMin - SEG_EPS && Math.min(t0, t1) <= 1 + SEG_EPS;
  }
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= tMin - SEG_EPS && t <= 1 + SEG_EPS && u >= -1e-6 && u <= 1 + 1e-6;
}

/** Liang–Barsky: does segment P1P2 touch the closed box [x0,x1]×[y0,y1]? */
function segTouchesBox(px1: number, py1: number, px2: number, py2: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = px2 - px1, dy = py2 - py1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, px1 - x0) && clip(dx, x1 - px1) && clip(-dy, py1 - y0) && clip(dy, y1 - py1) && t0 <= t1;
}

/** Spatial index of the blocking segments: per-cell lists of segment indices (cells the segment touches). */
function buildSegIndex(walls: VisionWall[] | null | undefined, w: number, h: number, pred: (w: VisionWall) => boolean): SegIndex | null {
  const list: VisionWall[] = [];
  for (const wl of walls || []) if (segOk(wl) && pred(wl)) list.push(wl);
  if (!list.length || !w || !h) return null;
  const n = list.length;
  const c = new Float64Array(n * 4);
  const cells: Array<number[] | null> = new Array(w * h).fill(null);
  const pad = 1e-6;
  list.forEach((wl, i) => {
    c[i * 4] = wl.x1; c[i * 4 + 1] = wl.y1; c[i * 4 + 2] = wl.x2; c[i * 4 + 3] = wl.y2;
    const gx0 = Math.max(0, Math.floor(Math.min(wl.x1, wl.x2) - pad)), gx1 = Math.min(w - 1, Math.floor(Math.max(wl.x1, wl.x2) + pad));
    const gy0 = Math.max(0, Math.floor(Math.min(wl.y1, wl.y2) - pad)), gy1 = Math.min(h - 1, Math.floor(Math.max(wl.y1, wl.y2) + pad));
    for (let y = gy0; y <= gy1; y++)
      for (let x = gx0; x <= gx1; x++) {
        if (!segTouchesBox(wl.x1, wl.y1, wl.x2, wl.y2, x - pad, y - pad, x + 1 + pad, y + 1 + pad)) continue;
        const k = y * w + x;
        (cells[k] ||= []).push(i);
      }
  });
  return { n, c, cells, w, h, stamp: new Uint32Array(n), mark: 0, walls: list };
}

/** True if the ray A→B (t ∈ [tMin, 1]) touches an indexed segment. Walks the cells the ray crosses (DDA). */
function rayBlocked(idx: SegIndex, ax: number, ay: number, bx: number, by: number, tMin = 1e-6): boolean {
  const { w, h, cells, c, stamp } = idx;
  if (++idx.mark >= 0xfffffff0) {
    stamp.fill(0);
    idx.mark = 1;
  }
  const mark = idx.mark;
  let cx = Math.floor(ax), cy = Math.floor(ay);
  const dx = bx - ax, dy = by - ay;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity, tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (cx + 1 - ax) / dx : stepX < 0 ? (cx - ax) / dx : Infinity;
  let tMaxY = stepY > 0 ? (cy + 1 - ay) / dy : stepY < 0 ? (cy - ay) / dy : Infinity;
  for (let guard = 2 * (w + h) + 8; guard > 0; guard--) {
    if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
      const lst = cells[cy * w + cx];
      if (lst)
        for (let k = 0; k < lst.length; k++) {
          const s = lst[k];
          if (stamp[s] === mark) continue;
          stamp[s] = mark;
          const o = s * 4;
          if (segmentsTouch(ax, ay, bx, by, c[o], c[o + 1], c[o + 2], c[o + 3], tMin)) return true;
        }
    }
    if (tMaxX > 1 && tMaxY > 1) break;
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      cx += stepX;
    } else {
      tMaxY += tDeltaY;
      cy += stepY;
    }
  }
  return false;
}

/** Segment-only visibility of cell (x, y) from the centre of cell (ox, oy). */
function cellSegVisible(idx: SegIndex | null, ox: number, oy: number, x: number, y: number): boolean {
  if (!idx || (x === ox && y === oy)) return true;
  const ax = ox + 0.5, ay = oy + 0.5;
  for (const [sx, sy] of SIGHT_SAMPLES) if (!rayBlocked(idx, ax, ay, x + sx, y + sy)) return true;
  return false;
}

/** Blocked steps between adjacent cells: bits E/S/SE/SW stored on the origin cell. null when no move-blocking segment. */
function buildStepMask(walls: VisionWall[] | null | undefined, w: number, h: number): Uint8Array | null {
  const segs = (walls || []).filter((wl) => segOk(wl) && wallBlocksMove(wl));
  if (!segs.length || !w || !h) return null;
  const steps = new Uint8Array(w * h);
  const DIRS: Array<[number, number, number]> = [[1, 0, STEP_E], [0, 1, STEP_S], [1, 1, STEP_SE], [-1, 1, STEP_SW]];
  for (const wl of segs) {
    const x0 = Math.max(0, Math.floor(Math.min(wl.x1, wl.x2)) - 2), x1 = Math.min(w - 1, Math.floor(Math.max(wl.x1, wl.x2)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(wl.y1, wl.y2)) - 2), y1 = Math.min(h - 1, Math.floor(Math.max(wl.y1, wl.y2)) + 1);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        for (const [dx, dy, bit] of DIRS) {
          if (steps[i] & bit) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (segmentsTouch(x + 0.5, y + 0.5, nx + 0.5, ny + 0.5, wl.x1, wl.y1, wl.x2, wl.y2, 0)) steps[i] |= bit;
        }
      }
  }
  return steps;
}

/** True if a segment wall blocks the step (x, y) → (x + dx, y + dy) (|dx|, |dy| ≤ 1). Bounds are not checked. */
export function stepBlocked(grid: Pick<VisionGrid, 'w' | 'steps'> | null | undefined, x: number, y: number, dx: number, dy: number): boolean {
  const s = grid?.steps;
  if (!s || (!dx && !dy)) return false;
  const w = grid!.w;
  if (dy === 0) return !!(s[y * w + (dx > 0 ? x : x - 1)] & STEP_E);
  if (dx === 0) return !!(s[(dy > 0 ? y : y - 1) * w + x] & STEP_S);
  if (dx === dy) return !!(s[(dy > 0 ? y * w + x : (y - 1) * w + x - 1)] & STEP_SE);
  return !!(s[(dy > 0 ? y * w + x : (y - 1) * w + x + 1)] & STEP_SW);
}

/** Convenience: can a token step from cell a to the adjacent cell b (tiles + segment walls, no corner cutting)? */
export function canStep(map: VisionMap, a: Point, b: Point, grid: VisionGrid | null = null): boolean {
  const g = grid || buildGrid(map);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  if (b.x < 0 || b.y < 0 || b.x >= g.w || b.y >= g.h || g.move[b.y * g.w + b.x]) return false;
  if (dx && dy && (g.move[a.y * g.w + b.x] || g.move[b.y * g.w + a.x])) return false;
  return !stepBlocked(g, a.x, a.y, dx, dy);
}

/**
 * Precomputed blocking grids for a map:
 * { w, h, n, move, sight, doors: Map(index -> door), sightSegs: index|null, steps: Uint8Array|null }.
 */
export function buildGrid(map: VisionMap): VisionGrid {
  const w = Math.max(0, map.width | 0);
  const h = Math.max(0, map.height | 0);
  const n = w * h;
  const move = new Uint8Array(n);
  const sight = new Uint8Array(n);
  const doors = new Map<number, VisionDoor>();
  for (const d of map.doors || []) if (d && inBounds(map, d.x, d.y)) doors.set(d.y * w + d.x, d);
  for (let y = 0; y < h; y++) {
    const row = map.tiles?.[y] || '';
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ch = row[x] === undefined ? ' ' : row[x];
      const door = doors.get(i);
      move[i] = cellBlocks(ch, door, 'blockMove') ? 1 : 0;
      sight[i] = cellBlocks(ch, door, 'blockSight') ? 1 : 0;
    }
  }
  const walls = Array.isArray(map.walls) ? map.walls : null;
  const sightSegs = walls?.length ? buildSegIndex(walls, w, h, wallBlocksSight) : null;
  const steps = walls?.length ? buildStepMask(walls, w, h) : null;
  return { w, h, n, move, sight, doors, sightSegs, steps };
}

/**
 * Cells in line of sight from (ox, oy), tiles AND segment walls. Returns a Uint8Array (1 = in LOS).
 * maxDepth limits the tile scan (Chebyshev rows); segment rays are only cast for cells the tiles let through.
 */
export function lineOfSightMask(grid: VisionGrid, ox: number, oy: number, maxDepth = Infinity, out: Uint8Array | null = null): Uint8Array {
  out = fieldOfView(grid, ox, oy, maxDepth, out);
  const idx = grid.sightSegs;
  if (!idx || ox < 0 || oy < 0 || ox >= grid.w || oy >= grid.h) return out;
  const { w, h } = grid;
  const lim = Number.isFinite(maxDepth) ? maxDepth : Math.max(w, h);
  const x0 = Math.max(0, ox - lim), x1 = Math.min(w - 1, ox + lim), y0 = Math.max(0, oy - lim), y1 = Math.min(h - 1, oy + lim);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (out[i] && !cellSegVisible(idx, ox, oy, x, y)) out[i] = 0;
    }
  return out;
}

// ---------------------------------------------------------------------------
// Field of view: symmetric shadowcasting (Albert Ford), exact integer slopes.
// Walls are revealed when one of their faces is seen; floors only when symmetric.
// ---------------------------------------------------------------------------

/**
 * Cells in line of sight from (ox, oy). Returns a Uint8Array (1 = in LOS).
 * maxDepth limits the scan (in rows, i.e. Chebyshev distance) for speed.
 */
export function fieldOfView(grid: Pick<VisionGrid, 'w' | 'h' | 'sight'>, ox: number, oy: number, maxDepth = Infinity, out: Uint8Array | null = null): Uint8Array {
  const { w, h, sight } = grid;
  if (!out) out = new Uint8Array(w * h);
  if (ox < 0 || oy < 0 || ox >= w || oy >= h) return out;
  out[oy * w + ox] = 1;
  const limit = Math.min(maxDepth, Math.max(w, h));
  for (let q = 0; q < 4; q++) {
    const scan = (depth: number, sn: number, sd: number, en: number, ed: number): void => {
      if (depth > limit) return;
      const minCol = Math.floor((2 * depth * sn + sd) / (2 * sd)); // round ties up (depth * start)
      const maxCol = Math.ceil((2 * depth * en - ed) / (2 * ed)); // round ties down (depth * end)
      let prev = -1; // -1 none, 0 floor, 1 wall
      for (let col = minCol; col <= maxCol; col++) {
        let x: number, y: number;
        if (q === 0) { x = ox + col; y = oy - depth; }
        else if (q === 1) { x = ox + depth; y = oy + col; }
        else if (q === 2) { x = ox + col; y = oy + depth; }
        else { x = ox - depth; y = oy + col; }
        const inside = x >= 0 && y >= 0 && x < w && y < h;
        const wall = !inside || sight[y * w + x] === 1;
        if (inside && (wall || (col * sd >= depth * sn && col * ed <= depth * en))) out[y * w + x] = 1;
        if (prev === 1 && !wall) { sn = 2 * col - 1; sd = 2 * depth; }
        if (prev === 0 && wall) scan(depth + 1, sn, sd, 2 * col - 1, 2 * depth);
        prev = wall ? 1 : 0;
      }
      if (prev === 0) scan(depth + 1, sn, sd, en, ed);
    };
    scan(1, -1, 1, 1, 1);
  }
  return out;
}

/** Line of sight between two cells (symmetric for floors). */
export function hasLineOfSight(map: VisionMap, from: Point, to: Point, grid: VisionGrid | null = null): boolean {
  const g = grid || buildGrid(map);
  const dist = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  const los = fieldOfView(g, from.x, from.y, dist);
  if (!los[to.y * g.w + to.x]) return false;
  return cellSegVisible(g.sightSegs, from.x, from.y, to.x, to.y);
}

// ---------------------------------------------------------------------------
// Vision of a token
// ---------------------------------------------------------------------------
const LOWLIGHT_RE = /low[\s-]?light|nocturne|faible lumi|basse lumi|lumi[eè]re faible/i;
const THERMO_RE = /thermo|infra[\s-]?rouge|infra[\s-]?red/i;
const LOWLIGHT_META: string[] = ['elfe', 'elf', 'ork', 'orc'];
const THERMO_META: string[] = ['nain', 'dwarf', 'troll'];

/** { lowLight, thermo, darkRange } for a token, from token.vision, actor.vision, metatype, qualities and 'ware names. */
export function tokenVision(token: { vision?: TokenVision | null } | null | undefined, actor?: ActorLike | null): ResolvedVision {
  const tv: TokenVision = token?.vision || {};
  const av: TokenVision = actor?.vision || {};
  const meta = String(actor?.metatype || '').trim().toLowerCase();
  const names = [...(actor?.qualities || []), ...(actor?.augmentations || []), ...(actor?.powers || [])]
    .map((q: { name?: string } | null) => (q && q.name) || '')
    .join(' | ');
  const pick = (a: unknown, b: unknown, derived: boolean): unknown => (typeof a === 'boolean' ? a : typeof b === 'boolean' ? b : derived);
  const lowLight = pick(tv.lowLight, av.lowLight, LOWLIGHT_META.includes(meta) || LOWLIGHT_RE.test(names));
  const thermo = pick(tv.thermo, av.thermo, THERMO_META.includes(meta) || THERMO_RE.test(names));
  const rawRange: unknown = tv.darkRange ?? av.darkRange; // may be '' in stored data
  const darkRange = rawRange != null && rawRange !== '' && !Number.isNaN(Number(rawRange)) ? Math.max(0, Number(rawRange)) : thermo ? THERMO_RANGE : 0;
  return { lowLight: !!lowLight, thermo: !!thermo, darkRange };
}

/** Tokens that count as player characters (party vision). */
export function isPcToken(token: VisionToken | null | undefined, actors: VisionActors | null | undefined): boolean {
  return token?.disposition === 'pc' || actors?.[token?.actorId as string]?.type === 'pc';
}

/**
 * Tokens whose eyes a user looks through on this map:
 * their own tokens, plus every PC token when map.sharedVision is on.
 */
export function viewersForUser<T extends VisionToken>(
  map: { tokens?: T[] | null; sharedVision?: boolean } | null | undefined,
  user: { characterIds?: string[] | null } | null | undefined,
  actors: VisionActors | null | undefined,
): T[] {
  const own = new Set(user?.characterIds || []);
  const shared = map?.sharedVision !== false;
  return (map?.tokens || []).filter((t) => (t.actorId && own.has(t.actorId)) || (shared && isPcToken(t, actors)));
}

/** All light sources of a map: lights[] that are on + token lights. */
export function mapLights(map: Pick<VisionMap, 'lights' | 'tokens'>): LightSource[] {
  const out: LightSource[] = [];
  for (const l of map.lights || []) if (l && l.on !== false && Number(l.radius) > 0) out.push({ x: l.x | 0, y: l.y | 0, radius: Number(l.radius), color: l.color || '#ffcc88', id: l.id });
  for (const t of map.tokens || []) {
    const r = Number(t?.light?.radius);
    if (r > 0) out.push({ x: t.x | 0, y: t.y | 0, radius: r, color: t.light!.color || '#fff1cc', tokenId: t.id });
  }
  return out;
}

/**
 * Viewer-independent lighting data, reusable across several computeVisibility() calls on the same map state.
 * litRatio[i] = min over lights reaching cell i of (distance − 0.5) / radius: lit if ≤ 1 (≤ 2 with low-light).
 */
export function createVisionContext(map: VisionMap): VisionContext {
  const grid = buildGrid(map);
  const litRatio = new Float32Array(grid.n).fill(Infinity);
  const lights = mapLights(map);
  if ((map.lighting || 'bright') !== 'bright') {
    const los = new Uint8Array(grid.n);
    for (const l of lights) {
      if (l.x < 0 || l.y < 0 || l.x >= grid.w || l.y >= grid.h) continue;
      const reach = Math.ceil(l.radius * 2 + 0.5);
      los.fill(0);
      lineOfSightMask(grid, l.x, l.y, reach, los);
      const x0 = Math.max(0, l.x - reach), x1 = Math.min(grid.w - 1, l.x + reach);
      const y0 = Math.max(0, l.y - reach), y1 = Math.min(grid.h - 1, l.y + reach);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * grid.w + x;
          if (!los[i]) continue;
          const r = Math.max(0, Math.hypot(x - l.x, y - l.y) - 0.5) / l.radius;
          if (r < litRatio[i]) litRatio[i] = r;
        }
      }
    }
  }
  return { grid, litRatio, lights, losCache: new Map() };
}

const LOS_CACHE_MAX = 48;
/** Per-viewer-cell LOS data, cached in the vision context: tile FOV + lazily memoised segment checks. */
function viewerLos(ctx: VisionContext, ox: number, oy: number): LosEntry {
  const { grid } = ctx;
  const key = oy * grid.w + ox;
  ctx.losCache ||= new Map();
  let e = ctx.losCache.get(key);
  if (!e) {
    e = { tile: fieldOfView(grid, ox, oy, Infinity), memo: grid.sightSegs ? new Uint8Array(grid.n) : null };
    if (ctx.losCache.size >= LOS_CACHE_MAX) ctx.losCache.delete(ctx.losCache.keys().next().value as number);
    ctx.losCache.set(key, e);
  }
  return e;
}
/** Is cell i in LOS for this viewer entry (tiles AND segments)? memo: 0 unknown, 1 visible, 2 blocked. */
function losAt(grid: VisionGrid, e: LosEntry, ox: number, oy: number, i: number): boolean {
  if (!e.tile[i]) return false;
  if (!e.memo) return true;
  let m = e.memo[i];
  if (!m) {
    const x = i % grid.w;
    m = cellSegVisible(grid.sightSegs, ox, oy, x, (i - x) / grid.w) ? 1 : 2;
    e.memo[i] = m;
  }
  return m === 1;
}

/**
 * Cells currently visible through the given tokens' eyes. Returns Uint8Array(width*height), 1 = visible.
 * Light model: bright → everything in LOS; dim → within 12 cells (24 with low-light) or lit;
 * dark → lit cells (light radius ×2 with low-light), within darkRange (thermo = 10), or adjacent.
 */
export function computeVisibility(
  map: VisionMap,
  viewerTokens: Array<VisionToken | null | undefined> | null | undefined,
  actorsById: VisionActors | null = {},
  vctx: VisionContext | null = null,
): Uint8Array {
  const ctx = vctx || createVisionContext(map);
  const { grid, litRatio } = ctx;
  const { w, h, n } = grid;
  const out = new Uint8Array(n);
  const lighting = map.lighting || 'bright';
  for (const tok of viewerTokens || []) {
    if (!tok) continue;
    const ox = tok.x | 0, oy = tok.y | 0;
    if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
    const tv = tokenVision(tok, actorsById?.[tok.actorId as string]);
    const e = viewerLos(ctx, ox, oy);
    if (lighting === 'bright') {
      for (let i = 0; i < n; i++) if (!out[i] && losAt(grid, e, ox, oy, i)) out[i] = 1;
      out[oy * w + ox] = 1;
      continue;
    }
    const ambient = lighting === 'dim' ? (tv.lowLight ? DIM_RANGE * 2 : DIM_RANGE) : DARK_TOUCH_RANGE;
    const R = Math.max(ambient, tv.darkRange || 0) + 0.5;
    const R2 = R * R;
    const mult = tv.lowLight ? 2 : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (out[i] || !e.tile[i]) continue;
        const dx = x - ox, dy = y - oy;
        if ((dx * dx + dy * dy <= R2 || litRatio[i] <= mult) && losAt(grid, e, ox, oy, i)) out[i] = 1;
      }
    }
    out[oy * w + ox] = 1;
  }
  return out;
}

/** Visibility for a user (own tokens + shared party vision). Returns { visible, viewers }. */
export function visibilityForUser<M extends VisionMap>(
  map: M,
  user: { characterIds?: string[] | null } | null | undefined,
  actors: VisionActors | null | undefined,
  vctx: VisionContext | null = null,
): { visible: Uint8Array; viewers: NonNullable<M['tokens']>[number][] } {
  const viewers = viewersForUser(map as { tokens?: NonNullable<M['tokens']>[number][] | null; sharedVision?: boolean }, user, actors);
  const n = (map.width | 0) * (map.height | 0);
  if (map.fog === false) return { visible: new Uint8Array(n).fill(1), viewers };
  if (!viewers.length) return { visible: new Uint8Array(n), viewers };
  return { visible: computeVisibility(map, viewers, actors, vctx), viewers };
}

/** True if any cell covered by the token is set in the mask. */
export function tokenInMask(token: { x: number; y: number; size?: number }, mask: ArrayLike<number>, width: number, height: number): boolean {
  const s = Math.max(1, (token.size as number) | 0 || 1);
  for (let dy = 0; dy < s; dy++)
    for (let dx = 0; dx < s; dx++) {
      const x = (token.x | 0) + dx, y = (token.y | 0) + dy;
      if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x]) return true;
    }
  return false;
}

// ---------------------------------------------------------------------------
// Path finding: 8-directional A*, no corner cutting.
// ---------------------------------------------------------------------------

/**
 * findPath(map, from {x,y}, to {x,y}, opts) → [{x,y}, …] (from → to inclusive) or null.
 * opts.blockers: iterable of {x,y} or cell indices that can't be crossed nor ended on (e.g. hostile tokens)
 * opts.occupied: cells that can be crossed but not ended on (e.g. allied tokens)
 * opts.allowed: Uint8Array mask; cells with 0 are impassable (e.g. cells a player never saw)
 * opts.ignoreWalls: GM teleport-style pathing (straight-line cost, only bounds apply; segment walls ignored too)
 * opts.grid: prebuilt buildGrid(map)
 */
export function findPath(map: VisionMap, from: Point, to: Point, opts: FindPathOptions = {}): Point[] | null {
  const grid = opts.grid || buildGrid(map);
  const { w, h, move } = grid;
  const fx = from.x | 0, fy = from.y | 0, tx = to.x | 0, ty = to.y | 0;
  if (fx < 0 || fy < 0 || fx >= w || fy >= h || tx < 0 || ty < 0 || tx >= w || ty >= h) return null;
  const toIndex = (c: Point | number): number => (typeof c === 'number' ? c : (c.y | 0) * w + (c.x | 0));
  const blockSet = new Set<number>();
  for (const c of opts.blockers || []) blockSet.add(toIndex(c));
  const occSet = new Set<number>();
  for (const c of opts.occupied || []) occSet.add(toIndex(c));
  const allowed = opts.allowed || null;
  const ignoreWalls = !!opts.ignoreWalls;
  const start = fy * w + fx, goal = ty * w + tx;
  blockSet.delete(start);
  if (start === goal) return [{ x: fx, y: fy }];
  const solid = (i: number) => (!ignoreWalls && move[i] === 1) || (allowed && !allowed[i]);
  const steps = ignoreWalls ? null : grid.steps;
  if (solid(goal) || blockSet.has(goal) || occSet.has(goal)) return null;

  const n = w * h;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap: Array<[number, number]> = []; // [f, i]
  const push = (f: number, i: number): void => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const hfun = (x: number, y: number): number => {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return Math.max(dx, dy) - Math.min(dx, dy) + DIAGONAL_COST * Math.min(dx, dy);
  };
  g[start] = 0;
  push(hfun(fx, fy), start);
  const DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const maxCost = opts.maxCost ?? Infinity;
  while (heap.length) {
    const [, cur] = pop();
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    const cx = cur % w, cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni] || solid(ni) || blockSet.has(ni)) continue;
      const diag = dx !== 0 && dy !== 0;
      if (diag && (solid(cy * w + nx) || solid(ny * w + cx))) continue; // no corner cutting
      if (steps && stepBlocked(grid, cx, cy, dx, dy)) continue; // segment walls / closed segment doors
      const ng = g[cur] + (diag ? DIAGONAL_COST : 1);
      if (ng > maxCost) continue;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        push(ng + hfun(nx, ny), ni);
      }
    }
  }
  if (g[goal] === Infinity) return null;
  const path: Point[] = [];
  for (let i = goal; i !== -1; i = came[i]) {
    path.push({ x: i % w, y: Math.floor(i / w) });
    if (i === start) break;
  }
  return path.reverse();
}

/** Path length in meters (diagonal step = 1.5 cells). Accepts [{x,y}] or [[x,y]]. */
export function pathLength(path: Array<Point | [number, number]> | null | undefined, metersPerCell: number | string | null = 1): number {
  if (!path || path.length < 2) return 0;
  let cells = 0;
  const P = (p: Point | [number, number]): Point => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);
  for (let i = 1; i < path.length; i++) {
    const a = P(path[i - 1]), b = P(path[i]);
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    cells += Math.max(dx, dy) - Math.min(dx, dy) + DIAGONAL_COST * Math.min(dx, dy);
  }
  return Math.round(cells * (Number(metersPerCell) || 1) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Fog-of-war memory: bitsets encoded as base64 (one bit per cell, row-major, LSB first).
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Uint8Array of 0/1 → compact base64 string. */
export function encodeBits(bits: ArrayLike<number>): string {
  const n = bits.length;
  const bytes = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
    const v = (b0 << 16) | (b1 << 8) | b2;
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
    s += i + 1 < bytes.length ? B64[(v >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? B64[v & 63] : '=';
  }
  return s;
}

/** base64 string → Uint8Array(n) of 0/1 (missing/invalid data = 0). */
export function decodeBits(str: unknown, n: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, n | 0));
  if (!str || typeof str !== 'string') return out;
  const bytes: number[] = [];
  let buf = 0, bitsIn = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bitsIn += 6;
    if (bitsIn >= 8) {
      bitsIn -= 8;
      bytes.push((buf >> bitsIn) & 255);
    }
  }
  for (let i = 0; i < out.length; i++) {
    const b = bytes[i >> 3];
    if (b && b & (1 << (i & 7))) out[i] = 1;
  }
  return out;
}

/** a |= b (in place). Returns true if a changed. */
export function orBits(a: { length: number; [i: number]: number }, b: ArrayLike<number>): boolean {
  let changed = false;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++)
    if (b[i] && !a[i]) {
      a[i] = 1;
      changed = true;
    }
  return changed;
}

/** Re-map a bitset after a resize: old cell (x, y) moves to (x + dx, y + dy). */
export function remapBits(bits: ArrayLike<number>, oldW: number, oldH: number, newW: number, newH: number, dx = 0, dy = 0): Uint8Array {
  const out = new Uint8Array(newW * newH);
  for (let y = 0; y < oldH; y++)
    for (let x = 0; x < oldW; x++) {
      if (!bits[y * oldW + x]) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < newW && ny < newH) out[ny * newW + nx] = 1;
    }
  return out;
}
