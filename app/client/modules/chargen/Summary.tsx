// Draft summary: validation report, budgets, derived stats and a full stat-block preview of the future actor.
// Used by the wizard's last step and by the GM review panel.
import { useMemo } from 'react';
import { Panel, Stat, Markdown } from '../../lib/ui.tsx';
import { derive } from '/shared/sr5.ts';
import { buildActor, STEPS, COLUMNS, COLUMN_LABELS, MAGIC_TYPES } from '/shared/chargen.ts';
import StatBlock from '../combat/StatBlock.tsx';
import { t, tn, tk, fmtNumber, metatypeLabel, itemName } from '../../lib/i18n.ts';
import { nuyen, issueText } from './common.tsx';
import type { Actor, DraftData, PriorityColumn } from '../../../shared/types.ts';
import type { ChargenIssue, ChargenResult, RulesCtx } from './types.ts';

const KARMA_LABELS: Record<string, string> = {
  qualities: tk('Positive Qualities'),
  attributes: tk('Attributes'),
  skills: tk('Skills'),
  specializations: tk('Specializations'),
  groups: tk('Groups'),
  knowledge: tk('pl::Knowledge'),
  spells: tk('Extra spells'),
  forms: tk('Complex Forms'),
  powerPoints: tk('Power Points'),
  contacts: tk('Contacts'),
  nuyen: tk('Converted to nuyen'),
};

interface ValidationReportProps {
  result: ChargenResult;
  onJump?: (stepId: string) => void;
  compact?: boolean;
}
export function ValidationReport({ result, onJump, compact }: ValidationReportProps) {
  const byStep = (STEPS as Array<{ id: string; label: string }>)
    .map((s) => ({
      s,
      errors: (result.errors as ChargenIssue[]).filter((e) => e.step === s.id),
      warnings: (result.warnings as ChargenIssue[]).filter((w) => w.step === s.id),
    }))
    .filter((x) => x.errors.length || x.warnings.length);
  if (!byStep.length) return <div className="cg-valid ok">✓ {t('Character complies with the SR5 creation rules (priorities).')}</div>;
  return (
    <div className="cg-report">
      <div className={'cg-valid ' + (result.errors.length ? 'err' : 'warn')}>
        {result.errors.length ? tn(result.errors.length, '{n} error to fix', '{n} errors to fix') : t('No errors')}
        {result.warnings.length ? ` · ${tn(result.warnings.length, '{n} remark', '{n} remarks')}` : ''}
      </div>
      {byStep.map(({ s, errors, warnings }) => (
        <div key={s.id} className="cg-report-step">
          <div className="cg-report-title">
            {onJump ? (
              <button className="cg-link" onClick={() => onJump(s.id)}>
                {t(s.label)} →
              </button>
            ) : (
              t(s.label)
            )}
          </div>
          {errors.map((e, i) => (
            <div key={'e' + i} className="cg-issue err">
              ✕ {issueText(e)}
            </div>
          ))}
          {!compact || !errors.length
            ? warnings.map((w, i) => (
                <div key={'w' + i} className="cg-issue warn">
                  ! {issueText(w)}
                </div>
              ))
            : null}
        </div>
      ))}
    </div>
  );
}

export function useActorPreview(data: DraftData, rc: RulesCtx): Actor | null {
  return useMemo(() => {
    try {
      const { actor } = buildActor(data, rc.ctx, {});
      return actor as unknown as Actor;
    } catch (err) {
      console.error('[chargen] preview failed', err);
      return null;
    }
  }, [data, rc.ctx]);
}

