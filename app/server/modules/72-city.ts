// City map (« Seattle » tab): which table map is the city, its districts (traced shapes, data/city/*.json) and where each
// lifestyle's home is (lifestyle.place, set by shop/move in 40-shop.ts). Players see their own runners' homes; another
// runner's home only once the GM « invites » one of their runners there (place.guests). See docs/modules/city.md.
import { deepClone } from '../../shared/util.ts';
import { activeCity, cityShapes, guessCityMap, shapesForMap } from '../lib/city.ts';
import type { ActionContext, Actor, ActorId, CityPin, CityState, CityView, GameView, Lifestyle, ServerModule, SessionUser, TableState } from '../../shared/types.ts';

const str = (v: unknown, max = 80): string => String(v ?? '').trim().slice(0, max);

function ensureSlice(state: TableState): CityState {
  const c = (state.city = state.city && typeof state.city === 'object' ? state.city : ({} as CityState));
  c.mapId = typeof c.mapId === 'string' && c.mapId ? c.mapId : null;
  c.shapes = typeof c.shapes === 'string' && c.shapes ? c.shapes : null;
  c.districts = Array.isArray(c.districts) ? c.districts.filter((d) => d && typeof d.id === 'string' && Array.isArray(d.rings)) : [];
  return c;
}

/**
 * Copy the districts of the city map's shapes into the state (first time, or when the map changed); later boots only
 * add districts missing by id and refresh their outlines, keeping the GM's names.
 */
function syncDistricts(state: TableState): void {
  const c = ensureSlice(state);
  const map = (c.mapId && state.maps?.[c.mapId]) || (!c.mapId ? guessCityMap(state) : null);
  const shapes = shapesForMap(map);
  if (!shapes) return;
  if (c.shapes !== shapes.id) {
    c.shapes = shapes.id;
    c.districts = deepClone(shapes.districts);
    return;
  }
  const byId = new Map(c.districts.map((d) => [d.id, d]));
  c.districts = shapes.districts.map((s) => {
    const own = byId.get(s.id);
    return own ? { ...deepClone(s), name: own.name || s.name } : deepClone(s);
  });
}

function findLifestyle(ctx: ActionContext, actorId: unknown, lifestyleId: unknown): { actor: Actor; lf: Lifestyle } {
  const actor = ctx.state.actors?.[actorId as ActorId];
  if (!actor) return ctx.fail('Character not found');
  const lf = (actor.lifestyles || []).find((l) => l.id === lifestyleId);
  if (!lf) return ctx.fail('Lifestyle not found');
  return { actor, lf };
}

/** Homes of every runner (PCs) that are on the map. */
function allPins(state: TableState): CityPin[] {
  const pins: CityPin[] = [];
  for (const a of Object.values(state.actors || {})) {
    if (!a || a.type !== 'pc') continue;
    for (const l of a.lifestyles || []) {
      const p = l?.place;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      pins.push({
        actorId: a.id, lifestyleId: l.id, actor: a.name, lifestyle: l.name, base: l.base, x: p.x, y: p.y, district: p.district ?? null,
        layout: l.home?.layout ?? null, own: true, guests: [...(p.guests || [])],
      });
    }
  }
  return pins;
}

/** The view slice: city map image + districts + the homes this user may see. */
function cityView(state: TableState, user: SessionUser | null): CityView {
  const city = activeCity(state);
  if (!city) return { map: null, districts: [], pins: [] };
  const m = city.map;
  const view: CityView = {
    map: { id: m.id, name: m.name, width: m.width, height: m.height, background: m.background! },
    districts: city.districts,
    pins: allPins(state),
  };
  if (user) {
    const mine = new Set(user.characterIds || []);
    view.pins = view.pins
      .filter((p) => mine.has(p.actorId) || p.guests.some((g) => mine.has(g)))
      .map((p) => ({ ...p, own: mine.has(p.actorId), guests: [] }));
  }
  return view;
}

const mod: ServerModule = {
  name: 'city',

  init(state) {
    ensureSlice(state);
    syncDistricts(state);
  },

  actions: {
    // GM: which map is the city (null = guess from the traced images), district names { id: name }.
    'city/settings': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, names }: { mapId?: string | null; names?: Record<string, unknown> }) {
        const c = ensureSlice(ctx.state);
        if (mapId !== undefined) {
          if (mapId !== null && mapId !== '' && !ctx.state.maps?.[String(mapId)]) ctx.fail('Map not found');
          c.mapId = mapId ? String(mapId) : null;
          c.shapes = null;
          c.districts = [];
          syncDistricts(ctx.state);
        }
        if (names && typeof names === 'object') {
          for (const d of c.districts) {
            if (!Object.prototype.hasOwnProperty.call(names, d.id)) continue;
            const n = str(names[d.id], 40);
            d.name = n || cityShapes().find((s) => s.id === c.shapes)?.districts.find((x) => x.id === d.id)?.name || d.id;
          }
        }
        return { mapId: c.mapId, shapes: c.shapes };
      },
    },

    // GM: runners whose players may see this home (« invited » there). guests = actor ids of PCs.
    'city/invite': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, lifestyleId, guests }: { actorId?: ActorId; lifestyleId?: string; guests?: unknown }) {
        const { lf } = findLifestyle(ctx, actorId, lifestyleId);
        if (!lf.place) ctx.fail('This home is not on the map');
        if (!Array.isArray(guests)) return ctx.fail('Invalid list');
        const ids = [...new Set(guests.map((g) => String(g)))].filter((g) => g !== actorId && ctx.state.actors?.[g]?.type === 'pc').slice(0, 40);
        if (ids.length) lf.place!.guests = ids;
        else delete lf.place!.guests;
        return { guests: ids };
      },
    },

    // GM: take a home off the map (the player places it again for free).
    'city/unplace': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, lifestyleId }: { actorId?: ActorId; lifestyleId?: string }) {
        const { lf } = findLifestyle(ctx, actorId, lifestyleId);
        delete lf.place;
        return { ok: true };
      },
    },
  },

  filter(view: GameView, user: SessionUser, full: TableState) {
    view.city = cityView(full, user);
    // Other runners' sheets: no home / spot unless one of the user's runners is invited there.
    const mine = new Set(user.characterIds || []);
    for (const [id, a] of Object.entries(view.actors || {})) {
      if (mine.has(id) || !Array.isArray((a as Actor).lifestyles)) continue;
      for (const l of (a as Actor).lifestyles) {
        if (l.place?.guests?.some((g) => mine.has(g))) delete l.place.guests;
        else {
          delete l.place;
          delete l.home;
        }
      }
    }
  },

  gmFilter(view: GameView, _user: SessionUser, full: TableState) {
    view.city = cityView(full, null);
  },
};

export default mod;
