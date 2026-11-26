// Attack tray (global, every user): attacks waiting for me (defend / resist damage), my attacks in progress, the latest results,
// GM shortcuts (auto-resolve an NPC's defense + soak, settle by hand, cancel). Dialogs: DefenseDialog, SoakDialog.
// Server: server/modules/33-attacks.js — rules: shared/combat.js.
import { useMemo, useState, useEffect } from 'preact/hooks';
import { html, Button, IconButton, NumberInput, Toggle, loadCss, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { openSheet } from '../../lib/ui-store.js';
import { attr, derive } from '/shared/sr5.js';
import { derivedWithModifiers } from '/shared/modifiers.js';
import { t, tn, getLang } from '../../lib/i18n.js';
import { Overlay, DiceFaces, RollBadges } from '../sheet/common.js';
import { useModifiers } from '../sheet/modifiers-ui.js';
import { BookRef } from '../books/BookRef.js';
import { DEFENSE_OPTIONS, DEFENSE_SITUATIONS, defenseLines, isUnlocked, unlockNames, finalDamageType, TOXIN_BY_ID, AFFLICTIONS } from '/shared/combat.js';
import { ownsActorId, turnInfo, PENDING } from './attack-common.js';

loadCss('/modules/combat/combat.css');

const RECENT_MS = 25000;
const wName = (n) => (!n ? '' : typeof n === 'string' ? n : (getLang() === 'en' ? n.en : n.fr) || n.fr || n.en || '');
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);

/** One-line description of an attack: « Garde 2 → Anthony · Ares Predator · 4 succès · VD 8P PA −1 ». */
function attackSummary(a) {
  const bits = [];
  if (a.actionName) bits.push(t(a.actionName));
  if (a.weaponName) bits.push(wName(a.weaponName));
  if (a.kind === 'toxin') {
    bits.push(t('{toxin}, puissance {n}', { toxin: t(TOXIN_BY_ID[a.toxinId]?.name || ''), n: a.dv }));
    return bits.join(' · ');
  }
  if (a.kind === 'blast') bits.push(t('souffle à {m} m', { m: a.meters }));
  else bits.push(tn(a.hits, 'one::{n} succès', 'other::{n} succès'));
  if (a.dv !== null && a.dv !== undefined) bits.push(t('VD {dv}{type}', { dv: a.modifiedDv ?? a.dv, type: a.type }) + (a.ap ? ` · ${t('PA {ap}', { ap: signed(a.ap) })}` : ''));
  else if (a.noDamage) bits.push(t('sans dommages'));
  return bits.join(' · ');
}

function outcomeText(a) {
  if (a.status === 'cancelled') return t('annulée');
  if (a.status === 'missed') return a.defenseHits !== undefined ? t('esquivée ({a} contre {d})', { a: a.hits, d: a.defenseHits }) : t('ratée');
  if (a.status === 'done' && a.kind === 'toxin') {
    if (!a.left) return t('toxine entièrement résistée');
    const fx = (a.effects || []).map((k) => t(AFFLICTIONS[k]?.name || k));
    const dmg = a.damage ? (a.damageType === 'P' ? tn(a.damage, '{n} case physique', '{n} cases physiques') : tn(a.damage, '{n} case étourdissante', '{n} cases étourdissantes')) : '';
    return [dmg, ...fx].filter(Boolean).join(' · ');
  }
  if (a.status === 'done') {
    if (a.noDamage || a.dv === null) return tn(a.net || 0, 'réussie : {n} succès net', 'réussie : {n} succès nets');
    if (!a.damage) return t('tout encaissé');
    return a.damageType === 'S' ? tn(a.damage, '{n} case étourdissante', '{n} cases étourdissantes') : tn(a.damage, '{n} case physique', '{n} cases physiques');
  }
  return '';
}

