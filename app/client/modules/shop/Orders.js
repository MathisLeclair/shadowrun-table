// Orders: GM approval queue (pending) and order history (players see their own orders only — server filter).
import { useState } from 'preact/hooks';
import { html, Button, Badge, Empty, Panel, TextInput, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { t, tk } from '../../lib/i18n.js';
import { nuyen, gradeLabel, timeAgo, STATUS_LABEL, STATUS_COLOR, FLAG_LABEL, FLAG_COLOR } from './common.js';
import { durText } from './avail.js';

const KIND_LABEL = { buy: tk('Achat'), sell: tk('Revente'), give: tk('Don du MJ'), karma: tk('Art martial (karma)') };
const kindLabel = (k) => (KIND_LABEL[k] ? t(KIND_LABEL[k]) : k);
/** Who placed the order: the server stores 'MJ' for the GM, else the player's name. */
const byLabel = (by) => (by === 'MJ' ? t('MJ') : by || '?');

function Lines({ order }) {
  return html`<ul class="shop-order-lines">
    ${order.items.map(
      (l) => html`<li>
        <span class="grow">${l.name}${l.target?.name ? html` <span class="cyan">→ ${l.target.name}</span>` : null}${l.techniques?.length ? html` <span class="muted">(${l.techniques.join(', ')})</span>` : null}${l.rating ? html` <span class="muted">${t('ind. {n}', { n: l.rating })}</span>` : null}${l.grade && l.grade !== 'standard' ? html` <span class="muted">${gradeLabel(l.grade)}</span>` : null}${l.qty > 1 ? html` <span class="muted">×${l.qty}</span>` : null}</span>
        ${l.legality === 'F' ? html`<${Badge} color="red">F</${Badge}>` : l.legality === 'R' ? html`<${Badge} color="amber">R</${Badge}>` : null}
        ${l.availValue !== undefined && order.kind !== 'sell' ? html`<span class="faint small mono" title=${t('Disponibilité')}>${t('D{n}', { n: l.availValue })}</span>` : null}
        ${l.essence ? html`<span class="faint small mono">${t('Ess {n}', { n: Math.round(l.essence * l.qty * 1000) / 1000 })}</span>` : null}
        ${l.availTest ? html`<span class="shop-avt ok small" title=${t('{hits} succès contre {opp} (dispo {avail})', { hits: l.availTest.hits, opp: l.availTest.availHits, avail: l.availTest.avail })}>${l.availTest.contact ? t('trouvé par {contact} en {delay}', { contact: l.availTest.contact, delay: durText(l.availTest.delayHours) }) : t('trouvé en {delay}', { delay: durText(l.availTest.delayHours) })}${l.availTest.tie ? ` · ${t('égalité')}` : ''}${l.availTest.tries > 1 ? ` · ${t('essai n° {n}', { n: l.availTest.tries })}` : ''}</span>${l.availTest.glitch ? html`<span class="shop-avt todo small" title=${t('Complication sur le test de disponibilité : attention indésirable (flics, yakuza, rivaux…), le MJ décide')}>⚠ ${t('complication')}</span>` : null}` : null}
        <span class="mono small">${l.karma ? t('{n} karma', { n: l.karma }) : l.unitCost === null || l.unitCost === undefined ? '?' : nuyen((l.unitCost + (l.surcharge || 0)) * l.qty)}${l.surcharge ? html` <span class="faint" title=${t('Surenchère pour trouver l’objet (+25 % du prix par dé)')}>${t('dont +{cost}', { cost: nuyen(l.surcharge * l.qty) })}</span>` : null}</span>
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
  const amount = total === '' ? null : Number(total);
  const after = order.kind === 'sell' ? have + (amount || 0) : have - (amount || 0);
  const karma = order.kind === 'karma';
  const karmaHave = Number(actor?.karma) || 0;
  const karmaAfter = karmaHave - (Number(order.karma) || 0);
  const resolve = async (approve) => {
    if (!approve && !(await confirmAction(t('Refuser cette commande ?')))) return;
    setBusy(true);
    try {
      const payload = { orderId: order.id, approve, note };
      if (approve && amount !== null && Number.isFinite(amount) && amount !== order.total) payload.total = amount;
      await send('shop/resolve', payload);
      toast(approve ? t('Commande validée') : t('Commande refusée'), approve ? 'success' : 'info');
    } catch {}
    setBusy(false);
  };
  return html`<div class="card shop-order pending">
    <div class="spread row wrap">
      <div class="row wrap gap-s">
        <${Badge} color=${order.kind === 'sell' ? 'cyan' : 'magenta'}>${kindLabel(order.kind)}</${Badge}>
        <button class="shop-link" onClick=${() => actor && openSheet(actor.id)}>${actor?.name || t('Personnage supprimé')}</button>
        <span class="faint small">${t('par {name} · {when}', { name: byLabel(order.by), when: timeAgo(order.ts) })}</span>
      </div>
      <div class="row gap-s">${(order.flags || []).map((f) => html`<${Badge} color=${FLAG_COLOR[f] || 'dim'}>${FLAG_LABEL[f] ? t(FLAG_LABEL[f]) : f}</${Badge}>`)}</div>
    </div>
    <${Lines} order=${order} />
    <div class="row wrap shop-order-foot">
      ${karma
        ? actor && html`<span class="small mono">${t('Karma')} ${karmaHave} → <span class=${karmaAfter < 0 ? 'red' : 'green'}>${karmaAfter}</span></span>`
        : html`<label class="row gap-s small">${order.kind === 'sell' ? t('Paiement') : t('Total')}
            <input class="input shop-price-input" type="number" min="0" value=${total} placeholder="¥" onInput=${(e) => setTotal(e.target.value)} />
          </label>
          ${actor && html`<span class="small mono">${nuyen(have)} → <span class=${after < 0 ? 'red' : 'green'}>${nuyen(after)}</span></span>`}`}
      <${TextInput} class="grow shop-note" live value=${note} onChange=${setNote} placeholder=${t('Note pour le joueur (optionnel)')} />
      <${Button} small variant="primary" disabled=${busy || (karma ? karmaAfter < 0 : (order.kind === 'sell' && amount === null) || (order.kind !== 'sell' && after < 0))} onClick=${() => resolve(true)}>${t('Valider')}</${Button}>
      <${Button} small variant="danger" disabled=${busy} onClick=${() => resolve(false)}>${t('Refuser')}</${Button}>
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
    if (!(await confirmAction(t('Annuler cette commande ?')))) return;
    try {
      await send('shop/cancel', { orderId: o.id });
      toast(t('Commande annulée'), 'info');
    } catch {}
  };
  const clear = async () => {
    if (!(await confirmAction(t('Effacer l’historique des commandes traitées ? (les commandes en attente sont conservées)')))) return;
    try {
      await send('shop/clearOrders');
    } catch {}
  };

  return html`<div class="shop-orders">
    <div class="section-title">${isGM ? t('À valider ({n})', { n: pending.length }) : t('En attente ({n})', { n: pending.length })}</div>
    ${!pending.length && html`<${Empty}>${t('Aucune commande en attente.')}</${Empty}>`}
    ${pending.map((o) =>
      isGM
        ? html`<${PendingCard} key=${o.id} order=${o} game=${game} />`
        : html`<div class="card shop-order pending" key=${o.id}>
            <div class="spread row wrap">
              <div class="row gap-s"><${Badge} color="amber">${t('En attente du MJ')}</${Badge}><span class="small">${game.actors?.[o.actorId]?.name || ''}</span><span class="faint small">${timeAgo(o.ts)}</span></div>
              <${Button} small variant="ghost" onClick=${() => cancel(o)}>${t('Annuler')}</${Button}>
            </div>
            <${Lines} order=${o} />
            <div class="right"><span class="muted small">${o.kind === 'sell' ? t('Proposé :') : t('Total :')} </span><strong class="mono">${o.kind === 'karma' ? t('{n} karma', { n: o.karma }) : o.total === null || o.total === undefined ? t('à fixer') : nuyen(o.total)}</strong></div>
          </div>`
    )}

    <div class="section-title row spread">
      <span>${t('Historique')}</span>
      <span class="row gap-s">
        ${isGM && actor && html`<label class="row gap-s small muted"><input type="checkbox" checked=${onlyActor} onChange=${(e) => setOnlyActor(e.target.checked)} /> ${t('{name} seulement', { name: actor.name })}</label>`}
        ${isGM && done.length > 0 && html`<${Button} small variant="ghost" onClick=${clear}>${t('Effacer')}</${Button}>`}
      </span>
    </div>
    ${!done.length && html`<${Empty}>${t('Aucune transaction pour l’instant.')}</${Empty}>`}
    ${done.length > 0 &&
    html`<${Panel} pad=${false}>
      <table class="sr shop-history">
        <thead><tr><th>${t('Quand')}</th><th>${t('Type')}</th><th>${t('Runner')}</th><th>${t('Articles')}</th><th class="right">${t('Montant')}</th><th>${t('Statut')}</th></tr></thead>
        <tbody>
          ${done.slice(0, 150).map(
            (o) => html`<tr key=${o.id}>
              <td class="small faint">${timeAgo(o.resolvedTs || o.ts)}</td>
              <td class="small">${kindLabel(o.kind)}</td>
              <td class="small">${game.actors?.[o.actorId]?.name || '—'}</td>
              <td class="small">${o.items.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(', ')}${o.gmNote ? html`<div class="faint">« ${o.gmNote} »</div>` : null}</td>
              <td class=${'num-cell small' + (o.kind === 'sell' ? ' green' : '')}>${o.kind === 'karma' ? t('{n} karma', { n: `−${o.karma}` }) : o.kind === 'give' ? t('offert') : o.total === null || o.total === undefined ? '—' : `${o.kind === 'sell' ? '+' : '−'}${nuyen(o.total)}`}</td>
              <td><${Badge} color=${STATUS_COLOR[o.status] || 'dim'}>${STATUS_LABEL[o.status] ? t(STATUS_LABEL[o.status]) : o.status}</${Badge}></td>
            </tr>`
          )}
        </tbody>
      </table>
    </${Panel}>`}
  </div>`;
}
