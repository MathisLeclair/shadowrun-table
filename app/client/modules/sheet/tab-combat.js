// Sheet tab « Combat »: initiative, defense/soak, weapons with attack rolls and ammo tracking.
import { html, Button, IconButton } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { SKILL_BY_ID, attr, skillPool, parseDamage } from '/shared/sr5.js';
import { t, tk, attrShort, skillLabel } from '../../lib/i18n.js';
import { accuracyLimit } from './common.js';
import { RollStat } from './tab-summary.js';
import { ListEditor } from './editors.js';

/** "(STR+5)P" → "11P" for this actor; other damage codes unchanged. */
export function damageText(actor, dmg) {
  const raw = String(dmg ?? '');
  if (!/STR/i.test(raw)) return raw || '—';
  const p = parseDamage(raw, actor);
  const rest = raw.replace(/\(?\s*STR\s*([+-]\s*\d+)?\s*\)?\s*[PS]?/i, '');
  return `${p.value}${p.type}${rest}`;
}

const capacity = (ammo) => {
  const m = String(ammo ?? '').match(/^\s*(\d+)/);
  return m ? Number(m[1]) : 0;
};

function AmmoCell({ s, w }) {
  const cap = capacity(w.ammo);
  if (!cap || (w.kind === 'melee' && !/charge/i.test(w.ammo || ''))) return html`<span class="muted">${w.ammo || '—'}</span>`;
  const left = w.ammoLeft ?? cap;
  const set = (v) => send('actor/updateItem', { actorId: s.actor.id, list: 'weapons', itemId: w.id, patch: { ammoLeft: Math.max(0, Math.min(cap, v)) } }).catch(() => {});
  return html`<span class="sh-ammo">
    <span class=${'mono' + (left === 0 ? ' red' : left <= cap / 4 ? ' amber' : '')} title=${t('Type de chargeur : {ammo}', { ammo: w.ammo })}>${left}/${cap}</span>
    ${s.own && html`<${IconButton} icon="−" title=${t('Tirer une munition')} onClick=${(e) => { e.stopPropagation(); set(left - 1); }} />
      <${IconButton} icon="↻" title=${t('Recharger')} onClick=${(e) => { e.stopPropagation(); set(cap); }} />`}
  </span>`;
}

export function CombatTab({ s }) {
  const { actor, d, edit } = s;
  const weapons = actor.weapons || [];
  const attack = (w) => {
    const lim = accuracyLimit(actor, w.accuracy);
    s.roll({ skillId: w.skill || 'exotic_weapon', label: `Attaque — ${w.name}`, limit: lim ?? undefined }); // i18n-ignore: stored French label, shown with rollLabel()
  };
  return html`<div class="sh-combat">
    <div class="sh-derived">
      <${RollStat} label=${t('Initiative')} value=${d.initiative.text} accent="cyan" />
      <${RollStat} label=${t('Défense')} value=${d.defense} sub=${`${attrShort('REA')} + ${attrShort('INT')}`} accent="amber" onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Défense') })} />
      <${RollStat} label=${t('Défense totale')} value=${d.defense + attr(actor, 'WIL')} sub=${`+ ${attrShort('WIL')}`} onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Défense totale'), bonus: [{ label: 'VOL', value: attr(actor, 'WIL') }] })} />
      <${RollStat} label=${t('Encaissement')} value=${d.soak} sub=${t('{attr} + armure', { attr: attrShort('BOD') })} accent="amber" onClick=${() => s.roll({ attr: 'BOD', label: tk('Encaissement'), applyWounds: false, limit: null, bonus: [{ label: tk('armure'), value: d.armor }] })} />
      <${RollStat} label=${t('Armure')} value=${d.armor} />
      <${RollStat} label=${t('Limite physique')} value=${d.limits.physical} />
      <${RollStat} label=${t('Blessures')} value=${d.woundModifier || 0} accent=${d.woundModifier ? 'magenta' : null} />
    </div>
    <div class="muted small">${t('Encaissement : la PA de l’arme modifie l’armure (ajoute-la en modificateur). Tous les jets d’attaque utilisent la Précision de l’arme comme limite.')}</div>

    <h4 class="section-title">${t('Armes')}</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="weapons" />`
      : weapons.length
        ? html`<div class="sh-table-wrap"><table class="sr sh-weapons">
            <thead><tr><th>${t('Arme')}</th><th class="right">${t('Réserve')}</th><th class="right">${t('Préc.')}</th><th>${t('VD')}</th><th class="right">${t('PA')}</th><th>${t('Mode')}</th><th class="right">${t('RC')}</th><th>${t('Munitions')}</th><th></th></tr></thead>
            <tbody>
              ${weapons.map((w) => {
                const def = SKILL_BY_ID[w.skill];
                const sk = (actor.skills || []).find((x) => x.id === w.skill);
                const pool = skillPool(actor, w.skill || 'exotic_weapon');
                return html`<tr key=${w.id}>
                  <td>
                    <div class="sh-weapon-name">${w.name}${w.kind === 'melee' && w.reach ? html` <span class="badge" title=${t('Allonge')}>${t('allonge {n}', { n: w.reach })}</span>` : null}</div>
                    <div class="faint small">${def ? skillLabel(def.id) : w.skill || '—'}${sk ? '' : ` ${t('(non maîtrisée)')}`}${w.notes ? html` · <span title=${w.notes}>${w.notes.length > 60 ? w.notes.slice(0, 60) + '…' : w.notes}</span>` : null}</div>
                  </td>
                  <td class="num-cell sh-pool" title=${`${def ? skillLabel(def.id) : w.skill} + ${attrShort(sk?.attr || def?.attr || 'AGI')}`}>${pool.impossible ? '—' : pool.pool}</td>
                  <td class="num-cell">${accuracyLimit(actor, w.accuracy) ?? w.accuracy ?? '—'}</td>
                  <td class="mono" title=${w.damage}>${damageText(actor, w.damage)}</td>
                  <td class="num-cell">${w.ap ?? 0}</td>
                  <td class="small">${w.mode || '—'}</td>
                  <td class="num-cell">${w.rc || 0}</td>
                  <td><${AmmoCell} s=${s} w=${w} /></td>
                  <td><${Button} small variant="primary" disabled=${pool.impossible} onClick=${() => attack(w)} title=${pool.impossible ? t('Compétence non maîtrisée') : t('Jet d’attaque')}>${t('Attaque')}</${Button}></td>
                </tr>`;
              })}
            </tbody>
          </table></div>`
        : html`<div class="muted small">${t('Aucune arme.')}</div>`}

    ${!edit && (actor.armor || []).length > 0 && html`
      <h4 class="section-title">${t('Armure portée')}</h4>
      <div class="row wrap">${(actor.armor || []).filter((a) => a.equipped).map((a) => html`<span class="badge badge-cyan" key=${a.id}>${a.name} ${a.stack ? '+' : ''}${a.rating}</span>`)}
        ${!(actor.armor || []).some((a) => a.equipped) && html`<span class="muted small">${t('Aucune armure équipée (onglet Équipement).')}</span>`}</div>`}
  </div>`;
}
