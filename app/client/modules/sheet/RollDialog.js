// Roll dialog: pool breakdown, modifiers of the actor's gear / qualities / powers / implants (shared/modifiers.js, with their
// 📖 reference and the situational switches « Tenue visible »…), wounds, limit, Push the Limit (Chance), GM secret → 'dice/roll'.
// The server recomputes everything (authority); the client only sends the switches turned on (conditions) and the bonuses left out (ignore).
// Usable by any module: <RollDialog game actor preset onClose /> where preset =
//   { label?, skillId?, attr?, attr2?, pool?, limit? (number|null: fixed by the caller), bonus?: [{label, value}], applyWounds? (default true),
//     test? ('composure'|'judgeIntentions'|'memory'|'liftCarry'|'defense'|'soak'|'drainResist'|'biofeedback'|'toxinResist': attribute tests with
//     modifiers of their own or without wound modifier — kept only on their own attributes, shared/modifiers.js checkedTest),
//     weaponId? (attack: limit = Accuracy + accessories, accessory dice), matrixLimit? ('attack'|'sleaze'|'dataProcessing'|'firewall') }
import { useMemo, useState } from 'preact/hooks';
import { html, Button, NumberInput, Toggle } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { attr, skillPool, SKILL_BY_ID, ATTR_LABELS, skillDefaultLimit } from '/shared/sr5.js';
import { poolModifiers, limitFor, rollContext, weaponAccuracy, derivedWithModifiers, checkedTest, woundsApply, TEST_BY_LABEL, ROLL_TESTS, MATRIX_LIMIT_SKILLS } from '/shared/modifiers.js';
import { t, tk, tn, tIfKnown, attrShort, attrLabel, limitLabel } from '../../lib/i18n.js';
import { Overlay, DiceFaces, RollBadges, isGM, ownsActor, skillName, rollLabel } from './common.js';
import { knowledgeAttr } from './sheet-data.js';
import { BookRef, SkillRef, RuleRef } from '../books/BookRef.js';
import { ruleRef } from '/shared/bookrefs.js';
import { useModifiers, ModChip, effectText, toggleText, sourceName, loadRollToggles as loadToggles, saveRollToggles as saveToggles } from './modifiers-ui.js';
import { Select } from '../../lib/ui.js';
import { itemLabel } from './common.js';
import { usesAmmo, isGrenade, fireOptions, isUnarmed } from './inventory.js';
import { ReloadDialog, fireSelectOptions, ammoKindLabel, actionLabel } from './weapon-ui.js';
import { useUI, setUI } from '../../lib/ui-store.js';
import { actionsForWeapon, ACTION_BY_ID, isAreaWeapon, rangeFor, rangeClass, blastOf, blastReach, cellDistance, isUnlocked, RANGE_BANDS, environmentFor, attackSenses, activeBlasts, areaEffectOf, TOXINS, toxinFromText } from '/shared/combat.js';
import { createVisionContext, tokenVision } from '/shared/vision.js';
import { targetCandidates, attackMap, tokenOfActor, turnInfo } from '../combat/attack-common.js';
import { isLauncherProfile, launcherRounds } from './inventory.js';

const MATRIX_LIMIT_LABELS = { attack: tk('Attaque'), sleaze: tk('Corruption'), dataProcessing: tk('Traitement'), firewall: tk('Firewall') };

/** Client-side preview of the server pool computation (the server stays authoritative). Part labels are display text. */
export function previewPool(actor, preset, { useSpec } = {}) {
  const parts = [];
  let pool = 0;
  let defaultLimit = null;
  let spec = '';
  let impossible = false;
  if (actor && preset.skillId) {
    const sk = (actor.skills || []).find((s) => s.id === preset.skillId || s.name === preset.skillId);
    const kno = !sk && (actor.knowledge || []).find((k) => k.id === preset.skillId);
    if (kno) {
      const at = preset.attr || knowledgeAttr(kno.type);
      pool = (Number(kno.rating) || 0) + attr(actor, at);
      parts.push([kno.name, kno.rating || 0], [attrShort(at), attr(actor, at)]);
      spec = kno.spec || '';
      if (useSpec && kno.spec) {
        pool += 2;
        parts.push([t('spé. {spec}', { spec: kno.spec }), 2]);
      }
      defaultLimit = 'mental';
    } else {
      const def = SKILL_BY_ID[preset.skillId];
      const at = preset.attr || sk?.attr || def?.attr || 'AGI';
      const r = skillPool(actor, preset.skillId, { useSpec, attrOverride: preset.attr || undefined });
      impossible = !!r.impossible;
      pool = r.pool;
      spec = sk?.spec || '';
      if (r.defaulting) parts.push([attrShort(at), attr(actor, at)], [t('par défaut'), -1]);
      else {
        parts.push([skillName(sk, preset.skillId), sk.rating], [attrShort(at), attr(actor, at)]);
        if (useSpec && sk.spec) parts.push([t('spé. {spec}', { spec: sk.spec }), 2]);
      }
      defaultLimit = skillDefaultLimit(def, at);
    }
  } else if (actor && preset.attr) {
    pool = attr(actor, preset.attr);
    parts.push([attrShort(preset.attr), pool]);
    if (preset.attr2) {
      pool += attr(actor, preset.attr2);
      parts.push([attrShort(preset.attr2), attr(actor, preset.attr2)]);
    }
  } else {
    pool = Math.max(0, Number(preset.pool) || 0);
    parts.push([t('dés'), pool]);
  }
  for (const b of preset.bonus || []) {
    if (!b.value) continue;
    pool += b.value;
    parts.push([tIfKnown(b.label), b.value]);
  }
  return { pool, parts, defaultLimit, spec, impossible };
}

