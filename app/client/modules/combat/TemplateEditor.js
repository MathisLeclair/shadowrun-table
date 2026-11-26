// Structured editor for a bestiary template (works on a local draft, saved in one action).
import { useState, useMemo } from 'preact/hooks';
import { html, Button, IconButton, Modal, Tabs, Panel, TextInput, NumberInput, Select, Toggle, SearchBox, Empty, Badge } from '../../lib/ui.js';
import { useCatalog, upload } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tk, attrLabel, attrShort, skillLabel, skillCategoryLabel, itemName, getLang } from '../../lib/i18n.js';
import { SKILLS, SKILL_BY_ID, SKILL_CATEGORIES, METATYPES } from '/shared/sr5.js';
import { uid, deepClone } from '/shared/util.js';
import { npcKindOptions, initModeOptions, dispoLabel, poolFor, safeDerive } from './combat-common.js';
import StatBlock from './StatBlock.js';

const EDIT_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES'];
const attrOptions = () => EDIT_ATTRS.map((k) => ({ value: k, label: attrShort(k) }));
const COMBAT_SKILLS = SKILLS.filter((s) => ['combat', 'vehicle'].includes(s.cat) || ['unarmed_combat', 'cybercombat', 'spellcasting'].includes(s.id));
const METATYPE_OPTIONS = [...Object.keys(METATYPES), 'Créature', 'Esprit', 'Drone', 'IC', 'Host', 'Autre'];

/** Label + control without a <label> wrapper (avoids nested-label clicks on steppers/toggles). */
function F({ label, hint, children, class: klass }) {
  return html`<div class=${'field' + (klass ? ' ' + klass : '')}><span class="field-label">${label}</span>${children}${hint && html`<span class="field-hint">${hint}</span>`}</div>`;
}

/** Immutable set: setIn(obj, ['a', 'b'], v). */
function setIn(obj, pathArr, value) {
  if (!pathArr.length) return value;
  const [k, ...rest] = pathArr;
  const base = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  base[k] = setIn(base[k], rest, value);
  return base;
}

/** Native select with SR5 skills grouped by category (+ current custom value). */
function SkillSelect({ value, onChange, only }) {
  const list = only || SKILLS;
  const cats = Object.keys(SKILL_CATEGORIES).map((cat) => ({ cat, label: skillCategoryLabel(cat), skills: list.filter((s) => s.cat === cat) })).filter((g) => g.skills.length);
  const custom = value && !SKILL_BY_ID[value];
  return html`<select class="input" value=${value || ''} onChange=${(e) => onChange(e.target.value)}>
    <option value="" selected=${!value}>—</option>
    ${custom && html`<option value=${value} selected>${t('{name} (perso)', { name: value })}</option>`}
    ${cats.map((g) => html`<optgroup label=${g.label}>${g.skills.map((s) => html`<option value=${s.id} selected=${s.id === value}>${skillLabel(s)}</option>`)}</optgroup>`)}
  </select>`;
}

/**
 * Generic table editor for item lists.
 * cols: [{ key, label, type: 'text'|'num'|'bool'|'select'|'custom', options?, width?, render?(item, set) }]
 */
