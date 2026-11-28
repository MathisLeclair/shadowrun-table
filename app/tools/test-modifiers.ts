// Tests for the modifiers of gear / clothing / qualities / adept powers / implants (shared/modifiers.ts, tools/lib/bonus-effects.ts,
// the 'dice/roll' authority in server/modules/10-characters.ts) — run: node tools/test-modifiers.ts (ports 3500-3529).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { startServer, login, client, settle } from './test-client.ts';
import { normalizeBonus, entryEffects, effValue, conditionKey, skillIdOf } from './lib/bonus-effects.ts';
import {
  collectModifiers, lookupFromIndex, poolModifiers, limitFor, rollContext, derivedWithModifiers, effectValue, cleanConditions,
  weaponAccuracy, conditionState, CONDITIONS, gearHasEffects, bonusFromEffects, checkedTest, woundsApply, qualityAutomation,
} from '../shared/modifiers.ts';
import { healthStatus } from '../client/modules/sheet/sheet-data.ts';
import { tokenVision } from '../shared/vision.ts';
import { parseChum5 } from '../server/lib/chummer/parse.ts';
import { convertSheet } from '../server/lib/foundry/convert-actor.ts';
import { derive, attr, skillPool } from '../shared/sr5.ts';
import { actionPool, ACTION_BY_ID, matrixInitiative } from '../shared/matrix.ts';
import { compute, buildActor, emptyDraft } from '../shared/chargen.ts';
import * as rules from '../client/modules/shop/rules.ts';
import type { ConvertedSheet, FoundryWeapon } from '../server/lib/foundry/convert-actor.ts';
import type { EffectsIndex, LineState } from '../shared/modifiers.ts';
import type { Actor, ActorLike, Augmentation, CatalogFile, CatalogItem, CatalogStats, DraftData, Effect, Gear, Quality, RollModLine, RollRecord, WeaponStats } from '../shared/types.ts';

/**
 * 'dice/roll' result as these tests read it: mods and breakdowns are always present on a sheet roll. The line state is
 * the modifiers engine's LineState ('applied' | 'off' | 'ignored' | 'info'), not ConditionState as RollModLine says.
 */
type Roll = Omit<RollRecord, 'mods'> & { mods: Array<Omit<RollModLine, 'state'> & { state: LineState }>; breakdown: string; limitBreakdown: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUMMER = path.join(ROOT, '..', 'Chummer5.226.0', 'data');
const PCS: Actor[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8'));
const pc = (id: string): Actor => structuredClone(PCS.find((a) => a.id === id)!);
const INDEX: EffectsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'effects.json'), 'utf8'));
const lookup = lookupFromIndex(INDEX);
const catalog = <S = CatalogStats>(file: string): CatalogItem<S>[] => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', `${file}.json`), 'utf8'));

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
const rejects = async (p: Promise<unknown>, re?: RegExp) => {
  try {
    await p;
  } catch (err) {
    if (re) assert.match((err as Error).message, re);
    return err;
  }
  throw new Error('expected rejection');
};
const strip = (effects: Effect[]) => effects.map(({ tag, ...e }) => e);

// ---------------------------------------------------------------------------
console.log('Catalog effect normalizer (real Chummer XML entries)');
// ---------------------------------------------------------------------------
const hasChummer = fs.existsSync(path.join(CHUMMER, 'armor.xml'));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true });
/** Parsed Chummer XML documents (fast-xml-parser output: dynamic). */
const xmlCache: Record<string, any> = {};
/** Raw XML entry by id (falls back to name) from a Chummer data file. */
function xmlEntry(file: string, listPath: string[], id: string): any {
  if (!xmlCache[file]) xmlCache[file] = parser.parse(fs.readFileSync(path.join(CHUMMER, file), 'utf8')).chummer;
  let node = xmlCache[file];
  for (const k of listPath) node = node?.[k];
  const list: any[] = Array.isArray(node) ? node : [node];
  const hit = list.find((x) => x && (x.id === id || x.name === id));
  assert.ok(hit, `${file}: ${id} not found`);
  return hit;
}
const xmlTest = (name: string, fn: () => unknown) => (hasChummer ? test(name, fn) : console.log('  - skipped (no Chummer data):', name));

