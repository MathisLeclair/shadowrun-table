// Attacks module: targeted attacks resolved step by step — attack roll → the target's defense → damage resistance → damage applied —
// grenades / launchers (aimed point, scatter, blast on the map) and the special combat actions (SR5 + Run & Gun, shared/combat.js).
// Rolls go through the characters module's performRoll (same modifiers, log entries and Edge as « dice/roll »).
// State: attacks: { list: [Attack] (newest first, max 60), blasts: [Blast] (max 12), turn: { [actorId]: { key, defended, boosts, once } } }.
import { parseDamage, attr } from '../../shared/sr5.ts';
import {
  ACTION_BY_ID, isUnlocked, rangeFor, rangeClass, RANGE_BANDS, environmentFor, attackSenses, activeBlasts, pruneExpired, areaEffectOf,
  LASTING_EFFECTS, TOXIN_BY_ID, toxinFromText, toxinOutcome, toxinProtection, untilFor, AFFLICTIONS,
  cellDistance, isAreaWeapon, scatterDice, rollScatter, blastOf, blastDvAt, blastReach, defenseLines,
  finalDamageType, DEFENSE_BY_ID, SITUATION_BY_ID, attackActionType,
} from '../../shared/combat.ts';
import { FIRE_BY_ID, isLauncherProfile, launcherRounds, fireOptions, usesAmmo } from '../../client/modules/sheet/inventory.ts';
import { createVisionContext, tokenVision } from '../../shared/vision.ts';
import { effectsLookup } from '../lib/modifiers.ts';
import { performRoll, applyDamage } from './10-characters.ts';
import { ELEMENTS, elementLabel, hasEnergyAura, type CombatSpellProfile, type SpellElement } from '../../shared/magic.ts';
import { spendInitiative, combatTurnKey } from './30-combat.ts';
import { recordAction } from '../lib/combat-actions.ts';
import { controllerInfo, driverOf, effectiveVehicle, mayControl, vehicleOf } from '../lib/vehicles.ts';
import { CALLED_SHOT_BY_ID, controlLimit, controlOf, gunneryPlan, vehicleDefensePlan, vehicleDestroyed, vehicleMonitor, vehicleStats, withBreakdown, NO_CONTROLLER } from '../../shared/vehicles.ts';
import type { PlanLine } from '../../shared/vehicles.ts';
import type { PerformedRoll, RollBonusLine, RollInternal, RollPayload } from './10-characters.ts';
import type {
  ActionContext, Actor, ActorId, AfflictionKind, AttrKey, Attack, AttacksState, AttackTurnRecord, Blast, BlastHit, BiName, DamageType, GameMap, GameView,
  I18nEntry, I18nMessage, I18nParams, Point, ServerModule, SessionUser, TableState, Token, Vehicle,
} from '../../shared/types.ts';

/** Weapons / launcher profiles / catalog entries / player payloads of several shapes: read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
/** Anything with catalog names (weapon, launcher profile). */
type Named = { name?: string; nameFr?: string; nameEn?: string } | null | undefined;
/** Where an area weapon lands (shared/combat.js rollScatter, or the thrower's cell on a critical glitch). */
type Landing = { x: number; y: number; meters: number; scattered?: boolean; fumble?: boolean; glitch?: boolean; dir?: number[] | null; dist?: number[] | null };
/** Blast profile of an area weapon (shared/combat.js blastOf). */
type BlastProfile = { dv: number | null; type: DamageType; ap: number; falloff: number | null; radius: number | null; damaging: boolean };
/** doDefend / doSoak options (player fields checked inside). */
type ResolveOpts = { options?: string[]; situations?: string[]; modifier?: unknown; explode?: unknown };

const tk = (s: string): string => s;
const MAX_ATTACKS = 60;
const MAX_BLASTS = 12;
const THROW_THRESHOLD = 3; // grenade / projectile: 3 hits = lands where aimed (SR5 p. 182)
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): string => (v === undefined || v === null ? '' : String(v).slice(0, max));
const int = (v: unknown, lo: number, hi: number, d = 0): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const ids = (v: unknown, max = 12): string[] => (Array.isArray(v) ? [...new Set(v.slice(0, max).map((x) => str(x, 40)))] : []);

function slice(state: TableState): AttacksState {
  if (!isObj(state.attacks)) state.attacks = {} as AttacksState;
  const s = state.attacks;
  if (!Array.isArray(s.list)) s.list = [];
  if (!Array.isArray(s.blasts)) s.blasts = [];
  if (!isObj(s.turn)) s.turn = {};
  return s;
}

/** Per-actor Combat Turn record (defenses made, turn-long defense boosts paid, once-per-turn actions used). */
function turnOf(state: TableState, actorId: ActorId): AttackTurnRecord | null {
  const key = combatTurnKey(state);
  if (!key) return null;
  const s = slice(state);
  let t = s.turn[actorId];
  if (!t || t.key !== key) t = s.turn[actorId] = { key, defended: 0, boosts: [], once: [] };
  return t;
}

function getAttack(ctx: ActionContext, id: string): Attack {
  const a = slice(ctx.state).list.find((x) => x.id === id);
  if (!a) ctx.fail('Attack not found');
  return a;
}
function actorOf(ctx: ActionContext, id: string): Actor {
  const a = ctx.state.actors[id];
  if (!a) ctx.fail('Character not found');
  return a;
}
const nameOf = (w: Named): string => w?.nameFr || w?.name || '';
const biName = (w: Named): BiName => ({ fr: w?.nameFr || w?.name || '', en: w?.nameEn || w?.name || w?.nameFr || '' });

/** Map of the attack: the one asked (GM), else the active map. Token of an actor on it (first one). */
function mapFor(ctx: ActionContext, mapId: unknown): GameMap | null {
  const id = ctx.isGM && mapId ? str(mapId, 60) : ctx.state.scene?.activeMapId;
  return id ? ctx.state.maps?.[id] || null : null;
}
/** The actor's own token (not one of their vehicles'). */
const tokenOf = (map: GameMap | null, actorId: ActorId): Token | null => (map?.tokens || []).find((t) => t.actorId === actorId && !t.vehicleId) || null;
const vehicleToken = (map: GameMap | null, actorId: ActorId, vehicleId: string): Token | null => (map?.tokens || []).find((t) => t.actorId === actorId && t.vehicleId === vehicleId) || null;

function push<T>(state: TableState, list: T[], item: NoInfer<T>, max: number): T {
  list.unshift(item);
  if (list.length > max) list.length = max;
  return item;
}

function logAttack(ctx: ActionContext, key: string, params: I18nParams, gmOnly?: boolean): void {
  ctx.log({ kind: 'combat', userId: ctx.user.id, author: 'Combat', i18n: { key, params }, ...(gmOnly ? { gmOnly: true } : {}) });
}

