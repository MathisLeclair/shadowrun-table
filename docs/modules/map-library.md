# Map library (server-wide fragmaps)

| | |
|---|---|
| server | `server/lib/maplib.ts`, `server/lib/maplib-admin.ts`, `server/lib/maplib-thumb.ts`, `server/modules/22-maplib.ts` |
| shared | `shared/maplib.ts` |
| client | `client/modules/map/LibraryBrowser.tsx` + `maplib-client.ts`, `client/modules/admin/MaplibAdmin.tsx`; English in `map.json` / `admin.json` |
| tools | `tools/maplib-build.ts`, `tools/maplib-campaign-seeds.ts`, `tools/maptrace/` |
| tests | `node tools/test-maplib.ts` (ports 3910-3912), `node tools/test-maplib-campaign.ts` (ports 3940-3941), `node tools/test-maptrace.ts` (no server) |

Raw fragmaps (image + walls/doors/lights/regions, no tokens, no fog) are **server-wide**: every table can use them. A
table works on its own **instance** (an ordinary table Map, [maps.md](maps.md)), so tokens, fog, door states and GM
edits never leak between tables. Only fragmaps go to the library: custom-made maps may be spoilers and can never be
published (no `map.library` → refused). Copying images to the VPS: [deploy.md](../deploy.md).

## Files

```
data/maplib/<slug>.json      IN GIT — one library map: { id: 'lib_<slug>', slug, name (EN), nameFr, source: 'fragmap'|'fragmaps-free',
                             image (file in <maplib>/images) | imagePath (relative to data/assets, e.g. foundry/scenes/x.jpg), imageW, imageH,
                             gridPx (px per cell, float ok), offsetX, offsetY (px of the grid origin), width, height (cells), metersPerCell, theme,
                             lighting, tags [FR+EN], description (FR), walls [{ id, x1, y1, x2, y2, move, sight, door: null|{ state, kind } }] (CELL
                             units from the grid origin), lights [{ id, x, y, radius, color, on }], regions [{ id, name, x, y, w, h, gmOnly: false }],
                             entry?: { x, y }, traced: { by, at, quality: 'good'|'rough', notes }, version }   (folder: SR_MAPLIB_SOURCE)
<maplib> = SR_MAPLIB_DIR, else <runtime>/maplib        PER SERVER, never in git (on the PC <runtime> = data/, so it sits next to the git files)
  library.json               { version: 1, settings: { publishAdminOnly }, maps: { [slug]: Meta } } — Meta = descriptive fields + geometry + version
                             (current revision), origin: 'git'|'seed'|'edited'|'upload', originRef { kind, file, hash }, overrides (admin names/tags…),
                             gitNewer?, deleted? (tombstone), counts, versionInfo { at, by }, history: [{ version, at, by, origin, counts }] (5 kept)
  entries/<slug>.json        { slug, versions: { [n]: { walls, lights, regions, entry?, geometry } } } — current + the 5 previous versions
  images/<file>              artwork (tools/maplib-build.ts copies it from ../fragmap, or an /admin upload) — the owner's paid content
  thumbs/<slug>.jpg          ≤ 480 px JPEG (tools/maplib-build.ts, or an /admin JPEG upload). Also accepted: thumbs/<slug>.webp|.png and
                             thumbs/<image file name>[.jpg]; migrated Foundry scenes fall back to their Foundry thumbnail (thumbPath).
<runtime>/maplib-sign.key    HMAC key of the image links (SR_MAPLIB_KEY_FILE) — outside <maplib>, which is copied PC → VPS
```

## Boot sync

`ensureLibrary()`, once per process, from the first table init: every git file is applied — a new slug → version 1
(origin `git`); an entry still following its source (`git` / `seed`) whose file hash changed gets a new version; an
`edited` (published / rolled back) or `upload` entry never gets git walls (its descriptive fields still follow git,
and `gitNewer` makes /admin show « git plus récent »). Admin `overrides` (names, tags, description, theme, lighting)
always win. Deleted entries are tombstones: git does not bring them back.

**Foundry fragmaps-free migration**: `data/seed/maps/foundry-*.json` whose image is one of the 26 fragmaps-free
images (`FRAGMAPS_FREE`, lower-case file names, with French name / tags / description) become entries (origin `seed`,
`imagePath` = the existing `foundry/scenes/<file>`, grid from the « Image W×H px » line of the map description). Custom
Foundry maps (Club House, Garage, Seattle, appartement…) stay out. Every table init runs `linkTableMaps` (idempotent):
a table map showing such an image gets `map.library = { slug, version, linkedAt, migrated: true }` (no entry for that
image yet → one is made from that map); the table data (walls, background URL, tokens, fog) is untouched.

## Instances

`map.library = { slug, version, linkedAt, syncedAt?, migrated? }` on a table Map, stripped from player views.
- `maps/fromLibrary { slug, name?, folder? = 'Bibliothèque' }` (GM) → map id. Name = `nameFr` (French table) / `name`;
  `background = { url: '/api/maplib/image/<slug>', mode: 'image', x: -offsetX/gridPx, y, w: imageW/gridPx, h }`, tiles
  all floor, walls / lights / regions copied with fresh ids, `entry` → a GM-only region « Entrée » (id `libentry_…`,
  found by `maps/placePCs`).
