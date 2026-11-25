// Sheet tab « Résumé »: attributes, derived values, condition monitors, Edge.
import { useState } from 'preact/hooks';
import { html, Button, NumberInput, Toggle, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { attr, ATTR_SHORT, ATTR_LABELS } from '/shared/sr5.js';
import { ConditionTrack, EdgePips, actorStatus, statusColor, fmtNum } from './common.js';

const BASE_ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];

/** Clickable stat box that opens a roll. */
export function RollStat({ label, value, onClick, title, accent, sub }) {
  const cls = 'stat sh-stat' + (accent ? ` stat-${accent}` : '') + (onClick ? ' sh-clickable' : '');
  const inner = html`<span class="stat-value">${value}</span><span class="stat-label">${label}</span>${sub ? html`<span class="sh-stat-sub">${sub}</span>` : null}`;
  return onClick
    ? html`<button type="button" class=${cls} title=${title || `Lancer : ${label}`} onClick=${onClick}>${inner}</button>`
    : html`<div class=${cls} title=${title}>${inner}</div>`;
}

function AttrCell({ s, k }) {
  const { actor, edit } = s;
  const base = Number(actor.attributes[k] ?? 0);
  const eff = attr(actor, k);
  const aug = eff - base;
  if (edit) {
    return html`<div class="sh-attr editing">
      <span class="sh-attr-key" title=${ATTR_LABELS[k]}>${ATTR_SHORT[k]}</span>
      <${NumberInput} small value=${base} min=${0} max=${15} onChange=${(v) => s.update({ attributes: { [k]: v } })} />
      ${k !== 'EDG' && k !== 'MAG' && k !== 'RES'
        ? html`<label class="sh-attr-aug" title="Bonus d’augmentation (max +4)">aug.
            <${NumberInput} small value=${Number(actor.augmented?.[k] ?? 0)} min=${0} max=${4} onChange=${(v) => s.update({ augmented: { [k]: v } })} /></label>`
        : null}
    </div>`;
  }
  return html`<button type="button" class=${'sh-attr' + (aug ? ' augmented' : '')} title=${`${ATTR_LABELS[k]} — lancer un test d’attribut`} onClick=${() => s.roll({ attr: k })}>
    <span class="sh-attr-key">${ATTR_SHORT[k]}</span>
    <span class="sh-attr-val">${eff}</span>
    <span class="sh-attr-base">${aug ? `base ${base} +${aug}` : ATTR_LABELS[k]}</span>
  </button>`;
}

