// Shop module test: node tools/test-shop.ts  (isolated server on port 3250, exit code != 0 on failure)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import { accessoryFit, weaponMounts, vehicleModFit, vehicleVars, vehicleSlots, upgradeAvail, upgradeFields, martialKarma, quote, lowersRent, availBaseHours, availOutcome, durationText, matchAvailTests, needsAvailTest } from '../client/modules/shop/rules.ts';
import type { AvailOutcome } from '../client/modules/shop/rules.ts';
import { armorTotal } from '../shared/sr5.ts';
import type { Armor, ArmorMod, I18nEntry } from '../shared/types.ts';

/** Result of the 'shop/availTest' action (server/modules/40-shop.ts). */
type AvailTestResult = AvailOutcome & { testId: string; hits: number; availHits: number; baseHours: number; tries: number; overpay: number; logId: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOP_TEST_PORT) || 3250;

/** i18n check: entries render to their stored English text, and every key has a French entry. Returns French texts. */
async function renderI18n(entries: Array<{ i18n?: I18nEntry; text?: string }>, label: string) {
  const I = await import('../client/lib/i18n.ts');
  const dir = new URL('../client/i18n/fr/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)));
  const dict: Record<string, string> = {};
  for (const f of files) Object.assign(dict, JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
  I.setDictionary(dict, { legacyKeys: JSON.parse(fs.readFileSync(new URL('../client/i18n/legacy-fr-keys.json', import.meta.url), 'utf8')) });
  I.clearMissing();
  const text = (e: { i18n?: I18nEntry; text?: string }): string => (e.i18n?.key ? I.t(e.i18n.key, e.i18n.params) : e.text as string);
  ok(entries.length > 0 && entries.every((e) => e.i18n?.key), `${label}: entries carry i18n keys`);
  I.setLang('en');
  const bad = entries.filter((e) => text(e) !== e.text);
  ok(!bad.length, `${label}: English rendering = stored text (${bad.map((e) => `${text(e)} ≠ ${e.text}`).join(' | ')})`);
  I.setLang('fr');
  const fr = entries.map(text);
  const missing = Object.keys(I.missingKeys());
  ok(!missing.length, `${label}: every key has French (${missing.join(' | ')})`);
  return fr;
}
// Raw catalog JSON: entries are read field by field (stats differ per catalog), hence any.
const cat = (name: string): any[] => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', `${name}.json`), 'utf8'));
const itemFr = (it: { nameFr?: string; name: string }) => it.nameFr || it.name;
const find = (file: string, name: string) => {
  const it = cat(file).find((x) => x.name === name);
  if (!it) throw new Error(`catalog item not found: ${file}/${name}`);
  return it;
};

// Test actors (the state is pre-seeded so the test does not depend on the characters seeds).
const baseActor = (id: string, name: string, extra?: Record<string, unknown>) => ({
  id, type: 'pc', name, metatype: 'Humain',
  attributes: { BOD: 3, AGI: 5, REA: 5, STR: 3, WIL: 3, LOG: 4, INT: 5, CHA: 5, EDG: 3, ESS: 6 },
  condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 3 },
  skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [],
  contacts: [], sins: [], karma: 0, karmaTotal: 0, nuyen: 0, streetCred: 0, notoriety: 0, publicAwareness: 0, history: [],
  ...extra,
});

async function startWithState(state: object) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-shop-'));
  fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify(state));
  // Node runs the TypeScript server directly; before 22.18 type stripping needs a flag.
  const stripTypes = process.execArgv.filter((a) => a === '--experimental-strip-types' || a === '--no-warnings');
  const proc = spawn(process.execPath, [...stripTypes, 'server/index.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), SR_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d: Buffer) => (out += d));
  proc.stderr.on('data', (d: Buffer) => (out += d));
  const url = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url + '/api/lobby');
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, output: () => out, stop: () => { proc.kill(); try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {} } };
}

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
// Pure upgrade rules (regressions of the rules review)
// ---------------------------------------------------------------------------
{
  console.log('• upgrade rules (pure)');
  // Armor mods' armor bonus counts in the Armor value (Gel Packs +2; unequipped mods do not).
  const gelMod = { id: 'm1', name: 'Gel Packs', capacity: 2, effects: { armor: 2 } } as ArmorMod;
  ok(armorTotal({ armor: [{ id: 'a', rating: 8, equipped: true, mods: [gelMod] } as Armor] }) === 10, 'armorTotal: Actioneer 8 + Gel Packs 2 = 10');
  ok(armorTotal({ armor: [{ id: 'a', rating: 8, equipped: true, mods: [{ ...gelMod, equipped: false }] } as Armor, { id: 'h', rating: 2, stack: true, equipped: true, mods: [{ id: 'm2', effects: { armor: 1 } } as ArmorMod] } as Armor] }) === 11, 'armorTotal: unequipped mod ignored, stacking helmet mod counted');
  // operation="contains" requirements (drones, Shock Pad).
  const alpha = find('weapons', 'Ares Alpha');
  const desert = find('weapons', 'Ares Desert Strike');
  const shock = find('accessories', 'Shock Pad');
  const asW = (c: { name: string; id: string }) => ({ id: 'w', name: c.name, catalogId: c.id, kind: 'ranged', accessories: [] });
  ok(!accessoryFit(asW(alpha), alpha, shock).problem && !accessoryFit(asW(desert), desert, shock).problem, 'Shock Pad fits assault and sniper rifles (category contains « Rifles »)');
  const l36 = find('weapons', 'Colt America L36');
  ok(!!accessoryFit(asW(l36), l36, shock).problem, 'Shock Pad still refused on a light pistol');
  const ammoDrone = find('vehicles', 'Ammo Drone (Small)');
  const droneArm = find('vehiclemods', 'Drone Arm');
  const dv = { id: 'v', name: ammoDrone.name, catalogId: ammoDrone.id, mods: [] };
  ok(!vehicleModFit(dv, ammoDrone, droneArm, 1, vehicleVars(dv, ammoDrone)).problem, 'Drone Arm fits Ammo Drone (Small) (category contains « Drones »)');
  ok(!!vehicleModFit({ id: 'v2', name: 'Scoot', mods: [] }, find('vehicles', 'Dodge Scoot (Scooter)'), droneArm, 1, {}).problem, 'Drone Arm refused on a scooter');
  // R5 per-category slot pools on vehicles (drones: one pool).
  const chinook = find('vehicles', 'Airstream Traveler Chinook');
  const workshop = find('vehiclemods', 'Workshop');
  const smugC = find('vehiclemods', 'Smuggling Compartment');
  const armStd = find('vehiclemods', 'Armor (Standard)');
  const cv = { id: 'c', name: chinook.name, catalogId: chinook.id, mods: [{ catalogId: workshop.id, slots: 6, category: 'Body' }, { catalogId: smugC.id, slots: 3, category: 'Body' }] };
  const cvars = vehicleVars(cv, chinook);
  const fit3 = vehicleModFit(cv, chinook, armStd, 3, cvars);
  ok(!fit3.problem && fit3.pool === 'Protection' && fit3.cap === 14 && fit3.used === 0 && fit3.need === 6, `Chinook (Body 14) with Workshop + Smuggling Compartment (Body 9/14): Armor (Standard) 3 fits the Protection pool (${JSON.stringify(fit3)})`);
  const fitBig = vehicleModFit(cv, chinook, armStd, 8, cvars);
  ok(/Not enough slots/.test(fitBig.problem?.key || '') && fitBig.cap === 14, 'Armor (Standard) 8 (16 slots) exceeds the Protection pool (14)');
  ok(vehicleSlots(cv, chinook, 'Body') === 14, 'Body pool = Body 14');
  const tank = find('vehicles', 'Krime Euskaldunak Tankette');
  ok(vehicleSlots({ name: tank.name }, tank, 'Powertrain') === 0 && vehicleSlots({ name: tank.name }, tank, 'Cosmetic') === 4, 'Tankette: Body 7 − 7 = 0 powertrain slots, 7 − 3 = 4 cosmetic');
  ok(vehicleSlots(dv, ammoDrone, 'Protection') === vehicleSlots(dv, ammoDrone), 'drones: one pool');
  // Catalog weapons without <accessorymounts> get no mount (bows, holdouts…); weapons without catalog entry: standard ones.
  const bow = find('weapons', 'Bow (Rating 1)');
  ok(weaponMounts({ name: bow.name, kind: 'ranged' }, bow).length === 0, 'Bow: no mount point');
  ok(!!accessoryFit(asW(bow), bow, find('accessories', 'Silencer/Suppressor')).problem && !!accessoryFit(asW(bow), bow, find('accessories', 'Bipod')).problem, 'no silencer / bipod on a bow');
  ok(weaponMounts({ name: 'Arme maison', kind: 'ranged' }, null).length === 5, 'weapon without catalog entry: standard mounts');
  // « +2R » availability relative to the target.
  const sgi = find('accessories', 'Smartgun System, Internal');
  const relQ = upgradeAvail(quote(sgi, { vars: { WeaponCost: l36.cost } }), sgi, quote(l36, {}));
  ok(sgi.availRelative && relQ.availValue === l36.availValue + 2 && relQ.legality === 'R', `Smartgun System, Internal on a Colt L36 (4R): 6R (got ${relQ.avail})`);
  ok(upgradeAvail(quote(sgi, { vars: { WeaponCost: 500 } }), sgi, quote(find('weapons', 'Ares Light Fire 75'), {})).legality === 'F', 'stricter legality of the target kept (F)');
  ok(upgradeAvail(quote(shock, {}), shock, quote(alpha, {})).availValue === shock.availValue, 'absolute availability unchanged');
  // Martial arts karma: catalog style cost, first technique included even for a known style without technique.
  const hapsum = cat('martialarts').find((m) => /Hapsum-Do/.test(m.name));
  ok(martialKarma(hapsum, null, 1) === 15 && martialKarma(hapsum, null, 2) === 20, 'Way of Unified Mana: style 15 karma (+5 per further technique)');
  ok(martialKarma(hapsum, { techniques: [] }, 1) === 0 && martialKarma(hapsum, { techniques: [] }, 2) === 5, 'known style without technique: first technique included');
  ok(martialKarma(hapsum, { techniques: [{ id: 't' }] }, 1) === 5, 'further techniques 5 karma');
  // Sheet editor: values that depend on the parent item.
  const yf = upgradeFields('armormods', find('armormods', 'YNT Softweave Armor'), { name: 'Veste', capacity: 12, rating: 12 }, { parentValue: 1000 });
  ok(yf.capacity === -6 && yf.cost === 1000, `YNT Softweave on capacity 12: −6 capacity, Armor Cost (got ${JSON.stringify(yf)})`);
  const gk = upgradeFields('vehiclemods', find('vehiclemods', 'Gecko Tips'), { name: 'Scoot', body: 4 }, { parentValue: 3000 });
  ok(gk.slots === 4 && gk.cost === 5000, `Gecko Tips on Body 4: 4 slots, 5000 ¥ (got ${JSON.stringify(gk)})`);
  ok(upgradeFields('accessories', sgi, { name: 'Colt' }, { parentValue: 350 }).cost === 350 && upgradeFields('accessories', sgi, { name: 'Colt' }, {}).cost === undefined, 'Smartgun internal: Weapon Cost, unknown without a price');
  ok(lowersRent(find('lifestylequalities', 'Dangerous Area')) && lowersRent({ category: 'Positive', multiplier: -10, cost: 0 }) && !lowersRent(find('lifestylequalities', 'Garage (Car (Body 5 or More))')), 'lowersRent');
}

