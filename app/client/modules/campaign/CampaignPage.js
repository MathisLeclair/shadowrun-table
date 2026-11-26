// GM campaign page: dashboard, quests, sessions, threads, docs, handouts, notes, player recap.
import { useState } from 'preact/hooks';
import { html, Tabs, Empty, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { t } from '../../lib/i18n.js';
import { campaignOf, currentAct, usePersistent, parseDocRef, MdEditor } from './common.js';
import Dashboard from './Dashboard.js';
import QuestsView from './QuestsView.js';
import SessionsView from './SessionsView.js';
import ThreadsView from './ThreadsView.js';
import DocsView from './DocsView.js';
import HandoutsView from './HandoutsView.js';

export default function CampaignPage({ game }) {
  const [tab, setTab] = usePersistent('sr.campaign.tab', 'dash');
  const [doc, setDoc] = usePersistent('sr.campaign.doc', null); // { name, anchor, nonce }
  const [focus, setFocus] = useState(null); // { kind: 'quest'|'session'|'handout'|'thread', id, nonce }
  const c = campaignOf(game);

  if (!game.campaign) {
    return html`<div class="page"><${Empty}>${t("Le module campagne n'est pas chargé côté serveur.")}</${Empty}></div>`;
  }

  const nav = {
    go: setTab,
    openDoc(ref) {
      const r = parseDocRef(ref);
      if (!r) return;
      setDoc({ ...r, nonce: Date.now() });
      setTab('docs');
    },
    open(kind, id) {
      setFocus({ kind, id, nonce: Date.now() });
      setTab({ quest: 'quests', session: 'sessions', handout: 'handouts', thread: 'threads' }[kind] || 'dash');
    },
  };

  const pendingHandouts = c.handouts.filter((h) => h.revealedTo !== 'all' && !(h.revealedTo || []).length).length;
  const activeQuests = c.quests.filter((q) => q.status === 'active').length;
  const openThreads = c.threads.filter((th) => th.state === 'open').length;
  const tabs = [
    { id: 'dash', label: t('Tableau de bord') },
    { id: 'quests', label: t('Quêtes'), badge: activeQuests || null },
    { id: 'sessions', label: t('Séances') },
    { id: 'threads', label: t('Fils narratifs'), badge: openThreads || null },
    { id: 'docs', label: t('Documents') },
    { id: 'handouts', label: t('Dossiers joueurs'), badge: pendingHandouts || null },
    { id: 'notes', label: t('Notes MJ') },
    { id: 'recap', label: t('Récap joueurs') },
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'dash';
  const act = currentAct(c);
  const focusFor = (kind) => (focus && focus.kind === kind ? focus : null);

  let body;
  switch (current) {
    case 'quests':
      body = html`<${QuestsView} game=${game} nav=${nav} focus=${focusFor('quest')} />`;
      break;
    case 'sessions':
      body = html`<${SessionsView} game=${game} nav=${nav} focus=${focusFor('session')} />`;
      break;
    case 'threads':
      body = html`<${ThreadsView} game=${game} nav=${nav} focus=${focusFor('thread')} />`;
      break;
    case 'docs':
      body = html`<${DocsView} target=${doc} setTarget=${setDoc} />`;
      break;
    case 'handouts':
      body = html`<${HandoutsView} game=${game} nav=${nav} focus=${focusFor('handout')} />`;
      break;
    case 'notes':
      body = html`<div class="camp-text-page">
        <p class="muted small">${t('Ton bloc-notes de MJ — jamais visible par les joueurs. Markdown accepté ; enregistrement en quittant le champ ou avec Ctrl+S.')}</p>
        <${MdEditor} value=${c.notes} initialMode="split" rows=${26} tall placeholder=${t('Idées, prochaines étapes, PNJ à improviser…')}
          onSave=${(text) => send('campaign/updateNotes', { text })} />
      </div>`;
      break;
    case 'recap':
      body = html`<div class="camp-text-page">
        <div class="camp-warn small">
          <strong>${t('Visible par tous les joueurs')}</strong> ${t("dans leur onglet « Dossiers » (section « L'histoire jusqu'ici »). Pas de secrets de MJ ici !")}
        </div>
        <${MdEditor} value=${c.playerRecap} initialMode="split" rows=${26} tall placeholder=${t('Ce que les runners savent…')}
          onSave=${(text) => send('campaign/updatePlayerRecap', { text })} />
      </div>`;
      break;
    default:
      body = html`<${Dashboard} game=${game} nav=${nav} />`;
  }

  return html`<div class="page camp-page">
    <div class="page-title">
      <h2>${t('Campagne')}</h2>
      ${act && html`<div class="row gap-s camp-act-chip" title=${t('Acte en cours')}><${Badge} color="magenta">${act.title}</${Badge}></div>`}
    </div>
    <${Tabs} class="camp-tabs" tabs=${tabs} value=${current} onChange=${setTab} />
    <div class="camp-body">${body}</div>
  </div>`;
}
