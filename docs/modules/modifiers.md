# Modifiers (gear, clothing, qualities, adept powers, implants → rolls, limits, derived values)

Chummer `<bonus>` / `<wirelessbonus>` data makes items count like in a real VTT: Jane wears « Zoé : Heritage 12 »
(RG 62: +2 social limit while visible) → her Con test shows « Limite sociale 9 + Zoé : Heritage 12 +2 = 11 » when
« Tenue visible » is on, and the sheet shows « 9 (11 si visible) ». What stacks with what (and what is never counted
twice): [rules/modifiers-stacking.md](../rules/modifiers-stacking.md).

```
tools/lib/bonus-effects.ts   Chummer XML <bonus> node → normalized effects (pure; build time)
tools/lib/effect-overrides.ts hand-written effects of entries whose rule is in the book text only (merged at build time)
tools/build-catalog.ts       catalog entries get `effects`; writes data/catalog/effects.json (runtime index), effects-coverage.md, qualities-coverage.md
shared/modifiers.ts          collectModifiers / poolModifiers / limitFor / weaponAccuracy / derivedWithModifiers (pure, server + browser)
server/lib/modifiers.ts      effects index (global read-only catalog data), actorModifiers(actor, { weaponId }), deriveFull(actor)
client/modules/sheet/modifiers-ui.tsx   useEffectsLookup / useModifiers / useDerivedModifiers, effect texts, chips with 📖 BookRef, tooltips
```
Types: `Effect`, `EffectType`, `Modifier`, `ConditionState` in `shared/types.ts`. Tests: `node tools/test-modifiers.ts`
(port 3500).

## Catalog effects

`entry.effects` on every catalog file whose XML has a bonus: armor, armormods, gear, cyberware, bioware, qualities,
powers, accessories, lifestylequalities, spells, martial-art techniques. `Effect = { type, target?, value (number |
formula with Rating: 'Rating', '-Rating', 'FixedValues(1,2,3)', 'Rating * 2'), condition? (key), choice? ({ kind:
'skill'|'text'|'matrixAction'|'attribute'|'limit', limitTo?, categories? }), wireless? (from <wirelessbonus>), tag
(Chummer tag) }`. Types:
- `limit` (limitmodifier, physical/mental/social/astrallimit), `skill` (specificskill, spellcategory focus, selectskill
  with a value), `skillCategory`, `skillGroup`, `skillAttribute` (skillattribute / skilllinkedattribute), `attribute`
  (specificattribute val / selectattribute), `attributeMax`, `initiativeDice` (initiativepass), `initiative`,
  `matrixInitiativeDice`, `armor`;
- `monitor` (conditionmonitor: physical / stun / overflow / threshold / thresholdOffset (each track) /
  sharedThresholdOffset (Damage Compensators: both tracks together, Physical first));
- `stat` (damageresistance → soak, composure, memory, liftandcarry, dodge / defensetest → defense, judgeintentions
  (+ offense / defense), reach, unarmeddv / unarmedap, drain / fading / fatigue resist, surprise, spellresistance,
  recovery, throw…), `resist` (toxin / pathogen / fire / cold… resistances and immunities: shown only), `accuracy`
  (weaponskillaccuracy, weaponaccuracy), `matrixAction` (Codeslinger), `flag` (smartlink, unarmed physical), `choice`
  (selecttext / selectskill without a value), `info` (addweapon), reputation and lifestyle cost (`stat` notoriety /
  publicAwareness / streetCred / lifestyleCost: shown), `personaAttribute` (livingpersona: shown), flags `ambidextrous`,
  `lowLightVision` / `thermographicVision` (hand-written; read by `shared/vision.ts` `tokenVision`).
