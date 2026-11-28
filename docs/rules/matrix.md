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
- Convergence (SR5 p. 232 / 247) at OS 40 (30 with Wanted by GOD, see below): on the grid, 12 DV resisted with Device Rating + Firewall, forced reboot, marks
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

## Data Trails

What the cockpit applies from Data Trails (DT); the rest is shown and left to the GM.

- **Qualities** the cockpit applies itself (`MATRIX_QUALITIES`, matched by catalog id or English / French name):
  Go Big or Go Home (DT 44: 3 marks on Brute Force / Hack on the Fly cost −6, `markPenalty`), Wanted by GOD (DT 49:
  convergence at OS 30, `convergenceAt`; the OS meter and hints follow), Faraday Himself (DT 48: +2 Noise on the
  character's own tests, `deckStats`; others within 10 m: GM), Virtual Stability (DT 151: no extra box from Virtual
  Machine). Others go through catalog effects (`tools/lib/effect-overrides.ts`): I C U (+2 Matrix Perception, switch),
  Snooper, Sapper, Online Fame, Nerdrage, Electronic Witness, Decaying Dissonance… The full list with what stays with
  the GM: `data/catalog/qualities-coverage.md`.
- **Programs** (`PROGRAMS`, DT pp. 56-57): `auto` = Crash (+2 limit on Reboot Device), Paintjob (+2 limit on Erase
  Mark), Tarball (Crash Program +1 die and +2 limit; the GM picks the random program), Swerve (+1 Firewall when
  resisting Reboot Device: `defenseBonus`, `personaDefensePool(…, actionId)`). The others (Bootstrap, Shredder, Search,
  Cloudless, Detonator, Smoke and Mirrors, Fly on a Wall, Tantrum, Cat's Paw, Hitchhiker, Nuke-from-Orbit) change the
  outcome or depend on the situation: their text gives the rule and the GM applies it.
- **Biofeedback resistance** (Black / Sparky / Blaster IC): WIL + Firewall + programs + the actor's `stat biofeedback`
  modifiers (`biofeedbackDice`: Natural Hardening, NeuroFilter; Scorched −2 against Black IC).
- **Echoes** (`actor.magic.echoes`, free names; `shared/modifiers.ts ECHOES`, SR5 258 / DT 58-59): NeuroFilter (+1
  biofeedback), Overclocking (+1D6 Matrix initiative in hot-sim only), Mathemagics (+2 Mental limit on scientific /
  technical knowledge, as Chummer), Mind over Machine / MMRI and FFF (shown), Attack / Sleaze / Data Processing /
  Firewall Upgrade (shown: the sheet's Matrix values are the living persona's, entered with the echoes), Resonance
  [Program] (that program becomes available: `availablePrograms`). Other echoes are the GM's call.
- Not implemented: DT's new actions (Garbage In/Garbage Out, Trackback), AI Depth actions, Bloodhound / Catapult /
  Shocker IC, deck modules, deep runs (Foundations).
