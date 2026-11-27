// Bestiary (NPC templates) + combat / initiative tracker.
// Slices owned: state.bestiary, state.bestiaryRemoved, state.combat (see ARCHITECTURE.md).
import fs from 'node:fs';
import path from 'node:path';
import { rollInitiative, attr, ATTRS } from '../../shared/sr5.js';
// deriveFull = derive() + modifiers of gear / qualities / implants (monitors, pain tolerance, matrix initiative dice — shared/modifiers.js).
import { deriveFull as derive } from '../lib/modifiers.js';
import { fillActorRefs } from '../lib/bookrefs.js';
import { uid, clamp, deepClone } from '../../shared/util.js';
import { pruneExpired } from '../../shared/combat.js';
import { thrownGearToWeapons } from './10-characters.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DISPOSITIONS = ['pc', 'ally', 'neutral', 'hostile'];
const NPC_KINDS = ['metahuman', 'critter', 'drone', 'ic', 'host', 'spirit', 'other'];
const INIT_MODES = ['physical', 'astral', 'ar', 'cold', 'hot'];
/** Marks a translatable key for tools/i18n-check.js (English in client/i18n/en/combat.json). */
const tk = (s) => s;
const INIT_MODE_LABELS = { physical: tk('physique'), astral: tk('astrale'), ar: tk('RA'), cold: tk('VR froide'), hot: tk('VR chaude') };
/** Interrupt-action labels sent by the combat dock (French keys, translated by the client in the log). */
const ADJUST_LABELS = new Set([tk('Esquive / parade'), tk('Défense totale')]);
// Tiles a token may stand on (see the tile legend). 'D' is handled separately (door state).
const PASSABLE = new Set(['.', ',', 's', 'e', 'g', 'r', 'x', 't', '_']);
const AUTHOR = 'Initiative';
const UNDO_MAX = 30;

// In-memory undo stacks for combat/prev, one per table state (not persisted: an undo across restarts is not needed).
const undoStacks = new WeakMap(); // state -> [combat snapshots]
function undoOf(state) {
  let s = undoStacks.get(state);
  if (!s) undoStacks.set(state, (s = []));
  return s;
}

// ---------------------------------------------------------------------------
// Sanitizing (templates come from the GM UI, imports and seeds)
// ---------------------------------------------------------------------------
const str = (v, max = 300) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const num = (v, d = 0, lo = -1e6, hi = 1e6) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : d;
};
const int = (v, d = 0, lo = -1e6, hi = 1e6) => Math.round(num(v, d, lo, hi));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Keep only primitive values (and arrays of primitives / flat objects) from a list item. */
function cleanItem(o, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.length > 40) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 4000);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).slice(0, 100);
    else if (isObj(v)) {
      const flat = {};
      for (const [k2, v2] of Object.entries(v)) if (['string', 'number', 'boolean'].includes(typeof v2)) flat[k2] = typeof v2 === 'string' ? v2.slice(0, 1000) : v2;
      out[k] = flat;
    }
  }
  if (typeof out.id !== 'string' || !out.id) out.id = uid(prefix);
  out.name = str(out.name, 200);
  return out;
}
function cleanList(v, prefix, fix) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const list = [];
  for (const raw of v.slice(0, 300)) {
    if (!isObj(raw)) continue;
    const it = cleanItem(raw, prefix);
    if (seen.has(it.id)) it.id = uid(prefix);
    seen.add(it.id);
    list.push(fix ? fix(it) : it);
  }
  return list;
}

