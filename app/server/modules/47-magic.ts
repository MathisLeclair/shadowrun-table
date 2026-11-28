// Magic module: owner of state.magic (settings, sustained spells, astral presences) and of `actor.magic.tradition`.
// Design and the features still to come (cast flow, sustaining, spirits, astral, foci…): docs/design/magic.md.
// Feature page: docs/modules/magic.md. Rules data: shared/magic.ts; traditions: server/lib/traditions.ts.
import { attr, rollDice } from '../../shared/sr5.ts';
import { uid } from '../../shared/util.ts';
import { blankActor, normalizeActor } from '../../client/modules/sheet/sheet-data.ts';
import { deriveFull } from '../lib/modifiers.ts';
import { spiritDef, spiritDefs } from '../lib/spirits.ts';
import { placeActorToken } from './20-maps.ts';
import { cellDistance } from '../../shared/combat.ts';
import { hasLineOfSight } from '../../shared/vision.ts';
import {
  isAwakened, DRAIN_ATTRS, drainAttr, drainValue, spellDrainType, spellReach, isAreaSpell, spellCategory, maxForce, RECKLESS_DV,
  isSustainable, spellEffects, combatSpellProfile, MIN_DRAIN, spellResistance, NO_AURA_KINDS, OBJECT_RESISTANCE,
  spiritStats, spiritWeapons, traditionSpiritTypes, optionalPowerCount, BINDING_DRAMS, isReagent, reagentDrams, aidSpiritType,
  canPerceiveAstral, canProjectAstral, focusKind, focusForce, focusCategory, focusWorks, teamwork, ritualDrain, hasMetamagic, spellShapingMax,
} from '../../shared/magic.ts';
import { spellCatalogInfo } from '../lib/spells.ts';
import { addSpellAttack, addAstralAttack } from './33-attacks.ts';
import { combatHooks, addEntries } from './30-combat.ts';
import { actorTradition, traditionDef } from '../lib/traditions.ts';
import { performRoll, applyDamage, removeActor } from './10-characters.ts';
import type { PerformedRoll } from './10-characters.ts';
import type {
  ActionContext, ActionDef, Actor, ActorId, ActorSpirit, AdeptPower, AttrKey, BiName, GameMap, I18nParams, MagicLogInfo, MagicSettings, MagicState, PendingDrain,
  ServerModule, Spell, SpellEffectEntry, SustainedSpell, SustainingEntry, TableState, Token,
} from '../../shared/types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): string => (v === undefined || v === null ? '' : String(v).slice(0, max));

/** state.magic, created and normalised on demand. */
export function slice(state: TableState): MagicState {
  state.magic ||= {} as MagicState;
  const m = state.magic;
  if (!isObj(m.settings)) m.settings = {} as MagicSettings;
  // autoDrain: drain resisted right after the cast (SR5 p. 282); off = a « Resist drain » button is left instead.
  m.settings.autoDrain = m.settings.autoDrain !== false;
  m.settings.showAstralToPlayers = !!m.settings.showAstralToPlayers;
  if (!isObj(m.sustained)) m.sustained = {};
  if (!isObj(m.astral)) m.astral = {};
  if (!isObj(m.pendingDrain)) m.pendingDrain = {};
  return m;
}

const tk = (s: string): string => s;
const biName = (w: { name?: string; nameFr?: string; nameEn?: string }): BiName => ({ fr: w.nameFr || w.name || '', en: w.nameEn || w.name || w.nameFr || '' });
/** Roll labels are stored in French (formats sheet/common.tsx rollLabel() translates). */
const drainRollLabel = (k: string): string => `Résistance au drain (VOL + ${k})`; // i18n-ignore
const spellRollLabel = (name: string): string => `Sort — ${name}`; // i18n-ignore

function logMagic(ctx: ActionContext, a: Actor, key: string, params: I18nParams, magic: MagicLogInfo, gmOnly = false) {
  return ctx.log({ kind: 'magic', userId: ctx.user.id, author: a.name, i18n: { key, params }, magic, ...(gmOnly ? { gmOnly: true } : {}) });
}

// ---------------------------------------------------------------------------
// Sustained spells (SR5 p. 282): state.magic.sustained is the record; syncSustained() mirrors it on the actors
// (actor.magic.sustaining = −2 dice on every test per spell, actor.magic.spellEffects = Armor, Combat Sense… on the
// targets) so the modifiers (shared/modifiers.ts collectModifiers) see it in every roll, on the server and the sheet.
// ---------------------------------------------------------------------------

/** Rewrite the actors' mirrors from state.magic.sustained (drops the spells of deleted casters). */
export function syncSustained(state: TableState): void {
  const m = slice(state);
  const sustaining: Record<ActorId, SustainingEntry[]> = {};
  const effects: Record<ActorId, SpellEffectEntry[]> = {};
  for (const [id, s] of Object.entries(m.sustained)) {
    const caster = state.actors?.[s?.casterId];
    if (!isObj(s) || !caster) {
      delete m.sustained[id];
      continue;
    }
    // A sustaining focus: mirrored on the caster with its id; the modifiers skip the −2 while the focus works (SR5 p. 320).
    if (s.by?.kind === 'focus') (sustaining[caster.id] ||= []).push({ id: s.id, name: s.name, force: s.force, focusId: s.by.gearId });
    else if (s.by?.kind === 'quickened') { /* permanent: nobody carries a −2 */ }
    else if (!s.by || s.by.kind === 'caster') (sustaining[caster.id] ||= []).push({ id: s.id, name: s.name, force: s.force });
    else if (s.by.kind === 'spirit' && state.actors?.[s.by.actorId]) (sustaining[s.by.actorId] ||= []).push({ id: s.id, name: s.name, force: s.force });
    const spell = (caster.spells || []).find((x) => x.id === s.spellId) || { name: s.name.en || s.name.fr, nameEn: s.name.en, nameFr: s.name.fr };
    const fx = spellEffects(spell, s.hits);
    if (!fx.length) continue;
    for (const tid of s.targetIds || []) {
      if (!state.actors?.[tid]) continue;
      (effects[tid] ||= []).push({ id: s.id, name: s.name, force: s.force, hits: s.hits, casterId: caster.id, casterName: caster.name, effects: fx });
    }
  }
  for (const a of Object.values(state.actors || {})) {
    const want = sustaining[a.id];
    const fx = effects[a.id];
    if (!want && !fx && !a.magic?.sustaining && !a.magic?.spellEffects) continue;
    a.magic = a.magic && typeof a.magic === 'object' ? a.magic : {};
    if (want) a.magic.sustaining = want;
    else delete a.magic.sustaining;
    if (fx) a.magic.spellEffects = fx;
    else delete a.magic.spellEffects;
  }
}

/** End a sustained spell (logged). */
function dropSustained(ctx: ActionContext, s: SustainedSpell, key: string): void {
  const m = slice(ctx.state);
  delete m.sustained[s.id];
  syncSustained(ctx.state);
  const a = ctx.state.actors[s.casterId];
  if (a) logMagic(ctx, a, key, { name: a.name, spell: s.name, force: s.force }, { event: 'drop', actorId: a.id, spellId: s.spellId, force: s.force }, hiddenCaster(a));
}

// A new Combat Turn: Permanent spells count down their Force in Combat Turns, then their effect is permanent (SR5 p. 283).
combatHooks.push((ctx: ActionContext, _c: TableState['combat'], event: string) => {
  if (event !== 'newTurn') return;
  for (const s of Object.values(slice(ctx.state).sustained)) {
    // A bound spirit sustains a spell for its Force in Combat Turns per service (SR5 p. 302), then gives it back.
    if (s.by?.kind === 'spirit') {
      s.by.turnsLeft -= 1;
      const sp = ctx.state.actors[s.by.actorId];
      if (s.by.turnsLeft <= 0 || !sp) {
        delete s.by;
        syncSustained(ctx.state);
        const caster = ctx.state.actors[s.casterId];
        if (caster) logMagic(ctx, caster, tk('{spirit} stops sustaining {spell}: {name} sustains it again.'), { spirit: sp?.name || '?', spell: s.name, name: caster.name }, { event: 'spirit', actorId: caster.id }, hiddenCaster(caster));
      }
    }
    if (typeof s.turnsLeft !== 'number') continue;
    s.turnsLeft -= 1;
    if (s.turnsLeft <= 0) dropSustained(ctx, s, tk('{spell} (Force {force}) of {name} is now permanent: no longer sustained.'));
  }
});

/** NPC actors the GM keeps hidden roll in secret (as dice/roll does). */
const hiddenCaster = (a: Actor): boolean => a.type === 'npc' && !!a.hidden;

/**
 * Resist Drain now (SR5 p. 282): WIL + the tradition's attribute with the drain modifiers (`test: 'drainResist'`), then the
 * boxes left are applied as Stun or Physical damage.
 */
