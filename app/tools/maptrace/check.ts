#!/usr/bin/env node
// Validation of traced library maps (data/maplib/<slug>.json).
//   node tools/maptrace/check.ts [<file.json|slug|dir> …] [--fix] [--strict] [--quiet] [--json]
// No argument = every file of data/maplib. Exit code 1 on errors (and on warnings with --strict).
// Checks: schema (ids, enums, geometry vs image size, FR/EN fields), bounds, zero-length / duplicate / overlapping
// walls, door length (≥ 0.6 cell), wall joints (« leak » = an endpoint 0.01–0.4 cell from another wall: light and
// sight pass through; « opening » = two free wall ends 0.4–1.6 cells apart without a door: archway or missing door),
// reachability of every region from `entry` with all doors open (shared/vision.ts buildGrid/canStep/findPath).
// --fix snaps leaks (endpoint → the other endpoint, or onto the other wall), rounds to 0.001 and rewrites the file
// in the canonical layout (one wall / light / region per line).
import fs from 'node:fs';
import path from 'node:path';
import { buildGrid, canStep, findPath, pointSegmentDistance } from '../../shared/vision.ts';
import { LIB_THEMES, LIB_LIGHTINGS, LIB_SOURCES, wallGeoKey } from '../../shared/maplib.ts';
import { args, isMain, findImage, jpegSize, readJpeg, MAPLIB_SRC } from './lib.ts';
import type { Img } from './lib.ts';
import type { LibLight, LibWall } from '../../shared/maplib.ts';
import type { VisionMap } from '../../shared/vision.ts';

export type IssueLevel = 'error' | 'warn' | 'info';
/** A finding of checkMap(); x/y/tag (cells) when it has a position. */
export interface MapIssue {
  level: IssueLevel;
  code: string;
  msg: string;
  x?: number;
  y?: number;
  tag?: string;
}
export interface MapStats {
  walls: number;
  windows: number;
  doors: number;
  lights: number;
  regions: number;
  wallLength: number;
  cells: number;
  joinedEnds: string;
  openings: number;
  reachable?: string;
  reachesBorder?: boolean;
  outsideCells?: number;
}
type Wall = LibWall & { id: string };

const JOIN = 0.01; // endpoints closer than this are joined
const LEAK = 0.4; // up to this: a leak (snap it)
const OPENING = 1.6; // free ends up to this apart: an opening without a door
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const len = (w: LibWall): number => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);

