// Map library — table side (see ARCHITECTURE.md « Map library »). The library itself (server-wide raw fragmaps,
// versions, images) lives in server/lib/maplib.js; this module makes table copies (instances) of library maps,
// re-syncs them, publishes a table's corrections back, serves the library to GMs and the signed images to users.
// Instances are ordinary table maps (20-maps.js) carrying map.library = { slug, version, linkedAt, syncedAt?, migrated? }.
import { uid } from '../../shared/util.js';
import { decodeBits, encodeBits, remapBits } from '../../shared/vision.js';
import { libImageUrl, libGeometry, instanceContent as instanceContentJs, libraryDiff, versionFromMap, ENTRY_REGION_PREFIX } from '../../shared/maplib.js';
import * as L from '../lib/maplib.js';
import { errorBody } from '../lib/i18n.js';
import { normalizeMap, refreshFog } from './20-maps.ts';
import type { ActionContext, GameMap, GameView, I18nParams, InitOptions, MapId, ServerModule, TableState } from '../../shared/types.ts';

// No @types/express yet (the server-core agent adds it): loose aliases for the HTTP app, requests and responses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExpressApp = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = any;
/** Multi-table internals passed to routes() as `tableApi` (server/index.js, still JavaScript). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TableApi = any;
/** Library error thrown by server/lib/maplib.js libError(): a translatable key and its params. */
type LibError = { libKey?: string; libParams?: I18nParams };

// server/lib/maplib.js and shared/maplib.js are still JavaScript: their `= null` option defaults are inferred as
// null-only, widened here.
const instanceContent = instanceContentJs as (
  version: Parameters<typeof instanceContentJs>[0], makeId: Parameters<typeof instanceContentJs>[1], opts?: { previous?: GameMap },
) => ReturnType<typeof instanceContentJs>;
const entryFromFoundryMap = L.entryFromFoundryMap as unknown as (
  map: GameMap, opts: { origin: string; originRef: { kind: string; tableId: string } },
) => ReturnType<typeof L.entryFromFoundryMap>;
const publish = L.publish as unknown as (
  slug: string, content: unknown, by: unknown, opts: { baseVersion: number; force: boolean },
) => ReturnType<typeof L.publish>;

/** Marker for the i18n checker. */
const tk = (s: string): string => s;
const MAX_DIM = 160;
const NOT_FOUND = tk('Carte de bibliothèque introuvable');
const BAD_LINK = tk('Lien d’image expiré ou invalide : recharge la page');
const str = (v: unknown, max = 200): string => (v == null ? '' : String(v)).slice(0, max);
const floorRows = (w: number, h: number): string[] => Array.from({ length: h }, () => '.'.repeat(w));

function getMap(ctx: ActionContext, mapId: MapId): GameMap {
  const m = ctx.state.maps?.[mapId];
  if (!m) ctx.fail('Carte introuvable');
  return m;
}
/** Library errors (server/lib/maplib.js libError) → translatable ctx.fail. */
function libCall<T>(ctx: ActionContext, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const le = err as LibError | null;
    if (le?.libKey) ctx.fail(le.libKey, le.libParams);
    throw err;
  }
}
function linkedEntry(ctx: ActionContext, map: GameMap) {
  if (!map.library?.slug) ctx.fail('Cette carte ne vient pas de la bibliothèque');
  const m = L.getMeta(map.library.slug);
  if (!m) ctx.fail(NOT_FOUND);
  return m;
}
const tableName = (ctx: ActionContext): string => ctx.state.config?.campaignName || ctx.table?.name || ctx.tableId;

/**
 * Migration (every boot, idempotent): table maps showing a Foundry fragmaps-free scene image get map.library,
 * linked to the library entry of that image (created from the map when the library has none). Table data is untouched.
 */
