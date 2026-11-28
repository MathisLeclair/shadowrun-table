// Inventory realism rules (pure: no imports, loaded by the characters server module AND the sheet UI).
// Ammunition (capacity / reload type / loaded rounds / fire modes and their round counts), reloading from the inventory,
// equipped weapons, containers (« Sur soi », bags, vehicles, safehouses) and item locations. See ARCHITECTURE.md « Inventaire ».
// Labels are English UI keys here; the UI renders them with t().

import type { AmmoKind, Container, ContainerKind, Weapon } from '../../../shared/types.ts';

/** A weapon as these rules read it: stored weapons, launcher profiles, catalog-built stand-ins (every field optional). */
export type WeaponLike = Partial<Weapon>;
/** Raw actor / item data (imports, payloads, old saves) fixed up in place: any shape until normalized. */
export type RawData = any;
/** Id factory of the caller: makeId('ct') → 'ct_…'. */
export type MakeId = (prefix: string) => string;
/** What the inventory rules read of an actor. */
export interface InventoryActor {
  /** Any actor (an NPC stub has no inventory: no weapons, no containers). */
  id?: string;
  weapons?: WeaponLike[];
  containers?: Container[];
}
/** One fire option (SR5 p. 180). */
export interface FireOption {
  id: string;
  mode: string;
  rounds: number;
  action: 'simple' | 'complex';
  /** Defense modifier of the target; null = suppressive fire (no defense test). */
  defense: number | null;
  label: string;
}
/** What an inventory item is for reloading (ammoInfo). */
export interface AmmoInfo {
  kind: 'ammo' | 'clip' | 'loader';
  cls: string;
  restrict?: string;
  forWeapon?: string;
}
/** A round a grenade launcher can fire (launcherRounds). */
export interface LauncherRound {
  id: string;
  w: WeaponLike;
  sheet: boolean;
  loaded: boolean;
}
/** One reload action (reloadPlan). */
export interface ReloadPlan {
  action: 'simple' | 'complex';
  perAction: number;
  swap: boolean;
}

/** Marker for the i18n checker (UI keys rendered with t() by the UI). */
const tk = (s: string): string => s;

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const isObj = (v: unknown): v is RawData => !!v && typeof v === 'object' && !Array.isArray(v);
/** Lower-case, no accents, single spaces: for name / category comparisons. */
export const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Ammunition: capacity and reload type
// ---------------------------------------------------------------------------
/** Reload type codes (Chummer « 15(c) »; Foundry clip types converted by convert-actor.js) → canonical code. */
const CLIP_CODES: Record<string, string> = { c: 'c', m: 'm', b: 'b', d: 'd', cy: 'cy', belt: 'belt', ceinture: 'belt', tambour: 'd', drum: 'd', ml: 'ml', cb: 'cb', lourd: 'belt', heavy: 'belt' };
/** Display keys of the reload types. */
export const AMMO_TYPE_LABELS: Record<string, string> = {
  c: tk('removable clip'), m: tk('internal magazine'), b: tk('break action'), d: tk('drum'), cy: tk('cylinder'), belt: tk('belt'), ml: tk('muzzle loader'), cb: tk('removable clip'),
};

/** '15(c)' → { max: 15, type: 'c' }; '42(c) or 21(c)' → first value; '14' → { max: 14, type: '' }; '' / 'Energy' → { max: 0, type: '' }. */
export function parseAmmo(ammo: unknown): { max: number; type: string } {
  const s = String(ammo ?? '').trim();
  const m = /^(\d+)\s*(?:x\s*\d+\s*)?(?:\(\s*([a-zé]+)\s*\))?/i.exec(s);
  if (!m) return { max: 0, type: '' };
  return { max: Math.max(0, Math.min(999, Number(m[1]) || 0)), type: CLIP_CODES[String(m[2] || '').toLowerCase()] || '' };
}

