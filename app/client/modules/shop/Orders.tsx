// Orders: GM approval queue (pending) and order history (players see their own orders only — server filter).
import { useState } from 'react';
import { Button, Badge, Empty, Panel, TextInput, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast, openSheet } from '../../lib/ui-store.ts';
import { t, tk } from '../../lib/i18n.ts';
import { nuyen, gradeLabel, timeAgo, STATUS_LABEL, STATUS_COLOR, FLAG_LABEL, FLAG_COLOR } from './common.tsx';
import { durText } from './avail.tsx';
import type { Actor, GameView, OrderLine, ShopOrder } from '../../../shared/types.ts';

const KIND_LABEL: Record<string, string> = { buy: tk('Purchase'), sell: tk('Resale'), give: tk('GM gift'), karma: tk('Martial art (karma)') };
const kindLabel = (k: string) => (KIND_LABEL[k] ? t(KIND_LABEL[k]) : k);
/** Who placed the order: the server stores 'MJ' for the GM, else the player's name. */
const byLabel = (by: string | undefined) => (by === 'MJ' ? t('GM') : by || '?');


function Lines({ order }: { order: ShopOrder }) {
  return (
    <ul className="shop-order-lines">
      {order.items.map((l, i) => (
        <li key={i}>
          <span className="grow">
            {l.name}
            {l.target?.name ? <span className="cyan"> → {l.target.name}</span> : null}
            {l.techniques?.length ? <span className="muted"> ({l.techniques.join(', ')})</span> : null}
            {l.rating ? <span className="muted"> {t('rtg {n}', { n: l.rating })}</span> : null}
            {l.grade && l.grade !== 'standard' ? <span className="muted"> {gradeLabel(l.grade)}</span> : null}
            {l.qty > 1 ? <span className="muted"> ×{l.qty}</span> : null}
          </span>
          {l.legality === 'F' ? <Badge color="red">F</Badge> : l.legality === 'R' ? <Badge color="amber">R</Badge> : null}
          {l.availValue !== undefined && order.kind !== 'sell' ? (
            <span className="faint small mono" title={t('Availability')}>
              {t('A{n}', { n: l.availValue })}
            </span>
          ) : null}
          {l.essence ? <span className="faint small mono">{t('Ess {n}', { n: Math.round(l.essence * l.qty * 1000) / 1000 })}</span> : null}
          {l.availTest ? (
            <>
              <span className="shop-avt ok small" title={t('{hits} hits vs {opp} (Availability {avail})', { hits: l.availTest.hits, opp: l.availTest.availHits, avail: l.availTest.avail })}>
                {l.availTest.contact
                  ? t('found by {contact} in {delay}', { contact: l.availTest.contact, delay: durText(l.availTest.delayHours) })
                  : t('found in {delay}', { delay: durText(l.availTest.delayHours) })}
                {l.availTest.tie ? ` · ${t('tie')}` : ''}
                {l.availTest.tries > 1 ? ` · ${t('attempt #{n}', { n: l.availTest.tries })}` : ''}
              </span>
              {l.availTest.glitch ? (
                <span className="shop-avt todo small" title={t('Glitch on the availability test: unwanted attention (cops, yakuza, rivals…), GM’s call')}>
                  ⚠ {t('glitch')}
                </span>
              ) : null}
            </>
          ) : null}
          <span className="mono small">
            {l.karma ? t('{n} karma', { n: l.karma }) : l.unitCost === null || l.unitCost === undefined ? '?' : nuyen((l.unitCost + (l.surcharge || 0)) * l.qty)}
            {l.surcharge ? (
              <>
                {' '}
                <span className="faint" title={t('Overpay to find the item (+25 % of the price per die)')}>
                  {t('incl. +{cost}', { cost: nuyen(l.surcharge * l.qty) })}
                </span>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PendingCard({ order, game }: { order: ShopOrder; game: GameView }) {
  const actor = game.actors?.[order.actorId] as Actor | undefined;
  const [note, setNote] = useState('');
  const [total, setTotal] = useState<number | string>(order.total ?? '');
  const [busy, setBusy] = useState(false);
  const have = Number(actor?.nuyen) || 0;
  const amount = total === '' ? null : Number(total);
  const after = order.kind === 'sell' ? have + (amount || 0) : have - (amount || 0);
  const karma = order.kind === 'karma';
  const karmaHave = Number(actor?.karma) || 0;
  const karmaAfter = karmaHave - (Number(order.karma) || 0);
  const resolve = async (approve: boolean) => {
    if (!approve && !(await confirmAction(t('Deny this order?')))) return;
    setBusy(true);
    try {
      const payload: { orderId: string; approve: boolean; note: string; total?: number } = { orderId: order.id, approve, note };
      if (approve && amount !== null && Number.isFinite(amount) && amount !== order.total) payload.total = amount;
      await send('shop/resolve', payload);
      toast(approve ? t('Order approved') : t('Order denied'), approve ? 'success' : 'info');
    } catch {}
    setBusy(false);
  };
  return (
    <div className="card shop-order pending">
      <div className="spread row wrap">
        <div className="row wrap gap-s">
          <Badge color={order.kind === 'sell' ? 'cyan' : 'magenta'}>{kindLabel(order.kind)}</Badge>
          <button className="shop-link" onClick={() => actor && openSheet(actor.id)}>
            {actor?.name || t('Deleted character')}
          </button>
          <span className="faint small">{t('by {name} · {when}', { name: byLabel(order.by), when: timeAgo(order.ts) })}</span>
        </div>
        <div className="row gap-s">
          {(order.flags || []).map((f) => (
            <Badge key={f} color={FLAG_COLOR[f] || 'dim'}>
              {FLAG_LABEL[f] ? t(FLAG_LABEL[f]) : f}
            </Badge>
          ))}
        </div>
      </div>
      <Lines order={order} />
      <div className="row wrap shop-order-foot">
        {karma ? (
          actor && (
            <span className="small mono">
              {t('Karma')} {karmaHave} → <span className={karmaAfter < 0 ? 'red' : 'green'}>{karmaAfter}</span>
            </span>
          )
        ) : (
          <>
            <label className="row gap-s small">
              {order.kind === 'sell' ? t('Payment') : t('Total')}
              <input className="input shop-price-input" type="number" min="0" value={total} placeholder="¥" onChange={(e) => setTotal(e.target.value)} />
            </label>
            {actor && (
              <span className="small mono">
                {nuyen(have)} → <span className={after < 0 ? 'red' : 'green'}>{nuyen(after)}</span>
              </span>
            )}
          </>
        )}
        <TextInput className="grow shop-note" live value={note} onChange={setNote} placeholder={t('Note for the player (optional)')} />
        <Button
          small
          variant="primary"
          disabled={busy || (karma ? karmaAfter < 0 : (order.kind === 'sell' && amount === null) || (order.kind !== 'sell' && after < 0))}
          onClick={() => resolve(true)}
        >
          {t('Approve')}
        </Button>
        <Button small variant="danger" disabled={busy} onClick={() => resolve(false)}>
          {t('Deny')}
        </Button>
      </div>
    </div>
  );
}

interface OrdersProps {
  game: GameView;
  actor: Actor | null;
}

export default function Orders({ game, actor }: OrdersProps) {
  const isGM = game.me.role === 'gm';
  const all = (game.shop?.orders || []).slice().sort((a, b) => b.ts - a.ts);
  const [onlyActor, setOnlyActor] = useState(false);
  const pending = all.filter((o) => o.status === 'pending');
  const done = all.filter((o) => o.status !== 'pending' && (!onlyActor || !actor || o.actorId === actor.id));

  const cancel = async (o: ShopOrder) => {
    if (!(await confirmAction(t('Cancel this order?')))) return;
    try {
      await send('shop/cancel', { orderId: o.id });
      toast(t('Order cancelled'), 'info');
    } catch {}
  };
  const clear = async () => {
    if (!(await confirmAction(t('Clear the history of handled orders? (pending orders are kept)')))) return;
    try {
      await send('shop/clearOrders');
    } catch {}
  };

  return (
    <div className="shop-orders">
      <div className="section-title">{isGM ? t('To approve ({n})', { n: pending.length }) : t('Pending ({n})', { n: pending.length })}</div>
      {!pending.length && <Empty>{t('No pending orders.')}</Empty>}
      {pending.map((o) =>
        isGM ? (
          <PendingCard key={o.id} order={o} game={game} />
        ) : (
          <div className="card shop-order pending" key={o.id}>
            <div className="spread row wrap">
              <div className="row gap-s">
                <Badge color="amber">{t('Awaiting the GM')}</Badge>
                <span className="small">{game.actors?.[o.actorId]?.name || ''}</span>
                <span className="faint small">{timeAgo(o.ts)}</span>
              </div>
              <Button small variant="ghost" onClick={() => cancel(o)}>
                {t('Cancel')}
              </Button>
            </div>
            <Lines order={o} />
            <div className="right">
              <span className="muted small">{o.kind === 'sell' ? t('Offered:') : t('Total:')} </span>
              <strong className="mono">{o.kind === 'karma' ? t('{n} karma', { n: o.karma }) : o.total === null || o.total === undefined ? t('to be set') : nuyen(o.total)}</strong>
            </div>
          </div>
        )
      )}

      <div className="section-title row spread">
        <span>{t('History')}</span>
        <span className="row gap-s">
          {isGM && actor && (
            <label className="row gap-s small muted">
              <input type="checkbox" checked={onlyActor} onChange={(e) => setOnlyActor(e.target.checked)} /> {t('{name} only', { name: actor.name })}
            </label>
          )}
          {isGM && done.length > 0 && (
            <Button small variant="ghost" onClick={clear}>
              {t('Clear')}
            </Button>
          )}
        </span>
      </div>
      {!done.length && <Empty>{t('No transactions yet.')}</Empty>}
      {done.length > 0 && (
        <Panel pad={false}>
          <table className="sr shop-history">
            <thead>
              <tr>
                <th>{t('When')}</th>
                <th>{t('Type')}</th>
                <th>{t('Runner')}</th>
                <th>{t('Items')}</th>
                <th className="right">{t('Amount')}</th>
                <th>{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {done.slice(0, 150).map((o) => (
                <tr key={o.id}>
                  <td className="small faint">{timeAgo(o.resolvedTs || o.ts)}</td>
                  <td className="small">{kindLabel(o.kind)}</td>
                  <td className="small">{game.actors?.[o.actorId]?.name || '—'}</td>
                  <td className="small">
                    {o.items.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(', ')}
                    {o.gmNote ? <div className="faint">« {o.gmNote} »</div> : null}
                  </td>
                  <td className={'num-cell small' + (o.kind === 'sell' ? ' green' : '')}>
                    {o.kind === 'karma'
                      ? t('{n} karma', { n: `−${o.karma}` })
                      : o.kind === 'give'
                        ? t('free')
                        : o.total === null || o.total === undefined
                          ? '—'
                          : `${o.kind === 'sell' ? '+' : '−'}${nuyen(o.total)}`}
                  </td>
                  <td>
                    <Badge color={STATUS_COLOR[o.status] || 'dim'}>{STATUS_LABEL[o.status] ? t(STATUS_LABEL[o.status]) : o.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
