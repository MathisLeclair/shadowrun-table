// Grid views of a map image (cell coordinates drawn in margins) + drawing of traced maplib content on top.
// Used by tiles.ts (tracing crops), overlay.ts (QA) and the tests.
import { crop, resize, newImage, paste, line, circle, rect, text, textWidth, hex, blend, dim } from './lib.ts';
import type { Img, MaplibFile, Rgb } from './lib.ts';
import type { LibGeometryInput, LibWall } from '../../shared/maplib.ts';

/** Grid geometry of a map image: grid pitch and origin (px), size in cells. */
export interface Geo {
  gridPx: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}
/** A rectangle in cell units. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** gridView() result: the rendered image and the cell → output pixel mapping. */
export interface GridView {
  img: Img;
  toPx(x: number, y: number): [number, number];
  ppc: number;
  region: CellRect;
  margin: number;
  top: number;
}
export interface GridViewOptions {
  grid?: boolean;
  labels?: boolean;
  title?: string;
  darken?: number;
  innerTags?: boolean;
}
/** Issue marker drawn by drawMaplib (cell coordinates). */
export interface IssueMark {
  x: number;
  y: number;
  tag?: string;
}

export const COLORS: Record<'wall' | 'window' | 'ethereal' | 'open' | 'closed' | 'locked' | 'secret' | 'light' | 'region' | 'entry' | 'issue' | 'grid' | 'grid5', Rgb> = {
  wall: [0, 235, 255],
  window: [70, 140, 255],
  ethereal: [255, 140, 0], // move:false sight:false? / odd combos
  open: [255, 190, 0],
  closed: [40, 230, 80],
  locked: [255, 50, 50],
  secret: [220, 80, 255],
  light: [255, 235, 60],
  region: [255, 255, 255],
  entry: [255, 60, 160],
  issue: [255, 0, 0],
  grid: [255, 255, 255],
  grid5: [255, 220, 0],
};

/** Geometry of a map: { gridPx, offsetX, offsetY, width, height } (cells) from a maplib JSON or explicit values. */
export function geometry(raw: LibGeometryInput, img?: Pick<Img, 'width' | 'height'> | null): Geo {
  const gridPx = Number(raw.gridPx) || 100;
  const offsetX = Number(raw.offsetX) || 0, offsetY = Number(raw.offsetY) || 0;
  const W = Number(raw.imageW || img?.width), H = Number(raw.imageH || img?.height);
  return {
    gridPx,
    offsetX,
    offsetY,
    width: Number(raw.width) || Math.ceil((W - offsetX) / gridPx),
    height: Number(raw.height) || Math.ceil((H - offsetY) / gridPx),
  };
}

const labelStep = (ppc: number, minPx: number): number => [1, 2, 5, 10, 20, 50].find((s) => s * ppc >= minPx) || 100;

/**
 * Render the cell rectangle `region` {x, y, w, h} of the image at `ppc` output px per cell, with a margin holding
 * coordinate labels. Returns { img, toPx(x, y) → [px, py], ppc, region }.
 * opts: grid (draw every-cell lines), every5 (stronger lines), labels, title, darken (0..1 multiplier), innerTags.
 */