await xmlTest('Zoé Heritage 12 (armor.xml, RG 62): +2 social limit if visible', () => {
  const x = xmlEntry('armor.xml', ['armors', 'armor'], 'd4804f1b-4443-4e97-a7d2-9c1659732c6b');
  assert.deepEqual(strip(entryEffects(x)), [{ type: 'limit', target: 'social', value: 2, condition: 'visible' }]);
});
await xmlTest('Chameleon Suit: +2 physical limit, Sneaking only, if visible', () => {
  const x = xmlEntry('armor.xml', ['armors', 'armor'], 'aacafde3-ff9a-4de0-85ac-3870645a9197');
  assert.deepEqual(strip(entryEffects(x)), [{ type: 'limit', target: 'physical', value: 2, condition: 'skills-active-sneaking-visible' }]);
  assert.deepEqual(CONDITIONS['skills-active-sneaking-visible'].skills, ['sneaking']);
});
await xmlTest('Improved Reflexes (powers.xml): initiative dice + REA per level (baked), disablequality kept as unsupported', () => {
  const x = xmlEntry('powers.xml', ['powers', 'power'], 'Improved Reflexes');
  const e = strip(entryEffects(x));
  assert.deepEqual(e.filter((m) => m.type !== 'unsupported'), [{ type: 'initiativeDice', value: 'Rating' }, { type: 'attribute', target: 'REA', value: 'Rating' }]);
  assert.ok(e.some((m) => m.type === 'unsupported' && entryEffects(x).find((k) => k.type === 'unsupported')!.tag === 'disablequality'));
});
await xmlTest('Kinesics: Rating dice to resist Judge Intentions', () => {
  const x = xmlEntry('powers.xml', ['powers', 'power'], 'Kinesics');
  assert.deepEqual(strip(entryEffects(x)), [{ type: 'stat', target: 'judgeIntentionsDefense', value: 'Rating' }]);
});
await xmlTest('Muscle Replacement (cyberware.xml): STR and AGI + Rating', () => {
  const x = xmlEntry('cyberware.xml', ['cyberwares', 'cyberware'], '46f80a44-80ae-41d7-a7c8-a119c4cff70f');
  const e = strip(entryEffects(x)).filter((m) => m.type !== 'unsupported');
  assert.deepEqual(e.map((m) => m.target).sort(), ['AGI', 'STR']);
  assert.ok(e.every((m) => m.type === 'attribute' && m.value === 'Rating'));
});
await xmlTest('Synaptic Booster (bioware.xml): initiative dice + REA', () => {
  const x = xmlEntry('bioware.xml', ['biowares', 'bioware'], '4a4e1079-5872-4f3f-a450-48c30a5504f3');
  const e = strip(entryEffects(x)).filter((m) => m.type !== 'unsupported');
  assert.deepEqual(e, [{ type: 'initiativeDice', value: 'Rating' }, { type: 'attribute', target: 'REA', value: 'Rating' }]);
});
await xmlTest('Tailored Pheromones: social limit + Rating, Acting / Influence groups with a free-text condition', () => {
  const x = xmlEntry('bioware.xml', ['biowares', 'bioware'], '2faac78a-ab32-4541-ad9c-3ef6c1b2cd84');
  const e = strip(entryEffects(x));
  assert.deepEqual(e[0], { type: 'limit', target: 'social', value: 'Rating' });
  assert.deepEqual(e.slice(1).map((m) => [m.type, m.target, m.condition]), [['skillGroup', 'acting', 't-people-who-can-smell-you'], ['skillGroup', 'influence', 't-people-who-can-smell-you']]);
});
await xmlTest('Codeslinger (qualities.xml): +2 dice to a chosen Matrix action', () => {
  const x = xmlEntry('qualities.xml', ['qualities', 'quality'], 'Codeslinger');
  assert.deepEqual(strip(entryEffects(x)), [{ type: 'matrixAction', target: '$choice', value: 2, choice: { kind: 'matrixAction' } }]);
});
await xmlTest('Dimmer Bulb: negative linked-attribute dice, memory, dodge (formula -Rating)', () => {
  const x = xmlEntry('qualities.xml', ['qualities', 'quality'], 'Dimmer Bulb');
  const e = strip(entryEffects(x));
  assert.deepEqual(e[0], { type: 'skillAttribute', target: 'LOG', value: '-Rating' });
  assert.ok(e.some((m) => m.type === 'stat' && m.target === 'memory' && m.value === '-Rating'));
  assert.ok(e.some((m) => m.type === 'stat' && m.target === 'defense'));
  assert.ok(e.some((m) => m.type === 'unsupported'), 'addiction tags kept as unsupported');
});
await xmlTest('Toughness / Will to Live / Catlike: soak, overflow boxes, Sneaking dice', () => {
  assert.deepEqual(strip(entryEffects(xmlEntry('qualities.xml', ['qualities', 'quality'], 'Toughness'))), [{ type: 'stat', target: 'soak', value: 1 }]);
  assert.deepEqual(strip(entryEffects(xmlEntry('qualities.xml', ['qualities', 'quality'], 'Will to Live'))), [{ type: 'monitor', target: 'overflow', value: 1 }]);
  assert.deepEqual(strip(entryEffects(xmlEntry('qualities.xml', ['qualities', 'quality'], 'Catlike'))), [{ type: 'skill', target: 'sneaking', value: 2 }]);
});
await xmlTest('Fire Resistance armor mod: fire armor Rating (resistance, shown)', () => {
  const x = xmlEntry('armor.xml', ['mods', 'mod'], 'dd246520-7306-40fb-88b4-c9cb031208fc');
  assert.deepEqual(strip(entryEffects(x)), [{ type: 'resist', target: 'firearmor', value: 'Rating' }]);
});
await xmlTest('Spellcasting Focus, Combat (gear.xml): Rating dice to Spellcasting for combat spells', () => {
  const x = xmlEntry('gear.xml', ['gears', 'gear'], '2f485376-54c1-41be-8678-79cc98e04ebc');
  const e = strip(entryEffects(x)).filter((m) => m.type !== 'unsupported');
  assert.deepEqual(e, [{ type: 'skill', target: 'spellcasting', value: 'Rating', condition: 'spell-combat' }]);
});
await test('normalizer helpers: values, conditions, skill names, unknown tags, wireless bonuses', () => {
  assert.equal(effValue('2'), 2);
  assert.equal(effValue('+1'), 1);
  assert.equal(effValue('{Rating}'), 'Rating');
  assert.equal(conditionKey('LimitCondition_Visible'), 'visible');
  assert.equal(conditionKey('LimitCondition_IntimidationVisible'), 'intimidation-visible');
  assert.equal(conditionKey('LimitCondition_TestAttribAGI'), 'test-attrib-agi');
  assert.equal(conditionKey('When in hosts'), 't-when-in-hosts');
  assert.equal(conditionKey('create'), false);
  assert.equal(skillIdOf('Exotic Ranged Weapon'), 'exotic_weapon');
  assert.equal(skillIdOf('Con'), 'con');
  assert.deepEqual(normalizeBonus({ somethingnew: '3' }), [{ type: 'unsupported', tag: 'somethingnew' }]);
  assert.deepEqual(strip(normalizeBonus({ limitmodifier: { limit: 'Social', value: '1', condition: 'LimitCondition_Visible' } }, { wireless: true })), [{ type: 'limit', target: 'social', value: 1, condition: 'visible', wireless: true }]);
  assert.equal(effectValue('Rating', 3), 3);
  assert.equal(effectValue('-Rating', 2), -2);
  assert.equal(effectValue('FixedValues(3,6,9)', 2), 6);
  assert.equal(effectValue('Rating * 2', 2), 4);
  assert.equal(effectValue('nonsense', 2), null);
});
await test('catalog: entries carry effects, coverage report lists every condition with a label', () => {
  const heritage = catalog('armor').find((x) => x.id === 'd4804f1b-4443-4e97-a7d2-9c1659732c6b')!;
  assert.equal(heritage.effects![0].condition, 'visible');
  const cov = fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'effects-coverage.md'), 'utf8');
  assert.match(cov, /\| limitmodifier \| \d+ \| 0 \|/);
  assert.match(cov, /## Conditions/);
  assert.doesNotMatch(cov, /⚠ (none|missing)/, 'every condition key has a French label and its English translation');
});

