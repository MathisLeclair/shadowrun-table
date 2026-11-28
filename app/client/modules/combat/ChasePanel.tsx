// Chase Combat tracker (Initiative dock, SR5 p. 203-205): environment and terrain of the Combat Turn, the quarry and the
// pursuers' Chase Ranges, Chase Actions for the drivers, the Vehicle Tests they owe, the chase history.
// Server: server/modules/34-vehicles.ts (chase/*). Initiative itself stays on the tracker below.
import { useState } from 'react';
import { Button, NumberInput, Select, Toggle, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t, tk } from '../../lib/i18n.ts';
import {
  CHASE_ACTIONS, CHASE_ACTION_LABELS, CHASE_RANGES, CHASE_RANGE_LABELS, CHASE_RANGE_METERS, TERRAINS, chaseActionNeedsShort, controlOf, vehicleDestroyed,
  type ChaseActionId,
} from '/shared/vehicles.ts';
import { BookRef } from '../books/BookRef.tsx';
import type { Actor, ChaseEnvironment, ChaseRange, ChaseVehicle, GameView, Vehicle } from '../../../shared/types.ts';

const act = (type: string, payload: object = {}) => send(type, payload).catch(() => null);
const sheet = (game: GameView, id: string | null | undefined): Actor | null => {
  const a = id ? game.actors?.[id] : null;
  return a && 'attributes' in a ? a : null;
};
const ENV_LABEL: Record<ChaseEnvironment, string> = { speed: tk('Speed'), handling: tk('Handling') };

/** Can the user drive this chase vehicle (GM, the owner's or the driver's player)? */
function canDrive(game: GameView, cv: ChaseVehicle): boolean {
  if (game.me?.role === 'gm') return true;
  const own = game.me?.characterIds || [];
  if (own.includes(cv.actorId)) return true;
  const v = sheet(game, cv.actorId)?.vehicles?.find((x) => x.id === cv.vehicleId);
  return !!v?.driverId && own.includes(v.driverId);
}

export default function ChasePanel({ game }: { game: GameView }) {
  const gm = game.me?.role === 'gm';
  const c = game.chase;
  const [setup, setSetup] = useState(false);
  if (!c?.active) {
    if (!gm) return null;
    return setup ? <ChaseSetup game={game} onClose={() => setSetup(false)} /> : <div className="row gap-s"><Button small variant="ghost" onClick={() => setSetup(true)} title={t('Chase Combat between vehicles (SR5 p. 203)')}>🏁 {t('Start a chase')}</Button></div>;
  }
  const quarry = c.vehicles.filter((x) => x.role === 'quarry');
  const pursuers = c.vehicles.filter((x) => x.role === 'pursuer');
  const end = async () => {
    if (await confirmAction(t('End the chase?'))) act('chase/end');
  };
  return <div className="chase">
    <div className="chase-head">
      <strong>🏁 {t('Chase — turn {n}', { n: c.round })}</strong>
      <BookRef source="SR5" page={203} />
      {gm ? <div className="row gap-s">
        <Select value={c.environment} onChange={(e) => act('chase/update', { environment: e })} options={(['speed', 'handling'] as ChaseEnvironment[]).map((e) => ({ value: e, label: t('{env} environment', { env: t(ENV_LABEL[e]) }) }))} />
        <Select value={String(c.terrain)} onChange={(x) => act('chase/update', { terrain: Number(x) })} options={TERRAINS.map((x) => ({ value: String(x.value), label: `${t(x.label)} +${x.value}` }))} />
        <Button small onClick={() => act('chase/round')}>{t('Next turn')}</Button>
        <Button small variant="ghost" onClick={end}>✕</Button>
      </div> : <span className="faint small">{t('{env} environment', { env: t(ENV_LABEL[c.environment]) })} · {t('terrain +{n}', { n: c.terrain })}</span>}
    </div>
    <div className="faint small">{c.environment === 'speed' ? t('Speed environment: tests limited by Speed.') : t('Handling environment: tests limited by Handling.')}</div>
    {quarry.map((cv) => <ChaseRow key={cv.id} game={game} cv={cv} />)}
    {pursuers.map((cv) => <ChaseRow key={cv.id} game={game} cv={cv} />)}
    {(c.pending || []).length > 0 && <div className="chase-pending">
      {c.pending.map((p) => {
        const cv = c.vehicles.find((x) => x.id === p.chaseVehicleId);
        if (!cv) return null;
        return <div className="row wrap gap-s" key={p.id}>
          <span className="grow small"><b>{cv.name}</b>: {t('Vehicle Test ({n})', { n: p.threshold })} — {t(p.reason.t, p.reason.params)} · <span className="faint">{p.onFail === 'crash' ? t('failure: crash') : p.onFail === 'fallBack' ? t('failure: falls back') : t('failure: out of control')}</span></span>
          {canDrive(game, cv) && <Button small variant="primary" onClick={() => act('chase/resolve', { pendingId: p.id })}>🎲 {t('Roll')}</Button>}
          {gm && <Button small variant="ghost" onClick={() => act('chase/dismiss', { pendingId: p.id })}>✕</Button>}
        </div>;
      })}
    </div>}
    {(c.events || []).length > 0 && <div className="chase-events">
      {c.events.slice(0, 5).map((e) => <div key={e.id} className="small faint">{t(e.text.t, e.text.params)}</div>)}
    </div>}
  </div>;
}

