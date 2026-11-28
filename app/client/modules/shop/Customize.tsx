// « Customize » shop tab: pick one of the character's weapons, see its mount slots (WeaponSlots: what sits on each, what
// is free, what is built in), switch / move accessories, and shop for a free slot: the accessories that fit that mount,
// bought through the usual detail panel (target weapon and mount preset; cart, availability tests, GM sell / give).
import { useEffect, useMemo, useState } from 'react';
import { Empty, Modal, Panel, SearchBox, Badge } from '../../lib/ui.tsx';
import { t, itemName } from '../../lib/i18n.ts';
import { accessoryFit, fold, weaponMounts, weaponSlots } from './rules.ts';
import { catalogItemOf, targetsFor, upgradePreview } from './upgrades.ts';
import { nuyen, AvailBadge, buyStatus, useCart, useMedia } from './common.tsx';
import { mountLabel } from '../sheet/sublists.tsx';
import WeaponSlots from './WeaponSlots.tsx';
import ItemDetail from './ItemDetail.tsx';
import { ItemRef } from '../books/BookRef.tsx';
import type { Actor, GameView } from '../../../shared/types.ts';
import type { ShopCatalog } from './types.ts';

// Remember the weapon across tab switches.
const memo: { weaponId: string | null } = { weaponId: null };

interface CustomizeProps {
  game: GameView;
  actor: Actor | null;
  catalog: ShopCatalog | null;
}

export default function Customize({ game, actor, catalog }: CustomizeProps) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const wide = useMedia('(min-width: 1180px)');
  // Weapons that can carry accessories: some mount point, or accessories already on (not unarmed, grenades, bows…).
  const weapons = targetsFor('accessories', actor).filter((w) => (w.accessories || []).length || weaponMounts(w, catalogItemOf(catalog, w)).length);
  const [weaponId, setWeaponRaw] = useState<string | null>(memo.weaponId);
  const [mount, setMount] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const setWeapon = (id: string | null) => {
    memo.weaponId = id;
    setWeaponRaw(id);
    setMount(null);
    setSelected(null);
  };
  useEffect(() => {
    if (!weapons.some((w) => w.id === weaponId)) setWeapon(weapons.find((w) => w.kind !== 'melee')?.id || weapons[0]?.id || null);
  }, [actor?.id, weapons.length, weaponId]);
  const weapon = weapons.find((w) => w.id === weaponId) || null;
  const cart = useCart(actor?.id);
  // The chosen slot got filled (bought, given, an accessory moved onto it): close its accessory list.
  const slotState = weapon && mount ? weaponSlots(weapon, catalogItemOf(catalog, weapon)).find((r) => r.mount === mount)?.state : null;
  useEffect(() => {
    if (mount && slotState !== 'free') setMount(null);
  }, [mount, slotState]);

  // Cart lines already aimed at a mount of this weapon.
  const reserved = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const l of cart) if (weapon && l.target?.itemId === weapon.id && l.mount) (out[l.mount] ||= []).push(l.name || catalog?.byId.get(l.ref)?.name || '?');
    return out;
  }, [cart, weapon, catalog]);

  // Accessories that fit the chosen mount of this weapon.
  const offers = useMemo(() => {
    if (!catalog || !weapon || !mount || !actor) return [];
    const weaponCat = catalogItemOf(catalog, weapon);
    const q = fold(query);
    return catalog.entries
      .filter((e) => e.file === 'accessories' && e.item && (!q || e.search.includes(q)))
      .filter((e) => {
        const fit = accessoryFit(weapon, weaponCat, e.item, { mount });
        return !fit.problem && fit.mount === mount;
      })
      .map((e) => {
        const pv = upgradePreview(e, actor, catalog, shop, { targetId: weapon.id, mount, rating: e.item?.rating?.min });
        const quote = { ...pv.q, unitCost: pv.unitCost };
        return { e, q: quote, st: buyStatus(shop, e, quote, isGM) };
      })
      .sort((a, b) => Number(b.st.ok) - Number(a.st.ok) || a.e.name.localeCompare(b.e.name));
  }, [catalog, weapon, mount, query, actor, shop, isGM]);

  if (!actor) return <Empty>{t('No character selected.')}</Empty>;
  if (!catalog) return <div className="shop-loading">{t('Loading the catalog…')}</div>;
  if (!weapons.length) return <Empty>{t('No weapon to install it on.')}</Empty>;

  const selEntry = selected ? offers.find((o) => o.e.ref === selected)?.e || null : null;
  const detail = selEntry && weapon && mount ? (
    <ItemDetail key={`${selEntry.ref}:${weapon.id}:${mount}`} entry={selEntry} game={game} actor={actor} catalog={catalog} targetId={weapon.id} mount={mount} compact={!wide} />
  ) : null;

  return (
    <div className={'shop-custom' + (wide ? ' wide' : '')}>
      <div className="shop-custom-weapons">
        {weapons.map((w) => (
          <button key={w.id} className={'shop-sec' + (w.id === weaponId ? ' active' : '')} onClick={() => setWeapon(w.id)}>
            <span className="grow">{w.name}</span>
            {(w.accessories || []).length ? <span className="shop-sec-count">{(w.accessories || []).length}</span> : null}
          </button>
        ))}
      </div>
      <div className="shop-main">
        {weapon && (
          <Panel title={weapon.name} actions={<ItemRef item={weapon} />} pad={false}>
            <WeaponSlots actor={actor} weapon={weapon} catalog={catalog} canEdit selected={mount} reserved={reserved} onPick={(m) => (setMount(m), setSelected(null))} />
          </Panel>
        )}
        {weapon && mount && (
          <Panel title={t('Accessories for the {mount} mount', { mount: mountLabel(mount) })} pad={false}>
            <div className="shop-custom-search">
              <SearchBox value={query} onChange={setQuery} />
            </div>
            {!offers.length ? (
              <Empty>{query ? t('Nothing matches your search.') : t('No accessory of the catalog fits this mount.')}</Empty>
            ) : (
              <table className="sr shop-table">
                <tbody>
                  {offers.map((o) => (
                    <tr key={o.e.ref} className={'shop-row' + (selected === o.e.ref ? ' selected' : '') + (!o.st.ok ? ' blocked' : '')} onClick={() => setSelected(o.e.ref)}>
                      <td>
                        <div className="shop-row-name">
                          {itemName(o.e.item)} <ItemRef item={o.e.item} />
                        </div>
                        {!o.st.ok && o.st.reason ? <div className="faint small">{o.st.reason}</div> : null}
                        {o.st.ok && o.st.approval ? <Badge color="amber">{t('GM approval')}</Badge> : null}
                      </td>
                      <td>
                        <AvailBadge avail={o.q.avail} value={o.q.availValue} legality={o.q.legality} max={isGM ? undefined : shop.maxAvail} />
                      </td>
                      <td className="num-cell">{nuyen(o.q.unitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}
      </div>
      {wide && <aside className="shop-side">{detail || <Empty>{mount ? t('Select an item to see its stats.') : t('Pick a free slot to shop for it.')}</Empty>}</aside>}
      {!wide && selEntry && (
        <Modal title={selEntry.name} width={560} onClose={() => setSelected(null)}>
          {detail}
        </Modal>
      )}
    </div>
  );
}
