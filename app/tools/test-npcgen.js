// Enemy generator test: node tools/test-npcgen.js  (pure generator + isolated server on port 3712, exit code != 0 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rules from '../client/modules/shop/rules.js';
import { generate, generateEncounter, ARCHETYPES, TIERS, catalogRefs, makeName, GENERATED_FOLDER } from '../shared/npcgen.js';
import { METATYPE_MIN } from '../shared/chargen.js';
import { METATYPES, derive, attr, skillPool, SKILL_BY_ID } from '../shared/sr5.js';
import { sanitizeTemplate } from '../server/modules/30-combat.js';
import { startServer, login, client, settle } from './test-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SR_TEST_PORT) || 3712;

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

const BY_NAME = new Map();
const BY_ID = new Map();
for (const f of ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'spells']) {
  for (const it of JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', `${f}.json`), 'utf8'))) {
    const k = `${f}:${it.name}`;
    BY_NAME.set(k, [...(BY_NAME.get(k) || []), it]);
    BY_ID.set(it.id, it);
  }
}
const ctx = { find: (file, name) => BY_NAME.get(`${file}:${name}`)?.[0] || null, rules };

function unitTests() {
  console.log('• catalog references');
  const refs = catalogRefs();
  ok(refs.length > 60, `generator references ${refs.length} catalog items`);
  for (const r of refs) {
    const list = BY_NAME.get(`${r.file}:${r.name}`);
    ok(!!list, `catalog item exists: ${r.file}/${r.name}`);
    ok(!list || list.length === 1, `catalog name is unique: ${r.file}/${r.name}`);
  }
  ok(TIERS.length === 7 && TIERS[0].label === 'Civil' && TIERS[6].label.startsWith('Forces spéciales'), 'PR 0-6 labels');

  console.log('• every archetype × tier');
  const seeds = [1, 77, 4242];
  for (const a of ARCHETYPES) {
    for (let tier = 0; tier <= 6; tier++) {
      for (const seed of seeds) {
        const label = `${a.id} PR${tier} seed ${seed}`;
        const tpl = generate({ archetype: a.id, tier, seed, metatype: 'random' }, ctx);
        // Deterministic
        const again = generate({ archetype: a.id, tier, seed, metatype: 'random' }, ctx);
        ok(JSON.stringify(tpl) === JSON.stringify(again), `${label}: deterministic`);
        // Valid template (sanitizeTemplate keeps the important parts)
        const s = sanitizeTemplate(tpl, { id: 'tpl_test' });
        ok(s.name === tpl.name && s.name.length > 0 && s.folder === GENERATED_FOLDER, `${label}: name / folder`);
        ok(s.npc.professionalRating === tier && s.npc.kind === (a.kind === 'critter' ? 'critter' : 'metahuman'), `${label}: PR and kind`);
        ok(s.weapons.length === tpl.weapons.length && s.skills.length === tpl.skills.length, `${label}: lists survive sanitizing`);
        // Attributes within limits
        if (METATYPES[tpl.metatype]) {
          const max = METATYPES[tpl.metatype].max;
          const min = METATYPE_MIN[tpl.metatype];
          for (const k of ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG']) {
            const v = tpl.attributes[k];
            ok(Number.isInteger(v) && v >= min[k] && v <= max[k], `${label}: ${tpl.metatype} ${k}=${v} within ${min[k]}-${max[k]}`);
          }
        } else {
          ok(Object.values(tpl.attributes).every((v) => Number.isFinite(v) && v >= 0 && v <= 12), `${label}: critter attributes sane`);
        }
        ok(tpl.attributes.ESS > 0 && tpl.attributes.ESS <= 6, `${label}: essence ${tpl.attributes.ESS} in (0, 6]`);
        ok(Object.values(tpl.augmented).every((v) => v > 0 && v <= 4), `${label}: augmented bonuses capped`);
        // Pools sane
        const d = derive(tpl);
        ok(d.initiative.dice >= 1 && d.initiative.dice <= 5 && d.initiative.base >= 2 && d.initiative.base <= 30, `${label}: initiative ${d.initiative.text}`);
        for (const sk of tpl.skills) {
          ok(SKILL_BY_ID[sk.id] && sk.rating >= 1 && sk.rating <= 8, `${label}: skill ${sk.id} ${sk.rating}`);
          const p = skillPool(tpl, sk.id).pool;
          ok(p >= 1 && p <= 22, `${label}: pool ${sk.id} = ${p}`);
        }
        for (const w of tpl.weapons) {
          ok(!!SKILL_BY_ID[w.skill], `${label}: weapon ${w.name} uses a known skill`);
          if (a.kind !== 'critter') {
            ok(!!BY_ID.get(w.catalogId), `${label}: weapon ${w.name} exists in the catalog`);
            ok(tpl.skills.some((s) => s.id === w.skill), `${label}: has the skill for ${w.name}`);
          }
        }
        for (const x of [...tpl.armor, ...tpl.augmentations, ...tpl.gear, ...tpl.spells, ...tpl.vehicles]) {
          if (x.catalogId) ok(!!BY_ID.get(x.catalogId), `${label}: ${x.name} exists in the catalog`);
        }
        if (a.magic) ok(tpl.attributes.MAG >= 1 && tpl.spells.length >= 1, `${label}: awakened with spells`);
        if (a.matrix === 'deck') ok(tpl.matrix && tpl.matrix.attack > 0 && tpl.matrix.firewall > 0, `${label}: decker matrix stats`);
        if (a.matrix === 'rcc') ok(tpl.vehicles.length >= 1 && tpl.matrix?.dataProcessing > 0, `${label}: rigger drones + RCC`);
        if (tpl.npc.grunt) ok(tpl.monitors?.stun === 0 && tpl.monitors.physical === 8 + Math.ceil(attr(tpl, 'BOD') / 2), `${label}: grunt single condition monitor`);
      }
    }
  }

  console.log('• gear scaling and options');
  const g1 = generate({ archetype: 'ganger', tier: 1, seed: 5 }, ctx);
  ok(g1.weapons.every((w) => ['Knife', 'Club', 'Streetline Special', 'Yamaha Pulsar'].includes(BY_ID.get(w.catalogId)?.name)), 'PR1 ganger: knife/club + holdout');
  ok(g1.armor.every((a) => BY_ID.get(a.catalogId)?.name === 'Armor Clothing'), 'PR1 ganger: armor clothing');
  const c3 = generate({ archetype: 'corpsec', tier: 3, seed: 5 }, ctx);
  ok(c3.weapons.some((w) => BY_ID.get(w.catalogId)?.name === 'Ares Predator V') && c3.armor.some((a) => BY_ID.get(a.catalogId)?.name === 'Armor Jacket'), 'PR3 corpsec: Predator V + armor jacket');
  const m6 = generate({ archetype: 'merc', tier: 6, seed: 5 }, ctx);
  ok(m6.augmentations.some((x) => BY_ID.get(x.catalogId)?.name === 'Wired Reflexes' && x.rating === 2) && derive(m6).initiative.dice === 3, 'PR6 merc: wired reflexes 2 → 3D6');
  ok(m6.armor.some((a) => BY_ID.get(a.catalogId)?.name === 'Full Body Armor'), 'PR6 merc: full body armor');
  const p1 = skillPool(generate({ archetype: 'merc', tier: 1, seed: 9 }, ctx), 'automatics').pool;
  const p6 = skillPool(m6, 'automatics').pool;
  ok(p6 >= p1 + 5, `pools scale with PR (${p1} → ${p6})`);
  const troll = generate({ archetype: 'ganger', tier: 2, seed: 3, metatype: 'Troll' }, ctx);
  ok(troll.metatype === 'Troll' && troll.attributes.BOD >= 5 && troll.vision.thermo, 'forced metatype (troll)');
  const names = new Set(Array.from({ length: 30 }, (_, i) => makeName('ganger', i + 1)));
  ok(names.size >= 15, `name generator variety (${names.size}/30)`);
  const enc = generateEncounter({ archetype: 'ganger', tier: 3, seed: 11, lieutenant: true }, ctx);
  ok(enc.main.npc.grunt && enc.lieutenant && !enc.lieutenant.npc.grunt, 'grunt group + lieutenant');
  ok(enc.lieutenant.npc.professionalRating === 4 && enc.lieutenant.attributes.EDG >= 3 && !enc.lieutenant.monitors, 'lieutenant: PR+1, Edge, full monitors');
  const solo = generate({ archetype: 'ganger', tier: 3, seed: 11, grunt: false }, ctx);
  ok(!solo.npc.grunt && !solo.monitors, 'grunt option off → normal monitors');
  const hh = generate({ archetype: 'hellhound', tier: 3, seed: 1 }, ctx);
  ok(hh.metatype === 'Créature' && hh.powers.length >= 4 && hh.attributes.MAG === 5, 'hellhound critter stats/powers');
  const shaman = generate({ archetype: 'shaman', tier: 4, seed: 1 }, ctx);
  ok(/esprit/i.test(shaman.description) && /Force \d/.test(shaman.description), 'shaman: spirit summoning note');
}

