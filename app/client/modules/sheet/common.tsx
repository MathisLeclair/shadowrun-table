// Shared bits of the sheet module: permissions, overlay dialog, dice faces, condition tracks, Edge pips.
import { Fragment, useEffect, type CSSProperties, type ReactNode } from 'react';
import { IconButton } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { derive, attr, SKILL_BY_ID } from '/shared/sr5.ts';
import { healthStatus, STATUS_COLORS, STATUS_LABELS } from './sheet-data.ts';
import { t, tn, tk, tIfKnown, getLang, skillLabel, attrShort, fmtDate as fmtLocaleDate } from '../../lib/i18n.ts';
import type { Actor, GameView, Skill, ViewActor, ViewUser } from '../../../shared/types.ts';
import type { ShownRoll } from './types.ts';

export const isGM = (game: GameView | null | undefined): boolean => game?.me?.role === 'gm';
/** GM, or the player controls this actor. */
export const ownsActor = (game: GameView | null | undefined, actorId: string): boolean => isGM(game) || (game?.me?.characterIds || []).includes(actorId);
/** Players receive a reduced NPC object (no attributes) for enemies. */
export const isRestricted = (actor: ViewActor | null | undefined): boolean => !actor || !('attributes' in actor) || !actor.attributes;

export function ownerOf(game: GameView | null | undefined, actorId: string): ViewUser | null {
  return Object.values(game?.users || {}).find((u) => (u.characterIds || []).includes(actorId)) || null;
}

/** Health status of an actor: a stored French value ('indemne'…, save compatibility), shown with statusLabel(). */
export function actorStatus(actor: ViewActor | null | undefined): string {
  if (!actor) return 'indemne';
  if ('status' in actor && actor.status) return actor.status;
  const d = derive(actor);
  return healthStatus((actor as Actor).condition, d.physicalMonitor, d.stunMonitor, d.overflowMax);
}
export const statusColor = (s: string): string => (STATUS_COLORS as Record<string, string>)[s] || 'dim';
/** Stored French health status ('blessé'…) → label in the UI language. */
export const statusLabel = (s: string | null | undefined): string => {
  const key = (STATUS_LABELS as Record<string, string>)[s ?? ''];
  return key ? t(key) : tIfKnown(String(s ?? ''));
};

/**
 * Translated sentence with markup inside: tRich(t('Before: {push}.'), { push: <b>…</b> }) → array of
 * text/nodes. Pass the already translated text (t() without params keeps the {name} markers).
 */
export function tRich(text: string, nodes?: Record<string, ReactNode>): ReactNode[] {
  return String(text)
    .split(/\{(\w+)\}/)
    .map((part, i) => (i % 2 ? (nodes && part in nodes ? <Fragment key={i}>{nodes[part]}</Fragment> : `{${part}}`) : part));
}

