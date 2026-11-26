// Tests for the Foundry import: node tools/test-foundry.js  (exit code ≠ 0 on failure)
// 1) Converters on the GM's world (exploration dump if present, else the LevelDB read from a temp copy).
// 2) scan/import actions through an isolated server (port 3910) pointing at a temp copy of the world,
//    with tiny placeholder asset files; re-import idempotence; merge vs replace.
// Foundry folders are only read. Assets/journals of the test server go to temp dirs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.js';
import { readWorld, readDump, detectWorldPath, assemble } from '../server/lib/foundry/world.js';
import { buildBundle, pcDiffEntries, pcDiff } from '../server/lib/foundry/importer.js';
import { i18nError, plural, bytesParam } from '../server/lib/foundry/messages.js';
import { t as tr, dictionary } from '../server/lib/i18n.js';
import { htmlToMarkdown } from '../server/lib/foundry/html2md.js';
import { SKILL_BY_ID, parseDamage } from '../shared/sr5.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}

const DUMP = path.join(os.tmpdir(), 'claude', '475e7aca9aa207a1', '3c07fd5a-6eb8-4c24-a36b-98077d5ccf6d', 'scratchpad', 'foundry');
const WORLD = detectWorldPath();
if (!fs.existsSync(path.join(WORLD, 'world.json')) && !fs.existsSync(path.join(DUMP, 'actors.json'))) {
  console.log('Aucun monde Foundry ni dump disponible — tests ignorés.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------
console.log('html2md / assemble');
{
  const md = htmlToMarkdown('<h2>Titre</h2><p>Voir @Actor[abc]{Dorian Ashe} et <strong>gras</strong>, <em>it</em>.</p><ul><li>un</li><li>deux<ul><li>sous</li></ul></li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>@Item[x]{Armor Jacket} &amp; [[/r 2d6]]</p>');
  ok(md.includes('## Titre'), 'heading');
  ok(md.includes('**Dorian Ashe**'), '@Actor link → bold name');
  ok(md.includes('**gras**') && md.includes('*it*'), 'bold/italic');
  ok(/- un\n- deux\n {2}- sous/.test(md), `nested list (${JSON.stringify(md)})`);
  ok(md.includes('| A | B |') && md.includes('| 1 | 2 |'), 'table');
  ok(md.includes('Armor Jacket & `2d6`'), '@Item + entity + inline roll');
  const w = assemble({ actors: { '!actors!a1': { _id: 'a1', name: 'A', items: ['i1'] }, '!actors.items!a1.i1': { _id: 'i1', name: 'Item', effects: ['e1'] }, '!actors.items.effects!a1.i1.e1': { _id: 'e1', name: 'Eff' } } });
  ok(w.actors[0].items[0].name === 'Item' && w.actors[0].items[0].effects[0].name === 'Eff', 'embedded documents assembled (2 levels)');
}

// ---------------------------------------------------------------------------
// 2. Converters on the real world
// ---------------------------------------------------------------------------
console.log('converters');
const world = fs.existsSync(path.join(DUMP, 'actors.json')) ? readDump(DUMP, WORLD) : await readWorld(WORLD);
const bundle = buildBundle(world, {});
{
  ok(bundle.pcs.length >= 4, `PCs found (${bundle.pcs.length})`);
  const ids = bundle.pcs.map((p) => p.appId);
  for (const id of ['pc_anthony', 'pc_jane', 'pc_bricks', 'pc_anklay']) ok(ids.includes(id), `PC ${id} mapped`);
  for (const pc of bundle.pcs) {
    const s = pc.sheet;
    for (const k of ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA']) ok(s.attributes[k] >= 1 && s.attributes[k] <= 12, `${pc.name} ${k}=${s.attributes[k]} in 1..12`);
    ok(s.attributes.ESS > 0 && s.attributes.ESS <= 6, `${pc.name} ESS ${s.attributes.ESS}`);
    ok(s.skills.length >= 3, `${pc.name} has skills`);
    const known = s.skills.filter((x) => SKILL_BY_ID[x.id]).length;
    ok(known >= s.skills.length - 1, `${pc.name} skills mapped to SR5 ids (${known}/${s.skills.length})`);
    ok(s.skills.every((x) => x.rating > 0 && x.name && x.attr), `${pc.name} skills complete`);
    ok(s.weapons.length > 0 && s.weapons.every((w) => w.damage), `${pc.name} weapons have damage`);
    const parsed = s.weapons.filter((w) => parseDamage(w.damage).value !== null || /STR/.test(w.damage)).length;
    const special = s.weapons.filter((w) => /^(Spécial|Grenade|Missile|Rocket|As )/i.test(w.damage)).length;
    ok(parsed + special === s.weapons.length && parsed >= special, `${pc.name} weapon damage codes parse (${parsed}/${s.weapons.length})`);
    ok(s.weapons.every((w) => SKILL_BY_ID[w.skill]), `${pc.name} weapon skills valid (${s.weapons.map((w) => w.skill).join(',')})`);
    ok(s.initiative.dice >= 1 && s.initiative.dice <= 5, `${pc.name} initiative dice`);
  }
  const jane = bundle.pcs.find((p) => p.appId === 'pc_jane');
  if (jane) {
    ok(jane.sheet.nuyen === 98188 || jane.sheet.nuyen > 0, `Jane nuyen from Foundry (${jane.sheet.nuyen})`);
    ok(jane.owner?.name === 'Baptou', 'Jane owned by Baptou');
    ok(jane.sheet.attributes.REA + (jane.sheet.augmented.REA || 0) === 7, 'Jane REA 7 = natural + Improved Reflexes');
    ok(jane.sheet.initiative.dice === 3, 'Jane 3 initiative dice');
    ok(jane.sheet.powers.some((p) => p.level === 2 && p.pp === 2.5), 'adept power level & pp');
    ok(jane.sheet.vision.lowLight, 'Jane low-light vision (quality)');
    ok(jane.sheet.vehicles.length >= 1, 'Jane owns vehicles (SAAB/Nightwing)');
    ok(jane.sheet.sins.length === 3 && jane.sheet.sins.every((s) => s.licenses.every((l) => l.trim())), 'SINs with licenses');
  }
  const bricks = bundle.pcs.find((p) => p.appId === 'pc_bricks');
  if (bricks) {
    ok(bricks.sheet.matrix && /Shadow Warrior/.test(bricks.sheet.matrix.device) && bricks.sheet.matrix.attack === 6, 'Bricks cyberdeck ASDF');
    ok(bricks.sheet.matrix.programs.length >= 10, 'Bricks programs');
    ok(bricks.sheet.attributes.ESS < 6, 'Bricks essence lowered by cyberware');
  }
  const ank = bundle.pcs.find((p) => p.appId === 'pc_anklay');
  if (ank) ok(ank.sheet.augmented.STR === 4 && ank.sheet.augmented.AGI === 4, "Ank'Lay augmentations from active effects");
  const chris = bundle.pcs.find((p) => p.appId === 'pc_christopher');
  if (chris) ok(chris.retired && !chris.owner, 'Christopher (no owner) → retired');

  ok(bundle.npcs.filter((n) => n.matchId).length === 17, `17 NPCs matched to existing templates (${bundle.npcs.filter((n) => n.matchId).length})`);
  ok(bundle.npcs.some((n) => n.templateId === 'tpl_fvtt_perrine_cabana' && n.appFolder === 'Contacts & PNJ'), 'Perrine Cabana → Contacts & PNJ');
  ok(bundle.npcs.filter((n) => n.appFolder === 'Figurants').length >= 4, 'generic background NPCs → Figurants');

  ok(bundle.scenes.length >= 20, `scenes converted (${bundle.scenes.length})`);
  const mapIds = new Set();
  for (const sc of bundle.scenes) {
    const m = sc.map;
    ok(!mapIds.has(m.id), `unique map id ${m.id}`);
    mapIds.add(m.id);
    ok(m.width >= 1 && m.width <= 160 && m.height >= 1 && m.height <= 160, `${m.id} dims ${m.width}×${m.height}`);
    ok(m.tiles.length === m.height && m.tiles.every((r) => r.length === m.width && /^\.+$/.test(r)), `${m.id} tiles`);
    ok(m.walls.every((w) => [w.x1, w.x2].every((x) => x >= -0.001 && x <= m.width + 0.001) && [w.y1, w.y2].every((y) => y >= -0.001 && y <= m.height + 0.001)), `${m.id} walls in bounds`);
    ok(m.lights.every((l) => l.x >= 0 && l.y >= 0 && l.x < m.width && l.y < m.height && l.radius > 0), `${m.id} lights in bounds`);
    ok(m.background?.mode === 'image' && m.background.url.startsWith('/assets/foundry/scenes/'), `${m.id} image background`);
    const src = world.scenes.find((s) => s._id === sc.fid);
    const foundryDoors = (src.walls || []).filter((w) => w.door > 0).length;
    const doors = m.walls.filter((w) => w.door).length;
    ok(doors <= foundryDoors && doors >= foundryDoors - 2, `${m.id} doors ${doors}/${foundryDoors}`);
  }
  const alley = bundle.scenes.find((s) => s.name === 'Back Alley');
  if (alley) {
    ok(alley.map.width === 32 && alley.map.height === 18 && alley.map.metersPerCell === 2, 'Back Alley 32×18 cells, 2 m');
    ok(/Jetons dans Foundry : .*thug/.test(alley.map.description), 'tokens listed in description');
    ok(alley.appMapId === 'map_back_alley', 'Back Alley linked to app map');
  }
  const bar = bundle.scenes.find((s) => s.name === 'Bar');
  if (bar) ok(bar.map.walls.filter((w) => w.door).length === 11 && bar.map.walls.some((w) => w.door?.state === 'locked'), 'Bar: 11 doors incl. locked');
  ok(bundle.journals.docs.length >= 10 && bundle.journals.pdfs.length >= 5, 'journals + pdf list');
  ok(bundle.journals.docs.every((d) => !/@Actor\[/.test(d.content)), 'no raw @Actor links in markdown');
}

// ---------------------------------------------------------------------------
// 3. Server: scan / import / re-import
// ---------------------------------------------------------------------------
console.log('server (port 3910)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-foundry-test-'));
const dataRoot = path.join(tmp, 'Data');
const worldCopy = path.join(dataRoot, 'worlds', path.basename(WORLD));
fs.mkdirSync(path.join(worldCopy, 'data'), { recursive: true });
fs.copyFileSync(path.join(WORLD, 'world.json'), path.join(worldCopy, 'world.json'));
for (const c of ['actors', 'scenes', 'journal', 'playlists', 'folders', 'users']) {
  const src = path.join(WORLD, 'data', c);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.join(worldCopy, 'data', c), { recursive: true });
  for (const f of fs.readdirSync(src, { withFileTypes: true })) if (f.isFile() && f.name !== 'LOCK') fs.copyFileSync(path.join(src, f.name), path.join(worldCopy, 'data', c, f.name));
}
// Tiny placeholder assets (portraits, one background, a few audio files) so copying is exercised.
const placeholder = (rel) => {
  let p = rel;
  try {
    p = decodeURIComponent(rel);
  } catch {}
  const f = path.join(dataRoot, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
};
for (const a of world.actors) if (a.img && !/^icons\//.test(a.img)) placeholder(a.img);
for (const sc of world.scenes) {
  const bg = (sc.levels || []).find((l) => l?.background?.src)?.background?.src;
  if (bg) placeholder(bg);
  if (sc.thumb) placeholder(sc.thumb);
}
const combatList = world.playlists.find((p) => /combat/i.test(p.name));
const combatSounds = (combatList?.sounds || []).slice(0, 3);
for (const s of combatSounds) placeholder(s.path);

const assetsOut = path.join(tmp, 'assets');
const docsOut = path.join(tmp, 'docs');
process.env.SR_FOUNDRY_ASSET_DIR = assetsOut;
process.env.SR_FOUNDRY_DOCS_DIR = docsOut;
// ---------------------------------------------------------------------------
// 3. i18n: translatable diffs / messages (French unchanged, English from client/i18n/en/foundry.json)
// ---------------------------------------------------------------------------
console.log('i18n');
{
  const en = dictionary('en');
  // Every key (also nested { t } params) must have an English entry.
  const keysOf = (e, out = []) => {
    if (Array.isArray(e)) e.forEach((x) => keysOf(x, out));
    else if (e && typeof e === 'object') {
      if (typeof e.t === 'string') out.push(e.t);
      if (typeof e.key === 'string') out.push(e.key);
      for (const v of Object.values(e.params || {})) keysOf(v, out);
    }
    return out;
  };
  ok(JSON.stringify(pcDiffEntries(null, bundle.pcs[0])) === JSON.stringify([{ t: 'Nouveau personnage' }]), 'new PC diff entry');
  const pc = bundle.pcs.find((p) => (p.sheet.skills || []).length) || bundle.pcs[0];
  const app = { karma: -1, karmaTotal: 0, nuyen: 1, attributes: { BOD: 0 }, skills: [], streetCred: 99 };
  const entries = pcDiffEntries(app, pc);
  const fr = pcDiff(app, pc);
  ok(entries.length >= 3 && entries.length === fr.length, `diff entries (${entries.length}) match French lines (${fr.length})`);
  ok(fr[0] === `Karma -1 → ${pc.sheet.karma ?? 0}` || fr.some((l) => l.startsWith('Karma -1 → ')), `French diff line unchanged (${fr[0]})`);
  ok(fr.some((l) => /^Attributs : .*CON 0 → /.test(l)), `French attribute diff keeps CON (${fr.find((l) => l.startsWith('Attributs'))})`);
  const enLines = entries.map((e) => tr('en', e.t, e.params));
  ok(enLines.some((l) => /^Attributes: .*BOD 0 → /.test(l)), `English attribute diff uses BOD (${enLines.find((l) => l.startsWith('Attrib'))})`);
  ok(enLines.some((l) => l.startsWith('Street Cred 99 → ')), 'English street cred line');
  const missing = [...new Set(keysOf(entries))].filter((k) => !en[k]);
  ok(!missing.length, `diff keys translated (${missing.join(' | ')})`);
  // Errors carrying keys
  const e = i18nError({ t: 'Aucun monde Foundry trouvé dans « {path} » (world.json manquant)', params: { path: 'X' } });
  ok(e.message === 'Aucun monde Foundry trouvé dans « X » (world.json manquant)' && e.i18nKey.startsWith('Aucun monde') && e.i18nParams.path === 'X', 'i18nError: French message + key + params');
  ok(tr('en', e.i18nKey, e.i18nParams) === 'No Foundry world found in “X” (world.json missing)', 'i18nError key translated');
  // Server-side plural: French keeps the old text, English pluralizes 0
  const p0 = plural(0, { t: 'zero::{n} fichier copié' }, { t: '{n} fichier copié' }, { t: '{n} fichiers copiés' });
  ok(tr('fr', p0.t, p0.params) === '0 fichier copié' && tr('en', p0.t, p0.params) === '0 files copied', `plural(0) fr/en (${tr('en', p0.t, p0.params)})`);
  const p2 = plural(2, { t: 'zero::{n} fichier copié' }, { t: '{n} fichier copié' }, { t: '{n} fichiers copiés' });
  ok(tr('fr', p2.t, p2.params) === '2 fichiers copiés' && tr('en', p2.t, p2.params) === '2 files copied', 'plural(2) fr/en');
  const b = bytesParam(12.34e6);
  ok(tr('fr', b.t, b.params) === '12,3 Mo' && tr('en', b.t, b.params) === '12,3 MB', `bytesParam (${tr('en', b.t, b.params)})`);
}

/** Raw action reply (to read errorKey / params, which client.send() hides). */
const rawSend = (c, type, payload = {}) => new Promise((res) => c.socket.emit('action', { type, payload }, res));

const srv = await startServer({ port: 3910 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  await settle();
  const st = () => gm.state;

  // Fresh start = seeds generated from Foundry
  const jane = st().actors.pc_jane;
  ok(jane && jane.nuyen === 98188, `seeded Jane nuyen 98188 (got ${jane?.nuyen})`);
  ok(jane?.foundry?.id === 'M47wzFIaLKTq9Nnb', 'seeded Jane keeps foundry id');
  ok(st().actors.pc_christopher?.retired === true, 'Christopher seeded as retired');
  const fMaps = Object.keys(st().maps).filter((id) => id.startsWith('map_fvtt_'));
  ok(fMaps.length >= 20, `Foundry maps seeded (${fMaps.length})`);
  ok(st().bestiary.tpl_fvtt_perrine_cabana && st().bestiary.tpl_agc_reyes?.foundryId, 'bestiary seeded with Foundry templates');

  // A player sees a Foundry map without crashing the filter
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur', characterId: 'pc_jane' }));
  await gm.send('maps/setActive', { mapId: 'map_fvtt_back-alley' });
  await settle(200);
  ok(p1.state.maps['map_fvtt_back-alley'], 'player receives the active Foundry map');
  ok(!p1.state.maps['map_fvtt_back-alley'].description, 'player map stripped of description');
  ok(p1.state.foundry === undefined, 'players never see the foundry slice');
  await gm.send('maps/setActive', { mapId: 'map_fvtt_bar' });
  await settle(200);
  ok(p1.state.maps.map_fvtt_bar && !(p1.state.maps.map_fvtt_bar.walls || []).some((w) => w.door?.kind === 'secret' && w.door.state !== 'open'), 'player map ok (no closed secret door)');
  let rejected = false;
  try {
    await p1.send('foundry/scan', {});
  } catch {
    rejected = true;
  }
  ok(rejected, 'players cannot scan');

  // worlds + scan
  const w = await gm.send('foundry/worlds', {});
  ok(typeof w.detected === 'string' && Array.isArray(w.worlds), 'foundry/worlds');
  let scan = await gm.send('foundry/scan', { worldPath: worldCopy });
  ok(scan.pcs.length === bundle.pcs.length && scan.npcs.length === bundle.npcs.length && scan.scenes.length === bundle.scenes.length, 'scan lists everything');
  ok(scan.pcs.filter((p) => p.status === 'unchanged').length >= 4, `PCs unchanged vs seeds (${scan.pcs.map((p) => p.status).join(',')})`);
  ok(scan.npcs.find((n) => n.templateId === 'tpl_agc_reyes')?.status === 'unchanged', 'Reyes unchanged vs seeds');
  ok(scan.scenes.every((s) => s.status === 'unchanged'), 'scenes unchanged vs seeds');
  ok(scan.journals.docs.every((d) => d.status === 'new'), 'journals new in temp docs dir');
  ok(scan.playlists.some((p) => p.tracks === combatSounds.length), 'only existing audio files become tracks');
  ok(scan.pcs.every((p) => Array.isArray(p.diffI18n) && p.diffI18n.length === p.diff.length), 'scan PCs carry translatable diffs (diffI18n)');
  ok(scan.skippedScenes.every((x) => x.reason === 'pas d’image de fond'), 'skipped scene reason is a French key');

  const counts = () => ({ actors: Object.keys(st().actors).length, tpl: Object.keys(st().bestiary).length, maps: Object.keys(st().maps).length, tracks: (st().audio?.tracks || []).length });
  const before = counts();

  // Simulate app-side changes: a shop purchase and spent nuyen on Jane.
  const itemId = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'gear', item: { name: 'Achat boutique', qty: 1 } });
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { nuyen: 90000, notes: 'note joueur' } });
  await settle();

  // Import everything (merge)
  const sel = { pcs: 'all', npcs: 'all', scenes: 'all', journals: true, playlists: true };
  const r1 = await gm.send('foundry/import', { worldPath: worldCopy, select: sel, pcMode: 'merge' });
  await settle(250);
  ok(r1.pcs.length === bundle.pcs.length && r1.maps.length === bundle.scenes.length, 'import result counts');
  const after1 = counts();
  ok(after1.actors === before.actors && after1.tpl === before.tpl && after1.maps === before.maps, `no duplicates after import (${JSON.stringify(before)} → ${JSON.stringify(after1)})`);
  ok(after1.tracks === before.tracks && combatSounds.every((x) => st().audio.tracks.some((t) => t.id === `trk_fvtt_${x._id}`)), `audio tracks present, no duplicates (${before.tracks} → ${after1.tracks})`);
  const j1 = st().actors.pc_jane;
  ok(j1.gear.some((g) => g.id === itemId), 'merge keeps app-side purchase');
  ok(j1.nuyen === 90000, `merge keeps app nuyen when Foundry did not change (${j1.nuyen})`);
  ok(j1.notes === 'note joueur', 'notes kept');
  ok(fs.existsSync(path.join(docsOut, '_index.md')) && fs.readdirSync(docsOut).length >= 10, 'journals written');
  ok(fs.existsSync(path.join(assetsOut, 'img', 'jane_pic.png')), 'portrait copied');
  ok(st().log.some((e) => /Import Foundry/.test(e.text)), 'system log entry');
  const logE = [...st().log].reverse().find((e) => e.author === 'Foundry' && e.i18n?.key === 'Import Foundry : {parts} — monde « {world} »');
  ok(logE && logE.text === r1.text, `log entry translatable, French text unchanged (${logE?.text})`);
  ok(/^Import Foundry : \d+ PJ \(fusion\), /.test(r1.text), `French import summary unchanged (${r1.text})`);
  ok(r1.textI18n?.key === logE?.i18n?.key && /^Foundry import: \d+ PC\(s\) \(merge\), /.test(tr('en', r1.textI18n.key, r1.textI18n.params)), `English import summary (${tr('en', r1.textI18n?.key, r1.textI18n?.params)})`);
  ok(typeof r1.assets.bytes === 'number', 'import result has asset bytes');
  ok(st().foundry?.lastImport?.counts?.pcs === bundle.pcs.length, 'lastImport recorded');

  // Re-import is idempotent
  const r2 = await gm.send('foundry/import', { worldPath: worldCopy, select: sel, pcMode: 'merge' });
  await settle(250);
  const after2 = counts();
  ok(JSON.stringify(after2) === JSON.stringify(after1), `re-import idempotent (${JSON.stringify(after2)})`);
  ok(r2.npcs.every((n) => n.status === 'update'), 're-import updates the same templates');
  scan = await gm.send('foundry/scan', { worldPath: worldCopy });
  ok(scan.npcs.every((n) => n.status === 'unchanged') && scan.scenes.every((s) => s.status === 'unchanged'), 'scan after import: all unchanged');
  ok(scan.journals.docs.every((d) => d.status === 'unchanged'), 'journals unchanged after import');

  // Replace: Foundry wins
  await gm.send('foundry/import', { worldPath: worldCopy, select: { pcs: ['M47wzFIaLKTq9Nnb'] }, pcMode: 'replace' });
  await settle(250);
  const j2 = st().actors.pc_jane;
  ok(j2.nuyen === 98188, `replace: Foundry nuyen (${j2.nuyen})`);
  ok(!j2.gear.some((g) => g.id === itemId), 'replace drops app-only items');
  ok(j2.history.some((h) => /Synchronisation Foundry/.test(h.text)), 'history entry for the nuyen change');
  ok(Object.keys(st().actors).length === before.actors, 'still no duplicate actor');

  // Bad world path
  rejected = false;
  try {
    await gm.send('foundry/scan', { worldPath: path.join(tmp, 'nope') });
  } catch (e) {
    rejected = /monde Foundry/i.test(e.message);
  }
  ok(rejected, 'invalid world path → French error');
  const bad = await rawSend(gm, 'foundry/scan', { worldPath: path.join(tmp, 'nope') });
  ok(bad.errorKey === 'Aucun monde Foundry trouvé dans « {path} » (world.json manquant)' && bad.params?.path && bad.error.includes('nope'), `world path error carries its key (${bad.errorKey})`);
  // Upload route errors are translatable too (409 while busy is hard to provoke: check a bad zip instead)
  const tok = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const up = await fetch(srv.url + '/api/foundry/upload?kind=world', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/zip' }, body: Buffer.from('not a zip') });
  const upj = await up.json();
  ok(!up.ok && typeof upj.error === 'string' && upj.error.length > 0, `bad zip upload → readable error (${upj.error})`);
  gm.close();
  p1.close();
} catch (err) {
  failures++;
  console.error(err);
} finally {
  srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
