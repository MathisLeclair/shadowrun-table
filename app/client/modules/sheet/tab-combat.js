// Sheet tab « Combat »: initiative, defense/soak, weapons (ready / stowed, loaded rounds, reload) with attack rolls.
import { useState } from 'preact/hooks';
import { html, Button } from '../../lib/ui.js';
import { SKILL_BY_ID, attr, skillPool, parseDamage } from '/shared/sr5.js';
import { t, tn, tk, attrShort, skillLabel } from '../../lib/i18n.js';
import { accuracyLimit, signed, itemLabel, itemTitle, categoryLabel, modeLabel, damageLabel } from './common.js';
import { RollStat } from './tab-summary.js';
import { ListEditor } from './editors.js';
import { SubChips, weaponWithMods } from './sublists.js';
import { poolModifiers, rollContext, weaponAccuracy } from '/shared/modifiers.js';
import { LimitStat } from './tab-summary.js';
import { sourcesTitle, sourceName, effectText } from './modifiers-ui.js';
import { ItemRef, SkillRef, RuleRef, BookRef } from '../books/BookRef.js';
import { ruleRef } from '/shared/bookrefs.js';
import { AmmoCell, ReadyToggle } from './weapon-ui.js';
import { readyCount, isUnarmed, isGrenade, usesAmmo, fireOptions } from './inventory.js';
import { COMBAT_ACTIONS, unlockedActions, isUnlocked } from '/shared/combat.js';

/** "(STR+5)P" → "11P" for this actor; other damage codes unchanged. */
export function damageText(actor, dmg) {
  const raw = String(dmg ?? '');
  if (!/STR/i.test(raw)) return raw || '—';
  const p = parseDamage(raw, actor);
  const rest = raw.replace(/\(?\s*STR\s*([+-]\s*\d+)?\s*\)?\s*[PS]?/i, '');
  return `${p.value}${p.type}${rest}`;
}

/** Weapons shown by default: the ready ones (« Mains nues » always). */
export const isReady = (w) => w.equipped !== false || isUnarmed(w);

