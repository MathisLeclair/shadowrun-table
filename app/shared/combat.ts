// Combat helpers shared by the server (attacks module) and the browser (roll / defense dialogs, map overlays). Pure: no Node / DOM.
// - weapon range bands and the range modifier (SR5 p. 185) from the distance between two tokens,
// - grenade / launcher scatter (SR5 p. 182: 2D6 direction on the scatter diagram, (N D6 − hits) meters) and blast falloff (p. 435),
// - the special combat actions (SR5 core + Run & Gun, from Chummer's data/actions.xml: dice, DV, AP, reach, initiative / Edge cost,
//   unlocked by the martial art technique / quality of the same name — `requireunlock`),
// - the defense options (Dodge / Parry / Block / Full Defense / R&G « Defender » qualities) and the situational defense modifiers (p. 189).
// Labels are French source keys (tk); the UI renders them with t(), the server stores them as i18n params.
import { attr } from './sr5.ts';
import type { LimitKey } from './sr5.ts';
import type { ActorLike, AfflictionKind, AttrKey, Blast, BlastEffect, CombatState, DamageType, EffectUntil, GameMap, Point, Weapon } from './types.ts';

/** Weapon-shaped input: an actor weapon, an attack's weapon snapshot, a catalog profile mapped to the sheet fields. */
export type WeaponLike = Partial<Weapon>;
export type RangeClass =
  | 'taser' | 'holdout' | 'lightPistol' | 'heavyPistol' | 'machinePistol' | 'smg' | 'assaultRifle' | 'shotgunFlechette' | 'shotgun'
  | 'sniper' | 'lmg' | 'hmg' | 'assaultCannon' | 'grenadeLauncher' | 'missileLauncher' | 'bow' | 'lightCrossbow' | 'mediumCrossbow'
  | 'heavyCrossbow' | 'thrownKnife' | 'shuriken' | 'grenade' | 'grenadeAero';
export type RangeBandId = 'short' | 'medium' | 'long' | 'extreme';
export interface RangeBandDef {
  id: RangeBandId;
  mod: number;
  label: string;
}
/** rangeFor(): the band of a distance. */
export interface RangeInfo extends RangeBandDef {
  meters: number;
  /** Past the extreme range (max = its upper bound). */
  beyond?: boolean;
  max?: number;
  /** Under the launcher's minimum range. */
  tooClose?: boolean;
  min?: number;
}
export interface WeaponRanges {
  cls: RangeClass;
  /** [short, medium, long, extreme] upper bounds in meters. */
  bands: number[];
  min: number;
}
export interface ScatterInput {
  from?: Point | null;
  to: Point;
  hits?: number;
  dice?: number;
  threshold?: number | null;
  metersPerCell?: number;
  rng?: () => number;
  width?: number;
  height?: number;
}
export interface ScatterResult {
  x: number;
  y: number;
  meters: number;
  /** Direction dice (2D6). */
  dir?: number[];
  /** Distance dice. */
  dist?: number[];
  scattered: boolean;
}
/** blastOf(): damage of an area weapon. */
export interface BlastInfo {
  dv: number | null;
  type: DamageType;
  ap: number;
  /** DV lost per meter. */
  falloff: number | null;
  /** Meters, full DV. */
  radius: number | null;
  damaging: boolean;
}
/** What blastDvAt / blastReach read: a BlastInfo or a stored Blast marker. */
export interface BlastLike {
  damaging?: boolean;
  dv?: number | null;
  radius?: number | null;
  falloff?: number | null;
}
export type ToxinEffect = 'disorientation' | 'nausea' | 'stun' | 'physical';
export interface ToxinDef {
  id: string;
  name: string;
  en: string;
  vector: Array<'contact' | 'inhalation'>;
  speed: number;
  penetration: number;
  power: number;
  effects: ToxinEffect[];
  page: number;
}
export interface ToxinOutcome {
  damage: number;
  damageType: DamageType | null;
  afflictions: AfflictionKind[];
}
export interface AfflictionDef {
  name: string;
  en: string;
  /** Dice on every test but resistance tests. */
  dice?: number;
  /** Wound modifier multiplier. */
  woundFactor?: number;
  /** Combat Turns it lasts. */
  turns?: number;
}
/** The combat fields the expiry rules read. */
export type CombatLike = Partial<Pick<CombatState, 'active' | 'startedAt' | 'round'>>;
export type EnvColumn = 'visibility' | 'light' | 'wind' | 'range';
export type EnvLevels = Record<EnvColumn, number>;
export interface AttackSenses {
  lowLight: boolean;
  thermo: boolean;
  ultrasound: boolean;
  flare: boolean;
  smartlink: boolean;
}
export interface EnvironmentInput {
  map?: Partial<Pick<GameMap, 'weather' | 'metersPerCell' | 'lighting' | 'width'>> | null;
  from?: Point | null;
  to?: Point | null;
  meters?: number | null;
  rangeIndex?: number | null;
  litRatio?: ArrayLike<number> | null;
  blasts?: Array<Pick<Blast, 'x' | 'y'> & Partial<Pick<Blast, 'radius' | 'reach' | 'effect'>>> | null;
  senses?: Partial<AttackSenses>;
}
export interface EnvironmentResult {
  value: number;
  /** After compensation. */
  levels: EnvLevels;
  /** Before compensation. */
  raw: EnvLevels & { glare: number };
  /** French labels of what lowered a column. */
  notes: string[];
  parts: string[];
  rangeOnly: boolean;
}
export interface CombatActionDef {
  id: string;
  name: string;
  en: string;
  kind: 'melee' | 'ranged' | 'any' | 'test';
  type?: 'simple' | 'complex';
  unlock?: string[];
  dice?: number;
  defense?: number;
  dv?: number;
  ap?: number;
  reach?: number;
  ini?: number;
  edge?: number;
  fire?: string;
  rounds?: number;
  noDamage?: boolean;
  once?: boolean;
  attr?: AttrKey;
  skillId?: string;
  weaponSkill?: boolean;
  limit?: LimitKey;
  threshold?: number;
  note: string;
  source: string;
  page: number;
}
export interface DefenseOptionDef {
  id: string;
  name: string;
  en: string;
  ini: number;
  /** Skill id, or 'weapon' (the best ready melee weapon's skill). */
  skill?: string;
  attr?: AttrKey;
  melee?: boolean;
  turn?: boolean;
  unlock?: string[];
  source: string;
  page: number;
}
export interface DefenseSituationDef {
  id: string;
  name: string;
  value: number;
  ranged?: boolean;
}
/** The attack fields defenseLines() reads (an Attack, or the preview of one). */
export interface DefenseAttack {
  kind?: string;
  defenseMod?: number;
  defenseLabel?: string;
  actionDefense?: number;
  actionName?: string;
  reach?: number;
}
export interface DefenseLineOptions {
  options?: string[];
  situations?: string[];
  prior?: number;
  turnBoosts?: string[];
}
export interface DefenseLine {
  label: string;
  value: number;
  key: string;
}
/** The state slices pruneExpired() reads and trims (a TableState fits). */
export interface PrunableState {
  attacks?: { blasts?: Array<{ until?: EffectUntil | null; ts?: number }> } | null;
  combat?: CombatLike | null;
  actors?: Record<string, { afflictions?: Array<{ until: EffectUntil } | null> | null } | null>;
}

