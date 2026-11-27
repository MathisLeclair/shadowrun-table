// SINs as ID cards (Contacts & SIN tab): holographic card per identity, « Présenter » = the card full size with the
// verification panel (SR5 p. 364: Device Rating × 2 vs the fake SIN's / license's rating, rolled by 'actor/sinCheck'),
// and the result line of a check in the log (SinCheckLine).
import { useState, type ReactNode } from 'react';
import { Button, Modal, Toggle } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, fmtDate } from '../../lib/i18n.ts';
import { Avatar, DiceFaces, cssVars } from './common.tsx';
import {
  FAKE_SIN_DETAILS, VERIFICATION_DETAILS, OUTCOME_LABELS, MAX_DEVICE_RATING, isRealSin, sinRating, sinIdentity, sinLicenses, sinNumber,
  verificationPool, checkOdds,
} from '/shared/sins.ts';

import type { Actor, Sin, SinCheckInfo } from '../../../shared/types.ts';
import type { ShownRoll } from './types.ts';
import './sins.css';
import { RuleRef } from '../books/BookRef.tsx';

const FAKE_DETAILS = FAKE_SIN_DETAILS as Record<number, string>;
const DEVICE_DETAILS = VERIFICATION_DETAILS as Record<number, string>;
const OUTCOMES = OUTCOME_LABELS as Record<string, string>;
/** A license of sinLicenses(). */
interface SinLicense {
  name: string;
  rating: number;
} // also needed by the log dock (SinCheckLine)

const pct = (x: number): string => (x > 0 && x < 0.005 ? '< 1 %' : x < 1 && x > 0.995 ? '> 99 %' : `${Math.round(x * 100)} %`);

/** The status stamp of a card: burned / real / nothing. */
function Stamp({ sin }: { sin: Sin }) {
  if (sin.burned) return <span className="sin-stamp burned" title={sin.burnedAt ? t('Grillé le {date}', { date: fmtDate(sin.burnedAt) }) : ''}>{t('Grillé')}</span>;
  return null;
}

/** One ID card. big = the « Présenter » view (larger, animated hologram). */
export function SinCard({ actor, sin, big, children }: { actor: Actor; sin: Sin; big?: boolean; children?: ReactNode }) {
  const real = isRealSin(sin);
  const rating = sinRating(sin);
  const lics: SinLicense[] = sinLicenses(sin);
  const klass = `sin-card${big ? ' big' : ''}${sin.burned ? ' is-burned' : ''}${real ? ' is-real' : ''}`;
  return <div className={klass} style={cssVars({ '--pc': actor.color || 'var(--cyan)' })}>
    <div className="sin-holo" aria-hidden="true" />
    <div className="sin-head">
      <span className="sin-issuer">{t('SIN · Identité numérique')}</span>
      {real
        ? <span className="badge badge-green" title={t('Un vrai SIN passe toujours le contrôle')}>{t('Légitime')}</span>
        : <span className="badge badge-amber" title={rating ? t(FAKE_DETAILS[rating]) : ''}>{t('Indice {n}', { n: rating || '?' })}</span>}
    </div>
    <div className="sin-body">
      <div className="sin-photo"><Avatar actor={actor} size={big ? 96 : 58} /></div>
      <div className="sin-id">
        <div className="sin-name">{sinIdentity(sin)}</div>
        <div className="sin-number mono">SIN {sinNumber(sin)}</div>
        {!real && rating > 0 && <div className="sin-quality faint small">{t(FAKE_DETAILS[rating])}</div>}
      </div>
    </div>
    <div className="sin-lics">
      {lics.length
        ? lics.map((l, i) => <span className="sin-lic" key={i} title={t('Licence (indice {n})', { n: l.rating })}>{l.name}<b>{l.rating}</b></span>)
        : <span className="faint small">{t('Aucune licence')}</span>}
    </div>
    {sin.notes && <div className="sin-notes faint small">{sin.notes}</div>}
    <div className="sin-barcode" aria-hidden="true" />
    <Stamp sin={sin} />
    {children}
  </div>;
}

