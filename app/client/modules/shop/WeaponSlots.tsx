// Slot board of one weapon: its mount points (Top, Under, Barrel, Stock, Side, Internal) with what sits on each, which
// are free and which the weapon lacks. Owners and the GM switch accessories on / off and move them to another free mount
// ('shop/setAccessory'; the server re-checks the fit). The shop « Customize » tab adds a buy button on free slots (onPick).
import { Button, Badge, Select, Toggle } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, itemName } from '../../lib/i18n.ts';
import { accessoryMoves, weaponSlots, fold } from './rules.ts';
import { catalogItemOf } from './upgrades.ts';
import { mountLabel, subEffect } from '../sheet/sublists.tsx';
import { ItemRef } from '../books/BookRef.tsx';
import type { Actor } from '../../../shared/types.ts';
import type { OwnedItem, ShopCatalog, ShopItem } from './types.ts';

/** Catalog entry of an installed accessory (by catalogId, else by name among the accessories), or null. */
export function accessoryCatOf(catalog: ShopCatalog | null | undefined, acc: OwnedItem | null | undefined): ShopItem | null {
  if (!catalog || !acc) return null;
  const byId = acc.catalogId ? catalog.byId.get(acc.catalogId) : null;
  if (byId) return byId.file === 'accessories' ? byId.item : null;
  const k = fold(acc.name);
  if (!k) return null;
  return catalog.entries.find((x) => x.file === 'accessories' && (fold(x.item?.name) === k || fold(x.item?.nameFr) === k))?.item || null;
}

interface WeaponSlotsProps {
  actor: Actor;
  weapon: OwnedItem;
  /** Shop catalog (null while loading: moves wait for it). */
  catalog: ShopCatalog | null;
  /** Owner or GM: show the on / off and move controls. */
  canEdit: boolean;
  /** Highlighted mount (shop: the slot being shopped for). */
  selected?: string | null;
  /** Shop: « buy for this slot » on free mounts. */
  onPick?: (mount: string) => void;
  /** Mounts already taken by cart lines: mount → item names. */
  reserved?: Record<string, string[]>;
}

export default function WeaponSlots({ actor, weapon, catalog, canEdit, selected, onPick, reserved = {} }: WeaponSlotsProps) {
  const weaponCat = catalogItemOf(catalog, weapon);
  const rows = weaponSlots(weapon, weaponCat);
  const setAcc = async (acc: OwnedItem, patch: { equipped?: boolean; mount?: string }) => {
    try {
      await send('shop/setAccessory', { actorId: actor.id, weaponId: weapon.id, subId: acc.id, ...patch });
      if (patch.mount) toast(t('{item} moved to {mount}', { item: itemName(acc), mount: mountLabel(patch.mount) }), 'success', 2000);
    } catch {}
  };
  return (
    <table className="sr shop-slots">
      <tbody>
        {rows.map((r) => {
          const cart = reserved[r.mount] || [];
          const state = r.state === 'free' && cart.length ? 'cart' : r.state;
          return (
            <tr key={r.mount || 'none'} className={'shop-slot ' + state + (selected === r.mount ? ' selected' : '')}>
              <th className="shop-slot-name">{mountLabel(r.mount)}</th>
              <td>
                {r.state === 'none' && <span className="faint small">{t('Not on this weapon')}</span>}
                {state === 'cart' && (
                  <span className="small">
                    <Badge color="magenta">{t('in the cart')}</Badge> {cart.join(', ')}
                  </span>
                )}
                {state === 'free' && (
                  <div className="shop-slot-free">
                    <span className="muted small">{r.mount === 'Internal' ? t('Nothing built in') : t('Free')}</span>
                    {onPick && r.mount !== 'Internal' && (
                      <Button small variant={selected === r.mount ? 'primary' : 'ghost'} onClick={() => onPick(r.mount)}>
                        {t('Find an accessory')}
                      </Button>
                    )}
                  </div>
                )}
                {r.items.map((acc: OwnedItem) => {
                  const moves = canEdit && catalog ? accessoryMoves(weapon, weaponCat, acc, accessoryCatOf(catalog, acc)) : [];
                  const fx = subEffect('accessories', acc);
                  return (
                    <div key={acc.id} className={'shop-slot-acc' + (acc.equipped === false ? ' off' : '')}>
                      <span className="grow">
                        <b>{itemName(acc)}</b>
                        {acc.rating ? ` ${acc.rating}` : ''} <ItemRef item={acc} />
                        {acc.included ? (
                          <>
                            {' '}
                            <Badge>{t('built-in')}</Badge>
                          </>
                        ) : null}
                        {fx ? <span className="faint small"> {fx}</span> : null}
                        {acc.equipped === false ? <span className="faint small"> · {t('off')}</span> : null}
                      </span>
                      {moves.length > 0 && (
                        <Select
                          className="shop-slot-move"
                          title={t('Move to another mount')}
                          aria-label={t('Move to another mount')}
                          value={acc.mount}
                          onChange={(m) => m !== acc.mount && setAcc(acc, { mount: m })}
                          options={[acc.mount, ...moves].map((m) => ({ value: m, label: mountLabel(m) }))}
                        />
                      )}
                      {canEdit && <Toggle value={acc.equipped !== false} title={acc.equipped === false ? t('Switch on') : t('Switch off')} onChange={(v) => setAcc(acc, { equipped: v })} />}
                    </div>
                  );
                })}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
