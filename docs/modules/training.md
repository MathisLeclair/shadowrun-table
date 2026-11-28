# Training (karma advancement)

| | |
|---|---|
| server | `server/modules/50-training.ts` (owner of `state.training`, writes `actor.training` / `actor.magic`) |
| shared | `shared/advancement.ts` (costs, times, `normalizeRequest`, `applyAdvance`) |
| client | `client/modules/training/` (TrainingPage) |
| tests | `node tools/test-training.ts` (port 3105) |

Karma costs, training time and instructor rules: [rules/advancement.md](../rules/advancement.md). Martial arts are a
training kind (`martialArt`, [rules](../rules/advancement.md#martial-arts-rg-p-128)) chosen in the shop's « Martial arts »
section ([shop-upgrades.md](shop-upgrades.md#actions)); the « Other » tab points there.

## State

Types `TrainingState`, `TrainingSettings`, `TrainingRequest`, `AdvancementRequest`, `TrainingJob`, `ActorMagic`.
```js
training: {
  settings: { approval: 'always'|'never', useTime: true, instructorTimeReduction: 25 (percent), instructorCostPerWeek: { attribute: 1000, skill: 500, knowledge: 250, other: 500 } },
  daysElapsed: 0,   // downtime days advanced by the GM
  requests: [{ id, ts, actorId, userId, kind: 'attribute'|'skill'|'skillGroup'|'specialization'|'knowledge'|'quality'|'removeQuality'|'spell'|'power'|'powerPoint'|'complexForm'|'initiation'|'martialArt'|'other',
    target, from, to, label, karmaCost, nuyenCost, days, daysBase, instructor, ppCost, manual (not verified against the catalog),
    request (normalized request, see shared/advancement.ts), status: 'pending'|'approved'|'denied'|'done'|'cancelled', note?, gmNote?, resolvedTs?, doneTs? }],
}
actor.training: [{ id, requestId, kind, label, daysTotal, daysDone, startedTs, request }]   // in-progress (downtime)
actor.magic = { initiation: grade, submersion: grade, metamagics: [string], echoes: [string], extraPP: n }   // written by training
```

## Actions and behaviour

- Actions: `training/request`, `training/resolve`, `training/cancel`, `training/advanceDays`, `training/addDays`, `training/complete`,
  `training/updateSettings`, `training/clearHistory`. `'training/advanceDays'` (GM) moves downtime forward. `'training/addDays'` (GM, `{ actorId, jobId, days }`) gives days to one training
  without moving the calendar (the « + days » button on a job).
- `martialArt` requests: `{ catalogId: styleId, techniques: [{ id }] }`. The server replaces the style name, karma and
  technique names with `data/catalog/martialarts.json` (unknown style / technique → refused) and drops techniques the
  actor already knows. Completion adds the style to `actor.martialArts` (`{ id, catalogId, name, rating: 1, techniques:
  [{ id, catalogId, name, nameFr? }] }`) or the techniques to the known style. GM downtime (`training/advanceDays`) and
  `training/complete` finish them like any job.
- Adept powers with a catalog `stats.bonus` get the bonus applied on purchase/level-up and recorded on `power.bonus`
  ([rules/magic.md](../rules/magic.md)).
- Advances fill 📖 references through `advance()` ([book-refs.md](book-refs.md)).