const state = {
  version: 1,
  config: { gmPassword: 'lazarus', campaignName: 'Test' },
  users: {},
  log: [],
  actors: {
    pc_jane: baseActor('pc_jane', 'Jane', { nuyen: 100000, attributes: { BOD: 2, AGI: 6, REA: 7, STR: 2, WIL: 3, LOG: 4, INT: 5, CHA: 8, EDG: 3, MAG: 5, ESS: 6 } }),
    pc_bricks: baseActor('pc_bricks', 'Bricks', { nuyen: 500, matrix: { device: 'Vieux deck', rating: 1, attack: 1, sleaze: 1, dataProcessing: 1, firewall: 1, programs: ['Browse'] } }),
  },
};

// « Compétence » storefront filter (pure helpers, client/modules/shop/skills.js).
{
  console.log('• skill filter (pure)');
  const S = await import('../client/modules/shop/skills.ts');
  const files = ['weapons', 'gear', 'vehicles', 'programs', 'accessories', 'cyberware'];
  const entries = files.flatMap((file) => cat(file).map((item) => ({ ref: item.id, file, item })));
  const catalog = { entries };
  const t0 = Date.now();
  const idx = S.skillIndex(catalog);
  ok(Date.now() - t0 < 2000, `skill index is fast (${Date.now() - t0} ms)`);
  ok(S.skillIndex(catalog) === idx, 'skill index cached per catalog');
  const sk = (file: string, name: string) => idx.get(find(file, name).id)!;
  ok(entries.filter((e) => e.file === 'weapons').every((e) => idx.get(e.ref)!.length === 1), 'every weapon has its skill');
  ok(sk('weapons', 'Ares Alpha').join() === 'automatics', 'Ares Alpha → automatics');
  ok(sk('weapons', 'Ares Predator V').join() === 'pistols', 'Predator → pistols');
  ok(sk('vehicles', 'Ares-Segway Terrier').join() === 'pilot_ground_craft', 'bike → Pilot Ground Craft');
  ok(entries.filter((e) => e.file === 'vehicles' && /^Drones/.test(e.item.category)).every((e) => !idx.get(e.ref)!.length), 'drones: no skill (ambiguous)');
  ok(entries.filter((e) => e.file === 'vehicles' && /hover/i.test(e.item.name)).every((e) => !idx.get(e.ref)!.length), 'hovercraft: no skill');
  ok(sk('gear', 'Spellcasting Focus, Combat').includes('spellcasting'), 'spellcasting focus → spellcasting');
  ok(sk('gear', 'Summoning Focus').join() === 'summoning', 'summoning focus → summoning');
  ok(!sk('gear', 'Power Focus').length && !sk('gear', 'Weapon Focus').length, 'power / weapon focus: no skill');
  ok(sk('gear', 'Grenade: Fragmentation').join() === 'throwing_weapons', 'grenade → throwing weapons');
  ok(sk('gear', 'Minigrenade: Fragmentation').join() === 'heavy_weapons', 'minigrenade → heavy weapons');
  ok(sk('gear', 'Arrow: Standard').join() === 'archery', 'arrow → archery');
  ok(sk('gear', 'Plastic Explosive').join() === 'demolitions', 'explosive → demolitions');
  ok(sk('gear', 'Medkit').join() === 'first_aid', 'medkit → first aid');
  const deck = entries.find((e) => e.file === 'gear' && e.item.category === 'Cyberdecks');
  ok(idx.get(deck!.ref)!.join() === 'cybercombat,hacking', 'cyberdeck → hacking + cybercombat');
  ok(!idx.get(entries.find((e) => e.file === 'gear' && e.item.category === 'Commlinks')!.ref)!.length, 'commlink: no skill');
  ok(sk('accessories', 'Vindicator 200-Round Belt').join() === 'heavy_weapons', 'accessory requires a minigun → heavy weapons only');
  ok(sk('accessories', 'Collapsed Frame').join() === 'automatics', 'accessory requires a machine pistol → automatics only');
  ok(!sk('accessories', 'Long Barrel').includes('blades'), 'barrel accessory not for blades');
  ok(sk('accessories', 'Long Barrel').includes('pistols'), 'barrel accessory fits pistols');
  // Ratings and matching
  const ratings = S.actorSkillRatings({ skills: [{ id: 'automatics', rating: 5 }, { id: 'pistols', rating: 0 }, { id: 'custom_x', name: 'Armes lourdes', rating: 2 }] });
  ok(ratings.get('automatics') === 5 && !ratings.has('pistols') && ratings.get('heavy_weapons') === 2, 'actor ratings (> 0, by id or French name)');
  ok(S.matchSkill(['automatics'], 'automatics', false, ratings) && !S.matchSkill(['pistols'], 'automatics', false, ratings), 'match by skill');
  ok(S.matchSkill(['automatics'], '', true, ratings) && !S.matchSkill(['pistols'], '', true, ratings) && !S.matchSkill([], '', true, ratings), 'match « my skills »');
  ok(S.matchSkill([], S.NO_SKILL, false, ratings) && !S.matchSkill(['pistols'], S.NO_SKILL, false, ratings), 'match « no linked skill »');
  const weapons = entries.filter((e) => e.file === 'weapons');
  const o = S.skillOptions(weapons, (e) => idx.get(e.ref)!, ratings);
  ok(o.options[0].id === 'automatics' && o.options[0].rating === 5 && o.options[1].id === 'heavy_weapons' && o.none === 0, `options: the character's skills first (${o.options.map((x) => x.id).join()})`);
  ok(o.options.reduce((n, x) => n + x.count, 0) === weapons.length, 'option counts');
}

