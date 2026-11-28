// Vehicles & drones on the sheet (Gear tab): condition monitor, control mode and driver, Vehicle Tests, sensors, stealth,
// mounted weapons (Gunnery), ramming, the vehicle's token, autosofts. Server: server/modules/34-vehicles.ts; rules:
// shared/vehicles.ts (the dialog previews the same plans the server rolls).
import { useState } from 'react';
import { Button, NumberInput, Select, Toggle, promptText } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { useUI, toast } from '../../lib/ui-store.ts';
import { t, tk, tn, attrShort } from '../../lib/i18n.ts';
import { skillKey, skillPool } from '/shared/sr5.ts';
import {
  AUTOSOFT_KINDS, AUTOSOFT_LABELS, CHASE_RANGE_LABELS, CONTROL_LABELS, TERRAINS, VEHICLE_CONTROLS, VEHICLE_SKILLS, VEHICLE_THRESHOLDS, controlOf, controlRigRating,
  gunneryPlan, hasRiggerInterface, isDrone, movementRate, previewDriverPool, ramDamage, splitStat, vehicleDamage, vehicleDamageMod, vehicleDestroyed,
  vehicleMonitor, vehicleSkillId, vehicleStats, vehicleTestPlan, type ControllerInfo, type PlanLine, type VehicleTestKind, type VehicleTestPlan,
  swarmMembers, swarmVehicle, mechanicSkillFor, REPAIR_CONDITIONS, riggerQualities, rccRating, EW_ACTIONS, EW_ACTION_DEFS, qualityLines,
  VEHICLE_CALLED_SHOTS, CALLED_SHOT_BY_ID, vehicleDisabled, type EwActionId,
} from '/shared/vehicles.ts';
import { Overlay, DiceFaces, RollBadges, itemLabel, itemTitle } from './common.tsx';
import { useModifiers, poolModsOf, sourceName } from './modifiers-ui.tsx';
import { rollContext, derivedWithModifiers } from '/shared/modifiers.ts';
import { fireOptions, usesAmmo } from './inventory.ts';
import { fireSelectOptions } from './weapon-ui.tsx';
import { attackMap, targetCandidates } from '../combat/attack-common.ts';
import { SubChips, vehicleSlotsText } from './sublists.tsx';
import { ItemRef, BookRef } from '../books/BookRef.tsx';
import type { Actor, Autosoft, AutosoftKind, ChaseEnvironment, GameView, Vehicle, VehicleBreakdowns, VehicleControl, Weapon } from '../../../shared/types.ts';
import type { SheetCtx, ShownRoll } from './types.ts';
import './vehicles.css';

const act = (type: string, payload: object) => send(type, payload).catch(() => null);
const fullActor = (game: GameView, id: string | null | undefined): Actor | null => {
  const a = id ? game.actors?.[id] : null;
  return a && 'attributes' in a ? a : null;
};
const mine = (game: GameView, id: string | null | undefined): boolean => game.me?.role === 'gm' || (!!id && (game.me?.characterIds || []).includes(id));

/** The one at the controls, as the server picks them (shared rules: driverId, else the owner; nobody on autopilot). */
function driverOf(game: GameView, owner: Actor, v: Vehicle): Actor | null {
  if (controlOf(v) === 'auto') return null;
  return fullActor(game, v.driverId) || owner;
}
/** Controller info the server would compute (persona mode, control rig, Data Processing). */
function controllerOf(game: GameView, driver: Actor | null): ControllerInfo {
  if (!driver) return { rig: 0, vr: false, hot: false, dataProcessing: 0 };
  const persona = game.matrix?.personas?.[driver.id];
  const mode = persona?.online ? persona.mode : null;
  return { rig: controlRigRating(driver), vr: mode === 'cold' || mode === 'hot', hot: mode === 'hot', dataProcessing: Number(driver.matrix?.dataProcessing) || 0 };
}
const vehicleTokenOn = (game: GameView, ownerId: string, vehicleId: string) => {
  const map = attackMap(game);
  return (map?.tokens || []).find((tk2) => tk2.actorId === ownerId && tk2.vehicleId === vehicleId) || null;
};
const lineText = (l: PlanLine, i: number): string => `${i ? (l.value >= 0 ? ' + ' : ' − ') : ''}${t(l.label)} ${i ? Math.abs(l.value) : l.value}`;
const CONTROL_HINTS: Record<VehicleControl, string> = {
  manual: tk('Physical controls (AR interface: +1 to the limits)'),
  remote: tk('Control Device through a commlink / RCC: AR +1 or VR +2 to the limits, never above its Data Processing'),
  rigged: tk('Jumped in with a control rig: VR +2 and the rig rating to the limits, thresholds − rig rating; half the vehicle\'s damage as biofeedback'),
  auto: tk('The Pilot program drives: Pilot + autosoft, its own initiative (Pilot × 2 + 4D6)'),
};

// ---------------------------------------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------------------------------------

type DialogState = { mode: 'test'; test: VehicleTestKind } | { mode: 'fire'; weaponId: string } | { mode: 'ram' } | null;
type ExtraDialog = 'repair' | 'ew' | null;

