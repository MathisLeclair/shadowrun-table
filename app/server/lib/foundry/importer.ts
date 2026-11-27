// Foundry import pipeline: world (assembled documents) → bundle (converted records) → scan summary / live import / seeds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { convertSheet, convertVehicle, guessRating } from './convert-actor.ts';
import { convertScene } from './convert-scene.ts';
import { convertJournals, convertPlaylists } from './convert-misc.ts';
import { createAssets, formatBytes } from './assets.ts';
import { norm } from './catalog.ts';
import { normalizeActor } from '../../../client/modules/sheet/sheet-data.js';
import { fillActorRefs } from '../bookrefs.js';
import { uid, deepClone, nuyen as fmtNuyen } from '../../../shared/util.js';
import { ATTR_SHORT, SKILL_BY_ID } from '../../../shared/sr5.js';
import { formatFr } from '../../../client/i18n/format.js';
import { plural } from './messages.ts';
import type { FoundryDoc, FoundryWorld, WorldMeta } from './world.ts';
import type { Assets } from './assets.ts';
import type { ConvertedSheet } from './convert-actor.ts';
import type { ConvertedJournals, ConvertedPlaylist } from './convert-misc.ts';
import type { Actor, AudioState, GameMap, I18nEntry, I18nMessage, TableState, Template, User, Vehicle } from '../../../shared/types.ts';

/**
 * Actor / template / snapshot walked key by key (the field lists below name Actor keys; merge mode copies whatever
 * the Foundry sheet holds): read and written generically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FieldRec = Record<string, any>;
/** Foundry user owning a document. */
export interface FoundryOwner {
  id: string;
  name: string;
}
export interface BundlePc {
  fid: string;
  name: string;
  folder: string;
  owner: FoundryOwner | null;
  retired: boolean;
  appId: string;
  sheet: ConvertedSheet;
}
export interface BundleNpc {
  fid: string;
  name: string;
  folder: string;
  isGrunt: boolean;
  matchId: string | null;
  templateId: string;
  appFolder: string;
  sheet: ConvertedSheet;
}
export interface BundleVehicle {
  fid: string;
  name: string;
  owner: FoundryOwner | null;
  item: Vehicle;
  pcId?: string;
}
export interface BundleScene {
  fid: string;
  name: string;
  folder: string;
  map: GameMap;
  hash: string;
  appMapId: string | null;
}
/** The whole world converted (buildBundle()). */
export interface Bundle {
  worldId: string;
  worldTitle: string;
  path: string;
  dataRoot: string;
  fingerprint: string;
  meta: WorldMeta;
  now: number;
  pcs: BundlePc[];
  npcs: BundleNpc[];
  vehicles: BundleVehicle[];
  scenes: BundleScene[];
  skippedScenes: Array<{ fid: string; name: string; reason: string }>;
  journals: ConvertedJournals;
  playlists: ConvertedPlaylist[];
  assets: Assets;
}
/** Compact snapshot of the Foundry values at import time (snapshotOf()), stored in actor.foundry.snapshot. */
export interface PcSnapshot {
  s: FieldRec;
  a: FieldRec;
  aug: FieldRec;
  init: FieldRec;
  c: FieldRec;
  e: number;
  sk: Record<string, string>;
  items: Record<string, Record<string, string>>;
  matrix: string;
  vision: string;
}
/** Bestiary template as imported (shared/types.ts Template has no foundryId). */
type FoundryTemplate = Template & { foundryId?: string };
/** applyImport() options. */
export interface ApplyOptions {
  select?: { pcs?: unknown; npcs?: unknown; scenes?: unknown; journals?: boolean; playlists?: boolean };
  pcMode?: string;
  now?: number;
  docsDir?: string;
  sanitizeTemplate?: (t: Template) => Template;
  assignPlayers?: boolean;
}
/** Import summary (applyImport()). */
export interface ImportSummary {
  pcs: Array<{ id: string; name: string; status: string }>;
  npcs: Array<{ id: string; name: string; status: string }>;
  maps: Array<{ id: string; name: string; status: string }>;
  journals: Array<{ file: string; status: string }>;
  tracks: number;
  questLinks: number;
  users: string[];
}

const tk = (s: string): string => s; // marks French keys stored as values (tools/i18n-check.js)

// Fixed app ids for the campaign PCs (keeps references in campaign docs, quests, users…).
export const PC_IDS: Record<string, string> = { 'anthony von schloss': 'pc_anthony', jane: 'pc_jane', bricks: 'pc_bricks', 'ank lay': 'pc_anklay', 'christopher armingstar': 'pc_christopher' };

// Foundry NPC name → existing bestiary template (Foundry is the GM's real data: stats are updated).
export const NPC_MATCH: Record<string, string> = {
  'ag chemie cleaner': 'tpl_agc_cleaner',
  'cleaner team leader reyes': 'tpl_agc_reyes',
  'dorian ashe': 'tpl_dorian_ashe',
  'reinhardt klee': 'tpl_reinhardt_klee',
  'joseph porfla': 'tpl_joseph_porfla',
  'elodie voss': 'tpl_subject_l07',
  'crimson crush ganger': 'tpl_crimson_ganger',
  'crimson crush sarge': 'tpl_crimson_sarge',
  'human corpo security r3': 'tpl_corpsec_human_r3',
  'troll corpo security r3': 'tpl_corpsec_troll_r3',
  'corporate security r4': 'tpl_corpsec_r4',
  'elite bodyguard r5': 'tpl_elite_bodyguard_r5',
  'junior security spider': 'tpl_spider_junior',
  'standard security spider': 'tpl_spider_standard',
  'corp sniper': 'tpl_corp_sniper',
  rigger: 'tpl_rigger',
  'hired mage': 'tpl_hired_mage',
};
const NAME_OVERRIDE: Record<string, string> = { tpl_subject_l07: 'Élodie Voss (Sujet L-07)' };
const FOUNDRY_DESC_FIRST = new Set(['tpl_subject_l07']);

// Foundry scene (normalized name) → hand-drawn app map of the same place: quests listing the app map also get the Foundry one.
export const SCENE_TO_APP_MAP: Record<string, string> = {
  bar: 'map_bar_porfla',
  'back alley': 'map_back_alley',
  'trauma ward': 'map_trauma_ward',
  apartement: 'map_jane_apartment',
  'hacker s lair': 'map_hacker_lair',
  'corp lobby': 'map_corp_lobby',
  'server room': 'map_server_room',
  'penthouse office': 'map_penthouse_office',
  'construction site': 'map_construction_site',
};

