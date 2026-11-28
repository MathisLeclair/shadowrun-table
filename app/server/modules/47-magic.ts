// Magic module: owner of state.magic (settings, sustained spells, astral presences) and of `actor.magic.tradition`.
// Design and the features still to come (cast flow, sustaining, spirits, astral, foci…): docs/design/magic.md.
// Feature page: docs/modules/magic.md. Rules data: shared/magic.ts; traditions: server/lib/traditions.ts.
import { isAwakened, DRAIN_ATTRS } from '../../shared/magic.ts';
import { actorTradition, traditionDef } from '../lib/traditions.ts';
import type { ActionContext, ActionDef, Actor, ActorId, AttrKey, MagicSettings, MagicState, ServerModule, TableState } from '../../shared/types.ts';

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
  return m;
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
  },

  actions,

  /** Players: the spells their characters sustain or are under, their own astral state (all of them when the GM shows them). */
  filter(view, user) {
    const m = view.magic;
    if (!m) return;
    const own = new Set(user.characterIds || []);
    m.sustained = Object.fromEntries(Object.entries(m.sustained || {}).filter(([, s]) => own.has(s.casterId) || (s.targetIds || []).some((id) => own.has(id))));
    if (!m.settings?.showAstralToPlayers) m.astral = Object.fromEntries(Object.entries(m.astral || {}).filter(([id]) => own.has(id)));
  },
};

export default mod;
