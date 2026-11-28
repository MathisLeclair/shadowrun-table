// Data model of Shadowrun Table: the table state the server keeps (`ctx.state`), the per-user view a client receives
// (`game`), the catalog files and the server module contract. Type-only: no runtime code, no enums, no namespaces
// (the server runs .ts files with Node's type stripping).
//
// Conventions in this file:
// - Text vs i18n key: fields named `text`, `label`, `name`… hold untranslated text (English source keys; older saves:
//   French text, translated through the legacy key map). `i18n` / `*I18n`
//   fields hold `{ key, params }` (log, history) or `{ t, params }` (messages) that the client translates.
// - Map coordinates are CELLS unless stated otherwise (`metersPerCell` converts); segment walls use fractional cells.
// - Timestamps are milliseconds since the epoch (Date.now()).
// - Shapes come from the module init()/sanitizers in server/modules/*.js and from ARCHITECTURE.md « State shape ».

import type { TableApi } from '../server/lib/tables.ts';

// =====================================================================================================================
// Common primitives
// =====================================================================================================================

/** Milliseconds since the epoch (Date.now()). */
export type Timestamp = number;
export type Lang = 'fr' | 'en';
export type Role = 'gm' | 'player';
/** A user id: 'gm' for the GM, `usr_…` for players. */
export type UserId = string;
export type ActorId = string;
export type MapId = string;

/** A name in both languages (item names in log / error params, weapon names on attacks). */
export interface BiName {
  fr?: string;
  en?: string;
}

/** A translatable message: English key + params (nested messages allowed). Used by results, `nameI18n`, Matrix `msgs`. */
export interface I18nMessage {
  t: string;
  params?: I18nParams;
}

/** Value of an i18n param (client/i18n/format.js cleanParams): primitives, bilingual names, nested messages, arrays of those. */
export type I18nParamValue = string | number | boolean | null | BiName | I18nMessage | Array<string | number | boolean | null | BiName | I18nMessage>;
export type I18nParams = Record<string, I18nParamValue>;

/** A translatable stored text: English key + params (log entries, actor history, training labels). */
export interface I18nEntry {
  key: string;
  params?: I18nParams;
}

/** Rulebook reference (📖 chip): Chummer book code + PRINTED page. Present on every catalog-backed item and sub-item. */
export interface BookRefFields {
  /** Chummer book code: 'SR5', 'RG', 'CF'… */
  source?: string | null;
  /** Printed page number (not the PDF page). */
  page?: number | null;
}

/** A point in cells (may be fractional). */
export interface Point {
  x: number;
  y: number;
}

// =====================================================================================================================
// Users, config, tables
// =====================================================================================================================

/** A player account of one table (`state.users[id]`). The GM is not stored here (id 'gm'). */
export interface User {
  id: UserId;
  name: string;
  /** sha256 hash of the PIN, or null (no PIN / demo table). Never sent to clients. */
  pin: string | null;
  /** Actors this player controls. */
  characterIds: ActorId[];
  /** The player's own UI language; null/absent = follow the table's. */
  lang?: Lang | null;
}

/** The user an action runs for (`ctx.user`), resolved from the session token. */
export interface SessionUser {
  id: UserId;
  role: Role;
  name: string;
  characterIds: ActorId[];
}

/** `view.users[id]`: what every client knows about the players. */
export interface ViewUser {
  id: UserId;
  name: string;
  characterIds: ActorId[];
}

/** `view.me`: the connected user. */
export interface ViewMe {
  id: UserId;
  role: Role;
  name: string;
  characterIds: ActorId[];
  /** Own language choice, null = follow the table (GM: config.gmLang). */
  lang: Lang | null;
}

/** `state.config` (never sent as is). */
export interface TableConfig {
  gmPassword: string;
  /** Display name of the table (the registry name follows it). */
  campaignName: string;
  /** Table language: default for everyone who did not choose. */
  lang: Lang;
  /** The GM's own UI language (null = the table's). */
  gmLang?: Lang | null;
}

/** What the client may know about the table (`Table.info()`). */
export interface TableInfo {
  id: string;
  slug: string;
  name: string;
  lang: Lang;
  /** Public demo table (no passwords, abuse limits, automatic reset). */
  demo?: boolean;
}

/** `view.config`. */
export interface ViewConfig {
  campaignName: string;
  lang: Lang;
  table: TableInfo;
}

export type PackId = 'project-lazarus' | 'blank' | 'demo';

/** Entry of the server registry `<runtime>/server.json` (multi-table hosting). */
export interface TableMeta {
  id: string;
  /** Equal to id, immutable. */
  slug: string;
  name: string;
  createdAt: Timestamp;
  archived: boolean;
  /** Not listed on the table picker. */
  hidden: boolean;
  pack: PackId;
  lang: Lang;
  /** Migrated single-table install (old URLs /uploads/…, docs in ../Shadowrun). */
  legacy?: boolean;
  docsDir?: string;
  demo?: boolean;
  /** When a single-table install was migrated into the multi-table layout. */
  migratedAt?: Timestamp;
}

// =====================================================================================================================
// Log, rolls
// =====================================================================================================================

export type LogKind = 'chat' | 'whisper' | 'roll' | 'system' | 'combat' | 'shop' | 'training' | 'matrix' | 'magic';

/** One line of `state.log` (max 600). Display with `logText(entry)`. */
export interface LogEntry {
  id: string;
  ts: Timestamp;
  kind: LogKind;
  userId?: UserId;
  /** Displayed author (character name, 'MJ', 'Combat', 'Progression'…). */
  author: string;
  /** French rendering (filled from `i18n` when omitted on creation). */
  text: string;
  i18n?: I18nEntry;
  /** Translatable author (Matrix: IC / agent names). */
  authorI18n?: I18nEntry;
  /** Recipients of a whisper / private entry ('gm' always included). */
  to?: UserId[];
  /** Hidden from players. */
  gmOnly?: boolean;
  roll?: RollRecord;
  /** Matrix entries (kind 'matrix'). */
  matrix?: MatrixLogInfo;
  /** Magic entries (kind 'magic'). */
  magic?: MagicLogInfo;
}

/** Result of `rollDice()` (shared/sr5.js). */
export interface RollResult {
  pool: number;
  /** Faces of the base dice (1–6). */
  dice: number[];
  /** Rule of Six re-rolls (Push the Limit). */
  extra: number[];
  hits: number;
  rawHits: number;
  ones: number;
  glitch: boolean;
  critGlitch: boolean;
  limit: number | null;
  limited: boolean;
}

/** One applied modifier line of a roll (pool or limit). */
export interface RollModLine {
  /** Modifier id 'list:itemId[:subId]:i'. */
  id: string;
  kind: 'pool' | 'limit';
  type: ModifierType;
  name: string;
  nameFr?: string;
  value: number;
  state: ConditionState;
  condition?: string;
  wireless?: boolean;
  book?: string;
  page?: number;
}

/** Ammunition use of a firing roll (`roll.fire`). */
export interface FireInfo {
  /** Fire option id: 'SS' | 'SA' | 'SB' | 'BF' | 'LB' | 'FA' | 'FAC' | 'SUP' (absent for a thrown item). */
  mode?: string;
  rounds?: number;
  left: number;
  max?: number;
  /** Missing rounds (fewer than the mode needs). */
  short?: number;
  /** Defense modifier after missing rounds. */
  defense?: number;
  /** Suppressive fire: metres narrower. */
  narrower?: number;
  /** A thrown item (grenade, throwing weapon): true, or the weapon item that was used up. */
  item?: string | boolean;
  /** Thrown item: the last one was used up and removed from the inventory. */
  removed?: boolean;
}

/** `roll.sinCheck` of an 'actor/sinCheck' roll. */
export interface SinCheckInfo {
  sinId: string;
  sin: string;
  device: number;
  threshold: number;
  license?: string;
  licenseIndex?: number;
  outcome: 'pass' | 'odd' | 'burned' | 'auto';
  burnedNow?: boolean;
}

/** `roll.contactRoll` of an 'actor/contactRoll' roll. */
export interface ContactRollInfo {
  kind: 'reach' | 'negotiate' | 'legwork' | 'network';
  contactId: string;
  contact: string;
  connection: number;
  loyalty: number;
  total?: number;
  available?: boolean;
  bribe?: number;
  bribeCost?: number;
  threshold?: number;
  success?: boolean;
  via?: string;
}

/** `roll.avail` of a shop availability test. */
export interface AvailRollInfo {
  testId: string;
  value: number;
  legality: Legality;
  /** Availability dice (one face per die). */
  dice: number[];
  hits: number;
  baseHours: number;
  tries: number;
  contact?: string;
  /** Extra dice bought by overpaying (shop « surenchère »). */
  overpay?: number;
}

/** `entry.roll`: the dice result plus what the server adds (performRoll and module `logExtra`). */
export interface RollRecord extends RollResult {
  /** Label shown in the log (UI key or stored text). */
  label: string;
  labelI18n?: I18nEntry;
  explode?: boolean;
  /** Edge was used (Push the Limit or Second Chance). */
  edge?: boolean;
  actorId?: ActorId | null;
  /** French breakdown « AGI 5 + Pistolets 4 + … ». */
  breakdown?: string;
  fire?: FireInfo;
  limitLabel?: string;
  limitBreakdown?: string;
  secret?: boolean;
  mods?: RollModLine[];
  /** Condition switch keys that were on. */
  conditions?: string[];
  secondChance?: { before: number[] };
  sinCheck?: SinCheckInfo;
  contactRoll?: ContactRollInfo;
  avail?: AvailRollInfo;
  /** Attack rolls (33-attacks). */
  attackId?: string;
  defense?: boolean;
  soak?: boolean;
  targetName?: string;
  actionName?: string;
  range?: { band: string; meters: number };
}

/** `entry.matrix` of a Matrix log entry. `gm` is stripped from players' views. */
export interface MatrixLogInfo {
  event?: 'alert' | 'connect' | 'convergence' | 'disconnect' | 'icIdle' | 'icLaunch' | 'osTick';
  actorId?: ActorId;
  hostId?: string;
  icType?: IcType;
  mode?: MatrixMode;
  actionId?: string;
  agent?: boolean;
  assist?: boolean;
  success?: boolean;
  net?: number;
  defenseHits?: number;
  defenseDice?: number[];
  /** French outcome sentences. */
  outcomes?: string[];
  /** GM-only details (defense pools). */
  gm?: { defensePool?: number };
}

// =====================================================================================================================
// Actor (PC / NPC sheet) — `state.actors[id]`, owner: 10-characters.js
// =====================================================================================================================

export type AttrKey = 'BOD' | 'AGI' | 'REA' | 'STR' | 'WIL' | 'LOG' | 'INT' | 'CHA' | 'EDG' | 'MAG' | 'RES' | 'ESS';
/** Stored French metatype ('Humain'…); critters and imports may hold other strings. */
export type Metatype = 'Humain' | 'Elfe' | 'Nain' | 'Ork' | 'Troll' | (string & {});
export type ActorType = 'pc' | 'npc';
export type Disposition = 'pc' | 'ally' | 'neutral' | 'hostile';
export type NpcKind = 'metahuman' | 'critter' | 'drone' | 'ic' | 'host' | 'spirit' | 'other';
export type InitMode = 'physical' | 'astral' | 'ar' | 'cold' | 'hot';
/** Health status shown to players for NPCs (stored French values). */
export type HealthStatus = 'indemne' | 'blessé' | 'grièvement blessé' | 'hors de combat' | 'mort';

export interface Attributes {
  BOD: number;
  AGI: number;
  REA: number;
  STR: number;
  WIL: number;
  LOG: number;
  INT: number;
  CHA: number;
  EDG: number;
  MAG?: number;
  RES?: number;
  /** Essence (decimal, 6 = none lost). */
  ESS: number;
}

/** Attribute / initiative bonus actually stored on the actor by an item (`augmentations[].bonus`, `powers[].bonus`, `qualities[].bonus`). */
export interface ItemBonus {
  attributes?: Partial<Record<AttrKey, number>>;
  initiativeDice?: number;
  initiative?: number;
}

