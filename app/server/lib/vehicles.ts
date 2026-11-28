// Server helpers for vehicles (34-vehicles, 33-attacks, 30-combat): find a vehicle and its driver, the controller's rigging
// situation (control rig, VR / hot sim, Data Processing), the catalog's drone flag. Rules are in shared/vehicles.ts.
import { appCatalog } from './chummer/data.ts';
import { controlRigRating, controlOf, rccRating, swarmVehicle } from '../../shared/vehicles.ts';
import type { ControllerInfo, RollerPlan, PlanLine } from '../../shared/vehicles.ts';
import { attr, derive, skillPool, skillEn, SKILL_BY_ID } from '../../shared/sr5.ts';
import type { ActionContext, Actor, ActorId, TableState, Vehicle } from '../../shared/types.ts';

/** The vehicle `vehicleId` of `actor` (null when missing). */
export function vehicleOf(actor: Actor | null | undefined, vehicleId: unknown): Vehicle | null {
  if (!actor || !vehicleId) return null;
  return (actor.vehicles || []).find((v) => v && v.id === String(vehicleId)) || null;
}

/** Owner + vehicle, or fail. */
export function getVehicle(ctx: ActionContext, actorId: unknown, vehicleId: unknown): { owner: Actor; vehicle: Vehicle } {
  const owner = ctx.state.actors?.[String(actorId ?? '')];
  if (!owner) ctx.fail('Character not found');
  const vehicle = vehicleOf(owner, vehicleId);
  if (!vehicle) ctx.fail('Vehicle not found');
  return { owner, vehicle };
}

/** Actor at the controls (driver / rigger / remote operator): the vehicle's driverId, else its owner; null on autopilot. */
export function driverOf(state: TableState, owner: Actor, v: Vehicle): Actor | null {
  if (controlOf(v) === 'auto') return null;
  const d = v.driverId ? state.actors?.[v.driverId] : null;
  return d || owner;
}

/** May this user act for the vehicle: GM, the owner's player, or the driver's player. */
export function mayControl(ctx: ActionContext, owner: Actor, v: Vehicle): boolean {
  if (ctx.isGM || ctx.owns(owner.id)) return true;
  return !!v.driverId && !!ctx.state.actors?.[v.driverId] && ctx.owns(v.driverId);
}

/** The controller's rigging situation (shared/vehicles.ts ControllerInfo). */
export function controllerInfo(state: TableState, driver: Actor | null): ControllerInfo {
  if (!driver) return { rig: 0, vr: false, hot: false, dataProcessing: 0 };
  const persona = state.matrix?.personas?.[driver.id];
  const mode = persona?.online ? persona.mode : null;
  return {
    rig: controlRigRating(driver),
    vr: mode === 'cold' || mode === 'hot',
    hot: mode === 'hot',
    dataProcessing: Math.max(0, Number(driver.matrix?.dataProcessing) || 0),
  };
}

/** Is the catalog entry of this vehicle a drone? null when the vehicle has no catalog entry. */
export function catalogDrone(v: Vehicle): boolean | null {
  try {
    type Entry = { id?: string; name?: string; category?: string; stats?: { drone?: boolean } };
    const list = appCatalog('vehicles').list as Entry[];
    const norm = (x: unknown) => String(x ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
    const last = (x: unknown) => norm(x).split(/s+/).pop() || '';
    // By catalog id, else by name (Foundry imports without an id: same name, or same distinctive last word, « … Nightwing »).
    const hit = (v.catalogId ? list.find((x) => x.id === v.catalogId) : null)
      || list.find((x) => norm(x.name) === norm(v.name))
      || (last(v.name).length >= 5 ? list.find((x) => last(x.name) === last(v.name)) : undefined);
    if (!hit) return null;
    return !!hit.stats?.drone || /^Drones/i.test(hit.category || '');
  } catch {
    return null;
  }
}

/**
 * A pool rolled without a sheet roll (the other side of an opposed vehicle test, rolled for the acting player): skill +
 * attribute + wound modifier of the driver, or the drone's Pilot + autosoft. → { pool, parts }.
 */
export function plainPool(driver: Actor | null, roller: RollerPlan, extra: PlanLine[] = []): { pool: number; parts: string[] } {
  const parts: string[] = [];
  let pool = 0;
  if (roller.kind === 'pilot' || !driver) {
    const lines = roller.kind === 'pilot' ? roller.lines : [];
    for (const l of lines) parts.push(`${l.label} ${l.value}`);
    pool = roller.kind === 'pilot' ? roller.pool : 0;
  } else {
    const res = roller.skillId ? skillPool(driver, roller.skillId, { attrOverride: roller.attr }) : { pool: attr(driver, roller.attr) + attr(driver, 'INT'), defaulting: false };
    pool = res.pool;
    const sk = (driver.skills || []).find((s) => s.id === roller.skillId);
    if (roller.skillId) parts.push(res.defaulting ? 'defaulting −1' : `${SKILL_BY_ID[roller.skillId] ? skillEn(roller.skillId) : sk?.name || roller.skillId} ${sk?.rating ?? 0}`);
    parts.push(`${roller.attr} ${attr(driver, roller.attr)}`);
    if (!roller.skillId) parts.push(`INT ${attr(driver, 'INT')}`);
    const w = derive(driver).woundModifier;
    if (w) {
      pool += w;
      parts.push(`wounds −${Math.abs(w)}`);
    }
  }
  for (const l of extra) {
    if (!l.value) continue;
    pool += l.value;
    parts.push(`${l.label} ${l.value > 0 ? '+' : '−'}${Math.abs(l.value)}`);
  }
  return { pool: Math.max(0, pool), parts };
}

/** Display name of a vehicle with its owner: « Harley-Davidson Nightmare (Anthony) ». */
export const vehicleLabel = (owner: Actor, v: Vehicle): string => `${v.name} (${owner.name})`;

/** Owner ids of every vehicle a driver controls (driverId = that actor). */
export function vehiclesDrivenBy(state: TableState, actorId: ActorId): Array<{ owner: Actor; vehicle: Vehicle }> {
  const out: Array<{ owner: Actor; vehicle: Vehicle }> = [];
  for (const a of Object.values(state.actors || {})) for (const v of a?.vehicles || []) if (v?.driverId === actorId) out.push({ owner: a, vehicle: v });
  return out;
}

/** The vehicle as it acts: its swarm merged into one drone when it is in one (Rigger 5.0 p. 31). */
export function effectiveVehicle(state: TableState, owner: Actor, v: Vehicle): Vehicle {
  if (!v.swarm) return v;
  const driver = driverOf(state, owner, v);
  return swarmVehicle(owner.vehicles, v, Math.max(rccRating(owner), rccRating(driver))) as Vehicle;
}
