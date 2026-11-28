# Magic flow — design (issue #7)

Status: **design, not built yet**. Each section ends with the sub-issue that builds it (list at the end). When a part
lands, its facts move to `docs/modules/magic.md` (feature) and `docs/rules/magic.md` (rules), as for the Matrix, and
this page keeps only what is still to do.

Goal: magic gets the same kind of streamlined flow as the Matrix cockpit — its own tab, a player cockpit, a GM view,
data-driven actions with next-step hints, its own server module and state. Decisions taken with the GM (2026-11-28):

- a new main **Magic** tab (cockpit for awakened players, GM view); the sheet's Magic section stays and its « Cast »
  button opens the same cast flow;
- **combat spells go through the attack pipeline** (`33-attacks.ts`: target token → defense → soak → damage); other
  spells roll the opposed resistance when there is one and show net hits, the GM applies the effect;
- **summoned spirits are real NPC actors** (token, combat entry, sheet), controlled by the summoner's player.

Rules: SR5 core, chapter Magic. Pages below are printed pages. When a rule is ambiguous, do what Chummer5a does
([rules/README.md](../rules/README.md)).

## What exists today

Sheet Magic tab (`client/modules/sheet/tab-misc.tsx MagicTab`): MAG, astral initiative and limit, power points, roll
buttons (Assensing, Spellcasting, Counterspelling, Summoning), three drain-resist buttons (WIL + LOG/CHA/INT, test
`drainResist`), spells table whose « Cast » rolls Spellcasting + MAG with no Force and no limit. Adept powers with
effects, spellcasting foci as gear effects (condition `spell-<category>`). Spells, powers, PP, initiation, metamagics
(names only) bought through training. `InitMode` already has `'astral'`; `NpcKind` already has `'spirit'`. The
tradition is chosen in chargen (`draft.magic.tradition`) but **not stored on the actor**; Chummer import only writes
it into the notes.

Data available: `data/catalog/spells.json` (category, type, range, duration, `dv`, `descriptor`, `damage`),
`gear.json` category `Foci` (96 items), Chummer `critters.xml` (30 entries in category Spirits: attributes as
`F+n`, skills, powers, optional powers), `traditions.xml` (drain attributes, the spirit of each spell category),
`metamagic.xml`, `spiritpowers.xml`.

## Architecture

| part | file | role |
|---|---|---|
| server | `server/modules/47-magic.ts` | owner of `state.magic`; actions `magic/*`; filters; combat hooks |
| shared | `shared/magic.ts` | pure rules: drain value, Force bounds, drain type, resistance pools, spirit stats from Force, services, sustain penalty, `magicHints()` |
| client | `client/modules/magic/` | `MagicPage` (player cockpit / GM view), `CastModal`, `SummonModal`, `magic.css` (classes `mg-…`) |
| data | `data/catalog/spirits.json`, `data/catalog/traditions.json` | built by `tools/build-catalog.ts` from Chummer |
| tests | `tools/test-magic.ts` | port 3650 (free) |

Same contract as `45-matrix.ts`: synchronous handlers that mutate `ctx.state`, every player payload validated,
owner-or-GM checks per actor, results return `outcomes` + `msgs` (`{ t, params }`), log entries `kind: 'magic'` with
`i18n`, rolls through `performRoll` of `10-characters.ts` (so modifiers, Edge, Second Chance and 3D dice work).

### State (`state.magic`)

```ts
interface MagicState {
  settings: { autoDrain: boolean; showAstralToPlayers: boolean };
  /** Spells being sustained, by caster or by a spirit / focus for them. */
  sustained: { [id: string]: SustainedSpell };
  /** Astral state of an actor (absent = physical only). */
  astral: { [actorId: string]: { mode: 'perceiving' | 'projecting'; since: Timestamp; bodyTokenId?: string } };
}
interface SustainedSpell {
  id: string; casterId: ActorId; spellId: string; name: BiName; force: number; hits: number;
  targetIds: ActorId[]; area?: { mapId: MapId; x: number; y: number; radius: number };
  /** Who carries the −2: the caster, a bound spirit (actor id) or a sustaining focus (gear id). */
  by: { kind: 'caster' } | { kind: 'spirit'; actorId: ActorId; until?: EffectUntil } | { kind: 'focus'; gearId: string };
  ts: Timestamp; gmOnly?: boolean;
}
```

