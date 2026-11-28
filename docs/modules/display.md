# Table displays (shared screen / projector)

Module `server/modules/96-display.ts`, pure rules `shared/display.ts`, auth in `server/index.ts`; client
`client/modules/display/` (`DisplayShell.tsx` = the display page, `DisplayMap.tsx`, `panes.tsx`, `DisplaysPanel.tsx` =
the GM's controls in Settings). Test: `node tools/test-display.ts` (port 3975). Issue #77.

For in-person games: a TV, a screen built into the table or a projector shows the shared scene (the map, mostly) the
way the players see it, while the GM keeps the full view on their laptop and the players keep their phones (sheet,
condition monitors, dice, Matrix cockpit, moving their tokens). The display is one more client next to them.

## Links

`state.displays[id]` = `DisplayLink` (types.ts): `{ id, token, createdAt, name, vision, rotation, blank, initiative,
audio, handoutId, layout }`. At most `MAX_DISPLAYS` (8) per table. The screen opens **`/t/<slug>/?display=<token>`**:
no login, no password typed on the shared screen. The token is the secret: it stays in the URL and is never stored in
the browser (`DISPLAY_TOKEN` in net.ts), so opening a display where someone is logged in leaves their session alone.

| GM action (all `role: 'gm'`) | payload | |
|---|---|---|
| `display/create` | `{ name? }` | → `{ id, token }`; default name « Display n » |
| `display/update` | `{ displayId, patch }` | any of the settings below, validated |
| `display/renew` | `{ displayId }` | new token: the old URL stops working, its screens are sent away |
| `display/remove` | `{ displayId }` | revoke: its screens are disconnected at the next broadcast |
| `display/focus` | `{ displayId?, mapId, x, y, zoom? }` | « look here »: transient `display/focus` event to one display (or all) |

Settings, all pushed live (the display has no input):
- `vision`: `'party'` (default) or a PC id. See « Vision » below.
- `layout` `{ main, split, splitDir: 'row'|'col', splitRatio }`: the panes, like the workspace split view
  ([workspace.md](workspace.md)), stored on the link server-side instead of the browser's `localStorage`. Panes are only
  player-safe: `map`, `initiative`, `handout`, `rolls` (`DISPLAY_PANES`). Floating panels are not offered (their pixel
  positions mean nothing on a screen of unknown size). More screens: add another link, or open the same link in
  another window.
- `rotation` 0/90/180/270: the map pane turns for a screen laid flat in the table (no local pan / zoom then: gestures
  would follow the unrotated axes).
- `blank`: black screen (during a reveal).
- `initiative`: an initiative strip along the bottom while a combat runs.
- `handoutId`: a handout shown full screen (in the `handout` pane when the layout has one). Only a handout revealed to
  every player (`revealedTo: 'all'`): that is what the display's player-side view holds.
- `audio`: this screen plays the ambience and sound effects (`AudioEngine`), off by default (the GM's laptop or the
  players may already play it).

The GM controls are in **Settings → Table displays** (link with Copy / Open, online badge from
`view.displaysOnline`); « Show on the table displays » in the GM's right-click menu of a map cell sends `display/focus`
(active map only, when links exist).

## What a display receives

The core resolves a link token to `SessionUser { id: 'display:<id>', role: 'display', characterIds: [], display: id }`
(`userFromToken`, `displayByToken`). Its view is built by **the player path of `buildView`**: the same module
`filter`s as a player without characters, so nothing GM-only reaches it (hidden tokens and combat entries, GM notes,
`gmOnly` regions, light names, NPC stats, whispers, `gmOnly` log entries, other maps). There is no third filter to keep
in sync; two small additions:
- `20-maps` computes the map mask with the display's eyes (`displayEyes`) instead of the user's own characters.
- `96-display` (runs last) adds `view.display` (its settings, without the token) and empties the party notes.

The links themselves never reach a player or a display: the core keeps `state.displays` out of every view but the
GM's (`view.displays`, with tokens, and `view.displaysOnline`).

Read-only: every socket action from a display is refused (`A table display is read-only`, also in `runAction`), and its
token gives no HTTP access (`authUser` ignores it). `online` (people connected) leaves displays out. A display gets the
`'all'` events (sfx, pings, `audio-stop`), never `'players'` ones. Displays survive a GM reset and an import (links
kept, like sessions). Demo tables allow display links like any table.

## Vision

`displayEyes(state, linkId)` (`shared/display.ts`):
- `party`: every PC in play (not retired) is a viewer; explored cells = every player's `map.explored`.
- one PC: that character is the viewer (plus every PC token when the map has `sharedVision`, as for its player);
  explored cells = its player's. A vision naming a PC that is gone falls back to the party.
- `fog: false`: the whole map, as for players.

The display renders the result like a player does (`map.explored['display:<id>']` + `map.visible`). The map is always
`scene.activeMapId`, like players.

## The display page

`client/modules/display/DisplayShell.tsx`, mounted by `app.tsx` when the URL has `?display=`: full screen, large type,
no tabs, dock or menus. Screen Wake Lock while visible; a full-screen button shows when the mouse moves. The table
announcement banner shows on top. A revoked or renewed link shows « This display link is no longer valid » (no login
screen).

The `rolls` pane lists the last public rolls (no whisper / `gmOnly` entries — the server already removed those);
`initiative` the order with the current participant highlighted (what players see: no hidden entries, no NPC dice).
