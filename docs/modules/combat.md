# Bestiary & combat tracker

| | |
|---|---|
| server | `server/modules/30-combat.ts` (owner of `state.bestiary`, `state.bestiaryRemoved`, `state.combat`) |
| client | `client/modules/combat/` (BestiaryPage, CombatDock, StatBlock, TemplateEditor) |
| tests | `node tools/test-combat.ts` (port 3103) |

Targeted attacks: [attacks.md](attacks.md). Initiative and damage rules: [rules/combat.md](../rules/combat.md).
Generated NPCs: [chargen.md](chargen.md#enemy-generator).

## State

Types `Template`, `CombatState`, `CombatEntry` in types.ts.
- `bestiary: { [templateId]: Template }` — Template = Actor schema minus id-specific runtime fields, plus `{ folder:
  'Project Lazarus'|'Gangs'|'Sécurité corpo'|'Spécialistes'|'Créatures'|..., description?: md }`. Every template goes
  through `sanitizeTemplate()` (also at init for stored templates). GM only.
- `combat: { active, mapId, round, pass, turn (index into entries = current actor), entries }`; an entry is `{ id,
  actorId, tokenId?, name, base, dice, score (current initiative), rolls: [], acted, delayed?, hidden? (GM only until
  revealed), out? }`.
- Matrix entries (no sheet, `isVirtual`): `kind: 'ic'` `{ actorId: null, hostId, icId, matrixKey, nameI18n }` and
  `kind: 'agent'` `{ actorId: null, ownerId, … }`. Rolled like NPCs, never wounded, owned by `ownerId` for players.
  Managed by the matrix module through `upsertVirtualEntry`, `setVirtualOut`, `endTurnOf`, and `combatHooks` (fn(ctx,
  combat, 'start'|'add'|'newTurn')), see [matrix.md](matrix.md#combat-tracker).

## Behaviour

- `'bestiary/spawn'` `{ templateId, mapId, x, y, count = 1, hidden? }` creates NPC actors (copy of template, new id,
  `type:'npc'`, `templateId`, names numbered « Nettoyeur AG Chemie 2 ») **and** tokens on the map (Token schema,
  `disposition:'hostile'`). Returns the new actor ids.
- Initiative: `derive(actor).initiative`, passes of −10, Matrix initiative for personas in cold / hot sim
  ([rules](../rules/combat.md#initiative-sr5-p-159)); initiative dice, incapacitation and wounds use `deriveFull()`.
- Initiative costs of actions: `spendInitiative(ctx, actorId, cost, label)` (used by [attacks](attacks.md)).
- Damage: `actor/damage` of the characters module ([characters.md](characters.md#actions)).
- Player view: hidden entries stay hidden until revealed; NPC entries whose token is on the shown map but not visible
  to that player are dropped.

## Actions

Bestiary: `bestiary/create|update|delete|duplicate|fromActor|import|renameFolder|spawn`. Combat: `combat/start|add|
remove|roll|rollAll|setScore|adjust|next|prev|newTurn|delay|act|seize|setMode|reveal|setOut|end`.
