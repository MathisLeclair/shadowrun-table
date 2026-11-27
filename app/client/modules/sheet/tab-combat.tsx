// Sheet tab « Combat »: initiative, defense/soak, weapons (ready / stowed, loaded rounds, reload) with attack rolls.
import { useState } from 'react';
import { Button } from '../../lib/ui.tsx';
import { SKILL_BY_ID, attr, skillPool, parseDamage } from '/shared/sr5.ts';
import { t, tn, tk, attrShort, skillLabel } from '../../lib/i18n.ts';
import { accuracyLimit, signed, itemLabel, itemTitle, categoryLabel, modeLabel, damageLabel } from './common.tsx';
import { RollStat } from './tab-summary.tsx';
import { ListEditor } from './editors.tsx';
import { SubChips, weaponWithMods } from './sublists.tsx';
import { rollContext } from '/shared/modifiers.ts';
import { LimitStat } from './tab-summary.tsx';
import { sourcesTitle, sourceName, effectText, poolModsOf, accuracyOf } from './modifiers-ui.tsx';
import { ruleRef } from '/shared/bookrefs.ts';
import { AmmoCell, ReadyToggle } from './weapon-ui.tsx';
import { readyCount, isUnarmed, isGrenade, usesAmmo, fireOptions } from './inventory.ts';
import { COMBAT_ACTIONS, unlockedActions, isUnlocked, AFFLICTIONS, stillActive } from '/shared/combat.ts';
import { send } from '../../lib/net.ts';
import type { ReactNode } from 'react';
import type { Actor, Weapon } from '../../../shared/types.ts';
import type { SheetCtx } from './types.ts';
import { ItemRef, SkillRef, RuleRef, BookRef } from '../books/BookRef.tsx';

type CombatAction = (typeof COMBAT_ACTIONS)[number];

/** "(STR+5)P" → "11P" for this actor; other damage codes unchanged. */
export function damageText(actor: Actor, dmg: string | null | undefined): string {
  const raw = String(dmg ?? '');
  if (!/STR/i.test(raw)) return raw || '—';
  const p = parseDamage(raw, actor);
  const rest = raw.replace(/\(?\s*STR\s*([+-]\s*\d+)?\s*\)?\s*[PS]?/i, '');
  return `${p.value}${p.type}${rest}`;
}

/** Toxin effects in progress (actor.afflictions, shared/combat.js AFFLICTIONS) — the GM can end one early. */
function Afflictions({ s }: { s: SheetCtx }) {
  const now = Date.now();
  const list = (s.actor.afflictions || []).filter((a) => a && (AFFLICTIONS as Record<string, unknown>)[a.kind] && stillActive(a.until, s.game.combat, now));
  if (!list.length) return null;
  const effect = (def: { dice?: number; woundFactor?: number }): string => (def.dice ? t('{n} dice on all tests', { n: def.dice }) : def.woundFactor ? t('wound modifiers ×{n}', { n: def.woundFactor }) : t('no actions'));
  return <div className="row wrap gap-s">
    <span className="field-label">{t('Active effects')}</span>
    {list.map((a) => {
      const def = (AFFLICTIONS as Record<string, { name: string; dice?: number; woundFactor?: number }>)[a.kind];
      return <span className="badge badge-magenta" key={a.id} title={`${a.source ? t(a.source) + ' — ' : ''}${effect(def)}`}>
        {t(def.name)} · {effect(def)}
        {s.gm && <>
          {' '}
          <button className="link" onClick={() => send('attack/removeAffliction', { actorId: s.actor.id, afflictionId: a.id }).catch(() => {})} title={t('End this effect')}>
            ✕
          </button>
        </>}
      </span>;
    })}
  </div>;
}

/** Weapons shown by default: the ready ones (« Mains nues » always). */
export const isReady = (w: Weapon): boolean => w.equipped !== false || isUnarmed(w);