// Foundry scenes that ARE a campaign location: app name + a GM line put before the import description.
export const SCENE_LABEL: Record<string, { name: string; intro: string }> = {
  bar: { name: 'Bar de Porfla (Renton)', intro: '**Le bar de Joseph Porfla, à Renton** : la carte jouée en séance 1 (*Cleanup Crew*), puis cible de Reyes dans *Burn Notice*. Plan maison du même lieu : « Bar de Porfla (plan maison) » (`map_bar_porfla`).' },
};

const PC_COLORS = ['#7a8cff', '#4fc38a', '#d9a441', '#b469d6', '#3fa7d6'];
const SHEET_FIELDS = ['metatype', 'attributes', 'augmented', 'initiative', 'condition', 'edge', 'skills', 'knowledge', 'qualities', 'powers', 'spells', 'weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'matrix', 'contacts', 'sins', 'lifestyles', 'karma', 'karmaTotal', 'nuyen', 'streetCred', 'notoriety', 'publicAwareness', 'vision', 'containers'];
const ITEM_LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'contacts', 'sins', 'qualities', 'powers', 'spells', 'knowledge', 'lifestyles'];
const SCALARS = ['karma', 'karmaTotal', 'nuyen', 'streetCred', 'notoriety', 'publicAwareness', 'metatype'];
const BIO_MARK = '### Historique (Foundry)';

/** URL of an asset copied by a Foundry import (/assets/foundry/… or, for non-legacy tables, /t/<slug>/assets/foundry/…). */
const isFoundryAsset = (u: unknown): boolean => /^\/(t\/[a-z0-9-]+\/)?assets\/foundry\//.test(String(u || ''));

export function stableHash(v: unknown): string {
  const s = JSON.stringify(v, (k: string, x: FieldRec) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
  return crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 12);
}

const snake = (s: unknown): string =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

