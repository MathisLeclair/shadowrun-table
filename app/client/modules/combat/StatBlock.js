// SR5-style stat block for a bestiary template (or any actor-shaped object).
import { html, Badge, Stat, Markdown } from '../../lib/ui.js';
import { t, attrShort, skillLabel, metatypeLabel, fmtNumber, getLang } from '../../lib/i18n.js';
import { attr, SKILL_BY_ID } from '/shared/sr5.js';
import { ItemRef, SkillRef } from '../books/BookRef.js';
import { safeDerive, poolFor, damageText, initials, avatarStyle, signed, npcKindLabel, dispoLabel, DISPO_BADGE, initModeLabel } from './combat-common.js';

const CORE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];

/** Skill name: French keeps the name stored on the template; English uses the official name of known SR5 skills. */
function skillName(tpl, id, stored) {
  if (getLang() !== 'fr' && SKILL_BY_ID[id]) return skillLabel(id);
  return stored || SKILL_BY_ID[id]?.fr || (tpl.skills || []).find((s) => s.id === id)?.name || id || '';
}

function AttrTable({ tpl }) {
  const keys = [...CORE_ATTRS];
  if (tpl.attributes?.MAG) keys.push('MAG');
  if (tpl.attributes?.RES) keys.push('RES');
  keys.push('ESS');
  return html`<div class="sb-attrs-wrap"><table class="sb-attrs">
    <thead><tr>${keys.map((k) => html`<th>${attrShort(k)}</th>`)}</tr></thead>
    <tbody><tr>${keys.map((k) => {
      const base = Number(tpl.attributes?.[k] ?? 0);
      if (k === 'ESS') return html`<td>${fmtNumber(base)}</td>`;
      const eff = attr(tpl, k);
      return html`<td>${base}${eff !== base ? html` <small>(${eff})</small>` : ''}</td>`;
    })}</tr></tbody>
  </table></div>`;
}

function MatrixLine({ m }) {
  if (!m) return null;
  return html`<div class="sb-sec">
    <h4>${t('Matrice')}</h4>
    <div class="sb-chips">
      ${m.device && html`<span class="sb-chip">${m.device}${m.rating ? html` <i>${t('indice {n}', { n: m.rating })}</i>` : ''}</span>`}
      <span class="sb-chip">${t('Attaque')}<b>${m.attack || 0}</b></span>
      <span class="sb-chip">${t('Corruption')}<b>${m.sleaze || 0}</b></span>
      <span class="sb-chip">${t('Traitement')}<b>${m.dataProcessing || 0}</b></span>
      <span class="sb-chip">${t('Firewall')}<b>${m.firewall || 0}</b></span>
    </div>
    ${m.programs?.length > 0 && html`<div class="small muted">${t('Programmes : {list}', { list: m.programs.join(', ') })}</div>`}
  </div>`;
}

function Chips({ title, items, render }) {
  if (!items || !items.length) return null;
  return html`<div class="sb-sec"><h4>${title}</h4><div class="sb-chips">${items.map(render)}</div></div>`;
}

