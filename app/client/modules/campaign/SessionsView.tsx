// GM sessions: numbered list, plan & recap editors, played flag, linked doc.
import { useEffect, useRef, useState } from 'react';
import { Button, Badge, Toggle, TextInput, Empty, Tabs, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { campaignOf, MdEditor, useDocs, DocSelect, DocButton, cx, fmtSessionDate, nextSession, usePersistent } from './common.tsx';
import type { CampaignSession, GameView } from '../../../shared/types.ts';
import type { CampaignNav, DocsState, Focus } from './types.ts';

interface SessionCardProps {
  session: CampaignSession;
  open: boolean;
  onToggle: () => void;
  nav: CampaignNav;
  docs: DocsState;
  isNext: boolean;
  highlight: boolean;
}
function SessionCard({ session, open, onToggle, nav, docs, isNext, highlight }: SessionCardProps) {
  const [part, setPart] = useState<'plan' | 'recap'>(session.played ? 'recap' : 'plan');
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlight && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [highlight]);
  const patch = (p: Partial<CampaignSession>) => send('campaign/updateSession', { sessionId: session.id, patch: p });
  const recapTodo = session.played && (!session.recap.trim() || /à compléter/i.test(session.recap));

  return (
    <article ref={ref} className={cx('camp-session', session.played && 'played', isNext && 'next', open && 'open', highlight && 'flash')}>
      <header className="camp-session-head" onClick={onToggle}>
        <div className="camp-session-num">{session.number}</div>
        <div className="grow camp-quest-headtext">
          <div className="camp-quest-title">{session.title || t('Session {n}', { n: session.number })}</div>
          <div className="small muted">{session.date ? fmtSessionDate(session.date) : t('No date set')}</div>
        </div>
        {recapTodo && (
          <Badge color="amber" title={t('This session\'s recap has yet to be written')}>
            {t('Recap to do')}
          </Badge>
        )}
        {session.played ? <Badge color="green">{t('session::Played')}</Badge> : isNext ? <Badge color="cyan">{t('session::Next')}</Badge> : <Badge>{t('session::Planned')}</Badge>}
        <span className={cx('camp-chev', open && 'open')}>›</span>
      </header>
      {open && (
        <div className="camp-quest-body">
          <div className="camp-quest-meta">
            <label className="field camp-num-field">
              <span className="field-label">{t('#')}</span>
              <TextInput type="number" min="1" value={String(session.number)} onChange={(v) => Number(v) > 0 && patch({ number: Number(v) })} />
            </label>
            <label className="field grow">
              <span className="field-label">{t('Title')}</span>
              <TextInput value={session.title} placeholder={t('Session {n}', { n: session.number })} onChange={(title) => patch({ title })} />
            </label>
            <label className="field">
              <span className="field-label">{t('Date')}</span>
              <TextInput type="date" value={session.date} onChange={(date) => patch({ date })} />
            </label>
            <div className="field">
              <span className="field-label">{t('session::Played')}</span>
              <Toggle
                value={session.played}
                onChange={(played) => {
                  patch({ played });
                  if (played) setPart('recap');
                }}
                label={session.played ? t('Yes') : t('No')}
              />
            </div>
            <label className="field">
              <span className="field-label">{t('Document')}</span>
              <div className="row gap-s">
                <DocSelect value={session.doc} docs={docs.list} onChange={(doc) => patch({ doc })} />
                {session.doc && <DocButton docRef={session.doc} nav={nav} label={t('Open')} />}
              </div>
            </label>
          </div>
          <Tabs
            tabs={[
              { id: 'plan', label: t('Plan') },
              { id: 'recap', label: t('Recap'), badge: recapTodo ? '!' : null },
            ]}
            value={part}
            onChange={setPart}
          />
          {part === 'plan' ? (
            <MdEditor
              key="plan"
              value={session.plan}
              rows={14}
              initialMode={session.plan ? 'preview' : 'edit'}
              placeholder={t('Planned scenes, NPCs, maps, things not to forget…')}
              onSave={(plan) => patch({ plan })}
            />
          ) : (
            <MdEditor
              key="recap"
              value={session.recap}
              rows={14}
              initialMode={session.recap ? 'preview' : 'edit'}
              placeholder={t("What actually happened at the table…")}
              onSave={(recap) => patch({ recap })}
            />
          )}
          <footer className="camp-quest-foot">
            <span className="faint small">{t("Tip: copy the essentials (no secrets) into the “Player recap”.")}</span>
            <Button
              small
              variant="danger"
              onClick={async () => {
                if (await confirmAction(t('Delete session #{n}?', { n: session.number }))) send('campaign/deleteSession', { sessionId: session.id });
              }}
            >
              {t('Delete')}
            </Button>
          </footer>
        </div>
      )}
    </article>
  );
}

export default function SessionsView({ game, nav, focus }: { game: GameView; nav: CampaignNav; focus: Focus | null }) {
  const c = campaignOf(game);
  const docs = useDocs();
  const sessions = [...c.sessions].sort((a, b) => a.number - b.number);
  const next = nextSession(c);
  const [openIds, setOpenIds] = usePersistent<string[]>('sr.campaign.openSessions', next ? [next.id] : []);
  const [flash, setFlash] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = usePersistent('sr.campaign.sessionsNewest', true);

  useEffect(() => {
    if (!focus) return;
    setOpenIds((ids) => (ids.includes(focus.id) ? ids : [...ids, focus.id]));
    setFlash(focus.id);
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [focus?.nonce]);

  const toggle = (id: string) => setOpenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const add = async () => {
    const id = await send<string>('campaign/addSession', {}).catch(() => null);
    if (id) {
      setOpenIds((ids) => [...ids, id]);
      setFlash(id);
    }
  };
  const list = newestFirst ? [...sessions].reverse() : sessions;

  return (
    <div className="camp-sessions">
      <div className="camp-toolbar">
        <span className="muted small">
          {t('{played} played · {planned} planned', { played: sessions.filter((s) => s.played).length, planned: sessions.filter((s) => !s.played).length })}
        </span>
        <span className="grow"></span>
        <Button small variant="ghost" onClick={() => setNewestFirst(!newestFirst)}>
          {newestFirst ? '↓ ' + t("Newest first") : '↑ ' + t("Oldest first")}
        </Button>
        <Button small variant="primary" onClick={add}>
          + {t('New session')}
        </Button>
      </div>
      {list.length ? (
        list.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            nav={nav}
            docs={docs}
            isNext={next?.id === s.id}
            open={openIds.includes(s.id)}
            onToggle={() => toggle(s.id)}
            highlight={flash === s.id}
          />
        ))
      ) : (
        <Empty>{t('No sessions. Create the first one!')}</Empty>
      )}
    </div>
  );
}
