# Data model

How a table's state is organised. The **types are the reference**: `app/shared/types.ts` defines every slice,
item and view (search it by the type names below). This page explains what the types don't: who owns each slice,
ids, units, invariants, what players receive, and what is normalised at boot.

- `TableState` = one table's full state (`ctx.state` on the server, `state.json` on disk). `emptyState()` only holds
  version/config/users/actors/log; every other slice is created by its module's `init()` at boot, so after boot all
  of them exist.
- `GameView` = the state as one user receives it (`game` in client components), built by the core and the module
  filters (see [architecture.md](architecture.md#views-and-filters)).
- Conventions (from the header of types.ts): fields named `text`, `label`, `name`… hold **French** text (the source
  language); `i18n` / `*I18n` fields hold `{ key, params }` (log, history) or `{ t, params }` (messages) that the client
  translates ([i18n.md](i18n.md)).

## Slices and owners

Only the owning module writes a slice (other modules go through its exported helpers, e.g. `performRoll`,
`applyDamage`, `spendInitiative`, `upsertVirtualEntry`).

| slice | owner | main types | page |
|---|---|---|---|
| `version`, `config`, `users`, `sessions`, `log`, `ui` | core (`server/index.ts`, `00-core.ts`) | `TableConfig`, `User`, `LogEntry` | [core](modules/core.md) |
| `actors` | `10-characters.ts` | `Actor` and its item types (`Weapon`, `Armor`, `Gear`, `Lifestyle`…) | [characters](modules/characters.md) |
| `scene`, `maps` | `20-maps.ts` (library links: `22-maplib.ts`) | `SceneState`, `GameMap`, `Token`, `MapWall` | [maps](modules/maps.md) |
| `bestiary`, `bestiaryRemoved`, `combat` | `30-combat.ts` | `Template`, `CombatState`, `CombatEntry` | [combat](modules/combat.md) |
| `attacks` | `33-attacks.ts` | `AttacksState`, `Attack`, `Blast` | [attacks](modules/attacks.md) |
| `chase` | `34-vehicles.ts` | `ChaseState`, `ChaseVehicle`, `ChasePending` | [vehicles](modules/vehicles.md) |
| `rigging` | `34-vehicles.ts` | `RiggingState`, `TargetLock`, `TargetDesignation` | [vehicles](modules/vehicles.md) |
| `shop` | `40-shop.ts` | `ShopState`, `ShopOrder`, `AvailTest` | [shop](modules/shop.md) |
| `matrix` | `45-matrix.ts` | `MatrixState`, `Persona`, `Host` | [matrix](modules/matrix.md) |
| `magic` | `47-magic.ts` | `MagicState`, `SustainedSpell`, `AstralPresence` (+ `Actor.magic.tradition`) | [magic](modules/magic.md) |
| `training` | `50-training.ts` | `TrainingState`, `TrainingRequest` (+ `Actor.training`, `Actor.magic`) | [training](modules/training.md) |
| `audio` | `60-audio.ts` | `AudioState` | [audio](modules/audio.md) |
| `campaign` | `70-campaign.ts` | `Campaign` | [campaign](modules/campaign.md) |
| `notes` | `75-notes.ts` | `NotesState` | [notes](modules/notes.md) |
| `chargen` | `15-chargen.ts` | `ChargenState`, `ChargenDraft` | [chargen](modules/chargen.md) |
| `foundry` | `80-foundry.ts` | `FoundryState` (+ `Actor.foundry`) | [foundry](modules/foundry.md) |
| `chummer` | `85-chummer.ts` | `ChummerState` (+ `Actor.chummer`) | [chummer](modules/chummer.md) |

Not in any table state (server-wide or per-table files): the table registry (`TableMeta`,
[multi-table](modules/multi-table.md)), rulebooks ([books](modules/books.md)), the map library
([map-library](modules/map-library.md)), assistant conversations and settings ([assistant](modules/assistant.md)),
catalog files (`CatalogItem`, [shop](modules/shop.md#catalog-files)).

## Ids

- New ids come from `ctx.uid(prefix)` / `uid()` of shared/util.ts: `<prefix>_<time><counter><random>` (`map_…`,
  `tok_…`, `itm_…`, `ord_…`, `atk_…`…). The GM's user id is `'gm'`, players are `usr_…`.
- Ids are stable keys: seeds are merged by id, imports keep their own ids so a re-import updates the same record —
  Foundry items `fvtt_…` and containers `fvtt_inv_<slug>`, Chummer containers `chum_<guid>`, library seed maps
  `map_lib_<slug>`, library music `trk_lib_*`.
- `catalogId` on an item = the Chummer GUID of its catalog entry (catalog `id`); `chummerGuid` = the item's own GUID in
  the linked `.chum5` once synced; `templateId` = the bestiary template a spawned NPC came from.

## Units

- Map coordinates are **cells** (integers for tokens, fractional cells for segment walls and blast landings);
  `map.metersPerCell` converts to metres. Movement budgets, ranges, blast reach and scatter are in metres.
- Timestamps are milliseconds since the epoch (`Date.now()`).
- Money is in nuyen (¥, numbers); lifestyle costs are ¥/month; `markup`, `sellRate` and lifestyle `multiplier` are
  percents.
- Rulebook `page` fields are **printed** pages with a Chummer book code in `source` ([book-refs](modules/book-refs.md)).
- Derived values are never stored: use `derive()` / `deriveFull()` ([modules/modifiers.md](modules/modifiers.md)).
  Exceptions, stored on purpose: `lifestyle.monthlyCost` (recomputed on every change) and the attribute / initiative
  bonuses baked into `actor.augmented` / `actor.initiative` with their `item.bonus` record
  ([rules/modifiers-stacking.md](rules/modifiers-stacking.md#no-double-counting)).

## GM vs player views

The GM view is the full state minus sessions/config (plus a few trims). A player view drops GM data; each module
filters its own slice:

| slice | a player receives | details |
|---|---|---|
| `config` | `{ campaignName, lang, table }` (no password, no `gmLang`) | [core](modules/core.md) |
| `users` | `{ id, name, characterIds }` of everyone; `me` = themselves | [core](modules/core.md) |
| `log` | no `gmOnly` entries, whispers only when addressed to them | [core](modules/core.md) |
| `actors` | own PCs (no `gmNotes`), other PCs also without `notes`, visible NPCs as `NpcStub`, hidden NPCs absent | [characters](modules/characters.md) |
| `maps` | only `maps[scene.activeMapId]`, masked by vision | [maps](modules/maps.md#vision) |
| `bestiary` | nothing (GM only) | [combat](modules/combat.md) |
| `combat`, `attacks` | hidden entries and attacks on hidden NPCs left out | [combat](modules/combat.md), [attacks](modules/attacks.md) |
| `chase` | without hidden chase vehicles, their pending tests and GM-only events | [vehicles](modules/vehicles.md) |
| `rigging` | only the locks and designations of their own characters | [vehicles](modules/vehicles.md) |
| `shop` | their actors' availability tests, `contactSearch` | [shop](modules/shop.md) |
| `matrix` | their own personas, hosts they can see | [matrix](modules/matrix.md) |
| `magic` | spells their characters sustain or are under, their own astral state (all when the GM shows them) | [magic](modules/magic.md) |
| `campaign` | revealed handouts + `playerRecap` | [campaign](modules/campaign.md) |
| `notes` | own private pages + party pages (built per user) | [notes](modules/notes.md) |
| `chargen` | their own drafts | [chargen](modules/chargen.md) |
| `foundry` | nothing (GM only) | [foundry](modules/foundry.md) |
| `displays` | nothing (GM only: the links and their tokens); a display gets its own `display` settings | [display](modules/display.md) |

A table display (role `display`) receives the player view of a user without characters, with the party's eyes on the
map and no party notes ([display.md](modules/display.md)).

## Normalisation at boot

Every `init()` runs at every boot (and after reset/import) and must be **idempotent**: it creates missing slices and
fields, merges the content pack by id (adding only what's missing, so GM edits survive restarts) and migrates old
shapes in place. Notable passes:
- characters: `normalizeActor` (containers, item locations, ammo fields, ready weapons, nested-item ids, one primary
  lifestyle, legacy `lifestyle` → `lifestyles[]`), `fillItemNames` (FR/EN names from the catalog) and `fillActorRefs`
  (📖 references) on every actor — see [inventory](modules/inventory.md#live-table-migration),
  [lifestyles](modules/lifestyles.md), [book-refs](modules/book-refs.md).
- combat: stored bestiary templates go through `sanitizeTemplate`.
- shop: recomputes every `monthlyCost`, applies the historic Chummer upgrades once per actor (`shop.restored`), see
  [lifestyles](modules/lifestyles.md#historic-chummer-restore).
- maplib: `ensureLibrary()` once per process, `linkTableMaps` on every table ([map-library](modules/map-library.md)).
- Deleted seed records stay deleted: `bestiaryRemoved` (template ids), `shop.removedSeedIds`.

## Content packs (seeds)

Each table has a content pack: `project-lazarus` = `data/seed/`, `vierge` = `data/packs/vierge/` (generic bestiary,
generic audio scenes, nothing else — regenerate with `node tools/build-packs.ts`), `demo` = `vierge` +
`data/packs/demo/` (generated by `node tools/build-demo.ts`, see [demo table](modules/demo-table.md)).
The pack is merged at boot, by id, adding only what's missing (so GM edits survive restarts):
- `actors/*.json` — array of PC actors (characters module)
- `bestiary/*.json` — array of templates (combat module)
- `maps/*.json` — one Map per file (maps module). `maps/lib-<slug>.json` (Lazarus) = library instances for the
  campaign's locations (`map_lib_<slug>`, `map.library = { slug, version }`, GM notes), written by
  `node tools/maplib-campaign-seeds.ts` (same build as `maps/fromLibrary`; choices in `../Shadowrun/cartes-campagne.md`,
  one fragmap per location); test `tools/test-maplib-campaign.ts` (ports 3940-3941)
- `campaign.json` — campaign slice (campaign module; merge acts/quests/sessions/threads by id)
- `audio.json` — tracks & scenes (audio module)
- `shop.json` — specials (shop module)
- `matrix.json` — `{ hosts: [Host] }` (matrix module; Lazarus and demo packs)
- `upgrades-restore.json` (Lazarus) — historic Chummer upgrades ([lifestyles](modules/lifestyles.md#historic-chummer-restore))
