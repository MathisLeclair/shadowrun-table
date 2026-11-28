# City map (« Seattle » tab)

Where the runners live, on the city map. Level 1 is the apartment plan ([lifestyles](lifestyles.md#homes)); this page
covers level 2 (the whole city with the homes pinned on it) and level 3 (zoom into a district).

Files: `shared/city.ts` (pure helpers), `server/lib/city.ts` (shapes files, active city), `server/modules/72-city.ts`
(state, view, GM actions), `shop/move` in `server/modules/40-shop.ts`, UI `client/modules/city/CityPage.tsx` + `city.css`,
the sheet's « 📍 » button (`CityPlaceButton` in `client/modules/sheet/home.tsx`), tool `tools/city-districts.ts`,
data `data/city/seattle.json`, tests `tools/test-city.ts`.

## Districts

District shapes are traced once from the map image by `tools/city-districts.ts` (the image itself,
`data/assets/foundry/scenes/DqT4928.jpeg`, is third-party art and not in git; the traced shapes are):

```
node tools/city-districts.ts [--image <jpeg>] [--out data/city/seattle.json] [--qa <out.jpg>] [--step 4] [--tol 1.2]
```

It samples the image every 4 px, gives each sample the nearest palette colour (the 12 district fills + backgrounds),
lets unknown samples (white sub-district lines, labels, road marks) take the majority district around them, removes
roads with a morphological opening, drops components under 150 samples, gives the components of two same-colour
districts (Council Island / Ft. Lewis) to the nearest seed, closes notches and border lines (radius 3 samples, only
over unclaimed samples), fills every hole that holds no other district (lakes, road numbers, labels inside a district
belong to it; a lake between two districts stays outside), then traces pixel-edge contours and simplifies them
(Douglas–Peucker). Rings are in cells (÷ 25 px) and use the even-odd rule: several rings = islands (Outremer), a ring
inside another = a hole. `--qa` writes the image with the outlines for a check by eye. Seeds and colours of
Seattle are at the top of the tool.

`CityShapes` (`data/city/<id>.json`): `{ id, name, background (image URL), width, height, traced, districts }`; a
district is `{ id, name, color, rings, security? }`.

**Security ratings** come only from the source: SR5 p. 352 « HTR Team Response Time » names Downtown Seattle (AAA) and
the Redmond Barrens (Z, a part of Redmond), so only those two carry `security`. Every other level of that table is a
kind of housing, so a home shows the rating of its lifestyle level (`homeSecurity`: Luxury AA, High A, Medium B, Low C,
no row for Squatter / Street) with the HTR response time (`HTR_RESPONSE`). Emerald City / Seattle 2072 ratings are not
used (books not in the PDFs).

## State and view

- `state.city = { mapId, shapes, districts }`: `mapId` null = the first table map whose background has traced shapes
  (`guessCityMap`); `districts` is a copy of the shapes (init refreshes outlines and adds missing districts, keeping
  the GM's names).
- `lifestyle.place = { x, y, district, at, guests? }` (cells of the city map). `district` is computed by the server
  (`placeAt`); `guests` = PC ids the GM « invited ». Players never write it through `actor/updateItem` (dropped);
  GM edits go through `sanitizePlace`; Chummer / Foundry re-imports keep it (app-only field).
- `game.city` (`CityView`, built by the module's filters; `state.city` is never sent as is):
  `{ map: { id, name, width, height, background } | null, districts, pins }`. Pins: GM = every PC home placed;
  player = their runners' homes (`own`) + homes whose `guests` include one of their runners (without the guest list).
  On other runners' sheets a player's view drops `place` and `home` unless invited.

## Actions

| action | who | what |
|---|---|---|
| `shop/move { actorId, lifestyleId, layout?, x?, y? }` | owner / GM | sets the flat and / or the spot. The first flat and the first spot are free; changing one that is set is a move: one fee (`homeMoveCost`, a month of the level's rent, house rule) even when both change; GM free. A new spot clears `guests`. Refuses « Tu habites déjà ici » / « Rien à changer ». |
| `shop/chooseHome { actorId, lifestyleId, layout }` | owner / GM | level-1 name, same as `shop/move` with a layout only |
| `city/settings { mapId?, names? }` | GM | city map (null = guess) and district names (empty = traced name) |
| `city/invite { actorId, lifestyleId, guests }` | GM | runners whose players see this home (PCs only, not the owner) |
| `city/unplace { actorId, lifestyleId }` | GM | takes a home off the map (the player places it again for free) |

## UI

Main tab « Seattle » (`registry.ts`, `visible`: GM always, players when the table has a city map). `MapCanvas` draws a
plain image map built on the client (no tiles, fog or grid); an SVG overlay follows the renderer's view (rAF) and draws
the hovered district, the focused district with the rest of the city dimmed (even-odd mask), and the pins in screen
space. Clicking a district zooms to it (`MapRenderer.fitRect(x, y, w, h, ms)`, an eased tween; user pan / zoom stops it).
Side panel: district name, its sourced ratings, homes there; « Mes logements » (GM: every runner) with « Placer sur la
carte » / « Déménager… », the plan, GM « Inviter… » / « Retirer de la carte »; players' « Invité chez ». Placing: click a
spot, then keep the current flat or pick one (`Chooser` from `sheet/home.tsx`, one confirm, one fee). Esc cancels the
placing, then leaves the district. The sheet's lifestyle card has « 📍 district » (or « Placer sur la carte »), which
opens the tab on that home.

Later (decided): GM-only places (safehouses, run targets, contacts), dragging pins, sub-districts from the white lines.
