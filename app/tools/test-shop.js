// Shop module test: node tools/test-shop.js  (isolated server on port 3104, exit code != 0 on failure)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, client, settle } from './test-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3104;

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
const cat = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', `${name}.json`), 'utf8'));
const find = (file, name) => {
  const it = cat(file).find((x) => x.name === name);
  if (!it) throw new Error(`catalog item not found: ${file}/${name}`);
  return it;
};

// Test actors (the state is pre-seeded so the test does not depend on the characters seeds).
const baseActor = (id, name, extra) => ({
  id, type: 'pc', name, metatype: 'Humain',
  attributes: { BOD: 3, AGI: 5, REA: 5, STR: 3, WIL: 3, LOG: 4, INT: 5, CHA: 5, EDG: 3, ESS: 6 },
  condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 3 },
  skills: [], knowledge: [], qualities: [], powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [],
  contacts: [], sins: [], karma: 0, karmaTotal: 0, nuyen: 0, streetCred: 0, notoriety: 0, publicAwareness: 0, history: [],
  ...extra,
});

async function startWithState(state) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-shop-'));
  fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify(state));
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), SR_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
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
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗', msg);
  }
}
async function rejects(promise, re, msg) {
  try {
    await promise;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(re.test(e.message), `${msg} — got: ${e.message}`);
  }
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

const srv = await startWithState(state);
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const jane = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  const bricks = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  await settle();
  const A = (c, id) => c.state.actors[id];

  console.log('• defaults & seeds');
  const shop = gm.state.shop;
  ok(shop && shop.open === true && shop.markup === 0 && shop.sellRate === 50 && shop.maxAvail === 12, 'default settings');
  ok(shop.approval === 'restricted' && shop.allowRestricted === true && shop.allowForbidden === false, 'default legality/approval');
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
  const arm = A(jane, 'pc_jane').armor.find((a) => a.catalogId === jacket.id);
  ok(arm && arm.rating === 12 && arm.paid === 1000 && arm.equipped === false, 'armor added with rating & paid price');
  ok(A(jane, 'pc_jane').history.some((h) => h.nuyen === -1000), 'history entry');
  ok(jane.state.log.some((e) => e.kind === 'shop' && /Jane achète/.test(e.text)), 'shop log entry visible to buyer');
  ok(!bricks.state.log.some((e) => e.kind === 'shop' && /Jane achète/.test(e.text)), 'shop log entry private from other player');
  ok(jane.events.some((e) => e.ev === 'sfx' && e.data.id === 'cash'), 'cash sfx emitted');

  console.log('• pending purchase (restricted) + GM approval');
  const katana = find('weapons', 'Katana');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await settle();
  ok(r.status === 'pending', 'restricted item creates a pending order');
  ok(A(jane, 'pc_jane').nuyen === 99000, 'nuyen not deducted while pending');
  const pend = gm.state.shop.orders.find((o) => o.id === r.orderId);
  ok(pend && pend.status === 'pending' && pend.flags.includes('restricted'), 'GM sees pending order with flags');
  ok(jane.state.shop.orders.some((o) => o.id === r.orderId), 'buyer sees own order');
  ok(!bricks.state.shop.orders.some((o) => o.id === r.orderId), 'other player does not see the order');
  await rejects(jane.send('shop/resolve', { orderId: r.orderId, approve: true }), /MJ/, 'player cannot resolve');
  await gm.send('shop/resolve', { orderId: r.orderId, approve: true, note: 'Cabana te fait un clin d’œil' });
  await settle();
  const w = A(jane, 'pc_jane').weapons.find((x) => x.catalogId === katana.id);
  ok(w && w.skill === 'blades' && w.kind === 'melee' && w.damage === '(STR+3)P' && w.ap === -3, 'katana added with weapon stats');
  ok(A(jane, 'pc_jane').nuyen === 98000, 'nuyen deducted on approval');
  ok(gm.state.shop.orders.find((o) => o.id === r.orderId).status === 'approved', 'order approved');
  await rejects(gm.send('shop/resolve', { orderId: r.orderId, approve: true }), /déjà/, 'cannot resolve twice');

  console.log('• deny & cancel');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await gm.send('shop/resolve', { orderId: r.orderId, approve: false, note: 'Rupture de stock' });
  await settle();
  const denied = jane.state.shop.orders.find((o) => o.id === r.orderId);
  ok(denied.status === 'denied' && denied.gmNote === 'Rupture de stock', 'denied with note');
  ok(A(jane, 'pc_jane').nuyen === 98000, 'no charge on deny');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: katana.id }] });
  await rejects(bricks.send('shop/cancel', { orderId: r.orderId }), /ta commande/, 'other player cannot cancel');
  await jane.send('shop/cancel', { orderId: r.orderId });
  await settle();
  ok(jane.state.shop.orders.find((o) => o.id === r.orderId).status === 'cancelled', 'owner cancels pending order');

  console.log('• legality, availability, funds, ownership');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: find('weapons', 'Ares Alpha').id }] }), /interdit/, 'forbidden item blocked');
  await gm.send('shop/updateSettings', { allowForbidden: true });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: find('weapons', 'Ranger Arms SM-5').id }] }), /disponibilité 16/, 'availability limit enforced');
  await rejects(bricks.send('shop/buy', { actorId: 'pc_bricks', items: [{ ref: find('gear', 'Hermes Chariot').id }] }), /Fonds insuffisants/, 'insufficient funds');
  await rejects(bricks.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /pas ton personnage/, 'cannot buy for someone else');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'nope' }] }), /inconnu/, 'unknown item');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id, qty: -3 }] }), /Quantité/, 'bad quantity');
  await rejects(jane.send('shop/updateSettings', { open: false }), /MJ/, 'player cannot change settings');
  await gm.send('shop/updateSettings', { categories: { armor: false } });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /rayon fermé/, 'disabled category');
  await gm.send('shop/updateSettings', { categories: { armor: true }, open: false });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] }), /joignable/, 'shop closed');
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
  const aug = jn.augmentations.find((a) => a.catalogId === wired.id);
  ok(aug && aug.grade === 'alpha' && Math.abs(aug.essence - 1.6) < 1e-6, 'alphaware essence 2 × 0.8 = 1.6');
  ok(Math.abs(jn.attributes.ESS - 4.4) < 1e-6, 'ESS reduced to 4.4');
  ok(jn.attributes.MAG === 3, 'MAG reduced by 2 (essence loss 1.6 → 2 points)');
  ok(jn.nuyen === before - 46800, 'alphaware cost ×1.2');
  ok(jn.augmented?.REA === 1 && jn.initiative?.dice === 2, 'wired reflexes bonus applied');
  await gm.send('shop/updateSettings', { maxAvail: 24 });
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: wired.id, rating: 3 }] }), /Essence insuffisante/, 'essence guard (4.4 − 5 would kill)');
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
  const mk3 = A(jane, 'pc_jane').gear.find((g) => g.catalogId === medkit.id && g.rating === 3);
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'gear', itemId: mk3.id, qty: 2 });
  await settle();
  ok(r.total === 750 && A(jane, 'pc_jane').nuyen === n1 + 750 && A(jane, 'pc_jane').gear.find((g) => g.id === mk3.id).qty === 1, 'partial gear sale');
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'augmentations', itemId: aug.id });
  await settle();
  const ja = A(jane, 'pc_jane');
  ok(!ja.augmentations.length && !ja.augmented?.REA && ja.initiative.dice === 1, 'augmentation sold, bonus removed');
  ok(Math.abs(ja.attributes.ESS - 4.4) < 1e-6, 'essence hole stays');
  await gm.send('shop/updateSettings', { approval: 'always' });
  const katanaItem = ja.weapons.find((x) => x.catalogId === katana.id);
  r = await jane.send('shop/sell', { actorId: 'pc_jane', list: 'weapons', itemId: katanaItem.id });
  ok(r.status === 'pending', 'sale pending when approval = always');
  await rejects(jane.send('shop/sell', { actorId: 'pc_jane', list: 'weapons', itemId: katanaItem.id }), /attend déjà/, 'no duplicate pending sale');
  const n2 = A(jane, 'pc_jane').nuyen;
  await gm.send('shop/resolve', { orderId: r.orderId, approve: true, total: 700 });
  await settle();
  ok(A(jane, 'pc_jane').nuyen === n2 + 700 && !A(jane, 'pc_jane').weapons.some((x) => x.id === katanaItem.id), 'GM approves sale with negotiated price');
  await gm.send('shop/updateSettings', { approval: 'never' });

  console.log('• specials');
  const fb = () => gm.state.shop.specials.find((s) => s.id === 'cabana-flashbang');
  const stock0 = fb().stock;
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-flashbang', qty: 2 }] });
  await settle();
  ok(r.total === 180 && fb().stock === stock0 - 2, 'special bought, stock decremented');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-flashbang', qty: 50 }] }), /stock/, 'stock limit');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-badge-hollow-pine' }] }), /n’existe plus/, 'hidden special not purchasable by players');
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: 'special:cabana-apds' }] });
  await settle();
  ok(A(jane, 'pc_jane').gear.find((g) => g.name.startsWith('Munitions APDS'))?.qty === 10, 'pack special adds 10 rounds');
  const { id: newId } = await gm.send('shop/addSpecial', { fromRef: jacket.id, cost: 800, stock: 1, forActorIds: ['pc_bricks'] });
  await settle();
  ok(gm.state.shop.specials.find((s) => s.id === newId)?.cost === 800, 'GM creates special from catalog');
  ok(!jane.state.shop.specials.some((s) => s.id === newId) && bricks.state.shop.specials.some((s) => s.id === newId), 'reserved special only visible to its runner');
  await rejects(jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: `special:${newId}` }] }), /réservée/, 'reserved special blocked for others');
  await gm.send('shop/updateSpecial', { id: newId, patch: { cost: 400, notes: 'Promo' } });
  r = await bricks.send('shop/buy', { actorId: 'pc_bricks', items: [{ ref: `special:${newId}` }] });
  await settle();
  ok(r.total === 400 && A(bricks, 'pc_bricks').armor.some((a) => a.rating === 12 && a.paid === 400), 'special mapped to armor with catalog stats');
  ok(gm.state.shop.specials.find((s) => s.id === newId).stock === 0, 'stock now 0');
  await gm.send('shop/removeSpecial', { id: 'cabana-trauma-patch' });
  await settle();
  ok(!gm.state.shop.specials.some((s) => s.id === 'cabana-trauma-patch'), 'special removed');

  console.log('• GM sale & gift, matrix device, lifestyle');
  const caliban = find('gear', 'Fairlight Caliban');
  await rejects(gm.send('shop/buy', { actorId: 'pc_bricks', items: [{ ref: caliban.id }] }), /Fonds insuffisants/, 'GM sale still needs funds');
  await gm.send('shop/give', { actorId: 'pc_bricks', ref: caliban.id, setMatrix: true });
  await settle();
  const b = A(bricks, 'pc_bricks');
  ok(b.nuyen === 100 && b.gear.some((g) => g.catalogId === caliban.id && g.paid === undefined), 'gift is free');
  ok(b.matrix.device === 'Fairlight Caliban' && b.matrix.rating === 7 && b.matrix.firewall === 7 && b.matrix.programs.includes('Browse'), 'matrix device set, programs kept');
  const exploit = cat('programs').find((p) => p.name === 'Exploit');
  await gm.send('shop/give', { actorId: 'pc_bricks', ref: exploit.id });
  await settle();
  ok(A(bricks, 'pc_bricks').matrix.programs.includes(exploit.nameFr || exploit.name), 'program added to matrix programs');
  const low = cat('lifestyles').find((l) => l.name === 'Low');
  await gm.send('shop/give', { actorId: 'pc_jane', ref: low.id, qty: 1 });
  await settle();
  ok(A(jane, 'pc_jane').lifestyle?.monthlyCost === 2000 && A(jane, 'pc_jane').lifestyle.monthsPaid === 1, 'lifestyle set');
  const n3 = A(jane, 'pc_jane').nuyen;
  r = await jane.send('shop/payLifestyle', { actorId: 'pc_jane', months: 2 });
  await settle();
  ok(r.monthsPaid === 3 && A(jane, 'pc_jane').nuyen === n3 - 4000, 'pay lifestyle');
  await rejects(bricks.send('shop/payLifestyle', { actorId: 'pc_bricks', months: 1 }), /train de vie/, 'no lifestyle → error');
  await rejects(jane.send('shop/payLifestyle', { actorId: 'pc_jane', months: 500 }), /mois/, 'months bounded');

  console.log('• markup');
  await gm.send('shop/updateSettings', { markup: 20 });
  r = await jane.send('shop/buy', { actorId: 'pc_jane', items: [{ ref: jacket.id }] });
  ok(r.total === 1200, 'markup +20%');
  await gm.send('shop/clearOrders');
  await settle();
  ok(gm.state.shop.orders.every((o) => o.status === 'pending'), 'clearOrders keeps pending only');

  console.log('• i18n');
  const shopEn = await renderI18n(gm.state.log.filter((e) => e.kind === 'shop'), 'shop log');
  ok(shopEn.some((x) => / buys: /.test(x)), 'English shop log');
  const hist = Object.values(gm.state.actors).flatMap((a) => (a.history || []).filter((h) => h.i18n));
  const histEn = await renderI18n(hist, 'shop history');
  ok(histEn.some((x) => /^Purchase: /.test(x)), 'English purchase history');

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
console.log(`\n${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
