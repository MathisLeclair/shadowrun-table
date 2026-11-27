// Main tab « Progression »: players spend karma on their runner; the GM validates, runs downtime and sets the rules.
import { useState } from 'react';
import './training.css';
import { Panel, Empty, Badge } from '../../lib/ui.tsx';
import { openSheet } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import type { GameProps } from '../../lib/net.ts';
import AdvancePanel from './AdvancePanel.tsx';
import GmTraining from './GmTraining.tsx';
import { KarmaHeader, JobList, RequestList, requestsOf, jobsOf, settingsOf, Rule, fullActor } from './common.tsx';

export default function TrainingPage({ game }: GameProps) {
  if (!game) return null;
  return game.me?.role === 'gm' ? <GmTraining game={game} /> : <PlayerTraining game={game} />;
}

function PlayerTraining({ game }: GameProps) {
  const ids = (game.me?.characterIds || []).filter((id) => game.actors?.[id]);
  const [sel, setSel] = useState<string | null>(null);
  const actorId = sel && ids.includes(sel) ? sel : ids[0];
  const actor = actorId ? fullActor(game.actors[actorId]) : null;
  if (!actor) {
    return (
      <div className="page">
        <div className="page-title">
          <h2>{t('Advancement')}</h2>
        </div>
        <Empty>{t('No character linked to your account — ask the GM to assign you one.')}</Empty>
      </div>
    );
  }
  const settings = settingsOf(game);
  const requests = requestsOf(game, actor.id);
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const jobs = jobsOf(actor);
  const mode =
    settings.approval === 'always'
      ? settings.useTime
        ? t('GM approval · training time')
        : t('GM approval · immediate effect')
      : settings.useTime
        ? t('Automatic approval · training time')
        : t('Automatic approval · immediate effect');
  return (
    <div className="page training-page">
      <div className="page-title">
        <div className="row wrap">
          <h2>{t('Advancement')}</h2>
          {ids.length > 1 ? (
            <span className="row gap-s">
              {ids.map((id) => (
                <button key={id} className={'training-pick' + (id === actor.id ? ' active' : '')} onClick={() => setSel(id)}>
                  {game.actors[id].name}
                </button>
              ))}
            </span>
          ) : (
            <button className="training-link training-actor-name" title={t('Open the sheet')} onClick={() => openSheet(actor.id)}>
              {actor.name}
            </button>
          )}
        </div>
        <KarmaHeader game={game} actor={actor} />
      </div>
      {actor.retired && <div className="training-warn">{t('This character is retired: no more advancement possible.')}</div>}
      <div className="training-layout">
        <Panel title={t('What do you want to improve?')} actions={<span className="small muted training-mode">{mode}</span>}>
          {actor.retired ? <Empty>{t('No more advancement for a retired runner.')}</Empty> : <AdvancePanel game={game} actor={actor} isGM={false} />}
        </Panel>
        <div className="col gap-l training-side">
          <Panel title={jobs.length ? t('In progress ({n})', { n: jobs.length }) : t('In progress')} actions={<Rule kind="instructor" />}>
            <JobList game={game} actor={actor} isGM={false} empty={t('No training in progress. Time passes during downtime, when the GM moves the calendar forward.')} />
          </Panel>
          <Panel title={t('My requests')} actions={pendingCount ? <Badge color="amber">{t('{n} pending', { n: pendingCount })}</Badge> : null}>
            <RequestList game={game} requests={requests} isGM={false} limit={25} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
