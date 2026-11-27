# Foundry VTT import

| | |
|---|---|
| server | `server/modules/80-foundry.ts` (owner of `state.foundry`), `server/lib/foundry/` (`world.ts`, `importer.ts`, `convert-actor.ts`, `convert-scene.ts`, `convert-misc.ts`, `assets.ts`, `upload.ts`) |
| client | `client/modules/foundry/FoundryPanel.tsx` (Réglages), `client/modules/admin/FoundryUpload.tsx` |
| tools | `node tools/foundry-import.ts` |
| tests | `node tools/test-foundry.ts` (port 3272) |

## State, actions, routes

Slice `state.foundry = { worldPath, lastScan?, lastImport? }` (GM only, `FoundryState`).
- Actions (GM): `foundry/worlds` (list detected worlds), `foundry/scan` `{ worldPath? }` → importable summary,
  `foundry/import` `{ worldPath?, select: { pcs, npcs, scenes, journals, playlists }, pcMode: 'replace'|'merge',
  assignPlayers? }`. Route `GET /api/foundry/status` (GM).
- Worlds uploaded as zips (VPS): `GET /api/foundry/uploads`, `POST /api/foundry/upload?kind=world|data` (body = zip,
  streamed; world → `tables/<id>/foundry/Data/worlds/<world>/` and becomes `state.foundry.worldPath`; data = extra Data
  folders such as `Music/`), `DELETE /api/foundry/uploads` — UI in Réglages (`client/modules/admin/FoundryUpload.tsx`).
  With `SR_FOUNDRY_LOCAL_PATHS=0` (Docker) a GM can only read worlds uploaded to their own table; otherwise local paths
  work but never another table's folder.
- Offline: `node tools/foundry-import.ts [--write-seeds] [--world <path>] [--dump <dir>] [--no-audio] [--no-journals]`
  regenerates the seeds.
- Env vars: `SR_FOUNDRY_ASSET_DIR` (where the legacy table's assets are copied, default data/assets/foundry; other
  tables: tables/<id>/assets/foundry), `SR_FOUNDRY_DOCS_DIR` (journal markdown output, default <table docs
  folder>/foundry).

## How it reads a world

Reads a Foundry VTT v11+ world (LevelDB) from a COPY in a temp dir. Default world: auto-detected from
`%LOCALAPPDATA%/FoundryVTT/Config/options.json` → `dataPath`/Data/worlds/* with `"system": "shadowrun5e"` (here:
`C:/Users/mathi/Documents/Foundry/Data/worlds/test-world`). Assets it references (portraits, scene backgrounds, playlist
audio) are copied into `data/assets/foundry/…` and served at `/assets/foundry/…` (per-table paths:
[multi-table.md](multi-table.md#files)). Every imported record keeps `foundry: { id, world, importedAt }` so a later
re-sync updates the same record. Journals are written as markdown to the table's docs folder, `foundry/*.md` (listed by
the docs API under folder `foundry`). Scenes become maps with segment walls and an image background
([maps.md](maps.md#segment-walls-and-image-backgrounds)).

Attribute / initiative bonuses come from active effects + known boosts (`convert-actor.ts`,
[rules/modifiers-stacking.md](../rules/modifiers-stacking.md#no-double-counting)); item sources from
`system.description.source` ([book-refs.md](book-refs.md)); inventories and ammo: [inventory.md](inventory.md#imports).

## Nested lists

`server/lib/foundry/convert-actor.ts`: lifestyle items → `lifestyles[]` (`system.type` → base,
comforts/security/neighborhood → `points`, `system.mods` → qualities; `system.cost` is the TOTAL per month: without
options it becomes `baseCost`, with options `baseCost` = the catalog base and the options are added back — no double
count); weapon/armor modifications embedded in the item (`flags.shadowrun5e.embeddedItems`, `system.mod_weapon {
mount_point, accuracy, rc, dice_pool }`, `system.mod_armor.value`) → accessories / mods.
- A merge re-import whose snapshot predates `lifestyles[]` adopts the app lifestyle of the same name instead of
  duplicating it.
- `actor.foundry.snapshotVersion` (2 = item hashes include `mounts` / `capacity` / `accessories` / `mods`): with an
  older snapshot an item that only differs by those fields counts as unchanged; an item Foundry did change replaces the
  app's but keeps the nested entries the app added (absent from Foundry, matched by catalogId / name, non-`fvtt_` ids)
  and `ammoLeft`.
- App-only fields kept by merges: `APP_ONLY_BY_LIST` (e.g. `lifestyles` → `home`).
