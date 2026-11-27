// Wizard steps: Compétences (active skills, groups, specializations) and Contacts & connaissances.
import { Button, Select, TextInput, NumberInput, Badge, Panel, IconButton, Field } from '../../lib/ui.tsx';
import { SKILLS, SKILL_BY_ID, SKILL_GROUPS, SKILL_CATEGORIES } from '/shared/sr5.js';
import { t, attrShort, skillLabel, skillGroupLabel, skillCategoryLabel } from '../../lib/i18n.js';
import { KNOWLEDGE_TYPES, skillAllowed, rowId, LIMITS } from '/shared/chargen.js';
import { Budget, PointsKarma, StepIssues } from './common.tsx';
import { SkillRef } from '../combat/legacy-components.ts';
import type { DraftData, KnowledgeType } from '../../../shared/types.ts';
import type { StepProps } from './types.ts';

/** sr5.js SKILLS entry. */
type SkillDef = { id: string; cat: string; attr: string; group?: string; [k: string]: unknown };
type SkillRow = DraftData['skills'][number];
type KnowledgeRow = DraftData['knowledge'][number];
type ContactRow = DraftData['contacts'][number];

// ---------------------------------------------------------------------------
// Active skills
// ---------------------------------------------------------------------------
export function StepSkills({ data, update, result, issues }: StepProps) {
  const r = result;
  const freeIds: string[] = r.magic.freeSkillIds;
  const groupR: Record<string, number> = r.groups;
  const rows = [...new Set([...freeIds, ...data.skills.map((s) => s.id)])];
  const ensure = (d: DraftData, id: string): SkillRow => {
    let s = d.skills.find((x) => x.id === id);
    if (!s) {
      s = { id, points: 0, karma: 0, spec: '', specKarma: false };
      d.skills.push(s);
    }
    return s;
  };
  const setField = <K extends keyof SkillRow>(id: string, k: K, v: SkillRow[K]) => update((d) => (ensure(d, id)[k] = v));
  const remove = (id: string) => update((d) => (d.skills = d.skills.filter((s) => s.id !== id)));
  const taken = new Set(rows);
  const options = [{ value: '', label: t('+ Ajouter une compétence…') }];
  for (const cat of Object.keys(SKILL_CATEGORIES)) {
    const list = (SKILLS as SkillDef[]).filter((s) => s.cat === cat && !taken.has(s.id) && skillAllowed(data, s.id) && !(s.group && groupR[s.group] > 0));
    if (!list.length) continue;
    options.push({ value: `__${cat}`, label: `— ${skillCategoryLabel(cat)} —` });
    for (const s of list) options.push({ value: s.id, label: `${skillLabel(s)} (${attrShort(s.attr)})` });
  }
  const groupOpts = [
    { value: '', label: t('+ Ajouter un groupe…') },
    ...Object.keys(SKILL_GROUPS)
      .filter((gid) => !data.groups.some((g) => g.id === gid) && (SKILLS as SkillDef[]).filter((s) => s.group === gid).every((s) => skillAllowed(data, s.id)))
      .map((value) => ({ value, label: skillGroupLabel(value) as string })),
  ];
  const attrVal = (k: string): number => (r.final as Record<string, number>)[k] ?? 0;

  return (
    <div className="cg-step">
      <p className="cg-lead">
        {t(
          'Indice 6 maximum à la création (7 avec la qualité Aptitude). Une spécialisation coûte 1 point de compétence (ou 7 karma) et donne +2 dés. Les compétences d’un groupe montent ensemble et ne se spécialisent pas séparément.'
        )}
      </p>
      <div className="row wrap cg-budget-row">
        <Budget label={t('Points de compétences')} used={r.spent.skillPoints} total={r.budgets.skillPoints} />
        <Budget label={t('Points de groupes')} used={r.spent.groupPoints} total={r.budgets.groupPoints} />
        <Budget label={t('Karma dépensé')} used={r.karma.spent} total={r.karma.total} />
      </div>
      <Panel title={t('Compétences actives')} pad={false}>
        <div className="cg-table-wrap">
          <table className="sr cg-skill-table">
            <thead>
              <tr>
                <th>{t('Compétence')}</th>
                <th title={t('Base gratuite (priorité Magie) ou groupe')}>{t('Base')}</th>
                <th>{t('Points · Karma')}</th>
                <th>{t('Spécialisation')}</th>
                <th className="right">{t('Indice')}</th>
                <th className="right" title={t('Indice + attribut')}>
                  {t('Réserve')}
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((id) => {
                const def: SkillDef = SKILL_BY_ID[id];
                const s = data.skills.find((x) => x.id === id) || { points: 0, karma: 0, spec: '', specKarma: false };
                const free: number = freeIds.includes(id) ? r.magic.row.skills.rating : 0;
                const grp = def.group && groupR[def.group] ? groupR[def.group] : 0;
                const base = Math.max(free, grp);
                const rating = base + s.points + s.karma;
                const locked = grp > 0;
                return (
                  <tr key={id} className={rating > 6 ? 'over' : ''}>
                    <td>
                      <strong>{skillLabel(def)}</strong> <SkillRef id={def.id} /> <span className="faint small mono">{attrShort(def.attr)}</span>
                      {def.group ? (
                        <>
                          {' '}
                          <span className="faint small">· {skillGroupLabel(def.group)}</span>
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="mono small">
                      {free ? <Badge color="magenta">{t('{n} magie', { n: free })}</Badge> : grp ? <Badge color="cyan">{t('{n} groupe', { n: grp })}</Badge> : <span className="faint">—</span>}
                    </td>
                    <td>
                      <PointsKarma
                        points={s.points}
                        karma={s.karma}
                        disabled={locked}
                        maxPoints={Math.max(0, 7 - base)}
                        maxKarma={Math.max(0, 7 - base)}
                        onPoints={(v) => setField(id, 'points', v)}
                        onKarma={(v) => setField(id, 'karma', v)}
                      />
                    </td>
                    <td>
                      {locked ? (
                        <span className="faint small">—</span>
                      ) : (
                        <span className="row gap-s">
                          <TextInput live className="cg-spec" value={s.spec} placeholder={t('ex. Semi-automatiques')} onChange={(v) => setField(id, 'spec', v)} />
                          {s.spec && (
                            <label className="small muted cg-nowrap" title={t('Payer la spécialisation 7 karma au lieu d’1 point')}>
                              <input type="checkbox" checked={s.specKarma} onChange={(e) => setField(id, 'specKarma', e.target.checked)} /> 7 K
                            </label>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="num-cell">
                      <strong>{rating}</strong>
                    </td>
                    <td className="num-cell cyan">
                      {rating + attrVal(def.attr)}
                      {s.spec ? (
                        <>
                          {' '}
                          <span className="faint small">({rating + attrVal(def.attr) + 2})</span>
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td>{!free && <IconButton icon="✕" title={t('Retirer')} onClick={() => remove(id)} />}</td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="muted center">
                    {t('Aucune compétence : ajoute-en avec le menu ci-dessous.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="cg-pad">
          <select
            className="input cg-add-select"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = '';
              if (v && !v.startsWith('__')) update((d) => d.skills.push({ id: v, points: 1, karma: 0, spec: '', specKarma: false }));
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.value.startsWith('__')}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </Panel>

      <Panel title={t('Groupes de compétences')} pad={false} className="cg-mt">
        <table className="sr cg-skill-table">
          <tbody>
            {data.groups.map((g) => {
              const free: number = g.id === r.magic.freeGroupId ? r.magic.row?.group?.rating || 0 : 0;
              const rating = free + g.points + g.karma;
              return (
                <tr key={g.id}>
                  <td>
                    <strong>{skillGroupLabel(g.id)}</strong>
                    <div className="small faint">
                      {(SKILLS as SkillDef[])
                        .filter((s) => s.group === g.id)
                        .map((s) => skillLabel(s))
                        .join(', ')}
                    </div>
                  </td>
                  <td className="mono small">{free ? <Badge color="magenta">{t('{n} magie', { n: free })}</Badge> : ''}</td>
                  <td>
                    <PointsKarma
                      points={g.points}
                      karma={g.karma}
                      maxPoints={6}
                      maxKarma={6}
                      onPoints={(v) =>
                        update((d) => {
                          const x = d.groups.find((y) => y.id === g.id);
                          if (x) x.points = v;
                        })
                      }
                      onKarma={(v) =>
                        update((d) => {
                          const x = d.groups.find((y) => y.id === g.id);
                          if (x) x.karma = v;
                        })
                      }
                    />
                  </td>
                  <td className="num-cell">
                    <strong>{rating}</strong>
                  </td>
                  <td>{!free && <IconButton icon="✕" title={t('Retirer')} onClick={() => update((d) => (d.groups = d.groups.filter((x) => x.id !== g.id)))} />}</td>
                </tr>
              );
            })}
            {r.magic.freeGroupId && !data.groups.some((g) => g.id === r.magic.freeGroupId) && (
              <tr>
                <td>
                  <strong>{skillGroupLabel(r.magic.freeGroupId)}</strong>
                </td>
                <td>
                  <Badge color="magenta">{t('{n} magie', { n: r.magic.row?.group?.rating })}</Badge>
                </td>
                <td>
                  <Button small variant="ghost" onClick={() => update((d) => d.groups.push({ id: r.magic.freeGroupId, points: 0, karma: 0 }))}>
                    {t('Augmenter')}
                  </Button>
                </td>
                <td className="num-cell">
                  <strong>{r.magic.row?.group?.rating}</strong>
                </td>
                <td></td>
              </tr>
            )}
            {!data.groups.length && !r.magic.freeGroupId && (
              <tr>
                <td colSpan={5} className="muted center">
                  {t('Un groupe coûte 1 point de groupe par indice pour toutes ses compétences.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="cg-pad">
          <Select className="cg-add-select" value="" options={groupOpts} onChange={(v) => v && update((d) => d.groups.push({ id: v, points: 1, karma: 0 }))} />
        </div>
      </Panel>
      <StepIssues issues={issues} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge + contacts
// ---------------------------------------------------------------------------
const ktypes = () => (Object.entries(KNOWLEDGE_TYPES) as Array<[KnowledgeType, string]>).map(([value, label]) => ({ value, label: t(label) as string }));

export function StepContacts({ data, update, result, issues }: StepProps) {
  const r = result;
  const setK = <K extends keyof KnowledgeRow>(id: string, k: K, v: KnowledgeRow[K]) =>
    update((d) => {
      const x = d.knowledge.find((y) => y.id === id);
      if (x) x[k] = v;
    });
  const setC = <K extends keyof ContactRow>(id: string, k: K, v: ContactRow[K]) =>
    update((d) => {
      const x = d.contacts.find((y) => y.id === id);
      if (x) x[k] = v;
    });
  return (
    <div className="cg-step">
      <div className="row wrap cg-budget-row">
        <Budget label={t('Points de connaissances')} used={r.spent.knowledgePoints} total={r.budgets.knowledgePoints} title={t('(Intuition + Logique) × 2')} />
        <Budget label={t('Karma de contacts')} used={r.spent.contactKarma} total={r.budgets.contactKarma} title={t('Charisme × 3 gratuits, puis karma général')} />
        <Budget label={t('Karma dépensé')} used={r.karma.spent} total={r.karma.total} />
      </div>
      <Panel
        title={t('Connaissances & langues')}
        pad={false}
        actions={
          <>
            <Button small onClick={() => update((d) => d.knowledge.push({ id: rowId('k'), name: '', type: 'language', points: 0, karma: 0, native: true } as KnowledgeRow))}>
              + {t('Langue maternelle')}
            </Button>
            <Button small onClick={() => update((d) => d.knowledge.push({ id: rowId('k'), name: '', type: 'street', points: 1, karma: 0 } as KnowledgeRow))}>
              + {t('Connaissance')}
            </Button>
          </>
        }
      >
        <div className="cg-table-wrap">
          <table className="sr cg-skill-table">
            <thead>
              <tr>
                <th>{t('Nom')}</th>
                <th>{t('Type')}</th>
                <th>{t('Points · Karma')}</th>
                <th>{t('Spécialisation')}</th>
                <th className="right">{t('Indice')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.knowledge.map((k) => (
                <tr key={k.id}>
                  <td>
                    <TextInput live value={k.name} placeholder={k.native ? t('ex. Français') : t('ex. Gangs de Seattle')} onChange={(v) => setK(k.id, 'name', v)} />
                  </td>
                  <td>{k.native ? <Badge color="cyan">{t('Langue maternelle')}</Badge> : <Select value={k.type} options={ktypes()} onChange={(v) => setK(k.id, 'type', v)} />}</td>
                  <td>
                    {k.native ? (
                      <span className="faint small">{t('gratuite')}</span>
                    ) : (
                      <PointsKarma
                        points={k.points}
                        karma={k.karma}
                        maxPoints={LIMITS.knowledgeMax}
                        maxKarma={LIMITS.knowledgeMax}
                        onPoints={(v) => setK(k.id, 'points', v)}
                        onKarma={(v) => setK(k.id, 'karma', v)}
                      />
                    )}
                  </td>
                  <td>{k.native ? '' : <TextInput live className="cg-spec" value={k.spec} placeholder={t('1 point')} onChange={(v) => setK(k.id, 'spec', v)} />}</td>
                  <td className="num-cell">{k.native ? 'N' : k.points + k.karma}</td>
                  <td>
                    <IconButton icon="✕" title={t('Retirer')} onClick={() => update((d) => (d.knowledge = d.knowledge.filter((x) => x.id !== k.id)))} />
                  </td>
                </tr>
              ))}
              {!data.knowledge.length && (
                <tr>
                  <td colSpan={6} className="muted center">
                    {t('Commence par la langue maternelle (gratuite), puis ce que ton runner connaît : rues, métiers, passions, langues.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={t('Contacts')}
        pad={false}
        className="cg-mt"
        actions={
          <Button small onClick={() => update((d) => d.contacts.push({ id: rowId('c'), name: '', connection: 2, loyalty: 2, notes: '' }))}>
            + {t('Contact')}
          </Button>
        }
      >
        <div className="cg-table-wrap">
          <table className="sr cg-skill-table">
            <thead>
              <tr>
                <th>{t('Nom & rôle')}</th>
                <th title={t('Influence du contact (1-12)')}>{t('contact::Influence')}</th>
                <th title={t('Ce qu’il ferait pour toi (1-6)')}>{t('Loyauté')}</th>
                <th>{t('Notes')}</th>
                <th className="right">{t('Karma')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <TextInput live value={c.name} placeholder={t('ex. Perrine Cabana (fixer)')} onChange={(v) => setC(c.id, 'name', v)} />
                  </td>
                  <td>
                    <NumberInput small value={c.connection} min={1} max={LIMITS.contactConnectionMax} onChange={(v) => setC(c.id, 'connection', v)} />
                  </td>
                  <td>
                    <NumberInput small value={c.loyalty} min={1} max={LIMITS.contactLoyaltyMax} onChange={(v) => setC(c.id, 'loyalty', v)} />
                  </td>
                  <td>
                    <TextInput live value={c.notes} placeholder={t('Comment vous vous connaissez')} onChange={(v) => setC(c.id, 'notes', v)} />
                  </td>
                  <td className="num-cell">{c.connection + c.loyalty}</td>
                  <td>
                    <IconButton icon="✕" title={t('Retirer')} onClick={() => update((d) => (d.contacts = d.contacts.filter((x) => x.id !== c.id)))} />
                  </td>
                </tr>
              ))}
              {!data.contacts.length && (
                <tr>
                  <td colSpan={6} className="muted center">
                    {t('Chaque contact coûte Influence + Loyauté en karma ; Charisme × 3 sont offerts.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t('Mot pour le MJ')} className="cg-mt">
        <Field label={t('Questions, demandes particulières, liens avec l’équipe…')}>
          <TextInput live multiline rows={3} value={data.notes} onChange={(v) => update((d) => (d.notes = v))} />
        </Field>
      </Panel>
      <StepIssues issues={issues} />
    </div>
  );
}
