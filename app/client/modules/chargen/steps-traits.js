// Wizard step: Qualités (catalog qualities.json, karma costs, positive / negative caps).
import { useMemo, useState } from 'preact/hooks';
import { html, Select, TextInput, NumberInput, Panel, IconButton, Toggle, Tabs } from '../../lib/ui.js';
import { SKILLS } from '/shared/sr5.js';
import { t, getLang, attrLabel, skillLabel, itemName } from '../../lib/i18n.js';
import { MAGIC_QUALITY_NAMES, LIMITS, rowId } from '/shared/chargen.js';
import { Budget, StepIssues } from './common.js';
import Picker from './Picker.js';

const CHOICE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'MAG', 'RES'];
const NEEDS_CHOICE = {
  'Exceptional Attribute': 'attr',
  Aptitude: 'skill',
};

export function StepQualities({ data, update, result, issues, rc }) {
  const r = result;
  const [tab, setTab] = useState('positive');
  const [coreOnly, setCoreOnly] = useState(true);
  const selected = useMemo(() => new Set(data.qualities.map((q) => q.catalogId)), [data.qualities]);
  const positive = r.qualities.filter((q) => q.positive).reduce((s, q) => s + q.cost, 0);
  const negative = r.qualities.filter((q) => !q.positive).reduce((s, q) => s + q.cost, 0);
  const items = useMemo(() => rc.qualities.filter((q) => !MAGIC_QUALITY_NAMES.has(q.name) && !q.stats?.metagenic && !/^Infected /.test(q.name)), [rc.qualities]);
  const filter = (q) => (tab === 'positive' ? q.stats?.positive !== false : q.stats?.positive === false) && (!coreOnly || q.source === 'SR5');
  const setQ = (id, k, v) =>
    update((d) => {
      const x = d.qualities.find((y) => y.id === id);
      if (x) x[k] = v;
    });
  return html`<div class="cg-step">
    <p class="cg-lead">${t('Les qualités positives coûtent du karma, les négatives en rapportent : {max} karma maximum de chaque côté. Le karma restant sert ensuite aux attributs, compétences, sorts et contacts, et jusqu’à 10 karma peuvent devenir des nuyens (2 000¥ le point).', { max: LIMITS.positiveQualities })}</p>
    <div class="row wrap cg-budget-row">
      <${Budget} label=${t('Qualités positives')} used=${positive} total=${LIMITS.positiveQualities} unit=" K" />
      <${Budget} label=${t('Qualités négatives')} used=${negative} total=${LIMITS.negativeQualities} unit=" K" />
      <${Budget} label=${t('Karma dépensé')} used=${r.karma.spent} total=${r.karma.total} title=${r.karma.base !== 25 ? t('25 + karma des qualités négatives (bonus MJ inclus)') : t('25 + karma des qualités négatives')} />
    </div>
    <${Panel} title=${t('Qualités choisies')} pad=${false}>
      <table class="sr cg-skill-table">
        <tbody>
          ${r.qualities.map((q) => {
            const row = data.qualities.find((x) => x.catalogId === q.catalogId);
            if (!row) return null;
            const kind = NEEDS_CHOICE[q.en];
            return html`<tr key=${row.id}>
              <td><strong class=${q.positive ? 'green' : 'red'}>${q.item ? itemName(q.item) : q.name}</strong>${getLang() === 'fr' && q.en !== q.name ? html` <span class="faint small">${q.en}</span>` : ''}</td>
              <td>${q.maxLevels > 1 ? html`<span class="row gap-s"><span class="small muted">${t('Niveau')}</span><${NumberInput} small value=${row.level} min=${1} max=${q.maxLevels} onChange=${(v) => setQ(row.id, 'level', v)} /></span>` : ''}</td>
              <td>${kind === 'attr'
                ? html`<${Select} value=${row.choice} onChange=${(v) => setQ(row.id, 'choice', v)} options=${[{ value: '', label: t('— Attribut —') }, ...CHOICE_ATTRS.map((k) => ({ value: k, label: attrLabel(k) }))]} />`
                : kind === 'skill'
                  ? html`<${Select} value=${row.choice} onChange=${(v) => setQ(row.id, 'choice', v)} options=${[{ value: '', label: t('— Compétence —') }, ...SKILLS.map((s) => ({ value: s.id, label: skillLabel(s) }))]} />`
                  : html`<${TextInput} live value=${row.notes} placeholder=${t('Précision (allergie à…, addiction à…)')} onChange=${(v) => setQ(row.id, 'notes', v)} />`}</td>
              <td class="num-cell ${q.positive ? 'magenta' : 'green'}">${q.positive ? `−${q.cost}` : `+${q.cost}`} K</td>
              <td><${IconButton} icon="✕" title=${t('Retirer')} onClick=${() => update((d) => (d.qualities = d.qualities.filter((x) => x.id !== row.id)))} /></td>
            </tr>`;
          })}
          ${!r.qualities.length && html`<tr><td colspan="5" class="muted center">${t('Aucune qualité pour l’instant.')}</td></tr>`}
        </tbody>
      </table>
    </${Panel}>
    <${Panel} title=${t('Catalogue')} class="cg-mt">
      <${Tabs} tabs=${[{ id: 'positive', label: t('Positives') }, { id: 'negative', label: t('Négatives') }]} value=${tab} onChange=${setTab} />
      ${!rc.qualities.length
        ? html`<div class="cg-loading">${t('Chargement du catalogue…')}</div>`
        : html`<${Picker} items=${items} name=${itemName} placeholder=${t('Chercher une qualité…')}
          extraFilter=${filter}
          toolbar=${html`<${Toggle} value=${coreOnly} onChange=${setCoreOnly} label=${t('Livre de base')} title=${t('Seulement les qualités du livre de base SR5')} />`}
          meta=${(it) => `${it.stats?.maxLevels ? t('{n} karma par niveau (max {max})', { n: Math.abs(it.stats?.karma || 0), max: it.stats.maxLevels }) : t('{n} karma', { n: Math.abs(it.stats?.karma || 0) })} · ${it.source} p.${it.page}${it.stats?.chargenOnly ? ` · ${t('création uniquement')}` : ''}`}
          selected=${selected}
          onAdd=${(it) => update((d) => d.qualities.push({ id: rowId('q'), catalogId: it.id, name: it.nameFr || it.name, level: 1, choice: '', notes: '' }))} />`}
    </${Panel}>
    <${StepIssues} issues=${issues} />
  </div>`;
}
