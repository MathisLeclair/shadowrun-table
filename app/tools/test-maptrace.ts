// Tests of the map tracing toolkit (tools/maptrace/*) and tools/maplib-build.ts: node tools/test-maptrace.ts
// No server is started (ports 3900-3909 stay free). Exit code ≠ 0 on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './maptrace/lib.ts';
import { measureTwin, conventionPitch, estimate } from './maptrace/scale.ts';
import { makeTiles, tileRects, resolveSource } from './maptrace/tiles.ts';
import { renderOverlay } from './maptrace/overlay.ts';
import { checkMap, fixMap, formatMaplib } from './maptrace/check.ts';
import { probe } from './maptrace/probe.ts';
import { scaffold } from './maptrace/new.ts';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0, passes = 0;
const ok = (c, msg) => (c ? passes++ : (failures++, console.error('  ✗ ' + msg)));
const section = (s) => console.log('• ' + s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maptrace-test-'));
const imgDir = path.join(tmp, 'img');
fs.mkdirSync(imgDir);
process.env.SR_FRAGMAP_DIRS = imgDir;
const isJpeg = (file) => {
  const b = fs.readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
  try {
    const d = L.readJpeg(file);
    return d.width > 0 && d.height > 0;
  } catch {
    return false;
  }
};

// Synthetic « fragmap »: dark background, a lit floor with a dark wall band, a 70 px grid in the twin.
const GP = 70, CW = 12, CH = 9;
function synth(grid = false) {
  const img = L.newImage(CW * GP, CH * GP, [20, 20, 28]);
  L.rect(img, 1 * GP, 1 * GP, 9 * GP, 7 * GP, [150, 120, 110], { fill: true });
  // dark wall band centred on x = 5.5 cells, from y 1 to 8
  L.rect(img, 5.5 * GP - 6, 1 * GP, 12, 7 * GP, [25, 25, 30], { fill: true });
  for (let i = 0; i < 400; i++) L.blend(img, (i * 37) % img.width, (i * 91) % img.height, [200, 200, 200], 1); // speckles
  if (grid) {
    for (let x = 0; x <= CW; x++) L.line(img, x * GP, 0, x * GP, CH * GP, [0, 0, 0], { width: 2, alpha: 0.8 });
    for (let y = 0; y <= CH; y++) L.line(img, 0, y * GP, CW * GP, y * GP, [0, 0, 0], { width: 2, alpha: 0.8 });
  }
  return img;
}
L.writeJpeg(synth(false), path.join(imgDir, 'test room.jpg'), 92);
L.writeJpeg(synth(true), path.join(imgDir, 'test room grid.jpg'), 92);

section('font & drawing');
{
  for (const [ch, g] of Object.entries(L.FONT)) ok(g.length === 7 && g.every((r) => Number.isInteger(r) && r >= 0 && r < 32), `glyph « ${ch} » is 7 rows of 5 bits`);
  for (const d of '0123456789') ok(L.FONT[d].some((r) => r), `digit ${d} has pixels`);
  const img = L.newImage(80, 30, [0, 0, 0]);
  const box = L.text(img, 'x12,3', 4, 4, { scale: 2, color: [255, 255, 255], bg: null });
  ok(box.w === L.textWidth('x12,3', 2) && box.h === 14, 'text box size');
  let lit = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 255) lit++;
  ok(lit > 60, `text draws pixels (${lit})`);
  ok(L.textWidth('Entrée', 1) === L.textWidth('ENTREE', 1), 'accents folded');
  const f = path.join(tmp, 'font.jpg');
  L.writeJpeg(img, f);
  ok(isJpeg(f), 'drawn image is a valid JPEG');
  const s = L.jpegSize(f);
  ok(s.width === 80 && s.height === 30, 'jpegSize reads the header');
  const r = L.resize(L.newImage(10, 10, [100, 0, 0]), 25, 5);
  ok(r.width === 25 && r.height === 5 && r.data[0] === 100, 'resize up/down');
  const c = L.crop(L.newImage(10, 10, [9, 9, 9]), -5, -5, 10, 10);
  ok(c.data[0] === 40 && c.data[(9 * 10 + 9) * 4] === 9, 'crop pads outside with grey');
}