export function gridView(src: Img, geo: Geo, region: CellRect, ppc: number, opts: GridViewOptions = {}): GridView {
  const { grid = true, labels = true, title = '', darken = 1, innerTags = true } = opts;
  const M = labels ? 34 : 0, T = title ? 22 : 0;
  const ow = Math.round(region.w * ppc), oh = Math.round(region.h * ppc);
  const sx = geo.offsetX + region.x * geo.gridPx, sy = geo.offsetY + region.y * geo.gridPx;
  const part = resize(crop(src, sx, sy, region.w * geo.gridPx, region.h * geo.gridPx), ow, oh);
  if (darken !== 1) dim(part, darken);
  const out = newImage(ow + 2 * M, oh + 2 * M + T, [18, 18, 22]);
  paste(out, part, M, M + T);
  const toPx = (x: number, y: number): [number, number] => [M + (x - region.x) * ppc, M + T + (y - region.y) * ppc];
  if (title) text(out, title, 6, 4, { scale: 2, color: [255, 255, 255], bg: null });
  const x0 = Math.ceil(region.x), x1 = Math.floor(region.x + region.w);
  const y0 = Math.ceil(region.y), y1 = Math.floor(region.y + region.h);
  const cellLines = grid && ppc >= 10;
  // grid lines (1 px, blended; every 5th: 2 px yellow)
  for (let x = x0; x <= x1; x++) {
    const five = x % 5 === 0;
    if (!five && !cellLines) continue;
    const [px] = toPx(x, 0);
    const c = five ? COLORS.grid5 : COLORS.grid, a = five ? 0.6 : 0.28;
    for (let yy = M + T; yy < M + T + oh; yy++) {
      blend(out, Math.round(px), yy, c, a);
      if (five) blend(out, Math.round(px) - 1, yy, c, a * 0.6);
    }
  }
  for (let y = y0; y <= y1; y++) {
    const five = y % 5 === 0;
    if (!five && !cellLines) continue;
    const [, py] = toPx(0, y);
    const c = five ? COLORS.grid5 : COLORS.grid, a = five ? 0.6 : 0.28;
    for (let xx = M; xx < M + ow; xx++) {
      blend(out, xx, Math.round(py), c, a);
      if (five) blend(out, xx, Math.round(py) - 1, c, a * 0.6);
    }
  }
  if (labels) {
    const step = labelStep(ppc, 30);
    for (let x = x0; x <= x1; x++) {
      if (x % step) continue;
      const [px] = toPx(x, 0);
      const five = x % 5 === 0;
      const col = five ? COLORS.grid5 : [200, 200, 200];
      for (const yy of [M + T - 6, M + T + oh + 1]) for (let k = 0; k < 5; k++) blend(out, Math.round(px), yy + k, col, 1);
      text(out, String(x), px, M + T - 8, { scale: 2, color: col, bg: null, align: 'center', valign: 'bottom' });
      text(out, String(x), px, M + T + oh + 8, { scale: 2, color: col, bg: null, align: 'center' });
    }
    for (let y = y0; y <= y1; y++) {
      if (y % step) continue;
      const [, py] = toPx(0, y);
      const five = y % 5 === 0;
      const col = five ? COLORS.grid5 : [200, 200, 200];
      for (const xx of [M - 6, M + ow + 1]) for (let k = 0; k < 5; k++) blend(out, xx + k, Math.round(py), col, 1);
      text(out, String(y), M - 8, py, { scale: 2, color: col, bg: null, align: 'right', valign: 'middle' });
      text(out, String(y), M + ow + 8, py, { scale: 2, color: col, bg: null, valign: 'middle' });
    }
    // half-cell ticks in the margins when zoomed in
    if (ppc >= 40) {
      for (let x = Math.ceil(region.x * 2) / 2; x <= region.x + region.w; x += 0.5) {
        if (Number.isInteger(x)) continue;
        const [px] = toPx(x, 0);
        for (let k = 0; k < 3; k++) blend(out, Math.round(px), M + T - 4 + k, [160, 160, 160], 1), blend(out, Math.round(px), M + T + oh + 1 + k, [160, 160, 160], 1);
      }
      for (let y = Math.ceil(region.y * 2) / 2; y <= region.y + region.h; y += 0.5) {
        if (Number.isInteger(y)) continue;
        const [, py] = toPx(0, y);
        for (let k = 0; k < 3; k++) blend(out, M - 4 + k, Math.round(py), [160, 160, 160], 1), blend(out, M + ow + 1 + k, Math.round(py), [160, 160, 160], 1);
      }
    }
  }
  // « x,y » tags at the 5×5 intersections inside the picture (orientation when a crop is viewed alone)
  if (innerTags && ppc >= 14) {
    for (let x = Math.ceil(x0 / 5) * 5; x <= x1; x += 5)
      for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) {
        const [px, py] = toPx(x, y);
        if (px < M + 2 || py < M + T + 2 || px > M + ow - 30 || py > M + T + oh - 14) continue;
        text(out, `${x},${y}`, px + 3, py + 3, { scale: ppc >= 40 ? 2 : 1, color: COLORS.grid5, bg: [0, 0, 0], bgAlpha: 0.55 });
      }
  }
  return { img: out, toPx, ppc, region, margin: M, top: T };
}

export function wallStyle(w: LibWall): { color: Rgb; dash?: [number, number]; door?: boolean } {
  if (w.door) {
    if (w.door.kind === 'secret') return { color: COLORS.secret, dash: [6, 4], door: true };
    return { color: w.door.state === 'open' ? COLORS.open : w.door.state === 'locked' ? COLORS.locked : COLORS.closed, door: true };
  }
  if (w.move !== false && w.sight === false) return { color: COLORS.window, dash: [7, 5] };
  if (w.move === false && w.sight !== false) return { color: COLORS.ethereal, dash: [3, 3] };
  if (w.move === false && w.sight === false) return { color: [150, 150, 150], dash: [2, 6] };
  return { color: COLORS.wall };
}

/**
 * Draw walls / doors / windows / lights / regions / entry / issues of a maplib JSON on a gridView.
 * opts: ids (label wall ids), issues ([{x, y, msg}]), endpoints (dots at wall ends).
 */
