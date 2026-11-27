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
    [t('Défense contre le hacking (Hacker à la volée, Pointe de données…)'), t('Intuition + Firewall = {n} dés', { n: attr(actor, 'INT') + fw })],
    [t('Défense contre la force brute'), t('Volonté + Firewall = {n} dés', { n: attr(actor, 'WIL') + fw })],
    [t('Résister aux dommages matriciels'), t('Indice + Firewall = {n} dés', { n: ds.deviceRating + fw + programSum(p, 'resistMatrix') })],
    [t('Initiative en RA'), matrixInitiative(actor, p, 'ar').text],
    [t('Moniteur matriciel'), t('{n} cases', { n: matrixMonitor(ds.deviceRating) })],
  ];
  const knownSkills = ACTIONS.filter((a) => a.skill && (actor.skills || []).some((s) => s.id === a.skill && s.rating > 0));
  return (
    <div className="mx-commlink">
      <div className="mx-commlink-card">
        <div className="mx-deck-name">{actor.matrix?.device || 'Commlink'}</div>
        <div className="small muted">
          {actor.name} · {t('indice {n}', { n: ds.deviceRating })}
        </div>
        <div className="mx-asdf two">
          <div className="mx-asdf-cell">
            <span className="mx-asdf-k">{asdfShort('dataProcessing')}</span>
            <b className="mono">{ds.eff.dataProcessing}</b>
            <span className="mx-asdf-l">{t('Traitement')}</span>
          </div>
          <div className="mx-asdf-cell">
            <span className="mx-asdf-k">{asdfShort('firewall')}</span>
            <b className="mono">{fw}</b>
            <span className="mx-asdf-l">{t('Firewall')}</span>
          </div>
        </div>
      </div>
      <div className="mx-panel">
        <div className="mx-panel-title">{t('La Matrice, pour toi')}</div>
        <p>
          {t('Ton commlink te garde en ligne en réalité augmentée : messages, cartes, smartlink, affichages en surimpression. Pas de cyberdeck, donc pas d’attaque ni de discrétion matricielle — c’est le terrain du decker de l’équipe.')}
        </p>
        <p className="small muted">
          {t('Si un hacker ennemi s’en prend à ton commlink, le MJ lancera ta défense avec ces chiffres. Laisser ton appareil en mode silencieux ou le confier au PAN du decker te protège davantage.')}
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
        {knownSkills.length > 0 && <p className="small">{t('Tu connais quand même quelques gestes : {list}.', { list: [...new Set(knownSkills.map(actionName))].slice(0, 6).join(', ') })}</p>}
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
        <Empty>{t('Choisis un personnage pour accéder à la Matrice.')}</Empty>
      </div>
    );
  if (!actors.length) {
    return (
      <div className="page">
        <div className="mx-commlink">
          <div className="mx-panel">
            <div className="mx-panel-title">{t('Matrice')}</div>
            <p>{t('{name} n’a ni commlink ni cyberdeck sur sa fiche. Demande au MJ d’en ajouter un (onglet Matrice de la fiche) ou passe à la Boutique.', { name: mine[0].name })}</p>
          </div>
        </div>
      </div>
    );
  }
  const cur = actors.find((a) => a.id === sel) || actors.find((a) => isCyberdeck(a)) || actors[0];
  return (
    <div className="page mx-page">
      <div className="page-title">
        <h2>{t('Matrice')}</h2>
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
    { id: 'hosts', label: t('Hôtes'), badge: alerts || null },
    { id: 'cockpit', label: t('Cockpit') },
    { id: 'log', label: t('Journal') },
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
        <h2>{t('Matrice')}</h2>
        <div className="row wrap">
          <Toggle
            value={!!game.matrix?.settings?.hideOverwatch}
            onChange={(v) => act('matrix/settings', { hideOverwatch: v })}
            label={t('Cacher le SO aux joueurs')}
            title={t('Les deckers ne voient que leur dernière vérification (sauf programme Surveillance)')}
          />
          <Toggle
            value={!!game.matrix?.settings?.osTimer}
            onChange={(v) => act('matrix/settings', { osTimer: v })}
            label={t('Minuterie du SO')}
            title={t('+2D6 au SO toutes les 15 minutes réelles en ligne (SR5 p. 232), appliqué à la prochaine action matricielle')}
          />
          <Toggle
            value={game.matrix?.settings?.autoLaunchIc !== false}
            onChange={(v) => act('matrix/settings', { autoLaunchIc: v })}
            label={t('IC automatiques en combat')}
            title={t('À chaque nouveau tour de combat, un hôte en alerte avec un intrus lance sa prochaine IC (SR5 p. 248)')}
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
                <span className="faint small">{t('Piloter :')}</span>
                {actors.map((a) => (
                  <button type="button" key={a.id} className={'mx-pill' + (a.id === cockpitActor.id ? ' on' : '')} onClick={() => setCockpitId(a.id)}>
                    {a.name}
                    {game.matrix?.personas?.[a.id]?.online ? (
                      <>
                        {' '}
                        <Badge color="cyan">{t('en ligne')}</Badge>
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
            <Empty>{t('Aucun personnage avec un appareil matriciel.')}</Empty>
          ))}
        {current === 'log' && (
          <div className="mx-panel">
            <MatrixLog game={game} limit={60} title={t('Toute l’activité matricielle')} />
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
        <Empty>{t('Le module Matrice n’est pas chargé côté serveur.')}</Empty>
      </div>
    );
  return isGM(game) ? <GmMatrixPage game={game} /> : <PlayerMatrix game={game} />;
}