// ---------------------------------------------------------------------------
// Fire modes (SR5 p. 179-180)
// ---------------------------------------------------------------------------
/** Weapon mode codes: Chummer / catalog English (SS SA BF FA) and Foundry / French (CC SA TR TA, RA). */
const MODE_ALIASES: Record<string, string> = { SS: 'SS', CC: 'SS', SA: 'SA', BF: 'BF', TR: 'BF', FA: 'FA', TA: 'FA', RA: 'FA' };
/** Short code of a mode in French (SR5 FR: CC, SA, TR, TA). English uses the canonical code. */
export const MODE_SHORT_FR: Record<string, string> = { SS: 'CC', SA: 'SA', BF: 'TR', FA: 'TA' };
/**
 * Fire options: rounds used, action, defense modifier of the target (SR5 p. 180). SA burst = 3 rounds (SR5: « Semi-Automatic Burst »).
 * Suppressive fire: 20 rounds, no defense modifier (the target area is « suppressed »).
 */
export const FIRE_OPTIONS: FireOption[] = [
  { id: 'SS', mode: 'SS', rounds: 1, action: 'simple', defense: 0, label: tk('Single shot') },
  { id: 'SA', mode: 'SA', rounds: 1, action: 'simple', defense: 0, label: tk('Semi-automatic') },
  { id: 'SB', mode: 'SA', rounds: 3, action: 'complex', defense: -2, label: tk('Semi-automatic burst') },
  { id: 'BF', mode: 'BF', rounds: 3, action: 'simple', defense: -2, label: tk('Burst fire') },
  { id: 'LB', mode: 'BF', rounds: 6, action: 'complex', defense: -5, label: tk('Long burst') },
  { id: 'FA', mode: 'FA', rounds: 6, action: 'simple', defense: -5, label: tk('Full auto (Simple Action)') },
  { id: 'FAC', mode: 'FA', rounds: 10, action: 'complex', defense: -9, label: tk('Full auto (Complex Action)') },
  { id: 'SUP', mode: 'FA', rounds: 20, action: 'complex', defense: null, label: tk('Suppressive fire') },
];
export const FIRE_BY_ID: Record<string, FireOption> = Object.fromEntries(FIRE_OPTIONS.map((o) => [o.id, o]));