async function serverTests() {
  console.log('• server actions (port ' + PORT + ')');
  const srv = await startServer({ port: PORT });
  try {
    const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
    const pl = await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueuse' }));
    await settle();
    await rejects(pl.send('npcgen/preview', { archetype: 'ganger', tier: 1, seed: 1 }), /réservée au MJ/, 'players cannot generate');
    await rejects(gm.send('npcgen/preview', { archetype: 'dragon', tier: 1, seed: 1 }), /Archétype inconnu/, 'unknown archetype');
    const pv = await gm.send('npcgen/preview', { archetype: 'corpsec', tier: 3, seed: 99, lieutenant: true });
    const pv2 = await gm.send('npcgen/preview', { archetype: 'corpsec', tier: 3, seed: 99, lieutenant: true });
    ok(pv.main && pv.lieutenant && JSON.stringify(pv) === JSON.stringify(pv2), 'preview deterministic, with lieutenant');
    ok(typeof pv.unitName === 'string' && pv.unitName.length > 2, 'preview carries a unit name');
    await settle();
    const nTpl = Object.keys(gm.state.bestiary).length;
    ok(!Object.values(gm.state.bestiary).some((t) => t.folder === GENERATED_FOLDER), 'preview stores nothing');

    // Save to bestiary only
    const r1 = await gm.send('npcgen/create', { archetype: 'merc', tier: 4, seed: 7, saveToBestiary: true, name: 'Mercenaire MET2000' });
    await settle();
    ok(r1.templateIds.length === 1 && gm.state.bestiary[r1.templateIds[0]]?.folder === GENERATED_FOLDER, 'template saved in « Générés »');
    ok(gm.state.bestiary[r1.templateIds[0]].name === 'Mercenaire MET2000', 'custom name kept');

    // Spawn a grunt group + lieutenant on the active map, without saving
    const mapId = gm.state.scene?.activeMapId || Object.keys(gm.state.maps)[0];
    const tokensBefore = (gm.state.maps[mapId]?.tokens || []).length;
    const r2 = await gm.send('npcgen/create', { archetype: 'ganger', tier: 2, seed: 3, lieutenant: true, name: 'Ganger des Spikes', saveToBestiary: false, spawn: { mapId, count: 4 } });
    await settle();
    ok(r2.templateIds.length === 0 && r2.actorIds.length === 5, `4 grunts + 1 lieutenant spawned (${r2.actorIds.length})`);
    ok(Object.keys(gm.state.bestiary).length === nTpl + 1, 'no temporary template left behind');
    const spawned = r2.actorIds.map((id) => gm.state.actors[id]);
    ok(spawned.every((a) => a?.type === 'npc' && !a.templateId), 'NPC actors created (no dangling template id)');
    ok(spawned.filter((a) => a.npc?.grunt).length === 4 && spawned.some((a) => a.npc?.professionalRating === 3 && !a.npc.grunt), 'grunts and lieutenant');
    ok(spawned.some((a) => a.name === 'Ganger des Spikes 1') && spawned.some((a) => a.name === 'Ganger des Spikes 4'), 'numbered names like the bestiary spawn');
    if (gm.state.maps[mapId]) ok(gm.state.maps[mapId].tokens.length === tokensBefore + 5 - r2.unplaced, 'tokens placed on the map');

    // Save + spawn without map
    const r3 = await gm.send('npcgen/create', { archetype: 'hellhound', tier: 5, seed: 2, saveToBestiary: true, spawn: { mapId: null, count: 2 } });
    await settle();
    ok(r3.templateIds.length === 1 && r3.actorIds.length === 2 && r3.tokenIds.length === 0, 'saved + 2 actors without tokens');
    ok(r3.actorIds.every((id) => gm.state.actors[id]?.templateId === r3.templateIds[0]), 'spawned actors linked to the saved template');
    await rejects(gm.send('npcgen/create', { archetype: 'ganger', tier: 1, seed: 1 }), /Rien à faire/, 'needs save or spawn');
    gm.close();
    pl.close();
  } finally {
    srv.stop();
  }
}

unitTests();
await serverTests();
console.log(failures ? `\n${failures} échec(s), ${passes} réussite(s)` : `\nOK — ${passes} vérifications`);
process.exit(failures ? 1 : 0);