export function linkTableMaps(state: TableState, tableId: string): boolean {
  let changed = false;
  for (const map of Object.values(state.maps || {})) {
    if (!map || typeof map !== 'object' || map.library) continue;
    const base = L.foundrySceneImage(map.background?.url);
    if (!base || !(L.FRAGMAPS_FREE as Record<string, unknown>)[base]) continue;
    const entry = L.findByImage(base) || entryFromFoundryMap(map, { origin: 'edited', originRef: { kind: 'table', tableId } });
    if (!entry) continue;
    map.library = { slug: entry.slug, version: entry.version, linkedAt: Date.now(), migrated: true };
    changed = true;
  }
  if (changed) L.saveLibrary();
  return changed;
}

/** True when one of the table's maps shows this library entry. */
function usesLibraryMap(state: TableState | null | undefined, slug: string): boolean {
  const url = libImageUrl(slug);
  return Object.values(state?.maps || {}).some((m) => m && (m.library?.slug === slug || m.background?.url === url));
}

const bearer = (req: Req): string => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
};

type SlugPayload = { slug?: unknown; name?: unknown; folder?: unknown };
type MapIdPayload = { mapId: MapId };
type PublishPayload = { mapId: MapId; force?: boolean };

const mod: ServerModule<ExpressApp> = {
  name: 'maplib',

  init(state: TableState, { tableId }: InitOptions) {
    L.ensureLibrary();
    if (state.maps && typeof state.maps === 'object') linkTableMaps(state, tableId);
  },

  actions: {
    // { slug, name?, folder? } → new table map id (a copy of the library map: walls, doors, lights, regions; fresh ids)
    'maps/fromLibrary': {
      role: 'gm',
      handler(ctx: ActionContext, { slug, name, folder }: SlugPayload) {
        const m = L.getMeta(slug);
        if (!m) ctx.fail(NOT_FOUND);
        const v = L.getVersion(m.slug);
        if (!v) ctx.fail(NOT_FOUND);
        const e = L.effective(m);
        const g = libGeometry({ ...e, ...(v.geometry || {}) });
        if (g.width > MAX_DIM || g.height > MAX_DIM) ctx.fail('Carte trop grande ({w} × {h} cases, {max} max)', { w: g.width, h: g.height, max: MAX_DIM });
        const content = instanceContent(v, uid);
        const map = normalizeMap({
          id: uid('map'),
          name: str(name, 80).trim() || (ctx.lang === 'en' ? e.name : e.nameFr) || e.name,
          folder: folder == null ? 'Bibliothèque' : str(folder, 60),
          description: e.description || '',
          width: g.width, height: g.height, metersPerCell: e.metersPerCell, theme: e.theme, lighting: e.lighting,
          tiles: floorRows(g.width, g.height),
          background: { url: libImageUrl(m.slug), opacity: 1, mode: 'image', x: g.bgX, y: g.bgY, w: g.bgW, h: g.bgH },
          walls: content.walls, lights: content.lights, regions: content.regions,
          doors: [], notes: [], tokens: [], fog: true,
        });
        map.library = { slug: m.slug, version: m.version, linkedAt: ctx.now };
        ctx.state.maps[map.id] = map;
        if (!ctx.state.scene.activeMapId) ctx.state.scene.activeMapId = map.id;
        return map.id;
      },
    },

    // { mapId } → state of the link + what « Mettre à jour » would change (nothing is modified)
    'maps/libraryDiff': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId }: MapIdPayload) {
        const map = getMap(ctx, mapId);
        const m = linkedEntry(ctx, map);
        const link = map.library!; // checked by linkedEntry
        const v = L.getVersion(m.slug);
        const e = L.effective(m);
        return {
          slug: m.slug, name: e.name, nameFr: e.nameFr, current: link.version || 0, latest: m.version,
          diff: libraryDiff(map, v, e), publishAllowed: !L.getSettings().publishAdminOnly, migrated: !!link.migrated,
        };
      },
    },

    // { mapId } — walls / doors / lights / regions from the latest library version; tokens, GM notes, fog, GM-only
    // regions, door states (doors at the same place) and light switches are kept.
    'maps/libraryUpdate': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId }: MapIdPayload) {
        const map = getMap(ctx, mapId);
        const m = linkedEntry(ctx, map);
        const v = L.getVersion(m.slug);
        if (!v) ctx.fail(NOT_FOUND);
        const e = L.effective(m);
        const diff = libraryDiff(map, v, e);
        const g = libGeometry({ ...e, ...(v.geometry || {}) });
        if (g.width > MAX_DIM || g.height > MAX_DIM) ctx.fail('Carte trop grande ({w} × {h} cases, {max} max)', { w: g.width, h: g.height, max: MAX_DIM });
        const content = instanceContent(v, uid, { previous: map });
        const keepRegions = (map.regions || []).filter((r) => r.gmOnly && !String(r.id).startsWith(ENTRY_REGION_PREFIX));
        if (g.width !== map.width || g.height !== map.height) {
          const oldW = map.width, oldH = map.height;
          for (const [userId, enc] of Object.entries(map.explored || {})) map.explored[userId] = encodeBits(remapBits(decodeBits(enc, oldW * oldH), oldW, oldH, g.width, g.height, 0, 0));
          map.width = g.width;
          map.height = g.height;
          map.tiles = floorRows(g.width, g.height);
        }
        const bg: Partial<NonNullable<GameMap['background']>> = map.background || {};
        map.background = { url: bg.url || libImageUrl(m.slug), opacity: bg.opacity ?? 1, mode: 'image', x: g.bgX, y: g.bgY, w: g.bgW, h: g.bgH };
        map.walls = content.walls;
        map.lights = content.lights;
        map.regions = [...content.regions, ...keepRegions];
        normalizeMap(map);
        map.library = { ...map.library!, version: m.version, syncedAt: ctx.now };
        delete map.library.migrated;
        refreshFog(ctx.state, map);
        return { version: m.version, diff };
      },
    },

    // { mapId, force? } — the table's walls / doors (closed) / lights / public regions become a new library version.
    // Only maps made from the library (map.library) — never custom maps; tokens, notes, fog, GM-only regions stay here.
    'maps/publishToLibrary': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId, force }: PublishPayload) {
        const map = getMap(ctx, mapId);
        if (!map.library?.slug) ctx.fail('Seules les cartes venant de la bibliothèque peuvent y être publiées');
        const link = map.library;
        const m = L.getMeta(link.slug);
        if (!m) ctx.fail(NOT_FOUND);
        if (L.getSettings().publishAdminOnly) ctx.fail('La publication dans la bibliothèque est réservée à l’administrateur');
        const cur = L.getVersion(m.slug);
        const g = libGeometry({ ...L.effective(m), ...(cur?.geometry || {}) });
        const bg: Partial<NonNullable<GameMap['background']>> = map.background || {};
        const shift = { x: (Number(bg.x) || 0) - g.bgX, y: (Number(bg.y) || 0) - g.bgY };
        const content = { ...versionFromMap(map, { shift }), ...(cur?.entry ? { entry: cur.entry } : {}) };
        const n = libCall(ctx, () =>
          publish(m.slug, content, { kind: 'gm', tableId: ctx.tableId, table: tableName(ctx), mapId: map.id }, { baseVersion: link.version ?? 0, force: !!force })
        );
        map.library = { ...link, version: n, syncedAt: ctx.now };
        delete map.library.migrated;
        ctx.log({ kind: 'system', gmOnly: true, author: 'MJ', i18n: { key: 'Corrections publiées dans la bibliothèque : {name} (version {version})', params: { name: map.name, version: n } } });
        return { version: n };
      },
    },

    // { mapId } — the map becomes an ordinary table map (no updates, no publishing).
    'maps/libraryUnlink': {
      role: 'gm',
      handler(ctx: ActionContext, { mapId }: MapIdPayload) {
        const map = getMap(ctx, mapId);
        if (!map.library) ctx.fail('Cette carte ne vient pas de la bibliothèque');
        delete map.library;
      },
    },
  },

  // Players see nothing of the library (the link is GM data).
  filter(view: GameView) {
    for (const m of Object.values(view.maps || {})) if (m && typeof m === 'object') delete m.library;
  },

  routes(app: ExpressApp, { requireGM, requireUser, tableApi: api }) {
    const tableApi: TableApi = api;
    /** Signed key for library images (any logged-in user: players need the image of the shown map). */
    app.get('/api/maplib/key', requireUser, (req: Req, res: Res) => {
      res.setHeader('Cache-Control', 'no-store');
      const { k, exp } = L.signKey({ tableId: req.srTable.id, userId: req.user.id, session: L.sessionTag(bearer(req)) });
      res.json({ k, exp, ttl: L.LINK_TTL, now: Date.now() });
    });

    /** Library list for the GM browser (no walls). */
    app.get('/api/maplib', requireGM, (req: Req, res: Res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ maps: L.listEntries().map(L.publicEntry), settings: { publishAdminOnly: L.getSettings().publishAdminOnly } });
    });

    const serve = (kind: 'image' | 'thumb') => (req: Req, res: Res) => {
      res.setHeader('Cache-Control', 'no-store'); // errors and placeholders are never cached; a real file replaces it
      const v = L.verifyKey(typeof req.query.k === 'string' ? req.query.k : '');
      if (!v.ok) return v.reason === 'missing' ? res.status(401).json(errorBody('Non connecté')) : res.status(403).json(errorBody(BAD_LINK));
      if (v.a) {
        if (!L.isAdminSessionAlive(v.s)) return res.status(403).json(errorBody(BAD_LINK));
      } else {
        const t = tableApi.tables.get(v.t);
        const live = t && tableApi.usableTable(t) === t && !t.meta?.archived;
        const userOk = live && (v.u === 'gm' || !!t.state?.users?.[v.u]) && L.sessionAlive(t.state?.sessions, v.u, v.s);
        if (!userOk) return res.status(403).json(errorBody(BAD_LINK));
        // Public demo table: only the images of its own maps (the library artwork is the server owner's, not public).
        if (t.meta?.demo && !usesLibraryMap(t.state, req.params.slug)) return res.status(404).json(errorBody(NOT_FOUND));
      }
      // Deleted entries keep serving their image: table maps made from them still show it.
      const m = L.getMeta(req.params.slug, { withDeleted: true });
      if (!m) return res.status(404).json(errorBody(NOT_FOUND));
      const file = kind === 'image' ? L.imageFile(m) : L.thumbFile(m);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!file) {
        res.setHeader('X-Maplib-Missing', '1');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        res.type('image/svg+xml');
        return res.send(L.placeholderSvg(m, kind === 'image' ? `${m.nameFr || m.name || m.slug} — image manquante / missing image` : m.nameFr || m.name || m.slug));
      }
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      const type = (L.IMAGE_EXTS as Record<string, string>)[ext];
      if (!type) return res.status(404).json(errorBody(NOT_FOUND));
      const root = file.slice(0, file.length - ((file.split(/[\\/]/).pop() as string).length + 1));
      const headers = { 'Cache-Control': 'private, max-age=3600', 'Content-Type': type, 'Content-Disposition': 'inline' };
      res.sendFile(file.split(/[\\/]/).pop(), { root, cacheControl: false, dotfiles: 'deny', headers }, (err: (Error & { status?: number }) | null | undefined) => {
        if (!err || res.headersSent) return;
        for (const h of ['Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified']) res.removeHeader(h);
        res.setHeader('Cache-Control', 'no-store');
        res.status(err.status === 404 ? 404 : 500).json(errorBody(err.status === 404 ? NOT_FOUND : 'Erreur du serveur'));
      });
    };
    app.get('/api/maplib/image/:slug', serve('image'));
    app.get('/api/maplib/thumb/:slug', serve('thumb'));

    /** One library map with its walls (GM preview). */
    app.get('/api/maplib/:slug', requireGM, (req: Req, res: Res) => {
      res.setHeader('Cache-Control', 'no-store');
      const m = L.getMeta(req.params.slug);
      const v = m && L.getVersion(m.slug);
      if (!v) return res.status(404).json(errorBody(NOT_FOUND));
      res.json({ ...L.publicEntry(m), walls: v.walls, lights: v.lights, regions: v.regions, entry: v.entry || null, geometry: v.geometry || null });
    });
  },
};

export default mod;