Spirits are actors, so their own data lives on the actor: `actor.spirit = { type, force, summonerId, services,
bound, optionalPowers, materialized }` (new optional field, `npc.kind: 'spirit'`). Actor additions:
`actor.magic.tradition` (Chummer tradition id + name), and on gear `bonded?: boolean` / `active?: boolean` for foci.

### Who sees what

Players: their own sustained spells, astral state and spirits (full sheets for spirits they summoned); other
players' spirits as NPC stubs when materialized on the map; astral presences only when they perceive or project
themselves (`settings.showAstralToPlayers` lets the GM show them all). GM: everything.

## Tradition and drain pool — *#12 Foundation*

`actor.magic.tradition` set by chargen approval, by Chummer import (`<tradition>`), and editable on the sheet (GM
edit mode). `traditions.json` gives the drain attribute (Hermetic WIL + LOG, Shamanic WIL + CHA…) and the spirit of
each spell category. The sheet's three drain buttons collapse to one when the tradition is known. Without a tradition
the cockpit asks for one (hint) and lets the player pick the drain attribute per roll, as today.

The foundation issue also adds the empty module, `state.magic`, the tab in `registry.ts` (visible to the GM, and to
players with an awakened character: MAG present and magician / mystic / aspected / adept), the cockpit layout
(header: MAG, drain pool, sustained count and penalty, astral state; sections filled by later issues), the GM view
shell and the hints panel (`magicHints({ actor, magic })`, toggled per browser like `sr.matrix.hints`).

## Cast flow — *#13 Cast*

Cockpit « Cast » (or sheet « Cast ») → `CastModal`:

1. **Spell** from `actor.spells` (category, type, range, duration, drain formula shown).
2. **Force** 1 … 2 × MAG (SR5 281), default MAG. Shows the drain value live: formula applied, **minimum 2** (282),
   +3 with **Reckless Spellcasting** (Simple Action, 281), and a warning that drain turns Physical if the hits after
   the limit exceed MAG (281).
3. **Target**: token(s) on the map (picker as in the attack tray) or « no target » (self / area point). LOS spells on
   tokens out of the caster's sight are refused for players (vision of `shared/vision.ts`), Touch spells need an
   adjacent token. Area spells: point + radius = Force (281), all visible tokens inside are listed and can be
   unticked.
4. **Roll** Spellcasting + MAG **[Force]** (the limit is the Force; Edge « push the limit » removes it as usual), with
   the actor's modifiers (wounds, sustained spells, foci via `spell-<category>`, aid from a bound spirit later).
