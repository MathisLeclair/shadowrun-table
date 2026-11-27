// Matrix module: deckers' personas (connection mode, ASDF configuration, programs, marks, Overwatch Score,
// matrix damage), their agents (teamwork assist or autonomous action), hosts and IC run by the GM.
// State slice: state.matrix (see ARCHITECTURE.md « Matrix »). Rules data: shared/matrix.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attr, derive, rollDice } from '../../shared/sr5.ts';
import {
  ACTION_BY_ID, ASDF, ASDF_LABELS, MODE_LABELS, MODES, IC_TYPES, MAX_MARKS, OS_MAX, CONVERGENCE_DV, HOST_PRESETS,
  PROGRAM_BY_ID, isIllegal, isCyberdeck, isPermutation, identityAsdf, deckStats, actionPool, hostDefensePool,
  personaDefensePool, programId, programSlots, programSum, availablePrograms, detectAgents, matrixMonitor,
  matrixInitiative, dumpshock, hostAttributes, defaultIcFor, icAttackPool, skillRating, loadedProgramIds,
  OS_TICK_MS, DEVICE_LINK_KINDS, DEVICE_CMD_LABELS, deviceWorks, type MatrixActionDef, type MatrixTargetKind,
} from '../../shared/matrix.ts';
import { uid, deepClone, slug } from '../../shared/util.ts';
import { cleanConditions } from '../../shared/modifiers.ts';
import { actorModifiers, deriveFull } from '../lib/modifiers.ts';
import { formatSource } from '../lib/i18n.ts';
import combatModule, { combatHooks, upsertVirtualEntry, setVirtualOut, endTurnOf, isVirtual } from './30-combat.ts';
import { refreshFog, findAnyDoor } from './20-maps.ts';
import notesModule from './75-notes.ts';
import campaignModule from './70-campaign.ts';
import type {
  ActionContext, ActionDef, Actor, ActorId, AsdfKey, EmitTarget, GameView, Host, HostDevice, HostFile, HostIc, I18nMessage, I18nParams, IcType,
  MatrixMark, MatrixMarkOnMe, MatrixMode, MatrixState, NewLogEntry, Persona, PersonaFile, PlayerHostView, ServerModule, SessionUser, SfxId, TableState, UserId,
} from '../../shared/types.ts';

/** Dynamic data read field by field (rules data of shared/matrix.js, GM patches, map objects). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
/** A message or a plain string (names stored as text). */
type MsgLike = string | I18nMessage;
/** A resolved action target (resolveTarget). */
interface Target {
  kind: string;
  key?: string | null;
  name?: string;
  nameMsg?: MsgLike;
  host?: Host | null;
  ic?: HostIc;
  device?: HostDevice;
  file?: HostFile;
  actor?: Actor | null;
  persona?: Persona | null;
  mark?: MatrixMarkOnMe;
}
/** A defense pool (null = no opposition, pending = the GM rolls). */
type Defense = { pending?: false; pool: number; parts: Array<{ label: string; value: number; key?: string; params?: I18nParams }>; labelMsg: MsgLike } | { pending: true } | null;
/** An action handler of this module (payload typed per action). */
type Handler<P> = (ctx: ActionContext, p: P) => unknown;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const clampInt = (v: unknown, lo: number, hi: number, d = lo): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const str = (v: unknown, max = 200): string => (v === undefined || v === null ? '' : String(v).slice(0, max));
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// i18n: every sentence shown to the table is a message { t: 'French key {x}', params } (see ARCHITECTURE.md « i18n »).
// Returned results keep `outcomes` (French strings) and add `msgs` (messages); log entries carry `i18n` + French `text`.
// ---------------------------------------------------------------------------
const tk = (s: string): string => s;
/** French text of a message (or a plain string). */
const fr = (m: MsgLike | null | undefined): string => (typeof m === 'string' ? m : m ? formatSource(m.t, m.params) : '');
/** Counted noun as a nested message: `zero` is the key used for 0 (French singular, English plural). */
const count = (n: number, one: string, other: string, zero = other): I18nMessage => ({ t: n === 1 ? one : n === 0 ? zero : other, params: { n } });
const boxesM = (n: number) => count(n, tk('{n} box'), tk('{n} boxes'), tk('zero::{n} boxes'));
const hitsM = (n: number) => count(n, tk('{n} hit'), tk('n::{n} hits'));
const netM = (n: number) => count(n, tk('{n} net hit'), tk('{n} net hits'), tk('zero::{n} net hits'));
/** Several messages as one (a log entry has a single i18n key): '{a} {b}' chain. */
function joinMsgs(list: MsgLike[]): I18nMessage | null {
  if (!list.length) return null;
  if (list.length === 1) return typeof list[0] === 'string' ? { t: '{a}', params: { a: list[0] } } : list[0];
  return { t: '{a} {b}', params: { a: list[0], b: joinMsgs(list.slice(1)) as I18nMessage } };
}
/** Message → log-style { key, params }. */
const toI18n = (m: MsgLike | null | undefined) => (m && typeof m === 'object' ? { key: m.t, ...(m.params ? { params: m.params } : {}) } : null);
/** « IC Tueuse (Hôte) » as a message. */
const icNameMsg = (type: IcType, hostName: string | undefined): I18nMessage => ({ t: '{ic} ({host})', params: { ic: { t: (IC_TYPES as Loose)[type]?.fr || 'IC' }, host: hostName || '' } });
/** Name of the IC holding a link-lock (older saves only have the French name). */
const linkLockMsg = (ll: Persona['linkLocked'] | undefined): MsgLike => (ll?.icType ? icNameMsg(ll.icType, ll.hostName) : ll?.name || '');
/** Display name of a mark entry (nameI18n when the name was generated, else the stored name). */
const markNameMsg = (m: MatrixMark | MatrixMarkOnMe | undefined): MsgLike => m?.nameI18n || m?.name || '';
const agentAuthorMsg = (ag: { name: string }, actor: { name: string }): I18nMessage => ({ t: '{agent} ({name}’s agent)', params: { agent: ag.name, name: actor.name } });

