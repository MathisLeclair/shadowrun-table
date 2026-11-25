// « Que veux-tu améliorer ? » — every way to spend karma, grouped by tabs. Picking something opens ConfirmModal.
import { useState } from 'preact/hooks';
import { html, Button, Tabs, SearchBox, Select, TextInput, NumberInput, Badge, Empty, Field } from '../../lib/ui.js';
import { useCatalog } from '../../lib/net.js';
import { ATTR_LABELS, SKILLS, SKILL_BY_ID, SKILL_GROUPS, SKILL_CATEGORIES } from '/shared/sr5.js';
import {
  TRAINABLE_ATTRS, KNOWLEDGE_TYPES, attrMax, skillRating, groupState, groupMembers, magicProfile, powerPoints, catalogName,
  qualityInfo, powerInfo, spellInfo, initiationGrade, submersionGrade,
} from '/shared/advancement.js';
import { slug } from '/shared/util.js';
import { makeQuoter, Rule, CostCell, MAGIC_TYPES } from './common.js';
import ConfirmModal from './ConfirmModal.js';

const norm = (s) => slug(String(s || '')).replace(/-/g, ' ');
const matches = (q, ...fields) => !q || fields.some((f) => norm(f).includes(norm(q)));
const ATTR_ORDER = ['physical', 'mental', 'special'];
const ATTR_KIND = { BOD: 'physical', AGI: 'physical', REA: 'physical', STR: 'physical', WIL: 'mental', LOG: 'mental', INT: 'mental', CHA: 'mental', EDG: 'special', MAG: 'special', RES: 'special' };
const ATTR_KIND_LABEL = { physical: 'Physiques', mental: 'Mentaux', special: 'Spéciaux' };

