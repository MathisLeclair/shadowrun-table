// Sheet tab « Inventaire »: weapons, armor and gear grouped by where they are — « Sur soi » and the actor's containers (bags,
// vehicles, safehouses…: actor.containers). Drag an item onto another card, or « Déplacer vers… » (touch). Owners and the GM move
// items, ready / stow weapons, wear armor, switch gear on, and add / rename / remove containers. Rules: ./inventory.js.
import { useState } from 'preact/hooks';
import { html, Button, Toggle, Select, IconButton, confirmAction, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tk, tn } from '../../lib/i18n.js';
import { itemLabel, itemTitle, categoryLabel } from './common.js';
import { ON_BODY, CONTAINER_KINDS, isCarried, usesAmmo, isGrenade, isUnarmed, readyCount } from './inventory.js';
import { gearHasEffects } from '/shared/modifiers.js';
import { ItemRef } from '../books/BookRef.js';

const LIST_ICONS = { weapons: '⚔', armor: '⛨', gear: '◇' };
const LIST_TITLES = { weapons: tk('Arme'), armor: tk('Armure'), gear: tk('Équipement') };
const KIND_ICONS = { body: '🧥', bag: '🎒', vehicle: '🚗', safehouse: '🏠', other: '📦' };
const kindOptions = () => Object.entries(CONTAINER_KINDS).map(([value, label]) => ({ value, label: t(label) }));

/** Items of the three located lists, with their list: [{ list, it }]. Unarmed attacks are not things you carry. */
function locatedItems(actor) {
  const out = [];
  for (const list of ['weapons', 'armor', 'gear']) for (const it of actor[list] || []) if (it && !(list === 'weapons' && isUnarmed(it))) out.push({ list, it });
  return out;
}

function ItemRow({ s, list, it, places, onDragStart }) {
  const { actor, own } = s;
  const up = (patch) => send('actor/updateItem', { actorId: actor.id, list, itemId: it.id, patch }).catch(() => {});
  const move = async (location) => {
    try {
      const r = await send('inventory/move', { actorId: actor.id, list, itemId: it.id, location });
      if (r?.stowed) toast(t('{item} rangé : il ne compte plus (ni prêt, ni porté, ni actif).', { item: itemLabel(it) }), 'info');
    } catch {}
  };
  const carried = isCarried(actor, it.location);
  let status = null;
  if (list === 'weapons') {
    status = own && carried
      ? html`<${Toggle} value=${it.equipped !== false} onChange=${(v) => up({ equipped: v })} title=${t('Prête / rangée')} />`
      : html`<span class=${'badge ' + (it.equipped !== false ? 'badge-cyan' : '')}>${it.equipped !== false ? t('prête') : t('rangée')}</span>`;
  } else if (list === 'armor') {
    status = own && carried
      ? html`<${Toggle} value=${!!it.equipped} onChange=${(v) => up({ equipped: v })} title=${t('Équiper / retirer')} />`
      : html`<span class=${'badge ' + (it.equipped ? 'badge-cyan' : '')}>${it.equipped ? t('portée') : t('rangée')}</span>`;
  } else if (gearHasEffects(it, s.lookup)) {
    status = own && carried
      ? html`<${Toggle} value=${!!it.active} onChange=${(v) => up({ active: v })} title=${t('Porté / activé : ses effets comptent dans les jets')} />`
      : html`<span class=${'badge ' + (it.active ? 'badge-cyan' : '')}>${it.active ? t('actif') : t('inactif')}</span>`;
  }
  const extra = list === 'weapons' && usesAmmo(it) ? `${it.ammoLoaded ?? it.ammoMax}/${it.ammoMax}` : list === 'weapons' && isGrenade(it) ? `×${it.qty ?? 1}` : list === 'armor' ? `${it.stack ? '+' : ''}${it.rating ?? 0}` : null;
  return html`<div class=${'sh-inv-row' + (own ? ' draggable' : '')} draggable=${own} onDragStart=${(e) => onDragStart(e, list, it)}>
    <span class="sh-inv-icon" title=${t(LIST_TITLES[list])}>${LIST_ICONS[list]}</span>
    <div class="grow sh-inv-name">
      <span title=${itemTitle(it)}>${itemLabel(it)}</span>${it.rating && list === 'gear' ? html` <span class="faint small">${t('indice {n}', { n: it.rating })}</span>` : null} <${ItemRef} item=${it} />
      ${categoryLabel(it) ? html`<div class="faint small">${categoryLabel(it)}</div>` : null}
    </div>
    ${extra !== null ? html`<span class="mono small">${extra}</span>` : null}
    ${list === 'gear' ? html`<span class="mono small" title=${t('Quantité')}>×${it.qty ?? 1}</span>` : null}
    ${status}
    ${own && html`<${Select} class="sh-inv-move" value="" title=${t('Déplacer vers…')} onChange=${(v) => v && move(v)}
      options=${[{ value: '', label: t('Déplacer vers…') }, ...places.filter((p) => p.value !== (it.location || ON_BODY))]} />`}
  </div>`;
}

