// Multi-table hosting tests: node tools/test-tables.ts  (ports 3500-3599)
// zip library · two isolated tables (state, broadcasts, events, uploads, docs, vision cache, combat undo) ·
// cross-table auth · admin API (create/rename/hide/archive/password/backup/delete/restore) · legacy migration ·
// Foundry zip upload (zip-slip, size cap, cross-table world paths).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient, TestServer } from './test-client.ts';
import type { Campaign } from '../shared/types.ts';
import { writeZipFile, listZip, extractZip, safeEntryPath, ZipError } from '../server/lib/zip.ts';

let passed = 0;
let failed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ✗ ' + msg);
  }
};
const section = (s: string) => console.log('• ' + s);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-tables-'));
const servers: TestServer[] = [];
const sockets: TestClient[] = [];
const track = (c: TestClient) => (sockets.push(c), c);
/** Session token a client connected with. */
const tokenOf = (c: TestClient) => (c.socket.auth as { token: string }).token;
const H = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
/** Parsed JSON body of an HTTP response: shapes vary per route, hence `any`. */
async function json<T = any>(res: Response): Promise<T> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t } as T;
  }
}
async function rejects(p: Promise<unknown>, re: RegExp, msg: string) {
  try {
    await p;
    ok(false, msg + ' (no error)');
  } catch (err) {
    const m = (err as Error).message;
    ok(re.test(m), `${msg} (got: ${m})`);
  }
}

const actor = (id: string, name: string, extra: object = {}) => ({
  id, type: 'pc', name, metatype: 'Humain', color: '#3fd6d0',
  attributes: { BOD: 3, AGI: 4, REA: 3, STR: 3, WIL: 3, LOG: 3, INT: 3, CHA: 3, EDG: 3, ESS: 6 },
  condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 3 },
  skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [], contacts: [], sins: [],
  karma: 0, karmaTotal: 0, nuyen: 0, history: [], ...extra,
});
/** Same map id in both tables; only alpha has a wall between the PC and the NPC. */
/** GET /api/tables (picker). */
interface PublicTables { tables: Array<{ slug: string; name: string }> }
/** GET /api/admin/tables. */
interface AdminTables { tables: Array<{ id: string; name: string; sizeBytes: number }>; packs: Array<{ id: string }> }
/** foundry/worlds action result. */
interface FoundryWorlds { worlds: Array<{ id: string }>; localPaths: boolean; detected: string }
/** <runtime>/server.json (tables registry). */
interface Registry { tables: Array<{ id: string; name: string; pack: string; legacy?: boolean }> }

function tableState(name: string, gmPassword: string, wall: boolean) {
  const row = wall ? '#...#....#' : '#........#';
  return {
    version: 1,
    config: { gmPassword, campaignName: name, lang: 'fr' },
    users: {}, log: [],
    actors: { pc1: actor('pc1', `Runner ${name}`), npc1: { ...actor('npc1', 'Garde'), type: 'npc' } },
    scene: { activeMapId: 'map_same' },
    maps: {
      map_same: {
        id: 'map_same', name: 'Même id', width: 10, height: 5, metersPerCell: 1, lighting: 'bright', fog: true, sharedVision: true,
        tiles: ['##########', row, row, row, '##########'], doors: [], lights: [], regions: [], notes: [], explored: {},
        tokens: [
          { id: 'tok_pc', actorId: 'pc1', name: 'PJ', x: 1, y: 2, size: 1, disposition: 'pc', hidden: false },
          { id: 'tok_npc', actorId: 'npc1', name: 'Garde', x: 8, y: 2, size: 1, disposition: 'hostile', hidden: false },
        ],
      },
    },
  };
}

