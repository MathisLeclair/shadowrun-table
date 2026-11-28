# Matrix

| | |
|---|---|
| server | `server/modules/45-matrix.ts` (owner of `state.matrix`) |
| shared | `shared/matrix.ts` (Matrix rules, `nextStepHints`) |
| client | `client/modules/matrix/` (MatrixPage: decker cockpit for players, overview / hosts / IC for the GM) |
| tests | `node tools/test-matrix.ts` (port 3600); `tools/test-integration.ts` covers Bricks + agent |

SR5 rules applied (initiative, limits, Overwatch, convergence, IC, agents): [rules/matrix.md](../rules/matrix.md).
Data Trails qualities, programs and echoes the cockpit applies: [rules/matrix.md](../rules/matrix.md#data-trails).

## State

Types `MatrixState`, `MatrixSettings`, `Persona`, `Host`, `HostIc`, `HostFile`, `HostDevice`, `PlayerHostView`. Facts
the types don't say:
- `settings`: `hideOverwatch` (true: players only see their OS with Baby Monitor loaded), `osTimer` (OS over time,
  applied lazily at the next Matrix action), `autoLaunchIc` (IC launch on a new Combat Turn).
- `personas: { [actorId]: Persona }` — created on first use (`matrix/ensure`), kept in sync with `actor.matrix`
  (device, programs). `asdf` is a permutation of the `actor.matrix` base values; `overwatch` 0..40; `osClock` = start
  of the current 15-minute OS period; `hostConverged` = converged inside that host.
- `hosts: { [hostId]: Host }` — `alert: 'none'|'active'`, `visible` (players can target it), `perceivedBy` (GM « knows
  the host »: everything), `known: { [actorId]: { stats?, ic?, files?, devices? } }` (what the GM revealed, item by item), `spotted`,
  `spider`, `notes` (GM); devices `{ id, name, rating, damage, offline, formatted, bricked, controlledBy, on
  (lights/cameras), link: null | { mapId, kind: 'door'|'light'|'camera', targetId } }`. Seeded from the pack's
  `matrix.json`.
- `persona.scans: { [actorId]: MatrixScan }` — what Matrix Perception revealed of other characters' PANs (copies of the
  devices' names and Device Rating, the commlink's ratings once revealed); max 60, most recent last.
- `reveals: { [id]: MatrixReveal }` — Matrix Perception / Matrix Search with hits waiting for the GM (`hits`, `options`
  = what the app can reveal); max 40. Players get their own, without options.
- `pans: { [ownerActorId]: { [itemId]: HostDevice } }` — Matrix state (damage, bricked, formatted, offline,
  controlledBy) of PAN devices, created when first targeted. GM only: players get each spotted device's state on
  their scan (`ScannedDevice.state`).

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

### Matrix Perception / Matrix Search: the GM answers
Matrix Perception: one piece of information per net hit (SR5 p. 241), chosen by the GM. Matrix Search (SR5 p. 241): the
dialog asks what is sought (`topic`) and how available it is (`searchLevel` → threshold 1 / 3 / 6, base time 1 min /
30 min / 12 h, 1 min inside a host) with the table's dice modifiers; reaching the threshold finds it in base time ÷ hits
above the threshold (`searchMinutes`), a failure logs the full base time. Either way a successful test creates a pending reveal
(`newReveal`, GM ping) instead of revealing anything. `revealOptions` lists what the decker does not know yet: on a host
its rating and attributes, its devices, and — from inside — its active IC and files (on an IC: that IC); on an NPC its
commlink and PAN devices; a perception with no target during a fight: the PANs of the NPCs in it (not hidden), outside a
fight nothing (GM's answer). Perception never reveals hidden hosts: that is information, so a Matrix Search — outside a
host it offers the hidden hosts (where the data is), inside one the file that holds the answer (`answer-file:`). The GM popup (`RevealPrompt`, global component) shows the oldest pending one — perception: options pre-ticked up
to the hits; search: topic, threshold and time, no limit, nothing pre-ticked — plus a free answer: `matrix/reveal { revealId, optionIds,
answer }` applies them (host `known`, IC `detected`, scans, `visible`) and logs « X learns: … » to the decker's owners
and the GM; `matrix/dropReveal` discards it; « Later » hides it for this session. The decker's cockpit shows a « ⏳ »
line while it waits.

### Characters' PANs
Rules: [rules/matrix.md](../rules/matrix.md#pans-characters-devices). Matrix Perception on an NPC persona reveals its
PAN devices (one per hit, picked by the GM); the cockpit's « PAN spotted » panel lists them per NPC (persona = master, then the
devices with marks, state and Hack on the Fly / Control Device / Data Spike buttons) and the action dialog offers them
as `pan:<actorId>:<itemId>` targets. Augmentations and weapons have a GM « Wireless off » field (`wirelessOff`) that
takes them out of the PAN. The GM's Deckers view lists hacked PAN devices with a Repair button (`matrix/panReset`).

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
  setFullDefense|forgetScan {actorId, targetId}`.
- GM: `matrix/hostCreate|hostUpdate|hostDelete|icLaunch|icUpdate|icRemove|icAct|setOverwatch|converge|resetPersona|
  setPersona|setMarks|setMarkOnMe|settings|panReset {actorId, deviceId}|reveal|dropReveal`, plus `osTick`, `hostTurn`, `icTurn`, `launchNextIc`, `spawnSpider` above;
  `matrix/testDice {mode}` only exists with `SR_MATRIX_TEST=1` (tests; the loaded-dice flag is process-wide).
- Agent: `agentAssist` = teamwork: its hits become `pendingAssist`, consumed by the next `matrix/action` of the same
  skill with `assistFromAgent: true`. `agentAct` = the agent performs the action itself.
- Results return `outcomes` (French) + `msgs` (`{ t, params }` messages); log entries are `kind: 'matrix'` with `i18n`
  (+ `authorI18n`, `roll.labelI18n`) and a GM-only `matrix.gm` block (defense pools) stripped for players.
- Rolls use the decker's modifiers ([modifiers.md](modifiers.md#rolls-server-authority)).

## Player view

Only their own personas; hosts only when `visible`, when inside, or with a mark on them; rating, IC ratings, files and
devices only once revealed to one of their deckers (`known` / `perceivedBy`), IC types when inside, file contents never
listed, GM notes/spider stripped; their own pending reveals without options; no `pans`.
