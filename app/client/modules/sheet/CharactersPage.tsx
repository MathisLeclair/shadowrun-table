// GM « Personnages »: runner cards, NPC actors on the field, creation, import, end-of-session rewards, rest.
import { useRef, useState, type ChangeEvent } from 'react';
import { Button, Badge, Select, NumberInput, TextInput, Empty, IconButton, confirmAction, promptText } from '../../lib/ui.tsx';
import { send, api } from '../../lib/net.ts';
import { openSheet, toast } from '../../lib/ui-store.ts';
import { derive } from '/shared/sr5.js';
import { t, tIfKnown, metatypeLabel, fmtNuyen, compare, getLang } from '../../lib/i18n.js';
import { Avatar, MiniBar, Overlay, ownerOf, actorStatus, statusColor, statusLabel, EdgePips, cssVars } from './common.tsx';
import { ChummerGmPanel } from '../chummer/ChummerActions.js';

import type { GameProps } from '../../lib/net.ts';
import type { Actor, GameView } from '../../../shared/types.ts';
import './sheet.css';

function PcCard({ game, actor }: { game: GameView; actor: Actor }) {
  const d = derive(actor);
  const c: Partial<Actor['condition']> = actor.condition || {};
  const owner = ownerOf(game, actor.id);
  const online = owner && (game.online || []).includes(owner.id);
  const users = Object.values(game.users || {});
  const assign = (userId: string) => {
    if (!userId) {
      if (owner) send('users/assign', { userId: owner.id, characterId: actor.id, assign: false }).catch(() => {});
      return;
    }
    send('users/assign', { userId, characterId: actor.id, assign: true }).catch(() => {});
  };
  const status = actorStatus(actor);
  return <div className="card ch-card" style={cssVars({ '--pc': actor.color || '#3fd6d0' })}>
    <div className="ch-card-top clickable" onClick={() => openSheet(actor.id)} title={t('Ouvrir la fiche')}>
      <Avatar actor={actor} size={52} />
      <div className="grow">
        <h4>{actor.name}</h4>
        <div className="muted small ch-ellipsis">{actor.concept || metatypeLabel(actor.metatype)}</div>
        <div className="row wrap gap-s small">
          <span className={'sh-online' + (online ? ' on' : '')}>{owner ? owner.name : t('non attribué')}</span>
          {actor.player && <span className="faint">({actor.player})</span>}
        </div>
      </div>
      {status !== 'indemne' && <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>}
    </div>
    <div className="ch-bars">
      <MiniBar label={t('moniteur::P')} kind="physical" value={c.physical || 0} max={d.physicalMonitor} />
      <MiniBar label={t('moniteur::É')} kind="stun" value={c.stun || 0} max={d.stunMonitor} />
    </div>
    <div className="row spread wrap ch-stats">
      <span title={t('Karma disponible / carrière')}>
        <span className="faint">{t('Karma')}</span>
        {' '}
        <b className="amber">{actor.karma}</b>
        <span className="faint">/{actor.karmaTotal}</span>
      </span>
      <span><span className="faint">¥</span>{' '}<b className="cyan">{fmtNuyen(actor.nuyen)}</b></span>
      <span className="row gap-s"><span className="faint">{t('Chance')}</span><EdgePips actor={actor} canUse={true} size="sm" /></span>
    </div>
    <div className="row ch-assign">
      <span className="faint small">{t('Joueur')}</span>
      <Select value={owner?.id || ''} options={[{ value: '', label: t('— personne —') }, ...users.map((u) => ({ value: u.id, label: u.name }))]} onChange={assign} />
    </div>
  </div>;
}

function NpcRow({ actor }: { actor: Actor }) {
  const d = derive(actor);
  const c: Partial<Actor['condition']> = actor.condition || {};
  const status = actorStatus(actor);
  const del = async () => {
    if (await confirmAction(t('Supprimer {name} (et son pion) ?', { name: actor.name }))) send('actor/delete', { actorId: actor.id }).catch(() => {});
  };
  return <div className={'ch-npc' + (status === 'mort' || status === 'hors de combat' ? ' down' : '')}>
    <Avatar actor={actor} size={28} />
    <button type="button" className="ch-npc-name" onClick={() => openSheet(actor.id)} title={t('Ouvrir la fiche')}>{actor.name}</button>
    {actor.hidden && <Badge>{t('caché')}</Badge>}
    <div className="ch-npc-bars">
      <MiniBar kind="physical" value={c.physical || 0} max={d.physicalMonitor} />
      <MiniBar kind="stun" value={c.stun || 0} max={d.stunMonitor} />
    </div>
    <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>
    <IconButton icon="✕" title={t('Supprimer')} onClick={del} />
  </div>;
}

