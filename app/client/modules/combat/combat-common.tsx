// Shared helpers for the combat dock and the bestiary (pure functions + tiny components).
import type { CSSProperties } from 'react';
import { t, tk } from '../../lib/i18n.ts';
import { derive, attr, skillPool, SKILL_BY_ID } from '/shared/sr5.ts';
import type { CombatEntry, Disposition, InitMode, NpcKind, Weapon } from '../../../shared/types.ts';
import type { ActorLike } from './types.ts';

// Constant tables hold French keys (tk); render them with the helpers below (or t(label)).
export const DISPO_LABELS: Record<Disposition, string> = { pc: tk('Runner'), ally: tk('Ally'), neutral: tk('Neutral'), hostile: tk('Hostile') };
export const DISPO_BADGE: Record<Disposition, string> = { pc: 'cyan', ally: 'green', neutral: 'amber', hostile: 'red' };
export const INIT_MODES: Array<{ value: InitMode; label: string }> = [
  { value: 'physical', label: tk('Physical') },
  { value: 'astral', label: tk('Astral') },
  { value: 'ar', label: tk('Matrix (AR)') },
  { value: 'cold', label: tk('Cold-sim VR') },
  { value: 'hot', label: tk('Hot-sim VR') },
];
export const INIT_MODE_LABEL: Record<string, string> = Object.fromEntries(INIT_MODES.map((m) => [m.value, m.label]));
export const NPC_KINDS: Array<{ value: NpcKind; label: string }> = [
  { value: 'metahuman', label: tk('Metahuman') },
  { value: 'critter', label: tk('Critter') },
  { value: 'spirit', label: tk('Spirit') },
  { value: 'drone', label: tk('Drone / vehicle') },
  { value: 'ic', label: tk('IC') },
  { value: 'host', label: tk('Host (reference)') },
  { value: 'other', label: tk('Other') },
];
export const NPC_KIND_LABEL: Record<string, string> = Object.fromEntries(NPC_KINDS.map((k) => [k.value, k.label]));

/** Translated labels / <Select> options (call at render time). */
export const dispoLabel = (d: string | null | undefined): string => (d && DISPO_LABELS[d as Disposition] ? t(DISPO_LABELS[d as Disposition]) : String(d ?? ''));
export const initModeLabel = (m: string | null | undefined): string => (m && INIT_MODE_LABEL[m] ? t(INIT_MODE_LABEL[m]) : String(m ?? ''));
export const npcKindLabel = (k: string | null | undefined): string => (k && NPC_KIND_LABEL[k] ? t(NPC_KIND_LABEL[k]) : String(k ?? ''));
export const initModeOptions = () => INIT_MODES.map((m) => ({ value: m.value, label: t(m.label) as string }));
export const npcKindOptions = () => NPC_KINDS.map((k) => ({ value: k.value, label: t(k.label) as string }));

export function initials(name: string | null | undefined): string {
  const words = String(name || '?').replace(/[«»"'’()—-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const nums = words.filter((w) => /^\d+$/.test(w));
  const letters = words.filter((w) => !/^\d+$/.test(w));
  const base = (letters[0]?.[0] || '') + (letters.length > 1 && !nums.length ? letters[1][0] : '');
  return (base + (nums[0] || '')).toUpperCase().slice(0, 3);
}

/** Avatar circle style: portrait image or color. */
export function avatarStyle(portrait: string | null | undefined, color: string | null | undefined): CSSProperties {
  const st: CSSProperties = {};
  if (portrait) {
    st.backgroundImage = `url("${String(portrait).replace(/"/g, '%22')}")`;
    if (color) st.borderColor = color;
  } else if (color) st.background = color;
  return st;
}

/** Result of sr5.derive(). */
export type Derived = ReturnType<typeof derive>;

/** Safe derive (actors filtered for players may miss most fields). */
export function safeDerive(actor: ActorLike | null | undefined): Derived | null {
  try {
    return actor && 'attributes' in actor && actor.attributes ? derive(actor) : null;
  } catch {
    return null;
  }
}

/** Pool for a skill id, also handling custom skills stored on the actor. */
export function poolFor(actor: ActorLike | null | undefined, skillId: string | null | undefined): number | null {
  if (!skillId) return null;
  const own = (actor?.skills || []).find((s) => s.id === skillId);
  if (!SKILL_BY_ID[skillId]) {
    if (!own) return null;
    return (Number(own.rating) || 0) + attr(actor, own.attr || 'AGI');
  }
  const p = skillPool(actor, skillId);
  return p.impossible ? 0 : p.pool;
}

/** Weapon damage with (STR+n) resolved: '(STR+3)P' -> '7P'. */
export function damageText(weapon: Partial<Weapon> | null | undefined, actor: ActorLike | null | undefined): string {
  const raw = String(weapon?.damage ?? '');
  return raw.replace(/\(?\s*(?:STR|FOR)\s*([+-]\s*\d+)?\s*\)?/i, (_m, mod) => String(attr(actor, 'STR') + Number(String(mod || '0').replace(/\s/g, ''))));
}

export function signed(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0';
}

/** Tooltip describing an initiative roll. */
export function rollTooltip(e: CombatEntry, pass: number): string {
  if (e.toRoll) return t('Initiative not rolled yet');
  if (e.rolls === undefined) return t('Current score: {n}', { n: e.score });
  const parts: string[] = [];
  if (e.rolls.length) parts.push(`${e.base} + [${e.rolls.join(' · ')}]`);
  else parts.push(t('Score set by the GM: {n}', { n: e.base }));
  if (e.wound) parts.push(t('{n} wounds', { n: signed(e.wound) }));
  if (e.adjust) parts.push(t('{n} actions', { n: signed(e.adjust) }));
  if (pass > 1) parts.push(t('−{n} passes', { n: 10 * (pass - 1) }));
  if (e.mode && e.mode !== 'physical') parts.push(initModeLabel(e.mode));
  if (e.blitz) parts.push(t('Blitz (5D6)'));
  if (e.seized) parts.push(t('Initiative seized'));
  return `${parts.join('  ')}  =  ${e.score}`;
}

interface MonitorBarProps {
  label: string;
  value: number | null | undefined;
  max: number | null | undefined;
  kind: 'p' | 's';
}
/** Condition boxes: <Monitor label="P" value=3 max=10 kind="p" /> */
export function MonitorBar({ label, value, max, kind }: MonitorBarProps) {
  if (!max) return null;
  const v = Math.max(0, Math.min(max, Number(value) || 0));
  const boxes = [];
  for (let i = 0; i < max; i++) boxes.push(<span key={i} className={'cbt-box ' + kind + (i < v ? ' on' : '')}></span>);
  return (
    <div className="cbt-bar" title={kind === 'p' ? t('Physical: {v}/{max}', { v, max }) : t('Stun: {v}/{max}', { v, max })}>
      <span>{label}</span>
      <span className="cbt-boxes">{boxes}</span>
      <span className="right">
        {v}/{max}
      </span>
    </div>
  );
}

/** Parses "5P", "3s", "-2P", "4" (physical) → { amount, type } (amount negative = heal). */
export function parseDamageInput(text: string | null | undefined): { amount: number; type: 'P' | 'S' } | null {
  const m = String(text || '').trim().match(/^([+-]?\s*\d+)\s*([PpSsEe])?$/);
  if (!m) return null;
  const amount = Number(m[1].replace(/\s/g, ''));
  if (!amount) return null;
  const kind = (m[2] || 'P').toUpperCase();
  return { amount, type: kind === 'P' ? 'P' : 'S' };
}

/** Download a JSON file in the browser. */
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
