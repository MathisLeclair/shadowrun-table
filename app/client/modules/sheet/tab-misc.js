// Sheet tabs: Magie, Matrice, Équipement, Contacts & SIN, Qualités, Notes, Historique, PNJ.
import { useState } from 'preact/hooks';
import { html, Button, NumberInput, TextInput, Toggle, Markdown, Select } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { attr, SKILL_BY_ID } from '/shared/sr5.js';
import { t, tk, tIfKnown, attrShort, fmtNuyen, itemName } from '../../lib/i18n.js';
import { fmtDate, fmtNum, signed } from './common.js';
import { RollStat } from './tab-summary.js';
import { ListEditor, CatalogPicker } from './editors.js';
import { openMatrix } from '../matrix/common.js';

// Roll labels are stored in French in the log; rollLabel() (common.js) translates them for each viewer.
const drainRollLabel = (k) => `Résistance au drain (VOL + ${k})`; // i18n-ignore
const spellRollLabel = (name) => `Sort — ${name}`; // i18n-ignore
const hasSkill = (actor, id) => (actor.skills || []).some((s) => s.id === id && s.rating > 0);
// Augmentation grade ids shown as stored in French ('alpha', 'used'…), translated in English.
const GRADE_LABELS = { alpha: tk('grade::alpha'), beta: tk('grade::beta'), delta: tk('grade::delta'), used: tk('grade::used'), gamma: tk('grade::gamma'), omega: tk('grade::omega') };
const gradeLabel = (g) => (GRADE_LABELS[g] ? t(GRADE_LABELS[g]) : g);

// ---------------------------------------------------------------------------
// Magie
// ---------------------------------------------------------------------------
export function MagicTab({ s }) {
  const { actor, d, edit } = s;
  const mag = attr(actor, 'MAG');
  const powers = actor.powers || [];
  const spells = actor.spells || [];
  const pp = powers.reduce((sum, p) => sum + (Number(p.pp) || 0), 0);
  return html`<div class="sh-magic">
    <div class="sh-derived">
      <${RollStat} label=${t('Magie')} value=${mag} accent="magenta" />
      <${RollStat} label=${t('Init. astrale')} value=${`${d.astralInitiative.base} + 2D6`} />
      ${d.limits.astral ? html`<${RollStat} label=${t('Limite astrale')} value=${d.limits.astral} />` : null}
      ${powers.length > 0 && html`<${RollStat} label=${t('Points de pouvoir')} value=${`${fmtNum(pp)} / ${mag}`} accent=${pp > mag ? 'magenta' : 'cyan'} title=${t('PP dépensés / Magie')} />`}
      ${hasSkill(actor, 'assensing') && html`<${RollStat} label=${t('Observation astrale')} value=${attrShort('INT')} onClick=${() => s.roll({ skillId: 'assensing' })} />`}
      ${hasSkill(actor, 'spellcasting') && html`<${RollStat} label=${t('Lancer un sort')} value=${attrShort('MAG')} onClick=${() => s.roll({ skillId: 'spellcasting', label: tk('Lancement de sort'), limit: null })} />`}
      ${hasSkill(actor, 'counterspelling') && html`<${RollStat} label=${t('Contresort')} value=${attrShort('MAG')} onClick=${() => s.roll({ skillId: 'counterspelling' })} />`}
      ${hasSkill(actor, 'summoning') && html`<${RollStat} label=${t('Invocation')} value=${attrShort('MAG')} onClick=${() => s.roll({ skillId: 'summoning', limit: null })} />`}
    </div>
    ${(spells.length > 0 || hasSkill(actor, 'spellcasting') || hasSkill(actor, 'summoning')) && html`<div class="row wrap">
      <span class="muted small">${t('Résister au drain :')}</span>
      ${['LOG', 'CHA', 'INT'].map((k) => html`<${Button} small key=${k} onClick=${() => s.roll({ attr: 'WIL', attr2: k, label: drainRollLabel(k), limit: null, applyWounds: false })}>${attrShort('WIL')} + ${attrShort(k)}</${Button}>`)}
    </div>`}

    <h4 class="section-title">${t('Pouvoirs d’adepte')}</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="powers" />`
      : powers.length
        ? html`<div class="sh-cards">${powers.map(
            (p) => html`<div class="sh-card" key=${p.id}>
              <div class="row spread"><b>${p.name}${p.level ? ` ${p.level}` : ''}</b><span class="badge badge-magenta">${t('{v} PP', { v: fmtNum(p.pp) })}</span></div>
              ${p.notes && html`<div class="muted small">${p.notes}</div>`}
            </div>`
          )}</div>`
        : html`<div class="muted small">${t('Aucun pouvoir.')}</div>`}

    <h4 class="section-title">${t('Sorts')}</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="spells" />`
      : spells.length
        ? html`<div class="sh-table-wrap"><table class="sr">
            <thead><tr><th>${t('Sort')}</th><th>${t('Catégorie')}</th><th>${t('Type')}</th><th>${t('Portée')}</th><th>${t('Durée')}</th><th>${t('Drain')}</th><th></th></tr></thead>
            <tbody>${spells.map(
              (sp) => html`<tr key=${sp.id}>
                <td><b>${sp.name}</b>${sp.notes ? html`<div class="faint small">${sp.notes}</div>` : null}</td>
                <td class="small">${sp.category}</td><td>${sp.type}</td><td class="small">${sp.range}</td><td>${sp.duration}</td><td class="mono">${sp.drain}</td>
                <td><${Button} small variant="accent" onClick=${() => s.roll({ skillId: 'spellcasting', label: spellRollLabel(sp.name), limit: null })} title=${t('Lancement de sorts + Magie (limite = Puissance, à régler)')}>${t('sort::Lancer')}</${Button}></td>
              </tr>`
            )}</tbody>
          </table></div>`
        : html`<div class="muted small">${t('Aucun sort.')}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Matrice