section('scale');
{
  const t = measureTwin(path.join(imgDir, 'test room.jpg'), path.join(imgDir, 'test room grid.jpg'));
  ok(Math.abs(t.x.pitch - GP) < 0.6 && Math.abs(t.y.pitch - GP) < 0.6, `twin pitch ≈ ${GP} (got ${t.x.pitch} / ${t.y.pitch})`);
  ok(conventionPitch(1540, 2520) === 140, 'dive bar → 140');
  ok(conventionPitch(1200, 1200) === 200, '1 BDRM → 200');
  ok(conventionPitch(6320, 4640) === 80, 'jungle landing pad → 80');
  ok(conventionPitch(5180, 3360) === 140, 'rooftop garden → 140 (twin-measured)');
  ok(conventionPitch(3202, 4200) === 200 && conventionPitch(2401, 2999) === 200, '±2 px exports → 200');
  ok(conventionPitch(1234, 567) === null, 'no standard pitch → null');
  const e = estimate(path.join(imgDir, 'test room.jpg'));
  ok(e.candidates.some((c) => c.gridPx === 70), 'estimate lists 70 for an 840×630 image');
}

section('tiles');
{
  const src = resolveSource('test room.jpg', {});
  ok(src.geo.gridPx === 70 && src.geo.width === 12 && src.geo.height === 9, 'grid from the convention (840×630 → 70, 12×9)');
  const rects = tileRects({ width: 30, height: 20 }, 12, 2);
  const covered = new Set();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) covered.add(`${x},${y}`);
  ok(covered.size === 600, `tiles cover every cell (${covered.size}/600)`);
  ok(rects.every((r) => r.w === 12 && r.h === 12 && r.x + r.w <= 30 && r.y + r.h <= 20), 'tiles inside the map');
  const out = path.join(tmp, 'tiles');
  const files = makeTiles({ ...src }, { out, tile: 6, overlap: 2, max: 700 });
  ok(files[0].kind === 'overview' && files.length === 1 + tileRects(src.geo, 6, 2).length, `overview + tiles written (${files.length})`);
  ok(files.every((f) => isJpeg(f.file)), 'every tile is a valid JPEG');
  ok(files.filter((f) => f.kind === 'tile').every((f) => L.jpegSize(f.file).width <= 700), 'tiles ≤ --max px wide');
  const tile = L.readJpeg(files[1].file);
  // the coordinate labels in the margin are yellow (5th lines) / grey: some bright yellow pixels must exist
  let yellow = 0;
  for (let i = 0; i < tile.data.length; i += 4) if (tile.data[i] > 200 && tile.data[i + 1] > 180 && tile.data[i + 2] < 90) yellow++;
  ok(yellow > 30, `tiles carry yellow 5-cell lines / labels (${yellow})`);
}

const good = () => ({
  id: 'lib_test-room', slug: 'test-room', name: 'Test room', nameFr: 'Salle de test', source: 'fragmap', image: 'test room.jpg',
  imageW: 840, imageH: 630, gridPx: 70, offsetX: 0, offsetY: 0, width: 12, height: 9, metersPerCell: 1.5, theme: 'corp', lighting: 'dim',
  tags: ['test', 'salle', 'room', 'bureau'], description: 'Salle de test.',
  entry: { x: 2.5, y: 2.5 },
  walls: [
    { id: 'w1', x1: 1, y1: 1, x2: 10, y2: 1, move: true, sight: true, door: null },
    { id: 'w2', x1: 10, y1: 1, x2: 10, y2: 8, move: true, sight: true, door: null },
    { id: 'w3', x1: 10, y1: 8, x2: 1, y2: 8, move: true, sight: true, door: null },
    { id: 'w4', x1: 1, y1: 8, x2: 1, y2: 1, move: true, sight: true, door: null },
    { id: 'w5', x1: 5.5, y1: 1, x2: 5.5, y2: 4, move: true, sight: true, door: null },
    { id: 'w6', x1: 5.5, y1: 4, x2: 5.5, y2: 5, move: true, sight: true, door: { state: 'closed', kind: 'door' } },
    { id: 'w7', x1: 5.5, y1: 5, x2: 5.5, y2: 7, move: true, sight: true, door: null },
    { id: 'w8', x1: 5.5, y1: 7, x2: 5.5, y2: 8, move: true, sight: false, door: null },
  ],
  lights: [{ id: 'l1', x: 3, y: 3, radius: 3, color: '#ffcc88', on: true }],
  regions: [{ id: 'r1', name: 'Ouest', x: 1, y: 1, w: 4, h: 7, gmOnly: false }, { id: 'r2', name: 'Est', x: 6, y: 1, w: 4, h: 7, gmOnly: false }],
  traced: { by: 'agent', at: '2026-11-26T00:00:00.000Z', quality: 'good', notes: '' },
  version: 1,
});

