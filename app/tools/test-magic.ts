// Magic module tests: shared rules (shared/magic.ts), traditions (server/lib/traditions.ts, Chummer import) and the
// server actions of 47-magic.ts on an isolated server.
// Run: node tools/test-magic.ts   (port 3650 or SR_TEST_PORT, exit code != 0 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findTradition, traditionFromDef, parseDrainText, sortTraditions, drainPool, drainAttr, usesTradition, isAwakened, magicHints, sustainedBy, traditionName,
  type TraditionDef,
} from '../shared/magic.ts';
import { checkedTest } from '../shared/modifiers.ts';
import { traditions, actorTradition, chummerTradition } from '../server/lib/traditions.ts';
import { parseChum5 } from '../server/lib/chummer/parse.ts';
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
