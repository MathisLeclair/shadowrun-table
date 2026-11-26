// Full SR5 character sheet (« dossier » look). Rendered in the global sheet modal and in « Ma fiche ».
// <SheetView game actorId /> — GM can toggle « Modifier » to edit everything; owners edit their allowed fields.
import { useRef, useState } from 'preact/hooks';
import { html, Button, Tabs, Toggle, Badge, TextInput, NumberInput, Select, Empty, loadCss, confirmAction } from '../../lib/ui.js';
import { send, upload, api } from '../../lib/net.js';
import { setUI, toast } from '../../lib/ui-store.js';
import { derive, METATYPES } from '/shared/sr5.js';
import { derivedWithModifiers } from '/shared/modifiers.js';
import { t, fmtNuyen, metatypeLabel } from '../../lib/i18n.js';
import { isGM, ownsActor, isRestricted, ownerOf, actorStatus, statusColor, statusLabel, Avatar, fmtNum } from './common.js';
import { RollDialog } from './RollDialog.js';
import { SummaryTab } from './tab-summary.js';
import { SkillsTab } from './tab-skills.js';
import { CombatTab } from './tab-combat.js';
import { MagicTab, MatrixTab, GearTab, ContactsTab, QualitiesTab, NotesTab, HistoryTab, NpcTab } from './tab-misc.js';
import { slugify } from './sheet-data.js';
import { ChummerSheetBar } from '../chummer/ChummerActions.js';
import { useDerivedModifiers, useEffectsLookup } from './modifiers-ui.js';

loadCss('/modules/sheet/sheet.css');