// ---------------------------------------------------------------------------
console.log('Modifiers of the Lazarus PCs (pure)');
// ---------------------------------------------------------------------------
await test('Jane: Con pool 14 (16 with Seduction), social limit 9 → 11 with « Tenue visible » (Zoé Heritage 12, RG 62)', () => {
  const jane = pc('pc_jane');
  const mods = collectModifiers(jane, lookup);
  const ctx = rollContext(jane, { skillId: 'con' });
  assert.equal(skillPool(jane, 'con').pool, 14);
  assert.equal(skillPool(jane, 'con', { useSpec: true }).pool, 16);
  assert.equal(poolModifiers(mods, ctx, {}).total, 0, 'no dice modifier on Con');
  const off = limitFor(jane, 'social', mods, ctx, { conditions: [] });
  assert.equal(off.base, 9);
  assert.equal(off.total, 9);
  const on = limitFor(jane, 'social', mods, ctx, { conditions: ['visible'] });
  assert.equal(on.total, 11);
  const line = on.lines.find((l) => l.state === 'applied')!;
  assert.equal(line.mod.source.name, 'Zoé : Heritage 12');
  assert.equal(line.mod.source.book, 'RG');
  assert.equal(line.mod.source.page, 62);
  // Summary: « 9 (11 si visible) »
  const dm = derivedWithModifiers(jane, mods);
  assert.equal(dm.limits.social, 9);
  assert.equal(dm.limitsAlt.social, 11);
  assert.deepEqual(dm.limitsAltConditions.social, ['visible']);
});
await test('Jane: adept powers — Improved Reflexes baked (no double count), Kinesics / Truth Detector on Judge Intentions', () => {
  const jane = pc('pc_jane');
  const mods = collectModifiers(jane, lookup);
  const d = derive(jane);
  const dm = derivedWithModifiers(jane, mods);
  const ir = mods.filter((m) => m.source.name === 'Réflexes améliorés');
  assert.deepEqual(ir.map((m) => [m.type, m.value, !!m.baked]).sort(), [['attribute', 2, true], ['initiativeDice', 2, true]]);
  assert.equal(attr(jane, 'REA'), 7, 'REA 5 + 2 (augmented), counted once');
  assert.equal(dm.initiative.dice, d.initiative.dice);
  assert.equal(dm.initiative.dice, 3);
  // Kinesics (Contrôle corporel 2) + Truth Detector 3: defense against Judge Intentions; Judge Intentions test +3
  const jiDef = mods.filter((m) => m.type === 'stat' && m.target === 'judgeIntentionsDefense').reduce((s, m) => s + m.value!, 0);
  assert.equal(jiDef, 5);
  assert.equal(dm.judgeIntentions, d.judgeIntentions + 3);
  assert.equal(poolModifiers(mods, rollContext(jane, { attr: 'CHA', attr2: 'INT', test: 'judgeIntentions' }), {}).total, 3);
});
await test('Jane: weapon attack limit = Accuracy + Laser Sight (Enfield AS-7: 4 + 1)', () => {
  const jane = pc('pc_jane');
  const w = jane.weapons.find((x) => x.name === 'Enfield AS-7')!;
  const mods = collectModifiers(jane, lookup, { weaponId: w.id });
  const acc = weaponAccuracy(jane, w, mods, rollContext(jane, { skillId: w.skill, weaponId: w.id }), {});
  assert.equal(acc.total, 5);
});
await test('Ank’Lay: Muscle Replacement / Synaptic Booster are baked into the Foundry augmented values (not added twice)', () => {
  const ank = pc('pc_anklay');
  const mods = collectModifiers(ank, lookup);
  const ware = mods.filter((m) => m.source.list === 'augmentations');
  assert.ok(ware.length >= 4);
  assert.ok(ware.every((m) => m.baked), 'attribute / initiative bonuses of implants are informational');
  assert.equal(attr(ank, 'STR'), 10);
  assert.equal(attr(ank, 'AGI'), 10);
  assert.equal(attr(ank, 'REA'), 8);
  const dm = derivedWithModifiers(ank, mods);
  assert.equal(dm.initiative.dice, 3);
  assert.equal(dm.limits.physical, derive(ank).limits.physical);
  // Clothes: Executive Suite +1 visible (+2 more wireless), Argentum coat +1 visible
  assert.equal(dm.limits.social, 3);
  assert.equal(limitFor(ank, 'social', mods, {}, { conditions: ['visible'] }).total, 5);
  assert.equal(limitFor(ank, 'social', mods, {}, { conditions: ['visible', 'wireless'] }).total, 7);
});
await test('Bricks: Codeslinger needs a choice; once chosen it adds +2 dice to that Matrix action only', () => {
  const bricks = pc('pc_bricks');
  let mods = collectModifiers(bricks, lookup);
  const cs = mods.find((m) => m.type === 'matrixAction');
  assert.ok(cs && cs.needsChoice && cs.info, 'not applied without a choice');
  const persona = { mode: 'cold' as const, loadedPrograms: [] };
  const before = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, { mods }).pool;
  bricks.qualities.find((q) => q.id === cs.source.itemId)!.choice = 'Hack on the Fly';
  mods = collectModifiers(bricks, lookup);
  const hack = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, { mods });
  assert.equal(hack.pool, before + 2);
  assert.ok(hack.parts.some((p) => p.label === 'Disparition Ninja' || p.mod), 'the bonus is a pool part with its source');
  assert.equal(actionPool(bricks, persona, ACTION_BY_ID.bruteForce, { mods }).pool, actionPool(bricks, persona, ACTION_BY_ID.bruteForce, {}).pool);
});
await test('conditions: skill-restricted conditions are automatic for that skill only, unknown switches are dropped', () => {
  const jane = pc('pc_jane');
  assert.equal(conditionState('intimidation-visible', rollContext(jane, { skillId: 'con' }), new Set(['visible'])), 'na');
  assert.equal(conditionState('intimidation-visible', rollContext(jane, { skillId: 'intimidation' }), new Set(['visible'])), 'on');
  assert.equal(conditionState('skills-active-perception', rollContext(jane, { skillId: 'perception' }), new Set()), 'auto');
  const mods = collectModifiers(jane, lookup);
  assert.deepEqual(cleanConditions(mods, ['visible', 'bogus', 'wireless']), ['visible']);
});
await test('gear: effects only while switched on (item.active); a GM-chosen skill for « select » effects (item.choice)', () => {
  const jane = pc('pc_jane');
  const focus = catalog('gear').find((x) => x.id === '2f485376-54c1-41be-8678-79cc98e04ebc')!;
  jane.gear.push({ id: 'g_focus', name: focus.name, catalogId: focus.id, rating: 3, qty: 1 } as Gear);
  assert.ok(gearHasEffects(jane.gear.at(-1)!, lookup));
  assert.equal(collectModifiers(jane, lookup).filter((m) => m.source.itemId === 'g_focus').length, 0);
  jane.gear.at(-1)!.active = true;
  const m = collectModifiers(jane, lookup).find((x) => x.source.itemId === 'g_focus' && x.type === 'skill')!;
  assert.equal(m.value, 3);
  assert.equal(m.condition, 'spell-combat');
  // Improved Ability (skill) on Con, chosen by the GM
  jane.powers.push({ id: 'pw_ia', name: 'Improved Ability (skill)', catalogId: '75821fb7-a180-4012-aa16-daa92ac3bb63', level: 2, pp: 1, choice: 'Con' });
  const pm = poolModifiers(collectModifiers(jane, lookup), rollContext(jane, { skillId: 'con' }), {});
  assert.equal(pm.total, 2);
});
await test('monitors and wounds: Will to Live, High Pain Tolerance, overrides win', () => {
  const a = pc('pc_anthony');
  const d0 = derive(a);
  a.qualities.push({ id: 'q_wtl', name: 'Will to Live', catalogId: '18d2a522-6460-4654-916b-a96631f11323', karma: 3 } as Quality);
  a.qualities.push({ id: 'q_hpt', name: 'High Pain Tolerance', catalogId: 'b7866fb4-3747-4caf-9240-69cbdd79ce78', karma: 7 } as Quality);
  a.condition = { physical: 3, stun: 0, overflow: 0 };
  const dm = derivedWithModifiers(a, collectModifiers(a, lookup));
  assert.equal(dm.overflowMax, d0.overflowMax + 1);
  assert.equal(derive(a).woundModifier, -1);
  assert.equal(dm.woundModifier, 0, 'one box ignored: 2 boxes → no wound modifier');
  a.monitors = { physical: 14 };
  a.qualities.push({ id: 'q_t', name: 'Toughness', catalogId: '00cc6499-db13-447e-8116-278d317a9e31', karma: 9 } as Quality);
  const dm2 = derivedWithModifiers(a, collectModifiers(a, lookup));
  assert.equal(dm2.physicalMonitor, 14);
  assert.equal(dm2.soak, attr(a, 'BOD') + dm2.armor + 1);
});

