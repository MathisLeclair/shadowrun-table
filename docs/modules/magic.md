# Magic

| | |
|---|---|
| server | `server/modules/47-magic.ts` (owner of `state.magic` and of `actor.magic.tradition`) |
| shared | `shared/magic.ts` (traditions lookup, drain pool, `magicHints`) |
| data | `data/catalog/spells.json` (descriptor, damage: `server/lib/spells.ts`), `data/catalog/spirits.json` (`server/lib/spirits.ts`), `data/catalog/traditions.json` (built by `tools/build-catalog.ts` from Chummer `traditions.xml`), read by `server/lib/traditions.ts` and the client (`/catalog/traditions.json`) |
| client | `client/modules/magic/` (MagicPage: cockpit for players, overview + cockpit for the GM; `common.tsx`: `TraditionPicker`, `openMagic`, roll labels shared with the sheet) |
| tests | `node tools/test-magic.ts` (port 3650) |

Rules: [rules/magic.md](../rules/magic.md). The design and the decisions behind it (issue #7, sub-issues #12–#23):
[design/magic.md](../design/magic.md).

## State

`MagicState`: `settings` (`autoDrain`, default on: drain resisted right after a cast; `showAstralToPlayers`, default
off), `sustained: { [id]: SustainedSpell }`, `astral: { [actorId]: AstralPresence }`, `pendingDrain: { [id]: PendingDrain }`
(drain to resist when `autoDrain` is off). `init` drops entries whose actor is gone.

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

## Summoning and spirit actors

`magic/summon { actorId, type, force, optionalPowers?, explode?, modifier?, replace? }` (SR5 300): the type must be one of
the tradition's spirits for players (`traditionSpiritTypes`; a tradition without spirits, and the GM, may summon any);
Force 1 … 2 × MAG; one unbound spirit at a time (`replace: true` releases the old one once the new one answers).
Summoning + MAG [Force] (`performRoll`) vs the spirit's Force dice (`rollDice`, a GM-only log entry). Drain =
max(2, 2 × the spirit's hits), Physical if Force > MAG, resisted or left pending as for spells. Net hits > 0 →
`createSpirit`: an NPC actor (`npc.kind: 'spirit'`, `initMode: 'astral'`, `metatype` = the type, attributes / initiative
/ skills / powers of `spiritStats`, chosen optional powers ≤ one per 3 Force, the summoner's color, hidden like a hidden
summoner) with `actor.spirit = { type, typeFr, force, summonerId, services, bound, materialized, optionalPowers, ts }`.
**Control**: the spirit's id is added to the `characterIds` of the summoner's player(s), so the existing rights (full
sheet, rolls, token moves, combat) apply unchanged; `removeActor` takes it out again.
- `magic/spiritServices { spiritId, delta }`: the player may use one (−1), the GM sets any; at 0 the spirit leaves.
- `magic/materialize { spiritId, materialized, mapId? }`: a token next to the summoner (`placeActorToken` of 20-maps),
  initiative mode physical; dematerialized: tokens removed, astral mode (also on its combat entry).
- `magic/spiritCombat { spiritId }`: joins the running fight (`addEntries` of 30-combat); one service for an unbound
  spirit (the whole fight, SR5 302).
- `magic/release { spiritId }`; `magic/sunrise` (GM): every unbound spirit leaves (no in-game clock).
- Disrupted (a full condition monitor, SR5 302): removed on the next magic action or Combat Turn (`sweepDisrupted`).
- Spirits' astral initiative is F × 2 + 3D6 (`derive`, SR5 314). They never get the Magic cockpit (`magicActors`,
  `usesTradition` skip `actor.spirit`).
- **Natural attacks** (SR5 187, 396-399): `spiritWeapons(actor)` (shared) turns the powers into sheet weapons with
  `natural: { power, element, rangeStep?, aura? }`, ids `<actorId>-nat-…`, category « Natural attack », limit Physical:
  an unarmed attack (Unarmed Combat, (STR)S; with Energy Aura (STR + F)P, AP −F, elemental), Elemental Attack (Exotic
  Ranged Weapon, (F × 2)P, AP −F, range bands F / 2F / 3F / 4F m), Engulf (melee, F × 2, AP −F, Stun for air and water),
  Natural Weapon (the DV / AP of its choice, « DV (Force)P, AP 0 »; vehicle weapons skipped). The element is the
  Elemental Attack's choice, else the type (Spirit of Fire → fire). `syncSpiritWeapons` rebuilds them at summoning and
  at boot (spirits summoned before keep up), other weapons kept. They go through `attack/roll` like any weapon
  ([attacks.md](attacks.md)); refused while the spirit is astral (it uses `magic/astralAttack` there).
UI: cockpit « Spirits » panel (Summon, services, materialize, join the fight, ⚔ Attack — the sheet's `RollDialog` on
its natural attacks, Elemental Attack first — or ⚔ Astral attack when not materialized, sheet, release), the sheet's
Combat tab shows each natural attack's rule (`naturalAttackRule`), `SummonModal` (type —
the tradition's first —, Force, stats preview, optional powers, Edge, Drain rule, result), GM overview column and
« Sunrise / sunset » button.

## Binding, bound spirits, banishing

- `magic/bind { spiritId, explode?, modifier?, free? }` (SR5 300-301): a summoned unbound spirit; at most CHA bound
  spirits; Force × 25 drams of reagents (`reagentDrams`: gear named « Reagents » / « Réactifs », `qty` = drams) used up
  by every attempt (the GM may pass `free`); Binding + MAG [Force] vs Force × 2 (GM-only roll); Drain 2 × the spirit's
  hits (min 2), Physical if Force > MAG; success: `bound`, `present`, services += net hits − 1.
- Bound spirits stay at sunrise; `magic/callSpirit { spiritId, present }` sends one to rest (`present: false`: tokens
  removed, out of the fight, cannot materialize, aid or sustain) or calls it back.
- **Aid sorcery** (SR5 302): `magic/cast … aidSpiritId`: a bound, called spirit of the caster with a service whose type is
  the tradition's spirit of the spell's category (`aidSpiritType`) adds its Force in dice (trusted bonus line
  « spirit F »), one service.
- **Spell sustaining** (SR5 302): `magic/spiritSustain { sustainedId, spiritId }`: `sustained.by = { kind: 'spirit',
  actorId, turnsLeft: Force }`, one service; `syncSustained` puts the −2 on the spirit instead of the caster; each new
  Combat Turn counts down, then the caster sustains it again (logged). Spell binding is the GM's.
- **Banishing** (SR5 301): `magic/banish { actorId, spiritId }`: any spirit (one's own or an enemy's; players: not a
  hidden NPC); Banishing + MAG [Astral] vs Force (+ the summoner's MAG if bound), each net hit removes a service, at 0
  the spirit leaves; Drain 2 × the spirit's hits (min 2), Physical if Force > the banisher's MAG.
UI: spirit cards « Bind » / « Call » / « Send to rest », « Give to <spirit> » on sustained spells, « Spirit aid » in the
cast modal, `BanishModal` (spirits in view: full sheets with `spirit`, or NPC stubs whose metatype is a spirit type).

## Astral

- `magic/astral { actorId, mode: 'perceiving' | 'projecting' | null, mapId? }`: perception for magicians and adepts with
  the Astral Perception power (`canPerceiveAstral`, SR5 312), projection for magicians (`canProjectAstral`, 313); the GM
  is not checked. Projecting: the actor's token stays as the body (status `'empty body'`, an English key shown with
  `statusText`), a second token `astral: true` is placed next to it (`placeActorToken`), the combat entry switches to
  astral initiative; leaving removes the astral token and the status. `state.magic.astral[actorId] = { mode, since, mapId? }`.
- Spirits: a new spirit gets an astral token next to its summoner; materializing turns its token physical, dematerializing
  turns it astral again; a bound spirit called back reappears astral.
- **Visibility**: the magic module's filter (after the maps one) strips `astral` tokens from a player's view unless the
  token is one of their characters (spirits included) or one of their characters is astrally active (perceiving,
  projecting, or an astral spirit), or `settings.showAstralToPlayers` is on. The renderer draws astral tokens at 60 %
  with a dashed cyan halo; « empty body » has the ⌀ status glyph.
- **Astral attack** `magic/astralAttack { actorId, targetId, mapId?, damage: 'P' | 'S' }` (SR5 315): from an astrally active
  actor or a spirit; Astral Combat + WIL [Astral]; DV = astral Strength (CHA when projecting, Force for a spirit, else
  STR) + net hits; `addAstralAttack` (33-attacks): defense INT + LOG (`doAstralDefense`, no active defense), soak with WIL
  (astral form) or BOD (physical body), no armor. The tray uses the resist dialog for the defense.
- Astral initiative: INT × 2 + 3D6 (SR5 314 table; it was 2D6), spirits F × 2 + 3D6.
UI: cockpit « Astral plane » panel (Perceive, Project, Back, Astral attack, the astral form's attributes AGI→LOG, BOD→WIL,
REA→INT, STR→CHA), hint while projecting.

## Foci

- A focus is gear of category Foci / Focus (or named « … Focus »): `focusKind` (spellcasting, counterspelling, ritual,
  sustaining, summoning, banishing, binding, power, weapon, qi, alchemical, disenchanting, centering, masking, flexible
  signature, spell shaping), Force = `rating`, `gear.bonded` (false when bought: shop and sheet catalog picker; absent on
  older sheets = bonded), `gear.active` (the sheet / cockpit switch).
- **Bonding** (SR5 318) is a training request `kind: 'focus'` (`shared/advancement.ts`): target = the gear id, karma =
  Force × `focusBondMultiplier` (spell / spirit / qi × 2, weapon / enchanting / metamagic × 3, power × 6), refused beyond
  MAG bonded foci or a total Force above MAG × 5 (`fociLimits`); no training days; the GM approves as for other
  requests; applying sets `bonded: true`.
- **Effects** (`collectModifiers`): only a bonded, active focus counts. Catalog effects (spellcasting +F on its category,
  power +F to MAG, alchemical, disenchanting) as before; `focusEffects` adds the ones the catalog leaves empty:
  counterspelling and ritual +F (condition `spell-<category>`, which now also covers Counterspelling), summoning /
  binding +F (switch « the chosen spirit type »), weapon focus +F on its weapon (`choice` = weapon id, set by
  `magic/focusWeapon`) and on Astral Combat. Banishing (+F limit), qi and metamagic foci stay with the GM.
- **Sustaining focus** (SR5 320): `magic/cast … sustainFocusId`: active, bonded, the spell's category, Force ≥ the
  spell's, one spell at a time → `sustained.by = { kind: 'focus', gearId }`; mirrored on the caster with `focusId`, the
  modifiers skip the −2 while the focus works, so switching it off puts the −2 back at once.
- Addiction (SR5 319): the cockpit warns when the active foci's Force exceeds MAG.
UI: cockpit « Foci » panel (kind, Force, bonded, Bond (karma), active switch, weapon link, limits, addiction), sustaining
focus choice in the cast modal.

## Ritual spellcasting

GM « Ritual » tab (`RitualPanel`): leader (an awakened character with Ritual Spellcasting), the ritual (the leader's
spells, « Rituals » category first; any spell for a Spell ritual), Force, participants, extra offerings, a « lodge Force ≥
ritual Force » check (step 4, by hand).
- `magic/ritual { leaderId, ritualId, force, participantIds?, extraOfferings?, free? }` (GM, SR5 295-296): the leader uses
  Force × (1 + extra) drams of reagents (`free` when the leader has not enough); each participant rolls Ritual Spellcasting
  + MAG [Force] (−2 for another tradition); `teamwork()` (SR5 49): their hits add dice up to the leader's skill, each
  assistant with hits and no glitch +1 limit (none on a critical glitch); the leader rolls Ritual Spellcasting + MAG
  [Force + teamwork] vs Force × 2 (GM-only roll); every participant resists Drain `ritualDrain` = 2 × the opposition's
  hits − extra offerings (min 2), Physical if the leader's hits exceed their MAG; glitches logged for the GM. Net hits are
  the ritual's effect (GM).
- `magic/ritualFail` (GM): Stun Drain 2 × the hits of a Force × 2 roll for every participant.

## Metamagic

`METAMAGICS` (shared/magic.ts, SR5 325-326; names of `actor.magic.metamagics` matched in English or French, like the
echoes): each has an automation status and a rule text shown in the cockpit « Metamagics » panel (with the initiate grade).
- **Centering**: +grade dice on every Drain Resistance Test, + the Force of an active centering focus (319) —
  `metamagicEffects` → a `stat drainResist` modifier. **Shielding**: +grade on Counterspelling (`skill counterspelling`).
- **Quickening**: `magic/quicken { sustainedId, karma }` (the caster's owner or GM; the metamagic required for players):
  1 … Force karma taken from the caster (history line), `sustained.by = { kind: 'quickened', karma }`: permanent, no −2,
  its effects stay on the targets; « Quicken » button on the cockpit's sustained spells.
- **Spell Shaping**: `magic/cast … shape` (area spells, the metamagic for players): radius Force ± shape metres, −|shape|
  dice (bonus line « spell shaping »), |shape| ≤ MAG + an active spell shaping focus's Force (`spellShapingMax`).
- Adept Centering, Masking, Flexible Signature, Fixation: text for the GM; Power Point: the training's.

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
- `magic/summon`, `magic/spiritServices`, `magic/materialize`, `magic/spiritCombat`, `magic/release`, `magic/sunrise`,
  `magic/bind`, `magic/callSpirit`, `magic/spiritSustain`, `magic/banish`, `magic/astral`, `magic/astralAttack`,
  `magic/focusWeapon`, `magic/ritual`, `magic/ritualFail`, `magic/quicken`: above. Focus bonding: `training/request { kind: 'focus', target: gearId }`.
- `magic/settings { autoDrain?, showAstralToPlayers? }` (GM; « Resist Drain automatically » toggle of the GM page).

## Player view

Astral tokens of the shown map are filtered (see Astral). `view.magic.sustained`: the spells their characters sustain or are under; `pendingDrain`: their characters' own; `view.magic.astral`: their own characters'
presence, every presence when `showAstralToPlayers`. Settings are sent as is.

## UI

- Main tab `magic` (registry): GM, and players with an awakened character. Player: one cockpit per awakened character
  (tabs when several). GM: « Overview » (every awakened character: MAG, tradition picker, drain pool, sustained spells,
  astral state, « Cockpit »), « Active spells » (every sustained spell, « Drop »), « Ritual » and « Cockpit » (pick a character).
- Cockpit: name, tradition picker, stats (Magic; Drain = WIL + attribute, click to roll the resistance with
  `test: 'drainResist'`; Sustained count and penalty; Astral state and astral initiative), « Drain to resist » (pending drains), « Sustained spells » (with « Drop ») and « Spells on <name> », spells with « Cast » (`CastModal`: spell, Force,
  live Drain Value and pool, reckless, push the limit, targets of the map in view with distance and line-of-sight /
  reach / area warnings, centre of an area; then the result: hits, drain and damage), magical skills (roll buttons),
  adept powers with PP. Rolls open the sheet's `RollDialog`.
- Hints (players only, toggled per browser: `localStorage['sr.magic.hints']`): `magicHints({ actor, magic })`.
- Sheet Magic tab: « Cast » opens the same `CastModal`; tradition picker for characters that use one, a single drain button once the tradition is known
  (the three WIL + LOG / CHA / INT buttons otherwise), « Magic tab » (`openMagic`, ui-store key `magicFocus`).
