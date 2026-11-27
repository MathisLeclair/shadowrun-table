// Contacts as dossiers (Contacts & SIN tab): one card per contact (portrait from an NPC / bestiary sheet of the same name,
// Connection and Loyalty gauges with the SR5 table texts), « Contacter » = the dossier full size with fees, favors and the
// rolls of SR5 p. 387-389 ('actor/contactRoll'), and the result line of those rolls in the log (ContactRollLine).
import { useState, type ReactNode } from 'react';
import { Button, Modal, Toggle, NumberInput, TextInput } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tk, fmtNuyen } from '../../lib/i18n.ts';
import { skillPool, derive } from '/shared/sr5.ts';
import { Avatar, DiceFaces, cssVars } from './common.tsx';
import {
  CONNECTION_DETAILS, LOYALTY_LEVELS, FAVOR_RATINGS, MAX_CONNECTION, MAX_LOYALTY, connectionOf, loyaltyOf, contactFees, bribeCost, contactSheet,
} from '/shared/contacts.ts';

/** contactSheet() of shared/contacts.js, or the player's view of it (shop.contactSearch). */
interface ContactSheetView {
  id: string;
  name: string;
  connection: number;
  known: boolean;
  portrait?: string;
  color?: string;
  source?: string;
  cha?: number;
  etiquette?: number;
  social?: number;
}
const LOYALTY = LOYALTY_LEVELS as Record<number, { name: string; text: string } | undefined>;
const CONNECTIONS = CONNECTION_DETAILS as Record<number, string>;

import type { Actor, Contact, GameView } from '../../../shared/types.ts';
import type { ShownRoll } from './types.ts';
import './contacts.css'; // also needed by the log dock (ContactRollLine)
import { RuleRef } from '../books/BookRef.tsx';

