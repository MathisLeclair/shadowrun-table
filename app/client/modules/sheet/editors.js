// GM editing helpers: generic item-list editor and catalog picker (adds items at no cost).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Button, NumberInput, TextInput, Select, Toggle, SearchBox, Empty, IconButton, confirmAction } from '../../lib/ui.js';
import { send, loadCatalog } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { SKILLS } from '/shared/sr5.js';
import { Overlay } from './common.js';
import { catalogToItem, LIST_LABELS, KNOWLEDGE_TYPES } from './sheet-data.js';

const COMBAT_SKILLS = SKILLS.filter((s) => s.cat === 'combat' || s.id === 'gunnery').map((s) => ({ value: s.id, label: s.fr }));

/** Field schemas of each item list, for the GM editor. */
export const LIST_FIELDS = {
  weapons: [
    { k: 'name', label: 'Nom', w: 170 }, { k: 'kind', label: 'Type', type: 'select', options: [{ value: 'melee', label: 'Mêlée' }, { value: 'ranged', label: 'Distance' }] },
    { k: 'skill', label: 'Compétence', type: 'select', options: COMBAT_SKILLS }, { k: 'accuracy', label: 'Préc.', w: 70 }, { k: 'damage', label: 'VD', w: 90 },
    { k: 'ap', label: 'PA', w: 50 }, { k: 'mode', label: 'Mode', w: 80 }, { k: 'rc', label: 'RC', type: 'num' }, { k: 'ammo', label: 'Munitions', w: 80 },
    { k: 'reach', label: 'Allonge', type: 'num' }, { k: 'category', label: 'Catégorie', w: 110 }, { k: 'notes', label: 'Notes', w: 180 },
  ],
  armor: [
    { k: 'name', label: 'Nom', w: 200 }, { k: 'rating', label: 'Indice', type: 'num' }, { k: 'equipped', label: 'Portée', type: 'bool' },
    { k: 'stack', label: 'Cumulable', type: 'bool' }, { k: 'notes', label: 'Notes', w: 220 },
  ],
  augmentations: [
    { k: 'name', label: 'Nom', w: 200 }, { k: 'kind', label: 'Type', type: 'select', options: [{ value: 'cyberware', label: 'Cyberware' }, { value: 'bioware', label: 'Bioware' }] },
    { k: 'grade', label: 'Grade', type: 'select', options: [{ value: 'standard', label: 'Standard' }, { value: 'used', label: 'Occasion' }, { value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Bêta' }, { value: 'delta', label: 'Delta' }] },
    { k: 'rating', label: 'Indice', type: 'num' }, { k: 'essence', label: 'Essence', type: 'num', step: 0.05 }, { k: 'notes', label: 'Notes', w: 220 },
  ],
  gear: [{ k: 'name', label: 'Nom', w: 200 }, { k: 'category', label: 'Catégorie', w: 120 }, { k: 'rating', label: 'Indice', type: 'num' }, { k: 'qty', label: 'Qté', type: 'num' }, { k: 'notes', label: 'Notes', w: 200 }],
  vehicles: [
    { k: 'name', label: 'Nom', w: 180 }, { k: 'handling', label: 'Maniab.', w: 60 }, { k: 'speed', label: 'Vitesse', w: 60 }, { k: 'accel', label: 'Accél.', w: 60 },
    { k: 'body', label: 'Struct.', type: 'num' }, { k: 'armor', label: 'Blind.', type: 'num' }, { k: 'pilot', label: 'Autopilote', type: 'num' }, { k: 'sensor', label: 'Senseurs', type: 'num' },
    { k: 'seats', label: 'Places', type: 'num' }, { k: 'notes', label: 'Notes', w: 180 },
  ],
  contacts: [{ k: 'name', label: 'Nom', w: 180 }, { k: 'role', label: 'Rôle', w: 140 }, { k: 'connection', label: 'Connexion', type: 'num' }, { k: 'loyalty', label: 'Loyauté', type: 'num' }, { k: 'notes', label: 'Notes', w: 220 }],
  sins: [{ k: 'name', label: 'Identité', w: 200 }, { k: 'rating', label: 'Indice', type: 'num' }, { k: 'licenses', label: 'Licences (séparées par des virgules)', type: 'tags', w: 240 }, { k: 'notes', label: 'Notes', w: 160 }],
  qualities: [{ k: 'name', label: 'Nom', w: 200 }, { k: 'karma', label: 'Karma', type: 'num' }, { k: 'positive', label: 'Positive', type: 'bool' }, { k: 'notes', label: 'Notes', w: 260 }],
  powers: [{ k: 'name', label: 'Pouvoir', w: 200 }, { k: 'level', label: 'Niveau', type: 'num' }, { k: 'pp', label: 'PP', type: 'num', step: 0.25 }, { k: 'notes', label: 'Notes', w: 260 }],
  spells: [
    { k: 'name', label: 'Sort', w: 160 }, { k: 'category', label: 'Catégorie', w: 100 }, { k: 'type', label: 'Type', w: 50 }, { k: 'range', label: 'Portée', w: 70 },
    { k: 'duration', label: 'Durée', w: 60 }, { k: 'drain', label: 'Drain', w: 70 }, { k: 'notes', label: 'Notes', w: 180 },
  ],
  knowledge: [
    { k: 'name', label: 'Connaissance', w: 200 }, { k: 'type', label: 'Type', type: 'select', options: Object.entries(KNOWLEDGE_TYPES).map(([value, label]) => ({ value, label })) },
    { k: 'rating', label: 'Indice', type: 'num' }, { k: 'native', label: 'Langue maternelle', type: 'bool' },
  ],
};

/** Which catalogs can feed a list. */
export const LIST_CATALOGS = {
  weapons: ['weapons'], armor: ['armor'], augmentations: ['cyberware', 'bioware'], gear: ['gear'], vehicles: ['vehicles'],
  qualities: ['qualities'], powers: ['powers'], spells: ['spells'],
};
const CATALOG_LABELS = { weapons: 'Armes', armor: 'Armures', gear: 'Équipement', cyberware: 'Cyberware', bioware: 'Bioware', vehicles: 'Véhicules', qualities: 'Qualités', powers: 'Pouvoirs', spells: 'Sorts', programs: 'Programmes' };

const BLANK = {
  weapons: { name: 'Nouvelle arme', kind: 'ranged', skill: 'pistols', accuracy: '5', damage: '7P', ap: 0, mode: 'SA', rc: 0, ammo: '' },
  armor: { name: 'Nouvelle armure', rating: 6, equipped: false },
  augmentations: { name: 'Nouvel implant', kind: 'cyberware', grade: 'standard', essence: 0.1 },
  gear: { name: 'Nouvel objet', qty: 1 },
  vehicles: { name: 'Nouveau véhicule', handling: '3/3', speed: '3', accel: '2', body: 8, armor: 4, pilot: 1, sensor: 1, seats: 2 },
  contacts: { name: 'Nouveau contact', role: '', connection: 1, loyalty: 1 },
  sins: { name: 'Nouvelle identité', rating: 3, licenses: [] },
  qualities: { name: 'Nouvelle qualité', karma: 5, positive: true },
  powers: { name: 'Nouveau pouvoir', pp: 0.5 },
  spells: { name: 'Nouveau sort', category: 'Combat', type: 'M', range: 'LdV', duration: 'I', drain: 'F−3' },
  knowledge: { name: 'Nouvelle connaissance', type: 'street', rating: 1 },
};

function FieldInput({ f, value, onChange }) {
  if (f.type === 'num') return html`<${NumberInput} small value=${Number(value) || 0} step=${f.step || 1} min=${f.k === 'essence' || f.k === 'pp' ? 0 : -99} onChange=${onChange} />`;
  if (f.type === 'bool') return html`<${Toggle} value=${!!value} onChange=${onChange} />`;
  if (f.type === 'select') return html`<${Select} value=${value || ''} options=${[{ value: '', label: '—' }, ...f.options]} onChange=${onChange} />`;
  if (f.type === 'tags') return html`<${TextInput} value=${(value || []).join(', ')} onChange=${(v) => onChange(v.split(',').map((s) => s.trim()).filter(Boolean))} />`;
  return html`<${TextInput} value=${value ?? ''} onChange=${onChange} style=${{ minWidth: (f.w || 90) + 'px' }} />`;
}

/** Inline editor for one item list (GM). */
export function ListEditor({ actor, list, fields = LIST_FIELDS[list] }) {
  const [picker, setPicker] = useState(false);
  const items = actor[list] || [];
  const up = (it, i, k, v) => send('actor/updateItem', { actorId: actor.id, list, itemId: it.id, index: i, patch: { [k]: v } }).catch(() => {});
  const remove = async (it, i) => {
    if (!(await confirmAction(`Retirer « ${it.name} » ?`))) return;
    const essence = list === 'augmentations' && it.essence ? await confirmAction(`Rendre ${it.essence} point(s) d’Essence à ${actor.name} ?`) : false;
    send('actor/removeItem', { actorId: actor.id, list, itemId: it.id, index: i, adjustEssence: essence }).catch(() => {});
  };
  const addBlank = () => send('actor/addItem', { actorId: actor.id, list, item: { ...(BLANK[list] || { name: 'Nouvel élément' }) } }).catch(() => {});
  return html`<div class="sh-editor">
    <div class="sh-table-wrap">
      <table class="sr sh-edit-table">
        <thead><tr>${fields.map((f) => html`<th>${f.label}</th>`)}<th></th></tr></thead>
        <tbody>
          ${items.map(
            (it, i) => html`<tr key=${it.id || i}>
              ${fields.map((f) => html`<td><${FieldInput} f=${f} value=${it[f.k]} onChange=${(v) => up(it, i, f.k, v)} /></td>`)}
              <td><${IconButton} icon="✕" title="Retirer" onClick=${() => remove(it, i)} /></td>
            </tr>`
          )}
          ${!items.length && html`<tr><td colspan=${fields.length + 1} class="muted small">Aucun élément.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="row wrap">
      <${Button} small onClick=${addBlank}>+ Ajouter (vierge)</${Button}>
      ${LIST_CATALOGS[list] && html`<${Button} small variant="primary" onClick=${() => setPicker(true)}>+ Depuis le catalogue</${Button}>`}
    </div>
    ${picker && html`<${CatalogPicker} actor=${actor} list=${list} catalogs=${LIST_CATALOGS[list]} onClose=${() => setPicker(false)} />`}
  </div>`;
}

const statLine = (catalog, e) => {
  const s = e.stats || {};
  if (catalog === 'weapons') return [s.accuracy && `Préc. ${s.accuracy}`, s.damage && `VD ${s.damage}`, s.ap !== undefined && `PA ${s.ap}`, s.mode && s.mode !== '0' && s.mode, s.ammo && s.ammo !== '0' && s.ammo].filter(Boolean).join(' · ');
  if (catalog === 'armor') return `Armure ${s.armor ?? s.rating ?? '?'}`;
  if (catalog === 'cyberware' || catalog === 'bioware') return `Essence ${e.essence ?? s.essence ?? '?'}`;
  if (catalog === 'vehicles') return [s.handling && `Man. ${s.handling}`, s.speed && `Vit. ${s.speed}`, s.body && `Struct. ${s.body}`, s.armor && `Blind. ${s.armor}`].filter(Boolean).join(' · ');
  if (catalog === 'qualities') return `${s.karma ?? e.karma ?? '?'} karma`;
  if (catalog === 'powers') return `${s.points ?? s.pp ?? '?'} PP`;
  if (catalog === 'spells') return [s.type, s.range, s.duration, (s.drain || s.dv) && `Drain ${s.drain || s.dv}`].filter(Boolean).join(' · ');
  return '';
};

/** Catalog browser: adds the chosen entry to `list` of the actor for free (GM). */
export function CatalogPicker({ actor, list, catalogs, onClose, onPick }) {
  const [cat, setCat] = useState(catalogs[0]);
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [ratings, setRatings] = useState({});
  const [essence, setEssence] = useState(true);
  useEffect(() => {
    let alive = true;
    setData(null);
    setCategory('');
    loadCatalog(cat)
      .then((d) => alive && setData(Array.isArray(d) ? d : []))
      .catch(() => alive && setData([]));
    return () => (alive = false);
  }, [cat]);
  const categories = useMemo(() => {
    const m = new Map();
    for (const e of data || []) if (e.category && !m.has(e.category)) m.set(e.category, e.categoryFr || e.category);
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }, [data]);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data || []).filter((e) => (!category || e.category === category) && (!needle || `${e.name} ${e.nameFr || ''} ${e.category || ''}`.toLowerCase().includes(needle)));
  }, [data, q, category]);
  const add = async (e) => {
    const r = e.rating && e.rating.max ? ratings[e.id] || e.rating.min || 1 : undefined;
    const conv = catalogToItem(cat, e, r);
    if (!conv) return;
    if (onPick) return onPick(conv, e);
    try {
      await send('actor/addItem', { actorId: actor.id, list: conv.list, item: conv.item, adjustEssence: conv.list === 'augmentations' && essence });
      toast(`${conv.item.name} ajouté à ${actor.name}`, 'success');
    } catch {}
  };
  return html`<${Overlay} title=${`Catalogue — ${LIST_LABELS[list] || ''}`} onClose=${onClose} width=${760}>
    <div class="col">
      <div class="row wrap">
        ${catalogs.length > 1 && html`<${Select} value=${cat} options=${catalogs.map((c) => ({ value: c, label: CATALOG_LABELS[c] || c }))} onChange=${setCat} style=${{ width: 'auto' }} />`}
        <${SearchBox} value=${q} onChange=${setQ} />
        ${categories.length > 1 && html`<${Select} value=${category} options=${[{ value: '', label: 'Toutes catégories' }, ...categories]} onChange=${setCategory} style=${{ width: 'auto', maxWidth: '220px' }} />`}
        ${list === 'augmentations' && html`<${Toggle} value=${essence} onChange=${setEssence} label="Déduire l’Essence" />`}
      </div>
      ${data === null
        ? html`<div class="muted">Chargement du catalogue…</div>`
        : !data.length
          ? html`<${Empty}>Catalogue « ${CATALOG_LABELS[cat] || cat} » indisponible. Lance <code>npm run build:catalog</code> sur le PC du MJ, ou ajoute un élément vierge.</${Empty}>`
          : html`<div class="sh-cat-list">
              ${results.slice(0, 150).map(
                (e) => html`<div class="sh-cat-row" key=${e.id}>
                  <div class="grow">
                    <div><b>${e.nameFr || e.name}</b>${e.nameFr && e.nameFr !== e.name ? html` <span class="faint small">${e.name}</span>` : null}</div>
                    <div class="muted small">${[e.categoryFr || e.category, statLine(cat, e), e.avail && `Dispo ${e.avail}`, e.cost != null && `${Number(e.cost).toLocaleString('fr-FR')}¥`].filter(Boolean).join(' · ')}</div>
                  </div>
                  ${e.rating && e.rating.max ? html`<${NumberInput} small value=${ratings[e.id] || e.rating.min || 1} min=${e.rating.min || 1} max=${e.rating.max} onChange=${(v) => setRatings({ ...ratings, [e.id]: v })} />` : null}
                  <${Button} small variant="primary" onClick=${() => add(e)}>Ajouter</${Button}>
                </div>`
              )}
              ${results.length > 150 && html`<div class="muted small center">${results.length - 150} résultats de plus — affine la recherche.</div>`}
              ${!results.length && html`<div class="muted small center">Aucun résultat.</div>`}
            </div>`}
      <div class="muted small">Ajout gratuit (édition MJ). Pour un achat avec nuyens, passe par la Boutique.</div>
    </div>
  </${Overlay}>`;
}
