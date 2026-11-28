// Table displays: read-only links for a shared screen or projector at in-person games (docs/modules/display.md).
// A display connects with its link token (server/index.ts resolves it to a user of role 'display') and gets a view
// built by the player filters, as a player without characters; 20-maps gives it the party's eyes (shared/display.ts).
// It can't run any action: the core rejects them. This module owns state.displays (GM actions) and runs last, so its
// filter only trims what the earlier filters left (party notes) and adds the display's own settings.
import crypto from 'node:crypto';
import {
  DISPLAY_ROTATIONS, MAX_DISPLAYS, defaultDisplaySettings, displayUserId, sanitizeDisplayLayout,
} from '../../shared/display.ts';
import type { ActionContext, DisplayLink, DisplayRotation, GameView, ServerModule, SessionUser, TableState } from '../../shared/types.ts';

type CreatePayload = { name?: unknown };
type IdPayload = { displayId?: unknown };
type UpdatePayload = IdPayload & { patch?: Record<string, unknown> };
type FocusPayload = IdPayload & { mapId?: unknown; x?: unknown; y?: unknown; zoom?: unknown };

const newToken = (): string => crypto.randomBytes(24).toString('hex');
const cleanName = (v: unknown): string => String(v ?? '').trim().slice(0, 40);

function slice(state: TableState): Record<string, DisplayLink> {
  if (!state.displays || typeof state.displays !== 'object' || Array.isArray(state.displays)) state.displays = {};
  return state.displays;
}

function findDisplay(ctx: ActionContext, id: unknown): DisplayLink {
  const d = typeof id === 'string' ? slice(ctx.state)[id] : undefined;
  if (!d) ctx.fail('Display not found');
  return d;
}

/** Complete / repair a stored link (old or hand-edited state). */
function normalize(d: DisplayLink, id: string): DisplayLink {
  const def = defaultDisplaySettings();
  return {
    id,
    token: typeof d.token === 'string' && d.token.length >= 32 ? d.token : newToken(),
    createdAt: Number(d.createdAt) || Date.now(),
    name: cleanName(d.name) || def.name,
    vision: typeof d.vision === 'string' && d.vision ? d.vision : 'party',
    rotation: DISPLAY_ROTATIONS.includes(d.rotation) ? d.rotation : 0,
    blank: !!d.blank,
    initiative: d.initiative !== false,
    audio: !!d.audio,
    handoutId: typeof d.handoutId === 'string' && d.handoutId ? d.handoutId : null,
    layout: sanitizeDisplayLayout(d.layout),
  };
}

/** A handout a display may show: one revealed to every player (what any player-side view already holds). */
function sharedHandout(state: TableState, id: string): boolean {
  return (state.campaign?.handouts || []).some((h) => h.id === id && h.revealedTo === 'all');
}

const mod: ServerModule = {
  name: 'display',

  init(state: TableState) {
    const all = slice(state);
    for (const [id, d] of Object.entries(all)) {
      if (!d || typeof d !== 'object') delete all[id];
      else all[id] = normalize(d, id);
    }
  },

  actions: {
    // { name? } → { id, token }
    'display/create': {
      handler(ctx: ActionContext, { name }: CreatePayload = {}) {
        const all = slice(ctx.state);
        if (Object.keys(all).length >= MAX_DISPLAYS) ctx.fail('At most {max} display links per table', { max: MAX_DISPLAYS });
        const id = ctx.uid('dsp');
        const n = Object.keys(all).length + 1;
        all[id] = { ...defaultDisplaySettings(cleanName(name) || ctx.t('Display {n}', { n })), id, token: newToken(), createdAt: ctx.now };
        return { id, token: all[id].token };
      },
    },

    // { displayId, patch: { name?, vision?, rotation?, blank?, initiative?, audio?, handoutId?, layout? } }
    'display/update': {
      handler(ctx: ActionContext, { displayId, patch }: UpdatePayload = {}) {
        const d = findDisplay(ctx, displayId);
        const p = patch && typeof patch === 'object' ? patch : {};
        if ('name' in p) d.name = cleanName(p.name) || d.name;
        if ('vision' in p) {
          const v = p.vision;
          if (v === 'party') d.vision = 'party';
          else {
            const a = typeof v === 'string' ? ctx.state.actors[v] : null;
            if (!a || a.type !== 'pc' || a.retired) ctx.fail('Character not found');
            d.vision = a.id;
          }
        }
        if ('rotation' in p) {
          const r = Number(p.rotation) as DisplayRotation;
          if (!DISPLAY_ROTATIONS.includes(r)) ctx.fail('Invalid rotation');
          d.rotation = r;
        }
        if ('blank' in p) d.blank = !!p.blank;
        if ('initiative' in p) d.initiative = !!p.initiative;
        if ('audio' in p) d.audio = !!p.audio;
        if ('handoutId' in p) {
          const h = p.handoutId;
          if (h === null || h === '') d.handoutId = null;
          else {
            if (typeof h !== 'string' || !sharedHandout(ctx.state, h)) ctx.fail('Reveal this handout to every player first');
            d.handoutId = h;
          }
        }
        if ('layout' in p) d.layout = sanitizeDisplayLayout(p.layout);
        return { ok: true };
      },
    },

    // New secret for the link: the old URL stops working (connected screens are sent away).
    'display/renew': {
      handler(ctx: ActionContext, { displayId }: IdPayload = {}) {
        const d = findDisplay(ctx, displayId);
        d.token = newToken();
        return { token: d.token };
      },
    },

    // Revoke a link: deleted, its screens are disconnected at the next broadcast.
    'display/remove': {
      handler(ctx: ActionContext, { displayId }: IdPayload = {}) {
        const d = findDisplay(ctx, displayId);
        delete slice(ctx.state)[d.id];
        return { ok: true };
      },
    },

    // « Look here »: centre the displays' map on a cell. { displayId? (default: every display), mapId, x, y, zoom? }
    'display/focus': {
      handler(ctx: ActionContext, { displayId, mapId, x, y, zoom }: FocusPayload = {}) {
        const map = typeof mapId === 'string' ? ctx.state.maps?.[mapId] : null;
        if (!map) ctx.fail('Map not found');
        const fx = Number(x), fy = Number(y);
        if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx >= map.width || fy >= map.height) ctx.fail('Cell outside the map');
        const ids = displayId === undefined || displayId === null ? Object.keys(slice(ctx.state)) : [findDisplay(ctx, displayId).id];
        if (!ids.length) ctx.fail('No display link yet');
        const z = Math.max(0, Math.min(160, Number(zoom) || 0));
        ctx.emitTo(ids.map(displayUserId), 'display/focus', { mapId: map.id, x: fx, y: fy, zoom: z });
        return { ok: true, count: ids.length };
      },
    },
  },

  // The core never puts the links in a player's or display's view (their tokens are the secret). A display gets its
  // own settings and no party notes (it never shows them; everything else is what a player without characters sees).
  filter(view: GameView, user: SessionUser, state: TableState) {
    if (user.role !== 'display') return;
    const d = user.display ? state.displays?.[user.display] : null;
    if (d) {
      const { token, createdAt, ...settings } = d;
      view.display = { ...settings, layout: { ...settings.layout } };
    }
    if (view.notes) view.notes = { ...view.notes, pages: {}, comments: {} };
  },
};

export default mod;
