// Table displays (read-only shared screen / projector at in-person games): pure rules used by the server
// (96-display, 20-maps) and the browser (display shell, GM settings). See docs/modules/display.md.
import type { DisplayLayout, DisplayLink, DisplayPane, DisplayRotation, DisplaySettings, TableState, UserId, ActorId } from './types.ts';

export const DISPLAY_PANES: readonly DisplayPane[] = ['map', 'initiative', 'handout', 'rolls'];
export const DISPLAY_ROTATIONS: readonly DisplayRotation[] = [0, 90, 180, 270];
/** Display links per table. */
export const MAX_DISPLAYS = 8;
export const DISPLAY_RATIO = { min: 0.15, max: 0.85, def: 0.7 };
/** Prefix of a display connection's user id (`display:<link id>`). */
export const DISPLAY_USER_PREFIX = 'display:';

export const DEFAULT_DISPLAY_LAYOUT: DisplayLayout = { main: 'map', split: null, splitDir: 'row', splitRatio: DISPLAY_RATIO.def };

export function defaultDisplaySettings(name = 'Display'): DisplaySettings {
  return { name, vision: 'party', rotation: 0, blank: false, initiative: true, audio: false, handoutId: null, layout: { ...DEFAULT_DISPLAY_LAYOUT } };
}

const isPane = (v: unknown): v is DisplayPane => typeof v === 'string' && (DISPLAY_PANES as readonly string[]).includes(v);

/** A display layout from untrusted input: unknown panes fall back to the map, the split never repeats the main pane. */
export function sanitizeDisplayLayout(raw: unknown): DisplayLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const main = isPane(r.main) ? r.main : 'map';
  const split = isPane(r.split) && r.split !== main ? r.split : null;
  const ratio = typeof r.splitRatio === 'number' && Number.isFinite(r.splitRatio) ? r.splitRatio : DISPLAY_RATIO.def;
  return {
    main,
    split,
    splitDir: r.splitDir === 'col' ? 'col' : 'row',
    splitRatio: Math.round(Math.min(DISPLAY_RATIO.max, Math.max(DISPLAY_RATIO.min, ratio)) * 100) / 100,
  };
}

/** Panes a layout shows, main first. */
export function layoutPanes(layout: DisplayLayout): DisplayPane[] {
  return layout.split ? [layout.main, layout.split] : [layout.main];
}

/** Display user id of a link, and back. */
export const displayUserId = (linkId: string): UserId => DISPLAY_USER_PREFIX + linkId;
export const displayIdOf = (userId: unknown): string | null =>
  typeof userId === 'string' && userId.startsWith(DISPLAY_USER_PREFIX) ? userId.slice(DISPLAY_USER_PREFIX.length) || null : null;

/** The display link holding this token, if any. */
export function displayByToken(state: Pick<TableState, 'displays'> | null | undefined, token: unknown): DisplayLink | null {
  if (!token || typeof token !== 'string') return null;
  for (const d of Object.values(state?.displays || {})) if (d && d.token === token) return d;
  return null;
}

type VisionState = Pick<TableState, 'actors' | 'users' | 'displays'>;

/** PCs in play (not retired): the party a display looks through. */
function partyIds(state: VisionState): ActorId[] {
  return Object.values(state.actors || {}).filter((a) => a && a.type === 'pc' && !a.retired).map((a) => a.id);
}

/**
 * Whose eyes a display uses on the map: `characterIds` (their tokens see, like a player's own characters) and
 * `exploredBy` (users whose explored fog it shows). Party: every PC in play and every player's explored cells.
 * One PC: that character (plus the party when the map shares vision, as for its player) and its player's fog.
 * A vision naming a PC that no longer exists falls back to the party.
 */
export function displayEyes(state: VisionState, linkId: string | null | undefined): { characterIds: ActorId[]; exploredBy: UserId[] } {
  const d = linkId ? state.displays?.[linkId] : null;
  const party = partyIds(state);
  const users = Object.values(state.users || {});
  if (d && d.vision !== 'party' && party.includes(d.vision)) {
    return { characterIds: [d.vision], exploredBy: users.filter((u) => (u.characterIds || []).includes(d.vision)).map((u) => u.id) };
  }
  return { characterIds: party, exploredBy: users.map((u) => u.id) };
}
