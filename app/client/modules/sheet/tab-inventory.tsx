// Sheet tab « Inventaire »: weapons, armor and gear grouped by where they are — « Sur soi » and the actor's containers (bags,
// vehicles, safehouses…: actor.containers). Drag an item onto another card, or « Déplacer vers… » (touch). Owners and the GM move
// items, ready / stow weapons, wear armor, switch gear on, and add / rename / remove containers. Rules: ./inventory.js.
import { useState, type DragEvent } from 'react';
import { Button, Toggle, Select, IconButton, confirmAction, promptText } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, tn } from '../../lib/i18n.ts';
import { itemLabel, itemTitle, categoryLabel } from './common.tsx';
import { ON_BODY, CONTAINER_KINDS, isCarried, usesAmmo, isGrenade, isUnarmed, readyCount } from './inventory.ts';
import { gearHasEffects } from '/shared/modifiers.ts';
import type { Actor, Container, ContainerKind } from '../../../shared/types.ts';
import type { AnyItem, SheetCtx } from './types.ts';
import { ItemRef } from '../books/BookRef.tsx';

type LocatedList = 'weapons' | 'armor' | 'gear';
/** An item of the three located lists (weapons, armor, gear), with its list. */
interface Located {
  list: LocatedList;
  it: AnyItem; // Weapon | Armor | Gear: the row reads the fields of each list
}
/** A container card: an actor container, or the implicit « Sur soi ». */
type Group = Pick<Container, 'id' | 'name' | 'notes'> & { kind: ContainerKind | string; implicit?: boolean; items: Located[] };
type Place = { value: string; label: string };
const CONTAINER_LABELS = CONTAINER_KINDS as Record<string, string>;

const LIST_ICONS: Record<LocatedList, string> = { weapons: '⚔', armor: '⛨', gear: '◇' };
const LIST_TITLES: Record<LocatedList, string> = { weapons: tk('Weapon'), armor: tk('Armor'), gear: tk('Gear') };
const KIND_ICONS: Record<string, string> = { body: '🧥', bag: '🎒', vehicle: '🚗', safehouse: '🏠', other: '📦' };
const kindOptions = () => Object.entries(CONTAINER_KINDS).map(([value, label]) => ({ value, label: t(label) }));

/** Items of the three located lists, with their list: [{ list, it }]. Unarmed attacks are not things you carry. */
function locatedItems(actor: Actor): Located[] {
  const out: Located[] = [];
  for (const list of ['weapons', 'armor', 'gear'] as LocatedList[]) for (const it of (actor[list] || []) as AnyItem[]) if (it && !(list === 'weapons' && isUnarmed(it))) out.push({ list, it });
  return out;
}

