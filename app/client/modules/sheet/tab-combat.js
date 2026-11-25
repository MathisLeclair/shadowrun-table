// Sheet tab « Combat »: initiative, defense/soak, weapons with attack rolls and ammo tracking.
import { html, Button, IconButton } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { SKILL_BY_ID, ATTR_SHORT, attr, skillPool, parseDamage } from '/shared/sr5.js';
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
    <span class=${'mono' + (left === 0 ? ' red' : left <= cap / 4 ? ' amber' : '')} title=${`Type de chargeur : ${w.ammo}`}>${left}/${cap}</span>
    ${s.own && html`<${IconButton} icon="−" title="Tirer une munition" onClick=${(e) => { e.stopPropagation(); set(left - 1); }} />
      <${IconButton} icon="↻" title="Recharger" onClick=${(e) => { e.stopPropagation(); set(cap); }} />`}
  </span>`;
}

export function CombatTab({ s }) {
  const { actor, d, edit } = s;
  const weapons = actor.weapons || [];
  const attack = (w) => {
    const lim = accuracyLimit(actor, w.accuracy);
    s.roll({ skillId: w.skill || 'exotic_weapon', label: `Attaque — ${w.name}`, limit: lim ?? undefined });
  };
  return html`<div class="sh-combat">
    <div class="sh-derived">
      <${RollStat} label="Initiative" value=${d.initiative.text} accent="cyan" />
      <${RollStat} label="Défense" value=${d.defense} sub="RÉA + INT" accent="amber" onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: 'Défense' })} />
      <${RollStat} label="Défense totale" value=${d.defense + attr(actor, 'WIL')} sub="+ VOL" onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: 'Défense totale', bonus: [{ label: 'VOL', value: attr(actor, 'WIL') }] })} />
      <${RollStat} label="Encaissement" value=${d.soak} sub="CON + armure" accent="amber" onClick=${() => s.roll({ attr: 'BOD', label: 'Encaissement', applyWounds: false, limit: null, bonus: [{ label: 'armure', value: d.armor }] })} />
      <${RollStat} label="Armure" value=${d.armor} />
      <${RollStat} label="Limite physique" value=${d.limits.physical} />
      <${RollStat} label="Blessures" value=${d.woundModifier || 0} accent=${d.woundModifier ? 'magenta' : null} />
    </div>
    <div class="muted small">Encaissement : la PA de l’arme modifie l’armure (ajoute-la en modificateur). Tous les jets d’attaque utilisent la Précision de l’arme comme limite.</div>

    <h4 class="section-title">Armes</h4>
    ${edit
      ? html`<${ListEditor} actor=${actor} list="weapons" />`
      : weapons.length
        ? html`<div class="sh-table-wrap"><table class="sr sh-weapons">
            <thead><tr><th>Arme</th><th class="right">Réserve</th><th class="right">Préc.</th><th>VD</th><th class="right">PA</th><th>Mode</th><th class="right">RC</th><th>Munitions</th><th></th></tr></thead>
            <tbody>
              ${weapons.map((w) => {
                const def = SKILL_BY_ID[w.skill];
                const sk = (actor.skills || []).find((x) => x.id === w.skill);
                const pool = skillPool(actor, w.skill || 'exotic_weapon');
                return html`<tr key=${w.id}>
                  <td>
                    <div class="sh-weapon-name">${w.name}${w.kind === 'melee' && w.reach ? html` <span class="badge" title="Allonge">allonge ${w.reach}</span>` : null}</div>
                    <div class="faint small">${def?.fr || w.skill || '—'}${sk ? '' : ' (non maîtrisée)'}${w.notes ? html` · <span title=${w.notes}>${w.notes.length > 60 ? w.notes.slice(0, 60) + '…' : w.notes}</span>` : null}</div>
                  </td>
                  <td class="num-cell sh-pool" title=${`${def?.fr || w.skill} + ${ATTR_SHORT[sk?.attr || def?.attr || 'AGI']}`}>${pool.impossible ? '—' : pool.pool}</td>
                  <td class="num-cell">${accuracyLimit(actor, w.accuracy) ?? w.accuracy ?? '—'}</td>
                  <td class="mono" title=${w.damage}>${damageText(actor, w.damage)}</td>
                  <td class="num-cell">${w.ap ?? 0}</td>
                  <td class="small">${w.mode || '—'}</td>
                  <td class="num-cell">${w.rc || 0}</td>
                  <td><${AmmoCell} s=${s} w=${w} /></td>
                  <td><${Button} small variant="primary" disabled=${pool.impossible} onClick=${() => attack(w)} title=${pool.impossible ? 'Compétence non maîtrisée' : 'Jet d’attaque'}>Attaque</${Button}></td>
                </tr>`;
              })}
            </tbody>
          </table></div>`
        : html`<div class="muted small">Aucune arme.</div>`}

    ${!edit && (actor.armor || []).length > 0 && html`
      <h4 class="section-title">Armure portée</h4>
      <div class="row wrap">${(actor.armor || []).filter((a) => a.equipped).map((a) => html`<span class="badge badge-cyan" key=${a.id}>${a.name} ${a.stack ? '+' : ''}${a.rating}</span>`)}
        ${!(actor.armor || []).some((a) => a.equipped) && html`<span class="muted small">Aucune armure équipée (onglet Équipement).</span>`}</div>`}
  </div>`;
}