- `maps/libraryDiff { mapId }` → `{ slug, name, nameFr, current, latest, diff: { walls|doors|lights|regions: { add,
  remove }, resized, width, height, keptDoorStates, same }, publishAllowed, migrated }` (`add` = only in the library,
  `remove` = only in the table map).
- `maps/libraryUpdate { mapId }` → `{ version, diff }`: walls / doors / lights / regions from the latest version;
  tokens, GM notes, fog (remapped when the size changes), GM-only regions, the background URL, door states (+ names) of
  doors at the same position and light switches are kept.
- `maps/publishToLibrary { mapId, force? }` → `{ version }`: walls (doors closed, door names dropped), lights and public
  regions become a new version (shifted back when the map was moved against its image); tokens, notes, fog and GM-only
  regions are never published. Refused for maps without `map.library`, when /admin reserved publishing to the admin,
  and when the library moved past the map's version (error key « La bibliothèque a changé depuis ta dernière
  synchronisation… »; `force` overrides — the replaced version stays in the history). Logs a GM-only line.
- `maps/libraryUnlink { mapId }` → an ordinary table map again.

## Routes

`GET /api/maplib/key` (any logged-in user) → `{ k, exp, ttl, now }`; `GET /api/maplib` (GM) → `{ maps: [{ id, slug,
name, nameFr, source, tags, description, theme, lighting, width, height, metersPerCell, gridPx, quality, version,
counts, origin, updatedAt, thumb, hasImage, hasThumb }], settings }`; `GET /api/maplib/:slug` (GM) → the same + `walls,
lights, regions, entry, geometry`; `GET /api/maplib/image/:slug?k=` and `/api/maplib/thumb/:slug?k=` are the only way to
the files (no static route, no listing). `k` = base64url({ t: tableId, u: userId, s: sessionTag(token), e }) +
HMAC-SHA256 (the rulebooks' scheme, own key, `maplib:` prefix), one key for every library image, expiry rounded up to
30 min + 1 h; or { a: 1, s: admin session tag, e } for /admin. No `k` → 401; bad signature, expired, unknown /
archived table, removed user, dead session (logout, kick, GM password change), dead admin session → 403. Success:
`Cache-Control: private, max-age=3600`, `nosniff`. Missing file → 200 grey SVG placeholder (`X-Maplib-Missing: 1`,
`no-store`). Deleted entries keep serving their image (instances made from them still need it).

## Admin

`/api/admin/maplib…`, admin bearer: `GET` (entries + history, overrides, files, `usedBy: [{ tableId, tableName, maps:
[{ id, name, version }] }]`), `GET /key`, `PATCH /settings { publishAdminOnly }`, `PATCH /:slug { name?, nameFr?, tags?,
description?, theme?, lighting? }`, `DELETE /:slug { confirm: slug }`, `POST /:slug/rollback { version }` (old content
→ new version), `POST /:slug/revert` (git file, else the Foundry seed scene; follows git again), `POST /:slug/publish {
tableId, mapId, force? }` (« Publier depuis une table »), `POST
/upload?slug=&name=&nameFr=&gridPx=&offsetX=&offsetY=&source=&replace=1` (body = JPEG / PNG / WebP, `X-Filename`,
streamed, header-checked, ≤ 160 × 160 cells, `SR_MAX_MAPLIB_IMAGE_BYTES` = 60 MB; a new entry without walls, or a new
version with the new grid for an existing slug; JPEGs ≤ 40 MP get a thumbnail made by `maplib-thumb.ts` in a worker
thread).

## Client

The GM « Cartes » page has tabs « Cartes de la table » / « Bibliothèque » (search in FR/EN names + tags, filters
ambiance / source / tracé, thumbnails, « Aperçu » = the real renderer (`MapCanvas`) on a throwaway Map with the walls
shown, « Ajouter à cette table »). Library-linked cards carry a « Bibliothèque » badge (amber ↑ when a newer version
exists) and a « Bibliothèque… » button (also in the editor header) → `LibraryLinkModal` (diff, update, publish,
detach). `renderer.ts getImage()` loads `/api/maplib/…` URLs with the signed key of `maplib-client.ts`
(`ensureLibKey()`, renewed 10 min before expiry; the image cache stays keyed by the bare URL, so a renewed key never
reloads an image). Players see nothing new (only the image of the shown map).

Campaign seed instances (`maps/lib-<slug>.json` of the Lazarus pack): [data-model.md](../data-model.md#content-packs-seeds).

## Tests

`node tools/test-maplib.ts` (ports 3910-3912): shared helpers, boot seeding from a fixture git folder + the Foundry
seeds, image auth (401 / 403, forged / expired / dead-session keys, admin key, no listing, placeholder), instances in
one table only, player view without `library`, publish (version + history, nothing private published), update keeping
tokens / notes / fog / door states, stale publish + force, admin-only setting, custom maps refused, rollback, revert,
rename, delete, upload + thumbnail, map_fvtt_* migration idempotent across restarts, git updates vs edited entries.
