// Wizard step: Magie / Résonance (type, tradition, free skills, spells, adept powers, complex forms).
import { html, Field, Select, TextInput, NumberInput, Badge, Panel, IconButton } from '../../lib/ui.js';
import { SKILLS } from '/shared/sr5.js';
import { t, tk, getLang, skillLabel, skillGroupLabel, itemName } from '../../lib/i18n.js';
import { powerInfo, SPELL_CATEGORIES } from '/shared/advancement.js';
import {
  MAGIC_TYPES, ASPECTS, TRADITIONS, COMPLEX_FORMS, magicOptions, magicOptionParts, aspectGroup, rowId,
} from '/shared/chargen.js';
import { Budget, StepIssues, i18n } from './common.js';
import Picker from './Picker.js';

/** Spell categories: French label from the catalog table, official English category (the key) in English. */
const spellCats = () => Object.entries(SPELL_CATEGORIES).map(([value, label]) => ({ value, label: getLang() === 'fr' ? label : value }));
/** Spell category of a catalog item (or a spellInfo() row) in the UI language. */
const spellCat = (item, fallback) => (getLang() === 'fr' ? fallback ?? (item?.categoryFr || item?.category || '') : item?.category || fallback || '');
const TYPE_TEXT = {
  none: tk('Pas de magie ni de résonance : tout le potentiel va dans le corps, les compétences et l’équipement (le cyberware ne coûte rien de plus).'),
  magician: tk('Lance des sorts, invoque des esprits, voit le plan astral. La tradition détermine le Drain et les esprits.'),
  mystic: tk('Magicien et adepte à la fois : achète ses points de pouvoir en karma (5 karma le point, maximum Magie).'),
  adept: tk('Canalise la magie dans son corps : points de pouvoir égaux à la Magie, pas de sorts.'),
  aspected: tk('Magicien limité à un seul groupe : Sorcellerie, Conjuration ou Enchantement.'),
  technomancer: tk('Résonance : la Matrice sans appareil, formes complexes et sprites.'),
};

export function StepMagic({ data, update, result, issues, rc }) {
  const letter = data.priorities.magic;
  const opts = letter ? magicOptions(letter) : [{ type: 'none' }];
  const m = data.magic;
  const r = result;
  const mrow = r.magic.row;
  const setType = (type) =>
    update((d) => {
      d.magic.type = type;
      d.magic.freeSkills = [];
      d.magic.freeGroup = type === 'aspected' ? aspectGroup(d.magic.aspect) : '';
      if (type !== 'magician' && type !== 'mystic' && type !== 'aspected') d.spells = [];
      if (type !== 'adept' && type !== 'mystic') d.powers = [];
      if (type !== 'technomancer') d.complexForms = [];
      if (type !== 'mystic') d.magic.ppKarma = 0;
      if (type === 'none' || type === 'technomancer') d.attributes.MAG = d.attrKarma.MAG = 0;
      if (type !== 'technomancer') d.attributes.RES = d.attrKarma.RES = 0;
    });

  return html`<div class="cg-step">
    ${!letter && html`<div class="cg-note warn">${t('Attribue d’abord une priorité à la colonne Magie / Résonance.')}</div>`}
    <div class="cg-magic-types">
      ${opts.map((o) => html`<div class=${'card clickable cg-mtype' + (m.type === o.type ? ' on' : '')} onClick=${() => setType(o.type)}>
        <h4>${t(MAGIC_TYPES[o.type].label)}</h4>
        <div class="small">${o.type === 'none' ? t('Aucune capacité surnaturelle') : magicOptionParts(o, i18n())}</div>
        <div class="small muted">${t(TYPE_TEXT[o.type])}</div>
      </div>`)}
    </div>
    ${m.type !== 'none' && !opts.some((o) => o.type === m.type) && html`<div class="cg-note err">${t('{type} n’est pas proposé avec la priorité {letter} : choisis une autre option.', { type: { t: MAGIC_TYPES[m.type].label }, letter: letter || '?' })}</div>`}

    ${m.type !== 'none' && html`<div class="grid-3 cg-mt">
      ${(m.type === 'magician' || m.type === 'mystic' || m.type === 'aspected') && html`<${Field} label=${t('Tradition')}>
        <${Select} value=${m.tradition} onChange=${(v) => update((d) => (d.magic.tradition = v))} options=${[{ value: '', label: t('— Choisir —') }, ...TRADITIONS.map((x) => ({ value: x, label: t(x) }))]} />
      </${Field}>`}
      ${m.type === 'aspected' && html`<${Field} label=${t('Aspect')}>
        <${Select} value=${m.aspect} onChange=${(v) => update((d) => { d.magic.aspect = v; d.magic.freeGroup = v; d.groups = d.groups.filter((g) => !ASPECTS[g.id] || g.id === v); })} options=${Object.entries(ASPECTS).map(([value, label]) => ({ value, label: t(label) }))} />
      </${Field}>`}
      ${m.type !== 'technomancer' && html`<${Field} label=${t('Mentor (facultatif)')}><${TextInput} live value=${m.mentor} placeholder=${t('ex. Chat, Dragon sage…')} onChange=${(v) => update((d) => (d.magic.mentor = v))} /></${Field}>`}
      ${m.type === 'mystic' && html`<${Field} label=${t('Points de pouvoir achetés')} hint=${t('5 karma par point, maximum Magie')}>
        <${NumberInput} value=${m.ppKarma} min=${0} max=${Math.max(0, r.magic.effMAG)} onChange=${(v) => update((d) => (d.magic.ppKarma = v))} />
      </${Field}>`}
    </div>`}

    ${mrow?.skills && html`<${FreeSkills} data=${data} update=${update} cfg=${mrow.skills} />`}
    ${mrow?.group && html`<div class="cg-note">${t('Groupe gratuit à l’indice {r} :', { r: mrow.group.rating })} <strong>${skillGroupLabel(aspectGroup(m.aspect))}</strong> ${t('(celui de ton aspect).')}</div>`}

    ${r.magic.canCast && html`<${Spells} data=${data} update=${update} result=${r} rc=${rc} />`}
    ${r.magic.hasPowers && html`<${Powers} data=${data} update=${update} result=${r} rc=${rc} />`}
    ${r.magic.emerged && html`<${Forms} data=${data} update=${update} result=${r} />`}
    <${StepIssues} issues=${issues} />
  </div>`;
}

