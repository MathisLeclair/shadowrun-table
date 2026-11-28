# Attacks (targeted attacks, grenades, blasts, toxins)

| | |
|---|---|
| server | `server/modules/33-attacks.ts` (owner of `state.attacks`) |
| shared | `shared/combat.ts` (range bands, scatter, blast, special actions, defense options) |
| client | `client/modules/combat/AttackTray.tsx` (global) + `attack-common.ts`; RollDialog; map overlays (`renderer.drawCombatMarks`) |
| tests | `node tools/test-attacks.ts` (port 3291, `SR_TEST_PORT` overrides) |

Targeted attacks resolved step by step. Every roll goes through the characters module's `performRoll(ctx, payload,
internal)` ([dice.md](dice.md)) and the damage through `applyDamage(ctx, actor, n, type)` (body of `actor/damage`).
Initiative costs: `spendInitiative(ctx, actorId, cost, label)` (combat module). The SR5 rules applied (range,
environment, scatter, blast, toxins, defense, soak): [rules/combat.md](../rules/combat.md).

> Combat spells (kind `'spell'`) are created by the magic module after a cast: see [magic.md](magic.md#combat-spells-attacks).
> A resistance roll left with no dice (a badly wounded target) counts as 0 hits instead of blocking the spell.

## State

Types `AttacksState`, `Attack`, `Blast`, `AttackTurnRecord`, `AttacksView` in types.ts.
- `attacks.list`: newest first, max 60. `Attack.status`: 'defense'|'soak'|'missed'|'done'|'cancelled'; `dv: null` = no
  damage code; `kind`: 'ranged'|'melee'|'blast'|'toxin'.
- `attacks.blasts` (max 12): landing cell `x, y` (may be fractional), `meters` (scatter), `dir: [d6, d6]`, `dist:
  [d6…]`, `falloff | radius`, `reach` (m), `hits: [{ actorId, tokenId, name, dv, meters, attackId }]`; record fields
  `effect`, `until` ({ round: 'startedAt:round' } | { combat: startedAt } | { ts }), `toxinId`.
- `attacks.turn: { [actorId]: { key: combatTurnKey, defended, boosts: [defense option ids paid for the turn], once:
  [action ids] } }` — GM only.
- `actor.afflictions: [{ id, kind, source, sourceEn, ts, until }]` (characters' actors).

## Actions

- `attack/roll` (any, owner of the attacker): the `dice/roll` payload + `{ targetTokenId? | targetActorId?, point?: { x,
  y }, actionId?, profileId? (launcher round: a « Minigrenade: … » sheet profile id or a `MINIGRENADES` catalog id),
  mapId? (GM) }`.
  - Grenade launcher: the round fired gives DV / AP / blast (`launcherRounds`: sheet profiles, then the catalog
    minigrenades the sheet does not list, the one matching `ammoKind` first); without `profileId` the loaded or first
    sheet round, none → refused (« Choisis la minigrenade tirée »).
  - Ranged weapon + attacker token on the map → range / environment modifier line.
  - Natural attack (`weapon.natural`, a spirit's powers — [magic.md](magic.md)): `Attack.natural = { power, element }`;
    refused while the spirit is not materialized. Elemental Attack range bands come from `natural.rangeStep` (range class
    `natural` of `rangeFor`).
  - Special action (`COMBAT_ACTIONS`): unlocked by a quality / power / martial art technique of the same name (French,
    English, or the « English name · BOOK page » notes of Foundry imports — `unlockNames`; the GM may use any), dice /
    DV / AP / reach, fewer rounds (Double Tap…), Edge and initiative costs paid after the roll, `once` per Combat Turn.
  - Area weapon + point (or the target token's cell) → scatter, then a `soak` attack for each token with a sheet in
    reach of the blast; gas → a `toxin` attack per token in the cloud. Otherwise: a `defense` attack (0 hits =
    `missed`). Returns the roll + `attackId` / `blast`.
- `attack/defend` (owner of the target, GM for NPCs) `{ attackId, options: ['dodge'|'parry'|'block'|'full'|'agile'|
  'acrobatic'|'perceptive'|'pretty'], situations: ['cover-partial'|'cover-good'|'running'|'prone'|'in-melee'|'vehicle'],
  modifier, explode }`: net ≤ 0 → `missed`; no damage code → `done`; else `soak` with DV + net hits. A hit by a
  natural attack logs its element (SR5 170-171) and Engulf's follow-up rule; a melee hit on a materialized critter with
  Energy Aura adds a `soak` attack against the attacker (DV MAG × 2, AP −MAG, « Energy Aura », SR5 396).
- `attack/soak` `{ attackId, modifier, explode }`; a `toxin` attack's soak is the Toxin Resistance Test.
- GM: `attack/auto` (defense then soak without options), `attack/resolve { outcome: 'missed'|'damage', amount, type }`,
  `attack/clear { all?, blasts? }`, `attack/removeBlast` (also in the GM's cell menu), `attack/removeAffliction {
  actorId, afflictionId }`; attacker or GM: `attack/cancel`.
- `pruneExpired` (shared/combat.ts) drops ran-out blasts and afflictions at each attack, new Combat Turn and combat end;
  the sheet's Combat tab lists the afflictions (GM ✕).

## Views and client

- Player view: no attack on a hidden NPC, a hidden attacker's name is `?`, blasts of the shown map only, `myTurn` =
  their characters' turn record.
- Client: `ui.targetTokenId` (players: click another token; everyone: token menu « Cibler »), `ui.aimPoint` (cell menu
  « Viser ce point »); the map draws `scene.combatMarks` (reticle, aimed point + blast preview ring, attack arrows,
  blasts with DV rings — `renderer.drawCombatMarks`) and a target banner with « Attaquer » (RollDialog). RollDialog:
  « Action » / « Cible » / « Munition » for weapon attacks → `attack/roll`. The sheet's Combat tab lists the unlocked
  « Actions spéciales » (« Utiliser »). `AttackTray` (global): defend / soak prompts, results, GM shortcuts.
