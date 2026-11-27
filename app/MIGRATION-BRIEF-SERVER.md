# TypeScript conversion — brief for server / shared agents (TRANSITIONAL, deleted at the end of the migration)

You convert part of the Shadowrun table app's **Node-side code** (server, shared rules, and the client files that
Node also loads) from JavaScript to **TypeScript run directly by Node** (type stripping: no build, no tsc output).
Other agents convert other parts at the same time, each in its own git worktree, so **only touch your files**.
Read `AGENTS.md` (repo root) first.

## Where things stand (branch `react-ts-migration`)
- `app/shared/types.ts` is the data model: `TableState`, `GameView`, `Actor`, `GameMap`, `CatalogItem`…, and the
  server contract: `ServerModule<App, Middleware>`, `ActionContext`, `ActionDef`, `RouteHelpers`, `InitOptions`,
  `ServerEvents`. Notes from its author: `TableState` slices are all required (true after boot; `emptyState()` only
  has `version, config, users, actors, log`); there is no `@types/express` yet, so `ServerModule`/`RouteHelpers` are
  generic and default to `unknown` (see « Express types » below).
- Client folders are being converted to React `.tsx` by other agents (not your concern).
- `tsconfig.json` covers the whole app: `strict`, `allowJs` (JS not checked), `allowImportingTsExtensions`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noEmit`.

## Node runs .ts directly
- Node 22.18+ / 24 strips types natively. The local machine has **Node 22.15**: set
  `NODE_OPTIONS=--experimental-strip-types` for every `node` command you run (tests spawn the server as a child
  process; the env variable is inherited, `execArgv` is not). Example (bash):
  `NODE_OPTIONS=--experimental-strip-types node tools/test-combat.js`.
- Type stripping only erases syntax. So: **no `enum`, no `namespace`, no constructor parameter properties, no
  `import x = require()`**. Type-only imports must be written `import type { X }` or `import { type X }`
  (`verbatimModuleSyntax`), otherwise Node fails at run time with « does not provide an export named X ».
- Import specifiers must name the real file: `import { roll } from '../../shared/sr5.ts'`. JSON imports keep their
  `with { type: 'json' }` if they have one.
- Workers and child processes that load a file by path (`new Worker(new URL('./index-worker.js', import.meta.url))`)
  must point at the new `.ts` name.

## Setup in your worktree
1. Your worktree must contain commit `837d89b` (`git merge-base --is-ancestor 837d89b HEAD`). If not, run
   `git merge --ff-only react-ts-migration`, or report back if that fails.
2. `cd app && npm ci --no-audit --no-fund`.
3. Express types: if you need them, the server-core agent adds `@types/express` (others: type the `app`/`req`/`res`
   parameters loosely with a local alias and say so in the report, rather than adding the dependency yourself).

## Conversion rules
- Every `.js` file in your scope becomes `.ts` (no JSX on the server). Keep behaviour identical: this is a
  conversion, not a refactor. Keep comments. No new features.
- Type with `shared/types.ts`. Avoid `any`; use it (with a short comment) only for genuinely dynamic data (parsed
  XML, foreign JSON). If a type in `shared/types.ts` is wrong or missing a field, only the **shared** agent may edit
  that file. Others: declare a local type next to your code and list the gap in your report.
- **Stubs:** when you rename a file that is imported from **outside** your scope (grep `app/server`, `app/shared`,
  `app/client`, `app/tools` for its name), leave a one-line `.js` stub at the old path:
  `export * from './x.ts';` plus `export { default } from './x.ts';` if it has a default export. Stubs keep the
  other agents' code and the tests working; the final integration rewrites every import and deletes the stubs.
  Inside your scope, import the `.ts` names directly.
- Server modules (`server/modules/NN-x.js`): the default export becomes `const mod: ServerModule = { … }; export
  default mod;` (or `satisfies`), typed handlers `handler(ctx: ActionContext, payload: XPayload)`. Note
  `server/index.js` loads modules by scanning the folder for `.js` files: the server-core agent changes it to load
  `.ts` (and ignore stubs) — until that lands, keep a stub for each module.
- i18n: keep every `t()`, `tn()`, `tk()`, `ctx.fail('…')` text exactly (they are dictionary keys).

## Checks before you finish
1. `cd app && npx tsc -p tsconfig.json` → no errors in your files (ignore errors elsewhere).
2. Run the Node tests for the areas you touched, once each (with `NODE_OPTIONS` as above). Your task lists them.
   Never run the whole suite.
3. `NODE_OPTIONS=--experimental-strip-types node server/index.js` must still start (use `PORT=<your port>` and a temp
   `SR_RUNTIME_DIR`; stop it after it prints its addresses).
4. Commit in your worktree branch (your files only), message `Convert <scope> to TypeScript`, ending with
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Report back (short)
Branch and commit; files converted; stubs left; anything not converted and why; type gaps in `shared/types.ts`;
tests run and results; anything you were unsure about.
