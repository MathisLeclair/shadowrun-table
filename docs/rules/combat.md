# Combat rules

Initiative, damage, firing, area weapons, defense and soak as the app resolves them. Code: `shared/combat.ts` (its
header cites range SR5 p. 185, scatter p. 182, blast p. 435, defense modifiers p. 189, special actions from Chummer's
`data/actions.xml`), `shared/sr5.ts`, `client/modules/sheet/inventory.ts`. Features: [combat tracker](../modules/combat.md),
[attacks](../modules/attacks.md), [inventory](../modules/inventory.md).

## Initiative (SR5 p. 159)

- Initiative uses `derive(actor).initiative` (+ wound modifiers apply to the initiative score in SR5).
- SR5 passes: each pass subtracts 10; actors with score > 0 act again.
- A PC rolling `cold` / `hot` initiative with a Matrix persona uses `matrixInitiative()` of shared/matrix.ts (deck as
  configured + modifiers). IC: Host Rating × 2 + 4D6; agents: Data Processing + Rating + 4D6.

## Movement (SR5 p. 161)

Run rate = AGI × 4 m per Combat Turn, enforced for players' tokens on the map ([maps](../modules/maps.md#segment-walls-and-image-backgrounds)).

## Damage (SR5 p. 169)

Stun overflow rolls into Physical; Physical overflow into `overflow`. An `actor.monitors` override of 0 = no such track
(grunts, drones: stun damage goes to Physical; hosts), see [modifiers-stacking.md](modifiers-stacking.md#monitors).

## Fire modes, ammunition and reloading

- Rounds per fire mode (`FIRE_OPTIONS`, SR5 p. 179): SS / SA 1, SB semi-auto burst 3, BF 3, LB long burst 6, FA 6
  (Simple) / FAC 10 (Complex), SUP suppressive 20.
- Fewer rounds than the mode (SR5 p. 180): fires what is left; defense modifier `min(0, defense + short)` (short =
  missing rounds); suppressive fire 1 m narrower per 2 missing rounds.
- Reloading (SR5 p. 163, simplified, `reloadPlan`): a spare clip of that weapon = clip change: ONE Simple Action
  (simplification: SR5 counts remove + insert clip as a Simple Action each; drum / belt: Complex); without one (« Fill
  Clip / Belt / Drum ») = AGI rounds per Complex Action; internal magazine / cylinder AGI rounds, break action 2,
  muzzle loader 1 per Complex Action; cylinder + speed loader: Complex, full.
- Several magazines (Additional Clip/Magazine, SL p. 45; Beretta Northstar « 6(m) × 2 », SL p. 39): one magazine per
  accessory on top of the weapon's own (as Chummer's ammo slots), each with its own rounds and ammunition. Switching the
  magazine fed to the weapon is a Free Action (table ruling); firing and reloading use the magazine in use.

## Range and environment

- Range (SR5 p. 185): ranged weapon + attacker token on the map → range modifier line « portée moyenne (18 m) −1 ».
- Environmental modifier (SR5 p. 175, `environmentFor`): columns visibility (map `weather.visibility`, heavy through a
  smoke cloud on the line of fire), light (target cell: `lightLevelAt` from `createVisionContext` litRatio — lit 0,
  light edge 1, dim map 2, dark 3; flash-pak glare 3 when the attacker or target is in it), wind (`weather.wind`), range
  (the band); the worst column, two at that level = one worse, two Heavy = −10 (`combineEnv`).
- Compensation (`attackSenses`): low-light (partial / dim light → 0), thermographic (visibility — not thermal smoke —
  and light one row up), ultrasound (visibility one row up, light ignored ≤ 50 m), flare compensation (glare),
  smartlink + smartgun (wind one row up).
- Range only → the range line as before; else one line « env. (portée, lumière) −N » (ranged weapons only, not
  melee).

## Area weapons

- Area weapon (`isAreaWeapon`: thrown grenade, grenade / missile launcher) + a point (or the target token's cell).
- Scatter (SR5 p. 182): 3 hits = no scatter, else 2D6 direction (7 = beyond the target, 2/12 = back) and (N D6 −
  hits) m (N: 1 grenade, 2 aerodynamic, 3 launcher, 4 missile, 5 rocket), glitch ×2, critical glitch = at the
  thrower's feet.
- Blast (`blastOf`): « −N/m » / « N m Radius » in the damage, else the SR5 p. 435 table by name → a `soak` attack for
  each token with a sheet in reach.
- Area effect (`areaEffectOf`): 'explosion' (blast marker until the end of its Combat Turn, 1 min outside combat),
  'smoke' / 'thermalSmoke' / 'gas' / 'flashpak' (`LASTING_EFFECTS`: a cloud until the end of the fight, 10 min outside;
  radius 10 m when the round gives none). A marker from before `until` existed lasts one minute from its `ts`.

## Toxins and afflictions

- Gas: `toxinId` (payload, else named in the grenade — `toxinFromText`, else CS) from `TOXINS` (SR5 p. 409-410), no
  blast damage; a `toxin` attack (status `soak`, dv = Power, ap = Penetration) for each token in the cloud, unless
  `toxinProtection` = immune (chemical seal; gas mask vs an inhalation-only toxin).
- Toxin Resistance Test (BOD + WIL, no wound modifier): left = Power − hits → `toxinOutcome`: Stun / Physical damage
  (no armor) and afflictions — 'disoriented' (−2 dice on every test but resistance tests: modifier type `allTests`),
  'nauseous' (wound modifier ×2: `woundFactor`), 'incapacitated' (left > WIL, 3 Combat Turns; shown only).
- Speed is not delayed and Penetration does not lower protection.

## Defense (SR5 p. 188)

REA + INT + `defenseLines()`: one active defense ('dodge'|'parry'|'block'|'full'|'agile'|'acrobatic'|'perceptive'|
'pretty'; turn-long ones paid once), situations ('cover-partial'|'cover-good'|'running'|'prone'|'in-melee'|'vehicle',
SR5 p. 189), fire mode, action, area −2, reach difference, −1 per defense already made this Combat Turn. Net hits ≤ 0
→ missed. Dodge also works against ranged attacks (SR5 p. 191; Chummer's data lists it for melee only).

## Soak (SR5 p. 173)

BOD + max(0, armor + AP) against the modified DV (DV + the attack's net hits); damage = modified DV − hits, Stun when
the DV is below the modified armor (`finalDamageType`). Armor counted: [modifiers-stacking.md](modifiers-stacking.md#armor).