// ---------------------------------------------------------------------------
// Catalog: program slots of known cyberdecks (data/catalog/gear.json → stats.programs)
// ---------------------------------------------------------------------------
let deckCatalog: Map<string, number> | null = null;
function deckCatalogSlots(deviceName: unknown): number | null {
  if (!deckCatalog) {
    deckCatalog = new Map();
    try {
      const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'gear.json'), 'utf8'));
      for (const it of list) {
        if (!it?.stats || !Number(it.stats.programs)) continue;
        for (const n of [it.name, it.nameFr]) if (n) deckCatalog.set(String(n).toLowerCase(), Number(it.stats.programs));
      }
    } catch (err) {
      console.error('[matrix] gear catalog unreadable:', (err as Error).message);
    }
  }
  return deckCatalog.get(String(deviceName || '').toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// Dice (test hook: SR_MATRIX_TEST=1 enables 'matrix/testDice' to load the dice)
// ---------------------------------------------------------------------------
let testDice: string | null = null; // null | 'actor' (decker side wins) | 'opposition' | 'glitch' (decker side all 1s)
const face = (f: number) => () => (f - 0.5) / 6;
/** side: 'actor' = the decker / her agent; 'opposition' = hosts, IC, GOD, other personas. */
function roll(pool: number, opts: Loose = {}, side = 'actor') {
  let rng: (() => number) | undefined;
  if (testDice) {
    const actorFace = testDice === 'actor' ? 5 : testDice === 'glitch' ? 1 : 2;
    const oppFace = testDice === 'opposition' ? 5 : 2;
    rng = face(side === 'actor' ? actorFace : oppFace);
  }
  return rollDice(pool, { ...opts, rng });
}
const sumParts = (parts: Array<{ label: string; value: number }>) => parts.map((p) => `${p.label} ${p.value >= 0 ? '+' : '−'}${Math.abs(p.value)}`).join(' · ');

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
function slice(state: TableState): MatrixState & { personas: Record<ActorId, Persona> } {
  state.matrix ||= {} as MatrixState;
  const m = state.matrix;
  if (!isObj(m.personas)) m.personas = {};
  if (!isObj(m.hosts)) m.hosts = {};
  if (!isObj(m.settings)) m.settings = {} as MatrixState['settings'];
  m.settings.hideOverwatch = !!m.settings.hideOverwatch;
  // osTimer: +2D6 OS every 15 real minutes online (SR5 p. 232), applied at the next Matrix action. autoLaunchIc: during a
  // fight, an alerted host with an intruder launches its next IC at each new Combat Turn (SR5 p. 248).
  m.settings.osTimer = !!m.settings.osTimer;
  m.settings.autoLaunchIc = m.settings.autoLaunchIc !== false;
  return m as MatrixState & { personas: Record<ActorId, Persona> };
}

function computeSlots(actor: Actor | Loose | null | undefined): number {
  return deckCatalogSlots(actor?.matrix?.device) || 4;
}

function blankPersona(actor: Actor | Loose): Persona {
  return {
    actorId: actor.id, online: false, mode: 'cold', asdf: (identityAsdf() as Persona['asdf']), loadedPrograms: [],
    marks: [], marksOnMe: [], overwatch: 0, osKnown: null, matrixDamage: 0, noise: 0, hostId: null,
    penalties: {}, linkLocked: null, fullDefense: false, bricked: false, traced: false, files: [],
    programSlots: computeSlots(actor), slotsOverride: false, deviceName: actor.matrix?.device || '',
    agent: null, pendingAssist: null,
    osClock: null, // start of the current 15-minute Overwatch period (set when the OS starts being tallied)
    hostConverged: null, // hostId: convergence happened inside this host (leaving it brings the grid's demiGOD)
  };
}

/** Default agent from what the actor owns (highest rating), or null. */
function defaultAgent(actor: Actor) {
  const found = detectAgents(actor);
  if (!found.length) return null;
  const best = found.reduce((a, b) => (b.rating > a.rating ? b : a));
  return { rating: best.rating, name: `Agent ${best.rating}`, loaded: false, damage: 0, source: best.source };
}

/** Normalize a stored persona (tolerates old/partial data). */
function normalizePersona(p: Persona, actor: Actor | null | undefined): Persona {
  const b = blankPersona(actor || { id: p.actorId, matrix: {} });
  const lp = p as unknown as Loose;
  for (const k of Object.keys(b)) if (lp[k] === undefined) lp[k] = (b as unknown as Loose)[k];
  if (!MODES.includes(p.mode)) p.mode = 'cold';
  if (!isPermutation(p.asdf)) p.asdf = (identityAsdf() as Persona['asdf']);
  for (const k of ['loadedPrograms', 'marks', 'marksOnMe', 'files']) if (!Array.isArray(lp[k])) lp[k] = [];
  if (!isObj(p.penalties)) p.penalties = {};
  p.overwatch = clampInt(p.overwatch, 0, OS_MAX, 0);
  p.matrixDamage = clampInt(p.matrixDamage, 0, 99, 0);
  p.noise = clampInt(p.noise, 0, 30, 0);
  p.programSlots = clampInt(p.programSlots, 1, 20, 4);
  return p;
}

function getActor(ctx: ActionContext, actorId: unknown): Actor {
  const a = ctx.state.actors?.[actorId as ActorId];
  if (!a) return ctx.fail('Character not found');
  return a;
}

/** Persona of an actor (created on first use). Keeps it in sync with the sheet (device, programs). */
function ensurePersona(state: TableState, actor: Actor): Persona {
  const m = slice(state);
  let p = m.personas[actor.id];
  if (!p) p = m.personas[actor.id] = blankPersona(actor);
  normalizePersona(p, actor);
  if (actor.matrix && p.deviceName !== (actor.matrix.device || '')) {
    p.deviceName = actor.matrix.device || '';
    if (!p.slotsOverride) p.programSlots = computeSlots(actor);
  }
  if (actor.matrix) {
    // Programs removed from the sheet are unloaded.
    const avail = new Set(availablePrograms(actor).map((x: Loose) => x.name.toLowerCase()));
    p.loadedPrograms = p.loadedPrograms.filter((n) => avail.has(String(n).toLowerCase()) && programId(n) !== 'agent');
    if (!isCyberdeck(actor)) p.asdf = (identityAsdf() as Persona['asdf']);
  }
  if (p.agent === null && actor.matrix) p.agent = defaultAgent(actor);
  return p;
}

/** Owner (or GM) + actor with a device. */
function ownPersona(ctx: ActionContext, actorId: unknown) {
  const actor = getActor(ctx, actorId);
  if (!ctx.owns(actorId as ActorId)) ctx.fail('This character is not yours');
  if (!actor.matrix) ctx.fail('{name} has no Matrix device (commlink or cyberdeck)', { name: actor.name });
  return { actor, persona: ensurePersona(ctx.state, actor) };
}

function requireOnline(ctx: ActionContext, actor: Actor, persona: Persona): void {
  if (persona.bricked) ctx.fail('{name}’s deck is bricked: it must be repaired', { name: actor.name });
  if (!persona.online) ctx.fail('{name} is not connected to the Matrix', { name: actor.name });
}

function getHost(ctx: ActionContext, hostId: unknown): Host {
  const h = slice(ctx.state).hosts[hostId as string];
  if (!h) return ctx.fail('Host not found');
  return h;
}

function sfx(ctx: ActionContext, id: SfxId, target: EmitTarget = 'all'): void {
  ctx.emitTo(target, 'sfx', { id });
}

/** User ids controlling an actor (for transient events). */
function ownersOf(state: TableState, actorId: ActorId): UserId[] {
  return Object.values(state.users || {}).filter((u) => (u.characterIds || []).includes(actorId)).map((u) => u.id);
}

/** Matrix log entry. msgs = messages (French `text` + translatable `i18n` are built from them). */
function mlog(ctx: ActionContext, { msgs, ...entry }: Loose & { msgs?: MsgLike[] }) {
  const e: Loose = { kind: 'matrix', userId: ctx.user.id, ...entry };
  if (msgs) {
    e.text = msgs.map(fr).join(' ');
    const i = toI18n(joinMsgs(msgs));
    if (i) e.i18n = i;
  }
  return ctx.log(e as NewLogEntry);
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
function marksOnKey(persona: Persona, key: string): number {
  return persona.marks.find((m) => m.targetId === key)?.count || 0;
}
/** Marks the persona has on a target. Marks on a host also count on its IC, devices and files. */
function effectiveMarks(persona: Persona, target: Target | null | undefined): number {
  if (!target || !target.key) return 0;
  let n = marksOnKey(persona, target.key);
  if (target.host && target.kind !== 'host') n = Math.max(n, marksOnKey(persona, `host:${target.host.id}`));
  return n;
}
/** msg (optional): the name as a message when it is generated text (« fichier « X » »), stored as nameI18n. */
function setMarkName(e: MatrixMark | MatrixMarkOnMe, name: string, msg?: MsgLike): void {
  e.name = name || e.name;
  if (msg && typeof msg === 'object') e.nameI18n = msg;
  else if (name) delete e.nameI18n;
}
function addMark(persona: Persona, key: string, name: string, n: number, msg?: MsgLike): number {
  let e = persona.marks.find((m) => m.targetId === key);
  if (!e) persona.marks.push((e = { targetId: key, name, count: 0 }));
  setMarkName(e, name, msg);
  e.count = Math.min(MAX_MARKS, e.count + n);
  return e.count;
}
function addMarkOnMe(persona: Persona, sourceId: string, name: string, n = 1, msg?: MsgLike): number {
  let e = persona.marksOnMe.find((m) => m.sourceId === sourceId);
  if (!e) persona.marksOnMe.push((e = { sourceId, name, count: 0 }));
  setMarkName(e, name, msg);
  e.count = Math.min(MAX_MARKS, e.count + n);
  return e.count;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------
/** Physical/stun damage on an actor (same overflow rules as the characters module). */
function applyActorDamage(actor: Actor, n: number, type: string): void {
  if (!n) return;
  actor.condition ||= { physical: 0, stun: 0, overflow: 0 };
  const d = deriveFull(actor); // monitors with the modifiers of gear / qualities / implants
  const c = actor.condition;
  let toPhysical = 0;
  if (type === 'S') {
    c.stun = (c.stun || 0) + n;
    if (c.stun > d.stunMonitor) {
      toPhysical = c.stun - d.stunMonitor;
      c.stun = d.stunMonitor;
    }
  } else toPhysical = n;
  if (toPhysical) {
    c.physical = (c.physical || 0) + toPhysical;
    if (c.physical > d.physicalMonitor) {
      c.overflow = (c.overflow || 0) + c.physical - d.physicalMonitor;
      c.physical = d.physicalMonitor;
    }
  }
  c.overflow = Math.min(c.overflow || 0, d.overflowMax + 1);
}

/** Dumpshock after being dumped from VR: 6 DV (P hot / S cold), resisted with WIL + Firewall. Returns a message or null. */
function applyDumpshock(ctx: ActionContext, actor: Actor, persona: Persona, mode: MatrixMode): I18nMessage | null {
  const ds = dumpshock(mode);
  if (!ds) return null;
  const fw = deckStats(actor, persona).eff.firewall;
  const res = roll(attr(actor, 'WIL') + fw, {}, 'actor');
  const boxes = Math.max(0, ds.dv - res.hits);
  applyActorDamage(actor, boxes, ds.type);
  const params = { boxes: boxesM(boxes), dv: ds.dv, hits: hitsM(res.hits) };
  if (!boxes) return { t: 'Dumpshock fully resisted ({hits} vs DV {dv}).', params };
  return ds.type === 'P'
    ? { t: 'Dumpshock: {boxes} of Physical damage (DV {dv}, {hits} on the resistance test).', params }
    : { t: 'Dumpshock: {boxes} of Stun damage (DV {dv}, {hits} on the resistance test).', params };
}

/** Leave the Matrix. dumped = forced (dumpshock in VR). Returns messages. */
function goOffline(ctx: ActionContext, actor: Actor, persona: Persona, { dumped }: { dumped: boolean }): I18nMessage[] {
  const out: I18nMessage[] = [];
  const mode = persona.mode;
  persona.online = false;
  persona.hostId = null;
  persona.fullDefense = false;
  persona.linkLocked = null;
  persona.pendingAssist = null;
  persona.hostConverged = null;
  if (dumped) {
    const s = applyDumpshock(ctx, actor, persona, mode);
    if (s) out.push(s);
  }
  return out;
}

/** Reboot the decker's deck: OS 0, marks wiped, IC penalties cleared, persona dumped. */
function rebootDeck(ctx: ActionContext, actor: Actor, persona: Persona): I18nMessage[] {
  const wasOnline = persona.online;
  persona.overwatch = 0;
  persona.osClock = null;
  persona.osKnown = null;
  persona.marks = [];
  persona.marksOnMe = [];
  persona.penalties = {};
  return goOffline(ctx, actor, persona, { dumped: wasOnline });
}

/** Matrix damage on the decker's deck (Virtual Machine adds 1 box per hit). Bricks the deck when full. */
function damageDeck(ctx: ActionContext, actor: Actor, persona: Persona, boxes: number): I18nMessage[] {
  const out: I18nMessage[] = [];
  if (boxes <= 0) return out;
  const extra = loadedProgramIds(persona).has('virtualMachine') ? 1 : 0;
  const n = boxes + extra;
  const mon = matrixMonitor(actor.matrix?.rating);
  persona.matrixDamage = Math.min(mon, persona.matrixDamage + n);
  out.push({ t: '{name}’s deck takes {boxes} of Matrix damage ({dmg}/{mon}).', params: { name: actor.name, boxes: boxesM(n), dmg: persona.matrixDamage, mon } });
  if (persona.matrixDamage >= mon && !persona.bricked) {
    persona.bricked = true;
    out.push({ t: 'Deck bricked! {name} is booted out of the Matrix.', params: { name: actor.name } });
    out.push(...goOffline(ctx, actor, persona, { dumped: true }));
    sfx(ctx, 'matrix-glitch');
  }
  return out;
}

/** Matrix damage on the agent (its own monitor 8 + ceil(Rating/2)); crashes it when full. */
function damageAgent(actor: Actor, persona: Persona, boxes: number): I18nMessage[] {
  const ag = persona.agent;
  if (!ag || boxes <= 0) return [];
  const mon = matrixMonitor(ag.rating);
  ag.damage = Math.min(mon, (ag.damage || 0) + boxes);
  const out: I18nMessage[] = [{ t: '{agent} takes {boxes} of Matrix damage ({dmg}/{mon}).', params: { agent: ag.name, boxes: boxesM(boxes), dmg: ag.damage, mon } }];
  if (ag.damage >= mon) {
    ag.loaded = false;
    out.push({ t: '{agent} crashes and unloads from the deck.', params: { agent: ag.name } });
  }
  return out;
}

/**
 * Convergence (SR5 p. 232 and p. 247). On the grid: 12 DV Matrix damage resisted with Device Rating + Firewall, forced
 * reboot (dumpshock in VR), marks lost, physical location revealed. Inside a host: the host puts 3 marks on the decker,
 * goes on alert and deploys IC; the decker stays online, and leaving the host brings the grid convergence at once.
 * grid = true forces the grid version (leaving the host after a host convergence).
 */
function converge(ctx: ActionContext, actor: Actor, persona: Persona, { grid = false }: { grid?: boolean } = {}): I18nMessage[] {
  const host = !grid && persona.online && persona.hostId ? slice(ctx.state).hosts[persona.hostId] : null;
  if (host) {
    const out: I18nMessage[] = [{ t: 'CONVERGENCE inside the host {host}! It places 3 marks on {name} and deploys its IC.', params: { host: host.name, name: actor.name } }];
    persona.hostConverged = host.id;
    addMarkOnMe(persona, `host:${host.id}`, host.name, MAX_MARKS);
    const s = setAlert(ctx, host, { t: 'convergence' });
    if (s) out.push(s);
    const l = launchNextIc(ctx, host);
    if (l) out.push(l);
    out.push({ t: 'Leaving the host will trigger GOD convergence at once.' });
    persona.convergedAt = Date.now();
    mlog(ctx, { author: 'GOD', msgs: out, matrix: { event: 'convergence', actorId: actor.id, hostId: host.id } });
    sfx(ctx, 'alarm');
    sfx(ctx, 'matrix-glitch');
    return out;
  }
  const out: I18nMessage[] = [{ t: 'CONVERGENCE! GOD comes down on {name}.', params: { name: actor.name } }];
  const ds = deckStats(actor, persona);
  const res = roll(ds.deviceRating + ds.eff.firewall + programSum(persona, 'resistMatrix'), {}, 'actor');
  const boxes = Math.max(0, CONVERGENCE_DV - res.hits);
  out.push({ t: 'DV {dv}: {hits} on the resistance test.', params: { dv: CONVERGENCE_DV, hits: hitsM(res.hits) } });
  if (boxes) out.push(...damageDeck(ctx, actor, persona, boxes));
  out.push({ t: 'Forced deck reboot: all marks are lost and the physical location is sent to the authorities and the grid owner.' });
  out.push(...rebootDeck(ctx, actor, persona));
  persona.traced = true;
  persona.convergedAt = Date.now();
  mlog(ctx, { author: 'GOD', msgs: out, matrix: { event: 'convergence', actorId: actor.id } });
  sfx(ctx, 'alarm');
  sfx(ctx, 'matrix-glitch');
  return out;
}

/** reason = message (why the alert went off, for the GM-only spider reminder). Returns a message or null. */
function setAlert(ctx: ActionContext, host: Host, reason: MsgLike): I18nMessage | null {
  if (host.alert === 'active') return null;
  host.alert = 'active';
  const s = { t: 'Host {host} goes on alert!', params: { host: host.name } };
  if (host.spiderAlert || host.spider) {
    const tpl = ctx.state.bestiary?.[(host.spiderAlert || host.spider) as string];
    mlog(ctx, {
      author: host.name, gmOnly: true,
      msgs: [tpl
        ? { t: 'Alert ({reason}): the spider switches to “{spider}” and the host may launch its IC.', params: { reason, spider: tpl.name } }
        : { t: 'Alert ({reason}): mind the spider on duty, and the host may launch its IC.', params: { reason } }],
    });
  }
  sfx(ctx, 'alarm');
  return s;
}

/** Personas online inside a host. */
function intrudersOf(state: TableState, host: Host): Persona[] {
  return Object.values(slice(state).personas).filter((p) => p.online && p.hostId === host.id && state.actors?.[p.actorId]?.matrix);
}

/** Launch (or relaunch) an IC of the host: logged (public when someone is inside), added to a running fight. */
function activateIc(ctx: ActionContext, host: Host, ic: HostIc): I18nMessage {
  ic.active = true;
  ic.crashed = false;
  ic.damage = 0;
  const inside = intrudersOf(ctx.state, host);
  const msg = { t: '{host} launches: {ic}.', params: { host: host.name, ic: { t: (IC_TYPES as Loose)[ic.type].fr } } };
  mlog(ctx, { author: host.name, gmOnly: !inside.length, msgs: [msg], matrix: { event: 'icLaunch', hostId: host.id, icType: ic.type } });
  if (inside.length) sfx(ctx, 'matrix-glitch', 'all');
  return msg;
}

/** SR5 p. 248: an alerted host launches one IC per Combat Turn — the next one of its suite not yet running. Message or null. */
function launchNextIc(ctx: ActionContext, host: Host): I18nMessage | null {
  const ic = (host.ic || []).find((x) => !x.active && !x.crashed && (IC_TYPES as Loose)[x.type]);
  return ic ? activateIc(ctx, host, ic) : null;
}

// ---------------------------------------------------------------------------
// Overwatch over time (SR5 p. 232): +2D6 every 15 minutes after the first tally
// ---------------------------------------------------------------------------
/** Add to the OS; the first points start the 15-minute clock. */
function addOverwatch(ctx: ActionContext, persona: Persona, n: number): void {
  if (!(n > 0)) return;
  if (!persona.overwatch || !persona.osClock) persona.osClock = ctx.now || Date.now();
  persona.overwatch = Math.min(OS_MAX, (persona.overwatch as number) + n);
}
const roll2d6 = () => 2 + Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6);

/** One or more 15-minute ticks on a persona (GM only log). Returns { added, msgs }. */
function osTick(ctx: ActionContext, actor: Actor, persona: Persona, ticks = 1) {
  let added = 0;
  for (let i = 0; i < ticks; i++) added += roll2d6();
  const before = persona.overwatch;
  addOverwatch(ctx, persona, added);
  const params = { name: actor.name, n: added, os: persona.overwatch, ticks };
  mlog(ctx, { author: 'GOD', gmOnly: true, msgs: [ticks === 1 ? { t: 'Time passes: {name}’s OS +{n} (2D6) → {os}.', params } : { t: 'Time passes ({ticks} × 15 min): {name}’s OS +{n} → {os}.', params }], matrix: { event: 'osTick', actorId: actor.id } });
  let convergence: I18nMessage[] | null = null;
  if ((before as number) < OS_MAX && (persona.overwatch as number) >= OS_MAX && persona.online && !persona.hostConverged) convergence = converge(ctx, actor, persona);
  return { added, convergence };
}

/** Automatic timer (setting osTimer): applied lazily at the start of every Matrix action. */
function tickOverwatch(ctx: ActionContext): void {
  const m = slice(ctx.state);
  if (!m.settings.osTimer) return;
  const now = ctx.now || Date.now();
  for (const p of Object.values(m.personas)) {
    if (!p.online || !((p.overwatch as number) > 0) || !p.osClock) continue;
    const ticks = Math.floor((now - p.osClock) / OS_TICK_MS);
    if (ticks <= 0) continue;
    p.osClock += ticks * OS_TICK_MS;
    const actor = ctx.state.actors?.[p.actorId];
    if (actor) osTick(ctx, actor, p, Math.min(ticks, 20));
  }
}

// ---------------------------------------------------------------------------
// Host devices ↔ map (doors, lights, camera zones)
// ---------------------------------------------------------------------------
/** The map object a device is linked to: { map, kind, door?, light?, region? } or null. */
function linkedObject(state: TableState, device: HostDevice | null | undefined): Loose | null {
  const l = device?.link;
  if (!l || !(DEVICE_LINK_KINDS as Loose)[l.kind]) return null;
  const map = state.maps?.[l.mapId];
  if (!map) return null;
  if (l.kind === 'door') {
    const found = findAnyDoor(map, l.targetId);
    return found ? { map, kind: 'door', door: found.door } : null;
  }
  if (l.kind === 'light') {
    const light = (map.lights || []).find((x) => x.id === l.targetId);
    return light ? { map, kind: 'light', light } : null;
  }
  const region = (map.regions || []).find((x) => x.id === l.targetId);
  return region ? { map, kind: 'camera', region } : null;
}

/** Current state of the linked object, for the cockpit: door state, 'on'/'off'. */
function linkState(state: TableState, device: HostDevice): string | null {
  const o = linkedObject(state, device);
  if (!o) return null;
  if (o.kind === 'door') return o.door.state;
  if (o.kind === 'light') return o.light.on ? 'on' : 'off';
  return o.region.cams || 'on';
}

/** Lights and cameras follow the device: on only while it works and was not switched off. Doors keep their state. */
function syncDeviceLink(ctx: ActionContext, device: HostDevice): void {
  const o = linkedObject(ctx.state, device);
  if (!o || o.kind === 'door') return;
  const on = deviceWorks(device) && device.on !== false;
  if (o.kind === 'light') o.light.on = on;
  else o.region.cams = on ? 'on' : 'off';
  refreshFog(ctx.state, o.map);
}

/** Apply a command (DEVICE_CMD_LABELS) to the linked map object. Returns a message or null. */
function applyDeviceCmd(ctx: ActionContext, device: HostDevice, cmd: string): I18nMessage | null {
  const o = linkedObject(ctx.state, device);
  if (!o || !(DEVICE_CMD_LABELS as Loose)[o.kind]?.[cmd]) return null;
  if (o.kind === 'door') {
    const before = o.door.state;
    o.door.state = cmd === 'open' ? 'open' : cmd === 'lock' ? 'locked' : 'closed';
    if (before !== o.door.state) sfx(ctx, o.door.state === 'open' ? 'door-open' : before === 'open' ? 'door-close' : 'door-locked');
  } else {
    device.on = cmd === 'on';
    syncDeviceLink(ctx, device);
  }
  refreshFog(ctx.state, o.map);
  return { t: 'On the map: {device} → {cmd}.', params: { device: device.name, cmd: { t: (DEVICE_CMD_LABELS as Loose)[o.kind][cmd] } } };
}

// ---------------------------------------------------------------------------
// Combat tracker sync: IC of a host with a decker in the fight, loaded agents of deckers in the fight
// ---------------------------------------------------------------------------
const icEntryKey = (hostId: string, icId: string) => `ic:${hostId}:${icId}`;
const agentEntryKey = (actorId: ActorId) => `agent:${actorId}`;

function syncMatrixCombat(ctx: ActionContext): void {
  const c = ctx.state.combat;
  if (!c?.active) return;
  const m = slice(ctx.state);
  const fighting = new Set(c.entries.filter((e) => !isVirtual(e) && !e.out && e.actorId).map((e) => e.actorId));
  const wantIc = new Map<string, { host: Host; ic: HostIc }>();
  const wantAgent = new Map<string, { p: Persona; actor: Actor }>();
  for (const p of Object.values(m.personas)) {
    const actor = ctx.state.actors?.[p.actorId];
    if (!actor?.matrix || !p.online || !fighting.has(p.actorId)) continue;
    // The decker's own entry follows the connection mode (next initiative roll).
    const own = c.entries.find((e) => e.actorId === p.actorId && !isVirtual(e));
    const mode = p.mode === 'ar' ? 'physical' : p.mode;
    if (own && own.mode !== mode && (own.mode === 'physical' || own.mode === 'ar' || own.mode === 'cold' || own.mode === 'hot')) own.mode = mode as typeof own.mode;
    if (p.agent?.loaded) wantAgent.set(agentEntryKey(p.actorId), { p, actor });
    const host = p.hostId ? m.hosts[p.hostId] : null;
    if (host) for (const ic of host.ic || []) if (ic.active && (IC_TYPES as Loose)[ic.type]) wantIc.set(icEntryKey(host.id, ic.id), { host, ic });
  }
  const gone = c.entries.filter((e) => isVirtual(e) && !e.out && !wantIc.has(e.matrixKey as string) && !wantAgent.has(e.matrixKey as string)).map((e) => e.matrixKey);
  for (const key of gone) setVirtualOut(ctx, key as string);
  for (const [key, { host, ic }] of wantIc) {
    const nameI18n = icNameMsg(ic.type, host.name);
    upsertVirtualEntry(ctx, { kind: 'ic', key, name: fr(nameI18n), nameI18n, hostId: host.id, icId: ic.id, disposition: 'hostile' });
  }
  for (const [key, { p, actor }] of wantAgent) {
    const nameI18n = agentAuthorMsg(p.agent!, actor);
    upsertVirtualEntry(ctx, { kind: 'agent', key, name: fr(nameI18n), nameI18n, ownerId: actor.id, disposition: 'pc' });
  }
}

// New Combat Turn: each alerted host with an intruder in the fight launches its next IC (setting autoLaunchIc).
combatHooks.push((ctx: ActionContext, c: TableState['combat'], event: string) => {
  if (event === 'newTurn' && slice(ctx.state).settings.autoLaunchIc) {
    const fighting = new Set(c.entries.filter((e) => !isVirtual(e) && !e.out).map((e) => e.actorId));
    for (const host of Object.values(slice(ctx.state).hosts)) {
      if (host.alert !== 'active') continue;
      if (intrudersOf(ctx.state, host).some((p) => fighting.has(p.actorId))) launchNextIc(ctx, host);
    }
  }
  syncMatrixCombat(ctx);
});

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
function canSeeHost(state: TableState, user: SessionUser, host: Host): boolean {
  if (user.role === 'gm') return true;
  if (host.visible) return true;
  const own = user.characterIds || [];
  return own.some((id) => {
    const p = state.matrix?.personas?.[id];
    if (!p) return false;
    if (p.hostId === host.id) return true;
    return (p.marks || []).some((m) => String(m.targetId).split(':')[1] === host.id && m.count > 0);
  });
}
const perceivedBy = (host: Host, actorIds: string[]) => (host.perceivedBy || []).some((id) => actorIds.includes(id));

/**
 * Resolve p.targetId into { kind, key, name, nameMsg, host?, ic?, device?, file?, actor?, persona?, source? }.
 * name = French display (stored on marks), nameMsg = the same as a message param (string or { t, params }).
 * Formats: host:<id> · ic:<host>:<id> · device:<host>:<id> · file:<host>:<id> · persona:<actorId> · manual · mark:<sourceId>
 */
function resolveTarget(ctx: ActionContext, persona: Persona, action: MatrixActionDef, p: MatrixActionPayload): Target {
  const raw = str(p.targetId, 200);
  const allow = action.targets || ['none'];
  if (!raw || raw === 'none') {
    if (allow.includes('none')) return { kind: 'none', key: null, name: '', nameMsg: '' };
    ctx.fail('Pick a target for this action');
  }
  const [kind, a, b] = raw.split(':');
  const t: Target = { kind };
  const own = ctx.isGM ? null : [persona.actorId];
  if (kind === 'markOnMe' || kind === 'mark') {
    t.kind = 'markOnMe';
    const sourceId = raw.slice(raw.indexOf(':') + 1);
    const e = persona.marksOnMe.find((m) => m.sourceId === sourceId && m.count > 0);
    if (!e) return ctx.fail('This mark no longer exists');
    t.mark = e;
    t.key = null;
    t.nameMsg = { t: 'mark from {name}', params: { name: markNameMsg(e) } };
    const [sk, sa] = sourceId.split(':');
    if (sk === 'host') t.host = slice(ctx.state).hosts[sa] || null;
    if (sk === 'persona') {
      t.actor = ctx.state.actors?.[sa] || null;
      t.persona = t.actor?.matrix ? ensurePersona(ctx.state, t.actor) : null;
    }
  } else if (kind === 'host' || kind === 'ic' || kind === 'device' || kind === 'file') {
    const host = getHost(ctx, a);
    if (!canSeeHost(ctx.state, ctx.user, host)) ctx.fail('Host not found');
    t.host = host;
    if (kind === 'host') {
      t.key = `host:${host.id}`;
      t.nameMsg = host.name;
    } else {
      const inside = persona.hostId === host.id;
      if (kind === 'ic') {
        t.ic = (host.ic || []).find((x) => x.id === b);
        if (!t.ic) return ctx.fail('IC not found');
        if (own && (!inside || !t.ic.active)) ctx.fail('This IC is out of reach (enter the host first)');
        t.nameMsg = icNameMsg(t.ic.type, host.name);
      } else if (kind === 'device') {
        t.device = (host.devices || []).find((x) => x.id === b);
        if (!t.device) return ctx.fail('Device not found');
        if (own && !perceivedBy(host, own)) ctx.fail('Spot this device first (Matrix Perception on the host)');
        t.nameMsg = `${t.device.name} (${host.name})`;
      } else {
        t.file = (host.files || []).find((x) => x.id === b);
        if (!t.file) return ctx.fail('File not found');
        if (own && (!inside || !perceivedBy(host, own))) ctx.fail('This file is out of reach (enter the host and spot it with Matrix Perception)');
        t.nameMsg = { t: 'file “{name}”', params: { name: t.file.name } };
      }
      t.key = `${kind}:${host.id}:${b}`;
    }
  } else if (kind === 'persona') {
    const target = ctx.state.actors?.[a];
    if (!target || (!ctx.isGM && target.type === 'npc' && target.hidden)) return ctx.fail('Persona not found');
    if (target.id === persona.actorId) ctx.fail('You cannot target yourself');
    t.actor = target;
    t.persona = target.matrix ? ensurePersona(ctx.state, target) : null;
    t.key = `persona:${target.id}`;
    t.nameMsg = target.name;
  } else if (kind === 'manual') {
    const name = str(p.targetName, 60).trim();
    // The key keeps the French default so marks stay found whatever the UI language (the client uses the same slug).
    t.key = `manual:${slug(name || 'cible inconnue') || 'cible'}`;
    t.nameMsg = name || { t: 'unknown target' };
  } else ctx.fail('Invalid target');
  if (!allow.includes(t.kind as MatrixTargetKind)) ctx.fail('This action cannot target that kind of icon');
  t.name = fr(t.nameMsg);
  return t;
}

/** Defense pool for an action against a target, or null (no opposition) / { pending: true } (GM to roll). labelMsg = who defends. */
function defenseFor(ctx: ActionContext, action: MatrixActionDef, target: Target, p: MatrixActionPayload): Defense {
  const d = action.defense;
  if (!d) return null;
  if ('fixed' in d && d.fixed) return { pool: d.fixed, parts: [{ label: 'GOD', value: d.fixed }], labelMsg: { t: 'GOD' } };
  if ('x2' in d && d.x2) {
    let r = 0;
    let label = '';
    if (d.x2 === 'protection') {
      r = Number(target.file?.protection) || Number(target.host?.rating) || 0;
      label = tk('Protection');
    } else if (d.x2 === 'bomb') {
      r = Number(target.file?.bomb) || 0;
      label = tk('Data bomb');
    } else {
      r = Number(target.host?.rating) || 0;
      label = tk('Device Rating');
    }
    const params = { what: { t: label }, r };
    return { pool: r * 2, parts: [{ label: fr({ t: '{what} {r} × 2', params }), key: '{what} {r} × 2', params, value: r * 2 }], labelMsg: { t: label } };
  }
  if (target.kind === 'markOnMe') {
    if (target.host) return { ...(hostDefensePool(target.host, action) as Loose), labelMsg: target.host.name } as Defense;
    if (target.actor) return { ...(personaDefensePool(target.actor, target.persona, d) as Loose), labelMsg: target.actor.name } as Defense;
    return { pending: true };
  }
  if (target.host) return { ...(hostDefensePool(target.host, action) as Loose), labelMsg: target.host.name } as Defense;
  if (target.kind === 'persona') {
    if (!target.actor!.attributes) return { pending: true };
    return { ...(personaDefensePool(target.actor, target.persona, d) as Loose), labelMsg: target.actor!.name } as Defense;
  }
  if (target.kind === 'manual') {
    if (ctx.isGM && p.defensePool !== undefined && p.defensePool !== null && p.defensePool !== '') {
      const n = clampInt(p.defensePool, 0, 60, 0);
      return { pool: n, parts: [{ label: 'Défense (MJ)', key: tk('Defense (GM)'), value: n }], labelMsg: target.nameMsg as MsgLike };
    }
    return { pending: true };
  }
  return null;
}

/** Resist matrix damage on a target; returns { boxes, sentences (messages) }. */
function damageTarget(ctx: ActionContext, target: Target, dv: number, attacker: Actor) {
  let resistPool = 0;
  let mon = 0;
  if (target.ic) {
    resistPool = (Number(target.host!.rating) || 0) + (Number(target.host!.firewall) || 0);
    mon = matrixMonitor(target.host!.rating);
  } else if (target.device) {
    const r = Math.max(Number(target.device.rating) || 0, Number(target.host?.rating) || 0);
    resistPool = r + Math.max(Number(target.device.rating) || 0, Number(target.host?.firewall) || 0);
    mon = matrixMonitor(target.device.rating);
  } else if (target.kind === 'persona' && target.actor?.matrix) {
    const ds = deckStats(target.actor, target.persona);
    resistPool = ds.deviceRating + ds.eff.firewall + programSum(target.persona, 'resistMatrix');
    mon = ds.monitor;
  } else {
    return { boxes: dv, sentences: [{ t: '{target} must resist {dv} Matrix damage (GM’s call).', params: { target: target.nameMsg as MsgLike, dv } }] as I18nMessage[] };
  }
  const res = roll(resistPool, {}, 'opposition');
  const boxes = Math.max(0, dv - res.hits);
  const out: I18nMessage[] = [{ t: 'DV {dv}: {target} resists with {hits} and takes {boxes}.', params: { dv, target: target.nameMsg as MsgLike, hits: hitsM(res.hits), boxes: boxesM(boxes) } }];
  if (target.ic) {
    target.ic.damage = Math.min(mon, (target.ic.damage || 0) + boxes);
    if (target.ic.damage >= mon && target.ic.active) {
      target.ic.active = false;
      target.ic.crashed = true;
      out.push({ t: '{target} is destroyed!', params: { target: target.nameMsg as MsgLike } });
    }
  } else if (target.device) {
    target.device.damage = Math.min(mon, (target.device.damage || 0) + boxes);
    if (target.device.damage >= mon && !target.device.bricked) {
      target.device.bricked = true;
      syncDeviceLink(ctx, target.device);
      out.push({ t: '{device} is bricked!', params: { device: target.device.name } });
    }
  } else if (target.persona) {
    out.push(...damageDeck(ctx, target.actor!, target.persona, boxes));
  }
  return { boxes, sentences: out, resistHits: res.hits, resistPool, attacker };
}

/** A data bomb goes off on the decker: Rating D6 matrix damage (resist DR + FW + Defuse/Armor), file destroyed. */
function explodeBomb(ctx: ActionContext, actor: Actor, persona: Persona, host: Host, file: HostFile, { agent }: { agent?: boolean } = {}): I18nMessage[] {
  const rating = Number(file.bomb) || 0;
  let dv = 0;
  for (let i = 0; i < rating; i++) dv += 1 + Math.floor(Math.random() * 6);
  if (testDice) dv = rating * 3;
  const ds = deckStats(actor, persona);
  const pool = ds.deviceRating + ds.eff.firewall + programSum(persona, 'resistBomb') + programSum(persona, 'resistMatrix');
  const res = roll(pool, {}, 'actor');
  const boxes = Math.max(0, dv - res.hits);
  const out: I18nMessage[] = [{ t: 'BOOM! The data bomb (rating {rating}) goes off: DV {dv}, {hits} on the resistance test.', params: { rating, dv, hits: hitsM(res.hits) } }];
  out.push(...(agent ? damageAgent(actor, persona, boxes) : damageDeck(ctx, actor, persona, boxes)));
  host.files = (host.files || []).filter((f) => f.id !== file.id);
  out.push({ t: 'The file “{file}” is destroyed.', params: { file: file.name } });
  sfx(ctx, 'explosion', [...ownersOf(ctx.state, actor.id), 'gm']);
  return out;
}

// ---------------------------------------------------------------------------
// Action resolution (decker or agent)
// ---------------------------------------------------------------------------
function performAction(ctx: ActionContext, actor: Actor, persona: Persona, action: MatrixActionDef, p: MatrixActionPayload, { agent = false }: { agent?: boolean } = {}) {
  const ag = persona.agent!;
  const who = agent ? ag.name : actor.name;
  const authorMsg = agent ? agentAuthorMsg(ag, actor) : null;
  const author = authorMsg ? fr(authorMsg) : actor.name;
  const target = resolveTarget(ctx, persona, action, p);
  const actionMsg = { t: action.fr };
  const labelMsg: I18nMessage = target.name ? { t: '{action} → {target}', params: { action: actionMsg, target: target.nameMsg as MsgLike } } : actionMsg;
  const logBase = { author, ...(authorMsg ? { authorI18n: toI18n(authorMsg) } : {}) };
  const done = (msgs: I18nMessage[], extra: { agent?: boolean } = {}) => {
    mlog(ctx, { ...logBase, msgs, matrix: { actionId: action.id, actorId: actor.id, ...(extra.agent !== undefined ? { agent: extra.agent } : {}), outcomes: msgs.map(fr) } });
    return msgs;
  };

  // Marks required
  let marksNeeded = action.marks || 0;
  if (action.id === 'controlDevice') marksNeeded = clampInt(p.controlMarks, 1, 3, 1);
  if (action.marksOnOwner) marksNeeded = 0; // the mark must be on the impersonated owner: arbitrated by the GM
  const have = effectiveMarks(persona, target);
  if (marksNeeded > have) {
    const params = { n: marksNeeded, target: target.nameMsg as MsgLike, have };
    if (marksNeeded === 1) ctx.fail('You need {n} mark on {target} ({have} now)', params);
    ctx.fail('You need {n} marks on {target} ({have} now)', params);
  }

  // Actions without a test
  if (action.noTest) {
    if (agent) ctx.fail('Your agent cannot take this action for you');
    let msgs: I18nMessage[] = [];
    if (action.id === 'enterHost') {
      persona.hostId = target.host!.id;
      persona.fullDefense = false;
      msgs = [{ t: '{who} enters the host {host}.', params: { who, host: target.host!.name } }];
    } else if (action.id === 'exitHost') {
      if (!persona.hostId) ctx.fail('You are not in any host');
      const h = slice(ctx.state).hosts[persona.hostId];
      if (persona.linkLocked) ctx.fail('Link-lock: you cannot leave the host');
      const convergedHere = persona.hostConverged && persona.hostConverged === persona.hostId;
      persona.hostId = null;
      msgs = [{ t: '{who} leaves the host {host} and returns to the grid.', params: { who, host: h ? h.name : '' } }];
      // SR5 p. 247: leaving a host after a convergence inside it → the grid's demiGOD converges at once.
      if (convergedHere) {
        persona.hostConverged = null;
        done(msgs);
        const conv = converge(ctx, actor, persona, { grid: true });
        return { actionId: action.id, noTest: true, outcomes: msgs.map(fr), msgs, success: true, convergence: conv.map(fr), convergenceMsgs: conv };
      }
    } else if (action.id === 'fullMatrixDefense') {
      persona.fullDefense = true;
      msgs = [{ t: '{who} goes on Full Matrix Defense (+Willpower on defense, −10 initiative).', params: { who } }];
    } else if (action.id === 'rebootSelf') {
      const out = rebootDeck(ctx, actor, persona);
      msgs = [{ t: '{who} reboots their deck: Overwatch Score reset to 0, marks erased.', params: { who } }, ...out];
    }
    done(msgs);
    return { actionId: action.id, noTest: true, outcomes: msgs.map(fr), msgs, success: true };
  }

  // Jack out: free unless link-locked
  if (action.id === 'jackOut') {
    if (agent) ctx.fail('Your agent cannot jack you out');
    if (!persona.linkLocked) {
      goOffline(ctx, actor, persona, { dumped: false });
      const msgs = done([{ t: '{who} jacks out of the Matrix cleanly.', params: { who } }]);
      return { actionId: action.id, noTest: true, outcomes: msgs.map(fr), msgs, success: true };
    }
  }

  // File preconditions (before rolling)
  if (action.id === 'editFile' && target.file) {
    if (target.file.protected) ctx.fail('Protected file: crack it first (Crack File)');
    if (Number(target.file.bomb) > 0 && target.file.bombBy !== actor.id) {
      const out = done(explodeBomb(ctx, actor, persona, target.host!, target.file, { agent }), { agent });
      return { actionId: action.id, exploded: true, outcomes: out.map(fr), msgs: out, success: false };
    }
  }
  if (action.id === 'crackFile' && target.file && !target.file.protected) ctx.fail('This file is not protected');
  if (action.id === 'disarmDataBomb' && target.file && !(Number(target.file.bomb) > 0)) ctx.fail('No data bomb on this file (as far as you know)');

  // Teamwork bonus from the agent
  let assist: { dice: number; limitBonus: number } | null = null;
  if (p.assistFromAgent && !agent) {
    const pa = persona.pendingAssist;
    if (!pa) return ctx.fail('No agent assist pending: have it assist first');
    if (pa.skill !== action.skill) ctx.fail('The agent’s assist was for another skill');
    assist = { dice: pa.dice, limitBonus: pa.limitBonus };
    persona.pendingAssist = null;
  }

  // Edge
  const edge = !!p.edge && !agent;
  if (edge && (actor.edge?.current || 0) <= 0) ctx.fail('{name} has no Edge left', { name: actor.name });

  const marksWanted = action.placesMarks ? clampInt(p.marks, 1, 3, 1) : 0;
  // Decker's modifiers (skill / linked attribute / Codeslinger dice: shared/modifiers.js), computed here; the client only says which
  // situational switches are on (checked against the actor's own modifiers). The agent rolls its Rating: no modifier.
  const mods = agent ? null : actorModifiers(actor);
  const conditions = mods ? cleanConditions(mods, p.conditions) : [];
  const pc = actionPool(actor, persona, action, { useSpec: !!p.useSpec && !agent, marks: marksWanted, modifier: clampInt(p.modifier, -30, 30, 0), assist, edge, agent, ...(mods ? { mods, conditions } : {}) });
  if (pc.impossible) ctx.fail(pc.reasonKey || pc.reason || '', pc.reasonParams);
  if (pc.pool <= 0) ctx.fail('Dice pool of zero: the action fails automatically');
  if (edge) actor.edge!.current -= 1;

  const r = roll(pc.pool, { limit: pc.limit, explode: edge }, 'actor');
  const ll = persona.linkLocked!;
  const def: Defense = action.id === 'jackOut'
    ? { pool: ll.pool, parts: [{ label: ll.name, value: ll.pool }], labelMsg: linkLockMsg(ll) }
    : defenseFor(ctx, action, target, p);
  let dr: ReturnType<typeof roll> | null = null;
  if (def && !def.pending) dr = roll(def.pool, {}, 'opposition');
  const defHits = dr ? dr.hits : 0;
  const net = r.hits - defHits;
  const threshold = clampInt(p.threshold, 0, 30, 0);
  const pending = !!def?.pending;
  const success = pending ? null : dr ? net > 0 : r.hits >= Math.max(1, threshold);
  const outcomes: I18nMessage[] = [];
  let osDelta = 0;
  const tgt = target.nameMsg as MsgLike;

  if (r.critGlitch) outcomes.push({ t: 'Critical glitch! {who} makes a serious mistake (GM’s call).', params: { who } });
  else if (r.glitch) outcomes.push({ t: 'Glitch for {who} (GM’s call).', params: { who } });
  if (pending) outcomes.push({ t: '{hits}: the GM rolls the defense for {target}.', params: { hits: hitsM(r.hits), target: tgt } });
  else if (dr) {
    outcomes.push(success
      ? { t: 'Success: {net} against {d} for {defender}.', params: { net: netM(net), d: defHits, defender: (def as Loose).labelMsg } }
      : { t: 'Failure: {hits} against {d} for {defender}.', params: { hits: r.hits, d: defHits, defender: (def as Loose).labelMsg } });
  } else outcomes.push(success ? { t: 'Success with {hits}.', params: { hits: hitsM(r.hits) } } : { t: 'Failure ({hits}).', params: { hits: hitsM(r.hits) } });

  // Overwatch: illegal actions add the defender's hits
  if (isIllegal(action) && dr && defHits > 0) {
    osDelta = defHits;
    addOverwatch(ctx, persona, defHits);
  }

  if (success) {
    switch (action.id) {
      case 'hackOnTheFly':
      case 'bruteForce': {
        const n = addMark(persona, target.key as string, target.name as string, marksWanted, target.nameMsg);
        const params = { n: marksWanted, target: tgt, total: n };
        outcomes.push(marksWanted === 1 ? { t: '{n} mark placed on {target} (total {total}).', params } : { t: '{n} marks placed on {target} (total {total}).', params });
        if (action.id === 'bruteForce' && Math.floor(net / 2) > 0 && (target.ic || target.device || target.kind === 'persona' || target.kind === 'manual')) {
          outcomes.push(...damageTarget(ctx, target, Math.floor(net / 2), actor).sentences);
        }
        break;
      }
      case 'dataSpike': {
        const marks = effectiveMarks(persona, target);
        const dv = deckStats(actor, persona).eff.attack + net + 2 * marks;
        outcomes.push(...damageTarget(ctx, target, dv, actor).sentences);
        break;
      }
      case 'crashProgram': {
        const progs = target.persona?.loadedPrograms || [];
        const wanted = str(p.program, 60);
        const victim = progs.find((x: string) => x.toLowerCase() === wanted.toLowerCase()) || (progs.length ? progs[Math.floor(Math.random() * progs.length)] : null);
        if (victim && target.persona) {
          target.persona.loadedPrograms = progs.filter((x: string) => x !== victim);
          outcomes.push({ t: '{target}’s {program} program crashes.', params: { program: victim, target: tgt } });
        } else outcomes.push({ t: 'One of {target}’s programs crashes (GM’s call).', params: { target: tgt } });
        break;
      }
      case 'crackFile':
        target.file!.protected = false;
        outcomes.push({ t: 'The protection on file “{file}” is cracked.', params: { file: target.file!.name } });
        break;
      case 'eraseMark':
        target.mark!.count -= 1;
        persona.marksOnMe = persona.marksOnMe.filter((m) => m.count > 0);
        outcomes.push({ t: 'A mark from {name} is erased.', params: { name: markNameMsg(target.mark) } });
        break;
      case 'jamSignals':
        outcomes.push({ t: 'Jamming: noise +{n} within 100 m.', params: { n: r.hits } });
        break;
      case 'spoofCommand': {
        outcomes.push(p.command ? { t: 'The device executes the spoofed command: “{command}”.', params: { command: str(p.command, 120) } } : { t: 'The device executes the spoofed command.' });
        const mapMsg = target.device && p.deviceCmd ? applyDeviceCmd(ctx, target.device, str(p.deviceCmd, 20)) : null;
        if (mapMsg) outcomes.push(mapMsg);
        break;
      }
      case 'snoop':
        outcomes.push({ t: '{who} intercepts {target}’s traffic.', params: { who, target: tgt } });
        break;
      case 'hide':
        if (target.host) target.host.spotted = (target.host.spotted || []).filter((id) => id !== actor.id);
        outcomes.push({ t: '{target} loses track of {who}.', params: { target: tgt, who } });
        break;
      case 'formatDevice':
        if (target.device) {
          target.device.formatted = true;
          syncDeviceLink(ctx, target.device);
        }
        outcomes.push({ t: '{target} is formatted: it will not reboot.', params: { target: tgt } });
        break;
      case 'rebootDevice':
        if (target.device) {
          target.device.offline = true;
          syncDeviceLink(ctx, target.device);
        }
        if (target.kind === 'persona' && target.persona?.online) outcomes.push(...rebootDeck(ctx, target.actor!, target.persona));
        outcomes.push({ t: '{target} reboots (offline until the end of the next turn).', params: { target: tgt } });
        break;
      case 'setDataBomb': {
        const rating = Math.min(12, net + programSum(persona, 'bombBonus'));
        target.file!.bomb = rating;
        target.file!.bombBy = actor.id;
        outcomes.push({ t: 'Rating {rating} data bomb set on “{file}”.', params: { rating, file: target.file!.name } });
        break;
      }
      case 'checkOverwatch':
        persona.osKnown = persona.overwatch;
        persona.osKnownAt = Date.now();
        outcomes.push({ t: 'Current Overwatch Score: {os}.', params: { os: persona.overwatch } });
        break;
      case 'matrixPerception': {
        if (target.host) {
          const h = target.host;
          h.perceivedBy = [...new Set([...(h.perceivedBy || []), actor.id])];
          if (target.ic) target.ic.detected = true;
          if (target.kind === 'host' && persona.hostId === h.id) for (const ic of h.ic || []) if (ic.active) ic.detected = true;
          const params = { n: r.hits, target: tgt };
          outcomes.push(r.hits === 1 ? { t: '{n} piece of information gained on {target}.', params } : { t: '{n} pieces of information gained on {target}.', params });
        } else outcomes.push(r.hits === 1 ? { t: '{n} piece of information (the GM answers).', params: { n: r.hits } } : { t: '{n} pieces of information (the GM answers).', params: { n: r.hits } });
        break;
      }
      case 'matrixSearch':
        outcomes.push({ t: '{hits} on the search (the GM answers).', params: { hits: hitsM(r.hits) } });
        break;
      case 'traceIcon':
        outcomes.push({ t: '{target}’s physical location traced.', params: { target: tgt } });
        break;
      case 'controlDevice': {
        if (target.device) target.device.controlledBy = actor.id;
        outcomes.push(p.command ? { t: '{target} obeys: “{command}”.', params: { target: tgt, command: str(p.command, 120) } } : { t: '{target} obeys.', params: { target: tgt } });
        const mapMsg = target.device && p.deviceCmd ? applyDeviceCmd(ctx, target.device, str(p.deviceCmd, 20)) : null;
        if (mapMsg) outcomes.push(mapMsg);
        break;
      }
      case 'editFile': {
        const f = target.file!;
        const host = target.host!;
        const op = ['read', 'copy', 'edit', 'delete'].includes(p.fileOp as string) ? p.fileOp : 'copy';
        if (op === 'copy' || op === 'read') {
          if (op === 'copy' && !persona.files.some((x) => x.sourceId === f.id)) {
            persona.files.push({ id: uid('pay'), sourceId: f.id, name: f.name, hostName: host.name, value: loadedProgramIds(persona).has('evaluate') ? f.value ?? null : null, content: f.content || '', ts: Date.now() });
          }
          if (op === 'read' && !persona.files.some((x) => x.sourceId === f.id)) {
            persona.files.push({ id: uid('pay'), sourceId: f.id, name: f.name, hostName: host.name, value: null, content: f.content || '', ts: Date.now(), readOnly: true });
          }
          outcomes.push(op === 'copy' ? { t: 'File “{file}” copied to the deck.', params: { file: f.name } } : { t: 'File “{file}” read.', params: { file: f.name } });
          sfx(ctx, 'notify', 'gm'); // the GM may want to describe what the file says
        } else if (op === 'edit') {
          f.edited = true;
          outcomes.push(p.command ? { t: 'File “{file}” edited: {change}.', params: { file: f.name, change: str(p.command, 160) } } : { t: 'File “{file}” edited.', params: { file: f.name } });
        } else {
          host.files = host.files.filter((x) => x.id !== f.id);
          outcomes.push({ t: 'File “{file}” deleted.', params: { file: f.name } });
        }
        break;
      }
      case 'disarmDataBomb':
        target.file!.bomb = 0;
        target.file!.bombBy = null;
        outcomes.push({ t: 'Data bomb disarmed on “{file}”.', params: { file: target.file!.name } });
        break;
      case 'jackOut':
        outcomes.push({ t: '{who} breaks the link-lock and jacks out.', params: { who } });
        goOffline(ctx, actor, persona, { dumped: false });
        break;
      default:
        break;
    }
  } else if (success === false) {
    if (action.id === 'disarmDataBomb' && target.file) outcomes.push(...explodeBomb(ctx, actor, persona, target.host!, target.file, { agent }));
    // Failed Sleaze action: the target marks you and raises the alarm
    if (action.cat === 'sleaze' && dr && target.kind !== 'none' && !(action.defense && 'fixed' in action.defense && action.defense.fixed)) {
      const sourceId = target.host ? `host:${target.host.id}` : target.key;
      const sourceMsg = (target.host ? target.host.name : target.nameMsg) as MsgLike;
      if (sourceId) {
        addMarkOnMe(persona, sourceId, fr(sourceMsg), 1, sourceMsg);
        outcomes.push({ t: '{source} places a mark on {name}.', params: { source: sourceMsg, name: actor.name } });
      }
      if (target.host) {
        const s = setAlert(ctx, target.host, { t: '{action} failed by {who}', params: { action: actionMsg, who } });
        if (s) outcomes.push(s);
      }
    }
    // Failed Attack action: 1 box per net hit of the defender
    if (action.cat === 'attack' && dr && defHits > r.hits) {
      const back = defHits - r.hits;
      outcomes.push({ t: 'Backlash: {boxes} of Matrix damage.', params: { boxes: boxesM(back) } });
      outcomes.push(...(agent ? damageAgent(actor, persona, back) : damageDeck(ctx, actor, persona, back)));
      if (target.host) {
        const s = setAlert(ctx, target.host, { t: '{action} failed by {who}', params: { action: actionMsg, who } });
        if (s) outcomes.push(s);
      }
    }
  }
  // Attacks are noticed by the target even when they succeed.
  if (success && action.cat === 'attack' && target.host && action.id !== 'crackFile' && action.id !== 'eraseMark') {
    const s = setAlert(ctx, target.host, { t: '{action} by {who}', params: { action: actionMsg, who } });
    if (s) outcomes.push(s);
  }
  if (osDelta) outcomes.push({ t: 'Overwatch Score +{n}.', params: { n: osDelta } });
  if (pending && isIllegal(action)) outcomes.push({ t: 'Illegal action: the GM adds the defense’s hits to the Overwatch Score.' });

  const converged = (persona.overwatch as number) >= OS_MAX && persona.online && !persona.hostConverged;
  const rollLabelMsg: I18nMessage = agent ? { t: '{label} ({agent})', params: { label: labelMsg, agent: ag.name } } : labelMsg;
  const roll1 = { ...r, label: fr(rollLabelMsg), labelI18n: toI18n(rollLabelMsg), breakdown: sumParts(pc.parts) + (pc.limit ? ` [${pc.limit}]` : ''), explode: edge, edge };
  const defLabel = def && !def.pending ? fr(def.labelMsg) : '';
  const entry = mlog(ctx, {
    ...logBase, msgs: outcomes, roll: roll1,
    matrix: {
      actionId: action.id, actorId: actor.id, agent, targetName: target.name || '', success, net, pending, osDelta, outcomes: outcomes.map(fr),
      defenseHits: dr ? defHits : null, defenseDice: dr ? dr.dice : null, assist,
      gm: dr ? { defensePool: (def as Loose).pool, defenseParts: (def as Loose).parts } : undefined,
    },
  });
  sfx(ctx, 'dice');
  if (r.critGlitch) sfx(ctx, 'matrix-glitch', [...ownersOf(ctx.state, actor.id), 'gm']);
  let convergence: I18nMessage[] | null = null;
  if (converged) convergence = converge(ctx, actor, persona);
  return {
    actionId: action.id, logId: entry.id, label: roll1.label, labelMsg: rollLabelMsg, agent,
    roll: { pool: r.pool, dice: r.dice, extra: r.extra, hits: r.hits, rawHits: r.rawHits, limit: r.limit, glitch: r.glitch, critGlitch: r.critGlitch, parts: pc.parts },
    defense: dr ? { hits: defHits, dice: dr.dice, label: defLabel, labelMsg: (def as Loose).labelMsg, ...(ctx.isGM ? { pool: (def as Loose).pool } : {}) } : null,
    pending, net, success, outcomes: outcomes.map(fr), msgs: outcomes, osDelta,
    convergence: convergence ? convergence.map(fr) : null, convergenceMsgs: convergence,
  };
}

// ---------------------------------------------------------------------------
// IC attacks (GM)
// ---------------------------------------------------------------------------
function icAttack(ctx: ActionContext, host: Host, ic: HostIc, actor: Actor, persona: Persona) {
  const def: Loose = (IC_TYPES as Loose)[ic.type];
  if (!def) return ctx.fail('Unknown IC type');
  const icMsg = icNameMsg(ic.type, host.name);
  const icName = fr(icMsg);
  const icType = { t: def.fr };
  const hostMarks = persona.marksOnMe.find((m) => m.sourceId === `host:${host.id}`)?.count || 0;
  if (def.needsMarks && hostMarks < def.needsMarks) {
    const params = { ic: icType, n: def.needsMarks, name: actor.name, have: hostMarks };
    if (def.needsMarks === 1) ctx.fail('{ic}: the host needs {n} mark on {name} ({have} now)', params);
    ctx.fail('{ic}: the host needs {n} marks on {name} ({have} now)', params);
  }
  const pool = icAttackPool(host);
  const limit = Number((host as unknown as Loose)[def.limit]) || null;
  const a = roll(pool, { limit }, 'opposition');
  const dp = personaDefensePool(actor, persona, def.defense) as Loose;
  const d = roll(dp.pool, {}, 'actor');
  const net = a.hits - d.hits;
  const out: I18nMessage[] = [];
  const name = actor.name;
  if (net <= 0) out.push({ t: '{name} dodges ({d} vs {a}).', params: { name, d: d.hits, a: a.hits } });
  else {
    out.push({ t: 'Hit: {net} ({a} vs {d}).', params: { net: netM(net), a: a.hits, d: d.hits } });
    switch (def.effect) {
      case 'spot':
        host.spotted = [...new Set([...(host.spotted || []), actor.id])];
        out.push({ t: '{name} is spotted by Patrol IC.', params: { name } });
        {
          const s = setAlert(ctx, host, { t: '{ic} spotted {name}', params: { ic: icType, name } });
          if (s) out.push(s);
        }
        break;
      case 'mark': {
        const n = addMarkOnMe(persona, `host:${host.id}`, host.name, 1);
        out.push({ t: 'The host places a mark on {name} ({n}/3).', params: { name, n } });
        break;
      }
      case 'penalty': {
        const k: AsdfKey = def.attrHit;
        persona.penalties[k] = (Number(persona.penalties[k]) || 0) + 1;
        out.push({ t: '{attr} −1 until reboot (total −{total}).', params: { attr: { t: ASDF_LABELS[k] }, total: persona.penalties[k] } });
        break;
      }
      case 'crash': {
        const progs = [...persona.loadedPrograms, ...(persona.agent?.loaded ? ['__agent__'] : [])];
        if (!progs.length) out.push({ t: 'No loaded program to crash.' });
        else {
          const v = progs[Math.floor(Math.random() * progs.length)];
          if (v === '__agent__') {
            persona.agent!.loaded = false;
            out.push({ t: '{agent} crashes!', params: { agent: persona.agent!.name } });
          } else {
            persona.loadedPrograms = persona.loadedPrograms.filter((x) => x !== v);
            out.push({ t: 'The {program} program crashes.', params: { program: v } });
          }
        }
        break;
      }
      case 'linklock':
        persona.linkLocked = { source: `host:${host.id}`, name: icName, icType: ic.type, hostName: host.name, pool: (Number(host.rating) || 0) + (Number(host.attack) || 0) };
        out.push({ t: 'Link-lock: {name} can no longer jack out normally.', params: { name } });
        break;
      case 'reboot':
        out.push({ t: '{name} is forced to reboot their deck.', params: { name } });
        out.push(...rebootDeck(ctx, actor, persona));
        break;
      case 'trace':
        persona.traced = true;
        out.push({ t: '{name}’s physical location is traced.', params: { name } });
        mlog(ctx, { author: host.name, gmOnly: true, msgs: [{ t: '{ic}: {name}’s physical location sent to the host owner.', params: { ic: icType, name } }] });
        break;
      case 'damage': {
        // Same as a Data Spike: the host's Attack + net hits.
        const dv = (Number(host.attack) || 0) + net;
        const ds = deckStats(actor, persona);
        const rp = ds.deviceRating + ds.eff.firewall + programSum(persona, 'resistMatrix');
        const rr = roll(rp, {}, 'actor');
        const boxes = Math.max(0, dv - rr.hits);
        out.push({ t: 'DV {dv}: {hits} on the resistance test.', params: { dv, hits: hitsM(rr.hits) } });
        if (def.bio) {
          const type = def.bio === 'S' ? (persona.mode === 'ar' ? null : 'S') : persona.mode === 'hot' ? 'P' : persona.mode === 'cold' ? 'S' : null;
          if (type) {
            const bp = attr(actor, 'WIL') + ds.eff.firewall + programSum(persona, 'resistBio');
            const br = roll(bp, {}, 'actor');
            const bb = Math.max(0, dv - br.hits);
            applyActorDamage(actor, bb, type);
            const params = { boxes: boxesM(bb), hits: hitsM(br.hits) };
            out.push(type === 'P'
              ? { t: 'Biofeedback: {boxes} of Physical damage ({hits} on the resistance test).', params }
              : { t: 'Biofeedback: {boxes} of Stun damage ({hits} on the resistance test).', params });
          } else out.push({ t: 'No biofeedback in AR.' });
        }
        if (def.linklock && persona.online) {
          persona.linkLocked = { source: `host:${host.id}`, name: icName, icType: ic.type, hostName: host.name, pool: (Number(host.rating) || 0) + (Number(host.attack) || 0) };
          out.push({ t: 'Link-lock applied.' });
        }
        out.push(...damageDeck(ctx, actor, persona, boxes));
        break;
      }
      default:
        break;
    }
  }
  const labelMsg: I18nMessage = { t: '{ic} → {name}', params: { ic: icMsg, name } };
  const r1 = { ...a, label: fr(labelMsg), labelI18n: toI18n(labelMsg), breakdown: `Indice ${host.rating} × 2${limit ? ` [${limit}]` : ''}` };
  mlog(ctx, {
    author: icName, authorI18n: toI18n(icMsg), msgs: out, roll: r1,
    matrix: { icType: ic.type, hostId: host.id, actorId: actor.id, success: net > 0, net, defenseHits: d.hits, defenseDice: d.dice, outcomes: out.map(fr), gm: { defensePool: dp.pool } },
  });
  sfx(ctx, net > 0 ? 'matrix-glitch' : 'dice', 'all');
  return { hits: a.hits, defenseHits: d.hits, net, success: net > 0, outcomes: out.map(fr), msgs: out };
}

/** Marks the host holds on a persona. */
const hostMarksOn = (persona: Persona, host: Host): number => persona.marksOnMe.find((m) => m.sourceId === `host:${host.id}`)?.count || 0;

/**
 * Who an IC goes after (GM « Tour de l'hôte » / « Agir » in the tracker): Patrol IC looks for intruders not spotted yet;
 * the others attack the intruders the host knows best (spotted, then the most host marks), if they have the marks they need.
 * Returns { actor, persona } or { reasonMsg }.
 */
function pickIcTarget(ctx: ActionContext, host: Host, ic: HostIc): { persona?: Persona; actor?: Actor; reasonMsg?: I18nMessage } {
  const def: Loose = (IC_TYPES as Loose)[ic.type];
  const icType = { t: def.fr };
  let list = intrudersOf(ctx.state, host).map((p) => ensurePersona(ctx.state, ctx.state.actors[p.actorId]));
  if (!list.length) return { reasonMsg: { t: '{ic}: nobody in the host.', params: { ic: icType } } };
  const spotted = new Set(host.spotted || []);
  if (def.effect === 'spot') {
    list = list.filter((p) => !spotted.has(p.actorId));
    if (!list.length) return { reasonMsg: { t: '{ic}: everyone is already spotted, it keeps watch.', params: { ic: icType } } };
  } else {
    if (def.needsMarks) list = list.filter((p) => hostMarksOn(p, host) >= def.needsMarks);
    if (!list.length) {
      const params = { ic: icType, n: def.needsMarks };
      return { reasonMsg: def.needsMarks === 1 ? { t: '{ic} waits: it needs {n} host mark on its target.', params } : { t: '{ic} waits: it needs {n} host marks on its target.', params } };
    }
    list.sort((a, b) => Number(spotted.has(b.actorId)) - Number(spotted.has(a.actorId)) || hostMarksOn(b, host) - hostMarksOn(a, host));
  }
  return { persona: list[0], actor: ctx.state.actors[list[0].actorId] };
}

/** One IC acts (automatic target unless actorId). Returns { ic, result?, skipped?: message }. */
function icTakesTurn(ctx: ActionContext, host: Host, ic: HostIc, actorId: string | null): Loose {
  if (!ic.active) ctx.fail('This IC is not launched');
  let actor: Actor;
  let persona: Persona;
  if (actorId) {
    actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    persona = ensurePersona(ctx.state, actor);
    if (!persona.online || persona.hostId !== host.id) ctx.fail('{name} is not in this host', { name: actor.name });
  } else {
    const pick = pickIcTarget(ctx, host, ic);
    if (!pick.persona) {
      mlog(ctx, { author: host.name, gmOnly: true, msgs: [pick.reasonMsg!], matrix: { event: 'icIdle', hostId: host.id, icType: ic.type } });
      return { icId: ic.id, skipped: fr(pick.reasonMsg), skippedMsg: pick.reasonMsg };
    }
    actor = pick.actor!;
    persona = pick.persona;
  }
  return { icId: ic.id, actorId: actor.id, result: icAttack(ctx, host, ic, actor, persona) };
}

// ---------------------------------------------------------------------------
// Host sanitizers (GM input)
// ---------------------------------------------------------------------------
function cleanIc(x: unknown, host: Loose): HostIc | null {
  if (!isObj(x) || !(IC_TYPES as Loose)[x.type]) return null;
  return {
    id: str(x.id, 40) || uid('ic'), type: x.type, rating: clampInt(x.rating ?? host.rating, 1, 12, host.rating || 1),
    active: !!x.active, damage: clampInt(x.damage, 0, 30, 0), detected: !!x.detected, crashed: !!x.crashed && !x.active,
  };
}
function cleanFile(x: unknown): HostFile | null {
  if (!isObj(x)) return null;
  return {
    id: str(x.id, 40) || uid('file'), name: str(x.name, 80).trim() || 'Fichier', protected: !!x.protected,
    protection: clampInt(x.protection, 0, 12, 0), bomb: clampInt(x.bomb, 0, 12, 0), bombBy: x.bombBy ? str(x.bombBy, 60) : null,
    value: x.value === null || x.value === undefined || x.value === '' ? null : clampInt(x.value, 0, 1e7, 0),
    content: str(x.content, 4000), edited: !!x.edited,
  };
}
function cleanDevice(x: unknown): HostDevice | null {
  if (!isObj(x)) return null;
  const l = x.link;
  const link = isObj(l) && (DEVICE_LINK_KINDS as Loose)[l.kind] && l.mapId && l.targetId ? { mapId: str(l.mapId, 80), kind: l.kind, targetId: str(l.targetId, 80) } : null;
  return {
    id: str(x.id, 40) || uid('dev'), name: str(x.name, 80).trim() || 'Appareil', rating: clampInt(x.rating, 1, 12, 3),
    damage: clampInt(x.damage, 0, 30, 0), offline: !!x.offline, formatted: !!x.formatted, bricked: !!x.bricked,
    controlledBy: x.controlledBy ? str(x.controlledBy, 60) : null, notes: str(x.notes, 400),
    link, on: x.on !== false,
  };
}
function normalizeHost(h: Loose, id: string): Host {
  h.id = id;
  h.name = str(h.name, 80) || 'Hôte';
  h.rating = clampInt(h.rating, 1, 12, 3);
  const attrs = hostAttributes(h.rating);
  for (const k of ASDF) h[k] = clampInt(h[k] ?? attrs[k], 0, 20, attrs[k]);
  h.alert = h.alert === 'active' ? 'active' : 'none';
  h.visible = !!h.visible;
  h.ic = (Array.isArray(h.ic) ? h.ic : []).map((x: unknown) => cleanIc(x, h)).filter(Boolean);
  h.files = (Array.isArray(h.files) ? h.files : []).map(cleanFile).filter(Boolean);
  h.devices = (Array.isArray(h.devices) ? h.devices : []).map(cleanDevice).filter(Boolean);
  h.perceivedBy = Array.isArray(h.perceivedBy) ? h.perceivedBy.map(String) : [];
  h.spotted = Array.isArray(h.spotted) ? h.spotted.map(String) : [];
  h.spider = h.spider ? str(h.spider, 80) : null;
  h.spiderAlert = h.spiderAlert ? str(h.spiderAlert, 80) : null;
  h.notes = str(h.notes, 8000);
  h.description = str(h.description, 2000);
  h.folder = str(h.folder, 60);
  return h as Host;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
// Action payloads (players send most of them: every field is validated by the handlers).
interface ActorPayload {
  actorId?: ActorId;
}
interface HostPayload {
  hostId?: string;
  icId?: string;
}
/** 'matrix/action' / 'matrix/agentAct'. */
interface MatrixActionPayload {
  actorId?: ActorId;
  actionId?: string;
  targetId?: string;
  targetName?: string;
  modifier?: number;
  edge?: boolean;
  useSpec?: boolean;
  marks?: number;
  controlMarks?: number;
  assistFromAgent?: boolean;
  fileOp?: string;
  command?: string;
  deviceCmd?: string;
  program?: string;
  threshold?: number;
  conditions?: unknown;
  /** GM only. */
  defensePool?: number | string | null;
}
interface HostCreatePayload {
  name?: string;
  rating?: number;
  preset?: string;
  folder?: string;
  ic?: boolean;
}

// Every Matrix action first applies the Overwatch timer (when on), then keeps the combat tracker in sync (IC, agents, VR mode).
const wrap = <P>(handler: Handler<P>) => (ctx: ActionContext, p: P) => {
  tickOverwatch(ctx);
  const r = handler(ctx, p);
  syncMatrixCombat(ctx);
  return r;
};
const any = <P>(handler: Handler<P>): ActionDef => ({ role: 'any', handler: wrap(handler) as ActionDef['handler'] });
const gm = <P>(handler: Handler<P>): ActionDef => ({ role: 'gm', handler: wrap(handler) as ActionDef['handler'] });

// Rolls written to the log carry no roll.actorId on purpose: the LogDock would offer « 2ᵉ chance » (dice/secondChance
// only handles kind 'roll'); the actor is in entry.matrix.actorId.
const actions: Record<string, ActionDef> = {
  // { actorId } — create/sync the persona (slots from the deck catalog, agent detection) without connecting.
  'matrix/ensure': any((ctx: ActionContext, { actorId }: ActorPayload = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    return { programSlots: persona.programSlots, agent: persona.agent };
  }),

  // { actorId, mode: 'ar'|'cold'|'hot' } — connect, or switch interface mode when already online.
  'matrix/connect': any((ctx: ActionContext, { actorId, mode }: ActorPayload & { mode?: MatrixMode } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    if (!MODES.includes(mode as MatrixMode)) ctx.fail('Unknown connection mode');
    if (persona.bricked) ctx.fail('{name}’s deck is bricked: it must be repaired', { name: actor.name });
    const was = persona.online ? persona.mode : null;
    persona.mode = mode as MatrixMode;
    persona.online = true;
    const ini = matrixInitiative(actor, persona, mode, actorModifiers(actor));
    if (was !== mode) {
      const params = { name: actor.name, mode: { t: MODE_LABELS[mode as MatrixMode] }, ini: ini.text };
      mlog(ctx, { author: actor.name, msgs: [was ? { t: '{name} switches to {mode} (initiative {ini}).', params } : { t: '{name} connects to the Matrix in {mode} (initiative {ini}).', params }], matrix: { event: 'connect', actorId, mode } });
    }
    return { mode, initiative: ini };
  }),

  // { actorId, dump? } — graceful by default; GM may dump the persona (dumpshock in VR).
  'matrix/disconnect': any((ctx: ActionContext, { actorId, dump }: ActorPayload & { dump?: boolean } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    if (!persona.online) return { online: false };
    const forced = !!dump && ctx.isGM;
    if (!forced && persona.linkLocked) ctx.fail('Link-lock: use the “Jack Out” action to try to break it');
    const out = goOffline(ctx, actor, persona, { dumped: forced });
    const head = forced ? { t: '{name} is booted out of the Matrix.', params: { name: actor.name } } : { t: '{name} jacks out of the Matrix.', params: { name: actor.name } };
    mlog(ctx, { author: actor.name, msgs: [head, ...out], matrix: { event: 'disconnect', actorId } });
    if (forced) sfx(ctx, 'matrix-glitch', [...ownersOf(ctx.state, actorId as ActorId), 'gm']);
    return { online: false, outcomes: out.map(fr), msgs: out };
  }),

  // { actorId, swap: [a, b] } or { actorId, asdf: { attack: 'sleaze', … } } — cyberdecks only (Free Action).
  'matrix/setASDF': any((ctx: ActionContext, { actorId, swap, asdf }: ActorPayload & { swap?: AsdfKey[]; asdf?: Record<AsdfKey, AsdfKey> } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    if (!isCyberdeck(actor)) ctx.fail('Only a cyberdeck can swap its attributes');
    if (Array.isArray(swap)) {
      const [a, b] = swap;
      if (!ASDF.includes(a) || !ASDF.includes(b) || a === b) ctx.fail('Invalid swap');
      const next = { ...persona.asdf };
      [next[a], next[b]] = [next[b], next[a]];
      persona.asdf = next;
    } else if (isPermutation(asdf)) {
      persona.asdf = Object.fromEntries((ASDF as AsdfKey[]).map((k) => [k, asdf![k]])) as Persona['asdf'];
    } else ctx.fail('Invalid configuration');
    return { asdf: persona.asdf, eff: deckStats(actor, persona).eff };
  }),

  // { actorId, name }
  'matrix/loadProgram': any((ctx: ActionContext, { actorId, name }: ActorPayload & { name?: string } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    const n = str(name, 80).trim();
    const prog = availablePrograms(actor).find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!prog) ctx.fail('Program not on your deck');
    if (prog.id === 'agent') ctx.fail('Load the agent from its own panel');
    if (persona.loadedPrograms.some((x) => x.toLowerCase() === n.toLowerCase())) ctx.fail('Program already loaded');
    const s = programSlots(persona);
    const gain: number = prog.id === 'virtualMachine' ? (PROGRAM_BY_ID as Loose).virtualMachine.slots : 0;
    if (s.used + 1 > s.total + gain) ctx.fail('No free slot ({used}/{total}): unload a program first', { used: s.used, total: s.total });
    persona.loadedPrograms.push(prog.name);
    return { loadedPrograms: persona.loadedPrograms, slots: programSlots(persona) };
  }),

  'matrix/unloadProgram': any((ctx: ActionContext, { actorId, name }: ActorPayload & { name?: string } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    const n = str(name, 80).trim().toLowerCase();
    const idx = persona.loadedPrograms.findIndex((x) => x.toLowerCase() === n);
    if (idx < 0) ctx.fail('Program not loaded');
    const next = persona.loadedPrograms.filter((_, i) => i !== idx);
    const s = programSlots({ ...persona, loadedPrograms: next });
    if (s.used > s.total) ctx.fail('Unload other programs first: Virtual Machine provides slots that are in use');
    persona.loadedPrograms = next;
    return { loadedPrograms: persona.loadedPrograms, slots: programSlots(persona) };
  }),

  // { actorId, rating, name } — players: rating up to the best agent they own; GM: any rating 1-6.
  'matrix/configureAgent': any((ctx: ActionContext, { actorId, rating, name }: ActorPayload & { rating?: number; name?: string } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    const owned = detectAgents(actor);
    const max = owned.reduce((m, x) => Math.max(m, x.rating), 0);
    const r = clampInt(rating, 1, 6, 1);
    if (!ctx.isGM) {
      if (!max) ctx.fail('No agent in your gear: buy an Agent in the shop (Software)');
      if (r > max) ctx.fail('Your best agent is rating {n}', { n: max });
    }
    const prev: Partial<NonNullable<Persona['agent']>> = persona.agent || { loaded: false, damage: 0 };
    persona.agent = { ...(prev as NonNullable<Persona['agent']>), rating: r, name: str(name, 40).trim() || prev.name || `Agent ${r}`, source: prev.source || (ctx.isGM && !max ? 'gm' : 'gear') };
    persona.agent!.damage = Math.min(persona.agent!.damage || 0, matrixMonitor(r));
    return { agent: persona.agent };
  }),

  // { actorId, loaded }
  'matrix/agentLoad': any((ctx: ActionContext, { actorId, loaded }: ActorPayload & { loaded?: boolean } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    const ag = persona.agent;
    if (!ag) ctx.fail('No agent set up');
    if (loaded) {
      if (ag.loaded) return { agent: ag };
      const s = programSlots(persona);
      if (s.used + 1 > s.total) ctx.fail('No free slot for the agent ({used}/{total})', { used: s.used, total: s.total });
      ag.loaded = true;
      ag.damage = 0;
    } else {
      ag.loaded = false;
      if (persona.pendingAssist) persona.pendingAssist = null;
    }
    return { agent: ag };
  }),

  // { actorId, actionId } — teamwork: the agent rolls Rating × 2 [deck limit]; hits = bonus dice for the next test
  // of the same skill (≤ the decker's skill rating) and +1 limit if it scored. Glitch: no help. Critical glitch: it crashes.
  'matrix/agentAssist': any((ctx: ActionContext, { actorId, actionId }: ActorPayload & { actionId?: string } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    requireOnline(ctx, actor, persona);
    const ag = persona.agent;
    if (!ag || !ag.loaded) ctx.fail('Your agent is not loaded');
    const action: MatrixActionDef | undefined = ACTION_BY_ID[actionId as string];
    if (!action || action.noTest || !action.skill) ctx.fail('This action does not allow teamwork');
    const pc = actionPool(actor, persona, action, { agent: true });
    if (pc.pool <= 0) ctx.fail('Dice pool of zero for the agent');
    const r = roll(pc.pool, { limit: pc.limit }, 'actor');
    const cap = skillRating(actor, action.skill);
    let dice = Math.min(r.hits, cap);
    let limitBonus = r.hits > 0 ? 1 : 0;
    const outcomes: I18nMessage[] = [];
    const agent = ag.name;
    if (r.critGlitch) {
      dice = 0;
      limitBonus = 0;
      ag.loaded = false;
      outcomes.push({ t: 'Critical glitch: {agent} crashes and unloads from the deck. No help.', params: { agent } });
      sfx(ctx, 'matrix-glitch', [...ownersOf(ctx.state, actorId as ActorId), 'gm']);
    } else if (r.glitch) {
      dice = 0;
      limitBonus = 0;
      outcomes.push({ t: 'Glitch: {agent} gets tangled up and provides no help.', params: { agent } });
    } else if (r.hits) {
      const params = { agent, n: dice, action: { t: action.fr } };
      outcomes.push(dice === 1
        ? { t: '{agent} provides +{n} die and +1 limit for “{action}”.', params }
        : dice === 0
          ? { t: 'zero::{agent} provides +{n} dice and +1 limit for “{action}”.', params }
          : { t: '{agent} provides +{n} dice and +1 limit for “{action}”.', params });
      if (dice < r.hits) outcomes.push({ t: 'Bonus capped at {name}’s skill rating ({cap}).', params: { name: actor.name, cap } });
    } else outcomes.push({ t: '{agent} finds nothing useful (no hits).', params: { agent } });
    persona.pendingAssist = r.critGlitch ? null : ({ actionId: action.id, skill: action.skill, dice, limitBonus, hits: r.hits, glitch: r.glitch, ts: Date.now() });
    const authorMsg = agentAuthorMsg(ag, actor);
    const labelMsg = { t: 'Assist — {action}', params: { action: { t: action.fr } } };
    mlog(ctx, {
      author: fr(authorMsg), authorI18n: toI18n(authorMsg), msgs: outcomes,
      roll: { ...r, label: fr(labelMsg), labelI18n: toI18n(labelMsg), breakdown: sumParts(pc.parts) + (pc.limit ? ` [${pc.limit}]` : '') },
      matrix: { actionId: action.id, actorId, agent: true, assist: true, outcomes: outcomes.map(fr) },
    });
    sfx(ctx, 'dice');
    return { pendingAssist: persona.pendingAssist, roll: { pool: r.pool, dice: r.dice, hits: r.hits, limit: r.limit, glitch: r.glitch, critGlitch: r.critGlitch }, outcomes: outcomes.map(fr), msgs: outcomes };
  }),

  // { actorId, actionId, targetId?, ... } — the agent performs the action itself (Rating × 2, deck limits, shared OS).
  'matrix/agentAct': any((ctx: ActionContext, p: MatrixActionPayload = {}) => {
    const { actor, persona } = ownPersona(ctx, p.actorId);
    requireOnline(ctx, actor, persona);
    if (!persona.agent || !persona.agent.loaded) ctx.fail('Your agent is not loaded');
    const action: MatrixActionDef | undefined = ACTION_BY_ID[p.actionId as string];
    if (!action) return ctx.fail('Unknown Matrix action');
    if (action.noTest || action.id === 'jackOut') ctx.fail('Your agent cannot take this action for you');
    return performAction(ctx, actor, persona, action, { ...p, assistFromAgent: false, edge: false, useSpec: false }, { agent: true });
  }),

  // { actorId, actionId, targetId?, modifier?, edge?, useSpec?, marks?, assistFromAgent?, fileOp?, command?, threshold?, targetName?, defensePool? (GM) }
  'matrix/action': any((ctx: ActionContext, p: MatrixActionPayload = {}) => {
    const { actor, persona } = ownPersona(ctx, p.actorId);
    const action: MatrixActionDef | undefined = ACTION_BY_ID[p.actionId as string];
    if (!action) return ctx.fail('Unknown Matrix action');
    // Rebooting your own deck also works offline (clears the Overwatch Score and marks).
    if (action.id === 'rebootSelf' && !persona.online) {
      if (persona.bricked) ctx.fail('{name}’s deck is bricked: it must be repaired', { name: actor.name });
    } else requireOnline(ctx, actor, persona);
    return performAction(ctx, actor, persona, action, p);
  }),

  // Owner/GM: { actorId, fileId } — share recovered paydata with the team. A player creates a party note (Notes › groupe,
  // folder « Matrice »); the GM creates a handout revealed to every player (Dossiers). The text is stored in the table language.
  'matrix/shareFile': any((ctx: ActionContext, { actorId, fileId }: ActorPayload & { fileId?: string } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    const f = persona.files.find((x) => x.id === fileId);
    if (!f) ctx.fail('File not found');
    const tr = (key: string, params?: I18nParams) => (ctx.t ? ctx.t(key, params) : formatSource(key, params));
    const head = f.hostName
      ? tr(tk('Recovered by {name} from the host “{host}”.'), { name: actor.name, host: f.hostName })
      : tr(tk('Recovered by {name} in the Matrix.'), { name: actor.name });
    const body = `*${head}*\n\n${f.content || tr(tk('Contents to be described by the GM.'))}`;
    let out: unknown;
    if (ctx.isGM) {
      const handoutId = campaignModule.actions!['campaign/addHandout'].handler(ctx, { title: f.name, body });
      campaignModule.actions!['campaign/revealHandout'].handler(ctx, { handoutId, to: 'all' });
      out = { handoutId };
    } else {
      out = notesModule.actions!['notes/create'].handler(ctx, { scope: 'party', title: f.name, folder: tr(tk('Matrix')), body });
      sfx(ctx, 'notify', 'gm');
    }
    f.shared = true;
    return out;
  }),

  // Owner/GM: end full matrix defense. { actorId, on }
  'matrix/setFullDefense': any((ctx: ActionContext, { actorId, on }: ActorPayload & { on?: boolean } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    persona.fullDefense = !!on;
    return { fullDefense: persona.fullDefense };
  }),

  // ---------------- GM ----------------
  // { name, rating, preset, folder?, ic?: bool (default suite, default true) } → { id }
  'matrix/hostCreate': gm((ctx: ActionContext, p: HostCreatePayload = {}) => {
    const m = slice(ctx.state);
    const rating = clampInt(p.rating, 1, 12, 3);
    const preset = (HOST_PRESETS as Loose)[p.preset as string] ? p.preset : 'shell';
    const id = uid('host');
    const host: Loose = { id, name: str(p.name, 80).trim() || (ctx.t ? ctx.t(tk('Host {n}'), { n: rating }) : formatSource('Host {n}', { n: rating })), rating, ...hostAttributes(rating, preset), alert: 'none', visible: false, folder: str(p.folder, 60) };
    host.ic = p.ic === false ? [] : defaultIcFor(rating).map((type, i) => ({ id: uid('ic'), type, rating, active: i === 0 && type === 'patrol', damage: 0 }));
    m.hosts[id] = normalizeHost(host, id);
    return { id };
  }),

  // { hostId, patch: { name, rating, attack, sleaze, dataProcessing, firewall, alert, visible, notes, description, folder, spider, spiderAlert, ic, files, devices, perceivedBy, spotted } }
  'matrix/hostUpdate': gm((ctx: ActionContext, { hostId, patch }: HostPayload & { patch?: Loose } = {}) => {
    const h = getHost(ctx, hostId);
    if (!isObj(patch)) ctx.fail('Invalid change');
    const wasAlert = h.alert;
    const devKey = (d: HostDevice) => `${deviceWorks(d)}|${d.on !== false}|${d.link ? `${d.link.mapId}:${d.link.kind}:${d.link.targetId}` : ''}`;
    const devBefore = new Map((h.devices || []).map((d) => [d.id, devKey(d)]));
    const keys = ['name', 'rating', ...ASDF, 'alert', 'visible', 'notes', 'description', 'folder', 'spider', 'spiderAlert', 'ic', 'files', 'devices', 'perceivedBy', 'spotted'];
    for (const k of keys) if (patch![k] !== undefined) (h as unknown as Loose)[k] = patch![k];
    normalizeHost(h, h.id);
    // Linked lights / cameras follow a device whose state or link changed (GM toggles « Hors ligne », repairs, links it).
    for (const d of h.devices) if (devBefore.get(d.id) !== devKey(d)) syncDeviceLink(ctx, d);
    if (wasAlert !== h.alert) {
      const inside = Object.values(slice(ctx.state).personas).some((p) => p.online && p.hostId === h.id);
      const msg = h.alert === 'active' ? { t: 'Host {host} goes on alert!', params: { host: h.name } } : { t: 'Host {host} stands down.', params: { host: h.name } };
      mlog(ctx, { author: h.name, gmOnly: !inside, msgs: [msg], matrix: { event: 'alert', hostId: h.id } });
      if (h.alert === 'active') sfx(ctx, 'alarm', inside ? 'all' : 'gm');
    }
    return { host: h };
  }),

  'matrix/hostDelete': gm((ctx: ActionContext, { hostId }: HostPayload = {}) => {
    const m = slice(ctx.state);
    const h = getHost(ctx, hostId);
    delete m.hosts[h.id];
    for (const p of Object.values(m.personas)) {
      if (p.hostId === h.id) p.hostId = null;
      p.marks = (p.marks || []).filter((x) => String(x.targetId).split(':')[1] !== h.id);
      p.marksOnMe = (p.marksOnMe || []).filter((x) => x.sourceId !== `host:${h.id}`);
      if (p.linkLocked?.source === `host:${h.id}`) p.linkLocked = null;
    }
    return { ok: true };
  }),

  // { hostId, type } adds and launches an IC; { hostId, icId } (re)launches an existing one (repaired).
  'matrix/icLaunch': gm((ctx: ActionContext, { hostId, type, icId }: HostPayload & { type?: IcType } = {}) => {
    const h = getHost(ctx, hostId);
    let ic: HostIc | undefined;
    if (icId) {
      ic = h.ic.find((x) => x.id === icId);
      if (!ic) return ctx.fail('IC not found');
    } else {
      if (!(IC_TYPES as Loose)[type as string]) ctx.fail('Unknown IC type');
      ic = { id: uid('ic'), type, rating: h.rating, active: false, damage: 0 } as HostIc;
      h.ic.push(ic);
    }
    activateIc(ctx, h, ic);
    return { ic };
  }),

  // { hostId } — the next IC of the host's suite (not running, not crashed) is launched.
  'matrix/launchNextIc': gm((ctx: ActionContext, { hostId }: HostPayload = {}) => {
    const h = getHost(ctx, hostId);
    const msg = launchNextIc(ctx, h);
    if (!msg) ctx.fail('Every IC of this host is already running (or crashed)');
    return { outcomes: [fr(msg)], msgs: [msg] };
  }),

  // { hostId, icId, actorId?, entryId? } — one IC acts (target picked automatically unless actorId). entryId: its combat
  // entry, whose turn ends afterwards (« Agir et passer » in the tracker).
  'matrix/icTurn': gm((ctx: ActionContext, { hostId, icId, actorId, entryId }: HostPayload & ActorPayload & { entryId?: string } = {}) => {
    const h = getHost(ctx, hostId);
    const ic = h.ic.find((x) => x.id === icId);
    if (!ic) return ctx.fail('IC not found');
    const r = icTakesTurn(ctx, h, ic, actorId ? str(actorId, 60) : null);
    if (entryId) r.advanced = endTurnOf(ctx, str(entryId, 60));
    return r;
  }),

  // { hostId, launch = true } — the whole host acts once: an alerted host launches its next IC, then every running IC
  // takes its action against an automatic target. Outside a fight, one click per Combat Turn.
  'matrix/hostTurn': gm((ctx: ActionContext, { hostId, launch = true }: HostPayload & { launch?: boolean } = {}) => {
    const h = getHost(ctx, hostId);
    const msgs: I18nMessage[] = [];
    if (launch !== false && h.alert === 'active') {
      const l = launchNextIc(ctx, h);
      if (l) msgs.push(l);
    }
    const results: Loose[] = [];
    for (const ic of h.ic.filter((x) => x.active && (IC_TYPES as Loose)[x.type])) {
      if (!ic.active) continue; // crashed meanwhile
      results.push(icTakesTurn(ctx, h, ic, null));
    }
    if (!results.length) msgs.push({ t: 'No IC running in {host}.', params: { host: h.name } });
    return { results, outcomes: msgs.map(fr), msgs };
  }),

  // { hostId } — puts the host's spider (the alert one when the host is on alert) into the fight, without a token.
  'matrix/spawnSpider': gm((ctx: ActionContext, { hostId }: HostPayload = {}) => {
    const h = getHost(ctx, hostId);
    const templateId = h.alert === 'active' ? h.spiderAlert || h.spider : h.spider || h.spiderAlert;
    if (!templateId || !ctx.state.bestiary?.[templateId]) ctx.fail('No spider chosen for this host');
    return combatModule.actions!['bestiary/spawn'].handler(ctx, { templateId, mapId: null, addToCombat: true });
  }),

  // { actorId } — 15 minutes go by: the decker's OS rises by 2D6 (rolled in secret, GM-only log).
  'matrix/osTick': gm((ctx: ActionContext, { actorId }: ActorPayload = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const r = osTick(ctx, actor, persona, 1);
    return { added: r.added, overwatch: persona.overwatch, convergence: r.convergence ? r.convergence.map(fr) : null, convergenceMsgs: r.convergence };
  }),

  // { hostId, icId, patch: { active, damage, rating, detected } }
  'matrix/icUpdate': gm((ctx: ActionContext, { hostId, icId, patch }: HostPayload & { patch?: Loose } = {}) => {
    const h = getHost(ctx, hostId);
    const idx = h.ic.findIndex((x) => x.id === icId);
    if (idx < 0) ctx.fail('IC not found');
    const next = cleanIc({ ...h.ic[idx], ...(isObj(patch) ? patch : {}), id: icId, type: h.ic[idx].type }, h);
    h.ic[idx] = next as HostIc;
    return { ic: next };
  }),

  'matrix/icRemove': gm((ctx: ActionContext, { hostId, icId }: HostPayload = {}) => {
    const h = getHost(ctx, hostId);
    h.ic = h.ic.filter((x) => x.id !== icId);
    return { ok: true };
  }),

  // { hostId, icId, actorId } — the IC attacks a persona inside the host.
  'matrix/icAct': gm((ctx: ActionContext, { hostId, icId, actorId }: HostPayload & ActorPayload = {}) => {
    const h = getHost(ctx, hostId);
    const ic = h.ic.find((x) => x.id === icId);
    if (!ic) return ctx.fail('IC not found');
    if (!ic.active) ctx.fail('This IC is not launched');
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    if (!persona.online || persona.hostId !== h.id) ctx.fail('{name} is not in this host', { name: actor.name });
    return icAttack(ctx, h, ic, actor, persona);
  }),

  // { actorId, value?, delta? }
  'matrix/setOverwatch': gm((ctx: ActionContext, { actorId, value, delta }: ActorPayload & { value?: number; delta?: number } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const next = delta !== undefined ? (persona.overwatch as number) + clampInt(delta, -40, 40, 0) : clampInt(value, 0, OS_MAX, persona.overwatch as number);
    const before = persona.overwatch;
    persona.overwatch = Math.max(0, Math.min(OS_MAX, next));
    if (!persona.overwatch) persona.osClock = null;
    else if (!before || !persona.osClock) persona.osClock = ctx.now || Date.now();
    let convergence: I18nMessage[] | null = null;
    if (persona.overwatch >= OS_MAX && persona.online && !persona.hostConverged) convergence = converge(ctx, actor, persona);
    return { overwatch: persona.overwatch, convergence: convergence ? convergence.map(fr) : null, convergenceMsgs: convergence };
  }),

  'matrix/converge': gm((ctx: ActionContext, { actorId }: ActorPayload = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const msgs = converge(ctx, actor, persona);
    return { outcomes: msgs.map(fr), msgs };
  }),

  'matrix/resetPersona': gm((ctx: ActionContext, { actorId }: ActorPayload = {}) => {
    const actor = getActor(ctx, actorId);
    const m = slice(ctx.state);
    delete m.personas[actorId as ActorId];
    if (actor.matrix) ensurePersona(ctx.state, actor);
    return { ok: true };
  }),

  // { actorId, patch: { matrixDamage, noise, bricked, traced, linkLocked: null, penalties: {}, programSlots, fullDefense, hostId, osKnown, agent: { damage, loaded } , files } }
  'matrix/setPersona': gm((ctx: ActionContext, { actorId, patch }: ActorPayload & { patch?: Loose } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    if (!isObj(patch)) ctx.fail('Invalid change');
    const mon = matrixMonitor(actor.matrix!.rating);
    if (patch!.matrixDamage !== undefined) persona.matrixDamage = clampInt(patch.matrixDamage, 0, mon, 0);
    if (patch.noise !== undefined) persona.noise = clampInt(patch.noise, 0, 30, 0);
    if (patch.bricked !== undefined) persona.bricked = !!patch.bricked;
    if (patch.traced !== undefined) persona.traced = !!patch.traced;
    if (patch.fullDefense !== undefined) persona.fullDefense = !!patch.fullDefense;
    if (patch.linkLocked === null) persona.linkLocked = null;
    if (isObj(patch.penalties)) persona.penalties = Object.fromEntries((ASDF as AsdfKey[]).map((k) => [k, clampInt(patch.penalties[k], 0, 12, 0)] as const).filter(([, v]) => v));
    if (patch.programSlots !== undefined) {
      if (patch.programSlots === null) {
        persona.slotsOverride = false;
        persona.programSlots = computeSlots(actor);
      } else {
        persona.slotsOverride = true;
        persona.programSlots = clampInt(patch.programSlots, 1, 20, 4);
      }
    }
    if (patch.hostId !== undefined) {
      if (patch.hostId && !slice(ctx.state).hosts[patch.hostId]) ctx.fail('Host not found');
      persona.hostId = patch.hostId || null;
    }
    if (patch.osKnown !== undefined) persona.osKnown = patch.osKnown === null ? null : clampInt(patch.osKnown, 0, OS_MAX, 0);
    if (patch.osClock !== undefined) persona.osClock = patch.osClock === null ? null : clampInt(patch.osClock, 0, 9e15, Date.now());
    if (Array.isArray(patch.files)) persona.files = patch.files.filter(isObj).slice(0, 200).map((f: Loose) => ({ ...f, id: str(f.id, 40) || uid('pay'), name: str(f.name, 80), content: str(f.content, 4000) }) as PersonaFile);
    if (isObj(patch.agent) && persona.agent) {
      if (patch.agent.damage !== undefined) persona.agent.damage = clampInt(patch.agent.damage, 0, matrixMonitor(persona.agent.rating), 0);
      if (patch.agent.loaded !== undefined) persona.agent.loaded = !!patch.agent.loaded;
    }
    if (patch.agent === null) persona.agent = null;
    if (persona.matrixDamage < mon && patch.matrixDamage !== undefined && patch.bricked === undefined && persona.bricked) persona.bricked = false;
    return { persona };
  }),

  // { actorId, targetId, name?, count } — set the marks a persona holds (0 removes).
  'matrix/setMarks': gm((ctx: ActionContext, { actorId, targetId, name, count }: ActorPayload & { targetId?: string; name?: string; count?: number } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const key = str(targetId, 200);
    if (!key) ctx.fail('Invalid target');
    const n = clampInt(count, 0, MAX_MARKS, 0);
    persona.marks = persona.marks.filter((m) => m.targetId !== key);
    if (n) persona.marks.push({ targetId: key, name: str(name, 80) || key, count: n });
    return { marks: persona.marks };
  }),

  // { actorId, sourceId, name?, count } — marks other icons have on the persona.
  'matrix/setMarkOnMe': gm((ctx: ActionContext, { actorId, sourceId, name, count }: ActorPayload & { sourceId?: string; name?: string; count?: number } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} has no Matrix device', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const key = str(sourceId, 200);
    if (!key) ctx.fail('Invalid source');
    const n = clampInt(count, 0, MAX_MARKS, 0);
    persona.marksOnMe = persona.marksOnMe.filter((m) => m.sourceId !== key);
    if (n) persona.marksOnMe.push({ sourceId: key, name: str(name, 80) || key, count: n });
    return { marksOnMe: persona.marksOnMe };
  }),

  // { hideOverwatch?, osTimer?, autoLaunchIc? }
  'matrix/settings': gm((ctx: ActionContext, p: Partial<MatrixState['settings']> = {}) => {
    const m = slice(ctx.state);
    if (p.hideOverwatch !== undefined) m.settings.hideOverwatch = !!p.hideOverwatch;
    if (p.osTimer !== undefined) {
      m.settings.osTimer = !!p.osTimer;
      // Turning the timer on starts the clock now (no burst of ticks for the time it was off).
      if (m.settings.osTimer) for (const per of Object.values(m.personas)) if ((per.overwatch as number) > 0) per.osClock = ctx.now || Date.now();
    }
    if (p.autoLaunchIc !== undefined) m.settings.autoLaunchIc = !!p.autoLaunchIc;
    return { settings: m.settings };
  }),
};

if (process.env.SR_MATRIX_TEST === '1') {
  // Test hook only: load the dice ('actor' wins, 'opposition' wins, 'glitch', or null = random).
  actions['matrix/testDice'] = gm((ctx: ActionContext, { mode }: { mode?: string } = {}) => {
    testDice = ['actor', 'opposition', 'glitch'].includes(mode as string) ? (mode as string) : null;
    return { mode: testDice };
  });
}

const mod: ServerModule = {
  name: 'matrix',

  init(state, { readSeed }) {
    const m = slice(state);
    const seed = readSeed<{ hosts?: Host[] } | null>('matrix.json', null);
    if (seed && Array.isArray(seed.hosts)) {
      for (const h of seed.hosts) if (h && h.id && !m.hosts[h.id]) m.hosts[h.id] = deepClone(h);
    }
    for (const [id, h] of Object.entries(m.hosts)) {
      if (!isObj(h)) delete m.hosts[id];
      else normalizeHost(h, id);
    }
    for (const [id, p] of Object.entries(m.personas)) {
      const actor = state.actors?.[id];
      if (!isObj(p) || !actor) delete m.personas[id];
      else {
        p.actorId = id;
        normalizePersona(p, actor);
      }
    }
  },

  actions,

  filter(view, user, full) {
    const m = view.matrix;
    if (!m) return;
    const own = user.characterIds || [];
    const personas: Record<ActorId, Persona> = {};
    for (const id of own) {
      const p = m.personas?.[id] as Persona | undefined;
      if (!p) continue;
      if (m.settings?.hideOverwatch && !loadedProgramIds(p).has('babyMonitor')) {
        p.overwatch = p.osKnown ?? null;
        p.overwatchHidden = true;
      }
      personas[id] = p;
    }
    m.personas = personas;
    const evaluate = Object.values(personas).some((p) => loadedProgramIds(p).has('evaluate'));
    const hosts: Record<string, PlayerHostView> = {};
    for (const h of Object.values(full.matrix?.hosts || {})) {
      if (!canSeeHost(full, user, h)) continue;
      const inside = Object.values(personas).some((p) => p.online && p.hostId === h.id);
      const perceived = perceivedBy(h, own);
      const out: Loose = { id: h.id, name: h.name, alert: h.alert, visible: !!h.visible, inside, perceived, description: h.description || '', spotted: (h.spotted || []).some((id) => own.includes(id)) };
      if (perceived) {
        out.rating = h.rating;
        for (const k of ASDF as AsdfKey[]) out[k] = h[k];
      }
      if (inside || perceived) {
        out.ic = (h.ic || []).filter((ic) => ic.active).map((ic) => (perceived || ic.detected ? { id: ic.id, type: ic.type, rating: ic.rating, damage: ic.damage, detected: true } : { id: ic.id, type: ic.type, detected: false }));
      } else out.ic = [];
      if (perceived) {
        out.files = (h.files || []).map((f) => ({ id: f.id, name: f.name, protected: f.protected, bomb: f.bomb, mine: !!f.bombBy && own.includes(f.bombBy), ...(evaluate && f.value !== null ? { value: f.value } : {}) }));
        out.devices = (h.devices || []).map((d) => ({
          id: d.id, name: d.name, rating: d.rating, offline: d.offline, formatted: d.formatted, bricked: d.bricked, damage: d.damage,
          ...(d.link && linkedObject(full, d) ? { link: { kind: d.link.kind, state: linkState(full, d) } } : {}),
        }));
      } else {
        out.files = [];
        out.devices = [];
      }
      hosts[h.id] = out as PlayerHostView;
    }
    m.hosts = hosts;
    for (const e of view.log || []) if (e.kind === 'matrix' && e.matrix?.gm) delete e.matrix.gm;
  },
};

export default mod;
