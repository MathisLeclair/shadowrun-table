// Character creation (SR5 Priority system) with GM approval, and the GM's quick enemy generator.
// State slice: state.chargen = { settings: { method, allowPlayers, startingKarmaBonus }, drafts: [Draft] }
//   Draft = { id, userId, userName, status: 'draft'|'pending'|'approved'|'rejected', data, gmNote, ts, createdTs,
//             submittedTs?, resolvedTs?, actorId?, check?: { errors, warnings } }
// Rules live in shared/chargen.js (validation, actor building) and shared/npcgen.js (enemy templates);
// prices come from client/modules/shop/rules.js (same price authority as the shop).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uid, deepClone } from '../../shared/util.ts';
import { normalizeDraft, compute, buildActor, draftHeadline, NUYEN_PARAMS } from '../../shared/chargen.ts';
import { generateEncounter, ARCHETYPE_BY_ID, METATYPE_CHOICES, GENERATED_FOLDER } from '../../shared/npcgen.ts';
import { quote, evalFormula, targetList, DEVICE_GEAR, accessoryFit, armorModFit, armorCapacity, upgradeAvail, accessoryEffects } from '../../client/modules/shop/rules.ts';
import { normalizeActor } from '../../client/modules/sheet/sheet-data.ts';
import combat, { sanitizeTemplate } from './30-combat.ts';
import { formatSource } from '../lib/i18n.ts';
import { fillActorRefs } from '../lib/bookrefs.ts';
import type {
  ActionContext, Actor, ActorId, CatalogFile, CatalogItem, ChargenDraft, ChargenState, DraftData, GameView, I18nMessage, I18nParams, MapId, ServerEvents,
  ServerModule, SessionUser, TableState, Template, UserId,
} from '../../shared/types.ts';

/**
 * Validation results of shared/chargen.ts, generated enemies of shared/npcgen.ts and untrusted payloads:
 * JSON-like data read field by field.
 */
type Loose = Record<string, any>;

/** Marks a translatable key for tools/i18n-check.ts (English in client/i18n/en/chargen.json). */
const tk = (s: string): string => s;

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const FILES = ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'programs', 'lifestyles', 'qualities', 'spells', 'powers', 'accessories', 'armormods'];
const STATUSES = ['draft', 'pending', 'approved', 'rejected'];
const MAX_DRAFTS_PER_PLAYER = 8;
const MAX_DRAFTS = 150;
const MAX_DATA_BYTES = 400000;