function RewardsDialog({ game, onClose }: { game: GameView; onClose: () => void }) {
  const pcs = (Object.values(game.actors) as Actor[]).filter((a) => a.type === 'pc' && !a.retired && a.attributes);
  const [sel, setSel] = useState(() => new Set(pcs.map((a) => a.id)));
  const [karma, setKarma] = useState(5);
  const [ny, setNy] = useState(0);
  const [reason, setReason] = useState(() => t('Fin de séance'));
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => {
    const n = new Set(sel);
    n.has(id) ? n.delete(id) : n.add(id);
    setSel(n);
  };
  const go = async () => {
    setBusy(true);
    try {
      await send('actor/adjust', { actorIds: [...sel], karma, nuyen: ny, reason });
      toast(t('Récompenses distribuées'), 'success');
      onClose();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return <Overlay title={t('Récompenses de fin de séance')} onClose={onClose} width={520}>
    <div className="col">
      <div className="ch-reward-pcs">
        {pcs.map(
          (a) => <label className={'ch-reward-pc' + (sel.has(a.id) ? ' on' : '')} key={a.id} style={cssVars({ '--pc': a.color || '#3fd6d0' })}>
            <input type="checkbox" checked={sel.has(a.id)} onChange={() => toggle(a.id)} />
            <Avatar actor={a} size={28} />
            <span>{a.name}</span>
          </label>
        )}
      </div>
      <div className="row wrap">
        <div className="field">
          <span className="field-label">{t('Karma (chacun)')}</span>
          <NumberInput value={karma} min={-100} max={100} onChange={setKarma} />
        </div>
        <div className="field">
          <span className="field-label">{t('Nuyens (chacun)')}</span>
          <NumberInput value={ny} min={-1000000} max={1000000} step={500} onChange={setNy} />
        </div>
      </div>
      <label className="field">
        <span className="field-label">{t('Raison (historique et journal)')}</span>
        <TextInput live value={reason} onChange={setReason} />
      </label>
      <div className="muted small">
        {t('Le karma positif s’ajoute aussi au karma de carrière. Chaque runner reçoit une ligne dans son historique.')}
      </div>
      <div className="row spread">
        <span className="muted small">{t('{n} runner(s)', { n: sel.size })}</span>
        <div className="row">
          <Button variant="ghost" onClick={onClose}>{t('Annuler')}</Button>
          <Button variant="primary" disabled={busy || !sel.size || (!karma && !ny)} onClick={go}>{t('Distribuer')}</Button>
        </div>
      </div>
    </div>
  </Overlay>;
}

export default function CharactersPage({ game }: GameProps) {
  const [rewards, setRewards] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const actors = Object.values(game.actors || {}) as Actor[]; // GM page: full sheets
  const pcs = actors.filter((a) => a.type === 'pc' && !a.retired).sort((a, b) => compare(a.name, b.name));
  const retired = actors.filter((a) => a.type === 'pc' && a.retired);
  const npcs = actors.filter((a) => a.type === 'npc');
  const groups: Record<string, Actor[]> = {};
  for (const a of npcs) (groups[a.templateId || ''] ||= []).push(a);
  const groupName = (tid: string): string => (tid ? game.bestiary?.[tid]?.name || t('Modèle inconnu') : t('PNJ sans modèle'));
  const unassigned = Object.values(game.users || {}).filter((u) => !(u.characterIds || []).some((id) => game.actors[id]));

  const create = async (type: 'pc' | 'npc') => {
    const name = await promptText(type === 'pc' ? t('Nom du nouveau runner :') : t('Nom du PNJ :'), '');
    if (!name || !name.trim()) return;
    try {
      const id = await send<string>('actor/create', { type, name: name.trim() });
      openSheet(id);
    } catch {}
  };
  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const res = await api<{ actorId: string; warnings?: string[] }>(`/api/chummer/import?type=pc&fileName=${encodeURIComponent(file.name)}`, { method: 'POST', body: new Blob([text], { type: 'text/plain' }), headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      toast(t('Fiche importée : {name}', { name: game.actors?.[res.actorId]?.name || file.name }), 'success');
      if (res.warnings?.length) toast(tIfKnown(res.warnings[0]), 'warn', 7000);
      openSheet(res.actorId);
    } catch (err) {
      toast((err as Error).message || t('Import impossible'), 'error');
    }
  };
  const rest = async () => {
    if (!(await confirmAction(t('Repos : recharger la Chance de tous les runners actifs et soigner leurs dommages étourdissants ?')))) return;
    try {
      await send('edge/refresh', { all: true });
      for (const a of pcs) if ((a.condition?.stun || 0) > 0) await send('actor/heal', { actorId: a.id, amount: a.condition.stun, type: 'S' });
      toast(t('Les runners ont récupéré'), 'success');
    } catch {}
  };
  const clearGroup = async (list: Actor[], label: string) => {
    if (!(await confirmAction(t('Supprimer {n} PNJ ({label}) et leurs pions ?', { n: list.length, label })))) return;
    send('actor/delete', { actorIds: list.map((a) => a.id) }).catch(() => {});
  };

  return <div className="page ch-page">
    <div className="page-title">
      <h2>{t('Personnages')}</h2>
      <div className="row wrap">
        <Button variant="primary" onClick={() => setRewards(true)}>{t('Récompenses de fin de séance')}</Button>
        <Button onClick={rest} title={t('Recharge la Chance, soigne l’étourdissant')}>{t('Repos')}</Button>
        <Button onClick={() => create('pc')}>{t('+ Runner')}</Button>
        <Button onClick={() => create('npc')}>{t('+ PNJ')}</Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()} title={t('Fiche Chummer5a (.chum5) ou export JSON d’une fiche')}>
          {t('Importer un .chum5')}
        </Button>
        <input ref={fileRef} type="file" accept=".chum5,.json,.xml" hidden onChange={importFile} />
      </div>
    </div>
    <ChummerGmPanel game={game} />
    <h3 className="section-title">{t('Runners ({n})', { n: pcs.length })}</h3>
    {pcs.length ? <div className="grid ch-grid">{pcs.map((a) => <PcCard game={game} actor={a} key={a.id} />)}</div> : <Empty>{t('Aucun runner actif.')}</Empty>}
    {unassigned.length > 0 && <div className="muted small ch-unassigned">
      {t('Joueurs sans personnage : {names} — attribue-leur un runner via le menu « Joueur » d’une carte.', { names: unassigned.map((u) => u.name).join(', ') })}
    </div>}
    {retired.length > 0 && <div>
      <button type="button" className="ch-toggle" onClick={() => setShowRetired(!showRetired)}>
        {showRetired ? '▾' : '▸'}{' '}{t('Retraités ({n})', { n: retired.length })}
      </button>
      {showRetired && <div className="grid ch-grid">{retired.map((a) => <PcCard game={game} actor={a} key={a.id} />)}</div>}
    </div>}
    <div className="ch-npc-head">
      <h3 className="section-title">{t('PNJ sur le terrain ({n})', { n: npcs.length })}</h3>
      {npcs.length > 0 && <Button small variant="danger" onClick={() => clearGroup(npcs, t('tous'))}>{t('Tout supprimer')}</Button>}
    </div>
    {npcs.length
      ? <div className="ch-npc-groups">
        {Object.entries(groups)
          .sort(([a], [b]) => compare(groupName(a), groupName(b)))
          .map(
            ([tid, list]) => <section className="panel ch-npc-group" key={tid || 'none'}>
              <header className="panel-head">
                <h3>{groupName(tid)}{' '}<span className="faint">×{list.length}</span></h3>
                <div className="panel-actions">
                  <Button small variant="ghost" onClick={() => clearGroup(list, groupName(tid))}>{t('Supprimer le groupe')}</Button>
                </div>
              </header>
              <div className="panel-body ch-npc-list">
                {list.sort((a, b) => a.name.localeCompare(b.name, getLang(), { numeric: true })).map((a) => <NpcRow actor={a} key={a.id} />)}
              </div>
            </section>
          )}
      </div>
      : <Empty>{t('Aucun PNJ en jeu. Fais apparaître des ennemis depuis le Bestiaire ou crée un PNJ.')}</Empty>}
    {rewards && <RewardsDialog game={game} onClose={() => setRewards(false)} />}
  </div>;
}

