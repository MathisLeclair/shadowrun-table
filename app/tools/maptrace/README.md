# Map tracing toolkit — tracer's manual

You turn a Fragmaps image into `data/maplib/<slug>.json` (walls, doors, windows, lights, regions, entry, French
name/tags/description). Format: `ARCHITECTURE.md` « Map library ». Images are paid content: **never** copy them into
the repo, never commit them. All commands run from `app/`. Write crops into **your scratchpad** (`--out <dir>`).

## Scale (rely on this)
**A Fragmaps image is always a whole number of 5 ft cells, grid origin at the top-left (offset 0,0), and the pitch is
the LARGEST of 200 / 140 / 120 / 100 / 80 / 70 px that divides both sides (±2 px).** Measured on the 4 « grid » twins
(tailor shop 200, kingpins 200, rooftop garden 140, jungle landing pad 80); the fragmaps-free scenes use 100/120.
The 69 distinct maps (71 root images − 4 grid twins − `tailor shop (1).jpg`, an exact duplicate, + 3 yacht decks):
40 → 200, 23 → 140 (incl. the yacht), 2 → 120, 2 → 100, 2 → 80. `new.js` and `tiles.js`
apply it automatically; `scale.js <image>` prints it with a sanity line — check one object: door leaf ≈ 0.6 cell,
pool table ≈ 0.85 × 1.7, car ≈ 1.3 × 3, 3-seat sofa ≈ 1.4. Ambiguous sizes (dead end market slums, food truck alley,
waste treatment plant, rooftop parking, desert checkpoint): check an object before trusting the rule.

## Tools
| command | what |
|---|---|
| `node tools/maptrace/new.ts "<image>" [--slug s --nameFr "…"]` | scaffold `data/maplib/<slug>.json` (geometry filled) |
| `node tools/maptrace/tiles.ts <slug\|image> --out D` | `overview.jpg` + 12×12-cell `tile_X_Y.jpg` crops (≤ 1100 px), cell numbers in the margins (yellow = multiple of 5), `x,y` tags at 5×5 crossings. `--tile 16` for big maps |
| `node tools/maptrace/tiles.ts <slug> --region x,y,w,h --ppc 250 --out D` | one zoomed crop (keep `w*ppc + 68 ≤ 1100`) |
| `node tools/maptrace/probe.ts <slug> --row 4.5 [--from 0 --to 11]` / `--col 3` | exact positions along a line: `bg` (outside), `floor`, `DARK` bands with their **centre** — use it for wall coordinates |
| `node tools/maptrace/overlay.ts <slug> --out f.jpg [--region x,y,w,h] [--ids]` | your trace over the image: walls cyan, doors green/amber/red, secret violet, windows blue dashed, lights yellow, regions, entry X, check issues in red circles |
| `node tools/maptrace/check.ts <slug> [--fix]` | validation (below). `--fix` snaps leaks + rewrites the file one wall per line |
| `node tools/maplib-build.ts` | (lead) copies images + thumbnails into `<runtime>/maplib/` |

**Reading a crop**: a pixel (px, py) of a `--region x,y,w,h --ppc P` crop is the cell point
`x + (px − 34)/P , y + (py − 56)/P` (34 px margin, 22 px title). Tiles print their px/cell when written.

## Method (≈ 20–40 min per map)
1. `new.js` → `tiles.js --out` → look at `overview.jpg`: building outline, rooms, doors, exits. Decide indoor/outdoor.
2. **Long walls first, from the overview + `probe.js`**: probe one row/column per room (`--row` through the middle of
   rooms) — read `bg→floor` edges and `DARK` band centres; write the outline and big partitions.
3. **Refine tile by tile** (zoom crops at 200–300 px/cell on corners, doors, diagonals). Fragmaps walls are thick dark
   bands: put the segment on the band's **centre line**. Thin-edged maps (no band, e.g. dive bar): put it on the floor edge.
4. **Doors** = wall segments with `door: { state: 'closed', kind: 'door' }` spanning the whole opening frame-to-frame
   wherever you see a leaf, slab, frame or keypad. Opening without leaf = gap (archway). Hidden passage = `kind: 'secret'`.
   Shutters/garage doors = doors too. Split the wall around the door (wall | door | wall, shared endpoints).
5. **Windows / glass / railings over a drop** = `move: true, sight: false`. Counters, bars, booths, tables, low
   dividers, shelves, cars, crates: **not walls**. Floor-to-ceiling only (wardrobes and server racks stay untraced).
