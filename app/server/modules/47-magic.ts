// Magic module: owner of state.magic (settings, sustained spells, astral presences) and of `actor.magic.tradition`.
// Design and the features still to come (cast flow, sustaining, spirits, astral, foci…): docs/design/magic.md.
// Feature page: docs/modules/magic.md. Rules data: shared/magic.ts; traditions: server/lib/traditions.ts.
import { attr } from '../../shared/sr5.ts';
import { cellDistance } from '../../shared/combat.ts';
import { hasLineOfSight } from '../../shared/vision.ts';
import {
  isAwakened, DRAIN_ATTRS, drainAttr, drainValue, spellDrainType, spellReach, isAreaSpell, spellCategory, maxForce, RECKLESS_DV,
  isSustainable, spellEffects, combatSpellProfile, NO_AURA_KINDS,
} from '../../shared/magic.ts';
import { spellCatalogInfo } from '../lib/spells.ts';
import { addSpellAttack } from './33-attacks.ts';
import { combatHooks } from './30-combat.ts';
import { actorTradition, traditionDef } from '../lib/traditions.ts';
import { performRoll, applyDamage } from './10-characters.ts';
import type { PerformedRoll } from './10-characters.ts';
import type {
  ActionContext, ActionDef, Actor, ActorId, AttrKey, BiName, GameMap, I18nParams, MagicLogInfo, MagicSettings, MagicState, PendingDrain,
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
    if (!s.by || s.by.kind === 'caster') (sustaining[caster.id] ||= []).push({ id: s.id, name: s.name, force: s.force });
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
    if (c) area = { ...c, radius: force };
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
  const roll = performRoll(ctx, {
    actorId: a.id, skillId: 'spellcasting', label: spellRollLabel(spell.nameFr || spell.name), limit: force, explode: !!p.explode,
    modifier: p.modifier, conditions, ignore: p.ignore, ...(secret ? { secret: true } : {}),
  }, { logExtra: { labelI18n: { key: tk('Spell — {spell} (Force {force})'), params: { spell: biName(spell), force } } } });
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
      return { ...c.result, sustainedId, attackIds };
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
  },

  actions,

  /** Players: the spells their characters sustain or are under, their own astral state (all of them when the GM shows them). */
  filter(view, user) {
    const m = view.magic;
    if (!m) return;
    const own = new Set(user.characterIds || []);
    m.sustained = Object.fromEntries(Object.entries(m.sustained || {}).filter(([, s]) => own.has(s.casterId) || (s.targetIds || []).some((id) => own.has(id))));
    m.pendingDrain = Object.fromEntries(Object.entries(m.pendingDrain || {}).filter(([, d]) => own.has(d.actorId)));
    if (!m.settings?.showAstralToPlayers) m.astral = Object.fromEntries(Object.entries(m.astral || {}).filter(([id]) => own.has(id)));
  },
};

export default mod;
