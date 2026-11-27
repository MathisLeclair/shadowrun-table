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
import type { AttrKey, DraftData, PriorityColumn, PriorityLetter } from '../../../shared/types.ts';
import type { DraftUpdate, StepProps } from './types.ts';
import { RuleRef } from '../books/BookRef.tsx';

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
    if (!/^image\//.test(file.type)) return toast(t('Pick an image (png, jpg, webp)'), 'warn');
    setBusy(true);
    try {
      const res = await upload(file);
      update((d) => (d.concept.portrait = res.url));
    } catch (e) {
      toast((e as Error).message || t('Upload failed'), 'error');
    }
    setBusy(false);
  };
  return (
    <div className="cg-step">
      <p className="cg-lead">
        {t('Who is your runner? A street name, a strong one-sentence idea and a few lines of background are enough to start: everything can be changed until you send it to the GM.')}
      </p>
      <div className="cg-concept">
        <div className="cg-portrait-box">
          <div className="cg-portrait" style={c.portrait ? { backgroundImage: `url("${c.portrait.replace(/"/g, '%22')}")`, borderColor: c.color } : { borderColor: c.color }}>
            {!c.portrait && <span>{(c.alias || c.name || '?').slice(0, 2).toUpperCase()}</span>}
          </div>
          <label className="btn btn-sm" title={t('png, jpg or webp image')}>
            {busy ? t('Uploading…') : c.portrait ? t('Change the portrait') : t('Add a portrait')}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={pickPortrait} />
          </label>
          {c.portrait && (
            <Button small variant="ghost" onClick={() => update((d) => (d.concept.portrait = ''))}>
              {t('Remove')}
            </Button>
          )}
          <Field label={t('Token color')}>
            <input type="color" className="cg-color" value={c.color} onChange={(e) => update((d) => (d.concept.color = e.target.value))} />
          </Field>
        </div>
        <div className="col grow">
          <div className="grid-2">
            <Field label={t('Street name')} hint={t('Shown on the map and in the log')}>
              <TextInput live value={c.alias} placeholder={t('e.g. Rust')} onChange={set('alias')} />
            </Field>
            <Field label={t('Real name (SIN)')}>
              <TextInput live value={c.name} placeholder={t('e.g. Marc Delorme')} onChange={set('name')} />
            </Field>
          </div>
          <Field label={t('Concept')} hint={t('One sentence: role in the team + what makes them unique')}>
            <TextInput live value={c.concept} placeholder={t('e.g. Former ork ganger turned street samurai, loyal to a fault')} onChange={set('concept')} />
          </Field>
          <div className="grid-3">
            <Field label={t('Gender')}>
              <TextInput live value={c.gender} onChange={set('gender')} />
            </Field>
            <Field label={t('Age')}>
              <TextInput live value={c.age} onChange={set('age')} />
            </Field>
            <Field label={t('Player')}>
              <TextInput live value={c.player} placeholder={game.me.role === 'gm' ? '' : game.me.name} onChange={set('player')} />
            </Field>
          </div>
          <Field label={t('bio::Background')} hint={t('Markdown accepted. Origins, what pushed them into the shadows, their debts, their dreams…')}>
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
  { label: tk('Street samurai'), p: { metatype: 'C', attributes: 'A', magic: 'E', skills: 'B', resources: 'D' } },
  { label: tk('Mage'), p: { metatype: 'D', attributes: 'B', magic: 'A', skills: 'C', resources: 'E' } },
  { label: tk('Adept'), p: { metatype: 'C', attributes: 'A', magic: 'B', skills: 'D', resources: 'E' } },
  { label: tk('Decker'), p: { metatype: 'D', attributes: 'B', magic: 'E', skills: 'C', resources: 'A' } },
  { label: tk('Face'), p: { metatype: 'B', attributes: 'A', magic: 'E', skills: 'C', resources: 'D' } },
  { label: tk('Technomancer'), p: { metatype: 'D', attributes: 'B', magic: 'A', skills: 'C', resources: 'E' } },
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
        {t('Each letter from A (best) to E is used only once. Click a cell to give that priority to the column: if the letter was already taken, the two columns swap letters.')}
      </p>
      <div className="row wrap gap-s cg-presets">
        <span className="small muted">
          {t('Priority table')} <RuleRef rule="priorityTable" />
        </span>
        <span className="small muted">{t('Typical builds:')}</span>
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
  if (!l) return t('No priority yet.');
  if (col === 'metatype') {
    const row = METATYPE_PRIORITY[l];
    return t('Available metatypes and special attribute points (Edge, Magic, Resonance): {list}.', {
      list: Object.entries(row)
        .map(([m, n]) => `${metatypeLabel(m)} ${n}`)
        .join(', '),
    });
  }
  if (col === 'attributes') return t('{n} points to spread over physical and mental attributes.', { n: ATTRIBUTE_POINTS[l] });
  if (col === 'skills') return t('{skills} skill points and {groups} skill group points.', { skills: SKILL_POINTS[l][0], groups: SKILL_POINTS[l][1] });
  if (col === 'resources') return t('{nuyen} for gear, cyberware and lifestyle (5,000¥ kept at most).', { nuyen: nuyen(RESOURCES[l]) });
  const opts = magicOptions(l).filter((o) => o.type !== 'none');
  if (!opts.length) return t('Mundane: neither magic nor resonance.');
  return opts.map((o) => magicOptionText(o, i18n())).join(' — ');
}