/** Verification panel of the « Présenter » view. */
function CheckPanel({ actor, sin, gm }: { actor: Actor; sin: Sin; gm: boolean }) {
  const lics: SinLicense[] = sinLicenses(sin);
  const [device, setDevice] = useState(3);
  const [target, setTarget] = useState(''); // '' = the SIN, else a license index
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ShownRoll | null>(null);
  const lic = target === '' ? null : lics[Number(target)];
  const threshold = lic ? lic.rating : sinRating(sin);
  const pool = verificationPool(device);
  const odds = checkOdds(pool, threshold);
  const run = async () => {
    setBusy(true);
    try {
      const r = await send<ShownRoll>('actor/sinCheck', { actorId: actor.id, sinId: sin.id, license: lic ? Number(target) : null, device, secret: gm && secret });
      setLast(r);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (sin.burned) {
    return <div className="sin-check">
      <div className="sin-result burned">{t('Ce SIN est grillé : tout contrôle échoue d’office.')}</div>
      <div className="row gap-s"><Button small disabled={busy} onClick={run}>{t('Présenter quand même')}</Button></div>
      {last && <CheckResult r={last} />}
    </div>;
  }
  return <div className="sin-check">
    <div className="row spread"><b>{t('Contrôle par un système de vérification')}</b><RuleRef rule="fakeSin" /></div>
    <div className="sin-devices" role="group" aria-label={t('Indice du système')}>
      {Array.from({ length: MAX_DEVICE_RATING }, (_, i) => i + 1).map((n) => <button type="button" key={n} className={'sin-dev' + (n === device ? ' on' : '')} title={t(DEVICE_DETAILS[n])} onClick={() => setDevice(n)}>
        {n}
      </button>)}
    </div>
    <div className="muted small">{t('Indice {n} : {what}', { n: device, what: t(DEVICE_DETAILS[device]) })}</div>
    {lics.length > 0 && <label className="row gap-s small">
      {t('Vérifier')}
      <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{t('Le SIN (indice {n})', { n: sinRating(sin) })}</option>
        {lics.map((l, i) => <option value={String(i)} key={i}>{t('Licence : {name} (indice {n})', { name: l.name, n: l.rating })}</option>)}
      </select>
    </label>}
    <div className="sin-odds small">
      <span>{t('{n} dés contre un seuil de {th}', { n: pool, th: threshold })}</span>
      <span className="ok">{t('Accepté {p}', { p: pct(odds.pass) })}</span>
      <span className="odd">{t('Anomalie {p}', { p: pct(odds.odd) })}</span>
      <span className="bad">{t('Grillé {p}', { p: pct(odds.burned) })}</span>
    </div>
    <div className="row gap-s wrap">
      <Button variant="primary" disabled={busy} onClick={run}>{t('Lancer le contrôle')}</Button>
      {gm && <Toggle value={secret} onChange={setSecret} label={t('Secret')} title={t('Jet visible du MJ seulement ; le SIN n’est pas grillé automatiquement')} />}
    </div>
    {last && <CheckResult r={last} />}
  </div>;
}

const OUTCOME_TEXT: Record<string, string> = {
  pass: tk('Aucun problème : le système accepte l’identité.'),
  odd: tk('Quelque chose cloche : le système recommande une vérification approfondie.'),
  burned: tk('Identité signalée comme fausse : le SIN est grillé.'),
};

function outcomeText(c: SinCheckInfo): string {
  if (c.outcome === 'burned' && !c.burnedNow) return t('Identité signalée comme fausse (jet secret : le MJ décide).');
  return t(OUTCOME_TEXT[c.outcome] || '');
}

/** Result of a check just rolled (the panel) — same text as the log line. */
function CheckResult({ r }: { r: ShownRoll }) {
  const c: SinCheckInfo = r.sinCheck || (r as unknown as SinCheckInfo); // older replies carried the check at the top level
  if (c.outcome === 'auto') return <div className="sin-result burned">{t('Contrôle échoué (SIN grillé).')}</div>;
  return <div className={'sin-result ' + c.outcome}>
    <DiceFaces roll={r} small />
    <div><b>{t(OUTCOMES[c.outcome])}</b> — {t('{hits} succès contre un seuil de {th}', { hits: r.hits, th: c.threshold })}</div>
    <div className="small">{outcomeText(c)}</div>
  </div>;
}

/** Result line under a SIN check in the log. */
export function SinCheckLine({ roll }: { roll: ShownRoll | null | undefined }) {
  const c = roll?.sinCheck;
  if (!c) return null;
  return <div className={'sin-logline ' + c.outcome}>
    <span className="sin-logtag">{t(OUTCOMES[c.outcome])}</span>
    <span className="small">
      {t('Système d’indice {d} ({n} dés) contre {th}', { d: c.device, n: (c.device || 0) * 2, th: c.threshold })} · {outcomeText(c)}
    </span>
  </div>;
}

/** Full-size card + verification (« Présenter »). */
function SinModal({ actor, sin, gm, canCheck, onClose }: { actor: Actor; sin: Sin; gm: boolean; canCheck: boolean; onClose: () => void }) {
  return <Modal title={sinIdentity(sin)} onClose={onClose} width={560}>
    <div className="sin-modal">
      <SinCard actor={actor} sin={sin} big />
      {canCheck && !isRealSin(sin) && <CheckPanel actor={actor} sin={sin} gm={gm} />}{isRealSin(sin) && <div className="muted small">{t('Un vrai SIN passe toujours le contrôle')}</div>}
    </div>
  </Modal>;
}

/** The SIN list of the Contacts & SIN tab (view mode). */
export function SinCards({ actor, gm, own }: { actor: Actor; gm: boolean; own: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const sins = actor.sins || [];
  const canCheck = gm || own;
  if (!sins.length) return <div className="muted small">{t('Aucun SIN.')}</div>;
  const shown = open && sins.find((x) => x.id === open);
  const burn = (sin: Sin, burned: boolean) => send('actor/sinBurn', { actorId: actor.id, sinId: sin.id, burned }).catch((err: Error) => toast(err.message, 'error'));
  return <div className="sin-cards">
    {sins.map(
      (sin) => <SinCard key={sin.id} actor={actor} sin={sin}>
        <div className="sin-actions">
          <Button small onClick={() => setOpen(sin.id)}>{canCheck && !isRealSin(sin) ? t('Présenter / contrôler') : t('Présenter')}</Button>
          {gm && !isRealSin(sin) && <Button small variant={sin.burned ? 'default' : 'danger'} onClick={() => burn(sin, !sin.burned)} title={sin.burned ? t('Le SIN redevient utilisable (autre pays, données pas encore partagées)') : t('Marquer ce SIN comme grillé')}>
            {sin.burned ? t('Restaurer') : t('Griller')}
          </Button>}
        </div>
      </SinCard>
    )}
    {shown && <SinModal actor={actor} sin={shown} gm={gm} canCheck={canCheck} onClose={() => setOpen(null)} />}
  </div>;
}