/** Fields shared by the items of the actor lists. */
export interface ItemBase extends BookRefFields {
  id: string;
  name: string;
  notes?: string;
  /** Catalog id (Chummer GUID) of data/catalog/*.json. */
  catalogId?: string;
  /** Chummer GUID once synced with a .chum5 file. */
  chummerGuid?: string;
  /** Catalog names in both languages, filled by fillItemNames (display: itemLabel). The stored `name` is never changed. */
  nameFr?: string;
  nameEn?: string;
  categoryFr?: string;
  categoryEn?: string;
  /** Chummer <extra> / GM pick of a « select… » effect (skill, attribute, text…). */
  choice?: string | null;
}

/** Inventory location: 'on' (« Sur soi », implicit) or a container id. */
export type ItemLocation = 'on' | (string & {});

export interface Skill {
  /** sr5.SKILLS id ('pistols') or a custom slug. */
  id: string;
  /** French name. */
  name: string;
  attr: AttrKey;
  rating: number;
  spec?: string;
  /** Skill group id ('firearms'). */
  group?: string;
  source?: string | null;
  page?: number | null;
  /** Chummer / Foundry import note. */
  notes?: string;
}

export interface SkillGroupRating {
  id: string;
  rating: number;
}

export type KnowledgeType = 'street' | 'academic' | 'professional' | 'interest' | 'language';

export interface KnowledgeSkill {
  id: string;
  name: string;
  rating: number;
  type: KnowledgeType;
  native?: boolean;
  spec?: string;
  /** Chummer / Foundry import note. */
  notes?: string;
  /** Chummer GUID once synced with a .chum5 file. */
  chummerGuid?: string;
}

export interface Quality extends ItemBase {
  /** Karma value (negative for negative qualities). */
  karma: number;
  positive: boolean;
  bonus?: ItemBonus;
}

export interface AdeptPower extends ItemBase {
  level?: number;
  /** Power points (absent on critter powers). */
  pp?: number;
  bonus?: ItemBonus;
}

export interface Spell extends ItemBase {
  /** 'Combat' | 'Detection' | 'Health' | 'Illusion' | 'Manipulation'. */
  category: string;
  /** 'M' (mana) | 'P' (physical). */
  type: string;
  /** 'LOS', 'LOS (A)', 'T'… */
  range: string;
  /** 'I' | 'S' | 'P'. */
  duration: string;
  /** Drain formula 'F-3'. */
  drain: string;
}

export interface ComplexForm extends ItemBase {
  /** Target (Chummer import: 'Device', 'Persona'…). */
  target?: string;
  duration?: string;
  fading?: string;
}

export type MountPoint = 'Top' | 'Under' | 'Barrel' | 'Stock' | 'Side' | 'Internal' | '';

/** Weapon accessory (weapons[].accessories). */
export interface Accessory extends ItemBase {
  mount: MountPoint;
  rating?: number | null;
  cost: number;
  avail: string;
  /** Delivered with the weapon (worth 0, never sold alone). */
  included?: boolean;
  /** false = switched off. */
  equipped?: boolean;
  /** Mount points it adds (slide mount). */
  extraMount?: MountPoint[];
  effects?: { accuracy?: number; rc?: number; rcGroup?: number; dicePool?: number; smartgun?: boolean };
  /** Price paid in the shop (resale value). */
  paid?: number | null;
}

export type ArmorModBonusKey = 'fire' | 'cold' | 'electricity' | 'acid' | 'falling' | 'toxin' | 'pathogen' | 'radiation';

/** Armor modification (armor[].mods). */
export interface ArmorMod extends ItemBase {
  rating?: number | null;
  /** Capacity used (may be < 0: YNT Softweave adds room). */
  capacity: number;
  cost: number;
  avail: string;
  included?: boolean;
  effects?: { armor?: number };
  bonus?: Partial<Record<ArmorModBonusKey, number | boolean>> | null;
  /** false = switched off (its armor bonus no longer counts). */
  equipped?: boolean;
  paid?: number | null;
}

export type VehicleStatKey = 'handling' | 'speed' | 'accel' | 'armor' | 'body' | 'sensor' | 'pilot' | 'seats';

/** Vehicle modification (vehicles[].mods). */
export interface VehicleMod extends ItemBase {
  rating?: number | null;
  slots: number;
  /** Chummer category: 'Powertrain' | 'Protection' | 'Weapons' | 'Body' | 'Electromagnetic' | 'Cosmetic' | 'All'… */
  category: string;
  cost: number;
  avail: string;
  included?: boolean;
  /** Evaluated at the rating; never applied to the stored vehicle stats. */
  effects?: Partial<Record<VehicleStatKey, number>>;
  paid?: number | null;
}

export interface AmmoKind {
  name: string;
  nameFr?: string;
  catalogId?: string;
}

export interface Weapon extends ItemBase {
  /** Category (French or English, as stored). */
  category: string;
  kind: 'melee' | 'ranged';
  /** Skill id ('pistols', 'blades'…). */
  skill: string;
  /** BASE accuracy (accessories add). A number, or 'Physical' / formula text, '' when unknown. */
  accuracy: number | string | null;
  /** Damage code '7P', '(STR+2)P', '10S(e)'. */
  damage: string;
  /** Armor Penetration (number, or text like '-half'). */
  ap: number | string;
  /** Fire modes 'SA/BF/FA' (French or English letters). */
  mode: string;
  /** BASE recoil compensation. */
  rc: number;
  /** Magazine '15(c)'. */
  ammo: string;
  reach: number;
  mounts?: MountPoint[];
  accessories?: Accessory[];
  /** Ready (true) or stowed. */
  equipped?: boolean;
  location?: ItemLocation;
  /** Derived from `ammo` by normalizeActor. */
  ammoMax?: number;
  /** Reload type: 'c' clip, 'm' internal magazine, 'b' break action, 'd' drum, 'cy' cylinder, 'belt', 'ml' muzzle loader. */
  ammoType?: string;
  ammoLoaded?: number;
  /** Legacy name of ammoLoaded (migrated). */
  ammoLeft?: number;
  ammoKind?: AmmoKind | null;
  /** Grenades / throwing weapons: how many. */
  qty?: number;
  /** Implant weapon of that augmentation (removed with it, never sold separately). */
  augId?: string;
  paid?: number;
}

export interface Armor extends ItemBase {
  /** BASE armor value (mods add). */
  rating: number;
  equipped: boolean;
  /** Helmet / shield: adds to the best armor. */
  stack?: boolean;
  capacity?: number;
  mods?: ArmorMod[];
  location?: ItemLocation;
  /** Chummer item rating (≠ armor value), used by « Rating » formulas. */
  itemRating?: number | null;
  paid?: number;
}

export type WareKind = 'cyberware' | 'bioware';
/** 'gamma' / 'omega' only come from Foundry imports (kept as Foundry stores them). */
export type WareGrade = 'standard' | 'alpha' | 'beta' | 'delta' | 'used' | 'gamma' | 'omega';

export interface Augmentation extends ItemBase {
  kind: WareKind;
  grade: WareGrade;
  rating?: number;
  /** Essence cost (decimal). */
  essence: number;
  bonus?: ItemBonus;
  /** Not counted by the modifiers. */
  disabled?: boolean;
  paid?: number;
}

export interface Gear extends ItemBase {
  category: string;
  rating?: number;
  qty: number;
  /** Worn / switched on: its catalog effects count (shared/modifiers.js). */
  active?: boolean;
  /** Focus (category Foci): bonded to its owner (SR5 p. 318). false = bought, not bonded yet; absent = older sheets (counted as bonded). */
  bonded?: boolean;
  location?: ItemLocation;
  /** Chummer <ammoforweapontype>. */
  ammoFor?: string;
  /** Unit price paid in the shop. */
  paid?: number;
}

export type ContainerKind = 'body' | 'bag' | 'vehicle' | 'safehouse' | 'other';

/** Place of the inventory (holster, backpack, car, safehouse…). « Sur soi » is implicit ('on'). */
export interface Container {
  id: string;
  name: string;
  kind: ContainerKind;
  notes?: string;
  /** Gear item this container is (a Chummer bag with contents: the item keeps its cost, the container holds the contents). */
  itemId?: string;
}

export interface Vehicle extends ItemBase {
  /** '4' or on/off-road '4/3'. */
  handling: number | string;
  speed: number | string;
  accel: number | string;
  body: number;
  armor: number;
  pilot: number;
  sensor: number;
  seats?: number;
  /** Slot override (rules.js vehicleSlots). */
  slots?: number;
  img?: string;
  mods?: VehicleMod[];
  paid?: number;
}

/** The actor's Matrix device (`actor.matrix`). */
export interface ActorMatrix {
  device: string;
  rating: number;
  attack: number;
  sleaze: number;
  dataProcessing: number;
  firewall: number;
  /** Program names ('Stealth', 'Agent (5)'). */
  programs: string[];
  /** Gear item that is the device. */
  gearId?: string;
}

export interface Contact extends ItemBase {
  /** What the contact does (« Fixer », « Barman »…). */
  role?: string;
  /** 1–12. */
  connection: number;
  /** 1–6. */
  loyalty: number;
}

export interface Sin extends ItemBase {
  rating: number;
  /** « Driver's License (4) »: a « (n) » is that license's rating, else the SIN's. */
  licenses: string[];
  /** Legal SIN: never checked. */
  real?: boolean;
  burned?: boolean;
  burnedAt?: Timestamp;
}

export type LifestyleBase =
  | 'Street' | 'Squatter' | 'Low' | 'Medium' | 'High' | 'Luxury' | 'Bolt Hole' | 'Traveler' | 'Commercial' | 'Hospitalized' | (string & {});

/** Lifestyle option (lifestyles[].qualities). */
export interface LifestyleQuality extends ItemBase {
  /** 'Positive' | 'Negative' | 'Contracts' | 'Entertainment - Asset'… */
  category: string;
  /** Flat ¥/month (may be < 0). */
  cost: number;
  /** Percent (e.g. −20 = Dangerous Area). */
  multiplier: number;
  /** The % applies to baseCost only (Extra Secure). */
  baseOnly?: boolean;
  lp?: number | null;
  paid?: number | null;
}

/** The apartment drawn for a lifestyle (shared/home.js; rebuilt on the fly, only the choice is stored). */
export interface LifestyleHome {
  /** HOME_LAYOUTS key. */
  layout: string;
  since: Timestamp;
  moves: number;
  /** Table map of this flat (server/lib/home-map.ts), created when the flat is picked. Missing = none yet. */
  mapId?: MapId;
  /** Add-ons the map was built with (homeAddons keys): differs from the current ones → the map is out of date. */
  addons?: string;
}

export interface Lifestyle extends ItemBase {
  base: LifestyleBase;
  /** ¥/month of the level (pinned to the level's fixed cost). */
  baseCost: number;
  monthsPaid: number;
  /** Exactly one lifestyle is primary. */
  primary: boolean;
  /** Run Faster points. */
  points?: { comforts?: number; security?: number; neighborhood?: number; entertainment?: number } | null;
  /** ¥ per Run Faster point of each category (from the catalog lifestyle). */
  pointCost?: { comforts?: number; security?: number; neighborhood?: number; entertainment?: number } | null;
  /** Metatype surcharge in % (dwarf / troll). */
  metatypePct?: number;
  extraCost?: number;
  qualities: LifestyleQuality[];
  /** Derived and stored (shared/lifestyle.js monthlyCost). */
  monthlyCost: number;
  home?: LifestyleHome | null;
  /** Where the home is on the city map (« Seattle » tab, shared/city.ts). Set by shop/move only. */
  place?: LifestylePlace | null;
}

// ---- City map (« Seattle » tab, shared/city.ts, server/modules/72-city.ts) ----

/** HTR response ratings (SR5 p. 352). */
export type SecurityRating = 'AAA' | 'AA' | 'A' | 'B' | 'C' | 'Z';

/** A security rating the source gives for a named area of a district. */
export interface CitySecurity {
  /** Area as the book names it (« Downtown Seattle », « Redmond Barrens »). */
  area: string;
  rating: SecurityRating;
  source: string;
  page: number;
}

/** A district of the city map: even-odd rings in cells (several rings = islands; a ring inside another = a hole). */
export interface CityDistrict {
  id: string;
  name: string;
  /** Fill colour of the district on the image (#rrggbb). */
  color: string;
  rings: Array<Array<[number, number]>>;
  /** Only when the source rates it (SR5 p. 352). */
  security?: CitySecurity[];
}