export default function AttackTray({ game }) {
  const [dialog, setDialog] = useState(null); // { kind: 'defend'|'soak', attackId }
  const [hidden, setHidden] = useState(() => new Set());
  const [userCollapsed, setCollapsed] = useState(null); // null = automatic: folded while nothing waits for me
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const gm = game.me?.role === 'gm';
  const mine = new Set(game.me?.characterIds || []);
  const list = game.attacks?.list || [];
  const now = Date.now();
  const rows = useMemo(() => list.filter((a) => {
    if (hidden.has(a.id)) return false;
    const involved = gm || mine.has(a.targetId) || mine.has(a.attackerId);
    if (!involved) return false;
    if (PENDING.has(a.status)) return true;
    return a.resolvedTs && now - a.resolvedTs < RECENT_MS;
  }), [list, hidden, gm, game.me, now]);
  const open = dialog ? list.find((a) => a.id === dialog.attackId) : null;
  if (!rows.length && !open) return null;
  const hide = (id) => setHidden(new Set([...hidden, id]));
  const toAct = rows.filter((a) => PENDING.has(a.status) && ownsActorId(game, a.targetId));
  const pendingCount = toAct.length;
  const collapsed = userCollapsed ?? !pendingCount;

  return html`<div class="atk-tray">
    <div class="atk-tray-head">
      <span>⚔ ${t('Attaques')}${pendingCount ? html` <span class="badge badge-red">${pendingCount}</span>` : null}</span>
      <span class="row gap-s">
        ${gm && html`<${Button} small variant="ghost" onClick=${() => send('attack/clear', {}).catch(() => {})} title=${t('Effacer les attaques résolues et les souffles de la carte')}>${t('Nettoyer')}</${Button}>`}
        <${IconButton} icon=${collapsed ? '▴' : '▾'} title=${collapsed ? t('Déplier') : t('Replier')} onClick=${() => setCollapsed(!collapsed)} />
      </span>
    </div>
    ${!collapsed && html`<div class="atk-tray-list">${rows.map((a) => {
      const canAct = PENDING.has(a.status) && ownsActorId(game, a.targetId);
      const isMineAtk = mine.has(a.attackerId) || gm;
      const target = a.targetName;
      return html`<div class=${'atk-card ' + a.status + (canAct ? ' act' : '')} key=${a.id}>
        <div class="atk-card-title">
          <b>${a.attackerName}</b> <span class="faint">→</span> <b class="link" onClick=${() => game.actors?.[a.targetId]?.attributes && openSheet(a.targetId)}>${target}</b>
          ${!PENDING.has(a.status) && html`<${IconButton} icon="✕" class="atk-x" title=${t('Masquer')} onClick=${() => hide(a.id)} />`}
        </div>
        <div class="small muted">${attackSummary(a)}</div>
        ${PENDING.has(a.status)
          ? html`<div class="row wrap gap-s atk-card-actions">
              ${canAct && a.status === 'defense' && html`<${Button} small variant="primary" onClick=${() => setDialog({ kind: 'defend', attackId: a.id })}>🛡 ${t('Se défendre')}</${Button}>`}
              ${canAct && a.status === 'soak' && html`<${Button} small variant="primary" onClick=${() => setDialog({ kind: 'soak', attackId: a.id })}>✚ ${a.kind === 'toxin' ? t('Résister au gaz') : t('Encaisser')}</${Button}>`}
              ${!canAct && html`<span class="faint small">${a.status === 'defense' ? t('en attente de la défense…') : t('en attente de l’encaissement…')}</span>`}
              ${gm && html`<${Button} small variant="ghost" onClick=${() => send('attack/auto', { attackId: a.id }).catch(() => {})} title=${t('Lancer défense puis encaissement sans option')}>⚡ ${t('Auto')}</${Button}>`}
              ${gm && html`<${Button} small variant="ghost" onClick=${async () => {
                const v = await promptText(t('Dommages à appliquer (ex. 6P, 4S, 0 = raté)'), a.modifiedDv ? `${a.modifiedDv}${a.type}` : '');
                if (v === null || v === undefined) return;
                const m = String(v).trim().match(/^(\d+)\s*([PSps])?$/);
                if (!m) return;
                const n = Number(m[1]);
                send('attack/resolve', n ? { attackId: a.id, outcome: 'damage', amount: n, type: (m[2] || a.type || 'P').toUpperCase() } : { attackId: a.id, outcome: 'missed' }).catch(() => {});
              }} title=${t('Résoudre à la main')}>✎</${Button}>`}
              ${isMineAtk && html`<${Button} small variant="ghost" onClick=${() => send('attack/cancel', { attackId: a.id }).catch(() => {})} title=${t('Annuler cette attaque')}>${t('Annuler')}</${Button}>`}
            </div>`
          : html`<div class=${'atk-outcome ' + (a.status === 'done' && a.damage ? 'hit' : '')}>${outcomeText(a)}</div>`}
      </div>`;
    })}</div>`}
    ${open && dialog.kind === 'defend' && open.status === 'defense' && html`<${DefenseDialog} game=${game} atk=${open} onClose=${() => setDialog(null)} />`}
    ${open && (dialog.kind === 'soak' || (dialog.kind === 'defend' && open.status !== 'defense')) && html`<${ResultOrSoak} game=${game} atk=${open} dialog=${dialog} onClose=${() => setDialog(null)} />`}
  </div>`;
}

