// Cart drawer: lines, quantities, totals, nuyen before/after, essence impact, checkout (player order / GM sale or gift).
import { useEffect, useState } from 'preact/hooks';
import { html, Button, IconButton, Empty, NumberInput, Badge, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t } from '../../lib/i18n.js';
import { magicLoss } from './rules.js';
import { setCart, specialEntry, priceEntry, buyStatus, nuyen, gradeLabel, lineKey } from './common.js';

/** Resolve cart lines against the catalog/specials. Unknown refs are flagged so they can be removed. */
export function pricedCart(lines, catalog, game) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  return lines.map((l) => {
    let entry = null;
    if (l.ref.startsWith('special:')) {
      const sp = (shop.specials || []).find((s) => `special:${s.id}` === l.ref);
      if (sp) entry = specialEntry(sp, catalog);
    } else entry = catalog?.byId.get(l.ref) || null;
    if (!entry) return { line: l, missing: true, total: 0 };
    const q = priceEntry(entry, { rating: l.rating, grade: l.grade, price: l.price }, shop);
    const st = buyStatus(shop, entry, q, isGM);
    const stockOut = entry.special && entry.special.stock !== null && entry.special.stock !== undefined && entry.special.stock < l.qty;
    return { line: l, entry, q, st, stockOut, total: q.unitCost * l.qty };
  });
}

