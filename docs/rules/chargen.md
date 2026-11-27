# Character creation rules

Feature (drafts, approval, actions, UI): [modules/chargen.md](../modules/chargen.md).

## Priority system (SR5 p. 62-107)

- SR5 Priority system, letters A–E for metatype, attributes, magic/resonance, skills, resources (priority table SR5
  65; each creator step carries its page, `CHARGEN_STEP_REFS`, SR5 62-100). Code: `shared/chargen.ts` (`compute(data,
  { lookup, rules, settings })`), the same check on the client (live) and on the server (submit / approval).
- Gear prices and availability come from `client/modules/shop/rules.ts` (same authority as the shop,
  [availability-and-shop.md](availability-and-shop.md)); weapon accessories and armor mods are priced with their
  target's value (`WeaponCost`, `ArmorCost`, `Capacity`, « +2R » availability) and fitted with the shop rules (mount
  points incl. the weapon's included accessories, capacity, duplicates).
- Settings: `startingKarmaBonus` adds karma; starting nuyen is rolled at approval when asked.

## NPCs (SR5 p. 381-385)

The enemy generator (`shared/npcgen.ts`) builds deterministic tiered NPCs by Professional Rating 0–6 with the grunt
rules (core p. 381-385), optionally with a lieutenant.
