// Multi-view layout store (client only, remembered per table in this browser) and pop-out windows.
// Pure moves are in layout.ts; the UI is client/modules/core/Workspace.tsx. See docs/modules/workspace.md.
import { useEffect, useState } from 'react';
import { TABLE } from './net.ts';
import { toast } from './ui-store.ts';
import { t } from './i18n.ts';
import { DEFAULT_LAYOUT, sanitizeLayout, type Layout } from './layout.ts';

const KEY = `sr.layout.${TABLE || '_'}`;
/** Query parameter of a pop-out window: /t/<slug>/?pane=<tab id>. */
export const PANE_PARAM = 'pane';

function load(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeLayout(JSON.parse(raw)) : { ...DEFAULT_LAYOUT };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

let layout: Layout = load();
const listeners = new Set<(l: Layout) => void>();

export function getLayout(): Layout {
  return layout;
}

/** Replace the layout (or patch it with a function of the current one) and remember it in this browser. */
export function setLayout(next: Layout | ((l: Layout) => Layout)) {
  const value = typeof next === 'function' ? next(layout) : next;
  if (value === layout) return;
  layout = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* blocked storage: the layout lasts until the page is reloaded */
  }
  for (const l of listeners) l(layout);
}

/** Hook: re-renders when the layout changes. */
export function useLayout(): Layout {
  const [l, set] = useState<Layout>(layout);
  useEffect(() => {
    if (layout !== l) set(layout);
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return l;
}

/** Tab shown alone in this window when it is a pop-out (?pane=<id>), else null. */
export const POPOUT_TAB: string | null = (() => {
  try {
    return new URLSearchParams(location.search).get(PANE_PARAM) || null;
  } catch {
    return null;
  }
})();

/**
 * Open a tab alone in its own browser window (can go to another screen). Same window name per tab: clicking again
 * brings the existing window back instead of opening a second one. Returns false when the browser blocked it.
 */
export function popOut(tab: string, size: { w: number; h: number } = { w: 1000, h: 760 }): boolean {
  const url = `${location.pathname}?${PANE_PARAM}=${encodeURIComponent(tab)}`;
  const w = window.open(url, `sr-pane-${TABLE || '_'}-${tab}`, `popup=yes,width=${Math.round(size.w)},height=${Math.round(size.h)}`);
  if (!w) {
    toast(t('The browser blocked the new window: allow pop-ups for this site'), 'warn', 6000);
    return false;
  }
  try {
    w.focus();
  } catch {
    /* ignore */
  }
  return true;
}
