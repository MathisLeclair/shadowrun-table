# Advancement rules (karma & training)

Code: `shared/advancement.ts` — sources SR5 core p. 103-107 (« Progression du personnage »), Run Faster and Run & Gun
p. 128 (martial arts); house rules are flagged in that file. Feature (requests, approval, downtime): [modules/training.md](../modules/training.md).

## Karma costs (SR5 p. 103)

Karma costs per SR5: attribute new×5, active skill new×2, group new×5, knowledge new×1, specialization 7, new skill 2,
new knowledge 1, positive quality karma×2, remove negative karma×2, spell 5, complex form 4, initiation 10+grade×3,
power point 5. Initiation options (group, ordeal, schooling) each lower the karma cost by 10 % (`InitiationOptions`).

## Martial arts (RG p. 128)

Kind `martialArt` (`MARTIAL_RULES`, `costFor` / `timeFor` / `martialInstructionCost`). `from` / `to` = techniques known in
the style before / after the training; `CostOptions.style` = the style itself is new.

| | Karma | Time | Instruction |
|---|---|---|---|
| New style (first technique included) | catalog `stats.karma` (7; Way of Unified Mana 15) | 1 month | 2,500¥ |
| Further technique | 5 | 2 weeks | 1,500¥ |

A known style without any technique (bought without, imported) still gets its first technique included (no karma, no
time), like the shop's `martialKarma` (Chummer charges the style with its first technique). With an instructor the time
drops by `instructorTimeReduction` like any training, and the nuyen cost is the book's instruction cost above (not
`instructorCostPerWeek`). One training per style at a time (`conflictKeys` → `martial:<styleId>`).

## Training time

With `training.settings.useTime`, an approved advance becomes a job of `days` on `actor.training`, advanced by the GM's
downtime days (`useTime: false` = advances apply immediately on approval); an instructor cuts the time by `instructorTimeReduction` (25 %) and costs `instructorCostPerWeek`
(attribute 1000, skill 500, knowledge 250, other 500 ¥). Time formulas: `timeFor()` in `shared/advancement.ts`.

## Groups and skills

Skills of a skill group are always materialized in `actor.skills` (so `skillPool()` works); `actor.skillGroups` keeps
the intact groups only (a group is removed when it gets broken).
