// Magic module tests: shared rules (shared/magic.ts), traditions (server/lib/traditions.ts, Chummer import) and the
// server actions of 47-magic.ts on an isolated server.
// Run: node tools/test-magic.ts   (port 3650 or SR_TEST_PORT, exit code != 0 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findTradition, traditionFromDef, parseDrainText, sortTraditions, drainValue, drainOffset, spellReach, isAreaSpell, spellCategory, spellDrainType, maxForce,
  spellEffects, isSustainable, combatSpellProfile, spellResistance, attributeOfSpell, drainPool, drainAttr, usesTradition, isAwakened, magicHints, sustainedBy, traditionName,
  type TraditionDef,
} from '../shared/magic.ts';
import { checkedTest, collectModifiers, poolModifiers, rollContext, derivedWithModifiers } from '../shared/modifiers.ts';
import { traditions, actorTradition, chummerTradition } from '../server/lib/traditions.ts';
import { parseChum5 } from '../server/lib/chummer/parse.ts';
import { spellCatalogInfo } from '../server/lib/spells.ts';
import { mergeActor } from '../server/lib/chummer/merge.ts';
import type { Actor, ActorLike, MagicState, SustainedSpell } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}
async function expectFail(p: Promise<unknown>, re: RegExp, msg: string) {
  try {
    await p;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(re.test((e as Error).message), `${msg} — got: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Traditions data and shared rules
// ---------------------------------------------------------------------------
const list: TraditionDef[] = traditions();
ok(list.length > 60, `traditions.json loaded (${list.length})`);
const hermetic = list.find((t) => t.name === 'Hermetic');
ok(hermetic?.drain === 'LOG' && hermetic.spirits?.combat === 'Spirit of Fire' && hermetic.source === 'SR5' && hermetic.page === 279, 'Hermetic: WIL + LOG, fire spirit for combat, SR5 279');
ok(list.find((t) => t.name === 'Shamanic')?.drain === 'CHA', 'Shamanic: WIL + CHA');
ok(list.find((t) => t.name === 'Custom') && !list.find((t) => t.name === 'Custom')!.drain, 'Custom: no drain attribute');
ok(list[0].name === 'Custom', 'Custom first in the list');
const frSorted = sortTraditions(list, 'fr');
ok(frSorted[0].name === 'Custom' && traditionName(frSorted[1], 'fr').localeCompare(traditionName(frSorted[2], 'fr'), 'fr') <= 0, 'sortTraditions: Custom, then French names in order');
ok(findTradition(list, hermetic!.id)?.name === 'Hermetic', 'findTradition by id');
ok(findTradition(list, 'hermetic')?.name === 'Hermetic', 'findTradition by name (case-insensitive)');
ok(findTradition(list, 'Chaos')?.name === 'Chaos Magic' && findTradition(list, 'Voodoo')?.name === 'Vodou' && findTradition(list, 'Other')?.name === 'Custom', 'legacy creator values');
ok(findTradition(list, 'Hermétique')?.name === 'Hermetic', 'old French creator value');
ok(findTradition(list, 'Nope') === null && findTradition(list, '') === null, 'unknown / empty → null');
const tradFr = list.find((t) => t.nameFr);
ok(!!tradFr && findTradition(list, tradFr.nameFr)?.id === tradFr.id, 'findTradition by French name');
ok(traditionName(tradFr, 'fr') === tradFr!.nameFr && traditionName(tradFr, 'en') === tradFr!.name, 'traditionName per language');
const custom = traditionFromDef(findTradition(list, 'Custom')!, 'INT');
ok(custom.drain === 'INT' && custom.name === 'Custom', 'Custom tradition takes the chosen drain');
ok(traditionFromDef(hermetic!, 'CHA').drain === 'LOG', 'a catalog drain wins over the choice');
ok(parseDrainText('WIL + CHA') === 'CHA' && parseDrainText('{WIL} + {LOG}') === 'LOG' && parseDrainText('') === null && parseDrainText('BOD + STR') === null, 'parseDrainText');

const mage = {
  id: 'npc_m', attributes: { BOD: 3, AGI: 3, REA: 3, STR: 2, WIL: 5, LOG: 6, INT: 4, CHA: 3, EDG: 2, MAG: 6, ESS: 6 },
  skills: [{ id: 'spellcasting', name: 'Lancement de sorts', attr: 'MAG', rating: 5 }], spells: [], magic: { tradition: traditionFromDef(hermetic!) },
} as unknown as ActorLike & { magic: { tradition: ReturnType<typeof traditionFromDef> } };
const adept = { id: 'pc_a', attributes: { BOD: 4, AGI: 5, REA: 5, STR: 4, WIL: 4, LOG: 2, INT: 4, CHA: 2, EDG: 3, MAG: 5, ESS: 6 }, skills: [], spells: [], powers: [{ id: 'p', name: 'Improved Reflexes', pp: 1.5 }] } as unknown as ActorLike;
const mundane = { id: 'pc_m', attributes: { BOD: 4, AGI: 4, REA: 4, STR: 4, WIL: 4, LOG: 4, INT: 4, CHA: 4, EDG: 3, ESS: 6 }, skills: [], spells: [] } as unknown as ActorLike;
ok(isAwakened(mage) && isAwakened(adept) && !isAwakened(mundane), 'isAwakened = MAG > 0');
ok(usesTradition(mage) && !usesTradition(adept) && !usesTradition(mundane), 'usesTradition: magician yes, adept / mundane no');
ok(drainAttr(mage) === 'LOG', 'drainAttr from the tradition');
const pool = drainPool(mage);
ok(pool?.base === 11 && pool.attrs.join('+') === 'WIL+LOG', `drain pool WIL 5 + LOG 6 = 11 (got ${pool?.base})`);
ok(drainPool(adept) === null, 'no drain pool without a tradition');
ok(checkedTest('drainResist', { attr: 'WIL', attr2: 'MAG' }) === 'drainResist' && checkedTest('drainResist', { attr: 'WIL', attr2: 'WIL' }) === 'drainResist', 'drainResist accepts WIL + MAG (Draconic) and WIL + WIL (Romani)');
ok(checkedTest('drainResist', { attr: 'WIL', attr2: 'BOD' }) === null, 'drainResist refuses WIL + BOD');

let hints = magicHints({ actor: mage, magic: { sustained: {} } });
ok(hints.length === 1 && hints[0].tone === 'info' && hints[0].params?.n === 11 && hints[0].action === 'drain', 'hint: drain pool');
hints = magicHints({ actor: { ...mage, magic: {} }, magic: null });
ok(hints[0]?.tone === 'warn' && hints[0].action === 'tradition', 'hint: pick a tradition');
hints = magicHints({ actor: { ...mage, magic: { tradition: custom && { ...custom, drain: null } } }, magic: null });
ok(/no Drain attribute/.test(hints[0]?.key || ''), 'hint: custom tradition without drain');
const sustained: Record<string, SustainedSpell> = {
  s1: { id: 's1', casterId: 'npc_m', spellId: 'x', name: { fr: 'Armure', en: 'Armor' }, force: 4, hits: 3, targetIds: [], ts: 0 },
  s2: { id: 's2', casterId: 'npc_m', spellId: 'y', name: { fr: 'Invisibilité', en: 'Invisibility' }, force: 4, hits: 2, targetIds: [], ts: 0 },
};
ok(sustainedBy({ sustained }, 'npc_m') === 2 && sustainedBy({ sustained }, 'other') === 0, 'sustainedBy counts the caster’s spells');
hints = magicHints({ actor: mage, magic: { sustained } });
ok(hints[0]?.tone === 'warn' && hints[0].params?.p === 4, 'hint: sustained spells −2 each, first (most urgent)');
ok(magicHints({ actor: adept, magic: null }).length === 0 && magicHints({ actor: mundane, magic: null }).length === 0, 'no hints for an adept without sustained spells / a mundane');

// Spellcasting rules (SR5 pp. 281-283)
ok(drainOffset('F-3') === -3 && drainOffset('F−2') === -2 && drainOffset('F+1') === 1 && drainOffset('F') === 0 && drainOffset(' F - 4 ') === -4, 'drainOffset: F ± n (ASCII or Unicode minus, spaces)');
ok(drainOffset('Special') === null && drainOffset('0') === null && drainOffset('') === null, 'drainOffset: Special / 0 / empty → null');
ok(drainValue('F-3', 6) === 3 && drainValue('F-3', 4) === 2 && drainValue('F-6', 3) === 2, 'drainValue: Force − n, never below 2');
ok(drainValue('F+1', 3) === 4 && drainValue('F-3', 6, { reckless: true }) === 6 && drainValue('F-6', 3, { reckless: true }) === 5, 'drainValue: + n; reckless +3 after the minimum');
ok(drainValue('Special', 5) === null, 'drainValue: Special → null');
ok(spellDrainType(6, 5) === 'P' && spellDrainType(5, 5) === 'S', 'drain Physical only when hits exceed Magic');
ok(maxForce(mage) === 12, 'max Force = 2 × MAG');
ok(spellReach('LOS') === 'los' && spellReach('LOS (A)') === 'los' && spellReach('T') === 'touch' && spellReach('T (A)') === 'touch' && spellReach('S') === 'self' && spellReach('Special') === 'special', 'spellReach');
ok(isAreaSpell('LOS (A)') && isAreaSpell('S (A)') && !isAreaSpell('LOS'), 'isAreaSpell');
ok(spellCategory('Combat') === 'combat' && spellCategory('Santé') === 'health' && spellCategory('Détection') === 'detection' && spellCategory('Health') === 'health' && spellCategory('?') === null, 'spellCategory (English / French)');

// Sustained spells (#14): effects table and modifiers mirrored on the actors
ok(JSON.stringify(spellEffects({ name: 'Armor' }, 3)) === JSON.stringify([{ type: 'armor', value: 3 }]), 'Armor: armor = hits');
ok(spellEffects({ name: 'Armure' }, 2)[0]?.value === 2 && spellEffects({ name: 'x', nameEn: 'Combat Sense' }, 4)[0]?.target === 'defense', 'French name, Combat Sense → defense');
ok(spellEffects({ name: 'Armor' }, 0).length === 0 && spellEffects({ name: 'Manabolt' }, 4).length === 0, 'no hits / no numeric effect → none');
ok(isSustainable('S') && isSustainable('P') && !isSustainable('I'), 'isSustainable: S and P');
{
  const noLookup = () => null;
  const sus = { ...mage, magic: { ...mage.magic, sustaining: [{ id: 's1', name: { fr: 'Armure', en: 'Armor' }, force: 4 }, { id: 's2', name: { fr: 'X', en: 'X' }, force: 2 }] } } as unknown as ActorLike;
  const mods = collectModifiers(sus, noLookup);
  const pm = poolModifiers(mods, rollContext(sus, { skillId: 'spellcasting' }), {});
  ok(pm.total === -4, `two sustained spells: −4 on a skill test (got ${pm.total})`);
  ok(poolModifiers(mods, rollContext(sus, { attr: 'WIL', attr2: 'LOG', test: 'drainResist' }), {}).total === 0, 'not on resistance tests (like afflictions)');
  const tgt = { ...mundane, armor: [], magic: { spellEffects: [{ id: 's1', name: { fr: 'Armure', en: 'Armor' }, force: 4, hits: 3, casterId: 'npc_m', casterName: 'Mage', effects: [{ type: 'armor', value: 3 }] }] } } as unknown as ActorLike;
  const d = derivedWithModifiers(tgt, collectModifiers(tgt, noLookup));
  ok(d.armor === 3, `Armor spell on the target: armor 3 (got ${d.armor})`);
}

// Combat spells (#15): profile from the catalog, fallback from type and name
{
  const p = (name: string, type: string) => combatSpellProfile({ name, type }, spellCatalogInfo({ name }));
  const mb = p('Manabolt', 'M');
  ok(mb.mode === 'direct' && mb.resist === 'WIL' && mb.damage === 'P' && mb.mana, `Manabolt: direct, WIL, Physical (${JSON.stringify(mb)})`);
  ok(p('Powerbolt', 'P').resist === 'BOD' && p('Stunbolt', 'M').damage === 'S', 'Powerbolt resisted with BOD; Stunbolt Stun');
  const fb = p('Fireball', 'P');
  ok(fb.mode === 'indirect' && fb.element === 'fire', `Fireball: indirect, fire (${JSON.stringify(fb)})`);
  ok(p('Boule de feu', 'P').mode === 'indirect', 'French catalog name found');
  const custom = combatSpellProfile({ name: 'Flame lash', type: 'P' }, null);
  ok(custom.mode === 'indirect' && custom.element === 'fire', 'hand-made physical elemental → indirect');
  ok(combatSpellProfile({ name: 'Mind spike', type: 'M' }, null).mode === 'direct' && combatSpellProfile({ name: 'Stun whip', type: 'M' }, null).damage === 'S', 'hand-made mana → direct; « stun » → Stun');
}

// Non-combat spells (#16): resistance from the catalog descriptor
{
  const r = (name: string, category: string, type: string, choice?: string) => spellResistance({ name, category, type, choice }, spellCatalogInfo({ name }));
  const attrs = (x: ReturnType<typeof r>) => (x ? x.attrs.join('+') : 'none');
  ok(attrs(r('Detect Enemies', 'Detection', 'M')) === 'LOG+WIL' && r('Detect Enemies', 'Detection', 'M')!.objects, 'active detection: LOG + WIL, objects allowed');
  ok(r('Clairvoyance', 'Detection', 'M') === null && r('Heal', 'Health', 'M') === null, 'passive detection and Heal: no resistance');
  ok(attrs(r('Decrease [Attribute]', 'Health', 'P', 'Body')) === 'BOD+WIL', 'Decrease [Body]: BOD + WIL (SR5 p. 288)');
  ok(attributeOfSpell({ name: 'Decrease [Agility]' }) === 'AGI' && attributeOfSpell({ name: 'x', choice: 'Volonté' }) === 'WIL', 'attributeOfSpell (name brackets, French choice)');
  ok(attrs(r('Invisibility', 'Illusion', 'M')) === 'LOG+WIL' && attrs(r('Chaos', 'Illusion', 'P')) === 'INT+LOG', 'illusions: mana LOG + WIL, physical INT + LOG');
  ok(r('Entertainment', 'Illusion', 'M') === null, 'obvious illusion: no resistance');
  ok(attrs(r('Control Thoughts', 'Manipulation', 'M')) === 'LOG+WIL' && attrs(r('Levitate', 'Manipulation', 'P')) === 'BOD+STR' && r('Light', 'Manipulation', 'P') === null, 'manipulation: mental, physical, environmental');
  ok(r('Manabolt', 'Combat', 'M') === null, 'combat spells are not handled here');
}

// ---------------------------------------------------------------------------
// Chummer import
// ---------------------------------------------------------------------------
const shinto = chummerTradition({ sourceid: '9abbebc1-48a3-4dde-960a-af565b163a3d', name: 'Shinto', drain: 'WIL + CHA', source: 'SG', page: '48', spirits: { health: 'Plant Spirit', combat: 'Spirit of Air' } });
ok(shinto?.name === 'Shinto' && shinto.drain === 'CHA' && shinto.spirits?.health === 'Plant Spirit' && !!shinto.id, 'chummerTradition: the file’s drain and spirits, catalog id');
const homemade = chummerTradition({ name: 'Ma tradition', drain: 'WIL + INT', source: 'HR', page: '3' });
ok(homemade?.name === 'Ma tradition' && homemade.drain === 'INT' && homemade.source === 'HR' && homemade.page === 3 && !homemade.id, 'chummerTradition: home-made tradition kept');
ok(chummerTradition({ name: '' }) === null, 'chummerTradition: empty → null');
ok(actorTradition('Shamanic')?.drain === 'CHA' && actorTradition('nope') === null, 'actorTradition');
const CHUM_DIR = path.join(ROOT, '..', 'Shadowrun_chum5_files');
if (fs.existsSync(path.join(CHUM_DIR, 'Eva_Otoko_Active.chum5'))) {
  const parsed = parseChum5(fs.readFileSync(path.join(CHUM_DIR, 'Eva_Otoko_Active.chum5'), 'utf8'));
  const tr = parsed.actor.magic?.tradition;
  ok(tr?.name === 'Shinto' && tr.drain === 'CHA', `.chum5 import stores the tradition (got ${JSON.stringify(tr)})`);
  // 3-way merge: the app's tradition stays when Chummer's did not change; Chummer's wins when it changed.
  const current = { ...(parsed.actor as unknown as Actor), magic: { tradition: { name: 'Hermetic', drain: 'LOG' as const } } };
  const same = mergeActor(current, parsed.actor, parsed.actor);
  ok(same.magic?.tradition?.name === 'Hermetic', 'merge: app tradition kept when the file’s did not change');
  const changed = mergeActor(current, parsed.actor, { ...parsed.actor, magic: {} });
  ok(changed.magic?.tradition?.name === 'Shinto', 'merge: the file’s new tradition wins');
  const noTrad = mergeActor(current, { ...parsed.actor, magic: {} }, null);
  ok(noTrad.magic?.tradition?.name === 'Hermetic', 'merge: a file without tradition never erases the app’s');
} else console.log('  (Shadowrun_chum5_files absent: .chum5 tradition import not checked)');

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------
const { startServer, login, client, settle } = await import('./test-client.ts');
const magicSeed: Partial<MagicState> = {
  settings: { autoDrain: true, showAstralToPlayers: false },
  sustained: {
    a: { id: 'a', casterId: 'pc_jane', spellId: 'x', name: { fr: 'Armure', en: 'Armor' }, force: 3, hits: 2, targetIds: [], ts: 1 },
    b: { id: 'b', casterId: 'pc_bricks', spellId: 'y', name: { fr: 'Soins', en: 'Heal' }, force: 3, hits: 2, targetIds: ['pc_anthony'], ts: 1 },
    c: { id: 'c', casterId: 'pc_bricks', spellId: 'z', name: { fr: 'Armure', en: 'Armor' }, force: 3, hits: 2, targetIds: ['pc_jane'], ts: 1 },
    gone: { id: 'gone', casterId: 'pc_deleted', spellId: 'z', name: { fr: 'x', en: 'x' }, force: 1, hits: 1, targetIds: [], ts: 1 },
  },
  astral: { pc_jane: { mode: 'perceiving', since: 1 }, pc_bricks: { mode: 'projecting', since: 1 }, pc_deleted: { mode: 'projecting', since: 1 } },
};
const srv = await startServer({
  port: Number(process.env.SR_TEST_PORT) || 3650,
  tables: [{ id: 'lazarus', state: { version: 1, config: { gmPassword: 'lazarus', campaignName: 'Test', lang: 'fr' }, users: {}, actors: {}, log: [], magic: magicSeed } }],
});
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus', table: 'lazarus' }), { table: 'lazarus' });
  const pj = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane', table: 'lazarus' }), { table: 'lazarus' });
  const pb = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks', table: 'lazarus' }), { table: 'lazarus' });

  // init: entries of unknown actors are dropped; defaults set.
  ok(gm.state.magic && !gm.state.magic.sustained.gone && !gm.state.magic.astral.pc_deleted, 'init drops entries of deleted actors');
  ok(Object.keys(gm.state.magic.sustained).length === 3 && gm.state.magic.settings.autoDrain === true, 'GM sees every sustained spell; autoDrain default on');
  // Player filter: own casts + spells on own characters; own astral state only.
  ok(Object.keys(pj.state.magic.sustained).sort().join() === 'a,c', `Jane's player: her spell and the one on her (got ${Object.keys(pj.state.magic.sustained)})`);
  ok(Object.keys(pj.state.magic.astral).join() === 'pc_jane', 'astral presences: own only');
  await gm.send('magic/settings', { showAstralToPlayers: true });
  await settle();
  ok(Object.keys(pj.state.magic.astral).sort().join() === 'pc_bricks,pc_jane', 'showAstralToPlayers: every astral presence');
  await expectFail(pj.send('magic/settings', { autoDrain: false }), /GM|MJ/, 'settings: GM only');

  // Tradition: GM on an NPC magician.
  const mageId = await gm.send<string>('actor/create', { type: 'npc', name: 'Mage test', attributes: { WIL: 5, LOG: 6, MAG: 6 } });
  const r = await gm.send('magic/setTradition', { actorId: mageId, tradition: 'Hermetic' });
  ok(r.tradition?.name === 'Hermetic' && r.tradition.drain === 'LOG' && r.tradition.id === hermetic!.id, 'GM sets Hermetic (drain LOG, catalog id)');
  await settle();
  ok(gm.state.actors[mageId].magic?.tradition?.drain === 'LOG', 'stored drain LOG');
  await gm.send('magic/setTradition', { actorId: mageId, tradition: 'Shamanic' });
  await settle();
  ok(gm.state.actors[mageId].magic?.tradition?.drain === 'CHA', 'GM changes it (Shamanic → CHA)');
  await gm.send('magic/setTradition', { actorId: mageId, tradition: null });
  await settle();
  ok(!gm.state.actors[mageId].magic?.tradition, 'GM clears it');
  await expectFail(gm.send('magic/setTradition', { actorId: mageId, tradition: 'Nope' }), /Nope/, 'unknown tradition refused');
  await expectFail(gm.send('magic/setTradition', { actorId: mageId, tradition: 'Custom', drain: 'BOD' }), /Drain|drain/, 'invalid drain attribute refused');

  // Player: own awakened character, once; Custom then its drain; no change after.
  await expectFail(pb.send('magic/setTradition', { actorId: 'pc_jane', tradition: 'Hermetic' }), /yours|vous/i, 'player cannot set another player’s tradition');
  await expectFail(pb.send('magic/setTradition', { actorId: 'pc_bricks', tradition: 'Hermetic' }), /awakened|éveillé/, 'player: mundane character refused');
  await pj.send('magic/setTradition', { actorId: 'pc_jane', tradition: 'Custom' });
  await settle();
  ok(pj.state.actors.pc_jane.magic?.tradition?.name === 'Custom' && pj.state.actors.pc_jane.magic.tradition.drain === null, 'player picks Custom (no drain yet)');
  await pj.send('magic/setTradition', { actorId: 'pc_jane', tradition: 'Custom', drain: 'INT' });
  await settle();
  ok(pj.state.actors.pc_jane.magic?.tradition?.drain === 'INT', 'player chooses the drain of Custom');
  await expectFail(pj.send('magic/setTradition', { actorId: 'pc_jane', tradition: 'Hermetic' }), /GM|MJ/, 'player cannot change a chosen tradition');
  await expectFail(pj.send('magic/setTradition', { actorId: 'pc_jane', tradition: 'Custom', drain: 'CHA' }), /GM|MJ/, 'player cannot change a chosen drain');
  await expectFail(pj.send('magic/setTradition', { actorId: 'pc_jane', tradition: null }), /GM|MJ|tradition/, 'player cannot clear it');
  await gm.send('magic/setTradition', { actorId: 'pc_jane', tradition: 'Custom', drain: 'CHA' });
  await settle();
  ok(gm.state.actors.pc_jane.magic?.tradition?.drain === 'CHA' && gm.state.actors.pc_jane.magic.tradition.name === 'Custom', 'GM changes the drain of a Custom tradition in place');
  await gm.send('magic/setTradition', { actorId: mageId, tradition: 'Hermetic' });
  await gm.send('magic/setTradition', { actorId: mageId, tradition: 'Hermetic', drain: 'CHA' });
  await settle();
  ok(gm.state.actors[mageId].magic?.tradition?.drain === 'LOG', 'a catalog tradition keeps its own drain');
  // ---------- Cast flow (#13) ----------
  await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'skills', item: { id: 'spellcasting', name: 'Spellcasting', attr: 'MAG', rating: 5 } });
  const addSpell = async (item: object) => {
    await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'spells', item });
    await settle();
    return gm.state.actors.pc_jane.spells[gm.state.actors.pc_jane.spells.length - 1].id;
  };
  const manabolt = await addSpell({ name: 'Manabolt', category: 'Combat', type: 'M', range: 'LOS', duration: 'I', drain: 'F-3' });
  const heal = await addSpell({ name: 'Heal', category: 'Health', type: 'M', range: 'T', duration: 'P', drain: 'F-4' });
  const ball = await addSpell({ name: 'Fireball', category: 'Combat', type: 'P', range: 'LOS (A)', duration: 'I', drain: 'F-1' });
  const odd = await addSpell({ name: 'Odd spell', category: 'Manipulation', type: 'P', range: 'LOS', duration: 'S', drain: 'Special' });
  const mapId = await gm.send<string>('maps/create', { name: 'Magic test', width: 30, height: 12 });
  await gm.send('maps/setActive', { mapId });
  await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_jane', x: 5, y: 5 } });
  await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_anthony', x: 10, y: 5 } });
  await gm.send('maps/addToken', { mapId, token: { actorId: 'pc_bricks', x: 20, y: 5 } });
  await gm.send('maps/addWall', { mapId, wall: { x1: 15, y1: 0, x2: 15, y2: 12, move: true, sight: true } });
  await settle();
  const stunBefore = gm.state.actors.pc_jane.condition.stun;
  const physBefore = gm.state.actors.pc_jane.condition.physical;
  let cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 6, mapId, targetIds: ['pc_anthony'] });
  ok(cr.force === 6 && cr.dv === 3 && cr.hits <= 6 && 'hits' in cr.drain && cr.targetIds.join() === 'pc_anthony', `cast Manabolt F6: DV 3, hits ≤ Force, drain resisted (${JSON.stringify(cr)})`);
  ok(cr.drainType === (cr.hits > 5 ? 'P' : 'S'), 'drain type from hits vs Magic');
  await settle();
  const dmg = (cr.drain as { damage: number }).damage;
  const after = gm.state.actors.pc_jane.condition;
  ok(dmg === Math.max(0, 3 - (cr.drain as { hits: number }).hits) && (cr.drainType === 'S' ? after.stun - stunBefore === dmg : after.physical - physBefore === dmg), 'drain damage applied to the caster');
  const castLog = gm.state.log.find((e) => e.id === cr.logId);
  ok(castLog?.kind === 'magic' && castLog.magic?.event === 'cast' && castLog.magic.force === 6 && castLog.magic.dv === 3, 'cast log entry (kind magic)');
  const rollLog = gm.state.log.find((e) => e.id === cr.rollLogId);
  ok(rollLog?.roll?.limit === 6 && rollLog.roll.labelI18n?.key === 'Spell — {spell} (Force {force})', 'Spellcasting roll limited by the Force, labelled with it');
  ok(gm.state.log.some((e) => e.kind === 'magic' && e.magic?.event === 'drain' && e.magic.actorId === 'pc_jane'), 'drain log entry');
  cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 2, reckless: true });
  ok(cr.dv === 5, 'reckless: max(2, 2 − 3) + 3 = 5');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 11 }), /Force|Puissance/, 'Force above 2 × MAG refused');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 0 }), /Force|Puissance/, 'Force 0 refused');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: 'nope', force: 3 }), /spell|sort/i, 'unknown spell refused');
  await expectFail(pb.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 3 }), /yours|vous/i, 'another player cannot cast for Jane');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 3, mapId, targetIds: ['pc_bricks'] }), /line of sight|ligne de vue/i, 'LOS spell: target behind a wall refused');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 3, targetIds: ['pc_anthony'] }), /map|carte/i, 'targets need the map');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: heal, force: 3, mapId, targetIds: ['pc_anthony'] }), /reach|portée/i, 'touch spell: distant target refused');
  cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: heal, force: 3, mapId, targetIds: ['pc_jane'] });
  ok(cr.targetIds.join() === 'pc_jane', 'touch spell on oneself');
  cr = await gm.send('magic/cast', { actorId: 'pc_jane', spellId: heal, force: 3, mapId, targetIds: ['pc_anthony'] });
  ok(cr.targetIds.join() === 'pc_anthony', 'the GM is not checked');
  cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: ball, force: 3, mapId, targetIds: ['pc_anthony'] });
  ok(cr.area?.x === 10 && cr.area.radius === 3, 'area centred on the first target, radius = Force');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: ball, force: 3, mapId, area: { x: 10, y: 5 }, targetIds: ['pc_anthony', 'pc_jane'] }), /outside|hors/i, 'area: a target outside the radius refused');
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: odd, force: 3 }), /Drain/, 'Special drain: the value is required');
  cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: odd, force: 3, drainDv: 4 });
  ok(cr.dv === 4, 'Special drain: given value');
  // ---------- Sustained spells (#14) ----------
  for (const old of Object.values(gm.state.magic.sustained)) if (old.casterId === 'pc_jane') await gm.send('magic/drop', { id: old.id });
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  const armorSpell = await addSpell({ name: 'Armor', category: 'Manipulation', type: 'P', range: 'LOS', duration: 'S', drain: 'F-2' });
  let sus: { sustainedId?: string | null; hits: number } = { hits: 0 };
  for (let i = 0; i < 5 && !sus.sustainedId; i++) sus = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: armorSpell, force: 5, mapId, targetIds: ['pc_anthony'] });
  await settle();
  const sid = sus.sustainedId as string;
  ok(!!sid && gm.state.magic.sustained[sid]?.hits === sus.hits && gm.state.magic.sustained[sid].targetIds.join() === 'pc_anthony', 'a Sustained spell with hits is sustained');
  ok(gm.state.actors.pc_jane.magic?.sustaining?.some((x) => x.id === sid), 'caster mirror: actor.magic.sustaining');
  ok(gm.state.actors.pc_anthony.magic?.spellEffects?.[0]?.effects[0]?.value === sus.hits, 'target mirror: Armor = hits');
  ok(!!pj.state.magic.sustained[sid] && !pb.state.magic.sustained[sid], 'the caster sees it; an unrelated player does not');
  const r1 = await pj.send('dice/roll', { actorId: 'pc_jane', skillId: 'spellcasting' });
  ok((r1.mods || []).some((m: { id: string; value: number; state: string }) => m.id === `sustained:${sid}` && m.value === -2 && m.state === 'applied'), 'the caster’s next roll has −2 (sustaining)');
  cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: armorSpell, force: 3, mapId, targetIds: ['pc_anthony'], sustain: false });
  ok(!cr.sustainedId, 'sustain: false → not sustained');
  const inst = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 3 });
  ok(!inst.sustainedId, 'an Instantaneous spell is never sustained');
  await expectFail(pb.send('magic/drop', { id: sid }), /yours|vous/i, 'another player cannot drop it');
  await pj.send('magic/drop', { id: sid });
  await settle();
  ok(!gm.state.magic.sustained[sid] && !(gm.state.actors.pc_jane.magic?.sustaining || []).some((x) => x.id === sid) && !(gm.state.actors.pc_anthony.magic?.spellEffects || []).some((x) => x.id === sid), 'drop clears the record and both mirrors');
  ok(gm.state.log.some((e) => e.magic?.event === 'drop'), 'drop logged');
  await expectFail(pj.send('magic/drop', { id: sid }), /sustained|maintenu/i, 'drop twice refused');
  // Permanent spell: Force Combat Turns, then it is no longer sustained.
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  let perm: { sustainedId?: string | null } = {};
  for (let i = 0; i < 5 && !perm.sustainedId; i++) perm = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: heal, force: 2, mapId, targetIds: ['pc_jane'] });
  await settle();
  const pid2 = perm.sustainedId as string;
  ok(gm.state.magic.sustained[pid2]?.turnsLeft === 2, 'Permanent spell: turnsLeft = Force');
  await gm.send('combat/start', { mapId });
  await gm.send('combat/newTurn');
  await settle();
  ok(gm.state.magic.sustained[pid2]?.turnsLeft === 1, 'a new Combat Turn counts down');
  await gm.send('combat/newTurn');
  await settle();
  ok(!gm.state.magic.sustained[pid2], 'after Force Combat Turns the spell is permanent: no longer sustained');
  await gm.send('combat/end');

  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  // ---------- Combat spells through the attacks (#15) ----------
  for (const old of Object.values(gm.state.magic.sustained)) if (old.casterId === 'pc_jane') await gm.send('magic/drop', { id: old.id });
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  await gm.send('actor/update', { actorId: 'pc_anthony', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  let mbCast: { hits: number; attackIds: string[] } = { hits: 0, attackIds: [] };
  for (let i = 0; i < 5 && !mbCast.hits; i++) mbCast = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 6, mapId, targetIds: ['pc_anthony'] });
  await settle();
  const atk1 = gm.state.attacks.list.find((x) => x.id === mbCast.attackIds[0]);
  ok(mbCast.attackIds.length === 1 && atk1?.kind === 'spell' && atk1.spell?.mode === 'direct' && atk1.spell.resist === 'WIL' && atk1.dv === null && atk1.status === 'defense' && atk1.hits === mbCast.hits, `Manabolt → a direct spell attack waiting for the resistance (${JSON.stringify(atk1)})`);
  const physBeforeA = gm.state.actors.pc_anthony.condition.physical;
  const res = await gm.send('attack/defend', { attackId: atk1!.id });
  await settle();
  const net = mbCast.hits - res.roll.hits;
  const dmgA = gm.state.actors.pc_anthony.condition.physical - physBeforeA;
  ok(/WIL/.test(res.roll.breakdown || ''), `resisted with WIL (${res.roll.breakdown})`);
  ok(net > 0 ? res.attack.status === 'done' && res.attack.damage === net && dmgA === net : res.attack.status === 'missed' && dmgA === 0, `direct: net hits are Physical damage, no soak (net ${net}, damage ${dmgA}, ${res.attack.status})`);
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  let fbCast: { hits: number; attackIds: string[] } = { hits: 0, attackIds: [] };
  for (let i = 0; i < 5 && !fbCast.hits; i++) fbCast = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: ball, force: 4, mapId, targetIds: ['pc_anthony'] });
  await settle();
  const atk2 = gm.state.attacks.list.find((x) => x.id === fbCast.attackIds[0]);
  ok(atk2?.spell?.mode === 'indirect' && atk2.dv === 4 && atk2.ap === -4 && atk2.type === 'P' && atk2.spell.element === 'fire', `Fireball → indirect: DV = Force, AP = −Force, fire (${JSON.stringify(atk2)})`);
  const auto = await gm.send('attack/auto', { attackId: atk2!.id });
  await settle();
  ok(auto.attack.status === 'missed' || (auto.attack.status === 'done' && auto.attack.modifiedDv === 4 + auto.attack.net && auto.attack.soakHits !== undefined), 'indirect: dodge, then soak at DV Force + net hits');
  if (auto.attack.net > 0) ok(gm.state.log.some((e) => e.i18n?.key?.startsWith('Elemental damage')), 'elemental reminder logged');
  const droneId = await gm.send<string>('actor/create', { type: 'npc', name: 'Drone test', npc: { kind: 'drone' } });
  await gm.send('maps/addToken', { mapId, token: { actorId: droneId, x: 8, y: 5 } });
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 3, mapId, targetIds: [droneId] }), /mana/i, 'a mana spell cannot target a drone');
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });

  // ---------- Non-combat spells: resistance (#16) ----------
  const control = await addSpell({ name: 'Control Thoughts', category: 'Manipulation', type: 'M', range: 'LOS', duration: 'S', drain: 'F-1' });
  const levitate = await addSpell({ name: 'Levitate', category: 'Manipulation', type: 'P', range: 'LOS', duration: 'S', drain: 'F-2' });
  let ct: { hits: number; attackIds: string[]; sustainedId?: string | null } = { hits: 0, attackIds: [] };
  for (let i = 0; i < 5 && !ct.hits; i++) ct = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: control, force: 4, mapId, targetIds: ['pc_anthony'] });
  await settle();
  const atk3 = gm.state.attacks.list.find((x) => x.id === ct.attackIds[0]);
  ok(ct.attackIds.length === 1 && atk3?.noDamage && atk3.spell?.resist === 'LOG' && atk3.spell.resist2 === 'WIL' && atk3.status === 'defense', `Control Thoughts → a resistance test LOG + WIL, no damage (${JSON.stringify(atk3)})`);
  const physA = gm.state.actors.pc_anthony.condition;
  const res3 = await gm.send('attack/defend', { attackId: atk3!.id });
  await settle();
  ok(/LOG/.test(res3.roll.breakdown) && /WIL/.test(res3.roll.breakdown), `resisted with LOG + WIL (${res3.roll.breakdown})`);
  ok((res3.attack.status === 'done' && res3.attack.net === ct.hits - res3.roll.hits) || res3.attack.status === 'missed', 'net hits recorded');
  ok(JSON.stringify(gm.state.actors.pc_anthony.condition) === JSON.stringify(physA), 'no damage from a non-combat spell');
  if (ct.sustainedId) await pj.send('magic/drop', { id: ct.sustainedId });
  // A spell on oneself is not resisted.
  const selfCast = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: control, force: 2, mapId, targetIds: ['pc_jane'], sustain: false });
  ok(selfCast.attackIds.length === 0, 'the caster does not resist their own spell');
  // Object Resistance.
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });
  const objCast = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: levitate, force: 4, object: 6, sustain: false });
  ok(objCast.object?.pool === 6 && objCast.object.net === Math.max(0, objCast.hits - objCast.object.hits), `object resists with 6 dice (${JSON.stringify(objCast.object)})`);
  await expectFail(pj.send('magic/cast', { actorId: 'pc_jane', spellId: levitate, force: 2, object: 7, sustain: false }), /Object|objets/, 'a player cannot invent an Object Resistance');
  await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { physical: 0, stun: 0, overflow: 0 } } });

  // Drain left pending (autoDrain off).
  await gm.send('magic/settings', { autoDrain: false });
  cr = await pj.send('magic/cast', { actorId: 'pc_jane', spellId: manabolt, force: 4 });
  await settle();
  const pid = (cr.drain as { pendingId: string }).pendingId;
  ok(!!pid && pj.state.magic.pendingDrain[pid]?.dv === 2, 'autoDrain off: drain left pending, visible to the caster');
  ok(!pb.state.magic.pendingDrain[pid], 'pending drain hidden from other players');
  await expectFail(pb.send('magic/resistDrain', { id: pid }), /yours|vous/i, 'another player cannot resist it');
  const rd = await pj.send('magic/resistDrain', { id: pid });
  await settle();
  ok(typeof rd.hits === 'number' && !pj.state.magic.pendingDrain[pid], 'resistDrain rolls and clears it');
  await expectFail(pj.send('magic/resistDrain', { id: pid }), /Drain/, 'resisted only once');
  await gm.send('magic/settings', { autoDrain: true });

  // The drain roll of the tradition goes through dice/roll with the drainResist test.
  const roll = await pj.send('dice/roll', { actorId: 'pc_jane', attr: 'WIL', attr2: 'INT', test: 'drainResist', limit: null, applyWounds: false, label: 'Résistance au drain (VOL + INT)' });
  ok(roll && typeof roll === 'object', 'drain resistance roll accepted');
  pj.close();
  pb.close();
  gm.close();
} finally {
  await srv.stopAndWait();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
