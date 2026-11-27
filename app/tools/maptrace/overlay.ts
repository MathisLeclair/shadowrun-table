#!/usr/bin/env node
// Visual QA of a traced library map: walls (cyan), doors (green closed / amber open / red locked / violet secret),
// windows (blue dashed), lights (yellow), regions (labels), entry (pink X) and check.js issues (red circles) drawn
// over the image.
//   node tools/maptrace/overlay.ts <maplib json|slug> [--out file.jpg] [--region x,y,w,h] [--ppc 120] [--ids] [--no-issues] [--max 1400]
// Without --region: the whole map ≤ --max px. With --region: a zoomed crop (cells) — use it to check alignment.
import os from 'node:os';
import path from 'node:path';
import { readJpeg, writeJpeg, findImage, args, isMain, loadMaplib } from './lib.ts';
import { gridView, drawMaplib, legend, geometry } from './render.ts';
import { checkMap } from './check.ts';

export function renderOverlay(raw, img, { region = null, ppc = 0, ids = false, issues = true, max = 1400 } = {}) {
  const geo = geometry(raw, img);
  const reg = region || { x: 0, y: 0, w: geo.width, h: geo.height };
  const p = ppc || Math.min((max - 68) / reg.w, (max - 90) / reg.h, geo.gridPx * 2);
  const view = gridView(img, geo, reg, p, { darken: 0.8, title: `${raw.slug || ''}  ${region ? `x ${+reg.x.toFixed(2)}-${+(reg.x + reg.w).toFixed(2)} y ${+reg.y.toFixed(2)}-${+(reg.y + reg.h).toFixed(2)}` : `${geo.width}x${geo.height}`}  walls ${(raw.walls || []).length}` });
  const list = issues ? checkMap(raw, { image: false }).issues.filter((i) => Number.isFinite(i.x)).map((i) => ({ x: i.x, y: i.y, tag: i.tag })) : [];
  drawMaplib(view, raw, { ids, issues: list });
  return legend(view);
}

if (isMain(import.meta.url)) {
  const a = args();
  if (!a._[0]) {
    console.error('usage: node tools/maptrace/overlay.ts <maplib json|slug> [--out file.jpg] [--region x,y,w,h] [--ppc n] [--ids] [--no-issues]');
    process.exit(2);
  }
  try {
    const { raw } = loadMaplib(a._[0]);
    const file = findImage(raw.image);
    if (!file) throw new Error(`image « ${raw.image} » not found`);
    const img = readJpeg(file);
    let region = null;
    if (a.region) {
      const [x, y, w, h] = String(a.region).split(',').map(Number);
      region = { x, y, w, h };
    }
    const v = renderOverlay(raw, img, { region, ppc: Number(a.ppc) || 0, ids: !!a.ids, issues: !a['no-issues'], max: Number(a.max) || 1400 });
    const out = path.resolve(a.out || path.join(os.tmpdir(), 'maptrace', raw.slug || 'map', region ? `overlay_${region.x}_${region.y}_${region.w}x${region.h}.jpg` : 'overlay.jpg'));
    writeJpeg(v.img, out, 88);
    console.log(`${out}  (${v.img.width}×${v.img.height}px, ${Math.round(v.ppc)} px/cell)`);
  } catch (err) {
    console.error('overlay: ' + err.message);
    process.exit(1);
  }
}
