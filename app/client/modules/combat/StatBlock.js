// SR5-style stat block for a bestiary template (or any actor-shaped object).
import { html, Badge, Stat, Markdown } from '../../lib/ui.js';
import { attr, ATTR_SHORT, SKILL_BY_ID } from '/shared/sr5.js';
import { safeDerive, poolFor, damageText, initials, avatarStyle, signed, NPC_KIND_LABEL, DISPO_LABELS, DISPO_BADGE, INIT_MODE_LABEL } from './combat-common.js';

const CORE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];

function AttrTable({ t }) {
  const keys = [...CORE_ATTRS];
  if (t.attributes?.MAG) keys.push('MAG');
  if (t.attributes?.RES) keys.push('RES');
  keys.push('ESS');
  return html`<div class="sb-attrs-wrap"><table class="sb-attrs">
    <thead><tr>${keys.map((k) => html`<th>${ATTR_SHORT[k]}</th>`)}</tr></thead>
    <tbody><tr>${keys.map((k) => {
      const base = Number(t.attributes?.[k] ?? 0);
      if (k === 'ESS') return html`<td>${String(base).replace('.', ',')}</td>`;
      const eff = attr(t, k);
      return html`<td>${base}${eff !== base ? html` <small>(${eff})</small>` : ''}</td>`;
    })}</tr></tbody>
  </table></div>`;
}

function MatrixLine({ m }) {
  if (!m) return null;
  return html`<div class="sb-sec">
    <h4>Matrice</h4>
    <div class="sb-chips">
      ${m.device && html`<span class="sb-chip">${m.device}${m.rating ? html` <i>indice ${m.rating}</i>` : ''}</span>`}
      <span class="sb-chip">Attaque<b>${m.attack || 0}</b></span>
      <span class="sb-chip">Corruption<b>${m.sleaze || 0}</b></span>
      <span class="sb-chip">Traitement<b>${m.dataProcessing || 0}</b></span>
      <span class="sb-chip">Firewall<b>${m.firewall || 0}</b></span>
    </div>
    ${m.programs?.length > 0 && html`<div class="small muted">Programmes : ${m.programs.join(', ')}</div>`}
  </div>`;
}

function Chips({ title, items, render }) {
  if (!items || !items.length) return null;
  return html`<div class="sb-sec"><h4>${title}</h4><div class="sb-chips">${items.map(render)}</div></div>`;
}

function WeaponsTable({ t, d }) {
  const ws = t.weapons || [];
  if (!ws.length) return null;
  return html`<div class="sb-sec">
    <h4>Armes</h4>
    <div class="sb-table-wrap"><table class="sr">
      <thead><tr><th>Arme</th><th title="Réserve de dés (compétence + attribut)">Réserve</th><th>Préc.</th><th>VD</th><th>PA</th><th>Mode</th><th>RC</th><th>Mun.</th></tr></thead>
      <tbody>${ws.map((w) => {
        const pool = poolFor(t, w.skill);
        const skillName = SKILL_BY_ID[w.skill]?.fr || (t.skills || []).find((s) => s.id === w.skill)?.name || w.skill || '';
        const acc = w.accuracy === null || w.accuracy === undefined || w.accuracy === '' ? (d ? `${d.limits.physical}*` : '—') : w.accuracy;
        return html`<tr>
          <td class="wname"><strong>${w.name}</strong>${w.reach ? html` <span class="faint small">allonge ${w.reach}</span>` : ''}
            ${(skillName || w.notes) && html`<span class="note">${skillName}${skillName && w.notes ? ' — ' : ''}${w.notes || ''}</span>`}</td>
          <td class="pool">${pool ?? '—'}</td>
          <td class="mono" title=${typeof acc === 'string' && acc.endsWith('*') ? 'Limite physique' : ''}>${acc}</td>
          <td class="mono">${damageText(w, t) || '—'}</td>
          <td class="mono">${w.ap ? signed(w.ap) : '—'}</td>
          <td class="mono">${w.mode || '—'}</td>
          <td class="mono">${w.rc || '—'}</td>
          <td class="mono">${w.ammo || '—'}</td>
        </tr>`;
      })}</tbody>
    </table></div>
  </div>`;
}

