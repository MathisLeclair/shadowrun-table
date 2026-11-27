// Campaign module tests: node tools/test-campaign.js  (exit code != 0 on failure)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import campaignModule, { mergeSeeds, applySeed, readCampaignSeeds } from '../server/modules/70-campaign.ts';
import { startServer, login, client, settle } from './test-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.stack || err}`);
  }
}
let n = 0;
const uid = (p) => `${p}_t${++n}`;

// ---------------------------------------------------------------------------
// Seed merge (pure, temp seed dir)
// ---------------------------------------------------------------------------
console.log('Seeds');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-campaign-seed-'));
fs.mkdirSync(path.join(tmp, 'campaign'));
const write = (f, v) => fs.writeFileSync(path.join(tmp, f), JSON.stringify(v));
write('campaign.json', {
  acts: [{ id: 'a1', title: 'Acte un', summary: 'base' }],
  quests: [
    { id: 'q1', actId: 'a1', title: 'Base Q1', status: 'active', summary: 'résumé base', phases: [{ id: 'p1', title: 'P1' }] },
    { id: 'q2', actId: 'a1', title: 'Base Q2' },
  ],
  sessions: [{ id: 's1', number: 1, title: 'S1', played: true }],
  threads: [{ id: 't1', label: 'Fil', state: 'open' }],
  handouts: [{ id: 'h1', title: 'Doc', body: 'secret', revealedTo: [] }],
  playerRecap: 'recap base',
  notes: 'notes base',
});
write('campaign/10-b.json', { quests: [{ id: 'q2', title: 'Override B', status: 'upcoming' }, { id: 'q3', actId: 'a1', title: 'New B' }], sessions: [{ id: 's2', number: 2, title: 'S2' }] });
write('campaign/05-a.json', { quests: [{ id: 'q2', title: 'Override A', summary: 'from A' }], playerRecap: 'recap A' });

await test('readCampaignSeeds reads campaign.json then campaign/*.json sorted, skips invalid', () => {
  fs.writeFileSync(path.join(tmp, 'campaign/20-broken.json'), '{ not json');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const seeds = readCampaignSeeds(tmp);
    assert.equal(seeds.length, 3);
    assert.equal(seeds[1].playerRecap, 'recap A'); // 05-a before 10-b
  } finally {
    console.warn = warn;
    fs.rmSync(path.join(tmp, 'campaign/20-broken.json'));
  }
});

