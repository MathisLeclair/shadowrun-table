# Testing

Run only the test files for the areas you touched, once — never the whole suite. Each test file starts its own
isolated server (own port, temp state dir, seeds applied).

## Rules (agents and humans)

- **Never** run the server on port 3000 or without `SR_RUNTIME_DIR` while developing in parallel — use
  `tools/test-client.ts`, which starts an isolated server:
  ```ts
  import { startServer, login, client, settle } from './test-client.ts';
  const srv = await startServer({ port: 31xx });
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  const p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur', characterId: '<pc id>' }));
  await gm.send('maps/…', {...}); await settle(); console.log(p1.state.maps);
  srv.stop();
  ```
  Multi-table: `startServer({ port, tables: [{ id, name, pack, gmPassword, state? }] })` (no default table then),
  `login(url, { …, table: 'id' })`, `client(url, token, { table: 'id' })`, `await srv.admin()` → admin token,
  `startServer({ legacyState })` writes an old single-table `state.json`. `test-client.ts` `send()` rejects with the
  French `error` text, so assertions on messages keep working after i18n.
- Put module tests in `tools/test-<module>.ts` (run with `node tools/test-<module>.ts`, exit code ≠ 0 on failure).
  Node 22.18+ runs `.ts` directly; on older 22.x set `NODE_OPTIONS=--experimental-strip-types`.
- Give a new test file its own port range (table below) so it can run next to the others.
- Type check everything: `npm run typecheck` (`tsc`, strict). Shared modules (`shared/*.ts`) and the pure client logic
  files (`.ts`, no JSX) can be imported and unit-tested in Node directly; components (`.tsx`) cannot.
- `node tools/smoke.ts` = quick global smoke test (port 3998).
- i18n: `node tools/test-i18n.ts`, `node tools/i18n-check.ts --area <area>` ([i18n.md](i18n.md#checker)).

## Ports per test file

From the code (`startServer({ port })`; several files take `SR_TEST_PORT`, `test-shop.ts` `SHOP_TEST_PORT`,
`test-sins.ts` `SINS_TEST_PORT`, `test-contacts.ts` `CONTACTS_TEST_PORT` to override). Files that share a port must not
run at the same time.

| test file | ports | area page |
|---|---|---|
| `test-assistant.ts` | 3990-3999 (uses 3991) | [assistant](modules/assistant.md) |
| `test-attacks.ts` | 3291 — same as `test-restore-lifestyles.ts` | [attacks](modules/attacks.md) |
| `test-audio.ts` | 3912 — same as `test-maplib.ts` | [audio](modules/audio.md) |
| `test-bookrefs.ts` | 3530-3531 (inside the `test-tables.ts` range) | [book-refs](modules/book-refs.md) |
| `test-books.ts` | 3420-3439 (3420 + pid % 10) | [books](modules/books.md) |
| `test-campaign.ts` | 3913 | [campaign](modules/campaign.md) |
| `test-characters.ts` | 3270 | [characters](modules/characters.md) |
| `test-chargen.ts` | 3711 | [chargen](modules/chargen.md) |
| `test-chummer.ts` | 3271 | [chummer](modules/chummer.md) |
| `test-chummer-migrate.ts` | 3273 | [chummer](modules/chummer.md#migrating-a-foundry-pc-onto-its-chummer-file) |
| `test-city.ts` | 3254 | [city](modules/city.md) |
| `test-combat.ts` | 3103 | [combat](modules/combat.md) |
| `test-contacts.ts` | 3962 (inside the `test-demo.ts` range) | [contacts-sins](modules/contacts-sins.md) |
| `test-demo.ts` | 3960-3969 (uses 3960-3961; short reset timers through the `SR_DEMO_*` variables) | [demo-table](modules/demo-table.md) |
| `test-foundry.ts` | 3272 | [foundry](modules/foundry.md) |
| `test-home.ts` | no server | [lifestyles](modules/lifestyles.md#homes) |
| `test-i18n.ts` | 3800-3849 | [i18n](i18n.md) |
| `test-i18n-sheet-map.ts` | 3850 | [i18n](i18n.md) |
| `test-integration.ts` | 3971 | below |
| `test-inventory.ts` | 3443-3447 | [inventory](modules/inventory.md) |
| `test-lifestyle.ts` | 3251-3252 | [lifestyles](modules/lifestyles.md) |
| `test-maplib.ts` | 3910-3912 | [map-library](modules/map-library.md) |
| `test-maplib-campaign.ts` | 3940-3941 | [map-library](modules/map-library.md) |
| `test-maps.ts` | 3201 | [maps](modules/maps.md) |
| `test-maptrace.ts` | no server (3900-3909 stay free) | `tools/maptrace/` |
| `test-layout.ts` | no server | [workspace](modules/workspace.md) |
| `test-markdown.ts` | no server | [architecture](architecture.md#security-rules) |
| `test-magic.ts` | 3650 | [magic](modules/magic.md) |
| `test-matrix.ts` | 3600 | [matrix](modules/matrix.md) |
| `test-modifiers.ts` | 3500 (inside the `test-tables.ts` range) | [modifiers](modules/modifiers.md) |
| `test-notes.ts` | 3150-3199 | [notes](modules/notes.md) |
| `test-npcgen.ts` | 3712 | [chargen](modules/chargen.md#enemy-generator) |
| `test-restore-lifestyles.ts` | 3290-3291 | [lifestyles](modules/lifestyles.md#historic-chummer-restore) |
| `test-shop.ts` | 3250 | [shop](modules/shop.md) |
| `test-sins.ts` | 3960 — same as `test-demo.ts` | [contacts-sins](modules/contacts-sins.md) |
| `test-tables.ts` | 3500-3599 (uses 3501-3505) | [multi-table](modules/multi-table.md) |
| `test-training.ts` | 3105 | [training](modules/training.md) |
| `smoke.ts` | 3998 | — |

## Integration checks

- `tools/i18n-check.ts` must report 0 missing; every `tools/test-*.ts` and `tools/smoke.ts` pass.
- `tools/test-integration.ts` (port 3971) runs the cross-module flow (two tables at once, EN + FR: admin creates a
  vierge/en table, player creator → GM approval, enemy generator + spawn + combat, Bricks + agent in the Matrix on
  Lazarus, no cross-table leak, keyed errors translated).