/** District shapes traced from one city image (data/city/<id>.json, tools/city-districts.ts). */
export interface CityShapes {
  id: string;
  name: string;
  /** Background URL of the map image the shapes match. */
  background: string;
  width: number;
  height: number;
  traced?: string;
  districts: CityDistrict[];
}

/** `state.city`. */
export interface CityState {
  /** Table map used as the city (its background image is drawn); null = no city tab. */
  mapId: MapId | null;
  /** id of the CityShapes the districts come from. */
  shapes: string | null;
  districts: CityDistrict[];
}

/** Where a lifestyle's home is on the city map. */
export interface LifestylePlace {
  /** Cells of the city map (floats). */
  x: number;
  y: number;
  /** District id at (x, y), computed by the server. */
  district: string | null;
  at: Timestamp;
  /** Runners the GM « invited »: their players see this home too. GM only. */
  guests?: ActorId[];
}

/** A home on the city map as a user receives it. */
export interface CityPin {
  actorId: ActorId;
  lifestyleId: string;
  /** Runner name. */
  actor: string;
  lifestyle: string;
  base: LifestyleBase;
  x: number;
  y: number;
  district: string | null;
  layout: string | null;
  /** One of the user's own runners (GM: always true). */
  own: boolean;
  guests: ActorId[];
}

/** `game.city`: the city map image and shapes, plus the homes this user may see. */
export interface CityView {
  map: { id: MapId; name: string; width: number; height: number; background: MapBackground } | null;
  districts: CityDistrict[];
  pins: CityPin[];
}

export interface MartialArtTechnique extends ItemBase {}

export interface MartialArt extends ItemBase {
  rating: number;
  techniques: MartialArtTechnique[];
}

export interface ActorVision {
  lowLight?: boolean;
  thermo?: boolean;
  /** Dark vision range in cells (thermographic = 10). */
  darkRange?: number;
}

export interface NpcInfo {
  professionalRating?: number;
  grunt?: boolean;
  kind?: NpcKind;
  initMode?: InitMode;
  /** Markdown, GM only (stripped for players). */
  tactics?: string;
  /** Markdown, GM only (stripped for players). */
  loot?: string;
}

/** Downtime training in progress (`actor.training`, owner: 50-training.js). */
export interface TrainingJob {
  id: string;
  requestId: string;
  kind: TrainingKind;
  /** French label. */
  label: string;
  labelI18n?: I18nEntry;
  daysTotal: number;
  daysDone: number;
  startedTs: Timestamp;
  request: AdvancementRequest;
}

/** Spell categories of a tradition's spirits (SR5 p. 279). */
export type SpellCategoryKey = 'combat' | 'detection' | 'health' | 'illusion' | 'manipulation';

/**
 * Magical tradition of an awakened actor (`actor.magic.tradition`, owner: 47-magic.ts). Copied from
 * data/catalog/traditions.json (Chummer traditions.xml) when it is set, so a custom tradition keeps its own values.
 */
export interface ActorTradition extends BookRefFields {
  /** Chummer tradition GUID (absent for a hand-made tradition). */
  id?: string;
  /** English (Chummer) name. */
  name: string;
  nameFr?: string;
  /** Second drain attribute: drain is resisted with WIL + this (null: not chosen yet, e.g. Custom). */
  drain: AttrKey | null;
  /** English spirit type per spell category. */
  spirits?: Partial<Record<SpellCategoryKey, string>>;
}

/** A spell the actor sustains (mirror of state.magic.sustained written by 47-magic): −2 dice on every test (SR5 p. 282). */
export interface SustainingEntry {
  id: string;
  name: BiName;
  force: number;
  /** Sustained by this sustaining focus (gear id): no −2 while the focus is bonded and active (SR5 p. 320). */
  focusId?: string;
}

/** A sustained spell acting on the actor (mirror of state.magic.sustained written by 47-magic), with its numeric effects. */
export interface SpellEffectEntry {
  id: string;
  name: BiName;
  force: number;
  hits: number;
  casterId: ActorId;
  casterName: string;
  /** Effects applied as modifiers (shared/magic.ts SPELL_EFFECTS): armor, defense… */
  effects: Array<{ type: 'armor' | 'stat'; target?: string; value: number }>;
}

/** Written by training (initiation, metamagics…) and the magic module (tradition, sustained spells). */
export interface ActorMagic {
  tradition?: ActorTradition;
  /** Spells this actor sustains (47-magic, never edited by hand). */
  sustaining?: SustainingEntry[];
  /** Sustained spells on this actor (47-magic, never edited by hand). */
  spellEffects?: SpellEffectEntry[];
  initiation?: number;
  submersion?: number;
  metamagics?: string[];
  echoes?: string[];
  extraPP?: number;
}

export type AfflictionKind = 'disoriented' | 'nauseous' | 'incapacitated';

/** Expiry of a lasting effect: end of a Combat Turn ('startedAt:round'), end of a fight (startedAt), or a time. */
export type EffectUntil = { round: string } | { combat: number } | { ts: Timestamp };

/** Toxin effect on an actor (`actor.afflictions`). */
export interface Affliction {
  id: string;
  kind: AfflictionKind;
  /** French toxin name. */
  source: string;
  sourceEn?: string;
  ts: Timestamp;
  until: EffectUntil;
}

/** Money / karma ledger line (`actor.history`). */
export interface HistoryEntry {
  ts: Timestamp;
  /** Text (a UI key when `i18n` is absent and the text is a known key). */
  text: string;
  i18n?: I18nEntry;
  /** Karma delta. */
  karma?: number;
  /** Nuyen delta. */
  nuyen?: number;
  chummer?: boolean;
}

/** Foundry VTT import metadata. */
export interface FoundryLink {
  id: string;
  world: string;
  importedAt: Timestamp;
  hash?: string;
  /** Item hashes of the last import (merge base). */
  snapshot?: unknown;
  snapshotVersion?: number;
  /** Foundry owner name. */
  user?: string;
}

/**
 * Chummer5a link (`actor.chummer`). In the state it holds the raw .chum5 `xml`; every VIEW (GM included) replaces it
 * with `hasFile` (85-chummer stripChummer).
 */
export interface ChummerLink {
  /** Raw .chum5 XML — server state only. */
  xml?: string;
  /** View only: an XML file is stored. */
  hasFile?: boolean;
  fileName: string;
  importedAt?: Timestamp;
  syncedAt?: Timestamp;
  exportedAt?: Timestamp;
  updatedAt?: Timestamp;
  sourceHash?: string;
  created?: boolean;
  appVersion?: string;
  /** Language of the texts the import wrote (notes, bio headings); absent = French (imports before 2026-11). */
  lang?: Lang;
  /** Gear with contents is a bag container (imports since 2026-11-28; older ones are migrated once at boot). */
  bags?: boolean;
  /** Upload URLs of the portraits. */
  mugshots?: string[];
}

/** A summoned spirit (`actor.spirit`, owner: 47-magic; SR5 pp. 300-302). */
export interface ActorSpirit {
  /** English spirit type of data/catalog/spirits.json ('Spirit of Fire'). */
  type: string;
  typeFr?: string;
  force: number;
  /** The magician who summoned it; their player controls it. */
  summonerId: ActorId;
  /** Services still owed (SR5 p. 302). */
  services: number;
  /** Bound spirit (SR5 p. 300): does not leave at sunrise / sunset. */
  bound: boolean;
  /** On the physical plane (token on the map), else astral. */
  materialized: boolean;
  /** Bound spirit at rest on its metaplane (false) or called to the summoner (true / absent). */
  present?: boolean;
  /** Chosen optional powers (English names). */
  optionalPowers: string[];
  ts: Timestamp;
}

/** PC or spawned NPC (`state.actors[id]`). Derived numbers are never stored: use derive()/deriveFull(). */
export interface Actor {
  id: ActorId;
  type: ActorType;
  name: string;
  /** Real player's name (PC). */
  player?: string;
  /** Bestiary template of a spawned NPC. */
  templateId?: string;
  metatype: Metatype;
  /** Chummer metavariant (English). */
  metavariant?: string;
  /** Real name behind the street name. */
  realName?: string;
  age?: number | string;
  gender?: string;
  concept?: string;
  /** Image URL (/uploads/…, /assets/…, https://…). */
  portrait?: string;
  /** Token color '#rrggbb'. */
  color?: string;
  /** Markdown. */
  bio?: string;
  /** Markdown, owner + GM (stripped from other players' views). */
  notes?: string;
  /** Markdown, GM only. */
  gmNotes?: string;
  /** NPC token disposition (templates, spawned NPCs). */
  disposition?: Disposition;
  attributes: Attributes;
  /** Bonuses from 'ware / powers (cap +4 applied by sr5.attr). */
  augmented?: Partial<Record<AttrKey, number>>;
  /** Extra initiative dice and flat bonus. */
  initiative?: { dice: number; bonus: number };
  /** Condition monitor overrides (grunts / critters). */
  monitors?: { physical?: number; stun?: number };
  /** Damage boxes filled. */
  condition: { physical: number; stun: number; overflow: number };
  /** max = attributes.EDG. */
  edge: { current: number };
  skills: Skill[];
  skillGroups?: SkillGroupRating[];
  knowledge: KnowledgeSkill[];
  qualities: Quality[];
  powers: AdeptPower[];
  spells: Spell[];
  complexForms?: ComplexForm[];
  weapons: Weapon[];
  armor: Armor[];
  augmentations: Augmentation[];
  gear: Gear[];
  containers?: Container[];
  vehicles: Vehicle[];
  matrix?: ActorMatrix;
  contacts: Contact[];
  sins: Sin[];
  lifestyles: Lifestyle[];
  martialArts: MartialArt[];
  /** Available karma. */
  karma: number;
  /** Career karma. */
  karmaTotal: number;
  nuyen: number;
  streetCred: number;
  notoriety: number;
  publicAwareness: number;
  vision?: ActorVision;
  npc?: NpcInfo;
  /** NPC: players don't see it at all. */
  hidden?: boolean;
  /** PC no longer played. */
  retired?: boolean;
  training?: TrainingJob[];
  magic?: ActorMagic;
  /** Summoned spirit (47-magic). */
  spirit?: ActorSpirit;
  afflictions?: Affliction[];
  history: HistoryEntry[];
  foundry?: FoundryLink;
  chummer?: ChummerLink;
  /** Legacy Foundry fields on old imports. */
  foundryWorld?: string;
  foundryImportedAt?: Timestamp;
  foundryHash?: string;
}

/** What a player sees of an NPC they do not control (10-characters filter). */
export interface NpcStub {
  id: ActorId;
  type: 'npc';
  name: string;
  portrait: string;
  color: string;
  metatype: Metatype;
  templateId: string | null;
  status: HealthStatus;
}

/** An actor in a client view: full sheet (GM; own and other PCs for players), or an NPC stub for players. */
export type ViewActor = Actor | NpcStub;

/**
 * Actor-shaped input of the shared rules functions (shared/*.ts): a full Actor, a bestiary Template, an NPC stub, a
 * chargen / enemy generator preview… Every field is optional and may be null: the rules read defensively.
 */
export type ActorLike = { [K in keyof Actor]?: Actor[K] | null };

/** The actor item lists (`ITEM_LISTS` of sheet-data.js) and their item types. */
export interface ActorItemLists {
  weapons: Weapon;
  armor: Armor;
  augmentations: Augmentation;
  gear: Gear;
  vehicles: Vehicle;
  contacts: Contact;
  sins: Sin;
  qualities: Quality;
  powers: AdeptPower;
  spells: Spell;
  knowledge: KnowledgeSkill;
  skills: Skill;
  complexForms: ComplexForm;
  skillGroups: SkillGroupRating;
  lifestyles: Lifestyle;
  martialArts: MartialArt;
}
export type ItemListName = keyof ActorItemLists;
/** Nested lists (`SUB_LISTS`): weapons → accessories, armor/vehicles → mods, lifestyles → qualities, martialArts → techniques. */
export type SubListName = 'accessories' | 'mods' | 'qualities' | 'techniques';

// =====================================================================================================================
// Bestiary & combat — owner: 30-combat.js
// =====================================================================================================================

