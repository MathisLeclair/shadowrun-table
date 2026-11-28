// <MapCanvas> hosts one MapRenderer and turns pointer input into high-level callbacks.
// Pan: drag empty space / middle mouse / right-drag / two fingers (or `panOnly()`); zoom: wheel / pinch (to cursor).
// handlers (all optional, read through a ref so they can change every render):
//   onDown(info) → true to take the gesture (then onMove(info) / onUp(info, moved) / onCancel())
//   onClick(info), onDblClick(info), onContext(info) (right click or two-finger… no: right click), onLongPress(info) (touch),
//   onHover(info|null), onDropData(info, dataTransfer), panOnly() → bool
// info = { sx, sy (CSS px in canvas), fx, fy (world cells, float), cx, cy (cell ints), button, shift, alt, ctrl, touch, clientX, clientY }
import { useEffect, useRef, type DragEvent, type MutableRefObject } from 'react';
import { MapRenderer, type MapScene } from './renderer.ts';

const MOVE_TOL = 5;

/** Pointer position handed to the handlers (see the header comment). */
export interface MapPointerInfo {
  sx: number;
  sy: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  button?: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  touch?: boolean;
  clientX: number;
  clientY: number;
}

export interface MapHandlers {
  onDown?: (info: MapPointerInfo) => boolean | void | undefined;
  onMove?: (info: MapPointerInfo) => void;
  onUp?: (info: MapPointerInfo, moved: boolean) => void;
  onCancel?: () => void;
  onClick?: (info: MapPointerInfo) => void;
  onDblClick?: (info: MapPointerInfo) => void;
  onContext?: (info: MapPointerInfo) => void;
  onLongPress?: (info: MapPointerInfo) => void;
  onHover?: (info: MapPointerInfo | null) => void;
  onDropData?: (info: MapPointerInfo, dataTransfer: DataTransfer) => void;
  panOnly?: () => boolean;
}

interface Gesture {
  kind: 'pinch' | 'pan' | 'right' | 'handler' | 'pan-or-click' | 'done';
  start?: { x: number; y: number };
  last?: { x: number; y: number };
  moved?: boolean;
  info?: MapPointerInfo;
  longTimer?: ReturnType<typeof setTimeout> | null;
  d?: number;
  mx?: number;
  my?: number;
}

interface MapCanvasProps {
  rendererRef?: MutableRefObject<MapRenderer | null>;
  scene: MapScene | null;
  handlers?: MapHandlers | null;
  className?: string;
}