function resistDrain(ctx: ActionContext, a: Actor, dv: number, type: 'P' | 'S', source: BiName): { roll: PerformedRoll; damage: number } {
  const second = drainAttr(a);
  if (!second) ctx.fail('Choose a tradition first: it sets the attribute you resist Drain with');
  const secret = hiddenCaster(a);
  const roll = performRoll(ctx, { actorId: a.id, attr: 'WIL', attr2: second, test: 'drainResist', label: drainRollLabel(second), limit: null, ...(secret ? { secret: true } : {}) });
  const damage = Math.max(0, dv - roll.hits);
  if (damage) applyDamage(ctx, a, damage, type);
  const key = !damage
    ? tk('{name} resists Drain {dv} ({source}): {hits} hit(s), no damage.')
    : type === 'P'
      ? tk('{name} resists Drain {dv} ({source}): {hits} hit(s), {damage} box(es) of Physical damage.')
      : tk('{name} resists Drain {dv} ({source}): {hits} hit(s), {damage} box(es) of Stun damage.');
  logMagic(ctx, a, key, { name: a.name, dv, source, hits: roll.hits, damage }, { event: 'drain', actorId: a.id, dv, drainType: type, damage }, secret);
  return { roll, damage };
}

const tokenOf = (map: GameMap | null, actorId: ActorId): Token | null => (map?.tokens || []).find((t) => t.actorId === actorId) || null;

type CastPayload = {
  actorId?: ActorId; spellId?: unknown; force?: unknown; reckless?: unknown; explode?: unknown; modifier?: unknown; conditions?: unknown;
  ignore?: unknown; mapId?: unknown; targetIds?: unknown; area?: unknown; drainDv?: unknown; sustain?: unknown;
  /** A bound spirit of the tradition's type for this category adds its Force in dice (SR5 p. 302, one service). */
  aidSpiritId?: unknown;
  /** A sustaining focus (gear id) sustains the spell instead of the caster (SR5 p. 320). */
  sustainFocusId?: unknown;
  /** Spell Shaping (SR5 p. 326): metres added to (or taken from) an area spell's radius, −1 die each. */
  shape?: unknown;
  /** The spell targets an object: its Object Resistance dice pool (3, 6, 9, 15: SR5 p. 295). */
  object?: unknown;
};
type CastArea = { x: number; y: number; radius: number };

/**
 * Targets of a cast, checked against the spell's range (SR5 p. 281): Line of Sight from the caster's token, Touch = an
 * adjacent token, Self = the caster only, Area = within Force metres of the centre. The GM's casts are not checked
 * (NPCs often have no token, the GM knows the scene).
 */
function castTargets(ctx: ActionContext, a: Actor, spell: Spell, force: number, p: CastPayload): { targets: Actor[]; area: CastArea | null } {
  const ids = [...new Set((Array.isArray(p.targetIds) ? p.targetIds : []).slice(0, 24).map((x) => str(x, 80)))].filter(Boolean);
  const targets = ids.map((id) => ctx.state.actors[id] || ctx.fail('Unknown character'));
  const mapId = str(p.mapId, 80);
  const map = mapId ? ctx.state.maps?.[mapId] || null : null;
  const reach = spellReach(spell.range);
  let area: CastArea | null = null;
  if (isAreaSpell(spell.range) && map) {
    const pt = isObj(p.area) ? { x: Math.round(Number(p.area.x)), y: Math.round(Number(p.area.y)) } : null;
    const first = targets[0] ? tokenOf(map, targets[0].id) : null;
    const c = pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) ? pt : first ? { x: first.x, y: first.y } : null;
    if (c) area = { ...c, radius: Math.max(0, force + (Math.round(Number(p.shape)) || 0)) };
  }
  if (ctx.isGM) return { targets, area };
  if (reach === 'self' && targets.some((t) => t.id !== a.id)) ctx.fail('{spell} can only target its caster', { spell: biName(spell) });
  const others = targets.filter((t) => t.id !== a.id);
  if (!others.length && !area) return { targets, area };
  if (!map) ctx.fail('Pick the targets on the map');
  const me = tokenOf(map, a.id);
  if (!me) ctx.fail('{name} has no token on this map', { name: a.name });
  const mpc = Number(map.metersPerCell) || 1;
  if (area && reach === 'los' && !hasLineOfSight(map, me, area)) ctx.fail('No line of sight to the centre of the area');
  // Area: every target (the caster included) must stand in it; otherwise the caster may always target themself.
  for (const t of area ? targets : others) {
    const tok = tokenOf(map, t.id);
    if (!tok || tok.hidden) ctx.fail('{name} is not on the map', { name: t.name });
    if (area) {
      const d = cellDistance(tok, area, mpc);
      if (d > area.radius + mpc) ctx.fail('{name} is outside the area ({d} m from the centre, radius {r} m)', { name: t.name, d, r: area.radius });
    } else if (reach === 'los' && !hasLineOfSight(map, me, tok)) ctx.fail('No line of sight to {name}', { name: t.name });
    else if (reach === 'touch' && Math.max(Math.abs(tok.x - me.x), Math.abs(tok.y - me.y)) > Math.max(1, me.size || 1, tok.size || 1)) {
      ctx.fail('{name} is out of reach: {spell} needs a touch', { name: t.name, spell: biName(spell) });
    }
  }
  return { targets, area };
}

/**
 * Cast a spell (SR5 pp. 281-282): Spellcasting + Magic [Force], drain computed (formula, min 2, +3 reckless), Physical when
 * the hits exceed Magic, resisted at once (settings.autoDrain) or left pending. Returns the cast for the effect steps.
 */
export function castSpell(ctx: ActionContext, p: CastPayload) {
  const a = actorOf(ctx, p.actorId);
  const spell = (a.spells || []).find((x) => x.id === str(p.spellId, 80));
  if (!spell) ctx.fail('Unknown spell');
  const mag = attr(a, 'MAG');
  if (mag <= 0) ctx.fail('{name} is not awakened', { name: a.name });
  const force = Math.round(Number(p.force));
  if (!Number.isFinite(force) || force < 1 || force > maxForce(a)) ctx.fail('The Force must be between 1 and {max} (twice your Magic)', { max: maxForce(a) });
  if (!drainAttr(a)) ctx.fail('Choose a tradition first: it sets the attribute you resist Drain with');
  const reckless = !!p.reckless;
  let dv = drainValue(spell.drain, force, { reckless });
  if (dv === null) {
    const given = Math.round(Number(p.drainDv));
    if (!(given >= 2 && given <= 40)) ctx.fail('Enter the Drain Value of {spell} (formula « {formula} »)', { spell: biName(spell), formula: spell.drain || '—' });
    dv = given + (reckless ? RECKLESS_DV : 0);
  }
  // Spell Shaping (SR5 p. 326): an area spell, the metamagic, at most Magic (+ a spell shaping focus) metres; −1 die each.
  const shape = Math.round(Number(p.shape)) || 0;
  if (shape) {
    if (!isAreaSpell(spell.range)) ctx.fail('Only an area spell can be shaped');
    if (!ctx.isGM && !hasMetamagic(a, 'spellShaping')) ctx.fail('{name} does not know Spell Shaping', { name: a.name });
    if (Math.abs(shape) > spellShapingMax(a)) ctx.fail('Spell Shaping: at most {n} metres', { n: spellShapingMax(a) });
  }
  const { targets, area } = castTargets(ctx, a, spell, force, p);
  const cat = spellCategory(spell.category);
  // Mana spells only affect living beings and astral forms (SR5 p. 282): no drone, IC or host.
  if (/^M/i.test(String(spell.type || '').trim())) {
    const dead = targets.find((t) => NO_AURA_KINDS.includes(String(t.npc?.kind || '')));
    if (dead) ctx.fail('{spell} is a mana spell: it cannot affect {name}', { spell: biName(spell), name: dead.name });
  }
  // Spellcasting foci (condition spell-<category>) apply to a spell of their category without a switch.
  const conditions = [...(Array.isArray(p.conditions) ? p.conditions.slice(0, 40) : []), ...(cat ? [`spell-${cat}`] : [])];
  const secret = hiddenCaster(a);
  // Aid Sorcery (bound spirit service, SR5 p. 302): +Force dice when its type is the tradition's spirit of the category.
  const bonus: Array<{ label: string; value: number }> = [];
  let aid: Actor | null = null;
  if (p.aidSpiritId) {
    aid = ctx.state.actors[str(p.aidSpiritId, 80)] || null;
    if (!aid?.spirit || aid.spirit.summonerId !== a.id) ctx.fail('Unknown spirit');
    if (!aid.spirit.bound) ctx.fail('Only a bound spirit can aid spellcasting');
    if (aid.spirit.present === false) ctx.fail('{name} is resting on its metaplane: call it first', { name: aid.name });
    if (aid.spirit.services <= 0) ctx.fail('{name} owes no service', { name: aid.name });
    if (aidSpiritType(a.magic?.tradition, spell.category) !== aid.spirit.type) ctx.fail('{name} cannot aid this category of spell', { name: aid.name });
    bonus.push({ label: `spirit ${aid.spirit.force}`, value: aid.spirit.force });
  }
  const roll = performRoll(ctx, {
    actorId: a.id, skillId: 'spellcasting', label: spellRollLabel(spell.nameFr || spell.name), limit: force, explode: !!p.explode,
    modifier: p.modifier, conditions, ignore: p.ignore, ...(secret ? { secret: true } : {}),
  }, { bonus: [...bonus, ...(shape ? [{ label: 'spell shaping', value: -Math.abs(shape) }] : [])], logExtra: { labelI18n: { key: tk('Spell — {spell} (Force {force})'), params: { spell: biName(spell), force } } } });
  if (aid?.spirit) {
    aid.spirit.services -= 1;
    logMagic(ctx, a, tk('{spirit} aids the spell: +{n} dice (one service).'), { spirit: aid.name, n: aid.spirit.force }, { event: 'spirit', actorId: aid.id }, secret);
    if (aid.spirit.services <= 0) dismissSpirit(ctx, aid, tk('{name} has no service left and returns to its metaplane.'));
  }
  const hits = roll.hits;
  const type = spellDrainType(hits, mag);
  const params = { name: a.name, spell: biName(spell), force, hits, dv, targets: targets.map((t) => t.name).join(', ') };
  let key: string;
  if (targets.length) key = type === 'P' ? tk('{name} casts {spell} at Force {force} on {targets}: {hits} hit(s). Drain {dv}, Physical (hits above Magic).') : tk('{name} casts {spell} at Force {force} on {targets}: {hits} hit(s). Drain {dv}.');
  else key = type === 'P' ? tk('{name} casts {spell} at Force {force}: {hits} hit(s). Drain {dv}, Physical (hits above Magic).') : tk('{name} casts {spell} at Force {force}: {hits} hit(s). Drain {dv}.');
  const entry = logMagic(ctx, a, key, params, { event: 'cast', actorId: a.id, spellId: spell.id, force, hits, reckless, dv, drainType: type, targetIds: targets.map((t) => t.id) }, secret);
  // Glitches (SR5 p. 282): the GM decides; the log reminds the usual effects.
  const info: MagicLogInfo = { event: 'cast', actorId: a.id, spellId: spell.id };
  if (roll.critGlitch) logMagic(ctx, a, tk('Critical glitch on {spell}: the spell may get away from its caster — the GM decides (SR5 p. 282).'), { spell: biName(spell) }, info, secret);
  else if (roll.glitch) logMagic(ctx, a, tk('Glitch on {spell}: usually +2 Drain, a wrong target or another mishap — the GM decides (SR5 p. 282).'), { spell: biName(spell) }, info, secret);
  const m = slice(ctx.state);
  let drain: { hits: number; damage: number } | { pendingId: string };
  if (m.settings.autoDrain) {
    const r = resistDrain(ctx, a, dv, type, biName(spell));
    drain = { hits: r.roll.hits, damage: r.damage };
  } else {
    const pd: PendingDrain = { id: ctx.uid('drain'), actorId: a.id, dv, type, source: biName(spell), ts: ctx.now };
    m.pendingDrain[pd.id] = pd;
    drain = { pendingId: pd.id };
  }
  const targetIds = targets.map((t) => t.id);
  return {
    actor: a, spell, force, reckless, hits, roll, dv, drainType: type, drain, targets, area, logId: entry.id,
    result: { logId: entry.id, rollLogId: roll.logId, hits, rawHits: roll.rawHits, glitch: roll.glitch, critGlitch: roll.critGlitch, force, dv, drainType: type, drain, targetIds, area },
  };
}

