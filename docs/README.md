# Shadowrun Table — developer docs

Documentation for AI coding agents and humans working on the app (`app/`). Each page answers one kind of question;
read the one you need, not all of them. Repo rules and commands: [AGENTS.md](../AGENTS.md). User guide:
[app/README.md](../app/README.md).

## Start here (agents)

1. [AGENTS.md](../AGENTS.md) — stack, layout, commands, the rules that matter.
2. [architecture.md](architecture.md) — the server module and client contracts; the module map tells you which page
   covers the code you are about to touch.
3. `app/shared/types.ts` — the data model; [data-model.md](data-model.md) explains what the types don't.
4. The feature page of the module you change, and the [rules](rules/README.md) page if you touch SR5 rules.
5. [testing.md](testing.md) — which test file to run and on which ports.

## Core

| page | answers |
|---|---|
| [architecture.md](architecture.md) | process layout, module map, `ServerModule` / `ActionContext`, table scope, views & filters, client contract (`send`, `useGame`, UI kit, UI store, registry), routing, persistence, security |
| [data-model.md](data-model.md) | slices and their owners, ids, units, what players receive, boot normalisation, content packs |
| [testing.md](testing.md) | how to write and run tests, port range of every test file, integration checks |
| [i18n.md](i18n.md) | French keys + English dictionaries, client/server API, translator rules, checker |
| [deploy.md](deploy.md) | VPS (Docker, port 8095), auto-deploy, backups, rollback, environment variables |

## Features

| page | answers |
|---|---|
| [modules/core.md](modules/core.md) | config, users, chat, log entries, core actions |
| [modules/workspace.md](modules/workspace.md) | multi-view: split pane, floating panels, pop-out windows, dock width, what modules must handle |
| [modules/characters.md](modules/characters.md) | actor sheet fields, permissions, sheet actions, damage, nested upgrades (accessories, mods, techniques) |
| [modules/dice.md](modules/dice.md) | `dice/roll` payload, `performRoll`, Second Chance, 3D dice |
| [modules/inventory.md](modules/inventory.md) | FR/EN item names, ammunition, firing, reloading, ready weapons, containers, import of locations |
| [modules/lifestyles.md](modules/lifestyles.md) | lifestyles and options, homes (apartment layouts), legacy migration, historic Chummer restore |
| [modules/city.md](modules/city.md) | « Seattle » tab: traced districts, homes on the city map, district zoom, invitations, `shop/move` |
| [modules/contacts-sins.md](modules/contacts-sins.md) | fake SINs and their checks, contact dossiers and rolls |
| [modules/modifiers.md](modules/modifiers.md) | catalog effects, conditions and switches, modifier sources, helpers, server authority on rolls |
| [modules/chargen.md](modules/chargen.md) | priority character creator (drafts, approval), enemy generator |
| [modules/maps.md](modules/maps.md) | map state, tile legend, vision and fog, map actions, segment walls and image backgrounds |
| [modules/map-library.md](modules/map-library.md) | server-wide fragmaps, instances, publish/update, signed image links, admin |
| [modules/combat.md](modules/combat.md) | bestiary templates, spawning, initiative tracker, Matrix entries |
| [modules/attacks.md](modules/attacks.md) | targeted attacks, grenades and blasts, defense / soak flow, afflictions, map marks |
| [modules/shop.md](modules/shop.md) | shop settings, availability tests, contact search, orders, catalog files |
| [modules/shop-upgrades.md](modules/shop-upgrades.md) | upgrade catalogs, fitting rules (mounts, capacity, slots), upgrade / martial-art actions |
| [modules/training.md](modules/training.md) | karma advancement requests, downtime |
| [modules/matrix.md](modules/matrix.md) | personas, hosts, IC, agents, devices linked to the map, Matrix actions |
| [modules/magic.md](modules/magic.md) | Magic tab (cockpit, GM overview), traditions and drain pool, `state.magic` |
| [modules/audio.md](modules/audio.md) | ambience / music state, music library, standard sfx ids |
| [modules/campaign.md](modules/campaign.md) | acts, quests, sessions, handouts, campaign docs, campaign facts |
| [modules/notes.md](modules/notes.md) | private / party notes, rights, locks, conflicts, markdown extras |
| [modules/books.md](modules/books.md) | rulebook PDFs: page offsets, search, signed links, viewer, reader, cache |
| [modules/book-refs.md](modules/book-refs.md) | 📖 chips: how items get their book and page |
| [modules/chummer.md](modules/chummer.md) | `.chum5` import / export / 3-way merge |
| [modules/foundry.md](modules/foundry.md) | Foundry VTT world import, uploads, nested-item mapping |
| [modules/assistant.md](modules/assistant.md) | GM assistant (Claude): auth, budget, tools, proposals |
| [modules/multi-table.md](modules/multi-table.md) | table registry, migration, auth, admin API, zips |
| [modules/demo-table.md](modules/demo-table.md) | public demo table: logins, refusals, caps, resets |

## Designs

| page | answers |
|---|---|
| [design/magic.md](design/magic.md) | magic flow (issue #7, built in #12–#23): plan, decisions, sub-issues |

## SR5 rules

[rules/README.md](rules/README.md) — what the app automates, with book and page, and the « follow Chummer when
ambiguous » rule: [dice & tests](rules/dice-and-tests.md), [combat](rules/combat.md), [matrix](rules/matrix.md),
[magic](rules/magic.md), [chargen](rules/chargen.md), [availability & shop](rules/availability-and-shop.md),
[advancement](rules/advancement.md), [modifiers stacking](rules/modifiers-stacking.md).
