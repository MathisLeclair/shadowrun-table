# Contacts & SINs

The sheet's « Contacts & SIN » tab (characters module, `server/modules/10-characters.ts`). Both features carry their
SR5 rule with them (page references inline). Lifestyles shown in the same tab: [lifestyles.md](lifestyles.md).

## SINs

Rules `shared/sins.ts`, UI `client/modules/sheet/sins.tsx` + `sins.css`, test `node tools/test-sins.ts` (port 3960).
- `sins[]` items `{ id, name, rating, licenses: string[] (« Driver's License (4) »: a « (n) » is that license's rating,
  else the SIN's), notes?, real? (legal SIN: never checked), burned?, burnedAt? }`.
- The tab shows each one as an ID card (identity without « Faux SIN — », decorative `sinNumber(id)`, Fake SIN Details
  text of its rating, licenses, « Grillé » stamp); « Présenter / contrôler » opens the big card + verification panel
  (system rating 1-6 with the SIN Verification Details text, SIN or one license, odds `checkOdds`).
- `'actor/sinCheck' { actorId, sinId, license?: index, device: 1-6, secret? (GM) }` (owner or GM; SR5 p. 364): Device
  Rating × 2 dice, threshold = SIN / license rating; hits < threshold `pass`, = `odd`, > `burned` → the SIN gets
  `burned` (not on a secret roll: the GM decides). Log entry `kind: 'roll'`, `labelI18n` « Contrôle de SIN — {sin} » /
  « Contrôle de licence — {license} ({sin}) », `roll.sinCheck = { sinId, sin, device, threshold, license?,
  licenseIndex?, outcome, burnedNow? }` (LogDock `SinCheckLine`; no Edge: `dice/secondChance` refuses it). A burned SIN
  fails automatically without a roll (system log).
- `'actor/sinBurn' { actorId, sinId, burned }` (GM: « Griller » / « Restaurer » on the card); the GM's list editor also
  has « Vrai SIN » / « Grillé ».

## Contacts

Rules + tables `shared/contacts.ts`, UI `client/modules/sheet/contacts.tsx` + `contacts.css`, test
`node tools/test-contacts.ts` (port 3962); SR5 p. 387-389.
- Each contact (`{ id, name, connection, loyalty, notes? }`) is a dossier card (portrait / color of its sheet,
  Connection 1-12 and Loyalty 1-6 gauges with the Connection / Loyalty table texts, the owner's inline notes).
- « Contacter » = the dossier full size + usual fee (`contactFees`: Connection × 100 ¥ info, × 1 000 ¥ goods, Loyalty ×
  10 % off) + Favor Rating table (≤ Loyalty « accepte ») + rolls.
- `contactSheet(state, contact)` = the contact's stats from an NPC actor, else a bestiary template, of the same name
  (also the shop's contact search, [shop.md](shop.md#contact-search); players read it from
  `view.shop.contactSearch[actorId]`, the GM computes it).
- `'actor/contactRoll' { actorId, contactId, kind, modifier?, secret? (GM) }` (owner or GM):
  - `reach`: 2D6 (plain `total`, no hits) ≥ Connection → `available`;
  - `negotiate`: the runner's Negotiation + CHA [Social] through `performRoll` (modifiers, Edge) + Loyalty dice +
    `bribe` bought dice (`bribeCost` 100 × (7 − Loyalty) ¥ each, shown, not charged);
  - `legwork` (contact's Connection + CHA [Social], one hour of the extended test, the GM adds hits) and `network`
    (contact's Etiquette + CHA + Connection [Social] vs `threshold` = target's Connection, `success`) need the contact's
    sheet, are logged under the contact's name with `actorId: null` (no Edge).
- `roll.contactRoll = { kind, contactId, contact, connection, loyalty, total?, available?, bribe?, bribeCost?,
  threshold?, success?, via? }` → LogDock `ContactRollLine`. `dice/secondChance` refuses rolls without hits; the 3D
  dice banner shows `total` when there are no hits.
