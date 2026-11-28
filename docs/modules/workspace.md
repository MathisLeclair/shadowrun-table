# Workspace: split view, floating panels, pop-out windows

Several tabs on screen at once (e.g. the decker's Matrix tab or a sheet's Combat tab next to the map). Client only,
core-owned: `client/modules/core/Workspace.tsx` (UI), `client/lib/layout.ts` (pure moves, tested by
`tools/test-layout.ts`), `client/lib/layout-store.ts` (stored layout, `popOut()`), wired in `client/app.tsx`.

## What the user gets

| | how | notes |
|---|---|---|
| **Split view** | top bar ◫ button, Ctrl/Cmd+click or middle click on a tab, or right-click → « Open in split view » | draggable divider (double-click: 50/50); bar of the second pane: tab picker, swap ⇄, side by side / stacked, float, pop out, close |
| **Floating panels** | right-click a tab → « Open as floating panel », or ❐ in the split bar | drag by the title bar, resize by the corner, click to bring to front; always keeps its bar inside the main area |
| **Pop-out window** | right-click a tab → « Pop out… », ⧉ in a pane bar or in the dock header | `/t/<slug>/?pane=<tab id>`: a real browser window, can go to another screen; main and dock tabs |
| **Dock width** | drag the dock's left edge (double-click: default 370px) | 260–760px, at most 60% of the window |

Clicking a top tab shows it in the main pane: a tab in the split pane swaps with the main one, a floating tab closes
its panel. A tab is shown at most once per window; opening it elsewhere takes it out of where it was. The main tab can
float only when a split pane exists (its tab takes the main pane).

The layout (main tab, split tab / side / ratio, floating panels, dock width) is remembered per table in this browser
(`localStorage['sr.layout.<slug>']`). Narrow screens (≤ 900px) show the main pane only; the stored layout comes back on
a wide screen.

A **table display** ([display.md](display.md)) reuses the split view without the workspace UI: its panes (main + one
split, side by side or stacked, ratio) are a `DisplayLayout` stored server-side on the display link, set by the GM in
Settings → Table displays and pushed live (the display has no input). Only display-safe panes exist there: map,
initiative, handout, public rolls.

## Pop-out windows

Same login (the token is per browser), its own Socket.IO connection, so it is live on its own. It mounts the tab, the
sheet modal and `popoutGlobalComponents` (the global components minus `AudioEngine`: the main window plays the
ambience). Each window has its **own UI store**: selection, target, `viewMapId`… are not shared between windows, and
`goTab()` inside a pop-out does nothing visible. Window name `sr-pane-<slug>-<tab>`: popping the same tab again
brings its window back. A blocked pop-up shows a toast.

## For tab components

- A tab may render in a pane narrower than the viewport, or in a floating panel. Its root must fill its parent
  (`height: 100%`, like `.page`); the parent is an absolutely positioned box with a definite size.
  Layouts driven by `@media` (viewport width) may look cramped in a half-width pane.
- Watch the element's own size (`ResizeObserver`, as `MapCanvas` does), not `window` resize: the divider, the floating
  panel corner and the dock grip resize panes without a window resize.
- Two different tabs can be mounted at once (map + matrix…), never the same tab twice in one window. Keep per-instance
  state in the component (`useState`), not in module-level variables.
- `setUI({ mainTab: id })` / `goTab(id)` for a tab already shown in the split pane or a floating panel leaves the main
  pane alone (the floating panel comes to the front); the other keys of the patch still apply (`focusTokenId`…).
  This is `setMainTabGuard()` in `ui-store.ts`, installed by the workspace.
- Drags set the DOM directly and save once on release, so panes don't re-render on every pointer move.
