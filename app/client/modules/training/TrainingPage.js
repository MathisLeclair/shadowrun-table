// Main tab « Progression »: players spend karma on their runner; the GM validates, runs downtime and sets the rules.
import { useState } from 'preact/hooks';
import { html, Panel, Empty, Badge, loadCss } from '../../lib/ui.js';
import { openSheet } from '../../lib/ui-store.js';
import { t } from '../../lib/i18n.js';
import AdvancePanel from './AdvancePanel.js';
import GmTraining from './GmTraining.js';
import { KarmaHeader, JobList, RequestList, requestsOf, jobsOf, settingsOf, Rule } from './common.js';

loadCss('/modules/training/training.css');

export default function TrainingPage({ game }) {
  if (!game) return null;
  return game.me?.role === 'gm' ? html`<${GmTraining} game=${game} />` : html`<${PlayerTraining} game=${game} />`;
}

function PlayerTraining({ game }) {
  const ids = (game.me?.characterIds || []).filter((id) => game.actors?.[id]);
  const [sel, setSel] = useState(null);
  const actorId = ids.includes(sel) ? sel : ids[0];
  const actor = actorId ? game.actors[actorId] : null;
  if (!actor) {
    return html`<div class="page"><div class="page-title"><h2>${t('Progression')}</h2></div>
      <${Empty}>${t('Aucun personnage associé à ton compte — demande au MJ de t’en attribuer un.')}</${Empty}></div>`;
  }
  const settings = settingsOf(game);
  const requests = requestsOf(game, actor.id);
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const jobs = jobsOf(actor);
  const mode = settings.approval === 'always'
    ? settings.useTime ? t('Validation par le MJ · temps d’entraînement') : t('Validation par le MJ · effet immédiat')
    : settings.useTime ? t('Validation automatique · temps d’entraînement') : t('Validation automatique · effet immédiat');
  return html`<div class="page training-page">
    <div class="page-title">
      <div class="row wrap">
        <h2>${t('Progression')}</h2>
        ${ids.length > 1
          ? html`<span class="row gap-s">${ids.map((id) => html`<button key=${id} class=${'training-pick' + (id === actor.id ? ' active' : '')} onClick=${() => setSel(id)}>${game.actors[id].name}</button>`)}</span>`
          : html`<button class="training-link training-actor-name" title=${t('Ouvrir la fiche')} onClick=${() => openSheet(actor.id)}>${actor.name}</button>`}
      </div>
      <${KarmaHeader} game=${game} actor=${actor} />
    </div>
    ${actor.retired && html`<div class="training-warn">${t('Ce personnage est à la retraite : plus de progression possible.')}</div>`}
    <div class="training-layout">
      <${Panel} title=${t('Que veux-tu améliorer ?')} actions=${html`<span class="small muted training-mode">${mode}</span>`}>
        ${actor.retired ? html`<${Empty}>${t('Plus de progression pour un runner à la retraite.')}</${Empty}>` : html`<${AdvancePanel} game=${game} actor=${actor} isGM=${false} />`}
      </${Panel}>
      <div class="col gap-l training-side">
        <${Panel} title=${jobs.length ? t('En cours ({n})', { n: jobs.length }) : t('En cours')} actions=${html`<${Rule} kind="instructor" />`}>
          <${JobList} game=${game} actor=${actor} isGM=${false} empty=${t('Aucun entraînement en cours. Le temps passe pendant les temps morts, quand le MJ avance le calendrier.')} />
        </${Panel}>
        <${Panel} title=${t('Mes demandes')} actions=${pendingCount ? html`<${Badge} color="amber">${t('{n} en attente', { n: pendingCount })}</${Badge}>` : null}>
          <${RequestList} game=${game} requests=${requests} isGM=${false} limit=${25} />
        </${Panel}>
      </div>
    </div>
  </div>`;
}