function stripTemp<T>(list: T[] | null | undefined): T[] {
  return (list || []).map((x) => {
    if (!x || typeof x !== 'object') return x;
    const { _en, ...rest } = x as FieldRec;
    return rest as T;
  });
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/** Convert the whole world. opts: { now, assets } (assets = createAssets(...) instance; created if missing). */
export function buildBundle(world: FoundryWorld, { now = Date.now(), assets }: { now?: number; assets?: Assets } = {}): Bundle {
  const A = assets || createAssets({ dataRoot: world.dataRoot });
  const worldId = world.meta?.id || path.basename(world.path || 'world');
  const folders = new Map((world.folders || []).map((f) => [f._id, f]));
  const folderPath = (id: string | null | undefined): string => {
    const out: string[] = [];
    let f = folders.get(id as string);
    let guard = 0;
    while (f && guard++ < 20) {
      out.unshift(f.name);
      f = folders.get(f.folder as string);
    }
    return out.join('/');
  };
  const users = new Map((world.users || []).map((u) => [u._id, u]));
  const ownerOf = (doc: FoundryDoc): FoundryOwner | null => {
    for (const [uid_, lvl] of Object.entries(doc.ownership || {})) {
      if (uid_ === 'default' || Number(lvl) < 3) continue;
      const u = users.get(uid_);
      if (u && Number(u.role) < 3) return { id: u._id, name: u.name };
    }
    return null;
  };
  const links = {
    actors: Object.fromEntries((world.actors || []).map((a) => [a._id, a.name])),
    journals: Object.fromEntries((world.journal || []).map((j) => [j._id, j.name])),
  };
  const ctx = { links, asset: A.asset };

  const pcs: BundlePc[] = [];
  const npcs: BundleNpc[] = [];
  const vehicles: BundleVehicle[] = [];
  for (const a of world.actors || []) {
    const fp = folderPath(a.folder);
    if (a.type === 'vehicle') {
      vehicles.push({ fid: a._id, name: a.name, owner: ownerOf(a), item: convertVehicle(a, ctx) });
      continue;
    }
    const owner = ownerOf(a);
    const isPc = a.type === 'character' && (owner || /^player/i.test(fp)) && !a.system?.is_npc;
    const sheet = convertSheet(a, ctx);
    if (isPc) {
      const key = norm(a.name);
      pcs.push({ fid: a._id, name: a.name, folder: fp, owner, retired: !owner, appId: PC_IDS[key] || `pc_${snake(a.name.split(/\s+/)[0]) || a._id.toLowerCase()}`, sheet });
    } else {
      const key = norm(a.name);
      const matchId = NPC_MATCH[key] || null;
      npcs.push({ fid: a._id, name: a.name, folder: fp, isGrunt: !!a.system?.npc?.is_grunt, matchId, templateId: matchId || `tpl_fvtt_${snake(a.name) || a._id.toLowerCase()}`, appFolder: appFolder(fp, a.name), sheet });
    }
  }
  // Vehicles → the PC owned by the same Foundry user.
  for (const v of vehicles) {
    const pc = v.owner && pcs.find((p) => p.owner?.id === v.owner!.id);
    if (pc) {
      pc.sheet.vehicles.push(v.item);
      v.pcId = pc.appId;
    }
  }
  const templateFor = (actorId: string) => npcs.find((n) => n.fid === actorId)?.templateId || null;
  const allScenes = world.scenes || [];
  const scenes: BundleScene[] = [];
  const skippedScenes: Bundle['skippedScenes'] = [];
  for (const s of allScenes) {
    const map = convertScene(s, { folderPath, asset: A.asset, actorNames: links.actors, templateFor, worldId, journalNames: links.journals, allScenes, now });
    if (!map) {
      skippedScenes.push({ fid: s._id, name: s.name, reason: tk('pas d’image de fond') }); // shown translated by the panel
      continue;
    }
    const label = SCENE_LABEL[norm(s.name)];
    if (label) Object.assign(map, { name: label.name, description: `${label.intro}

${map.description}` });
    scenes.push({ fid: s._id, name: s.name, folder: folderPath(s.folder), map, hash: stableHash({ ...map, foundry: undefined, explored: undefined }), appMapId: SCENE_TO_APP_MAP[norm(s.name)] || null });
  }
  const journals = convertJournals(world.journal || [], { folderPath, asset: A.asset, links, worldTitle: world.meta?.title });
  const playlists = convertPlaylists(world.playlists || [], { asset: A.asset });
  return { worldId, worldTitle: world.meta?.title || worldId, path: world.path, dataRoot: world.dataRoot, fingerprint: world.fingerprint, meta: world.meta, now, pcs, npcs, vehicles, scenes, skippedScenes, journals, playlists, assets: A };
}

function appFolder(fp: unknown, name: string): string {
  if (/^(human man|male elf|female elf|human woman|female human|male human)\b/i.test(name)) return 'Figurants';
  const p = String(fp || '');
  if (/background/i.test(p)) return 'Contacts & PNJ';
  if (/project lazarus/i.test(p)) return 'Project Lazarus';
  if (/grunt/i.test(p)) return 'Gangs';
  if (/specialist/i.test(p)) return 'Spécialistes';
  if (/spider|matrix/i.test(p)) return 'Matrice';
  if (/critter|creature/i.test(p)) return 'Créatures';
  if (/^npcs?$/i.test(p) || !p) return 'PNJ (Foundry)';
  return p.split('/').pop()!;
}

// ---------------------------------------------------------------------------
// PCs
// ---------------------------------------------------------------------------

/** Sheet fields of a bundle PC as they would be stored on the app actor. */
function freshPcFields(pc: BundlePc): FieldRec {
  const s = pc.sheet as FieldRec;
  const out: FieldRec = {};
  for (const k of SHEET_FIELDS) if (s[k] !== undefined) out[k] = deepClone(s[k]);
  for (const k of ['weapons', 'armor']) out[k] = stripTemp(out[k]);
  return out;
}

/** Compact snapshot of the Foundry values at import time (for 'merge' re-imports). */
export function snapshotOf(fresh: FieldRec): PcSnapshot {
  const items: PcSnapshot['items'] = {};
  for (const l of ITEM_LISTS) items[l] = Object.fromEntries((fresh[l] || []).map((it: FieldRec) => [it.id, itemHash(l, it)]));
  return {
    s: Object.fromEntries(SCALARS.map((k) => [k, fresh[k]])),
    a: { ...(fresh.attributes || {}) },
    aug: { ...(fresh.augmented || {}) },
    init: { ...(fresh.initiative || {}) },
    c: { ...(fresh.condition || {}) },
    e: fresh.edge?.current ?? 0,
    sk: Object.fromEntries((fresh.skills || []).map((x: FieldRec) => [x.id, stableHash(x)])),
    items,
    matrix: stableHash(fresh.matrix || null),
    vision: stableHash(fresh.vision || {}),
  };
}

/**
 * Inventory fields (client/modules/sheet/inventory.js) the converter added after snapshot version 2: never part of the item hashes,
 * so the snapshots stored on the live actors stay valid, and the app's state (where an item is, rounds loaded, grenades left) is
 * never mistaken for a Foundry change.
 */
const INVENTORY_FIELDS: Record<string, string[]> = { weapons: ['location', 'ammoLoaded', 'qty'], armor: ['location'], gear: ['location'] };
/** Hash of a fresh item as stored in a snapshot. */
function itemHash(list: string, it: unknown): string {
  const skip = INVENTORY_FIELDS[list];
  if (!skip || !it || typeof it !== 'object') return stableHash(it);
  const copy: FieldRec = { ...it };
  for (const k of skip) delete copy[k];
  return stableHash(copy);
}

/** Snapshot format: 2 = item hashes include the upgrade fields (weapon mounts / accessories, armor capacity / mods). */
export const SNAPSHOT_VERSION = 2;
/** Upgrade fields the converter added after snapshot version 1, and nested lists the app may have filled. */
const UPGRADE_FIELDS = ['mounts', 'capacity', 'accessories', 'mods'];
const SUB_OF: Record<string, string> = { weapons: 'accessories', armor: 'mods', vehicles: 'mods', lifestyles: 'qualities' };
/** Hash of an item as the version-1 converter produced it (no upgrade fields). */
const legacyItemHash = (list: string, it: FieldRec): string => {
  const copy: FieldRec = { ...it };
  for (const k of UPGRADE_FIELDS) delete copy[k];
  return itemHash(list, copy);
};
/** Item fields the app keeps when Foundry replaces the item (its own state: rounds loaded and their kind, place, grenades left). */
const APP_ONLY_FIELDS = ['ammoLeft', 'ammoLoaded', 'ammoKind', 'location'];
const APP_ONLY_BY_LIST: Record<string, string[]> = { weapons: ['qty'], lifestyles: ['home'] };

/**
 * Replacement of an app item by the fresh Foundry one: nested entries the app added (shop / restored accessories,
 * armor mods, lifestyle options — absent from Foundry, matched by catalogId or name) and app-only fields survive.
 */
function replaceKeeping(mine: FieldRec | undefined, it: FieldRec, list: string): FieldRec {
  const out: FieldRec = deepClone(it);
  const sub = SUB_OF[list];
  if (sub && Array.isArray(mine?.[sub]) && mine[sub].length) {
    const key = (x: FieldRec | undefined) => (x?.catalogId ? `id:${x.catalogId}` : `n:${String(x?.name || '').toLowerCase()}`);
    const have = new Set((Array.isArray(out[sub]) ? out[sub] : []).map(key));
    const kept = mine![sub].filter((x: FieldRec) => x && !String(x.id || '').startsWith('fvtt_') && !have.has(key(x)));
    if (kept.length) out[sub] = [...(Array.isArray(out[sub]) ? out[sub] : []), ...deepClone(kept)];
    if (Array.isArray(mine!.mounts) && !Array.isArray(out.mounts)) out.mounts = [...mine!.mounts];
    if (mine!.capacity !== undefined && out.capacity === undefined) out.capacity = mine!.capacity;
  }
  for (const k of [...APP_ONLY_FIELDS, ...(APP_ONLY_BY_LIST[list] || [])]) if (mine?.[k] !== undefined) out[k] = deepClone(mine[k]);
  return out;
}

/**
 * Merge mode: only values that changed in Foundry since the last import overwrite the app's.
 * legacy = the snapshot predates SNAPSHOT_VERSION 2: an item is « unchanged » when it matches without the upgrade fields.
 */
function mergeInto(a: FieldRec, fresh: FieldRec, snap: PcSnapshot, { legacy = false }: { legacy?: boolean } = {}): void {
  for (const k of SCALARS) if (fresh[k] !== undefined && fresh[k] !== snap.s?.[k]) a[k] = fresh[k];
  a.attributes ||= {};
  for (const [k, v] of Object.entries(fresh.attributes || {})) if (v !== snap.a?.[k]) a.attributes[k] = v;
  for (const k of Object.keys(snap.a || {})) if (!(k in (fresh.attributes || {})) && (k === 'MAG' || k === 'RES')) delete a.attributes[k];
  a.augmented ||= {};
  const augKeys = new Set([...Object.keys(fresh.augmented || {}), ...Object.keys(snap.aug || {})]);
  for (const k of augKeys) {
    const v = fresh.augmented?.[k];
    if (v !== snap.aug?.[k]) {
      if (v) a.augmented[k] = v;
      else delete a.augmented[k];
    }
  }
  a.initiative ||= { dice: 1, bonus: 0 };
  for (const k of ['dice', 'bonus']) if (fresh.initiative?.[k] !== snap.init?.[k]) a.initiative[k] = fresh.initiative[k];
  a.condition ||= {};
  for (const k of ['physical', 'stun', 'overflow']) if (fresh.condition?.[k] !== snap.c?.[k]) a.condition[k] = fresh.condition[k];
  if ((fresh.edge?.current ?? 0) !== snap.e) a.edge = { ...(a.edge || {}), current: fresh.edge.current };
  // Skills by id
  a.skills ||= [];
  const freshSk = new Map<string, FieldRec>((fresh.skills || []).map((x: FieldRec) => [x.id, x]));
  for (const [id, sk] of freshSk) {
    if (snap.sk?.[id] === stableHash(sk)) continue;
    const i = a.skills.findIndex((x: FieldRec) => x.id === id);
    if (i >= 0) a.skills[i] = { ...a.skills[i], rating: sk.rating, spec: sk.spec, attr: sk.attr };
    else a.skills.push(deepClone(sk));
  }
  for (const id of Object.keys(snap.sk || {})) if (!freshSk.has(id)) a.skills = a.skills.filter((x: FieldRec) => x.id !== id);
  // Snapshot from before lifestyles[] (single `lifestyle`): adopt the app lifestyle of the same name (migrated from the
  // old field) under the Foundry id instead of adding a duplicate.
  if (snap.items && !snap.items.lifestyles) {
    snap.items.lifestyles = {};
    for (const fl of fresh.lifestyles || []) {
      const mine = (a.lifestyles || []).find((x: FieldRec) => !String(x.id).startsWith('fvtt_') && String(x.name || '').startsWith(fl.name));
      if (mine) {
        mine.id = fl.id;
        snap.items.lifestyles[fl.id] = stableHash(fl);
      }
    }
  }
  // Item lists by Foundry item id
  for (const l of ITEM_LISTS) {
    a[l] ||= [];
    const prev = snap.items?.[l] || {};
    const freshList: FieldRec[] = fresh[l] || [];
    for (const it of freshList) {
      const h = itemHash(l, it);
      if (prev[it.id] === h) continue; // unchanged in Foundry: keep the app's version
      if (legacy && prev[it.id] && prev[it.id] === legacyItemHash(l, it)) continue; // only the new converter fields differ
      const i = a[l].findIndex((x: FieldRec) => x.id === it.id);
      if (i >= 0) a[l][i] = replaceKeeping(a[l][i], it, l);
      else a[l].push(deepClone(it));
    }
    const freshIds = new Set(freshList.map((x) => x.id));
    for (const id of Object.keys(prev)) if (!freshIds.has(id)) a[l] = a[l].filter((x: FieldRec) => x.id !== id);
  }
  mergeContainers(a, fresh);
  if (stableHash(fresh.matrix || null) !== snap.matrix && fresh.matrix) a.matrix = deepClone(fresh.matrix);
  if (stableHash(fresh.vision || {}) !== snap.vision) a.vision = deepClone(fresh.vision);
}

/**
 * Merge re-import of the Foundry inventories: containers the app does not have yet are added (same stable fvtt_inv_ ids), and the
 * app items Foundry puts in them are moved there when they are still « Sur soi » (first import of the containers: a live actor
 * migrated before inventories existed adopts Foundry's bags). Containers the app already has, and items moved in the app, are kept.
 */
function mergeContainers(a: FieldRec, fresh: FieldRec): void {
  a.containers = Array.isArray(a.containers) ? a.containers : [];
  const have = new Set(a.containers.map((c: FieldRec | null) => c?.id));
  const added = new Set<string>();
  for (const c of fresh.containers || []) {
    if (!c?.id || have.has(c.id)) continue;
    a.containers.push(deepClone(c));
    added.add(c.id);
  }
  if (!added.size) return;
  for (const l of ['weapons', 'armor', 'gear']) {
    const freshLoc = new Map<string, string>((fresh[l] || []).filter((x: FieldRec) => added.has(x.location)).map((x: FieldRec) => [x.id, x.location]));
    for (const it of a[l] || []) {
      const loc = freshLoc.get(it?.id);
      if (loc && (!it.location || it.location === 'on')) {
        it.location = loc;
        if (l === 'gear') it.active = false;
        else it.equipped = false;
      }
    }
  }
}

function mergeBio(bio: unknown, foundryDesc: unknown): string {
  const base = String(bio || '');
  const desc = String(foundryDesc || '').trim();
  if (!desc) return base;
  const i = base.indexOf(BIO_MARK);
  const head = (i >= 0 ? base.slice(0, i) : base).trim();
  if (!head) return desc;
  return `${head}\n\n${BIO_MARK}\n\n${desc}`;
}

/**
 * Build the app actor for a bundle PC. existing = current app actor (or seed) or null.
 * mode: 'replace' (Foundry is the truth for the sheet) | 'merge' (only values changed in Foundry since last import).
 */
export function buildPc(
  pc: BundlePc,
  existing: Actor | null | undefined,
  { mode = 'replace', now = Date.now(), worldId = '', index = 0 }: { mode?: string; now?: number; worldId?: string; index?: number } = {}
): Actor {
  const fresh = freshPcFields(pc);
  const snap = snapshotOf(fresh);
  const hash = stableHash(snap);
  const sheet = pc.sheet;
  let a: FieldRec;
  if (!existing) {
    a = {
      id: pc.appId,
      type: 'pc',
      name: pc.name,
      player: pc.owner?.name || '',
      concept: '',
      color: PC_COLORS[index % PC_COLORS.length],
      bio: sheet.description || '',
      notes: '',
      gmNotes: '',
      ...fresh,
      history: [],
    };
  } else {
    a = deepClone(existing);
    if (mode === 'merge' && existing.foundry?.snapshot) mergeInto(a, fresh, existing.foundry.snapshot as PcSnapshot, { legacy: (existing.foundry.snapshotVersion || 1) < SNAPSHOT_VERSION });
    else for (const k of SHEET_FIELDS) if (fresh[k] !== undefined) a[k] = deepClone(fresh[k]);
    a.bio = mergeBio(existing.bio, sheet.description);
  }
  if (pc.owner?.name) a.player = pc.owner.name;
  a.type = 'pc';
  a.retired = !!(existing?.retired || pc.retired);
  if (!a.retired) delete a.retired;
  const ownPortrait = mode === 'merge' && existing?.portrait && !isFoundryAsset(existing.portrait); // set by the player in the app
  if (sheet.portrait && !ownPortrait) a.portrait = sheet.portrait;
  else a.portrait = a.portrait || '';
  if (sheet.gmNotesExtra && !String(a.gmNotes || '').includes(sheet.gmNotesExtra)) a.gmNotes = [a.gmNotes, sheet.gmNotesExtra].filter(Boolean).join('\n\n');
  const orphan = 'Aucun joueur propriétaire dans Foundry : importé comme PJ retraité.';
  if (!pc.owner && !String(a.gmNotes || '').includes(orphan)) a.gmNotes = [a.gmNotes, orphan].filter(Boolean).join('\n\n');
  if (!a.concept) a.concept = 'PJ importé de Foundry';
  // Ledger entry when money/karma moved.
  if (existing) {
    const dk = (a.karma || 0) - (existing.karma || 0);
    const dn = (a.nuyen || 0) - (existing.nuyen || 0);
    if (dk || dn) {
      a.history = Array.isArray(a.history) ? a.history : [];
      const i18n: I18nEntry = { key: tk('Synchronisation Foundry ({world}) : {karma} karma, {nuyen}'), params: { world: worldId, karma: a.karma, nuyen: fmtNuyen(a.nuyen) } };
      a.history.push({ ts: now, text: formatFr(i18n.key, i18n.params), i18n, ...(dk ? { karma: dk } : {}), ...(dn ? { nuyen: dn } : {}) });
    }
  } else if (a.karma || a.nuyen) {
    const i18n: I18nEntry = { key: tk('Valeurs importées de Foundry ({world}) : {karma} karma, {nuyen}'), params: { world: worldId, karma: a.karma, nuyen: fmtNuyen(a.nuyen) } };
    a.history = [{ ts: now, text: formatFr(i18n.key, i18n.params), i18n, karma: a.karma, nuyen: a.nuyen }];
  }
  a.foundry = { id: pc.fid, world: worldId, importedAt: now, hash, snapshot: snap, snapshotVersion: SNAPSHOT_VERSION, ...(pc.owner ? { user: pc.owner.name } : {}) };
  normalizeActor(a, uid);
  fillActorRefs(a, { sources: sheet.itemSources }); // 📖 after the snapshot: never part of the item hashes
  return a as Actor;
}

/**
 * Differences app actor → Foundry, as translatable entries [{ t: key, params }] (the panel renders them with t();
 * formatFr() gives the French text). Names (skills, items) are data and stay as typed, except official skill names.
 */
export function pcDiffEntries(appActor: Actor | null | undefined, pc: BundlePc): I18nMessage[] {
  // Compared field by field with the fresh Foundry values: handled as a record below.
  const app = appActor as FieldRec | null | undefined;
  if (!app) return [{ t: 'Nouveau personnage' }];
  const fresh = freshPcFields(pc);
  const out: I18nMessage[] = [];
  if ((app.karma || 0) !== fresh.karma) out.push({ t: 'Karma {from} → {to}', params: { from: app.karma || 0, to: fresh.karma } });
  if ((app.karmaTotal || 0) !== fresh.karmaTotal) out.push({ t: 'Karma de carrière {from} → {to}', params: { from: app.karmaTotal || 0, to: fresh.karmaTotal } });
  if ((app.nuyen || 0) !== fresh.nuyen) out.push({ t: 'Nuyens {from} → {to}', params: { from: fmtNuyen(app.nuyen), to: fmtNuyen(fresh.nuyen) } });
  const repKey: Record<string, I18nMessage> = { streetCred: { t: 'Street Cred {from} → {to}' }, notoriety: { t: 'Notoriété {from} → {to}' }, publicAwareness: { t: 'Rumeur publique {from} → {to}' } };
  for (const k of ['streetCred', 'notoriety', 'publicAwareness']) if ((app[k] || 0) !== fresh[k]) out.push({ t: repKey[k].t, params: { from: app[k] || 0, to: fresh[k] } });
  const at: I18nMessage[] = [];
  for (const [k, v] of Object.entries(fresh.attributes || {})) {
    if (Number(app.attributes?.[k] ?? 0) === Number(v)) continue;
    const short = (ATTR_SHORT as Record<string, string>)[k] || k;
    at.push({ t: '{attr} {from} → {to}', params: { attr: short === k ? short : { t: short }, from: app.attributes?.[k] ?? '—', to: v as number } });
  }
  if (at.length) out.push({ t: 'Attributs : {list}', params: { list: at } });
  const sk: I18nMessage[] = [];
  const appSk = new Map<string, FieldRec>((app.skills || []).map((s: FieldRec) => [s.id, s]));
  const skillName = (s: FieldRec): I18nMessage | string => (SKILL_BY_ID[s.id]?.fr === s.name ? { t: s.name } : s.name);
  for (const s of fresh.skills || []) {
    const cur = appSk.get(s.id);
    if (!cur) sk.push({ t: '+{skill} {rating}', params: { skill: skillName(s), rating: s.rating } });
    else if (Number(cur.rating) !== s.rating) sk.push({ t: '{skill} {from} → {to}', params: { skill: skillName(cur), from: cur.rating, to: s.rating } });
  }
  const freshSk = new Set((fresh.skills || []).map((s: FieldRec) => s.id));
  for (const s of app.skills || []) if (!freshSk.has(s.id) && s.rating > 0) sk.push({ t: '−{skill}', params: { skill: skillName(s) } });
  if (sk.length) out.push(sk.length > SHORT ? { t: 'Compétences : {list}…', params: { list: sk.slice(0, SHORT) } } : { t: 'Compétences : {list}', params: { list: sk } });
  const added: string[] = [];
  const removed: string[] = [];
  for (const l of ITEM_LISTS) {
    const appNames = new Set((app[l] || []).map((x: FieldRec) => norm(x.name)));
    const appIds = new Set((app[l] || []).map((x: FieldRec) => x.id));
    const freshNames = new Set((fresh[l] || []).map((x: FieldRec) => norm(x.name)));
    const freshIds = new Set((fresh[l] || []).map((x: FieldRec) => x.id));
    for (const it of fresh[l] || []) if (!appIds.has(it.id) && !appNames.has(norm(it.name))) added.push(it.name);
    for (const it of app[l] || []) if (!freshIds.has(it.id) && !freshNames.has(norm(it.name))) removed.push(it.name);
  }
  if (added.length) out.push(added.length > SHORT ? { t: 'Ajouts ({n}) : {list}…', params: { n: added.length, list: added.slice(0, SHORT) } } : { t: 'Ajouts ({n}) : {list}', params: { n: added.length, list: added } });
  if (removed.length) out.push(removed.length > SHORT ? { t: 'Retraits ({n}) : {list}…', params: { n: removed.length, list: removed.slice(0, SHORT) } } : { t: 'Retraits ({n}) : {list}', params: { n: removed.length, list: removed } });
  return out;
}

/** Human-readable differences app actor → Foundry (French strings, e.g. for tools/foundry-import.js). */
export function pcDiff(app: Actor | null | undefined, pc: BundlePc): string[] {
  return pcDiffEntries(app, pc).map((e) => formatFr(e.t, e.params));
}

const SHORT = 8; // diff lists longer than this are cut with '…'

// ---------------------------------------------------------------------------
// NPC templates
// ---------------------------------------------------------------------------

function sameWeapon(appW: FieldRec, fw: FieldRec): boolean {
  if (appW.catalogId && fw.catalogId && appW.catalogId === fw.catalogId) return true;
  const a = norm(appW.name);
  for (const n of [norm(fw._en), norm(fw.name)]) if (n && (a === n || a.startsWith(`${n} `))) return true;
  return fw.skill === 'unarmed_combat' && appW.skill === 'unarmed_combat' && /mains nues|unarmed/i.test(appW.name);
}

function mergeNamed(appList: FieldRec[] | undefined, freshList: FieldRec[]): FieldRec[] {
  const used = new Set<FieldRec>();
  return freshList.map((fw) => {
    const m = (appList || []).find((aw) => !used.has(aw) && sameWeapon(aw, fw));
    if (!m) return fw;
    used.add(m);
    return { ...fw, name: m.name, ...(m.notes ? { notes: m.notes } : {}), ...(m.category ? { category: m.category } : {}) };
  });
}

/** Items without their inventory fields (template hashes predate them). */
function withoutInventory(list: string, items: unknown[] | null | undefined): unknown[] {
  return (items || []).map((it) => {
    if (!it || typeof it !== 'object') return it;
    const copy: FieldRec = { ...it };
    for (const k of INVENTORY_FIELDS[list] || []) delete copy[k];
    return copy;
  });
}
function templateStats(npc: BundleNpc): FieldRec {
  const s = npc.sheet;
  return { metatype: s.metatype, attributes: s.attributes, augmented: s.augmented, initiative: s.initiative, skills: s.skills, knowledge: s.knowledge, qualities: s.qualities, powers: s.powers, spells: s.spells, weapons: withoutInventory('weapons', stripTemp(s.weapons)), armor: withoutInventory('armor', stripTemp(s.armor)), augmentations: s.augmentations, gear: withoutInventory('gear', s.gear), matrix: s.matrix || null, vision: s.vision, description: s.description, portrait: s.portrait };
}

/** Build the bestiary template for a bundle NPC (existing = current template or null). */
export function buildTemplate(npc: BundleNpc, existing: Template | null | undefined, { now = Date.now(), worldId = '' }: { now?: number; worldId?: string } = {}): Template {
  const s = npc.sheet as FieldRec;
  const hash = stableHash(templateStats(npc));
  let t: FieldRec;
  if (existing) {
    t = deepClone(existing);
    if (s.hasStats) {
      t.metatype = s.metatype;
      t.attributes = deepClone(s.attributes);
      t.augmented = deepClone(s.augmented);
      t.initiative = deepClone(s.initiative);
      t.skills = deepClone(s.skills);
      if (s.weapons.length) t.weapons = stripTemp(mergeNamed(t.weapons, deepClone(s.weapons)));
      if (s.armor.length) t.armor = stripTemp(mergeNamed(t.armor, deepClone(s.armor)));
      for (const k of ['augmentations', 'qualities', 'powers', 'spells', 'knowledge']) if (s[k].length) t[k] = deepClone(s[k]);
      if (s.matrix) t.matrix = { ...deepClone(s.matrix), programs: s.matrix.programs?.length ? s.matrix.programs : t.matrix?.programs || [] };
      t.vision = { ...(t.vision || {}), ...s.vision };
    } else {
      // Empty Foundry stat block: keep the app's numbers, only add what Foundry knows.
      if (!t.skills?.length) t.skills = deepClone(s.skills);
    }
    if (s.portrait && (!t.portrait || isFoundryAsset(t.portrait))) t.portrait = s.portrait;
    if (NAME_OVERRIDE[t.id]) t.name = NAME_OVERRIDE[t.id];
    const desc = String(s.description || '').trim();
    const base = String(t.description || '').replace(/\n*---\n\*Foundry :\*[\s\S]*$/, '').trim();
    if (desc && !base.includes(desc)) {
      if (FOUNDRY_DESC_FIRST.has(t.id)) t.description = base ? `${desc}\n\n${base.replace(desc, '').trim()}` : desc;
      else t.description = base ? `${base}\n\n---\n*Foundry :* ${desc}` : desc;
    } else t.description = base;
    if (t.npc && typeof t.npc === 'object') t.npc.grunt = t.npc.grunt ?? npc.isGrunt;
  } else {
    const neutral = /contacts|figurants/i.test(npc.appFolder);
    t = {
      id: npc.templateId,
      type: 'npc',
      name: npc.name.charAt(0).toUpperCase() + npc.name.slice(1),
      folder: npc.appFolder,
      metatype: s.metatype,
      concept: '',
      gender: '',
      portrait: s.portrait || '',
      color: neutral ? '#8a9bb0' : '#c94a4a',
      disposition: neutral ? 'neutral' : 'hostile',
      attributes: deepClone(s.attributes),
      augmented: deepClone(s.augmented),
      initiative: deepClone(s.initiative),
      skills: deepClone(s.skills),
      knowledge: deepClone(s.knowledge),
      qualities: deepClone(s.qualities),
      powers: deepClone(s.powers),
      spells: deepClone(s.spells),
      weapons: stripTemp(s.weapons),
      armor: stripTemp(s.armor),
      augmentations: deepClone(s.augmentations),
      gear: deepClone(s.gear),
      vehicles: [],
      ...(s.matrix ? { matrix: deepClone(s.matrix) } : {}),
      vision: deepClone(s.vision),
      description: s.description || (s.hasStats ? '' : '*Fiche vide dans Foundry : statistiques par défaut (attributs 3).*'),
      npc: { professionalRating: guessRating(npc.name), grunt: npc.isGrunt, kind: 'metahuman', tactics: '', loot: '' },
    };
  }
  t.foundryId = npc.fid;
  t.foundryWorld = worldId;
  t.foundryImportedAt = now;
  t.foundryHash = hash;
  fillActorRefs(t, { sources: s.itemSources });
  return t as Template;
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

/** Re-import keeps the GM's additions (tokens, fog memory, regions, own notes, renames). */
export function buildMap(sc: BundleScene, existing: GameMap | null | undefined): GameMap {
  const m: FieldRec = deepClone(sc.map);
  m.foundry = { ...m.foundry, hash: sc.hash };
  if (!existing) return m as GameMap;
  const out: FieldRec = deepClone(existing);
  for (const k of ['description', 'width', 'height', 'metersPerCell', 'walls', 'lights', 'lighting', 'background', 'thumb', 'foundry', 'theme']) out[k] = m[k];
  if (existing.width !== m.width || existing.height !== m.height || !Array.isArray(existing.tiles)) {
    out.tiles = m.tiles;
    out.explored = {};
    out.tokens = (out.tokens || []).filter((t: FieldRec) => t.x < m.width && t.y < m.height);
  }
  out.notes = [...(existing.notes || []).filter((n) => !String(n.id).startsWith('n_')), ...m.notes];
  out.doors = (existing.doors || []).filter((d) => d.x < m.width && d.y < m.height);
  return out as GameMap;
}

// ---------------------------------------------------------------------------
// Scan & live import
// ---------------------------------------------------------------------------

function findPc(state: Partial<TableState>, pc: BundlePc): Actor | null {
  const pcsList = Object.values(state.actors || {}).filter((a) => a && a.type === 'pc');
  return pcsList.find((a) => a.foundry?.id === pc.fid) || (state.actors?.[pc.appId]?.type === 'pc' ? state.actors[pc.appId] : null) || pcsList.find((a) => norm(a.name) === norm(pc.name)) || null;
}

function findTemplate(state: Partial<TableState>, npc: BundleNpc): FoundryTemplate | null {
  const b: Record<string, FoundryTemplate> = state.bestiary || {};
  return Object.values(b).find((t) => t && t.foundryId === npc.fid) || b[npc.templateId] || null;
}

function docStatus(dir: string, d: { file: string; content: string }): 'unchanged' | 'update' | 'new' {
  try {
    return fs.readFileSync(path.join(dir, d.file), 'utf8') === d.content ? 'unchanged' : 'update';
  } catch {
    return 'new';
  }
}

/** PC diff for the scan reply: French strings (`diff`, older clients/tools) + translatable entries (`diffI18n`). */
const diffFields = (entries: I18nMessage[]) => ({ diff: entries.map((e) => formatFr(e.t, e.params)), diffI18n: entries });

/** Summary of what can be imported, with match status and PC diffs. */
export function scanBundle(state: Partial<TableState>, bundle: Bundle, { docsDir }: { docsDir?: string } = {}) {
  const pcs = bundle.pcs.map((pc) => {
    const app = findPc(state, pc);
    const status = !app ? 'new' : app.foundry?.hash && app.foundry.hash === stableHash(snapshotOf(freshPcFields(pc))) ? 'unchanged' : 'update';
    return {
      fid: pc.fid, name: pc.name, appId: app?.id || pc.appId, appName: app?.name || null, status, player: pc.owner?.name || '', retired: !!(app?.retired || pc.retired),
      portrait: pc.sheet.portrait || app?.portrait || '', karma: pc.sheet.karma, nuyen: pc.sheet.nuyen,
      vehicles: pc.sheet.vehicles.map((v) => v.name), ...diffFields(status === 'unchanged' ? [] : pcDiffEntries(app, pc)), lastImport: app?.foundry?.importedAt || null,
    };
  });
  const npcs = bundle.npcs.map((npc) => {
    const t = findTemplate(state, npc);
    const status = !t ? 'new' : t.foundryHash && t.foundryHash === stableHash(templateStats(npc)) ? 'unchanged' : 'update';
    return { fid: npc.fid, name: npc.name, templateId: t?.id || npc.templateId, templateName: t?.name || null, folder: t?.folder || npc.appFolder, foundryFolder: npc.folder, status, matched: !!npc.matchId, hasStats: npc.sheet.hasStats, portrait: npc.sheet.portrait || '' };
  });
  const scenes = bundle.scenes.map((sc) => {
    const m = state.maps?.[sc.map.id];
    const status = !m ? 'new' : m.foundry?.hash === sc.hash ? 'unchanged' : 'update';
    return { fid: sc.fid, name: sc.name, mapId: sc.map.id, folder: sc.map.folder, status, thumb: sc.map.thumb || '', size: `${sc.map.width}×${sc.map.height}`, walls: sc.map.walls.length, doors: sc.map.walls.filter((w) => w.door).length, lights: sc.map.lights.length, linkedTo: sc.appMapId };
  });
  const journals = bundle.journals.docs.map((d) => ({ file: d.file, title: d.title, folder: d.folder, status: docsDir ? docStatus(docsDir, d) : 'new' }));
  const tracks = new Set((state.audio?.tracks || []).map((t) => t.id));
  const playlists = bundle.playlists.map((p) => {
    const urls = new Set(p.tracks.map((t) => t.url));
    const size = bundle.assets.totals({ kinds: ['audio'], urls });
    return { id: p.id, name: p.name, kind: p.kind, tracks: p.tracks.length, newTracks: p.tracks.filter((t) => !tracks.has(t.id)).length, bytes: size.bytes, size: formatBytes(size.bytes) };
  });
  return {
    world: { id: bundle.worldId, title: bundle.worldTitle, path: bundle.path, system: bundle.meta?.system, systemVersion: bundle.meta?.systemVersion, coreVersion: bundle.meta?.coreVersion, fingerprint: bundle.fingerprint },
    pcs,
    npcs,
    scenes,
    skippedScenes: bundle.skippedScenes,
    vehicles: bundle.vehicles.map((v) => ({ name: v.name, owner: v.owner?.name || null, pcId: v.pcId || null })),
    journals: { docs: journals, pdfs: bundle.journals.pdfs.length },
    playlists,
    audio: { files: bundle.assets.totals({ kinds: ['audio'] }).files, bytes: bundle.assets.totals({ kinds: ['audio'] }).bytes, size: formatBytes(bundle.assets.totals({ kinds: ['audio'] }).bytes) },
    missingAssets: [...new Set(bundle.assets.missing)].slice(0, 30),
  };
}

/**
 * Apply the import to the live state.
 * opts: { select: { pcs: [fid]|'all', npcs, scenes, journals: bool, playlists: bool }, pcMode, now, docsDir,
 *         sanitizeTemplate?(t) → t, assignPlayers?: bool }
 * Returns { summary, logText, logI18n: { key, params }, urls: { sync: Set, audio: Set } } — the caller copies the assets.
 */
export function applyImport(state: Partial<TableState>, bundle: Bundle, opts: ApplyOptions = {}) {
  const now = opts.now || Date.now();
  const sel = opts.select || {};
  const pick = <T extends { fid: string }>(list: T[], key: unknown): T[] => (key === 'all' || key === true ? list : Array.isArray(key) ? list.filter((x) => key.includes(x.fid)) : []);
  const mode = opts.pcMode === 'merge' ? 'merge' : 'replace';
  const syncUrls = new Set();
  const audioUrls = new Set();
  const summary: ImportSummary = { pcs: [], npcs: [], maps: [], journals: [], tracks: 0, questLinks: 0, users: [] };

  // PCs
  state.actors ||= {};
  const pcs = pick(bundle.pcs, sel.pcs);
  pcs.forEach((pc, i) => {
    const existing = findPc(state, pc);
    const a = buildPc(pc, existing, { mode, now, worldId: bundle.worldId, index: i });
    if (existing && existing.id !== a.id) a.id = existing.id;
    state.actors![a.id] = a;
    if (a.portrait) syncUrls.add(a.portrait);
    for (const v of a.vehicles || []) if (v.img) syncUrls.add(v.img);
    summary.pcs.push({ id: a.id, name: a.name, status: existing ? 'update' : 'new' });
    if (opts.assignPlayers && pc.owner?.name && !a.retired) {
      const users = Object.values(state.users || {});
      if (!users.some((u) => (u.characterIds || []).includes(a.id))) {
        let u = users.find((x) => String(x.name).toLowerCase() === pc.owner!.name.toLowerCase());
        if (!u) {
          u = { id: uid('usr'), name: pc.owner.name.slice(0, 40), pin: null, characterIds: [] } as User;
          state.users![u.id] = u;
        }
        u.characterIds = [...(u.characterIds || []), a.id];
        summary.users.push(`${u.name} → ${a.name}`);
      }
    }
  });

  // NPC templates
  state.bestiary ||= {};
  for (const npc of pick(bundle.npcs, sel.npcs)) {
    const existing = findTemplate(state, npc);
    let t = buildTemplate(npc, existing, { now, worldId: bundle.worldId });
    if (opts.sanitizeTemplate) t = opts.sanitizeTemplate(t);
    state.bestiary[t.id] = t;
    if (Array.isArray(state.bestiaryRemoved)) state.bestiaryRemoved = state.bestiaryRemoved.filter((x) => x !== t.id);
    if (t.portrait) syncUrls.add(t.portrait);
    summary.npcs.push({ id: t.id, name: t.name, status: existing ? 'update' : 'new' });
  }

  // Maps (+ quest links)
  state.maps ||= {};
  for (const sc of pick(bundle.scenes, sel.scenes)) {
    const existing = state.maps[sc.map.id];
    const m = buildMap(sc, existing);
    state.maps[m.id] = m;
    if (m.background?.url) syncUrls.add(m.background.url);
    if (m.thumb) syncUrls.add(m.thumb);
    summary.maps.push({ id: m.id, name: m.name, status: existing ? 'update' : 'new' });
    if (sc.appMapId) {
      for (const q of state.campaign?.quests || []) {
        if (Array.isArray(q.maps) && q.maps.includes(sc.appMapId) && !q.maps.includes(m.id)) {
          q.maps.push(m.id);
          summary.questLinks++;
        }
      }
    }
  }

  // Journals → markdown files
  if (sel.journals && opts.docsDir) {
    fs.mkdirSync(opts.docsDir, { recursive: true });
    for (const d of bundle.journals.docs) {
      const st = docStatus(opts.docsDir, d);
      if (st !== 'unchanged') fs.writeFileSync(path.join(opts.docsDir, d.file), d.content, 'utf8');
      summary.journals.push({ file: d.file, status: st });
      for (const m of d.content.matchAll(/\]\((\/assets\/foundry\/[^)\s]+)\)/g)) syncUrls.add(m[1]);
    }
    fs.writeFileSync(path.join(opts.docsDir, '_index.md'), bundle.journals.index, 'utf8');
  }

  // Playlists → audio tracks
  if (sel.playlists) {
    state.audio ||= { master: 0.8, ambient: { trackId: null, volume: 0.5 }, music: { trackId: null, volume: 0.4 }, tracks: [], scenes: [] } as unknown as AudioState;
    state.audio.tracks ||= [];
    for (const p of bundle.playlists) {
      for (const t of p.tracks) {
        const i = state.audio.tracks.findIndex((x) => x.id === t.id);
        if (i >= 0) state.audio.tracks[i] = { ...state.audio.tracks[i], ...t, name: state.audio.tracks[i].name || t.name };
        else state.audio.tracks.push({ ...t });
        audioUrls.add(t.url);
        summary.tracks++;
      }
    }
  }

  // Log line, translatable: { key, params } (parts = list of nested { t, params }), and its French text.
  const parts: I18nMessage[] = [];
  const nPcs = summary.pcs.length;
  if (nPcs) parts.push(mode === 'merge' ? { t: '{n} PJ (fusion)', params: { n: nPcs } } : { t: '{n} PJ (remplacement)', params: { n: nPcs } });
  if (summary.npcs.length) parts.push(plural(summary.npcs.length, { t: '{n} PNJ' }, { t: '{n} PNJ' }, { t: 'pluriel::{n} PNJ' }));
  if (summary.maps.length) parts.push(plural(summary.maps.length, { t: '{n} carte' }, { t: '{n} carte' }, { t: '{n} cartes' }));
  if (summary.journals.length) parts.push(plural(summary.journals.length, { t: '{n} journaux' }, { t: 'un::{n} journaux' }, { t: '{n} journaux' }));
  if (summary.tracks) parts.push(plural(summary.tracks, { t: '{n} pistes audio' }, { t: 'un::{n} pistes audio' }, { t: '{n} pistes audio' }));
  const logI18n: I18nEntry = parts.length
    ? { key: tk('Import Foundry : {parts} — monde « {world} »'), params: { parts, world: bundle.worldTitle } }
    : { key: tk('Import Foundry : rien de sélectionné — monde « {world} »'), params: { world: bundle.worldTitle } };
  const logText = formatFr(logI18n.key, logI18n.params);
  return { summary, logText, logI18n, urls: { sync: syncUrls, audio: audioUrls } };
}