function actorOf(ctx: ActionContext, id: unknown): Actor {
  const a = ctx.state.actors[str(id, 80)];
  if (!a) ctx.fail('Unknown character');
  if (!ctx.owns(a.id)) ctx.fail('This character is not yours');
  return a;
}

type SetTraditionPayload = { actorId?: ActorId; tradition?: unknown; drain?: unknown };

// ---------------------------------------------------------------------------
// Astral (SR5 pp. 312-315): state.magic.astral = who perceives / projects; astral forms are map tokens with `astral: true`
// (a projecting magician's form, a spirit on the astral plane) that only astral viewers see (filter below).
// ---------------------------------------------------------------------------

const STATUS_EMPTY_BODY = 'empty body'; // token status of a projecting magician's body (English key, statusText translates it)

/** Leave the astral plane: the astral form's tokens go, the body is no longer empty. */
function endProjection(state: TableState, actorId: ActorId): void {
  for (const map of Object.values(state.maps || {})) {
    map.tokens = (map.tokens || []).filter((t) => !(t.actorId === actorId && t.astral));
    for (const t of map.tokens) if (t.actorId === actorId && t.status?.includes(STATUS_EMPTY_BODY)) t.status = t.status.filter((s) => s !== STATUS_EMPTY_BODY);
  }
  for (const e of state.combat?.entries || []) if (e.actorId === actorId && e.mode === 'astral') e.mode = 'physical';
}

/** Does this user see astral forms? Their own astrally active characters (or spirits), or the GM's setting. */
function seesAstral(state: TableState, own: Set<string>): boolean {
  const m = state.magic;
  if (m?.settings?.showAstralToPlayers) return true;
  return [...own].some((id) => !!m?.astral?.[id] || (state.actors?.[id]?.spirit && !state.actors[id].spirit!.materialized));
}

// ---------------------------------------------------------------------------
// Spirits (SR5 pp. 300-304): a summoned spirit is an NPC actor (npc.kind 'spirit', actor.spirit) controlled by the player of
// its summoner: its id is added to that player's characterIds, so the sheet, rolls, token and combat rights follow.
// ---------------------------------------------------------------------------

const spiritsOf = (state: TableState, summonerId: ActorId): Actor[] => Object.values(state.actors || {}).filter((a) => a.spirit?.summonerId === summonerId);
const spiritName = (ctx: ActionContext, s: { name?: string; nameFr?: string } | null | undefined): string => (ctx.lang === 'en' ? s?.name : s?.nameFr || s?.name) || '?';

/** A spirit the user controls (the summoner's player or the GM). */
function spiritOf(ctx: ActionContext, id: unknown): Actor & { spirit: ActorSpirit } {
  const a = ctx.state.actors[str(id, 80)];
  if (!a?.spirit) ctx.fail('Unknown spirit');
  if (!ctx.owns(a.id) && !ctx.owns(a.spirit.summonerId)) ctx.fail('This spirit is not yours');
  return a as Actor & { spirit: ActorSpirit };
}

/** A spirit whose condition monitor is full is disrupted (SR5 p. 302). */
function isDisrupted(a: Actor): boolean {
  const d = deriveFull(a);
  return (a.condition?.physical || 0) >= d.physicalMonitor || (a.condition?.stun || 0) >= d.stunMonitor;
}

/** The spirit leaves (services done, released, sunrise, disrupted): actor, tokens and combat entries removed, logged. */
function dismissSpirit(ctx: ActionContext, sp: Actor, key: string): void {
  const summoner = ctx.state.actors[sp.spirit!.summonerId];
  const name = sp.name;
  removeActor(ctx.state, sp.id);
  const who = summoner || sp;
  ctx.log({ kind: 'magic', userId: ctx.user.id, author: who.name, i18n: { key, params: { name, summoner: summoner?.name || '?' } }, magic: { event: 'spirit', actorId: who.id }, ...(who.hidden ? { gmOnly: true } : {}) });
}

/** Spirits disrupted by damage leave (checked on magic actions and new Combat Turns). */
function sweepDisrupted(ctx: ActionContext): void {
  for (const a of Object.values(ctx.state.actors || {})) if (a.spirit && isDisrupted(a)) dismissSpirit(ctx, a, tk('{name} is disrupted and returns to its metaplane: its services are lost.'));
}
combatHooks.push((ctx: ActionContext, _c: TableState['combat'], event: string) => {
  if (event === 'newTurn') sweepDisrupted(ctx);
});

type SummonPayload = { actorId?: ActorId; type?: unknown; force?: unknown; optionalPowers?: unknown; explode?: unknown; modifier?: unknown; replace?: unknown };

/**
 * Summon a spirit (SR5 p. 300): Summoning + Magic [Force] vs the spirit's Force (rolled by the server, GM-only), Drain =
 * 2 × the spirit's hits (min 2), Physical if Force > Magic; net hits = services. One unbound spirit at a time.
 */
