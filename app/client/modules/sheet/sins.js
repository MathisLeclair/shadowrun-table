// SINs as ID cards (Contacts & SIN tab): holographic card per identity, « Présenter » = the card full size with the
// verification panel (SR5 p. 364: Device Rating × 2 vs the fake SIN's / license's rating, rolled by 'actor/sinCheck'),
// and the result line of a check in the log (SinCheckLine).
import { useState } from 'preact/hooks';
import { html, Button, Modal, Toggle, loadCss } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tk, fmtDate } from '../../lib/i18n.js';
import { Avatar, DiceFaces } from './common.js';
import { RuleRef } from '../books/BookRef.js';
import {
  FAKE_SIN_DETAILS, VERIFICATION_DETAILS, OUTCOME_LABELS, MAX_DEVICE_RATING, isRealSin, sinRating, sinIdentity, sinLicenses, sinNumber,
  verificationPool, checkOdds,
} from '/shared/sins.js';

loadCss('/modules/sheet/sins.css'); // also needed by the log dock (SinCheckLine)

const pct = (x) => (x > 0 && x < 0.005 ? '< 1 %' : x < 1 && x > 0.995 ? '> 99 %' : `${Math.round(x * 100)} %`);

/** The status stamp of a card: burned / real / nothing. */
function Stamp({ sin }) {
  if (sin.burned) return html`<span class="sin-stamp burned" title=${sin.burnedAt ? t('Grillé le {date}', { date: fmtDate(sin.burnedAt) }) : ''}>${t('Grillé')}</span>`;
  return null;
}

/** One ID card. big = the « Présenter » view (larger, animated hologram). */
export function SinCard({ actor, sin, big, children }) {
  const real = isRealSin(sin);
  const rating = sinRating(sin);
  const lics = sinLicenses(sin);
  const klass = `sin-card${big ? ' big' : ''}${sin.burned ? ' is-burned' : ''}${real ? ' is-real' : ''}`;
  return html`<div class=${klass} style=${{ '--pc': actor.color || 'var(--cyan)' }}>
    <div class="sin-holo" aria-hidden="true"></div>
    <div class="sin-head">
      <span class="sin-issuer">${t('SIN · Identité numérique')}</span>
      ${real
        ? html`<span class="badge badge-green" title=${t('Un vrai SIN passe toujours le contrôle')}>${t('Légitime')}</span>`
        : html`<span class="badge badge-amber" title=${rating ? t(FAKE_SIN_DETAILS[rating]) : ''}>${t('Indice {n}', { n: rating || '?' })}</span>`}
    </div>
    <div class="sin-body">
      <div class="sin-photo"><${Avatar} actor=${actor} size=${big ? 96 : 58} /></div>
      <div class="sin-id">
        <div class="sin-name">${sinIdentity(sin)}</div>
        <div class="sin-number mono">SIN ${sinNumber(sin)}</div>
        ${!real && rating > 0 && html`<div class="sin-quality faint small">${t(FAKE_SIN_DETAILS[rating])}</div>`}
      </div>
    </div>
    <div class="sin-lics">
      ${lics.length
        ? lics.map((l, i) => html`<span class="sin-lic" key=${i} title=${t('Licence (indice {n})', { n: l.rating })}>${l.name}<b>${l.rating}</b></span>`)
        : html`<span class="faint small">${t('Aucune licence')}</span>`}
    </div>
    ${sin.notes && html`<div class="sin-notes faint small">${sin.notes}</div>`}
    <div class="sin-barcode" aria-hidden="true"></div>
    <${Stamp} sin=${sin} />
    ${children}
  </div>`;
}

