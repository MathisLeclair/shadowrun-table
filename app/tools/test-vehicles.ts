// Vehicles module tests: pure rules (shared/vehicles.ts) and the server flows — control modes, Vehicle Tests, vehicle
// damage, vehicle tokens, attacks against a vehicle, mounted weapons (Gunnery), ramming, drone initiative, chase combat.
// Run: node tools/test-vehicles.ts   (port 3295, SR_TEST_PORT overrides)
import assert from 'node:assert/strict';
import { startServer, login, client, settle } from './test-client.ts';
import {
  vehicleStats, vehicleMonitor, vehicleDamageMod, movementRate, ramDamage, controlLimit, controlThreshold, vehicleTestPlan, gunneryPlan,
  vehicleDefensePlan, shiftRange, vehicleSkillId, isDrone, autosoftRating, controlRigRating, droneInitiative, NO_CONTROLLER,
  CALLED_SHOT_BY_ID, withBreakdown, vehicleDisabled, swarmVehicle, qualityLines, subtlePilotPenalty, mechanicSkillFor, repairPartsCost, extendedTest, signatureMod, rccRating,
} from '../shared/vehicles.ts';
import type { ActorLike, Vehicle } from '../shared/types.ts';

let failures = 0;
async function test(name: string, fn: () => unknown) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name, '\n     ', (err as Error).stack?.split('\n').slice(0, 3).join('\n      '));
  }
}
const rejects = async (p: Promise<unknown>, re?: RegExp) => {
  try {
    await p;
  } catch (err) {
    if (re) assert.match((err as Error).message, re);
    return err;
  }
  throw new Error('expected rejection');
};

const car = { id: 'v1', name: 'Test car', handling: '4/3', speed: '4', accel: '2', body: 11, armor: 6, pilot: 2, sensor: 2, seats: 4 } as Vehicle;
const drone = { id: 'v2', name: 'Doberman', handling: '5', speed: '3', accel: '1', body: 4, armor: 4, pilot: 3, sensor: 3, drone: true, autosofts: [{ id: 'a', kind: 'maneuvering', rating: 3 }, { id: 'b', kind: 'targeting', rating: 4, target: 'Ares Alpha' }] } as Vehicle;
const rigger = { attributes: { REA: 5, INT: 4, AGI: 3, LOG: 5 }, skills: [{ id: 'pilot_ground_craft', rating: 5 }, { id: 'gunnery', rating: 4 }, { id: 'sneaking', rating: 6 }], augmentations: [{ name: 'Control Rig', rating: 2 }] } as unknown as ActorLike;

