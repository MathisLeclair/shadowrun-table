// i18n of the sheet / characters and maps areas — run: node tools/test-i18n-sheet-map.ts (port 3850)
// Checks that server messages of 10-characters.ts and 20-maps.ts carry translatable keys (log entries + error replies),
// that the stored / sent text is the English source, that the French dictionaries render them, and that the area
// dictionaries are sane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import type { ActionPayload, I18nMessage, I18nParams, LogEntry } from '../shared/types.ts';
import * as S from '../server/lib/i18n.ts';
import { placeholders } from '../client/i18n/format.ts';

let failures = 0;
async function test(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    const err = e as Error;
    failures++;
    console.log('  ✗', name, '\n     ', err.message.split('\n').slice(0, 8).join('\n      '));
  }
}
/** Whole action reply, read loosely: tests check `ok` then the error fields. */
interface RawReply { ok: boolean; result?: unknown; error?: string; errorKey?: string; params?: I18nParams }
/** Raw action call: resolves with the whole reply ({ ok, result } or { ok: false, error, errorKey, params }). */
const raw = (c: TestClient, type: string, payload: ActionPayload = {}) => new Promise<RawReply>((res) => c.socket.emit('action', { type, payload }, res));
/** Last matching log entry (the tests then assert on its fields, so a missing one fails there). */
const lastLog = (c: TestClient, pred: (e: LogEntry) => boolean = () => true): LogEntry => [...(c.state.log || [])].reverse().find(pred)!;
const en = (entry: LogEntry) => S.t('en', entry.i18n!.key, entry.i18n!.params);
const fr = (entry: LogEntry) => S.t('fr', entry.i18n!.key, entry.i18n!.params);

console.log('Dictionaries (map.json, sheet.json)');
for (const area of ['map', 'sheet']) {
  await test(`${area}.json: every entry translated, placeholders kept`, async () => {
    const d: Record<string, unknown> = JSON.parse(fs.readFileSync(new URL(`../client/i18n/fr/${area}.json`, import.meta.url), 'utf8'));
    assert.ok(Object.keys(d).length > 100, 'dictionary filled');
    for (const [k, v] of Object.entries(d)) {
      assert.equal(typeof v, 'string', k);
      assert.ok((v as string).trim(), `empty translation: ${k}`);
      assert.deepEqual(placeholders(v as string).sort(), placeholders(k).sort(), `placeholders of ${k}`);
    }
  });
}
await test('context keys show the English word, look up their own French', async () => {
  assert.equal(S.t('en', 'armor::Worn'), 'Worn');
  assert.equal(S.t('fr', 'armor::Worn'), 'Portée');
  assert.equal(S.t('fr', 'Range'), 'Portée');
  assert.equal(S.t('en', 'door::Gate'), 'Gate');
  assert.equal(S.t('fr', 'door::Gate'), 'Grille');
  assert.equal(S.t('fr', 'map::Theme'), 'Ambiance');
  // old French context keys (saved data) still render
  assert.equal(S.t('en', 'armure::Portée'), 'Worn');
  assert.equal(S.t('fr', 'carte::Ambiance'), 'Ambiance');
});

