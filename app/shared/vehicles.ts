// SR5 vehicle and rigging rules, pure (server and browser): effective stats, condition monitor, control modes, the Vehicle
// Test's pool / limit / threshold (SR5 p. 199-201), Gunnery (p. 183), sensors (p. 184), ramming (p. 203), chase ranges
// (p. 203-205), drone initiative and autosofts (p. 269-270), rigging limits and thresholds (p. 201, 266).
// The server (34-vehicles, 33-attacks) rolls with these plans; the sheet previews them.
import { attr, SKILL_BY_ID } from './sr5.ts';
import type { ActorLike, Autosoft, AutosoftKind, ChaseEnvironment, ChaseRange, Vehicle, VehicleControl, Weapon } from './types.ts';

/** Marks a dictionary key for the i18n checker (rendered with t() by the client). */
const tk = (s: string): string => s;
/** A vehicle as stored, or a partial one (sheet editor previews). */
type VehicleLike = Partial<Vehicle> | null | undefined;
/** One line of a pool / limit / threshold breakdown: a dictionary key + value. */
export interface PlanLine {
  label: string;
  value: number;
}

export const VEHICLE_CONTROLS: VehicleControl[] = ['manual', 'remote', 'rigged', 'auto'];
export const CONTROL_LABELS: Record<VehicleControl, string> = { manual: tk('Manual'), remote: tk('Remote control'), rigged: tk('Jumped in'), auto: tk('Autopilot') };
export const AUTOSOFT_KINDS: AutosoftKind[] = ['maneuvering', 'targeting', 'clearsight', 'evasion', 'stealth', 'electronicWarfare'];
export const AUTOSOFT_LABELS: Record<AutosoftKind, string> = {
  maneuvering: tk('Maneuvering'), targeting: tk('Targeting'), clearsight: tk('Clearsight'), evasion: tk('Evasion'), stealth: tk('Stealth'), electronicWarfare: tk('Electronic Warfare'),
};
/** Vehicle skills (SR5 p. 146). */
export const VEHICLE_SKILLS = ['pilot_ground_craft', 'pilot_aircraft', 'pilot_watercraft', 'pilot_walker', 'pilot_aerospace'] as const;

