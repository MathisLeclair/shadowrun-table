# Demo table (public sandbox)

Core: `server/lib/demo.ts`, pack `data/packs/demo/` (built by `tools/build-demo.ts`), test `node tools/test-demo.ts`
(ports 3960-3969; short reset timers through the `SR_DEMO_*` variables). Enabling it on the VPS:
[deploy.md](../deploy.md#4b-public-demo-table).

A **public** table anyone can try without a password. `TableMeta.demo = true` (never on the legacy table) switches it
on.
- **Creation**: `SR_DEMO_TABLE=<id>` → `ensureDemoTable()` (tables.ts) creates that table at boot with pack `demo`, flag
  `demo`, a random GM password (`SR_DEMO_NAME`, `SR_DEMO_LANG` on creation). It only ever creates: an existing table
  that is not already a demo is left alone (a reset would wipe it). Without the variable, a table already flagged in
  `server.json` stays a demo.
- **Content**: pack `demo` = `vierge` + `data/packs/demo/` (`PACKS.demo.base`; `table.packDirs` → `initModules` runs
  every module init once per folder, base first — inits only add what is missing). The pack is **generated** by
  `node tools/build-demo.ts` (hand-written warehouse tile map, Matrix host with map-linked devices, scenario/handout in
  the script; PCs from the enemy generator turned into PCs, bestiary NPCs, a `maps/fromLibrary` copy of `dive-bar` —
  through a throwaway server). Edit the script, rerun it, commit the pack. No Project Lazarus content.
- **Logins**: GM without password; players without PIN (a PIN sent is ignored, so a name can't be locked); pre-made PCs
  may be shared by several players; at most `SR_DEMO_MAX_USERS` (40) player accounts; every login counts against
  `SR_DEMO_LOGIN_MAX` (30) per IP / 10 min. The client reads `table.demo` (lobby, view config, `/api/tables`): banner on
  the login screen, no password/PIN fields, « démo » pill in the picker, its own message after a reset (`unauthorized {
  reason: 'demo-reset' }`), its own text in the assistant dock.
- **Refused** (403 `code: 'demo'`, `demoHttpGuard`, mounted before the body parsers): `/api/assistant/*` except
  `status` (also `allowed()` in 95-assistant, and never offered in `/admin → Assistant IA`), `/api/books/*` (`GET
  /api/books` answers an empty library), `/api/foundry/*`, `/api/admin/import|backup`, map-library browsing
  `/api/maplib[/<slug>]` (library images: only those of the demo's own maps, checked in 22-maplib). Socket actions
  `foundry/*`, `maps/fromLibrary`, `maps/publishToLibrary`. `/api/admin/reset` on a demo = demo reset. No backups are
  written (`store.backup` is a no-op), the registry name never follows a GM rename.
- **Allowed** like on any table: table display links ([display.md](display.md)). A demo reset wipes them with the rest
  of the state (their screens show « link no longer valid »).
- **Caps**: HTTP bodies need a Content-Length and ≤ 2 MB (uploads ≤ `SR_DEMO_UPLOAD_KB`, 1024); uploads =
  PNG/JPEG/WebP/GIF only, ≤ 200 files and `SR_DEMO_UPLOAD_QUOTA_MB` (20) per table; socket action payload ≤ 128 KB
  serialized, ≤ 120 actions / 10 s per socket, chat lines ≤ 500 characters.
- **Reset** (`resetDemoTable`): connected sockets get `unauthorized { reason: 'demo-reset' }`; `uploads/ assets/
  foundry/ docs/ backups/ assistant.json` removed; state = `emptyState()` + pack seeds (users, sessions, log wiped).
  When: at boot (a deploy brings the new pack), after `SR_DEMO_IDLE_MINUTES` (30) with nobody connected following a
  change (every save marks the table changed), at `SR_DEMO_RESET_HOUR` (4, server local time — UTC in the Docker image;
  `none` disables) even with people connected, and when `state.json` exceeds `SR_DEMO_MAX_STATE_MB` (12). Checked every
  `SR_DEMO_CHECK_SECONDS` (60).
- **Picker**: `/api/tables` lists non-hidden tables; hide the real tables (`/admin` → Masquer de l'accueil) so `/` shows
  — and redirects to — the demo only.
