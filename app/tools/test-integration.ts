// Cross-module integration flow, two tables at once (EN + FR): node tools/test-integration.ts (port 3971 or SR_TEST_PORT).
// Admin creates a « blank » English table, a player builds a character → GM approval → sheet; GM generates tier-3 enemies,
// spawns them and starts combat; on Lazarus, Bricks enters the Matrix and her agent assists then acts.
// Checks that nothing leaks across tables and that keyed errors translate to English.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import type { ActionPayload, CatalogItem, I18nParams } from '../shared/types.ts';
import { t as srvT } from '../server/lib/i18n.ts';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SR_TEST_PORT) || 3971;

let fails = 0, passes = 0;
const ok = (c: unknown, m: string) => { if (c) passes++; else { fails++; console.error('  ✗ ' + m); } };
const step = (m: string) => console.log('• ' + m);

// Legal draft (same as tools/test-chargen.ts)
const INDEX = new Map<string, { it: CatalogItem; f: string }>();
for (const f of ['weapons', 'armor', 'gear', 'cyberware', 'qualities', 'lifestyles']) for (const it of JSON.parse(fs.readFileSync(path.join(APP, 'data/catalog', f + '.json'), 'utf8'))) INDEX.set(it.id, { it, f });
const id = (file: string, name: string): string => { for (const e of INDEX.values()) if (e.f === file && e.it.name === name) return e.it.id; throw new Error(name); };
const legal = {
  concept: { name: 'Marc Delorme', alias: 'Rust', concept: 'Street samurai', background: 'Ex-ganger.' },
  priorities: { metatype: 'C', attributes: 'A', magic: 'E', skills: 'B', resources: 'D' },
  metatype: 'Ork',
  attributes: { BOD: 3, AGI: 5, REA: 4, STR: 2, WIL: 2, LOG: 2, INT: 4, CHA: 2, EDG: 0 },
  skills: [
    { id: 'automatics', points: 6 }, { id: 'pistols', points: 5, spec: 'Semi-automatiques' }, { id: 'perception', points: 4 },
    { id: 'sneaking', points: 4 }, { id: 'unarmed_combat', points: 4 }, { id: 'blades', points: 4 }, { id: 'running', points: 3 },
    { id: 'intimidation', points: 3 }, { id: 'first_aid', points: 2 },
  ],
  groups: [{ id: 'influence', points: 2 }, { id: 'electronics', points: 3 }],
  knowledge: [{ name: 'English', native: true }, { name: 'Seattle gangs', type: 'street', points: 4 }, { name: 'Weapons', type: 'professional', points: 4 }, { name: 'French', type: 'language', points: 4 }],
  qualities: [{ catalogId: id('qualities', 'Toughness') }, { catalogId: id('qualities', 'Distinctive Style') }],
  gear: [
    { ref: id('weapons', 'Ares Predator V'), file: 'weapons', qty: 1 },
    { ref: id('armor', 'Armor Jacket'), file: 'armor', qty: 1 },
    { ref: id('cyberware', 'Wired Reflexes'), file: 'cyberware', qty: 1, rating: 1, grade: 'standard' },
    { ref: id('gear', 'Ammo: Regular Ammo'), file: 'gear', qty: 2 },
  ],
  lifestyle: { catalogId: id('lifestyles', 'Low'), months: 1 },
  contacts: [{ name: 'Fixer', connection: 4, loyalty: 2 }, { name: 'Doc', connection: 2, loyalty: 2 }],
  rollStartingNuyen: true,
};

/** Whole action reply, read loosely: tests check `ok` then the error fields. */
interface RawReply { ok: boolean; result?: unknown; error?: string; errorKey?: string; params?: I18nParams }
/** Raw action: full reply (error, errorKey, params). */
const raw = (c: TestClient, type: string, payload: ActionPayload) => new Promise<RawReply>((res) => c.socket.emit('action', { type, payload }, res));

