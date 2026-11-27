// Tests for the Chummer5a interop (server/lib/chummer/*, server/modules/85-chummer.js) — run: node tools/test-chummer.ts
// Also writes tools/fixtures/export-sample-jane.chum5 and tools/fixtures/export-roundtrip-test.chum5 (to open in Chummer).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
import { startServer, login, client, settle } from './test-client.ts';
import { parseXml, serializeXml, el } from '../server/lib/chummer/xml.ts';
import { parseChum5 } from '../server/lib/chummer/parse.ts';
import { exportChum5 } from '../server/lib/chummer/export.ts';
import { mergeActor, diffActors } from '../server/lib/chummer/merge.ts';
import { t as tr, dictionary } from '../server/lib/i18n.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'chummer-test.chum5');
const OUT_JANE = path.join(ROOT, 'tools', 'fixtures', 'export-sample-jane.chum5');
const OUT_RT = path.join(ROOT, 'tools', 'fixtures', 'export-roundtrip-test.chum5');
const src = fs.readFileSync(FIXTURE, 'utf8');
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8'));
const COLT = '6366691e-c1e0-4d5e-b7a6-1c0371708714';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name, '\n     ', err.stack?.split('\n').slice(0, 3).join('\n      ') || err.message);
  }
}
const wellFormed = (xml) => {
  const v = XMLValidator.validate(xml.replace(/^﻿/, ''), { allowBooleanAttributes: false });
  assert.equal(v, true, JSON.stringify(v));
  new XMLParser({ ignoreAttributes: false }).parse(xml);
};
const topNames = (xml) => parseXml(xml).root.elements.map((e) => e.name);
const clone = (x) => JSON.parse(JSON.stringify(x));
const count = (xml, tag) => (xml.match(new RegExp(`<${tag}>`, 'g')) || []).length;

console.log('XML layer');
await test('fixture round-trips byte for byte through the DOM', () => {
  const doc = parseXml(src);
  assert.equal(doc.bom, true);
  assert.equal(serializeXml(doc, { bom: true }), src);
});
await test('malformed XML is rejected with a French message', () => {
  assert.throws(() => parseXml('<character><a></b></character>'), /XML invalide/);
  assert.throws(() => parseChum5('<root/>'), /pas une fiche Chummer/);
  assert.throws(() => parseChum5('<character><name>x</character>'), /illisible/);
});

console.log('Import (.chum5 → actor)');
const imported = parseChum5(src, { fileName: 'chummer-test.chum5' });
const fx = imported.actor;
await test('fixture: identity, attributes, skills, weapon', () => {
  assert.equal(fx.name, 'Test Chummer');
  assert.equal(fx.metatype, 'Humain');
  assert.deepEqual([fx.attributes.BOD, fx.attributes.AGI, fx.attributes.REA, fx.attributes.INT, fx.attributes.WIL], [4, 5, 4, 4, 3]);
  assert.equal(fx.attributes.MAG, 4);
  assert.equal(fx.attributes.EDG, 2);
  assert.equal(fx.attributes.ESS, 6);
  assert.equal(fx.skills.find((s) => s.id === 'disguise').rating, 6); // Stealth group 6
  assert.equal(fx.skills.find((s) => s.id === 'aeronautics_mechanic').rating, 2); // free priority rating (SkillBase improvement)
  const colt = fx.weapons.find((w) => w.name === 'Colt Government 2066');
  assert.ok(colt);
  assert.equal(colt.catalogId, COLT);
  assert.equal(colt.damage, '7P');
  assert.equal(colt.ap, -1);
  assert.equal(colt.skill, 'pistols');
  assert.equal(colt.chummerGuid, '90db7564-dcb4-4391-854d-1ec77e7a3d28');
  const unarmed = fx.weapons.find((w) => w.name === 'Mains nues');
  assert.ok(unarmed && unarmed.skill === 'unarmed_combat' && unarmed.damage === '(STR)S', 'Unarmed Attack → Mains nues');
  assert.equal(unarmed.accuracy, 'Physical', 'accuracy = the physical limit, kept as « Physical » (follows STR / BOD / REA and its modifiers)');
  assert.equal(fx.weapons.length, 2);
  assert.equal(fx.qualities[0].karma, 20);
  assert.equal(fx.nuyen, 6000);
  assert.equal(imported.info.created, false);
  assert.equal(fx.chummer.fileName, 'chummer-test.chum5');
  assert.ok(fx.chummer.xml.startsWith('<?xml'));
});

