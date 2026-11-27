// Matrix module: deckers' personas (connection mode, ASDF configuration, programs, marks, Overwatch Score,
// matrix damage), their agents (teamwork assist or autonomous action), hosts and IC run by the GM.
// State slice: state.matrix (see ARCHITECTURE.md « Matrix »). Rules data: shared/matrix.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attr, derive, rollDice } from '../../shared/sr5.js';
import {
  ACTION_BY_ID, ASDF, ASDF_LABELS, MODE_LABELS, MODES, IC_TYPES, MAX_MARKS, OS_MAX, CONVERGENCE_DV, HOST_PRESETS,
  PROGRAM_BY_ID, isIllegal, isCyberdeck, isPermutation, identityAsdf, deckStats, actionPool, hostDefensePool,
  personaDefensePool, programId, programSlots, programSum, availablePrograms, detectAgents, matrixMonitor,
  matrixInitiative, dumpshock, hostAttributes, defaultIcFor, icAttackPool, skillRating, loadedProgramIds,
  OS_TICK_MS, DEVICE_LINK_KINDS, DEVICE_CMD_LABELS, deviceWorks,
} from '../../shared/matrix.js';
import { uid, deepClone, slug } from '../../shared/util.js';
import { cleanConditions } from '../../shared/modifiers.js';
import { actorModifiers, deriveFull } from '../lib/modifiers.js';
import { formatFr } from '../lib/i18n.js';
import combatModule, { combatHooks, upsertVirtualEntry, setVirtualOut, endTurnOf, isVirtual } from './30-combat.js';
import { refreshFog, findAnyDoor } from './20-maps.js';
import notesModule from './75-notes.js';
import campaignModule from './70-campaign.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const clampInt = (v, lo, hi, d = lo) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// i18n: every sentence shown to the table is a message { t: 'French key {x}', params } (see ARCHITECTURE.md « i18n »).
// Returned results keep `outcomes` (French strings) and add `msgs` (messages); log entries carry `i18n` + French `text`.
// ---------------------------------------------------------------------------
const tk = (s) => s;
/** French text of a message (or a plain string). */
const fr = (m) => (typeof m === 'string' ? m : m ? formatFr(m.t, m.params) : '');
/** Counted noun as a nested message: `zero` is the key used for 0 (French singular, English plural). */
const count = (n, one, other, zero = other) => ({ t: n === 1 ? one : n === 0 ? zero : other, params: { n } });
const boxesM = (n) => count(n, tk('{n} case'), tk('{n} cases'), tk('zero::{n} case'));
const hitsM = (n) => count(n, tk('{n} succès'), tk('n::{n} succès'));
const netM = (n) => count(n, tk('{n} succès net'), tk('{n} succès nets'), tk('zero::{n} succès net'));
/** Several messages as one (a log entry has a single i18n key): '{a} {b}' chain. */
function joinMsgs(list) {
  if (!list.length) return null;
  if (list.length === 1) return typeof list[0] === 'string' ? { t: '{a}', params: { a: list[0] } } : list[0];
  return { t: '{a} {b}', params: { a: list[0], b: joinMsgs(list.slice(1)) } };
}
/** Message → log-style { key, params }. */
const toI18n = (m) => (m && typeof m === 'object' ? { key: m.t, ...(m.params ? { params: m.params } : {}) } : null);
/** « IC Tueuse (Hôte) » as a message. */
const icNameMsg = (type, hostName) => ({ t: '{ic} ({host})', params: { ic: { t: IC_TYPES[type]?.fr || 'IC' }, host: hostName || '' } });
/** Name of the IC holding a link-lock (older saves only have the French name). */
const linkLockMsg = (ll) => (ll?.icType ? icNameMsg(ll.icType, ll.hostName) : ll?.name || '');
/** Display name of a mark entry (nameI18n when the name was generated, else the stored name). */
const markNameMsg = (m) => m?.nameI18n || m?.name || '';
const agentAuthorMsg = (ag, actor) => ({ t: '{agent} (agent de {name})', params: { agent: ag.name, name: actor.name } });

// ---------------------------------------------------------------------------
// Catalog: program slots of known cyberdecks (data/catalog/gear.json → stats.programs)
// ---------------------------------------------------------------------------
let deckCatalog = null;
function deckCatalogSlots(deviceName) {
  if (!deckCatalog) {
    deckCatalog = new Map();
    try {
      const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'gear.json'), 'utf8'));
      for (const it of list) {
        if (!it?.stats || !Number(it.stats.programs)) continue;
        for (const n of [it.name, it.nameFr]) if (n) deckCatalog.set(String(n).toLowerCase(), Number(it.stats.programs));
      }
    } catch (err) {
      console.error('[matrix] gear catalog unreadable:', err.message);
    }
  }
  return deckCatalog.get(String(deviceName || '').toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// Dice (test hook: SR_MATRIX_TEST=1 enables 'matrix/testDice' to load the dice)
// ---------------------------------------------------------------------------
let testDice = null; // null | 'actor' (decker side wins) | 'opposition' | 'glitch' (decker side all 1s)
const face = (f) => () => (f - 0.5) / 6;
/** side: 'actor' = the decker / her agent; 'opposition' = hosts, IC, GOD, other personas. */
function roll(pool, opts = {}, side = 'actor') {
  let rng;
  if (testDice) {
    const actorFace = testDice === 'actor' ? 5 : testDice === 'glitch' ? 1 : 2;
    const oppFace = testDice === 'opposition' ? 5 : 2;
    rng = face(side === 'actor' ? actorFace : oppFace);
  }
  return rollDice(pool, { ...opts, rng });
}
const sumParts = (parts) => parts.map((p) => `${p.label} ${p.value >= 0 ? '+' : '−'}${Math.abs(p.value)}`).join(' · ');

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
function slice(state) {
  state.matrix ||= {};
  const m = state.matrix;
  if (!isObj(m.personas)) m.personas = {};
  if (!isObj(m.hosts)) m.hosts = {};
  if (!isObj(m.settings)) m.settings = {};
  m.settings.hideOverwatch = !!m.settings.hideOverwatch;
  // osTimer: +2D6 OS every 15 real minutes online (SR5 p. 232), applied at the next Matrix action. autoLaunchIc: during a
  // fight, an alerted host with an intruder launches its next IC at each new Combat Turn (SR5 p. 248).
  m.settings.osTimer = !!m.settings.osTimer;
  m.settings.autoLaunchIc = m.settings.autoLaunchIc !== false;
  return m;
}

function computeSlots(actor) {
  return deckCatalogSlots(actor?.matrix?.device) || 4;
}

function blankPersona(actor) {
  return {
    actorId: actor.id, online: false, mode: 'cold', asdf: identityAsdf(), loadedPrograms: [],
    marks: [], marksOnMe: [], overwatch: 0, osKnown: null, matrixDamage: 0, noise: 0, hostId: null,
    penalties: {}, linkLocked: null, fullDefense: false, bricked: false, traced: false, files: [],
    programSlots: computeSlots(actor), slotsOverride: false, deviceName: actor.matrix?.device || '',
    agent: null, pendingAssist: null,
    osClock: null, // start of the current 15-minute Overwatch period (set when the OS starts being tallied)
    hostConverged: null, // hostId: convergence happened inside this host (leaving it brings the grid's demiGOD)
  };
}

/** Default agent from what the actor owns (highest rating), or null. */
function defaultAgent(actor) {
  const found = detectAgents(actor);
  if (!found.length) return null;
  const best = found.reduce((a, b) => (b.rating > a.rating ? b : a));
  return { rating: best.rating, name: `Agent ${best.rating}`, loaded: false, damage: 0, source: best.source };
}

/** Normalize a stored persona (tolerates old/partial data). */
function normalizePersona(p, actor) {
  const b = blankPersona(actor || { id: p.actorId, matrix: {} });
  for (const k of Object.keys(b)) if (p[k] === undefined) p[k] = b[k];
  if (!MODES.includes(p.mode)) p.mode = 'cold';
  if (!isPermutation(p.asdf)) p.asdf = identityAsdf();
  for (const k of ['loadedPrograms', 'marks', 'marksOnMe', 'files']) if (!Array.isArray(p[k])) p[k] = [];
  if (!isObj(p.penalties)) p.penalties = {};
  p.overwatch = clampInt(p.overwatch, 0, OS_MAX, 0);
  p.matrixDamage = clampInt(p.matrixDamage, 0, 99, 0);
  p.noise = clampInt(p.noise, 0, 30, 0);
  p.programSlots = clampInt(p.programSlots, 1, 20, 4);
  return p;
}

function getActor(ctx, actorId) {
  const a = ctx.state.actors?.[actorId];
  if (!a) ctx.fail('Personnage introuvable');
  return a;
}

/** Persona of an actor (created on first use). Keeps it in sync with the sheet (device, programs). */
function ensurePersona(state, actor) {
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
    const avail = new Set(availablePrograms(actor).map((x) => x.name.toLowerCase()));
    p.loadedPrograms = p.loadedPrograms.filter((n) => avail.has(String(n).toLowerCase()) && programId(n) !== 'agent');
    if (!isCyberdeck(actor)) p.asdf = identityAsdf();
  }
  if (p.agent === null && actor.matrix) p.agent = defaultAgent(actor);
  return p;
}

/** Owner (or GM) + actor with a device. */
function ownPersona(ctx, actorId) {
  const actor = getActor(ctx, actorId);
  if (!ctx.owns(actorId)) ctx.fail('Ce personnage ne t’appartient pas');
  if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel (commlink ou cyberdeck)', { name: actor.name });
  return { actor, persona: ensurePersona(ctx.state, actor) };
}

function requireOnline(ctx, actor, persona) {
  if (persona.bricked) ctx.fail('Le deck de {name} est briqué : il doit être réparé', { name: actor.name });
  if (!persona.online) ctx.fail('{name} n’est pas connecté(e) à la Matrice', { name: actor.name });
}

function getHost(ctx, hostId) {
  const h = slice(ctx.state).hosts[hostId];
  if (!h) ctx.fail('Hôte introuvable');
  return h;
}

function sfx(ctx, id, target = 'all') {
  ctx.emitTo(target, 'sfx', { id });
}

/** User ids controlling an actor (for transient events). */
function ownersOf(state, actorId) {
  return Object.values(state.users || {}).filter((u) => (u.characterIds || []).includes(actorId)).map((u) => u.id);
}

