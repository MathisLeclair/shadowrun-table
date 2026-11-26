// Character creation — client helpers: catalog context for shared/chargen.js, draft state, small widgets.
import { useMemo } from 'preact/hooks';
import { html, Badge, NumberInput } from '../../lib/ui.js';
import { useCatalog } from '../../lib/net.js';
import { t, tk, getLang, fmtNumber, fmtNuyen, fmtDate, metatypeLabel } from '../../lib/i18n.js';
import { compute, normalizeDraft, issuesByStep, issueText as sharedIssueText, MAGIC_TYPES } from '/shared/chargen.js';
import * as rules from '../shop/rules.js';
import { useShopCatalog } from '../shop/common.js';

/** 12500 → « 12 500¥ » (fr) / « 12,500¥ » (en). */
export const nuyen = fmtNuyen;

export const STATUS_LABEL = { draft: tk('Brouillon'), pending: tk('En attente du MJ'), approved: tk('Validé'), rejected: tk('À revoir') };
export const STATUS_COLOR = { draft: 'dim', pending: 'amber', approved: 'green', rejected: 'red' };

export function StatusBadge({ status }) {
  return html`<${Badge} color=${STATUS_COLOR[status] || 'dim'}>${STATUS_LABEL[status] ? t(STATUS_LABEL[status]) : status}</${Badge}>`;
}

/** i18n hooks handed to shared/chargen.js display helpers (priorityText, magicOptionText…). */
export const i18n = () => ({ t, fmtNumber, lang: getLang() });

/** A validation issue (shared/chargen.js compute()) in the UI language. */
export const issueText = (i) => sharedIssueText(i, i18n());

/** draftHeadline() rebuilt in the UI language: { name, text }. */
export function headlineText(h) {
  const bits = [metatypeLabel(h.metatype)];
  if (h.magicType && h.magicType !== 'none' && MAGIC_TYPES[h.magicType]) bits.push(t(MAGIC_TYPES[h.magicType].label));
  if (h.concept) bits.push(h.concept);
  return { name: h.unnamed ? t('Sans nom') : h.name, text: h.metatype ? bits.join(' · ') : h.text };
}

/** Name of the user who owns a draft (the GM's stored « MJ » is translated). */
export const ownerName = (game, d, fallback = tk('Joueur')) => (d.userId === 'gm' ? t('MJ') : game.users?.[d.userId]?.name || d.userName || t(fallback));

/**
 * Catalog context for compute()/buildActor(): shop catalog (gear, lifestyles…) + qualities, spells, powers.
 * Returns { ctx, ready, shop, qualities, spells, powers }. While loading, ctx has no lookup (no « introuvable » errors).
 */
export function useRulesCtx(game) {
  const shop = useShopCatalog();
  const qualities = useCatalog('qualities');
  const spells = useCatalog('spells');
  const powers = useCatalog('powers');
  const settings = game?.chargen?.settings;
  return useMemo(() => {
    const ready = !!shop && qualities.length > 0 && spells.length > 0 && powers.length > 0;
    const extra = new Map();
    for (const [file, list] of [['qualities', qualities], ['spells', spells], ['powers', powers]]) for (const it of list) extra.set(it.id, { item: it, file });
    const lookup = (id) => {
      const e = shop?.byId.get(id);
      if (e) return { item: e.item, file: e.file };
      return extra.get(id) || null;
    };
    const ctx = { rules, settings: settings || {} };
    if (ready) ctx.lookup = lookup;
    return { ctx, ready, shop, qualities, spells, powers, lookup };
  }, [shop, qualities, spells, powers, settings]);
}

/** compute() memoized on the data object. */
export function useComputed(data, rc) {
  return useMemo(() => {
    const result = compute(data, rc.ctx);
    return { result, issues: issuesByStep(result) };
  }, [data, rc.ctx]);
}

/** Immutable update helper: update(d => { d.x = 1 }) on a JSON-able draft. */
export function produce(data, fn) {
  const next = JSON.parse(JSON.stringify(data));
  fn(next);
  return normalizeDraft(next);
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return t('à l’instant');
  const m = Math.round(s / 60);
  if (m < 60) return t('il y a {n} min', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('il y a {n} h', { n: h });
  return fmtDate(ts, { day: 'numeric', month: 'short' });
}

/** « 12 / 24 » budget pill: state ok (exact), left (some left), over (red). */
export function Budget({ label, used, total, unit = '', title, invert = false, format }) {
  const left = total - used;
  const state = left < 0 ? 'over' : left === 0 ? 'ok' : 'left';
  const f = format || ((n) => `${n}${unit}`);
  return html`<div class=${'cg-budget ' + state + (invert ? ' inv' : '')} title=${title || ''}>
    <span class="cg-budget-label">${label}</span>
    <span class="cg-budget-value">${f(used)}<span class="faint"> / ${f(total)}</span></span>
  </div>`;
}

/** Points + karma steppers for one rating row. */
export function PointsKarma({ points, karma, onPoints, onKarma, maxPoints = 12, maxKarma = 12, disabled }) {
  return html`<span class="cg-pk">
    <${NumberInput} small value=${points} min=${0} max=${maxPoints} onChange=${onPoints} disabled=${disabled} />
    <span class="cg-pk-k" title=${t('Indices achetés en karma, après les points')}>
      <span class="faint small">K</span>
      <${NumberInput} small value=${karma} min=${0} max=${maxKarma} onChange=${onKarma} disabled=${disabled} />
    </span>
  </span>`;
}

/** Errors / warnings of a step. */
export function StepIssues({ issues }) {
  if (!issues || (!issues.errors.length && !issues.warnings.length)) return null;
  return html`<div class="cg-issues">
    ${issues.errors.map((i) => html`<div class="cg-issue err">✕ ${issueText(i)}</div>`)}
    ${issues.warnings.map((i) => html`<div class="cg-issue warn">! ${issueText(i)}</div>`)}
  </div>`;
}

export function fold(s) {
  return rules.fold(s);
}
