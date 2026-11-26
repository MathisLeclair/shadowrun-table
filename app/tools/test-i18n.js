// Tests of the i18n foundation: format core, client t/tn/fallback/missing, dictionaries, server helpers,
// error keys over the socket and HTTP, per-user language persistence, table language, the i18n-check tool.
// Run: node tools/test-i18n.js   (isolated servers on ports 3800-3849)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.js';
import * as F from '../client/i18n/format.js';
import * as I from '../client/lib/i18n.js';
import * as S from '../server/lib/i18n.js';
import { ATTR_LABELS, SKILLS, SKILL_GROUPS } from '../shared/sr5.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'en');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

console.log('format core');
await test('interpolate: named params, unknown left as-is, nested translatable params, arrays', () => {
  assert.equal(F.interpolate('Salut {name}, {n} PJ', { name: 'Jane', n: 3 }), 'Salut Jane, 3 PJ');
  assert.equal(F.interpolate('Salut {name} {other}', { name: 'Jane' }), 'Salut Jane {other}');
  assert.equal(F.interpolate('{a}', { a: null }), '');
  assert.equal(F.interpolate('{who} : {what}', { who: 'X', what: { t: 'Tir {n}', params: { n: 2 } } }), 'X : Tir 2');
  assert.equal(F.interpolate('{who}', { who: { t: 'ctx::Force' } }), 'Force');
  assert.equal(F.interpolate('{list}', { list: ['a', 'b'] }), 'a, b');
  assert.equal(F.interpolate('pas de params', undefined), 'pas de params');
});
await test('context keys and placeholders', () => {
  assert.equal(F.stripContext('magie::Force'), 'Force');
  assert.equal(F.stripContext('Force'), 'Force');
  assert.deepEqual(F.placeholders('{a} et {b} puis {a}').sort(), ['a', 'b']);
});
await test('plural categories: French 0/1 singular, English only 1', () => {
  assert.equal(F.pluralCategory('fr', 0), 'one');
  assert.equal(F.pluralCategory('fr', 1), 'one');
  assert.equal(F.pluralCategory('fr', 1.5), 'one');
  assert.equal(F.pluralCategory('fr', 2), 'other');
  assert.equal(F.pluralCategory('en', 0), 'other');
  assert.equal(F.pluralCategory('en', 1), 'one');
  assert.equal(F.pluralKey('en', 0, { zero: 'Aucun', one: 'un', other: 'des' }), 'Aucun');
});
await test('cleanParams keeps small JSON-safe values and nested { t } params only', () => {
  const p = F.cleanParams({ a: 'x', n: 2, b: true, z: null, fn: () => 1, obj: { evil: 1 }, nested: { t: 'K', params: { x: 1 } }, 'bad key': 1, arr: [1, 'a', { t: 'K' }, { no: 1 }] });
  assert.deepEqual(p, { a: 'x', n: 2, b: true, z: null, nested: { t: 'K', params: { x: 1 } }, arr: [1, 'a', { t: 'K' }] });
  assert.equal(F.cleanParams('x'), undefined);
  assert.equal(F.cleanParams([1]), undefined);
});

