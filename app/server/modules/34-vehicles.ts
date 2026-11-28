// Vehicles module: control modes (manual / remote / jumped in / autopilot), Vehicle Tests, sensors, stealth, vehicle damage,
// vehicle tokens on the map, ramming, crashes, mounted weapons, and Chase Combat (SR5 p. 199-205, 264-270).
// Rules: shared/vehicles.ts. Rolls: the characters module's performRoll. Attacks against vehicles: 33-attacks.
// State: chase: ChaseState (types.ts). Vehicles live on their owner's sheet (actor.vehicles), their tokens carry vehicleId.
import { performRoll } from './10-characters.ts';
import { addEntries } from './30-combat.ts';
import { pushAttack, addVehicleSoak, damageVehicle, logAttack } from './33-attacks.ts';
import { placeActorToken, refreshFog } from './20-maps.ts';
import { recordAction } from '../lib/combat-actions.ts';
import { catalogDrone, controllerInfo, driverOf, getVehicle, mayControl, plainPool, vehicleOf } from '../lib/vehicles.ts';
import {
  CHASE_ACTIONS, CHASE_RANGES, CHASE_RANGE_LABELS, VEHICLE_CONTROLS, AUTOSOFT_KINDS, VEHICLE_SKILLS, chaseActionNeedsShort, controlLimit, controlOf, controlRigRating,
  crashDamage, hasRiggerInterface, isDrone, movementRate, ramDamage, shiftRange, vehicleDestroyed, vehicleMonitor, vehicleStats, vehicleTestPlan,
  type ChaseActionId, type PlanLine, type VehicleTestKind, type VehicleTestPlan,
} from '../../shared/vehicles.ts';
import { armorTotal } from '../../shared/sr5.ts';
import { uid } from '../../shared/util.ts';
import type { PerformedRoll, RollBonusLine, RollInternal } from './10-characters.ts';
import type {
  ActionContext, Actor, Autosoft, ChaseEnvironment, ChasePending, ChaseRange, ChaseState, ChaseVehicle, GameMap, GameView, I18nMessage, I18nParams,
  ServerModule, SessionUser, TableState, Vehicle, VehicleControl, VehicleRollInfo,
} from '../../shared/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const tk = (s: string): string => s;
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): string => (v === undefined || v === null ? '' : String(v).slice(0, max));
const int = (v: unknown, lo: number, hi: number, d = 0): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const MAX_EVENTS = 30;
const MAX_CHASE_VEHICLES = 20;
const TERRAIN_VALUES = [0, 1, 2, 4];

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

function emptyChase(): ChaseState {
  return { active: false, environment: 'handling', terrain: 0, round: 1, vehicles: [], pending: [], events: [] };
}
function chaseOf(state: TableState): ChaseState {
  if (!isObj(state.chase)) state.chase = emptyChase();
  const c = state.chase;
  if (!Array.isArray(c.vehicles)) c.vehicles = [];
  if (!Array.isArray(c.pending)) c.pending = [];
  if (!Array.isArray(c.events)) c.events = [];
  return c;
}
function activeChase(ctx: ActionContext): ChaseState {
  const c = chaseOf(ctx.state);
  if (!c.active) ctx.fail('No chase in progress');
  return c;
}

/** Drone flag from the catalog when the sheet has none (a vehicle bought / imported before this module). */
function settleDrone(v: Vehicle): void {
  if (typeof v.drone === 'boolean') return;
  const d = catalogDrone(v);
  if (d !== null) v.drone = d;
}

/** Chase history line (and combat log line). */
function note(ctx: ActionContext, key: string, params: I18nParams, gmOnly = false): void {
  const c = chaseOf(ctx.state);
  c.events.unshift({ id: uid('chev'), ts: ctx.now, text: { t: key, params }, ...(gmOnly ? { gmOnly: true } : {}) });
  if (c.events.length > MAX_EVENTS) c.events.length = MAX_EVENTS;
  logAttack(ctx, key, params, gmOnly);
}

const bonusOf = (lines: PlanLine[]): RollBonusLine[] => lines.filter((l) => l.value).map((l) => ({ label: l.label, value: l.value }));
const breakdown = (lines: PlanLine[]): string => lines.map((l, i) => (i ? `${l.label} ${l.value >= 0 ? '+' : '−'}${Math.abs(l.value)}` : `${l.label} ${l.value}`)).join(' + ');

/** The chase vehicle of an owner's vehicle (null when not in the chase). */
const chaseVehicleOf = (state: TableState, actorId: string, vehicleId: string): ChaseVehicle | null =>
  (state.chase?.active ? state.chase.vehicles.find((x) => x.actorId === actorId && x.vehicleId === vehicleId) : null) || null;

/** Uncontrolled vehicle: −2 to everything done aboard (SR5 p. 202). */
function uncontrolledLines(state: TableState, owner: Actor, v: Vehicle): PlanLine[] {
  return chaseVehicleOf(state, owner.id, v.id)?.uncontrolled ? [{ label: 'uncontrolled', value: -2 }] : [];
}

type RollOpts = { label: string; info: VehicleRollInfo; modifier?: unknown; explode?: unknown; secret?: unknown; extra?: PlanLine[] };
/**
 * Roll a vehicle plan: the driver's skill + attribute through performRoll (their modifiers, wounds, Edge), or the vehicle's
 * Pilot + autosoft. The threshold, when there is one, is checked here and written on the log entry (`roll.vehicle`).
 */
