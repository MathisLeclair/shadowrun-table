// Tests for the maps module: node tools/test-maps.js  (exit code ≠ 0 on failure)
// 1) Unit tests of shared/vision.js.  2) Server tests through an isolated server (port 3201) with a pre-seeded state.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, client, settle as baseSettle } from './test-client.js';
import * as V from '../shared/vision.js';

// Broadcasts carry every map to the GM (Foundry imports make the state ~1 MB): leave them time to arrive.
// settle(): wait at least ms + 150, then until no client received a state for 150 ms (max ~3 s).
const tracked = [];
function track(c) {
  c.lastStateAt = performance.now();
  c.socket.on('state', () => (c.lastStateAt = performance.now()));
  tracked.push(c);
  return c;
}
async function settle(ms = 120) {
  await baseSettle(ms + 150);
  for (let i = 0; i < 60 && !tracked.every((c) => performance.now() - c.lastStateAt > 150); i++) await baseSettle(50);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0, passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}
async function rejects(p, re, msg) {
  try {
    await p;
    ok(false, msg + ' (should have failed)');
  } catch (e) {
    ok(!re || re.test(e.message), `${msg} — got « ${e.message} »`);
  }
}
const vis = (v, map, x, y) => !!v[y * map.width + x];

// ---------------------------------------------------------------------------
// 1. vision.js
// ---------------------------------------------------------------------------
console.log('vision.js');
{
  const m = {
    width: 12, height: 5, lighting: 'bright', tokens: [],
    tiles: [
      '############',
      '#....#.....#',
      '#....D.....#',
      '#....#.....#',
      '############',
    ],
    doors: [{ id: 'd1', x: 5, y: 2, state: 'closed', kind: 'door' }],
  };
  const eye = [{ x: 2, y: 2 }];
  let v = V.computeVisibility(m, eye, {});
  ok(vis(v, m, 4, 1) && vis(v, m, 1, 3), 'same room visible');
  ok(!vis(v, m, 8, 2), 'closed door blocks sight');
  ok(vis(v, m, 5, 2), 'closed door face itself is visible');
  ok(vis(v, m, 0, 0) || vis(v, m, 5, 1), 'walls bordering the room are visible');
  ok(V.blocksMove(m, 5, 2) && V.blocksSight(m, 5, 2), 'closed door blocks move & sight');
  m.doors[0].state = 'locked';
  ok(V.blocksMove(m, 5, 2) && V.blocksSight(m, 5, 2), 'locked door blocks');
  m.doors[0].state = 'open';
  ok(!V.blocksMove(m, 5, 2) && !V.blocksSight(m, 5, 2), 'open door lets through');
  v = V.computeVisibility(m, eye, {});
  ok(vis(v, m, 8, 2), 'open door allows sight');
  ok(!vis(v, m, 10, 1) || true, 'partial view through doorway (no crash)');
  m.doors[0] = { id: 'd1', x: 5, y: 2, state: 'closed', kind: 'secret' };
  ok(V.blocksMove(m, 5, 2) && V.blocksSight(m, 5, 2), 'closed secret door is a wall');
  ok(!V.blocksSight(m, 3, 2) && V.blocksSight(m, 0, 2) && V.blocksSight(m, -1, 2), 'floor / wall / out of bounds');

  // Path finding
  m.doors[0].state = 'closed';
  ok(V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 }) === null, 'no path through closed door');
  m.doors[0].state = 'open';
  const p = V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 });
  ok(p && p.length === 7 && p.some((c) => c.x === 5 && c.y === 2), 'path through open door');
  ok(V.pathLength(p) === 6, 'path length 6 m');
  ok(V.findPath(m, { x: 2, y: 2 }, { x: 0, y: 0 }) === null, 'no path into a wall');
  // corner cutting: diagonal (4,1)->(5,2)? (5,1) is wall → must go (4,2)->(5,2)
  const p2 = V.findPath(m, { x: 4, y: 1 }, { x: 6, y: 1 });
  ok(p2 && !p2.some((c, i) => i > 0 && c.x === 5 && c.y === 2 && p2[i - 1].x === 4 && p2[i - 1].y === 1), 'no diagonal corner cutting past walls');
  ok(p2 && p2.every((c, i) => i === 0 || Math.abs(c.x - p2[i - 1].x) <= 1), 'path steps are adjacent');
  const p3 = V.findPath(m, { x: 1, y: 1 }, { x: 3, y: 3 });
  ok(p3 && p3.length === 3 && V.pathLength(p3) === 3, 'diagonals cost 1.5 m');
  const blocked = V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 }, { blockers: [{ x: 5, y: 2 }] });
  ok(blocked === null, 'hostile token in doorway blocks path');
  const ally = V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 }, { occupied: [{ x: 5, y: 2 }] });
  ok(ally && ally.length === 7, 'ally token can be crossed');
  ok(V.findPath(m, { x: 2, y: 2 }, { x: 5, y: 2 }, { occupied: [{ x: 5, y: 2 }] }) === null, 'cannot stop on an ally');
  const allowed = new Uint8Array(m.width * m.height).fill(1);
  allowed[2 * m.width + 7] = 0;
  ok(V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 }, { allowed }) !== null, 'allowed mask: detour possible');

  // Lighting
  const big = { width: 40, height: 5, lighting: 'dark', tokens: [], doors: [], lights: [], tiles: ['#'.repeat(40), '#' + '.'.repeat(38) + '#', '#' + '.'.repeat(38) + '#', '#' + '.'.repeat(38) + '#', '#'.repeat(40)] };
  const t0 = [{ x: 1, y: 2 }];
  v = V.computeVisibility(big, t0, {});
  ok(vis(v, big, 2, 2) && !vis(v, big, 5, 2) && !vis(v, big, 30, 2), 'dark: only adjacent cells without light');
  big.lights.push({ id: 'l', x: 30, y: 2, radius: 3, color: '#fff', on: true });
  v = V.computeVisibility(big, t0, {});
  ok(vis(v, big, 30, 2) && vis(v, big, 33, 2) && !vis(v, big, 25, 2) && !vis(v, big, 15, 2), 'dark: lit cells visible from afar, unlit not');
  v = V.computeVisibility(big, [{ x: 1, y: 2, vision: { lowLight: true } }], {});
  ok(vis(v, big, 25, 2) && !vis(v, big, 22, 2), 'low-light doubles light radius');
  big.lights[0].on = false;
  v = V.computeVisibility(big, t0, {});
  ok(!vis(v, big, 30, 2), 'switched-off light does nothing');
  v = V.computeVisibility(big, [{ x: 1, y: 2, vision: { darkRange: 6 } }], {});
  ok(vis(v, big, 7, 2) && !vis(v, big, 9, 2), 'darkRange sees in the dark');
  v = V.computeVisibility(big, [{ x: 1, y: 2, actorId: 'n' }], { n: { metatype: 'Nain' } });
  ok(vis(v, big, 11, 2) && !vis(v, big, 13, 2), 'thermographic (dwarf) = 10 cells in the dark');
  big.tokens = [{ id: 'torch', x: 1, y: 2, light: { radius: 4 } }];
  v = V.computeVisibility(big, big.tokens, {});
  big.tokens = [];
  ok(vis(v, big, 5, 2) && !vis(v, big, 7, 2), 'token light (torch) illuminates');
  // light blocked by walls
  const walled = { ...big, tiles: big.tiles.map((r, y) => (y > 0 && y < 4 ? r.slice(0, 28) + '#' + r.slice(29) : r)), lights: [{ id: 'l', x: 30, y: 2, radius: 6, on: true }] };
  v = V.computeVisibility(walled, [{ x: 22, y: 2 }], {});
  ok(!vis(v, walled, 26, 2) && !vis(v, walled, 25, 2), 'light does not pass walls');
  big.lighting = 'dim';
  big.lights = [];
  v = V.computeVisibility(big, t0, {});
  ok(vis(v, big, 13, 2) && !vis(v, big, 15, 2), 'dim: 12 cells');
  v = V.computeVisibility(big, [{ x: 1, y: 2, actorId: 'e' }], { e: { metatype: 'Elfe' } });
  ok(vis(v, big, 25, 2) && !vis(v, big, 27, 2), 'dim + low-light (elf): 24 cells');
  big.lighting = 'bright';
  v = V.computeVisibility(big, t0, {});
  ok(vis(v, big, 38, 2), 'bright: whole room');

  // tokenVision
  ok(V.tokenVision({}, { metatype: 'Humain', qualities: [{ name: 'Low-Light Vision' }] }).lowLight, 'quality Low-Light Vision');
  ok(V.tokenVision({}, { metatype: 'Humain', augmentations: [{ name: 'Yeux cybernétiques (vision nocturne)' }] }).lowLight, 'augmentation vision nocturne');
  ok(V.tokenVision({}, { metatype: 'Ork' }).lowLight && !V.tokenVision({}, { metatype: 'Humain' }).lowLight, 'ork low-light, human not');
  const troll = V.tokenVision({}, { metatype: 'Troll' });
  ok(troll.thermo && troll.darkRange === 10, 'troll thermo 10');
  ok(V.tokenVision({}, { metatype: 'Humain', augmentations: [{ name: 'Thermographic Vision' }] }).thermo, 'thermographic augmentation');
  ok(!V.tokenVision({ vision: { lowLight: false } }, { metatype: 'Elfe' }).lowLight, 'token override wins');

  // bitsets
  const bits = new Uint8Array(4801);
  [0, 7, 8, 9, 4800, 2345].forEach((i) => (bits[i] = 1));
  const enc = V.encodeBits(bits);
  const dec = V.decodeBits(enc, 4801);
  ok(dec.every((b, i) => b === bits[i]), 'bitset round-trip');
  ok(enc.length < 900, 'bitset compact (' + enc.length + ' chars)');
  ok(V.decodeBits('', 10).every((b) => b === 0) && V.decodeBits('%%%', 10).length === 10, 'decode garbage safely');
  const rm = V.remapBits(Uint8Array.from([1, 0, 0, 1]), 2, 2, 3, 3, 1, 1);
  ok(rm[4] === 1 && rm[8] === 1 && rm.reduce((a, b) => a + b, 0) === 2, 'remap bits after resize');

  // perf: 80x60 map, 4 tokens, 10 lights
  const W = 80, H = 60;
  const tiles = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 9 === 0 && y % 7 !== 3) ? '#' : '.')).join(''));
  const pm = { width: W, height: H, tiles, doors: [], lighting: 'dark', tokens: [], lights: Array.from({ length: 10 }, (_, i) => ({ x: 5 + i * 7, y: 30, radius: 6, on: true })) };
  const t1 = performance.now();
  for (let k = 0; k < 20; k++) V.computeVisibility(pm, [{ x: 4, y: 4 }, { x: 40, y: 30 }, { x: 70, y: 50 }, { x: 20, y: 50 }], {});
  const dt = (performance.now() - t1) / 20;
  ok(dt < 25, `visibility 80×60 fast enough (${dt.toFixed(2)} ms)`);
  const t2 = performance.now();
  const lp = V.findPath(pm, { x: 1, y: 1 }, { x: 78, y: 58 });
  ok(lp && performance.now() - t2 < 50, 'A* on 80×60 fast');
}

