# Magic rules

Magic is being automated step by step (plan: [design/magic.md](../design/magic.md)); so far: karma costs, item effects,
traditions, the drain pool, the cast flow, sustained spells, combat spells, the resistance to other spells, summoning, binding, banishing and the astral plane. Page references used by the 📖 chips: drain SR5
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
- **Resisting other spells** (SR5 285-292): active detection LOG + WIL; mana illusions LOG + WIL, physical illusions INT
  + LOG; mental manipulation LOG + WIL, physical manipulation BOD + STR; Decrease [Attribute] that attribute + WIL;
  objects use the Object Resistance table (3 / 6 / 9 / 15+, SR5 295). Passive detection, most health spells, obvious
  illusions and environmental manipulations are not resisted. Counterspelling dice are added by hand (modifier).
- **Summoning** (SR5 300-302): a type of the tradition, Force ≤ 2 × MAG, Summoning + MAG [Force] vs Force; net hits =
  services; Drain 2 × the spirit's hits (min 2), Physical if Force > MAG; one unbound spirit at a time; optional powers:
  one per 3 full points of Force; the whole fight is one service; leaving at sunrise / sunset is a GM button; a spirit
  with a full condition monitor is disrupted and its services are lost. Spirit stats: SR5 303-304 (Chummer data).
  Astral initiative of a spirit: F × 2 + 3D6 (314).
- **Binding** (SR5 300-301): Force × 25 drams of reagents used up per attempt, Binding + MAG [Force] vs Force × 2, net
  hits beyond the first add services, up to CHA bound spirits, Drain as summoning. Bound services: aid sorcery (+Force
  dice when the spirit is the tradition's type for the category), spell sustaining (Force Combat Turns per service).
  **Banishing** (301): Banishing + MAG [Astral] vs Force (+ summoner's MAG if bound), net hits remove services.
- **Astral** (SR5 312-315): perception for magicians and adepts with Astral Perception, projection for magicians only;
  the projected form uses LOG / WIL / INT / CHA for AGI / BOD / REA / STR; astral initiative INT × 2 + 3D6; unarmed
  astral combat Astral Combat + WIL [Astral] vs INT + LOG, DV astral STR + net hits, Stun or Physical, no armor.
  Mana barriers, astral tracking and assensing results stay with the GM.
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