function summon(ctx: ActionContext, p: SummonPayload) {
  const a = actorOf(ctx, p.actorId);
  const mag = attr(a, 'MAG');
  if (mag <= 0) ctx.fail('{name} is not awakened', { name: a.name });
  const force = Math.round(Number(p.force));
  if (!Number.isFinite(force) || force < 1 || force > maxForce(a)) ctx.fail('The Force must be between 1 and {max} (twice your Magic)', { max: maxForce(a) });
  if (!drainAttr(a)) ctx.fail('Choose a tradition first: it sets the attribute you resist Drain with');
  const def = spiritDef(str(p.type, 120));
  if (!def) ctx.fail('Unknown spirit type');
  if (!ctx.isGM) {
    const allowed = traditionSpiritTypes(a.magic?.tradition, spiritDefs());
    if (!allowed.some((d) => d.id === def.id)) ctx.fail('Your tradition does not summon this kind of spirit');
  }
  const unbound = spiritsOf(ctx.state, a.id).filter((s) => !s.spirit!.bound);
  if (unbound.length && !p.replace) ctx.fail('{name} already has an unbound spirit: release it first', { name: a.name });
  // Optional powers (SR5 p. 300): one per 3 full points of Force, from the type's list.
  const wanted = [...new Set((Array.isArray(p.optionalPowers) ? p.optionalPowers : []).map((x) => str(x, 80)))];
  const opts = wanted.filter((n) => def.optionalPowers.some((o) => o.name === n)).slice(0, optionalPowerCount(force));
  const secret = hiddenCaster(a);
  const roll = performRoll(ctx, {
    actorId: a.id, skillId: 'summoning', label: `Invocation — ${def.nameFr || def.name}`, limit: force, explode: !!p.explode, modifier: p.modifier, // i18n-ignore: stored label
    ...(secret ? { secret: true } : {}),
  }, { logExtra: { labelI18n: { key: tk('Summoning — {spirit} (Force {force})'), params: { spirit: { fr: def.nameFr || def.name, en: def.name }, force } } } });
  // The spirit resists with its Force (GM-only roll).
  const sr = rollDice(force);
  ctx.log({
    kind: 'roll', userId: ctx.user.id, author: def.nameFr || def.name, text: `Force ${force}`, gmOnly: true,
    roll: { ...sr, label: `Force ${force}`, labelI18n: { key: tk('Spirit resists the summoning (Force {force})'), params: { force } }, actorId: null },
  });
  const net = roll.hits - sr.hits;
  const dv = Math.max(MIN_DRAIN, 2 * sr.hits);
  const type: 'P' | 'S' = force > mag ? 'P' : 'S';
  const spiritBi: BiName = { fr: def.nameFr || def.name, en: def.name };
  let spirit: Actor | null = null;
  if (net > 0) {
    for (const old of unbound) dismissSpirit(ctx, old, tk('{summoner} releases {name}.'));
    spirit = createSpirit(ctx, a, def, force, net, opts);
    logMagic(ctx, a, tk('{name} summons {spirit} (Force {force}): {n} service(s). Drain {dv}.'), { name: a.name, spirit: spiritBi, force, n: net, dv }, { event: 'summon', actorId: a.id, force, hits: roll.hits, dv, drainType: type }, secret);
  } else {
    logMagic(ctx, a, tk('{name} fails to summon {spirit} (Force {force}). Drain {dv}.'), { name: a.name, spirit: spiritBi, force, dv }, { event: 'summon', actorId: a.id, force, hits: roll.hits, dv, drainType: type }, secret);
  }
  const m = slice(ctx.state);
  let drain: { hits: number; damage: number } | { pendingId: string };
  if (m.settings.autoDrain) {
    const r = resistDrain(ctx, a, dv, type, spiritBi);
    drain = { hits: r.roll.hits, damage: r.damage };
  } else {
    const pd: PendingDrain = { id: ctx.uid('drain'), actorId: a.id, dv, type, source: spiritBi, ts: ctx.now };
    m.pendingDrain[pd.id] = pd;
    drain = { pendingId: pd.id };
  }
  return { hits: roll.hits, spiritHits: sr.hits, net, dv, drainType: type, drain, spiritId: spirit?.id || null, services: spirit ? net : 0 };
}

/** Use up drams of reagents from the actor's gear (any « Reagents » item, quantities as drams). */
function useReagents(a: Actor, drams: number): void {
  let left = drams;
  for (const g of a.gear || []) {
    if (left <= 0) break;
    if (!isReagent(g)) continue;
    const take = Math.min(left, Math.max(0, Number(g.qty) || 0));
    g.qty = (Number(g.qty) || 0) - take;
    left -= take;
  }
  a.gear = (a.gear || []).filter((g) => !isReagent(g) || (Number(g.qty) || 0) > 0);
}

/** Opposed test against a spirit (Force dice, + extra), rolled by the server and logged for the GM only. */
function spiritRoll(ctx: ActionContext, sp: Actor, dice: number, key: string) {
  const r = rollDice(dice);
  ctx.log({ kind: 'roll', userId: ctx.user.id, author: sp.name, text: `${dice}`, gmOnly: true, roll: { ...r, label: `${dice}`, labelI18n: { key, params: { n: dice } }, actorId: null } });
  return r;
}

/**
 * Bind a summoned spirit (SR5 pp. 300-301): Force × 25 drams of reagents used up, Binding + MAG [Force] vs Force × 2;
 * Drain 2 × the spirit's hits (min 2), Physical if Force > MAG; net hits beyond the first add services. Up to CHA bound.
 */
function bind(ctx: ActionContext, p: { spiritId?: unknown; explode?: unknown; modifier?: unknown; free?: unknown }) {
  const sp = spiritOf(ctx, p.spiritId);
  const a = actorOf(ctx, sp.spirit.summonerId);
  if (sp.spirit.bound) ctx.fail('{name} is already bound', { name: sp.name });
  const mag = attr(a, 'MAG');
  const bound = spiritsOf(ctx.state, a.id).filter((s) => s.spirit!.bound).length;
  if (bound >= attr(a, 'CHA')) ctx.fail('{name} already binds as many spirits as their Charisma ({n})', { name: a.name, n: attr(a, 'CHA') });
  const drams = sp.spirit.force * BINDING_DRAMS;
  const free = ctx.isGM && !!p.free;
  if (!free && reagentDrams(a) < drams) ctx.fail('Binding needs {n} drams of reagents ({have} carried)', { n: drams, have: reagentDrams(a) });
  if (!free) useReagents(a, drams);
  const secret = hiddenCaster(a);
  const roll = performRoll(ctx, {
    actorId: a.id, skillId: 'binding', label: `Lien — ${sp.name}`, limit: sp.spirit.force, explode: !!p.explode, modifier: p.modifier, ...(secret ? { secret: true } : {}), // i18n-ignore: stored label
  }, { logExtra: { labelI18n: { key: tk('Binding — {spirit} (Force {force})'), params: { spirit: sp.name, force: sp.spirit.force } } } });
  const sr = spiritRoll(ctx, sp, sp.spirit.force * 2, tk('Spirit resists the binding ({n} dice)'));
  const net = roll.hits - sr.hits;
  const dv = Math.max(MIN_DRAIN, 2 * sr.hits);
  const type: 'P' | 'S' = sp.spirit.force > mag ? 'P' : 'S';
  const source: BiName = { fr: sp.name, en: sp.name };
  if (net > 0) {
    sp.spirit.bound = true;
    sp.spirit.present = true;
    sp.spirit.services += net - 1;
    logMagic(ctx, a, tk('{name} binds {spirit}: it now owes {n} service(s). Drain {dv}.'), { name: a.name, spirit: sp.name, n: sp.spirit.services, dv }, { event: 'bind', actorId: a.id, force: sp.spirit.force, hits: roll.hits, dv, drainType: type }, secret);
  } else {
    logMagic(ctx, a, tk('{name} fails to bind {spirit}. Drain {dv}.'), { name: a.name, spirit: sp.name, dv }, { event: 'bind', actorId: a.id, force: sp.spirit.force, hits: roll.hits, dv, drainType: type }, secret);
  }
  const drain = drainNow(ctx, a, dv, type, source);
  return { hits: roll.hits, spiritHits: sr.hits, net, dv, drainType: type, drain, bound: net > 0, services: sp.spirit.services, drams: free ? 0 : drams };
}

/**
 * Banish a spirit (SR5 p. 301), the banisher's own or an enemy's: Banishing + MAG [Astral] vs Force (+ the summoner's MAG
 * if bound); each net hit removes a service, at 0 the spirit leaves. Drain 2 × the spirit's hits (min 2), Physical if
 * Force > the banisher's MAG.
 */
function banish(ctx: ActionContext, p: { actorId?: ActorId; spiritId?: unknown; explode?: unknown; modifier?: unknown }) {
  const a = actorOf(ctx, p.actorId);
  const sp = ctx.state.actors[str(p.spiritId, 80)];
  if (!sp?.spirit) ctx.fail('Unknown spirit');
  if (!ctx.isGM && sp.hidden) ctx.fail('Unknown spirit');
  const mag = attr(a, 'MAG');
  if (mag <= 0) ctx.fail('{name} is not awakened', { name: a.name });
  if (!drainAttr(a)) ctx.fail('Choose a tradition first: it sets the attribute you resist Drain with');
  const summoner = ctx.state.actors[sp.spirit.summonerId];
  const secret = hiddenCaster(a);
  const roll = performRoll(ctx, {
    actorId: a.id, skillId: 'banishing', label: `Bannissement — ${sp.name}`, explode: !!p.explode, modifier: p.modifier, ...(secret ? { secret: true } : {}), // i18n-ignore: stored label
  }, { logExtra: { labelI18n: { key: tk('Banishing — {spirit}'), params: { spirit: sp.name } } } });
  const dice = sp.spirit.force + (sp.spirit.bound && summoner ? attr(summoner, 'MAG') : 0);
  const sr = spiritRoll(ctx, sp, dice, tk('Spirit resists the banishing ({n} dice)'));
  const net = Math.max(0, roll.hits - sr.hits);
  const dv = Math.max(MIN_DRAIN, 2 * sr.hits);
  const type: 'P' | 'S' = sp.spirit.force > mag ? 'P' : 'S';
  const name = sp.name;
  let gone = false;
  if (net > 0) {
    sp.spirit.services = Math.max(0, sp.spirit.services - net);
    if (sp.spirit.services <= 0) {
      gone = true;
      dismissSpirit(ctx, sp, tk('{name} is banished and returns to its metaplane.'));
    }
  }
  logMagic(ctx, a, net > 0 ? tk('{name} banishes {spirit}: −{n} service(s). Drain {dv}.') : tk('{name} fails to banish {spirit}. Drain {dv}.'), { name: a.name, spirit: name, n: net, dv }, { event: 'banish', actorId: a.id, hits: roll.hits, dv, drainType: type }, secret);
  const drain = drainNow(ctx, a, dv, type, { fr: name, en: name });
  return { hits: roll.hits, spiritHits: sr.hits, net, dv, drainType: type, drain, gone, services: gone ? 0 : sp.spirit.services };
}

