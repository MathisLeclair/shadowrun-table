// Multi-view layout of the table window (pure logic, no DOM: tools/test-layout.ts imports it).
// The main tab itself stays in the UI store (ui.mainTab); this layout adds, around it:
//   - split: a second tab shown next to the main one (draggable divider, side by side or stacked),
//   - floats: tabs shown as floating panels over the main area (moved / resized by hand),
//   - dockW: width of the right dock.
// A tab is shown at most once per window: opening it somewhere takes it out of where it was.
// Pop-out windows (a tab alone in its own browser window) are not part of the layout: see layout-store.ts.

export type SplitDir = 'row' | 'col';
export interface FloatPanel {
  tab: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}
export interface Layout {
  /** Last main tab (ui.mainTab is not remembered on its own): restored at reload, so the split pane comes back too. */
  main: string | null;
  split: string | null;
  splitDir: SplitDir;
  /** Share of the main pane, 0..1 (clamped to RATIO). */
  splitRatio: number;
  /** Last tab shown in the split pane: the split button reopens it. */
  lastSplit: string | null;
  floats: FloatPanel[];
  dockW: number;
}
/** New main tab + layout, for the moves that change both. */
export interface Placed {
  main: string;
  layout: Layout;
}
export interface Size {
  w: number;
  h: number;
}

export const RATIO = { min: 0.15, max: 0.85, def: 0.5 };
export const DOCK_W = { min: 260, def: 370, max: 760 };
export const FLOAT_MIN: Size = { w: 280, h: 180 };
/** Part of a floating panel that must stay inside the area, so it can always be grabbed back. */
export const FLOAT_KEEP = { x: 90, bar: 34 };

export const DEFAULT_LAYOUT: Layout = { main: null, split: null, splitDir: 'row', splitRatio: RATIO.def, lastSplit: null, floats: [], dockW: DOCK_W.def };

const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
export const clampRatio = (r: number) => Math.min(RATIO.max, Math.max(RATIO.min, num(r, RATIO.def)));
/** Dock width, never more than 60% of the viewport. */
export const clampDock = (w: number, viewportW = Infinity) =>
  Math.round(Math.max(DOCK_W.min, Math.min(DOCK_W.max, viewportW * 0.6, num(w, DOCK_W.def))));

/** Layout read back from storage: anything malformed falls back to the defaults. */
export function sanitizeLayout(raw: unknown): Layout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const floats: FloatPanel[] = [];
  for (const f of Array.isArray(r.floats) ? r.floats : []) {
    const tab = str(f?.tab);
    if (!tab || seen.has(tab) || floats.length >= 8) continue;
    seen.add(tab);
    floats.push({ tab, x: num(f.x, 40), y: num(f.y, 40), w: Math.max(FLOAT_MIN.w, num(f.w, 520)), h: Math.max(FLOAT_MIN.h, num(f.h, 420)), z: num(f.z, floats.length + 1) });
  }
  const split = str(r.split);
  return {
    main: str(r.main),
    split: split && !seen.has(split) ? split : null,
    splitDir: r.splitDir === 'col' ? 'col' : 'row',
    splitRatio: clampRatio(num(r.splitRatio, RATIO.def)),
    lastSplit: str(r.lastSplit),
    floats,
    dockW: clampDock(num(r.dockW, DOCK_W.def)),
  };
}

/**
 * Layout as shown for this main tab and these visible tabs: tabs the user can't see (role, hidden tab) are dropped,
 * and so is anything showing the main tab (the main pane wins).
 */
export function pruneLayout(L: Layout, main: string, visible: string[]): Layout {
  const ok = (tab: string | null) => !!tab && tab !== main && visible.includes(tab);
  const floats = L.floats.filter((f) => ok(f.tab));
  const split = ok(L.split) ? L.split : null;
  if (split === L.split && floats.length === L.floats.length) return L;
  return { ...L, split, floats };
}

export type Where = 'main' | 'split' | 'float' | null;
export function whereIs(L: Layout, main: string, tab: string): Where {
  if (tab === main) return 'main';
  if (L.split === tab) return 'split';
  if (L.floats.some((f) => f.tab === tab)) return 'float';
  return null;
}

/** Take a tab out of the split pane and the floating panels (it is about to be shown elsewhere). */
export function removeTab(L: Layout, tab: string): Layout {
  const floats = L.floats.filter((f) => f.tab !== tab);
  if (L.split !== tab && floats.length === L.floats.length) return L;
  return { ...L, split: L.split === tab ? null : L.split, floats };
}