/** Verification panel of the « Présenter » view. */
function CheckPanel({ actor, sin, gm }) {
  const lics = sinLicenses(sin);
  const [device, setDevice] = useState(3);
  const [target, setTarget] = useState(''); // '' = the SIN, else a license index
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const lic = target === '' ? null : lics[Number(target)];
  const threshold = lic ? lic.rating : sinRating(sin);
  const pool = verificationPool(device);
  const odds = checkOdds(pool, threshold);
  const run = async () => {
    setBusy(true);
    try {
      const r = await send('actor/sinCheck', { actorId: actor.id, sinId: sin.id, license: lic ? Number(target) : null, device, secret: gm && secret });
      setLast(r);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (sin.burned) {
    return html`<div class="sin-check">
      <div class="sin-result burned">${t('Ce SIN est grillé : tout contrôle échoue d’office.')}</div>
      <div class="row gap-s"><${Button} small disabled=${busy} onClick=${run}>${t('Présenter quand même')}</${Button}></div>
      ${last && html`<${CheckResult} r=${last} />`}
    </div>`;
  }
  return html`<div class="sin-check">
    <div class="row spread"><b>${t('Contrôle par un système de vérification')}</b><${RuleRef} rule="fakeSin" /></div>
    <div class="sin-devices" role="group" aria-label=${t('Indice du système')}>
      ${Array.from({ length: MAX_DEVICE_RATING }, (_, i) => i + 1).map((n) => html`<button type="button" key=${n} class=${'sin-dev' + (n === device ? ' on' : '')}
        title=${t(VERIFICATION_DETAILS[n])} onClick=${() => setDevice(n)}>${n}</button>`)}
    </div>
    <div class="muted small">${t('Indice {n} : {what}', { n: device, what: t(VERIFICATION_DETAILS[device]) })}</div>
    ${lics.length > 0 && html`<label class="row gap-s small">${t('Vérifier')}
      <select class="input" value=${target} onChange=${(e) => setTarget(e.target.value)}>
        <option value="">${t('Le SIN (indice {n})', { n: sinRating(sin) })}</option>
        ${lics.map((l, i) => html`<option value=${String(i)} key=${i}>${t('Licence : {name} (indice {n})', { name: l.name, n: l.rating })}</option>`)}
      </select></label>`}
    <div class="sin-odds small">
      <span>${t('{n} dés contre un seuil de {th}', { n: pool, th: threshold })}</span>
      <span class="ok">${t('Accepté {p}', { p: pct(odds.pass) })}</span>
      <span class="odd">${t('Anomalie {p}', { p: pct(odds.odd) })}</span>
      <span class="bad">${t('Grillé {p}', { p: pct(odds.burned) })}</span>
    </div>
    <div class="row gap-s wrap">
      <${Button} variant="primary" disabled=${busy} onClick=${run}>${t('Lancer le contrôle')}</${Button}>
      ${gm && html`<${Toggle} value=${secret} onChange=${setSecret} label=${t('Secret')} title=${t('Jet visible du MJ seulement ; le SIN n’est pas grillé automatiquement')} />`}
    </div>
    ${last && html`<${CheckResult} r=${last} />`}
  </div>`;
}

const OUTCOME_TEXT = {
  pass: tk('Aucun problème : le système accepte l’identité.'),
  odd: tk('Quelque chose cloche : le système recommande une vérification approfondie.'),
  burned: tk('Identité signalée comme fausse : le SIN est grillé.'),
};

function outcomeText(c) {
  if (c.outcome === 'burned' && !c.burnedNow) return t('Identité signalée comme fausse (jet secret : le MJ décide).');
  return t(OUTCOME_TEXT[c.outcome] || '');
}

/** Result of a check just rolled (the panel) — same text as the log line. */
function CheckResult({ r }) {
  const c = r.sinCheck || r;
  if (c.outcome === 'auto') return html`<div class="sin-result burned">${t('Contrôle échoué (SIN grillé).')}</div>`;
  return html`<div class=${'sin-result ' + c.outcome}>
    <${DiceFaces} roll=${r} small />
    <div><b>${t(OUTCOME_LABELS[c.outcome])}</b> — ${t('{hits} succès contre un seuil de {th}', { hits: r.hits, th: c.threshold })}</div>
    <div class="small">${outcomeText(c)}</div>
  </div>`;
}

/** Result line under a SIN check in the log. */
export function SinCheckLine({ roll }) {
  const c = roll?.sinCheck;
  if (!c) return null;
  return html`<div class=${'sin-logline ' + c.outcome}>
    <span class="sin-logtag">${t(OUTCOME_LABELS[c.outcome])}</span>
    <span class="small">${t('Système d’indice {d} ({n} dés) contre {th}', { d: c.device, n: (c.device || 0) * 2, th: c.threshold })} · ${outcomeText(c)}</span>
  </div>`;
}

/** Full-size card + verification (« Présenter »). */
function SinModal({ actor, sin, gm, canCheck, onClose }) {
  return html`<${Modal} title=${sinIdentity(sin)} onClose=${onClose} width=${560}>
    <div class="sin-modal">
      <${SinCard} actor=${actor} sin=${sin} big />
      ${canCheck && !isRealSin(sin) && html`<${CheckPanel} actor=${actor} sin=${sin} gm=${gm} />`}
      ${isRealSin(sin) && html`<div class="muted small">${t('Un vrai SIN passe toujours le contrôle')}</div>`}
    </div>
  </${Modal}>`;
}

/** The SIN list of the Contacts & SIN tab (view mode). */
export function SinCards({ actor, gm, own }) {
  const [open, setOpen] = useState(null);
  const sins = actor.sins || [];
  const canCheck = gm || own;
  if (!sins.length) return html`<div class="muted small">${t('Aucun SIN.')}</div>`;
  const shown = open && sins.find((x) => x.id === open);
  const burn = (sin, burned) => send('actor/sinBurn', { actorId: actor.id, sinId: sin.id, burned }).catch((err) => toast(err.message, 'error'));
  return html`<div class="sin-cards">
    ${sins.map(
      (sin) => html`<${SinCard} key=${sin.id} actor=${actor} sin=${sin}>
        <div class="sin-actions">
          <${Button} small onClick=${() => setOpen(sin.id)}>${canCheck && !isRealSin(sin) ? t('Présenter / contrôler') : t('Présenter')}</${Button}>
          ${gm && !isRealSin(sin) && html`<${Button} small variant=${sin.burned ? 'default' : 'danger'} onClick=${() => burn(sin, !sin.burned)}
            title=${sin.burned ? t('Le SIN redevient utilisable (autre pays, données pas encore partagées)') : t('Marquer ce SIN comme grillé')}>${sin.burned ? t('Restaurer') : t('Griller')}</${Button}>`}
        </div>
      </${SinCard}>`
    )}
    ${shown && html`<${SinModal} actor=${actor} sin=${shown} gm=${gm} canCheck=${canCheck} onClose=${() => setOpen(null)} />`}
  </div>`;
}