// --- Regressions of the review « modifiers engine » --------------------------------------------------------------------------
const CAT_ID = (file: string, name: string) => catalog(file).find((x) => x.name === name)!.id;
await test('a forced monitor of 0 stays 0 (grunt / drone stun track, host physical track) and is never « hors de combat »', () => {
  const drone = { ...pc('pc_bricks'), id: 'npc_x', monitors: { physical: 9, stun: 0 }, condition: { physical: 1, stun: 0, overflow: 0 } };
  drone.qualities = [{ id: 'q_wtl', name: 'Will to Live', catalogId: '18d2a522-6460-4654-916b-a96631f11323', karma: 3 } as Quality];
  const dm = derivedWithModifiers(drone, collectModifiers(drone, lookup));
  assert.equal(dm.stunMonitor, 0, 'override 0 kept (was clamped to 1)');
  assert.equal(dm.physicalMonitor, 9);
  assert.equal(healthStatus(drone.condition, dm.physicalMonitor, dm.stunMonitor, 4), 'blessé');
  assert.equal(healthStatus({ physical: 0, stun: 0 }, 9, 0, 4), 'indemne');
  assert.equal(healthStatus({ physical: 0, stun: 0 }, 0, 6, 4), 'indemne', 'host: no physical track');
});
await test('attribute / initiative bonuses: « déjà compté » only when stored (item.bonus, import, or room in the stored value)', () => {
  const ir = CAT_ID('powers', 'Improved Reflexes');
  const b = pc('pc_bricks');
  b.powers = [{ id: 'itm_gm', name: 'Improved Reflexes', catalogId: ir, level: 2, pp: 2.5 }];
  let mods = collectModifiers(b, lookup).filter((m) => m.source.itemId === 'itm_gm');
  assert.ok(mods.length === 2 && mods.every((m) => m.unbaked && !m.baked), 'GM-added power never stored → « non compté »');
  const dm = derivedWithModifiers(b, collectModifiers(b, lookup));
  assert.equal(dm.sources['attr.REA'][0].note, 'unbaked');
  b.powers[0].bonus = { attributes: { REA: 2 }, initiativeDice: 2 };
  b.augmented = { REA: 2 };
  b.initiative = { dice: 3, bonus: 0 };
  mods = collectModifiers(b, lookup).filter((m) => m.source.itemId === 'itm_gm');
  assert.ok(mods.every((m) => m.baked && !m.unbaked), 'recorded on item.bonus → baked');
  // A hand-made template whose stored values already hold the bonus (no record): baked
  delete b.powers[0].bonus;
  assert.ok(collectModifiers(b, lookup).filter((m) => m.source.itemId === 'itm_gm').every((m) => m.baked));
  // Move-by-Wire bought before its initiative score was recorded: REA / dice recorded, the +6 initiative is not
  const mbw = { id: 'aug_old', name: 'Move-by-Wire System', catalogId: CAT_ID('cyberware', 'Move-by-Wire System'), kind: 'cyberware', rating: 2, bonus: { attributes: { REA: 2 }, initiativeDice: 1 } };
  const c = pc('pc_bricks');
  c.augmentations.push(mbw as Augmentation);
  c.augmented = { REA: 2 };
  c.initiative = { dice: 2, bonus: 0 };
  const m2 = collectModifiers(c, lookup).filter((m) => m.source.itemId === 'aug_old');
  assert.deepEqual(m2.filter((m) => m.type !== 'limit').map((m) => [m.type, m.value, !!m.baked, !!m.unbaked]).sort(),
    [['attribute', 2, true, false], ['initiative', 6, false, true], ['initiativeDice', 1, true, false]]);
  // Imports (Jane's fvtt_ Improved Reflexes) stay baked
  assert.ok(collectModifiers(pc('pc_jane'), lookup).filter((m) => m.type === 'initiativeDice').every((m) => m.baked));
  assert.deepEqual(bonusFromEffects(INDEX.files!.cyberware[mbw.catalogId].effects, mbw as { choice?: string }), { initiative: 'FixedValues(3,6,9)', initiativeDice: 'FixedValues(0,1,1)', attributes: { REA: 'Rating' } });
  assert.deepEqual(bonusFromEffects(INDEX.files!.powers[CAT_ID('powers', 'Improved Physical Attribute')].effects, { choice: 'agi' }), { attributes: { AGI: 'Rating' } });
});
await test('Damage Compensators: boxes ignored over BOTH tracks (Physical first), High Pain Tolerance per track', () => {
  const dc = CAT_ID('bioware', 'Damage Compensators');
  assert.equal(INDEX.files!.bioware[dc].effects![0].target, 'sharedThresholdOffset');
  const a = pc('pc_anthony');
  a.augmentations.push({ id: 'aug_dc', name: 'Damage Compensators', catalogId: dc, kind: 'bioware', rating: 3 } as Augmentation);
  a.condition = { physical: 3, stun: 3, overflow: 0 };
  assert.equal(derivedWithModifiers(a, collectModifiers(a, lookup)).woundModifier, -1, '3 boxes shared: physical 0 + stun 3 → −1 (not 0)');
  a.condition = { physical: 2, stun: 4, overflow: 0 };
  assert.equal(derivedWithModifiers(a, collectModifiers(a, lookup)).woundModifier, -1, 'physical 2 → 0, stun 4 − 1 = 3 → −1');
  const h = pc('pc_anthony');
  h.qualities.push({ id: 'q_hpt', name: 'High Pain Tolerance', catalogId: 'b7866fb4-3747-4caf-9240-69cbdd79ce78', karma: 7 } as Quality);
  h.condition = { physical: 3, stun: 3, overflow: 0 };
  assert.equal(derivedWithModifiers(h, collectModifiers(h, lookup)).woundModifier, 0, 'per track: 1 box ignored on each');
});
await test('one outfit at a time: only the best non-stacking worn armor (+ stacking pieces) brings its effects', () => {
  const j = pc('pc_jane');
  const costume = j.armor.find((x) => /Actioneer/.test(x.name))!;
  costume.equipped = true;
  assert.equal(derivedWithModifiers(j, collectModifiers(j, lookup)).limitsAlt.social, 11, 'Heritage (14) is the outfit worn');
  costume.rating = 20;
  const mods = collectModifiers(j, lookup);
  assert.ok(!mods.some((m) => m.source.name === 'Zoé : Heritage 12'), 'Heritage under a better outfit: no effect');
  assert.equal(derivedWithModifiers(j, mods).limitsAlt.social, undefined);
});
await test('test claims: a test key only on its own attributes (no skill, no weapon); resistance tests skip wounds', () => {
  assert.equal(checkedTest('soak', { attr: 'BOD' }), 'soak');
  assert.equal(checkedTest('soak', { skillId: 'con', attr: 'BOD' }), null);
  assert.equal(checkedTest('soak', { attr: 'CHA' }), null);
  assert.equal(checkedTest('judgeIntentions', { attr: 'INT', attr2: 'CHA' }), 'judgeIntentions');
  assert.equal(checkedTest('defense', { attr: 'REA', attr2: 'INT', weaponId: 'w' }), null);
  assert.equal(checkedTest('drainResist', { attr: 'WIL', attr2: 'CHA' }), 'drainResist');
  assert.ok(!woundsApply('soak') && !woundsApply('drainResist') && woundsApply('defense') && woundsApply(null));
});
await test('imports keep the physical limit as « Physical »: Chummer Unarmed Attack, Foundry thrown / unarmed weapons', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'chummer-test.chum5'), 'utf8');
  const { actor } = parseChum5(xml, { keepXml: false });
  const unarmed = actor.weapons.find((w) => w.name === 'Unarmed')!; // texts in English by default (« Mains nues » on a French table)
  assert.equal(unarmed.accuracy, 'Physical');
  const fa = {
    _id: 'fa1', name: 'Test', type: 'character',
    system: { attributes: { body: { base: 3 }, agility: { base: 3 }, reaction: { base: 3 }, strength: { base: 6 }, willpower: { base: 3 }, logic: { base: 3 }, intuition: { base: 3 }, charisma: { base: 3 }, edge: { base: 2 }, essence: { base: 6 } } },
    items: [
      { _id: 'w1', type: 'weapon', name: 'Throwing Knife', system: { category: 'thrown', action: { skill: 'throwing_weapons', limit: { base: 6, value: 0 }, damage: { base: 1 } } } },
      { _id: 'w2', type: 'weapon', name: 'Unarmed Attack', system: { category: 'melee', action: { skill: 'unarmed_combat', limit: { base: 6, value: 0 }, damage: {} } } },
      { _id: 'w3', type: 'weapon', name: 'Boomerang', system: { category: 'thrown', action: { skill: 'throwing_weapons', limit: { base: 5, value: 0 }, damage: {} } } },
      { _id: 'w4', type: 'weapon', name: 'Ares Predator V', system: { category: 'range', action: { skill: 'pistols', limit: { base: 0, value: 7 }, damage: { base: 8 } } },
        flags: { shadowrun5e: { embeddedItems: [{ _id: 'm1', type: 'modification', name: 'Laser Sight', system: { type: 'weapon', mod_weapon: { accuracy: 1, mount_point: 'top' } } }] } } },
    ],
  };
  // Older converter versions returned { actor }: the test reads either shape.
  const conv: ConvertedSheet & { actor?: { weapons: FoundryWeapon[] } } = convertSheet(fa, {});
  const acc = (n: string) => conv.actor ? conv.actor.weapons.find((w) => w._en === n || w.name === n)?.accuracy : (conv.weapons || []).find((w) => w._en === n || w.name === n)?.accuracy;
  const phys = Math.ceil((6 * 2 + 3 + 3) / 3);
  assert.equal(phys, 6);
  assert.equal(acc('Throwing Knife'), 'Physical');
  assert.equal(acc('Mains nues') ?? acc('Unarmed Attack'), 'Physical');
  assert.equal(acc('Boomerang'), 'Physical-1');
  assert.notEqual(acc('Ares Predator V'), 7, 'limit.value (Laser Sight included) not taken when an accessory adds Accuracy');
});

