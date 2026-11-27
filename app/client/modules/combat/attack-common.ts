// Client helpers of the attack flow (server: server/modules/33-attacks.js, rules: shared/combat.js):
// the user's target (ui.targetTokenId) and aimed point (ui.aimPoint), target candidates with their distance, attacks waiting for me.
import { setUI, getUI, type UIState } from '../../lib/ui-store.ts';
import { cellDistance, rangeFor } from '/shared/combat.ts';
import type { ActorId, AttackStatus, AttackTurnRecord, GameMap, GameView, MapId, Token, ViewActor, Weapon } from '../../../shared/types.ts';

/** Map the user is looking at: players the shown map, the GM their viewed map (falls back to the active one). */
export function currentMap(game: GameView, ui: UIState = getUI()): GameMap | null {
  const maps = game.maps || {};
  const active = game.scene?.activeMapId;
  if (game.me?.role === 'gm' && ui.viewMapId && maps[ui.viewMapId]) return maps[ui.viewMapId];
  return (active && maps[active]) || null;
}
/** Map the server uses for an attack (players: the active map). */
export function attackMap(game: GameView, ui: UIState = getUI()): GameMap | null {
  const active = game.scene?.activeMapId;
  return game.me?.role === 'gm' ? currentMap(game, ui) : (active && game.maps?.[active]) || null;
}
export const tokenOfActor = (map: GameMap | null | undefined, actorId: ActorId | null | undefined): Token | null =>
  (map?.tokens || []).find((t) => t.actorId === actorId) || null;

/** Toggle the user's target (null clears it). */
export function setTarget(tokenId: string | null | undefined) {
  const cur = getUI().targetTokenId || null;
  setUI({ targetTokenId: tokenId && tokenId !== cur ? tokenId : null });
}
/** Aimed point for grenades / launchers (null clears it). */
export function setAimPoint(mapId: MapId | null | undefined, x?: number, y?: number) {
  setUI({ aimPoint: mapId == null ? null : { mapId, x: x as number, y: y as number } });
}

export interface TargetCandidate {
  token: Token;
  name: string;
  meters: number | null;
  /** shared/combat.js rangeFor() result. */
  range: ReturnType<typeof rangeFor> | null;
}

/** Tokens an actor can target on the map (not their own token, with a sheet): { token, name, meters, range }. */
export function targetCandidates(game: GameView, actorId: ActorId, weapon?: Weapon | null, actor?: ViewActor | null): TargetCandidate[] {
  const map = attackMap(game);
  if (!map) return [];
  const me = tokenOfActor(map, actorId);
  const mpc = Number(map.metersPerCell) || 1;
  return (map.tokens || [])
    .filter((t) => t.actorId && t.actorId !== actorId && (game.me?.role === 'gm' || !t.hidden))
    .map((t) => {
      const meters: number | null = me ? cellDistance(me, t, mpc) : null;
      return { token: t, name: t.name || game.actors?.[t.actorId as string]?.name || '?', meters, range: weapon && meters !== null ? rangeFor(weapon, actor, meters) : null };
    })
    .sort((a, b) => (a.meters ?? 1e9) - (b.meters ?? 1e9));
}

/** Can the user act for this actor (GM: every actor; players: their characters)? */
export const ownsActorId = (game: GameView, id: ActorId | null | undefined): boolean =>
  game.me?.role === 'gm' || (!!id && (game.me?.characterIds || []).includes(id));

/** Current Combat Turn key (same as the server's combatTurnKey) or null. */
export function turnKey(game: GameView): string | null {
  const c = game.combat;
  return c?.active ? `${c.startedAt || 0}:${c.round || 1}` : null;
}
/** This turn's defense record of an actor: { defended, boosts, once } (GM: raw turn data; players: their own). */
export function turnInfo(game: GameView, actorId: ActorId): Omit<AttackTurnRecord, 'key'> {
  const s = game.attacks || ({} as GameView['attacks']);
  if (s.myTurn?.[actorId]) return s.myTurn[actorId];
  const t = s.turn?.[actorId];
  return t && t.key === turnKey(game) ? t : { defended: 0, boosts: [], once: [] };
}

export const PENDING: Set<AttackStatus | string> = new Set<AttackStatus | string>(['defense', 'soak']);
