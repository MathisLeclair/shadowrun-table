// « Matrice » tab: decker cockpit for players, commlink overview for non-deckers, hosts & deckers manager for the GM.
import { useEffect, useState } from 'preact/hooks';
import { html, Tabs, Empty, Toggle, Badge, loadCss } from '../../lib/ui.js';
import { useUI } from '../../lib/ui-store.js';
import { t } from '../../lib/i18n.js';
import { attr } from '/shared/sr5.js';
import { isCyberdeck, deckStats, matrixInitiative, matrixMonitor, programSum, ACTIONS } from '/shared/matrix.js';
import { isGM, act, matrixActors, personaOf, MatrixLog, actionName, asdfShort } from './common.js';
import Cockpit from './Cockpit.js';
import { DeckersView, HostsView } from './GmMatrix.js';

loadCss('/modules/matrix/matrix.css');

function usePersistent(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : JSON.parse(s);
    } catch {
      return initial;
    }
  });
  const set = (x) => {
    setV(x);
    try {
      localStorage.setItem(key, JSON.stringify(x));
    } catch {}
  };
  return [v, set];
}

/** Actor requested by « Ouvrir la Matrice » on a sheet (ui-store key matrixFocus = { actorId, nonce }). */
function useMatrixFocus(onFocus) {
  const ui = useUI();
  const f = ui.matrixFocus;
  useEffect(() => {
    if (f?.actorId) onFocus(f.actorId);
  }, [f?.nonce]);
}

/** Players without a cyberdeck: friendly explanation + their commlink numbers. */
function CommlinkView({ game, actor }) {
  const p = personaOf(game, actor);
  const ds = deckStats(actor, p);
  const fw = ds.eff.firewall;
  const rows = [
    [t('Défense contre le hacking (Hacker à la volée, Pointe de données…)'), t('Intuition + Firewall = {n} dés', { n: attr(actor, 'INT') + fw })],
    [t('Défense contre la force brute'), t('Volonté + Firewall = {n} dés', { n: attr(actor, 'WIL') + fw })],
    [t('Résister aux dommages matriciels'), t('Indice + Firewall = {n} dés', { n: ds.deviceRating + fw + programSum(p, 'resistMatrix') })],
    [t('Initiative en RA'), matrixInitiative(actor, p, 'ar').text],
    [t('Moniteur matriciel'), t('{n} cases', { n: matrixMonitor(ds.deviceRating) })],
  ];
  const knownSkills = ACTIONS.filter((a) => a.skill && (actor.skills || []).some((s) => s.id === a.skill && s.rating > 0));
  return html`<div class="mx-commlink">
    <div class="mx-commlink-card">
      <div class="mx-deck-name">${actor.matrix.device || 'Commlink'}</div>
      <div class="small muted">${actor.name} · ${t('indice {n}', { n: ds.deviceRating })}</div>
      <div class="mx-asdf two">
        <div class="mx-asdf-cell"><span class="mx-asdf-k">${asdfShort('dataProcessing')}</span><b class="mono">${ds.eff.dataProcessing}</b><span class="mx-asdf-l">${t('Traitement')}</span></div>
        <div class="mx-asdf-cell"><span class="mx-asdf-k">${asdfShort('firewall')}</span><b class="mono">${fw}</b><span class="mx-asdf-l">${t('Firewall')}</span></div>
      </div>
    </div>
    <div class="mx-panel">
      <div class="mx-panel-title">${t('La Matrice, pour toi')}</div>
      <p>${t('Ton commlink te garde en ligne en réalité augmentée : messages, cartes, smartlink, affichages en surimpression. Pas de cyberdeck, donc pas d’attaque ni de discrétion matricielle — c’est le terrain du decker de l’équipe.')}</p>
      <p class="small muted">${t('Si un hacker ennemi s’en prend à ton commlink, le MJ lancera ta défense avec ces chiffres. Laisser ton appareil en mode silencieux ou le confier au PAN du decker te protège davantage.')}</p>
      <table class="sr mx-commlink-table"><tbody>${rows.map(([l, v]) => html`<tr key=${l}><td>${l}</td><td class="num-cell">${v}</td></tr>`)}</tbody></table>
      ${knownSkills.length > 0 && html`<p class="small">${t('Tu connais quand même quelques gestes : {list}.', { list: [...new Set(knownSkills.map(actionName))].slice(0, 6).join(', ') })}</p>`}
    </div>
  </div>`;
}

