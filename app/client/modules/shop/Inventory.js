// « Mon inventaire »: owned items with resale buttons, lifestyle rent, money ledger.
import { useState } from 'preact/hooks';
import { html, Button, Panel, Empty, NumberInput, Badge, confirmAction, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { ownedValue, nuyen, gradeLabel, timeAgo } from './common.js';

const LISTS = [
  { id: 'weapons', label: 'Armes', detail: (w) => [w.damage, w.ap ? `PA ${w.ap}` : '', w.mode].filter(Boolean).join(' · ') },
  { id: 'armor', label: 'Armures', detail: (a) => `${a.stack ? '+' : ''}${a.rating ?? 0} armure${a.equipped ? ' · portée' : ''}` },
  { id: 'augmentations', label: 'Augmentations', detail: (a) => [a.kind === 'bioware' ? 'Bioware' : 'Cyberware', a.rating ? `ind. ${a.rating}` : '', a.grade && a.grade !== 'standard' ? gradeLabel(a.grade) : '', `Ess ${a.essence ?? 0}`].filter(Boolean).join(' · ') },
  { id: 'gear', label: 'Équipement', detail: (g) => [g.category, g.rating ? `ind. ${g.rating}` : ''].filter(Boolean).join(' · ') },
  { id: 'vehicles', label: 'Véhicules & drones', detail: (v) => [`Man ${v.handling ?? '—'}`, `Vit ${v.speed ?? '—'}`, `Str ${v.body ?? '—'}`, `Bli ${v.armor ?? '—'}`].join(' · ') },
];

export default function Inventory({ game, actor, catalog }) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const [months, setMonths] = useState(1);
  const [qtys, setQtys] = useState({});
  if (!actor) return html`<${Empty}>Aucun personnage sélectionné.</${Empty}>`;
  const rate = Number(shop.sellRate) || 0;
  const pendingSales = new Set((shop.orders || []).filter((o) => o.status === 'pending' && o.kind === 'sell').map((o) => o.items[0]?.itemId));
  const canSell = isGM || shop.open;

  const sell = async (list, it) => {
    const have = list === 'gear' ? Math.max(1, Number(it.qty) || 1) : 1;
    const n = list === 'gear' ? Math.min(have, Math.max(1, qtys[it.id] || have)) : 1;
    const value = ownedValue(list, it, catalog);
    const offer = value === null ? null : Math.round((value * n * rate) / 100);
    let price;
    if (isGM) {
      const ans = await promptText(`Prix de revente de ${it.name}${n > 1 ? ` ×${n}` : ''} (¥)`, offer === null ? '' : String(offer));
      if (ans === null) return;
      price = Math.max(0, Math.round(Number(String(ans).replace(/[^\d.-]/g, '')) || 0));
    } else {
      const msg =
        offer === null
          ? `Revendre ${it.name} ? Cabana fixera le prix (validation du MJ).`
          : `Revendre ${it.name}${n > 1 ? ` ×${n}` : ''} à Cabana pour ${nuyen(offer)} (${rate} % de sa valeur) ?${list === 'augmentations' ? '\nL’Essence perdue ne revient pas.' : ''}`;
      if (!(await confirmAction(msg))) return;
    }
    try {
      const res = await send('shop/sell', { actorId: actor.id, list, itemId: it.id, qty: n, ...(isGM ? { price } : {}) });
      if (res?.status === 'pending') toast('Proposition de revente envoyée au MJ', 'info');
      else toast(`Vendu : +${nuyen(res?.total)}`, 'success');
    } catch {}
  };

  const payRent = async () => {
    const lf = actor.lifestyle;
    const cost = (Number(lf.monthlyCost) || 0) * months;
    if (!(await confirmAction(`Payer ${months} mois de ${lf.name} pour ${nuyen(cost)} ?`))) return;
    try {
      await send('shop/payLifestyle', { actorId: actor.id, months });
      toast('Loyer payé', 'success');
    } catch {}
  };

  const lf = actor.lifestyle;
  const ledger = (actor.history || []).slice(-25).reverse();
  const empty = LISTS.every((l) => !(actor[l.id] || []).length);

  return html`<div class="shop-inv">
    <div class="shop-inv-main">
      ${empty && html`<${Empty}>Inventaire vide.</${Empty}>`}
      ${LISTS.map((L) => {
        const items = actor[L.id] || [];
        if (!items.length) return null;
        return html`<${Panel} title=${`${L.label} (${items.length})`} pad=${false} class="shop-inv-panel">
          <table class="sr">
            <tbody>
              ${items.map((it) => {
                const value = ownedValue(L.id, it, catalog);
                const builtin = L.id === 'weapons' && !!it.augId; // implant weapon: sold with its augmentation
                const have = L.id === 'gear' ? Math.max(0, Number(it.qty ?? 1) || 0) : 1;
                const n = L.id === 'gear' ? Math.min(have, Math.max(1, qtys[it.id] || have)) : 1;
                const resale = value === null || builtin || have < 1 ? null : Math.round((value * n * rate) / 100);
                const pending = pendingSales.has(it.id);
                return html`<tr>
                  <td>
                    <div class="shop-row-name">${it.name}${L.id === 'gear' && have > 1 ? html` <span class="muted">×${have}</span>` : null}</div>
                    <div class="faint small">${L.detail(it)}</div>
                  </td>
                  <td class="num-cell small" title="Valeur de revente estimée">${builtin ? html`<span class="faint">intégrée (implant)</span>` : have < 1 ? html`<span class="faint">épuisé</span>` : resale === null ? html`<span class="faint">prix à fixer</span>` : nuyen(resale)}</td>
                  <td class="right shop-inv-actions">
                    ${L.id === 'gear' && have > 1 && html`<${NumberInput} small value=${n} min=${1} max=${have} onChange=${(v) => setQtys({ ...qtys, [it.id]: v })} />`}
                    ${builtin || have < 1
                      ? null
                      : pending
                      ? html`<${Badge} color="amber">Revente en attente</${Badge}>`
                      : html`<${Button} small variant="ghost" disabled=${!canSell} title=${canSell ? 'Revendre à Cabana' : 'Cabana est injoignable'} onClick=${() => sell(L.id, it)}>Revendre</${Button}>`}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </${Panel}>`;
      })}
    </div>
    <div class="shop-inv-side">
      <${Panel} title="Finances">
        <div class="row wrap">
          <div class="shop-wallet"><span class="stat-label">Nuyens</span><strong>${nuyen(actor.nuyen)}</strong></div>
          <div class="shop-wallet"><span class="stat-label">Revente</span><strong>${rate} %</strong></div>
        </div>
        <${Button} small variant="ghost" onClick=${() => openSheet(actor.id)}>Ouvrir la fiche</${Button}>
      </${Panel}>
      <${Panel} title="Train de vie">
        ${lf && lf.name
          ? html`<div class="col">
              <div class="spread row"><strong>${lf.name}</strong><span class="mono">${nuyen(lf.monthlyCost)}/mois</span></div>
              <div class="small muted">Mois payés d’avance : <strong class=${(Number(lf.monthsPaid) || 0) > 0 ? 'green' : 'red'}>${Number(lf.monthsPaid) || 0}</strong></div>
              ${Number(lf.monthlyCost) > 0 &&
              html`<div class="row wrap">
                <${NumberInput} small value=${months} min=${1} max=${24} onChange=${setMonths} />
                <${Button} small variant="primary" disabled=${(Number(actor.nuyen) || 0) < lf.monthlyCost * months} onClick=${payRent}>Payer ${nuyen(lf.monthlyCost * months)}</${Button}>
              </div>`}
            </div>`
          : html`<div class="muted small">Aucun train de vie. Choisis-en un dans le rayon « Train de vie » du catalogue.</div>`}
      </${Panel}>
      <${Panel} title="Historique des transactions" pad=${false}>
        ${!ledger.length
          ? html`<${Empty}>Aucune transaction.</${Empty}>`
          : html`<ul class="shop-ledger">
              ${ledger.map(
                (h) => html`<li>
                  <div class="grow"><div class="small">${h.text}</div><div class="faint small">${timeAgo(h.ts)}</div></div>
                  ${h.nuyen ? html`<span class=${'mono small ' + (h.nuyen > 0 ? 'green' : 'red')}>${h.nuyen > 0 ? '+' : ''}${nuyen(h.nuyen)}</span>` : null}
                  ${h.karma ? html`<span class="mono small violet">${h.karma > 0 ? '+' : ''}${h.karma} karma</span>` : null}
                </li>`
              )}
            </ul>`}
      </${Panel}>
    </div>
  </div>`;
}
