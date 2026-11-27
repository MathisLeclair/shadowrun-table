# Dice rolls & 3D dice

Every skill, attribute and weapon roll goes through `dice/roll` (characters module, `server/modules/10-characters.ts`);
the server rolls (Math.random) and computes pool and limit modifiers itself ([modifiers.md](modifiers.md)). SR5 rules
behind it (limits, Edge, wounds, tests): [rules/dice-and-tests.md](../rules/dice-and-tests.md).

## `dice/roll`

Payload `{ pool, label, actorId?, skillId?, attr?, attr2?, useSpec?, … }` plus:
- `test?` ('composure'|'judgeIntentions'|'memory'|'liftCarry'|'defense'|'soak'|'drainResist'|'biofeedback'|
  'toxinResist'): kept only on an attribute-only roll of that test's attributes (`shared/modifiers.ts TEST_ATTRS` /
  `checkedTest`).
- `weaponId?`: the weapon's skill is used; only the GM may roll it with another `skillId`.
- `matrixLimit?` ('attack'|'sleaze'|'dataProcessing'|'firewall'; Matrix skills only: `MATRIX_LIMIT_SKILLS`).
- `conditions?: [switch keys]`, `ignore?: [modifier ids]` ([modifiers.md](modifiers.md)).
- `limit?` (number = that limit; null/0 = none; absent = computed — what players may change:
  [rules](../rules/dice-and-tests.md#limits-sr5-p-46)).
- `applyWounds?` (GM only; for players the wound modifier is forced:
  [rules](../rules/dice-and-tests.md#wound-modifiers-sr5-p-169)).
- `bonus?: [{label, value}]` (players: only « VOL » of total defense and « Firewall » of Matrix defense /
  biofeedback, recomputed; any other line counts as « mod. »).
- `explode?` (Edge: Push the Limit), `secret?` (GM only: gmOnly log), `modifier?`.
- `fireMode?`, `ammoOverride?` (GM): firing a weapon with a magazine, see [inventory.md](inventory.md#firing).

→ logs `{ kind: 'roll', roll: {..., breakdown, limitLabel?, limitBreakdown?, mods?: [ModLine], conditions?} }` and
emits `sfx { id: 'dice' }` to all. Types: `RollRecord`, `RollModLine`. Other roll records hang extra blocks on
`roll`: `fire` ([inventory](inventory.md)), `avail` ([shop](shop.md)), `sinCheck` / `contactRoll`
([contacts-sins](contacts-sins.md)), `labelI18n` (translatable label).

The characters module exports the body of `dice/roll` as `performRoll(ctx, payload, internal)` (same modifiers, log
entry, Edge — `internal` = trusted named dice lines, fewer rounds, AP on soak, extra log fields), used by
[attacks](attacks.md), the shop availability test and contact rolls.

`dice/secondChance { logId }` = Edge « Seconde chance »: reroll every die that is not a hit (refused on SIN checks and
on rolls without hits, e.g. contact reach rolls).

## 3D dice

`client/modules/sheet/Dice3D.tsx` + `dice3d.css`, client only: every new log entry with `roll.dice` is thrown as CSS
3D cubes (`roll.extra` = a second wave; max 40 dice shown), then a banner shows hits / glitch badges (click = next).
Each die is simulated up front (`simulateDie`, exported for checks: fall, bounces, rolling without slipping until it
stops, lifted onto its lowest corner so it rocks over its edges; frames played with requestAnimationFrame, top-down
camera). The spin is computed forward and the orientation backward from the resting pose (the server's value facing
up, random yaw), so the die rolls straight into it — no snap at the end. Per-browser choice `localStorage['sr.dice3d']`
= `'off'` | `'mine'` (own rolls + rolls on own characters) | `'all'` (default: every roll the user can see), set with
`Dice3dPicker` (🎲 button in the Journal & dés bar). Entries present at load are never replayed; a burst keeps the
last 3, the queue at most 4. The banner shows `total` when there are no hits (contact reach rolls).
