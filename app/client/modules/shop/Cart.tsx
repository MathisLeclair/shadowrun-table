// Cart drawer: lines, quantities, totals, nuyen before/after, essence impact, checkout (player order / GM sale or gift).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton, Empty, NumberInput, Badge, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { magicLoss, UPGRADE_FILES, MOUNT_LABELS } from './rules.ts';
import { upgradePreview, msgText } from './upgrades.ts';
import { setCart, specialEntry, priceEntry, buyStatus, nuyen, gradeLabel, lineKey } from './common.tsx';
import { needsAvailTest, matchAvailTests, overpaySurcharge } from './rules.ts';
import { liveTests, AvailCartRow, type LiveAvailTest } from './avail.tsx';
import type { Actor, GameView, I18nEntry } from '../../../shared/types.ts';
import type { BuyStatus, CartLine, OwnedItem, PricedLine, ShopCatalog, ShopEntry } from './types.ts';

const MOUNTS = MOUNT_LABELS as Record<string, string>;

/**
 * Resolve cart lines against the catalog/specials. Unknown refs are flagged so they can be removed.
 * Upgrade lines (accessories, mods, lifestyle options) are checked together on the actor's items (same sim as the server).
 */
export function pricedCart(lines: CartLine[], catalog: ShopCatalog | null, game: GameView, actor: Actor | null): PricedLine[] {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const sim = new Map<string, OwnedItem>();
  return lines.map((l): PricedLine => {
    let entry: ShopEntry | null = null;
    if (l.ref.startsWith('special:')) {
      const sp = (shop.specials || []).find((s) => `special:${s.id}` === l.ref);
      if (sp) entry = specialEntry(sp, catalog);
    } else entry = catalog?.byId.get(l.ref) || null;
    if (!entry) return { line: l, missing: true, total: 0 };
    if (!entry.special && UPGRADE_FILES[entry.file as keyof typeof UPGRADE_FILES]) {
      const pv = upgradePreview(entry, actor, catalog, shop, { targetId: l.target?.itemId, mount: l.mount, rating: l.rating }, sim);
      const q = { ...pv.q, unitCost: pv.unitCost };
      let st: BuyStatus = buyStatus(shop, entry, q, isGM);
      if (st.ok && pv.problem) st = { ok: false, reason: msgText(pv.problem), approval: false };
      return { line: l, entry, q, st, pv, total: pv.unitCost };
    }
    const q = priceEntry(entry, { rating: l.rating, grade: l.grade, price: l.price }, shop);
    const st = buyStatus(shop, entry, q, isGM);
    const stockOut = !!entry.special && entry.special.stock !== null && entry.special.stock !== undefined && entry.special.stock < l.qty;
    return { line: l, entry, q, st, stockOut, total: q.unitCost * l.qty };
  });
}

/** Reply of 'shop/buy' / 'shop/give'. */
interface CheckoutResult {
  status?: string;
  total?: number;
  notes?: string[];
  notesI18n?: I18nEntry[];
}

interface CartProps {
  game: GameView;
  actor: Actor;
  catalog: ShopCatalog | null;
  lines: CartLine[];
  onClose: () => void;
}

