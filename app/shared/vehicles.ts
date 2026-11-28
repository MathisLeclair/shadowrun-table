// SR5 vehicle and rigging rules, pure (server and browser): effective stats, condition monitor, control modes, the Vehicle
// Test's pool / limit / threshold (SR5 p. 199-201), Gunnery (p. 183), sensors (p. 184), ramming (p. 203), chase ranges
// (p. 203-205), drone initiative and autosofts (p. 269-270), rigging limits and thresholds (p. 201, 266).
// The server (34-vehicles, 33-attacks) rolls with these plans; the sheet previews them.
import { attr, SKILL_BY_ID } from './sr5.ts';
import type { ActorLike, Autosoft, AutosoftKind, ChaseEnvironment, ChaseRange, Vehicle, VehicleBreakdowns, VehicleControl, Weapon } from './types.ts';

/** Marks a dictionary key for the i18n checker (rendered with t() by the client). */
const tk = (s: string): string => s;
/** A vehicle as stored, or a partial one (sheet editor previews). */
type VehicleLike = (Partial<Vehicle> & { swarmBonus?: number }) | null | undefined;
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
    // A broken axle (Run & Gun p. 115) leaves Speed 1.
    handling: h + hb, handlingOff: hOff + hb, speed: v?.breakdowns?.axle ? Math.min(1, sp + sb) : sp + sb, speedOff: v?.breakdowns?.axle ? Math.min(1, spOff + sb) : spOff + sb, accel: ac + modBonus(v, 'accel'),
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
  // A swarm adds (drones − 1) to its limits (Rigger 5.0 p. 31).
  if (v?.swarmBonus) return [{ label: tk('swarm'), value: v.swarmBonus }];
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
/** Swarm dice (Rigger 5.0 p. 31) and flat tires (−2 each on Vehicle Tests, SR5 p. 205). */
function vehicleLines(v: VehicleLike, test: 'control' | 'other'): PlanLine[] {
  const out: PlanLine[] = [];
  if (v?.swarmBonus) out.push({ label: tk('swarm'), value: v.swarmBonus });
  const tires = Math.max(0, Math.round(Number(v?.breakdowns?.tires) || 0));
  if (test === 'control' && tires) out.push({ label: tk('flat tires'), value: -2 * tires });
  return out;
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
    const lim = buildLimit({ label: tk('Sensor'), value: st.sensor }, [...(control === 'rigged' && c.rig ? [{ label: tk('control rig'), value: c.rig }] : []), ...(v?.swarmBonus ? [{ label: tk('swarm'), value: v.swarmBonus }] : [])], auto ? 'auto' : control, c);
    return { roller, bonus: [...(auto ? [] : riggerBonus(control, c)), ...vehicleLines(v, 'other')], limit: lim.limit, limitLabel: 'sensor', limitLines: lim.lines, ...thresholdOf(opts, 0, control, NO_CONTROLLER) };
  }
  const lim = controlLimit(v, auto ? 'auto' : control, c, opts.env || 'handling', !!opts.offRoad);
  if (test === 'stealth') {
    const sk = (driver?.skills || []).find((s) => s?.id === skillId);
    const roller: RollerPlan = auto
      ? pilotRoller(v, 'stealth', tk('Stealth'))
      : { kind: 'driver', skillId: 'sneaking', attr: control === 'rigged' ? 'INT' : 'REA', capSkillAt: Number(sk?.rating) || 0 };
    return { roller, bonus: [...(auto ? [] : riggerBonus(control, c)), ...vehicleLines(v, 'other')], limit: lim.limit, limitLabel: lim.label, limitLines: lim.lines, ...thresholdOf(opts, 0, control, NO_CONTROLLER) };
  }
  const roller: RollerPlan = auto ? pilotRoller(v, 'maneuvering', tk('Maneuvering')) : { kind: 'driver', skillId, attr: 'REA' };
  return { roller, bonus: [...(auto ? [] : riggerBonus(control, c)), ...vehicleLines(v, 'control')], limit: lim.limit, limitLabel: lim.label, limitLines: lim.lines, ...thresholdOf(opts, opts.terrain || 0, auto ? 'auto' : control, c) };
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
      roller: { kind: 'pilot', pool: st.pilot + soft, lines: [{ label: tk('Pilot'), value: st.pilot }, { label: tk('Targeting'), value: soft }] }, bonus: vehicleLines(v, 'other'),
      limitAdd: v?.swarmBonus || 0, limitMax: null, limitReplace: passive ? st.sensor : null, limitLabel: passive ? 'sensor' : 'accuracy', impossible: !soft,
    };
  }
  const attrKey = control === 'manual' && !passive ? 'AGI' : 'LOG';
  return {
    roller: { kind: 'driver', skillId: 'gunnery', attr: attrKey }, bonus: [...riggerBonus(control, c), ...vehicleLines(v, 'other')],
    limitAdd: (passive ? 0 : rigAdd) + (v?.swarmBonus || 0), limitMax, limitReplace: sensor, limitLabel: passive ? 'sensor' : 'accuracy',
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

// ---------------------------------------------------------------------------------------------------------------------
// Run & Gun: vehicle called shots (p. 115); SR5 p. 205: shot-out tires
// ---------------------------------------------------------------------------------------------------------------------

export interface VehicleCalledShot {
  id: string;
  label: string;
  /** Attack dice modifier. */
  mod: number;
  /** Most damage the shot can do (null = no limit; 0 = no damage, the effect alone). */
  dvLimit: number | null;
  /** Breakdown set when the shot damages the vehicle (or, with a DV limit of 0, hits). */
  effect: keyof VehicleBreakdowns;
  note: string;
  source: string;
  page: number;
}
export const VEHICLE_CALLED_SHOTS: VehicleCalledShot[] = [
  { id: 'engine', label: tk('Engine block'), mod: -4, dvLimit: null, effect: 'disabled', note: tk('Disables the vehicle.'), source: 'RG', page: 115 },
  { id: 'fuel', label: tk('Fuel tank / battery'), mod: -6, dvLimit: null, effect: 'leak', note: tk('Disables the vehicle; fuel or battery leak.'), source: 'RG', page: 115 },
  { id: 'axle', label: tk('Axle'), mod: -6, dvLimit: 6, effect: 'axle', note: tk('Speed drops to 1.'), source: 'RG', page: 115 },
  { id: 'antenna', label: tk('Antenna'), mod: -8, dvLimit: 2, effect: 'antenna', note: tk('No communications, no wireless: no remote control.'), source: 'RG', page: 115 },
  { id: 'door', label: tk('Door lock'), mod: -6, dvLimit: 0, effect: 'door', note: tk('The door cannot be opened.'), source: 'RG', page: 115 },
  { id: 'window', label: tk('Window motor'), mod: -4, dvLimit: 0, effect: 'window', note: tk('The window cannot be opened.'), source: 'RG', page: 115 },
  { id: 'tire', label: tk('Tire'), mod: -4, dvLimit: null, effect: 'tires', note: tk('Flat tire: −2 dice on Vehicle Tests (each).'), source: 'SR5', page: 205 },
];
export const CALLED_SHOT_BY_ID: Record<string, VehicleCalledShot> = Object.fromEntries(VEHICLE_CALLED_SHOTS.map((x) => [x.id, x]));
/** Breakdowns after a called shot landed (returns a new object). */
export function withBreakdown(b: VehicleBreakdowns | undefined, shot: VehicleCalledShot): VehicleBreakdowns {
  const out: VehicleBreakdowns = { ...(b || {}) };
  if (shot.effect === 'tires') out.tires = (Number(out.tires) || 0) + 1;
  else if (shot.effect === 'leak') {
    out.leak = true;
    out.disabled = true;
  } else (out as Record<string, unknown>)[shot.effect] = true;
  return out;
}
/** The vehicle cannot move (engine, fuel tank / battery shot). */
export const vehicleDisabled = (v: VehicleLike): boolean => !!v?.breakdowns?.disabled;

// ---------------------------------------------------------------------------------------------------------------------
// Rigger 5.0: swarms (p. 31)
// ---------------------------------------------------------------------------------------------------------------------

/** Drones of the owner in the same swarm as `v` (v included), not destroyed. */
export function swarmMembers(vehicles: VehicleLike[] | null | undefined, v: VehicleLike): Array<Partial<Vehicle>> {
  if (!v?.swarm) return [];
  return (vehicles || []).filter((x): x is Partial<Vehicle> => !!x && x.swarm === v.swarm && !vehicleDestroyed(x));
}
/**
 * The swarm as one drone: Pilot = highest Pilot or the RCC's Device Rating, best autosoft of each kind and best Sensor,
 * lowest Handling / Speed / Acceleration, + (drones − 1) to pools and limits (`swarmBonus`). `v` itself when it is in no
 * swarm (or alone in it).
 */
export function swarmVehicle(vehicles: VehicleLike[] | null | undefined, v: VehicleLike, rccRating = 0): VehicleLike {
  const members = swarmMembers(vehicles, v);
  if (members.length < 2 || !v) return v;
  const st = members.map((m) => vehicleStats(m));
  const best: Record<string, Autosoft> = {};
  for (const m of members) for (const a of m.autosofts || []) {
    const k = `${a.kind}:${(a.target || '').toLowerCase()}`;
    if (!best[k] || best[k].rating < a.rating) best[k] = a;
  }
  const min = (k: keyof VehicleStatsOut) => Math.min(...st.map((x) => x[k]));
  const max = (k: keyof VehicleStatsOut) => Math.max(...st.map((x) => x[k]));
  const own = vehicleStats(v);
  return {
    ...v, mods: [],
    handling: `${min('handling')}/${min('handlingOff')}`, speed: `${min('speed')}/${min('speedOff')}`, accel: min('accel'),
    pilot: Math.max(max('pilot'), rccRating), sensor: max('sensor'), body: own.body, armor: own.armor,
    autosofts: Object.values(best), swarmBonus: members.length - 1,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rigger 5.0: qualities (p. 33-34)
// ---------------------------------------------------------------------------------------------------------------------

const QUALITY_RX = {
  chaser: /^(chaser|poursuiveur)/i,
  stuntDriver: /^(stunt driver|cascadeur)/i,
  speedDemon: /^(speed demon|d[ée]mon de (la )?vitesse)/i,
  subtle: /^(subtle.*pilot|pilote d[ée]licat|pilote discret)/i,
  tooMuchData: /^(too much data|trop d.informations)/i,
  motionSickness: /^(motion sickness|mal des transports)/i,
  greaseMonkey: /^(grease monkey|m[ée]cano)/i,
};
export type RiggerQuality = keyof typeof QUALITY_RX;
/** The rigger qualities an actor has (names in English or French, as Chummer / the shop store them). */
export function riggerQualities(actor: ActorLike | null | undefined): Set<RiggerQuality> {
  const out = new Set<RiggerQuality>();
  for (const q of actor?.qualities || []) {
    const names = [q?.name, q?.nameEn, q?.nameFr].filter(Boolean) as string[];
    for (const [k, rx] of Object.entries(QUALITY_RX)) if (names.some((n) => rx.test(n.trim()))) out.add(k as RiggerQuality);
  }
  return out;
}
/**
 * Dice from the driver's rigger qualities: Chaser +2 on Chase Actions, Stunt Driver +2 on stunts, Speed Demon +1 on Pilot
 * tests at Speed 3+ (aircraft 4+) when aboard or jumped in, Too Much Data −2 on Pilot tests while directing 4+ moving vehicles.
 */
export function qualityLines(driver: ActorLike | null | undefined, v: VehicleLike, o: { chaseAction?: string | null; atSpeed?: boolean; directing?: number } = {}): PlanLine[] {
  if (!driver) return [];
  const q = riggerQualities(driver);
  const out: PlanLine[] = [];
  if (o.chaseAction && q.has('chaser')) out.push({ label: tk('Chaser'), value: 2 });
  if (o.chaseAction === 'stunt' && q.has('stuntDriver')) out.push({ label: tk('Stunt Driver'), value: 2 });
  const control = controlOf(v);
  const aboard = control === 'manual' || control === 'rigged';
  const fastEnough = vehicleStats(v).speed >= (vehicleSkillId(v) === 'pilot_aircraft' ? 4 : 3);
  if (o.atSpeed && aboard && fastEnough && q.has('speedDemon')) out.push({ label: tk('Speed Demon'), value: 1 });
  if ((o.directing || 0) >= 4 && q.has('tooMuchData')) out.push({ label: tk('Too Much Data'), value: -2 });
  return out;
}
/** Subtle [Vehicle] Pilot: −2 to the Perception / Sensor tests spotting a vehicle its driver steers directly. */
export function subtlePilotPenalty(driver: ActorLike | null | undefined, v: VehicleLike): number {
  if (!driver || controlOf(v) === 'auto' || !riggerQualities(driver).has('subtle')) return 0;
  return -2;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rigger 5.0: repair (p. 29-30)
// ---------------------------------------------------------------------------------------------------------------------

/** Mechanic skill that repairs a vehicle. */
export function mechanicSkillFor(v: VehicleLike): string {
  const sk = vehicleSkillId(v);
  return sk === 'pilot_aircraft' || sk === 'pilot_aerospace' ? 'aeronautics_mechanic' : sk === 'pilot_watercraft' ? 'nautical_mechanic' : 'automotive_mechanic';
}
/** Repair Table (Rigger 5.0 p. 30): working conditions. */
export const REPAIR_CONDITIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: tk('Superior') }, { value: 0, label: tk('Normal') }, { value: -1, label: tk('Distracting') }, { value: -2, label: tk('Poor') },
  { value: -3, label: tk('Bad') }, { value: -4, label: tk('Terrible') },
];
/** Spare parts: 5 % of the vehicle's cost per box. */
export const repairPartsCost = (cost: number, boxes: number): number => Math.ceil(Math.max(0, cost) * 0.05 * Math.max(0, boxes));
/**
 * Extended test (SR5 p. 48): roll, then one die less each interval, until the hits reach the threshold or the pool is gone.
 * → { rolls: hits per interval, intervals, success }.
 */
export function extendedTest(pool: number, threshold: number, limit: number | null, roll: (n: number) => { hits: number }): { rolls: number[]; intervals: number; success: boolean } {
  const rolls: number[] = [];
  let total = 0;
  for (let p = pool; p > 0 && total < threshold && rolls.length < 30; p--) {
    const h = Math.min(roll(p).hits, limit ?? Infinity);
    rolls.push(h);
    total += h;
  }
  return { rolls, intervals: rolls.length, success: total >= threshold };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sensors: target locks (SR5 p. 184) and Rigger 5.0 electronic warfare (p. 30)
// ---------------------------------------------------------------------------------------------------------------------

/** Signature modifier of the detected target on the Sensor Test (Signature Table, SR5 p. 184). */
export function signatureMod(target: { vehicle?: VehicleLike } | null): number {
  const v = target?.vehicle;
  if (!v) return -3; // metahumans, critters
  if (isDrone(v)) return /micro/i.test(`${v.categoryEn || ''} ${v.name || ''}`) ? -6 : -3;
  if (/electric|[ée]lectrique/i.test(`${v.name || ''} ${v.notes || ''}`)) return -3;
  return vehicleStats(v).body >= 16 ? 3 : 0;
}

export const EW_ACTIONS = ['breakLock', 'confusePilot', 'detectLock', 'suppressNoise', 'targetDevice'] as const;
export type EwActionId = (typeof EW_ACTIONS)[number];
export interface EwActionDef {
  id: EwActionId;
  label: string;
  type: 'free' | 'simple' | 'complex';
  skillId: string;
  attr: 'INT' | 'LOG';
  threshold?: number;
  /** What the other side rolls (shown). */
  opposed?: string;
  needsTarget?: 'lock' | 'pilot' | 'token';
  note: string;
}
export const EW_ACTION_DEFS: Record<EwActionId, EwActionDef> = {
  breakLock: { id: 'breakLock', label: tk('Break Target Lock'), type: 'simple', skillId: 'electronic_warfare', attr: 'INT', opposed: tk('LOG + Sensor of the locking vehicle'), needsTarget: 'lock', note: tk('Each net hit takes one hit off the enemy’s lock on you.') },
  confusePilot: { id: 'confusePilot', label: tk('Confuse Pilot'), type: 'complex', skillId: 'electronic_warfare', attr: 'LOG', opposed: tk('Pilot + Firewall'), needsTarget: 'pilot', note: tk('The pilot must pass a Pilot × 2 test (half your net hits) or keep doing what it was doing.') },
  detectLock: { id: 'detectLock', label: tk('Detect Target Lock'), type: 'free', skillId: 'computer', attr: 'LOG', threshold: 2, note: tk('Tells you who has a lock on you or your vehicles.') },
  suppressNoise: { id: 'suppressNoise', label: tk('Suppress Noise'), type: 'complex', skillId: 'electronic_warfare', attr: 'LOG', note: tk('Each hit reduces the noise to your vehicles by 1 for this Combat Turn.') },
  targetDevice: { id: 'targetDevice', label: tk('Target Device'), type: 'complex', skillId: 'electronic_warfare', attr: 'LOG', opposed: tk('WIL + Firewall'), needsTarget: 'token', note: tk('Your slaved drones and vehicles get your net hits as dice against that target this Combat Turn.') },
};

/**
 * Device Rating of the actor's rigger command console (its Matrix device when that gear is an RCC), 0 otherwise: the swarm
 * Pilot floor and the cap of the RCC's Noise Reduction (Rigger 5.0 p. 31, SR5 p. 267).
 */
export function rccRating(actor: ActorLike | null | undefined): number {
  const m = actor?.matrix;
  if (!m) return 0;
  const g = m.gearId ? (actor?.gear || []).find((x) => x?.id === m.gearId) : null;
  const text = `${g?.category || ''} ${g?.categoryEn || ''} ${m.device || ''}`;
  return /rigger command|console de (commande|rigg)|\brcc\b/i.test(text) ? Math.max(0, Math.round(Number(m.rating) || 0)) : 0;
}