/** NPC template (`state.bestiary[id]`): the Actor schema without runtime fields, plus a folder. GM only. */
export interface Template
  extends Omit<Actor, 'type' | 'templateId' | 'condition' | 'edge' | 'lifestyles' | 'martialArts' | 'contacts' | 'sins' | 'history' | 'karma' | 'karmaTotal' | 'nuyen' | 'streetCred' | 'notoriety' | 'publicAwareness'> {
  type: 'npc';
  /** 'Project Lazarus' | 'Gangs' | 'Sécurité corpo' | 'Générés'… */
  folder: string;
  /** Markdown. */
  description: string;
  tags?: string[];
  disposition: Exclude<Disposition, 'pc'>;
  initiative: { dice: number; bonus: number };
  vision: ActorVision;
  npc: NpcInfo;
  contacts?: Contact[];
  sins?: Sin[];
  lifestyles?: Lifestyle[];
  martialArts?: MartialArt[];
  /** Enemy generator preview only. */
  unitName?: string;
  /** Foundry VTT actor id (Foundry imports). */
  foundryId?: string;
}

export type CombatEntryKind = 'pc' | 'npc' | 'ic' | 'agent';

/** One line of the initiative tracker. Players lose the roll details of entries they do not own. */
export interface CombatEntry {
  id: string;
  /** null for Matrix entries (IC, agent). */
  actorId: ActorId | null;
  tokenId: string | null;
  name: string;
  /** Matrix entries: translatable name. */
  nameI18n?: I18nMessage;
  kind: CombatEntryKind;
  disposition: Disposition;
  /** Initiative base (stripped for players on entries they do not own). */
  base?: number;
  dice?: number;
  rolls?: number[];
  /** Initiative total of the turn. */
  total?: number;
  /** Current initiative score (passes subtract 10). */
  score: number;
  wound?: number;
  /** Interrupt actions spent (dodge, full defense…). */
  adjust?: number;
  acted: boolean;
  delayed: boolean;
  /** GM only until revealed. */
  hidden: boolean;
  out: boolean;
  /** Unconscious / dead (condition monitors). */
  down: boolean;
  /** Initiative not rolled yet. */
  toRoll: boolean;
  seized: boolean;
  blitz?: boolean;
  mode?: InitMode;
  /** Matrix entries: `ic:<hostId>:<icId>` / `agent:<actorId>`. */
  matrixKey?: string;
  hostId?: string;
  icId?: string;
  /** Agent entries: the decker's actor id. */
  ownerId?: ActorId;
}

/** `state.combat`. */
export interface CombatState {
  active: boolean;
  mapId: MapId | null;
  round: number;
  pass: number;
  /** Index of the current entry (recomputed in players' views). */
  turn: number;
  currentId: string | null;
  entries: CombatEntry[];
  startedAt?: Timestamp;
}

// =====================================================================================================================
// Attacks — owner: 33-attacks.js
// =====================================================================================================================

export type AttackKind = 'ranged' | 'melee' | 'blast' | 'toxin' | 'spell';
export type AttackStatus = 'defense' | 'soak' | 'missed' | 'done' | 'cancelled';
export type DamageType = 'P' | 'S';
export type BlastEffect = 'explosion' | 'smoke' | 'thermalSmoke' | 'gas' | 'flashpak';

export interface Attack {
  id: string;
  ts: Timestamp;
  mapId: MapId | null;
  kind: AttackKind;
  /** null in players' views when the attacker is hidden. */
  attackerId: ActorId | null;
  /** '?' in players' views when the attacker is hidden. */
  attackerName: string;
  attackLogId?: string;
  targetId: ActorId;
  targetTokenId: string | null;
  targetName: string;
  weaponName: BiName | null;
  actionId?: string;
  actionName?: string;
  hits: number;
  /** null = no damage code. */
  dv: number | null;
  type: DamageType;
  ap: number;
  reach?: number;
  /** Fire mode defense modifier. */
  defenseMod?: number;
  defenseLabel?: string;
  actionDefense?: number;
  noDamage?: boolean;
  range?: { band: string; meters: number };
  /** Blast / gas: distance to the landing point in metres. */
  meters?: number;
  toxinId?: string;
  toxinName?: BiName;
  status: AttackStatus;
  defenseHits?: number;
  defenseLogId?: string;
  net?: number;
  modifiedDv?: number;
  soakHits?: number;
  soakLogId?: string;
  damage?: number;
  /** null when a toxin does no damage. */
  damageType?: DamageType | null;
  /** Toxin: Power − hits left. */
  left?: number;
  /** Toxin afflictions inflicted. */
  effects?: AfflictionKind[];
  manual?: boolean;
  resolvedTs?: Timestamp;
  gmOnly?: boolean;
  /** Astral combat (47-magic, SR5 p. 315): defense INT + LOG, soak with `soak` and no armor. */
  astral?: { soak: AttrKey };
  /** Combat spell (kind 'spell', 47-magic): direct = resisted with `resist`, no soak; indirect = dodge then soak. */
  spell?: { mode: 'direct' | 'indirect'; resist: AttrKey; resist2?: AttrKey | null; force: number; element?: string | null; castLogId?: string };
}

/** An actor caught in a blast. */
export interface BlastHit {
  actorId: ActorId;
  tokenId: string;
  name: string;
  dv: number;
  meters: number;
  attackId: string;
}

/** Area weapon landing (`attacks.blasts`, max 12). */
export interface Blast {
  id: string;
  ts: Timestamp;
  mapId: MapId;
  attackerId: ActorId;
  attackerName: string;
  weaponName: BiName;
  /** Thrower's cell (null without a token). */
  from: Point | null;
  aim: Point;
  /** Landing cell (may be fractional). */
  x: number;
  y: number;
  /** Scatter distance in metres. */
  meters: number;
  scattered: boolean;
  /** Scatter direction dice. */
  dir: number[] | null;
  dist: number[] | null;
  fumble?: boolean;
  glitch?: boolean;
  hitsRolled: number;
  dv: number | null;
  type: DamageType;
  ap: number;
  /** DV lost per metre (null: no blast profile). */
  falloff?: number | null;
  /** Radius in metres (null: no blast profile). */
  radius?: number | null;
  /** Reach in metres. */
  reach: number;
  hits: BlastHit[];
  gmOnly?: boolean;
  effect?: BlastEffect | null;
  until?: EffectUntil;
  toxinId?: string;
  toxinName?: BiName;
}

/** Per-actor Combat Turn record (GM view). */
export interface AttackTurnRecord {
  /** combatTurnKey 'startedAt:round'. */
  key: string;
  defended: number;
  /** Defense option ids paid for the turn. */
  boosts: string[];
  /** Once-per-turn action ids used. */
  once: string[];
}

/** `state.attacks`. */
export interface AttacksState {
  /** Newest first, max 60. */
  list: Attack[];
  blasts: Blast[];
  /** GM only. */
  turn: Record<ActorId, AttackTurnRecord>;
}

/** `view.attacks` of a player: no `turn`, plus their own characters' turn records. */
export interface AttacksView {
  list: Attack[];
  blasts: Blast[];
  turn?: Record<ActorId, AttackTurnRecord>;
  myTurn?: Record<ActorId, Omit<AttackTurnRecord, 'key'>>;
}

// =====================================================================================================================
// Maps — owner: 20-maps.js (library links: 22-maplib.js)
// =====================================================================================================================

export type DoorState = 'open' | 'closed' | 'locked';
export type DoorKind = 'door' | 'gate' | 'shutter' | 'secret';
export type Lighting = 'bright' | 'dim' | 'dark';
export type MapTheme = 'street' | 'bar' | 'corp' | 'lab' | 'industrial' | 'residential' | 'matrix' | 'club';

/** Tile door (the cell holds 'D'). Players: locked shows as closed, closed secret doors are absent (rendered as walls). */
export interface MapDoor {
  id: string;
  /** Cell. */
  x: number;
  y: number;
  state: DoorState;
  kind: DoorKind;
  name?: string;
}

export interface MapLight {
  id: string;
  /** Cell. */
  x: number;
  y: number;
  /** Radius in cells. */
  radius: number;
  color: string;
  on: boolean;
  /** GM label (stripped for players). */
  name?: string;
}

/** Labelled room / zone. */
export interface MapRegion {
  id: string;
  name: string;
  /** Top-left cell and size in cells. */
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  gmOnly: boolean;
  /** Camera zone driven by a Matrix host device: 'on' filmed, 'off' feed cut. Absent = no camera. */
  cams?: 'on' | 'off';
}

/** GM pin. Never sent to players. */
export interface MapNote {
  id: string;
  x: number;
  y: number;
  text: string;
  gmOnly: true;
}

/** Door carried by a segment wall. */
export interface WallDoor {
  state: DoorState;
  kind: 'door' | 'secret';
  name?: string;
}

/** Thin wall between / through cells (Foundry imports, library maps). Coordinates in CELL units (floats), origin = grid top-left. */
export interface MapWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Blocks movement. */
  move: boolean;
  /** Blocks sight (a window: move true, sight false). */
  sight: boolean;
  door: WallDoor | null;
  /** One-way wall in Foundry. */
  foundry?: { dir: number };
}

