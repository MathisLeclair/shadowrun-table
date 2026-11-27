// Tests of the server-wide map library: node tools/test-maplib.ts  (ports 3910-3929, exit code ≠ 0 on failure)
// 1) Pure helpers of shared/maplib.js.  2) Isolated servers (two tables) with a fixture git folder (SR_MAPLIB_SOURCE):
// boot seeding, image auth, instances, update, publish + history, rollback, revert, custom maps, admin, migration, restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';
import { startServer, login, client, settle } from './test-client.ts';
import * as S from '../shared/maplib.ts';

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
const section = (s) => console.log('• ' + s);
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    await settle(60);
  }
  return fn();
}

// ---------------------------------------------------------------------------
section('shared/maplib.js');
{
  const g = S.libGeometry({ gridPx: 50, imageW: 525, imageH: 300, offsetX: 25, offsetY: 0 });
  ok(g.width === 10 && g.height === 6, `geometry width/height ${g.width}×${g.height}`);
  ok(g.bgX === -0.5 && g.bgW === 10.5, `background placement ${g.bgX} ${g.bgW}`);
  ok(S.wallGeoKey({ x1: 1, y1: 2, x2: 3, y2: 4 }) === S.wallGeoKey({ x1: 3, y1: 4, x2: 1, y2: 2 }), 'wall key ignores direction');
  let n = 0;
  const uid = (p) => `${p}_${++n}`;
  const version = {
    walls: [{ x1: 0, y1: 0, x2: 5, y2: 0 }, { x1: 5, y1: 0, x2: 5, y2: 2, door: { state: 'closed', kind: 'door' } }],
    lights: [{ x: 2, y: 2, radius: 4, color: '#fff', on: true }],
    regions: [{ name: 'Bar', x: 1, y: 1, w: 2, h: 2 }],
    entry: { x: 3.5, y: 1.2 },
  };
  const prev = { walls: [{ id: 'old', x1: 5, y1: 2, x2: 5, y2: 0, door: { state: 'open', kind: 'door', name: 'Porte du fond' } }], lights: [{ x: 2, y: 2, radius: 4, on: false }] };
  const c = S.instanceContent(version, uid, { previous: prev });
  ok(c.walls.length === 2 && c.walls.every((w) => /^wall_/.test(w.id)), 'fresh wall ids');
  ok(c.walls[1].door.state === 'open' && c.walls[1].door.name === 'Porte du fond', 'door state + name kept at the same place');
  ok(c.lights[0].on === false, 'light switch kept');
  ok(c.regions.some((r) => r.gmOnly && r.id.startsWith(S.ENTRY_REGION_PREFIX) && r.x === 3 && r.y === 1), 'entry → GM-only region');
  const map = { width: 10, height: 6, walls: c.walls, lights: c.lights, regions: [...c.regions, { id: 'r_secret', name: 'Planque', x: 0, y: 0, w: 1, h: 1, gmOnly: true }] };
  ok(S.libraryDiff(map, version, { gridPx: 50, imageW: 500, imageH: 300 }).same, 'diff of an untouched instance is empty');
  const pub = S.versionFromMap({ ...map, walls: [...map.walls, { x1: 1, y1: 1, x2: 2, y2: 1 }] }, { shift: { x: 1, y: 0 } });
  ok(pub.walls.length === 3 && pub.walls[2].x1 === 0, 'publish shifts walls back to the image origin');
  ok(pub.walls[1].door.state === 'closed' && !('name' in pub.walls[1].door), 'publish closes doors and drops their names');
  ok(pub.regions.length === 1 && pub.regions[0].name === 'Bar', 'publish leaves GM-only and entry regions out');
  const d = S.libraryDiff({ ...map, walls: map.walls.slice(1) }, version, { gridPx: 50, imageW: 500, imageH: 300 });
  ok(d.walls.add === 1 && d.walls.remove === 0 && !d.same, 'diff counts a missing wall');
  ok(S.matchesQuery({ name: 'Dive Bar', nameFr: 'Bar miteux', tags: ['ambiance', 'club'] }, 'miteux club') && !S.matchesQuery({ name: 'x', tags: [] }, 'bar'), 'search');
  ok(S.isLibUrl(S.libImageUrl('a')) && !S.isLibUrl('/assets/foundry/x.jpg'), 'isLibUrl');
}

