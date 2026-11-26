// « Que veux-tu améliorer ? » — every way to spend karma, grouped by tabs. Picking something opens ConfirmModal.
import { useState } from 'preact/hooks';
import { html, Button, Tabs, SearchBox, Select, TextInput, NumberInput, Badge, Empty, Field } from '../../lib/ui.js';
import { useCatalog } from '../../lib/net.js';
import { t, tk, attrLabel, skillLabel, skillGroupLabel, skillCategoryLabel, metatypeLabel, itemName, compare, getLang } from '../../lib/i18n.js';
import { SKILLS, SKILL_BY_ID, SKILL_GROUPS, SKILL_CATEGORIES } from '/shared/sr5.js';
import {
  TRAINABLE_ATTRS, KNOWLEDGE_TYPES, attrMax, skillRating, groupState, groupMembers, magicProfile, powerPoints, catalogName,
  qualityInfo, powerInfo, spellInfo, initiationGrade, submersionGrade,
} from '/shared/advancement.js';
import { slug } from '/shared/util.js';
import { makeQuoter, Rule, CostCell, MAGIC_TYPES, errorOf, warningsOf, msgText } from './common.js';
import ConfirmModal from './ConfirmModal.js';

const norm = (s) => slug(String(s || '')).replace(/-/g, ' ');
const matches = (q, ...fields) => !q || fields.some((f) => norm(f).includes(norm(q)));
const ATTR_ORDER = ['physical', 'mental', 'special'];
const ATTR_KIND = { BOD: 'physical', AGI: 'physical', REA: 'physical', STR: 'physical', WIL: 'mental', LOG: 'mental', INT: 'mental', CHA: 'mental', EDG: 'special', MAG: 'special', RES: 'special' };
const ATTR_KIND_LABEL = { physical: tk('attributs::Physiques'), mental: tk('Mentaux'), special: tk('Spéciaux') };
/** Spell category in the UI language (the French name comes from spellInfo()). */
const spellCategory = (item, info) => (getLang() === 'en' ? String(item?.category || info.category || '') : info.category);

export default function AdvancePanel({ game, actor, isGM }) {
  const [tab, setTab] = useState('attributes');
  const [draft, setDraft] = useState(null);
  const q = makeQuoter(game, actor);
  const prof = magicProfile(actor);
  const awakened = prof.MAG > 0 || prof.RES > 0;
  const tabs = [
    { id: 'attributes', label: t('Attributs') },
    { id: 'skills', label: t('Compétences') },
    { id: 'groups', label: t('Groupes') },
    { id: 'knowledge', label: t('Connaissances') },
    { id: 'qualities', label: t('Qualités') },
    ...(awakened ? [{ id: 'magic', label: prof.RES > 0 && prof.MAG <= 0 ? t('Résonance') : t('Magie') }] : []),
    { id: 'other', label: t('Autre') },
  ];
  const current = tabs.find((x) => x.id === tab) ? tab : 'attributes';
  const props = { game, actor, q, open: setDraft, prof, isGM };
  const body = {
    attributes: AttributesTab,
    skills: SkillsTab,
    groups: GroupsTab,
    knowledge: KnowledgeTab,
    qualities: QualitiesTab,
    magic: MagicTab,
    other: OtherTab,
  }[current];
  return html`<div class="training-advance">
    <${Tabs} tabs=${tabs} value=${current} onChange=${setTab} class="training-tabs" />
    <div class="training-tab-body"><${body} ...${props} /></div>
    ${draft && html`<${ConfirmModal} game=${game} actor=${actor} draft=${draft} isGM=${isGM} onClose=${() => setDraft(null)} />`}
  </div>`;
}

/** "+1" button that opens the confirmation (disabled with the reason when impossible). `label` = already translated. */
function PlusButton({ qt, onClick, label = '+1' }) {
  return html`<${Button} small variant="primary" disabled=${!!qt?.error} title=${errorOf(qt) || t('Voir le coût et confirmer')} onClick=${onClick}>${label}</${Button}>`;
}

