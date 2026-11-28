# Characters & sheet

PC and NPC sheets: the `actors` slice, item lists, nested upgrades and who may change what.

| | |
|---|---|
| server | `server/modules/10-characters.ts` (owner of `state.actors`), `server/lib/augment.ts` (baked item bonuses) |
| shared | `shared/sr5.ts` (attributes, SKILLS, `derive()`, `skillPool()`, `armorTotal()`), `shared/types.ts` (`Actor` and item types) |
| client | `client/modules/sheet/` (SheetView, MySheet, CharactersPage, LogDock, `sheet-data.ts`, `common.tsx`) |
| tests | `node tools/test-characters.ts` (port 3270) |

Related pages: [dice](dice.md) (`dice/roll`), [inventory](inventory.md) (weapons, ammo, containers),
[lifestyles](lifestyles.md), [contacts & SINs](contacts-sins.md), [modifiers](modifiers.md), [training](training.md),
[book references](book-refs.md).

## State

`actors: { [id]: Actor }` — PCs and spawned NPCs share this schema (`Actor` in types.ts). Facts the type doesn't say:
- `skills[].id` is a `sr5.SKILLS` id (`'pistols'`) or a custom slug; `knowledge[].type` is street / academic /
  professional / interest / language.
- `augmented` = bonuses from 'ware/adept powers (cap +4 applied by `sr5.attr`); `initiative` = extra dice (wired
  reflexes…) and flat bonus; `monitors` = overrides (grunts/critters), default from `derive()`; `edge.current` (max =
  `attributes.EDG`).
