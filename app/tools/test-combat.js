// Combat module tests: bestiary CRUD/spawn + initiative tracker. Run: node tools/test-combat.js
import fs from 'node:fs';
import { startServer, login, client, settle } from './test-client.js';

const srv = await startServer({ port: 3103 });
let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}
async function expectFail(p, msg) {
  try {
    await p;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(true, msg);
    return e.message;
  }
}
const H = (token) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** i18n check: entries render to their stored French text, and every key has an English entry. Returns English texts. */
async function renderI18n(entries, label) {
  const I = await import('../client/lib/i18n.js');
  const dir = new URL('../client/i18n/en/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)));
  const dict = {};
  for (const f of files) Object.assign(dict, JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
  I.setDictionary(dict);
  I.clearMissing();
  const text = (e) => (e.i18n?.key ? I.t(e.i18n.key, e.i18n.params) : e.text);
  ok(entries.length > 0 && entries.every((e) => e.i18n?.key), `${label}: entries carry i18n keys`);
  I.setLang('fr');
  const bad = entries.filter((e) => text(e) !== e.text);
  ok(!bad.length, `${label}: French rendering = stored text (${bad.map((e) => `${text(e)} ≠ ${e.text}`).join(' | ')})`);
  I.setLang('en');
  const en = entries.map(text);
  I.setLang('fr');
  const missing = Object.keys(I.missingKeys());
  ok(!missing.length, `${label}: every key has English (${missing.join(' | ')})`);
  return en;
}

try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm0 = await client(srv.url, gmToken);
  await settle();

  // ---------------------------------------------------------------- seeds
  const best = gm0.state.bestiary || {};
  ok(Object.keys(best).length >= 33, `bestiary seeded (${Object.keys(best).length})`);
  ok(best.tpl_agc_reyes?.initiative?.dice === 2, 'Reyes has 2D6 initiative');
  ok(best.tpl_agc_cleaner?.npc?.grunt === true, 'Cleaner is a grunt');
  ok(gm0.state.combat && gm0.state.combat.active === false, 'combat slice initialised');
  gm0.close();

  // ---------------------------------------------------------------- inject a test map + PC through admin import
  const exported = await (await fetch(srv.url + '/api/admin/export', { headers: H(gmToken) })).json();
  exported.actors.pc_test = {
    id: 'pc_test', type: 'pc', name: 'Testeuse', metatype: 'Humain',
    attributes: { BOD: 4, AGI: 4, REA: 5, STR: 3, WIL: 4, LOG: 4, INT: 5, CHA: 3, EDG: 4, ESS: 6 },
    initiative: { dice: 1, bonus: 0 }, condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 4 },
    skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [], contacts: [], sins: [], history: [],
    karma: 0, karmaTotal: 0, nuyen: 0,
  };
  exported.maps = exported.maps || {};
  exported.maps.map_test = {
    id: 'map_test', name: 'Test', width: 10, height: 6, metersPerCell: 1,
    tiles: ['##########', '#........#', '#..T.....#', '#....#...#', '#....D...#', '##########'],
    doors: [{ id: 'd1', x: 5, y: 4, state: 'closed', kind: 'door' }],
    lights: [], lighting: 'bright', regions: [], notes: [], explored: {}, fog: false, sharedVision: true, movementLocked: false,
    tokens: [{ id: 'tok_pc', actorId: 'pc_test', name: 'Testeuse', x: 1, y: 1, size: 1, disposition: 'pc', hidden: false }],
  };
  exported.scene = { ...(exported.scene || {}), activeMapId: 'map_test' };
  const imp = await fetch(srv.url + '/api/admin/import', { method: 'POST', headers: H(gmToken), body: JSON.stringify(exported) });
  ok(imp.ok, 'admin import of test fixture');

  const gm = await client(srv.url, gmToken);
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur', characterId: 'pc_test' }));
  await settle();
  ok(p1.state.bestiary === undefined, 'players do not receive the bestiary');

  // ---------------------------------------------------------------- bestiary CRUD + permissions
  await expectFail(p1.send('bestiary/create', {}), 'player cannot create a template');
  await expectFail(p1.send('bestiary/spawn', { templateId: 'tpl_agc_cleaner' }), 'player cannot spawn');
  const { templateId: newId } = await gm.send('bestiary/create', { template: { name: 'Testeur PNJ', folder: 'Tests', attributes: { BOD: 'abc', AGI: 99, REA: 4 }, skills: [{ id: 'pistols', rating: 4, attr: 'XXX' }, 'junk'], weapons: 'nope' } });
  await settle();
  let t = gm.state.bestiary[newId];
  ok(t && t.name === 'Testeur PNJ' && t.folder === 'Tests', 'create template');
  ok(t.attributes.BOD === 3 && t.attributes.AGI === 30 && t.attributes.REA === 4, 'attributes sanitized');
  ok(t.skills.length === 1 && t.skills[0].attr === 'AGI' && Array.isArray(t.weapons) && t.weapons.length === 0, 'lists sanitized');
  await gm.send('bestiary/update', { templateId: newId, patch: { name: 'Renommé', npc: { grunt: true } } });
  await settle();
  t = gm.state.bestiary[newId];
  ok(t.name === 'Renommé' && t.npc.grunt === true && t.npc.kind === 'metahuman', 'update merges npc');
  await expectFail(gm.send('bestiary/update', { templateId: 'nope', patch: {} }), 'update unknown template fails');
  const { templateId: dupId } = await gm.send('bestiary/duplicate', { templateId: newId });
  await settle();
  ok(gm.state.bestiary[dupId]?.name === 'Renommé (copie)', 'duplicate');
  const r1 = await gm.send('bestiary/renameFolder', { from: 'Tests', to: 'Essais' });
  ok(r1.count === 2, 'rename folder');
  await gm.send('bestiary/delete', { templateId: dupId });
  await settle();
  ok(!gm.state.bestiary[dupId], 'delete');
  const imported = await gm.send('bestiary/import', { templates: [{ id: newId, name: 'Import 1' }, { name: 'Import 2' }, 42] });
  await settle();
  ok(imported.count === 2 && !imported.ids.includes(newId) && gm.state.bestiary[newId].name === 'Renommé', 'import never overwrites without flag');
  await gm.send('bestiary/import', { templates: [{ id: newId, name: 'Écrasé' }], overwrite: true });
  await settle();
  ok(gm.state.bestiary[newId].name === 'Écrasé', 'import overwrite');
  await gm.send('bestiary/delete', { templateId: 'tpl_ghoul' });
  ok(true, 'seed template deletable');

  // ---------------------------------------------------------------- spawn
  const sp = await gm.send('bestiary/spawn', { templateId: 'tpl_agc_cleaner', x: 0, y: 0, count: 3 });
  await settle();
  const map = gm.state.maps.map_test;
  ok(sp.actorIds.length === 3 && sp.tokenIds.length === 3, 'spawn 3 cleaners');
  const toks = sp.tokenIds.map((id) => map.tokens.find((x) => x.id === id));
  const PASS = new Set(['.', ',', 's', 'e', 'g', 'r', 'x', 't', '_']);
  ok(toks.every((x) => x && PASS.has(map.tiles[x.y][x.x])), 'tokens placed on passable cells');
  const cells = new Set(map.tokens.map((x) => `${x.x},${x.y}`));
  ok(cells.size === map.tokens.length, 'no token overlap');
  ok(toks.every((x) => x.disposition === 'hostile' && x.hidden === false), 'token disposition/hidden');
  const names = sp.actorIds.map((id) => gm.state.actors[id].name).sort();
  ok(names.join('|') === 'Nettoyeur AG Chemie 1|Nettoyeur AG Chemie 2|Nettoyeur AG Chemie 3', 'numbered names: ' + names.join(', '));
  const a1 = gm.state.actors[sp.actorIds[0]];
  ok(a1.type === 'npc' && a1.templateId === 'tpl_agc_cleaner' && a1.condition.physical === 0 && a1.edge.current === 2, 'actor copied from template');
  ok(!a1.folder && !a1.description && a1.gmNotes.includes('Reyes'), 'template description moved to gmNotes');
  const sp2 = await gm.send('bestiary/spawn', { templateId: 'tpl_agc_cleaner', x: 1, y: 1 });
  await settle();
  ok(gm.state.actors[sp2.actorIds[0]].name === 'Nettoyeur AG Chemie 4', 'next spawn continues numbering');
  const t4 = gm.state.maps.map_test.tokens.find((x) => x.id === sp2.tokenIds[0]);
  ok(!(t4.x === 1 && t4.y === 1), 'occupied start cell avoided');
  // Behind a closed door: start in the right room, must not leak through the door.
  const sp3 = await gm.send('bestiary/spawn', { templateId: 'tpl_agc_reyes', x: 7, y: 4, hidden: true });
  await settle();
  const tr = gm.state.maps.map_test.tokens.find((x) => x.id === sp3.tokenIds[0]);
  ok(tr.hidden === true && tr.x >= 6, 'hidden spawn stays in the start room');
  const sp4 = await gm.send('bestiary/spawn', { templateId: 'tpl_hellhound', mapId: null, count: 2 });
  ok(sp4.tokenIds.length === 0 && sp4.actorIds.length === 2, 'spawn without map creates only actors');
  await expectFail(gm.send('bestiary/spawn', { templateId: 'tpl_hellhound', mapId: 'nope' }), 'spawn on unknown map fails');
  const fa = await gm.send('bestiary/fromActor', { actorId: sp.actorIds[0], folder: 'Essais' });
  await settle();
  const ft = gm.state.bestiary[fa.templateId];
  ok(ft && ft.name === 'Nettoyeur AG Chemie' && ft.folder === 'Essais' && !ft.condition && ft.description.includes('Reyes'), 'fromActor');

  // ---------------------------------------------------------------- combat start
  await expectFail(p1.send('combat/start', {}), 'player cannot start combat');
  await gm.send('combat/start', {});
  await settle();
  let c = gm.state.combat;
  ok(c.active && c.mapId === 'map_test', 'combat started on active map');
  ok(c.entries.length === 5, `non-hidden map tokens added (${c.entries.length})`);
  ok(!c.entries.some((e) => e.actorId === sp3.actorIds[0]), 'hidden token not added at start');
  const pcE = c.entries.find((e) => e.actorId === 'pc_test');
  ok(pcE.toRoll === true && c.currentId === null, 'PC waits to roll');
  ok(c.entries.filter((e) => e.kind === 'npc').every((e) => !e.toRoll && e.rolls.length === 1 && e.score === e.base + e.rolls[0]), 'NPCs auto-rolled');
  await expectFail(gm.send('combat/start', {}), 'cannot start twice');

  // KO flag follows damage right away (not only on the next combat action)
  {
    const koE = c.entries.find((e) => e.kind === 'npc');
    await gm.send('actor/damage', { actorId: koE.actorId, amount: 40, type: 'S' });
    await settle();
    ok(gm.state.combat.entries.find((e) => e.id === koE.id).down === true, 'damage sets the KO flag immediately');
    await gm.send('actor/heal', { actorId: koE.actorId, type: 'all' });
    await settle();
    ok(!gm.state.combat.entries.find((e) => e.id === koE.id).down, 'healing clears the KO flag');
  }

  // Player view filtering
  let pc = p1.state.combat;
  ok(pc.entries.length === 5, 'player sees non-hidden entries');
  ok(pc.entries.filter((e) => e.kind === 'npc').every((e) => e.rolls === undefined && typeof e.score === 'number'), 'NPC roll details stripped for players');

  // Permissions
  const npcIds = c.entries.filter((e) => e.kind === 'npc').map((e) => e.id);
  await expectFail(p1.send('combat/roll', { entryId: npcIds[0] }), 'player cannot roll an NPC');
  await expectFail(p1.send('combat/setScore', { entryId: pcE.id, score: 30 }), 'player cannot set score');

  // Deterministic scores: NPCs 15, 8, 3, 2 then PC 25 (setScore on the PC triggers the auto start).
  for (const id of npcIds) await gm.send('combat/setScore', { entryId: id, score: 1 });
  const rolled = await p1.send('combat/roll', { entryId: pcE.id });
  ok(rolled.rolls.length === 1, 'player rolls own initiative');
  await expectFail(p1.send('combat/roll', { entryId: pcE.id }), 'player cannot reroll');
  await gm.send('combat/setScore', { entryId: npcIds[0], score: 15 });
  await gm.send('combat/setScore', { entryId: npcIds[1], score: 8 });
  await gm.send('combat/setScore', { entryId: npcIds[2], score: 3 });
  await gm.send('combat/setScore', { entryId: npcIds[3], score: 2 });
  await gm.send('combat/setScore', { entryId: pcE.id, score: 25 });
  await settle();
  c = gm.state.combat;
  ok(c.entries.map((e) => e.score).join(',') === '25,15,8,3,2', 'sorted by score: ' + c.entries.map((e) => e.score).join(','));
  ok(c.currentId === pcE.id && c.turn === 0, 'PC acts first (auto start)');
  ok(p1.state.combat.currentId === pcE.id, 'player sees it is their turn');

  // Turn flow
  p1.events.length = 0;
  await p1.send('combat/next', { entryId: pcE.id });
  await expectFail(p1.send('combat/next', { entryId: pcE.id }), 'double "end my turn" is rejected');
  await expectFail(p1.send('combat/next', {}), 'player cannot advance an NPC turn');
  await settle();
  c = gm.state.combat;
  ok(c.currentId === npcIds[0] && c.entries.find((e) => e.id === pcE.id).acted, 'next → NPC 15, PC acted');
  await gm.send('combat/next', {}); // → 8
  await gm.send('combat/next', {}); // → 3
  await gm.send('combat/next', {}); // → 2
  await gm.send('combat/next', {}); // → pass 2 : PC 15
  await settle();
  c = gm.state.combat;
  ok(c.pass === 2 && c.currentId === pcE.id, `pass 2 starts with the PC (pass ${c.pass})`);
  ok(c.entries.find((e) => e.id === npcIds[2]).score === -7, 'scores reduced by 10');
  ok(p1.events.some((ev) => ev.ev === 'sfx' && ev.data.id === 'notify'), 'player notified on their turn');

  // Interrupts
  await p1.send('combat/adjust', { entryId: pcE.id, delta: -5, label: 'Esquive' });
  await expectFail(p1.send('combat/adjust', { entryId: pcE.id, delta: 5 }), 'player cannot add initiative');
  await settle();
  ok(gm.state.combat.entries.find((e) => e.id === pcE.id).score === 10, 'adjust −5');

  // Delay / act now
  await p1.send('combat/delay', { entryId: pcE.id });
  await settle();
  c = gm.state.combat;
  ok(c.currentId === npcIds[0] && c.entries.find((e) => e.id === pcE.id).delayed, 'delay passes to the next actor');
  await p1.send('combat/act', { entryId: pcE.id });
  await settle();
  c = gm.state.combat;
  ok(c.currentId === pcE.id && c.entries.find((e) => e.id === pcE.id).score === 5, 'act now: PC interrupts, score lowered to 5');
  await p1.send('combat/next', { entryId: pcE.id }); // → NPC (5) who kept its action
  await settle();
  ok(gm.state.combat.currentId === npcIds[0], 'interrupted NPC still acts');

  // Undo
  await gm.send('combat/prev', {});
  await settle();
  ok(gm.state.combat.currentId === pcE.id, 'prev restores previous turn');
  await gm.send('combat/next', {}); // → NPC 5
  await gm.send('combat/next', {}); // → new combat turn
  await settle();
  c = gm.state.combat;
  ok(c.round === 2 && c.pass === 1 && c.currentId === null, `new combat turn (round ${c.round})`);
  ok(c.entries.find((e) => e.id === pcE.id).toRoll && c.entries.filter((e) => e.kind === 'npc').every((e) => !e.toRoll), 'PCs à lancer, NPCs rerolled');

  // Seize the initiative + Blitz
  await p1.send('combat/seize', { entryId: pcE.id });
  await expectFail(p1.send('combat/seize', { entryId: pcE.id }), 'cannot seize twice');
  await p1.send('combat/roll', { entryId: pcE.id, blitz: true });
  await settle();
  c = gm.state.combat;
  const pcNow = c.entries.find((e) => e.id === pcE.id);
  ok(gm.state.actors.pc_test.edge.current === 2, 'seize + blitz spent 2 Edge');
  ok(pcNow.dice === 5 && pcNow.rolls.length === 5, 'blitz rolls 5D6');
  ok(c.entries[0].id === pcE.id && c.currentId === pcE.id, 'seized entry goes first');

  // Initiative mode (VR chaude)
  await p1.send('combat/setMode', { entryId: pcE.id, mode: 'hot' });
  await expectFail(p1.send('combat/setMode', { entryId: pcE.id, mode: 'warp' }), 'unknown mode rejected');

  // Hidden participant
  await gm.send('combat/add', { tokenIds: [sp3.tokenIds[0]] });
  await settle();
  const hid = gm.state.combat.entries.find((e) => e.actorId === sp3.actorIds[0]);
  ok(hid && hid.hidden && !hid.toRoll, 'hidden NPC added and rolled');
  ok(!p1.state.combat.entries.some((e) => e.id === hid.id), 'hidden entry not visible to players');
  ok(!p1.state.log.some((l) => l.text && l.text.includes('Reyes')), 'hidden roll not in player log');
  await expectFail(gm.send('combat/add', { tokenIds: [sp3.tokenIds[0]] }), 'no duplicate entries');
  await gm.send('combat/reveal', { entryId: hid.id });
  await settle();
  ok(p1.state.combat.entries.some((e) => e.id === hid.id), 'revealed entry visible');
  ok(gm.state.maps.map_test.tokens.find((x) => x.id === sp3.tokenIds[0]).hidden === false, 'reveal also shows the token');

  // Wound modifiers apply to the score (inject damage through admin import)
  const ex2 = await (await fetch(srv.url + '/api/admin/export', { headers: H(gmToken) })).json();
  const woundedEntry = ex2.combat.entries.find((e) => e.id === npcIds[1]);
  const before = woundedEntry.score;
  ex2.actors[woundedEntry.actorId].condition.physical = 6;
  await fetch(srv.url + '/api/admin/import', { method: 'POST', headers: H(gmToken), body: JSON.stringify(ex2) });
  await settle(200);
  await gm.send('combat/adjust', { entryId: npcIds[0], delta: 1 });
  await settle();
  const w = gm.state.combat.entries.find((e) => e.id === npcIds[1]);
  ok(w.score === before - 2 && w.wound === -2, `wound modifier applied (${before} → ${w.score})`);

  // Out / remove / end
  await gm.send('combat/setOut', { entryId: npcIds[3], out: true });
  await gm.send('combat/remove', { entryId: npcIds[2] });
  await settle();
  c = gm.state.combat;
  ok(!c.entries.some((e) => e.id === npcIds[2]) && c.entries.find((e) => e.id === npcIds[3]).out, 'setOut + remove');
  await expectFail(p1.send('combat/end', {}), 'player cannot end combat');
  await gm.send('combat/end', {});
  await settle();
  ok(gm.state.combat.active === false && gm.state.combat.entries.length === 0, 'combat ended');
  ok(gm.state.log.some((l) => l.kind === 'combat' && l.text.includes('Fin du combat')), 'combat log entries');
  const combatEn = await renderI18n(gm.state.log.filter((l) => l.kind === 'combat'), 'combat log');
  ok(combatEn.some((x) => /^Combat over \(\d+ turns?\)\.$/.test(x)), 'English combat log (combat over)');
  ok(combatEn.some((x) => /— initiative \d+ — \d+ \+ \d+D6 \(/.test(x)), 'English roll detail (nested params)');
  await expectFail(gm.send('combat/next', {}), 'next without combat fails');

  // Spawn straight into a running combat
  await gm.send('combat/start', { includeMapTokens: false });
  const sp5 = await gm.send('bestiary/spawn', { templateId: 'tpl_ic_killer', mapId: null, count: 2, addToCombat: true });
  await settle();
  c = gm.state.combat;
  ok(c.entries.length === 2 && c.entries.every((e) => e.mode === 'hot' && e.dice === 4 && e.base === 10), 'IC spawned into combat with VR chaude initiative (10 + 4D6)');
  ok(c.currentId === c.entries[0].id, 'auto start when everyone has rolled');
  ok(sp5.actorIds.length === 2, 'spawn result');

  gm.close();
  p1.close();
} catch (err) {
  failures++;
  console.error(err);
} finally {
  srv.stop();
}
console.log(`${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
