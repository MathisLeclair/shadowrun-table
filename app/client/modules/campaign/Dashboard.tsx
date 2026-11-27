// GM campaign dashboard: everything needed at the table in one screen.
import { Panel, Button, Markdown, Empty } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import {
  campaignOf, currentAct, nextSession, QUEST_STATUS_BY_ID, THREAD_STATES, npcInfo, mapInfo, spawnNpc,
  showMapToPlayers, openMap, revealHandout, useDocs, docTitle, DocButton, cx, fmtSessionDate,
} from './common.tsx';
import type { GameView, Quest, QuestPhase } from '../../../shared/types.ts';
import type { CampaignNav } from './types.ts';

function Progress({ phases }: { phases: QuestPhase[] }) {
  const done = phases.filter((p) => p.done).length;
  const pct = phases.length ? Math.round((done / phases.length) * 100) : 0;
  return (
    <div className="camp-progress" title={t('{done} / {total} phases', { done, total: phases.length })}>
      <div className="camp-progress-bar">
        <span style={{ width: pct + '%' }}></span>
      </div>
      <span className="mono small muted">
        {done}/{phases.length}
      </span>
    </div>
  );
}

function ActiveQuest({ game, quest, nav }: { game: GameView; quest: Quest; nav: CampaignNav }) {
  const next = quest.phases.filter((p) => !p.done).slice(0, 2);
  const activeMap = game.scene?.activeMapId;
  return (
    <div className="camp-dq">
      <div className="row spread wrap">
        <button className="camp-link camp-dq-title" onClick={() => nav.open('quest', quest.id)}>
          {quest.title}
        </button>
        <Progress phases={quest.phases} />
      </div>
      {next.length ? (
        <ul className="camp-checklist">
          {next.map((p) => (
            <li key={p.id}>
              <label className="camp-check">
                <input type="checkbox" checked={p.done} onChange={() => send('campaign/togglePhase', { questId: quest.id, phaseId: p.id })} />
                <span>{p.title}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted small">{t('All phases are checked — remember to close the quest.')}</div>
      )}
      <div className="camp-quick">
        {quest.npcs.map((id) => {
          const n = npcInfo(game, id);
          return (
            <span key={'n:' + id} className={cx('camp-chip', n.kind === 'missing' && 'missing')} title={n.kind === 'missing' ? t('Sheet not found: {id}', { id }) : n.folder}>
              ☠ {n.name}
              {n.kind === 'template' && (
                <button className="camp-chip-act" title={t('Place on the map')} onClick={() => spawnNpc(game, id)}>
                  + {t('Place')}
                </button>
              )}
            </span>
          );
        })}
        {quest.maps.map((id) => {
          const m = mapInfo(game, id);
          return (
            <span key={'m:' + id} className={cx('camp-chip camp-chip-map', !m.exists && 'missing', activeMap === id && 'live')} title={m.exists ? '' : t('Map not found: {id}', { id })}>
              ▦ {m.name}
              {m.exists && (
                <>
                  <button className="camp-chip-act" title={t('Open the map')} onClick={() => openMap(id)}>
                    {t('Open')}
                  </button>
                  {activeMap === id ? (
                    <span className="camp-live">● {t('Live')}</span>
                  ) : (
                    <button className="camp-chip-act" title={t('Show to players')} onClick={() => showMapToPlayers(game, id)}>
                      {t('Show')}
                    </button>
                  )}
                </>
              )}
            </span>
          );
        })}
        {quest.doc && <DocButton docRef={quest.doc} nav={nav} />}
      </div>
    </div>
  );
}

export default function Dashboard({ game, nav }: { game: GameView; nav: CampaignNav }) {
  const c = campaignOf(game);
  const act = currentAct(c);
  const docs = useDocs();
  const active = c.quests.filter((q) => q.status === 'active');
  const actQuests = act ? c.quests.filter((q) => q.actId === act.id) : [];
  const upcomingInAct = actQuests.filter((q) => q.status === 'upcoming');
  const session = nextSession(c);
  const lastPlayed = [...c.sessions].filter((s) => s.played).sort((a, b) => b.number - a.number)[0];
  const pending = c.handouts.filter((h) => h.revealedTo !== 'all' && !(h.revealedTo || []).length);

  return (
    <div className="camp-dash">
      <div className="camp-dash-main">
        <Panel
          title={t('Current act')}
          className="camp-dash-act"
          actions={
            <select
              className="input camp-mini-select"
              value={c.currentActId || ''}
              title={t("Choose the current act")}
              onChange={(e) => send('campaign/setCurrentAct', { actId: e.target.value || null })}
            >
              <option value="">{t('Automatic')}</option>
              {c.acts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          }
        >
          {act ? (
            <>
              <h3 className="camp-act-title">{act.title}</h3>
              <Markdown className="camp-act-summary" text={act.summary} />
              <div className="row wrap gap-s">
                {actQuests.map((q) => {
                  const st = QUEST_STATUS_BY_ID[q.status];
                  return (
                    <button key={q.id} className={cx('camp-qpill', `st-${q.status}`)} title={st ? t(st.label) : ''} onClick={() => nav.open('quest', q.id)}>
                      {q.title}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <Empty>{t('No act defined.')}</Empty>
          )}
        </Panel>

        <Panel
          title={t('Active quests ({n})', { n: active.length })}
          actions={
            <Button small variant="ghost" onClick={() => nav.go('quests')}>
              {t('All quests')}
            </Button>
          }
        >
          {active.length ? (
            active.map((q) => <ActiveQuest key={q.id} game={game} quest={q} nav={nav} />)
          ) : (
            <div className="muted">
              {t('No active quest.')}
              {upcomingInAct.length ? (
                <>
                  {' '}
                  {t('Next available:')}{' '}
                  <button className="camp-link" onClick={() => send('campaign/setQuestStatus', { questId: upcomingInAct[0].id, status: 'active' })}>
                    {t('start “{title}”', { title: upcomingInAct[0].title })}
                  </button>
                </>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title={session ? t('Next session — #{n}', { n: session.number }) : t('Next session')}
          actions={
            <>
              {session?.doc && <DocButton docRef={session.doc} nav={nav} />}
              {session ? (
                <Button small variant="ghost" onClick={() => nav.open('session', session.id)}>
                  {t('Open')}
                </Button>
              ) : (
                <Button
                  small
                  onClick={async () => {
                    const id = await send<string>('campaign/addSession', {});
                    nav.open('session', id);
                  }}
                >
                  + {t('Prepare the next session')}
                </Button>
              )}
            </>
          }
        >
          {session ? (
            <>
              <div className="row spread wrap">
                <h3 className="camp-sess-title">{session.title || t('Session {n}', { n: session.number })}</h3>
                {session.date && <span className="muted small">{fmtSessionDate(session.date)}</span>}
              </div>
              {session.plan ? <Markdown className="camp-dash-plan" text={session.plan} /> : <div className="muted">{t('Plan still empty.')}</div>}
              <div className="row gap-s camp-mt">
                <Button small onClick={() => send('campaign/updateSession', { sessionId: session.id, patch: { played: true } })}>
                  ✓ {t('Mark as played')}
                </Button>
              </div>
            </>
          ) : (
            <div className="muted">{t('All planned sessions have been played.')}</div>
          )}
          {lastPlayed && (
            <details className="camp-details">
              <summary>
                {t('Last session played — #{n}', { n: lastPlayed.number })} {lastPlayed.title ? `· ${lastPlayed.title}` : ''}
              </summary>
              {lastPlayed.recap ? <Markdown text={lastPlayed.recap} /> : <div className="muted small">{t('No recap yet.')}</div>}
            </details>
          )}
        </Panel>
      </div>

      <div className="camp-dash-side">
        <Panel
          title={t('Plot threads')}
          actions={
            <Button small variant="ghost" onClick={() => nav.go('threads')}>
              {t('Board')}
            </Button>
          }
        >
          <div className="camp-thread-counts">
            {THREAD_STATES.map((s) => (
              <div key={s.id} className={`camp-tc tc-${s.id}`}>
                <span className="mono">{c.threads.filter((th) => th.state === s.id).length}</span>
                <span>{t(s.label)}</span>
              </div>
            ))}
          </div>
          <ul className="camp-thread-list">
            {c.threads
              .filter((th) => th.state === 'open')
              .map((th) => (
                <li key={th.id}>
                  <button className="camp-link" title={th.notes} onClick={() => nav.open('thread', th.id)}>
                    {th.label}
                  </button>
                </li>
              ))}
          </ul>
        </Panel>

        <Panel
          title={t('Handouts to reveal ({n})', { n: pending.length })}
          actions={
            <Button small variant="ghost" onClick={() => nav.go('handouts')}>
              {t('Manage')}
            </Button>
          }
        >
          {pending.length ? (
            <ul className="camp-pending">
              {pending.map((h) => (
                <li key={h.id}>
                  <button className="camp-link grow" onClick={() => nav.open('handout', h.id)}>
                    {h.title}
                  </button>
                  <Button small variant="accent" title={t('Reveal to all players')} onClick={() => revealHandout(h.id, 'all')}>
                    {t('Reveal')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted small">{t('All prepared handouts have been shown.')}</div>
          )}
        </Panel>

        <Panel
          title={t('Campaign documents')}
          actions={
            <Button small variant="ghost" onClick={() => nav.go('docs')}>
              {t('Reader')}
            </Button>
          }
        >
          {docs.error ? (
            <div className="error small">{docs.error}</div>
          ) : docs.loading ? (
            <div className="muted small">{t('Loading…')}</div>
          ) : docs.list.length ? (
            <div className="camp-doc-links">
              {docs.list.map((d) => (
                <button key={d.name} className="camp-doc-link" onClick={() => nav.openDoc(d.name)}>
                  ❐ {docTitle(d.name)}
                </button>
              ))}
            </div>
          ) : (
            <div className="muted small">{t('No .md document found.')}</div>
          )}
        </Panel>

        <Panel title={t('Shortcuts')}>
          <div className="col gap-s">
            <Button small onClick={() => nav.go('notes')}>
              ✎ {t('GM notes')}
            </Button>
            <Button small onClick={() => nav.go('recap')}>
              ✉ {t('Player recap')}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
