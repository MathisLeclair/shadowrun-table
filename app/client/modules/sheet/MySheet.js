// « Ma fiche » (players): the character(s) assigned to this player, full sheet inline.
import { useState } from 'preact/hooks';
import { html, Tabs, Empty, loadCss } from '../../lib/ui.js';
import SheetView from './SheetView.js';
import { t } from '../../lib/i18n.js';
import { Avatar, tRich } from './common.js';

loadCss('/modules/sheet/sheet.css');

export default function MySheet({ game }) {
  const ids = (game.me.characterIds || []).filter((id) => game.actors?.[id]);
  const [sel, setSel] = useState(null);
  if (!ids.length) {
    return html`<div class="page"><div class="sh-nochar">
      <div class="logo-mark"></div>
      <h2>${t('Aucun personnage')}</h2>
      <p class="muted">${tRich(t('Le MJ ne t’a pas encore attribué de personnage. Demande-lui de t’en assigner un depuis l’onglet {tab} — ta fiche apparaîtra ici automatiquement.'), { tab: html`<b>${t('Personnages')}</b>` })}</p>
    </div></div>`;
  }
  const current = ids.includes(sel) ? sel : ids[0];
  return html`<div class="page sh-mysheet">
    ${ids.length > 1 &&
    html`<${Tabs}
      class="sh-mytabs"
      tabs=${ids.map((id) => ({ id, label: html`<span class="row gap-s"><${Avatar} actor=${game.actors[id]} size=${18} />${game.actors[id].name}</span>` }))}
      value=${current}
      onChange=${setSel}
    />`}
    ${game.actors[current] ? html`<${SheetView} key=${current} game=${game} actorId=${current} />` : html`<${Empty}>${t('Personnage introuvable.')}</${Empty}>`}
  </div>`;
}