const srv = await startServer({ port: 3850 });
try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  await settle();
  const jane = () => gm.state.actors.pc_jane;

  console.log('Characters: log entries');
  await test('PC damage: translatable entry, English text stored, French rendering', async () => {
    await gm.send('actor/damage', { actorId: 'pc_jane', amount: 3, type: 'S' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'combat');
    assert.equal(e.i18n!.key, '{name} takes {damage} ({track})');
    const c = jane().condition;
    const track = e.i18n!.params!.track as I18nMessage;
    const pm = track.params!.pm;
    const sm = track.params!.sm;
    assert.equal(e.text, `${jane().name} takes 3 Stun damage (P ${c.physical}/${pm} · S ${c.stun}/${sm})`);
    assert.equal(en(e), e.text);
    assert.equal(fr(e), `${jane().name} subit 3 dommages étourdissants (P ${c.physical}/${pm} · É ${c.stun}/${sm})`);
    await gm.send('actor/damage', { actorId: 'pc_jane', amount: 1, type: 'P' });
    await settle();
    const e2 = lastLog(gm, (x) => x.kind === 'combat');
    assert.match(e2.text, / takes 1 Physical damage \(P 1\//);
    assert.match(fr(e2), / subit 1 dommage physique \(P 1\//);
  });

  await test('NPC damage with a status change', async () => {
    const id = await gm.send<string>('actor/create', { type: 'npc', name: 'Garde test' });
    await gm.send('actor/damage', { actorId: id, amount: 2, type: 'P' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'combat');
    assert.equal(e.i18n!.key, '{name} takes {damage} — {status}.');
    assert.equal(en(e), 'Garde test takes 2 box(es) of Physical damage — wounded.');
    assert.equal(fr(e), 'Garde test encaisse 2 case(s) de dommages physiques — blessé.');
    assert.equal(e.text, en(e), 'stored text = English rendering (nested status included)');
    await gm.send('actor/damage', { actorId: id, amount: 1, type: 'S' });
    await settle();
    const e2 = lastLog(gm, (x) => x.kind === 'combat');
    assert.equal(e2.text, 'Garde test takes 1 box(es) of Stun damage.');
    assert.equal(fr(e2), 'Garde test encaisse 1 case(s) de dommages étourdissants.');
  });

  await test('Edge spend / refresh entries', async () => {
    await gm.send('edge/refresh', { actorId: 'pc_jane' });
    const max = jane().attributes.EDG;
    await p1.send('edge/spend', { actorId: 'pc_jane', reason: 'dodge' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'system');
    assert.equal(e.text, `${jane().name} spends 1 Edge point (dodge) — ${max - 1}/${max} left.`);
    assert.equal(fr(e), `${jane().name} dépense 1 point de Chance (dodge) — reste ${max - 1}/${max}.`);
    await gm.send('edge/refresh', { all: true });
    await settle();
    const r = lastLog(gm, (x) => x.kind === 'system');
    assert.equal(r.text, 'Every runner\'s Edge has been refreshed.');
    assert.equal(fr(r), 'La Chance de tous les runners est rechargée.');
  });

  await test('Rewards: default reason and name list are translatable', async () => {
    await gm.send('actor/adjust', { actorIds: ['pc_jane', 'pc_bricks'], karma: 5, nuyen: 0, reason: '' });
    await settle();
    const e = lastLog(gm, (x) => x.kind === 'system');
    const names = `${gm.state.actors.pc_jane.name} and ${gm.state.actors.pc_bricks.name}`;
    assert.equal(e.text, `Reward: +5 karma for ${names}.`);
    assert.equal(fr(e), `Récompense : +5 karma pour ${names.replace(' and ', ' et ')}.`);
    const h = jane().history.at(-1)!;
    assert.equal(h.text, 'Reward');
    assert.equal(S.t('fr', h.text), 'Récompense');
  });

  await test('Duplicate: name in the table language (French here), history entry with a key', async () => {
    const id = await gm.send<string>('actor/duplicate', { actorId: 'pc_bricks' });
    await settle();
    const copy = gm.state.actors[id];
    assert.equal(copy.name, `${gm.state.actors.pc_bricks.name} (copie)`);
    const h = copy.history.at(-1)!;
    assert.equal(h.i18n!.key, 'Copy of {name}');
    assert.equal(h.text, `Copy of ${gm.state.actors.pc_bricks.name}`);
    assert.equal(S.t('fr', h.i18n!.key, h.i18n!.params), `Copie de ${gm.state.actors.pc_bricks.name}`);
  });

  console.log('Characters: errors');
  await test('error replies carry errorKey + params and the English text', async () => {
    const r = await raw(gm, 'actor/addItem', { actorId: 'pc_jane', list: 'nope', item: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Unknown list: nope');
    assert.equal(r.errorKey, 'Unknown list: {list}');
    assert.equal(S.t('fr', r.errorKey!, r.params), 'Liste inconnue : nope');
    await gm.send('actor/update', { actorId: 'pc_jane', patch: { edge: { current: 0 } } });
    const r2 = await raw(p1, 'edge/spend', { actorId: 'pc_jane' });
    assert.equal(r2.errorKey, '{name} has no Edge left');
    assert.equal(r2.error, `${jane().name} has no Edge left`);
    assert.ok(S.t('fr', r2.errorKey!, r2.params).startsWith(`${jane().name} n’a plus de`));
    const r3 = await raw(p1, 'actor/update', { actorId: 'pc_jane', patch: { karma: 99 } });
    assert.equal(r3.errorKey, 'You can\'t change that yourself ({fields}) — ask the GM, or use the shop or training.');
    assert.equal(r3.params!.fields, 'karma');
    assert.match(r3.error!, /^You can't change that yourself \(karma\)/);
    assert.match(S.t('fr', r3.errorKey!, r3.params), /^Tu ne peux pas modifier ça toi-même \(karma\)/);
  });

  await test('untrained skill error names the skill through a nested key', async () => {
    const r = await raw(gm, 'dice/roll', { actorId: 'pc_jane', skillId: 'arcana' });
    if (r.ok) return console.log('     (skipped: Jane knows Arcana)');
    assert.equal(r.errorKey, '{skill} cannot be used untrained');
    assert.equal(r.error, 'Arcana cannot be used untrained');
    assert.equal(S.t('fr', r.errorKey!, r.params), 'Arcanes ne peut pas être utilisée sans formation');
  });

  await test('HTTP export of a missing actor → errorBody', async () => {
    const res = await fetch(srv.url + '/api/actors/nope/export', { headers: { Authorization: `Bearer ${gmToken}` } });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string; errorKey?: string };
    assert.equal(body.error, 'Character not found');
    assert.equal(body.errorKey, 'Character not found');
  });

  console.log('Maps');
  const mapId = await gm.send<string>('maps/create', { name: 'Test i18n', width: 12, height: 8, fill: '.' });
  await test('missing light / area / note → translatable « not found » keys', async () => {
    for (const [type, key, payload] of [
      ['maps/removeLight', 'Light not found', { lightId: 'x' }],
      ['maps/updateRegion', 'Area not found', { regionId: 'x', patch: {} }],
      ['maps/removeNote', 'Note not found', { noteId: 'x' }],
    ] as Array<[string, string, ActionPayload]>) {
      const r = await raw(gm, type, { mapId, ...payload });
      assert.equal(r.ok, false, type);
      assert.equal(r.error, key);
      assert.equal(r.errorKey, key);
      assert.notEqual(S.t('fr', key), key, `French for ${key}`);
    }
  });

  await test('revealing a hidden combatant logs a translatable entry', async () => {
    const npc = await gm.send<string>('actor/create', { type: 'npc', name: 'Sniper test' });
    const tok = await gm.send<string>('maps/addToken', { mapId, token: { actorId: npc, x: 2, y: 2, hidden: true } });
    await gm.send('combat/start', { mapId }).catch(() => {});
    await gm.send('combat/add', { tokenIds: [tok] }).catch(() => {});
    await settle();
    const entry = (gm.state.combat?.entries || []).find((e) => e.tokenId === tok);
    if (!entry?.hidden) return console.log('     (skipped: combatant not added hidden)');
    await gm.send('maps/updateToken', { mapId, tokenId: tok, patch: { hidden: false } });
    await settle();
    const e = lastLog(gm, (x) => x.i18n?.key === '{name} enters the combat!');
    assert.ok(e, 'entry logged');
    assert.equal(e.text, `${entry.name} enters the combat!`);
    assert.equal(fr(e), `${entry.name} entre dans le combat !`);
  });
} finally {
  srv.stop();
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nOK — all tests pass');
process.exit(0);
