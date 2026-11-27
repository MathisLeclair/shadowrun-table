// Characters module: PC + NPC actors, sheets, damage/healing, Edge, karma/nuyen rewards, dice rolls.
// State slice: state.actors (see ARCHITECTURE.md "Actors").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, attr, skillPool, rollDice, SKILL_BY_ID, ATTR_LABELS, ATTR_SHORT, ATTRS, skillDefaultLimit } from '../../shared/sr5.js';
import { uid, deepClone, nuyen as fmtNuyen } from '../../shared/util.js';
import {
  ITEM_LISTS, PLAYER_ITEM_FIELDS, PLAYER_ACTOR_KEYS, MERGE_KEYS, normalizeActor, blankActor, healthStatus, categoryToSkill,
  evalFormula, slugify, METATYPE_FR, MELEE_SKILLS, SUB_LISTS,
} from '../../client/modules/sheet/sheet-data.js';
import { normalizeLifestyle } from '../../shared/lifestyle.js';
import { sanitizeHome } from '../../shared/home.js';
import { contactSheet, connectionOf, loyaltyOf, bribeCost, MAX_CONNECTION, ROLL_KINDS as CONTACT_ROLLS } from '../../shared/contacts.js';
import { isRealSin, sinRating, sinIdentity, sinLicenses, sinCheckOutcome, verificationPool, MAX_DEVICE_RATING } from '../../shared/sins.js';
import { removeBonus, weaponFromStats, wareCatalogItem, detachAugmentation, bakeItemBonus, itemBonusSpec } from '../lib/augment.js';
import { errorBody } from '../lib/i18n.js';
import { actorModifiers, deriveFull } from '../lib/modifiers.js';
import { fillActorRefs } from '../lib/bookrefs.js';
import { appCatalog, norm as catNorm } from '../lib/chummer/data.js';
import {
  ON_BODY, CONTAINER_KINDS, LOCATED_LISTS, isCarried, containerOf, guessContainerKind, usesAmmo, isGrenade, fireOptions,
  ammoFits, clipFits, reloadPlan, ammoKindOf, sameAmmoKind, parseAmmo,
} from '../../client/modules/sheet/inventory.js';
import {
  poolModifiers, limitFor, rollContext, cleanConditions, derivedWithModifiers, weaponAccuracy, checkedTest, woundsApply, importedItem,
  MATRIX_LIMITS, MATRIX_LIMIT_SKILLS,
} from '../../shared/modifiers.js';
import type {
  ActionContext, Actor, ActorId, AttrKey, Container, ContainerKind, DamageType, FireInfo, HealthStatus, I18nEntry, I18nMessage,
  I18nParams, I18nParamValue, ItemListName, LogEntry, RollModLine, RollRecord, ServerModule, SessionUser, SfxId, EmitTarget,
  TableState, GameView, InitOptions, Weapon, AmmoKind, Template, GameMap, User, BiName, Gear, ActorMatrix, SinCheckInfo, ContactRollInfo,
} from '../../shared/types.ts';

/**
 * Sheet items handled generically by list name (`a[list][idx]`, nested sub-items) and untrusted payload objects
 * (patches, items sent by clients): dynamic by nature, validated field by field below.
 */
type Loose = Record<string, any>;
/** An actor seen as a bag of lists / fields (generic list access `a[list]`, patch keys). */
const loose = (a: Actor | Template): Loose => a as unknown as Loose;

/** Marker for the i18n checker: French keys stored as data (history texts…), translated by the client. */
const tk = (s: string): string => s;

const clampInt = (v: unknown, lo: number, hi: number, d = 0): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const str = (v: unknown, max = 4000): string => (v === undefined || v === null ? '' : String(v).slice(0, max));
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getActor(ctx: ActionContext, id: unknown): Actor {
  const a = ctx.state.actors[id as ActorId];
  if (!a) ctx.fail('Personnage introuvable');
  // Actors created by other modules (bestiary spawn…) may lack item ids / arrays: fix them lazily.
  normalizeActor(a, uid);
  if (fillItemNames(a)) normalizeActor(a, uid); // a weapon `ammo` completed from the catalog: reload type re-parsed
  return a;
}

function requireOwn(ctx: ActionContext, actorId: unknown): void {
  if (!ctx.owns(actorId as ActorId)) ctx.fail('Ce personnage ne t’appartient pas');
}

/** Keep condition boxes within the monitors (overflow may reach BOD + 1 = dead). */
function clampCondition(a: Actor): void {
  const d = deriveFull(a);
  const c = a.condition;
  c.physical = clampInt(c.physical, 0, d.physicalMonitor);
  c.stun = clampInt(c.stun, 0, d.stunMonitor);
  c.overflow = clampInt(c.overflow, 0, d.overflowMax + 1);
}

function statusOf(a: Actor): HealthStatus {
  const d = deriveFull(a);
  return healthStatus(a.condition, d.physicalMonitor, d.stunMonitor, d.overflowMax) as HealthStatus;
}

/** Health token markers set from the condition monitors (SR5: full track = unconscious, overflow > BOD = dead). */
const HEALTH_MARKERS: Partial<Record<HealthStatus, string>> = { 'hors de combat': 'inconscient', mort: 'mort' };

/**
 * After a condition change: refresh the combat tracker's KO flag and, when the health status changed,
 * swap the automatic 'inconscient' / 'mort' markers on the actor's tokens (other markers stay as they are).
 */
function syncHealth(state: TableState, a: Actor, wasStatus: HealthStatus | null): HealthStatus {
  const status = statusOf(a);
  const down = status === 'hors de combat' || status === 'mort';
  for (const e of state.combat?.entries || []) if (e.actorId === a.id) e.down = down;
  if (status === wasStatus) return status;
  const marker = HEALTH_MARKERS[status];
  for (const m of Object.values<GameMap>(state.maps || {})) {
    for (const t of m?.tokens || []) {
      if (t.actorId !== a.id) continue;
      const kept = (Array.isArray(t.status) ? t.status : []).filter((x) => x !== 'inconscient' && x !== 'mort');
      t.status = marker ? [...kept, marker] : kept;
    }
  }
  return status;
}

function cleanColor(v: unknown): string | null {
  const s = String(v || '');
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : null;
}

function cleanUrl(v: unknown): string | null {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^(\/uploads\/|\/assets\/|https?:\/\/)/.test(s)) return s.slice(0, 500);
  return null;
}

/** Sanitize a few well-known fields on any patch (GM or player). */
function sanitizeTop(key: string, value: unknown, actor: Actor, ctx: ActionContext): unknown {
  switch (key) {
    case 'id':
      ctx.fail('L’identifiant ne peut pas être modifié');
      break;
    case 'name':
      if (!String(value || '').trim()) ctx.fail('Le nom ne peut pas être vide');
      return String(value).trim().slice(0, 80);
    case 'type':
      if (!['pc', 'npc'].includes(value as string)) ctx.fail('Type invalide (pc ou npc)');
      return value;
    case 'color': {
      const c = cleanColor(value);
      if (!c) ctx.fail('Couleur invalide (format #rrggbb)');
      return c;
    }
    case 'portrait': {
      const u = cleanUrl(value);
      if (u === null) ctx.fail('Adresse de portrait invalide');
      return u;
    }
    case 'notes':
    case 'bio':
    case 'gmNotes':
      return str(value, 50000);
    case 'concept':
    case 'player':
    case 'gender':
      return str(value, 200);
    case 'karma':
    case 'karmaTotal':
    case 'nuyen':
    case 'streetCred':
    case 'notoriety':
    case 'publicAwareness':
    case 'age':
      return clampInt(value, -1e9, 1e9);
    default:
      return value;
  }
}

function applyPatch(ctx: ActionContext, a: Actor, patch: unknown): void {
  if (!isObj(patch)) ctx.fail('Modification invalide');
  if (!ctx.isGM) {
    const bad = Object.keys(patch).filter((k) => !PLAYER_ACTOR_KEYS.includes(k));
    if (bad.length) ctx.fail('Tu ne peux pas modifier ça toi-même ({fields}) — demande au MJ, à la boutique ou à l’entraînement.', { fields: bad.join(', ') });
  }
  for (const [k, v] of Object.entries(patch)) {
    if (BAD_KEYS.has(k)) continue;
    if (MERGE_KEYS.includes(k)) {
      if (v === null) {
        if (['condition', 'edge', 'attributes'].includes(k)) ctx.fail('Champ obligatoire');
        delete loose(a)[k];
        continue;
      }
      if (!isObj(v)) ctx.fail('Format invalide pour {field}', { field: k });
      if (!ctx.isGM && k === 'condition') {
        const allowed = ['physical', 'stun', 'overflow'];
        if (Object.keys(v).some((x) => !allowed.includes(x))) ctx.fail('Champ de condition inconnu');
      }
      if (!ctx.isGM && k === 'edge' && Object.keys(v).some((x) => x !== 'current')) ctx.fail('Seule la Chance actuelle peut être modifiée');
      loose(a)[k] = { ...(isObj(loose(a)[k]) ? loose(a)[k] : {}), ...v };
      if (k === 'condition') for (const x of ['physical', 'stun', 'overflow'] as const) a.condition[x] = clampInt(a.condition[x], 0, 99);
      if (k === 'attributes') for (const [ak, av] of Object.entries(a.attributes)) if (av !== null && av !== undefined) a.attributes[ak as AttrKey] = ak === 'ESS' ? Math.round(Math.max(0, Math.min(6, Number(av) || 0)) * 1000) / 1000 : clampInt(av, 0, 20);
    } else {
      const val = sanitizeTop(k, v, a, ctx);
      if (val === undefined || val === null) delete loose(a)[k];
      else loose(a)[k] = val;
    }
  }
  normalizeActor(a, uid);
  clampCondition(a);
}

/** Remove an actor and everything pointing at it (tokens, combat entries, user assignments). */
function removeActor(state: TableState, id: ActorId): void {
  delete state.actors[id];
  for (const m of Object.values<GameMap>(state.maps || {})) {
    if (Array.isArray(m?.tokens)) m.tokens = m.tokens.filter((t) => t.actorId !== id);
  }
  const cb = state.combat;
  if (cb && Array.isArray(cb.entries)) {
    const len = cb.entries.length;
    cb.entries = cb.entries.filter((e) => e.actorId !== id);
    if (cb.entries.length !== len) {
      // currentId is the source of truth (combat module); turn is rebuilt from it (-1 = nobody current).
      if (!cb.entries.some((e) => e.id === cb.currentId)) cb.currentId = null;
      cb.turn = cb.entries.findIndex((e) => e.id === cb.currentId);
    }
  }
  for (const u of Object.values<User>(state.users || {})) {
    if (Array.isArray(u.characterIds)) u.characterIds = u.characterIds.filter((x) => x !== id);
  }
}

/** Index of an item by id; `index` is a fallback for items that had no id when the client rendered them. */
function findItem(ctx: ActionContext, a: Actor, list: string, itemId: unknown, index?: unknown): number {
  if (!ITEM_LISTS.includes(list)) ctx.fail('Liste inconnue : {list}', { list: String(list) });
  const A = loose(a);
  if (!Array.isArray(A[list])) A[list] = [];
  let idx: number = itemId ? A[list].findIndex((i: Loose) => i.id === itemId) : -1;
  if (idx < 0 && !itemId && Number.isInteger(index) && A[list][index as number]) idx = index as number;
  if (idx < 0) ctx.fail('Élément introuvable');
  return idx;
}

const realNum = (v: unknown, lo: number, hi: number, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)) : d;
};
const MOUNTS = ['Top', 'Under', 'Barrel', 'Stock', 'Side', 'Internal', ''];
const VEHICLE_MOD_EFFECTS = ['armor', 'handling', 'speed', 'accel', 'body', 'sensor', 'pilot', 'seats'];
const ARMOR_MOD_BONUS = ['fire', 'cold', 'electricity', 'acid', 'falling', 'toxin', 'pathogen', 'radiation'];