const n0 = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/[^-\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
/** '4/3' → [4, 3] (on-road / off-road); '4' → [4, 4]. */
export function splitStat(v: unknown): [number, number] {
  const parts = String(v ?? '').split('/');
  const on = n0(parts[0]);
  return [on, parts.length > 1 ? n0(parts[1]) : on];
}

/** Drone: the explicit flag, else its name / category says so. */
export function isDrone(v: VehicleLike): boolean {
  if (typeof v?.drone === 'boolean') return v.drone;
  return /drone/i.test(`${v?.categoryEn || ''} ${v?.name || ''} ${v?.nameEn || ''}`);
}

/** Vehicle skill id of a vehicle: its own, else guessed (aircraft, boats, walkers, anthro drones), else Pilot Ground Craft. */
export function vehicleSkillId(v: VehicleLike): string {
  if (v?.skill && (VEHICLE_SKILLS as readonly string[]).includes(v.skill)) return v.skill;
  const s = `${v?.categoryEn || ''} ${v?.categoryFr || ''} ${v?.name || ''} ${v?.nameEn || ''} ${v?.notes || ''}`.toLowerCase();
  if (/aerospace|suborbital|semiballistic/.test(s)) return 'pilot_aerospace';
  if (/type\s*:\s*air|aircraft|rotor|vtol|vstol|ltav|wing|copter|plane|blimp|zeppelin|dirigible|skimmer|fly|\bair\b|a[ée]rien|avion|h[ée]lico/.test(s)) return 'pilot_aircraft';
  if (/type\s*:\s*(water|aquatic)|boat|submarine|ship|yacht|watercraft|hydrofoil|bateau|sous-marin/.test(s)) return 'pilot_watercraft';
  if (/anthro|walker|marcheur/.test(s)) return 'pilot_walker';
  return 'pilot_ground_craft';
}

/** Sum of the installed mods' stat effects (vehicles[].mods[].effects, evaluated at their rating). */
function modBonus(v: VehicleLike, key: string): number {
  return (Array.isArray(v?.mods) ? v.mods : []).reduce((s, m) => s + (Number((m?.effects as Record<string, number> | undefined)?.[key]) || 0), 0);
}

/** Effective stats: stored values + mods. Handling / Speed keep their on-road / off-road values. */
export interface VehicleStatsOut {
  handling: number;
  handlingOff: number;
  speed: number;
  speedOff: number;
  accel: number;
  body: number;
  armor: number;
  pilot: number;
  sensor: number;
  seats: number;
}
export function vehicleStats(v: VehicleLike): VehicleStatsOut {
  const [h, hOff] = splitStat(v?.handling);
  const [sp, spOff] = splitStat(v?.speed);
  const [ac] = splitStat(v?.accel);
  const hb = modBonus(v, 'handling');
  const sb = modBonus(v, 'speed');
  return {
    handling: h + hb, handlingOff: hOff + hb, speed: sp + sb, speedOff: spOff + sb, accel: ac + modBonus(v, 'accel'),
    body: n0(v?.body) + modBonus(v, 'body'), armor: n0(v?.armor) + modBonus(v, 'armor'), pilot: n0(v?.pilot) + modBonus(v, 'pilot'),
    sensor: n0(v?.sensor) + modBonus(v, 'sensor'), seats: n0(v?.seats) + modBonus(v, 'seats'),
  };
}

/** Condition monitor: 12 + Body/2 (drones 6 + Body/2), rounded up (SR5 p. 199). */
export function vehicleMonitor(v: VehicleLike): number {
  return (isDrone(v) ? 6 : 12) + Math.ceil(vehicleStats(v).body / 2);
}
export const vehicleDamage = (v: VehicleLike): number => Math.max(0, Math.round(Number(v?.damage) || 0));
/** Damage modifier (−1 per 3 boxes), applied to the Handling of the vehicle (SR5 p. 201). */
export const vehicleDamageMod = (v: VehicleLike): number => -Math.floor(vehicleDamage(v) / 3);
export const vehicleDestroyed = (v: VehicleLike): boolean => vehicleDamage(v) >= vehicleMonitor(v);

export const controlOf = (v: VehicleLike): VehicleControl => (VEHICLE_CONTROLS.includes(v?.control as VehicleControl) ? (v!.control as VehicleControl) : 'manual');
/** A rigger can jump in: drones always, other vehicles once fitted with a rigger interface (SR5 p. 265). */
export const hasRiggerInterface = (v: VehicleLike): boolean => isDrone(v) || !!v?.riggerInterface || (v?.mods || []).some((m) => /rigger\s*interface|interface\s*de\s*rigg/i.test(`${m?.name} ${m?.nameEn || ''}`));

/** Best autosoft of a kind on the vehicle ([Weapon] Targeting: one for that weapon, or one without a target). */
export function autosoftRating(v: VehicleLike, kind: AutosoftKind, weapon?: Pick<Weapon, 'name'> & { nameEn?: string; nameFr?: string } | null): number {
  const list = (Array.isArray(v?.autosofts) ? v.autosofts : []).filter((a): a is Autosoft => !!a && a.kind === kind);
  const fits = (a: Autosoft): boolean => {
    if (kind !== 'targeting' || !weapon || !a.target?.trim()) return true;
    const t = a.target.trim().toLowerCase();
    return [weapon.name, weapon.nameEn, weapon.nameFr].some((n) => !!n && (n.toLowerCase().includes(t) || t.includes(n.toLowerCase())));
  };
  return Math.max(0, ...list.filter(fits).map((a) => Math.max(0, Math.min(12, Math.round(Number(a.rating) || 0)))));
}

/** Control rig rating of an actor (implant rating; Mind over Machine / MMRI count as rating 1, SR5 p. 258). 0 = none. */
export function controlRigRating(actor: ActorLike | null | undefined): number {
  let r = 0;
  for (const a of actor?.augmentations || []) {
    if (!a || a.disabled || !/control\s*rig|rig\s*de\s*contr[ôo]le|r[ée]seau\s*de\s*contr[ôo]le/i.test(`${a.name} ${a.nameEn || ''}`)) continue;
    r = Math.max(r, Math.round(Number(a.rating) || 1));
  }
  for (const q of [...(actor?.qualities || []), ...(actor?.complexForms || [])] as Array<{ name?: string } | null>) {
    if (q && /mind\s*over\s*machine|esprit.*machine|\bmmri\b/i.test(q.name || '')) r = Math.max(r, 1);
  }
  return r;
}

/** Movement rates (m / Combat Turn) by Speed (Movement Rates Table, SR5 p. 202): [walking, running]. */
export function movementRate(speed: number): [number, number] {
  const s = Math.max(0, Math.min(10, Math.round(speed)));
  if (s <= 0) return [0, 0];
  const walk = s === 1 ? 5 : s === 2 ? 10 : 20 * 2 ** (s - 3);
  return [walk, walk * 2];
}

/** Ramming Damage Table (SR5 p. 203): DV from the rammer's Body and speed in m / turn. */
export function ramDamage(body: number, metersPerTurn: number): number {
  const m = Math.max(0, metersPerTurn);
  const factor = m <= 10 ? 0.5 : m <= 50 ? 1 : m <= 200 ? 2 : m <= 300 ? 3 : m <= 500 ? 5 : 10;
  return Math.ceil(Math.max(0, body) * factor);
}

/** Vehicle Test thresholds (SR5 p. 199) and Terrain Modifiers (p. 201). */
export const VEHICLE_THRESHOLDS: Array<{ id: string; label: string; value: number }> = [
  { id: 'easy', label: tk('Easy'), value: 1 }, { id: 'average', label: tk('Average'), value: 2 }, { id: 'hard', label: tk('Hard'), value: 3 }, { id: 'extreme', label: tk('Extreme'), value: 4 },
];
export const TERRAINS: Array<{ value: number; label: string; hint: string }> = [
  { value: 0, label: tk('terrain::Open'), hint: tk('Highways, flat plains, open sea, clear sky') },
  { value: 1, label: tk('terrain::Light'), hint: tk('Main streets, rolling hills, docks, intra-city air traffic') },
  { value: 2, label: tk('terrain::Restricted'), hint: tk('Side streets, light woods, light traffic, low altitude') },
  { value: 4, label: tk('terrain::Tight'), hint: tk('Back alleys, heavy woods, high traffic, street-level flying') },
];

/** Chase Ranges Table (SR5 p. 204): approximate metres per environment. */
export const CHASE_RANGES: ChaseRange[] = ['short', 'medium', 'long', 'extreme'];
export const CHASE_RANGE_LABELS: Record<ChaseRange, string> = { short: tk('chase::Short'), medium: tk('chase::Medium'), long: tk('chase::Long'), extreme: tk('chase::Extreme') };
export const CHASE_RANGE_METERS: Record<ChaseEnvironment, Record<ChaseRange, string>> = {
  speed: { short: '0-10', medium: '11-50', long: '51-150', extreme: '151-300' },
  handling: { short: '0-5', medium: '6-20', long: '21-80', extreme: '81-150' },
};
/** Shift a range by n categories (+ = farther). Beyond Extreme → 'lost'. */
export function shiftRange(r: ChaseRange | undefined, n: number): ChaseRange | 'lost' {
  const i = CHASE_RANGES.indexOf(r || 'medium') + n;
  if (i > CHASE_RANGES.length - 1) return 'lost';
  return CHASE_RANGES[Math.max(0, i)];
}
/** Chase actions (SR5 p. 204-205): which ranges allow them. */
export const CHASE_ACTIONS = ['catchUp', 'breakAway', 'cutOff', 'ram', 'stunt'] as const;
export type ChaseActionId = (typeof CHASE_ACTIONS)[number];
export const CHASE_ACTION_LABELS: Record<ChaseActionId, string> = { catchUp: tk('Catch-up'), breakAway: tk('Break away'), cutOff: tk('Cut-off'), ram: tk('Ram'), stunt: tk('Stunt') };
export const chaseActionNeedsShort = (a: ChaseActionId): boolean => a === 'cutOff' || a === 'ram';

/** Drone acting on its own: Pilot × 2 + 4D6 (SR5 p. 270). */
export function droneInitiative(v: VehicleLike): { base: number; dice: number } {
  return { base: vehicleStats(v).pilot * 2, dice: 4 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Test plans
// ---------------------------------------------------------------------------------------------------------------------

/** What the server needs to know about the one who controls the vehicle. */
export interface ControllerInfo {
  /** Control rig rating (0 = none). */
  rig: number;
  /** Persona in VR (cold / hot sim): remote control adds +2 to the limits instead of +1; hot sim +1 die when jumped in. */
  vr: boolean;
  hot: boolean;
  /** Data Processing of the commlink / RCC: caps the limits of remote control (Control Device, SR5 p. 238). */
  dataProcessing: number;
}
export const NO_CONTROLLER: ControllerInfo = { rig: 0, vr: false, hot: false, dataProcessing: 0 };

/** Who rolls: the driver's own skill and attribute, or the vehicle's Pilot + autosoft. */
export type RollerPlan =
  | { kind: 'driver'; skillId: string; attr: 'REA' | 'INT' | 'AGI' | 'LOG'; capSkillAt?: number }
  | { kind: 'pilot'; pool: number; lines: PlanLine[] };

export interface VehicleTestPlan {
  roller: RollerPlan;
  /** Trusted extra pool lines (hot sim, uncontrolled vehicle…). */
  bonus: PlanLine[];
  limit: number | null;
  /** 'handling' | 'speed' | 'sensor' | 'accuracy' — the limit's dictionary key. */
  limitLabel: string;
  limitLines: PlanLine[];
  threshold: number | null;
  thresholdLines: PlanLine[];
}

export type VehicleTestKind = 'control' | 'perception' | 'stealth' | 'pilot';
export interface VehicleTestOpts {
  /** Chase environment: Speed → the Speed limit (SR5 p. 204). Default handling. */
  env?: ChaseEnvironment;
  offRoad?: boolean;
  /** Base threshold (Vehicle Test Threshold Table) and terrain modifier. */
  threshold?: number | null;
  terrain?: number;
}

/** Interface limit bonus: AR +1, VR +2, jumped in +2 (VR) + control rig (SR5 p. 201, 266). */
function interfaceLines(control: VehicleControl, v: VehicleLike, c: ControllerInfo): PlanLine[] {
  if (control === 'rigged') return [{ label: tk('VR'), value: 2 }, ...(c.rig ? [{ label: tk('control rig'), value: c.rig }] : [])];
  if (control === 'remote') return [{ label: c.vr ? 'VR' : 'AR', value: c.vr ? 2 : 1 }];
  if (control === 'manual' && v?.ar) return [{ label: tk('AR'), value: 1 }];
  return [];
}

/** A limit from its base and lines, never below 1; remote control caps it at the Data Processing. */
function buildLimit(base: { label: string; value: number }, lines: PlanLine[], control: VehicleControl, c: ControllerInfo): { limit: number; lines: PlanLine[] } {
  const all = [base, ...lines.filter((l) => l.value)];
  let limit = Math.max(1, all.reduce((s, l) => s + l.value, 0));
  if (control === 'remote' && c.dataProcessing > 0 && c.dataProcessing < limit) {
    all.push({ label: tk('Data Processing'), value: c.dataProcessing - limit });
    limit = c.dataProcessing;
  }
  return { limit, lines: all };
}

/** Handling (or Speed in a Speed environment) limit with the damage modifier and the interface bonus. */
export function controlLimit(v: VehicleLike, control: VehicleControl, c: ControllerInfo, env: ChaseEnvironment = 'handling', offRoad = false): { limit: number; label: string; lines: PlanLine[] } {
  const st = vehicleStats(v);
  if (env === 'speed') {
    const r = buildLimit({ label: tk('Speed'), value: offRoad ? st.speedOff : st.speed }, interfaceLines(control, v, c), control, c);
    return { ...r, label: 'speed' };
  }
  const base = offRoad ? st.handlingOff : st.handling;
  const dmg = vehicleDamageMod(v);
  // A damaged vehicle: its damage modifier lowers the Handling, minimum 1 (SR5 p. 201).
  const lines: PlanLine[] = dmg ? [{ label: tk('damage'), value: Math.max(dmg, 1 - base) }] : [];
  const r = buildLimit({ label: tk('Handling'), value: base }, [...lines, ...interfaceLines(control, v, c)], control, c);
  return { ...r, label: 'handling' };
}

/** Threshold: base + terrain, minus the control rig rating when jumped in (minimum 1, SR5 p. 201). */
export function controlThreshold(base: number | null | undefined, terrain: number, control: VehicleControl, c: ControllerInfo): { threshold: number | null; lines: PlanLine[] } {
  if (base === null || base === undefined || !Number.isFinite(Number(base))) return { threshold: null, lines: [] };
  const lines: PlanLine[] = [{ label: tk('threshold'), value: Math.max(0, Math.round(Number(base))) }];
  if (terrain) lines.push({ label: tk('terrain'), value: terrain });
  let t = lines.reduce((s, l) => s + l.value, 0);
  if (control === 'rigged' && c.rig) {
    const after = Math.max(1, t - c.rig);
    if (after !== t) lines.push({ label: tk('control rig'), value: after - t });
    t = after;
  }
  return { threshold: t, lines };
}

/** Pool lines that every test of a jumped-in rigger gets: hot sim +1 (SR5 p. 266). */
function riggerBonus(control: VehicleControl, c: ControllerInfo): PlanLine[] {
  return control === 'rigged' && c.hot ? [{ label: tk('hot sim'), value: 1 }] : [];
}

/** Pilot + autosoft roller (drone on autopilot). */
function pilotRoller(v: VehicleLike, kind: AutosoftKind, softLabel: string): RollerPlan {
  const st = vehicleStats(v);
  const soft = autosoftRating(v, kind);
  const lines: PlanLine[] = [{ label: tk('Pilot'), value: st.pilot }, ...(soft ? [{ label: softLabel, value: soft }] : [])];
  return { kind: 'pilot', pool: st.pilot + soft, lines };
}

/**
 * A vehicle test of the sheet:
 * - control: Vehicle Skill + REA [Handling or Speed] (threshold + terrain), autopilot Pilot + Maneuvering (SR5 p. 199, 269);
 * - perception: Perception + INT [Sensor], autopilot Pilot + Clearsight [Sensor] (p. 184, 270);
 * - stealth: Sneaking (max the vehicle skill) + REA [Handling], jumped in Sneaking + INT, autopilot Pilot + Stealth (p. 184, 270);
 * - pilot: the Pilot program facing something new, Pilot × 2, no limit (p. 269).
 */
export function vehicleTestPlan(v: VehicleLike, test: VehicleTestKind, c: ControllerInfo, driver: ActorLike | null, opts: VehicleTestOpts = {}): VehicleTestPlan {
  const control = controlOf(v);
  const auto = control === 'auto' || !driver;
  const st = vehicleStats(v);
  const skillId = vehicleSkillId(v);
  if (test === 'pilot') {
    return { roller: { kind: 'pilot', pool: st.pilot * 2, lines: [{ label: tk('Pilot × 2'), value: st.pilot * 2 }] }, bonus: [], limit: null, limitLabel: '', limitLines: [], ...thresholdOf(opts, 0, control, NO_CONTROLLER) };
  }
  if (test === 'perception') {
    const roller: RollerPlan = auto ? pilotRoller(v, 'clearsight', tk('Clearsight')) : { kind: 'driver', skillId: 'perception', attr: 'INT' };
    const lim = buildLimit({ label: tk('Sensor'), value: st.sensor }, control === 'rigged' && c.rig ? [{ label: tk('control rig'), value: c.rig }] : [], auto ? 'auto' : control, c);
    return { roller, bonus: auto ? [] : riggerBonus(control, c), limit: lim.limit, limitLabel: 'sensor', limitLines: lim.lines, ...thresholdOf(opts, 0, control, NO_CONTROLLER) };
  }
  const lim = controlLimit(v, auto ? 'auto' : control, c, opts.env || 'handling', !!opts.offRoad);
  if (test === 'stealth') {
    const sk = (driver?.skills || []).find((s) => s?.id === skillId);
    const roller: RollerPlan = auto
      ? pilotRoller(v, 'stealth', tk('Stealth'))
      : { kind: 'driver', skillId: 'sneaking', attr: control === 'rigged' ? 'INT' : 'REA', capSkillAt: Number(sk?.rating) || 0 };
    return { roller, bonus: auto ? [] : riggerBonus(control, c), limit: lim.limit, limitLabel: lim.label, limitLines: lim.lines, ...thresholdOf(opts, 0, control, NO_CONTROLLER) };
  }
  const roller: RollerPlan = auto ? pilotRoller(v, 'maneuvering', tk('Maneuvering')) : { kind: 'driver', skillId, attr: 'REA' };
  return { roller, bonus: auto ? [] : riggerBonus(control, c), limit: lim.limit, limitLabel: lim.label, limitLines: lim.lines, ...thresholdOf(opts, opts.terrain || 0, auto ? 'auto' : control, c) };
}
function thresholdOf(opts: VehicleTestOpts, terrain: number, control: VehicleControl, c: ControllerInfo): { threshold: number | null; thresholdLines: PlanLine[] } {
  const r = controlThreshold(opts.threshold, terrain, control, c);
  return { threshold: r.threshold, thresholdLines: r.lines };
}

/** Defense of a vehicle against an attack (SR5 p. 205): the driver's REA + INT, a drone Pilot + Maneuvering [Handling]. */
export function vehicleDefensePlan(v: VehicleLike, c: ControllerInfo, driver: ActorLike | null): VehicleTestPlan {
  const control = controlOf(v);
  if (control === 'auto' || control === 'remote' || !driver) {
    const lim = controlLimit(v, control === 'remote' ? 'auto' : control, NO_CONTROLLER);
    return { roller: pilotRoller(v, 'maneuvering', tk('Maneuvering')), bonus: [], limit: lim.limit, limitLabel: lim.label, limitLines: lim.lines, threshold: null, thresholdLines: [] };
  }
  return { roller: { kind: 'driver', skillId: '', attr: 'REA' }, bonus: riggerBonus(control, c), limit: null, limitLabel: '', limitLines: [], threshold: null, thresholdLines: [] };
}

/**
 * Gunnery with a vehicle-mounted weapon (SR5 p. 183-184): manual Gunnery + AGI [Accuracy], remote / jumped in Gunnery +
 * LOG [Accuracy] (jumped in: + control rig; remote: max Data Processing), autopilot Pilot + [Weapon] Targeting [Accuracy]
 * (no autosoft = cannot fire). Passive targeting: Gunnery + LOG [Sensor].
 * → { attr, pilot (autopilot pool), limitAdd / limitMax / limitReplace for the weapon's computed Accuracy }.
 */
export interface GunneryPlan {
  roller: RollerPlan;
  bonus: PlanLine[];
  /** Added to the weapon's Accuracy (control rig). */
  limitAdd: number;
  /** Cap (remote control: Data Processing). */
  limitMax: number | null;
  /** Replaces the Accuracy (passive targeting: Sensor). */
  limitReplace: number | null;
  limitLabel: string;
  /** Autopilot without a Targeting autosoft for this weapon. */
  impossible?: boolean;
}
export function gunneryPlan(v: VehicleLike, weapon: (Pick<Weapon, 'name'> & { nameEn?: string; nameFr?: string }) | null, c: ControllerInfo, driver: ActorLike | null, { passive = false }: { passive?: boolean } = {}): GunneryPlan {
  const control = controlOf(v);
  const st = vehicleStats(v);
  const rigAdd = control === 'rigged' ? c.rig : 0;
  const sensor = passive ? st.sensor + rigAdd : null;
  const limitMax = control === 'remote' && c.dataProcessing > 0 ? c.dataProcessing : null;
  if (control === 'auto' || !driver) {
    const soft = autosoftRating(v, 'targeting', weapon);
    return {
      roller: { kind: 'pilot', pool: st.pilot + soft, lines: [{ label: tk('Pilot'), value: st.pilot }, { label: tk('Targeting'), value: soft }] }, bonus: [],
      limitAdd: 0, limitMax: null, limitReplace: passive ? st.sensor : null, limitLabel: passive ? 'sensor' : 'accuracy', impossible: !soft,
    };
  }
  const attrKey = control === 'manual' && !passive ? 'AGI' : 'LOG';
  return {
    roller: { kind: 'driver', skillId: 'gunnery', attr: attrKey }, bonus: riggerBonus(control, c),
    limitAdd: passive ? 0 : rigAdd, limitMax, limitReplace: sensor, limitLabel: passive ? 'sensor' : 'accuracy',
  };
}

/** Pool of a driver roller as the sheet previews it (skill + attribute; the server recomputes with every modifier). */
export function previewDriverPool(driver: ActorLike | null, roller: RollerPlan): number {
  if (roller.kind === 'pilot') return roller.pool;
  if (!driver) return 0;
  const a = attr(driver, roller.attr);
  if (!roller.skillId) return a + attr(driver, 'INT');
  const sk = (driver.skills || []).find((s) => s?.id === roller.skillId);
  const def = SKILL_BY_ID[roller.skillId];
  let rating = Number(sk?.rating) || 0;
  if (roller.capSkillAt !== undefined) rating = Math.min(rating, roller.capSkillAt);
  if (!rating) return def && !def.def ? 0 : Math.max(0, a - 1);
  return rating + a;
}

/** Crash damage (SR5 p. 201-202): DV = the vehicle's Body, AP −6; a character takes Stun when the Body is below their armor. */
export function crashDamage(v: VehicleLike): { dv: number; ap: number } {
  return { dv: vehicleStats(v).body, ap: -6 };
}
