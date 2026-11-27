#!/usr/bin/env node
// Tracing crops of a map image with a labelled cell grid.
//   node tools/maptrace/tiles.ts <image|maplib json> [--grid <px>] [--offset x,y] [--out dir] [--tile 12] [--overlap 2] [--max 1100]
//   node tools/maptrace/tiles.ts <image|json> --grid <px> --region x,y,w,h [--ppc 120] [--out dir]   (one zoomed crop)
// Writes overview.jpg (whole map ≤ 1400 px, yellow line + label every 5 cells) and tile_<x0>_<y0>.jpg crops of
// tile×tile cells (overlapping), each ≤ --max px wide: thin white line every cell, yellow every 5 cells, the cell
// number of every line in the margins (yellow = multiple of 5), « x,y » tags at 5×5 crossings.
// When given a maplib JSON, the image / grid / offset come from it (and walls are NOT drawn: use overlay.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJpeg, writeJpeg, findImage, args, isMain, loadMaplib, slugOf } from './lib.ts';
import { gridView, geometry } from './render.ts';
import { conventionPitch } from './scale.ts';

export function resolveSource(arg, a = {}) {
  let raw = null, imageFile;
  if (/\.json$/i.test(arg)) {
    raw = loadMaplib(arg).raw;
    imageFile = findImage(raw.image);
    if (!imageFile) throw new Error(`image « ${raw.image} » not found (see SR_FRAGMAP_DIRS)`);
  } else {
    imageFile = findImage(arg);
    if (!imageFile) throw new Error(`image « ${arg} » not found`);
  }
  const img = readJpeg(imageFile);
  const [ox, oy] = String(a.offset || '').split(',').map(Number);
  const gridPx = Number(a.grid) || raw?.gridPx || conventionPitch(img.width, img.height);
  if (!gridPx) throw new Error('no --grid given and no standard pitch fits: run scale.js first');
  const geo = geometry({ ...(raw || {}), gridPx, offsetX: Number.isFinite(ox) ? ox : raw?.offsetX || 0, offsetY: Number.isFinite(oy) ? oy : raw?.offsetY || 0, imageW: img.width, imageH: img.height, ...(a.grid ? { width: 0, height: 0 } : {}) }, img);
  return { raw, imageFile, img, geo, slug: raw?.slug || slugOf(path.basename(imageFile)) };
}

export function overview(src, geo, { max = 1400, title = '' } = {}) {
  const ppc = Math.min(max / geo.width, max / geo.height, geo.gridPx);
  return gridView(src, geo, { x: 0, y: 0, w: geo.width, h: geo.height }, ppc, { grid: ppc >= 18, title });
}

/** Tile rectangles (cells) covering the map with `overlap` cells shared between neighbours. */
export function tileRects(geo, tile = 12, overlap = 2) {
  const step = Math.max(1, tile - overlap);
  const starts = (n) => {
    if (n <= tile) return [0];
    const s = [];
    for (let v = 0; v + tile < n; v += step) s.push(v);
    s.push(n - tile);
    return [...new Set(s)];
  };
  const out = [];
  for (const y of starts(geo.height)) for (const x of starts(geo.width)) out.push({ x, y, w: Math.min(tile, geo.width), h: Math.min(tile, geo.height) });
  return out;
}

export function makeTiles({ img, geo, slug }, { out, tile = 12, overlap = 2, max = 1100, quality = 85 } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  const ov = overview(img, geo, { title: `${slug}  ${geo.width}x${geo.height} cells  grid ${geo.gridPx}px` });
  const ovFile = path.join(out, 'overview.jpg');
  writeJpeg(ov.img, ovFile, quality);
  files.push({ file: ovFile, kind: 'overview', ppc: Math.round(ov.ppc * 10) / 10 });
  const rects = tileRects(geo, tile, overlap);
  const ppc = Math.min((max - 68) / Math.max(rects[0].w, rects[0].h), geo.gridPx * 1.5);
  for (const r of rects) {
    const v = gridView(img, geo, r, ppc, { title: `${slug}  x ${r.x}-${r.x + r.w}  y ${r.y}-${r.y + r.h}` });
    const f = path.join(out, `tile_${String(r.x).padStart(2, '0')}_${String(r.y).padStart(2, '0')}.jpg`);
    writeJpeg(v.img, f, quality);
    files.push({ file: f, kind: 'tile', region: r, ppc: Math.round(ppc * 10) / 10 });
  }
  return files;
}

if (isMain(import.meta.url)) {
  const a = args();
  if (!a._[0]) {
    console.error('usage: node tools/maptrace/tiles.ts <image|maplib json> [--grid px] [--offset x,y] [--out dir] [--tile 12] [--overlap 2] [--max 1100] [--region x,y,w,h --ppc 120]');
    process.exit(2);
  }
  try {
    const s = resolveSource(a._[0], a);
    const out = path.resolve(a.out || path.join(os.tmpdir(), 'maptrace', s.slug));
    if (a.region) {
      const [x, y, w, h] = String(a.region).split(',').map(Number);
      const ppc = Number(a.ppc) || Math.min(1100 / Math.max(w, h), s.geo.gridPx * 2);
      const v = gridView(s.img, s.geo, { x, y, w, h }, ppc, { title: `${s.slug}  zoom x ${+x.toFixed(2)}-${+(x + w).toFixed(2)}  y ${+y.toFixed(2)}-${+(y + h).toFixed(2)}` });
      const f = path.join(out, `zoom_${x}_${y}_${w}x${h}.jpg`);
      fs.mkdirSync(out, { recursive: true });
      writeJpeg(v.img, f, 88);
      console.log(`${f}  (${v.img.width}×${v.img.height}px, ${Math.round(ppc)} px/cell)`);
    } else {
      const files = makeTiles(s, { out, tile: Number(a.tile) || 12, overlap: a.overlap !== undefined ? Number(a.overlap) : 2, max: Number(a.max) || 1100 });
      console.log(`${s.slug}: ${s.geo.width}×${s.geo.height} cells, grid ${s.geo.gridPx}px, offset ${s.geo.offsetX},${s.geo.offsetY}`);
      for (const f of files) console.log(`  ${f.file}${f.region ? `  cells x ${f.region.x}-${f.region.x + f.region.w} y ${f.region.y}-${f.region.y + f.region.h}` : ''}  (${f.ppc} px/cell)`);
    }
  } catch (err) {
    console.error('tiles: ' + err.message);
    process.exit(1);
  }
}