export default function AdvancePanel({ game, actor, isGM }) {
  const [tab, setTab] = useState('attributes');
  const [draft, setDraft] = useState(null);
  const q = makeQuoter(game, actor);
  const prof = magicProfile(actor);
  const awakened = prof.MAG > 0 || prof.RES > 0;
  const tabs = [
    { id: 'attributes', label: 'Attributs' },
    { id: 'skills', label: 'Compétences' },
    { id: 'groups', label: 'Groupes' },
    { id: 'knowledge', label: 'Connaissances' },
    { id: 'qualities', label: 'Qualités' },
    ...(awakened ? [{ id: 'magic', label: prof.RES > 0 && prof.MAG <= 0 ? 'Résonance' : 'Magie' }] : []),
    { id: 'other', label: 'Autre' },
  ];
  const current = tabs.find((t) => t.id === tab) ? tab : 'attributes';
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

/** "+1" button that opens the confirmation (disabled with the reason when impossible). */
function PlusButton({ qt, onClick, label = '+1' }) {
  return html`<${Button} small variant="primary" disabled=${!!qt?.error} title=${qt?.error || 'Voir le coût et confirmer'} onClick=${onClick}>${label}</${Button}>`;
}

// ---------------------------------------------------------------------------------------------
function AttributesTab({ actor, q, open }) {
  const keys = TRAINABLE_ATTRS.filter((k) => (k !== 'MAG' && k !== 'RES') || Number(actor.attributes?.[k]) > 0);
  return html`<div class="training-hint small muted">Un seul attribut à la fois. Le maximum dépend du métatype (${actor.metatype || 'Humain'})${keys.includes('MAG') ? ', et pour la Magie de l’essence et du grade d’initiation' : ''}. <${Rule} kind="attribute" /></div>
    <div class="training-table-wrap"><table class="sr training-table">
      <thead><tr><th>Attribut</th><th class="center">Actuel</th><th class="center">Max</th><th>Rang suivant</th><th></th></tr></thead>
      ${ATTR_ORDER.map((group) => {
        const list = keys.filter((k) => ATTR_KIND[k] === group);
        if (!list.length) return null;
        return html`<tbody key=${group}>
          <tr class="training-subhead"><td colspan="5">${ATTR_KIND_LABEL[group]}</td></tr>
          ${list.map((k) => {
            const cur = Number(actor.attributes?.[k]) || 0;
            const max = attrMax(actor, k);
            const qt = q({ kind: 'attribute', target: k });
            const aug = Number(actor.augmented?.[k]) || 0;
            return html`<tr key=${k} class=${cur >= max ? 'training-maxed' : ''}>
              <td><strong>${ATTR_LABELS[k]}</strong> <span class="muted small mono">${k}</span></td>
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
    .filter((s) => matches(search, s.name, SKILL_BY_ID[s.id]?.fr, s.spec))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const learnable = SKILLS.filter((s) => skillRating(actor, s.id) === 0)
    .filter((s) => (s.cat !== 'magic' || prof.MAG > 0) && (s.cat !== 'resonance' || prof.RES > 0));
  const byCat = Object.entries(SKILL_CATEGORIES)
    .map(([cat, label]) => ({ label, list: learnable.filter((s) => s.cat === cat).sort((a, b) => a.fr.localeCompare(b.fr, 'fr')) }))
    .filter((g) => g.list.length);
  const learnReq = newId === '__custom' ? { kind: 'skill', target: '', name: customName.trim(), attr: customAttr, to: 1 } : newId ? { kind: 'skill', target: newId, to: 1 } : null;
  const learnQt = learnReq ? q(learnReq) : null;

  return html`<div class="row spread wrap training-toolbar">
      <${SearchBox} value=${search} onChange=${setSearch} placeholder="Filtrer mes compétences…" />
      <span class="small muted">Rangs 1–4 : quelques jours · 5–8 : semaines · 9+ : longues semaines <${Rule} kind="skill" /></span>
    </div>
    ${owned.length
      ? html`<div class="training-table-wrap"><table class="sr training-table">
          <thead><tr><th>Compétence</th><th class="center">Rang</th><th>Rang suivant</th><th></th></tr></thead>
          <tbody>
            ${owned.map((s) => {
              const rating = skillRating(actor, s.id);
              const qt = q({ kind: 'skill', target: s.id });
              const def = SKILL_BY_ID[s.id];
              return html`<tr key=${s.id}>
                <td>
                  <strong>${s.name}</strong> <span class="muted small mono">${s.attr || def?.attr || ''}</span>
                  ${def?.group && html` <span class="faint small">· ${SKILL_GROUPS[def.group]}</span>`}
                  ${s.spec && html`<div class="small cyan">↳ ${s.spec}</div>`}
                </td>
                <td class="center mono">${rating}</td>
                <td><${CostCell} qt=${qt} />${!qt.error && qt.warnings.length ? html`<div class="small amber">⚠ ${qt.warnings.join(', ')}</div>` : ''}</td>
                <td class="right nowrap">
                  <${Button} small variant="ghost" title="Spécialisation : 7 karma · 1 mois" onClick=${() => open({ kind: 'specialization', target: s.id })}>Spé.</${Button}>
                  <${PlusButton} qt=${qt} onClick=${() => open({ kind: 'skill', target: s.id })} />
                </td>
              </tr>`;
            })}
          </tbody>
        </table></div>`
      : html`<${Empty}>${search ? 'Aucune compétence ne correspond.' : 'Aucune compétence active.'}</${Empty}>`}

    <div class="section-title">Apprendre une nouvelle compétence</div>
    <div class="training-learn">
      <${Field} label="Compétence">
        <select class="input" value=${newId} onChange=${(e) => setNewId(e.target.value)}>
          <option value="">— Choisir —</option>
          ${byCat.map((g) => html`<optgroup label=${g.label}>${g.list.map((s) => html`<option value=${s.id} selected=${s.id === newId}>${s.fr} (${s.attr})</option>`)}</optgroup>`)}
          <option value="__custom" selected=${newId === '__custom'}>Autre (arme exotique, pilotage particulier…)</option>
        </select>
      </${Field}>
      ${newId === '__custom' &&
      html`<${Field} label="Nom"><${TextInput} live value=${customName} placeholder="ex. Arme exotique (fouet monofilament)" onChange=${setCustomName} /></${Field}>
        <${Field} label="Attribut lié"><${Select} value=${customAttr} onChange=${setCustomAttr} options=${['AGI', 'BOD', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA'].map((k) => ({ value: k, label: ATTR_LABELS[k] }))} /></${Field}>`}
      <div class="training-learn-cta">
        ${learnQt && html`<${CostCell} qt=${learnQt} />`}
        <${Button} variant="primary" disabled=${!learnReq || !!learnQt?.error} onClick=${() => learnReq && open(learnReq)}>Apprendre…</${Button}>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
function GroupsTab({ actor, q, open, prof }) {
  const groups = Object.entries(SKILL_GROUPS).filter(([gid]) => {
    const cats = groupMembers(gid).map((id) => SKILL_BY_ID[id]?.cat);
    if (cats.includes('magic') && prof.MAG <= 0) return false;
    if (cats.includes('resonance') && prof.RES <= 0) return false;
    return true;
  });
  return html`<div class="training-hint small muted">
      Un groupe se rompt dès qu’une de ses compétences est augmentée seule ou spécialisée. Pour le reconstituer, remonte toutes ses compétences au même indice. <${Rule} kind="skillGroup" />
    </div>
    <div class="training-table-wrap"><table class="sr training-table">
      <thead><tr><th>Groupe</th><th class="center">Rang</th><th>Rang suivant</th><th></th></tr></thead>
      <tbody>
        ${groups.map(([gid, name]) => {
          const g = groupState(actor, gid);
          const qt = q({ kind: 'skillGroup', target: gid });
          const members = groupMembers(gid).map((id) => SKILL_BY_ID[id]?.fr || id);
          return html`<tr key=${gid} class=${g.intact ? '' : 'training-broken'}>
            <td>
              <strong>${name}</strong>
              ${!g.intact ? html` <${Badge} color="red" title=${g.reason}>rompu</${Badge}>` : g.owned ? html` <${Badge} color="cyan">intact</${Badge}>` : ''}
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
  const list = [...(actor.knowledge || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const newReq = name.trim().length >= 2 ? { kind: 'knowledge', name: name.trim(), ktype, to: 1 } : null;
  const newQt = newReq ? q(newReq) : null;
  return html`<div class="training-hint small muted">Connaissances de la rue, académiques, professionnelles, centres d’intérêt et langues. <${Rule} kind="knowledge" /></div>
    ${list.length
      ? html`<div class="training-table-wrap"><table class="sr training-table">
          <thead><tr><th>Connaissance</th><th class="center">Rang</th><th>Rang suivant</th><th></th></tr></thead>
          <tbody>
            ${list.map((k) => {
              const qt = k.native ? null : q({ kind: 'knowledge', target: k.id });
              return html`<tr key=${k.id}>
                <td><strong>${k.name}</strong> <span class="faint small">${KNOWLEDGE_TYPES[k.type] || ''}</span>${k.spec && html`<div class="small cyan">↳ ${k.spec}</div>`}</td>
                <td class="center mono">${k.native ? 'N' : k.rating || 0}</td>
                <td>${k.native ? html`<span class="muted small">Langue maternelle</span>` : html`<${CostCell} qt=${qt} />`}</td>
                <td class="right nowrap">
                  ${!k.native && (Number(k.rating) || 0) > 0 && html`<${Button} small variant="ghost" title="Spécialisation : 7 karma · 1 mois" onClick=${() => open({ kind: 'specialization', target: k.id })}>Spé.</${Button}>`}
                  ${qt && html`<${PlusButton} qt=${qt} onClick=${() => open({ kind: 'knowledge', target: k.id })} />`}
                </td>
              </tr>`;
            })}
          </tbody>
        </table></div>`
      : html`<${Empty}>Aucune connaissance pour l’instant.</${Empty}>`}
    <div class="section-title">Nouvelle connaissance ou langue</div>
    <div class="training-learn">
      <${Field} label="Nom"><${TextInput} live value=${name} placeholder="ex. Gangs de Redmond, Japonais, Politique corpo…" onChange=${setName} /></${Field}>
      <${Field} label="Type"><${Select} value=${ktype} onChange=${setKtype} options=${Object.entries(KNOWLEDGE_TYPES).map(([value, label]) => ({ value, label }))} /></${Field}>
      <div class="training-learn-cta">
        ${newQt && html`<${CostCell} qt=${newQt} />`}
        <${Button} variant="primary" disabled=${!newReq || !!newQt?.error} onClick=${() => newReq && open(newReq)}>Apprendre…</${Button}>
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
  const positives = (Array.isArray(catalog) ? catalog : [])
    .map((item) => ({ item, info: qualityInfo(item), name: catalogName(item) }))
    .filter((x) => x.info.positive && x.info.karma > 0 && matches(search, x.name, x.item.name));
  const shown = positives.sort((a, b) => a.name.localeCompare(b.name, 'fr')).slice(0, 60);
  const has = (x) => owned.some((o) => o.catalogId === x.item.id || norm(o.name) === norm(x.name) || norm(o.name) === norm(x.item.name));
  const manualReq = manualName.trim() ? { kind: 'quality', name: manualName.trim(), karma: manualKarma } : null;
  const manualQt = manualReq ? q(manualReq) : null;

  return html`<div class="section-title">Qualités actuelles</div>
    ${owned.length
      ? html`<ul class="training-qualities">
          ${owned.map((o) => {
            const negative = o.positive === false || Number(o.karma) < 0;
            const qt = negative ? q({ kind: 'removeQuality', target: o.id }) : null;
            return html`<li key=${o.id || o.name}>
              <${Badge} color=${negative ? 'red' : 'green'}>${negative ? '−' : '+'}</${Badge}>
              <span class="grow">${o.name} <span class="faint small mono">${Math.abs(Number(o.karma) || 0) || ''}</span></span>
              ${negative &&
              html`<span class="row gap-s"><${CostCell} qt=${qt} /><${PlusButton} qt=${qt} label="Racheter" onClick=${() => open({ kind: 'removeQuality', target: o.id })} /></span>`}
            </li>`;
          })}
        </ul>`
      : html`<div class="muted small">Aucune qualité.</div>`}

    <div class="section-title">Acquérir une qualité positive <${Rule} kind="quality" /></div>
    ${catalog.length
      ? html`<${SearchBox} value=${search} onChange=${setSearch} placeholder="Chercher une qualité (Ambidextre, Sang-froid…)" />
          <ul class="training-catalog">
            ${shown.map((x) => {
              const owns = has(x);
              const req = { kind: 'quality', catalogId: x.item.id, name: x.name, karma: x.info.karma };
              const qt = owns ? null : q(req);
              return html`<li key=${x.item.id} class=${owns ? 'owned' : ''}>
                <div class="grow">
                  <strong>${x.name}</strong>${x.item.nameFr && x.item.name !== x.item.nameFr ? html` <span class="faint small">${x.item.name}</span>` : ''}
                  <div class="small muted">${x.info.karma} karma de qualité · ${x.item.source || ''} ${x.item.page ? `p.${x.item.page}` : ''}</div>
                </div>
                ${owns ? html`<${Badge} color="green">possédée</${Badge}>` : html`<${CostCell} qt=${qt} /><${PlusButton} qt=${qt} label="Choisir" onClick=${() => open(req)} />`}
              </li>`;
            })}
            ${!shown.length && html`<li class="muted small">Aucune qualité ne correspond.</li>`}
          </ul>
          ${positives.length > shown.length && html`<div class="small faint">${positives.length - shown.length} autres résultats — affine la recherche.</div>`}`
      : html`<div class="muted small">Catalogue des qualités indisponible : utilise la saisie manuelle.</div>`}

    <div class="section-title">Saisie manuelle</div>
    <div class="training-learn">
      <${Field} label="Qualité"><${TextInput} live value=${manualName} placeholder="Nom de la qualité" onChange=${setManualName} /></${Field}>
      <${Field} label="Karma de la qualité"><${NumberInput} value=${manualKarma} min=${1} max=${50} onChange=${setManualKarma} /></${Field}>
      <div class="training-learn-cta">
        ${manualQt && html`<${CostCell} qt=${manualQt} />`}
        <${Button} disabled=${!manualReq || !!manualQt?.error} onClick=${() => manualReq && open(manualReq)}>Proposer au MJ…</${Button}>
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
      <${Badge} color="magenta">${MAGIC_TYPES[prof.type] || 'Éveillé'}</${Badge}>
      ${prof.MAG > 0 && html`<span class="small">Magie <strong class="mono">${prof.MAG}</strong></span>`}
      ${prof.RES > 0 && html`<span class="small">Résonance <strong class="mono">${prof.RES}</strong></span>`}
      <span class="small">${sub ? 'Submersion' : 'Initiation'} : grade <strong class="mono">${grade}</strong></span>
    </div>

    <div class="section-title">${sub ? 'Submersion' : 'Initiation'} <${Rule} kind="initiation" /></div>
    <div class="training-row-card">
      <div class="grow">
        <strong>Grade ${grade + 1}</strong>
        <div class="small muted">${sub ? 'Augmente le maximum de Résonance de 1 et donne accès à un écho.' : 'Augmente le maximum de Magie de 1 et donne accès à une métamagie.'}</div>
        ${Array.isArray(metas) && metas.length ? html`<div class="small cyan">Acquis : ${metas.join(', ')}</div>` : ''}
      </div>
      <${CostCell} qt=${initQt} />
      <${PlusButton} qt=${initQt} label="S’initier…" onClick=${() => open({ kind: 'initiation', options: {} })} />
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
  const shown = [...list].sort((a, b) => catalogName(a).localeCompare(catalogName(b), 'fr')).slice(0, 50);
  const knows = (s) => known.some((k) => k.catalogId === s.id || norm(k.name) === norm(catalogName(s)) || norm(k.name) === norm(s.name));
  const manualReq = manual.trim() ? { kind: 'spell', name: manual.trim() } : null;
  return html`<div class="section-title">Sorts (${known.length} connus) <${Rule} kind="spell" /></div>
    ${known.length ? html`<div class="small muted training-known">${known.map((s) => s.name).join(' · ')}</div>` : ''}
    ${catalog.length
      ? html`<${SearchBox} value=${search} onChange=${setSearch} placeholder="Chercher un sort (Boule de feu, Soins…)" />
        <ul class="training-catalog">
          ${shown.map((s) => {
            const info = spellInfo(s);
            const k = knows(s);
            const req = { kind: 'spell', catalogId: s.id, name: catalogName(s), data: info };
            const qt = k ? null : q(req);
            return html`<li key=${s.id} class=${k ? 'owned' : ''}>
              <div class="grow">
                <strong>${catalogName(s)}</strong>
                <div class="small muted">${[info.category, info.type, info.range, info.duration, info.drain && `Drain ${info.drain}`].filter(Boolean).join(' · ')}</div>
              </div>
              ${k ? html`<${Badge} color="green">connu</${Badge}>` : html`<${CostCell} qt=${qt} /><${PlusButton} qt=${qt} label="Apprendre" onClick=${() => open(req)} />`}
            </li>`;
          })}
          ${!shown.length && html`<li class="muted small">Aucun sort ne correspond.</li>`}
        </ul>
        ${list.length > shown.length && html`<div class="small faint">${list.length - shown.length} autres résultats — affine la recherche.</div>`}`
      : ''}
    <div class="training-learn">
      <${Field} label="Sort, rituel ou préparation (saisie manuelle)"><${TextInput} live value=${manual} placeholder="Nom" onChange=${setManual} /></${Field}>
      <div class="training-learn-cta"><${Button} disabled=${!manualReq || !!(manualReq && q(manualReq).error)} title=${manualReq ? q(manualReq).error || '' : ''} onClick=${() => manualReq && open(manualReq)}>Proposer au MJ…</${Button}></div>
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
  const shown = [...list].sort((a, b) => catalogName(a).localeCompare(catalogName(b), 'fr')).slice(0, 50);
  const ppQt = prof.type === 'mystic' ? q({ kind: 'powerPoint' }) : null;
  return html`<div class="section-title">Pouvoirs d’adepte <${Rule} kind="power" /></div>
    <div class="row wrap training-pp">
      <span>Points de pouvoir : <strong class="mono cyan">${pp.free}</strong> libres sur <span class="mono">${pp.total}</span></span>
      ${prof.type === 'adept' && html`<span class="small muted">(PP = Magie${pp.extra ? ` + ${pp.extra} gagné(s) par l’initiation` : ''}. Augmenter la Magie donne 1 PP.)</span>`}
      ${ppQt && html`<span class="row gap-s"><${CostCell} qt=${ppQt} /><${PlusButton} qt=${ppQt} label="+1 PP" onClick=${() => open({ kind: 'powerPoint' })} /></span>`}
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
              <div class="grow"><strong>${p.name}</strong>${p.level ? html` <span class="mono">niv. ${p.level}</span>` : ''} <span class="faint small mono">${p.pp} PP</span></div>
              ${leveled ? html`<${PlusButton} qt=${info ? qt : null} label="+1 niveau" onClick=${() => open(req)} />` : ''}
            </li>`;
          })}
        </ul>`
      : html`<div class="muted small">Aucun pouvoir.</div>`}
    ${items.length
      ? html`<${SearchBox} value=${search} onChange=${setSearch} placeholder="Chercher un pouvoir (Réflexes améliorés, Coup critique…)" />
        <ul class="training-catalog">
          ${shown.map((i) => {
            const info = powerInfo(i);
            const has = owned.some((p) => p.catalogId === i.id || norm(p.name) === norm(catalogName(i)) || norm(p.name) === norm(i.name));
            const req = { kind: 'power', catalogId: i.id, name: catalogName(i), pp: info.pp, levels: info.levels, maxLevel: info.maxLevel, to: 1 };
            const qt = has ? null : q(req);
            return html`<li key=${i.id} class=${has ? 'owned' : ''}>
              <div class="grow">
                <strong>${catalogName(i)}</strong>
                <div class="small muted">${info.pp} PP${info.levels ? ' par niveau' : ''}${info.maxLevel ? ` · max ${info.maxLevel}` : ''} · ${i.source || ''} ${i.page ? `p.${i.page}` : ''}</div>
              </div>
              ${has ? html`<${Badge} color="green">acquis</${Badge}>` : html`<${PlusButton} qt=${qt} label="Choisir" onClick=${() => open(req)} />`}
            </li>`;
          })}
          ${!shown.length && html`<li class="muted small">Aucun pouvoir ne correspond.</li>`}
        </ul>`
      : html`<div class="muted small">Catalogue des pouvoirs indisponible.</div>`}`;
}

function ComplexFormsSection({ actor, q, open }) {
  const [name, setName] = useState('');
  const known = actor.complexForms || [];
  const req = name.trim() ? { kind: 'complexForm', name: name.trim() } : null;
  const qt = req ? q(req) : null;
  return html`<div class="section-title">Formes complexes (${known.length}) <${Rule} kind="complexForm" /></div>
    ${known.length ? html`<div class="small muted training-known">${known.map((s) => s.name).join(' · ')}</div>` : ''}
    <div class="training-learn">
      <${Field} label="Forme complexe"><${TextInput} live value=${name} placeholder="ex. Nettoyeur, Pointeur…" onChange=${setName} /></${Field}>
      <div class="training-learn-cta">${qt && html`<${CostCell} qt=${qt} />`}<${Button} variant="primary" disabled=${!req || !!qt?.error} onClick=${() => req && open(req)}>Apprendre…</${Button}></div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
function OtherTab({ q, open, isGM }) {
  const [name, setName] = useState('');
  const [karma, setKarma] = useState(0);
  const [days, setDays] = useState(0);
  const req = name.trim() ? { kind: 'other', name: name.trim(), karma, days } : null;
  const qt = req ? q(req) : null;
  return html`<div class="training-hint small muted">Tout ce qui sort des cases : rituel spécial, cyber-entraînement, apprentissage d’un style d’arts martiaux, ajustement exceptionnel… ${isGM ? 'Appliqué tel quel (pense à modifier la fiche).' : 'Le MJ valide toujours ces demandes et met la fiche à jour.'} <${Rule} kind="other" /></div>
    <div class="training-learn">
      <${Field} label="Description"><${TextInput} live value=${name} placeholder="ex. Style d’arts martiaux : Krav Maga" onChange=${setName} /></${Field}>
      <${Field} label="Karma"><${NumberInput} value=${karma} min=${0} max=${500} onChange=${setKarma} /></${Field}>
      <${Field} label="Durée (jours)"><${NumberInput} value=${days} min=${0} max=${3650} onChange=${setDays} /></${Field}>
      <div class="training-learn-cta">${qt && html`<${CostCell} qt=${qt} />`}<${Button} variant="primary" disabled=${!req || !!qt?.error} onClick=${() => req && open(req)}>${isGM ? 'Préparer…' : 'Proposer au MJ…'}</${Button}></div>
    </div>`;
}