// ---------------------------------------------------------------------------
console.log('Character creator: weapon accessories and armor mods');
// ---------------------------------------------------------------------------
await test('chargen offers accessories / armor mods, installed on a weapon / armor of the draft (fit + target price)', () => {
  const BY = new Map<string, { item: CatalogItem; file: CatalogFile }>();
  for (const f of ['weapons', 'armor', 'gear', 'accessories', 'armormods'] as CatalogFile[]) for (const it of catalog(f)) BY.set(it.id, { item: it, file: f });
  const find = (f: string, n: string) => [...BY.values()].find((e) => e.file === f && e.item.name === n)!;
  const w = find('weapons', 'Ares Predator V');
  const acc = find('accessories', 'Laser Sight');
  const ar = find('armor', 'Armor Jacket');
  const mod = find('armormods', 'Fire Resistance');
  const ctx = { lookup: (id: string) => BY.get(id) || null, rules, settings: {} };
  const d = emptyDraft();
  d.gear = [
    { id: 'g1', ref: w.item.id, file: 'weapons', qty: 1 },
    { id: 'g2', ref: acc.item.id, file: 'accessories', qty: 1, target: 'g1' },
    { id: 'g3', ref: ar.item.id, file: 'armor', qty: 1 },
    { id: 'g4', ref: mod.item.id, file: 'armormods', qty: 1, rating: 2, target: 'g3' },
    { id: 'g5', ref: acc.item.id, file: 'accessories', qty: 1, target: 'g1' },
    { id: 'g6', ref: mod.item.id, file: 'armormods', qty: 1, rating: 2 },
  ] as DraftData['gear']; // rows as the client sends them: normalizeDraft fills the rest
  const r = compute(d, ctx);
  const line = (id: string) => r.gearLines.find((l) => l.row.id === id)!;
  assert.equal(line('g2').mount, 'Top');
  assert.equal(line('g4').capacity, 2);
  const gearErr = r.errors.filter((e) => e.step === 'gear').map((e) => e.key);
  assert.ok(gearErr.includes('{item} is already installed on {weapon}'), 'second Laser Sight refused');
  assert.ok(gearErr.includes('{name}: choose the armor to install it on.'), 'mod without target refused');
  const { actor } = buildActor(d, ctx, {});
  const pistol = actor.weapons.find((x) => x.catalogId === w.item.id)!;
  assert.deepEqual(pistol.mounts, (w.item.stats as WeaponStats).mounts);
  assert.ok(pistol.accessories!.some((a) => a.included && /Smartgun/.test(a.name)), 'included Smartgun System');
  const ls = pistol.accessories!.filter((a) => a.catalogId === acc.item.id);
  assert.equal(ls.length, 1);
  assert.deepEqual(ls[0].effects, { accuracy: 1 });
  assert.equal(ls[0].paid, line('g2').total);
  const jacket = actor.armor.find((x) => x.catalogId === ar.item.id)!;
  assert.equal(jacket.mods!.length, 1);
  assert.deepEqual(jacket.mods![0].bonus, { fire: 2 });
});

// ---------------------------------------------------------------------------
console.log('Quality coverage: hand-written effects, automation status, echoes (issues #1, #2)');
// ---------------------------------------------------------------------------
const actorWith = (qualities: Array<Partial<Quality>>, extra: Partial<Actor> = {}): Actor =>
  ({ ...pc('pc_jane'), qualities: qualities.map((q, i) => ({ id: `q${i}`, karma: 0, ...q })) as Quality[], powers: [], augmentations: [], gear: [], armor: [], ...extra }) as Actor;
const qCat = catalog('qualities');
const qByName = (n: string) => qCat.find((q) => q.name === n)!;

await test('normalizer: creation-only tags → chargen, reputation / living persona / ambidextrous are read', () => {
  const eff = normalizeBonus({ enabletab: { name: 'magician' }, notoriety: '1', livingpersona: { attack: '2' }, ambidextrous: '' });
  assert.deepEqual(strip(eff), [
    { type: 'chargen' },
    { type: 'stat', target: 'notoriety', value: 1 },
    { type: 'personaAttribute', target: 'attack', value: 2 },
    { type: 'flag', target: 'ambidextrous', value: 1 },
  ]);
  assert.ok(!collectModifiers(actorWith([{ name: 'Magician', catalogId: qByName('Magician').id }]), lookup).length, 'chargen effects never become modifiers');
});

await test('vision senses come from catalog effects (flag lowLightVision / thermographicVision), names only for unknown items', () => {
  const v = (a: Partial<ActorLike>, lk: typeof lookup | null = lookup) => tokenVision(null, { metatype: 'Humain', ...a } as ActorLike, lk);
  assert.equal(v({ qualities: [{ name: 'Low-Light Vision' }] } as Partial<ActorLike>).lowLight, true, 'metatype quality (index-only entry)');
  assert.equal(v({ qualities: [{ name: 'Night Vision' }] } as Partial<ActorLike>).lowLight, true, 'Night Vision (RF 148) grants low-light');
  assert.equal(v({ qualities: [{ name: 'Nocturne' }] } as Partial<ActorLike>).lowLight, false, 'Nocturnal (French « Nocturne »): a sleep cycle, not a sense');
  assert.equal(v({ qualities: [{ name: 'Nocturne' }] } as Partial<ActorLike>, null).lowLight, true, 'without the index: the old name guess');
  assert.equal(v({ qualities: [{ name: 'Thermal Sensitivity' }] } as Partial<ActorLike>).thermo, false);
  assert.equal(v({ qualities: [{ name: 'Thermographic Vision (SURGE)' }] } as Partial<ActorLike>).thermo, true);
  assert.equal(v({ augmentations: [{ name: 'Thermographic Vision' }] } as Partial<ActorLike>).thermo, true, 'eye implant (SR5 p. 453)');
  assert.equal(v({ augmentations: [{ name: 'Targeting Laser (Infrared)' }] } as Partial<ActorLike>).thermo, false, 'a laser, not a sense');
  assert.equal(v({ augmentations: [{ name: 'Thermographic Vision', disabled: true }] } as Partial<ActorLike>).thermo, false, 'disabled implant');
  assert.equal(v({ augmentations: [{ name: 'Yeux de chat (vision nocturne)' }] } as Partial<ActorLike>).lowLight, true, 'home-made item: name guess');
  assert.equal(v({ qualities: [{ name: 'Low-Light Vision' }], vision: { lowLight: false } } as Partial<ActorLike>).lowLight, false, 'the sheet switch wins');
  assert.equal(tokenVision(null, { metatype: 'Troll' } as ActorLike, lookup).thermo, true, 'metatype');
});