const tk = (s: string): string => s;
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
/** Lower-case, no accents, single spaces. */
export const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
const textOf = (w: WeaponLike | null | undefined) => norm([w?.name, w?.nameEn, w?.nameFr, w?.category, w?.categoryEn, w?.categoryFr].filter(Boolean).join(' '));

// ---------------------------------------------------------------------------
// Ranges (SR5 p. 185)
// ---------------------------------------------------------------------------
export const RANGE_BANDS: RangeBandDef[] = [
  { id: 'short', mod: 0, label: tk('portée courte') },
  { id: 'medium', mod: -1, label: tk('portée moyenne') },
  { id: 'long', mod: -3, label: tk('portée longue') },
  { id: 'extreme', mod: -6, label: tk('portée extrême') },
];
/** Upper bound (meters) of each band; a function of STR for bows / thrown weapons. `min` = launcher minimum range. */
const RANGE_TABLE: Record<RangeClass, number[] | { bands: number[]; min: number } | ((s: number) => number[])> = {
  taser: [5, 10, 15, 20],
  holdout: [5, 15, 30, 50],
  lightPistol: [5, 15, 30, 50],
  heavyPistol: [5, 20, 40, 60],
  machinePistol: [5, 15, 30, 50],
  smg: [10, 40, 80, 150],
  assaultRifle: [25, 150, 350, 550],
  shotgunFlechette: [15, 30, 45, 60],
  shotgun: [10, 40, 80, 150],
  sniper: [50, 350, 800, 1500],
  lmg: [25, 200, 400, 800],
  hmg: [40, 250, 750, 1200],
  assaultCannon: [50, 300, 750, 1500],
  grenadeLauncher: { bands: [50, 100, 150, 500], min: 5 },
  missileLauncher: { bands: [70, 150, 450, 1500], min: 20 },
  bow: (s) => [s, s * 10, s * 30, s * 60],
  lightCrossbow: [6, 24, 60, 120],
  mediumCrossbow: [9, 36, 90, 150],
  heavyCrossbow: [15, 45, 120, 180],
  thrownKnife: (s) => [s, s * 2, s * 3, s * 5],
  shuriken: (s) => [s, s * 2, s * 5, s * 7],
  grenade: (s) => [s * 2, s * 4, s * 6, s * 10],
  grenadeAero: (s) => [s * 2, s * 4, s * 8, s * 15],
};