// Availability test rules (pure): SR5 p. 418 time table, outcome, matching.
{
  console.log('• availability test rules (pure)');
  ok([[100, 6], [101, 24], [1000, 24], [1001, 48], [10000, 48], [10001, 168], [100000, 168], [100001, 720]].every(([c, h]) => availBaseHours(c) === h), 'time table by price');
  const o = availOutcome({ hits: 4, availHits: 1, baseHours: 48 });
  ok(o.net === 3 && o.found && o.delayHours === 16, `48 h / 3 net hits = 16 h (${JSON.stringify(o)})`);
  const tie = availOutcome({ hits: 2, availHits: 2, baseHours: 6 });
  ok(tie.found && tie.tie && tie.delayHours === 12, `a tie finds the item in twice the table time (${JSON.stringify(tie)})`);
  const miss = availOutcome({ hits: 1, availHits: 3, baseHours: 24 });
  ok(!miss.found && miss.retryHours === 48, 'failure: retry after twice the table time');
  ok(!availOutcome({ hits: 0, availHits: 0, baseHours: 6, glitch: true, critGlitch: true }).found, 'critical glitch: never found');
  ok(availOutcome({ hits: 3, availHits: 1, baseHours: 6, glitch: true }).glitch, 'glitch kept on a success (GM consequences)');
  const d = (h: number) => {
    const v = durationText(h);
    return v.t.replace(/\{(\w+)\}/g, (_, k: string) => v.params![k] as string);
  };
  const hs = [16, 1.5, 0.5, 24, 56, 168, 720, 240];
  ok(hs.map(d).join('|') === '16 h|1 h 30|30 min|1 day|2 d 8 h|1 week|1 month|10 days', `durations (${hs.map(d).join(' | ')})`);
  const shopS = { availTest: 'required', availFree: 2 };
  ok(needsAvailTest(shopS, { file: 'weapons', availValue: 4 }) && !needsAvailTest(shopS, { file: 'weapons', availValue: 2 }), 'free threshold');
  ok(!needsAvailTest(shopS, { file: 'gear', special: true, availValue: 8 }) && !needsAvailTest(shopS, { file: 'lifestyles', availValue: 8 }), 'specials / lifestyles: no test');
  ok(!needsAvailTest({ availTest: 'off' }, { file: 'gear', availValue: 8 }) && needsAvailTest({ availTest: 'helper' }, { file: 'gear', availValue: 8 }), 'modes');
  const tests = [{ id: 'a', ref: 'x', avail: 6, found: true, ts: 1 }, { id: 'b', ref: 'x', avail: 4, found: true, ts: 2 }, { id: 'c', ref: 'x', avail: 9, found: false, ts: 3 }, { id: 'd', ref: 'y', targetId: 'w1', avail: 3, found: true, ts: 1 }];
  const m = matchAvailTests([
    { ref: 'x', availValue: 4, needsTest: true }, { ref: 'x', availValue: 5, needsTest: true }, { ref: 'x', availValue: 4, needsTest: true },
    { ref: 'y', availValue: 3, needsTest: true }, { ref: 'y', targetId: 'w1', availValue: 3, needsTest: true }, { ref: 'z', availValue: 3, needsTest: false },
  ], tests);
  const ids = m.map((x) => x?.id || '-').join('');
  ok(ids === 'ba--d-', `matching: one test per line, tested avail ≥ the line's, same target, failures ignored (${ids})`);
}