await test('automation status: index `manual` and qualityAutomation() (automated, partly, not automated, creation only, home-made)', () => {
  const st = (n: string) => qualityAutomation({ catalogId: qByName(n).id, name: n }, lookup);
  assert.equal(st('Toughness'), 'auto');
  assert.equal(st('Magician'), 'auto', 'creation only: nothing to do at the table');
  assert.equal(st('Agile Defender'), 'auto', 'handled by the full defense options');
  assert.equal(st('Juryrigger'), 'some');
  assert.equal(st('Gremlins'), 'all');
  assert.equal(st('Addiction (Mild)'), 'all', 'notoriety alone does not make it automated');
  assert.equal(qualityAutomation({ name: 'Régénération Lazarus' }, lookup), 'custom');
  assert.equal(qualityAutomation({ name: 'Gremlins' }, lookup), 'all', 'matched by name (Foundry imports)');
  // Metatype senses (SR5 p. 66): hidden in Chummer, index entry only, so not « home-made »
  assert.equal(qualityAutomation({ name: 'Low-Light Vision' }, lookup), 'auto');
  assert.equal(qualityAutomation({ name: 'Thermographic Vision' }, lookup), 'auto');
  assert.equal(qualityAutomation({ name: 'Vision nocturne' }, lookup), 'auto', 'the app’s French name');
  assert.equal(st('Night Vision'), 'some', 'sun glare left to the GM');
  assert.equal(st('Low-Light Vision (Changeling)'), 'auto');
  assert.equal(st('Thermal Sensitivity'), 'all', 'a heat sense, not thermographic vision');
  const cov = fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'qualities-coverage.md'), 'utf8');
  assert.match(cov, /\| Gremlins \| SR5 81 \|/);
  assert.match(cov, /## Not automated \(\d+\)/);
});

await test('hand-written effects: Guts on Composure with its switch, Accident Prone on vehicle tests (not Gunnery), Natural Hardening on biofeedback', () => {
  const a = actorWith([
    { name: 'Guts', catalogId: qByName('Guts').id },
    { name: 'Accident Prone', catalogId: qByName('Accident Prone').id },
    { name: 'Natural Hardening', catalogId: qByName('Natural Hardening').id },
  ]);
  const mods = collectModifiers(a, lookup);
  const comp = poolModifiers(mods, rollContext(a, { test: 'composure', attr: 'CHA', attr2: 'WIL' }));
  assert.equal(comp.total, 0, 'Guts needs « resisting fear or intimidation »');
  assert.deepEqual(comp.toggles.map((x) => x.key), ['q-fear']);
  assert.equal(poolModifiers(mods, rollContext(a, { test: 'composure', attr: 'CHA', attr2: 'WIL' }), { conditions: ['q-fear'] }).total, 2);
  assert.equal(poolModifiers(mods, rollContext(a, { skillId: 'pilot_ground_craft' })).total, -2);
  assert.equal(poolModifiers(mods, rollContext(a, { skillId: 'gunnery' })).total, 0);
  assert.equal(poolModifiers(mods, rollContext(a, { test: 'biofeedback', attr: 'WIL' })).total, 1);
  assert.equal(CONDITIONS['q-fear'].label, 'resisting fear or intimidation');
});

await test('Data Trails qualities: I C U on Matrix Perception (switch), Snooper on Snoop', () => {
  const a = actorWith([{ name: 'I C U', catalogId: qByName('I C U').id }, { name: 'Snooper', catalogId: qByName('Snooper').id }]);
  const mods = collectModifiers(a, lookup);
  const ctx = (id: string) => ({ ...rollContext(a, { skillId: ACTION_BY_ID[id].skill, attr: ACTION_BY_ID[id].attr }), actionId: id });
  assert.equal(poolModifiers(mods, ctx('matrixPerception')).total, 0);
  assert.equal(poolModifiers(mods, ctx('matrixPerception'), { conditions: ['q-icu'] }).total, 2);
  assert.equal(poolModifiers(mods, ctx('snoop')).total, 2);
  assert.equal(poolModifiers(mods, ctx('hackOnTheFly')).total, 0);
});

await test('echoes: NeuroFilter (+1 biofeedback), Overclocking (+1D6 in hot-sim only), upgrades shown, unknown echoes ignored', () => {
  const a = actorWith([], { magic: { initiation: 0, submersion: 2, metamagics: [], echoes: ['NeuroFilter', 'Overclocking', 'Attack Upgrade', 'Resonance Link'] } } as Partial<Actor>);
  const mods = collectModifiers(a, lookup);
  assert.equal(mods.filter((m) => m.source.list === 'echoes').length, 3);
  assert.equal(poolModifiers(mods, rollContext(a, { test: 'biofeedback', attr: 'WIL' })).total, 1);
  assert.equal(matrixInitiative(a, { mode: 'hot' }, 'hot', mods).dice, 5);
  assert.equal(matrixInitiative(a, { mode: 'cold' }, 'cold', mods).dice, 3);
  const up = mods.find((m) => m.type === 'personaAttribute')!;
  assert.ok(up.info && up.target === 'attack' && up.source.book === 'SR5' && up.source.page === 258);
});