// ---------------------------------------------------------------------------
// Catalog index (validation authority)
// ---------------------------------------------------------------------------
// Catalog JSON files (data/catalog/*.json), read as the catalog item type shared/chargen.ts expects.
const BY_ID = new Map<string, { item: CatalogItem; file: CatalogFile }>(); // id -> { item, file }
const BY_NAME = new Map<string, CatalogItem>(); // 'file:Name' -> item
function loadCatalogs() {
  BY_ID.clear();
  BY_NAME.clear();
  for (const file of FILES) {
    let list: CatalogItem[] = [];
    try {
      list = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${file}.json`), 'utf8'));
    } catch {
      console.warn(`[chargen] catalogue ${file}.json absent ou invalide`);
      continue;
    }
    for (const item of list) {
      if (!item?.id) continue;
      BY_ID.set(item.id, { item, file: file as CatalogFile });
      const k = `${file}:${item.name}`;
      if (!BY_NAME.has(k)) BY_NAME.set(k, item);
    }
  }
}
loadCatalogs();

const RULES = { quote, evalFormula, targetList, DEVICE_GEAR, accessoryFit, armorModFit, armorCapacity, upgradeAvail, accessoryEffects };
function rulesCtx(state: TableState) {
  return { lookup: (id: string) => BY_ID.get(id) || null, rules: RULES, settings: state.chargen?.settings || {} };
}
const NPC_CTX = { find: (file: string, name: string) => BY_NAME.get(`${file}:${name}`) || null, rules: RULES };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): string => (v === undefined || v === null ? '' : String(v).slice(0, max));
const int = (v: unknown, d = 0, lo = -1e9, hi = 1e9): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

function defaults(): ChargenState {
  return { settings: { method: 'priority', allowPlayers: true, startingKarmaBonus: 0 }, drafts: [] };
}

function slice(ctx: ActionContext): ChargenState {
  const s = ctx.state;
  if (!isObj(s.chargen)) s.chargen = defaults();
  return s.chargen;
}

function getDraft(ctx: ActionContext, draftId: unknown): ChargenDraft {
  const d = slice(ctx).drafts.find((x) => x.id === draftId);
  if (!d) ctx.fail('Draft not found');
  if (!ctx.isGM && d.userId !== ctx.user.id) ctx.fail('This draft is not yours');
  return d;
}

function userName(state: TableState, userId: UserId): string {
  if (userId === 'gm') return 'MJ';
  return state.users?.[userId]?.name || 'Joueur inconnu';
}

function checkSummary(result: Loose): { errors: number; warnings: number } {
  return { errors: result.errors.length, warnings: result.warnings.length };
}

/** The first validation errors as one translatable message: « A · B · C (+2) ». */
function firstErrors(result: Loose, n = 3): I18nMessage | '' {
  const frNuyen = (v: unknown) => Math.round(Number(v) || 0).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
  const msg = (e: Loose): I18nMessage => {
    if (!e.key) return { t: '{a}', params: { a: e.text || '' } };
    const params: I18nParams = { ...(e.params || {}) };
    for (const k of NUYEN_PARAMS) if (typeof params[k] === 'number') params[k] = frNuyen(params[k]);
    return { t: e.key, params };
  };
  const list = result.errors.slice(0, n).map(msg);
  const chain = (l: I18nMessage[]): I18nMessage => (l.length === 1 ? l[0] : { t: '{a} · {b}', params: { a: l[0], b: chain(l.slice(1)) } });
  const more = result.errors.length - list.length;
  if (!list.length) return '';
  return more > 0 ? { t: '{list} (+{n})', params: { list: chain(list), n: more } } : chain(list);
}

/** Draft name as a message param (« Sans nom » is translated). */
function nameParam(data: DraftData): string | I18nMessage {
  const h = draftHeadline(data);
  return h.unnamed ? { t: h.name } : h.name;
}

/** History entry with a translatable text (same shape as the training module). */
function historyEntry(ctx: ActionContext, key: string, params: I18nParams, extra?: { karma?: number; nuyen?: number }) {
  return { ts: ctx.now, text: formatSource(key, params), i18n: { key, params }, ...extra };
}

/** Roll the lifestyle starting nuyen (SR5: dice × multiplier). Returns { dice, multiplier, rolls, total } or null. */
function rollStartingNuyen(lifestyle: Loose | null | undefined): { dice: number; multiplier: number; rolls: number[]; total: number } | null {
  if (!lifestyle || !(lifestyle.dice > 0) || !(lifestyle.multiplier > 0)) return null;
  const rolls: number[] = [];
  for (let i = 0; i < lifestyle.dice; i++) rolls.push(1 + Math.floor(Math.random() * 6));
  return { dice: lifestyle.dice, multiplier: lifestyle.multiplier, rolls, total: rolls.reduce((a, b) => a + b, 0) * lifestyle.multiplier };
}

/** Create the actor from a draft's data. opts: { type, assignTo (userId), source } → { actorId, actor, result, roll }. */
function createActor(ctx: ActionContext, data: DraftData, { type = 'pc', assignTo = null, source = '' }: { type?: 'pc' | 'npc'; assignTo?: UserId | null; source?: string } = {}) {
  const state = ctx.state;
  const owner = assignTo && state.users?.[assignTo] ? state.users[assignTo] : null;
  const built = buildActor(data, rulesCtx(state), { makeId: (p: string) => ctx.uid(p), type, player: owner?.name });
  const actor = built.actor as Actor; // gets its id just below
  const result = built.result;
  const id = ctx.uid(type === 'pc' ? 'pc' : 'npc');
  actor.id = id;
  const p = result.data.priorities;
  const letters = {
    t: tk('Metatype {metatype} · Attributes {attributes} · Magic {magic} · Skills {skills} · Resources {resources}'),
    params: { metatype: p.metatype, attributes: p.attributes, magic: p.magic, skills: p.skills, resources: p.resources },
  };
  actor.history.push(source
    ? historyEntry(ctx, tk('Creation (priorities: {letters}) — {source}'), { letters, source: { t: source } }, { karma: actor.karma, nuyen: actor.nuyen })
    : historyEntry(ctx, tk('Creation (priorities: {letters})'), { letters }, { karma: actor.karma, nuyen: actor.nuyen }));
  let roll = null;
  if (result.data.rollStartingNuyen) {
    roll = rollStartingNuyen(result.lifestyle);
    if (roll) {
      actor.nuyen += roll.total;
      actor.history.push(historyEntry(ctx, tk('Starting nuyen ({lifestyle}): {dice}D6 [{rolls}] × {mult}'), { lifestyle: result.lifestyle!.name, dice: roll.dice, rolls: roll.rolls.join(' '), mult: roll.multiplier }, { nuyen: roll.total }));
    }
  }
  normalizeActor(actor, (prefix: string) => ctx.uid(prefix));
  fillActorRefs(actor); // 📖 source / page of the bought gear, qualities, spells, powers, complex forms
  actor.edge.current = actor.attributes.EDG;
  state.actors[id] = actor;
  if (owner) {
    owner.characterIds = Array.isArray(owner.characterIds) ? owner.characterIds : [];
    if (!owner.characterIds.includes(id)) owner.characterIds.push(id);
  }
  return { actorId: id, actor, result, roll };
}

function notifyOwner(ctx: ActionContext, d: ChargenDraft, event: 'chargen:resolved', payload: ServerEvents['chargen:resolved']): void {
  if (d.userId && d.userId !== 'gm') ctx.emitTo([d.userId, 'gm'], event, payload);
}

// ---------------------------------------------------------------------------
// Enemy generator helpers
// ---------------------------------------------------------------------------
// Enemy generator payload: { archetype, tier, metatype?, seed, grunt?, lieutenant?, name?, lieutenantName? }
type NpcGenPayload = {
  archetype?: unknown; tier?: unknown; metatype?: unknown; seed?: unknown; grunt?: unknown; lieutenant?: unknown; name?: unknown; lieutenantName?: unknown;
};

function genOptions(ctx: ActionContext, p: NpcGenPayload) {
  const archetype = str(p.archetype, 40);
  if (!(ARCHETYPE_BY_ID as Record<string, unknown>)[archetype]) ctx.fail('Unknown archetype');
  const metatype = METATYPE_CHOICES.includes(p.metatype as string) ? (p.metatype as string) : 'random';
  return {
    archetype,
    tier: int(p.tier, 2, 0, 6),
    metatype,
    seed: int(p.seed, 1, 1, 2 ** 31),
    grunt: p.grunt === undefined ? undefined : !!p.grunt,
    lieutenant: !!p.lieutenant,
    name: str(p.name, 120).trim() || undefined,
    lieutenantName: str(p.lieutenantName, 120).trim() || undefined,
  };
}

function encounter(ctx: ActionContext, p: NpcGenPayload) {
  const o = genOptions(ctx, p);
  const enc: Loose = generateEncounter(o, NPC_CTX);
  if (enc.lieutenant && o.lieutenantName) enc.lieutenant.name = o.lieutenantName;
  return { o, enc };
}

function toTemplate(raw: Loose, id: string): Template {
  const t: Loose = deepClone(raw);
  delete t.unitName;
  t.folder = GENERATED_FOLDER;
  return sanitizeTemplate(t, { id });
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
// Action payloads (checked by the handlers)
type SaveDraftPayload = { draftId?: string; data?: unknown };
type DraftPayload = { draftId?: string };
type ResolvePayload = { draftId?: string; approve?: boolean; note?: unknown; force?: boolean; type?: string };
type CreatePayload = { draftId?: string; data?: unknown; type?: string; assignTo?: UserId | null; force?: boolean };
type SettingsPayload = { allowPlayers?: unknown; startingKarmaBonus?: unknown };
type NpcCreatePayload = NpcGenPayload & { saveToBestiary?: boolean; spawn?: unknown };
/** What 'bestiary/spawn' (30-combat) returns. */
type SpawnResult = { actorIds: ActorId[]; tokenIds: string[]; mapId: MapId | null; unplaced?: number };

const mod: ServerModule = {
  name: 'chargen',

  init(state: TableState) {
    const base = defaults();
    if (!isObj(state.chargen)) state.chargen = base;
    const c = state.chargen;
    c.settings = { ...base.settings, ...(isObj(c.settings) ? c.settings : {}) };
    c.settings.method = 'priority';
    c.settings.allowPlayers = c.settings.allowPlayers !== false;
    c.settings.startingKarmaBonus = int(c.settings.startingKarmaBonus, 0, -25, 100);
    c.drafts = (Array.isArray(c.drafts) ? c.drafts : []).filter((d) => isObj(d) && typeof d.id === 'string');
    for (const d of c.drafts) {
      if (!STATUSES.includes(d.status)) d.status = 'draft';
      d.data = normalizeDraft(d.data) as DraftData;
    }
  },

  actions: {
    // { draftId?, data } → { draftId }. Creates the draft when draftId is missing.
    'chargen/saveDraft': {
      role: 'any',
      handler(ctx: ActionContext, { draftId, data }: SaveDraftPayload = {}) {
        const c = slice(ctx);
        if (!ctx.isGM && !c.settings.allowPlayers) ctx.fail('Character creation is closed for now (see the GM)');
        if (!isObj(data)) ctx.fail('Invalid character data');
        let size = 0;
        try {
          size = JSON.stringify(data).length;
        } catch {
          ctx.fail('Invalid character data');
        }
        if (size > MAX_DATA_BYTES) ctx.fail('Draft too large');
        const clean = normalizeDraft(data) as DraftData;
        let d: ChargenDraft;
        if (draftId) {
          d = getDraft(ctx, draftId);
          if (d.status === 'pending' && !ctx.isGM) ctx.fail('This character is awaiting GM approval: withdraw the request to edit it');
          if (d.status === 'approved') ctx.fail('This character has already been approved');
          if (d.status === 'rejected') d.status = 'draft';
        } else {
          const mine = c.drafts.filter((x) => x.userId === ctx.user.id && x.status !== 'approved');
          if (!ctx.isGM && mine.length >= MAX_DRAFTS_PER_PLAYER) ctx.fail('Too many drafts in progress ({max} maximum): delete one', { max: MAX_DRAFTS_PER_PLAYER });
          if (c.drafts.length >= MAX_DRAFTS) {
            // Drop the oldest approved records first.
            const idx = c.drafts.findIndex((x) => x.status === 'approved');
            if (idx < 0) ctx.fail('Too many saved drafts');
            c.drafts.splice(idx, 1);
          }
          d = { id: ctx.uid('cg'), userId: ctx.user.id, userName: userName(ctx.state, ctx.user.id), status: 'draft', data: clean, gmNote: '', ts: ctx.now, createdTs: ctx.now };
          c.drafts.push(d);
        }
        d.data = clean;
        d.ts = ctx.now;
        d.check = checkSummary(compute(clean, rulesCtx(ctx.state)));
        return { draftId: d.id, check: d.check };
      },
    },

    // { draftId } → { status }. Server re-validates; any error blocks the submission.
    'chargen/submit': {
      role: 'any',
      handler(ctx: ActionContext, { draftId }: DraftPayload = {}) {
        const c = slice(ctx);
        if (!ctx.isGM && !c.settings.allowPlayers) ctx.fail('Character creation is closed for now (see the GM)');
        const d = getDraft(ctx, draftId);
        if (d.status === 'pending') ctx.fail('Already sent to the GM');
        if (d.status === 'approved') ctx.fail('This character has already been approved');
        const result = compute(d.data, rulesCtx(ctx.state));
        d.check = checkSummary(result);
        if (!result.ok) ctx.fail('Incomplete or illegal character: {errors}', { errors: firstErrors(result) });
        d.status = 'pending';
        d.submittedTs = ctx.now;
        d.ts = ctx.now;
        ctx.log({
          kind: 'system', userId: ctx.user.id, author: 'Création',
          i18n: { key: '{user} submits a character to the GM: {name}', params: { user: d.userId === 'gm' ? { t: 'GM' } : d.userName, name: nameParam(d.data) } },
          to: [...new Set([ctx.user.id, 'gm'])],
        });
        ctx.emitTo('gm', 'sfx', { id: 'notify' });
        return { status: d.status };
      },
    },

    // Owner (or GM): take a pending draft back to edit it. { draftId }
    'chargen/withdraw': {
      role: 'any',
      handler(ctx: ActionContext, { draftId }: DraftPayload = {}) {
        const d = getDraft(ctx, draftId);
        if (d.status !== 'pending') ctx.fail('This character is not pending');
        d.status = 'draft';
        d.ts = ctx.now;
        return { status: d.status };
      },
    },

    // GM: { draftId, approve, note?, force? (approve despite validation errors), type? } → { status, actorId? }
    'chargen/resolve': {
      role: 'gm',
      handler(ctx: ActionContext, { draftId, approve, note, force, type }: ResolvePayload = {}) {
        const d = getDraft(ctx, draftId);
        if (d.status !== 'pending') ctx.fail('This character is not awaiting approval');
        d.gmNote = str(note, 2000).trim();
        d.resolvedTs = ctx.now;
        const name = nameParam(d.data);
        if (!approve) {
          d.status = 'rejected';
          d.ts = ctx.now;
          ctx.log({
            kind: 'system', userId: ctx.user.id, author: 'Création',
            i18n: d.gmNote ? { key: 'Character needs changes: {name} — “{note}”', params: { name, note: d.gmNote } } : { key: 'Character needs changes: {name}', params: { name } },
            to: [...new Set([d.userId, 'gm'])],
          });
          notifyOwner(ctx, d, 'chargen:resolved', { draftId: d.id, status: 'rejected', note: d.gmNote });
          return { status: 'rejected' };
        }
        const result = compute(d.data, rulesCtx(ctx.state));
        if (!result.ok && !force) ctx.fail('The character breaks the rules: {errors}', { errors: firstErrors(result) });
        const assignTo = d.userId !== 'gm' && ctx.state.users?.[d.userId] ? d.userId : null;
        const { actorId, roll } = createActor(ctx, d.data, { type: type === 'npc' ? 'npc' : 'pc', assignTo, source: result.ok ? tk('approved by the GM') : tk('approved by the GM (outside the rules)') });
        d.status = 'approved';
        d.actorId = actorId;
        d.ts = ctx.now;
        const params = { name, ...(roll ? { nuyen: roll.total } : {}), ...(d.gmNote ? { note: d.gmNote } : {}) };
        const key = roll
          ? d.gmNote ? tk('Character approved: {name} (starting nuyen: {nuyen}¥) — “{note}”') : tk('Character approved: {name} (starting nuyen: {nuyen}¥)')
          : d.gmNote ? tk('Character approved: {name} — “{note}”') : tk('Character approved: {name}');
        ctx.log({ kind: 'system', userId: ctx.user.id, author: 'Création', i18n: { key, params }, to: [...new Set([d.userId, 'gm'])] });
        notifyOwner(ctx, d, 'chargen:resolved', { draftId: d.id, status: 'approved', note: d.gmNote, actorId });
        if (assignTo) ctx.emitTo(assignTo, 'sfx', { id: 'level-up' });
        return { status: 'approved', actorId };
      },
    },

    // GM: create directly, no approval. { draftId? | data?, type: 'pc'|'npc', assignTo?: userId, force? } → { actorId }
    'chargen/create': {
      role: 'gm',
      handler(ctx: ActionContext, { draftId, data, type, assignTo, force }: CreatePayload = {}) {
        const d = draftId ? getDraft(ctx, draftId) : null;
        if (d && d.status === 'approved') ctx.fail('This character has already been created');
        const src: DraftData | null = d ? d.data : isObj(data) ? (normalizeDraft(data) as DraftData) : null;
        if (!src) ctx.fail('Missing character data');
        const result = compute(src, rulesCtx(ctx.state));
        if (!result.ok && !force) ctx.fail('The character breaks the rules: {errors}', { errors: firstErrors(result) });
        if (assignTo && !ctx.state.users?.[assignTo]) ctx.fail('Player not found');
        const t = type === 'npc' ? 'npc' : 'pc';
        const { actorId } = createActor(ctx, src, { type: t, assignTo: t === 'pc' ? assignTo || null : null, source: tk('created by the GM') });
        if (d) {
          d.status = 'approved';
          d.actorId = actorId;
          d.resolvedTs = ctx.now;
          d.ts = ctx.now;
        }
        return { actorId };
      },
    },

    // Owner (not while pending) or GM. { draftId }
    'chargen/delete': {
      role: 'any',
      handler(ctx: ActionContext, { draftId }: DraftPayload = {}) {
        const d = getDraft(ctx, draftId);
        if (!ctx.isGM && d.status === 'pending') ctx.fail('Withdraw the request sent to the GM first');
        const c = slice(ctx);
        c.drafts = c.drafts.filter((x) => x.id !== d.id);
        return { ok: true };
      },
    },

    // GM: { allowPlayers?, startingKarmaBonus? }
    'chargen/settings': {
      role: 'gm',
      handler(ctx: ActionContext, patch: SettingsPayload = {}) {
        const s = slice(ctx).settings;
        if (patch.allowPlayers !== undefined) s.allowPlayers = !!patch.allowPlayers;
        if (patch.startingKarmaBonus !== undefined) s.startingKarmaBonus = int(patch.startingKarmaBonus, 0, -25, 100);
        s.method = 'priority';
        return { settings: { ...s } };
      },
    },

    // ------------------------------------------------------------- enemy generator (GM)
    // { archetype, tier, metatype?, seed, grunt?, lieutenant?, name?, lieutenantName? } → { main, lieutenant } (not stored)
    'npcgen/preview': {
      role: 'gm',
      handler(ctx: ActionContext, payload: NpcGenPayload = {}) {
        const { enc } = encounter(ctx, payload);
        return { main: sanitizePreview(enc.main), lieutenant: enc.lieutenant ? sanitizePreview(enc.lieutenant) : null, unitName: enc.main.unitName };
      },
    },

    // { ...preview options, saveToBestiary: bool, spawn?: { mapId (null = actors only), count, x?, y?, hidden?, addToCombat? } }
    //   → { templateIds, actorIds, tokenIds, mapId, unplaced }
    'npcgen/create': {
      role: 'gm',
      handler(ctx: ActionContext, payload: NpcCreatePayload = {}) {
        const { enc } = encounter(ctx, payload);
        const save = !!payload.saveToBestiary;
        const spawn = isObj(payload.spawn) ? payload.spawn : null;
        if (!save && !spawn) ctx.fail('Nothing to do: add to the bestiary or spawn');
        const state = ctx.state;
        const out: { templateIds: string[]; actorIds: ActorId[]; tokenIds: string[]; mapId: MapId | null; unplaced: number } = { templateIds: [], actorIds: [], tokenIds: [], mapId: null, unplaced: 0 };
        const list = [
          { raw: enc.main, count: spawn ? int(spawn.count, 1, 1, 30) : 0 },
          ...(enc.lieutenant ? [{ raw: enc.lieutenant, count: spawn ? 1 : 0 }] : []),
        ];
        const spawnDef = combat.actions!['bestiary/spawn'];
        for (const { raw, count } of list) {
          const id = ctx.uid('tpl');
          state.bestiary[id] = toTemplate(raw, id);
          if (save) out.templateIds.push(id);
          if (count > 0) {
            // Same code path as the bestiary's « Faire apparaître ».
            const res = spawnDef.handler(ctx, {
              templateId: id,
              mapId: spawn!.mapId === null ? null : str(spawn!.mapId, 80) || undefined,
              x: spawn!.x,
              y: spawn!.y,
              count,
              hidden: !!spawn!.hidden,
              addToCombat: !!spawn!.addToCombat,
            }) as SpawnResult;
            out.actorIds.push(...res.actorIds);
            out.tokenIds.push(...res.tokenIds);
            out.mapId = res.mapId;
            out.unplaced += res.unplaced || 0;
          }
          if (!save) {
            // Temporary template: the spawned actors keep a full copy, no dangling reference.
            delete state.bestiary[id];
            for (const aid of out.actorIds) if (state.actors[aid]?.templateId === id) delete state.actors[aid].templateId;
          }
        }
        return out;
      },
    },
  },

  // Players only see their own drafts.
  filter(view: GameView, user: SessionUser) {
    if (!isObj(view.chargen)) return;
    view.chargen = {
      settings: { ...view.chargen.settings },
      drafts: (view.chargen.drafts || []).filter((d) => d.userId === user.id),
    };
  },
};

export default mod;

/** Preview = what would be stored (sanitized), without a permanent id. */
function sanitizePreview(raw: Loose): Template {
  const t = toTemplate(raw, 'preview');
  t.unitName = raw.unitName;
  return t;
}