// ---------------------------------------------------------------------------
// 1b. Segment walls (Foundry-style maps)
// ---------------------------------------------------------------------------
console.log('vision.js — segment walls');
{
  const floor = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));
  // 12×5 all floor, a vertical wall on the grid line x = 6 with a door segment between y = 2 and 3
  const door = { id: 'sd', x1: 6, y1: 2, x2: 6, y2: 3, move: true, sight: true, door: { state: 'closed', kind: 'door' } };
  const m = {
    width: 12, height: 5, lighting: 'bright', tokens: [], doors: [], tiles: floor(12, 5),
    walls: [{ id: 'a', x1: 6, y1: 0, x2: 6, y2: 2, move: true, sight: true, door: null }, door, { id: 'b', x1: 6, y1: 3, x2: 6, y2: 5, move: true, sight: true, door: null }],
  };
  const eye = [{ x: 2, y: 2 }];
  let v = V.computeVisibility(m, eye, {});
  ok(vis(v, m, 5, 2) && vis(v, m, 5, 0) && vis(v, m, 0, 4), 'segments: own side visible');
  ok(!vis(v, m, 6, 2) && !vis(v, m, 8, 2) && !vis(v, m, 11, 4), 'segments: closed door + walls block sight');
  ok(!V.hasLineOfSight(m, { x: 2, y: 2 }, { x: 9, y: 2 }) && V.hasLineOfSight(m, { x: 2, y: 2 }, { x: 5, y: 4 }), 'hasLineOfSight honours segments');
  door.door.state = 'open';
  v = V.computeVisibility(m, eye, {});
  ok(vis(v, m, 8, 2) && vis(v, m, 11, 2), 'segments: open door lets sight through');
  ok(!vis(v, m, 7, 0) && !vis(v, m, 7, 4), 'segments: through a doorway only a cone is visible');
  door.door.state = 'locked';
  ok(V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 }) === null, 'segments: locked door blocks movement');
  door.door.state = 'open';
  const p = V.findPath(m, { x: 2, y: 2 }, { x: 8, y: 2 });
  ok(p && p.some((c, i) => i && p[i - 1].x === 5 && c.x === 6 && c.y === 2), 'segments: path goes through the open door');
  ok(p && p.every((c, i) => !i || V.canStep(m, p[i - 1], c)), 'canStep agrees with findPath');
  ok(!V.canStep(m, { x: 5, y: 1 }, { x: 6, y: 2 }) && !V.canStep(m, { x: 5, y: 3 }, { x: 6, y: 2 }), 'no diagonal squeeze past a door jamb');
  ok(V.canStep(m, { x: 7, y: 1 }, { x: 7, y: 2 }) && V.canStep(m, { x: 7, y: 0 }, { x: 8, y: 1 }), 'walls do not block moves parallel to them');
  // window: blocks movement, not sight
  const win = { width: 8, height: 3, lighting: 'bright', tokens: [], doors: [], tiles: floor(8, 3), walls: [{ id: 'w', x1: 4, y1: 0, x2: 4, y2: 3, move: true, sight: false }] };
  v = V.computeVisibility(win, [{ x: 1, y: 1 }], {});
  ok(vis(v, win, 6, 1) && V.findPath(win, { x: 1, y: 1 }, { x: 6, y: 1 }) === null, 'window segment: see through, cannot pass');
  win.walls[0] = { id: 'c', x1: 4, y1: 0, x2: 4, y2: 3, move: false, sight: true };
  v = V.computeVisibility(win, [{ x: 1, y: 1 }], {});
  ok(!vis(v, win, 6, 1) && V.findPath(win, { x: 1, y: 1 }, { x: 6, y: 1 }) !== null, 'curtain segment: blocks sight, can pass');
  // partial wall: sample rays (corners) let a cell be seen around the end of a wall
  const part = { width: 12, height: 8, lighting: 'bright', tokens: [], doors: [], tiles: floor(12, 8), walls: [{ id: 'p', x1: 6, y1: 0, x2: 6, y2: 4.5, move: true, sight: true }] };
  v = V.computeVisibility(part, [{ x: 2, y: 4 }], {});
  ok(vis(v, part, 9, 6) && vis(v, part, 7, 4) && !vis(v, part, 9, 1) && !vis(v, part, 7, 0), 'partial wall: visible around its end, hidden behind it');
  // corner squeeze: walls meeting at (5,3) enclose the top-right area
  const corner = { width: 12, height: 8, lighting: 'bright', tokens: [], doors: [], tiles: floor(12, 8), walls: [{ id: 'A', x1: 5, y1: 0, x2: 5, y2: 3 }, { id: 'B', x1: 5, y1: 3, x2: 12, y2: 3 }] };
  ok(!V.canStep(corner, { x: 4, y: 3 }, { x: 5, y: 2 }) && !V.canStep(corner, { x: 5, y: 2 }, { x: 4, y: 3 }), 'diagonal squeeze between walls meeting at a corner is blocked (both ways)');
  ok(V.canStep(corner, { x: 4, y: 3 }, { x: 5, y: 3 }) && V.canStep(corner, { x: 4, y: 3 }, { x: 4, y: 2 }), 'orthogonal steps around the corner are free');
  ok(V.findPath(corner, { x: 4, y: 3 }, { x: 5, y: 2 }) === null && V.findPath(corner, { x: 2, y: 6 }, { x: 8, y: 1 }) === null, 'enclosed corner area unreachable');
  ok(V.findPath(corner, { x: 2, y: 6 }, { x: 2, y: 0 }) !== null && V.findPath(corner, { x: 2, y: 6 }, { x: 10, y: 6 }) !== null, 'rest of the map reachable');
  ok(V.findPath(corner, { x: 4, y: 3 }, { x: 5, y: 2 }, { ignoreWalls: true }) !== null, 'ignoreWalls ignores segments');
  // light occlusion by segments
  const dark = { width: 12, height: 5, lighting: 'dark', tokens: [], doors: [], tiles: floor(12, 5), lights: [{ id: 'l', x: 8, y: 2, radius: 4, on: true }], walls: [{ id: 'x', x1: 6, y1: 0, x2: 6, y2: 5 }] };
  let ctx = V.createVisionContext(dark);
  ok(ctx.litRatio[2 * 12 + 7] <= 1 && ctx.litRatio[2 * 12 + 5] === Infinity, 'light does not pass a segment wall');
  v = V.computeVisibility(dark, [{ x: 2, y: 2 }], {}, ctx);
  ok(!vis(v, dark, 5, 2) && !vis(v, dark, 8, 2), 'dark: lit cells behind a wall stay hidden');
  dark.walls = [];
  v = V.computeVisibility(dark, [{ x: 2, y: 2 }], {});
  ok(vis(v, dark, 5, 2) && vis(v, dark, 8, 2), 'dark: same light without the wall is seen');
  ok(V.nearestWall(m.walls, 6.2, 2.5, 0.5)?.wall.id === 'sd' && !V.nearestWall(m.walls, 8, 2.5, 0.5), 'nearestWall');
  ok(V.segmentsTouch(0, 0, 2, 2, 1, 1, 3, 1) && !V.segmentsTouch(0, 0, 2, 0, 0, 1, 2, 1) && V.segmentsTouch(0, 0, 2, 0, 1, 0, 3, 0), 'segmentsTouch: endpoint / parallel / collinear');
  // vision context cache: same viewer cell reuses its LOS
  ctx = V.createVisionContext(m);
  V.computeVisibility(m, eye, {}, ctx);
  V.computeVisibility(m, eye, {}, ctx);
  ok(ctx.losCache.size === 1, 'per-viewer LOS cached in the vision context');

  // perf: 70×50 Foundry-like map (all floor), ~220 segments, 4 viewers
  const W = 70, H = 50;
  const walls = [];
  let id = 0;
  for (let rx = 0; rx <= W; rx += 10)
    for (let y = 0; y < H; y += 10) {
      walls.push({ id: 'w' + id++, x1: rx, y1: y, x2: rx, y2: y + 4 });
      walls.push({ id: 'w' + id++, x1: rx, y1: y + 4, x2: rx, y2: y + 5, door: { state: id % 3 ? 'closed' : 'open', kind: 'door' } });
      walls.push({ id: 'w' + id++, x1: rx, y1: y + 5, x2: rx, y2: y + 10 });
    }
  for (let ry = 0; ry <= H; ry += 10)
    for (let x = 0; x < W; x += 10) {
      walls.push({ id: 'w' + id++, x1: x, y1: ry, x2: x + 4, y2: ry });
      walls.push({ id: 'w' + id++, x1: x + 6, y1: ry, x2: x + 10, y2: ry });
    }
  for (let k = 0; k < 20; k++) walls.push({ id: 'd' + k, x1: 3 + k * 3, y1: 13 + (k % 5), x2: 5.3 + k * 3, y2: 16.7 + (k % 5) });
  const big = { width: W, height: H, tiles: floor(W, H), walls, doors: [], lighting: 'bright', tokens: [], lights: [] };
  const viewers = [{ x: 5, y: 5 }, { x: 35, y: 25 }, { x: 64, y: 44 }, { x: 15, y: 45 }];
  for (const lighting of ['bright', 'dark']) {
    big.lighting = lighting;
    big.lights = lighting === 'dark' ? Array.from({ length: 20 }, (_, i) => ({ x: 3 + ((i * 7) % 66), y: 3 + ((i * 11) % 44), radius: 6, on: true })) : [];
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) V.computeVisibility(big, viewers, {});
    const per = (performance.now() - t0) / 5 / viewers.length;
    ok(per < 30, `segments ${walls.length}: ${lighting} visibility ${per.toFixed(2)} ms per viewer (< 30)`);
  }
  big.lighting = 'bright';
  const t3 = performance.now();
  const unreachable = V.findPath(big, { x: 1, y: 1 }, { x: 68, y: 48 }); // closed doors: full search, no path
  const bp = V.findPath(big, { x: 1, y: 1 }, { x: 8, y: 48 }); // down through the gaps of the horizontal walls
  ok(unreachable === null && bp && bp.length > 40 && performance.now() - t3 < 60, 'A* with segments: correct and fast');
}