// ---------------------------------------------------------------------------
// Fixtures: a git folder with two library maps, an image + thumbnail in the runtime library.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-maplib-'));
const gitDir = path.join(tmp, 'git');
const runtime = path.join(tmp, 'runtime');
fs.mkdirSync(gitDir, { recursive: true });
fs.mkdirSync(path.join(runtime, 'maplib', 'images'), { recursive: true });
fs.mkdirSync(path.join(runtime, 'maplib', 'thumbs'), { recursive: true });
function makeJpeg(w, h, rgb) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], (i % w) & 255, 255], i * 4);
  return jpeg.encode({ data, width: w, height: h }, 80).data;
}
fs.writeFileSync(path.join(runtime, 'maplib', 'images', 'dive bar.jpg'), makeJpeg(200, 140, [200, 40]));
fs.writeFileSync(path.join(runtime, 'maplib', 'thumbs', 'test-dive-bar.jpg'), makeJpeg(40, 28, [20, 200]));
const fixtureA = {
  id: 'lib_test-dive-bar', slug: 'test-dive-bar', name: 'Dive Bar', nameFr: 'Bar miteux', source: 'fragmap', image: 'dive bar.jpg',
  imageW: 200, imageH: 140, gridPx: 20, offsetX: 0, offsetY: 0, width: 10, height: 7, metersPerCell: 1.5, theme: 'bar', lighting: 'dim',
  tags: ['bar', 'dive bar', 'ambiance louche'], description: 'Un bar crasseux des Barrens.',
  walls: [
    { id: 'w1', x1: 0, y1: 0, x2: 10, y2: 0, move: true, sight: true, door: null },
    { id: 'w2', x1: 0, y1: 0, x2: 0, y2: 7, move: true, sight: true, door: null },
    { id: 'w3', x1: 5, y1: 0, x2: 5, y2: 3, move: true, sight: true, door: null },
    { id: 'd1', x1: 5, y1: 3, x2: 5, y2: 4, move: true, sight: true, door: { state: 'closed', kind: 'door' } },
  ],
  lights: [{ id: 'l1', x: 2, y: 2, radius: 3, color: '#ffaa66', on: true }],
  regions: [{ id: 'r1', name: 'Comptoir', x: 1, y: 1, w: 3, h: 2, gmOnly: false }],
  entry: { x: 8, y: 5 }, traced: { by: 'agent', at: '2026-11-26T00:00:00Z', quality: 'good', notes: '' }, version: 1,
};
const fixtureB = { ...fixtureA, id: 'lib_test-no-image', slug: 'test-no-image', name: 'Missing Image', nameFr: 'Image absente', image: 'absent.jpg', theme: 'street', traced: { quality: 'rough' }, walls: fixtureA.walls.slice(0, 2), regions: [], lights: [], entry: undefined };
fs.writeFileSync(path.join(gitDir, 'test-dive-bar.json'), JSON.stringify(fixtureA, null, 2));
fs.writeFileSync(path.join(gitDir, 'test-no-image.json'), JSON.stringify(fixtureB, null, 2));
fs.writeFileSync(path.join(gitDir, 'library.json'), JSON.stringify({ not: 'an entry' })); // ignored (runtime file name)

