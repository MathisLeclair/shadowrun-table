// Tests for the Chummer5a interop (server/lib/chummer/*, server/modules/85-chummer.js) — run: node tools/test-chummer.js
// Also writes tools/fixtures/export-sample-jane.chum5 and tools/fixtures/export-roundtrip-test.chum5 (to open in Chummer).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
import { startServer, login, client, settle } from './test-client.js';
import { parseXml, serializeXml, el } from '../server/lib/chummer/xml.js';
import { parseChum5 } from '../server/lib/chummer/parse.js';
import { exportChum5 } from '../server/lib/chummer/export.js';
import { mergeActor, diffActors } from '../server/lib/chummer/merge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'chummer-test.chum5');
const OUT_JANE = path.join(ROOT, 'tools', 'fixtures', 'export-sample-jane.chum5');
const OUT_RT = path.join(ROOT, 'tools', 'fixtures', 'export-roundtrip-test.chum5');
const src = fs.readFileSync(FIXTURE, 'utf8');
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8'));
const COLT = '6366691e-c1e0-4d5e-b7a6-1c0371708714';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name, '\n     ', err.stack?.split('\n').slice(0, 3).join('\n      ') || err.message);
  }
}
const wellFormed = (xml) => {
  const v = XMLValidator.validate(xml.replace(/^﻿/, ''), { allowBooleanAttributes: false });
  assert.equal(v, true, JSON.stringify(v));
  new XMLParser({ ignoreAttributes: false }).parse(xml);
};
const topNames = (xml) => parseXml(xml).root.elements.map((e) => e.name);
const clone = (x) => JSON.parse(JSON.stringify(x));
const count = (xml, tag) => (xml.match(new RegExp(`<${tag}>`, 'g')) || []).length;

console.log('XML layer');
await test('fixture round-trips byte for byte through the DOM', () => {
  const doc = parseXml(src);
  assert.equal(doc.bom, true);
  assert.equal(serializeXml(doc, { bom: true }), src);
});
await test('malformed XML is rejected with a French message', () => {
  assert.throws(() => parseXml('<character><a></b></character>'), /XML invalide/);
  assert.throws(() => parseChum5('<root/>'), /pas une fiche Chummer/);
  assert.throws(() => parseChum5('<character><name>x</character>'), /illisible/);
});

console.log('Import (.chum5 → actor)');
const imported = parseChum5(src, { fileName: 'chummer-test.chum5' });
const fx = imported.actor;
await test('fixture: identity, attributes, skills, weapon', () => {
  assert.equal(fx.name, 'Test Chummer');
  assert.equal(fx.metatype, 'Humain');
  assert.deepEqual([fx.attributes.BOD, fx.attributes.AGI, fx.attributes.REA, fx.attributes.INT, fx.attributes.WIL], [4, 5, 4, 4, 3]);
  assert.equal(fx.attributes.MAG, 4);
  assert.equal(fx.attributes.EDG, 2);
  assert.equal(fx.attributes.ESS, 6);
  assert.equal(fx.skills.find((s) => s.id === 'disguise').rating, 6); // Stealth group 6
  assert.equal(fx.skills.find((s) => s.id === 'aeronautics_mechanic').rating, 2); // free priority rating (SkillBase improvement)
  const colt = fx.weapons.find((w) => w.name === 'Colt Government 2066');
  assert.ok(colt);
  assert.equal(colt.catalogId, COLT);
  assert.equal(colt.damage, '7P');
  assert.equal(colt.ap, -1);
  assert.equal(colt.skill, 'pistols');
  assert.equal(colt.chummerGuid, '90db7564-dcb4-4391-854d-1ec77e7a3d28');
  const unarmed = fx.weapons.find((w) => w.name === 'Mains nues');
  assert.ok(unarmed && unarmed.skill === 'unarmed_combat' && unarmed.damage === '(STR)S', 'Unarmed Attack → Mains nues');
  assert.equal(unarmed.accuracy, 4, 'accuracy = physical limit ceil((2×1+4+4)/3)');
  assert.equal(fx.weapons.length, 2);
  assert.equal(fx.qualities[0].karma, 20);
  assert.equal(fx.nuyen, 6000);
  assert.equal(imported.info.created, false);
  assert.equal(fx.chummer.fileName, 'chummer-test.chum5');
  assert.ok(fx.chummer.xml.startsWith('<?xml'));
});

