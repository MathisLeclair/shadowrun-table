// Action counter of the initiative tracker (SR5 p. 163): what each participant used in the current Initiative Pass.
// The combat module owns state.combat; this helper only appends to an entry's `spent` list, so the characters, attacks
// and matrix modules can record the cost of what they resolve without importing each other (no import cycle).
import { phaseUsage, overPhase } from '../../shared/combat.ts';
import { uid } from '../../shared/util.ts';
import type { ActionContext, ActorId, CombatEntry, I18nMessage, PhaseActionType, SpentAction } from '../../shared/types.ts';

/** Most actions kept per entry and pass (a GM spamming the menu must not grow the state forever). */
export const MAX_SPENT = 12;

/** Who took the action: an actor (first entry of that actor still in the fight) or an entry (Matrix entries have no actor). */
export type ActionTaker = { actorId?: ActorId | null; entryId?: string | null; matrixKey?: string | null };
export type ActionSpec = { type: PhaseActionType; label: string | I18nMessage; attack?: boolean; auto?: boolean; cost?: number };

/** The tracker entry of an actor / entry in the running combat (null outside combat, or not rolled yet). */
export function trackerEntry(ctx: ActionContext, who: ActionTaker): CombatEntry | null {
  const c = ctx.state.combat;
  if (!c?.active) return null;
  const e = c.entries.find((x) =>
    who.entryId ? x.id === who.entryId : who.matrixKey ? x.matrixKey === who.matrixKey : !!who.actorId && x.actorId === who.actorId && !x.out,
  );
  return e && !e.toRoll ? e : null;
}

/**
 * Record an action on the tracker entry. Over-budget actions are kept (the counter is an indication, never a block) and
 * flagged with `over` + the reason (a dictionary key). Returns null when there is no entry to record on.
 */
export function recordAction(ctx: ActionContext, who: ActionTaker, spec: ActionSpec): { entry: CombatEntry; action: SpentAction; reason: string | null } | null {
  const e = trackerEntry(ctx, who);
  if (!e) return null;
  const list = Array.isArray(e.spent) ? e.spent : (e.spent = []);
  const reason = spec.type === 'interrupt' ? null : overPhase(phaseUsage(list), spec.type, !!spec.attack);
  const action: SpentAction = {
    id: uid('act'),
    type: spec.type,
    label: spec.label,
    ...(spec.attack ? { attack: true } : {}),
    ...(spec.auto ? { auto: true } : {}),
    ...(spec.cost ? { cost: spec.cost } : {}),
    ...(reason ? { over: true } : {}),
  };
  list.push(action);
  if (list.length > MAX_SPENT) list.splice(0, list.length - MAX_SPENT);
  return { entry: e, action, reason };
}
