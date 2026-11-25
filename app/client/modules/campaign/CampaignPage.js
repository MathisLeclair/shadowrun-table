// GM campaign page: dashboard, quests, sessions, threads, docs, handouts, notes, player recap.
import { useState } from 'preact/hooks';
import { html, Tabs, Empty, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
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
    return html`<div class="page"><${Empty}>Le module campagne n'est pas chargé côté serveur.</${Empty}></div>`;
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
  const openThreads = c.threads.filter((t) => t.state === 'open').length;
  const tabs = [
    { id: 'dash', label: 'Tableau de bord' },
    { id: 'quests', label: 'Quêtes', badge: activeQuests || null },
    { id: 'sessions', label: 'Séances' },
    { id: 'threads', label: 'Fils narratifs', badge: openThreads || null },
    { id: 'docs', label: 'Documents' },
    { id: 'handouts', label: 'Dossiers joueurs', badge: pendingHandouts || null },
    { id: 'notes', label: 'Notes MJ' },
    { id: 'recap', label: 'Récap joueurs' },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : 'dash';
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
        <p class="muted small">Ton bloc-notes de MJ — jamais visible par les joueurs. Markdown accepté ; enregistrement en quittant le champ ou avec Ctrl+S.</p>
        <${MdEditor} value=${c.notes} initialMode="split" rows=${26} tall placeholder="Idées, prochaines étapes, PNJ à improviser…"
          onSave=${(text) => send('campaign/updateNotes', { text })} />
      </div>`;
      break;
    case 'recap':
      body = html`<div class="camp-text-page">
        <div class="camp-warn small">
          <strong>Visible par tous les joueurs</strong> dans leur onglet « Dossiers » (section « L'histoire jusqu'ici »). Pas de secrets de MJ ici !
        </div>
        <${MdEditor} value=${c.playerRecap} initialMode="split" rows=${26} tall placeholder="Ce que les runners savent…"
          onSave=${(text) => send('campaign/updatePlayerRecap', { text })} />
      </div>`;
      break;
    default:
      body = html`<${Dashboard} game=${game} nav=${nav} />`;
  }

  return html`<div class="page camp-page">
    <div class="page-title">
      <h2>Campagne</h2>
      ${act && html`<div class="row gap-s camp-act-chip" title="Acte en cours"><${Badge} color="magenta">${act.title}</${Badge}></div>`}
    </div>
    <${Tabs} class="camp-tabs" tabs=${tabs} value=${current} onChange=${setTab} />
    <div class="camp-body">${body}</div>
  </div>`;
}