/** Damage Value and type of a weapon (or a launcher's ammunition profile) for this actor: { dv: number|null, type }. */
function weaponDamage(actor: Actor, w: Loose | null): { dv: number | null; type: DamageType } {
  const p = parseDamage(w?.damage, actor);
  return { dv: Number.isFinite(p.value) ? p.value : null, type: p.type as DamageType };
}
const apOf = (w: { ap?: unknown } | null | undefined): number => {
  const n = Number(String(w?.ap ?? '0').replace(/[^-+\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------------------------------------------------
// Vehicles (SR5 p. 199-205, 266): vehicle targets, ramming, vehicle damage and the jumped-in rigger's biofeedback
// ---------------------------------------------------------------------------------------------------------------------

const bonusOf = (lines: PlanLine[]): RollBonusLine[] => lines.filter((l) => l.value).map((l) => ({ label: l.label, value: l.value }));
const limitBreakdown = (lines: PlanLine[]): string => lines.map((l, i) => (i ? `${l.label} ${l.value >= 0 ? '+' : '−'}${Math.abs(l.value)}` : `${l.label} ${l.value}`)).join(' + ');

/** Push an attack to the list (34-vehicles: ramming, crashes, chase rams). */
export function pushAttack(ctx: ActionContext, atk: Omit<Attack, 'id' | 'ts'> & { id?: string }): Attack {
  return push<Attack>(ctx.state, slice(ctx.state).list, { ...atk, id: atk.id || ctx.uid('atk'), ts: ctx.now } as Attack, MAX_ATTACKS);
}
export { logAttack };

/**
 * A soak attack against a vehicle (blast, crash, chase ram): Body + Armor, no defense. `ap` modifies the vehicle's armor.
 */
export function addVehicleSoak(ctx: ActionContext, o: { owner: Actor; vehicle: Vehicle; dv: number; ap?: number; attacker?: Actor | null; attackerName?: string; weaponName: BiName; mapId?: string | null; tokenId?: string | null; gmOnly?: boolean }): Attack {
  return pushAttack(ctx, {
    mapId: o.mapId ?? null, kind: 'blast', attackerId: o.attacker?.id || null, attackerName: o.attackerName || o.attacker?.name || '—', targetId: o.owner.id,
    targetTokenId: o.tokenId ?? null, targetName: o.vehicle.name, weaponName: o.weaponName, hits: 0, dv: o.dv, modifiedDv: o.dv, type: 'P', ap: o.ap || 0,
    vehicle: { vehicleId: o.vehicle.id, name: o.vehicle.name }, status: 'soak', ...(o.gmOnly || (o.owner.type === 'npc' && o.owner.hidden) ? { gmOnly: true } : {}),
  });
}

/** Biofeedback soak attack against a jumped-in rigger (WIL + Firewall; hot sim Physical, cold sim Stun — SR5 p. 229, 266). */
function addFeedback(ctx: ActionContext, rigger: Actor, dv: number, what: BiName, gmOnly?: boolean): Attack {
  const persona = ctx.state.matrix?.personas?.[rigger.id];
  const type: DamageType = persona?.online && persona.mode === 'hot' ? 'P' : 'S';
  return pushAttack(ctx, {
    mapId: null, kind: 'blast', attackerId: null, attackerName: '—', targetId: rigger.id, targetTokenId: null, targetName: rigger.name, weaponName: what,
    hits: 0, dv, modifiedDv: dv, type, ap: 0, feedback: true, status: 'soak', ...(gmOnly ? { gmOnly: true } : {}),
  });
}

/**
 * Fill boxes of a vehicle's condition monitor (vehicles ignore Stun). A jumped-in rigger resists half of it as biofeedback,
 * and dumpshock (6 DV) when the vehicle is destroyed under them (SR5 p. 266). The vehicle's tokens get the « détruit » marker.
 */
export function damageVehicle(ctx: ActionContext, owner: Actor, v: Vehicle, boxes: number, { gmOnly }: { gmOnly?: boolean } = {}): void {
  const n = Math.max(0, Math.round(boxes));
  if (!n) return;
  const max = vehicleMonitor(v);
  const was = vehicleDestroyed(v);
  v.damage = Math.min(max, (Number(v.damage) || 0) + n);
  const now = vehicleDestroyed(v);
  const hidden = gmOnly || (owner.type === 'npc' && !!owner.hidden);
  ctx.log({
    kind: 'combat', userId: ctx.user.id, author: v.name, ...(hidden ? { gmOnly: true } : {}),
    i18n: now && !was
      ? { key: tk('{vehicle} takes {n} box(es) of damage — destroyed!'), params: { vehicle: v.name, n } }
      : { key: tk('{vehicle} takes {n} box(es) of damage ({d}/{max}).'), params: { vehicle: v.name, n, d: v.damage, max } },
  });
  if (now !== was) {
    for (const m of Object.values<GameMap>(ctx.state.maps || {})) {
      for (const t of m?.tokens || []) {
        if (t.actorId !== owner.id || t.vehicleId !== v.id) continue;
        const kept = (t.status || []).filter((s) => s !== 'détruit');
        t.status = now ? [...kept, 'détruit'] : kept;
      }
    }
    for (const e of ctx.state.combat?.entries || []) if (e.kind === 'drone' && e.vehicleId === v.id) e.down = now;
  }
  const rigger = controlOf(v) === 'rigged' ? driverOf(ctx.state, owner, v) : null;
  if (!rigger) return;
  addFeedback(ctx, rigger, Math.ceil(n / 2), { fr: `Biofeedback (${v.name})`, en: `Biofeedback (${v.name})` }, hidden);
  if (now && !was) addFeedback(ctx, rigger, 6, { fr: `Choc de déconnexion (${v.name})`, en: `Dumpshock (${v.name})` }, hidden);
  logAttack(ctx, tk('{rigger} is jumped into {vehicle}: biofeedback to resist.'), { rigger: rigger.name, vehicle: v.name }, hidden);
}

/**
 * A called shot at a vehicle component landed (Run & Gun p. 115): its breakdown is set; an antenna shot cuts a remote
 * control (the autopilot takes over, SR5 p. 202).
 */
function applyCalledShot(ctx: ActionContext, owner: Actor, v: Vehicle, atk: Attack): void {
  const shot = atk.calledShot ? CALLED_SHOT_BY_ID[atk.calledShot] : null;
  if (!shot) return;
  v.breakdowns = withBreakdown(v.breakdowns, shot);
  const hidden = atk.gmOnly || (owner.type === 'npc' && !!owner.hidden);
  logAttack(ctx, tk('{vehicle}: {part} hit — {effect}'), { vehicle: v.name, part: { t: shot.label }, effect: { t: shot.note } }, hidden);
  if (shot.effect === 'antenna' && controlOf(v) === 'remote') {
    v.control = vehicleStats(v).pilot > 0 ? 'auto' : 'manual';
    if (v.control === 'manual') delete v.control;
    logAttack(ctx, tk('{vehicle} loses its remote control link.'), { vehicle: v.name }, hidden);
  }
}

/** The vehicle of a vehicle attack (fails when it was sold / removed meanwhile). */
function attackVehicle(ctx: ActionContext, atk: Attack): { owner: Actor; vehicle: Vehicle } {
  const owner = actorOf(ctx, atk.targetId);
  const vehicle = vehicleOf(owner, atk.vehicle?.vehicleId);
  if (!vehicle) ctx.fail('Vehicle not found');
  return { owner, vehicle };
}

/**
 * Defense of a vehicle (SR5 p. 205): the driver's REA + INT (evasive driving: + INT, −10 initiative; not against a ram),
 * a drone on its own Pilot + Maneuvering [Handling]. A ram is opposed with REA + INT [Handling] (p. 203).
 */
function doVehicleDefend(ctx: ActionContext, atk: Attack, { options = [], modifier = 0, explode = false }: ResolveOpts): PerformedRoll {
  const { owner, vehicle } = attackVehicle(ctx, atk);
  if (!mayControl(ctx, owner, vehicle)) ctx.fail('Only the target\'s player (or the GM) can defend');
  const driver = driverOf(ctx.state, owner, vehicle);
  const c = controllerInfo(ctx.state, driver);
  const plan = vehicleDefensePlan(vehicle, c, driver);
  const bonus: RollBonusLine[] = bonusOf(plan.bonus);
  if (atk.defenseMod) bonus.push({ label: atk.defenseLabel || tk('fire mode'), value: atk.defenseMod });
  if (atk.actionDefense) bonus.push({ label: atk.actionName || tk('action'), value: atk.actionDefense });
  const evasive = options.includes('evasive') && !atk.ram && plan.roller.kind === 'driver' && !!driver;
  if (evasive) bonus.push({ label: tk('evasive driving'), value: attr(driver, 'INT') });
  const vehicleInfo = { vehicleId: vehicle.id, name: vehicle.name, test: 'defense' };
  let roll: PerformedRoll;
  if (plan.roller.kind === 'driver' && driver) {
    const lim = atk.ram ? controlLimit(vehicle, controlOf(vehicle), c) : null;
    roll = performRoll(ctx, {
      actorId: driver.id, attr: 'REA', attr2: 'INT', test: 'defense', label: tk('Vehicle defense'), modifier: int(modifier, -30, 30), explode: !!explode,
    }, {
      bonus, logExtra: { attackId: atk.id, defense: true, vehicle: vehicleInfo },
      ...(lim ? { limitAdjust: { replace: lim.limit, label: lim.label, breakdown: limitBreakdown(lim.lines) } } : {}),
    });
    if (evasive) spendInitiative(ctx, driver.id, 10, tk('evasive driving'));
  } else {
    const r = plan.roller.kind === 'pilot' ? plan.roller : { pool: 0, lines: [] };
    roll = performRoll(ctx, { label: tk('Vehicle defense'), modifier: int(modifier, -30, 30) }, {
      bonus, basePool: { pool: r.pool, parts: r.lines.map((l) => `${l.label} ${l.value}`) }, author: vehicle.name,
      limitAdjust: { replace: plan.limit, label: plan.limitLabel, breakdown: limitBreakdown(plan.limitLines) },
      logExtra: { attackId: atk.id, defense: true, actorId: owner.id, vehicle: vehicleInfo },
    });
  }
  atk.defenseHits = roll.hits;
  atk.defenseLogId = roll.logId;
  atk.net = atk.hits - roll.hits;
  if (atk.net <= 0) {
    atk.status = 'missed';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{target} avoids {attacker}\'s attack.'), { target: atk.targetName, attacker: atk.attackerName }, atk.gmOnly);
  } else if (atk.noDamage || atk.dv === null) {
    atk.status = 'done';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{attacker} succeeds against {target}: {n} net hit(s).'), { attacker: atk.attackerName, target: atk.targetName, n: atk.net }, atk.gmOnly);
  } else if (atk.calledShot && CALLED_SHOT_BY_ID[atk.calledShot]?.dvLimit === 0) {
    // Door lock / window motor: no damage, the effect alone (Run & Gun p. 115).
    atk.status = 'done';
    atk.resolvedTs = ctx.now;
    atk.damage = 0;
    applyCalledShot(ctx, owner, vehicle, atk);
  } else {
    atk.status = 'soak';
    const cap = atk.calledShot ? CALLED_SHOT_BY_ID[atk.calledShot]?.dvLimit : null;
    atk.modifiedDv = cap ? Math.min(cap, atk.dv + atk.net) : atk.dv + atk.net;
    logAttack(ctx, tk('{attacker} hits {target}: DV {dv}{type}, AP {ap}.'), { attacker: atk.attackerName, target: atk.targetName, dv: atk.modifiedDv, type: atk.type, ap: atk.ap }, atk.gmOnly);
  }
  if (atk.ram && atk.net > 0) ramBacklash(ctx, atk);
  return roll;
}

/**
 * Damage resistance of a vehicle (SR5 p. 199, 205): Body + Armor (modified by AP). A modified DV below the modified Armor
 * does nothing, and so does Stun damage unless it is electrical.
 */
function doVehicleSoak(ctx: ActionContext, atk: Attack, { modifier = 0 }: ResolveOpts): PerformedRoll | null {
  const { owner, vehicle } = attackVehicle(ctx, atk);
  if (!mayControl(ctx, owner, vehicle)) ctx.fail('Only the target\'s player (or the GM) can resist the damage');
  const st = vehicleStats(vehicle);
  const armor = Math.max(0, st.armor + (atk.ap || 0));
  const dv = atk.modifiedDv ?? atk.dv ?? 0;
  const done = (boxes: number, hits: number, logId?: string) => {
    atk.soakHits = hits;
    if (logId) atk.soakLogId = logId;
    atk.damage = boxes;
    atk.damageType = 'P';
    atk.status = 'done';
    atk.resolvedTs = ctx.now;
  };
  if ((atk.type === 'S' && !atk.electric) || dv < armor) {
    done(0, 0);
    logAttack(ctx, atk.type === 'S' && !atk.electric
      ? tk('{target} ignores Stun damage (vehicle).')
      : tk('{target}: DV {dv} under its armor ({armor}), no damage.'), { target: atk.targetName, dv, armor }, atk.gmOnly);
    return null;
  }
  const roll = performRoll(ctx, { label: tk('Vehicle damage resistance'), modifier: int(modifier, -30, 30), limit: null }, {
    basePool: { pool: st.body + armor, parts: [`Body ${st.body}`, `armor ${st.armor}`, ...(atk.ap ? [`AP ${atk.ap > 0 ? '+' : '−'}${Math.abs(atk.ap)}`] : [])] },
    author: vehicle.name, logExtra: { attackId: atk.id, soak: true, actorId: owner.id, vehicle: { vehicleId: vehicle.id, name: vehicle.name, test: 'soak' } },
  });
  const boxes = Math.max(0, dv - roll.hits);
  done(boxes, roll.hits, roll.logId);
  if (boxes > 0) {
    damageVehicle(ctx, owner, vehicle, boxes, { gmOnly: atk.gmOnly });
    applyCalledShot(ctx, owner, vehicle, atk);
  } else logAttack(ctx, tk('{target} resists it all ({dv}{type}).'), { target: atk.targetName, dv, type: 'P' }, atk.gmOnly);
  return roll;
}

/** A ram that hit: the ramming vehicle resists half the base DV (SR5 p. 203); both drivers owe a Vehicle Test (2 / 3). */
function ramBacklash(ctx: ActionContext, atk: Attack): void {
  const rammer = atk.attackerId ? ctx.state.actors[atk.attackerId] : null;
  const v = vehicleOf(rammer, atk.ram?.vehicleId);
  if (!rammer || !v) return;
  const map = atk.mapId ? ctx.state.maps?.[atk.mapId] || null : null;
  addVehicleSoak(ctx, {
    owner: rammer, vehicle: v, dv: Math.ceil((atk.dv || 0) / 2), attacker: rammer, weaponName: { fr: 'Éperonnage', en: 'Ramming' },
    mapId: atk.mapId, tokenId: vehicleToken(map, rammer.id, v.id)?.id || null, gmOnly: atk.gmOnly,
  });
  logAttack(ctx, atk.vehicle
    ? tk('Ram: {rammer} must pass a Vehicle Test (2) and {target} a Vehicle Test (3), or lose control.')
    : tk('Ram: {rammer} must pass a Vehicle Test (2) or lose control.'), { rammer: v.name, target: atk.targetName }, atk.gmOnly);
}

/** Biofeedback soak: WIL + Firewall of the rigger's device, no armor (SR5 p. 229). */
function doFeedbackSoak(ctx: ActionContext, atk: Attack, target: Actor, { modifier = 0, explode = false }: ResolveOpts): PerformedRoll {
  const fw = Math.max(0, Number(target.matrix?.firewall) || 0);
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'WIL', test: 'biofeedback', label: tk('Biofeedback'), applyWounds: false, limit: null, modifier: int(modifier, -30, 30), explode: !!explode,
  }, { bonus: fw ? [{ label: 'Firewall', value: fw }] : [], logExtra: { attackId: atk.id, soak: true } });
  const dv = atk.modifiedDv ?? atk.dv ?? 0;
  const boxes = Math.max(0, dv - roll.hits);
  atk.soakHits = roll.hits;
  atk.soakLogId = roll.logId;
  atk.damage = boxes;
  atk.damageType = atk.type;
  atk.status = 'done';
  atk.resolvedTs = ctx.now;
  if (boxes > 0) applyDamage(ctx, target, boxes, atk.type);
  else logAttack(ctx, tk('{target} resists it all ({dv}{type}).'), { target: atk.targetName, dv, type: atk.type }, atk.gmOnly);
  return roll;
}

