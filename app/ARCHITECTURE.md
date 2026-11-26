# Shadowrun Table — architecture & module contract

Real-time web app for running Shadowrun 5E campaigns (« Project Lazarus » first). One Node server (the GM's PC or a VPS) hosts one or more **tables** (independent campaigns, see « Multi-table hosting »); the GM and players connect from a browser. **The UI is bilingual: French is the source text, English comes from dictionaries** — every user-facing string goes through `t()` (see « i18n » below). Code comments/identifiers in English.

```
app/
  server/index.js        core: HTTP, auth, Socket.IO, action dispatch, per-user views, tables (core-owned)
  server/store.js        per-table state persistence, table scope (AsyncLocalStorage)   (core-owned)
  server/lib/tables.js   table registry (server.json), migration, admin password        (core-owned)
  server/lib/admin.js    /api/admin/* server administration routes                     (core-owned)
  server/lib/zip.js      streaming zip reader/writer, streamed uploads                  (core-owned)
  server/errors.js       ActionError                                                    (core-owned)
  server/modules/NN-x.js feature modules, auto-loaded in filename order
  shared/util.js         uid(), clamp(), deepClone(), nuyen(), slug()                   (core-owned)
  shared/sr5.js          SR5 rules: attributes, SKILLS, derive(), rollDice(), skillPool() (core-owned)
  shared/*.js            other pure modules usable by server AND browser (no Node/DOM APIs):
                         vision.js (maps), advancement.js (training), matrix.js (Matrix rules), chargen.js (priority creation), npcgen.js (enemy generator)
  client/index.html      import map: 'preact', 'preact/hooks', 'htm'                    (core-owned)
  client/app.js          shell: login, top tabs, right dock, sheet modal, toasts         (core-owned)
  client/styles.css      global theme + shared classes                                   (core-owned)
  client/lib/net.js      useGame(), send(), on()/useServerEvent(), api(), upload(), useCatalog() (core-owned)
  client/lib/ui.js       html`` + UI kit (Button, Panel, Modal, Tabs, Field, TextInput, NumberInput, Select, Toggle, Badge, Empty, SearchBox, Markdown, Stat, loadCss, confirmAction, promptText) (core-owned)
  client/lib/ui-store.js useUI(), setUI(), openSheet(actorId), goTab(id), toast(text, kind), useLang() (core-owned)
  client/lib/i18n.js     t(), tn(), tk(), tIfKnown(), logText(), errorText(), SR5 label helpers, formatting   (core-owned)
  client/i18n/format.js  pure i18n core (interpolation, plurals) shared by client, server and tools   (core-owned)
  client/i18n/en/*.json  English dictionaries, one per area { "français": "english" }   (each translator owns their area file)
  server/lib/i18n.js     server t()/tn() for the table language, errorBody(), normalizeLogEntry()   (core-owned)
  client/lib/markdown.js renderMarkdown()                                                (core-owned)
  client/modules/registry.js  which component is which tab                              (core-owned — DO NOT EDIT)
  client/modules/<feature>/…  feature UI
  data/seed/…            initial content merged into state at boot (by id, never overwrites)
  data/catalog/*.json    gear catalog generated from Chummer data (tools/build-catalog.js)
  data/packs/<pack>/     other content packs (same layout as data/seed; « vierge » built by tools/build-packs.js)
  data/server.json       table registry (runtime, do not commit)
  data/tables/<id>/      one table: state.json, backups/, uploads/, docs/, assets/, foundry/ (runtime, do not commit)
  tools/                 offline scripts (catalog build, checks)
```

No build step. The browser loads ES modules directly. Preact 10 + htm (`html\`...\``) + hooks. Import paths in client code are **relative** (`../../lib/ui.js`) or absolute for shared (`/shared/sr5.js`). Server imports shared with `../../shared/sr5.js`.

Run: `npm start` (port 3000, or `PORT=xxxx`). A fresh install has one table « lazarus » (GM password `lazarus`); `/admin` manages tables. VPS: see DEPLOY.md (Docker, port 8095).

## Server module contract

`server/modules/NN-name.js`:

```js
export default {
  name: 'maps',
  // Called at every boot (and after reset/import). Create missing slices; merge seeds by id (add missing only).
  // `state` is ONE table's state; readSeed/seedDir point at that table's content pack. Also { tableId, table: { id, slug, name, lang } }.
  init(state, { readSeed, seedDir }) {},
  actions: {
    // role: 'gm' (default) | 'any'. Handler is synchronous, mutates ctx.state in place.
    // Return value is sent back to the caller (send() resolves with it). Throw via ctx.fail('Message FR {x}', { x }).
    'maps/moveToken': { role: 'any', handler(ctx, payload) {} },
  },
  // Optional. Mutate the player's view (a deep clone of state, already stripped of sessions/config/gm-only log).
  // Filters run in module filename order (20-maps before 30-combat, so combat can rely on the filtered view.maps).
  filter(view, user, fullState) {},
  // Optional. Trim the GM view (heavy or useless data, e.g. raw Chummer XML). Same signature as filter.
  gmFilter(view, user, fullState) {},
  // Optional. Extra HTTP routes. helpers: { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon }
  // — all act on the request's table (see « Multi-table hosting »); handlers run inside that table's scope.
  routes(app, helpers) {},
};
```

`ctx` = `{ state, user, isGM, tableId, table, owns(actorId), fail(msg, params?), log(entry), emitTo(target, event, data), uid(prefix), now, displayName(), lang, t(key, params) }`
- `fail('Texte {x}', { x })` throws; the client receives `{ error: 'Texte 42', errorKey: 'Texte {x}', params: { x: 42 } }` and toasts it translated. `log({ …, i18n: { key, params } })` stores a translatable entry. `ctx.lang` / `ctx.t()` = the table's language, only for texts that must be stored pre-rendered (rare). See « i18n ».
- `user` = `{ id, role: 'gm'|'player', name, characterIds: [] }` (GM id is `'gm'`).
- `owns(actorId)` → GM, or the player controls that actor.
- After every action the core saves to disk and broadcasts fresh views to everyone (debounced 30 ms). Never broadcast state yourself.
- `emitTo(target, event, data)` sends a **transient** event (not stored): target = `'all' | 'gm' | 'players' | userId | userId[]`.
- `log(entry)` appends to `state.log` (see below) and returns it.
- Action names: `<module>/<verb>`; payloads are plain objects. Validate everything coming from players.
- Read seeds with `readSeed('file.json', fallback)` (relative to the table's pack dir) or read a sub-directory of `seedDir` yourself with fs.
- No per-table data in module-level variables: key caches by the state/map object (`WeakMap`) or by `ctx.tableId`.

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
- The page URL names the table (`/t/<slug>/`, `TABLE` in net.js). Session token in localStorage `sr.token.<slug>` (old `sr.token` adopted once; memory fallback when storage is blocked); `api()`/`upload()` send `X-SR-Table`, the socket handshake `{ token, table }`. Upload URLs are returned by the server (`/t/<slug>/uploads/…`, `/uploads/…` for the legacy table) — never build them. The server emits `unauthorized` and disconnects a socket whose session no longer exists (user removed, import); the client then shows the login screen.

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
| assistant/AssistantDock.js | `({game})` GM assistant chat (Claude), see « Assistant MJ » | dock `assistant` (GM) |
| audio/AudioEngine.js | `({game})` global, renders nothing/tiny; plays audio for everyone | global |
| campaign/CampaignPage.js | `({game})` GM campaign: acts, quests, sessions, handouts, docs, notes | main tab `campaign` |
| campaign/DossiersPage.js | `({game})` player handouts + recap | main tab `dossiers` |
| matrix/MatrixPage.js | `({game})` decker cockpit (players) / Matrix overview, hosts & IC (GM) | main tab `matrix` |
| chargen/ChargenPage.js | `({game})` priority character creator (players) / approval queue (GM) | main tab `chargen` |
| notes/NotesPage.js | `({game})` private notes + collaborative party notes (see « Notes ») | main tab `notes` |
| core/SettingsPage.js | `({game})` GM settings (table language, players, backups, Foundry…) | main tab `settings` |

The enemy generator (`chargen/EnemyGenerator.js`) is opened from the Bestiaire page. The server admin page (`/admin`) is `client/modules/admin/AdminPage.js`, mounted by app.js outside the table UI.

## State shape

Everything below lives in `state` (server) and, filtered, in `game` (client).

### Core (owned by core)
```js
config: { gmPassword, campaignName, lang: 'fr'|'en' (table default), gmLang?: 'fr'|'en'|null } // view: { campaignName, lang, table: { id, slug, name, lang } } (no password, no gmLang)
users: { [id]: { id, name, pin, characterIds, lang?: 'fr'|'en'|null } }   // lang = the player's own choice (null = follow the table)
sessions: { [token]: userId }                    // never sent
log: [LogEntry]                                  // max 600
ui: { announcement: string|null }
online: [userId]                                 // view only
me: { id, role, name, characterIds, lang }       // view only; lang = own choice or null (GM: config.gmLang)
```
`LogEntry = { id, ts, kind: 'chat'|'whisper'|'roll'|'system'|'combat'|'shop'|'training'|'matrix', userId?, author, text, i18n?: { key, params? }, to?: userId[] (whisper; 'gm' always included), gmOnly?: bool, roll?: RollResult & { label, pool, actorId?, edge? } }` — display with `logText(entry)`; `text` is the French rendering (filled from `i18n` when omitted).
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
Players receive only `handouts` revealed to them and `playerRecap`. Campaign markdown docs (the table's docs folder: `data/tables/<id>/docs/`, `../Shadowrun/` for the legacy table on the GM's PC) are served GM-only at `GET /api/docs` and `GET /api/docs/:name` (use `api()`).

## Seeds
Each table has a content pack: `project-lazarus` = `data/seed/`, `vierge` = `data/packs/vierge/` (generic bestiary, generic audio scenes, nothing else — regenerate with `node tools/build-packs.js`).
The pack is merged at boot, by id, adding only what's missing (so GM edits survive restarts):
- `actors/*.json` — array of PC actors (characters module)
- `bestiary/*.json` — array of templates (combat module)
- `maps/*.json` — one Map per file (maps module)
- `campaign.json` — campaign slice (campaign module; merge acts/quests/sessions/threads by id)
- `audio.json` — tracks & scenes (audio module)
- `shop.json` — specials (shop module)
- `matrix.json` — `{ hosts: [Host] }` (matrix module; Lazarus pack only)

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
  Multi-table: `startServer({ port, tables: [{ id, name, pack, gmPassword, state? }] })` (no default table then), `login(url, { …, table: 'id' })`, `client(url, token, { table: 'id' })`, `await srv.admin()` → admin token, `startServer({ legacyState })` writes an old single-table `state.json`. Tests of this part: `tools/test-tables.js` (ports 3500-3599).
- Put module tests in `tools/test-<module>.js` (run with `node tools/test-<module>.js`, exit code ≠ 0 on failure).
- Check client files parse: `node --check client/modules/x/y.js` works for syntax (imports are browser paths, so don't execute them in Node). Shared modules (`shared/*.js`) can be imported and unit-tested in Node directly.
- `node tools/smoke.js` = quick global smoke test.
- i18n: `node tools/test-i18n.js` (ports 3800-3849), `node tools/i18n-check.js --area <area>` (see « i18n »).

## i18n (French source, English dictionaries)

The app runs in French or English, **per user**. French stays the source text in the code; English lives in flat JSON dictionaries. Nothing is translated by the server for the client: the server sends French text **plus a key**, the browser translates.

### How it works
- `t('Texte français {name}', { name })` (`client/lib/i18n.js`) returns the English entry of `client/i18n/en/*.json` when the UI language is `'en'`, else the French string — both with `{placeholders}` filled from the named params. **The key is the exact French string** (same apostrophes ’, spaces, punctuation).
- Missing English entry (or empty `""`) → the French text is shown and the key is recorded: `window.__i18nMissing` in the browser console, and Réglages → « Traductions » shows « Traductions manquantes : N » with a « Copier en JSON » button (`{ "clé": "" }`, ready to paste into a dictionary). Keys are recorded in both languages, so a French session also finds them.
- Dictionaries: `client/i18n/en/<area>.json` = `{ "Texte français {n}": "English text {n}" }`. All files are loaded before the first render (`/i18n/en/index.json` is generated by the server from the folder: a new file needs no code change). `glossary.json` is merged first; area files may override it. The same file must not translate one key two ways — use a context key (below).
- Language of a user: own choice (`game.me.lang`, stored in `state.users[id].lang`, GM: `config.gmLang`) › choice made in this browser before login (`localStorage['sr.lang']`, sent with the login) › table language (`game.config.lang`, GM sets it in Réglages, admin in /admin). FR/EN switch in the top bar, the login screen, the table picker and /admin; action `users/setLang { lang: 'fr'|'en'|null }` (any user).
- Language switch: the root re-renders the whole tree and the page, dock and sheet are remounted (`key=lang`), so `useMemo`'d labels are recomputed. `useLang()` (ui-store.js) exists for the rare component that must react itself.

### Client API (`import { t, tn, tk, … } from '../../lib/i18n.js'`)
| function | use |
|---|---|
| `t(key, params?)` | every user-facing literal. `params` = named values: `t('{actor} perd {n} cases', { actor: a.name, n })` |
| `tn(n, one, other, params?)` / `tn(n, { zero?, one, other }, params?)` | plurals; `{n}` is always available. French uses `one` for 0 and 1, English only for 1. Each form is its own key: `tn(k, '{n} marque', '{n} marques')` |
| `tk(key)` | marks a literal in a **constant table** for the checker, returns it unchanged; render with `t(value)`: `const STATUS = { draft: tk('Brouillon') }` … `${t(STATUS[s])}` |
| `tIfKnown(text, params?)` | text that MAY be a key (stored data, server text): translated if the dictionary has it, else unchanged, never counted missing |
| `logText(entry)` | log entry text: `t(entry.i18n.key, entry.i18n.params)`, else `entry.text` (non-chat texts translated when known) |
| `errorText(reply)` | `{ error, errorKey?, params? }` → translated message (`send()`/`api()` already use it: `err.message` is translated, `err.key/params/code/status` kept) |
| `attrLabel('AGI')`, `attrShort('BOD')`, `skillLabel(skill or id)`, `skillGroupLabel(id)`, `skillCategoryLabel(cat)`, `limitLabel('social')`, `metatypeLabel('Nain')` | SR5 vocabulary (official English names for SKILLS ids) — use instead of `ATTR_LABELS[k]`, `SKILL_BY_ID[id].fr`, `SKILL_GROUPS[g]`… |
| `itemName(item)` | catalog item: English `name` / French `nameFr` by language — use instead of `item.nameFr \|\| item.name` |
| `fmtNumber(n)`, `fmtNuyen(n)`, `fmtDate(ts, opts?)`, `locale()`, `compare(a, b)` | locale-aware formatting/sorting (`nuyen()` of shared/util.js is French-only) |
| `getLang()` | current language ('fr'/'en'), e.g. for `localeCompare(…, getLang())` |

### Rules for translators (client)
1. Wrap **every** user-facing French literal: text nodes, `title=`, `placeholder=`, `label=`, `hint=`, `aria-label=`, toasts, `confirmAction()`/`promptText()` messages, option labels, empty states, document titles: `html\`<${Button} title=${t('Supprimer')}>${t('Supprimer')}</${Button}>\``.
2. **Never concatenate translated fragments** and never put a variable in a key: `t('Rendre {n} point(s) d’Essence à {name} ?', { n, name })`, not `'Rendre ' + n + …` nor ``t(`Rendre ${n}…`)``. Whole sentences only (word order differs in English). Prefer `tn()` over « point(s) ».
3. **Never call `t()` at module top level** (dictionaries are not loaded yet and the language changes at runtime): translate at render time; constant tables use `tk()` + `t(value)`.
4. Add the English to **your area file only**: `client/i18n/en/<area>.json` (areas: `map`, `sheet`, `combat`, `shop`, `training`, `audio`, `campaign`, `foundry`, `chummer`, `matrix`, `chargen`, `notes`; `core`/`admin`/`glossary` belong to the core). Keep the placeholders identical (`{name}` stays `{name}`). Use the SR5 English terms of `glossary.json` (Edge, Body, Condition Monitor, Push the Limit, Overwatch Score, DV, AP…), and check the glossary before adding a term.
5. Ambiguous short words: a key may carry a context before `::` — `t('sort::Puissance')` shows « Puissance » in French and looks up `"sort::Puissance"` in the dictionary. Use it only when the same French word needs two English translations (the checker reports such conflicts).
6. Do **not** translate data: campaign story, quests, handouts, NPC descriptions, seeds, map/actor/item names typed by the GM, chat. Catalog items: `itemName(item)`. Skill/attribute labels: the helpers above. Stored French values (metatype 'Humain', status 'à terre'…): keep storing French, display with `t()`/`tIfKnown()`/`metatypeLabel()`.
7. Endonyms in a language picker (« Français », « English ») are never translated (add `// i18n-ignore` on the line if the checker flags them).
8. Dates/numbers: `fmtDate`, `fmtNumber`, `fmtNuyen` instead of hard-coded `'fr-FR'`.

### Server rules
- Errors: `ctx.fail('Texte {x}', { x })` — key = French text with placeholders, params = named values (strings/numbers/booleans; a nested translatable value is `{ t: 'clé', params }`). Static messages need no params: `ctx.fail('Personnage introuvable')` is already translatable (the key is the message). A template literal in `ctx.fail(\`… ${a.name} …\`)` works but is untranslatable → convert to params. The English goes in the area dictionary (the client translates `errorKey`).
- HTTP routes: `res.status(400).json(errorBody('Texte {x}', { x }))` (`import { errorBody } from '../lib/i18n.js'`); extra fields: `errorBody(key, params, { code })`.
- Log: `ctx.log({ kind, author, i18n: { key: '{actor} dépense 1 point de Chance', params: { actor: a.name } } })` — `text` is filled with the French rendering; LogDock shows `logText(entry)`. Roll labels / free text typed by users stay as typed.
- Shared modules (`shared/*.js`, used by both sides): return French messages as plain strings when static (the client shows them with `t(msg)` — define a local `const tk = (s) => s` and wrap them so the checker sees them), and `{ key, params }` objects for dynamic ones (client: `t(m.key, m.params)`, server: `ctx.fail(m.key, m.params)`).
- Text that must be stored already translated (rare, e.g. a generated document): `ctx.t(key, params)` renders in the table language (`server/lib/i18n.js` reads the same dictionaries; `t(lang, key, params)`, `tn(lang, n, …)` outside actions).
- Transient events carrying text to show (`emitTo(…, { note })`): send keys + params too and translate client-side.

### Checker
`node tools/i18n-check.js [--area <area>] [files…] [--add-missing=<area>] [--strict] [--json] [--unused] [--no-literals]`
- Lists `t()/tn()/tk()` keys and server `ctx.fail()/errorBody()/i18n.key` keys that have no English entry, keys built with `${…}` (must become params), dictionary problems (invalid JSON, non-string values, placeholder mismatch, one key translated two ways), and **suspicious untranslated French literals** (heuristic: accented letters / common French words in html`` text nodes, `title= placeholder= label= hint= alt= aria-label=`, and literals passed to `toast( confirmAction( promptText( setErr( Error(` or `label:/title:/hint:/placeholder:` props). A line containing `i18n-ignore` is skipped.
- `--add-missing=sheet` appends the missing keys of the scanned files to `client/i18n/en/sheet.json` with `""` values (empty = still missing), ready to translate.
- Done = `node tools/i18n-check.js --area <area> --strict` exits 0, with no dynamic key and no literal left in your files (or only justified `i18n-ignore`), and the module's tests still pass (`test-client.js` `send()` still rejects with the French `error` text, so existing assertions keep working). Then switch to EN in the app (top bar) and check the Réglages counter while visiting your screens.

## Persistence & robustness (core)
- `saveNow()` writes `state.json` atomically (tmp + fsync + rename) and never throws: on an fs error (EPERM lock by an antivirus/viewer, disk full) it logs and retries. `saveSoon()` debounces 400 ms but never postpones more than 2 s. Logins and admin import/reset save at once.
- Pending changes are flushed on SIGINT/SIGTERM/SIGHUP (console window closed)/SIGBREAK and on process exit; uncaught exceptions are logged without killing the server.
- An unreadable `state.json` at boot is never overwritten: it is copied to `state.corrupt-<ts>.json` and the newest readable copy (`state.json.tmp`, then backups) is restored; with none, that table is marked unavailable (503, listed by `/api/health` and `/admin`) and the other tables keep running.
- Backups (`backups/state-<ts>-<label>.json`): `boot` at every start, `shutdown`, `manual`, `before-import`, `before-reset` (20 newest kept) and `auto` every 15 min only when the state changed (30 newest kept).
- `/api/admin/import` fills missing base slices, keeps the live GM password when the file has none, and keeps current users/sessions so connected people stay logged in.
- All of this is per table (`createStateStore(dir)` in store.js): each table has its own state file, timers and backups.

## Multi-table hosting (core)
One server hosts several **tables** = independent campaigns (own GM password, players, actors, maps, campaign, shop/training/audio state, uploads, docs, backups). Modules are unchanged: they always receive ONE table's state.
- **Registry** `<runtime>/server.json` `{ tables: [TableMeta], adminPasswordHash, adminPasswordEnv }`, `TableMeta = { id, slug (= id, immutable), name, createdAt, archived, hidden, pack: 'project-lazarus'|'vierge', lang, legacy?, docsDir? }`; a copy sits in `tables/<id>/table.json` so a copied/restored folder is adopted at boot. `<runtime>` = `SR_RUNTIME_DIR` or `data/`.
- **Name**: `state.config.campaignName` is the table's display name (GM `config/update` → registry follows; admin rename → state follows).
- **Migration**: an old `<runtime>/state.json` (+ `backups/`, `uploads/`) becomes table `lazarus` with `legacy: true` (keeps `/uploads/…`, `/assets/foundry/…` URLs and the `../Shadowrun` docs folder); the original file is kept as `tables/lazarus/backups/legacy-state-<ts>.json`. Empty install: table `lazarus` is created unless `SR_BOOTSTRAP_TABLE=none` (Docker image).
- **Routing**: `/` = table picker (`GET /api/tables`; redirects to the table when only one is listed, `/?choisir` forces the list), `/admin` = admin page, `/t/<slug>/` = a table (same `index.html`/`app.js`). Every request resolves its table: URL prefix `/t/<slug>/`, else `X-SR-Table` header / `?table=`, else the session token's table, else the default table (legacy, or the only one). A named table wins: a token of another table then fails auth there.
- **Auth**: sessions stay in each table's `state.sessions`; socket handshake `{ token, table }`; tables never share sockets (one socket set + Socket.IO room `table:<id>` per table, per-table 30 ms broadcast). GM/PIN/admin logins are rate-limited per IP.
- **Table scope**: HTTP handlers registered by modules (wrapped by `scopedApp`) and socket actions run inside `tableScope` (AsyncLocalStorage, store.js) — `getState()`, `addLog()`, `emitTo()`, `saveSoon()`, `scheduleBroadcast()` and `currentTable()/currentUploadDir()/currentUploadUrl()/currentDocsDir()/localFileForUrl()` resolve to that table (also in promises/timers started there). `getState(req)` / `scheduleBroadcast(req)` accept the request explicitly.
- **Files**: uploads `tables/<id>/uploads/` served at `/t/<slug>/uploads/…` (legacy table: `/uploads/…`); Foundry imports copy assets to `tables/<id>/assets/foundry/` → `/t/<slug>/assets/foundry/…` (legacy table: shared `data/assets/foundry/` → `/assets/foundry/…`).
- **Admin API** (`server/lib/admin.js`, separate bearer token from `POST /api/admin/login { password }`, 12 h): `GET/POST /api/admin/tables`, `PATCH /api/admin/tables/:id { name?, hidden?, lang?, archived? }`, `POST …/:id/gm-password`, `POST …/:id/gm-session` (open as GM), `POST …/:id/download` → one-time `GET /api/admin/download/:ticket` (zip: state, uploads, docs, assets; `withBackups`), `DELETE …/:id { confirm: id }` (zip kept in `<runtime>/deleted/`), `POST /api/admin/restore?slug=&name=&replace=1` (body: table zip or state JSON, streamed), `POST /api/admin/password`, `POST /api/admin/deleted/:file/download`. The admin password comes from `SR_ADMIN_PASSWORD` (re-applied whenever it changes) or is generated and printed once.
- The per-table GM routes `/api/admin/backup|export|import|reset` act on the GM's own table.
- **Zips** (`server/lib/zip.js`): streamed to disk (`receiveToFile`, size cap), read from the central directory (ZIP64, CRC checked, entries bigger than declared refused), extraction rejects the whole archive on any dangerous path (absolute, drive letter, `..`). adm-zip is not used: it loads whole archives in memory.
- **Module-level state audited for table isolation**: maps vision cache = `WeakMap` keyed by the map object (OK); combat undo stack → `WeakMap` keyed by the table state (was one global array); foundry `audioJob` → `Map` by table id, world cache keyed by path + fingerprint (OK), journals/assets per table; chummer mugshots → current table's uploads; shop/training catalog indexes, chummer data caches, augment ware index: global read-only catalog data (OK).
- `GET /api/health` → `{ ok, tables, broken: [ids], uptime }` (Docker healthcheck).

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
Slice `state.foundry = { worldPath, lastScan?, lastImport? }` (GM only). Actions (GM): `foundry/worlds` (list detected worlds), `foundry/scan` `{ worldPath? }` → importable summary, `foundry/import` `{ worldPath?, select: { pcs, npcs, scenes, journals, playlists }, pcMode: 'replace'|'merge', assignPlayers? }`. Route `GET /api/foundry/status` (GM). Worlds uploaded as zips (VPS): `GET /api/foundry/uploads`, `POST /api/foundry/upload?kind=world|data` (body = zip, streamed; world → `tables/<id>/foundry/Data/worlds/<world>/` and becomes `state.foundry.worldPath`; data = extra Data folders such as `Music/`), `DELETE /api/foundry/uploads` — UI in Réglages (`client/modules/admin/FoundryUpload.js`). With `SR_FOUNDRY_LOCAL_PATHS=0` (Docker) a GM can only read worlds uploaded to their own table; otherwise local paths work but never another table's folder. Offline: `node tools/foundry-import.js [--write-seeds] [--world <path>] [--dump <dir>] [--no-audio] [--no-journals]` regenerates the seeds. Env vars: `SR_FOUNDRY_ASSET_DIR` (where the legacy table's assets are copied, default data/assets/foundry; other tables: tables/<id>/assets/foundry), `SR_FOUNDRY_DOCS_DIR` (journal markdown output, default <table docs folder>/foundry).
Reads a Foundry VTT v11+ world (LevelDB) from a COPY in a temp dir. Default world: auto-detected from `%LOCALAPPDATA%/FoundryVTT/Config/options.json` → `dataPath`/Data/worlds/* with `"system": "shadowrun5e"` (here: `C:/Users/mathi/Documents/Foundry/Data/worlds/test-world`). Assets it references (portraits, scene backgrounds, playlist audio) are copied into `data/assets/foundry/…` and served at `/assets/foundry/…`. Every imported record keeps `foundry: { id, world, importedAt }` so a later re-sync updates the same record. Journals are written as markdown to `../Shadowrun/foundry/*.md` (listed by the docs API under folder `foundry`).

### Chummer5a (module `85-chummer.js`)
Slice `state.chummer = { allowPlayerImport: true, pending: [{ id, ts, actorId, actorName, userId, userName, fileName, xml, mugshots, diff, summary, warnings, status }] }`.
Actions: `chummer/settings` (GM `{ allowPlayerImport }`), `chummer/resolve` (GM `{ requestId, approve, note? }`), `chummer/cancel` (owner/GM), `chummer/unlink` (GM `{ actorId }`).
Routes: `POST /api/actors/import-chum5` (GM, new actor), `POST /api/chummer/import` (GM new actor, or `?actorId=` = update), `POST /api/chummer/preview`, `POST /api/chummer/update?actorId=` (3-way merge; players create a pending request unless allowed), `GET /api/chummer/export/:actorId` (owner/GM; the exported file becomes the merge base). `CHUMMER_DATA_DIR` overrides the Chummer data folder.
Actor fields: `actor.chummer = { xml, fileName, importedAt, syncedAt, exportedAt?, updatedAt?, sourceHash, created, appVersion, mugshots? }` (xml stripped from the GM view by `gmFilter`), `item.chummerGuid`, `actor.realName`, `actor.metavariant`. Re-import never brings back items deleted in the app since the export, nor duplicates items the app keeps in another list (device in `actor.matrix`, shop SIN in gear).
Import `.chum5` → Actor (the original XML is kept in `actor.chummer = { xml, fileName, importedAt }`), export Actor → `.chum5`: patches the stored original when present (karma, nuyen, attributes, skill ratings, condition, new/removed gear by Chummer `sourceid` = catalog id), otherwise generates a new file from the skeleton `tools/fixtures/chummer-test.chum5`. Test fixture made with Chummer 5.226.0: `tools/fixtures/chummer-test.chum5`.

## Round 3 additions (Matrix, character creation, enemy generator)

### Matrix (owner: `45-matrix.js`, rules in `shared/matrix.js`, UI `client/modules/matrix/`)
```js
matrix: {
  settings: { hideOverwatch: false },            // true: players only see their OS with Baby Monitor loaded
  personas: { [actorId]: Persona },              // created on first use (matrix/ensure), kept in sync with actor.matrix (device, programs)
  hosts: { [hostId]: Host },
}
Persona = { actorId, online, mode: 'ar'|'cold'|'hot', asdf: { attack: 'sleaze', … } (permutation of actor.matrix base values),
  loadedPrograms: [programId], programSlots, slotsOverride, deviceName, marks: [{ targetId, name, count }], marksOnMe: [...],
  overwatch (0..40), osKnown, matrixDamage, noise, hostId, penalties, linkLocked, fullDefense, bricked, traced, files: [],
  agent: null | { rating, name, loaded, damage, source }, pendingAssist: null | { actionId, skill, dice, limitBonus, hits } }
Host = { id, name, rating, attack, sleaze, dataProcessing, firewall, alert: 'none'|'active', visible (players can target it),
  ic: [{ id, type, … }], files: [{ id, name, protected, bomb?, content }], devices: [...], perceivedBy: [userId], spotted, spider, notes (GM), description, folder }
```
- Actions (owner or GM, `ownPersona`): `matrix/ensure|connect {actorId, mode}|disconnect|setASDF {swap|asdf}|loadProgram|unloadProgram {name}|configureAgent {rating, name}|agentLoad {loaded}|agentAssist {actorId, actionId}|agentAct {actorId, actionId, targetId…}|action {actorId, actionId, targetId?, marks?, assistFromAgent?, fileOp?, edge?, …}|setFullDefense`. GM: `matrix/hostCreate|hostUpdate|hostDelete|icLaunch|icUpdate|icRemove|icAct|setOverwatch|converge|resetPersona|setPersona|setMarks|setMarkOnMe|settings`; `matrix/testDice {mode}` only exists with `SR_MATRIX_TEST=1` (tests; the loaded-dice flag is process-wide).
- The agent shares the deck (ASDF, loaded programs, marks, Overwatch Score) and rolls Rating × 2. `agentAssist` = SR5 teamwork: its hits (≤ the decker's skill) become `pendingAssist`, consumed by the next `matrix/action` of the same skill with `assistFromAgent: true`. `agentAct` = the agent performs the action itself.
- Results return `outcomes` (French) + `msgs` (`{ t, params }` messages); log entries are `kind: 'matrix'` with `i18n` (+ `authorI18n`, `roll.labelI18n`) and a GM-only `matrix.gm` block (defense pools) stripped for players.
- Player filter: only their own personas; hosts only when `visible`, when inside, or with a mark on them; rating/IC ratings/files only after Matrix Perception, file contents never listed, GM notes/spider stripped.

### Character creation (owner: `15-chargen.js`, rules in `shared/chargen.js`, UI `client/modules/chargen/`)
```js
chargen: { settings: { method: 'priority', allowPlayers: true, startingKarmaBonus: 0 },
  drafts: [{ id, userId, userName, status: 'draft'|'pending'|'approved'|'rejected', data (normalizeDraft), gmNote, ts, createdTs, submittedTs?, resolvedTs?, actorId?, check: { errors, warnings } }] }
```
- SR5 Priority system (A–E: metatype, attributes, magic/resonance, skills, resources), checked live client-side and again by the server with `compute(data, { lookup, rules, settings })`; gear prices come from `client/modules/shop/rules.js` (same authority as the shop).
- Actions: `chargen/saveDraft {draftId?, data}` → `{ draftId, check }`, `chargen/submit`, `chargen/withdraw`, `chargen/delete` (owner or GM); GM: `chargen/resolve {draftId, approve, note?, force?, type?}` (approve = `buildActor()` → new PC assigned to the player, starting nuyen rolled when asked), `chargen/create {draftId?|data, type, assignTo?, force?}`, `chargen/settings`. Players only receive their own drafts. Transient event `chargen:resolved { draftId, status, note, actorId? }` to the owner + GM.

### Enemy generator (actions in `15-chargen.js`, rules in `shared/npcgen.js`, UI `chargen/EnemyGenerator.js` from the Bestiaire)
- Deterministic tiered NPCs (Professional Rating 0–6, grunt rules): `generate()/generateEncounter({ archetype, tier, metatype, seed, grunt?, lieutenant? }, { find, rules })` → bestiary Templates (accepted by `sanitizeTemplate()` of 30-combat).
- GM actions: `npcgen/preview {…}` → `{ main, lieutenant, unitName }` (nothing stored); `npcgen/create {…, saveToBestiary, spawn?: { mapId (null = actors only), count, x?, y?, hidden?, addToCombat? } }` → `{ templateIds, actorIds, tokenIds, mapId, unplaced }`. Spawning goes through `bestiary/spawn`; saved templates land in folder « Générés ». Generated names/descriptions are stored French data.

### Integration checks
- `tools/i18n-check.js` must report 0 missing; every `tools/test-*.js` and `tools/smoke.js` pass. `tools/test-integration.js` (port 3971) runs the cross-module flow (two tables at once, EN + FR: admin creates a vierge/en table, player creator → GM approval, enemy generator + spawn + combat, Bricks + agent in the Matrix on Lazarus, no cross-table leak, keyed errors translated).
- Admin HTTP errors use `errorBody()` too (`fail(res, status, key, extra, params)` in `server/lib/admin.js`), so `/admin` shows them in English.

## Notes (owner: `75-notes.js`, UI `client/modules/notes/`, English `client/i18n/en/notes.json`)
Main tab `notes` (GM + players): each user has a **private** note space, the party has a **collaborative** one the GM reads too.
```js
notes: {
  pages: { [id]: { id, scope: 'private'|'party', ownerId (userId, private only), title (≤120), body (markdown, ≤100 000 chars), shareWithGM (private only),
    folder (≤60, '' = none), pinned, createdBy, updatedBy, createdAt, updatedAt, version (counts BODY changes),
    lock?: { userId, name, until } (party only, 60 s), deleted?: { at, by } (trash, purged after 7 days) } },
  comments: { [pageId]: [{ id, userId, author, text (≤2000), ts }] },
  settings: { gmCanEditParty: false },
}
// view only: notes.now = server time (clients estimate the clock skew for lock expiry)
```
- **Visibility** (`filter` AND `gmFilter`, the GM view is filtered too): a private page goes to its owner only, and to the GM while `shareWithGM` (read-only, the GM may comment). Party pages go to every user of the table. Comments follow their page. Any action on a page the user cannot read answers « Note introuvable » (existence never revealed). Private actions never log nor emit to anyone else. Limits: 300 private pages per user, 500 party pages, 12 M characters of bodies per table.
- **Write rights**: private → owner only (the GM may keep private GM notes the same way). Party → any player; the GM only with `settings.gmCanEditParty` (`notes/settings`, GM). Delete = soft (trash, restorable 7 days): private → owner; party → any player or the GM. Purge (only from the trash): private → owner; party → creator or GM.
- **Actions** (all `role: 'any'` except settings): `notes/create { scope, title, folder?, body? } → { id }` (party: logs `kind:'system'` « Nouvelle note de groupe : {title} »), `notes/save { id, body?, title?, baseVersion } → { version, updatedAt } | { conflict: true, server: { title, body, version, updatedBy, updatedAt } }` (conflict only when the body changes from a stale `baseVersion`; titles/folders/pins are last-write-wins), `notes/rename { id, title?, folder?, pinned? }`, `notes/delete`, `notes/restore`, `notes/purge { id }`, `notes/setShare { id, shareWithGM }` (owner), `notes/lock { id, force? } → { locked: false, until } | { locked: true, lock }` (party pages; private → `{ locked: false, until: null }`), `notes/unlock { id }`, `notes/comment { id, text }` (party pages, or private pages shared with the GM: owner + GM), `notes/deleteComment { id, commentId }` (author, GM, or the private page's owner), `notes/settings { gmCanEditParty }` (GM).
- Transient event `notes:comment { pageId, title, author }` → the page's other readers only.
- **Client**: two panes (« Mes notes », « Notes du groupe », GM: « Notes partagées par les joueurs » grouped by player; search in titles/bodies/folders; folders; pinned first; « Corbeille ») | editor (title, folder, pin, share toggle, Écrire / Côte à côte / Aperçu, toolbar bold/italic/heading/list/checkbox/quote/[[link]], Ctrl+B/I/S, comments). Single pane with a back button under 800 px. Autosave 1.5 s after typing stops, on blur, on leave/hidden tab; status Enregistré / Modifié… / Enregistrement… / Conflit; conflict dialog: keep mine (re-save on the server version) / take theirs / copy mine. Soft lock: taken on focus/typing of a party page, renewed every 20 s while typing (released after 45 s idle or on leave); others see « X est en train d’écrire… » and may « Modifier quand même » after a confirm (`force`).
- Markdown (`client/modules/notes/notes-md.js`, pure, tested in Node): the shared `renderMarkdown()` + `[[Titre]]` links (`#note:<id>`, or `#new:<title>` to create the missing page), `@Nom` mention badges (PC names, first names, player names), clickable `- [ ]` task checkboxes (toggling edits the source line).
- Tests: `node tools/test-notes.js` (ports 3150-3199): pure helpers, private isolation (other player, GM before/after share, other table), party visibility across one table only (second table created through the admin API), permissions, version conflict, lock lifecycle, trash/restore/purge, comments + events, payload validation. i18n: `node tools/i18n-check.js --area notes --strict` (client) and `node tools/i18n-check.js server/modules/75-notes.js --strict` (server keys; the checker's `--area` table has no `notes` entry for the server file).

### Notes — limits & privacy (after review)
- Limits: 100 000 chars per note, 1 M private chars per owner (trash included), 5 M per table (comments included), 1000 comments per author. Private pages of removed users are dropped.
- `notes/delete {id, force?}` is refused while another user holds a live lock on the party page, unless `force`.
- `state.notes` is excluded from the core's deep clone in `buildView`; the module builds `view.notes` per user (filter/gmFilter).
- The GM's « Télécharger la partie » (`/api/admin/export`) leaves out unshared private notes; server backups (host/admin) keep everything. `users/resetPin` logs a notice to the player.
- Checkboxes carry `data-line`; `toggleCheckboxAt(body, line)` toggles them outside code blocks.

## Assistant MJ (owner: `95-assistant.js`, `server/lib/assistant/`, UI `client/modules/assistant/` + `client/modules/admin/AssistantAdmin.js`, English `client/i18n/en/assistant.json`)
GM dock tab « Assistant » (GM only): a chat with Claude about the campaign, the SR5 rules and the live game. **No state slice**: conversations and proposals live in `tables/<id>/assistant.json` (never broadcast, never in any view); server-wide settings, spend ledger and signing key in `<runtime>/assistant/` (`SR_ASSISTANT_DIR`).
- **Auth** (`auth.js`): Workload Identity Federation. The server is its own OIDC issuer: EC P-256 key `signing-key.pem` (0600), public JWKS shown in /admin to paste in the Claude Console (Custom OIDC, inline JWKS); each token exchange signs a fresh ES256 JWT (`iss` = `SR_ASSISTANT_ISSUER`, `sub` = `shadowrun-table:<SR_ASSISTANT_HOST>`, 10 min, unique `jti`) passed to the SDK's `oidcFederationProvider` (env `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, optional `ANTHROPIC_WORKSPACE_ID` / `ANTHROPIC_SERVICE_ACCOUNT_ID`). `ANTHROPIC_API_KEY` is the local-development fallback. Setup steps: DEPLOY.md « GM assistant ».
- **Settings** (`config.js`, /admin → Assistant IA, `GET/PATCH /api/admin/assistant`, `POST …/test`, `POST …/reset-month`): `enabledTables` (off by default), `model` (`claude-opus-5-5` default, Sonnet/Haiku 5.5), `effort` (`medium`), `monthlyCapUsd` (80, all tables together).
- **Budget** (`budget.js`): every API response's `usage` is priced (input, output, cache reads, cache writes at the 1-hour rate unless split) and added to `usage.json` per UTC month and per table. Questions are refused (402) when `spent + 0.50 > cap`, re-checked before each tool-loop step. The Console workspace spend limit is the hard stop.
- **Request** (`run.js`, `context.js`): streamed `client.beta.messages.stream` with adaptive thinking, `output_config.effort`, server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`, Opus/Sonnet), `max_tokens` 32000, at most `MAX_STEPS` = 8 API calls per question. Cached prefix (1-hour TTL): tool definitions + instructions + core docs (GM bible, recap, outline, latest `session-N-plan`, ≤ 160 K chars) + the list of every doc. Live state is NOT in the prefix: tools read it, and each question carries one « [État de la table …] » line. Text deltas → `emitTo('gm', 'assistant:delta', { conversationId, text })`, then `assistant:step { phase }` and `assistant:done`. One run per table at a time (409); `POST /api/assistant/stop` aborts.
- **Tools** (`tools.js`): read — `list_docs`, `read_doc` (pages of 40 K chars), `search_docs`, `get_campaign`, `list_actors`, `get_actor` (minus Chummer XML), `list_maps`, `get_map`, `get_bestiary`, `get_combat`, `get_log`, `search_catalog`. Propose — `propose_map` (full tile map + doors/regions/GM notes/lights → `maps/import`), `propose_map_edits` (`maps/paint|addDoor|addRegion|addNote|addLight`), `propose_npc` (`bestiary/create`), `propose_handout` (`campaign/addHandout`, unrevealed), `propose_campaign_entry` (`campaign/addQuest|addThread|updateSession` plan append|`updateNotes` append). A proposal is validated by running its actions on a deep copy of the state (`simulateAction`, core) and stored with a preview; nothing changes until `POST /api/assistant/proposals/:id/apply`, which rebuilds the ops from the current state and runs them with `runAction` (core: the same path as socket actions — save, broadcast). No tool reveals anything to players, touches PCs, deletes, rolls or posts in the chat.
- **Routes** (GM, table must be enabled): `GET /api/assistant/status`, `GET|POST /api/assistant/conversations`, `GET|DELETE /api/assistant/conversations/:id` (view = items `user | assistant | tool | proposal | notice`; raw API messages stay server-side), `POST /api/assistant/ask { conversationId?, text, lang }` → `{ conversationId }` (the answer streams over the socket), `POST /api/assistant/stop`, `POST /api/assistant/proposals/:id/apply|dismiss`.
- Core additions: `runAction(table, user, type, payload)` and `simulateAction(table, user, type, payload, state?)` in server/index.js, passed to module routes as helpers (with `actions`).
- Tests: `node tools/test-assistant.js` (ports 3990-3999) — a local fake Claude API (`ANTHROPIC_BASE_URL`) replays scripted streamed responses: JWT signature/claims, pricing and ledger, gating (admin/GM/player/disabled table), tool loop and step limit, proposals (map, invalid map → tool error, NPC, unrevealed handout, quest) applied through the normal actions, nothing leaks to players, cap → 402. i18n: `node tools/i18n-check.js --area assistant --strict`.