console.log('client i18n');
await test('t: French source, English entry, fallback to French, interpolation', () => {
  I.setDictionary({ 'Bonjour {name}': 'Hello {name}', Carte: 'Map', 'magie::Force': 'Force (spell)', 'Vide pour l’instant': '' });
  I.setLang('fr');
  assert.equal(I.t('Bonjour {name}', { name: 'Jane' }), 'Bonjour Jane');
  assert.equal(I.t('magie::Force'), 'Force');
  I.setLang('en');
  assert.equal(I.getLang(), 'en');
  assert.equal(I.t('Bonjour {name}', { name: 'Jane' }), 'Hello Jane');
  assert.equal(I.t('Carte'), 'Map');
  assert.equal(I.t('magie::Force'), 'Force (spell)');
  assert.equal(I.t('Pas traduit {x}', { x: 1 }), 'Pas traduit 1');
  assert.equal(I.t('Vide pour l’instant'), 'Vide pour l’instant', 'an empty entry falls back to French');
});
await test('missing keys are collected (both languages), tIfKnown never counts', () => {
  I.clearMissing();
  I.setLang('en');
  I.t('Clé absente A');
  I.t('Clé absente A');
  I.setLang('fr');
  I.t('Clé absente B');
  I.t('Carte');
  I.tIfKnown('Texte libre du joueur');
  I.t('');
  I.t('123');
  assert.deepEqual(I.missingKeys(), { 'Clé absente A': 2, 'Clé absente B': 1 });
  assert.equal(I.missingCount(), 2);
  I.clearMissing();
  assert.equal(I.missingCount(), 0);
});
await test('tn: plural forms per language, {n} always available, zero form', () => {
  I.setDictionary({ '{n} objet': '{n} item', '{n} objets': '{n} items', 'Aucun objet': 'No items', '{n} objet pour {who}': '{n} item for {who}', '{n} objets pour {who}': '{n} items for {who}' });
  I.setLang('fr');
  assert.equal(I.tn(0, '{n} objet', '{n} objets'), '0 objet');
  assert.equal(I.tn(1, '{n} objet', '{n} objets'), '1 objet');
  assert.equal(I.tn(4, '{n} objet', '{n} objets'), '4 objets');
  I.setLang('en');
  assert.equal(I.tn(0, '{n} objet', '{n} objets'), '0 items');
  assert.equal(I.tn(1, '{n} objet', '{n} objets'), '1 item');
  assert.equal(I.tn(0, { zero: 'Aucun objet', one: '{n} objet', other: '{n} objets' }), 'No items');
  assert.equal(I.tn(2, '{n} objet pour {who}', '{n} objets pour {who}', { who: 'Jane' }), '2 items for Jane');
});
await test('language listeners, invalid languages ignored', () => {
  I.setLang('fr');
  const seen = [];
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
  I.setDictionary({ 'Action inconnue : {type}': 'Unknown action: {type}', 'Message vide': 'Empty message', '{actor} dépense 1 point de Chance': '{actor} spends 1 Edge point', Erreur: 'Error' });
  I.setLang('en');
  assert.equal(I.errorText({ error: 'Action inconnue : x', errorKey: 'Action inconnue : {type}', params: { type: 'x' } }), 'Unknown action: x');
  assert.equal(I.errorText({ error: 'Message vide' }), 'Empty message', 'plain French errors are translated when known');
  assert.equal(I.errorText({ error: 'Texte inconnu' }), 'Texte inconnu');
  assert.equal(I.errorText(null), 'Error');
  assert.equal(I.logText({ kind: 'system', text: 'Jane dépense 1 point de Chance', i18n: { key: '{actor} dépense 1 point de Chance', params: { actor: 'Jane' } } }), 'Jane spends 1 Edge point');
  assert.equal(I.logText({ kind: 'system', text: 'Message vide' }), 'Empty message');
  assert.equal(I.logText({ kind: 'chat', text: 'Message vide' }), 'Message vide', 'chat is never translated');
  I.setLang('fr');
  assert.equal(I.logText({ kind: 'system', text: 'x', i18n: { key: '{actor} dépense 1 point de Chance', params: { actor: 'Jane' } } }), 'Jane dépense 1 point de Chance');
});
await test('SR5 vocabulary helpers and catalog names', () => {
  I.setDictionary(JSON.parse(fs.readFileSync(path.join(DICT_DIR, 'glossary.json'), 'utf8')));
  I.setLang('en');
  assert.equal(I.attrLabel('EDG'), 'Edge');
  assert.equal(I.attrLabel('BOD'), 'Body');
  assert.equal(I.attrShort('BOD'), 'BOD');
  assert.equal(I.skillLabel('pistols'), 'Pistols');
  assert.equal(I.skillLabel({ id: 'pilot_ground_craft', name: 'Pilotage (véhicules terrestres)' }), 'Pilot Ground Craft');
  assert.equal(I.skillLabel({ id: 'free_fall' }), 'Free-Fall');
  assert.equal(I.skillLabel({ id: 'custom-x', name: 'Ma compétence' }), 'Ma compétence');
  assert.equal(I.skillGroupLabel('close_combat'), 'Close Combat');
  assert.equal(I.skillGroupLabel('stealth'), 'Stealth');
  assert.equal(I.skillCategoryLabel('magic'), 'Magical');
  assert.equal(I.limitLabel('social'), 'Social Limit');
  assert.equal(I.metatypeLabel('Nain'), 'Dwarf');
  assert.equal(I.itemName({ name: 'Ares Predator V', nameFr: 'Ares Predator V (fr)' }), 'Ares Predator V');
  assert.equal(I.fmtNuyen(12500), '12,500¥');
  I.setLang('fr');
  assert.equal(I.attrLabel('EDG'), 'Chance');
  assert.equal(I.attrShort('BOD'), 'CON');
  assert.equal(I.skillLabel('pistols'), 'Pistolets');
  assert.equal(I.skillGroupLabel('stealth'), 'Furtivité');
  assert.equal(I.skillCategoryLabel('magic'), 'Magiques');
  assert.equal(I.itemName({ name: 'Ares Predator V', nameFr: 'Ares Predator V (fr)' }), 'Ares Predator V (fr)');
  assert.equal(I.itemName({ name: 'Only EN' }), 'Only EN');
  assert.equal(I.fmtNuyen(12500), '12 500¥');
});

