// Training module tests: node tools/test-training.ts (exit code ≠ 0 on failure).
// Unit-tests shared/advancement.ts, then drives server/modules/50-training.ts through an isolated server.
import fs from 'node:fs';
import {
  costFor, timeFor, formatDays, withInstructor, validate, quote, applyAdvance, attrMax, groupState, powerPoints,
} from '../shared/advancement.ts';
import type { CostOptions } from '../shared/advancement.ts';
import type { Actor, Quality, TrainingJob, TrainingKind, TrainingRequest, TrainingSettings } from '../shared/types.ts';
import type { TestClient } from './test-client.ts';

let failures = 0;
let passes = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}
const eq = (a: unknown, b: unknown, label: string) => check(JSON.stringify(a) === JSON.stringify(b), `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
async function rejects(promise: Promise<unknown>, re: RegExp, label: string) {
  try {
    await promise;
    check(false, `${label} (should have failed)`);
  } catch (e) {
    check(re.test((e as Error).message), `${label} (message: ${(e as Error).message})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
// Partial actors (only the fields the rules read), cast to Actor.
const sam = (): Actor => ({
  id: 'pc_t_sam', type: 'pc', name: 'Sam Test', metatype: 'Humain',
  attributes: { BOD: 5, AGI: 6, REA: 5, STR: 4, WIL: 3, LOG: 2, INT: 4, CHA: 2, EDG: 3, ESS: 4.2 },
  condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 3 },
  skills: [
    { id: 'blades', name: 'Armes tranchantes', attr: 'AGI', rating: 6 },
    { id: 'pistols', name: 'Pistolets', attr: 'AGI', rating: 3, group: 'firearms' },
    { id: 'gymnastics', name: 'Gymnastique', attr: 'AGI', rating: 2, group: 'athletics' },
    { id: 'running', name: 'Course', attr: 'STR', rating: 2, group: 'athletics' },
    { id: 'swimming', name: 'Natation', attr: 'STR', rating: 2, group: 'athletics' },
  ],
  skillGroups: [{ id: 'athletics', rating: 2 }],
  knowledge: [
    { id: 'kn_gangs', name: 'Gangs de Seattle', rating: 3, type: 'street' },
    { id: 'kn_en', name: 'Anglais', rating: 0, type: 'language', native: true },
  ],
  qualities: [{ id: 'q_acc', name: 'Accident Prone', karma: 4, positive: false }],
  powers: [], spells: [], weapons: [], armor: [], augmentations: [], gear: [], vehicles: [], contacts: [], sins: [],
  karma: 60, karmaTotal: 100, nuyen: 5000, history: [],
}) as unknown as Actor;
const jane = (): Actor => ({
  id: 'pc_t_jane', type: 'pc', name: 'Jane Test', metatype: 'Humain',
  attributes: { BOD: 2, AGI: 6, REA: 6, STR: 2, WIL: 3, LOG: 4, INT: 5, CHA: 6, EDG: 3, MAG: 5, ESS: 6 },
  skills: [{ id: 'con', name: 'Escroquerie', attr: 'CHA', rating: 6 }], skillGroups: [], knowledge: [],
  qualities: [{ id: 'q_adept', name: 'Adepte', karma: 20, positive: true }],
  powers: [{ id: 'pw1', name: 'Kinésique', pp: 1 }, { id: 'pw2', name: 'Réflexes améliorés', level: 1, pp: 1.5, catalogId: 'ir' }],
  spells: [], karma: 20, karmaTotal: 80, nuyen: 1000, history: [],
}) as unknown as Actor;
const mage = (): Actor => ({
  id: 'npc_t_mage', type: 'pc', name: 'Mage Test', metatype: 'Elfe',
  attributes: { BOD: 3, AGI: 3, REA: 3, STR: 2, WIL: 5, LOG: 5, INT: 4, CHA: 5, EDG: 2, MAG: 4, ESS: 4.5 },
  skills: [{ id: 'spellcasting', name: 'Lancement de sorts', attr: 'MAG', rating: 5 }], skillGroups: [], knowledge: [],
  qualities: [{ id: 'q_mag', name: 'Magicien', karma: 30, positive: true }], powers: [], spells: [{ id: 's1', name: 'Boule de feu' }],
  karma: 100, karmaTotal: 150, nuyen: 0, history: [],
}) as unknown as Actor;

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------
const costTable: Array<[TrainingKind, number, number, CostOptions, number]> = [
  ['attribute', 4, 5, {}, 25], ['attribute', 3, 5, {}, 45], ['skill', 0, 1, {}, 2], ['skill', 5, 6, {}, 12], ['skill', 4, 6, {}, 22],
  ['skill', 3, 4, { spec: true }, 15], ['skillGroup', 0, 1, {}, 5], ['skillGroup', 3, 4, {}, 20], ['knowledge', 0, 1, {}, 1],
  ['knowledge', 3, 4, {}, 4], ['specialization', 0, 1, {}, 7], ['quality', 0, 1, { karma: 14 }, 28], ['removeQuality', 1, 0, { karma: 4 }, 8],
  ['spell', 0, 1, {}, 5], ['complexForm', 0, 1, {}, 4], ['power', 0, 1, {}, 0], ['powerPoint', 0, 2, {}, 10],
  ['initiation', 0, 1, {}, 13], ['initiation', 2, 3, {}, 19], ['initiation', 0, 1, { options: { group: true } }, 12],
  ['initiation', 0, 1, { options: { group: true, ordeal: true } }, 11],
];
for (const [k, f, t, o, exp] of costTable) eq(costFor(k, f, t, o), exp, `costFor ${k} ${f}→${t}`);