export function VehicleCard({ s, v }: { s: SheetCtx; v: Vehicle }) {
  const { actor, game, gm } = s;
  const ui = useUI();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [config, setConfig] = useState(false);
  const [extra, setExtra] = useState<ExtraDialog>(null);
  const control = controlOf(v);
  const driver = driverOf(game, actor, v);
  const canAct = gm || mine(game, actor.id) || (!!v.driverId && mine(game, v.driverId));
  const st = vehicleStats(v);
  const max = vehicleMonitor(v);
  const dmg = vehicleDamage(v);
  const destroyed = vehicleDestroyed(v);
  const dmgMod = vehicleDamageMod(v);
  const drone = isDrone(v);
  const token = vehicleTokenOn(game, actor.id, v.id);
  const mounted = (actor.weapons || []).filter((w) => w.vehicleId === v.id);
  const mountable = (actor.weapons || []).filter((w) => !w.vehicleId && w.kind !== 'melee' && !w.natural);
  const chase = game.chase?.active ? game.chase.vehicles.find((x) => x.actorId === actor.id && x.vehicleId === v.id) : null;
  const target = ui.targetTokenId && token ? (attackMap(game)?.tokens || []).find((x) => x.id === ui.targetTokenId) : null;
  // Who can be put at the controls: the owner, the user's own runners (the GM: every PC and NPC).
  const drivers = Object.values(game.actors || {}).filter((a) => a && 'attributes' in a && (a.id === actor.id || (gm ? true : mine(game, a.id)))) as Actor[];
  const setDamage = (n: number) => act('vehicle/damage', { actorId: actor.id, vehicleId: v.id, damage: n });
  const stat = (label: string, value: number | string, extra?: string) => <span key={label}><span className="faint">{t(label)}</span>{' '}<b>{value}</b>{extra ? <small className="red"> {extra}</small> : null}</span>;
  const [hOn, hOff] = splitStat(v.handling);
  const hText = hOn !== hOff ? `${st.handling}/${st.handlingOff}` : String(st.handling);
  return <div className={'sh-card sh-veh' + (destroyed ? ' sh-veh-destroyed' : '')}>
    <div className="row spread wrap gap-s">
      <span>
        <b title={itemTitle(v)}>{itemLabel(v)}</b>{' '}<ItemRef item={v} />
        {drone ? <>{' '}<span className="badge badge-cyan">{t('drone')}</span></> : null}
        {destroyed ? <>{' '}<span className="badge badge-red">{t('destroyed')}</span></> : null}
        {chase ? <>{' '}<span className="badge badge-amber" title={t('In the chase')}>🏁 {chase.role === 'quarry' ? t('quarry') : t(CHASE_RANGE_LABELS[chase.range || 'medium'])}</span></> : null}
      </span>
      <span className="faint small">{t(skillKey(vehicleSkillId(v)))}</span>
    </div>
    <div className="sh-vstats">
      {stat(tk('Handl.'), hText, dmgMod ? String(dmgMod) : '')}
      {stat(tk('Speed'), st.speed)}{stat(tk('Accel.'), st.accel)}{stat(tk('vehicle-abbr::Body'), st.body)}{stat(tk('vehicle-abbr::Armor'), st.armor)}
      {stat(tk('Pilot'), st.pilot)}{stat(tk('Sensor'), st.sensor)}{st.seats ? stat(tk('Seats'), st.seats) : null}
    </div>
    <div className="sh-veh-monitor" title={t('Condition monitor: {n} boxes ({base} + Body/2) — vehicles ignore Stun', { n: max, base: drone ? 6 : 12 })}>
      {Array.from({ length: max }, (_, i) => <button key={i} type="button" disabled={!(gm || s.own)} className={'sh-veh-box' + (i < dmg ? ' on' : '') + ((i + 1) % 3 === 0 ? ' third' : '')}
        onClick={() => setDamage(i + 1 === dmg ? i : i + 1)} aria-label={t('{n} box(es) of damage', { n: i + 1 })} />)}
      <span className="mono small">{dmg}/{max}</span>
      <BookRef source="SR5" page={199} />
    </div>
    {canAct && <div className="row wrap gap-s sh-veh-control">
      <Select value={control} onChange={(c) => act('vehicle/control', { actorId: actor.id, vehicleId: v.id, control: c })}
        options={VEHICLE_CONTROLS.map((c) => ({ value: c, label: t(CONTROL_LABELS[c]) }))} title={t(CONTROL_HINTS[control])} />
      {control !== 'auto' && drivers.length > 1 && <Select value={v.driverId || actor.id} onChange={(id) => act('vehicle/control', { actorId: actor.id, vehicleId: v.id, driverId: id === actor.id ? null : id })}
        options={drivers.map((a) => ({ value: a.id, label: a.name }))} title={t('At the controls')} />}
      {control === 'manual' && <Toggle value={!!v.ar} onChange={(on) => act('vehicle/control', { actorId: actor.id, vehicleId: v.id, ar: on })} label={t('AR')} title={t('AR interface: +1 to the limits')} />}
      {control === 'rigged' && driver && <span className="badge badge-magenta" title={t('Control rig rating')}>{t('rig {n}', { n: controlRigRating(driver) })}</span>}
      {!hasRiggerInterface(v) && <span className="faint small" title={t('Needed to jump in (drones have one)')}>{t('no rigger interface')}</span>}
    </div>}
    <VehicleExtras s={s} v={v} canAct={canAct} />
    {!canAct && <div className="faint small">{t(CONTROL_LABELS[control])}{driver && driver.id !== actor.id ? ` · ${driver.name}` : ''}</div>}
    {canAct && !destroyed && <div className="row wrap gap-s">
      <Button small disabled={vehicleDisabled(v)} onClick={() => setDialog({ mode: 'test', test: 'control' })} title={t('Vehicle skill + REA [Handling] against a threshold (SR5 p. 199)')}>🎲 {t('Vehicle Test')}</Button>
      <Button small onClick={() => setDialog({ mode: 'test', test: 'perception' })} title={t('Perception + INT [Sensor], autopilot Pilot + Clearsight')}>{t('Sensors')}</Button>
      <Button small onClick={() => setDialog({ mode: 'test', test: 'stealth' })}>{t('Stealth')}</Button>
      {control === 'auto' && <Button small onClick={() => setDialog({ mode: 'test', test: 'pilot' })} title={t('Pilot × 2 when something unexpected happens (SR5 p. 269)')}>{t('Pilot program')}</Button>}
      {token && <Button small disabled={!target || target.id === token.id} onClick={() => setDialog({ mode: 'ram' })} title={target ? t('Ram {name}', { name: target.name }) : t('Target a token on the map first')}>{t('Ram')}</Button>}
      {token && <Button small disabled={!target || target.id === token.id} onClick={() => target && act('vehicle/lock', { actorId: actor.id, vehicleId: v.id, targetTokenId: target.id })} title={target ? t('Sensor Test vs {name}: the net hits lower its defense against this vehicle\'s weapons (SR5 p. 184)', { name: target.name }) : t('Target a token on the map first')}>🔒 {t('Lock')}</Button>}
      {driver && mine(game, driver.id) && driver.matrix && <Button small onClick={() => setExtra('ew')} title={t('Electronic warfare (Rigger 5.0 p. 30)')}>📡 {t('EW')}</Button>}
      {token
        ? <Button small variant="ghost" onClick={() => act('vehicle/unplace', { actorId: actor.id, vehicleId: v.id })}>{t('Remove from the map')}</Button>
        : <Button small variant="ghost" onClick={() => act('vehicle/place', { actorId: actor.id, vehicleId: v.id })} title={t('Put the vehicle on the shown map, next to its driver')}>⌖ {t('Put on the map')}</Button>}
    </div>}
    {(mounted.length > 0 || (canAct && mountable.length > 0)) && <div className="sh-veh-weapons">
      {mounted.map((w) => <div className="row wrap gap-s" key={w.id}>
        <span className="grow"><b>{itemLabel(w)}</b> <span className="faint small">{w.damage} · {t('AP')} {w.ap} · {w.mode}{usesAmmo(w) ? ` · ${Number(w.ammoLoaded ?? 0)}/${w.ammoMax ?? ''}` : ''}</span></span>
        {canAct && !destroyed && <Button small onClick={() => setDialog({ mode: 'fire', weaponId: w.id })}>🎯 {t('Fire')}</Button>}
        {(gm || s.own) && <Button small variant="ghost" onClick={() => act('vehicle/mount', { actorId: actor.id, weaponId: w.id, vehicleId: null })} title={t('Take it off the vehicle')}>✕</Button>}
      </div>)}
      {(gm || s.own) && mountable.length > 0 && <Select value="" onChange={(id) => id && act('vehicle/mount', { actorId: actor.id, weaponId: id, vehicleId: v.id })}
        options={[{ value: '', label: t('+ Mount a weapon…') }, ...mountable.map((w) => ({ value: w.id, label: itemLabel(w) }))]} />}
    </div>}
    {((v.autosofts || []).length > 0 || gm) && <div className="row wrap gap-s small">
      <span className="faint">{t('Autosofts')}</span>
      {(v.autosofts || []).map((a) => <span className="badge" key={a.id}>{t(AUTOSOFT_LABELS[a.kind])} {a.rating}{a.target ? ` (${a.target})` : ''}</span>)}
      {gm && <Button small variant="ghost" onClick={() => setConfig(!config)}>{config ? t('Done') : '✎'}</Button>}
    </div>}
    {config && gm && <VehicleConfig actor={actor} v={v} />}
    {(v.mods || []).length > 0 && <><div className="faint small">{vehicleSlotsText(v)}</div><SubChips sub="mods" items={v.mods} /></>}{v.notes && <div className="faint small">{v.notes}</div>}
    {(gm || s.own) && !destroyed && (dmg > 0 || Object.values(v.breakdowns || {}).some(Boolean)) && <div className="row gap-s">
      <Button small variant="ghost" onClick={() => setExtra('repair')} title={t('Repair (Rigger 5.0 p. 29)')}>🔧 {t('Repair')}</Button>
    </div>}
    {dialog && <VehicleDialog game={game} owner={actor} v={v} state={dialog} onClose={() => setDialog(null)} />}
    {extra === 'repair' && <RepairDialog game={game} owner={actor} v={v} onClose={() => setExtra(null)} />}
    {extra === 'ew' && driver && <EwDialog game={game} rigger={driver} v={v} onClose={() => setExtra(null)} />}
  </div>;
}