section('overlay');
{
  const raw = good();
  const img = L.readJpeg(path.join(imgDir, 'test room.jpg'));
  const v = renderOverlay(raw, img, { ids: true });
  const f = path.join(tmp, 'overlay.jpg');
  L.writeJpeg(v.img, f);
  ok(isJpeg(f), 'overlay is a valid JPEG');
  let cyan = 0;
  for (let i = 0; i < v.img.data.length; i += 4) if (v.img.data[i] < 60 && v.img.data[i + 1] > 200 && v.img.data[i + 2] > 220) cyan++;
  ok(cyan > 200, `walls drawn in cyan (${cyan} px)`);
  const z = renderOverlay(raw, img, { region: { x: 4, y: 3, w: 3, h: 3 }, ppc: 100 });
  ok(z.img.width === 300 + 68 && z.ppc === 100, 'zoomed overlay size');
}

section('check');
{
  const r0 = checkMap(good(), { file: 'test-room.json' });
  const errs = r0.issues.filter((i) => i.level !== 'info');
  ok(errs.length === 0, `valid fixture passes (${errs.map((i) => i.code + ': ' + i.msg).join(' | ')})`);
  ok(r0.stats.walls === 6 && r0.stats.doors === 1 && r0.stats.windows === 1, `stats (${JSON.stringify(r0.stats)})`);
  ok(r0.stats.outsideCells === 0, 'no outside cell reachable in a closed room');
  const broken = (mut, code, level = 'error') => {
    const raw = good();
    mut(raw);
    const r = checkMap(raw, { file: 'test-room.json' });
    ok(r.issues.some((i) => i.code === code && i.level === level), `catches ${code} (${level}) — got ${r.issues.map((i) => `${i.level}:${i.code}`).join(', ')}`);
  };
  broken((r) => (r.id = 'test-room'), 'id');
  broken((r) => (r.slug = 'Test Room'), 'slug');
  broken((r) => (r.theme = 'castle'), 'theme');
  broken((r) => (r.width = 13), 'size');
  broken((r) => (r.imageW = 841), 'size');
  broken((r) => (r.imageW = 910) && (r.width = 13), 'image');
  broken((r) => delete r.traced, 'traced');
  broken((r) => r.walls.push({ id: 'w9', x1: 3, y1: 3, x2: 3, y2: 3, move: true, sight: true, door: null }), 'zero');
  broken((r) => r.walls.push({ ...r.walls[0], id: 'w9' }), 'duplicate');
  broken((r) => r.walls.push({ ...r.walls[0] }), 'wallId');
  broken((r) => r.walls.push({ id: 'w9', x1: 2, y1: 1, x2: 4, y2: 1, move: true, sight: true, door: null }), 'overlap', 'warn');
  broken((r) => (r.walls[5].y2 = 4.4), 'doorLen', 'warn');
  broken((r) => (r.walls[5].y2 = 4.2), 'doorLen');
  broken((r) => (r.walls[1].x1 = 13), 'bounds');
  broken((r) => (r.walls[1].y1 = 1.2), 'leak', 'warn');
  broken((r) => (r.walls[5].door = { state: 'ajar', kind: 'door' }), 'door');
  broken((r) => (r.walls[5].door = null), 'unreachable');
  broken((r) => (r.regions[0].gmOnly = true), 'region');
  broken((r) => (r.lights[0].color = 'yellow'), 'light');
  broken((r) => (r.entry = { x: 40, y: 2 }), 'entry');
  // gap in the outline → background reachable with the doors closed
  broken((r) => (r.walls[0].x2 = 3) && (r.walls[1].y1 = 1), 'outside', 'warn');
  broken((r) => r.walls.splice(6, 1, { id: 'w7a', x1: 5.5, y1: 5, x2: 5.5, y2: 5.8, move: true, sight: true, door: null }, { id: 'w7b', x1: 5.5, y1: 6.8, x2: 5.5, y2: 7, move: true, sight: true, door: null }), 'opening', 'info');
  // --fix snaps a leak and keeps the canonical layout parseable
  const raw = good();
  raw.walls[1].y1 = 1.2;
  const moved = fixMap(raw);
  ok(moved >= 1 && raw.walls[1].y1 === 1, `fixMap snaps the leak (${moved}, y1=${raw.walls[1].y1})`);
  const text = formatMaplib(raw);
  ok(JSON.parse(text).walls.length === 8 && text.split('\n').filter((l) => l.includes('"id":"w')).length === 8, 'formatMaplib: one wall per line, valid JSON');
}

