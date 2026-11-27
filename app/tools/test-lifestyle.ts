// Lifestyles test: node tools/test-lifestyle.ts  (isolated servers on ports 3251-3252, exit code != 0 on failure)
// Pure rules (shared/lifestyle.js), migration actor.lifestyle → actor.lifestyles[] (idempotent, across reboots),
// historic upgrades restore, new lifestyle / upgrade purchases, removals, rent per lifestyle, permissions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import { monthlyCost, costBreakdown, settleLifestyles, normalizeLifestyle, levelCost, primaryLifestyle, qualityProblem, lifestyleFromCatalog, qualityFromCatalog } from '../shared/lifestyle.ts';
import { normalizeActor } from '../client/modules/sheet/sheet-data.ts';
import type { RawData } from '../client/modules/sheet/sheet-data.ts';
import { uid } from '../shared/util.ts';
import type { I18nEntry, Lifestyle, LifestyleQuality } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Raw catalog JSON: entries are read field by field (stats differ per catalog), hence any.
const cat = (name: string): any[] => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', `${name}.json`), 'utf8'));
const find = (file: string, name: string) => {
  const it = cat(file).find((x) => x.name === name);
  if (!it) throw new Error(`catalog item not found: ${file}/${name}`);
  return it;
};

let failures = 0;
let passes = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗', msg);
  }
}
async function rejects(promise: Promise<unknown>, re: RegExp, msg: string) {
  try {
    await promise;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(re.test((e as Error).message), `${msg} — got: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('• cost math (pure)');
const medium = find('lifestyles', 'Medium');
const low = find('lifestyles', 'Low');
const squatter = find('lifestyles', 'Squatter');
const docGold = find('lifestylequalities', 'DocWagon Contract, Gold');
const extraSecure = find('lifestylequalities', 'Extra Secure');
const pheromone = find('lifestylequalities', 'Pheromone Detection');
const dangerous = find('lifestylequalities', 'Dangerous Area');
const garage = find('lifestylequalities', 'Garage (Car (Body 5 or More))');
ok(docGold.cost === 2083 && docGold.costFormula === '25000 div 12', 'DocWagon Gold = 25000/12 per month');
ok(extraSecure.stats.multiplier === 20 && extraSecure.stats.baseOnly, 'Extra Secure = +20 % of the base');
ok(dangerous.stats.multiplier === -20, 'Dangerous Area = −20 %');
ok(garage.cost === 100 && garage.stats.allowed.includes('Medium') && !garage.stats.allowed.includes('Low'), 'Garage: 100¥, Medium+ only');

const jane = lifestyleFromCatalog(medium, { id: 'l1', name: 'Best Home', months: 1, primary: true });
ok(jane.baseCost === 5000 && jane.monthlyCost === 5000 && jane.base === 'Medium' && jane.catalogId === medium.id, 'lifestyle from catalog');
for (const q of [docGold, extraSecure, pheromone, find('lifestylequalities', 'Vocal Tension Lie Detection')]) jane.qualities.push(qualityFromCatalog(q, { id: uid('q') }));
ok(monthlyCost(jane) === 8583, `Jane (Chummer): 5000 × 1.2 + 2083 + 250 + 250 = 8583 (got ${monthlyCost(jane)})`);
const br = costBreakdown(jane);
ok(br.base === 5000 && br.multiplier === 20 && br.fromMultiplier === 1000 && br.flat === 2583 && br.total === 8583, 'cost breakdown');
const squat = lifestyleFromCatalog(squatter, { id: 'l2' });
squat.qualities.push(qualityFromCatalog(dangerous, { id: 'q2' }));
ok(monthlyCost(squat) === 400, 'Squatter 500 − 20 % = 400');
ok(monthlyCost({ baseCost: 100, qualities: [{ cost: -1000 } as LifestyleQuality] }) === 0, 'never negative');
ok(monthlyCost({ base: 'Medium', baseCost: 7083, qualities: [{ cost: 100 } as LifestyleQuality] }) === 5100, 'stored baseCost ignored: Medium is always 5000 (+ Garage 100)');
ok(monthlyCost({ base: 'Custom', baseCost: 1234, qualities: [] }) === 1234, 'custom level keeps its stored base cost');
ok(levelCost({ base: 'Hospitalized', catalogId: '2be1a0f7-6133-4966-be57-720ed9b927a9' }) === 1000 && levelCost({ base: 'Hospitalized' }) === 500, 'Hospitalized basic / intensive');
ok(monthlyCost({ base: 'Medium', metatypePct: 20, qualities: [{ cost: 100 } as LifestyleQuality] }) === 6100, 'dwarf +20 % of the base only');
ok(monthlyCost({ base: 'Low', extraCost: 300, qualities: [] }) === 2300, 'RF points bought (extraCost) added to the base');
const baked = normalizeLifestyle({ base: 'Medium', baseCost: 7083, qualities: [{ cost: 2083, category: 'Contracts' }] } as Partial<Lifestyle>, { metatype: 'Humain' });
ok(baked.baseCost === 5000 && baked.monthlyCost === 7083 && baked.metatypePct === undefined, 'baked total (Anthony) pinned back to 5000, options added once');
const dwarf = normalizeLifestyle({ base: 'Medium', baseCost: 6000, qualities: [] } as Partial<Lifestyle>, { metatype: 'Nain' });
ok(dwarf.baseCost === 5000 && dwarf.metatypePct === 20 && dwarf.monthlyCost === 6000, 'chargen dwarf surcharge migrated to metatypePct');
ok(monthlyCost({ baseCost: 0, points: { comforts: 2, security: 1 }, pointCost: { comforts: 50, security: 50 }, qualities: [] }) === 150, 'RF points × cost per point');
ok(monthlyCost(null) === 0 && monthlyCost({}) === 0, 'robust to bad input');
// Chummer order: plain percentages multiply base + non-contract options (+ RF points); base-only % the base; contracts after.
const mga = lifestyleFromCatalog(medium, { id: 'l5' });
for (const q of [garage, dangerous]) mga.qualities.push(qualityFromCatalog(q, { id: uid('q') }));
ok(monthlyCost(mga) === 4080, `Medium + Garage + Dangerous Area = (5000 + 100) × 0.8 = 4080 (got ${monthlyCost(mga)})`);
mga.qualities.push(qualityFromCatalog(docGold, { id: uid('q') }), qualityFromCatalog(extraSecure, { id: uid('q') }));
ok(monthlyCost(mga) === Math.round((5000 * 1.2 + 100) * 0.8 + 2083), `+ DocWagon (contract, not multiplied) + Extra Secure (base only) = ${Math.round((5000 * 1.2 + 100) * 0.8 + 2083)} (got ${monthlyCost(mga)})`);
ok(qualityFromCatalog(extraSecure, {}).baseOnly === true && !qualityFromCatalog(dangerous, {}).baseOnly, 'baseOnly copied from the catalog');
const brk = costBreakdown(mga);
ok(brk.base + brk.fromMultiplier + brk.flat === brk.total && brk.contracts === 2083, 'breakdown adds up');

console.log('• options of the same lifestyle: forbidden / required (pure)');
const maid = find('lifestylequalities', 'Obscure/Difficult to Find');
const cleaning = find('lifestylequalities', 'Discreet Deliveryman');
const withMaid = lifestyleFromCatalog(medium, { id: 'l6' });
withMaid.qualities.push(qualityFromCatalog(maid, { id: 'qm' }));
const lookupQ = (id: string) => cat('lifestylequalities').find((x) => x.id === id);
ok(/cannot be combined/.test((qualityProblem(withMaid, cleaning, lookupQ) as I18nEntry | null)?.key || ''), 'Discreet Deliveryman refused on an Obscure/Difficult to Find lifestyle (forbidden by the latter)');
const withCleaning = lifestyleFromCatalog(medium, { id: 'l7' });
withCleaning.qualities.push(qualityFromCatalog(cleaning, { id: 'qc' }));
ok(/cannot be combined/.test((qualityProblem(withCleaning, maid) as I18nEntry | null)?.key || ''), 'Obscure/Difficult to Find refused next to Discreet Deliveryman');
ok(/first requires/.test((qualityProblem(lifestyleFromCatalog(medium, { id: 'l8' }), find('lifestylequalities', 'Safety Third')) as I18nEntry | null)?.key || ''), 'Safety Third needs a garage or workshop first');
ok(/only for/.test((qualityProblem(lifestyleFromCatalog(medium, { id: 'l9' }), find('lifestylequalities', 'Thrifty')) as I18nEntry | null)?.key || ''), 'Thrifty: Traveler lifestyles only');

console.log('• allowed lifestyles & duplicates (pure)');
const lowL = lifestyleFromCatalog(low, { id: 'l3' });
const p1 = qualityProblem(lowL, garage) as I18nEntry | null;
ok(p1 && p1.key && /only for/.test(p1.key) && (p1.params!.allowed as string).includes('Medium'), 'garage refused on a Low lifestyle');
ok(qualityProblem(jane, garage) === null, 'garage OK on Medium');
ok(/already on this lifestyle/.test((qualityProblem(jane, docGold) as I18nEntry | null)?.key || ''), 'same contract twice refused');
const twoGarages = lifestyleFromCatalog(medium, { id: 'l4' });
twoGarages.qualities.push(qualityFromCatalog(garage, { id: 'g1' }));
ok(qualityProblem(twoGarages, garage) === null, 'allowmultiple qualities can be stacked');

console.log('• settle & primary (pure)');
const actor = { lifestyles: [{ ...jane, primary: true }, { ...squat, primary: true }, { ...lowL }] };
settleLifestyles(actor);
ok(actor.lifestyles.filter((l) => l.primary).length === 1 && primaryLifestyle(actor)!.id === 'l1', 'exactly one primary');
ok(actor.lifestyles[1].monthlyCost === 400, 'monthlyCost stored');

console.log('• migration idempotence (normalizeActor)');
const legacy: RawData = { id: 'x', type: 'pc', name: 'Legacy', lifestyle: { name: 'Planque (Moyen)', monthlyCost: 7083, monthsPaid: 2, chummerGuid: 'g-1' } };
normalizeActor(legacy, uid);
ok(Array.isArray(legacy.lifestyles) && legacy.lifestyles.length === 1 && !('lifestyle' in legacy), 'legacy lifestyle migrated');
const m0 = legacy.lifestyles[0];
ok(m0.name === 'Planque (Moyen)' && m0.base === 'Medium' && m0.baseCost === 5000 && /7083/.test(m0.notes) && m0.monthsPaid === 2 && m0.primary && m0.chummerGuid === 'g-1', 'name / months / guid kept, base cost fixed by the level (old rent in the notes)');
normalizeActor(legacy, uid);
ok(legacy.lifestyles.length === 1 && legacy.lifestyles[0].id === m0.id, 'second normalization does nothing');

// ---------------------------------------------------------------------------
const baseActor = (id: string, name: string, extra?: Record<string, unknown>) => ({
  id, type: 'pc', name, metatype: 'Humain',
  attributes: { BOD: 3, AGI: 5, REA: 5, STR: 3, WIL: 3, LOG: 4, INT: 5, CHA: 5, EDG: 3, ESS: 6 },
  condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 3 },
  skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [],
  contacts: [], sins: [], karma: 0, karmaTotal: 0, nuyen: 0, streetCred: 0, notoriety: 0, publicAwareness: 0, history: [],
  ...extra,
});
const heritage = find('armor', 'Zoé: Heritage 12');
const legacyState = {
  version: 1,
  config: { gmPassword: 'lazarus', campaignName: 'Test' },
  users: {},
  log: [],
  actors: {
    // Same ids/names as the Lazarus PCs: the Chummer restore (data/seed/upgrades-restore.json) applies to them.
    pc_jane: baseActor('pc_jane', 'Jane', {
      nuyen: 50000,
      lifestyle: { name: 'Best Home (Moyen)', monthlyCost: 5000, monthsPaid: 1 },
      armor: [{ id: 'arm1', name: 'Zoé : Heritage 12', rating: 14, equipped: true, catalogId: heritage.id }],
    }),
    pc_bricks: baseActor('pc_bricks', 'Bricks', { nuyen: 1000 }),
    pc_low: baseActor('pc_low', 'Lowlife', { nuyen: 40000, lifestyle: { name: 'Trou (Bas)', monthlyCost: 2000, monthsPaid: 0 } }),
    // Restore spec flagged `inferred` (no Chummer file): never applied at boot.
    pc_anthony: baseActor('pc_anthony', 'Anthony Von Schloss', { lifestyle: { name: "Anthony's lifestyle (Moyen)", monthlyCost: 7083, monthsPaid: 1 } }),
  },
};

let srv = await startServer({ port: 3251, legacyState, keepRuntime: true });
try {
  let gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const pj = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  const pb = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  const pl = await client(srv.url, await login(srv.url, { role: 'player', name: 'Low', characterId: 'pc_low' }));
  await settle();
  const A = (c: TestClient, id: string) => c.state.actors[id];

  console.log('• migration at boot + Chummer restore');
  const j = A(gm, 'pc_jane');
  ok(!('lifestyle' in j) && j.lifestyles?.length === 1 && j.lifestyles[0].primary, 'legacy lifestyle → lifestyles[0] (primary)');
  const best = j.lifestyles[0];
  ok(best.name === 'Best Home (Moyen)' && best.monthsPaid === 1, 'name and months kept');
  ok(best.qualities.length === 4 && best.qualities.some((q) => q.catalogId === docGold.id) && best.qualities.some((q) => q.catalogId === extraSecure.id), 'Chummer lifestyle upgrades restored');
  ok(best.baseCost === 5000 && best.monthlyCost === 8583, `restored monthly cost 8583 (got ${best.monthlyCost})`);
  const her = j.armor.find((a) => a.id === 'arm1')!;
  ok(her.mods?.length! >= 5 && her.capacity === 6 && her.mods!.every((m) => !m.effects?.armor), 'armor mods restored, armor bonus not counted twice');
  ok(j.history.some((h) => h.i18n?.key === 'Options restored from Chummer: {n}'), 'restore noted in the history');
  ok(A(gm, 'pc_low').lifestyles[0].baseCost === 2000 && !A(gm, 'pc_low').lifestyles[0].qualities.length, 'other actors migrated without upgrades');
  ok(!('restored' in pj.state.shop), 'restore bookkeeping hidden from players');
  const an = A(gm, 'pc_anthony');
  ok(!an.lifestyles[0].qualities.length && an.lifestyles[0].monthlyCost === 5000 && !an.history.some((h) => /restored/.test(h.text || '')) && !gm.state.shop.restored!.includes('pc_anthony'), 'inferred restore spec (Anthony) not applied at boot');

  console.log('• buy a new lifestyle');
  let r = await pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: medium.id, qty: 2, lifestyleName: 'Appart du centre' }] });
  await settle();
  const lo = A(pl, 'pc_low');
  ok(r.status === 'done' && r.total === 10000 && lo.nuyen === 30000, 'medium × 2 months = 10000');
  ok(lo.lifestyles.length === 2 && lo.lifestyles[1].name === 'Appart du centre' && lo.lifestyles[1].monthsPaid === 2 && !lo.lifestyles[1].primary, 'second lifestyle, not primary');
  ok(lo.lifestyles[1].catalogId === medium.id && lo.lifestyles[1].base === 'Medium', 'catalog base recorded');
  const appart = lo.lifestyles[1].id;
  const trou = lo.lifestyles[0].id;

  console.log('• upgrades on a lifestyle');
  await rejects(pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: garage.id, target: { itemId: trou } }] }), /only for/, 'garage refused on Low');
  await rejects(pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: garage.id }] }), /install this item on/, 'target required');
  await rejects(pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: garage.id, target: { itemId: 'nope' } }] }), /not found/, 'unknown target');
  r = await pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: garage.id, target: { itemId: appart } }, { ref: docGold.id, target: { itemId: appart } }] });
  await settle();
  let ap = A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!;
  ok(ap.qualities.length === 2 && ap.monthlyCost === 5000 + 100 + 2083, `upgrades change the monthly cost (got ${ap.monthlyCost})`);
  ok(r.total === (100 + 2083) * 2, `already-paid months topped up: (100 + 2083) × 2 (got ${r.total})`);
  ok(A(pl, 'pc_low').nuyen === 30000 - r.total, 'nuyen charged');
  await rejects(pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: docGold.id, target: { itemId: appart } }] }), /already on this lifestyle/, 'same contract twice refused');
  r = await pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: extraSecure.id, target: { itemId: trou } }] });
  await settle();
  ok(r.total === 0 && A(pl, 'pc_low').lifestyles.find((l) => l.id === trou)!.monthlyCost === 2400, 'unpaid lifestyle: nothing now, +20 % on the rent');
  await rejects(pb.send('shop/buy', { actorId: 'pc_low', items: [{ ref: garage.id, target: { itemId: appart } }] }), /not your character/, 'other player cannot upgrade');
  // A player cannot cut their own rent with negative options: the order waits for the GM (even in « never » mode).
  await gm.send('shop/updateSettings', { approval: 'never' });
  const rentBefore = A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!.monthlyCost;
  r = await pl.send('shop/buy', { actorId: 'pc_low', items: [{ ref: dangerous.id, target: { itemId: appart } }] });
  await settle();
  const negOrder = gm.state.shop.orders.find((o) => o.id === r.orderId);
  ok(r.status === 'pending' && negOrder?.flags!.includes('rent') && A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!.monthlyCost === rentBefore, 'player buying a negative quality → pending GM approval, rent unchanged');
  await gm.send('shop/resolve', { orderId: r.orderId, approve: false });
  await gm.send('shop/updateSettings', { approval: 'restricted' });

  console.log('• remove upgrades & permissions');
  await gm.send('shop/give', { actorId: 'pc_low', ref: dangerous.id, target: { itemId: appart } });
  await settle();
  ap = A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!;
  ok(ap.monthlyCost === Math.round((5000 + 100) * 0.8) + 2083, `GM adds a negative quality (−20 % of base + Garage; the contract is not reduced) (got ${ap.monthlyCost})`);
  const dq = ap.qualities.find((q) => q.catalogId === dangerous.id)!;
  await rejects(pl.send('shop/removeUpgrade', { actorId: 'pc_low', list: 'lifestyles', itemId: appart, subId: dq.id }), /GM/, 'player cannot remove a negative quality');
  const gq = ap.qualities.find((q) => q.catalogId === garage.id)!;
  await pl.send('shop/removeUpgrade', { actorId: 'pc_low', list: 'lifestyles', itemId: appart, subId: gq.id });
  await gm.send('shop/removeUpgrade', { actorId: 'pc_low', list: 'lifestyles', itemId: appart, subId: dq.id });
  await settle();
  ap = A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!;
  ok(ap.qualities.length === 1 && ap.monthlyCost === 5000 + 2083, 'removals recompute the cost');
  await rejects(pl.send('shop/removeUpgrade', { actorId: 'pc_low', list: 'lifestyles', itemId: appart, subId: 'zz' }), /not found/, 'unknown option');

  console.log('• rent per lifestyle');
  let n0 = A(pl, 'pc_low').nuyen;
  r = await pl.send('shop/payLifestyle', { actorId: 'pc_low', lifestyleId: appart, months: 1 });
  await settle();
  ok(r.total === 7083 && r.monthsPaid === 3 && A(pl, 'pc_low').nuyen === n0 - 7083, 'rent of the chosen lifestyle (upgrades included)');
  n0 = A(pl, 'pc_low').nuyen;
  r = await pl.send('shop/payLifestyle', { actorId: 'pc_low', months: 1 });
  await settle();
  ok(r.lifestyleId === trou && r.total === 2400 && A(pl, 'pc_low').nuyen === n0 - 2400, 'no id → primary lifestyle');
  await rejects(pl.send('shop/payLifestyle', { actorId: 'pc_low', lifestyleId: 'nope', months: 1 }), /not found/, 'unknown lifestyle');
  await rejects(pb.send('shop/payLifestyle', { actorId: 'pc_bricks', months: 1 }), /No lifestyle/, 'no lifestyle → error');
  await rejects(pb.send('shop/payLifestyle', { actorId: 'pc_low', months: 1 }), /not your character/, 'cannot pay for someone else');
  await rejects(pj.send('shop/payLifestyle', { actorId: 'pc_jane', months: 99 }), /months/, 'months bounded');
  n0 = A(pj, 'pc_jane').nuyen;
  r = await pj.send('shop/payLifestyle', { actorId: 'pc_jane', months: 1 });
  await settle();
  ok(r.total === 8583 && A(pj, 'pc_jane').nuyen === n0 - 8583, 'Jane pays her restored rent');

  console.log('• homes (shared/home.ts)');
  n0 = A(pl, 'pc_low').nuyen;
  r = await pl.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'medium-loft' });
  await settle();
  ap = A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!;
  ok(r.fee === 0 && ap.home?.layout === 'medium-loft' && ap.home.moves === 0 && A(pl, 'pc_low').nuyen === n0, 'first home pick is free');
  await rejects(pl.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'medium-loft' }), /already live here/, 'same home refused');
  await rejects(pl.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'low-studio' }), /does not match/, 'layout of another level refused');
  await rejects(pl.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'nope' }), /does not match/, 'unknown layout refused');
  await rejects(pb.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'medium-classic' }), /not your character/, 'cannot move someone else');
  r = await pl.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'medium-classic' });
  await settle();
  ap = A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!;
  ok(r.fee === 5000 && ap.home!.layout === 'medium-classic' && ap.home!.moves === 1 && A(pl, 'pc_low').nuyen === n0 - 5000, 'moving costs one month of base rent');
  n0 = A(pl, 'pc_low').nuyen;
  r = await gm.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'medium-family' });
  await settle();
  ok(r.fee === 0 && A(pl, 'pc_low').nuyen === n0 && A(pl, 'pc_low').lifestyles.find((l) => l.id === appart)!.home!.moves === 2, 'GM moves for free');
  await gm.send('actor/updateItem', { actorId: 'pc_low', list: 'lifestyles', itemId: appart, patch: { home: { layout: 'evil', x: 1 } } });
  await settle();
  ok(!A(gm, 'pc_low').lifestyles.find((l) => l.id === appart)!.home, 'GM edit with a bad home → removed (player picks again)');
  await gm.send('shop/chooseHome', { actorId: 'pc_low', lifestyleId: appart, layout: 'medium-family' });
  await settle();

  console.log('• idempotence across reboots');
  const before = JSON.stringify(A(gm, 'pc_jane').lifestyles);
  const histLen = A(gm, 'pc_jane').history.length;
  gm.close();
  pj.close();
  pb.close();
  pl.close();
  await new Promise((res) => setTimeout(res, 2500)); // let the debounced save (≤ 2 s) hit the disk: kill() is abrupt on Windows
  await srv.stopAndWait({ keep: true });
  srv = await startServer({ port: 3252, runtime: srv.runtime });
  gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  await settle();
  ok(JSON.stringify(A(gm, 'pc_jane').lifestyles) === before, 'lifestyles unchanged after a reboot (no second migration / restore)');
  ok(A(gm, 'pc_jane').history.length === histLen, 'no second restore entry');
  ok(A(gm, 'pc_low').lifestyles.length === 2, 'purchased lifestyles kept');
  ok(A(gm, 'pc_low').lifestyles.find((l) => l.id === appart)?.home?.layout === 'medium-family', 'home kept after a reboot');
  const errors = srv.output().split('\n').filter((l) => /\[action|Error|failed/i.test(l));
  ok(!errors.length, `no server errors: ${errors.join(' | ')}`);
  gm.close();
} catch (err) {
  failures++;
  console.error('Test crashed:', err);
  console.error(srv.output());
} finally {
  await srv.stopAndWait();
}
console.log(`\n${passes} ok, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
