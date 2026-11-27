// « Mon inventaire »: owned items with resale buttons (installed accessories / mods under their item), lifestyles
// (several, with upgrades and rent per lifestyle), martial arts, money ledger.
import { Fragment, useState } from 'react';
import { Button, IconButton, Panel, Empty, NumberInput, Badge, confirmAction, promptText } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast, openSheet } from '../../lib/ui-store.ts';
import { t, tk, tn, tIfKnown, itemName } from '../../lib/i18n.ts';
import { costBreakdown } from '/shared/lifestyle.ts';
import { MOUNT_LABELS } from './rules.ts';
import { ownedValue, subValue, nuyen, gradeLabel, timeAgo } from './common.tsx';
import type { Actor, GameView, HistoryEntry, Lifestyle } from '../../../shared/types.ts';
import type { OwnedItem, ShopCatalog } from './types.ts';
import { ItemRef } from '../books/BookRef.tsx';

const MOUNTS = MOUNT_LABELS as Record<string, string>;

/** An actor list shown in the inventory. `label` = French key (render t(label)); `detail` runs at render time. */
interface ListDef {
  id: 'weapons' | 'armor' | 'augmentations' | 'gear' | 'vehicles';
  label: string;
  /** Sub-list of installed parts (accessories / mods). */
  sub?: string;
  detail: (it: OwnedItem) => string;
}

// `label` = French key (render t(label)); `detail` runs at render time.
const LISTS: ListDef[] = [
  { id: 'weapons', label: tk('Weapons'), sub: 'accessories', detail: (w) => [w.damage, w.ap ? t('AP {n}', { n: w.ap }) : '', w.mode].filter(Boolean).join(' · ') },
  {
    id: 'armor',
    label: tk('pl::Armor'),
    sub: 'mods',
    detail: (a) => (a.equipped ? t('{n} armor · worn', { n: `${a.stack ? '+' : ''}${a.rating ?? 0}` }) : t('{n} armor', { n: `${a.stack ? '+' : ''}${a.rating ?? 0}` })),
  },
  {
    id: 'augmentations',
    label: tk('Augmentations'),
    detail: (a) =>
      [a.kind === 'bioware' ? t('Bioware') : t('Cyberware'), a.rating ? t('rtg {n}', { n: a.rating }) : '', a.grade && a.grade !== 'standard' ? gradeLabel(a.grade) : '', t('Ess {n}', { n: a.essence ?? 0 })]
        .filter(Boolean)
        .join(' · '),
  },
  { id: 'gear', label: tk('Gear'), detail: (g) => [g.category, g.rating ? t('rtg {n}', { n: g.rating }) : ''].filter(Boolean).join(' · ') },
  {
    id: 'vehicles',
    label: tk('Vehicles & drones'),
    sub: 'mods',
    detail: (v) => t('Hand {handling} · Spd {speed} · Body {body} · Arm {armor}', { handling: v.handling ?? '—', speed: v.speed ?? '—', body: v.body ?? '—', armor: v.armor ?? '—' }),
  },
];
/** Ledger line text: translatable entry when the server stored an i18n key. */
const historyText = (h: HistoryEntry) => (h.i18n?.key ? t(h.i18n.key, h.i18n.params) : tIfKnown(h.text || ''));
/** Sub-item detail: mount / capacity / slots / rating. */
const subDetail = (sub: string | undefined, s: OwnedItem) =>
  [
    sub === 'accessories' ? (s.included ? t('built-in') : t(MOUNTS[s.mount || ''] || s.mount)) : '',
    s.rating ? t('rtg {n}', { n: s.rating }) : '',
    s.capacity ? t('cap. {n}', { n: s.capacity }) : '',
    s.slots ? tn(s.slots, '{n} slot', '{n} slots') : '',
  ]
    .filter(Boolean)
    .join(' · ');

interface InventoryProps {
  game: GameView;
  actor: Actor | null;
  catalog: ShopCatalog | null;
}

