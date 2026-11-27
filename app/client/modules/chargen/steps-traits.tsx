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
          'Positive qualities cost karma, negative ones give some back: {max} karma maximum each way. The remaining karma then goes to attributes, skills, spells and contacts, and up to 10 karma can become nuyen (2,000¥ per point).',
          { max: LIMITS.positiveQualities }
        )}
      </p>
      <div className="row wrap cg-budget-row">
        <Budget label={t('Positive Qualities')} used={positive} total={LIMITS.positiveQualities} unit=" K" />
        <Budget label={t('Negative Qualities')} used={negative} total={LIMITS.negativeQualities} unit=" K" />
        <Budget
          label={t('Karma spent')}
          used={r.karma.spent}
          total={r.karma.total}
          title={r.karma.base !== 25 ? t('25 + negative qualities karma (GM bonus included)') : t('25 + negative qualities karma')}
        />
      </div>
      <Panel title={t('Chosen qualities')} pad={false}>
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
                        <span className="small muted">{t('Level')}</span>
                        <NumberInput small value={row.level} min={1} max={q.maxLevels} onChange={(v) => setQ(row.id, 'level', v)} />
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td>
                    {kind === 'attr' ? (
                      <Select value={row.choice} onChange={(v) => setQ(row.id, 'choice', v)} options={[{ value: '', label: t('— Attribute —') }, ...CHOICE_ATTRS.map((k) => ({ value: k, label: attrLabel(k) }))]} />
                    ) : kind === 'skill' ? (
                      <Select
                        value={row.choice}
                        onChange={(v) => setQ(row.id, 'choice', v)}
                        options={[{ value: '', label: t('— Skill —') }, ...SKILLS.map((s: { id: string }) => ({ value: s.id, label: skillLabel(s) }))]}
                      />
                    ) : (
                      <TextInput live value={row.notes} placeholder={t('Detail (allergy to…, addiction to…)')} onChange={(v) => setQ(row.id, 'notes', v)} />
                    )}
                  </td>
                  <td className={`num-cell ${q.positive ? 'magenta' : 'green'}`}>{q.positive ? `−${q.cost}` : `+${q.cost}`} K</td>
                  <td>
                    <IconButton icon="✕" title={t('Remove')} onClick={() => update((d) => (d.qualities = d.qualities.filter((x) => x.id !== row.id)))} />
                  </td>
                </tr>
              );
            })}
            {!qualities.length && (
              <tr>
                <td colSpan={5} className="muted center">
                  {t('No qualities yet.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      <Panel title={t('Catalog')} className="cg-mt">
        <Tabs
          tabs={[
            { id: 'positive', label: t('pl::Positive') },
            { id: 'negative', label: t('Negative') },
          ]}
          value={tab}
          onChange={setTab}
        />
        {!rc.qualities.length ? (
          <div className="cg-loading">{t('Loading the catalog…')}</div>
        ) : (
          <Picker
            items={items}
            name={itemName}
            placeholder={t('Search a quality…')}
            extraFilter={filter}
            toolbar={<Toggle value={coreOnly} onChange={setCoreOnly} label={t('Core rulebook')} title={t('Only the SR5 core rulebook qualities')} />}
            meta={(it) =>
              `${it.stats?.maxLevels ? t('{n} karma per level (max {max})', { n: Math.abs(it.stats?.karma || 0), max: it.stats.maxLevels }) : t('{n} karma', { n: Math.abs(it.stats?.karma || 0) })} · ${it.source} p.${it.page}${it.stats?.chargenOnly ? ` · ${t('creation only')}` : ''}`
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