/**
 * Vehicle-mounted weapon (SR5 p. 183-184, 238): the roll payload / internal options from the control mode — Gunnery + AGI
 * (manual), + LOG (remote, jumped in: + control rig to the Accuracy, remote: max Data Processing), the drone's Pilot +
 * Targeting (autopilot), passive targeting [Sensor]. Fails when the drone has no Targeting autosoft for the weapon.
 */
function gunneryOptions(ctx: ActionContext, owner: Actor, weapon: Loose, passive: boolean): { payload: Partial<RollPayload>; internal: RollInternal; vehicle: Vehicle } {
  const vehicle = vehicleOf(owner, weapon.vehicleId);
  if (!vehicle) ctx.fail('Vehicle not found');
  if (vehicleDestroyed(vehicle)) ctx.fail('{vehicle} is destroyed', { vehicle: vehicle.name });
  const driver = driverOf(ctx.state, owner, vehicle);
  const c = driver ? controllerInfo(ctx.state, driver) : NO_CONTROLLER;
  const plan = gunneryPlan(effectiveVehicle(ctx.state, owner, vehicle), weapon as { name: string }, c, driver, { passive });
  if (plan.impossible) ctx.fail('{vehicle} has no Targeting autosoft for {weapon}', { vehicle: vehicle.name, weapon: weapon.name });
  const internal: RollInternal = {
    bonus: bonusOf(plan.bonus),
    limitAdjust: { replace: plan.limitReplace, add: plan.limitAdd, max: plan.limitMax, ...(plan.limitLabel !== 'accuracy' ? { label: plan.limitLabel } : {}) },
  };
  const payload: Partial<RollPayload> = { skillId: null, attr: null };
  if (plan.roller.kind === 'pilot') {
    internal.basePool = { pool: plan.roller.pool, parts: plan.roller.lines.map((l) => `${l.label} ${l.value}`) };
    internal.author = vehicle.name;
    payload.explode = false; // a drone has no Edge
  } else {
    payload.attr = plan.roller.attr;
    // Someone else remote-controls / rigs the vehicle: its weapons are theirs to fire (the owner may still man a mount aboard).
    if (driver && driver.id !== owner.id && controlOf(vehicle) !== 'manual') ctx.fail('{driver} controls {vehicle}: only they can fire its weapons', { driver: driver.name, vehicle: vehicle.name });
  }
  return { payload, internal, vehicle };
}

/**
 * Direct combat spell (SR5 p. 283): the target resists with BOD (physical spell) or WIL (mana spell); the net hits are the
 * damage, with no soak and no armor. A non-combat spell (noDamage, SR5 pp. 285-292) is resisted the same way with its
 * attributes (LOG + WIL…): the net hits are the spell's success, the GM applies the effect.
 */