console.log('dictionaries');
const dictFiles = fs.readdirSync(DICT_DIR).filter((f) => f.endsWith('.json'));
await test('every client/i18n/en/*.json is a flat { string: string } object with matching placeholders', () => {
  assert.ok(dictFiles.includes('glossary.json') && dictFiles.includes('core.json') && dictFiles.includes('admin.json'));
  for (const area of ['map', 'sheet', 'combat', 'shop', 'training', 'audio', 'campaign', 'foundry', 'chummer', 'matrix', 'chargen']) assert.ok(dictFiles.includes(`${area}.json`), `${area}.json exists`);
  for (const f of dictFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8'));
    assert.ok(data && typeof data === 'object' && !Array.isArray(data), f);
    for (const [k, v] of Object.entries(data)) {
      assert.equal(typeof v, 'string', `${f}: ${k}`);
      if (v) assert.deepEqual(F.placeholders(v).sort(), F.placeholders(k).sort(), `${f}: placeholders of « ${k} »`);
    }
  }
});
await test('glossary covers the SR5 labels of shared/sr5.js', () => {
  const g = JSON.parse(fs.readFileSync(path.join(DICT_DIR, 'glossary.json'), 'utf8'));
  for (const fr of Object.values(ATTR_LABELS)) assert.ok(g[fr], `attribute ${fr}`);
  for (const s of SKILLS) assert.ok(g[s.fr], `skill ${s.fr}`);
  for (const fr of Object.values(SKILL_GROUPS)) assert.ok(g[fr], `group ${fr}`);
  for (const k of ['Moniteur de condition', 'Glitch critique', 'Dépasser les limites', 'Seconde chance', 'Saisir l’initiative', 'Score de Surveillance', 'Marques', 'Rang Professionnel', 'Disponibilité', 'VD', 'PA', 'Précision', 'Indice', 'Sang-froid', 'Jauger les intentions', 'Mémoire', 'Soulever/porter']) assert.ok(g[k], k);
  assert.equal(g['Chance'], 'Edge');
  assert.equal(g['Score de Surveillance'], 'Overwatch Score');
});