- `notes` = owner + GM, `gmNotes` = GM only (stripped for players); `hidden` NPC: players don't see it in lists;
  `retired` PC no longer played (Ank'Lay).
- `vision` (`lowLight`, `thermo`, `darkRange` in cells) is used by the map; `npc` (professional rating, grunt, tactics,
  loot) for NPCs only.
- `training` is owned by the training module, `magic` is written by training ([training.md](training.md)).
- `history: [{ ts, text, karma?: delta, nuyen?: delta }]` = money/karma ledger, appended by shop/training/GM.
- Extra fields: `realName?`, `metavariant?` (Chummer), `chummer?` ([chummer.md](chummer.md)), items may carry
  `chummerGuid`, `source?` / `page?` on every item and nested item ([book-refs.md](book-refs.md)),
  `foundry: { id, world, importedAt }` (Foundry import), `afflictions` ([attacks.md](attacks.md)).
- `augmentations[].bonus` / `powers[].bonus` / `qualities[].bonus` = attribute / initiative bonus actually stored on the
  actor (`{ attributes: { REA: 1 }, initiativeDice: 1, initiative: 6 }`, from the catalog effects —
  `server/lib/augment.ts bakeItemBonus` — reversed on removal/sale, re-applied on a rating / level / choice change).
- `weapons[].augId` = implant weapon of that augmentation (removed with it, never sold separately).
- `gear[].paid` = unit price paid in the shop; map tokens carry `moveBudget: { key, meters }` (combat movement, maps
  module).

Derived values: `import { derive, skillPool, rollDice, attr, SKILLS, SKILL_BY_ID } from '/shared/sr5.ts'` — never store
derived numbers (with modifiers: `derivedWithModifiers` / `deriveFull`, [modifiers.md](modifiers.md)).
Default roll limit: `skillDefaultLimit(def, attr)` (shared/sr5.ts) — a skill's own `limit`
('physical'|'mental'|'social'|'astral', or null = none, e.g. spellcasting/pilot) overrides its category.

## Permissions

Player permissions on their own actor: condition, edge.current, armor equipped/location, gear qty (lower only — only
the GM raises a quantity)/notes/active/location, weapon notes/equipped/location/ammoLoaded (lower only), containers
(inventory/*), fire & reload (weapon/*), notes, portrait, bio, color, contacts notes. Attributes/skills/karma/nuyen/
qualities change only via GM edit, shop, or training.

Players' view of actors: own PCs without `gmNotes` and NPC tactics/loot; other PCs also without `notes`; visible NPCs
as `NpcStub` (`{ id, type, name, portrait, color, metatype, templateId, status }`); hidden NPCs removed.

## Actions

Sheet: `actor/create { type, name, ...fields } → id`, `actor/update { actorId, patch }`, `actor/delete { actorId } |
{ actorIds }`, `actor/duplicate { actorId, name? } → id`, `actor/adjust { actorId | actorIds, karma?, nuyen?, reason }`
(end-of-session rewards), `actor/heal { actorId, amount, type: 'P'|'S'|'all' }`, `edge/spend { actorId }` → remaining
Edge, `edge/refresh { actorId } | { all: true }`. Items: `actor/addItem|updateItem|removeItem` and the sub-item actions
below. Rolls: [dice.md](dice.md); `weapon/*`, `inventory/*`: [inventory.md](inventory.md); `actor/sinCheck|sinBurn|
contactRoll`: [contacts-sins.md](contacts-sins.md).

Damage: `'actor/damage'` `{ actorId, amount, type: 'P'|'S' }` (overflow rules: [rules/combat.md](../rules/combat.md#damage-sr5-p-169)). The combat UI calls it; the attacks module uses its body `applyDamage(ctx, actor, n, type)`.

## Nested items (accessories, mods, options, techniques)

Nested lists restore what the characters had in Chummer (upgrades lost on the way Chummer → Foundry → app). Sub-items
keep the English Chummer/catalog `name` and the French `nameFr` (display with `itemName()`), `catalogId` = Chummer
GUID, `chummerGuid` once synced. Types: `Accessory`, `ArmorMod`, `VehicleMod`, `LifestyleQuality`,
`MartialArtTechnique`. Facts the types don't say:
- `Accessory.mount`: 'Top'|'Under'|'Barrel'|'Stock'|'Side'|'Internal'|''; `included` = built in; `equipped: false` = off;
  `effects { accuracy?, rc?, rcGroup? (same group: best one only), dicePool?, smartgun? }`.
- `ArmorMod.capacity` may be < 0 (YNT Softweave adds room); `effects { armor? }`.
- `VehicleMod`: `slots`, `category`.
- Weapons: `mounts?: ['Top'|'Under'|'Barrel'|'Stock'|'Side']`, `accessories`; `accuracy` / `rc` are BASE values,
  accessories add. Armor: `capacity?`, `mods`.
- Martial arts: `martialArts: [{ id, catalogId?, name, rating (1), techniques: [{ id, catalogId?, name, nameFr?, notes?,
  chummerGuid? }], notes?, chummerGuid? }]`. Lifestyles: [lifestyles.md](lifestyles.md).

Pure helpers (`client/modules/sheet/sheet-data.ts`): `SUB_LISTS` (`weapons → accessories`, `armor → mods`,
`vehicles → mods`, `lifestyles → qualities`, `martialArts → techniques`), `weaponMods(w)` → `{ accuracy, rc, dicePool,
smartgun }`, `armorMods(ar)` → `{ used, total, bonus }`, `vehicleSlots(v)` (total used) / `vehicleSlotsByCategory(v)`
(per R5 pool, labels `VEHICLE_MOD_CATEGORIES`), `catalogToItem()` / `subFromCatalog(catalog, entry, rating)` for the
catalogs `lifestyles`, `martialarts`, `lifestylequalities`, `accessories`, `armormods`, `vehiclemods`. `normalizeActor`
gives every actor `lifestyles: []` / `martialArts: []`, ids to nested items, one primary lifestyle (legacy migration:
[lifestyles.md](lifestyles.md)).

Players switch weapon accessories on / off and move them between mounts with `shop/setAccessory`
([shop-upgrades.md](shop-upgrades.md#actions)).

Actions (GM; players read-only): `actor/addItem|updateItem|removeItem` accept the lists `lifestyles` and `martialArts`
(lifestyle: `monthlyCost` is always recomputed, `primary: true` moves the primary flag) and sanitize nested arrays
passed with an item; `actor/addSubItem { actorId, list, itemId, sub: 'accessories'|'mods'|'qualities'|'techniques',
item } → subId`, `actor/updateSubItem { …, subId, patch }`, `actor/removeSubItem { …, subId }` (`sub` must match
`SUB_LISTS[list]`, else « Sous-liste inconnue : {sub} »). Sanitizing (`sanitizeSub`) keeps the shop-only fields on GM
edits: `paid`, `choice`, accessory `extraMount` / `effects`, armor-mod `effects.armor` / `bonus`, vehicle-mod `effects`.

Display: the sheet shows the accuracy / RC of a weapon WITH its accessories (`weaponMods`), a « smartgun » badge (+2
dice with a wireless smartlink: a note, not added automatically), accessory `dicePool` added to the attack roll; armor
rows show their mods, « Capacité used/total » and the mods' armor bonus (`+2` from Gel Packs — counted:
`shared/sr5.ts armorTotal()` adds Σ `mods[].effects.armor` of equipped mods to each equipped armor, `armorValue(a)` /
`armorModBonus(a)`; armor `rating` is the BASE value: Chummer `<armor>`, Foundry `armor.base` — a Foundry rating taken
from `armor.value` (mods included) gets no `effects.armor`, nor do restored mods with `ratingIncludesMods`); vehicles
their mods and slots (« 9 emplacements utilisés (Protection 6 · Carrosserie 3) »); « Contacts & SIN » the lifestyles
(cost breakdown, options); « Combat » the « Arts martiaux ». GM edit mode: a « Accessoires / Modifications / Options /
Techniques (n) » button on each row of the list editor opens the nested editor (blank or from the catalog; techniques
from the martial art's `stats.techniques`). A catalog pick gets the values that depend on the parent item from
`rules.ts upgradeFields()` (the parent's catalog entry is loaded): capacity with its Capacity (YNT Softweave), slots
with its Body (Gecko Tips), price with its value (« Weapon Cost »…; left at the catalog price when the parent's value
is unknown).

Buying, fitting and selling upgrades: [shop-upgrades.md](shop-upgrades.md). Chummer and Foundry mapping of nested
lists: [chummer.md](chummer.md#nested-lists), [foundry.md](foundry.md#nested-lists).
