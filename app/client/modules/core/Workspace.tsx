// Multi-view workspace of the table window (core-owned): top tabs with their « open in… » menu, the main area
// (main pane + optional split pane with a draggable divider + floating panels), the split button and the dock's
// resize grip. Layout moves: lib/layout.ts (pure); stored per table in this browser: lib/layout-store.ts.
// Narrow screens (≤ 900px) show the main pane only. Drags move the DOM directly and save once, on release, so the
// tabs underneath (map canvas…) don't re-render on every pointer move. Docs: docs/modules/workspace.md.
import { useEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { cx } from '../../lib/ui.tsx';
import { getUI, setUI, setMainTabGuard } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { getLayout, setLayout, useLayout, popOut } from '../../lib/layout-store.ts';
import {
  showInMain,
  openSplit,
  closeSplit,
  swapSplit,
  splitCandidate,
  openFloat,
  canFloat,
  raiseFloat,
  closeFloat,
  moveFloat,
  removeTab,
  pruneLayout,
  whereIs,
  clampFloat,
  clampRatio,
  clampDock,
  RATIO,
  DOCK_W,
  type FloatPanel,
  type Placed,
  type Size,
} from '../../lib/layout.ts';
import type { GameProps } from '../../lib/net.ts';
import type { GameView } from '../../../shared/types.ts';
import './workspace.css';

/** What the workspace needs from a registry tab entry. */
export interface WsTab {
  id: string;
  label: string;
  icon?: string;
  component: ComponentType<GameProps>;
  badge?: (game: GameView) => string | number | null;
}

const NARROW = '(max-width: 900px)';
const isNarrow = () => {
  try {
    return window.matchMedia(NARROW).matches;
  } catch {
    return false;
  }
};
/** Hook: true on narrow screens (phones), where only the main pane is shown. */
export function useNarrow(): boolean {
  const [n, set] = useState(isNarrow);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(NARROW);
    } catch {
      return;
    }
    const on = () => set(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return n;
}

// The main area element (set by <Workspace>): floating panels are placed inside it.
let areaEl: HTMLElement | null = null;
const areaSize = (): Size => (areaEl ? { w: areaEl.clientWidth, h: areaEl.clientHeight } : { w: window.innerWidth * 0.7, h: window.innerHeight - 60 });

function place(p: Placed) {
  setLayout(p.layout);
  if (p.main !== getUI().mainTab) setUI({ mainTab: p.main });
}

/** Layout moves for a tab, given the tab now in the main pane. */
const act = {
  main: (main: string, tab: string) => place(showInMain(getLayout(), main, tab)),
  split: (main: string, tab: string) => setLayout((l) => openSplit(l, main, tab)),
  float: (main: string, tab: string) => place(openFloat(getLayout(), main, tab, areaSize())),
  pop: (tab: string, size?: Size) => {
    if (popOut(tab, size)) setLayout((l) => removeTab(l, tab));
  },
};

/** Pointer drag on an element: move(ev) on every move, end() once on release. Left button only. */
function drag(e: ReactPointerEvent<HTMLElement>, cursor: string, move: (ev: PointerEvent) => void, end: () => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.body.classList.add('ws-dragging');
  document.body.style.cursor = cursor;
  const onUp = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('ws-dragging');
    document.body.style.cursor = '';
    end();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

// ---------------------------------------------------------------------------
// Context menu (right-click on a top tab)
// ---------------------------------------------------------------------------
interface MenuItem {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}
function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="ws-menu" role="menu" style={{ left: Math.max(4, Math.min(x, window.innerWidth - 250)), top: y }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="ws-menu-item"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          <span className="ws-menu-icon">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top tabs
// ---------------------------------------------------------------------------
/**
 * Main tabs of the top bar. Click: show in the main pane (swaps with the split pane, docks a floating panel back).
 * Ctrl/Cmd+click or middle click: open in the split pane. Right-click: every way of opening it.
 */
export function TopTabs({ game, tabs, current }: { game: GameView; tabs: WsTab[]; current: WsTab }) {
  const narrow = useNarrow();
  const raw = useLayout();
  const L = pruneLayout(raw, current.id, tabs.map((tb) => tb.id));
  const [menu, setMenu] = useState<{ tab: string; x: number; y: number } | null>(null);
  const closeMenu = useRef(() => setMenu(null)).current;

  const items = (tab: string): MenuItem[] => {
    const where = whereIs(L, current.id, tab);
    const list: MenuItem[] = [];
    if (where !== 'main') list.push({ icon: '⤢', label: t('Show in the main view'), onClick: () => act.main(current.id, tab) });
    if (where !== 'main' && where !== 'split') list.push({ icon: '◫', label: t('Open in split view'), onClick: () => act.split(current.id, tab) });
    if (where === 'float') list.push({ icon: '❐', label: t('Bring to front'), onClick: () => setLayout((l) => raiseFloat(l, tab)) });
    else list.push({ icon: '❐', label: t('Open as floating panel'), onClick: () => act.float(current.id, tab), disabled: !canFloat(L, current.id, tab) });
    list.push({ icon: '⧉', label: t('Pop out to a new window'), onClick: () => act.pop(tab) });
    if (where === 'split') list.push({ icon: '✕', label: t('Close the split view'), onClick: () => setLayout(closeSplit) });
    if (where === 'float') list.push({ icon: '✕', label: t('Close the floating panel'), onClick: () => setLayout((l) => closeFloat(l, tab)) });
    return list;
  };

  return (
    <nav className="main-tabs">
      {tabs.map((tb) => {
        const badge = tb.badge ? tb.badge(game) : null;
        const where = narrow ? (tb.id === current.id ? 'main' : null) : whereIs(L, current.id, tb.id);
        return (
          <button
            key={tb.id}
            className={cx('main-tab', where === 'main' && 'active', where === 'split' && 'ws-in-split', where === 'float' && 'ws-in-float')}
            title={narrow ? undefined : t('Ctrl+click: open in split view · right-click: more')}
            onClick={(e) => {
              if (!narrow && (e.ctrlKey || e.metaKey)) act.split(current.id, tb.id);
              else if (narrow) setUI({ mainTab: tb.id });
              else act.main(current.id, tb.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1 && !narrow) {
                e.preventDefault();
                act.split(current.id, tb.id);
              }
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
            }}
            onContextMenu={(e) => {
              if (narrow) return;
              e.preventDefault();
              setMenu({ tab: tb.id, x: e.clientX, y: e.clientY + 4 });
            }}
          >
            <span className="tab-icon">{tb.icon}</span>
            <span className="tab-label">{t(tb.label)}</span>
            {where === 'split' && <span className="ws-tab-where">◫</span>}
            {where === 'float' && <span className="ws-tab-where">❐</span>}
            {badge ? <span className="tab-badge">{badge}</span> : null}
          </button>
        );
      })}
      {menu && <Menu x={menu.x} y={menu.y} items={items(menu.tab)} onClose={closeMenu} />}
    </nav>
  );
}

/** Top bar button: open the split view (last tab used there, else the next tab) or close it. Hidden on narrow screens. */
export function SplitButton({ tabs, current }: { tabs: WsTab[]; current: WsTab }) {
  const narrow = useNarrow();
  const raw = useLayout();
  if (narrow) return null;
  const ids = tabs.map((tb) => tb.id);
  const L = pruneLayout(raw, current.id, ids);
  const candidate = splitCandidate(L, current.id, ids);
  if (!L.split && !candidate) return null;
  return (
    <button
      className={cx('icon-btn', L.split && 'ws-split-on')}
      title={L.split ? t('Close the split view') : t('Split view')}
      onClick={() => setLayout((l) => (L.split ? closeSplit(l) : openSplit(l, current.id, candidate as string)))}
    >
      ◫
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main area
// ---------------------------------------------------------------------------
const basis = (r: number) => `calc(${(r * 100).toFixed(2)}% - 3px)`;

function Btn({ icon, title, onClick }: { icon: ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn ws-btn" title={title} aria-label={title} onClick={onClick}>
      {icon}
    </button>
  );
}

/** Main pane + split pane + floating panels. */
export function Workspace({ game, tabs, current, lang }: { game: GameView; tabs: WsTab[]; current: WsTab; lang: string }) {
  const narrow = useNarrow();
  const raw = useLayout();
  const L = pruneLayout(raw, current.id, tabs.map((tb) => tb.id));
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size>({ w: 0, h: 0 });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    areaEl = el;
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (areaEl === el) areaEl = null;
    };
  }, []);

  // Remember the main tab (restored at reload by the shell).
  useEffect(() => {
    if (getLayout().main !== current.id) setLayout((l) => ({ ...l, main: current.id }));
  }, [current.id]);

  // A module asking for a tab already on screen aside (split pane, floating panel) leaves the main pane alone.
  useEffect(() => {
    setMainTabGuard((id) => {
      if (isNarrow()) return false;
      const l = getLayout();
      if (l.split === id) return true;
      if (l.floats.some((f) => f.tab === id)) {
        setLayout(raiseFloat(l, id));
        return true;
      }
      return false;
    });
    return () => setMainTabGuard(null);
  }, []);

  const split = narrow ? null : tabs.find((tb) => tb.id === L.split) || null;
  const floats = narrow ? [] : L.floats;
  const row = L.splitDir === 'row';
  const Main = current.component;
  const Second = split?.component;

  const onDivider = (e: ReactPointerEvent<HTMLElement>) => {
    const box = rootRef.current?.getBoundingClientRect();
    const pane = primaryRef.current;
    if (!box || !pane) return;
    const total = row ? box.width : box.height;
    const minR = Math.max(RATIO.min, 220 / total);
    const maxR = Math.min(RATIO.max, 1 - 220 / total);
    let r = L.splitRatio;
    drag(
      e,
      row ? 'col-resize' : 'row-resize',
      (ev) => {
        const pos = row ? ev.clientX - box.left : ev.clientY - box.top;
        r = Math.min(maxR, Math.max(minR, pos / total));
        pane.style.flexBasis = basis(r);
      },
      () => setLayout((l) => ({ ...l, splitRatio: clampRatio(r) })),
    );
  };

  const paneSize = (el: HTMLElement | null): Size | undefined => (el ? { w: el.clientWidth, h: el.clientHeight + 40 } : undefined);

  return (
    <div ref={rootRef} className={cx('ws', split && 'ws-split', row ? 'ws-row' : 'ws-col')}>
      <div key="primary" ref={primaryRef} className="ws-pane ws-primary" style={split ? { flexBasis: basis(L.splitRatio) } : undefined}>
        <div className="ws-fill">
          <Main key={lang} game={game} />
        </div>
      </div>
      {split && Second && (
        <div
          key="divider"
          className="ws-divider"
          role="separator"
          aria-orientation={row ? 'vertical' : 'horizontal'}
          title={t('Drag to resize · double-click to reset')}
          onPointerDown={onDivider}
          onDoubleClick={() => setLayout((l) => ({ ...l, splitRatio: RATIO.def }))}
        />
      )}
      {split && Second && (
        <div key="second" ref={secondRef} className="ws-pane ws-second">
          <div className="ws-bar">
            <span className="ws-bar-icon">{split.icon}</span>
            <select className="ws-bar-select" value={split.id} onChange={(e) => setLayout((l) => openSplit(l, current.id, e.target.value))}>
              {tabs
                .filter((tb) => tb.id !== current.id)
                .map((tb) => (
                  <option key={tb.id} value={tb.id}>
                    {t(tb.label)}
                  </option>
                ))}
            </select>
            <span className="ws-bar-gap" />
            <Btn icon="⇄" title={t('Swap the panes')} onClick={() => place(swapSplit(getLayout(), current.id))} />
            <Btn
              icon={row ? '⇅' : '⇆'}
              title={row ? t('Stack the panes') : t('Side by side')}
              onClick={() => setLayout((l) => ({ ...l, splitDir: row ? 'col' : 'row' }))}
            />
            <Btn icon="❐" title={t('Open as floating panel')} onClick={() => act.float(current.id, split.id)} />
            <Btn icon="⧉" title={t('Pop out to a new window')} onClick={() => act.pop(split.id, paneSize(secondRef.current))} />
            <Btn icon="✕" title={t('Close the split view')} onClick={() => setLayout(closeSplit)} />
          </div>
          <div className="ws-pane-body">
            <div className="ws-fill">
              <Second key={lang} game={game} />
            </div>
          </div>
        </div>
      )}
      {area.w > 0 &&
        floats.map((f) => {
          const tab = tabs.find((tb) => tb.id === f.tab);
          return tab ? <FloatWin key={'f:' + f.tab} panel={f} area={area} tab={tab} main={current.id} game={game} lang={lang} /> : null;
        })}
    </div>
  );
}

function FloatWin({ panel, area, tab, main, game, lang }: { panel: FloatPanel; area: Size; tab: WsTab; main: string; game: GameView; lang: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const f = clampFloat(panel, area);
  const C = tab.component;

  const apply = (r: FloatPanel) => {
    const el = ref.current;
    if (!el) return;
    el.style.left = r.x + 'px';
    el.style.top = r.y + 'px';
    el.style.width = r.w + 'px';
    el.style.height = r.h + 'px';
  };
  const commit = (r: FloatPanel) => setLayout((l) => moveFloat(l, tab.id, r, area));

  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button, select, input')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let r = f;
    drag(
      e,
      'move',
      (ev) => {
        r = clampFloat({ ...f, x: f.x + ev.clientX - sx, y: f.y + ev.clientY - sy }, area);
        apply(r);
      },
      () => commit(r),
    );
  };
  const onResize = (e: ReactPointerEvent<HTMLElement>) => {
    const sx = e.clientX;
    const sy = e.clientY;
    let r = f;
    drag(
      e,
      'nwse-resize',
      (ev) => {
        r = clampFloat({ ...f, w: f.w + ev.clientX - sx, h: f.h + ev.clientY - sy }, area);
        apply(r);
      },
      () => commit(r),
    );
  };

  return (
    <div
      ref={ref}
      className="ws-float"
      style={{ left: f.x, top: f.y, width: f.w, height: f.h, zIndex: 10 + f.z }}
      onPointerDownCapture={() => setLayout((l) => raiseFloat(l, tab.id))}
    >
      <div className="ws-bar ws-float-bar" onPointerDown={onMove} title={t('Drag to move')}>
        <span className="ws-bar-icon">{tab.icon}</span>
        <span className="ws-bar-title">{t(tab.label)}</span>
        <span className="ws-bar-gap" />
        <Btn icon="◫" title={t('Open in split view')} onClick={() => act.split(main, tab.id)} />
        <Btn icon="⤢" title={t('Show in the main view')} onClick={() => act.main(main, tab.id)} />
        <Btn icon="⧉" title={t('Pop out to a new window')} onClick={() => act.pop(tab.id, { w: f.w, h: f.h })} />
        <Btn icon="✕" title={t('Close the floating panel')} onClick={() => setLayout((l) => closeFloat(l, tab.id))} />
      </div>
      <div className="ws-pane-body">
        <div className="ws-fill">
          <C key={lang} game={game} />
        </div>
      </div>
      <div className="ws-float-resize" title={t('Resize')} onPointerDown={onResize} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------
/** Width of the right dock for the shell's --dock-w (this browser's choice, clamped to the window). */
export function useDockWidth(): number {
  const L = useLayout();
  return clampDock(L.dockW, typeof window === 'undefined' ? Infinity : window.innerWidth);
}

/** Grip on the dock's left edge: drag to resize the dock, double-click to reset. */
export function DockGrip({ shellRef }: { shellRef: RefObject<HTMLElement | null> }) {
  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    const right = shell.getBoundingClientRect().right;
    let w = getLayout().dockW;
    drag(
      e,
      'col-resize',
      (ev) => {
        w = clampDock(right - ev.clientX, window.innerWidth);
        shell.style.setProperty('--dock-w', w + 'px');
      },
      () => setLayout((l) => ({ ...l, dockW: w })),
    );
  };
  return (
    <div
      className="ws-dock-grip"
      role="separator"
      aria-orientation="vertical"
      title={t('Drag to resize · double-click to reset')}
      onPointerDown={onDown}
      onDoubleClick={() => setLayout((l) => ({ ...l, dockW: DOCK_W.def }))}
    />
  );
}

/** Dock header button: pop the current dock tab out to its own window. */
export function DockPopButton({ tab }: { tab: string }) {
  const narrow = useNarrow();
  if (narrow) return null;
  return <Btn icon="⧉" title={t('Pop out to a new window')} onClick={() => popOut(tab, { w: 460, h: 760 })} />;
}
