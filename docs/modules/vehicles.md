# Vehicles, drones and chases

| | |
|---|---|
| server | `server/modules/34-vehicles.ts` (vehicle actions, owner of `state.chase`); vehicle targets in `33-attacks.ts` |
| shared | `shared/vehicles.ts` (rules and test plans), `server/lib/vehicles.ts` (driver, controller, catalog drone flag) |
| client | `client/modules/sheet/vehicles.tsx` (vehicle card + dialog, Gear tab; wide two-sided card `.sh-cards-wide` / `.sh-card-split` from `sheet.css`: state on the left, controls / tests / weapons on the right), `combat/ChasePanel.tsx` (Initiative dock), `combat/VehicleAttack.tsx` (attack tray) |
| tests | `node tools/test-vehicles.ts` (port 3295, `SR_TEST_PORT` overrides) |

Vehicles stay items of their owner's sheet (`actor.vehicles`). The SR5 rules applied: [rules/vehicles.md](../rules/vehicles.md).

## Data

`Vehicle` (types.ts) gains: `damage` (boxes), `control` ('manual' default | 'remote' | 'rigged' | 'auto'), `driverId`
(the actor at the controls; absent = the owner), `ar` (manual AR interface), `drone`, `skill` (vehicle skill override),
`riggerInterface`, `autosofts: [{ id, kind, rating, target? }]`, `swarm`, `breakdowns` (called-shot effects). A weapon of the sheet with `vehicleId` is mounted on that
vehicle. A token with `vehicleId` (and `actorId` = the owner) is the vehicle on the map. `CombatEntry.kind 'drone'`
(`ownerId`, `vehicleId`) = a vehicle on autopilot in the initiative order. `Attack.vehicle` = an attack on a vehicle,
`Attack.ram` = a ram, `Attack.feedback` = a rigger's biofeedback, `Attack.electric`. `RollRecord.vehicle` = the vehicle,
test, threshold and outcome of a vehicle roll. `state.chase`: `ChaseState` (vehicles, pending tests, events). `state.rigging`: `RiggingState` (target locks, Target
Device designations; players see only their own characters').

## Actions

Who may act for a vehicle (`mayControl`): the GM, the owner's player, the driver's player.
- `vehicle/control { actorId, vehicleId, control?, driverId?, ar? }`: players put one of their own runners at the controls;
  jumping in needs a control rig and a rigger interface, autopilot a Pilot rating (GM: no check). Switching to / from
  autopilot during a fight adds / takes out the drone entry.
- `vehicle/damage { actorId, vehicleId, damage }` (owner or GM): boxes set by hand (the GM raising them goes through
  `damageVehicle`: log, marker, rigger biofeedback).
- `vehicle/roll { actorId, vehicleId, test: 'control'|'perception'|'stealth'|'pilot', threshold?, terrain?, env?, offRoad?, modifier?, explode?, secret? }`
  → the roll with `roll.vehicle { threshold, success, net }`. A Vehicle Test records a Complex Action and regains control of
  an uncontrolled chase vehicle.
- `vehicle/mount { actorId, weaponId, vehicleId | null }` (owner or GM): mount / dismount a ranged weapon.
- `vehicle/configure { actorId, vehicleId, patch: { drone?, skill?, riggerInterface?, autosofts? } }` (GM).
- `vehicle/place { actorId, vehicleId, mapId?, x?, y? }` / `vehicle/unplace`: the vehicle's token (players: on the shown
  map, next to the driver's token; size 1 for drones, 2 for vehicles, 3 from Body 16).
- `vehicle/ram { actorId, vehicleId, targetTokenId, metersPerTurn, running?, modifier?, explode? }` → a melee `Attack` with
  `ram`, resolved by the attack tray; when it hits, the rammer's vehicle gets a soak attack of half the DV.
- `vehicle/crash { actorId, vehicleId, passengerIds? }` (GM): soak attacks for the vehicle and the chosen passengers.
- Firing a mounted weapon is `attack/roll` with its `weaponId` (+ `passive` for passive targeting): the attacks module
  takes the attribute, pool and limit from the control mode (`gunneryPlan`), fires from the vehicle's token.
- `vehicle/lock { actorId, vehicleId, targetTokenId, modifier? }`: target lock (Simple Action) stored in `state.rigging.locks`;
  `vehicle/unlock { lockId }`. A mounted weapon of that vehicle firing at the locked token lowers its defense by the lock.
- `vehicle/ew { actorId, action: 'breakLock'|'confusePilot'|'detectLock'|'suppressNoise'|'targetDevice', lockId?, targetTokenId?, noiseReduction?, modifier?, explode? }`:
  the rigger's electronic warfare (Rigger 5.0); Target Device stores `state.rigging.designations` (+dice for the rigger's
  vehicles against that token this Combat Turn).
- `vehicle/repair { actorId, vehicleId, mechanicId, boxes, conditions, tools, partsShort, skillId? }` → `{ success, rolls, hours, cost }`.
- `vehicle/swarm { actorId, vehicleId, swarm }` (owner or GM), `vehicle/breakdown { actorId, vehicleId, patch }` (GM).
- `attack/roll` takes `calledShot` (a `VEHICLE_CALLED_SHOTS` id) against a vehicle token.
- Chase (GM): `chase/start { environment, terrain, vehicles: [{ actorId, vehicleId, role, range?, hidden? }] }`,
  `chase/update { environment?, terrain? }`, `chase/add`, `chase/set { id, patch: { role?, range?, lost?, uncontrolled?, crashed?, hidden? } }`,
  `chase/remove`, `chase/round`, `chase/end`, `chase/dismiss { pendingId }`.
- Chase (drivers): `chase/action { id, action: 'catchUp'|'breakAway'|'cutOff'|'ram'|'stunt', targetId?, threshold?, modifier?, explode? }`
  and `chase/resolve { pendingId }` for a Vehicle Test the chase gave them (follow a stunt, keep the quarry in sight, a cut-off).

## Attacks module hooks

`33-attacks` exports `damageVehicle(ctx, owner, vehicle, boxes)`, `addVehicleSoak(...)`, `pushAttack`, `logAttack`. An
attack whose target token has `vehicleId` carries `vehicle`; `attack/defend` and `attack/soak` then use the vehicle rules
(`doVehicleDefend`, `doVehicleSoak`); `feedback` attacks are soaked with WIL + Firewall. Blasts damage vehicle tokens.
`performRoll` (10-characters) takes trusted `internal.basePool` (a drone's Pilot + autosoft: no actor modifiers or wounds),
`internal.limitAdjust` (Handling / Speed / Sensor limit, + control rig, max Data Processing) and `internal.author`.

## Views and client

- Players see the chase without its hidden vehicles, their pending tests and GM-only events.
- Sheet (Gear tab): one card per vehicle — stats with the damage modifier, clickable condition monitor, control mode /
  driver / AR, buttons for the tests, ram (needs a target picked on the map), place / remove on the map, mounted weapons
  (Fire / mount / dismount), autosofts (GM editor). The dialog previews the pool (driver's sheet modifiers and wounds
  included), the limit and the threshold with the same `shared/vehicles.ts` plans.
- Map: a vehicle token shows the vehicle's damage bar (amber) instead of its owner's tracks, and the « détruit » marker.
- Initiative dock: `ChasePanel` (GM: start / environment / terrain / next turn / per-vehicle flags; drivers: chase actions,
  pending tests). Attack tray: `VehicleAttackDialog` (defense with evasive driving, vehicle soak) and `FeedbackDialog`.
