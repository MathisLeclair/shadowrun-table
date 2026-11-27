# React + TypeScript conversion — brief for module agents (TRANSITIONAL, deleted at the end of the migration)

You convert some client folders of the Shadowrun table app from Preact + `html``` templates (JS) to **React + JSX in
TypeScript**. Other agents convert the other folders at the same time, each in its own git worktree, so **only touch
your folders** (plus the few exceptions below). Read `AGENTS.md` (repo root) first.

## Where things stand (branch `react-ts-migration`)
- Core is done: `client/lib/ui.tsx` (UI kit, typed), `client/lib/net.ts` (`useGame`, `send`, `api`, `GameProps`…),
  `client/lib/ui-store.ts`, `client/app.tsx`. Old `.js` paths of those (`lib/ui.js`, `lib/net.js`, `lib/ui-store.js`)
  are one-line re-export stubs.
- `app/shared/types.ts` is the data model: `GameView` (what a component's `game` prop is), `ViewActor`/`Actor`,
  `GameMap`, `Token`, `CombatState`, `ShopState`, `MatrixView`, `Campaign`, `CatalogItem`… Read the parts you need.
  Notes from its author: `game.actors` values are `ViewActor = Actor | NpcStub` (narrow with `'attributes' in a`);
  `game.campaign` is `Campaign | PlayerCampaignView`; `matrix.hosts` values are `Host | PlayerHostView`;
  GM-only slices (`bestiary`, `foundry`) are optional; the map type is `GameMap` (not `Map`).
- `client/lib/legacy-html.ts` lets unconverted `html``` modules run on React, so the app works while folders are
  converted one by one. Your converted files must not use it.
- Vite builds the client; `npm run dev` = server + Vite (hot reload) on one port.

## Setup in your worktree
1. Your worktree must contain commit `2209152` (`git merge-base --is-ancestor 2209152 HEAD`). If it does not, run
   `git merge --ff-only react-ts-migration`, or report back if that fails.
2. `cd app && npm ci --no-audit --no-fund` (the worktree has no node_modules).
3. For the browser checks, create `.claude/launch.json` at the **worktree root**:
   `{ "version": "0.0.1", "configurations": [{ "name": "<your-agent-name>", "runtimeExecutable": "node",
   "runtimeArgs": ["app/server/index.js", "--vite"], "env": { "PORT": "<your port>", "SR_RUNTIME_DIR":
   "<a new empty temp folder>", "SR_ADMIN_PASSWORD": "admin-test-pw", "SR_DEMO_TABLE": "demo" }, "port": <your port> }] }`
   then `preview_start` with that name. The `demo` table (`/t/demo/`) needs no password: enter as GM, or as a player
   with a pre-made character (open a second tab for the player side). The `lazarus` table is created too (GM password
   `lazarus`) and has the richer Project Lazarus content.

## Conversion rules
- Every `.js` file in your folders becomes `.tsx` (has JSX) or `.ts` (no JSX) — **except** the files listed under
  « Stay .js » in your task: Node tests import them and Node cannot load `.ts` yet. Leave those unchanged (they are
  converted in a later step).
- `html``…``` → JSX. Attribute renames: `class`→`className`, `for`→`htmlFor`, CSS strings in `style` → objects,
  `onDblClick`→`onDoubleClick`, `readonly`→`readOnly`, `maxlength`→`maxLength`, `colspan`→`colSpan`,
  `tabindex`→`tabIndex`, `autofocus`→`autoFocus`, `inputmode`→`inputMode`, `spellcheck`→`spellCheck`, SVG dash-case
  attributes → camelCase (`stroke-width`→`strokeWidth`; `data-*`/`aria-*` stay). Components from `ui.tsx` take
  `className` (not `class`).
- **Events — watch this one:** Preact `onInput` on a text field = React `onChange` (both fire per keystroke).
  But a Preact `onChange` on a text `<input>`/`<textarea>` is the native « change » event (fires on blur or Enter):
  keep that behaviour explicitly (use `TextInput` from `ui.tsx`, or `onBlur` + Enter), never a bare React `onChange`,
  or it will send a server action per keystroke. `<select>`, checkbox, radio, file: `onChange` stays.
- A controlled `value` with no `onChange` is frozen in React: wire `onChange`, or use `defaultValue` (+ a `key` to
  reset it).
- Every list built with `.map()` gets a stable `key` (an id; the index only for static lists).
- Hooks come from `'react'`. No `preact` import may remain. `useEffect` must return nothing or a cleanup function:
  `return () => set.delete(x)` returns a boolean, write `return () => { set.delete(x); };`.
- Refs: `useRef<HTMLDivElement>(null)`. Canvas/WebGL/Three.js code stays as it is, just typed.
- CSS: replace `loadCss('/modules/x/x.css')` with `import './x.css';` at the top of the module.
- Props: an `interface` per component. Tab/dock/global components take `GameProps` from `../../lib/net.ts`.
  Use the types from `shared/types.ts` (`import type { … } from '../../../shared/types.ts'`). Avoid `any`; use it
  (with a short comment) only for genuinely dynamic data. If a type in `shared/types.ts` is wrong or missing a field,
  **do not edit that file** (every agent would conflict on it): declare a local type in your folder (e.g.
  `client/modules/<folder>/types.ts`) and list the gap in your report.
- Imports: write the real extension of the target (`./Foo.tsx`, `../../lib/ui.tsx`, `../../lib/net.ts`,
  `../../lib/ui-store.ts`). Files of other folders that are not converted yet keep `.js`.
- **Stubs:** when you rename a file that is imported from **outside** your folders (grep `app/client`, `app/server`,
  `app/tools` for its name), leave a one-line `.js` stub at the old path:
  `export * from './Foo.tsx';` plus `export { default } from './Foo.tsx';` if it has a default export. The final
  integration rewrites every import and deletes the stubs. Never edit files outside your folders, except to keep
  imports of your own renamed files working when a stub cannot (say so in the report).
- i18n: keep every `t()`, `tn()`, `tk()` call and its exact French text (they are dictionary keys). If you must change
  a French string, update `client/i18n/en/<area>.json`.
- Same behaviour: this is a conversion, not a refactor. No new features, no redesign, keep the comments. Small,
  obviously correct simplifications are fine; anything else goes in the report as a suggestion.

## Checks before you finish
1. `cd app && npx tsc -p tsconfig.json` → no errors in your folders' files (ignore other folders).
2. `npx vite build` succeeds.
3. In the browser (preview), go through **every screen and dialog of your folders**, as GM and as a player where it
   applies, and click the main controls (forms, buttons, drag where relevant). The console must show no errors from
   your components (React errors, missing keys, controlled/uncontrolled warnings). Check that text inputs still
   commit on blur, not per keystroke.
4. Node tests: they don't load `.tsx` files. Run `node tools/test-<x>.js` only if you changed a file one of them
   imports. Never run the whole suite.
5. Commit in your worktree branch (`git add` your folders only), message `Convert <folders> to React TSX`, ending with
   the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Report back (short)
Your branch name and commit; files converted; stubs left; files not converted and why; type gaps you found in
`shared/types.ts`; what you checked in the browser and what you could not check; any behaviour you were unsure about.