/** Matrix log entry. msgs = messages (French `text` + translatable `i18n` are built from them). */
function mlog(ctx, { msgs, ...entry }) {
  const e = { kind: 'matrix', userId: ctx.user.id, ...entry };
  if (msgs) {
    e.text = msgs.map(fr).join(' ');
    const i = toI18n(joinMsgs(msgs));
    if (i) e.i18n = i;
  }
  return ctx.log(e);
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
function marksOnKey(persona, key) {
  return persona.marks.find((m) => m.targetId === key)?.count || 0;
}
/** Marks the persona has on a target. Marks on a host also count on its IC, devices and files. */
function effectiveMarks(persona, target) {
  if (!target || !target.key) return 0;
  let n = marksOnKey(persona, target.key);
  if (target.host && target.kind !== 'host') n = Math.max(n, marksOnKey(persona, `host:${target.host.id}`));
  return n;
}
/** msg (optional): the name as a message when it is generated text (« fichier « X » »), stored as nameI18n. */
function setMarkName(e, name, msg) {
  e.name = name || e.name;
  if (msg && typeof msg === 'object') e.nameI18n = msg;
  else if (name) delete e.nameI18n;
}
function addMark(persona, key, name, n, msg) {
  let e = persona.marks.find((m) => m.targetId === key);
  if (!e) persona.marks.push((e = { targetId: key, name, count: 0 }));
  setMarkName(e, name, msg);
  e.count = Math.min(MAX_MARKS, e.count + n);
  return e.count;
}
function addMarkOnMe(persona, sourceId, name, n = 1, msg) {
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
function applyActorDamage(actor, n, type) {
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
function applyDumpshock(ctx, actor, persona, mode) {
  const ds = dumpshock(mode);
  if (!ds) return null;
  const fw = deckStats(actor, persona).eff.firewall;
  const res = roll(attr(actor, 'WIL') + fw, {}, 'actor');
  const boxes = Math.max(0, ds.dv - res.hits);
  applyActorDamage(actor, boxes, ds.type);
  const params = { boxes: boxesM(boxes), dv: ds.dv, hits: hitsM(res.hits) };
  if (!boxes) return { t: 'Choc d’éjection entièrement résisté ({hits} contre VD {dv}).', params };
  return ds.type === 'P'
    ? { t: 'Choc d’éjection : {boxes} de dommages physiques (VD {dv}, {hits} en résistance).', params }
    : { t: 'Choc d’éjection : {boxes} de dommages étourdissants (VD {dv}, {hits} en résistance).', params };
}

/** Leave the Matrix. dumped = forced (dumpshock in VR). Returns messages. */
function goOffline(ctx, actor, persona, { dumped }) {
  const out = [];
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
function rebootDeck(ctx, actor, persona) {
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
function damageDeck(ctx, actor, persona, boxes) {
  const out = [];
  if (boxes <= 0) return out;
  const extra = loadedProgramIds(persona).has('virtualMachine') ? 1 : 0;
  const n = boxes + extra;
  const mon = matrixMonitor(actor.matrix?.rating);
  persona.matrixDamage = Math.min(mon, persona.matrixDamage + n);
  out.push({ t: 'Le deck de {name} subit {boxes} de dommages matriciels ({dmg}/{mon}).', params: { name: actor.name, boxes: boxesM(n), dmg: persona.matrixDamage, mon } });
  if (persona.matrixDamage >= mon && !persona.bricked) {
    persona.bricked = true;
    out.push({ t: 'Deck briqué ! {name} est éjecté(e) de la Matrice.', params: { name: actor.name } });
    out.push(...goOffline(ctx, actor, persona, { dumped: true }));
    sfx(ctx, 'matrix-glitch');
  }
  return out;
}

/** Matrix damage on the agent (its own monitor 8 + ceil(Rating/2)); crashes it when full. */
function damageAgent(actor, persona, boxes) {
  const ag = persona.agent;
  if (!ag || boxes <= 0) return [];
  const mon = matrixMonitor(ag.rating);
  ag.damage = Math.min(mon, (ag.damage || 0) + boxes);
  const out = [{ t: '{agent} subit {boxes} de dommages matriciels ({dmg}/{mon}).', params: { agent: ag.name, boxes: boxesM(boxes), dmg: ag.damage, mon } }];
  if (ag.damage >= mon) {
    ag.loaded = false;
    out.push({ t: '{agent} plante et se décharge du deck.', params: { agent: ag.name } });
  }
  return out;
}

/**
 * Convergence (SR5 p. 232 and p. 247). On the grid: 12 DV Matrix damage resisted with Device Rating + Firewall, forced
 * reboot (dumpshock in VR), marks lost, physical location revealed. Inside a host: the host puts 3 marks on the decker,
 * goes on alert and deploys IC; the decker stays online, and leaving the host brings the grid convergence at once.
 * grid = true forces the grid version (leaving the host after a host convergence).
 */
function converge(ctx, actor, persona, { grid = false } = {}) {
  const host = !grid && persona.online && persona.hostId ? slice(ctx.state).hosts[persona.hostId] : null;
  if (host) {
    const out = [{ t: 'CONVERGENCE dans l’hôte {host} ! Il pose 3 marques sur {name} et déploie ses IC.', params: { host: host.name, name: actor.name } }];
    persona.hostConverged = host.id;
    addMarkOnMe(persona, `host:${host.id}`, host.name, MAX_MARKS);
    const s = setAlert(ctx, host, { t: 'convergence' });
    if (s) out.push(s);
    const l = launchNextIc(ctx, host);
    if (l) out.push(l);
    out.push({ t: 'Sortir de l’hôte déclenchera aussitôt la convergence du GOD.' });
    persona.convergedAt = Date.now();
    mlog(ctx, { author: 'GOD', msgs: out, matrix: { event: 'convergence', actorId: actor.id, hostId: host.id } });
    sfx(ctx, 'alarm');
    sfx(ctx, 'matrix-glitch');
    return out;
  }
  const out = [{ t: 'CONVERGENCE ! Le GOD s’abat sur {name}.', params: { name: actor.name } }];
  const ds = deckStats(actor, persona);
  const res = roll(ds.deviceRating + ds.eff.firewall + programSum(persona, 'resistMatrix'), {}, 'actor');
  const boxes = Math.max(0, CONVERGENCE_DV - res.hits);
  out.push({ t: 'VD {dv} : {hits} en résistance.', params: { dv: CONVERGENCE_DV, hits: hitsM(res.hits) } });
  if (boxes) out.push(...damageDeck(ctx, actor, persona, boxes));
  out.push({ t: 'Deck redémarré de force : toutes les marques sont perdues et la position physique est transmise aux autorités et au propriétaire de la grille.' });
  out.push(...rebootDeck(ctx, actor, persona));
  persona.traced = true;
  persona.convergedAt = Date.now();
  mlog(ctx, { author: 'GOD', msgs: out, matrix: { event: 'convergence', actorId: actor.id } });
  sfx(ctx, 'alarm');
  sfx(ctx, 'matrix-glitch');
  return out;
}

/** reason = message (why the alert went off, for the GM-only spider reminder). Returns a message or null. */
function setAlert(ctx, host, reason) {
  if (host.alert === 'active') return null;
  host.alert = 'active';
  const s = { t: 'L’hôte {host} passe en alerte !', params: { host: host.name } };
  if (host.spiderAlert || host.spider) {
    const tpl = ctx.state.bestiary?.[host.spiderAlert || host.spider];
    mlog(ctx, {
      author: host.name, gmOnly: true,
      msgs: [tpl
        ? { t: 'Alerte ({reason}) : l’araignée passe à « {spider} » et l’hôte peut lancer ses IC.', params: { reason, spider: tpl.name } }
        : { t: 'Alerte ({reason}) : pensez à l’araignée de garde et l’hôte peut lancer ses IC.', params: { reason } }],
    });
  }
  sfx(ctx, 'alarm');
  return s;
}

/** Personas online inside a host. */
function intrudersOf(state, host) {
  return Object.values(slice(state).personas).filter((p) => p.online && p.hostId === host.id && state.actors?.[p.actorId]?.matrix);
}

/** Launch (or relaunch) an IC of the host: logged (public when someone is inside), added to a running fight. */
function activateIc(ctx, host, ic) {
  ic.active = true;
  ic.crashed = false;
  ic.damage = 0;
  const inside = intrudersOf(ctx.state, host);
  const msg = { t: '{host} lance : {ic}.', params: { host: host.name, ic: { t: IC_TYPES[ic.type].fr } } };
  mlog(ctx, { author: host.name, gmOnly: !inside.length, msgs: [msg], matrix: { event: 'icLaunch', hostId: host.id, icType: ic.type } });
  if (inside.length) sfx(ctx, 'matrix-glitch', 'all');
  return msg;
}

/** SR5 p. 248: an alerted host launches one IC per Combat Turn — the next one of its suite not yet running. Message or null. */
function launchNextIc(ctx, host) {
  const ic = (host.ic || []).find((x) => !x.active && !x.crashed && IC_TYPES[x.type]);
  return ic ? activateIc(ctx, host, ic) : null;
}

// ---------------------------------------------------------------------------
// Overwatch over time (SR5 p. 232): +2D6 every 15 minutes after the first tally
// ---------------------------------------------------------------------------
/** Add to the OS; the first points start the 15-minute clock. */
function addOverwatch(ctx, persona, n) {
  if (!(n > 0)) return;
  if (!persona.overwatch || !persona.osClock) persona.osClock = ctx.now || Date.now();
  persona.overwatch = Math.min(OS_MAX, persona.overwatch + n);
}
const roll2d6 = () => 2 + Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6);

/** One or more 15-minute ticks on a persona (GM only log). Returns { added, msgs }. */
function osTick(ctx, actor, persona, ticks = 1) {
  let added = 0;
  for (let i = 0; i < ticks; i++) added += roll2d6();
  const before = persona.overwatch;
  addOverwatch(ctx, persona, added);
  const params = { name: actor.name, n: added, os: persona.overwatch, ticks };
  mlog(ctx, { author: 'GOD', gmOnly: true, msgs: [ticks === 1 ? { t: 'Le temps passe : SO de {name} +{n} (2D6) → {os}.', params } : { t: 'Le temps passe ({ticks} × 15 min) : SO de {name} +{n} → {os}.', params }], matrix: { event: 'osTick', actorId: actor.id } });
  let convergence = null;
  if (before < OS_MAX && persona.overwatch >= OS_MAX && persona.online && !persona.hostConverged) convergence = converge(ctx, actor, persona);
  return { added, convergence };
}

/** Automatic timer (setting osTimer): applied lazily at the start of every Matrix action. */
function tickOverwatch(ctx) {
  const m = slice(ctx.state);
  if (!m.settings.osTimer) return;
  const now = ctx.now || Date.now();
  for (const p of Object.values(m.personas)) {
    if (!p.online || !(p.overwatch > 0) || !p.osClock) continue;
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
function linkedObject(state, device) {
  const l = device?.link;
  if (!l || !DEVICE_LINK_KINDS[l.kind]) return null;
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
function linkState(state, device) {
  const o = linkedObject(state, device);
  if (!o) return null;
  if (o.kind === 'door') return o.door.state;
  if (o.kind === 'light') return o.light.on ? 'on' : 'off';
  return o.region.cams || 'on';
}

/** Lights and cameras follow the device: on only while it works and was not switched off. Doors keep their state. */
function syncDeviceLink(ctx, device) {
  const o = linkedObject(ctx.state, device);
  if (!o || o.kind === 'door') return;
  const on = deviceWorks(device) && device.on !== false;
  if (o.kind === 'light') o.light.on = on;
  else o.region.cams = on ? 'on' : 'off';
  refreshFog(ctx.state, o.map);
}

/** Apply a command (DEVICE_CMD_LABELS) to the linked map object. Returns a message or null. */
function applyDeviceCmd(ctx, device, cmd) {
  const o = linkedObject(ctx.state, device);
  if (!o || !DEVICE_CMD_LABELS[o.kind]?.[cmd]) return null;
  if (o.kind === 'door') {
    const before = o.door.state;
    o.door.state = cmd === 'open' ? 'open' : cmd === 'lock' ? 'locked' : 'closed';
    if (before !== o.door.state) sfx(ctx, o.door.state === 'open' ? 'door-open' : before === 'open' ? 'door-close' : 'door-locked');
  } else {
    device.on = cmd === 'on';
    syncDeviceLink(ctx, device);
  }
  refreshFog(ctx.state, o.map);
  return { t: 'Sur la carte : {device} → {cmd}.', params: { device: device.name, cmd: { t: DEVICE_CMD_LABELS[o.kind][cmd] } } };
}

// ---------------------------------------------------------------------------
// Combat tracker sync: IC of a host with a decker in the fight, loaded agents of deckers in the fight
// ---------------------------------------------------------------------------
const icEntryKey = (hostId, icId) => `ic:${hostId}:${icId}`;
const agentEntryKey = (actorId) => `agent:${actorId}`;

function syncMatrixCombat(ctx) {
  const c = ctx.state.combat;
  if (!c?.active) return;
  const m = slice(ctx.state);
  const fighting = new Set(c.entries.filter((e) => !isVirtual(e) && !e.out && e.actorId).map((e) => e.actorId));
  const wantIc = new Map();
  const wantAgent = new Map();
  for (const p of Object.values(m.personas)) {
    const actor = ctx.state.actors?.[p.actorId];
    if (!actor?.matrix || !p.online || !fighting.has(p.actorId)) continue;
    // The decker's own entry follows the connection mode (next initiative roll).
    const own = c.entries.find((e) => e.actorId === p.actorId && !isVirtual(e));
    const mode = p.mode === 'ar' ? 'physical' : p.mode;
    if (own && own.mode !== mode && (own.mode === 'physical' || own.mode === 'ar' || own.mode === 'cold' || own.mode === 'hot')) own.mode = mode;
    if (p.agent?.loaded) wantAgent.set(agentEntryKey(p.actorId), { p, actor });
    const host = p.hostId ? m.hosts[p.hostId] : null;
    if (host) for (const ic of host.ic || []) if (ic.active && IC_TYPES[ic.type]) wantIc.set(icEntryKey(host.id, ic.id), { host, ic });
  }
  const gone = c.entries.filter((e) => isVirtual(e) && !e.out && !wantIc.has(e.matrixKey) && !wantAgent.has(e.matrixKey)).map((e) => e.matrixKey);
  for (const key of gone) setVirtualOut(ctx, key);
  for (const [key, { host, ic }] of wantIc) {
    const nameI18n = icNameMsg(ic.type, host.name);
    upsertVirtualEntry(ctx, { kind: 'ic', key, name: fr(nameI18n), nameI18n, hostId: host.id, icId: ic.id, disposition: 'hostile' });
  }
  for (const [key, { p, actor }] of wantAgent) {
    const nameI18n = agentAuthorMsg(p.agent, actor);
    upsertVirtualEntry(ctx, { kind: 'agent', key, name: fr(nameI18n), nameI18n, ownerId: actor.id, disposition: 'pc' });
  }
}

// New Combat Turn: each alerted host with an intruder in the fight launches its next IC (setting autoLaunchIc).
combatHooks.push((ctx, c, event) => {
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
function canSeeHost(state, user, host) {
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
const perceivedBy = (host, actorIds) => (host.perceivedBy || []).some((id) => actorIds.includes(id));

/**
 * Resolve p.targetId into { kind, key, name, nameMsg, host?, ic?, device?, file?, actor?, persona?, source? }.
 * name = French display (stored on marks), nameMsg = the same as a message param (string or { t, params }).
 * Formats: host:<id> · ic:<host>:<id> · device:<host>:<id> · file:<host>:<id> · persona:<actorId> · manual · mark:<sourceId>
 */
function resolveTarget(ctx, persona, action, p) {
  const raw = str(p.targetId, 200);
  const allow = action.targets || ['none'];
  if (!raw || raw === 'none') {
    if (allow.includes('none')) return { kind: 'none', key: null, name: '', nameMsg: '' };
    ctx.fail('Choisis une cible pour cette action');
  }
  const [kind, a, b] = raw.split(':');
  const t = { kind };
  const own = ctx.isGM ? null : [persona.actorId];
  if (kind === 'markOnMe' || kind === 'mark') {
    t.kind = 'markOnMe';
    const sourceId = raw.slice(raw.indexOf(':') + 1);
    const e = persona.marksOnMe.find((m) => m.sourceId === sourceId && m.count > 0);
    if (!e) ctx.fail('Cette marque n’existe plus');
    t.mark = e;
    t.key = null;
    t.nameMsg = { t: 'marque de {name}', params: { name: markNameMsg(e) } };
    const [sk, sa] = sourceId.split(':');
    if (sk === 'host') t.host = slice(ctx.state).hosts[sa] || null;
    if (sk === 'persona') {
      t.actor = ctx.state.actors?.[sa] || null;
      t.persona = t.actor?.matrix ? ensurePersona(ctx.state, t.actor) : null;
    }
  } else if (kind === 'host' || kind === 'ic' || kind === 'device' || kind === 'file') {
    const host = getHost(ctx, a);
    if (!canSeeHost(ctx.state, ctx.user, host)) ctx.fail('Hôte introuvable');
    t.host = host;
    if (kind === 'host') {
      t.key = `host:${host.id}`;
      t.nameMsg = host.name;
    } else {
      const inside = persona.hostId === host.id;
      if (kind === 'ic') {
        t.ic = (host.ic || []).find((x) => x.id === b);
        if (!t.ic) ctx.fail('IC introuvable');
        if (own && (!inside || !t.ic.active)) ctx.fail('Cette IC n’est pas à portée (entre d’abord dans l’hôte)');
        t.nameMsg = icNameMsg(t.ic.type, host.name);
      } else if (kind === 'device') {
        t.device = (host.devices || []).find((x) => x.id === b);
        if (!t.device) ctx.fail('Appareil introuvable');
        if (own && !perceivedBy(host, own)) ctx.fail('Repère d’abord cet appareil (Perception matricielle sur l’hôte)');
        t.nameMsg = `${t.device.name} (${host.name})`;
      } else {
        t.file = (host.files || []).find((x) => x.id === b);
        if (!t.file) ctx.fail('Fichier introuvable');
        if (own && (!inside || !perceivedBy(host, own))) ctx.fail('Ce fichier n’est pas à portée (entre dans l’hôte et repère-le par Perception matricielle)');
        t.nameMsg = { t: 'fichier « {name} »', params: { name: t.file.name } };
      }
      t.key = `${kind}:${host.id}:${b}`;
    }
  } else if (kind === 'persona') {
    const target = ctx.state.actors?.[a];
    if (!target || (!ctx.isGM && target.type === 'npc' && target.hidden)) ctx.fail('Persona introuvable');
    if (target.id === persona.actorId) ctx.fail('Tu ne peux pas te cibler toi-même');
    t.actor = target;
    t.persona = target.matrix ? ensurePersona(ctx.state, target) : null;
    t.key = `persona:${target.id}`;
    t.nameMsg = target.name;
  } else if (kind === 'manual') {
    const name = str(p.targetName, 60).trim();
    // The key keeps the French default so marks stay found whatever the UI language (the client uses the same slug).
    t.key = `manual:${slug(name || 'cible inconnue') || 'cible'}`;
    t.nameMsg = name || { t: 'cible inconnue' };
  } else ctx.fail('Cible invalide');
  if (!allow.includes(t.kind)) ctx.fail('Cette action ne peut pas viser ce type de cible');
  t.name = fr(t.nameMsg);
  return t;
}

/** Defense pool for an action against a target, or null (no opposition) / { pending: true } (GM to roll). labelMsg = who defends. */
function defenseFor(ctx, action, target, p) {
  const d = action.defense;
  if (!d) return null;
  if (d.fixed) return { pool: d.fixed, parts: [{ label: 'GOD', value: d.fixed }], labelMsg: { t: 'le GOD' } };
  if (d.x2) {
    let r = 0;
    let label = '';
    if (d.x2 === 'protection') {
      r = Number(target.file?.protection) || Number(target.host?.rating) || 0;
      label = tk('Protection');
    } else if (d.x2 === 'bomb') {
      r = Number(target.file?.bomb) || 0;
      label = tk('Bombe de données');
    } else {
      r = Number(target.host?.rating) || 0;
      label = tk('Indice de l’appareil');
    }
    const params = { what: { t: label }, r };
    return { pool: r * 2, parts: [{ label: fr({ t: '{what} {r} × 2', params }), key: '{what} {r} × 2', params, value: r * 2 }], labelMsg: { t: label } };
  }
  if (target.kind === 'markOnMe') {
    if (target.host) return { ...hostDefensePool(target.host, action), labelMsg: target.host.name };
    if (target.actor) return { ...personaDefensePool(target.actor, target.persona, d), labelMsg: target.actor.name };
    return { pending: true };
  }
  if (target.host) return { ...hostDefensePool(target.host, action), labelMsg: target.host.name };
  if (target.kind === 'persona') {
    if (!target.actor.attributes) return { pending: true };
    return { ...personaDefensePool(target.actor, target.persona, d), labelMsg: target.actor.name };
  }
  if (target.kind === 'manual') {
    if (ctx.isGM && p.defensePool !== undefined && p.defensePool !== null && p.defensePool !== '') {
      const n = clampInt(p.defensePool, 0, 60, 0);
      return { pool: n, parts: [{ label: 'Défense (MJ)', key: tk('Défense (MJ)'), value: n }], labelMsg: target.nameMsg };
    }
    return { pending: true };
  }
  return null;
}

/** Resist matrix damage on a target; returns { boxes, sentences (messages) }. */
function damageTarget(ctx, target, dv, attacker) {
  let resistPool = 0;
  let mon = 0;
  if (target.ic) {
    resistPool = (Number(target.host.rating) || 0) + (Number(target.host.firewall) || 0);
    mon = matrixMonitor(target.host.rating);
  } else if (target.device) {
    const r = Math.max(Number(target.device.rating) || 0, Number(target.host?.rating) || 0);
    resistPool = r + Math.max(Number(target.device.rating) || 0, Number(target.host?.firewall) || 0);
    mon = matrixMonitor(target.device.rating);
  } else if (target.kind === 'persona' && target.actor?.matrix) {
    const ds = deckStats(target.actor, target.persona);
    resistPool = ds.deviceRating + ds.eff.firewall + programSum(target.persona, 'resistMatrix');
    mon = ds.monitor;
  } else {
    return { boxes: dv, sentences: [{ t: '{target} doit résister à {dv} dommages matriciels (au MJ).', params: { target: target.nameMsg, dv } }] };
  }
  const res = roll(resistPool, {}, 'opposition');
  const boxes = Math.max(0, dv - res.hits);
  const out = [{ t: 'VD {dv} : {target} résiste avec {hits} et subit {boxes}.', params: { dv, target: target.nameMsg, hits: hitsM(res.hits), boxes: boxesM(boxes) } }];
  if (target.ic) {
    target.ic.damage = Math.min(mon, (target.ic.damage || 0) + boxes);
    if (target.ic.damage >= mon && target.ic.active) {
      target.ic.active = false;
      target.ic.crashed = true;
      out.push({ t: '{target} est détruite !', params: { target: target.nameMsg } });
    }
  } else if (target.device) {
    target.device.damage = Math.min(mon, (target.device.damage || 0) + boxes);
    if (target.device.damage >= mon && !target.device.bricked) {
      target.device.bricked = true;
      syncDeviceLink(ctx, target.device);
      out.push({ t: '{device} est briqué !', params: { device: target.device.name } });
    }
  } else if (target.persona) {
    out.push(...damageDeck(ctx, target.actor, target.persona, boxes));
  }
  return { boxes, sentences: out, resistHits: res.hits, resistPool, attacker };
}

/** A data bomb goes off on the decker: Rating D6 matrix damage (resist DR + FW + Defuse/Armor), file destroyed. */
function explodeBomb(ctx, actor, persona, host, file, { agent } = {}) {
  const rating = Number(file.bomb) || 0;
  let dv = 0;
  for (let i = 0; i < rating; i++) dv += 1 + Math.floor(Math.random() * 6);
  if (testDice) dv = rating * 3;
  const ds = deckStats(actor, persona);
  const pool = ds.deviceRating + ds.eff.firewall + programSum(persona, 'resistBomb') + programSum(persona, 'resistMatrix');
  const res = roll(pool, {}, 'actor');
  const boxes = Math.max(0, dv - res.hits);
  const out = [{ t: 'BOUM ! La bombe de données (indice {rating}) explose : VD {dv}, {hits} en résistance.', params: { rating, dv, hits: hitsM(res.hits) } }];
  out.push(...(agent ? damageAgent(actor, persona, boxes) : damageDeck(ctx, actor, persona, boxes)));
  host.files = (host.files || []).filter((f) => f.id !== file.id);
  out.push({ t: 'Le fichier « {file} » est détruit.', params: { file: file.name } });
  sfx(ctx, 'explosion', [...ownersOf(ctx.state, actor.id), 'gm']);
  return out;
}

// ---------------------------------------------------------------------------
// Action resolution (decker or agent)
// ---------------------------------------------------------------------------
function performAction(ctx, actor, persona, action, p, { agent = false } = {}) {
  const ag = persona.agent;
  const who = agent ? ag.name : actor.name;
  const authorMsg = agent ? agentAuthorMsg(ag, actor) : null;
  const author = authorMsg ? fr(authorMsg) : actor.name;
  const target = resolveTarget(ctx, persona, action, p);
  const actionMsg = { t: action.fr };
  const labelMsg = target.name ? { t: '{action} → {target}', params: { action: actionMsg, target: target.nameMsg } } : actionMsg;
  const logBase = { author, ...(authorMsg ? { authorI18n: toI18n(authorMsg) } : {}) };
  const done = (msgs, extra = {}) => {
    mlog(ctx, { ...logBase, msgs, matrix: { actionId: action.id, actorId: actor.id, ...(extra.agent !== undefined ? { agent: extra.agent } : {}), outcomes: msgs.map(fr) } });
    return msgs;
  };

  // Marks required
  let marksNeeded = action.marks || 0;
  if (action.id === 'controlDevice') marksNeeded = clampInt(p.controlMarks, 1, 3, 1);
  if (action.marksOnOwner) marksNeeded = 0; // the mark must be on the impersonated owner: arbitrated by the GM
  const have = effectiveMarks(persona, target);
  if (marksNeeded > have) {
    const params = { n: marksNeeded, target: target.nameMsg, have };
    if (marksNeeded === 1) ctx.fail('Il faut {n} marque sur {target} ({have} actuellement)', params);
    ctx.fail('Il faut {n} marques sur {target} ({have} actuellement)', params);
  }

  // Actions without a test
  if (action.noTest) {
    if (agent) ctx.fail('Ton agent ne peut pas faire cette action à ta place');
    let msgs = [];
    if (action.id === 'enterHost') {
      persona.hostId = target.host.id;
      persona.fullDefense = false;
      msgs = [{ t: '{who} entre dans l’hôte {host}.', params: { who, host: target.host.name } }];
    } else if (action.id === 'exitHost') {
      if (!persona.hostId) ctx.fail('Tu n’es dans aucun hôte');
      const h = slice(ctx.state).hosts[persona.hostId];
      if (persona.linkLocked) ctx.fail('Verrou de lien : impossible de quitter l’hôte');
      const convergedHere = persona.hostConverged && persona.hostConverged === persona.hostId;
      persona.hostId = null;
      msgs = [{ t: '{who} sort de l’hôte {host} et retourne sur la grille.', params: { who, host: h ? h.name : '' } }];
      // SR5 p. 247: leaving a host after a convergence inside it → the grid's demiGOD converges at once.
      if (convergedHere) {
        persona.hostConverged = null;
        done(msgs);
        const conv = converge(ctx, actor, persona, { grid: true });
        return { actionId: action.id, noTest: true, outcomes: msgs.map(fr), msgs, success: true, convergence: conv.map(fr), convergenceMsgs: conv };
      }
    } else if (action.id === 'fullMatrixDefense') {
      persona.fullDefense = true;
      msgs = [{ t: '{who} passe en défense matricielle totale (+Volonté en défense, −10 en initiative).', params: { who } }];
    } else if (action.id === 'rebootSelf') {
      const out = rebootDeck(ctx, actor, persona);
      msgs = [{ t: '{who} redémarre son deck : Score d’Overwatch remis à 0, marques effacées.', params: { who } }, ...out];
    }
    done(msgs);
    return { actionId: action.id, noTest: true, outcomes: msgs.map(fr), msgs, success: true };
  }

  // Jack out: free unless link-locked
  if (action.id === 'jackOut') {
    if (agent) ctx.fail('Ton agent ne peut pas te déconnecter');
    if (!persona.linkLocked) {
      goOffline(ctx, actor, persona, { dumped: false });
      const msgs = done([{ t: '{who} se déconnecte proprement de la Matrice.', params: { who } }]);
      return { actionId: action.id, noTest: true, outcomes: msgs.map(fr), msgs, success: true };
    }
  }

  // File preconditions (before rolling)
  if (action.id === 'editFile' && target.file) {
    if (target.file.protected) ctx.fail('Fichier protégé : il faut d’abord le craquer (Craquer un fichier)');
    if (Number(target.file.bomb) > 0 && target.file.bombBy !== actor.id) {
      const out = done(explodeBomb(ctx, actor, persona, target.host, target.file, { agent }), { agent });
      return { actionId: action.id, exploded: true, outcomes: out.map(fr), msgs: out, success: false };
    }
  }
  if (action.id === 'crackFile' && target.file && !target.file.protected) ctx.fail('Ce fichier n’est pas protégé');
  if (action.id === 'disarmDataBomb' && target.file && !(Number(target.file.bomb) > 0)) ctx.fail('Aucune bombe de données sur ce fichier (à ta connaissance)');

  // Teamwork bonus from the agent
  let assist = null;
  if (p.assistFromAgent && !agent) {
    const pa = persona.pendingAssist;
    if (!pa) ctx.fail('Aucune assistance de l’agent en attente : fais-le assister d’abord');
    if (pa.skill !== action.skill) ctx.fail('L’assistance de l’agent portait sur une autre compétence');
    assist = { dice: pa.dice, limitBonus: pa.limitBonus };
    persona.pendingAssist = null;
  }

  // Edge
  const edge = !!p.edge && !agent;
  if (edge && (actor.edge?.current || 0) <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: actor.name });

  const marksWanted = action.placesMarks ? clampInt(p.marks, 1, 3, 1) : 0;
  // Decker's modifiers (skill / linked attribute / Codeslinger dice: shared/modifiers.js), computed here; the client only says which
  // situational switches are on (checked against the actor's own modifiers). The agent rolls its Rating: no modifier.
  const mods = agent ? null : actorModifiers(actor);
  const conditions = mods ? cleanConditions(mods, p.conditions) : [];
  const pc = actionPool(actor, persona, action, { useSpec: !!p.useSpec && !agent, marks: marksWanted, modifier: clampInt(p.modifier, -30, 30, 0), assist, edge, agent, ...(mods ? { mods, conditions } : {}) });
  if (pc.impossible) ctx.fail(pc.reasonKey || pc.reason, pc.reasonParams);
  if (pc.pool <= 0) ctx.fail('Réserve de dés nulle : l’action échoue automatiquement');
  if (edge) actor.edge.current -= 1;

  const r = roll(pc.pool, { limit: pc.limit, explode: edge }, 'actor');
  const ll = persona.linkLocked;
  const def = action.id === 'jackOut'
    ? { pool: ll.pool, parts: [{ label: ll.name, value: ll.pool }], labelMsg: linkLockMsg(ll) }
    : defenseFor(ctx, action, target, p);
  let dr = null;
  if (def && !def.pending) dr = roll(def.pool, {}, 'opposition');
  const defHits = dr ? dr.hits : 0;
  const net = r.hits - defHits;
  const threshold = clampInt(p.threshold, 0, 30, 0);
  const pending = !!def?.pending;
  const success = pending ? null : dr ? net > 0 : r.hits >= Math.max(1, threshold);
  const outcomes = [];
  let osDelta = 0;
  const tgt = target.nameMsg;

  if (r.critGlitch) outcomes.push({ t: 'Échec critique ! {who} commet une erreur grave (au MJ).', params: { who } });
  else if (r.glitch) outcomes.push({ t: 'Complication pour {who} (au MJ).', params: { who } });
  if (pending) outcomes.push({ t: '{hits} : le MJ lance la défense de {target}.', params: { hits: hitsM(r.hits), target: tgt } });
  else if (dr) {
    outcomes.push(success
      ? { t: 'Réussite : {net} contre {d} pour {defender}.', params: { net: netM(net), d: defHits, defender: def.labelMsg } }
      : { t: 'Échec : {hits} contre {d} pour {defender}.', params: { hits: r.hits, d: defHits, defender: def.labelMsg } });
  } else outcomes.push(success ? { t: 'Réussite avec {hits}.', params: { hits: hitsM(r.hits) } } : { t: 'Échec ({hits}).', params: { hits: hitsM(r.hits) } });

  // Overwatch: illegal actions add the defender's hits
  if (isIllegal(action) && dr && defHits > 0) {
    osDelta = defHits;
    addOverwatch(ctx, persona, defHits);
  }

  if (success) {
    switch (action.id) {
      case 'hackOnTheFly':
      case 'bruteForce': {
        const n = addMark(persona, target.key, target.name, marksWanted, target.nameMsg);
        const params = { n: marksWanted, target: tgt, total: n };
        outcomes.push(marksWanted === 1 ? { t: '{n} marque placée sur {target} (total {total}).', params } : { t: '{n} marques placées sur {target} (total {total}).', params });
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
        const victim = progs.find((x) => x.toLowerCase() === wanted.toLowerCase()) || (progs.length ? progs[Math.floor(Math.random() * progs.length)] : null);
        if (victim && target.persona) {
          target.persona.loadedPrograms = progs.filter((x) => x !== victim);
          outcomes.push({ t: 'Le programme {program} de {target} plante.', params: { program: victim, target: tgt } });
        } else outcomes.push({ t: 'Un programme de {target} plante (au MJ).', params: { target: tgt } });
        break;
      }
      case 'crackFile':
        target.file.protected = false;
        outcomes.push({ t: 'La protection du fichier « {file} » saute.', params: { file: target.file.name } });
        break;
      case 'eraseMark':
        target.mark.count -= 1;
        persona.marksOnMe = persona.marksOnMe.filter((m) => m.count > 0);
        outcomes.push({ t: 'Une marque de {name} est effacée.', params: { name: markNameMsg(target.mark) } });
        break;
      case 'jamSignals':
        outcomes.push({ t: 'Brouillage : bruit +{n} dans un rayon de 100 m.', params: { n: r.hits } });
        break;
      case 'spoofCommand': {
        outcomes.push(p.command ? { t: 'L’appareil exécute la commande usurpée : « {command} ».', params: { command: str(p.command, 120) } } : { t: 'L’appareil exécute la commande usurpée.' });
        const mapMsg = target.device && p.deviceCmd ? applyDeviceCmd(ctx, target.device, str(p.deviceCmd, 20)) : null;
        if (mapMsg) outcomes.push(mapMsg);
        break;
      }
      case 'snoop':
        outcomes.push({ t: '{who} intercepte le trafic de {target}.', params: { who, target: tgt } });
        break;
      case 'hide':
        if (target.host) target.host.spotted = (target.host.spotted || []).filter((id) => id !== actor.id);
        outcomes.push({ t: '{target} perd la trace de {who}.', params: { target: tgt, who } });
        break;
      case 'formatDevice':
        if (target.device) {
          target.device.formatted = true;
          syncDeviceLink(ctx, target.device);
        }
        outcomes.push({ t: '{target} est formaté : il ne redémarrera pas.', params: { target: tgt } });
        break;
      case 'rebootDevice':
        if (target.device) {
          target.device.offline = true;
          syncDeviceLink(ctx, target.device);
        }
        if (target.kind === 'persona' && target.persona?.online) outcomes.push(...rebootDeck(ctx, target.actor, target.persona));
        outcomes.push({ t: '{target} redémarre (hors ligne jusqu’à la fin du tour suivant).', params: { target: tgt } });
        break;
      case 'setDataBomb': {
        const rating = Math.min(12, net + programSum(persona, 'bombBonus'));
        target.file.bomb = rating;
        target.file.bombBy = actor.id;
        outcomes.push({ t: 'Bombe de données d’indice {rating} posée sur « {file} ».', params: { rating, file: target.file.name } });
        break;
      }
      case 'checkOverwatch':
        persona.osKnown = persona.overwatch;
        persona.osKnownAt = Date.now();
        outcomes.push({ t: 'Score d’Overwatch actuel : {os}.', params: { os: persona.overwatch } });
        break;
      case 'matrixPerception': {
        if (target.host) {
          const h = target.host;
          h.perceivedBy = [...new Set([...(h.perceivedBy || []), actor.id])];
          if (target.ic) target.ic.detected = true;
          if (target.kind === 'host' && persona.hostId === h.id) for (const ic of h.ic || []) if (ic.active) ic.detected = true;
          const params = { n: r.hits, target: tgt };
          outcomes.push(r.hits === 1 ? { t: '{n} information obtenue sur {target}.', params } : { t: '{n} informations obtenues sur {target}.', params });
        } else outcomes.push(r.hits === 1 ? { t: '{n} information (le MJ répond).', params: { n: r.hits } } : { t: '{n} informations (le MJ répond).', params: { n: r.hits } });
        break;
      }
      case 'matrixSearch':
        outcomes.push({ t: '{hits} à la recherche (le MJ répond).', params: { hits: hitsM(r.hits) } });
        break;
      case 'traceIcon':
        outcomes.push({ t: 'Position physique de {target} localisée.', params: { target: tgt } });
        break;
      case 'controlDevice': {
        if (target.device) target.device.controlledBy = actor.id;
        outcomes.push(p.command ? { t: '{target} obéit : « {command} ».', params: { target: tgt, command: str(p.command, 120) } } : { t: '{target} obéit.', params: { target: tgt } });
        const mapMsg = target.device && p.deviceCmd ? applyDeviceCmd(ctx, target.device, str(p.deviceCmd, 20)) : null;
        if (mapMsg) outcomes.push(mapMsg);
        break;
      }
      case 'editFile': {
        const f = target.file;
        const op = ['read', 'copy', 'edit', 'delete'].includes(p.fileOp) ? p.fileOp : 'copy';
        if (op === 'copy' || op === 'read') {
          if (op === 'copy' && !persona.files.some((x) => x.sourceId === f.id)) {
            persona.files.push({ id: uid('pay'), sourceId: f.id, name: f.name, hostName: target.host.name, value: loadedProgramIds(persona).has('evaluate') ? f.value ?? null : null, content: f.content || '', ts: Date.now() });
          }
          if (op === 'read' && !persona.files.some((x) => x.sourceId === f.id)) {
            persona.files.push({ id: uid('pay'), sourceId: f.id, name: f.name, hostName: target.host.name, value: null, content: f.content || '', ts: Date.now(), readOnly: true });
          }
          outcomes.push(op === 'copy' ? { t: 'Fichier « {file} » copié dans le deck.', params: { file: f.name } } : { t: 'Fichier « {file} » lu.', params: { file: f.name } });
          sfx(ctx, 'notify', 'gm'); // the GM may want to describe what the file says
        } else if (op === 'edit') {
          f.edited = true;
          outcomes.push(p.command ? { t: 'Fichier « {file} » modifié : {change}.', params: { file: f.name, change: str(p.command, 160) } } : { t: 'Fichier « {file} » modifié.', params: { file: f.name } });
        } else {
          target.host.files = target.host.files.filter((x) => x.id !== f.id);
          outcomes.push({ t: 'Fichier « {file} » effacé.', params: { file: f.name } });
        }
        break;
      }
      case 'disarmDataBomb':
        target.file.bomb = 0;
        target.file.bombBy = null;
        outcomes.push({ t: 'Bombe de données désamorcée sur « {file} ».', params: { file: target.file.name } });
        break;
      case 'jackOut':
        outcomes.push({ t: '{who} brise le verrou de lien et se déconnecte.', params: { who } });
        goOffline(ctx, actor, persona, { dumped: false });
        break;
      default:
        break;
    }
  } else if (success === false) {
    if (action.id === 'disarmDataBomb' && target.file) outcomes.push(...explodeBomb(ctx, actor, persona, target.host, target.file, { agent }));
    // Failed Sleaze action: the target marks you and raises the alarm
    if (action.cat === 'sleaze' && dr && target.kind !== 'none' && !action.defense?.fixed) {
      const sourceId = target.host ? `host:${target.host.id}` : target.key;
      const sourceMsg = target.host ? target.host.name : target.nameMsg;
      if (sourceId) {
        addMarkOnMe(persona, sourceId, fr(sourceMsg), 1, sourceMsg);
        outcomes.push({ t: '{source} place une marque sur {name}.', params: { source: sourceMsg, name: actor.name } });
      }
      if (target.host) {
        const s = setAlert(ctx, target.host, { t: '{action} raté par {who}', params: { action: actionMsg, who } });
        if (s) outcomes.push(s);
      }
    }
    // Failed Attack action: 1 box per net hit of the defender
    if (action.cat === 'attack' && dr && defHits > r.hits) {
      const back = defHits - r.hits;
      outcomes.push({ t: 'Retour de flamme : {boxes} de dommages matriciels.', params: { boxes: boxesM(back) } });
      outcomes.push(...(agent ? damageAgent(actor, persona, back) : damageDeck(ctx, actor, persona, back)));
      if (target.host) {
        const s = setAlert(ctx, target.host, { t: '{action} raté par {who}', params: { action: actionMsg, who } });
        if (s) outcomes.push(s);
      }
    }
  }
  // Attacks are noticed by the target even when they succeed.
  if (success && action.cat === 'attack' && target.host && action.id !== 'crackFile' && action.id !== 'eraseMark') {
    const s = setAlert(ctx, target.host, { t: '{action} de {who}', params: { action: actionMsg, who } });
    if (s) outcomes.push(s);
  }
  if (osDelta) outcomes.push({ t: 'Score d’Overwatch +{n}.', params: { n: osDelta } });
  if (pending && isIllegal(action)) outcomes.push({ t: 'Action illégale : le MJ ajoute les succès de la défense au Score d’Overwatch.' });

  const converged = persona.overwatch >= OS_MAX && persona.online && !persona.hostConverged;
  const rollLabelMsg = agent ? { t: '{label} ({agent})', params: { label: labelMsg, agent: ag.name } } : labelMsg;
  const roll1 = { ...r, label: fr(rollLabelMsg), labelI18n: toI18n(rollLabelMsg), breakdown: sumParts(pc.parts) + (pc.limit ? ` [${pc.limit}]` : ''), explode: edge, edge };
  const defLabel = def && !def.pending ? fr(def.labelMsg) : '';
  const entry = mlog(ctx, {
    ...logBase, msgs: outcomes, roll: roll1,
    matrix: {
      actionId: action.id, actorId: actor.id, agent, targetName: target.name || '', success, net, pending, osDelta, outcomes: outcomes.map(fr),
      defenseHits: dr ? defHits : null, defenseDice: dr ? dr.dice : null, assist,
      gm: dr ? { defensePool: def.pool, defenseParts: def.parts } : undefined,
    },
  });
  sfx(ctx, 'dice');
  if (r.critGlitch) sfx(ctx, 'matrix-glitch', [...ownersOf(ctx.state, actor.id), 'gm']);
  let convergence = null;
  if (converged) convergence = converge(ctx, actor, persona);
  return {
    actionId: action.id, logId: entry.id, label: roll1.label, labelMsg: rollLabelMsg, agent,
    roll: { pool: r.pool, dice: r.dice, extra: r.extra, hits: r.hits, rawHits: r.rawHits, limit: r.limit, glitch: r.glitch, critGlitch: r.critGlitch, parts: pc.parts },
    defense: dr ? { hits: defHits, dice: dr.dice, label: defLabel, labelMsg: def.labelMsg, ...(ctx.isGM ? { pool: def.pool } : {}) } : null,
    pending, net, success, outcomes: outcomes.map(fr), msgs: outcomes, osDelta,
    convergence: convergence ? convergence.map(fr) : null, convergenceMsgs: convergence,
  };
}

// ---------------------------------------------------------------------------
// IC attacks (GM)
// ---------------------------------------------------------------------------
function icAttack(ctx, host, ic, actor, persona) {
  const def = IC_TYPES[ic.type];
  if (!def) ctx.fail('Type d’IC inconnu');
  const icMsg = icNameMsg(ic.type, host.name);
  const icName = fr(icMsg);
  const icType = { t: def.fr };
  const hostMarks = persona.marksOnMe.find((m) => m.sourceId === `host:${host.id}`)?.count || 0;
  if (def.needsMarks && hostMarks < def.needsMarks) {
    const params = { ic: icType, n: def.needsMarks, name: actor.name, have: hostMarks };
    if (def.needsMarks === 1) ctx.fail('{ic} : il faut {n} marque de l’hôte sur {name} ({have} actuellement)', params);
    ctx.fail('{ic} : il faut {n} marques de l’hôte sur {name} ({have} actuellement)', params);
  }
  const pool = icAttackPool(host);
  const limit = Number(host[def.limit]) || null;
  const a = roll(pool, { limit }, 'opposition');
  const dp = personaDefensePool(actor, persona, def.defense);
  const d = roll(dp.pool, {}, 'actor');
  const net = a.hits - d.hits;
  const out = [];
  const name = actor.name;
  if (net <= 0) out.push({ t: '{name} esquive ({d} contre {a}).', params: { name, d: d.hits, a: a.hits } });
  else {
    out.push({ t: 'Touché : {net} ({a} contre {d}).', params: { net: netM(net), a: a.hits, d: d.hits } });
    switch (def.effect) {
      case 'spot':
        host.spotted = [...new Set([...(host.spotted || []), actor.id])];
        out.push({ t: '{name} est repéré(e) par la patrouille.', params: { name } });
        {
          const s = setAlert(ctx, host, { t: '{ic} a repéré {name}', params: { ic: icType, name } });
          if (s) out.push(s);
        }
        break;
      case 'mark': {
        const n = addMarkOnMe(persona, `host:${host.id}`, host.name, 1);
        out.push({ t: 'L’hôte place une marque sur {name} ({n}/3).', params: { name, n } });
        break;
      }
      case 'penalty': {
        const k = def.attrHit;
        persona.penalties[k] = (Number(persona.penalties[k]) || 0) + 1;
        out.push({ t: '{attr} −1 jusqu’au redémarrage (total −{total}).', params: { attr: { t: ASDF_LABELS[k] }, total: persona.penalties[k] } });
        break;
      }
      case 'crash': {
        const progs = [...persona.loadedPrograms, ...(persona.agent?.loaded ? ['__agent__'] : [])];
        if (!progs.length) out.push({ t: 'Aucun programme chargé à faire planter.' });
        else {
          const v = progs[Math.floor(Math.random() * progs.length)];
          if (v === '__agent__') {
            persona.agent.loaded = false;
            out.push({ t: '{agent} plante !', params: { agent: persona.agent.name } });
          } else {
            persona.loadedPrograms = persona.loadedPrograms.filter((x) => x !== v);
            out.push({ t: 'Le programme {program} plante.', params: { program: v } });
          }
        }
        break;
      }
      case 'linklock':
        persona.linkLocked = { source: `host:${host.id}`, name: icName, icType: ic.type, hostName: host.name, pool: (Number(host.rating) || 0) + (Number(host.attack) || 0) };
        out.push({ t: 'Verrou de lien : {name} ne peut plus se déconnecter normalement.', params: { name } });
        break;
      case 'reboot':
        out.push({ t: '{name} est forcé(e) de redémarrer son deck.', params: { name } });
        out.push(...rebootDeck(ctx, actor, persona));
        break;
      case 'trace':
        persona.traced = true;
        out.push({ t: 'La position physique de {name} est localisée.', params: { name } });
        mlog(ctx, { author: host.name, gmOnly: true, msgs: [{ t: '{ic} : position physique de {name} transmise au propriétaire de l’hôte.', params: { ic: icType, name } }] });
        break;
      case 'damage': {
        // Same as a Data Spike: the host's Attack + net hits.
        const dv = (Number(host.attack) || 0) + net;
        const ds = deckStats(actor, persona);
        const rp = ds.deviceRating + ds.eff.firewall + programSum(persona, 'resistMatrix');
        const rr = roll(rp, {}, 'actor');
        const boxes = Math.max(0, dv - rr.hits);
        out.push({ t: 'VD {dv} : {hits} en résistance.', params: { dv, hits: hitsM(rr.hits) } });
        if (def.bio) {
          const type = def.bio === 'S' ? (persona.mode === 'ar' ? null : 'S') : persona.mode === 'hot' ? 'P' : persona.mode === 'cold' ? 'S' : null;
          if (type) {
            const bp = attr(actor, 'WIL') + ds.eff.firewall + programSum(persona, 'resistBio');
            const br = roll(bp, {}, 'actor');
            const bb = Math.max(0, dv - br.hits);
            applyActorDamage(actor, bb, type);
            const params = { boxes: boxesM(bb), hits: hitsM(br.hits) };
            out.push(type === 'P'
              ? { t: 'Biofeedback : {boxes} de dommages physiques ({hits} en résistance).', params }
              : { t: 'Biofeedback : {boxes} de dommages étourdissants ({hits} en résistance).', params });
          } else out.push({ t: 'Pas de biofeedback en RA.' });
        }
        if (def.linklock && persona.online) {
          persona.linkLocked = { source: `host:${host.id}`, name: icName, icType: ic.type, hostName: host.name, pool: (Number(host.rating) || 0) + (Number(host.attack) || 0) };
          out.push({ t: 'Verrou de lien posé.' });
        }
        out.push(...damageDeck(ctx, actor, persona, boxes));
        break;
      }
      default:
        break;
    }
  }
  const labelMsg = { t: '{ic} → {name}', params: { ic: icMsg, name } };
  const r1 = { ...a, label: fr(labelMsg), labelI18n: toI18n(labelMsg), breakdown: `Indice ${host.rating} × 2${limit ? ` [${limit}]` : ''}` };
  mlog(ctx, {
    author: icName, authorI18n: toI18n(icMsg), msgs: out, roll: r1,
    matrix: { icType: ic.type, hostId: host.id, actorId: actor.id, success: net > 0, net, defenseHits: d.hits, defenseDice: d.dice, outcomes: out.map(fr), gm: { defensePool: dp.pool } },
  });
  sfx(ctx, net > 0 ? 'matrix-glitch' : 'dice', 'all');
  return { hits: a.hits, defenseHits: d.hits, net, success: net > 0, outcomes: out.map(fr), msgs: out };
}

/** Marks the host holds on a persona. */
const hostMarksOn = (persona, host) => persona.marksOnMe.find((m) => m.sourceId === `host:${host.id}`)?.count || 0;

/**
 * Who an IC goes after (GM « Tour de l'hôte » / « Agir » in the tracker): Patrol IC looks for intruders not spotted yet;
 * the others attack the intruders the host knows best (spotted, then the most host marks), if they have the marks they need.
 * Returns { actor, persona } or { reasonMsg }.
 */
function pickIcTarget(ctx, host, ic) {
  const def = IC_TYPES[ic.type];
  const icType = { t: def.fr };
  let list = intrudersOf(ctx.state, host).map((p) => ensurePersona(ctx.state, ctx.state.actors[p.actorId]));
  if (!list.length) return { reasonMsg: { t: '{ic} : personne dans l’hôte.', params: { ic: icType } } };
  const spotted = new Set(host.spotted || []);
  if (def.effect === 'spot') {
    list = list.filter((p) => !spotted.has(p.actorId));
    if (!list.length) return { reasonMsg: { t: '{ic} : tout le monde est déjà repéré, elle surveille.', params: { ic: icType } } };
  } else {
    if (def.needsMarks) list = list.filter((p) => hostMarksOn(p, host) >= def.needsMarks);
    if (!list.length) {
      const params = { ic: icType, n: def.needsMarks };
      return { reasonMsg: def.needsMarks === 1 ? { t: '{ic} attend : il lui faut {n} marque de l’hôte sur sa cible.', params } : { t: '{ic} attend : il lui faut {n} marques de l’hôte sur sa cible.', params } };
    }
    list.sort((a, b) => Number(spotted.has(b.actorId)) - Number(spotted.has(a.actorId)) || hostMarksOn(b, host) - hostMarksOn(a, host));
  }
  return { persona: list[0], actor: ctx.state.actors[list[0].actorId] };
}

/** One IC acts (automatic target unless actorId). Returns { ic, result?, skipped?: message }. */
function icTakesTurn(ctx, host, ic, actorId) {
  if (!ic.active) ctx.fail('Cette IC n’est pas lancée');
  let actor;
  let persona;
  if (actorId) {
    actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    persona = ensurePersona(ctx.state, actor);
    if (!persona.online || persona.hostId !== host.id) ctx.fail('{name} n’est pas dans cet hôte', { name: actor.name });
  } else {
    const pick = pickIcTarget(ctx, host, ic);
    if (!pick.persona) {
      mlog(ctx, { author: host.name, gmOnly: true, msgs: [pick.reasonMsg], matrix: { event: 'icIdle', hostId: host.id, icType: ic.type } });
      return { icId: ic.id, skipped: fr(pick.reasonMsg), skippedMsg: pick.reasonMsg };
    }
    ({ actor, persona } = pick);
  }
  return { icId: ic.id, actorId: actor.id, result: icAttack(ctx, host, ic, actor, persona) };
}

// ---------------------------------------------------------------------------
// Host sanitizers (GM input)
// ---------------------------------------------------------------------------
function cleanIc(x, host) {
  if (!isObj(x) || !IC_TYPES[x.type]) return null;
  return {
    id: str(x.id, 40) || uid('ic'), type: x.type, rating: clampInt(x.rating ?? host.rating, 1, 12, host.rating || 1),
    active: !!x.active, damage: clampInt(x.damage, 0, 30, 0), detected: !!x.detected, crashed: !!x.crashed && !x.active,
  };
}
function cleanFile(x) {
  if (!isObj(x)) return null;
  return {
    id: str(x.id, 40) || uid('file'), name: str(x.name, 80).trim() || 'Fichier', protected: !!x.protected,
    protection: clampInt(x.protection, 0, 12, 0), bomb: clampInt(x.bomb, 0, 12, 0), bombBy: x.bombBy ? str(x.bombBy, 60) : null,
    value: x.value === null || x.value === undefined || x.value === '' ? null : clampInt(x.value, 0, 1e7, 0),
    content: str(x.content, 4000), edited: !!x.edited,
  };
}
function cleanDevice(x) {
  if (!isObj(x)) return null;
  const l = x.link;
  const link = isObj(l) && DEVICE_LINK_KINDS[l.kind] && l.mapId && l.targetId ? { mapId: str(l.mapId, 80), kind: l.kind, targetId: str(l.targetId, 80) } : null;
  return {
    id: str(x.id, 40) || uid('dev'), name: str(x.name, 80).trim() || 'Appareil', rating: clampInt(x.rating, 1, 12, 3),
    damage: clampInt(x.damage, 0, 30, 0), offline: !!x.offline, formatted: !!x.formatted, bricked: !!x.bricked,
    controlledBy: x.controlledBy ? str(x.controlledBy, 60) : null, notes: str(x.notes, 400),
    link, on: x.on !== false,
  };
}
function normalizeHost(h, id) {
  h.id = id;
  h.name = str(h.name, 80) || 'Hôte';
  h.rating = clampInt(h.rating, 1, 12, 3);
  const attrs = hostAttributes(h.rating);
  for (const k of ASDF) h[k] = clampInt(h[k] ?? attrs[k], 0, 20, attrs[k]);
  h.alert = h.alert === 'active' ? 'active' : 'none';
  h.visible = !!h.visible;
  h.ic = (Array.isArray(h.ic) ? h.ic : []).map((x) => cleanIc(x, h)).filter(Boolean);
  h.files = (Array.isArray(h.files) ? h.files : []).map(cleanFile).filter(Boolean);
  h.devices = (Array.isArray(h.devices) ? h.devices : []).map(cleanDevice).filter(Boolean);
  h.perceivedBy = Array.isArray(h.perceivedBy) ? h.perceivedBy.map(String) : [];
  h.spotted = Array.isArray(h.spotted) ? h.spotted.map(String) : [];
  h.spider = h.spider ? str(h.spider, 80) : null;
  h.spiderAlert = h.spiderAlert ? str(h.spiderAlert, 80) : null;
  h.notes = str(h.notes, 8000);
  h.description = str(h.description, 2000);
  h.folder = str(h.folder, 60);
  return h;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
// Every Matrix action first applies the Overwatch timer (when on), then keeps the combat tracker in sync (IC, agents, VR mode).
const wrap = (handler) => (ctx, p) => {
  tickOverwatch(ctx);
  const r = handler(ctx, p);
  syncMatrixCombat(ctx);
  return r;
};
const any = (handler) => ({ role: 'any', handler: wrap(handler) });
const gm = (handler) => ({ role: 'gm', handler: wrap(handler) });

// Rolls written to the log carry no roll.actorId on purpose: the LogDock would offer « 2ᵉ chance » (dice/secondChance
// only handles kind 'roll'); the actor is in entry.matrix.actorId.
const actions = {
  // { actorId } — create/sync the persona (slots from the deck catalog, agent detection) without connecting.
  'matrix/ensure': any((ctx, { actorId } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    return { programSlots: persona.programSlots, agent: persona.agent };
  }),

  // { actorId, mode: 'ar'|'cold'|'hot' } — connect, or switch interface mode when already online.
  'matrix/connect': any((ctx, { actorId, mode } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    if (!MODES.includes(mode)) ctx.fail('Mode de connexion inconnu');
    if (persona.bricked) ctx.fail('Le deck de {name} est briqué : il doit être réparé', { name: actor.name });
    const was = persona.online ? persona.mode : null;
    persona.mode = mode;
    persona.online = true;
    const ini = matrixInitiative(actor, persona, mode, actorModifiers(actor));
    if (was !== mode) {
      const params = { name: actor.name, mode: { t: MODE_LABELS[mode] }, ini: ini.text };
      mlog(ctx, { author: actor.name, msgs: [was ? { t: '{name} passe en {mode} (initiative {ini}).', params } : { t: '{name} se connecte à la Matrice en {mode} (initiative {ini}).', params }], matrix: { event: 'connect', actorId, mode } });
    }
    return { mode, initiative: ini };
  }),

  // { actorId, dump? } — graceful by default; GM may dump the persona (dumpshock in VR).
  'matrix/disconnect': any((ctx, { actorId, dump } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    if (!persona.online) return { online: false };
    const forced = !!dump && ctx.isGM;
    if (!forced && persona.linkLocked) ctx.fail('Verrou de lien : utilise l’action « Se déconnecter (Jack Out) » pour tenter de le briser');
    const out = goOffline(ctx, actor, persona, { dumped: forced });
    const head = forced ? { t: '{name} est éjecté(e) de la Matrice.', params: { name: actor.name } } : { t: '{name} se déconnecte de la Matrice.', params: { name: actor.name } };
    mlog(ctx, { author: actor.name, msgs: [head, ...out], matrix: { event: 'disconnect', actorId } });
    if (forced) sfx(ctx, 'matrix-glitch', [...ownersOf(ctx.state, actorId), 'gm']);
    return { online: false, outcomes: out.map(fr), msgs: out };
  }),

  // { actorId, swap: [a, b] } or { actorId, asdf: { attack: 'sleaze', … } } — cyberdecks only (Free Action).
  'matrix/setASDF': any((ctx, { actorId, swap, asdf } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    if (!isCyberdeck(actor)) ctx.fail('Seul un cyberdeck peut permuter ses attributs');
    if (Array.isArray(swap)) {
      const [a, b] = swap;
      if (!ASDF.includes(a) || !ASDF.includes(b) || a === b) ctx.fail('Permutation invalide');
      const next = { ...persona.asdf };
      [next[a], next[b]] = [next[b], next[a]];
      persona.asdf = next;
    } else if (isPermutation(asdf)) {
      persona.asdf = Object.fromEntries(ASDF.map((k) => [k, asdf[k]]));
    } else ctx.fail('Configuration invalide');
    return { asdf: persona.asdf, eff: deckStats(actor, persona).eff };
  }),

  // { actorId, name }
  'matrix/loadProgram': any((ctx, { actorId, name } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    const n = str(name, 80).trim();
    const prog = availablePrograms(actor).find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!prog) ctx.fail('Programme absent de ton deck');
    if (prog.id === 'agent') ctx.fail('L’agent se charge depuis son propre panneau');
    if (persona.loadedPrograms.some((x) => x.toLowerCase() === n.toLowerCase())) ctx.fail('Programme déjà chargé');
    const s = programSlots(persona);
    const gain = prog.id === 'virtualMachine' ? PROGRAM_BY_ID.virtualMachine.slots : 0;
    if (s.used + 1 > s.total + gain) ctx.fail('Plus d’emplacement libre ({used}/{total}) : décharge d’abord un programme', { used: s.used, total: s.total });
    persona.loadedPrograms.push(prog.name);
    return { loadedPrograms: persona.loadedPrograms, slots: programSlots(persona) };
  }),

  'matrix/unloadProgram': any((ctx, { actorId, name } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    const n = str(name, 80).trim().toLowerCase();
    const idx = persona.loadedPrograms.findIndex((x) => x.toLowerCase() === n);
    if (idx < 0) ctx.fail('Programme non chargé');
    const next = persona.loadedPrograms.filter((_, i) => i !== idx);
    const s = programSlots({ ...persona, loadedPrograms: next });
    if (s.used > s.total) ctx.fail('Décharge d’abord d’autres programmes : la Machine virtuelle fournit des emplacements occupés');
    persona.loadedPrograms = next;
    return { loadedPrograms: persona.loadedPrograms, slots: programSlots(persona) };
  }),

  // { actorId, rating, name } — players: rating up to the best agent they own; GM: any rating 1-6.
  'matrix/configureAgent': any((ctx, { actorId, rating, name } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    const owned = detectAgents(actor);
    const max = owned.reduce((m, x) => Math.max(m, x.rating), 0);
    const r = clampInt(rating, 1, 6, 1);
    if (!ctx.isGM) {
      if (!max) ctx.fail('Aucun agent dans ton équipement : achète un Agent à la boutique (Logiciels)');
      if (r > max) ctx.fail('Ton meilleur agent est d’indice {n}', { n: max });
    }
    const prev = persona.agent || { loaded: false, damage: 0 };
    persona.agent = { ...prev, rating: r, name: str(name, 40).trim() || prev.name || `Agent ${r}`, source: prev.source || (ctx.isGM && !max ? 'gm' : 'gear') };
    persona.agent.damage = Math.min(persona.agent.damage || 0, matrixMonitor(r));
    return { agent: persona.agent };
  }),

  // { actorId, loaded }
  'matrix/agentLoad': any((ctx, { actorId, loaded } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    const ag = persona.agent;
    if (!ag) ctx.fail('Aucun agent configuré');
    if (loaded) {
      if (ag.loaded) return { agent: ag };
      const s = programSlots(persona);
      if (s.used + 1 > s.total) ctx.fail('Plus d’emplacement libre pour l’agent ({used}/{total})', { used: s.used, total: s.total });
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
  'matrix/agentAssist': any((ctx, { actorId, actionId } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    requireOnline(ctx, actor, persona);
    const ag = persona.agent;
    if (!ag || !ag.loaded) ctx.fail('Ton agent n’est pas chargé');
    const action = ACTION_BY_ID[actionId];
    if (!action || action.noTest || !action.skill) ctx.fail('Cette action ne se prête pas au travail d’équipe');
    const pc = actionPool(actor, persona, action, { agent: true });
    if (pc.pool <= 0) ctx.fail('Réserve de dés nulle pour l’agent');
    const r = roll(pc.pool, { limit: pc.limit }, 'actor');
    const cap = skillRating(actor, action.skill);
    let dice = Math.min(r.hits, cap);
    let limitBonus = r.hits > 0 ? 1 : 0;
    const outcomes = [];
    const agent = ag.name;
    if (r.critGlitch) {
      dice = 0;
      limitBonus = 0;
      ag.loaded = false;
      outcomes.push({ t: 'Échec critique : {agent} plante et se décharge du deck. Aucune aide.', params: { agent } });
      sfx(ctx, 'matrix-glitch', [...ownersOf(ctx.state, actorId), 'gm']);
    } else if (r.glitch) {
      dice = 0;
      limitBonus = 0;
      outcomes.push({ t: 'Complication : {agent} s’emmêle et n’apporte aucune aide.', params: { agent } });
    } else if (r.hits) {
      const params = { agent, n: dice, action: { t: action.fr } };
      outcomes.push(dice === 1
        ? { t: '{agent} apporte +{n} dé et +1 à la limite pour « {action} ».', params }
        : dice === 0
          ? { t: 'zero::{agent} apporte +{n} dé et +1 à la limite pour « {action} ».', params }
          : { t: '{agent} apporte +{n} dés et +1 à la limite pour « {action} ».', params });
      if (dice < r.hits) outcomes.push({ t: 'Bonus plafonné à la compétence de {name} ({cap}).', params: { name: actor.name, cap } });
    } else outcomes.push({ t: '{agent} ne trouve rien d’utile (aucun succès).', params: { agent } });
    persona.pendingAssist = r.critGlitch ? null : { actionId: action.id, skill: action.skill, dice, limitBonus, hits: r.hits, glitch: r.glitch, ts: Date.now() };
    const authorMsg = agentAuthorMsg(ag, actor);
    const labelMsg = { t: 'Assistance — {action}', params: { action: { t: action.fr } } };
    mlog(ctx, {
      author: fr(authorMsg), authorI18n: toI18n(authorMsg), msgs: outcomes,
      roll: { ...r, label: fr(labelMsg), labelI18n: toI18n(labelMsg), breakdown: sumParts(pc.parts) + (pc.limit ? ` [${pc.limit}]` : '') },
      matrix: { actionId: action.id, actorId, agent: true, assist: true, outcomes: outcomes.map(fr) },
    });
    sfx(ctx, 'dice');
    return { pendingAssist: persona.pendingAssist, roll: { pool: r.pool, dice: r.dice, hits: r.hits, limit: r.limit, glitch: r.glitch, critGlitch: r.critGlitch }, outcomes: outcomes.map(fr), msgs: outcomes };
  }),

  // { actorId, actionId, targetId?, ... } — the agent performs the action itself (Rating × 2, deck limits, shared OS).
  'matrix/agentAct': any((ctx, p = {}) => {
    const { actor, persona } = ownPersona(ctx, p.actorId);
    requireOnline(ctx, actor, persona);
    if (!persona.agent || !persona.agent.loaded) ctx.fail('Ton agent n’est pas chargé');
    const action = ACTION_BY_ID[p.actionId];
    if (!action) ctx.fail('Action matricielle inconnue');
    if (action.noTest || action.id === 'jackOut') ctx.fail('Ton agent ne peut pas faire cette action à ta place');
    return performAction(ctx, actor, persona, action, { ...p, assistFromAgent: false, edge: false, useSpec: false }, { agent: true });
  }),

  // { actorId, actionId, targetId?, modifier?, edge?, useSpec?, marks?, assistFromAgent?, fileOp?, command?, threshold?, targetName?, defensePool? (GM) }
  'matrix/action': any((ctx, p = {}) => {
    const { actor, persona } = ownPersona(ctx, p.actorId);
    const action = ACTION_BY_ID[p.actionId];
    if (!action) ctx.fail('Action matricielle inconnue');
    // Rebooting your own deck also works offline (clears the Overwatch Score and marks).
    if (action.id === 'rebootSelf' && !persona.online) {
      if (persona.bricked) ctx.fail('Le deck de {name} est briqué : il doit être réparé', { name: actor.name });
    } else requireOnline(ctx, actor, persona);
    return performAction(ctx, actor, persona, action, p);
  }),

  // Owner/GM: { actorId, fileId } — share recovered paydata with the team. A player creates a party note (Notes › groupe,
  // folder « Matrice »); the GM creates a handout revealed to every player (Dossiers). The text is stored in the table language.
  'matrix/shareFile': any((ctx, { actorId, fileId } = {}) => {
    const { actor, persona } = ownPersona(ctx, actorId);
    const f = persona.files.find((x) => x.id === fileId);
    if (!f) ctx.fail('Fichier introuvable');
    const tr = (key, params) => (ctx.t ? ctx.t(key, params) : formatFr(key, params));
    const head = f.hostName
      ? tr(tk('Récupéré par {name} sur l’hôte « {host} ».'), { name: actor.name, host: f.hostName })
      : tr(tk('Récupéré par {name} dans la Matrice.'), { name: actor.name });
    const body = `*${head}*\n\n${f.content || tr(tk('Contenu à décrire par le MJ.'))}`;
    let out;
    if (ctx.isGM) {
      const handoutId = campaignModule.actions['campaign/addHandout'].handler(ctx, { title: f.name, body });
      campaignModule.actions['campaign/revealHandout'].handler(ctx, { handoutId, to: 'all' });
      out = { handoutId };
    } else {
      out = notesModule.actions['notes/create'].handler(ctx, { scope: 'party', title: f.name, folder: tr(tk('Matrice')), body });
      sfx(ctx, 'notify', 'gm');
    }
    f.shared = true;
    return out;
  }),

  // Owner/GM: end full matrix defense. { actorId, on }
  'matrix/setFullDefense': any((ctx, { actorId, on } = {}) => {
    const { persona } = ownPersona(ctx, actorId);
    persona.fullDefense = !!on;
    return { fullDefense: persona.fullDefense };
  }),

  // ---------------- GM ----------------
  // { name, rating, preset, folder?, ic?: bool (default suite, default true) } → { id }
  'matrix/hostCreate': gm((ctx, p = {}) => {
    const m = slice(ctx.state);
    const rating = clampInt(p.rating, 1, 12, 3);
    const preset = HOST_PRESETS[p.preset] ? p.preset : 'shell';
    const id = uid('host');
    const host = { id, name: str(p.name, 80).trim() || (ctx.t ? ctx.t(tk('Hôte {n}'), { n: rating }) : formatFr('Hôte {n}', { n: rating })), rating, ...hostAttributes(rating, preset), alert: 'none', visible: false, folder: str(p.folder, 60) };
    host.ic = p.ic === false ? [] : defaultIcFor(rating).map((type, i) => ({ id: uid('ic'), type, rating, active: i === 0 && type === 'patrol', damage: 0 }));
    m.hosts[id] = normalizeHost(host, id);
    return { id };
  }),

  // { hostId, patch: { name, rating, attack, sleaze, dataProcessing, firewall, alert, visible, notes, description, folder, spider, spiderAlert, ic, files, devices, perceivedBy, spotted } }
  'matrix/hostUpdate': gm((ctx, { hostId, patch } = {}) => {
    const h = getHost(ctx, hostId);
    if (!isObj(patch)) ctx.fail('Modification invalide');
    const wasAlert = h.alert;
    const devKey = (d) => `${deviceWorks(d)}|${d.on !== false}|${d.link ? `${d.link.mapId}:${d.link.kind}:${d.link.targetId}` : ''}`;
    const devBefore = new Map((h.devices || []).map((d) => [d.id, devKey(d)]));
    const keys = ['name', 'rating', ...ASDF, 'alert', 'visible', 'notes', 'description', 'folder', 'spider', 'spiderAlert', 'ic', 'files', 'devices', 'perceivedBy', 'spotted'];
    for (const k of keys) if (patch[k] !== undefined) h[k] = patch[k];
    normalizeHost(h, h.id);
    // Linked lights / cameras follow a device whose state or link changed (GM toggles « Hors ligne », repairs, links it).
    for (const d of h.devices) if (devBefore.get(d.id) !== devKey(d)) syncDeviceLink(ctx, d);
    if (wasAlert !== h.alert) {
      const inside = Object.values(slice(ctx.state).personas).some((p) => p.online && p.hostId === h.id);
      const msg = h.alert === 'active' ? { t: 'L’hôte {host} passe en alerte !', params: { host: h.name } } : { t: 'L’hôte {host} revient au calme.', params: { host: h.name } };
      mlog(ctx, { author: h.name, gmOnly: !inside, msgs: [msg], matrix: { event: 'alert', hostId: h.id } });
      if (h.alert === 'active') sfx(ctx, 'alarm', inside ? 'all' : 'gm');
    }
    return { host: h };
  }),

  'matrix/hostDelete': gm((ctx, { hostId } = {}) => {
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
  'matrix/icLaunch': gm((ctx, { hostId, type, icId } = {}) => {
    const h = getHost(ctx, hostId);
    let ic;
    if (icId) {
      ic = h.ic.find((x) => x.id === icId);
      if (!ic) ctx.fail('IC introuvable');
    } else {
      if (!IC_TYPES[type]) ctx.fail('Type d’IC inconnu');
      ic = { id: uid('ic'), type, rating: h.rating, active: false, damage: 0 };
      h.ic.push(ic);
    }
    activateIc(ctx, h, ic);
    return { ic };
  }),

  // { hostId } — the next IC of the host's suite (not running, not crashed) is launched.
  'matrix/launchNextIc': gm((ctx, { hostId } = {}) => {
    const h = getHost(ctx, hostId);
    const msg = launchNextIc(ctx, h);
    if (!msg) ctx.fail('Toutes les IC de cet hôte tournent déjà (ou sont plantées)');
    return { outcomes: [fr(msg)], msgs: [msg] };
  }),

  // { hostId, icId, actorId?, entryId? } — one IC acts (target picked automatically unless actorId). entryId: its combat
  // entry, whose turn ends afterwards (« Agir et passer » in the tracker).
  'matrix/icTurn': gm((ctx, { hostId, icId, actorId, entryId } = {}) => {
    const h = getHost(ctx, hostId);
    const ic = h.ic.find((x) => x.id === icId);
    if (!ic) ctx.fail('IC introuvable');
    const r = icTakesTurn(ctx, h, ic, actorId ? str(actorId, 60) : null);
    if (entryId) r.advanced = endTurnOf(ctx, str(entryId, 60));
    return r;
  }),

  // { hostId, launch = true } — the whole host acts once: an alerted host launches its next IC, then every running IC
  // takes its action against an automatic target. Outside a fight, one click per Combat Turn.
  'matrix/hostTurn': gm((ctx, { hostId, launch = true } = {}) => {
    const h = getHost(ctx, hostId);
    const msgs = [];
    if (launch !== false && h.alert === 'active') {
      const l = launchNextIc(ctx, h);
      if (l) msgs.push(l);
    }
    const results = [];
    for (const ic of h.ic.filter((x) => x.active && IC_TYPES[x.type])) {
      if (!ic.active) continue; // crashed meanwhile
      results.push(icTakesTurn(ctx, h, ic, null));
    }
    if (!results.length) msgs.push({ t: 'Aucune IC active dans {host}.', params: { host: h.name } });
    return { results, outcomes: msgs.map(fr), msgs };
  }),

  // { hostId } — puts the host's spider (the alert one when the host is on alert) into the fight, without a token.
  'matrix/spawnSpider': gm((ctx, { hostId } = {}) => {
    const h = getHost(ctx, hostId);
    const templateId = h.alert === 'active' ? h.spiderAlert || h.spider : h.spider || h.spiderAlert;
    if (!templateId || !ctx.state.bestiary?.[templateId]) ctx.fail('Aucune araignée choisie pour cet hôte');
    return combatModule.actions['bestiary/spawn'].handler(ctx, { templateId, mapId: null, addToCombat: true });
  }),

  // { actorId } — 15 minutes go by: the decker's OS rises by 2D6 (rolled in secret, GM-only log).
  'matrix/osTick': gm((ctx, { actorId } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const r = osTick(ctx, actor, persona, 1);
    return { added: r.added, overwatch: persona.overwatch, convergence: r.convergence ? r.convergence.map(fr) : null, convergenceMsgs: r.convergence };
  }),

  // { hostId, icId, patch: { active, damage, rating, detected } }
  'matrix/icUpdate': gm((ctx, { hostId, icId, patch } = {}) => {
    const h = getHost(ctx, hostId);
    const idx = h.ic.findIndex((x) => x.id === icId);
    if (idx < 0) ctx.fail('IC introuvable');
    const next = cleanIc({ ...h.ic[idx], ...(isObj(patch) ? patch : {}), id: icId, type: h.ic[idx].type }, h);
    h.ic[idx] = next;
    return { ic: next };
  }),

  'matrix/icRemove': gm((ctx, { hostId, icId } = {}) => {
    const h = getHost(ctx, hostId);
    h.ic = h.ic.filter((x) => x.id !== icId);
    return { ok: true };
  }),

  // { hostId, icId, actorId } — the IC attacks a persona inside the host.
  'matrix/icAct': gm((ctx, { hostId, icId, actorId } = {}) => {
    const h = getHost(ctx, hostId);
    const ic = h.ic.find((x) => x.id === icId);
    if (!ic) ctx.fail('IC introuvable');
    if (!ic.active) ctx.fail('Cette IC n’est pas lancée');
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    if (!persona.online || persona.hostId !== h.id) ctx.fail('{name} n’est pas dans cet hôte', { name: actor.name });
    return icAttack(ctx, h, ic, actor, persona);
  }),

  // { actorId, value?, delta? }
  'matrix/setOverwatch': gm((ctx, { actorId, value, delta } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const next = delta !== undefined ? persona.overwatch + clampInt(delta, -40, 40, 0) : clampInt(value, 0, OS_MAX, persona.overwatch);
    const before = persona.overwatch;
    persona.overwatch = Math.max(0, Math.min(OS_MAX, next));
    if (!persona.overwatch) persona.osClock = null;
    else if (!before || !persona.osClock) persona.osClock = ctx.now || Date.now();
    let convergence = null;
    if (persona.overwatch >= OS_MAX && persona.online && !persona.hostConverged) convergence = converge(ctx, actor, persona);
    return { overwatch: persona.overwatch, convergence: convergence ? convergence.map(fr) : null, convergenceMsgs: convergence };
  }),

  'matrix/converge': gm((ctx, { actorId } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const msgs = converge(ctx, actor, persona);
    return { outcomes: msgs.map(fr), msgs };
  }),

  'matrix/resetPersona': gm((ctx, { actorId } = {}) => {
    const actor = getActor(ctx, actorId);
    const m = slice(ctx.state);
    delete m.personas[actorId];
    if (actor.matrix) ensurePersona(ctx.state, actor);
    return { ok: true };
  }),

  // { actorId, patch: { matrixDamage, noise, bricked, traced, linkLocked: null, penalties: {}, programSlots, fullDefense, hostId, osKnown, agent: { damage, loaded } , files } }
  'matrix/setPersona': gm((ctx, { actorId, patch } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    if (!isObj(patch)) ctx.fail('Modification invalide');
    const mon = matrixMonitor(actor.matrix.rating);
    if (patch.matrixDamage !== undefined) persona.matrixDamage = clampInt(patch.matrixDamage, 0, mon, 0);
    if (patch.noise !== undefined) persona.noise = clampInt(patch.noise, 0, 30, 0);
    if (patch.bricked !== undefined) persona.bricked = !!patch.bricked;
    if (patch.traced !== undefined) persona.traced = !!patch.traced;
    if (patch.fullDefense !== undefined) persona.fullDefense = !!patch.fullDefense;
    if (patch.linkLocked === null) persona.linkLocked = null;
    if (isObj(patch.penalties)) persona.penalties = Object.fromEntries(ASDF.map((k) => [k, clampInt(patch.penalties[k], 0, 12, 0)]).filter(([, v]) => v));
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
      if (patch.hostId && !slice(ctx.state).hosts[patch.hostId]) ctx.fail('Hôte introuvable');
      persona.hostId = patch.hostId || null;
    }
    if (patch.osKnown !== undefined) persona.osKnown = patch.osKnown === null ? null : clampInt(patch.osKnown, 0, OS_MAX, 0);
    if (patch.osClock !== undefined) persona.osClock = patch.osClock === null ? null : clampInt(patch.osClock, 0, 9e15, Date.now());
    if (Array.isArray(patch.files)) persona.files = patch.files.filter(isObj).slice(0, 200).map((f) => ({ ...f, id: str(f.id, 40) || uid('pay'), name: str(f.name, 80), content: str(f.content, 4000) }));
    if (isObj(patch.agent) && persona.agent) {
      if (patch.agent.damage !== undefined) persona.agent.damage = clampInt(patch.agent.damage, 0, matrixMonitor(persona.agent.rating), 0);
      if (patch.agent.loaded !== undefined) persona.agent.loaded = !!patch.agent.loaded;
    }
    if (patch.agent === null) persona.agent = null;
    if (persona.matrixDamage < mon && patch.matrixDamage !== undefined && patch.bricked === undefined && persona.bricked) persona.bricked = false;
    return { persona };
  }),

  // { actorId, targetId, name?, count } — set the marks a persona holds (0 removes).
  'matrix/setMarks': gm((ctx, { actorId, targetId, name, count } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const key = str(targetId, 200);
    if (!key) ctx.fail('Cible invalide');
    const n = clampInt(count, 0, MAX_MARKS, 0);
    persona.marks = persona.marks.filter((m) => m.targetId !== key);
    if (n) persona.marks.push({ targetId: key, name: str(name, 80) || key, count: n });
    return { marks: persona.marks };
  }),

  // { actorId, sourceId, name?, count } — marks other icons have on the persona.
  'matrix/setMarkOnMe': gm((ctx, { actorId, sourceId, name, count } = {}) => {
    const actor = getActor(ctx, actorId);
    if (!actor.matrix) ctx.fail('{name} n’a pas d’appareil matriciel', { name: actor.name });
    const persona = ensurePersona(ctx.state, actor);
    const key = str(sourceId, 200);
    if (!key) ctx.fail('Source invalide');
    const n = clampInt(count, 0, MAX_MARKS, 0);
    persona.marksOnMe = persona.marksOnMe.filter((m) => m.sourceId !== key);
    if (n) persona.marksOnMe.push({ sourceId: key, name: str(name, 80) || key, count: n });
    return { marksOnMe: persona.marksOnMe };
  }),

  // { hideOverwatch?, osTimer?, autoLaunchIc? }
  'matrix/settings': gm((ctx, p = {}) => {
    const m = slice(ctx.state);
    if (p.hideOverwatch !== undefined) m.settings.hideOverwatch = !!p.hideOverwatch;
    if (p.osTimer !== undefined) {
      m.settings.osTimer = !!p.osTimer;
      // Turning the timer on starts the clock now (no burst of ticks for the time it was off).
      if (m.settings.osTimer) for (const per of Object.values(m.personas)) if (per.overwatch > 0) per.osClock = ctx.now || Date.now();
    }
    if (p.autoLaunchIc !== undefined) m.settings.autoLaunchIc = !!p.autoLaunchIc;
    return { settings: m.settings };
  }),
};

if (process.env.SR_MATRIX_TEST === '1') {
  // Test hook only: load the dice ('actor' wins, 'opposition' wins, 'glitch', or null = random).
  actions['matrix/testDice'] = gm((ctx, { mode } = {}) => {
    testDice = ['actor', 'opposition', 'glitch'].includes(mode) ? mode : null;
    return { mode: testDice };
  });
}

export default {
  name: 'matrix',

  init(state, { readSeed }) {
    const m = slice(state);
    const seed = readSeed('matrix.json', null);
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
    const personas = {};
    for (const id of own) {
      const p = m.personas?.[id];
      if (!p) continue;
      if (m.settings?.hideOverwatch && !loadedProgramIds(p).has('babyMonitor')) {
        p.overwatch = p.osKnown ?? null;
        p.overwatchHidden = true;
      }
      personas[id] = p;
    }
    m.personas = personas;
    const evaluate = Object.values(personas).some((p) => loadedProgramIds(p).has('evaluate'));
    const hosts = {};
    for (const h of Object.values(full.matrix?.hosts || {})) {
      if (!canSeeHost(full, user, h)) continue;
      const inside = Object.values(personas).some((p) => p.online && p.hostId === h.id);
      const perceived = perceivedBy(h, own);
      const out = { id: h.id, name: h.name, alert: h.alert, visible: !!h.visible, inside, perceived, description: h.description || '', spotted: (h.spotted || []).some((id) => own.includes(id)) };
      if (perceived) {
        out.rating = h.rating;
        for (const k of ASDF) out[k] = h[k];
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
      hosts[h.id] = out;
    }
    m.hosts = hosts;
    for (const e of view.log || []) if (e.kind === 'matrix' && e.matrix?.gm) delete e.matrix.gm;
  },
};