function doResistSpell(ctx: ActionContext, atk: Attack, target: Actor, { modifier = 0, explode = false }: ResolveOpts = {}): PerformedRoll {
  const sp = atk.spell!;
  const labelI18n: I18nEntry = sp.resist2
    ? { key: tk('Resist {spell} ({attr} + {attr2})'), params: { spell: atk.weaponName || '', attr: { t: sp.resist }, attr2: { t: sp.resist2 } } }
    : { key: tk('Resist {spell} ({attr})'), params: { spell: atk.weaponName || '', attr: { t: sp.resist } } };
  let roll: PerformedRoll;
  try {
    roll = performRoll(ctx, {
      actorId: target.id, attr: sp.resist, ...(sp.resist2 ? { attr2: sp.resist2 } : {}), label: tk('Resist the spell'), limit: null, modifier: int(modifier, -30, 30), explode: !!explode,
    }, { logExtra: { attackId: atk.id, defense: true, labelI18n } });
  } catch (err) {
    // A wounded target can be left with no dice: no dice means no hit, not a blocked attack.
    if ((err as { i18nKey?: string }).i18nKey !== 'Dice pool of zero: automatic failure') throw err;
    const zero = { pool: 0, dice: [], extra: [], hits: 0, rawHits: 0, ones: 0, glitch: false, critGlitch: false, limit: null, limited: false };
    const rec = { ...zero, label: 'Resist the spell', labelI18n, actorId: target.id, attackId: atk.id, defense: true };
    const entry = ctx.log({ kind: 'roll', userId: ctx.user.id, author: target.name, text: rec.label, roll: rec, ...(atk.gmOnly ? { gmOnly: true } : {}) });
    roll = { ...rec, logId: entry.id, entry };
  }
  atk.defenseHits = roll.hits;
  atk.defenseLogId = roll.logId;
  atk.net = atk.hits - roll.hits;
  atk.resolvedTs = ctx.now;
  if (atk.net <= 0) {
    atk.status = 'missed';
    logAttack(ctx, tk('{target} resists {spell}.'), { target: atk.targetName, spell: atk.weaponName || '' }, atk.gmOnly);
    return roll;
  }
  atk.status = 'done';
  if (atk.noDamage) {
    logAttack(ctx, tk('{attacker}’s {spell} affects {target}: {n} net hit(s).'), { attacker: atk.attackerName, spell: atk.weaponName || '', target: atk.targetName, n: atk.net }, atk.gmOnly);
    return roll;
  }
  atk.damage = atk.net;
  atk.damageType = atk.type;
  applyDamage(ctx, target, atk.net, atk.type);
  return roll;
}

/** Astral combat (SR5 p. 315): the target defends with Intuition + Logic (no active defense), then soaks. */
function doAstralDefense(ctx: ActionContext, atk: Attack, target: Actor, { modifier = 0, explode = false }: ResolveOpts = {}): PerformedRoll {
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'INT', attr2: 'LOG', label: tk('Astral defense'), limit: null, modifier: int(modifier, -30, 30), explode: !!explode,
  }, { logExtra: { attackId: atk.id, defense: true } });
  atk.defenseHits = roll.hits;
  atk.defenseLogId = roll.logId;
  atk.net = atk.hits - roll.hits;
  if (atk.net <= 0) {
    atk.status = 'missed';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{target} avoids {attacker}\'s attack.'), { target: atk.targetName, attacker: atk.attackerName }, atk.gmOnly);
  } else {
    atk.status = 'soak';
    atk.modifiedDv = (atk.dv || 0) + atk.net;
    logAttack(ctx, tk('{attacker} hits {target}: DV {dv}{type}, AP {ap}.'), { attacker: atk.attackerName, target: atk.targetName, dv: atk.modifiedDv, type: atk.type, ap: 0 }, atk.gmOnly);
  }
  return roll;
}

/**
 * An astral attack (called by 47-magic after the Astral Combat roll): DV and type chosen by the attacker, defense INT + LOG,
 * soak with `soak` (WIL for an astral form, BOD for a dual-natured body) and no armor (SR5 p. 315).
 */
export function addAstralAttack(ctx: ActionContext, o: { attacker: Actor; target: Actor; mapId: string | null; hits: number; dv: number; type: DamageType; soak: AttrKey; rollLogId?: string; gmOnly?: boolean }): Attack {
  const s = slice(ctx.state);
  const map = o.mapId ? ctx.state.maps?.[o.mapId] || null : null;
  const gmOnly = !!o.gmOnly || (o.target.type === 'npc' && !!o.target.hidden);
  return push<Attack>(ctx.state, s.list, {
    id: ctx.uid('atk'), ts: ctx.now, mapId: map?.id || null, kind: 'melee', attackerId: o.attacker.id, attackerName: o.attacker.name,
    ...(o.rollLogId ? { attackLogId: o.rollLogId } : {}), targetId: o.target.id, targetTokenId: tokenOf(map, o.target.id)?.id || null, targetName: o.target.name,
    weaponName: { fr: 'Combat astral', en: 'Astral combat' }, hits: o.hits, dv: o.dv, type: o.type, ap: 0, astral: { soak: o.soak },
    status: o.hits > 0 ? 'defense' : 'missed', ...(o.hits > 0 ? {} : { resolvedTs: ctx.now }), ...(gmOnly ? { gmOnly: true } : {}),
  }, MAX_ATTACKS);
}

/** Defense test of the target (REA + INT + options), then the attack moves to soak / missed / done. Returns the roll. */
function doDefend(ctx: ActionContext, atk: Attack, { options = [], situations = [], modifier = 0, explode = false }: ResolveOpts = {}): PerformedRoll {
  if (atk.status !== 'defense') ctx.fail('This attack is not waiting for a defense');
  if (atk.vehicle) return doVehicleDefend(ctx, atk, { options, modifier, explode });
  const target = actorOf(ctx, atk.targetId);
  if (!ctx.owns(target.id)) ctx.fail('Only the target\'s player (or the GM) can defend');
  if (atk.kind === 'spell' && atk.spell?.mode === 'direct') return doResistSpell(ctx, atk, target, { modifier, explode });
  if (atk.astral) return doAstralDefense(ctx, atk, target, { modifier, explode });
  const turn = turnOf(ctx.state, target.id);
  // A ram can be dodged, not blocked or parried (SR5 p. 203).
  if (atk.ram) options = options.filter((id) => id !== 'parry' && id !== 'block');
  const plan = defenseLines(target, atk, {
    options: options.filter((id: string) => DEFENSE_BY_ID[id]), situations: situations.filter((id: string) => SITUATION_BY_ID[id]),
    prior: turn ? turn.defended : 0, turnBoosts: turn ? turn.boosts : [],
  });
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'REA', attr2: 'INT', test: 'defense', label: tk('Defense'), modifier: int(modifier, -30, 30), explode: !!explode,
    secret: false,
  }, { bonus: plan.lines.map((l: RollBonusLine) => ({ label: l.label, value: l.value })), logExtra: { attackId: atk.id, defense: true } });
  for (const id of plan.paid) spendInitiative(ctx, target.id, DEFENSE_BY_ID[id].ini, DEFENSE_BY_ID[id].name);
  if (turn) {
    turn.defended += 1;
    for (const id of plan.paid) if (DEFENSE_BY_ID[id].turn && !turn.boosts.includes(id)) turn.boosts.push(id);
  }
  atk.defenseHits = roll.hits;
  atk.defenseLogId = roll.logId;
  atk.net = atk.hits - roll.hits;
  const gmOnly = atk.gmOnly;
  if (atk.net <= 0) {
    atk.status = 'missed';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{target} avoids {attacker}\'s attack.'), { target: atk.targetName, attacker: atk.attackerName }, gmOnly);
  } else if (atk.noDamage || atk.dv === null) {
    atk.status = 'done';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{attacker} succeeds against {target}: {n} net hit(s).'), { attacker: atk.attackerName, target: atk.targetName, n: atk.net }, gmOnly);
  } else {
    atk.status = 'soak';
    atk.modifiedDv = atk.dv + atk.net;
    logAttack(ctx, tk('{attacker} hits {target}: DV {dv}{type}, AP {ap}.'), { attacker: atk.attackerName, target: atk.targetName, dv: atk.modifiedDv, type: atk.type, ap: atk.ap }, gmOnly);
    // Elemental indirect spell: the extra effect (catching fire, shorting out, brittle armor…) is the GM's (SR5 pp. 170-171).
    if (atk.kind === 'spell' && atk.spell?.element) {
      logAttack(ctx, tk('Elemental damage ({element}) on {target}: see its extra effects (SR5 pp. 170-171).'), { element: { t: ELEMENTS[atk.spell.element as SpellElement]?.name || atk.spell.element }, target: atk.targetName }, gmOnly);
    }
    if (atk.natural?.element) {
      logAttack(ctx, tk('Elemental damage ({element}) on {target}: see its extra effects (SR5 pp. 170-171).'), { element: { t: elementLabel(atk.natural.element) }, target: atk.targetName }, gmOnly);
    }
    if (atk.natural?.power === 'engulf') {
      logAttack(ctx, tk('{target} is engulfed by {attacker}: the damage comes again on each of its Action Phases; escape: Complex Action, STR + BOD vs MAG + BOD (SR5 p. 396).'), { target: atk.targetName, attacker: atk.attackerName }, gmOnly);
    }
  }
  if (atk.net > 0) energyAuraBacklash(ctx, atk, target);
  return roll;
}

/**
 * Energy Aura (SR5 p. 396): a melee attack that hits a critter with this power also damages the attacker, who resists
 * DV Magic × 2, AP −Magic — a soak attack against the attacker, from the critter.
 */