type RitualPayload = { leaderId?: unknown; ritualId?: unknown; force?: unknown; participantIds?: unknown; extraOfferings?: unknown; free?: unknown };

/** Leader, ritual, Force and participants of a ritual payload, checked (GM action). */
function ritualSetup(ctx: ActionContext, p: RitualPayload) {
  const leader = actorOf(ctx, p.leaderId);
  const ritual = (leader.spells || []).find((s) => s.id === str(p.ritualId, 80));
  if (!ritual) ctx.fail('Unknown spell');
  const force = Math.round(Number(p.force));
  if (!Number.isFinite(force) || force < 1 || force > maxForce(leader)) ctx.fail('The Force must be between 1 and {max} (twice your Magic)', { max: maxForce(leader) });
  const ids = [...new Set((Array.isArray(p.participantIds) ? p.participantIds : []).slice(0, 12).map((x) => str(x, 80)))].filter((id) => id && id !== leader.id);
  const participants = ids.map((id) => ctx.state.actors[id] || ctx.fail('Unknown character'));
  for (const a of [leader, ...participants]) {
    if (attr(a, 'MAG') <= 0) ctx.fail('{name} is not awakened', { name: a.name });
    if (!drainAttr(a)) ctx.fail('{name} has no tradition: it sets the attribute they resist Drain with', { name: a.name });
  }
  return { leader, ritual, force, participants };
}

/**
 * Seal a ritual (SR5 pp. 295-296), GM: the leader spends Force drams of reagents (+ Force more per −1 Drain), each participant
 * rolls Ritual Spellcasting + MAG (−2 for another tradition) as teamwork, the leader rolls Ritual Spellcasting + MAG
 * [Force] vs Force × 2; every participant resists Drain 2 × the opposition's hits (min 2), Physical if the leader's hits
 * exceed their Magic. The net hits are the ritual's effect (GM).
 */
function sealRitual(ctx: ActionContext, p: RitualPayload) {
  const { leader, ritual, force, participants } = ritualSetup(ctx, p);
  const extra = Math.max(0, Math.min(20, Math.round(Number(p.extraOfferings) || 0)));
  const drams = force * (1 + extra);
  if (!p.free) {
    if (reagentDrams(leader) < drams) ctx.fail('The ritual needs {n} drams of reagents ({have} carried)', { n: drams, have: reagentDrams(leader) });
    useReagents(leader, drams);
  }
  const trad = (a: Actor) => a.magic?.tradition?.id || a.magic?.tradition?.name || '';
  const assists = participants.map((a) => {
    const other = trad(a) !== trad(leader);
    const r = performRoll(ctx, {
      actorId: a.id, skillId: 'ritual_spellcasting', label: `Rituel — ${ritual.nameFr || ritual.name}`, limit: force, ...(other ? { modifier: -2 } : {}), // i18n-ignore: stored label
    }, { logExtra: { labelI18n: { key: tk('Ritual teamwork — {ritual}'), params: { ritual: biName(ritual) } } } });
    return { id: a.id, hits: r.hits, glitch: r.glitch, critGlitch: r.critGlitch };
  });
  const skill = (leader.skills || []).find((s) => s.id === 'ritual_spellcasting')?.rating || 0;
  const tw = teamwork(assists, skill);
  const roll = performRoll(ctx, {
    actorId: leader.id, skillId: 'ritual_spellcasting', label: `Rituel — ${ritual.nameFr || ritual.name}`, limit: force + tw.limit, // i18n-ignore: stored label
  }, { bonus: tw.dice ? [{ label: 'teamwork', value: tw.dice }] : [], logExtra: { labelI18n: { key: tk('Ritual — {ritual} (Force {force})'), params: { ritual: biName(ritual), force } } } });
  const opp = rollDice(force * 2);
  ctx.log({ kind: 'roll', userId: ctx.user.id, author: biName(ritual).fr, text: `${force * 2}`, gmOnly: true, roll: { ...opp, label: `${force * 2}`, labelI18n: { key: tk('The ritual resists ({n} dice)'), params: { n: force * 2 } }, actorId: null } });
  const net = Math.max(0, roll.hits - opp.hits);
  const dv = ritualDrain(opp.hits, extra);
  const type: 'P' | 'S' = roll.hits > attr(leader, 'MAG') ? 'P' : 'S';
  logMagic(ctx, leader, tk('Ritual {ritual} (Force {force}) led by {name} with {n} participant(s): {net} net hit(s). Drain {dv} for each.'), {
    ritual: biName(ritual), force, name: leader.name, n: participants.length, net, dv,
  }, { event: 'ritual', actorId: leader.id, force, hits: roll.hits, dv, drainType: type });
  if (roll.critGlitch) logMagic(ctx, leader, tk('Critical glitch on the ritual: anything goes — the GM decides (SR5 p. 296).'), {}, { event: 'ritual', actorId: leader.id });
  else if (roll.glitch) logMagic(ctx, leader, tk('Glitch on the ritual: usually +2 Drain, +2 to the ritual’s Force or the leader seals it alone (SR5 p. 296).'), {}, { event: 'ritual', actorId: leader.id });
  const drains = [leader, ...participants].map((a) => ({ id: a.id, drain: drainNow(ctx, a, dv, type, biName(ritual)) }));
  return { hits: roll.hits, opposition: opp.hits, net, dv, drainType: type, teamwork: tw, assists, drains, drams: p.free ? 0 : drams };
}

/** A ritual fails (SR5 p. 296): every participant takes Stun Drain 2 × the hits of a Force × 2 roll; reagents are lost. */
function failRitual(ctx: ActionContext, p: RitualPayload) {
  const { leader, ritual, force, participants } = ritualSetup(ctx, p);
  const r = rollDice(force * 2);
  const dv = Math.max(MIN_DRAIN, 2 * r.hits);
  logMagic(ctx, leader, tk('The ritual {ritual} fails: Drain {dv} (Stun) for each participant.'), { ritual: biName(ritual), dv }, { event: 'ritual', actorId: leader.id, force, dv, drainType: 'S' });
  const drains = [leader, ...participants].map((a) => ({ id: a.id, drain: drainNow(ctx, a, dv, 'S', biName(ritual)) }));
  return { dv, drains };
}

/** Drain resisted now (settings.autoDrain) or left pending. */
function drainNow(ctx: ActionContext, a: Actor, dv: number, type: 'P' | 'S', source: BiName): { hits: number; damage: number } | { pendingId: string } {
  const m = slice(ctx.state);
  if (m.settings.autoDrain) {
    const r = resistDrain(ctx, a, dv, type, source);
    return { hits: r.roll.hits, damage: r.damage };
  }
  const pd: PendingDrain = { id: ctx.uid('drain'), actorId: a.id, dv, type, source, ts: ctx.now };
  m.pendingDrain[pd.id] = pd;
  return { pendingId: pd.id };
}

/**
 * A spirit's natural attacks (unarmed, Elemental Attack, Engulf, Natural Weapon: shared/magic.ts spiritWeapons) as sheet weapons,
 * rebuilt from its powers and Force; its other weapons are kept. Called at summoning and at boot (spirits summoned before).
 */
function syncSpiritWeapons(a: Actor): void {
  if (!a.spirit) return;
  a.weapons = [...spiritWeapons(a), ...(a.weapons || []).filter((w) => w && !w.natural)];
}

/** The spirit's NPC actor (SR5 pp. 303-304 via spiritStats), assigned to the summoner's player(s). */
function createSpirit(ctx: ActionContext, summoner: Actor, def: NonNullable<ReturnType<typeof spiritDef>>, force: number, services: number, optional: string[]): Actor {
  const st = spiritStats(def, force);
  const label = spiritName(ctx, def);
  const sp = blankActor('npc', `${label} (${summoner.name})`.slice(0, 80)) as unknown as Actor;
  sp.id = ctx.uid('npc');
  sp.metatype = def.name;
  sp.attributes = st.attributes;
  sp.initiative = st.initiative;
  sp.skills = st.skills;
  const power = (pw: { name: string; nameFr?: string; select?: string }): AdeptPower => ({ id: uid('pow'), name: pw.name, ...(pw.nameFr ? { nameFr: pw.nameFr } : {}), ...(pw.select ? { choice: pw.select } : {}) });
  sp.powers = [...st.powers.map(power), ...optional.map((n) => def.optionalPowers.find((o) => o.name === n)!).filter(Boolean).map(power)];
  sp.npc = { ...(sp.npc || {}), kind: 'spirit', initMode: 'astral', professionalRating: 0 };
  sp.disposition = summoner.type === 'pc' ? 'ally' : summoner.disposition || 'neutral';
  if (summoner.color) sp.color = summoner.color;
  if (summoner.hidden) sp.hidden = true;
  sp.spirit = { type: def.name, ...(def.nameFr ? { typeFr: def.nameFr } : {}), force, summonerId: summoner.id, services, bound: false, materialized: false, optionalPowers: optional, ts: ctx.now };
  syncSpiritWeapons(sp);
  sp.notes = [def.source && def.page ? `${def.source} p. ${def.page}` : '', def.movement?.walk ? `${def.movement.walk} / ${def.movement.run || ''} / ${def.movement.sprint || ''}` : ''].filter(Boolean).join(' · ');
  normalizeActor(sp, uid);
  ctx.state.actors[sp.id] = sp;
  for (const u of Object.values(ctx.state.users || {})) {
    if ((u.characterIds || []).includes(summoner.id) && !u.characterIds.includes(sp.id)) u.characterIds.push(sp.id);
  }
  // It arrives on the astral plane next to its summoner (SR5 p. 300): an astral token on the shown map.
  const map = ctx.state.scene?.activeMapId ? ctx.state.maps?.[ctx.state.scene.activeMapId] : null;
  const near = map ? tokenOf(map, summoner.id) : null;
  if (map && near) placeActorToken(ctx.state, map, sp, near.x, near.y, { disposition: sp.disposition || 'ally', hidden: !!sp.hidden, astral: true });
  return sp;
}

