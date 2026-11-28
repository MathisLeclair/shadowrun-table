// Matrix module tests: shared rules (shared/matrix.js) + server actions (45-matrix.js) on an isolated server.
// Run: node tools/test-matrix.ts   (port 3600 or SR_TEST_PORT, exit code != 0 on failure)
import {
  programId, detectAgents, availablePrograms, deckStats, actionPool, matrixInitiative, matrixMonitor, ACTION_BY_ID,
  ACTIONS, PROGRAMS, IC_TYPES, hostAttributes, osLevel, dumpshock, programSlots, isPermutation, agentInitiative,
  ACTION_CATS, ACTION_TYPES, TARGET_KIND_LABELS, HOST_PRESETS, MODE_LABELS, ASDF_LABELS, nextStepHints, DEVICE_CMD_LABELS,
  markPenalty, convergenceAt, hasMatrixQuality, personaDefensePool, biofeedbackDice, OS_MAX, panDevices, panMaster, panDefensePool, searchMinutes, isMatrixDevice,
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
ok(hof.pool === 11 - 6 + 3 && hof.limit === 7, 'extra marks −6 (Bricks has Go Big or Go Home, DT p. 44), agent assist +3 dice / +1 limit');
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
// i18n: the French dictionary covers the rules vocabulary and every server message (English is the source text)
// ---------------------------------------------------------------------------
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'fr');
const FR: Dictionary = {};
for (const f of fs.readdirSync(DICT_DIR).filter((x) => x.endsWith('.json')).sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)))) {
  Object.assign(FR, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
}
const LEGACY: Dictionary = JSON.parse(fs.readFileSync(path.join(ROOT, 'client', 'i18n', 'legacy-fr-keys.json'), 'utf8'));
const cur = (key: string): string => LEGACY[key] || key;
/** Strict French t(): a key without a French entry renders as ⟦key⟧. */
const frT = (key: string, params?: TParams | null): string => (FR[cur(key)] ? interpolate(FR[cur(key)], params, frT) : `⟦${stripContext(key)}⟧`);
/** English = the source text. */
const enT = (key: string, params?: TParams | null): string => interpolate(stripContext(cur(key)), params, enT);
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
const missingFr = (keys: string[]) => keys.filter((k) => !FR[cur(k)]);
{
  const vocab = [
    ...ACTIONS.flatMap((a) => [a.fr, a.desc]), ...Object.values(IC_TYPES).flatMap((t) => [t.fr, t.desc]), ...PROGRAMS.map((p) => p.effect),
    ...Object.values(ACTION_CATS), ...Object.values(ACTION_TYPES), ...Object.values(TARGET_KIND_LABELS), ...Object.values(HOST_PRESETS).map((p) => p.label),
    ...Object.values(MODE_LABELS), ...Object.values(ASDF_LABELS), ...[0, 10, 20, 30, 36].map((n) => osLevel(n).label),
  ];
  ok(missingFr(vocab).length === 0, `rules vocabulary translated (missing: ${missingFr(vocab).join(' | ')})`);
  ok(ACTIONS.every((a) => enT(a.fr) === a.en || a.id === 'rebootSelf'), `action names match their official English name (${ACTIONS.filter((a) => enT(a.fr) !== a.en).map((a) => a.id).join(', ')})`);
  ok(Object.values(IC_TYPES).every((t) => enT(t.fr) === t.en), 'IC names match their official English name');
  ok(frT(ACTION_BY_ID.hackOnTheFly.fr) === 'Piratage à la volée' || !/⟦/.test(frT(ACTION_BY_ID.hackOnTheFly.fr)), `action names render in French (${frT(ACTION_BY_ID.hackOnTheFly.fr)})`);
  const parts = actionPool(bricks, { mode: 'hot', noise: 2, asdf: null, loadedPrograms: ['Exploit'] } as unknown as PersonaLike, ACTION_BY_ID.hackOnTheFly, { marks: 2, modifier: 1, useSpec: true, edge: true });
  ok(missingFr(parts.parts.concat(parts.limitParts).filter((p) => p.key).map((p) => p.key!)).length === 0, 'pool part keys translated');
  // Next-step hints (cockpit « Conseils »)
  const hosts = { h1: { id: 'h1', name: 'H', visible: true } };
  const base: PersonaLike = { online: true, mode: 'hot', marks: [], overwatch: 0, files: [] };
  let hs = nextStepHints({ actor: bricks, persona: { online: false }, hosts });
  ok(/^Connect/.test(hs[0]?.key), `hint: offline → connect (${hs[0]?.key})`);
  hs = nextStepHints({ actor: bricks, persona: base, hosts });
  ok(hs.some((h) => h.actionId === 'hackOnTheFly' && h.targetId === 'host:h1'), 'hint: visible host without mark → Hack on the Fly');
  hs = nextStepHints({ actor: bricks, persona: { ...base, marks: [{ targetId: 'host:h1', count: 1 }] as MatrixMark[] }, hosts });
  ok(hs.some((h) => h.actionId === 'enterHost'), 'hint: marked host → enter');
  hs = nextStepHints({ actor: bricks, persona: { ...base, hostId: 'h1' }, hosts: { h1: { ...hosts.h1, perceived: false } } });
  ok(hs.some((h) => h.actionId === 'matrixPerception'), 'hint: inside, not perceived → Matrix Perception');
  const files = [{ id: 'a', name: 'A', protected: true }, { id: 'b', name: 'B', bomb: 3 }, { id: 'c', name: 'C' }] as HintHost['files'];
  hs = nextStepHints({ actor: bricks, persona: { ...base, hostId: 'h1', overwatch: 32 }, hosts: { h1: { ...hosts.h1, perceived: true, files, devices: [{ id: 'd', name: 'Porte', link: { kind: 'door' } }] } } });
  ok(hs[0].tone === 'danger' && ['crackFile', 'disarmDataBomb', 'editFile', 'controlDevice'].every((id) => hs.some((h) => h.actionId === id)), 'hint: OS 32 warning first, then crack / disarm / copy / control');
  ok(missingFr(hs.map((h) => h.key)).length === 0 && Object.values(DEVICE_CMD_LABELS).every((m) => missingFr(Object.values(m)).length === 0), 'hints and device commands translated');
  const imp = actionPool(jane, { mode: 'cold' }, ACTION_BY_ID.snoop);
  ok(imp.reasonKey && enT(imp.reasonKey, imp.reasonParams) === 'Electronic Warfare cannot be used untrained', `impossible reason in English (${imp.reasonKey && enT(imp.reasonKey, imp.reasonParams)})`);
  ok(imp.reasonKey && frT(imp.reasonKey, imp.reasonParams) === 'Guerre électronique ne peut pas être utilisée sans formation', `impossible reason translated (${imp.reasonKey && frT(imp.reasonKey, imp.reasonParams)})`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
process.env.SR_MATRIX_TEST = '1';

// Data Trails (issue #2): cockpit qualities, programs, echoes
{
  const withQ = (names: string[], extra: Record<string, unknown> = {}) => ({ ...structuredClone(bricks), qualities: names.map((name, i) => ({ id: `dt${i}`, name, karma: 0 })), ...extra });
  const plain: PersonaLike = { mode: 'cold', loadedPrograms: [], noise: 0 };
  ok(markPenalty(withQ([]), 3) === -10 && markPenalty(bricks, 3) === -6 && markPenalty(withQ(['Go Big or Go Home']), 3) === -6 && markPenalty(withQ(['Comme un bourrin']), 2) === -4, 'Go Big or Go Home: 3 marks at −6 (French name too), 2 marks unchanged');
  const hof3 = actionPool(withQ(['Go Big or Go Home']), plain, ACTION_BY_ID.hackOnTheFly, { marks: 3 });
  ok(hof3.parts.some((p) => p.value === -6 && p.key === '{n} marks'), 'Go Big or Go Home: actionPool shows the −6 marks part');
  ok(convergenceAt(bricks) === OS_MAX && convergenceAt(withQ(['Wanted by GOD'])) === 30, 'Wanted by GOD: convergence at 30');
  ok(deckStats(withQ(['Faraday Himself']), plain).noise === 2 && deckStats(withQ(['Faraday Himself']), { ...plain, loadedPrograms: ['Signal Scrub'] }).noise === 0, 'Faraday Himself: +2 Noise, reduced by Signal Scrub');
  ok(hasMatrixQuality(withQ(['Virtual Stability (AI)']), 'virtualStability'), 'quality names match without a trailing « (…) »');
  const crash = actionPool(bricks, { ...plain, loadedPrograms: ['Crash (Program)'] }, ACTION_BY_ID.rebootDevice, {});
  ok(crash.limitParts.some((p) => p.value === 2), 'Crash program: +2 limit on Reboot Device');
  const base = actionPool(bricks, plain, ACTION_BY_ID.crashProgram, {});
  const tar = actionPool(bricks, { ...plain, loadedPrograms: ['Tarball'] }, ACTION_BY_ID.crashProgram, {});
  ok(tar.pool === base.pool + 1 && tar.limit === (base.limit as number) + 2, 'Tarball: Crash Program +1 die, +2 limit');
  const paint = actionPool(bricks, { ...plain, loadedPrograms: ['Paintjob'] }, ACTION_BY_ID.eraseMark, {});
  ok(paint.limitParts.some((p) => p.value === 2), 'Paintjob: +2 limit on Erase Mark');
  const d0 = personaDefensePool(bricks, plain, ACTION_BY_ID.rebootDevice.defense, 'rebootDevice')!;
  const d1 = personaDefensePool(bricks, { ...plain, loadedPrograms: ['Swerve'] }, ACTION_BY_ID.rebootDevice.defense, 'rebootDevice')!;
  const d2 = personaDefensePool(bricks, { ...plain, loadedPrograms: ['Swerve'] }, ACTION_BY_ID.dataSpike.defense, 'dataSpike')!;
  ok(d1.pool === d0.pool + 1 && d2.pool === personaDefensePool(bricks, plain, ACTION_BY_ID.dataSpike.defense, 'dataSpike')!.pool, 'Swerve: +1 Firewall against Reboot Device only');
  const tm = { ...structuredClone(bricks), gear: [], matrix: { ...bricks.matrix, programs: [] }, magic: { echoes: ['Resonance [Armor]', 'Resonance Link'] } };
  ok(availablePrograms(tm).length === 1 && availablePrograms(tm)[0].id === 'armor', 'echo Resonance [Program]: that program is available');
  const nh = [{ id: 'q:1:0', source: { list: 'qualities', itemId: '1', name: 'Natural Hardening' }, type: 'stat', target: 'biofeedback', value: 1, condition: null },
    { id: 'q:2:0', source: { list: 'qualities', itemId: '2', name: 'Scorched' }, type: 'stat', target: 'biofeedback', value: -2, condition: 'q-black-ic' }] as Parameters<typeof biofeedbackDice>[0];
  ok(biofeedbackDice(nh) === 1 && biofeedbackDice(nh, true) === -1, 'biofeedback resistance: Natural Hardening always, Scorched against Black IC');
}

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
  await expectFail(pj.send('matrix/ensure', { actorId: 'pc_bricks' }), /not yours/, 'ensure is owner-only');

  // Connection
  await expectFail(pl.send('matrix/connect', { actorId: 'pc_jane', mode: 'hot' }), /not yours/, 'player cannot connect someone else');
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
  await expectFail(pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Armor' }), /No free slot/, 'slot limit enforced');
  await expectFail(pl.send('matrix/loadProgram', { actorId: 'pc_bricks', name: 'Exploit' }), /not on your deck/, 'cannot load a program she does not own');
  await pl.send('matrix/unloadProgram', { actorId: 'pc_bricks', name: 'Encryption' });
  await expectFail(pl.send('matrix/agentAssist', { actorId: 'pc_bricks', actionId: 'hackOnTheFly' }), /not loaded/, 'assist needs a loaded agent');
  await pl.send('matrix/agentLoad', { actorId: 'pc_bricks', loaded: true });
  await settle();
  ok(P().agent!.loaded && P().loadedPrograms.length === 2, 'agent loaded in the third slot');

  // ASDF
  res = await pl.send('matrix/setASDF', { actorId: 'pc_bricks', swap: ['attack', 'sleaze'] });
  ok(res.eff.sleaze === 7 && res.eff.attack === 5, `swap Attack/Sleaze (S 6 + Stealth = 7) got ${JSON.stringify(res.eff)}`);
  await pj.send('matrix/connect', { actorId: 'pc_jane', mode: 'ar' });
  await expectFail(pj.send('matrix/setASDF', { actorId: 'pc_jane', swap: ['attack', 'sleaze'] }), /cyberdeck/, 'commlinks cannot swap');

  // Agent configuration
  await expectFail(pj.send('matrix/configureAgent', { actorId: 'pc_jane', rating: 3 }), /shop/, 'no agent owned → shop hint');
  await expectFail(pl.send('matrix/configureAgent', { actorId: 'pc_bricks', rating: 6, name: 'Ghost' }).then(() => { throw new Error('ok-pass'); }), /ok-pass/, 'player configures her agent within owned rating');
  await gm.send('matrix/configureAgent', { actorId: 'pc_jane', rating: 2, name: 'Assistant' });

  // Targets and visibility
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine' }), /not found/, 'hidden host cannot be targeted');
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { visible: true } });
  await settle();
  ok(pl.state.matrix.hosts.host_hollow_pine && pl.state.matrix.hosts.host_hollow_pine.rating === undefined, 'visible host: name only, no rating before perception');
  ok((pl.state.matrix.hosts.host_hollow_pine as Host).notes === undefined && (pl.state.matrix.hosts.host_hollow_pine as Host).spider === undefined, 'GM notes and spider stripped');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'enterHost', targetId: 'host:host_hollow_pine' }), /mark/, 'Enter Host needs a mark');

  // Hack on the Fly — success (loaded dice)
  await gm.send('matrix/testDice', { mode: 'actor' });
  res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine', marks: 3 });
  ok(res.success && res.roll.pool === 14 - 6 && res.defense.hits === 0, `HotF 3 marks (Go Big or Go Home): pool 14 − 6 = 8 (got ${res.roll.pool})`);
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
  {
    // The GM picks what the hits reveal (matrix/reveal); nothing is revealed before.
    const rv = Object.values(M().reveals || {}).find((r) => r.actorId === 'pc_bricks' && r.actionId === 'matrixPerception');
    const ids = (rv?.options || []).map((o) => o.id);
    ok(res.success && !ph.perceived && ph.files.length === 0 && rv && rv.hits === res.roll.hits, `perception waits for the GM (${rv?.hits} hits)`);
    ok(ids.includes('host-stats:host_hollow_pine') && ids.filter((id) => id.startsWith('file:')).length === 3 && ids.some((id) => id.startsWith('ic:')), `options: stats, IC, 3 files (${ids.join(', ')})`);
    const mine = pl.state.matrix.reveals?.[rv!.id];
    ok(mine && mine.options.length === 0, 'the player sees the pending reveal, not what it could reveal');
    await expectFail(pl.send('matrix/reveal', { revealId: rv!.id, optionIds: ids }), /GM/, 'only the GM reveals');
    await gm.send('matrix/reveal', { revealId: rv!.id, optionIds: ['host-stats:host_hollow_pine', 'file:host_hollow_pine:file_hp_registry'], answer: 'Une odeur de pin.' });
    await settle();
    ph = pl.state.matrix.hosts.host_hollow_pine as PlayerHostView;
    ok(ph.perceived && ph.rating === 5 && ph.files.length === 1 && ph.ic[0].rating === undefined, 'GM picks: rating + one file, IC rating still hidden');
    ok(!M().reveals?.[rv!.id], 'answered reveal removed');
    const le = [...pl.state.log].reverse().find((e) => e.matrix?.event === 'reveal');
    ok(le && /Bricks learns: Rating and attributes, file “Registre/.test(le.text) || /Bricks learns/.test(le?.text || ''), `reveal logged for the player (${le?.text})`);
    ok(!pj.state.log.some((e) => e.matrix?.event === 'reveal'), 'other players do not see what was revealed');
    await gm.send('matrix/reveal', { revealId: rv!.id, optionIds: [] }).then(() => ok(false, 'second answer should fail'), () => ok(true, 'a reveal is answered once'));
    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'host:host_hollow_pine' });
    await settle();
    const rv2 = Object.values(M().reveals || {}).find((r) => r.actorId === 'pc_bricks' && r.id !== rv!.id)!;
    ok(!rv2.options.some((o) => o.id === 'host-stats:host_hollow_pine' || o.id === 'file:host_hollow_pine:file_hp_registry'), 'known things are not offered again');
    await gm.send('matrix/reveal', { revealId: rv2.id, optionIds: rv2.options.map((o) => o.id) });
    await settle();
    ph = pl.state.matrix.hosts.host_hollow_pine as PlayerHostView;
  }
  ok(ph.perceived && ph.rating === 5 && ph.files.length === 3 && ph.ic[0].rating === 5, 'revealed: rating, IC ratings and files');
  ok(ph.files.every((f) => (f as Partial<HostFile>).content === undefined), 'file contents never listed');
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'editFile', targetId: 'file:host_hollow_pine:file_hp_relay' }), /Protected file/, 'protected file must be cracked first');
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
  await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: 'host:host_hollow_pine', assistFromAgent: true }), /another skill/, 'assist is skill-specific');
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
  ok(gm.state.log.some((e) => e.kind === 'matrix' && /Bricks’s agent/.test(e.author)), 'agent action logged under the agent name');

  // IC attacks
  await gm.send('matrix/icLaunch', { hostId: 'host_hollow_pine', type: 'black' });
  await settle();
  const black = M().hosts.host_hollow_pine.ic.find((i) => i.type === 'black')!;
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { rating: 1 } }); // small hit: the deck survives
  const physBefore = gm.state.actors.pc_bricks.condition.physical;
  res = await gm.send('matrix/icAct', { hostId: 'host_hollow_pine', icId: black.id, actorId: 'pc_bricks' });
  await settle();
  ok(res.success && P().matrixDamage > 0 && gm.state.actors.pc_bricks.condition.physical > physBefore, 'Black IC: matrix damage + physical biofeedback in hot sim');
  ok(P().linkLocked && /Black/.test(P().linkLocked!.name), 'Black IC link-locks');
  await expectFail(pl.send('matrix/disconnect', { actorId: 'pc_bricks' }), /Link-lock/, 'link-locked: no graceful disconnect');
  await expectFail(pl.send('matrix/icAct', { hostId: 'host_hollow_pine', icId: black.id, actorId: 'pc_bricks' }), /GM-only/, 'players cannot run IC');
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
  await expectFail(pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' }), /bricked/, 'bricked deck cannot connect');
  await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { matrixDamage: 0 } });
  await settle();
  ok(!P().bricked, 'GM repair unbricks');

  // Dumpshock on forced disconnect
  await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' });
  const stunBefore = gm.state.actors.pc_bricks.condition.stun;
  res = await gm.send('matrix/disconnect', { actorId: 'pc_bricks', dump: true });
  await settle();
  ok(res.outcomes.some((s: string) => /Dumpshock/.test(s)) && gm.state.actors.pc_bricks.condition.stun > stunBefore, 'GM dump in cold sim → stun dumpshock');

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
  await expectFail(pl.send('matrix/hostCreate', { name: 'x', rating: 3 }), /GM-only/, 'players cannot create hosts');
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
  ok(res.results.some((r: { skipped?: string }) => r.skipped && /keeps watch/.test(r.skipped)), 'patrol skips when everyone is already spotted');
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
  await expectFail(pl.send('matrix/icTurn', { hostId: firstIc.hostId, icId: firstIc.icId }), /GM-only/, 'players cannot run IC turns');
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
  await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { devices: devs, perceivedBy: ['pc_bricks'] } }); // GM « knows the host »: every device
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
  await expectFail(pj.send('matrix/shareFile', { actorId: 'pc_bricks', fileId }), /not yours/, 'only the owner shares');
  res = await gm.send('matrix/shareFile', { actorId: 'pc_bricks', fileId });
  await settle();
  ok(res.handoutId && pl.state.campaign.handouts.some((h) => h.id === res.handoutId), 'GM share → handout revealed to the players');

  // ---------------------------------------------------------------- NPC PAN: Matrix Perception reveals its devices, which can be hacked
  {
    await gm.send('matrix/setPersona', { actorId: 'pc_bricks', patch: { bricked: false, matrixDamage: 0, linkLocked: null } });
    await pl.send('matrix/connect', { actorId: 'pc_bricks', mode: 'cold' });
    const npcId: string = await gm.send('actor/create', { type: 'npc', name: 'Garde Lazarus', attributes: { WIL: 3, INT: 3, LOG: 2 } });
    await gm.send('actor/addItem', { actorId: npcId, list: 'gear', item: { name: 'Meta Link', category: 'Commlinks', rating: 1, qty: 1 } });
    await gm.send('actor/addItem', { actorId: npcId, list: 'augmentations', item: { name: 'Cybereyes', kind: 'cyberware', grade: 'alpha', rating: 2, essence: 0.2 } });
    await gm.send('actor/addItem', { actorId: npcId, list: 'augmentations', item: { name: 'Muscle Toner', kind: 'bioware', grade: 'standard', rating: 1, essence: 0.2 } });
    await gm.send('actor/addItem', { actorId: npcId, list: 'augmentations', item: { name: 'Wired Reflexes', kind: 'cyberware', grade: 'standard', rating: 1, essence: 2, wirelessOff: true } });
    await gm.send('actor/addItem', { actorId: npcId, list: 'weapons', item: { name: 'Ares Predator V', kind: 'ranged', skill: 'pistols', accuracy: 5, damage: '8P', ap: -1, mode: 'SA', ammo: '15(c)' } });
    await settle();
    const npc = gm.state.actors[npcId] as any;
    const eyes = npc.augmentations.find((a: any) => a.name === 'Cybereyes');
    const gun = npc.weapons.find((w: any) => w.name === 'Ares Predator V');
    const devs = panDevices(npc);
    ok(devs.map((d) => `${d.kind}:${d.name}:${d.deviceRating}`).join('|') === 'cyberware:Cybereyes:3|weapon:Ares Predator V:2', `PAN: alpha cyberware DR 3 + pistol DR 2, no bioware, no wireless-off implant (${devs.map((d) => d.name).join(', ')})`);
    const master = panMaster(npc);
    ok(master?.name === 'Meta Link' && master.deviceRating === 1 && master.firewall === 1, 'PAN master: the commlink from the gear');
    ok(panDefensePool(npc, master, devs[0], ['WIL', 'firewall'])!.pool === 3 + 3, 'slaved device defense: max(WIL 3, DR 3) + max(FW 3, master FW 1)');
    ok(panDefensePool(npc, { name: 'x', deviceRating: 5, dataProcessing: 5, firewall: 5 }, devs[1], ['WIL', 'firewall'])!.pool === 3 + 5, 'slaved device uses the master’s Firewall when higher (SR5 p. 233)');

    const gunKey = `pan:${npcId}:${gun.id}`;
    await expectFail(pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: gunKey }), /Spot this device/, 'PAN device out of reach before Matrix Perception');
    await gm.send('matrix/testDice', { mode: 'actor' });
    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: `persona:${npcId}` });
    await settle();
    const prv = Object.values(M().reveals || {}).find((r) => r.target === 'Garde Lazarus')!;
    ok(prv?.options.map((o) => o.id).join('|') === `pan-master:${npcId}|pan:${npcId}:${eyes.id}|pan:${npcId}:${gun.id}`, `PAN options: commlink, then the devices in sheet order (${prv?.options.map((o) => o.id).join(', ')})`);
    ok(!pl.state.matrix.personas.pc_bricks.scans?.[npcId], 'nothing spotted before the GM answers');
    await gm.send('matrix/reveal', { revealId: prv.id, optionIds: prv.options.map((o) => o.id) });
    await settle();
    const scan = pl.state.matrix.personas.pc_bricks.scans?.[npcId];
    ok(res.success && scan?.devices.map((d) => d.id).join('|') === `${eyes.id}|${gun.id}` && scan.master?.name === 'Meta Link', `GM reveals the PAN: devices + commlink (${JSON.stringify(scan?.devices.map((d) => d.name))})`);
    ok(gm.state.log.some((e) => e.kind === 'matrix' && /Bricks learns: Commlink: Meta Link, Cybereyes, Ares Predator V/.test(e.text || '')), 'log lists what was revealed');
    ok(pl.state.matrix.pans === undefined, 'players never get the PAN states table');

    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'hackOnTheFly', targetId: `pan:${npcId}:${eyes.id}`, marks: 1 });
    await settle();
    const gmEntry = [...gm.state.log].reverse().find((e) => e.kind === 'matrix' && e.matrix?.gm);
    ok(res.success && gmEntry?.matrix?.gm?.defensePool === 6, `Hack on the Fly vs cybereyes: defense WIL 3 + FW 3 (got ${gmEntry?.matrix?.gm?.defensePool})`);
    ok(P().marks.find((m) => m.targetId === `pan:${npcId}:${eyes.id}`)?.count === 1 && P().marks.find((m) => m.targetId === `persona:${npcId}`)?.count === 1, 'a mark on the slave also marks the master (SR5 p. 233)');

    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'dataSpike', targetId: gunKey });
    await settle();
    ok(res.success && M().pans?.[npcId]?.[gun.id]?.bricked, `Data Spike bricks the pistol (damage ${M().pans?.[npcId]?.[gun.id]?.damage})`);
    const seen = pl.state.matrix.personas.pc_bricks.scans?.[npcId]?.devices.find((d) => d.id === gun.id);
    ok(seen?.state?.bricked === true && seen.state.monitor === 9, 'the decker sees the bricked state of the device');
    await expectFail(pl.send('matrix/panReset', { actorId: npcId, deviceId: gun.id }), /GM/, 'only the GM repairs a PAN device');
    await gm.send('matrix/panReset', { actorId: npcId, deviceId: gun.id });
    await settle();
    ok(!M().pans?.[npcId]?.[gun.id], 'GM repair clears the device state');
    await pl.send('matrix/forgetScan', { actorId: 'pc_bricks', targetId: npcId });
    await settle();
    ok(!pl.state.matrix.personas.pc_bricks.scans?.[npcId], 'forget a scan');

    // Bestiary NPCs keep their commlink as generic gear (« Équipement » / « Commlink (indice 4) »).
    const bestiaryLike = { gear: [{ name: 'Commlink (indice 4)', category: 'Équipement', rating: 4 }, { name: 'Dongle', category: 'Commlink Accessories', rating: 6 }] };
    ok(panMaster(bestiaryLike as any)?.deviceRating === 4 && panMaster(bestiaryLike as any)?.name === 'Commlink (indice 4)', 'commlink found by its name in generic gear, accessories ignored');
    ok(isMatrixDevice({ name: 'Cyberdeck Hermes Chariot', category: 'Équipement' }) && !isMatrixDevice({ name: 'Lunettes', category: 'Équipement' }), 'isMatrixDevice by name');

    // Matrix Perception with no target during a fight: the PANs of the NPCs in it are offered.
    await gm.send('actor/addItem', { actorId: npcId, list: 'gear', item: { name: 'Commlink (indice 4)', category: 'Équipement', rating: 4, qty: 1 } });
    await gm.send('combat/start', { includeMapTokens: false });
    await gm.send('combat/add', { actorIds: ['pc_bricks', npcId] });
    await settle();
    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'none' });
    await settle();
    const vic = Object.values(M().reveals || {}).find((r) => r.actionId === 'matrixPerception' && r.target === '')!;
    const vicIds = (vic?.options || []).map((o) => o.id);
    ok(res.success && vicIds.includes(`pan-master:${npcId}`) && vicIds.includes(`pan:${npcId}:${eyes.id}`) && vicIds.includes(`pan:${npcId}:${gun.id}`), `no target in a fight: the NPC's PAN is offered (${vicIds.join(', ')})`);
    await gm.send('matrix/reveal', { revealId: vic.id, optionIds: [`pan-master:${npcId}`, `pan:${npcId}:${eyes.id}`] });
    await settle();
    const vs = pl.state.matrix.personas.pc_bricks.scans?.[npcId];
    ok(vs?.master?.deviceRating === 4 && vs.devices.length === 1, `revealed from the vicinity: commlink DR ${vs?.master?.deviceRating} + 1 device`);
    ok(!vicIds.some((id) => id.startsWith('host-visible:')), 'perception never reveals hidden hosts (that is a Matrix Search)');
    await gm.send('combat/end', {});
    await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { visible: false } });
    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixPerception', targetId: 'none' });
    await settle();
    const quiet = Object.values(M().reveals || {}).find((r) => r.actionId === 'matrixPerception' && r.target === '' && r.id !== vic.id)!;
    ok(quiet && quiet.options.length === 0, `no target outside a fight: nothing for the app to reveal, the GM answers (${quiet?.options.map((o) => o.id).join(', ')})`);
    await gm.send('matrix/dropReveal', { revealId: quiet.id });
    await gm.send('matrix/hostUpdate', { hostId: 'host_hollow_pine', patch: { visible: true } });

    // Matrix Search (SR5 p. 241): threshold from the table, extra hits divide the base time, failure = full base time
    ok(searchMinutes('limited', 3) === 30 && searchMinutes('limited', 5) === 15 && searchMinutes('hidden', 2) === 720 && searchMinutes('public', 4) === 1 / 3, 'search time: base ÷ hits above the threshold');
    ok(searchMinutes('hidden', 8, true) === 0.5, 'search inside a host: base time 1 minute');
    const inHost = !!P().hostId;
    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixSearch', searchLevel: 'limited', topic: 'Adresse de M. Johnson' });
    await settle();
    const srv = Object.values(M().reveals || {}).find((r) => r.actionId === 'matrixSearch')!;
    const hits = res.roll.hits;
    ok(res.success && hits >= 3 && srv?.threshold === 3 && srv.topic === 'Adresse de M. Johnson' && srv.minutes === searchMinutes('limited', hits, inHost), `search succeeds against threshold 3 (${hits} hits, ${srv?.minutes} min)`);
    ok(gm.state.log.some((e) => /Search for “Adresse de M. Johnson”: found in .* \(threshold 3\)\. The GM answers\./.test(e.text || '')), 'search log: found, time, threshold');
    ok(inHost ? srv.options.length > 0 && srv.options.every((o) => o.id.startsWith('answer-file:')) : srv.options.every((o) => o.id.startsWith('host-visible:')), `search options: ${inHost ? 'the file holding the answer' : 'hidden hosts'} (${srv.options.map((o) => o.id).join(', ')})`);
    await gm.send('matrix/reveal', { revealId: srv.id, optionIds: [], answer: 'Il vit à Tacoma.' });
    await settle();
    ok(pl.state.log.some((e) => /GM’s answer to Bricks: Il vit à Tacoma\./.test(e.text || '')), 'GM answers the search freely');
    await gm.send('matrix/testDice', { mode: 'glitch' });
    res = await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'matrixSearch', searchLevel: 'hidden' });
    await settle();
    ok(!res.success && !Object.values(M().reveals || {}).some((r) => r.actionId === 'matrixSearch'), 'failed search: nothing for the GM to answer');
    ok(gm.state.log.some((e) => /Search: nothing found after (12 h|1 min) \(threshold 6\)\./.test(e.text || '')), 'failed search costs the full base time');
    await gm.send('matrix/testDice', { mode: null });
  }

  // i18n: every matrix log entry of this run is translatable (keys, nested params, authors, roll labels)
  {
    const entries = (gm.state.log || []).filter((e) => e.kind === 'matrix');
    const keys: string[] = [];
    for (const e of entries) {
      ok(!!e.i18n?.key || !e.text, `matrix log entry has an i18n key: ${e.text}`);
      keys.push(...msgKeys(e.i18n), ...msgKeys(e.authorI18n), ...msgKeys(e.roll?.labelI18n));
    }
    const miss = [...new Set(missingFr(keys))];
    ok(entries.length > 10 && miss.length === 0, `matrix log keys translated (${entries.length} entries, missing: ${miss.join(' | ')})`);
    const sample = entries.map((e) => frT(e.i18n!.key, e.i18n!.params)).filter((s) => /⟦/.test(s));
    ok(sample.length === 0, `French rendering complete (${sample.slice(0, 3).join(' / ')})`);
    const textDiff = entries.filter((e) => e.text !== enT(e.i18n!.key, e.i18n!.params)).map((e) => `${e.text} ≠ ${enT(e.i18n!.key, e.i18n!.params)}`);
    ok(textDiff.length === 0, `stored text = English rendering (${textDiff.slice(0, 3).join(' / ')})`);
    try {
      await pl.send('matrix/action', { actorId: 'pc_bricks', actionId: 'nope' });
      ok(false, 'unknown action should fail');
    } catch (e) {
      const ke = e as Error & { key?: string }; // an optional i18n key on the error (the harness sets none: message fallback)
      ok(ke.key ? !!FR[cur(ke.key)] : /Unknown Matrix action/.test(ke.message), `error reply carries a translated key (${ke.key || ke.message})`);
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
console.log(`matrix: ${passes} ok, ${failures} failed`);
process.exit(failures ? 1 : 0);