export function initials(name = ''): string {
  return String(name)
    .replace(/[’']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return (fmtLocaleDate as (d: Date, opts: Intl.DateTimeFormatOptions) => string)(d, { day: '2-digit', month: '2-digit', year: '2-digit' });
}
/** Name of an actor skill: the stored name in French (as before), the official SR5 English name in English. */
export function skillName(sk: Partial<Skill> | null | undefined, id?: string): string {
  if (getLang() === 'fr') return sk?.name || (SKILL_BY_ID as Record<string, { fr?: string }>)[id ?? sk?.id ?? '']?.fr || id || sk?.id || '';
  return skillLabel(sk && (sk.id || sk.name) ? sk : id);
}

/** Inline style with CSS custom properties ({ '--pc': color }), which CSSProperties does not list. */
export const cssVars = (style: Record<string, string | number | undefined>): CSSProperties => style as CSSProperties;

export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
export const fmtNum = (n: number | string | null | undefined): string => (getLang() === 'en' ? String(n) : String(n).replace('.', ','));

/** What the avatar needs of an actor (contacts pass a stand-in { name, portrait, color }). */
export interface AvatarActor {
  name?: string;
  portrait?: string;
  color?: string;
}
interface AvatarProps {
  actor: AvatarActor | null | undefined;
  size?: number;
  className?: string;
}
/** Avatar: portrait image or initials on the actor color. */
export function Avatar({ actor, size = 40, className = '' }: AvatarProps) {
  const color = actor?.color || '#3fd6d0';
  const style = cssVars({ width: `${size}px`, height: `${size}px`, '--av': color, fontSize: `${Math.round(size * 0.38)}px` });
  return actor?.portrait
    ? <img className={'sh-avatar ' + className} style={style} src={actor.portrait} alt="" loading="lazy" />
    : <span className={'sh-avatar sh-avatar-init ' + className} style={style}>{initials(actor?.name)}</span>;
}

interface OverlayProps {
  title?: ReactNode;
  onClose?: () => void;
  width?: number;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}
/**
 * Dialog usable inside the sheet modal: Escape closes only this dialog (capture listener stops the event
 * before the global Modal sees it). Same look as the core Modal.
 */
export function Overlay({ title, onClose, width = 560, children, actions, className = '' }: OverlayProps) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return <div className="modal-backdrop sh-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
    <div className={'modal ' + className} style={{ width: `min(${width}px, calc(100vw - 24px))` }} role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
      <header className="modal-head">
        <h2>{title}</h2>
        <div className="row gap-s">{actions}<IconButton icon="✕" title={t('Close')} onClick={onClose} /></div>
      </header>
      <div className="modal-body">{children}</div>
    </div>
  </div>;
}

// Roll labels and breakdowns are stored as text ('Defense', 'Agility + Logic', older French entries 'Défense', '6 dés',
// 'Pistolets 4 + AGI 5 + spé. +2'): every viewer sees them in their own language through these helpers.
// Terms the server/dialogs put in breakdowns (UI keys, translated when shown).
export const ROLL_TERMS = [tk('spec.'), tk('mod.'), tk('wounds'), tk('defaulting'), tk('bonus'), tk('recoil'), tk('armor'), tk('accessories'),
  // first term of roll.limitBreakdown (« sociale 9 + Zoé : Heritage 12 +2 »): the server's limit adjectives
  tk('physical'), tk('mental'), tk('fem::social'), tk('astral')];

function rollTermText(part: string): string {
  const p = String(part).trim();
  let m = p.match(/^(\d+) dés?$/);
  if (m) return tn(Number(m[1]), '{n} die', '{n} dice');
  m = p.match(/^(.*\S)\s+([+−-]?\d+(?:[.,]\d+)?)$/);
  if (m) return `${tIfKnown(m[1])} ${m[2]}`;
  return tIfKnown(p);
}

/** Roll label (stored text — UI key, older French text — or typed by a user) in the UI language. Accepts a roll or a label. */
export function rollLabel(rollOrLabel: ShownRoll | string | null | undefined): string {
  if (rollOrLabel && typeof rollOrLabel === 'object' && rollOrLabel.labelI18n?.key) return t(rollOrLabel.labelI18n.key, rollOrLabel.labelI18n.params);
  const label: string = typeof rollOrLabel === 'string' ? rollOrLabel : rollOrLabel?.label || '';
  if (!label) return '';
  if (label === 'Jet de dés') return t('Dice roll'); // older stored label
  let m = label.match(/^(\d+) dés?$/);
  if (m) return tn(Number(m[1]), '{n} die', '{n} dice');
  m = label.match(/^Jet de (\d+) dés$/);
  if (m) return t('Roll of {n} dice', { n: Number(m[1]) });
  m = label.match(/^Attaque — (.+)$/);
  if (m) return t('Attack — {weapon}', { weapon: m[1] });
  m = label.match(/^Sort — (.+)$/);
  if (m) return t('Spell — {spell}', { spell: m[1] });
  m = label.match(/^Résistance au drain \(VOL \+ ([A-ZÉ]+)\)$/);
  if (m) return t('Drain Resistance ({wil} + {attr})', { wil: attrShort('WIL'), attr: attrShort(m[1]) });
  if (/ \+ /.test(label)) return label.split(' + ').map((x) => tIfKnown(x)).join(' + ');
  return tIfKnown(label);
}

/** Pool breakdown ('Pistolets 4 + AGI 5 + spé. +2') in the UI language (terms stored in either language). */
export function rollBreakdown(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).split(' + ').map(rollTermText).join(' + ');
}

/** Dice faces of a roll: 5-6 green, 1 red, exploded dice marked, second-chance rerolls marked. */
export function DiceFaces({ roll, small }: { roll: ShownRoll | null | undefined; small?: boolean }) {
  if (!roll || !Array.isArray(roll.dice)) return null;
  const before = roll.secondChance?.before;
  return <div className={'sh-dice' + (small ? ' sh-dice-sm' : '')}>
    {roll.dice.map((d, i) => {
      const rerolled = !!before && before[i] < 5;
      return <span key={i} className={'sh-die' + (d >= 5 ? ' hit' : d === 1 ? ' one' : '') + (rerolled ? ' rerolled' : '')} title={rerolled ? t('Rerolled (was {n})', { n: before[i] }) : ''}>
        {d}
      </span>;
    })}
    {(roll.extra || []).map((d, i) => <span key={'x' + i} className={'sh-die extra' + (d >= 5 ? ' hit' : d === 1 ? ' one' : '')} title={t('Exploded die (rule of six)')}>{d}</span>)}
  </div>;
}

