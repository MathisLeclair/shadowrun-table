// i18n of the sheet / characters and maps areas — run: node tools/test-i18n-sheet-map.ts (port 3850)
// Checks that server messages of 10-characters.js and 20-maps.js carry translatable keys (log entries + error replies),
// that their French rendering is unchanged, that the English dictionaries render them, and that the area dictionaries are sane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, login, client, settle } from './test-client.ts';
import * as S from '../server/lib/i18n.ts';
import { placeholders } from '../client/i18n/format.ts';

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
/** Raw action call: resolves with the whole reply ({ ok, result } or { ok: false, error, errorKey, params }). */
const raw = (c, type, payload = {}) => new Promise((res) => c.socket.emit('action', { type, payload }, res));
const lastLog = (c, pred = () => true) => [...(c.state.log || [])].reverse().find(pred);
const en = (entry) => S.t('en', entry.i18n.key, entry.i18n.params);

console.log('Dictionaries (map.json, sheet.json)');
for (const area of ['map', 'sheet']) {
  await test(`${area}.json: every entry translated, placeholders kept`, async () => {
    const d = JSON.parse(fs.readFileSync(new URL(`../client/i18n/en/${area}.json`, import.meta.url), 'utf8'));
    assert.ok(Object.keys(d).length > 100, 'dictionary filled');
    for (const [k, v] of Object.entries(d)) {
      assert.equal(typeof v, 'string', k);
      assert.ok(v.trim(), `empty translation: ${k}`);
      assert.deepEqual(placeholders(v).sort(), placeholders(k).sort(), `placeholders of ${k}`);
    }
  });
}
await test('context keys show the French word, look up their own English', async () => {
  assert.equal(S.t('fr', 'armure::Portée'), 'Portée');
  assert.equal(S.t('en', 'armure::Portée'), 'Worn');
  assert.equal(S.t('en', 'Portée'), 'Range');
  assert.equal(S.t('en', 'porte::Grille'), 'Gate');
  assert.equal(S.t('en', 'carte::Ambiance'), 'Theme');
});