6. **Close indoor buildings** completely (outline + exterior doors). Outdoor maps: walls only on buildings, fences,
   cliffs; the open ground stays open (check's `outside` warning can be ignored there).
7. Lights at visible sources: ceiling lamps 3–4, neon/screens 1.5–3, street lamps 5–6, colour from the art
   (`#rrggbb`). Never ON a wall line (move them 0.2 inside). `lighting`: `dark` for night exteriors / unlit, `dim` most
   interiors with neon, `bright` daylight.
8. Regions: integer rectangles naming rooms in French (« Cuisine », « Arrière-salle », « Quai de chargement »…),
   4–10 per map. `entry` = where PCs arrive (inside the entrance door), float cells.
9. Fill `nameFr` (natural French), `theme`, `tags` (6–15, FR + EN: place, mood, use — e.g. `planque`, `safehouse`,
   `Johnson`, `fusillade`), `description` (French, 1–3 sentences: what + Seattle 2080 uses), `traced.quality`
   (`good` when checked with overlays) and `traced.notes` (choices a GM should know: assumed doors, skipped items).
10. `check.js <slug>` until **0 errors / 0 warnings**, then a final full `overlay.js` + 2–3 zoomed overlays.

Write the file with a small Node script or by hand, then `check.js --fix` for the canonical layout. Ids `w1…`, `l1…`, `r1…`.

## What check.js enforces
Schema (id `lib_<slug>` = file name, enums, `width = ceil(imageW/gridPx)`, real image size), bounds, zero-length,
duplicate and overlapping walls, door length ≥ 0.6 (< 0.3 error, > 3 warn), **leaks** (a free wall end 0.01–0.4 cell
from another wall — light/sight pass through), **openings** (info: free ends 0.4–1.6 apart → archway or missing door?),
every region reachable from `entry` with doors open, and **outside** (cells on the empty background reachable from
the entry with every door closed = a hole in the outline). Stats: walls, doors, windows, lights, regions, joined ends.

## Pitfalls met during calibration (1 BDRM, dive bar)
- **Tokens move centre to centre**: a step is blocked if the segment crosses the line between the two cell centres.
  A door must contain a crossing point: on a horizontal wall its x-range must include some `k + 0.5`, on a vertical
  wall its y-range some `k + 0.5`. A painted 0.55-cell door at x 3.85–4.40 is impassable → stretch it to 3.85–4.55.
  `check.js` reports the resulting `unreachable` region.
- Walls closer than 0.5 cell to the map edge separate no cell centres — harmless, but keep them for sight/light.
- The outer band of many maps is nearly the background colour: `probe` shows `bg` until the band's inner edge, so the
  centre is ~half a band (0.05–0.15) outside the first `floor`/`DARK` value. Compare with a zoom crop.
- Dark furniture, black floors and shadows also show as `DARK` in `probe`; trust a band only if it runs along the wall
  in the crop.
- Diagonal walls: probe 3–4 rows, take the band centres, fit one line, then clip it at the walls it meets.
- Keep T-junctions exact (endpoint ON the other wall); `--fix` snaps anything within 0.4 cell.
- Doors in Fragmaps are often drawn as a grey slab with a handle/keypad next to the wall, or as an open leaf at an
  angle (the hinge is where the leaf touches the wall; the opening is the leaf's length).
- Don't trace furniture « because it blocks »: the GM handles cover; walls are for vision.

## Time savers
- Probe several lines in one shell loop: `for y in 2 5.5 9; do node tools/maptrace/probe.ts <slug> --row $y; done`.
- Trace the outline in one pass from probes + overview; use zoom crops only where the probe is ambiguous.
- `overlay.js --region … --ids` shows wall ids to fix exact walls; red circles show check issues in place.
- Big maps (≥ 40 cells): `tiles.js --tile 16`, and probe every 5 cells along both axes first.

## Calibration results
- `1-bdrm.json` (6×6 @ 200 px): 12 walls, 3 doors (entrance keypad door, bathroom, en-suite bedroom), 7 lights, 4 regions; joined ends 30/30.
- `dive-bar.json` (11×18 @ 140 px): 23 walls, 2 doors (street door at the bottom of the stairs, back room), 1 railing
  window, 21 lights, 8 regions; joined ends 51/52 (free end = railing top).