function ChaseRow({ game, cv }: { game: GameView; cv: ChaseVehicle }) {
  const gm = game.me?.role === 'gm';
  const c = game.chase!;
  const owner = sheet(game, cv.actorId);
  const v: Vehicle | undefined = owner?.vehicles?.find((x) => x.id === cv.vehicleId);
  const mine = canDrive(game, cv);
  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState(1);
  const [action, setAction] = useState<ChaseActionId>(cv.role === 'quarry' ? 'breakAway' : 'catchUp');
  const others = c.vehicles.filter((x) => x.id !== cv.id && x.role !== cv.role && !x.crashed);
  const [targetId, setTargetId] = useState('');
  const range = (x: ChaseVehicle) => (x.role === 'pursuer' ? x.range || 'medium' : null);
  const shortWith = (x: ChaseVehicle) => (cv.role === 'pursuer' ? range(cv) === 'short' && x.role === 'quarry' : range(x) === 'short');
  const actions = CHASE_ACTIONS.filter((a) => a !== 'stunt' || cv.role === 'quarry');
  const needsTarget = chaseActionNeedsShort(action);
  const targets = needsTarget ? others.filter(shortWith) : cv.role === 'quarry' ? others : [];
  const go = () => act('chase/action', { id: cv.id, action, threshold, ...(targetId && targets.some((x) => x.id === targetId) ? { targetId } : {}) });
  const flag = (k: 'uncontrolled' | 'lost' | 'crashed' | 'hidden', label: string, cls: string) => (cv[k] ? <span className={'badge ' + cls}>{t(label)}</span> : null);
  return <div className={'chase-row' + (cv.role === 'quarry' ? ' quarry' : '') + (cv.crashed || cv.lost ? ' out' : '')}>
    <div className="row wrap gap-s">
      <span className="grow"><b>{cv.name}</b> <span className="faint small">{owner?.name}{v ? ` · ${controlOf(v) === 'auto' ? t('Autopilot') : t('Driven')}` : ''}</span></span>
      {cv.role === 'quarry' ? <span className="badge badge-amber">{t('quarry')}</span> : null}
      {flag('uncontrolled', tk('out of control'), 'badge-red')}{flag('lost', tk('lost'), 'badge-dim')}{flag('crashed', tk('crashed'), 'badge-red')}{flag('hidden', tk('hidden'), 'badge-dim')}
      {v && vehicleDestroyed(v) ? <span className="badge badge-red">{t('destroyed')}</span> : null}
      {(mine || gm) && !cv.crashed && <Button small variant={open ? 'accent' : 'ghost'} onClick={() => setOpen(!open)}>{t('Act')}</Button>}
    </div>
    {cv.role === 'pursuer' && <div className="chase-ranges">
      {CHASE_RANGES.map((r: ChaseRange) => <button key={r} type="button" disabled={!gm} className={'chase-range' + (range(cv) === r && !cv.lost ? ' on' : '')}
        onClick={() => act('chase/set', { id: cv.id, patch: { range: r, lost: false } })} title={`${CHASE_RANGE_METERS[c.environment][r]} m`}>{t(CHASE_RANGE_LABELS[r])}</button>)}
    </div>}
    {gm && open && <div className="row wrap gap-s small">
      <Toggle value={!!cv.uncontrolled} onChange={(on) => act('chase/set', { id: cv.id, patch: { uncontrolled: on } })} label={t('out of control')} />
      <Toggle value={!!cv.crashed} onChange={(on) => act('chase/set', { id: cv.id, patch: { crashed: on } })} label={t('crashed')} />
      {cv.role === 'pursuer' && <Toggle value={!!cv.lost} onChange={(on) => act('chase/set', { id: cv.id, patch: { lost: on } })} label={t('lost')} />}
      <Toggle value={!!cv.hidden} onChange={(on) => act('chase/set', { id: cv.id, patch: { hidden: on } })} label={t('hidden')} />
      <Button small variant="ghost" onClick={() => act('vehicle/crash', { actorId: cv.actorId, vehicleId: cv.vehicleId })}>{t('Crash')}</Button>
      <Button small variant="ghost" onClick={() => act('chase/remove', { id: cv.id })}>{t('Remove')}</Button>
    </div>}
    {open && mine && !cv.crashed && <div className="row wrap gap-s chase-act">
      <Select value={action} onChange={(a) => setAction(a as ChaseActionId)} options={actions.map((a) => ({ value: a, label: t(CHASE_ACTION_LABELS[a]) + (chaseActionNeedsShort(a) ? ` (${t(CHASE_RANGE_LABELS.short)})` : '') }))} />
      {!needsTarget && <><span className="faint small">{t('Threshold')}</span><NumberInput small value={threshold} min={0} max={8} onChange={setThreshold} /><span className="faint small">+{c.terrain}</span></>}
      {targets.length > 0 && <Select value={targetId} onChange={setTargetId} options={[...(needsTarget ? [] : [{ value: '', label: t('all pursuers') }]), ...targets.map((x) => ({ value: x.id, label: x.name }))]} />}
      <Button small variant="primary" disabled={needsTarget && !targets.length} onClick={go} title={needsTarget && !targets.length ? t('Short range only') : undefined}>🎲 {t('Go')}</Button>
    </div>}
  </div>;
}