function ListEditor({ items, onChange, cols, newItem, addLabel, extra }) {
  const list = items || [];
  const update = (i, key, v) => onChange(list.map((it, j) => (j === i ? { ...it, [key]: v } : it)));
  const remove = (i) => onChange(list.filter((_, j) => j !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return html`<div class="col">
    ${list.length > 0 &&
    html`<div class="bed-list-wrap"><table class="bed-list">
      <thead><tr>${cols.map((c) => html`<th style=${{ width: c.width || '' }}>${c.label}</th>`)}<th style=${{ width: '64px' }}></th></tr></thead>
      <tbody>${list.map(
        (it, i) => html`<tr key=${`${it.id}-${i}`}>
          ${cols.map((c) => {
            const set = (v) => update(i, c.key, v);
            let ctl;
            if (c.type === 'custom') ctl = c.render(it, (patch) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x))));
            else if (c.type === 'num') ctl = html`<${NumberInput} small value=${Number(it[c.key]) || 0} min=${c.min ?? -99} max=${c.max ?? 999} step=${c.step || 1} onChange=${(v) => set(c.step && c.step < 1 ? Math.round(v * 100) / 100 : v)} />`;
            else if (c.type === 'bool') ctl = html`<${Toggle} value=${!!it[c.key]} onChange=${set} />`;
            else if (c.type === 'select') ctl = html`<${Select} value=${it[c.key] ?? ''} options=${c.options} onChange=${set} />`;
            else ctl = html`<${TextInput} live value=${it[c.key] ?? ''} placeholder=${c.placeholder || ''} onChange=${set} />`;
            return html`<td>${ctl}</td>`;
          })}
          <td class="row gap-s" style=${{ flexWrap: 'nowrap' }}>
            <${IconButton} icon="↑" title=${t('Monter')} onClick=${() => move(i, -1)} />
            <${IconButton} icon="✕" title=${t('Supprimer')} onClick=${() => remove(i)} />
          </td>
        </tr>`
      )}</tbody>
    </table></div>`}
    <div class="row wrap">
      <${Button} small onClick=${() => onChange([...list, { id: uid('it'), ...newItem() }])}>+ ${addLabel || t('Ajouter')}</${Button}>
      ${extra}
    </div>
  </div>`;
}

/** Catalog picker (weapons / armor). Catalogs may be empty during development. */
function CatalogPicker({ name, onPick, onClose }) {
  const items = useCatalog(name);
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (items || []).filter((it) => !needle || `${it.nameFr || ''} ${it.name || ''} ${it.categoryFr || ''} ${it.category || ''}`.toLowerCase().includes(needle));
    return list.slice(0, 80);
  }, [items, q]);
  return html`<${Panel} title=${name === 'weapons' ? t('Catalogue d’armes') : t('Catalogue d’armures')} actions=${html`<${IconButton} icon="✕" title=${t('Fermer le catalogue')} onClick=${onClose} />`}>
    <div class="bed-cat">
      <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Nom, catégorie…')} />
      ${!items.length
        ? html`<${Empty}>${t('Catalogue indisponible (pas encore généré). Ajoute l’objet à la main.')}</${Empty}>`
        : html`<div class="bed-cat-list">
            ${filtered.map((it) => {
              const s = it.stats || {};
              const info = name === 'weapons'
                ? [s.damage, s.ap ? t('PA {n}', { n: s.ap }) : '', s.mode, s.accuracy ? t('Préc {n}', { n: s.accuracy }) : ''].filter(Boolean).join(' · ')
                : t('Armure {n}', { n: s.armor ?? '?' });
              const category = getLang() === 'fr' ? it.categoryFr || it.category || '' : it.category || it.categoryFr || '';
              return html`<div class="bed-cat-item" onClick=${() => onPick(it)}>
                <span class="grow"><strong>${itemName(it)}</strong> <span class="faint small">${category}</span></span>
                <span class="mono small muted">${info}</span>
              </div>`;
            })}
            ${!filtered.length && html`<${Empty}>${t('Aucun résultat.')}</${Empty}>`}
          </div>`}
    </div>
  </${Panel}>`;
}

function weaponFromCatalog(it) {
  const s = it.stats || {};
  const n = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    id: uid('w'),
    name: itemName(it),
    category: getLang() === 'fr' ? it.categoryFr || it.category || '' : it.category || it.categoryFr || '',
    kind: s.type === 'melee' ? 'melee' : 'ranged',
    skill: s.skill || (s.type === 'melee' ? 'clubs' : 'pistols'),
    accuracy: n(s.accuracy),
    damage: String(s.damage || ''),
    ap: n(s.ap) || 0,
    mode: s.mode || '',
    rc: n(s.rc) || 0,
    ammo: s.ammo || '',
    reach: n(s.reach) || 0,
    catalogId: it.id,
  };
}
function armorFromCatalog(it) {
  const raw = String(it.stats?.armor ?? '0');
  return { id: uid('a'), name: itemName(it), rating: parseInt(raw.replace('+', ''), 10) || 0, stack: raw.trim().startsWith('+'), equipped: true, catalogId: it.id };
}

