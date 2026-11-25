// Training module tests: node tools/test-training.js (exit code ≠ 0 on failure).
// Unit-tests shared/advancement.js, then drives server/modules/50-training.js through an isolated server.
import fs from 'node:fs';
import {
  costFor, timeFor, formatDays, withInstructor, validate, quote, applyAdvance, attrMax, groupState, powerPoints,
} from '../shared/advancement.js';

let failures = 0;
let passes = 0;
function check(cond, label, extra) {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), `${label} (attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)})`);
async function rejects(promise, re, label) {
  try {
    await promise;
    check(false, `${label} (aurait dû échouer)`);
  } catch (e) {
    check(re.test(e.message), `${label} (message: ${e.message})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const sam = () => ({
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
});
const jane = () => ({
  id: 'pc_t_jane', type: 'pc', name: 'Jane Test', metatype: 'Humain',
  attributes: { BOD: 2, AGI: 6, REA: 6, STR: 2, WIL: 3, LOG: 4, INT: 5, CHA: 6, EDG: 3, MAG: 5, ESS: 6 },
  skills: [{ id: 'con', name: 'Escroquerie', attr: 'CHA', rating: 6 }], skillGroups: [], knowledge: [],
  qualities: [{ id: 'q_adept', name: 'Adepte', karma: 20, positive: true }],
  powers: [{ id: 'pw1', name: 'Kinésique', pp: 1 }, { id: 'pw2', name: 'Réflexes améliorés', level: 1, pp: 1.5, catalogId: 'ir' }],
  spells: [], karma: 20, karmaTotal: 80, nuyen: 1000, history: [],
});
const mage = () => ({
  id: 'npc_t_mage', type: 'pc', name: 'Mage Test', metatype: 'Elfe',
  attributes: { BOD: 3, AGI: 3, REA: 3, STR: 2, WIL: 5, LOG: 5, INT: 4, CHA: 5, EDG: 2, MAG: 4, ESS: 4.5 },
  skills: [{ id: 'spellcasting', name: 'Lancement de sorts', attr: 'MAG', rating: 5 }], skillGroups: [], knowledge: [],
  qualities: [{ id: 'q_mag', name: 'Magicien', karma: 30, positive: true }], powers: [], spells: [{ id: 's1', name: 'Boule de feu' }],
  karma: 100, karmaTotal: 150, nuyen: 0, history: [],
});

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------
const costTable = [
  ['attribute', 4, 5, {}, 25], ['attribute', 3, 5, {}, 45], ['skill', 0, 1, {}, 2], ['skill', 5, 6, {}, 12], ['skill', 4, 6, {}, 22],
  ['skill', 3, 4, { spec: true }, 15], ['skillGroup', 0, 1, {}, 5], ['skillGroup', 3, 4, {}, 20], ['knowledge', 0, 1, {}, 1],
  ['knowledge', 3, 4, {}, 4], ['specialization', 0, 1, {}, 7], ['quality', 0, 1, { karma: 14 }, 28], ['removeQuality', 1, 0, { karma: 4 }, 8],
  ['spell', 0, 1, {}, 5], ['complexForm', 0, 1, {}, 4], ['power', 0, 1, {}, 0], ['powerPoint', 0, 2, {}, 10],
  ['initiation', 0, 1, {}, 13], ['initiation', 2, 3, {}, 19], ['initiation', 0, 1, { options: { group: true } }, 12],
  ['initiation', 0, 1, { options: { group: true, ordeal: true } }, 11],
];
for (const [k, f, t, o, exp] of costTable) eq(costFor(k, f, t, o), exp, `costFor ${k} ${f}→${t}`);

const timeTable = [
  ['attribute', 4, 5, {}, 35], ['skill', 0, 1, {}, 1], ['skill', 3, 4, {}, 4], ['skill', 4, 5, {}, 35], ['skill', 8, 9, {}, 126],
  ['skillGroup', 2, 3, {}, 42], ['knowledge', 2, 3, {}, 3], ['knowledge', 4, 5, {}, 35], ['specialization', 0, 1, {}, 30],
  ['quality', 0, 1, { karma: 14 }, 21], ['quality', 0, 1, { karma: 3 }, 7], ['spell', 0, 1, {}, 1], ['initiation', 0, 1, {}, 30], ['power', 0, 1, {}, 0],
];
for (const [k, f, t, o, exp] of timeTable) eq(timeFor(k, f, t, o), exp, `timeFor ${k} ${f}→${t}`);

eq(formatDays(0), 'immédiat', 'formatDays 0');
eq(formatDays(1), '1 jour', 'formatDays 1');
eq(formatDays(21), '3 semaines', 'formatDays 21');
eq(formatDays(10), '1 semaine et 3 jours', 'formatDays 10');
eq(formatDays(60), '2 mois', 'formatDays 60');
eq(withInstructor(35, 'attribute', { instructorTimeReduction: 25, instructorCostPerWeek: { attribute: 1000 } }), { days: 27, weeks: 4, nuyen: 4000, rate: 1000 }, 'withInstructor');

// Limits
const S = sam();
check(/maximum 6/.test(validate(S, { kind: 'attribute', target: 'AGI' })), 'AGI 6 → 7 humain refusé');
check(validate({ ...S, qualities: [{ name: 'Attribut exceptionnel (Agilité)', karma: 14, positive: true }] }, { kind: 'attribute', target: 'AGI' }) === null, 'Attribut exceptionnel autorise AGI 7');
check(validate({ ...S, qualities: [{ name: 'Attribut exceptionnel', notes: 'Force', karma: 14, positive: true }] }, { kind: 'attribute', target: 'AGI' }) !== null, 'Attribut exceptionnel (Force) n’aide pas AGI');
eq(attrMax(S, 'EDG'), 7, 'Chance max humain 7');
check(/Éveillé/.test(validate(S, { kind: 'attribute', target: 'MAG' })), 'pas de MAG pour Sam');
eq(attrMax(mage(), 'MAG'), 4, 'MAG max réduit par l’essence (4.5)');
check(/maximum 4/.test(validate(mage(), { kind: 'attribute', target: 'MAG' })), 'MAG 4→5 refusé (essence)');
check(/Karma insuffisant/.test(validate(jane(), { kind: 'attribute', target: 'WIL', to: 5 })), 'karma insuffisant (45 > 20)');
check(validate(jane(), { kind: 'attribute', target: 'BOD' }) === null, 'BOD 2→3 (15) ok');
check(/maximum 12/.test(validate(S, { kind: 'skill', target: 'blades', to: 13 })), 'compétence max 12');
check(/dépasser/.test(validate(S, { kind: 'skill', target: 'blades', to: 6 })), 'nouveau rang > actuel');
check(/Éveillé/.test(validate(S, { kind: 'skill', target: 'spellcasting' })), 'compétence magique interdite');
check(/maternelle/.test(validate(S, { kind: 'knowledge', target: 'kn_en' })), 'langue maternelle');
eq(quote(S, { kind: 'skill', target: 'running' }).warnings, ['Rompt le groupe Athlétisme'], 'avertissement groupe rompu');
eq(groupState(S, 'athletics').intact, true, 'groupe intact');
check(/rompu/.test(validate(S, { kind: 'skillGroup', target: 'firearms' })), 'groupe Armes à feu rompu (pistolets 3)');
eq(quote(S, { kind: 'skillGroup', target: 'athletics' }).karmaCost, 15, 'groupe 2→3 = 15');
eq(quote(S, { kind: 'skill', target: 'pistols', instructor: true }).nuyenCost, 500, 'instructeur compétence 500¥/sem');
eq(quote(S, { kind: 'skill', target: 'pistols', instructor: true }).days, 3, 'instructeur −25 % (4 → 3 jours)');
eq(quote(S, { kind: 'skill', target: 'pistols' }, { useTime: false }).days, 0, 'useTime false → 0 jour');
check(/Un seul attribut/.test(validate(S, { kind: 'attribute', target: 'BOD' }, undefined, { active: [{ request: { kind: 'attribute', target: 'STR', to: 5 } }] })), 'un seul attribut à la fois');
check(/Déjà/.test(validate(S, { kind: 'skill', target: 'running' }, undefined, { active: [{ label: 'Athlétisme', request: { kind: 'skillGroup', target: 'athletics' } }] })), 'conflit groupe / compétence');
check(/Karma insuffisant/.test(validate(S, { kind: 'attribute', target: 'STR' }, undefined, { reservedKarma: 50 })), 'karma réservé par les demandes en attente');
eq(powerPoints(jane()), { total: 5, spent: 2.5, free: 2.5, extra: 0 }, 'points de pouvoir Jane');
check(/insuffisants/.test(validate(jane(), { kind: 'power', name: 'Sens du combat', pp: 1, levels: true, to: 3 })), 'PP insuffisants');
check(/Magie/.test(validate(jane(), { kind: 'power', name: 'Sens du combat', pp: 0.25, levels: true, to: 6 })), 'niveau de pouvoir > MAG');
check(/Seuls/.test(validate(S, { kind: 'spell', name: 'Armure' })), 'sort refusé à un non-magicien');
check(/adeptes mystiques/.test(validate(jane(), { kind: 'powerPoint' })), 'achat de PP réservé aux adeptes mystiques');
check(/un grade à la fois/.test(validate(mage(), { kind: 'initiation', to: 2 })), 'initiation un grade à la fois');

// applyAdvance
{
  const a = sam();
  applyAdvance(a, { kind: 'skill', target: 'running', to: 3 });
  eq(a.skillGroups, [], 'apply : groupe rompu supprimé');
  eq(a.skills.find((s) => s.id === 'running').rating, 3, 'apply : Course 3');
  applyAdvance(a, { kind: 'skill', target: 'sneaking', to: 1, spec: 'Urbain' });
  const sn = a.skills.find((s) => s.id === 'sneaking');
  eq([sn.name, sn.attr, sn.rating, sn.spec, sn.group], ['Furtivité', 'AGI', 1, 'Urbain', 'stealth'], 'apply : nouvelle compétence + spé');
  applyAdvance(a, { kind: 'skillGroup', target: 'outdoors', to: 1 });
  eq(['survival', 'tracking', 'navigation'].map((id) => a.skills.find((s) => s.id === id)?.rating), [1, 1, 1], 'apply : groupe matérialisé');
  applyAdvance(a, { kind: 'knowledge', name: 'Japonais', ktype: 'language', to: 2 });
  eq(a.knowledge.find((k) => k.name === 'Japonais')?.rating, 2, 'apply : nouvelle langue');
  applyAdvance(a, { kind: 'removeQuality', target: 'q_acc' });
  eq(a.qualities.length, 0, 'apply : qualité rachetée');
  applyAdvance(a, { kind: 'attribute', target: 'EDG', to: 4 });
  eq([a.attributes.EDG, a.edge.current], [4, 4], 'apply : Chance + point regagné');
  const j = jane();
  applyAdvance(j, { kind: 'power', name: 'Réflexes améliorés', catalogId: 'ir', pp: 1, levels: true, to: 2 });
  eq(j.powers.find((p) => p.id === 'pw2'), { id: 'pw2', name: 'Réflexes améliorés', level: 2, pp: 2.5, catalogId: 'ir' }, 'apply : niveau de pouvoir');
  const m = mage();
  applyAdvance(m, { kind: 'initiation', to: 1, options: { metamagic: 'Centrage' } });
  eq([m.magic.initiation, m.magic.metamagics, attrMax(m, 'MAG')], [1, ['Centrage'], 5], 'apply : initiation');
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------
process.env.SR_TEST_TRAINING_ACTORS = JSON.stringify([sam(), jane(), mage()]);
const { startServer, login, client, settle } = await import('./test-client.js');
const srv = await startServer({ port: 3105 });
let gm, p1, p2;
try {
  gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueur Sam', characterId: 'pc_t_sam' }));
  p2 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Joueuse Jane', characterId: 'pc_t_jane' }));
  await settle();
  check(gm.state.training?.settings?.approval === 'always', 'slice training initialisé');
  check(gm.state.actors.pc_t_sam, 'fixture chargée');

  // Permissions & validation
  await rejects(p1.send('training/request', { actorId: 'pc_t_jane', kind: 'attribute', target: 'BOD' }), /appartient/, 'joueur ne peut pas entraîner le perso d’un autre');
  await rejects(p1.send('training/advanceDays', { days: 3 }), /MJ/, 'advanceDays réservé au MJ');
  await rejects(p1.send('training/updateSettings', { approval: 'never' }), /MJ/, 'updateSettings réservé au MJ');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'attribute', target: 'AGI' }), /maximum/, 'serveur : maximum métatype');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'nope' }), /inconnu/, 'type inconnu');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam' }), /inconnu/, 'payload vide');
  await rejects(gm.send('training/advanceDays', { days: 'abc' }), /invalide/, 'jours invalides');

  // Request → pending (karma not yet spent)
  const r1 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'attribute', target: 'STR', note: 'Salle de muscu' });
  eq(r1.status, 'pending', 'demande en attente');
  await settle();
  const req1 = gm.state.training.requests.find((r) => r.id === r1.requestId);
  eq([req1.karmaCost, req1.days, req1.label], [25, 35, 'Force 4 → 5'], 'demande calculée');
  eq(gm.state.actors.pc_t_sam.karma, 60, 'karma non débité tant que pending');
  check(p1.state.training.requests.some((r) => r.id === r1.requestId), 'le joueur voit sa demande');
  check(!p2.state.training.requests.some((r) => r.id === r1.requestId), 'un autre joueur ne la voit pas');
  check(gm.events.some((e) => e.ev === 'sfx' && e.data.id === 'notify'), 'MJ notifié');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'attribute', target: 'BOD' }), /Un seul attribut/, 'un seul attribut à la fois (pending)');
  await rejects(p1.send('training/resolve', { requestId: r1.requestId, approve: true }), /MJ/, 'joueur ne peut pas approuver');

  // Approve → karma spent, job created
  await gm.send('training/resolve', { requestId: r1.requestId, approve: true, note: 'OK' });
  await settle();
  let a = gm.state.actors.pc_t_sam;
  eq(a.karma, 35, 'karma débité à l’approbation');
  eq(a.training.length, 1, 'job créé');
  eq([a.training[0].daysTotal, a.training[0].daysDone], [35, 0], 'job 35 jours');
  check(a.history.some((h) => h.karma === -25), 'historique karma');
  eq(gm.state.training.requests.find((r) => r.id === r1.requestId).status, 'approved', 'statut approved');
  await rejects(gm.send('training/resolve', { requestId: r1.requestId, approve: true }), /déjà/, 'double approbation refusée');
  await rejects(p1.send('training/cancel', { requestId: r1.requestId }), /MJ/, 'joueur ne peut pas interrompre un entraînement en cours');

  // Instructor skill training in parallel
  const r2 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skill', target: 'pistols', instructor: true });
  await gm.send('training/resolve', { requestId: r2.requestId, approve: true });
  await settle();
  a = gm.state.actors.pc_t_sam;
  eq([a.karma, a.nuyen], [27, 4500], 'compétence + instructeur : karma et nuyens débités');

  // Downtime
  p1.events.length = 0;
  const adv1 = await gm.send('training/advanceDays', { days: 3 });
  eq(adv1.completed.map((c) => c.label), ['Pistolets 3 → 4'], 'temps mort 3 jours : Pistolets terminé');
  await settle();
  a = gm.state.actors.pc_t_sam;
  eq(a.skills.find((s) => s.id === 'pistols').rating, 4, 'Pistolets 4 appliqué');
  eq(a.training[0].daysDone, 3, 'Force progresse (3/35)');
  check(p1.events.some((e) => e.ev === 'sfx' && e.data.id === 'level-up'), 'sfx level-up au joueur');
  const adv2 = await gm.send('training/advanceDays', { days: 31 });
  eq(adv2.completed.length, 0, 'pas encore fini (34/35)');
  const adv3 = await gm.send('training/advanceDays', { days: 7, actorIds: ['pc_t_sam'] });
  eq(adv3.completed.length, 1, 'Force terminée');
  await settle();
  a = gm.state.actors.pc_t_sam;
  eq([a.attributes.STR, a.training.length], [5, 0], 'Force 5 appliquée, job retiré');
  eq(gm.state.training.requests.find((r) => r.id === r1.requestId).status, 'done', 'statut done');
  eq(gm.state.training.daysElapsed, 34, 'jours de temps mort comptés (hors filtre)');
  check(gm.state.log.some((e) => e.kind === 'training' && /terminé/.test(e.text)), 'log training');

  // Deny
  const r3 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'specialization', target: 'blades', spec: 'Katana' });
  await gm.send('training/resolve', { requestId: r3.requestId, approve: false, note: 'Pas de dojo' });
  await settle();
  eq(gm.state.training.requests.find((r) => r.id === r3.requestId).status, 'denied', 'refus');
  eq(gm.state.actors.pc_t_sam.karma, 27, 'refus : karma intact');

  // Cancel pending (owner) and in-progress (GM, refund)
  const r4 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'specialization', target: 'blades', spec: 'Katana' });
  await rejects(p2.send('training/cancel', { requestId: r4.requestId }), /appartient/, 'autre joueur ne peut pas annuler');
  await p1.send('training/cancel', { requestId: r4.requestId });
  await settle();
  eq(gm.state.training.requests.find((r) => r.id === r4.requestId).status, 'cancelled', 'annulation par le joueur');
  const r5 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'knowledge', target: 'kn_gangs', to: 5 });
  await gm.send('training/resolve', { requestId: r5.requestId, approve: true });
  await settle();
  eq(gm.state.actors.pc_t_sam.karma, 18, 'Gangs 3→5 : 9 karma');
  eq(gm.state.actors.pc_t_sam.training[0].daysTotal, 39, 'Gangs 3→5 : 4 jours + 5 semaines');
  await gm.send('training/cancel', { requestId: r5.requestId });
  await settle();
  eq([gm.state.actors.pc_t_sam.karma, gm.state.actors.pc_t_sam.training.length], [27, 0], 'interruption MJ remboursée');
  await rejects(gm.send('training/cancel', { requestId: r1.requestId }), /close/, 'impossible d’annuler une demande terminée');

  // Karma reservation across pending requests (27 available)
  await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skill', target: 'pistols', to: 5 }); // 10
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skillGroup', target: 'athletics', to: 4 }), /Karma insuffisant/, 'karma engagé par les demandes en attente'); // 15+20

  // Auto-approve, no training time
  await gm.send('training/updateSettings', { approval: 'never', useTime: false, instructorTimeReduction: 50, instructorCostPerWeek: { skill: 800 } });
  await settle();
  const st = gm.state.training.settings;
  eq([st.approval, st.useTime, st.instructorTimeReduction, st.instructorCostPerWeek.skill, st.instructorCostPerWeek.attribute], ['never', false, 50, 800, 1000], 'réglages');
  const r6 = await p2.send('training/request', { actorId: 'pc_t_jane', kind: 'knowledge', name: 'Japonais', ktype: 'language', to: 2 });
  eq(r6.status, 'done', 'auto-approbation + application immédiate');
  await settle();
  let j = gm.state.actors.pc_t_jane;
  eq([j.karma, j.knowledge.find((k) => k.name === 'Japonais')?.rating], [17, 2], 'Japonais 2 appliqué (3 karma)');
  // Manual entries (not in catalog) always need the GM
  const r7 = await p2.send('training/request', { actorId: 'pc_t_jane', kind: 'quality', name: 'Ambidextre', karma: 4, catalogId: 'inexistant' });
  eq(r7.status, 'pending', 'saisie manuelle → validation MJ même en auto');
  // Adept power (manual) approved → immediate
  const r8 = await p2.send('training/request', { actorId: 'pc_t_jane', kind: 'power', name: 'Réflexes améliorés', pp: 1, levels: true, to: 2 });
  await gm.send('training/resolve', { requestId: r8.requestId, approve: true });
  await settle();
  j = gm.state.actors.pc_t_jane;
  eq(j.powers.find((p) => p.id === 'pw2')?.level, 2, 'pouvoir niveau 2');
  eq(j.karma, 17, 'pouvoir : pas de karma');
  await rejects(p2.send('training/request', { actorId: 'pc_t_jane', kind: 'power', name: 'Sens du combat', pp: 1, levels: true, to: 2 }), /insuffisants/, 'PP insuffisants');
  // Remove negative quality (computed → auto)
  const r9 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'removeQuality', target: 'q_acc' });
  eq(r9.status, 'done', 'rachat qualité auto');
  await settle();
  eq([gm.state.actors.pc_t_sam.qualities.length, gm.state.actors.pc_t_sam.karma], [0, 19], 'qualité négative rachetée (8 karma)');

  // Catalog-verified quality (server reads data/catalog/qualities.json) → auto-approved; karma forced from catalog
  const qcat = (() => { try { return JSON.parse(fs.readFileSync(new URL('../data/catalog/qualities.json', import.meta.url), 'utf8')); } catch { return []; } })();
  const amb = qcat.find((q) => q.name === 'Ambidextrous');
  if (amb) {
    const r12 = await p1.send('training/request', { actorId: 'pc_t_sam', kind: 'quality', catalogId: amb.id, name: 'x', karma: 1 });
    eq(r12.status, 'done', 'qualité du catalogue auto-approuvée');
    await settle();
    const q = gm.state.actors.pc_t_sam.qualities.find((x) => x.catalogId === amb.id);
    eq([q?.name, q?.karma, gm.state.actors.pc_t_sam.karma], [amb.nameFr || amb.name, 4, 11], 'qualité catalogue : nom FR, karma ×2 = 8');
    await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'quality', name: amb.nameFr || amb.name, karma: 4 }), /déjà/, 'doublon détecté');
  } else console.warn('(catalogue des qualités absent : test sauté)');

  // GM: training for another actor, auto-approved; forced completion
  await gm.send('training/updateSettings', { useTime: true });
  const r10 = await gm.send('training/request', { actorId: 'npc_t_mage', kind: 'initiation', options: { ordeal: true, metamagic: 'Centrage' } });
  eq(r10.status, 'approved', 'demande MJ auto-approuvée');
  await settle();
  let m = gm.state.actors.npc_t_mage;
  eq([m.karma, m.training[0].daysTotal], [88, 30], 'initiation : 12 karma, 1 mois');
  const done = await gm.send('training/complete', { actorId: 'npc_t_mage', jobId: m.training[0].id });
  check(/Initiation/.test(done.label), 'complétion forcée');
  await settle();
  m = gm.state.actors.npc_t_mage;
  eq([m.magic.initiation, m.magic.metamagics, m.training.length], [1, ['Centrage'], 0], 'initiation appliquée');
  const r11 = await gm.send('training/request', { actorId: 'npc_t_mage', kind: 'spell', name: 'Armure', free: true });
  await settle();
  eq([gm.state.actors.npc_t_mage.karma, r11.status], [88, 'approved'], 'apprentissage offert par le MJ (free)');
  await rejects(p1.send('training/request', { actorId: 'pc_t_sam', kind: 'skill', target: 'blades', to: 8, free: true }), /Karma insuffisant/, 'free ignoré pour un joueur');

  // History clean-up
  const cleared = await gm.send('training/clearHistory', {});
  check(cleared.removed > 0, 'historique nettoyé');
  await settle();
  check(gm.state.training.requests.every((r) => ['pending', 'approved'].includes(r.status)), 'seules les demandes ouvertes restent');
} catch (e) {
  check(false, `exception: ${e.stack}`);
} finally {
  gm?.close();
  p1?.close();
  p2?.close();
  srv.stop();
}

console.log(`${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
