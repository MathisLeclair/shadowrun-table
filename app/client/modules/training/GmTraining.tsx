// GM side of « Progression »: pending requests, runners overview, downtime, workshop, history, settings.
import { useState } from 'react';
import { Panel, Tabs, Button, Empty, Badge, Field, Select, NumberInput, TextInput, Toggle, confirmAction } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { toast, openSheet, goTab } from '../../lib/ui-store.ts';
import { t, fmtNuyen, compare } from '../../lib/i18n.ts';
import { quote, RULE_TEXT } from '/shared/advancement.ts';
import AdvancePanel from './AdvancePanel.tsx';
import type { TrainingQuote } from './types.ts';
import { KarmaHeader, JobList, RequestList, ProgressBar, requestsOf, jobsOf, settingsOf, quoteContext, fmtDate, kindLabel, ruleText, fmtDays, labelOf, errorOf, fullActor } from './common.tsx';
import type { Actor, ActorId, GameView, I18nEntry, TrainingJob, TrainingRequest, TrainingSettings } from '../../../shared/types.ts';

/** Full actor sheets of the GM view (the GM never gets NPC stubs). */
const actorsOf = (game: GameView): Actor[] => Object.values(game.actors || {}).map(fullActor).filter((a): a is Actor => !!a);

const pcsOf = (game: GameView) =>
  actorsOf(game)
    .filter((a) => a && a.type === 'pc' && !a.retired)
    .sort((a, b) => compare(a.name, b.name));

/** Reply of 'training/advanceDays'. */
interface AdvanceResult {
  days: number;
  completed: Array<{ actorName: string; label?: string; labelI18n?: I18nEntry }>;
}