const timeTable: Array<[TrainingKind, number, number, CostOptions, number]> = [
  ['attribute', 4, 5, {}, 35], ['skill', 0, 1, {}, 1], ['skill', 3, 4, {}, 4], ['skill', 4, 5, {}, 35], ['skill', 8, 9, {}, 126],
  ['skillGroup', 2, 3, {}, 42], ['knowledge', 2, 3, {}, 3], ['knowledge', 4, 5, {}, 35], ['specialization', 0, 1, {}, 30],
  ['quality', 0, 1, { karma: 14 }, 21], ['quality', 0, 1, { karma: 3 }, 7], ['spell', 0, 1, {}, 1], ['initiation', 0, 1, {}, 30], ['power', 0, 1, {}, 0],
];
for (const [k, f, t, o, exp] of timeTable) eq(timeFor(k, f, t, o), exp, `timeFor ${k} ${f}→${t}`);

eq(formatDays(0), 'immediate', 'formatDays 0');
eq(formatDays(1), '1 day', 'formatDays 1');
eq(formatDays(21), '3 weeks', 'formatDays 21');
eq(formatDays(10), '1 week and 3 days', 'formatDays 10');
eq(formatDays(60), '2 months', 'formatDays 60');
eq(withInstructor(35, 'attribute', { instructorTimeReduction: 25, instructorCostPerWeek: { attribute: 1000 } } as Partial<TrainingSettings>), { days: 27, weeks: 4, nuyen: 4000, rate: 1000 }, 'withInstructor');

