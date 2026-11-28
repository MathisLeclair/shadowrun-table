// Weapon accessories on the sheet: the « ⚙ » button next to a weapon's accessory chips opens its slot board
// (shop/WeaponSlots.tsx): which mount each accessory uses, and for the owner / GM switching them on / off and moving
// them to another free mount ('shop/setAccessory'). Buying new ones happens in the shop (« Customize weapons »).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../../lib/ui.tsx';
import { t } from '../../lib/i18n.ts';
import { Overlay, itemLabel } from './common.tsx';
import { useShopCatalog } from '../shop/common.tsx';
import WeaponSlots from '../shop/WeaponSlots.tsx';
import type { Weapon } from '../../../shared/types.ts';
import type { SheetCtx } from './types.ts';
import type { OwnedItem } from '../shop/types.ts';

function AccessoriesDialog({ s, w, onClose }: { s: SheetCtx; w: Weapon; onClose: () => void }) {
  const catalog = useShopCatalog();
  // Read the live weapon: the dialog stays open while the server updates it.
  const live = (s.actor.weapons || []).find((x) => x.id === w.id) || w;
  return <Overlay title={t('Accessories — {weapon}', { weapon: itemLabel(live) })} onClose={onClose} width={620}>
    <WeaponSlots actor={s.actor} weapon={live as unknown as OwnedItem} catalog={catalog} canEdit={s.own} />
    {s.own && <div className="faint small">{t('A switched-off accessory stays on its mount. New accessories are bought in the shop (« Customize weapons »).')}</div>}
  </Overlay>;
}

/** « ⚙ » button of a weapon with accessories: opens its slot board. */
export function AccessoriesButton({ s, w }: { s: SheetCtx; w: Weapon }) {
  const [open, setOpen] = useState(false);
  return <>
    <IconButton icon="⚙" title={s.own ? t('Mounts: switch or move accessories') : t('Mounts of the accessories')} onClick={() => setOpen(true)} />
    {/* Portal: a stowed weapon's row is faded (opacity), which a dialog inside it would inherit. */}
    {open && createPortal(<AccessoriesDialog s={s} w={w} onClose={() => setOpen(false)} />, document.body)}
  </>;
}
