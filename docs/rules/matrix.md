# Matrix rules

Code: `shared/matrix.ts` (its header cites SR5 pp. 214-251 for the Matrix and p. 49 for teamwork, and documents the
modelling choices: ASDF stored as a permutation, hosts and IC use the host rating for every mental attribute, devices
and files inside a host defend with the host). Feature, actions and state: [modules/matrix.md](../modules/matrix.md).
Page references used by the 📖 chips: Matrix initiative SR5 231, Matrix damage 228, biofeedback 229, Matrix actions
237, programs 245, IC 248, complex forms 252, submersion 257.

## Initiative and limits

- `matrixInitiative(actor, persona, mode, mods)`: deck as configured + modifiers; adds matrix initiative dice (max
  5D6). IC: Host Rating × 2 + 4D6; agents: Data Processing + Rating + 4D6 ([combat.md](combat.md#initiative-sr5-p-159)).
- Matrix limits are the deck's attributes: no physical / mental / social modifier applies. Sheet Matrix tests pass
  `matrixLimit` (Matrix skills only).
- `actionPool(…, { mods, conditions })` adds skill / linked-attribute / Codeslinger dice; the decker's modifiers count,
  never the agent's.

## Overwatch Score and convergence

- OS over time: +2D6 OS per 15 real minutes online (SR5 p. 232), when the table's `osTimer` setting is on.
- Convergence (SR5 p. 232 / 247): on the grid, 12 DV resisted with Device Rating + Firewall, forced reboot, marks
  lost, traced. Inside a host: the host puts 3 marks on the decker, goes on alert and launches its next IC; the decker
  stays online (no second convergence) and **leaving the host** triggers the grid convergence at once.

## Hosts and IC

- New Combat Turn: an alerted host with an intruder in the fight launches its next IC (SR5 p. 248; `autoLaunchIc`
  setting).
- IC targets (`pickIcTarget`): Patrol looks for intruders not spotted yet; the others go after spotted /
  most-host-marked intruders that have the marks they need.

## Agents

The agent shares the deck (ASDF, loaded programs, marks, Overwatch Score) and rolls Rating × 2. Assisting = SR5
teamwork: its hits (≤ the decker's skill) become a bonus for the decker's next action of the same skill. It can also
perform the action itself.