export function CombatTab({ s }: { s: SheetCtx }) {
  const { actor, d, dm, edit } = s;
  const [showAll, setShowAll] = useState(false);
  const all = actor.weapons || [];
  const weapons = showAll ? all : all.filter(isReady);
  const stowed = all.length - all.filter(isReady).length;
  const ready = readyCount(actor);
  // Attack: the server computes the limit (Accuracy + accessories + Accuracy modifiers), adds the accessories' dice and uses the rounds
  // of the fire mode chosen in the roll dialog (weaponId).
  const attack = (w: Weapon) => s.roll({ skillId: w.skill || 'exotic_weapon', weaponId: w.id, label: `Attaque — ${w.nameFr || w.name}` }); // i18n-ignore: stored French label, shown with rollLabel()
  const arts = actor.martialArts || [];
  return <div className="sh-combat">
    <div className="sh-derived">
      <RollStat label={t('Initiative')} value={d.initiative.text} accent="cyan" book={ruleRef('initiative')} title={sourcesTitle(dm.sources.initiative)} />
      <RollStat label={t('Defense')} value={dm.defense} sub={`${attrShort('REA')} + ${attrShort('INT')}`} accent="amber" book={ruleRef('defense')} title={sourcesTitle(dm.sources.defense)} onClick={() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Defense'), test: 'defense' })} />
      <RollStat label={t('Full defense')} value={dm.defense + attr(actor, 'WIL')} book={ruleRef('defense')} sub={`+ ${attrShort('WIL')}`} onClick={() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Full defense'), test: 'defense', bonus: [{ label: 'VOL', value: attr(actor, 'WIL') }] /* 'VOL': label the server recognizes (playerBonus), shown translated */ })} />
      <RollStat label={t('Soak')} value={dm.soak} sub={t('{attr} + armor', { attr: attrShort('BOD') })} accent="amber" book={ruleRef('soak')} title={sourcesTitle([...(dm.sources.armor || []), ...(dm.sources.soak || [])])} onClick={() => s.roll({ attr: 'BOD', label: tk('Soak'), applyWounds: false, limit: null, test: 'soak' })} />
      <RollStat label={t('Armor')} value={dm.armor} book={ruleRef('armor')} title={sourcesTitle(dm.sources.armor)} />
      <LimitStat s={s} name="physical" label={t('Physical Limit')} />
      <RollStat label={t('Wounds')} value={dm.woundModifier || 0} accent={dm.woundModifier ? 'magenta' : null} book={ruleRef('woundModifiers')} />
    </div>
    <div className="muted small">
      {t('Soak: the weapon\'s AP modifies armor (add it as a modifier). Every attack roll uses the weapon\'s Accuracy as its limit.')}
    </div>
    <Afflictions s={s} />
    <div className="sh-sec-head">
      <h4 className="section-title">{t('Weapons')}</h4>
      {!edit && stowed > 0 && <Button small variant="ghost" onClick={() => setShowAll(!showAll)}>
        {showAll ? t('Ready weapons only') : tn(stowed, 'Show all ({n} stowed)', 'pl::Show all ({n} stowed)')}
      </Button>}
    </div>
    {!edit && ready.over && <div className="amber small">{t('Many ready weapons ({ranged} ranged, {melee} melee): usually 2 + 2 at most.', ready)}</div>}
    {edit
      ? <ListEditor actor={actor} list="weapons" />
      : weapons.length
        ? <div className="sh-table-wrap">
          <table className="sr sh-weapons">
            <thead>
              <tr>
                <th title={t('Ready / stowed')} />
                <th>{t('Weapon')}</th>
                <th className="right">{t('Pool')}</th>
                <th className="right">{t('Acc.')}</th>
                <th>{t('DV')}</th>
                <th className="right">{t('AP')}</th>
                <th>{t('Mode')}</th>
                <th className="right">{t('RC')}</th>
                <th>{t('Ammo')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {weapons.map((w) => {
                const def = SKILL_BY_ID[w.skill];
                const sk = (actor.skills || []).find((x) => x.id === w.skill);
                const pool = skillPool(actor, w.skill || 'exotic_weapon');
                const wm = weaponWithMods(actor, w, accuracyLimit);
                // Unconditional modifiers of the actor (skill / group / category dice, Accuracy qualities) — situational ones in the roll dialog.
                const rctx = rollContext(actor, { skillId: w.skill || 'exotic_weapon', weaponId: w.id });
                const pm = poolModsOf(s.mods, rctx, {});
                const acc = accuracyOf(actor, w, s.mods, rctx, {});
                const accMods = acc.lines.filter((l) => l.state === 'applied');
                const accTitle = [wm.mods.accuracy ? t('Accuracy {base} {mod} (accessories)', { base: wm.baseAccuracy ?? w.accuracy, mod: signed(wm.mods.accuracy) }) : '',
                  ...accMods.map((l) => `${sourceName(l.mod.source)} : ${effectText(l.mod)}`)].filter(Boolean).join('\n');
                const poolTitle = [`${def ? skillLabel(def.id) : w.skill} + ${attrShort(sk?.attr || def?.attr || 'AGI')}`, ...pm.lines.filter((l) => l.state === 'applied').map((l) => `${sourceName(l.mod.source)} : ${effectText(l.mod)}`)].join('\n');
                const rcTitle = wm.mods.rc ? t('RC {base} {mod} (accessories)', { base: Number(w.rc) || 0, mod: signed(wm.mods.rc) }) : '';
                const cat = categoryLabel(w);
                const empty = isGrenade(w) && Number(w.qty ?? 1) <= 0;
                return <tr key={w.id} className={w.equipped === false ? 'sh-stowed' : ''}>
                  <td className="sh-ready-cell">{isUnarmed(w) ? null : <ReadyToggle s={s} w={w} />}</td>
                  <td>
                    <div className="sh-weapon-name">
                      <span title={itemTitle(w)}>{itemLabel(w)}</span>
                      {' '}
                      <ItemRef item={w} />
                      {w.kind === 'melee' && w.reach ? <>{' '}<span className="badge" title={t('Reach')}>{t('reach {n}', { n: w.reach })}</span></> : null}
                      {wm.mods.smartgun ? <>
                        {' '}
                        <span className="badge badge-cyan" title={t('Smartgun: +2 dice with a wireless smartlink (add it to the roll).')}>
                          {t('smartgun')}
                        </span>
                      </> : null}
                    </div>
                    <div className="faint small">
                      {cat ? `${cat} · ` : ''}{def ? skillLabel(def.id) : w.skill || '—'}{def ? <>{' '}<SkillRef id={def.id} /></> : null}{sk ? '' : ` ${t('(untrained)')}`}{w.notes ? <> · <span title={w.notes}>{w.notes.length > 60 ? w.notes.slice(0, 60) + '…' : w.notes}</span></> : null}
                    </div>
                    {(w.accessories || []).length > 0 && <div><SubChips sub="accessories" items={w.accessories} /></div>}
                  </td>
                  <td className={'num-cell sh-pool' + (pm.total ? ' cyan' : '')} title={poolTitle}>
                    {pool.impossible ? '—' : pool.pool + wm.mods.dicePool + pm.total}
                  </td>
                  <td className={'num-cell' + (wm.mods.accuracy || accMods.length ? ' cyan' : '')} title={accTitle}>
                    {acc.total ?? wm.accuracy ?? w.accuracy ?? '—'}
                  </td>
                  <td className="mono" title={w.damage}>{damageLabel(damageText(actor, w.damage))}</td>
                  <td className="num-cell">{w.ap ?? 0}</td>
                  <td className="small" title={w.mode || ''}>{modeLabel(w.mode)}</td>
                  <td className={'num-cell' + (wm.mods.rc ? ' cyan' : '')} title={rcTitle}>{wm.rc}</td>
                  <td><AmmoCell s={s} w={w} /></td>
                  <td>
                    <Button small variant="primary" disabled={pool.impossible || empty} onClick={() => attack(w)} title={pool.impossible ? t('Untrained skill') : t('Attack roll')}>
                      {t('Attack')}
                    </Button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        : <div className="muted small">{all.length ? t('No ready weapon.') : t('No weapons.')}</div>}
    {!edit && <SpecialActions s={s} />}{(edit || arts.length > 0) && <h4 className="section-title">{t('Martial arts')}{' '}<RuleRef rule="martialArts" /></h4>}
    {edit
      ? <ListEditor actor={actor} list="martialArts" />
      : arts.length > 0 && <div className="sh-cards">
        {arts.map((m) => <div className="sh-card" key={m.id}>
          <div className="row spread">
            <span><b>{m.name}</b>{' '}<ItemRef item={m} /></span>
            {m.rating > 1 ? <span className="badge badge-magenta">{t('Rating {n}', { n: m.rating })}</span> : null}
          </div>
          <SubChips sub="techniques" items={m.techniques} empty={t('No technique.')} />
          {m.notes && <div className="faint small">{m.notes}</div>}
        </div>)}
      </div>}
    {!edit && (actor.armor || []).length > 0 && <>
      <h4 className="section-title">{t('Worn armor')}</h4>
      <div className="row wrap">
        {(actor.armor || []).filter((a) => a.equipped).map((a) => <span className="row gap-s" key={a.id}>
        <span className="badge badge-cyan" title={itemTitle(a)}>{itemLabel(a)}{' '}{a.stack ? '+' : ''}{a.rating}</span>
        <ItemRef item={a} />
      </span>)}
        {!(actor.armor || []).some((a) => a.equipped) && <span className="muted small">{t('No armor equipped (Gear tab).')}</span>}
      </div>
    </>}
  </div>;
}

/** Weapon used by a special action: the ready melee weapon with the best skill (or « Mains nues »), a ready gun with the fire mode. */
function weaponFor(actor: Actor, a: CombatAction): Weapon | null {
  const ready = (actor.weapons || []).filter((w) => w && isReady(w));
  const rating = (w: Weapon) => Number((actor.skills || []).find((x) => x.id === w.skill)?.rating) || 0;
  if (a.kind === 'melee' || a.weaponSkill) return ready.filter((w) => w.kind === 'melee').sort((x, y) => rating(y) - rating(x))[0] || null;
  if (a.kind === 'ranged') return ready.find((w) => w.kind !== 'melee' && (!a.fire || (usesAmmo(w) && fireOptions(w).some((o) => o.id === a.fire)))) || null;
  return ready.find((w) => w.kind !== 'melee' && !isGrenade(w)) || ready[0] || null;
}

/**
 * « Actions spéciales »: the actions unlocked by the character's techniques / qualities (R&G Finishing Move, Flying Kick…), the
 * defenses they unlock (used from the defense dialog), and the actions anyone can take (called shot, charge, Double Tap…).
 * « Utiliser » opens the attack roll with the action chosen (target from the map).
 */
function SpecialActions({ s }: { s: SheetCtx }) {
  const { actor } = s;
  const [showAll, setShowAll] = useState(false);
  const mine = unlockedActions(actor);
  const common = COMBAT_ACTIONS.filter((a) => !a.unlock?.length);
  const locked = s.gm ? COMBAT_ACTIONS.filter((a) => a.unlock?.length && !isUnlocked(a, actor)) : [];
  const use = (a: CombatAction) => {
    const w = a.kind === 'test' && !a.weaponSkill ? null : weaponFor(actor, a);
    if (a.kind === 'test') return s.roll({ attr: a.attr, skillId: a.weaponSkill ? w?.skill || 'unarmed_combat' : a.skillId, label: a.name, actionId: a.id });
    if (!w) return;
    s.roll({ skillId: w.skill || 'exotic_weapon', weaponId: w.id, label: `Attaque — ${w.nameFr || w.name}`, actionId: a.id }); // i18n-ignore: stored French label
  };
  const row = (a: CombatAction, extra: ReactNode = null) => {
    const w = a.kind === 'test' && !a.weaponSkill ? null : weaponFor(actor, a);
    const noWeapon = a.kind !== 'test' && !w;
    return <div className="sh-list-row" key={a.id}>
      <div className="grow">
        <div>
          <b>{t(a.name)}</b>
          {' '}
          <BookRef source={a.source} page={a.page} />
          {a.edge ? <>{' '}<span className="badge badge-magenta">{t('−{n} Edge', { n: a.edge })}</span></> : null}{a.ini ? <>{' '}<span className="badge">{t('−{n} init.', { n: a.ini })}</span></> : null}{a.once ? <>{' '}<span className="badge">{t('1× / turn')}</span></> : null}{extra}
        </div>
        <div className="faint small">{t(a.note)}{w ? ` · ${itemLabel(w)}` : ''}</div>
      </div>
      {s.own && <Button small variant="primary" disabled={noWeapon} title={noWeapon ? (a.kind === 'ranged' ? t('No suitable ready weapon') : t('No ready melee weapon')) : t('Attack roll with this action')} onClick={() => use(a)}>
        {t('Use')}
      </Button>}
    </div>;
  };
  return <>
    <div className="sh-sec-head">
      <h4 className="section-title">{t('Special actions')}</h4>
      <Button small variant="ghost" onClick={() => setShowAll(!showAll)}>
        {showAll ? t('Hide common actions') : tn(common.length, 'Common actions ({n})', 'Common actions ({n})')}
      </Button>
    </div>
    {mine.actions.length || mine.defenses.length
      ? <div className="sh-list">
        {mine.actions.map((a) => row(a))}
        {mine.defenses.map((o) => <div className="sh-list-row" key={o.id}>
            <div className="grow">
              <b>{t(o.name)}</b>
              {' '}
              <BookRef source={o.source} page={o.page} />
              {' '}
              <span className="badge">{t('−{n} init.', { n: o.ini })}</span>
              <div className="faint small">{t('Defense: tick it in the “Defend” window when attacked (lasts the whole turn).')}</div>
            </div>
          </div>)}
      </div>
      : <div className="muted small">{t('No special action unlocked (martial arts techniques, qualities).')}</div>}
    {showAll && <div className="sh-list">
      {common.map((a) => row(a))}{locked.map((a) => row(a, <>{' '}<span className="badge badge-amber">{t('not unlocked (GM)')}</span></>))}
    </div>}
    <div className="faint small">
      {t('Target: click a token on the map (or pick it in the roll window). Defense and damage follow automatically.')}
    </div>
  </>;
}
