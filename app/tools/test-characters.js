// Tests for server/modules/10-characters.js — run: node tools/test-characters.js
import assert from 'node:assert/strict';
import { startServer, login, client, settle } from './test-client.js';
import { readFileSync as readSeedFile } from 'node:fs';
// Expected values come from the seed (regenerated from Foundry), not hard-coded numbers.
const SEED_JANE = JSON.parse(readSeedFile(new URL('../data/seed/actors/pcs.json', import.meta.url), 'utf8')).find((a) => a.id === 'pc_jane');

const srv = await startServer({ port: Number(process.env.SR_TEST_PORT) || 3270 });
let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name, '\n     ', err.message);
  }
}
const rejects = async (p, re) => {
  try {
    await p;
  } catch (err) {
    if (re) assert.match(err.message, re);
    return err;
  }
  throw new Error('expected rejection');
};

try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  const p2 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  await settle();

  console.log('Seeds & filters');
  await test('seed PCs are loaded with fixed ids', async () => {
    for (const id of ['pc_anthony', 'pc_jane', 'pc_bricks', 'pc_anklay']) assert.ok(gm.state.actors[id], id);
    assert.equal(gm.state.actors.pc_anklay.retired, true);
    assert.equal(gm.state.actors.pc_jane.attributes.MAG, 5);
    assert.equal(gm.state.actors.pc_jane.edge.current, 3);
    assert.ok(gm.state.actors.pc_jane.gmNotes);
  });
  await test('lobby lists active PCs only', async () => {
    const lobby = await (await fetch(srv.url + '/api/lobby')).json();
    assert.deepEqual(lobby.pcs.map((p) => p.id).sort(), ['pc_anthony', 'pc_bricks', 'pc_jane']);
  });
  await test('player sees own notes, not gmNotes; other PCs without notes', async () => {
    const own = p1.state.actors.pc_jane;
    assert.ok(own.notes);
    assert.equal(own.gmNotes, undefined);
    const other = p1.state.actors.pc_bricks;
    assert.ok(other, 'party sheet visible');
    assert.equal(other.notes, undefined);
    assert.equal(other.gmNotes, undefined);
    assert.equal(other.attributes.LOG, 6);
  });

  console.log('Create / update / permissions');
  let npcId, hiddenId;
  await test('GM creates NPCs; player cannot', async () => {
    npcId = await gm.send('actor/create', { type: 'npc', name: 'Nettoyeur AG Chemie 1', templateId: 'tpl_cleaner', attributes: { BOD: 4, WIL: 3 }, npc: { professionalRating: 4, tactics: 'Flanquer', loot: '200¥' }, gmNotes: 'secret' });
    hiddenId = await gm.send('actor/create', { type: 'npc', name: 'Sniper caché', hidden: true });
    assert.ok(npcId.startsWith('npc_'));
    await rejects(p1.send('actor/create', { type: 'npc', name: 'x' }), /MJ/);
    await rejects(gm.send('actor/create', { type: 'npc', name: '  ' }), /nom/);
    await settle();
    const a = gm.state.actors[npcId];
    assert.equal(a.attributes.BOD, 4);
    assert.equal(a.npc.tactics, 'Flanquer');
    assert.deepEqual(a.condition, { physical: 0, stun: 0, overflow: 0 });
  });
  await test('players get a reduced NPC view and no hidden NPCs', async () => {
    const v = p1.state.actors[npcId];
    assert.deepEqual(Object.keys(v).sort(), ['color', 'id', 'metatype', 'name', 'portrait', 'status', 'templateId', 'type']);
    assert.equal(v.status, 'indemne');
    assert.equal(p1.state.actors[hiddenId], undefined);
    assert.ok(gm.state.actors[hiddenId]);
  });
  await test('actor/update merges nested objects (GM)', async () => {
    await gm.send('actor/update', { actorId: npcId, patch: { attributes: { AGI: 5 }, concept: 'Nettoyeur', npc: { grunt: true } } });
    await settle();
    const a = gm.state.actors[npcId];
    assert.equal(a.attributes.AGI, 5);
    assert.equal(a.attributes.BOD, 4);
    assert.equal(a.npc.tactics, 'Flanquer');
    assert.equal(a.npc.grunt, true);
  });
  await test('player updates allowed keys on own actor only', async () => {
    await p1.send('actor/update', { actorId: 'pc_jane', patch: { notes: 'Mes notes', color: '#ff00aa', condition: { stun: 2 } } });
    await rejects(p1.send('actor/update', { actorId: 'pc_jane', patch: { karma: 999 } }), /MJ/);
    await rejects(p1.send('actor/update', { actorId: 'pc_jane', patch: { attributes: { CHA: 12 } } }), /modifier/);
    await rejects(p1.send('actor/update', { actorId: 'pc_bricks', patch: { notes: 'hack' } }), /appartient/);
    await rejects(p1.send('actor/update', { actorId: 'pc_jane', patch: { color: 'red;}' } }), /Couleur/);
    await rejects(p1.send('actor/update', { actorId: 'pc_jane', patch: { portrait: 'javascript:alert(1)' } }), /portrait/);
    await settle();
    const a = gm.state.actors.pc_jane;
    assert.equal(a.notes, 'Mes notes');
    assert.equal(a.condition.stun, 2);
    assert.equal(a.karma, SEED_JANE.karma);
  });
  await test('condition is clamped to the monitors', async () => {
    await p1.send('actor/update', { actorId: 'pc_jane', patch: { condition: { stun: 50, physical: 0 } } });
    await settle();
    assert.equal(gm.state.actors.pc_jane.condition.stun, 10);
    await p1.send('actor/update', { actorId: 'pc_jane', patch: { condition: { stun: 0 } } });
  });

  console.log('Items');
  let itemId;
  await test('GM adds/updates/removes items; essence adjust', async () => {
    itemId = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'augmentations', item: { name: 'Datajack', kind: 'cyberware', essence: 0.1 }, adjustEssence: true });
    await settle();
    assert.equal(gm.state.actors.pc_jane.attributes.ESS, 5.9);
    await gm.send('actor/removeItem', { actorId: 'pc_jane', list: 'augmentations', itemId, adjustEssence: true });
    await settle();
    assert.equal(gm.state.actors.pc_jane.attributes.ESS, 6);
    const sk = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'skills', item: { id: 'navigation', rating: 3 } });
    assert.equal(sk, 'navigation');
    await rejects(gm.send('actor/addItem', { actorId: 'pc_jane', list: 'skills', item: { id: 'navigation', rating: 3 } }), /déjà/);
    await rejects(gm.send('actor/addItem', { actorId: 'pc_jane', list: 'bogus', item: {} }), /inconnue/);
    await settle();
    const s = gm.state.actors.pc_jane.skills.find((x) => x.id === 'navigation');
    assert.equal(s.name, 'Navigation');
    assert.equal(s.attr, 'INT');
  });
  await test('player item permissions', async () => {
    const jane = gm.state.actors.pc_jane;
    const armor = jane.armor[0];
    await p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'armor', itemId: armor.id, patch: { equipped: false } });
    const gear = jane.gear[0];
    // Players may lower a quantity (consumption) but never raise it (it could then be sold to the shop).
    await gm.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: gear.id, patch: { qty: 5 } });
    await p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: gear.id, patch: { qty: 4, notes: 'ok' } });
    await rejects(p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: gear.id, patch: { qty: 9999 } }), /MJ/);
    const w = jane.weapons.find((x) => x.ammoMax > 7);
    await p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { ammoLeft: 7, notes: '3 tirs' } }); // legacy field = ammoLoaded
    await rejects(p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { ammoLoaded: 9 } }), /Recharger/);
    await rejects(p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { damage: '20P' } }), /seulement/);
    await rejects(p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'armor', itemId: armor.id, patch: { rating: 20 } }), /seulement/);
    await rejects(p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'qualities', itemId: jane.qualities[0].id, patch: { karma: 0 } }), /MJ/);
    await rejects(p1.send('actor/addItem', { actorId: 'pc_jane', list: 'gear', item: { name: 'x' } }), /MJ/);
    await rejects(p2.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: gear.id, patch: { qty: 1 } }), /appartient/);
    await settle();
    const j = gm.state.actors.pc_jane;
    assert.equal(j.armor[0].equipped, false);
    assert.equal(j.gear[0].qty, 4);
    assert.equal(j.weapons.find((x) => x.id === w.id).ammoLoaded, 7);
    assert.equal(j.weapons.find((x) => x.id === w.id).ammoLeft, undefined);
  });

  console.log('Damage, healing, Edge');
  await test('stun overflows into physical, physical into overflow, death sfx', async () => {
    // Anthony: physical 11, stun 9 (WIL 1), BOD 5.
    gm.events.length = 0;
    let r = await gm.send('actor/damage', { actorId: 'pc_anthony', amount: 12, type: 'S' });
    assert.deepEqual(r.condition, { physical: 3, stun: 9, overflow: 0 });
    assert.equal(r.status, 'hors de combat');
    r = await gm.send('actor/damage', { actorId: 'pc_anthony', amount: 12, type: 'P' });
    assert.deepEqual(r.condition, { physical: 11, stun: 9, overflow: 4 });
    r = await gm.send('actor/damage', { actorId: 'pc_anthony', amount: 5, type: 'P' });
    assert.equal(r.condition.overflow, 6);
    assert.equal(r.status, 'mort');
    await settle();
    assert.ok(gm.events.some((e) => e.ev === 'sfx' && e.data.id === 'death'));
    assert.ok(gm.state.log.some((e) => e.kind === 'combat' && e.text.includes('Anthony')));
    r = await gm.send('actor/heal', { actorId: 'pc_anthony', amount: 3, type: 'P' });
    assert.deepEqual(r.condition, { physical: 11, stun: 9, overflow: 3 });
    r = await gm.send('actor/heal', { actorId: 'pc_anthony', type: 'all' });
    assert.deepEqual(r.condition, { physical: 0, stun: 0, overflow: 0 });
  });
  await test('health status sets the unconscious / dead token markers', async () => {
    // Anthony: physical 11, BOD 5.
    const mapId = await gm.send('maps/create', { name: 'Markers', width: 8, height: 8, folder: 'Tests' });
    const tokId = await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_anthony', x: 2, y: 2, status: ['à terre'] } });
    const tok = () => gm.state.maps[mapId].tokens.find((t) => t.id === tokId);
    await gm.send('actor/damage', { actorId: 'pc_anthony', amount: 13, type: 'P' }); // full + 2 overflow
    await settle();
    assert.deepEqual(tok().status, ['à terre', 'inconscient']);
    await gm.send('actor/damage', { actorId: 'pc_anthony', amount: 4, type: 'P' }); // overflow 6 > BOD
    await settle();
    assert.deepEqual(tok().status, ['à terre', 'mort']);
    await gm.send('actor/heal', { actorId: 'pc_anthony', type: 'all' });
    await settle();
    assert.deepEqual(tok().status, ['à terre']);
    await gm.send('actor/update', { actorId: 'pc_anthony', patch: { condition: { stun: 99 } } });
    await settle();
    assert.deepEqual(tok().status, ['à terre', 'inconscient'], 'GM editing the boxes');
    await gm.send('actor/heal', { actorId: 'pc_anthony', type: 'all' });
    await gm.send('maps/delete', { mapId });
  });
  await test('damage permissions + NPC status for players', async () => {
    await rejects(p1.send('actor/damage', { actorId: 'pc_bricks', amount: 2, type: 'P' }), /appartient/);
    await rejects(p1.send('actor/damage', { actorId: 'pc_jane', amount: 2, type: 'X' }), /Type/);
    await p1.send('actor/damage', { actorId: 'pc_jane', amount: 2, type: 'P' });
    await gm.send('actor/damage', { actorId: npcId, amount: 6, type: 'P' }); // BOD 4 → monitor 10
    await settle();
    assert.equal(p1.state.actors[npcId].status, 'grièvement blessé');
    await gm.send('actor/heal', { actorId: 'pc_jane', type: 'all' });
  });
  await test('edge spend / refresh', async () => {
    assert.equal(await p1.send('edge/spend', { actorId: 'pc_jane' }), 2);
    await rejects(p2.send('edge/spend', { actorId: 'pc_jane' }), /appartient/);
    assert.equal(await p1.send('edge/refresh', { actorId: 'pc_jane' }), 3);
    await rejects(p1.send('edge/refresh', { actorId: 'all' }), /MJ/);
    await gm.send('edge/spend', { actorId: 'pc_bricks' });
    assert.equal(await gm.send('edge/refresh', { actorId: 'all' }), 3);
    await settle();
    assert.equal(gm.state.actors.pc_bricks.edge.current, 5);
  });

  console.log('Karma & nuyen');
  await test('actor/adjust rewards several PCs and writes history', async () => {
    gm.events.length = 0;
    await gm.send('actor/adjust', { actorIds: ['pc_jane', 'pc_bricks'], karma: 5, nuyen: 3000, reason: 'Fin de séance 3' });
    await settle();
    const j = gm.state.actors.pc_jane;
    assert.equal(j.karma, SEED_JANE.karma + 5);
    assert.equal(j.karmaTotal, SEED_JANE.karmaTotal + 5);
    assert.equal(j.nuyen, SEED_JANE.nuyen + 3000);
    assert.deepEqual(j.history.at(-1).karma, 5);
    assert.ok(gm.events.some((e) => e.ev === 'sfx' && e.data.id === 'level-up'));
    assert.ok(p1.state.log.some((e) => e.kind === 'system' && e.text.includes('Fin de séance 3')));
    await rejects(gm.send('actor/adjust', { actorId: 'pc_bricks', nuyen: -1e7, reason: 'x' }), /assez/);
    await rejects(p1.send('actor/adjust', { actorId: 'pc_jane', karma: 50 }), /MJ/);
  });

  console.log('Dice');
  await test('plain pool roll', async () => {
    const r = await p1.send('dice/roll', { pool: 12, label: 'Test' });
    assert.equal(r.dice.length, 12);
    assert.equal(r.label, 'Test');
    assert.ok(r.hits >= 0 && r.hits <= 12);
    await settle();
    const e = p1.state.log.find((x) => x.id === r.logId);
    assert.equal(e.kind, 'roll');
    assert.equal(e.roll.pool, 12);
  });
  await test('skill roll computes pool and default limit', async () => {
    // Jane etiquette 6 + CHA 8 = 14, social limit 9
    const r = await p1.send('dice/roll', { actorId: 'pc_jane', skillId: 'etiquette' });
    assert.equal(r.pool, 14);
    assert.equal(r.limit, 9);
    assert.equal(r.label, 'Étiquette');
    // longarms + spec + wounds (2 physical boxes → no modifier) + modifier
    const r2 = await p1.send('dice/roll', { actorId: 'pc_jane', skillId: 'longarms', useSpec: true, modifier: -2, limit: 4 });
    assert.equal(r2.pool, 6 + 6 + 2 - 2);
    assert.equal(r2.limit, 4);
    // attribute pair
    const r3 = await p1.send('dice/roll', { actorId: 'pc_jane', attr: 'REA', attr2: 'INT' });
    assert.equal(r3.pool, 12);
    assert.equal(r3.limit, null);
    // defaulting forbidden
    await rejects(p1.send('dice/roll', { actorId: 'pc_jane', skillId: 'spellcasting' }), /formation/);
    // knowledge skill
    const kno = gm.state.actors.pc_jane.knowledge.find((k) => k.type === 'academic');
    const r4 = await p1.send('dice/roll', { actorId: 'pc_jane', skillId: kno.id });
    assert.equal(r4.pool, kno.rating + 4);
  });
  await test('wound modifiers', async () => {
    await gm.send('actor/damage', { actorId: 'pc_bricks', amount: 6, type: 'S' });
    const r = await p2.send('dice/roll', { actorId: 'pc_bricks', skillId: 'hacking', applyWounds: true, limit: null });
    assert.equal(r.pool, 6 + 6 - 2);
    assert.ok(r.limit > 0, 'a player cannot remove the computed limit (limit: null)');
    await gm.send('actor/heal', { actorId: 'pc_bricks', type: 'all' });
  });
  await test('Push the Limit: adds Edge, explodes, no limit, spends Edge', async () => {
    const r = await p1.send('dice/roll', { actorId: 'pc_jane', skillId: 'con', explode: true, limit: 3 });
    assert.equal(r.pool, 6 + 8 + 3);
    assert.equal(r.limit, null);
    assert.equal(r.explode, true);
    await settle();
    assert.equal(gm.state.actors.pc_jane.edge.current, 2);
    await p1.send('edge/spend', { actorId: 'pc_jane' });
    await p1.send('edge/spend', { actorId: 'pc_jane' });
    await rejects(p1.send('dice/roll', { actorId: 'pc_jane', skillId: 'con', explode: true }), /Chance/);
    await p1.send('edge/refresh', { actorId: 'pc_jane' });
  });
  await test('roll permissions and secret rolls', async () => {
    await rejects(p1.send('dice/roll', { actorId: 'pc_bricks', skillId: 'hacking' }), /ton personnage/);
    await rejects(p1.send('dice/roll', { pool: 5, secret: true }), /MJ/);
    await rejects(p1.send('dice/roll', { pool: 0 }), /nulle/);
    const r = await gm.send('dice/roll', { actorId: npcId, attr: 'AGI', secret: true, label: 'Furtivité secrète' });
    await settle();
    assert.ok(gm.state.log.find((e) => e.id === r.logId));
    assert.equal(p1.state.log.find((e) => e.id === r.logId), undefined);
  });
  await test('second chance rerolls misses and spends Edge', async () => {
    const r = await p2.send('dice/roll', { actorId: 'pc_bricks', skillId: 'computer' });
    const sc = await p2.send('dice/secondChance', { logId: r.logId });
    assert.equal(sc.dice.length, r.dice.length);
    assert.ok(sc.rawHits >= r.rawHits);
    assert.deepEqual(sc.secondChance.before, r.dice);
    await rejects(p2.send('dice/secondChance', { logId: r.logId }), /déjà/);
    await rejects(p1.send('dice/secondChance', { logId: r.logId }), /appartient/);
    await settle();
    assert.equal(gm.state.actors.pc_bricks.edge.current, 4);
  });

  console.log('Lifestyles, nested items (accessories, mods, options, techniques), martial arts');
  await test('legacy single lifestyle is migrated to lifestyles[] (seed / old state)', async () => {
    const { normalizeActor } = await import('../client/modules/sheet/sheet-data.ts');
    const a = normalizeActor({ name: 'Old', lifestyle: { name: 'Planque (Moyen)', monthlyCost: 5500, monthsPaid: 2, chummerGuid: 'g1' } }, (p) => `${p}_x`);
    assert.equal(a.lifestyle, undefined);
    assert.equal(a.lifestyles.length, 1);
    assert.deepEqual({ ...a.lifestyles[0], id: undefined }, { id: undefined, name: 'Planque (Moyen)', base: 'Medium', baseCost: 5000, monthsPaid: 2, primary: true, qualities: [], monthlyCost: 5000, notes: 'Ancien loyer : 5500 ¥', chummerGuid: 'g1' });
    for (const pc of Object.values(gm.state.actors).filter((x) => x.type === 'pc')) assert.ok(Array.isArray(pc.lifestyles) && pc.lifestyle === undefined, pc.name);
  });
  let lsId;
  await test('GM adds a lifestyle and options: monthly cost derived, single primary', async () => {
    const before = (gm.state.actors.pc_bricks.lifestyles || []).length;
    lsId = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'lifestyles', item: { name: 'Planque de Tacoma', base: 'Low', baseCost: 2000, monthsPaid: 1, primary: true, monthlyCost: 999999 } });
    const q1 = await gm.send('actor/addSubItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, sub: 'qualities', item: { name: 'Extra Secure', category: 'Positive', multiplier: 20, baseOnly: true, cost: 0, lp: 1 } });
    await gm.send('actor/addSubItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, sub: 'qualities', item: { name: 'Garage (Car (Body 5 or More))', category: 'Entertainment - Asset', cost: 100, lp: 2 } });
    await settle();
    let ls = gm.state.actors.pc_bricks.lifestyles;
    assert.equal(ls.length, before + 1);
    const mine = ls.find((l) => l.id === lsId);
    assert.equal(mine.monthlyCost, 2000 * 1.2 + 100, 'client monthlyCost ignored, derived instead (Extra Secure: % of the base only)');
    assert.equal(mine.qualities.find((q) => q.id === q1).baseOnly, true, 'baseOnly kept by the GM editor');
    assert.equal(ls.filter((l) => l.primary).length, 1);
    assert.ok(mine.primary);
    await gm.send('actor/updateSubItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, sub: 'qualities', subId: q1, patch: { multiplier: 10, notes: 'négocié' } });
    await settle();
    assert.equal(gm.state.actors.pc_bricks.lifestyles.find((l) => l.id === lsId).monthlyCost, 2000 * 1.1 + 100);
    await gm.send('actor/updateSubItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, sub: 'qualities', subId: q1, patch: { baseOnly: false } });
    await settle();
    assert.equal(gm.state.actors.pc_bricks.lifestyles.find((l) => l.id === lsId).monthlyCost, (2000 + 100) * 1.1, 'plain % applies to base + options');
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, patch: { baseCost: 3000 } }); // ignored: the base cost is fixed by the level
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, patch: { base: 'Medium' } });
    await gm.send('actor/removeSubItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, sub: 'qualities', subId: q1 });
    await settle();
    ls = gm.state.actors.pc_bricks.lifestyles;
    assert.equal(ls.find((l) => l.id === lsId).monthlyCost, 5100, 'Medium 5000 (fixed) + Garage 100');
    assert.equal(ls.find((l) => l.id === lsId).baseCost, 5000);
    if (ls.length > 1) {
      const other = ls.find((l) => l.id !== lsId);
      await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: other.id, patch: { primary: true } });
      await settle();
      assert.deepEqual(gm.state.actors.pc_bricks.lifestyles.filter((l) => l.primary).map((l) => l.id), [other.id], 'primary moved');
    }
    // Players see their lifestyles but cannot touch them.
    assert.ok(p2.state.actors.pc_bricks.lifestyles.some((l) => l.id === lsId));
    await rejects(p2.send('actor/addSubItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, sub: 'qualities', item: { name: 'X' } }));
    await rejects(p2.send('actor/updateItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId, patch: { monthsPaid: 12 } }), /MJ|modifier/);
    await gm.send('actor/removeItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: lsId });
    await settle();
    assert.equal(gm.state.actors.pc_bricks.lifestyles.length, before);
    if (before) assert.equal(gm.state.actors.pc_bricks.lifestyles.filter((l) => l.primary).length, 1);
  });
  await test('weapon accessories, armor mods, vehicle mods: nested CRUD (GM only) with validation', async () => {
    const w = gm.state.actors.pc_jane.weapons.find((x) => x.kind === 'ranged');
    const accId = await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', item: { name: 'Laser Sight', mount: 'Top', cost: '125', avail: '2', effects: { accuracy: 1, junk: 'x' } } });
    await settle();
    let acc = gm.state.actors.pc_jane.weapons.find((x) => x.id === w.id).accessories.find((x) => x.id === accId);
    assert.deepEqual({ name: acc.name, mount: acc.mount, cost: acc.cost, effects: acc.effects }, { name: 'Laser Sight', mount: 'Top', cost: 125, effects: { accuracy: 1 } });
    await gm.send('actor/updateSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', subId: accId, patch: { mount: 'Nowhere', effects: { rc: 2 } } });
    await settle();
    acc = gm.state.actors.pc_jane.weapons.find((x) => x.id === w.id).accessories.find((x) => x.id === accId);
    assert.equal(acc.mount, '');
    assert.deepEqual(acc.effects, { rc: 2 });
    assert.ok(p1.state.actors.pc_jane.weapons.find((x) => x.id === w.id).accessories.some((x) => x.id === accId), 'owner sees it');
    await rejects(p1.send('actor/removeSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', subId: accId }));
    await rejects(p1.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { accessories: [] } }), /modifier/);
    await rejects(gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'qualities', item: { name: 'x' } }), /Sous-liste inconnue/);
    await rejects(gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'gear', itemId: w.id, sub: 'mods', item: { name: 'x' } }), /Sous-liste inconnue/);
    await rejects(gm.send('actor/updateSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', subId: 'nope', patch: {} }), /introuvable/);
    await gm.send('actor/removeSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', subId: accId });
    await settle();
    assert.ok(!gm.state.actors.pc_jane.weapons.find((x) => x.id === w.id).accessories.some((x) => x.id === accId));
    const ar = gm.state.actors.pc_jane.armor[0];
    const modId = await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'armor', itemId: ar.id, sub: 'mods', item: { name: 'Gel Packs', capacity: 0, cost: 1500, effects: { armor: 2 } } });
    await settle();
    assert.deepEqual(gm.state.actors.pc_jane.armor[0].mods.find((m) => m.id === modId).effects, { armor: 2 });
    await gm.send('actor/removeSubItem', { actorId: 'pc_jane', list: 'armor', itemId: ar.id, sub: 'mods', subId: modId });
    const vid = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'vehicles', item: { name: 'Moto', mods: [{ name: 'Run-Flat Tires', slots: 0, rating: 1, category: 'All', cost: 250 }] } });
    await settle();
    const v = gm.state.actors.pc_jane.vehicles.find((x) => x.id === vid);
    assert.ok(v.mods[0].id && v.mods[0].name === 'Run-Flat Tires' && v.mods[0].rating === 1, 'mods sanitized and given ids by addItem');
    await gm.send('actor/removeItem', { actorId: 'pc_jane', list: 'vehicles', itemId: vid });
  });
  await test('martial arts and techniques', async () => {
    const id = await gm.send('actor/addItem', { actorId: 'pc_anthony', list: 'martialArts', item: { name: 'Kenjutsu', catalogId: 'abc', rating: 0 } });
    const tq = await gm.send('actor/addSubItem', { actorId: 'pc_anthony', list: 'martialArts', itemId: id, sub: 'techniques', item: { name: 'Riposte', nameFr: 'Riposte' } });
    await settle();
    const ma = gm.state.actors.pc_anthony.martialArts.find((m) => m.id === id);
    assert.equal(ma.rating, 1);
    assert.deepEqual(ma.techniques.map((x) => [x.id, x.name]), [[tq, 'Riposte']]);
    await gm.send('actor/removeItem', { actorId: 'pc_anthony', list: 'martialArts', itemId: id });
  });

  console.log('Duplicate / delete / import');
  await test('duplicate + delete (also removes user assignment)', async () => {
    const copy = await gm.send('actor/duplicate', { actorId: npcId });
    await settle();
    assert.equal(gm.state.actors[copy].name, 'Nettoyeur AG Chemie 1 (copie)');
    const n = await gm.send('actor/delete', { actorIds: [copy, hiddenId] });
    assert.equal(n, 2);
    const pcCopy = await gm.send('actor/duplicate', { actorId: 'pc_jane', name: 'Jane B' });
    const users = Object.values(gm.state.users);
    const bap = users.find((u) => u.name === 'Baptiste');
    await gm.send('users/assign', { userId: bap.id, characterId: pcCopy, assign: true });
    await settle();
    assert.ok(gm.state.users[bap.id].characterIds.includes(pcCopy));
    await gm.send('actor/delete', { actorId: pcCopy });
    await settle();
    assert.ok(!gm.state.users[bap.id].characterIds.includes(pcCopy));
    assert.equal(gm.state.actors[pcCopy], undefined);
    await rejects(p1.send('actor/delete', { actorId: npcId }), /MJ/);
  });
  await test('import .chum5 (XML) and Actor JSON over HTTP', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<character>
  <name>Kim Tanaka</name><alias>Ghost</alias><metatype>Elf</metatype><sex>Female</sex><age>28</age><playername>Test</playername>
  <karma>7</karma><nuyen>1234.5</nuyen><streetcred>1</streetcred><notoriety>0</notoriety><magenabled>False</magenabled><resenabled>False</resenabled>
  <attributes>
    <attribute><name>BOD</name><metatypemin>1</metatypemin><base>2</base><karma>0</karma></attribute>
    <attribute><name>AGI</name><metatypemin>2</metatypemin><base>3</base><karma>1</karma></attribute>
    <attribute><name>REA</name><metatypemin>1</metatypemin><base>3</base><karma>0</karma></attribute>
    <attribute><name>STR</name><metatypemin>1</metatypemin><base>1</base><karma>0</karma></attribute>
    <attribute><name>WIL</name><metatypemin>1</metatypemin><base>2</base><karma>0</karma></attribute>
    <attribute><name>LOG</name><metatypemin>1</metatypemin><base>3</base><karma>0</karma></attribute>
    <attribute><name>INT</name><metatypemin>1</metatypemin><base>4</base><karma>0</karma></attribute>
    <attribute><name>CHA</name><metatypemin>3</metatypemin><base>2</base><karma>0</karma></attribute>
    <attribute><name>EDG</name><metatypemin>1</metatypemin><base>2</base><karma>0</karma></attribute>
    <attribute><name>MAG</name><metatypemin>0</metatypemin><base>0</base><karma>0</karma></attribute>
  </attributes>
  <newskills>
    <groups><group><name>Firearms</name><base>0</base><karma>0</karma></group></groups>
    <skills>
      <skill><name>Pistols</name><base>5</base><karma>0</karma><specs><spec><name>Semi-Automatics</name></spec></specs></skill>
      <skill><name>Sneaking</name><base>4</base><karma>1</karma></skill>
      <skill><name>Electronic Warfare</name><base>2</base><karma>0</karma></skill>
    </skills>
    <knoskills><skill><name>English</name><type>Language</type><isnativelanguage>True</isnativelanguage></skill><skill><name>Gangs</name><type>Street</type><base>3</base><karma>0</karma></skill></knoskills>
  </newskills>
  <qualities><quality><name>Ambidextrous</name><bp>4</bp><qualitytype>Positive</qualitytype></quality><quality><name>SINner (National)</name><bp>5</bp><qualitytype>Negative</qualitytype></quality></qualities>
  <weapons><weapon><name>Ares Predator V</name><category>Heavy Pistols</category><type>Ranged</type><accuracy>5</accuracy><damage>8P</damage><ap>-1</ap><mode>SA</mode><rc>0</rc><ammo>15(c)</ammo><reach>0</reach></weapon>
    <weapon><name>Combat Knife</name><category>Blades</category><type>Melee</type><accuracy>6</accuracy><damage>({STR}+2)P</damage><ap>-3</ap><mode>0</mode><rc>0</rc><ammo>0</ammo><reach>0</reach></weapon></weapons>
  <armors><armor><name>Armor Jacket</name><armor>12</armor><equipped>True</equipped></armor><armor><name>Helmet</name><armor>+2</armor><equipped>False</equipped></armor></armors>
  <cyberwares><cyberware><name>Cybereyes Basic System</name><category>Eyeware</category><ess>(Rating * 0.1) + 0.1</ess><rating>2</rating><grade>Standard</grade><improvementsource>Cyberware</improvementsource>
     <children><cyberware><name>Smartlink</name><ess>0</ess><rating>0</rating><grade>Standard</grade><improvementsource>Cyberware</improvementsource></cyberware></children></cyberware></cyberwares>
  <gears><gear><name>Hermes Ikon</name><category>Commlinks</category><devicerating>5</devicerating><dataprocessing>5</dataprocessing><firewall>5</firewall><qty>1</qty></gear>
    <gear><name>Medkit</name><category>Biotech</category><rating>3</rating><qty>1</qty></gear>
    <gear><name>Fake SIN</name><category>ID/Credsticks</category><rating>4</rating><qty>1</qty><extra>John Doe</extra></gear></gears>
  <contacts><contact><name>Fixer Bob</name><role>Fixer</role><connection>4</connection><loyalty>2</loyalty></contact></contacts>
</character>`;
    const res = await fetch(srv.url + '/api/actors/import-chum5', { method: 'POST', headers: { Authorization: `Bearer ${gmToken}`, 'Content-Type': 'text/plain' }, body: xml });
    const j = await res.json();
    assert.equal(res.status, 200, j.error);
    await settle();
    const a = gm.state.actors[j.actorId];
    assert.equal(a.name, 'Ghost');
    assert.equal(a.metatype, 'Elfe');
    assert.equal(a.attributes.AGI, 6);
    assert.equal(a.attributes.CHA, 5);
    assert.equal(a.attributes.MAG, undefined);
    assert.equal(a.attributes.ESS, 5.7);
    assert.equal(a.skills.find((s) => s.id === 'pistols').rating, 5);
    assert.equal(a.skills.find((s) => s.id === 'pistols').spec, 'Semi-Automatics');
    assert.equal(a.skills.find((s) => s.id === 'sneaking').rating, 5);
    assert.ok(a.skills.find((s) => s.id === 'electronic_warfare'));
    assert.equal(a.knowledge.length, 2);
    assert.equal(a.qualities.find((q) => q.name.startsWith('SINner')).karma, -5);
    assert.equal(a.weapons.length, 2);
    assert.equal(a.weapons[1].skill, 'blades');
    assert.equal(a.weapons[1].damage, '(STR+2)P');
    assert.equal(a.armor[1].stack, true);
    assert.equal(a.matrix.device, 'Hermes Ikon');
    assert.equal(a.sins[0].name, 'John Doe');
    assert.equal(a.contacts[0].connection, 4);
    assert.equal(a.nuyen, 1235);
    // JSON export / import round trip
    const exp = await (await fetch(srv.url + '/api/actors/pc_bricks/export', { headers: { Authorization: `Bearer ${gmToken}` } })).json();
    const res2 = await fetch(srv.url + '/api/actors/import-chum5', { method: 'POST', headers: { Authorization: `Bearer ${gmToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(exp) });
    const j2 = await res2.json();
    assert.equal(res2.status, 200, j2.error);
    assert.notEqual(j2.actorId, 'pc_bricks');
    await settle();
    assert.equal(gm.state.actors[j2.actorId].name, 'Bricks');
    // garbage + permissions
    const bad = await fetch(srv.url + '/api/actors/import-chum5', { method: 'POST', headers: { Authorization: `Bearer ${gmToken}`, 'Content-Type': 'text/plain' }, body: 'hello' });
    assert.equal(bad.status, 400);
    const noAuth = await fetch(srv.url + '/api/actors/import-chum5', { method: 'POST', body: xml });
    assert.equal(noAuth.status, 403);
  });

  gm.close();
  p1.close();
  p2.close();
} finally {
  srv.stop();
}
if (failures) {
  console.log(`\n${failures} test(s) en échec`);
  process.exit(1);
}
console.log('\nOK — tous les tests passent');