function PlayerMatrix({ game }) {
  const actors = matrixActors(game);
  const mine = (game.me.characterIds || []).map((id) => game.actors?.[id]).filter((a) => a && a.attributes);
  const [sel, setSel] = useState(null);
  useMatrixFocus(setSel);
  if (!mine.length) return html`<div class="page"><${Empty}>${t('Choisis un personnage pour accéder à la Matrice.')}</${Empty}></div>`;
  if (!actors.length) {
    return html`<div class="page"><div class="mx-commlink"><div class="mx-panel">
      <div class="mx-panel-title">${t('Matrice')}</div>
      <p>${t('{name} n’a ni commlink ni cyberdeck sur sa fiche. Demande au MJ d’en ajouter un (onglet Matrice de la fiche) ou passe à la Boutique.', { name: mine[0].name })}</p>
    </div></div></div>`;
  }
  const cur = actors.find((a) => a.id === sel) || actors.find((a) => isCyberdeck(a)) || actors[0];
  return html`<div class="page mx-page">
    <div class="page-title">
      <h2>${t('Matrice')}</h2>
      ${actors.length > 1 && html`<${Tabs} tabs=${actors.map((a) => ({ id: a.id, label: a.name }))} value=${cur.id} onChange=${setSel} />`}
    </div>
    ${isCyberdeck(cur) || game.matrix?.personas?.[cur.id]?.online ? html`<${Cockpit} game=${game} actorId=${cur.id} />` : html`<${CommlinkView} game=${game} actor=${cur} />`}
  </div>`;
}

function GmMatrixPage({ game }) {
  const [tab, setTab] = usePersistent('sr.matrix.tab', 'deckers');
  const [cockpitId, setCockpitId] = usePersistent('sr.matrix.cockpit', null);
  const [hostId, setHostId] = usePersistent('sr.matrix.host', 'host_hollow_pine');
  const actors = matrixActors(game).filter((a) => !a.retired);
  const personas = Object.values(game.matrix?.personas || {});
  const online = personas.filter((p) => p.online).length;
  const alerts = Object.values(game.matrix?.hosts || {}).filter((h) => h.alert === 'active').length;
  const cockpitActor = actors.find((a) => a.id === cockpitId) || actors.find((a) => isCyberdeck(a)) || null;
  const tabs = [
    { id: 'deckers', label: t('Deckers'), badge: online || null },
    { id: 'hosts', label: t('Hôtes'), badge: alerts || null },
    { id: 'cockpit', label: t('Cockpit') },
    { id: 'log', label: t('Journal') },
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'deckers';
  const openCockpit = (id) => {
    setCockpitId(id);
    setTab('cockpit');
  };
  useMatrixFocus(openCockpit);
  return html`<div class="page mx-page">
    <div class="page-title">
      <h2>${t('Matrice')}</h2>
      <div class="row wrap">
        <${Toggle} value=${!!game.matrix?.settings?.hideOverwatch} onChange=${(v) => act('matrix/settings', { hideOverwatch: v })} label=${t('Cacher le SO aux joueurs')} title=${t('Les deckers ne voient que leur dernière vérification (sauf programme Surveillance)')} />
      </div>
    </div>
    <${Tabs} tabs=${tabs} value=${current} onChange=${setTab} class="mx-tabs" />
    <div class="mx-tabbody">
      ${current === 'deckers' && html`<${DeckersView} game=${game} onCockpit=${openCockpit} />`}
      ${current === 'hosts' && html`<${HostsView} game=${game} selected=${hostId} onSelect=${setHostId} />`}
      ${current === 'cockpit' && (cockpitActor
        ? html`<div>
            <div class="row wrap mx-gm-row">
              <span class="faint small">${t('Piloter :')}</span>
              ${actors.map((a) => html`<button type="button" key=${a.id} class=${'mx-pill' + (a.id === cockpitActor.id ? ' on' : '')} onClick=${() => setCockpitId(a.id)}>${a.name}${game.matrix?.personas?.[a.id]?.online ? html` <${Badge} color="cyan">${t('en ligne')}</${Badge}>` : ''}</button>`)}
            </div>
            <${Cockpit} game=${game} actorId=${cockpitActor.id} />
          </div>`
        : html`<${Empty}>${t('Aucun personnage avec un appareil matriciel.')}</${Empty}>`)}
      ${current === 'log' && html`<div class="mx-panel"><${MatrixLog} game=${game} limit=${60} title=${t('Toute l’activité matricielle')} /></div>`}
    </div>
  </div>`;
}

export default function MatrixPage({ game }) {
  if (!game.matrix) return html`<div class="page"><${Empty}>${t('Le module Matrice n’est pas chargé côté serveur.')}</${Empty}></div>`;
  return isGM(game) ? html`<${GmMatrixPage} game=${game} />` : html`<${PlayerMatrix} game=${game} />`;
}