console.log('Export: patch mode (original file kept)');
await test('unchanged actor exports the original file unchanged', () => {
  const r = exportChum5(clone(fx));
  assert.equal(r.mode, 'patch');
  assert.equal(r.xml, src.replace(/^﻿/, ''));
});
await test('round trip: karma, nuyen, skills, attributes, items added/removed, unknown nodes kept', () => {
  const a = clone(fx);
  a.karma = 12;
  a.karmaTotal = 12;
  a.nuyen = 5000;
  a.attributes.AGI = 6;
  a.attributes.BOD = 3;
  a.skills.find((s) => s.id === 'disguise').rating = 7;
  a.skills.find((s) => s.id === 'sneaking').rating = 4; // below its group: the group is dissolved
  a.skills.push({ id: 'pistols', name: 'Pistolets', attr: 'AGI', rating: 3, spec: 'Revolvers' });
  a.weapons = a.weapons.filter((w) => w.catalogId !== COLT);
  a.weapons.push({ id: 'w_new', name: 'Ares Predator V', kind: 'ranged', skill: 'pistols', damage: '8P', catalogId: null });
  a.armor.push({ id: 'a_new', name: 'Veste pare-balles', rating: 12, equipped: true });
  a.gear.push({ id: 'g_new', name: 'Medkit', rating: 3, qty: 2, category: 'Biotech' });
  a.gear.push({ id: 'g_cust', name: 'Bidule maison', qty: 1, category: 'Divers' });
  a.augmentations.push({ id: 'c_new', name: 'Datajack', kind: 'cyberware', grade: 'alpha', essence: 0.08 });
  a.contacts.push({ id: 'ct_new', name: 'Perrine Cabana', role: 'Fixeuse', connection: 3, loyalty: 4 });
  a.qualities.push({ id: 'q_new', name: 'Ambidextre', karma: 4, positive: true });
  a.knowledge.push({ id: 'k_new', name: 'Gangs de Seattle', rating: 3, type: 'street' });
  a.knowledge.push({ id: 'k_lang', name: 'English', rating: 0, type: 'language', native: true });
  a.powers.push({ id: 'p_new', name: 'Réflexes améliorés', level: 2, pp: 2.5 });
  a.condition.physical = 3;
  a.condition.stun = 2;
  a.edge.current = 1;
  const r = exportChum5(a);
  wellFormed(r.xml);
  assert.equal(r.mode, 'patch');
  for (const id of ['w_new', 'a_new', 'g_new', 'c_new', 'ct_new', 'q_new', 'p_new']) assert.ok(Object.values(r.assigned).some((m) => m[id]), `guid assigned for ${id}`);
  const b = parseChum5(r.xml).actor;
  assert.equal(b.name, 'Test Chummer');
  assert.equal(b.karma, 12);
  assert.equal(b.nuyen, 5000);
  assert.equal(b.attributes.AGI, 6);
  assert.equal(b.attributes.BOD, 3);
  assert.equal(b.attributes.INT, 4);
  const sk = Object.fromEntries(b.skills.map((s) => [s.id, s]));
  assert.equal(sk.disguise.rating, 7);
  assert.equal(sk.sneaking.rating, 4);
  assert.equal(sk.palming.rating, 6, 'other Stealth skills keep their rating');
  assert.equal(sk.pistols.rating, 3);
  assert.equal(sk.pistols.spec, 'Revolvers');
  assert.equal(sk.navigation.rating, 6);
  assert.ok(!b.weapons.some((w) => w.catalogId === COLT), 'Colt removed');
  const pred = b.weapons.find((w) => /Predator V/.test(w.name));
  assert.ok(pred, 'Predator added');
  assert.equal(pred.damage, '8P');
  assert.ok(pred.catalogId, 'Predator resolved to a Chummer sourceid');
  assert.equal(pred.chummerGuid, r.assigned.weapons.w_new);
  assert.equal(b.armor[0].rating, 12);
  assert.equal(b.armor[0].equipped, true);
  assert.ok(b.armor[0].catalogId, 'armor jacket found by French name');
  assert.equal(b.gear.find((g) => /Medkit|Médikit/.test(g.name)).qty, 2);
  assert.ok(b.gear.find((g) => g.name === 'Bidule maison'), 'unknown gear exported as a renamed Custom Item');
  const dj = b.augmentations.find((x) => /Datajack/i.test(x.name));
  assert.ok(dj && dj.grade === 'alpha' && Math.abs(dj.essence - 0.08) < 1e-6, 'datajack alpha 0.08');
  assert.equal(b.contacts[0].loyalty, 4);
  assert.ok(b.qualities.some((q) => q.karma === 4 && q.positive));
  assert.equal(b.knowledge.find((k) => k.name === 'Gangs de Seattle').rating, 3);
  assert.equal(b.knowledge.find((k) => k.name === 'English').native, true);
  const ir = b.powers[0];
  assert.equal(ir.level, 2);
  assert.equal(ir.pp, 2.5);
  assert.deepEqual(b.condition, { physical: 3, stun: 2, overflow: 0 });
  assert.equal(b.edge.current, 1);
  // Unknown / untouched nodes and order preserved
  const t0 = topNames(src);
  assert.deepEqual(topNames(r.xml).filter((n) => t0.includes(n)), t0);
  for (const tag of ['settingshashcode', 'priorityskill', 'improvement', 'calculatedvalues', 'essenceatspecialstart', 'skillptsmax']) assert.equal(count(r.xml, tag), count(src, tag), tag);
  assert.ok(r.xml.includes('<created>False</created>'), 'creation mode kept');
  assert.ok(r.xml.includes('<name>Unarmed Attack</name>'));
  fs.writeFileSync(OUT_RT, '﻿' + r.xml.replace(/\r?\n/g, '\r\n'));
});

