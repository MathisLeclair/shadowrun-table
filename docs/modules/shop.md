# Shop

| | |
|---|---|
| server | `server/modules/40-shop.ts` (owner of `state.shop`) |
| rules | `client/modules/shop/rules.ts` (pure, shared with the server and the character creator) |
| client | `client/modules/shop/` (ShopPage, `avail.tsx`, `upgrades.ts`, `Customize.tsx` + `WeaponSlots.tsx`: weapon slots) |
| catalog | `data/catalog/*.json` built by `tools/build-catalog.ts` (`npm run build:catalog`) |
| tests | `node tools/test-shop.ts` (port 3250: mounts, capacity, slots, target-based prices, resale of parts, martial arts, availability tests) |

Upgrades (accessories, armor / vehicle mods, lifestyle options, martial arts): [shop-upgrades.md](shop-upgrades.md).
Lifestyles: [lifestyles.md](lifestyles.md). SR5 rules (availability test, delivery, legality, sell rate):
[rules/availability-and-shop.md](../rules/availability-and-shop.md).

## State

`ShopState`, `ShopOrder`, `OrderLine`, `AvailTest`, `ShopSpecial`, `ContactSheet` in types.ts. Facts the types don't
say:
- Settings: `markup` (percent), `sellRate` (50: percent of price paid back), `maxAvail` (12), `allowRestricted`,
  `allowForbidden`, `approval: 'never'|'restricted'|'always'` (when a purchase needs GM approval), `availTest:
  'required'|'helper'|'off'`, `availFree` (items with Availability ≤ availFree need no test), `categories` (which
  catalogs are on sale).
- `specials` = GM-curated items / fixer deals (`{ id, name, category, cost, avail, stock, notes, stats?, catalogRef? }`).
- `orders[].kind`: 'buy'|'sell'|'give'|'karma'; `status`: 'pending'|'approved'|'denied'|'done'|'cancelled'; lines may
  carry `target`, `mount`, `subId`, `karma`, `techniqueIds`, `availTest`, `surcharge`; `flags` (e.g. `rent`), `gmNote`.
- `availTests` (max 300; players see their actors' only); `restored` (historic Chummer upgrades already restored, GM
  view only); `contactSearch` (player view only, below).

## Availability test

Pure rules `AVAIL_TEST_MODES / availTestable / needsAvailTest / availBaseHours / availOutcome / durationText /
matchAvailTests` in `client/modules/shop/rules.ts`, UI `client/modules/shop/avail.tsx`.
- `'shop/availTest' { actorId, item: cart line, useSpec?, explode?, modifier? }` (owner or GM) rolls through
  `performRoll` (log entry `roll.avail = { testId, value, legality, dice, hits, baseHours, tries }`, `roll.labelI18n`
  « Availability — {item} ») and stores the test. The outcome is always recomputed from the log entry's live `hits` /
  `glitch` / `critGlitch` (Edge « Seconde chance »); a glitch is kept on the test / order line (`glitch`).
- **Overpay** (`overpay`): breakdown « overpay +n », runner or contact roll; paid only when the item is bought: the
  claimed line gets `surcharge` per unit, included in the order total (unitCost / `paid` stay the item price, so resale
  ignores it), note « {item}: found in {delay} (overpay {cost}) »; the cart and the orders show « dont +{cost} ».
  `matchAvailTests` uses the cheapest search first.
- Players cannot search what `checkRules` forbids. Failures are not time-locked: the cart shows « nouvel essai après {2
  × base} en jeu » and `tries` counts attempts.
- **Buying** (players only): `required` refuses a line without an unused successful test of the same `ref` + target
  with tested Availability ≥ the line's (one test per line, `matchAvailTests`, same matching in the cart); `helper`
  only records the tests it finds. Claimed tests go on the order lines (`availTest`, note « {item} : trouvé en {delay}
  ») and become `used`; a denied / cancelled order gives them back (`open`). GM sales and gifts never need one.

### Contact search
`contactId` on `'shop/availTest'`: one of the runner's contacts makes the test instead. Stats come from an NPC actor,
else a bestiary template, whose name matches the contact's (accent/case-insensitive); a contact without one cannot
search (« contact sans fiche », the GM creates the NPC). The log entry (author = the runner, `actorId: null`,
`labelI18n` « Availability — {item} (via {contact}) », `avail.contact`) and the test (`contactId`, `contactName`;
order line `availTest.contact`) name the contact. Players get `view.shop.contactSearch = { [ownActorId]: [{ id, name,
connection, known, source?, cha?, negotiation?, pool?, defaulting?, social?, limit? }] }` (the bestiary stays hidden).
No fee or Availability cap: the GM adds a price by hand if wanted. Contact dossiers: [contacts-sins.md](contacts-sins.md).

## Orders, selling, events

- Buying adds the item to the actor (weapons → `actor.weapons`, armor → `actor.armor`, cyber/bio → `actor.augmentations`
  (and reduces ESS), vehicles → `actor.vehicles`, everything else → `actor.gear`) and deducts nuyen, appends
  `actor.history` and a `kind:'shop'` log entry.
- `'shop/cancel'` (owner or GM) cancels a pending order. Transient event `'shop:resolved'` `{ orderId, status, note }`
  is sent to the actor's owners when the GM approves/denies.
- Selling: gear can only be sold up to its current `qty` (≥ 1); implant weapons (`augId`) are not sellable (sell the
  augmentation).
- Actions: `shop/buy|availTest|give|sell|removeUpgrade|setAccessory|resolve|cancel|martialArt|updateSettings|addSpecial|
  updateSpecial|removeSpecial|payLifestyle|chooseHome|clearOrders`.

## Catalog files

Generated, `data/catalog/<name>.json`, loaded with `useCatalog(name)` client-side and read from disk server-side for
price validation: `weapons`, `armor`, `gear`, `cyberware`, `bioware`, `vehicles`, `qualities`, `spells`, `powers`,
`programs`, `lifestyles`, and the upgrade catalogs `accessories`, `armormods`, `vehiclemods`, `lifestylequalities`,
`martialarts` ([shop-upgrades.md](shop-upgrades.md#catalogs)). Each item (`CatalogItem`): `{ id, name, nameFr?,
category, cost: number|null, costFormula?: string, avail: '8R', availValue: 8, legality: ''|'R'|'F', availRelative?:
true (upgrade catalogs: Chummer « +2R », added to the target's availability — `avail` keeps the « + »), rating?: { min,
max }, essence?: number|string, source, page, stats: {...type-specific}, effects? }` (effects:
[modifiers.md](modifiers.md#catalog-effects)).
