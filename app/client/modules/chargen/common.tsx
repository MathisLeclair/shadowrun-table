// Character creation — client helpers: catalog context for shared/chargen.js, draft state, small widgets.
import { useMemo, type ReactNode } from 'react';
import { Badge, NumberInput } from '../../lib/ui.tsx';
import { useCatalog } from '../../lib/net.ts';
import { t, tk, getLang, fmtNumber, fmtNuyen, fmtDate, metatypeLabel } from '../../lib/i18n.ts';
import { compute, normalizeDraft, issuesByStep, issueText as sharedIssueText, MAGIC_TYPES } from '/shared/chargen.ts';
import * as rules from '../shop/rules.ts';
import { useShopCatalog } from '../shop/common.tsx';
import type { ChargenDraft, DraftData, DraftStatus, GameView } from '../../../shared/types.ts';
/** MAGIC_TYPES of shared/chargen.js, indexed by any magic type id. */
const MAGIC_TYPE_DEFS = MAGIC_TYPES as Record<string, { label: string }>;
/** fmtDate() of i18n.js with any Intl options (its JS default parameter narrows the inferred type). */
const fmtDateOpts = fmtDate as (ts: number, opts?: Intl.DateTimeFormatOptions) => string;
import type { ChargenIssue, ChargenResult, LooseCatalogItem, RulesCtx, ShopCatalog, StepIssueList } from './types.ts';

/** 12500 → « 12 500¥ » (fr) / « 12,500¥ » (en). */
export const nuyen: (n: number) => string = fmtNuyen;

export const STATUS_LABEL: Record<DraftStatus, string> = { draft: tk('Brouillon'), pending: tk('En attente du MJ'), approved: tk('Validé'), rejected: tk('À revoir') };
export const STATUS_COLOR: Record<DraftStatus, string> = { draft: 'dim', pending: 'amber', approved: 'green', rejected: 'red' };

export function StatusBadge({ status }: { status: DraftStatus }) {
  return <Badge color={STATUS_COLOR[status] || 'dim'}>{STATUS_LABEL[status] ? t(STATUS_LABEL[status]) : status}</Badge>;
}

/** i18n hooks handed to shared/chargen.js display helpers (priorityText, magicOptionText…). */
export const i18n = () => ({ t, fmtNumber, lang: getLang() });

/** A validation issue (shared/chargen.js compute()) in the UI language. */
export const issueText = (i: ChargenIssue): string => sharedIssueText(i, i18n());

/** draftHeadline() of shared/chargen.js. */
export interface DraftHeadline {
  name: string;
  text: string;
  unnamed?: boolean;
  metatype?: string;
  magicType?: string;
  concept?: string;
  letters: string;
}

/** draftHeadline() rebuilt in the UI language: { name, text }. */
export function headlineText(h: DraftHeadline): { name: string; text: string } {
  const bits = [metatypeLabel(h.metatype)];
  if (h.magicType && h.magicType !== 'none' && MAGIC_TYPE_DEFS[h.magicType]) bits.push(t(MAGIC_TYPE_DEFS[h.magicType].label));
  if (h.concept) bits.push(h.concept);
  return { name: h.unnamed ? t('Sans nom') : h.name, text: h.metatype ? bits.join(' · ') : h.text };
}

/** Name of the user who owns a draft (the GM's stored « MJ » is translated). */
export const ownerName = (game: GameView, d: ChargenDraft, fallback: string = tk('Joueur')): string =>
  d.userId === 'gm' ? t('MJ') : game.users?.[d.userId]?.name || d.userName || t(fallback);

/**
 * Catalog context for compute()/buildActor(): shop catalog (gear, lifestyles…) + qualities, spells, powers.
 * Returns { ctx, ready, shop, qualities, spells, powers }. While loading, ctx has no lookup (no « introuvable » errors).
 */
