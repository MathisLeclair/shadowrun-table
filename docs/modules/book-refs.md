# References everywhere (📖 chips)

Every game element a player or GM looks at links to its rulebook page (opened in the [rulebook viewer](books.md)).

```
shared/bookrefs.ts        pure tables + parsers: SKILL_PAGES (skill id → SR5 page, Chummer skills.xml), RULE_REFS (limits SR5 46, derived SR5 101,
                          initiative 159, matrixInitiative 231, conditionMonitor / woundModifiers / armor 169, defense 188, soak 173, attributeTests 152,
                          movement 161, edge 56, drain 282, powerPoints 278, adeptPowers 308, spellcasting 281, complexForms 252, matrixDamage 228,
                          biofeedback 229, matrixActions 237, programs 245, ic 248, knowledgeSkills 147, lifestyles 369, martialArts RG 128,
                          priorityTable 65, karmaAdvancement 103, initiation 324, submersion 257…), CHARGEN_STEP_REFS (creator steps, SR5 62-100),
                          COMPLEX_FORM_PAGES / complexFormRef, ITEM_CATALOGS / SUB_CATALOGS (catalog files of each actor list), REF_LISTS,
                          itemRef(item), normRef(source, page), parseRefText('SR5 p. 435'), refFromNotes('Name · SR5 66'), skillRef, ruleRef
server/lib/bookrefs.ts    catalog index (id → ref, folded EN / FR names per file, techniques included; global read-only data),
                          resolveItemRef(list, item, sub?, { sourceText? }), fillItemRef, fillActorRefs(actor, { sources? }) → n filled
client/modules/books/BookRef.tsx   <BookRef>, <ItemRef item />, <RuleRef rule="limits" />, <SkillRef id="pistols" /> (nothing without a reference)
```

## Item references

`item.source` (book code) + `item.page` (printed page; absent when unknown). Resolution order (`resolveItemRef`): the
item's own reference › catalog id › the import's own source text › « CODE page » in the notes (Foundry « Low-Light
Vision · SR5 66 », Chummer « SR5 p.71 — … », upper-case code required) › complex form table › English / French name in
the list's catalogs (also without « (…) » and a rating suffix: « Cyberyeux 2 (vision nocturne) » → Cybereyes; weapons
also look in gear and armor: grenades, shields) › « Mains nues » / Unarmed Attack → Unarmed Combat SR5 132. GM-typed
French items without a catalog match stay without chip.

## Where references are filled

Idempotent, never overwrites an existing reference: characters init (every actor at boot — one-time backfill of old
tables), `actor/create`, `actor/addItem`, `actor/addSubItem`; shop orders / martial arts / Chummer restore (40-shop);
training (`advance()`); chargen `buildActor`; bestiary `sanitizeTemplate` (+ combat init for stored templates; npcgen
previews and templates go through it); Chummer import / re-import (`parse.ts` stores `<source>`/`<page>` on items and
nested items, 85-chummer fills the rest); Foundry import (`convertSheet` returns `itemSources { [appItemId]:
system.description.source }`, applied by `buildPc` / `buildTemplate` AFTER the merge snapshot: converted items carry no
source, so item hashes and « unchanged » detection are not affected). GM edits: `sanitizeItem` / `sanitizeSub` keep
`source` (≤ 12 chars) and `page` (int).

## UI

Sheet — Résumé / Combat / Magie / Matrice stat boxes carry their rule chip in the corner (`RollStat
book={ruleRef(…)}`, outside the roll button), section titles (condition monitors, Edge, derived values, adept powers,
lifestyles, martial arts, knowledge), every item row (weapons, armor, implants, gear, vehicles, qualities, powers,
spells, complex forms — new table in the Matrice tab, also shown without a device —, martial arts, lifestyles) and
nested chips (accessories, mods, options, techniques), skills (SR5 page of each skill), programs (programs catalog), GM
catalog picker; roll dialog (skill / test rule, limits, Edge, modifier lines); item effects only repeat the chip for
nested items; shop list rows, item detail, inventory, martial arts; training (rule « ? » + SR5 103 / 324 / 257, skills,
qualities, spells, powers, complex forms); creator (step header, priority table, catalog pickers, gear, spells, powers,
qualities, skills, complex forms); Matrix (action list + dialog page, skill, pool parts with a source, programs, IC);
bestiary / enemy generator stat blocks (weapons, spells, skills, armor, implants, powers, qualities, gear, vehicles).
Chip title « Ouvrir Run & Gun p. 62 » (« Livre non disponible sur ce serveur (RG p. 62) » + dashed chip when the book
is absent).

## Tests

`node tools/test-bookrefs.ts` (ports 3530-3531): every catalog entry / technique has a parseable reference of a known
Chummer book (client parser agrees), SR5 skill / rule / creator-step pages checked against the SR5 text index when
present, parsers, seed PCs fully resolved (fill idempotent), bestiary items with a catalog id resolved, Chummer and
Foundry imports (snapshot items without source), boot backfill of an old table, GM catalog add / nested add / GM
override, shop gift, martial art, training, bestiary template.
