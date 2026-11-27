// Matrix module tests: shared rules (shared/matrix.js) + server actions (45-matrix.js) on an isolated server.
// Run: node tools/test-matrix.ts   (port 3600 or SR_TEST_PORT, exit code != 0 on failure)
import {
  programId, detectAgents, availablePrograms, deckStats, actionPool, matrixInitiative, matrixMonitor, ACTION_BY_ID,
  ACTIONS, PROGRAMS, IC_TYPES, hostAttributes, osLevel, dumpshock, programSlots, isPermutation, agentInitiative,
  ACTION_CATS, ACTION_TYPES, TARGET_KIND_LABELS, HOST_PRESETS, MODE_LABELS, ASDF_LABELS, nextStepHints, DEVICE_CMD_LABELS,
} from '../shared/matrix.ts';
import type { HintHost, PersonaLike, PoolPart } from '../shared/matrix.ts';
import type { Host, HostDevice, HostFile, MatrixAgent, MatrixMark, MatrixState, PlayerHostView } from '../shared/types.ts';
import { interpolate, stripContext } from '../client/i18n/format.ts';
import type { Dictionary, TParams } from '../client/i18n/format.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Shared rules
// ---------------------------------------------------------------------------
// raw seed JSON (actor fixtures)
const pcs: any[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'actors', 'pcs.json'), 'utf8'));
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
let persona: PersonaLike = { mode: 'hot', asdf: { attack: 'attack', sleaze: 'sleaze', dataProcessing: 'dataProcessing', firewall: 'firewall' }, loadedPrograms: ['Stealth', 'Toolbox'], noise: 3 };
let ds = deckStats(bricks, persona);
ok(ds.eff.sleaze === 6 && ds.eff.dataProcessing === 4 && ds.eff.attack === 6, 'program bonuses (Stealth +1 S, Toolbox +1 DP)');
ok(ds.noise === 3, 'noise without Signal Scrub');
let hof = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, {});
ok(hof.pool === 6 + 6 + 2 - 3 && hof.limit === 6, `Hack on the Fly: Hacking 6 + LOG 6 + hot 2 − noise 3 = 11 [6] (got ${hof.pool} [${hof.limit}])`);
hof = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, { marks: 3, assist: { dice: 3, limitBonus: 1 } });
ok(hof.pool === 11 - 10 + 3 && hof.limit === 7, 'extra marks −10, agent assist +3 dice / +1 limit');
hof = actionPool(bricks, persona, ACTION_BY_ID.hackOnTheFly, { edge: true });
ok(hof.limit === null && hof.pool === 11 + 5, 'Edge: +EDG dice, no limit');
const agentPool = actionPool(bricks, { ...persona, agent: { rating: 5 } as MatrixAgent }, ACTION_BY_ID.dataSpike, { agent: true });
ok(agentPool.pool === 10 - 3 && agentPool.limit === 6, `agent pool = Rating × 2 − noise, deck limit (got ${agentPool.pool} [${agentPool.limit}])`);
persona = { ...persona, asdf: { attack: 'sleaze', sleaze: 'attack', dataProcessing: 'dataProcessing', firewall: 'firewall' }, loadedPrograms: ['Signal Scrub'] };
ds = deckStats(bricks, persona);
ok(ds.eff.attack === 5 && ds.eff.sleaze === 6 && ds.noise === 1, 'ASDF swap + Signal Scrub −2 noise');
ok(isPermutation(persona.asdf) && !isPermutation({ attack: 'attack', sleaze: 'attack', dataProcessing: 'dataProcessing', firewall: 'firewall' }), 'isPermutation');
ok(matrixInitiative(bricks, { mode: 'cold' }).text === '7 + 3D6' && matrixInitiative(bricks, { mode: 'hot' }).text === '7 + 4D6', 'VR initiative = DP + INT + 3D6/4D6');
ok(matrixInitiative(bricks, { mode: 'ar' }).text === '9 + 1D6', 'AR initiative = physical');
ok(agentInitiative(bricks, { agent: { rating: 5 } as MatrixAgent }).text === '8 + 4D6', 'agent initiative = DP + Rating + 4D6');
ok(actionPool(jane, { mode: 'cold' }, ACTION_BY_ID.snoop).impossible, 'untrained Electronic Warfare cannot default');
ok(JSON.stringify(hostAttributes(5, 'shell')) === JSON.stringify({ attack: 6, sleaze: 8, dataProcessing: 5, firewall: 7 }), 'shell preset = Hollow Pine array');
ok(osLevel(36).id === 'critical' && osLevel(5).id === 'calm', 'OS levels');
ok(dumpshock('hot')!.type === 'P' && dumpshock('cold')!.type === 'S' && dumpshock('ar') === null, 'dumpshock P hot / S cold / none AR');
ok(programSlots({ programSlots: 3, loadedPrograms: ['Virtual Machine', 'Stealth'], agent: { loaded: true } as MatrixAgent }).total === 5, 'Virtual Machine adds 2 slots');
ok(Object.values(IC_TYPES).every((t) => t.fr && t.defense && t.effect), 'IC types complete');