/** Nearest other wall to point (x, y): { d, j, end: [x, y]|null (when the closest point is an endpoint), t }. */
function nearestOther(walls: LibWall[], i: number, x: number, y: number): { d: number; j: number; end: [number, number] | null } {
  let best: { d: number; j: number; end: [number, number] | null } = { d: Infinity, j: -1, end: null };
  for (let j = 0; j < walls.length; j++) {
    if (j === i || joinedWalls(walls[i], walls[j])) continue;
    const w = walls[j];
    const d = pointSegmentDistance(x, y, w.x1, w.y1, w.x2, w.y2);
    if (d < best.d) {
      const d1 = Math.hypot(x - w.x1, y - w.y1), d2 = Math.hypot(x - w.x2, y - w.y2);
      const end: [number, number] | null = Math.min(d1, d2) <= d + 0.05 ? (d1 <= d2 ? [w.x1, w.y1] : [w.x2, w.y2]) : null;
      best = { d, j, end };
    }
  }
  return best;
}
/** True when two walls already touch (an endpoint of one lies on the other): neighbours, never a leak of each other. */
/** True when the point touches another wall (≤ JOIN). */
function isJoined(walls: LibWall[], i: number, x: number, y: number): boolean {
  for (let j = 0; j < walls.length; j++) if (j !== i && pointSegmentDistance(x, y, walls[j].x1, walls[j].y1, walls[j].x2, walls[j].y2) <= JOIN) return true;
  return false;
}
function joinedWalls(a: LibWall, b: LibWall): boolean {
  for (const [p, q] of [[a, b], [b, a]])
    for (const [x, y] of [[p.x1, p.y1], [p.x2, p.y2]]) if (pointSegmentDistance(x, y, q.x1, q.y1, q.x2, q.y2) <= JOIN) return true;
  return false;
}
const angleOf = (x1: number, y1: number, x2: number, y2: number): number => Math.atan2(y2 - y1, x2 - x1);
function projectOnto(w: LibWall, x: number, y: number): [number, number] {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - w.x1) * dx + (y - w.y1) * dy) / L2));
  return [w.x1 + t * dx, w.y1 + t * dy];
}
const collinearOverlap = (a: LibWall, b: LibWall): number => {
  const ax = a.x2 - a.x1, ay = a.y2 - a.y1, La = Math.hypot(ax, ay);
  if (La < 1e-6) return 0;
  const ux = ax / La, uy = ay / La;
  const off = (x: number, y: number) => Math.abs((x - a.x1) * uy - (y - a.y1) * ux);
  if (off(b.x1, b.y1) > 0.03 || off(b.x2, b.y2) > 0.03) return 0;
  const t1 = (b.x1 - a.x1) * ux + (b.y1 - a.y1) * uy, t2 = (b.x2 - a.x1) * ux + (b.y2 - a.y1) * uy;
  return Math.min(La, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
};

/**
 * Check one maplib object. opts: { file (for slug/name checks), image: true (compare with the real image size) }.
 * Returns { issues: [{ level, code, msg, x?, y?, tag? }], stats }.
 */
// `raw` is any parsed JSON: this function is the validator, it checks every field before trusting it.
export function checkMap(raw: any, { file = null, image = true }: { file?: string | null; image?: boolean } = {}): { issues: MapIssue[]; stats: Partial<MapStats> } {
  const issues: MapIssue[] = [];
  const add = (level: IssueLevel, code: string, msg: string, at: readonly number[] | null = null, tag: string | null = null) => issues.push({ level, code, msg, ...(at ? { x: at[0], y: at[1], tag: tag || code } : {}) });
  if (!raw || typeof raw !== 'object') return { issues: [{ level: 'error', code: 'json', msg: 'not an object' }], stats: {} };
  // ---- schema ----
  const slug = raw.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) add('error', 'slug', `slug « ${slug} » must be lower-case a-z0-9 words joined by -`);
  if (file && path.basename(file, '.json') !== slug) add('error', 'slug', `file name ${path.basename(file)} ≠ slug « ${slug} »`);
  if (raw.id !== `lib_${slug}`) add('error', 'id', `id must be « lib_${slug} » (is « ${raw.id} »)`);
  for (const k of ['name', 'nameFr', 'description', 'image'])
    if (typeof raw[k] !== 'string' || !raw[k].trim()) add('error', 'field', `${k} missing`);
  if (!LIB_SOURCES.includes(raw.source)) add('error', 'source', `source must be one of ${LIB_SOURCES.join('|')}`);
  if (!LIB_THEMES.includes(raw.theme)) add('error', 'theme', `theme must be one of ${LIB_THEMES.join('|')}`);
  if (!LIB_LIGHTINGS.includes(raw.lighting)) add('error', 'lighting', `lighting must be one of ${LIB_LIGHTINGS.join('|')}`);
  if (raw.metersPerCell !== 1.5) add('warn', 'meters', 'metersPerCell should be 1.5');
  if (!Array.isArray(raw.tags) || raw.tags.length < 4 || raw.tags.some((t: unknown) => typeof t !== 'string' || !t.trim())) add('warn', 'tags', 'tags: at least 4 non-empty strings (French + English)');
  if (typeof raw.description === 'string' && raw.description.length > 700) add('warn', 'description', 'description too long (1-3 sentences)');
  if (!Number.isInteger(raw.version) || raw.version < 1) add('error', 'version', 'version must be an integer ≥ 1');
  const t = raw.traced;
  if (!t || typeof t !== 'object' || !t.by || !t.at || !['good', 'rough'].includes(t.quality) || Number.isNaN(Date.parse(t.at))) add('error', 'traced', 'traced = { by, at (ISO date), quality: good|rough, notes }');
  const gridPx = raw.gridPx, offX = raw.offsetX ?? 0, offY = raw.offsetY ?? 0;
  if (!isNum(gridPx) || gridPx < 4) add('error', 'grid', 'gridPx must be a number ≥ 4');
  if (!isNum(offX) || !isNum(offY)) add('error', 'offset', 'offsetX / offsetY must be numbers');
  if (!Number.isInteger(raw.imageW) || !Number.isInteger(raw.imageH) || raw.imageW < 1 || raw.imageH < 1) add('error', 'image', 'imageW / imageH must be positive integers (px)');
  else if (isNum(gridPx)) {
    const ew = Math.ceil((raw.imageW - offX) / gridPx - 1e-6), eh = Math.ceil((raw.imageH - offY) / gridPx - 1e-6);
    if (raw.width !== ew || raw.height !== eh) add('error', 'size', `width/height must be ${ew}×${eh} (ceil(image / gridPx)), got ${raw.width}×${raw.height}`);
  }
  if (image && typeof raw.image === 'string') {
    const f = findImage(raw.image);
    if (!f) add('warn', 'image', `image « ${raw.image} » not found in the source folders`);
    else {
      const s = jpegSize(f);
      if (s && (s.width !== raw.imageW || s.height !== raw.imageH)) add('error', 'image', `imageW×imageH ${raw.imageW}×${raw.imageH} ≠ real ${s.width}×${s.height}`);
    }
  }
  const W = Number(raw.width) || 0, H = Number(raw.height) || 0;
  const inB = (x: number, y: number, m = 0.05) => x >= -m && y >= -m && x <= W + m && y <= H + m;
  // ---- walls ----
  const walls: any[] = Array.isArray(raw.walls) ? raw.walls : (add('error', 'walls', 'walls must be an array'), []);
  const ids = new Set<string>();
  const good: Wall[] = [];
  walls.forEach((w, i) => {
    const tag = w?.id || `#${i}`;
    if (!w || typeof w !== 'object' || ![w.x1, w.y1, w.x2, w.y2].every(isNum)) return add('error', 'wall', `wall ${tag}: x1 y1 x2 y2 must be numbers`);
    if (!w.id || ids.has(w.id)) add('error', 'wallId', `wall ${tag}: missing or duplicate id`);
    ids.add(w.id);
    if (typeof w.move !== 'boolean' || typeof w.sight !== 'boolean') add('error', 'wall', `wall ${tag}: move / sight must be booleans`);
    if (w.door !== null && (typeof w.door !== 'object' || !['open', 'closed', 'locked'].includes(w.door.state) || !['door', 'secret'].includes(w.door.kind)))
      add('error', 'door', `wall ${tag}: door must be null or { state: open|closed|locked, kind: door|secret }`);
    const mid = [(w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2];
    if (!inB(w.x1, w.y1) || !inB(w.x2, w.y2)) add('error', 'bounds', `wall ${tag} outside the map (0..${W} × 0..${H})`, mid, tag);
    const L = len(w);
    if (L < 0.05) return add('error', 'zero', `wall ${tag} has (almost) zero length`, mid, tag);
    if (w.door) {
      if (L < 0.3) add('error', 'doorLen', `door ${tag} is ${L.toFixed(2)} cell long (< 0.3)`, mid, tag);
      else if (L < 0.6) add('warn', 'doorLen', `door ${tag} is only ${L.toFixed(2)} cell long (doors ≥ 0.6: span the whole opening, frame to frame)`, mid, tag);
      else if (L > 3) add('warn', 'doorLen', `door ${tag} is ${L.toFixed(2)} cells long (> 3: split double doors / shutters?)`, mid, tag);
    }
    good.push(w);
  });
  const keys = new Map<string, string>();
  for (const w of good) {
    const k = wallGeoKey(w);
    if (keys.has(k)) add('error', 'duplicate', `walls ${keys.get(k)} and ${w.id} are identical`, [(w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2], w.id);
    else keys.set(k, w.id);
  }
  for (let i = 0; i < good.length; i++)
    for (let j = i + 1; j < good.length; j++) {
      const o = collinearOverlap(good[i], good[j]);
      if (o > 0.1 && wallGeoKey(good[i]) !== wallGeoKey(good[j])) {
        const w = good[j];
        add('warn', 'overlap', `walls ${good[i].id} and ${w.id} overlap on ${o.toFixed(2)} cell (collinear)`, [(w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2], 'overlap');
      }
    }
  // ---- joints ----
  let joined = 0, ends = 0;
  const free: Array<{ w: Wall; x: number; y: number; i: number }> = [];
  good.forEach((w, i) => {
    for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
      ends++;
      if (isJoined(good, i, x, y)) {
        joined++;
        continue;
      }
      const n = nearestOther(good, i, x, y);
      if (n.d <= LEAK) add('warn', 'leak', `${w.id} end (${r3(x)}, ${r3(y)}) is ${n.d.toFixed(2)} cell from ${good[n.j].id}: sight leaks — join them (--fix)`, [x, y], 'leak');
      else free.push({ w, x, y, i });
    }
  });
  const usedFree = new Set<number>();
  let openings = 0;
  for (let a = 0; a < free.length; a++) {
    if (usedFree.has(a)) continue;
    let best = -1, bd = Infinity;
    for (let b = 0; b < free.length; b++) {
      if (b === a || usedFree.has(b) || free[b].i === free[a].i) continue;
      const d = Math.hypot(free[a].x - free[b].x, free[a].y - free[b].y);
      if (d < bd) (bd = d), (best = b);
    }
    if (best >= 0 && bd > LEAK && bd <= OPENING) {
      usedFree.add(a);
      usedFree.add(best);
      openings++;
      add('info', 'opening', `opening ${bd.toFixed(2)} cell between ${free[a].w.id} and ${free[best].w.id} (archway / passage? add a door wall if there is a leaf)`, [(free[a].x + free[best].x) / 2, (free[a].y + free[best].y) / 2], 'open?');
    }
  }
  // ---- lights / regions / entry ----
  const lights: any[] = Array.isArray(raw.lights) ? raw.lights : (add('error', 'lights', 'lights must be an array'), []);
  const lids = new Set<string>();
  for (const l of lights) {
    if (!l || !isNum(l.x) || !isNum(l.y) || !isNum(l.radius)) {
      add('error', 'light', `light ${l?.id}: x, y, radius must be numbers`);
      continue;
    }
    if (!l.id || lids.has(l.id)) add('error', 'lightId', `light ${l.id}: missing or duplicate id`);
    lids.add(l.id);
    if (!inB(l.x, l.y, 0)) add('error', 'bounds', `light ${l.id} outside the map`, [l.x, l.y], l.id);
    if (l.radius < 0.5 || l.radius > 60) add('error', 'light', `light ${l.id}: radius ${l.radius} outside 0.5..60 cells`, [l.x, l.y], l.id);
    if (!/^#[0-9a-f]{6}$/i.test(l.color || '')) add('error', 'light', `light ${l.id}: color must be #rrggbb`);
    if (typeof l.on !== 'boolean') add('error', 'light', `light ${l.id}: on must be a boolean`);
  }
  const regions: any[] = Array.isArray(raw.regions) ? raw.regions : (add('error', 'regions', 'regions must be an array'), []);
  const rids = new Set<string>();
  for (const r of regions) {
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.w < 1 || r.h < 1) {
      add('error', 'region', `region ${r?.id}: x, y, w, h must be integers (w, h ≥ 1)`);
      continue;
    }
    if (!r.id || rids.has(r.id)) add('error', 'regionId', `region ${r.id}: missing or duplicate id`);
    rids.add(r.id);
    if (typeof r.name !== 'string' || !r.name.trim()) add('error', 'region', `region ${r.id}: name (French) missing`);
    if (r.gmOnly !== false) add('error', 'region', `region ${r.id}: gmOnly must be false`);
    if (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) add('error', 'bounds', `region ${r.id} outside the map`, [r.x + r.w / 2, r.y + r.h / 2], r.id);
  }
  // ---- reachability (all doors open) ----
  const stats: MapStats = {
    walls: good.filter((w) => !w.door && w.sight !== false).length,
    windows: good.filter((w) => !w.door && w.sight === false && w.move !== false).length,
    doors: good.filter((w) => w.door).length,
    lights: lights.length,
    regions: regions.length,
    wallLength: r3(good.reduce((s, w) => s + len(w), 0)),
    cells: W * H,
    joinedEnds: ends ? `${joined}/${ends} (${Math.round((joined / ends) * 100)}%)` : '0/0',
    openings,
  };
  if (W > 0 && H > 0 && W * H <= 200 * 200) {
    const map: VisionMap = { width: W, height: H, tiles: Array.from({ length: H }, () => '.'.repeat(W)), walls: good.map((w) => ({ ...w, door: w.door ? { ...w.door, state: 'open' } : null })) };
    const grid = buildGrid(map);
    const e = raw.entry;
    if (!e) add('warn', 'entry', 'no entry point: reachability not checked');
    else if (!isNum(e.x) || !isNum(e.y) || !inB(e.x, e.y, 0)) add('error', 'entry', 'entry outside the map');
    else {
      const sx = Math.min(W - 1, Math.floor(e.x)), sy = Math.min(H - 1, Math.floor(e.y));
      const seen = new Uint8Array(W * H);
      const q: Array<[number, number]> = [[sx, sy]];
      seen[sy * W + sx] = 1;
      while (q.length) {
        const [x, y] = q.pop()!;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx]) continue;
            if (canStep(map, { x, y }, { x: nx, y: ny }, grid)) {
              seen[ny * W + nx] = 1;
              q.push([nx, ny]);
            }
          }
      }
      let reached = 0, border = false;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (seen[y * W + x]) {
            reached++;
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
          }
      stats.reachable = `${reached}/${W * H} cells`;
      stats.reachesBorder = border;
      // leak check: with every door CLOSED, can a token walk from the entry onto empty background (outside the building)?
      const imgFile = image && typeof raw.image === 'string' ? findImage(raw.image) : null;
      if (imgFile && isNum(gridPx)) {
        const bgCells = backgroundCells(readJpeg(imgFile), W, H, gridPx, offX, offY);
        if (bgCells) {
          const closedMap: VisionMap = { ...map, walls: good };
          const cg = buildGrid(closedMap);
          const seen2 = new Uint8Array(W * H);
          const q2: Array<[number, number]> = [[sx, sy]];
          seen2[sy * W + sx] = 1;
          while (q2.length) {
            const [x, y] = q2.pop()!;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H || seen2[ny * W + nx]) continue;
                if (canStep(closedMap, { x, y }, { x: nx, y: ny }, cg)) {
                  seen2[ny * W + nx] = 1;
                  q2.push([nx, ny]);
                }
              }
          }
          const out: Array<[number, number]> = [];
          for (let i = 0; i < W * H; i++) if (seen2[i] && bgCells[i]) out.push([i % W, Math.floor(i / W)]);
          stats.outsideCells = out.length;
          if (out.length) {
            add('warn', 'outside', `${out.length} cell(s) reachable from the entry with every door CLOSED lie on the empty background outside the building (first: ${out.slice(0, 4).map(([x, y]) => `${x},${y}`).join(' ')}) — a gap in the outline? (ignore for outdoor maps)`);
            for (const [x, y] of out.slice(0, 6)) add('info', 'outsideCell', `reachable background cell ${x},${y}`, [x + 0.5, y + 0.5], 'outside');
          }
        }
      }
      for (const r of regions) {
        if (![r.x, r.y, r.w, r.h].every(Number.isInteger)) continue;
        // a region is reachable when findPath reaches one of its cells (try the centre first, then any flooded cell)
        const cx = Math.min(W - 1, r.x + (r.w >> 1)), cy = Math.min(H - 1, r.y + (r.h >> 1));
        let ok = !!findPath(map, { x: sx, y: sy }, { x: cx, y: cy }, { grid });
        for (let y = r.y; !ok && y < Math.min(H, r.y + r.h); y++) for (let x = r.x; !ok && x < Math.min(W, r.x + r.w); x++) ok = !!seen[y * W + x];
        if (!ok) add('error', 'unreachable', `region « ${r.name} » (${r.id}) cannot be reached from the entry with every door open — missing door / gap?`, [r.x + r.w / 2, r.y + r.h / 2], 'unreachable');
      }
    }
  }
  return { issues, stats };
}

