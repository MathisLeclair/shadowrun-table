// Wizard steps: Concept, Priorités, Métatype, Attributs.
import { useState, type ChangeEvent } from 'react';
import { Button, Field, TextInput, Badge, Panel } from '../../lib/ui.tsx';
import { upload } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { METATYPES } from '/shared/sr5.ts';
import { t, tk, attrLabel, attrShort, metatypeLabel } from '../../lib/i18n.ts';
import {
  LETTERS,
  COLUMNS,
  COLUMN_LABELS,
  METATYPE_PRIORITY,
  METATYPE_IDS,
  METATYPE_MIN,
  METATYPE_TRAITS,
  ATTRIBUTE_POINTS,
  PHYSICAL,
  MENTAL,
  priorityText,
  magicOptions,
  magicOptionText,
  karmaSteps,
  SKILL_POINTS,
  RESOURCES,
} from '/shared/chargen.ts';
import { Budget, PointsKarma, StepIssues, nuyen, i18n } from './common.tsx';
import { RuleRef } from '../combat/legacy-components.ts';
import type { AttrKey, DraftData, PriorityColumn, PriorityLetter } from '../../../shared/types.ts';
import type { DraftUpdate, StepProps } from './types.ts';

// ---------------------------------------------------------------------------
// Concept
// ---------------------------------------------------------------------------
type ConceptKey = keyof DraftData['concept'];
export function StepConcept({ data, update, issues, game }: StepProps) {
  const c = data.concept;
  const [busy, setBusy] = useState(false);
  const set = (k: ConceptKey) => (v: string) => update((d) => (d.concept[k] = v));
  const pickPortrait = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast(t('Choisis une image (png, jpg, webp)'), 'warn');
    setBusy(true);
    try {
      const res = await upload(file);
      update((d) => (d.concept.portrait = res.url));
    } catch (e) {
      toast((e as Error).message || t('Envoi impossible'), 'error');
    }
    setBusy(false);
  };
  return (
    <div className="cg-step">
      <p className="cg-lead">
        {t('Qui est ton runner ? Un nom de rue, une idée forte en une phrase et quelques lignes d’histoire suffisent pour commencer : tout reste modifiable jusqu’à l’envoi au MJ.')}
      </p>
      <div className="cg-concept">
        <div className="cg-portrait-box">
          <div className="cg-portrait" style={c.portrait ? { backgroundImage: `url("${c.portrait.replace(/"/g, '%22')}")`, borderColor: c.color } : { borderColor: c.color }}>
            {!c.portrait && <span>{(c.alias || c.name || '?').slice(0, 2).toUpperCase()}</span>}
          </div>
          <label className="btn btn-sm" title={t('Image png, jpg ou webp')}>
            {busy ? t('Envoi…') : c.portrait ? t('Changer le portrait') : t('Ajouter un portrait')}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={pickPortrait} />
          </label>
          {c.portrait && (
            <Button small variant="ghost" onClick={() => update((d) => (d.concept.portrait = ''))}>
              {t('Retirer')}
            </Button>
          )}
          <Field label={t('Couleur du pion')}>
            <input type="color" className="cg-color" value={c.color} onChange={(e) => update((d) => (d.concept.color = e.target.value))} />
          </Field>
        </div>
        <div className="col grow">
          <div className="grid-2">
            <Field label={t('Nom de rue')} hint={t('Affiché sur la carte et dans le journal')}>
              <TextInput live value={c.alias} placeholder={t('ex. Rouille')} onChange={set('alias')} />
            </Field>
            <Field label={t('Vrai nom (SIN)')}>
              <TextInput live value={c.name} placeholder={t('ex. Marc Delorme')} onChange={set('name')} />
            </Field>
          </div>
          <Field label={t('Concept')} hint={t('Une phrase : rôle dans l’équipe + ce qui le rend unique')}>
            <TextInput live value={c.concept} placeholder={t('ex. Ancien ganger ork devenu samouraï des rues, loyal jusqu’à la bêtise')} onChange={set('concept')} />
          </Field>
          <div className="grid-3">
            <Field label={t('Genre')}>
              <TextInput live value={c.gender} onChange={set('gender')} />
            </Field>
            <Field label={t('Âge')}>
              <TextInput live value={c.age} onChange={set('age')} />
            </Field>
            <Field label={t('Joueur')}>
              <TextInput live value={c.player} placeholder={game.me.role === 'gm' ? '' : game.me.name} onChange={set('player')} />
            </Field>
          </div>
          <Field label={t('bio::Historique')} hint={t('Markdown accepté. Origine, ce qui l’a poussé dans les Ombres, ses dettes, ses rêves…')}>
            <TextInput live multiline rows={8} value={c.background} onChange={set('background')} />
          </Field>
        </div>
      </div>
      <StepIssues issues={issues} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------
type Priorities = Record<PriorityColumn, PriorityLetter>;
const PRESETS: Array<{ label: string; p: Priorities }> = [
  { label: tk('Samouraï des rues'), p: { metatype: 'C', attributes: 'A', magic: 'E', skills: 'B', resources: 'D' } },
  { label: tk('Mage'), p: { metatype: 'D', attributes: 'B', magic: 'A', skills: 'C', resources: 'E' } },
  { label: tk('Adepte'), p: { metatype: 'C', attributes: 'A', magic: 'B', skills: 'D', resources: 'E' } },
  { label: tk('Decker'), p: { metatype: 'D', attributes: 'B', magic: 'E', skills: 'C', resources: 'A' } },
  { label: tk('Face'), p: { metatype: 'B', attributes: 'A', magic: 'E', skills: 'C', resources: 'D' } },
  { label: tk('Technomancien'), p: { metatype: 'D', attributes: 'B', magic: 'A', skills: 'C', resources: 'E' } },
];
const COLS = COLUMNS as PriorityColumn[];
const LETTER_LIST = LETTERS as Exclude<PriorityLetter, ''>[];

export function StepPriorities({ data, update, issues }: StepProps) {
  const P = data.priorities;
  const assign = (col: PriorityColumn, l: PriorityLetter) =>
    update((d) => {
      const prev = d.priorities[col];
      const other = COLS.find((k) => k !== col && d.priorities[k] === l);
      d.priorities[col] = prev === l ? '' : l;
      if (other && prev !== l) d.priorities[other] = prev || '';
    });
  const usedBy = (l: PriorityLetter) => COLS.find((k) => P[k] === l);
  return (
    <div className="cg-step">
      <p className="cg-lead">
        {t('Chaque lettre de A (le mieux) à E ne sert qu’une fois. Clique une case pour donner cette priorité à la colonne : si la lettre était déjà prise, les deux colonnes échangent leurs lettres.')}
      </p>
      <div className="row wrap gap-s cg-presets">
        <span className="small muted">
          {t('Table des priorités')} <RuleRef rule="priorityTable" />
        </span>
        <span className="small muted">{t('Répartitions types :')}</span>
        {PRESETS.map((pr) => (
          <Button key={pr.label} small variant="ghost" onClick={() => update((d) => (d.priorities = { ...pr.p }))}>
            {t(pr.label)}
          </Button>
        ))}
      </div>
      <div className="cg-prio-wrap">
        <table className="cg-prio">
          <thead>
            <tr>
              <th></th>
              {COLS.map((col) => (
                <th key={col}>{t(COLUMN_LABELS[col])}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LETTER_LIST.map((l) => (
              <tr key={l}>
                <th className={'cg-prio-letter' + (usedBy(l) ? ' used' : '')}>{l}</th>
                {COLS.map((col) => (
                  <td key={col} className={'cg-prio-cell' + (P[col] === l ? ' on' : '') + (P[col] && P[col] !== l ? ' dim' : '')} onClick={() => assign(col, l)}>
                    {priorityText(col, l, i18n())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cg-explain">
        {COLS.map((col) => (
          <div key={col} className="cg-explain-row">
            <span className={'cg-letter' + (P[col] ? '' : ' empty')}>{P[col] || '?'}</span>
            <div className="grow">
              <strong>{t(COLUMN_LABELS[col])}</strong>
              <div className="small muted">{explain(col, P[col])}</div>
            </div>
          </div>
        ))}
      </div>
      <StepIssues issues={issues} />
    </div>
  );
}

function explain(col: PriorityColumn, l: PriorityLetter): string {
  if (!l) return t('Pas encore de priorité.');
  if (col === 'metatype') {
    const row: Record<string, number> = METATYPE_PRIORITY[l];
    return t('Métatypes possibles et points d’attributs spéciaux (Chance, Magie, Résonance) : {list}.', {
      list: Object.entries(row)
        .map(([m, n]) => `${metatypeLabel(m)} ${n}`)
        .join(', '),
    });
  }
  if (col === 'attributes') return t('{n} points à répartir dans les attributs physiques et mentaux.', { n: ATTRIBUTE_POINTS[l] });
  if (col === 'skills') return t('{skills} points de compétences et {groups} points de groupes de compétences.', { skills: SKILL_POINTS[l][0], groups: SKILL_POINTS[l][1] });
  if (col === 'resources') return t('{nuyen} pour l’équipement, le cyberware et le train de vie (5 000¥ maximum conservés).', { nuyen: nuyen(RESOURCES[l]) });
  const opts = (magicOptions(l) as Array<{ type: string }>).filter((o) => o.type !== 'none');
  if (!opts.length) return t('Profane : ni magie ni résonance.');
  return opts.map((o) => magicOptionText(o, i18n())).join(' — ');
}

// ---------------------------------------------------------------------------
// Metatype
// ---------------------------------------------------------------------------
const CORE_KEYS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];
export function StepMetatype({ data, update, issues }: StepProps) {
  const row: Record<string, number> | undefined = data.priorities.metatype ? METATYPE_PRIORITY[data.priorities.metatype] : undefined;
  return (
    <div className="cg-step">
      {!row && <div className="cg-note warn">{t('Attribue d’abord une priorité à la colonne Métatype.')}</div>}
      <div className="cg-meta-grid">
        {(METATYPE_IDS as DraftData['metatype'][]).map((m) => {
          const pts = row ? row[m] : undefined;
          const avail = pts !== undefined;
          const on = data.metatype === m;
          return (
            <div key={m} className={'cg-meta card' + (on ? ' on' : '') + (avail ? ' clickable' : ' off')} onClick={() => avail && update((d) => (d.metatype = m))}>
              <div className="spread row">
                <h4>{metatypeLabel(m)}</h4>
                {avail ? <Badge color="cyan">{pts === 1 ? t('1 point spécial') : t('{n} points spéciaux', { n: pts })}</Badge> : <Badge>{t('Indisponible')}</Badge>}
              </div>
              <table className="cg-meta-attrs">
                <tbody>
                  <tr>
                    {CORE_KEYS.map((k) => (
                      <th key={k}>{attrShort(k)}</th>
                    ))}
                  </tr>
                  <tr>
                    {CORE_KEYS.map((k) => (
                      <td key={k}>
                        {(METATYPE_MIN as Record<string, Record<string, number>>)[m][k]}–{(METATYPES as Record<string, { max: Record<string, number> }>)[m].max[k]}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <div className="small muted">
                {METATYPE_TRAITS[m].length ? (METATYPE_TRAITS[m] as string[]).map((x) => t(x)).join(' · ') : t('Polyvalent : Chance jusqu’à 7, aucune restriction.')}
              </div>
            </div>
          );
        })}
      </div>
      <StepIssues issues={issues} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------
/** compute() attribute row. */
interface AttrState {
  min: number;
  max: number;
  points: number;
  karma: number;
  value: number;
  inactive?: boolean;
}
function AttrRow({ k, a, update, special }: { k: AttrKey; a: AttrState | undefined; update: DraftUpdate; special?: boolean }) {
  if (!a || a.inactive) return null;
  const natMax = a.max;
  const setPts = (v: number) => update((d) => (d.attributes[k] = Math.max(0, v)));
  const setK = (v: number) => update((d) => (d.attrKarma[k] = Math.max(0, v)));
  const kCost = karmaSteps(a.min + a.points, a.value, 5);
  const pct = natMax > 0 ? Math.min(100, (a.value / natMax) * 100) : 0;
  return (
    <tr className={a.value > natMax ? 'over' : a.value === natMax ? 'max' : ''}>
      <td>
        <strong>{attrLabel(k)}</strong> <span className="faint small mono">{attrShort(k)}</span>
      </td>
      <td className="mono small muted">
        {a.min}–{natMax}
      </td>
      <td>
        <PointsKarma points={a.points} karma={a.karma} onPoints={setPts} onKarma={setK} maxPoints={Math.max(0, natMax - a.min)} maxKarma={Math.max(0, natMax - a.min)} />
      </td>
      <td className="cg-attr-val">
        <span className="cg-attr-num">{a.value}</span>
        <span className="cg-attr-bar">
          <span style={{ width: `${pct}%` }}></span>
        </span>
        {a.value >= natMax && <Badge color={a.value > natMax ? 'red' : 'amber'}>{t('max')}</Badge>}
      </td>
      <td className="mono small">
        {kCost ? <span className="magenta">{kCost} K</span> : <span className="faint">—</span>}
        {special ? (
          <>
            {' '}
            <span className="faint">{t('spécial')}</span>
          </>
        ) : (
          ''
        )}
      </td>
    </tr>
  );
}

export function StepAttributes({ update, result, issues }: StepProps) {
  const r = result;
  const A = r.attrs as Record<AttrKey, AttrState>;
  return (
    <div className="cg-step">
      <p className="cg-lead">
        {t('Les points s’ajoutent au minimum du métatype. Un seul attribut physique ou mental peut atteindre son maximum naturel. La colonne K achète des indices supplémentaires en karma (nouvel indice × 5).')}
      </p>
      <div className="row wrap cg-budget-row">
        <Budget label={t('Points d’attributs')} used={r.spent.attrPoints} total={r.budgets.attrPoints} />
        <Budget label={t('Points spéciaux')} used={r.spent.specialPoints} total={r.budgets.specialPoints} title={t('Chance, Magie, Résonance (priorité Métatype)')} />
        <Budget label={t('Karma dépensé')} used={r.karma.spent} total={r.karma.total} title={t('25 karma de départ + qualités négatives')} />
      </div>
      <div className="grid-2">
        <Panel title={t('Physiques')} pad={false}>
          <table className="sr cg-attr-table">
            <tbody>
              {(PHYSICAL as AttrKey[]).map((k) => (
                <AttrRow key={k} k={k} a={A[k]} update={update} />
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={t('Mentaux')} pad={false}>
          <table className="sr cg-attr-table">
            <tbody>
              {(MENTAL as AttrKey[]).map((k) => (
                <AttrRow key={k} k={k} a={A[k]} update={update} />
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title={t('Spéciaux')} pad={false} className="cg-mt">
        <table className="sr cg-attr-table">
          <tbody>
            <AttrRow k="EDG" a={A.EDG} update={update} special />
            <AttrRow k="MAG" a={A.MAG} update={update} special />
            <AttrRow k="RES" a={A.RES} update={update} special />
          </tbody>
        </table>
        {A.MAG.inactive && A.RES.inactive && <div className="small faint cg-pad">{t('Magie et Résonance : choisis un type magique (étape Magie / Résonance) pour en disposer.')}</div>}
      </Panel>
      <StepIssues issues={issues} />
    </div>
  );
}
