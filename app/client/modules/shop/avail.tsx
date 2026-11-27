// Availability test helper (SR5 p. 418): Negotiation + Charisma [Social] vs dice equal to the item's Availability; the net hits
// divide the base time of the Availability Time table. Rolled by the server ('shop/availTest'); this file shows the cart panel,
// the tests' live outcome (Edge « Seconde chance » rerolls the log entry) and the result line of the roll in the log.
import { useState, type ComponentType } from 'react';
import './shop.css'; // the log dock shows availability rolls outside the shop page
import { Button, NumberInput, Toggle } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { skillPool, attr, derive } from '/shared/sr5.ts';
import { availOutcome, availBaseHours, durationText, MAX_OVERPAY_DICE, clampOverpay, overpaySurcharge } from './rules.ts';
import { nuyen } from './common.tsx';
import type { Actor, ActorId, AvailTest, GameView, RollRecord } from '../../../shared/types.ts';
import type { PricedLine } from './types.ts';

/** Outcome of an availability test (rules.js availOutcome). */
interface AvailOutcome {
  net: number;
  found: boolean;
  tie: boolean;
  delayHours: number | null;
  retryHours: number | null;
  glitch: boolean;
  critGlitch: boolean;
}
/** A stored test with its live hits and outcome. */
export type LiveAvailTest = AvailTest & AvailOutcome;
/** What foundText / failText / scoreText read (a live test, or the server's reply to 'shop/availTest'). */
type TestLike = Partial<LiveAvailTest> & AvailOutcome;

/** A duration in hours in the UI language (« 16 h », « 2 j 12 h », « 1 semaine »). */
export function durText(hours: number | null | undefined): string {
  const d = durationText(hours);
  return t(d.t, d.params);
}

/** The actor's unused availability tests with their live outcome (hits read from the log entry when it is still there). */
export function liveTests(game: GameView, actorId: ActorId): LiveAvailTest[] {
  const log = game.log || [];
  return (game.shop?.availTests || [])
    .filter((x) => x.actorId === actorId && x.status === 'open')
    .map((x) => {
      const e = x.logId ? log.find((l) => l.id === x.logId) : null;
      const live = typeof e?.roll?.hits === 'number' ? { hits: e.roll.hits, glitch: !!e.roll.glitch, critGlitch: !!e.roll.critGlitch } : {};
      const y = { ...x, ...live };
      return { ...y, ...(availOutcome(y) as AvailOutcome) };
    });
}

/** « 3 succès contre 1 (dispo 8R) » */
const scoreText = (x: TestLike) => t('{hits} hits vs {opp} (Availability {avail})', { hits: x.hits, opp: x.availHits, avail: `${x.avail}${x.legality || ''}` });

/** « Trouvé — délai 12 h » / « Trouvé de justesse (égalité) — délai 2 jours », + « complication » on a glitch. */
function foundText(o: TestLike) {
  const s = o.tie ? t('Barely found (tie) — takes {delay}', { delay: durText(o.delayHours) }) : t('Found — takes {delay}', { delay: durText(o.delayHours) });
  return o.glitch ? `${s} · ${t('glitch: GM’s call')}` : s;
}
/** « Introuvable (2 contre 3) — nouvel essai après 2 jours en jeu » / critical glitch: no chance to get it. */
function failText(o: TestLike) {
  if (o.critGlitch) return t('Critical glitch: no chance of getting this item (GM decides what happens)');
  return t('Not found ({hits} vs {opp}) — try again after {time} in game', { hits: o.hits, opp: o.availHits, time: durText(o.retryHours) });
}

interface AvailCartRowProps {
  game: GameView;
  actor: Actor;
  /** Priced cart line ({ line, entry, q }). */
  p: PricedLine;
  /** The successful test covering it (or null). */
  match: LiveAvailTest | null;
  /** The latest failed test for it. */
  last: LiveAvailTest | null;
  required: boolean;
}

/**
 * Cart row status + roll panel for one line that needs (or may use) an availability test.
 * p = priced cart line ({ line, entry, q }), match = the successful test covering it (or null), last = the latest failed test for it.
 */