// ---------------------------------------------------------------------------------------------
function AttributesTab({ actor, q, open }) {
  const keys = TRAINABLE_ATTRS.filter((k) => (k !== 'MAG' && k !== 'RES') || Number(actor.attributes?.[k]) > 0);
  const meta = metatypeLabel(actor.metatype || 'Humain');
  return html`<div class="training-hint small muted">${keys.includes('MAG')
      ? t('Un seul attribut à la fois. Le maximum dépend du métatype ({meta}), et pour la Magie de l’essence et du grade d’initiation.', { meta })
      : t('Un seul attribut à la fois. Le maximum dépend du métatype ({meta}).', { meta })} <${Rule} kind="attribute" /></div>
    <div class="training-table-wrap"><table class="sr training-table">
      <thead><tr><th>${t('Attribut')}</th><th class="center">${t('Actuel')}</th><th class="center">${t('Max')}</th><th>${t('Rang suivant')}</th><th></th></tr></thead>
      ${ATTR_ORDER.map((group) => {
        const list = keys.filter((k) => ATTR_KIND[k] === group);
        if (!list.length) return null;
        return html`<tbody key=${group}>
          <tr class="training-subhead"><td colspan="5">${t(ATTR_KIND_LABEL[group])}</td></tr>
          ${list.map((k) => {
            const cur = Number(actor.attributes?.[k]) || 0;
            const max = attrMax(actor, k);
            const qt = q({ kind: 'attribute', target: k });
            const aug = Number(actor.augmented?.[k]) || 0;
            return html`<tr key=${k} class=${cur >= max ? 'training-maxed' : ''}>
              <td><strong>${attrLabel(k)}</strong> <span class="muted small mono">${k}</span></td>
              <td class="center mono">${cur}${aug ? html`<span class="muted small"> (${cur + Math.min(4, aug)})</span>` : ''}</td>
              <td class="center mono muted">${max}</td>
              <td><${CostCell} qt=${qt} /></td>
              <td class="right"><${PlusButton} qt=${qt} onClick=${() => open({ kind: 'attribute', target: k })} /></td>
            </tr>`;
          })}
        </tbody>`;
      })}
    </table></div>`;
}