/** Range class of a weapon (key of RANGE_TABLE) or null (melee, unknown). French and English names / categories. */
export function rangeClass(w: WeaponLike | null | undefined): RangeClass | null {
  if (!w || w.kind === 'melee') return null;
  const s = textOf(w);
  const thrownGrenade = (!w.skill || w.skill === 'throwing_weapons') && /grenade|explosi/.test(s);
  if (thrownGrenade) return /aerodynami/.test(s) ? 'grenadeAero' : 'grenade';
  if (/grenade launcher|lance grenades?|minigrenade/.test(s)) return 'grenadeLauncher';
  if (/missile|rocket|roquette/.test(s)) return 'missileLauncher';
  if (/taser|impulsion electrique|shocker/.test(s)) return 'taser';
  if (/hold ?outs?|pistolets? de poche/.test(s)) return 'holdout';
  if (/machine pistols?|pistolets? mitrailleurs?/.test(s)) return 'machinePistol';
  if (/light pistols?|pistolets? legers?/.test(s)) return 'lightPistol';
  if (/heavy pistols?|pistolets? lourds?/.test(s)) return 'heavyPistol';
  if (/submachine|\bsmgs?\b|mitraillettes?/.test(s)) return 'smg';
  if (/assault rifles?|fusils? d'assaut/.test(s)) return 'assaultRifle';
  if (/assault cannons?|canons? d'assaut/.test(s)) return 'assaultCannon';
  if (/light machine ?guns?|mitrailleuses? legeres?/.test(s)) return 'lmg';
  if (/(medium|heavy) machine ?guns?|mitrailleuses? (moyennes?|lourdes?)/.test(s)) return 'hmg';
  if (/sniper|precision/.test(s)) return 'sniper';
  if (/shotguns?|fusils? a pompe/.test(s)) return /flechette/.test(norm(w.ammoKind?.name || '')) ? 'shotgunFlechette' : 'shotgun';
  if (/crossbows?|arbaletes?/.test(s)) return /heavy|lourde/.test(s) ? 'heavyCrossbow' : /medium|moyenne/.test(s) ? 'mediumCrossbow' : 'lightCrossbow';
  if (/\bbows?\b|\barcs?\b/.test(s) || w.skill === 'archery') return 'bow';
  if (/shuriken/.test(s)) return 'shuriken';
  if (w.skill === 'throwing_weapons') return 'thrownKnife';
  if (w.skill === 'pistols') return 'heavyPistol';
  if (w.skill === 'automatics') return 'smg';
  return null;
}

/** [short, medium, long, extreme] upper bounds in meters (+ min) for this weapon and actor, or null. */
export function weaponRanges(w: WeaponLike | null | undefined, actor?: ActorLike | null): WeaponRanges | null {
  const cls = rangeClass(w);
  if (!cls) return null;
  const e = RANGE_TABLE[cls];
  const str = Math.max(1, actor && actor.attributes ? attr(actor, 'STR') : 3);
  if (typeof e === 'function') return { cls, bands: e(str), min: 0 };
  if (Array.isArray(e)) return { cls, bands: e, min: 0 };
  return { cls, bands: e.bands, min: e.min };
}

/** Range band of a distance: { band, mod, label, meters, beyond?, tooClose? } — null for melee / unknown weapons. */
export function rangeFor(w: WeaponLike | null | undefined, actor: ActorLike | null | undefined, meters: number | null | undefined): RangeInfo | null {
  const r = weaponRanges(w, actor);
  if (!r || meters == null || !Number.isFinite(meters)) return null;
  const m = Math.max(0, Math.round(meters));
  const i = r.bands.findIndex((b) => m <= b);
  if (i < 0) return { ...RANGE_BANDS[3], meters: m, beyond: true, max: r.bands[3] };
  return { ...RANGE_BANDS[i], meters: m, ...(r.min && m < r.min ? { tooClose: true, min: r.min } : {}) };
}

/** Meters between two cells (token top-left cells; centre to centre), map scale = metersPerCell. */
export function cellDistance(a: Partial<Point>, b: Partial<Point>, metersPerCell?: unknown): number;
export function cellDistance(a: Partial<Point> | null | undefined, b: Partial<Point> | null | undefined, metersPerCell?: unknown): number | null;
export function cellDistance(a: Partial<Point> | null | undefined, b: Partial<Point> | null | undefined, metersPerCell: unknown = 1): number | null {
  if (!a || !b) return null;
  const dx = num(a.x) - num(b.x);
  const dy = num(a.y) - num(b.y);
  return Math.round(Math.hypot(dx, dy) * (num(metersPerCell, 1) || 1) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Grenades, launchers: scatter and blast (SR5 p. 182 and 435)
// ---------------------------------------------------------------------------
/** Area-effect weapon: thrown grenade, grenade launcher (or its minigrenade profile), rocket / missile launcher. */
export function isAreaWeapon(w: WeaponLike | null | undefined): boolean {
  const c = rangeClass(w);
  return c === 'grenade' || c === 'grenadeAero' || c === 'grenadeLauncher' || c === 'missileLauncher';
}

/** Scatter dice (SR5 Scatter Table): standard grenade 1D6, aerodynamic 2D6, grenade launcher 3D6, missile 4D6, rocket 5D6. */
export function scatterDice(w: WeaponLike | null | undefined): number {
  const c = rangeClass(w);
  if (c === 'grenade') return 1;
  if (c === 'grenadeAero') return 2;
  if (c === 'grenadeLauncher') return 3;
  if (c === 'missileLauncher') return /rocket|roquette/.test(textOf(w)) ? 5 : 4;
  return 0;
}

/** Scatter diagram (2D6): 7 = straight on past the target, 2 / 12 = back toward the attacker; angle in degrees from the launch direction. */
export const SCATTER_ANGLE: Record<number, number> = { 2: -150, 3: -120, 4: -90, 5: -60, 6: -30, 7: 0, 8: 30, 9: 60, 10: 90, 11: 120, 12: 150 };

/**
 * Landing point of a grenade / projectile. from, to = cells; hits = attack hits; dice = scatter dice; rng() in [0, 1).
 * Thrown grenades: 3 hits (threshold) = no scatter. Returns { x, y, meters, dir: [d1, d2], dist: [dice…], scattered }.
 */
export function rollScatter({ from, to, hits = 0, dice = 1, threshold = null, metersPerCell = 1, rng = Math.random, width = Infinity, height = Infinity }: ScatterInput): ScatterResult {
  const d6 = () => 1 + Math.floor(rng() * 6);
  if (threshold && hits >= threshold) return { x: to.x, y: to.y, meters: 0, scattered: false };
  const dir = [d6(), d6()];
  const dist = Array.from({ length: Math.max(1, dice) }, d6);
  const meters = Math.max(0, dist.reduce((s, v) => s + v, 0) - Math.max(0, hits));
  if (!meters) return { x: to.x, y: to.y, meters: 0, dir, dist, scattered: false };
  const base = from && (from.x !== to.x || from.y !== to.y) ? Math.atan2(to.y - from.y, to.x - from.x) : -Math.PI / 2;
  const ang = base + ((SCATTER_ANGLE[dir[0] + dir[1]] || 0) * Math.PI) / 180;
  const cells = meters / (num(metersPerCell, 1) || 1);
  const clampTo = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  const x = clampTo(Math.round((to.x + Math.cos(ang) * cells) * 10) / 10, width);
  const y = clampTo(Math.round((to.y + Math.sin(ang) * cells) * 10) / 10, height);
  return { x, y, meters, dir, dist, scattered: true };
}

/**
 * Blast of an area weapon: { dv, type, ap, falloff (DV lost per meter) | radius (meters, full DV), damaging }.
 * Reads « 9P (-3/m) », « (3m Radius) », « 10m Radius » in the damage text, else the SR5 table by name (p. 435).
 */
export function blastOf(w: WeaponLike | null | undefined, actor?: ActorLike | null): BlastInfo | null {
  if (!w) return null;
  const raw = String(w.damage ?? '');
  const s = textOf(w);
  const dvM = raw.replace(/\(.*?\)/g, '').match(/(\d+)\s*([PS])/i);
  let dv: number | null = dvM ? Number(dvM[1]) : null;
  let type = (dvM ? dvM[2].toUpperCase() : 'P') as DamageType;
  const ap = num(String(w.ap ?? '0').replace(/[^-+\d]/g, ''), 0);
  let falloff: number | null = null;
  let radius: number | null = null;
  const fm = raw.match(/-\s*(\d+)\s*\/\s*m/i);
  if (fm) falloff = Number(fm[1]);
  const rm = raw.match(/(\d+)\s*m\s*(radius|rayon)/i);
  if (rm) radius = Number(rm[1]);
  if (falloff === null && radius === null) {
    if (/flash ?bang|aveuglante|incapacitante/.test(s)) radius = 10;
    else if (/\bgas\b|\bgaz\b|smoke|fumee|fumigene|thermal/.test(s)) radius = 10;
    else if (/anti ?vehicle|antivehicule/.test(s)) falloff = 4;
    else if (/high explosive|explosifs?\b|\bhe\b|explosive/.test(s)) falloff = 2;
    else if (/frag/.test(s)) falloff = 1;
    else if (dv !== null) falloff = 1;
  }
  if (/flash ?bang/.test(s) && dv === null) {
    dv = 10;
    type = 'S';
  }
  return { dv, type, ap, falloff, radius, damaging: dv !== null && dv > 0 };
}

/** Damage Value of a blast at a distance in meters (0 = out of the blast). */
export function blastDvAt(blast: BlastLike | null | undefined, meters: number): number {
  if (!blast?.damaging) return 0;
  // damaging => dv is a number
  if (blast.radius !== null && blast.radius !== undefined) return meters <= blast.radius ? (blast.dv as number) : 0;
  return Math.max(0, Math.floor((blast.dv as number) - (blast.falloff || 0) * Math.max(0, Math.round(meters))));
}

/** Radius (meters) a blast reaches: its radius, or where the falloff brings the DV to 0. */
export function blastReach(blast: BlastLike | null | undefined): number {
  if (!blast) return 0;
  if (blast.radius !== null && blast.radius !== undefined) return blast.radius;
  if (!blast.damaging || !blast.falloff) return 0;
  return Math.max(0, Math.ceil((blast.dv as number) / blast.falloff) - 1);
}

// ---------------------------------------------------------------------------
// Area effects of grenades: what the blast leaves on the map (SR5 p. 435) and the toxins of gas grenades (p. 409-410)
// ---------------------------------------------------------------------------
/**
 * Kind of area effect of a grenade / launcher round: 'explosion' (frag, HE, flash-bang: damage once), 'smoke' / 'thermalSmoke'
 * (a cloud: heavy visibility modifier through it; thermographic vision sees through plain smoke only), 'gas' (a cloud: the
 * toxin chosen at the throw, a resistance test for each token caught), 'flashpak' (blinding glare in its radius).
 */
export function areaEffectOf(w: WeaponLike | null | undefined): BlastEffect {
  const s = textOf(w);
  if (/flash ?pak/.test(s)) return 'flashpak';
  if (/thermal smoke|fumigene infrarouge|fumee thermique|thermal/.test(s)) return 'thermalSmoke';
  if (/smoke|fumigene|fumee/.test(s)) return 'smoke';
  if (/\bgas\b|\bgaz\b|chemical|chimique|lacrymo|neuro ?stun|pepper punch|nausea|seven ?7|\bcs\b/.test(s)) return 'gas';
  return 'explosion';
}
/** Cloud-like effects stay on the map until the end of the fight (explosions: until the end of the Combat Turn). */
export const LASTING_EFFECTS: BlastEffect[] = ['smoke', 'thermalSmoke', 'gas', 'flashpak'];

/**
 * Toxins a gas grenade can hold (SR5 p. 409-410): vector, speed, penetration, power, effects
 * ('disorientation' | 'nausea' | 'stun' | 'physical'). Speed is not delayed here: the resistance test is rolled at once.
 */
export const TOXINS: ToxinDef[] = [
  { id: 'cs', name: tk('Gaz lacrymogène (CS)'), en: 'CS/Tear Gas', vector: ['contact', 'inhalation'], speed: 1, penetration: 0, power: 8, effects: ['disorientation', 'nausea', 'stun'], page: 409 },
  { id: 'pepper', name: tk('Gaz poivre (Pepper Punch)'), en: 'Pepper Punch', vector: ['contact', 'inhalation'], speed: 1, penetration: 0, power: 11, effects: ['nausea', 'stun'], page: 410 },
  { id: 'nausea', name: tk('Gaz vomitif'), en: 'Nausea Gas', vector: ['inhalation'], speed: 3, penetration: 0, power: 9, effects: ['disorientation', 'nausea'], page: 410 },
  { id: 'neurostun8', name: tk('Neuro-Stun VIII'), en: 'Neuro-Stun VIII', vector: ['contact', 'inhalation'], speed: 1, penetration: 0, power: 15, effects: ['disorientation', 'stun'], page: 410 },
  { id: 'neurostun9', name: tk('Neuro-Stun IX'), en: 'Neuro-Stun IX', vector: ['contact', 'inhalation'], speed: 1, penetration: 0, power: 15, effects: ['disorientation', 'stun'], page: 410 },
  { id: 'neurostun10', name: tk('Neuro-Stun X'), en: 'Neuro-Stun X', vector: ['contact', 'inhalation'], speed: 1, penetration: -2, power: 15, effects: ['disorientation', 'stun'], page: 410 },
  { id: 'seven7', name: tk('Seven-7'), en: 'Seven-7', vector: ['contact', 'inhalation'], speed: 1, penetration: -2, power: 12, effects: ['disorientation', 'nausea', 'physical'], page: 410 },
];
export const TOXIN_BY_ID: Record<string, ToxinDef> = Object.fromEntries(TOXINS.map((x) => [x.id, x]));

/** Toxin named by a gas grenade (« Grenade: Gas (Neuro-Stun VIII) »), else null (the thrower picks; CS by default). */
export function toxinFromText(w: WeaponLike | null | undefined): string | null {
  const s = textOf(w) + ' ' + norm(w?.notes || '') + ' ' + norm(w?.choice || '');
  if (/neuro ?stun (x|10)\b/.test(s)) return 'neurostun10';
  if (/neuro ?stun (ix|9)\b/.test(s)) return 'neurostun9';
  if (/neuro ?stun/.test(s)) return 'neurostun8';
  if (/seven ?7/.test(s)) return 'seven7';
  if (/pepper|poivre/.test(s)) return 'pepper';
  if (/nausea|vomitif/.test(s)) return 'nausea';
  if (/\bcs\b|tear|lacrymo/.test(s)) return 'cs';
  return null;
}

/**
 * Toxin effects once resisted (SR5 p. 408-409). left = Power − resistance hits (nothing when ≤ 0).
 * disorientation: −2 dice for 10 minutes; nausea: wound modifiers doubled for 10 minutes, and incapacitated for 3 Combat Turns
 * when left > Willpower; stun / physical: left boxes of that damage (no armor).
 */
export function toxinOutcome(toxin: ToxinDef | null | undefined, left: number, wil: unknown): ToxinOutcome {
  const out: ToxinOutcome = { damage: 0, damageType: null, afflictions: [] };
  if (!toxin || left <= 0) return out;
  if (toxin.effects.includes('stun')) { out.damage = left; out.damageType = 'S'; }
  if (toxin.effects.includes('physical')) { out.damage = left; out.damageType = 'P'; }
  if (toxin.effects.includes('disorientation')) out.afflictions.push('disoriented');
  if (toxin.effects.includes('nausea')) {
    out.afflictions.push('nauseous');
    if (left > (Number(wil) || 0)) out.afflictions.push('incapacitated');
  }
  return out;
}

/**
 * Afflictions a character can carry (actor.afflictions: [{ id, kind, source, ts, until }]), with their modifiers:
 * dice = on every skill / attribute test but resistance tests, woundFactor = wound modifier multiplier.
 * until: { round: 'startedAt:round' } (Combat Turns) | { combat: startedAt } (rest of the fight) | { ts } (out of combat).
 */
export const AFFLICTIONS: Record<AfflictionKind, AfflictionDef> = {
  disoriented: { name: tk('Désorienté'), en: 'Disoriented', dice: -2 },
  nauseous: { name: tk('Nauséeux'), en: 'Nauseous', woundFactor: 2 },
  incapacitated: { name: tk('Incapable d’agir (nausée)'), en: 'Incapacitated (nausea)', turns: 3 },
};
const LONG_MS = 10 * 60 * 1000; // 10 minutes (outside combat)
const TURN_MS = 60 * 1000; // a few Combat Turns outside combat

/** Expiry of an affliction / area effect created now: { round } | { combat } | { ts }. */
export function untilFor(combat: CombatLike | null | undefined, now: number, { turns = 0, long = false }: { turns?: number; long?: boolean } = {}): EffectUntil {
  if (combat?.active) {
    if (turns) return { round: `${combat.startedAt || 0}:${(combat.round || 1) + turns - 1}` };
    return { combat: combat.startedAt || 0 };
  }
  return { ts: now + (turns ? TURN_MS : long ? LONG_MS : TURN_MS) };
}
/** Is something with this `until` still running? */
export function stillActive(untilIn: EffectUntil | null | undefined, combat: CombatLike | null | undefined, now: number): boolean {
  if (!untilIn) return true;
  const until = untilIn as { round?: string; combat?: number; ts?: number };
  if (until.ts !== undefined) return now <= until.ts;
  if (!combat?.active) return false;
  const started = combat.startedAt || 0;
  if (until.combat !== undefined) return until.combat === started;
  const [s, r] = String(until.round || '').split(':').map(Number);
  return s === started && (combat.round || 1) <= r;
}

/** Blast markers still shown: explosions until the end of their Combat Turn (1 min outside combat), clouds until the end of the fight. */
export function activeBlasts<T extends { until?: EffectUntil | null; ts?: number }>(blasts: T[] | null | undefined, combat: CombatLike | null | undefined, now: number): T[] {
  // Markers made before expiry existed (no `until`) last one minute from their throw.
  return (blasts || []).filter((b) => (b.until ? stillActive(b.until, combat, now) : now - (Number(b.ts) || 0) <= 60 * 1000));
}

/** Drop the blast markers and afflictions that ran out (state.attacks.blasts, actor.afflictions). Returns true when something changed. */
export function pruneExpired(state: PrunableState | null | undefined, now: number): boolean {
  let changed = false;
  const s = state?.attacks;
  if (s && Array.isArray(s.blasts)) {
    const kept = activeBlasts(s.blasts, state.combat, now);
    if (kept.length !== s.blasts.length) {
      s.blasts = kept;
      changed = true;
    }
  }
  for (const a of Object.values(state?.actors || {})) {
    if (!Array.isArray(a?.afflictions) || !a.afflictions.length) continue;
    const kept = a.afflictions.filter((x) => x && stillActive(x.until, state!.combat, now));
    if (kept.length !== a.afflictions.length) {
      a.afflictions = kept;
      changed = true;
    }
  }
  return changed;
}

/** Protection of an actor against a toxin: 'immune' (chemical seal, or a gas mask against an inhalation-only toxin) or null. */
export function toxinProtection(actor: ActorLike | null | undefined, toxin: ToxinDef | null | undefined): 'immune' | null {
  const names = [...(actor?.gear || []), ...(actor?.armor || []).filter((a) => a?.equipped).flatMap((a) => [a, ...(a.mods || [])]), ...(actor?.augmentations || [])]
    .filter(Boolean).flatMap((x) => [x.name, x.nameEn, x.nameFr, x.notes]).filter(Boolean).map(norm).join(' | ');
  if (/chemical seal|joint chimique|etancheite chimique|scelle chimique/.test(names)) return 'immune';
  const inhalationOnly = toxin && toxin.vector.length === 1 && toxin.vector[0] === 'inhalation';
  if (inhalationOnly && /gas mask|masque a gaz|internal air tank|reservoir d'air|reserve d'air/.test(names)) return 'immune';
  return null;
}

// ---------------------------------------------------------------------------
// Environmental modifiers of ranged attacks (SR5 p. 175): visibility, light / glare, wind, range — vision compensation
// ---------------------------------------------------------------------------
export const ENV_LEVEL_MODS: number[] = [0, -1, -3, -6];
export const ENV_COLUMNS: EnvColumn[] = ['visibility', 'light', 'wind', 'range'];
export const ENV_LEVEL_LABELS: Record<'visibility' | 'light' | 'glare' | 'wind', string[]> = {
  visibility: [tk('dégagé'), tk('pluie / brouillard / fumée légers'), tk('pluie / brouillard / fumée modérés'), tk('pluie / brouillard / fumée denses')],
  light: [tk('pleine lumière'), tk('lumière partielle'), tk('faible lumière'), tk('obscurité totale')],
  glare: [tk('sans éblouissement'), tk('léger éblouissement'), tk('éblouissement modéré'), tk('éblouissement aveuglant')],
  wind: [tk('pas de vent'), tk('vent léger'), tk('vent modéré'), tk('vent fort')],
};

/** SR5: the worst column gives the modifier; two columns at that worst level → one level worse (two Heavy → −10). */
export function combineEnv(levels: Partial<EnvLevels> | null | undefined): number {
  const vals = ENV_COLUMNS.map((k) => Math.max(0, Math.min(3, Math.round(Number(levels?.[k]) || 0)))).filter((v) => v > 0);
  if (!vals.length) return 0;
  const top = Math.max(...vals);
  const ties = vals.filter((v) => v === top).length;
  if (ties < 2) return ENV_LEVEL_MODS[top];
  return top >= 3 ? -10 : ENV_LEVEL_MODS[top + 1];
}

const ULTRASOUND_RE = /ultrasound|ultrason/;
const SMARTLINK_RE = /smart ?link|smartgun|smart ?gun/;
const FLARE_RE = /flare comp|compensation (anti ?)?flash|anti ?eblouissement|compensation d'eblouissement/;
/** Senses of an attacker for the compensation rules: low-light / thermographic (token vision rules), ultrasound, flare compensation, smartlink. */
export function attackSenses(
  actor: ActorLike | null | undefined,
  tokenVisionInfo: { lowLight?: boolean; thermo?: boolean } = {},
  weapon: WeaponLike | null = null,
): AttackSenses {
  type NamedItem = { name?: string; nameEn?: string; nameFr?: string; notes?: string; mods?: Array<{ name?: string } | null> };
  const items: NamedItem[] = [
    ...(actor?.augmentations || []), ...(actor?.gear || []), ...(actor?.qualities || []), ...(actor?.powers || []),
    ...(actor?.armor || []).flatMap((a) => [a, ...(a?.mods || [])]),
  ].filter(Boolean) as NamedItem[];
  const names = items.flatMap((x) => [x.name, x.nameEn, x.nameFr, x.notes, ...(x.mods || []).map((m) => m?.name)]).filter(Boolean).map(norm).join(' | ');
  const wNames = weapon ? [weapon.name, ...(weapon.accessories || []).flatMap((a) => [a?.name, a?.nameFr])].filter(Boolean).map(norm).join(' | ') : '';
  return {
    lowLight: !!tokenVisionInfo.lowLight,
    thermo: !!tokenVisionInfo.thermo,
    ultrasound: ULTRASOUND_RE.test(names),
    flare: FLARE_RE.test(names),
    smartlink: SMARTLINK_RE.test(names) && SMARTLINK_RE.test(wNames),
  };
}

/** Light level of a cell from the map lighting (createVisionContext litRatio): lit 0, edge of a light 1, dim 2, dark 3. */
export function lightLevelAt(
  map: Partial<Pick<GameMap, 'lighting' | 'width'>> | null | undefined,
  litRatio: ArrayLike<number> | null | undefined,
  x: number,
  y: number,
): number {
  const lighting = map?.lighting || 'bright';
  if (lighting === 'bright') return 0;
  const i = (y | 0) * (map!.width! | 0) + (x | 0);
  const r = litRatio ? litRatio[i] : Infinity;
  if (r <= 1) return 0;
  if (r <= 2) return 1;
  return lighting === 'dim' ? 2 : 3;
}

/** Shortest distance (cells) from point p to segment a–b. */
function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/**
 * Environmental modifier of a ranged attack. from / to = cells, meters = distance, rangeIndex = 0..3 (short … extreme, null = none),
 * litRatio from createVisionContext (null = bright map), blasts = active blast markers of the map, senses = attackSenses().
 * Returns { value, levels (after compensation), raw (before), notes: [French labels of what lowered a column], parts: [labels] }.
 */
export function environmentFor({ map, from, to, meters = 0, rangeIndex = null, litRatio = null, blasts = [], senses = {} }: EnvironmentInput): EnvironmentResult {
  const weather: Partial<NonNullable<GameMap['weather']>> = map?.weather || {};
  const mpc = Number(map?.metersPerCell) || 1;
  const raw = { visibility: Math.max(0, Math.min(3, Number(weather.visibility) || 0)), light: 0, glare: 0, wind: Math.max(0, Math.min(3, Number(weather.wind) || 0)), range: rangeIndex ?? 0 };
  let thermalSmoke = false;
  if (to) raw.light = lightLevelAt(map, litRatio, to.x, to.y);
  for (const b of blasts || []) {
    const r = (Number(b.radius ?? b.reach) || 10) / mpc;
    const c = { x: b.x, y: b.y };
    if (b.effect === 'smoke' || b.effect === 'thermalSmoke') {
      const through = from && to ? segDist(c, from, to) <= r : to ? Math.hypot(to.x - c.x, to.y - c.y) <= r : false;
      if (through) {
        raw.visibility = 3;
        if (b.effect === 'thermalSmoke') thermalSmoke = true;
      }
    } else if (b.effect === 'flashpak') {
      const near = (p: Point | null | undefined) => p && Math.hypot(p.x - c.x, p.y - c.y) <= r;
      if (near(from) || near(to)) raw.glare = 3;
    }
  }
  const lv = { ...raw };
  const notes: string[] = [];
  const lower = (k: keyof typeof lv, n: number, why: string) => {
    const before = lv[k];
    lv[k] = Math.max(0, lv[k] - n);
    if (lv[k] < before && !notes.includes(why)) notes.push(why);
  };
  if (senses.lowLight && (lv.light === 1 || lv.light === 2)) lower('light', lv.light, tk('vision nocturne'));
  if (senses.thermo) {
    lower('light', 1, tk('vision thermographique'));
    if (!thermalSmoke) lower('visibility', 1, tk('vision thermographique'));
  }
  if (senses.ultrasound) {
    lower('visibility', 1, tk('ultrasons'));
    if ((meters ?? 0) <= 50) lower('light', 3, tk('ultrasons'));
  }
  if (senses.flare) lower('glare', 3, tk('compensation anti-flash'));
  if (senses.smartlink) lower('wind', 1, tk('smartlink'));
  const levels = { visibility: lv.visibility, light: Math.max(lv.light, lv.glare), wind: lv.wind, range: lv.range };
  const parts: string[] = [];
  if (lv.visibility) parts.push(ENV_LEVEL_LABELS.visibility[lv.visibility]);
  if (lv.light) parts.push(ENV_LEVEL_LABELS.light[lv.light]);
  if (lv.glare) parts.push(ENV_LEVEL_LABELS.glare[lv.glare]);
  if (lv.wind) parts.push(ENV_LEVEL_LABELS.wind[lv.wind]);
  return { value: combineEnv(levels), levels, raw, notes, parts, rangeOnly: !lv.visibility && !lv.light && !lv.glare && !lv.wind };
}

// ---------------------------------------------------------------------------
// Special combat actions (SR5 core + Run & Gun — Chummer data/actions.xml)
// ---------------------------------------------------------------------------
/**
 * id, name (French) / en, kind: 'melee' | 'ranged' | 'any' (weapon attack), or 'test' (own pool, no weapon: Clinch…),
 * type: 'simple' | 'complex', unlock: names of the technique / quality that unlocks it (Chummer `requireunlock`),
 * dice (attack pool), defense (target's defense pool), dv, ap, reach, ini (initiative cost), edge (Edge cost),
 * fire: fire option required (rounds override `rounds`), noDamage (opposed test only), once: once per Combat Turn,
 * note: French summary of the rule, source / page.
 */
export const COMBAT_ACTIONS: CombatActionDef[] = [
  { id: 'called-shot', name: tk('Tir ciblé (dommages)'), en: 'Called Shot (Increase Damage)', kind: 'any', dice: -4, dv: 2, source: 'SR5', page: 195,
    note: tk('Viser une zone vulnérable : −4 dés, +2 VD (ou autre effet de tir ciblé au choix du MJ).') },
  { id: 'charge', name: tk('Attaque en charge'), en: 'Charging Attack', kind: 'melee', dice: 2, source: 'SR5', page: 187,
    note: tk('Courir au moins quelques mètres vers la cible avant de frapper : +2 dés.') },
  { id: 'double-tap', name: tk('Double frappe'), en: 'Double Tap', kind: 'ranged', fire: 'SB', rounds: 2, dv: 1, source: 'RG', page: 120,
    note: tk('Rafale semi-automatique de 2 balles au lieu de 3 : +1 VD.') },
  { id: 'aimed-burst', name: tk('Rafale visée'), en: 'Aimed Burst', kind: 'ranged', fire: 'LB', rounds: 3, dv: 1, source: 'RG', page: 119,
    note: tk('Rafale longue de 3 balles au lieu de 6 : +1 VD.') },
  { id: 'brain-blaster', name: tk('Rafale cervicale'), en: 'Brain Blaster', kind: 'ranged', fire: 'FAC', rounds: 6, dv: 2, source: 'RG', page: 119,
    note: tk('Tir automatique (complexe) de 6 balles au lieu de 10 : +2 VD.') },
  { id: 'finishing-move', name: tk('Prise de finition'), en: 'Finishing Move', kind: 'melee', type: 'complex', unlock: ['Finishing Move', 'Prise de finition'],
    dice: 2, ini: 10, edge: 1, once: true, source: 'RG', page: 120, note: tk('+2 dés, coûte 1 point de Chance et 10 d’initiative. Une fois par tour de combat.') },
  { id: 'flying-kick', name: tk('Coup de pied sauté'), en: 'Flying Kick', kind: 'melee', type: 'complex', unlock: ['Flying Kick', 'Coup de pied sauté'], dice: 1, reach: 1,
    source: 'RG', page: 121, note: tk('+1 dé, +1 allonge. En cas d’échec : −1 aux tests de défense jusqu’à sa prochaine action.') },
  { id: 'full-offense', name: tk('Attaque pure'), en: 'Full Offense', kind: 'melee', type: 'complex', unlock: ['Full Offense', 'Attaque pure'], dice: 2, ini: 5,
    source: 'RG', page: 121, note: tk('+2 dés, coûte 5 d’initiative. Ensuite, aucune action d’interruption défensive avant sa prochaine action.') },
  { id: 'ballestra', name: tk('Ballestra'), en: 'Ballestra', kind: 'melee', type: 'complex', unlock: ['Ballestra'], reach: 1, source: 'RG', page: 119,
    note: tk('+1 allonge. Ensuite −1 aux tests de défense et pas de défense active jusqu’à sa prochaine action.') },
  { id: 'half-sword', name: tk('Demi-épée'), en: 'Half Sword', kind: 'melee', type: 'complex', unlock: ['Half Sword', 'Demi-épée'], ap: -2, source: 'RG', page: 121,
    note: tk('PA −2 supplémentaire, à deux mains. En cas d’échec : −2 à la prochaine action, ni parade ni blocage.') },
  { id: 'haymaker', name: tk('Coup décisif'), en: 'Haymaker', kind: 'melee', type: 'complex', unlock: ['Haymaker', 'Coup décisif'], defense: 2, dv: 1, source: 'RG', page: 121,
    note: tk('+1 VD, mais le défenseur gagne +2 dés.') },
  { id: 'pouncing-dragon', name: tk('Poing du dragon'), en: 'Pouncing Dragon', kind: 'melee', type: 'complex', unlock: ['Pouncing Dragon', 'Poing du dragon'], dv: 2,
    source: 'RG', page: 122, note: tk('+2 VD. Exige une position supérieure, perdue après l’action.') },
  { id: 'herding', name: tk('Ruse du Berger'), en: 'Herding', kind: 'melee', type: 'complex', unlock: ['Herding', 'Ruse du Berger'], defense: 2, noDamage: true,
    source: 'RG', page: 121, note: tk('Pas de dommages : repousse l’adversaire de 1 m par succès net (le défenseur gagne +2 dés).') },
  { id: 'subduing', name: tk('Maîtrise'), en: 'Subduing', kind: 'melee', type: 'complex', noDamage: true, source: 'SR5', page: 195,
    note: tk('Pas de dommages : si FOR + succès nets dépasse la limite physique de la cible, elle est immobilisée.') },
  { id: 'push', name: tk('Repousser'), en: 'Push', kind: 'melee', type: 'simple', noDamage: true, source: 'RG', page: 123,
    note: tk('Action simple, pas de dommages : la cible est repoussée hors d’allonge.') },
  { id: 'clinch', name: tk('Accrochage'), en: 'Clinch', kind: 'test', type: 'simple', unlock: ['Clinch', 'Accrochage'], attr: 'AGI', skillId: 'gymnastics', limit: 'physical',
    noDamage: true, source: 'RG', page: 119, note: tk('AGI + Gymnastique contre RÉA + INT : position supérieure, la cible ne peut pas s’éloigner.') },
  { id: 'kip-up', name: tk('Kip-Up'), en: 'Kip-Up', kind: 'test', type: 'simple', unlock: ['Kip-Up'], attr: 'AGI', skillId: 'gymnastics', limit: 'physical', threshold: 3,
    source: 'RG', page: 122, note: tk('AGI + Gymnastique (3) : se relever et attaquer aussitôt une cible proche.') },
  { id: 'reading-defense', name: tk('Lire la défense'), en: 'Reading the Defense', kind: 'test', type: 'complex', attr: 'INT', weaponSkill: true, limit: 'mental', threshold: 3,
    source: 'RG', page: 123, note: tk('INT + compétence de l’arme (3) : +3 dés à la prochaine attaque de mêlée contre la cible (−1 en cas d’échec).') },
];
export const ACTION_BY_ID: Record<string, CombatActionDef> = Object.fromEntries(COMBAT_ACTIONS.map((a) => [a.id, a]));

/**
 * Defense options (interrupts and R&G « Defender » qualities), SR5 p. 190-191 / RG 127. `bonus(actor, ctx)` = dice added;
 * melee: melee attacks only; turn: lasts the rest of the Combat Turn (paid once).
 */
export const DEFENSE_OPTIONS: DefenseOptionDef[] = [
  { id: 'dodge', name: tk('Esquive'), en: 'Dodge', ini: 5, skill: 'gymnastics', source: 'SR5', page: 191 },
  { id: 'parry', name: tk('Parade'), en: 'Parry', ini: 5, melee: true, skill: 'weapon', source: 'SR5', page: 191 },
  { id: 'block', name: tk('Blocage'), en: 'Block', ini: 5, melee: true, skill: 'unarmed_combat', source: 'SR5', page: 191 },
  { id: 'full', name: tk('Défense totale'), en: 'Full Defense', ini: 10, turn: true, attr: 'WIL', source: 'SR5', page: 191 },
  { id: 'agile', name: tk('Défenseur agile'), en: 'Agile Defender', ini: 10, turn: true, attr: 'AGI', unlock: ['Agile Defender', 'Défenseur agile'], source: 'RG', page: 127 },
  { id: 'acrobatic', name: tk('Défenseur acrobatique'), en: 'Acrobatic Defender', ini: 10, turn: true, skill: 'gymnastics', unlock: ['Acrobatic Defender', 'Défenseur acrobatique'], source: 'RG', page: 127 },
  { id: 'perceptive', name: tk('Défenseur perspicace'), en: 'Perceptive Defender', ini: 10, turn: true, skill: 'perception', unlock: ['Perceptive Defender', 'Défenseur perspicace'], source: 'RG', page: 127 },
  { id: 'pretty', name: tk('Trop beau pour être touché'), en: 'Too Pretty to Hit', ini: 10, turn: true, attr: 'CHA', unlock: ['Too Pretty to Hit', 'Trop beau pour être touché'], source: 'RG', page: 127 },
];
export const DEFENSE_BY_ID: Record<string, DefenseOptionDef> = Object.fromEntries(DEFENSE_OPTIONS.map((o) => [o.id, o]));

/** Situational defense modifiers the defender chooses (SR5 p. 189). */
export const DEFENSE_SITUATIONS: DefenseSituationDef[] = [
  { id: 'cover-partial', name: tk('Couvert partiel'), value: 2 },
  { id: 'cover-good', name: tk('Bon couvert'), value: 4 },
  { id: 'running', name: tk('Défenseur en course'), value: 2 },
  { id: 'prone', name: tk('Défenseur à terre'), value: -2 },
  { id: 'in-melee', name: tk('En mêlée, visé à distance'), value: -3, ranged: true },
  { id: 'vehicle', name: tk('Dans un véhicule en mouvement'), value: 3 },
];
export const SITUATION_BY_ID: Record<string, DefenseSituationDef> = Object.fromEntries(DEFENSE_SITUATIONS.map((o) => [o.id, o]));

/** Names an actor has that may unlock an action: qualities, adept powers, martial arts and their techniques (French, English, notes « Agile Defender · RG 127 »). */
export function unlockNames(actor: ActorLike | null | undefined): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const n = norm(v);
    if (n) out.add(n);
  };
  const addItem = (it: { name?: string; nameFr?: string; nameEn?: string; notes?: string } | null | undefined) => {
    if (!it) return;
    add(it.name);
    add(it.nameFr);
    add(it.nameEn);
    if (it.notes) add(String(it.notes).split(/\s+[·|]\s+/)[0]);
  };
  for (const q of actor?.qualities || []) addItem(q);
  for (const p of actor?.powers || []) addItem(p);
  for (const m of actor?.martialArts || []) {
    addItem(m);
    for (const tq of m.techniques || []) addItem(tq);
  }
  return out;
}

/** Is this action / defense option available to the actor (no unlock needed, or a matching technique / quality)? */
export function isUnlocked(def: { unlock?: string[] } | null | undefined, actor: ActorLike | null | undefined, names: Set<string> | null = null): boolean {
  if (!def?.unlock?.length) return true;
  const have = names || unlockNames(actor);
  return def.unlock.some((u) => have.has(norm(u)));
}

/** Actions usable with this weapon (kind / fire mode), unlocked ones first. allowLocked: the GM sees every action. */
export function actionsForWeapon(
  actor: ActorLike | null | undefined,
  w: WeaponLike | null | undefined,
  { allowLocked = false, fireIds = null }: { allowLocked?: boolean; fireIds?: string[] | null } = {},
): Array<CombatActionDef & { locked: boolean }> {
  const names = unlockNames(actor);
  const melee = w?.kind === 'melee';
  return COMBAT_ACTIONS.filter((a) => {
    if (a.kind === 'test') return false;
    if (a.kind === 'melee' && !melee) return false;
    if (a.kind === 'ranged' && melee) return false;
    if (a.fire && fireIds && !fireIds.includes(a.fire)) return false;
    return allowLocked || isUnlocked(a, actor, names);
  }).map((a) => ({ ...a, locked: !isUnlocked(a, actor, names) }));
}

/** Special actions an actor has unlocked (techniques / qualities): shown on the sheet's Combat tab. */
export function unlockedActions(actor: ActorLike | null | undefined): { actions: CombatActionDef[]; defenses: DefenseOptionDef[] } {
  const names = unlockNames(actor);
  return {
    actions: COMBAT_ACTIONS.filter((a) => a.unlock?.length && isUnlocked(a, actor, names)),
    defenses: DEFENSE_OPTIONS.filter((o) => o.unlock?.length && isUnlocked(o, actor, names)),
  };
}

// ---------------------------------------------------------------------------
// Defense pool (shared preview / server)
// ---------------------------------------------------------------------------
const skillRating = (actor: ActorLike | null | undefined, id: string | undefined): number => num((actor?.skills || []).find((s) => s && s.id === id)?.rating, 0);
/** Best ready melee weapon of the defender (parry skill, reach). */
export function bestMeleeWeapon(actor: ActorLike | null | undefined): Weapon | null {
  let best: { w: Weapon; rating: number } | null = null;
  for (const w of actor?.weapons || []) {
    if (!w || w.kind !== 'melee' || w.equipped === false) continue;
    const r = skillRating(actor, w.skill);
    if (!best || r > best.rating || (r === best.rating && num(w.reach) > num(best.w.reach))) best = { w, rating: r };
  }
  return best?.w || null;
}
/** Natural reach: trolls +1 (SR5 p. 184). */
export const metatypeReach = (actor: ActorLike | null | undefined): number => (/troll/i.test(String(actor?.metatype || '')) ? 1 : 0);

/**
 * Dice lines of a defense test besides REA + INT (the roll adds wounds and gear modifiers itself).
 * attack: { kind: 'melee'|'ranged'|'blast', defenseMod, actionDefense, reach }; opts: { options: [ids], situations: [ids], prior: n,
 * turnBoosts: [ids already paid this turn] }. Returns { lines: [{ label, value, key }], ini, paid: [ids paying initiative], unavailable }.
 */
export function defenseLines(
  actor: ActorLike | null | undefined,
  attack: DefenseAttack | null | undefined,
  opts: DefenseLineOptions = {},
): { lines: DefenseLine[]; ini: number; paid: string[] } {
  const lines: DefenseLine[] = [];
  let ini = 0;
  const paid: string[] = [];
  const melee = attack?.kind === 'melee';
  const names = unlockNames(actor);
  const chosen = new Set([...(opts.options || []), ...(opts.turnBoosts || [])]);
  const boosts = new Set(opts.turnBoosts || []);
  // Only one active defense (dodge / parry / block) per attack.
  let active = false;
  for (const o of DEFENSE_OPTIONS) {
    if (!chosen.has(o.id)) continue;
    if (o.melee && !melee) continue;
    if (!isUnlocked(o, actor, names)) continue;
    if (!o.turn) {
      if (active) continue;
      active = true;
    }
    let v = 0;
    if (o.attr) v = attr(actor, o.attr);
    else if (o.skill === 'weapon') {
      const w = bestMeleeWeapon(actor);
      v = w ? skillRating(actor, w.skill) : 0;
    } else v = skillRating(actor, o.skill);
    lines.push({ label: o.name, value: v, key: o.id });
    if (!boosts.has(o.id)) {
      ini += o.ini;
      paid.push(o.id);
    }
  }
  if (num(attack?.defenseMod)) lines.push({ label: attack!.defenseLabel || tk('mode de tir'), value: num(attack!.defenseMod), key: 'fire' });
  if (num(attack?.actionDefense)) lines.push({ label: attack!.actionName || tk('action'), value: num(attack!.actionDefense), key: 'action' });
  if (attack?.kind === 'blast') lines.push({ label: tk('Attaque de zone'), value: -2, key: 'area' });
  if (melee) {
    const myW = bestMeleeWeapon(actor);
    const diff = num(myW?.reach) + metatypeReach(actor) - num(attack?.reach);
    if (diff) lines.push({ label: tk('différence d’allonge'), value: diff, key: 'reach' });
  }
  for (const id of opts.situations || []) {
    const s = SITUATION_BY_ID[id];
    if (!s || (s.ranged && melee)) continue;
    lines.push({ label: s.name, value: s.value, key: id });
  }
  if (num(opts.prior) > 0) lines.push({ label: tk('défenses précédentes ce tour'), value: -num(opts.prior), key: 'prior' });
  return { lines: lines.filter((l) => l.value), ini, paid };
}

/** Damage type after soak: Physical becomes Stun when the modified DV is lower than the modified armor (SR5 p. 168). */
export function finalDamageType(type: DamageType | string, modifiedDv: number, modifiedArmor: number): DamageType {
  if (type === 'S') return 'S';
  return modifiedDv < modifiedArmor ? 'S' : 'P';
}