// ---------------------------------------------------------------------------
console.log('Server: dice/roll authority (port 3500)');
// ---------------------------------------------------------------------------
const srv = await startServer({ port: 3500 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const jane = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  const bricks = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  await settle();

  await test('Jane rolls Con: pool 14, limit 9; with « visible »: limit 11 and the Heritage line in the log (source + book)', async () => {
    const r1 = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con' });
    assert.equal(r1.pool, 14);
    assert.equal(r1.limit, 9);
    assert.equal(r1.limitLabel, 'social');
    const off = r1.mods.find((m) => m.name === 'Zoé : Heritage 12')!;
    assert.equal(off.state, 'off');
    const r2 = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', useSpec: true, conditions: ['visible'] });
    assert.equal(r2.pool, 16);
    assert.equal(r2.limit, 11);
    const on = r2.mods.find((m) => m.name === 'Zoé : Heritage 12')!;
    assert.deepEqual([on.kind, on.state, on.value, on.condition, on.book, on.page], ['limit', 'applied', 2, 'visible', 'RG', 62]);
    assert.match(r2.limitBreakdown, /Heritage 12 \+2/);
    await settle();
    const entry = gm.state.log.filter((e) => e.kind === 'roll').at(-1)!;
    assert.equal(entry.roll!.limit, 11);
    assert.deepEqual(entry.roll!.conditions, ['visible']);
  });
  await test('a player cannot inject modifiers: unknown switches dropped, client « mods » ignored, maluses kept, limit not raised', async () => {
    const r = await jane.send<Roll>('dice/roll', {
      actorId: 'pc_jane', skillId: 'con', conditions: ['bogus', 'wireless', 'visible'], mods: [{ type: 'limit', target: 'social', value: 10 }],
      effects: [{ type: 'skill', target: 'con', value: 10 }], limit: 30,
    });
    assert.deepEqual(r.conditions, ['visible']);
    assert.equal(r.pool, 14);
    assert.equal(r.limit, 11, 'limit clamped to the computed one');
    // Bricks has no « visible » effect: the switch is not even known
    const rb = await bricks.send<Roll>('dice/roll', { actorId: 'pc_bricks', skillId: 'hacking', conditions: ['visible'] });
    assert.equal(rb.conditions, undefined);
    // A negative modifier (Dimmer Bulb, GM-given) cannot be dropped by the player, the GM can
    await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'qualities', item: { name: 'Dimmer Bulb', catalogId: '7706ce23-77c2-470f-bb7e-6a4e56fa78fe', karma: -5, positive: false, rating: 1 } });
    const r2 = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'forgery' });
    const malus = r2.mods.find((m) => m.name === 'Dimmer Bulb' && m.state === 'applied')!;
    assert.equal(malus.value, -1);
    const r3 = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'forgery', ignore: [malus.id] });
    assert.equal(r3.pool, r2.pool, 'player cannot drop a malus');
    const r4 = await gm.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'forgery', ignore: [malus.id] });
    assert.equal(r4.pool, r2.pool + 1, 'GM can');
    assert.equal(r4.mods.find((m) => m.id === malus.id)!.state, 'ignored');
    // ... but the player may leave out one of her own bonuses
    const r5 = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', conditions: ['visible'], ignore: [on11(r)] });
    assert.equal(r5.limit, 9);
  });
  await test('weapon attack: server limit = Accuracy + accessories, accessory dice added (weaponId)', async () => {
    const w = gm.state.actors.pc_jane.weapons.find((x) => x.name === 'Enfield AS-7')!;
    const r = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    assert.equal(r.limit, 5);
    assert.equal(r.limitLabel, 'accuracy');
    await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', item: { name: 'Test grip', mount: 'Under', effects: { dicePool: 1 } } });
    const r2 = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    assert.equal(r2.pool, r.pool + 1);
    await rejects(jane.send<Roll>('dice/roll', { actorId: 'pc_jane', weaponId: 'nope' }), /Weapon not found/);
  });
  await test('soak test: Body + armor computed by the server (client figure ignored); Matrix tests use the device attribute as limit', async () => {
    const st = gm.state.actors.pc_jane;
    const r = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', attr: 'BOD', test: 'soak', limit: null, bonus: [] });
    assert.equal(r.pool, attr(st, 'BOD') + derivedWithModifiers(st, collectModifiers(st, lookup)).armor);
    const m = gm.state.actors.pc_bricks.matrix!;
    const rm = await bricks.send<Roll>('dice/roll', { actorId: 'pc_bricks', skillId: 'hacking', matrixLimit: 'sleaze' });
    assert.equal(rm.limit, m.sleaze);
    assert.equal(rm.limitLabel, 'Sleaze');
  });
  await test('gear « active » switch: players may toggle it on their own gear; effects then reach the roll', async () => {
    await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'gear', item: { name: 'Spellcasting Focus, Combat', catalogId: '2f485376-54c1-41be-8678-79cc98e04ebc', rating: 2, qty: 1 } });
    await settle();
    const g = gm.state.actors.pc_jane.gear.find((x) => x.catalogId === '2f485376-54c1-41be-8678-79cc98e04ebc')!;
    await jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: g.id, patch: { active: true } });
    await settle();
    assert.equal(gm.state.actors.pc_jane.gear.find((x) => x.id === g.id)!.active, true);
    await rejects(jane.send('actor/updateItem', { actorId: 'pc_jane', list: 'gear', itemId: g.id, patch: { choice: 'Con' } }));
  });
  await test('GM edits keep shop-only sub-item fields (paid, extraMount, armor-mod bonus, vehicle-mod effects)', async () => {
    const a = gm.state.actors.pc_jane;
    const w = a.weapons.find((x) => x.name === 'Enfield AS-7')!;
    const subId = await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', item: { name: 'Slide', mount: 'Side', paid: 120, extraMount: ['Top'] } });
    await gm.send('actor/updateSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: w.id, sub: 'accessories', subId, patch: { notes: 'ok', paid: 100 } });
    const ar = a.armor.find((x) => x.equipped)!;
    const modId = await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'armor', itemId: ar.id, sub: 'mods', item: { name: 'Fire Resistance', capacity: 2, bonus: { fire: 2 }, paid: 500 } });
    await gm.send('actor/updateSubItem', { actorId: 'pc_jane', list: 'armor', itemId: ar.id, sub: 'mods', subId: modId, patch: { notes: 'x' } });
    await settle();
    const s = gm.state.actors.pc_jane;
    const acc = s.weapons.find((x) => x.id === w.id)!.accessories!.find((x) => x.id === subId)!;
    assert.deepEqual([acc.paid, acc.extraMount, acc.notes], [100, ['Top'], 'ok']);
    const m = s.armor.find((x) => x.id === ar.id)!.mods!.find((x) => x.id === modId)!;
    assert.deepEqual([m.paid, m.bonus], [500, { fire: 2 }]);
  });

  // --- Regressions of the review « modifiers engine » ------------------------------------------------------------------------
  await test('grunt / drone with a stun monitor of 0: stun damage goes to Physical, never « hors de combat » from one stun box', async () => {
    const id = await gm.send('actor/create', { type: 'npc', name: 'Drone test', monitors: { physical: 9, stun: 0 } });
    const r = await gm.send('actor/damage', { actorId: id, amount: 2, type: 'S' });
    assert.deepEqual([r.condition.physical, r.condition.stun], [2, 0]);
    assert.notEqual(r.status, 'hors de combat');
  });
  await test('GM-added power / implant / quality: their attribute, initiative dice and initiative score are stored (and reversed)', async () => {
    const ini0 = { ...gm.state.actors.pc_bricks.initiative };
    const rea0 = gm.state.actors.pc_bricks.augmented?.REA || 0;
    const pw = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'powers', item: { name: 'Improved Reflexes', catalogId: CAT_ID('powers', 'Improved Reflexes'), level: 2, pp: 2.5, bonus: { attributes: { REA: 9 } } } });
    const mbw = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'augmentations', item: { name: 'Move-by-Wire System', catalogId: CAT_ID('cyberware', 'Move-by-Wire System'), kind: 'cyberware', rating: 2, essence: 0 } });
    const lr = await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'qualities', item: { name: 'Lightning Reflexes', catalogId: CAT_ID('qualities', 'Lightning Reflexes'), karma: 20, positive: true } });
    await settle();
    let b = gm.state.actors.pc_bricks;
    assert.equal(b.augmented!.REA, rea0 + 4, 'Improved Reflexes 2 + Move-by-Wire 2 (the client bonus is ignored)');
    assert.equal(b.initiative!.dice, Math.min(5, ini0.dice! + 2 + 1 + 1));
    assert.equal(b.initiative!.bonus, (ini0.bonus || 0) + 6 + 1, 'Move-by-Wire 2 +6, Lightning Reflexes +1');
    assert.deepEqual(b.powers.find((x) => x.id === pw)!.bonus, { attributes: { REA: 2 }, initiativeDice: 2 });
    assert.deepEqual(b.qualities.find((x) => x.id === lr)!.bonus, { initiativeDice: 1, initiative: 1 });
    const mods = collectModifiers(b, lookup).filter((m) => [pw, mbw, lr].includes(m.source.itemId) && ['attribute', 'initiativeDice', 'initiative'].includes(m.type));
    assert.ok(mods.length >= 6 && mods.every((m) => m.baked && !m.unbaked), 'all « déjà compté », for real');
    // Level change follows; removal gives everything back
    await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'powers', itemId: pw, patch: { level: 3 } });
    await settle();
    assert.equal(gm.state.actors.pc_bricks.augmented!.REA, rea0 + 5);
    for (const [list, itemId] of [['powers', pw], ['augmentations', mbw], ['qualities', lr]]) await gm.send('actor/removeItem', { actorId: 'pc_bricks', list, itemId });
    await settle();
    b = gm.state.actors.pc_bricks;
    assert.equal(b.augmented?.REA || 0, rea0);
    assert.deepEqual([b.initiative!.dice, b.initiative!.bonus || 0], [ini0.dice, ini0.bonus || 0]);
  });
  await test('wound modifier: players cannot drop it (applyWounds: false ignored), the GM can; damage resistance tests skip it', async () => {
    await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { stun: 6 } } });
    const r = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', applyWounds: false });
    assert.equal(r.pool, 14 - 2);
    assert.match(r.breakdown, /wounds −2/);
    const g = await gm.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', applyWounds: false });
    assert.equal(g.pool, 14);
    const st = gm.state.actors.pc_jane;
    const soak = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', attr: 'BOD', test: 'soak', limit: null });
    assert.equal(soak.pool, attr(st, 'BOD') + derivedWithModifiers(st, collectModifiers(st, lookup)).armor, 'soak: no wounds');
    await gm.send('actor/update', { actorId: 'pc_jane', patch: { condition: { stun: 0 } } });
  });
  await test('test claims are checked: « soak » / « judgeIntentions » on another roll add nothing', async () => {
    const r = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', test: 'soak' });
    assert.equal(r.pool, 14, 'no armor on a skill test');
    const j = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', test: 'judgeIntentions' });
    assert.equal(j.pool, 14);
    const c = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', attr: 'CHA', test: 'soak', limit: null });
    assert.equal(c.pool, attr(gm.state.actors.pc_jane, 'CHA'));
  });
  await test('weapon attack: a player cannot swap the skill (the weapon\'s own is used), matrixLimit only on Matrix skills', async () => {
    const w = gm.state.actors.pc_jane.weapons.find((x) => x.name === 'Ares Desert Strike')!;
    const r = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: 'sneaking' });
    const normal = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', weaponId: w.id, skillId: w.skill });
    assert.equal(r.pool, normal.pool);
    assert.ok(!/Furtivité|Sneaking/.test(r.breakdown), r.breakdown);
    await gm.send('actor/update', { actorId: 'pc_bricks', patch: { matrix: { attack: 9 } } });
    const con = await bricks.send<Roll>('dice/roll', { actorId: 'pc_bricks', skillId: 'con', matrixLimit: 'attack' });
    assert.equal(con.limitLabel, 'social');
    const pair = await bricks.send<Roll>('dice/roll', { actorId: 'pc_bricks', attr: 'CHA', attr2: 'INT', matrixLimit: 'attack' });
    assert.equal(pair.limit, null);
    const hack = await bricks.send<Roll>('dice/roll', { actorId: 'pc_bricks', skillId: 'cybercombat', matrixLimit: 'attack' });
    assert.equal(hack.limit, 9);
  });
  await test('limits: a player cannot remove a computed limit (null / 0), the GM can; a limit lowered to 0 stays 1', async () => {
    for (const limit of [null, 0]) assert.equal((await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', limit })).limit, 9);
    assert.equal((await gm.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', limit: null })).limit, null);
    const id = await gm.send('actor/create', { type: 'npc', name: 'Faible', attributes: { CHA: 1, WIL: 1, ESS: 0.5 } });
    await gm.send('actor/addItem', { actorId: id, list: 'augmentations', item: { name: 'Move-by-Wire System', catalogId: CAT_ID('cyberware', 'Move-by-Wire System'), kind: 'cyberware', rating: 2 } });
    await gm.send('actor/addItem', { actorId: id, list: 'skills', item: { id: 'con', name: 'Escroquerie', rating: 4 } });
    await gm.send('actor/addItem', { actorId: id, list: 'qualities', item: { name: 'Liar', catalogId: CAT_ID('qualities', 'Liar'), karma: -5, positive: false } });
    const r = await gm.send<Roll>('dice/roll', { actorId: id, skillId: 'con' });
    assert.equal(r.limit, 1, 'social limit 2 − 2 − 1 → floored at 1, not « no limit »');
  });
  await test('player bonus lines: only the sheet\'s own, recomputed (VOL, Firewall); anything else goes under « mod. »', async () => {
    const r = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', skillId: 'con', bonus: [{ label: 'Codeslinger', value: 50 }], modifier: 50 });
    assert.equal(r.pool, 14 + 50);
    assert.ok(!/Codeslinger/.test(r.breakdown), r.breakdown);
    const st = gm.state.actors.pc_jane;
    const d = await jane.send<Roll>('dice/roll', { actorId: 'pc_jane', attr: 'REA', attr2: 'INT', test: 'defense', bonus: [{ label: 'VOL', value: 40 }] });
    assert.equal(d.pool, derivedWithModifiers(st, collectModifiers(st, lookup)).defense + attr(st, 'WIL'));
  });
  await test('Matrix situation switches come from the persona: a player offline cannot turn « dans un hôte » on', async () => {
    await gm.send('actor/addItem', { actorId: 'pc_bricks', list: 'qualities', item: { name: 'Sloppy Code', catalogId: CAT_ID('qualities', 'Sloppy Code'), karma: -5, positive: false } });
    const r = await bricks.send<Roll>('dice/roll', { actorId: 'pc_bricks', skillId: 'sneaking', conditions: ['in-host'] });
    assert.equal(r.conditions, undefined);
    assert.ok(!r.mods.some((m) => m.name === 'Sloppy Code' && m.state === 'applied'));
    const g = await gm.send<Roll>('dice/roll', { actorId: 'pc_bricks', skillId: 'sneaking', conditions: ['in-host'] });
    assert.ok(g.mods.some((m) => m.name === 'Sloppy Code' && m.state === 'applied'), 'GM, no persona: the switch is kept');
  });
  await test('i18n: the stored limit labels of the server (sociale, mentale…) map to English keys that have a French entry', () => {
    // Rolls store the French limit label (limitLabel); the client renders it through the legacy key map.
    const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, 'client', 'i18n', 'legacy-fr-keys.json'), 'utf8')) as Record<string, string>;
    const dir = path.join(ROOT, 'client', 'i18n', 'fr');
    const fr = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))) as Record<string, string>;
    const expected: Record<string, string> = { physique: 'physical', mentale: 'mental', sociale: 'social', astrale: 'astral' };
    for (const [k, en] of Object.entries(expected)) {
      const key = legacy[k];
      assert.ok(key, `legacy key for ${k}`);
      assert.equal(key.replace(/^.*::/, ''), en, `English text of ${k}`);
      assert.equal(fr[key], k, `French entry of ${key}`);
    }
  });
} finally {
  srv.stop();
}

/** Id of the Heritage limit line of a roll result (helper of the « player may drop her own bonus » check). */
function on11(r: Roll) {
  return r.mods.find((m) => m.name === 'Zoé : Heritage 12')!.id;
}

console.log(failures ? `\n${failures} failed` : '\nAll green.');
process.exit(failures ? 1 : 0);