// Limits
const S = sam();
check(/maximum 6/.test(validate(S, { kind: 'attribute', target: 'AGI' })!), 'AGI 6 → 7 refused for a human');
check(validate({ ...S, qualities: [{ name: 'Attribut exceptionnel (Agilité)', karma: 14, positive: true }] as Quality[] }, { kind: 'attribute', target: 'AGI' }) === null, 'Exceptional Attribute allows AGI 7');
check(validate({ ...S, qualities: [{ name: 'Attribut exceptionnel', notes: 'Force', karma: 14, positive: true }] as Quality[] }, { kind: 'attribute', target: 'AGI' }) !== null, 'Exceptional Attribute (Strength) does not help AGI');
eq(attrMax(S, 'EDG'), 7, 'human Edge max 7');
check(/Awakened/.test(validate(S, { kind: 'attribute', target: 'MAG' })!), 'no MAG for Sam');
eq(attrMax(mage(), 'MAG'), 4, 'MAG max lowered by Essence (4.5)');
check(/maximum 4/.test(validate(mage(), { kind: 'attribute', target: 'MAG' })!), 'MAG 4→5 refused (Essence)');
check(/Not enough karma/.test(validate(jane(), { kind: 'attribute', target: 'WIL', to: 5 })!), 'not enough karma (45 > 20)');
check(validate(jane(), { kind: 'attribute', target: 'BOD' }) === null, 'BOD 2→3 (15) ok');
check(/maximum 12/.test(validate(S, { kind: 'skill', target: 'blades', to: 13 })!), 'skill max 12');
check(/must exceed/.test(validate(S, { kind: 'skill', target: 'blades', to: 6 })!), 'new rating > current');
check(/Awakened/.test(validate(S, { kind: 'skill', target: 'spellcasting' })!), 'magical skill refused');
check(/Native language/.test(validate(S, { kind: 'knowledge', target: 'kn_en' })!), 'native language');
eq(quote(S, { kind: 'skill', target: 'running' }).warnings, ['Breaks the Athletics group'], 'broken group warning');
eq(groupState(S, 'athletics').intact, true, 'group intact');
check(/broken/.test(validate(S, { kind: 'skillGroup', target: 'firearms' })!), 'Firearms group broken (Pistols 3)');
eq(quote(S, { kind: 'skillGroup', target: 'athletics' }).karmaCost, 15, 'group 2→3 = 15');
eq(quote(S, { kind: 'skill', target: 'pistols', instructor: true }).nuyenCost, 500, 'skill instructor 500¥/week');
eq(quote(S, { kind: 'skill', target: 'pistols', instructor: true }).days, 3, 'instructor −25 % (4 → 3 days)');
eq(quote(S, { kind: 'skill', target: 'pistols' }, { useTime: false }).days, 0, 'useTime false → 0 days');
check(/One attribute at a time/.test(validate(S, { kind: 'attribute', target: 'BOD' }, undefined, { active: [{ request: { kind: 'attribute', target: 'STR', to: 5 } }] })!), 'one attribute at a time');
check(/Already in progress/.test(validate(S, { kind: 'skill', target: 'running' }, undefined, { active: [{ label: 'Athletics', request: { kind: 'skillGroup', target: 'athletics' } }] })!), 'group / skill conflict');
check(/Not enough karma/.test(validate(S, { kind: 'attribute', target: 'STR' }, undefined, { reservedKarma: 50 })!), 'karma reserved by pending requests');
eq(powerPoints(jane()), { total: 5, spent: 2.5, free: 2.5, extra: 0 }, 'Jane power points');
check(/Not enough Power Points/.test(validate(jane(), { kind: 'power', name: 'Sens du combat', pp: 1, levels: true, to: 3 })!), 'not enough PP');
check(/Magic/.test(validate(jane(), { kind: 'power', name: 'Sens du combat', pp: 0.25, levels: true, to: 6 })!), 'power level > MAG');
check(/Only magicians/.test(validate(S, { kind: 'spell', name: 'Armure' })!), 'spell refused to a non-magician');
check(/mystic adepts/.test(validate(jane(), { kind: 'powerPoint' })!), 'buying PP is for mystic adepts');
check(/one grade at a time/.test(validate(mage(), { kind: 'initiation', to: 2 })!), 'initiation one grade at a time');