/** Cells whose centre shows the uniform background colour of the image corners (null when the corners differ). */
export function backgroundCells(img: Img, W: number, H: number, gridPx: number, offX = 0, offY = 0): Uint8Array | null {
  const at = (x: number, y: number): number[] => {
    const i = (Math.max(0, Math.min(img.height - 1, Math.round(y))) * img.width + Math.max(0, Math.min(img.width - 1, Math.round(x)))) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const corners = [at(2, 2), at(img.width - 3, 2), at(2, img.height - 3), at(img.width - 3, img.height - 3)];
  const bg = [0, 1, 2].map((k) => corners.map((c) => c[k]).sort((a, b) => a - b)[1]);
  const near = (c: number[]) => Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) < 14;
  if (corners.filter(near).length < 3) return null;
  const out = new Uint8Array(W * H);
  const r = Math.max(1, Math.round(gridPx * 0.12));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const cx = offX + (x + 0.5) * gridPx, cy = offY + (y + 0.5) * gridPx;
      let all = true;
      for (const [dx, dy] of [[0, 0], [-r, -r], [r, -r], [-r, r], [r, r]]) if (!near(at(cx + dx, cy + dy))) all = false;
      out[y * W + x] = all ? 1 : 0;
    }
  // keep only background connected to the map border (dark floors / furniture inside the building are not « outside »)
  const keep = new Uint8Array(W * H);
  const q: Array<[number, number]> = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && out[y * W + x]) (keep[y * W + x] = 1), q.push([x, y]);
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, i = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || keep[i] || !out[i]) continue;
      keep[i] = 1;
      q.push([nx, ny]);
    }
  }
  return keep;
}