/** GM: who is in the chase, as quarry or pursuer, at which range. */
function ChaseSetup({ game, onClose }: { game: GameView; onClose: () => void }) {
  const [env, setEnv] = useState<ChaseEnvironment>('speed');
  const [terrain, setTerrain] = useState(0);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const list: Array<{ key: string; owner: Actor; v: Vehicle }> = [];
  for (const a of Object.values(game.actors || {})) {
    if (!a || !('attributes' in a)) continue;
    for (const v of a.vehicles || []) if (v) list.push({ key: `${a.id}:${v.id}`, owner: a, v });
  }
  const start = () => {
    const vehicles = list.filter((x) => roles[x.key]).map((x) => ({ actorId: x.owner.id, vehicleId: x.v.id, role: roles[x.key] === 'quarry' ? 'quarry' : 'pursuer', range: roles[x.key] === 'quarry' ? undefined : roles[x.key] }));
    act('chase/start', { environment: env, terrain, vehicles }).then((r) => r && onClose());
  };
  return <div className="chase">
    <div className="chase-head"><strong>🏁 {t('New chase')}</strong><BookRef source="SR5" page={203} /></div>
    <div className="row wrap gap-s">
      <Select value={env} onChange={(e) => setEnv(e as ChaseEnvironment)} options={(['speed', 'handling'] as ChaseEnvironment[]).map((e) => ({ value: e, label: t('{env} environment', { env: t(ENV_LABEL[e]) }) }))} />
      <Select value={String(terrain)} onChange={(x) => setTerrain(Number(x))} options={TERRAINS.map((x) => ({ value: String(x.value), label: `${t(x.label)} +${x.value}` }))} />
    </div>
    {!list.length && <div className="muted small">{t('No vehicle on any sheet.')}</div>}
    {list.map((x) => <div className="chase-setup-row" key={x.key}>
      <span className="small"><b>{x.v.name}</b><br /><span className="faint">{x.owner.name}</span></span>
      <Select value={roles[x.key] || ''} onChange={(r) => setRoles({ ...roles, [x.key]: r })} options={[
        { value: '', label: t('— not in it —') }, { value: 'quarry', label: t('quarry') },
        ...CHASE_RANGES.map((r) => ({ value: r, label: t('pursuer · {range}', { range: t(CHASE_RANGE_LABELS[r]) }) })),
      ]} />
    </div>)}
    <div className="row spread">
      <Button small variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
      <Button small variant="primary" disabled={!Object.values(roles).some(Boolean)} onClick={start}>{t('Start the chase')}</Button>
    </div>
  </div>;
}
