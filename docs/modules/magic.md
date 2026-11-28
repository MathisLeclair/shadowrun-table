# Magic

| | |
|---|---|
| server | `server/modules/47-magic.ts` (owner of `state.magic` and of `actor.magic.tradition`) |
| shared | `shared/magic.ts` (traditions lookup, drain pool, `magicHints`) |
| data | `data/catalog/traditions.json` (built by `tools/build-catalog.ts` from Chummer `traditions.xml`), read by `server/lib/traditions.ts` and the client (`/catalog/traditions.json`) |
| client | `client/modules/magic/` (MagicPage: cockpit for players, overview + cockpit for the GM; `common.tsx`: `TraditionPicker`, `openMagic`, roll labels shared with the sheet) |
| tests | `node tools/test-magic.ts` (port 3650) |

Rules: [rules/magic.md](../rules/magic.md). What is still to build (sustaining, spell effects, spirits, astral, foci,
rituals, metamagic) and the sub-issues: [design/magic.md](../design/magic.md).

## State

`MagicState`: `settings` (`autoDrain`, default on: drain resisted right after a cast; `showAstralToPlayers`, default
off), `sustained: { [id]: SustainedSpell }`, `astral: { [actorId]: AstralPresence }`, `pendingDrain: { [id]: PendingDrain }`
(drain to resist when `autoDrain` is off). `sustained` and `astral` are
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

## Cast flow (`magic/cast`)

`castSpell()` (exported for the effect steps): the actor's spell, Force 1 … 2 × MAG, the tradition's drain attribute
required. Drain Value = `drainValue(formula, force, { reckless })` (« F ± n », minimum 2, +3 reckless); a formula that
is not « F ± n » (« Special ») needs `drainDv` from the caster. Targets (`targetIds`, actors with a token on `mapId`)
are checked for players only: Line of Sight (`hasLineOfSight` from the caster's token), Touch (adjacent token), Self
(the caster), Area (`(A)`: centre = `area` point or the first target, every target within Force metres + one cell).
Roll: `performRoll` Spellcasting + MAG with `limit = force` (Edge: no limit), the condition `spell-<category>` added
so spellcasting foci apply, label « Sort — name » + `labelI18n` « Spell — {spell} (Force {force}) »; hidden NPC
casters roll in secret. Drain is Physical when the hits exceed MAG (`spellDrainType`). Log entries `kind: 'magic'`
with `entry.magic` (`MagicLogInfo`: cast / drain); a glitch / critical glitch adds a reminder for the GM (SR5 282).
Drain: `resistDrain()` = `dice/roll`-like WIL + tradition attribute, `test: 'drainResist'`, damage applied with
`applyDamage`; or a `PendingDrain` when `autoDrain` is off. The effects of the spell are the next steps (design).

## Actions

- `magic/setTradition { actorId, tradition: id | Chummer name | null, drain? }` (any): GM = any change, `null`
  clears. Owner = only an awakened character without a tradition, or to choose the drain of a tradition that has none
  (Custom); after that only the GM changes it. Unknown tradition / invalid drain refused.
- `magic/cast { actorId, spellId, force, reckless?, explode?, modifier?, conditions?, ignore?, mapId?, targetIds?, area?, drainDv? }`
  (owner or GM) → `{ logId, rollLogId, hits, rawHits, glitch, critGlitch, force, dv, drainType, drain, targetIds, area }`.
- `magic/resistDrain { id }` (owner or GM): resist a pending drain.
- `magic/settings { autoDrain?, showAstralToPlayers? }` (GM; « Resist Drain automatically » toggle of the GM page).

## Player view

`view.magic.sustained`: the spells their characters sustain or are under; `pendingDrain`: their characters' own; `view.magic.astral`: their own characters'
presence, every presence when `showAstralToPlayers`. Settings are sent as is.

## UI

- Main tab `magic` (registry): GM, and players with an awakened character. Player: one cockpit per awakened character
  (tabs when several). GM: « Overview » (every awakened character: MAG, tradition picker, drain pool, sustained spells,
  astral state, « Cockpit ») and « Cockpit » (pick a character).
- Cockpit: name, tradition picker, stats (Magic; Drain = WIL + attribute, click to roll the resistance with
  `test: 'drainResist'`; Sustained count and penalty; Astral state and astral initiative), « Drain to resist » (pending drains), spells with « Cast » (`CastModal`: spell, Force,
  live Drain Value and pool, reckless, push the limit, targets of the map in view with distance and line-of-sight /
  reach / area warnings, centre of an area; then the result: hits, drain and damage), magical skills (roll buttons),
  adept powers with PP. Rolls open the sheet's `RollDialog`.
- Hints (players only, toggled per browser: `localStorage['sr.magic.hints']`): `magicHints({ actor, magic })`.
- Sheet Magic tab: « Cast » opens the same `CastModal`; tradition picker for characters that use one, a single drain button once the tradition is known
  (the three WIL + LOG / CHA / INT buttons otherwise), « Magic tab » (`openMagic`, ui-store key `magicFocus`).