section('new');
{
  const r = scaffold('test room.jpg', { nameFr: 'Salle' });
  ok(r.slug === 'test-room' && r.id === 'lib_test-room' && r.gridPx === 70 && r.width === 12 && r.height === 9 && r.imageW === 840, 'scaffold geometry');
  const c = checkMap({ ...r, theme: 'corp', tags: ['a', 'b', 'c', 'd'], description: 'x' }, { file: 'test-room.json' });
  ok(!c.issues.some((i) => i.level === 'error'), 'scaffold passes the schema once described: ' + c.issues.filter((i) => i.level === 'error').map((i) => i.msg).join(' | '));
}

section('probe');
{
  const src = resolveSource('test room.jpg', {});
  const r = probe(src, { axis: 'row', at: 3.3, from: 0, to: 12, step: 0.02, band: 0.06 });
  const dark = r.runs.filter((x) => x.kind === 'dark');
  const c = dark.map((d) => (d.a + d.b + 0.02) / 2).find((v) => Math.abs(v - 5.5) < 0.3);
  ok(c !== undefined && Math.abs(c - 5.5) < 0.06, `dark band centre ≈ 5.5 (got ${dark.map((d) => d.a + '–' + d.b).join(', ')})`);
  ok(r.runs[0].kind === 'background' && Math.abs(r.runs[0].b - 1) < 0.06, `background until x≈1 (got ${r.runs[0].b})`);
}

section('calibration maps');
{
  for (const slug of ['1-bdrm', 'dive-bar']) {
    const file = path.join(APP, 'data', 'maplib', `${slug}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete process.env.SR_FRAGMAP_DIRS;
    const r = checkMap(raw, { file });
    process.env.SR_FRAGMAP_DIRS = imgDir;
    const bad = r.issues.filter((i) => i.level === 'error' || (i.level === 'warn' && i.code !== 'image'));
    ok(bad.length === 0, `${slug} is clean (${bad.map((i) => i.code + ': ' + i.msg).join(' | ')})`);
    ok(r.stats.doors >= 2 && r.stats.walls >= 10 && raw.regions.length >= 4 && raw.lights.length >= 5, `${slug} has walls, doors, lights, regions`);
  }
}

section('maplib-build');
{
  const git = path.join(tmp, 'git'), lib = path.join(tmp, 'lib');
  fs.mkdirSync(git);
  fs.writeFileSync(path.join(git, 'test-room.json'), formatMaplib(good()));
  fs.writeFileSync(path.join(git, 'ghost.json'), formatMaplib({ ...good(), id: 'lib_ghost', slug: 'ghost', image: 'nope.jpg' }));
  fs.mkdirSync(path.join(imgDir, 'sub'));
  fs.copyFileSync(path.join(imgDir, 'test room.jpg'), path.join(imgDir, 'sub', 'deck 1.jpg'));
  fs.writeFileSync(path.join(git, 'deck.json'), formatMaplib({ ...good(), id: 'lib_deck', slug: 'deck', image: 'sub/deck 1.jpg' }));
  const env = { ...process.env, SR_MAPLIB_SOURCE: git, SR_MAPLIB_DIR: lib, SR_FRAGMAP_DIRS: imgDir };
  const run = () => spawnSync(process.execPath, [path.join(APP, 'tools', 'maplib-build.js')], { env, encoding: 'utf8' });
  const a = run();
  ok(a.status === 1 && /MISSING: ghost/.test(a.stdout), `missing image reported, exit 1 (${a.status})`);
  ok(fs.existsSync(path.join(lib, 'images', 'test room.jpg')) && fs.existsSync(path.join(lib, 'images', 'sub', 'deck 1.jpg')), 'images copied (sub-folders kept)');
  ok(isJpeg(path.join(lib, 'thumbs', 'test-room.jpg')) && isJpeg(path.join(lib, 'thumbs', 'deck.jpg')), 'thumbnails are JPEGs');
  ok(L.jpegSize(path.join(lib, 'thumbs', 'test-room.jpg')).width <= 480, 'thumbnail ≤ 480 px');
  ok(/2 copied/.test(a.stdout), 'first run copies');
  const b = run();
  ok(/0 copied, 2 unchanged, 0 thumbnail/.test(b.stdout), `second run is a no-op (${b.stdout.split('\n').pop() || b.stdout.trim().split('\n').pop()})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
