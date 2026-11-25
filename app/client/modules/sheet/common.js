// Shared bits of the sheet module: permissions, overlay dialog, dice faces, condition tracks, Edge pips.
import { useEffect } from 'preact/hooks';
import { html, IconButton } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { derive, attr } from '/shared/sr5.js';
import { healthStatus, STATUS_COLORS } from './sheet-data.js';

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
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
export const fmtNum = (n) => String(n).replace('.', ',');

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
        <div class="row gap-s">${actions}<${IconButton} icon="✕" title="Fermer" onClick=${onClose} /></div>
      </header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

/** Dice faces of a roll: 5-6 green, 1 red, exploded dice marked, second-chance rerolls marked. */
export function DiceFaces({ roll, small }) {
  if (!roll || !Array.isArray(roll.dice)) return null;
  const before = roll.secondChance?.before;
  return html`<div class=${'sh-dice' + (small ? ' sh-dice-sm' : '')}>
    ${roll.dice.map((d, i) => {
      const rerolled = before && before[i] < 5;
      return html`<span class=${'sh-die' + (d >= 5 ? ' hit' : d === 1 ? ' one' : '') + (rerolled ? ' rerolled' : '')} title=${rerolled ? `Relancé (était ${before[i]})` : ''}>${d}</span>`;
    })}
    ${(roll.extra || []).map((d) => html`<span class=${'sh-die extra' + (d >= 5 ? ' hit' : d === 1 ? ' one' : '')} title="Dé explosé (règle des 6)">${d}</span>`)}
  </div>`;
}

/** Badges summarizing a roll (glitch, limit, Edge…). */
export function RollBadges({ roll }) {
  if (!roll) return null;
  return html`<span class="sh-roll-badges">
    ${roll.critGlitch ? html`<span class="badge badge-red sh-glitch">Échec critique !</span>` : roll.glitch ? html`<span class="badge badge-amber">Complication</span>` : null}
    ${roll.limit ? html`<span class=${'badge ' + (roll.limited ? 'badge-amber' : '')} title=${roll.limitLabel ? `Limite ${roll.limitLabel}` : 'Limite'}>lim. ${roll.limit}${roll.limited ? ` (${roll.rawHits} → ${roll.limit})` : ''}</span>` : null}
    ${roll.explode ? html`<span class="badge badge-magenta" title="Repousser les limites : +Chance, règle des 6, sans limite">Chance</span>` : null}
    ${roll.secondChance ? html`<span class="badge badge-magenta" title="Seconde chance : échecs relancés">2ᵉ chance</span>` : null}
    ${roll.secret ? html`<span class="badge badge-dim">secret</span>` : null}
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
      title=${readOnly ? '' : filled && i + 1 === value ? 'Retirer cette case' : `Mettre à ${i + 1}`}
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
  return html`<span class=${'sh-pips sh-pips-' + size} title=${`Chance ${cur}/${max}`}>
    ${Array.from({ length: max }, (_, i) => html`<button type="button" class=${'sh-pip' + (i < cur ? ' on' : '')} disabled=${!canUse}
      onClick=${() => set(i + 1 === cur ? i : i + 1)} aria-label=${`Chance ${i + 1}`}></button>`)}
  </span>`;
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