export function InventoryTab({ s }) {
  const { actor, own } = s;
  const [closed, setClosed] = useState(() => new Set());
  const [over, setOver] = useState(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('bag');
  const containers = actor.containers || [];
  const items = locatedItems(actor);
  const places = [{ value: ON_BODY, label: t('Sur soi') }, ...containers.map((c) => ({ value: c.id, label: c.name }))];
  const groups = [{ id: ON_BODY, name: t('Sur soi'), kind: 'body', implicit: true }, ...containers].map((c) => ({
    ...c, items: items.filter(({ it }) => (it.location || ON_BODY) === c.id || (c.id === ON_BODY && !containers.some((x) => x.id === it.location))),
  }));
  const ready = readyCount(actor);

  const toggle = (id) => {
    const n = new Set(closed);
    n.has(id) ? n.delete(id) : n.add(id);
    setClosed(n);
  };
  const onDragStart = (e, list, it) => {
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify({ list, id: it.id }));
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
  };
  const drop = async (e, location) => {
    e.preventDefault();
    setOver(null);
    let data = null;
    try {
      data = JSON.parse(e.dataTransfer.getData('text/plain') || 'null');
    } catch {}
    if (!data?.id || !data.list) return;
    const cur = actor[data.list]?.find((x) => x.id === data.id);
    if (!cur || (cur.location || ON_BODY) === location) return;
    try {
      const r = await send('inventory/move', { actorId: actor.id, list: data.list, itemId: data.id, location });
      if (r?.stowed) toast(t('{item} rangé : il ne compte plus (ni prêt, ni porté, ni actif).', { item: itemLabel(cur) }), 'info');
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
  const rename = async (c) => {
    const name = await promptText(t('Nouveau nom :'), c.name);
    if (name && name.trim() && name.trim() !== c.name) send('inventory/updateContainer', { actorId: actor.id, containerId: c.id, patch: { name: name.trim() } }).catch(() => {});
  };
  const remove = async (c) => {
    if (await confirmAction(t('Supprimer « {name} » ? Ce qu’il contient revient « Sur soi ».', { name: c.name }))) send('inventory/removeContainer', { actorId: actor.id, containerId: c.id }).catch(() => {});
  };

  return html`<div class="sh-inventory">
    <div class="muted small">${t('Ce qui est rangé dans un sac, un véhicule ou une planque ne compte pas : armes non prêtes, armure non portée, équipement inactif. Les munitions se prennent sur soi ou dans un sac.')}</div>
    ${ready.over && html`<div class="amber small">${t('Beaucoup d’armes prêtes ({ranged} à distance, {melee} de mêlée) : en principe 2 + 2 au plus.', ready)}</div>`}
    <div class="sh-inv-groups">
      ${groups.map((c) => {
        const isClosed = closed.has(c.id);
        return html`<section key=${c.id} class=${'sh-inv-card sh-inv-' + (c.kind || 'other') + (over === c.id ? ' over' : '')}
            onDragOver=${own ? (e) => { e.preventDefault(); if (over !== c.id) setOver(c.id); } : null}
            onDragLeave=${own ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); } : null}
            onDrop=${own ? (e) => drop(e, c.id) : null}>
          <header class="sh-inv-head">
            <button type="button" class="sh-inv-toggle" onClick=${() => toggle(c.id)} aria-expanded=${!isClosed}>
              <span>${isClosed ? '▸' : '▾'}</span> <span aria-hidden="true">${KIND_ICONS[c.kind] || KIND_ICONS.other}</span> <b>${c.name}</b>
              <span class="faint small">${tn(c.items.length, '{n} objet', '{n} objets')}</span>
            </button>
            ${!c.implicit && html`<span class="badge">${t(CONTAINER_KINDS[c.kind] || CONTAINER_KINDS.other)}</span>`}
            ${own && !c.implicit && html`<span class="row gap-s">
              ${(s.gm || c.kind === 'body' || c.kind === 'bag') && html`<${Select} class="sh-inv-kind" value=${c.kind} options=${kindOptions()} title=${t('Type de contenant')} onChange=${(v) => send('inventory/updateContainer', { actorId: actor.id, containerId: c.id, patch: { kind: v } }).catch(() => {})} />`}
              <${IconButton} icon="✎" title=${t('Renommer')} onClick=${() => rename(c)} />
              <${IconButton} icon="✕" title=${t('Supprimer le contenant')} onClick=${() => remove(c)} />
            </span>`}
          </header>
          ${c.notes && !isClosed ? html`<div class="faint small">${c.notes}</div>` : null}
          ${!isClosed && (c.items.length
            ? html`<div class="sh-inv-list">${c.items.map(({ list, it }) => html`<${ItemRow} key=${list + it.id} s=${s} list=${list} it=${it} places=${places} onDragStart=${onDragStart} />`)}</div>`
            : html`<div class="muted small sh-inv-empty">${own ? t('Vide — glisse un objet ici.') : t('Vide.')}</div>`)}
        </section>`;
      })}
    </div>
    ${own && html`<div class="row wrap sh-inv-add">
      <input class="input" value=${newName} placeholder=${t('Nouveau contenant (sac à dos, coffre de la voiture…)')} maxLength=${60}
        onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && add()} />
      <${Select} value=${newKind} options=${kindOptions()} onChange=${setNewKind} />
      <${Button} small variant="primary" disabled=${!newName.trim()} onClick=${add}>${t('Ajouter')}</${Button}>
    </div>`}
  </div>`;
}
