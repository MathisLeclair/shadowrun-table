// Draft summary: validation report, budgets, derived stats and a full stat-block preview of the future actor.
// Used by the wizard's last step and by the GM review panel.
import { useMemo } from 'preact/hooks';
import { html, Panel, Stat, Markdown } from '../../lib/ui.js';
import { derive } from '/shared/sr5.js';
import { buildActor, STEPS, COLUMNS, COLUMN_LABELS, MAGIC_TYPES } from '/shared/chargen.js';
import StatBlock from '../combat/StatBlock.js';
import { t, tn, tk, fmtNumber, metatypeLabel, itemName } from '../../lib/i18n.js';
import { nuyen, issueText } from './common.js';

const KARMA_LABELS = {
  qualities: tk('Qualités positives'), attributes: tk('Attributs'), skills: tk('Compétences'), specializations: tk('Spécialisations'), groups: tk('Groupes'),
  knowledge: tk('Connaissances'), spells: tk('Sorts supplémentaires'), forms: tk('Formes complexes'), powerPoints: tk('Points de pouvoir'), contacts: tk('Contacts'), nuyen: tk('Conversion en nuyens'),
};

export function ValidationReport({ result, onJump, compact }) {
  const byStep = STEPS.map((s) => ({
    s,
    errors: result.errors.filter((e) => e.step === s.id),
    warnings: result.warnings.filter((w) => w.step === s.id),
  })).filter((x) => x.errors.length || x.warnings.length);
  if (!byStep.length) return html`<div class="cg-valid ok">✓ ${t('Personnage conforme aux règles de création SR5 (priorités).')}</div>`;
  return html`<div class="cg-report">
    <div class=${'cg-valid ' + (result.errors.length ? 'err' : 'warn')}>
      ${result.errors.length ? tn(result.errors.length, '{n} erreur à corriger', '{n} erreurs à corriger') : t('Aucune erreur')}${result.warnings.length ? ` · ${tn(result.warnings.length, '{n} remarque', '{n} remarques')}` : ''}
    </div>
    ${byStep.map(({ s, errors, warnings }) => html`<div class="cg-report-step">
      <div class="cg-report-title">${onJump ? html`<button class="cg-link" onClick=${() => onJump(s.id)}>${t(s.label)} →</button>` : t(s.label)}</div>
      ${errors.map((e) => html`<div class="cg-issue err">✕ ${issueText(e)}</div>`)}
      ${!compact || !errors.length ? warnings.map((w) => html`<div class="cg-issue warn">! ${issueText(w)}</div>`) : null}
    </div>`)}
  </div>`;
}

export function useActorPreview(data, rc) {
  return useMemo(() => {
    try {
      const { actor } = buildActor(data, rc.ctx, {});
      return actor;
    } catch (err) {
      console.error('[chargen] preview failed', err);
      return null;
    }
  }, [data, rc.ctx]);
}

