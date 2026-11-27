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
| sheet/Dice3D.js | `({game})` global 3D dice overlay (see « Dice ») | global |
| campaign/CampaignPage.js | `({game})` GM campaign: acts, quests, sessions, handouts, docs, notes | main tab `campaign` |
| campaign/DossiersPage.js | `({game})` player handouts + recap | main tab `dossiers` |
| matrix/MatrixPage.js | `({game})` decker cockpit (players) / Matrix overview, hosts & IC (GM) | main tab `matrix` |
| chargen/ChargenPage.js | `({game})` priority character creator (players) / approval queue (GM) | main tab `chargen` |
| notes/NotesPage.js | `({game})` private notes + collaborative party notes (see « Notes ») | main tab `notes` |
| books/BooksPage.js | `({game})` rulebooks: search, common rules, library (see « Rulebooks ») | main tab `books` |
| books/BookViewer.js | rulebook viewer drawer, opened with `openBook(code, page)` | global |
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
  weapons: [{ id, name, category, kind: 'melee'|'ranged', skill: 'pistols', accuracy, damage: '7P', ap: -1, mode: 'SA', rc, ammo: '15(c)', reach, notes?, catalogId?,
              mounts?: ['Top'|'Under'|'Barrel'|'Stock'|'Side'], accessories?: [Accessory],   // accuracy / rc = BASE values, accessories add (see below)
              equipped: bool (ready / stowed), location, ammoMax?, ammoType?, ammoLoaded?, ammoKind?: { name, nameFr?, catalogId? } | null, qty? (grenades) }],   // « Inventaire »
  armor: [{ id, name, rating, equipped: bool, stack?: bool (helmet/shield adds), notes?, catalogId?, capacity?, mods?: [ArmorMod], location }],
  augmentations: [{ id, name, kind: 'cyberware'|'bioware', grade: 'standard'|'alpha'|'beta'|'delta'|'used', rating?, essence, notes?, catalogId? }],
  gear: [{ id, name, category, rating?, qty, notes?, catalogId?, active? (worn / switched on: its catalog effects count — « Modifiers »), location, ammoFor? (Chummer) }],
  containers: [{ id, name, kind: 'body'|'bag'|'vehicle'|'safehouse'|'other', notes? }],   // places of the inventory; « Sur soi » = 'on', implicit
  vehicles: [{ id, name, handling, speed, accel, body, armor, pilot, sensor, seats?, notes?, catalogId?, mods?: [VehicleMod] }],
  matrix?: { device, rating, attack, sleaze, dataProcessing, firewall, programs: [string] },
  contacts: [{ id, name, connection, loyalty, notes? }],
  sins: [{ id, name, rating, licenses: [string] }],
  lifestyles: [Lifestyle],   // see « Lifestyles, accessories, mods, martial arts » (the old single `lifestyle` is migrated by normalizeActor)
  martialArts: [{ id, catalogId?, name, rating (1), techniques: [{ id, catalogId?, name, nameFr?, notes?, chummerGuid? }], notes?, chummerGuid? }],
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
`source?` / `page?` on every item and nested item (rulebook reference: Chummer book code + printed page, see « Rulebooks › References everywhere »),
`foundry: { id, world, importedAt }` (Foundry import), `magic?` (written by training, see Training below),
`augmentations[].bonus` / `powers[].bonus` / `qualities[].bonus` = attribute / initiative bonus actually stored on the actor (`{ attributes: { REA: 1 }, initiativeDice: 1, initiative: 6 }`, from the catalog effects — `server/lib/augment.js bakeItemBonus` — reversed on removal/sale, re-applied on a rating / level / choice change),
`weapons[].augId` = implant weapon of that augmentation (removed with it, never sold separately),
`gear[].paid` = unit price paid in the shop, map tokens `moveBudget: { key, meters }` (combat movement, maps module).
Derived values: `import { derive, skillPool, rollDice, attr, SKILLS, SKILL_BY_ID } from '/shared/sr5.js'` — never store derived numbers.
Default roll limit: `skillDefaultLimit(def, attr)` (shared/sr5.js) — a skill's own `limit` ('physical'|'mental'|'social'|'astral', or null = none, e.g. spellcasting/pilot) overrides its category.
Player permissions on their own actor: condition, edge.current, armor equipped/location, gear qty (lower only — only the GM raises a quantity)/notes/active/location, weapon notes/equipped/location/ammoLoaded (lower only), containers (inventory/*), fire & reload (weapon/*), notes, portrait, bio, color, contacts notes. Attributes/skills/karma/nuyen/qualities change only via GM edit, shop, or training.

#### Lifestyles, accessories, mods, martial arts (characters module + sheet + Chummer/Foundry mapping)
Nested lists restore what the characters had in Chummer (upgrades lost on the way Chummer → Foundry → app). Sub-items keep the
English Chummer/catalog `name` and the French `nameFr` (display with `itemName()`), `catalogId` = Chummer GUID, `chummerGuid` once synced.
```js
Lifestyle = { id, name (free: 'Best Home'), base: 'Street'|'Squatter'|'Low'|'Medium'|'High'|'Luxury'|'Bolt Hole'|'Traveler'|'Commercial'|'Hospitalized',
  catalogId?, baseCost (¥/month), monthsPaid, primary: bool (exactly one), points?: { comforts, security, neighborhood, entertainment? } (RF), pointCost?,
  qualities: [{ id, catalogId?, name, nameFr?, category ('Positive'|'Negative'|'Contracts'|'Entertainment - Asset'…), cost (flat ¥/month),
                multiplier (%, e.g. −20 = Dangerous Area), baseOnly? (the % applies to baseCost only: Chummer <multiplierbaseonly> /
                <basemultiplier>, Extra Secure +20), lp?, notes?, chummerGuid? }],
  monthlyCost (derived, stored — shared/lifestyle.js monthlyCost(), Chummer's order: (baseCost × (1 + Σ baseOnly %/100) + Σ cost of non-'Contracts'
    options + RF points × pointCost) × (1 + Σ other %/100) + Σ cost of 'Contracts' options; Medium + Garage + Dangerous Area = 4 080), notes, chummerGuid? }
Accessory = { id, catalogId?, name, nameFr?, mount: 'Top'|'Under'|'Barrel'|'Stock'|'Side'|'Internal'|'', rating?, cost, avail, included? (built in),
  equipped? (false = off), effects?: { accuracy?, rc?, rcGroup? (same group: best one only), dicePool?, smartgun? }, notes?, chummerGuid? }
ArmorMod = { id, catalogId?, name, nameFr?, rating?, capacity (may be < 0: YNT Softweave adds room), cost, avail, included?, effects?: { armor? }, notes?, chummerGuid? }
VehicleMod = { id, catalogId?, name, nameFr?, rating?, slots, category, cost, avail, included?, notes?, chummerGuid? }
```
- Pure helpers (`client/modules/sheet/sheet-data.js`): `SUB_LISTS` (`weapons → accessories`, `armor → mods`, `vehicles → mods`, `lifestyles → qualities`,
  `martialArts → techniques`), `weaponMods(w)` → `{ accuracy, rc, dicePool, smartgun }`, `armorMods(ar)` → `{ used, total, bonus }`, `vehicleSlots(v)`
  (total used) / `vehicleSlotsByCategory(v)` (per R5 pool, labels `VEHICLE_MOD_CATEGORIES`),
  `catalogToItem()` / `subFromCatalog(catalog, entry, rating)` for the catalogs `lifestyles`, `martialarts`, `lifestylequalities`, `accessories`, `armormods`,
  `vehiclemods`. `normalizeActor` gives every actor `lifestyles: []` / `martialArts: []`, ids to nested items, one primary lifestyle, and migrates a
  legacy `lifestyle: { name, monthlyCost, monthsPaid }` once (base guessed from the name, `baseCost = monthlyCost`).
- Actions (GM; players read-only): `actor/addItem|updateItem|removeItem` accept the lists `lifestyles` and `martialArts` (lifestyle: `monthlyCost` is
  always recomputed, `primary: true` moves the primary flag) and sanitize nested arrays passed with an item; `actor/addSubItem { actorId, list, itemId,
  sub: 'accessories'|'mods'|'qualities'|'techniques', item } → subId`, `actor/updateSubItem { …, subId, patch }`, `actor/removeSubItem { …, subId }`
  (`sub` must match `SUB_LISTS[list]`, else « Sous-liste inconnue : {sub} »). Sanitizing (`sanitizeSub`) keeps the shop-only fields on GM edits: `paid`, `choice`, accessory `extraMount` / `effects`, armor-mod `effects.armor` / `bonus`, vehicle-mod `effects`.
- Display: the sheet shows the accuracy / RC of a weapon WITH its accessories (`weaponMods`), a « smartgun » badge (+2 dice with a wireless smartlink:
  a note, not added automatically), accessory `dicePool` added to the attack roll; armor rows show their mods, « Capacité used/total » and the mods'
  armor bonus (`+2` from Gel Packs — counted: `shared/sr5.js armorTotal()` adds Σ `mods[].effects.armor` of equipped mods to each equipped armor,
  `armorValue(a)` / `armorModBonus(a)`; armor `rating` is the BASE value: Chummer `<armor>`, Foundry `armor.base` — a Foundry rating taken from
  `armor.value` (mods included) gets no `effects.armor`, nor do restored mods with `ratingIncludesMods`); vehicles their mods and slots (« 9 emplacements
  utilisés (Protection 6 · Carrosserie 3) »); « Contacts & SIN » the lifestyles (cost breakdown, options); « Combat » the « Arts martiaux ». GM edit
  mode: a « Accessoires / Modifications / Options / Techniques (n) » button on each row of the list editor opens the nested editor (blank or from the
  catalog; techniques from the martial art's `stats.techniques`). A catalog pick gets the values that depend on the parent item from
  `rules.js upgradeFields()` (the parent's catalog entry is loaded): capacity with its Capacity (YNT Softweave), slots with its Body (Gecko Tips),
  price with its value (« Weapon Cost »…; left at the catalog price when the parent's value is unknown).
- Chummer (`server/lib/chummer/`): parse reads every `<lifestyle>` (+ `<lifestylequalities>`, cost formulas like `25000 div 12`, `<basemultiplier>`
  of standard / `<multiplier>` of advanced lifestyles, RF points, primary = `<primarytenant>` else the most expensive), weapon `<accessories>`
  (+ `mounts` from the data `accessorymounts`), armor `<armormods>` (capacity evaluated with the armor's capacity), vehicle `<mods>` and
  `<martialarts>/<martialarttechniques>` (`chummerEval()` evaluates Chummer formulas: Rating, Capacity, Body…, `FixedValues`, `div`, `mod`, `number()`).
  Export: lifestyles and martial arts are ordinary lists; nested nodes are synced by guid in patch mode (removed → deleted, new → built from the
  Chummer data, rating/notes patched) and built in generate mode; new nested guids come back in `assigned.sub[subItemId]` (stored by 85-chummer).
  Re-import (merge.js): nested lists are merged entry by entry by `chummerGuid` like the parent lists (app ids kept; entries added in the app since
  the last sync survive an upload that did not touch them); `sameItem` ignores nested ids. Quality `<basemultiplier>` ↔ `baseOnly`.
- Foundry (`server/lib/foundry/convert-actor.js`): lifestyle items → `lifestyles[]` (`system.type` → base, comforts/security/neighborhood →
  `points`, `system.mods` → qualities; `system.cost` is the TOTAL per month: without options it becomes `baseCost`, with options `baseCost` = the
  catalog base and the options are added back — no double count); weapon/armor modifications embedded in the item
  (`flags.shadowrun5e.embeddedItems`, `system.mod_weapon { mount_point, accuracy, rc, dice_pool }`, `system.mod_armor.value`) → accessories / mods.
  A merge re-import whose snapshot predates `lifestyles[]` adopts the app lifestyle of the same name instead of duplicating it. `actor.foundry.snapshotVersion`
  (2 = item hashes include `mounts` / `capacity` / `accessories` / `mods`): with an older snapshot an item that only differs by those fields counts as
  unchanged; an item Foundry did change replaces the app's but keeps the nested entries the app added (absent from Foundry, matched by catalogId /
  name, non-`fvtt_` ids) and `ammoLeft`.

#### Inventaire (characters module, rules `client/modules/sheet/inventory.js` — pure, shared by server and sheet; UI `tab-inventory.js`, `weapon-ui.js`)
- **Names in both languages**: `item.nameFr` / `item.nameEn` and `categoryFr` / `categoryEn` (weapons, armor, gear, augmentations, vehicles) are filled by
  `10-characters.js fillItemNames` (boot + every characters action, missing fields only) from the catalog entry of `catalogId` — names only when the stored
  name IS a catalog name (renamed items keep theirs), categories when the stored one is the catalog's or empty; an item without `catalogId` gets one by
  exact English / French catalog name (never overwritten; weapons also take names from weapon-like gear: grenades). A GM change of name / category /
  catalogId clears them. Display: `common.js itemLabel(item)` (FR: nameFr › name; EN: nameEn › name), `itemTitle` (stored / other name in the tooltip),
  `categoryLabel`, `modeLabel` (FR CC/SA/TR/TA, EN SS/SA/BF/FA), `damageLabel` (FR « E » = Stun). The stored `name` is never changed. A weapon ammo
  without reload type (Foundry « 14 ») takes the catalog's (« 14(c) ») when the capacity matches (`fillItemNames` returns true then and the caller runs
  `normalizeActor` again, so `ammoType` follows at once). Log / error params name items with `biName(item)` = `{ fr, en }` (format.js picks the viewer's
  language); a weapon attack roll carries `labelI18n { key: 'Attaque — {weapon}', params: { weapon: { fr, en } } }` (common.js `rollLabel`).
- **Ammunition**: `ammo` « 15(c) » → `ammoMax` 15 / `ammoType` (c clip, m internal magazine, b break action, d drum, cy cylinder, belt, ml muzzle loader;
  Foundry 'ceinture' / 'tambour' mapped), recomputed by `normalizeActor` (`normalizeInventory`); `ammoLoaded` defaults to full (the old `ammoLeft` is
  adopted then deleted; `actor/updateItem { ammoLeft }` still means ammoLoaded); `ammoKind` defaults to regular rounds (`DEFAULT_AMMO`: gun / taser / bow).
  **Firing**: `dice/roll` with the `weaponId` of a weapon with `ammoMax` uses the rounds of `fireMode` (`FIRE_OPTIONS`: SS / SA 1, SB semi-auto burst 3, BF 3,
  LB long burst 6, FA 6 (Simple) / FAC 10 (Complex), SUP suppressive 20 — SR5 p. 179; absent = the weapon's first mode; a mode the weapon lacks is refused),
  checked before the roll. Fewer rounds than the mode (SR5 p. 180): fires what is left, `short` = missing rounds, defense modifier `min(0, defense + short)`
  (`defense`), suppressive fire 1 m narrower per 2 missing rounds (`narrower`); an empty weapon → « Plus assez de munitions — recharge » (GM: `ammoOverride`
  fires 0 round); `roll.fire = { mode, rounds, left, max, short?, defense?, narrower? }`. The weapon must be within reach (carried or in a bag; GM: anywhere)
  for `dice/roll`, `weapon/fire` and `weapon/reload`.
  Grenades (`isGrenade` = `isThrownExplosive`: throwing skill or none, name / category « grenade » / « explosive »; never a magazine — Chummer's
  « <ammo>1</ammo> » is dropped): a throw uses one `qty` (default 1), the last one removes the weapon (`roll.fire.item`). Launcher profiles
  Thrown weapons added as gear (catalog gear with throwing-weapon stats: grenades, Molotovs, throwing knives — shop, sheet, bestiary
  templates) are moved to `weapons` with their qty (`thrownGearToWeapons`: on add / boot / spawn / shop delivery; same weapon → qty grows).
  (`isLauncherProfile`: « Minigrenade: … » entries, never offered as a weapon) and grenade launchers are not single-use (the launcher's magazine is used).
  `weapon/fire { actorId, weaponId, mode?, override? }` = the same without a roll (logged). Melee weapons are untouched.
  **Reload** `weapon/reload { actorId, weaponId, sourceItemId?, free? (GM) }` (owner / GM) — one action (`reloadPlan`, SR5 p. 163 simplified): rounds come from
  compatible ammunition gear (`ammoFits`: ammo class from Chummer `ammoFor` / names — « Ammo: », « Arrow: », « Taser Dart »…, Foundry's original name kept
  in `notes` —; firearm rounds restricted by the weapon category in parentheses « (Sniper Rifles) » or Chummer `choice`), carried first then bags, never
  from a vehicle / safehouse; the box's `qty` goes down (kept at 0). A spare clip of that weapon (« Spare Clip (Ares Desert Strike) », `clipFits`) = clip
  change: ONE Simple Action (simplification: SR5 counts remove + insert clip as a Simple Action each; drum / belt: Complex), clips kept; without one
  (« Fill Clip / Belt / Drum ») = AGI rounds per Complex Action; internal magazine / cylinder AGI rounds, break action 2, muzzle loader 1 per Complex Action;
  cylinder + speed loader: Complex, full. Other ammunition than the loaded kind: the rounds taken out go back to a box of their kind (within reach first;
  created « Sur soi » if none). Without `sourceItemId`, a weapon that still holds rounds is only reloaded from its loaded kind (« Plus de {ammo} à portée :
  choisis d’autres munitions »); the sheet's ↻ opens the chooser instead of reloading at once when the only source is another kind.
  Returns `{ loaded, ammoLoaded, max, action, swap, sourceId, clipId, returned, dropped }`; logged.
- **Ready weapons / locations**: `weapon.equipped` (« prête » / « rangée »; unarmed always ready). Defaults (idempotent): flags already set are kept;
  otherwise the first carried ranged weapon and the first carried melee weapon when none is ready. Soft limit: more than 2 ranged + 2 melee ready (unarmed,
  grenades not counted) → warning (`readyCount`), never a block. The Combat tab and the roll dialog list the ready weapons (« afficher tout »).
  `item.location` (weapons, armor, gear) = 'on' (« Sur soi », implicit) or a container id; unknown → 'on'. In a 'bag' / 'vehicle' / 'safehouse' / 'other'
  container an item is never ready / worn / active (switched off); readying / wearing / activating it moves it 'on' from a bag (`settleItem`); from a
  vehicle / safehouse / other place players are refused (« hors de portée »; GM: moved 'on'). 'body' containers (holster, vest) count as carried.
  Players cannot change the kind of a vehicle / safehouse / other container, nor remove one that still holds items; moving an item out of one (`inventory/move`,
  `location` patch) is allowed and logged (« {name} récupère {item} ({place}) ») so the GM sees it. Actions (owner / GM): `inventory/addContainer { actorId, name, kind? }` → id (kind guessed from the name),
  `inventory/updateContainer { actorId, containerId, patch: { name?, kind?, notes? } }`, `inventory/removeContainer` (contents back 'on') → count,
  `inventory/move { actorId, list, itemId, location }` → `{ location, stowed }`; `actor/updateItem` also accepts `location` / `equipped` from players.
- **Imports**: Foundry `system.inventories` (« All » skipped) → containers `fvtt_inv_<slug>` + item locations (a weapon / armor Foundry marks equipped
  stays 'on'), weapon `ammoLoaded` (system.ammo.current.value), thrown weapon `qty`. These inventory fields are never part of the Foundry item hashes
  (`importer.js INVENTORY_FIELDS`: old snapshots stay valid); a merge keeps the app's location / ammoLoaded / ammoKind / grenade qty, adds the Foundry
  containers the app lacks and moves the matching items that are still 'on' into them (live actors adopt Foundry's bags once). Chummer: `<gearlocations>`
  / `<armorlocations>` / `<weaponlocations>` → containers `chum_<guid>`, item `<location>` (guid, or name in old files), weapon `<equipped>`, active clip
  count / ammo (`<clips>`, `<activeammoslot>`), gear `<ammoforweapontype>` → `ammoFor`; weapon `<equipped>` is NOT imported as ready (Chummer marks
  nearly every weapon equipped: the app's ready defaults apply) and never written from it; export writes `<location>` (creating the Chummer location of an
  app container, matched by guid then name), the active clip's count when the file has clips; re-import (merge.js) adds new containers.
- **Live table migration**: `init` runs `normalizeActor` (containers [], locations 'on', ammo fields, ready defaults) and `fillItemNames` on every actor at
  every boot — idempotent (`tools/test-inventory.js` boots twice). Tests: `node tools/test-inventory.js` (ports 3443-3445).

Dice: `'dice/roll'` (characters module) `{ pool, label, actorId?, skillId?, attr?, attr2?, useSpec?, test? ('composure'|'judgeIntentions'|'memory'|'liftCarry'|'defense'|'soak'|'drainResist'|'biofeedback'|'toxinResist': kept only on an attribute-only roll of that test's attributes, `shared/modifiers.js TEST_ATTRS` / `checkedTest`), weaponId? (the weapon's skill is used; only the GM may roll it with another `skillId`), matrixLimit? ('attack'|'sleaze'|'dataProcessing'|'firewall'; Matrix skills only: `MATRIX_LIMIT_SKILLS`), conditions?: [switch keys], ignore?: [modifier ids], limit? (number = that limit; null/0 = none; absent = computed — players can neither raise nor remove a computed limit; a computed limit is ≥ 1), applyWounds? (GM only: the wound modifier always applies to a player's skill / attribute roll except damage resistance tests `RESIST_TESTS`), bonus?: [{label, value}] (players: only « VOL » of total defense and « Firewall » of Matrix defense / biofeedback, recomputed; any other line counts as « mod. »), explode? (Edge: Push the Limit — adds EDG to the pool, rule of six, ignores limit and spends 1 Edge), secret? (GM only: gmOnly log), modifier?, fireMode?, ammoOverride? (GM; see « Inventaire ») }` → logs `{ kind: 'roll', roll: {..., breakdown, limitLabel?, limitBreakdown?, mods?: [ModLine], conditions?} }` and emits `sfx { id: 'dice' }` to all. Server rolls (Math.random). Pool and limit modifiers are computed by the server (« Modifiers »).
- **3D dice** (`client/modules/sheet/Dice3D.js` + `dice3d.css`, client only): every new log entry with `roll.dice` is thrown as CSS 3D cubes (`roll.extra` = a second wave; max 40 dice shown), then a banner shows hits / glitch badges (click = next). Each die is simulated up front (`simulateDie`, exported for checks: fall, bounces, rolling without slipping until it stops, lifted onto its lowest corner so it rocks over its edges; frames played with requestAnimationFrame, top-down camera). The spin is computed forward and the orientation backward from the resting pose (the server's value facing up, random yaw), so the die rolls straight into it — no snap at the end. Per-browser choice `localStorage['sr.dice3d']` = `'off'` | `'mine'` (own rolls + rolls on own characters) | `'all'` (default: every roll the user can see), set with `Dice3dPicker` (🎲 button in the Journal & dés bar). Entries present at load are never replayed; a burst keeps the last 3, the queue at most 4.
- **SINs** (rules `shared/sins.js`, UI `client/modules/sheet/sins.js` + `sins.css`, test `tools/test-sins.js`): `sins[]` items `{ id, name, rating, licenses: string[] (« Driver's License (4) »: a « (n) » is that license's rating, else the SIN's), notes?, real? (legal SIN: never checked), burned?, burnedAt? }`. The Contacts & SIN tab shows each one as an ID card (identity without « Faux SIN — », decorative `sinNumber(id)`, Fake SIN Details text of its rating, licenses, « Grillé » stamp); « Présenter / contrôler » opens the big card + verification panel (system rating 1-6 with the SIN Verification Details text, SIN or one license, odds `checkOdds`). `'actor/sinCheck' { actorId, sinId, license?: index, device: 1-6, secret? (GM) }` (owner or GM; SR5 p. 364): Device Rating × 2 dice, threshold = SIN / license rating; hits < threshold `pass`, = `odd`, > `burned` → the SIN gets `burned` (not on a secret roll: the GM decides). Log entry `kind: 'roll'`, `labelI18n` « Contrôle de SIN — {sin} » / « Contrôle de licence — {license} ({sin}) », `roll.sinCheck = { sinId, sin, device, threshold, license?, licenseIndex?, outcome, burnedNow? }` (LogDock `SinCheckLine`; no Edge: `dice/secondChance` refuses it). A burned SIN fails automatically without a roll (system log). `'actor/sinBurn' { actorId, sinId, burned }` (GM: « Griller » / « Restaurer » on the card); the GM's list editor also has « Vrai SIN » / « Grillé ».
- **Contacts** (rules + tables `shared/contacts.js`, UI `client/modules/sheet/contacts.js` + `contacts.css`, test `tools/test-contacts.js`; SR5 p. 387-389): each contact is a dossier card (portrait / color of its sheet, Connection 1-12 and Loyalty 1-6 gauges with the Connection / Loyalty table texts, the owner's inline notes). « Contacter » = the dossier full size + usual fee (`contactFees`: Connection × 100 ¥ info, × 1 000 ¥ goods, Loyalty × 10 % off) + Favor Rating table (≤ Loyalty « accepte ») + rolls. `contactSheet(state, contact)` = the contact's stats from an NPC actor, else a bestiary template, of the same name (also the shop's contact search; players read it from `view.shop.contactSearch[actorId]`, the GM computes it). `'actor/contactRoll' { actorId, contactId, kind, modifier?, secret? (GM) }` (owner or GM): `reach` 2D6 (plain `total`, no hits) ≥ Connection → `available`; `negotiate` = the runner's Negotiation + CHA [Social] through `performRoll` (modifiers, Edge) + Loyalty dice + `bribe` bought dice (`bribeCost` 100 × (7 − Loyalty) ¥ each, shown, not charged); `legwork` (contact's Connection + CHA [Social], one hour of the extended test, the GM adds hits) and `network` (contact's Etiquette + CHA + Connection [Social] vs `threshold` = target's Connection, `success`) need the contact's sheet, are logged under the contact's name with `actorId: null` (no Edge). `roll.contactRoll = { kind, contactId, contact, connection, loyalty, total?, available?, bribe?, bribeCost?, threshold?, success?, via? }` → LogDock `ContactRollLine`. `dice/secondChance` refuses rolls without hits; the 3D dice banner shows `total` when there are no hits.

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

### Attacks (owner: attacks module `33-attacks.js`, rules `shared/combat.js`, UI `client/modules/combat/AttackTray.js` + `attack-common.js`)
Targeted attacks resolved step by step; every roll goes through the characters module's `performRoll(ctx, payload, internal)` (the body of
`dice/roll`: same modifiers, log entry, Edge — `internal` = trusted named dice lines, fewer rounds, AP on soak, extra log fields) and the
damage through `applyDamage(ctx, actor, n, type)` (body of `actor/damage`). Initiative costs: `spendInitiative(ctx, actorId, cost, label)` (combat module).
```js
attacks: {
  list: [Attack],   // newest first, max 60
  blasts: [{ id, mapId, attackerId, weaponName: { fr, en }, from, aim: { x, y }, x, y (landing cell, may be fractional), meters (scatter), scattered,
             dir: [d6, d6], dist: [d6…], fumble?, glitch?, dv, type, ap, falloff | radius, reach (m), hits: [{ actorId, tokenId, name, dv, meters, attackId }] }], // max 12
  turn: { [actorId]: { key: combatTurnKey, defended, boosts: [defense option ids paid for the turn], once: [action ids] } },   // GM only
}
Attack = { id, ts, mapId, kind: 'ranged'|'melee'|'blast', attackerId, attackerName, targetId, targetTokenId, targetName, weaponName, actionId?, actionName?,
  hits, dv (null = no damage code), type, ap, reach, defenseMod (fire mode), actionDefense, noDamage?, range?, meters? (blast),
  status: 'defense'|'soak'|'missed'|'done'|'cancelled', defenseHits?, net?, modifiedDv?, soakHits?, damage?, damageType?, resolvedTs?, gmOnly? }
```
- `attack/roll` (any, owner of the attacker): the `dice/roll` payload + `{ targetTokenId? | targetActorId?, point?: { x, y }, actionId?, profileId? (launcher
  round: a « Minigrenade: … » sheet profile id or a `MINIGRENADES` catalog id), mapId? (GM) }`. Grenade launcher: the round fired gives DV / AP /
  blast (`launcherRounds`: sheet profiles, then the catalog minigrenades the sheet does not list, the one matching `ammoKind` first); without
  `profileId` the loaded or first sheet round, none → refused (« Choisis la minigrenade tirée »). Ranged weapon + attacker token on the map → range modifier line « portée moyenne (18 m) −1 » (SR5 p. 185).
  Special action (`COMBAT_ACTIONS`): unlocked by a quality / power / martial art technique of the same name (French, English, or the
  « English name · BOOK page » notes of Foundry imports — `unlockNames`; the GM may use any), dice / DV / AP / reach, fewer rounds (Double Tap…),
  Edge and initiative costs paid after the roll, `once` per Combat Turn. Area weapon (`isAreaWeapon`: thrown grenade, grenade / missile launcher) +
  point (or the target token's cell): 3 hits = no scatter, else 2D6 direction (7 = beyond the target, 2/12 = back) and (N D6 − hits) m (N: 1
  grenade, 2 aerodynamic, 3 launcher, 4 missile, 5 rocket), glitch ×2, critical glitch = at the thrower's feet; blast (`blastOf`: « −N/m » / « N m
  Radius » in the damage, else the SR5 p. 435 table by name) → a `soak` attack for each token with a sheet in reach. Otherwise: a `defense` attack
  (0 hits = `missed`). Returns the roll + `attackId` / `blast`.
  Area effect (`areaEffectOf`): 'explosion' (blast marker until the end of its Combat Turn, 1 min outside combat), 'smoke' / 'thermalSmoke' /
  'gas' / 'flashpak' (`LASTING_EFFECTS`: a cloud until the end of the fight, 10 min outside; radius 10 m when the round gives none).
  A marker from before `until` existed lasts one minute from its `ts`. Blast
  record: `effect`, `until` ({ round: 'startedAt:round' } | { combat: startedAt } | { ts }), `toxinId`. Gas: `toxinId` (payload, else named in the
  grenade — `toxinFromText`, else CS) from `TOXINS` (SR5 p. 409-410), no blast damage; a `toxin` attack (status `soak`, dv = Power, ap =
  Penetration) for each token in the cloud, unless `toxinProtection` = immune (chemical seal; gas mask vs an inhalation-only toxin).
  Environmental modifier (SR5 p. 175, `environmentFor`): columns visibility (map `weather.visibility`, heavy through a smoke cloud on the line
  of fire), light (target cell: `lightLevelAt` from `createVisionContext` litRatio — lit 0, light edge 1, dim map 2, dark 3; flash-pak glare
  3 when the attacker or target is in it), wind (`weather.wind`), range (the band); the worst column, two at that level = one worse, two
  Heavy = −10 (`combineEnv`). Compensation (`attackSenses`): low-light (partial / dim light → 0), thermographic (visibility — not thermal
  smoke — and light one row up), ultrasound (visibility one row up, light ignored ≤ 50 m), flare compensation (glare), smartlink + smartgun
  (wind one row up). Range only → the range line as before; else one line « env. (portée, lumière) −N » (ranged weapons only, not melee).
- `attack/defend` (owner of the target, GM for NPCs) `{ attackId, options: ['dodge'|'parry'|'block'|'full'|'agile'|'acrobatic'|'perceptive'|'pretty'],
  situations: ['cover-partial'|'cover-good'|'running'|'prone'|'in-melee'|'vehicle'], modifier, explode }`: REA + INT + `defenseLines()` (one active
  defense, turn-long ones paid once, fire mode, action, area −2, reach difference, −1 per defense already made this Combat Turn). net ≤ 0 →
  `missed`; no damage code → `done`; else `soak` with DV + net hits. Dodge also works against ranged attacks (SR5 p. 191; Chummer's data lists it for melee only).
- `attack/soak` `{ attackId, modifier, explode }`: BOD + max(0, armor + AP); damage = DV − hits, Stun when the DV is below the modified armor
  (`finalDamageType`). GM: `attack/auto` (defense then soak without options), `attack/resolve { outcome: 'missed'|'damage', amount, type }`,
  `attack/clear { all?, blasts? }`, `attack/removeBlast` (also in the GM's cell menu), `attack/removeAffliction { actorId, afflictionId }`;
  attacker or GM: `attack/cancel`. A `toxin` attack's soak is the Toxin Resistance Test (BOD + WIL, no wound modifier): left = Power − hits →
  `toxinOutcome`: Stun / Physical damage (no armor) and `actor.afflictions` [{ id, kind, source, sourceEn, ts, until }] — 'disoriented'
  (−2 dice on every test but resistance tests: modifier type `allTests`), 'nauseous' (wound modifier ×2: `woundFactor`), 'incapacitated'
  (left > WIL, 3 Combat Turns; shown only). `pruneExpired` (shared/combat.js) drops ran-out blasts and afflictions at each attack, new Combat
  Turn and combat end; the sheet's Combat tab lists the afflictions (GM ✕). Speed is not delayed and Penetration does not lower protection.
- Player view: no attack on a hidden NPC, a hidden attacker's name is `?`, blasts of the shown map only, `myTurn` = their characters' turn record.
- Client: `ui.targetTokenId` (players: click another token; everyone: token menu « Cibler »), `ui.aimPoint` (cell menu « Viser ce point »); the map draws
  `scene.combatMarks` (reticle, aimed point + blast preview ring, attack arrows, blasts with DV rings — `renderer.drawCombatMarks`) and a target
  banner with « Attaquer » (RollDialog). RollDialog: « Action » / « Cible » / « Munition » for weapon attacks → `attack/roll`. The sheet's Combat tab
  lists the unlocked « Actions spéciales » (« Utiliser »). `AttackTray` (global): defend / soak prompts, results, GM shortcuts.

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
  weather?: { visibility: 0..3, wind: 0..3 },  // rain / fog and wind levels of the environmental modifier (absent = clear, no wind)
  regions: [{ id, name, x, y, w, h, color?, gmOnly?: bool }],   // labelled rooms/zones
  notes: [{ id, x, y, text, gmOnly: true }],                    // GM pins
  tokens: [Token],
  explored: { [userId]: string },   // fog-of-war memory (encoding owned by maps module)
  fog: true,                        // false = players see the whole map
  sharedVision: true,               // party shares what any PC sees
  movementLocked: false,            // GM freeze: players can't move tokens
  background?: { url, opacity },    // optional image underlay
  theme?: 'street'|'bar'|'corp'|'lab'|'industrial'|'residential'|'matrix'|'club',
  library?: { slug, version, linkedAt, syncedAt?, migrated? },   // copy of a server-wide library map, GM only (see « Map library »)
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
  availTest: 'required'|'helper'|'off', availFree: 0,   // availability test (below); items with Availability ≤ availFree need none
  categories: { [catalogFile]: bool },           // which catalogs are on sale
  specials: [{ id, name, category, cost, avail, stock, notes, stats?, catalogRef? }],   // GM-curated items / fixer deals
  orders: [{ id, ts, actorId, userId, by?, kind: 'buy'|'sell'|'give'|'karma', items: [{ ref, name, qty, rating?, unitCost, target?: { list, itemId, name }, mount?, subId?, karma?, techniqueIds?, availTest?: { id, hits, availHits, net, avail, baseHours, delayHours, tries, tie?, glitch?, contact?, overpay? }, surcharge? }], total, karma? (kind 'karma'), status: 'pending'|'approved'|'denied'|'done'|'cancelled', flags?: [string], gmNote?, resolvedTs? }],
  availTests: [{ id, ts, actorId, userId, ref, targetId?, name, avail, legality, availHits, hits, glitch, critGlitch, overpay?, logId, baseHours, tries, status: 'open'|'used', orderId?, contactId?, contactName? }],   // max 300; players see their actors' only
  restored?: [actorId],                          // historic Chummer upgrades already restored (GM view only)
}
```
**Availability test** (SR5 p. 418; pure rules `AVAIL_TEST_MODES / availTestable / needsAvailTest / availBaseHours / availOutcome / durationText / matchAvailTests` in `client/modules/shop/rules.js`, UI `client/modules/shop/avail.js`):
`'shop/availTest' { actorId, item: cart line, useSpec?, explode?, modifier? }` (owner or GM) rolls Negotiation + Charisma [Social] through `performRoll` (gear modifiers, wounds, Social limit, Edge; log entry `roll.avail = { testId, value, legality, dice, hits, baseHours, tries }`, `roll.labelI18n` « Disponibilité — {item} ») opposed by dice = the line's Availability, and stores the test. Net hits = hits − availability hits; delivery time = Delivery Times table by unit price (≤ 100 ¥ 6 h, ≤ 1 000 ¥ 1 day, ≤ 10 000 ¥ 2 days, ≤ 100 000 ¥ 1 week, more 1 month) ÷ net hits; a tie finds the item in twice the table time; a failure may retry after twice the table time (`retryHours`); a glitch is kept on the test / order line (`glitch`: unwanted attention, GM's call); a critical glitch never finds the item. The outcome is always recomputed from the log entry's live `hits` / `glitch` / `critGlitch` (Edge « Seconde chance »). Text checked against the core PDF (SR5 p. 418 « Black Market Goods », « Contacts and Availability »). **Overpay** (`overpay`: 0–12 dice, `clampOverpay`): +1 die per extra 25 % of the item's value offered (breakdown « surenchère +n », runner or contact roll); paid only when the item is bought: the claimed line gets `surcharge` = `overpaySurcharge(unitCost, dice)` per unit, included in the order total (unitCost / `paid` stay the item price, so resale ignores it), note « {item} : trouvé en {delay} (surenchère {cost}) »; the cart and the orders show « dont +{cost} ». `matchAvailTests` uses the cheapest search first. Not implemented: the Run Faster qualities Black Market Pipeline (+2 dice, −10 % via one contact) / Made Man (+1 die, −10 %). No test for fixer specials, lifestyles / lifestyle options or Availability 0; players cannot search what `checkRules` forbids. Failures are not time-locked (no game clock): the cart shows « nouvel essai après {2 × base} en jeu » and `tries` counts attempts. **Buying** (players only): `required` refuses a line without an unused successful test of the same `ref` + target with tested Availability ≥ the line's (one test per line, `matchAvailTests`, same matching in the cart); `helper` only records the tests it finds. Claimed tests go on the order lines (`availTest`, note « {item} : trouvé en {delay} ») and become `used`; a denied / cancelled order gives them back (`open`). GM sales and gifts never need one.
**Contact search** (`contactId` on `'shop/availTest'`): one of the runner's contacts makes the test instead, with their own Charisma + Negotiation (defaulting CHA − 1) and Social limit + the contact's Connection (`contactInfo`). Stats come from an NPC actor, else a bestiary template, whose name matches the contact's (accent/case-insensitive); a contact without one cannot search (« contact sans fiche », the GM creates the NPC). No runner Edge, specialization or gear on that roll; the log entry (author = the runner, `actorId: null`, `labelI18n` « Disponibilité — {item} (via {contact}) », `avail.contact`) and the test (`contactId`, `contactName`; order line `availTest.contact`) name the contact. Players get `view.shop.contactSearch = { [ownActorId]: [{ id, name, connection, known, source?, cha?, negotiation?, pool?, defaulting?, social?, limit? }] }` (the bestiary stays hidden). No fee or Availability cap: the GM adds a price by hand if wanted.
`'shop/cancel'` (owner or GM) cancels a pending order. Transient event `'shop:resolved'` `{ orderId, status, note }` is sent to the actor's owners when the GM approves/denies.
Selling: gear can only be sold up to its current `qty` (≥ 1); implant weapons (`augId`) are not sellable (sell the augmentation).
Catalog files (generated, `data/catalog/<name>.json`, loaded with `useCatalog(name)` client-side and read from disk server-side for price validation): `weapons`, `armor`, `gear`, `cyberware`, `bioware`, `vehicles`, `qualities`, `spells`, `powers`, `programs`, `lifestyles`, and the upgrade catalogs `accessories`, `armormods`, `vehiclemods`, `lifestylequalities`, `martialarts` (see « Shop: upgrades, lifestyles, martial arts » below). Each item: `{ id, name, nameFr?, category, cost: number|null, costFormula?: string, avail: '8R', availValue: 8, legality: ''|'R'|'F', availRelative?: true (upgrade catalogs: Chummer « +2R », added to the target's availability — `avail` keeps the « + »), rating?: { min, max }, essence?: number|string, source, page, stats: {...type-specific} }`. Buying adds the item to the actor (weapons → `actor.weapons`, armor → `actor.armor`, cyber/bio → `actor.augmentations` (and reduces ESS), vehicles → `actor.vehicles`, everything else → `actor.gear`) and deducts nuyen, appends `actor.history` and a `kind:'shop'` log entry.

#### Shop: upgrades, lifestyles, martial arts
Schema of the nested lists: « Lifestyles, accessories, mods, martial arts » above. Shop-installed sub-items also carry `paid` (price paid; resale value =
`paid`, else `cost`; included parts are worth 0 and never sold alone), accessories `extraMount` (mount points they add, e.g. slide mount), armor mods
`bonus` (`{ fire|cold|electricity|acid|falling|toxin|pathogen|radiation: n }` evaluated at the rating), vehicle mods `effects` (`{ handling, speed, accel,
armor, body, sensor, pilot, seats }` evaluated at the rating; never applied to the stored vehicle stats).
- **Catalogs** (tools/build-catalog.js; id = Chummer GUID, `nameFr` from `lang/fr-fr_data.xml`, same price/avail fields as the other catalogs).
  Formulas may use the TARGET's values (`rules.js quote(item, { vars })`, `evalFormula` accepts extra variables, `div`, `mod`): `WeaponCost`,
  `ArmorCost` + `Capacity`, `VehicleCost` + `Body Speed Handling Acceleration Pilot Sensor Seats Armor`; `stats.targetCost: true` flags them.
  - `accessories` (weapons.xml `<accessories>`): `stats { mount: ['Top','Under'] ([] = no mount needed), extraMount?, accuracy?, rc?, rcGroup?, conceal?,
    smartgun? (no Accuracy: +1 die wired / +2 wireless, a note), requires?/forbids?: { names?, namesContains?, categories?, categoriesContains?, types? } }`
    (any listed value matches; `*Contains` = Chummer `operation="contains"`, e.g. Shock Pad « Rifles », drone mods « Drones »; only name / category / type are
    read: a required OR group that also tests conceal / ammo / useskill / NOT… is dropped — it passes — and unknown forbidden conditions never forbid). Weapons gain
    `stats.mounts` (`<accessorymounts>`) and `stats.included: [{ id?, name }]` (accessories delivered with the weapon).
  - `armormods` (armor.xml `<mods>`, « Custom Liners » kept as « Armor Liners (Rating N) »): `stats { capacity: n | formula (Rating, Capacity), armor?, bonus? }`. Armors keep `stats.capacity`.
  - `vehiclemods` (vehicles.xml `<mods>`): `stats { slots: n | formula, ratingVar?: 'Body'|'Seats'|'qty' (max rating from the vehicle), bonus?, requires?/forbids? (same shape as accessories) }`.
    Vehicles gain `stats.modSlots` (drones: extra slots, one pool = Body + modSlots) and `stats.slotBonus { Powertrain|Protection|Weapons|Body|Electromagnetic|Cosmetic: n }`
    (`<xxxmodslots>`: other vehicles have one pool per category = Body + slotBonus[category], R5).
  - `lifestylequalities` (lifestyles.xml `<qualities>`: SR5 + Run Faster Garage, Workshop, DocWagon, Extra Secure…): `cost` (¥/month, may be < 0),
    `stats { multiplier? (%; baseOnly: Chummer <multiplierbaseonly>, % of the base only), lp, allowed?: [base lifestyles], multiple?, selectText?, comforts?, security?, neighborhood?,
    forbids?: [option names] / requiresOneOf?: [option names] (<forbidden>/<required> <oneof><lifestylequality>), requiresLifestyle?: [bases] }`.
    `lifestyles` gain `stats { lp, points: { comforts|neighborhood|security: [min, max] }, pointCost? }`.
  - `martialarts` (martialarts.xml, karma): `stats { karma (7; Way of Unified Mana 15), techniqueKarma: 5, techniques: [{ id, name, nameFr?, source, page }] }` (not in SHOP_FILES).
  - `data/catalog/coverage.md` = items per source book, Chummer XML vs catalog, with the dropped entries and why (regenerated by the build).
  - Every entry has `source` + `page` (📖 chips). Model-specific vehicle mods have no page in Chummer (« ? »: Enviroseal, Smart Tires…): the build
    gives them the page of the vehicle that ships them. Only 3 Chummer entries keep no page (Essence Hole / Antihole, HK MP75: « 0 » in Chummer).
- **Rules** (pure, `client/modules/shop/rules.js`, shared with the browser): `UPGRADE_FILES` (file → `{ list, sub }`), `STORE_SECTIONS` (= `SECTIONS` +
  `UPGRADE_SECTIONS` « Accessoires d’armes », « Modifications d’armure », « Modifications de véhicule », « Arts martiaux »; `SECTIONS`, used by the
  character creator, gains only the lifestyle options in « Train de vie »), `weaponMounts / freeMounts / accessoryFit` (mount points of the weapon —
  own `mounts`, else the catalog's (none when the catalog entry has no `<accessorymounts>`: bows, holdouts…), else standard ones for ranged weapons
  without catalog entry — minus mounts taken by non-included accessories; requires/forbids; no duplicate), `upgradeAvail(q, item, targetQuote)`
  (`availRelative`: + the target's availability, stricter legality), `armorCapacity / armorModFit` (capacity = `armor.capacity` › catalog › rating;
  Σ mod capacity ≤ capacity), `vehicleVars / vehicleSlotPool / vehicleSlots(vehicle, cat, pool) / vehicleSlotsUsed(vehicle, pool) / vehicleModFit`
  (`vehicle.slots` overrides; drones and vehicles without catalog entry: one pool 'all' = Body + modSlots; other vehicles: the mod's category pool
  `VEHICLE_SLOT_CATEGORIES` = Body + slotBonus[category]; « All », « Model-Specific » and drone-attribute categories take no pool → not limited),
  `vehicleModEffects`, `upgradeFields(file, entry, parent, { rating, parentCat, parentValue })` (sheet editor), `lowersRent(q)`, `MARTIAL_KARMA`,
  `martialKarma(style, known, n)`. `shared/lifestyle.js`: `monthlyCost`, `costBreakdown`, `isContract`, `settleLifestyles` (stores monthlyCost, one
  primary), `primaryLifestyle`, `lifestyleFromCatalog`, `qualityFromCatalog`, `qualityProblem(l, item, lookup?)` (allowed / required bases, duplicates,
  options forbidden by / required with the other options — lookup(catalogId) → catalog item also catches an existing option that forbids the new one).
  The client preview is `client/modules/shop/upgrades.js` (`upgradePreview`), the server stays the authority.
- **Actions**:
  - `shop/buy` / `shop/give` lines accept `target: { itemId }` (weapon / armor / vehicle / lifestyle id) for upgrade catalogs and `mount` (accessories);
    the lines of one order are checked together (two Barrel accessories refused). Prices: catalog formulas with the target's values; lifestyle options cost
    nothing up front except the rent difference × months already paid (`line.monthlyDelta`, `line.monthlyCost`), then change the monthly cost.
    Options that lower the rent (`lowersRent`: category 'Negative', negative cost or multiplier) bought by a player ALWAYS wait for the GM (whatever the
    approval mode; order flag `rent`, line `lowersRent`); the storefront shows « Validation MJ ».
    Upgrade lines are re-checked when a pending order is approved. GM gifts skip prices and legality, never the fit (mounts, capacity, slots).
  - Lifestyles: a `lifestyles` line (qty = months paid, `lifestyleName?`, `primary?`) ADDS a lifestyle (the first one is primary).
    `shop/payLifestyle { actorId, lifestyleId? (default: primary), months 1–24 }` pays that lifestyle's `monthlyCost` (upgrades included).
  - Bought weapons get `mounts` and their included accessories (`included: true`, mount 'Internal'); bought armors get `capacity`.
  - `shop/sell { …, subId }` sells an installed accessory / mod (sell rate × `paid`/`cost`); selling a weapon / armor / vehicle sells its installed parts with it.
  - `shop/removeUpgrade { actorId, list: 'weapons'|'armor'|'vehicles'|'lifestyles', itemId, subId }` removes without refund (players: own actor, not
    rent-lowering lifestyle options — category 'Negative' / negative cost or multiplier — nor built-in parts: GM only).
  - `shop/martialArt { actorId, styleId, techniqueIds, free? }`: karma (`martialKarma`) = the style's `stats.karma` (7; Hapsum-Do 15) for a new style
    (its first technique included, RG p.128) + 5 per further technique, 5 per technique of a known style — a known style without any technique
    (bought without, imported) still gets its first technique included. Players → pending order `kind: 'karma'` (one per style; the GM approves in « Commandes », karma spent
    then, history `karma: -n`); GM → granted at once (`free` = no karma). The training module does not handle martial arts.
- **Migration**: `normalizeActor` (characters) turns the old `actor.lifestyle` into `lifestyles[0]` (40-shop init has a safety net and recomputes every
  `monthlyCost`). `data/seed/upgrades-restore.json` (Lazarus pack, generated from `../Shadowrun_chum5_files`, historic) lists lifestyle options, weapon
  accessories and armor mods the PCs had in Chummer; 40-shop init applies it ONCE per actor (`shop.restored`), only to a lifestyle of the same name
  that has no option yet (its `baseCost` becomes the catalog base cost) and to weapons / armors found by catalogId or name (restored armor mods carry no
  `effects.armor`: the stored Foundry rating already counts them), with a history line « Options restaurées depuis Chummer : {n} ». The Lazarus seed
  actors (`data/seed/actors/pcs.json`) already contain it. Per actor: `actorName`, `chummerFile`, `chummerDate`, `note` (notes of every restored
  sub-item, « Restauré depuis Chummer (fichier du …) — à vérifier »), `lifestyleNote` (appended once to the primary lifestyle's notes: historic
  lifestyle NOT restored, Christopher), `inferred: true` (not from a Chummer file: Anthony's DocWagon deduced from his 7083 ¥ rent — never applied by
  the boot restore, only by `tools/restore-lifestyles.js --include-inferred`; the Lazarus seed already has it).
  GM-facing comparison: `../Shadowrun/historique-chummer.md`.
- **Restore on a running table**: `node tools/restore-lifestyles.js --url <server> [--table <slug>] --password <gm pw> [--dry-run] [--include-inferred]`
  applies the LIFESTYLE part of that spec through GM actions (`actor/updateItem` catalogId/base/baseCost, `actor/addSubItem` qualities,
  `lifestyleNote`): matches the actor by id then PC name, the lifestyle by name then the only/primary one; skips options already present (catalog id
  or name), never removes anything, never touches karma/nuyen/items, refuses a server without `actor.lifestyles`; inferred specs only with
  `--include-inferred`. After the boot restore it reports « Nothing to do ». Test: `node tools/test-restore-lifestyles.js` (ports 3290-3291).
- Tests: `node tools/test-shop.js` (port 3250: mounts, capacity, slots, target-based prices, resale of parts, martial arts, availability tests) and
  `node tools/test-lifestyle.js` (ports 3251-3252: cost math, migration idempotence, restore, lifestyle options, rent per lifestyle, permissions).

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
  tracks: [{ id, name, kind: 'ambient'|'music'|'sfx', source: 'synth'|'url', preset?: 'rain'|..., url?, tags?, credit? }],
  scenes?: [{ id, name, ambient, music, mapId? }],   // one-click presets
}
```
Music library: `data/assets/music/` (not in git, served at `/assets/music/`, credits in its `CREDITS.md`) = seed tracks `trk_lib_*` (tags: mood + artist), also shipped in the `vierge` pack. A seed scene may carry `replaces: { music: oldValue }`: on an existing table the channel is upgraded only if it still holds `oldValue` (the GM never changed it).
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
- `maps/*.json` — one Map per file (maps module). `maps/lib-<slug>.json` (Lazarus) = library instances for the campaign's locations
  (`map_lib_<slug>`, `map.library = { slug, version }`, GM notes), written by `node tools/maplib-campaign-seeds.js` (same build as
  `maps/fromLibrary`; choices in `../Shadowrun/cartes-campagne.md`, one fragmap per location); test `tools/test-maplib-campaign.js` (ports 3940-3941)
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
  Multi-table: `startServer({ port, tables: [{ id, name, pack, gmPassword, state? }] })` (no default table then), `login(url, { …, table: 'id' })`, `client(url, token, { table: 'id' })`, `await srv.admin()` → admin token, `startServer({ legacyState })` writes an old single-table `state.json`. Tests of this part: `tools/test-tables.js` (ports 3500-3599; `tools/test-modifiers.js` uses 3500 and `tools/test-bookrefs.js` 3530-3531 — don't run them at the same time).
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
- Gear may include weapon accessories and armor mods (`GEAR_FILES` + `accessories`, `armormods`; `CREATION_UPGRADES`): a draft gear row `{ ref, file, target: <weapon/armor row id>, mount? }` is priced with its target's value (`WeaponCost`, `ArmorCost`, `Capacity`, « +2R » availability) and fitted with the shop rules (`accessoryFit`, `armorModFit` of `client/modules/shop/rules.js`, passed in `ctx.rules`: mount points incl. the weapon's included accessories, capacity, duplicates). `buildActor()` gives weapons their `mounts` and included accessories (like a shop purchase), armors their `capacity`, then installs the upgrades (`paid`, `effects`, armor-mod `bonus`). UI: « Accessoires d’armes » / « Modifications d’armure » sections of the gear step, « Sur l’arme / l’armure » + mount pickers.
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

## Rulebooks (owner: `90-books.js`, `server/lib/books/`, UI `client/modules/books/`, English `client/i18n/en/books.json`)
The server owner's SR5 PDFs, readable by GM and players of the tables the admin allows: tab « Règles » (search, common
rules, library) and a global viewer drawer opened from anywhere. **Server-wide**, not per table, never in git.
```
<books dir> = SR_BOOKS_DIR, else <runtime>/books
  library.json        { books: [{ code (Chummer code: SR5, RG…), name, nameFr, file: '<CODE>.pdf', pages, offset, offsets?: [{ fromPrinted, offset }],
                        confidence (0..1, folio agreement), verified? (Chummer's reference sentence found on the right page), matchPdfPage?,
                        manual? (offset set by hand: a re-index keeps it), indexedAt, tables: 'all'|[tableId], size, extra? (not a Chummer book), source? }] }
  <CODE>.pdf          the PDF
  index/<CODE>.json   { v, code, pages, texts: [text of each PDF page], edges: [[numbers found in its header/footer]] }
<runtime>/books-sign.key  HMAC key of the PDF links (SR_BOOKS_KEY_FILE; per install, deliberately outside the books folder, which is copied
                          from the GM's PC to the VPS — an old books/.sign-key is deleted at first use)
```
- **Page numbers**: references everywhere are PRINTED pages (catalog `source`/`page`, Chummer). PDF page = printed + `offset`; `offsets` lists
  changes (printed page n uses the last entry with `fromPrinted ≤ n`), for books with unnumbered inserts. `server/lib/books/offsets.js`
  (`printedToPdf`, `pdfToPrinted`, `detectOffsets`) and the same helpers client-side in `client/modules/books/refs.js`. `printedToPdf` returns null for a
  page outside the book (never clamped to the last page: a bad reference shows « Page {page} introuvable dans ce livre »).
- **Detection** (`detectOffsets`): bare numbers in the top/bottom 8.5 % of each page vote for `pdfPage − n`; numbers printed on > 20 % of the
  pages are noise (kept as weak candidates that may only continue a run); each change of offset kept for ≥ 3 pages becomes a range, starting right
  after the last printed page of the previous range. Cross-checked with Chummer's reference sentence (`books.xml` `<match>`, names in
  `server/lib/books/book-names.json`, regenerate with `node tools/books-setup.js --names`).
- **CLI** `node tools/books-setup.js --from "<folder>" [--runtime <dir>|--books <dir>] [--only SR5,RG] [--map "file.pdf=CODE"] [--foundry <world>]`
  copies the PDFs (code guessed from the file name, never modifies the source), extracts with pdfjs-dist (legacy build, ≈ 20 s for 10 books),
  writes the index and library, prints a table (offsets, confidence, Chummer check, Foundry pdfoundry/pdf-pager hints) and runs the checks:
  known references (RG 62 Heritage, SR5 240 Hack on the Fly, SR5 310 Improved Reflexes/Kinesics, RF 221 Garage…), the « Règles » quick links
  (`client/modules/books/quicklinks.js`: each page must contain its heading) and catalog evidence (share of `data/catalog` items whose name is on
  the announced page; warns when a ±1–3 shift would score better). `--reindex [CODES]`, `--check`, `--list`, `--strict` (exit 1 on a failed check).
- **Routes** (any logged-in user of the table, `requireUser`): `GET /api/books` → `{ books: [{ code, name, nameFr, pages, offset, offsets?, indexed,
  extra?, url, exp, version, size }], ttl, now, pdfjs }` (books allowed for the requester's table whose PDF exists; `url` = signed PDF link; `now` = server
  clock in ms, the client judges expiry with it; `version` = base36 `size-mtime` of the PDF = the reader's cache key and the file's ETag; `size` = bytes,
  for the progress bar; `pdfjs` = `/vendor/pdfjs/<pdfjs-dist version>`), `GET /api/books/search?q=&code=` →
  `{ hits: [{ code, page (printed|null), pdfPage, snippet, marks: [[start, end]] }], total }` (accent/case-insensitive, every term required at a word
  start, "quoted phrases", capitals headings first, max 50; `code` of a book not allowed → 403), `GET /api/books/:code/page/:n[?pdf=1]` →
  `{ code, page, pdfPage, pages, text }` (page outside the book → 404 « Page introuvable »), `GET /api/books/:code/link` → fresh `{ url, exp }`.
  `/page` and `/link` answer the same 404 for an unknown book and a book not allowed for the table (no existence oracle).
  `GET /api/books/:code/file?k=…` = the PDF (`sendFile`: HTTP Range/206, `Cache-Control: private, max-age=86400`, strong `ETag: "<version>"` +
  `Last-Modified` → `If-None-Match` / `If-Modified-Since` 304 and `If-Range`, all checked AFTER the signature, `Content-Disposition: inline`,
  `nosniff`, `Referrer-Policy: no-referrer`; these PDF headers only on success: an error is JSON with `no-store`, an unsatisfiable Range a bare 416,
  a malformed Range is ignored → 200). `k` = base64url({ t: tableId, u: userId, s: sessionTag(token), c: code, e: expiry }) + HMAC-SHA256; expiry
  rounded up to the next UTC midnight + 24 h (`access.js` STEP = LINK_TTL = 86400: the same URL all day, valid 24-48 h → HTTP cache hits). No `k` → 401; bad signature, other book, expired, table archived/unknown, user
  removed, **session gone** (logout, kick, GM password change), book not allowed for that table → 403.
- **Admin** (`server/lib/books/admin-routes.js`, registered by `registerAdminRoutes`, admin bearer token): `GET /api/admin/books` (books + `indexed`,
  `present`, jobs, tables, known Chummer codes, max size), `POST /api/admin/books/upload?code=&replace=1` (body = PDF, streamed with `receiveToFile`,
  `%PDF-` checked, `X-Filename` URI-encoded) → background index, `PATCH /api/admin/books/:code { name?, nameFr?, offset?, offsets?, tables?: 'all'|[ids] }`
  (offset → `manual`), `POST …/:code/detect[?apply=0]` (re-run detection on the stored index; `apply=0` = preview for the edit dialog, saved only by
  « Enregistrer »), `POST …/:code/reindex { detect? }`, `DELETE …/:code { confirm: code }`. Upload cap `SR_MAX_BOOK_BYTES` (120 MB).
  Indexing runs in a `worker_threads` worker (`index-worker.js`, heap `SR_BOOKS_WORKER_MB`, `SR_BOOKS_JOBS` at a time, default 1) inside the server's
  process: a job (and an upload with a Content-Length) is refused with « Mémoire insuffisante… » (`jobs.js memoryVerdict`, error key + `errorParams`)
  when 6 × the PDF size exceeds the cgroup limit (`memory.max`, `SR_MEMORY_LIMIT_BYTES`) minus the server's RSS. pdfjs reads the file through a view
  (no second copy). Only the main thread writes `library.json`. Search folds texts with one regex replace (a char-by-char `+=` cost ≈ 300 MB of heap).
  UI: `client/modules/admin/BooksAdmin.js` (panel « Livres de règles » of `/admin`).
- **Client API** (`import { BookRef, openBook, parseSourceRef } from '../books/BookRef.js'`):
  `<${BookRef} source="RG" page="62" label? />` (also `source="SR5 p. 240"` or `source=${{ source, page }}`) renders a « 📖 RG 62 » chip (dashed when
  the book is not on the server) that opens the drawer; `openBook(code, printedPage)` / `openBook('RG 62')`; `parseSourceRef('RG 62' | 'SR5 p. 240' |
  { source, page })` → `{ code, page }` or null (a separator is required: « GH3 » is a code). `useBooks()` (store.js) = library list (links renewed
  10 min before expiry by a timer and before any page change, judged on the server clock: `serverNow()` = `Date.now()` + skew from `/api/books` `now`).
  `openBook()` with the list already loaded sets the page synchronously. `openBookPdf(code, pdfPage, { q })` (search hits: `q` is highlighted on that page).
  Viewer state: `nav` is bumped by every navigation request (the reader scrolls), `reportPdfPage()` = the reader's own scrolling (no bump).
- **Viewer** (`BookViewer.js`, in `globalComponents`, z-index 150 above the sheet modal): right drawer, resizable (width kept in `localStorage`
  `sr.books.width`), Esc closes it first (capture listener). A `.modal-backdrop` that appears after the drawer opened (MutationObserver; baseline reset
  by every `openBook*` through `viewer.raise`) puts the drawer behind it (`.behind`, z-index 90) and leaves Esc to that modal; book switcher, printed-page
  field + prev/next, zoom (− / % / +, the % toggles fit width ↔ fit page; kept in `localStorage` `sr.books.zoom`), « Texte » mode (extracted text of the
  page, with an « Ouvrir le PDF » link), new-tab link (browser's own viewer), search (this book / all books), ⚙ settings (zoom presets, mode, cache).
- **Reader** (in-app pdf.js, desktop and mobile): `PdfReader.js` (Preact shell: progress bar, errors, retry) → `pdfdoc.js` (loads pdf.js from
  `/vendor/pdfjs/<v>/build/` — or `legacy/build/` when the browser lacks `Promise.withResolvers` —, ONE open document kept across drawer close for
  10 min, `getDocument({ data, isEvalSupported: false, cMapUrl, standardFontDataUrl })`, a 403 download renews the links once) → `pdfview.js`
  (imperative: one box per page sized from the PDF, continuous scroll, only pages within 1.5 screens drawn — HiDPI canvas, devicePixelRatio ≤ 2,
  ≤ 16 Mpx — with a pdf.js `TextLayer` (selection, search highlights `.books-hl`), pages further away released (canvas freed, `page.cleanup()`),
  ≤ 10 drawn; Ctrl+wheel and two-finger pinch zoom around the pointer; page jumps scroll inside the same document, nothing is reloaded).
  Pure helpers (Node-tested): `readerlib.js` (fold/terms/matches, page tops, fit scale, zoom steps, canvas density), `cachepolicy.js`.
  pdf.js is served by `90-books.js` from `node_modules/pdfjs-dist` (only `{build,legacy/build}/pdf{,.worker}.min.mjs`, `cmaps/*.bcmap`,
  `standard_fonts/*.{pfb,ttf}`; `Cache-Control: immutable`, 1 year). **No CSP change**: the module worker is same-origin (`default-src 'self'` covers
  `worker-src`), fonts are `FontFace` objects, eval is disabled.
- **Book cache** (`bookcache.js`, rules in `cachepolicy.js`): each PDF is downloaded ONCE per browser (`fetch` + progress from Content-Length / `size`)
  and kept under the key `<CODE>@<version>` (never the signed URL). Backend: Cache Storage `caches.open('sr-books')` (fake request URLs
  `/__sr-books/<key>`, last use in `localStorage` `sr.books.used`) in a secure context (https, localhost); **IndexedDB** `sr-books` (stores `meta` +
  `data` = Blob) otherwise — the production URL `http://<ip>:8095` is not a secure context, `caches` is undefined there; nothing persistent when both
  fail (private mode: the open document still stays in memory). With a persistent backend the download is `cache: 'no-store'` (no second copy in the
  HTTP cache; `cachepolicy.js downloadOptions`); opening another book aborts the running download (`pdfdoc.js ensureDoc` AbortController). Store: other versions of that book dropped, then least recently used books evicted to
  stay ≤ 12 books / 600 MB (a bigger book is read but not kept; a quota error evicts the oldest and retries). Every fresh `/api/books` list drops
  entries whose code now has another version (`pruneStale`). « Vider le cache des livres » in ⚙ and under the Règles library (which also shows
  « en cache » per book, current version only). Measured (SR5, 41 MB, 502 pages, headless Edge, local server): first open ≈ 0.6-0.7 s to the first
  drawn page over loopback (on the VPS: the time to download 41 MB once), reopen from cache ≈ 0.45 s (Cache Storage and IndexedDB alike), page jump
  ≈ 0.05-0.15 s, 0 PDF requests after the first download, also after a full page reload.
- **Tests**: `node tools/test-books.js` (ports 3420-3439): hand-made 9-page PDF (cover, printed 1-4, unnumbered insert, printed 5-7, a constant
  « 3 » in every footer) → CLI install, offset ranges, auth 401/403 (forged expired / other table / unknown user keys / dead session after a GM
  password change), signing key outside the books folder, Range 206 / 416 / malformed, error headers, search, page text (out of range → 404),
  same 404 for restricted books, admin permissions, upload + background index, memory guard, manual offset / detect (preview `apply=0`), table
  restriction, delete; fold() equivalence + speed; reader: `version` / `size` / `pdfjs` in the list, same URL on every list call and for the whole day,
  ETag = version, 304 (If-None-Match, If-Modified-Since, never before the signature check), If-Range, new version + ETag when the PDF changes,
  pdf.js files served (JS MIME, immutable) and nothing else of the package; pure cache key / eviction / stale-version / backend choice, highlight
  matching, layout and zoom math.

### References everywhere (📖 chips)
Every game element a player or GM looks at links to its rulebook page.
```
shared/bookrefs.js        pure tables + parsers: SKILL_PAGES (skill id → SR5 page, Chummer skills.xml), RULE_REFS (limits SR5 46, derived SR5 101,
                          initiative 159, matrixInitiative 231, conditionMonitor / woundModifiers / armor 169, defense 188, soak 173, attributeTests 152,
                          movement 161, edge 56, drain 282, powerPoints 278, adeptPowers 308, spellcasting 281, complexForms 252, matrixDamage 228,
                          biofeedback 229, matrixActions 237, programs 245, ic 248, knowledgeSkills 147, lifestyles 369, martialArts RG 128,
                          priorityTable 65, karmaAdvancement 103, initiation 324, submersion 257…), CHARGEN_STEP_REFS (creator steps, SR5 62-100),
                          COMPLEX_FORM_PAGES / complexFormRef, ITEM_CATALOGS / SUB_CATALOGS (catalog files of each actor list), REF_LISTS,
                          itemRef(item), normRef(source, page), parseRefText('SR5 p. 435'), refFromNotes('Name · SR5 66'), skillRef, ruleRef
server/lib/bookrefs.js    catalog index (id → ref, folded EN / FR names per file, techniques included; global read-only data),
                          resolveItemRef(list, item, sub?, { sourceText? }), fillItemRef, fillActorRefs(actor, { sources? }) → n filled
client/modules/books/BookRef.js   <BookRef>, <ItemRef item />, <RuleRef rule="limits" />, <SkillRef id="pistols" /> (nothing without a reference)
```
- **Item references**: `item.source` (book code) + `item.page` (printed page; absent when unknown). Resolution order (`resolveItemRef`): the
  item's own reference › catalog id › the import's own source text › « CODE page » in the notes (Foundry « Low-Light Vision · SR5 66 », Chummer
  « SR5 p.71 — … », upper-case code required) › complex form table › English / French name in the list's catalogs (also without « (…) » and a
  rating suffix: « Cyberyeux 2 (vision nocturne) » → Cybereyes; weapons also look in gear and armor: grenades, shields) › « Mains nues » /
  Unarmed Attack → Unarmed Combat SR5 132. GM-typed French items without a catalog match stay without chip.
- **Filled** (idempotent, never overwrites an existing reference): characters init (every actor at boot — one-time backfill of old tables),
  `actor/create`, `actor/addItem`, `actor/addSubItem`; shop orders / martial arts / Chummer restore (40-shop); training (`advance()`); chargen
  `buildActor`; bestiary `sanitizeTemplate` (+ combat init for stored templates; npcgen previews and templates go through it); Chummer import /
  re-import (`parse.js` stores `<source>`/`<page>` on items and nested items, 85-chummer fills the rest); Foundry import (`convertSheet` returns
  `itemSources { [appItemId]: system.description.source }`, applied by `buildPc` / `buildTemplate` AFTER the merge snapshot: converted items carry no
  source, so item hashes and « unchanged » detection are not affected). GM edits: `sanitizeItem` / `sanitizeSub` keep `source` (≤ 12 chars) and `page` (int).
- **UI**: sheet — Résumé / Combat / Magie / Matrice stat boxes carry their rule chip in the corner (`RollStat book={ruleRef(…)}`, outside the roll
  button), section titles (condition monitors, Edge, derived values, adept powers, lifestyles, martial arts, knowledge), every item row (weapons,
  armor, implants, gear, vehicles, qualities, powers, spells, complex forms — new table in the Matrice tab, also shown without a device —, martial
  arts, lifestyles) and nested chips (accessories, mods, options, techniques), skills (SR5 page of each skill), programs (programs catalog), GM catalog
  picker; roll dialog (skill / test rule, limits, Edge, modifier lines); item effects only repeat the chip for nested items; shop list rows, item
  detail, inventory, martial arts; training (rule « ? » + SR5 103 / 324 / 257, skills, qualities, spells, powers, complex forms); creator (step header,
  priority table, catalog pickers, gear, spells, powers, qualities, skills, complex forms); Matrix (action list + dialog page, skill, pool parts with a
  source, programs, IC); bestiary / enemy generator stat blocks (weapons, spells, skills, armor, implants, powers, qualities, gear, vehicles).
  Chip title « Ouvrir Run & Gun p. 62 » (« Livre non disponible sur ce serveur (RG p. 62) » + dashed chip when the book is absent).
- **Tests**: `node tools/test-bookrefs.js` (ports 3530-3531): every catalog entry / technique has a parseable reference of a known Chummer book
  (client parser agrees), SR5 skill / rule / creator-step pages checked against the SR5 text index when present, parsers, seed PCs fully resolved
  (fill idempotent), bestiary items with a catalog id resolved, Chummer and Foundry imports (snapshot items without source), boot backfill of an
  old table, GM catalog add / nested add / GM override, shop gift, martial art, training, bestiary template.

## Modifiers (gear, clothing, qualities, adept powers, implants → rolls, limits, derived values)
Chummer `<bonus>` / `<wirelessbonus>` data makes items count like in a real VTT: Jane wears « Zoé : Heritage 12 » (RG 62: +2 social limit while
visible) → her Con test shows « Limite sociale 9 + Zoé : Heritage 12 +2 = 11 » when « Tenue visible » is on, and the sheet shows « 9 (11 si visible) ».
```
tools/lib/bonus-effects.js   Chummer XML <bonus> node → normalized effects (pure; build time)
tools/build-catalog.js       catalog entries get `effects`; writes data/catalog/effects.json (runtime index) + effects-coverage.md
shared/modifiers.js          collectModifiers / poolModifiers / limitFor / weaponAccuracy / derivedWithModifiers (pure, server + browser)
server/lib/modifiers.js      effects index (global read-only catalog data), actorModifiers(actor, { weaponId }), deriveFull(actor)
client/modules/sheet/modifiers-ui.js   useEffectsLookup / useModifiers / useDerivedModifiers, effect texts, chips with 📖 BookRef, tooltips
```
- **Catalog effects** (`entry.effects` on every catalog file whose XML has a bonus: armor, armormods, gear, cyberware, bioware, qualities, powers,
  accessories, lifestylequalities, spells, martial-art techniques): `Effect = { type, target?, value (number | formula with Rating: 'Rating', '-Rating',
  'FixedValues(1,2,3)', 'Rating * 2'), condition? (key), choice? ({ kind: 'skill'|'text'|'matrixAction'|'attribute'|'limit', limitTo?, categories? }),
  wireless? (from <wirelessbonus>), tag (Chummer tag) }`. Types: `limit` (limitmodifier, physical/mental/social/astrallimit), `skill` (specificskill,
  spellcategory focus, selectskill with a value), `skillCategory`, `skillGroup`, `skillAttribute` (skillattribute / skilllinkedattribute), `attribute`
  (specificattribute val / selectattribute), `attributeMax`, `initiativeDice` (initiativepass), `initiative`, `matrixInitiativeDice`, `armor`, `monitor`
  (conditionmonitor: physical / stun / overflow / threshold / thresholdOffset (each track) / sharedThresholdOffset (Damage Compensators: both tracks
  together, Physical first)), `stat` (damageresistance → soak, composure, memory, liftandcarry,
  dodge / defensetest → defense, judgeintentions (+ offense / defense), reach, unarmeddv / unarmedap, drain / fading / fatigue resist, surprise,
  spellresistance, recovery, throw…), `resist` (toxin / pathogen / fire / cold… resistances and immunities: shown only), `accuracy` (weaponskillaccuracy,
  weaponaccuracy), `matrixAction` (Codeslinger), `flag` (smartlink, unarmed physical), `choice` (selecttext / selectskill without a value), `info`
  (addweapon). Any other tag → `{ type: 'unsupported', tag }` (kept on the catalog entry, never silently dropped). `data/catalog/effects-coverage.md` =
  tag → supported / unsupported counts, effect types, and every **condition** key with Chummer's FR / EN strings (`lang/*.xml` `LimitCondition_*`) and
  the app's labels. Index `data/catalog/effects.json` = `{ files: { [file]: { [catalogId]: { name, nameFr, source, page, effects } } }, names: { [file]:
  { [lower-case EN / FR name]: id } } }` (runtime effects only: no unsupported / info / free-text choices / tag names; techniques under `techniques`).
- **Conditions** (`shared/modifiers.js CONDITIONS`): Chummer `LimitCondition_Visible` → `visible`, `LimitCondition_IntimidationVisible` →
  `intimidation-visible`, free-text conditions → `t-<slug>` (`t-urban`), spellcasting foci → `spell-<category>`. Each has a French label (« si visible »,
  English in `client/i18n/en/sheet.json`), optional restrictions that make it apply to some tests only (`skills`, `groups`, `exclude`, `attrs`,
  `knowledge`, `matrixActions`, `mode`) and a **switch** (`toggle`): `null` = automatic; several conditions share one switch (every « must be visible »
  outfit → `visible`); unknown keys become their own switch (never applied silently). Wireless bonuses also need the `wireless` switch. Switch labels:
  `TOGGLE_LABELS` (« Tenue visible », « Bonus sans fil actifs »…). `conditionState(key, ctx, toggles)` → 'na' | 'auto' | 'on' | 'off'.
- **Sources** (`collectModifiers(actor, lookup, { weaponId? })`): EQUIPPED armor and its mods — like `armorTotal()`, one outfit at a time: only the best
  non-stacking worn armor plus the `stack` pieces (`equipped !== false`; armor « Rating » formulas use
  `armor.itemRating` — `armor.rating` is the armor value), augmentations (rating; not `disabled`), qualities, adept powers (Rating = `level`), gear with
  `active: true` (players may toggle it on their own gear; the sheet shows an « actif » switch on gear whose catalog entry has effects; default off),
  martial-art techniques, and with `weaponId` that weapon's equipped accessories (`effects.dicePool` → `weaponPool`). Items are matched by `catalogId`,
  else by English / French name (Foundry imports), also without a trailing « (…) » / « R4 ». `Modifier = { id ('list:itemId[:subId]:i'), source: { list,
  itemId, subId?, name, nameFr?, parentName?, catalogId?, book, page }, type, target, value (number, Rating resolved), condition, wireless?, baked?, info?,
  needsChoice?, choice?, immune? }`. `select…` effects target `item.choice` (Chummer `<extra>`, stored by the Chummer import; the GM sets it in edit mode,
  « Choix (effet) »: a skill name or id, a Matrix action, an attribute, a limit) — without a choice they are shown, not applied.
- **No double counting**: attribute bonuses and initiative dice / score bonuses (`attribute`, `initiativeDice`, `initiative`) are already STORED on the
  actor — `actor.augmented` / `actor.initiative`, filled by `server/lib/augment.js` (shop, sheet, training: `augmentations[].bonus`, `powers[].bonus`),
  by the Foundry import (active effects + known boosts, `convert-actor.js`) and by the Chummer import (`<totalvalue>` and improvements, `parse.js`). They
  are `baked: true` only when really stored: the item records it (`item.bonus`: `server/lib/augment.js bakeItemBonus` from the catalog effects — sheet
  `actor/addItem` / `updateItem` of augmentations, powers, qualities; shop; training; creator; enemy generator — initiative score and « select attribute »
  included), the item comes from an import (`fvtt_` id / `chummerGuid`: `importedItem()`), or the stored value still has room for it (hand-made
  templates). Otherwise `unbaked: true`: shown « non compté (à reporter par le MJ) », never added. Everything else is stored nowhere and is applied:
  skill ratings, limits, monitors and armor ratings of both imports are base values (Foundry armor `rating` = `armor.base`; Chummer monitors are
  recomputed). An `actor.monitors` override wins over monitor bonuses (shown « ignoré : valeur forcée ») and is kept as is: 0 = no such track (grunts,
  drones: stun damage goes to Physical; hosts). Imported unarmed / thrown weapons keep `accuracy: 'Physical'` (± n), never a frozen number.
- **Helpers**: `rollContext(actor, { skillId?, attr?, attr2?, test?, weaponId?, actionId?, mode? })`; `poolModifiers(mods, ctx, { conditions, ignore,
  isGM })` → `{ lines: [{ mod, value, state: 'applied'|'off'|'ignored'|'info', toggles }], total, toggles }`; `limitFor(actor, name, mods, ctx, opts)` →
  `{ base, total, lines, toggles, alt, altConditions }`; `weaponAccuracy(actor, weapon, mods, ctx, opts)` (Accuracy or « Physical » + equipped accessories'
  `effects.accuracy` + accuracy effects); `derivedWithModifiers(actor, mods)` = `derive()` + monitors (physical / stun / overflow), wound modifier (pain
  tolerance), armor (implants, powers: Mystic Armor), soak, defense, composure, judge intentions, memory, lift / carry, limits (unconditional) +
  `limitsAlt` / `limitsAltConditions` (value with the switches on), matrix initiative dice, and `sources[key]` (`limit.social`, `armor`,
  `physicalMonitor`, `initiative`, `attr.REA`…) for tooltips. `cleanConditions(mods, list)` keeps only the switches this actor's modifiers use.
- **Rolls (server authority)**: `dice/roll` recomputes the pool and the limit with `actorModifiers()`; the client only sends `conditions` (switches on,
  filtered by `cleanConditions`) and `ignore` (modifier ids to leave out: players may only drop bonuses, the GM anything). Any other client field
  (`mods`, `effects`…) is ignored; a player's `limit` above the computed one, `null` or 0 gives the computed one; `test` is checked against its
  attributes (`checkedTest`), a weapon roll uses the weapon's skill, `matrixLimit` only applies to Matrix skills, the wound modifier is forced for
  players (except damage resistance), player `bonus` lines are recomputed or counted as « mod. », and the Matrix switches « en RV chaude » /
  « dans un hôte » come from the actor's persona (mode, `hostId`; the GM keeps them for an actor without persona). `roll.mods = [{ id, kind: 'pool'|'limit', type, name,
  nameFr?, value, state, condition?, wireless?, book?, page? }]`, `roll.limitBreakdown` (« sociale 9 + Zoé : Heritage 12 +2 »), `roll.conditions`. Soak
  (`test: 'soak'`) adds the armor with its modifiers itself; weapon attacks (`weaponId`) use `weaponAccuracy` and the accessories' dice; Matrix tests
  from the sheet (`matrixLimit`) use the device attribute. Damage, status and combat (`30-combat.js`: initiative dice, incapacitation, wounds) use
  `deriveFull()`.
- **Matrix**: `shared/matrix.js actionPool(…, { mods, conditions })` adds skill / linked-attribute / Codeslinger dice (`modLines`, parts with their
  source); `matrixInitiative(actor, persona, mode, mods)` adds matrix initiative dice (max 5D6). `45-matrix.js` passes the decker's modifiers (never the
  agent's) and `p.conditions`; damage monitors use `deriveFull`. Matrix limits are the deck's attributes: no physical / mental / social modifier applies.
- **UI**: `RollDialog` (preset `test`, `weaponId`, `matrixLimit`) lists every modifier of the test with its source and 📖 chip (players can uncheck a
  bonus), the switches that change something (« Tenue visible (+2 Limite sociale) », remembered per actor in `localStorage['sr.rollToggles.<actorId>']`,
  guarded) and the limit breakdown; the Matrix « Lancer » dialog shows the same switches. Sheet: limits « 9 (11 si visible) » with a source tooltip,
  initiative / monitors / armor / soak / composure… with their sources, effect chips under armor, implants, qualities, powers and gear, gear « actif »
  switch; GM edit mode: « Choix (effet) » on qualities / powers / implants / gear / armor, « Indice (objet) » on armor, « Actif » on gear. The log shows
  the applied modifiers of a roll with their 📖 chips; the limit badge's tooltip has the limit breakdown.
- **Not automated** (shown, or left to the GM): resistances / immunities, reach / unarmed DV, attribute maximums, karma / chargen tags (unsupported),
  « Too Pretty To Hit » (empty `<bonus>` in Chummer: no data). Situational conditions without restriction (« avec la corpo concernée, si visible »)
  are their own switch.
- **Tests**: `node tools/test-modifiers.js` (port 3500): the normalizer on real Chummer entries (Heritage 12, Chameleon Suit, Improved Reflexes,
  Kinesics, Muscle Replacement, Synaptic Booster, Tailored Pheromones, Codeslinger, Dimmer Bulb, Toughness / Will to Live / Catlike, Fire Resistance,
  Spellcasting Focus), the Lazarus PCs (Jane's Con: pool 14 / 16 with Seduction, social limit 9 → 11 « visible »; Improved Reflexes baked; Ank'Lay's
  ware baked; Bricks' Codeslinger), monitors / pain tolerance, chargen accessories / armor mods, and the server authority (no injected modifier, maluses
  kept, limit not raised, weapon / soak / Matrix limits, gear switch, GM sub-item edits keep `paid` / `extraMount` / `bonus`), and the review
  regressions: monitor override 0, baked / unbaked bonuses + stored GM additions (Improved Reflexes, Move-by-Wire, Lightning Reflexes), Damage
  Compensators, one outfit, test claims, wounds, weapon skill, matrixLimit, limit removal / floor, player bonus lines, persona switches, imported
  « Physical » accuracy.
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

## Map library (owner: `server/lib/maplib.js`, `server/lib/maplib-admin.js`, `server/lib/maplib-thumb.js`, `server/modules/22-maplib.js`, `shared/maplib.js`, UI `client/modules/map/LibraryBrowser.js` + `maplib-client.js`, `client/modules/admin/MaplibAdmin.js`; English in `map.json` / `admin.json`)
Raw fragmaps (image + walls/doors/lights/regions, no tokens, no fog) are **server-wide**: every table can use them. A table works on its own
**instance** (an ordinary table Map), so tokens, fog, door states and GM edits never leak between tables. Only fragmaps go to the library:
custom-made maps may be spoilers and can never be published (no `map.library` → refused).
```
data/maplib/<slug>.json      IN GIT — one library map: { id: 'lib_<slug>', slug, name (EN), nameFr, source: 'fragmap'|'fragmaps-free',
                             image (file in <maplib>/images) | imagePath (relative to data/assets, e.g. foundry/scenes/x.jpg), imageW, imageH,
                             gridPx (px per cell, float ok), offsetX, offsetY (px of the grid origin), width, height (cells), metersPerCell, theme,
                             lighting, tags [FR+EN], description (FR), walls [{ id, x1, y1, x2, y2, move, sight, door: null|{ state, kind } }] (CELL
                             units from the grid origin), lights [{ id, x, y, radius, color, on }], regions [{ id, name, x, y, w, h, gmOnly: false }],
                             entry?: { x, y }, traced: { by, at, quality: 'good'|'rough', notes }, version }   (folder: SR_MAPLIB_SOURCE)
<maplib> = SR_MAPLIB_DIR, else <runtime>/maplib        PER SERVER, never in git (on the PC <runtime> = data/, so it sits next to the git files)
  library.json               { version: 1, settings: { publishAdminOnly }, maps: { [slug]: Meta } } — Meta = descriptive fields + geometry + version
                             (current revision), origin: 'git'|'seed'|'edited'|'upload', originRef { kind, file, hash }, overrides (admin names/tags…),
                             gitNewer?, deleted? (tombstone), counts, versionInfo { at, by }, history: [{ version, at, by, origin, counts }] (5 kept)
  entries/<slug>.json        { slug, versions: { [n]: { walls, lights, regions, entry?, geometry } } } — current + the 5 previous versions
  images/<file>              artwork (tools/maplib-build.js copies it from ../fragmap, or an /admin upload) — the owner's paid content
  thumbs/<slug>.jpg          ≤ 480 px JPEG (tools/maplib-build.js, or an /admin JPEG upload). Also accepted: thumbs/<slug>.webp|.png and
                             thumbs/<image file name>[.jpg]; migrated Foundry scenes fall back to their Foundry thumbnail (thumbPath).
<runtime>/maplib-sign.key    HMAC key of the image links (SR_MAPLIB_KEY_FILE) — outside <maplib>, which is copied PC → VPS
```
- **Boot sync** (`ensureLibrary()`, once per process, from the first table init): every git file is applied — a new slug → version 1 (origin
  `git`); an entry still following its source (`git` / `seed`) whose file hash changed gets a new version; an `edited` (published / rolled back)
  or `upload` entry never gets git walls (its descriptive fields still follow git, and `gitNewer` makes /admin show « git plus récent »).
  Admin `overrides` (names, tags, description, theme, lighting) always win. Deleted entries are tombstones: git does not bring them back.
- **Foundry fragmaps-free migration**: `data/seed/maps/foundry-*.json` whose image is one of the 26 fragmaps-free images (`FRAGMAPS_FREE`,
  lower-case file names, with French name / tags / description) become entries (origin `seed`, `imagePath` = the existing `foundry/scenes/<file>`,
  grid from the « Image W×H px » line of the map description). Custom Foundry maps (Club House, Garage, Seattle, appartement…) stay out.
  Every table init runs `linkTableMaps` (idempotent): a table map showing such an image gets `map.library = { slug, version, linkedAt, migrated: true }`
  (no entry for that image yet → one is made from that map); the table data (walls, background URL, tokens, fog) is untouched.
- **Instances**: `map.library = { slug, version, linkedAt, syncedAt?, migrated? }` on a table Map, stripped from player views.
  - `maps/fromLibrary { slug, name?, folder? = 'Bibliothèque' }` (GM) → map id. Name = `nameFr` (French table) / `name`; `background = { url:
    '/api/maplib/image/<slug>', mode: 'image', x: -offsetX/gridPx, y, w: imageW/gridPx, h }`, tiles all floor, walls / lights / regions copied with
    fresh ids, `entry` → a GM-only region « Entrée » (id `libentry_…`, found by `maps/placePCs`).
  - `maps/libraryDiff { mapId }` → `{ slug, name, nameFr, current, latest, diff: { walls|doors|lights|regions: { add, remove }, resized, width, height,
    keptDoorStates, same }, publishAllowed, migrated }` (`add` = only in the library, `remove` = only in the table map).
  - `maps/libraryUpdate { mapId }` → `{ version, diff }`: walls / doors / lights / regions from the latest version; tokens, GM notes, fog (remapped
    when the size changes), GM-only regions, the background URL, door states (+ names) of doors at the same position and light switches are kept.
  - `maps/publishToLibrary { mapId, force? }` → `{ version }`: walls (doors closed, door names dropped), lights and public regions become a new version
    (shifted back when the map was moved against its image); tokens, notes, fog and GM-only regions are never published. Refused for maps without
    `map.library`, when /admin reserved publishing to the admin, and when the library moved past the map's version (error key « La bibliothèque a
    changé depuis ta dernière synchronisation… »; `force` overrides — the replaced version stays in the history). Logs a GM-only line.
  - `maps/libraryUnlink { mapId }` → an ordinary table map again.
- **Routes**: `GET /api/maplib/key` (any logged-in user) → `{ k, exp, ttl, now }`; `GET /api/maplib` (GM) → `{ maps: [{ id, slug, name, nameFr, source,
  tags, description, theme, lighting, width, height, metersPerCell, gridPx, quality, version, counts, origin, updatedAt, thumb, hasImage, hasThumb }],
  settings }`; `GET /api/maplib/:slug` (GM) → the same + `walls, lights, regions, entry, geometry`; `GET /api/maplib/image/:slug?k=` and
  `/api/maplib/thumb/:slug?k=` are the only way to the files (no static route, no listing). `k` = base64url({ t: tableId, u: userId, s: sessionTag(token),
  e }) + HMAC-SHA256 (the rulebooks' scheme, own key, `maplib:` prefix), one key for every library image, expiry rounded up to 30 min + 1 h; or
  { a: 1, s: admin session tag, e } for /admin. No `k` → 401; bad signature, expired, unknown / archived table, removed user, dead session (logout,
  kick, GM password change), dead admin session → 403. Success: `Cache-Control: private, max-age=3600`, `nosniff`. Missing file → 200 grey SVG
  placeholder (`X-Maplib-Missing: 1`, `no-store`). Deleted entries keep serving their image (instances made from them still need it).
- **Admin** (`/api/admin/maplib…`, admin bearer): `GET` (entries + history, overrides, files, `usedBy: [{ tableId, tableName, maps: [{ id, name, version }] }]`),
  `GET /key`, `PATCH /settings { publishAdminOnly }`, `PATCH /:slug { name?, nameFr?, tags?, description?, theme?, lighting? }`, `DELETE /:slug { confirm: slug }`,
  `POST /:slug/rollback { version }` (old content → new version), `POST /:slug/revert` (git file, else the Foundry seed scene; follows git again),
  `POST /:slug/publish { tableId, mapId, force? }` (« Publier depuis une table »), `POST /upload?slug=&name=&nameFr=&gridPx=&offsetX=&offsetY=&source=&replace=1`
  (body = JPEG / PNG / WebP, `X-Filename`, streamed, header-checked, ≤ 160 × 160 cells, `SR_MAX_MAPLIB_IMAGE_BYTES` = 60 MB; a new entry without walls,
  or a new version with the new grid for an existing slug; JPEGs ≤ 40 MP get a thumbnail made by `maplib-thumb.js` in a worker thread).
- **Client**: the GM « Cartes » page has tabs « Cartes de la table » / « Bibliothèque » (search in FR/EN names + tags, filters ambiance / source / tracé,
  thumbnails, « Aperçu » = the real renderer (`MapCanvas`) on a throwaway Map with the walls shown, « Ajouter à cette table »). Library-linked cards carry
  a « Bibliothèque » badge (amber ↑ when a newer version exists) and a « Bibliothèque… » button (also in the editor header) → `LibraryLinkModal`
  (diff, update, publish, detach). `renderer.js getImage()` loads `/api/maplib/…` URLs with the signed key of `maplib-client.js` (`ensureLibKey()`,
  renewed 10 min before expiry; the image cache stays keyed by the bare URL, so a renewed key never reloads an image). Players see nothing new
  (only the image of the shown map).
- **Tests**: `node tools/test-maplib.js` (ports 3910-3912): shared helpers, boot seeding from a fixture git folder + the Foundry seeds, image auth
  (401 / 403, forged / expired / dead-session keys, admin key, no listing, placeholder), instances in one table only, player view without `library`,
  publish (version + history, nothing private published), update keeping tokens / notes / fog / door states, stale publish + force, admin-only
  setting, custom maps refused, rollback, revert, rename, delete, upload + thumbnail, map_fvtt_* migration idempotent across restarts, git updates
  vs edited entries.