console.log('Pure rules (shared/vehicles.ts)');
await test('stats with mods, condition monitor (12/6 + Body/2), damage modifier', () => {
  const v = { ...car, mods: [{ id: 'm', name: 'Handling', slots: 1, category: 'Powertrain', cost: 0, avail: '', effects: { handling: 1 } }] } as Vehicle;
  assert.equal(vehicleStats(v).handling, 5);
  assert.equal(vehicleStats(v).handlingOff, 4);
  assert.equal(vehicleMonitor(car), 18);
  assert.equal(vehicleMonitor(drone), 8);
  assert.equal(vehicleDamageMod({ ...car, damage: 7 }), -2);
});
await test('movement rates, ramming damage, chase range shifts', () => {
  assert.deepEqual(movementRate(1), [5, 10]);
  assert.deepEqual(movementRate(4), [40, 80]);
  assert.deepEqual(movementRate(6), [160, 320]);
  assert.equal(ramDamage(11, 8), 6);
  assert.equal(ramDamage(11, 40), 11);
  assert.equal(ramDamage(11, 160), 22);
  assert.equal(shiftRange('medium', -1), 'short');
  assert.equal(shiftRange('long', 2), 'lost');
  assert.equal(shiftRange('short', -3), 'short');
});
await test('skill guess, drone flag, autosofts, control rig', () => {
  assert.equal(vehicleSkillId(car), 'pilot_ground_craft');
  assert.equal(vehicleSkillId({ name: 'Nightwing', notes: 'Type : air' }), 'pilot_aircraft');
  assert.equal(vehicleSkillId({ name: 'Samuvani Criscraft Otter', categoryEn: 'Boats' }), 'pilot_watercraft');
  assert.equal(isDrone(drone), true);
  assert.equal(isDrone(car), false);
  assert.equal(autosoftRating(drone, 'targeting', { name: 'Ares Alpha' }), 4);
  assert.equal(autosoftRating(drone, 'targeting', { name: 'FN HAR' }), 0);
  assert.equal(controlRigRating(rigger), 2);
  assert.deepEqual(droneInitiative(drone), { base: 6, dice: 4 });
});
await test('Handling limit: damage (min 1), AR +1, remote VR +2 capped by Data Processing, jumped in +2 + rig', () => {
  assert.equal(controlLimit(car, 'manual', NO_CONTROLLER).limit, 4);
  assert.equal(controlLimit({ ...car, ar: true }, 'manual', NO_CONTROLLER).limit, 5);
  assert.equal(controlLimit({ ...car, damage: 15 }, 'manual', NO_CONTROLLER).limit, 1);
  assert.equal(controlLimit(car, 'remote', { rig: 0, vr: true, hot: false, dataProcessing: 5 }).limit, 5);
  assert.equal(controlLimit(car, 'rigged', { rig: 2, vr: true, hot: true, dataProcessing: 6 }).limit, 8);
  assert.equal(controlLimit(car, 'manual', NO_CONTROLLER, 'speed').limit, 4);
  assert.equal(controlLimit(car, 'manual', NO_CONTROLLER, 'handling', true).limit, 3);
});
await test('threshold: + terrain, − control rig when jumped in (min 1)', () => {
  assert.equal(controlThreshold(3, 2, 'manual', NO_CONTROLLER).threshold, 5);
  assert.equal(controlThreshold(3, 2, 'rigged', { ...NO_CONTROLLER, rig: 2 }).threshold, 3);
  assert.equal(controlThreshold(1, 0, 'rigged', { ...NO_CONTROLLER, rig: 3 }).threshold, 1);
  assert.equal(controlThreshold(null, 2, 'manual', NO_CONTROLLER).threshold, null);
});
await test('test plans: driver skill + REA, autopilot Pilot + autosoft, jumped-in hot sim +1, stealth capped by the vehicle skill', () => {
  const p = vehicleTestPlan({ ...car, control: 'rigged' }, 'control', { rig: 2, vr: true, hot: true, dataProcessing: 6 }, rigger, { threshold: 2 });
  assert.deepEqual(p.roller, { kind: 'driver', skillId: 'pilot_ground_craft', attr: 'REA' });
  assert.deepEqual(p.bonus, [{ label: 'hot sim', value: 1 }]);
  assert.equal(p.threshold, 1);
  const a = vehicleTestPlan({ ...drone, control: 'auto' }, 'control', NO_CONTROLLER, null, {});
  assert.equal(a.roller.kind, 'pilot');
  assert.equal(a.roller.kind === 'pilot' && a.roller.pool, 6);
  const s = vehicleTestPlan(car, 'stealth', NO_CONTROLLER, rigger, {});
  assert.equal(s.roller.kind === 'driver' && s.roller.capSkillAt, 5);
  const per = vehicleTestPlan({ ...drone, control: 'auto' }, 'perception', NO_CONTROLLER, null, {});
  assert.equal(per.limit, 3);
  assert.equal(per.limitLabel, 'sensor');
});
await test('gunnery: manual AGI, jumped in LOG + rig, remote max Data Processing, drone Pilot + Targeting, passive Sensor', () => {
  const w = { name: 'Ares Alpha' };
  assert.equal(gunneryPlan(car, w, NO_CONTROLLER, rigger).roller.kind === 'driver' && (gunneryPlan(car, w, NO_CONTROLLER, rigger).roller as { attr: string }).attr, 'AGI');
  const rig = gunneryPlan({ ...car, control: 'rigged' }, w, { rig: 2, vr: true, hot: false, dataProcessing: 6 }, rigger);
  assert.equal((rig.roller as { attr: string }).attr, 'LOG');
  assert.equal(rig.limitAdd, 2);
  assert.equal(gunneryPlan({ ...car, control: 'remote' }, w, { rig: 0, vr: false, hot: false, dataProcessing: 3 }, rigger).limitMax, 3);
  const d = gunneryPlan({ ...drone, control: 'auto' }, w, NO_CONTROLLER, null);
  assert.equal(d.roller.kind === 'pilot' && d.roller.pool, 7);
  assert.equal(gunneryPlan({ ...drone, control: 'auto' }, { name: 'FN HAR' }, NO_CONTROLLER, null).impossible, true);
  assert.equal(gunneryPlan(car, w, NO_CONTROLLER, rigger, { passive: true }).limitReplace, 2);
});
await test('vehicle defense: driver REA + INT, drone Pilot + Maneuvering [Handling]', () => {
  assert.equal(vehicleDefensePlan(car, NO_CONTROLLER, rigger).roller.kind, 'driver');
  const d = vehicleDefensePlan({ ...drone, control: 'auto' }, NO_CONTROLLER, null);
  assert.equal(d.roller.kind === 'pilot' && d.roller.pool, 6);
  assert.equal(d.limit, 5);
});


