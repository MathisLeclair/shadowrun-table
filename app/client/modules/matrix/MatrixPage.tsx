// « Matrice » tab: decker cockpit for players, commlink overview for non-deckers, hosts & deckers manager for the GM.
import { useEffect, useState } from 'react';
import { Tabs, Empty, Toggle, Badge, type TabDef } from '../../lib/ui.tsx';
import { useUI } from '../../lib/ui-store.ts';
import type { GameProps } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import { isCyberdeck, deckStats, matrixInitiative, matrixMonitor, programSum, ACTIONS } from './types.ts';
import { isGM, act, matrixActors, personaOf, MatrixLog, actionName, asdfShort, isFullActor } from './common.tsx';
import Cockpit from './Cockpit.tsx';
import { DeckersView, HostsView } from './GmMatrix.tsx';
import type { Actor, GameView } from '../../../shared/types.ts';
import './matrix.css';

function usePersistent<T>(key: string, initial: T): [T, (x: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : JSON.parse(s);
    } catch {
      return initial;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, JSON.stringify(x));
    } catch {}
  };
  return [v, set];
}

/** Actor requested by « Ouvrir la Matrice » on a sheet (ui-store key matrixFocus = { actorId, nonce }). */
function useMatrixFocus(onFocus: (actorId: string) => void) {
  const ui = useUI();
  const f = ui.matrixFocus as { actorId?: string; nonce?: number } | undefined;
  useEffect(() => {
    if (f?.actorId) onFocus(f.actorId);
  }, [f?.nonce]);
}

