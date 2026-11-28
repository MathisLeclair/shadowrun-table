# Magic

| | |
|---|---|
| server | `server/modules/47-magic.ts` (owner of `state.magic` and of `actor.magic.tradition`) |
| shared | `shared/magic.ts` (traditions lookup, drain pool, `magicHints`) |
| data | `data/catalog/spells.json` (descriptor, damage: `server/lib/spells.ts`), `data/catalog/spirits.json` (`server/lib/spirits.ts`), `data/catalog/traditions.json` (built by `tools/build-catalog.ts` from Chummer `traditions.xml`), read by `server/lib/traditions.ts` and the client (`/catalog/traditions.json`) |
| client | `client/modules/magic/` (MagicPage: cockpit for players, overview + cockpit for the GM; `common.tsx`: `TraditionPicker`, `openMagic`, roll labels shared with the sheet) |
| tests | `node tools/test-magic.ts` (port 3650) |

Rules: [rules/magic.md](../rules/magic.md). What is still to build (spirits, astral, foci,
rituals, metamagic) and the sub-issues: [design/magic.md](../design/magic.md).

## State

`MagicState`: `settings` (`autoDrain`, default on: drain resisted right after a cast; `showAstralToPlayers`, default
off), `sustained: { [id]: SustainedSpell }`, `astral: { [actorId]: AstralPresence }`, `pendingDrain: { [id]: PendingDrain }`
(drain to resist when `autoDrain` is off). `astral` is read by the cockpit but nothing writes it yet (#20). `init`
drops entries whose actor is gone.

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

## Spirit data

`data/catalog/spirits.json`: Chummer `critters.xml` entries of category Spirits (29 types: the six SR5 spirits,
guardian, guidance, plant, task, blood, toxic…), built by `tools/build-catalog.ts` (`SpiritDef`): attributes as Force
formulas, `initiative` formula and `initiativeDice` (1 + Chummer's initiativepass), powers and optional powers with
their French names and choice (`select`: Elemental Attack « Fire »), skills (rating « F »), movement, source / page.
`spiritStats(def, force)` (shared): attributes (`evalForce`: F, F ± n, F / 2 rounded down, (F × 2) + 3; no eval),
physical initiative as a bonus over REA + INT so the normal initiative rules give the book value, astral initiative
F × 2 + 3D6, skills mapped to the app's ids (Exotic Ranged Weapon → `exotic_weapon`, Flight kept as a custom AGI
skill), powers, `optionalPowerCount` = one per 3 full points of Force (SR5 300). `traditionSpiritTypes(tradition, all)`:
the tradition's five spirits (every type without one). Summoning (#18) uses them.

## Combat spells (attacks)

After the cast, a Combat spell with hits creates one `Attack` per target (`addSpellAttack` of 33-attacks, kind
`'spell'`, `attack.spell = { mode, resist, force, element, castLogId }`), so the attack tray, `attack/defend`,
`attack/soak`, `attack/auto` and the GM's hand resolution work as for weapons. `combatSpellProfile(spell, info)`
(shared): the catalog descriptor and damage (`server/lib/spells.ts spellCatalogInfo`, by catalog id or English / French
name); a hand-made spell: mana → direct, physical → indirect when its name is elemental, Stun when its name says so.
- **Direct** (SR5 283): status `defense` resolved by `doResistSpell`: the target rolls BOD (physical spell) or WIL
  (mana spell), the net hits are the damage (spell's type), no soak, no armor.
- **Indirect** (SR5 283): `dv = Force`, `ap = −Force`; the usual defense (REA + INT, dodge options) then soak at
  Force + net hits. Elemental spells (fire, acid, electricity, cold by name) log a reminder of the extra effects
  (SR5 170-171) when they hit.
- Mana spells cannot target an NPC of kind drone, IC or host (SR5 282).
The tray shows « Resist the spell » (`SpellResistDialog`: attribute, modifier, Edge) for a direct spell.

## Non-combat spells: resistance

`spellResistance(spell, info)` (shared, from the catalog descriptor; SR5 285-292): active Detection → LOG + WIL (objects:
Object Resistance); Health → none, but Decrease [Attribute] / Negative spells → that attribute + WIL; Illusion → mana
LOG + WIL, physical INT + LOG (devices: Object Resistance), Obvious → none; Manipulation → Mental LOG + WIL, Physical
BOD + STR (objects: Object Resistance), Environmental → none. After a cast with hits, each target other than the caster
gets an `Attack` kind `'spell'` with `noDamage` and `spell.resist` / `resist2`: the target resists from the tray
(`SpellResistDialog`, an ally's Counterspelling dice in the modifier) and the net hits are logged; the GM applies the
effect. `object: 3 | 6 | 9 | 15` (Object Resistance table, SR5 295) rolls the object's dice at once: `result.object =
{ pool, hits, net }`. The cast modal shows the rule and, when objects can be targeted, the Object Resistance choice.

## Sustained spells

A cast of a Sustained (S) or Permanent (P) spell with at least one hit is sustained unless the caster unticks it
(`sustain: false`): a `SustainedSpell` in `state.magic.sustained` (caster, spell, Force, hits, targets, area;
`turnsLeft = Force` for a Permanent spell, counted down by the combat `newTurn` hook and dropped at 0: its effect is
then permanent, SR5 283). `syncSustained(state)` mirrors the record on the actors after every change (and at boot):
- `actor.magic.sustaining = [{ id, name, force }]` on the caster → `collectModifiers` adds an `allTests` −2 per
  spell (source « Sustaining … », 📖 SR5 282): every skill / attribute test, Matrix pools included, not the resistance
  tests (as the afflictions);
- `actor.magic.spellEffects = [{ id, name, force, hits, casterId, casterName, effects }]` on each target, with the
  numeric effects of `SPELL_EFFECTS` (shared/magic.ts): Armor (+hits armor, SR5 293), Combat Sense (+hits defense,
  SR5 288). Other spells stay a text for the GM. Both mirrors are written by the module only.
`magic/drop { id }` (the caster's owner or GM) ends it (logged). A bound spirit or a sustaining focus (`by`) comes
with #19 / #21.

## Actions

- `magic/setTradition { actorId, tradition: id | Chummer name | null, drain? }` (any): GM = any change, `null`
  clears. Owner = only an awakened character without a tradition, or to choose the drain of a tradition that has none
  (Custom); after that only the GM changes it. Unknown tradition / invalid drain refused.
- `magic/cast { actorId, spellId, force, reckless?, explode?, modifier?, conditions?, ignore?, mapId?, targetIds?, area?, drainDv? }`
  (owner or GM) → `{ logId, rollLogId, hits, rawHits, glitch, critGlitch, force, dv, drainType, drain, targetIds, area, sustainedId, attackIds }`.
- `magic/resistDrain { id }` (owner or GM): resist a pending drain.
- `magic/cast … sustain?, object?` (default: sustained when possible) → also `sustainedId`, `attackIds`, `object`; `magic/drop { id }`.
- `magic/settings { autoDrain?, showAstralToPlayers? }` (GM; « Resist Drain automatically » toggle of the GM page).

## Player view

`view.magic.sustained`: the spells their characters sustain or are under; `pendingDrain`: their characters' own; `view.magic.astral`: their own characters'
presence, every presence when `showAstralToPlayers`. Settings are sent as is.

## UI

- Main tab `magic` (registry): GM, and players with an awakened character. Player: one cockpit per awakened character
  (tabs when several). GM: « Overview » (every awakened character: MAG, tradition picker, drain pool, sustained spells,
  astral state, « Cockpit »), « Active spells » (every sustained spell, « Drop ») and « Cockpit » (pick a character).
- Cockpit: name, tradition picker, stats (Magic; Drain = WIL + attribute, click to roll the resistance with
  `test: 'drainResist'`; Sustained count and penalty; Astral state and astral initiative), « Drain to resist » (pending drains), « Sustained spells » (with « Drop ») and « Spells on <name> », spells with « Cast » (`CastModal`: spell, Force,
  live Drain Value and pool, reckless, push the limit, targets of the map in view with distance and line-of-sight /
  reach / area warnings, centre of an area; then the result: hits, drain and damage), magical skills (roll buttons),
  adept powers with PP. Rolls open the sheet's `RollDialog`.
- Hints (players only, toggled per browser: `localStorage['sr.magic.hints']`): `magicHints({ actor, magic })`.
- Sheet Magic tab: « Cast » opens the same `CastModal`; tradition picker for characters that use one, a single drain button once the tradition is known
  (the three WIL + LOG / CHA / INT buttons otherwise), « Magic tab » (`openMagic`, ui-store key `magicFocus`).
