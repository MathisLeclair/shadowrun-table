// Sheet tab « Résumé »: attributes, derived values, condition monitors, Edge.
import { useState } from 'preact/hooks';
import { html, Button, NumberInput, Toggle, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { attr } from '/shared/sr5.js';
import { t, tk, attrLabel, attrShort } from '../../lib/i18n.js';
import { ConditionTrack, EdgePips, actorStatus, statusColor, statusLabel, fmtNum, tRich } from './common.js';

const BASE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];

/** Clickable stat box that opens a roll. */
export function RollStat({ label, value, onClick, title, accent, sub }) {
  const cls = 'stat sh-stat' + (accent ? ` stat-${accent}` : '') + (onClick ? ' sh-clickable' : '');
  const inner = html`<span class="stat-value">${value}</span><span class="stat-label">${label}</span>${sub ? html`<span class="sh-stat-sub">${sub}</span>` : null}`;
  return onClick
    ? html`<button type="button" class=${cls} title=${title || t('Lancer : {label}', { label })} onClick=${onClick}>${inner}</button>`
    : html`<div class=${cls} title=${title}>${inner}</div>`;
}

function AttrCell({ s, k }) {
  const { actor, edit } = s;
  const base = Number(actor.attributes[k] ?? 0);
  const eff = attr(actor, k);
  const aug = eff - base;
  if (edit) {
    return html`<div class="sh-attr editing">
      <span class="sh-attr-key" title=${attrLabel(k)}>${attrShort(k)}</span>
      <${NumberInput} small value=${base} min=${0} max=${15} onChange=${(v) => s.update({ attributes: { [k]: v } })} />
      ${k !== 'EDG' && k !== 'MAG' && k !== 'RES'
        ? html`<label class="sh-attr-aug" title=${t('Bonus d’augmentation (max +4)')}>${t('aug.')}
            <${NumberInput} small value=${Number(actor.augmented?.[k] ?? 0)} min=${0} max=${4} onChange=${(v) => s.update({ augmented: { [k]: v } })} /></label>`
        : null}
    </div>`;
  }
  return html`<button type="button" class=${'sh-attr' + (aug ? ' augmented' : '')} title=${t('{attr} — lancer un test d’attribut', { attr: attrLabel(k) })} onClick=${() => s.roll({ attr: k })}>
    <span class="sh-attr-key">${attrShort(k)}</span>
    <span class="sh-attr-val">${eff}</span>
    <span class="sh-attr-base">${aug ? t('base {base} +{aug}', { base, aug }) : attrLabel(k)}</span>
  </button>`;
}

function QuickDamage({ s }) {
  const [amount, setAmount] = useState(1);
  const id = s.actor.id;
  const dmg = (type) => send('actor/damage', { actorId: id, amount, type }).catch(() => {});
  return html`<div class="sh-quickdmg row wrap">
    <${NumberInput} small value=${amount} min=${1} max=${30} onChange=${setAmount} />
    <${Button} small variant="danger" onClick=${() => dmg('P')} title=${t('Ajoute des dommages physiques')}>${t('Physiques')}</${Button}>
    <${Button} small onClick=${() => dmg('S')} title=${t('Ajoute des dommages étourdissants (le surplus passe en physique)')}>${t('Étourdissants')}</${Button}>
    <${Button} small variant="ghost" onClick=${() => send('actor/heal', { actorId: id, amount, type: 'S' }).catch(() => {})} title=${t('Soigne des cases étourdissantes')}>${t('Soigner É')}</${Button}>
    <${Button} small variant="ghost" onClick=${() => send('actor/heal', { actorId: id, amount, type: 'P' }).catch(() => {})} title=${t('Soigne des cases physiques (surplus d’abord)')}>${t('Soigner P')}</${Button}>
  </div>`;
}