/** Label sent to the server and stored in the log: French source text (each viewer translates it). */
export function presetLabel(actor, preset) {
  if (preset.label) return preset.label;
  if (preset.skillId) {
    const sk = (actor?.skills || []).find((s) => s.id === preset.skillId);
    const kno = (actor?.knowledge || []).find((k) => k.id === preset.skillId);
    return sk?.name || kno?.name || SKILL_BY_ID[preset.skillId]?.fr || preset.skillId;
  }
  if (preset.attr) return preset.attr2 ? `${ATTR_LABELS[preset.attr]} + ${ATTR_LABELS[preset.attr2]}` : ATTR_LABELS[preset.attr];
  return 'Jet de dés';
}

/** The same label in the UI language (a weapon attack names the weapon in the UI language too). */
export function presetDisplayLabel(actor, preset) {
  const w = preset.weaponId && /^Attaque — /.test(preset.label || '') ? (actor?.weapons || []).find((x) => x && x.id === preset.weaponId) : null;
  if (w) return t('Attaque — {weapon}', { weapon: itemLabel(w) });
  if (preset.label) return rollLabel(preset.label);
  if (preset.skillId) {
    const sk = (actor?.skills || []).find((s) => s.id === preset.skillId);
    const kno = (actor?.knowledge || []).find((k) => k.id === preset.skillId);
    if (sk || !kno) return skillName(sk, preset.skillId);
    return kno.name;
  }
  if (preset.attr) return preset.attr2 ? `${attrLabel(preset.attr)} + ${attrLabel(preset.attr2)}` : attrLabel(preset.attr);
  return t('Jet de dés');
}

/** Limit of the test: fixed by the caller, weapon Accuracy, device attribute, or the skill's limit — with its modifiers. */
function computeLimit(actor, preset, prev, mods, rctx, opts) {
  if (preset.limit !== undefined) return { total: preset.limit, lines: [], parts: [], fixed: true };
  if (!actor) return null;
  if (preset.weaponId) {
    const w = (actor.weapons || []).find((x) => x && x.id === preset.weaponId);
    if (!w) return null;
    const acc = weaponAccuracy(actor, w, mods, rctx, opts);
    return acc.total === null ? null : { total: acc.total, lines: acc.lines, parts: acc.parts.map(([l, v], i) => [i === 0 || l === 'accessoires' ? t(l) : l, v]) };
  }
  if (preset.matrixLimit && MATRIX_LIMIT_SKILLS.includes(rctx.skillId)) {
    const v = Number(actor.matrix?.[preset.matrixLimit]) || 0;
    return v > 0 ? { total: v, lines: [], parts: [[t(MATRIX_LIMIT_LABELS[preset.matrixLimit] || preset.matrixLimit), v]] } : null;
  }
  if (!prev.defaultLimit) return null;
  const l = limitFor(actor, prev.defaultLimit, mods, rctx, opts);
  if (l.total === null) return null;
  const parts = [[limitLabel(prev.defaultLimit), l.base], ...l.lines.filter((x) => x.state === 'applied').map((x) => [sourceName(x.mod.source), x.value])];
  return { total: l.total, lines: l.lines, parts, name: prev.defaultLimit };
}

