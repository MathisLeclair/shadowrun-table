#!/usr/bin/env node
// Measure exact wall positions along a scan line (cell units), instead of eyeballing a downscaled crop.
//   node tools/maptrace/probe.js <maplib json|image> --row <y> [--from x0 --to x1] [--grid px] [--step 0.02] [--band 0.06]
//   node tools/maptrace/probe.js <maplib json|image> --col <x> [--from y0 --to y1] …
// Prints, along the line: background runs (the empty area around the building: colour of the image corners),
// content runs, and DARK BANDS (runs much darker than the line's median — wall bands, door frames) with their centre:
// use the centre as the wall coordinate. A luminance strip (" .:-=+*#%@", one char per step) helps reading.
import { args, isMain } from './lib.js';
import { resolveSource } from './tiles.js';

const SHADES = ' .:-=+*#%@';

export function probe({ img, geo }, { axis, at, from, to, step = 0.02, band = 0.06 }) {
  const { gridPx, offsetX, offsetY } = geo;
  const px = (c, o) => o + c * gridPx;
  const sampleRGB = (cx, cy) => {
    // mean colour over a small square (band × step) around the cell point
    const hx = Math.max(1, ((axis === 'row' ? step : band) * gridPx) / 2), hy = Math.max(1, ((axis === 'row' ? band : step) * gridPx) / 2);
    const x0 = Math.max(0, Math.floor(px(cx, offsetX) - hx)), x1 = Math.min(img.width - 1, Math.ceil(px(cx, offsetX) + hx));
    const y0 = Math.max(0, Math.floor(px(cy, offsetY) - hy)), y1 = Math.min(img.height - 1, Math.ceil(px(cy, offsetY) + hy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = (y * img.width + x) * 4;
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        n++;
      }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
  };
  // background = median colour of the four corners
  const corners = [[2, 2], [img.width - 3, 2], [2, img.height - 3], [img.width - 3, img.height - 3]].map(([x, y]) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  });
  const bg = [0, 1, 2].map((k) => corners.map((c) => c[k]).sort((a, b) => a - b)[1]);
  const samples = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const c = axis === 'row' ? sampleRGB(t, at) : sampleRGB(at, t);
    const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const dist = Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
    samples.push({ t: Math.round(t * 1000) / 1000, lum, isBg: dist < 14 });
  }
  const content = samples.filter((s) => !s.isBg).map((s) => s.lum).sort((a, b) => a - b);
  const med = content.length ? content[content.length >> 1] : 0;
  const dark = Math.max(12, med * 0.5);
  const runs = [];
  let cur = null;
  for (const s of samples) {
    const kind = s.isBg ? 'background' : s.lum < dark ? 'dark' : 'content';
    if (!cur || cur.kind !== kind) {
      if (cur) runs.push(cur);
      cur = { kind, a: s.t, b: s.t };
    } else cur.b = s.t;
  }
  if (cur) runs.push(cur);
  // background-coloured runs inside the building are dark bands (walls, shadows), not the outside
  runs.forEach((r, i) => {
    if (r.kind === 'background' && i !== 0 && i !== runs.length - 1) r.kind = 'dark';
  });
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.kind === r.kind) last.b = r.b;
    else merged.push({ ...r });
  }
  runs.length = 0;
  runs.push(...merged);
  const maxL = Math.max(1, ...samples.map((s) => s.lum));
  const strip = samples.map((s) => (s.isBg ? '·' : SHADES[Math.min(9, Math.floor((s.lum / maxL) * 9.99))])).join('');
  return { runs, strip, median: Math.round(med), bg: bg.map(Math.round) };
}

if (isMain(import.meta.url)) {
  const a = args();
  if (!a._[0] || (a.row === undefined && a.col === undefined)) {
    console.error('usage: node tools/maptrace/probe.js <maplib json|image> (--row y | --col x) [--from a --to b] [--grid px] [--step 0.02] [--band 0.06]');
    process.exit(2);
  }
  try {
    const s = resolveSource(a._[0], a);
    const axis = a.row !== undefined ? 'row' : 'col';
    const at = Number(axis === 'row' ? a.row : a.col);
    const from = a.from !== undefined ? Number(a.from) : 0;
    const to = a.to !== undefined ? Number(a.to) : axis === 'row' ? s.geo.width : s.geo.height;
    const step = Number(a.step) || 0.02;
    const r = probe(s, { axis, at, from, to, step, band: Number(a.band) || 0.06 });
    const along = axis === 'row' ? 'x' : 'y';
    console.log(`${s.slug}  ${axis === 'row' ? `row y=${at}` : `column x=${at}`}  ${along} ${from}→${to} step ${step}  (median content lum ${r.median}, background rgb ${r.bg.join(',')})`);
    for (const run of r.runs) {
      if (run.kind === 'content' && run.b - run.a < step * 1.5) continue;
      const w = run.b - run.a + step;
      const c = Math.round(((run.a + run.b) / 2) * 1000) / 1000;
      if (run.kind === 'dark') console.log(`  DARK  ${along} ${run.a.toFixed(2)}–${(run.b + step).toFixed(2)}  width ${w.toFixed(2)}  centre ${c.toFixed(2)}`);
      else console.log(`  ${run.kind === 'background' ? 'bg   ' : 'floor'} ${along} ${run.a.toFixed(2)}–${(run.b + step).toFixed(2)}`);
    }
    const per = Math.max(1, Math.round(0.1 / step));
    let line = '';
    for (let i = 0; i < r.strip.length; i += per) line += r.strip[i];
    console.log(`  strip (1 char = 0.1 cell from ${from}): ${line}`);
  } catch (err) {
    console.error('probe: ' + err.message);
    process.exit(1);
  }
}
