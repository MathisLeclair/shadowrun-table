// Shop tab (registry: shop/ShopPage.js). Players: storefront, cart, inventory/resale, orders.
// GM: same storefront for any PC (sell / give), approval queue, specials editor, settings.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Tabs, Select, Badge, Empty, loadCss } from '../../lib/ui.js';
import { useServerEvent } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t } from '../../lib/i18n.js';
import { useShopCatalog, useCart, useShopActors, nuyen } from './common.js';
import { pricedCart } from './Cart.js';
import Storefront from './Storefront.js';
import Cart from './Cart.js';
import Inventory from './Inventory.js';
import Orders from './Orders.js';
import { SettingsPanel, SpecialsPanel } from './GmPanels.js';

loadCss('/modules/shop/shop.css');

// Remember tab & selected actor across tab switches.
const memo = { tab: 'store', actorId: null };

export default function ShopPage({ game }) {
  const isGM = game.me.role === 'gm';
  const catalog = useShopCatalog();
  const actors = useShopActors(game);
  const [tab, setTabRaw] = useState(memo.tab);
  const [actorId, setActorRaw] = useState(memo.actorId);
  const [cartOpen, setCartOpen] = useState(false);
  const setTab = (id) => {
    memo.tab = id;
    setTabRaw(id);
  };
  const setActor = (id) => {
    memo.actorId = id;
    setActorRaw(id);
  };

  // Default / fallback actor.
  useEffect(() => {
    if (!actors.some((a) => a.id === actorId)) setActor(actors[0]?.id || null);
  }, [actors, actorId]);

  useServerEvent(
    'shop:resolved',
    (d) => {
      if (isGM) return;
      if (d?.status === 'approved') toast(d.note ? t('Cabana confirme : commande validée — « {note} »', { note: d.note }) : t('Cabana confirme : commande validée'), 'success', 5000);
      else if (d?.status === 'denied') toast(d.note ? t('Commande refusée — « {note} »', { note: d.note }) : t('Commande refusée'), 'warn', 6000);
    },
    [isGM]
  );

  const actor = actors.find((a) => a.id === actorId) || null;
  const lines = useCart(actor?.id);
  const cartTotal = catalog ? pricedCart(lines, catalog, game, actor).reduce((s, p) => s + p.total, 0) : 0;
  const orders = game.shop?.orders || [];
  const pending = orders.filter((o) => o.status === 'pending').length;

  if (!game.shop) return html`<div class="page"><${Empty}>${t('Module boutique indisponible.')}</${Empty}></div>`;
  if (!isGM && !actors.length) {
    return html`<div class="page"><${Empty}>${t('Tu n’as pas encore de personnage : demande au MJ de t’en attribuer un pour faire tes achats.')}</${Empty}></div>`;
  }

  const tabs = isGM
    ? [
        { id: 'store', label: t('Catalogue') },
        { id: 'inventory', label: t('Inventaire du PJ') },
        { id: 'orders', label: t('Commandes'), badge: pending || null },
        { id: 'specials', label: t('Offres de Cabana'), badge: (game.shop.specials || []).length || null },
        { id: 'settings', label: t('Réglages') },
      ]
    : [
        { id: 'store', label: t('Catalogue') },
        { id: 'inventory', label: t('Mon inventaire') },
        { id: 'orders', label: t('Mes commandes'), badge: pending || null },
      ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'store';

  return html`<div class="page shop-page">
    <div class="page-title shop-title">
      <div class="row wrap">
        <h2>${t('Boutique')}</h2>
        <span class="muted small shop-fixer">${game.shop.open ? t('Perrine Cabana, fixeuse — « Dis-moi ce qu’il te faut, chéri. »') : t('Cabana est injoignable')}</span>
        ${!game.shop.open && html`<${Badge} color="red">${t('Fermée')}</${Badge}>`}
        ${isGM && game.shop.markup ? html`<${Badge} color="amber">${t('Marge {pct} %', { pct: `${game.shop.markup > 0 ? '+' : ''}${game.shop.markup}` })}</${Badge}>` : null}
      </div>
      <div class="row wrap shop-title-right">
        ${(isGM || actors.length > 1) &&
        html`<${Select} class="shop-actor-select" value=${actorId || ''} onChange=${setActor}
          options=${actors.length ? actors.map((a) => ({ value: a.id, label: `${a.name} — ${nuyen(a.nuyen)}` })) : [{ value: '', label: t('Aucun PJ') }]} />`}
        ${actor && !(isGM || actors.length > 1) && html`<span class="shop-wallet-inline"><strong>${actor.name}</strong> <span class="mono cyan">${nuyen(actor.nuyen)}</span></span>`}
        ${actor && (isGM || actors.length > 1) && html`<span class="mono cyan shop-wallet-inline">${nuyen(actor.nuyen)}</span>`}
        <${Button} variant=${lines.length ? 'primary' : 'default'} disabled=${!actor || !catalog} onClick=${() => setCartOpen(true)}>
          ${t('Panier')}${lines.length ? html` <span class="shop-cart-count">${lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)}</span> · ${nuyen(cartTotal)}` : ''}
        </${Button}>
      </div>
    </div>

    <${Tabs} class="shop-tabs" tabs=${tabs} value=${current} onChange=${setTab} />

    <div class="shop-body">
      ${current === 'store' && html`<${Storefront} game=${game} actor=${actor} catalog=${catalog} />`}
      ${current === 'inventory' && html`<${Inventory} game=${game} actor=${actor} catalog=${catalog} />`}
      ${current === 'orders' && html`<${Orders} game=${game} actor=${actor} />`}
      ${current === 'specials' && isGM && html`<${SpecialsPanel} game=${game} />`}
      ${current === 'settings' && isGM && html`<${SettingsPanel} game=${game} />`}
    </div>

    ${cartOpen && actor && html`<${Cart} game=${game} actor=${actor} catalog=${catalog} lines=${lines} onClose=${() => setCartOpen(false)} />`}
  </div>`;
}
