// « Mon inventaire »: owned items with resale buttons (installed accessories / mods under their item), lifestyles
// (several, with upgrades and rent per lifestyle), martial arts, money ledger.
import { Fragment, useState } from 'react';
import { Button, IconButton, Panel, Empty, NumberInput, Badge, confirmAction, promptText } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast, openSheet } from '../../lib/ui-store.ts';
import { t, tk, tn, tIfKnown, itemName } from '../../lib/i18n.js';
import { costBreakdown } from '/shared/lifestyle.js';
import { MOUNT_LABELS } from './rules.js';
import { ownedValue, subValue, nuyen, gradeLabel, timeAgo } from './common.tsx';
import { ItemRef } from './bookrefs.ts';
import type { Actor, GameView, HistoryEntry, Lifestyle } from '../../../shared/types.ts';
import type { OwnedItem, ShopCatalog } from './types.ts';

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
  { id: 'weapons', label: tk('Armes'), sub: 'accessories', detail: (w) => [w.damage, w.ap ? t('PA {n}', { n: w.ap }) : '', w.mode].filter(Boolean).join(' · ') },
  {
    id: 'armor',
    label: tk('Armures'),
    sub: 'mods',
    detail: (a) => (a.equipped ? t('{n} armure · portée', { n: `${a.stack ? '+' : ''}${a.rating ?? 0}` }) : t('{n} armure', { n: `${a.stack ? '+' : ''}${a.rating ?? 0}` })),
  },
  {
    id: 'augmentations',
    label: tk('Augmentations'),
    detail: (a) =>
      [a.kind === 'bioware' ? t('Bioware') : t('Cyberware'), a.rating ? t('ind. {n}', { n: a.rating }) : '', a.grade && a.grade !== 'standard' ? gradeLabel(a.grade) : '', t('Ess {n}', { n: a.essence ?? 0 })]
        .filter(Boolean)
        .join(' · '),
  },
  { id: 'gear', label: tk('Équipement'), detail: (g) => [g.category, g.rating ? t('ind. {n}', { n: g.rating }) : ''].filter(Boolean).join(' · ') },
  {
    id: 'vehicles',
    label: tk('Véhicules & drones'),
    sub: 'mods',
    detail: (v) => t('Man {handling} · Vit {speed} · Str {body} · Bli {armor}', { handling: v.handling ?? '—', speed: v.speed ?? '—', body: v.body ?? '—', armor: v.armor ?? '—' }),
  },
];
/** Ledger line text: translatable entry when the server stored an i18n key. */
const historyText = (h: HistoryEntry) => (h.i18n?.key ? t(h.i18n.key, h.i18n.params) : tIfKnown(h.text || ''));
/** Sub-item detail: mount / capacity / slots / rating. */
const subDetail = (sub: string | undefined, s: OwnedItem) =>
  [
    sub === 'accessories' ? (s.included ? t('d’origine') : t(MOUNTS[s.mount || ''] || s.mount)) : '',
    s.rating ? t('ind. {n}', { n: s.rating }) : '',
    s.capacity ? t('cap. {n}', { n: s.capacity }) : '',
    s.slots ? tn(s.slots, '{n} emplacement', '{n} emplacements') : '',
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
  if (!actor) return <Empty>{t('Aucun personnage sélectionné.')}</Empty>;
  const rate = Number(shop.sellRate) || 0;
  // Sell orders carry the sold item id as `itemId` (not in shared/types.ts OrderLine).
  const pendingSales = new Set(
    (shop.orders || []).filter((o) => o.status === 'pending' && o.kind === 'sell').map((o) => o.items[0]?.subId || (o.items[0] as { itemId?: string } | undefined)?.itemId)
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
      const ans = await promptText(n > 1 ? t('Prix de revente de {item} ×{n} (¥)', { item: name, n }) : t('Prix de revente de {item} (¥)', { item: name }), offer === null ? '' : String(offer));
      if (ans === null) return;
      price = Math.max(0, Math.round(Number(String(ans).replace(/[^\d.-]/g, '')) || 0));
    } else {
      const item = n > 1 ? `${name} ×${n}` : name;
      const p = { item, cost: nuyen(offer), rate };
      const msg =
        offer === null
          ? t('Revendre {item} ? Cabana fixera le prix (validation du MJ).', { item: name })
          : list === 'augmentations'
            ? t('Revendre {item} à Cabana pour {cost} ({rate} % de sa valeur) ?\nL’Essence perdue ne revient pas.', p)
            : t('Revendre {item} à Cabana pour {cost} ({rate} % de sa valeur) ?', p);
      if (!(await confirmAction(msg))) return;
    }
    try {
      const res = await send<{ status?: string; total?: number }>('shop/sell', { actorId: actor.id, list, itemId: it.id, ...(sub ? { subId: sub.id } : { qty: n }), ...(isGM ? { price } : {}) });
      if (res?.status === 'pending') toast(t('Proposition de revente envoyée au MJ'), 'info');
      else toast(t('Vendu : +{cost}', { cost: nuyen(res?.total) }), 'success');
    } catch {}
  };

  const removeUpgrade = async (list: string, it: OwnedItem, sub: OwnedItem) => {
    if (!(await confirmAction(t('Retirer {item} de {target} ? (sans remboursement)', { item: itemName(sub), target: it.name })))) return;
    try {
      await send('shop/removeUpgrade', { actorId: actor.id, list, itemId: it.id, subId: sub.id });
      toast(t('Option retirée'), 'info');
    } catch {}
  };

  const payRent = async (lf: Lifestyle) => {
    const m = months[lf.id] || 1;
    const cost = (Number(lf.monthlyCost) || 0) * m;
    if (!(await confirmAction(t('Payer {n} mois de {name} pour {cost} ?', { n: m, name: lf.name, cost: nuyen(cost) })))) return;
    try {
      await send('shop/payLifestyle', { actorId: actor.id, lifestyleId: lf.id, months: m });
      toast(t('Loyer payé'), 'success');
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
                  <Badge>{t('d’origine')}</Badge>
                </>
              ) : null}
            </div>
            <div className="faint small">{subDetail(L.sub, s)}</div>
          </td>
          <td className="num-cell small">{resale === null ? <span className="faint">—</span> : nuyen(resale)}</td>
          <td className="right shop-inv-actions">
            {pending ? (
              <Badge color="amber">{t('Revente en attente')}</Badge>
            ) : (
              <>
                {resale !== null && (
                  <Button small variant="ghost" disabled={!canSell} onClick={() => sell(L.id, it, s)}>
                    {t('Revendre')}
                  </Button>
                )}
                {canRemove(L.id, s) && <IconButton icon="✕" title={t('Retirer (sans remboursement)')} onClick={() => removeUpgrade(L.id, it, s)} />}
              </>
            )}
          </td>
        </tr>
      );
    });

  return (
    <div className="shop-inv">
      <div className="shop-inv-main">
        {empty && <Empty>{t('Inventaire vide.')}</Empty>}
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
                          <td className="num-cell small" title={t('Valeur de revente estimée')}>
                            {builtin ? (
                              <span className="faint">{t('intégrée (implant)')}</span>
                            ) : have < 1 ? (
                              <span className="faint">{t('épuisé')}</span>
                            ) : resale === null ? (
                              <span className="faint">{t('prix à fixer')}</span>
                            ) : (
                              nuyen(resale)
                            )}
                          </td>
                          <td className="right shop-inv-actions">
                            {L.id === 'gear' && have > 1 && <NumberInput small value={n} min={1} max={have} onChange={(v) => setQtys({ ...qtys, [it.id]: v })} />}
                            {builtin || have < 1 ? null : pending ? (
                              <Badge color="amber">{t('Revente en attente')}</Badge>
                            ) : (
                              <Button small variant="ghost" disabled={!canSell} title={canSell ? t('Revendre à Cabana') : t('Cabana est injoignable')} onClick={() => sell(L.id, it)}>
                                {t('Revendre')}
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
          <Panel title={t('Arts martiaux ({n})', { n: arts.length })}>
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
              <span className="stat-label">{t('Nuyens')}</span>
              <strong>{nuyen(actor.nuyen)}</strong>
            </div>
            <div className="shop-wallet">
              <span className="stat-label">{t('Revente')}</span>
              <strong>{t('{n} %', { n: rate })}</strong>
            </div>
          </div>
          <Button small variant="ghost" onClick={() => openSheet(actor.id)}>
            {t('Ouvrir la fiche')}
          </Button>
        </Panel>
        <Panel title={t('Train de vie')}>
          {!lifestyles.length && <div className="muted small">{t('Aucun train de vie. Choisis-en un dans le rayon « Train de vie » du catalogue.')}</div>}
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
                        <Badge color="cyan">{t('principal')}</Badge>
                      </>
                    ) : null}{' '}
                    <ItemRef item={lf} />
                  </strong>
                  <span className="mono">{t('{cost}/mois', { cost: nuyen(lf.monthlyCost) })}</span>
                </div>
                <div className="faint small">
                  {t('Base {cost}', { cost: nuyen(b.base) })}
                  {b.multiplier ? ` · ${t('{n} % du coût de base', { n: `${b.multiplier > 0 ? '+' : ''}${b.multiplier}` })}` : ''}
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
                    {canRemove('lifestyles', q) && <IconButton icon="✕" title={t('Retirer (sans remboursement)')} onClick={() => removeUpgrade('lifestyles', lf, q)} />}
                  </div>
                ))}
                <div className="small muted">
                  {t('Mois payés d’avance :')} <strong className={(Number(lf.monthsPaid) || 0) > 0 ? 'green' : 'red'}>{Number(lf.monthsPaid) || 0}</strong>
                </div>
                {Number(lf.monthlyCost) > 0 && (
                  <div className="row wrap">
                    <NumberInput small value={m} min={1} max={24} onChange={(v) => setMonths({ ...months, [lf.id]: v })} />
                    <Button small variant="primary" disabled={(Number(actor.nuyen) || 0) < lf.monthlyCost * m} onClick={() => payRent(lf)}>
                      {t('Payer {cost}', { cost: nuyen(lf.monthlyCost * m) })}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </Panel>
        <Panel title={t('Historique des transactions')} pad={false}>
          {!ledger.length ? (
            <Empty>{t('Aucune transaction.')}</Empty>
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
