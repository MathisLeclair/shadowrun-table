// Matrix module tests: shared rules (shared/matrix.js) + server actions (45-matrix.js) on an isolated server.
// Run: node tools/test-matrix.js   (port 3600 or SR_TEST_PORT, exit code != 0 on failure)
import {
  programId, detectAgents, availablePrograms, deckStats, actionPool, matrixInitiative, matrixMonitor, ACTION_BY_ID,
  ACTIONS, PROGRAMS, IC_TYPES, hostAttributes, osLevel, dumpshock, programSlots, isPermutation, agentInitiative,
  ACTION_CATS, ACTION_TYPES, TARGET_KIND_LABELS, HOST_PRESETS, MODE_LABELS, ASDF_LABELS,
} from '../shared/matrix.js';
import { interpolate, stripContext } from '../client/i18n/format.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}
async function expectFail(p, re, msg) {
  try {
    await p;
    ok(false, `${msg} (should have failed)`);
  } catch (e) {
    ok(re.test(e.message), `${msg} — got: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------
const pcs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8'));
const bricks = pcs.find((a) => a.id === 'pc_bricks');
const jane = pcs.find((a) => a.id === 'pc_jane');

ok(programId('Agent (5)') === 'agent', 'programId: Agent (5)');
ok(programId('Crash (Program)') === 'crash', 'programId: Crash (Program)');
ok(programId('Boîte à outils') === 'toolbox', 'programId: French alias');
ok(programId('Armure') === 'armor' && programId('Furtivité') === 'stealth', 'programId: catalog French names');
ok(programId('Truc inconnu') === null, 'programId: unknown → null');
ok(ACTIONS.every((a) => a.fr && a.en && a.cat && a.type && Array.isArray(a.targets)), 'every action has FR/EN names, category, type, targets');
ok(ACTIONS.filter((a) => !a.noTest).every((a) => a.skill && a.attr && a.limit), 'every tested action has skill/attribute/limit');
ok(PROGRAMS.every((p) => p.id && p.en && p.fr && p.effect), 'every program has names and an effect');
const ag = detectAgents(bricks);
ok(ag.some((x) => x.rating === 5 && x.source === 'programs') && ag.some((x) => x.rating === 6 && x.source === 'gear'), `Bricks owns Agent (5) and an Agent rating 6 (${JSON.stringify(ag)})`);
ok(detectAgents(jane).length === 0, 'Jane has no agent');
ok(availablePrograms(bricks).length === 21 && availablePrograms(bricks).some((x) => x.name === 'Agent' && x.id === 'agent'), 'Bricks: 20 programs on the deck + the Agent from her gear');
ok(matrixMonitor(3) === 10 && matrixMonitor(6) === 11, 'matrix condition monitor = 8 + ceil(DR/2)');
let persona = { mode: 'hot', asdf: { attack: 'attack', sleaze: 'sleaze', dataProcessing: 'dataProcessing', firewall: 'firewall' }, loadedPrograms: ['Stealth', 'Toolbox'], noise: 3 };
let ds = deckStats(bricks, persona);
ok(ds.eff.sleaze === 6 && ds.eff.dataProcessing === 4 && ds.eff.attack === 6, 'program bonuses (Stealth +1 S, Toolbox +1 DP)');
ok(ds.noise === 3, 'noise without Signal Scrub');
let hof = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, {});
ok(hof.pool === 6 + 6 + 2 - 3 && hof.limit === 6, `Hack on the Fly: Hacking 6 + LOG 6 + hot 2 − noise 3 = 11 [6] (got ${hof.pool} [${hof.limit}])`);
hof = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, { marks: 3, assist: { dice: 3, limitBonus: 1 } });
ok(hof.pool === 11 - 10 + 3 && hof.limit === 7, 'extra marks −10, agent assist +3 dice / +1 limit');
hof = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, { edge: true });
ok(hof.limit === null && hof.pool === 11 + 5, 'Edge: +EDG dice, no limit');
const agentPool = actionPool(bricks, { ...persona, agent: { rating: 5 } }, ACTION_BY_ID.dataSpike, { agent: true });
ok(agentPool.pool === 10 - 3 && agentPool.limit === 6, `agent pool = Rating × 2 − noise, deck limit (got ${agentPool.pool} [${agentPool.limit}])`);
persona = { ...persona, asdf: { attack: 'sleaze', sleaze: 'attack', dataProcessing: 'dataProcessing', firewall: 'firewall' }, loadedPrograms: ['Signal Scrub'] };
ds = deckStats(bricks, persona);
ok(ds.eff.attack === 5 && ds.eff.sleaze === 6 && ds.noise === 1, 'ASDF swap + Signal Scrub −2 noise');
ok(isPermutation(persona.asdf) && !isPermutation({ attack: 'attack', sleaze: 'attack', dataProcessing: 'dataProcessing', firewall: 'firewall' }), 'isPermutation');
ok(matrixInitiative(bricks, { mode: 'cold' }).text === '7 + 3D6' && matrixInitiative(bricks, { mode: 'hot' }).text === '7 + 4D6', 'VR initiative = DP + INT + 3D6/4D6');
ok(matrixInitiative(bricks, { mode: 'ar' }).text === '9 + 1D6', 'AR initiative = physical');
ok(agentInitiative(bricks, { agent: { rating: 5 } }).text === '8 + 4D6', 'agent initiative = DP + Rating + 4D6');
ok(actionPool(jane, { mode: 'cold' }, ACTION_BY_ID.snoop).impossible, 'untrained Electronic Warfare cannot default');
ok(JSON.stringify(hostAttributes(5, 'shell')) === JSON.stringify({ attack: 6, sleaze: 8, dataProcessing: 5, firewall: 7 }), 'shell preset = Hollow Pine array');
ok(osLevel(36).id === 'critical' && osLevel(5).id === 'calm', 'OS levels');
ok(dumpshock('hot').type === 'P' && dumpshock('cold').type === 'S' && dumpshock('ar') === null, 'dumpshock P hot / S cold / none AR');
ok(programSlots({ programSlots: 3, loadedPrograms: ['Virtual Machine', 'Stealth'], agent: { loaded: true } }).total === 5, 'Virtual Machine adds 2 slots');
ok(Object.values(IC_TYPES).every((t) => t.fr && t.defense && t.effect), 'IC types complete');

// ---------------------------------------------------------------------------
// i18n: English dictionary covers the rules vocabulary and every server message
// ---------------------------------------------------------------------------
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'en');
const EN = {};
for (const f of fs.readdirSync(DICT_DIR).filter((x) => x.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)))) {
  Object.assign(EN, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
}
const enT = (key, params) => (EN[key] ? interpolate(EN[key], params, enT) : `⟦${stripContext(key)}⟧`);
/** Every translatable key inside a message / { key, params } (nested params included). */
function msgKeys(m, out = []) {
  if (!m || typeof m !== 'object') return out;
  const k = m.t || m.key;
  if (typeof k === 'string') out.push(k);
  for (const v of Object.values(m.params || {})) {
    if (Array.isArray(v)) v.forEach((x) => msgKeys(x, out));
    else msgKeys(v, out);
  }
  return out;
}
const missingEn = (keys) => keys.filter((k) => !EN[k]);
{
  const vocab = [
    ...ACTIONS.flatMap((a) => [a.fr, a.desc]), ...Object.values(IC_TYPES).flatMap((t) => [t.fr, t.desc]), ...PROGRAMS.map((p) => p.effect),
    ...Object.values(ACTION_CATS), ...Object.values(ACTION_TYPES), ...Object.values(TARGET_KIND_LABELS), ...Object.values(HOST_PRESETS).map((p) => p.label),
    ...Object.values(MODE_LABELS), ...Object.values(ASDF_LABELS), ...[0, 10, 20, 30, 36].map((n) => osLevel(n).label),
  ];
  ok(missingEn(vocab).length === 0, `rules vocabulary translated (missing: ${missingEn(vocab).join(' | ')})`);
  ok(ACTIONS.every((a) => EN[a.fr] === a.en || a.id === 'rebootSelf'), `action names match their official English name (${ACTIONS.filter((a) => EN[a.fr] !== a.en).map((a) => a.id).join(', ')})`);
  ok(Object.values(IC_TYPES).every((t) => EN[t.fr] === t.en), 'IC names match their official English name');
  const parts = actionPool(bricks, { mode: 'hot', noise: 2, asdf: null, loadedPrograms: ['Exploit'] }, ACTION_BY_ID.hackOnTheFly, { marks: 2, modifier: 1, useSpec: true, edge: true });
  ok(missingEn(parts.parts.concat(parts.limitParts).filter((p) => p.key).map((p) => p.key)).length === 0, 'pool part keys translated');
  const imp = actionPool(jane, { mode: 'cold' }, ACTION_BY_ID.snoop);
  ok(imp.reasonKey && EN[imp.reasonKey] && enT(imp.reasonKey, imp.reasonParams) === 'Electronic Warfare cannot be used untrained', `impossible reason translated (${enT(imp.reasonKey, imp.reasonParams)})`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
process.env.SR_MATRIX_TEST = '1';
const { startServer, login, client, settle } = await import('./test-client.js');
const srv = await startServer({ port: Number(process.env.SR_TEST_PORT) || 3600 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const pl = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  const pj = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  await settle();
  let res;
  const M = () => gm.state.matrix;
  const P = () => gm.state.matrix.personas.pc_bricks;

  ok(M() && M().hosts.host_hollow_pine, 'Hollow Pine host seeded');
  const hp = M().hosts.host_hollow_pine;
  ok(hp.rating === 5 && hp.attack === 6 && hp.sleaze === 8 && hp.dataProcessing === 5 && hp.firewall === 7, 'Hollow Pine 5 : 6/8/5/7');
  ok(hp.ic.some((i) => i.type === 'patrol' && i.active) && hp.spider === 'tpl_spider_junior' && hp.spiderAlert === 'tpl_spider_standard', 'Patrol IC + junior → standard spider');
  ok(Object.keys(pl.state.matrix.hosts).length === 0, 'players see no hidden host');
  ok(!pl.state.matrix.hosts.host_hollow_pine, 'host internals not sent to players');

  // Persona creation without connecting
  res = await pl.send('matrix/ensure', { actorId: 'pc_bricks' });
  ok(res.programSlots === 3 && res.agent?.rating === 6, 'matrix/ensure: deck slots from the catalog + agent detection before connecting');
  await expectFail(pj.send('matrix/ensure', { actorId: 'pc_bricks' }), /appartient/, 'ensure is owner-only');

  // Connection
  await expectFail(pl.send('matrix/connect', { actorId: 'pc_jane', mode: 'hot' }), /appartient/, 'player cannot connect someone else');
  res = await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'hot' });
  ok(res.initiative.text === '7 + 4D6', 'connect hot → initiative DP + INT + 4D6');
  await settle();
  ok(P().online && P().mode === 'hot' && P().programSlots === 3, `persona online, Shadow Warrior has 3 program slots (${P().programSlots})`);
  ok(P().agent && P().agent.rating === 6 && !P().agent.loaded, 'agent auto-detected (best rating 6), not loaded');
  ok(pl.state.matrix.personas.pc_bricks && !pj.state.matrix.personas.pc_bricks, 'only the owner sees the persona');

  // Programs
  await pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Stealth' });
  await pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Toolbox' });
  await pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Encryption' });
  await expectFail(pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Armor' }), /emplacement/, 'slot limit enforced');
  await expectFail(pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Exploit' }), /absent/, 'cannot load a program she does not own');
  await pl.send('matrix/unloadProgram', { actorId: 'pc_bricks', name: 'Encryption' });
  await expectFail(pl.send('matrix/agentAssist', { actorId: 'pc_bricks', actionId: 'hackOnTheFly' }), /pas chargé/, 'assist needs a loaded agent');
  await pl.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: true });
  await settle();
  ok(P().agent.loaded && P().loadedPrograms.length === 2, 'agent loaded in the third slot');

  // ASDF
  res = await pl.send('matrix/setASDF', { actorId: 'pc_bricks', swap: ['attack', 'sleaze'] });
  ok(res.eff.sleaze === 7 && res.eff.attack === 5, `swap Attack/Sleaze (S 6 + Stealth = 7) got ${JSON.stringify(res.eff)}`);
  await pj.send('matrix/connect', { actorId: 'pc_jane', mode: 'ar' });
  await expectFail(pj.send('matrix/setASDF', { actorId: 'pc_jane', swap: ['attack', 'sleaze'] }), /cyberdeck/, 'commlinks cannot swap');

  // Agent configuration
  await expectFail(pj.send('matrix/configureAgent', { actorId: 'pc_jane', rating: 3 }), /boutique/, 'no agent owned → shop hint');
  await expectFail(pl.send('matrix/configureAgent', { actorId: 'pc_bricks', rating: 6, name: 'Ghost' }).then(() => { throw new Error('ok-pass'); }), /ok-pass/, 'player configures her agent within owned rating');
  await gm.send('matrix/configureAgent', { actorId: 'pc_jane', rating: 2, name: 'Assistant' });

  // Targets and visibility
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine' }), /introuvable/, 'hidden host cannot be targeted');
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { visible: true } });
  await settle();
  ok(pl.state.matrix.hosts.host_hollow_pine && pl.state.matrix.hosts.host_hollow_pine.rating === undefined, 'visible host: name only, no rating before perception');
  ok(pl.state.matrix.hosts.host_hollow_pine.notes === undefined && pl.state.matrix.hosts.host_hollow_pine.spider === undefined, 'GM notes and spider stripped');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'enterHost', targetId: 'host:host_hollow_pine' }), /marque/, 'Enter Host needs a mark');

  // Hack on the Fly — success (loaded dice)
  await gm.send('matrix/testDice', { mode: 'actor' });
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine', marks: 3 });
  ok(res.success && res.roll.pool === 14 - 10 && res.defense.hits === 0, `HotF 3 marks: pool 14 − 10 = 4 (got ${res.roll.pool})`);
  ok(res.defense.pool === undefined, 'defense pool hidden from players');
  await settle();
  ok(P().marks.find((m) => m.targetId === 'host:host_hollow_pine')?.count === 3, '3 marks on the host');
  ok(P().overwatch === 0, 'no defender hits → OS unchanged');
  const mlogs = pl.state.log.filter((e) => e.kind === 'matrix');
  ok(mlogs.length && mlogs.every((e) => !e.matrix?.gm), 'matrix log visible to players without GM details');
  ok(mlogs.every((e) => !e.roll || !e.roll.actorId), 'matrix log rolls carry no actorId (no « 2ᵉ chance » on them)');
  ok(gm.state.log.some((e) => e.kind === 'matrix' && e.matrix?.gm?.defensePool === 12), 'GM log keeps the defense pool (5 + FW 7)');

  // Enter, perceive, files
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'enterHost', targetId: 'host:host_hollow_pine' });
  await settle();
  let ph = pl.state.matrix.hosts.host_hollow_pine;
  ok(P().hostId === 'host_hollow_pine' && ph.inside && ph.ic.length === 1 && ph.ic[0].rating === undefined, 'inside: active IC type visible, rating hidden');
  ok(ph.files.length === 0, 'files hidden before perception');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_registry' }), /Perception/, 'files need Matrix Perception first');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'host:host_hollow_pine' });
  await settle();
  ph = pl.state.matrix.hosts.host_hollow_pine;
  ok(res.success && ph.perceived && ph.rating === 5 && ph.files.length === 3 && ph.ic[0].rating === 5, 'perception reveals rating, IC ratings and files');
  ok(ph.files.every((f) => f.content === undefined), 'file contents never listed');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_relay' }), /protégé/, 'protected file must be cracked first');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'crackFile', targetId: 'file:host_hollow_pine:file_hp_relay' });
  await settle();
  ok(res.success && !M().hosts.host_hollow_pine.files.find((f) => f.id === 'file_hp_relay').protected, 'Crack File removes protection');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_relay', fileOp: 'copy' });
  await settle();
  ok(res.success && pl.state.matrix.personas.pc_bricks.files.some((f) => /L-07/.test(f.content)), 'Edit File copy brings the content into the deck');
  ok(M().hosts.host_hollow_pine.alert === 'none', 'cracking a file does not alert the host by itself');
  // Data bomb on the KE file: crack, then edit without disarming → explodes
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'crackFile', targetId: 'file:host_hollow_pine:file_hp_ke' });
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_ke' });
  await settle();
  ok(res.exploded && P().matrixDamage > 0 && !M().hosts.host_hollow_pine.files.some((f) => f.id === 'file_hp_ke'), `data bomb exploded (deck damage ${P().matrixDamage})`);
  await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { matrixDamage: 0 } });

  // Agent assist then action
  res = await pl.send('matrix/agentAssist', { actorId: 'pc_bricks', actionId: 'dataSpike' });
  ok(res.pendingAssist && res.pendingAssist.dice === Math.min(res.roll.hits, 6) && res.pendingAssist.limitBonus === 1, `agent assist stores bonus dice/limit (${JSON.stringify(res.pendingAssist)})`);
  ok(res.roll.pool === 12 && res.roll.limit === 5, `assist pool = 2 × 6, limit = deck Attack 5 (got ${res.roll.pool} [${res.roll.limit}])`);
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine', assistFromAgent: true }), /autre compétence/, 'assist is skill-specific');
  const icId = 'ic_hp_patrol';
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'dataSpike', targetId: `ic:host_hollow_pine:${icId}`, assistFromAgent: true });
  ok(res.success && res.roll.parts.some((p) => /agent/i.test(p.label)) && res.roll.limit === 6, `assisted Data Spike: bonus dice and limit 5 + 1 (got ${res.roll.limit})`);
  await settle();
  ok(P().pendingAssist === null, 'assist consumed');
  ok(M().hosts.host_hollow_pine.ic.find((i) => i.id === icId).damage > 0, 'Data Spike damaged the IC');

  // Agent acts on its own; failed sleaze → OS shared, host marks the decker
  await gm.send('matrix/testDice', { mode: 'opposition' });
  const osBefore = P().overwatch;
  res = await pl.send('matrix/agentAct', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'device:host_hollow_pine:dev_hp_cams' });
  await settle();
  ok(res.agent && res.success === false && res.roll.pool === 12 && P().overwatch === osBefore + res.defense.hits, `agent action: Rating × 2 pool, its OS goes to the deck (+${res.defense.hits})`);
  ok(P().marksOnMe.some((m) => m.sourceId === 'host:host_hollow_pine'), 'failed sleaze → host marks the decker');
  ok(gm.state.log.some((e) => e.kind === 'matrix' && /agent de Bricks/.test(e.author)), 'agent action logged under the agent name');

  // IC attacks
  await gm.send('matrix/icLaunch', { hostId: 'host_hollow_pine', type: 'black' });
  await settle();
  const black = M().hosts.host_hollow_pine.ic.find((i) => i.type === 'black');
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { rating: 1 } }); // small hit: the deck survives
  const physBefore = gm.state.actors.pc_bricks.condition.physical;
  res = await gm.send('matrix/icAct', { hostId: 'host_hollow_pine', icId: black.id, actorId: 'pc_bricks' });
  await settle();
  ok(res.success && P().matrixDamage > 0 && gm.state.actors.pc_bricks.condition.physical > physBefore, 'Black IC: matrix damage + physical biofeedback in hot sim');
  ok(P().linkLocked && /Noire/.test(P().linkLocked.name), 'Black IC link-locks');
  await expectFail(pl.send('matrix/disconnect', { actorId: 'pc_bricks' }), /Verrou/, 'link-locked: no graceful disconnect');
  await expectFail(pl.send('matrix/icAct', { hostId: 'host_hollow_pine', icId: black.id, actorId: 'pc_bricks' }), /MJ/, 'players cannot run IC');
  await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { linkLocked: null, matrixDamage: 0 } });
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { rating: 5 } });

  // Convergence
  await gm.send('matrix/setOverwatch', { actorId: 'pc_bricks', value: 39 });
  pl.events.length = 0;
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'snoop', targetId: 'device:host_hollow_pine:dev_hp_cams' });
  await settle();
  ok(res.convergence && !P().online && P().overwatch === 0 && P().marks.length === 0 && P().traced, 'OS 40 → convergence: dumped, OS reset, marks lost, location revealed');
  ok(P().matrixDamage >= 10, `convergence: 12 boxes of matrix damage (monitor 10, deck bricked) — ${P().matrixDamage}`);
  ok(P().bricked, 'deck bricked after convergence damage on a DR 3 deck');
  const evs = pl.events.filter((e) => e.ev === 'sfx').map((e) => e.data.id);
  ok(evs.includes('alarm') && evs.includes('matrix-glitch'), `convergence sfx (${evs.join(',')})`);
  await expectFail(pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' }), /briqué/, 'bricked deck cannot connect');
  await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { matrixDamage: 0 } });
  await settle();
  ok(!P().bricked, 'GM repair unbricks');

  // Dumpshock on forced disconnect
  await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' });
  const stunBefore = gm.state.actors.pc_bricks.condition.stun;
  res = await gm.send('matrix/disconnect', { actorId: 'pc_bricks', dump: true });
  await settle();
  ok(res.outcomes.some((s) => /Choc/.test(s)) && gm.state.actors.pc_bricks.condition.stun > stunBefore, 'GM dump in cold sim → stun dumpshock');

  // Glitch: critical glitch on assist crashes the agent
  await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' });
  await pl.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: true });
  await gm.send('matrix/testDice', { mode: 'glitch' });
  res = await pl.send('matrix/agentAssist', { actorId: 'pc_bricks', actionId: 'hackOnTheFly' });
  await settle();
  ok(res.roll.critGlitch && !P().agent.loaded && P().pendingAssist === null, 'critical glitch on assist crashes the agent');

  // Hidden OS setting
  await gm.send('matrix/setOverwatch', { actorId: 'pc_bricks', value: 12 });
  await gm.send('matrix/settings', { hideOverwatch: true });
  await settle();
  ok(pl.state.matrix.personas.pc_bricks.overwatchHidden && pl.state.matrix.personas.pc_bricks.overwatch === null, 'hidden OS: player sees only the last check');
  await gm.send('matrix/settings', { hideOverwatch: false });

  // GM host management
  res = await gm.send('matrix/hostCreate', { name: 'Test', rating: 8, preset: 'fortress' });
  await settle();
  let h = M().hosts[res.id];
  ok(h && h.attack === 9 && h.sleaze === 8 && h.dataProcessing === 10 && h.firewall === 11 && h.ic.length === 6 && h.ic.filter((i) => i.active).length === 1, 'host created from template with default IC suite');
  await gm.send('matrix/setMarks', { actorId: 'pc_bricks', targetId: `host:${res.id}`, name: 'Test', count: 2 });
  await gm.send('matrix/hostDelete', { hostId: res.id });
  await settle();
  ok(!M().hosts[res.id] && !P().marks.some((m) => m.targetId === `host:${res.id}`), 'host delete clears marks');
  await expectFail(pl.send('matrix/hostCreate', { name: 'x', rating: 3 }), /MJ/, 'players cannot create hosts');
  await gm.send('matrix/resetPersona', { actorId: 'pc_bricks' });
  await settle();
  ok(P() && !P().online && P().overwatch === 0, 'reset persona');

  // i18n: every matrix log entry of this run is translatable (keys, nested params, authors, roll labels)
  {
    const entries = (gm.state.log || []).filter((e) => e.kind === 'matrix');
    const keys = [];
    for (const e of entries) {
      ok(!!e.i18n?.key || !e.text, `matrix log entry has an i18n key: ${e.text}`);
      keys.push(...msgKeys(e.i18n), ...msgKeys(e.authorI18n), ...msgKeys(e.roll?.labelI18n));
    }
    const miss = [...new Set(missingEn(keys))];
    ok(entries.length > 10 && miss.length === 0, `matrix log keys translated (${entries.length} entries, missing: ${miss.join(' | ')})`);
    const sample = entries.map((e) => enT(e.i18n.key, e.i18n.params)).filter((s) => /⟦/.test(s));
    ok(sample.length === 0, `English rendering complete (${sample.slice(0, 3).join(' / ')})`);
    try {
      await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'nope' });
      ok(false, 'unknown action should fail');
    } catch (e) {
      ok(e.key ? !!EN[e.key] : /inconnue/.test(e.message), `error reply carries a translated key (${e.key || e.message})`);
    }
  }

  gm.close();
  pl.close();
  pj.close();
} catch (err) {
  failures++;
  console.error(err);
} finally {
  srv.stop();
}
console.log(`matrix: ${passes} ok, ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