export function AvailCartRow({ game, actor, p, match, last, required }: AvailCartRowProps) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState(''); // '' = the runner, else a contact id
  const [useSpec, setUseSpec] = useState(false);
  const [explode, setExplode] = useState(false);
  const [modifier, setModifier] = useState(0);
  const [overpay, setOverpay] = useState(0);
  const [busy, setBusy] = useState(false);
  const avail = p.q?.availValue ?? 0;
  const legality = p.q?.legality || '';
  const contacts = game.shop?.contactSearch?.[actor.id] || [];
  const contact = who ? contacts.find((c) => c.id === who) : null;
  const sk = (actor.skills || []).find((s) => s.id === 'negotiation');
  const base = skillPool(actor, 'negotiation', { useSpec });
  const wounds = derive(actor).woundModifier || 0;
  const edge = explode ? attr(actor, 'EDG') : 0;
  const mod = Number(modifier) || 0;
  const extra = clampOverpay(overpay);
  const unit = Number(p.q?.unitCost) || 0;
  const pool = contact ? Math.max(0, (contact.pool || 0) + mod + extra) : Math.max(0, base.pool + wounds + edge + mod + extra);
  const baseTime = durText(availBaseHours(p.q?.unitCost));
  const doubleTime = durText(availBaseHours(p.q?.unitCost) * 2);
  const canEdge = (actor.edge?.current || 0) > 0;

  const roll = async () => {
    setBusy(true);
    try {
      const { name, qty, ...item } = p.line;
      const payload = contact ? { actorId: actor.id, item, contactId: contact.id, modifier: mod, overpay: extra } : { actorId: actor.id, item, useSpec, explode, modifier: mod, overpay: extra };
      const r = await send<TestLike>('shop/availTest', payload);
      if (r.found) toast(foundText(r), r.glitch ? 'warn' : 'success', 6000);
      else toast(failText(r), 'warn', 7000);
      setOpen(false);
      setExplode(false);
      setModifier(0);
      setOverpay(0);
    } catch {}
    setBusy(false);
  };

  let status;
  const by = (x: LiveAvailTest) =>
    (x.contactName ? ` · ${t('via {contact}', { contact: x.contactName })}` : '') +
    (x.found && x.overpay ? ` · ${t('overpay +{pct} % (+{cost})', { pct: x.overpay * 25, cost: nuyen(overpaySurcharge(unit, x.overpay) * (p.line.qty || 1)) })}` : '');
  if (match)
    status = (
      <span className={'shop-avt ' + (match.glitch ? 'todo' : 'ok')} title={scoreText(match)}>
        ✓ {foundText(match)}
        {by(match)}
      </span>
    );
  else if (last)
    status = (
      <span className="shop-avt bad" title={scoreText(last)}>
        ✗ {failText(last)}
        {by(last)}
      </span>
    );
  else
    status = (
      <span className={'shop-avt ' + (required ? 'todo' : 'opt')}>
        {required ? t('Availability test required (Availability {avail})', { avail: `${avail}${legality}` }) : t('Availability test available (Availability {avail})', { avail: `${avail}${legality}` })}
      </span>
    );

  return (
    <div className="shop-avt-row">
      <div className="row wrap gap-s small">
        {status}
        {!match && (
          <Button small variant={open ? 'ghost' : 'default'} onClick={() => setOpen(!open)}>
            {open ? t('Close') : last ? t('🎲 Try again') : t('🎲 Search')}
          </Button>
        )}
      </div>
      {open && (
        <div className="shop-avt-panel small">
          {contacts.length > 0 && (
            <label className="row gap-s">
              {t('Who searches?')}
              <select className="input grow" value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">{t('{name} (Negotiation + Charisma)', { name: actor.name })}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.known}>
                    {c.known ? t('{name} — contact, {n} dice [limit {limit}]', { name: c.name, n: c.pool, limit: c.limit }) : t('{name} — contact without stats', { name: c.name })}
                  </option>
                ))}
              </select>
            </label>
          )}
          {contact ? (
            <div>
              {t('{name} makes the test: Charisma {cha} + Negotiation {neg} [Social {social} + Connection {conn}] vs {n} Availability dice', {
                name: contact.name,
                cha: contact.cha,
                neg: contact.defaulting ? t('defaulting') : contact.negotiation,
                social: contact.social,
                conn: contact.connection,
                n: avail,
              })}
            </div>
          ) : (
            <div>{t('Negotiation + Charisma [Social] vs {n} Availability dice', { n: avail })}</div>
          )}
          <div className="muted">
            {t('Delivery: {time} (by price) ÷ net hits. Tie: found, but takes {double}. Failure: try again after {double}.', { time: baseTime, double: doubleTime })}
          </div>
          {contacts.some((c) => !c.known) && <div className="faint">{t('A contact without stats can search once the GM creates an NPC with the same name in the Bestiary.')}</div>}
          <div className="row wrap gap-l">
            {!contact && sk?.spec && <Toggle value={useSpec} onChange={setUseSpec} label={t('Specialization ({spec}) +2', { spec: sk.spec })} />}
            {!contact && canEdge && <Toggle value={explode} onChange={setExplode} label={t('Push the Limit (+{n}, Edge)', { n: attr(actor, 'EDG') })} />}
            <span className="row gap-s">
              {t('Edit')} <NumberInput small value={modifier} min={-20} max={20} onChange={setModifier} />
            </span>
            <span className="row gap-s" title={t('SR5 p. 418: +1 die per extra 25 % of the price offered, 12 dice max (400 % of the price). Only paid when you buy.')}>
              {t('Overpay (dice)')} <NumberInput small value={overpay} min={0} max={MAX_OVERPAY_DICE} onChange={setOverpay} />
              {extra ? <span className="amber">{t('+{pct} % of the price = +{cost}', { pct: extra * 25, cost: nuyen(overpaySurcharge(unit, extra) * (p.line.qty || 1)) })}</span> : null}
            </span>
          </div>
          <div className="row spread gap-s">
            {contact ? (
              <span>
                <strong className="mono">{t('{n} dice', { n: pool })}</strong> <span className="faint">{t('[limit {n}]', { n: contact.limit })}</span>
              </span>
            ) : (
              <span>
                <strong className="mono">{t('≈ {n} dice', { n: pool })}</strong>
                {base.defaulting ? <span className="amber"> {t('(defaulting)')}</span> : null}
                {wounds ? <span className="faint"> {t('(wounds {n})', { n: wounds })}</span> : null}
                <span className="faint"> · {t('gear bonuses and limit computed on the roll')}</span>
              </span>
            )}
            <Button small variant="primary" disabled={busy || pool <= 0} onClick={roll}>
              {t('Roll')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface AvailRollLineProps {
  roll: Partial<RollRecord> | null | undefined;
  /** Dice faces component of the log dock (passed in to avoid an import cycle). */
  Dice?: ComponentType<{ roll: { dice: number[] }; small?: boolean }>;
}

/** Result line of an availability roll in the log: the Availability dice and the outcome (live after a « Seconde chance »). */
export function AvailRollLine({ roll, Dice }: AvailRollLineProps) {
  const a = roll?.avail;
  if (!roll || !a) return null;
  const out = availOutcome({ hits: roll.hits, availHits: a.hits, baseHours: a.baseHours, glitch: roll.glitch, critGlitch: roll.critGlitch }) as AvailOutcome;
  return (
    <div className="shop-avt-log small">
      <span className="faint">{t('Availability {avail}: {n} hits', { avail: `${a.value}${a.legality || ''}`, n: a.hits })}</span>
      {Dice ? <Dice roll={{ dice: a.dice }} small /> : null}
      {out.found ? (
        <span className={'shop-avt ' + (out.glitch ? 'todo' : 'ok')}>
          {out.tie ? t('tie — found in {delay}', { delay: durText(out.delayHours) }) : t('{net} net hit(s) — found in {delay}', { net: out.net, delay: durText(out.delayHours) })}
          {out.glitch ? ` · ${t('glitch: GM’s call')}` : ''}
        </span>
      ) : (
        <span className="shop-avt bad">
          {out.critGlitch ? t('Critical glitch: no chance of getting this item (GM decides what happens)') : t('Not found — try again after {time} in game', { time: durText(out.retryHours) })}
        </span>
      )}
      {a.contact ? <span className="faint">{t('via {contact}', { contact: a.contact })}</span> : null}
      {a.tries > 1 ? <span className="faint">{t('attempt #{n}', { n: a.tries })}</span> : null}
    </div>
  );
}
