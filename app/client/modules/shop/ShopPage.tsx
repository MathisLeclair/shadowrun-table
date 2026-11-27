// Shop tab (registry: shop/ShopPage.js). Players: storefront, cart, inventory/resale, orders.
// GM: same storefront for any PC (sell / give), approval queue, specials editor, settings.
import { useEffect, useState } from 'react';
import './shop.css';
import { Button, Tabs, Select, Badge, Empty } from '../../lib/ui.tsx';
import { useServerEvent, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { useShopCatalog, useCart, useShopActors, nuyen } from './common.tsx';
import { pricedCart } from './Cart.tsx';
import Storefront from './Storefront.tsx';
import Cart from './Cart.tsx';
import Inventory from './Inventory.tsx';
import Orders from './Orders.tsx';
import { SettingsPanel, SpecialsPanel } from './GmPanels.tsx';

// Remember tab & selected actor across tab switches.
const memo: { tab: string; actorId: string | null } = { tab: 'store', actorId: null };

export default function ShopPage({ game }: GameProps) {
  const isGM = game.me.role === 'gm';
  const catalog = useShopCatalog();
  const actors = useShopActors(game);
  const [tab, setTabRaw] = useState(memo.tab);
  const [actorId, setActorRaw] = useState(memo.actorId);
  const [cartOpen, setCartOpen] = useState(false);
  const setTab = (id: string) => {
    memo.tab = id;
    setTabRaw(id);
  };
  const setActor = (id: string | null) => {
    memo.actorId = id;
    setActorRaw(id);
  };

  // Default / fallback actor.
  useEffect(() => {
    if (!actors.some((a) => a.id === actorId)) setActor(actors[0]?.id || null);
  }, [actors, actorId]);

  useServerEvent(
    'shop:resolved',
    (d: { status?: string; note?: string } | undefined) => {
      if (isGM) return;
      if (d?.status === 'approved') toast(d.note ? t('Cabana confirms: order approved — « {note} »', { note: d.note }) : t('Cabana confirms: order approved'), 'success', 5000);
      else if (d?.status === 'denied') toast(d.note ? t('Order denied — « {note} »', { note: d.note }) : t('Order denied'), 'warn', 6000);
    },
    [isGM]
  );

  const actor = actors.find((a) => a.id === actorId) || null;
  const lines = useCart(actor?.id);
  const cartTotal = catalog ? pricedCart(lines, catalog, game, actor).reduce((s, p) => s + p.total, 0) : 0;
  const orders = game.shop?.orders || [];
  const pending = orders.filter((o) => o.status === 'pending').length;

  if (!game.shop) return <div className="page"><Empty>{t('Shop module unavailable.')}</Empty></div>;
  if (!isGM && !actors.length) {
    return (
      <div className="page">
        <Empty>{t('You don’t have a character yet: ask the GM to assign you one to go shopping.')}</Empty>
      </div>
    );
  }

  const tabs = isGM
    ? [
        { id: 'store', label: t('Catalog') },
        { id: 'inventory', label: t('PC inventory') },
        { id: 'orders', label: t('Orders'), badge: pending || null },
        { id: 'specials', label: t('Cabana’s deals'), badge: (game.shop.specials || []).length || null },
        { id: 'settings', label: t('Settings') },
      ]
    : [
        { id: 'store', label: t('Catalog') },
        { id: 'inventory', label: t('My inventory') },
        { id: 'orders', label: t('My orders'), badge: pending || null },
      ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'store';

  return (
    <div className="page shop-page">
      <div className="page-title shop-title">
        <div className="row wrap">
          <h2>{t('Shop')}</h2>
          <span className="muted small shop-fixer">{game.shop.open ? t('Perrine Cabana, fixer — « Tell me what you need, sweetie. »') : t('Cabana can’t be reached')}</span>
          {!game.shop.open && <Badge color="red">{t('Closed')}</Badge>}
          {isGM && game.shop.markup ? <Badge color="amber">{t('Markup {pct}%', { pct: `${game.shop.markup > 0 ? '+' : ''}${game.shop.markup}` })}</Badge> : null}
        </div>
        <div className="row wrap shop-title-right">
          {(isGM || actors.length > 1) && (
            <Select
              className="shop-actor-select"
              value={actorId || ''}
              onChange={setActor}
              options={actors.length ? actors.map((a) => ({ value: a.id, label: `${a.name} — ${nuyen(a.nuyen)}` })) : [{ value: '', label: t('No PC') }]}
            />
          )}
          {actor && !(isGM || actors.length > 1) && (
            <span className="shop-wallet-inline">
              <strong>{actor.name}</strong> <span className="mono cyan">{nuyen(actor.nuyen)}</span>
            </span>
          )}
          {actor && (isGM || actors.length > 1) && <span className="mono cyan shop-wallet-inline">{nuyen(actor.nuyen)}</span>}
          <Button variant={lines.length ? 'primary' : 'default'} disabled={!actor || !catalog} onClick={() => setCartOpen(true)}>
            {t('Cart')}
            {lines.length ? (
              <>
                {' '}
                <span className="shop-cart-count">{lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)}</span> · {nuyen(cartTotal)}
              </>
            ) : (
              ''
            )}
          </Button>
        </div>
      </div>

      <Tabs className="shop-tabs" tabs={tabs} value={current} onChange={setTab} />

      <div className="shop-body">
        {current === 'store' && <Storefront game={game} actor={actor} catalog={catalog} />}
        {current === 'inventory' && <Inventory game={game} actor={actor} catalog={catalog} />}
        {current === 'orders' && <Orders game={game} actor={actor} />}
        {current === 'specials' && isGM && <SpecialsPanel game={game} />}
        {current === 'settings' && isGM && <SettingsPanel game={game} />}
      </div>

      {cartOpen && actor && <Cart game={game} actor={actor} catalog={catalog} lines={lines} onClose={() => setCartOpen(false)} />}
    </div>
  );
}