interface ItemRowProps {
  s: SheetCtx;
  list: LocatedList;
  it: AnyItem;
  places: Place[];
  onDragStart: (e: DragEvent, list: LocatedList, it: AnyItem) => void;
}
function ItemRow({ s, list, it, places, onDragStart }: ItemRowProps) {
  const { actor, own } = s;
  const up = (patch: AnyItem) => send('actor/updateItem', { actorId: actor.id, list, itemId: it.id, patch }).catch(() => {});
  const move = async (location: string) => {
    try {
      const r = await send<{ stowed?: boolean }>('inventory/move', { actorId: actor.id, list, itemId: it.id, location });
      if (r?.stowed) toast(t('{item} stowed: it no longer counts (not ready, worn or active).', { item: itemLabel(it) }), 'info');
    } catch {}
  };
  const carried = isCarried(actor, it.location);
  let status = null;
  if (list === 'weapons') {
    status = own && carried
      ? <Toggle value={it.equipped !== false} onChange={(v) => up({ equipped: v })} title={t('Ready / stowed')} />
      : <span className={'badge ' + (it.equipped !== false ? 'badge-cyan' : '')}>{it.equipped !== false ? t('ready') : t('stowed')}</span>;
  } else if (list === 'armor') {
    status = own && carried
      ? <Toggle value={!!it.equipped} onChange={(v) => up({ equipped: v })} title={t('Equip / unequip')} />
      : <span className={'badge ' + (it.equipped ? 'badge-cyan' : '')}>{it.equipped ? t('worn') : t('stowed')}</span>;
  } else if (gearHasEffects(it, s.lookup)) {
    status = own && carried
      ? <Toggle value={!!it.active} onChange={(v) => up({ active: v })} title={t('Worn / switched on: its effects count in rolls')} />
      : <span className={'badge ' + (it.active ? 'badge-cyan' : '')}>{it.active ? t('active') : t('inactive')}</span>;
  }
  const extra = list === 'weapons' && usesAmmo(it) ? `${it.ammoLoaded ?? it.ammoMax}/${it.ammoMax}` : list === 'weapons' && isGrenade(it) ? `×${it.qty ?? 1}` : list === 'armor' ? `${it.stack ? '+' : ''}${it.rating ?? 0}` : null;
  return <div className={'sh-inv-row' + (own ? ' draggable' : '')} draggable={own} onDragStart={(e) => onDragStart(e, list, it)}>
    <span className="sh-inv-icon" title={t(LIST_TITLES[list])}>{LIST_ICONS[list]}</span>
    <div className="grow sh-inv-name">
      <span title={itemTitle(it)}>{itemLabel(it)}</span>
      {it.rating && list === 'gear' ? <>{' '}<span className="faint small">{t('rating {n}', { n: it.rating })}</span></> : null}{' '}
      <ItemRef item={it} />
      {categoryLabel(it) ? <div className="faint small">{categoryLabel(it)}</div> : null}
    </div>
    {extra !== null ? <span className="mono small">{extra}</span> : null}{list === 'gear' ? <span className="mono small" title={t('Quantity')}>×{it.qty ?? 1}</span> : null}{status}{own && <Select className="sh-inv-move" value="" title={t('Move to…')} onChange={(v) => v && move(v)} options={[{ value: '', label: t('Move to…') }, ...places.filter((p) => p.value !== (it.location || ON_BODY))]} />}
  </div>;
}

