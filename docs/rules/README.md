# SR5 rules implemented

What the app automates from Shadowrun 5th Edition, grouped by topic, with the book and page each rule comes from.
References use Chummer book codes and **printed** pages (SR5 = core rulebook, RG = Run & Gun, RF = Run Faster…), the
way the data's `source` / `page` fields do ([book-refs](../modules/book-refs.md)). How each feature uses the rule
(actions, state, UI) is on its feature page, linked from each section.

## Follow Chummer when ambiguous

When a rule is ambiguous or stacking is unclear, do what **Chummer5a** does (its data files are the source of the
catalog and of item effects), so imported characters compute the same numbers in both tools. Cite book and page
(`source`, `page` fields) the way the existing data does. Before implementing a rule, read the page: the server's
rulebook index (`index/<CODE>.json` in the books folder, [books.md](../modules/books.md)) holds the text of every page,
also searchable in the « Règles » tab.

Known places where the app departs from Chummer or from the book (on purpose):
- Dodge also works against ranged attacks (SR5 p. 191; Chummer's data lists it for melee only) —
  [combat.md](combat.md#defense-sr5-p-188).
- Clip change = one Simple Action (SR5 counts remove + insert as a Simple Action each) —
  [combat.md](combat.md#fire-modes-ammunition-and-reloading).
- Moving to another home layout costs one month of rent (house rule, SR5 has none) — [lifestyles](../modules/lifestyles.md#homes).
- The wireless smartgun bonus is a note, not added automatically — [characters](../modules/characters.md#nested-items-accessories-mods-options-techniques).
- House rules of karma advancement are flagged in `shared/advancement.ts` — [advancement.md](advancement.md).

## Pages

| page | rules |
|---|---|
| [dice-and-tests.md](dice-and-tests.md) | pools, limits, Edge, wound modifiers, attribute-only tests |
| [combat.md](combat.md) | initiative, damage, fire modes & reloading, range & environment, area weapons, toxins, defense, soak |
| [vehicles.md](vehicles.md) | Vehicle Tests, rigging limits and thresholds, gunnery, sensors, vehicle damage, ramming, drones, chase combat |
| [matrix.md](matrix.md) | Matrix initiative and limits, Overwatch, convergence, IC, agents |
| [magic.md](magic.md) | adept powers, foci, drain, initiation |
| [chargen.md](chargen.md) | Priority creation, NPC Professional Rating |
| [availability-and-shop.md](availability-and-shop.md) | availability test, delivery, overpay, legality, upgrades availability, lifestyle cost, martial arts |
| [advancement.md](advancement.md) | karma costs, training time |
| [modifiers-stacking.md](modifiers-stacking.md) | what stacks: armor, accessories, baked bonuses, monitors, limits |

Rules documented with their feature: SIN verification (SR5 p. 364) and contacts (SR5 p. 387-389) in
[contacts-sins](../modules/contacts-sins.md); the rule page of each skill / test (`SKILL_PAGES`, `RULE_REFS`) in
[book-refs](../modules/book-refs.md).