export function CombatTab({ s }) {
  const { actor, d, dm, edit } = s;
  const [showAll, setShowAll] = useState(false);
  const all = actor.weapons || [];
  const weapons = showAll ? all : all.filter(isReady);
  const stowed = all.length - all.filter(isReady).length;
  const ready = readyCount(actor);
  // Attack: the server computes the limit (Accuracy + accessories + Accuracy modifiers), adds the accessories' dice and uses the rounds
  // of the fire mode chosen in the roll dialog (weaponId).
  const attack = (w) => s.roll({ skillId: w.skill || 'exotic_weapon', weaponId: w.id, label: `Attaque — ${w.nameFr || w.name}` }); // i18n-ignore: stored French label, shown with rollLabel()
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

    <div class="sh-sec-head"><h4 class="section-title">${t('Armes')}</h4>
      ${!edit && stowed > 0 && html`<${Button} small variant="ghost" onClick=${() => setShowAll(!showAll)}>${showAll ? t('Armes prêtes seulement') : tn(stowed, 'Afficher tout ({n} rangée)', 'Afficher tout ({n} rangées)')}</${Button}>`}</div>
    ${!edit && ready.over && html`<div class="amber small">${t('Beaucoup d’armes prêtes ({ranged} à distance, {melee} de mêlée) : en principe 2 + 2 au plus.', ready)}</div>`}
    ${edit
      ? html`<${ListEditor} actor=${actor} list="weapons" />`
      : weapons.length
        ? html`<div class="sh-table-wrap"><table class="sr sh-weapons">
            <thead><tr><th title=${t('Prête / rangée')}></th><th>${t('Arme')}</th><th class="right">${t('Réserve')}</th><th class="right">${t('Préc.')}</th><th>${t('VD')}</th><th class="right">${t('PA')}</th><th>${t('Mode')}</th><th class="right">${t('RC')}</th><th>${t('Munitions')}</th><th></th></tr></thead>
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
                const cat = categoryLabel(w);
                const empty = isGrenade(w) && Number(w.qty ?? 1) <= 0;
                return html`<tr key=${w.id} class=${w.equipped === false ? 'sh-stowed' : ''}>
                  <td class="sh-ready-cell">${isUnarmed(w) ? null : html`<${ReadyToggle} s=${s} w=${w} />`}</td>
                  <td>
                    <div class="sh-weapon-name"><span title=${itemTitle(w)}>${itemLabel(w)}</span> <${ItemRef} item=${w} />${w.kind === 'melee' && w.reach ? html` <span class="badge" title=${t('Allonge')}>${t('allonge {n}', { n: w.reach })}</span>` : null}
                      ${wm.mods.smartgun ? html` <span class="badge badge-cyan" title=${t('Smartgun : +2 dés avec un smartlink sans fil (à ajouter au jet).')}>${t('smartgun')}</span>` : null}</div>
                    <div class="faint small">${cat ? `${cat} · ` : ''}${def ? skillLabel(def.id) : w.skill || '—'}${def ? html` <${SkillRef} id=${def.id} />` : null}${sk ? '' : ` ${t('(non maîtrisée)')}`}${w.notes ? html` · <span title=${w.notes}>${w.notes.length > 60 ? w.notes.slice(0, 60) + '…' : w.notes}</span>` : null}</div>
                    ${(w.accessories || []).length > 0 && html`<div><${SubChips} sub="accessories" items=${w.accessories} /></div>`}
                  </td>
                  <td class=${'num-cell sh-pool' + (pm.total ? ' cyan' : '')} title=${poolTitle}>${pool.impossible ? '—' : pool.pool + wm.mods.dicePool + pm.total}</td>
                  <td class=${'num-cell' + (wm.mods.accuracy || accMods.length ? ' cyan' : '')} title=${accTitle}>${acc.total ?? wm.accuracy ?? w.accuracy ?? '—'}</td>
                  <td class="mono" title=${w.damage}>${damageLabel(damageText(actor, w.damage))}</td>
                  <td class="num-cell">${w.ap ?? 0}</td>
                  <td class="small" title=${w.mode || ''}>${modeLabel(w.mode)}</td>
                  <td class=${'num-cell' + (wm.mods.rc ? ' cyan' : '')} title=${rcTitle}>${wm.rc}</td>
                  <td><${AmmoCell} s=${s} w=${w} /></td>
                  <td><${Button} small variant="primary" disabled=${pool.impossible || empty} onClick=${() => attack(w)} title=${pool.impossible ? t('Compétence non maîtrisée') : t('Jet d’attaque')}>${t('Attaque')}</${Button}></td>
                </tr>`;
              })}
            </tbody>
          </table></div>`
        : html`<div class="muted small">${all.length ? t('Aucune arme prête.') : t('Aucune arme.')}</div>`}

    ${!edit && html`<${SpecialActions} s=${s} />`}

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
      <div class="row wrap">${(actor.armor || []).filter((a) => a.equipped).map((a) => html`<span class="row gap-s" key=${a.id}><span class="badge badge-cyan" title=${itemTitle(a)}>${itemLabel(a)} ${a.stack ? '+' : ''}${a.rating}</span><${ItemRef} item=${a} /></span>`)}
        ${!(actor.armor || []).some((a) => a.equipped) && html`<span class="muted small">${t('Aucune armure équipée (onglet Équipement).')}</span>`}</div>`}
  </div>`;
}

/** Weapon used by a special action: the ready melee weapon with the best skill (or « Mains nues »), a ready gun with the fire mode. */
function weaponFor(actor, a) {
  const ready = (actor.weapons || []).filter((w) => w && isReady(w));
  const rating = (w) => Number((actor.skills || []).find((x) => x.id === w.skill)?.rating) || 0;
  if (a.kind === 'melee' || a.weaponSkill) return ready.filter((w) => w.kind === 'melee').sort((x, y) => rating(y) - rating(x))[0] || null;
  if (a.kind === 'ranged') return ready.find((w) => w.kind !== 'melee' && (!a.fire || (usesAmmo(w) && fireOptions(w).some((o) => o.id === a.fire)))) || null;
  return ready.find((w) => w.kind !== 'melee' && !isGrenade(w)) || ready[0] || null;
}

