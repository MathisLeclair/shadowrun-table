# Multi-table hosting & server admin

Core: `server/index.ts`, `server/store.ts`, `server/lib/tables.ts`, `server/lib/admin.ts`, `server/lib/zip.ts`; admin
page `client/modules/admin/AdminPage.tsx` (`/admin`). Tests: `node tools/test-tables.ts` (ports 3500-3599;
`tools/test-modifiers.ts` uses 3500 and `tools/test-bookrefs.ts` 3530-3531 — don't run them at the same time).

One server hosts several **tables** = independent campaigns (own GM password, players, actors, maps, campaign,
shop/training/audio state, uploads, docs, backups). Modules are unchanged: they always receive ONE table's state. How a
request finds its table: [architecture.md](../architecture.md#routing); table scope for module code:
[architecture.md](../architecture.md#table-scope); persistence and backups per table:
[architecture.md](../architecture.md#persistence--robustness).

- **Registry** `<runtime>/server.json` `{ tables: [TableMeta], adminPasswordHash, adminPasswordEnv }`, `TableMeta = {
  id, slug (= id, immutable), name, createdAt, archived, hidden, pack: 'project-lazarus'|'vierge'|'demo', lang,
  legacy?, docsDir?, demo? }`; a copy sits in `tables/<id>/table.json` so a copied/restored folder is adopted at boot.
  `<runtime>` = `SR_RUNTIME_DIR` or `data/`.
- **Name**: `state.config.campaignName` is the table's display name (GM `config/update` → registry follows; admin rename
  → state follows).
- **Migration**: an old `<runtime>/state.json` (+ `backups/`, `uploads/`) becomes table `lazarus` with `legacy: true`
  (keeps `/uploads/…`, `/assets/foundry/…` URLs and the `../Shadowrun` docs folder); the original file is kept as
  `tables/lazarus/backups/legacy-state-<ts>.json`. Empty install: table `lazarus` is created unless
  `SR_BOOTSTRAP_TABLE=none` (Docker image).
- **Auth**: sessions stay in each table's `state.sessions`; socket handshake `{ token, table }`; tables never share
  sockets (one socket set + Socket.IO room `table:<id>` per table, per-table 30 ms broadcast). GM/PIN/admin logins are
  rate-limited per IP. A table display link's token (`state.displays[id].token`) is accepted in the same handshake
  and resolves to a read-only `display` user of that table ([display.md](display.md)); it never authenticates HTTP.
- **Module-level state audited for table isolation**: maps vision cache = `WeakMap` keyed by the map object (OK);
  combat undo stack → `WeakMap` keyed by the table state (was one global array); foundry `audioJob` → `Map` by table
  id, world cache keyed by path + fingerprint (OK), journals/assets per table; chummer mugshots → current table's
  uploads; shop/training catalog indexes, chummer data caches, augment ware index: global read-only catalog data (OK).
- `GET /api/health` → `{ ok, tables, broken: [ids], uptime }` (Docker healthcheck).

## Files

Uploads `tables/<id>/uploads/` served at `/t/<slug>/uploads/…` (legacy table: `/uploads/…`); Foundry imports copy
assets to `tables/<id>/assets/foundry/` → `/t/<slug>/assets/foundry/…` (legacy table: shared `data/assets/foundry/` →
`/assets/foundry/…`).

## Admin API

`server/lib/admin.ts`, separate bearer token from `POST /api/admin/login { password }`, 12 h:
`GET/POST /api/admin/tables`, `PATCH /api/admin/tables/:id { name?, hidden?, lang?, archived? }`, `POST
…/:id/gm-password`, `POST …/:id/gm-session` (open as GM), `POST …/:id/download` → one-time `GET
/api/admin/download/:ticket` (zip: state, uploads, docs, assets; `withBackups`), `DELETE …/:id { confirm: id }` (zip
kept in `<runtime>/deleted/`), `POST /api/admin/restore?slug=&name=&replace=1` (body: table zip or state JSON,
streamed), `POST /api/admin/password`, `POST /api/admin/deleted/:file/download`. The admin password comes from
`SR_ADMIN_PASSWORD` (re-applied whenever it changes) or is generated and printed once.
- The per-table GM routes `/api/admin/backup|export|import|reset` act on the GM's own table.
- Admin HTTP errors use `errorBody()` too (`fail(res, status, key, extra, params)` in `server/lib/admin.ts`), so
  `/admin` shows them in English.
- Server-wide panels of `/admin`: rulebooks ([books.md](books.md#admin)), map library
  ([map-library.md](map-library.md#admin)), assistant ([assistant.md](assistant.md)).

## Zips

`server/lib/zip.ts`: streamed to disk (`receiveToFile`, size cap), read from the central directory (ZIP64, CRC checked,
entries bigger than declared refused), extraction rejects the whole archive on any dangerous path (absolute, drive
letter, `..`). adm-zip is not used: it loads whole archives in memory.
