// Main tab « Progression »: players spend karma on their runner; the GM validates, runs downtime and sets the rules.
import { useState } from 'preact/hooks';
import { html, Panel, Empty, Badge, loadCss } from '../../lib/ui.js';
import { openSheet } from '../../lib/ui-store.js';
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
    return html`<div class="page"><div class="page-title"><h2>Progression</h2></div>
      <${Empty}>Aucun personnage associé à ton compte — demande au MJ de t’en attribuer un.</${Empty}></div>`;
  }
  const settings = settingsOf(game);
  const requests = requestsOf(game, actor.id);
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const jobs = jobsOf(actor);
  return html`<div class="page training-page">
    <div class="page-title">
      <div class="row wrap">
        <h2>Progression</h2>
        ${ids.length > 1
          ? html`<span class="row gap-s">${ids.map((id) => html`<button key=${id} class=${'training-pick' + (id === actor.id ? ' active' : '')} onClick=${() => setSel(id)}>${game.actors[id].name}</button>`)}</span>`
          : html`<button class="training-link training-actor-name" title="Ouvrir la fiche" onClick=${() => openSheet(actor.id)}>${actor.name}</button>`}
      </div>
      <${KarmaHeader} game=${game} actor=${actor} />
    </div>
    ${actor.retired && html`<div class="training-warn">Ce personnage est à la retraite : plus de progression possible.</div>`}
    <div class="training-layout">
      <${Panel} title="Que veux-tu améliorer ?" actions=${html`<span class="small muted training-mode">${settings.approval === 'always' ? 'Validation par le MJ' : 'Validation automatique'}${settings.useTime ? ' · temps d’entraînement' : ' · effet immédiat'}</span>`}>
        ${actor.retired ? html`<${Empty}>Plus de progression pour un runner à la retraite.</${Empty}>` : html`<${AdvancePanel} game=${game} actor=${actor} isGM=${false} />`}
      </${Panel}>
      <div class="col gap-l training-side">
        <${Panel} title=${`En cours${jobs.length ? ` (${jobs.length})` : ''}`} actions=${html`<${Rule} kind="instructor" />`}>
          <${JobList} game=${game} actor=${actor} isGM=${false} empty="Aucun entraînement en cours. Le temps passe pendant les temps morts, quand le MJ avance le calendrier." />
        </${Panel}>
        <${Panel} title="Mes demandes" actions=${pendingCount ? html`<${Badge} color="amber">${pendingCount} en attente</${Badge}>` : null}>
          <${RequestList} game=${game} requests=${requests} isGM=${false} limit=${25} />
        </${Panel}>
      </div>
    </div>
  </div>`;
}
