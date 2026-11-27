// Contacts as dossiers (Contacts & SIN tab): one card per contact (portrait from an NPC / bestiary sheet of the same name,
// Connection and Loyalty gauges with the SR5 table texts), « Contacter » = the dossier full size with fees, favors and the
// rolls of SR5 p. 387-389 ('actor/contactRoll'), and the result line of those rolls in the log (ContactRollLine).
import { useState } from 'preact/hooks';
import { html, Button, Modal, Toggle, NumberInput, TextInput, loadCss } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tn, tk, fmtNuyen } from '../../lib/i18n.js';
import { skillPool, derive } from '/shared/sr5.js';
import { Avatar, DiceFaces } from './common.js';
import { RuleRef } from '../books/BookRef.js';
import {
  CONNECTION_DETAILS, LOYALTY_LEVELS, FAVOR_RATINGS, MAX_CONNECTION, MAX_LOYALTY, connectionOf, loyaltyOf, contactFees, bribeCost, contactSheet,
} from '/shared/contacts.js';

loadCss('/modules/sheet/contacts.css'); // also needed by the log dock (ContactRollLine)

/** Stable hue per contact name (initials avatar without a sheet). */
function nameColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 55%)`;
}
/** Short decorative file number. */
function fileNo(c) {
  let h = 7;
  for (const ch of String(c.id || c.name || '')) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).toUpperCase().padStart(6, '0').slice(-6);
}
/** P(2D6 ≥ n). */
function reachOdds(n) {
  let ok = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b >= n) ok++;
  return ok / 36;
}
const pct = (x) => `${Math.round(x * 100)} %`;

/** The contact's sheet: GM computes it from the bestiary / NPCs, players get it from the shop view (bestiary hidden). */
export function sheetOf(game, actor, c) {
  if (game?.bestiary || !game?.shop?.contactSearch) return contactSheet(game, c);
  return (game.shop.contactSearch[actor.id] || []).find((x) => x.id === c.id) || { id: c.id, name: c.name, connection: connectionOf(c), known: false };
}

function Gauge({ value, max, kind }) {
  return html`<span class=${'ct-gauge ' + kind} aria-hidden="true">${Array.from({ length: max }, (_, i) => html`<i key=${i} class=${i < value ? 'on' : ''} />`)}</span>`;
}

/** One dossier card. big = the « Contacter » view. */
export function ContactCard({ game, actor, c, big, children }) {
  const sh = sheetOf(game, actor, c);
  const cn = connectionOf(c);
  const loy = loyaltyOf(c);
  const lv = LOYALTY_LEVELS[loy];
  const color = sh.color || nameColor(c.name);
  return html`<div class=${'ct-card' + (big ? ' big' : '')} style=${{ '--ct': color }}>
    <div class="ct-head">
      <span class="ct-file mono">${t('CONTACT · DOSSIER {n}', { n: fileNo(c) })}</span>
      ${sh.known ? html`<span class="badge badge-cyan" title=${t('Stats trouvées (PNJ ou Bestiaire : {name}) : le contact peut faire Enquête et Réseau lui-même', { name: sh.source })}>${t('fiche PNJ')}</span>` : null}
    </div>
    <div class="ct-body">
      <div class="ct-photo"><${Avatar} actor=${{ name: c.name, portrait: sh.portrait, color }} size=${big ? 84 : 52} /></div>
      <div class="ct-id">
        <div class="ct-name">${c.name}</div>
        ${c.role && html`<div class="ct-role muted small">${c.role}</div>`}
      </div>
    </div>
    <div class="ct-stat" title=${cn ? t(CONNECTION_DETAILS[cn]) : ''}>
      <span class="ct-k">${t('contact::Connexion')}</span><${Gauge} value=${cn} max=${MAX_CONNECTION} kind="cn" /><b class="mono">${cn}</b>
      ${(big || cn > 0) && html`<span class="ct-desc faint small">${cn ? t(CONNECTION_DETAILS[cn]) : ''}</span>`}
    </div>
    <div class="ct-stat" title=${lv ? t(lv.text) : ''}>
      <span class="ct-k">${t('Loyauté')}</span><${Gauge} value=${loy} max=${MAX_LOYALTY} kind="loy" /><b class="mono">${loy}</b>
      ${lv && html`<span class="ct-desc faint small"><b>${t(lv.name)}</b> — ${t(lv.text)}</span>`}
    </div>
    ${children}
  </div>`;
}

const RESULT_TEXT = {
  reachYes: tk('Décroche : {total} ≥ {cn}'),
  reachNo: tk('Injoignable pour l’instant : {total} < {cn}'),
};

/** Result line of a contact roll (log + panel). */
export function ContactRollLine({ roll }) {
  const c = roll?.contactRoll;
  if (!c) return null;
  let tag;
  let cls;
  let text;
  if (c.kind === 'reach') {
    cls = c.available ? 'ok' : 'bad';
    tag = c.available ? t('Disponible') : t('Injoignable');
    text = t(c.available ? RESULT_TEXT.reachYes : RESULT_TEXT.reachNo, { total: c.total, cn: c.connection });
  } else if (c.kind === 'negotiate') {
    cls = 'info';
    tag = t('Négociation');
    text = c.bribe
      ? t('Loyauté +{l} dés, {n} dés achetés ({cost})', { l: c.loyalty, n: c.bribe, cost: fmtNuyen(c.bribeCost) })
      : t('Loyauté +{l} dés', { l: c.loyalty });
  } else if (c.kind === 'legwork') {
    cls = 'info';
    tag = t('Enquête');
    text = t('{contact} se renseigne pour {actor} : 1 heure, le MJ cumule les succès jusqu’au seuil', { contact: c.contact, actor: c.via || '' });
  } else {
    cls = c.success ? 'ok' : 'bad';
    tag = c.success ? t('Rendez-vous') : t('Pas de rendez-vous');
    text = c.success
      ? t('{hits} succès contre {th} : rencontre arrangée (environ 4D6 heures)', { hits: roll.hits, th: c.threshold })
      : t('{hits} succès contre {th} : la personne ne veut pas (encore) rencontrer', { hits: roll.hits, th: c.threshold });
  }
  return html`<div class=${'ct-logline ' + cls}><span class="ct-logtag">${tag}</span><span class="small">${text}</span></div>`;
}

function LastRoll({ r }) {
  if (!r) return null;
  return html`<div class="ct-result">
    <div class="row gap-s"><${DiceFaces} roll=${r} small />${typeof r.hits === 'number' ? html`<b>${r.hits} ${tn(r.hits, 'one::succès', 'other::succès')}</b>` : html`<b>${r.total}</b>`}</div>
    <${ContactRollLine} roll=${r} />
  </div>`;
}

/** Rolls of the « Contacter » view. */
function RollPanel({ game, actor, c, gm }) {
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
  const [last, setLast] = useState(null);
  const neg = skillPool(actor, 'negotiation', { useSpec });
  const social = derive(actor).limits?.social;
  const spec = (actor.skills || []).find((s) => s.id === 'negotiation')?.spec;
  const run = async () => {
    setBusy(true);
    try {
      const payload = { actorId: actor.id, contactId: c.id, kind, modifier: mod, secret: gm && secret };
      if (kind === 'negotiate') Object.assign(payload, { bribe, useSpec, explode });
      if (kind === 'network') payload.threshold = threshold;
      setLast(await send('actor/contactRoll', payload));
      setExplode(false);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const KINDS = [
    { id: 'reach', label: t('Joindre') },
    { id: 'negotiate', label: t('Négocier') },
    { id: 'legwork', label: t('Enquête'), off: !sh.known },
    { id: 'network', label: t('Réseau'), off: !sh.known },
  ];
  let help;
  let poolText;
  if (kind === 'reach') {
    help = t('Si le MJ n’a pas d’avis : 2D6, le contact décroche si le total atteint sa Connexion (plus il est influent, plus il est occupé).');
    poolText = t('2D6 ≥ {cn} : {p}', { cn, p: pct(reachOdds(cn - mod)) });
  } else if (kind === 'negotiate') {
    help = t('Pour qu’il partage une info confidentielle, baisser son tarif ou accepter une faveur au-dessus de sa Loyauté : Négociation + Charisme [Sociale] + Loyauté.');
    poolText = t('{pool} + Loyauté {l}{bribe} [Sociale {s}]', { pool: neg.pool, l: loy, bribe: bribe ? ` + ${bribe}` : '', s: social ?? '?' });
  } else if (kind === 'legwork') {
    help = t('Il ne sait rien mais demande autour de lui : test étendu Connexion + Charisme [Sociale], un jet par heure, seuil fixé par le MJ selon la difficulté.');
    poolText = sh.known ? t('Connexion {cn} + CHA {cha} [Sociale {s}]', { cn, cha: sh.cha, s: sh.social }) : '';
  } else {
    help = t('Il arrange une rencontre : Étiquette + Charisme [Sociale] + Connexion, seuil = Connexion de la personne visée.');
    poolText = sh.known ? t('Étiquette + CHA {e} + Connexion {cn} [Sociale {s}]', { e: sh.etiquette, cn, s: sh.social }) : '';
  }
  return html`<div class="ct-rolls">
    <div class="row spread"><b>${t('Faire appel à lui')}</b><${RuleRef} rule="contacts" /></div>
    <div class="ct-kinds" role="tablist">
      ${KINDS.map((k) => html`<button type="button" key=${k.id} class=${'ct-kind' + (kind === k.id ? ' on' : '')} disabled=${k.off}
        title=${k.off ? t('{contact} n’a pas de fiche (Charisme, Étiquette) : le MJ peut créer un PNJ de ce nom dans le Bestiaire', { contact: c.name }) : ''}
        onClick=${() => setKind(k.id)}>${k.label}</button>`)}
    </div>
    <div class="muted small">${help}</div>
    <div class="row gap-s wrap ct-opts">
      ${kind === 'negotiate' && html`
        <label class="row gap-s small">${t('Dés achetés')} <${NumberInput} small value=${bribe} min=${0} max=${6} onChange=${setBribe} /></label>
        ${bribe > 0 && html`<span class="faint small">${t('{cost} à lui verser', { cost: fmtNuyen(bribeCost(c, bribe)) })}</span>`}
        ${spec && html`<${Toggle} value=${useSpec} onChange=${setUseSpec} label=${t('Spécialisation ({spec})', { spec })} />`}
        <${Toggle} value=${explode} onChange=${setExplode} label=${t('Repousser les limites')} title=${t('Repousser les limites : +Chance, règle des 6, sans limite')} />`}
      ${kind === 'network' && html`<label class="row gap-s small">${t('Connexion de la cible')} <${NumberInput} small value=${threshold} min=${1} max=${12} onChange=${setThreshold} /></label>`}
      <label class="row gap-s small">${t('Modificateur')} <${NumberInput} small value=${mod} min=${-20} max=${20} onChange=${setMod} /></label>
    </div>
    <div class="row gap-s wrap">
      <${Button} variant="primary" disabled=${busy} onClick=${run}>${t('Lancer')}</${Button}>
      <span class="mono small muted">${poolText}</span>
      ${gm && html`<${Toggle} value=${secret} onChange=${setSecret} label=${t('Secret')} />`}
    </div>
    <${LastRoll} r=${last} />
  </div>`;
}

/** Fees + favors this contact will do without negotiating. */
function Terms({ c }) {
  const f = contactFees(c);
  const loy = loyaltyOf(c);
  return html`<div class="ct-terms">
    <div class="small"><b>${t('Tarif habituel')}</b> — ${t('info : ~{info} · biens ou services : jusqu’à ~{goods} · remise entre amis : jusqu’à {pct} %', { info: fmtNuyen(f.info), goods: fmtNuyen(f.goods), pct: f.discountPct })}</div>
    <div class="ct-favors">
      ${Object.entries(FAVOR_RATINGS).map(([n, fv]) => html`<div key=${n} class=${'ct-favor' + (Number(n) <= loy ? ' ok' : '')} title=${t(fv.text)}>
        <span class="mono">${n}</span><span class="small">${t(fv.name)}</span>
        <span class="faint small">${Number(n) <= loy ? t('accepte') : t('à négocier')}</span>
      </div>`)}
    </div>
  </div>`;
}

function ContactModal({ game, actor, c, gm, canRoll, onClose }) {
  return html`<${Modal} title=${c.name} onClose=${onClose} width=${600}>
    <div class="ct-modal">
      <${ContactCard} game=${game} actor=${actor} c=${c} big>
        ${c.notes && html`<div class="ct-notes small">${c.notes}</div>`}
      </${ContactCard}>
      <${Terms} c=${c} />
      ${canRoll && html`<${RollPanel} game=${game} actor=${actor} c=${c} gm=${gm} />`}
    </div>
  </${Modal}>`;
}

/** The contact list of the Contacts & SIN tab (view mode). */
export function ContactCards({ game, actor, gm, own }) {
  const [open, setOpen] = useState(null);
  const contacts = actor.contacts || [];
  if (!contacts.length) return html`<div class="muted small">${t('Aucun contact.')}</div>`;
  const upItem = (id, patch) => send('actor/updateItem', { actorId: actor.id, list: 'contacts', itemId: id, patch }).catch(() => {});
  const shown = open && contacts.find((x) => x.id === open);
  return html`<div class="ct-cards">
    ${contacts.map(
      (c) => html`<${ContactCard} key=${c.id} game=${game} actor=${actor} c=${c}>
        ${own
          ? html`<${TextInput} multiline rows=${2} class="sh-inline-note" value=${c.notes || ''} placeholder=${t('Notes…')} onChange=${(v) => upItem(c.id, { notes: v })} />`
          : c.notes
            ? html`<div class="faint small">${c.notes}</div>`
            : null}
        <div class="row gap-s"><${Button} small onClick=${() => setOpen(c.id)}>${t('Contacter')}</${Button}></div>
      </${ContactCard}>`
    )}
    ${shown && html`<${ContactModal} game=${game} actor=${actor} c=${shown} gm=${gm} canRoll=${gm || own} onClose=${() => setOpen(null)} />`}
  </div>`;
}
