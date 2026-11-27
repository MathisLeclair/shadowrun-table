// GM « Personnages »: runner cards, NPC actors on the field, creation, import, end-of-session rewards, rest.
import { useRef, useState, type ChangeEvent } from 'react';
import { Button, Badge, Select, NumberInput, TextInput, Empty, IconButton, confirmAction, promptText } from '../../lib/ui.tsx';
import { send, api } from '../../lib/net.ts';
import { openSheet, toast } from '../../lib/ui-store.ts';
import { derive } from '/shared/sr5.ts';
import { t, tIfKnown, metatypeLabel, fmtNuyen, compare, getLang } from '../../lib/i18n.ts';
import { Avatar, MiniBar, Overlay, ownerOf, actorStatus, statusColor, statusLabel, EdgePips, cssVars } from './common.tsx';
import { ChummerGmPanel } from '../chummer/ChummerActions.tsx';

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
    <div className="ch-card-top clickable" onClick={() => openSheet(actor.id)} title={t('Open the sheet')}>
      <Avatar actor={actor} size={52} />
      <div className="grow">
        <h4>{actor.name}</h4>
        <div className="muted small ch-ellipsis">{actor.concept || metatypeLabel(actor.metatype)}</div>
        <div className="row wrap gap-s small">
          <span className={'sh-online' + (online ? ' on' : '')}>{owner ? owner.name : t('unassigned')}</span>
          {actor.player && <span className="faint">({actor.player})</span>}
        </div>
      </div>
      {status !== 'indemne' && <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>}
    </div>
    <div className="ch-bars">
      <MiniBar label={t('monitor::P')} kind="physical" value={c.physical || 0} max={d.physicalMonitor} />
      <MiniBar label={t('monitor::S')} kind="stun" value={c.stun || 0} max={d.stunMonitor} />
    </div>
    <div className="row spread wrap ch-stats">
      <span title={t('Available / career karma')}>
        <span className="faint">{t('Karma')}</span>
        {' '}
        <b className="amber">{actor.karma}</b>
        <span className="faint">/{actor.karmaTotal}</span>
      </span>
      <span><span className="faint">¥</span>{' '}<b className="cyan">{fmtNuyen(actor.nuyen)}</b></span>
      <span className="row gap-s"><span className="faint">{t('Edge')}</span><EdgePips actor={actor} canUse={true} size="sm" /></span>
    </div>
    <div className="row ch-assign">
      <span className="faint small">{t('Player')}</span>
      <Select value={owner?.id || ''} options={[{ value: '', label: t('— nobody —') }, ...users.map((u) => ({ value: u.id, label: u.name }))]} onChange={assign} />
    </div>
  </div>;
}

function NpcRow({ actor }: { actor: Actor }) {
  const d = derive(actor);
  const c: Partial<Actor['condition']> = actor.condition || {};
  const status = actorStatus(actor);
  const del = async () => {
    if (await confirmAction(t('Delete {name} (and their token)?', { name: actor.name }))) send('actor/delete', { actorId: actor.id }).catch(() => {});
  };
  return <div className={'ch-npc' + (status === 'mort' || status === 'hors de combat' ? ' down' : '')}>
    <Avatar actor={actor} size={28} />
    <button type="button" className="ch-npc-name" onClick={() => openSheet(actor.id)} title={t('Open the sheet')}>{actor.name}</button>
    {actor.hidden && <Badge>{t('hidden')}</Badge>}
    <div className="ch-npc-bars">
      <MiniBar kind="physical" value={c.physical || 0} max={d.physicalMonitor} />
      <MiniBar kind="stun" value={c.stun || 0} max={d.stunMonitor} />
    </div>
    <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>
    <IconButton icon="✕" title={t('Delete')} onClick={del} />
  </div>;
}

