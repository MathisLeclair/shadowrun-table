// Table display tests: node tools/test-display.ts  (port 3975, exit code ≠ 0 on failure)
// 1) Pure rules of shared/display.ts.  2) A display link end to end on an isolated server: player-safe view (party
// vision, chosen PC's vision, no hidden tokens / whispers / links), read-only connection, focus events, revoke, renew.
import { startServer, login, client, settle } from './test-client.ts';
import { sanitizeDisplayLayout, displayEyes, displayByToken, displayIdOf, displayUserId, MAX_DISPLAYS } from '../shared/display.ts';
import type { TestClient, TestView } from './test-client.ts';
import type { DisplayLink, GameMap, TableState } from '../shared/types.ts';

let failures = 0, passes = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}
async function rejects(p: Promise<unknown>, re: RegExp, msg: string) {
  try {
    await p;
    ok(false, msg + ' (should have failed)');
  } catch (e) {
    ok(re.test((e as Error).message), `${msg} — got “${(e as Error).message}”`);
  }
}

// ---------------------------------------------------------------------------
// 1. shared/display.ts
// ---------------------------------------------------------------------------
console.log('shared/display.ts');
{
  const L = sanitizeDisplayLayout({ main: 'initiative', split: 'initiative', splitDir: 'col', splitRatio: 3 });
  ok(L.main === 'initiative' && L.split === null && L.splitDir === 'col' && L.splitRatio === 0.85, 'layout: split never repeats main, ratio clamped');
  const D = sanitizeDisplayLayout({ main: 'sheet', split: 'rolls', splitRatio: 'x' });
  ok(D.main === 'map' && D.split === 'rolls' && D.splitDir === 'row' && D.splitRatio === 0.7, 'layout: unknown pane → map, defaults');
  ok(sanitizeDisplayLayout(null).main === 'map', 'layout: garbage → default');
  ok(displayIdOf(displayUserId('dsp_1')) === 'dsp_1' && displayIdOf('usr_1') === null, 'display user ids');

  const link = { id: 'd1', token: 'secret-token', vision: 'pcB' } as DisplayLink;
  const state = {
    actors: { pcA: { id: 'pcA', type: 'pc' }, pcB: { id: 'pcB', type: 'pc' }, old: { id: 'old', type: 'pc', retired: true }, npc: { id: 'npc', type: 'npc' } },
    users: { u1: { id: 'u1', characterIds: ['pcA'] }, u2: { id: 'u2', characterIds: ['pcB'] } },
    displays: { d1: link },
  } as unknown as Pick<TableState, 'actors' | 'users' | 'displays'>;
  ok(displayByToken(state, 'secret-token') === link && !displayByToken(state, 'nope') && !displayByToken(state, ''), 'displayByToken');
  let eyes = displayEyes(state, 'd1');
  ok(eyes.characterIds.join() === 'pcB' && eyes.exploredBy.join() === 'u2', 'one PC: its eyes and its player’s fog');
  link.vision = 'party';
  eyes = displayEyes(state, 'd1');
  ok(eyes.characterIds.sort().join() === 'pcA,pcB' && eyes.exploredBy.sort().join() === 'u1,u2', 'party: every PC in play, every player’s fog');
  link.vision = 'gone';
  ok(displayEyes(state, 'd1').characterIds.length === 2, 'unknown PC falls back to the party');
}