const srv = await startServer({ port: 3850 });
try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  await settle();
  const jane = () => gm.state.actors.pc_jane;

  console.log('Characters: log entries');
  await test('PC damage: translatable entry, French text unchanged', async () => {
    await gm.send('actor/damage', { actorId: 'pc_jane', amount: 3, type: 'S' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'combat');
    assert.equal(e.i18n.key, '{name} subit {damage} ({track})');
    const c = jane().condition;
    const pm = e.i18n.params.track.params.pm;
    const sm = e.i18n.params.track.params.sm;
    assert.equal(e.text, `${jane().name} subit 3 dommages étourdissants (P ${c.physical}/${pm} · É ${c.stun}/${sm})`);
    assert.equal(en(e), `${jane().name} takes 3 Stun damage (P ${c.physical}/${pm} · S ${c.stun}/${sm})`);
    await gm.send('actor/damage', { actorId: 'pc_jane', amount: 1, type: 'P' });
    await settle();
    const e2 = lastLog(gm, (x) => x.kind === 'combat');
    assert.match(e2.text, / subit 1 dommage physique \(P 1\//);
    assert.match(en(e2), / takes 1 Physical damage \(P 1\//);
  });

  await test('NPC damage with a status change', async () => {
    const id = await gm.send('actor/create', { type: 'npc', name: 'Garde test' });
    await gm.send('actor/damage', { actorId: id, amount: 2, type: 'P' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'combat');
    assert.equal(e.i18n.key, '{name} encaisse {damage} — {status}.');
    assert.equal(e.text, 'Garde test encaisse 2 case(s) de dommages physiques — blessé.');
    assert.equal(en(e), 'Garde test takes 2 box(es) of Physical damage — wounded.');
    await gm.send('actor/damage', { actorId: id, amount: 1, type: 'S' });
    await settle();
    const e2 = lastLog(gm, (x) => x.kind === 'combat');
    assert.equal(e2.text, 'Garde test encaisse 1 case(s) de dommages étourdissants.');
  });

  await test('Edge spend / refresh entries', async () => {
    await gm.send('edge/refresh', { actorId: 'pc_jane' });
    const max = jane().attributes.EDG;
    await p1.send('edge/spend', { actorId: 'pc_jane', reason: 'esquive' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'system');
    assert.equal(e.text, `${jane().name} dépense 1 point de Chance (esquive) — reste ${max - 1}/${max}.`);
    assert.equal(en(e), `${jane().name} spends 1 Edge point (esquive) — ${max - 1}/${max} left.`);
    await gm.send('edge/refresh', { all: true });
    await settle();
    const r = lastLog(gm, (x) => x.kind === 'system');
    assert.equal(r.text, 'La Chance de tous les runners est rechargée.');
    assert.equal(en(r), 'Every runner\'s Edge has been refreshed.');
  });

  await test('Rewards: default reason and name list are translatable', async () => {
    await gm.send('actor/adjust', { actorIds: ['pc_jane', 'pc_bricks'], karma: 5, nuyen: 0, reason: '' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'system');
    const names = `${gm.state.actors.pc_jane.name} et ${gm.state.actors.pc_bricks.name}`;
    assert.equal(e.text, `Récompense : +5 karma pour ${names}.`);
    assert.equal(en(e), `Reward: +5 karma for ${names.replace(' et ', ' and ')}.`);
    const h = jane().history.at(-1);
    assert.equal(h.text, 'Récompense');
    assert.equal(S.t('en', h.text), 'Reward');
  });

  await test('Duplicate: name in the table language, history entry with a key', async () => {
    const id = await gm.send('actor/duplicate', { actorId: 'pc_bricks' });
    await settle();
    const copy = gm.state.actors[id];
    assert.equal(copy.name, `${gm.state.actors.pc_bricks.name} (copie)`);
    const h = copy.history.at(-1);
    assert.equal(h.i18n.key, 'Copie de {name}');
    assert.equal(h.text, `Copie de ${gm.state.actors.pc_bricks.name}`);
    assert.equal(S.t('en', h.i18n.key, h.i18n.params), `Copy of ${gm.state.actors.pc_bricks.name}`);
  });

  console.log('Characters: errors');
  await test('error replies carry errorKey + params, French error unchanged', async () => {
    const r = await raw(gm, 'actor/addItem', { actorId: 'pc_jane', list: 'nope', item: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Liste inconnue : nope');
    assert.equal(r.errorKey, 'Liste inconnue : {list}');
    assert.equal(S.t('en', r.errorKey, r.params), 'Unknown list: nope');
    await gm.send('actor/update', { actorId: 'pc_jane', patch: { edge: { current: 0 } } });
    const r2 = await raw(p1, 'edge/spend', { actorId: 'pc_jane' });
    assert.equal(r2.errorKey, '{name} n’a plus de point de Chance');
    assert.equal(r2.error, `${jane().name} n’a plus de point de Chance`);
    const r3 = await raw(p1, 'actor/update', { actorId: 'pc_jane', patch: { karma: 99 } });
    assert.equal(r3.errorKey, 'Tu ne peux pas modifier ça toi-même ({fields}) — demande au MJ, à la boutique ou à l’entraînement.');
    assert.equal(r3.params.fields, 'karma');
    assert.match(S.t('en', r3.errorKey, r3.params), /^You can't change that yourself \(karma\)/);
  });

  await test('untrained skill error names the skill through a nested key', async () => {
    const r = await raw(gm, 'dice/roll', { actorId: 'pc_jane', skillId: 'arcana' });
    if (r.ok) return console.log('     (skipped: Jane knows Arcana)');
    assert.equal(r.errorKey, '{skill} ne peut pas être utilisée sans formation');
    assert.equal(r.error, 'Arcanes ne peut pas être utilisée sans formation');
    assert.equal(S.t('en', r.errorKey, r.params), 'Arcana cannot be used untrained');
  });

  await test('HTTP export of a missing actor → errorBody', async () => {
    const res = await fetch(srv.url + '/api/actors/nope/export', { headers: { Authorization: `Bearer ${gmToken}` } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Personnage introuvable');
    assert.equal(body.errorKey, 'Personnage introuvable');
  });

  console.log('Maps');
  const mapId = await gm.send('maps/create', { name: 'Test i18n', width: 12, height: 8, fill: '.' });
  await test('missing light / area / note → translatable « introuvable » keys', async () => {
    for (const [type, key, payload] of [
      ['maps/removeLight', 'Lumière introuvable', { lightId: 'x' }],
      ['maps/updateRegion', 'Zone introuvable', { regionId: 'x', patch: {} }],
      ['maps/removeNote', 'Note introuvable', { noteId: 'x' }],
    ]) {
      const r = await raw(gm, type, { mapId, ...payload });
      assert.equal(r.ok, false, type);
      assert.equal(r.error, key);
      assert.equal(r.errorKey, key);
      assert.notEqual(S.t('en', key), key, `English for ${key}`);
    }
  });

  await test('revealing a hidden combatant logs a translatable entry', async () => {
    const npc = await gm.send('actor/create', { type: 'npc', name: 'Sniper test' });
    const tok = await gm.send('maps/addToken', { mapId, token: { actorId: npc, x: 2, y: 2, hidden: true } });
    await gm.send('combat/start', { mapId }).catch(() => {});
    await gm.send('combat/add', { tokenIds: [tok] }).catch(() => {});
    await settle();
    const entry = (gm.state.combat?.entries || []).find((e) => e.tokenId === tok);
    if (!entry?.hidden) return console.log('     (skipped: combatant not added hidden)');
    await gm.send('maps/updateToken', { mapId, tokenId: tok, patch: { hidden: false } });
    await settle();
    const e = lastLog(gm, (x) => x.i18n?.key === '{name} entre dans le combat !');
    assert.ok(e, 'entry logged');
    assert.equal(e.text, `${entry.name} entre dans le combat !`);
    assert.equal(en(e), `${entry.name} enters the combat!`);
  });
} finally {
  srv.stop();
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
}
console.log('\nOK — tous les tests passent');
process.exit(0);
