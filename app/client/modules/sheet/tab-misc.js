// Sheet tabs: Magie, Matrice, Équipement, Contacts & SIN, Qualités, Notes, Historique, PNJ.
import { useState } from 'preact/hooks';
import { html, Button, NumberInput, TextInput, Toggle, Markdown, Select } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { attr, SKILL_BY_ID } from '/shared/sr5.js';
import { nuyen } from '/shared/util.js';
import { fmtDate, fmtNum, signed } from './common.js';
import { RollStat } from './tab-summary.js';
import { ListEditor, CatalogPicker } from './editors.js';

const hasSkill = (actor, id) => (actor.skills || []).some((s) => s.id === id && s.rating > 0);

// ---------------------------------------------------------------------------
// Magie
// ---------------------------------------------------------------------------
export function MagicTab({ s }) {
  const { actor, d, edit } = s;
  const mag = attr(actor, 'MAG');
  const powers = actor.powers || [];
  const spells = actor.spells || [];
  const pp = powers.reduce((t, p) => t + (Number(p.pp) || 0), 0);
  return html`<div class="sh-magic">
    <div class="sh-derived">
      <${RollStat} label="Magie" value=${mag} accent="magenta" />
      <${RollStat} label="Init. astrale" value=${`${d.astralInitiative.base} + 2D6`} />
      ${d.limits.astral ? html`<${RollStat} label="Limite astrale" value=${d.limits.astral} />` : null}
      ${powers.length > 0 && html`<${RollStat} label="Points de pouvoir" value=${`${fmtNum(pp)} / ${mag}`} accent=${pp > mag ? 'magenta' : 'cyan'} title="PP dépensés / Magie" />`}
      ${hasSkill(actor, 'assensing') && html`<${RollStat} label="Observation astrale" value="INT" onClick=${() => s.roll({ skillId: 'assensing' })} />`}
      ${hasSkill(actor, 'spellcasting') && html`<${RollStat} label="Lancer un sort" value="MAG" onClick=${() => s.roll({ skillId: 'spellcasting', label: 'Lancement de sort', limit: null })} />`}
      ${hasSkill(actor, 'counterspelling') && html`<${RollStat} label="Contresort" value="MAG" onClick=${() => s.roll({ skillId: 'counterspelling' })} />`}
      ${hasSkill(actor, 'summoning') && html`<${RollStat} label="Invocation" value="MAG" onClick=${() => s.roll({ skillId: 'summoning', limit: null })} />`}
    </div>
    ${(spells.length > 0 || hasSkill(actor, 'spellcasting') || hasSkill(actor, 'summoning')) && html`<div class="row wrap">
      <span class="muted small">Résister au drain :</span>
      ${['LOG', 'CHA', 'INT'].map((k) => html`<${Button} small key=${k} onClick=${() => s.roll({ attr: 'WIL', attr2: k, label: `Résistance au drain (VOL + ${k})`, limit: null, applyWounds: false })}>VOL + ${k}</${Button}>`)}
    </div>`}

    <h4 class="section-title">Pouvoirs d’adepte</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="powers" />`
      : powers.length
        ? html`<div class="sh-cards">${powers.map(
            (p) => html`<div class="sh-card" key=${p.id}>
              <div class="row spread"><b>${p.name}${p.level ? ` ${p.level}` : ''}</b><span class="badge badge-magenta">${fmtNum(p.pp)} PP</span></div>
              ${p.notes && html`<div class="muted small">${p.notes}</div>`}
            </div>`
          )}</div>`
        : html`<div class="muted small">Aucun pouvoir.</div>`}

    <h4 class="section-title">Sorts</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="spells" />`
      : spells.length
        ? html`<div class="sh-table-wrap"><table class="sr">
            <thead><tr><th>Sort</th><th>Catégorie</th><th>Type</th><th>Portée</th><th>Durée</th><th>Drain</th><th></th></tr></thead>
            <tbody>${spells.map(
              (sp) => html`<tr key=${sp.id}>
                <td><b>${sp.name}</b>${sp.notes ? html`<div class="faint small">${sp.notes}</div>` : null}</td>
                <td class="small">${sp.category}</td><td>${sp.type}</td><td class="small">${sp.range}</td><td>${sp.duration}</td><td class="mono">${sp.drain}</td>
                <td><${Button} small variant="accent" onClick=${() => s.roll({ skillId: 'spellcasting', label: `Sort — ${sp.name}`, limit: null })} title="Lancement de sorts + Magie (limite = Puissance, à régler)">Lancer</${Button}></td>
              </tr>`
            )}</tbody>
          </table></div>`
        : html`<div class="muted small">Aucun sort.</div>`}
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
    return html`<div class="empty">Aucun appareil matriciel.
      ${edit && html`<div style=${{ marginTop: '10px' }}><${Button} variant="primary" onClick=${() => s.update({ matrix: { device: 'Commlink', rating: 3, attack: 0, sleaze: 0, dataProcessing: 3, firewall: 3, programs: [] } })}>Ajouter un commlink / deck</${Button}></div>`}
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
  const actions = [
    { label: 'Piratage', skillId: 'hacking', limit: m.sleaze, sub: 'Hacking + LOG [Corruption]' },
    { label: 'Force brute', skillId: 'cybercombat', limit: m.attack, sub: 'Cybercombat + LOG [Attaque]' },
    { label: 'Informatique', skillId: 'computer', limit: m.dataProcessing, sub: 'Informatique + LOG [Traitement]' },
    { label: 'Guerre électronique', skillId: 'electronic_warfare', limit: m.dataProcessing, sub: 'GE + LOG [Traitement]' },
    { label: 'Software', skillId: 'software', limit: m.dataProcessing, sub: 'Software + LOG [Traitement]' },
  ].filter((a) => SKILL_BY_ID[a.skillId] && (hasSkill(actor, a.skillId) || SKILL_BY_ID[a.skillId].def));
  const num = (k, label) => html`<div class="field"><span class="field-label">${label}</span><${NumberInput} small value=${m[k] || 0} min=${0} max=${15} onChange=${(v) => setM({ [k]: v })} /></div>`;
  return html`<div class="sh-matrix">
    ${edit
      ? html`<div class="row wrap sh-edit-row">
          <label class="field grow"><span class="field-label">Appareil</span><${TextInput} value=${m.device || ''} onChange=${(v) => setM({ device: v })} /></label>
          ${num('rating', 'Indice')}${num('attack', 'Attaque')}${num('sleaze', 'Corruption')}${num('dataProcessing', 'Traitement')}${num('firewall', 'Firewall')}
          <${Button} small variant="danger" onClick=${() => s.update({ matrix: null })}>Retirer l’appareil</${Button}>
        </div>`
      : html`<div class="sh-deck">
          <div class="sh-deck-name">${m.device || 'Appareil'} <span class="badge badge-cyan">Indice ${m.rating || 0}</span></div>
          <div class="sh-asdf">
            ${[['Attaque', m.attack], ['Corruption', m.sleaze], ['Traitement', m.dataProcessing], ['Firewall', m.firewall]].map(([l, v]) => html`<div class="sh-asdf-cell" key=${l}><b>${v || 0}</b><span>${l}</span></div>`)}
          </div>
        </div>`}
    <div class="sh-derived">
      <${RollStat} label="Init. RA" value=${d.initiative.text} />
      <${RollStat} label="Init. RV froide" value=${`${d.matrixInitiative.cold.base} + 3D6`} />
      <${RollStat} label="Init. RV chaude" value=${`${d.matrixInitiative.hot.base} + 4D6`} accent="magenta" />
      ${actions.map((a) => html`<${RollStat} key=${a.skillId} label=${a.label} value=${a.limit ?? '—'} sub=${a.sub} onClick=${() => s.roll({ skillId: a.skillId, label: a.label, limit: a.limit || undefined })} />`)}
      <${RollStat} label="Défense matricielle" value=${attr(actor, 'INT') + (m.firewall || 0)} sub="INT + Firewall" onClick=${() => s.roll({ attr: 'INT', label: 'Défense matricielle', limit: null, bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} />
      <${RollStat} label="Résister (dommages)" value=${(m.rating || 0) + (m.firewall || 0)} sub="Indice + Firewall" onClick=${() => s.roll({ pool: (m.rating || 0) + (m.firewall || 0), label: 'Résistance aux dommages matriciels', limit: null, applyWounds: false })} />
      ${(m.attack || m.sleaze) ? html`<${RollStat} label="Biofeedback" value=${attr(actor, 'WIL') + (m.firewall || 0)} sub="VOL + Firewall" onClick=${() => s.roll({ attr: 'WIL', label: 'Résistance au biofeedback', limit: null, applyWounds: false, bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} />` : null}
    </div>
    <h4 class="section-title">Programmes (${programs.length})</h4>
    <div class="sh-chips">
      ${programs.map((p) => html`<span class="sh-chip" key=${p}>${p}${edit ? html`<button type="button" class="sh-chip-x" title="Retirer" onClick=${() => setM({ programs: programs.filter((x) => x !== p) })}>✕</button>` : null}</span>`)}
      ${!programs.length && html`<span class="muted small">Aucun programme.</span>`}
    </div>
    ${edit && html`<div class="row wrap" style=${{ marginTop: '8px' }}>
      <${TextInput} live value=${newProg} placeholder="Nom du programme" onChange=${setNewProg} onKeyDown=${(e) => e.key === 'Enter' && addProg(e.target.value)} style=${{ maxWidth: '220px' }} />
      <${Button} small onClick=${() => addProg(newProg)}>Ajouter</${Button}>
      <${Button} small variant="primary" onClick=${() => setPicker(true)}>Depuis le catalogue</${Button}>
    </div>`}
    ${picker && html`<${CatalogPicker} actor=${actor} list="gear" catalogs=${['programs']} onClose=${() => setPicker(false)} onPick=${(conv, e) => addProg(e.nameFr || e.name)} />`}
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
  const essUsed = augs.reduce((t, a) => t + (Number(a.essence) || 0), 0);
  if (edit) {
    return html`<div class="sh-gear">
      <h4 class="section-title">Armures</h4><${ListEditor} actor=${actor} list="armor" />
      <h4 class="section-title">Augmentations</h4><${ListEditor} actor=${actor} list="augmentations" />
      <h4 class="section-title">Équipement</h4><${ListEditor} actor=${actor} list="gear" />
      <h4 class="section-title">Véhicules & drones</h4><${ListEditor} actor=${actor} list="vehicles" />
    </div>`;
  }
  return html`<div class="sh-gear">
    <div class="sh-sec-head"><h4 class="section-title">Armures</h4><span class="badge badge-cyan">Armure totale ${d.armor}</span></div>
    ${armor.length
      ? html`<div class="sh-list">${armor.map(
          (a) => html`<div class=${'sh-list-row' + (a.equipped ? ' on' : '')} key=${a.id}>
            ${own
              ? html`<${Toggle} value=${a.equipped} onChange=${(v) => upItem('armor', a.id, { equipped: v })} title="Équiper / retirer" />`
              : html`<span class=${'badge ' + (a.equipped ? 'badge-cyan' : '')}>${a.equipped ? 'portée' : 'rangée'}</span>`}
            <div class="grow"><b>${a.name}</b>${a.notes ? html`<div class="faint small">${a.notes}</div>` : null}</div>
            <span class="mono sh-big">${a.stack ? '+' : ''}${a.rating}</span>
          </div>`
        )}</div>`
      : html`<div class="muted small">Aucune armure.</div>`}

    <div class="sh-sec-head"><h4 class="section-title">Augmentations</h4><span class="badge">Essence ${fmtNum(Math.round(d.essence * 100) / 100)} (−${fmtNum(Math.round(essUsed * 100) / 100)})</span></div>
    ${augs.length
      ? html`<div class="sh-list">${augs.map(
          (a) => html`<div class="sh-list-row" key=${a.id}>
            <span class=${'badge ' + (a.kind === 'bioware' ? 'badge-green' : 'badge-cyan')}>${a.kind === 'bioware' ? 'Bio' : 'Cyber'}</span>
            <div class="grow"><b>${a.name}</b>${a.rating ? ` (indice ${a.rating})` : ''}${a.grade && a.grade !== 'standard' ? html` <span class="badge">${a.grade}</span>` : null}
              ${a.notes ? html`<div class="faint small">${a.notes}</div>` : null}</div>
            <span class="mono">${fmtNum(Math.round((Number(a.essence) || 0) * 1000) / 1000)} ESS</span>
          </div>`
        )}</div>`
      : html`<div class="muted small">Aucune augmentation.</div>`}

    <h4 class="section-title">Équipement</h4>
    ${gear.length
      ? html`<div class="sh-list">${gear.map(
          (g) => html`<div class="sh-list-row" key=${g.id}>
            <div class="grow"><b>${g.name}</b>${g.rating ? ` (indice ${g.rating})` : ''} <span class="faint small">${g.category || ''}</span>
              ${own
                ? html`<${TextInput} class="sh-inline-note" value=${g.notes || ''} placeholder="Notes…" onChange=${(v) => upItem('gear', g.id, { notes: v })} />`
                : g.notes
                  ? html`<div class="faint small">${g.notes}</div>`
                  : null}</div>
            ${own ? html`<${NumberInput} small value=${g.qty ?? 1} min=${0} max=${s.gm ? 9999 : Math.max(0, Number(g.qty ?? 1) || 0)} onChange=${(v) => upItem('gear', g.id, { qty: v })} />` : html`<span class="mono">×${g.qty ?? 1}</span>`}
          </div>`
        )}</div>`
      : html`<div class="muted small">Aucun équipement.</div>`}

    ${vehicles.length > 0 && html`<h4 class="section-title">Véhicules & drones</h4>
      <div class="sh-cards">${vehicles.map(
        (v) => html`<div class="sh-card" key=${v.id}>
          <b>${v.name}</b>
          <div class="sh-vstats">
            ${[['Maniab.', v.handling], ['Vitesse', v.speed], ['Accél.', v.accel], ['Struct.', v.body], ['Blind.', v.armor], ['Autopilote', v.pilot], ['Senseurs', v.sensor], ['Places', v.seats]].map(([l, x]) => html`<span key=${l}><span class="faint">${l}</span> <b>${x ?? '—'}</b></span>`)}
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
      <h4 class="section-title">Contacts</h4><${ListEditor} actor=${actor} list="contacts" />
      <h4 class="section-title">SIN & licences</h4><${ListEditor} actor=${actor} list="sins" />
      <h4 class="section-title">Mode de vie</h4>
      <div class="row wrap sh-edit-row">
        <label class="field"><span class="field-label">Niveau</span><${TextInput} value=${ls?.name || ''} placeholder="Moyen…" onChange=${(v) => s.update({ lifestyle: { name: v } })} /></label>
        <div class="field"><span class="field-label">Coût mensuel (¥)</span><${NumberInput} value=${ls?.monthlyCost || 0} min=${0} max=${1000000} step=${100} onChange=${(v) => s.update({ lifestyle: { monthlyCost: v } })} /></div>
        <div class="field"><span class="field-label">Mois payés</span><${NumberInput} value=${ls?.monthsPaid || 0} min=${0} max=${120} onChange=${(v) => s.update({ lifestyle: { monthsPaid: v } })} /></div>
      </div>
    </div>`;
  }
  return html`<div>
    <h4 class="section-title">Contacts</h4>
    ${contacts.length
      ? html`<div class="sh-cards">${contacts.map(
          (c) => html`<div class="sh-card sh-contact" key=${c.id}>
            <div class="row spread"><b>${c.name}</b>
              <span class="row gap-s"><span class="badge badge-cyan" title="Connexion">C${c.connection ?? 0}</span><span class="badge badge-magenta" title="Loyauté">L${c.loyalty ?? 0}</span></span></div>
            ${c.role && html`<div class="muted small">${c.role}</div>`}
            ${own
              ? html`<${TextInput} multiline rows=${2} class="sh-inline-note" value=${c.notes || ''} placeholder="Notes…" onChange=${(v) => upItem(c.id, { notes: v })} />`
              : c.notes
                ? html`<div class="faint small">${c.notes}</div>`
                : null}
          </div>`
        )}</div>`
      : html`<div class="muted small">Aucun contact.</div>`}

    <h4 class="section-title">SIN & licences</h4>
    ${sins.length
      ? html`<div class="sh-cards">${sins.map(
          (x) => html`<div class="sh-card" key=${x.id}>
            <div class="row spread"><b>${x.name}</b><span class="badge badge-amber">Indice ${x.rating ?? '?'}</span></div>
            ${(x.licenses || []).length ? html`<div class="row wrap gap-s">${x.licenses.map((l) => html`<span class="badge" key=${l}>${l}</span>`)}</div>` : html`<div class="faint small">Aucune licence</div>`}
            ${x.notes && html`<div class="faint small">${x.notes}</div>`}
          </div>`
        )}</div>`
      : html`<div class="muted small">Aucun SIN.</div>`}

    ${ls && html`<h4 class="section-title">Mode de vie</h4>
      <div class="row wrap"><span class="badge badge-cyan">${ls.name || '—'}</span><span class="muted">${nuyen(ls.monthlyCost || 0)}/mois</span>
        ${gm || own ? html`<span class="muted small">· ${ls.monthsPaid || 0} mois payé(s)</span>` : null}</div>`}
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
    <div class="sh-sec-head"><h4 class="section-title">${title}</h4><span class=${'badge badge-' + color}>${signed(list.reduce((t, q) => t + (q.karma || 0), 0))} karma</span></div>
    ${list.length
      ? html`<div class="sh-list">${list.map(
          (q) => html`<div class="sh-list-row" key=${q.id}>
            <div class="grow"><b>${q.name}</b>${q.notes ? html`<div class="faint small">${q.notes}</div>` : null}</div>
            <span class=${'mono ' + color}>${signed(q.karma || 0)}</span>
          </div>`
        )}</div>`
      : html`<div class="muted small">Aucune.</div>`}
  </section>`;
  return html`<div class="grid-2">${col('Qualités positives', pos, 'green')}${col('Qualités négatives', neg, 'red')}</div>`;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
function MdField({ title, value, canEdit, onSave, placeholder, accent }) {
  const [editing, setEditing] = useState(false);
  return html`<section class=${'sh-md' + (accent ? ' sh-md-' + accent : '')}>
    <div class="sh-sec-head"><h4 class="section-title">${title}</h4>
      ${canEdit && html`<${Button} small variant="ghost" onClick=${() => setEditing(!editing)}>${editing ? 'Aperçu' : 'Modifier'}</${Button}>`}</div>
    ${editing
      ? html`<${TextInput} multiline rows=${10} value=${value || ''} placeholder=${placeholder} onChange=${onSave} />
          <div class="faint small">Markdown : **gras**, *italique*, listes « - », titres « ## ». Enregistré en quittant le champ.</div>`
      : value
        ? html`<${Markdown} text=${value} />`
        : html`<div class="muted small">${canEdit ? 'Vide — clique « Modifier ».' : 'Rien pour l’instant.'}</div>`}
  </section>`;
}

export function NotesTab({ s }) {
  const { actor, own, gm } = s;
  return html`<div class="col gap-l">
    ${(own || actor.notes !== undefined) && html`<${MdField} title=${gm ? 'Notes (joueur + MJ)' : 'Mes notes'} value=${actor.notes} canEdit=${own} onSave=${(v) => s.update({ notes: v })} placeholder="Pistes, noms, dettes, plans…" />`}
    <${MdField} title="Biographie" value=${actor.bio} canEdit=${own} onSave=${(v) => s.update({ bio: v })} placeholder="Passé, apparence, motivations…" />
    ${gm && html`<${MdField} title="Notes du MJ (secrètes)" accent="magenta" value=${actor.gmNotes} canEdit=${true} onSave=${(v) => s.update({ gmNotes: v })} placeholder="Secrets, accroches, faiblesses à exploiter…" />`}
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
    <div class="field"><span class="field-label">Karma</span><${NumberInput} small value=${karma} min=${-500} max=${500} onChange=${setKarma} /></div>
    <div class="field"><span class="field-label">Nuyens</span><${NumberInput} small value=${ny} min=${-10000000} max=${10000000} step=${100} onChange=${setNy} /></div>
    <label class="field grow"><span class="field-label">Raison</span><${TextInput} live value=${reason} placeholder="Récompense de run, dette, achat hors boutique…" onChange=${setReason} /></label>
    <${Button} variant="primary" disabled=${!karma && !ny} onClick=${go}>Appliquer</${Button}>
  </div>`;
}

export function HistoryTab({ s }) {
  const { actor, gm, edit } = s;
  const h = [...(actor.history || [])].reverse();
  const totK = (actor.history || []).reduce((t, e) => t + (e.karma || 0), 0);
  const totN = (actor.history || []).reduce((t, e) => t + (e.nuyen || 0), 0);
  return html`<div>
    <div class="sh-derived">
      <${RollStat} label="Karma disponible" value=${actor.karma} accent="amber" />
      <${RollStat} label="Karma de carrière" value=${actor.karmaTotal} />
      <${RollStat} label="Nuyens" value=${nuyen(actor.nuyen)} accent="cyan" />
      ${edit && html`<div class="field"><span class="field-label">Karma (direct)</span><${NumberInput} small value=${actor.karma} min=${-999} max=${99999} onChange=${(v) => s.update({ karma: v })} /></div>
        <div class="field"><span class="field-label">Carrière</span><${NumberInput} small value=${actor.karmaTotal} min=${0} max=${99999} onChange=${(v) => s.update({ karmaTotal: v })} /></div>
        <div class="field"><span class="field-label">Nuyens (direct)</span><${NumberInput} small value=${actor.nuyen} min=${0} max=${1e9} step=${100} onChange=${(v) => s.update({ nuyen: v })} /></div>`}
    </div>
    ${gm && html`<h4 class="section-title">Ajustement (consigné dans l’historique)</h4><${AdjustForm} actor=${actor} />`}
    <h4 class="section-title">Registre</h4>
    ${h.length
      ? html`<div class="sh-table-wrap"><table class="sr">
          <thead><tr><th>Date</th><th>Opération</th><th class="right">Karma</th><th class="right">Nuyens</th></tr></thead>
          <tbody>${h.map(
            (e, i) => html`<tr key=${i}>
              <td class="small muted">${fmtDate(e.ts)}</td><td>${e.text}</td>
              <td class=${'num-cell ' + ((e.karma || 0) > 0 ? 'green' : (e.karma || 0) < 0 ? 'red' : 'faint')}>${e.karma ? signed(e.karma) : '—'}</td>
              <td class=${'num-cell ' + ((e.nuyen || 0) > 0 ? 'green' : (e.nuyen || 0) < 0 ? 'red' : 'faint')}>${e.nuyen ? (e.nuyen > 0 ? '+' : '−') + nuyen(Math.abs(e.nuyen)) : '—'}</td>
            </tr>`
          )}</tbody>
          <tfoot><tr><td></td><td class="muted small">Total des mouvements</td><td class="num-cell">${signed(totK)}</td><td class="num-cell">${nuyen(totN)}</td></tr></tfoot>
        </table></div>`
      : html`<div class="muted small">Aucune opération.</div>`}
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
      <div class="field"><span class="field-label">Indice de professionnalisme</span><${NumberInput} small value=${npc.professionalRating || 0} min=${0} max=${7} onChange=${(v) => setN({ professionalRating: v })} /></div>
      <${Toggle} value=${!!npc.grunt} onChange=${(v) => setN({ grunt: v })} label="Sbire (moniteur de groupe)" />
      <${Toggle} value=${!!actor.hidden} onChange=${(v) => s.update({ hidden: v })} label="Caché aux joueurs" />
      <label class="field"><span class="field-label">Type</span><${Select} value=${actor.type} options=${[{ value: 'npc', label: 'PNJ' }, { value: 'pc', label: 'PJ' }]} onChange=${(v) => s.update({ type: v })} /></label>
      ${tpl ? html`<span class="badge badge-amber">Modèle : ${tpl.name}</span>` : actor.templateId ? html`<span class="badge">Modèle ${actor.templateId}</span>` : null}
    </div>
    <${MdField} title="Tactiques" accent="magenta" value=${npc.tactics} canEdit=${true} onSave=${(v) => setN({ tactics: v })} placeholder="Comportement en combat, réactions, moral…" />
    <${MdField} title="Butin" value=${npc.loot} canEdit=${true} onSave=${(v) => setN({ loot: v })} placeholder="Ce que les runners trouvent sur le corps…" />
  </div>`;
}