/** Stable hue per contact name (initials avatar without a sheet). */
function nameColor(name: string): string {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 55%)`;
}
/** Short decorative file number. */
function fileNo(c: Contact): string {
  let h = 7;
  for (const ch of String(c.id || c.name || '')) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).toUpperCase().padStart(6, '0').slice(-6);
}
/** P(2D6 ≥ n). */
function reachOdds(n: number): number {
  let ok = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b >= n) ok++;
  return ok / 36;
}
const pct = (x: number): string => `${Math.round(x * 100)} %`;

/** The contact's sheet: GM computes it from the bestiary / NPCs, players get it from the shop view (bestiary hidden). */
export function sheetOf(game: GameView, actor: Actor, c: Contact): ContactSheetView {
  if (game?.bestiary || !game?.shop?.contactSearch) return contactSheet(game, c) as ContactSheetView;
  return ((game.shop.contactSearch as Record<string, ContactSheetView[] | undefined>)[actor.id] || []).find((x) => x.id === c.id) || { id: c.id, name: c.name, connection: connectionOf(c), known: false };
}

function Gauge({ value, max, kind }: { value: number; max: number; kind: string }) {
  return <span className={'ct-gauge ' + kind} aria-hidden="true">
    {Array.from({ length: max }, (_, i) => <i key={i} className={i < value ? 'on' : ''} />)}
  </span>;
}

/** One dossier card. big = the « Contacter » view. */
interface ContactCardProps {
  game: GameView;
  actor: Actor;
  c: Contact;
  big?: boolean;
  children?: ReactNode;
}
export function ContactCard({ game, actor, c, big, children }: ContactCardProps) {
  const sh = sheetOf(game, actor, c);
  const cn = connectionOf(c);
  const loy = loyaltyOf(c);
  const lv = LOYALTY[loy];
  const color = sh.color || nameColor(c.name);
  return <div className={'ct-card' + (big ? ' big' : '')} style={cssVars({ '--ct': color })}>
    <div className="ct-head">
      <span className="ct-file mono">{t('CONTACT · FILE {n}', { n: fileNo(c) })}</span>
      {sh.known ? <span className="badge badge-cyan" title={t('Stats found (NPC or Bestiary: {name}): the contact can roll Legwork and Networking themselves', { name: sh.source })}>
        {t('NPC sheet')}
      </span> : null}
    </div>
    <div className="ct-body">
      <div className="ct-photo"><Avatar actor={{ name: c.name, portrait: sh.portrait, color }} size={big ? 84 : 52} /></div>
      <div className="ct-id"><div className="ct-name">{c.name}</div>{c.role && <div className="ct-role muted small">{c.role}</div>}</div>
    </div>
    <div className="ct-stat" title={cn ? t(CONNECTIONS[cn]) : ''}>
      <span className="ct-k">{t('contact::Connection')}</span>
      <Gauge value={cn} max={MAX_CONNECTION} kind="cn" />
      <b className="mono">{cn}</b>
      {(big || cn > 0) && <span className="ct-desc faint small">{cn ? t(CONNECTIONS[cn]) : ''}</span>}
    </div>
    <div className="ct-stat" title={lv ? t(lv.text) : ''}>
      <span className="ct-k">{t('Loyalty')}</span>
      <Gauge value={loy} max={MAX_LOYALTY} kind="loy" />
      <b className="mono">{loy}</b>
      {lv && <span className="ct-desc faint small"><b>{t(lv.name)}</b> — {t(lv.text)}</span>}
    </div>
    {children}
  </div>;
}

const RESULT_TEXT = {
  reachYes: tk('Picks up: {total} ≥ {cn}'),
  reachNo: tk('Can’t be reached right now: {total} < {cn}'),
};

/** Result line of a contact roll (log + panel). */
export function ContactRollLine({ roll }: { roll: ShownRoll | null | undefined }) {
  const c = roll?.contactRoll;
  if (!c) return null;
  let tag;
  let cls;
  let text;
  if (c.kind === 'reach') {
    cls = c.available ? 'ok' : 'bad';
    tag = c.available ? t('Available') : t('server::Unreachable');
    text = t(c.available ? RESULT_TEXT.reachYes : RESULT_TEXT.reachNo, { total: c.total, cn: c.connection });
  } else if (c.kind === 'negotiate') {
    cls = 'info';
    tag = t('Negotiation');
    text = c.bribe
      ? t('Loyalty +{l} dice, {n} bought dice ({cost})', { l: c.loyalty, n: c.bribe, cost: fmtNuyen(c.bribeCost) })
      : t('Loyalty +{l} dice', { l: c.loyalty });
  } else if (c.kind === 'legwork') {
    cls = 'info';
    tag = t('Legwork');
    text = t('{contact} asks around for {actor}: 1 hour, the GM adds up the hits until the threshold', { contact: c.contact, actor: c.via || '' });
  } else {
    cls = c.success ? 'ok' : 'bad';
    tag = c.success ? t('Meeting set') : t('No meeting');
    text = c.success
      ? t('{hits} hits vs {th}: meeting arranged (about 4D6 hours)', { hits: roll.hits, th: c.threshold })
      : t('{hits} hits vs {th}: they won’t meet (yet)', { hits: roll.hits, th: c.threshold });
  }
  return <div className={'ct-logline ' + cls}><span className="ct-logtag">{tag}</span><span className="small">{text}</span></div>;
}

function LastRoll({ r }: { r: ShownRoll | null }) {
  if (!r) return null;
  return <div className="ct-result">
    <div className="row gap-s">
      <DiceFaces roll={r} small />
      {typeof r.hits === 'number' ? <b>{r.hits}{' '}{tn(r.hits, 'one::hit', 'other::hits')}</b> : <b>{r.total}</b>}
    </div>
    <ContactRollLine roll={r} />
  </div>;
}

/** Rolls of the « Contacter » view. */
function RollPanel({ game, actor, c, gm }: { game: GameView; actor: Actor; c: Contact; gm: boolean }) {
  const sh = sheetOf(game, actor, c);
  const cn = connectionOf(c);
  const loy = loyaltyOf(c);
  const [kind, setKind] = useState('reach');
  const [mod, setMod] = useState(0);
  const [bribe, setBribe] = useState(0);
  const [useSpec, setUseSpec] = useState(false);
  const [explode, setExplode] = useState(false);
  const [threshold, setThreshold] = useState(3);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ShownRoll | null>(null);
  const neg = skillPool(actor, 'negotiation', { useSpec });
  const social = derive(actor).limits?.social;
  const spec = (actor.skills || []).find((s) => s.id === 'negotiation')?.spec;
  const run = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { actorId: actor.id, contactId: c.id, kind, modifier: mod, secret: gm && secret };
      if (kind === 'negotiate') Object.assign(payload, { bribe, useSpec, explode });
      if (kind === 'network') payload.threshold = threshold;
      setLast(await send<ShownRoll>('actor/contactRoll', payload));
      setExplode(false);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const KINDS = [
    { id: 'reach', label: t('verb::Reach') },
    { id: 'negotiate', label: t('Negotiate') },
    { id: 'legwork', label: t('Legwork'), off: !sh.known },
    { id: 'network', label: t('Networking'), off: !sh.known },
  ];
  let help: string;
  let poolText: string;
  if (kind === 'reach') {
    help = t('If the GM has no preference: 2D6, the contact is available if the total reaches their Connection (the more influential, the busier).');
    poolText = t('2D6 ≥ {cn}: {p}', { cn, p: pct(reachOdds(cn - mod)) });
  } else if (kind === 'negotiate') {
    help = t('To make them share confidential info, lower their fee or accept a favor above their Loyalty: Negotiation + Charisma [Social] + Loyalty.');
    poolText = t('{pool} + Loyalty {l}{bribe} [Social {s}]', { pool: neg.pool, l: loy, bribe: bribe ? ` + ${bribe}` : '', s: social ?? '?' });
  } else if (kind === 'legwork') {
    help = t('They don’t know but ask around: Extended Connection + Charisma [Social] Test, one roll per hour, threshold set by the GM from the difficulty.');
    poolText = sh.known ? t('Connection {cn} + CHA {cha} [Social {s}]', { cn, cha: sh.cha, s: sh.social }) : '';
  } else {
    help = t('They arrange a meeting: Etiquette + Charisma [Social] + Connection, threshold = the target’s Connection.');
    poolText = sh.known ? t('Etiquette + CHA {e} + Connection {cn} [Social {s}]', { e: sh.etiquette, cn, s: sh.social }) : '';
  }
  return <div className="ct-rolls">
    <div className="row spread"><b>{t('Call on them')}</b><RuleRef rule="contacts" /></div>
    <div className="ct-kinds" role="tablist">
      {KINDS.map((k) => <button type="button" key={k.id} className={'ct-kind' + (kind === k.id ? ' on' : '')} disabled={k.off} title={k.off ? t('{contact} has no sheet (Charisma, Etiquette): the GM can create an NPC with that name in the Bestiary', { contact: c.name }) : ''} onClick={() => setKind(k.id)}>
        {k.label}
      </button>)}
    </div>
    <div className="muted small">{help}</div>
    <div className="row gap-s wrap ct-opts">
      {kind === 'negotiate' && <>
        <label className="row gap-s small">{t('Bought dice')}{' '}<NumberInput small value={bribe} min={0} max={6} onChange={setBribe} /></label>
        {bribe > 0 && <span className="faint small">{t('{cost} to pay them', { cost: fmtNuyen(bribeCost(c, bribe)) })}</span>}{spec && <Toggle value={useSpec} onChange={setUseSpec} label={t('Specialization ({spec})', { spec })} />}
        <Toggle value={explode} onChange={setExplode} label={t('Push the Limit')} title={t('Push the Limit: +Edge, rule of six, no limit')} />
      </>}
      {kind === 'network' && <label className="row gap-s small">
        {t('Target’s Connection')}{' '}
        <NumberInput small value={threshold} min={1} max={12} onChange={setThreshold} />
      </label>}
      <label className="row gap-s small">{t('Edit')}{' '}<NumberInput small value={mod} min={-20} max={20} onChange={setMod} /></label>
    </div>
    <div className="row gap-s wrap">
      <Button variant="primary" disabled={busy} onClick={run}>{t('Roll')}</Button>
      <span className="mono small muted">{poolText}</span>
      {gm && <Toggle value={secret} onChange={setSecret} label={t('Secret')} />}
    </div>
    <LastRoll r={last} />
  </div>;
}

/** Fees + favors this contact will do without negotiating. */
function Terms({ c }: { c: Contact }) {
  const f = contactFees(c);
  const loy = loyaltyOf(c);
  return <div className="ct-terms">
    <div className="small">
      <b>{t('Usual fee')}</b> — {t('info: ~{info} · goods or services: up to ~{goods} · friendly discount: up to {pct}%', { info: fmtNuyen(f.info), goods: fmtNuyen(f.goods), pct: f.discountPct })}
    </div>
    <div className="ct-favors">
      {Object.entries(FAVOR_RATINGS as Record<string, { name: string; text: string }>).map(([n, fv]) => <div key={n} className={'ct-favor' + (Number(n) <= loy ? ' ok' : '')} title={t(fv.text)}>
        <span className="mono">{n}</span>
        <span className="small">{t(fv.name)}</span>
        <span className="faint small">{Number(n) <= loy ? t('agrees') : t('negotiate')}</span>
      </div>)}
    </div>
  </div>;
}

interface ContactModalProps {
  game: GameView;
  actor: Actor;
  c: Contact;
  gm: boolean;
  canRoll: boolean;
  onClose: () => void;
}
function ContactModal({ game, actor, c, gm, canRoll, onClose }: ContactModalProps) {
  return <Modal title={c.name} onClose={onClose} width={600}>
    <div className="ct-modal">
      <ContactCard game={game} actor={actor} c={c} big>{c.notes && <div className="ct-notes small">{c.notes}</div>}</ContactCard>
      <Terms c={c} />
      {canRoll && <RollPanel game={game} actor={actor} c={c} gm={gm} />}
    </div>
  </Modal>;
}

/** The contact list of the Contacts & SIN tab (view mode). */
export function ContactCards({ game, actor, gm, own }: { game: GameView; actor: Actor; gm: boolean; own: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const contacts = actor.contacts || [];
  if (!contacts.length) return <div className="muted small">{t('No contacts.')}</div>;
  const upItem = (id: string, patch: Partial<Contact>) => send('actor/updateItem', { actorId: actor.id, list: 'contacts', itemId: id, patch }).catch(() => {});
  const shown = open && contacts.find((x) => x.id === open);
  return <div className="ct-cards">
    {contacts.map(
      (c) => <ContactCard key={c.id} game={game} actor={actor} c={c}>
        {own
          ? <TextInput multiline rows={2} className="sh-inline-note" value={c.notes || ''} placeholder={t('Notes…')} onChange={(v) => upItem(c.id, { notes: v })} />
          : c.notes
            ? <div className="faint small">{c.notes}</div>
            : null}
        <div className="row gap-s"><Button small onClick={() => setOpen(c.id)}>{t('verb::Contact')}</Button></div>
      </ContactCard>
    )}
    {shown && <ContactModal game={game} actor={actor} c={shown} gm={gm} canRoll={gm || own} onClose={() => setOpen(null)} />}
  </div>;
}
