# Lifestyles & homes

A character's lifestyles (`actor.lifestyles[]`, characters module), their options, the apartment drawn for each one,
and the historic Chummer restore. Cost formula: [rules/availability-and-shop.md](../rules/availability-and-shop.md#lifestyle-cost).

| | |
|---|---|
| shared | `shared/lifestyle.ts` (cost, options), `shared/home.ts` (layouts, `buildHome`) |
| server | `server/modules/10-characters.ts` (lists), `40-shop.ts` (buying options, rent, `shop/chooseHome`, restore) |
| client | `client/modules/sheet/home.tsx` + `home.css`; lifestyle cards in the « Contacts & SIN » tab |
| tests | `node tools/test-lifestyle.ts` (ports 3251-3252: cost math, migration idempotence, restore, lifestyle options, rent per lifestyle, permissions, homes), `node tools/test-home.ts`, `node tools/test-restore-lifestyles.ts` (ports 3290-3291) |

## State

`Lifestyle` / `LifestyleQuality` / `LifestyleHome` in types.ts. Facts the types don't say:
- `name` is free ('Best Home'); `base`: 'Street'|'Squatter'|'Low'|'Medium'|'High'|'Luxury'|'Bolt Hole'|'Traveler'|
  'Commercial'|'Hospitalized'; `baseCost` ¥/month; `primary`: exactly one; `points` = Run Faster points (comforts,
  security, neighborhood, entertainment?), `pointCost`.
- Options (`qualities`): `category` ('Positive'|'Negative'|'Contracts'|'Entertainment - Asset'…), `cost` (flat ¥/month),
  `multiplier` (%, e.g. −20 = Dangerous Area), `baseOnly?` (the % applies to baseCost only: Chummer
  `<multiplierbaseonly>` / `<basemultiplier>`, Extra Secure +20), `lp?`.
- `monthlyCost` is derived but stored (`shared/lifestyle.ts monthlyCost()`), always recomputed by the actions.
- `home?: { layout, since, moves }` — the apartment drawn for this lifestyle (below).

Helpers in `shared/lifestyle.ts`: `monthlyCost`, `costBreakdown`, `isContract`, `settleLifestyles` (stores
monthlyCost, one primary), `primaryLifestyle`, `lifestyleFromCatalog`, `qualityFromCatalog`, `qualityProblem(l, item,
lookup?)` (allowed / required bases, duplicates, options forbidden by / required with the other options —
lookup(catalogId) → catalog item also catches an existing option that forbids the new one).

## Buying and paying

- A shop `lifestyles` line (qty = months paid, `lifestyleName?`, `primary?`) ADDS a lifestyle (the first one is
  primary). `shop/payLifestyle { actorId, lifestyleId? (default: primary), months 1–24 }` pays that lifestyle's
  `monthlyCost` (upgrades included).
- Lifestyle options cost nothing up front except the rent difference × months already paid (`line.monthlyDelta`,
  `line.monthlyCost`), then change the monthly cost. Options that lower the rent (`lowersRent`: category 'Negative',
  negative cost or multiplier) bought by a player ALWAYS wait for the GM ([shop-upgrades.md](shop-upgrades.md#actions)).
- GM edits: `actor/addItem|updateItem` with list `lifestyles` ([characters.md](characters.md#nested-items-accessories-mods-options-techniques)).

## Homes

`shared/home.ts`, UI `client/modules/sheet/home.tsx` + `home.css`, tests `tools/test-home.ts` + the « homes » part of
`tools/test-lifestyle.ts`: each lifestyle level has 1–3 hand-drawn layouts (`HOME_LAYOUTS`: ASCII rows in the map tile
legend + `E` entrance, `d` open door, `L` locked, `%` secret, `G` shutter, digits = room markers flood-filled into
labelled regions; `out` rooms = corridor / street / shared kitchen, never glued onto). Street has none. Lifestyle
options that are places (`homeModuleKey`: garages, workshop, yard, pool, gym, armory, panic room, bat cave, escape
tunnel…) become modules glued onto a free wall (`buildHome`: 4 rotations, every offset, the module's top row must
share ≥ 3 wall cells with the home and get a door onto the living room > another room > another add-on; outside of
entrances stays free; « Pas de place pour : … » when nothing fits). The map is rebuilt on the fly (never stored), so a
bought / removed garage shows at once.
- `shop/move { actorId, lifestyleId, layout?, x?, y? }` (alias `shop/chooseHome` with a layout; spot on the city map: [city](city.md)) (owner or GM): first pick free; another layout of the same level
  = a move, paid `homeMoveCost` (one month of the level's rent — house rule, SR5 has none) by players, free for the GM;
  logs « emménage / déménage ».
- `lifestyle.home` is sanitized on GM edits (`sanitizeHome`, bad → removed), kept by Chummer re-imports (app-only
  field) and Foundry merges (`APP_ONLY_BY_LIST.lifestyles`); a layout of another level counts as none (new level → free
  pick).
- The sheet's lifestyle card has a « 🏠 » button (GM / owner): chooser with previews (`drawStaticMap`), pan/zoom viewer
  (`MapCanvas`), GM « Créer une carte de jeu » (`maps/import` of the built map, folder « Logements »).

## Migration

`normalizeActor` (characters) gives every actor `lifestyles: []` and migrates a legacy `lifestyle: { name,
monthlyCost, monthsPaid }` once into `lifestyles[0]` (base guessed from the name, `baseCost = monthlyCost`). 40-shop
init has a safety net and recomputes every `monthlyCost`.

## Historic Chummer restore

`data/seed/upgrades-restore.json` (Lazarus pack, generated from `../Shadowrun_chum5_files`, historic) lists lifestyle
options, weapon accessories and armor mods the PCs had in Chummer; 40-shop init applies it ONCE per actor
(`shop.restored`), only to a lifestyle of the same name that has no option yet (its `baseCost` becomes the catalog base
cost) and to weapons / armors found by catalogId or name (restored armor mods carry no `effects.armor`: the stored
Foundry rating already counts them), with a history line « Options restaurées depuis Chummer : {n} ». The Lazarus seed
actors (`data/seed/actors/pcs.json`) already contain it. Per actor: `actorName`, `chummerFile`, `chummerDate`, `note`
(notes of every restored sub-item, « Restauré depuis Chummer (fichier du …) — à vérifier »), `lifestyleNote` (appended
once to the primary lifestyle's notes: historic lifestyle NOT restored, Christopher), `inferred: true` (not from a
Chummer file: Anthony's DocWagon deduced from his 7083 ¥ rent — never applied by the boot restore, only by
`tools/restore-lifestyles.ts --include-inferred`; the Lazarus seed already has it).
GM-facing comparison: `../Shadowrun/historique-chummer.md`.

**Restore on a running table**: `node tools/restore-lifestyles.ts --url <server> [--table <slug>] --password <gm pw>
[--dry-run] [--include-inferred]` applies the LIFESTYLE part of that spec through GM actions (`actor/updateItem`
catalogId/base/baseCost, `actor/addSubItem` qualities, `lifestyleNote`): matches the actor by id then PC name, the
lifestyle by name then the only/primary one; skips options already present (catalog id or name), never removes
anything, never touches karma/nuyen/items, refuses a server without `actor.lifestyles`; inferred specs only with
`--include-inferred`. After the boot restore it reports « Nothing to do ». Test: `node tools/test-restore-lifestyles.ts`
(ports 3290-3291).

## Chummer and Foundry

Lifestyle parsing / export: [chummer.md](chummer.md#nested-lists). Foundry lifestyle items: [foundry.md](foundry.md#nested-lists).