const tables = [
  { id: 'alpha', name: 'Alpha', pack: 'project-lazarus', gmPassword: 'alpha-pw' },
  { id: 'beta', name: 'Beta', pack: 'vierge', gmPassword: 'beta-pw' },
];
const env = { SR_MAPLIB_SOURCE: gitDir };
let srv = await startServer({ port: 3910, tables, runtime, keepRuntime: true, env });
const H = (tok) => ({ Authorization: `Bearer ${tok}` });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
try {
  const gmA = await login(srv.url, { role: 'gm', password: 'alpha-pw', table: 'alpha' });
  const gmB = await login(srv.url, { role: 'gm', password: 'beta-pw', table: 'beta' });
  const plA = await login(srv.url, { role: 'player', name: 'Testeuse', table: 'alpha' });
  const admin = await srv.admin();
  const get = (p, tok, table) => fetch(srv.url + p, { headers: { ...(tok ? H(tok) : {}), ...(table ? { 'X-SR-Table': table } : {}) } }).then(json);
  const adminCall = (p, method = 'GET', body) => fetch(srv.url + p, { method, headers: { ...H(admin), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(json);

  // -------------------------------------------------------------------------
  section('boot seeding from git + Foundry fragmaps-free scenes');
  let lib = await get('/api/maplib', gmA, 'alpha');
  ok(lib.status === 200, 'GM lists the library');
  const bySlug = (l) => Object.fromEntries(l.body.maps.map((m) => [m.slug, m]));
  let L1 = bySlug(lib);
  ok(L1['test-dive-bar']?.version === 1 && L1['test-dive-bar'].origin === 'git', 'git entry seeded at version 1');
  ok(L1['test-dive-bar'].nameFr === 'Bar miteux' && L1['test-dive-bar'].quality === 'good' && L1['test-dive-bar'].hasImage && L1['test-dive-bar'].hasThumb, 'git entry fields + files');
  ok(L1['test-no-image'] && !L1['test-no-image'].hasImage, 'entry with a missing image is listed');
  ok(!L1.library && !L1['not'], 'library.json of the git folder is not an entry');
  ok(L1['back-alley']?.source === 'fragmaps-free' && L1['back-alley'].counts.walls === 49, 'Foundry fragmaps-free scene migrated (walls from the seed map)');
  ok(!['club-house', 'garage', 'seattle', 'appartement', 'apartement', 'testchronos', 'office-floor', 'bar'].some((s) => L1[s]), 'custom Foundry maps stay out of the library');
  ok(!('usedBy' in L1['back-alley']), 'usedBy is admin-only');
  ok((await get('/api/maplib', plA, 'alpha')).status === 403, 'players cannot list the library');
  ok((await get('/api/maplib', null)).status === 403 || (await get('/api/maplib', null)).status === 401, 'anonymous cannot list the library');
  const detail = await get('/api/maplib/test-dive-bar', gmA, 'alpha');
  ok(detail.status === 200 && detail.body.walls.length === 4 && detail.body.entry.x === 8, 'GM reads one entry with walls');

  // -------------------------------------------------------------------------
  section('image auth');
  const img = (slug, k, kind = 'image') => fetch(`${srv.url}/api/maplib/${kind}/${slug}${k != null ? `?k=${encodeURIComponent(k)}` : ''}`);
  ok((await img('test-dive-bar')).status === 401, 'no key → 401');
  ok((await img('test-dive-bar', 'garbage.sig')).status === 403, 'bad key → 403');
  const keyP = await get('/api/maplib/key', plA, 'alpha');
  ok(keyP.status === 200 && keyP.body.k, 'player gets a key');
  ok((await get('/api/maplib/key', null)).status === 401, 'anonymous gets no key');
  let r = await img('test-dive-bar', keyP.body.k);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && /private/.test(r.headers.get('cache-control')), 'player key → image');
  const bytes = Buffer.from(await r.arrayBuffer());
  ok(bytes[0] === 0xff && bytes[1] === 0xd8, 'JPEG bytes');
  r = await img('test-dive-bar', keyP.body.k, 'thumb');
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'thumbnail');
  r = await img('test-no-image', keyP.body.k);
  ok(r.status === 200 && r.headers.get('x-maplib-missing') === '1' && /svg/.test(r.headers.get('content-type')) && /no-store/.test(r.headers.get('cache-control')), 'missing image → placeholder, not cached');
  ok((await img('nope', keyP.body.k)).status === 404, 'unknown slug → 404');
  // Forged keys signed with the real key file: other session / unknown user / expired.
  const keyHex = fs.readFileSync(path.join(runtime, 'maplib-sign.key'), 'utf8').trim();
  const sign = (data) => {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update('maplib:' + payload).digest('base64url')}`;
  };
  const real = JSON.parse(Buffer.from(keyP.body.k.split('.')[0], 'base64url').toString());
  ok((await img('test-dive-bar', sign(real))).status === 200, 'test signer matches the server');
  ok((await img('test-dive-bar', sign({ ...real, s: 'deadsession00000' }))).status === 403, 'dead session → 403');
  ok((await img('test-dive-bar', sign({ ...real, u: 'usr_ghost' }))).status === 403, 'unknown user → 403');
  ok((await img('test-dive-bar', sign({ ...real, t: 'nowhere' }))).status === 403, 'unknown table → 403');
  ok((await img('test-dive-bar', sign({ ...real, e: Math.floor(Date.now() / 1000) - 10 }))).status === 403, 'expired → 403');
  ok((await img('test-dive-bar', sign({ a: 1, s: 'x', e: real.e }))).status === 403, 'forged admin key → 403');
  const keyAdmin = await adminCall('/api/admin/maplib/key');
  ok((await img('test-dive-bar', keyAdmin.body.k, 'thumb')).status === 200, 'admin session key → thumbnail');
  for (const p of ['/api/maplib/image/', '/api/maplib/image', '/maplib/images/dive%20bar.jpg', '/maplib/library.json', '/data/maplib/test-dive-bar.json']) {
    const x = await fetch(srv.url + p);
    ok(x.status === 404 || x.status === 401 || x.status === 403, `no listing / static access: ${p} → ${x.status}`);
  }

  // -------------------------------------------------------------------------
  section('instances: fromLibrary in table A only');
  const A = await client(srv.url, gmA, { table: 'alpha' });
  const B = await client(srv.url, gmB, { table: 'beta' });
  const mapA = await A.send('maps/fromLibrary', { slug: 'test-dive-bar' });
  const instA = await until(() => A.state.maps[mapA]);
  ok(instA?.library?.slug === 'test-dive-bar' && instA.library.version === 1, 'instance linked to the library version');
  ok(instA.name === 'Bar miteux' && instA.folder === 'Bibliothèque', 'French name + default folder');
  ok(instA.width === 10 && instA.height === 7 && instA.metersPerCell === 1.5 && instA.lighting === 'dim' && instA.theme === 'bar', 'geometry + ambience copied');
  ok(instA.background?.url === '/api/maplib/image/test-dive-bar' && instA.background.mode === 'image' && instA.background.w === 10, 'image background with the library URL scheme');
  ok(instA.walls.length === 4 && !instA.walls.some((w) => ['w1', 'w2', 'w3', 'd1'].includes(w.id)), 'walls copied with fresh ids');
  ok(instA.lights.length === 1 && instA.regions.some((x) => x.name === 'Comptoir') && instA.regions.some((x) => x.gmOnly && x.name === 'Entrée'), 'lights + regions + entry region');
  ok(!Object.values(B.state.maps || {}).some((m) => m.library?.slug === 'test-dive-bar'), 'table B has no instance');
  await rejects(A.send('maps/fromLibrary', { slug: 'nope' }), /introuvable/, 'unknown library map');
  // Player view: no library data.
  await A.send('maps/setActive', { mapId: mapA });
  const P = await client(srv.url, plA, { table: 'alpha' });
  const pv = await until(() => P.state.maps?.[mapA]);
  ok(pv && !('library' in pv), 'players never receive map.library');
  P.close();

  // Table data on the instance: token, GM note, fog, open door.
  const door = instA.walls.find((w) => w.door);
  await A.send('maps/addToken', { mapId: mapA, token: { name: 'Videur', x: 2, y: 3, disposition: 'hostile' } });
  await A.send('maps/addNote', { mapId: mapA, note: { x: 1, y: 1, text: 'Le barman est un indic' } });
  await A.send('maps/addRegion', { mapId: mapA, region: { name: 'Planque secrète', x: 7, y: 1, w: 2, h: 2, gmOnly: true } });
  await A.send('maps/setDoor', { mapId: mapA, doorId: door.id, state: 'open' });
  await settle(300);

  // -------------------------------------------------------------------------
  section('publish from table B → new version + history');
  const mapB = await B.send('maps/fromLibrary', { slug: 'test-dive-bar', name: 'Bar de Beta', folder: 'Lieux' });
  const instB = await until(() => B.state.maps[mapB]);
  ok(instB.name === 'Bar de Beta' && instB.folder === 'Lieux', 'custom name / folder');
  ok(!A.state.maps[mapB], 'table A does not see B’s instance');
  await B.send('maps/addWall', { mapId: mapB, wall: { x1: 0, y1: 7, x2: 10, y2: 7 } });
  await B.send('maps/addToken', { mapId: mapB, token: { name: 'Espion', x: 1, y: 1 } });
  await B.send('maps/addNote', { mapId: mapB, note: { x: 2, y: 2, text: 'secret de Beta' } });
  await B.send('maps/addRegion', { mapId: mapB, region: { name: 'Spoiler MJ', x: 0, y: 0, w: 1, h: 1, gmOnly: true } });
  const dB = await B.send('maps/libraryDiff', { mapId: mapB });
  ok(dB.diff.walls.remove === 1 && dB.current === 1 && dB.latest === 1, 'diff sees the extra wall');
  const pubB = await B.send('maps/publishToLibrary', { mapId: mapB });
  ok(pubB.version === 2, 'publish → version 2');
  const v2 = await get('/api/maplib/test-dive-bar', gmA, 'alpha');
  ok(v2.body.version === 2 && v2.body.walls.length === 5, 'library has the new wall');
  ok(!JSON.stringify(v2.body).includes('Espion') && !JSON.stringify(v2.body).includes('secret de Beta') && !JSON.stringify(v2.body).includes('Spoiler MJ'), 'tokens, notes, GM-only regions never published');
  ok(v2.body.walls.filter((w) => w.door).every((w) => w.door.state === 'closed'), 'doors published closed');
  ok(v2.body.entry?.x === 8, 'entry point kept');
  let adm = await adminCall('/api/admin/maplib');
  let E = adm.body.maps.find((m) => m.slug === 'test-dive-bar');
  ok(E.history.length === 1 && E.history[0].version === 1 && E.origin === 'edited' && E.versionInfo.by.tableId === 'beta', 'history + origin edited + author');
  ok(E.usedBy.length === 2 && E.usedBy.some((u) => u.tableId === 'alpha') && E.usedBy.some((u) => u.tableId === 'beta'), 'usedBy lists both tables');

  // -------------------------------------------------------------------------
  section('libraryUpdate keeps tokens / notes / fog / door states');
  // Give a player some fog memory on A's instance.
  const st0 = A.state.maps[mapA];
  ok(st0.tokens.length === 1 && st0.notes.length === 1, 'instance has table data');
  const dA = await A.send('maps/libraryDiff', { mapId: mapA });
  ok(dA.current === 1 && dA.latest === 2 && dA.diff.walls.add === 1 && dA.diff.keptDoorStates === 1, 'A sees the update (+1 wall, 1 door state kept)');
  const up = await A.send('maps/libraryUpdate', { mapId: mapA });
  ok(up.version === 2, 'update → version 2');
  const after = await until(() => A.state.maps[mapA]?.library?.version === 2 && A.state.maps[mapA]);
  ok(after.walls.length === 5, 'walls re-synced');
  ok(after.tokens.length === 1 && after.tokens[0].name === 'Videur', 'tokens kept');
  ok(after.notes.length === 1 && after.notes[0].text === 'Le barman est un indic', 'GM notes kept');
  ok(after.regions.some((x) => x.name === 'Planque secrète' && x.gmOnly), 'GM-only regions kept');
  ok(after.regions.filter((x) => x.name === 'Entrée').length === 1, 'entry region not duplicated');
  ok(after.walls.find((w) => w.door)?.door.state === 'open', 'door state kept at the same position');
  ok(after.fog === true && after.background.url === '/api/maplib/image/test-dive-bar', 'fog + background kept');
  ok((await A.send('maps/libraryDiff', { mapId: mapA })).diff.same, 'in sync after the update');

  // -------------------------------------------------------------------------
  section('stale publish, force, admin-only setting, custom maps');
  await B.send('maps/addLight', { mapId: mapB, light: { x: 8, y: 5, radius: 2 } });
  ok((await B.send('maps/publishToLibrary', { mapId: mapB })).version === 3, 'B publishes v3');
  await A.send('maps/removeWall', { mapId: mapA, wallId: A.state.maps[mapA].walls[0].id });
  await rejects(A.send('maps/publishToLibrary', { mapId: mapA }), /a changé/, 'A (at v2) cannot overwrite v3 without force');
  ok((await A.send('maps/publishToLibrary', { mapId: mapA, force: true })).version === 4, 'force → v4');
  adm = await adminCall('/api/admin/maplib');
  E = adm.body.maps.find((m) => m.slug === 'test-dive-bar');
  ok(E.history.map((h) => h.version).join() === '3,2,1', `history keeps the previous versions (${E.history.map((h) => h.version)})`);
  const custom = await A.send('maps/create', { name: 'Ma carte perso', width: 8, height: 8 });
  await rejects(A.send('maps/publishToLibrary', { mapId: custom }), /Seules les cartes/, 'custom maps cannot publish');
  await rejects(A.send('maps/libraryUpdate', { mapId: custom }), /ne vient pas/, 'custom maps cannot update');
  let set = await adminCall('/api/admin/maplib/settings', 'PATCH', { publishAdminOnly: true });
  ok(set.body.settings.publishAdminOnly === true, 'admin-only publishing on');
  await rejects(B.send('maps/publishToLibrary', { mapId: mapB, force: true }), /réservée à l’administrateur/, 'GM refused when admin-only');
  ok((await B.send('maps/libraryDiff', { mapId: mapB })).publishAllowed === false, 'diff tells the UI');
  const pubAdm = await adminCall('/api/admin/maplib/test-dive-bar/publish', 'POST', { tableId: 'beta', mapId: mapB, force: true });
  ok(pubAdm.status === 200 && pubAdm.body.version === 5, 'admin publishes from table B (v5)');
  ok((await adminCall('/api/admin/maplib/test-dive-bar/publish', 'POST', { tableId: 'alpha', mapId: custom })).status === 400, 'admin cannot publish a custom map');
  await adminCall('/api/admin/maplib/settings', 'PATCH', { publishAdminOnly: false });

  // -------------------------------------------------------------------------
  section('rollback, revert to origin, rename, delete');
  const rb = await adminCall('/api/admin/maplib/test-dive-bar/rollback', 'POST', { version: 2 });
  ok(rb.status === 200 && rb.body.version === 6, 'rollback v2 → v6');
  let cur = await get('/api/maplib/test-dive-bar', gmA, 'alpha');
  ok(cur.body.walls.length === 5 && cur.body.counts.lights === 1, 'v6 has v2’s content');
  ok((await adminCall('/api/admin/maplib/test-dive-bar/rollback', 'POST', { version: 99 })).status === 400, 'unknown version refused');
  const rv = await adminCall('/api/admin/maplib/test-dive-bar/revert', 'POST');
  ok(rv.status === 200 && rv.body.version === 7 && rv.body.entry.origin === 'git', 'revert to the git original (v7, origin git)');
  cur = await get('/api/maplib/test-dive-bar', gmA, 'alpha');
  ok(cur.body.walls.length === 4, 'original walls back');
  const pt = await adminCall('/api/admin/maplib/test-dive-bar', 'PATCH', { nameFr: 'Bar des docks', tags: ['docks', 'bar'] });
  ok(pt.status === 200 && pt.body.entry.nameFr === 'Bar des docks', 'admin rename');
  ok((await adminCall('/api/admin/maplib/test-no-image', 'DELETE', { confirm: 'wrong' })).status === 400, 'delete needs confirmation');
  ok((await adminCall('/api/admin/maplib/test-no-image', 'DELETE', { confirm: 'test-no-image' })).status === 200, 'delete');
  lib = await get('/api/maplib', gmA, 'alpha');
  ok(!lib.body.maps.some((m) => m.slug === 'test-no-image'), 'deleted entry hidden');
  ok((await img('test-no-image', keyP.body.k)).status === 200, 'deleted entry still serves its image (existing instances)');
  ok((await adminCall('/api/admin/maplib', 'GET')).status === 200 && (await fetch(srv.url + '/api/admin/maplib')).status === 401, 'admin routes need the admin token');

  // -------------------------------------------------------------------------
  section('admin upload → new entry');
  const up1 = await fetch(`${srv.url}/api/admin/maplib/upload?slug=test-upload&name=Upload&nameFr=T%C3%A9l%C3%A9vers%C3%A9e&gridPx=25`, {
    method: 'POST', headers: { ...H(admin), 'content-type': 'application/octet-stream', 'x-filename': 'upload.jpg' }, body: makeJpeg(250, 150, [10, 10]),
  }).then(json);
  ok(up1.status === 200 && up1.body.entry.width === 10 && up1.body.entry.height === 6 && up1.body.entry.hasImage, 'upload creates the entry (10 × 6 cells)');
  ok(up1.body.thumb === true && fs.existsSync(path.join(runtime, 'maplib', 'thumbs', 'test-upload.jpg')), 'thumbnail made in a worker');
  const up2 = await fetch(`${srv.url}/api/admin/maplib/upload?slug=test-upload&gridPx=25`, { method: 'POST', headers: { ...H(admin), 'x-filename': 'u.jpg' }, body: makeJpeg(10, 10, [0, 0]) }).then(json);
  ok(up2.status === 409, 'existing slug needs replace=1');
  const up3 = await fetch(`${srv.url}/api/admin/maplib/upload?slug=test-bad&gridPx=25`, { method: 'POST', headers: { ...H(admin), 'x-filename': 'u.jpg' }, body: Buffer.from('not an image') }).then(json);
  ok(up3.status === 400, 'non-image refused');
  ok(!fs.readdirSync(path.join(runtime, 'maplib', 'images')).some((f) => f.endsWith('.part')), 'no temp file left');
  const mapU = await B.send('maps/fromLibrary', { slug: 'test-upload' });
  ok((await until(() => B.state.maps[mapU]))?.walls.length === 0, 'uploaded map can be added (no walls yet)');

  // -------------------------------------------------------------------------
  section('migration of map_fvtt_* table maps');
  const fv = A.state.maps['map_fvtt_back-alley'];
  ok(fv?.library?.slug === 'back-alley' && fv.library.migrated, 'map_fvtt_back-alley linked to the library');
  ok(fv.background.url === '/assets/foundry/scenes/backalley.jpg' && fv.walls.length === 49, 'table data untouched (background URL, walls)');
  ok(!A.state.maps['map_fvtt_club-house']?.library, 'custom Foundry map not linked');
  ok(!Object.values(B.state.maps).some((m) => m.library?.migrated), 'vierge table has nothing to migrate');
  const linkedAt = fv.library.linkedAt;
  const libFile = path.join(runtime, 'maplib', 'library.json');
  const before = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  A.close();
  B.close();

  // Restart: same runtime, a git file changed (origin git → upgraded; edited entries untouched).
  fs.writeFileSync(path.join(gitDir, 'test-dive-bar.json'), JSON.stringify({ ...fixtureA, walls: fixtureA.walls.slice(0, 3), version: 2 }, null, 2));
  await settle(2600); // debounced save (a Windows kill skips the shutdown flush)
  await srv.stopAndWait({ keep: true });
  srv = await startServer({ port: 3911, tables: [], runtime, keepRuntime: true, env, bootstrap: false });
  const gmA2 = await login(srv.url, { role: 'gm', password: 'alpha-pw', table: 'alpha' });
  const A2 = await client(srv.url, gmA2, { table: 'alpha' });
  const fv2 = A2.state.maps['map_fvtt_back-alley'];
  ok(fv2?.library?.slug === 'back-alley' && fv2.library.linkedAt === linkedAt, 'migration idempotent (link unchanged)');
  const after2 = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  const fvttSlugs = (x) => Object.values(x.maps).filter((m) => m.source === 'fragmaps-free').map((m) => `${m.slug}@${m.version}`).sort().join();
  ok(fvttSlugs(after2) === fvttSlugs(before) && fvttSlugs(after2).split(',').length === 19, `no duplicate fragmaps-free entries (${fvttSlugs(after2).split(',').length})`);
  ok(after2.maps['test-dive-bar'].version === 8 && after2.maps['test-dive-bar'].counts.walls === 3, 'git change applied to an origin-git entry (v8)');
  ok(after2.maps['test-dive-bar'].overrides?.nameFr === 'Bar des docks', 'admin rename survives the git update');
  ok(A2.state.maps[mapA]?.library?.version === 4, 'table instances are not touched by library changes (still v4)');
  // Edit then change git again: the edited entry is not overwritten.
  await A2.send('maps/libraryUpdate', { mapId: mapA });
  await A2.send('maps/publishToLibrary', { mapId: mapA });
  A2.close();
  fs.writeFileSync(path.join(gitDir, 'test-dive-bar.json'), JSON.stringify({ ...fixtureA, walls: fixtureA.walls.slice(0, 2), version: 3 }, null, 2));
  await settle(2600); // debounced save (a Windows kill skips the shutdown flush)
  await srv.stopAndWait({ keep: true });
  srv = await startServer({ port: 3912, tables: [], runtime, keepRuntime: true, env, bootstrap: false });
  const after3 = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  ok(after3.maps['test-dive-bar'].origin === 'edited' && after3.maps['test-dive-bar'].counts.walls !== 2 && after3.maps['test-dive-bar'].gitNewer?.version === 3, 'git never overwrites an edited entry (gitNewer flagged)');
} catch (err) {
  failures++;
  console.error('  ✗ exception', err);
} finally {
  await srv.stopAndWait({ keep: true }).catch(() => {});
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
