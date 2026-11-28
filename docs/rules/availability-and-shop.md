# Availability, shop and lifestyle rules

Code: `client/modules/shop/rules.ts` (pure, shared by server, shop and character creator), `shared/lifestyle.ts`.
Features: [shop](../modules/shop.md), [shop upgrades](../modules/shop-upgrades.md), [lifestyles](../modules/lifestyles.md).

## Availability test (SR5 p. 418)

Text checked against the core PDF (SR5 p. 418 « Black Market Goods », « Contacts and Availability »).
- Negotiation + Charisma [Social] (gear modifiers, wounds, Social limit, Edge) opposed by dice = the item's
  Availability. Net hits = hits − availability hits.
- Delivery time = Delivery Times table by unit price (≤ 100 ¥ 6 h, ≤ 1 000 ¥ 1 day, ≤ 10 000 ¥ 2 days, ≤ 100 000 ¥ 1
  week, more 1 month) ÷ net hits; a tie finds the item in twice the table time; a failure may retry after twice the
  table time (`retryHours`); a glitch means unwanted attention (GM's call); a critical glitch never finds the item.
- **Overpay**: +1 die per extra 25 % of the item's value offered (0–12 dice, `clampOverpay`); the surcharge
  `overpaySurcharge(unitCost, dice)` per unit is paid only when the item is bought.
- **Contacts**: one of the runner's contacts may make the test instead, with their own Charisma + Negotiation
  (defaulting CHA − 1) and Social limit + the contact's Connection (`contactInfo`); no runner Edge, specialization or
  gear on that roll.
- No test for fixer specials, lifestyles / lifestyle options or Availability 0.
- Not implemented: the Run Faster qualities Black Market Pipeline (+2 dice, −10 % via one contact) / Made Man (+1 die,
  −10 %). Failures are not time-locked (no game clock).

## Legality and limits

- Catalog availability `avail: '8R'` → `availValue: 8`, `legality: ''|'R'|'F'`. The shop settings cap what can be
  bought (`maxAvail`, `allowRestricted`, `allowForbidden`) and when the GM approves (`approval`).
- Upgrade catalogs give a relative availability (Chummer « +2R », `availRelative`): `upgradeAvail(q, item,
  targetQuote)` adds the target's availability and keeps the stricter legality.
- Selling pays back `sellRate` (default 50 %) of the price paid (`paid`, else `cost`); included parts are worth 0.

## Lifestyle cost

`shared/lifestyle.ts monthlyCost()`, Chummer's order: (baseCost × (1 + Σ baseOnly %/100) + Σ cost of non-'Contracts'
options + RF points × pointCost) × (1 + Σ other %/100) + Σ cost of 'Contracts' options; Medium + Garage + Dangerous
Area = 4 080.

## Martial arts (RG p. 128)

Karma (`martialKarma(style, known, n)`) = the style's `stats.karma` (7; Way of Unified Mana (Hapsum-Do) 15) for a new
style (its first technique included) + 5 per further technique, 5 per technique of a known style — a known style
without any technique (bought without, imported) still gets its first technique included.

Learning time and instruction cost (RG p.128 « Learning martial arts » table): new style 1 month (first technique
included), 2,500¥ of instruction; further technique 2 weeks, 1,500¥. Players learn martial arts as a `martialArt`
training request, with the same karma: see [advancement.md](advancement.md#martial-arts-rg-p-128).