/** Accessory / mod / lifestyle quality / technique (nested list `sub`). `partial` = patch (only the given keys). */
function sanitizeSub(ctx: ActionContext, sub: string, x: unknown, partial = false): Loose {
  if (!isObj(x)) ctx.fail('Élément invalide');
  const out: Loose = {};
  const has = (k: string) => x[k] !== undefined;
  if (!partial || has('name')) out.name = str(x.name, 120).trim() || (partial ? undefined : 'Option');
  if (out.name === undefined) delete out.name;
  for (const k of ['nameFr', 'catalogId', 'chummerGuid', 'avail', 'category']) if (has(k)) out[k] = x[k] === null ? null : str(x[k], k === 'category' ? 60 : 120);
  if (has('notes')) out.notes = x.notes === null ? null : str(x.notes, 2000);
  // Rulebook reference (📖 chip): book code + printed page (filled from the catalog by server/lib/bookrefs.js when missing).
  if (has('source')) out.source = x.source === null || x.source === '' ? null : str(x.source, 12).trim();
  if (has('page')) out.page = x.page === null || x.page === '' ? null : clampInt(x.page, 1, 9999);
  if (has('rating')) out.rating = x.rating === null || x.rating === '' ? null : clampInt(x.rating, 0, 99);
  for (const k of ['included', 'equipped']) if (has(k)) out[k] = !!x[k];
  if (has('cost')) out.cost = realNum(x.cost, -1e8, 1e8);
  // Shop-only fields (40-shop installUpgrade) survive GM edits: price paid (resale value), choice (Chummer <extra>).
  if (has('paid')) out.paid = x.paid === null || x.paid === '' ? null : realNum(x.paid, 0, 1e9);
  if (has('choice')) out.choice = x.choice === null ? null : str(x.choice, 120);
  if (sub === 'accessories') {
    if (has('mount')) out.mount = MOUNTS.includes(x.mount) ? x.mount : '';
    if (has('extraMount')) out.extraMount = Array.isArray(x.extraMount) ? x.extraMount.map((m: unknown) => str(m, 20)).filter((m: string) => MOUNTS.includes(m) && m).slice(0, 6) : [];
    if (has('effects')) {
      const e = isObj(x.effects) ? x.effects : {};
      out.effects = {};
      for (const k of ['accuracy', 'rc', 'dicePool']) if (Number(e[k])) out.effects[k] = clampInt(e[k], -20, 20);
      if (Number(e.rcGroup)) out.effects.rcGroup = clampInt(e.rcGroup, 0, 99);
      if (e.smartgun) out.effects.smartgun = true;
    }
  } else if (sub === 'mods') {
    if (has('capacity')) out.capacity = realNum(x.capacity, -50, 50);
    if (has('slots')) out.slots = realNum(x.slots, -50, 99);
    if (has('effects')) {
      // Armor mods: { armor }; vehicle mods: { handling, speed, accel, armor, body, sensor, pilot, seats } (evaluated at the rating).
      const e = isObj(x.effects) ? x.effects : {};
      out.effects = {};
      for (const k of VEHICLE_MOD_EFFECTS) if (Number(e[k])) out.effects[k] = realNum(e[k], -50, 50);
    }
    if (has('bonus')) {
      // Armor mods: { fire|cold|electricity|acid|falling|toxin|pathogen|radiation: n }.
      const b = isObj(x.bonus) ? x.bonus : {};
      out.bonus = {};
      for (const k of ARMOR_MOD_BONUS) if (b[k] !== undefined && b[k] !== null && b[k] !== '') out.bonus[k] = Number.isFinite(Number(b[k])) ? realNum(b[k], -50, 50) : !!b[k];
      if (!Object.keys(out.bonus).length) out.bonus = null;
    }
  } else if (sub === 'qualities') {
    if (has('multiplier')) out.multiplier = realNum(x.multiplier, -100, 1000);
    if (has('baseOnly')) out.baseOnly = !!x.baseOnly; // % of the base cost only (Extra Secure), shared/lifestyle.js
    if (has('lp')) out.lp = x.lp === null ? null : clampInt(x.lp, -20, 20);
  }
  return out;
}

const subList = (ctx: ActionContext, list: string, items: unknown, sub: string): Loose[] => (Array.isArray(items) ? items.slice(0, 60).map((x) => ({ ...sanitizeSub(ctx, sub, x), id: str(x?.id, 60) || ctx.uid('sub') })) : []);

/** Lifestyles: derived monthly cost (shared/lifestyle.js) and a single primary lifestyle. */
function settleLifestyles(a: Actor, primaryId?: string | null): void {
  if (!Array.isArray(a.lifestyles)) return;
  if (primaryId && a.lifestyles.some((l) => l.id === primaryId)) for (const l of a.lifestyles) l.primary = l.id === primaryId;
  for (const l of a.lifestyles) normalizeLifestyle(l, a); // baseCost pinned to the level's fixed cost
  if (a.lifestyles.length && !a.lifestyles.some((l) => l.primary)) a.lifestyles[0].primary = true;
}