console.log('Export: patch mode (original file kept)');
await test('unchanged actor exports the original file unchanged', () => {
  const r = exportChum5(clone(fx));
  assert.equal(r.mode, 'patch');
  assert.equal(r.xml, src.replace(/^﻿/, ''));
});
await test('round trip: karma, nuyen, skills, attributes, items added/removed, unknown nodes kept', () => {
  const a = clone(fx);
  a.karma = 12;
  a.karmaTotal = 12;
  a.nuyen = 5000;
  a.attributes.AGI = 6;
  a.attributes.BOD = 3;
  a.skills.find((s) => s.id === 'disguise').rating = 7;
  a.skills.find((s) => s.id === 'sneaking').rating = 4; // below its group: the group is dissolved
  a.skills.push({ id: 'pistols', name: 'Pistolets', attr: 'AGI', rating: 3, spec: 'Revolvers' });
  a.weapons = a.weapons.filter((w) => w.catalogId !== COLT);
  a.weapons.push({ id: 'w_new', name: 'Ares Predator V', kind: 'ranged', skill: 'pistols', damage: '8P', catalogId: null });
  a.armor.push({ id: 'a_new', name: 'Veste pare-balles', rating: 12, equipped: true });
  a.gear.push({ id: 'g_new', name: 'Medkit', rating: 3, qty: 2, category: 'Biotech' });
  a.gear.push({ id: 'g_cust', name: 'Bidule maison', qty: 1, category: 'Divers' });
  a.augmentations.push({ id: 'c_new', name: 'Datajack', kind: 'cyberware', grade: 'alpha', essence: 0.08 });
  a.contacts.push({ id: 'ct_new', name: 'Perrine Cabana', role: 'Fixeuse', connection: 3, loyalty: 4 });
  a.qualities.push({ id: 'q_new', name: 'Ambidextre', karma: 4, positive: true });
  a.knowledge.push({ id: 'k_new', name: 'Gangs de Seattle', rating: 3, type: 'street' });
  a.knowledge.push({ id: 'k_lang', name: 'English', rating: 0, type: 'language', native: true });
  a.powers.push({ id: 'p_new', name: 'Réflexes améliorés', level: 2, pp: 2.5 });
  a.condition.physical = 3;
  a.condition.stun = 2;
  a.edge.current = 1;
  const r = exportChum5(a);
  wellFormed(r.xml);
  assert.equal(r.mode, 'patch');
  for (const id of ['w_new', 'a_new', 'g_new', 'c_new', 'ct_new', 'q_new', 'p_new']) assert.ok(Object.values(r.assigned).some((m) => m[id]), `guid assigned for ${id}`);
  const b = parseChum5(r.xml).actor;
  assert.equal(b.name, 'Test Chummer');
  assert.equal(b.karma, 12);
  assert.equal(b.nuyen, 5000);
  assert.equal(b.attributes.AGI, 6);
  assert.equal(b.attributes.BOD, 3);
  assert.equal(b.attributes.INT, 4);
  const sk = Object.fromEntries(b.skills.map((s) => [s.id, s]));
  assert.equal(sk.disguise.rating, 7);
  assert.equal(sk.sneaking.rating, 4);
  assert.equal(sk.palming.rating, 6, 'other Stealth skills keep their rating');
  assert.equal(sk.pistols.rating, 3);
  assert.equal(sk.pistols.spec, 'Revolvers');
  assert.equal(sk.navigation.rating, 6);
  assert.ok(!b.weapons.some((w) => w.catalogId === COLT), 'Colt removed');
  const pred = b.weapons.find((w) => /Predator V/.test(w.name));
  assert.ok(pred, 'Predator added');
  assert.equal(pred.damage, '8P');
  assert.ok(pred.catalogId, 'Predator resolved to a Chummer sourceid');
  assert.equal(pred.chummerGuid, r.assigned.weapons.w_new);
  assert.equal(b.armor[0].rating, 12);
  assert.equal(b.armor[0].equipped, true);
  assert.ok(b.armor[0].catalogId, 'armor jacket found by French name');
  assert.equal(b.gear.find((g) => /Medkit|Médikit/.test(g.name)).qty, 2);
  assert.ok(b.gear.find((g) => g.name === 'Bidule maison'), 'unknown gear exported as a renamed Custom Item');
  const dj = b.augmentations.find((x) => /Datajack/i.test(x.name));
  assert.ok(dj && dj.grade === 'alpha' && Math.abs(dj.essence - 0.08) < 1e-6, 'datajack alpha 0.08');
  assert.equal(b.contacts[0].loyalty, 4);
  assert.ok(b.qualities.some((q) => q.karma === 4 && q.positive));
  assert.equal(b.knowledge.find((k) => k.name === 'Gangs de Seattle').rating, 3);
  assert.equal(b.knowledge.find((k) => k.name === 'English').native, true);
  const ir = b.powers[0];
  assert.equal(ir.level, 2);
  assert.equal(ir.pp, 2.5);
  assert.deepEqual(b.condition, { physical: 3, stun: 2, overflow: 0 });
  assert.equal(b.edge.current, 1);
  // Unknown / untouched nodes and order preserved
  const t0 = topNames(src);
  assert.deepEqual(topNames(r.xml).filter((n) => t0.includes(n)), t0);
  for (const tag of ['settingshashcode', 'priorityskill', 'improvement', 'calculatedvalues', 'essenceatspecialstart', 'skillptsmax']) assert.equal(count(r.xml, tag), count(src, tag), tag);
  assert.ok(r.xml.includes('<created>False</created>'), 'creation mode kept');
  assert.ok(r.xml.includes('<name>Unarmed Attack</name>'));
  fs.writeFileSync(OUT_RT, '﻿' + r.xml.replace(/\r?\n/g, '\r\n'));
});

