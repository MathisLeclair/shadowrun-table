// Main tab « Création »: SR5 Priority character creator (players: drafts + wizard; GM: approval queue + wizard).
import { useMemo, useState } from 'preact/hooks';
import { html, Button, Empty, loadCss, confirmAction } from '../../lib/ui.js';
import { send, useServerEvent } from '../../lib/net.js';
import { toast, openSheet, goTab } from '../../lib/ui-store.js';
import { draftHeadline, normalizeDraft } from '/shared/chargen.js';
import { t, tn } from '../../lib/i18n.js';
import { useRulesCtx, useComputed, StatusBadge, timeAgo, headlineText } from './common.js';
import Wizard from './Wizard.js';
import GmQueue from './GmQueue.js';
import DraftSummary from './Summary.js';

loadCss('/modules/chargen/chargen.css');
loadCss('/modules/combat/combat.css'); // stat block styles (summary preview)

export default function ChargenPage({ game }) {
  const [open, setOpen] = useState(null); // { draft|null, key }
  const isGM = game.me.role === 'gm';
  useServerEvent('chargen:resolved', (e) => {
    if (isGM) return;
    if (e.status === 'approved') toast(t('Ton personnage a été validé par le MJ !'), 'success', 6000);
    else toast(e.note ? t('Le MJ demande des changements : {note}', { note: e.note }) : t('Le MJ demande des changements'), 'warn', 8000);
  }, [isGM]);
  const openWizard = (draft) => setOpen({ draft, key: draft?.id || `new-${Date.now()}` });

  if (open) {
    return html`<div class="page cg-page cg-page-wizard"><${Wizard} key=${open.key} game=${game} draft=${open.draft} onExit=${() => setOpen(null)} /></div>`;
  }
  return html`<div class="page cg-page">
    <div class="page-title"><h2>${t('Création de personnage')}</h2><span class="small muted">${t('Système de priorités SR5')}</span></div>
    ${isGM ? html`<${GmQueue} game=${game} onOpenWizard=${openWizard} />` : html`<${PlayerHome} game=${game} onOpen=${openWizard} />`}
  </div>`;
}

function PlayerHome({ game, onOpen }) {
  const settings = game.chargen?.settings || {};
  const drafts = useMemo(() => [...(game.chargen?.drafts || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)), [game.chargen?.drafts]);
  const [viewId, setViewId] = useState(null);
  const viewing = drafts.find((d) => d.id === viewId);
  const closed = settings.allowPlayers === false;

  if (viewing) return html`<${DraftView} game=${game} d=${viewing} onBack=${() => setViewId(null)} onEdit=${() => onOpen(viewing)} />`;

  const open = (d) => (d.status === 'draft' || d.status === 'rejected' ? onOpen(d) : setViewId(d.id));
  const remove = async (d) => {
    if (!(await confirmAction(t('Supprimer « {name} » ?', { name: headlineText(draftHeadline(d.data)).name })))) return;
    send('chargen/delete', { draftId: d.id }).catch(() => null);
  };
  return html`<div class="col gap-l">
    ${closed && html`<div class="cg-note warn">${t('Le MJ a fermé la création de personnage pour l’instant : tu peux consulter tes brouillons mais pas les modifier.')}</div>`}
    <div class="cg-hero">
      <div class="grow">
        <h3>${t('Un nouveau runner pour les Ombres de Seattle')}</h3>
        <p class="muted">${t('L’assistant suit le livre de base : tu répartis les priorités A à E, puis les attributs, la magie, les compétences, les qualités, l’équipement et les contacts. Tout est vérifié en direct et enregistré automatiquement ; une fois prêt, tu l’envoies au MJ qui le valide.')}</p>
      </div>
      <${Button} variant="accent" disabled=${closed} onClick=${() => onOpen(null)}>✚ ${t('Nouveau personnage')}</${Button}>
    </div>
    ${drafts.length
      ? html`<div class="cg-drafts">
          ${drafts.map((d) => {
            const h = draftHeadline(d.data);
            const ht = headlineText(h);
            return html`<div key=${d.id} class="card clickable cg-draft" onClick=${() => open(d)}>
              <div class="spread row"><h4>${ht.name}</h4><${StatusBadge} status=${d.status} /></div>
              <div class="small muted">${ht.text || t('Concept à définir')}</div>
              <div class="row wrap gap-s small faint cg-draft-meta">
                <span class="mono" title=${t('Métatype / Attributs / Magie / Compétences / Ressources')}>${h.letters}</span>
                <span>· ${t('modifié {when}', { when: timeAgo(d.ts) })}</span>
                ${d.check && d.status !== 'approved' && html`<span class=${d.check.errors ? 'red' : 'green'}>· ${d.check.errors ? tn(d.check.errors, '{n} erreur', '{n} erreurs') : t('valide')}</span>`}
              </div>
              ${d.status === 'rejected' && d.gmNote && html`<div class="cg-quote small">« ${d.gmNote} »</div>`}
              <div class="row gap-s cg-draft-actions" onClick=${(e) => e.stopPropagation()}>
                ${d.status === 'approved' && d.actorId && game.actors?.[d.actorId] && html`<${Button} small variant="primary" onClick=${() => openSheet(d.actorId)}>${t('Ouvrir la fiche')}</${Button}>`}
                ${d.status === 'pending' && html`<${Button} small onClick=${() => send('chargen/withdraw', { draftId: d.id }).then(() => toast(t('Demande retirée : tu peux de nouveau modifier ce personnage'), 'info')).catch(() => null)}>${t('Retirer la demande')}</${Button}>`}
                ${d.status !== 'pending' && html`<${Button} small variant="ghost" onClick=${() => remove(d)}>${t('Supprimer')}</${Button}>`}
              </div>
            </div>`;
          })}
        </div>`
      : html`<${Empty}>${t('Aucun brouillon pour l’instant.')}</${Empty}>`}
  </div>`;
}

function DraftView({ game, d, onBack, onEdit }) {
  const rc = useRulesCtx(game);
  const data = useMemo(() => normalizeDraft(d.data), [d.data]);
  const { result } = useComputed(data, rc);
  const h = headlineText(draftHeadline(d.data));
  return html`<div class="col">
    <div class="row wrap">
      <${Button} variant="ghost" onClick=${onBack}>← ${t('Mes personnages')}</${Button}>
      <h3 class="grow">${h.name}</h3>
      <${StatusBadge} status=${d.status} />
      ${d.status === 'pending' && html`<${Button} onClick=${() => send('chargen/withdraw', { draftId: d.id }).then(onEdit).catch(() => null)}>${t('Retirer et modifier')}</${Button}>`}
      ${d.status === 'approved' && d.actorId && game.actors?.[d.actorId] && html`<${Button} variant="primary" onClick=${() => { openSheet(d.actorId); goTab('sheet'); }}>${t('Voir ma fiche')}</${Button}>`}
    </div>
    ${d.status === 'pending' && html`<div class="cg-note">${t('Envoyé au MJ {when}. Tu seras prévenu dès qu’il l’aura relu.', { when: timeAgo(d.submittedTs) })}</div>`}
    ${!rc.ready ? html`<div class="cg-loading">${t('Chargement des catalogues…')}</div>` : html`<${DraftSummary} data=${data} result=${result} rc=${rc} />`}
  </div>`;
}

