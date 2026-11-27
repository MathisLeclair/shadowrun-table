# Character creation & enemy generator

| | |
|---|---|
| server | `server/modules/15-chargen.ts` (owner of `state.chargen`; also the `npcgen/*` actions) |
| shared | `shared/chargen.ts` (priority creation), `shared/npcgen.ts` (enemy generator) |
| client | `client/modules/chargen/` (ChargenPage, `EnemyGenerator.tsx` opened from the Bestiaire) |
| tests | `node tools/test-chargen.ts` (port 3711), `node tools/test-npcgen.ts` (port 3712) |

Rules (Priority system, NPC Professional Rating): [rules/chargen.md](../rules/chargen.md).

## Character creation

State `chargen` (`ChargenState`, `ChargenDraft`, `DraftData` in types.ts):
```js
chargen: { settings: { method: 'priority', allowPlayers: true, startingKarmaBonus: 0 },
  drafts: [{ id, userId, userName, status: 'draft'|'pending'|'approved'|'rejected', data (normalizeDraft), gmNote, ts, createdTs, submittedTs?, resolvedTs?, actorId?, check: { errors, warnings } }] }
```
- Drafts are checked live client-side and again by the server with `compute(data, { lookup, rules, settings })`; gear
  prices come from `client/modules/shop/rules.ts` (same authority as the shop). The draft data format is documented in
  the header of `shared/chargen.ts`.
- Gear may include weapon accessories and armor mods (`GEAR_FILES` + `accessories`, `armormods`; `CREATION_UPGRADES`):
  a draft gear row `{ ref, file, target: <weapon/armor row id>, mount? }` is priced with its target's value and fitted
  with the shop rules (`accessoryFit`, `armorModFit` of `client/modules/shop/rules.ts`, passed in `ctx.rules`).
  `buildActor()` gives weapons their `mounts` and included accessories (like a shop purchase), armors their
  `capacity`, then installs the upgrades (`paid`, `effects`, armor-mod `bonus`). UI: « Accessoires d’armes » /
  « Modifications d’armure » sections of the gear step, « Sur l’arme / l’armure » + mount pickers.
- Actions: `chargen/saveDraft {draftId?, data}` → `{ draftId, check }`, `chargen/submit`, `chargen/withdraw`,
  `chargen/delete` (owner or GM); GM: `chargen/resolve {draftId, approve, note?, force?, type?}` (approve =
  `buildActor()` → new PC assigned to the player, starting nuyen rolled when asked), `chargen/create {draftId?|data,
  type, assignTo?, force?}`, `chargen/settings`. Players only receive their own drafts. Transient event
  `chargen:resolved { draftId, status, note, actorId? }` to the owner + GM.

## Enemy generator

Actions in `15-chargen.ts`, rules in `shared/npcgen.ts`, UI `chargen/EnemyGenerator.tsx` from the Bestiaire.
- Deterministic tiered NPCs (Professional Rating 0–6, grunt rules): `generate()/generateEncounter({ archetype, tier,
  metatype, seed, grunt?, lieutenant? }, { find, rules })` → bestiary Templates (accepted by `sanitizeTemplate()` of
  30-combat). The same input always gives the same template.
- GM actions: `npcgen/preview {…}` → `{ main, lieutenant, unitName }` (nothing stored); `npcgen/create {…,
  saveToBestiary, spawn?: { mapId (null = actors only), count, x?, y?, hidden?, addToCombat? } }` → `{ templateIds,
  actorIds, tokenIds, mapId, unplaced }`. Spawning goes through `bestiary/spawn` ([combat.md](combat.md)); saved
  templates land in folder « Générés ». Generated names/descriptions are stored French data.
