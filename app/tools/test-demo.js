// Public demo table tests: node tools/test-demo.js  (ports 3960-3969)
// SR_DEMO_TABLE creation from the « demo » pack · table picker (hidden tables, demo flag, / redirect) · passwordless
// GM login, PIN-less players, shared PCs, user cap, login throttle · refused features (assistant, rulebooks, Foundry,
// import/backup, map library) · upload / body / action / chat caps · idle, GM, boot and size resets · a real table
// next to it keeps its normal rules · an existing table is never turned into a demo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer, login, client, settle } from './test-client.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) passed++;
  else {
    failed++;
    console.log('  ✗ ' + msg);
  }
};
const section = (s) => console.log('• ' + s);
const H = (token, table, extra = {}) => ({ Authorization: `Bearer ${token}`, ...(table ? { 'X-SR-Table': table } : {}), ...extra });
const json = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
};
const rejects = async (p, re, msg) => {
  try {
    await p;
    ok(false, msg + ' (no error)');
  } catch (err) {
    ok(re.test(err.message), `${msg} (got: ${err.message})`);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until fn() is truthy (or timeout). */
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(200);
  }
  return false;
}
const png = (bytes) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, bytes - 8), 1)]);

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-demo-'));
// The assistant settings enable BOTH tables: the demo must refuse anyway.
fs.mkdirSync(path.join(runtime, 'assistant'), { recursive: true });
fs.writeFileSync(path.join(runtime, 'assistant', 'settings.json'), JSON.stringify({ enabledTables: ['demo', 'alpha'] }));
const ENV = {
  SR_DEMO_TABLE: 'demo',
  SR_DEMO_IDLE_MINUTES: '0.05', // 3 s
  SR_DEMO_CHECK_SECONDS: '1',
  SR_DEMO_RESET_HOUR: 'none',
  SR_DEMO_UPLOAD_KB: '600',
  SR_DEMO_UPLOAD_QUOTA_MB: '1',
  SR_DEMO_MAX_USERS: '4',
  SR_DEMO_LOGIN_MAX: '40',
};
let srv = null;
const sockets = [];
const track = (c) => (sockets.push(c), c);

