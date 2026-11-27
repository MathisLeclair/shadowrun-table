# Dice pools, limits and tests

Applied by `dice/roll` ([modules/dice.md](../modules/dice.md)) for every roll of the sheet, the attack tray, the shop
and the Matrix. Modifiers on pools and limits: [modifiers-stacking.md](modifiers-stacking.md).

## Limits (SR5 p. 46)

- Default roll limit: `skillDefaultLimit(def, attr)` (shared/sr5.ts) — a skill's own `limit`
  ('physical'|'mental'|'social'|'astral', or null = none, e.g. spellcasting/pilot) overrides its category.
- A computed limit is ≥ 1. Players can neither raise nor remove a computed limit; the GM may set any limit or none.
- Matrix tests use the deck's attributes as limits ([matrix.md](matrix.md)).

## Edge (SR5 p. 56)

- Push the Limit (`explode`): adds EDG to the pool, rule of six, ignores the limit and spends 1 Edge.
- Second Chance (`dice/secondChance`): rerolls every die that is not a hit; no Edge on SIN checks or rolls made by a
  contact.

## Wound modifiers (SR5 p. 169)

- The wound modifier always applies to a player's skill / attribute roll, except damage resistance tests
  (`RESIST_TESTS`); only the GM can switch it off (`applyWounds`). It also applies to the initiative score.
- Pain tolerance changes it (`derivedWithModifiers`); the « nauseous » affliction doubles it (`woundFactor`,
  [combat.md](combat.md#toxins-and-afflictions)).

## Attribute-only tests (SR5 p. 152)

`test`: 'composure'|'judgeIntentions'|'memory'|'liftCarry'|'defense'|'soak'|'drainResist'|'biofeedback'|'toxinResist' —
accepted only on a roll of that test's attributes (`shared/modifiers.ts TEST_ATTRS` / `checkedTest`), so its
modifiers (`stat` effects: composure, memory, soak…) apply. Defense and soak: [combat.md](combat.md); drain: [magic.md](magic.md);
biofeedback: [matrix.md](matrix.md).