/**
 * Show a tab in the main pane (top bar click). If it was in the split pane the two panes swap; if it was floating,
 * the panel closes.
 */
export function showInMain(L: Layout, main: string, tab: string): Placed {
  if (tab === main) return { main, layout: L };
  if (L.split === tab) return { main: tab, layout: { ...L, split: main, lastSplit: main } };
  return { main: tab, layout: removeTab(L, tab) };
}

/** Show a tab in the split pane (opening it if needed). The main tab can't go there: nothing changes. */
export function openSplit(L: Layout, main: string, tab: string): Layout {
  if (tab === main) return L;
  const out = removeTab(L, tab);
  return { ...out, split: tab, lastSplit: tab };
}

export function closeSplit(L: Layout): Layout {
  return L.split ? { ...L, split: null, lastSplit: L.split } : L;
}

/** Swap the main and split panes. */
export function swapSplit(L: Layout, main: string): Placed {
  if (!L.split) return { main, layout: L };
  return { main: L.split, layout: { ...L, split: main, lastSplit: main } };
}

/** Tab the split button opens: the last one used if still possible, else the first other visible tab. */
export function splitCandidate(L: Layout, main: string, visible: string[]): string | null {
  if (L.lastSplit && L.lastSplit !== main && visible.includes(L.lastSplit)) return L.lastSplit;
  return visible.find((id) => id !== main && !L.floats.some((f) => f.tab === id)) || null;
}

const topZ = (L: Layout) => L.floats.reduce((m, f) => Math.max(m, f.z), 0);

/** A tab can float unless it is the main tab with nothing to replace it (no split pane). */
export function canFloat(L: Layout, main: string, tab: string): boolean {
  return tab !== main || !!L.split;
}

/**
 * Open a tab as a floating panel (or bring it to the front if it already floats). Floating the main tab moves the
 * split pane's tab into the main pane.
 */
export function openFloat(L: Layout, main: string, tab: string, area: Size): Placed {
  if (!canFloat(L, main, tab)) return { main, layout: L };
  if (L.floats.some((f) => f.tab === tab)) return { main, layout: raiseFloat(L, tab) };
  let nextMain = main;
  let base = L;
  if (tab === main) {
    nextMain = L.split as string;
    base = { ...L, split: null, lastSplit: L.split };
  } else base = removeTab(L, tab);
  const n = base.floats.length;
  const w = Math.max(FLOAT_MIN.w, Math.min(560, Math.round(area.w * 0.45)));
  const h = Math.max(FLOAT_MIN.h, Math.min(520, Math.round(area.h * 0.7)));
  const panel = clampFloat({ tab, w, h, x: area.w - w - 16 - n * 28, y: 16 + n * 28, z: topZ(base) + 1 }, area);
  return { main: nextMain, layout: { ...base, floats: [...base.floats, panel] } };
}

export function raiseFloat(L: Layout, tab: string): Layout {
  const f = L.floats.find((p) => p.tab === tab);
  const z = topZ(L);
  if (!f || (f.z === z && L.floats.filter((p) => p.z === z).length === 1)) return L;
  return { ...L, floats: L.floats.map((p) => (p.tab === tab ? { ...p, z: z + 1 } : p)) };
}

export function closeFloat(L: Layout, tab: string): Layout {
  return removeTab(L, tab);
}

/** New position / size of a floating panel (clamped to the area). */
export function moveFloat(L: Layout, tab: string, rect: { x: number; y: number; w: number; h: number }, area: Size): Layout {
  return { ...L, floats: L.floats.map((p) => (p.tab === tab ? clampFloat({ ...p, ...rect }, area) : p)) };
}

/**
 * Keep a floating panel usable inside an area: at least the minimum size, no bigger than the area, its title bar
 * inside vertically and at least FLOAT_KEEP.x pixels of it inside horizontally.
 */
export function clampFloat(f: FloatPanel, area: Size): FloatPanel {
  const aw = Math.max(area.w, FLOAT_MIN.w);
  const ah = Math.max(area.h, FLOAT_MIN.h);
  const w = Math.round(Math.min(aw, Math.max(FLOAT_MIN.w, f.w)));
  const h = Math.round(Math.min(ah, Math.max(FLOAT_MIN.h, f.h)));
  const x = Math.round(Math.min(aw - FLOAT_KEEP.x, Math.max(FLOAT_KEEP.x - w, f.x)));
  const y = Math.round(Math.min(ah - FLOAT_KEEP.bar, Math.max(0, f.y)));
  return { ...f, w, h, x, y };
}
