// Shared bits of the sheet module: permissions, overlay dialog, dice faces, condition tracks, Edge pips.
import { useEffect } from 'preact/hooks';
import { html, IconButton } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { derive, attr, SKILL_BY_ID } from '/shared/sr5.js';
import { healthStatus, STATUS_COLORS, STATUS_LABELS } from './sheet-data.js';
import { t, tn, tk, tIfKnown, getLang, skillLabel, attrShort, fmtDate as fmtLocaleDate } from '../../lib/i18n.js';

export const isGM = (game) => game?.me?.role === 'gm';
/** GM, or the player controls this actor. */
export const ownsActor = (game, actorId) => isGM(game) || (game?.me?.characterIds || []).includes(actorId);
/** Players receive a reduced NPC object (no attributes) for enemies. */
export const isRestricted = (actor) => !actor?.attributes;

export function ownerOf(game, actorId) {
  return Object.values(game?.users || {}).find((u) => (u.characterIds || []).includes(actorId)) || null;
}

export function actorStatus(actor) {
  if (!actor) return 'indemne';
  if (actor.status) return actor.status;
  const d = derive(actor);
  return healthStatus(actor.condition, d.physicalMonitor, d.stunMonitor, d.overflowMax);
}
export const statusColor = (s) => STATUS_COLORS[s] || 'dim';
/** Stored French health status ('blessé'…) → label in the UI language. */
export const statusLabel = (s) => (STATUS_LABELS[s] ? t(STATUS_LABELS[s]) : tIfKnown(String(s ?? '')));

/**
 * Translated sentence with markup inside: tRich(t('Avant : {push}.'), { push: html`<b>…</b>` }) → array of
 * text/vnodes. Pass the already translated text (t() without params keeps the {name} markers).
 */
export function tRich(text, nodes) {
  return String(text)
    .split(/\{(\w+)\}/)
    .map((part, i) => (i % 2 ? (nodes && part in nodes ? nodes[part] : `{${part}}`) : part));
}