/** Snap leaks and round coordinates (in place). Returns the number of moved endpoints. */
export function fixMap(raw: { walls?: LibWall[] | null; lights?: LibLight[] | null }): number {
  const walls = (raw.walls || []).filter((w) => w && [w.x1, w.y1, w.x2, w.y2].every(isNum));
  let moved = 0;
  // pass 0 only applies snaps that keep the moved wall's direction (a vertical wall stays vertical); pass 1 the rest
  for (let pass = 0; pass < 2; pass++)
    walls.forEach((w, i) => {
      for (const [kx, ky] of [['x1', 'y1'], ['x2', 'y2']] as const) {
        if (isJoined(walls, i, w[kx], w[ky])) continue;
        const n = nearestOther(walls, i, w[kx], w[ky]);
        if (n.d > LEAK) continue;
        const [x, y] = n.end && Math.hypot(n.end[0] - w[kx], n.end[1] - w[ky]) <= LEAK ? n.end : projectOnto(walls[n.j], w[kx], w[ky]);
        const before = angleOf(w.x1, w.y1, w.x2, w.y2);
        const after = kx === 'x1' ? angleOf(x, y, w.x2, w.y2) : angleOf(w.x1, w.y1, x, y);
        let turn = Math.abs(after - before);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (pass === 0 && turn > 0.02) continue;
        w[kx] = x;
        w[ky] = y;
        moved++;
      }
    });
  for (const w of raw.walls || []) for (const k of ['x1', 'y1', 'x2', 'y2'] as const) if (isNum(w[k])) w[k] = r3(w[k]);
  for (const l of raw.lights || []) for (const k of ['x', 'y', 'radius'] as const) if (isNum(l[k])) l[k] = r3(l[k]);
  return moved;
}