/** After a defense: the result, then the soak dialog when the attack hit. */
function ResultOrSoak({ game, atk, dialog, onClose }) {
  if (atk.status === 'soak') return html`<${SoakDialog} game=${game} atk=${atk} onClose=${onClose} />`;
  return html`<${Overlay} title=${t('Résultat — {target}', { target: atk.targetName })} onClose=${onClose} width=${420}>
    <div class="col gap-s">
      <div class="atk-big ${atk.status === 'done' && atk.damage ? 'hit' : ''}">${outcomeText(atk)}</div>
      <div class="muted small">${attackSummary(atk)}</div>
      <div class="row spread"><span></span><${Button} variant="primary" onClick=${onClose}>${t('Fermer')}</${Button}></div>
    </div>
  </${Overlay}>`;
}

/** Defense test: REA + INT, active defense (one), turn-long defenses, situation, previous defenses this turn, Edge. */
export function DefenseDialog({ game, atk, onClose }) {
  const actor = game.actors?.[atk.targetId];
  const gm = game.me?.role === 'gm';
  const turn = turnInfo(game, atk.targetId);
  const [options, setOptions] = useState(() => new Set());
  const [situations, setSituations] = useState(() => new Set());
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!actor?.attributes) {
    return html`<${Overlay} title=${t('Défense')} onClose=${onClose} width=${420}><div class="muted">${t('Fiche de la cible indisponible.')}</div></${Overlay}>`;
  }
  const names = unlockNames(actor);
  const melee = atk.kind === 'melee';
  const plan = defenseLines(actor, atk, { options: [...options], situations: [...situations], prior: turn.defended, turnBoosts: turn.boosts });
  let wound = 0;
  try {
    wound = derive(actor).woundModifier || 0;
  } catch {}
  const edgeMax = attr(actor, 'EDG');
  const base = attr(actor, 'REA') + attr(actor, 'INT');
  const total = Math.max(0, base + plan.lines.reduce((s, l) => s + l.value, 0) + modifier + wound + (explode ? edgeMax : 0));
  const toggle = (set, setter, id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else {
      // one active defense at a time
      const o = DEFENSE_OPTIONS.find((x) => x.id === id);
      if (o && !o.turn) for (const x of DEFENSE_OPTIONS) if (!x.turn) next.delete(x.id);
      next.add(id);
    }
    setter(next);
  };
  const go = async () => {
    setBusy(true);
    try {
      const r = await send('attack/defend', { attackId: atk.id, options: [...options], situations: [...situations], modifier, explode });
      setResult(r);
    } catch {} finally {
      setBusy(false);
    }
  };
  const visibleOptions = DEFENSE_OPTIONS.filter((o) => (!o.melee || melee) && (isUnlocked(o, actor, names) || gm));
  return html`<${Overlay} title=${t('Défense — {name}', { name: actor.name })} onClose=${onClose} width=${500}>
    <div class="col gap-s atk-dlg">
      <div class="atk-dlg-attack"><b>${atk.attackerName}</b> · ${attackSummary(atk)}</div>
      ${!result && html`
        <div class="field-label">${t('Défense active (interruption)')}</div>
        <div class="col gap-s">
          ${visibleOptions.map((o) => {
            const paid = o.turn && turn.boosts.includes(o.id);
            const locked = !isUnlocked(o, actor, names);
            return html`<label class=${'atk-opt' + (locked ? ' locked' : '')} key=${o.id}>
              <input type="checkbox" checked=${options.has(o.id) || paid} disabled=${paid || locked} onChange=${() => toggle(options, setOptions, o.id)} />
              <span class="grow">${t(o.name)} <${BookRef} source=${o.source} page=${o.page} /></span>
              <span class="faint small">${paid ? t('actif ce tour') : t('−{n} init.', { n: o.ini })}${o.turn ? ` · ${t('tout le tour')}` : ''}${locked ? ` · ${t('non débloqué')}` : ''}</span>
            </label>`;
          })}
        </div>
        <div class="field-label">${t('Situation')}</div>
        <div class="row wrap gap-s">
          ${DEFENSE_SITUATIONS.filter((s) => !(s.ranged && melee)).map((s) => html`<button key=${s.id} class=${'chip' + (situations.has(s.id) ? ' on' : '')} onClick=${() => toggle(situations, setSituations, s.id)}>${t(s.name)} ${signed(s.value)}</button>`)}
        </div>
        <div class="sh-rd-breakdown">
          <span class="sh-rd-part"><span>${t('RÉA + INT')}</span><b>${base}</b></span>
          ${plan.lines.map((l) => html`<span class=${'sh-rd-part' + (l.value < 0 ? ' bad' : '')} key=${l.key}><span>${t(l.label)}</span><b>${signed(l.value)}</b></span>`)}
          ${wound ? html`<span class="sh-rd-part bad"><span>${t('blessures')}</span><b>${wound}</b></span>` : null}
          ${modifier ? html`<span class="sh-rd-part"><span>${t('mod.')}</span><b>${signed(modifier)}</b></span>` : null}
          ${explode ? html`<span class="sh-rd-part edge"><span>${t('Chance')}</span><b>+${edgeMax}</b></span>` : null}
          <span class="sh-rd-total">${tn(total, '= {n} dé', '= {n} dés')}</span>
        </div>
        <div class="faint small">${t('Les modificateurs d’équipement et de qualités sont ajoutés par le serveur.')}${plan.ini ? ' ' + t('Coût : {n} d’initiative.', { n: plan.ini }) : ''}</div>
        <div class="row wrap gap-s">
          <div class="field"><span class="field-label">${t('Modificateur')}</span><${NumberInput} value=${modifier} min=${-20} max=${20} onChange=${setModifier} small /></div>
          ${(actor.edge?.current ?? 0) > 0 && html`<${Toggle} value=${explode} onChange=${setExplode} label=${t('Repousser les limites (+{n}) — Chance {left}', { n: edgeMax, left: actor.edge.current })} />`}
        </div>
        <div class="row spread">
          <${Button} variant="ghost" onClick=${onClose}>${t('Plus tard')}</${Button}>
          <${Button} variant="primary" disabled=${busy} onClick=${go}>🛡 ${tn(total, 'Défendre ({n} dé)', 'Défendre ({n} dés)')}</${Button}>
        </div>`}
      ${result && html`<div class="sh-rd-result">
          <div class="sh-rd-hits"><b>${result.roll.hits}</b><span>${tn(result.roll.hits, 'one::succès', 'other::succès')}</span></div>
          <div class="grow col gap-s"><${DiceFaces} roll=${result.roll} /><${RollBadges} roll=${result.roll} /></div>
        </div>
        <div class="atk-big ${result.attack.status === 'soak' ? 'hit' : ''}">${result.attack.status === 'soak'
          ? t('Touché : {net} succès net(s) → VD {dv}{type}', { net: result.attack.net, dv: result.attack.modifiedDv, type: result.attack.type })
          : outcomeText(result.attack)}</div>
        <div class="row spread"><span></span>${result.attack.status === 'soak'
          ? html`<span class="faint small">${t('Encaissement à suivre…')}</span>`
          : html`<${Button} variant="primary" onClick=${onClose}>${t('Fermer')}</${Button}>`}</div>`}
    </div>
  </${Overlay}>`;
}