const srv = await startServer({ port: PORT, env: { SR_MATRIX_TEST: '1' } });
const closers: TestClient[] = [];
try {
  step('admin creates table B (vierge, en)');
  const admin = await srv.admin();
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin };
  let r = await fetch(srv.url + '/api/admin/tables', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Table B', slug: 'tableb', pack: 'vierge', lang: 'en', gmPassword: 'secret-b' }) });
  let j = await r.json();
  ok(r.ok && j.table?.id === 'tableb', 'table B created ' + JSON.stringify(j).slice(0, 200));
  r = await fetch(srv.url + '/api/admin/tables', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Table B2', slug: 'tableb', pack: 'vierge', lang: 'en', gmPassword: 'secret-b' }) });
  j = await r.json();
  ok(r.status === 409 && j.errorKey === 'The identifier “{id}” is already in use' && j.params?.id === 'tableb' && j.error === 'The identifier “tableb” is already in use', 'duplicate slug → keyed error ' + JSON.stringify(j));
  ok(srvT('fr', j.errorKey, j.params) === 'L’identifiant « tableb » est déjà utilisé', 'admin error translated to French');
  const tables: Array<{ slug: string; lang: string }> = (await (await fetch(srv.url + '/api/tables')).json()).tables;
  ok(tables.some((t) => t.slug === 'tableb' && t.lang === 'en') && tables.some((t) => t.slug === 'lazarus'), 'both tables listed ' + JSON.stringify(tables.map((t) => [t.slug, t.lang])));

  step('logins on both tables');
  const gmA = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus', table: 'lazarus' }), { table: 'lazarus' });
  const gmB = await client(srv.url, await login(srv.url, { role: 'gm', password: 'secret-b', table: 'tableb' }), { table: 'tableb' });
  const tokB = await login(srv.url, { role: 'player', name: 'Alice', table: 'tableb' });
  const plB = await client(srv.url, tokB, { table: 'tableb' });
  const plA = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks', table: 'lazarus', lang: 'fr' }), { table: 'lazarus' });
  closers.push(gmA, gmB, plB, plA);
  await fetch(srv.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'gm', password: 'lazarus', table: 'tableb' }) }).then((x) => ok(x.status === 403, 'lazarus GM password refused on table B'));
  ok(gmB.state.config.lang === 'en' && gmB.state.config.table?.slug === 'tableb', 'GM B view: table B in English ' + JSON.stringify(gmB.state.config));
  ok(gmA.state.config.lang === 'fr' && gmA.state.config.table?.slug === 'lazarus', 'GM A view: lazarus in French');
  ok(Object.keys(gmB.state.actors).length === 0 && Object.keys(gmB.state.maps || {}).length === 0, 'table B starts empty (vierge pack)');
  ok(Object.keys(gmB.state.bestiary || {}).length > 0, 'vierge bestiary seeded');
  ok(!Object.values(gmB.state.bestiary!).some((b) => /Ashe|Lazarus|Hollow Pine/i.test(JSON.stringify(b))), 'no Lazarus content in table B bestiary');
  // Cross-table token
  const crossFail = await new Promise<string>((res) => { const s = io(srv.url, { auth: { token: tokB, table: 'lazarus' }, transports: ['websocket'], reconnection: false }); s.on('connect_error', (e) => { s.close(); res(e.message); }); s.on('state', () => { s.close(); res('connected'); }); setTimeout(() => { s.close(); res('timeout'); }, 3000); });
  ok(crossFail === 'unauthorized', 'table B token refused on lazarus socket: ' + crossFail);

  step('player B: character creator → GM B approves');
  const sd = await plB.send('chargen/saveDraft', { data: legal });
  ok(sd.draftId && sd.check.errors === 0, 'draft saved without errors ' + JSON.stringify(sd.check));
  await plB.send('chargen/submit', { draftId: sd.draftId });
  await settle();
  ok(gmB.state.chargen.drafts.some((d) => d.id === sd.draftId && d.status === 'pending'), 'GM B sees the pending draft');
  ok(!(gmA.state.chargen?.drafts || []).some((d) => d.id === sd.draftId), 'GM A does not see table B drafts');
  // English error for a failing action
  const rep = await raw(plB, 'chargen/submit', { draftId: sd.draftId });
  ok(rep && !rep.ok && rep.errorKey === 'Already sent to the GM' && rep.error === 'Already sent to the GM', 'resubmit fails with a key ' + JSON.stringify(rep));
  const fr = srvT('fr', rep.errorKey!, rep.params);
  ok(fr === 'Déjà envoyé au MJ' && srvT('en', rep.errorKey!, rep.params) === rep.error, `French text for the error: "${fr}", English = source`);
  ok(plB.state.me.lang === 'en' || (plB.state.me.lang == null && plB.state.config.lang === 'en'), 'player B UI language resolves to English');
  const rep2 = await raw(plB, 'matrix/connect', { actorId: 'pc_bricks', mode: 'hot' });
  ok(rep2 && !rep2.ok && rep2.errorKey && srvT('en', rep2.errorKey, rep2.params) === rep2.error && srvT('fr', rep2.errorKey, rep2.params) !== rep2.error, 'pc_bricks unknown on table B, English error: ' + JSON.stringify(rep2) + ' → ' + srvT('fr', rep2.errorKey!, rep2.params));
  const res = await gmB.send('chargen/resolve', { draftId: sd.draftId, approve: true, note: 'Welcome' });
  await settle();
  ok(res.status === 'approved' && res.actorId, 'approved');
  const newId = res.actorId;
  ok(plB.state.me.characterIds.includes(newId) && plB.state.actors[newId]?.name, 'player B now owns a sheet ' + plB.state.actors[newId]?.name);
  ok(plB.events.some((e) => e.ev === 'chargen:resolved' && e.data.status === 'approved'), 'player B got chargen:resolved');
  ok(!gmA.state.actors[newId] && !plA.events.some((e) => e.ev === 'chargen:resolved') && !gmA.events.some((e) => e.ev === 'chargen:resolved'), 'nothing leaks to lazarus');
  ok(!gmA.state.log.some((e) => /Marc Delorme|Rust/.test(JSON.stringify(e))), 'lazarus log has no table B entries');

  step('GM B: enemy generator tier 3 + spawn + combat');
  const map = await gmB.send('maps/create', { name: 'Warehouse', width: 20, height: 14 });
  const mapId = typeof map === 'string' ? map : map?.id || map?.mapId || Object.keys((await gmB.nextState()).maps)[0];
  await gmB.send('maps/setActive', { mapId });
  await gmB.send('maps/placePCs', { mapId }).catch((e: Error) => console.log('   placePCs:', e.message));
  const pv = await gmB.send('npcgen/preview', { archetype: 'corpsec', tier: 3, seed: 42, lieutenant: true });
  ok(pv.main?.name && pv.lieutenant, 'preview tier 3 ' + pv.main?.name);
  const gen = await gmB.send('npcgen/create', { archetype: 'corpsec', tier: 3, seed: 42, lieutenant: true, saveToBestiary: true, spawn: { mapId, count: 3 } });
  ok(gen.actorIds.length === 4 && gen.tokenIds.length === 4 && gen.templateIds.length === 2, 'spawned 3 + lieutenant ' + JSON.stringify({ a: gen.actorIds.length, t: gen.tokenIds.length, u: gen.unplaced }));
  const cs = await gmB.send('combat/start', { mapId });
  await settle();
  ok(gmB.state.combat?.active && gmB.state.combat.entries.length >= 4, 'combat B active with ' + gmB.state.combat?.entries?.length + ' entries');
  ok(!gmA.state.combat?.active, 'lazarus combat not started');
  ok(!gen.actorIds.some((a: string) => gmA.state.actors[a]), 'generated NPCs absent from lazarus');
  ok(plB.state.combat?.active, 'player B sees the combat');

  step('lazarus: Bricks in the Matrix, agent assists then acts');
  await plA.send('matrix/connect', { actorId: 'pc_bricks', mode: 'hot' });
  await plA.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: true });
  await gmA.send('matrix/testDice', { mode: 'actor' });
  const as = await plA.send('matrix/agentAssist', { actorId: 'pc_bricks', actionId: 'hackOnTheFly' });
  ok(as.pendingAssist && as.roll.hits > 0, 'agent assist pending ' + JSON.stringify(as.pendingAssist));
  await gmA.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { visible: true } });
  const act = await plA.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine', marks: 1, assistFromAgent: true });
  ok(act.success, 'Bricks hacks with the agent bonus');
  const aa = await plA.send('matrix/agentAct', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'host:host_hollow_pine' });
  ok(aa && (aa.success !== undefined || aa.roll), 'agent acts on its own ' + JSON.stringify(aa).slice(0, 160));
  await settle();
  ok(plA.state.matrix?.personas?.pc_bricks?.online, 'Bricks online in player A view');
  ok(!gmB.state.matrix?.personas?.pc_bricks && !plB.state.matrix?.personas?.pc_bricks, 'no Lazarus persona on table B');
  ok(!JSON.stringify(gmB.state.matrix || {}).includes('hollow_pine'), 'no Lazarus host on table B');
  ok(!gmB.state.log.some((e) => e.kind === 'matrix') && !plB.events.some((e) => e.ev === 'sfx' && e.data.id === 'matrix-glitch'), 'no matrix log/sfx leaked to table B');
  const frRep = await raw(plA, 'matrix/agentAct', { actorId: 'pc_bricks', actionId: 'nope' });
  ok(frRep && !frRep.ok && frRep.error === 'Unknown Matrix action' && frRep.errorKey === 'Unknown Matrix action' && srvT('fr', frRep.errorKey!) === 'Action matricielle inconnue', 'French session: English error text + key, French available: ' + srvT('fr', frRep.errorKey!));
  ok(!plA.state.actors[newId] && !Object.values(plA.state.users || {}).some((u) => u.name === 'Alice'), 'player A sees nothing of table B');
  const stB = JSON.stringify(plB.state);
  ok(!/Bricks|Hollow Pine|Sploadie/.test(stB), 'player B view free of Lazarus names');
  // Language switch per user
  await plA.send('users/setLang', { lang: 'en' });
  await settle();
  ok(plA.state.me.lang === 'en' && gmA.state.config.lang === 'fr', 'player A switches to English without changing the table');
  // Health
  const h = await (await fetch(srv.url + '/api/health')).json();
  ok(h.ok && h.tables >= 2 || (Array.isArray(h.tables) && h.tables.length >= 2), 'health lists both tables ' + JSON.stringify(h));
  // Server stderr
  const errs = srv.output().split('\n').filter((l) => /Error|TypeError|ReferenceError|uncaught/i.test(l));
  ok(!errs.length, 'no server errors: ' + errs.slice(0, 5).join(' | '));
} catch (e) {
  fails++;
  console.error(e);
} finally {
  for (const c of closers) c.close();
  srv.stop();
}
console.log(`\n${passes} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
