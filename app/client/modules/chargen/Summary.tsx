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
  qualities: tk('Qualités positives'),
  attributes: tk('Attributs'),
  skills: tk('Compétences'),
  specializations: tk('Spécialisations'),
  groups: tk('Groupes'),
  knowledge: tk('Connaissances'),
  spells: tk('Sorts supplémentaires'),
  forms: tk('Formes complexes'),
  powerPoints: tk('Points de pouvoir'),
  contacts: tk('Contacts'),
  nuyen: tk('Conversion en nuyens'),
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
  if (!byStep.length) return <div className="cg-valid ok">✓ {t('Personnage conforme aux règles de création SR5 (priorités).')}</div>;
  return (
    <div className="cg-report">
      <div className={'cg-valid ' + (result.errors.length ? 'err' : 'warn')}>
        {result.errors.length ? tn(result.errors.length, '{n} erreur à corriger', '{n} erreurs à corriger') : t('Aucune erreur')}
        {result.warnings.length ? ` · ${tn(result.warnings.length, '{n} remarque', '{n} remarques')}` : ''}
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
        <Panel title={t('Priorités')}>
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
              <span>{r.karma.base !== 25 ? t('Départ (bonus MJ inclus)') : t('karma::Départ')}</span>
              <span className="mono">{r.karma.base}</span>
            </div>
            {r.karma.negative > 0 && (
              <div className="spread row">
                <span>{t('Qualités négatives')}</span>
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
              <span>{t('Reste')}</span>
              <span className="mono">{r.karma.left}</span>
            </div>
            <div className="spread row faint">
              <span>{t('Conservé')}</span>
              <span className="mono">{r.karma.kept}</span>
            </div>
          </div>
        </Panel>
        <Panel title={t('Nuyens')}>
          <div className="cg-money small">
            <div className="spread row">
              <span>{t('Ressources')}</span>
              <span className="mono">{nuyen(r.nuyen.total)}</span>
            </div>
            <div className="spread row">
              <span>{t('Équipement')}</span>
              <span className="mono">−{nuyen(r.nuyen.gear)}</span>
            </div>
            <div className="spread row">
              <span>{t('Train de vie')}</span>
              <span className="mono">−{nuyen(r.nuyen.lifestyle)}</span>
            </div>
            <div className={'spread row cg-money-total' + (r.nuyen.left < 0 ? ' red' : '')}>
              <span>{t('Reste')}</span>
              <span className="mono">{nuyen(r.nuyen.left)}</span>
            </div>
            <div className="spread row faint">
              <span>{t('Conservé')}</span>
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
          <Stat label={t('Sang-froid')} value={d.composure} title={t('Charisme + Volonté')} />
          <Stat label={t('Jugement')} value={d.judgeIntentions} title={t('Jauger les intentions : Charisme + Intuition')} />
          <Stat label={t('Mémoire')} value={d.memory} title={t('Logique + Volonté')} />
          <Stat label={t('Soulever')} value={d.liftCarry} title={t('Soulever / porter : Constitution + Force')} />
          <Stat label={t('Déplacement')} value={`${d.movement.walk}/${d.movement.run} m`} title={t('Marche / course')} />
          {d.limits.astral && <Stat label={t('Limite astrale')} value={d.limits.astral} />}
        </div>
      )}
      {actor && <StatBlock t={{ ...actor, npc: { kind: 'metahuman' }, disposition: 'pc', color: data.concept.color }} />}
      {actor && ((actor.contacts?.length ?? 0) > 0 || (actor.lifestyles?.length ?? 0) > 0) && (
        <Panel title={t('Contacts & train de vie')} className="cg-mt">
          <div className="cg-chips">
            {actor.contacts.map((c, i) => (
              <span key={c.id || 'c' + i} className="cg-chip">
                {c.name}{' '}
                <i>
                  {t('Influence {c} · Loyauté {l}', { c: c.connection, l: c.loyalty })}
                  {c.notes ? ` — ${c.notes}` : ''}
                </i>
              </span>
            ))}
            {(actor.lifestyles || []).map((l, i) => (
              <span key={l.id || 'l' + i} className="cg-chip">
                {r.lifestyle?.item ? itemName(r.lifestyle.item) : l.name} <i>{tn(l.monthsPaid, '{n} mois payé', '{n} mois payés')}</i>
              </span>
            ))}
          </div>
        </Panel>
      )}
      {showBackground && data.concept.background && (
        <Panel title={t('bio::Historique')} className="cg-mt">
          <Markdown text={data.concept.background} />
        </Panel>
      )}
      {data.notes && (
        <Panel title={t('Mot pour le MJ')} className="cg-mt">
          <div className="cg-quote">{data.notes}</div>
        </Panel>
      )}
    </div>
  );
}