/** Canonical file layout: pretty top level, one wall / light / region per line. */
export function formatMaplib(obj: object): string {
  const raw = obj as Record<string, unknown>;
  const order = ['id', 'slug', 'name', 'nameFr', 'source', 'image', 'imageW', 'imageH', 'gridPx', 'offsetX', 'offsetY', 'width', 'height', 'metersPerCell', 'theme', 'lighting', 'tags', 'description', 'entry', 'walls', 'lights', 'regions', 'traced', 'version'];
  const keys = [...order.filter((k) => k in raw), ...Object.keys(raw).filter((k) => !order.includes(k))];
  const lines = keys.map((k) => {
    const v = raw[k];
    if (['walls', 'lights', 'regions'].includes(k) && Array.isArray(v)) return `  ${JSON.stringify(k)}: ${v.length ? `[\n${v.map((o) => `    ${JSON.stringify(o)}`).join(',\n')}\n  ]` : '[]'}`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

function filesOf(argsList: string[]): string[] {
  if (!argsList.length) argsList = [MAPLIB_SRC];
  const out: string[] = [];
  for (const a of argsList) {
    let p = a;
    if (!fs.existsSync(p)) p = path.join(MAPLIB_SRC, a.endsWith('.json') ? a : `${a}.json`);
    if (!fs.existsSync(p)) {
      console.error(`not found: ${a}`);
      process.exitCode = 1;
      continue;
    }
    if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) f.endsWith('.json') && f !== 'library.json' && out.push(path.join(p, f));
    else out.push(p);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const a = args();
  let errors = 0, warns = 0;
  const report: Array<{ file: string; issues: MapIssue[]; stats: Partial<MapStats> }> = [];
  for (const file of filesOf(a._)) {
    // Parsed JSON of unknown shape: checkMap() validates it.
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.log(`✗ ${path.basename(file)}: invalid JSON (${(err as Error).message})`);
      errors++;
      continue;
    }
    if (a.fix) {
      const moved = fixMap(raw);
      fs.writeFileSync(file, formatMaplib(raw));
      if (!a.quiet) console.log(`  --fix: ${moved} endpoint(s) snapped, file rewritten`);
    }
    const { issues, stats } = checkMap(raw, { file });
    const e = issues.filter((i) => i.level === 'error').length, w = issues.filter((i) => i.level === 'warn').length;
    errors += e;
    warns += w;
    report.push({ file, issues, stats });
    if (a.json) continue;
    console.log(`${e ? '✗' : w ? '!' : '✓'} ${path.basename(file)}  ${raw.width}×${raw.height} cells @${raw.gridPx}px  walls ${stats.walls}  doors ${stats.doors}  windows ${stats.windows}  lights ${stats.lights}  regions ${stats.regions}  wall length ${stats.wallLength}  joined ends ${stats.joinedEnds}${stats.reachable ? `  reachable ${stats.reachable}${stats.outsideCells !== undefined ? `  outside(doors closed) ${stats.outsideCells}` : ''}` : ''}`);
    for (const i of issues) {
      if (a.quiet && i.level === 'info') continue;
      console.log(`    ${i.level.padEnd(5)} ${i.code.padEnd(11)} ${i.msg}`);
    }
  }
  if (a.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.length} file(s): ${errors} error(s), ${warns} warning(s)`);
  if (errors || (a.strict && warns)) process.exitCode = 1;
}