function RewardsDialog({ game, onClose }: { game: GameView; onClose: () => void }) {
  const pcs = (Object.values(game.actors) as Actor[]).filter((a) => a.type === 'pc' && !a.retired && a.attributes);
  const [sel, setSel] = useState(() => new Set(pcs.map((a) => a.id)));
  const [karma, setKarma] = useState(5);
  const [ny, setNy] = useState(0);
  const [reason, setReason] = useState(() => t('End of session'));
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
      toast(t('Rewards handed out'), 'success');
      onClose();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return <Overlay title={t('End-of-session rewards')} onClose={onClose} width={520}>
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
          <span className="field-label">{t('Karma (each)')}</span>
          <NumberInput value={karma} min={-100} max={100} onChange={setKarma} />
        </div>
        <div className="field">
          <span className="field-label">{t('Nuyen (each)')}</span>
          <NumberInput value={ny} min={-1000000} max={1000000} step={500} onChange={setNy} />
        </div>
      </div>
      <label className="field">
        <span className="field-label">{t('Reason (history and log)')}</span>
        <TextInput live value={reason} onChange={setReason} />
      </label>
      <div className="muted small">
        {t('Positive karma is also added to career karma. Each runner gets a line in their history.')}
      </div>
      <div className="row spread">
        <span className="muted small">{t('{n} runner(s)', { n: sel.size })}</span>
        <div className="row">
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={busy || !sel.size || (!karma && !ny)} onClick={go}>{t('Hand out')}</Button>
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
  const groupName = (tid: string): string => (tid ? game.bestiary?.[tid]?.name || t('Unknown template') : t('NPCs without a template'));
  const unassigned = Object.values(game.users || {}).filter((u) => !(u.characterIds || []).some((id) => game.actors[id]));

  const create = async (type: 'pc' | 'npc') => {
    const name = await promptText(type === 'pc' ? t('Name of the new runner:') : t('NPC name:'), '');
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
      toast(t('Sheet imported: {name}', { name: game.actors?.[res.actorId]?.name || file.name }), 'success');
      if (res.warnings?.length) toast(tIfKnown(res.warnings[0]), 'warn', 7000);
      openSheet(res.actorId);
    } catch (err) {
      toast((err as Error).message || t('Import failed'), 'error');
    }
  };
  const rest = async () => {
    if (!(await confirmAction(t('Rest: refresh the Edge of every active runner and heal their Stun damage?')))) return;
    try {
      await send('edge/refresh', { all: true });
      for (const a of pcs) if ((a.condition?.stun || 0) > 0) await send('actor/heal', { actorId: a.id, amount: a.condition.stun, type: 'S' });
      toast(t('The runners have recovered'), 'success');
    } catch {}
  };
  const clearGroup = async (list: Actor[], label: string) => {
    if (!(await confirmAction(t('Delete {n} NPC(s) ({label}) and their tokens?', { n: list.length, label })))) return;
    send('actor/delete', { actorIds: list.map((a) => a.id) }).catch(() => {});
  };

  return <div className="page ch-page">
    <div className="page-title">
      <h2>{t('Characters')}</h2>
      <div className="row wrap">
        <Button variant="primary" onClick={() => setRewards(true)}>{t('End-of-session rewards')}</Button>
        <Button onClick={rest} title={t('Refreshes Edge, heals Stun damage')}>{t('Rest')}</Button>
        <Button onClick={() => create('pc')}>{t('+ Runner')}</Button>
        <Button onClick={() => create('npc')}>{t('+ NPC')}</Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()} title={t('Chummer5a sheet (.chum5) or JSON sheet export')}>
          {t('Import a .chum5')}
        </Button>
        <input ref={fileRef} type="file" accept=".chum5,.json,.xml" hidden onChange={importFile} />
      </div>
    </div>
    <ChummerGmPanel game={game} />
    <h3 className="section-title">{t('Runners ({n})', { n: pcs.length })}</h3>
    {pcs.length ? <div className="grid ch-grid">{pcs.map((a) => <PcCard game={game} actor={a} key={a.id} />)}</div> : <Empty>{t('No active runners.')}</Empty>}
    {unassigned.length > 0 && <div className="muted small ch-unassigned">
      {t('Players without a character: {names} — assign them a runner with the “Player” menu of a card.', { names: unassigned.map((u) => u.name).join(', ') })}
    </div>}
    {retired.length > 0 && <div>
      <button type="button" className="ch-toggle" onClick={() => setShowRetired(!showRetired)}>
        {showRetired ? '▾' : '▸'}{' '}{t('Retired ({n})', { n: retired.length })}
      </button>
      {showRetired && <div className="grid ch-grid">{retired.map((a) => <PcCard game={game} actor={a} key={a.id} />)}</div>}
    </div>}
    <div className="ch-npc-head">
      <h3 className="section-title">{t('NPCs in play ({n})', { n: npcs.length })}</h3>
      {npcs.length > 0 && <Button small variant="danger" onClick={() => clearGroup(npcs, t('all'))}>{t('Delete all')}</Button>}
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
                  <Button small variant="ghost" onClick={() => clearGroup(list, groupName(tid))}>{t('Delete the group')}</Button>
                </div>
              </header>
              <div className="panel-body ch-npc-list">
                {list.sort((a, b) => a.name.localeCompare(b.name, getLang(), { numeric: true })).map((a) => <NpcRow actor={a} key={a.id} />)}
              </div>
            </section>
          )}
      </div>
      : <Empty>{t('No NPCs in play. Spawn enemies from the Bestiary or create an NPC.')}</Empty>}
    {rewards && <RewardsDialog game={game} onClose={() => setRewards(false)} />}
  </div>;
}