console.log('Export: generate mode (no Chummer file)');
for (const seed of seeds) {
  await test(`${seed.name}: well-formed career file, same values after re-import`, () => {
    // The sample written for Chummer carries the portrait (like the HTTP export does).
    const img = seed.id === 'pc_jane' && String(seed.portrait || '').startsWith('/assets/') ? path.join(ROOT, 'data', ...seed.portrait.split('/').filter(Boolean)) : null;
    const mugshots = img && fs.existsSync(img) ? [fs.readFileSync(img).toString('base64')] : null;
    const r = exportChum5(clone(seed), { mugshots });
    assert.equal(r.mode, 'generate');
    wellFormed(r.xml);
    assert.ok(r.xml.includes('<created>True</created>'));
    assert.ok(r.xml.includes('<appversion>5.226.0</appversion>'));
    assert.ok(r.xml.includes('<settings>223a11ff-80e0-428b-89a9-6ef1c243b8b6</settings>'));
    const b = parseChum5(r.xml).actor;
    for (const k of ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES']) assert.equal(b.attributes[k], seed.attributes[k], k);
    assert.equal(b.attributes.ESS, seed.attributes.ESS);
    for (const s of seed.skills) {
      const t = b.skills.find((x) => x.id === s.id);
      assert.ok(t, s.id);
      assert.equal(t.rating, s.rating, s.id);
      assert.equal(t.spec || '', s.spec || '', `${s.id} spec`);
    }
    assert.equal(b.karma, seed.karma);
    assert.equal(b.karmaTotal, Math.max(seed.karmaTotal, seed.karma));
    assert.equal(b.nuyen, seed.nuyen);
    assert.equal(b.streetCred, seed.streetCred || 0);
    assert.equal(b.notoriety, seed.notoriety || 0);
    assert.equal(b.name, seed.name);
    assert.equal(b.metatype, seed.metatype);
    for (const l of ['weapons', 'armor', 'augmentations', 'contacts', 'qualities', 'powers', 'spells', 'sins', 'knowledge', 'vehicles']) assert.equal((b[l] || []).length, (seed[l] || []).length, l);
    if (seed.id === 'pc_jane') fs.writeFileSync(OUT_JANE, '﻿' + r.xml.replace(/\r?\n/g, '\r\n'));
  });
}
await test('career mode: app karma/nuyen history becomes Chummer expenses; street cred stays stable', () => {
  const jane = clone(seeds.find((a) => a.id === 'pc_jane'));
  const first = exportChum5(jane);
  const a = parseChum5(first.xml, { now: 1000 }).actor; // the file as the player would import it
  const expBefore = count(first.xml, 'expense');
  a.history.push({ ts: 2000, text: 'Fin de séance', karma: 5 });
  a.karma += 5;
  a.karmaTotal += 5;
  a.history.push({ ts: 3000, text: 'Achat : Medkit', nuyen: -1500 });
  a.nuyen -= 1500;
  const r = exportChum5(a, { now: 4000 });
  wellFormed(r.xml);
  assert.equal(count(r.xml, 'expense'), expBefore + 2);
  assert.ok(r.xml.includes('<reason>Fin de séance</reason>'));
  const b = parseChum5(r.xml).actor;
  assert.equal(b.karma, a.karma);
  assert.equal(b.karmaTotal, a.karmaTotal);
  assert.equal(b.nuyen, a.nuyen);
  assert.equal(b.streetCred, a.streetCred);
});

console.log('Merge (re-import into an existing actor)');
await test('3-way merge keeps app changes, applies Chummer changes, merges karma as deltas', () => {
  const base = clone(fx); // last synced file
  const ours = clone(fx);
  ours.karma += 5; // GM reward in the app
  ours.karmaTotal += 5;
  ours.armor = [{ id: 'app_only', name: 'Casque', rating: 2, equipped: true, stack: true }]; // bought in the app, not yet exported
  ours.condition.stun = 4;
  ours.portrait = '/uploads/me.png';
  ours.training = [{ id: 't1' }];
  const theirs = clone(fx); // edited in Chummer
  theirs.karma -= 2; // spent in Chummer
  theirs.skills.find((s) => s.id === 'disguise').rating = 7;
  theirs.weapons = [];
  theirs.chummer = { ...theirs.chummer, fileName: 'v2.chum5' };
  const m = mergeActor(ours, theirs, base, { now: 99, fileName: 'v2.chum5' });
  assert.equal(m.karma, fx.karma + 5 - 2);
  assert.equal(m.skills.find((s) => s.id === 'disguise').rating, 7);
  assert.equal(m.weapons.length, 0, 'weapons removed in Chummer');
  assert.equal(m.armor[0].id, 'app_only', 'app-only item kept');
  assert.equal(m.condition.stun, 4);
  assert.equal(m.portrait, '/uploads/me.png');
  assert.deepEqual(m.training, [{ id: 't1' }]);
  assert.equal(m.chummer.fileName, 'v2.chum5');
  const d = diffActors(ours, m);
  assert.ok(d.skills.some((s) => s.id === 'disguise'));
  assert.ok(d.lists.some((l) => l.list === 'weapons' && l.removed.length === 2));
  assert.ok(d.scalars.some((s) => s.label === 'Karma'));
});
await test('after a merge, app rewards not in the uploaded file still become Chummer expenses', () => {
  const file = exportChum5(clone(seeds.find((a) => a.id === 'pc_jane'))).xml;
  const ours = parseChum5(file, { now: 1000 }).actor;
  ours.karma += 5;
  ours.karmaTotal += 5;
  ours.history.push({ ts: 2000, text: 'Récompense', karma: 5 });
  const edited = parseXml(file);
  edited.root.set('nuyen', String(Number(edited.root.val('nuyen')) - 300)); // spent in Chummer
  const theirs = parseChum5(serializeXml(edited), { now: 3000 }).actor;
  const m = mergeActor(ours, theirs, parseChum5(file, { keepXml: false }).actor, { now: 3000 });
  assert.equal(m.karma, ours.karma);
  assert.equal(m.nuyen, ours.nuyen - 300);
  const out = exportChum5(m, { now: 4000 });
  assert.ok(out.xml.includes('<reason>Récompense</reason>'));
  assert.ok(!out.xml.includes('Mise à jour depuis Chummer'), 'the merge entry is not re-exported');
  const b = parseChum5(out.xml).actor;
  assert.equal(b.karma, m.karma);
  assert.equal(b.karmaTotal, m.karmaTotal);
  assert.equal(b.nuyen, m.nuyen);
});
await test('first import into an app-made actor: the file wins, app-only data kept', () => {
  const ours = clone(seeds.find((a) => a.id === 'pc_bricks'));
  const m = mergeActor(ours, clone(fx), null, { now: 1 });
  assert.equal(m.id, 'pc_bricks');
  assert.equal(m.attributes.AGI, 5);
  assert.equal(m.weapons.length, 2);
  assert.equal(m.color, ours.color);
  assert.equal(m.history.length, ours.history.length + 1);
  assert.ok(m.bio, 'empty Chummer text never erases app text');
});

console.log('i18n (French unchanged, English from client/i18n/en/chummer.json)');
const en = dictionary('en');
await test('XML / file errors carry a translatable key, French message unchanged', () => {
  let e1;
  try {
    parseXml('<character><a></b></character>');
  } catch (err) {
    e1 = err;
  }
  assert.equal(e1.message, 'XML invalide (ligne 1) : </b> ferme <a>');
  assert.equal(e1.i18nKey, 'XML invalide (ligne {line}) : {error}');
  assert.equal(tr('en', e1.i18nKey, e1.i18nParams), 'Invalid XML (line 1): </b> closes <a>');
  let e2;
  try {
    parseChum5('<character><name>x</character>');
  } catch (err) {
    e2 = err;
  }
  assert.match(e2.message, /^Fichier \.chum5 illisible — XML invalide \(ligne 1\) : /);
  assert.match(tr('en', e2.i18nKey, e2.i18nParams), /^Unreadable \.chum5 file — Invalid XML \(line 1\): /);
  let e3;
  try {
    parseChum5('<root/>');
  } catch (err) {
    e3 = err;
  }
  assert.equal(e3.i18nKey, 'Ce fichier n’est pas une fiche Chummer5 (.chum5)');
  assert.ok(en[e3.i18nKey]);
});
await test('warnings: French strings kept, translatable copy alongside', () => {
  const p = parseChum5(src.replace(/<created>True<\/created>/, '<created>False</created>'), { fileName: 'x.chum5' });
  assert.equal(p.warnings.length, p.warningsI18n.length);
  assert.ok(p.warnings.some((w) => /mode création/.test(w)), JSON.stringify(p.warnings));
  for (const w of p.warningsI18n) assert.ok(en[w.t], `English for « ${w.t} »`);
  const jane = clone(seeds.find((a) => a.id === 'pc_jane'));
  const r = exportChum5(jane, { now: 1 });
  assert.equal(r.warnings.length, r.warningsI18n.length);
  assert.equal(r.warnings.add, undefined, 'no helper left on the returned array');
  r.warningsI18n.forEach((w, i) => {
    assert.ok(en[w.t], `English for « ${w.t} »`);
    assert.equal(tr('fr', w.t, w.params), r.warnings[i]);
  });
});
await test('diff labels are dictionary keys', () => {
  const a = clone(fx);
  const b = clone(fx);
  b.karma += 3;
  b.nuyen += 10;
  b.notes = 'autre';
  b.lifestyles = [...(b.lifestyles || []), { id: 'ls_new', name: 'Luxe', base: 'Luxury', baseCost: 100000, monthsPaid: 0, qualities: [], monthlyCost: 100000 }];
  b.gear = [...(b.gear || []), { id: 'g_new', name: 'Truc' }];
  const d = diffActors(a, b);
  for (const sc of d.scalars) assert.ok(en[sc.label], `English for « ${sc.label} »`);
  for (const l of d.lists) assert.ok(en[l.label], `English for « ${l.label} »`);
  assert.ok(d.scalars.some((x) => x.label === 'Notes' && x.to === 'modifiées'));
});

console.log('Lifestyles, accessories, armor/vehicle mods, martial arts (Shadowrun_chum5_files, historic)');
const CHUM_DIR = path.resolve(ROOT, '..', 'Shadowrun_chum5_files');
const chum = (f) => fs.readFileSync(path.join(CHUM_DIR, f), 'utf8');
const hasChumFiles = fs.existsSync(path.join(CHUM_DIR, 'Jane_Active.chum5'));
const noIds = (x) => JSON.parse(JSON.stringify(x ?? null, (k, v) => (k === 'id' ? undefined : v)));
const noGuids = (x) => JSON.parse(JSON.stringify(x ?? null, (k, v) => (k === 'id' || k === 'chummerGuid' ? undefined : v)));
const nested = (a) => ({
  lifestyles: a.lifestyles, accessories: a.weapons.map((w) => w.accessories || []), armorMods: a.armor.map((x) => x.mods || []),
  vehicleMods: a.vehicles.map((v) => v.mods || []), martialArts: a.martialArts,
});
const GARAGE = '9e7cea76-8f2e-4d87-a5ce-60395a8d701f';
const SMARTGUN_EXT = findSmartgunExt();
function findSmartgunExt() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'accessories.json'), 'utf8')).find((e) => e.name === 'Smartgun System, External') || null;
  } catch {
    return null;
  }
}
if (!hasChumFiles) console.log('  (dossier Shadowrun_chum5_files absent — tests ignorés)');
else {
  const jane = parseChum5(chum('Jane_Active.chum5'), { fileName: 'Jane_Active.chum5' }).actor;
  const chris = parseChum5(chum('Christopher_Armingstar_Active.chum5')).actor;
  const ank = parseChum5(chum('Ank_Lay_Active.chum5')).actor;
  await test('Jane: lifestyle « Best Home » (Medium) with DocWagon Gold, Extra Secure, Pheromone + Vocal Tension detection', () => {
    assert.equal(jane.lifestyle, undefined);
    assert.equal(jane.lifestyles.length, 1);
    const ls = jane.lifestyles[0];
    assert.equal(ls.name, 'Best Home');
    assert.equal(ls.base, 'Medium');
    assert.equal(ls.primary, true);
    assert.equal(ls.baseCost, 5000);
    assert.equal(ls.monthsPaid, 1);
    assert.ok(ls.chummerGuid);
    const names = ls.qualities.map((q) => q.name);
    for (const n of ['DocWagon Contract, Gold', 'Extra Secure', 'Pheromone Detection', 'Vocal Tension Lie Detection']) assert.ok(names.includes(n), n);
    const xs = ls.qualities.find((q) => q.name === 'Extra Secure');
    assert.equal(xs.multiplier, 20); // <basemultiplier> of a standard lifestyle
    assert.equal(xs.lp, 1);
    assert.equal(ls.qualities.find((q) => q.name === 'DocWagon Contract, Gold').cost, 2083.33); // "25000 div 12"
    assert.equal(ls.qualities.find((q) => q.name === 'Pheromone Detection').category, 'Contracts');
    assert.equal(ls.monthlyCost, Math.round(5000 * 1.2 + 2083.33 + 250 + 250));
  });
  await test('Christopher: Garage upgrade (Run Faster) on his advanced lifestyle', () => {
    const ls = chris.lifestyles.find((l) => l.primary);
    const garage = ls.qualities.find((q) => /^Garage/.test(q.name));
    assert.ok(garage, 'Garage');
    assert.equal(garage.catalogId, GARAGE);
    assert.equal(garage.category, 'Entertainment - Asset');
    assert.equal(garage.cost, 100);
    assert.ok(ls.qualities.some((q) => q.name === 'Dangerous Area' && q.multiplier === -20));
    assert.ok(ls.qualities.some((q) => q.name === "Local Bar Patron (The Jeffrey's)"), 'extra kept in the name');
    assert.ok(ls.points && ls.points.comforts >= 3, 'RF points of an advanced lifestyle');
  });
  await test('Jane / Ank’Lay: weapon accessories and armor mods are structured (no more notes)', () => {
    const enfield = jane.weapons.find((w) => /Enfield/.test(w.name));
    const laser = enfield.accessories.find((x) => x.name === 'Laser Sight');
    assert.deepEqual(laser.effects, { accuracy: 1 });
    assert.equal(laser.included, true);
    assert.ok(!/Accessoires :/.test(enfield.notes || ''));
    assert.ok(Array.isArray(enfield.mounts) && enfield.mounts.includes('Top'));
    const strike = jane.weapons.find((w) => /Desert Strike/.test(w.name));
    assert.ok(strike.accessories.some((x) => x.name === 'Shock Pad' && x.effects.rc === 1));
    const shocker = jane.weapons.find((w) => /Defiance/.test(w.name));
    assert.equal(shocker.accessories[0].name, 'Concealed Quick-Draw Holster');
    assert.equal(shocker.accessories[0].cost, 275);
    const heritage = jane.armor.find((a) => (a.mods || []).some((m) => m.name === 'Chemical Protection'));
    assert.ok(heritage.capacity > 0);
    const chem = heritage.mods.find((m) => m.name === 'Chemical Protection');
    assert.equal(chem.rating, 6);
    assert.equal(chem.capacity, 6);
    assert.equal(chem.cost, 1500);
    assert.ok(heritage.mods.some((m) => m.name === 'Gel Packs' && m.effects?.armor === 2));
    assert.ok(!/Modifications :/.test(heritage.notes || ''));
    const yntCap = heritage.mods.find((m) => m.name === 'YNT Softweave Armor').capacity;
    assert.ok(yntCap < 0, 'YNT Softweave adds capacity');
    const knife = ank.weapons.find((w) => (w.accessories || []).length);
    assert.ok(knife.accessories.some((x) => x.name === 'Survival Knife Bonuses' && x.included));
    const coat = ank.armor.find((a) => (a.mods || []).some((m) => m.name === 'Fire Resistance'));
    assert.equal(coat.mods.find((m) => m.name === 'Fire Resistance').rating, 6);
    assert.ok(coat.mods.length >= 8);
    assert.equal(ank.lifestyles[0].base, 'Low');
    assert.equal(ank.lifestyles[0].monthsPaid, 2);
    const roadmaster = chris.vehicles.find((v) => (v.mods || []).length);
    const armorMod = roadmaster.mods.find((m) => m.name === 'Armor (Concealed)');
    assert.equal(armorMod.rating, 4);
    assert.equal(armorMod.slots, 12); // Rating * 3
    assert.equal(armorMod.category, 'Protection');
  });
  await test('export (patch mode) keeps lifestyles, accessories and mods: re-parse equal', () => {
    for (const a of [jane, chris, ank]) {
      const r = exportChum5(a);
      assert.equal(r.mode, 'patch');
      wellFormed(r.xml);
      assert.deepEqual(noIds(nested(parseChum5(r.xml).actor)), noIds(nested(a)), a.name);
    }
  });
  await test('export (generate mode, no stored file) rebuilds them from the Chummer data', () => {
    const g = clone(jane);
    delete g.chummer;
    const r = exportChum5(g);
    assert.equal(r.mode, 'generate');
    wellFormed(r.xml);
    const back = parseChum5(r.xml).actor;
    assert.deepEqual(noGuids(back.lifestyles), noGuids(g.lifestyles));
    assert.deepEqual(noGuids(back.weapons.map((w) => w.accessories || [])), noGuids(g.weapons.map((w) => w.accessories || [])));
    assert.deepEqual(back.armor.map((x) => (x.mods || []).map((m) => m.name)), g.armor.map((x) => (x.mods || []).map((m) => m.name)));
    assert.deepEqual(back.vehicles.map((v) => (v.mods || []).map((m) => m.name)), g.vehicles.map((v) => (v.mods || []).map((m) => m.name)));
  });
  await test('export (patch mode) applies app changes to nested items and assigns guids to new ones', () => {
    const a = clone(jane);
    const ls = a.lifestyles[0];
    const vocal = ls.qualities.find((q) => q.name === 'Vocal Tension Lie Detection');
    ls.qualities = ls.qualities.filter((q) => q !== vocal);
    ls.qualities.push({ id: 'sub_garage', catalogId: GARAGE, name: 'Garage (Car (Body 5 or More))', category: 'Entertainment - Asset', cost: 100, multiplier: 0, lp: 2 });
    ls.monthsPaid = 3;
    const strike = a.weapons.find((w) => /Desert Strike/.test(w.name));
    strike.accessories.push({ id: 'sub_smart', name: 'Smartgun System, External', catalogId: SMARTGUN_EXT?.id, mount: 'Top', cost: 200, effects: { smartgun: true } });
    const heritage = a.armor.find((x) => (x.mods || []).some((m) => m.name === 'Chemical Protection'));
    heritage.mods = heritage.mods.filter((m) => m.name !== 'AR Fashion');
    heritage.mods.find((m) => m.name === 'Chemical Protection').rating = 4;
    a.martialArts = [{ id: 'itm_ma', name: 'Aikido', catalogId: 'f0b55f24-a184-4d91-a4c2-71b480bace0b', rating: 1, techniques: [{ id: 'sub_tech', name: 'Counterstrike', catalogId: '11a90b83-af42-4972-a028-0ab4c60e1c33' }] }];
    const r = exportChum5(a);
    wellFormed(r.xml);
    const back = parseChum5(r.xml).actor;
    const bls = back.lifestyles[0];
    assert.equal(bls.chummerGuid, ls.chummerGuid, 'same lifestyle node');
    assert.equal(bls.monthsPaid, 3);
    assert.ok(!bls.qualities.some((q) => q.name === 'Vocal Tension Lie Detection'), 'removed quality gone');
    const g = bls.qualities.find((q) => /^Garage/.test(q.name));
    assert.ok(g && g.catalogId === GARAGE && g.cost === 100 && g.lp === 2, 'new Garage quality');
    assert.equal(r.assigned.sub.sub_garage, g.chummerGuid);
    assert.equal(bls.qualities.find((q) => q.name === 'Extra Secure').chummerGuid, ls.qualities.find((q) => q.name === 'Extra Secure').chummerGuid, 'untouched qualities keep their guid');
    const bstrike = back.weapons.find((w) => /Desert Strike/.test(w.name));
    const smart = bstrike.accessories.find((x) => /Smartgun/.test(x.name));
    assert.ok(smart?.effects.smartgun && smart.mount === 'Top', 'new accessory');
    assert.equal(r.assigned.sub.sub_smart, smart.chummerGuid);
    const bher = back.armor.find((x) => x.chummerGuid === heritage.chummerGuid);
    assert.ok(!bher.mods.some((m) => m.name === 'AR Fashion'));
    assert.equal(bher.mods.find((m) => m.name === 'Chemical Protection').rating, 4);
    assert.equal(back.martialArts.length, 1);
    assert.equal(back.martialArts[0].catalogId, 'f0b55f24-a184-4d91-a4c2-71b480bace0b');
    assert.deepEqual(back.martialArts[0].techniques.map((x) => x.name), ['Counterstrike']);
    assert.equal(r.assigned.martialArts.itm_ma, back.martialArts[0].chummerGuid);
    assert.equal(r.assigned.sub.sub_tech, back.martialArts[0].techniques[0].chummerGuid);
    // Re-export of the edited actor once the guids are recorded: nothing duplicated.
    const a2 = clone(a);
    for (const [list, sub] of [['lifestyles', 'qualities'], ['weapons', 'accessories'], ['armor', 'mods'], ['martialArts', 'techniques']]) {
      for (const it of a2[list]) {
        if (r.assigned[list]?.[it.id]) it.chummerGuid = r.assigned[list][it.id];
        for (const x of it[sub] || []) if (r.assigned.sub[x.id]) x.chummerGuid = r.assigned.sub[x.id];
      }
    }
    a2.chummer = { ...a2.chummer, xml: r.xml };
    const r2 = exportChum5(a2);
    assert.equal(count(r2.xml, 'lifestylequality'), count(r.xml, 'lifestylequality'));
    assert.equal(count(r2.xml, 'accessory'), count(r.xml, 'accessory'));
    assert.equal(count(r2.xml, 'martialarttechnique'), 1);
  });
  await test('3-way merge and diff know lifestyles and nested items', () => {
    const base = clone(jane);
    const theirs = clone(jane);
    theirs.lifestyles[0].qualities = theirs.lifestyles[0].qualities.filter((q) => q.name !== 'Pheromone Detection');
    theirs.lifestyles[0].monthlyCost -= 250;
    const ours = clone(jane);
    ours.lifestyles[0].monthsPaid = 4;
    const m = mergeActor(ours, theirs, base);
    assert.equal(m.lifestyles.length, 1);
    assert.equal(m.lifestyles[0].monthsPaid, 4, 'app change kept');
    assert.ok(!m.lifestyles[0].qualities.some((q) => q.name === 'Pheromone Detection'), 'Chummer change applied');
    assert.equal(m.lifestyle, undefined);
    const d = diffActors(ours, m);
    const l = d.lists.find((x) => x.list === 'lifestyles');
    assert.ok(l && l.changed.some((c) => /−Pheromone Detection/.test(c)), JSON.stringify(d.lists));
    assert.ok(en[l.label], 'English list label');
  });
  await test('an app-side accessory / lifestyle option survives an unrelated Chummer upload; nested ids kept', () => {
    // Same file parsed three times like 85-chummer prepareUpdate: theirs with fresh ids, base with ids 'base'.
    const raw = chum('Jane_Active.chum5');
    const ours = parseChum5(raw).actor;
    const theirs = parseChum5(raw).actor;
    const base = parseChum5(raw, { keepXml: false, makeId: () => 'base' }).actor;
    const defiance = ours.weapons.find((w) => /Defiance/.test(w.name));
    defiance.accessories.push({ id: 'acc_app', name: 'Silencer/Suppressor', mount: 'Barrel', cost: 500 });
    ours.lifestyles[0].qualities.push({ id: 'lsq_app', name: 'Garage (Car (Body 5 or More))', catalogId: GARAGE, category: 'Entertainment - Asset', cost: 100, multiplier: 0 });
    const m = mergeActor(ours, theirs, base);
    const md = m.weapons.find((w) => w.id === defiance.id);
    assert.ok(md.accessories.some((x) => x.id === 'acc_app'), 'shop accessory kept');
    assert.ok(m.lifestyles[0].qualities.some((q) => q.id === 'lsq_app'), 'Garage kept');
    const ids = (a) => a.weapons.flatMap((w) => (w.accessories || []).map((x) => x.id)).concat(a.lifestyles.flatMap((l) => l.qualities.map((q) => q.id))).sort();
    assert.deepEqual(ids(m), ids(ours), 'nested ids unchanged');
    // A Chummer-side change to a nested item still applies.
    const theirs2 = parseChum5(raw).actor;
    theirs2.lifestyles[0].qualities = theirs2.lifestyles[0].qualities.filter((q) => q.name !== 'Vocal Tension Lie Detection');
    const m2 = mergeActor(ours, theirs2, base);
    assert.ok(!m2.lifestyles[0].qualities.some((q) => q.name === 'Vocal Tension Lie Detection') && m2.lifestyles[0].qualities.some((q) => q.id === 'lsq_app'), 'Chummer removal applied, app option kept');
    // A weapon deleted in the app (with accessories) does not come back from an unchanged file.
    const ours3 = clone(ours);
    ours3.weapons = ours3.weapons.filter((w) => w.id !== defiance.id);
    assert.ok(!mergeActor(ours3, theirs, base).weapons.some((w) => /Defiance/.test(w.name)), 'deleted weapon stays deleted');
  });
  await test('Extra Secure <basemultiplier> → baseOnly; Gel Packs counted in the armor value', async () => {
    const xs = jane.lifestyles[0].qualities.find((q) => q.name === 'Extra Secure');
    assert.equal(xs.baseOnly, true);
    assert.ok(!jane.lifestyles[0].qualities.find((q) => q.name === 'DocWagon Contract, Gold').baseOnly);
    const { armorTotal, armorValue } = await import('../shared/sr5.ts');
    const actioneer = jane.armor.find((a) => /Actioneer/.test(a.name) && (a.mods || []).some((m) => m.name === 'Gel Packs'));
    if (actioneer) assert.equal(armorValue(actioneer), Number(actioneer.rating) + 2, 'Actioneer + Gel Packs');
    const heritage = jane.armor.find((a) => (a.mods || []).some((m) => m.name === 'Gel Packs'));
    assert.equal(armorTotal({ armor: [{ ...heritage, equipped: true, stack: false }] }), Number(heritage.rating) + heritage.mods.reduce((s, m) => s + (Number(m.effects?.armor) || 0), 0));
    const re = parseChum5(exportChum5(jane).xml).actor.lifestyles[0].qualities.find((q) => q.name === 'Extra Secure');
    assert.equal(re.baseOnly, true, 'baseOnly survives the export');
  });
}