export function InventoryTab({ s }: { s: SheetCtx }) {
  const { actor, own } = s;
  const [closed, setClosed] = useState(() => new Set<string>());
  const [over, setOver] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('bag');
  const containers = actor.containers || [];
  const items = locatedItems(actor);
  const places: Place[] = [{ value: ON_BODY, label: t('Carried') }, ...containers.map((c) => ({ value: c.id, label: c.name }))];
  const groups: Group[] = [{ id: ON_BODY, name: t('Carried'), kind: 'body', implicit: true } as Omit<Group, 'items'>, ...containers].map((c) => ({
    ...c, items: items.filter(({ it }) => (it.location || ON_BODY) === c.id || (c.id === ON_BODY && !containers.some((x) => x.id === it.location))),
  }));
  const ready = readyCount(actor);

  const toggle = (id: string) => {
    const n = new Set(closed);
    n.has(id) ? n.delete(id) : n.add(id);
    setClosed(n);
  };
  const onDragStart = (e: DragEvent, list: LocatedList, it: AnyItem) => {
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify({ list, id: it.id }));
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
  };
  const drop = async (e: DragEvent, location: string) => {
    e.preventDefault();
    setOver(null);
    let data: { list?: LocatedList; id?: string } | null = null;
    try {
      data = JSON.parse(e.dataTransfer.getData('text/plain') || 'null');
    } catch {}
    if (!data?.id || !data.list) return;
    const want = data;
    const cur = ((actor[data.list] || []) as AnyItem[]).find((x) => x.id === want.id);
    if (!cur || (cur.location || ON_BODY) === location) return;
    try {
      const r = await send<{ stowed?: boolean }>('inventory/move', { actorId: actor.id, list: data.list, itemId: data.id, location });
      if (r?.stowed) toast(t('{item} stowed: it no longer counts (not ready, worn or active).', { item: itemLabel(cur) }), 'info');
    } catch {}
  };
  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await send('inventory/addContainer', { actorId: actor.id, name, kind: newKind });
      setNewName('');
    } catch {}
  };
  const rename = async (c: Group) => {
    const name = await promptText(t('New name:'), c.name);
    if (name && name.trim() && name.trim() !== c.name) send('inventory/updateContainer', { actorId: actor.id, containerId: c.id, patch: { name: name.trim() } }).catch(() => {});
  };
  const remove = async (c: Group) => {
    if (await confirmAction(t('Delete “{name}”? What it holds goes back to “Carried”.', { name: c.name }))) send('inventory/removeContainer', { actorId: actor.id, containerId: c.id }).catch(() => {});
  };

  return <div className="sh-inventory">
    <div className="muted small">
      {t('What is stored in a bag, a vehicle or a safehouse does not count: weapons not ready, armor not worn, gear inactive. Ammunition is taken from your person or a bag.')}
    </div>
    {ready.over && <div className="amber small">{t('Many ready weapons ({ranged} ranged, {melee} melee): usually 2 + 2 at most.', ready)}</div>}
    <div className="sh-inv-groups">
      {groups.map((c) => {
        const isClosed = closed.has(c.id);
        return <section key={c.id} className={'sh-inv-card sh-inv-' + (c.kind || 'other') + (over === c.id ? ' over' : '')} onDragOver={own ? (e) => { e.preventDefault(); if (over !== c.id) setOver(c.id); } : undefined} onDragLeave={own ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); } : undefined} onDrop={own ? (e) => drop(e, c.id) : undefined}>
          <header className="sh-inv-head">
            <button type="button" className="sh-inv-toggle" onClick={() => toggle(c.id)} aria-expanded={!isClosed}>
              <span>{isClosed ? '▸' : '▾'}</span>
              {' '}
              <span aria-hidden="true">{KIND_ICONS[c.kind] || KIND_ICONS.other}</span>
              {' '}
              <b>{c.name}</b>
              <span className="faint small">{tn(c.items.length, '{n} item', '{n} items')}</span>
            </button>
            {!c.implicit && <span className="badge">{t(CONTAINER_LABELS[c.kind] || CONTAINER_LABELS.other)}</span>}
            {own && !c.implicit && <span className="row gap-s">
              {(s.gm || c.kind === 'body' || c.kind === 'bag') && <Select className="sh-inv-kind" value={c.kind} options={kindOptions()} title={t('Container type')} onChange={(v) => send('inventory/updateContainer', { actorId: actor.id, containerId: c.id, patch: { kind: v } }).catch(() => {})} />}
              <IconButton icon="✎" title={t('Rename')} onClick={() => rename(c)} />
              <IconButton icon="✕" title={t('Delete the container')} onClick={() => remove(c)} />
            </span>}
          </header>
          {c.notes && !isClosed ? <div className="faint small">{c.notes}</div> : null}
          {!isClosed && (c.items.length
            ? <div className="sh-inv-list">
              {c.items.map(({ list, it }) => <ItemRow key={list + it.id} s={s} list={list} it={it} places={places} onDragStart={onDragStart} />)}
            </div>
            : <div className="muted small sh-inv-empty">{own ? t('Empty — drag an item here.') : t('Empty.')}</div>)}
        </section>;
      })}
    </div>
    {own && <div className="row wrap sh-inv-add">
      <input className="input" value={newName} placeholder={t('New container (backpack, car trunk…)')} maxLength={60} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <Select value={newKind} options={kindOptions()} onChange={setNewKind} />
      <Button small variant="primary" disabled={!newName.trim()} onClick={add}>{t('Add')}</Button>
    </div>}
  </div>;
}