/** Damage resistance: BOD + armor modified by AP, Edge; the damage is applied by the server. */
/** Toxin Resistance Test (BOD + WIL) against a gas grenade: Power − hits = damage and effects (shared/combat.js toxinOutcome). */
function ToxinDialog({ actor, atk, onClose }) {
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const toxin = TOXIN_BY_ID[atk.toxinId];
  const edgeMax = attr(actor, 'EDG');
  const total = Math.max(0, attr(actor, 'BOD') + attr(actor, 'WIL') + modifier + (explode ? edgeMax : 0));
  const go = async () => {
    setBusy(true);
    try {
      setResult(await send('attack/soak', { attackId: atk.id, modifier, explode }));
    } catch {} finally {
      setBusy(false);
    }
  };
  const a = result?.attack || atk;
  const fx = (toxin?.effects || []).map((k) => ({ disorientation: t('désorientation (−2 dés)'), nausea: t('nausée (malus de blessures ×2, incapable d’agir si Puissance restante > VOL)'), stun: t('dommages étourdissants'), physical: t('dommages physiques') })[k]);
  return html`<${Overlay} title=${t('Résister aux toxines — {name}', { name: actor.name })} onClose=${onClose} width=${460}>
    <div class="col gap-s atk-dlg">
      <div class="atk-dlg-attack"><b>${atk.attackerName}</b> · ${attackSummary(atk)} <${BookRef} source="SR5" page=${toxin?.page || 409} /></div>
      <div class="atk-big hit">${t('Puissance {n}', { n: atk.dv })}</div>
      <div class="small muted">${t('Chaque succès réduit la Puissance ; ce qui reste : {fx}.', { fx: fx.join(', ') })}</div>
      ${!result && html`
        <div class="sh-rd-breakdown">
          <span class="sh-rd-part"><span>${t('CON')}</span><b>${attr(actor, 'BOD')}</b></span>
          <span class="sh-rd-part"><span>${t('VOL')}</span><b>+${attr(actor, 'WIL')}</b></span>
          ${modifier ? html`<span class="sh-rd-part"><span>${t('mod.')}</span><b>${signed(modifier)}</b></span>` : null}
          ${explode ? html`<span class="sh-rd-part edge"><span>${t('Chance')}</span><b>+${edgeMax}</b></span>` : null}
          <span class="sh-rd-total">${tn(total, '= {n} dé', '= {n} dés')}</span>
        </div>
        <div class="row wrap gap-s">
          <div class="field"><span class="field-label">${t('Modificateur')}</span><${NumberInput} value=${modifier} min=${-20} max=${20} onChange=${setModifier} small /></div>
          ${(actor.edge?.current ?? 0) > 0 && html`<${Toggle} value=${explode} onChange=${setExplode} label=${t('Repousser les limites (+{n}) — Chance {left}', { n: edgeMax, left: actor.edge.current })} />`}
        </div>
        <div class="row spread">
          <${Button} variant="ghost" onClick=${onClose}>${t('Plus tard')}</${Button}>
          <${Button} variant="primary" disabled=${busy} onClick=${go}>✚ ${tn(total, 'Résister ({n} dé)', 'Résister ({n} dés)')}</${Button}>
        </div>`}
      ${result && html`<div class="sh-rd-result">
          <div class="sh-rd-hits"><b>${result.roll.hits}</b><span>${tn(result.roll.hits, 'one::succès', 'other::succès')}</span></div>
          <div class="grow col gap-s"><${DiceFaces} roll=${result.roll} /><${RollBadges} roll=${result.roll} /></div>
        </div>
        <div class=${'atk-big' + (a.left ? ' hit' : '')}>${outcomeText(a)}</div>
        <div class="row spread"><span></span><${Button} variant="primary" onClick=${onClose}>${t('Fermer')}</${Button}></div>`}
    </div>
  </${Overlay}>`;
}

