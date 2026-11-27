// Tests of the i18n foundation: format core, client t/tn/fallback/missing, dictionaries, server helpers,
// error keys over the socket and HTTP, per-user language persistence, table language, the i18n-check tool.
// Run: node tools/test-i18n.ts   (isolated servers on ports 3800-3849)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import type { ActionPayload, ActionResponse, I18nEntry, I18nParams, Lang, NewLogEntry } from '../shared/types.ts';
import * as F from '../client/i18n/format.ts';
import * as I from '../client/lib/i18n.ts';
import * as S from '../server/lib/i18n.ts';
import { ATTR_LABELS, SKILLS, SKILL_CATEGORIES, SKILL_GROUPS } from '../shared/sr5.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'fr');
const LEGACY_FILE = path.join(ROOT, 'client', 'i18n', 'legacy-fr-keys.json');
const readJson = (f: string): Record<string, string> => JSON.parse(fs.readFileSync(f, 'utf8'));
/** All French dictionaries merged the way the browser does it (glossary first, then the area files). */
function frenchDictionary(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of S.dictionaryFiles('fr')) Object.assign(out, readJson(path.join(DICT_DIR, f)));
  return out;
}
const LEGACY = readJson(LEGACY_FILE);
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack).split('\n').slice(0, 3).join('\n       ')}`);
  }
}

console.log('format core');
await test('interpolate: named params, unknown left as-is, nested translatable params, arrays', () => {
  assert.equal(F.interpolate('Hi {name}, {n} PCs', { name: 'Jane', n: 3 }), 'Hi Jane, 3 PCs');
  assert.equal(F.interpolate('Hi {name} {other}', { name: 'Jane' }), 'Hi Jane {other}');
  assert.equal(F.interpolate('{a}', { a: null }), '');
  assert.equal(F.interpolate('{who}: {what}', { who: 'X', what: { t: 'Shot {n}', params: { n: 2 } } }), 'X: Shot 2');
  assert.equal(F.interpolate('{who}', { who: { t: 'spell::Force' } }), 'Force');
  assert.equal(F.interpolate('{list}', { list: ['a', 'b'] }), 'a, b');
  assert.equal(F.interpolate('no params', undefined), 'no params');
});
await test('context keys and placeholders', () => {
  assert.equal(F.stripContext('spell::Force'), 'Force');
  assert.equal(F.stripContext('Force'), 'Force');
  assert.deepEqual(F.placeholders('{a} and {b} then {a}').sort(), ['a', 'b']);
});
await test('source and default languages', () => {
  assert.equal(F.SOURCE_LANG, 'en');
  assert.equal(F.DEFAULT_LANG, 'fr');
});
await test('plural categories: French 0/1 singular, English only 1', () => {
  assert.equal(F.pluralCategory('fr', 0), 'one');
  assert.equal(F.pluralCategory('fr', 1), 'one');
  assert.equal(F.pluralCategory('fr', 1.5), 'one');
  assert.equal(F.pluralCategory('fr', 2), 'other');
  assert.equal(F.pluralCategory('en', 0), 'other');
  assert.equal(F.pluralCategory('en', 1), 'one');
  assert.equal(F.pluralKey('en', 0, { zero: 'None', one: 'one', other: 'some' }), 'None');
});
await test('lookup / currentKey / formatSource: English source, French dictionary, legacy French keys', () => {
  const dict = { 'Attack — {weapon}': 'Attaque — {weapon}', 'fem::current': 'actuelle', Empty: '' };
  const legacy = { 'Attaque — {weapon}': 'Attack — {weapon}' };
  assert.deepEqual(F.lookup(dict, 'en', 'Attack — {weapon}'), { text: 'Attack — {weapon}', missing: false });
  assert.deepEqual(F.lookup(dict, 'fr', 'Attack — {weapon}'), { text: 'Attaque — {weapon}', missing: false });
  assert.deepEqual(F.lookup(dict, 'en', 'fem::current'), { text: 'current', missing: false }, 'English drops the context');
  assert.deepEqual(F.lookup(dict, 'fr', 'fem::current'), { text: 'actuelle', missing: false });
  assert.deepEqual(F.lookup(dict, 'fr', 'Not there'), { text: 'Not there', missing: true }, 'French falls back to English');
  assert.deepEqual(F.lookup(dict, 'fr', 'Empty'), { text: 'Empty', missing: true }, 'an empty entry counts as missing');
  assert.deepEqual(F.lookup(dict, 'fr', 'Attaque — {weapon}', legacy), { text: 'Attaque — {weapon}', missing: false }, 'legacy key in French');
  assert.deepEqual(F.lookup(dict, 'en', 'Attaque — {weapon}', legacy), { text: 'Attack — {weapon}', missing: false }, 'legacy key in English');
  assert.equal(F.currentKey(legacy, 'Attaque — {weapon}'), 'Attack — {weapon}');
  assert.equal(F.currentKey(legacy, 'Free text'), 'Free text');
  assert.equal(F.currentKey(null, 'x'), 'x');
  assert.equal(F.formatSource('Attaque — {weapon}', { weapon: 'Ares Predator V' }, legacy), 'Attack — Ares Predator V');
  assert.equal(F.formatSource('fem::current'), 'current');
});
await test('cleanParams keeps small JSON-safe values and nested { t } params only', () => {
  const p = F.cleanParams({ a: 'x', n: 2, b: true, z: null, fn: () => 1, obj: { evil: 1 }, nested: { t: 'K', params: { x: 1 } }, 'bad key': 1, arr: [1, 'a', { t: 'K' }, { no: 1 }] });
  assert.deepEqual(p, { a: 'x', n: 2, b: true, z: null, nested: { t: 'K', params: { x: 1 } }, arr: [1, 'a', { t: 'K' }] });
  assert.equal(F.cleanParams('x'), undefined);
  assert.equal(F.cleanParams([1]), undefined);
});

console.log('client i18n');
await test('t: English source, French entry, fallback to English, interpolation', () => {
  I.setDictionary({ 'Hello {name}': 'Bonjour {name}', Map: 'Carte', 'spell::Force': 'Puissance (sort)', 'Empty for now': '' }, { legacyKeys: {} });
  I.setLang('en');
  assert.equal(I.getLang(), 'en');
  assert.equal(I.t('Hello {name}', { name: 'Jane' }), 'Hello Jane', 'English output = source');
  assert.equal(I.t('spell::Force'), 'Force');
  I.setLang('fr');
  assert.equal(I.t('Hello {name}', { name: 'Jane' }), 'Bonjour Jane');
  assert.equal(I.t('Map'), 'Carte');
  assert.equal(I.t('spell::Force'), 'Puissance (sort)');
  assert.equal(I.t('Not translated {x}', { x: 1 }), 'Not translated 1');
  assert.equal(I.t('Empty for now'), 'Empty for now', 'an empty entry falls back to English');
});
await test('missing keys are collected in French only, tIfKnown never counts', () => {
  I.clearMissing();
  I.setLang('fr');
  I.t('Missing key A');
  I.t('Missing key A');
  I.t('Map');
  I.tIfKnown('Free text typed by a player');
  I.t('');
  I.t('123');
  I.setLang('en');
  I.t('Missing key B');
  assert.deepEqual(I.missingKeys(), { 'Missing key A': 2 });
  assert.equal(I.missingCount(), 1);
  I.clearMissing();
  assert.equal(I.missingCount(), 0);
});
await test('tn: plural forms per language, {n} always available, zero form', () => {
  I.setDictionary({ '{n} item': '{n} objet', '{n} items': '{n} objets', 'No items': 'Aucun objet', '{n} item for {who}': '{n} objet pour {who}', '{n} items for {who}': '{n} objets pour {who}' });
  I.setLang('fr');
  assert.equal(I.tn(0, '{n} item', '{n} items'), '0 objet');
  assert.equal(I.tn(1, '{n} item', '{n} items'), '1 objet');
  assert.equal(I.tn(4, '{n} item', '{n} items'), '4 objets');
  assert.equal(I.tn(0, { zero: 'No items', one: '{n} item', other: '{n} items' }), 'Aucun objet');
  assert.equal(I.tn(2, '{n} item for {who}', '{n} items for {who}', { who: 'Jane' }), '2 objets pour Jane');
  I.setLang('en');
  assert.equal(I.tn(0, '{n} item', '{n} items'), '0 items');
  assert.equal(I.tn(1, '{n} item', '{n} items'), '1 item');
  assert.equal(I.tn(0, { zero: 'No items', one: '{n} item', other: '{n} items' }), 'No items');
  assert.equal(I.tn(2, '{n} item for {who}', '{n} items for {who}', { who: 'Jane' }), '2 items for Jane');
});
await test('language listeners, invalid languages ignored', () => {
  I.setLang('fr');
  const seen: Lang[] = [];
  const off = I.onLangChange((l) => seen.push(l));
  I.setLang('en');
  I.setLang('en');
  I.setLang('de');
  off();
  I.setLang('fr');
  assert.deepEqual(seen, ['en']);
});
await test('langFromGame: own choice > table language; a fresh switch survives a stale state', () => {
  assert.equal(I.langFromGame({ me: { lang: 'en' }, config: { lang: 'fr' } }), 'en');
  assert.equal(I.langFromGame({ me: { lang: null }, config: { lang: 'en' } }), 'en');
  assert.equal(I.langFromGame({ me: {}, config: {} }), 'fr');
  I.expectUserLang('en');
  assert.equal(I.langFromGame({ me: { lang: 'fr' }, config: { lang: 'fr' } }), 'en', 'stale broadcast ignored');
  assert.equal(I.langFromGame({ me: { lang: 'en' }, config: { lang: 'fr' } }), 'en');
  assert.equal(I.langFromGame({ me: { lang: 'fr' }, config: { lang: 'fr' } }), 'fr', 'once confirmed, the state wins again');
});
await test('errorText / logText', () => {
  I.setDictionary({ 'Unknown action: {type}': 'Action inconnue : {type}', 'Empty message': 'Message vide', '{actor} spends 1 Edge point': '{actor} dépense 1 point de Chance', Error: 'Erreur' }, { legacyKeys: {} });
  I.setLang('fr');
  assert.equal(I.errorText({ error: 'Unknown action: x', errorKey: 'Unknown action: {type}', params: { type: 'x' } }), 'Action inconnue : x');
  assert.equal(I.errorText({ error: 'Empty message' }), 'Message vide', 'plain English errors are translated when known');
  assert.equal(I.errorText({ error: 'Unknown text' }), 'Unknown text');
  assert.equal(I.errorText(null), 'Erreur');
  assert.equal(I.logText({ kind: 'system', text: 'Jane spends 1 Edge point', i18n: { key: '{actor} spends 1 Edge point', params: { actor: 'Jane' } } }), 'Jane dépense 1 point de Chance');
  assert.equal(I.logText({ kind: 'system', text: 'Empty message' }), 'Message vide');
  assert.equal(I.logText({ kind: 'chat', text: 'Empty message' }), 'Empty message', 'chat is never translated');
  I.setLang('en');
  assert.equal(I.errorText({ error: 'Unknown action: x', errorKey: 'Unknown action: {type}', params: { type: 'x' } }), 'Unknown action: x');
  assert.equal(I.errorText(null), 'Error');
  assert.equal(I.logText({ kind: 'system', text: 'x', i18n: { key: '{actor} spends 1 Edge point', params: { actor: 'Jane' } } }), 'Jane spends 1 Edge point');
});
await test('legacy French keys (saved before the switch) render in English and in French', () => {
  I.setDictionary(frenchDictionary(), { legacyKeys: LEGACY });
  assert.equal(LEGACY['Attaque — {weapon}'], 'Attack — {weapon}');
  const entry = { kind: 'roll', text: 'Attaque — Ares Predator V', i18n: { key: 'Attaque — {weapon}', params: { weapon: 'Ares Predator V' } } };
  I.setLang('en');
  assert.equal(I.logText(entry), 'Attack — Ares Predator V');
  assert.equal(I.t('Attaque — {weapon}', { weapon: 'X' }), 'Attack — X');
  assert.equal(I.errorText({ error: 'Introuvable' }), 'Not found', 'an old French error text');
  assert.equal(I.tIfKnown('Nain'), 'Dwarf', 'a stored French value');
  I.setLang('fr');
  I.clearMissing();
  assert.equal(I.logText(entry), 'Attaque — Ares Predator V');
  assert.equal(I.errorText({ error: 'Introuvable' }), 'Introuvable');
  assert.equal(I.tIfKnown('Nain'), 'Nain');
  assert.equal(I.missingCount(), 0, 'legacy keys are found through their English key');
  // server side: same map
  assert.equal(S.t('en', 'Attaque — {weapon}', { weapon: 'X' }), 'Attack — X');
  assert.equal(S.t('fr', 'Attaque — {weapon}', { weapon: 'X' }), 'Attaque — X');
  assert.equal(S.formatSource('Attaque — {weapon}', { weapon: 'X' }), 'Attack — X');
  assert.equal(S.sourceKey('Attaque — {weapon}'), 'Attack — {weapon}');
  assert.deepEqual(S.errorBody('Introuvable'), { error: 'Not found', errorKey: 'Not found' });
  const old = S.normalizeLogEntry({ kind: 'roll', i18n: { key: 'Attaque — {weapon}', params: { weapon: 'X' } } } as NewLogEntry);
  assert.equal(old.text, 'Attack — X');
});
await test('SR5 vocabulary helpers and catalog names (real French dictionaries)', () => {
  I.setDictionary(frenchDictionary(), { legacyKeys: LEGACY });
  I.setLang('en');
  assert.equal(I.attrLabel('EDG'), 'Edge');
  assert.equal(I.attrLabel('BOD'), 'Body');
  assert.equal(I.attrShort('BOD'), 'BOD');
  assert.equal(I.skillLabel('pistols'), 'Pistols');
  assert.equal(I.skillLabel({ id: 'pilot_ground_craft', name: 'Pilotage (véhicules terrestres)' }), 'Pilot Ground Craft');
  assert.equal(I.skillLabel({ id: 'free_fall' }), 'Free-Fall');
  assert.equal(I.skillLabel({ id: 'custom-x', name: 'My own skill' }), 'My own skill');
  assert.equal(I.skillGroupLabel('close_combat'), 'Close Combat');
  assert.equal(I.skillGroupLabel('stealth'), 'Stealth');
  assert.equal(I.skillCategoryLabel('magic'), 'Magical');
  assert.equal(I.limitLabel('social'), 'Social Limit');
  assert.equal(I.metatypeLabel('Dwarf'), 'Dwarf');
  assert.equal(I.itemName({ name: 'Ares Predator V', nameFr: 'Ares Predator V (fr)' }), 'Ares Predator V');
  assert.equal(I.fmtNuyen(12500), '12,500¥');
  I.setLang('fr');
  assert.equal(I.attrLabel('EDG'), 'Chance');
  assert.equal(I.attrLabel('BOD'), 'Constitution');
  assert.equal(I.attrShort('BOD'), 'CON');
  assert.equal(I.skillLabel('pistols'), 'Pistolets');
  assert.equal(I.skillGroupLabel('close_combat'), 'Combat rapproché');
  assert.equal(I.skillGroupLabel('stealth'), 'Furtivité');
  assert.equal(I.skillCategoryLabel('magic'), 'Magiques');
  assert.equal(I.limitLabel('social'), 'Limite sociale');
  assert.equal(I.metatypeLabel('Dwarf'), 'Nain');
  assert.equal(I.itemName({ name: 'Ares Predator V', nameFr: 'Ares Predator V (fr)' }), 'Ares Predator V (fr)');
  assert.equal(I.itemName({ name: 'Only EN' }), 'Only EN');
  assert.equal(I.fmtNuyen(12500), '12 500¥');
});

console.log('dictionaries');
const dictFiles = fs.readdirSync(DICT_DIR).filter((f) => f.endsWith('.json'));
await test('client/i18n/en is gone: French dictionaries only', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'client', 'i18n', 'en')));
});
await test('every client/i18n/fr/*.json is a flat { English: French } object with matching placeholders', () => {
  assert.ok(dictFiles.includes('glossary.json') && dictFiles.includes('core.json') && dictFiles.includes('admin.json'));
  for (const area of ['map', 'sheet', 'combat', 'shop', 'training', 'audio', 'campaign', 'foundry', 'chummer', 'matrix', 'chargen']) assert.ok(dictFiles.includes(`${area}.json`), `${area}.json exists`);
  for (const f of dictFiles) {
    const data = readJson(path.join(DICT_DIR, f));
    assert.ok(data && typeof data === 'object' && !Array.isArray(data), f);
    for (const [k, v] of Object.entries(data)) {
      assert.equal(typeof v, 'string', `${f}: ${k}`);
      if (v) assert.deepEqual(F.placeholders(v).sort(), F.placeholders(k).sort(), `${f}: placeholders of “${k}”`);
    }
  }
});
await test('legacy-fr-keys.json maps old French keys to English keys with the same placeholders', () => {
  assert.ok(Object.keys(LEGACY).length > 1000);
  for (const [k, v] of Object.entries(LEGACY)) {
    assert.ok(typeof v === 'string' && v, k);
    assert.deepEqual(F.placeholders(v).sort(), F.placeholders(k).sort(), `placeholders of “${k}”`);
  }
});
await test('glossary covers the SR5 labels of shared/sr5.ts', () => {
  const g = readJson(path.join(DICT_DIR, 'glossary.json'));
  for (const en of Object.values(ATTR_LABELS)) assert.ok(g[en], `attribute ${en}`);
  for (const en of Object.values(SKILL_GROUPS)) assert.ok(g[en], `group ${en}`);
  for (const en of Object.values(SKILL_CATEGORIES)) assert.ok(g[en], `category ${en}`);
  for (const s of SKILLS) assert.ok(s.fr, `skill ${s.id} has its French name`);
  for (const k of ['Condition Monitor', 'Critical Glitch', 'Push the Limit', 'Second Chance', 'Seize the Initiative', 'Overwatch Score', 'Marks', 'Professional Rating', 'Availability', 'DV', 'AP', 'Accuracy', 'Rating', 'Composure', 'Judge Intentions', 'Memory', 'Lift/Carry']) assert.ok(g[k], k);
  assert.equal(g['Edge'], 'Chance');
  assert.equal(g['Body'], 'Constitution');
});

console.log('server i18n');
await test('server t/tn read the same dictionaries; errorBody; normalizeLogEntry', () => {
  assert.equal(S.t('fr', 'Map'), 'Carte');
  assert.equal(S.t('en', 'Map'), 'Map');
  assert.equal(S.t('fr', 'Unknown action: {type}', { type: 'x/y' }), 'Action inconnue : x/y');
  assert.equal(S.t('en', 'Unknown action: {type}', { type: 'x/y' }), 'Unknown action: x/y');
  assert.equal(S.t('fr', 'No such key {a}', { a: 1 }), 'No such key 1');
  assert.equal(S.tn('en', 3, '{n} player', '{n} players'), '3 players');
  assert.equal(S.tn('fr', 1, '{n} player', '{n} players'), '1 joueur');
  assert.equal(S.tn('fr', 3, '{n} player', '{n} players'), '3 joueurs');
  assert.deepEqual(S.errorBody('This character is already taken by {name}', { name: 'Bob' }), { error: 'This character is already taken by Bob', errorKey: 'This character is already taken by {name}', params: { name: 'Bob' } });
  assert.deepEqual(S.errorBody('Empty file', null, { code: 'x' }), { error: 'Empty file', errorKey: 'Empty file', code: 'x' });
  // A function param is invalid input on purpose (dropped by normalizeLogEntry).
  const e = S.normalizeLogEntry({ kind: 'system', i18n: { key: '{actor} enters the combat!', params: { actor: 'Jane', bad: (() => 0) as unknown as string } } } as NewLogEntry);
  assert.equal(e.text, 'Jane enters the combat!');
  assert.deepEqual(e.i18n, { key: '{actor} enters the combat!', params: { actor: 'Jane' } });
  assert.equal(S.normalizeLogEntry({ text: 'kept', i18n: { key: 'K {x}', params: { x: 1 } } }).text, 'kept');
  const bad = S.normalizeLogEntry({ text: 't', i18n: { nokey: 1 } as unknown as I18nEntry } as NewLogEntry); // malformed on purpose
  assert.equal(bad.i18n, undefined);
  assert.deepEqual(S.dictionaryFiles('fr')[0], 'glossary.json');
  assert.deepEqual(S.dictionaryFiles('en'), [], 'no English dictionaries: English is the source');
  assert.deepEqual(S.dictionaryFiles('xx'), []);
});

console.log('server integration');
const srv = await startServer({ port: 3800 + Math.floor(Math.random() * 40), keepRuntime: true });
/** Raw socket reply: error replies keep their errorKey/params (send() only keeps the text). */
type Reply = Extract<ActionResponse, { ok: false }> | { ok: true; result: unknown; error?: undefined; errorKey?: undefined; params?: I18nParams };
const raw = (c: TestClient, type: string, payload: ActionPayload = {}) => new Promise<Reply>((res) => c.socket.emit('action', { type, payload }, res));
try {
  await test('French dictionaries and the legacy key map are served, with a generated index', async () => {
    const idx = await (await fetch(`${srv.url}/i18n/fr/index.json`)).json();
    assert.equal(idx.lang, 'fr');
    assert.equal(idx.files[0], 'glossary.json');
    assert.deepEqual([...idx.files].sort(), dictFiles.filter((f) => f !== 'index.json').sort());
    const core = await fetch(`${srv.url}/i18n/fr/core.json`);
    assert.equal(core.status, 200);
    assert.equal((await core.json())['Close'], 'Fermer');
    const legacy = await fetch(`${srv.url}/i18n/legacy-fr-keys.json`);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json())['Attaque — {weapon}'], 'Attack — {weapon}');
    assert.deepEqual((await (await fetch(`${srv.url}/i18n/en/index.json`)).json()).files, [], 'English is the source: no dictionary');
    assert.equal((await fetch(`${srv.url}/i18n/xx/index.json`)).status, 404);
    // (The client code itself is bundled by Vite now: its source modules are no longer served one by one.)
  });

  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const pcIds = Object.values(gm.state.actors).filter((a) => a.type === 'pc' && !a.retired).map((a) => a.id);

  await test('action errors carry errorKey + params (and the English text)', async () => {
    const r = await raw(gm, 'nope/doesNotExist');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Unknown action: nope/doesNotExist');
    assert.equal(r.errorKey, 'Unknown action: {type}');
    assert.deepEqual(r.params, { type: 'nope/doesNotExist' });
    assert.equal(S.t('fr', r.errorKey!, r.params), 'Action inconnue : nope/doesNotExist');
    const r2 = await raw(gm, 'config/update', { campaignName: '   ' });
    assert.equal(r2.errorKey, 'The campaign name cannot be empty');
    assert.equal(r2.error, 'The campaign name cannot be empty');
    assert.equal(r2.params, undefined);
  });

  await test('HTTP errors carry errorKey + params', async () => {
    const bad = await fetch(`${srv.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'gm', password: 'wrong' }) });
    assert.equal(bad.status, 403);
    const j = await bad.json();
    assert.equal(j.errorKey, 'Wrong GM password');
    assert.equal(j.error, 'Wrong GM password');
    await login(srv.url, { role: 'player', name: 'Prem', characterId: pcIds[0] });
    const taken = await fetch(`${srv.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'player', name: 'Deuz', characterId: pcIds[0] }) });
    const tj = await taken.json();
    assert.equal(taken.status, 403);
    assert.equal(tj.errorKey, 'This character is already taken by {name}');
    assert.equal(tj.error, 'This character is already taken by Prem');
    assert.deepEqual(tj.params, { name: 'Prem' });
    const nf = await (await fetch(`${srv.url}/api/nothing-here`)).json();
    assert.equal(nf.errorKey, 'Not found');
  });

  let pToken = '';
  await test('language chosen at login is stored on the user (me.lang), the table language stays the default', async () => {
    pToken = await login(srv.url, { role: 'player', name: 'Anglo', characterId: pcIds[1], lang: 'en' });
    const p = await client(srv.url, pToken);
    assert.equal(p.state.me.lang, 'en');
    assert.equal(p.state.config.lang, 'fr');
    assert.equal((p.state.config as { gmLang?: unknown }).gmLang, undefined, 'GM language never leaks into config views');
    assert.equal((p.state.users[p.state.me.id] as { lang?: unknown }).lang, undefined, 'other users’ languages are not exposed');
    p.close();
    const other = await client(srv.url, await login(srv.url, { role: 'player', name: 'Franco' }));
    assert.equal(other.state.me.lang, null);
    other.close();
  });

  await test('users/setLang: players and GM, persisted per user, invalid refused', async () => {
    const p = await client(srv.url, pToken);
    assert.deepEqual(await p.send('users/setLang', { lang: 'fr' }), { lang: 'fr' });
    await settle();
    assert.equal(p.state.me.lang, 'fr');
    const r = await raw(p, 'users/setLang', { lang: 'de' });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'Unknown language');
    await p.send('users/setLang', { lang: null });
    await settle();
    assert.equal(p.state.me.lang, null);
    await p.send('users/setLang', { lang: 'en' });
    await gm.send('users/setLang', { lang: 'en' });
    await settle();
    assert.equal(gm.state.me.lang, 'en');
    assert.equal(p.state.me.lang, 'en');
    p.close();
    const again = await client(srv.url, pToken); // reconnect: still English
    assert.equal(again.state.me.lang, 'en');
    again.close();
  });

  await test('GM table language: config/update lang reaches views, the table list and the registry', async () => {
    await gm.send('config/update', { lang: 'en' });
    await settle();
    assert.equal(gm.state.config.lang, 'en');
    assert.equal(gm.state.config.table.lang, 'en');
    const list = await (await fetch(`${srv.url}/api/tables?choisir`)).json(); // HTTP bodies: untyped JSON (any)
    assert.equal(list.tables[0].lang, 'en');
    const adminToken = await srv.admin();
    const admin = await (await fetch(`${srv.url}/api/admin/tables`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(admin.tables.find((x: { id: string }) => x.id === 'lazarus').lang, 'en');
    const lobby = await (await fetch(`${srv.url}/api/lobby?table=lazarus`)).json();
    assert.equal(lobby.table.lang, 'en');
  });

  gm.close();
  await test('languages survive a server restart', async () => {
    // Windows kills the server without a signal (no shutdown flush): let the debounced save (400 ms) land first.
    await new Promise((r) => setTimeout(r, 900));
    await srv.stopAndWait({ keep: true });
    const srv2 = await startServer({ port: srv.port + 1, runtime: srv.runtime, keepRuntime: true });
    try {
      const p = await client(srv2.url, pToken);
      assert.equal(p.state.me.lang, 'en');
      assert.equal(p.state.config.lang, 'en');
      p.close();
      const g = await client(srv2.url, gmToken);
      assert.equal(g.state.me.lang, 'en');
      g.close();
    } finally {
      await srv2.stopAndWait({ keep: true });
    }
  });
} finally {
  srv.stop();
  try {
    fs.rmSync(srv.runtime, { recursive: true, force: true });
  } catch {}
}

console.log('tools');
/** `node tools/i18n-check.ts --json` output (the fields read here). */
interface CheckReport {
  files: number;
  keys: number;
  problems: Array<{ file: string; msg: string; fatal?: boolean }>;
  missing: Array<{ file: string; line: number; key: string; kind: string }>;
  dynamic: Array<{ file: string; line: number; text: string; kind: string }>;
  literals: Array<{ file: string; line: number; text: string; kind: string }>;
  legacy: number;
}
// The child node process runs the .ts tool: before Node 22.18 it needs the type-stripping flag.
const NODE_TS = process.execArgv.filter((a) => a === '--experimental-strip-types' || a === '--no-warnings');
/** Run the checker; its JSON report is read even when it exits 1 (invalid dictionary, --strict with missing keys). */
const runCheck = (...args: string[]): CheckReport => {
  let out: string;
  try {
    out = execFileSync(process.execPath, [...NODE_TS, 'tools/i18n-check.ts', ...args, '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    out = String((err as { stdout?: unknown }).stdout ?? '');
  }
  return JSON.parse(out);
};
await test('i18n-check: core area fully translated (--strict), JSON output parses', () => {
  const j = runCheck('--area', 'core', '--strict');
  assert.equal(j.problems.filter((p) => p.fatal).length, 0, 'French dictionaries and legacy map are valid');
  assert.deepEqual(j.missing, [], 'every English key of the core area has a French entry');
  assert.deepEqual(j.literals, [], 'no text left outside t() in core files');
  assert.ok(j.keys > 200);
});
await test('i18n-check: finds missing French entries, dynamic keys and text not wrapped in t()', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'tools', '.i18n-sample-'));
  const file = path.join(dir, 'Sample.ts');
  fs.writeFileSync(file, [
    "import { t, tn, tk } from '../lib/i18n.ts';",
    "// t('In a comment')",
    "const L = { a: tk('Constant label never translated') };",
    "export const X = () => [t('Key never translated {n}', { n: 1 }), t('Map'), tn(2, '{n} apple', '{n} apples'), t(`Dynamic ${1}`)];",
    "toast('Hard-coded error'); // i18n-ignore",
    "toast('Another hard-coded error');",
    "setErr('Erreur codée en dur');",
    "toast('SR5');",
  ].join('\n'));
  try {
    const j = runCheck(path.relative(ROOT, file));
    const keys = j.missing.map((m) => m.key).sort();
    assert.deepEqual(keys, ['Constant label never translated', 'Key never translated {n}', '{n} apple', '{n} apples'].sort(), "'Map' has its French entry");
    assert.equal(j.dynamic.length, 1);
    const lits = j.literals.map((l) => l.text);
    assert.ok(lits.includes('Another hard-coded error'), 'toast literal flagged');
    assert.ok(lits.includes('Erreur codée en dur'), 'any language');
    assert.ok(!lits.includes('Hard-coded error'), 'i18n-ignore respected');
    assert.ok(!lits.includes('SR5'), 'single all-caps token not flagged');
    assert.ok(!keys.includes('In a comment'), 'comments ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
await test('i18n-check: reads keys and unwrapped text in TSX (JSX text, attributes, {t()} children)', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'tools', '.i18n-sample-'));
  const file = path.join(dir, 'Sample.tsx');
  fs.writeFileSync(file, [
    "import { t, tn } from '../lib/i18n.ts';",
    'export function Sample({ n }: { n: number }) {',
    "  const big = n > 2 ? send<string>('x/y', {}) : null;",
    '  return (',
    '    <div className="sample big-box" title="Close the window" aria-label="Main menu">',
    "      <b>{t('JSX key never translated')}</b> <span title={t('JSX attribute never translated')}>{tn(n, '{n} pear', '{n} pears')}</span>",
    '      <p>No character yet</p> <p>Aucun personnage</p>',
    '      {n > 1 && <i>Already there</i>}',
    "      {big ? <b>{n}</b> : big ? 'a' : null}",
    '      <b>SR5</b> <i>Shadowrun</i> <span>PIN</span> <span>×</span> <code>npm run build</code>',
    "      <input placeholder=\"min\" /> <img alt=\"\" />",
    "      <p>{/* t('JSX comment') */}Text ignored on purpose</p> {/* i18n-ignore */}",
    '    </div>',
    '  );',
    '}',
  ].join('\n'));
  try {
    const j = runCheck(path.relative(ROOT, file));
    assert.deepEqual(j.missing.map((m) => m.key).sort(), ['JSX attribute never translated', 'JSX key never translated', '{n} pear', '{n} pears'].sort());
    assert.deepEqual(j.literals.map((l) => l.text).sort(), ['Already there', 'Aucun personnage', 'Close the window', 'Main menu', 'No character yet'].sort(), 'JSX text, title= and aria-label= flagged; code, names, symbols and ignored lines not');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
await test('i18n-check: dictionary problems (placeholders, same key translated two ways)', () => {
  // A scratch dictionary folder (--dict-dir), so the real client/i18n/fr is never touched.
  const dir = fs.mkdtempSync(path.join(ROOT, 'tools', '.i18n-dict-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ Map: 'Carte', 'Hello {name}': 'Bonjour {nom}' }, null, 2));
  fs.writeFileSync(path.join(dir, 'b.json'), ['{', '  "Map": "Plan",', '  "Twice": "Deux fois",', '  "Twice": "Encore"', '}'].join('\n'));
  fs.writeFileSync(path.join(dir, 'c.json'), '{ "broken": ');
  try {
    const j = runCheck('client/i18n/format.ts', '--dict-dir', path.relative(ROOT, dir));
    const msgs = j.problems.map((p) => `${p.file.split('/').pop()}: ${p.fatal ? 'ERROR ' : ''}${p.msg}`);
    assert.ok(msgs.some((m) => m.startsWith('a.json: placeholders differ') && m.includes('Hello {name}')), 'placeholder mismatch');
    assert.ok(msgs.some((m) => m.startsWith('b.json: “Map” already translated differently in a.json')), 'same key, two translations across files');
    assert.ok(msgs.some((m) => m.startsWith('b.json: “Twice” is written 2 times, translated two ways')), 'duplicate key in one file');
    assert.ok(msgs.some((m) => m.startsWith('c.json: ERROR invalid JSON')), 'invalid JSON is fatal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
await test('client files of the i18n foundation exist and are type-checked by tsconfig.json', () => {
  // These were checked with `node --check` when they were plain JS. The client is TypeScript now and `npm run typecheck`
  // (tsc) is what validates it: here, the files exist and tsconfig's include/exclude cover them, with strict on.
  const files = ['client/app.tsx', 'client/lib/i18n.ts', 'client/lib/net.ts', 'client/lib/ui.tsx', 'client/lib/ui-store.ts', 'client/modules/registry.ts', 'client/modules/core/SettingsPage.tsx', 'client/modules/admin/AdminPage.tsx', 'client/modules/admin/FoundryUpload.tsx', 'client/modules/admin/common.tsx', 'client/i18n/format.ts'];
  // tsconfig.json is JSONC: drop whole-line comments before parsing.
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { include: string[]; exclude: string[]; compilerOptions: { strict?: boolean } };
  assert.equal(cfg.compilerOptions.strict, true);
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
    assert.ok(cfg.include.some((inc) => f === inc || f.startsWith(inc + '/')), `${f} is in tsconfig include`);
    assert.ok(!cfg.exclude.some((ex) => f === ex || f.startsWith(ex + '/')), `${f} is not excluded`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
