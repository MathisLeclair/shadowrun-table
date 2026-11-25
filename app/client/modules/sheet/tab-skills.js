// Sheet tab « Compétences »: active skills grouped by category, knowledge skills. Click a skill to roll.
import { useState } from 'preact/hooks';
import { html, Button, NumberInput, TextInput, Select, Toggle, IconButton, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { SKILLS, SKILL_BY_ID, SKILL_CATEGORIES, SKILL_GROUPS, ATTR_SHORT, attr, skillPool } from '/shared/sr5.js';
import { ListEditor } from './editors.js';
import { KNOWLEDGE_TYPES, knowledgeAttr } from './sheet-data.js';

const ATTR_OPTIONS = ['AGI', 'BOD', 'REA', 'STR', 'CHA', 'INT', 'LOG', 'WIL', 'MAG', 'RES'].map((k) => ({ value: k, label: ATTR_SHORT[k] }));

function SkillRow({ s, sk, def, ghost }) {
  const { actor, edit } = s;
  const at = sk?.attr || def?.attr || 'AGI';
  const res = skillPool(actor, sk?.id || def.id);
  const name = sk?.name || def?.fr || sk?.id;
  const up = (patch) => send('actor/updateItem', { actorId: actor.id, list: 'skills', itemId: sk.id, patch }).catch(() => {});
  const remove = async () => {
    if (await confirmAction(`Retirer la compétence ${name} ?`)) send('actor/removeItem', { actorId: actor.id, list: 'skills', itemId: sk.id }).catch(() => {});
  };
  if (edit && sk) {
    return html`<tr>
      <td><b>${name}</b>${sk.notes ? html` <span class="badge badge-amber" title=${sk.notes}>!</span>` : null}</td>
      <td><${Select} value=${at} options=${ATTR_OPTIONS} onChange=${(v) => up({ attr: v })} /></td>
      <td><${NumberInput} small value=${sk.rating || 0} min=${0} max=${13} onChange=${(v) => up({ rating: v })} /></td>
      <td><${TextInput} value=${sk.spec || ''} placeholder="Spécialisation" onChange=${(v) => up({ spec: v })} /></td>
      <td class="num-cell">${res.pool}</td>
      <td><${IconButton} icon="✕" title="Retirer" onClick=${remove} /></td>
    </tr>`;
  }
  const disabled = res.impossible;
  return html`<tr class=${'sh-skill' + (ghost ? ' ghost' : '') + (disabled ? ' disabled' : '')} onClick=${disabled ? null : () => s.roll({ skillId: sk?.id || def.id })}
    title=${disabled ? 'Ne peut pas être utilisée sans formation' : `Lancer ${name}`}>
    <td><span class="sh-skill-name">${name}</span>${def?.group ? html` <span class="faint small">${SKILL_GROUPS[def.group]}</span>` : null}
      ${sk?.notes ? html` <span class="badge badge-amber" title=${sk.notes}>${sk.notes}</span>` : null}</td>
    <td class="muted small">${ATTR_SHORT[at]} ${attr(actor, at)}</td>
    <td class="num-cell">${ghost ? '—' : sk.rating}</td>
    <td class="small">${sk?.spec ? html`<span class="badge badge-cyan" title="+2 dés avec la spécialisation">${sk.spec}</span>` : null}</td>
    <td class="num-cell sh-pool">${disabled ? '—' : res.pool}${sk?.spec && !ghost ? html`<span class="faint"> (${res.pool + 2})</span>` : null}</td>
    <td class="sh-roll-cell">${disabled ? null : html`<span class="sh-die-btn" aria-hidden="true">⚄</span>`}</td>
  </tr>`;
}

function AddSkill({ s }) {
  const { actor } = s;
  const [id, setId] = useState('');
  const [rating, setRating] = useState(1);
  const [custom, setCustom] = useState('');
  const [customAttr, setCustomAttr] = useState('LOG');
  const have = new Set((actor.skills || []).map((x) => x.id));
  const options = [{ value: '', label: 'Choisir une compétence…' }, ...SKILLS.filter((x) => !have.has(x.id)).map((x) => ({ value: x.id, label: `${x.fr} (${ATTR_SHORT[x.attr]})` }))];
  const add = (item) => send('actor/addItem', { actorId: actor.id, list: 'skills', item }).then(() => { setId(''); setCustom(''); }).catch(() => {});
  return html`<div class="sh-add-skill row wrap">
    <${Select} value=${id} options=${options} onChange=${setId} style=${{ maxWidth: '260px' }} />
    <${NumberInput} small value=${rating} min=${0} max=${13} onChange=${setRating} />
    <${Button} small variant="primary" disabled=${!id} onClick=${() => add({ id, rating })}>Ajouter</${Button}>
    <span class="faint">ou</span>
    <${TextInput} live value=${custom} placeholder="Compétence personnalisée" onChange=${setCustom} style=${{ maxWidth: '200px' }} />
    <${Select} value=${customAttr} options=${ATTR_OPTIONS} onChange=${setCustomAttr} style=${{ width: 'auto' }} />
    <${Button} small disabled=${!custom.trim()} onClick=${() => add({ name: custom.trim(), attr: customAttr, rating })}>Créer</${Button}>
  </div>`;
}

export function SkillsTab({ s }) {
  const { actor, edit } = s;
  const [showAll, setShowAll] = useState(false);
  const skills = actor.skills || [];
  const groups = {};
  for (const sk of skills) {
    const cat = SKILL_BY_ID[sk.id]?.cat || 'custom';
    (groups[cat] ||= []).push({ sk, def: SKILL_BY_ID[sk.id] });
  }
  if (showAll && !edit) {
    const have = new Set(skills.map((x) => x.id));
    for (const def of SKILLS) if (!have.has(def.id) && def.def) (groups[def.cat] ||= []).push({ def, ghost: true });
  }
  const cats = [...Object.keys(SKILL_CATEGORIES), 'custom'].filter((c) => groups[c]?.length);
  for (const c of cats) groups[c].sort((a, b) => (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0) || ((b.sk?.rating || 0) - (a.sk?.rating || 0)) || String(a.sk?.name || a.def?.fr).localeCompare(String(b.sk?.name || b.def?.fr)));
  const knowledge = actor.knowledge || [];
  return html`<div class="sh-skills">
    <div class="row spread wrap">
      <div class="muted small">${edit ? 'Modifie les indices et spécialisations directement.' : 'Clique une compétence pour lancer les dés (indice + attribut).'}</div>
      ${!edit && html`<${Toggle} value=${showAll} onChange=${setShowAll} label="Afficher les jets par défaut" />`}
    </div>
    ${edit && html`<${AddSkill} s=${s} />`}
    ${!cats.length && html`<div class="empty">Aucune compétence.</div>`}
    <div class="sh-skill-cols">
      ${cats.map(
        (c) => html`<section class="sh-skill-cat" key=${c}>
          <h4 class="section-title">${SKILL_CATEGORIES[c] || 'Autres'}</h4>
          <div class="sh-table-wrap"><table class="sr sh-skill-table">
            <thead><tr><th>Compétence</th><th>Attr.</th><th class="right">Ind.</th><th>Spé.</th><th class="right">Réserve</th><th></th></tr></thead>
            <tbody>${groups[c].map((g) => html`<${SkillRow} s=${s} sk=${g.sk} def=${g.def} ghost=${g.ghost} key=${g.sk?.id || g.def.id} />`)}</tbody>
          </table></div>
        </section>`
      )}
    </div>

    <h4 class="section-title">Connaissances & langues</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="knowledge" />`
      : knowledge.length
        ? html`<div class="sh-table-wrap"><table class="sr">
            <thead><tr><th>Connaissance</th><th>Type</th><th class="right">Ind.</th><th class="right">Réserve</th></tr></thead>
            <tbody>${[...knowledge]
              .sort((a, b) => (a.type === 'language' ? 1 : 0) - (b.type === 'language' ? 1 : 0) || (b.rating || 0) - (a.rating || 0))
              .map((k) => {
                const at = knowledgeAttr(k.type);
                const pool = (Number(k.rating) || 0) + attr(actor, at);
                return html`<tr key=${k.id} class=${k.native ? '' : 'sh-skill'} onClick=${k.native ? null : () => s.roll({ skillId: k.id })}>
                  <td>${k.name}${k.notes ? html` <span class="badge badge-amber" title=${k.notes}>${k.notes}</span>` : null}</td>
                  <td class="muted small">${KNOWLEDGE_TYPES[k.type] || k.type}</td>
                  <td class="num-cell">${k.native ? html`<span class="badge badge-cyan">Maternelle</span>` : k.rating}</td>
                  <td class="num-cell sh-pool">${k.native ? '—' : `${pool}`}<span class="faint small"> ${k.native ? '' : ATTR_SHORT[at]}</span></td>
                </tr>`;
              })}</tbody>
          </table></div>`
        : html`<div class="muted small">Aucune connaissance.</div>`}
  </div>`;
}