// ---------------------------------------------------------------------------
// Metatype
// ---------------------------------------------------------------------------
const CORE_KEYS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];
export function StepMetatype({ data, update, issues }: StepProps) {
  const row = data.priorities.metatype ? METATYPE_PRIORITY[data.priorities.metatype] : undefined;
  return (
    <div className="cg-step">
      {!row && <div className="cg-note warn">{t('Assign a priority to the Metatype column first.')}</div>}
      <div className="cg-meta-grid">
        {(METATYPE_IDS as DraftData['metatype'][]).map((m) => {
          const pts = row ? row[m] : undefined;
          const avail = pts !== undefined;
          const on = data.metatype === m;
          return (
            <div key={m} className={'cg-meta card' + (on ? ' on' : '') + (avail ? ' clickable' : ' off')} onClick={() => avail && update((d) => (d.metatype = m))}>
              <div className="spread row">
                <h4>{metatypeLabel(m)}</h4>
                {avail ? <Badge color="cyan">{pts === 1 ? t('1 special point') : t('{n} special points', { n: pts })}</Badge> : <Badge>{t('Unavailable')}</Badge>}
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
                {METATYPE_TRAITS[m].length ? (METATYPE_TRAITS[m] as string[]).map((x) => t(x)).join(' · ') : t('Versatile: Edge up to 7, no restrictions.')}
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
            <span className="faint">{t('special')}</span>
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
        {t('Points are added to the metatype minimum. Only one physical or mental attribute may reach its natural maximum. The K column buys extra ratings with karma (new rating × 5).')}
      </p>
      <div className="row wrap cg-budget-row">
        <Budget label={t('Attribute points')} used={r.spent.attrPoints} total={r.budgets.attrPoints} />
        <Budget label={t('Special points')} used={r.spent.specialPoints} total={r.budgets.specialPoints} title={t('Edge, Magic, Resonance (Metatype priority)')} />
        <Budget label={t('Karma spent')} used={r.karma.spent} total={r.karma.total} title={t('25 starting karma + negative qualities')} />
      </div>
      <div className="grid-2">
        <Panel title={t('pl::Physical')} pad={false}>
          <table className="sr cg-attr-table">
            <tbody>
              {(PHYSICAL as AttrKey[]).map((k) => (
                <AttrRow key={k} k={k} a={A[k]} update={update} />
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={t('Mental')} pad={false}>
          <table className="sr cg-attr-table">
            <tbody>
              {(MENTAL as AttrKey[]).map((k) => (
                <AttrRow key={k} k={k} a={A[k]} update={update} />
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title={t('pl::Special')} pad={false} className="cg-mt">
        <table className="sr cg-attr-table">
          <tbody>
            <AttrRow k="EDG" a={A.EDG} update={update} special />
            <AttrRow k="MAG" a={A.MAG} update={update} special />
            <AttrRow k="RES" a={A.RES} update={update} special />
          </tbody>
        </table>
        {A.MAG.inactive && A.RES.inactive && <div className="small faint cg-pad">{t('Magic and Resonance: pick a magic type (Magic / Resonance step) to get them.')}</div>}
      </Panel>
      <StepIssues issues={issues} />
    </div>
  );
}
