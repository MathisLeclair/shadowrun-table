# Shadowrun Table — architecture & module contract

Real-time web app for running the « Project Lazarus » Shadowrun 5E campaign. One Node server (the GM's PC), the GM and players connect from a browser on the LAN. **All UI text is in French** (the table plays in French). Code comments/identifiers in English.

```
app/
  server/index.js        core: HTTP, auth, Socket.IO, action dispatch, per-user views   (core-owned)
  server/store.js        state persistence (data/state.json), seeds                     (core-owned)
  server/errors.js       ActionError                                                    (core-owned)
  server/modules/NN-x.js feature modules, auto-loaded in filename order
  shared/util.js         uid(), clamp(), deepClone(), nuyen(), slug()                   (core-owned)
  shared/sr5.js          SR5 rules: attributes, SKILLS, derive(), rollDice(), skillPool() (core-owned)
  shared/*.js            other pure modules usable by server AND browser (no Node/DOM APIs)
  client/index.html      import map: 'preact', 'preact/hooks', 'htm'                    (core-owned)
  client/app.js          shell: login, top tabs, right dock, sheet modal, toasts         (core-owned)
  client/styles.css      global theme + shared classes                                   (core-owned)
  client/lib/net.js      useGame(), send(), on()/useServerEvent(), api(), upload(), useCatalog() (core-owned)
  client/lib/ui.js       html`` + UI kit (Button, Panel, Modal, Tabs, Field, TextInput, NumberInput, Select, Toggle, Badge, Empty, SearchBox, Markdown, Stat, loadCss, confirmAction, promptText) (core-owned)
  client/lib/ui-store.js useUI(), setUI(), openSheet(actorId), goTab(id), toast(text, kind)        (core-owned)
  client/lib/markdown.js renderMarkdown()                                                (core-owned)
  client/modules/registry.js  which component is which tab                              (core-owned — DO NOT EDIT)
  client/modules/<feature>/…  feature UI
  data/seed/…            initial content merged into state at boot (by id, never overwrites)
  data/catalog/*.json    gear catalog generated from Chummer data (tools/build-catalog.js)
  data/state.json        live game state (runtime, do not commit)
  tools/                 offline scripts (catalog build, checks)
```

No build step. The browser loads ES modules directly. Preact 10 + htm (`html\`...\``) + hooks. Import paths in client code are **relative** (`../../lib/ui.js`) or absolute for shared (`/shared/sr5.js`). Server imports shared with `../../shared/sr5.js`.

Run: `npm start` (port 3000, or `PORT=xxxx`). GM password default `lazarus`.

## Server module contract

`server/modules/NN-name.js`:

```js
export default {
  name: 'maps',
  // Called at every boot (and after reset/import). Create missing slices; merge seeds by id (add missing only).
  init(state, { readSeed, seedDir }) {},
  actions: {
    // role: 'gm' (default) | 'any'. Handler is synchronous, mutates ctx.state in place.
    // Return value is sent back to the caller (send() resolves with it). Throw via ctx.fail('message FR').
    'maps/moveToken': { role: 'any', handler(ctx, payload) {} },
  },
  // Optional. Mutate the player's view (a deep clone of state, already stripped of sessions/config/gm-only log).
  // Filters run in module filename order (20-maps before 30-combat, so combat can rely on the filtered view.maps).
  filter(view, user, fullState) {},
  // Optional. Trim the GM view (heavy or useless data, e.g. raw Chummer XML). Same signature as filter.
  gmFilter(view, user, fullState) {},
  // Optional. Extra HTTP routes. helpers: { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon }
  routes(app, helpers) {},
};
```

`ctx` = `{ state, user, isGM, owns(actorId), fail(msg), log(entry), emitTo(target, event, data), uid(prefix), now, displayName() }`
- `user` = `{ id, role: 'gm'|'player', name, characterIds: [] }` (GM id is `'gm'`).
- `owns(actorId)` → GM, or the player controls that actor.
- After every action the core saves to disk and broadcasts fresh views to everyone (debounced 30 ms). Never broadcast state yourself.
- `emitTo(target, event, data)` sends a **transient** event (not stored): target = `'all' | 'gm' | 'players' | userId | userId[]`.
- `log(entry)` appends to `state.log` (see below) and returns it.
- Action names: `<module>/<verb>`; payloads are plain objects. Validate everything coming from players.
- Read seeds with `readSeed('file.json', fallback)` (relative to data/seed) or read a sub-directory yourself with fs.

## Client contract

- Components receive `{ game }` (the user's current view). `game.me = { id, role, name, characterIds }`.
- `send(type, payload)` → Promise of the handler's return value; shows an error toast automatically on failure.
- `useServerEvent('sfx', cb)` / `on(event, cb)` for transient events.
- Module CSS: put a file next to your JS (`client/modules/map/map.css`) and call `loadCss('/modules/map/map.css')` at the top of your entry file. Reuse CSS variables from styles.css (`--bg --panel --panel2 --panel3 --line --line2 --text --dim --faint --cyan --magenta --amber --green --red --blue --violet --mono`), prefix your own classes with your module name.
- Shared classes: `.page` (scrollable page container), `.page-title`, `.section-title`, `.row`, `.col`, `.grid`, `.grid-2`, `.grid-3`, `.grow`, `.spread`, `.wrap`, `.muted`, `.small`, `.mono`, `.card`, `.card.clickable`, `table.sr`, `.btn` variants via `<Button variant>`, `.badge-*`.
- Open a sheet anywhere: `openSheet(actorId)`. Switch tab: `goTab('shop')`.
- Use `TextInput` (commits on blur) for anything that sends to the server, so we don't spam actions per keystroke.
- Wrap a `NumberInput` with `<Field label>` (a div), never a bare `<label>` (a label forwards clicks on its text to its first labelable descendant).
- Markdown is rendered with `renderMarkdown()` (client/lib/markdown.js, regression tests in tools/test-markdown.js): raw HTML is escaped, links/images only allow `http(s):`, `/` and `#` URLs. The page is served with a Content-Security-Policy (no inline scripts/handlers, import map allowed by hash) and `/uploads/*` is served with a sandbox CSP + `nosniff` (non-media files as attachments).
- Session token in localStorage `sr.token` (memory fallback when storage is blocked). The server emits `unauthorized` and disconnects a socket whose session no longer exists (user removed, import); the client then shows the login screen.

UI store (`client/lib/ui-store.js`, client-only, shared by modules): `mainTab`, `dockTab`, `dockOpen`, `sheetActorId`, `toasts`,
`viewMapId` (GM: map shown on the Carte tab, may be stale — always check `game.maps[viewMapId]` and fall back to `scene.activeMapId`),
`mapsEditId` (map open in the editor), `selectedTokenIds` (map selection), `focusTokenId` (ask the map to centre on a token, e.g. from the initiative dock),
`handoutsReadAt` (bumped when a player opens a handout so the « Dossiers » badge refreshes).

Registry (fixed — implement these default exports):

| file | default export | where |
|---|---|---|
| map/MapView.js | `({game})` live map (GM + players) | main tab `map` |
| map/MapsPage.js | `({game})` GM map list + editor | main tab `maps` |
| sheet/SheetView.js | `({game, actorId})` full sheet | global modal (openSheet) |
| sheet/MySheet.js | `({game})` player's own sheet(s) | main tab `sheet` |
| sheet/CharactersPage.js | `({game})` GM list of PCs/NPC actors | main tab `characters` |
| sheet/LogDock.js | `({game})` chat + dice + log | dock `log` |
| combat/BestiaryPage.js | `({game})` NPC templates | main tab `bestiary` |
| combat/CombatDock.js | `({game})` initiative tracker | dock `combat` |
| shop/ShopPage.js | `({game})` shop (player buy / GM manage+approve) | main tab `shop` |
| training/TrainingPage.js | `({game})` karma advancement/training | main tab `training` |
| audio/AudioPage.js | `({game})` GM ambience/music manager | main tab `audio` |
| audio/SoundDock.js | `({game})` GM quick soundboard | dock `sounds` |
| audio/AudioEngine.js | `({game})` global, renders nothing/tiny; plays audio for everyone | global |
| campaign/CampaignPage.js | `({game})` GM campaign: acts, quests, sessions, handouts, docs, notes | main tab `campaign` |
| campaign/DossiersPage.js | `({game})` player handouts + recap | main tab `dossiers` |

## State shape

Everything below lives in `state` (server) and, filtered, in `game` (client).

### Core (owned by core)
```js
config: { gmPassword, campaignName }            // never sent to players (only campaignName)
users: { [id]: { id, name, pin, characterIds } }
sessions: { [token]: userId }                    // never sent
log: [LogEntry]                                  // max 600
ui: { announcement: string|null }
online: [userId]                                 // view only
me: { id, role, name, characterIds }             // view only
```
`LogEntry = { id, ts, kind: 'chat'|'whisper'|'roll'|'system'|'combat'|'shop'|'training', userId?, author, text, to?: userId[] (whisper; 'gm' always included), gmOnly?: bool, roll?: RollResult & { label, pool, actorId?, edge? } }`
Players never see `gmOnly` entries or whispers not addressed to them (core filter).

### Actors (owner: characters module `10-characters.js`)
`actors: { [id]: Actor }` — PCs and spawned NPCs share this schema.
```js
Actor = {
  id, type: 'pc' | 'npc', name, player?: 'real player name', templateId?: 'bestiary template id (npc)',
  metatype: 'Humain'|'Elfe'|'Nain'|'Ork'|'Troll', age?, gender?, concept?, portrait?: url, color?: '#hex' (token color),
  bio?: md, notes?: md (owner + GM), gmNotes?: md (GM only — stripped for players),
  attributes: { BOD, AGI, REA, STR, WIL, LOG, INT, CHA, EDG, MAG?, RES?, ESS },
  augmented?: { REA?: n, AGI?: n, ... },        // bonuses from 'ware/adept powers (cap +4 applied by sr5.attr)
  initiative?: { dice: 1..5, bonus: 0 },        // extra dice (wired reflexes…) and flat bonus
  monitors?: { physical?, stun? },             // overrides (grunts/critters); default from derive()
  condition: { physical: 0, stun: 0, overflow: 0 },   // damage boxes filled
  edge: { current },                            // max = attributes.EDG
  skills: [{ id: 'pistols' (sr5.SKILLS id or custom slug), name: 'Pistolets', attr: 'AGI', rating, spec?: '', group?: '' }],
  skillGroups?: [{ id: 'firearms', rating }],
  knowledge: [{ id, name, rating, type: 'street'|'academic'|'professional'|'interest'|'language', native?: bool }],
  qualities: [{ id, name, karma: number, positive: bool, notes? }],
  powers: [{ id, name, level?, pp, notes? }],              // adept powers
  spells: [{ id, name, category, type, range, duration, drain, notes? }],
  complexForms?: [...],
  weapons: [{ id, name, category, kind: 'melee'|'ranged', skill: 'pistols', accuracy, damage: '7P', ap: -1, mode: 'SA', rc, ammo: '15(c)', reach, notes?, catalogId? }],
  armor: [{ id, name, rating, equipped: bool, stack?: bool (helmet/shield adds), notes?, catalogId? }],
  augmentations: [{ id, name, kind: 'cyberware'|'bioware', grade: 'standard'|'alpha'|'beta'|'delta'|'used', rating?, essence, notes?, catalogId? }],
  gear: [{ id, name, category, rating?, qty, notes?, catalogId? }],
  vehicles: [{ id, name, handling, speed, accel, body, armor, pilot, sensor, seats?, notes?, catalogId? }],
  matrix?: { device, rating, attack, sleaze, dataProcessing, firewall, programs: [string] },
  contacts: [{ id, name, connection, loyalty, notes? }],
  sins: [{ id, name, rating, licenses: [string] }],
  lifestyle?: { name, monthlyCost, monthsPaid },
  karma: number (available), karmaTotal: number (career), nuyen: number,
  streetCred, notoriety, publicAwareness,
  vision?: { lowLight?: bool, thermo?: bool, darkRange?: cells },   // used by the map
  npc?: { professionalRating?, grunt?: bool, tactics?: md, loot?: md },   // NPCs only
  hidden?: bool,           // NPC: players don't see it in lists
  retired?: bool,          // PC no longer played (Ank'Lay)
  training?: [TrainingJob],   // owned by training module (see below)
  history: [{ ts, text, karma?: delta, nuyen?: delta }],   // money/karma ledger, appended by shop/training/GM
}
```
Extra actor fields: `realName?`, `metavariant?` (Chummer), `chummer?` (see Chummer below), items may carry `chummerGuid`,
`foundry: { id, world, importedAt }` (Foundry import), `magic?` (written by training, see Training below),
`augmentations[].bonus` / `powers[].bonus` = attribute / initiative-dice bonus actually applied (`{ attributes: { REA: 1 }, initiativeDice: 1 }`, reversed on removal/sale),
`weapons[].augId` = implant weapon of that augmentation (removed with it, never sold separately),
`gear[].paid` = unit price paid in the shop, map tokens `moveBudget: { key, meters }` (combat movement, maps module).
Derived values: `import { derive, skillPool, rollDice, attr, SKILLS, SKILL_BY_ID } from '/shared/sr5.js'` — never store derived numbers.
Default roll limit: `skillDefaultLimit(def, attr)` (shared/sr5.js) — a skill's own `limit` ('physical'|'mental'|'social'|'astral', or null = none, e.g. spellcasting/pilot) overrides its category.
Player permissions on their own actor: condition, edge.current, armor equipped, gear qty (lower only — only the GM raises a quantity)/notes, notes, portrait, bio, color, contacts notes. Attributes/skills/karma/nuyen/qualities change only via GM edit, shop, or training.

Dice: `'dice/roll'` (characters module) `{ pool, label, actorId?, limit?, explode? (Edge: Push the Limit — adds EDG to the pool, rule of six, ignores limit and spends 1 Edge), secret? (GM only: gmOnly log) , modifier? }` → logs `{ kind: 'roll', roll: {...} }` and emits `sfx { id: 'dice' }` to all. Server rolls (Math.random).

### Bestiary & combat (owner: combat module `30-combat.js`)
```js
bestiary: { [templateId]: Template }   // Template = Actor schema minus id-specific runtime fields, plus { folder: 'Project Lazarus'|'Gangs'|'Sécurité corpo'|'Spécialistes'|'Créatures'|..., description?: md }
combat: {
  active: bool, mapId, round: 1, pass: 1, turn: index into entries (current actor),
  entries: [{ id, actorId, tokenId?, name, base, dice, score (current initiative), rolls: [], acted: bool, delayed?: bool, hidden?: bool (GM only until revealed), out?: bool }],
}
```
- `'bestiary/spawn'` `{ templateId, mapId, x, y, count = 1, hidden? }` creates NPC actors (copy of template, new id, `type:'npc'`, `templateId`, names numbered « Nettoyeur AG Chemie 2 ») **and** tokens on the map (Token schema below, `disposition:'hostile'`). Returns the new actor ids.
- Initiative uses `derive(actor).initiative` (+ wound modifiers apply to initiative score in SR5). SR5 passes: each pass subtracts 10; actors with score > 0 act again.
- Damage: `'actor/damage'` `{ actorId, amount, type: 'P'|'S' }` (characters module) — stun overflow rolls into physical; physical overflow into `overflow`. Combat UI calls it.

### Maps (owner: maps module `20-maps.js`)
```js
scene: { activeMapId: string|null }          // the map players currently see
maps: { [id]: Map }
Map = {
  id, name, folder?: 'Acte 1'|..., description?: md (GM only),
  width, height,                    // cells
  metersPerCell: 1,
  tiles: [string],                  // height rows, each `width` chars — legend below
  doors: [{ id, x, y, state: 'open'|'closed'|'locked', kind: 'door'|'gate'|'shutter'|'secret', name? }],
  lights: [{ id, x, y, radius, color: '#ffcc88', on: true }],
  lighting: 'bright'|'dim'|'dark',  // ambient light
  regions: [{ id, name, x, y, w, h, color?, gmOnly?: bool }],   // labelled rooms/zones
  notes: [{ id, x, y, text, gmOnly: true }],                    // GM pins
  tokens: [Token],
  explored: { [userId]: string },   // fog-of-war memory (encoding owned by maps module)
  fog: true,                        // false = players see the whole map
  sharedVision: true,               // party shares what any PC sees
  movementLocked: false,            // GM freeze: players can't move tokens
  background?: { url, opacity },    // optional image underlay
  theme?: 'street'|'bar'|'corp'|'lab'|'industrial'|'residential'|'matrix'|'club',
}
Token = {
  id, actorId: string|null, name, x, y (integer cells), size: 1,
  color?: '#hex', img?: url, disposition: 'pc'|'ally'|'neutral'|'hostile',
  hidden: bool (GM only), vision?: { lowLight, thermo, darkRange }, light?: { radius, color } (torch/flashlight),
  status?: [string],               // 'à terre', 'inconscient', 'mort', …
}
```
Tile legend (one char per cell):
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

Vision (`shared/vision.js`, maps module): line of sight from a token's cell; closed doors and opaque tiles block. Light: `bright` → everything in LOS visible; `dim` → visible within 12 cells (24 with lowLight); `dark` → only cells lit by `lights[]` or token lights (radius ×2 with lowLight), or within `vision.darkRange` (thermographic = 10 cells). The server filter removes from players' views: tokens not visible to them (and all `hidden` tokens), GM notes, `gmOnly` regions, `description`, other maps (players only receive `maps[scene.activeMapId]`), and secret doors (rendered as walls while `kind:'secret'` and `state !== 'open'`).

Player actions: move own tokens (only to cells reachable without passing walls/closed doors; not while `movementLocked`), open/close unlocked doors within 1 cell (Chebyshev) of one of their tokens, ping. GM: everything.

### Shop (owner: `40-shop.js`)
```js
shop: {
  open: bool, markup: 0 (percent), sellRate: 50 (percent of price paid back), maxAvail: 12,
  allowRestricted: true, allowForbidden: false,
  approval: 'never'|'restricted'|'always',     // when a purchase needs GM approval
  categories: { [catalogFile]: bool },           // which catalogs are on sale
  specials: [{ id, name, category, cost, avail, stock, notes, stats?, catalogRef? }],   // GM-curated items / fixer deals
  orders: [{ id, ts, actorId, userId, by?, kind: 'buy'|'sell'|'give', items: [{ ref, name, qty, rating?, unitCost }], total, status: 'pending'|'approved'|'denied'|'done'|'cancelled', flags?: [string], gmNote?, resolvedTs? }],
}
```
`'shop/cancel'` (owner or GM) cancels a pending order. Transient event `'shop:resolved'` `{ orderId, status, note }` is sent to the actor's owners when the GM approves/denies.
Selling: gear can only be sold up to its current `qty` (≥ 1); implant weapons (`augId`) are not sellable (sell the augmentation).
Catalog files (generated, `data/catalog/<name>.json`, loaded with `useCatalog(name)` client-side and read from disk server-side for price validation): `weapons`, `armor`, `gear`, `cyberware`, `bioware`, `vehicles`, `qualities`, `spells`, `powers`, `programs`, `lifestyles`. Each item: `{ id, name, nameFr?, category, cost: number|null, costFormula?: string, avail: '8R', availValue: 8, legality: ''|'R'|'F', rating?: { min, max }, essence?: number|string, source, page, stats: {...type-specific} }`. Buying adds the item to the actor (weapons → `actor.weapons`, armor → `actor.armor`, cyber/bio → `actor.augmentations` (and reduces ESS), vehicles → `actor.vehicles`, everything else → `actor.gear`) and deducts nuyen, appends `actor.history` and a `kind:'shop'` log entry.

### Training (owner: `50-training.js`)
```js
training: {
  settings: { approval: 'always'|'never', useTime: true, instructorTimeReduction: 25 (percent), instructorCostPerWeek: { attribute: 1000, skill: 500, knowledge: 250, other: 500 } },
  daysElapsed: 0,   // downtime days advanced by the GM
  requests: [{ id, ts, actorId, userId, kind: 'attribute'|'skill'|'skillGroup'|'specialization'|'knowledge'|'quality'|'removeQuality'|'spell'|'power'|'powerPoint'|'complexForm'|'initiation'|'other',
    target, from, to, label, karmaCost, nuyenCost, days, daysBase, instructor, ppCost, manual (not verified against the catalog),
    request (normalized request, see shared/advancement.js), status: 'pending'|'approved'|'denied'|'done'|'cancelled', note?, gmNote?, resolvedTs?, doneTs? }],
}
actor.training: [{ id, requestId, kind, label, daysTotal, daysDone, startedTs, request }]   // in-progress (downtime)
actor.magic = { initiation: grade, submersion: grade, metamagics: [string], echoes: [string], extraPP: n }   // written by training
```
Actions: `training/request`, `training/resolve`, `training/cancel`, `training/advanceDays`, `training/complete`, `training/updateSettings`, `training/clearHistory`.
Adept powers with a catalog `stats.bonus` (Improved Reflexes: REA + initiative dice per level, `extrapointcost` 0.5 PP on the first level) get the bonus applied on purchase/level-up and recorded on `power.bonus`.
Karma costs per SR5 (attribute new×5, active skill new×2, group new×5, knowledge new×1, specialization 7, new skill 2, new knowledge 1, positive quality karma×2, remove negative karma×2, spell 5, complex form 4, initiation 10+grade×3, power point 5). `'training/advanceDays'` (GM) moves downtime forward.

### Audio (owner: `60-audio.js`)
```js
audio: {
  master: 0.8,
  ambient: { trackId: string|null, volume: 0.5 },   // looping atmosphere, synced to everyone
  music: { trackId: string|null, volume: 0.4 },
  tracks: [{ id, name, kind: 'ambient'|'music'|'sfx', source: 'synth'|'url', preset?: 'rain'|..., url?, tags? }],
  scenes?: [{ id, name, ambient, music, mapId? }],   // one-click presets
}
```
Transient event `'sfx'` `{ id, volume? }` → every client plays it. **Standard sfx ids** (any module may emit them): `dice`, `door-open`, `door-close`, `door-locked`, `gunshot-pistol`, `gunshot-rifle`, `gunshot-auto`, `explosion`, `hit-melee`, `glass-break`, `alarm`, `footsteps`, `notify`, `matrix-glitch`, `spell-cast`, `heal`, `death`, `cash`, `level-up`, `ping`.

### Campaign (owner: `70-campaign.js`)
```js
campaign: {
  acts: [{ id, title, summary }],
  quests: [{ id, actId, title, status: 'upcoming'|'active'|'done'|'skipped', summary, phases: [{ id, title, text, done }], npcs: [templateId|actorId], maps: [mapId], rewards, gmNotes, doc?: 'file.md' }],
  sessions: [{ id, number, title, date?, plan: md, recap: md, played: bool, doc?: 'session-3-plan.md' }],
  threads: [{ id, label, state: 'open'|'resolved'|'dormant'|'dead', notes }],
  handouts: [{ id, title, body: md, image?, revealedTo: 'all'|[userId], ts }],
  playerRecap: md,           // « L'histoire jusqu'ici » shown to players
  notes: md,                 // GM scratchpad
}
```
Players receive only `handouts` revealed to them and `playerRecap`. Campaign markdown docs (../Shadowrun/*.md) are served GM-only at `GET /api/docs` and `GET /api/docs/:name` (use `api()`).

## Seeds
`data/seed/` — merged at boot, by id, adding only what's missing (so GM edits survive restarts):
- `actors/*.json` — array of PC actors (characters module)
- `bestiary/*.json` — array of templates (combat module)
- `maps/*.json` — one Map per file (maps module)
- `campaign.json` — campaign slice (campaign module; merge acts/quests/sessions/threads by id)
- `audio.json` — tracks & scenes (audio module)
- `shop.json` — specials (shop module)

## Campaign facts (for content)
Seattle 2080, SR5. PCs: **Anthony Von Schloss** (street samurai / blades, player Anthony H.), **Jane** (face / social adept / sniper, player Baptiste), **Bricks** (decker, ex-Knight Errant spider, player Sploadie). Ank'Lay (ork brawler) retired. Full sheets in `../Shadowrun/campaign-recap.md`; plot in `campaign-outline.md`, `act1-loose-ends.md`, session plans. Antagonist: AG Chemie via shell company Hollow Pine Holdings (Dorian Ashe), Project Lazarus. Fixer: Perrine Cabana.

## Testing (agents and humans)
- **Never** run the server on port 3000 or without `SR_RUNTIME_DIR` while developing in parallel — use `tools/test-client.js`, which starts an isolated server (own port, temp state dir, seeds applied):
  ```js
  import { startServer, login, client, settle } from './test-client.js';
  const srv = await startServer({ port: 31xx });
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur', characterId: '<pc id>' }));
  await gm.send('maps/…', {...}); await settle(); console.log(p1.state.maps);
  srv.stop();
  ```
- Put module tests in `tools/test-<module>.js` (run with `node tools/test-<module>.js`, exit code ≠ 0 on failure).
- Check client files parse: `node --check client/modules/x/y.js` works for syntax (imports are browser paths, so don't execute them in Node). Shared modules (`shared/*.js`) can be imported and unit-tested in Node directly.
- `node tools/smoke.js` = quick global smoke test.

## Persistence & robustness (core)
- `saveNow()` writes `state.json` atomically (tmp + fsync + rename) and never throws: on an fs error (EPERM lock by an antivirus/viewer, disk full) it logs and retries. `saveSoon()` debounces 400 ms but never postpones more than 2 s. Logins and admin import/reset save at once.
- Pending changes are flushed on SIGINT/SIGTERM/SIGHUP (console window closed)/SIGBREAK and on process exit; uncaught exceptions are logged without killing the server.
- An unreadable `state.json` at boot is never overwritten: it is copied to `state.corrupt-<ts>.json` and the newest readable copy (`state.json.tmp`, then backups) is restored; with none, the server refuses to start.
- Backups (`backups/state-<ts>-<label>.json`): `boot` at every start, `shutdown`, `manual`, `before-import`, `before-reset` (20 newest kept) and `auto` every 15 min only when the state changed (30 newest kept).
- `/api/admin/import` fills missing base slices, keeps the live GM password when the file has none, and keeps current users/sessions so connected people stay logged in.

## Round 2 additions (Foundry import, Chummer, image maps)

### Segment walls & image backgrounds (maps module)
Maps imported from Foundry VTT keep their artwork. They use the same Map schema plus:
```js
map.walls = [{                    // thin walls between/through cells, coordinates in CELL units (floats), origin = top-left of the grid
  id, x1, y1, x2, y2,
  move: true, sight: true,        // which things the segment blocks (a window: move true, sight false)
  door: null | { state: 'open'|'closed'|'locked', kind: 'door'|'secret', name? },   // a door segment blocks only when not open
}]
map.background = { url, opacity: 1, mode: 'image' | 'underlay', x: 0, y: 0, w: width, h: height }   // x/y/w/h in cells
```
- `mode: 'image'` → the image IS the floor: the renderer draws it and does not paint tile art (tiles stay for movement/vision: usually `.` inside the scene, ` ` outside). `mode: 'underlay'` (default, legacy) → tiles drawn over the image at its opacity.
- Segment walls block line of sight, light, and movement exactly like opaque tiles/doors do (a step between two cells is blocked if the segment crosses the line between their centres; LOS to a cell is blocked if every sample ray crosses a blocking segment).
- Segment doors are toggled with `maps/toggleDoor {mapId, doorId}` where `doorId` is the wall id; players must have a token within 1.5 cells of the door segment's midpoint. Same sfx and rules as tile doors.
- Lights from Foundry: `radius` in cells (= Foundry dim radius in grid units ÷ grid distance).
- Deviation: closed secret wall-doors (`door.kind === 'secret'` and not open) are sent to players as anonymous plain walls (no door, no name), so vision/movement stay consistent client-side.
- Player filter: lights are only sent when their glow reaches a known cell, without their `name`; the combat filter drops NPC entries whose token is on the shown map but not visible to that player.
- Players can only switch the standard torch (radius 6) on their token (`light` patch); radius is GM-only.
- In combat, `maps/moveToken` enforces the run rate (AGI×4 m) per combat turn for players (`token.moveBudget`).

### Foundry import (module `80-foundry.js`)
Slice `state.foundry = { worldPath, lastScan?, lastImport? }` (GM only). Actions (GM): `foundry/worlds` (list detected worlds), `foundry/scan` `{ worldPath? }` → importable summary, `foundry/import` `{ worldPath?, select: { pcs, npcs, scenes, journals, playlists }, pcMode: 'replace'|'merge', assignPlayers? }`. Route `GET /api/foundry/status` (GM). Offline: `node tools/foundry-import.js [--write-seeds] [--world <path>] [--dump <dir>] [--no-audio] [--no-journals]` regenerates the seeds. Env vars: `SR_FOUNDRY_ASSET_DIR` (where assets are copied, default data/assets/foundry), `SR_FOUNDRY_DOCS_DIR` (journal markdown output, default ../Shadowrun/foundry).
Reads a Foundry VTT v11+ world (LevelDB) from a COPY in a temp dir. Default world: auto-detected from `%LOCALAPPDATA%/FoundryVTT/Config/options.json` → `dataPath`/Data/worlds/* with `"system": "shadowrun5e"` (here: `C:/Users/mathi/Documents/Foundry/Data/worlds/test-world`). Assets it references (portraits, scene backgrounds, playlist audio) are copied into `data/assets/foundry/…` and served at `/assets/foundry/…`. Every imported record keeps `foundry: { id, world, importedAt }` so a later re-sync updates the same record. Journals are written as markdown to `../Shadowrun/foundry/*.md` (listed by the docs API under folder `foundry`).

### Chummer5a (module `85-chummer.js`)
Slice `state.chummer = { allowPlayerImport: true, pending: [{ id, ts, actorId, actorName, userId, userName, fileName, xml, mugshots, diff, summary, warnings, status }] }`.
Actions: `chummer/settings` (GM `{ allowPlayerImport }`), `chummer/resolve` (GM `{ requestId, approve, note? }`), `chummer/cancel` (owner/GM), `chummer/unlink` (GM `{ actorId }`).
Routes: `POST /api/actors/import-chum5` (GM, new actor), `POST /api/chummer/import` (GM new actor, or `?actorId=` = update), `POST /api/chummer/preview`, `POST /api/chummer/update?actorId=` (3-way merge; players create a pending request unless allowed), `GET /api/chummer/export/:actorId` (owner/GM; the exported file becomes the merge base). `CHUMMER_DATA_DIR` overrides the Chummer data folder.
Actor fields: `actor.chummer = { xml, fileName, importedAt, syncedAt, exportedAt?, updatedAt?, sourceHash, created, appVersion, mugshots? }` (xml stripped from the GM view by `gmFilter`), `item.chummerGuid`, `actor.realName`, `actor.metavariant`. Re-import never brings back items deleted in the app since the export, nor duplicates items the app keeps in another list (device in `actor.matrix`, shop SIN in gear).
Import `.chum5` → Actor (the original XML is kept in `actor.chummer = { xml, fileName, importedAt }`), export Actor → `.chum5`: patches the stored original when present (karma, nuyen, attributes, skill ratings, condition, new/removed gear by Chummer `sourceid` = catalog id), otherwise generates a new file from the skeleton `tools/fixtures/chummer-test.chum5`. Test fixture made with Chummer 5.226.0: `tools/fixtures/chummer-test.chum5`.