function WeaponsTable({ tpl, d }) {
  const ws = tpl.weapons || [];
  if (!ws.length) return null;
  return html`<div class="sb-sec">
    <h4>${t('Armes')}</h4>
    <div class="sb-table-wrap"><table class="sr">
      <thead><tr><th>${t('Arme')}</th><th title=${t('Réserve de dés (compétence + attribut)')}>${t('Réserve')}</th><th>${t('Préc.')}</th><th>${t('VD')}</th><th>${t('PA')}</th><th>${t('Mode')}</th><th>${t('RC')}</th><th>${t('Mun.')}</th></tr></thead>
      <tbody>${ws.map((w) => {
        const pool = poolFor(tpl, w.skill);
        const skName = w.skill ? skillName(tpl, w.skill, '') : '';
        const acc = w.accuracy === null || w.accuracy === undefined || w.accuracy === '' ? (d ? `${d.limits.physical}*` : '—') : w.accuracy;
        return html`<tr>
          <td class="wname"><strong>${w.name}</strong> <${ItemRef} item=${w} />${w.reach ? html` <span class="faint small">${t('allonge {n}', { n: w.reach })}</span>` : ''}
            ${(skName || w.notes) && html`<span class="note">${skName}${skName && w.notes ? ' — ' : ''}${w.notes || ''}</span>`}</td>
          <td class="pool">${pool ?? '—'}</td>
          <td class="mono" title=${typeof acc === 'string' && acc.endsWith('*') ? t('Limite physique') : ''}>${acc}</td>
          <td class="mono">${damageText(w, tpl) || '—'}</td>
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
    <h4>${t('Sorts')}</h4>
    <div class="sb-table-wrap"><table class="sr">
      <thead><tr><th>${t('Sort')}</th><th>${t('Catégorie')}</th><th>${t('Type')}</th><th>${t('Portée')}</th><th>${t('Durée')}</th><th>${t('Drain')}</th></tr></thead>
      <tbody>${spells.map((s) => html`<tr>
        <td class="wname"><strong>${s.name}</strong> <${ItemRef} item=${s} />${s.notes && html`<span class="note">${s.notes}</span>`}</td>
        <td>${s.category || ''}</td><td class="mono">${s.type || ''}</td><td class="mono">${s.range || ''}</td><td class="mono">${s.duration || ''}</td><td class="mono">${s.drain || ''}</td>
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}

/** Full stat block. props: { t: template (prop name kept for callers), compact? } */
export default function StatBlock({ t: tpl }) {
  const d = safeDerive(tpl);
  const kind = tpl.npc?.kind || 'metahuman';
  const nonPhysical = kind === 'host';
  const mode = tpl.npc?.initMode || 'physical';
  const initText = !d
    ? '—'
    : mode === 'hot'
      ? `${d.matrixInitiative.hot.base} + ${d.matrixInitiative.hot.dice}D6`
      : mode === 'cold'
        ? `${d.matrixInitiative.cold.base} + ${d.matrixInitiative.cold.dice}D6`
        : mode === 'astral'
          ? `${d.astralInitiative.base} + ${d.astralInitiative.dice}D6`
          : d.initiative.text;
  const armorItems = (tpl.armor || []).filter((a) => a.equipped !== false);
  const pr = tpl.npc?.professionalRating;

  return html`<article class="sb">
    <header class="sb-head" style=${{ '--tc': tpl.color || 'var(--magenta)' }}>
      <div class="sb-portrait" style=${avatarStyle(tpl.portrait, tpl.color)}>${tpl.portrait ? '' : initials(tpl.name)}</div>
      <div class="grow">
        <h3>${tpl.name}</h3>
        <div class="sub">${[tpl.metatype && metatypeLabel(tpl.metatype), tpl.concept].filter(Boolean).join(' · ')}</div>
        <div class="row wrap gap-s" style=${{ marginTop: '5px' }}>
          ${pr > 0 && html`<${Badge} color="amber" title=${t('Indice de professionnalisme')}>${t('PR {n}', { n: pr })}</${Badge}>`}
          ${tpl.npc?.grunt && html`<${Badge} color="magenta" title=${t('Sbire : à jouer en groupe')}>${t('Sbire')}</${Badge}>`}
          ${kind !== 'metahuman' && html`<${Badge} color="cyan">${npcKindLabel(kind)}</${Badge}>`}
          ${tpl.disposition && tpl.disposition !== 'hostile' && html`<${Badge} color=${DISPO_BADGE[tpl.disposition]}>${dispoLabel(tpl.disposition)}</${Badge}>`}
          ${tpl.vision?.lowLight && html`<${Badge}>${t('Vision nocturne')}</${Badge}>`}
          ${tpl.vision?.thermo && html`<${Badge}>${t('Thermographique')}</${Badge}>`}
          ${tpl.vision?.darkRange > 0 && html`<${Badge}>${t('Vision dans le noir {n} c.', { n: tpl.vision.darkRange })}</${Badge}>`}
        </div>
      </div>
    </header>
    <div class="sb-body">
      ${!nonPhysical && kind !== 'ic' && html`<${AttrTable} tpl=${tpl} />`}
      ${d && !nonPhysical && html`<div class="sb-stats">
        <${Stat} label=${mode === 'physical' ? t('Initiative') : t('Init. {mode}', { mode: initModeLabel(mode) })} value=${initText} accent="cyan" />
        <${Stat} label=${kind === 'ic' || kind === 'drone' ? t('Moniteur') : t('Physique')} value=${d.physicalMonitor} accent="magenta" />
        ${d.stunMonitor > 0 && html`<${Stat} label=${t('Étourdis.')} value=${d.stunMonitor} accent="amber" />`}
        ${kind !== 'ic' && html`<${Stat} label=${t('Armure')} value=${d.armor} />
          <${Stat} label=${t('Défense')} value=${d.defense} title=${t('Réaction + Intuition')} />
          <${Stat} label=${t('Encaiss.')} value=${d.soak} title=${t('Constitution + Armure')} />
          <${Stat} label=${t('Limites')} value=${`${d.limits.physical}/${d.limits.mental}/${d.limits.social}`} title=${t('Physique / Mentale / Sociale')} />`}
        ${mode !== 'physical' && kind === 'metahuman' && html`<${Stat} label=${t('Init. physique')} value=${d.initiative.text} />`}
      </div>`}

      <${Chips} title=${t('Compétences')} items=${tpl.skills} render=${(s) => {
        const pool = poolFor(tpl, s.id);
        return html`<span class="sb-chip" title=${s.spec ? t('Spécialisation : {spec} (+2)', { spec: s.spec }) : ''}>${skillName(tpl, s.id, s.name)} ${s.rating}${s.spec ? html` <i>(${s.spec})</i>` : ''}<b>${pool ?? '—'}</b><${SkillRef} id=${s.id} /></span>`;
      }} />
      <${WeaponsTable} tpl=${tpl} d=${d} />
      <${Chips} title=${t('Armure')} items=${armorItems} render=${(a) => html`<span class="sb-chip" title=${a.notes || ''}>${a.name}<b>${a.stack ? '+' : ''}${a.rating}</b><${ItemRef} item=${a} /></span>`} />
      <${Chips} title=${t('Augmentations')} items=${tpl.augmentations} render=${(x) => html`<span class="sb-chip" title=${x.notes || ''}>${x.name}${x.grade && x.grade !== 'standard' ? html` <i>${x.grade}</i>` : ''} <i>${t('ess. {n}', { n: fmtNumber(x.essence ?? 0) })}</i><${ItemRef} item=${x} /></span>`} />
      <${Chips} title=${t('Pouvoirs')} items=${tpl.powers} render=${(p) => html`<span class="sb-chip" title=${p.notes || ''}>${p.name}${p.level ? ` ${p.level}` : ''}${p.notes ? html` <i>— ${p.notes}</i>` : ''}<${ItemRef} item=${p} /></span>`} />
      <${SpellsTable} spells=${tpl.spells} />
      <${Chips} title=${t('Qualités')} items=${tpl.qualities} render=${(q) => html`<span class="sb-chip" title=${q.notes || ''} style=${{ borderColor: q.positive === false ? '#6a2c2c' : '' }}>${q.name}${q.notes ? html` <i>— ${q.notes}</i>` : ''}<${ItemRef} item=${q} /></span>`} />
      <${MatrixLine} m=${tpl.matrix} />
      <${Chips} title=${t('Connaissances')} items=${tpl.knowledge} render=${(k) => html`<span class="sb-chip">${k.name}${k.native ? html` <i>${t('langue maternelle')}</i>` : html`<b>${k.rating}</b>`}</span>`} />
      <${Chips} title=${t('Équipement')} items=${tpl.gear} render=${(g) => html`<span class="sb-chip" title=${g.notes || ''}>${g.name}${g.qty > 1 ? html` <i>×${g.qty}</i>` : ''}<${ItemRef} item=${g} /></span>`} />
      <${Chips} title=${t('Véhicules & drones')} items=${tpl.vehicles} render=${(v) => html`<span class="sb-chip" title=${v.notes || ''}>${v.name} <i>${t('Mani {handling} · Vit {speed} · Str {body} · Bli {armor} · Pil {pilot}', { handling: v.handling ?? '—', speed: v.speed ?? '—', body: v.body ?? '—', armor: v.armor ?? '—', pilot: v.pilot ?? '—' })}</i><${ItemRef} item=${v} /></span>`} />

      ${tpl.description && html`<div class="sb-sec"><h4>${t('Description')}</h4><div class="sb-text"><${Markdown} text=${tpl.description} /></div></div>`}
      ${tpl.npc?.tactics && html`<div class="sb-sec"><h4>${t('Tactique')}</h4><div class="sb-text tactics"><${Markdown} text=${tpl.npc.tactics} /></div></div>`}
      ${tpl.npc?.loot && html`<div class="sb-sec"><h4>${t('Butin')}</h4><div class="sb-text loot"><${Markdown} text=${tpl.npc.loot} /></div></div>`}
    </div>
  </article>`;
}