export function SummaryTab({ s }) {
  const { actor, d, edit, own } = s;
  const attrs = [...BASE_ATTRS];
  if (actor.attributes.MAG !== undefined && actor.attributes.MAG !== null) attrs.push('MAG');
  if (actor.attributes.RES !== undefined && actor.attributes.RES !== null) attrs.push('RES');
  const c = actor.condition || {};
  const status = actorStatus(actor);
  const setCond = (k) => (v) => s.update({ condition: { [k]: v } });
  const vision = actor.vision || {};
  return html`<div class="sh-summary">
    <section>
      <div class="sh-sec-head"><h4 class="section-title">${t('Attributs')}</h4>
        ${edit && html`<div class="row wrap">
          ${!attrs.includes('MAG') && html`<${Button} small onClick=${() => s.update({ attributes: { MAG: 1 } })}>${t('+ Magie')}</${Button}>`}
          ${attrs.includes('MAG') && html`<${Button} small variant="ghost" onClick=${() => s.update({ attributes: { MAG: null } })}>${t('− Magie')}</${Button}>`}
          ${!attrs.includes('RES') && html`<${Button} small onClick=${() => s.update({ attributes: { RES: 1 } })}>${t('+ Résonance')}</${Button}>`}
          ${attrs.includes('RES') && html`<${Button} small variant="ghost" onClick=${() => s.update({ attributes: { RES: null } })}>${t('− Résonance')}</${Button}>`}
        </div>`}
      </div>
      <div class="sh-attrs">
        ${attrs.map((k) => html`<${AttrCell} s=${s} k=${k} key=${k} />`)}
        <div class=${'sh-attr sh-ess' + (edit ? ' editing' : '')} title=${t('Essence')}>
          <span class="sh-attr-key">${attrShort('ESS')}</span>
          ${edit
            ? html`<${NumberInput} small value=${actor.attributes.ESS} min=${0} max=${6} step=${0.05} onChange=${(v) => s.update({ attributes: { ESS: v } })} />`
            : html`<span class="sh-attr-val">${fmtNum(Math.round(d.essence * 100) / 100)}</span><span class="sh-attr-base">${t('Essence')}</span>`}
        </div>
      </div>
    </section>

    <section>
      <h4 class="section-title">${t('Valeurs dérivées')}</h4>
      <div class="sh-derived">
        <${RollStat} label=${t('Initiative')} value=${d.initiative.text} accent="cyan" title=${d.woundModifier ? t('Blessures {n} au score', { n: d.woundModifier }) : `${attrLabel('REA')} + ${attrLabel('INT')}`} />
        ${attrs.includes('MAG') && html`<${RollStat} label=${t('Init. astrale')} value=${`${d.astralInitiative.base} + 2D6`} />`}
        ${actor.matrix && html`<${RollStat} label=${t('Init. RV chaude')} value=${`${d.matrixInitiative.hot.base} + 4D6`} title=${t('RA : {ar} · RV froide : {cold} + 3D6', { ar: d.initiative.text, cold: d.matrixInitiative.cold.base })} />`}
        <${RollStat} label=${t('Limite physique')} value=${d.limits.physical} />
        <${RollStat} label=${t('Limite mentale')} value=${d.limits.mental} />
        <${RollStat} label=${t('Limite sociale')} value=${d.limits.social} />
        ${d.limits.astral ? html`<${RollStat} label=${t('Limite astrale')} value=${d.limits.astral} />` : null}
        <${RollStat} label=${t('Défense')} value=${d.defense} sub=${`${attrShort('REA')} + ${attrShort('INT')}`} onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Défense') })} />
        <${RollStat} label=${t('Encaissement')} value=${d.soak} sub=${t('{attr} + armure', { attr: attrShort('BOD') })} onClick=${() => s.roll({ attr: 'BOD', label: tk('Encaissement'), applyWounds: false, limit: null, bonus: [{ label: tk('armure'), value: d.armor }] })} />
        <${RollStat} label=${t('Armure')} value=${d.armor} />
        <${RollStat} label=${t('Sang-froid')} value=${d.composure} sub=${`${attrShort('CHA')} + ${attrShort('WIL')}`} onClick=${() => s.roll({ attr: 'CHA', attr2: 'WIL', label: tk('Sang-froid') })} />
        <${RollStat} label=${t('Jauger intentions')} value=${d.judgeIntentions} sub=${`${attrShort('CHA')} + ${attrShort('INT')}`} onClick=${() => s.roll({ attr: 'CHA', attr2: 'INT', label: tk('Jauger les intentions') })} />
        <${RollStat} label=${t('Mémoire')} value=${d.memory} sub=${`${attrShort('LOG')} + ${attrShort('WIL')}`} onClick=${() => s.roll({ attr: 'LOG', attr2: 'WIL', label: tk('Mémoire') })} />
        <${RollStat} label=${t('Soulever / porter')} value=${d.liftCarry} sub=${`${attrShort('BOD')} + ${attrShort('STR')}`} onClick=${() => s.roll({ attr: 'BOD', attr2: 'STR', label: tk('Soulever / porter') })} />
        <${RollStat} label=${t('Déplacement')} value=${`${d.movement.walk}/${d.movement.run} m`} title=${t('Marche / course par tour')} />
      </div>
      ${(vision.lowLight || vision.thermo || vision.darkRange) && html`<div class="row wrap sh-vision">
        ${vision.lowLight && html`<${Badge} color="cyan">${t('Vision nocturne')}</${Badge}>`}
        ${vision.thermo && html`<${Badge} color="magenta">${t('Vision thermographique')}</${Badge}>`}
        ${vision.darkRange ? html`<${Badge}>${t('Vision dans le noir : {n} cases', { n: vision.darkRange })}</${Badge}>` : null}
      </div>`}
      ${edit && html`<div class="sh-edit-row row wrap">
        <div class="field"><span class="field-label">${t('Dés d’initiative')}</span><${NumberInput} small value=${actor.initiative?.dice ?? 1} min=${1} max=${5} onChange=${(v) => s.update({ initiative: { dice: v } })} /></div>
        <div class="field"><span class="field-label">${t('Bonus d’initiative')}</span><${NumberInput} small value=${actor.initiative?.bonus ?? 0} min=${-10} max=${20} onChange=${(v) => s.update({ initiative: { bonus: v } })} /></div>
        <div class="field"><span class="field-label">${t('Moniteur physique (forcé)')}</span><${NumberInput} small value=${actor.monitors?.physical ?? 0} min=${0} max=${40} onChange=${(v) => s.update({ monitors: { physical: v || null } })} /></div>
        <div class="field"><span class="field-label">${t('Moniteur étourdi (forcé)')}</span><${NumberInput} small value=${actor.monitors?.stun ?? 0} min=${0} max=${40} onChange=${(v) => s.update({ monitors: { stun: v || null } })} /></div>
        <${Toggle} value=${!!vision.lowLight} onChange=${(v) => s.update({ vision: { lowLight: v } })} label=${t('Vision nocturne')} />
        <${Toggle} value=${!!vision.thermo} onChange=${(v) => s.update({ vision: { thermo: v } })} label=${t('Thermographique')} />
        <div class="field"><span class="field-label">${t('Vision noir (cases)')}</span><${NumberInput} small value=${vision.darkRange ?? 0} min=${0} max=${50} onChange=${(v) => s.update({ vision: { darkRange: v } })} /></div>
      </div>`}
    </section>

    <section>
      <div class="sh-sec-head">
        <h4 class="section-title">${t('Moniteurs de condition')}</h4>
        <div class="row wrap">
          <${Badge} color=${statusColor(status)}>${statusLabel(status)}</${Badge}>
          ${d.woundModifier ? html`<${Badge} color="red" title=${t('Malus de blessures à tous les tests et à l’initiative')}>${t('Blessures {n}', { n: d.woundModifier })}</${Badge}>` : null}
        </div>
      </div>
      <div class="sh-tracks">
        <${ConditionTrack} label=${t('Physique')} kind="physical" max=${d.physicalMonitor} value=${c.physical || 0} readOnly=${!own} onSet=${setCond('physical')} />
        <${ConditionTrack} label=${t('Étourdissant')} kind="stun" max=${d.stunMonitor} value=${c.stun || 0} readOnly=${!own} onSet=${setCond('stun')} />
        <${ConditionTrack} label=${t('Surplus')} kind="overflow" max=${d.overflowMax} value=${Math.min(c.overflow || 0, d.overflowMax)} wounds=${false} readOnly=${!own} onSet=${setCond('overflow')} />
      </div>
      ${(c.overflow || 0) > d.overflowMax && html`<div class="error small">${t('Le surplus dépasse la Constitution : {name} est mort·e.', { name: actor.name })}</div>`}
      ${own && html`<${QuickDamage} s=${s} />`}
    </section>

    <section>
      <div class="sh-sec-head">
        <h4 class="section-title">${t('Chance')}</h4>
        <div class="row wrap">
          <${EdgePips} actor=${actor} canUse=${own} size="lg" />
          <span class="mono">${actor.edge?.current ?? 0}/${attr(actor, 'EDG')}</span>
          ${own && html`<${Button} small variant="accent" disabled=${!(actor.edge?.current > 0)} onClick=${() => send('edge/spend', { actorId: actor.id }).catch(() => {})}>${t('Dépenser 1')}</${Button}>
            <${Button} small variant="ghost" onClick=${() => send('edge/refresh', { actorId: actor.id }).catch(() => {})}>${t('Recharger')}</${Button}>`}
        </div>
      </div>
      <div class="muted small">${tRich(t('Avant un jet : {push} (+Chance en dés, règle des 6, sans limite). Après : {second} (relance des échecs) depuis le résultat du jet.'), { push: html`<b>${t('Repousser les limites')}</b>`, second: html`<b>${t('Seconde chance')}</b>` })}</div>
    </section>
  </div>`;
}
