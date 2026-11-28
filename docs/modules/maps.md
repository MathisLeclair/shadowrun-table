# Maps & vision

Tile maps, tokens, doors, lights, fog of war and line of sight; Foundry-style segment walls and image backgrounds.

| | |
|---|---|
| server | `server/modules/20-maps.ts` (owner of `state.scene`, `state.maps`) |
| shared | `shared/vision.ts` (line of sight, light) |
| client | `client/modules/map/` (MapView, MapsPage, editor, `renderer.ts`, `MapCanvas`) |
| tests | `node tools/test-maps.ts` (port 3201), `node tools/check-maps.ts` |

Library maps shared by every table: [map-library.md](map-library.md). Combat marks on the map (targets, blasts):
[attacks.md](attacks.md).

> Tokens may carry `astral: true` (an astral form, 47-magic): players without astral sight do not get them — see [magic.md](magic.md#astral).

## State

`scene: { activeMapId }` (the map players currently see) and `maps: { [id]: GameMap }` — types `SceneState`,
`GameMap`, `Token`, `MapDoor`, `MapLight`, `MapRegion`, `MapNote`, `MapWall`, `MapBackground` in types.ts. Facts the
types don't say:
- `folder` ('Acte 1'…) groups maps in the GM list; `description` is GM only; `regions` are labelled rooms/zones
  (`gmOnly` ones hidden from players); `notes` are GM pins.
- `tiles`: `height` rows of `width` chars, legend below. `doors[]` give the state of `D` cells (`kind: 'door'|'gate'|
  'shutter'|'secret'`); `lights[]` `{ x, y, radius, color: '#ffcc88', on }`; `lighting` = ambient light.
- `weather?: { visibility: 0..3, wind: 0..3 }` = rain / fog and wind levels of the environmental modifier
  ([rules/combat.md](../rules/combat.md#range-and-environment)).
- `explored: { [userId]: string }` = fog-of-war memory (encoding owned by maps module); `fog: false` = players see the
  whole map; `sharedVision` = party shares what any PC sees; `movementLocked` = GM freeze.
- `background?: { url, opacity }` (optional image underlay; full shape below), `theme?: 'street'|'bar'|'corp'|'lab'|
  'industrial'|'residential'|'matrix'|'club'`, `library?` (GM only, [map-library.md](map-library.md)).
- Token: `x, y` integer cells, `size: 1`, `disposition: 'pc'|'ally'|'neutral'|'hostile'`, `hidden` (GM only),
  `vision?: { lowLight, thermo, darkRange }`, `light?: { radius, color }` (torch/flashlight), `status?: [string]` ('à
  terre', 'inconscient', 'mort', …), `moveBudget` (combat movement).

### Tile legend (one char per cell)

| char | meaning | blocks movement | blocks sight |
|---|---|---|---|
| ` ` | void / outside the map | yes | yes |
| `.` | interior floor | no | no |
| `,` | exterior ground / street / asphalt | no | no |
| `#` | wall | yes | yes |
| `D` | door location (state comes from `doors[]` entry at x,y; no entry = open doorway) | if closed/locked | if closed/locked |
| `W` | window | yes | no |
| `=` | counter / low wall / railing | yes | no |
| `T` | table / furniture | yes | no |
| `c` | crates / cover | yes | no |
| `o` | pillar / column | yes | yes |
| `m` | machinery / server rack / tall shelves | yes | yes |
| `v` | vehicle | yes | no |
| `b` | bed / sofa | yes | no |
| `s` | stairs / ramp | no | no |
| `e` | elevator | no | no |
| `~` | water | yes | no |
| `g` | grass / vegetation | no | no |
| `r` | rubble / debris (difficult terrain) | no | no |
| `x` | hazard (fire, chemicals, electric) | no | no |
| `t` | trees / dense bushes | no | yes |
| `_` | carpet / special floor (stage, rug, dance floor) | no | no |

## Vision

`shared/vision.ts`, maps module: line of sight from a token's cell; closed doors and opaque tiles block. Light:
`bright` → everything in LOS visible; `dim` → visible within 12 cells (24 with lowLight); `dark` → only cells lit by
`lights[]` or token lights (radius ×2 with lowLight), or within `vision.darkRange` (thermographic = 10 cells). The server
filter removes from players' views: tokens not visible to them (and all `hidden` tokens), GM notes, `gmOnly` regions,
`description`, other maps (players only receive `maps[scene.activeMapId]`), and secret doors (rendered as walls while
`kind:'secret'` and `state !== 'open'`).

## Actions

Player actions: move own tokens (only to cells reachable without passing walls/closed doors; not while
`movementLocked`), open/close unlocked doors within 1 cell (Chebyshev) of one of their tokens, ping. GM: everything.

All actions: `maps/create|update|paint|setTiles|resize|duplicate|delete|import|setActive|resetFog`, tokens
`maps/addToken|updateToken|removeToken|moveToken|moveTokens|placePCs`, doors `maps/toggleDoor|setDoor|addDoor|
removeDoor`, walls `maps/addWall|updateWall|removeWall|setWalls`, lights `maps/addLight|updateLight|removeLight|
toggleLight`, `maps/addRegion|updateRegion|removeRegion`, `maps/addNote|updateNote|removeNote`. Library actions
(`maps/fromLibrary`…): [map-library.md](map-library.md).

## Segment walls and image backgrounds

Maps imported from Foundry VTT keep their artwork. They use the same Map schema plus:
```js
map.walls = [{                    // thin walls between/through cells, coordinates in CELL units (floats), origin = top-left of the grid
  id, x1, y1, x2, y2,
  move: true, sight: true,        // which things the segment blocks (a window: move true, sight false)
  door: null | { state: 'open'|'closed'|'locked', kind: 'door'|'secret', name? },   // a door segment blocks only when not open
}]
map.background = { url, opacity: 1, mode: 'image' | 'underlay', x: 0, y: 0, w: width, h: height }   // x/y/w/h in cells
```
- `mode: 'image'` → the image IS the floor: the renderer draws it and does not paint tile art (tiles stay for
  movement/vision: usually `.` inside the scene, ` ` outside). `mode: 'underlay'` (default, legacy) → tiles drawn over
  the image at its opacity.
- Segment walls block line of sight, light, and movement exactly like opaque tiles/doors do (a step between two cells
  is blocked if the segment crosses the line between their centres; LOS to a cell is blocked if every sample ray
  crosses a blocking segment).
- Segment doors are toggled with `maps/toggleDoor {mapId, doorId}` where `doorId` is the wall id; players must have a
  token within 1.5 cells of the door segment's midpoint. Same sfx and rules as tile doors.
- Lights from Foundry: `radius` in cells (= Foundry dim radius in grid units ÷ grid distance).
- Deviation: closed secret wall-doors (`door.kind === 'secret'` and not open) are sent to players as anonymous plain
  walls (no door, no name), so vision/movement stay consistent client-side.
- Player filter: lights are only sent when their glow reaches a known cell, without their `name`; the combat filter
  drops NPC entries whose token is on the shown map but not visible to that player.
- Players can only switch the standard torch (radius 6) on their token (`light` patch); radius is GM-only.
- In combat, `maps/moveToken` enforces the run rate ([rules/combat.md](../rules/combat.md#movement-sr5-p-161)) per
  combat turn for players (`token.moveBudget`).