// ---------------------------------------------------------------------------------------------
function SkillsTab({ actor, q, open, prof }) {
  const [search, setSearch] = useState('');
  const [newId, setNewId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customAttr, setCustomAttr] = useState('AGI');
  const owned = (actor.skills || [])
    .filter((s) => skillRating(actor, s.id) > 0)
    .filter((s) => matches(search, s.name, SKILL_BY_ID[s.id]?.fr, skillLabel(s), s.spec))
    .sort((a, b) => compare(skillLabel(a), skillLabel(b)));
  const learnable = SKILLS.filter((s) => skillRating(actor, s.id) === 0)
    .filter((s) => (s.cat !== 'magic' || prof.MAG > 0) && (s.cat !== 'resonance' || prof.RES > 0));
  const byCat = Object.keys(SKILL_CATEGORIES)
    .map((cat) => ({ label: skillCategoryLabel(cat), list: learnable.filter((s) => s.cat === cat).sort((a, b) => compare(skillLabel(a), skillLabel(b))) }))
    .filter((g) => g.list.length);
  const learnReq = newId === '__custom' ? { kind: 'skill', target: '', name: customName.trim(), attr: customAttr, to: 1 } : newId ? { kind: 'skill', target: newId, to: 1 } : null;
  const learnQt = learnReq ? q(learnReq) : null;

  return html`<div class="row spread wrap training-toolbar">
      <${SearchBox} value=${search} onChange=${setSearch} placeholder=${t('Filtrer mes compétences…')} />
      <span class="small muted">${t('Rangs 1–4 : quelques jours · 5–8 : semaines · 9+ : longues semaines')} <${Rule} kind="skill" /></span>
    </div>
    ${owned.length
      ? html`<div class="training-table-wrap"><table class="sr training-table">
          <thead><tr><th>${t('Compétence')}</th><th class="center">${t('Rang')}</th><th>${t('Rang suivant')}</th><th></th></tr></thead>
          <tbody>
            ${owned.map((s) => {
              const rating = skillRating(actor, s.id);
              const qt = q({ kind: 'skill', target: s.id });
              const def = SKILL_BY_ID[s.id];
              const warnings = warningsOf(qt);
              return html`<tr key=${s.id}>
                <td>
                  <strong>${skillLabel(s)}</strong> <span class="muted small mono">${s.attr || def?.attr || ''}</span>
                  ${def?.group && html` <span class="faint small">· ${skillGroupLabel(def.group)}</span>`}
                  ${s.spec && html`<div class="small cyan">↳ ${s.spec}</div>`}
                </td>
                <td class="center mono">${rating}</td>
                <td><${CostCell} qt=${qt} />${!qt.error && warnings.length ? html`<div class="small amber">⚠ ${warnings.join(', ')}</div>` : ''}</td>
                <td class="right nowrap">
                  <${Button} small variant="ghost" title=${t('Spécialisation : 7 karma · 1 mois')} onClick=${() => open({ kind: 'specialization', target: s.id })}>${t('Spé.')}</${Button}>
                  <${PlusButton} qt=${qt} onClick=${() => open({ kind: 'skill', target: s.id })} />
                </td>
              </tr>`;
            })}
          </tbody>
        </table></div>`
      : html`<${Empty}>${search ? t('Aucune compétence ne correspond.') : t('Aucune compétence active.')}</${Empty}>`}

    <div class="section-title">${t('Apprendre une nouvelle compétence')}</div>
    <div class="training-learn">
      <${Field} label=${t('Compétence')}>
        <select class="input" value=${newId} onChange=${(e) => setNewId(e.target.value)}>
          <option value="">${t('— Choisir —')}</option>
          ${byCat.map((g) => html`<optgroup label=${g.label}>${g.list.map((s) => html`<option value=${s.id} selected=${s.id === newId}>${skillLabel(s)} (${s.attr})</option>`)}</optgroup>`)}
          <option value="__custom" selected=${newId === '__custom'}>${t('Autre (arme exotique, pilotage particulier…)')}</option>
        </select>
      </${Field}>
      ${newId === '__custom' &&
      html`<${Field} label=${t('Nom')}><${TextInput} live value=${customName} placeholder=${t('ex. Arme exotique (fouet monofilament)')} onChange=${setCustomName} /></${Field}>
        <${Field} label=${t('Attribut lié')}><${Select} value=${customAttr} onChange=${setCustomAttr} options=${['AGI', 'BOD', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA'].map((k) => ({ value: k, label: attrLabel(k) }))} /></${Field}>`}
      <div class="training-learn-cta">
        ${learnQt && html`<${CostCell} qt=${learnQt} />`}
        <${Button} variant="primary" disabled=${!learnReq || !!learnQt?.error} onClick=${() => learnReq && open(learnReq)}>${t('Apprendre…')}</${Button}>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
function GroupsTab({ actor, q, open, prof }) {
  const groups = Object.keys(SKILL_GROUPS).filter((gid) => {
    const cats = groupMembers(gid).map((id) => SKILL_BY_ID[id]?.cat);
    if (cats.includes('magic') && prof.MAG <= 0) return false;
    if (cats.includes('resonance') && prof.RES <= 0) return false;
    return true;
  });
  return html`<div class="training-hint small muted">
      ${t('Un groupe se rompt dès qu’une de ses compétences est augmentée seule ou spécialisée. Pour le reconstituer, remonte toutes ses compétences au même indice.')} <${Rule} kind="skillGroup" />
    </div>
    <div class="training-table-wrap"><table class="sr training-table">
      <thead><tr><th>${t('Groupe')}</th><th class="center">${t('Rang')}</th><th>${t('Rang suivant')}</th><th></th></tr></thead>
      <tbody>
        ${groups.map((gid) => {
          const g = groupState(actor, gid);
          const qt = q({ kind: 'skillGroup', target: gid });
          const members = groupMembers(gid).map((id) => skillLabel(id));
          return html`<tr key=${gid} class=${g.intact ? '' : 'training-broken'}>
            <td>
              <strong>${skillGroupLabel(gid)}</strong>
              ${!g.intact ? html` <${Badge} color="red" title=${msgText(g.reasonI18n, g.reason)}>${t('rompu')}</${Badge}>` : g.owned ? html` <${Badge} color="cyan">${t('intact')}</${Badge}>` : ''}
              <div class="small faint">${members.join(', ')}</div>
            </td>
            <td class="center mono">${g.intact ? g.rating : '—'}</td>
            <td><${CostCell} qt=${qt} /></td>
            <td class="right"><${PlusButton} qt=${qt} onClick=${() => open({ kind: 'skillGroup', target: gid })} /></td>
          </tr>`;
        })}
      </tbody>
    </table></div>`;
}

// ---------------------------------------------------------------------------------------------
function KnowledgeTab({ actor, q, open }) {
  const [name, setName] = useState('');
  const [ktype, setKtype] = useState('street');
  const list = [...(actor.knowledge || [])].sort((a, b) => compare(a.name, b.name));
  const newReq = name.trim().length >= 2 ? { kind: 'knowledge', name: name.trim(), ktype, to: 1 } : null;
  const newQt = newReq ? q(newReq) : null;
  return html`<div class="training-hint small muted">${t('Connaissances de la rue, académiques, professionnelles, centres d’intérêt et langues.')} <${Rule} kind="knowledge" /></div>
    ${list.length
      ? html`<div class="training-table-wrap"><table class="sr training-table">
          <thead><tr><th>${t('Connaissance')}</th><th class="center">${t('Rang')}</th><th>${t('Rang suivant')}</th><th></th></tr></thead>
          <tbody>
            ${list.map((k) => {
              const qt = k.native ? null : q({ kind: 'knowledge', target: k.id });
              return html`<tr key=${k.id}>
                <td><strong>${k.name}</strong> <span class="faint small">${KNOWLEDGE_TYPES[k.type] ? t(KNOWLEDGE_TYPES[k.type]) : ''}</span>${k.spec && html`<div class="small cyan">↳ ${k.spec}</div>`}</td>
                <td class="center mono">${k.native ? t('langue maternelle::N') : k.rating || 0}</td>
                <td>${k.native ? html`<span class="muted small">${t('Langue maternelle')}</span>` : html`<${CostCell} qt=${qt} />`}</td>
                <td class="right nowrap">
                  ${!k.native && (Number(k.rating) || 0) > 0 && html`<${Button} small variant="ghost" title=${t('Spécialisation : 7 karma · 1 mois')} onClick=${() => open({ kind: 'specialization', target: k.id })}>${t('Spé.')}</${Button}>`}
                  ${qt && html`<${PlusButton} qt=${qt} onClick=${() => open({ kind: 'knowledge', target: k.id })} />`}
                </td>
              </tr>`;
            })}
          </tbody>
        </table></div>`
      : html`<${Empty}>${t('Aucune connaissance pour l’instant.')}</${Empty}>`}
    <div class="section-title">${t('Nouvelle connaissance ou langue')}</div>
    <div class="training-learn">
      <${Field} label=${t('Nom')}><${TextInput} live value=${name} placeholder=${t('ex. Gangs de Redmond, Japonais, Politique corpo…')} onChange=${setName} /></${Field}>
      <${Field} label=${t('Type')}><${Select} value=${ktype} onChange=${setKtype} options=${Object.entries(KNOWLEDGE_TYPES).map(([value, label]) => ({ value, label: t(label) }))} /></${Field}>
      <div class="training-learn-cta">
        ${newQt && html`<${CostCell} qt=${newQt} />`}
        <${Button} variant="primary" disabled=${!newReq || !!newQt?.error} onClick=${() => newReq && open(newReq)}>${t('Apprendre…')}</${Button}>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
function QualitiesTab({ actor, q, open }) {
  const catalog = useCatalog('qualities');
  const [search, setSearch] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualKarma, setManualKarma] = useState(5);
  const owned = actor.qualities || [];
  // `name` (French when known) is what gets stored on the sheet; `shown` is the label in the UI language.
  const positives = (Array.isArray(catalog) ? catalog : [])
    .map((item) => ({ item, info: qualityInfo(item), name: catalogName(item), label: itemName(item) }))
    .filter((x) => x.info.positive && x.info.karma > 0 && matches(search, x.name, x.item.name));
  const shown = positives.sort((a, b) => compare(a.label, b.label)).slice(0, 60);
  const has = (x) => owned.some((o) => o.catalogId === x.item.id || norm(o.name) === norm(x.name) || norm(o.name) === norm(x.item.name));
  const manualReq = manualName.trim() ? { kind: 'quality', name: manualName.trim(), karma: manualKarma } : null;
  const manualQt = manualReq ? q(manualReq) : null;
  const other = (item) => (getLang() === 'en' ? item.nameFr : item.name);

  return html`<div class="section-title">${t('Qualités actuelles')}</div>
    ${owned.length
      ? html`<ul class="training-qualities">
          ${owned.map((o) => {
            const negative = o.positive === false || Number(o.karma) < 0;
            const qt = negative ? q({ kind: 'removeQuality', target: o.id }) : null;
            return html`<li key=${o.id || o.name}>
              <${Badge} color=${negative ? 'red' : 'green'}>${negative ? '−' : '+'}</${Badge}>
              <span class="grow">${o.name} <span class="faint small mono">${Math.abs(Number(o.karma) || 0) || ''}</span></span>
              ${negative &&
              html`<span class="row gap-s"><${CostCell} qt=${qt} /><${PlusButton} qt=${qt} label=${t('Racheter')} onClick=${() => open({ kind: 'removeQuality', target: o.id })} /></span>`}
            </li>`;
          })}
        </ul>`
      : html`<div class="muted small">${t('Aucune qualité.')}</div>`}

    <div class="section-title">${t('Acquérir une qualité positive')} <${Rule} kind="quality" /></div>
    ${catalog.length
      ? html`<${SearchBox} value=${search} onChange=${setSearch} placeholder=${t('Chercher une qualité (Ambidextre, Sang-froid…)')} />
          <ul class="training-catalog">
            ${shown.map((x) => {
              const owns = has(x);
              const req = { kind: 'quality', catalogId: x.item.id, name: x.name, karma: x.info.karma };
              const qt = owns ? null : q(req);
              const alt = other(x.item);
              return html`<li key=${x.item.id} class=${owns ? 'owned' : ''}>
                <div class="grow">
                  <strong>${x.label}</strong>${x.item.nameFr && x.item.name !== x.item.nameFr && alt ? html` <span class="faint small">${alt}</span>` : ''}
                  <div class="small muted">${t('{karma} karma de qualité · {source}', { karma: x.info.karma, source: `${x.item.source || ''} ${x.item.page ? `p.${x.item.page}` : ''}`.trim() })}</div>
                </div>
                ${owns ? html`<${Badge} color="green">${t('possédée')}</${Badge}>` : html`<${CostCell} qt=${qt} /><${PlusButton} qt=${qt} label=${t('Choisir')} onClick=${() => open(req)} />`}
              </li>`;
            })}
            ${!shown.length && html`<li class="muted small">${t('Aucune qualité ne correspond.')}</li>`}
          </ul>
          ${positives.length > shown.length && html`<div class="small faint">${t('{n} autres résultats — affine la recherche.', { n: positives.length - shown.length })}</div>`}`
      : html`<div class="muted small">${t('Catalogue des qualités indisponible : utilise la saisie manuelle.')}</div>`}

    <div class="section-title">${t('Saisie manuelle')}</div>
    <div class="training-learn">
      <${Field} label=${t('Qualité')}><${TextInput} live value=${manualName} placeholder=${t('Nom de la qualité')} onChange=${setManualName} /></${Field}>
      <${Field} label=${t('Karma de la qualité')}><${NumberInput} value=${manualKarma} min=${1} max=${50} onChange=${setManualKarma} /></${Field}>
      <div class="training-learn-cta">
        ${manualQt && html`<${CostCell} qt=${manualQt} />`}
        <${Button} disabled=${!manualReq || !!manualQt?.error} onClick=${() => manualReq && open(manualReq)}>${t('Proposer au MJ…')}</${Button}>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
function MagicTab({ actor, q, open, prof }) {
  const sub = prof.MAG <= 0 && prof.RES > 0;
  const grade = sub ? submersionGrade(actor) : initiationGrade(actor);
  const initQt = q({ kind: 'initiation' });
  const metas = sub ? actor.magic?.echoes : actor.magic?.metamagics;
  return html`<div class="row wrap training-magic-head">
      <${Badge} color="magenta">${MAGIC_TYPES[prof.type] ? t(MAGIC_TYPES[prof.type]) : t('Éveillé')}</${Badge}>
      ${prof.MAG > 0 && html`<span class="small">${t('Magie')} <strong class="mono">${prof.MAG}</strong></span>`}
      ${prof.RES > 0 && html`<span class="small">${t('Résonance')} <strong class="mono">${prof.RES}</strong></span>`}
      <span class="small">${sub ? t('Submersion : grade') : t('Initiation : grade')} <strong class="mono">${grade}</strong></span>
    </div>

    <div class="section-title">${sub ? t('Submersion') : t('Initiation')} <${Rule} kind="initiation" /></div>
    <div class="training-row-card">
      <div class="grow">
        <strong>${t('Grade {n}', { n: grade + 1 })}</strong>
        <div class="small muted">${sub ? t('Augmente le maximum de Résonance de 1 et donne accès à un écho.') : t('Augmente le maximum de Magie de 1 et donne accès à une métamagie.')}</div>
        ${Array.isArray(metas) && metas.length ? html`<div class="small cyan">${t('Acquis : {list}', { list: metas.join(', ') })}</div>` : ''}
      </div>
      <${CostCell} qt=${initQt} />
      <${PlusButton} qt=${initQt} label=${t('S’initier…')} onClick=${() => open({ kind: 'initiation', options: {} })} />
    </div>

    ${prof.hasPowers && html`<${PowersSection} actor=${actor} q=${q} open=${open} prof=${prof} />`}
    ${prof.canCast && html`<${SpellsSection} actor=${actor} q=${q} open=${open} />`}
    ${prof.RES > 0 && html`<${ComplexFormsSection} actor=${actor} q=${q} open=${open} />`}`;
}

function SpellsSection({ actor, q, open }) {
  const catalog = useCatalog('spells');
  const [search, setSearch] = useState('');
  const [manual, setManual] = useState('');
  const known = actor.spells || [];
  const list = (Array.isArray(catalog) ? catalog : []).filter((s) => matches(search, catalogName(s), s.name, s.category));
  const shown = [...list].sort((a, b) => compare(itemName(a), itemName(b))).slice(0, 50);
  const knows = (s) => known.some((k) => k.catalogId === s.id || norm(k.name) === norm(catalogName(s)) || norm(k.name) === norm(s.name));
  const manualReq = manual.trim() ? { kind: 'spell', name: manual.trim() } : null;
  const manualQt = manualReq ? q(manualReq) : null;
  return html`<div class="section-title">${t('Sorts ({n} connus)', { n: known.length })} <${Rule} kind="spell" /></div>
    ${known.length ? html`<div class="small muted training-known">${known.map((s) => s.name).join(' · ')}</div>` : ''}
    ${catalog.length
      ? html`<${SearchBox} value=${search} onChange=${setSearch} placeholder=${t('Chercher un sort (Boule de feu, Soins…)')} />
        <ul class="training-catalog">
          ${shown.map((s) => {
            const info = spellInfo(s);
            const k = knows(s);
            const req = { kind: 'spell', catalogId: s.id, name: catalogName(s), data: info };
            const qt = k ? null : q(req);
            return html`<li key=${s.id} class=${k ? 'owned' : ''}>
              <div class="grow">
                <strong>${itemName(s)}</strong>
                <div class="small muted">${[spellCategory(s, info), info.type, info.range, info.duration, info.drain && t('Drain {dv}', { dv: info.drain })].filter(Boolean).join(' · ')}</div>
              </div>
              ${k ? html`<${Badge} color="green">${t('connu')}</${Badge}>` : html`<${CostCell} qt=${qt} /><${PlusButton} qt=${qt} label=${t('Apprendre')} onClick=${() => open(req)} />`}
            </li>`;
          })}
          ${!shown.length && html`<li class="muted small">${t('Aucun sort ne correspond.')}</li>`}
        </ul>
        ${list.length > shown.length && html`<div class="small faint">${t('{n} autres résultats — affine la recherche.', { n: list.length - shown.length })}</div>`}`
      : ''}
    <div class="training-learn">
      <${Field} label=${t('Sort, rituel ou préparation (saisie manuelle)')}><${TextInput} live value=${manual} placeholder=${t('Nom')} onChange=${setManual} /></${Field}>
      <div class="training-learn-cta"><${Button} disabled=${!manualReq || !!manualQt?.error} title=${manualQt ? errorOf(manualQt) || '' : ''} onClick=${() => manualReq && open(manualReq)}>${t('Proposer au MJ…')}</${Button}></div>
    </div>`;
}

function PowersSection({ actor, q, open, prof }) {
  const catalog = useCatalog('powers');
  const [search, setSearch] = useState('');
  const items = Array.isArray(catalog) ? catalog : [];
  const pp = powerPoints(actor);
  const owned = actor.powers || [];
  const findItem = (p) => items.find((i) => (p.catalogId && i.id === p.catalogId) || norm(catalogName(i)) === norm(p.name) || norm(i.name) === norm(p.name));
  const list = items.filter((i) => matches(search, catalogName(i), i.name));
  const shown = [...list].sort((a, b) => compare(itemName(a), itemName(b))).slice(0, 50);
  const ppQt = prof.type === 'mystic' ? q({ kind: 'powerPoint' }) : null;
  return html`<div class="section-title">${t('Pouvoirs d’adepte')} <${Rule} kind="power" /></div>
    <div class="row wrap training-pp">
      <span>${t('Points de pouvoir :')} <strong class="mono cyan">${pp.free}</strong> ${t('libres sur')} <span class="mono">${pp.total}</span></span>
      ${prof.type === 'adept' && html`<span class="small muted">${pp.extra
        ? t('(PP = Magie + {n} gagné(s) par l’initiation. Augmenter la Magie donne 1 PP.)', { n: pp.extra })
        : t('(PP = Magie. Augmenter la Magie donne 1 PP.)')}</span>`}
      ${ppQt && html`<span class="row gap-s"><${CostCell} qt=${ppQt} /><${PlusButton} qt=${ppQt} label=${t('+1 PP')} onClick=${() => open({ kind: 'powerPoint' })} /></span>`}
    </div>
    ${owned.length
      ? html`<ul class="training-catalog">
          ${owned.map((p) => {
            const item = findItem(p);
            const info = item ? powerInfo(item) : null;
            const leveled = info ? info.levels : !!p.level;
            const req = { kind: 'power', target: p.id, name: p.name, catalogId: item?.id || '', pp: info?.pp || 0, levels: leveled, maxLevel: info?.maxLevel || null, existing: true };
            if (!req.catalogId) delete req.catalogId;
            const qt = leveled ? q(req) : null;
            return html`<li key=${p.id || p.name}>
              <div class="grow"><strong>${p.name}</strong>${p.level ? html` <span class="mono">${t('niv. {n}', { n: p.level })}</span>` : ''} <span class="faint small mono">${t('{pp} PP', { pp: p.pp })}</span></div>
              ${leveled ? html`<${PlusButton} qt=${info ? qt : null} label=${t('+1 niveau')} onClick=${() => open(req)} />` : ''}
            </li>`;
          })}
        </ul>`
      : html`<div class="muted small">${t('Aucun pouvoir.')}</div>`}
    ${items.length
      ? html`<${SearchBox} value=${search} onChange=${setSearch} placeholder=${t('Chercher un pouvoir (Réflexes améliorés, Coup critique…)')} />
        <ul class="training-catalog">
          ${shown.map((i) => {
            const info = powerInfo(i);
            const has = owned.some((p) => p.catalogId === i.id || norm(p.name) === norm(catalogName(i)) || norm(p.name) === norm(i.name));
            const req = { kind: 'power', catalogId: i.id, name: catalogName(i), pp: info.pp, levels: info.levels, maxLevel: info.maxLevel, to: 1 };
            const qt = has ? null : q(req);
            const cost = info.levels ? t('{pp} PP par niveau', { pp: info.pp }) : t('{pp} PP', { pp: info.pp });
            const source = `${i.source || ''} ${i.page ? `p.${i.page}` : ''}`;
            return html`<li key=${i.id} class=${has ? 'owned' : ''}>
              <div class="grow">
                <strong>${itemName(i)}</strong>
                <div class="small muted">${cost}${info.maxLevel ? ` · ${t('max {n}', { n: info.maxLevel })}` : ''} · ${source}</div>
              </div>
              ${has ? html`<${Badge} color="green">${t('acquis')}</${Badge}>` : html`<${PlusButton} qt=${qt} label=${t('Choisir')} onClick=${() => open(req)} />`}
            </li>`;
          })}
          ${!shown.length && html`<li class="muted small">${t('Aucun pouvoir ne correspond.')}</li>`}
        </ul>`
      : html`<div class="muted small">${t('Catalogue des pouvoirs indisponible.')}</div>`}`;
}

function ComplexFormsSection({ actor, q, open }) {
  const [name, setName] = useState('');
  const known = actor.complexForms || [];
  const req = name.trim() ? { kind: 'complexForm', name: name.trim() } : null;
  const qt = req ? q(req) : null;
  return html`<div class="section-title">${t('Formes complexes ({n})', { n: known.length })} <${Rule} kind="complexForm" /></div>
    ${known.length ? html`<div class="small muted training-known">${known.map((s) => s.name).join(' · ')}</div>` : ''}
    <div class="training-learn">
      <${Field} label=${t('Forme complexe')}><${TextInput} live value=${name} placeholder=${t('ex. Nettoyeur, Pointeur…')} onChange=${setName} /></${Field}>
      <div class="training-learn-cta">${qt && html`<${CostCell} qt=${qt} />`}<${Button} variant="primary" disabled=${!req || !!qt?.error} onClick=${() => req && open(req)}>${t('Apprendre…')}</${Button}></div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
function OtherTab({ q, open, isGM }) {
  const [name, setName] = useState('');
  const [karma, setKarma] = useState(0);
  const [days, setDays] = useState(0);
  const req = name.trim() ? { kind: 'other', name: name.trim(), karma, days } : null;
  const qt = req ? q(req) : null;
  return html`<div class="training-hint small muted">${isGM
      ? t('Tout ce qui sort des cases : rituel spécial, cyber-entraînement, apprentissage d’un style d’arts martiaux, ajustement exceptionnel… Appliqué tel quel (pense à modifier la fiche).')
      : t('Tout ce qui sort des cases : rituel spécial, cyber-entraînement, apprentissage d’un style d’arts martiaux, ajustement exceptionnel… Le MJ valide toujours ces demandes et met la fiche à jour.')} <${Rule} kind="other" /></div>
    <div class="training-learn">
      <${Field} label=${t('Description')}><${TextInput} live value=${name} placeholder=${t('ex. Style d’arts martiaux : Krav Maga')} onChange=${setName} /></${Field}>
      <${Field} label=${t('Karma')}><${NumberInput} value=${karma} min=${0} max=${500} onChange=${setKarma} /></${Field}>
      <${Field} label=${t('Durée (jours)')}><${NumberInput} value=${days} min=${0} max=${3650} onChange=${setDays} /></${Field}>
      <div class="training-learn-cta">${qt && html`<${CostCell} qt=${qt} />`}<${Button} variant="primary" disabled=${!req || !!qt?.error} onClick=${() => req && open(req)}>${isGM ? t('Préparer…') : t('Proposer au MJ…')}</${Button}></div>
    </div>`;
}
