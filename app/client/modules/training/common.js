// Shared bits of the training UI: settings/quote helpers, status badges, progress bars, job & request lists.
import { html, Badge, Button, Stat, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { DEFAULT_SETTINGS, RULE_TEXT, quote, formatDays } from '/shared/advancement.js';
import { nuyen } from '/shared/util.js';

export const STATUS = {
  pending: { label: 'En attente', color: 'amber' },
  approved: { label: 'En cours', color: 'cyan' },
  done: { label: 'Acquise', color: 'green' },
  denied: { label: 'Refusée', color: 'red' },
  cancelled: { label: 'Annulée', color: 'dim' },
};

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
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status, color: 'dim' };
  return html`<${Badge} color=${s.color}>${s.label}</${Badge}>`;
}

/** Small « ? » showing the SR5 rule (tooltip on desktop, toast on tap). */
export function Rule({ kind }) {
  const text = RULE_TEXT[kind];
  if (!text) return null;
  return html`<button type="button" class="training-rule" title=${text} aria-label=${`Règle : ${text}`}
    onClick=${(e) => {
      e.preventDefault();
      e.stopPropagation();
      toast(text, 'info', 7000);
    }}>?</button>`;
}

/** "25 karma · 5 semaines" or the reason it's impossible. */
export function CostCell({ qt }) {
  if (!qt) return null;
  if (qt.error) return html`<span class="training-err small">${qt.error}</span>`;
  return html`<span class="training-cost"><span class="mono amber">${qt.karmaCost} karma</span><span class="muted"> · ${formatDays(qt.days)}</span></span>`;
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
    <${Stat} label="Karma dispo" value=${avail - ctx.reservedKarma} accent="cyan" title=${ctx.reservedKarma ? `${avail} au total, dont ${ctx.reservedKarma} engagés par des demandes en attente` : 'Karma disponible'} />
    ${ctx.reservedKarma > 0 && html`<${Stat} label="Engagé" value=${ctx.reservedKarma} accent="amber" title="Karma réservé par des demandes en attente de validation" />`}
    <${Stat} label="Carrière" value=${Number(actor.karmaTotal) || 0} title="Karma total gagné" />
    <${Stat} label="Nuyens" value=${nuyen(actor.nuyen)} accent="magenta" />
  </div>`;
}

/** In-progress trainings of one actor. GM can finish or interrupt them. */
export function JobList({ game, actor, isGM, empty = 'Aucun entraînement en cours.' }) {
  const jobs = jobsOf(actor);
  if (!jobs.length) return html`<div class="muted small training-empty">${empty}</div>`;
  const finish = (job) => send('training/complete', { actorId: actor.id, jobId: job.id }).then(() => toast(`${job.label} : terminé`, 'success')).catch(() => {});
  const stop = async (job) => {
    if (!(await confirmAction(`Interrompre « ${job.label} » pour ${actor.name} ?\nLe karma (et l’éventuel instructeur) sera remboursé.`))) return;
    send('training/cancel', { requestId: job.requestId, refund: true }).then(() => toast('Entraînement interrompu, karma remboursé', 'warn')).catch(() => {});
  };
  return html`<ul class="training-jobs">
    ${jobs.map((job) => {
      const done = Number(job.daysDone) || 0;
      const total = Number(job.daysTotal) || 0;
      return html`<li key=${job.id} class="training-job">
        <div class="row spread wrap">
          <strong class="training-job-label">${job.label}</strong>
          <span class="small mono muted">${done} / ${total} j</span>
        </div>
        <${ProgressBar} value=${done} max=${total} />
        <div class="row spread wrap small">
          <span class="muted">Reste ${formatDays(Math.max(0, total - done))}</span>
          ${isGM &&
          html`<span class="row gap-s">
            <${Button} small variant="ghost" title="Terminer maintenant" onClick=${() => finish(job)}>✓ Terminer</${Button}>
            <${Button} small variant="ghost" title="Interrompre et rembourser" onClick=${() => stop(job)}>✕</${Button}>
          </span>`}
        </div>
      </li>`;
    })}
  </ul>`;
}

/** Request history. showActor: prefix with the actor name (GM). */
export function RequestList({ game, requests, isGM, showActor, limit = 40, empty = 'Aucune demande pour l’instant.' }) {
  const list = [...(requests || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!list.length) return html`<div class="muted small training-empty">${empty}</div>`;
  const cancel = async (r) => {
    if (!(await confirmAction(`Annuler la demande « ${r.label} » ?`))) return;
    send('training/cancel', { requestId: r.id }).then(() => toast('Demande annulée')).catch(() => {});
  };
  return html`<ul class="training-requests">
    ${list.slice(0, limit).map((r) => {
      const actor = game.actors?.[r.actorId];
      return html`<li key=${r.id} class=${'training-req status-' + r.status}>
        <div class="row spread wrap gap-s">
          <span class="grow">
            ${showActor && html`<button class="training-link" onClick=${() => actor && openSheet(actor.id)}>${actor?.name || '?'}</button> · `}
            <span>${r.label}</span>
          </span>
          <${StatusBadge} status=${r.status} />
        </div>
        <div class="row wrap small muted gap-s">
          <span>${fmtDate(r.ts)}</span>
          ${r.karmaCost > 0 && html`<span class="mono">· ${r.karmaCost} karma</span>`}
          ${r.nuyenCost > 0 && html`<span class="mono">· ${nuyen(r.nuyenCost)}</span>`}
          ${r.days > 0 && html`<span>· ${formatDays(r.days)}${r.instructor ? ' (instructeur)' : ''}</span>`}
          ${r.manual && html`<${Badge} color="magenta" title="Saisie manuelle, non vérifiée par le catalogue">manuel</${Badge}>`}
        </div>
        ${r.note && html`<div class="small training-note">« ${r.note} »</div>`}
        ${r.gmNote && html`<div class="small training-gmnote">MJ : ${r.gmNote}</div>`}
        ${r.status === 'pending' && !isGM && html`<div class="right"><${Button} small variant="ghost" onClick=${() => cancel(r)}>Annuler</${Button}></div>`}
      </li>`;
    })}
  </ul>
  ${list.length > limit && html`<div class="muted small center">… ${list.length - limit} demande(s) plus ancienne(s)</div>`}`;
}

export const MAGIC_TYPES = { adept: 'Adepte', mystic: 'Adepte mystique', magician: 'Magicien', technomancer: 'Technomancien' };