console.log('Pure rules: Rigger 5.0 / Run & Gun');
await test('called shots (R&G p. 115): axle caps Speed at 1, tires stack −2 on Vehicle Tests, fuel tank disables', () => {
  const axle = { ...car, breakdowns: withBreakdown(undefined, CALLED_SHOT_BY_ID.axle) };
  assert.equal(vehicleStats(axle).speed, 1);
  const twoTires = { ...car, breakdowns: withBreakdown(withBreakdown(undefined, CALLED_SHOT_BY_ID.tire), CALLED_SHOT_BY_ID.tire) };
  assert.deepEqual(vehicleTestPlan(twoTires, 'control', NO_CONTROLLER, rigger, {}).bonus, [{ label: 'flat tires', value: -4 }]);
  assert.equal(vehicleDisabled({ ...car, breakdowns: withBreakdown(undefined, CALLED_SHOT_BY_ID.fuel) }), true);
  assert.equal(CALLED_SHOT_BY_ID.door.dvLimit, 0);
});
await test('swarm (R5 p. 31): best Pilot / Sensor / autosofts, worst Handling / Speed, + (n − 1) to pools and limits', () => {
  const a = { ...drone, id: 'a', swarm: 'S', pilot: 2, sensor: 2, handling: '5', speed: '3' } as Vehicle;
  const b = { ...drone, id: 'b', swarm: 'S', pilot: 4, sensor: 3, handling: '3', speed: '4', autosofts: [{ id: 'x', kind: 'maneuvering', rating: 5 }] } as Vehicle;
  const c = { ...drone, id: 'c', swarm: 'S', pilot: 3, sensor: 1, handling: '4', speed: '2' } as Vehicle;
  const sw = swarmVehicle([a, b, c], a, 5)!;
  assert.equal(sw.swarmBonus, 2);
  assert.equal(vehicleStats(sw).pilot, 5); // the RCC's Device Rating
  assert.equal(vehicleStats(sw).handling, 3);
  assert.equal(vehicleStats(sw).speed, 2);
  assert.equal(vehicleStats(sw).sensor, 3);
  assert.equal(autosoftRating(sw, 'maneuvering'), 5);
  const plan = vehicleTestPlan({ ...sw, control: 'auto' }, 'control', NO_CONTROLLER, null, {});
  assert.ok(plan.bonus.some((l) => l.label === 'swarm' && l.value === 2));
  assert.ok(plan.limitLines.some((l) => l.label === 'swarm' && l.value === 2));
  assert.equal(swarmVehicle([a], a), a, 'alone: no swarm');
});
await test('qualities (R5 p. 33-34): Chaser, Stunt Driver, Speed Demon (aboard, Speed 3+), Too Much Data, Subtle Pilot', () => {
  const ace = { ...rigger, qualities: [{ name: 'Chaser' }, { name: 'Cascadeur' }, { name: 'Speed Demon' }, { name: 'Too Much Data' }, { name: 'Subtle Pilot' }] } as unknown as ActorLike;
  const labels = (o: object, v: Vehicle = car) => qualityLines(ace, v, o).map((l) => `${l.label} ${l.value}`);
  assert.deepEqual(labels({ chaseAction: 'stunt', atSpeed: true }), ['Chaser 2', 'Stunt Driver 2', 'Speed Demon 1']);
  assert.deepEqual(labels({ atSpeed: true }, { ...car, control: 'remote' }), [], 'Speed Demon only aboard or jumped in');
  assert.deepEqual(labels({ directing: 4 }), ['Too Much Data -2']);
  assert.equal(subtlePilotPenalty(ace, car), -2);
  assert.equal(subtlePilotPenalty(ace, { ...car, control: 'auto' }), 0);
});
await test('repair (R5 p. 29-30): mechanic skill per vehicle, parts 5 % per box, extended test loses a die per interval', () => {
  assert.equal(mechanicSkillFor(car), 'automotive_mechanic');
  assert.equal(mechanicSkillFor({ name: 'Nightwing', notes: 'Type : air' }), 'aeronautics_mechanic');
  assert.equal(repairPartsCost(20000, 3), 3000);
  const pools: number[] = [];
  const r = extendedTest(6, 4, null, (n) => { pools.push(n); return { hits: 1 }; });
  assert.deepEqual(pools, [6, 5, 4, 3]);
  assert.equal(r.success, true);
  assert.equal(extendedTest(2, 9, null, () => ({ hits: 1 })).success, false);
});
await test('signature (SR5 p. 184): people −3, drones −3, big vehicles +3; RCC rating from the Matrix device', () => {
  assert.equal(signatureMod(null), -3);
  assert.equal(signatureMod({ vehicle: drone }), -3);
  assert.equal(signatureMod({ vehicle: { ...car, body: 18 } }), 3);
  assert.equal(rccRating({ matrix: { device: 'Proteus Poseidon', rating: 6 }, gear: [] } as unknown as ActorLike), 0);
  assert.equal(rccRating({ matrix: { device: 'X', rating: 4, gearId: 'g' }, gear: [{ id: 'g', category: 'Rigger Command Consoles' }] } as unknown as ActorLike), 4);
});