export function useRulesCtx(game: GameView | null | undefined): RulesCtx {
  const shop = useShopCatalog() as ShopCatalog | null;
  const qualities = useCatalog<LooseCatalogItem>('qualities');
  const spells = useCatalog<LooseCatalogItem>('spells');
  const powers = useCatalog<LooseCatalogItem>('powers');
  const settings = game?.chargen?.settings;
  return useMemo(() => {
    const ready = !!shop && qualities.length > 0 && spells.length > 0 && powers.length > 0;
    const extra = new Map<string, { item: LooseCatalogItem; file: string }>();
    for (const [file, list] of [
      ['qualities', qualities],
      ['spells', spells],
      ['powers', powers],
    ] as const)
      for (const it of list) extra.set(it.id, { item: it, file });
    const lookup = (id: string) => {
      const e = shop?.byId.get(id);
      if (e) return { item: e.item, file: e.file };
      return extra.get(id) || null;
    };
    const ctx: RulesCtx['ctx'] = { rules, settings: settings || {} };
    if (ready) ctx.lookup = lookup;
    return { ctx, ready, shop, qualities, spells, powers, lookup };
  }, [shop, qualities, spells, powers, settings]);
}

/** compute() memoized on the data object. */
export function useComputed(data: DraftData, rc: RulesCtx): { result: ChargenResult; issues: Record<string, StepIssueList> } {
  return useMemo(() => {
    const result = compute(data, rc.ctx);
    return { result, issues: issuesByStep(result) as Record<string, StepIssueList> };
  }, [data, rc.ctx]);
}

/** Immutable update helper: update(d => { d.x = 1 }) on a JSON-able draft. */
export function produce(data: DraftData, fn: (d: DraftData) => unknown): DraftData {
  const next = JSON.parse(JSON.stringify(data));
  fn(next);
  return normalizeDraft(next) as DraftData;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return t('à l’instant');
  const m = Math.round(s / 60);
  if (m < 60) return t('il y a {n} min', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('il y a {n} h', { n: h });
  return fmtDateOpts(ts, { day: 'numeric', month: 'short' });
}

interface BudgetProps {
  label: ReactNode;
  used: number;
  total: number;
  unit?: string;
  title?: string;
  invert?: boolean;
  format?: (n: number) => ReactNode;
}
/** « 12 / 24 » budget pill: state ok (exact), left (some left), over (red). */
export function Budget({ label, used, total, unit = '', title, invert = false, format }: BudgetProps) {
  const left = total - used;
  const state = left < 0 ? 'over' : left === 0 ? 'ok' : 'left';
  const f = format || ((n: number) => `${n}${unit}`);
  return (
    <div className={'cg-budget ' + state + (invert ? ' inv' : '')} title={title || ''}>
      <span className="cg-budget-label">{label}</span>
      <span className="cg-budget-value">
        {f(used)}
        <span className="faint"> / {f(total)}</span>
      </span>
    </div>
  );
}

interface PointsKarmaProps {
  points: number;
  karma: number;
  onPoints: (v: number) => void;
  onKarma: (v: number) => void;
  maxPoints?: number;
  maxKarma?: number;
  disabled?: boolean;
}
/** Points + karma steppers for one rating row. */
export function PointsKarma({ points, karma, onPoints, onKarma, maxPoints = 12, maxKarma = 12, disabled }: PointsKarmaProps) {
  return (
    <span className="cg-pk">
      <NumberInput small value={points} min={0} max={maxPoints} onChange={onPoints} disabled={disabled} />
      <span className="cg-pk-k" title={t('Indices achetés en karma, après les points')}>
        <span className="faint small">K</span>
        <NumberInput small value={karma} min={0} max={maxKarma} onChange={onKarma} disabled={disabled} />
      </span>
    </span>
  );
}

/** Errors / warnings of a step. */
export function StepIssues({ issues }: { issues: StepIssueList | null | undefined }) {
  if (!issues || (!issues.errors.length && !issues.warnings.length)) return null;
  return (
    <div className="cg-issues">
      {issues.errors.map((i, n) => (
        <div key={'e' + n} className="cg-issue err">
          ✕ {issueText(i)}
        </div>
      ))}
      {issues.warnings.map((i, n) => (
        <div key={'w' + n} className="cg-issue warn">
          ! {issueText(i)}
        </div>
      ))}
    </div>
  );
}

export function fold(s: string): string {
  return rules.fold(s);
}