// roll.limitLabel is stored by the server as an adjective (French 'physique'… in older entries) — or any text.
const LIMIT_TITLES: Record<string, string> = {
  physique: tk('Physical Limit'), mentale: tk('Mental Limit'), sociale: tk('Social Limit'), astrale: tk('Astral Limit'), précision: tk('Accuracy'),
  physical: tk('Physical Limit'), mental: tk('Mental Limit'), social: tk('Social Limit'), astral: tk('Astral Limit'), accuracy: tk('Accuracy'),
  Attaque: tk('Attack'), Corruption: tk('Sleaze'), Traitement: tk('Data Processing'), Firewall: tk('Firewall'),
};
const limitTitle = (l: string): string => (LIMIT_TITLES[l] ? t(LIMIT_TITLES[l]) : t('{kind} limit', { kind: l }));

/** Badges summarizing a roll (glitch, limit, Edge…). */
export function RollBadges({ roll }: { roll: ShownRoll | null | undefined }) {
  if (!roll) return null;
  return <span className="sh-roll-badges">
    {roll.critGlitch ? <span className="badge badge-red sh-glitch">{t('Critical glitch!')}</span> : roll.glitch ? <span className="badge badge-amber">{t('Glitch')}</span> : null}
    {roll.limit ? <span className={'badge ' + (roll.limited ? 'badge-amber' : '')} title={(roll.limitLabel ? limitTitle(roll.limitLabel) : t('Limit')) + (roll.limitBreakdown ? `
${rollBreakdown(roll.limitBreakdown)}` : '')}>
      {t('lim. {n}', { n: roll.limit })}{roll.limited ? ` (${roll.rawHits} → ${roll.limit})` : ''}
    </span> : null}
    {roll.explode ? <span className="badge badge-magenta" title={t('Push the Limit: +Edge, rule of six, no limit')}>{t('Edge')}</span> : null}{roll.secondChance ? <span className="badge badge-magenta" title={t('Second Chance: misses rerolled')}>{t('2nd Chance')}</span> : null}{roll.secret ? <span className="badge badge-dim">{t('secret')}</span> : null}
  </span>;
}

/**
 * Condition monitor as a box track. Click a box to set damage to that box (click the last filled box to clear it).
 * Boxes are grouped by 3 with the wound modifier shown at each group end.
 */
interface ConditionTrackProps {
  label: ReactNode;
  max: number;
  value: number;
  onSet?: (value: number) => void;
  kind?: string;
  readOnly?: boolean;
  wounds?: boolean;
}
export function ConditionTrack({ label, max, value, onSet, kind = 'physical', readOnly, wounds = true }: ConditionTrackProps) {
  const boxes: ReactNode[] = [];
  for (let i = 0; i < max; i++) {
    const filled = i < value;
    const mark = wounds && (i + 1) % 3 === 0 ? `−${(i + 1) / 3}` : '';
    boxes.push(<button key={i} type="button" className={'sh-box' + (filled ? ' filled' : '')} disabled={readOnly} title={readOnly ? '' : filled && i + 1 === value ? t('Clear this box') : t('Set to {n}', { n: i + 1 })} onClick={() => onSet?.(filled && i + 1 === value ? i : i + 1)}>
      {mark ? <span className="sh-box-mark">{mark}</span> : null}
    </button>);
  }
  return <div className={'sh-track sh-track-' + kind}>
    <div className="sh-track-head"><span>{label}</span><span className="mono">{value}/{max}</span></div>
    <div className="sh-boxes">{boxes}</div>
  </div>;
}

/** Compact bar for lists (characters page, log). */
export function MiniBar({ value, max, kind = 'physical', label }: { value: number; max: number; kind?: string; label?: string }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className={'sh-minibar sh-minibar-' + kind} title={`${label || ''} ${value}/${max}`}>
    <div className="sh-minibar-fill" style={{ width: pct + '%' }} />
    <span className="sh-minibar-text">{label ? label + ' ' : ''}{max - value}/{max}</span>
  </div>;
}