interface DraftSummaryProps {
  data: DraftData;
  result: ChargenResult;
  rc: RulesCtx;
  onJump?: (stepId: string) => void;
  showBackground?: boolean;
}
/** props: { data, result, rc, onJump?, showBackground? } */
export default function DraftSummary({ data, result, rc, onJump, showBackground = true }: DraftSummaryProps) {
  const r = result;
  const actor = useActorPreview(data, rc);
  let d = null;
  try {
    d = actor ? derive(actor) : null;
  } catch {}
  const p = data.priorities;
  return (
    <div className="cg-summary">
      <div className="cg-summary-top">
        <Panel title={t('Validation')}>
          <ValidationReport result={r} onJump={onJump} />
        </Panel>
        <Panel title={t('Priorities')}>
          <div className="cg-sum-prio">
            {(COLUMNS as PriorityColumn[]).map((c) => (
              <div key={c} className="cg-sum-prio-row">
                <span className={'cg-letter' + (p[c] ? '' : ' empty')}>{p[c] || '?'}</span>
                <span>{t(COLUMN_LABELS[c])}</span>
              </div>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: '8px' }}>
            {metatypeLabel(data.metatype)} · {t(MAGIC_TYPES[data.magic.type].label)}
          </div>
        </Panel>
        <Panel title={t('Karma')}>
          <div className="cg-money small">
            <div className="spread row">
              <span>{r.karma.base !== 25 ? t('Starting (GM bonus included)') : t('karma::Starting')}</span>
              <span className="mono">{r.karma.base}</span>
            </div>
            {r.karma.negative > 0 && (
              <div className="spread row">
                <span>{t('Negative Qualities')}</span>
                <span className="mono green">+{r.karma.negative}</span>
              </div>
            )}
            {(Object.entries(r.karma.parts) as Array<[string, number]>)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="spread row">
                  <span>{t(KARMA_LABELS[k])}</span>
                  <span className="mono magenta">−{v}</span>
                </div>
              ))}
            <div className={'spread row cg-money-total' + (r.karma.left < 0 ? ' red' : '')}>
              <span>{t('Left')}</span>
              <span className="mono">{r.karma.left}</span>
            </div>
            <div className="spread row faint">
              <span>{t('Kept')}</span>
              <span className="mono">{r.karma.kept}</span>
            </div>
          </div>
        </Panel>
        <Panel title={t('Nuyen')}>
          <div className="cg-money small">
            <div className="spread row">
              <span>{t('Resources')}</span>
              <span className="mono">{nuyen(r.nuyen.total)}</span>
            </div>
            <div className="spread row">
              <span>{t('Gear')}</span>
              <span className="mono">−{nuyen(r.nuyen.gear)}</span>
            </div>
            <div className="spread row">
              <span>{t('Lifestyle')}</span>
              <span className="mono">−{nuyen(r.nuyen.lifestyle)}</span>
            </div>
            <div className={'spread row cg-money-total' + (r.nuyen.left < 0 ? ' red' : '')}>
              <span>{t('Left')}</span>
              <span className="mono">{nuyen(r.nuyen.left)}</span>
            </div>
            <div className="spread row faint">
              <span>{t('Kept')}</span>
              <span className="mono">
                {nuyen(r.nuyen.kept)}
                {data.rollStartingNuyen && r.lifestyle?.dice ? ` + ${r.lifestyle.dice}D6×${r.lifestyle.multiplier}` : ''}
              </span>
            </div>
          </div>
        </Panel>
      </div>
      {d && (
        <div className="cg-derived">
          <Stat label={t('Essence')} value={fmtNumber(d.essence)} accent="cyan" />
          <Stat label={t('Composure')} value={d.composure} title={t('Charisma + Willpower')} />
          <Stat label={t('short::Judge Intentions')} value={d.judgeIntentions} title={t('Judge Intentions: Charisma + Intuition')} />
          <Stat label={t('Memory')} value={d.memory} title={t('Logic + Willpower')} />
          <Stat label={t('short::Lift/Carry')} value={d.liftCarry} title={t('Lift/Carry: Body + Strength')} />
          <Stat label={t('Movement')} value={`${d.movement.walk}/${d.movement.run} m`} title={t('Walk / run')} />
          {d.limits.astral && <Stat label={t('Astral Limit')} value={d.limits.astral} />}
        </div>
      )}
      {actor && <StatBlock t={{ ...actor, npc: { kind: 'metahuman' }, disposition: 'pc', color: data.concept.color }} />}
      {actor && ((actor.contacts?.length ?? 0) > 0 || (actor.lifestyles?.length ?? 0) > 0) && (
        <Panel title={t('Contacts & lifestyle')} className="cg-mt">
          <div className="cg-chips">
            {actor.contacts.map((c, i) => (
              <span key={c.id || 'c' + i} className="cg-chip">
                {c.name}{' '}
                <i>
                  {t('Connection {c} · Loyalty {l}', { c: c.connection, l: c.loyalty })}
                  {c.notes ? ` — ${c.notes}` : ''}
                </i>
              </span>
            ))}
            {(actor.lifestyles || []).map((l, i) => (
              <span key={l.id || 'l' + i} className="cg-chip">
                {r.lifestyle?.item ? itemName(r.lifestyle.item) : l.name} <i>{tn(l.monthsPaid, '{n} month paid', '{n} months paid')}</i>
              </span>
            ))}
          </div>
        </Panel>
      )}
      {showBackground && data.concept.background && (
        <Panel title={t('bio::Background')} className="cg-mt">
          <Markdown text={data.concept.background} />
        </Panel>
      )}
      {data.notes && (
        <Panel title={t('Note for the GM')} className="cg-mt">
          <div className="cg-quote">{data.notes}</div>
        </Panel>
      )}
    </div>
  );
}