// applyAdvance
{
  const a = sam();
  applyAdvance(a, { kind: 'skill', target: 'running', to: 3 });
  eq(a.skillGroups, [], 'apply: broken group removed');
  eq(a.skills.find((s) => s.id === 'running')!.rating, 3, 'apply: Running 3');
  applyAdvance(a, { kind: 'skill', target: 'sneaking', to: 1, spec: 'Urbain' });
  const sn = a.skills.find((s) => s.id === 'sneaking')!;
  eq([sn.name, sn.attr, sn.rating, sn.spec, sn.group], ['Furtivité', 'AGI', 1, 'Urbain', 'stealth'], 'apply: new skill + specialization');
  applyAdvance(a, { kind: 'skillGroup', target: 'outdoors', to: 1 });
  eq(['survival', 'tracking', 'navigation'].map((id) => a.skills.find((s) => s.id === id)?.rating), [1, 1, 1], 'apply: group turned into skills');
  applyAdvance(a, { kind: 'knowledge', name: 'Japonais', ktype: 'language', to: 2 });
  eq(a.knowledge.find((k) => k.name === 'Japonais')?.rating, 2, 'apply: new language');
  applyAdvance(a, { kind: 'removeQuality', target: 'q_acc' });
  eq(a.qualities.length, 0, 'apply: quality bought off');
  applyAdvance(a, { kind: 'attribute', target: 'EDG', to: 4 });
  eq([a.attributes.EDG, a.edge!.current], [4, 4], 'apply: Edge + point regained');
  const j = jane();
  applyAdvance(j, { kind: 'power', name: 'Réflexes améliorés', catalogId: 'ir', pp: 1, levels: true, to: 2 });
  eq(j.powers.find((p) => p.id === 'pw2'), { id: 'pw2', name: 'Réflexes améliorés', level: 2, pp: 2.5, catalogId: 'ir' }, 'apply: power level');
  const m = mage();
  applyAdvance(m, { kind: 'initiation', to: 1, options: { metamagic: 'Centrage' } });
  eq([m.magic!.initiation, m.magic!.metamagics, attrMax(m, 'MAG')], [1, ['Centrage'], 5], 'apply: initiation');
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------
process.env.SR_TEST_TRAINING_ACTORS = JSON.stringify([sam(), jane(), mage()]);
const { startServer, login, client, settle } = await import('./test-client.ts');
const srv = await startServer({ port: 3105 });
let gm: TestClient | undefined, p1: TestClient | undefined, p2: TestClient | undefined;
try {
  gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueur Sam', characterId: 'pc_t_sam' }));
  p2 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueuse Jane', characterId: 'pc_t_jane' }));
  await settle();
  check(gm.state.training?.settings?.approval === 'always', 'training slice initialized');
  check(gm.state.actors.pc_t_sam, 'fixture loaded');

  // Permissions & validation
  await rejects(p1.send('training/request', { actorId: 'pc_t_jane', kind: 'attribute', target: 'BOD' }), /not yours/, 'a player cannot train another player’s character');
  await rejects(p1.send('training/advanceDays', { days: 3 }), /GM/, 'advanceDays is GM-only');
  await rejects(p1.send('training/updateSettings', { approval: 'never' }), /GM/, 'updateSettings is GM-only');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'attribute', target: 'AGI' }), /maximum/, 'server: metatype maximum');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'nope' }), /Unknown advancement type/, 'unknown type');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam' }), /Unknown advancement type/, 'empty payload');
  await rejects(gm.send('training/advanceDays', { days: 'abc' }), /Invalid number of days/, 'invalid days');

  // Request → pending (karma not yet spent)
  const r1 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'attribute', target: 'STR', note: 'Salle de muscu' });
  eq(r1.status, 'pending', 'request pending');
  await settle();
  const req1 = gm.state.training.requests.find((r) => r.id === r1.requestId)!;
  eq([req1.karmaCost, req1.days, req1.label], [25, 35, 'Strength 4 → 5'], 'request computed');
  eq(gm.state.actors.pc_t_sam.karma, 60, 'karma not spent while pending');
  check(p1.state.training.requests.some((r) => r.id === r1.requestId), 'the player sees their request');
  check(!p2.state.training.requests.some((r) => r.id === r1.requestId), 'another player does not see it');
  check(gm.events.some((e) => e.ev === 'sfx' && e.data.id === 'notify'), 'GM notified');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'attribute', target: 'BOD' }), /One attribute at a time/, 'one attribute at a time (pending)');
  await rejects(p1.send('training/resolve', { requestId: r1.requestId, approve: true }), /GM/, 'a player cannot approve');

  // Approve → karma spent, job created
  await gm.send('training/resolve', { requestId: r1.requestId, approve: true, note: 'OK' });
  await settle();
  let a = gm.state.actors.pc_t_sam;
  eq(a.karma, 35, 'karma spent on approval');
  eq(a.training!.length, 1, 'job created');
  eq([a.training![0].daysTotal, a.training![0].daysDone], [35, 0], 'job 35 days');
  check(a.history.some((h) => h.karma === -25), 'karma history');
  eq(gm.state.training.requests.find((r) => r.id === r1.requestId)!.status, 'approved', 'status approved');
  await rejects(gm.send('training/resolve', { requestId: r1.requestId, approve: true }), /already been handled/, 'second approval refused');
  await rejects(p1.send('training/cancel', { requestId: r1.requestId }), /only the GM/, 'a player cannot interrupt a training in progress');

  // Instructor skill training in parallel
  const r2 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skill', target: 'pistols', instructor: true });
  await gm.send('training/resolve', { requestId: r2.requestId, approve: true });
  await settle();
  a = gm.state.actors.pc_t_sam;
  eq([a.karma, a.nuyen], [27, 4500], 'skill + instructor: karma and nuyen spent');

  // Downtime
  p1.events.length = 0;
  const adv1 = await gm.send('training/advanceDays', { days: 3 });
  eq(adv1.completed.map((c: { label: string }) => c.label), ['Pistols 3 → 4'], 'downtime 3 days: Pistols finished');
  await settle();
  a = gm.state.actors.pc_t_sam;
  eq(a.skills.find((s) => s.id === 'pistols')!.rating, 4, 'Pistols 4 applied');
  eq(a.training![0].daysDone, 3, 'Strength progresses (3/35)');
  check(p1.events.some((e) => e.ev === 'sfx' && e.data.id === 'level-up'), 'level-up sfx to the player');
  const adv2 = await gm.send('training/advanceDays', { days: 31 });
  eq(adv2.completed.length, 0, 'not finished yet (34/35)');
  const adv3 = await gm.send('training/advanceDays', { days: 7, actorIds: ['pc_t_sam'] });
  eq(adv3.completed.length, 1, 'Strength finished');
  await settle();
  a = gm.state.actors.pc_t_sam;
  eq([a.attributes.STR, a.training!.length], [5, 0], 'Strength 5 applied, job removed');
  eq(gm.state.training.requests.find((r) => r.id === r1.requestId)!.status, 'done', 'status done');
  eq(gm.state.training.daysElapsed, 34, 'downtime days counted (unfiltered)');
  check(gm.state.log.some((e) => e.kind === 'training' && /finished/.test(e.text)), 'training log');

  // Deny
  const r3 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'specialization', target: 'blades', spec: 'Katana' });
  await gm.send('training/resolve', { requestId: r3.requestId, approve: false, note: 'No dojo' });
  await settle();
  eq(gm.state.training.requests.find((r) => r.id === r3.requestId)!.status, 'denied', 'denied');
  eq(gm.state.actors.pc_t_sam.karma, 27, 'denied: karma untouched');

  // Cancel pending (owner) and in-progress (GM, refund)
  const r4 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'specialization', target: 'blades', spec: 'Katana' });
  await rejects(p2.send('training/cancel', { requestId: r4.requestId }), /not yours/, 'another player cannot cancel');
  await p1.send('training/cancel', { requestId: r4.requestId });
  await settle();
  eq(gm.state.training.requests.find((r) => r.id === r4.requestId)!.status, 'cancelled', 'cancelled by the player');
  const r5 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'knowledge', target: 'kn_gangs', to: 5 });
  await gm.send('training/resolve', { requestId: r5.requestId, approve: true });
  await settle();
  eq(gm.state.actors.pc_t_sam.karma, 18, 'Gangs 3→5: 9 karma');
  eq(gm.state.actors.pc_t_sam.training![0].daysTotal, 39, 'Gangs 3→5: 4 days + 5 weeks');
  await gm.send('training/cancel', { requestId: r5.requestId });
  await settle();
  eq([gm.state.actors.pc_t_sam.karma, gm.state.actors.pc_t_sam.training!.length], [27, 0], 'GM interruption refunded');
  await rejects(gm.send('training/cancel', { requestId: r1.requestId }), /close/, 'a finished request cannot be cancelled');

  // Karma reservation across pending requests (27 available)
  await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skill', target: 'pistols', to: 5 }); // 10
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skillGroup', target: 'athletics', to: 4 }), /Not enough karma/, 'karma committed by pending requests'); // 15+20

  // Auto-approve, no training time
  await gm.send('training/updateSettings', { approval: 'never', useTime: false, instructorTimeReduction: 50, instructorCostPerWeek: { skill: 800 } });
  await settle();
  const st = gm.state.training.settings;
  eq([st.approval, st.useTime, st.instructorTimeReduction, st.instructorCostPerWeek.skill, st.instructorCostPerWeek.attribute], ['never', false, 50, 800, 1000], 'settings');
  const r6 = await p2.send('training/request', { actorId: 'pc_t_jane', kind: 'knowledge', name: 'Japonais', ktype: 'language', to: 2 });
  eq(r6.status, 'done', 'auto-approval + immediate application');
  await settle();
  let j = gm.state.actors.pc_t_jane;
  eq([j.karma, j.knowledge.find((k) => k.name === 'Japonais')?.rating], [17, 2], 'Japanese 2 applied (3 karma)');
  // Manual entries (not in catalog) always need the GM
  const r7 = await p2.send('training/request', { actorId: 'pc_t_jane', kind: 'quality', name: 'Ambidextre', karma: 4, catalogId: 'inexistant' });
  eq(r7.status, 'pending', 'manual entry → GM approval even in auto mode');
  // Adept power (manual) approved → immediate
  const r8 = await p2.send('training/request', { actorId: 'pc_t_jane', kind: 'power', name: 'Réflexes améliorés', pp: 1, levels: true, to: 2 });
  await gm.send('training/resolve', { requestId: r8.requestId, approve: true });
  await settle();
  j = gm.state.actors.pc_t_jane;
  eq(j.powers.find((p) => p.id === 'pw2')?.level, 2, 'power level 2');
  eq(j.karma, 17, 'power: no karma');
  await rejects(p2.send('training/request', { actorId: 'pc_t_jane', kind: 'power', name: 'Sens du combat', pp: 1, levels: true, to: 2 }), /Not enough Power Points/, 'not enough PP');
  // Remove negative quality (computed → auto)
  const r9 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'removeQuality', target: 'q_acc' });
  eq(r9.status, 'done', 'quality buy-off auto');
  await settle();
  eq([gm.state.actors.pc_t_sam.qualities.length, gm.state.actors.pc_t_sam.karma], [0, 19], 'negative quality bought off (8 karma)');

  // Catalog-verified quality (server reads data/catalog/qualities.json) → auto-approved; karma forced from catalog
  // raw catalog JSON
  const qcat: any[] = (() => { try { return JSON.parse(fs.readFileSync(new URL('../data/catalog/qualities.json', import.meta.url), 'utf8')); } catch { return []; } })();
  const amb = qcat.find((q: any) => q.name === 'Ambidextrous');
  if (amb) {
    const r12 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'quality', catalogId: amb.id, name: 'x', karma: 1 });
    eq(r12.status, 'done', 'catalog quality auto-approved');
    await settle();
    const q = gm.state.actors.pc_t_sam.qualities.find((x) => x.catalogId === amb.id);
    eq([q?.name, q?.karma, gm.state.actors.pc_t_sam.karma], [amb.nameFr || amb.name, 4, 11], 'catalog quality: French name, karma ×2 = 8');
    await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'quality', name: amb.nameFr || amb.name, karma: 4 }), /already owned/, 'duplicate detected');
  } else console.warn('(quality catalog missing: test skipped)');

  // GM: training for another actor, auto-approved; forced completion
  await gm.send('training/updateSettings', { useTime: true });
  const r10 = await gm.send('training/request', { actorId: 'npc_t_mage', kind: 'initiation', options: { ordeal: true, metamagic: 'Centrage' } });
  eq(r10.status, 'approved', 'GM request auto-approved');
  await settle();
  let m = gm.state.actors.npc_t_mage;
  eq([m.karma, m.training![0].daysTotal], [88, 30], 'initiation: 12 karma, 1 month');
  const done = await gm.send('training/complete', { actorId: 'npc_t_mage', jobId: m.training![0].id });
  check(/Initiation/.test(done.label), 'forced completion');
  await settle();
  m = gm.state.actors.npc_t_mage;
  eq([m.magic!.initiation, m.magic!.metamagics, m.training!.length], [1, ['Centrage'], 0], 'initiation applied');
  const r11 = await gm.send('training/request', { actorId: 'npc_t_mage', kind: 'spell', name: 'Armure', free: true });
  await settle();
  eq([gm.state.actors.npc_t_mage.karma, r11.status], [88, 'approved'], 'learning given by the GM (free)');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skill', target: 'blades', to: 8, free: true }), /Not enough karma/, 'free ignored for a player');

  // History clean-up
  const cleared = await gm.send('training/clearHistory', {});
  check(cleared.removed > 0, 'history cleaned');
  await settle();
  check(gm.state.training.requests.every((r) => ['pending', 'approved'].includes(r.status)), 'only open requests remain');

  // i18n: log entries, history entries and request labels render to the stored English text, and have French.
  {
    const I = await import('../client/lib/i18n.ts');
    const dir = new URL('../client/i18n/fr/', import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)));
    const dict: Record<string, string> = {};
    for (const f of files) Object.assign(dict, JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
    I.setDictionary(dict, { legacyKeys: JSON.parse(fs.readFileSync(new URL('../client/i18n/legacy-fr-keys.json', import.meta.url), 'utf8')) });
    I.clearMissing();
    const logs = gm.state.log.filter((l) => l.kind === 'training');
    const hist = Object.values(gm.state.actors).flatMap((a) => (a.history || []).filter((h) => h.i18n));
    const labels = Object.values(gm.state.actors).flatMap<TrainingJob | TrainingRequest>((a) => a.training || []).concat(gm.state.training.requests).filter((x) => x.labelI18n).map((x) => ({ text: x.label, i18n: x.labelI18n }));
    const all = [...logs, ...hist, ...labels];
    check(logs.length > 0 && logs.every((l) => l.i18n?.key), 'i18n: translatable log entries');
    check(hist.length > 0 && labels.length > 0, 'i18n: translatable history and labels');
    const text = (e: (typeof all)[number]) => I.t(e.i18n!.key, e.i18n!.params);
    I.setLang('en');
    const bad = all.filter((e) => text(e) !== e.text);
    check(!bad.length, 'i18n: English rendering = stored text', bad.map((e) => `${text(e)} ≠ ${e.text}`).join(' | '));
    check(logs.some((x) => /^⏱ Downtime: /.test(x.text)) && logs.some((x) => /requests: /.test(x.text)), 'i18n: English log (stored)');
    I.setLang('fr');
    const fr = all.map(text);
    const missing = Object.keys(I.missingKeys());
    check(!missing.length, 'i18n: every key has a French translation', missing.join(' | '));
    check(fr.some((x) => /^⏱ Temps mort : /.test(x)) && fr.some((x) => /demande : /.test(x)), 'i18n: French log');
    // Quote errors / labels (shared/advancement.ts) are translatable too.
    const q = quote(sam(), { kind: 'skill', target: 'pistols', to: 12 });
    I.setLang('en');
    check(q.errorI18n?.key && I.t(q.errorI18n.key, q.errorI18n.params) === q.error, 'i18n: quote error = English text');
    I.setLang('fr');
    check(q.errorI18n?.key && I.t(q.errorI18n.key, q.errorI18n.params) !== q.error, 'i18n: quote error translated to French');
  }
} catch (e) {
  check(false, `exception: ${(e as Error).stack}`);
} finally {
  gm?.close();
  p1?.close();
  p2?.close();
  srv.stop();
}

console.log(`${passes} ok, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