function energyAuraBacklash(ctx: ActionContext, atk: Attack, target: Actor): void {
  if (atk.kind !== 'melee' || atk.astral || !atk.attackerId || atk.attackerId === target.id || !hasEnergyAura(target)) return;
  if (target.spirit && !target.spirit.materialized) return;
  const attacker = ctx.state.actors[atk.attackerId];
  const mag = attr(target, 'MAG');
  if (!attacker || mag <= 0) return;
  const map = atk.mapId ? ctx.state.maps?.[atk.mapId] || null : null;
  const dv = mag * 2;
  const gmOnly = !!atk.gmOnly || (target.type === 'npc' && !!target.hidden);
  push<Attack>(ctx.state, slice(ctx.state).list, {
    id: ctx.uid('atk'), ts: ctx.now, mapId: atk.mapId, kind: 'melee', attackerId: target.id, attackerName: target.name,
    targetId: attacker.id, targetTokenId: tokenOf(map, attacker.id)?.id || null, targetName: attacker.name,
    weaponName: { fr: 'Aura énergétique', en: 'Energy Aura' }, hits: 0, dv, modifiedDv: dv, type: 'P', ap: -mag, status: 'soak',
    ...(gmOnly ? { gmOnly: true } : {}),
  }, MAX_ATTACKS);
  logAttack(ctx, tk('{attacker} touches {target}’s Energy Aura: resist DV {dv}P, AP {ap} (SR5 p. 396).'), { attacker: attacker.name, target: target.name, dv, ap: -mag }, gmOnly);
}

/**
 * A combat spell aimed at a target (called by 47-magic after the Spellcasting roll): direct → status 'defense' resolved by
 * doResistSpell; indirect → like a ranged attack, DV = Force (+ net hits on the hit), AP = −Force (SR5 p. 283).
 */
export function addSpellAttack(ctx: ActionContext, o: {
  attacker: Actor; target: Actor; mapId: string | null; hits: number; spellName: BiName; force: number;
  profile: Pick<CombatSpellProfile, 'mode' | 'damage' | 'element'> & { resist: AttrKey; resist2?: AttrKey | null };
  /** Non-combat spell: resisted for net hits, no damage. */
  noDamage?: boolean;
  castLogId?: string; rollLogId?: string; gmOnly?: boolean;
}): Attack {
  const s = slice(ctx.state);
  const map = o.mapId ? ctx.state.maps?.[o.mapId] || null : null;
  const direct = o.profile.mode === 'direct';
  const gmOnly = !!o.gmOnly || (o.target.type === 'npc' && !!o.target.hidden);
  const atk = push<Attack>(ctx.state, s.list, {
    id: ctx.uid('atk'), ts: ctx.now, mapId: map?.id || null, kind: 'spell', attackerId: o.attacker.id, attackerName: o.attacker.name,
    ...(o.rollLogId ? { attackLogId: o.rollLogId } : {}), targetId: o.target.id, targetTokenId: tokenOf(map, o.target.id)?.id || null,
    targetName: o.target.name, weaponName: o.spellName, hits: o.hits, dv: direct ? null : o.force, type: o.profile.damage, ap: direct ? 0 : -o.force,
    spell: { mode: o.profile.mode, resist: o.profile.resist, ...(o.profile.resist2 ? { resist2: o.profile.resist2 } : {}), force: o.force, element: o.profile.element, ...(o.castLogId ? { castLogId: o.castLogId } : {}) },
    ...(o.noDamage ? { noDamage: true } : {}),
    status: o.hits > 0 ? 'defense' : 'missed', ...(o.hits > 0 ? {} : { resolvedTs: ctx.now }), ...(gmOnly ? { gmOnly: true } : {}),
  }, MAX_ATTACKS);
  return atk;
}

/**
 * Toxin Resistance Test (BOD + WIL, SR5 p. 408): Power − hits = what is left; damage (no armor) and the toxin's effects
 * (afflictions: Disoriented / Nauseous for the rest of the fight, 10 min outside; Incapacitated 3 Combat Turns if left > WIL).
 */
function doToxin(ctx: ActionContext, atk: Attack, target: Actor, { modifier = 0, explode = false }: ResolveOpts = {}): PerformedRoll {
  const toxin = TOXIN_BY_ID[atk.toxinId as string];
  if (!toxin) ctx.fail('Unknown toxin');
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'BOD', attr2: 'WIL', test: 'toxinResist', label: tk('Resist toxins'), applyWounds: false, limit: null,
    modifier: int(modifier, -30, 30), explode: !!explode,
  }, { logExtra: { attackId: atk.id, soak: true } });
  const left = Math.max(0, toxin.power - roll.hits);
  const out = toxinOutcome(toxin, left, target.attributes?.WIL);
  atk.soakHits = roll.hits;
  atk.soakLogId = roll.logId;
  atk.damage = out.damage;
  atk.damageType = out.damageType; // null when the toxin does no damage
  atk.left = left;
  atk.effects = out.afflictions;
  atk.status = 'done';
  atk.resolvedTs = ctx.now;
  if (out.afflictions.length) {
    const list = (target.afflictions = (Array.isArray(target.afflictions) ? target.afflictions : []).filter((a) => !out.afflictions.includes(a.kind)));
    for (const kind of out.afflictions) {
      const def = AFFLICTIONS[kind];
      list.push({ id: ctx.uid('aff'), kind, source: toxin.name, sourceEn: toxin.en, ts: ctx.now, until: untilFor(ctx.state.combat, ctx.now, def.turns ? { turns: def.turns } : { long: true }) });
    }
  }
  if (out.damage > 0) applyDamage(ctx, target, out.damage, out.damageType as DamageType);
  if (!left) logAttack(ctx, tk('{target} resists the gas ({toxin}).'), { target: atk.targetName, toxin: { t: toxin.name } }, atk.gmOnly);
  else if (out.afflictions.length) {
    logAttack(ctx, tk('{target} is affected by the gas ({toxin}): {effects}.'), {
      target: atk.targetName, toxin: { t: toxin.name }, effects: { fr: out.afflictions.map((k) => AFFLICTIONS[k].name).join(', '), en: out.afflictions.map((k) => AFFLICTIONS[k].en).join(', ') },
    }, atk.gmOnly);
  }
  return roll;
}

/** Damage resistance (BOD + armor modified by AP), damage applied. Returns the roll. */
function doSoak(ctx: ActionContext, atk: Attack, { modifier = 0, explode = false }: ResolveOpts = {}): PerformedRoll | null {
  if (atk.status !== 'soak') ctx.fail('This attack is not waiting for damage resistance');
  if (atk.vehicle) return doVehicleSoak(ctx, atk, { modifier });
  const target = actorOf(ctx, atk.targetId);
  if (!ctx.owns(target.id)) ctx.fail('Only the target\'s player (or the GM) can resist the damage');
  if (atk.kind === 'toxin') return doToxin(ctx, atk, target, { modifier, explode });
  if (atk.feedback) return doFeedbackSoak(ctx, atk, target, { modifier, explode });
  if (atk.astral) {
    // Astral soak: the astral body (WIL) or the dual-natured body (BOD), no armor (SR5 p. 315).
    const roll = performRoll(ctx, {
      actorId: target.id, attr: atk.astral.soak, label: tk('Soak'), applyWounds: false, limit: null, modifier: int(modifier, -30, 30), explode: !!explode,
    }, { logExtra: { attackId: atk.id, soak: true } });
    const dv = atk.modifiedDv ?? atk.dv ?? 0;
    const boxes = Math.max(0, dv - roll.hits);
    atk.soakHits = roll.hits;
    atk.soakLogId = roll.logId;
    atk.damage = boxes;
    atk.damageType = atk.type;
    atk.status = 'done';
    atk.resolvedTs = ctx.now;
    if (boxes > 0) applyDamage(ctx, target, boxes, atk.type);
    else logAttack(ctx, tk('{target} resists it all ({dv}{type}).'), { target: atk.targetName, dv, type: atk.type }, atk.gmOnly);
    return roll;
  }
  const internal: RollInternal = { ap: atk.ap, logExtra: { attackId: atk.id, soak: true } };
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'BOD', test: 'soak', label: tk('Soak'), applyWounds: false, limit: null, modifier: int(modifier, -30, 30), explode: !!explode,
  }, internal);
  const dv = atk.modifiedDv ?? atk.dv ?? 0;
  const boxes = Math.max(0, dv - roll.hits);
  const type = finalDamageType(atk.type, dv, internal.armorUsed ?? 0);
  atk.soakHits = roll.hits;
  atk.soakLogId = roll.logId;
  atk.damage = boxes;
  atk.damageType = type;
  atk.status = 'done';
  atk.resolvedTs = ctx.now;
  if (boxes > 0) applyDamage(ctx, target, boxes, type);
  else logAttack(ctx, tk('{target} resists it all ({dv}{type}).'), { target: atk.targetName, dv, type: atk.type }, atk.gmOnly);
  return roll;
}

/** Players' view: no attack on a hidden NPC; a hidden attacker's name is masked. Blasts of the shown map only. */
function filterView(view: GameView, user: SessionUser, state: TableState): void {
  const s = view.attacks;
  if (!s) return;
  delete s.turn;
  const visible = (id: ActorId | null) => !!view.actors?.[id as ActorId];
  s.list = (s.list || []).filter((a) => !a.gmOnly && visible(a.targetId)).map((a) => (visible(a.attackerId) ? a : { ...a, attackerName: '?', attackerId: null }));
  const amid = state?.scene?.activeMapId;
  s.blasts = activeBlasts(s.blasts, state?.combat, Date.now()).filter((b: Blast) => b.mapId === amid && !b.gmOnly).map((b: Blast) => ({ ...b, hits: (b.hits || []).filter((h) => visible(h.actorId)) }));
  // Turn info of the player's own characters (defenses already made, boosts paid) for the defense dialog preview.
  const own = new Set<ActorId>(user.characterIds || []);
  const myTurn: NonNullable<typeof s.myTurn> = (s.myTurn = {});
  const key = combatTurnKey(state);
  for (const [id, t] of Object.entries(state.attacks?.turn || {})) if (own.has(id) && t.key === key) myTurn[id] = { defended: t.defended, boosts: t.boosts, once: t.once };
}