export function RollDialog({ game, actor, preset: initialPreset = {}, onClose }) {
  const gm = isGM(game);
  const sheet = actor && !actor.status && actor.attributes ? actor : null;
  // Weapon attack: the weapon can be switched in the dialog (ready weapons, « afficher tout » for the stowed ones); its skill and label follow.
  const [weaponId, setWeaponId] = useState(initialPreset.weaponId || null);
  const [allWeapons, setAllWeapons] = useState(false);
  const weapon = weaponId && sheet ? (sheet.weapons || []).find((w) => w && w.id === weaponId) || null : null;
  const preset = weapon && weaponId !== initialPreset.weaponId
    ? { ...initialPreset, weaponId, skillId: weapon.skill || 'exotic_weapon', label: `Attaque — ${weapon.nameFr || weapon.name}` } // i18n-ignore: stored French label (rollLabel)
    : initialPreset;
  const [fireMode, setFireMode] = useState(null);
  const [ammoOverride, setAmmoOverride] = useState(false);
  // Target (map token), special action, launcher ammunition, aimed point — attacks module (attack/roll).
  const ui = useUI();
  const [actionId, setActionId] = useState(initialPreset.actionId || '');
  const action = actionId ? ACTION_BY_ID[actionId] || null : null;
  const canTarget = !!sheet && (!!initialPreset.weaponId || action?.kind === 'test');
  const candidates = canTarget ? targetCandidates(game, sheet.id, weapon, sheet) : [];
  const [targetId, setTargetId] = useState(() => {
    const want = initialPreset.targetTokenId ?? ui.targetTokenId;
    return want && candidates.some((c) => c.token.id === want) ? want : '';
  });
  const target = candidates.find((c) => c.token.id === targetId) || null;
  const amap = canTarget ? attackMap(game) : null;
  const myToken = amap && sheet ? tokenOfActor(amap, sheet.id) : null;
  const area = !!weapon && isAreaWeapon(weapon);
  const aim = area && ui.aimPoint && amap && ui.aimPoint.mapId === amap.id ? ui.aimPoint : null;
  const [useAim, setUseAim] = useState(true);
  const point = area ? (aim && useAim ? { x: aim.x, y: aim.y } : target ? { x: target.token.x, y: target.token.y } : null) : null;
  // Grenade launcher: the round fired (sheet profile, else catalog minigrenade; the loaded one first) gives DV / AP / blast.
  const rounds = weapon && sheet && rangeClass(weapon) === 'grenadeLauncher' && !isLauncherProfile(weapon) ? launcherRounds(sheet, weapon) : [];
  const [profileId, setProfileId] = useState(() => rounds[0]?.id || '');
  const round = rounds.find((r) => r.id === profileId) || rounds[0] || null;
  const profile = round?.w || null;
  const blast = area ? blastOf(profile || weapon, sheet) : null;
  const aimAt = point || (target ? { x: target.token.x, y: target.token.y } : null);
  const range = weapon && weapon.kind !== 'melee' && myToken && aimAt ? rangeFor(weapon, sheet, cellDistance(myToken, aimAt, Number(amap.metersPerCell) || 1)) : null;
  // Environmental modifier (SR5 p. 175, same computation as the server): range + light at the target + weather + smoke / flash-pak.
  const litRatio = useMemo(() => (amap && (amap.lighting || 'bright') !== 'bright' ? createVisionContext(amap).litRatio : null), [amap]);
  const env = weapon && weapon.kind !== 'melee' && myToken && aimAt
    ? environmentFor({
      map: amap, from: myToken, to: aimAt, meters: range?.meters ?? cellDistance(myToken, aimAt, Number(amap.metersPerCell) || 1),
      rangeIndex: range ? RANGE_BANDS.findIndex((b) => b.id === range.id) : null, litRatio,
      blasts: activeBlasts((game.attacks?.blasts || []).filter((b) => b.mapId === amap.id), game.combat, Date.now()),
      senses: attackSenses(sheet, tokenVision(myToken, sheet), weapon),
    })
    : null;
  // Gas grenade: the toxin it holds (named in the grenade, else chosen here; CS by default).
  const gas = area && areaEffectOf(profile || weapon) === 'gas';
  const [toxinId, setToxinId] = useState(() => toxinFromText(profile || weapon) || 'cs');
  const weaponActions = sheet && weapon ? actionsForWeapon(sheet, weapon, { allowLocked: gm, fireIds: usesAmmo(weapon) ? fireOptions(weapon).map((o) => o.id) : [] }) : [];
  const turn = sheet ? turnInfo(game, sheet.id) : null;
  const usedOnce = !!(action?.once && turn?.once?.includes(action.id));
  const pickAction = (id) => {
    setActionId(id);
    const a = id ? ACTION_BY_ID[id] : null;
    if (a?.fire) setFireMode(a.fire);
  };
  const [reloading, setReloading] = useState(false);
  const fireOpts = weapon && usesAmmo(weapon) ? fireOptions(weapon) : [];
  const fire = fireOpts.find((o) => o.id === (action?.fire || fireMode)) || fireOpts[0] || null;
  const loaded = weapon && usesAmmo(weapon) ? Number(weapon.ammoLoaded ?? weapon.ammoMax) || 0 : 0;
  const grenadeLeft = weapon && isGrenade(weapon) ? Number(weapon.qty ?? 1) : null;
  // SR5 p. 180: fewer rounds than the mode fires what is left (defense modifier −1 smaller per missing round); only an empty weapon is blocked.
  const outOfAmmo = (fire && loaded < 1) || (grenadeLeft !== null && grenadeLeft <= 0);
  const short = fire && loaded > 0 && loaded < fire.rounds ? fire.rounds - loaded : 0;
  const shownDefense = fire && fire.defense ? Math.min(0, fire.defense + short) : 0;
  const blockedByAmmo = outOfAmmo && !(gm && ammoOverride);
  const mods = useModifiers(sheet, { weaponId: preset.weaponId });
  const dm = useMemo(() => (sheet ? derivedWithModifiers(sheet, mods) : null), [sheet, mods]);
  // Same rules as the server: a test key only on its own attributes; the wound modifier on every test but damage resistance
  // (players cannot leave it out); the Matrix situation from the persona.
  const claimed = ROLL_TESTS.includes(preset.test) ? preset.test : !preset.skillId && preset.attr ? TEST_BY_LABEL[preset.label] || null : null;
  const test = checkedTest(claimed, { skillId: preset.skillId, weaponId: preset.weaponId, attr: preset.attr, attr2: preset.attr2 });
  const statRoll = !!(preset.skillId || preset.attr || preset.weaponId);
  const persona = sheet ? game.matrix?.personas?.[sheet.id] : null;
  const personaRules = !!sheet && (!!persona || !gm);
  // 📖 rule of an attribute-only test (defense, soak, composure…); a skill test shows its skill's page.
  const testRef = test ? ruleRef(TEST_RULES[test]) : null;
  const [useSpec, setUseSpec] = useState(!!preset.useSpec);
  const [modifier, setModifier] = useState(0);
  const [gmWounds, setWounds] = useState(preset.applyWounds !== false && woundsApply(test) && !!dm && dm.woundModifier < 0);
  const wounds = gm ? gmWounds : statRoll && woundsApply(test) && !!dm && dm.woundModifier < 0;
  const [toggles, setToggles] = useState(() => new Set(actor ? loadToggles(actor.id) : []));
  const [ignored, setIgnored] = useState(() => new Set());
  const prev = previewPool(actor, preset, { useSpec });
  const rctx = sheet ? rollContext(sheet, { skillId: preset.skillId, attr: preset.attr, attr2: preset.attr2, test, weaponId: preset.weaponId }) : {};
  let conds = [...toggles];
  if (personaRules) {
    rctx.mode = persona?.online ? persona.mode || 'ar' : 'offline';
    conds = conds.filter((k) => !PERSONA_SWITCHES.includes(k));
    if (persona?.online && persona.hostId) conds.push('in-host');
  }
  const opts = { conditions: conds, ignore: [...ignored], isGM: gm };
  const pm = sheet ? poolModifiers(mods, rctx, opts) : { lines: [], total: 0 };
  const lim = computeLimit(sheet, preset, prev, mods, rctx, opts);
  const autoLimit = lim ? (lim.fixed || lim.total === null ? lim.total : Math.max(1, lim.total)) : null; // server: a computed limit is ≥ 1
  const [wantNoLimit, setNoLimit] = useState(autoLimit === null || autoLimit === undefined);
  // Players cannot remove a computed limit (the server keeps it); a fixed or absent one is theirs to set.
  const canRemoveLimit = gm || autoLimit === null || autoLimit === undefined || !!lim?.fixed;
  const noLimit = wantNoLimit && canRemoveLimit;
  const [manualLimit, setManualLimit] = useState(null);
  const limit = manualLimit ?? autoLimit ?? 1;
  const [explode, setExplode] = useState(false);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const live = actor ? game.actors[actor.id] || actor : null;
  const edgeLeft = live?.edge?.current ?? 0;
  const edgeMax = live && live.attributes ? attr(live, 'EDG') : 0;
  const woundMod = wounds && dm ? dm.woundModifier : 0;
  const soakArmor = test === 'soak' && dm ? dm.armor : 0;
  const extraParts = [];
  if (env && !env.rangeOnly) {
    if (env.value) extraParts.push([t('environnement'), env.value]);
  } else if (range?.mod) extraParts.push([`${t(range.label)} (${range.meters} m)`, range.mod]);
  if (action?.dice) extraParts.push([t(action.name), action.dice]);
  const extra = extraParts.reduce((n, [, v]) => n + v, 0);
  const total = Math.max(0, prev.pool + pm.total + soakArmor + modifier + woundMod + extra + (explode ? edgeMax : 0));
  const label = presetLabel(actor, preset);
  const shownLabel = presetDisplayLabel(actor, preset);
  const canEdge = !!live && ownsActor(game, live.id) && edgeLeft > 0 && !!live.attributes;
  const edgeNeeded = (action?.edge || 0) + (explode ? 1 : 0);
  const edgeShort = edgeNeeded > 0 && edgeLeft < edgeNeeded;
  const attackRoll = canTarget && (!!targetId || !!point || !!actionId);

  // Modifier lines of this test (dice pool + limit) and the switches that would change something.
  const lines = [...pm.lines.map((l) => ({ ...l, kind: 'pool' })), ...(lim?.lines || []).map((l) => ({ ...l, kind: 'limit' }))];
  const switches = {};
  for (const l of lines) if (!l.mod.baked && !l.mod.info && l.value !== null) for (const k of l.toggles || []) if (!personaRules || !PERSONA_SWITCHES.includes(k)) (switches[k] ||= []).push(l);
  const setToggle = (k, on) => {
    const next = new Set(toggles);
    if (on) next.add(k);
    else next.delete(k);
    setToggles(next);
    if (actor) saveToggles(actor.id, [...next]);
  };
  const setIgnore = (id, off) => {
    const next = new Set(ignored);
    if (off) next.add(id);
    else next.delete(id);
    setIgnored(next);
  };

  const roll = async () => {
    setBusy(true);
    try {
      const payload = {
        label, actorId: actor?.id, skillId: preset.skillId, attr: preset.attr, attr2: preset.attr2, useSpec,
        modifier, applyWounds: wounds, explode, secret: gm && secret, bonus: preset.bonus,
        ...(test ? { test } : {}), ...(preset.weaponId ? { weaponId: preset.weaponId } : {}), ...(preset.matrixLimit ? { matrixLimit: preset.matrixLimit } : {}),
        ...(fire ? { fireMode: fire.id } : {}), ...(gm && ammoOverride && outOfAmmo ? { ammoOverride: true } : {}),
        conditions: [...toggles], ignore: [...ignored],
      };
      // Limit: none, a value typed in the dialog, the caller's fixed value — otherwise the server computes it (the value shown).
      if (explode || noLimit) payload.limit = null;
      else if (manualLimit !== null) payload.limit = manualLimit;
      else if (preset.limit !== undefined && preset.limit !== null) payload.limit = preset.limit;
      else if (autoLimit === null || autoLimit === undefined) payload.limit = limit; // a limit turned on without a computed one: the value shown
      if (!preset.skillId && !preset.attr) payload.pool = prev.pool;
      if (attackRoll) {
        if (point && area && aim && useAim) payload.point = point;
        else if (targetId) payload.targetTokenId = targetId;
        if (actionId) payload.actionId = actionId;
        if (round) payload.profileId = round.id;
        if (gas) payload.toxinId = toxinId;
        if (gm && amap) payload.mapId = amap.id;
      }
      const r = await send(attackRoll ? 'attack/roll' : 'dice/roll', payload);
      setResult(r);
      if (r?.blast) setUI({ aimPoint: null }); // the grenade is gone: the blast marker replaces the aimed point
      if (explode) setExplode(false);
    } catch {
      /* toast already shown */
    } finally {
      setBusy(false);
    }
  };
  const secondChance = async () => {
    try {
      const r = await send('dice/secondChance', { logId: result.logId });
      setResult({ ...result, ...r });
    } catch {}
  };

  return html`<${Overlay} title=${t('Jet — {label}', { label: shownLabel })} onClose=${onClose} width=${480}>
    <div class="sh-rd">
      ${(actor || preset.skillId || testRef) && html`<div class="row wrap gap-s muted small">${actor ? html`<span>${actor.name}</span>` : null}
        ${preset.skillId ? html`<${SkillRef} id=${preset.skillId} />` : null}${testRef ? html`<${BookRef} source=${testRef.source} page=${testRef.page} />` : null}</div>`}
      <div class="sh-rd-breakdown">
        ${prev.parts.map(([l, v], i) => html`<span class=${'sh-rd-part' + (v < 0 ? ' bad' : '')}><span>${l}</span><b>${i > 0 && v >= 0 ? '+' : ''}${v}</b></span>`)}
        ${soakArmor ? html`<span class="sh-rd-part"><span>${t('armure')}</span><b>+${soakArmor}</b></span>` : null}
        ${pm.lines.filter((l) => l.state === 'applied').map((l) => html`<span class=${'sh-rd-part mod' + (l.value < 0 ? ' bad' : '')} key=${l.mod.id} title=${effectText(l.mod)}><span>${sourceName(l.mod.source)}</span><b>${l.value >= 0 ? '+' : ''}${l.value}</b></span>`)}
        ${extraParts.map(([l, v]) => html`<span class=${'sh-rd-part mod' + (v < 0 ? ' bad' : '')} key=${l}><span>${l}</span><b>${v >= 0 ? '+' : ''}${v}</b></span>`)}
        ${modifier ? html`<span class="sh-rd-part"><span>${t('mod.')}</span><b>${modifier > 0 ? '+' : ''}${modifier}</b></span>` : null}
        ${woundMod ? html`<span class="sh-rd-part bad"><span>${t('blessures')}</span><b>${woundMod}</b></span>` : null}
        ${explode ? html`<span class="sh-rd-part edge"><span>${t('Chance')}</span><b>+${edgeMax}</b></span>` : null}
        <span class="sh-rd-total">${tn(total, '= {n} dé', '= {n} dés')}</span>
      </div>
      ${prev.impossible && !(result && !weapon) && html`<div class="error small">${t('Compétence non maîtrisée : impossible de l’utiliser par défaut.')}</div>`}
      ${initialPreset.weaponId && sheet && html`<div class="col gap-s sh-rd-weapon">
        <div class="row wrap gap-s">
          <${Select} value=${weaponId || ''} onChange=${(v) => { setWeaponId(v); setFireMode(null); setAmmoOverride(false); }}
            options=${(sheet.weapons || []).filter((w) => w.id === weaponId || (!isLauncherProfile(w) && (allWeapons || w.equipped !== false || isUnarmed(w)))).map((w) => ({ value: w.id, label: itemLabel(w) + (w.equipped === false && !isUnarmed(w) ? ` (${t('rangée')})` : '') }))} />
          <${Toggle} value=${allWeapons} onChange=${setAllWeapons} label=${t('afficher tout')} title=${t('Montrer aussi les armes rangées')} />
        </div>
        ${!weapon && !result && html`<div class="error small">${t('Arme introuvable')}</div>`}
        ${fireOpts.length > 0 && html`<div class="row wrap gap-s">
          ${fireOpts.length > 1 ? html`<${Select} value=${fire.id} options=${fireSelectOptions(weapon)} onChange=${setFireMode} />` : html`<span class="small">${fireSelectOptions(weapon)[0].label}</span>`}
          <span class=${'badge mono' + (outOfAmmo ? ' badge-red' : '')} title=${weapon.ammoKind ? t('Chargée : {ammo}', { ammo: ammoKindLabel(weapon.ammoKind) }) : ''}>${loaded}/${weapon.ammoMax}</span>
          ${ownsActor(game, sheet.id) && html`<${Button} small variant="ghost" onClick=${() => setReloading(true)}>↻ ${t('Recharger')}</${Button}>`}
          ${shownDefense ? html`<span class="faint small">${t('Défense de la cible {n}', { n: shownDefense })} · ${actionLabel(fire.action)}</span>` : html`<span class="faint small">${actionLabel(fire.action)}</span>`}
        </div>`}
        ${short > 0 && html`<div class="amber small">${fire.defense === null
          ? tn(loaded, 'Seulement {n} balle : zone de barrage réduite de {m} m.', 'Seulement {n} balles : zone de barrage réduite de {m} m.', { m: Math.floor(short / 2) })
          : tn(loaded, 'Seulement {n} balle : modificateur de défense réduit de {short}.', 'Seulement {n} balles : modificateur de défense réduit de {short}.', { short })}</div>`}
        ${grenadeLeft !== null && html`<div class="muted small">${tn(grenadeLeft, '{n} exemplaire — le jet le consomme.', '{n} exemplaires — le jet en consomme un.')}</div>`}
        ${outOfAmmo && html`<div class="row wrap gap-s"><span class="error small">${t('Plus assez de munitions — recharge')}</span>
          ${gm && html`<${Toggle} value=${ammoOverride} onChange=${setAmmoOverride} label=${t('Tirer quand même (MJ)')} />`}</div>`}
      </div>`}
      ${reloading && weapon && html`<${ReloadDialog} actor=${sheet} w=${weapon} gm=${gm} onClose=${() => setReloading(false)} />`}
      ${canTarget && !result && html`<div class="atk-target">
        ${weapon && weaponActions.length > 0 && html`<div class="row wrap gap-s">
          <span class="field-label">${t('Action')}</span>
          <${Select} value=${actionId} onChange=${pickAction} options=${[{ value: '', label: t('Attaque normale') }, ...weaponActions.map((a) => ({ value: a.id, label: t(a.name) + (a.locked ? ` (${t('non débloquée')})` : '') }))]} />
        </div>`}
        ${action && html`<div class="atk-action-note">${t(action.note)} <${BookRef} source=${action.source} page=${action.page} />
          ${action.edge ? html` <span class=${'badge ' + (edgeShort ? 'badge-red' : 'badge-magenta')}>${t('−{n} Chance', { n: action.edge })}</span>` : null}
          ${action.ini ? html` <span class="badge">${t('−{n} init.', { n: action.ini })}</span>` : null}
          ${action.rounds ? html` <span class="badge">${tn(action.rounds, '{n} balle', '{n} balles')}</span>` : null}
          ${usedOnce ? html` <span class="badge badge-red">${t('déjà utilisée ce tour')}</span>` : null}
          ${!isUnlocked(action, sheet) ? html` <span class="badge badge-amber">${t('non débloquée (MJ)')}</span>` : null}</div>`}
        ${rounds.length > 0 && html`<div class="row wrap gap-s"><span class="field-label">${t('Munition')}</span>
          <${Select} value=${round.id} onChange=${setProfileId} options=${rounds.map((r) => ({ value: r.id, label: itemLabel(r.w) + (r.loaded ? ` · ${t('chargée')}` : r.sheet ? '' : ` · ${t('catalogue')}`) }))} /></div>`}
        <div class="row wrap gap-s">
          <span class="field-label">${area ? t('Cible / point visé') : t('Cible')}</span>
          <${Select} value=${targetId} onChange=${setTargetId} options=${[{ value: '', label: candidates.length ? t('— aucune —') : t('— aucun pion sur la carte —') }, ...candidates.map((c) => ({ value: c.token.id, label: c.name + (c.meters !== null ? ` · ${c.meters} m` : '') + (c.range ? ` · ${t(c.range.label)}${c.range.mod ? ` ${c.range.mod}` : ''}` : '') }))]} />
        </div>
        ${area && aim && html`<${Toggle} value=${useAim} onChange=${setUseAim} label=${t('Viser le point marqué sur la carte ({x}, {y})', { x: aim.x, y: aim.y })} />`}
        ${area && !aim && html`<div class="faint small">${t('Astuce : clic droit sur la carte → « Viser ce point » pour lancer sur une case.')}</div>`}
        ${area && blast && html`<div class="faint small">${gas
          ? t('Nuage de gaz de {r} m : un test de Résistance aux toxines (CON + VOL) pour chaque pion dedans.', { r: blast.radius || 10 })
          : blast.damaging
          ? (blast.radius ? t('Souffle : {dv}{type} dans un rayon de {r} m.', { dv: blast.dv, type: blast.type, r: blast.radius }) : t('Souffle : {dv}{type}, −{f} par mètre (jusqu’à {r} m).', { dv: blast.dv, type: blast.type, f: blast.falloff, r: blastReach(blast) }))
          : t('Pas de dommages de souffle (fumée, gaz…).')} ${t('3 succès : pas de dispersion.')}</div>`}
        ${range && html`<div class=${'small ' + (range.beyond || range.tooClose ? 'error' : 'muted')}>${range.beyond ? t('Hors de portée ({m} m, max {max} m)', { m: range.meters, max: range.max }) : range.tooClose ? t('Trop près : portée minimale {min} m', { min: range.min }) : t('{band} ({m} m) : {mod} dés', { band: t(range.label), m: range.meters, mod: range.mod })}</div>`}
        ${env && !env.rangeOnly && html`<div class=${'small ' + (env.value ? 'amber' : 'muted')}>${t('Environnement : {parts} → {mod} dés', { parts: [...(range?.mod ? [t(range.label)] : []), ...env.parts.map((p) => t(p))].join(', '), mod: env.value })}${env.notes.length ? ` (${t('compensé : {what}', { what: env.notes.map((n) => t(n)).join(', ') })})` : ''} <${BookRef} source="SR5" page=${175} /></div>`}
        ${gas && html`<div class="row wrap gap-s"><span class="field-label">${t('Gaz')}</span>
          <${Select} value=${toxinId} onChange=${setToxinId} options=${TOXINS.map((x) => ({ value: x.id, label: `${t(x.name)} · ${t('puissance {n}', { n: x.power })}` }))} /></div>`}
        ${!myToken && (targetId || point) && weapon?.kind !== 'melee' && html`<div class="faint small">${t('Pas de pion de ce personnage sur la carte : portée non calculée.')}</div>`}
      </div>`}
      ${lines.length > 0 && html`<div class="sh-rd-mods">
        <div class="field-label">${t('Modificateurs (équipement, qualités, pouvoirs, implants)')}</div>
        ${lines.map((l) => {
          const canDrop = (l.state === 'applied' || l.state === 'ignored') && (gm || l.value > 0);
          return html`<div class="sh-rd-mod" key=${l.kind + l.mod.id}>
            ${canDrop
              ? html`<input type="checkbox" checked=${l.state === 'applied'} onChange=${(e) => setIgnore(l.mod.id, !e.target.checked)} title=${t('Compter ce modificateur')} />`
              : html`<span class="sh-rd-mod-dot" aria-hidden="true">${l.state === 'applied' ? '●' : '○'}</span>`}
            <${ModChip} m=${l.mod} state=${l.state} />
            ${l.kind === 'limit' ? html`<span class="faint small">${t('limite')}</span>` : null}
            ${l.state === 'off' ? html`<span class="faint small">${t('inactif')}</span>` : null}
          </div>`;
        })}
      </div>`}
      ${Object.keys(switches).length > 0 && html`<div class="col gap-s sh-rd-switches">
        ${Object.entries(switches).map(([k, ls]) => html`<${Toggle} key=${k} value=${toggles.has(k)} onChange=${(v) => setToggle(k, v)}
          label=${t('{switch} ({effects})', { switch: toggleText(k), effects: [...new Set(ls.map((l) => effectText(l.mod)))].join(', ') })} />`)}
      </div>`}

      <div class="sh-rd-grid">
        <div class="field"><span class="field-label">${t('Modificateur')}</span><${NumberInput} value=${modifier} min=${-30} max=${30} onChange=${setModifier} /></div>
        <div class="field"><span class="field-label">${t('Limite')} <${RuleRef} rule="limits" /></span>
          <div class="row">
            ${!explode && !noLimit ? html`<${NumberInput} value=${limit} min=${1} max=${30} onChange=${setManualLimit} small />` : html`<span class="muted small">${explode ? t('aucune (Chance)') : t('aucune')}</span>`}
            ${!explode && !noLimit && manualLimit !== null && autoLimit !== null && manualLimit !== autoLimit ? html`<${Button} small variant="ghost" onClick=${() => setManualLimit(null)} title=${t('Revenir à la limite calculée')}>↺ ${autoLimit}</${Button}>` : null}
            ${!explode && canRemoveLimit && html`<${Toggle} value=${!noLimit} onChange=${(v) => setNoLimit(!v)} title=${t('Appliquer une limite')} />`}
          </div>
          ${lim && !lim.fixed && lim.parts.length > 0 && !explode && html`<span class="field-hint">${lim.parts.map(([l, v], i) => `${i ? ' + ' : ''}${l} ${i && v >= 0 ? '+' : ''}${v}`).join('')}${lim.parts.length > 1 ? ` = ${lim.total}` : ''}</span>`}
        </div>
      </div>
      <div class="col gap-s">
        ${prev.spec && html`<${Toggle} value=${useSpec} onChange=${setUseSpec} label=${t('Spécialisation ({spec}) +2', { spec: prev.spec })} />`}
        ${dm && dm.woundModifier < 0 && (gm
          ? html`<${Toggle} value=${wounds} onChange=${setWounds} label=${t('Malus de blessures ({n})', { n: dm.woundModifier })} />`
          : wounds ? html`<span class="muted small">${t('Malus de blessures ({n})', { n: dm.woundModifier })}</span>` : null)}
        ${canEdge && html`<div class="row gap-s"><${Toggle} value=${explode} onChange=${setExplode} label=${t('Repousser les limites (+{n} dés, règle des 6) — Chance {left}/{max}', { n: edgeMax, left: edgeLeft, max: edgeMax })} /><${RuleRef} rule="edge" /></div>`}
        ${gm && html`<${Toggle} value=${secret} onChange=${setSecret} label=${t('Jet secret (visible du MJ seulement)')} />`}
      </div>

      ${result && html`<div class="sh-rd-result">
        <div class="sh-rd-hits"><b>${result.hits}</b><span>${tn(result.hits, 'one::succès', 'other::succès')}</span></div>
        <div class="grow col gap-s">
          <${DiceFaces} roll=${result} />
          <${RollBadges} roll=${result} />
          ${result.fire && html`<span class="muted small">${fireText(result.fire)}</span>`}
          ${result.attackId && !result.blast && html`<span class="small cyan">${result.hits > 0 ? t('Attaque envoyée à {target} : en attente de sa défense.', { target: result.targetName || '' }) : t('Raté : aucun succès.')}</span>`}
          ${result.blast && html`<span class="small amber">${result.blast.fumble ? t('Échec critique : la grenade part dans les pieds du lanceur !') : result.blast.scattered ? t('Dévie de {m} m (direction {d} au diagramme).', { m: result.blast.meters, d: (result.blast.dir || [0, 0]).reduce((a, b) => a + b, 0) }) : t('Pile sur le point visé.')}${result.blast.hits?.length ? ' ' + tn(result.blast.hits.length, '{n} cible dans le souffle.', '{n} cibles dans le souffle.') : ''}</span>`}
        </div>
      </div>`}

      <div class="row spread wrap">
        <div class="row">
          ${result && !result.explode && !result.secondChance && canEdge && html`<${Button} small variant="accent" onClick=${secondChance} title=${t('Relancer tous les dés qui ne sont pas des succès (1 point de Chance)')}>${t('Seconde chance')}</${Button}>`}
        </div>
        <div class="row">
          <${Button} variant="ghost" onClick=${onClose}>${t('Fermer')}</${Button}>
          <${Button} variant="primary" disabled=${busy || total <= 0 || prev.impossible || blockedByAmmo || (initialPreset.weaponId && !weapon) || (attackRoll && (edgeShort || usedOnce))} onClick=${roll}>${result ? tn(total, 'Relancer {n} dé', 'Relancer {n} dés') : tn(total, 'Lancer {n} dé', 'Lancer {n} dés')}</${Button}>
        </div>
      </div>
    </div>
  </${Overlay}>`;
}

