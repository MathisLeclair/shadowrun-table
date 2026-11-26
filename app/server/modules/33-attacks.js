// Attacks module: targeted attacks resolved step by step — attack roll → the target's defense → damage resistance → damage applied —
// grenades / launchers (aimed point, scatter, blast on the map) and the special combat actions (SR5 + Run & Gun, shared/combat.js).
// Rolls go through the characters module's performRoll (same modifiers, log entries and Edge as « dice/roll »).
// State: attacks: { list: [Attack] (newest first, max 60), blasts: [Blast] (max 12), turn: { [actorId]: { key, defended, boosts, once } } }.
import { parseDamage } from '../../shared/sr5.js';
import {
  ACTION_BY_ID, isUnlocked, rangeFor, rangeClass, cellDistance, isAreaWeapon, scatterDice, rollScatter, blastOf, blastDvAt, blastReach, defenseLines, finalDamageType,
  DEFENSE_BY_ID, SITUATION_BY_ID,
} from '../../shared/combat.js';
import { FIRE_BY_ID, isLauncherProfile, launcherRounds, fireOptions, usesAmmo } from '../../client/modules/sheet/inventory.js';
import { performRoll, applyDamage } from './10-characters.js';
import { spendInitiative, combatTurnKey } from './30-combat.js';

const tk = (s) => s;
const MAX_ATTACKS = 60;
const MAX_BLASTS = 12;
const THROW_THRESHOLD = 3; // grenade / projectile: 3 hits = lands where aimed (SR5 p. 182)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const int = (v, lo, hi, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const ids = (v, max = 12) => (Array.isArray(v) ? [...new Set(v.slice(0, max).map((x) => str(x, 40)))] : []);

function slice(state) {
  if (!isObj(state.attacks)) state.attacks = {};
  const s = state.attacks;
  if (!Array.isArray(s.list)) s.list = [];
  if (!Array.isArray(s.blasts)) s.blasts = [];
  if (!isObj(s.turn)) s.turn = {};
  return s;
}

/** Per-actor Combat Turn record (defenses made, turn-long defense boosts paid, once-per-turn actions used). */
function turnOf(state, actorId) {
  const key = combatTurnKey(state);
  if (!key) return null;
  const s = slice(state);
  let t = s.turn[actorId];
  if (!t || t.key !== key) t = s.turn[actorId] = { key, defended: 0, boosts: [], once: [] };
  return t;
}

function getAttack(ctx, id) {
  const a = slice(ctx.state).list.find((x) => x.id === id);
  if (!a) ctx.fail('Attaque introuvable');
  return a;
}
function actorOf(ctx, id) {
  const a = ctx.state.actors[id];
  if (!a) ctx.fail('Personnage introuvable');
  return a;
}
const nameOf = (w) => w?.nameFr || w?.name || '';
const biName = (w) => ({ fr: w?.nameFr || w?.name || '', en: w?.nameEn || w?.name || w?.nameFr || '' });

/** Map of the attack: the one asked (GM), else the active map. Token of an actor on it (first one). */
function mapFor(ctx, mapId) {
  const id = ctx.isGM && mapId ? str(mapId, 60) : ctx.state.scene?.activeMapId;
  return id ? ctx.state.maps?.[id] || null : null;
}
const tokenOf = (map, actorId) => (map?.tokens || []).find((t) => t.actorId === actorId) || null;

function push(state, list, item, max) {
  list.unshift(item);
  if (list.length > max) list.length = max;
  return item;
}

function logAttack(ctx, key, params, gmOnly) {
  ctx.log({ kind: 'combat', userId: ctx.user.id, author: 'Combat', i18n: { key, params }, ...(gmOnly ? { gmOnly: true } : {}) });
}