function rollPlan(ctx: ActionContext, owner: Actor, v: Vehicle, plan: VehicleTestPlan, o: RollOpts): PerformedRoll {
  const driver = driverOf(ctx.state, owner, v);
  const extra = [...plan.bonus, ...(o.extra || [])];
  const limitAdjust = plan.limit !== null ? { replace: plan.limit, label: plan.limitLabel, breakdown: breakdown(plan.limitLines) } : undefined;
  const info: VehicleRollInfo = { ...o.info, ...(plan.threshold !== null ? { threshold: plan.threshold } : {}) };
  let roll: PerformedRoll;
  if (plan.roller.kind === 'driver' && driver) {
    const r = plan.roller;
    // Infiltration from a vehicle: the Sneaking dice never exceed the driver's vehicle skill (SR5 p. 184).
    if (r.capSkillAt !== undefined) {
      const sk = (driver.skills || []).find((s) => s.id === r.skillId);
      const over = (Number(sk?.rating) || 0) - r.capSkillAt;
      if (over > 0) extra.push({ label: 'vehicle skill cap', value: -over });
    }
    roll = performRoll(ctx, {
      actorId: driver.id, skillId: r.skillId || null, attr: r.attr, label: o.label, modifier: int(o.modifier, -30, 30), explode: !!o.explode, secret: !!o.secret && ctx.isGM,
    }, { bonus: bonusOf(extra), ...(limitAdjust ? { limitAdjust } : {}), logExtra: { vehicle: info } });
  } else {
    const r = plan.roller.kind === 'pilot' ? plan.roller : { pool: vehicleStats(v).pilot, lines: [{ label: 'Pilot', value: vehicleStats(v).pilot }] };
    roll = performRoll(ctx, { label: o.label, modifier: int(o.modifier, -30, 30), secret: !!o.secret && ctx.isGM }, {
      bonus: bonusOf(extra), basePool: { pool: r.pool, parts: r.lines.map((l) => `${l.label} ${l.value}`) }, author: v.name,
      ...(limitAdjust ? { limitAdjust } : {}), logExtra: { actorId: owner.id, vehicle: info },
    });
  }
  if (plan.threshold !== null) {
    info.success = roll.hits >= plan.threshold;
    info.net = roll.hits - plan.threshold;
    if (roll.entry.roll) roll.entry.roll.vehicle = info;
    roll.vehicle = info;
  }
  return roll;
}

/**
 * The other side of an opposed vehicle test, rolled for the acting player (no Edge, no sheet modifiers): the driver's skill +
 * attribute + wounds, or the drone's Pilot + autosoft, with the vehicle's limit.
 */
function rollOpposed(ctx: ActionContext, owner: Actor, v: Vehicle, plan: VehicleTestPlan, label: string, info: VehicleRollInfo): PerformedRoll {
  const driver = driverOf(ctx.state, owner, v);
  const base = plainPool(driver, plan.roller, [...plan.bonus, ...uncontrolledLines(ctx.state, owner, v)]);
  return performRoll(ctx, { label, ...(base.pool <= 0 ? { modifier: 0 } : {}) }, {
    basePool: base.pool > 0 ? base : { pool: 1, parts: ['1 die'] }, author: driver && plan.roller.kind === 'driver' ? `${driver.name} (${v.name})` : v.name,
    ...(plan.limit !== null ? { limitAdjust: { replace: plan.limit, label: plan.limitLabel, breakdown: breakdown(plan.limitLines) } } : {}),
    logExtra: { actorId: owner.id, vehicle: info },
  });
}

/** Record a Complex Action on the tracker: the driver's entry, or the drone's own entry on autopilot. */
function spendComplex(ctx: ActionContext, owner: Actor, v: Vehicle, label: I18nMessage): void {
  const driver = driverOf(ctx.state, owner, v);
  if (driver) recordAction(ctx, { actorId: driver.id }, { type: 'complex', label, auto: true });
  else {
    const e = ctx.state.combat?.entries.find((x) => x.kind === 'drone' && x.vehicleId === v.id && !x.out);
    if (e) recordAction(ctx, { entryId: e.id }, { type: 'complex', label, auto: true });
  }
}

/** Put a vehicle on autopilot in / out of the running fight when its control mode changes. */
function syncDroneEntry(ctx: ActionContext, owner: Actor, v: Vehicle): void {
  const c = ctx.state.combat;
  if (!c?.active) return;
  const existing = c.entries.find((e) => e.kind === 'drone' && e.vehicleId === v.id);
  if (controlOf(v) === 'auto') {
    if (existing && !existing.out) return;
    if (existing) existing.out = false;
    const map = c.mapId ? ctx.state.maps?.[c.mapId] : null;
    const tok = (map?.tokens || []).find((t) => t.actorId === owner.id && t.vehicleId === v.id);
    if (!existing && tok) addEntries(ctx, c, { tokenIds: [tok.id] });
  } else if (existing && !existing.out) existing.out = true;
}

/** Remove what a sheet no longer has (sold vehicle, deleted actor) from the chase. */
function pruneChase(state: TableState): void {
  const c = state.chase;
  if (!c?.vehicles) return;
  c.vehicles = c.vehicles.filter((x) => vehicleOf(state.actors?.[x.actorId], x.vehicleId));
  const ids = new Set(c.vehicles.map((x) => x.id));
  c.pending = (c.pending || []).filter((p) => ids.has(p.chaseVehicleId));
}

function getChaseVehicle(ctx: ActionContext, c: ChaseState, id: unknown): { cv: ChaseVehicle; owner: Actor; vehicle: Vehicle } {
  const cv = c.vehicles.find((x) => x.id === str(id, 60));
  if (!cv) ctx.fail('Vehicle not in the chase');
  const { owner, vehicle } = getVehicle(ctx, cv.actorId, cv.vehicleId);
  return { cv, owner, vehicle };
}

/** Range between two chase vehicles (one of them must be the quarry). */
function rangeBetween(c: ChaseState, a: ChaseVehicle, b: ChaseVehicle): ChaseRange | null {
  if (a.role === 'quarry' && b.role === 'pursuer') return b.lost ? null : b.range || 'medium';
  if (b.role === 'quarry' && a.role === 'pursuer') return a.lost ? null : a.range || 'medium';
  return null;
}

/** Apply a failed pending test. */
function failPending(ctx: ActionContext, c: ChaseState, p: ChasePending, cv: ChaseVehicle, owner: Actor, v: Vehicle): void {
  const gm = !!cv.hidden;
  if (p.onFail === 'fallBack') {
    if (cv.range === 'extreme' || cv.lost) {
      cv.lost = true;
      note(ctx, tk('{vehicle} loses the quarry: escaped!'), { vehicle: v.name }, gm);
    } else {
      const next = shiftRange(cv.range, 1);
      cv.range = next === 'lost' ? 'extreme' : next;
      note(ctx, tk('{vehicle} falls back to {range} range.'), { vehicle: v.name, range: { t: rangeKey(cv.range) } }, gm);
    }
  } else if (p.onFail === 'crash') crash(ctx, c, cv, owner, v);
  else {
    cv.uncontrolled = true;
    note(ctx, tk('{vehicle} is out of control.'), { vehicle: v.name }, gm);
  }
}