/** Image under / instead of the tiles. x/y/w/h in cells. */
export interface MapBackground {
  url: string;
  opacity: number;
  /** 'image': the image IS the floor (no tile art); 'underlay': tiles drawn over it. */
  mode: 'image' | 'underlay';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Link of a table map to a server-wide library map (GM only, stripped for players). */
export interface MapLibraryLink {
  slug: string;
  version: number;
  linkedAt?: Timestamp;
  syncedAt?: Timestamp;
  /** Linked automatically from a Foundry fragmaps-free scene. */
  migrated?: boolean;
}

export interface TokenVision {
  lowLight?: boolean;
  thermo?: boolean;
  /** Cells. */
  darkRange?: number;
}

export interface Token {
  id: string;
  actorId: ActorId | null;
  name: string;
  /** Integer cells. */
  x: number;
  y: number;
  /** Cells per side (1–4). */
  size: number;
  color?: string;
  img?: string;
  disposition: Disposition;
  /** GM only. */
  hidden: boolean;
  /** Stripped for players on tokens they do not own. */
  vision?: TokenVision;
  /** Torch / flashlight: radius in cells. */
  light?: { radius: number; color: string };
  /** Markers: 'à terre', 'inconscient', 'mort'… (French). */
  status?: string[];
  /** Last move path as [x, y] cells (players see only its visible tail). */
  lastMove?: { path: Array<[number, number]>; ts: Timestamp };
  /** Combat movement used this Combat Turn, in metres. */
  moveBudget?: { key: string; meters: number };
  /** Astral form (projecting magician, spirit on the astral plane): seen only by astral viewers (47-magic filter). */
  astral?: boolean;
}

/**
 * A table map (`state.maps[id]`). Players only receive the shown map, masked to what they know: unknown tiles become ' ',
 * no notes / description / GM regions / library link, and `explored` holds only their own key plus `visible`.
 */
export interface GameMap {
  id: MapId;
  name: string;
  folder?: string;
  /** Markdown, GM only. */
  description?: string;
  /** Size in cells. */
  width: number;
  height: number;
  metersPerCell: number;
  /** `height` rows of `width` chars (tile legend in ARCHITECTURE.md « Maps »). */
  tiles: string[];
  doors: MapDoor[];
  lights: MapLight[];
  /** Ambient light. */
  lighting: Lighting;
  /** Environmental modifier levels 0–3 (absent = clear, no wind). */
  weather?: { visibility: number; wind: number };
  regions: MapRegion[];
  notes: MapNote[];
  tokens: Token[];
  walls: MapWall[];
  /** Fog-of-war memory per user (bit field encoded by the maps module). */
  explored: Record<UserId, string>;
  /** Player view only: cells visible right now (same encoding as `explored`). */
  visible?: string;
  /** false = players see the whole map. */
  fog: boolean;
  /** The party shares what any PC sees. */
  sharedVision: boolean;
  /** GM freeze: players can't move tokens. */
  movementLocked: boolean;
  background?: MapBackground;
  theme: MapTheme;
  library?: MapLibraryLink;
  /** Foundry scene thumbnail URL. */
  thumb?: string;
  foundry?: { id: string; world: string; importedAt: Timestamp; hash?: string };
  /** A runner's home map (lifestyle.home.mapId points back here). */
  home?: { actorId: ActorId; lifestyleId: string };
}

/** `state.scene`. */
export interface SceneState {
  /** The map players currently see. */
  activeMapId: MapId | null;
}

// =====================================================================================================================
// Shop — owner: 40-shop.js
// =====================================================================================================================

export type Legality = '' | 'R' | 'F';
export type ShopApproval = 'never' | 'restricted' | 'always';
export type AvailTestMode = 'required' | 'helper' | 'off';
export type OrderKind = 'buy' | 'sell' | 'give' | 'karma';
export type OrderStatus = 'pending' | 'approved' | 'denied' | 'done' | 'cancelled';

/** GM-curated item / fixer deal. */
export interface ShopSpecial {
  id: string;
  name: string;
  category?: string;
  /** Catalog file it is sold as. */
  file: CatalogFile;
  cost: number;
  originalCost?: number | null;
  avail: string;
  /** null = unlimited. */
  stock: number | null;
  notes?: string;
  /** GM only (stripped for players). */
  gmNotes?: string;
  /** Hidden from players. */
  hidden?: boolean;
  /** Reserved for these runners. */
  forActorIds?: ActorId[];
  rating?: number | null;
  grade?: WareGrade;
  /** Number, or the GM's raw text ('' = none). */
  essence?: number | string | null;
  catalogRef?: string | null;
  stats?: CatalogStats;
}

/** Availability test claimed by an order line. */
export interface OrderLineAvailTest {
  id: string;
  hits: number;
  availHits: number;
  net: number;
  avail: number;
  baseHours: number;
  delayHours: number | null;
  tries: number;
  tie?: boolean;
  glitch?: boolean;
  contact?: string;
  overpay?: number;
}

/** One line of a shop order (priced and validated by the server). */
export interface OrderLine {
  /** Catalog id or 'special:<id>'. */
  ref: string;
  specialId?: string;
  catalogId?: string;
  file?: CatalogFile;
  name: string;
  category?: string;
  qty: number;
  rating?: number | null;
  grade?: WareGrade | null;
  /** null on sell lines the GM prices. */
  unitCost: number | null;
  availValue?: number;
  legality?: Legality;
  essence?: number;
  stats?: CatalogStats;
  variablePrice?: boolean;
  /** Upgrade target (weapon / armor / vehicle / lifestyle). */
  target?: { list: string; itemId: string; name: string };
  mount?: MountPoint;
  capacity?: number;
  slots?: number;
  effects?: Partial<Record<VehicleStatKey, number>>;
  /** Lifestyle options: rent change. */
  monthlyDelta?: number;
  monthlyCost?: number;
  lowersRent?: boolean;
  /** Value of the installed part (resale). */
  price?: number;
  lifestyleName?: string;
  primary?: boolean;
  setMatrix?: boolean;
  /** Sell lines: list and id of the sold item, and the sold sub-item. */
  list?: string;
  itemId?: string;
  subId?: string;
  /** Karma orders (martial arts). */
  karma?: number;
  techniqueIds?: string[];
  /** Karma orders: names of the techniques learnt. */
  techniques?: string[];
  availTest?: OrderLineAvailTest;
  /** Overpay surcharge per unit (included in the total). */
  surcharge?: number;
}

export interface ShopOrder {
  id: string;
  ts: Timestamp;
  actorId: ActorId;
  userId: UserId;
  /** 'MJ' or the player's name. */
  by?: string;
  kind: OrderKind;
  items: OrderLine[];
  /** null = sell price to be set by the GM. */
  total: number | null;
  /** Karma orders. */
  karma?: number;
  status: OrderStatus;
  /** 'restricted', 'price', 'rent'… why it waits for the GM. */
  flags?: string[];
  gmNote?: string;
  resolvedTs?: Timestamp;
}

/** Stored availability test (max 300; players see their own actors' only). */
export interface AvailTest {
  id: string;
  ts: Timestamp;
  actorId: ActorId;
  userId: UserId;
  /** Catalog ref searched. */
  ref: string;
  targetId?: string;
  name: string;
  avail: number;
  legality: Legality;
  availHits: number;
  hits: number;
  glitch: boolean;
  critGlitch: boolean;
  overpay?: number;
  /** Log entry of the roll (live hits are read from it). */
  logId: string;
  baseHours: number;
  tries: number;
  status: 'open' | 'used';
  orderId?: string;
  contactId?: string;
  contactName?: string;
}

/** A contact's stats from an NPC actor / bestiary template of the same name (shared/contacts.js contactSheet). */
export interface ContactSheet {
  id: string;
  name: string;
  connection: number;
  /** A sheet was found. */
  known: boolean;
  /** Name of the NPC / template the stats come from. */
  source?: string;
  portrait?: string;
  color?: string;
  cha?: number;
  negotiation?: number;
  pool?: number;
  defaulting?: boolean;
  etiquette?: number;
  etiquetteDefaulting?: boolean;
  social?: number;
  limit?: number;
}

/** `state.shop`. */
export interface ShopState {
  open: boolean;
  /** Percent. */
  markup: number;
  /** Percent of the price paid back. */
  sellRate: number;
  maxAvail: number;
  allowRestricted: boolean;
  allowForbidden: boolean;
  approval: ShopApproval;
  availTest: AvailTestMode;
  /** Items with Availability ≤ availFree need no test. */
  availFree: number;
  /** Catalog files on sale. */
  categories: Partial<Record<CatalogFile, boolean>>;
  specials: ShopSpecial[];
  orders: ShopOrder[];
  availTests: AvailTest[];
  /** Seed specials the GM deleted (GM only). */
  removedSeedIds?: string[];
  /** Actors whose historic Chummer upgrades were restored (GM only). */
  restored?: ActorId[];
  /** Player view only: who can run an availability search for each of their runners. */
  contactSearch?: Record<ActorId, ContactSheet[]>;
}

// =====================================================================================================================
// Training — owner: 50-training.js, rules shared/advancement.js
// =====================================================================================================================

export type TrainingKind =
  | 'attribute' | 'skill' | 'skillGroup' | 'specialization' | 'knowledge' | 'quality' | 'removeQuality'
  | 'spell' | 'complexForm' | 'power' | 'powerPoint' | 'initiation' | 'martialArt' | 'focus' | 'other';

/** A martial art technique carried by a 'martialArt' request (catalog martialarts.json, Run & Gun). */
export interface AdvancementTechnique {
  /** Catalog technique id. */
  id: string;
  name: string;
  nameFr?: string;
}

/** Normalized advancement request (shared/advancement.js normalizeRequest). */
export interface AdvancementRequest {
  kind: TrainingKind | null;
  target: string;
  to: number | null;
  name: string;
  altName: string;
  spec: string;
  attr: AttrKey | '';
  ktype: KnowledgeType | '';
  karma: number;
  pp: number;
  extraPP: number;
  levels: boolean;
  maxLevel: number | null;
  days: number;
  instructor: boolean;
  note: string;
  catalogId: string;
  positive: boolean;
  data: { category: string; type: string; range: string; duration: string; drain: string };
  options: { group: boolean; ordeal: boolean; schooling: boolean; metamagic: string; powerPoint: boolean };
  /** 'martialArt': techniques to learn (catalogId = style id, karma = style cost). */
  techniques: AdvancementTechnique[];
  free: boolean;
}

export interface TrainingSettings {
  /** 'always' = every request waits for the GM; 'never' = auto-approved (manual entries still wait). */
  approval: 'always' | 'never';
  /** false = advances apply immediately on approval. */
  useTime: boolean;
  /** Percent. */
  instructorTimeReduction: number;
  /** ¥ per week. */
  instructorCostPerWeek: { attribute: number; skill: number; knowledge: number; other: number };
}

export interface TrainingRequest {
  id: string;
  ts: Timestamp;
  actorId: ActorId;
  userId: UserId;
  kind: TrainingKind;
  target: string;
  from: number | null;
  to: number | null;
  /** French label. */
  label: string;
  labelI18n?: I18nEntry;
  karmaCost: number;
  nuyenCost: number;
  days: number;
  daysBase: number;
  instructor: boolean;
  ppCost?: number;
  /** Not verified against the catalog: always needs the GM. */
  manual?: boolean;
  request: AdvancementRequest;
  status: OrderStatus;
  note?: string;
  gmNote?: string;
  resolvedTs?: Timestamp;
  doneTs?: Timestamp;
  jobId?: string;
}

/** `state.training`. */
export interface TrainingState {
  settings: TrainingSettings;
  /** Downtime days advanced by the GM. */
  daysElapsed: number;
  requests: TrainingRequest[];
}

// =====================================================================================================================
// Audio — owner: 60-audio.js
// =====================================================================================================================

export type TrackKind = 'ambient' | 'music' | 'sfx';

export interface AudioTrack {
  id: string;
  name: string;
  kind: TrackKind;
  /** 'synth' = procedurally generated in the browser; 'url' = a file. */
  source: 'synth' | 'url';
  /** Synth preset id ('rain'…). */
  preset?: string;
  url?: string;
  tags?: string[];
  credit?: string;
  /** 0–2. */
  volume?: number;
  loop?: boolean;
  foundry?: unknown;
}

export interface AudioChannel {
  trackId: string | null;
  /** 0–1. */
  volume: number;
  startedAt: Timestamp;
}

/** One-click preset: track ids, null = silence, 'keep' = leave the channel as is. */
export interface AudioScene {
  id: string;
  name: string;
  ambient?: string | null;
  music?: string | null;
  mapId?: MapId;
  ambientVolume?: number;
  musicVolume?: number;
}

/** `state.audio`. Players get master/ambient/music and only the playing tracks + uploaded sfx. */
export interface AudioState {
  /** 0–1. */
  master: number;
  ambient: AudioChannel;
  music: AudioChannel;
  tracks: AudioTrack[];
  /** GM only. */
  scenes?: AudioScene[];
  /** GM only: apply a scene when its map is shown. */
  autoScenes?: boolean;
}

// =====================================================================================================================
// Campaign — owner: 70-campaign.js
// =====================================================================================================================

export type QuestStatus = 'upcoming' | 'active' | 'done' | 'skipped';
export type ThreadState = 'open' | 'dormant' | 'resolved' | 'dead';

export interface CampaignAct {
  id: string;
  title: string;
  /** Markdown. */
  summary: string;
}

export interface QuestPhase {
  id: string;
  title: string;
  /** Markdown. */
  text: string;
  done: boolean;
}

export interface Quest {
  id: string;
  actId: string;
  title: string;
  status: QuestStatus;
  summary: string;
  phases: QuestPhase[];
  /** Template or actor ids. */
  npcs: string[];
  maps: MapId[];
  rewards: string;
  gmNotes: string;
  /** Campaign doc 'file.md' or 'file.md#Heading' ('' = none). */
  doc: string;
}

export interface CampaignSession {
  id: string;
  number: number;
  title: string;
  date: string;
  /** Markdown. */
  plan: string;
  /** Markdown. */
  recap: string;
  played: boolean;
  doc: string;
}

export interface CampaignThread {
  id: string;
  label: string;
  state: ThreadState;
  notes: string;
}

export interface Handout {
  id: string;
  title: string;
  /** Markdown. */
  body: string;
  /** Image URL ('' = none). */
  image: string;
  /** 'all' or the user ids it is revealed to ([] = hidden). */
  revealedTo: 'all' | UserId[];
  ts: Timestamp;
  revealedAt?: Timestamp;
  gmNotes: string;
}

/** `state.campaign` (GM view). */
export interface Campaign {
  acts: CampaignAct[];
  quests: Quest[];
  sessions: CampaignSession[];
  threads: CampaignThread[];
  handouts: Handout[];
  /** « L'histoire jusqu'ici », markdown shown to players. */
  playerRecap: string;
  /** GM scratchpad, markdown. */
  notes: string;
  /** null = automatic (act of the first active quest). */
  currentActId: string | null;
  /** Seed bookkeeping (hashes of untouched seed items, deleted seed keys). */
  _seed?: { hashes: Record<string, string>; deleted: string[] };
}

/** A handout as a player receives it. */
export interface PlayerHandout {
  id: string;
  title: string;
  body: string;
  image: string;
  ts: Timestamp;
  revealedAt: Timestamp;
  toAll: boolean;
}

/** `view.campaign` of a player. */
export interface PlayerCampaignView {
  handouts: PlayerHandout[];
  playerRecap: string;
}

// =====================================================================================================================
// Notes — owner: 75-notes.js
// =====================================================================================================================

export interface NotePage {
  id: string;
  scope: 'private' | 'party';
  /** Private pages only. */
  ownerId?: UserId;
  title: string;
  /** Markdown (≤ 100 000 chars). */
  body: string;
  /** Private pages only: the GM may read it. */
  shareWithGM?: boolean;
  /** '' = none. */
  folder: string;
  pinned: boolean;
  createdBy: UserId;
  updatedBy: UserId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Counts BODY changes (conflict detection). */
  version: number;
  /** Party pages: soft edit lock (60 s). */
  lock?: { userId: UserId; name: string; until: Timestamp };
  /** In the trash (purged after 7 days). */
  deleted?: { at: Timestamp; by: UserId };
}

export interface NoteComment {
  id: string;
  userId: UserId;
  author: string;
  text: string;
  ts: Timestamp;
}

export interface NotesSettings {
  gmCanEditParty: boolean;
}

/** `state.notes`. */
export interface NotesState {
  pages: Record<string, NotePage>;
  comments: Record<string, NoteComment[]>;
  settings: NotesSettings;
}

/** `view.notes`: the pages this user may read (GM view filtered too) and the server clock. */
export interface NotesView extends NotesState {
  /** Server time (clients estimate the clock skew for lock expiry). */
  now: Timestamp;
}

// =====================================================================================================================
// Matrix — owner: 45-matrix.js, rules shared/matrix.js
// =====================================================================================================================

export type MatrixMode = 'ar' | 'cold' | 'hot';
export type AsdfKey = 'attack' | 'sleaze' | 'dataProcessing' | 'firewall';
export type IcType =
  | 'patrol' | 'probe' | 'killer' | 'acid' | 'binder' | 'jammer' | 'marker' | 'crash' | 'tarbaby' | 'scramble' | 'track' | 'blaster' | 'black' | 'sparky';
export type DeviceLinkKind = 'door' | 'light' | 'camera';

export interface MatrixSettings {
  /** Players only see their OS with Baby Monitor loaded. */
  hideOverwatch: boolean;
  /** +2D6 OS per 15 real minutes online, applied at the next Matrix action. */
  osTimer: boolean;
  /** New Combat Turn: an alerted host with an intruder in the fight launches its next IC. */
  autoLaunchIc: boolean;
}

/** Marks the persona holds on a target. */
export interface MatrixMark {
  /** 'host:<id>', 'ic:<hostId>:<icId>', 'dev:…', persona key… */
  targetId: string;
  name: string;
  /** Generated name as a message (« Fichier {n} »…). */
  nameI18n?: I18nMessage;
  count: number;
}

/** Marks placed on the persona. */
export interface MatrixMarkOnMe {
  sourceId: string;
  name: string;
  nameI18n?: I18nMessage;
  count: number;
}

export interface MatrixAgent {
  rating: number;
  name: string;
  loaded: boolean;
  damage: number;
  /** Where the agent comes from (program name / gear). */
  source?: string;
}

/** Agent teamwork hits waiting for the decker's next action of that skill. */
export interface PendingAssist {
  actionId: string;
  skill: string;
  dice: number;
  limitBonus: number;
  hits: number;
  glitch?: boolean;
  ts?: Timestamp;
}

export interface LinkLock {
  /** 'host:<id>'. */
  source: string;
  name: string;
  icType: IcType;
  hostName: string;
  pool: number;
}

/** Paydata copied / read by the decker. */
export interface PersonaFile {
  id: string;
  sourceId: string;
  name: string;
  hostName: string;
  value: number | null;
  content: string;
  ts: Timestamp;
  readOnly?: boolean;
  shared?: boolean;
}

/** A decker's persona (`matrix.personas[actorId]`). */
export interface Persona {
  actorId: ActorId;
  online: boolean;
  mode: MatrixMode;
  /** Permutation of the deck's base values: slot → attribute it takes its value from. */
  asdf: Record<AsdfKey, AsdfKey>;
  loadedPrograms: string[];
  programSlots: number;
  slotsOverride: boolean;
  deviceName: string;
  marks: MatrixMark[];
  marksOnMe: MatrixMarkOnMe[];
  /** Overwatch Score 0–40 (players: osKnown when hidden). */
  overwatch: number | null;
  /** Player view: the real OS is hidden (no Baby Monitor). */
  overwatchHidden?: boolean;
  osKnown: number | null;
  /** When osKnown was last checked (player view, hidden OS). */
  osKnownAt?: Timestamp | null;
  /** When the persona was last converged on. */
  convergedAt?: Timestamp;
  matrixDamage: number;
  noise: number;
  hostId: string | null;
  /** ASDF penalties until reboot (Acid / Binder / Jammer IC). */
  penalties: Partial<Record<AsdfKey, number>>;
  linkLocked: LinkLock | null;
  fullDefense: boolean;
  bricked: boolean;
  traced: boolean;
  files: PersonaFile[];
  agent: MatrixAgent | null;
  pendingAssist: PendingAssist | null;
  /** Start of the current 15-minute OS period. */
  osClock: Timestamp | null;
  /** Converged inside that host (leaving it brings the grid's convergence). */
  hostConverged: string | null;
}

export interface HostIc {
  id: string;
  type: IcType;
  rating: number;
  active: boolean;
  damage: number;
  detected: boolean;
  crashed: boolean;
}

export interface HostFile {
  id: string;
  name: string;
  protected: boolean;
  protection: number;
  /** Data bomb rating (0 = none). */
  bomb: number;
  /** Persona key of the decker who set the bomb. */
  bombBy: string | null;
  /** ¥ value (null = unknown). */
  value: number | null;
  /** French text (GM only). */
  content: string;
  edited: boolean;
}

/** Host device link to a map object: a tile / segment-wall door, a light, or a region (camera zone). */
export interface DeviceLink {
  mapId: MapId;
  kind: DeviceLinkKind;
  targetId: string;
}

export interface HostDevice {
  id: string;
  name: string;
  rating: number;
  damage: number;
  offline: boolean;
  formatted: boolean;
  bricked: boolean;
  controlledBy: string | null;
  notes: string;
  link: DeviceLink | null;
  /** Lights / cameras switched on. */
  on: boolean;
}

/** `matrix.hosts[id]` (GM view). */
export interface Host {
  id: string;
  name: string;
  rating: number;
  attack: number;
  sleaze: number;
  dataProcessing: number;
  firewall: number;
  alert: 'none' | 'active';
  /** Players can target it. */
  visible: boolean;
  ic: HostIc[];
  files: HostFile[];
  devices: HostDevice[];
  /** User ids who perceived it (Matrix Perception). */
  perceivedBy: UserId[];
  /** Actor / persona ids the host spotted. */
  spotted: string[];
  /** Bestiary template id of the host's spider. */
  spider: string | null;
  spiderAlert: string | null;
  /** GM notes. */
  notes: string;
  description: string;
  folder: string;
}

/** A host as a player sees it (rating / files / devices only after Matrix Perception). */
export interface PlayerHostView {
  id: string;
  name: string;
  alert: 'none' | 'active';
  visible: boolean;
  /** One of the player's personas is inside. */
  inside: boolean;
  perceived: boolean;
  description: string;
  /** The host spotted one of the player's characters. */
  spotted: boolean;
  rating?: number;
  attack?: number;
  sleaze?: number;
  dataProcessing?: number;
  firewall?: number;
  ic: Array<{ id: string; type: IcType; rating?: number; damage?: number; detected: boolean }>;
  files: Array<{ id: string; name: string; protected: boolean; bomb: number; mine: boolean; value?: number }>;
  devices: Array<{
    id: string;
    name: string;
    rating: number;
    offline: boolean;
    formatted: boolean;
    bricked: boolean;
    damage: number;
    link?: { kind: DeviceLinkKind; state: string };
  }>;
}

/** `state.matrix`. */
export interface MatrixState {
  settings: MatrixSettings;
  personas: Record<ActorId, Persona>;
  hosts: Record<string, Host>;
}

/** `view.matrix`: players get only their own personas and the hosts they may see. */
export interface MatrixView {
  settings: MatrixSettings;
  personas: Record<ActorId, Persona>;
  hosts: Record<string, Host | PlayerHostView>;
}

// =====================================================================================================================
// Magic — owner: 47-magic.ts, rules shared/magic.ts (design: docs/design/magic.md)
// =====================================================================================================================

export interface MagicSettings {
  /** Drain resisted right after a cast / summoning (false: a « Resist drain » button is left instead). */
  autoDrain: boolean;
  /** Players see every astral presence (false: only when they perceive or project themselves). */
  showAstralToPlayers: boolean;
}

/** `state.magic`. `sustained` and `astral` are filled by the sustained-spell and astral features. */
export interface MagicState {
  settings: MagicSettings;
  sustained: Record<string, SustainedSpell>;
  astral: Record<ActorId, AstralPresence>;
  /** Drain left to resist (settings.autoDrain off), by id. */
  pendingDrain: Record<string, PendingDrain>;
}

/** Drain a caster still has to resist (SR5 p. 282). */
export interface PendingDrain {
  id: string;
  actorId: ActorId;
  /** Drain Value. */
  dv: number;
  type: 'P' | 'S';
  /** What caused it (spell name). */
  source: BiName;
  ts: Timestamp;
}

/** `entry.magic` of a magic log entry. */
export interface MagicLogInfo {
  event: 'cast' | 'drain' | 'drop' | 'summon' | 'spirit' | 'bind' | 'banish' | 'astral';
  actorId: ActorId;
  spellId?: string;
  force?: number;
  hits?: number;
  reckless?: boolean;
  dv?: number;
  drainType?: 'P' | 'S';
  /** Drain boxes taken after resistance. */
  damage?: number;
  targetIds?: ActorId[];
}

/** Who carries a sustained spell's −2: its caster, a bound spirit for some Combat Turns (SR5 p. 302), or a sustaining focus (p. 320). */
export type SustainCarrier = { kind: 'caster' } | { kind: 'spirit'; actorId: ActorId; turnsLeft: number } | { kind: 'focus'; gearId: string };

/** A spell being sustained (by its caster, a bound spirit or a sustaining focus). */
export interface SustainedSpell {
  id: string;
  casterId: ActorId;
  /** Id of the spell in the caster's `spells`. */
  spellId: string;
  name: BiName;
  force: number;
  hits: number;
  targetIds: ActorId[];
  ts: Timestamp;
  /** Absent = the caster. */
  by?: SustainCarrier;
  /** Permanent (P) spell: Combat Turns left before its effect becomes permanent and the spell ends (SR5 p. 283). */
  turnsLeft?: number;
  /** Area of the spell (cells, radius in metres). */
  area?: { mapId: MapId; x: number; y: number; radius: number };
}

/** Astral state of an actor (absent: physical only). */
export interface AstralPresence {
  mode: 'perceiving' | 'projecting';
  since: Timestamp;
  /** Projecting: the map of the astral form. */
  mapId?: MapId;
}

/** `view.magic`: players only get the entries of their own characters (astral: all when the GM shows them). */
export type MagicView = MagicState;

// =====================================================================================================================
// Character creation — owner: 15-chargen.js, rules shared/chargen.js
// =====================================================================================================================

export type PriorityLetter = 'A' | 'B' | 'C' | 'D' | 'E' | '';
export type PriorityColumn = 'metatype' | 'attributes' | 'magic' | 'skills' | 'resources';
export type MagicType = 'none' | 'magician' | 'mystic' | 'adept' | 'aspected' | 'technomancer';
export type DraftStatus = 'draft' | 'pending' | 'approved' | 'rejected';
/** Catalog files usable in the creator's gear step. */
export type ChargenGearFile = 'weapons' | 'armor' | 'gear' | 'cyberware' | 'bioware' | 'vehicles' | 'programs' | 'accessories' | 'armormods';

/** Normalized draft data (shared/chargen.js normalizeDraft). */
export interface DraftData {
  v: 1;
  concept: { name: string; alias: string; concept: string; gender: string; age: string; portrait: string; background: string; player: string; color: string };
  priorities: Record<PriorityColumn, PriorityLetter>;
  metatype: 'Humain' | 'Elfe' | 'Nain' | 'Ork' | 'Troll';
  /** Points spent above the metatype minimum (EDG / MAG / RES: special points). */
  attributes: Partial<Record<AttrKey, number>>;
  /** Extra ratings bought with karma. */
  attrKarma: Partial<Record<AttrKey, number>>;
  magic: { type: MagicType; tradition: string; aspect: 'sorcery' | 'conjuring' | 'enchanting'; freeSkills: string[]; freeGroup: string; mentor: string; ppKarma: number };
  skills: Array<{ id: string; points: number; karma: number; spec: string; specKarma: boolean }>;
  groups: Array<{ id: string; points: number; karma: number }>;
  knowledge: Array<{ id: string; name: string; type: KnowledgeType; points: number; karma: number; spec: string; native: boolean }>;
  qualities: Array<{ id: string; catalogId: string; name: string; level: number; choice: string; notes: string }>;
  spells: Array<{ id: string; catalogId: string; name: string }>;
  powers: Array<{ id: string; catalogId: string; name: string; level: number; choice: string }>;
  complexForms: Array<{ id: string; formId: string }>;
  gear: Array<{
    id: string;
    ref: string;
    file: ChargenGearFile;
    name: string;
    qty: number;
    rating: number | null;
    grade: WareGrade | null;
    /** Weapon accessory / armor mod: the draft row it is installed on. */
    target?: string;
    mount?: string;
  }>;
  lifestyle: { catalogId: string; months: number } | null;
  rollStartingNuyen: boolean;
  karmaToNuyen: number;
  contacts: Array<{ id: string; name: string; connection: number; loyalty: number; notes: string }>;
  notes: string;
}

export interface ChargenDraft {
  id: string;
  userId: UserId;
  userName: string;
  status: DraftStatus;
  data: DraftData;
  gmNote: string;
  ts: Timestamp;
  createdTs: Timestamp;
  submittedTs?: Timestamp;
  resolvedTs?: Timestamp;
  /** The PC built on approval. */
  actorId?: ActorId;
  /** Validation summary (counts). */
  check?: { errors: number; warnings: number };
}

export interface ChargenSettings {
  method: 'priority';
  allowPlayers: boolean;
  startingKarmaBonus: number;
}

/** `state.chargen`. Players only receive their own drafts. */
export interface ChargenState {
  settings: ChargenSettings;
  drafts: ChargenDraft[];
}

// =====================================================================================================================
// Foundry & Chummer import bookkeeping — owners: 80-foundry.js, 85-chummer.js
// =====================================================================================================================

/** `state.foundry` (GM only). */
export interface FoundryState {
  worldPath: string;
  lastScan?: { ts: Timestamp; worldId: string; fingerprint: string };
  lastImport?: {
    ts: Timestamp;
    worldId: string;
    worldTitle: string;
    fingerprint: string;
    pcMode: 'replace' | 'merge';
    counts: { pcs: number; npcs: number; maps: number; journals: number; tracks: number };
  };
}

/** A player's Chummer re-import waiting for the GM. */
export interface ChummerRequest {
  id: string;
  ts: Timestamp;
  actorId: ActorId;
  actorName: string;
  userId: UserId;
  userName: string;
  fileName: string;
  /** Raw .chum5 — server state only (stripped from every view). */
  xml?: string;
  /** Chummer portraits detached from the file (upload URLs). */
  mugshots?: string[];
  /** Merge diff (server/lib/chummer/merge.js). */
  diff: unknown;
  /** French summary. */
  summary: string;
  summaryI18n?: I18nMessage[];
  warnings?: string[];
  warningsI18n?: I18nMessage[];
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  resolvedAt?: Timestamp;
  /** GM's note when resolving. */
  gmNote?: string;
}

/** `state.chummer`. Players see their own requests only. */
export interface ChummerState {
  allowPlayerImport: boolean;
  pending: ChummerRequest[];
}

// =====================================================================================================================
// Catalog (data/catalog/<file>.json, generated from Chummer data by tools/build-catalog.ts)
// =====================================================================================================================

export type CatalogFile =
  | 'weapons' | 'armor' | 'gear' | 'cyberware' | 'bioware' | 'vehicles' | 'qualities' | 'spells' | 'powers' | 'programs'
  | 'lifestyles' | 'accessories' | 'armormods' | 'vehiclemods' | 'lifestylequalities' | 'martialarts';

/** Value that may be a Chummer formula string ('Rating * 2', 'FixedValues(1,2,3)'). */
export type Formula = number | string;

/** Attribute / initiative bonus of a catalog entry (formulas in Rating). */
export interface CatalogBonus {
  attributes?: Partial<Record<AttrKey, Formula>>;
  /** Armor of an implant (Dermal Plating). */
  armor?: Formula;
  initiativeDice?: Formula;
  initiative?: Formula;
}

/** Weapon profile embedded in gear / 'ware (implant weapons, grenades). */
export interface CatalogWeaponProfile {
  name?: string;
  type: 'melee' | 'ranged';
  skill: string;
  accuracy: Formula;
  damage: string;
  ap: Formula;
  rc?: number;
  mode?: string;
  ammo?: string;
  reach?: number;
  conceal?: number;
}

/** Requirements / exclusions of an upgrade (any listed value matches; `*Contains` = substring). */
export interface CatalogFitRule {
  names?: string[];
  namesContains?: string[];
  categories?: string[];
  categoriesContains?: string[];
  types?: string[];
}

export interface WeaponStats {
  type: 'melee' | 'ranged';
  skill: string;
  accuracy: Formula;
  damage: string;
  ap: Formula;
  mode?: string;
  rc?: number;
  ammo?: string;
  conceal?: number;
  reach?: number;
  mounts?: MountPoint[];
  /** Accessories delivered with the weapon. */
  included?: Array<{ id?: string; name: string }>;
}

export interface ArmorStats {
  armor: Formula;
  capacity?: number;
  stack?: boolean;
}

export interface GearStats {
  /** Sold per pack of N units (ammunition). */
  costFor?: number;
  weapon?: CatalogWeaponProfile;
  capacity?: string;
  deviceRating?: Formula;
  /** Cyberdecks: [attack, sleaze, dataProcessing, firewall]. */
  attributeArray?: number[];
  attack?: number;
  sleaze?: number;
  dataProcessing?: number;
  firewall?: number;
  programs?: number;
}

export interface WareStats {
  kind: WareKind;
  bonus?: CatalogBonus;
  /** Capacity cost '[3]'. */
  capacity?: string;
  weapon?: CatalogWeaponProfile;
  geneware?: boolean;
}

export interface VehicleStats {
  handling: Formula;
  speed: Formula;
  accel: Formula;
  body: number;
  armor: number;
  pilot: number;
  sensor: number;
  seats?: number;
  drone?: boolean;
  /** Drones: extra slots (one pool = Body + modSlots). */
  modSlots?: number;
  /** Other vehicles: extra slots per category pool. */
  slotBonus?: Partial<Record<'Powertrain' | 'Protection' | 'Weapons' | 'Body' | 'Electromagnetic' | 'Cosmetic', number>>;
}

export interface QualityStats {
  karma: number;
  positive: boolean;
  maxLevels?: number;
  metagenic?: boolean;
  chargenOnly?: boolean;
}

export interface SpellStats {
  /** 'M' | 'P'. */
  type: string;
  range: string;
  duration: string;
  /** Drain value 'F-3'. */
  dv: string;
  descriptor?: string;
  damage?: string;
}

export interface PowerStats {
  /** Power points (per level). */
  points: number;
  levels?: boolean;
  maxLevels?: number;
  action?: string;
  /** Extra PP on the first level. */
  extrapointcost?: number;
  bonus?: CatalogBonus;
}

export interface ProgramStats {
  program?: boolean;
}

export interface LifestyleStats {
  monthly?: boolean;
  /** Starting nuyen dice. */
  startingDice?: string;
  startingMultiplier?: number;
  lp?: number;
  /** Run Faster points [min, max]. */
  points?: Partial<Record<'comforts' | 'neighborhood' | 'security', [number, number]>>;
  pointCost?: Partial<Record<'comforts' | 'neighborhood' | 'security', number>>;
}

export interface AccessoryStats {
  /** Mount points it can use ([] = no mount needed). */
  mount: MountPoint[];
  extraMount?: MountPoint[];
  accuracy?: number;
  rc?: number;
  rcGroup?: number;
  conceal?: number;
  smartgun?: boolean;
  targetCost?: boolean;
  requires?: CatalogFitRule;
  forbids?: CatalogFitRule;
}

export interface ArmorModStats {
  capacity: Formula;
  armor?: number;
  bonus?: Partial<Record<ArmorModBonusKey, Formula>>;
  targetCost?: boolean;
}

export interface VehicleModStats {
  slots: Formula;
  /** Max rating from the vehicle. */
  ratingVar?: 'Body' | 'Seats' | 'qty';
  bonus?: Partial<Record<VehicleStatKey, Formula>>;
  requires?: CatalogFitRule;
  forbids?: CatalogFitRule;
  targetCost?: boolean;
}

export interface LifestyleQualityStats {
  monthly?: boolean;
  /** Percent. */
  multiplier?: number;
  baseOnly?: boolean;
  lp?: number;
  /** Base lifestyles it is allowed on. */
  allowed?: string[];
  multiple?: boolean;
  selectText?: boolean;
  comforts?: number;
  security?: number;
  neighborhood?: number;
  forbids?: string[];
  requiresOneOf?: string[];
  requiresLifestyle?: string[];
}

export interface MartialArtCatalogTechnique {
  id: string;
  name: string;
  nameFr?: string;
  source: string;
  page: number;
  effects?: Effect[];
}

export interface MartialArtStats {
  karma: number;
  techniqueKarma: number;
  techniques: MartialArtCatalogTechnique[];
}

/** `stats` of each catalog file. */
export interface CatalogStatsByFile {
  weapons: WeaponStats;
  armor: ArmorStats;
  gear: GearStats;
  cyberware: WareStats;
  bioware: WareStats;
  vehicles: VehicleStats;
  qualities: QualityStats;
  spells: SpellStats;
  powers: PowerStats;
  programs: ProgramStats;
  lifestyles: LifestyleStats;
  accessories: AccessoryStats;
  armormods: ArmorModStats;
  vehiclemods: VehicleModStats;
  lifestylequalities: LifestyleQualityStats;
  martialarts: MartialArtStats;
}
export type CatalogStats = CatalogStatsByFile[CatalogFile];

/** One catalog entry. `S` = the file's stats type (CatalogItem<WeaponStats>, or CatalogEntry<'weapons'>). */
export interface CatalogItem<S = CatalogStats> {
  /** Chummer GUID. */
  id: string;
  /** English name. */
  name: string;
  nameFr?: string;
  category: string;
  categoryFr?: string;
  /** ¥ (absent for qualities, spells, powers, martial arts). */
  cost?: number | null;
  costFormula?: string;
  /** Variable cost range [min, max]. */
  costRange?: [number, number];
  /** '8R' (upgrade catalogs: '+2R' when availRelative). */
  avail?: string;
  availValue?: number;
  availFormula?: string;
  legality?: Legality;
  /** Added to the target's availability (upgrade catalogs). */
  availRelative?: boolean;
  rating?: { min: number; max: number };
  /** 'ware: essence cost (number or formula). */
  essence?: Formula;
  /** 'ware: grades allowed besides the defaults. */
  grades?: WareGrade[];
  source: string;
  page: number;
  /** Absent on many gear entries. */
  stats?: S;
  effects?: Effect[];
}
export type CatalogEntry<F extends CatalogFile> = CatalogItem<CatalogStatsByFile[F]>;

/** data/catalog/index.json. */
export interface CatalogIndex {
  generated: string;
  source: string;
  files: Array<{ name: CatalogFile; count: number; bytes: number; categories: Array<{ name: string; nameFr?: string; count: number }> }>;
}

// =====================================================================================================================
// Modifiers (catalog effects → rolls, limits, derived values) — shared/modifiers.js
// =====================================================================================================================

export type EffectType =
  | 'limit' | 'skill' | 'skillCategory' | 'skillGroup' | 'skillAttribute' | 'attribute' | 'attributeMax' | 'initiativeDice' | 'initiative'
  | 'matrixInitiativeDice' | 'armor' | 'monitor' | 'stat' | 'resist' | 'accuracy' | 'matrixAction' | 'flag' | 'choice' | 'info'
  | 'unsupported' | 'allTests' | 'chargen' | 'personaAttribute';

/** Normalized Chummer <bonus> effect of a catalog entry (data/catalog/effects.json, tools/lib/bonus-effects.ts). */
export interface Effect {
  type: EffectType;
  target?: string;
  /** Number or formula with Rating ('immune' on resist effects). */
  value?: Formula | null;
  /** Condition key ('visible', 't-urban', 'spell-combat'…). */
  condition?: string;
  choice?: { kind: 'skill' | 'text' | 'matrixAction' | 'attribute' | 'limit'; limitTo?: string[]; categories?: string[] };
  /** From <wirelessbonus>. */
  wireless?: boolean;
  /** Chummer tag (absent from effects.json entries). */
  tag?: string;
  note?: string;
  /** Skills / tests the effect does not apply to. */
  exclude?: string[];
}

/** Modifier types: catalog effect types plus the ones shared/modifiers.ts makes (weapon accessories, afflictions). */
export type ModifierType = EffectType | 'weaponPool' | 'woundFactor';

/** A modifier collected from an actor's items (collectModifiers). */
export interface Modifier {
  /** 'list:itemId[:subId]:i'. */
  id: string;
  source: {
    list: string;
    itemId: string;
    subId?: string;
    name: string;
    nameFr?: string;
    parentName?: string;
    catalogId?: string;
    book?: string;
    page?: number | string;
  };
  type: ModifierType;
  target: string | null;
  /** Rating resolved; null = could not be evaluated (shown only). */
  value: number | null;
  condition: string | null;
  wireless?: boolean;
  /** The effect's « select… » definition (the pick is the item's `choice`). */
  choice?: Effect['choice'];
  note?: string;
  immune?: boolean;
  /** Already counted in actor.augmented / actor.initiative. */
  baked?: boolean;
  /** An attribute / initiative bonus the stored values do not contain (« non compté »). */
  unbaked?: boolean;
  /** Shown, not applied. */
  info?: boolean;
  needsChoice?: boolean;
  exclude?: string[];
}

/** conditionState(): 'na' not relevant to this test, 'auto' always on, 'on' / 'off' by its switch. */
export type ConditionState = 'na' | 'auto' | 'on' | 'off';

// =====================================================================================================================
// Rulebooks (GET /api/books) — owner: 90-books.js
// =====================================================================================================================

export interface BookOffset {
  fromPrinted: number;
  offset: number;
}

export interface BookListEntry {
  code: string;
  name: string;
  nameFr?: string;
  /** PDF page count. */
  pages: number;
  /** PDF page = printed page + offset. */
  offset: number;
  offsets?: BookOffset[];
  indexed: boolean;
  /** Not a Chummer book. */
  extra?: boolean;
  /** Signed PDF link. */
  url: string;
  exp: Timestamp;
  /** Cache key / ETag of the PDF. */
  version: string;
  /** Bytes. */
  size: number;
}

export interface BooksResponse {
  books: BookListEntry[];
  ttl: number;
  /** Server clock (ms). */
  now: Timestamp;
  /** '/vendor/pdfjs/<version>'. */
  pdfjs: string;
}

// =====================================================================================================================
// Table state & client view
// =====================================================================================================================

/**
 * One table's full state (`ctx.state`, `state.json`). `emptyState()` only holds version/config/users/actors/log; every
 * other slice is created by its module's init() at boot, so after boot all of them exist.
 */
export interface TableState {
  version: number;
  config: TableConfig;
  users: Record<UserId, User>;
  /** Session token → user id ('gm' for the GM). Never sent. */
  sessions: Record<string, UserId>;
  actors: Record<ActorId, Actor>;
  /** Max 600 entries. */
  log: LogEntry[];
  ui: { announcement: string | null };
  scene: SceneState;
  maps: Record<MapId, GameMap>;
  bestiary: Record<string, Template>;
  /** Seed template ids the GM deleted (never re-seeded). */
  bestiaryRemoved: string[];
  combat: CombatState;
  attacks: AttacksState;
  shop: ShopState;
  training: TrainingState;
  audio: AudioState;
  campaign: Campaign;
  notes: NotesState;
  matrix: MatrixState;
  magic: MagicState;
  chargen: ChargenState;
  foundry: FoundryState;
  chummer: ChummerState;
  city: CityState;
}

/**
 * The state as one user receives it (`game` in client components, built by buildView + module filters). The GM view is
 * the full state minus sessions/config (plus a few trims); a player view drops GM data and filters each slice — the
 * unions below cover both. Slices a player never receives are optional.
 */
export interface GameView {
  version: number;
  config: ViewConfig;
  me: ViewMe;
  users: Record<UserId, ViewUser>;
  /** Connected user ids. */
  online: UserId[];
  /** Players: own and other PCs (without gmNotes; other PCs without notes), visible NPCs as stubs. */
  actors: Record<ActorId, ViewActor>;
  /** Players: no gmOnly entries, whispers only when addressed to them. */
  log: LogEntry[];
  ui: { announcement: string | null };
  scene: SceneState;
  /** Players: only the shown map, masked. */
  maps: Record<MapId, GameMap>;
  /** GM only. */
  bestiary?: Record<string, Template>;
  /** GM only. */
  bestiaryRemoved?: string[];
  combat: CombatState;
  attacks: AttacksView;
  shop: ShopState;
  training: TrainingState;
  audio: AudioState;
  campaign: Campaign | PlayerCampaignView;
  notes: NotesView;
  matrix: MatrixView;
  magic: MagicView;
  chargen: ChargenState;
  /** GM only. */
  foundry?: FoundryState;
  chummer: ChummerState;
  /** Built by the city module for everyone (state.city is never sent as is). */
  city: CityView;
  /** Players: maps of their runners' homes and of the homes they were invited to (GM: in `maps`). */
  homeMaps?: Record<MapId, GameMap>;
}

// =====================================================================================================================
// Server: action context and module contract (ARCHITECTURE.md « Server module contract »)
// =====================================================================================================================

/** Target of a transient event. */
export type EmitTarget = 'all' | 'gm' | 'players' | UserId | UserId[];

/** A log entry as passed to ctx.log(): id/ts are added, kind defaults to 'system', `text` is filled from `i18n` when omitted. */
export type NewLogEntry = Omit<LogEntry, 'id' | 'ts' | 'kind' | 'text' | 'author'> & {
  kind?: LogKind;
  author?: string;
  text?: string;
  id?: string;
  ts?: Timestamp;
};

/** `ctx`: what an action handler receives. Handlers are synchronous and mutate `ctx.state`; the core saves and broadcasts. */
export interface ActionContext {
  state: TableState;
  user: SessionUser;
  isGM: boolean;
  tableId: string;
  table: TableInfo;
  /** GM, or the player controls that actor. */
  owns(actorId: ActorId): boolean;
  /** Throws: the client gets the text plus `errorKey` / `params` and shows it translated. */
  fail(msg: string, params?: I18nParams): never;
  /** Appends to state.log (max 600) and returns the stored entry. */
  log(entry: NewLogEntry): LogEntry;
  /** Transient event (not stored). */
  emitTo<E extends keyof ServerEvents>(target: EmitTarget, event: E, data: ServerEvents[E]): void;
  /** New id `<prefix>_…`. */
  uid(prefix?: string): string;
  /** Time the action started. */
  now: Timestamp;
  /** Name of the user's main character (or their name; 'MJ' for the GM). */
  displayName(): string;
  /** Table language, only for texts that must be stored pre-rendered (rare). */
  lang: Lang;
  t(key: string, params?: I18nParams): string;
}

/** Action payload: a plain object sent by the client (validate everything coming from players). */
export type ActionPayload = Record<string, unknown>;

/**
 * One action of a module (`'<module>/<verb>'`). Declared with method syntax so a module may type its payload more
 * narrowly than ActionPayload.
 */
export interface ActionDef {
  /** 'gm' (default) or 'any'. */
  role?: 'gm' | 'any';
  /** Return value is sent back to the caller (send() resolves with it). */
  handler(ctx: ActionContext, payload: ActionPayload): unknown;
}

/** Second argument of init(). */
export interface InitOptions {
  /** Read a JSON file of the table's content pack (relative to seedDir). */
  readSeed<T = unknown>(name: string, fallback: T): T;
  /** Folder of the content pack (a pack built on a base pack runs every init once per folder, base first). */
  seedDir: string;
  tableId: string;
  table: TableInfo;
}

/** A player's / GM's request as resolved by requireUser / requireGM (req.user). */
export type RequestUser = SessionUser;

/** Result of runAction()/simulateAction() and the socket 'action' ack. */
export type ActionResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; errorKey?: string; params?: I18nParams; code?: string };

