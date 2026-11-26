// Shared helpers for the combat dock and the bestiary (pure functions + tiny components).
import { html } from '../../lib/ui.js';
import { t, tk } from '../../lib/i18n.js';
import { derive, attr, skillPool, SKILL_BY_ID } from '/shared/sr5.js';

// Constant tables hold French keys (tk); render them with the helpers below (or t(label)).
export const DISPO_LABELS = { pc: tk('Runner'), ally: tk('Allié'), neutral: tk('Neutre'), hostile: tk('Hostile') };
export const DISPO_BADGE = { pc: 'cyan', ally: 'green', neutral: 'amber', hostile: 'red' };
export const INIT_MODES = [
  { value: 'physical', label: tk('Physique') },
  { value: 'astral', label: tk('Astrale') },
  { value: 'ar', label: tk('Matrice (RA)') },
  { value: 'cold', label: tk('VR froide') },
  { value: 'hot', label: tk('VR chaude') },
];
export const INIT_MODE_LABEL = Object.fromEntries(INIT_MODES.map((m) => [m.value, m.label]));
export const NPC_KINDS = [
  { value: 'metahuman', label: tk('Métahumain') },
  { value: 'critter', label: tk('Créature') },
  { value: 'spirit', label: tk('Esprit') },
  { value: 'drone', label: tk('Drone / véhicule') },
  { value: 'ic', label: tk('IC') },
  { value: 'host', label: tk('Host (référence)') },
  { value: 'other', label: tk('Autre') },
];
export const NPC_KIND_LABEL = Object.fromEntries(NPC_KINDS.map((k) => [k.value, k.label]));

/** Translated labels / <Select> options (call at render time). */
export const dispoLabel = (d) => (DISPO_LABELS[d] ? t(DISPO_LABELS[d]) : String(d ?? ''));
export const initModeLabel = (m) => (INIT_MODE_LABEL[m] ? t(INIT_MODE_LABEL[m]) : String(m ?? ''));
export const npcKindLabel = (k) => (NPC_KIND_LABEL[k] ? t(NPC_KIND_LABEL[k]) : String(k ?? ''));
export const initModeOptions = () => INIT_MODES.map((m) => ({ value: m.value, label: t(m.label) }));
export const npcKindOptions = () => NPC_KINDS.map((k) => ({ value: k.value, label: t(k.label) }));

export function initials(name) {
  const words = String(name || '?').replace(/[«»"'’()—-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const nums = words.filter((w) => /^\d+$/.test(w));
  const letters = words.filter((w) => !/^\d+$/.test(w));
  const base = (letters[0]?.[0] || '') + (letters.length > 1 && !nums.length ? letters[1][0] : '');
  return (base + (nums[0] || '')).toUpperCase().slice(0, 3);
}

/** Avatar circle style: portrait image or color. */
export function avatarStyle(portrait, color) {
  const st = {};
  if (portrait) {
    st.backgroundImage = `url("${String(portrait).replace(/"/g, '%22')}")`;
    if (color) st.borderColor = color;
  } else if (color) st.background = color;
  return st;
}

/** Safe derive (actors filtered for players may miss most fields). */
export function safeDerive(actor) {
  try {
    return actor && actor.attributes ? derive(actor) : null;
  } catch {
    return null;
  }
}

/** Pool for a skill id, also handling custom skills stored on the actor. */
export function poolFor(actor, skillId) {
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
export function damageText(weapon, actor) {
  const raw = String(weapon?.damage ?? '');
  return raw.replace(/\(?\s*(?:STR|FOR)\s*([+-]\s*\d+)?\s*\)?/i, (_m, mod) => String(attr(actor, 'STR') + Number(String(mod || '0').replace(/\s/g, ''))));
}

export function signed(n) {
  const v = Number(n) || 0;
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0';
}

/** Tooltip describing an initiative roll. */
export function rollTooltip(e, pass) {
  if (e.toRoll) return t('Initiative pas encore lancée');
  if (e.rolls === undefined) return t('Score actuel : {n}', { n: e.score });
  const parts = [];
  if (e.rolls.length) parts.push(`${e.base} + [${e.rolls.join(' · ')}]`);
  else parts.push(t('Score fixé par le MJ : {n}', { n: e.base }));
  if (e.wound) parts.push(t('{n} blessures', { n: signed(e.wound) }));
  if (e.adjust) parts.push(t('{n} actions', { n: signed(e.adjust) }));
  if (pass > 1) parts.push(t('−{n} passes', { n: 10 * (pass - 1) }));
  if (e.mode && e.mode !== 'physical') parts.push(initModeLabel(e.mode));
  if (e.blitz) parts.push(t('Blitz (5D6)'));
  if (e.seized) parts.push(t('Initiative saisie'));
  return `${parts.join('  ')}  =  ${e.score}`;
}

/** Condition boxes: <Monitor label="P" value=3 max=10 kind="p" /> */
export function MonitorBar({ label, value, max, kind }) {
  if (!max) return null;
  const v = Math.max(0, Math.min(max, Number(value) || 0));
  const boxes = [];
  for (let i = 0; i < max; i++) boxes.push(html`<span class=${'cbt-box ' + kind + (i < v ? ' on' : '')}></span>`);
  return html`<div class="cbt-bar" title=${kind === 'p' ? t('Physique : {v}/{max}', { v, max }) : t('Étourdissant : {v}/{max}', { v, max })}>
    <span>${label}</span><span class="cbt-boxes">${boxes}</span><span class="right">${v}/${max}</span>
  </div>`;
}

/** Parses "5P", "3s", "-2P", "4" (physical) → { amount, type } (amount negative = heal). */
export function parseDamageInput(text) {
  const m = String(text || '').trim().match(/^([+-]?\s*\d+)\s*([PpSsEe])?$/);
  if (!m) return null;
  const amount = Number(m[1].replace(/\s/g, ''));
  if (!amount) return null;
  const kind = (m[2] || 'P').toUpperCase();
  return { amount, type: kind === 'P' ? 'P' : 'S' };
}

/** Download a JSON file in the browser. */
export function downloadJson(filename, data) {
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