/** Canonical modes of a weapon, in its own order: 'SA/TR/TA' → ['SA', 'BF', 'FA']. */
export function weaponModes(w: WeaponLike | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(w?.mode ?? '').toUpperCase().split(/[^A-Z]+/)) {
    const m = MODE_ALIASES[part];
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Fire options a weapon allows (first = default: the weapon's first mode). A weapon without mode fires single shots. */
export function fireOptions(w: WeaponLike | null | undefined): FireOption[] {
  const modes = weaponModes(w);
  if (!modes.length) return [FIRE_BY_ID.SS];
  const out: FireOption[] = [];
  for (const m of modes) for (const o of FIRE_OPTIONS) if (o.mode === m) out.push(o);
  return out;
}

/** Rounds a fire option uses (unknown option → the weapon's default). */
export function roundsFor(w: WeaponLike | null | undefined, optionId?: string | null): number {
  const opts = fireOptions(w);
  return (opts.find((o) => o.id === optionId) || opts[0]).rounds;
}

/** « Mains nues »: always ready, never stowed. */
export function isUnarmed(w: WeaponLike | null | undefined): boolean {
  return !!w && w.kind === 'melee' && (w.skill === 'unarmed_combat' && !w.catalogId) && /^(mains nues|unarmed|unarmed attack)$/i.test(String(w.name || '').trim());
}

const namesOf = (w: WeaponLike | null | undefined): string[] => [w?.name, w?.nameEn, w?.nameFr].filter(Boolean).map(String);

/**
 * Launcher ammunition profile listed as a weapon (Chummer « Minigrenade: High Explosive », heavy weapons): the stats of a round the
 * grenade launcher fires. Never consumed itself (the launcher's magazine is), never counted as a ready weapon.
 */
export function isLauncherProfile(w: WeaponLike | null | undefined): boolean {
  if (!w || w.kind === 'melee') return false;
  return namesOf(w).some((n) => /^\s*mini ?-?grenade/i.test(n));
}

/**
 * Catalog minigrenades (data/catalog/gear.json, SR5 p. 435) a grenade launcher can fire when the sheet lists no profile for them.
 * The Hornet Direct-Fire round is left out: it is a direct hit, not an area round.
 */
export const MINIGRENADES = [
  { catalogId: 'daecdfc8-15d5-4864-9e20-13e4a0dca88e', name: 'Minigrenade: High Explosive', nameFr: 'Mini-Grenades hautement explosive', damage: '16P (-2/m)', ap: -2 },
  { catalogId: '8e1583bf-4cc5-4498-a800-36cb61d3fb27', name: 'Minigrenade: Fragmentation', nameFr: 'Mini-Grenades à fragmentation', damage: '18P(f) (-1/m)', ap: 5 },
  { catalogId: 'f092fca8-46a9-4351-a06a-362846e6546a', name: 'Minigrenade: Flash-Bang', nameFr: 'Mini-Grenades Flashbang', damage: '10S (10m Radius)', ap: -4 },
  { catalogId: '74284124-57a0-479b-9ab1-3433bdb9e3b7', name: 'Minigrenade: Gas', nameFr: 'Mini-Grenades à gaz', damage: 'Chemical (10m Radius)', ap: 0 },
  { catalogId: '7c00891f-6554-497d-9726-058d7c4a598e', name: 'Minigrenade: Flash-Pak', nameFr: 'Mini-Grenades Flash-pak', damage: 'Special', ap: 0 },
  { catalogId: 'b6381691-1a96-4299-b9df-129ffee64c45', name: 'Minigrenade: Smoke', nameFr: 'Mini-Grenades fumigène', damage: '(10m Radius)', ap: 0 },
  { catalogId: 'e2252b3c-1bae-496e-adbb-f1c3d6e0b32b', name: 'Minigrenade: Thermal Smoke', nameFr: 'Mini-Grenades fumigène infrarouge', damage: '(10m Radius)', ap: 0 },
];

/**
 * Rounds a grenade launcher can fire, best guess first: [{ id, w (weapon-like stats for blastOf), loaded, sheet }].
 * The sheet's « Minigrenade: … » profiles (Chummer stats), then the catalog minigrenades the sheet does not list; the round matching the
 * launcher's loaded ammunition (ammoKind) comes first. id = the profile's weapon id, or the catalog id.
 */
export function launcherRounds(actor: InventoryActor | null | undefined, launcher: WeaponLike | null | undefined): LauncherRound[] {
  const kind = launcher?.ammoKind || null;
  const matches = (w: WeaponLike, catalogId: string | undefined): boolean => !!kind && ((kind.catalogId && catalogId && kind.catalogId === catalogId) || namesOf(w).some((n) => norm(n) === norm(kind.name) || (kind.nameFr && norm(n) === norm(kind.nameFr))));
  const sheet: LauncherRound[] = (actor?.weapons || []).filter((w) => isLauncherProfile(w)).map((w) => ({ id: w.id as string, w, sheet: true, loaded: matches(w, w.catalogId) }));
  const listed = new Set(sheet.flatMap((r) => namesOf(r.w).map(norm)));
  const catalog = MINIGRENADES.filter((m) => !listed.has(norm(m.name)) && !listed.has(norm(m.nameFr))).map((m): LauncherRound => {
    const w: WeaponLike = { kind: 'ranged', skill: 'heavy_weapons', catalogId: m.catalogId, name: m.name, nameFr: m.nameFr, damage: m.damage, ap: m.ap };
    return { id: m.catalogId, w, sheet: false, loaded: matches(w, m.catalogId) };
  });
  const all = [...sheet, ...catalog];
  return [...all.filter((r) => r.loaded), ...all.filter((r) => !r.loaded)];
}

/**
 * Single-use thrown explosive (hand grenade: throwing skill or no skill, name / category « grenade » / « explosive »): throwing it uses
 * one unit (qty), its ammunition is never tracked (Chummer gives hand grenades « <ammo>1</ammo> »). Launcher profiles and weapons of
 * another skill (grenade launchers) are not.
 */
export function isThrownExplosive(w: WeaponLike | null | undefined): boolean {
  if (!w || w.kind === 'melee' || isLauncherProfile(w)) return false;
  if (w.skill && w.skill !== 'throwing_weapons') return false;
  return /grenade|explosi/i.test(`${namesOf(w).join(' ')} ${w.category || ''} ${w.categoryEn || ''}`);
}

/** Ranged weapon with a magazine (rounds are tracked). Hand grenades never are. */
export function usesAmmo(w: WeaponLike | null | undefined): boolean {
  return !!w && w.kind !== 'melee' && num(w.ammoMax) > 0 && !isThrownExplosive(w);
}

/** Single-use thrown explosive: firing it consumes the item (qty). Same as isThrownExplosive. */
export function isGrenade(w: WeaponLike | null | undefined): boolean {
  return isThrownExplosive(w);
}

/** Ranged firearm-like weapon (not thrown, not a grenade, not a launcher profile): counts in the « ready » soft limit. */
export function isRangedArm(w: WeaponLike | null | undefined): boolean {
  return !!w && w.kind !== 'melee' && !isGrenade(w) && !isLauncherProfile(w) && w.skill !== 'throwing_weapons';
}

// ---------------------------------------------------------------------------
// Ammunition in the inventory
// ---------------------------------------------------------------------------
/**
 * Ammunition class of a weapon (Chummer <ammoforweapontype> values): 'gun' (firearms), 'bow', 'crossbow', 'taser', 'glauncher',
 * 'mlauncher', 'cannon', 'netgun', 'grapplegun', 'flaregun', 'dartgun', 'gyrojet', 'spraypen'.
 */
export function weaponAmmoClass(w: WeaponLike | null | undefined): string {
  const s = norm(`${w?.name || ''} ${w?.nameEn || ''} ${w?.nameFr || ''} ${w?.category || ''} ${w?.categoryEn || ''} ${w?.categoryFr || ''}`);
  if (/taser|impulsion electrique|shocker/.test(s)) return 'taser';
  if (/crossbow|arbalete/.test(s)) return 'crossbow';
  if (/\bbows?\b|\barcs?\b/.test(s)) return 'bow';
  if (/grenade/.test(s)) return 'glauncher';
  if (/missile|rocket|roquette/.test(s)) return 'mlauncher';
  if (/assault cannon|canons? d'assaut/.test(s)) return 'cannon';
  if (/net ?gun|lance filet/.test(s)) return 'netgun';
  if (/grapple|grappin/.test(s)) return 'grapplegun';
  if (/flare|detresse/.test(s)) return 'flaregun';
  if (/dart ?gun|flechette/.test(s)) return 'dartgun';
  if (/gyrojet/.test(s)) return 'gyrojet';
  if (/spray|squirt|pepper punch/.test(s)) return 'spraypen';
  return 'gun';
}

/** Chummer <ammoforweapontype> → app ammo class (unknown values kept as they are). */
const AMMO_FOR: Record<string, string> = { gun: 'gun', bow: 'bow', crossbow: 'crossbow', taser: 'taser', glauncher: 'glauncher', microglauncher: 'glauncher', torpglauncher: 'glauncher', mlauncher: 'mlauncher', cannon: 'cannon', netgun: 'netgun', netgunxl: 'netgun', grapplegun: 'grapplegun', flaregun: 'flaregun', dartgun: 'dartgun', gyrojet: 'gyrojet', spraypen: 'spraypen' };

const AMMO_NAME = /^(ammo|mun\.?|munitions?|arrow|fleche|bolt|carreau|minigrenade|mini grenade|rocket|roquette|missile|harpoon|harpon|net gun reload|xl net gun reload|recharge de lance filet)\b/;
const CLIP_NAME = /\b(spare clip|chargeur supplementaire|spare magazine|spare drum)\b/;
const LOADER_NAME = /\b(speed ?loader|chargeur rapide)\b/;

/** Text in parentheses at the end: 'Ammo: APDS (Sniper Rifles)' → 'Sniper Rifles'. */
function suffix(s: unknown): string {
  const m = /\(([^()]+)\)\s*$/.exec(String(s || '').trim());
  return m ? m[1].trim() : '';
}

/**
 * What an inventory item is for reloading: null (not ammunition) or { kind: 'ammo'|'clip'|'loader', cls, restrict?, forWeapon? }.
 * Reads the stored name, the English / French catalog names, Foundry's original name kept in `notes` and Chummer's `choice`
 * (<extra>: weapon category of an ammo box, weapon of a spare clip) and `ammoFor` (Chummer <ammoforweapontype>).
 */
export function ammoInfo(g: unknown): AmmoInfo | null {
  if (!isObj(g)) return null;
  const names = [g.name, g.nameEn, g.nameFr, g.notes].filter(Boolean).map(String);
  const all = names.map(norm);
  const extra = String(g.choice || '').trim();
  if (all.some((n) => CLIP_NAME.test(n))) return { kind: 'clip', cls: 'gun', forWeapon: extra || names.map(suffix).find(Boolean) || '' };
  if (all.some((n) => LOADER_NAME.test(n))) return { kind: 'loader', cls: 'gun', forWeapon: extra || names.map(suffix).find(Boolean) || '' };
  const isAmmo = !!g.ammoFor || all.some((n) => AMMO_NAME.test(n));
  if (!isAmmo) return null;
  const s = all.join(' | ');
  let cls = AMMO_FOR[String(g.ammoFor || '').toLowerCase().split(',')[0]] || '';
  if (!cls) {
    if (/taser/.test(s)) cls = 'taser';
    else if (/(^| )(arrow|fleche)/.test(s)) cls = 'bow';
    else if (/(^| )(bolt|carreau)/.test(s)) cls = 'crossbow';
    else if (/minigrenade|mini grenade/.test(s)) cls = 'glauncher';
    else if (/rocket|roquette|missile/.test(s)) cls = 'mlauncher';
    else if (/assault cannon|canon d'assaut/.test(s)) cls = 'cannon';
    else if (/net ?gun|filet/.test(s)) cls = 'netgun';
    else if (/injection dart|flechettes? (a|d')injection/.test(s)) cls = 'dartgun';
    else if (/gyrojet/.test(s)) cls = 'gyrojet';
    else if (/flare|detresse/.test(s)) cls = 'flaregun';
    else cls = 'gun';
  }
  return { kind: 'ammo', cls, restrict: extra || names.map(suffix).find((x) => x && !/^\d/.test(x)) || '' };
}

const singular = (s: string): string => s.replace(/s\b/g, '');
/** Does a weapon category / name hint (« Sniper Rifles », « Heavy Pistols », « Shotguns ») fit this weapon? */
export function restrictionFits(restrict: unknown, w: WeaponLike): boolean {
  const r = norm(restrict);
  if (!r) return true;
  const cands = [w.category, w.categoryEn, w.categoryFr, w.name, w.nameEn, w.nameFr].filter(Boolean).map(norm);
  if (!cands.length) return true;
  return cands.some((c) => c === r || singular(c) === singular(r) || (c.length > 3 && r.length > 3 && (c.includes(r) || r.includes(c) || singular(c).includes(singular(r)))));
}

/** Can this inventory item's loose rounds go into this weapon? */
export function ammoFits(g: unknown, w: WeaponLike): boolean {
  const info = ammoInfo(g);
  if (!info || info.kind !== 'ammo') return false;
  if (info.cls !== weaponAmmoClass(w)) return false;
  // « (Sniper Rifles) », « Heavy Pistols »: firearm rounds are sold per weapon category; « (Bows) », « (Tasers) » only repeat the class.
  return info.cls !== 'gun' || restrictionFits(info.restrict, w);
}

/** Is this item a spare clip / magazine of this weapon (« Spare Clip (Ares Desert Strike) »; a generic spare clip fits any clip-fed weapon)? */
export function clipFits(g: unknown, w: WeaponLike, kind: AmmoInfo['kind'] = 'clip'): boolean {
  const info = ammoInfo(g);
  if (!info || info.kind !== kind) return false;
  if (!info.forWeapon) return true;
  const want = norm(info.forWeapon);
  return [w.name, w.nameEn, w.nameFr].filter(Boolean).map(norm).some((n) => n === want || n.includes(want) || want.includes(n));
}

/** Default loaded ammunition of a weapon class (« regular » rounds: catalog entries of data/catalog/gear.json). */
export const DEFAULT_AMMO: Record<string, AmmoKind> = {
  gun: { name: 'Ammo: Regular Ammo', nameFr: 'Mun. : Balles normales', catalogId: 'b2a0b340-c793-4322-8422-8b03d18a6fae' },
  taser: { name: 'Ammo: Taser Dart', nameFr: 'Mun. : Dards taser', catalogId: '8afe5065-5815-4a98-b047-2a7fed85db55' },
  bow: { name: 'Arrow: Standard', nameFr: 'Mun. : Flèches standard', catalogId: '9e7a685f-e612-4b6b-955c-a7bc42b23682' },
};
export function defaultAmmoKind(w: WeaponLike | null | undefined): AmmoKind | null {
  const d = DEFAULT_AMMO[weaponAmmoClass(w)];
  return d ? { ...d } : null;
}

/** Loaded ammunition descriptor from an inventory item: { name, nameFr?, catalogId? }. */
export function ammoKindOf(g: { name?: string; nameEn?: string; nameFr?: string; catalogId?: string }): AmmoKind {
  const out: AmmoKind = { name: String(g.nameEn || g.name || '').slice(0, 120) };
  const fr = g.nameFr || (g.nameEn && g.name !== g.nameEn ? g.name : '');
  if (fr) out.nameFr = String(fr).slice(0, 120);
  if (g.catalogId) out.catalogId = String(g.catalogId).slice(0, 80);
  return out;
}
export const sameAmmoKind = (a: AmmoKind | null | undefined, b: AmmoKind | null | undefined): boolean => !!a && !!b && (a.catalogId && b.catalogId ? a.catalogId === b.catalogId : norm(a.name) === norm(b.name));

/**
 * One reload action (SR5 p. 163 « Reloading Weapons »): { action: 'simple'|'complex', perAction (rounds one action loads), swap (clip change) }.
 * Removable clip with a spare clip for this weapon = clip change, full, counted as ONE Simple Action (simplification: SR5 has « remove clip »
 * and « insert clip » as a Simple Action each); drum / belt with a spare one = Complex Action, full. Without a spare (« Fill clip / belt /
 * drum »): AGI rounds per Complex Action. Break action: 2 rounds per Complex Action. Internal magazine, cylinder: AGI rounds per Complex
 * Action; cylinder + speed loader: Complex Action, full. Muzzle loader: 1 round per Complex Action. Bow / crossbow / no type: Simple Action, full.
 */
export function reloadPlan(w: WeaponLike | null | undefined, { agi = 3, clip = false, loader = false }: { agi?: number; clip?: boolean; loader?: boolean } = {}): ReloadPlan {
  const t = w?.ammoType || '';
  const cls = weaponAmmoClass(w || {});
  const byHand: ReloadPlan = { action: 'complex', perAction: Math.max(1, agi), swap: false };
  if (t === 'c' || t === 'cb') return clip ? { action: 'simple', perAction: Infinity, swap: true } : byHand;
  if (t === 'd' || t === 'belt') return clip ? { action: 'complex', perAction: Infinity, swap: true } : byHand;
  if (t === 'b') return { action: 'complex', perAction: 2, swap: false };
  if (t === 'm') return byHand;
  if (t === 'cy') return loader ? { action: 'complex', perAction: Infinity, swap: true } : byHand;
  if (t === 'ml') return { action: 'complex', perAction: 1, swap: false };
  if (cls === 'bow' || cls === 'crossbow') return { action: 'simple', perAction: Infinity, swap: false };
  return { action: 'complex', perAction: Infinity, swap: false };
}

// ---------------------------------------------------------------------------
// Containers & locations
// ---------------------------------------------------------------------------
/** Item lists that live somewhere (« Sur soi » or a container). */
export const LOCATED_LISTS: ('weapons' | 'armor' | 'gear')[] = ['weapons', 'armor', 'gear'];
/** Implicit location: carried (« Sur soi »). */
export const ON_BODY = 'on';
export const CONTAINER_KINDS: Record<ContainerKind, string> = { body: tk('worn'), bag: tk('bag'), vehicle: tk('vehicle'), safehouse: tk('safehouse'), other: tk('other') };

/** Container kind guessed from its name (Foundry inventories, Chummer locations). */
export function guessContainerKind(name: unknown): ContainerKind {
  const s = norm(name);
  if (/(bag|sac|backpack|duffel|pack|case|valise|mallette|sacoche|satchel|briefcase|attache)/.test(s)) return 'bag';
  if (/(car|vehicle|vehicule|voiture|van|truck|camion|bike|moto|drone|trunk|coffre|boot)\b/.test(s)) return 'vehicle';
  if (/(house|home|safe ?house|apartment|appart|flat|planque|maison|squat|garage|locker|storage|stash|cache|casier|entrepot|warehouse|hideout|chez)/.test(s)) return 'safehouse';
  if (/(holster|belt|ceinture|vest|gilet|harness|harnais|pocket|poche|bandolier|bandouliere|worn|porte)/.test(s)) return 'body';
  return 'other';
}

/**
 * Carry bags of the catalog (Run Faster p. 254: Backpack, Duffel Bag, Suitcase, Briefcase — Cheap / Good / Nice),
 * by Chummer catalog id → English base name. Owning one opens a container for it (see linkCarryBags).
 */
export const CARRY_BAGS: Record<string, string> = {
  '6d4d5284-ef86-4960-97a1-fe6883541c75': 'Backpack', 'd7c98f39-279e-4169-8818-0c3cad08205b': 'Backpack', '8459fade-af0f-48a6-b283-b4969d1fe6b7': 'Backpack',
  'f1d60d11-b2e1-41ba-8cb5-34ce86ee584e': 'Duffel Bag', '429fbdba-2818-43db-948a-e138b6bf49f9': 'Duffel Bag', 'c22784cf-6ff2-4f65-9120-0be4d8eec1e3': 'Duffel Bag',
  '91a60831-8144-44fa-8d28-c0fe4d9acb4e': 'Suitcase', 'c91e95a4-818f-4324-b571-08324ad1162b': 'Suitcase', '7ba6ed45-2088-4fc4-ba1b-6f4bc3eb8aad': 'Suitcase',
  'fd5e0fcb-3d44-430e-a7a6-4f07b650adb6': 'Briefcase', '18b58439-6009-4865-8466-e09240c51af2': 'Briefcase', 'bf403263-ff8e-4f0b-a6d6-e180e7d05fcf': 'Briefcase',
};

/**
 * A carry bag the actor owns gets a container linked to it (Container.itemId), once per item (`bagMade`: a container the
 * owner deletes afterwards does not come back). An unlinked bag container of the same name (a Foundry inventory « Duffel
 * Bag » next to the item « Duffel Bag (Nice) » / « Sac de sport (Luxe) ») is linked instead of adding a second one. Ids
 * are stable: `chumgear_<guid>` for a Chummer item (the id a Chummer re-import would give that bag), else `bag_<item id>`.
 */
function linkCarryBags(a: RawData, containers: Container[], seen: Set<string>): void {
  const base = (s: unknown) => norm(String(s || '').replace(/\s*\([^)]*\)\s*$/, ''));
  for (const g of Array.isArray(a.gear) ? a.gear : []) {
    if (!isObj(g) || g.bagMade || !g.id || !CARRY_BAGS[g.catalogId]) continue;
    g.bagMade = true;
    if (containers.some((c) => c.itemId === g.id)) continue;
    const names = new Set([norm(CARRY_BAGS[g.catalogId]), base(g.name), base(g.nameFr), norm(g.name)].filter(Boolean));
    const same = containers.find((c) => c.kind === 'bag' && !c.itemId && names.has(norm(c.name)));
    if (same) {
      same.itemId = String(g.id);
      continue;
    }
    const id = (g.chummerGuid ? `chumgear_${String(g.chummerGuid).toLowerCase()}` : `bag_${g.id}`).slice(0, 60);
    if (seen.has(id) || id === ON_BODY) continue;
    seen.add(id);
    containers.push({ id, name: String(g.name || CARRY_BAGS[g.catalogId]).slice(0, 60), kind: 'bag', itemId: String(g.id) });
  }
}

export function containerOf(actor: InventoryActor | null | undefined, loc: unknown): Container | null {
  if (!loc || loc === ON_BODY) return null;
  return (Array.isArray(actor?.containers) ? actor.containers : []).find((c) => c && c.id === loc) || null;
}

/** Is an item at this location within reach (on the body or in a worn container)? Unknown container = carried. */
export function isCarried(actor: InventoryActor | null | undefined, loc: unknown): boolean {
  const c = containerOf(actor, loc);
  return !c || c.kind === 'body';
}

/** Ready weapons beyond the soft limit (2 ranged + 2 melee, unarmed and grenades not counted): { ranged, melee, over }. */
export function readyCount(actor: InventoryActor | null | undefined): { ranged: number; melee: number; over: boolean } {
  let ranged = 0;
  let melee = 0;
  for (const w of Array.isArray(actor?.weapons) ? actor.weapons : []) {
    if (!w || w.equipped === false || isUnarmed(w) || isGrenade(w) || isLauncherProfile(w)) continue;
    if (w.kind === 'melee') melee++;
    else if (isRangedArm(w)) ranged++;
  }
  return { ranged, melee, over: ranged > 2 || melee > 2 };
}

/**
 * Idempotent inventory fix-up (called by normalizeActor): containers (a carry bag owned opens one: linkCarryBags), item locations (unknown → « Sur soi »), items stored away
 * can be neither worn, ready nor active, weapon ammo (ammoMax / ammoType parsed from `ammo`, ammoLoaded defaults to full — the old
 * `ammoLeft` is adopted —, ammoKind defaults to regular rounds), weapon `equipped` defaults (unarmed always ready; weapons already
 * flagged keep their flag; the others: the first carried ranged weapon and the first carried melee weapon when none is ready).
 */
export function normalizeInventory(a: RawData, makeId: MakeId): RawData {
  if (!isObj(a)) return a;
  const seen = new Set<string>();
  a.containers = (Array.isArray(a.containers) ? a.containers : [])
    .filter(isObj)
    .map((c: RawData): Container => {
      let id = String(c.id || '').slice(0, 60) || makeId('ct');
      if (id === ON_BODY || seen.has(id)) id = makeId('ct');
      seen.add(id);
      const out: Container = { id, name: String(c.name || 'Contenant').slice(0, 60), kind: CONTAINER_KINDS[c.kind as ContainerKind] ? c.kind : 'other' };
      if (c.notes) out.notes = String(c.notes).slice(0, 500);
      if (c.itemId) out.itemId = String(c.itemId).slice(0, 60);
      return out;
    });
  linkCarryBags(a, a.containers, seen);
  for (const list of LOCATED_LISTS) {
    for (const it of Array.isArray(a[list]) ? a[list] : []) {
      if (!isObj(it)) continue;
      if (!it.location || (it.location !== ON_BODY && !seen.has(it.location))) it.location = ON_BODY;
      if (isCarried(a, it.location)) continue;
      if (list === 'gear' && it.active) it.active = false;
      if (list !== 'gear' && it.equipped) it.equipped = false;
    }
  }
  const weapons: RawData[] = (Array.isArray(a.weapons) ? a.weapons : []).filter(isObj);
  for (const w of weapons) {
    if (w.kind === 'melee') continue;
    const p = isThrownExplosive(w) ? { max: 0, type: '' } : parseAmmo(w.ammo); // hand grenades: units (qty), never rounds
    if (p.max > 0) {
      w.ammoMax = p.max;
      w.ammoType = p.type;
      if (w.ammoLoaded === undefined || w.ammoLoaded === null || !Number.isFinite(Number(w.ammoLoaded))) w.ammoLoaded = w.ammoLeft ?? p.max;
      w.ammoLoaded = Math.max(0, Math.min(p.max, Math.round(num(w.ammoLoaded, p.max))));
      if (w.ammoKind === undefined) w.ammoKind = defaultAmmoKind(w);
    } else {
      delete w.ammoMax;
      delete w.ammoType;
      delete w.ammoLoaded;
    }
    delete w.ammoLeft;
    if (w.qty !== undefined) w.qty = Math.max(0, Math.round(num(w.qty, 1)));
  }
  let ranged = weapons.some((w) => w.equipped === true && isRangedArm(w));
  let melee = weapons.some((w) => w.equipped === true && w.kind === 'melee' && !isUnarmed(w));
  for (const w of weapons) {
    if (isUnarmed(w)) {
      w.equipped = true;
      continue;
    }
    if (w.equipped === true || w.equipped === false) continue;
    w.equipped = false;
    if (!isCarried(a, w.location)) continue;
    if (w.kind === 'melee' && !melee) w.equipped = melee = true;
    else if (w.kind !== 'melee' && isRangedArm(w) && !ranged) w.equipped = ranged = true;
  }
  return a;
}
