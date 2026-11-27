// Sheet tab « Compétences »: active skills grouped by category, knowledge skills. Click a skill to roll.
import { useState } from 'react';
import { Button, NumberInput, TextInput, Select, Toggle, IconButton, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { SKILLS, SKILL_BY_ID, SKILL_CATEGORIES, attr, skillPool } from '/shared/sr5.ts';
import { t, attrShort, skillLabel, skillGroupLabel, skillCategoryLabel, getLang, compare } from '../../lib/i18n.ts';
import { ListEditor } from './editors.tsx';
import { KNOWLEDGE_TYPES, knowledgeAttr } from './sheet-data.ts';
import { skillName } from './common.tsx';
import { SkillRef, RuleRef } from './ext.ts';
import type { AttrKey } from '../../../shared/types.ts';
import type { SheetCtx, SheetKnowledge, SheetSkill, SkillDef } from './types.ts';

const attrOptions = () => ['AGI', 'BOD', 'REA', 'STR', 'CHA', 'INT', 'LOG', 'WIL', 'MAG', 'RES'].map((k) => ({ value: k, label: attrShort(k) }));

interface SkillRowProps {
  s: SheetCtx;
  sk?: SheetSkill;
  def?: SkillDef;
  ghost?: boolean;
}
function SkillRow({ s, sk, def, ghost }: SkillRowProps) {
  const { actor, edit } = s;
  const at = sk?.attr || def?.attr || 'AGI';
  const skillId = (sk?.id || def?.id) as string;
  const res = skillPool(actor, skillId);
  const name = skillName(sk, def?.id);
  const up = (patch: Partial<SheetSkill>) => send('actor/updateItem', { actorId: actor.id, list: 'skills', itemId: sk?.id, patch }).catch(() => {});
  const remove = async () => {
    if (await confirmAction(t('Retirer la compétence {name} ?', { name }))) send('actor/removeItem', { actorId: actor.id, list: 'skills', itemId: sk?.id }).catch(() => {});
  };
  if (edit && sk) {
    return <tr>
      <td><b>{name}</b>{sk.notes ? <>{' '}<span className="badge badge-amber" title={sk.notes}>!</span></> : null}</td>
      <td><Select value={at} options={attrOptions()} onChange={(v) => up({ attr: v as AttrKey })} /></td>
      <td><NumberInput small value={sk.rating || 0} min={0} max={13} onChange={(v) => up({ rating: v })} /></td>
      <td><TextInput value={sk.spec || ''} placeholder={t('Spécialisation')} onChange={(v) => up({ spec: v })} /></td>
      <td className="num-cell">{res.pool}</td>
      <td><IconButton icon="✕" title={t('Retirer')} onClick={remove} /></td>
    </tr>;
  }
  const disabled = res.impossible;
  return <tr className={'sh-skill' + (ghost ? ' ghost' : '') + (disabled ? ' disabled' : '')} onClick={disabled ? undefined : () => s.roll({ skillId })} title={disabled ? t('Ne peut pas être utilisée sans formation') : t('Lancer {name}', { name })}>
    <td>
      <span className="sh-skill-name">{name}</span>
      {' '}
      <SkillRef id={skillId} />
      {def?.group ? <>{' '}<span className="faint small">{skillGroupLabel(def.group)}</span></> : null}{sk?.notes ? <>{' '}<span className="badge badge-amber" title={sk.notes}>{sk.notes}</span></> : null}
    </td>
    <td className="muted small">{attrShort(at)}{' '}{attr(actor, at)}</td>
    <td className="num-cell">{ghost ? '—' : sk?.rating}</td>
    <td className="small">{sk?.spec ? <span className="badge badge-cyan" title={t('+2 dés avec la spécialisation')}>{sk.spec}</span> : null}</td>
    <td className="num-cell sh-pool">{disabled ? '—' : res.pool}{sk?.spec && !ghost ? <span className="faint"> ({res.pool + 2})</span> : null}</td>
    <td className="sh-roll-cell">{disabled ? null : <span className="sh-die-btn" aria-hidden="true">⚄</span>}</td>
  </tr>;
}

function AddSkill({ s }: { s: SheetCtx }) {
  const { actor } = s;
  const [id, setId] = useState('');
  const [rating, setRating] = useState(1);
  const [custom, setCustom] = useState('');
  const [customAttr, setCustomAttr] = useState('LOG');
  const have = new Set((actor.skills || []).map((x) => x.id));
  const choices = SKILLS.filter((x) => !have.has(x.id)).map((x) => ({ value: x.id, label: `${skillLabel(x.id)} (${attrShort(x.attr)})` }));
  if (getLang() !== 'fr') choices.sort((a, b) => compare(a.label, b.label)); // French list keeps its curated order
  const options = [{ value: '', label: t('Choisir une compétence…') }, ...choices];
  const add = (item: Partial<SheetSkill>) => send('actor/addItem', { actorId: actor.id, list: 'skills', item }).then(() => { setId(''); setCustom(''); }).catch(() => {});
  return <div className="sh-add-skill row wrap">
    <Select value={id} options={options} onChange={setId} style={{ maxWidth: '260px' }} />
    <NumberInput small value={rating} min={0} max={13} onChange={setRating} />
    <Button small variant="primary" disabled={!id} onClick={() => add({ id, rating })}>{t('Ajouter')}</Button>
    <span className="faint">{t('ou')}</span>
    <TextInput live value={custom} placeholder={t('Compétence personnalisée')} onChange={setCustom} style={{ maxWidth: '200px' }} />
    <Select value={customAttr} options={attrOptions()} onChange={setCustomAttr} style={{ width: 'auto' }} />
    <Button small disabled={!custom.trim()} onClick={() => add({ name: custom.trim(), attr: customAttr as AttrKey, rating })}>{t('Créer')}</Button>
  </div>;
}

export function SkillsTab({ s }: { s: SheetCtx }) {
  const { actor, edit } = s;
  const [showAll, setShowAll] = useState(false);
  const skills = (actor.skills || []) as SheetSkill[];
  const groups: Record<string, Array<{ sk?: SheetSkill; def?: SkillDef; ghost?: boolean }>> = {};
  for (const sk of skills) {
    const cat = SKILL_BY_ID[sk.id]?.cat || 'custom';
    (groups[cat] ||= []).push({ sk, def: SKILL_BY_ID[sk.id] });
  }
  if (showAll && !edit) {
    const have = new Set(skills.map((x) => x.id));
    for (const def of SKILLS) if (!have.has(def.id) && def.def) (groups[def.cat] ||= []).push({ def, ghost: true });
  }
  const cats = [...Object.keys(SKILL_CATEGORIES), 'custom'].filter((c) => groups[c]?.length);
  for (const c of cats) groups[c].sort((a, b) => (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0) || ((b.sk?.rating || 0) - (a.sk?.rating || 0)) || compare(skillName(a.sk, a.def?.id), skillName(b.sk, b.def?.id)));
  const knowledge = (actor.knowledge || []) as SheetKnowledge[];
  return <div className="sh-skills">
    <div className="row spread wrap">
      <div className="muted small">
        {edit ? t('Modifie les indices et spécialisations directement.') : t('Clique une compétence pour lancer les dés (indice + attribut).')}
      </div>
      {!edit && <Toggle value={showAll} onChange={setShowAll} label={t('Afficher les jets par défaut')} />}
    </div>
    {edit && <AddSkill s={s} />}{!cats.length && <div className="empty">{t('Aucune compétence.')}</div>}
    <div className="sh-skill-cols">
      {cats.map(
        (c) => <section className="sh-skill-cat" key={c}>
          <h4 className="section-title">{(SKILL_CATEGORIES as Record<string, string>)[c] ? skillCategoryLabel(c) : t('Autres')}</h4>
          <div className="sh-table-wrap">
            <table className="sr sh-skill-table">
              <thead>
                <tr>
                  <th>{t('Compétence')}</th>
                  <th>{t('Attr.')}</th>
                  <th className="right">{t('Ind.')}</th>
                  <th>{t('Spé.')}</th>
                  <th className="right">{t('Réserve')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>{groups[c].map((g) => <SkillRow s={s} sk={g.sk} def={g.def} ghost={g.ghost} key={g.sk?.id || g.def?.id} />)}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
    <h4 className="section-title">{t('Connaissances & langues')}{' '}<RuleRef rule="knowledgeSkills" /></h4>
    {edit
      ? <ListEditor actor={actor} list="knowledge" />
      : knowledge.length
        ? <div className="sh-table-wrap">
          <table className="sr">
            <thead>
              <tr><th>{t('Connaissance')}</th><th>{t('Type')}</th><th className="right">{t('Ind.')}</th><th className="right">{t('Réserve')}</th></tr>
            </thead>
            <tbody>
              {[...knowledge]
              .sort((a, b) => (a.type === 'language' ? 1 : 0) - (b.type === 'language' ? 1 : 0) || (b.rating || 0) - (a.rating || 0))
              .map((k) => {
                const at = knowledgeAttr(k.type);
                const pool = (Number(k.rating) || 0) + attr(actor, at);
                return <tr key={k.id} className={k.native ? '' : 'sh-skill'} onClick={k.native ? undefined : () => s.roll({ skillId: k.id })}>
                  <td>{k.name}{k.notes ? <>{' '}<span className="badge badge-amber" title={k.notes}>{k.notes}</span></> : null}</td>
                  <td className="muted small">{KNOWLEDGE_TYPES[k.type] ? t(KNOWLEDGE_TYPES[k.type]) : k.type}</td>
                  <td className="num-cell">{k.native ? <span className="badge badge-cyan">{t('Maternelle')}</span> : k.rating}</td>
                  <td className="num-cell sh-pool">
                    {k.native ? '—' : `${pool}`}
                    <span className="faint small">{' '}{k.native ? '' : attrShort(at)}</span>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        : <div className="muted small">{t('Aucune connaissance.')}</div>}
  </div>;
}
