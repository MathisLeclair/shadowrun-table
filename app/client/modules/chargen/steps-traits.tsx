// Wizard step: Qualités (catalog qualities.json, karma costs, positive / negative caps).
import { useMemo, useState } from 'react';
import { Select, TextInput, NumberInput, Panel, IconButton, Toggle, Tabs } from '../../lib/ui.tsx';
import { SKILLS } from '/shared/sr5.ts';
import { t, getLang, attrLabel, skillLabel, itemName } from '../../lib/i18n.ts';
import { MAGIC_QUALITY_NAMES, LIMITS, rowId } from '/shared/chargen.ts';
import { Budget, StepIssues } from './common.tsx';
import Picker from './Picker.tsx';
import type { DraftData } from '../../../shared/types.ts';
import type { LooseCatalogItem, StepProps } from './types.ts';
import { ItemRef } from '../books/BookRef.tsx';

const CHOICE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'MAG', 'RES'];
const NEEDS_CHOICE: Record<string, 'attr' | 'skill'> = {
  'Exceptional Attribute': 'attr',
  Aptitude: 'skill',
};

/** compute() quality row. */
interface QualityState {
  catalogId: string;
  name: string;
  en: string;
  item: LooseCatalogItem | null;
  positive: boolean;
  cost: number;
  maxLevels: number;
}
type QualityRow = DraftData['qualities'][number];

export function StepQualities({ data, update, result, issues, rc }: StepProps) {
  const r = result;
  const [tab, setTab] = useState<'positive' | 'negative'>('positive');
  const [coreOnly, setCoreOnly] = useState(true);
  const selected = useMemo(() => new Set(data.qualities.map((q) => q.catalogId)), [data.qualities]);
  const qualities = r.qualities as QualityState[];
  const positive = qualities.filter((q) => q.positive).reduce((s, q) => s + q.cost, 0);
  const negative = qualities.filter((q) => !q.positive).reduce((s, q) => s + q.cost, 0);
  const items = useMemo(() => rc.qualities.filter((q) => !MAGIC_QUALITY_NAMES.has(q.name) && !q.stats?.metagenic && !/^Infected /.test(q.name)), [rc.qualities]);
  const filter = (q: LooseCatalogItem) => (tab === 'positive' ? q.stats?.positive !== false : q.stats?.positive === false) && (!coreOnly || q.source === 'SR5');
  const setQ = <K extends keyof QualityRow>(id: string, k: K, v: QualityRow[K]) =>
    update((d) => {
      const x = d.qualities.find((y) => y.id === id);
      if (x) x[k] = v;
    });
  return (
    <div className="cg-step">
      <p className="cg-lead">
        {t(
          'Les qualités positives coûtent du karma, les négatives en rapportent : {max} karma maximum de chaque côté. Le karma restant sert ensuite aux attributs, compétences, sorts et contacts, et jusqu’à 10 karma peuvent devenir des nuyens (2 000¥ le point).',
          { max: LIMITS.positiveQualities }
        )}
      </p>
      <div className="row wrap cg-budget-row">
        <Budget label={t('Qualités positives')} used={positive} total={LIMITS.positiveQualities} unit=" K" />
        <Budget label={t('Qualités négatives')} used={negative} total={LIMITS.negativeQualities} unit=" K" />
        <Budget
          label={t('Karma dépensé')}
          used={r.karma.spent}
          total={r.karma.total}
          title={r.karma.base !== 25 ? t('25 + karma des qualités négatives (bonus MJ inclus)') : t('25 + karma des qualités négatives')}
        />
      </div>
      <Panel title={t('Qualités choisies')} pad={false}>
        <table className="sr cg-skill-table">
          <tbody>
            {qualities.map((q) => {
              const row = data.qualities.find((x) => x.catalogId === q.catalogId);
              if (!row) return null;
              const kind = NEEDS_CHOICE[q.en];
              return (
                <tr key={row.id}>
                  <td>
                    <strong className={q.positive ? 'green' : 'red'}>{q.item ? itemName(q.item) : q.name}</strong> <ItemRef item={q.item} />
                    {getLang() === 'fr' && q.en !== q.name ? (
                      <>
                        {' '}
                        <span className="faint small">{q.en}</span>
                      </>
                    ) : (
                      ''
                    )}
                  </td>
                  <td>
                    {q.maxLevels > 1 ? (
                      <span className="row gap-s">
                        <span className="small muted">{t('Niveau')}</span>
                        <NumberInput small value={row.level} min={1} max={q.maxLevels} onChange={(v) => setQ(row.id, 'level', v)} />
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td>
                    {kind === 'attr' ? (
                      <Select value={row.choice} onChange={(v) => setQ(row.id, 'choice', v)} options={[{ value: '', label: t('— Attribut —') }, ...CHOICE_ATTRS.map((k) => ({ value: k, label: attrLabel(k) }))]} />
                    ) : kind === 'skill' ? (
                      <Select
                        value={row.choice}
                        onChange={(v) => setQ(row.id, 'choice', v)}
                        options={[{ value: '', label: t('— Compétence —') }, ...SKILLS.map((s: { id: string }) => ({ value: s.id, label: skillLabel(s) }))]}
                      />
                    ) : (
                      <TextInput live value={row.notes} placeholder={t('Précision (allergie à…, addiction à…)')} onChange={(v) => setQ(row.id, 'notes', v)} />
                    )}
                  </td>
                  <td className={`num-cell ${q.positive ? 'magenta' : 'green'}`}>{q.positive ? `−${q.cost}` : `+${q.cost}`} K</td>
                  <td>
                    <IconButton icon="✕" title={t('Retirer')} onClick={() => update((d) => (d.qualities = d.qualities.filter((x) => x.id !== row.id)))} />
                  </td>
                </tr>
              );
            })}
            {!qualities.length && (
              <tr>
                <td colSpan={5} className="muted center">
                  {t('Aucune qualité pour l’instant.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      <Panel title={t('Catalogue')} className="cg-mt">
        <Tabs
          tabs={[
            { id: 'positive', label: t('Positives') },
            { id: 'negative', label: t('Négatives') },
          ]}
          value={tab}
          onChange={setTab}
        />
        {!rc.qualities.length ? (
          <div className="cg-loading">{t('Chargement du catalogue…')}</div>
        ) : (
          <Picker
            items={items}
            name={itemName}
            placeholder={t('Chercher une qualité…')}
            extraFilter={filter}
            toolbar={<Toggle value={coreOnly} onChange={setCoreOnly} label={t('Livre de base')} title={t('Seulement les qualités du livre de base SR5')} />}
            meta={(it) =>
              `${it.stats?.maxLevels ? t('{n} karma par niveau (max {max})', { n: Math.abs(it.stats?.karma || 0), max: it.stats.maxLevels }) : t('{n} karma', { n: Math.abs(it.stats?.karma || 0) })} · ${it.source} p.${it.page}${it.stats?.chargenOnly ? ` · ${t('création uniquement')}` : ''}`
            }
            selected={selected}
            onAdd={(it) => update((d) => d.qualities.push({ id: rowId('q'), catalogId: it.id, name: it.nameFr || it.name, level: 1, choice: '', notes: '' }))}
          />
        )}
      </Panel>
      <StepIssues issues={issues} />
    </div>
  );
}