- `chargen`: creation / structural tags (karma and point costs, unlocked tabs and attributes, free spells or contacts,
  forbidden 'ware grades…, `CHARGEN_TAGS`): nothing to do at the table, never a modifier.
- Any other tag → `{ type: 'unsupported', tag }` (kept on the catalog entry, never silently dropped).

## Hand-written effects and automation status

`tools/lib/effect-overrides.ts` = `{ [file]: { [English name]: { effects?, replace?, partial?, gm?, handled? } } }`: effects
written from the book (tag `hand`, the entry's own `source` / `page`) for entries Chummer has no data for (Guts, Unsteady
Hands, Allergy, Prejudiced, Accident Prone, Data Trails qualities…), `partial` / `gm` = what stays with the GM (text for
the report), `handled` = applied elsewhere (Agile Defender: full defense options; Wanted by GOD: the Matrix cockpit).
Their conditions are `q-…` keys of `CONDITIONS`. A name that matches no entry is reported by the build.

Each quality gets an automation status (`automationOf()` in the build): **automated**, **partly** (`manual: 'some'`),
**not automated** (`manual: 'all'`: no effect data, only unsupported tags or bookkeeping such as notoriety, or `gm`),
**creation only**. Every quality has an index entry (even without runtime effect) so `qualityAutomation(q, lookup)` →
'auto' | 'some' | 'all' | 'custom' (not in the catalog). `data/catalog/qualities-coverage.md` lists every quality by
status and book, with what is applied and what is not.

`data/catalog/effects-coverage.md` = tag → supported / unsupported counts, effect types, and every **condition** key
with Chummer's FR / EN strings (`lang/*.xml` `LimitCondition_*`) and the app's labels. Index
`data/catalog/effects.json` = `{ files: { [file]: { [catalogId]: { name, nameFr, source, page, effects } } }, names: {
[file]: { [lower-case EN / FR name]: id } } }` (runtime effects only: no unsupported / chargen / info / free-text choices /
tag names; techniques under `techniques`; qualities: every entry, with `manual?: 'all' | 'some'`).

## Conditions

`shared/modifiers.ts CONDITIONS`: Chummer `LimitCondition_Visible` → `visible`, `LimitCondition_IntimidationVisible` →
`intimidation-visible`, free-text conditions → `t-<slug>` (`t-urban`), spellcasting foci → `spell-<category>`. Each has
a French label (English source text, French in `client/i18n/fr/sheet.json`), optional restrictions that make it apply to
some tests only (`skills`, `groups`, `exclude`, `attrs`, `knowledge`, `matrixActions`, `mode`) and a **switch**
(`toggle`): `null` = automatic; several conditions share one switch (every « must be visible » outfit → `visible`);
unknown keys become their own switch (never applied silently). Wireless bonuses also need the `wireless` switch. Switch
labels: `TOGGLE_LABELS` (« Tenue visible », « Bonus sans fil actifs »…). `conditionState(key, ctx, toggles)` → 'na' |
'auto' | 'on' | 'off'.

## Sources

`collectModifiers(actor, lookup, { weaponId? })`: EQUIPPED armor and its mods (one outfit at a time, see the stacking
rules; armor « Rating » formulas use `armor.itemRating` — `armor.rating` is the armor value), augmentations (rating;
not `disabled`), qualities, adept powers (Rating = `level`), gear with `active: true` (players may toggle it on their
own gear; the sheet shows an « actif » switch on gear whose catalog entry has effects; default off), martial-art
techniques, echoes (`actor.magic.echoes`, free names matched by `ECHOES`: NeuroFilter, Overclocking, Mathemagics…, SR5 258 /
DT 58-59), and with `weaponId` that weapon's equipped accessories (`effects.dicePool` → `weaponPool`). Items are
matched by `catalogId`, else by English / French name (Foundry imports), also without a trailing « (…) » / « R4 ».
`Modifier = { id ('list:itemId[:subId]:i'), source: { list, itemId, subId?, name, nameFr?, parentName?, catalogId?,
book, page }, type, target, value (number, Rating resolved), condition, wireless?, baked?, info?, needsChoice?, choice?,
immune? }`. `select…` effects target `item.choice` (Chummer `<extra>`, stored by the Chummer import; the GM sets it in
edit mode, « Choix (effet) »: a skill name or id, a Matrix action, an attribute, a limit) — without a choice they are
shown, not applied.

## Helpers

`rollContext(actor, { skillId?, attr?, attr2?, test?, weaponId?, actionId?, mode? })`; `poolModifiers(mods, ctx, {
conditions, ignore, isGM })` → `{ lines: [{ mod, value, state: 'applied'|'off'|'ignored'|'info', toggles }], total,
toggles }`; `limitFor(actor, name, mods, ctx, opts)` → `{ base, total, lines, toggles, alt, altConditions }`;
`weaponAccuracy(actor, weapon, mods, ctx, opts)` (Accuracy or « Physical » + equipped accessories' `effects.accuracy` +
accuracy effects); `derivedWithModifiers(actor, mods)` = `derive()` + monitors (physical / stun / overflow), wound
modifier (pain tolerance), armor (implants, powers: Mystic Armor), soak, defense, composure, judge intentions, memory,
lift / carry, limits (unconditional) + `limitsAlt` / `limitsAltConditions` (value with the switches on), matrix
initiative dice, and `sources[key]` (`limit.social`, `armor`, `physicalMonitor`, `initiative`, `attr.REA`…) for
tooltips. `cleanConditions(mods, list)` keeps only the switches this actor's modifiers use.

## Rolls (server authority)

`dice/roll` recomputes the pool and the limit with `actorModifiers()`; the client only sends `conditions` (switches on,
filtered by `cleanConditions`) and `ignore` (modifier ids to leave out: players may only drop bonuses, the GM
anything). Any other client field (`mods`, `effects`…) is ignored; the payload checks (limit, test, weapon skill,
`matrixLimit`, wounds, bonus lines) are listed in [dice.md](dice.md). The Matrix switches « en RV chaude » / « dans un
hôte » come from the actor's persona (mode, `hostId`; the GM keeps them for an actor without persona).
`roll.mods = [{ id, kind: 'pool'|'limit', type, name, nameFr?, value, state, condition?, wireless?, book?, page? }]`,
`roll.limitBreakdown` (« sociale 9 + Zoé : Heritage 12 +2 »), `roll.conditions`. Soak (`test: 'soak'`) adds the armor
with its modifiers itself; weapon attacks (`weaponId`) use `weaponAccuracy` and the accessories' dice; Matrix tests from
the sheet (`matrixLimit`) use the device attribute. Damage, status and combat (`30-combat.ts`: initiative dice,
incapacitation, wounds) use `deriveFull()`.

**Matrix**: `shared/matrix.ts actionPool(…, { mods, conditions })` adds skill / linked-attribute / Codeslinger dice
(`modLines`, parts with their source); `matrixInitiative(actor, persona, mode, mods)` adds matrix initiative dice (max
5D6). `45-matrix.ts` passes the decker's modifiers (never the agent's) and `p.conditions`; damage monitors use
`deriveFull`. Matrix limits: [rules/matrix.md](../rules/matrix.md#initiative-and-limits).

## UI

`RollDialog` (preset `test`, `weaponId`, `matrixLimit`) lists every modifier of the test with its source and 📖 chip
(players can uncheck a bonus), the switches that change something (« Tenue visible (+2 Limite sociale) », remembered per
actor in `localStorage['sr.rollToggles.<actorId>']`, guarded) and the limit breakdown; the Matrix « Lancer » dialog
shows the same switches. Sheet: limits « 9 (11 si visible) » with a source tooltip, initiative / monitors / armor /
soak / composure… with their sources, effect chips under armor, implants, qualities, powers and gear, gear « actif »
switch; GM edit mode: « Choix (effet) » on qualities / powers / implants / gear / armor, « Indice (objet) » on armor,
« Actif » on gear. The log shows the applied modifiers of a roll with their 📖 chips; the limit badge's tooltip has the
limit breakdown.

## Not automated

Shown, or left to the GM: resistances / immunities, reach / unarmed DV, attribute maximums, reputation, living persona
attributes, glitch rules (Gremlins, Social Stress). Qualities: see `data/catalog/qualities-coverage.md`; the sheet marks
« non automatisé » / « en partie automatisé » qualities (`AutomationMark`, tooltip says the GM applies them by hand).
Situational conditions without restriction
(« avec la corpo concernée, si visible ») are their own switch.

## Tests

`node tools/test-modifiers.ts` (port 3500): the normalizer on real Chummer entries (Heritage 12, Chameleon Suit,
Improved Reflexes, Kinesics, Muscle Replacement, Synaptic Booster, Tailored Pheromones, Codeslinger, Dimmer Bulb,
Toughness / Will to Live / Catlike, Fire Resistance, Spellcasting Focus), creation-only / reputation / living persona tags,
automation status (qualityAutomation, qualities-coverage.md), hand-written effects (Guts, Accident Prone — not Gunnery —,
Natural Hardening, I C U, Snooper), echoes (NeuroFilter, Overclocking in hot-sim only), the Lazarus PCs (Jane's Con: pool 14 / 16
with Seduction, social limit 9 → 11 « visible »; Improved Reflexes baked; Ank'Lay's ware baked; Bricks' Codeslinger),
monitors / pain tolerance, chargen accessories / armor mods, and the server authority (no injected modifier, maluses
kept, limit not raised, weapon / soak / Matrix limits, gear switch, GM sub-item edits keep `paid` / `extraMount` /
`bonus`), and the review regressions: monitor override 0, baked / unbaked bonuses + stored GM additions (Improved
Reflexes, Move-by-Wire, Lightning Reflexes), Damage Compensators, one outfit, test claims, wounds, weapon skill,
matrixLimit, limit removal / floor, player bonus lines, persona switches, imported « Physical » accuracy.