/** « 3 balles · reste 9/15 » / « reste 1 » of a roll's fire record (roll.fire). */
export function fireText(f) {
  if (!f) return '';
  if (f.item) return f.removed ? t('dernier exemplaire utilisé') : t('reste {n}', { n: f.left });
  const base = t('{rounds} · reste {left}/{max}', { rounds: tn(f.rounds, '{n} balle', '{n} balles'), left: f.left, max: f.max });
  if (!f.short) return base;
  // Short burst (SR5 p. 180): the reduced defense modifier / narrower suppressive area.
  const extra = f.narrower !== undefined ? t('zone réduite de {m} m', { m: f.narrower }) : t('défense de la cible {n}', { n: f.defense ?? 0 });
  return `${base} · ${extra}`;
}

/** Rule (shared/bookrefs.js RULE_REFS) of each ROLL_TESTS test. */
const TEST_RULES = {
  composure: 'attributeTests', judgeIntentions: 'attributeTests', memory: 'attributeTests', liftCarry: 'attributeTests', defense: 'defense', soak: 'soak',
  drainResist: 'drain', biofeedback: 'biofeedback', toxinResist: 'attributeTests',
};
/** Switches the persona decides (Matrix mode, inside a host): not offered when the actor's persona is known (server rule). */
const PERSONA_SWITCHES = ['in-host', 'hot-sim'];

export default RollDialog;