/** props: { data, result, rc, onJump?, showBackground? } */
export default function DraftSummary({ data, result, rc, onJump, showBackground = true }) {
  const r = result;
  const actor = useActorPreview(data, rc);
  let d = null;
  try {
    d = actor ? derive(actor) : null;
  } catch {}
  const p = data.priorities;
  return html`<div class="cg-summary">
    <div class="cg-summary-top">
      <${Panel} title=${t('Validation')}>
        <${ValidationReport} result=${r} onJump=${onJump} />
      </${Panel}>
      <${Panel} title=${t('Priorités')}>
        <div class="cg-sum-prio">
          ${COLUMNS.map((c) => html`<div class="cg-sum-prio-row"><span class=${'cg-letter' + (p[c] ? '' : ' empty')}>${p[c] || '?'}</span><span>${t(COLUMN_LABELS[c])}</span></div>`)}
        </div>
        <div class="small muted" style=${{ marginTop: '8px' }}>${metatypeLabel(data.metatype)} · ${t(MAGIC_TYPES[data.magic.type].label)}</div>
      </${Panel}>
      <${Panel} title=${t('Karma')}>
        <div class="cg-money small">
          <div class="spread row"><span>${r.karma.base !== 25 ? t('Départ (bonus MJ inclus)') : t('karma::Départ')}</span><span class="mono">${r.karma.base}</span></div>
          ${r.karma.negative > 0 && html`<div class="spread row"><span>${t('Qualités négatives')}</span><span class="mono green">+${r.karma.negative}</span></div>`}
          ${Object.entries(r.karma.parts).filter(([, v]) => v).map(([k, v]) => html`<div class="spread row"><span>${t(KARMA_LABELS[k])}</span><span class="mono magenta">−${v}</span></div>`)}
          <div class=${'spread row cg-money-total' + (r.karma.left < 0 ? ' red' : '')}><span>${t('Reste')}</span><span class="mono">${r.karma.left}</span></div>
          <div class="spread row faint"><span>${t('Conservé')}</span><span class="mono">${r.karma.kept}</span></div>
        </div>
      </${Panel}>
      <${Panel} title=${t('Nuyens')}>
        <div class="cg-money small">
          <div class="spread row"><span>${t('Ressources')}</span><span class="mono">${nuyen(r.nuyen.total)}</span></div>
          <div class="spread row"><span>${t('Équipement')}</span><span class="mono">−${nuyen(r.nuyen.gear)}</span></div>
          <div class="spread row"><span>${t('Train de vie')}</span><span class="mono">−${nuyen(r.nuyen.lifestyle)}</span></div>
          <div class=${'spread row cg-money-total' + (r.nuyen.left < 0 ? ' red' : '')}><span>${t('Reste')}</span><span class="mono">${nuyen(r.nuyen.left)}</span></div>
          <div class="spread row faint"><span>${t('Conservé')}</span><span class="mono">${nuyen(r.nuyen.kept)}${data.rollStartingNuyen && r.lifestyle?.dice ? ` + ${r.lifestyle.dice}D6×${r.lifestyle.multiplier}` : ''}</span></div>
        </div>
      </${Panel}>
    </div>
    ${d && html`<div class="cg-derived">
      <${Stat} label=${t('Essence')} value=${fmtNumber(d.essence)} accent="cyan" />
      <${Stat} label=${t('Sang-froid')} value=${d.composure} title=${t('Charisme + Volonté')} />
      <${Stat} label=${t('Jugement')} value=${d.judgeIntentions} title=${t('Jauger les intentions : Charisme + Intuition')} />
      <${Stat} label=${t('Mémoire')} value=${d.memory} title=${t('Logique + Volonté')} />
      <${Stat} label=${t('Soulever')} value=${d.liftCarry} title=${t('Soulever / porter : Constitution + Force')} />
      <${Stat} label=${t('Déplacement')} value=${`${d.movement.walk}/${d.movement.run} m`} title=${t('Marche / course')} />
      ${d.limits.astral && html`<${Stat} label=${t('Limite astrale')} value=${d.limits.astral} />`}
    </div>`}
    ${actor && html`<${StatBlock} t=${{ ...actor, npc: { kind: 'metahuman' }, disposition: 'pc', color: data.concept.color }} />`}
    ${(actor?.contacts?.length > 0 || actor?.lifestyle) && html`<${Panel} title=${t('Contacts & train de vie')} class="cg-mt">
      <div class="cg-chips">
        ${actor.contacts.map((c) => html`<span class="cg-chip">${c.name} <i>${t('Influence {c} · Loyauté {l}', { c: c.connection, l: c.loyalty })}${c.notes ? ` — ${c.notes}` : ''}</i></span>`)}
        ${actor.lifestyle && html`<span class="cg-chip">${r.lifestyle?.item ? itemName(r.lifestyle.item) : actor.lifestyle.name} <i>${tn(actor.lifestyle.monthsPaid, '{n} mois payé', '{n} mois payés')}</i></span>`}
      </div>
    </${Panel}>`}
    ${showBackground && data.concept.background && html`<${Panel} title=${t('bio::Historique')} class="cg-mt"><${Markdown} text=${data.concept.background} /></${Panel}>`}
    ${data.notes && html`<${Panel} title=${t('Mot pour le MJ')} class="cg-mt"><div class="cg-quote">${data.notes}</div></${Panel}>`}
  </div>`;
}