console.log('HTTP routes & permissions');
const srv = await startServer({ port: Number(process.env.SR_TEST_PORT) || 3271 });
try {
  const gmToken = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmToken);
  const H = (tok, extra = {}) => ({ Authorization: `Bearer ${tok}`, ...extra });
  const post = (url, tok, body, ct = 'text/plain') => fetch(srv.url + url, { method: 'POST', headers: H(tok, { 'Content-Type': ct }), body });
  let actorId;
  let p1Token;
  let p1;
  let p2Token;

  await test('GM imports a .chum5 as a new PC; legacy URL still works', async () => {
    const res = await post('/api/chummer/import?type=pc&fileName=chummer-test.chum5', gmToken, src);
    const j = await res.json();
    assert.equal(res.status, 200, j.error);
    actorId = j.actorId;
    await settle(300);
    const a = gm.state.actors[actorId];
    assert.equal(a.name, 'Test Chummer');
    assert.equal(a.type, 'pc');
    assert.equal(a.chummer.fileName, 'chummer-test.chum5');
    const legacy = await post('/api/actors/import-chum5', gmToken, src);
    assert.equal(legacy.status, 200);
    const noAuth = await fetch(srv.url + '/api/actors/import-chum5', { method: 'POST', body: src });
    assert.equal(noAuth.status, 403);
    const bad = await post('/api/chummer/import', gmToken, 'hello');
    assert.equal(bad.status, 400);
    const badXml = await post('/api/chummer/import', gmToken, '<character><name>x</character>');
    assert.equal(badXml.status, 400);
    const badJ = await badXml.json();
    assert.match(badJ.error, /illisible/);
    assert.equal(badJ.errorKey, 'Fichier .chum5 illisible — {error}', 'route error carries its key');
    const notChar = await (await post('/api/chummer/import', gmToken, 'hello')).json();
    assert.equal(notChar.errorKey, 'Fichier non reconnu : envoie un .chum5 (Chummer5) ou un export JSON de fiche');
    const logE = gm.state.log.find((e) => e.i18n?.key === 'Fiche importée : {actor} (Chummer).');
    assert.ok(logE && logE.text === 'Fiche importée : Test Chummer (Chummer).', 'import log translatable, French text unchanged');
  });

  await test('players never receive the stored XML; only their own pending requests', async () => {
    p1Token = await login(srv.url, { role: 'player', name: 'Testeur Chummer', characterId: actorId });
    p1 = await client(srv.url, p1Token);
    p2Token = await login(srv.url, { role: 'player', name: 'Autre Joueur', characterId: 'pc_bricks' });
    await settle(300);
    const mine = p1.state.actors[actorId];
    assert.equal(mine.chummer.xml, undefined);
    assert.equal(mine.chummer.hasFile, true);
    assert.equal(mine.chummer.fileName, 'chummer-test.chum5');
    assert.deepEqual(p1.state.chummer, { allowPlayerImport: true, pending: [] });
  });

  await test('export: owner and GM get a .chum5 attachment; others are refused', async () => {
    const res = await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p1Token) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".*\.chum5"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM like Chummer');
    const xml = buf.toString('utf8');
    wellFormed(xml);
    assert.equal(parseChum5(xml).actor.name, 'Test Chummer');
    const other = await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p2Token) });
    assert.equal(other.status, 403);
    const gmRes = await fetch(srv.url + '/api/chummer/export/pc_jane', { headers: H(gmToken) });
    assert.equal(gmRes.status, 200);
    assert.equal(gmRes.headers.get('x-chummer-mode'), 'generate');
    const missing = await fetch(srv.url + '/api/chummer/export/nope', { headers: H(gmToken) });
    assert.equal(missing.status, 404);
    await settle(300);
    assert.ok(gm.state.actors.pc_jane.chummer.exportedAt, 'export remembers the sync point');
    assert.ok(gm.state.actors.pc_jane.weapons.every((w) => w.chummerGuid), 'items got their Chummer guid');
  });

  await test('player round trip: export → edit in « Chummer » → preview → update, app rewards kept', async () => {
    const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p1Token) })).arrayBuffer()).toString('utf8');
    await gm.send('actor/adjust', { actorId, karma: 5, reason: 'Récompense' }); // happens in the app while the player edits
    await settle(300);
    const karmaApp = gm.state.actors[actorId].karma;
    const doc = parseXml(xml);
    const c = doc.root;
    const disguise = c.get('newskills/skills').all('skill').find((s) => s.val('name') === 'Disguise');
    disguise.set('karma', String(Number(disguise.val('karma')) + 1)); // Disguise 6 → 7
    c.set('nuyen', String(Number(c.val('nuyen')) - 100));
    const weapons = c.child('weapons');
    weapons.children = weapons.children.filter((w) => w.type !== 'el' || w.val('name') !== 'Colt Government 2066');
    weapons.children.push(el('weapon', [el('sourceid', COLT), el('guid', '11111111-2222-3333-4444-555555555555'), el('name', 'Colt Government 2066'), el('category', 'Heavy Pistols'), el('type', 'Ranged'), el('damage', '7P'), el('ap', '-1'), el('mode', 'SA'), el('ammo', '14(c)'), el('accuracy', '6')]));
    const edited = serializeXml(doc);
    const pre = await post(`/api/chummer/preview?actorId=${actorId}&fileName=edit.chum5`, p1Token, edited);
    const pj = await pre.json();
    assert.equal(pre.status, 200, pj.error);
    assert.equal(pj.needsApproval, false);
    assert.equal(pj.linked, true);
    assert.ok(pj.diff.skills.some((s) => s.id === 'disguise' && s.to === '7'));
    assert.ok(pj.diff.scalars.some((s) => s.label === 'Nuyens'));
    await settle(100);
    assert.equal(gm.state.actors[actorId].skills.find((s) => s.id === 'disguise').rating, 6, 'preview changes nothing');
    const up = await post(`/api/chummer/update?actorId=${actorId}&fileName=edit.chum5`, p1Token, edited);
    const uj = await up.json();
    assert.equal(up.status, 200, uj.error);
    assert.equal(uj.applied, true);
    await settle(300);
    const a = gm.state.actors[actorId];
    assert.equal(a.skills.find((s) => s.id === 'disguise').rating, 7);
    assert.equal(a.karma, karmaApp, 'reward given in the app is kept');
    assert.equal(a.nuyen, 6000 - 100);
    assert.equal(a.weapons.filter((w) => /Colt/.test(w.name)).length, 1, 'Colt replaced, not duplicated');
    assert.equal(a.weapons.filter((w) => w.name === 'Mains nues').length, 1);
    assert.equal(a.chummer.fileName, 'edit.chum5');
    assert.match(a.history[a.history.length - 1].text, /Mise à jour depuis Chummer/);
    assert.ok(gm.state.log.some((e) => /mis à jour depuis Chummer/.test(e.text)));
    const logE = [...gm.state.log].reverse().find((e) => e.i18n?.key === '{actor} mis à jour depuis Chummer ({file}) par {user} : {summary}.');
    assert.ok(logE, 'update log entry has a key');
    assert.match(logE.text, /^Test Chummer mis à jour depuis Chummer \(edit\.chum5\) par Testeur Chummer : Nuyens .+ → .+\.$/);
    assert.match(tr('en', logE.i18n.key, logE.i18n.params), /^Test Chummer updated from Chummer \(edit\.chum5\) by Testeur Chummer: Nuyen .+ → .+\.$/);
    assert.ok(Array.isArray(uj.warningsI18n), 'update reply carries translatable warnings');
  });

  await test('GM approval mode: player upload → pending request → GM validates', async () => {
    await assert.rejects(p1.send('chummer/settings', { allowPlayerImport: false }), /MJ/);
    await gm.send('chummer/settings', { allowPlayerImport: false });
    const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(p1Token) })).arrayBuffer()).toString('utf8');
    const edited = xml.replace(/<nuyen>(\d+)<\/nuyen>/, (m, n) => `<nuyen>${Number(n) + 1000}</nuyen>`);
    const nuyenBefore = gm.state.actors[actorId].nuyen;
    const pre = await (await post(`/api/chummer/preview?actorId=${actorId}`, p1Token, edited)).json();
    assert.equal(pre.needsApproval, true);
    const up = await (await post(`/api/chummer/update?actorId=${actorId}&fileName=riche.chum5`, p1Token, edited)).json();
    assert.equal(up.applied, false);
    assert.equal(up.pending, true);
    await settle(300);
    assert.equal(gm.state.actors[actorId].nuyen, nuyenBefore, 'not applied yet');
    const req = p1.state.chummer.pending.find((r) => r.id === up.requestId);
    assert.ok(req, 'player sees own request');
    assert.ok(Array.isArray(req.summaryI18n) && req.summaryI18n.length, 'pending request carries a translatable summary');
    assert.equal(req.summary, req.summaryI18n.map((p) => tr('fr', p.t, p.params)).join(', '), 'French summary unchanged');
    assert.match(req.summaryI18n.map((p) => tr('en', p.t, p.params)).join(', '), /^Nuyen /);
    assert.equal(req.xml, undefined, 'without the XML');
    const p2 = await client(srv.url, p2Token);
    assert.equal(p2.state.chummer.pending.length, 0, 'other players do not see it');
    p2.close();
    assert.ok(gm.state.chummer.pending.some((r) => r.id === up.requestId));
    await gm.send('chummer/resolve', { requestId: up.requestId, approve: true });
    await settle(300);
    assert.equal(gm.state.actors[actorId].nuyen, nuyenBefore + 1000);
    assert.equal(gm.state.chummer.pending.find((r) => r.id === up.requestId).status, 'approved');
    await assert.rejects(gm.send('chummer/resolve', { requestId: up.requestId, approve: true }), /déjà traitée/);
    // denied + cancelled requests
    const up2 = await (await post(`/api/chummer/update?actorId=${actorId}`, p1Token, edited)).json();
    await p1.send('chummer/cancel', { requestId: up2.requestId });
    const up3 = await (await post(`/api/chummer/update?actorId=${actorId}`, p1Token, edited)).json();
    await gm.send('chummer/resolve', { requestId: up3.requestId, approve: false });
    await settle(300);
    assert.equal(gm.state.actors[actorId].nuyen, nuyenBefore + 1000);
    await gm.send('chummer/settings', { allowPlayerImport: true });
  });

  await test('permissions: players cannot import new actors or touch others’ sheets', async () => {
    assert.equal((await post('/api/chummer/import', p1Token, src)).status, 403);
    assert.equal((await post('/api/chummer/update?actorId=pc_bricks', p1Token, src)).status, 403);
    assert.equal((await post('/api/chummer/preview?actorId=pc_bricks', p1Token, src)).status, 403);
    assert.equal((await post(`/api/chummer/update?actorId=${actorId}`, p1Token, 'pas du xml')).status, 400);
    assert.equal((await fetch(srv.url + `/api/chummer/export/${actorId}`)).status, 401);
    const via = await post(`/api/chummer/import?actorId=${actorId}`, p1Token, src);
    assert.equal(via.status, 200, 'import with ?actorId = update of an owned actor');
  });

  await test('Chummer portraits become the app portrait, stay out of the state, and come back on export', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const withMug = src.replace('<mainmugshotindex>-1</mainmugshotindex>', '<mainmugshotindex>0</mainmugshotindex>').replace('<mugshots />', `<mugshots>\r\n    <mugshot>${png}</mugshot>\r\n  </mugshots>`);
    const j = await (await post('/api/chummer/import?fileName=mug.chum5', gmToken, withMug)).json();
    await settle(300);
    const a = gm.state.actors[j.actorId];
    assert.match(a.portrait, /^\/uploads\/chummer-[0-9a-f]+\.png$/);
    // The raw XML never reaches clients (gmFilter); it must not hold image data server-side either (checked via export below).
    assert.ok(!a.chummer?.xml, 'raw XML not sent to the GM view');
    assert.ok((await fetch(srv.url + a.portrait)).ok, 'portrait served');
    const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${j.actorId}`, { headers: H(gmToken) })).arrayBuffer()).toString('utf8');
    assert.ok(xml.includes(`<mugshot>${png}</mugshot>`));
    assert.equal(xml.replace(/^﻿/, ''), withMug.replace(/^﻿/, ''), 'unchanged actor → identical file, portrait included');
  });

  if (hasChumFiles) {
    await test('Jane_Active import over HTTP: GM adds a Garage, the export records the guids of the new nested items', async () => {
      const res = await post('/api/chummer/import?type=pc&fileName=Jane_Active.chum5', gmToken, chum('Jane_Active.chum5'));
      const j = await res.json();
      assert.equal(res.status, 200, j.error);
      await settle(300);
      const a = gm.state.actors[j.actorId];
      const ls = a.lifestyles[0];
      assert.equal(ls.name, 'Best Home');
      assert.equal(ls.qualities.length, 4);
      const subId = await gm.send('actor/addSubItem', { actorId: a.id, list: 'lifestyles', itemId: ls.id, sub: 'qualities', item: { name: 'Garage (Car (Body 5 or More))', catalogId: GARAGE, category: 'Entertainment - Asset', cost: 100, multiplier: 0, lp: 2 } });
      const enfield = a.weapons.find((w) => /Enfield/.test(w.name));
      const accId = await gm.send('actor/addSubItem', { actorId: a.id, list: 'weapons', itemId: enfield.id, sub: 'accessories', item: { name: 'Bipod', mount: 'Under', cost: 200, effects: { rc: 2 } } });
      await settle(200);
      assert.equal(gm.state.actors[a.id].lifestyles[0].monthlyCost, ls.monthlyCost + 100, 'monthly cost recomputed');
      const xml = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${a.id}`, { headers: H(gmToken) })).arrayBuffer()).toString('utf8');
      await settle(300);
      const back = parseChum5(xml).actor;
      const garage = back.lifestyles[0].qualities.find((q) => /^Garage/.test(q.name));
      assert.ok(garage);
      const after = gm.state.actors[a.id];
      assert.equal(after.lifestyles[0].qualities.find((q) => q.id === subId).chummerGuid, garage.chummerGuid, 'quality guid recorded');
      const bipod = back.weapons.find((w) => /Enfield/.test(w.name)).accessories.find((x) => x.name === 'Bipod');
      assert.ok(bipod && bipod.effects.rc === 2);
      assert.equal(after.weapons.find((w) => w.id === enfield.id).accessories.find((x) => x.id === accId).chummerGuid, bipod.chummerGuid, 'accessory guid recorded');
      // Exporting again does not duplicate them.
      const xml2 = Buffer.from(await (await fetch(srv.url + `/api/chummer/export/${a.id}`, { headers: H(gmToken) })).arrayBuffer()).toString('utf8');
      assert.equal(count(xml2, 'lifestylequality'), 5);
      assert.equal(parseChum5(xml2).actor.weapons.find((w) => /Enfield/.test(w.name)).accessories.filter((x) => x.name === 'Bipod').length, 1);
    });
  }

  await test('GM can unlink an actor from its Chummer file', async () => {
    await gm.send('chummer/unlink', { actorId });
    await settle(300);
    assert.equal(gm.state.actors[actorId].chummer, undefined);
    assert.ok(gm.state.actors[actorId].weapons.every((w) => !w.chummerGuid));
    const r = await fetch(srv.url + `/api/chummer/export/${actorId}`, { headers: H(gmToken) });
    assert.equal(r.headers.get('x-chummer-mode'), 'generate');
    const wI18n = JSON.parse(decodeURIComponent(r.headers.get('x-chummer-warnings-i18n') || '%5B%5D'));
    const wFr = JSON.parse(decodeURIComponent(r.headers.get('x-chummer-warnings') || '%5B%5D'));
    assert.equal(wI18n.length, wFr.length, 'export: translatable warnings header');
  });

  gm.close();
  p1?.close();
} finally {
  srv.stop();
}

if (failures) {
  console.log(`\n${failures} test(s) en échec`);
  process.exit(1);
}
console.log('\nOK — tous les tests passent');
console.log(`Fichiers à ouvrir dans Chummer : ${path.relative(ROOT, OUT_JANE)}, ${path.relative(ROOT, OUT_RT)}`);
