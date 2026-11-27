# AGENTS.md — working on Shadowrun Table

Guide for AI coding agents (and humans) working in this repository. Read this first. Details are in
[`docs/`](docs/README.md), one page per topic: open the page you need (« Where to look » below), not all of them.

## What this is

A real-time, self-hosted virtual tabletop for **Shadowrun 5th Edition**. One Node server hosts one or more **tables**
(independent campaigns); the GM and players connect from a browser. Everything lives in `app/`.

**Stack:** TypeScript everywhere (strict). The browser UI is **React 19** in `.tsx`, bundled by **Vite**. The server
(Express + Socket.IO) and the shared rules are `.ts` files that **Node runs directly** (type stripping: no server
build). The data model — table state, the per-user view, actors, maps, catalog items, the server module contract —
is in **`app/shared/types.ts`**: start there.
- New code is TypeScript: `.tsx` for components, `.ts` for everything else. Imports name the real file
  (`./Foo.tsx`, `../../lib/net.ts`, `/shared/sr5.ts` in the client).
- Type stripping only erases types: no `enum`, `namespace` or constructor parameter properties, and type-only imports
  must be `import type` (`verbatimModuleSyntax`).
- Pure logic that Node tests import goes in `.ts` files without JSX; components can't be loaded by Node.

## Layout (`app/`)

| Path | What |
|---|---|
| `server/index.ts` | core: HTTP, auth, Socket.IO, action dispatch, per-user state views, client serving |
| `server/modules/NN-name.ts` | feature modules (actions, filters, routes), auto-loaded in filename order |
| `server/lib/` | tables registry, admin, Chummer, Foundry, rulebooks, GM assistant, map library, demo table |
| `shared/*.ts` | pure SR5 rules used by **both** server and browser (no Node or DOM APIs): `sr5.ts`, `combat.ts`, `matrix.ts`, `chargen.ts`… |
| `client/app.tsx` | browser shell: login, tabs, dock, sheet modal |
| `client/lib/` | `net.ts` (state/actions), `ui.tsx` (UI kit), `ui-store.ts`, `i18n.ts`, `markdown.ts` |
| `client/modules/<feature>/` | one folder per tab; `client/modules/registry.ts` maps tabs to components |
| `client/i18n/fr/*.json` | French dictionaries (English is the source text in code); `legacy-fr-keys.json` maps old saved French keys |
| `data/catalog/` | gear catalogue generated from Chummer data |
| `data/seed/`, `data/packs/<pack>/` | content packs (seed = Project Lazarus, `vierge` = empty, `demo` = public demo) |
| `tools/` | tests (`test-*.ts`), builders, importers (TypeScript, run by Node) |

Runtime data (`data/tables/`, `runtime/`, uploads, rulebook PDFs, map images) is never committed.

## Commands (run in `app/`)

| Command | What |
|---|---|
| `npm install` | dependencies (Node 22.18+, 24 LTS recommended; the Docker image uses Node 24) |
| `npm run dev` | server + Vite middleware on one port (3000): hot reload, no build |
| `npm run build` | production bundle in `dist/client/` (well under 1 s); Express serves it when present |
| `npm start` | server only (`node server/index.ts`): serves `dist/client/`; build first |
| `npm run typecheck` | `tsc` (strict) over the whole app: must stay at 0 errors |
| `node tools/test-<area>.ts` | tests for one area; each starts its own isolated server. On Node < 22.18 set `NODE_OPTIONS=--experimental-strip-types` |

## Rules that matter

- **Tests:** run only the test files for the areas you touched, once. Never the whole suite. Never start a server on
  port 3000 or without `SR_RUNTIME_DIR`: other sessions may be running. Use `tools/test-client.ts`
  (`startServer({ port })`), which gives each test its own port and temp folder. Port ranges per test are listed in
  [docs/testing.md](docs/testing.md).
- **Server actions:** `server/modules/NN-x.ts` exports `{ name, init, actions, filter, gmFilter, routes }`. Action
  names are `<module>/<verb>`. Handlers are synchronous and mutate `ctx.state`; the core saves and broadcasts. Validate
  every player payload. No per-table data in module-level variables. See [docs/architecture.md](docs/architecture.md).
- **Client:** components get `{ game }` (the user's view). Call `send(type, payload)` for actions. Use `TextInput` for
  anything sent to the server (it commits on blur). Module CSS sits next to the component and is imported (`import './x.css';`),
  with classes prefixed by the module name. React: every `.map()` list gets a stable `key`; a text field that sends to
  the server commits on blur/Enter, never per keystroke.
- **i18n:** UI text is written in English in the code and wrapped in `t()`/`tn()`/`tk()`. Add the French to
  `client/i18n/fr/<area>.json`, then check with `node tools/i18n-check.ts --area <area>`. The server throws
  `ctx.fail('Texte {x}', { x })`. Code comments and identifiers are in English.
- **SR5 rules:** when a rule is ambiguous or stacking is unclear, do what **Chummer5a** does. Cite book and page
  (`source`, `page` fields) the way the existing data does.
- **Security:** the page has a strict CSP (no inline scripts or handlers). Markdown goes through `renderMarkdown()`.
  Never build upload URLs yourself; the server returns them.
- **Content:** never commit rulebook text, PDFs, Fragmaps images or music files (see `.gitignore`).

## Where to look

| Topic | Page |
|---|---|
| data model types (state, view, actors, maps, catalog, server contract) | `app/shared/types.ts` (the code is the reference); [docs/data-model.md](docs/data-model.md) |
| module contracts, which page covers which module, routing, security | [docs/architecture.md](docs/architecture.md) |
| a feature (sheet, maps, combat, shop, Matrix, chargen, notes, books…) | [docs/README.md](docs/README.md) « Features » → `docs/modules/<feature>.md` |
| SR5 rules implemented, with book and page | [docs/rules/](docs/rules/README.md) |
| modifiers (qualities, 'ware, powers → dice) | [docs/modules/modifiers.md](docs/modules/modifiers.md), [docs/rules/modifiers-stacking.md](docs/rules/modifiers-stacking.md) |
| tests and their ports | [docs/testing.md](docs/testing.md) |
| translations | [docs/i18n.md](docs/i18n.md) |
| multi-table, admin, demo table | [docs/modules/multi-table.md](docs/modules/multi-table.md), [docs/modules/demo-table.md](docs/modules/demo-table.md) |
| deployment | [docs/deploy.md](docs/deploy.md) |