export function drawMaplib(view: GridView, raw: Partial<MaplibFile>, opts: { ids?: boolean; issues?: IssueMark[]; endpoints?: boolean } = {}): GridView {
  const { img, toPx, ppc } = view;
  const { ids = false, issues = [], endpoints = true } = opts;
  const lw = Math.max(2, Math.min(5, ppc * 0.06));
  for (const r of raw.regions || []) {
    const [a, b] = toPx(r.x, r.y);
    rect(img, a + 2, b + 2, r.w * ppc - 4, r.h * ppc - 4, COLORS.region, { alpha: 0.35, width: 1 });
    const [cx, cy] = toPx(r.x + r.w / 2, r.y + r.h / 2);
    text(img, r.name || '?', cx, cy, { scale: ppc >= 30 ? 2 : 1, color: [255, 255, 255], bg: [40, 0, 60], bgAlpha: 0.7, align: 'center', valign: 'middle' });
  }
  for (const l of raw.lights || []) {
    const [cx, cy] = toPx(l.x, l.y);
    const c = hex(l.color, COLORS.light);
    circle(img, cx, cy, (Number(l.radius) || 0) * ppc, COLORS.light, { width: 1, alpha: l.on === false ? 0.2 : 0.45 });
    const dot = Math.max(3, Math.min(7, ppc * 0.05));
    circle(img, cx, cy, dot, c, { width: 2, alpha: 1, fill: 1 });
    circle(img, cx, cy, dot + 1, COLORS.light, { width: 2, alpha: 1 });
  }
  for (const w of raw.walls || []) {
    const s = wallStyle(w);
    const [a, b] = toPx(w.x1, w.y1), [c, d] = toPx(w.x2, w.y2);
    // dark under-stroke so the colour reads on any floor
    line(img, a, b, c, d, [0, 0, 0], { width: lw + 2, alpha: 0.6, dash: s.dash });
    line(img, a, b, c, d, s.color, { width: s.door ? lw + 1 : lw, alpha: 1, dash: s.dash });
    if (s.door) {
      // door tick marks at both ends
      const L = Math.hypot(c - a, d - b) || 1, nx = -(d - b) / L, ny = (c - a) / L, k = Math.max(4, ppc * 0.12);
      for (const [px, py] of [[a, b], [c, d]]) line(img, px - nx * k, py - ny * k, px + nx * k, py + ny * k, s.color, { width: 2 });
    }
    if (ids && w.id) {
      const [mx, my] = toPx((w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2);
      text(img, w.id, mx, my, { scale: 1, color: s.color, bg: [0, 0, 0], bgAlpha: 0.7, align: 'center', valign: 'middle' });
    }
  }
  if (endpoints)
    for (const w of raw.walls || [])
      for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
        const [px, py] = toPx(x, y);
        circle(img, px, py, Math.max(1.5, lw * 0.55), [255, 255, 255], { width: 1, fill: 1 });
      }
  if (raw.entry) {
    const [ex, ey] = toPx(raw.entry.x, raw.entry.y);
    const k = Math.max(6, ppc * 0.25);
    line(img, ex - k, ey - k, ex + k, ey + k, COLORS.entry, { width: 3 });
    line(img, ex - k, ey + k, ex + k, ey - k, COLORS.entry, { width: 3 });
    text(img, 'ENTRY', ex, ey + k + 3, { scale: 1, color: COLORS.entry, bg: [0, 0, 0], align: 'center' });
  }
  for (const is of issues) {
    const [px, py] = toPx(is.x, is.y);
    circle(img, px, py, Math.max(8, ppc * 0.3), COLORS.issue, { width: 3 });
    if (is.tag) text(img, is.tag, px + Math.max(8, ppc * 0.3) + 2, py, { scale: 1, color: COLORS.issue, bg: [0, 0, 0], valign: 'middle' });
  }
  return view;
}

/** Legend strip appended under an overlay. */
export function legend(view: GridView): GridView {
  const items: Array<[string, Rgb]> = [
    ['MUR', COLORS.wall], ['FENETRE', COLORS.window], ['PORTE FERMEE', COLORS.closed], ['OUVERTE', COLORS.open],
    ['VERROUILLEE', COLORS.locked], ['SECRETE', COLORS.secret], ['LUMIERE', COLORS.light], ['PROBLEME', COLORS.issue],
  ];
  const H = 22;
  const out = newImage(view.img.width, view.img.height + H, [18, 18, 22]);
  paste(out, view.img, 0, 0);
  let x = 8;
  for (const [name, c] of items) {
    rect(out, x, view.img.height + 6, 14, 10, c, { fill: true });
    text(out, name, x + 18, view.img.height + 6, { scale: 1, color: [230, 230, 230], bg: null });
    x += 18 + textWidth(name, 1) + 14;
  }
  return { ...view, img: out };
}
