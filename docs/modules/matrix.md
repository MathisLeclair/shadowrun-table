# Matrix

| | |
|---|---|
| server | `server/modules/45-matrix.ts` (owner of `state.matrix`) |
| shared | `shared/matrix.ts` (Matrix rules, `nextStepHints`) |
| client | `client/modules/matrix/` (MatrixPage: decker cockpit for players, overview / hosts / IC for the GM) |
| tests | `node tools/test-matrix.ts` (port 3600); `tools/test-integration.ts` covers Bricks + agent |

SR5 rules applied (initiative, limits, Overwatch, convergence, IC, agents): [rules/matrix.md](../rules/matrix.md).

## State

Types `MatrixState`, `MatrixSettings`, `Persona`, `Host`, `HostIc`, `HostFile`, `HostDevice`, `PlayerHostView`. Facts
the types don't say:
- `settings`: `hideOverwatch` (true: players only see their OS with Baby Monitor loaded), `osTimer` (OS over time,
  applied lazily at the next Matrix action), `autoLaunchIc` (IC launch on a new Combat Turn).
- `personas: { [actorId]: Persona }` — created on first use (`matrix/ensure`), kept in sync with `actor.matrix`
  (device, programs). `asdf` is a permutation of the `actor.matrix` base values; `overwatch` 0..40; `osClock` = start
  of the current 15-minute OS period; `hostConverged` = converged inside that host.
- `hosts: { [hostId]: Host }` — `alert: 'none'|'active'`, `visible` (players can target it), `perceivedBy`, `spotted`,
  `spider`, `notes` (GM); devices `{ id, name, rating, damage, offline, formatted, bricked, controlledBy, on
  (lights/cameras), link: null | { mapId, kind: 'door'|'light'|'camera', targetId } }`. Seeded from the pack's
  `matrix.json`.

## Behaviour

- **Convergence**: the host / grid convergence rule is applied by every Matrix action; inside a host the persona keeps
  `hostConverged` (no second convergence) and leaving the host triggers the grid convergence at once.
  `matrix/converge` (GM) follows the same rule.
- **OS over time**: `matrix/osTick { actorId }` (GM) = +2D6 in secret (GM-only log); with `settings.osTimer` every
  Matrix action first applies the 15-minute ticks elapsed since `osClock` (set when the OS starts being tallied, cleared
  on reboot). `matrix/setPersona` accepts `osClock`.
- **Host turn** (GM): `matrix/hostTurn { hostId, launch = true }` — alerted host launches its next IC, then every
  running IC acts on an automatic target (`pickIcTarget`). `matrix/icTurn { hostId, icId, actorId?, entryId? }` = one
  IC (entryId: its combat entry, whose turn then ends), `matrix/launchNextIc { hostId }`, `matrix/spawnSpider { hostId
  }` (the host's spider via `bestiary/spawn`, no token, added to a running fight).

### Combat tracker
After every Matrix action and on the combat hooks (`start`, `add`, `newTurn` — `combatHooks` of 30-combat),
`syncMatrixCombat` keeps in the fight, for each decker who is in it and online: her loaded agent (entry
`kind:'agent'`, `ownerId`), the running IC of the host she is in (`kind:'ic'`, `hostId`, `icId`), and her entry's
initiative mode (VR mode). They leave (`out`) when the IC stops, the agent unloads or she leaves. Entry shapes:
[combat.md](combat.md#state).

### Devices ↔ map
`link` points at a tile door / segment-wall door (`findAnyDoor` of 20-maps), a light, or a region (camera zone:
`region.cams = 'on'|'off'`, drawn « 📷 name » / « 📷✕ name »). Control Device / Spoof Command take `deviceCmd`
(`DEVICE_LINK_KINDS[kind].cmds`: open/close/unlock/lock, on/off) applied on success. Lights and cameras follow the
device (`deviceWorks` && `on`): reboot, format, brick, GM « Hors ligne » / repair. Players get `device.link = { kind,
state }` (no map id).

### Paydata and hints
- `matrix/shareFile { actorId, fileId }` (owner/GM) — a player creates a party note ([notes](notes.md), folder
  « Matrice »), the GM a handout revealed to all ([campaign](campaign.md)). Text stored in the table language. Copying
  a file pings the GM (`sfx notify`).
- `nextStepHints({ actor, persona, hosts })` (shared, pure, on the player's filtered view) → the cockpit's « Conseils »
  panel (players only, toggled per browser: `localStorage['sr.matrix.hints']`).

## Actions

- Owner or GM (`ownPersona`): `matrix/ensure|connect {actorId, mode}|disconnect|setASDF {swap|asdf}|loadProgram|
  unloadProgram {name}|configureAgent {rating, name}|agentLoad {loaded}|agentAssist {actorId, actionId}|agentAct
  {actorId, actionId, targetId…}|action {actorId, actionId, targetId?, marks?, assistFromAgent?, fileOp?, edge?, …}|
  setFullDefense`.
- GM: `matrix/hostCreate|hostUpdate|hostDelete|icLaunch|icUpdate|icRemove|icAct|setOverwatch|converge|resetPersona|
  setPersona|setMarks|setMarkOnMe|settings`, plus `osTick`, `hostTurn`, `icTurn`, `launchNextIc`, `spawnSpider` above;
  `matrix/testDice {mode}` only exists with `SR_MATRIX_TEST=1` (tests; the loaded-dice flag is process-wide).
- Agent: `agentAssist` = teamwork: its hits become `pendingAssist`, consumed by the next `matrix/action` of the same
  skill with `assistFromAgent: true`. `agentAct` = the agent performs the action itself.
- Results return `outcomes` (French) + `msgs` (`{ t, params }` messages); log entries are `kind: 'matrix'` with `i18n`
  (+ `authorI18n`, `roll.labelI18n`) and a GM-only `matrix.gm` block (defense pools) stripped for players.
- Rolls use the decker's modifiers ([modifiers.md](modifiers.md#rolls-server-authority)).

## Player view

Only their own personas; hosts only when `visible`, when inside, or with a mark on them; rating/IC ratings/files only
after Matrix Perception, file contents never listed, GM notes/spider stripped.
