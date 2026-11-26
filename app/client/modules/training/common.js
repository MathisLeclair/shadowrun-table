// Shared bits of the training UI: settings/quote helpers, status badges, progress bars, job & request lists.
import { html, Badge, Button, Stat, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { t, tn, tk, fmtNuyen, locale } from '../../lib/i18n.js';
import { DEFAULT_SETTINGS, RULE_TEXT, KIND_LABELS, quote, formatDaysI18n } from '/shared/advancement.js';

export const STATUS = {
  pending: { label: tk('En attente'), color: 'amber' },
  approved: { label: tk('En cours'), color: 'cyan' },
  done: { label: tk('Acquise'), color: 'green' },
  denied: { label: tk('Refusée'), color: 'red' },
  cancelled: { label: tk('Annulée'), color: 'dim' },
};

// ---------------------------------------------------------------------------
// i18n helpers (texts computed by shared/advancement.js come with { key, params })
// ---------------------------------------------------------------------------
/** 'skill' → « Compétence » / « Skill ». */
export const kindLabel = (kind) => (KIND_LABELS[kind] ? t(KIND_LABELS[kind]) : String(kind ?? ''));
/** SR5 rule summary of a kind (or 'instructor'), translated. */
export const ruleText = (kind) => (RULE_TEXT[kind] ? t(RULE_TEXT[kind]) : '');
/** 14 → « 2 semaines » / « 2 weeks ». */
export function fmtDays(days) {
  const v = formatDaysI18n(days);
  return t(v.t, v.params);
}
/** Label of a quote / request / job, in the UI language (stored requests keep their French `label`). */
export const labelOf = (x) => (x?.labelI18n?.key ? t(x.labelI18n.key, x.labelI18n.params) : x?.label || '');
/** Error of a quote, translated (null when none). */
export const errorOf = (qt) => (qt?.error ? (qt.errorI18n?.key ? t(qt.errorI18n.key, qt.errorI18n.params) : qt.error) : null);
/** Warnings of a quote, translated. */
export const warningsOf = (qt) => (qt?.warningsI18n?.length ? qt.warningsI18n.map((w) => t(w.key, w.params)) : qt?.warnings || []);
/** { key, params } message → text. */
export const msgText = (m, fallback = '') => (m?.key ? t(m.key, m.params) : fallback);

export function settingsOf(game) {
  const s = game?.training?.settings || {};
  return { ...DEFAULT_SETTINGS, ...s, instructorCostPerWeek: { ...DEFAULT_SETTINGS.instructorCostPerWeek, ...(s.instructorCostPerWeek || {}) } };
}

export function requestsOf(game, actorId) {
  const all = Array.isArray(game?.training?.requests) ? game.training.requests : [];
  return actorId ? all.filter((r) => r.actorId === actorId) : all;
}

export function jobsOf(actor) {
  return Array.isArray(actor?.training) ? actor.training : [];
}

/** Context for quote(): other open requests/jobs and karma/nuyen engaged by pending requests. */
export function quoteContext(game, actor, exceptId) {
  const pending = requestsOf(game, actor?.id).filter((r) => r.status === 'pending' && r.id !== exceptId);
  return {
    active: [...pending, ...jobsOf(actor).filter((j) => j.requestId !== exceptId)],
    reservedKarma: pending.reduce((s, r) => s + (Number(r.karmaCost) || 0), 0),
    reservedNuyen: pending.reduce((s, r) => s + (Number(r.nuyenCost) || 0), 0),
  };
}

/** (request) => quote, for one actor with the current settings and open requests. */
export function makeQuoter(game, actor) {
  const settings = settingsOf(game);
  const ctx = quoteContext(game, actor);
  return (req) => quote(actor, req, settings, ctx);
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(locale(), { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function StatusBadge({ status }) {
  const s = STATUS[status];
  return html`<${Badge} color=${s?.color || 'dim'}>${s ? t(s.label) : status}</${Badge}>`;
}

/** Small « ? » showing the SR5 rule (tooltip on desktop, toast on tap). */
export function Rule({ kind }) {
  const text = ruleText(kind);
  if (!text) return null;
  return html`<button type="button" class="training-rule" title=${text} aria-label=${t('Règle : {text}', { text })}
    onClick=${(e) => {
      e.preventDefault();
      e.stopPropagation();
      toast(text, 'info', 7000);
    }}>?</button>`;
}

/** "25 karma · 5 semaines" or the reason it's impossible. */
export function CostCell({ qt }) {
  if (!qt) return null;
  if (qt.error) return html`<span class="training-err small">${errorOf(qt)}</span>`;
  return html`<span class="training-cost"><span class="mono amber">${t('{n} karma', { n: qt.karmaCost })}</span><span class="muted"> · ${fmtDays(qt.days)}</span></span>`;
}

export function ProgressBar({ value, max, compact }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 100;
  return html`<div class=${'training-bar' + (compact ? ' compact' : '')} role="progressbar" aria-valuenow=${value} aria-valuemin="0" aria-valuemax=${max}>
    <div class="training-bar-fill" style=${{ width: `${pct}%` }}></div>
  </div>`;
}

export function KarmaHeader({ game, actor }) {
  const ctx = quoteContext(game, actor);
  const avail = Number(actor.karma) || 0;
  return html`<div class="training-stats">
    <${Stat} label=${t('Karma dispo')} value=${avail - ctx.reservedKarma} accent="cyan" title=${ctx.reservedKarma ? t('{total} au total, dont {reserved} engagés par des demandes en attente', { total: avail, reserved: ctx.reservedKarma }) : t('Karma disponible')} />
    ${ctx.reservedKarma > 0 && html`<${Stat} label=${t('Engagé')} value=${ctx.reservedKarma} accent="amber" title=${t('Karma réservé par des demandes en attente de validation')} />`}
    <${Stat} label=${t('Carrière')} value=${Number(actor.karmaTotal) || 0} title=${t('Karma total gagné')} />
    <${Stat} label=${t('Nuyens')} value=${fmtNuyen(actor.nuyen)} accent="magenta" />
  </div>`;
}

/** In-progress trainings of one actor. GM can finish or interrupt them. `empty` = already translated text. */
export function JobList({ game, actor, isGM, empty }) {
  const jobs = jobsOf(actor);
  if (!jobs.length) return html`<div class="muted small training-empty">${empty || t('Aucun entraînement en cours.')}</div>`;
  const finish = (job) => send('training/complete', { actorId: actor.id, jobId: job.id }).then(() => toast(t('{label} : terminé', { label: labelOf(job) }), 'success')).catch(() => {});
  const stop = async (job) => {
    if (!(await confirmAction(t('Interrompre « {label} » pour {name} ?\nLe karma (et l’éventuel instructeur) sera remboursé.', { label: labelOf(job), name: actor.name })))) return;
    send('training/cancel', { requestId: job.requestId, refund: true }).then(() => toast(t('Entraînement interrompu, karma remboursé'), 'warn')).catch(() => {});
  };
  return html`<ul class="training-jobs">
    ${jobs.map((job) => {
      const done = Number(job.daysDone) || 0;
      const total = Number(job.daysTotal) || 0;
      return html`<li key=${job.id} class="training-job">
        <div class="row spread wrap">
          <strong class="training-job-label">${labelOf(job)}</strong>
          <span class="small mono muted">${t('{done} / {total} j', { done, total })}</span>
        </div>
        <${ProgressBar} value=${done} max=${total} />
        <div class="row spread wrap small">
          <span class="muted">${t('Reste {time}', { time: fmtDays(Math.max(0, total - done)) })}</span>
          ${isGM &&
          html`<span class="row gap-s">
            <${Button} small variant="ghost" title=${t('Terminer maintenant')} onClick=${() => finish(job)}>✓ ${t('Terminer')}</${Button}>
            <${Button} small variant="ghost" title=${t('Interrompre et rembourser')} onClick=${() => stop(job)}>✕</${Button}>
          </span>`}
        </div>
      </li>`;
    })}
  </ul>`;
}

/** Request history. showActor: prefix with the actor name (GM). `empty` = already translated text. */
export function RequestList({ game, requests, isGM, showActor, limit = 40, empty }) {
  const list = [...(requests || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!list.length) return html`<div class="muted small training-empty">${empty || t('Aucune demande pour l’instant.')}</div>`;
  const cancel = async (r) => {
    if (!(await confirmAction(t('Annuler la demande « {label} » ?', { label: labelOf(r) })))) return;
    send('training/cancel', { requestId: r.id }).then(() => toast(t('Demande annulée'))).catch(() => {});
  };
  return html`<ul class="training-requests">
    ${list.slice(0, limit).map((r) => {
      const actor = game.actors?.[r.actorId];
      return html`<li key=${r.id} class=${'training-req status-' + r.status}>
        <div class="row spread wrap gap-s">
          <span class="grow">
            ${showActor && html`<button class="training-link" onClick=${() => actor && openSheet(actor.id)}>${actor?.name || '?'}</button> · `}
            <span>${labelOf(r)}</span>
          </span>
          <${StatusBadge} status=${r.status} />
        </div>
        <div class="row wrap small muted gap-s">
          <span>${fmtDate(r.ts)}</span>
          ${r.karmaCost > 0 && html`<span class="mono">· ${t('{n} karma', { n: r.karmaCost })}</span>`}
          ${r.nuyenCost > 0 && html`<span class="mono">· ${fmtNuyen(r.nuyenCost)}</span>`}
          ${r.days > 0 && html`<span>· ${r.instructor ? t('{time} (instructeur)', { time: fmtDays(r.days) }) : fmtDays(r.days)}</span>`}
          ${r.manual && html`<${Badge} color="magenta" title=${t('Saisie manuelle, non vérifiée par le catalogue')}>${t('manuel')}</${Badge}>`}
        </div>
        ${r.note && html`<div class="small training-note">« ${r.note} »</div>`}
        ${r.gmNote && html`<div class="small training-gmnote">${t('MJ : {note}', { note: r.gmNote })}</div>`}
        ${r.status === 'pending' && !isGM && html`<div class="right"><${Button} small variant="ghost" onClick=${() => cancel(r)}>${t('Annuler')}</${Button}></div>`}
      </li>`;
    })}
  </ul>
  ${list.length > limit && html`<div class="muted small center">${tn(list.length - limit, 'un::… {n} demande(s) plus ancienne(s)', '… {n} demande(s) plus ancienne(s)')}</div>`}`;
}

export const MAGIC_TYPES = { adept: tk('Adepte'), mystic: tk('Adepte mystique'), magician: tk('Magicien'), technomancer: tk('Technomancien') };