/**
 * Helpers passed to routes(). Generic in the HTTP middleware type: the app has no Express types yet, so the server can
 * instantiate it once it does (`RouteHelpers<RequestHandler>`).
 */
export interface RouteHelpers<Middleware = unknown> {
  requireGM: Middleware;
  requireUser: Middleware;
  /** State of the request's table (or of the running action's table). */
  getState(req?: unknown): TableState | null;
  scheduleBroadcast(req?: unknown): void;
  emitTo<E extends keyof ServerEvents>(target: EmitTarget, event: E, data: ServerEvents[E]): void;
  addLog(entry: NewLogEntry): LogEntry | null;
  saveSoon(): void;
  /** Multi-table internals (tables registry, openTable, initModules…), used by admin-like routes. */
  tableApi: TableApi;
  runAction(table: unknown, user: SessionUser, type: string, payload: ActionPayload): ActionResponse;
  simulateAction(table: unknown, user: SessionUser, type: string, payload: ActionPayload, state?: TableState): ActionResponse & { state: TableState };
  actions: Record<string, ActionDef>;
}

/** A server module `server/modules/NN-name.(js|ts)`, auto-loaded in filename order. `App` = the HTTP app type. */
export interface ServerModule<App = unknown, Middleware = unknown> {
  name: string;
  /** Every boot (and after reset/import): create missing slices, merge seeds by id (add missing only). */
  init?(state: TableState, opts: InitOptions): void;
  actions?: Record<string, ActionDef>;
  /** Players: mutate the view (a deep clone, already without sessions/config/gm-only log). Runs in module order. */
  filter?(view: GameView, user: SessionUser, fullState: TableState): void;
  /** GM: trim heavy or useless data. */
  gmFilter?(view: GameView, user: SessionUser, fullState: TableState): void;
  routes?(app: App, helpers: RouteHelpers<Middleware>): void;
}