console.log('server i18n');
await test('server t/tn read the same dictionaries; errorBody; normalizeLogEntry', () => {
  assert.equal(S.t('en', 'Carte'), 'Map');
  assert.equal(S.t('fr', 'Carte'), 'Carte');
  assert.equal(S.t('en', 'Action inconnue : {type}', { type: 'x/y' }), 'Unknown action: x/y');
  assert.equal(S.t('en', 'Clé inexistante {a}', { a: 1 }), 'Clé inexistante 1');
  assert.equal(S.tn('en', 3, '{n} joueur', '{n} joueurs'), '3 players');
  assert.equal(S.tn('fr', 1, '{n} joueur', '{n} joueurs'), '1 joueur');
  assert.deepEqual(S.errorBody('Ce personnage est déjà pris par {name}', { name: 'Bob' }), { error: 'Ce personnage est déjà pris par Bob', errorKey: 'Ce personnage est déjà pris par {name}', params: { name: 'Bob' } });
  assert.deepEqual(S.errorBody('Fichier vide', null, { code: 'x' }), { error: 'Fichier vide', errorKey: 'Fichier vide', code: 'x' });
  const e = S.normalizeLogEntry({ kind: 'system', i18n: { key: '{actor} entre dans le combat !', params: { actor: 'Jane', bad: () => 0 } } });
  assert.equal(e.text, 'Jane entre dans le combat !');
  assert.deepEqual(e.i18n, { key: '{actor} entre dans le combat !', params: { actor: 'Jane' } });
  assert.equal(S.normalizeLogEntry({ text: 'gardé', i18n: { key: 'K {x}', params: { x: 1 } } }).text, 'gardé');
  const bad = S.normalizeLogEntry({ text: 't', i18n: { nokey: 1 } });
  assert.equal(bad.i18n, undefined);
  assert.deepEqual(S.dictionaryFiles('en')[0], 'glossary.json');
  assert.deepEqual(S.dictionaryFiles('xx'), []);
});