/** Players without a cyberdeck: friendly explanation + their commlink numbers. */
function CommlinkView({ game, actor }: { game: GameView; actor: Actor }) {
  const p = personaOf(game, actor);
  const ds = deckStats(actor, p);
  const fw = ds.eff.firewall;
  const rows: Array<[string, string]> = [
    [t('Defense against hacking (Hack on the Fly, Data Spike…)'), t('Intuition + Firewall = {n} dice', { n: attr(actor, 'INT') + fw })],
    [t('Defense against Brute Force'), t('Willpower + Firewall = {n} dice', { n: attr(actor, 'WIL') + fw })],
    [t('Resist Matrix damage'), t('Rating + Firewall = {n} dice', { n: ds.deviceRating + fw + programSum(p, 'resistMatrix') })],
    [t('AR initiative'), matrixInitiative(actor, p, 'ar').text],
    [t('Matrix Condition Monitor'), t('{n} boxes', { n: matrixMonitor(ds.deviceRating) })],
  ];
  const knownSkills = ACTIONS.filter((a) => a.skill && (actor.skills || []).some((s) => s.id === a.skill && s.rating > 0));
  return (
    <div className="mx-commlink">
      <div className="mx-commlink-card">
        <div className="mx-deck-name">{actor.matrix?.device || 'Commlink'}</div>
        <div className="small muted">
          {actor.name} · {t('rating {n}', { n: ds.deviceRating })}
        </div>
        <div className="mx-asdf two">
          <div className="mx-asdf-cell">
            <span className="mx-asdf-k">{asdfShort('dataProcessing')}</span>
            <b className="mono">{ds.eff.dataProcessing}</b>
            <span className="mx-asdf-l">{t('Data Processing')}</span>
          </div>
          <div className="mx-asdf-cell">
            <span className="mx-asdf-k">{asdfShort('firewall')}</span>
            <b className="mono">{fw}</b>
            <span className="mx-asdf-l">{t('Firewall')}</span>
          </div>
        </div>
      </div>
      <div className="mx-panel">
        <div className="mx-panel-title">{t('The Matrix, for you')}</div>
        <p>
          {t('Your commlink keeps you online in augmented reality: messages, maps, smartlink, overlays. No cyberdeck means no Matrix attacks or sleaze — that is the team decker’s turf.')}
        </p>
        <p className="small muted">
          {t('If an enemy hacker goes after your commlink, the GM rolls your defense with these numbers. Running silent or slaving your device to the decker’s PAN protects you better.')}
        </p>
        <table className="sr mx-commlink-table">
          <tbody>
            {rows.map(([l, v]) => (
              <tr key={l}>
                <td>{l}</td>
                <td className="num-cell">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {knownSkills.length > 0 && <p className="small">{t('You still know a few moves: {list}.', { list: [...new Set(knownSkills.map(actionName))].slice(0, 6).join(', ') })}</p>}
      </div>
    </div>
  );
}

function PlayerMatrix({ game }: GameProps) {
  const actors = matrixActors(game);
  const mine = (game.me.characterIds || []).map((id) => game.actors?.[id]).filter(isFullActor);
  const [sel, setSel] = useState<string | null>(null);
  useMatrixFocus(setSel);
  if (!mine.length)
    return (
      <div className="page">
        <Empty>{t('Pick a character to access the Matrix.')}</Empty>
      </div>
    );
  if (!actors.length) {
    return (
      <div className="page">
        <div className="mx-commlink">
          <div className="mx-panel">
            <div className="mx-panel-title">{t('Matrix')}</div>
            <p>{t('{name} has neither a commlink nor a cyberdeck on their sheet. Ask the GM to add one (Matrix tab of the sheet) or visit the Shop.', { name: mine[0].name })}</p>
          </div>
        </div>
      </div>
    );
  }
  const cur = actors.find((a) => a.id === sel) || actors.find((a) => isCyberdeck(a)) || actors[0];
  return (
    <div className="page mx-page">
      <div className="page-title">
        <h2>{t('Matrix')}</h2>
        {actors.length > 1 && <Tabs tabs={actors.map((a) => ({ id: a.id, label: a.name }))} value={cur.id} onChange={setSel} />}
      </div>
      {isCyberdeck(cur) || game.matrix?.personas?.[cur.id]?.online ? <Cockpit game={game} actorId={cur.id} /> : <CommlinkView game={game} actor={cur} />}
    </div>
  );
}

function GmMatrixPage({ game }: GameProps) {
  const [tab, setTab] = usePersistent('sr.matrix.tab', 'deckers');
  const [cockpitId, setCockpitId] = usePersistent<string | null>('sr.matrix.cockpit', null);
  const [hostId, setHostId] = usePersistent<string | null>('sr.matrix.host', 'host_hollow_pine');
  const actors = matrixActors(game).filter((a) => !a.retired);
  const personas = Object.values(game.matrix?.personas || {});
  const online = personas.filter((p) => p.online).length;
  const alerts = Object.values(game.matrix?.hosts || {}).filter((h) => h.alert === 'active').length;
  const cockpitActor = actors.find((a) => a.id === cockpitId) || actors.find((a) => isCyberdeck(a)) || null;
  const tabs: TabDef[] = [
    { id: 'deckers', label: t('Deckers'), badge: online || null },
    { id: 'hosts', label: t('Hosts'), badge: alerts || null },
    { id: 'cockpit', label: t('Cockpit') },
    { id: 'log', label: t('Log') },
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'deckers';
  const openCockpit = (id: string) => {
    setCockpitId(id);
    setTab('cockpit');
  };
  useMatrixFocus(openCockpit);
  return (
    <div className="page mx-page">
      <div className="page-title">
        <h2>{t('Matrix')}</h2>
        <div className="row wrap">
          <Toggle
            value={!!game.matrix?.settings?.hideOverwatch}
            onChange={(v) => act('matrix/settings', { hideOverwatch: v })}
            label={t('Hide the OS from players')}
            title={t('Deckers only see their last check (unless they run Baby Monitor)')}
          />
          <Toggle
            value={!!game.matrix?.settings?.osTimer}
            onChange={(v) => act('matrix/settings', { osTimer: v })}
            label={t('OS timer')}
            title={t('+2D6 OS every 15 real minutes online (SR5 p. 232), applied at the next Matrix action')}
          />
          <Toggle
            value={game.matrix?.settings?.autoLaunchIc !== false}
            onChange={(v) => act('matrix/settings', { autoLaunchIc: v })}
            label={t('Automatic IC in fights')}
            title={t('At each new Combat Turn, an alerted host with an intruder launches its next IC (SR5 p. 248)')}
          />
        </div>
      </div>
      <Tabs tabs={tabs} value={current} onChange={setTab} className="mx-tabs" />
      <div className="mx-tabbody">
        {current === 'deckers' && <DeckersView game={game} onCockpit={openCockpit} />}
        {current === 'hosts' && <HostsView game={game} selected={hostId} onSelect={setHostId} />}
        {current === 'cockpit' &&
          (cockpitActor ? (
            <div>
              <div className="row wrap mx-gm-row">
                <span className="faint small">{t('Pilot:')}</span>
                {actors.map((a) => (
                  <button type="button" key={a.id} className={'mx-pill' + (a.id === cockpitActor.id ? ' on' : '')} onClick={() => setCockpitId(a.id)}>
                    {a.name}
                    {game.matrix?.personas?.[a.id]?.online ? (
                      <>
                        {' '}
                        <Badge color="cyan">{t('online')}</Badge>
                      </>
                    ) : (
                      ''
                    )}
                  </button>
                ))}
              </div>
              <Cockpit game={game} actorId={cockpitActor.id} />
            </div>
          ) : (
            <Empty>{t('No character with a Matrix device.')}</Empty>
          ))}
        {current === 'log' && (
          <div className="mx-panel">
            <MatrixLog game={game} limit={60} title={t('All Matrix activity')} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function MatrixPage({ game }: GameProps) {
  if (!game.matrix)
    return (
      <div className="page">
        <Empty>{t('The Matrix module is not loaded on the server.')}</Empty>
      </div>
    );
  return isGM(game) ? <GmMatrixPage game={game} /> : <PlayerMatrix game={game} />;
}