/**
 * « Actions spéciales »: the actions unlocked by the character's techniques / qualities (R&G Finishing Move, Flying Kick…), the
 * defenses they unlock (used from the defense dialog), and the actions anyone can take (called shot, charge, Double Tap…).
 * « Utiliser » opens the attack roll with the action chosen (target from the map).
 */
function SpecialActions({ s }) {
  const { actor } = s;
  const [showAll, setShowAll] = useState(false);
  const mine = unlockedActions(actor);
  const common = COMBAT_ACTIONS.filter((a) => !a.unlock?.length);
  const locked = s.gm ? COMBAT_ACTIONS.filter((a) => a.unlock?.length && !isUnlocked(a, actor)) : [];
  const use = (a) => {
    const w = a.kind === 'test' && !a.weaponSkill ? null : weaponFor(actor, a);
    if (a.kind === 'test') return s.roll({ attr: a.attr, skillId: a.weaponSkill ? w?.skill || 'unarmed_combat' : a.skillId, label: a.name, actionId: a.id });
    if (!w) return;
    s.roll({ skillId: w.skill || 'exotic_weapon', weaponId: w.id, label: `Attaque — ${w.nameFr || w.name}`, actionId: a.id }); // i18n-ignore: stored French label
  };
  const row = (a, extra = null) => {
    const w = a.kind === 'test' && !a.weaponSkill ? null : weaponFor(actor, a);
    const noWeapon = a.kind !== 'test' && !w;
    return html`<div class="sh-list-row" key=${a.id}>
      <div class="grow">
        <div><b>${t(a.name)}</b> <${BookRef} source=${a.source} page=${a.page} />
          ${a.edge ? html` <span class="badge badge-magenta">${t('−{n} Chance', { n: a.edge })}</span>` : null}
          ${a.ini ? html` <span class="badge">${t('−{n} init.', { n: a.ini })}</span>` : null}
          ${a.once ? html` <span class="badge">${t('1 fois / tour')}</span>` : null}
          ${extra}</div>
        <div class="faint small">${t(a.note)}${w ? ` · ${itemLabel(w)}` : ''}</div>
      </div>
      ${s.own && html`<${Button} small variant="primary" disabled=${noWeapon} title=${noWeapon ? (a.kind === 'ranged' ? t('Aucune arme prête adaptée') : t('Aucune arme de mêlée prête')) : t('Jet d’attaque avec cette action')} onClick=${() => use(a)}>${t('Utiliser')}</${Button}>`}
    </div>`;
  };
  return html`<div class="sh-sec-head"><h4 class="section-title">${t('Actions spéciales')}</h4>
      <${Button} small variant="ghost" onClick=${() => setShowAll(!showAll)}>${showAll ? t('Masquer les actions communes') : tn(common.length, 'Actions communes ({n})', 'Actions communes ({n})')}</${Button}></div>
    ${mine.actions.length || mine.defenses.length
      ? html`<div class="sh-list">
          ${mine.actions.map((a) => row(a))}
          ${mine.defenses.map((o) => html`<div class="sh-list-row" key=${o.id}><div class="grow"><b>${t(o.name)}</b> <${BookRef} source=${o.source} page=${o.page} /> <span class="badge">${t('−{n} init.', { n: o.ini })}</span>
            <div class="faint small">${t('Défense : à cocher dans la fenêtre « Se défendre » quand on est attaqué (dure tout le tour).')}</div></div></div>`)}
        </div>`
      : html`<div class="muted small">${t('Aucune action spéciale débloquée (techniques d’arts martiaux, qualités).')}</div>`}
    ${showAll && html`<div class="sh-list">${common.map((a) => row(a))}${locked.map((a) => row(a, html` <span class="badge badge-amber">${t('non débloquée (MJ)')}</span>`))}</div>`}
    <div class="faint small">${t('Cible : clic sur un pion de la carte (ou dans la fenêtre du jet). La défense et les dommages suivent automatiquement.')}</div>`;
}
