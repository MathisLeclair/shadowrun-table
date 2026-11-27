// Shared bits of the training UI: settings/quote helpers, status badges, progress bars, job & request lists.
import { Badge, Button, Stat, confirmAction, type BadgeColor } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast, openSheet } from '../../lib/ui-store.ts';
import { t, tn, tk, fmtNuyen, locale } from '../../lib/i18n.ts';
import { DEFAULT_SETTINGS, RULE_TEXT, KIND_LABELS, quote, formatDaysI18n } from '/shared/advancement.ts';
import type { Actor, ActorId, GameView, I18nEntry, OrderStatus, TrainingJob, TrainingRequest, TrainingSettings, ViewActor } from '../../../shared/types.ts';
import type { TrainingDraft, TrainingQuote } from './types.ts';
import { RuleRef } from '../books/BookRef.tsx';

/** Rulebook page of each advancement kind (shared/bookrefs.js RULE_REFS): karma costs and training times, SR5 p. 103. */
const KIND_RULES: Record<string, string> = { initiation: 'initiation', submersion: 'submersion' };

export const STATUS: Record<OrderStatus, { label: string; color: BadgeColor }> = {
  pending: { label: tk('En attente'), color: 'amber' },
  approved: { label: tk('En cours'), color: 'cyan' },
  done: { label: tk('Acquise'), color: 'green' },
  denied: { label: tk('Refusée'), color: 'red' },
  cancelled: { label: tk('Annulée'), color: 'dim' },
};

/** Full sheet of a view actor (players see other NPCs as stubs), or null. */
export const fullActor = (a: ViewActor | null | undefined): Actor | null => (a && 'attributes' in a ? a : null);

// ---------------------------------------------------------------------------
// i18n helpers (texts computed by shared/advancement.js come with { key, params })
// ---------------------------------------------------------------------------
/** 'skill' → « Compétence » / « Skill ». */
export const kindLabel = (kind: string | null | undefined): string => (kind && (KIND_LABELS as Record<string, string>)[kind] ? t((KIND_LABELS as Record<string, string>)[kind]) : String(kind ?? ''));
/** SR5 rule summary of a kind (or 'instructor'), translated. */
export const ruleText = (kind: string | null | undefined): string => (kind && (RULE_TEXT as Record<string, string>)[kind] ? t((RULE_TEXT as Record<string, string>)[kind]) : '');
/** 14 → « 2 semaines » / « 2 weeks ». */
export function fmtDays(days: number): string {
  const v = formatDaysI18n(days);
  return t(v.t, v.params);
}
/** Anything with a label: quote, request or job. */
type Labelled = { label?: string; labelI18n?: I18nEntry | null } | null | undefined;
/** Label of a quote / request / job, in the UI language (stored requests keep their French `label`). */
export const labelOf = (x: Labelled): string => (x?.labelI18n?.key ? t(x.labelI18n.key, x.labelI18n.params) : x?.label || '');
/** Error of a quote, translated (null when none). */
export const errorOf = (qt: TrainingQuote | null | undefined): string | null => (qt?.error ? (qt.errorI18n?.key ? t(qt.errorI18n.key, qt.errorI18n.params) : qt.error) : null);
/** Warnings of a quote, translated. */
export const warningsOf = (qt: TrainingQuote | null | undefined): string[] =>
  qt?.warningsI18n?.length ? qt.warningsI18n.map((w) => t(w.key, w.params)) : qt?.warnings || [];
/** { key, params } message → text. */
export const msgText = (m: I18nEntry | null | undefined, fallback = ''): string => (m?.key ? t(m.key, m.params) : fallback);

export function settingsOf(game: GameView | null | undefined): TrainingSettings {
  const s: Partial<TrainingSettings> = game?.training?.settings || {};
  return { ...DEFAULT_SETTINGS, ...s, instructorCostPerWeek: { ...DEFAULT_SETTINGS.instructorCostPerWeek, ...(s.instructorCostPerWeek || {}) } } as TrainingSettings;
}

export function requestsOf(game: GameView | null | undefined, actorId?: ActorId | null): TrainingRequest[] {
  const all = Array.isArray(game?.training?.requests) ? game.training.requests : [];
  return actorId ? all.filter((r) => r.actorId === actorId) : all;
}

