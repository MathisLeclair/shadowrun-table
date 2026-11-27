# Chummer5a import / export

| | |
|---|---|
| server | `server/modules/85-chummer.ts` (owner of `state.chummer`), `server/lib/chummer/` (`parse.ts`, `export.ts`, `merge.ts`, `data.ts`) |
| client | `client/modules/chummer/` (ChummerActions on the sheet) |
| tests | `node tools/test-chummer.ts` (port 3271); fixture `tools/fixtures/chummer-test.chum5` (made with Chummer 5.226.0) |

## State and actions

Slice `state.chummer = { allowPlayerImport: true, pending: [{ id, ts, actorId, actorName, userId, userName, fileName,
xml, mugshots, diff, summary, warnings, status }] }` (`ChummerState`, `ChummerRequest`).
- Actions: `chummer/settings` (GM `{ allowPlayerImport }`), `chummer/resolve` (GM `{ requestId, approve, note? }`),
  `chummer/cancel` (owner/GM), `chummer/unlink` (GM `{ actorId }`).
- Routes: `POST /api/actors/import-chum5` (GM, new actor), `POST /api/chummer/import` (GM new actor, or `?actorId=` =
  update), `POST /api/chummer/preview`, `POST /api/chummer/update?actorId=` (3-way merge; players create a pending
  request unless allowed), `GET /api/chummer/export/:actorId` (owner/GM; the exported file becomes the merge base).
  `CHUMMER_DATA_DIR` overrides the Chummer data folder.
- Actor fields: `actor.chummer = { xml, fileName, importedAt, syncedAt, exportedAt?, updatedAt?, sourceHash, created,
  appVersion, mugshots? }` (xml stripped from the GM view by `gmFilter`), `item.chummerGuid`, `actor.realName`,
  `actor.metavariant`. Chummer mugshots go to the current table's uploads.

## Import, export, re-import

- Import `.chum5` → Actor (the original XML is kept in `actor.chummer = { xml, fileName, importedAt }`); `parse.ts`
  stores `<source>`/`<page>` on items and nested items ([book-refs.md](book-refs.md)) and the attribute / initiative
  bonuses from `<totalvalue>` and improvements ([rules/modifiers-stacking.md](../rules/modifiers-stacking.md#no-double-counting));
  `select…` effects get `item.choice` from `<extra>`.
- Export Actor → `.chum5`: patches the stored original when present (karma, nuyen, attributes, skill ratings,
  condition, new/removed gear by Chummer `sourceid` = catalog id), otherwise generates a new file from the skeleton
  `server/lib/chummer/skeleton.chum5` (a copy of `tools/fixtures/chummer-test.chum5`). After opening an exported file in
  Chummer, run *Réappliquer les améliorations* if bonuses look off.
- Re-import never brings back items deleted in the app since the export, nor duplicates items the app keeps in another
  list (device in `actor.matrix`, shop SIN in gear).
- Inventory locations, clips and ammo: [inventory.md](inventory.md#imports).

## Nested lists

Parse reads every `<lifestyle>` (+ `<lifestylequalities>`, cost formulas like `25000 div 12`, `<basemultiplier>` of
standard / `<multiplier>` of advanced lifestyles, RF points, primary = `<primarytenant>` else the most expensive),
weapon `<accessories>` (+ `mounts` from the data `accessorymounts`), armor `<armormods>` (capacity evaluated with the
armor's capacity), vehicle `<mods>` and `<martialarts>/<martialarttechniques>` (`chummerEval()` evaluates Chummer
formulas: Rating, Capacity, Body…, `FixedValues`, `div`, `mod`, `number()`).
- Export: lifestyles and martial arts are ordinary lists; nested nodes are synced by guid in patch mode (removed →
  deleted, new → built from the Chummer data, rating/notes patched) and built in generate mode; new nested guids come
  back in `assigned.sub[subItemId]` (stored by 85-chummer).
- Re-import (merge.ts): nested lists are merged entry by entry by `chummerGuid` like the parent lists (app ids kept;
  entries added in the app since the last sync survive an upload that did not touch them); `sameItem` ignores nested
  ids. Quality `<basemultiplier>` ↔ `baseOnly`. `lifestyle.home` is app-only and kept ([lifestyles.md](lifestyles.md#homes)).