/** 'attack/roll': the dice/roll payload plus the target / aimed point / special action. */
type AttackRollPayload = RollPayload & {
  targetTokenId?: unknown;
  targetActorId?: unknown;
  point?: unknown;
  actionId?: unknown;
  profileId?: unknown;
  toxinId?: unknown;
  mapId?: unknown;
  /** Vehicle-mounted weapon: passive targeting, the vehicle's Sensor as the limit (SR5 p. 184). */
  passive?: unknown;
  /** Called shot at a vehicle component (Run & Gun p. 115): VEHICLE_CALLED_SHOTS id. */
  calledShot?: unknown;
};
type AttackIdPayload = { attackId?: unknown };
type DefendPayload = { attackId?: unknown; options?: unknown; situations?: unknown; modifier?: unknown; explode?: unknown };
type SoakPayload = { attackId?: unknown; modifier?: unknown; explode?: unknown };
type ResolvePayload = { attackId?: unknown; outcome?: unknown; amount?: unknown; type?: unknown };
type ClearPayload = { all?: boolean; blasts?: boolean };
type RemoveAfflictionPayload = { actorId?: unknown; afflictionId?: unknown };
type RemoveBlastPayload = { blastId?: unknown };

const mod: ServerModule = {
  name: 'attacks',

  init(state: TableState) {
    slice(state);
  },

  actions: {
    // Attack roll with a target / an aimed point / a special action. Payload = the dice/roll payload +
    // { targetTokenId?, targetActorId?, point?: { x, y } (area weapons), actionId?, profileId? (launcher ammunition), mapId? (GM) }.
    'attack/roll': {
      role: 'any',
      handler(ctx: ActionContext, p: AttackRollPayload = {}) {
        const actor = actorOf(ctx, str(p.actorId, 60));
        if (!ctx.owns(actor.id)) ctx.fail('You can only roll for your own character');
        const weapon = p.weaponId ? (actor.weapons || []).find((w) => w && w.id === str(p.weaponId, 60)) : null;
        if (p.weaponId && !weapon) ctx.fail('Weapon not found');
        // A spirit's natural attacks hit the physical plane only when it is materialized (SR5 p. 398); astral: magic/astralAttack.
        if (weapon?.natural && actor.spirit && !actor.spirit.materialized) ctx.fail('{name} is in astral form: materialize it, or make an astral attack', { name: actor.name });
        const action = p.actionId ? ACTION_BY_ID[str(p.actionId, 40)] : null;
        if (p.actionId && !action) ctx.fail('Unknown action');
        const payload: AttackRollPayload = { ...p };
        delete payload.targetTokenId;
        delete payload.targetActorId;
        delete payload.point;
        delete payload.actionId;
        delete payload.profileId;
        delete payload.toxinId;
        delete payload.passive;
        delete payload.calledShot;
        pruneExpired(ctx.state, ctx.now);
        delete payload.mapId;
        // Vehicle-mounted weapon: Gunnery with the attribute / limit of the control mode, or the drone's Pilot + Targeting.
        const gun = weapon?.vehicleId ? gunneryOptions(ctx, actor, weapon, !!p.passive) : null;
        if (gun) Object.assign(payload, gun.payload);
        // Special action: unlocked (technique / quality), fits the weapon, once per turn, Edge.
        if (action) {
          if (!ctx.isGM && !isUnlocked(action, actor)) ctx.fail('{name} hasn\'t unlocked “{action}”', { name: actor.name, action: { t: action.name } });
          if (action.kind === 'test') {
            if (weapon && !action.weaponSkill) ctx.fail('This action isn\'t done with a weapon');
          } else {
            if (!weapon) ctx.fail('Choose a weapon for this action');
            if (action.kind === 'melee' && weapon.kind !== 'melee') ctx.fail('“{action}” needs a melee weapon', { action: { t: action.name } });
            if (action.kind === 'ranged' && weapon.kind === 'melee') ctx.fail('“{action}” needs a ranged weapon', { action: { t: action.name } });
            if (action.fire) {
              if (!usesAmmo(weapon) || !fireOptions(weapon).some((o) => o.id === action.fire)) ctx.fail('“{action}”: fire mode not available with this weapon', { action: { t: action.name } });
              payload.fireMode = action.fire;
            }
          }
          const turn = turnOf(ctx.state, actor.id);
          if (action.once && turn?.once.includes(action.id)) ctx.fail('“{action}”: once per Combat Turn only', { action: { t: action.name } });
          const edgeNeeded = (action.edge || 0) + (payload.explode ? 1 : 0);
          if (edgeNeeded && (actor.edge?.current ?? 0) < edgeNeeded) ctx.fail('{name} doesn\'t have enough Edge left', { name: actor.name });
        }
        // Target: a token on the map (players: not a hidden one), or an actor (GM, no map).
        const map = mapFor(ctx, p.mapId);
        let targetToken: Token | null = null;
        let target: Actor | null = null;
        if (p.targetTokenId) {
          targetToken = (map?.tokens || []).find((t) => t.id === str(p.targetTokenId, 60)) || null;
          if (!targetToken || (!ctx.isGM && targetToken.hidden)) ctx.fail('Target not found on the map');
          if (targetToken.actorId) target = ctx.state.actors[targetToken.actorId] || null;
        } else if (p.targetActorId) {
          target = actorOf(ctx, str(p.targetActorId, 60));
          if (!ctx.isGM && target.type === 'npc' && target.hidden) ctx.fail('Target not found');
          targetToken = tokenOf(map, target.id);
        }
        // A vehicle token: the attack targets the vehicle (its owner defends / soaks for it), not the passengers (SR5 p. 205).
        const targetVehicle = targetToken?.vehicleId && target ? vehicleOf(target, targetToken.vehicleId) : null;
        if (targetToken?.vehicleId && !targetVehicle) ctx.fail('Vehicle not found');
        if (target && target.id === actor.id && !targetVehicle) ctx.fail('You can\'t target yourself');
        // Called shot at a vehicle component (Run & Gun p. 115).
        const calledShot = p.calledShot ? CALLED_SHOT_BY_ID[str(p.calledShot, 20)] || null : null;
        if (p.calledShot && (!calledShot || !targetVehicle)) ctx.fail('Called shots at a component need a vehicle target');
        // Target lock of the firing vehicle (SR5 p. 184) and Target Device of its rigger (Rigger 5.0 p. 30).
        const lock = gun && targetToken ? (ctx.state.rigging?.locks || []).find((l) => l.actorId === actor.id && l.vehicleId === gun.vehicle.id && l.targetTokenId === targetToken!.id) || null : null;
        const turnKey = combatTurnKey(ctx.state);
        const designation = gun && targetToken ? (ctx.state.rigging?.designations || []).find((d) => d.riggerId === actor.id && d.targetTokenId === targetToken!.id && (d.turn === null || d.turn === turnKey)) || null : null;
        // A mounted weapon fires from its vehicle's token when the vehicle is on the map.
        const attackerToken = (gun ? vehicleToken(map, actor.id, gun.vehicle.id) : null) || tokenOf(map, actor.id);
        const mpc = Number(map?.metersPerCell) || 1;
        const area = weapon && isAreaWeapon(weapon);
        let point: Point | null = null;
        if (area) {
          if (isObj(p.point) && map) point = { x: int(p.point.x, 0, map.width - 1), y: int(p.point.y, 0, map.height - 1) };
          else if (targetToken) point = { x: targetToken.x, y: targetToken.y };
        }
        // Environmental modifier (SR5 p. 175) from the token distance (range column), the target cell's light, the map weather,
        // smoke clouds on the line of fire and flash-paks, after the attacker's vision: « long range (34 m) −3 » when the range
        // is the only condition, else « env. (range, light) −6 ». Labels are dictionary keys (sheet/common.tsx rollBreakdown).
        const bonus: RollBonusLine[] = [];
        let range: Loose | null = null;
        let env: Loose | null = null;
        const aimAt = point || (targetToken ? { x: targetToken.x, y: targetToken.y } : null);
        if (weapon && weapon.kind !== 'melee' && attackerToken && aimAt) {
          range = rangeFor(weapon, actor, cellDistance(attackerToken, aimAt, mpc));
          env = environmentFor({
            map, from: attackerToken, to: aimAt, meters: range?.meters ?? cellDistance(attackerToken, aimAt, mpc),
            rangeIndex: range ? RANGE_BANDS.findIndex((b) => b.id === range!.id) : null,
            litRatio: (map!.lighting || 'bright') !== 'bright' ? createVisionContext(map!).litRatio : null,
            blasts: activeBlasts(slice(ctx.state).blasts.filter((b) => b.mapId === map!.id), ctx.state.combat, ctx.now),
            senses: attackSenses(actor, tokenVision(attackerToken, actor, effectsLookup()), weapon),
          });
          if (env.rangeOnly) {
            if (range?.mod) bonus.push({ label: `${range.label} (${range.meters} m)`, value: range.mod });
          } else if (env.value) {
            // Short label (roll lines are cut at 40 characters): the columns that count, « env. (range, light) −6 ».
            const cols = ['range', 'visibility', 'light', 'wind'].filter((k) => env!.levels[k] > 0);
            bonus.push({ label: `env. (${cols.join(', ')})`, value: env.value });
          }
        }
        if (action?.dice) bonus.push({ label: action.name, value: action.dice });
        if (calledShot) bonus.push({ label: calledShot.label, value: calledShot.mod });
        if (designation?.net) bonus.push({ label: tk('Target Device'), value: designation.net });
        // Launcher ammunition: the minigrenade profile listed on the sheet gives DV / AP / blast.
        // Without one (Chummer did not list it): the loaded minigrenade, or the catalog minigrenade chosen in the dialog.
        let profile: Loose | null = null;
        if (weapon && rangeClass(weapon) === 'grenadeLauncher' && !isLauncherProfile(weapon)) {
          const rounds = launcherRounds(actor, weapon);
          const pick = p.profileId ? rounds.find((r: Loose) => r.id === str(p.profileId, 60)) : rounds.find((r: Loose) => r.loaded || r.sheet);
          if (p.profileId && !pick) ctx.fail('Unknown ammunition for this grenade launcher');
          if (!pick) ctx.fail('Choose the minigrenade to fire');
          profile = pick.w;
        }
        const source = profile || weapon;
        const dmg: { dv: number | null; type: DamageType } = source ? weaponDamage(actor, source) : { dv: null, type: 'P' };
        const atkId = ctx.uid('atk');
        if (action?.kind === 'test') {
          // Own pool, no weapon (Clinch, Kip-Up, Reading the Defense: weapon skill + INT).
          if (action.weaponSkill && weapon) payload.skillId = weapon.skill;
          else if (action.skillId) payload.skillId = action.skillId;
          payload.attr = action.attr;
          delete payload.weaponId;
          payload.label = action.name;
        }
        const targetName = targetVehicle?.name || target?.name || targetToken?.name || '';
        const roll = performRoll(ctx, payload, {
          ...(gun ? gun.internal : {}),
          bonus: [...bonus, ...(gun?.internal.bonus || [])], rounds: action?.rounds,
          logExtra: { attackId: target || point ? atkId : undefined, ...(targetName ? { targetName } : {}), ...(action ? { actionName: action.name } : {}), ...(range ? { range: { band: range.id, meters: range.meters, ...(range.beyond ? { beyond: true } : {}) } } : {}) },
        });
        // Costs of the special action, once the roll went through.
        if (action) {
          if (action.edge) actor.edge.current = Math.max(0, actor.edge.current - action.edge);
          if (action.ini) spendInitiative(ctx, actor.id, action.ini, action.name);
          const turn = turnOf(ctx.state, actor.id);
          if (action.once && turn) turn.once.push(action.id);
        }
        // Action counter of the tracker (SR5 p. 164-167): the special action's own type, else the fire option's (SS/SA/BF/FA
        // Simple, SA burst/LB/FA 10/suppressive Complex), a melee attack Complex, a thrown weapon Simple.
        if (action || source) {
          const fireAction = FIRE_BY_ID[String(roll.fire?.mode || payload.fireMode || '')]?.action;
          // A vehicle-mounted weapon takes a Complex Action in any fire mode (SR5 p. 183).
          const type = action?.type || (gun ? 'complex' : attackActionType({ fireAction, melee: weapon?.kind === 'melee' }));
          const what: I18nMessage = action
            ? source ? { t: '{a} · {b}', params: { a: { t: action.name }, b: biName(source) } } : { t: action.name }
            : { t: tk('Attack — {weapon}'), params: { weapon: biName(source!) } };
          // A drone firing on its own records on its own tracker entry.
          const droneEntry = gun?.internal.basePool ? ctx.state.combat?.entries.find((e) => e.kind === 'drone' && e.vehicleId === gun.vehicle.id && !e.out) : null;
          recordAction(ctx, droneEntry ? { entryId: droneEntry.id } : { actorId: actor.id }, { type, label: what, attack: action?.kind !== 'test', auto: true });
        }
        const gmOnly = !!roll.secret || !!(actor.type === 'npc' && actor.hidden);
        const s = slice(ctx.state);
        const base = {
          ts: ctx.now, mapId: map?.id || null, attackerId: actor.id, attackerName: actor.name, attackLogId: roll.logId, hits: roll.hits,
          weaponName: source ? biName(source) : null, ...(action ? { actionId: action.id, actionName: action.name } : {}), ...(gmOnly ? { gmOnly: true } : {}),
        };
        // Area weapon: scatter, blast, a soak for every token caught in it.
        if (area && point && map) {
          const from = attackerToken ? { x: attackerToken.x, y: attackerToken.y } : null;
          let land: Landing;
          if (roll.critGlitch && from) land = { x: from.x, y: from.y, meters: cellDistance(from, point, mpc), scattered: true, fumble: true };
          else {
            land = rollScatter({ from, to: point, hits: roll.hits, dice: scatterDice(weapon), threshold: THROW_THRESHOLD, metersPerCell: mpc, width: map.width, height: map.height });
            // Glitch: the scatter distance is doubled (SR5 p. 182, motion sensor).
            if (roll.glitch && land.scattered) {
              const clampTo = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v * 10) / 10));
              land = { ...land, meters: land.meters * 2, x: clampTo(point.x + (land.x - point.x) * 2, map.width), y: clampTo(point.y + (land.y - point.y) * 2, map.height), glitch: true };
            }
          }
          const blast: BlastProfile = blastOf(source, actor) || { dv: null, type: 'P', ap: 0, falloff: null, radius: null, damaging: false };
          // What the blast leaves: an explosion (until the end of the Combat Turn) or a cloud / flash-pak (until the end of the fight).
          const effect = areaEffectOf(source);
          const lasting = LASTING_EFFECTS.includes(effect);
          if (lasting && !blast.radius && !blastReach(blast)) blast.radius = 10;
          const toxin = effect === 'gas' ? TOXIN_BY_ID[str(p.toxinId, 20)] || TOXIN_BY_ID[toxinFromText(source) as string] || TOXIN_BY_ID.cs : null;
          if (toxin) blast.damaging = false; // the toxin replaces the grenade's damage
          if (action?.dv && blast.damaging) blast.dv! += action.dv;
          const hits: BlastHit[] = [];
          if (toxin) {
            // Gas: a Toxin Resistance Test (BOD + WIL) for every token caught (a chemical seal, or a gas mask against an
            // inhalation-only toxin, protects).
            for (const tok of map.tokens || []) {
              if (!tok.actorId || !ctx.state.actors[tok.actorId] || tok.vehicleId) continue; // a sealed vehicle is not poisoned
              const m = cellDistance(tok, land, mpc);
              if (m > blast.radius!) continue;
              const victim = ctx.state.actors[tok.actorId];
              const hidden = gmOnly || (victim.type === 'npc' && victim.hidden);
              if (toxinProtection(victim, toxin) === 'immune') {
                logAttack(ctx, tk('{target} is protected from the gas ({toxin}).'), { target: victim.name, toxin: { t: toxin.name } }, hidden);
                continue;
              }
              const atk = push<Attack>(ctx.state, s.list, {
                ...base, id: ctx.uid('atk'), kind: 'toxin', targetId: victim.id, targetTokenId: tok.id, targetName: victim.name,
                toxinId: toxin.id, toxinName: { fr: toxin.name, en: toxin.en }, dv: toxin.power, modifiedDv: toxin.power, type: toxin.effects.includes('physical') ? 'P' : 'S',
                ap: toxin.penetration, meters: m, status: 'soak', ...(hidden ? { gmOnly: true } : {}),
              }, MAX_ATTACKS);
              hits.push({ actorId: victim.id, tokenId: tok.id, name: victim.name, dv: toxin.power, meters: m, attackId: atk.id });
            }
          } else if (blast.damaging) {
            for (const tok of map.tokens || []) {
              if (!tok.actorId || !ctx.state.actors[tok.actorId]) continue;
              const m = cellDistance(tok, land, mpc);
              const dv = blastDvAt(blast, m);
              if (dv <= 0) continue;
              const victim = ctx.state.actors[tok.actorId];
              const hitVehicle = tok.vehicleId ? vehicleOf(victim, tok.vehicleId) : null;
              if (tok.vehicleId) {
                // Area attacks damage the vehicle (and its passengers, who have their own tokens or are the GM's call — SR5 p. 205).
                if (!hitVehicle) continue;
                const atk = addVehicleSoak(ctx, {
                  owner: victim, vehicle: hitVehicle, dv, ap: blast.ap + (action?.ap || 0), attacker: actor, weaponName: biName(source), mapId: map.id, tokenId: tok.id,
                  gmOnly: gmOnly || (victim.type === 'npc' && !!victim.hidden),
                });
                if (blast.type === 'S') atk.type = 'S';
                hits.push({ actorId: victim.id, tokenId: tok.id, name: hitVehicle.name, dv, meters: m, attackId: atk.id });
                continue;
              }
              const atk = push<Attack>(ctx.state, s.list, {
                ...base, id: ctx.uid('atk'), kind: 'blast', targetId: victim.id, targetTokenId: tok.id, targetName: victim.name,
                dv, type: blast.type, ap: blast.ap + (action?.ap || 0), meters: m, status: 'soak', modifiedDv: dv,
                ...(gmOnly || (victim.type === 'npc' && victim.hidden) ? { gmOnly: true } : {}),
              }, MAX_ATTACKS);
              hits.push({ actorId: victim.id, tokenId: tok.id, name: victim.name, dv, meters: m, attackId: atk.id });
            }
          }
          const b = push<Blast>(ctx.state, s.blasts, {
            id: atkId, ts: ctx.now, mapId: map.id, attackerId: actor.id, attackerName: actor.name, weaponName: biName(source), from, aim: point,
            x: land.x, y: land.y, meters: land.meters, scattered: !!land.scattered, dir: land.dir || null, dist: land.dist || null,
            ...(land.fumble ? { fumble: true } : {}), ...(land.glitch ? { glitch: true } : {}), hitsRolled: roll.hits,
            dv: blast.damaging ? blast.dv : null, type: blast.type, ap: blast.ap, falloff: blast.falloff, radius: blast.radius, reach: blastReach(blast), hits, ...(gmOnly ? { gmOnly: true } : {}),
            effect, until: untilFor(ctx.state.combat, ctx.now, lasting ? { long: true } : { turns: 1 }), ...(toxin ? { toxinId: toxin.id, toxinName: { fr: toxin.name, en: toxin.en } } : {}),
          }, MAX_BLASTS);
          if (land.scattered) logAttack(ctx, tk('{weapon} scatters {m} m ({dir} on the diagram).'), { weapon: biName(source), m: land.meters, dir: land.dir ? land.dir[0] + land.dir[1] : '—' }, gmOnly);
          else logAttack(ctx, tk('{weapon} lands right on the aimed point.'), { weapon: biName(source) }, gmOnly);
          return { ...roll, entry: undefined, blastId: b.id, blast: b };
        }
        if (!target) {
          const { entry, ...out } = roll;
          return out;
        }
        // Targeted attack: the defender rolls next (no hit = missed at once).
        const fireDef = roll.fire ? (roll.fire.defense !== undefined ? roll.fire.defense : FIRE_BY_ID[roll.fire.mode ?? '']?.defense || 0) : 0;
        const atk = push<Attack>(ctx.state, s.list, {
          ...base, id: atkId, kind: weapon?.kind === 'melee' || action?.kind === 'test' ? 'melee' : 'ranged', targetId: target.id, targetTokenId: targetToken?.id || null, targetName,
          dv: action?.noDamage ? null : dmg.dv === null ? null : dmg.dv + (action?.dv || 0), type: dmg.type, ap: apOf(source) + (action?.ap || 0),
          reach: weapon?.kind === 'melee' ? (Number(weapon.reach) || 0) + (action?.reach || 0) + (/troll/i.test(actor.metatype || '') ? 1 : 0) : 0,
          defenseMod: (fireDef || 0) - (lock?.net || 0), ...(fireDef || lock ? { defenseLabel: lock ? (fireDef ? tk('fire mode, target lock') : tk('target lock')) : tk('fire mode') } : {}), actionDefense: action?.defense || 0,
          ...(calledShot ? { calledShot: calledShot.id } : {}),
          ...(action?.noDamage ? { noDamage: true } : {}), ...(range ? { range: { band: range.id, meters: range.meters } } : {}),
          ...(weapon?.natural ? { natural: { power: weapon.natural.power, element: weapon.natural.element ?? null } } : {}),
          ...(targetVehicle ? { vehicle: { vehicleId: targetVehicle.id, name: targetVehicle.name }, ...(/\(e\)|elec/i.test(String(source?.damage || '')) ? { electric: true } : {}) } : {}),
          status: roll.hits > 0 ? 'defense' : 'missed', ...(roll.hits > 0 ? {} : { resolvedTs: ctx.now }),
          ...(target.type === 'npc' && target.hidden ? { gmOnly: true } : {}),
        }, MAX_ATTACKS);
        if (atk.status === 'missed') logAttack(ctx, tk('{attacker} misses {target}.'), { attacker: atk.attackerName, target: atk.targetName }, atk.gmOnly);
        const { entry, ...out } = roll;
        return { ...out, attackId: atk.id };
      },
    },

    // The target's owner (or the GM) defends: { attackId, options: ['dodge'|'parry'|'block'|'full'|…], situations: [...], modifier, explode }.
    'attack/defend': {
      role: 'any',
      handler(ctx: ActionContext, p: DefendPayload = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        const { entry, ...roll } = doDefend(ctx, atk, { options: ids(p.options), situations: ids(p.situations), modifier: p.modifier, explode: p.explode });
        return { roll, attack: atk };
      },
    },

    // Damage resistance: { attackId, modifier, explode } — damage applied to the target.
    'attack/soak': {
      role: 'any',
      handler(ctx: ActionContext, p: SoakPayload = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        const res = doSoak(ctx, atk, { modifier: p.modifier, explode: p.explode });
        if (!res) return { roll: null, attack: atk };
        const { entry, ...roll } = res;
        return { roll, attack: atk };
      },
    },

    // GM: roll the remaining steps without options (NPC defense then soak). { attackId }
    'attack/auto': {
      handler(ctx: ActionContext, p: AttackIdPayload = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        if (atk.status === 'defense') doDefend(ctx, atk, {});
        if (atk.status === 'soak') doSoak(ctx, atk, {});
        return { attack: atk };
      },
    },

    // GM: settle by hand. { attackId, outcome: 'missed'|'damage', amount?, type? }
    'attack/resolve': {
      handler(ctx: ActionContext, p: ResolvePayload = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        if (atk.status === 'done' || atk.status === 'missed' || atk.status === 'cancelled') ctx.fail('Attack already resolved');
        if (p.outcome === 'damage') {
          const n = int(p.amount, 0, 100);
          const type = p.type === 'S' ? 'S' : 'P';
          if (n > 0 && atk.vehicle) {
            const { owner, vehicle } = attackVehicle(ctx, atk);
            damageVehicle(ctx, owner, vehicle, n, { gmOnly: atk.gmOnly });
            applyCalledShot(ctx, owner, vehicle, atk);
          } else if (n > 0) applyDamage(ctx, actorOf(ctx, atk.targetId), n, type);
          atk.damage = n;
          atk.damageType = type;
          atk.status = 'done';
        } else {
          atk.status = 'missed';
          logAttack(ctx, tk('{target} avoids {attacker}\'s attack.'), { target: atk.targetName, attacker: atk.attackerName }, atk.gmOnly);
        }
        atk.manual = true;
        atk.resolvedTs = ctx.now;
        return { attack: atk };
      },
    },

    // The attacker's owner or the GM withdraws a pending attack. { attackId }
    'attack/cancel': {
      role: 'any',
      handler(ctx: ActionContext, p: AttackIdPayload = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        if (!ctx.isGM && !(atk.attackerId && ctx.owns(atk.attackerId))) ctx.fail('Only the attacker (or the GM) can cancel');
        if (atk.status !== 'defense' && atk.status !== 'soak') ctx.fail('Attack already resolved');
        atk.status = 'cancelled';
        atk.resolvedTs = ctx.now;
        return { attack: atk };
      },
    },

    // GM: clear finished attacks (all: pending ones too) and blasts. { all?, blasts? }
    'attack/clear': {
      handler(ctx: ActionContext, p: ClearPayload = {}) {
        const s = slice(ctx.state);
        s.list = p.all ? [] : s.list.filter((a) => a.status === 'defense' || a.status === 'soak');
        if (p.blasts !== false) s.blasts = [];
        return { left: s.list.length };
      },
    },

    // GM (or the character's player): end an affliction (toxin effect) early. { actorId, afflictionId }
    'attack/removeAffliction': {
      role: 'any',
      handler(ctx: ActionContext, p: RemoveAfflictionPayload = {}) {
        const actor = actorOf(ctx, str(p.actorId, 60));
        if (!ctx.isGM) ctx.fail('GM only');
        actor.afflictions = (actor.afflictions || []).filter((a) => a.id !== str(p.afflictionId, 60));
        return {};
      },
    },

    // GM: remove one blast marker. { blastId }
    'attack/removeBlast': {
      handler(ctx: ActionContext, p: RemoveBlastPayload = {}) {
        const s = slice(ctx.state);
        s.blasts = s.blasts.filter((b) => b.id !== str(p.blastId, 60));
        return {};
      },
    },
  },

  filter: filterView,
};

export default mod;