// ---------------------------------------------------------------------------
// i18n: English dictionary covers the rules vocabulary and every server message
// ---------------------------------------------------------------------------
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'en');
const EN: Dictionary = {};
for (const f of fs.readdirSync(DICT_DIR).filter((x) => x.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)))) {
  Object.assign(EN, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
}
const enT = (key: string, params?: TParams): string => (EN[key] ? interpolate(EN[key], params, enT) : `⟦${stripContext(key)}⟧`);
/** Every translatable key inside a message / { key, params } (nested params included). */
type MsgLike = { t?: unknown; key?: unknown; params?: object };
function msgKeys(m: unknown, out: string[] = []): string[] {
  if (!m || typeof m !== 'object') return out;
  const k = (m as MsgLike).t || (m as MsgLike).key;
  if (typeof k === 'string') out.push(k);
  for (const v of Object.values((m as MsgLike).params || {})) {
    if (Array.isArray(v)) v.forEach((x) => msgKeys(x, out));
    else msgKeys(v, out);
  }
  return out;
}
const missingEn = (keys: string[]) => keys.filter((k) => !EN[k]);
{
  const vocab = [
    ...ACTIONS.flatMap((a) => [a.fr, a.desc]), ...Object.values(IC_TYPES).flatMap((t) => [t.fr, t.desc]), ...PROGRAMS.map((p) => p.effect),
    ...Object.values(ACTION_CATS), ...Object.values(ACTION_TYPES), ...Object.values(TARGET_KIND_LABELS), ...Object.values(HOST_PRESETS).map((p) => p.label),
    ...Object.values(MODE_LABELS), ...Object.values(ASDF_LABELS), ...[0, 10, 20, 30, 36].map((n) => osLevel(n).label),
  ];
  ok(missingEn(vocab).length === 0, `rules vocabulary translated (missing: ${missingEn(vocab).join(' | ')})`);
  ok(ACTIONS.every((a) => EN[a.fr] === a.en || a.id === 'rebootSelf'), `action names match their official English name (${ACTIONS.filter((a) => EN[a.fr] !== a.en).map((a) => a.id).join(', ')})`);
  ok(Object.values(IC_TYPES).every((t) => EN[t.fr] === t.en), 'IC names match their official English name');
  const parts = actionPool(bricks, { mode: 'hot', noise: 2, asdf: null, loadedPrograms: ['Exploit'] } as unknown as PersonaLike, ACTION_BY_ID.hackOnTheFly, { marks: 2, modifier: 1, useSpec: true, edge: true });
  ok(missingEn(parts.parts.concat(parts.limitParts).filter((p) => p.key).map((p) => p.key!)).length === 0, 'pool part keys translated');
  // Next-step hints (cockpit « Conseils »)
  const hosts = { h1: { id: 'h1', name: 'H', visible: true } };
  const base: PersonaLike = { online: true, mode: 'hot', marks: [], overwatch: 0, files: [] };
  let hs = nextStepHints({ actor: bricks, persona: { online: false }, hosts });
  ok(/^Connecte-toi/.test(hs[0]?.key), 'hint: offline → connect');
  hs = nextStepHints({ actor: bricks, persona: base, hosts });
  ok(hs.some((h) => h.actionId === 'hackOnTheFly' && h.targetId === 'host:h1'), 'hint: visible host without mark → Hack on the Fly');
  hs = nextStepHints({ actor: bricks, persona: { ...base, marks: [{ targetId: 'host:h1', count: 1 }] as MatrixMark[] }, hosts });
  ok(hs.some((h) => h.actionId === 'enterHost'), 'hint: marked host → enter');
  hs = nextStepHints({ actor: bricks, persona: { ...base, hostId: 'h1' }, hosts: { h1: { ...hosts.h1, perceived: false } } });
  ok(hs.some((h) => h.actionId === 'matrixPerception'), 'hint: inside, not perceived → Matrix Perception');
  const files = [{ id: 'a', name: 'A', protected: true }, { id: 'b', name: 'B', bomb: 3 }, { id: 'c', name: 'C' }] as HintHost['files'];
  hs = nextStepHints({ actor: bricks, persona: { ...base, hostId: 'h1', overwatch: 32 }, hosts: { h1: { ...hosts.h1, perceived: true, files, devices: [{ id: 'd', name: 'Porte', link: { kind: 'door' } }] } } });
  ok(hs[0].tone === 'danger' && ['crackFile', 'disarmDataBomb', 'editFile', 'controlDevice'].every((id) => hs.some((h) => h.actionId === id)), 'hint: OS 32 warning first, then crack / disarm / copy / control');
  ok(missingEn(hs.map((h) => h.key)).length === 0 && Object.values(DEVICE_CMD_LABELS).every((m) => missingEn(Object.values(m)).length === 0), 'hints and device commands translated');
  const imp = actionPool(jane, { mode: 'cold' }, ACTION_BY_ID.snoop);
  ok(imp.reasonKey && EN[imp.reasonKey] && enT(imp.reasonKey, imp.reasonParams) === 'Electronic Warfare cannot be used untrained', `impossible reason translated (${enT(imp.reasonKey!, imp.reasonParams)})`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
process.env.SR_MATRIX_TEST = '1';
const { startServer, login, client, settle } = await import('./test-client.ts');
const srv = await startServer({ port: Number(process.env.SR_TEST_PORT) || 3600 });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const pl = await client(srv.url, await login(srv.url, { role: 'player', name: 'Sploadie', characterId: 'pc_bricks' }));
  const pj = await client(srv.url, await login(srv.url, { role: 'player', name: 'Baptiste', characterId: 'pc_jane' }));
  await settle();
  let res: any; // action results differ per action (untyped send)
  const M = () => gm.state.matrix as MatrixState; // GM view: full hosts
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
  ok(P().agent && P().agent!.rating === 6 && !P().agent!.loaded, 'agent auto-detected (best rating 6), not loaded');
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
  ok(P().agent!.loaded && P().loadedPrograms.length === 2, 'agent loaded in the third slot');

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
  ok((pl.state.matrix.hosts.host_hollow_pine as Host).notes === undefined && (pl.state.matrix.hosts.host_hollow_pine as Host).spider === undefined, 'GM notes and spider stripped');
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
  let ph = pl.state.matrix.hosts.host_hollow_pine as PlayerHostView;
  ok(P().hostId === 'host_hollow_pine' && ph.inside && ph.ic.length === 1 && ph.ic[0].rating === undefined, 'inside: active IC type visible, rating hidden');
  ok(ph.files.length === 0, 'files hidden before perception');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_registry' }), /Perception/, 'files need Matrix Perception first');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'host:host_hollow_pine' });
  await settle();
  ph = pl.state.matrix.hosts.host_hollow_pine as PlayerHostView;
  ok(res.success && ph.perceived && ph.rating === 5 && ph.files.length === 3 && ph.ic[0].rating === 5, 'perception reveals rating, IC ratings and files');
  ok(ph.files.every((f) => (f as Partial<HostFile>).content === undefined), 'file contents never listed');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_relay' }), /protégé/, 'protected file must be cracked first');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'crackFile', targetId: 'file:host_hollow_pine:file_hp_relay' });
  await settle();
  ok(res.success && !M().hosts.host_hollow_pine.files.find((f) => f.id === 'file_hp_relay')!.protected, 'Crack File removes protection');
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
  ok(res.success && res.roll.parts.some((p: PoolPart) => /agent/i.test(p.label)) && res.roll.limit === 6, `assisted Data Spike: bonus dice and limit 5 + 1 (got ${res.roll.limit})`);
  await settle();
  ok(P().pendingAssist === null, 'assist consumed');
  ok(M().hosts.host_hollow_pine.ic.find((i) => i.id === icId)!.damage > 0, 'Data Spike damaged the IC');

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
  const black = M().hosts.host_hollow_pine.ic.find((i) => i.type === 'black')!;
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { rating: 1 } }); // small hit: the deck survives
  const physBefore = gm.state.actors.pc_bricks.condition.physical;
  res = await gm.send('matrix/icAct', { hostId: 'host_hollow_pine', icId: black.id, actorId: 'pc_bricks' });
  await settle();
  ok(res.success && P().matrixDamage > 0 && gm.state.actors.pc_bricks.condition.physical > physBefore, 'Black IC: matrix damage + physical biofeedback in hot sim');
  ok(P().linkLocked && /Noire/.test(P().linkLocked!.name), 'Black IC link-locks');
  await expectFail(pl.send('matrix/disconnect', { actorId: 'pc_bricks' }), /Verrou/, 'link-locked: no graceful disconnect');
  await expectFail(pl.send('matrix/icAct', { hostId: 'host_hollow_pine', icId: black.id, actorId: 'pc_bricks' }), /MJ/, 'players cannot run IC');
  await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { linkLocked: null, matrixDamage: 0 } });
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { rating: 5 } });

  // Convergence inside a host (SR5 p. 247): 3 host marks, alert, IC deployed, still online; leaving → grid convergence
  await gm.send('matrix/setOverwatch', { actorId: 'pc_bricks', value: 39 });
  pl.events.length = 0;
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'snoop', targetId: 'device:host_hollow_pine:dev_hp_cams' });
  await settle();
  ok(res.convergence && P().online && P().hostId === 'host_hollow_pine' && P().hostConverged === 'host_hollow_pine', 'OS 40 inside a host → host convergence, still online');
  ok(P().marksOnMe.find((m) => m.sourceId === 'host:host_hollow_pine')?.count === 3 && M().hosts.host_hollow_pine.alert === 'active', 'host convergence: 3 host marks + alert');
  ok(P().matrixDamage === 0, 'host convergence: no 12 DV');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'snoop', targetId: 'device:host_hollow_pine:dev_hp_cams' });
  ok(!res.convergence, 'no second convergence while inside the converged host');
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'exitHost' });
  await settle();
  ok(res.convergence && !P().online && P().overwatch === 0 && P().marks.length === 0 && P().traced, 'leaving the host → grid convergence: dumped, OS reset, marks lost, location revealed');
  ok(P().matrixDamage >= 10, `grid convergence: 12 DV resisted with DR + Firewall (no hits on loaded dice) — ${P().matrixDamage}`);
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
  ok(res.outcomes.some((s: string) => /Choc/.test(s)) && gm.state.actors.pc_bricks.condition.stun > stunBefore, 'GM dump in cold sim → stun dumpshock');

  // Glitch: critical glitch on assist crashes the agent
  await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' });
  await pl.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: true });
  await gm.send('matrix/testDice', { mode: 'glitch' });
  res = await pl.send('matrix/agentAssist', { actorId: 'pc_bricks', actionId: 'hackOnTheFly' });
  await settle();
  ok(res.roll.critGlitch && !P().agent!.loaded && P().pendingAssist === null, 'critical glitch on assist crashes the agent');

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

  // ---------------------------------------------------------------- GM helpers: host turn, OS over time, combat tracker
  await gm.send('matrix/testDice', { mode: 'actor' });
  await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'hot' });
  await gm.send('matrix/setMarks', { actorId: 'pc_bricks', targetId: 'host:host_hollow_pine', name: 'Hollow Pine Holdings', count: 1 });
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'enterHost', targetId: 'host:host_hollow_pine' });
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { alert: 'none', spotted: [], ic: M().hosts.host_hollow_pine.ic.map((i) => ({ ...i, active: i.type === 'patrol', crashed: false, damage: 0 })) } });
  await settle();
  // Host turn, calm host: the patrol looks for Bricks (loaded dice: the decker side wins → she dodges), no IC launched
  res = await gm.send('matrix/hostTurn', { hostId: 'host_hollow_pine' });
  ok(res.results.length === 1 && res.results[0].actorId === 'pc_bricks' && res.results[0].result && !res.msgs.length, `calm host turn: only the patrol acts (${JSON.stringify(res.outcomes)})`);
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { alert: 'active', spotted: ['pc_bricks'] } });
  res = await gm.send('matrix/hostTurn', { hostId: 'host_hollow_pine' });
  await settle();
  const hpIc = () => M().hosts.host_hollow_pine.ic;
  ok(hpIc().filter((i) => i.active).length === 2 && res.msgs.length === 1, 'alerted host turn: the next IC of the suite is launched');
  ok(res.results.some((r: { skipped?: string }) => r.skipped && /surveille/.test(r.skipped)), 'patrol skips when everyone is already spotted');
  ok(res.results.some((r: { result?: unknown; actorId?: string }) => r.result && r.actorId === 'pc_bricks'), 'the launched IC attacks Bricks');
  // Overwatch: manual 15-minute tick, then the automatic timer
  await gm.send('matrix/setOverwatch', { actorId: 'pc_bricks', value: 5 });
  res = await gm.send('matrix/osTick', { actorId: 'pc_bricks' });
  await settle();
  ok(res.added >= 2 && res.added <= 12 && P().overwatch === 5 + res.added, `+2D6 OS tick (${res.added})`);
  ok(!pl.state.log.some((e) => e.matrix?.event === 'osTick') && gm.state.log.some((e) => e.matrix?.event === 'osTick'), 'OS tick is GM-only');
  await gm.send('matrix/settings', { osTimer: true });
  await gm.send('matrix/setOverwatch', { actorId: 'pc_bricks', value: 3 });
  await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { osClock: Date.now() - 31 * 60 * 1000 } });
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'host:host_hollow_pine' });
  await settle();
  ok(P().overwatch! >= 3 + 4 && P().overwatch! <= 3 + 24 && Date.now() - P().osClock! < 15 * 60 * 1000, `timer: 31 minutes online → two 2D6 ticks at the next action (OS ${P().overwatch})`);
  await gm.send('matrix/settings', { osTimer: false });
  await gm.send('matrix/setOverwatch', { actorId: 'pc_bricks', value: 0 });

  // Combat tracker: the decker in VR, her agent and the host's running IC join the order
  // (earlier random biofeedback / dumpshock may have knocked Bricks out: an incapacitated entry would not wait for her roll)
  await gm.send('actor/heal', { actorId: 'pc_bricks', amount: 30, type: 'S' });
  await gm.send('actor/heal', { actorId: 'pc_bricks', amount: 30, type: 'P' });
  await pl.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: true });
  await gm.send('combat/start', { includeMapTokens: false });
  await gm.send('combat/add', { actorIds: ['pc_bricks'] });
  await settle();
  let ents = () => gm.state.combat.entries;
  const icEnts = () => ents().filter((e) => e.kind === 'ic' && !e.out);
  ok(icEnts().length === 2 && icEnts().every((e) => e.score > 0 && !e.toRoll), `running IC join the fight, rolled (${icEnts().map((e) => `${e.name} ${e.score}`).join(', ')})`);
  ok(ents().some((e) => e.kind === 'agent' && e.ownerId === 'pc_bricks' && !e.out), 'the loaded agent joins the fight');
  ok(ents().find((e) => e.actorId === 'pc_bricks')!.mode === 'hot', 'the decker’s entry uses her hot VR initiative');
  ok(pl.state.combat.entries.some((e) => e.kind === 'agent'), 'the player sees her agent in the tracker');
  // An IC with the best score acts first once the decker has rolled; then « Agir et passer »
  const firstIc = icEnts()[0];
  await gm.send('combat/setScore', { entryId: firstIc.id, score: 60 });
  await pl.send('combat/roll', { entryId: ents().find((e) => e.actorId === 'pc_bricks')!.id });
  await settle();
  const deckerEntry = ents().find((e) => e.actorId === 'pc_bricks')!;
  ok(deckerEntry.base === 7 && deckerEntry.dice === 4, `decker rolls DP + INT + 4D6 in hot VR (${deckerEntry.base} + ${deckerEntry.dice}D6)`);
  ok(gm.state.combat.currentId === firstIc.id, 'the IC (score 60) has the first turn');
  res = await gm.send('matrix/icTurn', { hostId: firstIc.hostId, icId: firstIc.icId, entryId: firstIc.id });
  await settle();
  ok(res.advanced && gm.state.combat.currentId !== firstIc.id, 'IC acts and passes its turn');
  await expectFail(pl.send('matrix/icTurn', { hostId: firstIc.hostId, icId: firstIc.icId }), /MJ/, 'players cannot run IC turns');
  // New Combat Turn: the alerted host launches one more IC, which joins the order
  const activeBefore = hpIc().filter((i) => i.active).length;
  await gm.send('combat/newTurn', {});
  await settle();
  ok(hpIc().filter((i) => i.active).length === Math.min(activeBefore + 1, hpIc().length) && icEnts().length === hpIc().filter((i) => i.active).length, 'new Combat Turn: alerted host launches its next IC (auto)');
  // Leaving the host takes its IC out of the order; unloading the agent too
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'exitHost' });
  await pl.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: false });
  await settle();
  ok(icEnts().length === 0 && !ents().some((e) => e.kind === 'agent' && !e.out), 'IC and agent leave the order with the decker');
  await gm.send('combat/end', {});

  // ---------------------------------------------------------------- Devices linked to the map
  const mapId = await gm.send('maps/create', { name: 'Test devices', width: 10, height: 8 });
  const doorId = await gm.send('maps/addDoor', { mapId, door: { x: 4, y: 0, state: 'locked' } });
  const lightId = await gm.send('maps/addLight', { mapId, light: { x: 2, y: 2, radius: 4, on: true } });
  const regionId = await gm.send('maps/addRegion', { mapId, region: { name: 'Hall', x: 1, y: 1, w: 4, h: 4 } });
  const devs = M().hosts.host_hollow_pine.devices.map((d) => ({ ...d }));
  devs.find((d) => d.id === 'dev_hp_maglock')!.link = { mapId, kind: 'door', targetId: doorId };
  devs.find((d) => d.id === 'dev_hp_cams')!.link = { mapId, kind: 'camera', targetId: regionId };
  devs.push({ id: 'dev_test_light', name: 'Néons', rating: 3, link: { mapId, kind: 'light', targetId: lightId } } as HostDevice); // partial device, the server normalizes it
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { devices: devs } });
  await settle();
  const map = () => gm.state.maps[mapId];
  ok(map().regions[0].cams === 'on', 'linking a camera zone marks it as filmed');
  await gm.send('matrix/setMarks', { actorId: 'pc_bricks', targetId: 'host:host_hollow_pine', name: 'Hollow Pine Holdings', count: 3 });
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'enterHost', targetId: 'host:host_hollow_pine' });
  await settle();
  const pdev = (pl.state.matrix.hosts.host_hollow_pine as PlayerHostView).devices.find((d) => d.id === 'dev_hp_maglock');
  ok(pdev?.link?.kind === 'door' && pdev.link.state === 'locked', `player sees the device's map link and state (${JSON.stringify(pdev?.link)})`);
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'controlDevice', targetId: 'device:host_hollow_pine:dev_hp_maglock', deviceCmd: 'open' });
  await settle();
  ok(res.success && map().doors.find((d) => d.id === doorId)!.state === 'open', 'Control Device « open » opens the door on the map');
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'controlDevice', targetId: 'device:host_hollow_pine:dev_hp_cams', deviceCmd: 'off' });
  await settle();
  ok(map().regions[0].cams === 'off', 'cutting the camera feed marks the zone');
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'rebootDevice', targetId: 'device:host_hollow_pine:dev_test_light' });
  await settle();
  ok(map().lights[0].on === false, 'rebooting the light device turns the light off');
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { devices: M().hosts.host_hollow_pine.devices.map((d) => (d.id === 'dev_test_light' ? { ...d, offline: false } : d)) } });
  await settle();
  ok(map().lights[0].on === true, 'back online (GM) → the light comes back');

  // ---------------------------------------------------------------- Share paydata with the team
  await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_registry', fileOp: 'copy' });
  await settle();
  const fileId = P().files[0]?.id;
  res = await pl.send('matrix/shareFile', { actorId: 'pc_bricks', fileId });
  await settle();
  const note = Object.values(pl.state.notes?.pages || {}).find((n) => n.id === res.id);
  ok(note && note.scope === 'party' && note.title === P().files[0].name && /L-07|Récupéré/.test(note.body), 'shared file → party note');
  ok(P().files[0].shared, 'file flagged as shared');
  await expectFail(pj.send('matrix/shareFile', { actorId: 'pc_bricks', fileId }), /appartient/, 'only the owner shares');
  res = await gm.send('matrix/shareFile', { actorId: 'pc_bricks', fileId });
  await settle();
  ok(res.handoutId && pl.state.campaign.handouts.some((h) => h.id === res.handoutId), 'GM share → handout revealed to the players');

  // i18n: every matrix log entry of this run is translatable (keys, nested params, authors, roll labels)
  {
    const entries = (gm.state.log || []).filter((e) => e.kind === 'matrix');
    const keys: string[] = [];
    for (const e of entries) {
      ok(!!e.i18n?.key || !e.text, `matrix log entry has an i18n key: ${e.text}`);
      keys.push(...msgKeys(e.i18n), ...msgKeys(e.authorI18n), ...msgKeys(e.roll?.labelI18n));
    }
    const miss = [...new Set(missingEn(keys))];
    ok(entries.length > 10 && miss.length === 0, `matrix log keys translated (${entries.length} entries, missing: ${miss.join(' | ')})`);
    const sample = entries.map((e) => enT(e.i18n!.key, e.i18n!.params)).filter((s) => /⟦/.test(s));
    ok(sample.length === 0, `English rendering complete (${sample.slice(0, 3).join(' / ')})`);
    try {
      await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'nope' });
      ok(false, 'unknown action should fail');
    } catch (e) {
      const ke = e as Error & { key?: string }; // an optional i18n key on the error (the harness sets none: message fallback)
      ok(ke.key ? !!EN[ke.key] : /inconnue/.test(ke.message), `error reply carries a translated key (${ke.key || ke.message})`);
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