// ---------------------------------------------------------------------------
// 2. Server
// ---------------------------------------------------------------------------
console.log('server');
const TABLE = 'disp';
const srv = await startServer({
  port: Number(process.env.SR_TEST_PORT) || 3975,
  tables: [{
    id: TABLE, pack: 'blank', gmPassword: 'gm-pw',
    state: {
      version: 1, config: { gmPassword: 'gm-pw', campaignName: 'Display test', lang: 'en' }, users: {}, log: [],
      actors: {
        pcA: { id: 'pcA', type: 'pc', name: 'Alpha' }, pcB: { id: 'pcB', type: 'pc', name: 'Bravo' },
        goon: { id: 'goon', type: 'npc', name: 'Goon' }, spy: { id: 'spy', type: 'npc', name: 'Spy' },
      },
    },
  }],
});
const clients: TestClient[] = [];
const open = async (token: string) => {
  const c = await client(srv.url, token, { table: TABLE });
  clients.push(c);
  return c;
};
try {
  const gm = await open(await login(srv.url, { role: 'gm', password: 'gm-pw', table: TABLE }));
  const p1 = await open(await login(srv.url, { role: 'player', name: 'Ann', characterId: 'pcA', table: TABLE }));
  const p2 = await open(await login(srv.url, { role: 'player', name: 'Ben', characterId: 'pcB', table: TABLE }));
  await settle();

  // Two rooms with no door between them; NPCs in room 1 (one hidden), PC Alpha in room 1, PC Bravo in room 2.
  const mapId = await gm.send<string>('maps/import', {
    map: {
      name: 'Two rooms', width: 11, height: 4, lighting: 'bright', fog: true, sharedVision: false,
      tiles: ['###########', '#...#.....#', '#...#.....#', '###########'],
      tokens: [
        { id: 'tA', actorId: 'pcA', name: 'Alpha', x: 2, y: 1, disposition: 'pc' },
        { id: 'tB', actorId: 'pcB', name: 'Bravo', x: 7, y: 1, disposition: 'pc' },
        { id: 'tGoon', actorId: 'goon', name: 'Goon', x: 1, y: 2, disposition: 'hostile' },
        { id: 'tSpy', actorId: 'spy', name: 'Spy', x: 3, y: 2, disposition: 'hostile', hidden: true },
      ],
    },
  });
  await gm.send('maps/setActive', { mapId });

  // ----- links -----
  const { id: dId, token } = await gm.send<{ id: string; token: string }>('display/create', { name: 'Big screen' });
  await settle();
  ok(gm.state.displays?.[dId]?.token === token && gm.state.displays[dId].name === 'Big screen', 'GM view holds the link and its token');
  ok(!p1.state.displays && !JSON.stringify(p1.state).includes(token), 'players never get the links nor their tokens');
  await rejects(p1.send('display/create', {}), /GM-only/, 'players cannot create a link');

  const disp = await open(token);
  await settle();
  let v: TestView = disp.state;
  ok(v.me.role === 'display' && v.me.id === displayUserId(dId) && !v.me.characterIds.length, 'display connects with its link token, role display');
  ok(v.display?.id === dId && v.display.vision === 'party' && v.display.layout.main === 'map', 'display gets its settings');
  ok(!JSON.stringify(v).includes(token) && !v.displays, 'display view holds no token');
  ok(!v.online.includes(displayUserId(dId)) && gm.state.displaysOnline?.includes(dId), 'a display is not an online person; the GM sees it connected');
  ok(!('bestiary' in v) && !v.foundry, 'no GM slices');

  // ----- vision: the party -----
  let m: GameMap = v.maps[mapId];
  ok(Object.keys(v.maps).join() === mapId, 'display only gets the shown map');
  const ids = (mm: GameMap) => mm.tokens.map((x) => x.id).sort().join();
  ok(ids(m) === 'tA,tB,tGoon', `party vision: both PCs and the visible NPC, never the hidden one (got ${ids(m)})`);
  ok(m.tiles[1][2] === '.' && m.tiles[1][7] === '.', 'party vision: both rooms known');
  ok(!m.notes.length && !m.tokens.some((x) => x.vision), 'no GM notes, no token vision details');
  ok(p1.state.maps[mapId].tiles[1][7] === ' ', 'a player without shared vision does not know the other room');

  // ----- vision: one PC -----
  await gm.send('display/update', { displayId: dId, patch: { vision: 'pcB' } });
  await settle();
  m = disp.state.maps[mapId];
  ok(ids(m) === 'tB', `Bravo's point of view: only Bravo (got ${ids(m)})`);
  ok(m.tiles[1][2] === ' ' && m.tiles[1][7] === '.', "Bravo's point of view: room 1 unknown");
  await rejects(gm.send('display/update', { displayId: dId, patch: { vision: 'nobody' } }), /Character not found/, 'vision must be a PC');
  await gm.send('display/update', { displayId: dId, patch: { vision: 'party' } });

  // ----- read-only -----
  await rejects(disp.send('chat/send', { text: 'hello' }), /read-only/, 'a display cannot chat');
  await rejects(disp.send('maps/moveToken', { mapId, tokenId: 'tA', x: 3, y: 1 }), /read-only/, 'a display cannot move tokens');
  await rejects(disp.send('display/update', { displayId: dId, patch: { blank: true } }), /read-only/, 'a display cannot change itself');
  const me = await fetch(`${srv.url}/api/me`, { headers: { Authorization: `Bearer ${token}`, 'X-SR-Table': TABLE } });
  ok(me.status === 401, 'no HTTP access with a display token');

  // ----- log: public entries only -----
  await p1.send('chat/send', { text: 'public hello' });
  await gm.send('chat/send', { text: 'secret plan', to: [Object.keys(gm.state.users).find((id) => gm.state.users[id].name === 'Ben')] });
  await settle();
  const texts = disp.state.log.map((e) => e.text);
  ok(texts.includes('public hello') && !texts.includes('secret plan'), 'display sees public chat, never whispers');

  // ----- settings -----
  await gm.send('display/update', { displayId: dId, patch: { rotation: 180, blank: true, initiative: false, layout: { main: 'map', split: 'rolls', splitDir: 'col', splitRatio: 0.6 } } });
  await settle();
  v = disp.state;
  ok(v.display?.rotation === 180 && v.display.blank && !v.display.initiative && v.display.layout.split === 'rolls' && v.display.layout.splitRatio === 0.6, 'settings pushed live');
  await rejects(gm.send('display/update', { displayId: dId, patch: { rotation: 45 } }), /Invalid rotation/, 'rotation validated');
  const hId = await gm.send<string>('campaign/addHandout', { title: 'Flyer', body: 'Hello **runners**' });
  await rejects(gm.send('display/update', { displayId: dId, patch: { handoutId: hId } }), /Reveal this handout/, 'only a handout revealed to everyone');
  await gm.send('campaign/revealHandout', { handoutId: hId, to: 'all' });
  await gm.send('display/update', { displayId: dId, patch: { handoutId: hId } });
  await settle();
  v = disp.state;
  ok(v.display?.handoutId === hId && v.campaign.handouts.some((h) => h.id === hId), 'handout shown, and in the display view');

  // ----- combat: hidden entries stay hidden -----
  await gm.send('combat/start', { includeMapTokens: false });
  await gm.send('combat/add', { tokenIds: ['tGoon', 'tSpy'] });
  await settle();
  const names = (disp.state.combat.entries || []).map((e) => e.name);
  ok(names.includes('Goon') && !names.includes('Spy'), `initiative: visible NPC listed, hidden one not (got ${names.join(', ')})`);

  // ----- focus -----
  disp.events.length = 0;
  p1.events.length = 0;
  await gm.send('display/focus', { mapId, x: 7, y: 2, zoom: 40 });
  await settle(150);
  const f = disp.events.find((e) => e.ev === 'display/focus');
  ok(f && f.ev === 'display/focus' && f.data.x === 7 && f.data.mapId === mapId && f.data.zoom === 40, 'display receives « look here »');
  ok(!p1.events.some((e) => e.ev === 'display/focus'), 'players do not');
  await rejects(gm.send('display/focus', { mapId, x: 99, y: 2 }), /outside/, 'focus cell validated');

  // ----- reset keeps the links -----
  const r = await fetch(`${srv.url}/api/admin/reset`, { method: 'POST', headers: { Authorization: `Bearer ${await login(srv.url, { role: 'gm', password: 'gm-pw', table: TABLE })}`, 'X-SR-Table': TABLE } });
  ok(r.ok, 'reset');
  await settle();
  ok(gm.state.displays?.[dId] && disp.socket.connected, 'a reset keeps the display links connected');

  // ----- renew / remove -----
  let kicked = false;
  disp.socket.on('unauthorized', () => (kicked = true));
  const { token: token2 } = await gm.send<{ token: string }>('display/renew', { displayId: dId });
  await settle();
  ok(kicked && token2 !== token, 'renewing the link sends the old screen away');
  await rejects(open(token), /unauthorized/, 'old token rejected');
  const disp2 = await open(token2);
  let kicked2 = false;
  disp2.socket.on('unauthorized', () => (kicked2 = true));
  await gm.send('display/remove', { displayId: dId });
  await settle();
  ok(kicked2 && !gm.state.displays?.[dId], 'revoking the link disconnects its screen');

  // ----- cap -----
  for (let i = 0; i < MAX_DISPLAYS; i++) await gm.send('display/create', {});
  await rejects(gm.send('display/create', {}), /At most/, `at most ${MAX_DISPLAYS} links`);
  await settle();
  ok(Object.values(gm.state.displays || {}).every((d) => d.name && d.token.length >= 32), 'default names and long tokens');
} catch (err) {
  failures++;
  console.error('  ✗ crashed:', err);
} finally {
  for (const c of clients) c.close();
  srv.stop();
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