console.log('Export: generate mode (no Chummer file)');
for (const seed of seeds) {
  await test(`${seed.name}: well-formed career file, same values after re-import`, () => {
    // The sample written for Chummer carries the portrait (like the HTTP export does).
    const img = seed.id === 'pc_jane' && String(seed.portrait || '').startsWith('/assets/') ? path.join(ROOT, 'data', ...seed.portrait.split('/').filter(Boolean)) : null;
    const mugshots = img && fs.existsSync(img) ? [fs.readFileSync(img).toString('base64')] : null;
    const r = exportChum5(clone(seed), { mugshots });
    assert.equal(r.mode, 'generate');
    wellFormed(r.xml);
    assert.ok(r.xml.includes('<created>True</created>'));
    assert.ok(r.xml.includes('<appversion>5.226.0</appversion>'));
    assert.ok(r.xml.includes('<settings>223a11ff-80e0-428b-89a9-6ef1c243b8b6</settings>'));
    const b = parseChum5(r.xml).actor;
    for (const k of ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES']) assert.equal(b.attributes[k], seed.attributes[k], k);
    assert.equal(b.attributes.ESS, seed.attributes.ESS);
    for (const s of seed.skills) {
      const t = b.skills.find((x) => x.id === s.id);
      assert.ok(t, s.id);
      assert.equal(t.rating, s.rating, s.id);
      assert.equal(t.spec || '', s.spec || '', `${s.id} spec`);
    }
    assert.equal(b.karma, seed.karma);
    assert.equal(b.karmaTotal, Math.max(seed.karmaTotal, seed.karma));
    assert.equal(b.nuyen, seed.nuyen);
    assert.equal(b.streetCred, seed.streetCred || 0);
    assert.equal(b.notoriety, seed.notoriety || 0);
    assert.equal(b.name, seed.name);
    assert.equal(b.metatype, seed.metatype);
    for (const l of ['weapons', 'armor', 'augmentations', 'contacts', 'qualities', 'powers', 'spells', 'sins', 'knowledge', 'vehicles']) assert.equal((b[l] || []).length, (seed[l] || []).length, l);
    if (seed.id === 'pc_jane') fs.writeFileSync(OUT_JANE, '﻿' + r.xml.replace(/\r?\n/g, '\r\n'));
  });
}
await test('career mode: app karma/nuyen history becomes Chummer expenses; street cred stays stable', () => {
  const jane = clone(seeds.find((a) => a.id === 'pc_jane'));
  const first = exportChum5(jane);
  const a = parseChum5(first.xml, { now: 1000 }).actor; // the file as the player would import it
  const expBefore = count(first.xml, 'expense');
  a.history.push({ ts: 2000, text: 'Fin de séance', karma: 5 });
  a.karma += 5;
  a.karmaTotal += 5;
  a.history.push({ ts: 3000, text: 'Achat : Medkit', nuyen: -1500 });
  a.nuyen -= 1500;
  const r = exportChum5(a, { now: 4000 });
  wellFormed(r.xml);
  assert.equal(count(r.xml, 'expense'), expBefore + 2);
  assert.ok(r.xml.includes('<reason>Fin de séance</reason>'));
  const b = parseChum5(r.xml).actor;
  assert.equal(b.karma, a.karma);
  assert.equal(b.karmaTotal, a.karmaTotal);
  assert.equal(b.nuyen, a.nuyen);
  assert.equal(b.streetCred, a.streetCred);
});

console.log('Merge (re-import into an existing actor)');
await test('3-way merge keeps app changes, applies Chummer changes, merges karma as deltas', () => {
  const base = clone(fx); // last synced file
  const ours = clone(fx);
  ours.karma += 5; // GM reward in the app
  ours.karmaTotal += 5;
  ours.armor = [{ id: 'app_only', name: 'Casque', rating: 2, equipped: true, stack: true }]; // bought in the app, not yet exported
  ours.condition.stun = 4;
  ours.portrait = '/uploads/me.png';
  ours.training = [{ id: 't1' }];
  const theirs = clone(fx); // edited in Chummer
  theirs.karma -= 2; // spent in Chummer
  theirs.skills.find((s) => s.id === 'disguise').rating = 7;
  theirs.weapons = [];
  theirs.chummer = { ...theirs.chummer, fileName: 'v2.chum5' };
  const m = mergeActor(ours, theirs, base, { now: 99, fileName: 'v2.chum5' });
  assert.equal(m.karma, fx.karma + 5 - 2);
  assert.equal(m.skills.find((s) => s.id === 'disguise').rating, 7);
  assert.equal(m.weapons.length, 0, 'weapons removed in Chummer');
  assert.equal(m.armor[0].id, 'app_only', 'app-only item kept');
  assert.equal(m.condition.stun, 4);
  assert.equal(m.portrait, '/uploads/me.png');
  assert.deepEqual(m.training, [{ id: 't1' }]);
  assert.equal(m.chummer.fileName, 'v2.chum5');
  const d = diffActors(ours, m);
  assert.ok(d.skills.some((s) => s.id === 'disguise'));
  assert.ok(d.lists.some((l) => l.list === 'weapons' && l.removed.length === 2));
  assert.ok(d.scalars.some((s) => s.label === 'Karma'));
});
await test('after a merge, app rewards not in the uploaded file still become Chummer expenses', () => {
  const file = exportChum5(clone(seeds.find((a) => a.id === 'pc_jane'))).xml;
  const ours = parseChum5(file, { now: 1000 }).actor;
  ours.karma += 5;
  ours.karmaTotal += 5;
  ours.history.push({ ts: 2000, text: 'Récompense', karma: 5 });
  const edited = parseXml(file);
  edited.root.set('nuyen', String(Number(edited.root.val('nuyen')) - 300)); // spent in Chummer
  const theirs = parseChum5(serializeXml(edited), { now: 3000 }).actor;
  const m = mergeActor(ours, theirs, parseChum5(file, { keepXml: false }).actor, { now: 3000 });
  assert.equal(m.karma, ours.karma);
  assert.equal(m.nuyen, ours.nuyen - 300);
  const out = exportChum5(m, { now: 4000 });
  assert.ok(out.xml.includes('<reason>Récompense</reason>'));
  assert.ok(!out.xml.includes('Mise à jour depuis Chummer'), 'the merge entry is not re-exported');
  const b = parseChum5(out.xml).actor;
  assert.equal(b.karma, m.karma);
  assert.equal(b.karmaTotal, m.karmaTotal);
  assert.equal(b.nuyen, m.nuyen);
});
await test('first import into an app-made actor: the file wins, app-only data kept', () => {
  const ours = clone(seeds.find((a) => a.id === 'pc_bricks'));
  const m = mergeActor(ours, clone(fx), null, { now: 1 });
  assert.equal(m.id, 'pc_bricks');
  assert.equal(m.attributes.AGI, 5);
  assert.equal(m.weapons.length, 2);
  assert.equal(m.color, ours.color);
  assert.equal(m.history.length, ours.history.length + 1);
  assert.ok(m.bio, 'empty Chummer text never erases app text');
});

console.log('HTTP routes & permissions');
const srv = await startServer({ port: 3203 });
try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const H = (tok, extra = {}) => ({ Authorization: `Bearer ${tok}`, ...extra });
  const post = (url, tok, body, ct = 'text/plain') => fetch(srv.url + url, { method: 'POST', headers: H(tok, { 'Content-Type': ct }), body });
  let actorId;
  let p1Token;
  let p1;
  let p2Token;

  await test('GM imports a .chum5 as a new PC; legacy URL still works', async () => {
    const res = await post('/api/chummer/import?type=pc&fileName=chummer-test.chum5', gmToken, src);
    const j = await res.json();
    assert.equal(res.status, 200, j.error);
    actorId = j.actorId;
    await settle(300);
    const a = gm.state.actors[actorId];
    assert.equal(a.name, 'Test Chummer');
    assert.equal(a.type, 'pc');
    assert.equal(a.chummer.fileName, 'chummer-test.chum5');
    const legacy = await post('/api/actors/import-chum5', gmToken, src);
    assert.equal(legacy.status, 200);
    const noAuth = await fetch(srv.url + '/api/actors/import-chum5', { method: 'POST', body: src });
    assert.equal(noAuth.status, 403);
    const bad = await post('/api/chummer/import', gmToken, 'hello');
    assert.equal(bad.status, 400);
    const badXml = await post('/api/chummer/import', gmToken, '<character><name>x</character>');
    assert.equal(badXml.status, 400);
    assert.match((await badXml.json()).error, /illisible/);
  });

  await test('players never receive the stored XML; only their own pending requests', async () => {
    p1Token = await login(srv.url, { role: 'player', name: 'Testeur Chummer', characterId: actorId });
    p1 = await client(srv.url, p1Token);
    p2Token = await login(srv.url, { role: 'player', name: 'Autre Joueur', characterId: 'pc_bricks' });
    await settle(300);
    const mine = p1.state.actors[actorId];
    assert.equal(mine.chummer.xml, undefined);
    assert.equal(mine.chummer.hasFile, true);
    assert.equal(mine.chummer.fileName, 'chummer-test.chum5');
    assert.deepEqual(p1.state.chummer, { allowPlayerImport: true, pending: [] });
  });

  await test('export: owner and GM get a .chum5 attachment; others are refused', async () => {
    const res = await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p1Token) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".*\.chum5"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM like Chummer');
    const xml = buf.toString('utf8');
    wellFormed(xml);
    assert.equal(parseChum5(xml).actor.name, 'Test Chummer');
    const other = await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p2Token) });
    assert.equal(other.status, 403);
    const gmRes = await fetch(srv.url + '/api/chummer/export/pc_jane', { headers: H(gmToken) });
    assert.equal(gmRes.status, 200);
    assert.equal(gmRes.headers.get('x-chummer-mode'), 'generate');
    const missing = await fetch(srv.url + '/api/chummer/export/nope', { headers: H(gmToken) });
    assert.equal(missing.status, 404);
    await settle(300);
    assert.ok(gm.state.actors.pc_jane.chummer.exportedAt, 'export remembers the sync point');
    assert.ok(gm.state.actors.pc_jane.weapons.every((w) => w.chummerGuid), 'items got their Chummer guid');
  });

  await test('player round trip: export → edit in « Chummer » → preview → update, app rewards kept', async () => {
    const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p1Token) })).arrayBuffer()).toString('utf8');
    await gm.send('actor/adjust', { actorId, karma: 5, reason: 'Récompense' }); // happens in the app while the player edits
    await settle(300);
    const karmaApp = gm.state.actors[actorId].karma;
    const doc = parseXml(xml);
    const c = doc.root;
    const disguise = c.get('newskills/skills').all('skill').find((s) => s.val('name') === 'Disguise');
    disguise.set('karma', String(Number(disguise.val('karma')) + 1)); // Disguise 6 → 7
    c.set('nuyen', String(Number(c.val('nuyen')) - 100));
    const weapons = c.child('weapons');
    weapons.children = weapons.children.filter((w) => w.type !== 'el' || w.val('name') !== 'Colt Government 2066');
    weapons.children.push(el('weapon', [el('sourceid', COLT), el('guid', '11111111-2222-3333-4444-555555555555'), el('name', 'Colt Government 2066'), el('category', 'Heavy Pistols'), el('type', 'Ranged'), el('damage', '7P'), el('ap', '-1'), el('mode', 'SA'), el('ammo', '14(c)'), el('accuracy', '6')]));
    const edited = serializeXml(doc);
    const pre = await post(`/api/chummer/preview?actorId=${actorId}&fileName=edit.chum5`, p1Token, edited);
    const pj = await pre.json();
    assert.equal(pre.status, 200, pj.error);
    assert.equal(pj.needsApproval, false);
    assert.equal(pj.linked, true);
    assert.ok(pj.diff.skills.some((s) => s.id === 'disguise' && s.to === '7'));
    assert.ok(pj.diff.scalars.some((s) => s.label === 'Nuyens'));
    await settle(100);
    assert.equal(gm.state.actors[actorId].skills.find((s) => s.id === 'disguise').rating, 6, 'preview changes nothing');
    const up = await post(`/api/chummer/update?actorId=${actorId}&fileName=edit.chum5`, p1Token, edited);
    const uj = await up.json();
    assert.equal(up.status, 200, uj.error);
    assert.equal(uj.applied, true);
    await settle(300);
    const a = gm.state.actors[actorId];
    assert.equal(a.skills.find((s) => s.id === 'disguise').rating, 7);
    assert.equal(a.karma, karmaApp, 'reward given in the app is kept');
    assert.equal(a.nuyen, 6000 - 100);
    assert.equal(a.weapons.filter((w) => /Colt/.test(w.name)).length, 1, 'Colt replaced, not duplicated');
    assert.equal(a.weapons.filter((w) => w.name === 'Mains nues').length, 1);
    assert.equal(a.chummer.fileName, 'edit.chum5');
    assert.match(a.history[a.history.length - 1].text, /Mise à jour depuis Chummer/);
    assert.ok(gm.state.log.some((e) => /mis à jour depuis Chummer/.test(e.text)));
  });

  await test('GM approval mode: player upload → pending request → GM validates', async () => {
    await assert.rejects(p1.send('chummer/settings', { allowPlayerImport: false }), /MJ/);
    await gm.send('chummer/settings', { allowPlayerImport: false });
    const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p1Token) })).arrayBuffer()).toString('utf8');
    const edited = xml.replace(/<nuyen>(\d+)<\/nuyen>/, (m, n) => `<nuyen>${Number(n) + 1000}</nuyen>`);
    const nuyenBefore = gm.state.actors[actorId].nuyen;
    const pre = await (await post(`/api/chummer/preview?actorId=${actorId}`, p1Token, edited)).json();
    assert.equal(pre.needsApproval, true);
    const up = await (await post(`/api/chummer/update?actorId=${actorId}&fileName=riche.chum5`, p1Token, edited)).json();
    assert.equal(up.applied, false);
    assert.equal(up.pending, true);
    await settle(300);
    assert.equal(gm.state.actors[actorId].nuyen, nuyenBefore, 'not applied yet');
    const req = p1.state.chummer.pending.find((r) => r.id === up.requestId);
    assert.ok(req, 'player sees own request');
    assert.equal(req.xml, undefined, 'without the XML');
    const p2 = await client(srv.url, p2Token);
    assert.equal(p2.state.chummer.pending.length, 0, 'other players do not see it');
    p2.close();
    assert.ok(gm.state.chummer.pending.some((r) => r.id === up.requestId));
    await gm.send('chummer/resolve', { requestId: up.requestId, approve: true });
    await settle(300);
    assert.equal(gm.state.actors[actorId].nuyen, nuyenBefore + 1000);
    assert.equal(gm.state.chummer.pending.find((r) => r.id === up.requestId).status, 'approved');
    await assert.rejects(gm.send('chummer/resolve', { requestId: up.requestId, approve: true }), /déjà traitée/);
    // denied + cancelled requests
    const up2 = await (await post(`/api/chummer/update?actorId=${actorId}`, p1Token, edited)).json();
    await p1.send('chummer/cancel', { requestId: up2.requestId });
    const up3 = await (await post(`/api/chummer/update?actorId=${actorId}`, p1Token, edited)).json();
    await gm.send('chummer/resolve', { requestId: up3.requestId, approve: false });
    await settle(300);
    assert.equal(gm.state.actors[actorId].nuyen, nuyenBefore + 1000);
    await gm.send('chummer/settings', { allowPlayerImport: true });
  });

  await test('permissions: players cannot import new actors or touch others’ sheets', async () => {
    assert.equal((await post('/api/chummer/import', p1Token, src)).status, 403);
    assert.equal((await post('/api/chummer/update?actorId=pc_bricks', p1Token, src)).status, 403);
    assert.equal((await post('/api/chummer/preview?actorId=pc_bricks', p1Token, src)).status, 403);
    assert.equal((await post(`/api/chummer/update?actorId=${actorId}`, p1Token, 'pas du xml')).status, 400);
    assert.equal((await fetch(srv.url + `/api/chummer/export/${actorId}`)).status, 401);
    const via = await post(`/api/chummer/import?actorId=${actorId}`, p1Token, src);
    assert.equal(via.status, 200, 'import with ?actorId = update of an owned actor');
  });

  await test('Chummer portraits become the app portrait, stay out of the state, and come back on export', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const withMug = src.replace('<mainmugshotindex>-1</mainmugshotindex>', '<mainmugshotindex>0</mainmugshotindex>').replace('<mugshots />', `<mugshots>\r\n    <mugshot>${png}</mugshot>\r\n  </mugshots>`);
    const j = await (await post('/api/chummer/import?fileName=mug.chum5', gmToken, withMug)).json();
    await settle(300);
    const a = gm.state.actors[j.actorId];
    assert.match(a.portrait, /^\/uploads\/chummer-[0-9a-f]+\.png$/);
    // The raw XML never reaches clients (gmFilter); it must not hold image data server-side either (checked via export below).
    assert.ok(!a.chummer?.xml, 'raw XML not sent to the GM view');
    assert.ok((await fetch(srv.url + a.portrait)).ok, 'portrait served');
    const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${j.actorId}`, { headers: H(gmToken) })).arrayBuffer()).toString('utf8');
    assert.ok(xml.includes(`<mugshot>${png}</mugshot>`));
    assert.equal(xml.replace(/^﻿/, ''), withMug.replace(/^﻿/, ''), 'unchanged actor → identical file, portrait included');
  });

  await test('GM can unlink an actor from its Chummer file', async () => {
    await gm.send('chummer/unlink', { actorId });
    await settle(300);
    assert.equal(gm.state.actors[actorId].chummer, undefined);
    assert.ok(gm.state.actors[actorId].weapons.every((w) => !w.chummerGuid));
    const r = await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(gmToken) });
    assert.equal(r.headers.get('x-chummer-mode'), 'generate');
  });

  gm.close();
  p1?.close();
} finally {
  srv.stop();
}

if (failures) {
  console.log(`\n${failures} test(s) en échec`);
  process.exit(1);
}
console.log('\nOK — tous les tests passent');
console.log(`Fichiers à ouvrir dans Chummer : ${path.relative(ROOT, OUT_JANE)}, ${path.relative(ROOT, OUT_RT)}`);