export default function Inventory({ game, actor, catalog }: InventoryProps) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const [months, setMonths] = useState<Record<string, number>>({});
  const [qtys, setQtys] = useState<Record<string, number>>({});
  if (!actor) return <Empty>{t('No character selected.')}</Empty>;
  const rate = Number(shop.sellRate) || 0;
  const pendingSales = new Set(
    (shop.orders || []).filter((o) => o.status === 'pending' && o.kind === 'sell').map((o) => o.items[0]?.subId || o.items[0]?.itemId)
  );
  const canSell = isGM || shop.open;

  const sell = async (list: string, it: OwnedItem, sub?: OwnedItem) => {
    const have = list === 'gear' && !sub ? Math.max(1, Number(it.qty) || 1) : 1;
    const n = list === 'gear' && !sub ? Math.min(have, Math.max(1, qtys[it.id] || have)) : 1;
    const value = sub ? subValue(sub) || null : ownedValue(list, it, catalog);
    const offer = value === null ? null : Math.round((value * n * rate) / 100);
    const name = sub ? itemName(sub) : it.name;
    let price: number | undefined;
    if (isGM) {
      const ans = await promptText(n > 1 ? t('Resale price of {item} ×{n} (¥)', { item: name, n }) : t('Resale price of {item} (¥)', { item: name }), offer === null ? '' : String(offer));
      if (ans === null) return;
      price = Math.max(0, Math.round(Number(String(ans).replace(/[^\d.-]/g, '')) || 0));
    } else {
      const item = n > 1 ? `${name} ×${n}` : name;
      const p = { item, cost: nuyen(offer), rate };
      const msg =
        offer === null
          ? t('Sell {item}? Cabana will set the price (GM approval).', { item: name })
          : list === 'augmentations'
            ? t('Sell {item} to Cabana for {cost} ({rate}% of its value)?\nLost Essence does not come back.', p)
            : t('Sell {item} to Cabana for {cost} ({rate}% of its value)?', p);
      if (!(await confirmAction(msg))) return;
    }
    try {
      const res = await send<{ status?: string; total?: number }>('shop/sell', { actorId: actor.id, list, itemId: it.id, ...(sub ? { subId: sub.id } : { qty: n }), ...(isGM ? { price } : {}) });
      if (res?.status === 'pending') toast(t('Resale offer sent to the GM'), 'info');
      else toast(t('Sold: +{cost}', { cost: nuyen(res?.total) }), 'success');
    } catch {}
  };

  const removeUpgrade = async (list: string, it: OwnedItem, sub: OwnedItem) => {
    if (!(await confirmAction(t('Remove {item} from {target}? (no refund)', { item: itemName(sub), target: it.name })))) return;
    try {
      await send('shop/removeUpgrade', { actorId: actor.id, list, itemId: it.id, subId: sub.id });
      toast(t('Option removed'), 'info');
    } catch {}
  };

  const payRent = async (lf: Lifestyle) => {
    const m = months[lf.id] || 1;
    const cost = (Number(lf.monthlyCost) || 0) * m;
    if (!(await confirmAction(t('Pay {n} month(s) of {name} for {cost}?', { n: m, name: lf.name, cost: nuyen(cost) })))) return;
    try {
      await send('shop/payLifestyle', { actorId: actor.id, lifestyleId: lf.id, months: m });
      toast(t('Rent paid'), 'success');
    } catch {}
  };

  const lifestyles = actor.lifestyles || [];
  const arts = actor.martialArts || [];
  const ledger = (actor.history || []).slice(-25).reverse();
  const itemsOf = (L: ListDef) => (actor[L.id] || []) as unknown as OwnedItem[];
  const empty = LISTS.every((l) => !itemsOf(l).length);
  // Players may drop the options they pay for; rent-lowering ones (negative) and parts delivered with an item stay GM-only.
  const canRemove = (list: string, s: OwnedItem) =>
    isGM || (list === 'lifestyles' ? !(s.category === 'Negative' || Number(s.multiplier) < 0 || Number(s.cost) < 0) : !s.included);

  const subRows = (L: ListDef, it: OwnedItem) =>
    ((L.sub && (it[L.sub] as OwnedItem[] | undefined)) || []).map((s) => {
      const value = subValue(s);
      const resale = s.included || !value ? null : Math.round((value * rate) / 100);
      const pending = pendingSales.has(s.id);
      return (
        <tr key={s.id} className="shop-inv-sub">
          <td>
            <div className="small">
              ↳ {itemName(s)} <ItemRef item={s} />
              {s.included ? (
                <>
                  {' '}
                  <Badge>{t('built-in')}</Badge>
                </>
              ) : null}
            </div>
            <div className="faint small">{subDetail(L.sub, s)}</div>
          </td>
          <td className="num-cell small">{resale === null ? <span className="faint">—</span> : nuyen(resale)}</td>
          <td className="right shop-inv-actions">
            {pending ? (
              <Badge color="amber">{t('Resale pending')}</Badge>
            ) : (
              <>
                {resale !== null && (
                  <Button small variant="ghost" disabled={!canSell} onClick={() => sell(L.id, it, s)}>
                    {t('Sell')}
                  </Button>
                )}
                {canRemove(L.id, s) && <IconButton icon="✕" title={t('Remove (no refund)')} onClick={() => removeUpgrade(L.id, it, s)} />}
              </>
            )}
          </td>
        </tr>
      );
    });

  return (
    <div className="shop-inv">
      <div className="shop-inv-main">
        {empty && <Empty>{t('Empty inventory.')}</Empty>}
        {LISTS.map((L) => {
          const items = itemsOf(L);
          if (!items.length) return null;
          return (
            <Panel key={L.id} title={t('{label} ({n})', { label: t(L.label), n: items.length })} pad={false} className="shop-inv-panel">
              <table className="sr">
                <tbody>
                  {items.map((it) => {
                    const value = ownedValue(L.id, it, catalog);
                    const builtin = L.id === 'weapons' && !!it.augId; // implant weapon: sold with its augmentation
                    const have = L.id === 'gear' ? Math.max(0, Number(it.qty ?? 1) || 0) : 1;
                    const n = L.id === 'gear' ? Math.min(have, Math.max(1, qtys[it.id] || have)) : 1;
                    const resale = value === null || builtin || have < 1 ? null : Math.round((value * n * rate) / 100);
                    const pending = pendingSales.has(it.id);
                    return (
                      <Fragment key={it.id}>
                        <tr>
                          <td>
                            <div className="shop-row-name">
                              {it.name}
                              {L.id === 'gear' && have > 1 ? <span className="muted"> ×{have}</span> : null} <ItemRef item={it} />
                            </div>
                            <div className="faint small">{L.detail(it)}</div>
                          </td>
                          <td className="num-cell small" title={t('Estimated resale value')}>
                            {builtin ? (
                              <span className="faint">{t('built in (implant)')}</span>
                            ) : have < 1 ? (
                              <span className="faint">{t('sold out')}</span>
                            ) : resale === null ? (
                              <span className="faint">{t('price to be set')}</span>
                            ) : (
                              nuyen(resale)
                            )}
                          </td>
                          <td className="right shop-inv-actions">
                            {L.id === 'gear' && have > 1 && <NumberInput small value={n} min={1} max={have} onChange={(v) => setQtys({ ...qtys, [it.id]: v })} />}
                            {builtin || have < 1 ? null : pending ? (
                              <Badge color="amber">{t('Resale pending')}</Badge>
                            ) : (
                              <Button small variant="ghost" disabled={!canSell} title={canSell ? t('Sell to Cabana') : t('Cabana can’t be reached')} onClick={() => sell(L.id, it)}>
                                {t('Sell')}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {L.sub ? subRows(L, it) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          );
        })}
        {arts.length > 0 && (
          <Panel title={t('Martial arts ({n})', { n: arts.length })}>
            {arts.map((m) => (
              <div key={m.id} className="shop-inv-art">
                <strong>{m.name}</strong> <ItemRef item={m} /> <span className="faint small">{(m.techniques || []).map((x) => itemName(x)).join(', ') || '—'}</span>
              </div>
            ))}
          </Panel>
        )}
      </div>
      <div className="shop-inv-side">
        <Panel title={t('Finances')}>
          <div className="row wrap">
            <div className="shop-wallet">
              <span className="stat-label">{t('Nuyen')}</span>
              <strong>{nuyen(actor.nuyen)}</strong>
            </div>
            <div className="shop-wallet">
              <span className="stat-label">{t('Resale')}</span>
              <strong>{t('{n}%', { n: rate })}</strong>
            </div>
          </div>
          <Button small variant="ghost" onClick={() => openSheet(actor.id)}>
            {t('Open the sheet')}
          </Button>
        </Panel>
        <Panel title={t('Lifestyle')}>
          {!lifestyles.length && <div className="muted small">{t('No lifestyle. Pick one in the « Lifestyle » section of the catalog.')}</div>}
          {lifestyles.map((lf) => {
            const b = costBreakdown(lf);
            const m = months[lf.id] || 1;
            return (
              <div key={lf.id} className="col shop-inv-ls">
                <div className="spread row">
                  <strong>
                    {lf.name}
                    {lf.primary && lifestyles.length > 1 ? (
                      <>
                        {' '}
                        <Badge color="cyan">{t('primary')}</Badge>
                      </>
                    ) : null}{' '}
                    <ItemRef item={lf} />
                  </strong>
                  <span className="mono">{t('{cost}/month', { cost: nuyen(lf.monthlyCost) })}</span>
                </div>
                <div className="faint small">
                  {t('Base {cost}', { cost: nuyen(b.base) })}
                  {b.multiplier ? ` · ${t('{n}% of the base cost', { n: `${b.multiplier > 0 ? '+' : ''}${b.multiplier}` })}` : ''}
                  {b.flat ? ` · ${t('options {cost}', { cost: nuyen(b.flat) })}` : ''}
                </div>
                {(lf.qualities || []).map((q) => (
                  <div key={q.id} className="row small shop-inv-lsq">
                    <span className="grow">
                      ↳ {itemName(q)} <ItemRef item={q} />
                    </span>
                    <span className="faint mono">
                      {q.multiplier ? `${q.multiplier > 0 ? '+' : ''}${q.multiplier} %` : ''}
                      {q.multiplier && q.cost ? ' · ' : ''}
                      {q.cost ? nuyen(q.cost) : ''}
                    </span>
                    {canRemove('lifestyles', q) && <IconButton icon="✕" title={t('Remove (no refund)')} onClick={() => removeUpgrade('lifestyles', lf, q)} />}
                  </div>
                ))}
                <div className="small muted">
                  {t('Months paid in advance:')} <strong className={(Number(lf.monthsPaid) || 0) > 0 ? 'green' : 'red'}>{Number(lf.monthsPaid) || 0}</strong>
                </div>
                {Number(lf.monthlyCost) > 0 && (
                  <div className="row wrap">
                    <NumberInput small value={m} min={1} max={24} onChange={(v) => setMonths({ ...months, [lf.id]: v })} />
                    <Button small variant="primary" disabled={(Number(actor.nuyen) || 0) < lf.monthlyCost * m} onClick={() => payRent(lf)}>
                      {t('Pay {cost}', { cost: nuyen(lf.monthlyCost * m) })}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </Panel>
        <Panel title={t('Transaction history')} pad={false}>
          {!ledger.length ? (
            <Empty>{t('No transactions.')}</Empty>
          ) : (
            <ul className="shop-ledger">
              {ledger.map((h, i) => (
                <li key={`${h.ts}-${i}`}>
                  <div className="grow">
                    <div className="small">{historyText(h)}</div>
                    <div className="faint small">{timeAgo(h.ts)}</div>
                  </div>
                  {h.nuyen ? (
                    <span className={'mono small ' + (h.nuyen > 0 ? 'green' : 'red')}>
                      {h.nuyen > 0 ? '+' : ''}
                      {nuyen(h.nuyen)}
                    </span>
                  ) : null}
                  {h.karma ? <span className="mono small violet">{t('{n} karma', { n: `${h.karma > 0 ? '+' : ''}${h.karma}` })}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