function Portrait({ actor, canEdit }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast(t('Choisis une image (png, jpg, webp…)'), 'warn');
    setBusy(true);
    try {
      const { url } = await upload(file);
      await send('actor/update', { actorId: actor.id, patch: { portrait: url } });
      toast(t('Portrait mis à jour'), 'success');
    } catch (err) {
      if (err?.message) toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<div class=${'sh-portrait' + (canEdit ? ' editable' : '')} style=${{ '--pc': actor.color || '#3fd6d0' }}
      onClick=${canEdit ? () => input.current?.click() : null} title=${canEdit ? t('Changer le portrait') : ''}>
    <${Avatar} actor=${actor} size=${96} />
    ${canEdit && html`<span class="sh-portrait-edit">${busy ? '…' : '⇪'}</span>`}
    <input ref=${input} type="file" accept="image/*" hidden onChange=${pick} />
  </div>`;
}

function HeaderBadge({ label, value, color = 'dim', title }) {
  return html`<div class=${'sh-hbadge sh-hbadge-' + color} title=${title}><span class="sh-hbadge-v">${value}</span><span class="sh-hbadge-l">${label}</span></div>`;
}

function Header({ s, game }) {
  const { actor, gm, own, edit } = s;
  const owner = ownerOf(game, actor.id);
  const online = owner && (game.online || []).includes(owner.id);
  const status = actorStatus(actor);
  const meta = [metatypeLabel(actor.metatype), actor.age ? t('{age} ans', { age: actor.age }) : '', actor.gender].filter(Boolean).join(' · ');
  return html`<header class="sh-header" data-id=${String(actor.id).slice(-6).toUpperCase()} style=${{ '--pc': actor.color || '#3fd6d0' }}>
    <${Portrait} actor=${actor} canEdit=${own} />
    <div class="sh-ident">
      ${edit
        ? html`<div class="sh-ident-edit">
            <${TextInput} class="sh-name-input" value=${actor.name} onChange=${(v) => v.trim() && s.update({ name: v })} />
            <div class="row wrap">
              <${Select} value=${actor.metatype} options=${Object.keys(METATYPES).map((m) => ({ value: m, label: metatypeLabel(m) }))} onChange=${(v) => s.update({ metatype: v })} style=${{ width: 'auto' }} />
              <${NumberInput} small value=${actor.age || 0} min=${0} max=${300} onChange=${(v) => s.update({ age: v })} />
              <${TextInput} value=${actor.gender || ''} placeholder=${t('Genre')} onChange=${(v) => s.update({ gender: v })} style=${{ maxWidth: '110px' }} />
              <${TextInput} value=${actor.player || ''} placeholder=${t('Joueur (nom réel)')} onChange=${(v) => s.update({ player: v })} style=${{ maxWidth: '160px' }} />
            </div>
          </div>`
        : html`<h2 class="sh-name">${actor.name}</h2><div class="sh-meta">${meta}</div>`}
      ${own && !edit
        ? html`<${TextInput} class="sh-concept-input" value=${actor.concept || ''} placeholder=${t('Concept du personnage')} onChange=${(v) => s.update({ concept: v })} />`
        : edit
          ? html`<${TextInput} class="sh-concept-input" value=${actor.concept || ''} placeholder=${t('Concept')} onChange=${(v) => s.update({ concept: v })} />`
          : actor.concept && html`<div class="sh-concept">${actor.concept}</div>`}
      <div class="sh-meta row wrap gap-s">
        ${actor.type === 'pc'
          ? html`<span>${t('Joueur :')} <b>${actor.player || owner?.name || '—'}</b></span>
            ${owner && html`<span class=${'sh-online' + (online ? ' on' : '')} title=${online ? t('Connecté') : t('Hors ligne')}>${owner.name}</span>`}`
          : html`<${Badge} color="red">${t('PNJ')}</${Badge}>${actor.hidden ? html`<${Badge}>${t('caché')}</${Badge}>` : null}`}
        ${actor.retired && html`<${Badge} color="amber">${t('Retraité')}</${Badge}>`}
        <${Badge} color=${statusColor(status)}>${statusLabel(status)}</${Badge}>
        ${own && html`<label class="sh-color" title=${t('Couleur du pion')}><input type="color" value=${actor.color || '#3fd6d0'} onChange=${(e) => s.update({ color: e.target.value })} /></label>`}
      </div>
    </div>
    <div class="sh-hbadges">
      ${edit
        ? html`<div class="field"><span class="field-label">${t('Street Cred')}</span><${NumberInput} small value=${actor.streetCred || 0} min=${0} max=${99} onChange=${(v) => s.update({ streetCred: v })} /></div>
          <div class="field"><span class="field-label">${t('Notoriété')}</span><${NumberInput} small value=${actor.notoriety || 0} min=${0} max=${99} onChange=${(v) => s.update({ notoriety: v })} /></div>
          <div class="field"><span class="field-label">${t('Exposition')}</span><${NumberInput} small value=${actor.publicAwareness || 0} min=${0} max=${99} onChange=${(v) => s.update({ publicAwareness: v })} /></div>`
        : html`
          <${HeaderBadge} label=${t('Karma')} value=${actor.karma ?? 0} color="amber" title=${t('Karma de carrière : {n}', { n: actor.karmaTotal ?? 0 })} />
          <${HeaderBadge} label=${t('Nuyens')} value=${fmtNuyen(actor.nuyen ?? 0)} color="cyan" />
          <${HeaderBadge} label=${t('Street Cred')} value=${actor.streetCred ?? 0} color="magenta" />
          ${actor.notoriety ? html`<${HeaderBadge} label=${t('Notoriété')} value=${actor.notoriety} color="red" />` : null}
          ${actor.publicAwareness ? html`<${HeaderBadge} label=${t('Exposition')} value=${actor.publicAwareness} />` : null}
          <${HeaderBadge} label=${t('Essence')} value=${fmtNum(Math.round(s.d.essence * 100) / 100)} />`}
    </div>
  </header>`;
}

function GmToolbar({ s }) {
  const { actor, edit, setEdit } = s;
  const dup = async () => {
    try {
      const id = await send('actor/duplicate', { actorId: actor.id });
      setUI({ sheetActorId: id });
      toast(t('Copie créée'), 'success');
    } catch {}
  };
  const exp = async () => {
    try {
      const data = await api(`/api/actors/${encodeURIComponent(actor.id)}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slugify(actor.name)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) {
      toast(err.message || t('Export impossible'), 'error');
    }
  };
  const del = async () => {
    if (!(await confirmAction(t('Supprimer définitivement {name} ? Ses pions et son entrée d’initiative seront aussi retirés.', { name: actor.name })))) return;
    try {
      await send('actor/delete', { actorId: actor.id });
      setUI({ sheetActorId: null });
      toast(t('{name} supprimé', { name: actor.name }), 'success');
    } catch {}
  };
  return html`<div class="sh-gmbar">
    <${Toggle} value=${edit} onChange=${setEdit} label=${t('Modifier')} title=${t('Mode édition MJ')} />
    <div class="row wrap gap-s">
      <${Button} small variant="ghost" onClick=${dup}>${t('Dupliquer')}</${Button}>
      <${Button} small variant="ghost" onClick=${exp}>${t('Exporter')}</${Button}>
      ${actor.type === 'pc' && html`<${Button} small variant="ghost" onClick=${() => s.update({ retired: !actor.retired })}>${actor.retired ? t('Réactiver') : t('Mettre à la retraite')}</${Button}>`}
      <${Button} small variant="danger" onClick=${del}>${t('Supprimer')}</${Button}>
    </div>
  </div>`;
}

