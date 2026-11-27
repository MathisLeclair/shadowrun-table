# Magic rules

Little of magic is automated beyond karma costs and item effects. Page references used by the 📖 chips: drain SR5
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
- **Spellcasting** has no default limit (`skillDefaultLimit`: a skill's `limit` null = none). Spellcasting foci give
  dice under the condition `spell-<category>` ([modifiers](../modules/modifiers.md#conditions)).
- **Drain**: the `drainResist` attribute test carries drain-resistance modifiers ([dice-and-tests.md](dice-and-tests.md#attribute-only-tests-sr5-p-152)).
- **Mystic Armor** (adept power) adds to armor ([modifiers](../modules/modifiers.md#helpers)).