export function SoakDialog({ game, atk, onClose }) {
  const actor = game.actors?.[atk.targetId];
  const mods = useModifiers(actor?.attributes ? actor : null, {});
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!actor?.attributes) return html`<${Overlay} title=${t('Encaissement')} onClose=${onClose} width=${420}><div class="muted">${t('Fiche de la cible indisponible.')}</div></${Overlay}>`;
  if (atk.kind === 'toxin') return html`<${ToxinDialog} actor=${actor} atk=${atk} onClose=${onClose} />`;
  let armor = 0;
  try {
    armor = derivedWithModifiers(actor, mods).armor || 0;
  } catch {}
  const ap = Number(atk.ap) || 0;
  const modArmor = Math.max(0, armor + ap);
  const dv = atk.modifiedDv ?? atk.dv ?? 0;
  const edgeMax = attr(actor, 'EDG');
  const total = Math.max(0, attr(actor, 'BOD') + modArmor + modifier + (explode ? edgeMax : 0));
  const type = finalDamageType(atk.type, dv, modArmor);
  const go = async () => {
    setBusy(true);
    try {
      setResult(await send('attack/soak', { attackId: atk.id, modifier, explode }));
    } catch {} finally {
      setBusy(false);
    }
  };
  const a = result?.attack || atk;
  return html`<${Overlay} title=${t('Encaissement — {name}', { name: actor.name })} onClose=${onClose} width=${460}>
    <div class="col gap-s atk-dlg">
      <div class="atk-dlg-attack"><b>${atk.attackerName}</b> · ${attackSummary(atk)}</div>
      <div class="atk-big hit">${t('VD {dv}{type} à encaisser', { dv, type: atk.type })}${type !== atk.type ? html` <span class="small muted">(${t('étourdissants : VD < armure modifiée')})</span>` : null}</div>
      ${!result && html`
        <div class="sh-rd-breakdown">
          <span class="sh-rd-part"><span>${t('CON')}</span><b>${attr(actor, 'BOD')}</b></span>
          <span class="sh-rd-part"><span>${t('armure')}</span><b>+${armor}</b></span>
          ${ap ? html`<span class=${'sh-rd-part' + (ap < 0 ? ' bad' : '')}><span>${t('PA')}</span><b>${signed(Math.max(ap, -armor))}</b></span>` : null}
          ${modifier ? html`<span class="sh-rd-part"><span>${t('mod.')}</span><b>${signed(modifier)}</b></span>` : null}
          ${explode ? html`<span class="sh-rd-part edge"><span>${t('Chance')}</span><b>+${edgeMax}</b></span>` : null}
          <span class="sh-rd-total">${tn(total, '= {n} dé', '= {n} dés')}</span>
        </div>
        <div class="row wrap gap-s">
          <div class="field"><span class="field-label">${t('Modificateur')}</span><${NumberInput} value=${modifier} min=${-20} max=${20} onChange=${setModifier} small /></div>
          ${(actor.edge?.current ?? 0) > 0 && html`<${Toggle} value=${explode} onChange=${setExplode} label=${t('Repousser les limites (+{n}) — Chance {left}', { n: edgeMax, left: actor.edge.current })} />`}
        </div>
        <div class="row spread">
          <${Button} variant="ghost" onClick=${onClose}>${t('Plus tard')}</${Button}>
          <${Button} variant="primary" disabled=${busy} onClick=${go}>✚ ${tn(total, 'Encaisser ({n} dé)', 'Encaisser ({n} dés)')}</${Button}>
        </div>`}
      ${result && html`<div class="sh-rd-result">
          <div class="sh-rd-hits"><b>${result.roll.hits}</b><span>${tn(result.roll.hits, 'one::succès', 'other::succès')}</span></div>
          <div class="grow col gap-s"><${DiceFaces} roll=${result.roll} /><${RollBadges} roll=${result.roll} /></div>
        </div>
        <div class=${'atk-big' + (a.damage ? ' hit' : '')}>${outcomeText(a)}</div>
        <div class="row spread"><span></span><${Button} variant="primary" onClick=${onClose}>${t('Fermer')}</${Button}></div>`}
    </div>
  </${Overlay}>`;
}