/** Damage Value and type of a weapon (or a launcher's ammunition profile) for this actor: { dv: number|null, type }. */
function weaponDamage(actor, w) {
  const p = parseDamage(w?.damage, actor);
  return { dv: Number.isFinite(p.value) ? p.value : null, type: p.type };
}
const apOf = (w) => {
  const n = Number(String(w?.ap ?? '0').replace(/[^-+\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Defense test of the target (REA + INT + options), then the attack moves to soak / missed / done. Returns the roll. */
function doDefend(ctx, atk, { options = [], situations = [], modifier = 0, explode = false } = {}) {
  if (atk.status !== 'defense') ctx.fail('Cette attaque n’attend pas de défense');
  const target = actorOf(ctx, atk.targetId);
  if (!ctx.owns(target.id)) ctx.fail('Seul le joueur de la cible (ou le MJ) peut défendre');
  const turn = turnOf(ctx.state, target.id);
  const plan = defenseLines(target, atk, {
    options: options.filter((id) => DEFENSE_BY_ID[id]), situations: situations.filter((id) => SITUATION_BY_ID[id]),
    prior: turn ? turn.defended : 0, turnBoosts: turn ? turn.boosts : [],
  });
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'REA', attr2: 'INT', test: 'defense', label: tk('Défense'), modifier: int(modifier, -30, 30), explode: !!explode,
    secret: false,
  }, { bonus: plan.lines.map((l) => ({ label: l.label, value: l.value })), logExtra: { attackId: atk.id, defense: true } });
  for (const id of plan.paid) spendInitiative(ctx, target.id, DEFENSE_BY_ID[id].ini, DEFENSE_BY_ID[id].name);
  if (turn) {
    turn.defended += 1;
    for (const id of plan.paid) if (DEFENSE_BY_ID[id].turn && !turn.boosts.includes(id)) turn.boosts.push(id);
  }
  atk.defenseHits = roll.hits;
  atk.defenseLogId = roll.logId;
  atk.net = atk.hits - roll.hits;
  const gmOnly = atk.gmOnly;
  if (atk.net <= 0) {
    atk.status = 'missed';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{target} évite l’attaque de {attacker}.'), { target: atk.targetName, attacker: atk.attackerName }, gmOnly);
  } else if (atk.noDamage || atk.dv === null) {
    atk.status = 'done';
    atk.resolvedTs = ctx.now;
    logAttack(ctx, tk('{attacker} réussit contre {target} : {n} succès net(s).'), { attacker: atk.attackerName, target: atk.targetName, n: atk.net }, gmOnly);
  } else {
    atk.status = 'soak';
    atk.modifiedDv = atk.dv + atk.net;
    logAttack(ctx, tk('{attacker} touche {target} : VD {dv}{type}, PA {ap}.'), { attacker: atk.attackerName, target: atk.targetName, dv: atk.modifiedDv, type: atk.type, ap: atk.ap }, gmOnly);
  }
  return roll;
}

/** Damage resistance (BOD + armor modified by AP), damage applied. Returns the roll. */
function doSoak(ctx, atk, { modifier = 0, explode = false } = {}) {
  if (atk.status !== 'soak') ctx.fail('Cette attaque n’attend pas d’encaissement');
  const target = actorOf(ctx, atk.targetId);
  if (!ctx.owns(target.id)) ctx.fail('Seul le joueur de la cible (ou le MJ) peut encaisser');
  const internal = { ap: atk.ap, logExtra: { attackId: atk.id, soak: true } };
  const roll = performRoll(ctx, {
    actorId: target.id, attr: 'BOD', test: 'soak', label: tk('Encaissement'), applyWounds: false, limit: null, modifier: int(modifier, -30, 30), explode: !!explode,
  }, internal);
  const dv = atk.modifiedDv ?? atk.dv ?? 0;
  const boxes = Math.max(0, dv - roll.hits);
  const type = finalDamageType(atk.type, dv, internal.armorUsed ?? 0);
  atk.soakHits = roll.hits;
  atk.soakLogId = roll.logId;
  atk.damage = boxes;
  atk.damageType = type;
  atk.status = 'done';
  atk.resolvedTs = ctx.now;
  if (boxes > 0) applyDamage(ctx, target, boxes, type);
  else logAttack(ctx, tk('{target} encaisse tout ({dv}{type}).'), { target: atk.targetName, dv, type: atk.type }, atk.gmOnly);
  return roll;
}

/** Players' view: no attack on a hidden NPC; a hidden attacker's name is masked. Blasts of the shown map only. */
function filterView(view, user, state) {
  const s = view.attacks;
  if (!s) return;
  delete s.turn;
  const visible = (id) => !!view.actors?.[id];
  s.list = (s.list || []).filter((a) => !a.gmOnly && visible(a.targetId)).map((a) => (visible(a.attackerId) ? a : { ...a, attackerName: '?', attackerId: null }));
  const amid = state?.scene?.activeMapId;
  s.blasts = (s.blasts || []).filter((b) => b.mapId === amid && !b.gmOnly).map((b) => ({ ...b, hits: (b.hits || []).filter((h) => visible(h.actorId)) }));
  // Turn info of the player's own characters (defenses already made, boosts paid) for the defense dialog preview.
  const own = new Set(user.characterIds || []);
  s.myTurn = {};
  const key = combatTurnKey(state);
  for (const [id, t] of Object.entries(state.attacks?.turn || {})) if (own.has(id) && t.key === key) s.myTurn[id] = { defended: t.defended, boosts: t.boosts, once: t.once };
}

export default {
  name: 'attacks',

  init(state) {
    slice(state);
  },

  actions: {
    // Attack roll with a target / an aimed point / a special action. Payload = the dice/roll payload +
    // { targetTokenId?, targetActorId?, point?: { x, y } (area weapons), actionId?, profileId? (launcher ammunition), mapId? (GM) }.
    'attack/roll': {
      role: 'any',
      handler(ctx, p = {}) {
        const actor = actorOf(ctx, str(p.actorId, 60));
        if (!ctx.owns(actor.id)) ctx.fail('Tu ne peux lancer que pour ton personnage');
        const weapon = p.weaponId ? (actor.weapons || []).find((w) => w && w.id === str(p.weaponId, 60)) : null;
        if (p.weaponId && !weapon) ctx.fail('Arme introuvable');
        const action = p.actionId ? ACTION_BY_ID[str(p.actionId, 40)] : null;
        if (p.actionId && !action) ctx.fail('Action inconnue');
        const payload = { ...p };
        delete payload.targetTokenId;
        delete payload.targetActorId;
        delete payload.point;
        delete payload.actionId;
        delete payload.profileId;
        delete payload.mapId;
        // Special action: unlocked (technique / quality), fits the weapon, once per turn, Edge.
        if (action) {
          if (!ctx.isGM && !isUnlocked(action, actor)) ctx.fail('{name} n’a pas débloqué « {action} »', { name: actor.name, action: { t: action.name } });
          if (action.kind === 'test') {
            if (weapon && !action.weaponSkill) ctx.fail('Cette action ne se fait pas avec une arme');
          } else {
            if (!weapon) ctx.fail('Choisis une arme pour cette action');
            if (action.kind === 'melee' && weapon.kind !== 'melee') ctx.fail('« {action} » demande une arme de mêlée', { action: { t: action.name } });
            if (action.kind === 'ranged' && weapon.kind === 'melee') ctx.fail('« {action} » demande une arme à distance', { action: { t: action.name } });
            if (action.fire) {
              if (!usesAmmo(weapon) || !fireOptions(weapon).some((o) => o.id === action.fire)) ctx.fail('« {action} » : mode de tir impossible avec cette arme', { action: { t: action.name } });
              payload.fireMode = action.fire;
            }
          }
          const turn = turnOf(ctx.state, actor.id);
          if (action.once && turn?.once.includes(action.id)) ctx.fail('« {action} » : une seule fois par tour de combat', { action: { t: action.name } });
          const edgeNeeded = (action.edge || 0) + (payload.explode ? 1 : 0);
          if (edgeNeeded && (actor.edge?.current ?? 0) < edgeNeeded) ctx.fail('{name} n’a plus assez de points de Chance', { name: actor.name });
        }
        // Target: a token on the map (players: not a hidden one), or an actor (GM, no map).
        const map = mapFor(ctx, p.mapId);
        let targetToken = null;
        let target = null;
        if (p.targetTokenId) {
          targetToken = (map?.tokens || []).find((t) => t.id === str(p.targetTokenId, 60)) || null;
          if (!targetToken || (!ctx.isGM && targetToken.hidden)) ctx.fail('Cible introuvable sur la carte');
          if (targetToken.actorId) target = ctx.state.actors[targetToken.actorId] || null;
        } else if (p.targetActorId) {
          target = actorOf(ctx, str(p.targetActorId, 60));
          if (!ctx.isGM && target.type === 'npc' && target.hidden) ctx.fail('Cible introuvable');
          targetToken = tokenOf(map, target.id);
        }
        if (target && target.id === actor.id) ctx.fail('Impossible de se cibler soi-même');
        const attackerToken = tokenOf(map, actor.id);
        const mpc = Number(map?.metersPerCell) || 1;
        const area = weapon && isAreaWeapon(weapon);
        let point = null;
        if (area) {
          if (isObj(p.point) && map) point = { x: int(p.point.x, 0, map.width - 1), y: int(p.point.y, 0, map.height - 1) };
          else if (targetToken) point = { x: targetToken.x, y: targetToken.y };
        }
        // Range modifier from the token distance (ranged weapons): « portée longue (34 m) −3 ».
        const bonus = [];
        let range = null;
        const aimAt = point || (targetToken ? { x: targetToken.x, y: targetToken.y } : null);
        if (weapon && weapon.kind !== 'melee' && attackerToken && aimAt) {
          range = rangeFor(weapon, actor, cellDistance(attackerToken, aimAt, mpc));
          if (range?.mod) bonus.push({ label: `${range.label} (${range.meters} m)`, value: range.mod });
        }
        if (action?.dice) bonus.push({ label: action.name, value: action.dice });
        // Launcher ammunition: the minigrenade profile listed on the sheet gives DV / AP / blast.
        // Without one (Chummer did not list it): the loaded minigrenade, or the catalog minigrenade chosen in the dialog.
        let profile = null;
        if (weapon && rangeClass(weapon) === 'grenadeLauncher' && !isLauncherProfile(weapon)) {
          const rounds = launcherRounds(actor, weapon);
          const pick = p.profileId ? rounds.find((r) => r.id === str(p.profileId, 60)) : rounds.find((r) => r.loaded || r.sheet);
          if (p.profileId && !pick) ctx.fail('Munition inconnue pour ce lance-grenades');
          if (!pick) ctx.fail('Choisis la minigrenade tirée');
          profile = pick.w;
        }
        const source = profile || weapon;
        const dmg = source ? weaponDamage(actor, source) : { dv: null, type: 'P' };
        const atkId = ctx.uid('atk');
        if (action?.kind === 'test') {
          // Own pool, no weapon (Clinch, Kip-Up, Reading the Defense: weapon skill + INT).
          if (action.weaponSkill && weapon) payload.skillId = weapon.skill;
          else if (action.skillId) payload.skillId = action.skillId;
          payload.attr = action.attr;
          delete payload.weaponId;
          payload.label = action.name;
        }
        const targetName = target?.name || targetToken?.name || '';
        const roll = performRoll(ctx, payload, {
          bonus, rounds: action?.rounds,
          logExtra: { attackId: target || point ? atkId : undefined, ...(targetName ? { targetName } : {}), ...(action ? { actionName: action.name } : {}), ...(range ? { range: { band: range.id, meters: range.meters, ...(range.beyond ? { beyond: true } : {}) } } : {}) },
        });
        // Costs of the special action, once the roll went through.
        if (action) {
          if (action.edge) actor.edge.current = Math.max(0, actor.edge.current - action.edge);
          if (action.ini) spendInitiative(ctx, actor.id, action.ini, action.name);
          const turn = turnOf(ctx.state, actor.id);
          if (action.once && turn) turn.once.push(action.id);
        }
        const gmOnly = !!roll.secret || !!(actor.type === 'npc' && actor.hidden);
        const s = slice(ctx.state);
        const base = {
          ts: ctx.now, mapId: map?.id || null, attackerId: actor.id, attackerName: actor.name, attackLogId: roll.logId, hits: roll.hits,
          weaponName: source ? biName(source) : null, ...(action ? { actionId: action.id, actionName: action.name } : {}), ...(gmOnly ? { gmOnly: true } : {}),
        };
        // Area weapon: scatter, blast, a soak for every token caught in it.
        if (area && point && map) {
          const from = attackerToken ? { x: attackerToken.x, y: attackerToken.y } : null;
          let land;
          if (roll.critGlitch && from) land = { x: from.x, y: from.y, meters: cellDistance(from, point, mpc), scattered: true, fumble: true };
          else {
            land = rollScatter({ from, to: point, hits: roll.hits, dice: scatterDice(weapon), threshold: THROW_THRESHOLD, metersPerCell: mpc, width: map.width, height: map.height });
            // Glitch: the scatter distance is doubled (SR5 p. 182, motion sensor).
            if (roll.glitch && land.scattered) {
              const clampTo = (v, max) => Math.max(0, Math.min(max - 1, Math.round(v * 10) / 10));
              land = { ...land, meters: land.meters * 2, x: clampTo(point.x + (land.x - point.x) * 2, map.width), y: clampTo(point.y + (land.y - point.y) * 2, map.height), glitch: true };
            }
          }
          const blast = blastOf(source, actor) || { dv: null, type: 'P', ap: 0, falloff: null, radius: null, damaging: false };
          if (action?.dv && blast.damaging) blast.dv += action.dv;
          const hits = [];
          if (blast.damaging) {
            for (const tok of map.tokens || []) {
              if (!tok.actorId || !ctx.state.actors[tok.actorId]) continue;
              const m = cellDistance(tok, land, mpc);
              const dv = blastDvAt(blast, m);
              if (dv <= 0) continue;
              const victim = ctx.state.actors[tok.actorId];
              const atk = push(ctx.state, s.list, {
                ...base, id: ctx.uid('atk'), kind: 'blast', targetId: victim.id, targetTokenId: tok.id, targetName: victim.name,
                dv, type: blast.type, ap: blast.ap + (action?.ap || 0), meters: m, status: 'soak', modifiedDv: dv,
                ...(gmOnly || (victim.type === 'npc' && victim.hidden) ? { gmOnly: true } : {}),
              }, MAX_ATTACKS);
              hits.push({ actorId: victim.id, tokenId: tok.id, name: victim.name, dv, meters: m, attackId: atk.id });
            }
          }
          const b = push(ctx.state, s.blasts, {
            id: atkId, ts: ctx.now, mapId: map.id, attackerId: actor.id, attackerName: actor.name, weaponName: biName(source), from, aim: point,
            x: land.x, y: land.y, meters: land.meters, scattered: !!land.scattered, dir: land.dir || null, dist: land.dist || null,
            ...(land.fumble ? { fumble: true } : {}), ...(land.glitch ? { glitch: true } : {}), hitsRolled: roll.hits,
            dv: blast.dv, type: blast.type, ap: blast.ap, falloff: blast.falloff, radius: blast.radius, reach: blastReach(blast), hits, ...(gmOnly ? { gmOnly: true } : {}),
          }, MAX_BLASTS);
          if (land.scattered) logAttack(ctx, tk('{weapon} dévie de {m} m ({dir} au diagramme).'), { weapon: biName(source), m: land.meters, dir: land.dir ? land.dir[0] + land.dir[1] : '—' }, gmOnly);
          else logAttack(ctx, tk('{weapon} tombe exactement au point visé.'), { weapon: biName(source) }, gmOnly);
          return { ...roll, entry: undefined, blastId: b.id, blast: b };
        }
        if (!target) {
          const { entry, ...out } = roll;
          return out;
        }
        // Targeted attack: the defender rolls next (no hit = missed at once).
        const fireDef = roll.fire ? (roll.fire.defense !== undefined ? roll.fire.defense : FIRE_BY_ID[roll.fire.mode]?.defense || 0) : 0;
        const atk = push(ctx.state, s.list, {
          ...base, id: atkId, kind: weapon?.kind === 'melee' || action?.kind === 'test' ? 'melee' : 'ranged', targetId: target.id, targetTokenId: targetToken?.id || null, targetName,
          dv: action?.noDamage ? null : dmg.dv === null ? null : dmg.dv + (action?.dv || 0), type: dmg.type, ap: apOf(source) + (action?.ap || 0),
          reach: weapon?.kind === 'melee' ? (Number(weapon.reach) || 0) + (action?.reach || 0) + (/troll/i.test(actor.metatype || '') ? 1 : 0) : 0,
          defenseMod: fireDef || 0, ...(fireDef ? { defenseLabel: tk('mode de tir') } : {}), actionDefense: action?.defense || 0,
          ...(action?.noDamage ? { noDamage: true } : {}), ...(range ? { range: { band: range.id, meters: range.meters } } : {}),
          status: roll.hits > 0 ? 'defense' : 'missed', ...(roll.hits > 0 ? {} : { resolvedTs: ctx.now }),
          ...(target.type === 'npc' && target.hidden ? { gmOnly: true } : {}),
        }, MAX_ATTACKS);
        if (atk.status === 'missed') logAttack(ctx, tk('{attacker} rate {target}.'), { attacker: atk.attackerName, target: atk.targetName }, atk.gmOnly);
        const { entry, ...out } = roll;
        return { ...out, attackId: atk.id };
      },
    },

    // The target's owner (or the GM) defends: { attackId, options: ['dodge'|'parry'|'block'|'full'|…], situations: [...], modifier, explode }.
    'attack/defend': {
      role: 'any',
      handler(ctx, p = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        const { entry, ...roll } = doDefend(ctx, atk, { options: ids(p.options), situations: ids(p.situations), modifier: p.modifier, explode: p.explode });
        return { roll, attack: atk };
      },
    },

    // Damage resistance: { attackId, modifier, explode } — damage applied to the target.
    'attack/soak': {
      role: 'any',
      handler(ctx, p = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        const { entry, ...roll } = doSoak(ctx, atk, { modifier: p.modifier, explode: p.explode });
        return { roll, attack: atk };
      },
    },

    // GM: roll the remaining steps without options (NPC defense then soak). { attackId }
    'attack/auto': {
      handler(ctx, p = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        if (atk.status === 'defense') doDefend(ctx, atk, {});
        if (atk.status === 'soak') doSoak(ctx, atk, {});
        return { attack: atk };
      },
    },

    // GM: settle by hand. { attackId, outcome: 'missed'|'damage', amount?, type? }
    'attack/resolve': {
      handler(ctx, p = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        if (atk.status === 'done' || atk.status === 'missed' || atk.status === 'cancelled') ctx.fail('Attaque déjà résolue');
        if (p.outcome === 'damage') {
          const n = int(p.amount, 0, 100);
          const type = p.type === 'S' ? 'S' : 'P';
          if (n > 0) applyDamage(ctx, actorOf(ctx, atk.targetId), n, type);
          atk.damage = n;
          atk.damageType = type;
          atk.status = 'done';
        } else {
          atk.status = 'missed';
          logAttack(ctx, tk('{target} évite l’attaque de {attacker}.'), { target: atk.targetName, attacker: atk.attackerName }, atk.gmOnly);
        }
        atk.manual = true;
        atk.resolvedTs = ctx.now;
        return { attack: atk };
      },
    },

    // The attacker's owner or the GM withdraws a pending attack. { attackId }
    'attack/cancel': {
      role: 'any',
      handler(ctx, p = {}) {
        const atk = getAttack(ctx, str(p.attackId, 60));
        if (!ctx.isGM && !(atk.attackerId && ctx.owns(atk.attackerId))) ctx.fail('Seul l’attaquant (ou le MJ) peut annuler');
        if (atk.status !== 'defense' && atk.status !== 'soak') ctx.fail('Attaque déjà résolue');
        atk.status = 'cancelled';
        atk.resolvedTs = ctx.now;
        return { attack: atk };
      },
    },

    // GM: clear finished attacks (all: pending ones too) and blasts. { all?, blasts? }
    'attack/clear': {
      handler(ctx, p = {}) {
        const s = slice(ctx.state);
        s.list = p.all ? [] : s.list.filter((a) => a.status === 'defense' || a.status === 'soak');
        if (p.blasts !== false) s.blasts = [];
        return { left: s.list.length };
      },
    },

    // GM: remove one blast marker. { blastId }
    'attack/removeBlast': {
      handler(ctx, p = {}) {
        const s = slice(ctx.state);
        s.blasts = s.blasts.filter((b) => b.id !== str(p.blastId, 60));
        return {};
      },
    },
  },

  filter: filterView,
};