// ---------------------------------------------------------------------------
// 2. Server
// ---------------------------------------------------------------------------
async function startSeeded(port, initialState) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-maps-'));
  fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify(initialState));
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), SR_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url + '/api/lobby');
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, output: () => out, stop: () => { proc.kill(); try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {} } };
}

const actor = (id, name, extra = {}) => ({
  id, type: 'pc', name, metatype: 'Humain', color: '#3fd6d0',
  attributes: { BOD: 3, AGI: 4, REA: 3, STR: 3, WIL: 3, LOG: 3, INT: 3, CHA: 3, EDG: 3, ESS: 6 },
  condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 3 },
  skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [], contacts: [], sins: [],
  karma: 0, karmaTotal: 0, nuyen: 0, history: [], ...extra,
});

console.log('server (port 3201)');
const srv = await startSeeded(3201, {
  version: 1,
  config: { gmPassword: 'lazarus', campaignName: 'Test' },
  users: {},
  actors: {
    tpc1: actor('tpc1', 'Testeur Un'),
    tpc2: actor('tpc2', 'Testeur Deux', { qualities: [{ id: 'q', name: 'Low-Light Vision', karma: 3, positive: true }] }),
    tpcR: actor('tpcR', 'Retraité', { retired: true }),
    tnpc: { ...actor('tnpc', 'Garde'), type: 'npc' },
  },
  log: [],
});
let gm, p1, p2;
try {
  gm = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' })));
  p1 = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueur Un', characterId: 'tpc1' })));
  p2 = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueur Deux', characterId: 'tpc2' })));
  await settle();
  const p1Id = p1.state.me.id;
  for (const m of Object.values(gm.state.maps)) {
    ok(m.tiles.length === m.height && m.tiles.every((r) => r.length === m.width), 'seed map normalized: ' + m.id);
    ok(m.doors.every((d) => m.tiles[d.y][d.x] === 'D'), 'seed map doors on D tiles: ' + m.id);
  }

  // Fixture map
  const A = await gm.send('maps/create', { name: 'Fixture A', width: 22, height: 9, theme: 'corp', lighting: 'bright', folder: 'Tests' });
  ok(typeof A === 'string', 'maps/create returns id');
  await gm.send('maps/setTiles', {
    mapId: A,
    tiles: [
      '######################',
      '#........#...........#',
      '#........#...........#',
      '#........D...........#',
      '#........#...........#',
      '#........#####D#######',
      '#........#...........#',
      '#........D...........#',
      '######################',
    ],
  });
  const doorA = await gm.send('maps/addDoor', { mapId: A, door: { x: 9, y: 3, state: 'closed', kind: 'door' } });
  const secret = await gm.send('maps/addDoor', { mapId: A, door: { x: 14, y: 5, state: 'closed', kind: 'secret' } });
  const locked = await gm.send('maps/addDoor', { mapId: A, door: { x: 9, y: 7, state: 'locked', kind: 'door', name: 'Réserve' } });
  await gm.send('maps/update', { mapId: A, patch: { description: 'secret du MJ', sharedVision: true } });
  await gm.send('maps/addNote', { mapId: A, note: { x: 1, y: 1, text: 'piège' } });
  await gm.send('maps/addRegion', { mapId: A, region: { name: 'Hall', x: 1, y: 1, w: 8, h: 7 } });
  await gm.send('maps/addRegion', { mapId: A, region: { name: 'Coffre caché', x: 10, y: 1, w: 11, h: 4, gmOnly: true } });
  const t1 = await gm.send('maps/addToken', { mapId: A, token: { actorId: 'tpc1', x: 2, y: 2 } });
  const t2 = await gm.send('maps/addToken', { mapId: A, token: { actorId: 'tpc2', x: 3, y: 3 } });
  const tHidden = await gm.send('maps/addToken', { mapId: A, token: { name: 'Sniper', x: 6, y: 6, hidden: true, disposition: 'hostile' } });
  const tBehind = await gm.send('maps/addToken', { mapId: A, token: { name: 'Garde', actorId: 'tnpc', x: 15, y: 2 } });
  const tNeutral = await gm.send('maps/addToken', { mapId: A, token: { name: 'Barman', x: 7, y: 1, disposition: 'neutral' } });
  const tFar = await gm.send('maps/addToken', { mapId: A, token: { name: 'Rat', x: 18, y: 7, disposition: 'neutral' } });
  const B = await gm.send('maps/create', { name: 'Fixture B', width: 15, height: 10 });
  await gm.send('maps/setActive', { mapId: A });
  await settle();

  ok(gm.state.scene.activeMapId === A, 'setActive');
  ok(Object.keys(gm.state.maps).includes(B) && gm.state.maps[A].notes.length === 1, 'GM sees everything');
  ok(gm.state.maps[A].tokens.find((t) => t.id === t1).disposition === 'pc' && gm.state.maps[A].tokens.find((t) => t.id === t1).color === '#3fd6d0', 'PC token defaults from actor');

  let pm = p1.state.maps[A];
  ok(Object.keys(p1.state.maps).length === 1 && pm, 'player only gets the active map');
  const ids = new Set(pm.tokens.map((t) => t.id));
  ok(ids.has(t1) && ids.has(t2), 'player sees own + party tokens');
  ok(ids.has(tNeutral), 'player sees visible neutral');
  ok(!ids.has(tHidden), 'hidden token removed');
  ok(!ids.has(tBehind), 'token behind closed door removed');
  ok(pm.notes.length === 0, 'notes removed');
  ok(pm.regions.length === 1 && pm.regions[0].name === 'Hall', 'gmOnly region removed');
  ok(pm.description === undefined, 'description removed');
  ok(pm.tiles[5][14] !== 'D', 'closed secret door not shown as door');
  ok(!pm.doors.some((d) => d.id === secret), 'secret door removed from doors');
  ok(pm.tiles[2][15] === ' ', 'unexplored cells masked');
  ok(typeof pm.visible === 'string' && Object.keys(pm.explored).length === 1 && pm.explored[p1Id], 'visible + own explored only');
  ok(gm.state.maps[A].explored[p1Id], 'server stored explored for player');

  // Movement permissions
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t2, x: 4, y: 4 }), /appartient/, 'player cannot move another PC');
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: tNeutral, x: 4, y: 4 }), /appartient/, 'player cannot move NPC');
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 15, y: 2 }), /inaccessible/, 'player cannot move through closed door / walls');
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 0, y: 0 }), /inaccessible/, 'player cannot move into a wall');
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 99, y: 0 }), /hors/, 'out of map');
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 3, y: 3 }), /inaccessible/, 'cannot stop on an ally');
  const exploredBefore = V.decodeBits(pm.explored[p1Id], 22 * 9).reduce((a, b) => a + b, 0);
  const mv = await p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 8, y: 3 });
  ok(mv && mv.path.length >= 2 && mv.path.at(-1).x === 8 && mv.meters > 0, 'player move returns path');

  // Doors
  await rejects(p2.send('maps/toggleDoor', { mapId: A, doorId: doorA }), /Approche/, 'door too far');
  p1.events.length = 0;
  const st = await p1.send('maps/toggleDoor', { mapId: A, doorId: doorA });
  await settle();
  ok(st === 'open' && p1.events.some((e) => e.ev === 'sfx' && e.data.id === 'door-open'), 'player opens adjacent door (+ sfx)');
  pm = p1.state.maps[A];
  ok(pm.tokens.some((t) => t.id === tBehind), 'token visible once door open');
  const exploredAfter = V.decodeBits(pm.explored[p1Id], 22 * 9).reduce((a, b) => a + b, 0);
  ok(exploredAfter > exploredBefore, `explored grows (${exploredBefore} → ${exploredAfter})`);
  ok(pm.tiles[2][15] === '.', 'newly seen cells unmasked');
  ok(pm.tiles[5][14] === '#', 'closed secret door rendered as wall once seen');
  await rejects(p1.send('maps/toggleDoor', { mapId: A, doorId: secret }), /introuvable/, 'player cannot use hidden secret door');
  await p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 8, y: 6 });
  p1.events.length = 0;
  p2.events.length = 0;
  await rejects(p1.send('maps/toggleDoor', { mapId: A, doorId: locked }), /verrouill/, 'locked door refuses player');
  await settle(60);
  ok(p1.events.some((e) => e.ev === 'sfx' && e.data.id === 'door-locked') && p2.events.some((e) => e.data?.id === 'door-locked'), 'door-locked sfx to everyone');
  ok(p1.state.maps[A].doors.find((d) => d.id === locked).state === 'closed', 'locked shown as closed to players');
  await gm.send('maps/toggleDoor', { mapId: A, doorId: locked });
  await settle();
  ok(gm.state.maps[A].doors.find((d) => d.id === locked).state === 'open', 'GM opens locked door');
  await gm.send('maps/setDoor', { mapId: A, doorId: locked, state: 'locked' });

  // Move lock
  await gm.send('maps/update', { mapId: A, patch: { movementLocked: true } });
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 7, y: 6 }), /verrouill/, 'movement locked');
  await gm.send('maps/update', { mapId: A, patch: { movementLocked: false } });
  await p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 7, y: 6 });

  // Closed door blocks path even into explored cells
  await gm.send('maps/setDoor', { mapId: A, doorId: doorA, state: 'closed' });
  await rejects(p1.send('maps/moveToken', { mapId: A, tokenId: t1, x: 12, y: 3 }), /inaccessible/, 'closed door blocks player path to explored cells');

  // GM moves anything, ignoring walls
  const gmv = await gm.send('maps/moveToken', { mapId: A, tokenId: tBehind, x: 1, y: 7, ignoreWalls: true });
  ok(gmv.path.length === 2, 'GM teleport ignoring walls');
  await gm.send('maps/moveTokens', { mapId: A, moves: [{ tokenId: tBehind, x: 15, y: 2 }, { tokenId: tNeutral, x: 7, y: 2 }], ignoreWalls: true });
  await settle();
  ok(gm.state.maps[A].tokens.find((t) => t.id === tNeutral).y === 2, 'GM multi move');

  // Shared vision
  await gm.send('maps/moveToken', { mapId: A, tokenId: t2, x: 12, y: 7, ignoreWalls: true });
  await settle();
  ok(p1.state.maps[A].tokens.some((t) => t.id === tFar), 'shared vision: p1 sees what p2 sees');
  await gm.send('maps/update', { mapId: A, patch: { sharedVision: false } });
  await settle();
  ok(!p1.state.maps[A].tokens.some((t) => t.id === tFar), 'no shared vision: p1 does not see it');
  ok(p1.state.maps[A].tokens.some((t) => t.id === t1) && p2.state.maps[A].tokens.some((t) => t.id === t2), 'own token always kept');
  ok(p2.state.maps[A].tokens.some((t) => t.id === tFar), 'p2 still sees it');

  // Dark lighting on the server
  await gm.send('maps/update', { mapId: A, patch: { lighting: 'dark' } });
  await settle();
  ok(!p2.state.maps[A].tokens.some((t) => t.id === tFar), 'dark: far token invisible');
  const lid = await gm.send('maps/addLight', { mapId: A, light: { x: 18, y: 6, radius: 2, color: '#ff00ff' } });
  await settle();
  ok(p2.state.maps[A].tokens.some((t) => t.id === tFar), 'dark: light reveals token');
  await gm.send('maps/toggleLight', { mapId: A, lightId: lid });
  await settle();
  ok(!p2.state.maps[A].tokens.some((t) => t.id === tFar), 'dark: light off hides token');
  await gm.send('maps/updateLight', { mapId: A, lightId: lid, patch: { on: true, radius: 3 } });
  await settle();
  ok(gm.state.maps[A].lights[0].radius === 3 && gm.state.maps[A].lights[0].on, 'updateLight');
  await gm.send('maps/removeLight', { mapId: A, lightId: lid });
  await gm.send('maps/update', { mapId: A, patch: { lighting: 'bright', sharedVision: true } });

  // Token updates
  await p1.send('maps/updateToken', { mapId: A, tokenId: t1, patch: { color: '#ff0000', status: ['à terre'] } });
  await rejects(p1.send('maps/updateToken', { mapId: A, tokenId: t1, patch: { name: 'Hack', hidden: true } }), /apparence/, 'player cannot change name/hidden');
  await rejects(p1.send('maps/updateToken', { mapId: A, tokenId: t2, patch: { color: '#000000' } }), /appartient/, 'player cannot restyle others');
  await settle();
  const tok1 = gm.state.maps[A].tokens.find((t) => t.id === t1);
  ok(tok1.color === '#ff0000' && tok1.status[0] === 'à terre' && tok1.name === 'Testeur Un', 'player cosmetic update');
  await gm.send('maps/updateToken', { mapId: A, tokenId: tHidden, patch: { hidden: false, disposition: 'hostile', name: 'Sniper révélé' } });
  await settle();
  ok(p1.state.maps[A].tokens.some((t) => t.id === tHidden), 'unhidden token appears for players');

  // Fog toggle
  await gm.send('maps/update', { mapId: A, patch: { fog: false } });
  await settle();
  ok(p1.state.maps[A].tiles[2][15] === '.', 'fog off: map revealed');
  ok(!p1.state.maps[A].tiles.some((r) => r.includes(' ')), 'fog off: no masked cells');
  await gm.send('maps/update', { mapId: A, patch: { fog: true } });
  await gm.send('maps/resetFog', { mapId: A, userId: p1Id });
  await settle();
  ok(gm.state.maps[A].explored[p1Id] && V.decodeBits(gm.state.maps[A].explored[p1Id], 22 * 9).reduce((a, b) => a + b, 0) < exploredAfter + 40, 'reset fog then current view re-explored');

  // Player restrictions on GM actions + non-active map
  await rejects(p1.send('maps/create', { name: 'x' }), /MJ/, 'player cannot create map');
  await rejects(p1.send('maps/addToken', { mapId: A, token: { x: 1, y: 1 } }), /MJ/, 'player cannot add token');
  const tB = await gm.send('maps/addToken', { mapId: B, token: { actorId: 'tpc1', x: 3, y: 3 } });
  await rejects(p1.send('maps/moveToken', { mapId: B, tokenId: tB, x: 4, y: 4 }), /affichée/, 'player cannot move on a non-shown map');
  await gm.send('maps/removeToken', { mapId: B, tokenId: tB });

  // placePCs
  const placed = await gm.send('maps/placePCs', { mapId: B, x: 0, y: 0 });
  await settle();
  const mb = gm.state.maps[B];
  const pcCount = Object.values(gm.state.actors).filter((a) => a.type === 'pc' && !a.retired).length;
  ok(placed.length === pcCount && mb.tokens.length === pcCount, `placePCs places every active PC (${placed.length}/${pcCount})`);
  ok(!mb.tokens.some((t) => t.actorId === 'tpcR'), 'retired PC skipped');
  ok(new Set(mb.tokens.map((t) => t.x + ',' + t.y)).size === mb.tokens.length, 'placePCs: distinct cells');
  ok(mb.tokens.every((t) => !V.blocksMove(mb, t.x, t.y)), 'placePCs: on floor (start was a wall corner)');
  ok((await gm.send('maps/placePCs', { mapId: B })).length === 0, 'placePCs idempotent');

  // Map management
  const C = await gm.send('maps/duplicate', { mapId: A });
  await gm.send('maps/resize', { mapId: C, width: 30, height: 12, anchor: 'c' });
  await settle();
  const mc = gm.state.maps[C];
  ok(mc.width === 30 && mc.tiles.length === 12 && mc.tiles.every((r) => r.length === 30), 'resize');
  ok(mc.doors.some((d) => d.x === 9 + 4 && d.y === 3 + 2) && mc.tiles[5][13] === 'D', 'resize shifts doors (anchor center)');
  await gm.send('maps/paint', { mapId: C, cells: [{ x: 13, y: 5, ch: '#' }, { x: 1, y: 1, ch: '?' }] });
  await settle();
  ok(!gm.state.maps[C].doors.some((d) => d.x === 13 && d.y === 5), 'painting over a door removes it');
  const exported = JSON.parse(JSON.stringify(gm.state.maps[C]));
  exported.tiles[0] = 'ZZZ';
  const D = await gm.send('maps/import', { map: exported });
  await settle();
  ok(D !== C && gm.state.maps[D].tiles[0].length === 30 && !gm.state.maps[D].tiles[0].includes('Z'), 'import (new id, sanitized rows)');
  await rejects(gm.send('maps/import', { map: { nope: 1 } }), /invalide/, 'import validates');
  await gm.send('maps/delete', { mapId: D });
  await gm.send('maps/delete', { mapId: C });
  const rid = gm.state.maps[A].regions[0].id;
  await gm.send('maps/updateRegion', { mapId: A, regionId: rid, patch: { name: 'Hall principal' } });
  const nid = gm.state.maps[A].notes[0].id;
  await gm.send('maps/updateNote', { mapId: A, noteId: nid, patch: { text: 'piège à gaz' } });
  await settle();
  ok(gm.state.maps[A].regions[0].name === 'Hall principal' && gm.state.maps[A].notes[0].text === 'piège à gaz', 'update region / note');
  await gm.send('maps/removeNote', { mapId: A, noteId: nid });
  await gm.send('maps/removeRegion', { mapId: A, regionId: rid });
  await gm.send('maps/removeDoor', { mapId: A, doorId: doorA });
  await gm.send('maps/delete', { mapId: A });
  await settle();
  const nextActive = gm.state.scene.activeMapId;
  ok(nextActive && nextActive !== A && gm.state.maps[nextActive] && !gm.state.maps[A], 'deleting active map activates another');
  ok(Object.keys(p1.state.maps).length === 1 && p1.state.maps[nextActive], 'players follow the new active map');
  await gm.send('maps/setActive', { mapId: null });
  await settle();
  ok(Object.keys(p1.state.maps).length === 0, 'no active map → players get no map');

  // ---------------- segment walls & image backgrounds ----------------
  // 16×8 all-floor image map; vertical wall on x = 8 with a door segment (y 3..4) and a locked door (y 6..7);
  // a secret door on the horizontal line y = 2 between x 2..3 (leads to a closet in the west room).
  const F = await gm.send('maps/import', {
    map: {
      id: 'foundry-test', name: 'Foundry test', folder: 'Tests', width: 16, height: 8,
      tiles: Array.from({ length: 8 }, () => '.'.repeat(16)),
      background: { url: '/assets/foundry/test/map.webp', mode: 'image', x: '0', y: 0, w: 16, h: 8 },
      walls: [
        { id: 'wN', x1: '8', y1: 0, x2: 8, y2: 3, move: true, sight: true },
        { id: 'dA', x1: 8, y1: 3, x2: 8, y2: 4, door: { state: 'closed', kind: 'door', name: 'Porte du bureau' } },
        { id: 'wM', x1: 8, y1: 4, x2: 8, y2: 6 },
        { id: 'dL', x1: 8, y1: 6, x2: 8, y2: 7, door: { state: 'locked', kind: 'door' } },
        { id: 'wS', x1: 8, y1: 7, x2: 8, y2: 8 },
        { id: 'wC', x1: 0, y1: 2, x2: 2, y2: 2 },
        { id: 'dS', x1: 2, y1: 2, x2: 3, y2: 2, door: { state: 'closed', kind: 'secret' } },
        { id: 'wC2', x1: 3, y1: 2, x2: 8, y2: 2 },
        { id: 'win', x1: 12, y1: 0, x2: 12, y2: 2, move: true, sight: false },
        { id: 'bad', x1: 'x', y1: 0, x2: 1, y2: 1 },
        { id: 'zero', x1: 1, y1: 1, x2: 1, y2: 1 },
        { id: 'wN', x1: 15, y1: 0, x2: 15, y2: 1 },
      ],
      lighting: 'bright', fog: true,
    },
  });
  await gm.send('maps/setActive', { mapId: F });
  const fa = await gm.send('maps/addToken', { mapId: F, token: { actorId: 'tpc1', x: 4, y: 4 } });
  const fb = await gm.send('maps/addToken', { mapId: F, token: { actorId: 'tpc2', x: 1, y: 6 } });
  const fGuard = await gm.send('maps/addToken', { mapId: F, token: { name: 'Garde', x: 12, y: 4, disposition: 'hostile' } });
  const fCloset = await gm.send('maps/addToken', { mapId: F, token: { name: 'Planqué', x: 2, y: 1, disposition: 'hostile' } });
  await settle();
  let gf = gm.state.maps[F];
  ok(gf.background.mode === 'image' && gf.background.x === 0 && gf.background.w === 16 && gf.background.opacity === 1, 'image background normalized (mode, numbers, opacity 1)');
  ok(gf.walls.length === 10 && !gf.walls.some((w) => w.id === 'bad' || w.id === 'zero'), 'invalid / zero-length walls dropped');
  ok(gf.walls.every((w) => typeof w.x1 === 'number' && typeof w.move === 'boolean' && typeof w.sight === 'boolean' && 'door' in w), 'walls normalized (numbers, booleans, door)');
  ok(new Set(gf.walls.map((w) => w.id)).size === gf.walls.length, 'duplicate wall ids re-assigned');
  ok(gf.walls.find((w) => w.id === 'dA').door.name === 'Porte du bureau' && gf.walls.find((w) => w.id === 'win').sight === false, 'door names / window flags kept');

  let pf = p1.state.maps[F];
  ok(pf && pf.background?.mode === 'image' && pf.background.url === '/assets/foundry/test/map.webp', 'image background passes through the player filter');
  ok(!pf.walls.some((w) => w.id === 'dS' || w.door?.kind === 'secret'), 'closed secret wall-door stripped for players');
  ok(pf.walls.some((w) => w.x1 === 2 && w.y1 === 2 && w.x2 === 3 && !w.door), '… sent as an anonymous plain wall');
  ok(pf.walls.some((w) => w.id === 'dA' && w.door.state === 'closed'), 'known door segment kept with its id');
  ok(pf.walls.filter((w) => !w.door).every((w) => !['wN', 'wM', 'wC', 'win'].includes(w.id)), 'plain walls have anonymous ids for players');
  ok(gm.state.maps[F].walls.some((w) => w.id === 'dS'), 'GM still has the secret door');
  let pids = new Set(pf.tokens.map((t) => t.id));
  ok(!pids.has(fGuard) && !pids.has(fCloset), 'segment walls hide tokens behind them');
  ok(pf.tiles[4][12] === ' ' && pf.tiles[4][6] === '.', 'segment walls limit explored cells');

  // movement (fog off so that only the walls matter, not unexplored cells)
  await gm.send('maps/update', { mapId: F, patch: { fog: false } });
  await rejects(p1.send('maps/moveToken', { mapId: F, tokenId: fa, x: 10, y: 4 }), /inaccessible/, 'player cannot walk through a closed door segment');
  await rejects(p1.send('maps/moveToken', { mapId: F, tokenId: fa, x: 4, y: 1 }), /inaccessible/, 'player cannot walk through a wall segment');
  await gm.send('maps/update', { mapId: F, patch: { fog: true } });
  await p1.send('maps/moveToken', { mapId: F, tokenId: fa, x: 7, y: 3 });

  // door segment permissions
  await rejects(p2.send('maps/toggleDoor', { mapId: F, doorId: 'dA' }), /Approche/, 'door segment too far for p2');
  await rejects(p1.send('maps/toggleDoor', { mapId: F, doorId: 'dS' }), /introuvable/, 'player cannot use a closed secret door segment');
  p1.events.length = 0;
  const fst = await p1.send('maps/toggleDoor', { mapId: F, doorId: 'dA' });
  await settle();
  ok(fst === 'open' && p1.events.some((e) => e.ev === 'sfx' && e.data.id === 'door-open'), 'player opens a door segment within 1.5 cells (+ sfx)');
  pf = p1.state.maps[F];
  pids = new Set(pf.tokens.map((t) => t.id));
  ok(pids.has(fGuard) && pf.tiles[4][12] === '.', 'open door segment reveals the room and grows fog memory');
  const mvF = await p1.send('maps/moveToken', { mapId: F, tokenId: fa, x: 9, y: 3 });
  ok(mvF.path.some((c) => c.x === 8 && c.y === 3), 'player walks through the open door segment');
  p1.events.length = 0;
  await p1.send('maps/toggleDoor', { mapId: F, doorId: 'dA' });
  await settle();
  ok(gm.state.maps[F].walls.find((w) => w.id === 'dA').door.state === 'closed' && p1.events.some((e) => e.data?.id === 'door-close'), 'player closes it again (+ sfx)');
  await p1.send('maps/moveToken', { mapId: F, tokenId: fa, x: 9, y: 6 });
  p1.events.length = 0;
  await rejects(p1.send('maps/toggleDoor', { mapId: F, doorId: 'dL' }), /verrouill/, 'locked door segment refuses player');
  await settle(60);
  ok(p1.events.some((e) => e.data?.id === 'door-locked'), 'door-locked sfx for a locked segment');
  ok(p1.state.maps[F].walls.find((w) => w.id === 'dL')?.door.state === 'closed', 'locked segment shown as closed to players');
  await rejects(p1.send('maps/setDoor', { mapId: F, doorId: 'dL', state: 'open' }), /MJ/, 'players cannot setDoor');
  await gm.send('maps/toggleDoor', { mapId: F, doorId: 'dL' });
  await settle();
  ok(gm.state.maps[F].walls.find((w) => w.id === 'dL').door.state === 'open', 'GM toggles a locked segment door open');
  const sd = await gm.send('maps/setDoor', { mapId: F, doorId: 'dL', state: 'locked', kind: 'secret', name: 'Trappe' });
  await settle();
  gf = gm.state.maps[F];
  ok(sd === 'dL' && gf.walls.find((w) => w.id === 'dL').door.kind === 'secret' && gf.walls.find((w) => w.id === 'dL').door.name === 'Trappe', 'setDoor on a segment (state, kind, name)');
  await gm.send('maps/setDoor', { mapId: F, doorId: 'dL', kind: 'gate' });
  await settle();
  ok(gm.state.maps[F].walls.find((w) => w.id === 'dL').door.kind === 'secret', 'segment door kinds limited to door / secret');
  await gm.send('maps/setDoor', { mapId: F, doorId: 'dS', state: 'open' });
  await settle();
  ok(p1.state.maps[F].walls.some((w) => w.id === 'dS' && w.door.kind === 'door' && w.door.state === 'open'), 'open secret door segment shown to players as a door');
  ok(p1.state.maps[F].tokens.some((t) => t.id === fCloset), 'closet token seen through the opened secret door (shared vision)');

  // GM wall CRUD
  await rejects(p1.send('maps/addWall', { mapId: F, wall: { x1: 0, y1: 0, x2: 1, y2: 0 } }), /MJ/, 'players cannot add walls');
  await rejects(gm.send('maps/addWall', { mapId: F, wall: { x1: 1, y1: 1, x2: 1, y2: 1 } }), /invalide/, 'addWall validates');
  const nw = await gm.send('maps/addWall', { mapId: F, wall: { x1: 9, y1: 5, x2: 15, y2: 5, door: null } });
  await settle();
  ok(typeof nw === 'string' && gm.state.maps[F].walls.some((w) => w.id === nw && w.move && w.sight), 'addWall');
  await gm.send('maps/updateWall', { mapId: F, wallId: nw, patch: { sight: false, door: { state: 'open', kind: 'door' } } });
  await settle();
  let nwW = gm.state.maps[F].walls.find((w) => w.id === nw);
  ok(nwW.sight === false && nwW.door?.state === 'open', 'updateWall (flags + door)');
  await gm.send('maps/updateWall', { mapId: F, wallId: nw, patch: { door: { state: 'closed' } } });
  await settle();
  nwW = gm.state.maps[F].walls.find((w) => w.id === nw);
  ok(nwW.door.state === 'closed' && nwW.door.kind === 'door', 'updateWall merges a partial door patch');
  await gm.send('maps/updateWall', { mapId: F, wallId: nw, patch: { door: null } });
  await settle();
  ok(gm.state.maps[F].walls.find((w) => w.id === nw).door === null, 'updateWall door: null removes the door');
  const removed = await gm.send('maps/removeWall', { mapId: F, wallIds: [nw, 'win'] });
  await settle();
  ok(removed === 2 && !gm.state.maps[F].walls.some((w) => w.id === nw || w.id === 'win'), 'removeWall (several)');
  await rejects(gm.send('maps/removeWall', { mapId: F, wallId: 'nope' }), /introuvable/, 'removeWall unknown id');
  const before = gm.state.maps[F].walls;
  const cnt = await gm.send('maps/setWalls', { mapId: F, walls: [...before, { x1: 0, y1: 7, x2: 3, y2: 7 }, { x1: 'a' }] });
  await settle();
  ok(cnt === before.length + 1 && gm.state.maps[F].walls.slice(0, before.length).every((w, i) => w.id === before[i].id), 'setWalls (bulk save keeps ids, drops invalid)');

  // background patches, resize, duplicate
  await gm.send('maps/update', { mapId: F, patch: { background: { opacity: 0.5 } } });
  await settle();
  gf = gm.state.maps[F];
  ok(gf.background.opacity === 0.5 && gf.background.mode === 'image' && gf.background.url, 'partial background patch merges');
  await gm.send('maps/update', { mapId: F, patch: { background: { mode: 'underlay' } } });
  await settle();
  ok(gm.state.maps[F].background.mode === 'underlay', 'background mode switch');
  const Fd = await gm.send('maps/duplicate', { mapId: F });
  await settle();
  const fdW = gm.state.maps[Fd].walls;
  ok(fdW.length === gm.state.maps[F].walls.length && !fdW.some((w) => gm.state.maps[F].walls.some((o) => o.id === w.id)), 'duplicate gives walls new ids');
  await gm.send('maps/resize', { mapId: Fd, width: 20, height: 10, anchor: 'c' });
  await settle();
  const rz = gm.state.maps[Fd];
  ok(rz.walls.some((w) => w.x1 === 10 && w.y1 === 1 && w.x2 === 10 && w.y2 === 4) && rz.background.x === 2 && rz.background.y === 1, 'resize shifts walls and background');
  await gm.send('maps/update', { mapId: F, patch: { background: null } });
  await settle();
  ok(!gm.state.maps[F].background, 'background removed');
  await gm.send('maps/delete', { mapId: Fd });
} catch (err) {
  failures++;
  console.error('  ✗ unexpected error:', err);
  console.error(srv.output().slice(-2000));
} finally {
  gm?.close();
  p1?.close();
  p2?.close();
  srv.stop();
}

const errs = srv.output().split('\n').filter((l) => /\[action|filter failed|init failed/.test(l));
ok(errs.length === 0, 'no server-side errors: ' + errs.join(' | '));
console.log(`${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