function FreeSkills({ data, update, cfg }) {
  const allowed = SKILLS.filter((s) => (cfg.cat === 'active' ? s.cat !== 'magic' && s.cat !== 'resonance' : s.cat === cfg.cat));
  const slots = Array.from({ length: cfg.n }, (_, i) => data.magic.freeSkills[i] || '');
  const set = (i, v) =>
    update((d) => {
      const arr = Array.from({ length: cfg.n }, (_, j) => d.magic.freeSkills[j] || '');
      arr[i] = v;
      d.magic.freeSkills = arr.filter(Boolean);
    });
  return html`<${Panel} title=${cfg.n > 1 ? t('Compétences gratuites (indice {r})', { r: cfg.rating }) : t('Compétence gratuite (indice {r})', { r: cfg.rating })} class="cg-mt">
    <div class="row wrap">
      ${slots.map((v, i) => html`<${Select} class="cg-free-skill" value=${v} onChange=${(x) => set(i, x)}
        options=${[{ value: '', label: t('— Choisir —') }, ...allowed.map((s) => ({ value: s.id, label: slots.includes(s.id) && s.id !== v ? t('{skill} (déjà choisie)', { skill: skillLabel(s) }) : skillLabel(s) }))]} />`)}
    </div>
    <div class="small muted" style=${{ marginTop: '6px' }}>${t('Elles apparaissent dans l’étape Compétences à cet indice ; tu peux encore les augmenter avec des points.')}</div>
  </${Panel}>`;
}

function Spells({ data, update, result, rc }) {
  const r = result;
  const selected = new Set(data.spells.map((s) => s.catalogId));
  const max = r.magic.effMAG * 2;
  const free = r.budgets.freeSpells;
  return html`<${Panel} title=${t('Sorts')} class="cg-mt" actions=${html`<${Badge} color=${r.spent.spells > max ? 'red' : 'cyan'}>${t('{n} / {free} gratuits', { n: r.spent.spells, free })}${r.spent.spells > free ? ` · +${(r.spent.spells - free) * 5} K` : ''}</${Badge}>`}>
    <div class="small muted">${free ? t('{n} sorts gratuits, puis 5 karma par sort.', { n: free }) : t('5 karma par sort.')} ${t('Maximum Magie × 2 = {max}.', { max })}</div>
    ${data.spells.length > 0 && html`<div class="cg-chips">
      ${r.spells.map((s) => html`<span class="cg-chip">${s.item ? itemName(s.item) : s.name} <i>${spellCat(s.item, s.category)} · ${s.type} · ${s.range} · ${s.duration} · ${t('Drain {dv}', { dv: s.drain })}</i>
        <${IconButton} icon="✕" title=${t('Retirer')} onClick=${() => update((d) => (d.spells = d.spells.filter((x) => x.catalogId !== s.catalogId)))} /></span>`)}
    </div>`}
    <${Picker} items=${rc.spells} name=${itemName} placeholder=${t('Chercher un sort…')}
      meta=${(it) => `${spellCat(it)} · ${it.stats?.type || ''} · ${it.stats?.range || ''} · ${it.stats?.duration || ''} · ${t('Drain {dv}', { dv: it.stats?.dv || '?' })}`}
      categories=${spellCats()} category=${(it) => it.category} selected=${selected}
      disabled=${() => (data.spells.length >= max ? t('Maximum {max} sorts', { max }) : null)}
      onAdd=${(it) => update((d) => d.spells.push({ id: rowId('s'), catalogId: it.id, name: it.nameFr || it.name }))} />
  </${Panel}>`;
}

