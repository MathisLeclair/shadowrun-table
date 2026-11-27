// GM campaign page: dashboard, quests, sessions, threads, docs, handouts, notes, player recap.
import { useState, type ReactNode } from 'react';
import { Tabs, Empty, Badge, type TabDef } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { t } from '../../lib/i18n.js';
import { campaignOf, currentAct, usePersistent, parseDocRef, MdEditor } from './common.tsx';
import Dashboard from './Dashboard.tsx';
import QuestsView from './QuestsView.tsx';
import SessionsView from './SessionsView.tsx';
import ThreadsView from './ThreadsView.tsx';
import DocsView from './DocsView.tsx';
import HandoutsView from './HandoutsView.tsx';
import type { CampaignNav, DocTarget, Focus, FocusKind } from './types.ts';

export default function CampaignPage({ game }: GameProps) {
  const [tab, setTab] = usePersistent<string>('sr.campaign.tab', 'dash');
  const [doc, setDoc] = usePersistent<DocTarget | null>('sr.campaign.doc', null); // { name, anchor, nonce }
  const [focus, setFocus] = useState<Focus | null>(null); // { kind: 'quest'|'session'|'handout'|'thread', id, nonce }
  const c = campaignOf(game);

  if (!game.campaign) {
    return (
      <div className="page">
        <Empty>{t("Le module campagne n'est pas chargé côté serveur.")}</Empty>
      </div>
    );
  }

  const nav: CampaignNav = {
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
  const tabs: TabDef[] = [
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
  const focusFor = (kind: FocusKind) => (focus && focus.kind === kind ? focus : null);

  let body: ReactNode;
  switch (current) {
    case 'quests':
      body = <QuestsView game={game} nav={nav} focus={focusFor('quest')} />;
      break;
    case 'sessions':
      body = <SessionsView game={game} nav={nav} focus={focusFor('session')} />;
      break;
    case 'threads':
      body = <ThreadsView game={game} focus={focusFor('thread')} />;
      break;
    case 'docs':
      body = <DocsView target={doc} setTarget={setDoc} />;
      break;
    case 'handouts':
      body = <HandoutsView game={game} focus={focusFor('handout')} />;
      break;
    case 'notes':
      body = (
        <div className="camp-text-page">
          <p className="muted small">{t('Ton bloc-notes de MJ — jamais visible par les joueurs. Markdown accepté ; enregistrement en quittant le champ ou avec Ctrl+S.')}</p>
          <MdEditor
            value={c.notes}
            initialMode="split"
            rows={26}
            tall
            placeholder={t('Idées, prochaines étapes, PNJ à improviser…')}
            onSave={(text) => send('campaign/updateNotes', { text })}
          />
        </div>
      );
      break;
    case 'recap':
      body = (
        <div className="camp-text-page">
          <div className="camp-warn small">
            <strong>{t('Visible par tous les joueurs')}</strong> {t("dans leur onglet « Dossiers » (section « L'histoire jusqu'ici »). Pas de secrets de MJ ici !")}
          </div>
          <MdEditor
            value={c.playerRecap}
            initialMode="split"
            rows={26}
            tall
            placeholder={t('Ce que les runners savent…')}
            onSave={(text) => send('campaign/updatePlayerRecap', { text })}
          />
        </div>
      );
      break;
    default:
      body = <Dashboard game={game} nav={nav} />;
  }

  return (
    <div className="page camp-page">
      <div className="page-title">
        <h2>{t('Campagne')}</h2>
        {act && (
          <div className="row gap-s camp-act-chip" title={t('Acte en cours')}>
            <Badge color="magenta">{act.title}</Badge>
          </div>
        )}
      </div>
      <Tabs className="camp-tabs" tabs={tabs} value={current} onChange={setTab} />
      <div className="camp-body">{body}</div>
    </div>
  );
}