/** Edge pips. Click a pip to set the current Edge (owner/GM). */
export function EdgePips({ actor, canUse, size = 'md' }: { actor: Actor; canUse: boolean; size?: string }) {
  const max: number = attr(actor, 'EDG');
  const cur = actor.edge?.current ?? max;
  const set = (v: number) => send('actor/update', { actorId: actor.id, patch: { edge: { current: Math.max(0, Math.min(max, v)) } } }).catch(() => {});
  return <span className={'sh-pips sh-pips-' + size} title={t('Edge {cur}/{max}', { cur, max })}>
    {Array.from({ length: max }, (_, i) => <button key={i} type="button" className={'sh-pip' + (i < cur ? ' on' : '')} disabled={!canUse} onClick={() => set(i + 1 === cur ? i : i + 1)} aria-label={t('Edge {n}', { n: i + 1 })} />)}
  </span>;
}

// ---------------------------------------------------------------------------
// Item names, categories, fire modes and damage in the UI language
// ---------------------------------------------------------------------------
/**
 * Name of an actor item in the UI language: the catalog's French / English name (nameFr / nameEn, filled by the characters
 * module from the catalog when the stored name is the catalog one), else the stored name (typed / renamed: never changed).
 */
/** Fields of an item the name / category helpers read. */
export interface NamedItem {
  name?: string;
  nameFr?: string;
  nameEn?: string;
  category?: string;
  categoryFr?: string;
  categoryEn?: string;
}
export function itemLabel(item: NamedItem | null | undefined): string {
  if (!item) return '';
  return (getLang() === 'fr' ? item.nameFr : item.nameEn) || item.name || item.nameFr || item.nameEn || '';
}
/** Tooltip of an item name: the stored / other-language name and Foundry's original name (kept in the notes) when they differ. */
export function itemTitle(item: NamedItem | null | undefined): string {
  if (!item) return '';
  const shown = itemLabel(item);
  const other = getLang() === 'fr' ? item.nameEn : item.nameFr;
  return [...new Set([item.name, other].filter((n) => n && n !== shown))].join(' · ');
}
// Categories the app itself stores (French, translated in English with these keys).
const OWN_CATEGORIES: string[] = [tk('Melee'), tk('Throwing weapon'), tk('Ranged weapon'), tk('Ammo'), tk('Gear'), tk('Clothing'), tk('Commlink'), tk('Cyberdeck')];
/** Category of an item in the UI language (catalog categoryFr / categoryEn, the app's own French categories, else as stored). */
export function categoryLabel(item: NamedItem | null | undefined): string {
  if (!item) return '';
  const c = getLang() === 'fr' ? item.categoryFr : item.categoryEn;
  if (c) return c;
  return item.category && OWN_CATEGORIES.includes(item.category) ? t(item.category) : tIfKnown(String(item.category || ''));
}
const MODE_CODES: Record<string, string> = { SS: 'SS', CC: 'SS', SA: 'SA', BF: 'BF', TR: 'BF', FA: 'FA', TA: 'FA', RA: 'FA' };
const MODE_FR: Record<string, string> = { SS: 'CC', SA: 'SA', BF: 'TR', FA: 'TA' };
/** Fire modes « SA/BF/FA » (Chummer) or « SA/TR/TA » (Foundry) in the UI language: French CC/SA/TR/TA, English SS/SA/BF/FA. */
export function modeLabel(mode: string | null | undefined): string {
  const s = String(mode ?? '').trim();
  if (!s || s === '0') return '—';
  return s.split('/').map((p) => {
    const code = MODE_CODES[p.trim().toUpperCase()];
    return code ? (getLang() === 'fr' ? MODE_FR[code] : code) : p.trim();
  }).join('/');
}
/** Damage code in the UI language: French uses « E » (étourdissant) for Stun, « P » stays (physique / Physical). « Special » → « Spécial ». */
export function damageLabel(text: string | null | undefined): string {
  let s = String(text ?? '').trim();
  if (!s) return '—';
  if (/^(sp[ée]cial)$/i.test(s)) return t('Special');
  if (getLang() === 'fr') s = s.replace(/(\d|\))S(?![a-z])/g, '$1E');
  else s = s.replace(/(\d|\))E(?![a-z])/g, '$1S');
  return s;
}

/** Accuracy text ("5", "Physique", "Physique−1") → number limit. */
export function accuracyLimit(actor: Actor | null | undefined, accuracy: number | string | null | undefined): number | null {
  const s = String(accuracy ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (/phys/i.test(s)) {
    const base: number = actor ? derive(actor).limits.physical : 0;
    const m = s.match(/([+\-−])\s*(\d+)/);
    return m ? base + (m[1] === '+' ? 1 : -1) * Number(m[2]) : base;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