try {
  srv = await startServer({ port: 3960, runtime, keepRuntime: true, env: ENV, tables: [{ id: 'alpha', pack: 'vierge', gmPassword: 'alpha-pw', hidden: true }] });
  const url = srv.url;

  // -------------------------------------------------------------------------
  section('creation from the demo pack');
  const reg = JSON.parse(fs.readFileSync(path.join(runtime, 'server.json'), 'utf8'));
  const meta = reg.tables.find((t) => t.id === 'demo');
  ok(meta && meta.demo === true && meta.pack === 'demo' && !meta.hidden, 'SR_DEMO_TABLE created a visible demo table with the demo pack: ' + JSON.stringify(meta));
  const gmTok = await login(url, { role: 'gm', table: 'demo' }); // no password
  ok(!!gmTok, 'GM login on the demo needs no password');
  ok(!!(await login(url, { role: 'gm', password: 'whatever', table: 'demo' })), 'any GM password is accepted on the demo');
  const gm = track(await client(url, gmTok, { table: 'demo' }));
  const st = gm.state;
  const pcs = Object.values(st.actors).filter((a) => a.type === 'pc');
  ok(pcs.length === 4 && pcs.every((a) => a.id.startsWith('pc_demo_')), '4 pre-made PCs: ' + pcs.map((a) => a.name).join(', '));
  ok(Object.values(st.actors).some((a) => a.type === 'npc' && a.id.startsWith('npc_demo_')), 'demo NPCs present');
  ok(st.scene.activeMapId === 'map_demo_entrepot' && st.maps.map_demo_entrepot.tokens.length >= 8, 'warehouse map is active with its tokens');
  ok(!!st.maps.map_demo_bar, 'map-library copy present');
  const host = st.matrix?.hosts?.host_demo_entrepot;
  ok(host && host.devices.some((d) => d.link?.mapId === 'map_demo_entrepot'), 'Matrix host with map-linked devices');
  ok(!!st.bestiary?.tpl_street_ganger && !!st.bestiary?.tpl_spider_junior, 'vierge bestiary layered under the demo pack');
  ok(st.campaign?.acts?.some((a) => a.id === 'act_demo') && st.campaign?.handouts?.some((h) => h.id === 'ho_demo_brief'), 'demo scenario (act, handout)');
  ok(!JSON.stringify(st).includes('Lazarus'), 'no Project Lazarus content in the demo state');
  ok(st.config.table?.demo === true, 'view config carries the demo flag');

  // -------------------------------------------------------------------------
  section('table picker');
  const list = await json(await fetch(url + '/api/tables'));
  ok(list.tables.length === 1 && list.tables[0].slug === 'demo' && list.tables[0].demo === true, 'only the demo is listed (alpha is hidden): ' + JSON.stringify(list));
  const root = await fetch(url + '/', { redirect: 'manual' });
  ok(root.status === 302 && root.headers.get('location') === '/t/demo/', '/ goes straight to the demo table');
  const lobby = await json(await fetch(url + '/api/lobby?table=demo'));
  ok(lobby.table?.demo === true && lobby.pcs.length === 4, 'lobby flags the demo');

  // -------------------------------------------------------------------------
  section('players: no PIN, shared PCs, user cap');
  const p1 = await login(url, { role: 'player', name: 'Alice', pin: '1234', characterId: 'pc_demo_decker', table: 'demo' });
  const p2 = await login(url, { role: 'player', name: 'Alice', pin: '9999', table: 'demo' });
  ok(!!p1 && !!p2, 'a PIN is ignored on the demo (the same name logs in again)');
  const bob = await login(url, { role: 'player', name: 'Bob', characterId: 'pc_demo_decker', table: 'demo' });
  ok(!!bob, 'two players may share a pre-made PC');
  const alice = track(await client(url, p1, { table: 'demo' }));
  ok(alice.state.users && Object.values(gm.state.users || {}).every((u) => !u.pin), 'no PIN stored');
  await login(url, { role: 'player', name: 'Chloé', table: 'demo' });
  await login(url, { role: 'player', name: 'Dan', table: 'demo' });
  await rejects(login(url, { role: 'player', name: 'Eve', table: 'demo' }), /pleine/, 'user cap (SR_DEMO_MAX_USERS=4)');
  ok(!!(await login(url, { role: 'player', name: 'Dan', table: 'demo' })), 'existing users still log in when full');

  // -------------------------------------------------------------------------
  section('refused features');
  const statusD = await json(await fetch(url + '/api/assistant/status', { headers: H(gmTok, 'demo') }));
  ok(statusD.enabled === false, 'assistant status: off on the demo even when enabled in the settings');
  const ask = await fetch(url + '/api/assistant/ask', { method: 'POST', headers: H(gmTok, 'demo', { 'content-type': 'application/json' }), body: JSON.stringify({ question: 'hello' }) });
  ok(ask.status === 403, 'assistant ask refused: ' + ask.status);
  const alphaTok = await login(url, { role: 'gm', password: 'alpha-pw', table: 'alpha' });
  const statusA = await json(await fetch(url + '/api/assistant/status', { headers: H(alphaTok, 'alpha') }));
  ok(statusA.enabled === true, 'a real table keeps its assistant setting');
  const adminTok = await srv.admin();
  const asst = await json(await fetch(url + '/api/admin/assistant', { method: 'PATCH', headers: H(adminTok, null, { 'content-type': 'application/json' }), body: JSON.stringify({ enabledTables: ['demo', 'alpha'] }) }));
  ok(!asst.settings.enabledTables.includes('demo') && asst.settings.enabledTables.includes('alpha') && !asst.tables.some((t) => t.id === 'demo'), 'admin cannot enable the assistant on the demo');
  for (const [p, m] of [['/api/books/search?q=test', 'GET'], ['/api/books/SR5/page/1', 'GET'], ['/api/books/SR5/file', 'GET'], ['/api/foundry/uploads', 'GET'], ['/api/foundry/upload', 'POST'], ['/api/admin/backup', 'POST'], ['/api/maplib', 'GET'], ['/api/maplib/dive-bar', 'GET']]) {
    const r = await fetch(url + p, { method: m, headers: H(gmTok, 'demo') });
    const j = await json(r);
    ok(r.status === 403 && j.code === 'demo', `${m} ${p} refused on the demo (${r.status})`);
  }
  const books = await json(await fetch(url + '/api/books', { headers: H(gmTok, 'demo') }));
  ok(Array.isArray(books.books) && books.books.length === 0, 'the book list answers an empty library on the demo');
  const imp = await fetch(url + '/api/admin/import', { method: 'POST', headers: H(gmTok, 'demo', { 'content-type': 'application/json' }), body: JSON.stringify({ actors: {} }) });
  ok(imp.status === 403, 'state import refused: ' + imp.status);
  ok((await fetch(url + '/api/books', { headers: H(alphaTok, 'alpha') })).status === 200, 'rulebooks route still open on a real table');
  ok((await fetch(url + '/api/admin/export', { headers: H(gmTok, 'demo') })).status === 200, 'export still works on the demo');
  await rejects(gm.send('foundry/worlds', {}), /Désactivé/, 'Foundry actions refused');
  await rejects(gm.send('maps/fromLibrary', { slug: 'gas-station' }), /Désactivé/, 'library copies refused');
  await rejects(gm.send('maps/publishToLibrary', { mapId: 'map_demo_bar' }), /Désactivé/, 'library publishing refused');
  // Library images: only those of the demo's own maps.
  const key = await json(await fetch(url + '/api/maplib/key', { headers: H(gmTok, 'demo') }));
  const own = await fetch(`${url}/api/maplib/image/dive-bar?k=${encodeURIComponent(key.k)}`);
  ok(own.status === 200, 'image of a demo map is served (placeholder without the artwork): ' + own.status);
  const other = await fetch(`${url}/api/maplib/image/gas-station?k=${encodeURIComponent(key.k)}`);
  ok(other.status === 404, 'other library images are not served to the demo: ' + other.status);

  // -------------------------------------------------------------------------
  section('uploads and body caps');
  const up = (tok, table, name, buf, extra = {}) => fetch(url + '/api/upload', { method: 'POST', headers: H(tok, table, { 'X-Filename': name, 'content-type': 'application/octet-stream', ...extra }), body: buf });
  const u1 = await up(gmTok, 'demo', 'a.png', png(500 * 1024));
  ok(u1.status === 200, 'small image accepted: ' + u1.status);
  ok((await up(gmTok, 'demo', 'x.svg', Buffer.from('<svg/>'))).status === 400, 'SVG refused on the demo');
  ok((await up(gmTok, 'demo', 'x.mp3', Buffer.alloc(100, 1))).status === 400, 'audio refused on the demo');
  const big = await up(gmTok, 'demo', 'big.png', png(700 * 1024));
  ok(big.status === 413, 'image over SR_DEMO_UPLOAD_KB refused: ' + big.status);
  ok((await up(p1, 'demo', 'b.png', png(400 * 1024))).status === 200, 'player upload within the quota');
  const full = await up(gmTok, 'demo', 'c.png', png(300 * 1024));
  ok(full.status === 400 && /plein/.test((await json(full)).error || ''), 'upload quota enforced: ' + full.status);
  // Chunked body without Content-Length: refused before reading.
  const chunked = await new Promise((resolve) => {
    const req = http.request(url + '/api/upload', { method: 'POST', headers: { ...H(gmTok, 'demo'), 'X-Filename': 'd.png', 'Transfer-Encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.write(png(1000));
    req.end();
  });
  ok(chunked === 411, 'chunked upload without a length refused: ' + chunked);
  const bigJson = await fetch(url + '/api/chummer/preview', { method: 'POST', headers: H(gmTok, 'demo', { 'content-type': 'text/plain' }), body: 'x'.repeat(2.5 * 1024 * 1024) });
  ok(bigJson.status === 413, 'HTTP body over 2 MB refused on the demo: ' + bigJson.status);
  ok((await up(alphaTok, 'alpha', 'x.svg', Buffer.from('<svg/>'))).status === 200, 'a real table still accepts SVG uploads');

  // -------------------------------------------------------------------------
  section('socket action caps');
  await rejects(gm.send('chat/send', { text: 'x'.repeat(600) }), /trop long/, 'chat over 500 characters refused');
  await gm.send('chat/send', { text: 'Salut la démo' });
  await rejects(gm.send('notes/create', { title: 'x', body: 'y'.repeat(140 * 1024) }), /volumineuse/, 'action payload over 128 KB refused');
  const burst = await Promise.allSettled(Array.from({ length: 130 }, () => gm.send('maps/setActive', { mapId: 'map_demo_entrepot' })));
  ok(burst.some((r) => r.status === 'rejected' && /ralentis/.test(r.reason.message)), 'per-socket action rate limit');
  const alphaGm = track(await client(url, alphaTok, { table: 'alpha' }));
  await alphaGm.send('chat/send', { text: 'x'.repeat(1500) });
  ok(true, 'a real table keeps the normal chat length');

  // -------------------------------------------------------------------------
  section('idle reset');
  const gmB = track(await client(url, gmTok, { table: 'demo' })); // fresh socket: the rate limit is per socket
  const created = await gmB.send('actor/create', { type: 'npc', name: 'Intrus de passage' });
  await gmB.send('maps/moveToken', { mapId: 'map_demo_entrepot', tokenId: 'tok_pc_demo_samurai', x: 6, y: 9 }).catch(() => {});
  await settle();
  ok(!!gmB.state.actors[created], 'change made');
  const uploads = path.join(runtime, 'tables', 'demo', 'uploads');
  ok(fs.readdirSync(uploads).length >= 2, 'uploads present before the reset');
  for (const c of sockets.splice(0)) c.close();
  await wait(500);
  const reset = await until(async () => {
    const s = JSON.parse(fs.readFileSync(path.join(runtime, 'tables', 'demo', 'state.json'), 'utf8'));
    return !s.actors[created];
  }, 10000);
  ok(reset, 'demo table reset after SR_DEMO_IDLE_MINUTES with nobody connected');
  const after = JSON.parse(fs.readFileSync(path.join(runtime, 'tables', 'demo', 'state.json'), 'utf8'));
  ok(Object.keys(after.users || {}).length === 0 && Object.keys(after.sessions || {}).length === 0, 'users and sessions wiped');
  ok(!after.log.some((e) => /Salut la démo/.test(e.text || '')), 'chat log wiped');
  ok(Object.keys(after.actors).filter((id) => id.startsWith('pc_demo_')).length === 4, 'pre-made PCs back');
  ok(fs.readdirSync(uploads).length === 0, 'uploads emptied');
  ok((await fetch(url + '/api/me', { headers: H(gmTok, 'demo') })).status === 401, 'old tokens no longer work');
  ok(!fs.existsSync(path.join(runtime, 'tables', 'demo', 'backups')) || fs.readdirSync(path.join(runtime, 'tables', 'demo', 'backups')).length === 0, 'no backups kept for the demo');
  const alphaState = JSON.parse(fs.readFileSync(path.join(runtime, 'tables', 'alpha', 'state.json'), 'utf8'));
  ok(alphaState.log.some((e) => (e.text || '').length === 1500), 'the real table is untouched by the demo reset');

  // -------------------------------------------------------------------------
  section('GM reset (Réglages) on the demo');
  const gm2Tok = await login(url, { role: 'gm', table: 'demo' });
  const gm2 = track(await client(url, gm2Tok, { table: 'demo' }));
  const extra = await gm2.send('actor/create', { type: 'npc', name: 'Encore un' });
  const r = await fetch(url + '/api/admin/reset', { method: 'POST', headers: H(gm2Tok, 'demo') });
  const rj = await json(r);
  ok(r.ok && rj.demo === true, 'GM reset answers as a demo reset');
  await settle(500);
  ok(gm2.events.some((e) => e.ev === 'unauthorized' && e.data?.reason === 'demo-reset'), 'connected users are told why they are logged out');
  const s2 = JSON.parse(fs.readFileSync(path.join(runtime, 'tables', 'demo', 'state.json'), 'utf8'));
  ok(!s2.actors[extra] && s2.actors.pc_demo_face, 'GM reset restores the demo content');

  // -------------------------------------------------------------------------
  section('login throttle');
  let throttled = false;
  for (let i = 0; i < 45 && !throttled; i++) {
    try {
      await login(url, { role: 'gm', table: 'demo' });
    } catch (err) {
      throttled = /Trop de tentatives/.test(err.message);
    }
  }
  ok(throttled, 'demo logins are throttled per IP');
  for (const c of sockets.splice(0)) c.close();

  // -------------------------------------------------------------------------
  section('boot reset, existing tables never converted');
  {
    // Dirty the demo directly on disk, then restart with SR_DEMO_TABLE pointing at the real table.
    const file = path.join(runtime, 'tables', 'demo', 'state.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    s.actors.npc_left_over = { ...s.actors.pc_demo_face, id: 'npc_left_over', type: 'npc', name: 'Reste' };
    await srv.stopAndWait({ keep: true });
    fs.writeFileSync(file, JSON.stringify(s));
    srv = await startServer({ port: 3961, runtime, keepRuntime: true, env: { ...ENV, SR_DEMO_TABLE: 'alpha', SR_DEMO_IDLE_MINUTES: '60' }, tables: [] });
    const out = srv.output();
    ok(/n’est pas une table de démo/.test(out), 'SR_DEMO_TABLE naming an existing real table is refused');
    await rejects(login(srv.url, { role: 'gm', password: 'nope', table: 'alpha' }), /incorrect/, 'alpha still needs its GM password');
    const s3 = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(!s3.actors.npc_left_over && !!s3.actors.pc_demo_samurai, 'a demo table (still flagged in server.json) is rebuilt at boot');
  }

  // -------------------------------------------------------------------------
  section('reset rules (unit)');
  {
    process.env.SR_RUNTIME_DIR = runtime;
    const demo = await import('../server/lib/demo.js');
    const tmp = path.join(runtime, 'fake-state.json');
    fs.writeFileSync(tmp, '{}');
    const fake = { id: 'fake', meta: { demo: true }, store: { stateFile: tmp } };
    demo.touchDemo(fake);
    ok(demo.resetReason(fake, { online: 1 }) === (demo.DEMO.resetHour === null ? null : 'nightly'), 'nobody-idle rule needs nobody online');
    ok(demo.resetReason(fake, { online: 0, now: Date.now() + demo.DEMO.idleMs + 1 }) === 'idle', 'idle rule');
    const b = demo.lastNightlyBoundary(new Date(2026, 0, 10, 3, 0).getTime(), 4);
    ok(new Date(b).getDate() === 9 && new Date(b).getHours() === 4, 'nightly boundary before the hour = yesterday');
    const b2 = demo.lastNightlyBoundary(new Date(2026, 0, 10, 5, 0).getTime(), 4);
    ok(new Date(b2).getDate() === 10, 'nightly boundary after the hour = today');
    ok(demo.lastNightlyBoundary(Date.now(), null) === 0, 'no nightly reset when disabled');
    demo.DEMO.maxStateBytes = 1;
    fs.writeFileSync(tmp, '{"big":true}');
    ok(demo.resetReason(fake, { online: 3 }) === 'size', 'oversized state triggers a reset even with people connected');
    demo.DEMO.maxStateBytes = 1e9;
    const upDir = path.join(runtime, 'fake-uploads');
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, 'big.png'), Buffer.alloc(2 * demo.DEMO.uploadQuotaBytes + 10));
    ok(demo.resetReason({ ...fake, uploadDir: upDir }, { online: 3 }) === 'size', 'an overfull uploads folder triggers a reset');
  }
} catch (err) {
  failed++;
  console.error('  ✗ crashed:', err);
} finally {
  for (const c of sockets) c.close();
  if (srv) await srv.stopAndWait({ keep: true });
  try {
    fs.rmSync(runtime, { recursive: true, force: true });
  } catch {}
}
console.log(`\n${passed} ok, ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
