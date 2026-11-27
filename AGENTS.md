# AGENTS.md — working on Shadowrun Table

Guide for AI coding agents (and humans) working in this repository. Read this first. Full details are in
[`app/ARCHITECTURE.md`](app/ARCHITECTURE.md), which is being split into `docs/`. Search it by section instead of
reading all of it.

## What this is

A real-time, self-hosted virtual tabletop for **Shadowrun 5th Edition**. One Node server hosts one or more **tables**
(independent campaigns); the GM and players connect from a browser. Everything lives in `app/`.

**Migration in progress (2026-11):** Preact + htm (no build) → **React + Vite + TypeScript**, step by step.
- Done: Vite builds the client, `tsconfig.json` is in place (`.js` allowed, not type-checked yet).
- Next: shared data-model types (`app/shared/types.ts`) → Preact swapped for React → modules converted to `.tsx` one
  folder at a time → server converted to `.ts` (Node runs it directly, no server build).
- New files go in TypeScript (`.ts`, or `.tsx` for components) once the step for that area is done. Until then, follow
  the style of the files around you.

## Layout (`app/`)

| Path | What |
|---|---|
| `server/index.js` | core: HTTP, auth, Socket.IO, action dispatch, per-user state views, client serving |
| `server/modules/NN-name.js` | feature modules (actions, filters, routes), auto-loaded in filename order |
| `server/lib/` | tables registry, admin, Chummer, Foundry, rulebooks, GM assistant, map library, demo table |
| `shared/*.js` | pure SR5 rules used by **both** server and browser (no Node or DOM APIs): `sr5.js`, `combat.js`, `matrix.js`, `chargen.js`… |
| `client/app.js` | browser shell: login, tabs, dock, sheet modal |
| `client/lib/` | `net.js` (state/actions), `ui.js` (UI kit), `ui-store.js`, `i18n.js`, `markdown.js` |
| `client/modules/<feature>/` | one folder per tab; `client/modules/registry.js` maps tabs to components |
| `client/i18n/en/*.json` | English dictionaries (French is the source text in code) |
| `data/catalog/` | gear catalogue generated from Chummer data |
| `data/seed/`, `data/packs/<pack>/` | content packs (seed = Project Lazarus, `vierge` = empty, `demo` = public demo) |
| `tools/` | tests (`test-*.js`), builders, importers |

Runtime data (`data/tables/`, `runtime/`, uploads, rulebook PDFs, map images) is never committed.

## Commands (run in `app/`)

| Command | What |
|---|---|
| `npm install` | dependencies (Node 20+; the Docker image uses Node 22) |
| `npm run dev` | server + Vite middleware on one port (3000): hot reload, no build |
| `npm run build` | production bundle in `dist/client/` (well under 1 s); Express serves it when present |
| `npm start` | server only: serves `dist/client/` if built, else the raw `client/` files |
| `npm run typecheck` | `tsc` over `.ts`/`.tsx` files |
| `node tools/test-<area>.js` | tests for one area; each starts its own isolated server |

## Rules that matter

- **Tests:** run only the test files for the areas you touched, once. Never the whole suite. Never start a server on
  port 3000 or without `SR_RUNTIME_DIR`: other sessions may be running. Use `tools/test-client.js`
  (`startServer({ port })`), which gives each test its own port and temp folder. Port ranges per test are listed in
  ARCHITECTURE.md « Testing ».
- **Server actions:** `server/modules/NN-x.js` exports `{ name, init, actions, filter, gmFilter, routes }`. Action
  names are `<module>/<verb>`. Handlers are synchronous and mutate `ctx.state`; the core saves and broadcasts. Validate
  every player payload. No per-table data in module-level variables. See ARCHITECTURE.md « Server module contract ».
- **Client:** components get `{ game }` (the user's view). Call `send(type, payload)` for actions. Use `TextInput` for
  anything sent to the server (it commits on blur). Module CSS sits next to the JS, loaded with `loadCss('/modules/x/x.css')`,
  with classes prefixed by the module name.
- **i18n:** UI text is written in French in the code and wrapped in `t()`/`tn()`/`tk()`. Add the English to
  `client/i18n/en/<area>.json`, then check with `node tools/i18n-check.js --area <area>`. The server throws
  `ctx.fail('Texte {x}', { x })`. Code comments and identifiers are in English.
- **SR5 rules:** when a rule is ambiguous or stacking is unclear, do what **Chummer5a** does. Cite book and page
  (`source`, `page` fields) the way the existing data does.
- **Security:** the page has a strict CSP (no inline scripts or handlers). Markdown goes through `renderMarkdown()`.
  Never build upload URLs yourself; the server returns them.
- **Content:** never commit rulebook text, PDFs, Fragmaps images or music files (see `.gitignore`).

## Where to look

| Topic | ARCHITECTURE.md section |
|---|---|
| state shape (actors, maps, combat, shop, campaign…) | « State shape » |
| client tabs and components | « Client contract » (registry table) |
| translations | « i18n » |
| multi-table, admin, demo table | « Multi-table hosting », « Demo table » |
| Matrix, chargen, enemy generator | « Round 3 additions » |
| rulebooks and page references | « Rulebooks » |
| modifiers (qualities, 'ware, powers → dice) | « Modifiers » |
| deployment | [`app/DEPLOY.md`](app/DEPLOY.md) |
