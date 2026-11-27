# What stacks: modifiers, armor, baked bonuses

How item effects combine on rolls, limits and derived values. The pipeline (catalog effects, conditions, helpers, UI)
is in [modules/modifiers.md](../modules/modifiers.md). When stacking is unclear, do what Chummer does
([README](README.md#follow-chummer-when-ambiguous)).

## Armor

- One outfit at a time (like `armorTotal()`): only the best non-stacking worn armor plus the `stack` pieces (helmet /
  shield adds; `equipped !== false`), each with the armor bonus of its equipped mods (computation:
  [characters](../modules/characters.md#nested-items-accessories-mods-options-techniques)).
- Armor `rating` is the BASE value (Chummer `<armor>`, Foundry `armor.base`); armor « Rating » formulas of effects use
  `armor.itemRating`.
- Implants and powers (Mystic Armor) add through `armor` effects (`derivedWithModifiers`).

## Attributes and accessories

- Attribute bonuses from 'ware / powers (`actor.augmented`) are capped at +4 (`sr5.attr`).
- Weapon accessories with the same `rcGroup`: the best one only. Smartgun: no Accuracy, +1 die wired / +2 wireless (a
  note, not added automatically).
- Wireless bonuses need the « Bonus sans fil actifs » switch; conditional bonuses need their switch (unknown conditions
  are never applied silently).

## No double counting

Attribute bonuses and initiative dice / score bonuses (`attribute`, `initiativeDice`, `initiative`) are already STORED
on the actor — `actor.augmented` / `actor.initiative`, filled by `server/lib/augment.ts` (shop, sheet, training:
`augmentations[].bonus`, `powers[].bonus`), by the Foundry import (active effects + known boosts, `convert-actor.ts`)
and by the Chummer import (`<totalvalue>` and improvements, `parse.ts`). They are `baked: true` only when really
stored: the item records it (`item.bonus`: `server/lib/augment.ts bakeItemBonus` from the catalog effects — sheet
`actor/addItem` / `updateItem` of augmentations, powers, qualities; shop; training; creator; enemy generator —
initiative score and « select attribute » included), the item comes from an import (`fvtt_` id / `chummerGuid`:
`importedItem()`), or the stored value still has room for it (hand-made templates). Otherwise `unbaked: true`: shown
« non compté (à reporter par le MJ) », never added. Everything else is stored nowhere and is applied: skill ratings,
limits, monitors and armor ratings of both imports are base values (Foundry armor `rating` = `armor.base`; Chummer
monitors are recomputed). Imported unarmed / thrown weapons keep `accuracy: 'Physical'` (± n), never a frozen number.

## Monitors

An `actor.monitors` override wins over monitor bonuses (shown « ignoré : valeur forcée ») and is kept as is: 0 = no
such track (grunts, drones: stun damage goes to Physical; hosts). Damage Compensators (`sharedThresholdOffset`) offset
both tracks together, Physical first.

## Limits and player rolls

- A computed limit is ≥ 1; players can neither raise nor remove it ([dice-and-tests.md](dice-and-tests.md#limits-sr5-p-46)).
- Players may only leave out bonuses (`ignore`); maluses always apply. The GM may leave out anything.
- Matrix limits: [matrix.md](matrix.md#initiative-and-limits).
