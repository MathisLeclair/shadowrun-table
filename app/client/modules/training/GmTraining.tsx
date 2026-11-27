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
    { id: 'dash', label: t('Tableau de bord'), badge: pending.length || null },
    { id: 'workshop', label: t('Atelier') },
    { id: 'history', label: t('Historique') },
    { id: 'settings', label: t('Réglages & règles') },
  ];
  const train = (id: ActorId) => {
    setWorkshopId(id);
    setTab('workshop');
  };
  return (
    <div className="page training-page">
      <div className="page-title">
        <h2>{t('Progression')}</h2>
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
        <Panel title={pending.length ? t('Demandes en attente ({n})', { n: pending.length }) : t('Demandes en attente')}>
          {pending.length ? (
            <div className="col">
              {[...pending]
                .sort((a, b) => a.ts - b.ts)
                .map((r) => (
                  <PendingCard key={r.id} game={game} r={r} />
                ))}
            </div>
          ) : (
            <div className="muted small training-empty">{t('Aucune demande. Les runners peuvent dépenser leur karma depuis leur onglet Progression.')}</div>
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
      toast(approve ? (res?.status === 'done' ? t('{label} : acquis', { label }) : t('{label} : entraînement lancé', { label })) : t('Demande refusée'), approve ? 'success' : 'warn');
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="training-pending">
      <div className="row spread wrap gap-s">
        <span className="grow">
          <button className="training-link" onClick={() => actor && openSheet(actor.id)}>
            {actor?.name || t('Personnage supprimé')}
          </button>
          <span className="faint small">
            {' '}
            · {kindLabel(r.kind)} · {fmtDate(r.ts)}
          </span>
        </span>
        {r.manual && (
          <Badge color="magenta" title={t('Saisie manuelle : vérifie le coût')}>
            {t('manuel')}
          </Badge>
        )}
      </div>
      <div className="training-pending-label">{labelOf(r)}</div>
      <div className="row wrap small gap-s">
        <span className="mono amber">{t('{n} karma', { n: r.karmaCost })}</span>
        <span className="muted">{t('(dispo {n})', { n: Number(actor?.karma) || 0 })}</span>
        {r.days > 0 && <span>· {fmtDays(r.days)}</span>}
        {r.instructor && <span>· {t('instructeur {cost}', { cost: fmtNuyen(r.nuyenCost) })}</span>}
        {(r.ppCost || 0) > 0 && <span>· {t('{pp} PP', { pp: r.ppCost })}</span>}
      </div>
      {r.note && <div className="small training-note">« {r.note} »</div>}
      {recheck?.error && <div className="training-warn small">⚠ {errorOf(recheck)}</div>}
      <div className="row wrap gap-s training-pending-actions">
        <div className="grow">
          <TextInput live value={note} placeholder={t('Note au joueur (optionnel)')} onChange={setNote} />
        </div>
        <Button small variant="danger" disabled={busy} onClick={() => resolve(false)}>
          {t('Refuser')}
        </Button>
        <Button small variant="primary" disabled={busy || !!recheck?.error} title={errorOf(recheck) || ''} onClick={() => resolve(true)}>
          {t('Valider')}
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
        res.completed.length ? t('Temps mort : {time} — {n} entraînement(s) terminé(s)', { time, n: res.completed.length }) : t('Temps mort : {time}', { time }),
        res.completed.length ? 'success' : 'info'
      );
    } catch {}
    setBusy(false);
  };
  return (
    <Panel
      title={t('Temps mort')}
      actions={
        <span className="small muted" title={t('Jours de temps mort écoulés depuis le début du suivi')}>
          {t('Jour {n}', { n: elapsed })}
        </span>
      }
    >
      <div className="small muted">{t('Fait avancer le calendrier : tous les entraînements en cours progressent, ceux qui sont terminés s’appliquent aux fiches.')}</div>
      <div className="row wrap training-downtime">
        <Button disabled={busy} onClick={() => advance(1)}>
          {t('+1 jour')}
        </Button>
        <Button disabled={busy} onClick={() => advance(7)}>
          {t('+1 semaine')}
        </Button>
        <Button disabled={busy} onClick={() => advance(30)}>
          {t('+1 mois')}
        </Button>
        <span className="row gap-s">
          <NumberInput small value={custom} min={1} max={365} onChange={setCustom} />
          <Button variant="primary" disabled={busy} onClick={() => advance(custom)}>
            {t('Avancer')}
          </Button>
        </span>
      </div>
      {next ? (
        <div className="small">
          {t('{n} entraînement(s) en cours · prochain :', { n: running.length })} <strong>{next.actor.name}</strong> — {labelOf(next.job)}{' '}
          <span className="muted">{t('(dans {time})', { time: fmtDays(next.left) })}</span>
        </div>
      ) : (
        <div className="small muted">{t('Aucun entraînement en cours.')}</div>
      )}
      {last && (
        <div className="training-last">
          <div className="small">
            <strong>{fmtDays(last.days)}</strong> {last.completed.length ? t('écoulé(s) — {n} terminé(s) :', { n: last.completed.length }) : t('écoulé(s) — rien de terminé.')}
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
        <Button small variant="ghost" title={t('Fiches, karma et nuyens')} onClick={() => goTab('characters')}>
          {t('Personnages →')}
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
                    {pend > 0 && <Badge color="amber">{t('{n} en attente', { n: pend })}</Badge>}
                    <span className="mono" title={t('Karma disponible / carrière')}>
                      <span className="cyan">{Number(a.karma) || 0}</span>
                      <span className="faint"> / {t('{n} karma', { n: Number(a.karmaTotal) || 0 })}</span>
                    </span>
                    <span className="mono magenta">{fmtNuyen(a.nuyen)}</span>
                    <Button small onClick={() => onTrain(a.id)}>
                      {t('Entraîner')}
                    </Button>
                  </span>
                </div>
                {jobs.map((j) => (
                  <div key={j.id} className="training-runner-job">
                    <span className="small grow">{labelOf(j)}</span>
                    <span className="small mono muted">{t('{done}/{total} j', { done: j.daysDone || 0, total: j.daysTotal })}</span>
                    <ProgressBar value={j.daysDone || 0} max={j.daysTotal || 0} compact />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>{t('Aucun runner actif.')}</Empty>
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
    if (!(await confirmAction(t('Donner {n} karma à {names} ?', { n: karma, names: targets.map((a) => a.name).join(', ') })))) return;
    setBusy(true);
    try {
      await send('actor/adjust', { actorIds: targets.map((a) => a.id), karma, reason: reason.trim() || t('Récompense de run') });
      toast(t('{n} karma distribués', { n: karma }), 'success');
      setReason('');
    } catch {}
    setBusy(false);
  };
  if (!pcs.length) return null;
  return (
    <Panel title={t('Récompense de karma')}>
      <div className="row wrap gap-s">
        {pcs.map((a) => (
          <Toggle key={a.id} label={a.name} value={!excluded.includes(a.id)} onChange={(v) => setExcluded((ex) => (v ? ex.filter((x) => x !== a.id) : [...ex, a.id]))} />
        ))}
      </div>
      <div className="row wrap training-reward">
        <NumberInput value={karma} min={-50} max={100} onChange={setKarma} />
        <div className="grow">
          <TextInput live value={reason} placeholder={t('Raison (ex. Run « Cleanup Crew »)')} onChange={setReason} />
        </div>
        <Button variant="accent" disabled={busy || !targets.length || !karma} onClick={give}>
          {t('Donner')}
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
    ...pcs.map((a) => ({ value: a.id, label: a.retired ? t('{name} (retraité)', { name: a.name }) : a.name })),
    ...npcs.map((a) => ({ value: a.id, label: t('PNJ · {name}', { name: a.name }) })),
  ];
  if (!actor) return <Empty>{t('Aucun personnage. Crée ou importe des fiches dans l’onglet Personnages.')}</Empty>;
  return (
    <div className="col gap-l">
      <div className="row wrap spread">
        <div className="row wrap">
          <Field label={t('Personnage')}>
            <Select value={id} onChange={setActorId} options={options} />
          </Field>
          <Button small variant="ghost" onClick={() => openSheet(actor.id)}>
            {t('Ouvrir la fiche')}
          </Button>
        </div>
        <KarmaHeader game={game} actor={actor} />
      </div>
      <div className="small muted">
        {t('Atelier MJ : tout ce que tu valides ici est appliqué directement (karma débité, entraînement lancé). Coche « Offert » dans la confirmation pour un gain sans coût.')}
      </div>
      <div className="training-layout">
        <Panel title={t('Progression de {name}', { name: actor.name })}>
          <AdvancePanel game={game} actor={actor} isGM={true} />
        </Panel>
        <div className="col gap-l training-side">
          <Panel title={t('En cours')}>
            <JobList game={game} actor={actor} isGM={true} />
          </Panel>
          <Panel title={t('Demandes')}>
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
      ? t('Effacer les {n} demande(s) closes (acquises, refusées, annulées) de tous les personnages ?\nLes fiches ne sont pas modifiées.', { n: closed })
      : name
        ? t('Effacer les {n} demande(s) closes (acquises, refusées, annulées) de {name} ?\nLes fiches ne sont pas modifiées.', { n: closed, name })
        : t('Effacer les {n} demande(s) closes (acquises, refusées, annulées) de ce personnage ?\nLes fiches ne sont pas modifiées.', { n: closed });
    if (!(await confirmAction(msg))) return;
    send<{ removed: number }>('training/clearHistory', actorId ? { actorId } : {})
      .then((r) => toast(t('{n} demande(s) effacée(s)', { n: r.removed })))
      .catch(() => {});
  };
  return (
    <Panel
      title={t('Historique des demandes')}
      actions={
        <Button small variant="ghost" disabled={!closed} onClick={clear}>
          {t('Purger les demandes closes')}
        </Button>
      }
    >
      <div className="row wrap training-toolbar">
        <Select
          value={actorId}
          onChange={setActorId}
          options={[{ value: '', label: t('Tous les personnages') }, ...actorIds.map((id) => ({ value: id, label: game.actors?.[id]?.name || t('(supprimé)') }))]}
        />
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: t('Tous les statuts') },
            { value: 'pending', label: t('En attente') },
            { value: 'approved', label: t('En cours') },
            { value: 'done', label: t('Acquises') },
            { value: 'denied', label: t('Refusées') },
            { value: 'cancelled', label: t('Annulées') },
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
      <Panel title={t('Réglages')}>
        <div className="col gap-l">
          <Field label={t('Validation des demandes')} hint={t('En automatique, les saisies manuelles (hors catalogue) et « Autre » passent quand même par toi.')}>
            <Select
              value={s.approval}
              onChange={(v) => update({ approval: v })}
              options={[
                { value: 'always' as const, label: t('Le MJ valide chaque demande') },
                { value: 'never' as const, label: t('Automatique') },
              ]}
            />
          </Field>
          <div className="col gap-s">
            <Toggle label={t('Temps d’entraînement (temps mort)')} value={s.useTime} onChange={(v) => update({ useTime: v })} />
            <span className="field-hint">{s.useTime ? t('Les progressions validées prennent du temps : avance le calendrier dans « Temps mort ».') : t('Les progressions validées s’appliquent immédiatement.')}</span>
          </div>
          <Field label={t('Instructeur : réduction du temps (%)')} hint={t('SR5 : chaque succès au test d’Enseignement réduit le temps. Ici une réduction fixe.')}>
            <NumberInput value={s.instructorTimeReduction} min={0} max={90} step={5} onChange={(n) => update({ instructorTimeReduction: n })} />
          </Field>
          <div className="field">
            <span className="field-label">{t('Instructeur : prix par semaine (¥)')}</span>
            <div className="training-prices">
              <span>{t('Attributs')}</span>
              <NumberInput value={s.instructorCostPerWeek.attribute} min={0} max={100000} step={100} onChange={price('attribute')} />
              <span>{t('Compétences & groupes')}</span>
              <NumberInput value={s.instructorCostPerWeek.skill} min={0} max={100000} step={50} onChange={price('skill')} />
              <span>{t('Connaissances & langues')}</span>
              <NumberInput value={s.instructorCostPerWeek.knowledge} min={0} max={100000} step={50} onChange={price('knowledge')} />
              <span>{t('Autres (qualités, magie…)')}</span>
              <NumberInput value={s.instructorCostPerWeek.other} min={0} max={100000} step={50} onChange={price('other')} />
            </div>
          </div>
        </div>
      </Panel>
      <Panel title={t('Règles SR5 appliquées')}>
        <ul className="training-rules">
          {Object.keys(RULE_TEXT).map((k) => (
            <li key={k}>
              <strong>{k === 'instructor' ? t('Instructeur') : kindLabel(k)}</strong>
              <div className="small muted">{ruleText(k).replace(/^[^:]+ ?: /, '')}</div>
            </li>
          ))}
          <li>
            <strong>{t('Limites')}</strong>
            <div className="small muted">
              {t(
                'Attributs : maximum du métatype (+1 Attribut exceptionnel, +1 Chance pour Chanceux). Magie/Résonance : 6 + grade − essence perdue (arrondie au supérieur). Compétences : 12 (13 avec Aptitude). Un seul attribut à la fois ; pas deux entraînements sur la même chose.'
              )}
            </div>
          </li>
          <li>
            <strong>{t('Karma')}</strong>
            <div className="small muted">{t('Débité à la validation ; une demande en attente réserve son karma. Interrompre un entraînement (MJ) rembourse karma et instructeur.')}</div>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
