// Attacks module tests: targeted attack → defense → soak → damage, range modifier, special actions (unlock, Edge, once per turn),
// grenade scatter / blast, player permissions and view filter. Run: node tools/test-attacks.js
import assert from 'node:assert/strict';
import { startServer, login, client, settle } from './test-client.js';
import { launcherRounds } from '../client/modules/sheet/inventory.js';
import { combineEnv, environmentFor, toxinOutcome, TOXIN_BY_ID, stillActive, untilFor, areaEffectOf, pruneExpired } from '../shared/combat.js';
import { collectModifiers, poolModifiers, rollContext, derivedWithModifiers } from '../shared/modifiers.js';
import { rollScatter, blastOf, blastDvAt, blastReach, rangeFor, defenseLines, actionsForWeapon, unlockedActions, finalDamageType } from '../shared/combat.js';

const srv = await startServer({ port: Number(process.env.SR_TEST_PORT) || 3291 });
let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name, '\n     ', err.stack?.split('\n').slice(0, 3).join('\n      '));
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

const COLT = 'fvtt_SjM0aaww96kxVueJ';
const NODACHI = 'fvtt_2cQIIYkKrRxiNUeR';
const FRAG = 'fvtt_ejEwGCVoJcX2A23P';

try {
  console.log('Pure rules (shared/combat.js)');
  await test('range bands: heavy pistol 10 m = medium −1, 70 m beyond', () => {
    const w = { kind: 'ranged', skill: 'pistols', category: 'Pistolets lourds', name: 'Colt' };
    assert.equal(rangeFor(w, null, 10).mod, -1);
    assert.equal(rangeFor(w, null, 3).mod, 0);
    assert.equal(rangeFor(w, null, 70).beyond, true);
    const g = { kind: 'ranged', skill: 'throwing_weapons', name: 'Grenade: Fragmentation' };
    assert.equal(rangeFor(g, { attributes: { STR: 5 } }, 15).id, 'medium'); // STR×2 = 10, ×4 = 20
  });
  await test('scatter: 3 hits = no scatter; otherwise (N D6 − hits) m in a 2D6 direction', () => {
    assert.deepEqual(rollScatter({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, hits: 3, threshold: 3 }).scattered, false);
    let i = 0;
    const seq = [0.99, 0.99, 0.99]; // 2D6 = 12 (back toward the thrower), 1D6 = 6
    const s = rollScatter({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, hits: 1, dice: 1, threshold: 3, rng: () => seq[i++] });
    assert.equal(s.meters, 5);
    assert.ok(s.x < 10, 'lands back toward the attacker');
  });
  await test('blast: frag 18P −1/m, flash-bang 10 m radius, smoke no damage', () => {
    const frag = blastOf({ name: 'Grenade: Fragmentation', damage: '18P', ap: 5 });
    assert.equal(frag.falloff, 1);
    assert.equal(blastDvAt(frag, 4), 14);
    assert.equal(blastReach(frag), 17);
    const fb = blastOf({ name: 'Grenade: Flash-Bang', damage: '10S', ap: -4 });
    assert.equal(fb.radius, 10);
    assert.equal(blastDvAt(fb, 9), 10);
    assert.equal(blastDvAt(fb, 11), 0);
    assert.equal(blastOf({ name: 'Grenade: Smoke', damage: '' }).damaging, false);
    assert.equal(blastOf({ name: 'Molotov', damage: '9P (-3/m)' }).falloff, 3);
  });
  await test('Finishing Move / Agile Defender unlocked by Anthony’s qualities, Flying Kick not', () => {
    const anthony = { qualities: [{ name: 'Défenseur agile', notes: 'Agile Defender · RG 127' }, { name: 'Finishing Move' }], weapons: [] };
    const u = unlockedActions(anthony);
    assert.deepEqual(u.actions.map((a) => a.id), ['finishing-move']);
    assert.deepEqual(u.defenses.map((a) => a.id), ['agile']);
    const melee = actionsForWeapon(anthony, { kind: 'melee' }).map((a) => a.id);
    assert.ok(melee.includes('finishing-move') && !melee.includes('flying-kick') && melee.includes('charge'));
  });
  await test('defense lines: one active defense, full defense paid once per turn, reach, prior defenses', () => {
    const actor = { attributes: { WIL: 3, AGI: 5 }, skills: [{ id: 'gymnastics', rating: 4 }, { id: 'unarmed_combat', rating: 2 }], weapons: [] };
    const r = defenseLines(actor, { kind: 'melee', reach: 1 }, { options: ['dodge', 'block', 'full'], prior: 1, turnBoosts: ['full'] });
    assert.deepEqual(r.lines.map((l) => [l.key, l.value]), [['dodge', 4], ['full', 3], ['reach', -1], ['prior', -1]]);
    assert.equal(r.ini, 5);
    assert.equal(finalDamageType('P', 6, 9), 'S');
    assert.equal(finalDamageType('P', 10, 9), 'P');
  });

  await test('environment: worst column, two at the worst level = one worse, two Heavy = −10', () => {
    assert.equal(combineEnv({ range: 1 }), -1);
    assert.equal(combineEnv({ light: 3 }), -6);
    assert.equal(combineEnv({ light: 2, range: 1 }), -3);
    assert.equal(combineEnv({ light: 2, wind: 2 }), -6);
    assert.equal(combineEnv({ light: 3, visibility: 3 }), -10);
  });
  await test('environment: dark map, low-light / thermographic vision, smoke on the line of fire', () => {
    const map = { width: 20, height: 10, lighting: 'dark', metersPerCell: 1 };
    const base = { map, from: { x: 1, y: 5 }, to: { x: 10, y: 5 }, meters: 9, rangeIndex: 0, litRatio: null };
    assert.equal(environmentFor(base).value, -6, 'total darkness');
    assert.equal(environmentFor({ ...map && base, map: { ...map, lighting: 'dim' }, senses: { lowLight: true } }).value, 0, 'low-light: dim → full');
    assert.equal(environmentFor({ ...base, senses: { thermo: true } }).value, -3, 'thermo: one row up');
    const smoke = [{ effect: 'smoke', x: 5, y: 5, radius: 3 }];
    assert.equal(environmentFor({ ...base, map: { ...map, lighting: 'bright' }, blasts: smoke }).value, -6, 'heavy smoke on the line');
    assert.equal(environmentFor({ ...base, map: { ...map, lighting: 'bright' }, blasts: smoke, senses: { thermo: true } }).value, -3);
    assert.equal(environmentFor({ ...base, map: { ...map, lighting: 'bright' }, blasts: [{ ...smoke[0], effect: 'thermalSmoke' }], senses: { thermo: true } }).value, -6, 'thermal smoke blocks thermo');
    assert.equal(environmentFor({ ...base, blasts: smoke }).value, -10, 'darkness + smoke');
    assert.equal(environmentFor({ ...base, map: { ...map, lighting: 'bright', weather: { wind: 2 } }, senses: { smartlink: true } }).value, -1, 'smartlink: wind one row up');
  });
  await test('toxins: outcome, afflictions on the sheet (−2 dice, wounds ×2), expiry', () => {
    const cs = TOXIN_BY_ID.cs;
    assert.deepEqual(toxinOutcome(cs, 0, 3).afflictions, []);
    const o = toxinOutcome(cs, 5, 3);
    assert.equal(o.damage, 5);
    assert.equal(o.damageType, 'S');
    assert.deepEqual(o.afflictions, ['disoriented', 'nauseous', 'incapacitated']);
    assert.deepEqual(toxinOutcome(cs, 2, 3).afflictions, ['disoriented', 'nauseous']);
    assert.equal(areaEffectOf({ name: 'Grenade: Gas' }), 'gas');
    assert.equal(areaEffectOf({ name: 'Minigrenade: Thermal Smoke' }), 'thermalSmoke');
    assert.equal(areaEffectOf({ name: 'Grenade: Fragmentation' }), 'explosion');
    const a = { attributes: { BOD: 3, AGI: 3, REA: 3, STR: 3, WIL: 3, LOG: 3, INT: 3, CHA: 3, EDG: 2, ESS: 6 }, skills: [{ id: 'pistols', rating: 3 }], condition: { physical: 3, stun: 0 },
      afflictions: [{ id: 'a1', kind: 'disoriented' }, { id: 'a2', kind: 'nauseous' }] };
    const mods = collectModifiers(a, () => null);
    assert.equal(poolModifiers(mods, rollContext(a, { skillId: 'pistols' })).total, -2);
    assert.equal(poolModifiers(mods, rollContext(a, { attr: 'BOD', attr2: 'WIL', test: 'toxinResist' })).total, 0, 'not on resistance tests');
    assert.equal(derivedWithModifiers(a, mods).woundModifier, -2);
    const combat = { active: true, startedAt: 5, round: 2 };
    const u = untilFor(combat, 0, { turns: 3 });
    assert.ok(stillActive(u, { ...combat, round: 4 }, 0) && !stillActive(u, { ...combat, round: 5 }, 0));
    const state = { combat: { ...combat, round: 3 }, attacks: { blasts: [{ id: 'b', until: untilFor(combat, 0, { turns: 1 }) }, { id: 'c', until: untilFor(combat, 0, { long: true }) }] }, actors: {} };
    pruneExpired(state, 0);
    assert.deepEqual(state.attacks.blasts.map((b) => b.id), ['c'], 'explosion gone at the next Combat Turn, cloud stays');
  });

  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Mat', characterId: 'pc_anthony' }));
  await settle();
  const mapId = await gm.send('maps/create', { name: 'Test attaques', width: 40, height: 20 });
  await gm.send('maps/setActive', { mapId });
  await gm.send('maps/update', { mapId, patch: { lighting: 'bright' } }); // daylight: no environmental modifier but the range
  await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_anthony', x: 5, y: 5 } });
  const spawned = await gm.send('bestiary/spawn', { templateId: 'tpl_agc_cleaner', mapId, x: 15, y: 5 });
  const npcId = Array.isArray(spawned) ? spawned[0] : spawned.actorIds?.[0];
  await settle();
  const npcToken = gm.state.maps[mapId].tokens.find((t) => t.actorId === npcId);
  assert.ok(npcToken, 'npc token');
  const distance = Math.round(Math.hypot(npcToken.x - 5, npcToken.y - 5));

  console.log('Targeted attack');
  let atkId = null;
  await test('player attacks the NPC token: range modifier in the pool, attack waits for defense', async () => {
    let r;
    for (let i = 0; i < 12; i++) {
      r = await p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: COLT, skillId: 'pistols', targetTokenId: npcToken.id, label: 'Attaque — Colt Government 2066' });
      await gm.send('weapon/reload', { actorId: 'pc_anthony', weaponId: COLT, free: true });
      if (r.attackId && r.hits > 0) break;
    }
    assert.ok(r.attackId, 'attack created');
    if (distance > 5) assert.match(r.breakdown, /portée moyenne \(\d+ m\) −1/);
    await settle();
    const a = gm.state.attacks.list.find((x) => x.id === r.attackId);
    assert.equal(a.status, 'defense');
    assert.equal(a.targetId, npcId);
    assert.equal(a.dv, 7);
    assert.equal(a.ap, -5);
    atkId = a.id;
  });
  await test('the player cannot defend for the NPC; the player sees the attack', async () => {
    await rejects(p1.send('attack/defend', { attackId: atkId }), /Seul le joueur de la cible/);
    await settle();
    assert.ok(p1.state.attacks.list.some((a) => a.id === atkId));
    assert.equal(p1.state.attacks.turn, undefined);
  });
  await test('GM defends (dodge) then soaks: damage applied to the NPC', async () => {
    const before = gm.state.actors[npcId].condition.physical + gm.state.actors[npcId].condition.stun;
    const d = await gm.send('attack/defend', { attackId: atkId, options: ['dodge'] });
    assert.ok(['missed', 'soak', 'done'].includes(d.attack.status));
    if (d.attack.status === 'soak') {
      assert.equal(d.attack.modifiedDv, 7 + d.attack.net);
      const s = await gm.send('attack/soak', { attackId: atkId });
      assert.equal(s.attack.status, 'done');
      assert.match(s.roll.breakdown, /armure \d+ PA −5|armure 0/);
      await settle();
      const after = gm.state.actors[npcId].condition.physical + gm.state.actors[npcId].condition.stun + gm.state.actors[npcId].condition.overflow;
      assert.equal(after - before, s.attack.damage);
    }
  });

  console.log('Special actions');
  await test('Flying Kick is locked for Anthony (player); the GM may use any action', async () => {
    await rejects(p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: NODACHI, targetTokenId: npcToken.id, actionId: 'flying-kick' }), /débloqué/);
    await rejects(p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: COLT, actionId: 'finishing-move' }), /mêlée/);
  });
  await test('Finishing Move: +2 dice, costs 1 Edge, once per Combat Turn in combat', async () => {
    const edge = gm.state.actors.pc_anthony.edge.current;
    const r = await p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: NODACHI, targetTokenId: npcToken.id, actionId: 'finishing-move' });
    assert.match(r.breakdown, /Prise de finition \+2/);
    await settle();
    assert.equal(gm.state.actors.pc_anthony.edge.current, edge - 1);
    await gm.send('combat/start', {});
    await gm.send('combat/rollAll', {});
    await settle();
    await p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: NODACHI, targetTokenId: npcToken.id, actionId: 'finishing-move' });
    await rejects(p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: NODACHI, targetTokenId: npcToken.id, actionId: 'finishing-move' }), /une seule fois/);
    await settle();
    const entry = gm.state.combat.entries.find((e) => e.actorId === 'pc_anthony');
    assert.ok(entry.adjust <= -10, 'initiative paid');
    await gm.send('combat/end', {});
  });

  console.log('Grenades');
  await test('frag grenade at a point: scatter, blast marker, a soak for each token caught', async () => {
    const r = await p1.send('attack/roll', { actorId: 'pc_anthony', weaponId: FRAG, point: { x: npcToken.x, y: npcToken.y + 1 }, label: 'Attaque — Grenade: Fragmentation' });
    assert.ok(r.blastId, 'blast created');
    await settle();
    const b = gm.state.attacks.blasts.find((x) => x.id === r.blastId);
    assert.equal(b.falloff, 1);
    assert.equal(b.reach, 17);
    for (const h of b.hits) {
      const a = gm.state.attacks.list.find((x) => x.id === h.attackId);
      assert.equal(a.status, 'soak');
      assert.equal(a.kind, 'blast');
      assert.equal(a.dv, h.dv);
    }
    assert.ok(!gm.state.actors.pc_anthony.weapons.some((w) => w.id === FRAG), 'last grenade used');
    assert.ok(p1.state.attacks.blasts.some((x) => x.id === r.blastId), 'player sees the blast');
    await gm.send('attack/clear', { all: true });
    await settle();
    assert.equal(gm.state.attacks.blasts.length, 0);
  });
  await test('gas grenade: a toxin resistance for each token caught, effects on the sheet, the cloud stays', async () => {
    const jane = gm.state.actors.pc_jane;
    const gas = jane.weapons.find((w) => w.name === 'Grenade: Gas');
    await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_jane', x: npcToken.x - 2, y: npcToken.y + 2 } });
    const r = await gm.send('attack/roll', { actorId: 'pc_jane', weaponId: gas.id, skillId: gas.skill, toxinId: 'neurostun8', point: { x: npcToken.x, y: npcToken.y } });
    await settle();
    const b = gm.state.attacks.blasts.find((x) => x.id === r.blastId);
    assert.equal(b.effect, 'gas');
    assert.equal(b.toxinId, 'neurostun8');
    assert.equal(b.dv, null, 'no blast damage: the toxin replaces it');
    assert.ok(b.until, 'expiry set');
    assert.ok(b.hits.length > 0, 'Jane, 3 m away, is in the 10 m cloud');
    for (const h of b.hits) {
      const a = gm.state.attacks.list.find((x) => x.id === h.attackId);
      assert.equal(a.kind, 'toxin');
      assert.equal(a.dv, 15);
      const res = await gm.send('attack/soak', { attackId: a.id });
      assert.equal(res.attack.status, 'done');
      assert.match(res.roll.breakdown, /CON|BOD/);
      await settle();
      const victim = gm.state.actors[a.targetId];
      if (res.attack.left > 0) assert.ok((victim.afflictions || []).some((x) => x.kind === 'disoriented'), 'disoriented');
    }
    // Clean up for the next tests: effects ended, stun healed, cloud gone.
    for (const h of b.hits) {
      for (const x of gm.state.actors[h.actorId].afflictions || []) await gm.send('attack/removeAffliction', { actorId: h.actorId, afflictionId: x.id });
      await gm.send('actor/update', { actorId: h.actorId, patch: { condition: { ...gm.state.actors[h.actorId].condition, stun: 0 } } }).catch(() => {});
    }
    await gm.send('attack/clear', { all: true });
    await settle();
  });
  await test('weather: the environment line replaces the range line in the attack pool', async () => {
    await gm.send('maps/update', { mapId, patch: { weather: { visibility: 3 } } });
    const colt = gm.state.actors.pc_anthony.weapons.find((w) => w.id === COLT);
    await gm.send('weapon/reload', { actorId: 'pc_anthony', weaponId: COLT, free: true }).catch(() => {});
    try {
      const r = await gm.send('attack/roll', { actorId: 'pc_anthony', weaponId: colt.id, skillId: 'pistols', targetTokenId: npcToken.id });
      assert.match(r.breakdown, /env\. \(portée, visibilité\) −6/);
    } finally {
      await gm.send('maps/update', { mapId, patch: { weather: { visibility: 0 } } });
    }
    await settle();
    assert.equal(gm.state.maps[mapId].weather, undefined);
    await gm.send('attack/clear', { all: true });
  });
  await test('grenade launcher without a minigrenade profile: the catalog round chosen gives the blast, a round is used', async () => {
    const alpha = gm.state.actors.pc_anthony.weapons.find((w) => /Alpha Grenade Launcher/.test(w.name));
    const rounds = launcherRounds(gm.state.actors.pc_anthony, alpha);
    assert.ok(rounds.length && rounds.every((r) => !r.sheet), 'catalog rounds offered');
    await rejects(gm.send('attack/roll', { actorId: 'pc_anthony', weaponId: alpha.id, skillId: alpha.skill, point: { x: npcToken.x, y: npcToken.y } }), /minigrenade/);
    const he = rounds.find((r) => /High Explosive/.test(r.w.name));
    const before = gm.state.actors.pc_anthony.weapons.find((w) => w.id === alpha.id).ammoLoaded;
    const r = await gm.send('attack/roll', { actorId: 'pc_anthony', weaponId: alpha.id, skillId: alpha.skill, profileId: he.id, point: { x: npcToken.x, y: npcToken.y } });
    await settle();
    const b = gm.state.attacks.blasts.find((x) => x.id === r.blastId);
    assert.equal(b.dv, 16);
    assert.equal(b.falloff, 2);
    assert.equal(b.reach, 7);
    assert.equal(gm.state.actors.pc_anthony.weapons.find((w) => w.id === alpha.id).ammoLoaded, before - 1);
  });
  await test('launcher rounds: the sheet profiles first, the loaded minigrenade before them; the sheet profile is the default', async () => {
    const chris = gm.state.actors.pc_christopher;
    const mgl = chris.weapons.find((w) => /MGL/.test(w.name));
    const names = launcherRounds(chris, mgl).map((r) => r.w.name);
    assert.deepEqual(names.slice(0, 2), ['Minigrenade: High Explosive', 'Minigrenade: Gas']);
    assert.equal(names.filter((n) => n === 'Minigrenade: High Explosive').length, 1, 'catalog duplicate of a sheet profile dropped');
    const loaded = launcherRounds(chris, { ...mgl, ammoKind: { name: 'Minigrenade: Smoke', catalogId: 'b6381691-1a96-4299-b9df-129ffee64c45' } });
    assert.equal(loaded[0].w.name, 'Minigrenade: Smoke');
    assert.ok(loaded[0].loaded);
    await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_christopher', x: 5, y: 12 } });
    const r = await gm.send('attack/roll', { actorId: 'pc_christopher', weaponId: mgl.id, skillId: mgl.skill, point: { x: npcToken.x, y: npcToken.y } });
    assert.equal(r.blast.dv, 16, 'sheet HE profile used by default');
    await gm.send('attack/clear', { all: true });
    await settle();
  });
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await srv.stop();
}
console.log(failures ? `\n${failures} échec(s)` : '\nOK');
process.exit(failures ? 1 : 0);