export function MapCanvas({ rendererRef, scene, handlers, className: klass = '' }: MapCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hRef = useRef<MapHandlers>(handlers || {});
  hRef.current = handlers || {};
  const localRef = useRef<MapRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const r = new MapRenderer(canvas);
    localRef.current = r;
    if (rendererRef) rendererRef.current = r;
    // Layout size, not the bounding box: a rotated parent (table display laid flat) swaps the box's width and height.
    const fitWrap = () => r.resize(wrap.clientWidth, wrap.clientHeight);
    const ro = new ResizeObserver(fitWrap);
    ro.observe(wrap);
    fitWrap();

    const H = (): MapHandlers => hRef.current || {};
    const pointers = new Map<number, { x: number; y: number }>();
    let g: Gesture | null = null; // current gesture
    let lastTap: { t: number; cx: number; cy: number } | null = null;
    let spaceDown = false;

    const infoFrom = (e: PointerEvent): MapPointerInfo => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const w = r.toWorld(sx, sy);
      return {
        sx, sy, fx: w.x, fy: w.y, cx: Math.floor(w.x), cy: Math.floor(w.y),
        button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey,
        touch: e.pointerType === 'touch' || e.pointerType === 'pen', clientX: e.clientX, clientY: e.clientY,
      };
    };
    const clearLong = () => {
      if (g?.longTimer) clearTimeout(g.longTimer);
      if (g) g.longTimer = null;
    };
    const pinchState = () => {
      const pts = [...pointers.values()];
      const rect = canvas.getBoundingClientRect();
      const a = pts[0], c = pts[1];
      return { d: Math.hypot(a.x - c.x, a.y - c.y), mx: (a.x + c.x) / 2 - rect.left, my: (a.y + c.y) / 2 - rect.top };
    };
    const tapCheck = (info: MapPointerInfo) => {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 380 && lastTap.cx === info.cx && lastTap.cy === info.cy) {
        lastTap = null;
        H().onDblClick?.(info);
        return true;
      }
      lastTap = { t: now, cx: info.cx, cy: info.cy };
      return false;
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button > 2) return;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        clearLong();
        if (g?.kind === 'handler') H().onCancel?.();
        const p = pinchState();
        g = { kind: 'pinch', ...p };
        return;
      }
      if (pointers.size > 2) return;
      const info = infoFrom(e);
      const start = { x: e.clientX, y: e.clientY };
      if (e.button === 1 || (e.button === 0 && (spaceDown || H().panOnly?.()))) {
        e.preventDefault();
        g = { kind: 'pan', start, last: start, moved: false };
        wrap.classList.add('panning');
        return;
      }
      if (e.button === 2) {
        g = { kind: 'right', start, last: start, moved: false, info };
        return;
      }
      const taken = H().onDown?.(info);
      g = { kind: taken ? 'handler' : 'pan-or-click', start, last: start, moved: false, info };
      if (info.touch) {
        g.longTimer = setTimeout(() => {
          if (g && !g.moved && (g.kind === 'pan-or-click' || g.kind === 'handler')) {
            if (g.kind === 'handler') H().onCancel?.();
            H().onLongPress?.(g.info!);
            g.kind = 'done';
          }
        }, 550);
      }
    };

    const move = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g) {
        if (e.pointerType === 'mouse') H().onHover?.(infoFrom(e));
        return;
      }
      if (g.kind === 'pinch') {
        if (pointers.size < 2) return;
        const p = pinchState();
        if (g.d! > 0) r.zoomAt(p.mx, p.my, p.d / g.d!);
        r.pan(p.mx - g.mx!, p.my - g.my!);
        Object.assign(g, p);
        return;
      }
      const dx = e.clientX - g.last!.x, dy = e.clientY - g.last!.y;
      if (!g.moved && Math.hypot(e.clientX - g.start!.x, e.clientY - g.start!.y) > MOVE_TOL) {
        g.moved = true;
        clearLong();
        if (g.kind !== 'handler') wrap.classList.add('panning');
      }
      if (g.kind === 'handler') {
        if (g.moved) H().onMove?.(infoFrom(e));
      } else if (g.kind === 'pan' || ((g.kind === 'pan-or-click' || g.kind === 'right') && g.moved)) {
        r.pan(dx, dy);
      }
      g.last = { x: e.clientX, y: e.clientY };
    };

    const up = (e: PointerEvent) => {
      const had = pointers.has(e.pointerId);
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      if (!g || !had) return;
      if (g.kind === 'pinch') {
        if (pointers.size === 0) g = null;
        else g = { kind: 'done' };
        return;
      }
      clearLong();
      const info = infoFrom(e);
      const cancelled = e.type === 'pointercancel';
      if (g.kind === 'handler') {
        if (cancelled) H().onCancel?.();
        else {
          H().onUp?.(info, !!g.moved);
          if (!g.moved) tapCheck(info);
        }
      } else if (g.kind === 'pan-or-click' && !g.moved && !cancelled) {
        if (!tapCheck(info)) H().onClick?.(info);
      } else if (g.kind === 'right' && !g.moved && !cancelled) {
        H().onContext?.(info);
      }
      wrap.classList.remove('panning');
      if (pointers.size === 0) g = null;
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      r.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.0018, -delta));
    };
    const ctxMenu = (e: Event) => e.preventDefault();
    const leave = () => {
      if (!g) H().onHover?.(null);
    };
    // Space = pan modifier. Its default action is cancelled so a toolbar button that kept focus after a click
    // (Annuler, Recentrer, Bestiaire…) is not "pressed" again when Space is released. Text fields and modals keep it.
    const panKeyTarget = () => {
      const a = document.activeElement;
      if (/INPUT|TEXTAREA|SELECT/.test(a?.tagName || '') || (a as HTMLElement | null)?.isContentEditable) return false;
      return !(a as HTMLElement | null)?.closest?.('.modal');
    };
    const keyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && panKeyTarget()) {
        e.preventDefault();
        if (!spaceDown) wrap.classList.add('pan-ready');
        spaceDown = true;
      }
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (spaceDown && panKeyTarget()) e.preventDefault();
        spaceDown = false;
        wrap.classList.remove('pan-ready');
      }
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', ctxMenu);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', ctxMenu);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      clearLong();
      r.destroy();
      if (rendererRef && rendererRef.current === r) rendererRef.current = null;
    };
  }, []);

  // Push the latest scene after every render (cheap: the renderer diffs keys).
  useEffect(() => {
    localRef.current?.setScene(scene);
  });

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (hRef.current?.onDropData) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const h = hRef.current;
    if (!h?.onDropData || !localRef.current) return;
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = localRef.current.toWorld(sx, sy);
    h.onDropData({ sx, sy, fx: w.x, fy: w.y, cx: Math.floor(w.x), cy: Math.floor(w.y), clientX: e.clientX, clientY: e.clientY }, e.dataTransfer);
  };

  return (
    <div className={'map-canvas-wrap ' + klass} ref={wrapRef} onDragOver={onDragOver} onDrop={onDrop}>
      <canvas className="map-canvas" ref={canvasRef}></canvas>
    </div>
  );
}
