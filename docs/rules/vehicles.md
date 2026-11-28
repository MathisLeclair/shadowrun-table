# Vehicle, rigging and chase rules

Vehicle Tests, vehicle damage, mounted weapons, sensors, ramming, drones and Chase Combat as the app resolves them.
Code: `shared/vehicles.ts` (pure rules: the plans the server rolls and the sheet previews), `server/modules/34-vehicles.ts`,
the vehicle branches of `server/modules/33-attacks.ts`. Feature page: [vehicles](../modules/vehicles.md).

## Stats and condition monitor (SR5 p. 199)

- Effective stats = the sheet's values + the installed mods' `effects` (`vehicleStats`). Handling / Speed `4/3` = on-road /
  off-road (the dialog's « Off-road » switch).
- Condition monitor 12 + ⌈Body / 2⌉, drones 6 + ⌈Body / 2⌉ (`vehicleMonitor`). Vehicles ignore Stun damage, electrical
  damage excepted (an attack whose damage code carries `(e)`). Full monitor = destroyed (token marker « détruit »).
- Damage modifier −1 per 3 boxes, applied to the **Handling** (minimum 1), not to the pilot's dice (SR5 p. 201).
- Drone: the sheet's `drone` flag, else the catalog category « Drones: … » (filled at boot from the catalog, by id or name).

## Vehicle Test (SR5 p. 199-201)

- Pool: Vehicle skill + REA (the skill from the vehicle: `vehicleSkillId`, GM override), with the driver's sheet modifiers
  and wound modifier (Pilot wounded, p. 201). Autopilot: Pilot + [Model] Maneuvering autosoft (p. 269).
- Limit: Handling, or Speed in a Speed environment (p. 204). Interface (p. 201, 266): manual with an AR interface +1;
  remote control AR +1 / VR +2, never above the controlling device's Data Processing (Control Device, SR5 p. 238);
  jumped in VR +2 **and** + control rig rating (both apply: p. 201 « VR +2 » and p. 266 « limits increased by the rating »).
- Threshold: Vehicle Test Threshold Table (Easy 1 … Extreme 4+) + Terrain Modifier (open 0, light +1, restricted +2,
  tight +4); jumped in: − control rig rating, minimum 1 (p. 201).
- Jumped in with hot sim: +1 die to vehicle actions (p. 266).
- Pilot program facing something unexpected: Pilot × 2, threshold set by the GM (p. 269).

## Sensors and stealth (SR5 p. 184, 270)

- Perception through the vehicle: Perception + INT [Sensor] (jumped in: Sensor + control rig); autopilot Pilot + Clearsight [Sensor].
- Stealth: Sneaking + REA [Handling], the Sneaking dice capped at the driver's vehicle skill (p. 184); jumped in Sneaking +
  INT [Handling] (p. 270); autopilot Pilot + [Model] Stealth [Handling].

## Gunnery (SR5 p. 183-184)

- A weapon mounted on a vehicle (`weapon.vehicleId`) always uses Gunnery: manual Gunnery + AGI [Accuracy], remote or jumped
  in Gunnery + LOG [Accuracy] (jumped in: + control rig; remote: max Data Processing). A Complex Action in any fire mode.
- Passive targeting: Gunnery + LOG [Sensor].
- Drone on autopilot: Pilot + [Weapon] Targeting autosoft [Accuracy]; without a Targeting autosoft for that weapon it cannot
  fire (p. 183). An autosoft without a target name fits any mounted weapon.
- Only the one controlling the vehicle fires its weapons when someone else remote-controls or rigs it (control override,
  p. 265); on manual control the owner may man a mount while someone else drives.

## Attacks against vehicles (SR5 p. 205)

- A vehicle token is attacked as the vehicle, not its passengers (Damage and Passengers, p. 205).
- Defense: the driver's REA + INT; evasive driving (Free Action): + INT, −10 initiative, not against a ram. A drone on
  autopilot (or remote-controlled) defends with Pilot + Maneuvering [Handling].
- Soak: Body + Armor (Armor modified by AP). **A modified DV below the modified Armor does nothing** (p. 205 « less than »;
  p. 199 says « does not exceed » — the app follows p. 205, consistent with barriers, p. 197). Area attacks hit vehicle
  tokens in their blast; gas grenades do not.
- Jumped-in rigger: half the boxes (rounded up) as biofeedback, plus dumpshock (6 DV) when the vehicle is destroyed under
  them (p. 266); resisted with WIL + Firewall, no armor, Physical in hot sim, Stun in cold sim (p. 229).

## Ramming (SR5 p. 203)

- Vehicle skill + REA [Handling] as a melee attack (−3 at running rate) against the target's defense (pedestrians: dodge /
  full defense, no block or parry; a driven vehicle REA + INT [Handling]).
- DV from the Ramming Damage Table: Body/2 (≤ 10 m/turn), Body (≤ 50), ×2 (≤ 200), ×3 (≤ 300), ×5 (≤ 500), ×10; AP −6
  against characters. The rammer resists half the base DV. Each driver then owes a Vehicle Test (rammer 2, rammed 3).

## Movement (SR5 p. 202)

- Vehicle tokens move on the map with the Movement Rates Table: walking 5 / 10 / 20 / 40 … m per turn by Speed, running ×2.

## Drones (SR5 p. 269-270)

- A vehicle on autopilot placed on the combat map has its own initiative entry: Pilot × 2 + 4D6. A driven, rigged or
  remote-controlled vehicle acts on its driver's initiative.
- Autosofts (Maneuvering, Targeting, Clearsight, Evasion, Stealth, Electronic Warfare) are set on the vehicle by the GM;
  RCC sharing is not modelled (give the drone the shared autosoft).

## Crashes (SR5 p. 201-202)

- The vehicle and its passengers resist DV = Body, AP −6; a character takes Stun when the vehicle's Body is below their
  armor, Physical otherwise; Composure (4) for everyone aboard (logged, the GM applies it).

## Chase Combat (SR5 p. 203-205)

- Environment per Combat Turn: Speed (tests limited by Speed) or Handling. Ranges Short / Medium / Long / Extreme
  (0-10 / 11-50 / 51-150 / 151-300 m in Speed, 0-5 / 6-20 / 21-80 / 81-150 m in Handling), measured pursuer → quarry.
- Catch-up / Break away (any range): REA + Vehicle skill [env] against the maneuver threshold + terrain; each hit over the
  threshold moves one range, at most the vehicle's Acceleration. Beyond Extreme: the pursuer owes a test to keep the quarry
  in sight (failed = lost).
- Cut-off (Short): opposed REA + skill [Handling]; net hits = the threshold of the target's Vehicle Test, failed = crash.
- Ram (Short): opposed skill + REA [env]; the target takes the rammer's Body + net hits, the rammer half its Body.
- Stunt (quarry, any range): threshold set by the GM + terrain; failed = out of control (crash or the pursuers gain a range:
  GM's call); passed = every pursuer owes a test at the same threshold, failed = falls back one range (from Extreme: escaped).
- Out of control: −2 to everything done aboard until a Vehicle Test regains control (p. 202).
- The other side of an opposed chase test is rolled for the acting player from the target's skill + attribute + wounds
  (no Edge, no sheet modifiers) so the action resolves at once (« vehicle scenes … resolve fast », p. 199).
- Passengers firing a non-mounted weapon at a target outside the vehicle: −2 (p. 205): GM modifier for now.
