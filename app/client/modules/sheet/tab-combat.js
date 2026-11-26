// Sheet tab « Combat »: initiative, defense/soak, weapons with attack rolls and ammo tracking.
import { html, Button, IconButton } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { SKILL_BY_ID, attr, skillPool, parseDamage } from '/shared/sr5.js';
import { t, tk, attrShort, skillLabel } from '../../lib/i18n.js';
import { accuracyLimit, signed } from './common.js';
import { RollStat } from './tab-summary.js';
import { ListEditor } from './editors.js';
import { SubChips, weaponWithMods } from './sublists.js';
import { poolModifiers, rollContext, weaponAccuracy } from '/shared/modifiers.js';
import { LimitStat } from './tab-summary.js';
import { sourcesTitle, sourceName, effectText } from './modifiers-ui.js';
import { ItemRef, SkillRef, RuleRef } from '../books/BookRef.js';
import { ruleRef } from '/shared/bookrefs.js';

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
  const { actor, d, dm, edit } = s;
  const weapons = actor.weapons || [];
  // Attack: the server computes the limit (Accuracy + accessories + Accuracy modifiers) and adds the accessories' dice (weaponId).
  const attack = (w) => s.roll({ skillId: w.skill || 'exotic_weapon', weaponId: w.id, label: `Attaque — ${w.name}` }); // i18n-ignore: stored French label, shown with rollLabel()
  const arts = actor.martialArts || [];
  return html`<div class="sh-combat">
    <div class="sh-derived">
      <${RollStat} label=${t('Initiative')} value=${d.initiative.text} accent="cyan" book=${ruleRef('initiative')} title=${sourcesTitle(dm.sources.initiative)} />
      <${RollStat} label=${t('Défense')} value=${dm.defense} sub=${`${attrShort('REA')} + ${attrShort('INT')}`} accent="amber" book=${ruleRef('defense')} title=${sourcesTitle(dm.sources.defense)} onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Défense'), test: 'defense' })} />
      <${RollStat} label=${t('Défense totale')} value=${dm.defense + attr(actor, 'WIL')} book=${ruleRef('defense')} sub=${`+ ${attrShort('WIL')}`} onClick=${() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Défense totale'), test: 'defense', bonus: [{ label: 'VOL', value: attr(actor, 'WIL') }] })} />
      <${RollStat} label=${t('Encaissement')} value=${dm.soak} sub=${t('{attr} + armure', { attr: attrShort('BOD') })} accent="amber" book=${ruleRef('soak')} title=${sourcesTitle([...(dm.sources.armor || []), ...(dm.sources.soak || [])])} onClick=${() => s.roll({ attr: 'BOD', label: tk('Encaissement'), applyWounds: false, limit: null, test: 'soak' })} />
      <${RollStat} label=${t('Armure')} value=${dm.armor} book=${ruleRef('armor')} title=${sourcesTitle(dm.sources.armor)} />
      <${LimitStat} s=${s} name="physical" label=${t('Limite physique')} />
      <${RollStat} label=${t('Blessures')} value=${dm.woundModifier || 0} accent=${dm.woundModifier ? 'magenta' : null} book=${ruleRef('woundModifiers')} />
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
                const wm = weaponWithMods(actor, w, accuracyLimit);
                // Unconditional modifiers of the actor (skill / group / category dice, Accuracy qualities) — situational ones in the roll dialog.
                const rctx = rollContext(actor, { skillId: w.skill || 'exotic_weapon', weaponId: w.id });
                const pm = poolModifiers(s.mods, rctx, {});
                const acc = weaponAccuracy(actor, w, s.mods, rctx, {});
                const accMods = acc.lines.filter((l) => l.state === 'applied');
                const accTitle = [wm.mods.accuracy ? t('Précision {base} {mod} (accessoires)', { base: wm.baseAccuracy ?? w.accuracy, mod: signed(wm.mods.accuracy) }) : '',
                  ...accMods.map((l) => `${sourceName(l.mod.source)} : ${effectText(l.mod)}`)].filter(Boolean).join('\n');
                const poolTitle = [`${def ? skillLabel(def.id) : w.skill} + ${attrShort(sk?.attr || def?.attr || 'AGI')}`, ...pm.lines.filter((l) => l.state === 'applied').map((l) => `${sourceName(l.mod.source)} : ${effectText(l.mod)}`)].join('\n');
                const rcTitle = wm.mods.rc ? t('RC {base} {mod} (accessoires)', { base: Number(w.rc) || 0, mod: signed(wm.mods.rc) }) : '';
                return html`<tr key=${w.id}>
                  <td>
                    <div class="sh-weapon-name">${w.name} <${ItemRef} item=${w} />${w.kind === 'melee' && w.reach ? html` <span class="badge" title=${t('Allonge')}>${t('allonge {n}', { n: w.reach })}</span>` : null}
                      ${wm.mods.smartgun ? html` <span class="badge badge-cyan" title=${t('Smartgun : +2 dés avec un smartlink sans fil (à ajouter au jet).')}>${t('smartgun')}</span>` : null}</div>
                    <div class="faint small">${def ? skillLabel(def.id) : w.skill || '—'}${def ? html` <${SkillRef} id=${def.id} />` : null}${sk ? '' : ` ${t('(non maîtrisée)')}`}${w.notes ? html` · <span title=${w.notes}>${w.notes.length > 60 ? w.notes.slice(0, 60) + '…' : w.notes}</span>` : null}</div>
                    ${(w.accessories || []).length > 0 && html`<div><${SubChips} sub="accessories" items=${w.accessories} /></div>`}
                  </td>
                  <td class=${'num-cell sh-pool' + (pm.total ? ' cyan' : '')} title=${poolTitle}>${pool.impossible ? '—' : pool.pool + wm.mods.dicePool + pm.total}</td>
                  <td class=${'num-cell' + (wm.mods.accuracy || accMods.length ? ' cyan' : '')} title=${accTitle}>${acc.total ?? wm.accuracy ?? w.accuracy ?? '—'}</td>
                  <td class="mono" title=${w.damage}>${damageText(actor, w.damage)}</td>
                  <td class="num-cell">${w.ap ?? 0}</td>
                  <td class="small">${w.mode || '—'}</td>
                  <td class=${'num-cell' + (wm.mods.rc ? ' cyan' : '')} title=${rcTitle}>${wm.rc}</td>
                  <td><${AmmoCell} s=${s} w=${w} /></td>
                  <td><${Button} small variant="primary" disabled=${pool.impossible} onClick=${() => attack(w)} title=${pool.impossible ? t('Compétence non maîtrisée') : t('Jet d’attaque')}>${t('Attaque')}</${Button}></td>
                </tr>`;
              })}
            </tbody>
          </table></div>`
        : html`<div class="muted small">${t('Aucune arme.')}</div>`}

    ${(edit || arts.length > 0) && html`<h4 class="section-title">${t('Arts martiaux')} <${RuleRef} rule="martialArts" /></h4>`}
    ${edit
      ? html`<${ListEditor} actor=${actor} list="martialArts" />`
      : arts.length > 0 && html`<div class="sh-cards">${arts.map((m) => html`<div class="sh-card" key=${m.id}>
          <div class="row spread"><span><b>${m.name}</b> <${ItemRef} item=${m} /></span>${m.rating > 1 ? html`<span class="badge badge-magenta">${t('Indice {n}', { n: m.rating })}</span>` : null}</div>
          <${SubChips} sub="techniques" items=${m.techniques} empty=${t('Aucune technique.')} />
          ${m.notes && html`<div class="faint small">${m.notes}</div>`}
        </div>`)}</div>`}

    ${!edit && (actor.armor || []).length > 0 && html`
      <h4 class="section-title">${t('Armure portée')}</h4>
      <div class="row wrap">${(actor.armor || []).filter((a) => a.equipped).map((a) => html`<span class="row gap-s" key=${a.id}><span class="badge badge-cyan">${a.name} ${a.stack ? '+' : ''}${a.rating}</span><${ItemRef} item=${a} /></span>`)}
        ${!(actor.armor || []).some((a) => a.equipped) && html`<span class="muted small">${t('Aucune armure équipée (onglet Équipement).')}</span>`}</div>`}
  </div>`;
}