const actions: Record<string, ActionDef> = {
  /**
   * { actorId, tradition: id | Chummer name | null, drain?: 'LOG'|'CHA'|'INT'|'MAG'|'WIL' }. GM: any change (null clears).
   * Owner: only while the character has no tradition, or to choose the drain attribute of a tradition without one (Custom).
   */
  'magic/setTradition': {
    role: 'any',
    handler(ctx: ActionContext, p: SetTraditionPayload = {}) {
      const a = actorOf(ctx, p.actorId);
      const ref = str(p.tradition, 120).trim();
      const drain = p.drain === undefined || p.drain === null || p.drain === '' ? null : (str(p.drain, 3) as AttrKey);
      if (drain && !DRAIN_ATTRS.includes(drain)) ctx.fail('Invalid Drain attribute');
      const cur = a.magic?.tradition || null;
      if (!ctx.isGM) {
        if (!isAwakened(a)) ctx.fail('{name} is not awakened', { name: a.name });
        const sameNoDrain = !!cur && !cur.drain && (!ref || ref === cur.id || ref === cur.name);
        if (cur && !sameNoDrain) ctx.fail('Only the GM can change a tradition once it is chosen');
      }
      if (!ref) {
        if (cur && !cur.drain && drain) {
          cur.drain = drain;
          return { tradition: cur };
        }
        if (!ctx.isGM) ctx.fail('Choose a tradition');
        if (a.magic) delete a.magic.tradition;
        return { tradition: null };
      }
      // Same tradition, drain chosen (Custom, or a home-made one imported from Chummer): changed in place.
      if (cur && drain && (ref === cur.id || ref === cur.name) && !traditionDef(ref)?.drain) {
        cur.drain = drain;
        return { tradition: cur };
      }
      const t = actorTradition(ref, drain);
      if (!t) ctx.fail('Unknown tradition: {name}', { name: ref });
      a.magic = a.magic && typeof a.magic === 'object' ? a.magic : {};
      a.magic.tradition = t;
      return { tradition: t };
    },
  },

  /**
   * { actorId, spellId, force, reckless?, explode?, modifier?, conditions?, ignore?, mapId?, targetIds?, area?: {x, y}, drainDv? }
   * (owner or GM). drainDv: the Drain Value when the spell's formula is not « F ± n ».
   */
  'magic/cast': {
    role: 'any',
    handler(ctx: ActionContext, p: CastPayload = {}) {
      const c = castSpell(ctx, p);
      // Sustain (SR5 p. 282): a Sustained / Permanent spell that worked, unless the caster lets it go (sustain: false).
      let sustainedId: string | null = null;
      if (p.sustain !== false && c.hits > 0 && isSustainable(c.spell.duration)) {
        const s: SustainedSpell = {
          id: ctx.uid('sus'), casterId: c.actor.id, spellId: c.spell.id, name: biName(c.spell), force: c.force, hits: c.hits,
          targetIds: c.targets.map((t) => t.id), ts: ctx.now,
          ...(/^P$/i.test(String(c.spell.duration).trim()) ? { turnsLeft: c.force } : {}),
          ...(c.area && str(p.mapId, 80) ? { area: { mapId: str(p.mapId, 80), ...c.area } } : {}),
        };
        // A sustaining focus of the spell's category, Force ≥ the spell's, not already busy (SR5 p. 320).
        if (p.sustainFocusId) {
          const g = (c.actor.gear || []).find((x) => x.id === str(p.sustainFocusId, 80));
          if (!g || focusKind(g) !== 'sustaining' || !focusWorks(g)) ctx.fail('Choose an active, bonded sustaining focus');
          if (focusCategory(g) !== spellCategory(c.spell.category)) ctx.fail('This focus sustains another category of spells');
          if (focusForce(g) < c.force) ctx.fail('The focus’s Force ({f}) is below the spell’s ({force})', { f: focusForce(g), force: c.force });
          if (Object.values(slice(ctx.state).sustained).some((x) => x.by?.kind === 'focus' && x.by.gearId === g.id)) ctx.fail('This focus already sustains a spell');
          s.by = { kind: 'focus', gearId: g.id };
        }
        slice(ctx.state).sustained[s.id] = s;
        syncSustained(ctx.state);
        sustainedId = s.id;
      }
      // Combat spell (SR5 p. 283): one attack per target, resolved by the attacks module (resist / dodge, soak, damage).
      const attackIds: string[] = [];
      if (spellCategory(c.spell.category) === 'combat' && c.hits > 0) {
        const profile = combatSpellProfile(c.spell, spellCatalogInfo(c.spell));
        for (const t of c.targets) {
          const atk = addSpellAttack(ctx, {
            attacker: c.actor, target: t, mapId: str(p.mapId, 80) || null, hits: c.hits, spellName: biName(c.spell), profile, force: c.force,
            castLogId: c.logId, rollLogId: c.roll.logId, gmOnly: hiddenCaster(c.actor),
          });
          attackIds.push(atk.id);
        }
      }
      // Non-combat spell with an Opposed Test (SR5 pp. 285-292): each target resists from the attack tray (net hits, no damage).
      let object: { pool: number; hits: number; net: number } | null = null;
      const resistance = spellCategory(c.spell.category) !== 'combat' ? spellResistance(c.spell, spellCatalogInfo(c.spell)) : null;
      if (resistance && c.hits > 0) {
        for (const t of c.targets) {
          if (t.id === c.actor.id) continue; // a caster does not resist their own spell
          const atk = addSpellAttack(ctx, {
            attacker: c.actor, target: t, mapId: str(p.mapId, 80) || null, hits: c.hits, spellName: biName(c.spell), force: c.force, noDamage: true,
            profile: { mode: 'direct', resist: resistance.attrs[0], resist2: resistance.attrs[1] || null, damage: 'P', element: null },
            castLogId: c.logId, rollLogId: c.roll.logId, gmOnly: hiddenCaster(c.actor),
          });
          attackIds.push(atk.id);
        }
      }
      // An object resists with its Object Resistance (SR5 p. 295): rolled at once.
      const objPool = Math.round(Number(isObj(p.object) ? p.object.resistance : p.object));
      if (Number.isFinite(objPool) && objPool > 0) {
        if (!OBJECT_RESISTANCE.some((o) => o.value === objPool) && !ctx.isGM) ctx.fail('Unknown Object Resistance');
        const r = performRoll(ctx, { pool: Math.min(30, objPool), label: tk('Object Resistance'), limit: null, ...(hiddenCaster(c.actor) ? { secret: true } : {}) }, {
          logExtra: { labelI18n: { key: tk('Object Resistance ({n}) against {spell}'), params: { n: objPool, spell: biName(c.spell) } } },
        });
        object = { pool: objPool, hits: r.hits, net: Math.max(0, c.hits - r.hits) };
        logMagic(ctx, c.actor, object.net ? tk('{spell} overcomes the object: {n} net hit(s).') : tk('The object resists {spell}.'), { spell: biName(c.spell), n: object.net }, { event: 'cast', actorId: c.actor.id, spellId: c.spell.id }, hiddenCaster(c.actor));
      }
      return { ...c.result, sustainedId, attackIds, object };
    },
  },

  /** { actorId, type, force, optionalPowers?, explode?, modifier?, replace? } (owner or GM): summon a spirit (SR5 p. 300). */
  'magic/summon': {
    role: 'any',
    handler(ctx: ActionContext, p: SummonPayload = {}) {
      sweepDisrupted(ctx);
      return summon(ctx, p);
    },
  },

  /** { spiritId, delta } — services owed: the summoner's player may only use one (−1), the GM sets any. At 0 the spirit leaves. */
  'magic/spiritServices': {
    role: 'any',
    handler(ctx: ActionContext, p: { spiritId?: unknown; delta?: unknown } = {}) {
      const sp = spiritOf(ctx, p.spiritId);
      const d = Math.round(Number(p.delta)) || 0;
      if (!ctx.isGM && d !== -1) ctx.fail('Only the GM can add services');
      sp.spirit.services = Math.max(0, Math.min(30, sp.spirit.services + d));
      if (sp.spirit.services <= 0) {
        dismissSpirit(ctx, sp, tk('{name} has no service left and returns to its metaplane.'));
        return { services: 0, gone: true };
      }
      return { services: sp.spirit.services };
    },
  },

  /** { spiritId, materialized, mapId? } — materialize next to the summoner on the map (token), or go back to the astral plane. */
  'magic/materialize': {
    role: 'any',
    handler(ctx: ActionContext, p: { spiritId?: unknown; materialized?: unknown; mapId?: unknown } = {}) {
      const sp = spiritOf(ctx, p.spiritId);
      const on = !!p.materialized;
      if (on && sp.spirit.present === false) ctx.fail('{name} is resting on its metaplane: call it first', { name: sp.name });
      sp.spirit.materialized = on;
      sp.npc = { ...(sp.npc || {}), initMode: on ? 'physical' : 'astral' };
      for (const e of ctx.state.combat?.entries || []) if (e.actorId === sp.id) e.mode = on ? 'physical' : 'astral';
      // Its token stays: physical (materialized, dual-natured) or astral (seen by astral viewers only).
      for (const map of Object.values(ctx.state.maps || {})) for (const t of map.tokens || []) if (t.actorId === sp.id) t.astral = !on || undefined;
      const mapId = str(p.mapId, 80) || ctx.state.scene?.activeMapId || '';
      const map = mapId ? ctx.state.maps?.[mapId] : null;
      if (map && !tokenOf(map, sp.id)) {
        const near = tokenOf(map, sp.spirit.summonerId);
        placeActorToken(ctx.state, map, sp, near ? near.x : Math.floor(map.width / 2), near ? near.y : Math.floor(map.height / 2), { disposition: sp.disposition || 'ally', hidden: !!sp.hidden, ...(on ? {} : { astral: true }) });
      }
      for (const m of Object.values(ctx.state.maps || {})) for (const t of m.tokens || []) if (t.actorId === sp.id && !t.astral) delete t.astral;
      logMagic(ctx, ctx.state.actors[sp.spirit.summonerId] || sp, on ? tk('{name} materializes.') : tk('{name} returns to the astral plane.'), { name: sp.name }, { event: 'spirit', actorId: sp.id }, !!sp.hidden);
      return { materialized: on };
    },
  },

  /** { spiritId } — the spirit joins the fight (SR5 p. 302: the whole fight is one service for an unbound spirit). */
  'magic/spiritCombat': {
    role: 'any',
    handler(ctx: ActionContext, p: { spiritId?: unknown } = {}) {
      const sp = spiritOf(ctx, p.spiritId);
      const c = ctx.state.combat;
      if (!c?.active) ctx.fail('No fight in progress');
      if (sp.spirit.present === false) ctx.fail('{name} is resting on its metaplane: call it first', { name: sp.name });
      if ((c.entries || []).some((e) => e.actorId === sp.id)) ctx.fail('{name} is already in the fight', { name: sp.name });
      const map = c.mapId ? ctx.state.maps?.[c.mapId] : null;
      const tok = tokenOf(map || null, sp.id);
      addEntries(ctx, c, tok ? { tokenIds: [tok.id] } : { actorIds: [sp.id] });
      if (!sp.spirit.bound) sp.spirit.services = Math.max(0, sp.spirit.services - 1);
      logMagic(ctx, ctx.state.actors[sp.spirit.summonerId] || sp, tk('{name} joins the fight (one service).'), { name: sp.name }, { event: 'spirit', actorId: sp.id }, !!sp.hidden);
      return { services: sp.spirit.services };
    },
  },

  /** { spiritId } — release the spirit (it returns to its metaplane). */
  'magic/release': {
    role: 'any',
    handler(ctx: ActionContext, p: { spiritId?: unknown } = {}) {
      const sp = spiritOf(ctx, p.spiritId);
      dismissSpirit(ctx, sp, tk('{summoner} releases {name}.'));
      return true;
    },
  },

  /** { spiritId, explode?, modifier?, free? (GM: no reagents) } — bind a summoned spirit (SR5 pp. 300-301). */
  'magic/bind': {
    role: 'any',
    handler(ctx: ActionContext, p: { spiritId?: unknown; explode?: unknown; modifier?: unknown; free?: unknown } = {}) {
      sweepDisrupted(ctx);
      return bind(ctx, p);
    },
  },

  /** { actorId, spiritId, explode?, modifier? } — banish a spirit, one's own or an enemy's (SR5 p. 301). */
  'magic/banish': {
    role: 'any',
    handler(ctx: ActionContext, p: { actorId?: ActorId; spiritId?: unknown; explode?: unknown; modifier?: unknown } = {}) {
      sweepDisrupted(ctx);
      return banish(ctx, p);
    },
  },

  /** { spiritId, present } — call a bound spirit to its summoner, or send it to rest on its metaplane (Simple Action). */
  'magic/callSpirit': {
    role: 'any',
    handler(ctx: ActionContext, p: { spiritId?: unknown; present?: unknown } = {}) {
      const sp = spiritOf(ctx, p.spiritId);
      if (!sp.spirit.bound) ctx.fail('Only a bound spirit rests on its metaplane');
      const on = !!p.present;
      sp.spirit.present = on;
      if (on) {
        const map = ctx.state.scene?.activeMapId ? ctx.state.maps?.[ctx.state.scene.activeMapId] : null;
        const near = map ? tokenOf(map, sp.spirit.summonerId) : null;
        if (map && near && !tokenOf(map, sp.id)) placeActorToken(ctx.state, map, sp, near.x, near.y, { disposition: sp.disposition || 'ally', hidden: !!sp.hidden, astral: true });
      }
      if (!on) {
        sp.spirit.materialized = false;
        for (const map of Object.values(ctx.state.maps || {})) map.tokens = (map.tokens || []).filter((t) => t.actorId !== sp.id);
        for (const e of ctx.state.combat?.entries || []) if (e.actorId === sp.id) e.out = true;
      }
      logMagic(ctx, ctx.state.actors[sp.spirit.summonerId] || sp, on ? tk('{name} answers the call.') : tk('{name} goes back to rest on its metaplane.'), { name: sp.name }, { event: 'spirit', actorId: sp.id }, !!sp.hidden);
      return { present: on };
    },
  },

  /** { sustainedId, spiritId } — a bound spirit sustains a spell of its summoner for Force Combat Turns (one service). */
  'magic/spiritSustain': {
    role: 'any',
    handler(ctx: ActionContext, p: { sustainedId?: unknown; spiritId?: unknown } = {}) {
      const s = slice(ctx.state).sustained[str(p.sustainedId, 80)];
      if (!s) ctx.fail('This spell is no longer sustained');
      const sp = spiritOf(ctx, p.spiritId);
      if (sp.spirit.summonerId !== s.casterId) ctx.fail('Only a spirit of the caster can sustain it');
      if (!sp.spirit.bound) ctx.fail('Only a bound spirit can sustain a spell');
      if (sp.spirit.present === false) ctx.fail('{name} is resting on its metaplane: call it first', { name: sp.name });
      if (sp.spirit.services <= 0) ctx.fail('{name} owes no service', { name: sp.name });
      sp.spirit.services -= 1;
      s.by = { kind: 'spirit', actorId: sp.id, turnsLeft: sp.spirit.force };
      syncSustained(ctx.state);
      const caster = ctx.state.actors[s.casterId];
      logMagic(ctx, caster || sp, tk('{spirit} sustains {spell} for {n} Combat Turn(s) (one service).'), { spirit: sp.name, spell: s.name, n: sp.spirit.force }, { event: 'spirit', actorId: sp.id }, !!sp.hidden);
      return { turns: sp.spirit.force, services: sp.spirit.services };
    },
  },

  /**
   * { actorId, mode: 'perceiving' | 'projecting' | null, mapId? } — astral perception (SR5 p. 312: magicians, adepts with the
   * power) or projection (p. 313: magicians): the body stays (status « empty body »), an astral token appears next to it;
   * astral initiative in a fight. null: back to the physical plane.
   */
  'magic/astral': {
    role: 'any',
    handler(ctx: ActionContext, p: { actorId?: ActorId; mode?: unknown; mapId?: unknown } = {}) {
      const a = actorOf(ctx, p.actorId);
      const m = slice(ctx.state);
      const mode = p.mode === 'perceiving' || p.mode === 'projecting' ? p.mode : null;
      if (mode === 'perceiving' && !ctx.isGM && !canPerceiveAstral(a)) ctx.fail('{name} cannot perceive the astral plane', { name: a.name });
      if (mode === 'projecting' && !ctx.isGM && !canProjectAstral(a)) ctx.fail('Only magicians can project their astral form');
      const was = m.astral[a.id]?.mode || null;
      if (was === 'projecting' && mode !== 'projecting') endProjection(ctx.state, a.id);
      if (!mode) {
        delete m.astral[a.id];
        logMagic(ctx, a, tk('{name} returns to the physical plane.'), { name: a.name }, { event: 'astral', actorId: a.id }, hiddenCaster(a));
        return { mode: null };
      }
      const entry: TableState['magic']['astral'][string] = { mode, since: ctx.now };
      if (mode === 'projecting' && was !== 'projecting') {
        const mapId = str(p.mapId, 80) || ctx.state.scene?.activeMapId || '';
        const map = mapId ? ctx.state.maps?.[mapId] : null;
        const body = map ? tokenOf(map, a.id) : null;
        if (map && body) {
          body.status = [...new Set([...(body.status || []), STATUS_EMPTY_BODY])];
          placeActorToken(ctx.state, map, a, body.x, body.y, { name: a.name, disposition: body.disposition, hidden: !!body.hidden, astral: true });
          entry.mapId = map.id;
        }
        for (const e of ctx.state.combat?.entries || []) if (e.actorId === a.id) e.mode = 'astral';
      }
      m.astral[a.id] = entry;
      logMagic(ctx, a, mode === 'projecting' ? tk('{name} projects their astral form: the body stays behind, empty.') : tk('{name} perceives the astral plane.'), { name: a.name }, { event: 'astral', actorId: a.id }, hiddenCaster(a));
      return { mode };
    },
  },

  /**
   * { actorId, targetId, mapId?, damage: 'P' | 'S' } — unarmed astral attack (SR5 p. 315): Astral Combat + WIL [Astral] vs
   * INT + LOG; DV = astral Strength (CHA when projecting, Force for a spirit, else STR) + net hits, Stun or Physical.
   */
  'magic/astralAttack': {
    role: 'any',
    handler(ctx: ActionContext, p: { actorId?: ActorId; targetId?: unknown; mapId?: unknown; damage?: unknown } = {}) {
      const a = actorOf(ctx, p.actorId);
      const m = slice(ctx.state);
      const astralOf = (x: Actor) => !!m.astral[x.id] || (!!x.spirit && !x.spirit.materialized);
      if (!astralOf(a) && !(a.spirit && a.spirit.materialized)) ctx.fail('{name} is not on the astral plane', { name: a.name });
      const t = ctx.state.actors[str(p.targetId, 80)];
      if (!t) ctx.fail('Unknown character');
      if (t.id === a.id) ctx.fail('You can\'t target yourself');
      const secret = hiddenCaster(a);
      const roll = performRoll(ctx, { actorId: a.id, skillId: 'astral_combat', label: tk('Astral combat'), ...(secret ? { secret: true } : {}) });
      const projecting = m.astral[a.id]?.mode === 'projecting';
      const dv = a.spirit ? a.spirit.force : attr(a, projecting ? 'CHA' : 'STR');
      // The target soaks with its astral body (WIL when projecting or an astral spirit) or its physical body (BOD).
      const astralForm = m.astral[t.id]?.mode === 'projecting' || (!!t.spirit && !t.spirit.materialized);
      const atk = addAstralAttack(ctx, {
        attacker: a, target: t, mapId: str(p.mapId, 80) || ctx.state.scene?.activeMapId || null, hits: roll.hits, dv, type: p.damage === 'S' ? 'S' : 'P',
        soak: astralForm ? 'WIL' : 'BOD', rollLogId: roll.logId, gmOnly: secret,
      });
      return { attackId: atk.id, hits: roll.hits, dv };
    },
  },

  /** { actorId, gearId, weaponId | null } — the melee weapon a weapon focus is (SR5 p. 320): its Force adds to that weapon's attacks. */
  'magic/focusWeapon': {
    role: 'any',
    handler(ctx: ActionContext, p: { actorId?: ActorId; gearId?: unknown; weaponId?: unknown } = {}) {
      const a = actorOf(ctx, p.actorId);
      const g = (a.gear || []).find((x) => x.id === str(p.gearId, 80));
      if (!g || focusKind(g) !== 'weapon') ctx.fail('Choose a weapon focus');
      const wid = str(p.weaponId, 80);
      if (wid) {
        const w = (a.weapons || []).find((x) => x.id === wid);
        if (!w || w.kind !== 'melee') ctx.fail('A weapon focus is a melee weapon');
        g.choice = wid;
      } else g.choice = null;
      return { weaponId: g.choice || null };
    },
  },

  /** GM: { leaderId, ritualId, force, participantIds?, extraOfferings?, free? } — seal a ritual (SR5 pp. 295-296). */
  'magic/ritual': {
    role: 'gm',
    handler(ctx: ActionContext, p: RitualPayload = {}) {
      return sealRitual(ctx, p);
    },
  },

  /** GM: { leaderId, ritualId, force, participantIds? } — the ritual fails (a participant left, the lodge broke…). */
  'magic/ritualFail': {
    role: 'gm',
    handler(ctx: ActionContext, p: RitualPayload = {}) {
      return failRitual(ctx, p);
    },
  },

  /** GM: sunrise or sunset — every unbound spirit leaves with its services (SR5 p. 300). */
  'magic/sunrise': {
    role: 'gm',
    handler(ctx: ActionContext) {
      let n = 0;
      for (const a of Object.values(ctx.state.actors || {})) {
        if (a.spirit && !a.spirit.bound) {
          dismissSpirit(ctx, a, tk('Sunrise / sunset: {name} leaves.'));
          n++;
        }
      }
      return { left: n };
    },
  },

  /**
   * { sustainedId, karma } (the caster's owner or GM) — Quickening (SR5 p. 326): 1 … Force karma spent, the spell becomes
   * permanent (no −2; the karma is its bonus against dispelling).
   */
  'magic/quicken': {
    role: 'any',
    handler(ctx: ActionContext, p: { sustainedId?: unknown; karma?: unknown } = {}) {
      const s = slice(ctx.state).sustained[str(p.sustainedId, 80)];
      if (!s) ctx.fail('This spell is no longer sustained');
      const a = actorOf(ctx, s.casterId);
      if (!ctx.isGM && !hasMetamagic(a, 'quickening')) ctx.fail('{name} does not know Quickening', { name: a.name });
      if (s.by?.kind === 'quickened') ctx.fail('This spell is already quickened');
      const k = Math.round(Number(p.karma));
      if (!Number.isFinite(k) || k < 1 || k > s.force) ctx.fail('Quickening costs 1 to {n} karma (the spell’s Force)', { n: s.force });
      if ((a.karma || 0) < k) ctx.fail('{name} does not have {n} karma', { name: a.name, n: k });
      a.karma -= k;
      a.history = Array.isArray(a.history) ? a.history : [];
      a.history.push({ ts: ctx.now, text: tk('Quickening: {spell} ({n} karma)'), i18n: { key: tk('Quickening: {spell} ({n} karma)'), params: { spell: s.name, n: k } }, karma: -k });
      s.by = { kind: 'quickened', karma: k };
      delete s.turnsLeft;
      syncSustained(ctx.state);
      logMagic(ctx, a, tk('{name} quickens {spell} with {n} karma: the spell is permanent.'), { name: a.name, spell: s.name, n: k }, { event: 'quicken', actorId: a.id, spellId: s.spellId, force: s.force }, hiddenCaster(a));
      return { karma: k };
    },
  },

  /** { id } (the caster's owner or GM): stop sustaining a spell. */
  'magic/drop': {
    role: 'any',
    handler(ctx: ActionContext, p: { id?: unknown } = {}) {
      const s = slice(ctx.state).sustained[str(p.id, 80)];
      if (!s) ctx.fail('This spell is no longer sustained');
      actorOf(ctx, s.casterId);
      dropSustained(ctx, s, tk('{name} stops sustaining {spell} (Force {force}).'));
      return true;
    },
  },

  /** { id } (owner or GM): resist a pending Drain (settings.autoDrain off). */
  'magic/resistDrain': {
    role: 'any',
    handler(ctx: ActionContext, p: { id?: unknown } = {}) {
      const m = slice(ctx.state);
      const pd = m.pendingDrain[str(p.id, 80)];
      if (!pd) ctx.fail('No Drain to resist');
      const a = actorOf(ctx, pd.actorId);
      delete m.pendingDrain[pd.id];
      const r = resistDrain(ctx, a, pd.dv, pd.type, pd.source);
      return { hits: r.roll.hits, damage: r.damage };
    },
  },

  /** { autoDrain?, showAstralToPlayers? } (GM). */
  'magic/settings': {
    role: 'gm',
    handler(ctx: ActionContext, p: Partial<MagicSettings> = {}) {
      const m = slice(ctx.state);
      if (p.autoDrain !== undefined) m.settings.autoDrain = !!p.autoDrain;
      if (p.showAstralToPlayers !== undefined) m.settings.showAstralToPlayers = !!p.showAstralToPlayers;
      return { settings: m.settings };
    },
  },
};