const TABS = [
  { id: 'id', label: tk('Identité') },
  { id: 'attr', label: tk('Attributs') },
  { id: 'skills', label: tk('Compétences') },
  { id: 'gear', label: tk('Armes & armure') },
  { id: 'magic', label: tk('Pouvoirs & sorts') },
  { id: 'notes', label: tk('Notes & tactique') },
  { id: 'preview', label: tk('Aperçu') },
];
/** Stored spell categories (French values) for the spell list editor. */
const SPELL_CATS = [tk('Combat'), tk('Détection'), tk('Santé'), tk('Illusion'), tk('Manipulation')];
const DEFAULT_FOLDER = 'Divers';

/** props: { template, folders: [string], onSave(draft) → Promise, onClose } */
export default function TemplateEditor({ template, folders, onSave, onClose }) {
  const [draft, setDraft] = useState(() => {
    const tpl = deepClone(template);
    tpl.npc = tpl.npc || {};
    tpl.attributes = tpl.attributes || {};
    tpl.initiative = tpl.initiative || { dice: 1, bonus: 0 };
    return tpl;
  });
  const [initialJson] = useState(() => JSON.stringify(draft));
  const [tab, setTab] = useState('id');
  const [picker, setPicker] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (pathArr, v) => setDraft((d) => setIn(d, pathArr, v));
  const d = safeDerive(draft);
  const hasMonitors = !!draft.monitors;

  const requestClose = () => {
    if (JSON.stringify(draft) !== initialJson && !window.confirm(t('Abandonner les modifications de ce modèle ?'))) return;
    onClose();
  };
  const save = async () => {
    if (!String(draft.name || '').trim()) return toast(t('Donne un nom au modèle'), 'warn');
    setSaving(true);
    try {
      // Explicit nulls so that removed optional blocks are removed server-side too.
      await onSave({ ...draft, monitors: draft.monitors || null, matrix: draft.matrix || null });
    } catch {
      /* toast shown by send() */
    }
    setSaving(false);
  };
  const uploadPortrait = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const r = await upload(f);
      set(['portrait'], r.url);
    } catch (err) {
      toast(err.message || t('Échec du téléversement'), 'error');
    }
  };

  const pickerEl =
    picker &&
    html`<${CatalogPicker} name=${picker} onClose=${() => setPicker(null)}
      onPick=${(it) => {
        if (picker === 'weapons') set(['weapons'], [...(draft.weapons || []), weaponFromCatalog(it)]);
        else set(['armor'], [...(draft.armor || []), armorFromCatalog(it)]);
        toast(t('{name} ajouté', { name: itemName(it) }), 'success', 1800);
      }} />`;

  let body;
  if (tab === 'id') {
    body = html`<div class="bed">
      <div class="bed-grid">
        <${F} label=${t('Nom')}><${TextInput} live value=${draft.name} onChange=${(v) => set(['name'], v)} /></${F}>
        <${F} label=${t('Dossier')}>
          <input class="input" list="bst-folders" value=${draft.folder || ''} onInput=${(e) => set(['folder'], e.target.value)} />
          <datalist id="bst-folders">${folders.map((f) => html`<option value=${f} />`)}</datalist>
        </${F}>
        <${F} label=${t('Métatype / type')}>
          <input class="input" list="bst-metatypes" value=${draft.metatype || ''} onInput=${(e) => set(['metatype'], e.target.value)} />
          <datalist id="bst-metatypes">${METATYPE_OPTIONS.map((m) => html`<option value=${m} />`)}</datalist>
        </${F}>
        <${F} label=${t('Concept')}><${TextInput} live value=${draft.concept} onChange=${(v) => set(['concept'], v)} /></${F}>
        <${F} label=${t('Nature')}><${Select} value=${draft.npc.kind || 'metahuman'} options=${npcKindOptions()} onChange=${(v) => set(['npc', 'kind'], v)} /></${F}>
        <${F} label=${t('Attitude par défaut')}><${Select} value=${draft.disposition || 'hostile'} options=${['hostile', 'neutral', 'ally'].map((k) => ({ value: k, label: dispoLabel(k) }))} onChange=${(v) => set(['disposition'], v)} /></${F}>
        <${F} label=${t('Indice pro. (PR)')} hint=${t('0 à 7')}><${NumberInput} value=${draft.npc.professionalRating || 0} min=${0} max=${7} onChange=${(v) => set(['npc', 'professionalRating'], v)} /></${F}>
        <${F} label=${t('Sbire')} hint=${t('à jouer en groupe')}><${Toggle} value=${!!draft.npc.grunt} onChange=${(v) => set(['npc', 'grunt'], v)} label=${draft.npc.grunt ? t('Oui') : t('Non')} /></${F}>
      </div>
      <div class="bed-grid">
        <${F} label=${t('Couleur du token')}>
          <div class="row"><input type="color" value=${/^#[0-9a-f]{6}$/i.test(draft.color || '') ? draft.color : '#e05c5c'} onInput=${(e) => set(['color'], e.target.value)} />
          <${TextInput} live value=${draft.color} placeholder="#e05c5c" onChange=${(v) => set(['color'], v)} /></div>
        </${F}>
        <${F} label=${t('Portrait (URL)')} class="grow">
          <div class="row"><${TextInput} live value=${draft.portrait} placeholder="/uploads/…" onChange=${(v) => set(['portrait'], v)} />
          <label class="btn btn-sm">${t('Téléverser')}<input type="file" accept="image/*" style=${{ display: 'none' }} onChange=${uploadPortrait} /></label></div>
        </${F}>
        <${F} label=${t('Genre')}><${TextInput} live value=${draft.gender} onChange=${(v) => set(['gender'], v)} /></${F}>
      </div>
      <div class="section-title">${t('Vision (carte)')}</div>
      <div class="row wrap gap-l">
        <${Toggle} value=${!!draft.vision?.lowLight} onChange=${(v) => set(['vision', 'lowLight'], v)} label=${t('Vision nocturne')} />
        <${Toggle} value=${!!draft.vision?.thermo} onChange=${(v) => set(['vision', 'thermo'], v)} label=${t('Thermographique')} />
        <${F} label=${t('Vision dans le noir (cases)')}><${NumberInput} small value=${draft.vision?.darkRange || 0} min=${0} max=${60} onChange=${(v) => set(['vision', 'darkRange'], v)} /></${F}>
      </div>
    </div>`;
  } else if (tab === 'attr') {
    body = html`<div class="bed">
      <div class="bed-attrs">
        ${EDIT_ATTRS.map(
          (k) => html`<div class="bed-attr" title=${attrLabel(k)}>
            <span class="field-label"><span>${attrShort(k)}</span><span class="faint">${attrLabel(k)}</span></span>
            <${NumberInput} small value=${draft.attributes[k] ?? 0} min=${0} max=${30} onChange=${(v) => set(['attributes', k], v)} />
            <span class="field-hint row spread">${t('Augm.')} <${NumberInput} small value=${draft.augmented?.[k] || 0} min=${-4} max=${4} onChange=${(v) => set(['augmented', k], v)} /></span>
          </div>`
        )}
        <div class="bed-attr">
          <span class="field-label"><span>${attrShort('ESS')}</span><span class="faint">${t('Essence')}</span></span>
          <${NumberInput} small value=${draft.attributes.ESS ?? 6} min=${0} max=${6} step=${0.1} onChange=${(v) => set(['attributes', 'ESS'], Math.round(v * 100) / 100)} />
        </div>
      </div>
      <div class="section-title">${t('Initiative & moniteurs')}</div>
      <div class="bed-grid">
        <${F} label=${t('Dés d’initiative')} hint=${t('réflexes câblés, etc.')}><${NumberInput} value=${draft.initiative.dice || 1} min=${1} max=${5} onChange=${(v) => set(['initiative', 'dice'], v)} /></${F}>
        <${F} label=${t('Bonus d’initiative')}><${NumberInput} value=${draft.initiative.bonus || 0} min=${-20} max=${30} onChange=${(v) => set(['initiative', 'bonus'], v)} /></${F}>
        <${F} label=${t('Initiative au combat')}><${Select} value=${draft.npc.initMode || 'physical'} options=${initModeOptions()} onChange=${(v) => set(['npc', 'initMode'], v)} /></${F}>
        <${F} label=${t('Moniteurs personnalisés')} hint=${d ? t('auto : P {p} / É {s}', { p: 8 + Math.ceil((draft.attributes.BOD || 0) / 2), s: 8 + Math.ceil((draft.attributes.WIL || 0) / 2) }) : ''}>
          <${Toggle} value=${hasMonitors} onChange=${(v) => set(['monitors'], v ? { physical: d?.physicalMonitor ?? 10, stun: d?.stunMonitor ?? 10 } : undefined)} label=${hasMonitors ? t('Oui') : t('Auto')} />
        </${F}>
        ${hasMonitors && html`
          <${F} label=${t('Physique')}><${NumberInput} value=${draft.monitors.physical ?? 10} min=${0} max=${60} onChange=${(v) => set(['monitors', 'physical'], v)} /></${F}>
          <${F} label=${t('Étourdissant')} hint=${t('0 = aucun (IC, drone)')}><${NumberInput} value=${draft.monitors.stun ?? 10} min=${0} max=${60} onChange=${(v) => set(['monitors', 'stun'], v)} /></${F}>`}
      </div>
      ${d && html`<div class="small muted">${t('Initiative {init} · Défense {def} · Limites {limits}', { init: d.initiative.text, def: d.defense, limits: `${d.limits.physical}/${d.limits.mental}/${d.limits.social}` })}</div>`}
      <div class="section-title">${t('Matrice')}</div>
      ${draft.matrix
        ? html`<div class="bed-grid">
            <${F} label=${t('Appareil')}><${TextInput} live value=${draft.matrix.device} onChange=${(v) => set(['matrix', 'device'], v)} /></${F}>
            ${[['rating', tk('Indice')], ['attack', tk('Attaque')], ['sleaze', tk('Corruption')], ['dataProcessing', tk('Traitement')], ['firewall', tk('Firewall')]].map(
              ([k, label]) => html`<${F} label=${t(label)}><${NumberInput} small value=${draft.matrix[k] || 0} min=${0} max=${20} onChange=${(v) => set(['matrix', k], v)} /></${F}>`
            )}
            <${F} label=${t('Programmes (séparés par des virgules)')} class="grow">
              <${TextInput} live value=${(draft.matrix.programs || []).join(', ')} onChange=${(v) => set(['matrix', 'programs'], v.split(',').map((x) => x.trim()).filter(Boolean))} />
            </${F}>
            <div class="field"><span class="field-label"> </span><${Button} small variant="danger" onClick=${() => set(['matrix'], undefined)}>${t('Retirer')}</${Button}></div>
          </div>`
        : html`<${Button} small onClick=${() => set(['matrix'], { device: '', rating: 0, attack: 0, sleaze: 0, dataProcessing: 0, firewall: 0, programs: [] })}>${t('+ Ajouter un profil Matrice')}</${Button}>`}
    </div>`;
  } else if (tab === 'skills') {
    body = html`<div class="bed">
      <${ListEditor}
        items=${draft.skills}
        onChange=${(v) => set(['skills'], v)}
        addLabel=${t('Compétence')}
        newItem=${() => ({ id: 'perception', name: 'Perception', attr: 'INT', rating: 3 })}
        cols=${[
          {
            key: 'id',
            label: t('Compétence'),
            type: 'custom',
            render: (it, patch) => html`<${SkillSelect} value=${it.id} onChange=${(id) => {
              const def = SKILL_BY_ID[id];
              patch(def ? { id, name: def.fr, attr: def.attr, group: def.group || undefined } : { id });
            }} />`,
          },
          { key: 'name', label: t('Libellé'), type: 'text' },
          { key: 'attr', label: t('Attr.'), type: 'select', options: attrOptions(), width: '78px' },
          { key: 'rating', label: t('Indice'), type: 'num', min: 0, max: 20, width: '96px' },
          { key: 'spec', label: t('Spécialisation'), type: 'text' },
          { key: '_pool', label: t('Réserve'), type: 'custom', width: '60px', render: (it) => html`<span class="mono cyan">${poolFor(draft, it.id) ?? '—'}</span>` },
        ]}
        extra=${html`<span class="bst-hint">${t('Pour une compétence maison (autosoft, attaque d’IC…), choisis « — » puis renseigne le libellé.')}</span>`}
      />
      <div class="section-title">${t('Connaissances & langues')}</div>
      <${ListEditor}
        items=${draft.knowledge}
        onChange=${(v) => set(['knowledge'], v)}
        addLabel=${t('Connaissance')}
        newItem=${() => ({ name: '', rating: 3, type: 'street' })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text' },
          { key: 'type', label: t('Type'), type: 'select', width: '130px', options: [{ value: 'street', label: t('Rue') }, { value: 'academic', label: t('Académique') }, { value: 'professional', label: t('Professionnelle') }, { value: 'interest', label: t('Centre d’intérêt') }, { value: 'language', label: t('Langue') }] },
          { key: 'rating', label: t('Indice'), type: 'num', min: 0, max: 12, width: '96px' },
        ]}
      />
    </div>`;
  } else if (tab === 'gear') {
    body = html`<div class="bed">
      <div class="section-title">${t('Armes')}</div>
      <${ListEditor}
        items=${draft.weapons}
        onChange=${(v) => set(['weapons'], v)}
        addLabel=${t('Arme')}
        newItem=${() => ({ name: t('Nouvelle arme'), kind: 'ranged', skill: 'pistols', accuracy: 5, damage: '7P', ap: 0, mode: 'SA', rc: 0, ammo: '', reach: 0 })}
        extra=${html`<${Button} small variant="ghost" onClick=${() => setPicker('weapons')}>${t('Depuis le catalogue…')}</${Button}>`}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text', width: '170px' },
          { key: 'kind', label: t('Type'), type: 'select', width: '96px', options: [{ value: 'ranged', label: t('Distance') }, { value: 'melee', label: t('Mêlée') }] },
          {
            key: 'skill',
            label: t('Compétence'),
            type: 'custom',
            width: '150px',
            render: (it, patch) => html`<${SkillSelect} value=${it.skill} only=${COMBAT_SKILLS} onChange=${(skill) => patch({ skill })} />`,
          },
          { key: '_pool', label: t('Rés.'), type: 'custom', render: (it) => html`<span class="mono cyan">${poolFor(draft, it.skill) ?? '—'}</span>` },
          { key: 'accuracy', label: t('Préc.'), type: 'custom', width: '56px', render: (it, patch) => html`<input class="input" value=${it.accuracy ?? ''} placeholder=${t('phys.')} onInput=${(e) => patch({ accuracy: e.target.value === '' ? null : Number(e.target.value) || 0 })} />` },
          { key: 'damage', label: t('VD'), type: 'text', width: '86px', placeholder: '(STR+2)P' },
          { key: 'ap', label: t('PA'), type: 'num', min: -20, max: 10, width: '92px' },
          { key: 'mode', label: t('Mode'), type: 'text', width: '86px', placeholder: 'SA/TR' },
          { key: 'rc', label: t('RC'), type: 'num', min: 0, max: 20, width: '92px' },
          { key: 'ammo', label: t('Mun.'), type: 'text', width: '70px' },
          { key: 'notes', label: t('Notes'), type: 'text', width: '140px' },
        ]}
      />
      ${picker === 'weapons' && pickerEl}
      <div class="section-title">${t('Armure')}</div>
      <${ListEditor}
        items=${draft.armor}
        onChange=${(v) => set(['armor'], v)}
        addLabel=${t('Armure')}
        newItem=${() => ({ name: t('Veste pare-balles'), rating: 12, equipped: true, stack: false })}
        extra=${html`<${Button} small variant="ghost" onClick=${() => setPicker('armor')}>${t('Depuis le catalogue…')}</${Button}>`}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text' },
          { key: 'rating', label: t('Indice'), type: 'num', min: 0, max: 50, width: '96px' },
          { key: 'stack', label: t('Cumulable'), type: 'bool', width: '80px' },
          { key: 'equipped', label: t('armure::Portée'), type: 'bool', width: '70px' },
        ]}
      />
      ${picker === 'armor' && pickerEl}
      ${d && html`<div class="small muted">${t('Armure totale :')} <strong class="cyan">${d.armor}</strong> · ${t('Encaissement {n}', { n: d.soak })}</div>`}
      <div class="section-title">${t('Augmentations')}</div>
      <${ListEditor}
        items=${draft.augmentations}
        onChange=${(v) => set(['augmentations'], v)}
        addLabel=${t('Augmentation')}
        newItem=${() => ({ name: '', kind: 'cyberware', grade: 'standard', essence: 0.1 })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text' },
          { key: 'kind', label: t('Type'), type: 'select', width: '110px', options: [{ value: 'cyberware', label: t('Cyberware') }, { value: 'bioware', label: t('Bioware') }] },
          { key: 'grade', label: t('Grade'), type: 'select', width: '100px', options: ['standard', 'alpha', 'beta', 'delta', 'used'] },
          { key: 'essence', label: t('Essence'), type: 'num', min: 0, max: 6, step: 0.1, width: '96px' },
          { key: 'notes', label: t('Notes'), type: 'text' },
        ]}
      />
      <div class="section-title">${t('Équipement')}</div>
      <${ListEditor}
        items=${draft.gear}
        onChange=${(v) => set(['gear'], v)}
        addLabel=${t('Objet')}
        newItem=${() => ({ name: '', qty: 1 })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text' },
          { key: 'qty', label: t('Qté'), type: 'num', min: 0, max: 999, width: '96px' },
          { key: 'notes', label: t('Notes'), type: 'text' },
        ]}
      />
      <div class="section-title">${t('Véhicules & drones')}</div>
      <${ListEditor}
        items=${draft.vehicles}
        onChange=${(v) => set(['vehicles'], v)}
        addLabel=${t('Véhicule')}
        newItem=${() => ({ name: '', handling: '4', speed: 3, accel: 1, body: 4, armor: 4, pilot: 3, sensor: 3 })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text', width: '170px' },
          { key: 'handling', label: t('Mani.'), type: 'text', width: '56px' },
          { key: 'speed', label: t('Vit.'), type: 'num', min: 0, max: 20, width: '92px' },
          { key: 'body', label: t('Struct.'), type: 'num', min: 0, max: 40, width: '92px' },
          { key: 'armor', label: t('Blind.'), type: 'num', min: 0, max: 40, width: '92px' },
          { key: 'pilot', label: t('Pilote'), type: 'num', min: 0, max: 10, width: '92px' },
          { key: 'notes', label: t('Notes'), type: 'text' },
        ]}
      />
    </div>`;
  } else if (tab === 'magic') {
    body = html`<div class="bed">
      <div class="section-title">${t('Pouvoirs (adepte, critter)')}</div>
      <${ListEditor}
        items=${draft.powers}
        onChange=${(v) => set(['powers'], v)}
        addLabel=${t('Pouvoir')}
        newItem=${() => ({ name: '', pp: 0 })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text' },
          { key: 'level', label: t('Niveau'), type: 'num', min: 0, max: 20, width: '96px' },
          { key: 'notes', label: t('Effet / notes'), type: 'text' },
        ]}
      />
      <div class="section-title">${t('Sorts')}</div>
      <${ListEditor}
        items=${draft.spells}
        onChange=${(v) => set(['spells'], v)}
        addLabel=${t('Sort')}
        newItem=${() => ({ name: '', category: 'Combat', type: 'M', range: 'LdV', duration: 'I', drain: 'P-3' })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text', width: '160px' },
          { key: 'category', label: t('Catégorie'), type: 'select', width: '120px', options: SPELL_CATS.map((c) => ({ value: c, label: t(c) })) },
          { key: 'type', label: t('Type'), type: 'select', width: '64px', options: ['M', 'P'] },
          { key: 'range', label: t('Portée'), type: 'text', width: '70px' },
          { key: 'duration', label: t('Durée'), type: 'select', width: '64px', options: ['I', 'M', 'P'] },
          { key: 'drain', label: t('Drain'), type: 'text', width: '64px' },
          { key: 'notes', label: t('Notes'), type: 'text' },
        ]}
      />
      <div class="section-title">${t('Qualités')}</div>
      <${ListEditor}
        items=${draft.qualities}
        onChange=${(v) => set(['qualities'], v)}
        addLabel=${t('Qualité')}
        newItem=${() => ({ name: '', karma: 0, positive: true })}
        cols=${[
          { key: 'name', label: t('Nom'), type: 'text' },
          { key: 'positive', label: t('Positive'), type: 'bool', width: '70px' },
          { key: 'notes', label: t('Notes'), type: 'text' },
        ]}
      />
    </div>`;
  } else if (tab === 'notes') {
    body = html`<div class="bed">
      <${F} label=${t('Description (markdown — MJ uniquement)')}><${TextInput} live multiline rows=${8} value=${draft.description} onChange=${(v) => set(['description'], v)} /></${F}>
      <${F} label=${t('Tactique (markdown)')}><${TextInput} live multiline rows=${6} value=${draft.npc.tactics} onChange=${(v) => set(['npc', 'tactics'], v)} /></${F}>
      <${F} label=${t('Butin (markdown)')}><${TextInput} live multiline rows=${3} value=${draft.npc.loot} onChange=${(v) => set(['npc', 'loot'], v)} /></${F}>
    </div>`;
  } else {
    body = html`<${StatBlock} t=${draft} />`;
  }

  const folder = draft.folder || DEFAULT_FOLDER;
  return html`<${Modal} title=${draft.name ? t('Modèle : {name}', { name: draft.name }) : t('Modèle : sans nom')} width=${1080} onClose=${requestClose}
      actions=${html`<${Badge} color="dim">${folder === DEFAULT_FOLDER ? t('Divers') : folder}</${Badge}>`}>
    <div class="bed">
      <${Tabs} tabs=${TABS.map((x) => ({ ...x, label: t(x.label) }))} value=${tab} onChange=${setTab} />
      ${body}
      <div class="bed-foot">
        <${Button} variant="ghost" onClick=${requestClose}>${t('Annuler')}</${Button}>
        <${Button} variant="primary" disabled=${saving} onClick=${save}>${saving ? t('Enregistrement…') : t('Enregistrer le modèle')}</${Button}>
      </div>
    </div>
  </${Modal}>`;
}