// =====================================================================================================================
// Transient socket events (server → client; never stored)
// =====================================================================================================================

/** Standard sfx ids (any module may emit them; synth presets add more). */
export type SfxId =
  | 'dice' | 'door-open' | 'door-close' | 'door-locked' | 'gunshot-pistol' | 'gunshot-rifle' | 'gunshot-auto' | 'explosion' | 'hit-melee'
  | 'glass-break' | 'alarm' | 'footsteps' | 'notify' | 'matrix-glitch' | 'spell-cast' | 'heal' | 'death' | 'cash' | 'level-up' | 'ping'
  | (string & {});

export interface ServerEvents {
  /** Fresh view after every action (debounced 30 ms). */
  state: GameView;
  sfx: { id: SfxId; volume?: number };
  ping: { mapId: MapId; x: number; y: number; userId: UserId; name: string };
  'audio-stop': Record<string, never>;
  'shop:resolved': { orderId: string; status: OrderStatus; note: string };
  'chargen:resolved': { draftId: string; status: DraftStatus; note: string; actorId?: ActorId };
  'notes:comment': { pageId: string; title: string; author: string };
  /** Session rejected; reason 'demo-reset' after a demo table reset. */
  unauthorized: { reason?: string } | undefined;
  'assistant:step': { conversationId: string; phase: 'thinking' | 'message' | 'tools' };
  'assistant:delta': { conversationId: string; text: string };
  'assistant:done': { conversationId: string };
  /** A handout was revealed to the player. */
  'campaign/handout': { id: string; title: string };
  /** Foundry import: audio copy progress (GM). */
  'foundry/audio': { total?: number; done?: number; bytes?: number; running: boolean; errors?: unknown[]; error?: string };
}