export default function Cart({ game, actor, catalog, lines, onClose }) {
  const isGM = game.me.role === 'gm';
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);

  const priced = pricedCart(lines, catalog, game);
  const total = priced.reduce((s, p) => s + p.total, 0);
  const have = Number(actor?.nuyen) || 0;
  const after = have - total;
  const blocked = priced.filter((p) => p.missing || !p.st?.ok || p.stockOut);
  const approval = !isGM && priced.some((p) => p.st?.approval);
  const ess = priced.reduce((s, p) => s + (p.q?.essence ? p.q.essence * p.line.qty : 0), 0);
  const essBefore = Math.round(Number(actor?.attributes?.ESS ?? 6) * 1000) / 1000;
  const essAfter = Math.round((essBefore - ess) * 1000) / 1000;
  const loss = ess > 0 ? magicLoss(essBefore, essAfter) : 0;
  const awakened = Number(actor?.attributes?.MAG) > 0 ? 'MAG' : Number(actor?.attributes?.RES) > 0 ? 'RES' : null;

  const update = (i, patch) => {
    const next = lines.slice();
    next[i] = { ...next[i], ...patch };
    setCart(actor.id, next);
  };
  const remove = (i) => setCart(actor.id, lines.filter((_, j) => j !== i));
  const payload = () => lines.map(({ name, ...rest }) => rest);

  const checkout = async (mode) => {
    if (!actor || !lines.length) return;
    if (mode === 'give' && !(await confirmAction(t('Donner gratuitement ces {n} article(s) à {name} ?', { n: lines.length, name: actor.name })))) return;
    if (mode === 'buy' && isGM && !(await confirmAction(t('Débiter {cost} à {name} ?', { cost: nuyen(total), name: actor.name })))) return;
    setBusy(true);
    try {
      const res = await send(mode === 'give' ? 'shop/give' : 'shop/buy', { actorId: actor.id, items: payload() });
      setCart(actor.id, []);
      if (res?.status === 'pending') toast(t('Commande transmise à Cabana — en attente de validation du MJ'), 'info', 4500);
      else toast(mode === 'give' ? t('Livré à {name}', { name: actor.name }) : t('Achat effectué : {cost}', { cost: nuyen(res?.total ?? total) }), 'success');
      const notes = res?.notesI18n?.length ? res.notesI18n.map((n) => t(n.key, n.params)) : res?.notes || [];
      if (notes.length) toast(notes.join(' · '), 'warn', 5000);
      onClose();
    } catch {}
    setBusy(false);
  };

  return html`<div class="shop-drawer-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <aside class="shop-drawer">
      <header class="shop-drawer-head">
        <h3>${t('Panier')}${actor ? html` <span class="muted">— ${actor.name}</span>` : null}</h3>
        <${IconButton} icon="✕" title=${t('Fermer')} onClick=${onClose} />
      </header>
      <div class="shop-drawer-body">
        ${!lines.length && html`<${Empty}>${t('Panier vide. Ajoute des articles depuis le catalogue.')}</${Empty}>`}
        ${priced.map(
          (p, i) => html`<div class=${'shop-cart-line' + (p.missing || !p.st?.ok || p.stockOut ? ' bad' : '')} key=${lineKey(p.line)}>
            <div class="grow">
              <div class="shop-cart-name">${p.entry?.name || p.line.name || p.line.ref}</div>
              <div class="row wrap gap-s small muted">
                ${p.line.rating ? html`<span>${t('Indice {n}', { n: p.line.rating })}</span>` : null}
                ${p.line.grade && p.line.grade !== 'standard' ? html`<span>${gradeLabel(p.line.grade)}</span>` : null}
                ${p.q?.essence ? html`<span>${t('Ess {n}', { n: Math.round(p.q.essence * p.line.qty * 1000) / 1000 })}</span>` : null}
                ${p.line.setMatrix ? html`<${Badge} color="cyan">${t('Appareil Matriciel')}</${Badge}>` : null}
                ${p.missing && html`<span class="red">${t('Article retiré du catalogue')}</span>`}
                ${p.st && !p.st.ok && html`<span class="red">${p.st.reason}</span>`}
                ${p.stockOut && html`<span class="red">${t('Stock insuffisant')}</span>`}
                ${p.st?.ok && p.st.approval && html`<span class="amber">${t('Validation MJ')}</span>`}
              </div>
            </div>
            ${p.entry?.file !== 'lifestyles'
              ? html`<${NumberInput} small value=${p.line.qty} min=${1} max=${999} onChange=${(v) => update(i, { qty: v })} />`
              : html`<span class="small muted">${t('{n} mois', { n: p.line.qty })}</span>`}
            <div class="shop-cart-price mono">${nuyen(p.total)}</div>
            <${IconButton} icon="✕" title=${t('Retirer')} onClick=${() => remove(i)} />
          </div>`
        )}
      </div>
      ${lines.length > 0 &&
      html`<footer class="shop-drawer-foot">
        <div class="shop-sum">
          <div class="spread row"><span>${t('Total')}</span><strong class="shop-price">${nuyen(total)}</strong></div>
          ${actor &&
          html`<div class="spread row small"><span class="muted">${t('Nuyens')}</span>
            <span class="mono">${nuyen(have)} → <span class=${after < 0 ? 'red' : 'green'}>${nuyen(after)}</span></span></div>`}
          ${ess > 0 &&
          html`<div class="spread row small"><span class="muted">${t('Essence')}</span>
            <span class="mono">${essBefore} → <span class=${essAfter <= 0 ? 'red' : 'amber'}>${essAfter}</span></span></div>`}
          ${loss > 0 && awakened === 'MAG' && html`<div class="shop-ess warn small">⚠ ${t('Magie −{n} après l’implantation.', { n: loss })}</div>`}
          ${loss > 0 && awakened === 'RES' && html`<div class="shop-ess warn small">⚠ ${t('Résonance −{n} après l’implantation.', { n: loss })}</div>`}
          ${essAfter <= 0 && ess > 0 && html`<div class="shop-blocked small">${t('Essence à zéro : implantation impossible.')}</div>`}
          ${after < 0 && html`<div class="shop-blocked small">${t('Fonds insuffisants.')}</div>`}
          ${approval && html`<div class="shop-approval small">${t('Certains articles demandent l’accord du MJ : rien n’est débité avant sa validation.')}</div>`}
        </div>
        <div class="row wrap">
          ${!isGM &&
          html`<${Button} variant="primary" class="grow" disabled=${busy || blocked.length > 0 || after < 0 || !game.shop?.open || (ess > 0 && essAfter <= 0)} onClick=${() => checkout('buy')}>
            ${approval ? t('Envoyer la commande') : t('Acheter')} — ${nuyen(total)}
          </${Button}>`}
          ${isGM &&
          html`
            <${Button} variant="accent" class="grow" disabled=${busy || after < 0 || priced.some((p) => p.missing || p.stockOut)} onClick=${() => checkout('buy')}>${t('Vendre au PJ — {cost}', { cost: nuyen(total) })}</${Button}>
            <${Button} class="grow" disabled=${busy || priced.some((p) => p.missing || p.stockOut)} onClick=${() => checkout('give')}>${t('Donner (gratuit)')}</${Button}>
          `}
          <${Button} variant="ghost" small onClick=${() => setCart(actor.id, [])}>${t('Vider')}</${Button}>
        </div>
      </footer>`}
    </aside>
  </div>`;
}