export function jobsOf(actor: ViewActor | null | undefined): TrainingJob[] {
  const a = fullActor(actor);
  return Array.isArray(a?.training) ? a.training : [];
}

/** Context for quote(): other open requests/jobs and karma/nuyen engaged by pending requests. */
export function quoteContext(game: GameView, actor: Actor | null | undefined, exceptId?: string) {
  const pending = requestsOf(game, actor?.id).filter((r) => r.status === 'pending' && r.id !== exceptId);
  return {
    active: [...pending, ...jobsOf(actor).filter((j) => j.requestId !== exceptId)],
    reservedKarma: pending.reduce((s, r) => s + (Number(r.karmaCost) || 0), 0),
    reservedNuyen: pending.reduce((s, r) => s + (Number(r.nuyenCost) || 0), 0),
  };
}

/** (request) => quote, for one actor with the current settings and open requests. */
export function makeQuoter(game: GameView, actor: Actor): (req: TrainingDraft) => TrainingQuote {
  const settings = settingsOf(game);
  const ctx = quoteContext(game, actor);
  return (req) => quote(actor, req, settings, ctx) as TrainingQuote;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(locale(), { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  const s = STATUS[status];
  return <Badge color={s?.color || 'dim'}>{s ? t(s.label) : status}</Badge>;
}

/** Small « ? » showing the SR5 rule (tooltip on desktop, toast on tap). */
export function Rule({ kind }: { kind: string }) {
  const text = ruleText(kind);
  if (!text) return null;
  return (
    <>
      <button
        type="button"
        className="training-rule"
        title={text}
        aria-label={t('Règle : {text}', { text })}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toast(text, 'info', 7000);
        }}
      >
        ?
      </button>{' '}
      <RuleRef rule={KIND_RULES[kind] || 'karmaAdvancement'} />
    </>
  );
}

/** "25 karma · 5 semaines" or the reason it's impossible. */
export function CostCell({ qt }: { qt: TrainingQuote | null | undefined }) {
  if (!qt) return null;
  if (qt.error) return <span className="training-err small">{errorOf(qt)}</span>;
  return (
    <span className="training-cost">
      <span className="mono amber">{t('{n} karma', { n: qt.karmaCost })}</span>
      <span className="muted"> · {fmtDays(qt.days)}</span>
    </span>
  );
}

