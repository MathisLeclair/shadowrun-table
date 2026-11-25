// Orders: GM approval queue (pending) and order history (players see their own orders only — server filter).
import { useState } from 'preact/hooks';
import { html, Button, Badge, Empty, Panel, TextInput, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { nuyen, gradeLabel, timeAgo, STATUS_LABEL, STATUS_COLOR, FLAG_LABEL, FLAG_COLOR } from './common.js';

const KIND_LABEL = { buy: 'Achat', sell: 'Revente', give: 'Don du MJ' };

function Lines({ order }) {
  return html`<ul class="shop-order-lines">
    ${order.items.map(
      (l) => html`<li>
        <span class="grow">${l.name}${l.rating ? html` <span class="muted">ind. ${l.rating}</span>` : null}${l.grade && l.grade !== 'standard' ? html` <span class="muted">${gradeLabel(l.grade)}</span>` : null}${l.qty > 1 ? html` <span class="muted">×${l.qty}</span>` : null}</span>
        ${l.legality === 'F' ? html`<${Badge} color="red">F</${Badge}>` : l.legality === 'R' ? html`<${Badge} color="amber">R</${Badge}>` : null}
        ${l.availValue !== undefined && order.kind !== 'sell' ? html`<span class="faint small mono" title="Disponibilité">D${l.availValue}</span>` : null}
        ${l.essence ? html`<span class="faint small mono">Ess ${Math.round(l.essence * l.qty * 1000) / 1000}</span>` : null}
        <span class="mono small">${l.unitCost === null || l.unitCost === undefined ? '?' : nuyen(l.unitCost * l.qty)}</span>
      </li>`
    )}
  </ul>`;
}

function PendingCard({ order, game }) {
  const actor = game.actors?.[order.actorId];
  const [note, setNote] = useState('');
  const [total, setTotal] = useState(order.total ?? '');
  const [busy, setBusy] = useState(false);
  const have = Number(actor?.nuyen) || 0;
  const t = total === '' ? null : Number(total);
  const after = order.kind === 'sell' ? have + (t || 0) : have - (t || 0);
  const resolve = async (approve) => {
    if (!approve && !(await confirmAction('Refuser cette commande ?'))) return;
    setBusy(true);
    try {
      const payload = { orderId: order.id, approve, note };
      if (approve && t !== null && Number.isFinite(t) && t !== order.total) payload.total = t;
      await send('shop/resolve', payload);
      toast(approve ? 'Commande validée' : 'Commande refusée', approve ? 'success' : 'info');
    } catch {}
    setBusy(false);
  };
  return html`<div class="card shop-order pending">
    <div class="spread row wrap">
      <div class="row wrap gap-s">
        <${Badge} color=${order.kind === 'sell' ? 'cyan' : 'magenta'}>${KIND_LABEL[order.kind]}</${Badge}>
        <button class="shop-link" onClick=${() => actor && openSheet(actor.id)}>${actor?.name || 'Personnage supprimé'}</button>
        <span class="faint small">par ${order.by || '?'} · ${timeAgo(order.ts)}</span>
      </div>
      <div class="row gap-s">${(order.flags || []).map((f) => html`<${Badge} color=${FLAG_COLOR[f] || 'dim'}>${FLAG_LABEL[f] || f}</${Badge}>`)}</div>
    </div>
    <${Lines} order=${order} />
    <div class="row wrap shop-order-foot">
      <label class="row gap-s small">${order.kind === 'sell' ? 'Paiement' : 'Total'}
        <input class="input shop-price-input" type="number" min="0" value=${total} placeholder="¥" onInput=${(e) => setTotal(e.target.value)} />
      </label>
      ${actor && html`<span class="small mono">${nuyen(have)} → <span class=${after < 0 ? 'red' : 'green'}>${nuyen(after)}</span></span>`}
      <${TextInput} class="grow shop-note" live value=${note} onChange=${setNote} placeholder="Note pour le joueur (optionnel)" />
      <${Button} small variant="primary" disabled=${busy || (order.kind === 'sell' && t === null) || (order.kind !== 'sell' && after < 0)} onClick=${() => resolve(true)}>Valider</${Button}>
      <${Button} small variant="danger" disabled=${busy} onClick=${() => resolve(false)}>Refuser</${Button}>
    </div>
  </div>`;
}

export default function Orders({ game, actor }) {
  const isGM = game.me.role === 'gm';
  const all = (game.shop?.orders || []).slice().sort((a, b) => b.ts - a.ts);
  const [onlyActor, setOnlyActor] = useState(false);
  const pending = all.filter((o) => o.status === 'pending');
  const done = all.filter((o) => o.status !== 'pending' && (!onlyActor || !actor || o.actorId === actor.id));

  const cancel = async (o) => {
    if (!(await confirmAction('Annuler cette commande ?'))) return;
    try {
      await send('shop/cancel', { orderId: o.id });
      toast('Commande annulée', 'info');
    } catch {}
  };
  const clear = async () => {
    if (!(await confirmAction('Effacer l’historique des commandes traitées ? (les commandes en attente sont conservées)'))) return;
    try {
      await send('shop/clearOrders');
    } catch {}
  };

  return html`<div class="shop-orders">
    <div class="section-title">${isGM ? `À valider (${pending.length})` : `En attente (${pending.length})`}</div>
    ${!pending.length && html`<${Empty}>Aucune commande en attente.</${Empty}>`}
    ${pending.map((o) =>
      isGM
        ? html`<${PendingCard} key=${o.id} order=${o} game=${game} />`
        : html`<div class="card shop-order pending" key=${o.id}>
            <div class="spread row wrap">
              <div class="row gap-s"><${Badge} color="amber">En attente du MJ</${Badge}><span class="small">${game.actors?.[o.actorId]?.name || ''}</span><span class="faint small">${timeAgo(o.ts)}</span></div>
              <${Button} small variant="ghost" onClick=${() => cancel(o)}>Annuler</${Button}>
            </div>
            <${Lines} order=${o} />
            <div class="right"><span class="muted small">${o.kind === 'sell' ? 'Proposé : ' : 'Total : '}</span><strong class="mono">${o.total === null || o.total === undefined ? 'à fixer' : nuyen(o.total)}</strong></div>
          </div>`
    )}

    <div class="section-title row spread">
      <span>Historique</span>
      <span class="row gap-s">
        ${isGM && actor && html`<label class="row gap-s small muted"><input type="checkbox" checked=${onlyActor} onChange=${(e) => setOnlyActor(e.target.checked)} /> ${actor.name} seulement</label>`}
        ${isGM && done.length > 0 && html`<${Button} small variant="ghost" onClick=${clear}>Effacer</${Button}>`}
      </span>
    </div>
    ${!done.length && html`<${Empty}>Aucune transaction pour l’instant.</${Empty}>`}
    ${done.length > 0 &&
    html`<${Panel} pad=${false}>
      <table class="sr shop-history">
        <thead><tr><th>Quand</th><th>Type</th><th>Runner</th><th>Articles</th><th class="right">Montant</th><th>Statut</th></tr></thead>
        <tbody>
          ${done.slice(0, 150).map(
            (o) => html`<tr key=${o.id}>
              <td class="small faint">${timeAgo(o.resolvedTs || o.ts)}</td>
              <td class="small">${KIND_LABEL[o.kind] || o.kind}</td>
              <td class="small">${game.actors?.[o.actorId]?.name || '—'}</td>
              <td class="small">${o.items.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(', ')}${o.gmNote ? html`<div class="faint">« ${o.gmNote} »</div>` : null}</td>
              <td class=${'num-cell small' + (o.kind === 'sell' ? ' green' : '')}>${o.kind === 'give' ? 'offert' : o.total === null || o.total === undefined ? '—' : `${o.kind === 'sell' ? '+' : '−'}${nuyen(o.total)}`}</td>
              <td><${Badge} color=${STATUS_COLOR[o.status] || 'dim'}>${STATUS_LABEL[o.status] || o.status}</${Badge}></td>
            </tr>`
          )}
        </tbody>
      </table>
    </${Panel}>`}
  </div>`;
}