/** GM: drone flag, vehicle skill, rigger interface, autosofts. */
function VehicleConfig({ actor, v }: { actor: Actor; v: Vehicle }) {
  const [kind, setKind] = useState<AutosoftKind>('maneuvering');
  const [rating, setRating] = useState(3);
  const [target, setTarget] = useState('');
  const patch = (p: object) => act('vehicle/configure', { actorId: actor.id, vehicleId: v.id, patch: p });
  const softs: Autosoft[] = v.autosofts || [];
  return <div className="sh-veh-config col gap-s">
    <div className="row wrap gap-s">
      <Toggle value={isDrone(v)} onChange={(on) => patch({ drone: on })} label={t('Drone')} />
      <Toggle value={!!v.riggerInterface || isDrone(v)} onChange={(on) => patch({ riggerInterface: on })} label={t('Rigger interface')} />
      <Select value={v.skill || ''} onChange={(sk) => patch({ skill: sk || null })} options={[{ value: '', label: t('Skill: {skill} (guessed)', { skill: t(skillKey(vehicleSkillId({ ...v, skill: undefined }))) }) }, ...VEHICLE_SKILLS.map((id) => ({ value: id, label: t(skillKey(id)) }))]} />
    </div>
    {softs.map((a) => <div className="row gap-s small" key={a.id}>
      <span className="grow">{t(AUTOSOFT_LABELS[a.kind])} {a.rating}{a.target ? ` (${a.target})` : ''}</span>
      <Button small variant="ghost" onClick={() => patch({ autosofts: softs.filter((x) => x.id !== a.id) })}>✕</Button>
    </div>)}
    <div className="row wrap gap-s">
      <Select value={kind} onChange={(k) => setKind(k as AutosoftKind)} options={AUTOSOFT_KINDS.map((k) => ({ value: k, label: t(AUTOSOFT_LABELS[k]) }))} />
      <NumberInput small value={rating} min={1} max={6} onChange={setRating} />
      {kind === 'targeting' && <input className="input" value={target} placeholder={t('Weapon (empty = any)')} onChange={(e) => setTarget(e.target.value)} />}
      <Button small onClick={() => { patch({ autosofts: [...softs, { kind, rating, ...(target.trim() ? { target: target.trim() } : {}) }] }); setTarget(''); }}>+ {t('Autosoft')}</Button>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dialog: a vehicle test, firing a mounted weapon, a ram
// ---------------------------------------------------------------------------------------------------------------------

const TEST_LABELS: Record<VehicleTestKind, string> = { control: tk('Vehicle Test'), perception: tk('Sensor Test'), stealth: tk('Vehicle stealth'), pilot: tk('Pilot program') };

function VehicleDialog({ game, owner, v, state, onClose }: { game: GameView; owner: Actor; v: Vehicle; state: NonNullable<DialogState>; onClose: () => void }) {
  const ui = useUI();
  const driver = driverOf(game, owner, v);
  const c = controllerOf(game, driver);
  const chaseEnv: ChaseEnvironment = game.chase?.active ? game.chase.environment : 'handling';
  const [test, setTest] = useState<VehicleTestKind>(state.mode === 'test' ? state.test : 'control');
  const [threshold, setThreshold] = useState<number | null>(test === 'control' ? 2 : null);
  const [terrain, setTerrain] = useState(game.chase?.active ? game.chase.terrain : 0);
  const [env, setEnv] = useState<ChaseEnvironment>(chaseEnv);
  const [offRoad, setOffRoad] = useState(false);
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShownRoll | null>(null);
  // Fire / ram
  const weapons = (owner.weapons || []).filter((w) => w.vehicleId === v.id);
  const [weaponId, setWeaponId] = useState(state.mode === 'fire' ? state.weaponId : weapons[0]?.id || '');
  const weapon: Weapon | null = weapons.find((w) => w.id === weaponId) || null;
  const fireOpts = weapon && usesAmmo(weapon) ? fireOptions(weapon) : [];
  const [fireMode, setFireMode] = useState<string>(fireOpts[0]?.id || '');
  const [passive, setPassive] = useState(false);
  const [calledShot, setCalledShot] = useState('');
  const [atSpeed, setAtSpeed] = useState(!!game.chase?.active);
  const ev = swarmVehicle(owner.vehicles, v, Math.max(rccRating(owner), rccRating(driver))) as Vehicle;
  const candidates = targetCandidates(game, owner.id, weapon, owner).filter((x) => !(x.token.actorId === owner.id && x.token.vehicleId === v.id));
  const [targetId, setTargetId] = useState(ui.targetTokenId && candidates.some((x) => x.token.id === ui.targetTokenId) ? ui.targetTokenId : '');
  const st = vehicleStats(v);
  const [walk, run] = movementRate(st.speed);
  const [meters, setMeters] = useState(walk || 10);

  const driverMods = useModifiers(driver, { weaponId: state.mode === 'fire' ? weaponId : null });
  const hasOffRoad = splitStat(v.handling)[0] !== splitStat(v.handling)[1];
  let plan: VehicleTestPlan | null = null;
  let limitText = '';
  let pool = 0;
  let poolLines: PlanLine[] = [];
  if (state.mode === 'fire') {
    const g = gunneryPlan(ev, weapon, c, driver, { passive });
    pool = previewDriverPool(driver, g.roller) + g.bonus.reduce((n, l) => n + l.value, 0);
    poolLines = g.roller.kind === 'pilot' ? g.roller.lines : [{ label: skillKey('gunnery'), value: 0 }, { label: g.roller.attr, value: 0 }];
    limitText = g.limitReplace !== null ? `${t('Sensor')} ${g.limitReplace}` : `${t('Accuracy')} ${weapon?.accuracy ?? '—'}${g.limitAdd ? ` + ${t('control rig')} ${g.limitAdd}` : ''}${g.limitMax ? ` (${t('max {n}', { n: g.limitMax })})` : ''}`;
    if (g.impossible) limitText = t('No Targeting autosoft for this weapon');
  } else {
    plan = vehicleTestPlan(ev, state.mode === 'ram' ? 'control' : test, c, driver, { env, offRoad, threshold: state.mode === 'ram' ? null : threshold, terrain });
    // Rigger 5.0 qualities of the driver (Speed Demon, Too Much Data…), as the server adds them.
    if (plan.roller.kind === 'driver' && (state.mode === 'ram' || test === 'control')) plan = { ...plan, bonus: [...plan.bonus, ...qualityLines(driver, v, { atSpeed: state.mode === 'ram' || atSpeed })] };
    pool = previewDriverPool(driver, plan.roller) + plan.bonus.reduce((n, l) => n + l.value, 0) + (state.mode === 'ram' && meters > walk ? -3 : 0);
    poolLines = plan.roller.kind === 'pilot' ? plan.roller.lines : [];
    limitText = plan.limit !== null ? plan.limitLines.map(lineText).join('') + (plan.limitLines.length > 1 ? ` = ${plan.limit}` : '') : t('none');
  }
  // The driver's sheet modifiers (qualities, 'ware…) and wound modifier, as the server applies them.
  const roller = state.mode === 'fire' ? gunneryPlan(ev, weapon, c, driver, { passive }).roller : plan!.roller;
  // Called shot at a vehicle component (Run & Gun p. 115): only against a vehicle token.
  const targetTok = candidates.find((x) => x.token.id === targetId)?.token || null;
  const shot = state.mode === 'fire' && targetTok?.vehicleId ? CALLED_SHOT_BY_ID[calledShot] || null : null;
  if (shot) pool += shot.mod;
  const modLines = roller.kind === 'driver' && driver
    ? poolModsOf(driverMods, rollContext(driver, { skillId: roller.skillId || null, attr: roller.attr, attr2: roller.skillId ? null : 'INT', weaponId: state.mode === 'fire' ? weaponId : null }), { conditions: [], ignore: [], isGM: game.me?.role === 'gm' }).lines.filter((l) => l.state === 'applied')
    : [];
  const wounds = roller.kind === 'driver' && driver ? derivedWithModifiers(driver, driverMods).woundModifier || 0 : 0;
  pool += modLines.reduce((n, l) => n + (l.value ?? 0), 0) + wounds;
  const total = Math.max(0, pool + modifier);
  const canEdge = !!driver && mine(game, driver.id) && (driver.edge?.current ?? 0) > 0 && (state.mode === 'fire' ? gunneryPlan(v, weapon, c, driver).roller.kind === 'driver' : plan?.roller.kind === 'driver');
  const title = state.mode === 'fire' ? t('Fire — {weapon}', { weapon: weapon ? itemLabel(weapon) : '—' }) : state.mode === 'ram' ? t('Ram') : t(TEST_LABELS[test]);

  const roll = async () => {
    setBusy(true);
    try {
      let r: ShownRoll | null;
      if (state.mode === 'fire') {
        r = await send<ShownRoll>('attack/roll', {
          actorId: owner.id, weaponId, label: `Attack — ${weapon?.nameFr || weapon?.name || ''}`, modifier, explode: explode && canEdge, // i18n-ignore: stored label, shown with rollLabel()
          ...(fireMode ? { fireMode } : {}), ...(targetId ? { targetTokenId: targetId } : {}), ...(passive ? { passive: true } : {}), ...(shot ? { calledShot: shot.id } : {}),
          ...(game.me?.role === 'gm' && attackMap(game) ? { mapId: attackMap(game)!.id } : {}),
        });
      } else if (state.mode === 'ram') {
        r = await send<ShownRoll>('vehicle/ram', { actorId: owner.id, vehicleId: v.id, targetTokenId: targetId, metersPerTurn: meters, modifier, explode: explode && canEdge });
      } else {
        r = await send<ShownRoll>('vehicle/roll', { actorId: owner.id, vehicleId: v.id, test, threshold, terrain, env, offRoad, atSpeed, modifier, explode: explode && canEdge });
      }
      setResult(r);
      if (explode) setExplode(false);
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  return <Overlay title={title} onClose={onClose} width={480}>
    <div className="sh-rd sh-veh-dialog">
      <div className="row wrap gap-s muted small">
        <span>{v.name}</span><span>·</span><span>{t(CONTROL_LABELS[controlOf(v)])}{driver ? ` · ${driver.name}` : ''}</span>
        <BookRef source="SR5" page={state.mode === 'fire' ? 183 : state.mode === 'ram' ? 203 : test === 'perception' || test === 'stealth' ? 184 : 199} />
      </div>
      {state.mode === 'test' && <div className="row wrap gap-s">
        <Select value={test} onChange={(x) => { setTest(x as VehicleTestKind); if (x !== 'control') setThreshold(null); }} options={(['control', 'perception', 'stealth', ...(controlOf(v) === 'auto' ? ['pilot'] : [])] as VehicleTestKind[]).map((k) => ({ value: k, label: t(TEST_LABELS[k]) }))} />
      </div>}
      {state.mode === 'fire' && <div className="col gap-s">
        <div className="row wrap gap-s">
          {weapons.length > 1 && <Select value={weaponId} onChange={setWeaponId} options={weapons.map((w) => ({ value: w.id, label: itemLabel(w) }))} />}
          {weapon && fireOpts.length > 1 && <Select value={fireMode} onChange={setFireMode} options={fireSelectOptions(weapon)} />}
          {weapon && usesAmmo(weapon) && <span className="badge mono">{Number(weapon.ammoLoaded ?? 0)}/{weapon.ammoMax}</span>}
        </div>
        <Toggle value={passive} onChange={setPassive} label={t('Passive targeting: the vehicle\'s Sensor as the limit (Gunnery + LOG)')} />
      </div>}
      {state.mode === 'fire' && targetTok?.vehicleId && !result && <div className="row wrap gap-s">
        <span className="field-label">{t('Called shot')}</span>
        <Select value={calledShot} onChange={setCalledShot} options={[{ value: '', label: t('— none —') }, ...VEHICLE_CALLED_SHOTS.map((x) => ({ value: x.id, label: `${t(x.label)} (${x.mod})` }))]} />
        {shot && <span className="faint small">{t(shot.note)}{shot.dvLimit !== null ? ` · ${t('max DV {n}', { n: shot.dvLimit })}` : ''} <BookRef source={shot.source} page={shot.page} /></span>}
      </div>}
      {(state.mode === 'fire' || state.mode === 'ram') && !result && <div className="row wrap gap-s">
        <span className="field-label">{t('Target')}</span>
        <Select value={targetId} onChange={setTargetId} options={[{ value: '', label: candidates.length ? t('— none —') : t('— no token on the map —') }, ...candidates.map((x) => ({ value: x.token.id, label: x.name + (x.meters !== null ? ` · ${x.meters} m` : '') }))]} />
      </div>}
      {state.mode === 'ram' && <div className="row wrap gap-s">
        <span className="field-label">{t('Speed (m / turn)')}</span>
        <NumberInput small value={meters} min={1} max={Math.max(1, run)} onChange={setMeters} />
        <span className="faint small">{t('walk {w} · run {r} (−3)', { w: walk, r: run })} · {t('DV {dv}P, AP −6', { dv: ramDamage(st.body, meters) })}</span>
      </div>}
      {state.mode === 'test' && test !== 'pilot' && <div className="sh-veh-grid">
        {test === 'control' && <>
          <span className="field-label">{t('Threshold')}</span>
          <Select value={String(threshold ?? '')} onChange={(x) => setThreshold(x === '' ? null : Number(x))} options={[{ value: '', label: t('— none —') }, ...VEHICLE_THRESHOLDS.map((x) => ({ value: String(x.value), label: `${t(x.label)} (${x.value})` })), { value: '5', label: '5' }, { value: '6', label: '6' }]} />
          <span className="field-label">{t('Terrain')}</span>
          <Select value={String(terrain)} onChange={(x) => setTerrain(Number(x))} options={TERRAINS.map((x) => ({ value: String(x.value), label: `${t(x.label)} (+${x.value})` }))} title={t(TERRAINS.find((x) => x.value === terrain)?.hint || '')} />
        </>}
        {test !== 'perception' && <>
          <span className="field-label">{t('Limit')}</span>
          <Select value={env} onChange={(x) => setEnv(x as ChaseEnvironment)} options={[{ value: 'handling', label: t('Handling') }, { value: 'speed', label: t('Speed') }]} />
        </>}
        {hasOffRoad && test !== 'perception' && <><span /><Toggle value={offRoad} onChange={setOffRoad} label={t('Off-road')} /></>}
        {test === 'control' && driver && riggerQualities(driver).has('speedDemon') && <><span /><Toggle value={atSpeed} onChange={setAtSpeed} label={t('Moving fast (Speed Demon)')} /></>}
      </div>}
      <div className="sh-rd-breakdown">
        {poolLines.map((l, i) => <span key={i} className="sh-rd-part"><span>{t(l.label)}</span>{l.value ? <b>{i ? '+' : ''}{l.value}</b> : null}</span>)}
        {plan?.roller.kind === 'driver' && plan.roller.skillId && <span className="sh-rd-part"><span>{t(skillKey(plan.roller.skillId))} + {plan.roller.attr}</span></span>}
        {plan?.roller.kind === 'driver' && !plan.roller.skillId && <span className="sh-rd-part"><span>REA + INT</span></span>}
        {(plan?.bonus || []).map((l) => <span key={l.label} className={'sh-rd-part mod' + (l.value < 0 ? ' bad' : '')}><span>{t(l.label)}</span><b>{l.value >= 0 ? '+' : ''}{l.value}</b></span>)}
        {shot ? <span className="sh-rd-part bad"><span>{t(shot.label)}</span><b>{shot.mod}</b></span> : null}
        {modLines.map((l) => <span key={l.mod.id} className={'sh-rd-part mod' + ((l.value ?? 0) < 0 ? ' bad' : '')}><span>{sourceName(l.mod.source)}</span><b>{(l.value ?? 0) >= 0 ? '+' : ''}{l.value}</b></span>)}
        {wounds ? <span className="sh-rd-part bad"><span>{t('wounds')}</span><b>{wounds}</b></span> : null}
        {state.mode === 'ram' && meters > walk ? <span className="sh-rd-part bad"><span>{t('running rate')}</span><b>−3</b></span> : null}
        {modifier ? <span className="sh-rd-part"><span>{t('mod.')}</span><b>{modifier > 0 ? '+' : ''}{modifier}</b></span> : null}
        <span className="sh-rd-total">{tn(total, '≈ {n} die', '≈ {n} dice')}</span>
      </div>
      <div className="small muted">
        {t('Limit')}: {limitText}
        {plan && plan.threshold !== null ? <> · {t('Threshold')}: {plan.thresholdLines.length > 1 ? `${plan.thresholdLines.map((l, i) => (i ? lineText(l, i) : String(l.value))).join('')} = ${plan.threshold}` : plan.threshold}</> : null}
      </div>
      <div className="row wrap gap-s">
        <span className="field-label">{t('Edit')}</span>
        <NumberInput small value={modifier} min={-30} max={30} onChange={setModifier} />
        {canEdge && <Toggle value={explode} onChange={setExplode} label={t('Push the Limit (Edge)')} />}
      </div>
      {result && <div className="sh-rd-result">
        <div className="sh-rd-hits"><b>{result.hits}</b><span>{tn(result.hits ?? 0, 'one::hit', 'other::hits')}</span></div>
        <div className="grow col gap-s">
          <DiceFaces roll={result} />
          <RollBadges roll={result} />
          {result.attackId && <span className="small cyan">{(result.hits ?? 0) > 0 ? t('Attack sent to {target}: waiting for their defense.', { target: result.targetName || candidates.find((x) => x.token.id === targetId)?.name || '' }) : t('Miss: no hits.')}</span>}
        </div>
      </div>}
      <div className="row spread">
        <span />
        <div className="row">
          <Button variant="ghost" onClick={onClose}>{t('Close')}</Button>
          <Button variant="primary" disabled={busy || total <= 0 || (state.mode === 'ram' && !targetId) || (state.mode === 'fire' && !weapon)} onClick={roll}>
            {result ? t('Roll again') : t('Roll')}
          </Button>
        </div>
      </div>
    </div>
  </Overlay>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Breakdowns, swarm, locks (Run & Gun p. 115; Rigger 5.0 p. 31; SR5 p. 184)
// ---------------------------------------------------------------------------------------------------------------------

const BREAKDOWN_LABELS: Array<[keyof VehicleBreakdowns, string]> = [
  ['disabled', tk('disabled')], ['leak', tk('leaking')], ['axle', tk('broken axle (Speed 1)')], ['antenna', tk('no antenna (no wireless)')],
  ['door', tk('door jammed')], ['window', tk('window jammed')],
];

function VehicleExtras({ s, v, canAct }: { s: SheetCtx; v: Vehicle; canAct: boolean }) {
  const { actor, game, gm } = s;
  const b = v.breakdowns || {};
  const locks = (game.rigging?.locks || []).filter((l) => l.actorId === actor.id && l.vehicleId === v.id);
  const swarms = [...new Set((actor.vehicles || []).map((x) => x.swarm).filter(Boolean) as string[])];
  const members = swarmMembers(actor.vehicles, v);
  const setSwarm = async (val: string) => {
    let name = val;
    if (val === '+') {
      const typed = await promptText(t('Name of the new swarm'), '');
      if (!typed) return;
      name = typed;
    }
    act('vehicle/swarm', { actorId: actor.id, vehicleId: v.id, swarm: name });
  };
  const clear = (k: string, val: unknown) => act('vehicle/breakdown', { actorId: actor.id, vehicleId: v.id, patch: { [k]: val } });
  return <>
    {(BREAKDOWN_LABELS.some(([k]) => b[k]) || b.tires) && <div className="row wrap gap-s small">
      {BREAKDOWN_LABELS.filter(([k]) => b[k]).map(([k, label]) => <span key={k} className="badge badge-red">{t(label)}{gm ? <button type="button" className="sh-veh-x" onClick={() => clear(k, false)} title={t('Repaired')}>✕</button> : null}</span>)}
      {b.tires ? <span className="badge badge-red">{tn(b.tires, '{n} flat tire (−2)', '{n} flat tires (−{m})', { m: 2 * b.tires })}{gm ? <button type="button" className="sh-veh-x" onClick={() => clear('tires', b.tires! - 1)} title={t('Repaired')}>✕</button> : null}</span> : null}
      <BookRef source="RG" page={115} />
    </div>}
    {(isDrone(v) && (canAct || v.swarm)) && <div className="row wrap gap-s small">
      <span className="faint">{t('Swarm')}</span>
      {(gm || s.own)
        ? <Select value={v.swarm || ''} onChange={setSwarm} options={[{ value: '', label: t('— none —') }, ...swarms.map((x) => ({ value: x, label: x })), { value: '+', label: t('+ New swarm…') }]} />
        : <span>{v.swarm}</span>}
      {members.length > 1 && <span className="badge badge-cyan" title={t('Acts as one drone: best Pilot / Sensor / autosofts, worst Handling / Speed / Acceleration')}>{t('{n} drones: +{b} dice and limits', { n: members.length, b: members.length - 1 })}</span>}
      <BookRef source="R5" page={31} />
    </div>}
    {locks.map((l) => <div className="row gap-s small" key={l.id}>
      <span className="badge badge-amber">🔒 {t('Locked on {target} ({n})', { target: l.targetName, n: l.net })}</span>
      {canAct && <Button small variant="ghost" onClick={() => act('vehicle/unlock', { lockId: l.id })}>✕</Button>}
    </div>)}
  </>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Repair (Rigger 5.0 p. 29-30)
// ---------------------------------------------------------------------------------------------------------------------

const MECHANIC_SKILLS = ['automotive_mechanic', 'aeronautics_mechanic', 'nautical_mechanic', 'industrial_mechanic'];

export function RepairDialog({ game, owner, v, onClose }: { game: GameView; owner: Actor; v: Vehicle; onClose: () => void }) {
  const gm = game.me?.role === 'gm';
  const mechanics = Object.values(game.actors || {}).filter((a) => a && 'attributes' in a && mine(game, a.id) && (gm || a.type === 'pc')) as Actor[];
  const [mechId, setMechId] = useState(mechanics.find((a) => a.id === owner.id)?.id || mechanics[0]?.id || '');
  const mech = mechanics.find((a) => a.id === mechId) || null;
  const dmg = vehicleDamage(v);
  const [boxes, setBoxes] = useState(dmg);
  const [skillId, setSkillId] = useState(mechanicSkillFor(v));
  const [conditions, setConditions] = useState(0);
  const [tools, setTools] = useState<'ok' | 'none' | 'superior'>('ok');
  const [short, setShort] = useState(0);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ success: boolean; rolls: number[]; hours: number; cost: number } | null>(null);
  const sk = mech ? skillPool(mech, skillId) : null;
  const grease = mech && riggerQualities(mech).has('greaseMonkey') ? 1 : 0;
  const pool = sk ? sk.pool + conditions + (tools === 'none' ? -4 : tools === 'superior' ? 1 : 0) - 4 * short + grease : 0;
  const go = async () => {
    setBusy(true);
    try {
      setRes(await send('vehicle/repair', { actorId: owner.id, vehicleId: v.id, mechanicId: mechId, boxes, skillId, conditions, tools, partsShort: short }));
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return <Overlay title={t('Repair — {vehicle}', { vehicle: v.name })} onClose={onClose} width={460}>
    <div className="col gap-s sh-veh-dialog">
      <div className="faint small">{t('Extended Mechanic + LOG [Mental] test: threshold = boxes to repair, one roll per 4 hours (a day when parts are short). Spare parts: 5 % of the vehicle\'s price per box.')} <BookRef source="R5" page={29} /></div>
      <div className="sh-veh-grid">
        <span className="field-label">{t('Mechanic')}</span>
        <Select value={mechId} onChange={setMechId} options={mechanics.map((a) => ({ value: a.id, label: a.name }))} />
        <span className="field-label">{t('Skill')}</span>
        <Select value={skillId} onChange={setSkillId} options={MECHANIC_SKILLS.map((id) => ({ value: id, label: t(skillKey(id)) }))} />
        <span className="field-label">{t('Boxes')}</span>
        <NumberInput small value={boxes} min={0} max={dmg} onChange={setBoxes} />
        <span className="field-label">{t('Conditions')}</span>
        <Select value={String(conditions)} onChange={(x) => setConditions(Number(x))} options={REPAIR_CONDITIONS.map((c) => ({ value: String(c.value), label: `${t(c.label)} (${c.value >= 0 ? '+' : ''}${c.value})` }))} />
        <span className="field-label">{t('Tools')}</span>
        <Select value={tools} onChange={(x) => setTools(x as 'ok' | 'none' | 'superior')} options={[{ value: 'ok', label: t('Toolkit') }, { value: 'superior', label: t('Superior (+1)') }, { value: 'none', label: t('Unavailable (−4)') }]} />
        <span className="field-label">{t('Parts missing (boxes)')}</span>
        <NumberInput small value={short} min={0} max={Math.max(0, boxes)} onChange={setShort} />
      </div>
      <div className="sh-rd-breakdown">
        <span className="sh-rd-part"><span>{t(skillKey(skillId))} + {attrShort('LOG')}</span><b>{sk?.pool ?? 0}</b></span>
        {grease ? <span className="sh-rd-part mod"><span>{t('Grease Monkey')}</span><b>+1</b></span> : null}
        <span className="sh-rd-total">{tn(Math.max(0, pool), '≈ {n} die', '≈ {n} dice')}</span>
      </div>
      {sk?.impossible && <div className="error small">{t('Untrained skill: it can\'t be used by defaulting.')}</div>}
      {res && <div className={'atk-big' + (res.success ? '' : ' hit')}>
        {res.success ? t('Repaired in {h} h (hits {rolls}).', { h: res.hours, rolls: res.rolls.join(' + ') }) : t('Not repaired after {h} h (hits {rolls}).', { h: res.hours, rolls: res.rolls.join(' + ') })}
        {res.cost ? <div className="small muted">{t('Spare parts: {cost}¥', { cost: res.cost })}</div> : null}
      </div>}
      <div className="row spread">
        <span />
        <div className="row">
          <Button variant="ghost" onClick={onClose}>{t('Close')}</Button>
          <Button variant="primary" disabled={busy || !mech || pool <= 0 || !!sk?.impossible || (!boxes && !Object.values(v.breakdowns || {}).some(Boolean))} onClick={go}>🔧 {t('Repair')}</Button>
        </div>
      </div>
    </div>
  </Overlay>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Electronic warfare (Rigger 5.0 p. 30) and target lock (SR5 p. 184)
// ---------------------------------------------------------------------------------------------------------------------

export function EwDialog({ game, rigger, v, onClose }: { game: GameView; rigger: Actor; v: Vehicle; onClose: () => void }) {
  const ui = useUI();
  const [action, setAction] = useState<EwActionId>('targetDevice');
  const def = EW_ACTION_DEFS[action];
  const rcc = rccRating(rigger);
  const [nr, setNr] = useState(0);
  const [modifier, setModifier] = useState(0);
  const map = attackMap(game);
  const tokens = (map?.tokens || []).filter((x) => x.actorId && !(x.actorId === rigger.id && !x.vehicleId) && (game.me?.role === 'gm' || !x.hidden));
  const pilots = tokens.filter((x) => {
    const a = x.actorId ? game.actors?.[x.actorId] : null;
    const veh = x.vehicleId && a && 'vehicles' in a ? (a.vehicles || []).find((y) => y.id === x.vehicleId) : null;
    return !!veh && (controlOf(veh) === 'auto' || controlOf(veh) === 'remote');
  });
  const choices = def.needsTarget === 'pilot' ? pilots : tokens;
  const [targetId, setTargetId] = useState(ui.targetTokenId && tokens.some((x) => x.id === ui.targetTokenId) ? ui.targetTokenId : '');
  const [lockId, setLockId] = useState('');
  // Locks on the rigger: what Detect Target Lock found (players), every lock on their tokens (GM).
  const [detected, setDetected] = useState<Array<{ id: string; vehicle: string; net: number }>>([]);
  const myTokens = new Set(Object.values(game.maps || {}).flatMap((m) => m.tokens || []).filter((x) => x.actorId === rigger.id).map((x) => x.id));
  const knownLocks = game.me?.role === 'gm' ? (game.rigging?.locks || []).filter((l) => myTokens.has(l.targetTokenId)).map((l) => ({ id: l.id, vehicle: l.vehicleName, net: l.net })) : detected;
  const [res, setRes] = useState<ShownRoll | null>(null);
  const [busy, setBusy] = useState(false);
  const dp = Number(rigger.matrix?.dataProcessing) || 0;
  const sk = skillPool(rigger, def.skillId, { attrOverride: def.attr });
  const go = async () => {
    setBusy(true);
    try {
      const r = await send<ShownRoll>('vehicle/ew', { actorId: rigger.id, action, noiseReduction: nr, modifier, ...(def.needsTarget === 'lock' ? { lockId } : {}), ...(def.needsTarget === 'pilot' || def.needsTarget === 'token' ? { targetTokenId: targetId } : {}) });
      setRes(r);
      if (action === 'detectLock' && r?.success) setDetected(r.locks || []);
      if (action === 'detectLock' && r) toast(r.success ? (r.locks?.length ? t('Locked by: {list}', { list: r.locks.map((l: { vehicle: string; net: number }) => `${l.vehicle} (${l.net})`).join(', ') }) : t('No target lock on you.')) : t('You detect nothing.'), r.success && r.locks?.length ? 'warn' : 'info');
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return <Overlay title={t('Electronic warfare — {name}', { name: rigger.name })} onClose={onClose} width={480}>
    <div className="col gap-s sh-veh-dialog">
      <div className="row wrap gap-s">
        <Select value={action} onChange={(x) => { setAction(x as EwActionId); setRes(null); }} options={EW_ACTIONS.map((id) => ({ value: id, label: `${t(EW_ACTION_DEFS[id].label)} (${t(EW_TYPE_LABELS[EW_ACTION_DEFS[id].type])})` }))} />
        <BookRef source="R5" page={30} />
      </div>
      <div className="faint small">{t(def.note)}{def.opposed ? ` ${t('Opposed by {what}.', { what: t(def.opposed) })}` : ''}{def.threshold ? ` ${t('Threshold {n}.', { n: def.threshold })}` : ''}</div>
      {!dp && <div className="error small">{t('{name} has no commlink, deck or RCC', { name: rigger.name })}</div>}
      {(def.needsTarget === 'pilot' || def.needsTarget === 'token') && <div className="row wrap gap-s">
        <span className="field-label">{t('Target')}</span>
        <Select value={targetId} onChange={setTargetId} options={[{ value: '', label: choices.length ? t('— none —') : t('— no token on the map —') }, ...choices.map((x) => ({ value: x.id, label: x.name }))]} />
      </div>}
      {def.needsTarget === 'lock' && <div className="row wrap gap-s">
        <span className="field-label">{t('Lock')}</span>
        {knownLocks.length
          ? <Select value={lockId} onChange={setLockId} options={[{ value: '', label: t('— none —') }, ...knownLocks.map((l) => ({ value: l.id, label: `${l.vehicle} (${l.net})` }))]} />
          : <span className="faint small">{t('Detect the lock first (Detect Target Lock).')}</span>}
      </div>}
      <div className="sh-rd-breakdown">
        <span className="sh-rd-part"><span>{t(skillKey(def.skillId))} + {attrShort(def.attr)}</span><b>{sk.pool}</b></span>
        {nr ? <span className="sh-rd-part mod"><span>{t('noise reduction')}</span><b>+{nr}</b></span> : null}
        {modifier ? <span className="sh-rd-part"><span>{t('mod.')}</span><b>{modifier > 0 ? '+' : ''}{modifier}</b></span> : null}
        <span className="sh-rd-total">{tn(Math.max(0, sk.pool + nr + modifier), '≈ {n} die', '≈ {n} dice')}</span>
      </div>
      {sk.impossible && <div className="error small">{t('Untrained skill: it can\'t be used by defaulting.')}</div>}
      <div className="small muted">{t('Limit')}: {t('Data Processing')} {dp}</div>
      <div className="row wrap gap-s">
        {rcc > 0 && <><span className="field-label">{t('RCC Noise Reduction')}</span><NumberInput small value={nr} min={0} max={rcc} onChange={setNr} /></>}
        <span className="field-label">{t('Edit')}</span>
        <NumberInput small value={modifier} min={-30} max={30} onChange={setModifier} />
      </div>
      {res && <div className="sh-rd-result">
        <div className="sh-rd-hits"><b>{res.hits}</b><span>{tn(res.hits ?? 0, 'one::hit', 'other::hits')}</span></div>
        <div className="grow col gap-s"><DiceFaces roll={res} /><RollBadges roll={res} />{res.net !== undefined ? <span className="small">{t('Net hits: {n}', { n: res.net })}</span> : null}</div>
      </div>}
      <div className="row spread">
        <span className="faint small">{v.name}</span>
        <div className="row">
          <Button variant="ghost" onClick={onClose}>{t('Close')}</Button>
          <Button variant="primary" disabled={busy || !dp || sk.impossible || ((def.needsTarget === 'pilot' || def.needsTarget === 'token') && !targetId) || (def.needsTarget === 'lock' && !lockId)} onClick={go}>{t('Roll')}</Button>
        </div>
      </div>
    </div>
  </Overlay>;
}
const EW_TYPE_LABELS: Record<string, string> = { free: tk('Free'), simple: tk('Simple'), complex: tk('Complex') };