console.log('server integration');
const srv = await startServer({ port: 3800 + Math.floor(Math.random() * 40), keepRuntime: true });
const raw = (c, type, payload = {}) => new Promise((res) => c.socket.emit('action', { type, payload }, res));
try {
  await test('dictionaries are served, with a generated index', async () => {
    const idx = await (await fetch(`${srv.url}/i18n/en/index.json`)).json();
    assert.equal(idx.lang, 'en');
    assert.equal(idx.files[0], 'glossary.json');
    assert.deepEqual([...idx.files].sort(), dictFiles.filter((f) => f !== 'index.json').sort());
    const core = await fetch(`${srv.url}/i18n/en/core.json`);
    assert.equal(core.status, 200);
    assert.equal((await core.json())['Carte'], 'Map');
    assert.equal((await fetch(`${srv.url}/i18n/xx/index.json`)).status, 404);
    assert.equal((await fetch(`${srv.url}/lib/i18n.js`)).status, 200);
    assert.equal((await fetch(`${srv.url}/i18n/format.js`)).status, 200);
  });

  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const pcIds = Object.values(gm.state.actors).filter((a) => a.type === 'pc' && !a.retired).map((a) => a.id);

  await test('action errors carry errorKey + params (and the French text)', async () => {
    const r = await raw(gm, 'nope/doesNotExist');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Action inconnue : nope/doesNotExist');
    assert.equal(r.errorKey, 'Action inconnue : {type}');
    assert.deepEqual(r.params, { type: 'nope/doesNotExist' });
    const r2 = await raw(gm, 'config/update', { campaignName: '   ' });
    assert.equal(r2.errorKey, 'Le nom de la campagne ne peut pas être vide');
    assert.equal(r2.error, 'Le nom de la campagne ne peut pas être vide');
    assert.equal(r2.params, undefined);
  });

  await test('HTTP errors carry errorKey + params', async () => {
    const bad = await fetch(`${srv.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'gm', password: 'wrong' }) });
    assert.equal(bad.status, 403);
    const j = await bad.json();
    assert.equal(j.errorKey, 'Mot de passe MJ incorrect');
    assert.equal(j.error, 'Mot de passe MJ incorrect');
    await login(srv.url, { role: 'player', name: 'Prem', characterId: pcIds[0] });
    const taken = await fetch(`${srv.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'player', name: 'Deuz', characterId: pcIds[0] }) });
    const tj = await taken.json();
    assert.equal(taken.status, 403);
    assert.equal(tj.errorKey, 'Ce personnage est déjà pris par {name}');
    assert.deepEqual(tj.params, { name: 'Prem' });
    const nf = await (await fetch(`${srv.url}/api/nothing-here`)).json();
    assert.equal(nf.errorKey, 'Introuvable');
  });

  let pToken;
  await test('language chosen at login is stored on the user (me.lang), the table language stays the default', async () => {
    pToken = await login(srv.url, { role: 'player', name: 'Anglo', characterId: pcIds[1], lang: 'en' });
    const p = await client(srv.url, pToken);
    assert.equal(p.state.me.lang, 'en');
    assert.equal(p.state.config.lang, 'fr');
    assert.equal(p.state.config.gmLang, undefined, 'GM language never leaks into config views');
    assert.equal(p.state.users[p.state.me.id].lang, undefined, 'other users’ languages are not exposed');
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
    assert.equal(r.errorKey, 'Langue inconnue');
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
    const list = await (await fetch(`${srv.url}/api/tables?choisir`)).json();
    assert.equal(list.tables[0].lang, 'en');
    const adminToken = await srv.admin();
    const admin = await (await fetch(`${srv.url}/api/admin/tables`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(admin.tables.find((x) => x.id === 'lazarus').lang, 'en');
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
await test('i18n-check: core area fully translated (--strict), JSON output parses', () => {
  const out = execFileSync(process.execPath, ['tools/i18n-check.js', '--area', 'core', '--strict', '--json'], { cwd: ROOT, encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.problems.filter((p) => p.msg.startsWith('JSON')).length, 0);
  assert.deepEqual(j.missing, []);
  assert.deepEqual(j.literals, [], 'no untranslated French in core files');
  assert.ok(j.keys > 200);
});
await test('i18n-check: finds keys, dynamic keys and French literals in a sample file', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'tools', '.i18n-sample-'));
  const file = path.join(dir, 'Sample.js');
  fs.writeFileSync(file, [
    "import { t, tn, tk } from '../lib/i18n.js';",
    "// t('Dans un commentaire')",
    "const L = { a: tk('Étiquette constante') };",
    "export const X = () => html`<div title=\"Bouton d’aide\">${t('Clé jamais traduite {n}', { n: 1 })} Texte en dur à traduire</div>",
    "  <input placeholder=${t('Carte')} /> ${tn(2, '{n} pomme', '{n} pommes')} ${t(`Dynamique ${1}`)}`;",
    "toast('Erreur en dur'); // i18n-ignore",
    "toast('Autre erreur en dur');",
  ].join('\n'));
  try {
    const j = JSON.parse(execFileSync(process.execPath, ['tools/i18n-check.js', path.relative(ROOT, file), '--json'], { cwd: ROOT, encoding: 'utf8' }));
    const keys = j.missing.map((m) => m.key).sort();
    assert.deepEqual(keys, ['Clé jamais traduite {n}', 'Étiquette constante', '{n} pomme', '{n} pommes'].sort());
    assert.equal(j.dynamic.length, 1);
    const lits = j.literals.map((l) => l.text);
    assert.ok(lits.includes('Bouton d’aide'), 'title= flagged');
    assert.ok(lits.includes('Texte en dur à traduire'), 'text node flagged');
    assert.ok(lits.includes('Autre erreur en dur'), 'toast literal flagged');
    assert.ok(!lits.includes('Erreur en dur'), 'i18n-ignore respected');
    assert.ok(!keys.includes('Dans un commentaire'), 'comments ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
await test('client files of the i18n foundation parse', () => {
  for (const f of ['client/app.js', 'client/lib/i18n.js', 'client/lib/net.js', 'client/lib/ui.js', 'client/lib/ui-store.js', 'client/modules/registry.js', 'client/modules/core/SettingsPage.js', 'client/modules/admin/AdminPage.js', 'client/modules/admin/FoundryUpload.js', 'client/modules/admin/common.js', 'client/i18n/format.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