const rangeKey = (r: ChaseRange | undefined): string => CHASE_RANGE_LABELS[r || 'medium'];

/** A crash (SR5 p. 201-202): the vehicle resists its own Body (AP −6); it leaves the chase. Passengers: the GM's vehicle/crash. */
function crash(ctx: ActionContext, c: ChaseState | null, cv: ChaseVehicle | null, owner: Actor, v: Vehicle): void {
  if (cv) {
    cv.crashed = true;
    cv.uncontrolled = false;
  }
  const { dv, ap } = crashDamage(v);
  addVehicleSoak(ctx, { owner, vehicle: v, dv, ap, weaponName: { fr: 'Accident', en: 'Crash' }, gmOnly: !!cv?.hidden });
  note(ctx, tk('{vehicle} crashes! Vehicle and passengers resist {dv}P, AP −6; Composure (4) for everyone aboard.'), { vehicle: v.name, dv }, !!cv?.hidden);
  if (c) c.pending = c.pending.filter((p) => p.chaseVehicleId !== cv?.id);
}

function cleanAutosofts(v: unknown): Autosoft[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 12).filter(isObj).map((a) => ({
    id: str(a.id, 60) || uid('soft'),
    kind: AUTOSOFT_KINDS.includes(a.kind) ? a.kind : 'maneuvering',
    rating: int(a.rating, 1, 12, 1),
    ...(str(a.target, 80).trim() ? { target: str(a.target, 80).trim() } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Player view
// ---------------------------------------------------------------------------------------------------------------------

function filterView(view: GameView, _user: SessionUser, state: TableState): void {
  const c = state.chase;
  if (!c) return;
  const vehicles = (c.vehicles || []).filter((x) => !x.hidden);
  const ids = new Set(vehicles.map((x) => x.id));
  view.chase = { ...c, vehicles, pending: (c.pending || []).filter((p) => ids.has(p.chaseVehicleId)), events: (c.events || []).filter((e) => !e.gmOnly) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------------------------------

type VehicleRef = { actorId?: unknown; vehicleId?: unknown };
type ControlPayload = VehicleRef & { control?: unknown; driverId?: unknown; ar?: unknown };
type DamagePayload = VehicleRef & { damage?: unknown };
type RollPayload = VehicleRef & { test?: unknown; threshold?: unknown; terrain?: unknown; env?: unknown; offRoad?: unknown; modifier?: unknown; explode?: unknown; secret?: unknown };
type MountPayload = { actorId?: unknown; weaponId?: unknown; vehicleId?: unknown };
type ConfigurePayload = VehicleRef & { patch?: unknown };
type PlacePayload = VehicleRef & { mapId?: unknown; x?: unknown; y?: unknown };
type RamPayload = VehicleRef & { targetTokenId?: unknown; metersPerTurn?: unknown; running?: unknown; modifier?: unknown; explode?: unknown; mapId?: unknown };
type CrashPayload = VehicleRef & { passengerIds?: unknown };
type ChaseVehicleIn = VehicleRef & { role?: unknown; range?: unknown; hidden?: unknown };
type ChaseStartPayload = { environment?: unknown; terrain?: unknown; vehicles?: unknown };
type ChaseUpdatePayload = { environment?: unknown; terrain?: unknown };
type ChaseSetPayload = { id?: unknown; patch?: unknown };
type ChaseActionPayload = { id?: unknown; action?: unknown; targetId?: unknown; threshold?: unknown; modifier?: unknown; explode?: unknown };
type ChaseResolvePayload = { pendingId?: unknown; modifier?: unknown; explode?: unknown };

const envOf = (v: unknown, d: ChaseEnvironment = 'handling'): ChaseEnvironment => (v === 'speed' || v === 'handling' ? v : d);
const rangeOf = (v: unknown, d: ChaseRange = 'medium'): ChaseRange => (CHASE_RANGES.includes(v as ChaseRange) ? (v as ChaseRange) : d);

function newChaseVehicle(ctx: ActionContext, c: ChaseState, x: ChaseVehicleIn): ChaseVehicle {
  const { owner, vehicle } = getVehicle(ctx, x.actorId, x.vehicleId);
  if (c.vehicles.some((cv) => cv.actorId === owner.id && cv.vehicleId === vehicle.id)) ctx.fail('{vehicle} is already in the chase', { vehicle: vehicle.name });
  settleDrone(vehicle);
  const role = x.role === 'quarry' ? 'quarry' : 'pursuer';
  return {
    id: uid('chv'), actorId: owner.id, vehicleId: vehicle.id, name: vehicle.name, role,
    ...(role === 'pursuer' ? { range: rangeOf(x.range) } : {}), ...(x.hidden ? { hidden: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------------------------------------------------

const mod: ServerModule = {
  name: 'vehicles',

  init(state: TableState) {
    chaseOf(state);
    for (const a of Object.values(state.actors || {})) for (const v of a?.vehicles || []) if (v) settleDrone(v);
  },

  actions: {
    // Control mode and who is at the controls. { actorId, vehicleId, control?: 'manual'|'remote'|'rigged'|'auto', driverId?: actorId|null, ar?: bool }
    // Owner's player, driver's player, or GM. Jumping in needs a control rig and a rigger interface (SR5 p. 266); autopilot a Pilot rating.
    'vehicle/control': {
      role: 'any',
      handler(ctx: ActionContext, p: ControlPayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        settleDrone(vehicle);
        if (p.driverId !== undefined) {
          const id = p.driverId ? str(p.driverId, 60) : null;
          if (id && !ctx.state.actors[id]) ctx.fail('Character not found');
          // A player puts their own runners at the controls (the GM anyone).
          if (id && !ctx.isGM && !ctx.owns(id) && id !== owner.id) ctx.fail('That is not your character');
          vehicle.driverId = id && id !== owner.id ? id : null;
          if (!vehicle.driverId) delete vehicle.driverId;
        }
        if (p.ar !== undefined) vehicle.ar = !!p.ar || undefined;
        if (p.control !== undefined) {
          const control = VEHICLE_CONTROLS.includes(p.control as VehicleControl) ? (p.control as VehicleControl) : 'manual';
          const driver = ctx.state.actors[vehicle.driverId || ''] || owner;
          if (control === 'rigged' && !ctx.isGM) {
            if (!controlRigRating(driver)) ctx.fail('{name} has no control rig', { name: driver.name });
            if (!hasRiggerInterface(vehicle)) ctx.fail('{vehicle} has no rigger interface', { vehicle: vehicle.name });
          }
          if (control === 'auto' && !vehicleStats(vehicle).pilot && !ctx.isGM) ctx.fail('{vehicle} has no Pilot program', { vehicle: vehicle.name });
          vehicle.control = control;
          if (control === 'manual') delete vehicle.control;
          syncDroneEntry(ctx, owner, vehicle);
          const hidden = owner.type === 'npc' && !!owner.hidden;
          ctx.log({
            kind: 'combat', userId: ctx.user.id, author: vehicle.name, ...(hidden ? { gmOnly: true } : {}),
            i18n: control === 'auto'
              ? { key: tk('{vehicle} switches to autopilot.'), params: { vehicle: vehicle.name } }
              : { key: tk('{driver} takes {vehicle}: {mode}.'), params: { driver: driver.name, vehicle: vehicle.name, mode: { t: { manual: 'Manual', remote: 'Remote control', rigged: 'Jumped in', auto: 'Autopilot' }[control] } } },
          });
        }
        return { control: controlOf(vehicle), driverId: vehicle.driverId || null };
      },
    },

    // Boxes of damage, set by hand (owner's player or GM). { actorId, vehicleId, damage }
    'vehicle/damage': {
      role: 'any',
      handler(ctx: ActionContext, p: DamagePayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!ctx.isGM && !ctx.owns(owner.id)) ctx.fail('That is not your vehicle');
        settleDrone(vehicle);
        const max = vehicleMonitor(vehicle);
        const was = vehicleDestroyed(vehicle);
        const next = int(p.damage, 0, max);
        if (next > (Number(vehicle.damage) || 0) && ctx.isGM) {
          damageVehicle(ctx, owner, vehicle, next - (Number(vehicle.damage) || 0));
          return { damage: vehicle.damage, max };
        }
        vehicle.damage = next;
        if (!next) delete vehicle.damage;
        const now = vehicleDestroyed(vehicle);
        if (now !== was) {
          for (const m of Object.values<GameMap>(ctx.state.maps || {})) {
            for (const t of m?.tokens || []) {
              if (t.actorId !== owner.id || t.vehicleId !== vehicle.id) continue;
              const kept = (t.status || []).filter((s) => s !== 'détruit');
              t.status = now ? [...kept, 'détruit'] : kept;
            }
          }
          for (const e of ctx.state.combat?.entries || []) if (e.kind === 'drone' && e.vehicleId === vehicle.id) e.down = now;
        }
        return { damage: vehicle.damage || 0, max };
      },
    },

    // A test of the vehicle: { actorId, vehicleId, test: 'control'|'perception'|'stealth'|'pilot', threshold?, terrain?, env?, offRoad?, modifier?, explode?, secret? }
    'vehicle/roll': {
      role: 'any',
      handler(ctx: ActionContext, p: RollPayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        if (vehicleDestroyed(vehicle)) ctx.fail('{vehicle} is destroyed', { vehicle: vehicle.name });
        settleDrone(vehicle);
        const test: VehicleTestKind = (['control', 'perception', 'stealth', 'pilot'] as const).find((x) => x === p.test) || 'control';
        const driver = driverOf(ctx.state, owner, vehicle);
        const c = controllerInfo(ctx.state, driver);
        const chase = ctx.state.chase?.active ? ctx.state.chase : null;
        const plan = vehicleTestPlan(vehicle, test, c, driver, {
          env: envOf(p.env, chase?.environment || 'handling'), offRoad: !!p.offRoad,
          threshold: p.threshold === undefined || p.threshold === null || p.threshold === '' ? null : int(p.threshold, 0, 12),
          terrain: TERRAIN_VALUES.includes(Number(p.terrain)) ? Number(p.terrain) : 0,
        });
        const labels: Record<VehicleTestKind, string> = { control: tk('Vehicle Test'), perception: tk('Sensor Test'), stealth: tk('Vehicle stealth'), pilot: tk('Pilot program') };
        const roll = rollPlan(ctx, owner, vehicle, plan, {
          label: labels[test], info: { vehicleId: vehicle.id, name: vehicle.name, test }, modifier: p.modifier, explode: p.explode, secret: p.secret,
          extra: uncontrolledLines(ctx.state, owner, vehicle),
        });
        if (test === 'control') spendComplex(ctx, owner, vehicle, { t: tk('Vehicle Test — {vehicle}'), params: { vehicle: vehicle.name } });
        // Regaining control of an uncontrolled vehicle in a chase.
        const cv = chaseVehicleOf(ctx.state, owner.id, vehicle.id);
        if (cv?.uncontrolled && test === 'control' && roll.vehicle?.success !== false && roll.hits > 0) {
          cv.uncontrolled = false;
          note(ctx, tk('{vehicle} is back under control.'), { vehicle: vehicle.name }, !!cv.hidden);
        }
        const { entry, ...out } = roll;
        return out;
      },
    },

    // Mount a weapon of the sheet on one of its vehicles (or take it off: vehicleId null). Owner's player or GM.
    'vehicle/mount': {
      role: 'any',
      handler(ctx: ActionContext, p: MountPayload = {}) {
        const owner = ctx.state.actors[str(p.actorId, 60)];
        if (!owner) ctx.fail('Character not found');
        if (!ctx.isGM && !ctx.owns(owner.id)) ctx.fail('That is not your character');
        const w = (owner.weapons || []).find((x) => x?.id === str(p.weaponId, 60));
        if (!w) ctx.fail('Weapon not found');
        if (p.vehicleId) {
          const v = vehicleOf(owner, p.vehicleId);
          if (!v) ctx.fail('Vehicle not found');
          if (w.kind === 'melee') ctx.fail('Only a ranged weapon can be mounted');
          w.vehicleId = v.id;
        } else delete w.vehicleId;
        return { vehicleId: w.vehicleId || null };
      },
    },

    // GM: drone flag, vehicle skill, rigger interface, autosofts. { actorId, vehicleId, patch: { drone?, skill?, riggerInterface?, autosofts? } }
    'vehicle/configure': {
      handler(ctx: ActionContext, p: ConfigurePayload = {}) {
        const { vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!isObj(p.patch)) ctx.fail('Invalid change');
        const x = p.patch;
        if (x.drone !== undefined) vehicle.drone = !!x.drone;
        if (x.skill !== undefined) {
          if (x.skill && (VEHICLE_SKILLS as readonly string[]).includes(x.skill)) vehicle.skill = x.skill;
          else delete vehicle.skill;
        }
        if (x.riggerInterface !== undefined) vehicle.riggerInterface = !!x.riggerInterface || undefined;
        if (x.autosofts !== undefined) vehicle.autosofts = cleanAutosofts(x.autosofts);
        return { ok: true };
      },
    },

    // Put a vehicle token on the map, next to its owner's token (players: their own vehicle on the shown map). { actorId, vehicleId, mapId?, x?, y? }
    'vehicle/place': {
      role: 'any',
      handler(ctx: ActionContext, p: PlacePayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        const mapId = ctx.isGM && p.mapId ? str(p.mapId, 60) : ctx.state.scene?.activeMapId;
        const map = mapId ? ctx.state.maps?.[mapId] : null;
        if (!map) ctx.fail('Map not found');
        if (map.tokens.some((t) => t.actorId === owner.id && t.vehicleId === vehicle.id)) ctx.fail('{vehicle} is already on the map', { vehicle: vehicle.name });
        settleDrone(vehicle);
        const near = map.tokens.find((t) => t.actorId === (vehicle.driverId || owner.id) && !t.vehicleId) || map.tokens.find((t) => t.actorId === owner.id && !t.vehicleId);
        if (!near && !ctx.isGM) ctx.fail('Your character must be on the map');
        const x = ctx.isGM && p.x !== undefined ? int(p.x, 0, map.width - 1) : near ? near.x : Math.floor(map.width / 2);
        const y = ctx.isGM && p.y !== undefined ? int(p.y, 0, map.height - 1) : near ? near.y : Math.floor(map.height / 2);
        // Size on the grid: drones 1 cell, other vehicles 2 (big ones 3).
        const body = vehicleStats(vehicle).body;
        const size = isDrone(vehicle) ? 1 : body >= 16 ? 3 : 2;
        const tok = placeActorToken(ctx.state, map, owner, x, y, {
          vehicleId: vehicle.id, name: vehicle.name, size, ...(vehicle.img ? { img: vehicle.img } : {}), ...(near ? { disposition: near.disposition, hidden: near.hidden } : {}),
          ...(vehicleDestroyed(vehicle) ? { status: ['détruit'] } : {}),
        });
        if (ctx.state.combat?.active && ctx.state.combat.mapId === map.id) syncDroneEntry(ctx, owner, vehicle);
        return { tokenId: tok.id };
      },
    },

    // Take a vehicle token off a map. { actorId, vehicleId, mapId? }
    'vehicle/unplace': {
      role: 'any',
      handler(ctx: ActionContext, p: PlacePayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        const mapId = ctx.isGM && p.mapId ? str(p.mapId, 60) : ctx.state.scene?.activeMapId;
        const map = mapId ? ctx.state.maps?.[mapId] : null;
        if (!map) ctx.fail('Map not found');
        const before = map.tokens.length;
        const gone = new Set(map.tokens.filter((t) => t.actorId === owner.id && t.vehicleId === vehicle.id).map((t) => t.id));
        map.tokens = map.tokens.filter((t) => !gone.has(t.id));
        if (map.tokens.length === before) ctx.fail('Token not found');
        for (const e of ctx.state.combat?.entries || []) if (e.tokenId && gone.has(e.tokenId)) e.out = true;
        refreshFog(ctx.state, map);
        return { removed: before - map.tokens.length };
      },
    },

    // Ram a token with a vehicle (SR5 p. 203): Vehicle skill + REA [Handling] (−3 at running rate) vs the target's defense;
    // DV from the Ramming Damage Table (Body, m / turn), AP −6 against characters. { actorId, vehicleId, targetTokenId, metersPerTurn, running?, modifier?, explode? }
    'vehicle/ram': {
      role: 'any',
      handler(ctx: ActionContext, p: RamPayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        if (vehicleDestroyed(vehicle)) ctx.fail('{vehicle} is destroyed', { vehicle: vehicle.name });
        const mapId = ctx.isGM && p.mapId ? str(p.mapId, 60) : ctx.state.scene?.activeMapId;
        const map = mapId ? ctx.state.maps?.[mapId] || null : null;
        const tok = (map?.tokens || []).find((t) => t.id === str(p.targetTokenId, 60));
        if (!tok || (!ctx.isGM && tok.hidden) || !tok.actorId) ctx.fail('Target not found on the map');
        const target = ctx.state.actors[tok.actorId];
        if (!target) ctx.fail('Target not found on the map');
        const targetVehicle = tok.vehicleId ? vehicleOf(target, tok.vehicleId) : null;
        if (targetVehicle && targetVehicle.id === vehicle.id) ctx.fail('You can\'t target yourself');
        const st = vehicleStats(vehicle);
        const [walk, run] = movementRate(st.speed);
        const meters = int(p.metersPerTurn, 1, Math.max(1, run), Math.max(1, walk));
        const running = !!p.running || meters > walk;
        const driver = driverOf(ctx.state, owner, vehicle);
        const c = controllerInfo(ctx.state, driver);
        const plan = vehicleTestPlan(vehicle, 'control', c, driver, {});
        const roll = rollPlan(ctx, owner, vehicle, plan, {
          label: tk('Ram'), info: { vehicleId: vehicle.id, name: vehicle.name, test: 'ram' }, modifier: p.modifier, explode: p.explode,
          extra: [...(running ? [{ label: 'running rate', value: -3 }] : []), ...uncontrolledLines(ctx.state, owner, vehicle)],
        });
        spendComplex(ctx, owner, vehicle, { t: tk('Ram — {vehicle}'), params: { vehicle: vehicle.name } });
        const dv = ramDamage(st.body, meters);
        const gmOnly = (owner.type === 'npc' && !!owner.hidden) || (target.type === 'npc' && !!target.hidden) || !!roll.secret;
        const atk = pushAttack(ctx, {
          mapId: map?.id || null, kind: 'melee', attackerId: owner.id, attackerName: vehicle.name, attackLogId: roll.logId, targetId: target.id, targetTokenId: tok.id,
          targetName: targetVehicle?.name || target.name, weaponName: { fr: `Éperonnage (${vehicle.name})`, en: `Ram (${vehicle.name})` }, hits: roll.hits,
          dv, type: 'P', ap: targetVehicle ? 0 : -6, ram: { vehicleId: vehicle.id, name: vehicle.name, metersPerTurn: meters },
          ...(targetVehicle ? { vehicle: { vehicleId: targetVehicle.id, name: targetVehicle.name } } : {}),
          status: roll.hits > 0 ? 'defense' : 'missed', ...(roll.hits > 0 ? {} : { resolvedTs: ctx.now }), ...(gmOnly ? { gmOnly: true } : {}),
        });
        if (atk.status === 'missed') logAttack(ctx, tk('{attacker} misses {target}.'), { attacker: atk.attackerName, target: atk.targetName }, gmOnly);
        if (roll.entry.roll) roll.entry.roll.attackId = atk.id;
        const { entry, ...out } = roll;
        return { ...out, attackId: atk.id, dv };
      },
    },

    // GM: a vehicle crashes (SR5 p. 201-202): it resists its Body (AP −6), so do the passengers chosen (Stun when the Body is
    // below their armor). { actorId, vehicleId, passengerIds? }
    'vehicle/crash': {
      handler(ctx: ActionContext, p: CrashPayload = {}) {
        const { owner, vehicle } = getVehicle(ctx, p.actorId, p.vehicleId);
        const cv = chaseVehicleOf(ctx.state, owner.id, vehicle.id);
        crash(ctx, ctx.state.chase?.active ? ctx.state.chase : null, cv, owner, vehicle);
        const { dv } = crashDamage(vehicle);
        const ids = Array.isArray(p.passengerIds) ? [...new Set(p.passengerIds.slice(0, 20).map((x) => str(x, 60)))] : [];
        for (const id of ids) {
          const a = ctx.state.actors[id];
          if (!a) continue;
          pushAttack(ctx, {
            mapId: null, kind: 'blast', attackerId: null, attackerName: vehicle.name, targetId: a.id, targetTokenId: null, targetName: a.name,
            weaponName: { fr: `Accident (${vehicle.name})`, en: `Crash (${vehicle.name})` }, hits: 0, dv, modifiedDv: dv, type: dv < armorTotal(a) ? 'S' : 'P', ap: -6,
            status: 'soak', ...(a.type === 'npc' && a.hidden ? { gmOnly: true } : {}),
          });
        }
        return { passengers: ids.length };
      },
    },

    // ---------------------------------------------------------------------------------------------------------------
    // Chase Combat (SR5 p. 203-205)
    // ---------------------------------------------------------------------------------------------------------------

    // GM: { environment: 'speed'|'handling', terrain: 0|1|2|4, vehicles: [{ actorId, vehicleId, role: 'quarry'|'pursuer', range?, hidden? }] }
    'chase/start': {
      handler(ctx: ActionContext, p: ChaseStartPayload = {}) {
        const c: ChaseState = (ctx.state.chase = { ...emptyChase(), active: true, environment: envOf(p.environment), terrain: TERRAIN_VALUES.includes(Number(p.terrain)) ? Number(p.terrain) : 0, startedAt: ctx.now });
        for (const x of Array.isArray(p.vehicles) ? p.vehicles.slice(0, MAX_CHASE_VEHICLES) : []) if (isObj(x)) c.vehicles.push(newChaseVehicle(ctx, c, x));
        note(ctx, tk('🏁 A chase begins ({env} environment).'), { env: { t: c.environment === 'speed' ? 'Speed' : 'Handling' } });
        ctx.emitTo('players', 'sfx', { id: 'notify' });
        return { vehicles: c.vehicles.length };
      },
    },
    // GM: environment / terrain for this Combat Turn. { environment?, terrain? }
    'chase/update': {
      handler(ctx: ActionContext, p: ChaseUpdatePayload = {}) {
        const c = activeChase(ctx);
        if (p.environment !== undefined) {
          const env = envOf(p.environment, c.environment);
          if (env !== c.environment) note(ctx, tk('The chase enters a {env} environment.'), { env: { t: env === 'speed' ? 'Speed' : 'Handling' } });
          c.environment = env;
        }
        if (p.terrain !== undefined && TERRAIN_VALUES.includes(Number(p.terrain))) c.terrain = Number(p.terrain);
        return {};
      },
    },
    // GM: add a vehicle. { actorId, vehicleId, role, range?, hidden? }
    'chase/add': {
      handler(ctx: ActionContext, p: ChaseVehicleIn = {}) {
        const c = activeChase(ctx);
        if (c.vehicles.length >= MAX_CHASE_VEHICLES) ctx.fail('Too many vehicles');
        const cv = newChaseVehicle(ctx, c, p);
        c.vehicles.push(cv);
        note(ctx, tk('{vehicle} joins the chase.'), { vehicle: cv.name }, !!cv.hidden);
        return { id: cv.id };
      },
    },
    // GM: change a chase vehicle. { id, patch: { role?, range?, lost?, uncontrolled?, crashed?, hidden? } }
    'chase/set': {
      handler(ctx: ActionContext, p: ChaseSetPayload = {}) {
        const c = activeChase(ctx);
        const { cv } = getChaseVehicle(ctx, c, p.id);
        if (!isObj(p.patch)) ctx.fail('Invalid change');
        const x = p.patch;
        if (x.role !== undefined) cv.role = x.role === 'quarry' ? 'quarry' : 'pursuer';
        if (cv.role === 'pursuer' && !cv.range) cv.range = 'medium';
        if (cv.role === 'quarry') {
          delete cv.range;
          delete cv.lost;
        }
        if (x.range !== undefined && cv.role === 'pursuer') cv.range = rangeOf(x.range, cv.range);
        for (const k of ['lost', 'uncontrolled', 'crashed', 'hidden'] as const) if (x[k] !== undefined) {
          if (x[k]) cv[k] = true;
          else delete cv[k];
        }
        return {};
      },
    },
    // GM: { id }
    'chase/remove': {
      handler(ctx: ActionContext, p: { id?: unknown } = {}) {
        const c = activeChase(ctx);
        const id = str(p.id, 60);
        c.vehicles = c.vehicles.filter((x) => x.id !== id);
        c.pending = c.pending.filter((x) => x.chaseVehicleId !== id);
        return {};
      },
    },
    // GM: next Combat Turn of the chase (the GM sets the environment, then initiative is rolled on the tracker).
    'chase/round': {
      handler(ctx: ActionContext) {
        const c = activeChase(ctx);
        c.round = (c.round || 1) + 1;
        note(ctx, tk('Chase — Combat Turn {n}.'), { n: c.round });
        return { round: c.round };
      },
    },
    'chase/end': {
      handler(ctx: ActionContext) {
        const c = chaseOf(ctx.state);
        if (c.active) note(ctx, tk('The chase is over.'), {});
        ctx.state.chase = { ...emptyChase(), events: c.events.slice(0, 10) };
        return {};
      },
    },
    // GM: drop a pending test. { pendingId }
    'chase/dismiss': {
      handler(ctx: ActionContext, p: ChaseResolvePayload = {}) {
        const c = activeChase(ctx);
        c.pending = c.pending.filter((x) => x.id !== str(p.pendingId, 60));
        return {};
      },
    },

    // A driver's Chase Action (Complex): { id (chase vehicle), action: 'catchUp'|'breakAway'|'cutOff'|'ram'|'stunt', targetId?, threshold?, modifier?, explode? }
    'chase/action': {
      role: 'any',
      handler(ctx: ActionContext, p: ChaseActionPayload = {}) {
        const c = activeChase(ctx);
        pruneChase(ctx.state);
        const { cv, owner, vehicle } = getChaseVehicle(ctx, c, p.id);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        if (cv.crashed) ctx.fail('{vehicle} has crashed', { vehicle: vehicle.name });
        if (vehicleDestroyed(vehicle)) ctx.fail('{vehicle} is destroyed', { vehicle: vehicle.name });
        if (cv.lost && !ctx.isGM) ctx.fail('{vehicle} has lost the quarry', { vehicle: vehicle.name });
        const action = (CHASE_ACTIONS as readonly string[]).includes(str(p.action, 20)) ? (p.action as ChaseActionId) : null;
        if (!action) ctx.fail('Unknown action');
        if (action === 'stunt' && cv.role !== 'quarry') ctx.fail('Only the quarry can attempt a stunt');
        const env = c.environment;
        const driver = driverOf(ctx.state, owner, vehicle);
        const ctrl = controllerInfo(ctx.state, driver);
        const gm = !!cv.hidden;
        const label = { catchUp: tk('Catch-up'), breakAway: tk('Break away'), cutOff: tk('Cut-off'), ram: tk('Ram'), stunt: tk('Stunt') }[action];
        const info = { vehicleId: vehicle.id, name: vehicle.name, test: action };
        const extra = uncontrolledLines(ctx.state, owner, vehicle);
        spendComplex(ctx, owner, vehicle, { t: tk('{action} — {vehicle}'), params: { action: { t: label }, vehicle: vehicle.name } });
        // Opposed actions at Short range: Cut-off, Ram.
        let target: { cv: ChaseVehicle; owner: Actor; vehicle: Vehicle } | null = null;
        if (p.targetId) target = getChaseVehicle(ctx, c, p.targetId);
        if (chaseActionNeedsShort(action)) {
          if (!target) ctx.fail('Choose the target vehicle');
          if (rangeBetween(c, cv, target.cv) !== 'short') ctx.fail('{action}: Short range only', { action: { t: label } });
          if (target.cv.crashed) ctx.fail('{vehicle} has crashed', { vehicle: target.vehicle.name });
          const tDriver = driverOf(ctx.state, target.owner, target.vehicle);
          const tCtrl = controllerInfo(ctx.state, tDriver);
          const limitEnv = action === 'ram' ? env : 'handling';
          const plan = vehicleTestPlan(vehicle, 'control', ctrl, driver, { env: limitEnv });
          const tPlan = vehicleTestPlan(target.vehicle, 'control', tCtrl, tDriver, { env: limitEnv });
          const roll = rollPlan(ctx, owner, vehicle, plan, { label, info, modifier: p.modifier, explode: p.explode, extra });
          const opp = rollOpposed(ctx, target.owner, target.vehicle, tPlan, label, { vehicleId: target.vehicle.id, name: target.vehicle.name, test: action });
          const net = roll.hits - opp.hits;
          const vinfo = { ...info, opposed: opp.hits, net, success: net > 0 };
          if (roll.entry.roll) roll.entry.roll.vehicle = vinfo;
          const hidden = gm || !!target.cv.hidden;
          if (net <= 0) {
            note(ctx, tk('{vehicle} fails to {action} {target}.'), { vehicle: vehicle.name, action: { t: label }, target: target.vehicle.name }, hidden);
          } else if (action === 'cutOff') {
            const pend: ChasePending = { id: uid('chp'), chaseVehicleId: target.cv.id, threshold: net, onFail: 'crash', reason: { t: tk('Cut off by {vehicle}'), params: { vehicle: vehicle.name } } };
            c.pending.push(pend);
            note(ctx, tk('{vehicle} cuts off {target}: Vehicle Test ({n}) or crash.'), { vehicle: vehicle.name, target: target.vehicle.name, n: net }, hidden);
          } else {
            // Ram: the target takes the rammer's Body + net hits, the rammer half its Body (SR5 p. 204).
            const body = vehicleStats(vehicle).body;
            addVehicleSoak(ctx, { owner: target.owner, vehicle: target.vehicle, dv: body + net, attacker: owner, attackerName: vehicle.name, weaponName: { fr: 'Éperonnage', en: 'Ram' }, gmOnly: hidden });
            addVehicleSoak(ctx, { owner, vehicle, dv: Math.ceil(body / 2), attacker: owner, attackerName: vehicle.name, weaponName: { fr: 'Éperonnage', en: 'Ram' }, gmOnly: hidden });
            note(ctx, tk('{vehicle} rams {target}: {dv} DV to {target}, {self} DV to itself.'), { vehicle: vehicle.name, target: target.vehicle.name, dv: body + net, self: Math.ceil(body / 2) }, hidden);
          }
          const { entry, ...out } = roll;
          return { ...out, vehicle: vinfo };
        }
        // Catch-up / Break away (any range) and Stunt (quarry): Vehicle Test against the maneuver threshold + terrain.
        const base = int(p.threshold, 0, 12, 1);
        const plan = vehicleTestPlan(vehicle, 'control', ctrl, driver, { env, threshold: base, terrain: c.terrain });
        const roll = rollPlan(ctx, owner, vehicle, plan, { label, info, modifier: p.modifier, explode: p.explode, extra });
        const net = roll.vehicle?.net ?? 0;
        if (action === 'stunt') {
          if (net < 0) {
            cv.uncontrolled = true;
            note(ctx, tk('{vehicle} botches the stunt and goes out of control (crash, or the pursuers gain a range: GM\'s call).'), { vehicle: vehicle.name }, gm);
          } else {
            const followers = c.vehicles.filter((x) => x.role === 'pursuer' && !x.lost && !x.crashed);
            for (const f of followers) c.pending.push({ id: uid('chp'), chaseVehicleId: f.id, threshold: base + c.terrain, onFail: 'fallBack', reason: { t: tk('Follow the stunt of {vehicle}'), params: { vehicle: vehicle.name } } });
            note(ctx, tk('{vehicle} pulls off a stunt: the pursuers must pass a Vehicle Test ({n}) or fall back.'), { vehicle: vehicle.name, n: base + c.terrain }, gm);
          }
        } else if (net < 0) {
          note(ctx, tk('{vehicle} fails to {action}.'), { vehicle: vehicle.name, action: { t: label } }, gm);
        } else {
          const shift = Math.min(net, Math.max(0, vehicleStats(vehicle).accel));
          const dir = action === 'catchUp' ? -1 : 1;
          const moved: ChaseVehicle[] = cv.role === 'pursuer'
            ? [cv]
            : target ? [target.cv] : c.vehicles.filter((x) => x.role === 'pursuer' && !x.lost && !x.crashed);
          for (const m of moved) {
            if (m.role !== 'pursuer' || m.lost) continue;
            const next = shiftRange(m.range, dir * shift);
            if (next === 'lost') {
              // Out of Extreme range: the pursuer gets a test to keep the quarry in sight (SR5 p. 204).
              m.range = 'extreme';
              c.pending.push({ id: uid('chp'), chaseVehicleId: m.id, threshold: base + c.terrain, onFail: 'fallBack', reason: { t: tk('Keep {vehicle} in sight'), params: { vehicle: cv.role === 'quarry' ? vehicle.name : '—' } } });
              note(ctx, tk('{vehicle} breaks away beyond Extreme range: {other} must keep it in sight (Vehicle Test {n}).'), { vehicle: vehicle.name, other: m.name, n: base + c.terrain }, gm || !!m.hidden);
            } else {
              m.range = next;
              note(ctx, shift
                ? tk('{vehicle}: {action} ({n} range(s)) — {other} now at {range} range.')
                : tk('{vehicle}: {action} — no ground gained ({other} at {range} range).'), { vehicle: vehicle.name, action: { t: label }, n: shift, other: m.name, range: { t: rangeKey(m.range) } }, gm || !!m.hidden);
            }
          }
        }
        const { entry, ...out } = roll;
        return out;
      },
    },

    // A driver passes (or fails) a test the chase gave them: { pendingId, modifier?, explode? }
    'chase/resolve': {
      role: 'any',
      handler(ctx: ActionContext, p: ChaseResolvePayload = {}) {
        const c = activeChase(ctx);
        const pend = c.pending.find((x) => x.id === str(p.pendingId, 60));
        if (!pend) ctx.fail('Nothing to resolve');
        const { cv, owner, vehicle } = getChaseVehicle(ctx, c, pend.chaseVehicleId);
        if (!mayControl(ctx, owner, vehicle)) ctx.fail('That is not your vehicle');
        const driver = driverOf(ctx.state, owner, vehicle);
        const plan = vehicleTestPlan(vehicle, 'control', controllerInfo(ctx.state, driver), driver, { env: c.environment, threshold: pend.threshold });
        const roll = rollPlan(ctx, owner, vehicle, plan, {
          label: tk('Vehicle Test'), info: { vehicleId: vehicle.id, name: vehicle.name, test: 'follow' }, modifier: p.modifier, explode: p.explode,
          extra: uncontrolledLines(ctx.state, owner, vehicle),
        });
        c.pending = c.pending.filter((x) => x.id !== pend.id);
        if (roll.vehicle?.success) {
          note(ctx, tk('{vehicle} keeps control ({hits} hit(s) vs {n}).'), { vehicle: vehicle.name, hits: roll.hits, n: plan.threshold ?? pend.threshold }, !!cv.hidden);
        } else failPending(ctx, c, pend, cv, owner, vehicle);
        const { entry, ...out } = roll;
        return out;
      },
    },
  },

  filter: filterView,
};

export default mod;