/** Normalize a template (tolerant: unknown primitive fields are kept). */
export function sanitizeTemplate(raw, { id } = {}) {
  const t = isObj(raw) ? raw : {};
  const out = {};
  // Keep extra primitive top-level fields (forward compatible), then normalize the known ones.
  for (const [k, v] of Object.entries(t)) {
    if (['string', 'number', 'boolean'].includes(typeof v) && k.length <= 40) out[k] = typeof v === 'string' ? v.slice(0, 20000) : v;
  }
  out.id = id || (typeof t.id === 'string' && t.id ? t.id.slice(0, 80) : uid('tpl'));
  out.type = 'npc';
  out.name = str(t.name, 120).trim() || 'PNJ sans nom';
  out.folder = str(t.folder, 60).trim() || 'Divers';
  out.metatype = str(t.metatype, 40) || 'Humain';
  for (const k of ['concept', 'gender', 'portrait', 'color']) out[k] = str(t[k], k === 'portrait' ? 500 : 120);
  out.description = str(t.description, 20000);
  if (t.gmNotes) out.gmNotes = str(t.gmNotes, 20000);
  if (t.bio) out.bio = str(t.bio, 20000);
  out.disposition = DISPOSITIONS.includes(t.disposition) && t.disposition !== 'pc' ? t.disposition : 'hostile';

  const attrs = isObj(t.attributes) ? t.attributes : {};
  out.attributes = {};
  for (const k of ATTRS) {
    if (k === 'ESS') out.attributes.ESS = Math.round(num(attrs.ESS, 6, 0, 6) * 100) / 100;
    else if (k === 'MAG' || k === 'RES') {
      if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== '' && Number(attrs[k]) > 0) out.attributes[k] = int(attrs[k], 0, 0, 20);
    } else out.attributes[k] = int(attrs[k], k === 'EDG' ? 1 : 3, 0, 30);
  }
  out.augmented = {};
  if (isObj(t.augmented)) for (const k of ATTRS) if (Number(t.augmented[k])) out.augmented[k] = int(t.augmented[k], 0, -10, 10);
  out.initiative = { dice: int(t.initiative?.dice, 1, 1, 5), bonus: int(t.initiative?.bonus, 0, -20, 30) };
  if (isObj(t.monitors)) {
    const m = {};
    if (t.monitors.physical !== undefined && t.monitors.physical !== null && t.monitors.physical !== '') m.physical = int(t.monitors.physical, 10, 0, 60);
    if (t.monitors.stun !== undefined && t.monitors.stun !== null && t.monitors.stun !== '') m.stun = int(t.monitors.stun, 10, 0, 60);
    if (Object.keys(m).length) out.monitors = m;
  }
  out.skills = cleanList(t.skills, 'sk', (s) => {
    s.id = str(s.id || s.name, 60) || uid('sk');
    s.rating = int(s.rating, 0, 0, 20);
    if (!ATTRS.includes(s.attr)) s.attr = 'AGI';
    return s;
  });
  out.knowledge = cleanList(t.knowledge, 'k', (k) => ({ ...k, rating: int(k.rating, 0, 0, 20) }));
  out.qualities = cleanList(t.qualities, 'q', (q) => ({ ...q, karma: int(q.karma, 0, -100, 100), positive: q.positive !== false }));
  out.powers = cleanList(t.powers, 'p');
  out.spells = cleanList(t.spells, 's');
  out.weapons = cleanList(t.weapons, 'w', (w) => ({ ...w, kind: w.kind === 'melee' ? 'melee' : 'ranged', damage: str(w.damage, 40) }));
  out.armor = cleanList(t.armor, 'a', (a) => ({ ...a, rating: int(a.rating, 0, 0, 50), equipped: a.equipped !== false, stack: !!a.stack }));
  out.augmentations = cleanList(t.augmentations, 'x', (x) => ({ ...x, essence: num(x.essence, 0, 0, 6) }));
  out.gear = cleanList(t.gear, 'g', (g) => ({ ...g, qty: int(g.qty, 1, 0, 9999) }));
  out.vehicles = cleanList(t.vehicles, 'v');
  out.knowledge = out.knowledge.filter((k) => k.name);
  if (isObj(t.matrix)) {
    out.matrix = {
      device: str(t.matrix.device, 120),
      rating: int(t.matrix.rating, 0, 0, 12),
      attack: int(t.matrix.attack, 0, 0, 20),
      sleaze: int(t.matrix.sleaze, 0, 0, 20),
      dataProcessing: int(t.matrix.dataProcessing, 0, 0, 20),
      firewall: int(t.matrix.firewall, 0, 0, 20),
      programs: Array.isArray(t.matrix.programs) ? t.matrix.programs.map((p) => str(p, 80)).filter(Boolean).slice(0, 40) : [],
    };
  }
  const vis = isObj(t.vision) ? t.vision : {};
  out.vision = {};
  if (vis.lowLight) out.vision.lowLight = true;
  if (vis.thermo) out.vision.thermo = true;
  if (Number(vis.darkRange) > 0) out.vision.darkRange = int(vis.darkRange, 0, 0, 60);
  const npc = isObj(t.npc) ? t.npc : {};
  out.npc = {
    professionalRating: int(npc.professionalRating, 0, 0, 7),
    grunt: !!npc.grunt,
    kind: NPC_KINDS.includes(npc.kind) ? npc.kind : 'metahuman',
    initMode: INIT_MODES.includes(npc.initMode) ? npc.initMode : 'physical',
    tactics: str(npc.tactics, 20000),
    loot: str(npc.loot, 20000),
  };
  if (Array.isArray(t.tags)) out.tags = t.tags.map((x) => str(x, 40)).filter(Boolean).slice(0, 20);
  fillActorRefs(out); // 📖 rulebook references of the items (catalog id / name), shown in the stat blocks
  return out;
}

/** Template → runtime NPC actor (deep copy, fresh condition). */
function actorFromTemplate(tpl, { id, name, hidden }) {
  const a = deepClone(tpl);
  delete a.folder;
  delete a.description;
  delete a.tags;
  a.id = id;
  a.type = 'npc';
  a.templateId = tpl.id;
  a.name = name;
  a.gmNotes = [tpl.gmNotes, tpl.description].filter(Boolean).join('\n\n');
  a.condition = { physical: 0, stun: 0, overflow: 0 };
  a.edge = { current: Number(tpl.attributes?.EDG) || 0 };
  for (const k of ['skills', 'knowledge', 'qualities', 'powers', 'spells', 'weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'contacts', 'sins', 'history']) {
    if (!Array.isArray(a[k])) a[k] = [];
  }
  a.karma = 0;
  a.karmaTotal = 0;
  a.nuyen = 0;
  a.streetCred = 0;
  a.notoriety = 0;
  a.publicAwareness = 0;
  a.hidden = !!hidden;
  thrownGearToWeapons(a, uid); // grenades / Molotovs listed as gear in the template: throwable weapons
  return a;
}

/** Runtime actor → template (used by bestiary/fromActor). */
function templateFromActor(actor) {
  const t = deepClone(actor);
  for (const k of ['id', 'type', 'templateId', 'condition', 'edge', 'history', 'training', 'player', 'retired', 'hidden', 'karma', 'karmaTotal', 'nuyen', 'streetCred', 'notoriety', 'publicAwareness', 'contacts', 'sins', 'lifestyle', 'lifestyles']) delete t[k];
  if (actor.gmNotes) t.description = actor.gmNotes;
  delete t.gmNotes;
  return t;
}

// ---------------------------------------------------------------------------
// Map helpers (spawn placement)
// ---------------------------------------------------------------------------
function cellPassable(map, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= (map.width || 0) || y >= (map.height || 0)) return false;
  const ch = (map.tiles?.[y] || '')[x] ?? ' ';
  if (ch === 'D') {
    const door = (map.doors || []).find((d) => d.x === x && d.y === y);
    return !door || door.state === 'open';
  }
  return PASSABLE.has(ch);
}

function occupiedCells(map) {
  const occ = new Set();
  for (const t of map.tokens || []) {
    const size = Math.max(1, Number(t.size) || 1);
    for (let dx = 0; dx < size; dx++) for (let dy = 0; dy < size; dy++) occ.add(`${t.x + dx},${t.y + dy}`);
  }
  return occ;
}

/**
 * Nearest free passable cell around (x, y). First a flood fill from the start cell (so a group stays in
 * the same room), then a ring ("spiral") search over the whole map as a fallback.
 */