export function initials(name = '') {
  return String(name)
    .replace(/[’']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtDate(ts) {
  const d = new Date(ts);
  return fmtLocaleDate(d, { day: '2-digit', month: '2-digit', year: '2-digit' });
}
/** Name of an actor skill: the stored name in French (as before), the official SR5 English name in English. */
export function skillName(sk, id) {
  if (getLang() === 'fr') return sk?.name || SKILL_BY_ID[id ?? sk?.id]?.fr || id || sk?.id || '';
  return skillLabel(sk && (sk.id || sk.name) ? sk : id);
}

export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
export const fmtNum = (n) => (getLang() === 'en' ? String(n) : String(n).replace('.', ','));

/** Avatar: portrait image or initials on the actor color. */
export function Avatar({ actor, size = 40, class: klass = '' }) {
  const color = actor?.color || '#3fd6d0';
  const style = { width: `${size}px`, height: `${size}px`, '--av': color, fontSize: `${Math.round(size * 0.38)}px` };
  return actor?.portrait
    ? html`<img class=${'sh-avatar ' + klass} style=${style} src=${actor.portrait} alt="" loading="lazy" />`
    : html`<span class=${'sh-avatar sh-avatar-init ' + klass} style=${style}>${initials(actor?.name)}</span>`;
}

/**
 * Dialog usable inside the sheet modal: Escape closes only this dialog (capture listener stops the event
 * before the global Modal sees it). Same look as the core Modal.
 */
export function Overlay({ title, onClose, width = 560, children, actions, class: klass = '' }) {
  useEffect(() => {
    const k = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return html`<div class="modal-backdrop sh-overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class=${'modal ' + klass} style=${{ width: `min(${width}px, calc(100vw - 24px))` }} role="dialog" aria-label=${title}>
      <header class="modal-head">
        <h2>${title}</h2>
        <div class="row gap-s">${actions}<${IconButton} icon="✕" title=${t('Fermer')} onClick=${onClose} /></div>
      </header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

// Roll labels and breakdowns are stored in French by the server ('Défense', 'Agilité + Logique', '6 dés',
// 'Pistolets 4 + AGI 5 + spé. +2'): every viewer sees them in their own language through these helpers.
// Terms the server/dialogs put in breakdowns (French keys, translated when shown).
export const ROLL_TERMS = [tk('spé.'), tk('mod.'), tk('blessures'), tk('par défaut'), tk('bonus'), tk('recul'), tk('armure'), tk('accessoires'),
  // first term of roll.limitBreakdown (« sociale 9 + Zoé : Heritage 12 +2 »): the server's French limit adjectives
  tk('physique'), tk('mentale'), tk('sociale'), tk('astrale')];

function rollTermText(part) {
  const p = String(part).trim();
  let m = p.match(/^(\d+) dés?$/);
  if (m) return tn(Number(m[1]), '{n} dé', '{n} dés');
  m = p.match(/^(.*\S)\s+([+−-]?\d+(?:[.,]\d+)?)$/);
  if (m) return `${tIfKnown(m[1])} ${m[2]}`;
  return tIfKnown(p);
}

/** Roll label (stored French text, or typed by a user) in the UI language. Accepts a roll or a label. */
export function rollLabel(rollOrLabel) {
  if (rollOrLabel && typeof rollOrLabel === 'object' && rollOrLabel.labelI18n?.key) return t(rollOrLabel.labelI18n.key, rollOrLabel.labelI18n.params);
  const label = typeof rollOrLabel === 'string' ? rollOrLabel : rollOrLabel?.label || '';
  if (!label) return '';
  if (label === 'Jet de dés') return t('Jet de dés');
  let m = label.match(/^(\d+) dés?$/);
  if (m) return tn(Number(m[1]), '{n} dé', '{n} dés');
  m = label.match(/^Jet de (\d+) dés$/);
  if (m) return t('Jet de {n} dés', { n: Number(m[1]) });
  m = label.match(/^Attaque — (.+)$/);
  if (m) return t('Attaque — {weapon}', { weapon: m[1] });
  m = label.match(/^Sort — (.+)$/);
  if (m) return t('Sort — {spell}', { spell: m[1] });
  m = label.match(/^Résistance au drain \(VOL \+ ([A-ZÉ]+)\)$/);
  if (m) return t('Résistance au drain ({wil} + {attr})', { wil: attrShort('WIL'), attr: attrShort(m[1]) });
  if (/ \+ /.test(label)) return label.split(' + ').map((x) => tIfKnown(x)).join(' + ');
  return tIfKnown(label);
}

/** Pool breakdown ('Pistolets 4 + AGI 5 + spé. +2') in the UI language. */
export function rollBreakdown(text) {
  if (!text) return '';
  if (getLang() === 'fr') return text;
  return String(text).split(' + ').map(rollTermText).join(' + ');
}

/** Dice faces of a roll: 5-6 green, 1 red, exploded dice marked, second-chance rerolls marked. */
export function DiceFaces({ roll, small }) {
  if (!roll || !Array.isArray(roll.dice)) return null;
  const before = roll.secondChance?.before;
  return html`<div class=${'sh-dice' + (small ? ' sh-dice-sm' : '')}>
    ${roll.dice.map((d, i) => {
      const rerolled = before && before[i] < 5;
      return html`<span class=${'sh-die' + (d >= 5 ? ' hit' : d === 1 ? ' one' : '') + (rerolled ? ' rerolled' : '')} title=${rerolled ? t('Relancé (était {n})', { n: before[i] }) : ''}>${d}</span>`;
    })}
    ${(roll.extra || []).map((d) => html`<span class=${'sh-die extra' + (d >= 5 ? ' hit' : d === 1 ? ' one' : '')} title=${t('Dé explosé (règle des 6)')}>${d}</span>`)}
  </div>`;
}

// roll.limitLabel is stored by the server as a French adjective ('physique'…) — older entries may hold any text.
const LIMIT_TITLES = {
  physique: tk('Limite physique'), mentale: tk('Limite mentale'), sociale: tk('Limite sociale'), astrale: tk('Limite astrale'), précision: tk('Précision'),
  Attaque: tk('Attaque'), Corruption: tk('Corruption'), Traitement: tk('Traitement'), Firewall: tk('Firewall'),
};
const limitTitle = (l) => (LIMIT_TITLES[l] ? t(LIMIT_TITLES[l]) : t('Limite {kind}', { kind: l }));

/** Badges summarizing a roll (glitch, limit, Edge…). */
export function RollBadges({ roll }) {
  if (!roll) return null;
  return html`<span class="sh-roll-badges">
    ${roll.critGlitch ? html`<span class="badge badge-red sh-glitch">${t('Échec critique !')}</span>` : roll.glitch ? html`<span class="badge badge-amber">${t('Complication')}</span>` : null}
    ${roll.limit ? html`<span class=${'badge ' + (roll.limited ? 'badge-amber' : '')} title=${(roll.limitLabel ? limitTitle(roll.limitLabel) : t('Limite')) + (roll.limitBreakdown ? `
${rollBreakdown(roll.limitBreakdown)}` : '')}>${t('lim. {n}', { n: roll.limit })}${roll.limited ? ` (${roll.rawHits} → ${roll.limit})` : ''}</span>` : null}
    ${roll.explode ? html`<span class="badge badge-magenta" title=${t('Repousser les limites : +Chance, règle des 6, sans limite')}>${t('Chance')}</span>` : null}
    ${roll.secondChance ? html`<span class="badge badge-magenta" title=${t('Seconde chance : échecs relancés')}>${t('2ᵉ chance')}</span>` : null}
    ${roll.secret ? html`<span class="badge badge-dim">${t('secret')}</span>` : null}
  </span>`;
}

/**
 * Condition monitor as a box track. Click a box to set damage to that box (click the last filled box to clear it).
 * Boxes are grouped by 3 with the wound modifier shown at each group end.
 */
export function ConditionTrack({ label, max, value, onSet, kind = 'physical', readOnly, wounds = true }) {
  const boxes = [];
  for (let i = 0; i < max; i++) {
    const filled = i < value;
    const mark = wounds && (i + 1) % 3 === 0 ? `−${(i + 1) / 3}` : '';
    boxes.push(html`<button type="button" class=${'sh-box' + (filled ? ' filled' : '')} disabled=${readOnly}
      title=${readOnly ? '' : filled && i + 1 === value ? t('Retirer cette case') : t('Mettre à {n}', { n: i + 1 })}
      onClick=${() => onSet?.(filled && i + 1 === value ? i : i + 1)}>${mark ? html`<span class="sh-box-mark">${mark}</span>` : null}</button>`);
  }
  return html`<div class=${'sh-track sh-track-' + kind}>
    <div class="sh-track-head"><span>${label}</span><span class="mono">${value}/${max}</span></div>
    <div class="sh-boxes">${boxes}</div>
  </div>`;
}

/** Compact bar for lists (characters page, log). */
export function MiniBar({ value, max, kind = 'physical', label }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return html`<div class=${'sh-minibar sh-minibar-' + kind} title=${`${label || ''} ${value}/${max}`}>
    <div class="sh-minibar-fill" style=${{ width: pct + '%' }}></div>
    <span class="sh-minibar-text">${label ? label + ' ' : ''}${max - value}/${max}</span>
  </div>`;
}

/** Edge pips. Click a pip to set the current Edge (owner/GM). */
export function EdgePips({ actor, canUse, size = 'md' }) {
  const max = attr(actor, 'EDG');
  const cur = actor.edge?.current ?? max;
  const set = (v) => send('actor/update', { actorId: actor.id, patch: { edge: { current: Math.max(0, Math.min(max, v)) } } }).catch(() => {});
  return html`<span class=${'sh-pips sh-pips-' + size} title=${t('Chance {cur}/{max}', { cur, max })}>
    ${Array.from({ length: max }, (_, i) => html`<button type="button" class=${'sh-pip' + (i < cur ? ' on' : '')} disabled=${!canUse}
      onClick=${() => set(i + 1 === cur ? i : i + 1)} aria-label=${t('Chance {n}', { n: i + 1 })}></button>`)}
  </span>`;
}

// ---------------------------------------------------------------------------
// Item names, categories, fire modes and damage in the UI language
// ---------------------------------------------------------------------------
/**
 * Name of an actor item in the UI language: the catalog's French / English name (nameFr / nameEn, filled by the characters
 * module from the catalog when the stored name is the catalog one), else the stored name (typed / renamed: never changed).
 */
export function itemLabel(item) {
  if (!item) return '';
  return (getLang() === 'fr' ? item.nameFr : item.nameEn) || item.name || item.nameFr || item.nameEn || '';
}
/** Tooltip of an item name: the stored / other-language name and Foundry's original name (kept in the notes) when they differ. */
export function itemTitle(item) {
  if (!item) return '';
  const shown = itemLabel(item);
  const other = getLang() === 'fr' ? item.nameEn : item.nameFr;
  return [...new Set([item.name, other].filter((n) => n && n !== shown))].join(' · ');
}
// Categories the app itself stores (French, translated in English with these keys).
const OWN_CATEGORIES = [tk('Corps à corps'), tk('Arme de jet'), tk('Arme à distance'), tk('Munitions'), tk('Équipement'), tk('Vêtements'), tk('Commlink'), tk('Cyberdeck')];
/** Category of an item in the UI language (catalog categoryFr / categoryEn, the app's own French categories, else as stored). */
export function categoryLabel(item) {
  if (!item) return '';
  const c = getLang() === 'fr' ? item.categoryFr : item.categoryEn;
  if (c) return c;
  return OWN_CATEGORIES.includes(item.category) ? t(item.category) : tIfKnown(String(item.category || ''));
}
const MODE_CODES = { SS: 'SS', CC: 'SS', SA: 'SA', BF: 'BF', TR: 'BF', FA: 'FA', TA: 'FA', RA: 'FA' };
const MODE_FR = { SS: 'CC', SA: 'SA', BF: 'TR', FA: 'TA' };
/** Fire modes « SA/BF/FA » (Chummer) or « SA/TR/TA » (Foundry) in the UI language: French CC/SA/TR/TA, English SS/SA/BF/FA. */
export function modeLabel(mode) {
  const s = String(mode ?? '').trim();
  if (!s || s === '0') return '—';
  return s.split('/').map((p) => {
    const code = MODE_CODES[p.trim().toUpperCase()];
    return code ? (getLang() === 'fr' ? MODE_FR[code] : code) : p.trim();
  }).join('/');
}
/** Damage code in the UI language: French uses « E » (étourdissant) for Stun, « P » stays (physique / Physical). « Special » → « Spécial ». */
export function damageLabel(text) {
  let s = String(text ?? '').trim();
  if (!s) return '—';
  if (/^(sp[ée]cial)$/i.test(s)) return t('Spécial');
  if (getLang() === 'fr') s = s.replace(/(\d|\))S(?![a-z])/g, '$1E');
  else s = s.replace(/(\d|\))E(?![a-z])/g, '$1S');
  return s;
}

/** Accuracy text ("5", "Physique", "Physique−1") → number limit. */
export function accuracyLimit(actor, accuracy) {
  const s = String(accuracy ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (/phys/i.test(s)) {
    const base = actor ? derive(actor).limits.physical : 0;
    const m = s.match(/([+\-−])\s*(\d+)/);
    return m ? base + (m[1] === '+' ? 1 : -1) * Number(m[2]) : base;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
