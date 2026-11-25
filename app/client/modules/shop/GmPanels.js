// GM-only panels: shop settings and the fixer specials editor (« Offres de Cabana »).
import { useState } from 'preact/hooks';
import { html, Button, Badge, Empty, Panel, Field, TextInput, NumberInput, Select, Toggle, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { SKILLS } from '/shared/sr5.js';
import { SHOP_FILES, FILE_LABELS, GRADES, GRADE_IDS } from './rules.js';
import { nuyen } from './common.js';

const settings = (patch) => send('shop/updateSettings', patch).catch(() => {});

export function SettingsPanel({ game }) {
  const s = game.shop || {};
  return html`<div class="shop-settings grid-2">
    <${Panel} title="Boutique">
      <div class="col gap-l">
        <${Toggle} value=${s.open} onChange=${(v) => settings({ open: v })} label=${s.open ? 'Ouverte — Cabana répond' : 'Fermée — Cabana injoignable'} />
        <div class="row wrap gap-l">
          <${Field} label="Marge de Cabana (%)" hint="Appliquée aux prix catalogue (pas aux offres)"><${NumberInput} value=${s.markup} min=${-90} max=${500} step=${5} onChange=${(v) => settings({ markup: v })} /></${Field}>
          <${Field} label="Taux de revente (%)" hint="Part du prix payé rendue au runner"><${NumberInput} value=${s.sellRate} min=${0} max=${100} step=${5} onChange=${(v) => settings({ sellRate: v })} /></${Field}>
          <${Field} label="Disponibilité max" hint="Au-delà, achat impossible pour les joueurs"><${NumberInput} value=${s.maxAvail} min=${0} max=${40} onChange=${(v) => settings({ maxAvail: v })} /></${Field}>
        </div>
      </div>
    </${Panel}>
    <${Panel} title="Légalité & validation">
      <div class="col gap-l">
        <${Toggle} value=${s.allowRestricted} onChange=${(v) => settings({ allowRestricted: v })} label="Autoriser le matériel restreint (R)" />
        <${Toggle} value=${s.allowForbidden} onChange=${(v) => settings({ allowForbidden: v })} label="Autoriser le matériel interdit (F)" />
        <${Field} label="Validation par le MJ">
          <${Select} value=${s.approval} onChange=${(v) => settings({ approval: v })} options=${[
            { value: 'never', label: 'Jamais — les achats sont immédiats' },
            { value: 'restricted', label: 'Objets R/F et prix négociés' },
            { value: 'always', label: 'Toujours — chaque achat et revente' },
          ]} />
        </${Field}>
      </div>
    </${Panel}>
    <${Panel} title="Rayons ouverts">
      <div class="shop-cat-toggles">
        ${SHOP_FILES.map((f) => html`<${Toggle} value=${s.categories?.[f] !== false} onChange=${(v) => settings({ categories: { [f]: v } })} label=${FILE_LABELS[f]} />`)}
      </div>
      <div class="faint small">Les offres de Cabana restent visibles même si leur rayon est fermé.</div>
    </${Panel}>
  </div>`;
}

const FILE_OPTIONS = SHOP_FILES.filter((f) => f !== 'lifestyles').map((f) => ({ value: f, label: FILE_LABELS[f] }));
const SKILL_OPTIONS = SKILLS.filter((s) => s.cat === 'combat').map((s) => ({ value: s.id, label: s.fr }));

function SpecialEditor({ sp, game }) {
  const upd = (patch) => send('shop/updateSpecial', { id: sp.id, patch }).catch(() => {});
  const pcs = Object.values(game.actors || {}).filter((a) => a.type === 'pc' && !a.retired);
  const ware = sp.file === 'cyberware' || sp.file === 'bioware';
  const st = sp.stats || {};
  const updStats = (patch) => upd({ stats: { ...st, ...patch } });
  const reserved = sp.forActorIds || [];
  const unlimited = sp.stock === null || sp.stock === undefined;
  return html`<div class="shop-special-edit">
    <div class="grid-2">
      <${Field} label="Nom"><${TextInput} value=${sp.name} onChange=${(v) => upd({ name: v })} /></${Field}>
      <${Field} label="Catégorie affichée"><${TextInput} value=${sp.category} onChange=${(v) => upd({ category: v })} /></${Field}>
    </div>
    <div class="row wrap gap-l">
      <${Field} label="Rayon (livré dans)"><${Select} value=${sp.file || 'gear'} onChange=${(v) => upd({ file: v })} options=${FILE_OPTIONS} /></${Field}>
      <${Field} label="Prix (¥)"><${NumberInput} value=${sp.cost} min=${0} step=${50} onChange=${(v) => upd({ cost: v })} /></${Field}>
      <${Field} label="Prix barré (¥)" hint="0 = aucun"><${NumberInput} value=${sp.originalCost || 0} min=${0} step=${50} onChange=${(v) => upd({ originalCost: v || null })} /></${Field}>
      <${Field} label="Dispo" hint="ex. 8R"><${TextInput} class="shop-short" value=${sp.avail} onChange=${(v) => upd({ avail: v })} /></${Field}>
      <${Field} label="Stock">
        <div class="row">
          <${Toggle} value=${unlimited} onChange=${(v) => upd({ stock: v ? null : 1 })} label="illimité" />
          ${!unlimited && html`<${NumberInput} small value=${sp.stock} min=${0} max=${999} onChange=${(v) => upd({ stock: v })} />`}
        </div>
      </${Field}>
      <${Field} label="Indice"><${NumberInput} value=${sp.rating || 0} min=${0} max=${20} onChange=${(v) => upd({ rating: v || null })} /></${Field}>
      ${ware && html`<${Field} label="Grade"><${Select} value=${sp.grade || 'standard'} onChange=${(v) => upd({ grade: v })} options=${GRADE_IDS.map((g) => ({ value: g, label: GRADES[g].label }))} /></${Field}>`}
      ${ware && html`<${Field} label="Essence" hint="vide = catalogue"><${TextInput} class="shop-short" value=${sp.essence ?? ''} onChange=${(v) => upd({ essence: v === '' ? null : v.replace(',', '.') })} /></${Field}>`}
    </div>
    ${!sp.catalogRef &&
    sp.file === 'weapons' &&
    html`<div class="row wrap gap-l shop-stats-edit">
      <${Field} label="Type"><${Select} value=${st.type || 'ranged'} onChange=${(v) => updStats({ type: v })} options=${[{ value: 'melee', label: 'Mêlée' }, { value: 'ranged', label: 'Distance' }]} /></${Field}>
      <${Field} label="Compétence"><${Select} value=${st.skill || 'pistols'} onChange=${(v) => updStats({ skill: v })} options=${SKILL_OPTIONS} /></${Field}>
      <${Field} label="Dégâts"><${TextInput} class="shop-short" value=${st.damage || ''} onChange=${(v) => updStats({ damage: v })} /></${Field}>
      <${Field} label="PA"><${NumberInput} small value=${Number(st.ap) || 0} min=${-20} max=${10} onChange=${(v) => updStats({ ap: v })} /></${Field}>
      <${Field} label="Précision"><${NumberInput} small value=${Number(st.accuracy) || 0} min=${0} max=${12} onChange=${(v) => updStats({ accuracy: v })} /></${Field}>
      <${Field} label="Mode"><${TextInput} class="shop-short" value=${st.mode || ''} onChange=${(v) => updStats({ mode: v })} /></${Field}>
      <${Field} label="RC"><${NumberInput} small value=${Number(st.rc) || 0} min=${0} max=${12} onChange=${(v) => updStats({ rc: v })} /></${Field}>
      <${Field} label="Munitions"><${TextInput} class="shop-short" value=${st.ammo || ''} onChange=${(v) => updStats({ ammo: v })} /></${Field}>
      <${Field} label="Allonge"><${NumberInput} small value=${Number(st.reach) || 0} min=${0} max=${4} onChange=${(v) => updStats({ reach: v })} /></${Field}>
    </div>`}
    ${!sp.catalogRef &&
    sp.file === 'armor' &&
    html`<div class="row wrap gap-l shop-stats-edit">
      <${Field} label="Armure"><${NumberInput} small value=${Number(st.armor) || 0} min=${0} max=${30} onChange=${(v) => updStats({ armor: v })} /></${Field}>
      <${Toggle} value=${!!st.stack} onChange=${(v) => updStats({ stack: v })} label="Cumulable (casque, bouclier…)" />
    </div>`}
    <div class="grid-2">
      <${Field} label="Texte de Cabana (vu par les joueurs)"><${TextInput} multiline rows=${3} value=${sp.notes || ''} onChange=${(v) => upd({ notes: v })} /></${Field}>
      <${Field} label="Notes MJ (secrètes)"><${TextInput} multiline rows=${3} value=${sp.gmNotes || ''} onChange=${(v) => upd({ gmNotes: v })} /></${Field}>
    </div>
    <div class="row wrap gap-l">
      <${Toggle} value=${!!sp.hidden} onChange=${(v) => upd({ hidden: v })} label="Brouillon (caché aux joueurs)" />
      <div class="row wrap gap-s">
        <span class="field-label">Réservée à</span>
        ${pcs.map(
          (a) => html`<button class=${'shop-chip' + (reserved.includes(a.id) ? ' on' : '')}
            onClick=${() => upd({ forActorIds: reserved.includes(a.id) ? reserved.filter((x) => x !== a.id) : [...reserved, a.id] })}>${a.name}</button>`
        )}
        ${!reserved.length && html`<span class="faint small">tout le monde</span>`}
      </div>
    </div>
  </div>`;
}

export function SpecialsPanel({ game }) {
  const specials = game.shop?.specials || [];
  const [open, setOpen] = useState(null);
  const create = async () => {
    try {
      const r = await send('shop/addSpecial', { special: { name: 'Nouvelle offre', category: 'Divers', file: 'gear', cost: 0, avail: '0', stock: 1, hidden: true } });
      setOpen(r?.id || null);
    } catch {}
  };
  const remove = async (sp) => {
    if (!(await confirmAction(`Supprimer l’offre « ${sp.name} » ?`))) return;
    try {
      await send('shop/removeSpecial', { id: sp.id });
      toast('Offre supprimée', 'info');
    } catch {}
  };
  const actors = game.actors || {};
  return html`<div class="shop-specials-admin">
    <div class="row spread wrap">
      <div class="muted small">Les offres sont des affaires préparées par Cabana : prix fixes, stock limité, hors limite de disponibilité. Pour partir d’un article du catalogue, utilise « + Offre Cabana » dans sa fiche.</div>
      <${Button} variant="primary" onClick=${create}>+ Nouvelle offre</${Button}>
    </div>
    ${!specials.length && html`<${Empty}>Aucune offre.</${Empty}>`}
    ${specials.map(
      (sp) => html`<div class=${'card shop-special-admin' + (sp.hidden ? ' draft' : '')} key=${sp.id}>
        <div class="row spread wrap">
          <div class="row wrap gap-s">
            <strong class="cyan">${sp.name}</strong>
            <${Badge}>${FILE_LABELS[sp.file] || sp.file}</${Badge}>
            ${sp.hidden && html`<${Badge} color="amber">Brouillon</${Badge}>`}
            ${(sp.forActorIds || []).length > 0 && html`<${Badge} color="magenta">Pour ${(sp.forActorIds || []).map((id) => actors[id]?.name || '?').join(', ')}</${Badge}>`}
            ${sp.stock === 0 && html`<${Badge} color="red">Épuisé</${Badge}>`}
          </div>
          <div class="row gap-s">
            <span class="mono">${nuyen(sp.cost)}</span>
            <span class="muted small">${sp.stock === null || sp.stock === undefined ? '∞' : `stock ${sp.stock}`}</span>
            <${Button} small variant=${open === sp.id ? 'primary' : 'ghost'} onClick=${() => setOpen(open === sp.id ? null : sp.id)}>${open === sp.id ? 'Fermer' : 'Modifier'}</${Button}>
            <${Button} small variant="danger" onClick=${() => remove(sp)}>Supprimer</${Button}>
          </div>
        </div>
        ${open === sp.id && html`<${SpecialEditor} sp=${sp} game=${game} />`}
      </div>`
    )}
  </div>`;
}
