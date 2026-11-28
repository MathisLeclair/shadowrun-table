# Architecture & module contracts

The core of the app: how the process is laid out, the contracts a server module and a client component must follow,
how state is saved and turned into per-user views, how requests find their table, and the security rules. Feature
details are in [`modules/`](README.md#features); the data model is in [data-model.md](data-model.md).

Real-time web app for running Shadowrun 5E campaigns (« Project Lazarus » first). One Node server (the GM's PC or a
VPS) hosts one or more **tables** (independent campaigns, see [multi-table hosting](modules/multi-table.md)); the GM
and players connect from a browser. **The UI is bilingual: English is the source text, French comes from
dictionaries** — every user-facing string goes through `t()` (see [i18n.md](i18n.md)). Code comments/identifiers in
English.

## Process layout

```
app/
  server/index.ts        core: HTTP, auth, Socket.IO, action dispatch, per-user views, tables (core-owned)
  server/store.ts        per-table state persistence, table scope (AsyncLocalStorage)   (core-owned)
  server/lib/tables.ts   table registry (server.json), migration, admin password        (core-owned)
  server/lib/admin.ts    /api/admin/* server administration routes                     (core-owned)
  server/lib/zip.ts      streaming zip reader/writer, streamed uploads                  (core-owned)
  server/errors.ts       ActionError                                                    (core-owned)
  server/modules/NN-x.ts feature modules, auto-loaded in filename order (table below)
  shared/types.ts        data model types: state, view, actors, maps, catalog, server module contract
  shared/util.ts         uid(), clamp(), deepClone(), nuyen(), slug()                   (core-owned)
  shared/sr5.ts          SR5 rules: attributes, SKILLS, derive(), rollDice(), skillPool() (core-owned)
  shared/*.ts            other pure modules usable by server AND browser (no Node/DOM APIs):
                         vision.ts (maps), advancement.ts (training), matrix.ts (Matrix rules), chargen.ts (priority creation),
                         npcgen.ts (enemy generator), combat.ts (attacks), modifiers.ts, lifestyle.ts, home.ts, sins.ts,
                         contacts.ts, bookrefs.ts, maplib.ts
  client/index.html      page shell, loads app.tsx (Vite)                               (core-owned)
  client/app.tsx         shell: login, top tabs, right dock, sheet modal, toasts         (core-owned)
  client/styles.css      global theme + shared classes                                   (core-owned)
  client/lib/net.ts      useGame(), send(), on()/useServerEvent(), api(), upload(), useCatalog() (core-owned)
  client/lib/ui.tsx      UI kit, typed React components (Button, Panel, Modal, Tabs, Field, TextInput, NumberInput, Select, Toggle, Badge, Empty, SearchBox, Markdown, Stat, confirmAction, promptText, cx) (core-owned)
  client/lib/ui-store.ts useUI(), setUI(), openSheet(actorId), goTab(id), toast(text, kind), useLang() (core-owned)
  client/lib/i18n.ts     t(), tn(), tk(), tIfKnown(), logText(), errorText(), SR5 label helpers, formatting   (core-owned)
  client/i18n/format.ts  pure i18n core (interpolation, plurals) shared by client, server and tools   (core-owned)
  client/i18n/fr/*.json  French dictionaries, one per area { "english": "français" }    (legacy-fr-keys.json: old saved French keys)
  server/lib/i18n.ts     server t()/tn() for the table language, errorBody(), normalizeLogEntry()   (core-owned)
  client/lib/markdown.ts renderMarkdown()                                                (core-owned)
  client/modules/registry.ts  which component is which tab                              (core-owned — DO NOT EDIT)
  client/modules/<feature>/…  feature UI
  data/seed/…            initial content merged into state at boot (by id, never overwrites)
  data/catalog/*.json    gear catalog generated from Chummer data (tools/build-catalog.ts)
  data/packs/<pack>/     other content packs (same layout as data/seed; « vierge » built by tools/build-packs.ts)
  data/server.json       table registry (runtime, do not commit)
  data/tables/<id>/      one table: state.json, backups/, uploads/, docs/, assets/, foundry/ (runtime, do not commit)
  tools/                 offline scripts (catalog build, checks, tests)
```

Client delivery (see [AGENTS.md](../AGENTS.md) « Commands »): `npm run dev` runs Vite as middleware inside the server
(hot reload); `npm run build` writes `dist/client/`, which `npm start` serves when present (without a build it answers
« Client not built »). `client/i18n/` is served from `client/` in every mode. **React 19 + TypeScript (JSX in
`.tsx`), hooks.** The whole app is TypeScript: the server and `shared/` run in Node directly (type stripping, no
build), the client is bundled by Vite. Types of the data model: `shared/types.ts`. Import paths in client code are
**relative** (`../../lib/ui.tsx`) or absolute for shared (`/shared/sr5.ts`). Server imports shared with
`../../shared/sr5.ts`.

Run: `npm start` (port 3000, or `PORT=xxxx`). A fresh install has one table « lazarus » (GM password `lazarus`);
`/admin` manages tables. VPS: see [deploy.md](deploy.md) (Docker, port 8095).

### Module map

| server module | client folder | page |
|---|---|---|
| `00-core.ts` | `core/` (Réglages), `app.tsx` | [modules/core.md](modules/core.md) |
| `10-characters.ts` | `sheet/` | [characters](modules/characters.md), [dice](modules/dice.md), [inventory](modules/inventory.md), [lifestyles](modules/lifestyles.md), [contacts & SINs](modules/contacts-sins.md) |
| `15-chargen.ts` | `chargen/` | [modules/chargen.md](modules/chargen.md) |
| `20-maps.ts` | `map/` | [modules/maps.md](modules/maps.md) |
| `22-maplib.ts` | `map/`, `admin/MaplibAdmin.tsx` | [modules/map-library.md](modules/map-library.md) |
| `30-combat.ts` | `combat/` | [modules/combat.md](modules/combat.md) |
| `33-attacks.ts` | `combat/AttackTray.tsx` | [modules/attacks.md](modules/attacks.md) |
| `40-shop.ts` | `shop/` | [shop](modules/shop.md), [shop upgrades](modules/shop-upgrades.md) |
| `45-matrix.ts` | `matrix/` | [modules/matrix.md](modules/matrix.md) |
| `50-training.ts` | `training/` | [modules/training.md](modules/training.md) |
| `60-audio.ts` | `audio/` | [modules/audio.md](modules/audio.md) |
| `70-campaign.ts` | `campaign/` | [modules/campaign.md](modules/campaign.md) |
| `72-city.ts` | `city/` | [modules/city.md](modules/city.md) |
| `75-notes.ts` | `notes/` | [modules/notes.md](modules/notes.md) |
| `80-foundry.ts` | `foundry/`, `admin/FoundryUpload.tsx` | [modules/foundry.md](modules/foundry.md) |
| `85-chummer.ts` | `chummer/` | [modules/chummer.md](modules/chummer.md) |
| `90-books.ts` | `books/` | [books](modules/books.md), [book references](modules/book-refs.md) |
| `95-assistant.ts` | `assistant/`, `admin/AssistantAdmin.tsx` | [modules/assistant.md](modules/assistant.md) |
| (core) `server/lib/tables.ts`, `admin.ts` | `admin/` | [multi-table](modules/multi-table.md), [demo table](modules/demo-table.md) |
| (cross-cutting) `shared/modifiers.ts`, `server/lib/modifiers.ts` | `sheet/modifiers-ui.tsx` | [modules/modifiers.md](modules/modifiers.md) |

## Server module contract

`server/modules/NN-name.ts` default-exports a `ServerModule` (type in `shared/types.ts`, with `ActionContext`,
`ActionDef`, `InitOptions`, `RouteHelpers`):

```ts
const mod: ServerModule = {
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
  // Optional. Extra HTTP routes. helpers: { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon,
  // runAction, simulateAction, actions, tableApi } — all act on the request's table (see « Table scope » below).
  routes(app, helpers) {},
};
export default mod;
```

`ctx` (`ActionContext`) = `{ state, user, isGM, tableId, table, owns(actorId), fail(msg, params?), log(entry),
emitTo(target, event, data), uid(prefix), now, displayName(), lang, t(key, params) }`
- `fail('Texte {x}', { x })` throws; the client receives `{ error: 'Texte 42', errorKey: 'Texte {x}', params: { x: 42 } }`
  and toasts it translated. `log({ …, i18n: { key, params } })` stores a translatable entry. `ctx.lang` / `ctx.t()` =
  the table's language, only for texts that must be stored pre-rendered (rare). See [i18n.md](i18n.md).
- `user` = `{ id, role: 'gm'|'player', name, characterIds: [] }` (GM id is `'gm'`).
- `owns(actorId)` → GM, or the player controls that actor.
- After every action the core saves to disk and broadcasts fresh views to everyone (debounced 30 ms). Never broadcast
  state yourself.
- `emitTo(target, event, data)` sends a **transient** event (not stored): target = `'all' | 'gm' | 'players' | userId |
  userId[]`. Event payloads are typed by `ServerEvents`.
- `log(entry)` appends to `state.log` (see [core.md](modules/core.md)) and returns it.
- Action names: `<module>/<verb>`; payloads are plain objects. Validate everything coming from players.
- Read seeds with `readSeed('file.json', fallback)` (relative to the table's pack dir) or read a sub-directory of
  `seedDir` yourself with fs. Packs and seed files: [data-model.md](data-model.md#content-packs-seeds).
- No per-table data in module-level variables: key caches by the state/map object (`WeakMap`) or by `ctx.tableId`.
- `runAction(table, user, type, payload)` and `simulateAction(table, user, type, payload, state?)` (server/index.ts,
  passed to module routes as helpers with `actions`): run an action through the same path as socket actions (save,
  broadcast), or on a deep copy of the state (validation only — used by the [assistant](modules/assistant.md)).

### Table scope
HTTP handlers registered by modules (wrapped by `scopedApp`) and socket actions run inside `tableScope`
(AsyncLocalStorage, store.ts) — `getState()`, `addLog()`, `emitTo()`, `saveSoon()`, `scheduleBroadcast()` and
`currentTable()/currentUploadDir()/currentUploadUrl()/currentDocsDir()/localFileForUrl()` resolve to that table (also
in promises/timers started there). `getState(req)` / `scheduleBroadcast(req)` accept the request explicitly.

## Views and filters

Each user receives a **view** of their table's state (`GameView` in types.ts, `game` in components), rebuilt after
every change (`buildView`, cached per user per broadcast):
- The core deep-clones the state minus `sessions`, `config` and `notes` (`state.notes` is built per user by the notes
  module), then sets `config` (campaign name, language, table info — never the password), `me`, `users` (no PINs) and
  `online`.
- GM: every module's `gmFilter` runs (trims only, e.g. Chummer XML, notes privacy). Players: the core drops `gmOnly`
  log entries and whispers not addressed to them, then every module's `filter` runs in filename order.
- What each slice looks like for a player is listed in [data-model.md](data-model.md#gm-vs-player-views).

## Client contract

- Components receive `{ game }` (the user's current view). `game.me = { id, role, name, characterIds }`.
- `send(type, payload)` → Promise of the handler's return value; shows an error toast automatically on failure.
- `useServerEvent('sfx', cb)` / `on(event, cb)` for transient events.
- Module CSS: put a file next to your component (`client/modules/map/map.css`) and `import './map.css';` at the top
  of the module (Vite bundles it). Reuse CSS variables from styles.css (`--bg --panel --panel2 --panel3 --line
  --line2 --text --dim --faint --cyan --magenta --amber --green --red --blue --violet --mono`), prefix your own
  classes with your module name.
- Shared classes: `.page` (scrollable page container), `.page-title`, `.section-title`, `.row`, `.col`, `.grid`,
  `.grid-2`, `.grid-3`, `.grow`, `.spread`, `.wrap`, `.muted`, `.small`, `.mono`, `.card`, `.card.clickable`,
  `table.sr`, `.btn` variants via `<Button variant>`, `.badge-*`.
- Open a sheet anywhere: `openSheet(actorId)`. Switch tab: `goTab('shop')`.
- Use `TextInput` (commits on blur) for anything that sends to the server, so we don't spam actions per keystroke.
- Wrap a `NumberInput` with `<Field label>` (a div), never a bare `<label>` (a label forwards clicks on its text to
  its first labelable descendant).
- Catalog files: `useCatalog(name)` (see [shop.md](modules/shop.md#catalog-files)).

UI store (`client/lib/ui-store.ts`, client-only, shared by modules): `mainTab`, `dockTab`, `dockOpen`, `sheetActorId`,
`toasts`, `viewMapId` (GM: map shown on the Carte tab, may be stale — always check `game.maps[viewMapId]` and fall
back to `scene.activeMapId`), `mapsEditId` (map open in the editor), `selectedTokenIds` (map selection),
`focusTokenId` (ask the map to centre on a token, e.g. from the initiative dock), `handoutsReadAt` (bumped when a
player opens a handout so the « Dossiers » badge refreshes), `targetTokenId` / `aimPoint` (see
[attacks.md](modules/attacks.md)).

### Registry
`client/modules/registry.ts` is fixed — implement these default exports:

| file | default export | where |
|---|---|---|
| map/MapView.tsx | `({game})` live map (GM + players) | main tab `map` |
| map/MapsPage.tsx | `({game})` GM map list + editor | main tab `maps` |
| sheet/SheetView.tsx | `({game, actorId})` full sheet | global modal (openSheet) |
| sheet/MySheet.tsx | `({game})` player's own sheet(s) | main tab `sheet` |
| sheet/CharactersPage.tsx | `({game})` GM list of PCs/NPC actors | main tab `characters` |
| sheet/LogDock.tsx | `({game})` chat + dice + log | dock `log` |
| combat/BestiaryPage.tsx | `({game})` NPC templates | main tab `bestiary` |
| combat/CombatDock.tsx | `({game})` initiative tracker | dock `combat` |
| combat/AttackTray.tsx | `({game})` defend / soak prompts (see [attacks](modules/attacks.md)) | global |
| shop/ShopPage.tsx | `({game})` shop (player buy / GM manage+approve) | main tab `shop` |
| training/TrainingPage.tsx | `({game})` karma advancement/training | main tab `training` |
| audio/AudioPage.tsx | `({game})` GM ambience/music manager | main tab `audio` |
| audio/SoundDock.tsx | `({game})` GM quick soundboard | dock `sounds` |
| assistant/AssistantDock.tsx | `({game})` GM assistant chat (Claude), see [assistant](modules/assistant.md) | dock `assistant` (GM) |
| audio/AudioEngine.tsx | `({game})` global, renders nothing/tiny; plays audio for everyone | global |
| sheet/Dice3D.tsx | `({game})` global 3D dice overlay (see [dice](modules/dice.md)) | global |
| campaign/CampaignPage.tsx | `({game})` GM campaign: acts, quests, sessions, handouts, docs, notes | main tab `campaign` |
| campaign/DossiersPage.tsx | `({game})` player handouts + recap | main tab `dossiers` |
| matrix/MatrixPage.tsx | `({game})` decker cockpit (players) / Matrix overview, hosts & IC (GM) | main tab `matrix` |
| chargen/ChargenPage.tsx | `({game})` priority character creator (players) / approval queue (GM) | main tab `chargen` |
| notes/NotesPage.tsx | `({game})` private notes + collaborative party notes (see [notes](modules/notes.md)) | main tab `notes` |
| books/BooksPage.tsx | `({game})` rulebooks: search, common rules, library (see [books](modules/books.md)) | main tab `books` |
| books/BookViewer.tsx | rulebook viewer drawer, opened with `openBook(code, page)` | global |
| core/SettingsPage.tsx | `({game})` GM settings (table language, players, backups, Foundry…) | main tab `settings` |

The enemy generator (`chargen/EnemyGenerator.tsx`) is opened from the Bestiaire page. The server admin page (`/admin`)
is `client/modules/admin/AdminPage.tsx`, mounted by app.tsx outside the table UI.

## Routing

- `/` = table picker (`GET /api/tables`; redirects to the table when only one is listed, `/?choisir` forces the list),
  `/admin` = admin page, `/t/<slug>/` = a table (same `index.html`/`app.tsx`). Every request resolves its table: URL
  prefix `/t/<slug>/`, else `X-SR-Table` header / `?table=`, else the session token's table, else the default table
  (legacy, or the only one). A named table wins: a token of another table then fails auth there.
- Client side, the page URL names the table (`/t/<slug>/`, `TABLE` in net.ts). Session token in localStorage
  `sr.token.<slug>` (old `sr.token` adopted once; memory fallback when storage is blocked); `api()`/`upload()` send
  `X-SR-Table`, the socket handshake `{ token, table }`. Upload URLs are returned by the server
  (`/t/<slug>/uploads/…`, `/uploads/…` for the legacy table) — never build them. The server emits `unauthorized` and
  disconnects a socket whose session no longer exists (user removed, import); the client then shows the login screen.
- Sessions, sockets and per-table files: [multi-table.md](modules/multi-table.md).

## Persistence & robustness

- `saveNow()` writes `state.json` atomically (tmp + fsync + rename) and never throws: on an fs error (EPERM lock by an
  antivirus/viewer, disk full) it logs and retries. `saveSoon()` debounces 400 ms but never postpones more than 2 s.
  Logins and admin import/reset save at once.
- Pending changes are flushed on SIGINT/SIGTERM/SIGHUP (console window closed)/SIGBREAK and on process exit; uncaught
  exceptions are logged without killing the server.
- An unreadable `state.json` at boot is never overwritten: it is copied to `state.corrupt-<ts>.json` and the newest
  readable copy (`state.json.tmp`, then backups) is restored; with none, that table is marked unavailable (503, listed
  by `/api/health` and `/admin`) and the other tables keep running.
- Backups (`backups/state-<ts>-<label>.json`): `boot` at every start, `shutdown`, `manual`, `before-import`,
  `before-reset` (20 newest kept) and `auto` every 15 min only when the state changed (30 newest kept).
- `/api/admin/import` fills missing base slices, keeps the live GM password when the file has none, and keeps current
  users/sessions so connected people stay logged in.
- All of this is per table (`createStateStore(dir)` in store.ts): each table has its own state file, timers and
  backups.

## Security rules

- Markdown is rendered with `renderMarkdown()` (client/lib/markdown.ts, regression tests in tools/test-markdown.ts):
  raw HTML is escaped, links/images only allow `http(s):`, `/` and `#` URLs.
- The page is served with a Content-Security-Policy (no inline scripts/handlers; relaxed only under `npm run dev` for
  Vite) and `/uploads/*` is served with a sandbox CSP + `nosniff` (non-media files as attachments).
- Never build upload URLs yourself: the server returns them (see « Routing »).
- Validate every player payload in actions; check ownership with `ctx.owns()`.
- Logins are rate-limited per IP ([multi-table.md](modules/multi-table.md)); signed links for rulebook PDFs and
  map-library images are described in [books.md](modules/books.md) and [map-library.md](modules/map-library.md).
- Zip uploads and extraction: [multi-table.md](modules/multi-table.md#zips).