export default function Cart({ game, actor, catalog, lines, onClose }: CartProps) {
  const isGM = game.me.role === 'gm';
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);

  const priced = pricedCart(lines, catalog, game, actor);
  const blocked = priced.filter((p) => p.missing || !p.st?.ok || p.stockOut);
  const approval = !isGM && priced.some((p) => p.st?.approval);
  const ess = priced.reduce((s, p) => s + (p.q?.essence ? p.q.essence * p.line.qty : 0), 0);
  const essBefore = Math.round(Number(actor?.attributes?.ESS ?? 6) * 1000) / 1000;
  const essAfter = Math.round((essBefore - ess) * 1000) / 1000;
  const loss = ess > 0 ? magicLoss(essBefore, essAfter) : 0;
  const awakened = Number(actor?.attributes?.MAG) > 0 ? 'MAG' : Number(actor?.attributes?.RES) > 0 ? 'RES' : null;
  // Availability tests (players): which lines need one, the successful test covering each (same matching as the server).
  const shop = game.shop || {};
  const tests = !isGM && actor ? liveTests(game, actor.id) : [];
  const availNeed = priced.map((p) => ({
    ref: p.line.ref,
    targetId: p.line.target?.itemId || '',
    availValue: p.q?.availValue,
    needsTest: !isGM && !!p.entry && needsAvailTest(shop, { file: p.entry.file, special: !!p.entry.special, availValue: p.q?.availValue }),
  }));
  const availMatch: Array<LiveAvailTest | null> = matchAvailTests(availNeed, tests);
  const lastFail = (i: number) =>
    tests.filter((x) => !x.found && x.ref === availNeed[i].ref && (x.targetId || '') === availNeed[i].targetId).sort((a, b) => b.ts - a.ts)[0] || null;
  const availRequired = shop.availTest === 'required';
  const availMissing = availRequired ? availNeed.filter((n, i) => n.needsTest && !availMatch[i]).length : 0;
  // Dice bought on a successful search (« surenchère », SR5 p. 418): +25 % of the unit price per die, charged with the purchase.
  const surcharge = priced.map((p, i) => (availMatch[i]?.overpay ? overpaySurcharge(p.q?.unitCost, availMatch[i]?.overpay) * p.line.qty : 0));
  const total = priced.reduce((s, p, i) => s + p.total + surcharge[i], 0);
  const have = Number(actor?.nuyen) || 0;
  const after = have - total;

  const update = (i: number, patch: Partial<CartLine>) => {
    const next = lines.slice();
    next[i] = { ...next[i], ...patch };
    setCart(actor.id, next);
  };
  const remove = (i: number) => setCart(actor.id, lines.filter((_, j) => j !== i));
  const payload = () => lines.map(({ name, ...rest }) => rest);

  const checkout = async (mode: 'buy' | 'give') => {
    if (!actor || !lines.length) return;
    if (mode === 'give' && !(await confirmAction(t('Give these {n} item(s) to {name} for free?', { n: lines.length, name: actor.name })))) return;
    if (mode === 'buy' && isGM && !(await confirmAction(t('Charge {cost} to {name}?', { cost: nuyen(total), name: actor.name })))) return;
    setBusy(true);
    try {
      const res = await send<CheckoutResult>(mode === 'give' ? 'shop/give' : 'shop/buy', { actorId: actor.id, items: payload() });
      setCart(actor.id, []);
      if (res?.status === 'pending') toast(t('Order sent to Cabana — awaiting GM approval'), 'info', 4500);
      else toast(mode === 'give' ? t('Delivered to {name}', { name: actor.name }) : t('Purchase done: {cost}', { cost: nuyen(res?.total ?? total) }), 'success');
      const notes = res?.notesI18n?.length ? res.notesI18n.map((n) => t(n.key, n.params)) : res?.notes || [];
      if (notes.length) toast(notes.join(' · '), 'warn', 5000);
      onClose();
    } catch {}
    setBusy(false);
  };

  // Rendered on <body>, like Modal: the shop pane sits in the workspace's isolated stacking context, so an inline
  // fixed drawer would paint under the dock.
  return createPortal(
    <div className="shop-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="shop-drawer">
        <header className="shop-drawer-head">
          <h3>
            {t('Cart')}
            {actor ? <span className="muted"> — {actor.name}</span> : null}
          </h3>
          <IconButton icon="✕" title={t('Close')} onClick={onClose} />
        </header>
        <div className="shop-drawer-body">
          {!lines.length && <Empty>{t('Empty cart. Add items from the catalog.')}</Empty>}
          {priced.map((p, i) => (
            <div className="shop-cart-item" key={lineKey(p.line)}>
              <div className={'shop-cart-line' + (p.missing || !p.st?.ok || p.stockOut ? ' bad' : '')}>
                <div className="grow">
                  <div className="shop-cart-name">{p.entry?.name || p.line.name || p.line.ref}</div>
                  <div className="row wrap gap-s small muted">
                    {p.line.rating ? <span>{t('Rating {n}', { n: p.line.rating })}</span> : null}
                    {p.line.grade && p.line.grade !== 'standard' ? <span>{gradeLabel(p.line.grade)}</span> : null}
                    {p.q?.essence ? <span>{t('Ess {n}', { n: Math.round(p.q.essence * p.line.qty * 1000) / 1000 })}</span> : null}
                    {p.line.setMatrix ? <Badge color="cyan">{t('Matrix device')}</Badge> : null}
                    {p.pv?.target ? (
                      <span className="cyan">
                        → {p.pv.target.name}
                        {p.pv.mount ? ` [${t(MOUNTS[p.pv.mount] || p.pv.mount)}]` : ''}
                      </span>
                    ) : null}
                    {p.pv?.monthlyDelta ? <span>{t('{delta}/month', { delta: `${p.pv.monthlyDelta > 0 ? '+' : '−'}${nuyen(Math.abs(p.pv.monthlyDelta))}` })}</span> : null}
                    {p.line.lifestyleName ? <span>« {p.line.lifestyleName} »</span> : null}
                    {p.missing && <span className="red">{t('Item removed from the catalog')}</span>}
                    {p.st && !p.st.ok && <span className="red">{p.st.reason}</span>}
                    {p.stockOut && <span className="red">{t('Not enough stock')}</span>}
                    {p.st?.ok && p.st.approval && <span className="amber">{t('GM approval')}</span>}
                  </div>
                </div>
                {p.pv ? null : p.entry?.file !== 'lifestyles' ? (
                  <NumberInput small value={p.line.qty} min={1} max={999} onChange={(v) => update(i, { qty: v })} />
                ) : (
                  <span className="small muted">{t('{n} months', { n: p.line.qty })}</span>
                )}
                <div className="shop-cart-price mono">
                  {nuyen(p.total + surcharge[i])}
                  {surcharge[i] ? (
                    <div className="faint small" title={t('Overpay to find the item (+25 % of the price per die)')}>
                      {t('incl. +{cost}', { cost: nuyen(surcharge[i]) })}
                    </div>
                  ) : null}
                </div>
                <IconButton icon="✕" title={t('Remove')} onClick={() => remove(i)} />
              </div>
              {availNeed[i].needsTest && p.st?.ok && (
                <AvailCartRow game={game} actor={actor} p={p} match={availMatch[i]} last={availMatch[i] ? null : lastFail(i)} required={availRequired} />
              )}
            </div>
          ))}
        </div>
        {lines.length > 0 && (
          <footer className="shop-drawer-foot">
            <div className="shop-sum">
              <div className="spread row">
                <span>{t('Total')}</span>
                <strong className="shop-price">{nuyen(total)}</strong>
              </div>
              {actor && (
                <div className="spread row small">
                  <span className="muted">{t('Nuyen')}</span>
                  <span className="mono">
                    {nuyen(have)} → <span className={after < 0 ? 'red' : 'green'}>{nuyen(after)}</span>
                  </span>
                </div>
              )}
              {ess > 0 && (
                <div className="spread row small">
                  <span className="muted">{t('Essence')}</span>
                  <span className="mono">
                    {essBefore} → <span className={essAfter <= 0 ? 'red' : 'amber'}>{essAfter}</span>
                  </span>
                </div>
              )}
              {loss > 0 && awakened === 'MAG' && <div className="shop-ess warn small">⚠ {t('Magic −{n} after implantation.', { n: loss })}</div>}
              {loss > 0 && awakened === 'RES' && <div className="shop-ess warn small">⚠ {t('Resonance −{n} after implantation.', { n: loss })}</div>}
              {essAfter <= 0 && ess > 0 && <div className="shop-blocked small">{t('Essence at zero: implantation impossible.')}</div>}
              {after < 0 && <div className="shop-blocked small">{t('Insufficient funds.')}</div>}
              {approval && <div className="shop-approval small">{t('Some items need the GM’s approval: nothing is charged until it is given.')}</div>}
              {availMissing > 0 && <div className="shop-approval small">{t('Find these items first: availability test (Negotiation + Charisma) on each marked line.')}</div>}
            </div>
            <div className="row wrap">
              {!isGM && (
                <Button
                  variant="primary"
                  className="grow"
                  disabled={busy || blocked.length > 0 || availMissing > 0 || after < 0 || !game.shop?.open || (ess > 0 && essAfter <= 0)}
                  onClick={() => checkout('buy')}
                >
                  {approval ? t('Send the order') : t('Buy')} — {nuyen(total)}
                </Button>
              )}
              {isGM && (
                <>
                  <Button variant="accent" className="grow" disabled={busy || after < 0 || priced.some((p) => p.missing || p.stockOut)} onClick={() => checkout('buy')}>
                    {t('Sell to the PC — {cost}', { cost: nuyen(total) })}
                  </Button>
                  <Button className="grow" disabled={busy || priced.some((p) => p.missing || p.stockOut)} onClick={() => checkout('give')}>
                    {t('Give (free)')}
                  </Button>
                </>
              )}
              <Button variant="ghost" small onClick={() => setCart(actor.id, [])}>
                {t('verb::Empty')}
              </Button>
            </div>
          </footer>
        )}
      </aside>
    </div>,
    document.body,
  );
}