function sanitizeItem(list: string, item: unknown, ctx?: ActionContext): Loose {
  const out: Loose = deepClone(item);
  delete out.__proto__;
  if (ctx) {
    const sub = (SUB_LISTS as Record<string, string | undefined>)[list];
    if (sub && out[sub] !== undefined) out[sub] = subList(ctx, list, out[sub], sub);
    if (list === 'weapons' && out.mounts !== undefined) out.mounts = Array.isArray(out.mounts) ? out.mounts.map((m: unknown) => str(m, 20)).filter((m: string) => MOUNTS.includes(m)) : [];
    if (list === 'armor' && out.capacity !== undefined) out.capacity = realNum(out.capacity, 0, 99);
    if (list === 'lifestyles') {
      for (const k of ['base', 'catalogId']) if (out[k] !== undefined) out[k] = str(out[k], k === 'base' ? 40 : 80);
      if (out.baseCost !== undefined) out.baseCost = clampInt(out.baseCost, 0, 1e8); // only kept for a custom level (normalizeLifestyle)
      if (out.metatypePct !== undefined) out.metatypePct = clampInt(out.metatypePct, 0, 500);
      if (out.extraCost !== undefined) out.extraCost = clampInt(out.extraCost, 0, 1e8);
      if (out.monthsPaid !== undefined) out.monthsPaid = clampInt(out.monthsPaid, 0, 999);
      if (out.primary !== undefined) out.primary = !!out.primary;
      if (out.home !== undefined) out.home = sanitizeHome(out.home); // shared/home.js (null → removed: the player picks again)
      if (out.points !== undefined) {
        const p = isObj(out.points) ? out.points : null;
        out.points = p ? Object.fromEntries(['comforts', 'security', 'neighborhood', 'entertainment'].filter((k) => p[k] !== undefined && p[k] !== null).map((k) => [k, clampInt(p[k], 0, 20)])) : null;
      }
      delete out.monthlyCost; // derived
    }
  }
  if (out.name !== undefined) out.name = String(out.name).slice(0, 120);
  if (out.notes !== undefined) out.notes = str(out.notes, 5000);
  // Rulebook reference (📖 chip): book code + printed page.
  if (out.source !== undefined && out.source !== null) out.source = str(out.source, 12).trim() || null;
  if (out.page !== undefined && out.page !== null) out.page = out.page === '' ? null : clampInt(out.page, 1, 9999);
  for (const k of ['rating', 'qty', 'connection', 'loyalty', 'rc', 'reach', 'level', 'body', 'armor', 'pilot', 'sensor', 'seats', 'ammoLeft', 'ammoLoaded']) {
    if (out[k] !== undefined && out[k] !== null && out[k] !== '') {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  if (out.essence !== undefined) out.essence = Math.round(Math.max(0, Number(out.essence) || 0) * 1000) / 1000;
  if (out.pp !== undefined) out.pp = Math.max(0, Number(out.pp) || 0);
  if (out.karma !== undefined) out.karma = Number(out.karma) || 0;
  if (list === 'qualities' && out.positive === undefined) out.positive = (out.karma || 0) >= 0;
  if (list === 'armor' && out.equipped !== undefined) out.equipped = !!out.equipped;
  if (list === 'gear' && out.active !== undefined) out.active = !!out.active; // gear with catalog effects: worn / switched on (shared/modifiers.js)
  // Inventory (client/modules/sheet/inventory.js): location ('on' or a container id, checked by the handlers), ready weapons, ammo.
  if (LOCATED_LISTS.includes(list) && out.location !== undefined) out.location = str(out.location, 60).trim() || ON_BODY;
  for (const k of BILINGUAL) if (out[k] !== undefined && out[k] !== null) out[k] = str(out[k], 120);
  if (list === 'weapons') {
    if (out.equipped !== undefined) out.equipped = !!out.equipped;
    for (const k of ['ammoLoaded', 'ammoLeft', 'qty']) if (out[k] !== undefined && out[k] !== null) out[k] = clampInt(out[k], 0, 999);
    delete out.ammoMax; // derived from `ammo` by normalizeActor
    delete out.ammoType;
    if (out.ammoKind !== undefined) {
      const k = out.ammoKind;
      out.ammoKind = isObj(k) && String(k.name || '').trim()
        ? { name: str(k.name, 120).trim(), ...(k.nameFr ? { nameFr: str(k.nameFr, 120) } : {}), ...(k.catalogId ? { catalogId: str(k.catalogId, 80) } : {}) }
        : null;
    }
  }
  if (out.choice !== undefined && out.choice !== null) out.choice = str(out.choice, 120); // Chummer <extra> / GM pick of a « select… » effect
  if (out.itemRating !== undefined && out.itemRating !== null) out.itemRating = clampInt(out.itemRating, 0, 99); // armor: Chummer item rating (≠ armor value)
  if (list === 'sins' && typeof out.licenses === 'string') out.licenses = out.licenses.split(',').map((s) => s.trim()).filter(Boolean);
  if (list === 'martialArts' && out.rating !== undefined) out.rating = clampInt(out.rating, 1, 20, 1);
  return out;
}

/** Nested list of an item: validates list/sub and returns { a, it, arr }. */
function findSubParent(ctx: ActionContext, actorId: unknown, list: string, itemId: unknown, sub: string): { a: Actor; it: Loose; arr: Loose[] } {
  const a = getActor(ctx, actorId);
  const subOf = (SUB_LISTS as Record<string, string | undefined>)[list];
  if (!subOf || subOf !== sub) ctx.fail('Sous-liste inconnue : {sub}', { sub: `${String(list)}.${String(sub)}` });
  const idx = findItem(ctx, a, list, itemId);
  const it: Loose = loose(a)[list][idx];
  if (!Array.isArray(it[sub])) it[sub] = [];
  return { a, it, arr: it[sub] };
}

const LIMIT_LABEL: Record<string, string> = { physical: 'physique', mental: 'mentale', social: 'sociale', astral: 'astrale' };
/** Lists whose items carry attribute / initiative bonuses stored on the actor (item.bonus, server/lib/augment.js). */
const BONUS_LISTS = ['augmentations', 'powers', 'qualities'];
const BONUS_FIELDS = ['rating', 'level', 'choice', 'catalogId', 'name'];

/**
 * Value of a named pool line a player's sheet sends ('dice/roll' bonus), recomputed from the actor; null = not one of them.
 * « VOL »: total defense (REA + INT + WIL); « Firewall »: Matrix defense (INT + Firewall) / biofeedback (WIL + Firewall).
 */
function playerBonus(actor: Actor, label: string, { skillId, test, A1, A2 }: { skillId: string | null; test: string | null; A1: string | null; A2: string | null }): number | null {
  if (label === 'VOL' && test === 'defense') return attr(actor, 'WIL');
  if (label === 'Firewall' && !skillId && !A2 && (test === 'biofeedback' || A1 === 'INT') && actor.matrix) return clampInt(actor.matrix.firewall, 0, 20);
  return null;
}
/** 'dice/roll' payload.matrixLimit: device attribute used as the limit of a Matrix test from the sheet (stored French label). */
const MATRIX_LIMIT_LABEL: Record<string, string> = { attack: 'Attaque', sleaze: 'Corruption', dataProcessing: 'Traitement', firewall: 'Firewall' };
/** Upper-case status shown in PC damage logs (French keys). */
const STATUS_UPPER: Partial<Record<HealthStatus, string>> = { 'hors de combat': tk('HORS DE COMBAT'), mort: tk('MORT') };

function sfx(ctx: ActionContext, id: SfxId, target: EmitTarget = 'all'): void {
  ctx.emitTo(target, 'sfx', { id });
}

/** 'A, B et C' as a translatable log param. */
function names(list: string[]): I18nParamValue {
  if (list.length <= 1) return list.join('');
  return { t: '{list} et {last}', params: { list: list.slice(0, -1).join(', '), last: list[list.length - 1] } };
}

// ---------------------------------------------------------------------------
// Item names in both languages (catalog)
// ---------------------------------------------------------------------------
/** Catalog files of each list: catalogId lookup and one-time backfill by exact name. */
const NAME_CATALOGS: Record<string, string[]> = { weapons: ['weapons'], armor: ['armor'], gear: ['gear', 'programs', 'armor'], augmentations: ['cyberware', 'bioware'], vehicles: ['vehicles'] };
/** Gear entries that describe a weapon (grenades, throwing knives, grapple gun…): their names serve weapon items (no catalogId). */
let weaponGear: Map<string, Loose> | null = null;
function weaponGearByName(): Map<string, Loose> {
  if (!weaponGear) {
    weaponGear = new Map();
    for (const e of appCatalog('gear').list) {
      if (!e?.stats?.weapon) continue;
      for (const n of [e.name, e.nameFr]) {
        const k = catNorm(n);
        if (k && !weaponGear.has(k)) weaponGear.set(k, e);
      }
    }
  }
  return weaponGear;
}
const BILINGUAL = ['nameFr', 'nameEn', 'categoryFr', 'categoryEn'];

/**
 * Catalog names / categories in both languages on the items (shown by the sheet in the UI language, the stored name in the tooltip):
 * nameFr / nameEn only when the stored name IS a catalog name (a renamed item keeps its own name), categoryFr / categoryEn when the
 * stored category is the catalog's (or empty). Items without catalogId get one by exact English / French name (never overwrites an
 * existing catalogId). Missing fields only: idempotent, cheap (Map lookups).
 * Returns true when a weapon's `ammo` was completed (« 14 » → « 14(c) »): the caller runs normalizeActor again so that
 * ammoType / ammoMax follow (the inventory migration must give the same state at every boot).
 */
/**
 * Thrown weapons bought / added as gear (grenades, Molotov cocktails, throwing knives: catalog gear with throwing-weapon stats — Chummer
 * keeps them as gear with a weapon bonus) become weapon items with a quantity, so the Combat tab and the map offer to throw them.
 * Same weapon already listed (catalog id or name): its quantity grows. Returns true when something moved.
 */
export function thrownGearToWeapons(actor: Actor | Template | Loose, makeId: (prefix?: string) => string = uid): boolean {
  const a = actor as Loose;
  if (!Array.isArray(a?.gear) || !a.gear.length) return false;
  let moved = false;
  const gearCat = appCatalog('gear');
  const keep: Loose[] = [];
  for (const g of a.gear) {
    const e = isObj(g) ? (g.catalogId ? gearCat.byId.get(String(g.catalogId).toLowerCase()) : gearCat.byName.get(catNorm(g.name)) || weaponGearByName().get(catNorm(g.name))) : null;
    const st = e?.stats?.weapon;
    if (!st || st.skill !== 'throwing_weapons') {
      keep.push(g);
      continue;
    }
    if (!Array.isArray(a.weapons)) a.weapons = [];
    const names = new Set([g.name, g.nameEn, g.nameFr, e.name, e.nameFr].filter(Boolean).map(catNorm));
    const qty = Math.max(1, Math.round(Number(g.qty) || 1));
    const same = a.weapons.find((w: unknown) => isObj(w) && ((w.catalogId && w.catalogId === e.id) || [w.name, w.nameEn, w.nameFr].filter(Boolean).some((n) => names.has(catNorm(n)))));
    if (same) same.qty = Math.max(0, Math.round(Number(same.qty ?? 1))) + qty;
    else {
      a.weapons.push({
        id: makeId('wpn'), name: g.name || e.name, ...(e.nameFr ? { nameFr: e.nameFr } : {}), nameEn: e.name, category: e.categoryFr || e.category || '', kind: 'ranged', skill: 'throwing_weapons',
        accuracy: st.accuracy ?? '', damage: st.damage || '', ap: st.ap ?? 0, mode: '', rc: 0, ammo: '', reach: 0,
        catalogId: e.id, qty, equipped: true, ...(g.location !== undefined ? { location: g.location } : {}), ...(g.notes ? { notes: g.notes } : {}),
      });
    }
    moved = true;
  }
  if (moved) a.gear = keep;
  return moved;
}

function fillItemNames(a: Actor): boolean {
  let ammoChanged = thrownGearToWeapons(a);
  for (const [list, files] of Object.entries(NAME_CATALOGS)) {
    for (const it of Array.isArray(loose(a)[list]) ? loose(a)[list] : []) {
      if (!isObj(it) || !it.name) continue;
      let e: Loose | null = null;
      if (it.catalogId) {
        const id = String(it.catalogId).toLowerCase();
        for (const f of files) if ((e = appCatalog(f).byId.get(id))) break;
      } else {
        const k = catNorm(it.name);
        for (const f of files) if ((e = appCatalog(f).byName.get(k))) break;
        if (e) it.catalogId = e.id;
        else if (list === 'weapons') e = weaponGearByName().get(k) || null;
      }
      if (!e) continue;
      const names = [catNorm(e.name), catNorm(e.nameFr)];
      if (names.includes(catNorm(it.name))) {
        if (!it.nameFr && (e.nameFr || e.name)) it.nameFr = e.nameFr || e.name; // no French name in Chummer: same name
        if (!it.nameEn && e.name) it.nameEn = e.name;
      }
      // Weapon ammo without its reload type (Foundry « 14 »): the catalog's (« 14(c) ») when the capacity is the same.
      if (list === 'weapons' && it.catalogId && e.stats?.ammo) {
        const mine = parseAmmo(it.ammo);
        const cat = parseAmmo(e.stats.ammo);
        if (mine.max && !mine.type && cat.type && cat.max === mine.max) {
          it.ammo = String(e.stats.ammo).slice(0, 40);
          ammoChanged = true;
        }
      }
      if (!it.category || [catNorm(e.category), catNorm(e.categoryFr)].includes(catNorm(it.category))) {
        if (!it.categoryFr && e.categoryFr) it.categoryFr = e.categoryFr;
        if (!it.categoryEn && e.category) it.categoryEn = e.category;
      }
    }
  }
  return ammoChanged;
}

// ---------------------------------------------------------------------------
// Inventory: locations, firing, reloading (rules: client/modules/sheet/inventory.js)
// ---------------------------------------------------------------------------
/** 'on' or an existing container id of the actor. */
function cleanLocation(ctx: ActionContext, a: Actor, loc: unknown): string {
  const v = String(loc ?? '').trim().slice(0, 60) || ON_BODY;
  if (v !== ON_BODY && !containerOf(a, v)) ctx.fail('Contenant introuvable');
  return v;
}

/**
 * After a location / equipped / active change. An item stored away (bag, vehicle, safehouse) can be neither ready, worn nor active:
 * readying it (`flagged`) takes it out of a bag (« Sur soi »); an item in a vehicle / safehouse stays there switched off (players are
 * refused before, see requireReach — only the GM's `flagged` takes it from anywhere). Storing it switches it off.
 * Returns 'taken' | 'stowed' | null.
 */
function settleItem(a: Actor, list: string, it: Loose | undefined, flagged: boolean, isGM = false): 'taken' | 'stowed' | null {
  if (!LOCATED_LISTS.includes(list) || !it) return null;
  const flag = list === 'gear' ? 'active' : 'equipped';
  if (isCarried(a, it.location) || !it[flag]) return null;
  if (flagged && (isGM || reachOf(a, it.location) < 2)) {
    it.location = ON_BODY;
    return 'taken';
  }
  it[flag] = false;
  return 'stowed';
}

/** Name of an item in both languages, for log / error params ({ fr, en }: each viewer reads their language). */
const biName = (it: Loose | null | undefined): string | BiName => {
  const fr = String(it?.nameFr || it?.name || '');
  const en = String(it?.nameEn || it?.name || it?.nameFr || '');
  return fr === en ? fr : { fr, en };
};
/** Same for a loaded ammunition descriptor ({ name: English, nameFr }). */
const biAmmo = (k: AmmoKind | null | undefined): string | BiName => (k ? biName({ name: k.name, nameEn: k.name, nameFr: k.nameFr }) : '—');
const placeName = (a: Actor, loc: unknown): string => containerOf(a, loc)?.name || '';

/** Players cannot use (fire, reload, ready) an item kept in a vehicle / safehouse / other place: within reach = carried or in a bag. */
function requireReach(ctx: ActionContext, a: Actor, it: Loose): void {
  if (ctx.isGM || reachOf(a, it.location) < 2) return;
  ctx.fail('{item} est hors de portée ({place})', { item: biName(it), place: placeName(a, it.location) });
}

/**
 * Items taken out of a vehicle / safehouse / other place by a player (move, location patch): allowed (the runner went there),
 * written to the log so the GM sees it (out of reach in the middle of a fight is the GM's call).
 */
function noteRetrieval(ctx: ActionContext, a: Actor, it: Loose, from: unknown): void {
  if (ctx.isGM || reachOf(a, from) < 2 || reachOf(a, it.location) >= 2) return;
  ctx.log({
    kind: 'system', userId: ctx.user.id, author: a.name,
    i18n: { key: tk('{name} récupère {item} ({place})'), params: { name: a.name, item: biName(it), place: placeName(a, from) } },
  });
}

/** Rounds of a weapon's magazine (0..ammoMax). */
const loadedOf = (w: Loose): number => Math.max(0, Math.min(Number(w.ammoMax) || 0, Math.round(Number(w.ammoLoaded) || 0)));

/**
 * What a weapon attack uses, checked BEFORE the roll: rounds of the fire option (SS/SA 1, SA burst 3, BF 3, long burst 6, FA 6 / 10,
 * suppressive 20) or one grenade. The weapon must be within reach (carried or in a bag; GM: anywhere).
 * Fewer rounds than the option (SR5 p. 180): the shot fires what is left and the defense modifier is reduced by 1 per missing round
 * (`short`, `defense`); suppressive fire: the area is 1 m narrower per 2 missing rounds (`narrower`). Empty magazine → « Plus assez
 * de munitions — recharge » (GM: ammoOverride fires anyway, 0 round). null for melee weapons and weapons without tracked ammunition.
 */
/** What planShot() allows: rounds of a fire option, or one thrown item. */
type Shot = { kind: 'ammo' | 'item'; mode?: string; rounds: number; action?: string; short?: number; narrower?: number; defense?: number };
/** applyShot() result (roll.fire): rounds left, or the thrown item's remaining quantity. */
type ShotResult = { mode?: string; rounds?: number; left: number; max?: number; short?: number; defense?: number; narrower?: number; item?: boolean; removed?: boolean };

function planShot(ctx: ActionContext, a: Actor, w: Loose, { fireMode, ammoOverride, rounds: fewer }: { fireMode?: unknown; ammoOverride?: unknown; rounds?: number } = {}): Shot | null {
  requireReach(ctx, a, w);
  const override = ctx.isGM && !!ammoOverride;
  if (usesAmmo(w)) {
    const opts = fireOptions(w);
    const asked = fireMode ? String(fireMode).slice(0, 8) : '';
    if (asked && !opts.some((o) => o.id === asked)) ctx.fail('Mode de tir impossible avec cette arme : {mode}', { mode: asked });
    const opt = opts.find((o) => o.id === asked) || opts[0];
    const loaded = loadedOf(w);
    if (loaded < 1 && !override) ctx.fail('Plus assez de munitions — recharge');
    const wanted: number = fewer && fewer > 0 ? Math.min(opt.rounds, Math.round(fewer)) : opt.rounds; // R&G Double Tap / Aimed Burst / Brain Blaster
    const rounds = Math.min(loaded, wanted);
    const shot: Shot = { kind: 'ammo', mode: opt.id, rounds, action: opt.action };
    const short = wanted - rounds;
    if (short > 0 && rounds > 0) {
      shot.short = short;
      if (opt.defense === null) shot.narrower = Math.floor(short / 2);
      else shot.defense = Math.min(0, opt.defense + short);
    }
    return shot;
  }
  if (isGrenade(w)) {
    const qty = w.qty === undefined || w.qty === null ? 1 : Math.max(0, Math.round(Number(w.qty) || 0));
    if (qty < 1 && !override) ctx.fail('Plus aucun exemplaire : {weapon}', { weapon: biName(w) });
    return { kind: 'item', rounds: qty ? 1 : 0 };
  }
  return null;
}

/** Consume what planShot() allowed. A thrown grenade leaves the sheet with its last unit. */
function applyShot(a: Actor, w: Loose, shot: Shot): ShotResult {
  if (shot.kind === 'ammo') {
    w.ammoLoaded = Math.max(0, loadedOf(w) - shot.rounds);
    const out: ShotResult = { mode: shot.mode, rounds: shot.rounds, left: w.ammoLoaded, max: Number(w.ammoMax) || 0 };
    if (shot.short) {
      out.short = shot.short;
      if (shot.defense !== undefined) out.defense = shot.defense;
      if (shot.narrower !== undefined) out.narrower = shot.narrower;
    }
    return out;
  }
  const qty = (w.qty === undefined || w.qty === null ? 1 : Math.max(0, Number(w.qty) || 0)) - shot.rounds;
  if (qty <= 0) {
    a.weapons = a.weapons.filter((x) => x !== w);
    return { item: true, left: 0, removed: true };
  }
  w.qty = qty;
  return { item: true, left: qty };
}

/** 0 = carried, 1 = in a bag, 2 = out of reach (vehicle, safehouse, other place). */
function reachOf(a: Actor, loc: unknown): number {
  if (isCarried(a, loc)) return 0;
  return containerOf(a, loc)?.kind === 'bag' ? 1 : 2;
}
const qtyOf = (g: Loose | null | undefined): number => Math.max(0, Math.round(Number(g?.qty ?? 1) || 0));

/**
 * One reload action (SR5 p. 163, simplified — inventory.js reloadPlan): rounds come from compatible ammunition in the inventory
 * (qty = rounds; carried first, then bags; never from a vehicle / safehouse), the ammo box's qty goes down. A spare clip of the
 * weapon = clip change (Simple Action, clips are kept); loose rounds = Complex Action. Other ammunition than the loaded one: the
 * rounds still in the weapon go back to a matching box (or are dropped, noted). GM `free`: fill up without using the inventory.
 */
function reloadWeapon(ctx: ActionContext, a: Actor, w: Loose, { sourceItemId, free }: { sourceItemId?: unknown; free?: unknown } = {}) {
  if (!usesAmmo(w)) ctx.fail('Cette arme ne se recharge pas');
  requireReach(ctx, a, w);
  const max = Number(w.ammoMax) || 0;
  const loaded = loadedOf(w);
  const gear: Loose[] = (Array.isArray(a.gear) ? a.gear : []).filter(isObj);
  const usable = (g: Loose) => reachOf(a, g.location) < 2 && qtyOf(g) > 0;
  let source: Loose | null = null;
  if (sourceItemId) {
    source = gear.find((g) => g.id === String(sourceItemId)) || null;
    if (!source) ctx.fail('Élément introuvable');
    if (!ammoFits(source, w)) ctx.fail('Munitions incompatibles avec {weapon}', { weapon: biName(w) });
    if (!qtyOf(source)) ctx.fail('{item} est vide', { item: biName(source) });
    if (reachOf(a, source.location) >= 2 && !ctx.isGM) ctx.fail('{item} est hors de portée ({place})', { item: biName(source), place: placeName(a, source.location) });
  } else if (!(ctx.isGM && free)) {
    const cands = gear.filter((g) => usable(g) && ammoFits(g, w));
    const same = (g: Loose) => (w.ammoKind && sameAmmoKind(ammoKindOf(g), w.ammoKind) ? 0 : 1);
    cands.sort((x, y) => same(x) - same(y) || reachOf(a, x.location) - reachOf(a, y.location) || qtyOf(y) - qtyOf(x));
    source = cands[0] || null;
    if (!source) ctx.fail('Aucune munition compatible dans l’inventaire de {name}', { name: a.name });
    // Rounds still loaded: an automatic pick never swaps them for another ammunition (that is chosen explicitly: sourceItemId).
    if (loaded > 0 && w.ammoKind && same(source)) ctx.fail('Plus de {ammo} à portée : choisis d’autres munitions', { ammo: biAmmo(w.ammoKind) });
  }
  const newKind = source ? ammoKindOf(source) : w.ammoKind || null;
  let base = loaded;
  let returned = 0;
  let dropped = 0;
  if (source && loaded > 0 && w.ammoKind && !sameAmmoKind(w.ammoKind, newKind)) {
    // Other ammunition: the rounds (or the clip) taken out go back to a box of their kind, a new one « Sur soi » when there is none.
    const old = w.ammoKind;
    const back = gear
      .filter((g) => g !== source && ammoFits(g, w) && sameAmmoKind(ammoKindOf(g), old))
      .sort((x, y) => reachOf(a, x.location) - reachOf(a, y.location))[0]; // a box within reach first
    if (back) back.qty = qtyOf(back) + loaded;
    else if (old.name) {
      const box: Loose = { id: ctx.uid('itm'), name: old.nameFr || old.name, ...(old.nameFr ? { nameFr: old.nameFr } : {}), nameEn: old.name, category: 'Munitions', qty: loaded, location: ON_BODY };
      if (old.catalogId) box.catalogId = old.catalogId;
      if (ammoFits(box, w)) {
        a.gear.push(box as Gear);
        gear.push(box);
      } else dropped = loaded;
    } else dropped = loaded;
    if (!dropped) returned = loaded;
    base = 0;
  }
  if (base >= max) ctx.fail('{weapon} est déjà chargée', { weapon: biName(w) });
  const clip = gear.find((g) => reachOf(a, g.location) < 2 && qtyOf(g) > 0 && clipFits(g, w, 'clip'));
  const loader = w.ammoType === 'cy' ? gear.find((g) => reachOf(a, g.location) < 2 && qtyOf(g) > 0 && clipFits(g, w, 'loader')) : null;
  const plan = reloadPlan(w, { agi: attr(a, 'AGI'), clip: !!clip, loader: !!loader });
  const avail = source ? qtyOf(source) : Infinity;
  const n = Math.min(max - base, plan.perAction, avail);
  if (source) source.qty = avail - n;
  w.ammoLoaded = base + n;
  if (newKind) w.ammoKind = newKind;
  const params = { name: a.name, weapon: biName(w), n, loaded: w.ammoLoaded, max, ammo: biAmmo(newKind), action: { t: plan.action === 'simple' ? tk('action simple') : tk('action complexe') } };
  const key = plan.swap ? tk('{name} change le chargeur de {weapon} : {loaded}/{max} ({ammo}) — {action}') : tk('{name} recharge {weapon} : +{n} → {loaded}/{max} ({ammo}) — {action}');
  ctx.log({ kind: 'combat', userId: ctx.user.id, author: a.name, i18n: { key, params }, gmOnly: a.type === 'npc' ? true : undefined });
  return { loaded: n, ammoLoaded: w.ammoLoaded, max, action: plan.action, swap: plan.swap, sourceId: source?.id || null, clipId: plan.swap ? (clip || loader)?.id || null : null, returned, dropped };
}

// Chummer5 import/export lives in server/modules/85-chummer.js (+ server/lib/chummer/).

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
/** Fill n boxes of damage (stun overflow rolls into physical, physical into overflow), log it. Callers check ownership. */
export function applyDamage(ctx: ActionContext, a: Actor, n: number, type: DamageType | string): { condition: Actor['condition']; status: HealthStatus } {
  const d = deriveFull(a);
  const c = a.condition;
  const wasStatus = statusOf(a);
  let toPhysical = 0;
  if (type === 'S') {
    c.stun += n;
    if (c.stun > d.stunMonitor) {
      toPhysical = c.stun - d.stunMonitor;
      c.stun = d.stunMonitor;
    }
  } else toPhysical = n;
  if (toPhysical) {
    c.physical += toPhysical;
    if (c.physical > d.physicalMonitor) {
      c.overflow += c.physical - d.physicalMonitor;
      c.physical = d.physicalMonitor;
    }
  }
  c.overflow = Math.min(c.overflow, d.overflowMax + 1);
  const status = syncHealth(ctx.state, a, wasStatus);
  // Translatable log line (status values are stored French words, translated as nested keys).
  let i18n: I18nEntry;
  if (a.type === 'npc') {
    const damage = { t: type === 'S' ? tk('{n} case(s) de dommages étourdissants') : tk('{n} case(s) de dommages physiques'), params: { n } };
    i18n = status !== wasStatus
      ? { key: tk('{name} encaisse {damage} — {status}.'), params: { name: a.name, damage, status: { t: status } } }
      : { key: tk('{name} encaisse {damage}.'), params: { name: a.name, damage } };
  } else {
    const damage = type === 'S'
      ? { t: n > 1 ? tk('{n} dommages étourdissants') : tk('{n} dommage étourdissant'), params: { n } }
      : { t: n > 1 ? tk('{n} dommages physiques') : tk('{n} dommage physique'), params: { n } };
    const trackParams = { p: c.physical, pm: d.physicalMonitor, s: c.stun, sm: d.stunMonitor, o: c.overflow, om: d.overflowMax };
    const track = { t: c.overflow ? tk('P {p}/{pm} · É {s}/{sm} · surplus {o}/{om}') : tk('P {p}/{pm} · É {s}/{sm}'), params: trackParams };
    i18n = status !== wasStatus && STATUS_UPPER[status]
      ? { key: tk('{name} subit {damage} ({track}) — {status}'), params: { name: a.name, damage, track, status: { t: STATUS_UPPER[status] } } }
      : { key: tk('{name} subit {damage} ({track})'), params: { name: a.name, damage, track } };
  }
  ctx.log({ kind: 'combat', userId: ctx.user.id, author: a.name, i18n, gmOnly: a.type === 'npc' && !!a.hidden ? true : undefined });
  if (status === 'mort' && wasStatus !== 'mort') sfx(ctx, 'death');
  return { condition: { ...c }, status };
}

/** 'dice/roll' payload (see ARCHITECTURE.md); every field is checked by performRoll. */
export type RollPayload = {
  actorId?: ActorId | null;
  secret?: boolean;
  label?: string;
  weaponId?: string | null;
  fireMode?: string | null;
  ammoOverride?: boolean;
  skillId?: string | null;
  attr?: string | null;
  attr2?: string | null;
  test?: string | null;
  useSpec?: boolean;
  conditions?: unknown;
  ignore?: unknown;
  /** Extra named lines [{ label, value }] (players: only the sheet's own, recomputed). */
  bonus?: unknown;
  modifier?: unknown;
  applyWounds?: boolean | null;
  explode?: boolean;
  matrixLimit?: string;
  /** number → that limit; null / 0 / '' → no limit; absent → computed. */
  limit?: unknown;
  pool?: unknown;
};
/** A trusted named pool line (attack actions, range, defense options). */
export type RollBonusLine = { label?: string; value?: number };
/** performRoll's server-only options (never from a client). `armorUsed` is written back (soak). */
export type RollInternal = {
  bonus?: RollBonusLine[];
  rounds?: number;
  ap?: number;
  logExtra?: Partial<RollRecord>;
  armorUsed?: number;
};
/** performRoll result: the stored roll plus its log entry. */
export type PerformedRoll = RollRecord & { logId: string; entry: LogEntry };

/**
 * A dice roll with every modifier computed here (dice/roll, attacks module). `internal` never comes from a client:
 * { bonus: [{ label, value }] trusted named lines (attack actions, range, defense options), rounds (fire fewer rounds: Double Tap…),
 *   ap (soak: the attack's AP modifies the armor), logExtra (fields merged into the log entry's roll) }.
 */
export function performRoll(ctx: ActionContext, p: RollPayload | null | undefined, internal: RollInternal = {}): PerformedRoll {
  const payload: RollPayload = p || {};
  let actor: Actor | null = null;
  if (payload.actorId) {
    actor = getActor(ctx, payload.actorId);
    if (!ctx.owns(payload.actorId)) ctx.fail('Tu ne peux lancer que pour ton personnage');
  }
  if (payload.secret && !ctx.isGM) ctx.fail('Seul le MJ peut faire un jet secret');
  const parts: string[] = [];
  let pool = 0;
  let label = str(payload.label, 120).trim();
  let defaultLimit: string | null = null;
  // Weapon attack: skill and limit (Accuracy + accessories) come from the weapon, its accessories add their dice.
  let weapon: Weapon | null = null;
  if (payload.weaponId) {
    if (!actor) ctx.fail('Choisis un personnage pour ce jet');
    weapon = (actor.weapons || []).find((w) => w && w.id === String(payload.weaponId)) || null;
    if (!weapon) ctx.fail('Arme introuvable');
  }
  // A ranged attack fires rounds of the chosen fire mode (or throws a grenade): checked now, used after the checks below.
  const shot = weapon ? planShot(ctx, actor!, weapon, { fireMode: payload.fireMode, ammoOverride: payload.ammoOverride, rounds: internal.rounds }) : null;
  // A weapon attack uses the weapon's skill (only the GM may roll it with another one).
  const asked = payload.skillId ? String(payload.skillId).slice(0, 80) : null;
  const skillId = weapon ? (ctx.isGM && asked) || weapon.skill || 'exotic_weapon' : asked;
  const A1 = payload.attr && ATTRS.includes(payload.attr) ? (payload.attr as AttrKey) : null;
  const A2 = payload.attr2 && ATTRS.includes(payload.attr2) ? (payload.attr2 as AttrKey) : null;
  // An attribute test's own modifiers (soak: + armor, composure, judge intentions…) only for an attribute-only roll on that
  // test's attributes (shared/modifiers.js TEST_ATTRS) — any other claim is ignored.
  const test = checkedTest(payload.test, { skillId, weaponId: weapon?.id, attr: A1, attr2: A2 });
  if ((skillId || A1) && !actor) ctx.fail('Choisis un personnage pour ce jet');
  if (skillId && actor) {
    const sk = actor.skills.find((s) => s.id === skillId || s.name === skillId);
    const kno = !sk && actor.knowledge.find((k) => k.id === skillId);
    if (kno) {
      const at: AttrKey = A1 || (kno.type === 'academic' || kno.type === 'professional' ? 'LOG' : 'INT');
      const r = Number(kno.rating) || 0;
      const spec = payload.useSpec && String(kno.spec || '').trim() ? 2 : 0;
      pool = r + attr(actor, at) + spec;
      parts.push(`${kno.name} ${r}`, `${ATTR_SHORT[at]} ${attr(actor, at)}`);
      if (spec) parts.push('spé. +2');
      if (!label) label = kno.name;
      defaultLimit = 'mental';
    } else {
      const def = (SKILL_BY_ID as Record<string, Loose | undefined>)[skillId];
      const res = skillPool(actor, skillId, { useSpec: !!payload.useSpec, attrOverride: A1 || undefined } as { useSpec: boolean });
      if (res.impossible) ctx.fail('{skill} ne peut pas être utilisée sans formation', { skill: def?.fr ? { t: def.fr } : sk?.name || skillId });
      const at: AttrKey = A1 || sk?.attr || def?.attr || 'AGI';
      pool = res.pool;
      if (res.defaulting) parts.push(`${ATTR_SHORT[at]} ${attr(actor, at)}`, 'par défaut −1');
      else {
        parts.push(`${sk?.name || def?.fr || skillId} ${sk!.rating}`, `${ATTR_SHORT[at]} ${attr(actor, at)}`);
        if (payload.useSpec && sk!.spec) parts.push(`spé. +2`);
      }
      if (!label) label = sk?.name || def?.fr || skillId;
      defaultLimit = skillDefaultLimit(def, at);
    }
  } else if (A1 && actor) {
    pool = attr(actor, A1);
    parts.push(`${ATTR_SHORT[A1]} ${pool}`);
    if (A2) {
      pool += attr(actor, A2);
      parts.push(`${ATTR_SHORT[A2]} ${attr(actor, A2)}`);
    }
    if (!label) label = A2 ? `${ATTR_LABELS[A1]} + ${ATTR_LABELS[A2]}` : ATTR_LABELS[A1];
  } else {
    pool = clampInt(payload.pool, 0, 100);
    parts.push(`${pool} dés`);
  }
  // Modifiers of the actor's gear, qualities, powers, implants (shared/modifiers.js) — computed here, never taken from the
  // client: the client only says which situational switches are on (`conditions`, checked against the actor's modifiers)
  // and which bonuses to leave out (`ignore`: players may only drop bonuses, the GM any modifier).
  const mods = actor ? actorModifiers(actor, { weaponId: weapon?.id }) : [];
  let conditions = cleanConditions(mods, payload.conditions);
  const rctx: Loose = actor ? rollContext(actor, { skillId, attr: A1, attr2: A2, test, weaponId: weapon?.id }) : {};
  // Matrix situation (« en RV chaude », « dans un hôte ») comes from the actor's persona, not from a switch — except for the
  // GM rolling an actor that has no persona.
  const persona = actor ? ctx.state.matrix?.personas?.[actor.id] : null;
  if (actor && (persona || !ctx.isGM)) {
    const online = !!persona?.online;
    rctx.mode = online ? persona!.mode || 'ar' : 'offline';
    conditions = conditions.filter((k) => k !== 'in-host' && k !== 'hot-sim');
    if (online && persona!.hostId) conditions.push(...cleanConditions(mods, ['in-host']));
  }
  const modOpts = { conditions, ignore: Array.isArray(payload.ignore) ? payload.ignore.slice(0, 60).map((x: unknown) => String(x).slice(0, 200)) : [], isGM: ctx.isGM };
  const modLines: RollModLine[] = [];
  const pushLine = (l: Loose, kind: 'pool' | 'limit') => modLines.push({
    id: l.mod.id, kind, type: l.mod.type, name: l.mod.source.name, ...(l.mod.source.nameFr ? { nameFr: l.mod.source.nameFr } : {}),
    value: l.value, state: l.state, ...(l.mod.condition ? { condition: l.mod.condition } : {}), ...(l.mod.wireless ? { wireless: true } : {}),
    ...(l.mod.source.book ? { book: l.mod.source.book, page: l.mod.source.page } : {}),
  });
  if (actor && test === 'soak') {
    // Soak: Body + armor (worn armor, its mods, implants / qualities armor) — never the client's figure.
    const full = derivedWithModifiers(actor, mods);
    const ap = Math.round(Number(internal.ap) || 0);
    const armor = Math.max(0, full.armor + ap);
    pool += armor;
    parts.push(ap ? `armure ${full.armor} PA ${ap > 0 ? '+' : '−'}${Math.abs(ap)}` : `armure ${full.armor}`);
    internal.armorUsed = armor;
  }
  if (actor) {
    const pm = poolModifiers(mods, rctx, modOpts);
    for (const l of pm.lines) {
      pushLine(l, 'pool');
      if (l.state !== 'applied') continue;
      pool += l.value;
      parts.push(`${l.mod.source.name} ${l.value >= 0 ? '+' : '−'}${Math.abs(l.value)}`);
    }
  }
  // Extra named lines: the GM's are kept as typed; a player's are only the sheet's own (total defense « VOL », Matrix defense /
  // biofeedback « Firewall »), recomputed from the actor — anything else a player adds is counted under « mod. ».
  for (const b of Array.isArray(internal.bonus) ? internal.bonus : []) {
    const v = clampInt(b?.value, -50, 50);
    if (!v) continue;
    pool += v;
    parts.push(`${str(b.label, 40) || 'bonus'} ${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  }
  let extraMod = 0;
  const named = new Set();
  for (const b of Array.isArray(payload.bonus) ? payload.bonus.slice(0, 6) : []) {
    const label = str(b?.label, 30).trim();
    let v = clampInt(b?.value, -50, 50);
    if (!ctx.isGM) {
      const known = actor && !named.has(label) ? playerBonus(actor, label, { skillId, test, A1, A2 }) : null;
      if (known === null) {
        extraMod += v;
        continue;
      }
      named.add(label);
      v = known;
    }
    if (!v) continue;
    pool += v;
    parts.push(`${label || 'bonus'} ${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  }
  const mod = clampInt(clampInt(payload.modifier, -50, 50) + extraMod, -50, 50);
  if (mod) {
    pool += mod;
    parts.push(`mod. ${mod > 0 ? '+' : '−'}${Math.abs(mod)}`);
  }
  // Wound modifier: SR5 applies it to every test of the actor's skills / attributes but damage resistance (soak, drain,
  // biofeedback, toxins). Players cannot leave it out; the GM may (applyWounds: false) or force it (true).
  const statRoll = !!(skillId || A1);
  const gmWounds = ctx.isGM && payload.applyWounds !== undefined && payload.applyWounds !== null;
  if ((gmWounds ? !!payload.applyWounds : statRoll && woundsApply(test)) && actor) {
    const w = derivedWithModifiers(actor, mods).woundModifier;
    if (w) {
      pool += w;
      parts.push(`blessures −${Math.abs(w)}`);
    }
  }
  const explode = !!payload.explode;
  if (explode) {
    if (!actor) ctx.fail('Choisis un personnage pour utiliser la Chance');
    if (actor.edge.current <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: actor.name });
    const e = attr(actor, 'EDG');
    pool += e;
    parts.push(`Chance +${e}`);
  }
  pool = Math.min(100, pool);
  if (pool <= 0) ctx.fail('Réserve de dés nulle : échec automatique');
  let limit = null;
  let limitLabel = null;
  let limitBreakdown = null;
  if (!explode) {
    // Computed limit: the weapon's Accuracy (+ accessories) or the skill's default limit, with the limit modifiers.
    let auto = null;
    if (weapon) {
      const acc = weaponAccuracy(actor, weapon, mods, rctx, modOpts);
      if (acc.total !== null) {
        auto = Math.max(1, acc.total); // a limit lowered to 0 stays a limit (never « none »)
        limitLabel = 'précision';
        for (const l of acc.lines) pushLine(l, 'limit');
        if (acc.parts.length > 1) limitBreakdown = acc.parts.map(([n, v], i) => (i ? `${n} ${v >= 0 ? '+' : '−'}${Math.abs(v)}` : `${n} ${v}`)).join(' + ');
      }
    } else if (actor && MATRIX_LIMITS.includes(payload.matrixLimit as string) && actor.matrix && MATRIX_LIMIT_SKILLS.includes(rctx.skillId)) {
      // Matrix test from the sheet (Matrix skills only): the device attribute is the limit (no physical / mental / social modifier).
      const v = Number(actor.matrix[payload.matrixLimit as keyof ActorMatrix]) || 0;
      if (v > 0) {
        auto = v;
        limitLabel = MATRIX_LIMIT_LABEL[payload.matrixLimit as string];
      }
    } else if (defaultLimit && actor) {
      const lim = limitFor(actor, defaultLimit, mods, rctx, modOpts);
      if (lim.total !== null) {
        auto = Math.max(1, lim.total); // a limit lowered to 0 stays a limit (never « none »)
        limitLabel = LIMIT_LABEL[defaultLimit];
        for (const l of lim.lines) pushLine(l, 'limit');
        const applied = lim.lines.filter((l: Loose) => l.state === 'applied');
        if (applied.length) limitBreakdown = [`${LIMIT_LABEL[defaultLimit]} ${lim.base}`, ...applied.map((l: Loose) => `${l.mod.source.name} ${l.value >= 0 ? '+' : '−'}${Math.abs(l.value)}`)].join(' + ');
      }
    }
    // limit: number → that limit; null/0/'' → explicitly no limit; absent → computed. Players can neither raise nor remove a
    // computed limit (null / 0 / a higher number → the computed one).
    if (payload.limit !== undefined) {
      limit = clampInt(payload.limit, 0, 50) || null;
      if (!ctx.isGM && auto !== null && (limit === null || limit > auto)) limit = auto;
      if (limit !== auto) {
        limitLabel = null;
        limitBreakdown = null;
      }
    } else limit = auto;
  }
  if (explode) actor!.edge.current -= 1;
  const fire = shot ? applyShot(actor!, weapon!, shot) : null;
  const r = rollDice(pool, { limit, explode });
  if (!label) label = `Jet de ${pool} dés`;
  // Weapon attack (« Attaque — <arme> »): the weapon's name in both languages, each viewer reads their own (common.js rollLabel).
  const labelI18n = weapon && /^Attaque — /.test(label) ? { key: tk('Attaque — {weapon}'), params: { weapon: biName(weapon) } } : null;
  // roll.fire of a thrown item is { item: true, left, removed? } (no mode / rounds): FireInfo in shared/types.ts only covers ammunition.
  const roll: RollRecord = {
    ...r, label, ...(labelI18n ? { labelI18n } : {}), explode, edge: explode, actorId: actor?.id || null, breakdown: parts.join(' + '), ...(fire ? { fire: fire as FireInfo } : {}),
    ...(limitLabel ? { limitLabel } : {}), ...(limitBreakdown ? { limitBreakdown } : {}), ...(payload.secret ? { secret: true } : {}),
    ...(modLines.length ? { mods: modLines } : {}), ...(conditions.length ? { conditions } : {}), ...(internal.logExtra || {}),
  };
  const author = actor ? actor.name : ctx.displayName();
  const hidden = !!payload.secret || (actor && actor.type === 'npc' && ctx.isGM && actor.hidden);
  const entry = ctx.log({ kind: 'roll', userId: ctx.user.id, author, text: label, roll, ...(hidden ? { gmOnly: true } : {}) });
  sfx(ctx, 'dice', hidden ? 'gm' : 'all');
  return { ...roll, logId: entry.id, entry };
}

// ---------------------------------------------------------------------------
// Action payloads (checked by the handlers)
// ---------------------------------------------------------------------------
type ActorCreatePayload = { type?: string; name?: unknown; [field: string]: unknown };
type ActorPatchPayload = { actorId: ActorId; patch?: unknown };
type ActorDeletePayload = { actorId?: ActorId; actorIds?: unknown };
type ActorDuplicatePayload = { actorId: ActorId; name?: unknown };
type AddItemPayload = { actorId: ActorId; list: string; item?: unknown; adjustEssence?: boolean };
type UpdateItemPayload = { actorId: ActorId; list: string; itemId?: string; index?: number; patch?: unknown };
type SubItemPayload = { actorId: ActorId; list: string; itemId?: string; sub: string; subId?: string; item?: unknown; patch?: unknown };
type RemoveItemPayload = { actorId: ActorId; list: string; itemId?: string; index?: number; adjustEssence?: boolean };
type AddContainerPayload = { actorId: ActorId; name?: unknown; kind?: string; notes?: unknown };
type ContainerPayload = { actorId: ActorId; containerId?: string; patch?: unknown };
type MovePayload = { actorId: ActorId; list: string; itemId?: string; location?: unknown };
type FirePayload = { actorId: ActorId; weaponId?: unknown; mode?: unknown; override?: unknown };
type ReloadPayload = { actorId: ActorId; weaponId?: unknown; sourceItemId?: unknown; free?: unknown };
type DamagePayload = { actorId: ActorId; amount?: unknown; type?: string };
type AdjustPayload = { actorId?: ActorId; actorIds?: unknown; karma?: unknown; nuyen?: unknown; reason?: unknown };
type EdgeSpendPayload = { actorId: ActorId; reason?: unknown };
type EdgeRefreshPayload = { actorId?: ActorId; all?: boolean };
type SecondChancePayload = { logId?: string };
type SinCheckPayload = { actorId: ActorId; sinId?: unknown; license?: unknown; device?: unknown; secret?: boolean };
type ContactRollPayload = {
  actorId: ActorId; contactId?: unknown; kind?: string; modifier?: unknown; secret?: boolean;
  useSpec?: boolean; explode?: boolean; bribe?: unknown; threshold?: unknown;
};
type SinBurnPayload = { actorId: ActorId; sinId?: unknown; burned?: boolean };

// No @types/express yet (the server-core agent adds it): loose aliases for routes().
type ExpressApp = any;
type Req = any;
type Res = any;

const mod: ServerModule<ExpressApp> = {
  name: 'characters',

  init(state: TableState, { seedDir }: InitOptions) {
    state.actors ||= {};
    const dir = path.join(seedDir, 'actors');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        let list: unknown;
        try {
          list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (err) {
          console.error(`[characters] seed ${f} invalide :`, (err as Error).message);
          continue;
        }
        for (const a of (Array.isArray(list) ? list : [list]) as Loose[]) {
          if (a && a.id && !state.actors[a.id]) state.actors[a.id] = deepClone(a);
        }
      }
    }
    for (const [id, a] of Object.entries(state.actors)) {
      if (!a || typeof a !== 'object') {
        delete state.actors[id];
        continue;
      }
      a.id = id;
      normalizeActor(a, uid); // also the inventory migration: containers, locations, ammo, ready weapons (idempotent)
      fillActorRefs(a); // rulebook references of items created before item.source existed (idempotent)
      // Catalog names in both languages, catalogId backfill by exact name (idempotent). A completed weapon `ammo` (Foundry « 14 » →
      // « 14(c) ») is parsed again by the migration, so the second boot finds the same state.
      if (fillItemNames(a)) normalizeActor(a, uid);
    }
  },

  actions: {
    // { type: 'pc'|'npc', name, ...fields } → id
    'actor/create': {
      role: 'gm',
      handler(ctx: ActionContext, payload: ActorCreatePayload) {
        const { type = 'npc', name, ...rest } = payload || {};
        const cleanName = String(name || '').trim();
        if (!cleanName) ctx.fail('Donne un nom au personnage');
        const a = blankActor(type === 'pc' ? 'pc' : 'npc', cleanName.slice(0, 80)) as unknown as Actor;
        const id = ctx.uid(a.type);
        a.id = id;
        const { id: _ignore, ...fields } = rest;
        for (const [k, v] of Object.entries(fields)) {
          if (BAD_KEYS.has(k)) continue;
          if (MERGE_KEYS.includes(k) && isObj(v)) loose(a)[k] = { ...(loose(a)[k] || {}), ...v };
          else if (v !== undefined) loose(a)[k] = sanitizeTop(k, v, a, ctx);
        }
        normalizeActor(a, uid);
        fillActorRefs(a);
        if (fields.edge === undefined) a.edge.current = a.attributes.EDG;
        a.history.push({ ts: ctx.now, text: tk('Création du personnage') });
        ctx.state.actors[id] = a;
        return id;
      },
    },

    // { actorId, patch }
    'actor/update': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, patch }: ActorPatchPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const wasStatus = statusOf(a);
        applyPatch(ctx, a, patch);
        syncHealth(ctx.state, a, wasStatus);
        return true;
      },
    },

    // { actorId } or { actorIds: [] }
    'actor/delete': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, actorIds }: ActorDeletePayload) {
        const ids: unknown[] = Array.isArray(actorIds) ? actorIds : [actorId];
        let n = 0;
        for (const id of ids) {
          if (id && ctx.state.actors[id as ActorId]) {
            removeActor(ctx.state, id as ActorId);
            n++;
          }
        }
        if (!n) ctx.fail('Personnage introuvable');
        return n;
      },
    },

    // { actorId, name? } → new id
    'actor/duplicate': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, name }: ActorDuplicatePayload) {
        const src = getActor(ctx, actorId);
        const a: Actor = deepClone(src);
        a.id = ctx.uid(a.type);
        a.name = String(name || ctx.t(tk('{name} (copie)'), { name: src.name })).slice(0, 80); // stored in the table language
        for (const k of ITEM_LISTS) if (Array.isArray(loose(a)[k]) && k !== 'skills') for (const it of loose(a)[k]) it.id = ctx.uid('itm');
        a.history = [...(a.history || []), { ts: ctx.now, text: `Copie de ${src.name}`, i18n: { key: 'Copie de {name}', params: { name: src.name } } }];
        normalizeActor(a, uid);
        ctx.state.actors[a.id] = a;
        return a.id;
      },
    },

    // { actorId, list, item, adjustEssence? } → item id
    'actor/addItem': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, list, item, adjustEssence }: AddItemPayload) {
        const a = getActor(ctx, actorId);
        if (!ITEM_LISTS.includes(list)) ctx.fail('Liste inconnue : {list}', { list: String(list) });
        if (!isObj(item)) ctx.fail('Élément invalide');
        const it = sanitizeItem(list, item, ctx);
        if (!Array.isArray(loose(a)[list])) loose(a)[list] = [];
        if (list === 'skills') {
          it.id = it.id || slugify(it.name || '');
          if (!it.id || it.id === 'x') ctx.fail('Compétence sans nom');
          if (a.skills.some((s) => s.id === it.id)) ctx.fail('Cette compétence est déjà sur la fiche');
          const def = (SKILL_BY_ID as Record<string, Loose | undefined>)[it.id];
          it.name = it.name || def?.fr || it.id;
          it.attr = it.attr || def?.attr || 'AGI';
          it.rating = clampInt(it.rating ?? 1, 0, 13, 1);
          if (def?.group && !it.group) it.group = def.group;
        } else {
          it.id = ctx.uid('itm');
          if (!it.name && list !== 'skillGroups') it.name = 'Nouvel élément';
        }
        if (list === 'gear' && it.qty === undefined) it.qty = 1;
        if (list === 'augmentations') {
          // Bonuses come from the catalog only (never from the client), recorded on the item so removal reverses them.
          delete it.bonus;
          const st = wareCatalogItem(it.catalogId)?.stats || {};
          bakeItemBonus(a, list, it, st.bonus);
          if (st.weapon) {
            if (!Array.isArray(a.weapons)) a.weapons = [];
            a.weapons.push(weaponFromStats(ctx, it.name, it.category, st.weapon, { augId: it.id }) as Weapon);
          }
        }
        if (list === 'weapons') delete it.augId;
        if (list === 'powers' || list === 'qualities') {
          // Attribute / initiative bonus of the catalog effects (Improved Reflexes, Lightning Reflexes…) stored on the actor, recorded on item.bonus.
          delete it.bonus;
          bakeItemBonus(a, list, it);
        }
        if (list === 'lifestyles') {
          it.base ||= 'Medium';
          it.baseCost ??= 0;
          it.monthsPaid ??= 0;
          it.qualities ||= [];
          if (!a.lifestyles.length) it.primary = true;
        }
        if (list === 'martialArts') {
          it.rating ??= 1;
          it.techniques ||= [];
        }
        if (LOCATED_LISTS.includes(list) && it.location !== undefined) it.location = cleanLocation(ctx, a, it.location);
        loose(a)[list].push(it);
        settleItem(a, list, it, false);
        if (LOCATED_LISTS.includes(list)) normalizeActor(a, uid); // ammo capacity / loaded rounds / location of the new item
        fillActorRefs(a); // 📖 source / page from the catalog when the item has none
        if (fillItemNames(a)) normalizeActor(a, uid);
        if (list === 'lifestyles') settleLifestyles(a, it.primary ? it.id : null);
        if (adjustEssence && list === 'augmentations' && it.essence) {
          a.attributes.ESS = Math.max(0, Math.round((a.attributes.ESS - it.essence) * 1000) / 1000);
        }
        return it.id;
      },
    },

    // { actorId, list, itemId, patch }
    'actor/updateItem': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, list, itemId, index, patch }: UpdateItemPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const idx = findItem(ctx, a, list, itemId, index);
        if (!isObj(patch)) ctx.fail('Modification invalide');
        if (!ctx.isGM) {
          const allowed: string[] = (PLAYER_ITEM_FIELDS as Record<string, string[] | undefined>)[list] || [];
          const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
          if (bad.length) ctx.fail(allowed.length ? tk('Tu peux seulement modifier : {fields}') : tk('Seul le MJ peut modifier cet élément'), allowed.length ? { fields: allowed.join(', ') } : undefined);
        }
        const clean = sanitizeItem(list, patch, ctx);
        delete clean.id;
        if (list === 'skills' && clean.rating !== undefined) clean.rating = clampInt(clean.rating, 0, 13);
        if (list === 'gear' && clean.qty !== undefined) {
          clean.qty = clampInt(clean.qty, 0, 9999);
          // Players may record consumption, never create units (they could then sell them to the shop).
          const cur = Math.max(0, Number(loose(a)[list][idx].qty ?? 1) || 0);
          if (!ctx.isGM && clean.qty > cur) ctx.fail('Seul le MJ peut augmenter une quantité');
        }
        if (list === 'augmentations' || list === 'powers' || list === 'qualities') delete clean.bonus;
        if (list === 'weapons') delete clean.augId;
        if (list === 'weapons' && clean.ammoLeft !== undefined) {
          // Legacy field (before ammoLoaded): same meaning.
          if (clean.ammoLoaded === undefined) clean.ammoLoaded = clean.ammoLeft;
          delete clean.ammoLeft;
        }
        if (list === 'weapons' && clean.ammoLoaded !== undefined && !usesAmmo(loose(a)[list][idx]) && !String(patch.ammo ?? '').trim()) delete clean.ammoLoaded;
        if (list === 'weapons' && clean.ammoLoaded !== undefined && !ctx.isGM && clean.ammoLoaded > loadedOf(loose(a)[list][idx])) {
          ctx.fail('Recharge avec le bouton « Recharger » : les balles viennent de l’inventaire');
        }
        if (LOCATED_LISTS.includes(list) && clean.location !== undefined) clean.location = cleanLocation(ctx, a, clean.location);
        if (LOCATED_LISTS.includes(list) && (clean.equipped === true || clean.active === true)) {
          // Readying / wearing / switching on: within reach only (a bag is emptied onto the body by settleItem).
          requireReach(ctx, a, { ...loose(a)[list][idx], location: clean.location ?? loose(a)[list][idx].location });
        }
        // A new name / category / catalog entry: the catalog names in both languages are looked up again (fillItemNames).
        if (clean.name !== undefined && clean.nameFr === undefined) clean.nameFr = clean.nameEn = null;
        if (clean.category !== undefined && clean.categoryFr === undefined) clean.categoryFr = clean.categoryEn = null;
        if (clean.catalogId !== undefined && clean.catalogId !== loose(a)[list][idx].catalogId) for (const k of BILINGUAL) if (clean[k] === undefined) clean[k] = null;
        const before = loose(a)[list][idx];
        loose(a)[list][idx] = { ...loose(a)[list][idx], ...clean };
        for (const [k, v] of Object.entries(loose(a)[list][idx])) if (v === null) delete loose(a)[list][idx][k];
        settleItem(a, list, loose(a)[list][idx], clean.equipped === true || clean.active === true, ctx.isGM);
        if (LOCATED_LISTS.includes(list) && clean.location !== undefined) noteRetrieval(ctx, a, loose(a)[list][idx], before.location);
        if (BONUS_LISTS.includes(list) && BONUS_FIELDS.some((k) => clean[k] !== undefined && clean[k] !== before[k]) && !importedItem(before)) {
          // New rating / level / choice: the stored attribute / initiative bonus follows (items whose bonus the app recorded, or that had none).
          const st = list === 'augmentations' ? wareCatalogItem(loose(a)[list][idx].catalogId)?.stats || {} : {};
          if (before.bonus || !itemBonusSpec(list, before, st.bonus)) bakeItemBonus(a, list, loose(a)[list][idx], st.bonus);
        }
        if (list === 'lifestyles') settleLifestyles(a, clean.primary ? loose(a)[list][idx].id : null);
        if (LOCATED_LISTS.includes(list)) normalizeActor(a, uid); // new `ammo` → capacity, loaded rounds clamped
        if (fillItemNames(a)) normalizeActor(a, uid);
        return true;
      },
    },

    // Nested lists (GM): weapon accessories, armor/vehicle mods, lifestyle qualities, martial art techniques.
    // { actorId, list, itemId, sub: 'accessories'|'mods'|'qualities'|'techniques', item } → sub-item id
    'actor/addSubItem': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, list, itemId, sub, item }: SubItemPayload) {
        const { a, arr } = findSubParent(ctx, actorId, list, itemId, sub);
        if (arr.length >= 60) ctx.fail('Trop d’éléments');
        const x = sanitizeSub(ctx, sub, item);
        for (const [k, v] of Object.entries(x)) if (v === null) delete x[k];
        x.id = ctx.uid('sub');
        arr.push(x);
        fillActorRefs(a);
        if (list === 'lifestyles') settleLifestyles(a);
        return x.id;
      },
    },

    // { actorId, list, itemId, sub, subId, patch }
    'actor/updateSubItem': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, list, itemId, sub, subId, patch }: SubItemPayload) {
        const { a, arr } = findSubParent(ctx, actorId, list, itemId, sub);
        const i = arr.findIndex((x) => x.id === subId);
        if (i < 0) ctx.fail('Élément introuvable');
        const clean = sanitizeSub(ctx, sub, patch, true);
        delete clean.id;
        arr[i] = { ...arr[i], ...clean };
        for (const [k, v] of Object.entries(arr[i])) if (v === null || v === undefined) delete arr[i][k];
        if (list === 'lifestyles') settleLifestyles(a);
        return true;
      },
    },

    // { actorId, list, itemId, sub, subId }
    'actor/removeSubItem': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, list, itemId, sub, subId }: SubItemPayload) {
        const { a, it, arr } = findSubParent(ctx, actorId, list, itemId, sub);
        const i = arr.findIndex((x) => x.id === subId);
        if (i < 0) ctx.fail('Élément introuvable');
        arr.splice(i, 1);
        it[sub] = arr;
        if (list === 'lifestyles') settleLifestyles(a);
        return true;
      },
    },

    // { actorId, list, itemId, adjustEssence? }
    'actor/removeItem': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, list, itemId, index, adjustEssence }: RemoveItemPayload) {
        const a = getActor(ctx, actorId);
        const idx = findItem(ctx, a, list, itemId, index);
        const [it]: Loose[] = loose(a)[list].splice(idx, 1);
        if (list === 'augmentations') detachAugmentation(a, it); // its attribute/initiative bonus and implant weapon
        if (list === 'powers' || list === 'qualities') removeBonus(a, it.bonus); // e.g. Improved Reflexes, Lightning Reflexes
        if (list === 'lifestyles') settleLifestyles(a);
        if (adjustEssence && list === 'augmentations' && it.essence) {
          a.attributes.ESS = Math.min(6, Math.round((a.attributes.ESS + Number(it.essence)) * 1000) / 1000);
        }
        return true;
      },
    },

    // ----- Inventory (owner or GM): containers, item locations, firing without a roll, reloading -----
    // { actorId, name, kind?: 'body'|'bag'|'vehicle'|'safehouse'|'other', notes? } → container id
    'inventory/addContainer': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, name, kind, notes }: AddContainerPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const n = str(name, 60).trim();
        if (!n) ctx.fail('Donne un nom au contenant');
        const containers = a.containers!; // normalizeActor (getActor) creates the list
        if (containers.length >= 30) ctx.fail('Trop de contenants');
        const c: Container = { id: ctx.uid('ct'), name: n, kind: (CONTAINER_KINDS as Record<string, string>)[kind as string] ? (kind as ContainerKind) : guessContainerKind(n) };
        if (notes) c.notes = str(notes, 500);
        containers.push(c);
        return c.id;
      },
    },

    // { actorId, containerId, patch: { name?, kind?, notes? } }
    'inventory/updateContainer': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, containerId, patch }: ContainerPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const c = containerOf(a, containerId);
        if (!c) ctx.fail('Contenant introuvable');
        if (!isObj(patch)) ctx.fail('Modification invalide');
        if (patch.name !== undefined) {
          const n = str(patch.name, 60).trim();
          if (!n) ctx.fail('Donne un nom au contenant');
          c.name = n;
        }
        if (patch.kind !== undefined) {
          if (!(CONTAINER_KINDS as Record<string, string>)[patch.kind]) ctx.fail('Type de contenant inconnu');
          // A vehicle / safehouse / other place does not become a bag or « worn » (its contents would come within reach): GM only.
          if (patch.kind !== c.kind && !ctx.isGM && reachOf(a, c.id) >= 2) ctx.fail('Seul le MJ peut changer le type de {place}', { place: c.name });
          c.kind = patch.kind;
        }
        if (patch.notes !== undefined) {
          if (patch.notes) c.notes = str(patch.notes, 500);
          else delete c.notes;
        }
        normalizeActor(a, uid); // a bag that became a vehicle / safehouse: what it holds is switched off
        return true;
      },
    },

    // { actorId, containerId } — what it holds goes back « Sur soi ».
    'inventory/removeContainer': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, containerId }: ContainerPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const c = containerOf(a, containerId);
        if (!c) ctx.fail('Contenant introuvable');
        // A vehicle / safehouse that still holds items: removing it would bring them all « Sur soi » at once (GM only).
        if (!ctx.isGM && reachOf(a, c.id) >= 2 && LOCATED_LISTS.some((l) => (loose(a)[l] || []).some((it: Loose) => it && it.location === c.id))) {
          ctx.fail('{place} contient encore des objets : récupère-les d’abord', { place: c.name });
        }
        a.containers = a.containers!.filter((x) => x.id !== containerId);
        let moved = 0;
        for (const list of LOCATED_LISTS) {
          for (const it of loose(a)[list] || []) {
            if (it.location === containerId) {
              it.location = ON_BODY;
              moved++;
            }
          }
        }
        return moved;
      },
    },

    // { actorId, list: 'weapons'|'armor'|'gear', itemId, location: 'on'|containerId } → { location, stowed }
    // Stored away (bag, vehicle, safehouse): the item stops being ready / worn / active.
    'inventory/move': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, list, itemId, location }: MovePayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        if (!LOCATED_LISTS.includes(list)) ctx.fail('Liste inconnue : {list}', { list: String(list) });
        const it: Loose = loose(a)[list][findItem(ctx, a, list, itemId)];
        const from = it.location;
        it.location = cleanLocation(ctx, a, location);
        noteRetrieval(ctx, a, it, from);
        return { location: it.location, stowed: settleItem(a, list, it, false) === 'stowed' };
      },
    },

    // { actorId, weaponId, mode?: 'SS'|'SA'|'SB'|'BF'|'LB'|'FA'|'FAC'|'SUP', override? (GM) } → { rounds, left, max } — rounds used without a roll.
    'weapon/fire': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, weaponId, mode, override }: FirePayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const w = (a.weapons || []).find((x) => x && x.id === String(weaponId));
        if (!w) ctx.fail('Arme introuvable');
        const shot = planShot(ctx, a, w, { fireMode: mode, ammoOverride: override });
        if (!shot) ctx.fail('Cette arme n’utilise pas de munitions');
        const res = applyShot(a, w, shot);
        const i18n: I18nEntry = shot.kind === 'ammo'
          ? { key: tk('{name} tire {n} balle(s) avec {weapon} — reste {left}/{max}'), params: { name: a.name, n: shot.rounds, weapon: biName(w), left: res.left, max: res.max as number } }
          : { key: tk('{name} lance {weapon}'), params: { name: a.name, weapon: biName(w) } };
        ctx.log({ kind: 'combat', userId: ctx.user.id, author: a.name, i18n, gmOnly: a.type === 'npc' ? true : undefined });
        return res;
      },
    },

    // { actorId, weaponId, sourceItemId?, free? (GM: no ammunition used) } → { loaded, ammoLoaded, max, action, swap, sourceId, clipId, returned, dropped }
    'weapon/reload': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, weaponId, sourceItemId, free }: ReloadPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const w = (a.weapons || []).find((x) => x && x.id === String(weaponId));
        if (!w) ctx.fail('Arme introuvable');
        return reloadWeapon(ctx, a, w, { sourceItemId, free });
      },
    },

    // { actorId, amount, type: 'P'|'S' } → { condition, status }
    'actor/damage': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, amount, type }: DamagePayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const n = clampInt(amount, 0, 100);
        if (!n) ctx.fail('Indique un nombre de cases de dommages');
        if (!['P', 'S'].includes(type as string)) ctx.fail('Type de dommages invalide (P ou S)');
        return applyDamage(ctx, a, n, type as DamageType);
      },
    },

    // { actorId, amount, type: 'P'|'S'|'all' }
    'actor/heal': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, amount, type }: DamagePayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const c = a.condition;
        const wasStatus = statusOf(a);
        if (type === 'all') {
          c.physical = 0;
          c.stun = 0;
          c.overflow = 0;
        } else {
          let n = clampInt(amount, 0, 999);
          if (!n) ctx.fail('Indique un nombre de cases à soigner');
          if (type === 'S') c.stun = Math.max(0, c.stun - n);
          else if (type === 'P') {
            const fromOverflow = Math.min(c.overflow, n);
            c.overflow -= fromOverflow;
            n -= fromOverflow;
            c.physical = Math.max(0, c.physical - n);
          } else ctx.fail('Type de soin invalide');
        }
        sfx(ctx, 'heal', a.type === 'npc' ? 'gm' : 'all');
        return { condition: { ...c }, status: syncHealth(ctx.state, a, wasStatus) };
      },
    },

    // { actorId | actorIds, karma?, nuyen?, reason }
    'actor/adjust': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, actorIds, karma, nuyen, reason }: AdjustPayload) {
        const ids: unknown[] = Array.isArray(actorIds) ? actorIds : actorId ? [actorId] : [];
        if (!ids.length) ctx.fail('Choisis au moins un personnage');
        const dk = clampInt(karma, -10000, 10000);
        const dn = clampInt(nuyen, -1e8, 1e8);
        if (!dk && !dn) ctx.fail('Rien à ajuster (karma et nuyens à 0)');
        const typed = str(reason, 300).trim();
        const why = typed || (dk > 0 || dn > 0 ? tk('Récompense') : tk('Ajustement MJ'));
        const actors = ids.map((id) => getActor(ctx, id));
        for (const a of actors) {
          if (a.karma + dk < 0) ctx.fail('{name} n’a pas assez de karma ({karma})', { name: a.name, karma: a.karma });
          if (a.nuyen + dn < 0) ctx.fail('{name} n’a pas assez de nuyens ({nuyen})', { name: a.name, nuyen: fmtNuyen(a.nuyen) });
        }
        for (const a of actors) {
          a.karma += dk;
          if (dk > 0) a.karmaTotal += dk;
          a.nuyen += dn;
          a.history.push({ ts: ctx.now, text: why, ...(dk ? { karma: dk } : {}), ...(dn ? { nuyen: dn } : {}) });
        }
        const parts: Array<string | I18nMessage> = [];
        if (dk) parts.push({ t: '{v} karma', params: { v: `${dk > 0 ? '+' : ''}${dk}` } });
        if (dn) parts.push(`${dn > 0 ? '+' : '−'}${fmtNuyen(Math.abs(dn))}`);
        const pcs = actors.filter((a) => !(a.type === 'npc' && a.hidden));
        ctx.log({
          kind: 'system', author: 'MJ', gmOnly: pcs.length ? undefined : true,
          i18n: { key: '{reason} : {changes} pour {names}.', params: { reason: typed || { t: why }, changes: parts, names: names(actors.map((a) => a.name)) } },
        });
        if (dk > 0) sfx(ctx, 'level-up');
        else if (dn > 0) sfx(ctx, 'cash');
        return true;
      },
    },

    // { actorId } → remaining Edge
    'edge/spend': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, reason }: EdgeSpendPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        if (a.edge.current <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: a.name });
        a.edge.current -= 1;
        const edgeParams = { name: a.name, cur: a.edge.current, max: a.attributes.EDG };
        const i18n = reason
          ? { key: tk('{name} dépense 1 point de Chance ({reason}) — reste {cur}/{max}.'), params: { ...edgeParams, reason: str(reason, 120) } }
          : { key: tk('{name} dépense 1 point de Chance — reste {cur}/{max}.'), params: edgeParams };
        ctx.log({ kind: 'system', userId: ctx.user.id, author: a.name, i18n, gmOnly: a.type === 'npc' ? true : undefined });
        return a.edge.current;
      },
    },

    // { actorId } or { all: true } (GM) / actorId: 'all'
    'edge/refresh': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, all }: EdgeRefreshPayload) {
        if (all || actorId === 'all') {
          if (!ctx.isGM) ctx.fail('Réservé au MJ');
          const pcs = Object.values(ctx.state.actors).filter((a) => a.type === 'pc' && !a.retired);
          for (const a of pcs) a.edge.current = attr(a, 'EDG');
          ctx.log({ kind: 'system', author: 'MJ', i18n: { key: 'La Chance de tous les runners est rechargée.' } });
          return pcs.length;
        }
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        a.edge.current = attr(a, 'EDG');
        return a.edge.current;
      },
    },

    // See ARCHITECTURE.md + { skillId, attr, attr2, useSpec, applyWounds, bonus: [{label, value}] }
    'dice/roll': {
      role: 'any',
      handler(ctx: ActionContext, p: RollPayload) {
        const { entry, ...out } = performRoll(ctx, p);
        return out;
      },
    },

    // Edge « Seconde chance »: reroll every die that is not a hit. { logId }
    'dice/secondChance': {
      role: 'any',
      handler(ctx: ActionContext, { logId }: SecondChancePayload) {
        const e = ctx.state.log.find((x) => x.id === logId);
        if (!e || e.kind !== 'roll' || !e.roll) ctx.fail('Jet introuvable');
        const r = e.roll;
        if (!r.actorId) ctx.fail('Ce jet n’est lié à aucun personnage');
        const a = getActor(ctx, r.actorId);
        requireOwn(ctx, r.actorId);
        if (r.explode) ctx.fail('Impossible : la Chance a déjà été utilisée pour ce jet (Repousser les limites)');
        if (r.secondChance) ctx.fail('Seconde chance déjà utilisée pour ce jet');
        if (typeof r.hits !== 'number') ctx.fail('Ce jet n’a pas de succès à relancer');
        if (r.sinCheck) ctx.fail('La Chance ne s’applique pas au contrôle d’un SIN (c’est le jet du système)');
        if (a.edge.current <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: a.name });
        a.edge.current -= 1;
        const before = [...r.dice];
        const rerolled = before.map((d: number) => (d >= 5 ? d : 1 + Math.floor(Math.random() * 6)));
        const raw = rerolled.filter((d) => d >= 5).length;
        r.secondChance = { before };
        r.dice = rerolled;
        r.rawHits = raw;
        r.hits = r.limit ? Math.min(raw, r.limit) : raw;
        r.limited = !!r.limit && raw > r.limit;
        r.edge = true;
        sfx(ctx, 'dice', e.gmOnly ? 'gm' : 'all');
        return { ...r };
      },
    },

    // SIN verification (SR5 p. 364): the system rolls Device Rating × 2, threshold = the fake SIN's (or license's) rating.
    // { actorId, sinId, license?: index in sin.licenses, device: 1-6, secret?: GM only (gmOnly log, nothing burned automatically) }
    'actor/sinCheck': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, sinId, license, device, secret }: SinCheckPayload) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        if (secret && !ctx.isGM) ctx.fail('Seul le MJ peut faire un jet secret');
        const sin = (a.sins || []).find((x) => x && x.id === String(sinId));
        if (!sin) ctx.fail('SIN introuvable');
        if (isRealSin(sin)) ctx.fail('Un vrai SIN passe toujours le contrôle');
        const dev = Math.round(Number(device));
        if (!(dev >= 1 && dev <= MAX_DEVICE_RATING)) ctx.fail('Indice du système de vérification invalide');
        const lics = sinLicenses(sin);
        const li = license === undefined || license === null || license === '' ? null : clampInt(license, 0, 999, -1);
        if (li !== null && !lics[li]) ctx.fail('Licence introuvable');
        const lic = li === null ? null : lics[li];
        const identity = sinIdentity(sin);
        const threshold = lic ? lic.rating : sinRating(sin);
        const base = { sinId: sin.id, sin: identity, device: dev, threshold, ...(lic ? { license: lic.name, licenseIndex: li as number } : {}) };
        const hidden = !!secret || (a.type === 'npc' && !!a.hidden);
        if (sin.burned) {
          // « Any further use of the fake SIN automatically fails »: no roll.
          ctx.log({
            kind: 'system', userId: ctx.user.id, author: a.name, ...(hidden ? { gmOnly: true } : {}),
            i18n: { key: tk('{actor} présente {sin} : SIN grillé, le contrôle échoue d’office'), params: { actor: a.name, sin: identity } },
          });
          return { ...base, outcome: 'auto' };
        }
        const pool = verificationPool(dev);
        const r = rollDice(pool);
        const outcome = sinCheckOutcome(r.hits, threshold);
        const label = lic ? `Contrôle de licence — ${lic.name} (${identity})` : `Contrôle de SIN — ${identity}`; // i18n-ignore (stored French label, labelI18n below)
        const labelI18n: I18nEntry = lic
          ? { key: tk('Contrôle de licence — {license} ({sin})'), params: { license: lic.name, sin: identity } }
          : { key: tk('Contrôle de SIN — {sin}'), params: { sin: identity } };
        const roll: RollRecord & { sinCheck: SinCheckInfo } = { ...r, pool, label, labelI18n, actorId: a.id, ...(secret ? { secret: true } : {}), sinCheck: { ...base, outcome: outcome as SinCheckInfo['outcome'] } };
        // A visible check that exceeds the threshold burns the SIN; a secret one leaves it to the GM (card « Griller »).
        if (outcome === 'burned' && !secret) {
          sin.burned = true;
          sin.burnedAt = Date.now();
          roll.sinCheck.burnedNow = true;
        }
        const entry = ctx.log({ kind: 'roll', userId: ctx.user.id, author: a.name, text: label, roll, ...(hidden ? { gmOnly: true } : {}) });
        sfx(ctx, 'dice', hidden ? 'gm' : 'all');
        return { ...roll, logId: entry.id };
      },
    },

    // Rolls with a contact (SR5 p. 387-389, shared/contacts.js). Owner or GM.
    // { actorId, contactId, kind: 'reach'|'negotiate'|'legwork'|'network', modifier?, secret? (GM),
    //   negotiate: useSpec?, explode? (Edge), bribe? (bought dice, 0-6); network: threshold (target's Connection 1-12) }
    'actor/contactRoll': {
      role: 'any',
      handler(ctx: ActionContext, p: ContactRollPayload) {
        const { actorId, contactId, kind } = p || ({} as Partial<ContactRollPayload>);
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        if (p.secret && !ctx.isGM) ctx.fail('Seul le MJ peut faire un jet secret');
        if (!CONTACT_ROLLS.includes(kind as string)) ctx.fail('Jet de contact inconnu');
        const c = (a.contacts || []).find((x) => x && x.id === String(contactId));
        if (!c) ctx.fail('Contact introuvable');
        const name = str(c.name, 120) || '?';
        const cn = connectionOf(c);
        const loy = loyaltyOf(c);
        const mod = clampInt(p.modifier, -20, 20, 0);
        const hidden = !!p.secret || (a.type === 'npc' && !!a.hidden);
        const info = { kind: kind as ContactRollInfo['kind'], contactId: c.id, contact: name, connection: cn, loyalty: loy };
        // The « reach » roll is a 2D6 total without hits / limit: not a full RollRecord.
        const finish = (roll: Loose) => {
          const entry = ctx.log({ kind: 'roll', userId: ctx.user.id, author: roll.authorName || a.name, text: roll.label, roll: roll as RollRecord, ...(hidden ? { gmOnly: true } : {}) });
          delete roll.authorName;
          sfx(ctx, 'dice', hidden ? 'gm' : 'all');
          return { ...roll, logId: entry.id };
        };

        if (kind === 'negotiate') {
          // The runner's own test (modifiers, wounds, Social limit, Edge) with the contact's Loyalty as extra dice.
          const bribe = clampInt(p.bribe, 0, 6, 0);
          const label = `Négociation avec ${name}`; // i18n-ignore (stored French label, labelI18n below)
          const bonus = [{ label: `Loyauté ${name}`, value: loy }, ...(bribe ? [{ label: 'dés achetés', value: bribe }] : [])]; // i18n-ignore (breakdown)
          const r = performRoll(ctx, { actorId: a.id, skillId: 'negotiation', useSpec: !!p.useSpec, explode: !!p.explode, modifier: mod, label, secret: !!p.secret }, {
            bonus,
            logExtra: { labelI18n: { key: tk('Négociation avec {contact}'), params: { contact: name } }, contactRoll: { ...info, ...(bribe ? { bribe, bribeCost: bribeCost(c, bribe) } : {}) } },
          });
          const { entry, ...out } = r;
          return out;
        }

        if (kind === 'reach') {
          // 2D6 ≥ Connection: the contact picks up (a plain total, not hits).
          const dice = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
          const total = dice[0] + dice[1] + mod;
          const label = `Joindre ${name}`; // i18n-ignore
          return finish({
            dice, extra: [], pool: 2, total, label, labelI18n: { key: tk('Joindre {contact}'), params: { contact: name } }, actorId: a.id,
            breakdown: mod ? `2D6 ${mod > 0 ? '+' : '−'} ${Math.abs(mod)}` : '2D6', ...(p.secret ? { secret: true } : {}),
            contactRoll: { ...info, total, available: total >= cn },
          });
        }

        // The contact's own tests: their sheet (NPC actor / bestiary template of the same name) is needed.
        const s: Loose = contactSheet(ctx.state, c); // shared/contacts.js (JS): { known, cha, etiquette, etiquetteDefaulting, social… }
        if (!s.known) ctx.fail('{contact} n’a pas de fiche (Charisme, Étiquette) : le MJ peut créer un PNJ de ce nom dans le Bestiaire', { contact: name });
        let pool;
        let parts;
        let label;
        let labelI18n;
        let threshold = null;
        if (kind === 'legwork') {
          pool = s.cha + cn;
          parts = [`CHA ${s.cha}`, `Connexion ${cn}`];
          label = `Enquête — ${name}`; // i18n-ignore
          labelI18n = { key: tk('Enquête — {contact}'), params: { contact: name } };
        } else {
          threshold = clampInt(p.threshold, 1, MAX_CONNECTION, 0);
          if (!threshold) ctx.fail('Indique la Connexion de la personne à rencontrer (seuil)');
          pool = s.etiquette + cn;
          parts = [s.etiquetteDefaulting ? `CHA ${s.cha} par défaut −1` : `Étiquette + CHA ${s.etiquette}`, `Connexion ${cn}`];
          label = `Réseau — ${name}`; // i18n-ignore
          labelI18n = { key: tk('Réseau — {contact}'), params: { contact: name } };
        }
        if (mod) parts.push(`mod. ${mod > 0 ? '+' : '−'}${Math.abs(mod)}`);
        pool = Math.max(0, Math.min(100, pool + mod));
        if (pool <= 0) ctx.fail('Réserve de dés nulle : échec automatique');
        const r = rollDice(pool, { limit: s.social });
        return finish({
          ...r, label, labelI18n, explode: false, edge: false, actorId: null, authorName: name, breakdown: parts.join(' + '),
          limitLabel: 'sociale', limitBreakdown: `sociale ${s.social}`, ...(p.secret ? { secret: true } : {}),
          contactRoll: { ...info, ...(threshold ? { threshold, success: r.hits >= threshold } : {}), via: a.name },
        });
      },
    },

    // GM: burn / restore a SIN by hand (a secret check, a burned SIN still valid in another country — p. 364). { actorId, sinId, burned }
    'actor/sinBurn': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, sinId, burned }: SinBurnPayload) {
        const a = getActor(ctx, actorId);
        const sin = (a.sins || []).find((x) => x && x.id === String(sinId));
        if (!sin) ctx.fail('SIN introuvable');
        if (burned) {
          sin.burned = true;
          sin.burnedAt = Date.now();
        } else {
          delete sin.burned;
          delete sin.burnedAt;
        }
        return true;
      },
    },
  },

  filter(view: GameView, user: SessionUser) {
    const own = new Set(user.characterIds || []);
    // Before this filter every view actor is a full sheet (NPC stubs are made below).
    for (const [id, a] of Object.entries(view.actors || {}) as Array<[ActorId, Actor]>) {
      if (!a) continue;
      delete a.gmNotes;
      if (a.npc) {
        delete a.npc.tactics;
        delete a.npc.loot;
      }
      if (own.has(id)) continue;
      if (a.type === 'npc') {
        if (a.hidden) {
          delete view.actors[id];
          continue;
        }
        view.actors[id] = { id, type: 'npc', name: a.name, portrait: a.portrait || '', color: a.color || '', metatype: a.metatype, templateId: a.templateId || null, status: statusOf(a) };
        continue;
      }
      delete a.notes;
    }
  },

  routes(app: ExpressApp, { requireGM, getState, scheduleBroadcast, saveSoon, addLog }) {
    // POST /api/actors/import-chum5 (.chum5 or Actor JSON) is now served by the chummer module (85-chummer.js).

    // Export one actor as JSON (GM).
    app.get('/api/actors/:id/export', requireGM, (req: Req, res: Res) => {
      const a = getState()!.actors[req.params.id];
      if (!a) return res.status(404).json(errorBody('Personnage introuvable'));
      res.setHeader('Content-Disposition', `attachment; filename="${slugify(a.name)}.json"`);
      res.json(a);
    });
  },
};

export default mod;