function SpellsTable({ spells }) {
  if (!spells?.length) return null;
  return html`<div class="sb-sec">
    <h4>Sorts</h4>
    <div class="sb-table-wrap"><table class="sr">
      <thead><tr><th>Sort</th><th>Catégorie</th><th>Type</th><th>Portée</th><th>Durée</th><th>Drain</th></tr></thead>
      <tbody>${spells.map((s) => html`<tr>
        <td class="wname"><strong>${s.name}</strong>${s.notes && html`<span class="note">${s.notes}</span>`}</td>
        <td>${s.category || ''}</td><td class="mono">${s.type || ''}</td><td class="mono">${s.range || ''}</td><td class="mono">${s.duration || ''}</td><td class="mono">${s.drain || ''}</td>
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}

/** Full stat block. props: { t: template, compact? } */
export default function StatBlock({ t }) {
  const d = safeDerive(t);
  const kind = t.npc?.kind || 'metahuman';
  const nonPhysical = kind === 'host';
  const mode = t.npc?.initMode || 'physical';
  const initText = !d
    ? '—'
    : mode === 'hot'
      ? `${d.matrixInitiative.hot.base} + ${d.matrixInitiative.hot.dice}D6`
      : mode === 'cold'
        ? `${d.matrixInitiative.cold.base} + ${d.matrixInitiative.cold.dice}D6`
        : mode === 'astral'
          ? `${d.astralInitiative.base} + ${d.astralInitiative.dice}D6`
          : d.initiative.text;
  const armorItems = (t.armor || []).filter((a) => a.equipped !== false);
  const pr = t.npc?.professionalRating;

  return html`<article class="sb">
    <header class="sb-head" style=${{ '--tc': t.color || 'var(--magenta)' }}>
      <div class="sb-portrait" style=${avatarStyle(t.portrait, t.color)}>${t.portrait ? '' : initials(t.name)}</div>
      <div class="grow">
        <h3>${t.name}</h3>
        <div class="sub">${[t.metatype, t.concept].filter(Boolean).join(' · ')}</div>
        <div class="row wrap gap-s" style=${{ marginTop: '5px' }}>
          ${pr > 0 && html`<${Badge} color="amber" title="Indice de professionnalisme">PR ${pr}</${Badge}>`}
          ${t.npc?.grunt && html`<${Badge} color="magenta" title="Sbire : à jouer en groupe">Sbire</${Badge}>`}
          ${kind !== 'metahuman' && html`<${Badge} color="cyan">${NPC_KIND_LABEL[kind] || kind}</${Badge}>`}
          ${t.disposition && t.disposition !== 'hostile' && html`<${Badge} color=${DISPO_BADGE[t.disposition]}>${DISPO_LABELS[t.disposition]}</${Badge}>`}
          ${t.vision?.lowLight && html`<${Badge}>Vision nocturne</${Badge}>`}
          ${t.vision?.thermo && html`<${Badge}>Thermographique</${Badge}>`}
          ${t.vision?.darkRange > 0 && html`<${Badge}>Vision dans le noir ${t.vision.darkRange} c.</${Badge}>`}
        </div>
      </div>
    </header>
    <div class="sb-body">
      ${!nonPhysical && kind !== 'ic' && html`<${AttrTable} t=${t} />`}
      ${d && !nonPhysical && html`<div class="sb-stats">
        <${Stat} label=${mode === 'physical' ? 'Initiative' : `Init. ${INIT_MODE_LABEL[mode]}`} value=${initText} accent="cyan" />
        <${Stat} label=${kind === 'ic' || kind === 'drone' ? 'Moniteur' : 'Physique'} value=${d.physicalMonitor} accent="magenta" />
        ${d.stunMonitor > 0 && html`<${Stat} label="Étourdis." value=${d.stunMonitor} accent="amber" />`}
        ${kind !== 'ic' && html`<${Stat} label="Armure" value=${d.armor} />
          <${Stat} label="Défense" value=${d.defense} title="Réaction + Intuition" />
          <${Stat} label="Encaiss." value=${d.soak} title="Constitution + Armure" />
          <${Stat} label="Limites" value=${`${d.limits.physical}/${d.limits.mental}/${d.limits.social}`} title="Physique / Mentale / Sociale" />`}
        ${mode !== 'physical' && kind === 'metahuman' && html`<${Stat} label="Init. physique" value=${d.initiative.text} />`}
      </div>`}

      <${Chips} title="Compétences" items=${t.skills} render=${(s) => {
        const pool = poolFor(t, s.id);
        return html`<span class="sb-chip" title=${s.spec ? `Spécialisation : ${s.spec} (+2)` : ''}>${s.name || SKILL_BY_ID[s.id]?.fr || s.id} ${s.rating}${s.spec ? html` <i>(${s.spec})</i>` : ''}<b>${pool ?? '—'}</b></span>`;
      }} />
      <${WeaponsTable} t=${t} d=${d} />
      <${Chips} title="Armure" items=${armorItems} render=${(a) => html`<span class="sb-chip" title=${a.notes || ''}>${a.name}<b>${a.stack ? '+' : ''}${a.rating}</b></span>`} />
      <${Chips} title="Augmentations" items=${t.augmentations} render=${(x) => html`<span class="sb-chip" title=${x.notes || ''}>${x.name}${x.grade && x.grade !== 'standard' ? html` <i>${x.grade}</i>` : ''} <i>ess. ${String(x.essence ?? 0).replace('.', ',')}</i></span>`} />
      <${Chips} title="Pouvoirs" items=${t.powers} render=${(p) => html`<span class="sb-chip" title=${p.notes || ''}>${p.name}${p.level ? ` ${p.level}` : ''}${p.notes ? html` <i>— ${p.notes}</i>` : ''}</span>`} />
      <${SpellsTable} spells=${t.spells} />
      <${Chips} title="Qualités" items=${t.qualities} render=${(q) => html`<span class="sb-chip" title=${q.notes || ''} style=${{ borderColor: q.positive === false ? '#6a2c2c' : '' }}>${q.name}${q.notes ? html` <i>— ${q.notes}</i>` : ''}</span>`} />
      <${MatrixLine} m=${t.matrix} />
      <${Chips} title="Connaissances" items=${t.knowledge} render=${(k) => html`<span class="sb-chip">${k.name}${k.native ? html` <i>langue maternelle</i>` : html`<b>${k.rating}</b>`}</span>`} />
      <${Chips} title="Équipement" items=${t.gear} render=${(g) => html`<span class="sb-chip" title=${g.notes || ''}>${g.name}${g.qty > 1 ? html` <i>×${g.qty}</i>` : ''}</span>`} />
      <${Chips} title="Véhicules & drones" items=${t.vehicles} render=${(v) => html`<span class="sb-chip" title=${v.notes || ''}>${v.name} <i>Mani ${v.handling ?? '—'} · Vit ${v.speed ?? '—'} · Str ${v.body ?? '—'} · Bli ${v.armor ?? '—'} · Pil ${v.pilot ?? '—'}</i></span>`} />

      ${t.description && html`<div class="sb-sec"><h4>Description</h4><div class="sb-text"><${Markdown} text=${t.description} /></div></div>`}
      ${t.npc?.tactics && html`<div class="sb-sec"><h4>Tactique</h4><div class="sb-text tactics"><${Markdown} text=${t.npc.tactics} /></div></div>`}
      ${t.npc?.loot && html`<div class="sb-sec"><h4>Butin</h4><div class="sb-text loot"><${Markdown} text=${t.npc.loot} /></div></div>`}
    </div>
  </article>`;
}