await test('mergeSeeds: later files override fields of the same id, keep others, append new', () => {
  const m = mergeSeeds(readCampaignSeeds(tmp));
  const q2 = m.quests.find((q) => q.id === 'q2');
  assert.equal(q2.title, 'Override B');
  assert.equal(q2.summary, 'from A');
  assert.equal(q2.actId, 'a1');
  assert.deepEqual(m.quests.map((q) => q.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(m.sessions.map((s) => s.id), ['s1', 's2']);
  assert.equal(m.playerRecap, 'recap A');
  assert.equal(m.notes, 'notes base');
});

await test('init fills an empty state from merged seeds', () => {
  const state = {};
  campaignModule.init(state, { seedDir: tmp });
  const c = state.campaign;
  assert.equal(c.quests.length, 3);
  assert.equal(c.quests.find((q) => q.id === 'q2').title, 'Override B');
  assert.equal(c.quests[0].phases[0].done, false);
  assert.equal(c.handouts[0].revealedTo.length, 0);
  assert.equal(c.playerRecap, 'recap A');
  assert.equal(c.currentActId, null);
});

await test('init never overwrites GM edits, re-adds nothing deleted, refreshes untouched seed items', () => {
  const state = {};
  campaignModule.init(state, { seedDir: tmp });
  const c = state.campaign;
  c.quests.find((q) => q.id === 'q1').title = 'Edité par le MJ';
  c.notes = 'mes notes';
  // GM deletes q3 through the action (records it as a deleted seed item).
  const ctx = { state, uid, fail: (m) => { throw new Error(m); }, now: Date.now() };
  campaignModule.actions['campaign/deleteQuest'].handler(ctx, { questId: 'q3' });
  // Seeds change: q1 and q2 updated upstream, recap/notes too.
  write('campaign/10-b.json', { quests: [{ id: 'q1', title: 'Seed v2' }, { id: 'q2', title: 'Override B v2' }, { id: 'q3', actId: 'a1', title: 'New B' }], sessions: [{ id: 's2', number: 2, title: 'S2' }] });
  write('campaign.json', { ...JSON.parse(fs.readFileSync(path.join(tmp, 'campaign.json'), 'utf8')), notes: 'notes v2' });
  campaignModule.init(state, { seedDir: tmp });
  assert.equal(c.quests.find((q) => q.id === 'q1').title, 'Edité par le MJ', 'GM edit kept');
  assert.equal(c.quests.find((q) => q.id === 'q2').title, 'Override B v2', 'untouched item refreshed');
  assert.ok(!c.quests.some((q) => q.id === 'q3'), 'deleted seed item not re-added');
  assert.equal(c.notes, 'mes notes', 'GM notes kept');
  assert.equal(c.playerRecap, 'recap A');
});

await test('applySeed sanitizes bad seed data', () => {
  const c = { acts: [], quests: [], sessions: [], threads: [], handouts: [] };
  applySeed(c, mergeSeeds([{ quests: [{ id: 'qx', status: 'weird', npcs: 'nope', phases: [null, { title: 'ok' }], doc: '../../etc/passwd' }], handouts: [{ id: 'hx', image: 'javascript:alert(1)', revealedTo: 'everyone' }] }]), uid);
  assert.equal(c.quests[0].status, 'upcoming');
  assert.deepEqual(c.quests[0].npcs, []);
  assert.equal(c.quests[0].phases.length, 1);
  assert.equal(c.quests[0].doc, '');
  assert.equal(c.handouts[0].image, '');
  assert.deepEqual(c.handouts[0].revealedTo, []);
});

await test('real seed (data/seed/campaign.json + campaign/*.json) loads with the fixed ids', () => {
  const state = {};
  campaignModule.init(state, { seedDir: path.join(ROOT, 'data', 'seed') });
  const ids = state.campaign.quests.map((q) => q.id);
  for (const id of ['q_cleanup_crew', 'q_open_book', 'q_family_business', 'q_windows_open', 'q_guest_list', 'q_lazarus_cell', 'q_inheritance', 'q_burn_notice', 'q_severance']) assert.ok(ids.includes(id), id);
  assert.deepEqual(state.campaign.acts.map((a) => a.id).slice(0, 3), ['act_1', 'act_2', 'act_3']);
  assert.ok(state.campaign.sessions.filter((s) => s.played).length >= 3);
  assert.ok(state.campaign.handouts.every((h) => Array.isArray(h.revealedTo) && h.revealedTo.length === 0), 'seed handouts unrevealed');
  assert.ok(state.campaign.playerRecap.length > 200);
  assert.ok(!/Reyes|Lazarus|Hollow Pine|Ashe|Morinaga|L-07/.test(state.campaign.playerRecap), 'player recap has no GM secrets');
});
fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Live server
// ---------------------------------------------------------------------------
console.log('Server');
const srv = await startServer({ port: 3913 });
try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const t1 = await login(srv.url, { role: 'player', name: 'Testeur Un' });
  const t2 = await login(srv.url, { role: 'player', name: 'Testeur Deux' });
  const p1 = await client(srv.url, t1);
  const p2 = await client(srv.url, t2);
  await settle();
  const p1Id = Object.values(gm.state.users).find((u) => u.name === 'Testeur Un').id;
  const p2Id = Object.values(gm.state.users).find((u) => u.name === 'Testeur Deux').id;

  await test('GM sees the full seeded campaign', () => {
    const c = gm.state.campaign;
    assert.ok(c.quests.some((q) => q.id === 'q_open_book' && q.status === 'active'));
    assert.ok(c.threads.length >= 10);
    assert.ok(c.handouts.length >= 4);
    assert.equal(typeof c.notes, 'string');
  });

  await test('players only receive revealed handouts + playerRecap', () => {
    const c = p1.state.campaign;
    assert.deepEqual(Object.keys(c).sort(), ['handouts', 'playerRecap']);
    assert.equal(c.handouts.length, 0);
    assert.ok(c.playerRecap.length > 0);
  });

  await test('players cannot use GM campaign actions', async () => {
    for (const [type, payload] of [
      ['campaign/updateNotes', { text: 'hack' }],
      ['campaign/revealHandout', { handoutId: 'h_klee_message', to: 'all' }],
      ['campaign/addQuest', { title: 'x' }],
      ['campaign/togglePhase', { questId: 'q_open_book', phaseId: 'p3' }],
    ]) await assert.rejects(p1.send(type, payload), /réservée au MJ/);
  });

  let hid;
  await test('reveal to a specific player: only them, with log + notify sfx', async () => {
    hid = await gm.send('campaign/addHandout', { title: 'Plan du bâtiment', body: '**secret**', image: '/uploads/plan.png' });
    p1.events.length = 0;
    p2.events.length = 0;
    const r = await gm.send('campaign/revealHandout', { handoutId: hid, to: [p1Id] });
    assert.deepEqual(r.notified, [p1Id]);
    await settle(200);
    assert.equal(p1.state.campaign.handouts.length, 1);
    assert.equal(p1.state.campaign.handouts[0].title, 'Plan du bâtiment');
    assert.equal(p1.state.campaign.handouts[0].image, '/uploads/plan.png');
    assert.equal(p1.state.campaign.handouts[0].revealedTo, undefined, 'recipient list not leaked');
    assert.equal(p2.state.campaign.handouts.length, 0);
    assert.ok(p1.events.some((e) => e.ev === 'sfx' && e.data.id === 'notify'));
    assert.ok(!p2.events.some((e) => e.ev === 'sfx' && e.data.id === 'notify'));
    assert.ok(p1.state.log.some((e) => e.text === 'Nouveau document : Plan du bâtiment'));
    assert.ok(!p2.state.log.some((e) => e.text === 'Nouveau document : Plan du bâtiment'));
    // Revealing again to the same player: no new notification.
    const again = await gm.send('campaign/revealHandout', { handoutId: hid, to: [p1Id] });
    assert.deepEqual(again.notified, []);
  });

  await test('reveal to all, hide from one, hide from all', async () => {
    p2.events.length = 0;
    const r = await gm.send('campaign/revealHandout', { handoutId: hid, to: 'all' });
    assert.deepEqual(r.notified, [p2Id]);
    await settle(200);
    assert.equal(p2.state.campaign.handouts.length, 1);
    assert.equal(p2.state.campaign.handouts[0].toAll, true);
    assert.ok(p2.events.some((e) => e.ev === 'sfx' && e.data.id === 'notify'));
    await gm.send('campaign/hideHandout', { handoutId: hid, userId: p1Id });
    await settle(200);
    assert.equal(p1.state.campaign.handouts.length, 0);
    assert.equal(p2.state.campaign.handouts.length, 1);
    await gm.send('campaign/hideHandout', { handoutId: hid });
    await settle(200);
    assert.equal(p2.state.campaign.handouts.length, 0);
    await assert.rejects(gm.send('campaign/revealHandout', { handoutId: hid, to: ['nobody'] }), /au moins un joueur/);
    await assert.rejects(gm.send('campaign/revealHandout', { handoutId: 'nope', to: 'all' }), /introuvable/);
  });

  await test('handout edits are sanitized; gmNotes never reach players', async () => {
    await gm.send('campaign/updateHandout', { handoutId: hid, patch: { title: 'Plan v2', image: 'javascript:x', gmNotes: 'NE PAS MONTRER', revealedTo: 'all' } });
    await gm.send('campaign/revealHandout', { handoutId: hid, to: [p1Id] });
    await settle(200);
    const h = gm.state.campaign.handouts.find((x) => x.id === hid);
    assert.equal(h.title, 'Plan v2');
    assert.equal(h.image, '');
    assert.deepEqual(h.revealedTo, [p1Id], 'revealedTo not patchable through updateHandout');
    assert.ok(!JSON.stringify(p1.state.campaign).includes('NE PAS MONTRER'));
  });

  await test('quests: add, patch, phases, status, move, delete', async () => {
    const qid = await gm.send('campaign/addQuest', { actId: 'act_2', title: 'Test quête' });
    const ph = await gm.send('campaign/addPhase', { questId: qid, title: 'Étape 1' });
    await gm.send('campaign/addPhase', { questId: qid, title: 'Étape 2' });
    assert.equal(await gm.send('campaign/togglePhase', { questId: qid, phaseId: ph }), true);
    await gm.send('campaign/updatePhase', { questId: qid, phaseId: ph, patch: { text: 'détails' } });
    await gm.send('campaign/movePhase', { questId: qid, phaseId: ph, dir: 1 });
    await gm.send('campaign/updateQuest', { questId: qid, patch: { npcs: ['tpl_reyes', 'tpl_reyes', 'missing_id'], maps: ['map_bar_porfla'], status: 'bogus', doc: 'session-3-plan.md#Scène 2', id: 'hijack' } });
    await settle();
    let q = gm.state.campaign.quests.find((x) => x.id === qid);
    assert.ok(q, 'id not patchable');
    assert.equal(q.status, 'active', 'toggling a phase activates an upcoming quest; bogus status ignored');
    assert.deepEqual(q.npcs, ['tpl_reyes', 'missing_id']);
    assert.equal(q.doc, 'session-3-plan.md#Scène 2');
    assert.deepEqual(q.phases.map((p) => p.title), ['Étape 2', 'Étape 1']);
    assert.equal(q.phases[1].text, 'détails');
    await assert.rejects(gm.send('campaign/setQuestStatus', { questId: qid, status: 'nope' }), /Statut invalide/);
    await gm.send('campaign/setQuestStatus', { questId: qid, status: 'done' });
    await assert.rejects(gm.send('campaign/togglePhase', { questId: qid, phaseId: 'zz' }), /Phase introuvable/);
    await gm.send('campaign/deletePhase', { questId: qid, phaseId: ph });
    await settle();
    q = gm.state.campaign.quests.find((x) => x.id === qid);
    assert.equal(q.status, 'done');
    assert.equal(q.phases.length, 1);
    await assert.rejects(gm.send('campaign/deleteAct', { actId: 'act_2' }), /contient encore/);
    await gm.send('campaign/deleteQuest', { questId: qid });
    await settle();
    assert.ok(!gm.state.campaign.quests.some((x) => x.id === qid));
  });

  await test('sessions: numbering, update, delete', async () => {
    const max = Math.max(...gm.state.campaign.sessions.map((s) => s.number));
    const sid = await gm.send('campaign/addSession', {});
    await gm.send('campaign/updateSession', { sessionId: sid, patch: { plan: '## Plan', played: true, date: '2080-12-01' } });
    await settle();
    const s = gm.state.campaign.sessions.find((x) => x.id === sid);
    assert.equal(s.number, max + 1);
    assert.equal(s.title, `Séance ${max + 1}`);
    assert.equal(s.played, true);
    await gm.send('campaign/deleteSession', { sessionId: sid });
  });

  await test('threads, acts, notes and player recap', async () => {
    const tid = await gm.send('campaign/addThread', { label: 'Nouveau fil', state: 'dormant' });
    await gm.send('campaign/updateThread', { threadId: tid, patch: { state: 'resolved', notes: 'ok' } });
    await gm.send('campaign/updateAct', { actId: 'act_1', patch: { summary: 'Résumé MJ' } });
    await gm.send('campaign/setCurrentAct', { actId: 'act_2' });
    await assert.rejects(gm.send('campaign/setCurrentAct', { actId: 'nope' }), /introuvable/);
    await gm.send('campaign/updateNotes', { text: 'Notes secrètes' });
    await gm.send('campaign/updatePlayerRecap', { text: 'Récap pour tous' });
    await settle(200);
    const c = gm.state.campaign;
    assert.equal(c.threads.find((t) => t.id === tid).state, 'resolved');
    assert.equal(c.acts.find((a) => a.id === 'act_1').summary, 'Résumé MJ');
    assert.equal(c.currentActId, 'act_2');
    assert.equal(c.notes, 'Notes secrètes');
    assert.equal(p2.state.campaign.playerRecap, 'Récap pour tous');
    assert.ok(!JSON.stringify(p2.state).includes('Notes secrètes'));
    await gm.send('campaign/deleteThread', { threadId: tid });
  });

  await test('docs routes: GM lists and reads, players are refused', async () => {
    const list = await (await fetch(srv.url + '/api/docs', { headers: { Authorization: `Bearer ${gmToken}` } })).json();
    assert.ok(Array.isArray(list) && list.some((d) => d.name === 'campaign-outline.md'));
    const r = await fetch(srv.url + '/api/docs/session-3-plan.md', { headers: { Authorization: `Bearer ${gmToken}` } });
    assert.ok((await r.text()).includes('session 3'));
    const pr = await fetch(srv.url + '/api/docs', { headers: { Authorization: `Bearer ${t1}` } });
    assert.equal(pr.status, 403);
  });

  for (const c of [gm, p1, p2]) c.close();
} finally {
  srv.stop();
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) {
  console.log(srv.output().split('\n').filter((l) => /error|campaign/i.test(l)).slice(-20).join('\n'));
  process.exit(1);
}
process.exit(0);