try {
  // -------------------------------------------------------------------------
  section('zip library');
  {
    const src = path.join(tmpRoot, 'src');
    fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.json'), JSON.stringify({ hello: 'monde', n: [1, 2, 3] }).repeat(50));
    fs.writeFileSync(path.join(src, 'sub', 'deep', 'img.png'), Buffer.alloc(5000, 7));
    fs.writeFileSync(path.join(src, 'Scène été.md'), '# Accents ok');
    const zip = path.join(tmpRoot, 'ok.zip');
    await writeZipFile(zip, [
      { name: 'a.json', file: path.join(src, 'a.json') },
      { name: 'sub/deep/img.png', file: path.join(src, 'sub', 'deep', 'img.png') },
      { name: 'Scène été.md', file: path.join(src, 'Scène été.md') },
      { name: 'inline.txt', data: 'texte' },
    ]);
    const entries = listZip(zip);
    ok(entries.length === 4 && entries.some((e) => e.name === 'Scène été.md'), 'writeZip/listZip roundtrip (utf-8 names)');
    const out = path.join(tmpRoot, 'out');
    const r = await extractZip(zip, out);
    ok(r.files === 4, 'extractZip extracts every file');
    ok(fs.readFileSync(path.join(out, 'a.json'), 'utf8') === fs.readFileSync(path.join(src, 'a.json'), 'utf8'), 'deflated content intact');
    ok(fs.readFileSync(path.join(out, 'sub', 'deep', 'img.png')).equals(Buffer.alloc(5000, 7)), 'stored content intact');
    ok(fs.readFileSync(path.join(out, 'Scène été.md'), 'utf8') === '# Accents ok', 'accented file name extracted');
    for (const bad of ['../x', '/etc/passwd', 'C:/Windows/x', 'a/../../b', 'a\\..\\..\\b', '..', 'x\0y']) ok(safeEntryPath(bad) === null, `safeEntryPath rejects ${JSON.stringify(bad)}`);
    ok(safeEntryPath('./a//b/c.txt') === 'a/b/c.txt', 'safeEntryPath normalizes');
    const evil = path.join(tmpRoot, 'evil.zip');
    await writeZipFile(evil, [{ name: 'fine.txt', data: 'ok' }, { name: '../../evil-outside.txt', data: 'pwned' }]);
    const out2 = path.join(tmpRoot, 'out2', 'inner');
    await rejects(extractZip(evil, out2), /Forbidden path/, 'zip-slip archive rejected');
    ok(!fs.existsSync(path.join(tmpRoot, 'evil-outside.txt')) && !fs.existsSync(path.join(out2, 'fine.txt')), 'nothing written when an entry is dangerous');
    // Tampered size: an entry inflating to more than announced is refused.
    const bomb = path.join(tmpRoot, 'bomb.zip');
    await writeZipFile(bomb, [{ name: 'big.txt', data: 'A'.repeat(100000) }]);
    const buf = fs.readFileSync(bomb);
    const cen = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(10, cen + 24); // claim 10 bytes uncompressed
    fs.writeFileSync(bomb, buf);
    await rejects(extractZip(bomb, path.join(tmpRoot, 'out3')), /larger than the archive says|CRC|corrupt/i, 'entry larger than declared rejected');
    ok(ZipError && true, 'ZipError exported');
  }

  // -------------------------------------------------------------------------
  section('two isolated tables');
  const srv = await startServer({
    port: 3501,
    env: { SR_FOUNDRY_LOCAL_PATHS: '0', SR_MAX_UPLOAD_BYTES: '200000' },
    tables: [
      { id: 'alpha', name: 'Alpha', pack: 'blank', state: tableState('Alpha', 'secret-alpha', true) },
      { id: 'beta', name: 'Beta', pack: 'project-lazarus', state: tableState('Beta', 'secret-beta', false) },
    ],
  });
  servers.push(srv);
  const health = await json(await fetch(srv.url + '/api/health'));
  ok(health.ok === true && health.tables === 2, 'health route: 2 tables open');
  const pub = await json<PublicTables>(await fetch(srv.url + '/api/tables'));
  ok(pub.tables.map((t) => t.slug).sort().join() === 'alpha,beta', 'public table list');
  const rootRes = await fetch(srv.url + '/', { redirect: 'manual' });
  ok(rootRes.status === 200 && /<div id="app">/.test(await rootRes.text()), '/ with two tables serves the picker page');
  const tRes = await fetch(srv.url + '/t/alpha', { redirect: 'manual' });
  ok(tRes.status === 301 && tRes.headers.get('location') === '/t/alpha/', '/t/alpha redirects to /t/alpha/');
  const tPage = await fetch(srv.url + '/t/alpha/');
  ok(tPage.status === 200 && (tPage.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'table page served with CSP');
  const lobbyA = await json(await fetch(srv.url + '/api/lobby?table=alpha'));
  ok(lobbyA.table?.slug === 'alpha' && lobbyA.campaignName === 'Alpha', 'lobby of alpha');
  ok((await fetch(srv.url + '/api/lobby?table=nope')).status === 404, 'lobby of an unknown table: 404');
  ok((await fetch(srv.url + '/api/lobby')).status === 404, 'lobby without table and no default: 404');

  const gmA = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'secret-alpha', table: 'alpha' }), { table: 'alpha' }));
  const gmATok = tokenOf(gmA);
  const gmB = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'secret-beta', table: 'beta' }), { table: 'beta' }));
  const gmBTok = tokenOf(gmB);
  await rejects(login(srv.url, { role: 'gm', password: 'secret-alpha', table: 'beta' }), /Wrong GM password/, 'alpha password refused on beta');
  const pA = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Ana', characterId: 'pc1', table: 'alpha' }), { table: 'alpha' }));
  const pB = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Bob', characterId: 'pc1', table: 'beta' }), { table: 'beta' }));
  await settle();
  ok(gmA.state.config.table?.slug === 'alpha' && gmA.state.config.lang === 'fr', 'view carries config.table and config.lang');
  ok(Object.keys(gmA.state.users).length === 1 && Object.keys(gmB.state.users).length === 1, 'users are per table');

  // Packs
  const bestA = Object.values(gmA.state.bestiary || {});
  ok(bestA.length > 10 && !bestA.some((t) => /Lazarus|Acte|Passeur|Nachtigall|Foundry/.test(t.folder || '')), `vierge pack: generic bestiary only (${bestA.length})`);
  ok(!gmA.state.bestiary?.tpl_host_hollow_pine, 'vierge pack: no campaign host');
  ok(((gmA.state.campaign as Campaign)?.acts || []).length === 0 && ((gmA.state.campaign as Campaign)?.quests || []).length === 0, 'vierge pack: no acts/quests');
  ok(Object.keys(gmA.state.maps).join() === 'map_same', 'vierge pack: no seeded maps');
  ok(!(gmA.state.shop?.specials || []).length, 'vierge pack: no fixer deals');
  ok(Object.keys(gmB.state.maps).length > 10 && Object.values(gmB.state.bestiary || {}).some((t) => t.folder === 'Project Lazarus'), 'project-lazarus pack seeds beta');

  // Log + broadcasts
  let betaStates = 0;
  gmB.socket.on('state', () => betaStates++);
  pB.socket.on('state', () => betaStates++);
  await gmA.send('chat/send', { text: 'message secret alpha' });
  await gmA.send('ui/announce', { text: 'Bandeau alpha' });
  await pA.send('ui/ping', { mapId: 'map_same', x: 2, y: 2 });
  await settle();
  ok(gmA.state.log.some((e) => e.text === 'message secret alpha'), 'alpha log has its message');
  ok(!gmB.state.log.some((e) => e.text === 'message secret alpha') && !pB.state.log.some((e) => e.text === 'message secret alpha'), 'beta log untouched');
  ok(betaStates === 0, `no broadcast crossed to beta (got ${betaStates})`);
  ok(gmB.state.ui?.announcement !== 'Bandeau alpha', 'announcement stays in alpha');
  ok(gmA.events.some((e) => e.ev === 'ping') && !gmB.events.some((e) => e.ev === 'ping') && !pB.events.some((e) => e.ev === 'ping'), 'transient events stay in their table');

  // Vision: same map id, different walls → separate vision caches
  const visA = pA.state.maps?.map_same?.tokens?.map((t) => t.id) || [];
  const visB = pB.state.maps?.map_same?.tokens?.map((t) => t.id) || [];
  ok(visA.includes('tok_pc') && !visA.includes('tok_npc'), `alpha player: wall hides the NPC (${visA})`);
  ok(visB.includes('tok_npc'), `beta player: no wall, NPC visible (${visB})`);
  await gmB.send('maps/moveToken', { mapId: 'map_same', tokenId: 'tok_npc', x: 7, y: 2 }).catch(() => gmB.send('maps/updateToken', { mapId: 'map_same', tokenId: 'tok_npc', patch: { x: 7 } }));
  await gmA.send('chat/send', { text: 'refresh' });
  await settle();
  ok(!(pA.state.maps.map_same.tokens || []).some((t) => t.id === 'tok_npc'), 'alpha vision still blocked after beta changes (no cache bleed)');
  ok((pB.state.maps.map_same.tokens || []).some((t) => t.id === 'tok_npc'), 'beta vision still open');

  // Combat undo stacks per table
  await gmA.send('combat/start', { mapId: 'map_same' });
  await gmB.send('combat/start', { mapId: 'map_same' });
  await gmA.send('combat/newTurn', {});
  await rejects(gmB.send('combat/prev', {}), /Nothing to undo/, 'beta has no undo from alpha');
  ok((await gmA.send('combat/prev', {})) !== undefined, 'alpha can undo its own turn');

  // Cross-table auth
  const sockBad = await client(srv.url, gmATok, { table: 'beta' }).then((c) => (c.close(), 'connected')).catch((e) => e.message);
  ok(sockBad === 'unauthorized', 'alpha token refused on the beta socket');
  ok((await fetch(srv.url + '/api/admin/export', { headers: H(gmATok, { 'X-SR-Table': 'beta' }) })).status === 403, 'alpha GM token refused on beta HTTP routes');
  const expA = await json(await fetch(srv.url + '/api/admin/export', { headers: H(gmATok) }));
  ok(expA.config?.campaignName === 'Alpha', 'token alone resolves its own table');
  const expB = await json(await fetch(srv.url + '/api/admin/export', { headers: H(gmBTok) }));
  ok(expB.config?.campaignName === 'Beta', 'beta export is beta');
  ok((await fetch(srv.url + '/api/docs', { headers: H(tokenOf(pA)) })).status === 403, 'players cannot read docs');

  // Docs per table
  fs.mkdirSync(path.join(srv.runtime, 'tables', 'alpha', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(srv.runtime, 'tables', 'alpha', 'docs', 'secret-alpha.md'), '# Plan alpha');
  const docsA = await json<Array<{ name: string }>>(await fetch(srv.url + '/api/docs', { headers: H(gmATok) }));
  const docsB = await json<Array<{ name: string }>>(await fetch(srv.url + '/api/docs', { headers: H(gmBTok) }));
  ok(docsA.some((d) => d.name === 'secret-alpha.md'), 'alpha docs listed');
  ok(!docsB.some((d) => d.name === 'secret-alpha.md'), 'beta does not see alpha docs');
  ok((await fetch(srv.url + '/api/docs/secret-alpha.md', { headers: H(gmBTok) })).status === 404, 'beta cannot read alpha doc');

  // Uploads per table
  const up = await json(await fetch(srv.url + '/api/upload', { method: 'POST', headers: H(gmATok, { 'X-Filename': 'carte.png', 'Content-Type': 'application/octet-stream' }), body: Buffer.from('\x89PNG fake') }));
  ok(/^\/t\/alpha\/uploads\/[\w.-]+carte\.png$/.test(up.url || ''), `upload URL is table-scoped (${up.url})`);
  const file = up.url.split('/').pop();
  ok((await fetch(srv.url + up.url)).status === 200, 'uploaded file served under its table');
  ok((await fetch(srv.url + `/t/beta/uploads/${file}`)).status === 404, 'not served under another table');
  ok((await fetch(srv.url + `/uploads/${file}`)).status === 404, 'no legacy /uploads without a legacy table');
  ok(fs.existsSync(path.join(srv.runtime, 'tables', 'alpha', 'uploads', file)), 'stored in tables/alpha/uploads');

  // Foundry zip upload
  section('foundry zip upload');
  const worldDir = path.join(tmpRoot, 'world');
  fs.mkdirSync(path.join(worldDir, 'data', 'actors'), { recursive: true });
  fs.writeFileSync(path.join(worldDir, 'world.json'), JSON.stringify({ id: 'mon-monde', title: 'Mon Monde', system: 'shadowrun5e', coreVersion: '12' }));
  fs.writeFileSync(path.join(worldDir, 'data', 'actors', 'CURRENT'), 'MANIFEST-000001\n');
  const worldZip = path.join(tmpRoot, 'world.zip');
  await writeZipFile(worldZip, [
    { name: 'mon-monde/world.json', file: path.join(worldDir, 'world.json') },
    { name: 'mon-monde/data/actors/CURRENT', file: path.join(worldDir, 'data', 'actors', 'CURRENT') },
  ]);
  const upW = await fetch(srv.url + '/api/foundry/upload?kind=world', { method: 'POST', headers: H(gmATok, { 'Content-Type': 'application/zip' }), body: fs.readFileSync(worldZip) });
  const upWj = await json(upW);
  ok(upW.status === 200 && upWj.world?.id === 'mon-monde', `world zip installed (${upW.status} ${upWj.error || ''})`);
  ok(fs.existsSync(path.join(srv.runtime, 'tables', 'alpha', 'foundry', 'Data', 'worlds', 'mon-monde', 'world.json')), 'world extracted under tables/alpha/foundry/Data/worlds');
  await settle(150);
  const worldsA = await gmA.send<FoundryWorlds>('foundry/worlds', {});
  ok(worldsA.worlds.some((w) => w.id === 'mon-monde') && worldsA.localPaths === false && worldsA.detected === upWj.world.path, 'foundry/worlds lists the uploaded world (no local paths)');
  const worldsB = await gmB.send<FoundryWorlds>('foundry/worlds', {});
  ok(!worldsB.worlds.length, 'beta sees no world of alpha');
  await rejects(gmB.send('foundry/scan', { worldPath: upWj.world.path }), /only worlds uploaded for this table|another table/, 'beta cannot scan alpha’s uploaded world');
  await rejects(gmB.send('foundry/scan', { worldPath: 'C:/Users' }), /only worlds uploaded for this table/, 'local paths refused on a shared server');
  const evilWorld = path.join(tmpRoot, 'evil-world.zip');
  await writeZipFile(evilWorld, [{ name: 'world.json', file: path.join(worldDir, 'world.json') }, { name: '../../../pwned.txt', data: 'x' }]);
  const upE = await fetch(srv.url + '/api/foundry/upload?kind=world', { method: 'POST', headers: H(gmATok, { 'Content-Type': 'application/zip' }), body: fs.readFileSync(evilWorld) });
  ok(upE.status === 400 && /Forbidden path/.test((await json(upE)).error), 'zip-slip world upload rejected (400)');
  ok(!fs.existsSync(path.join(srv.runtime, 'pwned.txt')) && !fs.existsSync(path.join(srv.runtime, 'tables', 'pwned.txt')), 'no file escaped the table folder');
  const evilData = path.join(tmpRoot, 'evil-data.zip');
  await writeZipFile(evilData, [{ name: 'Music/a.mp3', data: 'x' }, { name: 'Music/../../../../escape.txt', data: 'x' }]);
  const upD = await fetch(srv.url + '/api/foundry/upload?kind=data', { method: 'POST', headers: H(gmATok, { 'Content-Type': 'application/zip' }), body: fs.readFileSync(evilData) });
  ok(upD.status === 400, 'zip-slip data upload rejected');
  const big = Buffer.alloc(300000, 1);
  const upBig = await fetch(srv.url + '/api/foundry/upload?kind=data', { method: 'POST', headers: H(gmATok, { 'Content-Type': 'application/zip' }), body: big });
  ok(upBig.status === 413, `upload above SR_MAX_UPLOAD_BYTES refused (${upBig.status})`);
  const notZip = await fetch(srv.url + '/api/foundry/upload?kind=world', { method: 'POST', headers: H(gmATok, { 'Content-Type': 'application/zip' }), body: Buffer.from('not a zip at all') });
  ok(notZip.status === 400, 'garbage upload refused');
  ok((await fetch(srv.url + '/api/foundry/upload?kind=world', { method: 'POST', headers: H(tokenOf(pA)), body: fs.readFileSync(worldZip) })).status === 403, 'players cannot upload worlds');
  const okData = path.join(tmpRoot, 'data.zip');
  await writeZipFile(okData, [{ name: 'Data/Music/theme.mp3', data: 'ID3 fake' }]);
  const upOk = await json(await fetch(srv.url + '/api/foundry/upload?kind=data', { method: 'POST', headers: H(gmATok, { 'Content-Type': 'application/zip' }), body: fs.readFileSync(okData) }));
  ok(upOk.files === 1 && fs.existsSync(path.join(srv.runtime, 'tables', 'alpha', 'foundry', 'Data', 'Music', 'theme.mp3')), 'Data zip installed (top Data/ folder stripped)');
  const delUp = await fetch(srv.url + '/api/foundry/uploads', { method: 'DELETE', headers: H(gmATok) });
  ok(delUp.status === 200 && !fs.existsSync(path.join(srv.runtime, 'tables', 'alpha', 'foundry')), 'uploaded Foundry data removed');

  // -------------------------------------------------------------------------
  section('admin API');
  ok((await fetch(srv.url + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })).status === 403, 'wrong admin password refused');
  const adm = await srv.admin();
  const A = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(srv.url + p, { ...opts, headers: { 'content-type': 'application/json', ...H(adm), ...(opts.headers || {}) } });
  ok((await fetch(srv.url + '/api/admin/tables', { headers: H(gmATok) })).status === 401, 'a GM token is not an admin token');
  const list0 = await json<AdminTables>(await A('/api/admin/tables'));
  ok(list0.tables.length === 2 && list0.packs.length === 3 && list0.packs.some((p) => p.id === 'demo') && list0.tables.every((t) => t.sizeBytes > 0), 'admin list with sizes and packs');
  ok((await A('/api/admin/tables', { method: 'POST', body: JSON.stringify({ name: 'X', slug: 'Bad Slug', pack: 'vierge', gmPassword: 'longenough' }) })).status === 400, 'invalid slug refused');
  ok((await A('/api/admin/tables', { method: 'POST', body: JSON.stringify({ name: 'X', slug: 'alpha', pack: 'vierge', gmPassword: 'longenough' }) })).status === 409, 'duplicate slug refused');
  ok((await A('/api/admin/tables', { method: 'POST', body: JSON.stringify({ name: 'X', slug: 'admin', pack: 'vierge', gmPassword: 'longenough' }) })).status === 400, 'reserved slug refused');
  ok((await A('/api/admin/tables', { method: 'POST', body: JSON.stringify({ name: 'X', slug: 'xx', pack: 'vierge', gmPassword: '123' }) })).status === 400, 'short GM password refused');
  const cr = await A('/api/admin/tables', { method: 'POST', body: JSON.stringify({ name: 'Les Ombres de Lyon', pack: 'vierge', lang: 'en', gmPassword: 'gamma-pass' }) });
  const crj = await json(cr);
  ok(cr.status === 200 && crj.table.id === 'les-ombres-de-lyon', `table created with a slug from its name (${crj.error || crj.table?.id})`);
  const G = 'les-ombres-de-lyon';
  const gmG = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'gamma-pass', table: G }), { table: G }));
  ok(gmG.state.config.lang === 'en' && gmG.state.config.campaignName === 'Les Ombres de Lyon', 'new table: language + name');
  ok(!Object.values(gmG.state.actors).some((a) => a.type === 'pc'), 'new vierge table has no PCs');
  ok((await json<PublicTables>(await fetch(srv.url + '/api/tables'))).tables.some((t) => t.slug === G), 'new table on the picker');
  // rename (state follows) and GM rename (registry follows)
  await A(`/api/admin/tables/${G}`, { method: 'PATCH', body: JSON.stringify({ name: 'Ombres de Lyon' }) });
  await settle();
  ok(gmG.state.config.campaignName === 'Ombres de Lyon', 'admin rename reaches the table view');
  await gmG.send('config/update', { campaignName: 'Lyon 2080' });
  ok((await json<AdminTables>(await A('/api/admin/tables'))).tables.find((t) => t.id === G)!.name === 'Lyon 2080', 'GM campaign rename updates the registry');
  // hide
  await A(`/api/admin/tables/${G}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
  ok(!(await json<PublicTables>(await fetch(srv.url + '/api/tables'))).tables.some((t) => t.slug === G), 'hidden table not on the picker');
  ok((await fetch(srv.url + `/api/lobby?table=${G}`)).status === 200, 'hidden table still reachable by its link');
  // GM password reset
  await A(`/api/admin/tables/${G}/gm-password`, { method: 'POST', body: JSON.stringify({ password: 'nouveau-pass' }) });
  await rejects(login(srv.url, { role: 'gm', password: 'gamma-pass', table: G }), /Wrong GM password/, 'old GM password refused after reset');
  const gTok = await login(srv.url, { role: 'gm', password: 'nouveau-pass', table: G });
  ok(!!gTok, 'new GM password works');
  // admin opens a table as GM
  const gs = await json(await A(`/api/admin/tables/${G}/gm-session`, { method: 'POST' }));
  ok((await fetch(srv.url + '/api/me', { headers: H(gs.token) })).status === 200, 'admin "open as GM" token is a valid GM session');
  // archive
  const gmG2 = track(await client(srv.url, gTok, { table: G }));
  await A(`/api/admin/tables/${G}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
  await settle();
  ok(gmG2.events.some((e) => e.ev === 'unauthorized'), 'archiving disconnects the table’s users');
  ok((await fetch(srv.url + `/api/lobby?table=${G}`)).status === 410, 'archived table: lobby 410');
  await rejects(login(srv.url, { role: 'gm', password: 'nouveau-pass', table: G }), /archived/, 'archived table: no login');
  await A(`/api/admin/tables/${G}`, { method: 'PATCH', body: JSON.stringify({ name: 'Lyon 2081' }) }); // renamed while archived
  await A(`/api/admin/tables/${G}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
  const gmG3 = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'nouveau-pass', table: G }), { table: G }));
  ok(!!gmG3, 'unarchived table: login again');
  ok((await json<AdminTables>(await A('/api/admin/tables'))).tables.find((t) => t.id === G)!.name === 'Lyon 2081' && gmG3.state.config.campaignName === 'Lyon 2081', 'rename while archived survives unarchive');
  // backup download (one-time ticket)
  const tk = await json(await A(`/api/admin/tables/${G}/download`, { method: 'POST', body: '{}' }));
  const dl = await fetch(srv.url + tk.url);
  ok(dl.status === 200 && dl.headers.get('content-type') === 'application/zip', 'table backup zip downloads');
  const backupZip = path.join(tmpRoot, 'gamma.zip');
  fs.writeFileSync(backupZip, Buffer.from(await dl.arrayBuffer()));
  const names = listZip(backupZip).map((e) => e.name);
  ok(names.includes('state.json') && names.includes('table.json') && !names.some((n) => n.startsWith('backups/')), `backup zip content (${names.join(', ')})`);
  ok((await fetch(srv.url + tk.url)).status === 404, 'download ticket is single-use');
  // delete
  ok((await A(`/api/admin/tables/${G}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'wrong' }) })).status === 400, 'delete needs the typed id');
  const del = await json(await A(`/api/admin/tables/${G}`, { method: 'DELETE', body: JSON.stringify({ confirm: G }) }));
  ok(del.ok && fs.existsSync(path.join(srv.runtime, 'deleted', del.backup)), 'deleted table archived in deleted/');
  ok(!fs.existsSync(path.join(srv.runtime, 'tables', G)), 'table folder removed');
  ok((await fetch(srv.url + `/api/lobby?table=${G}`)).status === 404, 'deleted table gone');
  ok((await fetch(srv.url + '/api/me', { headers: H(gs.token) })).status === 401, 'sessions of a deleted table are dead');
  // restore
  const rs = await fetch(srv.url + `/api/admin/restore?slug=${G}`, { method: 'POST', headers: H(adm, { 'Content-Type': 'application/octet-stream' }), body: fs.readFileSync(backupZip) });
  const rsj = await json(rs);
  ok(rs.status === 200 && rsj.table?.name === 'Lyon 2081', `table restored from its zip (${rsj.error || ''})`);
  ok(!!(await login(srv.url, { role: 'gm', password: 'nouveau-pass', table: G })), 'restored table: GM password kept');
  const rs2 = await fetch(srv.url + `/api/admin/restore?slug=${G}`, { method: 'POST', headers: H(adm, { 'Content-Type': 'application/octet-stream' }), body: fs.readFileSync(backupZip) });
  ok(rs2.status === 409, 'restore onto an existing id needs replace');
  const rs3 = await json(await fetch(srv.url + `/api/admin/restore?slug=${G}&replace=1`, { method: 'POST', headers: H(adm, { 'Content-Type': 'application/octet-stream' }), body: fs.readFileSync(backupZip) }));
  ok(rs3.table && rs3.replaced && fs.existsSync(path.join(srv.runtime, 'deleted', rs3.replaced)), 'replace keeps the old version in deleted/');
  const evilRestore = path.join(tmpRoot, 'evil-restore.zip');
  await writeZipFile(evilRestore, [{ name: 'state.json', data: JSON.stringify({ actors: {} }) }, { name: '../../escaped.txt', data: 'x' }]);
  const rsE = await fetch(srv.url + '/api/admin/restore?slug=evil', { method: 'POST', headers: H(adm, { 'Content-Type': 'application/octet-stream' }), body: fs.readFileSync(evilRestore) });
  ok(rsE.status === 400 && !fs.existsSync(path.join(srv.runtime, 'escaped.txt')) && !fs.existsSync(path.join(srv.runtime, 'tables', 'evil')), 'zip-slip restore rejected');
  const rsJ = await json(await fetch(srv.url + '/api/admin/restore?slug=depuis-json&name=Depuis%20JSON', { method: 'POST', headers: H(adm, { 'Content-Type': 'application/octet-stream' }), body: JSON.stringify(expA) }));
  ok(rsJ.table?.id === 'depuis-json' && rsJ.table.name === 'Depuis JSON', 'table restored from a JSON export');
  ok(!!(await login(srv.url, { role: 'gm', password: 'secret-alpha', table: 'depuis-json' })), 'JSON restore keeps its GM password');
  ok((await fetch(srv.url + '/api/admin/restore', { method: 'POST', headers: H(adm, { 'Content-Type': 'application/octet-stream' }), body: 'garbage' })).status === 400, 'garbage restore refused');
  // admin password change
  ok((await A('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: 'bad', next: 'abcdefgh' }) })).status === 403, 'admin password change needs the current one');
  ok((await A('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: srv.adminPassword, next: 'nouveau-admin-pw' }) })).status === 200, 'admin password changed');
  ok(!!(await srv.admin('nouveau-admin-pw')), 'new admin password works');
  // per-table GM routes still scoped: reset of alpha leaves beta alone
  const resetA = await fetch(srv.url + '/api/admin/reset', { method: 'POST', headers: H(gmATok) });
  await settle();
  ok(resetA.status === 200 && !gmA.state.log.some((e) => e.text === 'message secret alpha') && gmB.state.log.length > 0, 'GM reset is scoped to the GM’s table');

  for (const c of sockets.splice(0)) c.close();
  await srv.stopAndWait();
  servers.length = 0;

  // -------------------------------------------------------------------------
  section('legacy migration (data/state.json → table lazarus)');
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-legacy-'));
  fs.mkdirSync(path.join(rt, 'uploads'));
  fs.mkdirSync(path.join(rt, 'backups'));
  fs.writeFileSync(path.join(rt, 'uploads', 'old-map.png'), 'PNGDATA');
  fs.writeFileSync(path.join(rt, 'backups', 'state-2026-01-01T00-00-00-000Z-auto.json'), '{"actors":{}}');
  const legacyState = { ...tableState('Ma Campagne', 'vieux-mdp', false), sessions: { tok_legacy_gm: 'gm' } };
  const srvL = await startServer({ port: 3502, legacyState, runtime: rt });
  servers.push(srvL);
  const reg: Registry = JSON.parse(fs.readFileSync(path.join(rt, 'server.json'), 'utf8'));
  const laz = reg.tables.find((t) => t.id === 'lazarus');
  ok(laz && laz.legacy && laz.name === 'Ma Campagne' && laz.pack === 'project-lazarus', 'registry: lazarus table, legacy, name from the state');
  ok(!fs.existsSync(path.join(rt, 'state.json')), 'old state.json moved away');
  ok(fs.readdirSync(path.join(rt, 'tables', 'lazarus', 'backups')).some((f) => f.startsWith('legacy-state-')), 'original kept as backups/legacy-state-*.json');
  ok(fs.existsSync(path.join(rt, 'tables', 'lazarus', 'backups', 'state-2026-01-01T00-00-00-000Z-auto.json')), 'old backups moved into the table');
  ok(fs.existsSync(path.join(rt, 'tables', 'lazarus', 'uploads', 'old-map.png')), 'old uploads moved into the table');
  const legRoot = await fetch(srvL.url + '/', { redirect: 'manual' });
  ok(legRoot.status === 302 && legRoot.headers.get('location') === '/t/lazarus/', 'single table: / redirects to it (old bookmarks)');
  ok((await fetch(srvL.url + '/?choisir', { redirect: 'manual' })).status === 200, '/?choisir shows the picker anyway');
  ok((await fetch(srvL.url + '/uploads/old-map.png')).status === 200, 'legacy /uploads URLs still served');
  const legacyGm = track(await client(srvL.url, 'tok_legacy_gm'));
  ok(legacyGm.state.config.campaignName === 'Ma Campagne' && legacyGm.state.actors.pc1, 'old session token still valid (no table named)');
  const legacyGm2 = track(await client(srvL.url, 'tok_legacy_gm', { table: 'lazarus' }));
  ok(legacyGm2.state.config.table.slug === 'lazarus', 'old session token valid with the table named');
  ok(!!(await login(srvL.url, { role: 'gm', password: 'vieux-mdp' })), 'login without table → the legacy table');
  const upL = await json(await fetch(srvL.url + '/api/upload', { method: 'POST', headers: H('tok_legacy_gm', { 'X-Filename': 'n.png', 'Content-Type': 'application/octet-stream' }), body: Buffer.from('x') }));
  ok(/^\/uploads\//.test(upL.url || ''), 'legacy table keeps /uploads URLs for new files');
  await legacyGm.send('chat/send', { text: 'après migration' });
  await settle(800); // debounced save (Windows kill() skips the shutdown flush)
  for (const c of sockets.splice(0)) c.close();
  await srvL.stopAndWait({ keep: true });
  servers.length = 0;
  const srvL2 = await startServer({ port: 3503, runtime: rt });
  servers.push(srvL2);
  const again = track(await client(srvL2.url, 'tok_legacy_gm'));
  ok(again.state.log.some((e) => e.text === 'après migration'), 'restart: state persisted, no second migration');
  ok(JSON.parse(fs.readFileSync(path.join(rt, 'server.json'), 'utf8')).tables.length === 1, 'restart: still one table');
  for (const c of sockets.splice(0)) c.close();
  await srvL2.stopAndWait();
  servers.length = 0;

  // -------------------------------------------------------------------------
  section('fresh install bootstrap + orphan adoption');
  const rt2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-boot-'));
  fs.mkdirSync(path.join(rt2, 'tables', 'copiee'), { recursive: true });
  fs.writeFileSync(path.join(rt2, 'tables', 'copiee', 'state.json'), JSON.stringify(tableState('Copiée à la main', 'copie-pw', false)));
  const srvB = await startServer({ port: 3504, runtime: rt2, env: { SR_BOOTSTRAP_TABLE: 'none' } });
  servers.push(srvB);
  const pubB = await json(await fetch(srvB.url + '/api/tables'));
  ok(pubB.tables.length === 1 && pubB.tables[0].slug === 'copiee' && pubB.tables[0].name === 'Copiée à la main', 'a copied table folder is adopted at boot');
  await srvB.stopAndWait();
  servers.length = 0;
  const srvC = await startServer({ port: 3505, env: { SR_BOOTSTRAP_TABLE: 'none' } });
  servers.push(srvC);
  ok((await json(await fetch(srvC.url + '/api/tables'))).tables.length === 0, 'SR_BOOTSTRAP_TABLE=none: empty server');
  ok((await fetch(srvC.url + '/', { redirect: 'manual' })).status === 200, 'empty server serves the picker');
  await srvC.stopAndWait();
  servers.length = 0;
} catch (err) {
  failed++;
  console.error(err);
} finally {
  for (const c of sockets) c.close();
  for (const s of servers) s.stop();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