export function findFreeCell(map, x, y, occ) {
  const W = map.width || 0;
  const H = map.height || 0;
  if (!W || !H) return null;
  let sx = Number.isFinite(Number(x)) ? Math.round(Number(x)) : Math.floor(W / 2);
  let sy = Number.isFinite(Number(y)) ? Math.round(Number(y)) : Math.floor(H / 2);
  sx = clamp(sx, 0, W - 1);
  sy = clamp(sy, 0, H - 1);
  const free = (cx, cy) => cellPassable(map, cx, cy) && !occ.has(`${cx},${cy}`);
  if (cellPassable(map, sx, sy)) {
    const seen = new Set([`${sx},${sy}`]);
    const queue = [[sx, sy]];
    for (let i = 0; i < queue.length && i < 20000; i++) {
      const [cx, cy] = queue[i];
      if (free(cx, cy)) return { x: cx, y: cy };
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        const k = `${nx},${ny}`;
        if (seen.has(k) || !cellPassable(map, nx, ny)) continue;
        // No diagonal squeeze between two blocking cells.
        if (dx && dy && !cellPassable(map, cx + dx, cy) && !cellPassable(map, cx, cy + dy)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
  }
  const maxR = Math.max(W, H);
  for (let r = 0; r <= maxR; r++) {
    const ring = [];
    for (let cx = sx - r; cx <= sx + r; cx++) {
      for (let cy = sy - r; cy <= sy + r; cy++) {
        if (Math.max(Math.abs(cx - sx), Math.abs(cy - sy)) !== r) continue;
        ring.push([cx, cy, (cx - sx) ** 2 + (cy - sy) ** 2]);
      }
    }
    ring.sort((a, b) => a[2] - b[2]);
    for (const [cx, cy] of ring) if (free(cx, cy)) return { x: cx, y: cy };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Combat helpers
// ---------------------------------------------------------------------------
function emptyCombat() {
  return { active: false, mapId: null, round: 1, pass: 1, turn: -1, currentId: null, entries: [] };
}

function combatOf(ctx, { requireActive = true } = {}) {
  const c = ctx.state.combat;
  if (requireActive && !c?.active) ctx.fail('Aucun combat en cours');
  return c;
}

function getEntry(ctx, c, entryId) {
  const e = c.entries.find((x) => x.id === entryId);
  if (!e) ctx.fail('Participant introuvable');
  return e;
}

function requireOwner(ctx, e) {
  if (ctx.isGM) return;
  if (e.hidden || !e.actorId || !ctx.owns(e.actorId)) ctx.fail('Ce n’est pas ton personnage');
}

function isPC(state, e) {
  return state.actors[e.actorId]?.type === 'pc';
}

/** Can this entry act right now (in the current pass)? */
function canAct(e) {
  return !e.out && !e.down && !e.toRoll && !e.acted && !e.delayed && e.score > 0;
}

function initFor(actor, mode) {
  const d = derive(actor);
  switch (mode) {
    case 'astral':
      return d.astralInitiative;
    case 'ar':
      return { base: d.initiative.base, dice: d.initiative.dice };
    case 'cold':
      return d.matrixInitiative.cold;
    case 'hot':
      return d.matrixInitiative.hot;
    default:
      return d.initiative;
  }
}

function isIncapacitated(actor) {
  if (!actor) return false;
  const d = derive(actor);
  const c = actor.condition || {};
  return (d.physicalMonitor > 0 && (c.physical || 0) >= d.physicalMonitor) || (d.stunMonitor > 0 && (c.stun || 0) >= d.stunMonitor);
}

/** Apply wound modifier changes to scores (SR5: wound modifiers apply to the initiative score) and refresh 'down'. */
function syncActors(state, c) {
  for (const e of c.entries) {
    const actor = state.actors[e.actorId];
    if (!actor) {
      e.out = true;
      continue;
    }
    e.down = isIncapacitated(actor);
    if (e.toRoll) continue;
    const wm = derive(actor).woundModifier;
    if (wm !== (e.wound || 0)) {
      const delta = wm - (e.wound || 0);
      e.score += delta;
      e.total = (e.total || 0) + delta;
      e.wound = wm;
    }
  }
}

function sortEntries(state, c) {
  const val = (e, k) => attr(state.actors[e.actorId], k);
  c.entries.sort((a, b) => {
    if (!!a.toRoll !== !!b.toRoll) return a.toRoll ? 1 : -1;
    if (!!a.out !== !!b.out) return a.out ? 1 : -1;
    if (!!a.seized !== !!b.seized) return a.seized ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const edg = val(b, 'EDG') - val(a, 'EDG');
    if (edg) return edg;
    const rea = val(b, 'REA') - val(a, 'REA');
    if (rea) return rea;
    return String(a.name).localeCompare(String(b.name), 'fr');
  });
  const idx = c.entries.findIndex((e) => e.id === c.currentId);
  if (idx < 0) c.currentId = null;
  c.turn = idx;
}

/**
 * Pay an initiative cost (interrupt actions, R&G Finishing Move…) for an actor in the running combat: score − cost, logged.
 * Returns the new score, or null when the actor is not in an active combat (nothing to pay). `label` = French key.
 */
export function spendInitiative(ctx, actorId, cost, label) {
  const c = ctx.state.combat;
  const n = Math.max(0, Math.round(Number(cost) || 0));
  if (!c?.active || !n) return null;
  const e = c.entries.find((x) => x.actorId === actorId && !x.out);
  if (!e || e.toRoll) return null;
  syncActors(ctx.state, c);
  e.score -= n;
  e.adjust = (e.adjust || 0) - n;
  logCombat(ctx, tk('{name} : {label} ({delta} initiative → {score})'), { name: e.name, label: { t: label }, delta: `-${n}`, score: e.score }, { gmOnly: !!e.hidden });
  sortEntries(ctx.state, c);
  return e.score;
}

/** Key of the current Combat Turn (« once per turn » actions, defenses already made this turn) or null outside combat. */
export function combatTurnKey(state) {
  const c = state.combat;
  return c?.active ? `${c.startedAt || 0}:${c.round || 1}` : null;
}

function ownersOf(state, actorId) {
  return Object.values(state.users || {})
    .filter((u) => (u.characterIds || []).includes(actorId))
    .map((u) => u.id);
}

/** Combat log entry: `key` = French text with {placeholders} (translated by the client), `params` = named values. */
function logCombat(ctx, key, params, { gmOnly = false } = {}) {
  ctx.log({ kind: 'combat', author: AUTHOR, userId: ctx.user.id, i18n: { key, params }, ...(gmOnly ? { gmOnly: true } : {}) });
}

function setCurrent(ctx, c, entry) {
  c.currentId = entry ? entry.id : null;
  sortEntries(ctx.state, c);
  if (!entry) return;
  const owners = ownersOf(ctx.state, entry.actorId);
  if (owners.length) ctx.emitTo(owners, 'sfx', { id: 'notify' });
}

function firstActable(state, c) {
  sortEntries(state, c);
  return c.entries.find(canAct) || null;
}

/** Roll initiative for one entry (mode from the entry, Blitz = 5D6). */
function doRoll(ctx, c, e, { blitz = false } = {}) {
  const actor = ctx.state.actors[e.actorId];
  if (!actor) ctx.fail('Ce participant n’a pas de fiche');
  const mode = INIT_MODES.includes(e.mode) ? e.mode : 'physical';
  const { base, dice } = initFor(actor, mode);
  const nd = blitz ? 5 : dice;
  const r = rollInitiative(base, nd);
  const wm = derive(actor).woundModifier;
  e.base = base;
  e.dice = nd;
  e.rolls = r.rolls;
  e.wound = wm;
  e.adjust = 0;
  e.blitz = !!blitz;
  e.total = r.total + wm;
  e.score = e.total - 10 * ((c.pass || 1) - 1);
  e.toRoll = false;
  e.down = isIncapacitated(actor);
  return e;
}

/** Initiative roll detail as a translatable value { t, params } (French: « 14 — 8 + 2D6 (3, 3) · -1 blessures »). */
function rollText(e) {
  let detail = { t: tk('{base} + {dice}D6 ({rolls})'), params: { base: e.base, dice: e.dice, rolls: (e.rolls || []).join(', ') } };
  const add = (part) => (detail = { t: '{a} · {b}', params: { a: detail, b: part } });
  if (e.wound) add({ t: '{n} blessures', params: { n: e.wound } });
  if (e.mode && e.mode !== 'physical') add({ t: INIT_MODE_LABELS[e.mode] });
  if (e.blitz) add('Blitz');
  return { t: '{total} — {detail}', params: { total: e.total, detail } };
}
/** "Name 12, Other 9" (names and numbers only, no translation needed). */
const scoreList = (entries, withRolls = false) => entries.map((e) => (withRolls ? `${e.name} ${e.total} [${e.rolls.join(',')}]` : `${e.name} ${e.total}`)).join(', ');

/** Once nobody is waiting to roll, the first actor gets the turn. */
function maybeAutoStart(ctx, c) {
  if (!c.active || c.currentId) return;
  const live = c.entries.filter((e) => !e.out && !e.down);
  if (!live.length || live.some((e) => e.toRoll)) return;
  const first = firstActable(ctx.state, c);
  if (first) {
    setCurrent(ctx, c, first);
    logCombat(ctx, tk('Tour {round} : {name} agit en premier.'), { round: c.round, name: first.name }, { gmOnly: !!first.hidden });
  }
}

function makeEntry(state, actor, token) {
  const pc = actor.type === 'pc';
  return {
    id: uid('ini'),
    actorId: actor.id,
    tokenId: token?.id || null,
    name: token?.name || actor.name,
    kind: pc ? 'pc' : 'npc',
    disposition: token?.disposition || (pc ? 'pc' : 'hostile'),
    base: 0,
    dice: 0,
    rolls: [],
    total: 0,
    score: 0,
    wound: 0,
    adjust: 0,
    acted: false,
    delayed: false,
    hidden: !!(token ? token.hidden : !pc && actor.hidden),
    out: false,
    down: isIncapacitated(actor),
    toRoll: true,
    seized: false,
    blitz: false,
    mode: INIT_MODES.includes(actor.npc?.initMode) ? actor.npc.initMode : 'physical',
  };
}

/** Add entries for tokens/actors. NPCs are rolled immediately; PCs are « à lancer ». */
function addEntries(ctx, c, { tokenIds, actorIds, rollNpcs = true }) {
  const state = ctx.state;
  const added = [];
  const has = (tok, actorId) => c.entries.some((e) => (tok ? e.tokenId === tok.id : !e.tokenId && e.actorId === actorId));
  const findToken = (tid) => {
    const preferred = c.mapId && state.maps?.[c.mapId];
    const t = preferred && (preferred.tokens || []).find((x) => x.id === tid);
    if (t) return t;
    for (const m of Object.values(state.maps || {})) {
      const found = (m.tokens || []).find((x) => x.id === tid);
      if (found) return found;
    }
    return null;
  };
  for (const tid of Array.isArray(tokenIds) ? tokenIds.slice(0, 200) : []) {
    const tok = findToken(tid);
    if (!tok || !tok.actorId || !state.actors[tok.actorId] || has(tok)) continue;
    const e = makeEntry(state, state.actors[tok.actorId], tok);
    c.entries.push(e);
    added.push(e);
  }
  for (const aid of Array.isArray(actorIds) ? actorIds.slice(0, 200) : []) {
    const actor = state.actors[aid];
    if (!actor || has(null, aid)) continue;
    const e = makeEntry(state, actor, null);
    c.entries.push(e);
    added.push(e);
  }
  const npcRolls = [];
  for (const e of added) {
    if (rollNpcs && e.kind !== 'pc') {
      doRoll(ctx, c, e);
      npcRolls.push(e);
    }
  }
  if (npcRolls.length) logCombat(ctx, tk('Initiative PNJ : {list}'), { list: scoreList(npcRolls) }, { gmOnly: true });
  sortEntries(state, c);
  return added;
}

function pushUndo(ctx, c) {
  const stack = undoOf(ctx.state);
  stack.push(deepClone(c));
  if (stack.length > UNDO_MAX) stack.shift();
}

/** New combat turn: everybody rerolls (NPCs automatically, PCs « à lancer »). */
function newCombatTurn(ctx, c) {
  c.round = (c.round || 1) + 1;
  c.pass = 1;
  c.currentId = null;
  const npcRolls = [];
  for (const e of c.entries) {
    e.acted = false;
    e.delayed = false;
    e.seized = false;
    e.blitz = false;
    e.adjust = 0;
    if (e.kind === 'pc' || isPC(ctx.state, e)) {
      e.toRoll = true;
      e.score = 0;
      e.total = 0;
      e.rolls = [];
    } else if (ctx.state.actors[e.actorId]) {
      doRoll(ctx, c, e);
      npcRolls.push(e);
    }
  }
  logCombat(ctx, tk('— Tour de combat {round} — lancez l’initiative !'), { round: c.round });
  pruneExpired(ctx.state, ctx.now); // explosion markers of the last turn, afflictions that ran out (shared/combat.js)
  if (npcRolls.length) logCombat(ctx, tk('Initiative PNJ : {list}'), { list: scoreList(npcRolls) }, { gmOnly: true });
  sortEntries(ctx.state, c);
  const waiting = c.entries.filter((e) => e.toRoll && !e.out && !e.down);
  for (const e of waiting) {
    const owners = ownersOf(ctx.state, e.actorId);
    if (owners.length) ctx.emitTo(owners, 'sfx', { id: 'notify' });
  }
  maybeAutoStart(ctx, c);
}

/** Move to the next actor (marks the current one as having acted unless markActed=false). */
function advance(ctx, c, { markActed = true } = {}) {
  const cur = c.entries.find((e) => e.id === c.currentId);
  if (cur && markActed) {
    cur.acted = true;
    cur.delayed = false;
  }
  let next = firstActable(ctx.state, c);
  if (!next) {
    const anotherPass = c.entries.some((e) => !e.out && !e.down && !e.toRoll && e.score - 10 > 0);
    if (anotherPass) {
      c.pass += 1;
      for (const e of c.entries) {
        if (!e.toRoll) e.score -= 10;
        e.acted = false;
        e.delayed = false;
      }
      logCombat(ctx, tk('Passe d’initiative {n}'), { n: c.pass });
      next = firstActable(ctx.state, c);
    } else {
      newCombatTurn(ctx, c);
      return;
    }
  }
  setCurrent(ctx, c, next);
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
export default {
  name: 'combat',

  init(state, { seedDir }) {
    state.bestiary = isObj(state.bestiary) ? state.bestiary : {};
    state.bestiaryRemoved = Array.isArray(state.bestiaryRemoved) ? state.bestiaryRemoved : [];
    const removed = new Set(state.bestiaryRemoved);
    const dir = path.join(seedDir, 'bestiary');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        let data;
        try {
          data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (err) {
          console.warn(`[combat] seed ${f} illisible : ${err.message}`);
          continue;
        }
        const list = Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : isObj(data) ? [data] : [];
        for (const t of list) {
          if (!isObj(t) || typeof t.id !== 'string' || !t.id) continue;
          if (state.bestiary[t.id] || removed.has(t.id)) continue;
          state.bestiary[t.id] = sanitizeTemplate(t, { id: t.id });
        }
      }
    }
    for (const t of Object.values(state.bestiary)) if (isObj(t)) fillActorRefs(t); // templates stored before item.source (idempotent)
    if (!isObj(state.combat)) state.combat = emptyCombat();
    const c = state.combat;
    if (!Array.isArray(c.entries)) c.entries = [];
    c.round = c.round || 1;
    c.pass = c.pass || 1;
    if (c.currentId === undefined) c.currentId = null;
    c.active = !!c.active;
    undoStacks.delete(state);
  },

  actions: {
    // ----------------------------------------------------------- bestiary
    // { template?: {...}, folder? } → { templateId }
    'bestiary/create': {
      handler(ctx, { template, folder } = {}) {
        const id = ctx.uid('tpl');
        const t = sanitizeTemplate({ name: 'Nouveau PNJ', folder: folder || 'Divers', ...(isObj(template) ? template : {}) }, { id });
        ctx.state.bestiary[id] = t;
        return { templateId: id };
      },
    },
    // { templateId, patch } — top-level fields replaced, `npc` merged.
    'bestiary/update': {
      handler(ctx, { templateId, patch } = {}) {
        const t = ctx.state.bestiary[templateId];
        if (!t) ctx.fail('Modèle introuvable');
        if (!isObj(patch)) ctx.fail('Modification invalide');
        const merged = { ...t, ...patch, npc: isObj(patch.npc) ? { ...t.npc, ...patch.npc } : t.npc };
        ctx.state.bestiary[templateId] = sanitizeTemplate(merged, { id: templateId });
        return { templateId };
      },
    },
    'bestiary/delete': {
      handler(ctx, { templateId } = {}) {
        if (!ctx.state.bestiary[templateId]) ctx.fail('Modèle introuvable');
        delete ctx.state.bestiary[templateId];
        if (!ctx.state.bestiaryRemoved.includes(templateId)) ctx.state.bestiaryRemoved.push(templateId);
        return { ok: true };
      },
    },
    'bestiary/duplicate': {
      handler(ctx, { templateId } = {}) {
        const t = ctx.state.bestiary[templateId];
        if (!t) ctx.fail('Modèle introuvable');
        const id = ctx.uid('tpl');
        ctx.state.bestiary[id] = sanitizeTemplate({ ...deepClone(t), name: `${t.name} (copie)` }, { id });
        return { templateId: id };
      },
    },
    // Save a spawned/edited actor as a new template. { actorId, folder?, name? } → { templateId }
    'bestiary/fromActor': {
      handler(ctx, { actorId, folder, name } = {}) {
        const a = ctx.state.actors[actorId];
        if (!a) ctx.fail('Personnage introuvable');
        const src = a.templateId && ctx.state.bestiary[a.templateId];
        const id = ctx.uid('tpl');
        const t = templateFromActor(a);
        t.folder = folder || src?.folder || 'Divers';
        t.name = name || a.name.replace(/\s+\d+$/, '');
        if (src && !t.description) t.description = src.description;
        ctx.state.bestiary[id] = sanitizeTemplate(t, { id });
        return { templateId: id };
      },
    },
    // { templates: [...], overwrite? } → { count, ids }
    'bestiary/import': {
      handler(ctx, { templates, overwrite } = {}) {
        const list = Array.isArray(templates) ? templates : isObj(templates) ? [templates] : [];
        if (!list.length) ctx.fail('Aucun modèle à importer');
        const ids = [];
        for (const raw of list.slice(0, 500)) {
          if (!isObj(raw)) continue;
          let id = typeof raw.id === 'string' && /^tpl_[\w-]{1,60}$/.test(raw.id) ? raw.id : null;
          if (!id || (ctx.state.bestiary[id] && !overwrite)) id = ctx.uid('tpl');
          ctx.state.bestiary[id] = sanitizeTemplate(raw, { id });
          ctx.state.bestiaryRemoved = ctx.state.bestiaryRemoved.filter((x) => x !== id);
          ids.push(id);
        }
        if (!ids.length) ctx.fail('Fichier sans modèle valide');
        return { count: ids.length, ids };
      },
    },
    // { from, to } → { count }
    'bestiary/renameFolder': {
      handler(ctx, { from, to } = {}) {
        const dest = str(to, 60).trim();
        if (!dest) ctx.fail('Nom de dossier vide');
        let count = 0;
        for (const t of Object.values(ctx.state.bestiary)) {
          if (t.folder === from) {
            t.folder = dest;
            count++;
          }
        }
        return { count };
      },
    },
    // { templateId, mapId? (null = no map), x?, y?, count=1, hidden?, name?, disposition?, addToCombat? } → { actorIds, tokenIds }
    'bestiary/spawn': {
      handler(ctx, { templateId, mapId, x, y, count = 1, hidden, name, disposition, addToCombat } = {}) {
        const state = ctx.state;
        const tpl = state.bestiary[templateId];
        if (!tpl) ctx.fail('Modèle introuvable');
        const n = int(count, 1, 1, 30);
        let map = null;
        if (mapId !== null) {
          const id = mapId || state.scene?.activeMapId;
          map = id ? state.maps?.[id] || null : null;
          if (mapId && !map) ctx.fail('Carte introuvable');
        }
        // Names: « Nettoyeur AG Chemie », or numbered when several exist.
        const baseName = str(name, 120).trim() || tpl.name;
        let maxN = 0;
        let existing = 0;
        for (const a of Object.values(state.actors)) {
          if (a.name === baseName) {
            existing++;
            maxN = Math.max(maxN, 1);
            continue;
          }
          const m = String(a.name).match(/^(.*) (\d+)$/);
          if (m && m[1] === baseName) {
            existing++;
            maxN = Math.max(maxN, Number(m[2]));
          }
        }
        const numbered = n > 1 || existing > 0;
        const occ = map ? occupiedCells(map) : null;
        const actorIds = [];
        const tokenIds = [];
        let unplaced = 0;
        for (let i = 0; i < n; i++) {
          const actorName = numbered ? `${baseName} ${maxN + i + 1}` : baseName;
          const actor = actorFromTemplate(tpl, { id: ctx.uid('npc'), name: actorName, hidden });
          state.actors[actor.id] = actor;
          actorIds.push(actor.id);
          if (!map) continue;
          const cell = findFreeCell(map, x, y, occ);
          if (!cell) {
            unplaced++;
            continue;
          }
          occ.add(`${cell.x},${cell.y}`);
          const token = {
            id: ctx.uid('tok'),
            actorId: actor.id,
            name: actorName,
            x: cell.x,
            y: cell.y,
            size: 1,
            color: tpl.color || '#e05c5c',
            disposition: DISPOSITIONS.includes(disposition) ? disposition : tpl.disposition || 'hostile',
            hidden: !!hidden,
            vision: { lowLight: !!tpl.vision?.lowLight, thermo: !!tpl.vision?.thermo, darkRange: Number(tpl.vision?.darkRange) || 0 },
            status: [],
          };
          if (tpl.portrait) token.img = tpl.portrait;
          map.tokens = Array.isArray(map.tokens) ? map.tokens : [];
          map.tokens.push(token);
          tokenIds.push(token.id);
        }
        if (addToCombat && state.combat?.active) {
          const c = state.combat;
          const placedActors = new Set(tokenIds.map((tid) => map.tokens.find((t) => t.id === tid)?.actorId));
          addEntries(ctx, c, { tokenIds, actorIds: actorIds.filter((a) => !placedActors.has(a)) });
          maybeAutoStart(ctx, c);
        }
        return { actorIds, tokenIds, mapId: map?.id || null, unplaced };
      },
    },

    // ----------------------------------------------------------- combat
    // { mapId?, includeMapTokens = true, rollNpcs = true, force? }
    'combat/start': {
      handler(ctx, { mapId, includeMapTokens = true, rollNpcs = true, force } = {}) {
        const state = ctx.state;
        if (state.combat?.active && !force) ctx.fail('Un combat est déjà en cours');
        const mid = mapId || state.scene?.activeMapId || null;
        const map = mid ? state.maps?.[mid] : null;
        if (mapId && !map) ctx.fail('Carte introuvable');
        const c = (state.combat = { ...emptyCombat(), active: true, mapId: map ? map.id : null, startedAt: ctx.now });
        undoStacks.delete(state);
        if (map && includeMapTokens !== false) {
          const tokenIds = (map.tokens || []).filter((t) => !t.hidden && t.actorId && state.actors[t.actorId]).map((t) => t.id);
          addEntries(ctx, c, { tokenIds, rollNpcs });
        }
        logCombat(ctx, tk('⚔ Le combat commence ! Lancez l’initiative.'));
        ctx.emitTo('players', 'sfx', { id: 'notify' });
        maybeAutoStart(ctx, c);
        return { entries: c.entries.length };
      },
    },
    // { tokenIds?, actorIds? } → { added }
    'combat/add': {
      handler(ctx, { tokenIds, actorIds } = {}) {
        const c = combatOf(ctx);
        syncActors(ctx.state, c);
        const added = addEntries(ctx, c, { tokenIds, actorIds });
        if (!added.length) ctx.fail('Aucun nouveau participant (déjà dans le combat, ou sans fiche)');
        maybeAutoStart(ctx, c);
        return { added: added.map((e) => e.id) };
      },
    },
    'combat/remove': {
      handler(ctx, { entryId } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        const wasCurrent = c.currentId === e.id;
        c.entries = c.entries.filter((x) => x.id !== e.id);
        if (wasCurrent) {
          c.currentId = null;
          advance(ctx, c, { markActed: false });
        } else sortEntries(ctx.state, c);
        maybeAutoStart(ctx, c);
        return { ok: true };
      },
    },
    // Owner or GM. { entryId, blitz? } — Blitz spends 1 Edge for 5D6.
    'combat/roll': {
      role: 'any',
      handler(ctx, { entryId, blitz } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        requireOwner(ctx, e);
        if (!ctx.isGM && !e.toRoll) ctx.fail('Initiative déjà lancée pour ce tour');
        const actor = ctx.state.actors[e.actorId];
        if (!actor) ctx.fail('Ce participant n’a pas de fiche');
        if (blitz) {
          if ((actor.edge?.current ?? 0) < 1) ctx.fail('Plus de points de Chance');
          actor.edge = { ...(actor.edge || {}), current: actor.edge.current - 1 };
        }
        syncActors(ctx.state, c);
        doRoll(ctx, c, e, { blitz: !!blitz });
        const pcLike = e.kind === 'pc';
        const rp = { name: e.name, roll: rollText(e) };
        const gmOnly = !!e.hidden || !pcLike;
        if (blitz) logCombat(ctx, tk('{name} — initiative {roll} (1 point de Chance dépensé)'), rp, { gmOnly });
        else logCombat(ctx, tk('{name} — initiative {roll}'), rp, { gmOnly });
        if (!e.hidden && !pcLike) logCombat(ctx, tk('{name} a lancé son initiative.'), { name: e.name });
        ctx.emitTo('all', 'sfx', { id: 'dice' });
        sortEntries(ctx.state, c);
        maybeAutoStart(ctx, c);
        return { score: e.score, rolls: e.rolls };
      },
    },
    // GM. { npcOnly?, reroll? } — rolls entries waiting to roll (or every entry with reroll).
    'combat/rollAll': {
      handler(ctx, { npcOnly, reroll } = {}) {
        const c = combatOf(ctx);
        syncActors(ctx.state, c);
        const rolled = [];
        for (const e of c.entries) {
          if (npcOnly && e.kind === 'pc') continue;
          if (!reroll && !e.toRoll) continue;
          if (!ctx.state.actors[e.actorId]) continue;
          doRoll(ctx, c, e);
          rolled.push(e);
        }
        if (!rolled.length) {
          if (npcOnly) ctx.fail('Aucun PNJ à lancer');
          ctx.fail('Personne à lancer');
        }
        const pcs = rolled.filter((e) => e.kind === 'pc' && !e.hidden);
        const npcs = rolled.filter((e) => !(e.kind === 'pc' && !e.hidden));
        if (pcs.length) logCombat(ctx, tk('Le MJ lance l’initiative : {list}'), { list: scoreList(pcs) });
        if (npcs.length) logCombat(ctx, tk('Initiative PNJ : {list}'), { list: scoreList(npcs, true) }, { gmOnly: true });
        ctx.emitTo('all', 'sfx', { id: 'dice' });
        sortEntries(ctx.state, c);
        maybeAutoStart(ctx, c);
        return { rolled: rolled.length };
      },
    },
    // GM. { entryId, score }
    'combat/setScore': {
      handler(ctx, { entryId, score } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        const s = int(score, NaN, -60, 99);
        if (!Number.isFinite(s)) ctx.fail('Score invalide');
        if (e.toRoll) {
          e.toRoll = false;
          e.rolls = [];
          e.base = s;
          e.dice = 0;
          e.wound = derive(ctx.state.actors[e.actorId] || {}).woundModifier;
        }
        e.total = (e.total || 0) + (s - e.score);
        e.score = s;
        sortEntries(ctx.state, c);
        maybeAutoStart(ctx, c);
        return { score: s };
      },
    },
    // Owner or GM. { entryId, delta, label? } — interrupt actions (−5 esquive/parade/blocage, −10 défense totale…).
    'combat/adjust': {
      role: 'any',
      handler(ctx, { entryId, delta, label } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        requireOwner(ctx, e);
        if (e.toRoll) ctx.fail('Lance d’abord ton initiative');
        const d = ctx.isGM ? int(delta, 0, -40, 40) : int(delta, 0, -10, 0);
        if (!d) ctx.fail('Ajustement invalide');
        syncActors(ctx.state, c);
        e.score += d;
        e.adjust = (e.adjust || 0) + d;
        const what = str(label, 40).trim();
        const ap = { name: e.name, delta: `${d > 0 ? '+' : ''}${d}`, score: e.score };
        if (what) logCombat(ctx, tk('{name} : {label} ({delta} initiative → {score})'), { ...ap, label: ADJUST_LABELS.has(what) ? { t: what } : what }, { gmOnly: !!e.hidden });
        else logCombat(ctx, tk('{name} : ({delta} initiative → {score})'), ap, { gmOnly: !!e.hidden });
        sortEntries(ctx.state, c);
        return { score: e.score };
      },
    },
    // Owner of the current entry or GM. { entryId? } — entryId guards against double clicks.
    'combat/next': {
      role: 'any',
      handler(ctx, { entryId } = {}) {
        const c = combatOf(ctx);
        const cur = c.entries.find((e) => e.id === c.currentId);
        if (!ctx.isGM) {
          if (!cur || !cur.actorId || !ctx.owns(cur.actorId)) ctx.fail('Ce n’est pas ton tour');
        }
        if (entryId && entryId !== (c.currentId || null)) ctx.fail('Le tour a déjà changé');
        if (!c.entries.length) ctx.fail('Aucun participant');
        syncActors(ctx.state, c);
        if (!cur) {
          // Nobody is acting yet (waiting for rolls): the GM forces the start with whoever has rolled.
          const first = firstActable(ctx.state, c);
          if (!first && c.entries.some((e) => e.toRoll && !e.out && !e.down)) ctx.fail('En attente des jets d’initiative');
          pushUndo(ctx, c);
          if (!first) {
            newCombatTurn(ctx, c);
            return { currentId: c.currentId, round: c.round, pass: c.pass };
          }
          setCurrent(ctx, c, first);
          logCombat(ctx, tk('Tour {round} : {name} agit en premier.'), { round: c.round, name: first.name }, { gmOnly: !!first.hidden });
          return { currentId: c.currentId, round: c.round, pass: c.pass };
        }
        pushUndo(ctx, c);
        advance(ctx, c);
        return { currentId: c.currentId, round: c.round, pass: c.pass };
      },
    },
    // GM: undo the last next/newTurn/delay/act.
    'combat/prev': {
      handler(ctx) {
        combatOf(ctx);
        const snap = undoOf(ctx.state).pop();
        if (!snap) ctx.fail('Rien à annuler');
        ctx.state.combat = snap;
        sortEntries(ctx.state, snap);
        return { currentId: snap.currentId };
      },
    },
    // GM: force a new combat turn (everyone rerolls).
    'combat/newTurn': {
      handler(ctx) {
        const c = combatOf(ctx);
        syncActors(ctx.state, c);
        pushUndo(ctx, c);
        newCombatTurn(ctx, c);
        return { round: c.round };
      },
    },
    // Owner of the current entry or GM: hold the action (act later in this pass).
    'combat/delay': {
      role: 'any',
      handler(ctx, { entryId } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        requireOwner(ctx, e);
        if (c.currentId !== e.id) ctx.fail('Seul le personnage qui agit peut retarder son action');
        syncActors(ctx.state, c);
        const others = c.entries.filter((x) => x.id !== e.id && canAct(x));
        if (!others.length) ctx.fail('Personne d’autre n’agit dans cette passe');
        pushUndo(ctx, c);
        e.delayed = true;
        logCombat(ctx, tk('{name} retarde son action.'), { name: e.name }, { gmOnly: !!e.hidden });
        advance(ctx, c, { markActed: false });
        return { currentId: c.currentId };
      },
    },
    // Owner or GM: a delayed entry acts now (interrupting the current one, which keeps its action).
    'combat/act': {
      role: 'any',
      handler(ctx, { entryId } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        requireOwner(ctx, e);
        if (!e.delayed) ctx.fail('Cette action n’a pas été retardée');
        pushUndo(ctx, c);
        const cur = c.entries.find((x) => x.id === c.currentId);
        e.delayed = false;
        if (cur && cur.score < e.score) {
          e.total -= e.score - cur.score;
          e.score = cur.score;
        }
        logCombat(ctx, tk('{name} agit maintenant (action retardée).'), { name: e.name }, { gmOnly: !!e.hidden });
        setCurrent(ctx, c, e);
        return { currentId: e.id };
      },
    },
    // Owner or GM: Seize the Initiative (1 Edge) → acts first for this combat turn.
    'combat/seize': {
      role: 'any',
      handler(ctx, { entryId } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        requireOwner(ctx, e);
        if (e.seized) ctx.fail('Initiative déjà saisie ce tour');
        const actor = ctx.state.actors[e.actorId];
        if (!actor) ctx.fail('Ce participant n’a pas de fiche');
        if ((actor.edge?.current ?? 0) < 1) ctx.fail('Plus de points de Chance');
        actor.edge = { ...(actor.edge || {}), current: actor.edge.current - 1 };
        e.seized = true;
        logCombat(ctx, tk('{name} saisit l’initiative (1 point de Chance) !'), { name: e.name }, { gmOnly: !!e.hidden });
        sortEntries(ctx.state, c);
        return { ok: true };
      },
    },
    // Owner or GM: initiative type for the next roll. { entryId, mode: physical|astral|ar|cold|hot }
    'combat/setMode': {
      role: 'any',
      handler(ctx, { entryId, mode } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        requireOwner(ctx, e);
        if (!INIT_MODES.includes(mode)) ctx.fail('Type d’initiative inconnu');
        e.mode = mode;
        return { mode };
      },
    },
    // GM: reveal a hidden participant (and its token). { entryId, token = true }
    'combat/reveal': {
      handler(ctx, { entryId, token = true } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        e.hidden = false;
        if (token && e.tokenId) {
          for (const m of Object.values(ctx.state.maps || {})) {
            const t = (m.tokens || []).find((x) => x.id === e.tokenId);
            if (t) t.hidden = false;
          }
        }
        const actor = ctx.state.actors[e.actorId];
        if (actor && actor.type !== 'pc') actor.hidden = false;
        logCombat(ctx, tk('{name} entre dans le combat !'), { name: e.name });
        sortEntries(ctx.state, c);
        return { ok: true };
      },
    },
    // GM: mark out of the fight (fled, dead…) or back in. { entryId, out }
    'combat/setOut': {
      handler(ctx, { entryId, out } = {}) {
        const c = combatOf(ctx);
        const e = getEntry(ctx, c, entryId);
        e.out = !!out;
        if (e.out && c.currentId === e.id) advance(ctx, c, { markActed: false });
        else sortEntries(ctx.state, c);
        return { ok: true };
      },
    },
    'combat/end': {
      handler(ctx) {
        const c = ctx.state.combat;
        const rounds = c?.round || 1;
        ctx.state.combat = emptyCombat();
        undoStacks.delete(ctx.state);
        pruneExpired(ctx.state, ctx.now); // the fight's clouds and afflictions end with it
        if (c?.active) {
          if (rounds > 1) logCombat(ctx, tk('Fin du combat ({n} tours).'), { n: rounds });
          else logCombat(ctx, tk('Fin du combat ({n} tour).'), { n: rounds });
        }
        return { ok: true };
      },
    },
  },

  // Players: no bestiary; hidden participants removed; NPC roll details stripped (players see the
  // order and the current score, not the dice / base / modifiers of NPCs). GM-only NPC notes stripped.
  filter(view, user, state) {
    delete view.bestiary;
    delete view.bestiaryRemoved;
    const mine = new Set(user.characterIds || []);
    for (const a of Object.values(view.actors || {})) {
      if (a && a.type === 'npc' && a.npc) {
        delete a.npc.tactics;
        delete a.npc.loot;
      }
    }
    const c = view.combat;
    if (!c) return;
    c.entries = (c.entries || []).filter((e) => !e.hidden);
    // Fog of war: an NPC whose token is on the shown map but not visible to this player stays off the tracker
    // (view.maps was already filtered by the maps module, which runs before this one).
    const amid = state?.scene?.activeMapId;
    const full = amid && state.maps?.[amid];
    if (full) {
      const onMap = new Set((full.tokens || []).map((t) => t.id));
      const seen = new Set((view.maps?.[amid]?.tokens || []).map((t) => t.id));
      c.entries = c.entries.filter((e) => e.kind === 'pc' || mine.has(e.actorId) || !e.tokenId || !onMap.has(e.tokenId) || seen.has(e.tokenId));
    }
    for (const e of c.entries) {
      if (e.kind !== 'pc' && !mine.has(e.actorId)) {
        delete e.rolls;
        delete e.base;
        delete e.dice;
        delete e.total;
        delete e.wound;
        delete e.adjust;
        delete e.blitz;
        delete e.mode;
      }
    }
    const idx = c.entries.findIndex((e) => e.id === c.currentId);
    if (idx < 0) c.currentId = null;
    c.turn = idx;
  },
};
