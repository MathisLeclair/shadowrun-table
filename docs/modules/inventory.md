# Inventory: names, ammunition, ready weapons, containers

Part of the characters module. Rules in `client/modules/sheet/inventory.ts` (pure, shared by server and sheet); UI
`tab-inventory.tsx`, `weapon-ui.tsx`; server `server/modules/10-characters.ts`. Tests: `node tools/test-inventory.ts`
(ports 3443-3445). SR5 fire-mode and reload rules: [rules/combat.md](../rules/combat.md#fire-modes-ammunition-and-reloading).

## Names in both languages

`item.nameFr` / `item.nameEn` and `categoryFr` / `categoryEn` (weapons, armor, gear, augmentations, vehicles) are filled
by `10-characters.ts fillItemNames` (boot + every characters action, missing fields only) from the catalog entry of
`catalogId` — names only when the stored name IS a catalog name (renamed items keep theirs), categories when the stored
one is the catalog's or empty; an item without `catalogId` gets one by exact English / French catalog name (never
overwritten; weapons also take names from weapon-like gear: grenades). A GM change of name / category / catalogId
clears them. Display: `sheet/common.tsx itemLabel(item)` (FR: nameFr › name; EN: nameEn › name), `itemTitle` (stored /
other name in the tooltip), `categoryLabel`, `modeLabel` (FR CC/SA/TR/TA, EN SS/SA/BF/FA), `damageLabel` (FR « E » =
Stun). The stored `name` is never changed. A weapon ammo without reload type (Foundry « 14 ») takes the catalog's
(« 14(c) ») when the capacity matches (`fillItemNames` returns true then and the caller runs `normalizeActor` again, so
`ammoType` follows at once). Log / error params name items with `biName(item)` = `{ fr, en }` (format.ts picks the
viewer's language); a weapon attack roll carries `labelI18n { key: 'Attack — {weapon}', params: { weapon: { fr, en } } }`
(`sheet/common.tsx` `rollLabel`).

## Ammunition

`ammo` « 15(c) » → `ammoMax` 15 / `ammoType` (c clip, m internal magazine, b break action, d drum, cy cylinder, belt,
ml muzzle loader; Foundry 'ceinture' / 'tambour' mapped), recomputed by `normalizeActor` (`normalizeInventory`);
`ammoLoaded` defaults to full (the old `ammoLeft` is adopted then deleted; `actor/updateItem { ammoLeft }` still means
ammoLoaded); `ammoKind` defaults to regular rounds (`DEFAULT_AMMO`: gun / taser / bow).

### Firing
`dice/roll` with the `weaponId` of a weapon with `ammoMax` uses the rounds of `fireMode` (`FIRE_OPTIONS`; absent = the
weapon's first mode; a mode the weapon lacks is refused), checked before the roll. Fewer rounds than the mode: fires
what is left, `short` = missing rounds, defense modifier (`defense`) and narrower suppressive fire (`narrower`) per the
rules; an empty weapon → « Plus assez de munitions — recharge » (GM: `ammoOverride` fires 0 round);
`roll.fire = { mode, rounds, left, max, short?, defense?, narrower? }`. The weapon must be within reach (carried or in
a bag; GM: anywhere) for `dice/roll`, `weapon/fire` and `weapon/reload`.

Grenades (`isGrenade` = `isThrownExplosive`: throwing skill or none, name / category « grenade » / « explosive »; never
a magazine — Chummer's « <ammo>1</ammo> » is dropped): a throw uses one `qty` (default 1), the last one removes the
weapon (`roll.fire.item`). Launcher profiles (`isLauncherProfile`: « Minigrenade: … » entries, never offered as a
weapon) and grenade launchers are not single-use (the launcher's magazine is used). Thrown weapons added as gear
(catalog gear with throwing-weapon stats: grenades, Molotovs, throwing knives — shop, sheet, bestiary templates) are
moved to `weapons` with their qty (`thrownGearToWeapons`: on add / boot / spawn / shop delivery; same weapon → qty
grows).

`weapon/fire { actorId, weaponId, mode?, override? }` = the same without a roll (logged). Melee weapons are untouched.

### Reload
`weapon/reload { actorId, weaponId, sourceItemId?, free? (GM) }` (owner / GM) — one action (`reloadPlan`; action cost
per reload type in the rules): rounds come from compatible ammunition gear (`ammoFits`: ammo class from Chummer
`ammoFor` / names — « Ammo: », « Arrow: », « Taser Dart »…, Foundry's original name kept in `notes` —; firearm rounds
restricted by the weapon category in parentheses « (Sniper Rifles) » or Chummer `choice`), carried first then bags,
never from a vehicle / safehouse; the box's `qty` goes down (kept at 0). A spare clip of that weapon (« Spare Clip
(Ares Desert Strike) », `clipFits`) = clip change, clips kept; without one (« Fill Clip / Belt / Drum ») rounds are
loaded one by one. Other ammunition than the loaded kind: the rounds taken out go back to a box of their kind (within
reach first; created « Sur soi » if none). Without `sourceItemId`, a weapon that still holds rounds is only reloaded
from its loaded kind (« Plus de {ammo} à portée : choisis d’autres munitions »); the sheet's ↻ opens the chooser
instead of reloading at once when the only source is another kind.
Returns `{ loaded, ammoLoaded, max, action, swap, sourceId, clipId, returned, dropped }`; logged.

## Ready weapons and locations

`weapon.equipped` (« prête » / « rangée »; unarmed always ready). Defaults (idempotent): flags already set are kept;
otherwise the first carried ranged weapon and the first carried melee weapon when none is ready. Soft limit: more than
2 ranged + 2 melee ready (unarmed, grenades not counted) → warning (`readyCount`), never a block. The Combat tab and the
roll dialog list the ready weapons (« afficher tout »).

`item.location` (weapons, armor, gear) = 'on' (« Sur soi », implicit) or a container id; unknown → 'on'. In a 'bag' /
'vehicle' / 'safehouse' / 'other' container an item is never ready / worn / active (switched off); readying / wearing /
activating it moves it 'on' from a bag (`settleItem`); from a vehicle / safehouse / other place players are refused
(« hors de portée »; GM: moved 'on'). 'body' containers (holster, vest) count as carried. Players cannot change the
kind of a vehicle / safehouse / other container, nor remove one that still holds items; moving an item out of one
(`inventory/move`, `location` patch) is allowed and logged (« {name} récupère {item} ({place}) ») so the GM sees it.

Containers: `containers: [{ id, name, kind: 'body'|'bag'|'vehicle'|'safehouse'|'other', notes?, itemId? }]` (`itemId`:
the gear item the container is — a Chummer bag, see Imports) (« Sur soi » = 'on',
implicit). Actions (owner / GM): `inventory/addContainer { actorId, name, kind? }` → id (kind guessed from the name),
`inventory/updateContainer { actorId, containerId, patch: { name?, kind?, notes? } }`, `inventory/removeContainer`
(contents back 'on') → count, `inventory/move { actorId, list, itemId, location }` → `{ location, stowed }`;
`actor/updateItem` also accepts `location` / `equipped` from players.

## Imports

Foundry `system.inventories` (« All » skipped) → containers `fvtt_inv_<slug>` + item locations (a weapon / armor
Foundry marks equipped stays 'on'), weapon `ammoLoaded` (system.ammo.current.value), thrown weapon `qty`. These
inventory fields are never part of the Foundry item hashes (`importer.ts INVENTORY_FIELDS`: old snapshots stay valid);
a merge keeps the app's location / ammoLoaded / ammoKind / grenade qty, adds the Foundry containers the app lacks and
moves the matching items that are still 'on' into them (live actors adopt Foundry's bags once).

Chummer: `<gearlocations>` / `<armorlocations>` / `<weaponlocations>` → containers `chum_<guid>`, item `<location>`
(guid, or name in old files), weapon `<equipped>`, active clip count / ammo (`<clips>`, `<activeammoslot>`), gear
`<ammoforweapontype>` → `ammoFor`; weapon `<equipped>` is NOT imported as ready (Chummer marks nearly every weapon
equipped: the app's ready defaults apply) and never written from it; export writes `<location>` (creating the Chummer
location of an app container, matched by guid then name), the active clip's count when the file has clips; re-import
(merge.ts) adds new containers.

Chummer bags (gear holding gear: a backpack and its contents, `parse.ts pushGear` / `isBagGear`): a gear node with
children (not `includedinparent`) is a bag when its name (`gearname` or `name`) guesses kind 'bag' (backpack, case,
sac…), or when none of its children is an accessory of it — an accessory has a capacity slot « [n] », a category the
parent lists in `<addoncategory>` (file or data), or the parent's own category other than Custom (rope of a grapple gun, medkit refills);
matrix devices never are. The bag stays a gear item (cost, notes, its own location) and gets a container
`chumgear_<guid>` (kind 'bag', `itemId` = that item's id); its children are placed in it without the « in {bag} » note
(bags in bags nest the same way). Accessories stay flat items noted « in {parent} », at their parent's location (rope
of a grapple gun in a backpack → in the backpack). Export (`export.ts placeBagContents`): gear in a container linked
to a gear item becomes a `<children>` entry of that item's node, gear taken out of it goes back to the top-level
`<gears>`, never a Chummer `<gearlocation>`; gear deleted in the app leaves the children the app still has at the top
level. Weapons / armor put in a bag are exported with a Chummer location of the bag's name (Chummer cannot put them
in gear). Re-import: a new bag's `itemId` is pointed at the merged item (same `chummerGuid`). Characters imported
before bags existed (2026-11-28): `85-chummer init` runs `lib/chummer/bags.ts adoptChummerBags` once per actor
(flag `chummer.bags`, set by new imports and exports too): it re-reads the stored .chum5, adds the bag containers and
moves the contents that are still « Sur soi », dropping the old « in {bag} » note when the rest is the imported note.

## Live table migration

`init` runs `normalizeActor` (containers [], locations 'on', ammo fields, ready defaults) and `fillItemNames` on every
actor at every boot — idempotent (`tools/test-inventory.ts` boots twice).