const srv = await startWithState(state);
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const jane = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  const bricks = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  await settle();
  const A = (c: TestClient, id: string) => c.state.actors[id];

  console.log('• defaults & seeds');
  const shop = gm.state.shop;
  ok(shop && shop.open === true && shop.markup === 0 && shop.sellRate === 50 && shop.maxAvail === 12, 'default settings');
  ok(shop.approval === 'restricted' && shop.allowRestricted === true && shop.allowForbidden === false, 'default legality/approval');
  ok(shop.availTest === 'required' && shop.availFree === 0 && Array.isArray(shop.availTests), 'default availability test: required');
  // The purchase sections below test the shop without availability tests (their own section is « availability test »).
  await gm.send('shop/updateSettings', { availTest: 'off' });
  await settle();
  ok(shop.categories.weapons === true && shop.categories.gear === true, 'categories enabled');
  ok(shop.specials.length >= 8, 'seed specials merged');
  ok(shop.specials.some((s) => s.hidden), 'GM sees hidden special');
  ok(!jane.state.shop.specials.some((s) => s.hidden), 'player does not see hidden special');
  ok(!jane.state.shop.specials.some((s) => 'gmNotes' in s), 'gmNotes stripped for players');
  ok(!('removedSeedIds' in jane.state.shop), 'internal fields stripped');

  console.log('• immediate purchase (legal item)');
  const jacket = find('armor', 'Armor Jacket');
  jane.events.length = 0;
  let r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id, qty: 1 }] });
  await settle();
  ok(r.status === 'done' && r.total === 1000, 'armor jacket bought immediately');
  ok(A(jane, 'pc_jane').nuyen === 99000, 'nuyen deducted');
  const arm = A(jane, 'pc_jane').armor.find((a) => a.catalogId === jacket.id)!;
  ok(arm && arm.rating === 12 && arm.paid === 1000 && arm.equipped === false, 'armor added with rating & paid price');
  ok(A(jane, 'pc_jane').history.some((h) => h.nuyen === -1000), 'history entry');
  ok(jane.state.log.some((e) => e.kind === 'shop' && /Jane buys/.test(e.text)), 'shop log entry visible to buyer');
  ok(!bricks.state.log.some((e) => e.kind === 'shop' && /Jane buys/.test(e.text)), 'shop log entry private from other player');
  ok(jane.events.some((e) => e.ev === 'sfx' && e.data.id === 'cash'), 'cash sfx emitted');

  console.log('• pending purchase (restricted) + GM approval');
  const katana = find('weapons', 'Katana');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await settle();
  ok(r.status === 'pending', 'restricted item creates a pending order');
  ok(A(jane, 'pc_jane').nuyen === 99000, 'nuyen not deducted while pending');
  const pend = gm.state.shop.orders.find((o) => o.id === r.orderId);
  ok(pend && pend.status === 'pending' && pend.flags!.includes('restricted'), 'GM sees pending order with flags');
  ok(jane.state.shop.orders.some((o) => o.id === r.orderId), 'buyer sees own order');
  ok(!bricks.state.shop.orders.some((o) => o.id === r.orderId), 'other player does not see the order');
  await rejects(jane.send('shop/resolve', { orderId: r.orderId, approve: true }), /GM/, 'player cannot resolve');
  await gm.send('shop/resolve', { orderId: r.orderId, approve: true, note: 'Cabana te fait un clin d’œil' });
  await settle();
  const w = A(jane, 'pc_jane').weapons.find((x) => x.catalogId === katana.id);
  ok(w && w.skill === 'blades' && w.kind === 'melee' && w.damage === '(STR+3)P' && w.ap === -3, 'katana added with weapon stats');
  ok(A(jane, 'pc_jane').nuyen === 98000, 'nuyen deducted on approval');
  ok(gm.state.shop.orders.find((o) => o.id === r.orderId)!.status === 'approved', 'order approved');
  await rejects(gm.send('shop/resolve', { orderId: r.orderId, approve: true }), /already/, 'cannot resolve twice');

  console.log('• deny & cancel');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await gm.send('shop/resolve', { orderId: r.orderId, approve: false, note: 'Rupture de stock' });
  await settle();
  const denied = jane.state.shop.orders.find((o) => o.id === r.orderId)!;
  ok(denied.status === 'denied' && denied.gmNote === 'Rupture de stock', 'denied with note');
  ok(A(jane, 'pc_jane').nuyen === 98000, 'no charge on deny');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await rejects(bricks.send('shop/cancel', { orderId: r.orderId }), /your order/, 'other player cannot cancel');
  await jane.send('shop/cancel', { orderId: r.orderId });
  await settle();
  ok(jane.state.shop.orders.find((o) => o.id === r.orderId)!.status === 'cancelled', 'owner cancels pending order');

  console.log('• legality, availability, funds, ownership');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: find('weapons', 'Ares Alpha').id }] }), /forbidden/, 'forbidden item blocked');
  await gm.send('shop/updateSettings', { allowForbidden: true });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: find('weapons', 'Ranger Arms SM-5').id }] }), /availability 16/, 'availability limit enforced');
  await rejects(bricks.send('shop/buy', { actorId: 'pc_bricks', items: [{ ref: find('gear', 'Hermes Chariot').id }] }), /Insufficient funds/, 'insufficient funds');
  await rejects(bricks.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /not your character/, 'cannot buy for someone else');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'nope' }] }), /not in the catalog/, 'unknown item');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id, qty: -3 }] }), /quantity/, 'bad quantity');
  await rejects(jane.send('shop/updateSettings', { open: false }), /GM/, 'player cannot change settings');
  await gm.send('shop/updateSettings', { categories: { armor: false } });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /section closed/, 'disabled category');
  await gm.send('shop/updateSettings', { categories: { armor: true }, open: false });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /can’t be reached/, 'shop closed');
  await gm.send('shop/updateSettings', { open: true, approval: 'never' });

  console.log('• rating & stacking & packs');
  const medkit = find('gear', 'Medkit');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: medkit.id, rating: 3 }, { ref: medkit.id, rating: 3, qty: 2 }, { ref: medkit.id, rating: 99 }] });
  await settle();
  ok(r.total === 750 * 3 + 1500, 'rating formula pricing (r3 ×3 = 2250, r99 clamped to 6 = 1500)');
  const mk = A(jane, 'pc_jane').gear.filter((g) => g.catalogId === medkit.id);
  ok(mk.length === 2 && mk.find((g) => g.rating === 3)?.qty === 3 && mk.find((g) => g.rating === 6)?.qty === 1, 'identical gear stacks by rating');

  console.log('• cyberware: grade, essence, magic, bonuses');
  const wired = find('cyberware', 'Wired Reflexes');
  const before = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: wired.id, rating: 1, grade: 'alpha' }] });
  await settle();
  ok(r.status === 'done', 'approval never → immediate even for restricted');
  const jn = A(jane, 'pc_jane');
  const aug = jn.augmentations.find((a) => a.catalogId === wired.id)!;
  ok(aug && aug.grade === 'alpha' && Math.abs(aug.essence - 1.6) < 1e-6, 'alphaware essence 2 × 0.8 = 1.6');
  ok(Math.abs(jn.attributes.ESS - 4.4) < 1e-6, 'ESS reduced to 4.4');
  ok(jn.attributes.MAG === 3, 'MAG reduced by 2 (essence loss 1.6 → 2 points)');
  ok(jn.nuyen === before - 46800, 'alphaware cost ×1.2');
  ok(jn.augmented?.REA === 1 && jn.initiative?.dice === 2, 'wired reflexes bonus applied');
  await gm.send('shop/updateSettings', { maxAvail: 24 });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: wired.id, rating: 3 }] }), /Insufficient Essence/, 'essence guard (4.4 − 5 would kill)');
  await gm.send('shop/updateSettings', { maxAvail: 12 });
  const synaptic = find('bioware', 'Synaptic Booster');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: synaptic.id, grade: 'used' }] }), /Grade/, 'banned grade rejected');

  console.log('• sell');
  const n0 = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'armor', itemId: arm.id });
  await settle();
  ok(r.status === 'done' && r.total === 500, 'sold at 50% of paid price');
  ok(A(jane, 'pc_jane').nuyen === n0 + 500 && !A(jane, 'pc_jane').armor.some((a) => a.id === arm.id), 'armor removed & paid');
  const n1 = A(jane, 'pc_jane').nuyen;
  const mk3 = A(jane, 'pc_jane').gear.find((g) => g.catalogId === medkit.id && g.rating === 3)!;
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'gear', itemId: mk3.id, qty: 2 });
  await settle();
  ok(r.total === 750 && A(jane, 'pc_jane').nuyen === n1 + 750 && A(jane, 'pc_jane').gear.find((g) => g.id === mk3.id)!.qty === 1, 'partial gear sale');
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'augmentations', itemId: aug.id });
  await settle();
  const ja = A(jane, 'pc_jane');
  ok(!ja.augmentations.length && !ja.augmented?.REA && ja.initiative!.dice === 1, 'augmentation sold, bonus removed');
  ok(Math.abs(ja.attributes.ESS - 4.4) < 1e-6, 'essence hole stays');
  await gm.send('shop/updateSettings', { approval: 'always' });
  const katanaItem = ja.weapons.find((x) => x.catalogId === katana.id)!;
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'weapons', itemId: katanaItem.id });
  ok(r.status === 'pending', 'sale pending when approval = always');
  await rejects(jane.send('shop/sell', { actorId: 'pc_jane', list: 'weapons', itemId: katanaItem.id }), /already waiting/, 'no duplicate pending sale');
  const n2 = A(jane, 'pc_jane').nuyen;
  await gm.send('shop/resolve', { orderId: r.orderId, approve: true, total: 700 });
  await settle();
  ok(A(jane, 'pc_jane').nuyen === n2 + 700 && !A(jane, 'pc_jane').weapons.some((x) => x.id === katanaItem.id), 'GM approves sale with negotiated price');
  await gm.send('shop/updateSettings', { approval: 'never' });

  console.log('• specials');
  const fb = () => gm.state.shop.specials.find((s) => s.id === 'cabana-flashbang')!;
  const stock0 = fb().stock;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-flashbang', qty: 2 }] });
  await settle();
  ok(r.total === 180 && fb().stock === stock0! - 2, 'special bought, stock decremented');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-flashbang', qty: 50 }] }), /stock/, 'stock limit');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-badge-hollow-pine' }] }), /no longer exists/, 'hidden special not purchasable by players');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-apds' }] });
  await settle();
  ok(A(jane, 'pc_jane').gear.find((g) => g.name.startsWith('Munitions APDS'))?.qty === 10, 'pack special adds 10 rounds');
  const { id: newId } = await gm.send('shop/addSpecial', { fromRef: jacket.id, cost: 800, stock: 1, forActorIds: ['pc_bricks'] });
  await settle();
  ok(gm.state.shop.specials.find((s) => s.id === newId)?.cost === 800, 'GM creates special from catalog');
  ok(!jane.state.shop.specials.some((s) => s.id === newId) && bricks.state.shop.specials.some((s) => s.id === newId), 'reserved special only visible to its runner');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: `special:${newId}` }] }), /reserved/, 'reserved special blocked for others');
  await gm.send('shop/updateSpecial', { id: newId, patch: { cost: 400, notes: 'Promo' } });
  r = await bricks.send('shop/buy', { actorId: 'pc_bricks', items: [{ ref: `special:${newId}` }] });
  await settle();
  ok(r.total === 400 && A(bricks, 'pc_bricks').armor.some((a) => a.rating === 12 && a.paid === 400), 'special mapped to armor with catalog stats');
  ok(gm.state.shop.specials.find((s) => s.id === newId)!.stock === 0, 'stock now 0');
  await gm.send('shop/removeSpecial', { id: 'cabana-trauma-patch' });
  await settle();
  ok(!gm.state.shop.specials.some((s) => s.id === 'cabana-trauma-patch'), 'special removed');

  console.log('• GM sale & gift, matrix device, lifestyle');
  const caliban = find('gear', 'Fairlight Caliban');
  await rejects(gm.send('shop/buy', { actorId: 'pc_bricks', items: [{ ref: caliban.id }] }), /Insufficient funds/, 'GM sale still needs funds');
  await gm.send('shop/give', { actorId: 'pc_bricks', ref: caliban.id, setMatrix: true });
  await settle();
  const b = A(bricks, 'pc_bricks');
  ok(b.nuyen === 100 && b.gear.some((g) => g.catalogId === caliban.id && g.paid === undefined), 'gift is free');
  ok(b.matrix!.device === 'Fairlight Caliban' && b.matrix!.rating === 7 && b.matrix!.firewall === 7 && b.matrix!.programs.includes('Browse'), 'matrix device set, programs kept');
  const exploit = cat('programs').find((p) => p.name === 'Exploit');
  await gm.send('shop/give', { actorId: 'pc_bricks', ref: exploit.id });
  await settle();
  ok(A(bricks, 'pc_bricks').matrix!.programs.includes(exploit.nameFr || exploit.name), 'program added to matrix programs');
  const low = cat('lifestyles').find((l) => l.name === 'Low');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: low.id, qty: 1 });
  await settle();
  const jl = A(jane, 'pc_jane').lifestyles || [];
  ok(jl.length === 1 && jl[0].baseCost === 2000 && jl[0].monthlyCost === 2000 && jl[0].monthsPaid === 1 && jl[0].primary && !('lifestyle' in A(jane, 'pc_jane')), 'lifestyle set (lifestyles[0], primary)');
  const n3 = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/payLifestyle', { actorId: 'pc_jane', lifestyleId: jl[0].id, months: 2 });
  await settle();
  ok(r.monthsPaid === 3 && A(jane, 'pc_jane').nuyen === n3 - 4000, 'pay lifestyle');
  await rejects(bricks.send('shop/payLifestyle', { actorId: 'pc_bricks', months: 1 }), /No lifestyle/, 'no lifestyle → error');
  await rejects(jane.send('shop/payLifestyle', { actorId: 'pc_jane', months: 500 }), /months/, 'months bounded');

  console.log('• weapon accessories: mounts, included parts, prices, resale');
  await gm.send('shop/updateSettings', { approval: 'never', allowForbidden: true, maxAvail: 20 });
  const predator = find('weapons', 'Ares Predator V');
  const laser = find('accessories', 'Laser Sight');
  const scope = find('accessories', 'Imaging Scope');
  const bipod = find('accessories', 'Bipod');
  const silencer = find('accessories', 'Silencer/Suppressor');
  const sgInternal = find('accessories', 'Smartgun System, Internal');
  await gm.send('shop/give', { actorId: 'pc_jane', items: [{ ref: predator.id }, { ref: find('weapons', 'Colt America L36').id }] });
  await settle();
  const pred = A(jane, 'pc_jane').weapons.find((x) => x.catalogId === predator.id)!;
  const colt = A(jane, 'pc_jane').weapons.find((x) => x.name === itemFr(find('weapons', 'Colt America L36')))!;
  ok(pred && JSON.stringify(pred.mounts) === JSON.stringify(predator.stats.mounts), 'weapon.mounts copied from the catalog');
  ok(pred.accessories?.length === 1 && pred.accessories[0].catalogId === sgInternal.id && pred.accessories[0].included && pred.accessories[0].effects?.smartgun, 'included smartgun installed');
  let nw = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: laser.id, target: { itemId: pred.id } }] });
  await settle();
  let pw = A(jane, 'pc_jane').weapons.find((x) => x.id === pred.id)!;
  const las = pw.accessories!.find((x) => x.catalogId === laser.id)!;
  ok(r.total === laser.cost && A(jane, 'pc_jane').nuyen === nw - laser.cost, 'accessory priced from the catalog');
  ok(las && las.mount === 'Top' && las.effects?.accuracy === 1 && las.paid === laser.cost, 'laser on the Top mount (Predator has no Under mount), accuracy +1');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: scope.id, target: { itemId: pred.id } }] }), /No free mount/, 'Top already taken → scope refused');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: bipod.id, target: { itemId: pred.id } }] }), /No free mount/, 'no Under mount on the Predator');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: laser.id, target: { itemId: pred.id } }] }), /already installed/, 'same accessory twice refused');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: silencer.id, target: { itemId: colt.id } }, { ref: find('accessories', 'Gas-Vent 2 System').id, target: { itemId: colt.id } }] }), /No free mount/, 'two Barrel accessories in one cart refused');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: scope.id, target: { itemId: colt.id } }, { ref: silencer.id, target: { itemId: colt.id } }] });
  await settle();
  const cw = A(jane, 'pc_jane').weapons.find((x) => x.id === colt.id)!;
  ok(r.total === scope.cost + silencer.cost && cw.accessories!.map((x) => x.mount).sort().join() === 'Barrel,Top', 'two accessories on two mounts in one cart');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: find('weapons', 'Colt America L36').id });
  await settle();
  const colt2 = A(jane, 'pc_jane').weapons.filter((x) => x.name === colt.name).find((x) => x.id !== colt.id)!;
  nw = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: sgInternal.id, target: { itemId: colt2.id } }] });
  await settle();
  ok(r.total === find('weapons', 'Colt America L36').cost, '« Weapon Cost » formula: internal smartgun = the weapon price');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: find('weapons', 'Combat Knife').id });
  await settle();
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: laser.id, target: { itemId: A(jane, 'pc_jane').weapons.find((x) => x.kind === 'melee')!.id } }] }), /mount|fit/, 'no accessory on a melee weapon');
  await rejects(jane.send('shop/sell', { actorId: 'pc_jane', list: 'weapons', itemId: pred.id, subId: pred.accessories![0].id }), /Built-in/, 'included accessory not sold separately');
  nw = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'weapons', itemId: pred.id, subId: las.id });
  await settle();
  pw = A(jane, 'pc_jane').weapons.find((x) => x.id === pred.id)!;
  ok(r.total === Math.round(laser.cost / 2) && A(jane, 'pc_jane').nuyen === nw + r.total && !pw.accessories!.some((x) => x.id === las.id), 'accessory sold at the sell rate');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: scope.id, target: { itemId: pred.id } }] });
  ok(r.status === 'done', 'freed mount reusable');

  console.log('• armor modifications: capacity');
  const chem = find('armormods', 'Chemical Protection');
  const fire = find('armormods', 'Fire Resistance');
  const insul = find('armormods', 'Insulation');
  const gel = find('armormods', 'Gel Packs');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: jacket.id });
  await settle();
  const jk = A(jane, 'pc_jane').armor.filter((x) => x.catalogId === jacket.id).pop()!;
  ok(jk.capacity === 12, 'armor capacity copied from the catalog');
  nw = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: chem.id, rating: 6, target: { itemId: jk.id } }, { ref: fire.id, rating: 5, target: { itemId: jk.id } }] });
  await settle();
  let ja2 = A(jane, 'pc_jane').armor.find((x) => x.id === jk.id)!;
  ok(r.total === 6 * 250 + 5 * 250 && ja2.mods!.length === 2 && ja2.mods!.reduce((s, m) => s + m.capacity, 0) === 11, 'rated mods priced by formula, capacity 6 + 5');
  ok(ja2.mods!.find((m) => m.catalogId === fire.id)!.bonus?.fire === 5, 'mod bonus evaluated at its rating');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: insul.id, rating: 2, target: { itemId: jk.id } }] }), /Not enough capacity/, 'capacity exceeded');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: insul.id, rating: 1, target: { itemId: jk.id } }, { ref: gel.id, target: { itemId: jk.id } }] });
  await settle();
  ja2 = A(jane, 'pc_jane').armor.find((x) => x.id === jk.id)!;
  ok(r.status === 'done' && ja2.mods!.length === 4 && ja2.mods!.find((m) => m.catalogId === gel.id)!.effects?.armor === 2 && ja2.rating === 12, 'last capacity point used; armor bonus stored as effects (rating unchanged)');
  await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'armor', itemId: jk.id, patch: { equipped: true } });
  await settle();
  ok(armorTotal(A(jane, 'pc_jane')) === 14, `bought Gel Packs count in the Armor value: 12 + 2 (got ${armorTotal(A(jane, 'pc_jane'))})`);
  await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'armor', itemId: jk.id, patch: { equipped: false } });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: chem.id, target: { itemId: A(jane, 'pc_jane').weapons[0].id } }] }), /not found/, 'armor mod needs an armor');

  console.log('• vehicle modifications: slots, target-based prices');
  const scoot = find('vehicles', 'Dodge Scoot (Scooter)');
  const smug = find('vehiclemods', 'Smuggling Compartment');
  const armorStd = find('vehiclemods', 'Armor (Standard)');
  const offroad = find('vehiclemods', 'Off-Road Suspension');
  const gecko = find('vehiclemods', 'Gecko Tips');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: scoot.id });
  await settle();
  const sc = A(jane, 'pc_jane').vehicles.find((x) => x.catalogId === scoot.id)!;
  const rigger = find('vehiclemods', 'Rigger Interface');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: offroad.id, target: { itemId: sc.id } }, { ref: rigger.id, target: { itemId: sc.id } }] });
  await settle();
  let sv = A(jane, 'pc_jane').vehicles.find((x) => x.id === sc.id)!;
  ok(r.total === scoot.cost * 0.25 + rigger.cost, `« Vehicle Cost » formula: off-road = 25 % of the vehicle (${r.total})`);
  ok(sv.mods!.length === 2 && sv.mods!.reduce((s, m) => s + m.slots, 0) === 2 && sv.mods!.find((m) => m.catalogId === offroad.id)!.effects?.handling === -1, 'slots and effects stored');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: gecko.id, target: { itemId: sc.id } }] }), /Not enough slots.*4 needed, 2 free/, 'Body formula: gecko tips need 4 slots on Body 4, 2 free');
  // R5: one pool per category (Body 4 each on the scooter): the Body and Protection pools are still empty.
  await gm.send('shop/give', { actorId: 'pc_jane', ref: smug.id, target: { itemId: sc.id } });
  await settle();
  await rejects(gm.send('shop/give', { actorId: 'pc_jane', ref: find('vehiclemods', 'Workshop').id, target: { itemId: sc.id } }), /Not enough slots.*6 needed, 1 free/, 'Body pool: smuggling compartment 3/4, workshop (6) refused');
  await rejects(gm.send('shop/give', { actorId: 'pc_jane', ref: armorStd.id, rating: 3, target: { itemId: sc.id } }), /Not enough slots.*6 needed, 4 free/, 'GM gifts still respect slots (Protection pool 4)');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: armorStd.id, rating: 1, target: { itemId: sc.id } });
  await settle();
  sv = A(jane, 'pc_jane').vehicles.find((x) => x.id === sc.id)!;
  const arStd = sv.mods!.find((m) => m.catalogId === armorStd.id);
  ok(arStd && arStd.rating === 1 && arStd.slots === 2 && arStd.effects?.armor === 1, 'vehicle armor rating 1: 2 slots, +1 armor');
  r = await gm.send('shop/give', { actorId: 'pc_jane', items: [{ ref: offroad.id, target: { itemId: sc.id } }] }).catch((e) => e);
  ok(/already installed|Not enough slots/.test(r?.message || ''), 'same mod twice refused');

  console.log('• martial arts (karma, GM gifts — players learn them through training: tools/test-training.ts)');
  const ma = cat('martialarts').find((m) => m.name === 'Krav Maga') || cat('martialarts')[0];
  const [t1, t2] = ma.stats.techniques;
  await rejects(jane.send('shop/martialArt', { actorId: 'pc_jane', styleId: ma.id, techniqueIds: [t1.id] }), /GM/, 'players cannot get a martial art from the shop directly');
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { karma: 20 } });
  await rejects(gm.send('shop/martialArt', { actorId: 'pc_jane', styleId: 'nope' }), /Unknown martial art/, 'unknown style');
  r = await gm.send('shop/martialArt', { actorId: 'pc_jane', styleId: ma.id, techniqueIds: [t1.id, t2.id] });
  await settle();
  let jm = A(jane, 'pc_jane').martialArts?.find((m) => m.catalogId === ma.id);
  ok(r.status === 'done' && r.karma === 12 && jm && jm.techniques.length === 2 && A(jane, 'pc_jane').karma === 8 && A(jane, 'pc_jane').history.some((h) => h.karma === -12), 'GM grant: style 7 (first technique included) + 5, learned at once');
  await rejects(gm.send('shop/martialArt', { actorId: 'pc_jane', styleId: ma.id, techniqueIds: [t1.id] }), /Nothing new/, 'known techniques refused');
  if (ma.stats.techniques[2]) {
    r = await gm.send('shop/martialArt', { actorId: 'pc_jane', styleId: ma.id, techniqueIds: [ma.stats.techniques[2].id], free: true });
    await settle();
    jm = A(jane, 'pc_jane').martialArts.find((m) => m.catalogId === ma.id);
    ok(jm!.techniques.length === 3 && A(jane, 'pc_jane').karma === 8, 'GM free grant of a technique');
  }
  const hapsumDo = cat('martialarts').find((m) => /Hapsum-Do/.test(m.name));
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { karma: 30 } });
  r = await gm.send('shop/martialArt', { actorId: 'pc_jane', styleId: hapsumDo.id, techniqueIds: [hapsumDo.stats.techniques[0].id] });
  await settle();
  ok(r.karma === 15 && A(jane, 'pc_jane').karma === 15, `catalog style cost: Hapsum-Do 15 karma (got ${r.karma})`);
  const bare = cat('martialarts').find((m) => m.stats.karma === 7 && m.id !== ma.id && m.stats.techniques.length >= 2 && m.stats.techniques.every((x: { id?: string }) => x.id));
  await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'martialArts', item: { name: bare.name, catalogId: bare.id, rating: 1, techniques: [] } });
  await settle();
  r = await gm.send('shop/martialArt', { actorId: 'pc_jane', styleId: bare.id, techniqueIds: [bare.stats.techniques[0].id, bare.stats.techniques[1].id] });
  ok(r.karma === 5, `known style without technique (import): first technique included, 2 techniques = 5 karma (got ${r.karma})`);

  console.log('• markup');
  await gm.send('shop/updateSettings', { markup: 20 });
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  ok(r.total === 1200, 'markup +20%');
  await gm.send('shop/clearOrders');
  await settle();
  ok(gm.state.shop.orders.every((o) => o.status === 'pending'), 'clearOrders keeps pending only');

  console.log('• availability test');
  await gm.send('shop/updateSettings', { markup: 0, availTest: 'required', approval: 'restricted' });
  await settle();
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /availability test/, 'required: no purchase without a successful test');
  await rejects(jane.send('shop/availTest', { actorId: 'pc_bricks', item: { ref: jacket.id } }), /your character/, 'cannot search for another runner');
  const sp0 = jane.state.shop.specials.find((x) => x.stock === null || x.stock === undefined || x.stock > 0);
  await rejects(jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: `special:${sp0!.id}` } }), /no availability test/, 'fixer specials need no test');
  // Jane: Negotiation defaults to CHA 8 − 1 = 7 dice vs Availability 2 — retry until found (bounded).
  let at: AvailTestResult;
  let tries = 0;
  do {
    at = await jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id } });
    tries++;
  } while (!at.found && tries < 30);
  await settle();
  ok(at.found && at.net === at.hits - at.availHits && at.baseHours === 24 && at.delayHours === (at.net > 0 ? Math.round((24 / at.net) * 100) / 100 : 48), `test outcome (${JSON.stringify(at)})`);
  ok(at.tries === tries, `attempt counter (${at.tries} / ${tries})`);
  const rollE = gm.state.log.find((e) => e.id === at.logId);
  ok(rollE?.kind === 'roll' && rollE.roll!.avail?.value === 2 && rollE.roll!.avail.dice.length === 2 && rollE.roll!.labelI18n?.key === 'Availability — {item}', `roll logged with the Availability dice (${rollE?.roll?.breakdown})`);
  ok(rollE!.roll!.pool === 7 && rollE!.roll!.limitLabel === 'social', `Negotiation default pool 7, Social limit (${rollE!.roll!.pool}, ${rollE!.roll!.limitLabel})`);
  ok(jane.state.shop.availTests.some((x) => x.id === at.testId) && !bricks.state.shop.availTests.some((x) => x.id === at.testId), 'tests visible to their owner only');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  await settle();
  const ord = gm.state.shop.orders.find((o) => o.id === r.orderId)!;
  ok(r.status === 'done' && ord.items[0].availTest?.id === at.testId && ord.items[0].availTest.delayHours === at.delayHours, 'purchase with the test: delay on the order line');
  ok(r.notes.some((n: string) => /found in/.test(n)), `delay note (${r.notes.join(' | ')})`);
  ok(gm.state.shop.availTests.find((x) => x.id === at.testId)!.status === 'used', 'test used by the purchase');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /availability test/, 'one test = one purchase');
  // Pending order (restricted): cancelling or denying gives the search back.
  tries = 0;
  do at = await jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: katana.id } });
  while (!at.found && ++tries < 30);
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await settle();
  ok(r.status === 'pending' && gm.state.shop.availTests.find((x) => x.id === at.testId)!.status === 'used', 'pending order holds the test');
  await jane.send('shop/cancel', { orderId: r.orderId });
  await settle();
  ok(gm.state.shop.availTests.find((x) => x.id === at.testId)!.status === 'open', 'cancelled order releases the test');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await gm.send('shop/resolve', { orderId: r.orderId, approve: false });
  await settle();
  ok(gm.state.shop.availTests.find((x) => x.id === at.testId)!.status === 'open', 'denied order releases the test');
  // A contact searches instead (SR5: the contact's Charisma + Negotiation, Social limit + Connection). Stats: bestiary template of the same name.
  const tpl = Object.values(gm.state.bestiary || {}).find((x) => x?.name === 'Perrine Cabana')!;
  ok(!!tpl, 'bestiary has Perrine Cabana (Foundry seed)');
  await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'contacts', item: { name: 'Perrine Cabana', connection: 2, loyalty: 4 } });
  await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'contacts', item: { name: 'Contact Sans Fiche', connection: 3, loyalty: 1 } });
  await settle();
  const cs = jane.state.shop.contactSearch?.pc_jane || [];
  const cab = cs.find((c) => c.name === 'Perrine Cabana');
  const nobody = cs.find((c) => c.name === 'Contact Sans Fiche');
  const tplNeg = (tpl.skills || []).find((s) => s.id === 'negotiation')?.rating || 0;
  const tplSocial = Math.ceil((tpl.attributes.CHA * 2 + tpl.attributes.WIL + Math.ceil(tpl.attributes.ESS ?? 6)) / 3);
  ok(cab?.known && cab.pool === tpl.attributes.CHA + tplNeg && cab.limit === tplSocial + 2, `contact stats from the bestiary (${JSON.stringify(cab)})`);
  ok(nobody && !nobody.known && !('pool' in nobody), 'contact without stats listed as unknown');
  ok(!bricks.state.shop.contactSearch?.pc_jane, 'contact search info private to the runner’s player');
  ok(!('contactSearch' in (jane.state.bestiary || {})) && !jane.state.bestiary, 'bestiary still hidden from players');
  await rejects(jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id }, contactId: nobody!.id }), /has no stats/, 'contact without stats cannot search');
  await rejects(jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id }, contactId: 'nope' }), /Contact not found/, 'unknown contact');
  const edgeBefore = A(jane, 'pc_jane').edge.current;
  tries = 0;
  do at = await jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id }, contactId: cab!.id, explode: true });
  while (!at.found && ++tries < 30);
  await settle();
  const cRoll = gm.state.log.find((e) => e.id === at.logId)?.roll!;
  ok(at.found && cRoll.pool === cab!.pool && cRoll.limit === cab!.limit && !cRoll.explode && cRoll.avail!.contact === 'Perrine Cabana' && cRoll.labelI18n!.key === 'Availability — {item} (via {contact})', `contact roll: their pool and limit, no runner Edge (${cRoll?.breakdown} [${cRoll?.limitBreakdown}])`);
  ok(A(jane, 'pc_jane').edge.current === edgeBefore && gm.state.shop.availTests.find((x) => x.id === at.testId)?.contactName === 'Perrine Cabana', 'test records the contact');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  await settle();
  ok(r.status === 'done' && gm.state.shop.orders.find((o) => o.id === r.orderId)!.items[0].availTest!.contact === 'Perrine Cabana', 'order line says who found it');

  // Throwing money at it (SR5 p. 418): +1 die per extra 25 % of the price (max 12), paid on purchase only.
  tries = 0;
  do at = await jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id }, overpay: 4 });
  while (!at.found && ++tries < 30);
  await settle();
  const oRoll = gm.state.log.find((e) => e.id === at.logId)?.roll!;
  ok(at.overpay === 4 && oRoll.pool === 7 + 4 && /overpay \+4/.test(oRoll.breakdown!), `bought dice in the pool (${oRoll?.breakdown})`);
  const nuyenBefore = A(gm, 'pc_jane').nuyen;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  await settle();
  const oOrd = gm.state.shop.orders.find((o) => o.id === r.orderId)!;
  ok(r.status === 'done' && r.total === 2000 && oOrd.items[0].surcharge === 1000 && oOrd.items[0].unitCost === 1000, `+100 % surcharge charged (${r.total})`);
  ok(A(gm, 'pc_jane').nuyen === nuyenBefore - 2000, 'nuyen debited with the surcharge');
  ok(r.notes.some((n: string) => /overpay/.test(n)), `surcharge note (${r.notes.join(' | ')})`);
  const boughtJacket = A(gm, 'pc_jane').armor.filter((x) => x.catalogId === jacket.id).pop()!;
  ok(boughtJacket.paid === 1000, 'resale value stays the item price');
  const capped = await jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id }, overpay: 99, contactId: cab!.id });
  await settle();
  ok(capped.overpay === 12 && gm.state.log.find((e) => e.id === capped.logId)!.roll!.pool === cab!.pool! + 12, 'overpay capped at 12 dice (contact roll too)');

  // Threshold, helper mode, GM, off.
  await gm.send('shop/updateSettings', { availFree: 2 });
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  ok(r.status === 'done', 'Availability at or under the threshold: no test');
  await gm.send('shop/updateSettings', { availFree: 0, availTest: 'helper' });
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  ok(r.status === 'done', 'helper mode: buying without a test');
  await gm.send('shop/updateSettings', { availTest: 'required' });
  r = await gm.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  ok(r.status === 'done', 'GM sale: no test');
  await rejects(gm.send('shop/updateSettings', { availTest: 'bogus' }), /Unknown availability test mode/, 'unknown mode refused');
  await gm.send('shop/updateSettings', { availTest: 'off' });
  await rejects(jane.send('shop/availTest', { actorId: 'pc_jane', item: { ref: jacket.id } }), /No availability tests/, 'off: no test for players');
  await settle();
  const availRolls = gm.state.log.filter((e) => e.roll?.labelI18n).map((e) => ({ i18n: e.roll!.labelI18n, text: e.roll!.label }));
  ok(availRolls.every((x) => /^Availability — /.test(x.text!)), 'English availability label (stored)');
  const availFr = await renderI18n(availRolls, 'availability roll label');
  ok(availFr.every((x) => /^Disponibilité — /.test(x)), 'French availability label');

  console.log('• i18n');
  const shopLog = gm.state.log.filter((e) => e.kind === 'shop');
  ok(shopLog.some((x) => / buys: /.test(x.text)), 'English shop log (stored)');
  const shopFr = await renderI18n(shopLog, 'shop log');
  ok(shopFr.some((x) => / achète/.test(x)), 'French shop log');
  const hist = Object.values(gm.state.actors).flatMap((a) => (a.history || []).filter((h) => h.i18n));
  ok(hist.some((x) => /^Purchase: /.test(x.text || '')), 'English purchase history (stored)');
  const histFr = await renderI18n(hist, 'shop history');
  ok(histFr.some((x) => /^Achat/.test(x)), 'French purchase history');

  const errors = srv.output().split('\n').filter((l) => /\[action|Error|failed/i.test(l));
  ok(!errors.length, `no server errors: ${errors.join(' | ')}`);
  gm.close();
  jane.close();
  bricks.close();
} catch (err) {
  failures++;
  console.error('Test crashed:', err);
  console.error(srv.output());
} finally {
  srv.stop();
}
console.log(`\n${passes} ok, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
