// Inventory realism: node tools/test-inventory.ts  (ports 3443-3445 or SR_TEST_PORT…+2; exit code ≠ 0 on failure)
// 1) Pure rules (client/modules/sheet/inventory.js): ammo parsing, fire modes, ammo / clip compatibility, reload plans, migration.
// 2) Server (10-characters.js): firing consumption per mode, refusal + GM override, reload from ammo gear (qty decrement), clip swap,
//    ammunition change, grenades, equip / locations / containers permissions, active-off in a bag, names backfill, migration idempotence.
// 3) Foundry inventories on a copy of the GM's world (Jane's Duffel Bag / Backpack / House, Bricks' Go Bag), merge adoption.
// 4) Chummer locations: parse (<weaponlocations>) and export (new location node + item <location> guid).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import {
  parseAmmo, fireOptions, roundsFor, weaponModes, ammoInfo, ammoFits, clipFits, reloadPlan, guessContainerKind, normalizeInventory, readyCount, isGrenade,
  weaponAmmoClass, restrictionFits, usesAmmo, isLauncherProfile,
} from '../client/modules/sheet/inventory.ts';
import type { RawData, WeaponLike } from '../client/modules/sheet/inventory.ts';
import { attr } from '../shared/sr5.ts';
import { normalizeActor } from '../client/modules/sheet/sheet-data.ts';
import type { Actor } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = Number(process.env.SR_TEST_PORT) || 3443;
let failures = 0;
async function test(name: string, fn: () => unknown) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name, '\n     ', (err as Error).message);
  }
}
const rejects = async (p: Promise<unknown>, re?: RegExp, _msg?: string) => {
  try {
    await p;
  } catch (err) {
    if (re) assert.match((err as Error).message, re);
    return err;
  }
  throw new Error('expected rejection');
};
let n = 0;
const mkId = (p: string) => `${p}_${++n}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
console.log('Pure rules');
await test('parseAmmo: capacity + reload type', () => {
  assert.deepEqual(parseAmmo('15(c)'), { max: 15, type: 'c' });
  assert.deepEqual(parseAmmo('42(c) or 21(c)'), { max: 42, type: 'c' });
  assert.deepEqual(parseAmmo('6(cy)'), { max: 6, type: 'cy' });
  assert.deepEqual(parseAmmo('2(b)'), { max: 2, type: 'b' });
  assert.deepEqual(parseAmmo('50(belt)'), { max: 50, type: 'belt' });
  assert.deepEqual(parseAmmo('100(d)'), { max: 100, type: 'd' });
  assert.deepEqual(parseAmmo('8(m)'), { max: 8, type: 'm' });
  assert.deepEqual(parseAmmo('1(ml)'), { max: 1, type: 'ml' });
  assert.deepEqual(parseAmmo('14'), { max: 14, type: '' });
  assert.deepEqual(parseAmmo('30(ceinture)'), { max: 30, type: 'belt' });
  assert.deepEqual(parseAmmo(''), { max: 0, type: '' });
  assert.deepEqual(parseAmmo('Energy'), { max: 0, type: '' });
});
await test('fire modes: Chummer and Foundry codes, SR5 rounds', () => {
  assert.deepEqual(weaponModes({ mode: 'SA/TR/TA' }), ['SA', 'BF', 'FA']);
  assert.deepEqual(weaponModes({ mode: 'SA/BF/FA' }), ['SA', 'BF', 'FA']);
  assert.deepEqual(weaponModes({ mode: 'CC' }), ['SS']);
  assert.deepEqual(fireOptions({ mode: 'SA/BF' }).map((o) => [o.id, o.rounds]), [['SA', 1], ['SB', 3], ['BF', 3], ['LB', 6]]);
  assert.deepEqual(fireOptions({ mode: 'FA' }).map((o) => [o.id, o.rounds]), [['FA', 6], ['FAC', 10], ['SUP', 20]]);
  assert.deepEqual(fireOptions({ mode: '' }).map((o) => o.id), ['SS'], 'no mode: single shot');
  assert.equal(roundsFor({ mode: 'SA/TR/TA' }, 'LB'), 6);
  assert.equal(roundsFor({ mode: 'SA/TR/TA' }, 'nope'), 1, 'unknown option → first mode');
});
await test('ammunition compatibility (Foundry names in notes, Chummer extra / ammoforweapontype)', () => {
  const sniper: WeaponLike = { name: 'Ares Desert Strike', category: 'Fusils de précision', categoryEn: 'Sniper Rifles', kind: 'ranged', ammo: '14' };
  const shotgun: WeaponLike = { name: 'Enfield AS-7', category: 'Fusils à pompe', categoryEn: 'Shotguns', kind: 'ranged', ammo: '10(c)' };
  const taser: WeaponLike = { name: 'Defiance EX Shocker', category: 'Pistolets à impulsion électrique', categoryEn: 'Tasers', kind: 'ranged', ammo: '4(m)' };
  const bow: WeaponLike = { name: 'Arc (Indice 10)', category: 'Arcs', kind: 'ranged', ammo: '1' };
  const apds = { name: 'Mun. : Balles ADPS', nameEn: 'Ammo: APDS', notes: 'Ammo: APDS (Sniper Rifles)', category: 'Munitions', qty: 23 };
  const darts = { name: 'Mun. : Dards taser', notes: 'Ammo: Taser Dart (Tasers)', qty: 68 };
  const arrows = { name: 'Mun. : Flèches standard', notes: 'Arrow: Standard (Bows)', qty: 100 };
  const chummer = { name: 'Mun. : Balles ADPS', choice: 'Shotguns', ammoFor: 'gun', qty: 30 };
  const generic = { name: 'Mun. : Balles normales', nameEn: 'Ammo: Regular Ammo', qty: 50 };
  const knife = { name: 'Couteau de lancer', notes: 'Throwing Knife', category: 'Munitions', qty: 10 };
  assert.equal(weaponAmmoClass(taser), 'taser');
  assert.equal(weaponAmmoClass(bow), 'bow');
  assert.ok(ammoFits(apds, sniper) && !ammoFits(apds, shotgun), 'APDS (Sniper Rifles) only fits sniper rifles');
  assert.ok(ammoFits(darts, taser) && !ammoFits(darts, sniper));
  assert.ok(ammoFits(arrows, bow) && !ammoFits(arrows, shotgun));
  assert.ok(ammoFits(chummer, shotgun) && !ammoFits(chummer, sniper), 'Chummer <extra> = weapon category');
  assert.ok(ammoFits(generic, sniper) && ammoFits(generic, shotgun) && !ammoFits(generic, taser), 'no category: any firearm');
  assert.equal(ammoInfo(knife), null, 'throwing knives are not ammunition');
  assert.ok(restrictionFits('Heavy Pistols', { categoryEn: 'Heavy Pistols' }) && restrictionFits('Shotgun', { categoryEn: 'Shotguns' }));
  const clip = { name: 'Chargeur supplémentaire', notes: 'Spare Clip (Ares Desert Strike)', qty: 1 };
  assert.ok(clipFits(clip, sniper) && !clipFits(clip, shotgun), 'spare clip of that weapon only');
  assert.ok(!ammoFits(clip, sniper), 'a clip is not rounds');
});
await test('reload plans (SR5 p. 163 « Reloading Weapons »)', () => {
  assert.deepEqual(reloadPlan({ ammoType: 'c' }, { clip: true }), { action: 'simple', perAction: Infinity, swap: true }, 'clip change (one Simple Action: documented simplification)');
  // Regression: « Fill Clip » / « Fill Belt / Drum » without a spare = AGI rounds per Complex Action, not the whole magazine.
  assert.deepEqual(reloadPlan({ ammoType: 'c' }, { clip: false, agi: 6 }), { action: 'complex', perAction: 6, swap: false });
  assert.deepEqual(reloadPlan({ ammoType: 'd' }, { clip: false, agi: 4 }), { action: 'complex', perAction: 4, swap: false });
  assert.deepEqual(reloadPlan({ ammoType: 'belt' }, { clip: false, agi: 4 }), { action: 'complex', perAction: 4, swap: false });
  assert.deepEqual(reloadPlan({ ammoType: 'belt' }, { clip: true }), { action: 'complex', perAction: Infinity, swap: true });
  assert.deepEqual(reloadPlan({ ammoType: 'm' }, { agi: 5 }), { action: 'complex', perAction: 5, swap: false });
  assert.deepEqual(reloadPlan({ ammoType: 'b' }), { action: 'complex', perAction: 2, swap: false });
  // Regression: speed loader = Complex Action (not Simple).
  assert.deepEqual(reloadPlan({ ammoType: 'cy' }, { agi: 4, loader: true }), { action: 'complex', perAction: Infinity, swap: true });
  assert.deepEqual(reloadPlan({ ammoType: 'cy' }, { agi: 4 }), { action: 'complex', perAction: 4, swap: false });
  assert.deepEqual(reloadPlan({ ammoType: 'ml' }), { action: 'complex', perAction: 1, swap: false });
  assert.equal(reloadPlan({ name: 'Arc', category: 'Arcs', ammoType: '' }).action, 'simple');
});
await test('grenades: launcher profiles are not single-use, hand grenades never track rounds', () => {
  // Regression: « Minigrenade: … » weapon entries (launcher ammo profiles) were deleted by one attack.
  const profile: WeaponLike = { name: 'Minigrenade: High Explosive', kind: 'ranged', skill: 'heavy_weapons', ammo: '' };
  assert.ok(isLauncherProfile(profile) && !isGrenade(profile));
  const launcher: WeaponLike = { name: 'ArmTech MGL-12', category: 'Grenade Launchers', kind: 'ranged', skill: 'heavy_weapons', ammo: '12(c)', ammoMax: 12 };
  assert.ok(!isGrenade(launcher) && usesAmmo(launcher), 'a grenade launcher has a magazine');
  // Regression: Chummer hand grenades (« <ammo>1</ammo> ») became one-round guns.
  const hand: WeaponLike = { name: 'Grenade: Gas', kind: 'ranged', skill: 'throwing_weapons', ammo: '1' };
  assert.ok(isGrenade(hand) && !usesAmmo(hand));
  const a = { weapons: [{ ...hand, id: 'h', ammoMax: 1, ammoLoaded: 1, ammoType: '' }] };
  normalizeInventory(a, mkId);
  assert.equal(a.weapons[0].ammoMax, undefined, 'live actors imported before the fix lose their magazine');
});
await test('container kinds guessed from names', () => {
  assert.equal(guessContainerKind('Duffel Bag'), 'bag');
  assert.equal(guessContainerKind('Sac à dos'), 'bag');
  assert.equal(guessContainerKind('House'), 'safehouse');
  assert.equal(guessContainerKind('Coffre de la voiture'), 'vehicle');
  assert.equal(guessContainerKind('Holster'), 'body');
  assert.equal(guessContainerKind('Truc'), 'other');
});
await test('migration (normalizeInventory) is idempotent; legacy ammoLeft adopted; ready defaults; stored items switched off', () => {
  // Raw legacy data (bad ids, ammoLeft, missing fields): normalizeInventory works on untyped actors.
  const a: RawData = {
    containers: [{ name: 'Sac', kind: 'bag' }, { id: 'on', name: 'bad id' }],
    weapons: [
      { id: 'u', name: 'Mains nues', kind: 'melee', skill: 'unarmed_combat' },
      { id: 'k', name: 'Couteau', kind: 'melee', skill: 'blades' },
      { id: 'k2', name: 'Machette', kind: 'melee', skill: 'blades' },
      { id: 'p', name: 'Ares Predator V', kind: 'ranged', skill: 'pistols', ammo: '15(c)', ammoLeft: 7 },
      { id: 'r', name: 'Fusil', kind: 'ranged', skill: 'longarms', ammo: '10(m)' },
      { id: 'g', name: 'Grenade: Flash-Bang', kind: 'ranged', skill: 'throwing_weapons', ammo: '' },
    ],
    armor: [{ id: 'a', name: 'Veste', rating: 12, equipped: true, location: 'ghost' }],
    gear: [{ id: 'x', name: 'Lunettes', active: true }],
  };
  normalizeInventory(a, mkId);
  const once = clone(a);
  normalizeInventory(a, mkId);
  assert.deepEqual(a, once, 'idempotent');
  assert.equal(a.containers.length, 2);
  assert.notEqual(a.containers[1].id, 'on', '« on » is reserved');
  const w = Object.fromEntries(a.weapons.map((x: RawData) => [x.id, x]));
  assert.equal(w.p.ammoMax, 15);
  assert.equal(w.p.ammoType, 'c');
  assert.equal(w.p.ammoLoaded, 7, 'legacy ammoLeft adopted');
  assert.equal(w.p.ammoLeft, undefined);
  assert.equal(w.p.ammoKind.name, 'Ammo: Regular Ammo');
  assert.equal(w.r.ammoLoaded, 10, 'full by default');
  assert.deepEqual(['u', 'k', 'k2', 'p', 'r', 'g'].map((id) => w[id].equipped), [true, true, false, true, false, false], 'unarmed + first melee + first ranged');
  assert.equal(a.armor[0].location, 'on', 'unknown container → « Sur soi »');
  // Stored away: switched off.
  a.gear[0].location = a.containers[0].id;
  a.weapons[3].location = a.containers[0].id;
  normalizeInventory(a, mkId);
  assert.equal(a.gear[0].active, false);
  assert.equal(a.weapons[3].equipped, false);
  assert.equal(readyCount(a).ranged, 0);
  assert.ok(isGrenade(w.g));
});
await test('normalizeActor runs the migration on the seed PCs (idempotent)', () => {
  const pcs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8'));
  for (const pc of pcs) {
    normalizeActor(pc, mkId);
    const once = JSON.stringify(pc);
    normalizeActor(pc, mkId);
    assert.equal(JSON.stringify(pc), once, pc.id);
    assert.ok(Array.isArray(pc.containers));
    for (const l of ['weapons', 'armor', 'gear']) for (const it of pc[l]) assert.ok(it.location, `${pc.id} ${it.name} location`);
  }
});

// ---------------------------------------------------------------------------
console.log('Server');
const srv = await startServer({ port: BASE_PORT });
// Phase-1 sockets: closed with the server, or their reconnect loop keeps the process alive.
const phase1: { close(): void }[] = [];
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const jane = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  const bricks = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  phase1.push(gm, jane, bricks);
  await settle();
  const J = () => gm.state.actors.pc_jane;
  const weapon = (re: RegExp) => J().weapons.find((w) => re.test(w.nameEn || w.name))!;

  await test('catalog names in both languages, category backfill, catalogId by exact name', async () => {
    const enfield = weapon(/Enfield/);
    assert.equal(enfield.nameEn, 'Enfield AS-7');
    assert.equal(enfield.categoryEn, 'Shotguns');
    assert.equal(enfield.categoryFr, 'Fusils à pompe');
    const apds = J().gear.find((g) => /ADPS/.test(g.name))!;
    assert.equal(apds.nameEn, 'Ammo: APDS');
    assert.equal(apds.nameFr, 'Mun. : Balles ADPS');
    const id = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'weapons', item: { name: 'Ares Predator V', kind: 'ranged', skill: 'pistols', ammo: '15(c)', mode: 'SA' } });
    const custom = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'weapons', item: { name: 'Bessie', catalogId: enfield.catalogId, kind: 'ranged', ammo: '10(c)' } });
    await settle();
    const b = gm.state.actors.pc_bricks;
    const pred = b.weapons.find((w) => w.id === id)!;
    assert.ok(pred.catalogId, 'catalogId backfilled by exact English name');
    assert.equal(pred.nameFr, 'Ares Predator V');
    const bessie = b.weapons.find((w) => w.id === custom)!;
    assert.equal(bessie.nameFr, undefined, 'a renamed item keeps its own name');
    assert.equal(bessie.categoryEn, 'Shotguns', 'no stored category: the catalog’s');
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'weapons', itemId: custom, patch: { category: 'Fusil de famille' } });
    await settle();
    assert.equal(gm.state.actors.pc_bricks.weapons.find((w) => w.id === custom)!.categoryEn, undefined, 'a custom category drops the catalog ones');
  });

  await test('firing consumes rounds per fire mode; not enough → refused; GM override', async () => {
    const w = weapon(/Enfield/); // SA/TR, 10(c)
    assert.equal(w.ammoMax, 10);
    assert.equal(w.ammoLoaded, 10);
    let r = await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, fireMode: 'BF' });
    assert.deepEqual([r.fire.rounds, r.fire.left], [3, 7]);
    r = await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill }); // default: first mode (SA, 1 round)
    assert.equal(r.fire.mode, 'SA');
    assert.equal(r.fire.left, 6);
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, fireMode: 'LB' }); // 6 → 0
    await settle();
    assert.equal(weapon(/Enfield/).ammoLoaded, 0);
    await rejects(jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, fireMode: 'SA' }), /Plus assez de munitions — recharge/);
    await rejects(jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, fireMode: 'FA' }), /Mode de tir impossible/);
    await rejects(jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, ammoOverride: true }), /Plus assez/, 'players cannot override');
    r = await gm.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, fireMode: 'BF', ammoOverride: true });
    assert.equal(r.fire.rounds, 0, 'GM override fires what is left');
    await settle();
    const log = gm.state.log.filter((e) => e.kind === 'roll' && e.roll?.fire).length;
    assert.ok(log >= 4, 'rolls record the shot');
    // Melee: nothing used
    const knife = J().weapons.find((x) => x.kind === 'melee')!;
    r = await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: knife.id, skillId: knife.skill });
    assert.equal(r.fire, undefined);
  });

  await test('fewer rounds than the mode: fires what is left, defense modifier reduced (SR5 p. 180); empty = refused', async () => {
    const id = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'weapons', item: { name: 'Ares Alpha', kind: 'ranged', skill: 'automatics', ammo: '42(c)', mode: 'SA/BF/FA', equipped: true } });
    const B = () => gm.state.actors.pc_bricks.weapons.find((x) => x.id === id)!;
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'weapons', itemId: id, patch: { ammoLoaded: 1 } });
    await settle();
    let r = await bricks.send('dice/roll', { actorId: 'pc_bricks', weaponId: id, skillId: 'automatics', fireMode: 'BF' });
    assert.deepEqual([r.fire.rounds, r.fire.left, r.fire.short, r.fire.defense], [1, 0, 2, 0], 'BF with 1 round: −2 + 2 = 0');
    await rejects(bricks.send('dice/roll', { actorId: 'pc_bricks', weaponId: id, skillId: 'automatics', fireMode: 'BF' }), /Plus assez de munitions — recharge/, 'empty: refused');
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'weapons', itemId: id, patch: { ammoLoaded: 7 } });
    r = await bricks.send('weapon/fire', { actorId: 'pc_bricks', weaponId: id, mode: 'FAC' });
    assert.deepEqual([r.rounds, r.short, r.defense], [7, 3, -6], 'FA complex with 7 rounds: −9 + 3');
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'weapons', itemId: id, patch: { ammoLoaded: 15 } });
    r = await bricks.send('weapon/fire', { actorId: 'pc_bricks', weaponId: id, mode: 'SUP' });
    assert.deepEqual([r.rounds, r.short, r.narrower, r.defense], [15, 5, 2, undefined], 'suppressive fire: 1 m narrower per 2 missing rounds');
    await settle();
    assert.equal(B().ammoLoaded, 0);
  });

  await test('reload from compatible ammunition gear: qty decremented, action type, ownership', async () => {
    const w = weapon(/Enfield/);
    const box = () => J().gear.find((g) => /Stick-n-Shock \(Shotguns\)/.test(g.notes || ''))!;
    const before = box().qty;
    await rejects(bricks.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id }), /appartient/);
    const apds = J().gear.find((g) => /APDS \(Sniper Rifles\)/.test(g.notes || ''))!;
    await rejects(jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, sourceItemId: apds.id }), /incompatibles/);
    // Automatic pick: carried boxes before bags (the loose Stick-n-Shock round on Jane before the box in her Backpack).
    const carried = J().gear.find((g) => /Stick-n-Shock/.test(g.notes || '') && g.id !== box().id && g.location === 'on');
    if (carried && box().location !== 'on') {
      const r0 = await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id });
      assert.equal(r0.sourceId, carried.id, 'carried rounds first');
      assert.equal(r0.loaded, Math.min(10, carried.qty));
      await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill, fireMode: 'SA', ammoOverride: false }).catch(() => {});
    }
    await settle();
    const need = 10 - (weapon(/Enfield/).ammoLoaded || 0);
    const agi = attr(J(), 'AGI');
    const r = await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, sourceItemId: box().id });
    assert.equal(r.sourceId, box().id, 'the shotgun rounds (Shotguns) fit the Enfield');
    assert.equal(r.loaded, Math.min(need, agi), 'no spare clip (« Fill Clip »): AGI rounds per Complex Action');
    assert.equal(r.action, 'complex', 'no spare clip for the Enfield: loose rounds');
    assert.equal(r.swap, false);
    let used = r.loaded;
    while (used < need) {
      const more = await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, sourceItemId: box().id });
      assert.ok(more.loaded > 0 && more.loaded <= agi);
      used += more.loaded;
    }
    await settle();
    assert.equal(box().qty, before - need);
    assert.equal(weapon(/Enfield/).ammoLoaded, 10);
    assert.match(weapon(/Enfield/).ammoKind!.name, /Stick-n-Shock/);
    await rejects(jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id }), /déjà chargée/);
    assert.ok(gm.state.log.some((e) => e.i18n?.key?.includes('recharge {weapon}')), 'reload logged');
    // Players cannot raise the rounds by hand
    await rejects(jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { ammoLoaded: 99 } }), /Recharger/);
  });

  await test('clip swap with the spare clip of the weapon (Simple Action), clip kept; other ammunition: old rounds go back to a box', async () => {
    const w = weapon(/Desert Strike/); // 14, spare clip « Spare Clip (Ares Desert Strike) »
    await gm.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { equipped: true } });
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    await settle();
    assert.equal(weapon(/Desert Strike/).ammoLoaded, 12);
    const clip = J().gear.find((g) => /Spare Clip \(Ares Desert Strike\)/.test(g.notes || ''))!;
    const apds = J().gear.find((g) => /APDS \(Sniper Rifles\)/.test(g.notes || ''))!;
    const apdsBefore = apds.qty;
    const r = await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, sourceItemId: apds.id });
    assert.equal(r.swap, true);
    assert.equal(r.action, 'simple');
    assert.equal(r.clipId, clip.id);
    assert.equal(r.returned, 12, 'the 12 regular rounds are kept');
    await settle();
    const after = weapon(/Desert Strike/);
    assert.equal(after.ammoLoaded, Math.min(14, apdsBefore));
    assert.equal(after.ammoKind!.catalogId, apds.catalogId);
    assert.equal(J().gear.find((g) => g.id === clip.id)!.qty, clip.qty, 'clips are not consumed');
    assert.equal(J().gear.find((g) => g.id === apds.id)!.qty, apdsBefore - after.ammoLoaded);
    const regular = J().gear.find((g) => g.nameEn === 'Ammo: Regular Ammo' && g.qty === 12);
    assert.ok(regular, 'a box of regular rounds holds the 12 rounds taken out');
    // « free » is GM-only: a player's reload still takes the rounds from the inventory.
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    await settle();
    const left = J().gear.find((g) => g.id === apds.id)!.qty;
    await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, free: true });
    await settle();
    assert.equal(J().gear.find((g) => g.id === apds.id)!.qty, left - 1);
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    await gm.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, free: true });
    await settle();
    assert.equal(J().gear.find((g) => g.id === apds.id)!.qty, left - 1, 'GM free reload: inventory untouched');
    assert.equal(weapon(/Desert Strike/).ammoLoaded, 14);
  });

  await test('grenades: a throw uses one unit, the last one leaves the sheet', async () => {
    const g = J().weapons.find((x) => isGrenade(x))!;
    const before = g.qty ?? 1;
    const r = await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: g.id, skillId: g.skill || 'throwing_weapons' });
    assert.equal(r.fire.item, true);
    await settle();
    const now = J().weapons.find((x) => x.id === g.id);
    if (before <= 1) assert.equal(now, undefined, 'last grenade removed');
    else assert.equal(now!.qty, before - 1);
    const w2 = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'weapons', item: { name: 'Grenade: Fragmentation', kind: 'ranged', skill: 'throwing_weapons', accuracy: 'Physical', damage: '18P(f)', qty: 2 } });
    await jane.send('weapon/fire', { actorId: 'pc_jane', weaponId: w2 });
    await settle();
    assert.equal(J().weapons.find((x) => x.id === w2)!.qty, 1);
    await jane.send('weapon/fire', { actorId: 'pc_jane', weaponId: w2 });
    await settle();
    assert.equal(J().weapons.find((x) => x.id === w2), undefined);
  });

  await test('containers & locations: owners move their items, stored = switched off, readying takes it out; others refused', async () => {
    const ct = await jane.send('inventory/addContainer', { actorId: 'pc_jane', name: 'Sac à dos tactique' });
    await settle();
    assert.equal(J().containers!.find((c) => c.id === ct)!.kind, 'bag');
    await rejects(jane.send('inventory/addContainer', { actorId: 'pc_jane', name: '  ' }), /nom/);
    await rejects(bricks.send('inventory/addContainer', { actorId: 'pc_jane', name: 'x' }), /appartient/);
    const armor = J().armor.find((a) => a.equipped)!;
    let r = await jane.send('inventory/move', { actorId: 'pc_jane', list: 'armor', itemId: armor.id, location: ct });
    assert.equal(r.stowed, true);
    await settle();
    assert.equal(J().armor.find((a) => a.id === armor.id)!.equipped, false, 'armor in a bag is not worn');
    await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'armor', itemId: armor.id, patch: { equipped: true } });
    await settle();
    assert.equal(J().armor.find((a) => a.id === armor.id)!.location, 'on', 'wearing it takes it out of the bag');
    // Gear with effects: active off in a bag.
    const gid = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'gear', item: { name: 'Lunettes', active: true } });
    await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: gid, patch: { location: ct } });
    await settle();
    assert.equal(J().gear.find((g) => g.id === gid)!.active, false, 'active switched off in a bag');
    await rejects(jane.send('inventory/move', { actorId: 'pc_jane', list: 'gear', itemId: gid, location: 'nowhere' }), /Contenant introuvable/);
    await rejects(bricks.send('inventory/move', { actorId: 'pc_jane', list: 'gear', itemId: gid, location: 'on' }), /appartient/);
    await rejects(jane.send('inventory/move', { actorId: 'pc_jane', list: 'skills', itemId: 'x', location: 'on' }), /Liste inconnue/);
    // Weapons: players toggle ready.
    const w = weapon(/Defiance/);
    await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, patch: { equipped: true } });
    await settle();
    assert.equal(weapon(/Defiance/).equipped, true);
    // A safehouse: kind change switches its contents off.
    await jane.send('inventory/move', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, location: ct });
    await settle();
    assert.equal(weapon(/Defiance/).equipped, false);
    await jane.send('inventory/updateContainer', { actorId: 'pc_jane', containerId: ct, patch: { name: 'Planque de Tacoma', kind: 'safehouse' } });
    await rejects(jane.send('inventory/updateContainer', { actorId: 'pc_jane', containerId: ct, patch: { kind: 'castle' } }), /inconnu/);
    // Ammunition in a safehouse is out of reach.
    const darts = J().gear.find((g) => /Taser Dart/.test(g.notes || ''))!;
    await jane.send('inventory/move', { actorId: 'pc_jane', list: 'gear', itemId: darts.id, location: ct });
    await jane.send('inventory/move', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, location: 'on' });
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    await rejects(jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id }), /Aucune munition compatible/);
    await rejects(jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id, sourceItemId: darts.id }), /hors de portée/);
    // A safehouse holding items: players cannot empty it by removing it; the GM can (everything back « Sur soi »).
    await rejects(jane.send('inventory/removeContainer', { actorId: 'pc_jane', containerId: ct }), /contient encore des objets/);
    const moved = await gm.send('inventory/removeContainer', { actorId: 'pc_jane', containerId: ct });
    assert.ok(moved >= 2);
    await settle();
    assert.ok(!J().containers!.some((c) => c.id === ct));
    assert.equal(J().gear.find((g) => g.id === darts.id)!.location, 'on');
    const r2 = await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: w.id });
    assert.equal(r2.action, 'complex', 'internal magazine (m)');
  });

  await test('weapons in a vehicle / safehouse: no firing, reloading or readying; no way around the location rules', async () => {
    const HOUSE = 'fvtt_inv_house';
    const ds = () => weapon(/Desert Strike/);
    await jane.send('inventory/move', { actorId: 'pc_jane', list: 'weapons', itemId: ds().id, location: HOUSE });
    await settle();
    const left = ds().ammoLoaded;
    // Regression: a weapon kept at the safehouse fired and reloaded.
    await rejects(jane.send('dice/roll', { actorId: 'pc_jane', weaponId: ds().id, skillId: ds().skill }), /hors de portée/);
    await rejects(jane.send('weapon/fire', { actorId: 'pc_jane', weaponId: ds().id }), /hors de portée/);
    await rejects(jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: ds().id }), /hors de portée/);
    await settle();
    assert.equal(ds().ammoLoaded, left, 'no round used');
    const gr = await gm.send('dice/roll', { actorId: 'pc_jane', weaponId: ds().id, skillId: ds().skill, ammoOverride: true });
    assert.ok(gr.fire, 'the GM can');
    // Regression: readying it took it back « Sur soi ».
    await rejects(jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: ds().id, patch: { equipped: true } }), /hors de portée/);
    await settle();
    assert.equal(ds().location, HOUSE);
    // Regression: switching the safehouse to « worn » brought its contents within reach.
    await rejects(jane.send('inventory/updateContainer', { actorId: 'pc_jane', containerId: HOUSE, patch: { kind: 'body' } }), /Seul le MJ/);
    await rejects(jane.send('inventory/updateContainer', { actorId: 'pc_jane', containerId: HOUSE, patch: { kind: 'bag' } }), /Seul le MJ/);
    await jane.send('inventory/updateContainer', { actorId: 'pc_jane', containerId: HOUSE, patch: { name: 'House' } });
    await rejects(jane.send('inventory/removeContainer', { actorId: 'pc_jane', containerId: HOUSE }), /contient encore des objets/);
    // Taking it out is allowed, and written to the log for the GM.
    const logBefore = gm.state.log.length;
    await jane.send('inventory/move', { actorId: 'pc_jane', list: 'weapons', itemId: ds().id, location: 'on' });
    await settle();
    const note = gm.state.log.slice(logBefore).find((e) => e.i18n?.key === '{name} récupère {item} ({place})');
    assert.ok(note, 'retrieval logged');
    assert.equal(note.i18n!.params!.place, 'House');
    assert.ok(!gm.state.log.slice(logBefore).some((e) => e.i18n?.key === '{name} récupère {item} ({place})' && e !== note), 'logged once');
    await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: ds().id, patch: { equipped: true } });
    await settle();
    assert.equal(ds().equipped, true, 'carried: can be readied');
  });

  await test('automatic reload never swaps loaded rounds for another ammunition; English names in logs and attack labels', async () => {
    const ds = () => weapon(/Desert Strike/);
    // Only rounds of another kind within reach: every box of the loaded ammunition goes to a safehouse.
    const kind = ds().ammoKind!;
    await jane.send('dice/roll', { actorId: 'pc_jane', weaponId: ds().id, skillId: ds().skill });
    await settle();
    const vault = await gm.send('inventory/addContainer', { actorId: 'pc_jane', name: 'Coffre', kind: 'safehouse' });
    const sameKind = J().gear.filter((g) => g.catalogId && kind.catalogId && g.catalogId === kind.catalogId && Number(g.qty ?? 1) > 0);
    for (const g of sameKind) await gm.send('inventory/move', { actorId: 'pc_jane', list: 'gear', itemId: g.id, location: vault });
    const other = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'gear', item: { name: 'Mun. : Balles normales', nameEn: 'Ammo: Regular Ammo', notes: 'Ammo: Regular Ammo', category: 'Munitions', qty: 1 } });
    await settle();
    const loaded = ds().ammoLoaded;
    assert.ok(loaded! > 0);
    // Regression: one click emptied a partly loaded magazine into a 1-round box of another type.
    await rejects(jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: ds().id }), /choisis d’autres munitions/);
    await settle();
    assert.equal(ds().ammoLoaded, loaded, 'magazine untouched');
    const r = await jane.send('weapon/reload', { actorId: 'pc_jane', weaponId: ds().id, sourceItemId: other });
    assert.equal(r.swap, true, 'an explicit choice still swaps');
    await settle();
    // Log params: both languages (each viewer reads theirs).
    const log = gm.state.log.filter((e) => e.i18n?.key?.includes('change le chargeur de {weapon}')).pop()!;
    assert.deepEqual(log.i18n!.params!.ammo, { fr: 'Mun. : Balles normales', en: 'Ammo: Regular Ammo' });
    // Attack label: « Attaque — {weapon} » with the weapon in both languages.
    const flash = J().weapons.find((x) => /Flash-Bang/.test(x.nameEn || x.name))!;
    assert.ok(flash.nameEn && flash.nameFr && flash.nameEn !== flash.nameFr, `${flash.nameEn} / ${flash.nameFr}`);
    const roll = await gm.send('dice/roll', { actorId: 'pc_jane', weaponId: flash.id, skillId: flash.skill, label: `Attaque — ${flash.nameFr}` });
    assert.deepEqual(roll.labelI18n, { key: 'Attack — {weapon}', params: { weapon: { fr: flash.nameFr, en: flash.nameEn } } });
    const { interpolate } = await import('../client/i18n/format.ts');
    assert.equal(interpolate('Attack — {weapon}', roll.labelI18n.params, null as unknown as undefined, 'en'), `Attack — ${flash.nameEn}`);
  });

  await test('launcher profiles (« Minigrenade: … ») are not consumed by an attack', async () => {
    const id = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'weapons', item: { name: 'Minigrenade: High Explosive', kind: 'ranged', skill: 'heavy_weapons', damage: '16P(f)', ammo: '' } });
    const r = await gm.send('dice/roll', { actorId: 'pc_bricks', weaponId: id, skillId: 'heavy_weapons' });
    assert.equal(r.fire, undefined);
    await settle();
    assert.ok(gm.state.actors.pc_bricks.weapons.some((w) => w.id === id), 'still on the sheet');
  });
} finally {
  for (const c of phase1) c.close();
  srv.stop();
}

await test('live table migration: idempotent at every boot (legacy ammoLeft, no containers)', async () => {
  const runtime = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'sr-inv-'));
  const state = {
    version: 1, config: { gmPassword: 'lazarus', campaignName: 'T', lang: 'fr' }, users: {}, log: [],
    actors: { pc_x: { id: 'pc_x', type: 'pc', name: 'X', attributes: { BOD: 3, AGI: 3 }, weapons: [{ id: 'w1', name: 'Ares Predator V', kind: 'ranged', skill: 'pistols', ammo: '15(c)', ammoLeft: 4 }, { id: 'w2', name: 'Colt Government 2066', kind: 'ranged', skill: 'pistols', ammo: '14' }], gear: [{ id: 'g1', name: 'Ammo: APDS', qty: 20 }] } },
  };
  let srv2 = await startServer({ port: BASE_PORT + 1, runtime, keepRuntime: true, tables: [{ id: 't1', name: 'T', state }] });
  const gm = await client(srv2.url, await login(srv2.url, { role: 'gm', password: 'lazarus', table: 't1' }), { table: 't1' });
  await settle();
  const a1 = clone(gm.state.actors.pc_x);
  assert.equal(a1.weapons[0].ammoLoaded, 4);
  assert.equal(a1.weapons[0].ammoLeft, undefined);
  assert.deepEqual(a1.containers, []);
  assert.equal(a1.gear[0].location, 'on');
  assert.equal(a1.gear[0].nameFr, 'Mun. : Balles ADPS');
  // Regression: the catalog completes Foundry's « 14 » to « 14(c) »; the reload type must follow at the same boot.
  assert.deepEqual([a1.weapons[1].ammo, a1.weapons[1].ammoType, a1.weapons[1].ammoMax], ['14(c)', 'c', 14]);
  gm.close?.();
  await srv2.stopAndWait({ keep: true });
  srv2 = await startServer({ port: BASE_PORT + 2, runtime, keepRuntime: true });
  const gm2 = await client(srv2.url, await login(srv2.url, { role: 'gm', password: 'lazarus', table: 't1' }), { table: 't1' });
  await settle();
  assert.deepEqual(gm2.state.actors.pc_x, a1, 'second boot changes nothing');
  gm2.close?.();
  await srv2.stopAndWait();
  fs.rmSync(runtime, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
console.log('Foundry inventories (copy of the GM’s world)');
{
  const { readWorld, detectWorldPath } = await import('../server/lib/foundry/world.ts');
  const { convertSheet } = await import('../server/lib/foundry/convert-actor.ts');
  const { buildBundle, buildPc } = await import('../server/lib/foundry/importer.ts');
  const WORLD = detectWorldPath();
  if (!fs.existsSync(path.join(WORLD, 'world.json'))) console.log('  (monde Foundry absent — ignoré)');
  else {
    const world = await readWorld(WORLD, { collections: ['actors', 'folders', 'users'] });
    const fa = (name: string) => world.actors!.find((a) => a.name === name)!;
    await test('Jane: Duffel Bag / Backpack / House containers, items placed, equipped weapons stay « Sur soi »', () => {
      const s = convertSheet(fa('Jane'), {});
      const ids = Object.fromEntries(s.containers.map((c) => [c.name, c]));
      assert.deepEqual(Object.keys(ids).sort(), ['Backpack', 'Duffel Bag', 'House']);
      assert.equal(ids['Duffel Bag'].kind, 'bag');
      assert.equal(ids.House.kind, 'safehouse');
      const loc = (list: 'weapons' | 'gear', re: RegExp) => (s[list] as Array<{ _en?: string; notes?: string; name: string; location?: string }>).find((x) => re.test(x._en || x.notes || x.name))?.location;
      assert.equal(loc('weapons', /Desert Strike/), ids['Duffel Bag'].id);
      assert.equal(loc('gear', /APDS \(Sniper Rifles\)/), ids['Duffel Bag'].id);
      assert.equal(loc('gear', /Spare Clip/), ids['Duffel Bag'].id);
      assert.equal(loc('gear', /Taser Dart/), ids.Backpack.id);
      assert.equal(loc('weapons', /Enfield/), undefined, 'equipped in Foundry: ready, so carried');
      assert.ok(s.weapons.find((w) => /Enfield/.test(w._en!))!.equipped);
      assert.equal(s.weapons.find((w) => /Grenade: Thermal Smoke/.test(w._en!))!.qty, 4, 'grenade units');
      assert.equal(s.weapons.find((w) => /Defiance/.test(w._en!))!.ammoLoaded, 4);
    });
    await test('Bricks: Go Bag holds the Colt Cobra', () => {
      const s = convertSheet(fa('Bricks'), {});
      assert.deepEqual(s.containers.map((c) => [c.name, c.kind]), [['Go Bag', 'bag']]);
      assert.equal(s.weapons.find((w) => /Cobra/.test(w._en!))!.location, s.containers[0].id);
    });
    await test('merge re-import on a live actor without containers: Foundry bags adopted once, app moves kept', () => {
      const bundle = buildBundle(world, {});
      const pc = bundle.pcs.find((p) => p.appId === 'pc_jane')!;
      const seedJane = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8')).find((a: { id: string }) => a.id === 'pc_jane');
      const live = clone(seedJane);
      delete live.containers;
      for (const l of ['weapons', 'armor', 'gear']) for (const it of live[l]) delete it.location;
      normalizeActor(live, mkId);
      const merged = buildPc(pc, live, { mode: 'merge' });
      assert.ok(merged.containers!.some((c) => c.name === 'Duffel Bag'), 'containers adopted');
      const ds = merged.weapons.find((w) => w.id === 'fvtt_z0d0D3M9DQ8s5Mjc')!;
      assert.equal(ds.location, 'fvtt_inv_duffel_bag', 'Desert Strike moved to the Duffel Bag');
      // The app moves it out; a second merge keeps the app's choice.
      ds.location = 'on';
      const again = buildPc(pc, merged, { mode: 'merge' });
      assert.equal(again.weapons.find((w) => w.id === ds.id)!.location, 'on');
      assert.equal(again.containers!.length, merged.containers!.length);
    });
  }
}

// ---------------------------------------------------------------------------
console.log('Chummer locations, clips, grenades, ready weapons');
{
  const { parseChum5 } = await import('../server/lib/chummer/parse.ts');
  const { exportChum5 } = await import('../server/lib/chummer/export.ts');
  const xml0 = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'chummer-test.chum5'), 'utf8');
  const GUID = '11111111-2222-4333-8444-555555555555';
  const xml = xml0
    .replace('<weaponlocations />', `<weaponlocations><location><guid>${GUID}</guid><name>Duffel Bag</name><notes /><notesColor /><sortorder>0</sortorder></location></weaponlocations>`)
    .replace(/(<name>Colt Government 2066<\/name>[\s\S]*?)<location \/>/, `$1<location>${GUID}</location>`);
  await test('parse: <weaponlocations> → containers, weapon <location> guid → item.location; <equipped> is not « ready »', () => {
    const { actor } = parseChum5(xml, { keepXml: true });
    assert.deepEqual(actor.containers, [{ id: `chum_${GUID}`, name: 'Duffel Bag', kind: 'bag' }]);
    const colt = actor.weapons.find((w) => /Colt Government/.test(w.name))!;
    assert.equal(colt.location, `chum_${GUID}`);
    assert.equal(colt.equipped, undefined, 'the app’s ready defaults apply (normalizeInventory)');
  });
  // A copy of the Colt with a clip of 9 rounds, a hand grenade (« <ammo>1</ammo> ») and a second pistol, all <equipped>True</equipped>.
  const colt0 = /<weapon>\s*<sourceid>6366691e[\s\S]*?<\/weapon>/.exec(xml0)![0];
  const grenade = colt0
    .replace(/<sourceid>[^<]*<\/sourceid>/, '<sourceid>aecfccf7-d22e-4ead-abf9-e29f6dbf8550</sourceid>')
    .replace(/<guid>[^<]*<\/guid>/, '<guid>687eb954-96ba-4d8b-aab3-c767af56926b</guid>')
    .replace('<name>Colt Government 2066</name>', '<name>Grenade: Gas</name>')
    .replace('<category>Heavy Pistols</category>', '<category>Gear</category>')
    .replace('<ammo>14(c)</ammo>', '<ammo>1</ammo>')
    .replace('<mode>SA</mode>', '<mode>0</mode>');
  const second = colt0
    .replace(/<sourceid>[^<]*<\/sourceid>/, '<sourceid>00000000-0000-0000-0000-000000000000</sourceid>')
    .replace(/<guid>[^<]*<\/guid>/, '<guid>22222222-2222-4222-8222-222222222222</guid>')
    .replace('<name>Colt Government 2066</name>', '<name>Second Pistol</name>');
  const clipped = colt0.replace('<activeammoslot>1</activeammoslot>', '<activeammoslot>1</activeammoslot><clips><clip><name>Ammo: Hollow Points</name><id>8abb07e3-e18a-4cb0-b7a0-649a9f591dfb</id><count>9</count></clip></clips>');
  const xml2 = xml0.replace(colt0, clipped + grenade + second);
  await test('parse + export: rounds of the active clip (<clips><count>)', () => {
    // Regression: the clip regex had lost its backslashes, no clip was ever read (import) nor written (export).
    const { actor } = parseChum5(xml2, { keepXml: true });
    const colt = actor.weapons.find((w) => w.name === 'Colt Government 2066')!;
    assert.equal(colt.ammoLoaded, 9);
    normalizeActor(actor, mkId);
    colt.ammoLoaded = 3;
    const { xml: out } = exportChum5(actor as Actor);
    const node = /<name>Colt Government 2066<\/name>[\s\S]*?<\/weapon>/.exec(out)![0];
    assert.match(node, /<count>3<\/count>/);
    assert.equal(parseChum5(out, {}).actor.weapons.find((w) => w.name === 'Colt Government 2066')!.ammoLoaded, 3);
  });
  await test('parse: hand grenades are single-use items (qty), not one-round guns', () => {
    // Regression: « <ammo>1</ammo> » gave a 1-round magazine of minigrenades.
    const { actor } = parseChum5(xml2, { keepXml: true });
    const g = actor.weapons.find((w) => w.name === 'Grenade: Gas')!;
    assert.equal(g.skill, 'throwing_weapons');
    assert.equal(g.ammo, '');
    assert.equal(g.qty, 1);
    normalizeActor(actor, mkId);
    assert.ok(isGrenade(g) && !usesAmmo(g) && g.ammoMax === undefined);
  });
  await test('Chummer <equipped> is neither imported as ready nor exported from it', () => {
    // Regression: every Chummer weapon came in ready (2 + 2 warning always on); stowing one wrote <equipped>False</equipped>.
    const { actor } = parseChum5(xml2, { keepXml: true });
    normalizeActor(actor, mkId);
    assert.equal(readyCount(actor).ranged, 1, 'first carried ranged weapon only');
    const colt = actor.weapons.find((w) => w.name === 'Colt Government 2066')!;
    colt.equipped = false;
    const { xml: out } = exportChum5(actor as Actor);
    const node = /<name>Colt Government 2066<\/name>[\s\S]*?<\/weapon>/.exec(out)![0];
    assert.match(node, /<equipped>True<\/equipped>/, 'the file keeps Chummer’s own meaning');
  });
  await test('export: a new app container becomes a Chummer location, the item points at it', () => {
    const { actor } = parseChum5(xml, { keepXml: true });
    normalizeActor(actor, mkId);
    actor.containers!.push({ id: 'ct_new', name: 'Coffre de la voiture', kind: 'vehicle' });
    const colt = actor.weapons.find((w) => /Colt Government/.test(w.name))!;
    colt.location = 'ct_new';
    const { xml: out } = exportChum5(actor as Actor);
    const back = parseChum5(out, { keepXml: false }).actor;
    const c2 = back.weapons.find((w) => /Colt Government/.test(w.name))!;
    const ct = back.containers!.find((c) => c.id === c2.location);
    assert.equal(ct?.name, 'Coffre de la voiture');
    assert.ok(back.containers!.some((c) => c.name === 'Duffel Bag'), 'existing location kept');
  });
}

if (failures) {
  console.log(`\n${failures} test(s) en échec`);
  process.exit(1);
}
console.log('\nOK — tous les tests passent');