5. **Effect** (#C, #D below).
6. **Drain**: DV computed by the server (`drainValue(spell.drain, force, { reckless })`), type Stun or Physical (hits
   > MAG), resisted at once with the tradition's pool (`test: 'drainResist'`, so drain modifiers apply), damage
   applied with `applyDamage`. `settings.autoDrain = false` leaves a « Resist drain » button instead (GM preference).
   Glitch / critical glitch on the casting test: a log note (+2 DV suggested on a glitch, 282), the GM decides.
7. **Sustain**: for duration S, a « Sustain » toggle (default on) creates a `SustainedSpell` (#E). Permanent spells
   are sustained for Force Combat Turns then dropped (283).

Multiple spells at once (split pool, 281) stays manual for now.

## Sustained spells — *#14 Sustain*

- Each spell sustained by the caster = **−2 dice pool on all tests**, cumulative (282). Applied server-side as a
  modifier source in `actorModifiers()` (kind `pool`, type `sustained`, one line per spell, 📖 chip SR5 282), so it
  appears in every roll breakdown and in the Matrix pools too.
- Cockpit list: spell, Force, hits, targets, « Drop » (free action); the target's sheet shows « under Armor (F 4) ».
- Effects of the common sustained spells that are plain numbers (Armor +hits, Increase Attribute +hits, Improved
  Invisibility…) become modifier sources on the target where the catalog effect allows it; the others are listed as
  text for the GM.
- GM view: all active spells, by caster, with « Drop ».
- A spell sustained by a sustaining focus (#J) or a bound spirit (#H) does not cost the caster the −2.

## Combat spells through the attack pipeline — *#15 Combat spells*

The cast creates `Attack`s (new `AttackKind: 'spell'`) so the existing tray, defense, soak and damage steps work:

- **Direct** (SR5 283): opposed by BOD (physical) or WIL (mana); damage = net hits, **no soak**. Mana spells only
  affect living / astrally active targets (drones, vehicles are refused).
- **Indirect** (283): defense REA + INT (dodge modifiers apply as for a ranged attack), DV = Force + net hits, AP =
  −Force, soak with BOD + armor. Elemental effects (284-285: fire, acid, electricity, cold…) are logged with their rule
  text; the ones the app already models (e.g. electricity → disoriented-like affliction) reuse `LASTING_EFFECTS`.
- **Area**: one attack per selected target, each with its own defense.
- Stun spells (Stunbolt, Stunball) deal Stun.

## Other spells: opposed resistance — *#16 Resistance*

For non-combat spells the cast shows the resistance and, when there is a target, rolls it:

| case | resistance (SR5) |
|---|---|
| Health on an unwilling target, mental Manipulation (Control Thoughts, Mob Mind…) | WIL or LOG + WIL per spell |
| Mana Illusion / Physical Illusion | LOG + WIL / INT + LOG |
| Physical Manipulation on a being | BOD + STR or per spell |
| Spells on objects | Object Resistance threshold (non-living objects table) |
| Detection on an unwilling target | WIL (+ counterspelling) |

Built as data: a `resistance` field derived from the catalog `descriptor` + category, with a small override table in
`shared/magic.ts` for the spells whose text says otherwise (cite page). The result shows net hits and the spell's
effect text; counterspelling dice from an ally can be added before the target rolls.

## Spirits: data — *#17 Spirit data*

`tools/build-catalog.ts` reads Chummer `critters.xml` (category Spirits) → `data/catalog/spirits.json`: attributes as
offsets from Force, initiative, skills (rating = Force), powers, optional powers, movement, source/page; and
`traditions.xml` → `traditions.json`. `shared/magic.ts spiritStats(type, force)` turns a template into an actor
(attributes, monitors, astral attributes = Force, powers as `actor.powers`, natural weapons). French names through
the catalog's FR names as for other items.

## Summoning and spirit actors — *#18 Summoning*

Cockpit « Summon » → `SummonModal`:

1. **Type** from the tradition's five spirits (all types for the GM), **Force** 1 … 2 × MAG (300), optional powers
   (1 per 3 full Force points).
2. **Roll** Summoning + MAG [Force] vs spirit's Force (opposed; the spirit's roll is GM-only in the log).
3. **Drain** = 2 × the spirit's hits, min 2; **Physical if Force > MAG** (300); resisted automatically.
4. **Net hits > 0**: an NPC actor is created next to the summoner's token (via the same path as `bestiary/spawn`),
   `actor.spirit = { services: net hits, bound: false, summonerId }`, hidden from other players until materialized.
   One unbound spirit at a time (300): summoning another asks to release the first.

Control: the summoner's owner can act for the spirit (roll, move its token, join combat) — a core permission rule
(`canControlActor`: own characters + spirits whose `summonerId` is one of them). Combat: added with its astral
initiative, or its physical initiative when materialized (both from the spirit data);
« Combat » service consumed when it joins a fight (302). Cockpit spirit card: services (− / +), materialize / dematerialize,
« Use a power », « Release », disrupted when a monitor is full (302: services lost). GM action « Sunrise / sunset »:
unbound spirits leave (300; no in-game clock exists).

## Binding, bound spirits, banishing — *#19 Binding*

- **Binding** (300-301): only an already summoned spirit; costs Force × 25 drams of reagents (gear « Reagents »
  quantity, refused without), Binding + MAG [Force] vs Force × 2, drain 2 × hits (min 2), extra net hits add services.
  Bound spirits don't leave at sunrise; max bound = CHA.
- Bound spirits rest on the metaplane: call / dismiss (Simple Action), listed even when absent (actor kept, token
  removed).
- Bound services (302): **Aid sorcery** (+Force dice to Spellcasting when its type matches the spell category of the
  tradition — offered in `CastModal`), **Spell sustaining** (moves a `SustainedSpell` to `by: spirit` for Force Combat
  Turns per service), Spell binding (Force −1 per day, GM).
- **Banishing** (301): Banishing + MAG [Astral] vs Force (+ summoner's MAG if bound); each net hit removes a service;
  at 0 the spirit leaves. Drain 2 × hits (min 2), Physical if Force > MAG. Works on enemy spirits too.

## Astral — *#20 Astral*

- **Astral perception** (312, Simple Action): toggle in the cockpit; the actor becomes dual-natured, can target
  astral beings with mana spells, sees spirits on the map that are not materialized. Map: astral-only tokens (spirits,
  projecting mages) drawn only for viewers who perceive / project and the GM.
- **Astral projection** (313): the body stays (token marked « body, empty »), an astral token is created; astral
  initiative (`d.astralInitiative`, mode `astral` of the tracker), astral attributes = mental attributes (314 table).
- Astral combat (315) uses the attack pipeline with Astral Combat + WIL [Astral] / weapon foci.
- GM view: list of astral presences (who, mode, since).

## Foci — *#21 Foci*

- **Bonding** (318): karma cost per focus type × Force (focus table), through training like other karma spends;
  max bonded foci = MAG; total active Force > MAG × 5 (addiction threshold, 319) shown as a warning.
- Gear flags `bonded` / `active`; only active bonded foci give their bonus (spellcasting foci today, through their
  effects; plus counterspelling, summoning, banishing, binding, ritual, sustaining, power focus = +Force dice to magic
  tests and +Force to MAG-linked pools as Chummer does, weapon focus = +Force dice to its melee attacks and usable in
  astral combat, qi focus, spirit focus, metamagic focus).
- Sustaining focus: sustains one spell of its category up to its Force without the −2 (#C).

## Ritual spellcasting — *#22 Ritual*

SR5 295-296: leader + participants, lodge or foci, Ritual Spellcasting + MAG [Force] vs Force × 2, drain per
participant, time in hours. A GM-started « ritual » panel that collects participants, rolls teamwork and applies
drain to all. Lowest priority.

## Metamagic effects — *#23 Metamagic*

Data-driven like `ECHOES`: `METAMAGICS` in `shared/magic.ts` (SR5 325-326 + Street Grimoire), applied where
mechanical — Centering (reduce penalties with a metamagic skill), Shielding (+initiate grade dice vs spells as
counterspelling), Quickening (karma = Force, spell made permanent without sustaining), Spell Shaping (area changes),
Masking / Flexible Signature (shown, GM), Power Points for adepts (already in training). The rest: names + rule text.

## Hints

`magicHints()` (pure, player's filtered view), as the Matrix « Conseils »: no tradition set; sustaining N spells →
−2N on everything; drain may be Physical at this Force; a bound spirit could sustain / aid; unbound spirit leaves at
sunrise; projecting → body undefended; foci over the addiction threshold.

## Sub-issues

Filed on GitHub 2026-11-28, all « Part of #7 ». Order: #12 first; #13 → #14, #15, #16; #17 → #18 → #19; #20 and #21 after #12; #22, #23 last.

| issue | title | depends on |
|---|---|---|
| #12 | Magic foundation: module, state, tab, tradition on the actor, hints panel | — |
| #13 | Cast flow: Force, Force as limit, reckless, drain computed and resisted | #12 |
| #14 | Sustained spells: −2 per spell as a modifier, list, GM view | #13 |
| #15 | Combat spells through the attack pipeline (direct, indirect, area) | #13 |
| #16 | Non-combat spells: opposed resistance and net hits | #13 |
| #17 | Spirit data from Chummer (spirits.json, traditions.json, `spiritStats`) | — |
| #18 | Summoning: spirit NPC actors, services, control by the summoner, combat | #12, #17 |
| #19 | Binding, bound spirits (aid sorcery, sustaining), banishing | #18, #14 |
| #20 | Astral perception and projection, astral tokens and initiative | #12 |
| #21 | Foci: bonding, active foci, non-spellcasting foci, sustaining focus | #12, #14 |
| #22 | Ritual spellcasting | #13 |
| #23 | Metamagic effects | #13, #20 |