function RestrictedView({ actor }) {
  const status = actorStatus(actor);
  return html`<div class="sh-restricted" style=${{ '--pc': actor.color || '#e05c5c' }}>
    <${Avatar} actor=${actor} size=${96} />
    <div>
      <h2 class="sh-name">${actor.name}</h2>
      <div class="sh-meta">${actor.metatype ? metatypeLabel(actor.metatype) : t('Inconnu')}</div>
      <div class="row wrap" style=${{ marginTop: '8px' }}><${Badge} color=${statusColor(status)}>${statusLabel(status)}</${Badge}></div>
      <p class="muted small">${t('Fiche confidentielle — seul le MJ connaît ses capacités.')}</p>
    </div>
  </div>`;
}

export default function SheetView({ game, actorId }) {
  const [tab, setTab] = useState('summary');
  const [edit, setEdit] = useState(false);
  const [rollPreset, setRollPreset] = useState(null);
  const actor = game?.actors?.[actorId];
  // Modifiers of the actor's gear, qualities, powers, implants (shared/modifiers.js): s.mods, s.dm = derive() + modifiers.
  const { mods, dm } = useDerivedModifiers(actor && !isRestricted(actor) ? actor : null);
  const lookup = useEffectsLookup();
  if (!actor) return html`<${Empty}>${t('Personnage introuvable (supprimé ?).')}</${Empty}>`;
  if (isRestricted(actor)) return html`<${RestrictedView} actor=${actor} />`;

  const gm = isGM(game);
  const own = ownsActor(game, actor.id);
  const s = {
    game, actor, gm, own, d: derive(actor), dm: dm || derivedWithModifiers(actor, []), mods, lookup,
    edit: gm && edit, setEdit,
    roll: own ? (preset) => setRollPreset({ ...preset, _k: Date.now() }) : () => toast(t('Tu ne peux lancer les dés que pour ton personnage'), 'warn'),
    update: (patch) => send('actor/update', { actorId: actor.id, patch }).catch(() => {}),
  };
  const showMagic = s.edit || (actor.attributes.MAG !== undefined && actor.attributes.MAG !== null) || (actor.powers || []).length || (actor.spells || []).length;
  const showMatrix = s.edit || !!actor.matrix || (actor.complexForms || []).length > 0;
  const tabs = [
    { id: 'summary', label: t('Résumé') },
    { id: 'skills', label: t('Compétences') },
    { id: 'combat', label: t('Combat') },
    showMagic && { id: 'magic', label: t('Magie') },
    showMatrix && { id: 'matrix', label: t('Matrice') },
    { id: 'gear', label: t('Équipement') },
    { id: 'contacts', label: t('Contacts & SIN') },
    { id: 'qualities', label: t('Qualités') },
    { id: 'notes', label: t('Notes') },
    { id: 'history', label: t('Historique') },
    gm && actor.type === 'npc' && { id: 'npc', label: t('PNJ') },
  ].filter(Boolean);
  const current = tabs.find((x) => x.id === tab) ? tab : 'summary';
  const body = {
    summary: () => html`<${SummaryTab} s=${s} />`,
    skills: () => html`<${SkillsTab} s=${s} />`,
    combat: () => html`<${CombatTab} s=${s} />`,
    magic: () => html`<${MagicTab} s=${s} />`,
    matrix: () => html`<${MatrixTab} s=${s} />`,
    gear: () => html`<${GearTab} s=${s} />`,
    contacts: () => html`<${ContactsTab} s=${s} />`,
    qualities: () => html`<${QualitiesTab} s=${s} />`,
    notes: () => html`<${NotesTab} s=${s} />`,
    history: () => html`<${HistoryTab} s=${s} />`,
    npc: () => html`<${NpcTab} s=${s} game=${game} />`,
  }[current];

  return html`<div class=${'sh-sheet' + (s.edit ? ' sh-editing' : '')} style=${{ '--pc': actor.color || '#3fd6d0' }}>
    ${gm && html`<${GmToolbar} s=${s} />`}
    <${Header} s=${s} game=${game} />
    ${own && html`<${ChummerSheetBar} game=${game} actor=${actor} />`}
    ${!own && !gm && html`<div class="sh-readonly muted small">${t('Fiche d’équipe — lecture seule.')}</div>`}
    <${Tabs} class="sh-tabs" tabs=${tabs} value=${current} onChange=${setTab} />
    <div class="sh-body" key=${current}>${body()}</div>
    ${rollPreset && html`<${RollDialog} key=${rollPreset._k} game=${game} actor=${actor} preset=${rollPreset} onClose=${() => setRollPreset(null)} />`}
  </div>`;
}