// ---------------------------------------------------------------------------
export function MatrixTab({ s }) {
  const { actor, d, edit } = s;
  const m = actor.matrix || null;
  const [picker, setPicker] = useState(false);
  const [newProg, setNewProg] = useState('');
  if (!m) {
    return html`<div class="empty">${t('Aucun appareil matriciel.')}
      ${edit && html`<div style=${{ marginTop: '10px' }}><${Button} variant="primary" onClick=${() => s.update({ matrix: { device: 'Commlink', rating: 3, attack: 0, sleaze: 0, dataProcessing: 3, firewall: 3, programs: [] } })}>${t('Ajouter un commlink / deck')}</${Button}></div>`}
    </div>`;
  }
  const programs = m.programs || [];
  const setM = (patch) => s.update({ matrix: patch });
  const addProg = (name) => {
    const n = String(name || '').trim();
    if (!n || programs.includes(n)) return;
    setM({ programs: [...programs, n] });
    setNewProg('');
  };
  // `label` is the French roll label stored in the log (each viewer translates it).
  const actions = [
    { label: tk('Piratage'), skillId: 'hacking', limit: m.sleaze, sub: tk('Hacking + LOG [Corruption]') },
    { label: tk('Force brute'), skillId: 'cybercombat', limit: m.attack, sub: tk('Cybercombat + LOG [Attaque]') },
    { label: tk('Informatique'), skillId: 'computer', limit: m.dataProcessing, sub: tk('Informatique + LOG [Traitement]') },
    { label: tk('Guerre électronique'), skillId: 'electronic_warfare', limit: m.dataProcessing, sub: tk('GE + LOG [Traitement]') },
    { label: tk('Software'), skillId: 'software', limit: m.dataProcessing, sub: tk('Software + LOG [Traitement]') },
  ].filter((a) => SKILL_BY_ID[a.skillId] && (hasSkill(actor, a.skillId) || SKILL_BY_ID[a.skillId].def));
  const num = (k, label) => html`<div class="field"><span class="field-label">${label}</span><${NumberInput} small value=${m[k] || 0} min=${0} max=${15} onChange=${(v) => setM({ [k]: v })} /></div>`;
  return html`<div class="sh-matrix">
    ${edit
      ? html`<div class="row wrap sh-edit-row">
          <label class="field grow"><span class="field-label">${t('Appareil')}</span><${TextInput} value=${m.device || ''} onChange=${(v) => setM({ device: v })} /></label>
          ${num('rating', t('Indice'))}${num('attack', t('Attaque'))}${num('sleaze', t('Corruption'))}${num('dataProcessing', t('Traitement'))}${num('firewall', t('Firewall'))}
          <${Button} small variant="danger" onClick=${() => s.update({ matrix: null })}>${t('Retirer l’appareil')}</${Button}>
        </div>`
      : html`<div class="sh-deck">
          <div class="sh-deck-name">${m.device || t('Appareil')} <span class="badge badge-cyan">${t('Indice {n}', { n: m.rating || 0 })}</span>
            <${Button} small variant="primary" onClick=${() => openMatrix(actor.id)} title=${t('Cockpit matriciel : connexion, programmes, agent, actions')}>${t('Ouvrir la Matrice')}</${Button}></div>
          <div class="sh-asdf">
            ${[[tk('Attaque'), m.attack], [tk('Corruption'), m.sleaze], [tk('Traitement'), m.dataProcessing], [tk('Firewall'), m.firewall]].map(([l, v]) => html`<div class="sh-asdf-cell" key=${l}><b>${v || 0}</b><span>${t(l)}</span></div>`)}
          </div>
        </div>`}
    <div class="sh-derived">
      <${RollStat} label=${t('Init. RA')} value=${d.initiative.text} />
      <${RollStat} label=${t('Init. RV froide')} value=${`${d.matrixInitiative.cold.base} + 3D6`} />
      <${RollStat} label=${t('Init. RV chaude')} value=${`${d.matrixInitiative.hot.base} + 4D6`} accent="magenta" />
      ${actions.map((a) => html`<${RollStat} key=${a.skillId} label=${t(a.label)} value=${a.limit ?? '—'} sub=${t(a.sub)} onClick=${() => s.roll({ skillId: a.skillId, label: a.label, limit: a.limit || undefined })} />`)}
      <${RollStat} label=${t('Défense matricielle')} value=${attr(actor, 'INT') + (m.firewall || 0)} sub=${t('{attr} + Firewall', { attr: attrShort('INT') })} onClick=${() => s.roll({ attr: 'INT', label: tk('Défense matricielle'), limit: null, bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} />
      <${RollStat} label=${t('Résister (dommages)')} value=${(m.rating || 0) + (m.firewall || 0)} sub=${t('Indice + Firewall')} onClick=${() => s.roll({ pool: (m.rating || 0) + (m.firewall || 0), label: tk('Résistance aux dommages matriciels'), limit: null, applyWounds: false })} />
      ${(m.attack || m.sleaze) ? html`<${RollStat} label=${t('Biofeedback')} value=${attr(actor, 'WIL') + (m.firewall || 0)} sub=${t('{attr} + Firewall', { attr: attrShort('WIL') })} onClick=${() => s.roll({ attr: 'WIL', label: tk('Résistance au biofeedback'), limit: null, applyWounds: false, bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} />` : null}
    </div>
    <h4 class="section-title">${t('Programmes ({n})', { n: programs.length })}</h4>
    <div class="sh-chips">
      ${programs.map((p) => html`<span class="sh-chip" key=${p}>${p}${edit ? html`<button type="button" class="sh-chip-x" title=${t('Retirer')} onClick=${() => setM({ programs: programs.filter((x) => x !== p) })}>✕</button>` : null}</span>`)}
      ${!programs.length && html`<span class="muted small">${t('Aucun programme.')}</span>`}
    </div>
    ${edit && html`<div class="row wrap" style=${{ marginTop: '8px' }}>
      <${TextInput} live value=${newProg} placeholder=${t('Nom du programme')} onChange=${setNewProg} onKeyDown=${(e) => e.key === 'Enter' && addProg(e.target.value)} style=${{ maxWidth: '220px' }} />
      <${Button} small onClick=${() => addProg(newProg)}>${t('Ajouter')}</${Button}>
      <${Button} small variant="primary" onClick=${() => setPicker(true)}>${t('Depuis le catalogue')}</${Button}>
    </div>`}
    ${picker && html`<${CatalogPicker} actor=${actor} list="gear" catalogs=${['programs']} onClose=${() => setPicker(false)} onPick=${(conv, e) => addProg(itemName(e))} />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Équipement
// ---------------------------------------------------------------------------
export function GearTab({ s }) {
  const { actor, d, edit, own } = s;
  const upItem = (list, id, patch) => send('actor/updateItem', { actorId: actor.id, list, itemId: id, patch }).catch(() => {});
  const armor = actor.armor || [];
  const augs = actor.augmentations || [];
  const gear = actor.gear || [];
  const vehicles = actor.vehicles || [];
  const essUsed = augs.reduce((sum, a) => sum + (Number(a.essence) || 0), 0);
  if (edit) {
    return html`<div class="sh-gear">
      <h4 class="section-title">${t('Armures')}</h4><${ListEditor} actor=${actor} list="armor" />
      <h4 class="section-title">${t('Augmentations')}</h4><${ListEditor} actor=${actor} list="augmentations" />
      <h4 class="section-title">${t('Équipement')}</h4><${ListEditor} actor=${actor} list="gear" />
      <h4 class="section-title">${t('Véhicules & drones')}</h4><${ListEditor} actor=${actor} list="vehicles" />
    </div>`;
  }
  return html`<div class="sh-gear">
    <div class="sh-sec-head"><h4 class="section-title">${t('Armures')}</h4><span class="badge badge-cyan">${t('Armure totale {n}', { n: d.armor })}</span></div>
    ${armor.length
      ? html`<div class="sh-list">${armor.map(
          (a) => html`<div class=${'sh-list-row' + (a.equipped ? ' on' : '')} key=${a.id}>
            ${own
              ? html`<${Toggle} value=${a.equipped} onChange=${(v) => upItem('armor', a.id, { equipped: v })} title=${t('Équiper / retirer')} />`
              : html`<span class=${'badge ' + (a.equipped ? 'badge-cyan' : '')}>${a.equipped ? t('portée') : t('rangée')}</span>`}
            <div class="grow"><b>${a.name}</b>${a.notes ? html`<div class="faint small">${a.notes}</div>` : null}</div>
            <span class="mono sh-big">${a.stack ? '+' : ''}${a.rating}</span>
          </div>`
        )}</div>`
      : html`<div class="muted small">${t('Aucune armure.')}</div>`}

    <div class="sh-sec-head"><h4 class="section-title">${t('Augmentations')}</h4><span class="badge">${t('Essence {ess} (−{used})', { ess: fmtNum(Math.round(d.essence * 100) / 100), used: fmtNum(Math.round(essUsed * 100) / 100) })}</span></div>
    ${augs.length
      ? html`<div class="sh-list">${augs.map(
          (a) => html`<div class="sh-list-row" key=${a.id}>
            <span class=${'badge ' + (a.kind === 'bioware' ? 'badge-green' : 'badge-cyan')}>${a.kind === 'bioware' ? 'Bio' : 'Cyber'}</span>
            <div class="grow"><b>${a.name}</b>${a.rating ? ` (${t('indice {n}', { n: a.rating })})` : ''}${a.grade && a.grade !== 'standard' ? html` <span class="badge">${gradeLabel(a.grade)}</span>` : null}
              ${a.notes ? html`<div class="faint small">${a.notes}</div>` : null}</div>
            <span class="mono">${t('{v} ESS', { v: fmtNum(Math.round((Number(a.essence) || 0) * 1000) / 1000) })}</span>
          </div>`
        )}</div>`
      : html`<div class="muted small">${t('Aucune augmentation.')}</div>`}

    <h4 class="section-title">${t('Équipement')}</h4>
    ${gear.length
      ? html`<div class="sh-list">${gear.map(
          (g) => html`<div class="sh-list-row" key=${g.id}>
            <div class="grow"><b>${g.name}</b>${g.rating ? ` (${t('indice {n}', { n: g.rating })})` : ''} <span class="faint small">${g.category || ''}</span>
              ${own
                ? html`<${TextInput} class="sh-inline-note" value=${g.notes || ''} placeholder=${t('Notes…')} onChange=${(v) => upItem('gear', g.id, { notes: v })} />`
                : g.notes
                  ? html`<div class="faint small">${g.notes}</div>`
                  : null}</div>
            ${own ? html`<${NumberInput} small value=${g.qty ?? 1} min=${0} max=${s.gm ? 9999 : Math.max(0, Number(g.qty ?? 1) || 0)} onChange=${(v) => upItem('gear', g.id, { qty: v })} />` : html`<span class="mono">×${g.qty ?? 1}</span>`}
          </div>`
        )}</div>`
      : html`<div class="muted small">${t('Aucun équipement.')}</div>`}

    ${vehicles.length > 0 && html`<h4 class="section-title">${t('Véhicules & drones')}</h4>
      <div class="sh-cards">${vehicles.map(
        (v) => html`<div class="sh-card" key=${v.id}>
          <b>${v.name}</b>
          <div class="sh-vstats">
            ${[[tk('Maniab.'), v.handling], [tk('Vitesse'), v.speed], [tk('Accél.'), v.accel], [tk('Struct.'), v.body], [tk('Blind.'), v.armor], [tk('Autopilote'), v.pilot], [tk('Senseurs'), v.sensor], [tk('Places'), v.seats]].map(([l, x]) => html`<span key=${l}><span class="faint">${t(l)}</span> <b>${x ?? '—'}</b></span>`)}
          </div>
          ${v.notes && html`<div class="faint small">${v.notes}</div>`}
        </div>`
      )}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Contacts & SIN
// ---------------------------------------------------------------------------
export function ContactsTab({ s }) {
  const { actor, edit, own, gm } = s;
  const contacts = actor.contacts || [];
  const sins = actor.sins || [];
  const ls = actor.lifestyle;
  const upItem = (id, patch) => send('actor/updateItem', { actorId: actor.id, list: 'contacts', itemId: id, patch }).catch(() => {});
  if (edit) {
    return html`<div>
      <h4 class="section-title">${t('Contacts')}</h4><${ListEditor} actor=${actor} list="contacts" />
      <h4 class="section-title">${t('SIN & licences')}</h4><${ListEditor} actor=${actor} list="sins" />
      <h4 class="section-title">${t('Mode de vie')}</h4>
      <div class="row wrap sh-edit-row">
        <label class="field"><span class="field-label">${t('Niveau')}</span><${TextInput} value=${ls?.name || ''} placeholder=${t('Moyen…')} onChange=${(v) => s.update({ lifestyle: { name: v } })} /></label>
        <div class="field"><span class="field-label">${t('Coût mensuel (¥)')}</span><${NumberInput} value=${ls?.monthlyCost || 0} min=${0} max=${1000000} step=${100} onChange=${(v) => s.update({ lifestyle: { monthlyCost: v } })} /></div>
        <div class="field"><span class="field-label">${t('Mois payés')}</span><${NumberInput} value=${ls?.monthsPaid || 0} min=${0} max=${120} onChange=${(v) => s.update({ lifestyle: { monthsPaid: v } })} /></div>
      </div>
    </div>`;
  }
  return html`<div>
    <h4 class="section-title">${t('Contacts')}</h4>
    ${contacts.length
      ? html`<div class="sh-cards">${contacts.map(
          (c) => html`<div class="sh-card sh-contact" key=${c.id}>
            <div class="row spread"><b>${c.name}</b>
              <span class="row gap-s"><span class="badge badge-cyan" title=${t('contact::Connexion')}>C${c.connection ?? 0}</span><span class="badge badge-magenta" title=${t('Loyauté')}>L${c.loyalty ?? 0}</span></span></div>
            ${c.role && html`<div class="muted small">${c.role}</div>`}
            ${own
              ? html`<${TextInput} multiline rows=${2} class="sh-inline-note" value=${c.notes || ''} placeholder=${t('Notes…')} onChange=${(v) => upItem(c.id, { notes: v })} />`
              : c.notes
                ? html`<div class="faint small">${c.notes}</div>`
                : null}
          </div>`
        )}</div>`
      : html`<div class="muted small">${t('Aucun contact.')}</div>`}

    <h4 class="section-title">${t('SIN & licences')}</h4>
    ${sins.length
      ? html`<div class="sh-cards">${sins.map(
          (x) => html`<div class="sh-card" key=${x.id}>
            <div class="row spread"><b>${x.name}</b><span class="badge badge-amber">${t('Indice {n}', { n: x.rating ?? '?' })}</span></div>
            ${(x.licenses || []).length ? html`<div class="row wrap gap-s">${x.licenses.map((l) => html`<span class="badge" key=${l}>${l}</span>`)}</div>` : html`<div class="faint small">${t('Aucune licence')}</div>`}
            ${x.notes && html`<div class="faint small">${x.notes}</div>`}
          </div>`
        )}</div>`
      : html`<div class="muted small">${t('Aucun SIN.')}</div>`}

    ${ls && html`<h4 class="section-title">${t('Mode de vie')}</h4>
      <div class="row wrap"><span class="badge badge-cyan">${ls.name || '—'}</span><span class="muted">${t('{cost}/mois', { cost: fmtNuyen(ls.monthlyCost || 0) })}</span>
        ${gm || own ? html`<span class="muted small">· ${t('{n} mois payé(s)', { n: ls.monthsPaid || 0 })}</span>` : null}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Qualités
// ---------------------------------------------------------------------------
export function QualitiesTab({ s }) {
  const { actor, edit } = s;
  const qs = actor.qualities || [];
  if (edit) return html`<${ListEditor} actor=${actor} list="qualities" />`;
  const pos = qs.filter((q) => q.positive !== false && (q.karma || 0) >= 0);
  const neg = qs.filter((q) => !pos.includes(q));
  const col = (title, list, color) => html`<section>
    <div class="sh-sec-head"><h4 class="section-title">${title}</h4><span class=${'badge badge-' + color}>${t('{v} karma', { v: signed(list.reduce((sum, q) => sum + (q.karma || 0), 0)) })}</span></div>
    ${list.length
      ? html`<div class="sh-list">${list.map(
          (q) => html`<div class="sh-list-row" key=${q.id}>
            <div class="grow"><b>${q.name}</b>${q.notes ? html`<div class="faint small">${q.notes}</div>` : null}</div>
            <span class=${'mono ' + color}>${signed(q.karma || 0)}</span>
          </div>`
        )}</div>`
      : html`<div class="muted small">${t('Aucune.')}</div>`}
  </section>`;
  return html`<div class="grid-2">${col(t('Qualités positives'), pos, 'green')}${col(t('Qualités négatives'), neg, 'red')}</div>`;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
function MdField({ title, value, canEdit, onSave, placeholder, accent }) {
  const [editing, setEditing] = useState(false);
  return html`<section class=${'sh-md' + (accent ? ' sh-md-' + accent : '')}>
    <div class="sh-sec-head"><h4 class="section-title">${title}</h4>
      ${canEdit && html`<${Button} small variant="ghost" onClick=${() => setEditing(!editing)}>${editing ? t('Aperçu') : t('Modifier')}</${Button}>`}</div>
    ${editing
      ? html`<${TextInput} multiline rows=${10} value=${value || ''} placeholder=${placeholder} onChange=${onSave} />
          <div class="faint small">${t('Markdown : **gras**, *italique*, listes « - », titres « ## ». Enregistré en quittant le champ.')}</div>`
      : value
        ? html`<${Markdown} text=${value} />`
        : html`<div class="muted small">${canEdit ? t('Vide — clique « Modifier ».') : t('Rien pour l’instant.')}</div>`}
  </section>`;
}

export function NotesTab({ s }) {
  const { actor, own, gm } = s;
  return html`<div class="col gap-l">
    ${(own || actor.notes !== undefined) && html`<${MdField} title=${gm ? t('Notes (joueur + MJ)') : t('Mes notes')} value=${actor.notes} canEdit=${own} onSave=${(v) => s.update({ notes: v })} placeholder=${t('Pistes, noms, dettes, plans…')} />`}
    <${MdField} title=${t('Biographie')} value=${actor.bio} canEdit=${own} onSave=${(v) => s.update({ bio: v })} placeholder=${t('Passé, apparence, motivations…')} />
    ${gm && html`<${MdField} title=${t('Notes du MJ (secrètes)')} accent="magenta" value=${actor.gmNotes} canEdit=${true} onSave=${(v) => s.update({ gmNotes: v })} placeholder=${t('Secrets, accroches, faiblesses à exploiter…')} />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------
function AdjustForm({ actor }) {
  const [karma, setKarma] = useState(0);
  const [ny, setNy] = useState(0);
  const [reason, setReason] = useState('');
  const go = () =>
    send('actor/adjust', { actorId: actor.id, karma, nuyen: ny, reason })
      .then(() => {
        setKarma(0);
        setNy(0);
        setReason('');
      })
      .catch(() => {});
  return html`<div class="sh-adjust row wrap">
    <div class="field"><span class="field-label">${t('Karma')}</span><${NumberInput} small value=${karma} min=${-500} max=${500} onChange=${setKarma} /></div>
    <div class="field"><span class="field-label">${t('Nuyens')}</span><${NumberInput} small value=${ny} min=${-10000000} max=${10000000} step=${100} onChange=${setNy} /></div>
    <label class="field grow"><span class="field-label">${t('Raison')}</span><${TextInput} live value=${reason} placeholder=${t('Récompense de run, dette, achat hors boutique…')} onChange=${setReason} /></label>
    <${Button} variant="primary" disabled=${!karma && !ny} onClick=${go}>${t('Appliquer')}</${Button}>
  </div>`;
}

export function HistoryTab({ s }) {
  const { actor, gm, edit } = s;
  const h = [...(actor.history || [])].reverse();
  const totK = (actor.history || []).reduce((sum, e) => sum + (e.karma || 0), 0);
  const totN = (actor.history || []).reduce((sum, e) => sum + (e.nuyen || 0), 0);
  return html`<div>
    <div class="sh-derived">
      <${RollStat} label=${t('Karma disponible')} value=${actor.karma} accent="amber" />
      <${RollStat} label=${t('Karma de carrière')} value=${actor.karmaTotal} />
      <${RollStat} label=${t('Nuyens')} value=${fmtNuyen(actor.nuyen)} accent="cyan" />
      ${edit && html`<div class="field"><span class="field-label">${t('Karma (direct)')}</span><${NumberInput} small value=${actor.karma} min=${-999} max=${99999} onChange=${(v) => s.update({ karma: v })} /></div>
        <div class="field"><span class="field-label">${t('Carrière')}</span><${NumberInput} small value=${actor.karmaTotal} min=${0} max=${99999} onChange=${(v) => s.update({ karmaTotal: v })} /></div>
        <div class="field"><span class="field-label">${t('Nuyens (direct)')}</span><${NumberInput} small value=${actor.nuyen} min=${0} max=${1e9} step=${100} onChange=${(v) => s.update({ nuyen: v })} /></div>`}
    </div>
    ${gm && html`<h4 class="section-title">${t('Ajustement (consigné dans l’historique)')}</h4><${AdjustForm} actor=${actor} />`}
    <h4 class="section-title">${t('Registre')}</h4>
    ${h.length
      ? html`<div class="sh-table-wrap"><table class="sr">
          <thead><tr><th>${t('Date')}</th><th>${t('Opération')}</th><th class="right">${t('Karma')}</th><th class="right">${t('Nuyens')}</th></tr></thead>
          <tbody>${h.map(
            (e, i) => html`<tr key=${i}>
              <td class="small muted">${fmtDate(e.ts)}</td><td>${e.i18n?.key ? t(e.i18n.key, e.i18n.params) : tIfKnown(e.text)}</td>
              <td class=${'num-cell ' + ((e.karma || 0) > 0 ? 'green' : (e.karma || 0) < 0 ? 'red' : 'faint')}>${e.karma ? signed(e.karma) : '—'}</td>
              <td class=${'num-cell ' + ((e.nuyen || 0) > 0 ? 'green' : (e.nuyen || 0) < 0 ? 'red' : 'faint')}>${e.nuyen ? (e.nuyen > 0 ? '+' : '−') + fmtNuyen(Math.abs(e.nuyen)) : '—'}</td>
            </tr>`
          )}</tbody>
          <tfoot><tr><td></td><td class="muted small">${t('Total des mouvements')}</td><td class="num-cell">${signed(totK)}</td><td class="num-cell">${fmtNuyen(totN)}</td></tr></tfoot>
        </table></div>`
      : html`<div class="muted small">${t('Aucune opération.')}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// PNJ (GM)
// ---------------------------------------------------------------------------
export function NpcTab({ s, game }) {
  const { actor } = s;
  const npc = actor.npc || {};
  const tpl = actor.templateId && game.bestiary?.[actor.templateId];
  const setN = (patch) => s.update({ npc: patch });
  return html`<div class="col gap-l">
    <div class="row wrap sh-edit-row">
      <div class="field"><span class="field-label">${t('Indice de professionnalisme')}</span><${NumberInput} small value=${npc.professionalRating || 0} min=${0} max=${7} onChange=${(v) => setN({ professionalRating: v })} /></div>
      <${Toggle} value=${!!npc.grunt} onChange=${(v) => setN({ grunt: v })} label=${t('Sbire (moniteur de groupe)')} />
      <${Toggle} value=${!!actor.hidden} onChange=${(v) => s.update({ hidden: v })} label=${t('Caché aux joueurs')} />
      <label class="field"><span class="field-label">${t('Type')}</span><${Select} value=${actor.type} options=${[{ value: 'npc', label: t('PNJ') }, { value: 'pc', label: t('PJ') }]} onChange=${(v) => s.update({ type: v })} /></label>
      ${tpl ? html`<span class="badge badge-amber">${t('Modèle : {name}', { name: tpl.name })}</span>` : actor.templateId ? html`<span class="badge">${t('Modèle {id}', { id: actor.templateId })}</span>` : null}
    </div>
    <${MdField} title=${t('Tactiques')} accent="magenta" value=${npc.tactics} canEdit=${true} onSave=${(v) => setN({ tactics: v })} placeholder=${t('Comportement en combat, réactions, moral…')} />
    <${MdField} title=${t('Butin')} value=${npc.loot} canEdit=${true} onSave=${(v) => setN({ loot: v })} placeholder=${t('Ce que les runners trouvent sur le corps…')} />
  </div>`;
}
