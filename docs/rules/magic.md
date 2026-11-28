# Magic rules

Magic is being automated step by step (plan: [design/magic.md](../design/magic.md)); so far: karma costs, item effects,
traditions, the drain pool, the cast flow, sustained spells and combat spells. Page references used by the 📖 chips: drain SR5
282, power points 278, adept powers 308, spellcasting 281, initiation 324 (`RULE_REFS`, [book-refs](../modules/book-refs.md)).

- **Adept powers**: powers with a catalog `stats.bonus` (Improved Reflexes: REA + initiative dice per level,
  `extrapointcost` 0.5 PP on the first level) get the bonus applied on purchase/level-up and recorded on
  `power.bonus` ([modifiers-stacking.md](modifiers-stacking.md#no-double-counting)). `actor.powers[].pp` is the TOTAL
  power-point cost of that power (all levels included).
- **Magic grades** (`actor.magic`, written by training): `initiation` grade (raises the MAG maximum by 1 per grade),
  `submersion` (technomancer grade, raises the RES maximum by 1 per grade), `metamagics`, `echoes`, `extraPP` (power
  points not coming from MAG: bought by mystic adepts, or gained via initiation by adepts). Source: the header of
  `shared/advancement.ts`.
- **Karma costs** of spells, powers, power points, complex forms, initiation: [advancement.md](advancement.md).
- **Casting** (SR5 281-282): Force 1 … 2 × MAG and the Force is the limit; Drain Value = the spell's formula at that
  Force, never below 2, +3 for Reckless Spellcasting (Simple Action); Drain is Physical when the hits (after the limit)
  exceed Magic, else Stun; glitches are left to the GM (+2 Drain is the usual one). Line of Sight / Touch / Area (radius
  = Force metres) are checked on the map for players. Multiple spells in one action (split pool) stay manual.
- **Combat spells** (SR5 283): direct = opposed by BOD (physical) / WIL (mana), damage = net hits, no soak; indirect =
  dodged like a ranged attack, DV = Force + net hits, AP = −Force, soaked with BOD + armor. Direct / indirect and the
  damage type come from Chummer's spell descriptor; elemental extra effects (SR5 170-171) are the GM's. Mana spells do
  not affect drones, IC or hosts (282).
- **Sustaining** (SR5 282-283): −2 dice per spell the character sustains, cumulative, on every test but damage
  resistance (the app's convention for « all tests » penalties, as for afflictions). Permanent spells are sustained Force Combat Turns
  (counted on new Combat Turns), then end. Armor (+hits armor, 293) and Combat Sense (+hits defense dice, 288) apply to
  the target; other effects are the GM's.
- **Spellcasting** has no default limit (`skillDefaultLimit`: a skill's `limit` null = none). Spellcasting foci give
  dice under the condition `spell-<category>` ([modifiers](../modules/modifiers.md#conditions)).
- **Traditions** (SR5 279, Street Grimoire 41-52, Forbidden Arcana…): `data/catalog/traditions.json` from Chummer
  `traditions.xml` (drain attribute, spirit of each spell category). Drain is resisted with WIL + the tradition's
  attribute (LOG, CHA or INT; Draconic MAG and Romani WIL as in Chummer, so `drainResist` accepts WIL + MAG and WIL + WIL).
  Adepts have no tradition. Details: [modules/magic.md](../modules/magic.md).
- **Drain**: the `drainResist` attribute test carries drain-resistance modifiers ([dice-and-tests.md](dice-and-tests.md#attribute-only-tests-sr5-p-152)).
- **Mystic Armor** (adept power) adds to armor ([modifiers](../modules/modifiers.md#helpers)).