function Powers({ data, update, result, rc }) {
  const r = result;
  const selected = new Set(data.powers.map((p) => p.catalogId));
  return html`<${Panel} title=${t('Pouvoirs d’adepte')} class="cg-mt" actions=${html`<${Budget} label=${t('Points de pouvoir')} used=${r.spent.powerPoints} total=${r.budgets.powerPoints} />`}>
    ${r.powers.length > 0 && html`<table class="sr cg-mb"><tbody>
      ${r.powers.map((p) => {
        const info = powerInfo(p.item);
        const row = data.powers.find((x) => x.catalogId === p.catalogId);
        return html`<tr>
          <td><strong>${p.item ? itemName(p.item) : p.name}</strong>${info.extraPP ? html` <span class="faint small">${t('(+{pp} PP au 1er niveau)', { pp: info.extraPP })}</span>` : ''}</td>
          <td>${info.levels ? html`<span class="row gap-s"><span class="small muted">${t('Niveau')}</span><${NumberInput} small value=${row?.level || 1} min=${1} max=${Math.min(info.maxLevel || 12, Math.max(1, r.magic.effMAG))} onChange=${(v) => update((d) => { const x = d.powers.find((y) => y.catalogId === p.catalogId); if (x) x.level = v; })} /></span>` : ''}</td>
          <td><${TextInput} live value=${row?.choice || ''} placeholder=${t('Précision (compétence, attribut…)')} onChange=${(v) => update((d) => { const x = d.powers.find((y) => y.catalogId === p.catalogId); if (x) x.choice = v; })} /></td>
          <td class="num-cell">${p.pp} PP</td>
          <td><${IconButton} icon="✕" title=${t('Retirer')} onClick=${() => update((d) => (d.powers = d.powers.filter((x) => x.catalogId !== p.catalogId)))} /></td>
        </tr>`;
      })}
    </tbody></table>`}
    <${Picker} items=${rc.powers} name=${itemName} placeholder=${t('Chercher un pouvoir…')}
      meta=${(it) => { const i = powerInfo(it); return `${i.levels ? t('{pp} PP par niveau', { pp: i.pp }) : t('{pp} PP', { pp: i.pp })}${i.maxLevel ? ` ${t('(max {n})', { n: i.maxLevel })}` : ''}`; }}
      selected=${selected}
      onAdd=${(it) => update((d) => d.powers.push({ id: rowId('p'), catalogId: it.id, name: it.nameFr || it.name, level: 1 }))} />
  </${Panel}>`;
}

function Forms({ data, update, result }) {
  const r = result;
  const chosen = new Set(data.complexForms.map((f) => f.formId));
  const toggle = (id) =>
    update((d) => {
      if (chosen.has(id)) d.complexForms = d.complexForms.filter((f) => f.formId !== id);
      else d.complexForms.push({ id: rowId('f'), formId: id });
    });
  return html`<${Panel} title=${t('Formes complexes')} class="cg-mt" actions=${html`<${Badge} color="cyan">${t('{n} / {free} gratuites', { n: r.spent.forms, free: r.budgets.freeForms })}${r.spent.forms > r.budgets.freeForms ? ` · +${(r.spent.forms - r.budgets.freeForms) * 4} K` : ''}</${Badge}>`}>
    <div class="small muted cg-mb">${t('{n} gratuites, puis 4 karma chacune. Maximum Logique ({max}).', { n: r.budgets.freeForms, max: r.final.LOG })}</div>
    <div class="cg-forms">
      ${COMPLEX_FORMS.map((f) => html`<label class=${'cg-form' + (chosen.has(f.id) ? ' on' : '')}>
        <input type="checkbox" checked=${chosen.has(f.id)} onChange=${() => toggle(f.id)} />
        <span class="grow"><strong>${getLang() === 'fr' ? f.name : f.en}</strong><span class="small muted"> · ${t(f.target)} · ${t('durée {d}', { d: f.duration })} · ${t('estompage {f}', { f: f.fading })}</span></span>
      </label>`)}
    </div>
  </${Panel}>`;
}