function QuickDamage({ s }) {
  const [amount, setAmount] = useState(1);
  const id = s.actor.id;
  const dmg = (type) => send('actor/damage', { actorId: id, amount, type }).catch(() => {});
  return html`<div class="sh-quickdmg row wrap">
    <${NumberInput} small value=${amount} min=${1} max=${30} onChange=${setAmount} />
    <${Button} small variant="danger" onClick=${() => dmg('P')} title="Ajoute des dommages physiques">Physiques</${Button}>
    <${Button} small onClick=${() => dmg('S')} title="Ajoute des dommages étourdissants (le surplus passe en physique)">Étourdissants</${Button}>
    <${Button} small variant="ghost" onClick=${() => send('actor/heal', { actorId: id, amount, type: 'S' }).catch(() => {})} title="Soigne des cases étourdissantes">Soigner É</${Button}>
    <${Button} small variant="ghost" onClick=${() => send('actor/heal', { actorId: id, amount, type: 'P' }).catch(() => {})} title="Soigne des cases physiques (surplus d’abord)">Soigner P</${Button}>
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
      <div class="sh-sec-head"><h4 class="section-title">Attributs</h4>
        ${edit && html`<div class="row wrap">
          ${!attrs.includes('MAG') && html`<${Button} small onClick=${() => s.update({ attributes: { MAG: 1 } })}>+ Magie</${Button}>`}
          ${attrs.includes('MAG') && html`<${Button} small variant="ghost" onClick=${() => s.update({ attributes: { MAG: null } })}>− Magie</${Button}>`}
          ${!attrs.includes('RES') && html`<${Button} small onClick=${() => s.update({ attributes: { RES: 1 } })}>+ Résonance</${Button}>`}
          ${attrs.includes('RES') && html`<${Button} small variant="ghost" onClick=${() => s.update({ attributes: { RES: null } })}>− Résonance</${Button}>`}
        </div>`}
      </div>
      <div class="sh-attrs">
        ${attrs.map((k) => html`<${AttrCell} s=${s} k=${k} key=${k} />`)}
        <div class=${'sh-attr sh-ess' + (edit ? ' editing' : '')} title="Essence">
          <span class="sh-attr-key">ESS</span>
          ${edit
            ? html`<${NumberInput} small value=${actor.attributes.ESS} min=${0} max=${6} step=${0.05} onChange=${(v) => s.update({ attributes: { ESS: v } })} />`
            : html`<span class="sh-attr-val">${fmtNum(Math.round(d.essence * 100) / 100)}</span><span class="sh-attr-base">Essence</span>`}
        </div>
      </div>
    </section>

    <section>
      <h4 class="section-title">Valeurs dérivées</h4>
      <div class="sh-derived">
        <${RollStat} label="Initiative" value=${d.initiative.text} accent="cyan" title=${d.woundModifier ? `Blessures ${d.woundModifier} au score` : 'Réaction + Intuition'} />
        ${attrs.includes('MAG') && html`<${RollStat} label="Init. astrale" value=${`${d.astralInitiative.base} + 2D6`} />`}
        ${actor.matrix && html`<${RollStat} label="Init. RV chaude" value=${`${d.matrixInitiative.hot.base} + 4D6`} title=${`RA : ${d.initiative.text} · RV froide : ${d.matrixInitiative.cold.base} + 3D6`} />`}
        <${RollStat} label="Limite physique" value=${d.limits.physical} />
        <${RollStat} label="Limite mentale" value=${d.limits.mental} />
        <${RollStat} label="Limite sociale" value=${d.limits.social} />
        ${d.limits.astral ? html`<${RollStat} label="Limite astrale" value=${d.limits.astral} />` : null}
        <${RollStat} label="Défense" value=${d.defense} sub="RÉA + INT" onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: 'Défense' })} />
        <${RollStat} label="Encaissement" value=${d.soak} sub="CON + armure" onClick=${() => s.roll({ attr: 'BOD', label: 'Encaissement', applyWounds: false, limit: null, bonus: [{ label: 'armure', value: d.armor }] })} />
        <${RollStat} label="Armure" value=${d.armor} />
        <${RollStat} label="Sang-froid" value=${d.composure} sub="CHA + VOL" onClick=${() => s.roll({ attr: 'CHA', attr2: 'WIL', label: 'Sang-froid' })} />
        <${RollStat} label="Jauger intentions" value=${d.judgeIntentions} sub="CHA + INT" onClick=${() => s.roll({ attr: 'CHA', attr2: 'INT', label: 'Jauger les intentions' })} />
        <${RollStat} label="Mémoire" value=${d.memory} sub="LOG + VOL" onClick=${() => s.roll({ attr: 'LOG', attr2: 'WIL', label: 'Mémoire' })} />
        <${RollStat} label="Soulever / porter" value=${d.liftCarry} sub="CON + FOR" onClick=${() => s.roll({ attr: 'BOD', attr2: 'STR', label: 'Soulever / porter' })} />
        <${RollStat} label="Déplacement" value=${`${d.movement.walk}/${d.movement.run} m`} title="Marche / course par tour" />
      </div>
      ${(vision.lowLight || vision.thermo || vision.darkRange) && html`<div class="row wrap sh-vision">
        ${vision.lowLight && html`<${Badge} color="cyan">Vision nocturne</${Badge}>`}
        ${vision.thermo && html`<${Badge} color="magenta">Vision thermographique</${Badge}>`}
        ${vision.darkRange ? html`<${Badge}>Vision dans le noir : ${vision.darkRange} cases</${Badge}>` : null}
      </div>`}
      ${edit && html`<div class="sh-edit-row row wrap">
        <div class="field"><span class="field-label">Dés d’initiative</span><${NumberInput} small value=${actor.initiative?.dice ?? 1} min=${1} max=${5} onChange=${(v) => s.update({ initiative: { dice: v } })} /></div>
        <div class="field"><span class="field-label">Bonus d’initiative</span><${NumberInput} small value=${actor.initiative?.bonus ?? 0} min=${-10} max=${20} onChange=${(v) => s.update({ initiative: { bonus: v } })} /></div>
        <div class="field"><span class="field-label">Moniteur physique (forcé)</span><${NumberInput} small value=${actor.monitors?.physical ?? 0} min=${0} max=${40} onChange=${(v) => s.update({ monitors: { physical: v || null } })} /></div>
        <div class="field"><span class="field-label">Moniteur étourdi (forcé)</span><${NumberInput} small value=${actor.monitors?.stun ?? 0} min=${0} max=${40} onChange=${(v) => s.update({ monitors: { stun: v || null } })} /></div>
        <${Toggle} value=${!!vision.lowLight} onChange=${(v) => s.update({ vision: { lowLight: v } })} label="Vision nocturne" />
        <${Toggle} value=${!!vision.thermo} onChange=${(v) => s.update({ vision: { thermo: v } })} label="Thermographique" />
        <div class="field"><span class="field-label">Vision noir (cases)</span><${NumberInput} small value=${vision.darkRange ?? 0} min=${0} max=${50} onChange=${(v) => s.update({ vision: { darkRange: v } })} /></div>
      </div>`}
    </section>

    <section>
      <div class="sh-sec-head">
        <h4 class="section-title">Moniteurs de condition</h4>
        <div class="row wrap">
          <${Badge} color=${statusColor(status)}>${status}</${Badge}>
          ${d.woundModifier ? html`<${Badge} color="red" title="Malus de blessures à tous les tests et à l’initiative">Blessures ${d.woundModifier}</${Badge}>` : null}
        </div>
      </div>
      <div class="sh-tracks">
        <${ConditionTrack} label="Physique" kind="physical" max=${d.physicalMonitor} value=${c.physical || 0} readOnly=${!own} onSet=${setCond('physical')} />
        <${ConditionTrack} label="Étourdissant" kind="stun" max=${d.stunMonitor} value=${c.stun || 0} readOnly=${!own} onSet=${setCond('stun')} />
        <${ConditionTrack} label="Surplus" kind="overflow" max=${d.overflowMax} value=${Math.min(c.overflow || 0, d.overflowMax)} wounds=${false} readOnly=${!own} onSet=${setCond('overflow')} />
      </div>
      ${(c.overflow || 0) > d.overflowMax && html`<div class="error small">Le surplus dépasse la Constitution : ${actor.name} est mort·e.</div>`}
      ${own && html`<${QuickDamage} s=${s} />`}
    </section>

    <section>
      <div class="sh-sec-head">
        <h4 class="section-title">Chance</h4>
        <div class="row wrap">
          <${EdgePips} actor=${actor} canUse=${own} size="lg" />
          <span class="mono">${actor.edge?.current ?? 0}/${attr(actor, 'EDG')}</span>
          ${own && html`<${Button} small variant="accent" disabled=${!(actor.edge?.current > 0)} onClick=${() => send('edge/spend', { actorId: actor.id }).catch(() => {})}>Dépenser 1</${Button}>
            <${Button} small variant="ghost" onClick=${() => send('edge/refresh', { actorId: actor.id }).catch(() => {})}>Recharger</${Button}>`}
        </div>
      </div>
      <div class="muted small">Avant un jet : <b>Repousser les limites</b> (+Chance en dés, règle des 6, sans limite). Après : <b>Seconde chance</b> (relance des échecs) depuis le résultat du jet.</div>
    </section>
  </div>`;
}