const srv = await startServer({ port: Number(process.env.SR_TEST_PORT) || 3295 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const jane = await client(srv.url, await login(srv.url, { role: 'player', name: 'Jane', characterId: 'pc_jane' }));
  const mat = await client(srv.url, await login(srv.url, { role: 'player', name: 'Mat', characterId: 'pc_anthony' }));
  await settle();
  const SAAB = gm.state.actors.pc_jane.vehicles!.find((v) => /SAAB/.test(v.name))!.id;
  const WING = gm.state.actors.pc_jane.vehicles!.find((v) => /Nightwing/.test(v.name))!.id;
  const BIKE = gm.state.actors.pc_anthony.vehicles![0].id;

  console.log('Server: control, tests, damage');
  await test('vehicle kinds: the Nightwing glider flies (Pilot Aircraft) and is no drone, nor is the SAAB', async () => {
    const vs = gm.state.actors.pc_jane.vehicles!;
    assert.equal(isDrone(vs.find((v) => v.id === WING)), false);
    assert.equal(vehicleSkillId(vs.find((v) => v.id === WING)), 'pilot_aircraft');
    assert.equal(isDrone(vs.find((v) => v.id === SAAB)), false);
    assert.equal(vehicleSkillId(vs.find((v) => v.id === SAAB)), 'pilot_ground_craft');
  });
  await test('Vehicle Test: Pilot skill + REA, Handling limit, threshold checked and logged', async () => {
    const r = await jane.send('vehicle/roll', { actorId: 'pc_jane', vehicleId: SAAB, test: 'control', threshold: 2, terrain: 1 });
    assert.equal(r.vehicle.threshold, 3);
    assert.equal(r.vehicle.success, r.hits >= 3);
    assert.equal(r.limitLabel, 'handling');
    assert.match(r.breakdown, /REA \d/);
    await settle();
    const e = jane.state.log.find((x) => x.roll?.vehicle?.vehicleId === SAAB);
    assert.ok(e && e.roll!.vehicle!.threshold === 3);
  });
  await test('another player cannot drive Jane\'s car; Jane cannot jump in without a control rig', async () => {
    await rejects(mat.send('vehicle/roll', { actorId: 'pc_jane', vehicleId: SAAB, test: 'control' }), /not your vehicle/);
    await rejects(jane.send('vehicle/control', { actorId: 'pc_jane', vehicleId: SAAB, control: 'rigged' }), /control rig/);
  });
  await test('autopilot: the drone rolls Pilot + autosoft, under its own name', async () => {
    await gm.send('vehicle/configure', { actorId: 'pc_jane', vehicleId: WING, patch: { autosofts: [{ kind: 'clearsight', rating: 3 }] } });
    await jane.send('vehicle/control', { actorId: 'pc_jane', vehicleId: WING, control: 'auto' });
    const r = await jane.send('vehicle/roll', { actorId: 'pc_jane', vehicleId: WING, test: 'perception' });
    assert.match(r.breakdown, /Pilot 1 \+ Clearsight 3/);
    assert.equal(r.limitLabel, 'sensor');
    await settle();
    const e = gm.state.log.find((x) => x.roll?.vehicle?.vehicleId === WING)!;
    assert.match(e.author, /Nightwing/);
  });
  await test('damage by hand: capped at the monitor; destroyed vehicle refuses tests', async () => {
    const r = await jane.send('vehicle/damage', { actorId: 'pc_jane', vehicleId: WING, damage: 99 });
    assert.equal(r.damage, r.max);
    await rejects(jane.send('vehicle/roll', { actorId: 'pc_jane', vehicleId: WING, test: 'perception' }), /destroyed/);
    await jane.send('vehicle/damage', { actorId: 'pc_jane', vehicleId: WING, damage: 0 });
    await settle();
    assert.equal(gm.state.actors.pc_jane.vehicles!.find((v) => v.id === WING)!.damage, undefined);
  });

  console.log('Server: map, attacks, gunnery, ramming');
  const mapId = await gm.send('maps/create', { name: 'Test véhicules', width: 40, height: 20 });
  await gm.send('maps/setActive', { mapId });
  await gm.send('maps/update', { mapId, patch: { lighting: 'bright' } });
  await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_jane', x: 5, y: 5 } });
  await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_anthony', x: 20, y: 5 } });
  let carToken = '';
  await test('Jane places her car next to her token; it keeps vehicleId', async () => {
    const r = await jane.send('vehicle/place', { actorId: 'pc_jane', vehicleId: SAAB });
    carToken = r.tokenId;
    await settle();
    const t = gm.state.maps[mapId].tokens.find((x) => x.id === carToken)!;
    assert.equal(t.vehicleId, SAAB);
    assert.equal(t.actorId, 'pc_jane');
    assert.equal(t.size, 2);
    await rejects(jane.send('vehicle/place', { actorId: 'pc_jane', vehicleId: SAAB }), /already on the map/);
  });
  await test('an attack on the car token targets the vehicle; driver defends; DV under the armor does nothing', async () => {
    // A weak weapon: 2P, AP 0 against Armor 3 → modified DV stays under the armor unless 1+ net hits.
    const wid = await gm.send('actor/addItem', { actorId: 'pc_anthony', list: 'weapons', item: { name: 'Pea shooter', kind: 'ranged', skill: 'pistols', category: 'Pistols', damage: '1P', ap: 0, accuracy: 9, mode: 'SA', rc: 0, ammo: '50(c)', reach: 0 } });
    const weaponId = typeof wid === 'string' ? wid : wid?.id || gm.state.actors.pc_anthony.weapons.find((w) => w.name === 'Pea shooter')!.id;
    await gm.send('weapon/reload', { actorId: 'pc_anthony', weaponId, free: true }).catch(() => null);
    let r: any;
    for (let i = 0; i < 20; i++) {
      r = await mat.send('attack/roll', { actorId: 'pc_anthony', weaponId, targetTokenId: carToken, label: 'Attack — Pea shooter' });
      await gm.send('weapon/reload', { actorId: 'pc_anthony', weaponId, free: true }).catch(() => null);
      if (r.hits > 0) break;
    }
    await settle();
    const a = gm.state.attacks.list.find((x) => x.id === r.attackId)!;
    assert.deepEqual(a.vehicle, { vehicleId: SAAB, name: gm.state.actors.pc_jane.vehicles!.find((v) => v.id === SAAB)!.name });
    assert.equal(a.targetId, 'pc_jane');
    if (a.status !== 'defense') return;
    const d = await jane.send('attack/defend', { attackId: a.id, options: ['evasive'] });
    assert.match(d.roll.breakdown, /REA \d+ \+ INT \d+/);
    assert.match(d.roll.breakdown, /evasive driving/);
    if (d.attack.status === 'soak') {
      const before = gm.state.actors.pc_jane.condition.physical;
      const s = await jane.send('attack/soak', { attackId: a.id });
      assert.equal(s.attack.status, 'done');
      await settle();
      assert.equal(gm.state.actors.pc_jane.condition.physical, before, 'the owner takes no damage');
      const v = gm.state.actors.pc_jane.vehicles!.find((x) => x.id === SAAB)!;
      assert.equal(Number(v.damage) || 0, s.attack.damage);
      if (s.attack.modifiedDv < 3) assert.equal(s.roll, null);
    }
  });
  await test('mounted weapon: fired with Gunnery + AGI from the car token, Complex Action', async () => {
    const wid = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'weapons', item: { name: 'Ares Alpha', kind: 'ranged', skill: 'automatics', category: 'Assault Rifles', damage: '11P', ap: -2, accuracy: 5, mode: 'SA/BF/FA', rc: 2, ammo: '42(c)', reach: 0 } });
    const weaponId = typeof wid === 'string' ? wid : gm.state.actors.pc_jane.weapons.find((w) => w.name === 'Ares Alpha')!.id;
    await jane.send('vehicle/mount', { actorId: 'pc_jane', weaponId, vehicleId: SAAB });
    await gm.send('weapon/reload', { actorId: 'pc_jane', weaponId, free: true }).catch(() => null);
    const anthonyTok = gm.state.maps[mapId].tokens.find((t) => t.actorId === 'pc_anthony' && !t.vehicleId)!;
    const r = await jane.send('attack/roll', { actorId: 'pc_jane', weaponId, targetTokenId: anthonyTok.id, label: 'Attack — Ares Alpha', attr: 'LOG' });
    assert.match(r.breakdown, /^(Gunnery \d+|AGI \d+ \+ defaulting)/);
    assert.match(r.breakdown, /AGI \d/);
    assert.ok(!/LOG/.test(r.breakdown), 'the client cannot pick the attribute');
  });
  await test('ram: Vehicle skill + REA vs the target; DV from Body and speed, AP −6 on a character', async () => {
    const anthonyTok = gm.state.maps[mapId].tokens.find((t) => t.actorId === 'pc_anthony' && !t.vehicleId)!;
    const r = await jane.send('vehicle/ram', { actorId: 'pc_jane', vehicleId: SAAB, targetTokenId: anthonyTok.id, metersPerTurn: 40 });
    await settle();
    const a = gm.state.attacks.list.find((x) => x.id === r.attackId)!;
    assert.equal(a.ram?.vehicleId, SAAB);
    assert.equal(a.ap, -6);
    assert.equal(a.dv, 10); // SAAB Body 10, 11-50 m/turn → Body
    assert.equal(a.kind, 'melee');
  });
  await test('vehicle on autopilot gets its own initiative entry (Pilot × 2 + 4D6); the driven car does not', async () => {
    await jane.send('vehicle/control', { actorId: 'pc_jane', vehicleId: WING, control: 'auto' });
    await jane.send('vehicle/place', { actorId: 'pc_jane', vehicleId: WING });
    await gm.send('combat/start', {});
    await settle();
    const entries = gm.state.combat.entries;
    const d = entries.find((e) => e.kind === 'drone')!;
    assert.ok(d, 'drone entry');
    assert.equal(d.vehicleId, WING);
    assert.equal(d.base, 2);
    assert.equal(d.dice, 4);
    assert.ok(!entries.some((e) => e.tokenId === carToken), 'no entry for the driven car');
    assert.equal(entries.filter((e) => e.actorId === 'pc_jane').length, 1);
    await jane.send('vehicle/control', { actorId: 'pc_jane', vehicleId: WING, control: 'manual' });
    await settle();
    assert.equal(gm.state.combat.entries.find((e) => e.kind === 'drone')!.out, true);
    await gm.send('combat/end', {});
  });

  console.log('Server: Rigger 5.0 / Run & Gun');
  await test('called shot on a vehicle (R&G): −6 dice for the axle, DV capped at 6, the breakdown lands with the damage', async () => {
    const anthonyTok = gm.state.maps[mapId].tokens.find((t) => t.actorId === 'pc_anthony' && !t.vehicleId)!;
    void anthonyTok;
    const wid = gm.state.actors.pc_anthony.weapons.find((w) => w.name === 'Pea shooter')!.id;
    await gm.send('weapon/reload', { actorId: 'pc_anthony', weaponId: wid, free: true }).catch(() => null);
    const r = await mat.send('attack/roll', { actorId: 'pc_anthony', weaponId: wid, targetTokenId: carToken, calledShot: 'axle', label: 'Attack — Pea shooter' });
    assert.match(r.breakdown, /Axle −6/);
    await settle();
    const a = gm.state.attacks.list.find((x) => x.id === r.attackId)!;
    assert.equal(a.calledShot, 'axle');
    await rejects(mat.send('attack/roll', { actorId: 'pc_anthony', weaponId: wid, targetTokenId: gm.state.maps[mapId].tokens.find((t) => t.actorId === 'pc_jane' && !t.vehicleId)!.id, calledShot: 'axle' }), /vehicle target/);
    if (a.status === 'defense' || a.status === 'soak') await gm.send('attack/resolve', { attackId: a.id, outcome: 'damage', amount: 2, type: 'P' });
    else await gm.send('vehicle/breakdown', { actorId: 'pc_jane', vehicleId: SAAB, patch: { axle: true } });
    await settle();
    const v = gm.state.actors.pc_jane.vehicles!.find((x) => x.id === SAAB)!;
    assert.equal(v.breakdowns?.axle, true);
    assert.equal(vehicleStats(v).speed, 1);
  });
  await test('repair (R5): Jane fixes her car — boxes and breakdowns cleared on success, log with hours and parts', async () => {
    await gm.send('vehicle/damage', { actorId: 'pc_jane', vehicleId: SAAB, damage: 1 });
    // Jane has no Automotive Mechanic: it cannot default (SR5) — the GM's NPC mechanic does it instead.
    const err = await jane.send('vehicle/repair', { actorId: 'pc_jane', vehicleId: SAAB, mechanicId: 'pc_jane', boxes: 1 }).then(() => null, (e: Error) => e);
    if (err) assert.match(err.message, /untrained/);
    await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'skills', item: { id: 'automotive_mechanic', name: 'Mécanique automobile', attr: 'LOG', rating: 12 } });
    const r = await jane.send('vehicle/repair', { actorId: 'pc_jane', vehicleId: SAAB, mechanicId: 'pc_jane', boxes: 1, conditions: 1 });
    assert.ok(r.rolls.length >= 1);
    assert.equal(r.hours, r.rolls.length * 4);
    await settle();
    const v = gm.state.actors.pc_jane.vehicles!.find((x) => x.id === SAAB)!;
    if (r.success) {
      assert.equal(v.damage, undefined);
      assert.equal(v.breakdowns, undefined);
    }
  });
  await test('target lock (SR5 p. 184): a lock lowers the defense against the vehicle\'s weapons; players only see their own', async () => {
    const anthonyTok = gm.state.maps[mapId].tokens.find((t) => t.actorId === 'pc_anthony' && !t.vehicleId)!;
    let r: any;
    for (let i = 0; i < 15; i++) {
      r = await jane.send('vehicle/lock', { actorId: 'pc_jane', vehicleId: SAAB, targetTokenId: anthonyTok.id, modifier: 10 });
      if (r.vehicle.net > 0) break;
    }
    assert.match(r.breakdown, /signature −3/);
    await settle();
    if (r.vehicle.net <= 0) return;
    const lock = jane.state.rigging!.locks.find((l) => l.vehicleId === SAAB)!;
    assert.equal(lock.net, r.vehicle.net);
    assert.equal(mat.state.rigging!.locks.length, 0, 'Anthony does not see the lock on him');
    const wid = gm.state.actors.pc_jane.weapons.find((w) => w.name === 'Ares Alpha')!.id;
    await gm.send('weapon/reload', { actorId: 'pc_jane', weaponId: wid, free: true }).catch(() => null);
    const shot = await jane.send('attack/roll', { actorId: 'pc_jane', weaponId: wid, targetTokenId: anthonyTok.id, label: 'Attack — Ares Alpha', fireMode: 'SA' });
    await settle();
    const a = gm.state.attacks.list.find((x) => x.id === shot.attackId);
    if (a) assert.equal(a.defenseMod, -lock.net);
    // Detect Target Lock: Anthony has no device in the seed — refused; the GM gives him one.
    await gm.send('actor/update', { actorId: 'pc_anthony', patch: { matrix: { device: 'Test link', rating: 3, attack: 0, sleaze: 0, dataProcessing: 3, firewall: 3, programs: [] } } });
    const d = await mat.send('vehicle/ew', { actorId: 'pc_anthony', action: 'detectLock', modifier: 20 });
    if (d.success) assert.ok(d.locks.some((l: { vehicle: string }) => /SAAB/.test(l.vehicle)));
    const lockId = gm.state.rigging!.locks.find((l) => l.vehicleId === SAAB)!.id;
    await rejects(jane.send('vehicle/ew', { actorId: 'pc_jane', action: 'breakLock', lockId }), /no commlink|not on you/);
    await rejects(mat.send('vehicle/ew', { actorId: 'pc_anthony', action: 'breakLock', lockId }), /untrained/);
    await gm.send('actor/addItem', { actorId: 'pc_anthony', list: 'skills', item: { id: 'electronic_warfare', name: 'Guerre électronique', attr: 'LOG', rating: 6 } });
    const b = await mat.send('vehicle/ew', { actorId: 'pc_anthony', action: 'breakLock', lockId, modifier: 20 });
    await settle();
    const left = gm.state.rigging!.locks.find((l) => l.id === lockId);
    if (b.net >= lock.net) assert.equal(left, undefined);
  });
  await test('swarm (R5 p. 31): drones of one swarm share a single initiative entry', async () => {
    const add = async (name: string) => {
      await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'vehicles', item: { name, handling: '4', speed: '3', accel: '1', body: 2, armor: 2, pilot: 3, sensor: 3, drone: true, control: 'auto' } });
      await settle();
      return gm.state.actors.pc_jane.vehicles!.find((v) => v.name === name)!.id;
    };
    const d1 = await add('Fly-Spy A');
    const d2 = await add('Fly-Spy B');
    for (const id of [d1, d2]) {
      await jane.send('vehicle/swarm', { actorId: 'pc_jane', vehicleId: id, swarm: 'Bees' });
      await jane.send('vehicle/control', { actorId: 'pc_jane', vehicleId: id, control: 'auto' });
      await jane.send('vehicle/place', { actorId: 'pc_jane', vehicleId: id });
    }
    await gm.send('combat/start', {});
    await settle();
    const drones = gm.state.combat.entries.filter((e) => e.kind === 'drone' && [d1, d2].includes(e.vehicleId!));
    assert.equal(drones.length, 1);
    const r = await jane.send('vehicle/roll', { actorId: 'pc_jane', vehicleId: d1, test: 'perception' });
    assert.match(r.breakdown, /swarm \+1/);
    await gm.send('combat/end', {});
  });

  console.log('Server: chase combat');
  await test('GM starts a chase: quarry + pursuer at Medium; players see it', async () => {
    await gm.send('chase/start', { environment: 'speed', terrain: 1, vehicles: [{ actorId: 'pc_jane', vehicleId: SAAB, role: 'quarry' }, { actorId: 'pc_anthony', vehicleId: BIKE, role: 'pursuer', range: 'medium' }] });
    await settle();
    assert.equal(jane.state.chase!.active, true);
    assert.equal(jane.state.chase!.vehicles.length, 2);
    assert.equal(jane.state.chase!.vehicles.find((v) => v.role === 'pursuer')!.range, 'medium');
  });
  await test('break away: range moves by min(net hits, Accel) and never past what the roll allows', async () => {
    const c = gm.state.chase!;
    const q = c.vehicles.find((v) => v.role === 'quarry')!;
    const before = c.vehicles.find((v) => v.role === 'pursuer')!.range;
    const r = await jane.send('chase/action', { id: q.id, action: 'breakAway', threshold: 1 });
    assert.equal(r.vehicle.threshold, 2); // 1 + light terrain
    assert.equal(r.limitLabel, 'speed');
    await settle();
    const p = gm.state.chase!.vehicles.find((v) => v.role === 'pursuer')!;
    const order = ['short', 'medium', 'long', 'extreme'];
    const moved = order.indexOf(p.range!) - order.indexOf(before!);
    const accel = vehicleStats(gm.state.actors.pc_jane.vehicles!.find((v) => v.id === SAAB)).accel;
    if (r.vehicle.net < 0) assert.equal(moved, 0);
    else assert.ok(moved >= 0 && moved <= Math.min(r.vehicle.net, accel));
  });
  await test('cut-off needs Short range; at Short the target may owe a Vehicle Test', async () => {
    const c = gm.state.chase!;
    const q = c.vehicles.find((v) => v.role === 'quarry')!;
    const p = c.vehicles.find((v) => v.role === 'pursuer')!;
    await gm.send('chase/set', { id: p.id, patch: { range: 'long', lost: false } });
    await rejects(mat.send('chase/action', { id: p.id, action: 'cutOff', targetId: q.id }), /Short range/);
    await gm.send('chase/set', { id: p.id, patch: { range: 'short' } });
    const r = await mat.send('chase/action', { id: p.id, action: 'cutOff', targetId: q.id });
    await settle();
    const pend = gm.state.chase!.pending.find((x) => x.chaseVehicleId === q.id);
    if (r.vehicle.net > 0) {
      assert.ok(pend, 'Jane owes a test');
      assert.equal(pend!.threshold, r.vehicle.net);
      await rejects(mat.send('chase/resolve', { pendingId: pend!.id }), /not your vehicle/);
      await jane.send('chase/resolve', { pendingId: pend!.id });
      await settle();
      assert.ok(!gm.state.chase!.pending.some((x) => x.id === pend!.id));
    } else assert.ok(!pend);
  });
  await test('stunt: only the quarry; success makes the pursuers owe a test', async () => {
    const c = gm.state.chase!;
    const q = c.vehicles.find((v) => v.role === 'quarry')!;
    const p = c.vehicles.find((v) => v.role === 'pursuer')!;
    await gm.send('chase/set', { id: q.id, patch: { crashed: false } });
    await rejects(mat.send('chase/action', { id: p.id, action: 'stunt', threshold: 1 }), /quarry/);
    const r = await jane.send('chase/action', { id: q.id, action: 'stunt', threshold: 0 });
    await settle();
    if (r.vehicle.success) assert.ok(gm.state.chase!.pending.some((x) => x.chaseVehicleId === p.id && x.onFail === 'fallBack'));
  });
  await test('hidden chase vehicles stay out of players\' views; chase/end clears it', async () => {
    const c = gm.state.chase!;
    await gm.send('chase/set', { id: c.vehicles[1].id, patch: { hidden: true } });
    await settle();
    assert.equal(jane.state.chase!.vehicles.length, 1);
    await gm.send('chase/end', {});
    await settle();
    assert.equal(gm.state.chase!.active, false);
  });
} finally {
  await srv.stop();
}
console.log(failures ? `\n${failures} test(s) failed` : '\nAll vehicle tests passed');
process.exit(failures ? 1 : 0);