export default function GmTraining({ game }: GameProps) {
  const [tab, setTab] = useState('dash');
  const [workshopId, setWorkshopId] = useState<ActorId | null>(null);
  const pending = requestsOf(game).filter((r) => r.status === 'pending');
  const tabs = [
    { id: 'dash', label: t('Dashboard'), badge: pending.length || null },
    { id: 'workshop', label: t('Workshop') },
    { id: 'history', label: t('History') },
    { id: 'settings', label: t('Settings & rules') },
  ];
  const train = (id: ActorId) => {
    setWorkshopId(id);
    setTab('workshop');
  };
  return (
    <div className="page training-page">
      <div className="page-title">
        <h2>{t('Advancement')}</h2>
        <Tabs tabs={tabs} value={tab} onChange={setTab} className="training-gm-tabs" />
      </div>
      {tab === 'dash' && <Dashboard game={game} pending={pending} onTrain={train} />}
      {tab === 'workshop' && <Workshop game={game} actorId={workshopId} setActorId={setWorkshopId} />}
      {tab === 'history' && <History game={game} />}
      {tab === 'settings' && <Settings game={game} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function Dashboard({ game, pending, onTrain }: { game: GameView; pending: TrainingRequest[]; onTrain: (id: ActorId) => void }) {
  return (
    <div className="training-dash">
      <div className="col gap-l">
        <Panel title={pending.length ? t('Pending requests ({n})', { n: pending.length }) : t('Pending requests')}>
          {pending.length ? (
            <div className="col">
              {[...pending]
                .sort((a, b) => a.ts - b.ts)
                .map((r) => (
                  <PendingCard key={r.id} game={game} r={r} />
                ))}
            </div>
          ) : (
            <div className="muted small training-empty">{t('No requests. Runners can spend their karma from their Advancement tab.')}</div>
          )}
        </Panel>
        <Downtime game={game} />
      </div>
      <div className="col gap-l">
        <Runners game={game} onTrain={onTrain} />
        <KarmaReward game={game} />
      </div>
    </div>
  );
}

function PendingCard({ game, r }: { game: GameView; r: TrainingRequest }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const actor = fullActor(game.actors?.[r.actorId]);
  const recheck = actor ? (quote(actor, r.request || r, settingsOf(game), quoteContext(game, actor, r.id)) as TrainingQuote) : null;
  const resolve = async (approve: boolean) => {
    setBusy(true);
    try {
      const res = await send<{ status?: string }>('training/resolve', { requestId: r.id, approve, note });
      const label = labelOf(r);
      toast(approve ? (res?.status === 'done' ? t('{label}: gained', { label }) : t('{label}: training started', { label })) : t('Request denied'), approve ? 'success' : 'warn');
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="training-pending">
      <div className="row spread wrap gap-s">
        <span className="grow">
          <button className="training-link" onClick={() => actor && openSheet(actor.id)}>
            {actor?.name || t('Deleted character')}
          </button>
          <span className="faint small">
            {' '}
            · {kindLabel(r.kind)} · {fmtDate(r.ts)}
          </span>
        </span>
        {r.manual && (
          <Badge color="magenta" title={t('Manual entry: check the cost')}>
            {t('manual')}
          </Badge>
        )}
      </div>
      <div className="training-pending-label">{labelOf(r)}</div>
      <div className="row wrap small gap-s">
        <span className="mono amber">{t('{n} karma', { n: r.karmaCost })}</span>
        <span className="muted">{t('({n} available)', { n: Number(actor?.karma) || 0 })}</span>
        {r.days > 0 && <span>· {fmtDays(r.days)}</span>}
        {r.instructor && <span>· {t('instructor {cost}', { cost: fmtNuyen(r.nuyenCost) })}</span>}
        {(r.ppCost || 0) > 0 && <span>· {t('{pp} PP', { pp: r.ppCost })}</span>}
      </div>
      {r.note && <div className="small training-note">« {r.note} »</div>}
      {recheck?.error && <div className="training-warn small">⚠ {errorOf(recheck)}</div>}
      <div className="row wrap gap-s training-pending-actions">
        <div className="grow">
          <TextInput live value={note} placeholder={t('Note to the player (optional)')} onChange={setNote} />
        </div>
        <Button small variant="danger" disabled={busy} onClick={() => resolve(false)}>
          {t('Deny')}
        </Button>
        <Button small variant="primary" disabled={busy || !!recheck?.error} title={errorOf(recheck) || ''} onClick={() => resolve(true)}>
          {t('Approve')}
        </Button>
      </div>
    </div>
  );
}

function Downtime({ game }: GameProps) {
  const [custom, setCustom] = useState(3);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<AdvanceResult | null>(null);
  const elapsed = Number(game.training?.daysElapsed) || 0;
  const running: Array<{ actor: Actor; job: TrainingJob; left: number }> = [];
  for (const a of actorsOf(game)) for (const j of jobsOf(a)) running.push({ actor: a, job: j, left: Math.max(0, (j.daysTotal || 0) - (j.daysDone || 0)) });
  running.sort((x, y) => x.left - y.left);
  const next = running[0];
  const advance = async (days: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await send<AdvanceResult>('training/advanceDays', { days });
      setLast(res);
      const time = fmtDays(days);
      toast(
        res.completed.length ? t('Downtime: {time} — {n} training(s) completed', { time, n: res.completed.length }) : t('Downtime: {time}', { time }),
        res.completed.length ? 'success' : 'info'
      );
    } catch {}
    setBusy(false);
  };
  return (
    <Panel
      title={t('Downtime')}
      actions={
        <span className="small muted" title={t('Downtime days elapsed since tracking started')}>
          {t('Day {n}', { n: elapsed })}
        </span>
      }
    >
      <div className="small muted">{t('Moves the calendar forward: every training in progress advances, and finished ones are applied to the sheets.')}</div>
      <div className="row wrap training-downtime">
        <Button disabled={busy} onClick={() => advance(1)}>
          {t('+1 day')}
        </Button>
        <Button disabled={busy} onClick={() => advance(7)}>
          {t('+1 week')}
        </Button>
        <Button disabled={busy} onClick={() => advance(30)}>
          {t('+1 month')}
        </Button>
        <span className="row gap-s">
          <NumberInput small value={custom} min={1} max={365} onChange={setCustom} />
          <Button variant="primary" disabled={busy} onClick={() => advance(custom)}>
            {t('Advance')}
          </Button>
        </span>
      </div>
      {next ? (
        <div className="small">
          {t('{n} training(s) in progress · next:', { n: running.length })} <strong>{next.actor.name}</strong> — {labelOf(next.job)}{' '}
          <span className="muted">{t('(in {time})', { time: fmtDays(next.left) })}</span>
        </div>
      ) : (
        <div className="small muted">{t('No training in progress.')}</div>
      )}
      {last && (
        <div className="training-last">
          <div className="small">
            <strong>{fmtDays(last.days)}</strong> {last.completed.length ? t('elapsed — {n} completed:', { n: last.completed.length }) : t('elapsed — nothing completed.')}
          </div>
          {last.completed.length > 0 && (
            <ul className="small">
              {last.completed.map((c, i) => (
                <li key={i}>
                  <span className="cyan">{c.actorName}</span> : {labelOf(c)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

function Runners({ game, onTrain }: { game: GameView; onTrain: (id: ActorId) => void }) {
  const pcs = pcsOf(game);
  const npcsTraining = actorsOf(game).filter((a) => a && a.type !== 'pc' && jobsOf(a).length);
  const list = [...pcs, ...npcsTraining];
  return (
    <Panel
      title={t('Runners')}
      actions={
        <Button small variant="ghost" title={t('Sheets, karma and nuyen')} onClick={() => goTab('characters')}>
          {t('Characters →')}
        </Button>
      }
    >
      {list.length ? (
        <div className="col">
          {list.map((a) => {
            const jobs = jobsOf(a);
            const pend = requestsOf(game, a.id).filter((r) => r.status === 'pending').length;
            return (
              <div key={a.id} className="training-runner">
                <div className="row spread wrap gap-s">
                  <button className="training-link" onClick={() => openSheet(a.id)}>
                    <strong>{a.name}</strong>
                  </button>
                  <span className="row gap-s small">
                    {pend > 0 && <Badge color="amber">{t('{n} pending', { n: pend })}</Badge>}
                    <span className="mono" title={t('Available / career karma')}>
                      <span className="cyan">{Number(a.karma) || 0}</span>
                      <span className="faint"> / {t('{n} karma', { n: Number(a.karmaTotal) || 0 })}</span>
                    </span>
                    <span className="mono magenta">{fmtNuyen(a.nuyen)}</span>
                    <Button small onClick={() => onTrain(a.id)}>
                      {t('Train')}
                    </Button>
                  </span>
                </div>
                {jobs.map((j) => (
                  <div key={j.id} className="training-runner-job">
                    <span className="small grow">{labelOf(j)}</span>
                    <span className="small mono muted">{t('{done}/{total} d', { done: j.daysDone || 0, total: j.daysTotal })}</span>
                    <ProgressBar value={j.daysDone || 0} max={j.daysTotal || 0} compact />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>{t('No active runners.')}</Empty>
      )}
    </Panel>
  );
}

/** Quick end-of-run karma reward (characters module action 'actor/adjust'). */
function KarmaReward({ game }: GameProps) {
  const pcs = pcsOf(game);
  const [karma, setKarma] = useState(3);
  const [reason, setReason] = useState('');
  const [excluded, setExcluded] = useState<ActorId[]>([]);
  const [busy, setBusy] = useState(false);
  const targets = pcs.filter((a) => !excluded.includes(a.id));
  const give = async () => {
    if (!targets.length || !karma) return;
    if (!(await confirmAction(t('Give {n} karma to {names}?', { n: karma, names: targets.map((a) => a.name).join(', ') })))) return;
    setBusy(true);
    try {
      await send('actor/adjust', { actorIds: targets.map((a) => a.id), karma, reason: reason.trim() || t('Run reward') });
      toast(t('{n} karma awarded', { n: karma }), 'success');
      setReason('');
    } catch {}
    setBusy(false);
  };
  if (!pcs.length) return null;
  return (
    <Panel title={t('Karma reward')}>
      <div className="row wrap gap-s">
        {pcs.map((a) => (
          <Toggle key={a.id} label={a.name} value={!excluded.includes(a.id)} onChange={(v) => setExcluded((ex) => (v ? ex.filter((x) => x !== a.id) : [...ex, a.id]))} />
        ))}
      </div>
      <div className="row wrap training-reward">
        <NumberInput value={karma} min={-50} max={100} onChange={setKarma} />
        <div className="grow">
          <TextInput live value={reason} placeholder={t('Reason (e.g. Run « Cleanup Crew »)')} onChange={setReason} />
        </div>
        <Button variant="accent" disabled={busy || !targets.length || !karma} onClick={give}>
          {t('Give')}
        </Button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
function Workshop({ game, actorId, setActorId }: { game: GameView; actorId: ActorId | null; setActorId: (id: ActorId) => void }) {
  const all = actorsOf(game).filter(Boolean);
  const pcs = all.filter((a) => a.type === 'pc').sort((a, b) => compare(a.name, b.name));
  const npcs = all.filter((a) => a.type !== 'pc').sort((a, b) => compare(a.name, b.name));
  const id = actorId && game.actors?.[actorId] ? actorId : pcs.find((a) => !a.retired)?.id || pcs[0]?.id || npcs[0]?.id || '';
  const actor = id ? fullActor(game.actors[id]) : null;
  const options = [
    ...pcs.map((a) => ({ value: a.id, label: a.retired ? t('{name} (retired)', { name: a.name }) : a.name })),
    ...npcs.map((a) => ({ value: a.id, label: t('NPC · {name}', { name: a.name }) })),
  ];
  if (!actor) return <Empty>{t('No characters. Create or import sheets in the Characters tab.')}</Empty>;
  return (
    <div className="col gap-l">
      <div className="row wrap spread">
        <div className="row wrap">
          <Field label={t('Character')}>
            <Select value={id} onChange={setActorId} options={options} />
          </Field>
          <Button small variant="ghost" onClick={() => openSheet(actor.id)}>
            {t('Open the sheet')}
          </Button>
        </div>
        <KarmaHeader game={game} actor={actor} />
      </div>
      <div className="small muted">
        {t('GM workshop: everything you approve here is applied directly (karma spent, training started). Tick « Granted » in the confirmation for a free gain.')}
      </div>
      <div className="training-layout">
        <Panel title={t('Advancement of {name}', { name: actor.name })}>
          <AdvancePanel game={game} actor={actor} isGM={true} />
        </Panel>
        <div className="col gap-l training-side">
          <Panel title={t('In progress')}>
            <JobList game={game} actor={actor} isGM={true} />
          </Panel>
          <Panel title={t('Requests')}>
            <RequestList game={game} requests={requestsOf(game, actor.id)} isGM={true} limit={20} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function History({ game }: GameProps) {
  const [actorId, setActorId] = useState('');
  const [status, setStatus] = useState('');
  const all = requestsOf(game);
  const list = all.filter((r) => (!actorId || r.actorId === actorId) && (!status || r.status === status));
  const actorIds = [...new Set(all.map((r) => r.actorId))];
  const closed = all.filter((r) => !['pending', 'approved'].includes(r.status) && (!actorId || r.actorId === actorId)).length;
  const clear = async () => {
    const name = actorId ? game.actors?.[actorId]?.name : '';
    const msg = !actorId
      ? t('Delete the {n} closed request(s) (gained, denied, cancelled) of all characters?\nSheets are not changed.', { n: closed })
      : name
        ? t('Delete the {n} closed request(s) (gained, denied, cancelled) of {name}?\nSheets are not changed.', { n: closed, name })
        : t('Delete the {n} closed request(s) (gained, denied, cancelled) of this character?\nSheets are not changed.', { n: closed });
    if (!(await confirmAction(msg))) return;
    send<{ removed: number }>('training/clearHistory', actorId ? { actorId } : {})
      .then((r) => toast(t('{n} request(s) deleted', { n: r.removed })))
      .catch(() => {});
  };
  return (
    <Panel
      title={t('Request history')}
      actions={
        <Button small variant="ghost" disabled={!closed} onClick={clear}>
          {t('Purge closed requests')}
        </Button>
      }
    >
      <div className="row wrap training-toolbar">
        <Select
          value={actorId}
          onChange={setActorId}
          options={[{ value: '', label: t('All characters') }, ...actorIds.map((id) => ({ value: id, label: game.actors?.[id]?.name || t('(deleted)') }))]}
        />
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: t('All statuses') },
            { value: 'pending', label: t('Pending') },
            { value: 'approved', label: t('In progress') },
            { value: 'done', label: t('pl::Gained') },
            { value: 'denied', label: t('pl::Denied') },
            { value: 'cancelled', label: t('pl::Cancelled') },
          ]}
        />
      </div>
      <RequestList game={game} requests={list} isGM={true} showActor={true} limit={150} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
type SettingsPatch = Partial<Omit<TrainingSettings, 'instructorCostPerWeek'>> & { instructorCostPerWeek?: Partial<TrainingSettings['instructorCostPerWeek']> };

function Settings({ game }: GameProps) {
  const s = settingsOf(game);
  const update = (patch: SettingsPatch) => send('training/updateSettings', patch).catch(() => {});
  const price = (k: keyof TrainingSettings['instructorCostPerWeek']) => (n: number) => update({ instructorCostPerWeek: { [k]: n } });
  return (
    <div className="grid-2">
      <Panel title={t('Settings')}>
        <div className="col gap-l">
          <Field label={t('Request approval')} hint={t('In automatic mode, manual entries (not from the catalog) and « Other » still go through you.')}>
            <Select
              value={s.approval}
              onChange={(v) => update({ approval: v })}
              options={[
                { value: 'always' as const, label: t('The GM approves every request') },
                { value: 'never' as const, label: t('Automatic') },
              ]}
            />
          </Field>
          <div className="col gap-s">
            <Toggle label={t('Training time (downtime)')} value={s.useTime} onChange={(v) => update({ useTime: v })} />
            <span className="field-hint">{s.useTime ? t('Approved advancements take time: move the calendar forward in « Downtime ».') : t('Approved advancements apply immediately.')}</span>
          </div>
          <Field label={t('Instructor: time reduction (%)')} hint={t('SR5: each hit on the Instruction test reduces the time. Here, a fixed reduction.')}>
            <NumberInput value={s.instructorTimeReduction} min={0} max={90} step={5} onChange={(n) => update({ instructorTimeReduction: n })} />
          </Field>
          <div className="field">
            <span className="field-label">{t('Instructor: price per week (¥)')}</span>
            <div className="training-prices">
              <span>{t('Attributes')}</span>
              <NumberInput value={s.instructorCostPerWeek.attribute} min={0} max={100000} step={100} onChange={price('attribute')} />
              <span>{t('Skills & groups')}</span>
              <NumberInput value={s.instructorCostPerWeek.skill} min={0} max={100000} step={50} onChange={price('skill')} />
              <span>{t('Knowledge & languages')}</span>
              <NumberInput value={s.instructorCostPerWeek.knowledge} min={0} max={100000} step={50} onChange={price('knowledge')} />
              <span>{t('Other (qualities, magic…)')}</span>
              <NumberInput value={s.instructorCostPerWeek.other} min={0} max={100000} step={50} onChange={price('other')} />
            </div>
          </div>
        </div>
      </Panel>
      <Panel title={t('SR5 rules applied')}>
        <ul className="training-rules">
          {Object.keys(RULE_TEXT).map((k) => (
            <li key={k}>
              <strong>{k === 'instructor' ? t('Instructor') : kindLabel(k)}</strong>
              <div className="small muted">{ruleText(k).replace(/^[^:]+ ?: /, '')}</div>
            </li>
          ))}
          <li>
            <strong>{t('Limits')}</strong>
            <div className="small muted">
              {t(
                'Attributes: metatype maximum (+1 with Exceptional Attribute, +1 Edge with Lucky). Magic/Resonance: 6 + grade − Essence lost (rounded up). Skills: 12 (13 with Aptitude). One attribute at a time; no two trainings on the same thing.'
              )}
            </div>
          </li>
          <li>
            <strong>{t('Karma')}</strong>
            <div className="small muted">{t('Spent on approval; a pending request reserves its karma. Interrupting a training (GM) refunds karma and instructor.')}</div>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
