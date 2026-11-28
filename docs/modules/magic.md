# Magic

| | |
|---|---|
| server | `server/modules/47-magic.ts` (owner of `state.magic` and of `actor.magic.tradition`) |
| shared | `shared/magic.ts` (traditions lookup, drain pool, `magicHints`) |
| data | `data/catalog/traditions.json` (built by `tools/build-catalog.ts` from Chummer `traditions.xml`), read by `server/lib/traditions.ts` and the client (`/catalog/traditions.json`) |
| client | `client/modules/magic/` (MagicPage: cockpit for players, overview + cockpit for the GM; `common.tsx`: `TraditionPicker`, `openMagic`, roll labels shared with the sheet) |
| tests | `node tools/test-magic.ts` (port 3650) |

Rules: [rules/magic.md](../rules/magic.md). What is still to build (cast flow, sustaining, spirits, astral, foci,
rituals, metamagic) and the sub-issues: [design/magic.md](../design/magic.md).

## State

`MagicState`: `settings` (`autoDrain`, default on: drain resisted right after a cast; `showAstralToPlayers`, default
off), `sustained: { [id]: SustainedSpell }`, `astral: { [actorId]: AstralPresence }`. `sustained` and `astral` are
read by the cockpit and the hints but nothing writes them yet (sub-issues #14 and #20). `init` drops entries whose
actor is gone.

### Tradition (`actor.magic.tradition`)

`ActorTradition` = a copy of the catalog entry: `id` (Chummer GUID, absent for a home-made one), `name` (English),
`nameFr`, `drain` (the attribute added to WIL; `null` until chosen for Custom), `spirits` (spirit type per spell
category), `source` / `page`. A copy, so a Chummer character keeps its own drain and spirits. Written by:
- `magic/setTradition` (below);
- character creation approval (`15-chargen.ts createActor`): the draft's `magic.tradition` (Chummer name, chosen in a
  list of the catalog; drafts from before 2026-11-28 hold the old short list, mapped by `LEGACY_CHARGEN_TRADITIONS`)
  for magicians, mystic adepts and aspected magicians;
- Chummer import (`server/lib/chummer/parse.ts`, `<tradition>` with `traditiontype` MAG; `chummerTradition()`): the
  file's drain and spirits win, the catalog adds the id and French name. The 3-way merge takes Chummer's tradition when
  it changed and never erases the app's with a file that has none.

Who needs one: `usesTradition(actor)` = MAG > 0 and a spell or a sorcery / conjuring / enchanting skill. Adepts don't.

## Actions

- `magic/setTradition { actorId, tradition: id | Chummer name | null, drain? }` (any): GM = any change, `null`
  clears. Owner = only an awakened character without a tradition, or to choose the drain of a tradition that has none
  (Custom); after that only the GM changes it. Unknown tradition / invalid drain refused.
- `magic/settings { autoDrain?, showAstralToPlayers? }` (GM).

## Player view

`view.magic.sustained`: the spells their characters sustain or are under; `view.magic.astral`: their own characters'
presence, every presence when `showAstralToPlayers`. Settings are sent as is.

## UI

- Main tab `magic` (registry): GM, and players with an awakened character. Player: one cockpit per awakened character
  (tabs when several). GM: « Overview » (every awakened character: MAG, tradition picker, drain pool, sustained spells,
  astral state, « Cockpit ») and « Cockpit » (pick a character).
- Cockpit: name, tradition picker, stats (Magic; Drain = WIL + attribute, click to roll the resistance with
  `test: 'drainResist'`; Sustained count and penalty; Astral state and astral initiative), spells with « Cast »
  (Spellcasting + MAG roll as on the sheet, until the cast flow #13), magical skills (roll buttons), adept powers with
  PP. Rolls open the sheet's `RollDialog`.
- Hints (players only, toggled per browser: `localStorage['sr.magic.hints']`): `magicHints({ actor, magic })`.
- Sheet Magic tab: tradition picker for characters that use one, a single drain button once the tradition is known
  (the three WIL + LOG / CHA / INT buttons otherwise), « Magic tab » (`openMagic`, ui-store key `magicFocus`).