const mod: ServerModule = {
  name: 'magic',

  init(state) {
    const m = slice(state);
    // Entries of deleted actors go away.
    for (const [id, s] of Object.entries(m.sustained)) if (!isObj(s) || !state.actors?.[s.casterId]) delete m.sustained[id];
    for (const id of Object.keys(m.astral)) if (!state.actors?.[id]) delete m.astral[id];
    for (const [id, d] of Object.entries(m.pendingDrain)) if (!isObj(d) || !state.actors?.[d.actorId]) delete m.pendingDrain[id];
    syncSustained(state);
    for (const a of Object.values(state.actors || {})) if (isObj(a) && a.spirit) syncSpiritWeapons(a);
  },

  actions,

  /** Players: the spells their characters sustain or are under, their own astral state (all of them when the GM shows them). */
  filter(view, user, full) {
    const m = view.magic;
    if (!m) return;
    const own = new Set(user.characterIds || []);
    m.sustained = Object.fromEntries(Object.entries(m.sustained || {}).filter(([, s]) => own.has(s.casterId) || (s.targetIds || []).some((id) => own.has(id))));
    m.pendingDrain = Object.fromEntries(Object.entries(m.pendingDrain || {}).filter(([, d]) => own.has(d.actorId)));
    // Astral forms on the map: the token's controller, or a user with an astrally active character (SR5 p. 312).
    const astralSight = seesAstral(full, own);
    for (const map of Object.values(view.maps || {})) {
      if (!astralSight) map.tokens = (map.tokens || []).filter((t) => !t.astral || (!!t.actorId && own.has(t.actorId)));
    }
    if (!m.settings?.showAstralToPlayers) m.astral = Object.fromEntries(Object.entries(m.astral || {}).filter(([id]) => own.has(id)));
  },
};

export default mod;