export function ProgressBar({ value, max, compact }: { value: number; max: number; compact?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 100;
  return (
    <div className={'training-bar' + (compact ? ' compact' : '')} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className="training-bar-fill" style={{ width: `${pct}%` }}></div>
    </div>
  );
}

export function KarmaHeader({ game, actor }: { game: GameView; actor: Actor }) {
  const ctx = quoteContext(game, actor);
  const avail = Number(actor.karma) || 0;
  return (
    <div className="training-stats">
      <Stat
        label={t('Karma dispo')}
        value={avail - ctx.reservedKarma}
        accent="cyan"
        title={ctx.reservedKarma ? t('{total} au total, dont {reserved} engagés par des demandes en attente', { total: avail, reserved: ctx.reservedKarma }) : t('Karma disponible')}
      />
      {ctx.reservedKarma > 0 && <Stat label={t('Engagé')} value={ctx.reservedKarma} accent="amber" title={t('Karma réservé par des demandes en attente de validation')} />}
      <Stat label={t('Carrière')} value={Number(actor.karmaTotal) || 0} title={t('Karma total gagné')} />
      <Stat label={t('Nuyens')} value={fmtNuyen(actor.nuyen)} accent="magenta" />
    </div>
  );
}

interface JobListProps {
  game: GameView;
  actor: Actor;
  isGM: boolean;
  /** Already translated text. */
  empty?: string;
}
/** In-progress trainings of one actor. GM can finish or interrupt them. `empty` = already translated text. */
export function JobList({ actor, isGM, empty }: JobListProps) {
  const jobs = jobsOf(actor);
  if (!jobs.length) return <div className="muted small training-empty">{empty || t('Aucun entraînement en cours.')}</div>;
  const finish = (job: TrainingJob) =>
    send('training/complete', { actorId: actor.id, jobId: job.id })
      .then(() => toast(t('{label} : terminé', { label: labelOf(job) }), 'success'))
      .catch(() => {});
  const stop = async (job: TrainingJob) => {
    if (!(await confirmAction(t('Interrompre « {label} » pour {name} ?\nLe karma (et l’éventuel instructeur) sera remboursé.', { label: labelOf(job), name: actor.name })))) return;
    send('training/cancel', { requestId: job.requestId, refund: true })
      .then(() => toast(t('Entraînement interrompu, karma remboursé'), 'warn'))
      .catch(() => {});
  };
  return (
    <ul className="training-jobs">
      {jobs.map((job) => {
        const done = Number(job.daysDone) || 0;
        const total = Number(job.daysTotal) || 0;
        return (
          <li key={job.id} className="training-job">
            <div className="row spread wrap">
              <strong className="training-job-label">{labelOf(job)}</strong>
              <span className="small mono muted">{t('{done} / {total} j', { done, total })}</span>
            </div>
            <ProgressBar value={done} max={total} />
            <div className="row spread wrap small">
              <span className="muted">{t('Reste {time}', { time: fmtDays(Math.max(0, total - done)) })}</span>
              {isGM && (
                <span className="row gap-s">
                  <Button small variant="ghost" title={t('Terminer maintenant')} onClick={() => finish(job)}>
                    ✓ {t('Terminer')}
                  </Button>
                  <Button small variant="ghost" title={t('Interrompre et rembourser')} onClick={() => stop(job)}>
                    ✕
                  </Button>
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface RequestListProps {
  game: GameView;
  requests: TrainingRequest[];
  isGM: boolean;
  /** Prefix with the actor name (GM). */
  showActor?: boolean;
  limit?: number;
  /** Already translated text. */
  empty?: string;
}
/** Request history. showActor: prefix with the actor name (GM). `empty` = already translated text. */
export function RequestList({ game, requests, isGM, showActor, limit = 40, empty }: RequestListProps) {
  const list = [...(requests || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!list.length) return <div className="muted small training-empty">{empty || t('Aucune demande pour l’instant.')}</div>;
  const cancel = async (r: TrainingRequest) => {
    if (!(await confirmAction(t('Annuler la demande « {label} » ?', { label: labelOf(r) })))) return;
    send('training/cancel', { requestId: r.id })
      .then(() => toast(t('Demande annulée')))
      .catch(() => {});
  };
  return (
    <>
      <ul className="training-requests">
        {list.slice(0, limit).map((r) => {
          const actor = game.actors?.[r.actorId];
          return (
            <li key={r.id} className={'training-req status-' + r.status}>
              <div className="row spread wrap gap-s">
                <span className="grow">
                  {showActor && (
                    <>
                      <button className="training-link" onClick={() => actor && openSheet(actor.id)}>
                        {actor?.name || '?'}
                      </button>
                      {' · '}
                    </>
                  )}
                  <span>{labelOf(r)}</span>
                </span>
                <StatusBadge status={r.status} />
              </div>
              <div className="row wrap small muted gap-s">
                <span>{fmtDate(r.ts)}</span>
                {r.karmaCost > 0 && <span className="mono">· {t('{n} karma', { n: r.karmaCost })}</span>}
                {r.nuyenCost > 0 && <span className="mono">· {fmtNuyen(r.nuyenCost)}</span>}
                {r.days > 0 && <span>· {r.instructor ? t('{time} (instructeur)', { time: fmtDays(r.days) }) : fmtDays(r.days)}</span>}
                {r.manual && (
                  <Badge color="magenta" title={t('Saisie manuelle, non vérifiée par le catalogue')}>
                    {t('manuel')}
                  </Badge>
                )}
              </div>
              {r.note && <div className="small training-note">« {r.note} »</div>}
              {r.gmNote && <div className="small training-gmnote">{t('MJ : {note}', { note: r.gmNote })}</div>}
              {r.status === 'pending' && !isGM && (
                <div className="right">
                  <Button small variant="ghost" onClick={() => cancel(r)}>
                    {t('Annuler')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {list.length > limit && <div className="muted small center">{tn(list.length - limit, 'un::… {n} demande(s) plus ancienne(s)', '… {n} demande(s) plus ancienne(s)')}</div>}
    </>
  );
}

export const MAGIC_TYPES: Record<string, string> = { adept: tk('Adepte'), mystic: tk('Adepte mystique'), magician: tk('Magicien'), technomancer: tk('Technomancien') };
