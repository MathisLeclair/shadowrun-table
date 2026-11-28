// Traces the district shapes of a city map image (solid colour fills, e.g. the Seattle map DqT4928.jpeg) into polygons
// in cell units, for the « Seattle » tab (shared/city.ts, data/city/<id>.json). Run once per image, check the QA picture.
//
//   node tools/city-districts.ts [--image <jpeg>] [--out data/city/seattle.json] [--qa <out.jpg>] [--step 4]
//
// 1. Downsample (mean of step × step px), classify each sample by nearest palette colour (districts + backgrounds).
// 2. Unknown samples (white sub-district lines, labels, road marks) take the majority district around them (a few passes).
// 3. Morphological opening removes roads and slivers; components smaller than --min samples are dropped; districts with
//    near-identical colours (Council Island / Ft. Lewis) keep the components closest to their own seed.
// 4. A closing fills notches and border lines; holes holding no other district (lakes, road numbers) are filled.
// 5. Pixel-edge contours → rings, Douglas–Peucker simplified, converted to cells (÷ gridPx). Even-odd rings.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, args as parseArgs, isMain, line, readJpeg, resize, text, writeJpeg, type Img } from './maptrace/lib.ts';
import type { CityDistrict, CityShapes } from '../shared/types.ts';

interface Seed {
  id: string;
  name: string;
  rgb: [number, number, number];
  /** Full-resolution pixel inside the district. */
  at: [number, number];
  /** Same colour as another district: components go to the nearest seed of the group. */
  group?: string;
  security?: CityDistrict['security'];
}

/** Seattle (DqT4928.jpeg, 3300 × 3100 px, 25 px per cell). Colours = 13 × 13 px medians at the seed point. */
const SEATTLE_SEEDS: Seed[] = [
  { id: 'everett', name: 'Everett', rgb: [118, 176, 202], at: [960, 450] },
  { id: 'snohomish', name: 'Snohomish', rgb: [69, 125, 102], at: [990, 810] },
  { id: 'redmond', name: 'Redmond', rgb: [222, 111, 78], at: [1410, 1050], security: [{ area: 'Redmond Barrens', rating: 'Z', source: 'SR5', page: 352 }] },
  { id: 'downtown', name: 'Downtown', rgb: [162, 130, 191], at: [900, 900], security: [{ area: 'Downtown Seattle', rating: 'AAA', source: 'SR5', page: 352 }] },
  { id: 'council-island', name: 'Council Island', rgb: [100, 75, 105], at: [1035, 1260], group: 'purple-grey' },
  { id: 'bellevue', name: 'Bellevue', rgb: [237, 164, 84], at: [1170, 1260] },
  { id: 'renton', name: 'Renton', rgb: [57, 79, 117], at: [1440, 1410] },
  { id: 'outremer', name: 'Outremer', rgb: [233, 106, 161], at: [660, 1530] },
  { id: 'tacoma', name: 'Tacoma', rgb: [112, 82, 78], at: [690, 1980] },
  { id: 'auburn', name: 'Auburn', rgb: [179, 73, 74], at: [1410, 1800] },
  { id: 'puyallup', name: 'Puyallup', rgb: [193, 184, 163], at: [1200, 2400] },
  { id: 'fort-lewis', name: 'Ft. Lewis', rgb: [98, 87, 107], at: [450, 2430], group: 'purple-grey' },
];
/** Background colours (land, water, metroplex outline area, parks). */
const SEATTLE_BG: Array<[number, number, number]> = [[62, 65, 70], [98, 105, 112], [83, 90, 97], [40, 43, 48]];

const hex = (c: readonly number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Mean-downsampled RGB grid. */
function sample(img: Img, step: number) {
  const w = Math.floor(img.width / step), h = Math.floor(img.height / step);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
      const i = ((y * step + dy) * img.width + x * step + dx) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
    }
    const n = step * step, o = (y * w + x) * 3;
    rgb[o] = r / n;
    rgb[o + 1] = g / n;
    rgb[o + 2] = b / n;
  }
  return { w, h, rgb };
}

const UNKNOWN = -1, BG = -2;

/** Label grid: district index, BG or UNKNOWN. */
function classify(s: ReturnType<typeof sample>, seeds: Seed[], bg: Array<[number, number, number]>, maxDist: number): Int16Array {
  const lab = new Int16Array(s.w * s.h);
  const pal = [...seeds.map((sd, i) => ({ c: sd.rgb, l: i })), ...bg.map((c) => ({ c, l: BG }))];
  for (let i = 0; i < s.w * s.h; i++) {
    const r = s.rgb[i * 3], g = s.rgb[i * 3 + 1], b = s.rgb[i * 3 + 2];
    let best = UNKNOWN, bd = Infinity;
    for (const p of pal) {
      const d = (r - p.c[0]) ** 2 + (g - p.c[1]) ** 2 + (b - p.c[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = p.l;
      }
    }
    lab[i] = bd <= maxDist * maxDist ? best : UNKNOWN;
  }
  return lab;
}

/** Unknown samples take the most common district among their 8 neighbours (needs ≥ 3 of them). */
function grow(lab: Int16Array, w: number, h: number, passes: number): void {
  for (let p = 0; p < passes; p++) {
    const next = lab.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (lab[i] !== UNKNOWN) continue;
      const count = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const l = lab[i + dy * w + dx];
        if (l >= 0) count.set(l, (count.get(l) || 0) + 1);
      }
      let best = UNKNOWN, bn = 2;
      for (const [l, n] of count) if (n > bn) {
        bn = n;
        best = l;
      }
      next[i] = best;
    }
    lab.set(next);
  }
}

/** Binary erosion / dilation with a 3 × 3 square, `n` times. */
function morph(mask: Uint8Array, w: number, h: number, n: number, erode: boolean): Uint8Array {
  let cur = mask;
  for (let k = 0; k < n; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let dy = -1; dy <= 1 && v === (erode ? 1 : 0); dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        const m = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : cur[yy * w + xx];
        if (erode && !m) {
          v = 0;
          break;
        }
        if (!erode && m) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
    cur = out;
  }
  return cur;
}

/** 4-connected components of a mask: component id per sample (0 = none) and their sizes / centroids. */
function components(mask: Uint8Array, w: number, h: number) {
  const id = new Int32Array(w * h);
  const comps: Array<{ size: number; cx: number; cy: number }> = [{ size: 0, cx: 0, cy: 0 }];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || id[s]) continue;
    const c = comps.length;
    let size = 0, sx = 0, sy = 0;
    id[s] = c;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      size++;
      sx += x;
      sy += y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && mask[j] && !id[j]) {
          id[j] = c;
          stack.push(j);
        }
      }
    }
    comps.push({ size, cx: sx / size, cy: sy / size });
  }
  return { id, comps };
}

type Pt = [number, number];

/** Outline rings of a mask along sample edges (interior on the right). */
function traceRings(mask: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const out = new Map<number, number[]>(); // start vertex key → end vertex keys
  const key = (x: number, y: number) => y * (w + 1) + x;
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const k = key(x1, y1);
    const l = out.get(k);
    if (l) l.push(key(x2, y2));
    else out.set(k, [key(x2, y2)]);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  const rings: Pt[][] = [];
  const unkey = (k: number): Pt => [k % (w + 1), Math.floor(k / (w + 1))];
  for (const [start, ends] of out) {
    while (ends.length) {
      const ring: Pt[] = [unkey(start)];
      let cur = ends.pop()!;
      let guard = 0;
      while (cur !== start && guard++ < 1e7) {
        ring.push(unkey(cur));
        const nx = out.get(cur);
        if (!nx?.length) break;
        cur = nx.pop()!;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/** Douglas–Peucker on a closed ring. */
function simplify(ring: Pt[], tol: number): Pt[] {
  if (ring.length < 5) return ring;
  // split at the farthest point from the first one, simplify both halves as open polylines
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const dp = (pts: Pt[]): Pt[] => {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    let idx = 0, md = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs(dy * (pts[i][0] - a[0]) - dx * (pts[i][1] - a[1])) / len;
      if (d > md) {
        md = d;
        idx = i;
      }
    }
    if (md <= tol) return [a, b];
    const l = dp(pts.slice(0, idx + 1)), r = dp(pts.slice(idx));
    return [...l.slice(0, -1), ...r];
  };
  const first = dp(ring.slice(0, far + 1));
  const second = dp([...ring.slice(far), ring[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

const ringArea = (r: Pt[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
};

export interface TraceOptions {
  step?: number;
  gridPx?: number;
  maxDist?: number;
  growPasses?: number;
  /** Closing radius (samples) that fills notches and border lines. */
  close?: number;
  open?: number;
  minSamples?: number;
  tol?: number;
}

/** Trace the districts of a city image. Returns districts with rings in cell units. */
export function traceDistricts(img: Img, seeds: Seed[], bg: Array<[number, number, number]>, o: TraceOptions = {}): CityDistrict[] {
  const step = o.step ?? 4, gridPx = o.gridPx ?? 25;
  const s = sample(img, step);
  const { w, h } = s;
  const lab = classify(s, seeds, bg, o.maxDist ?? 30);
  grow(lab, w, h, o.growPasses ?? 4);
  const k = step / gridPx;
  const masks = seeds.map((_, i) => {
    let m: Uint8Array = new Uint8Array(w * h);
    for (let j = 0; j < w * h; j++) m[j] = lab[j] === i ? 1 : 0;
    m = morph(morph(m, w, h, o.open ?? 2, true), w, h, o.open ?? 2, false);
    return m;
  });
  // groups of same-colour districts: merge their masks, give each component to the nearest seed of the group
  const groups = new Map<string, number[]>();
  seeds.forEach((sd, i) => sd.group && groups.set(sd.group, [...(groups.get(sd.group) || []), i]));
  for (const members of groups.values()) {
    const all = new Uint8Array(w * h);
    for (const i of members) for (let j = 0; j < w * h; j++) all[j] |= masks[i][j];
    const { id, comps } = components(all, w, h);
    const owner = comps.map((c) => {
      let best = members[0], bd = Infinity;
      for (const i of members) {
        const d = (c.cx - seeds[i].at[0] / step) ** 2 + (c.cy - seeds[i].at[1] / step) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    });
    for (const i of members) masks[i].fill(0);
    for (let j = 0; j < w * h; j++) if (id[j]) masks[owner[id[j]]][j] = 1;
  }
  const finals = masks.map((mask) => {
    const { id, comps } = components(mask, w, h);
    const keep = comps.map((c) => c.size >= (o.minSamples ?? 150));
    const m = new Uint8Array(w * h);
    for (let j = 0; j < w * h; j++) if (id[j] && keep[id[j]]) m[j] = 1;
    return m;
  });
  // owner of each sample (-1 = none), to keep districts from overlapping while they absorb what is inside them
  const owner = new Int16Array(w * h).fill(-1);
  finals.forEach((m, i) => {
    for (let j = 0; j < w * h; j++) if (m[j]) owner[j] = i;
  });
  // 1. closing: notches and border lines (road number circles on an edge, white district lines) join the district
  const R = o.close ?? 3;
  finals.forEach((m, i) => {
    const closed = morph(morph(m, w, h, R, false), w, h, R, true);
    for (let j = 0; j < w * h; j++) if (closed[j] && owner[j] === -1) {
      m[j] = 1;
      owner[j] = i;
    }
  });
  // 2. holes: lakes, labels, road numbers fully inside a district are part of it (unless another district is in there)
  finals.forEach((m, i) => {
    const inv = new Uint8Array(w * h);
    for (let j = 0; j < w * h; j++) inv[j] = m[j] ? 0 : 1;
    const { id, comps } = components(inv, w, h);
    const open = new Uint8Array(comps.length); // touches the image edge or holds another district
    for (let j = 0; j < w * h; j++) {
      if (!id[j]) continue;
      const x = j % w, y = (j - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || (owner[j] !== -1 && owner[j] !== i)) open[id[j]] = 1;
    }
    for (let j = 0; j < w * h; j++) if (id[j] && !open[id[j]]) {
      m[j] = 1;
      owner[j] = i;
    }
  });
  return seeds.map((sd, i) => {
    const m = finals[i];
    const rings = traceRings(m, w, h)
      .map((r) => simplify(r, o.tol ?? 1.2))
      .filter((r) => r.length >= 3 && ringArea(r) >= 6)
      .map((r) => r.map(([x, y]): Pt => [Math.round(x * k * 100) / 100, Math.round(y * k * 100) / 100]));
    const d: CityDistrict = { id: sd.id, name: sd.name, color: hex(sd.rgb), rings };
    if (sd.security) d.security = sd.security;
    return d;
  });
}

/** QA picture: the image at `scale`, each district outlined in white with its name at the seed. */
export function qaImage(img: Img, districts: CityDistrict[], seeds: Seed[], gridPx: number, width = 1400): Img {
  const sc = width / img.width;
  const out = resize(img, width, Math.round(img.height * sc));
  const px = gridPx * sc;
  for (const d of districts) {
    for (const r of d.rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        line(out, a[0] * px, a[1] * px, b[0] * px, b[1] * px, [255, 255, 255], { width: 2 });
        line(out, a[0] * px, a[1] * px, b[0] * px, b[1] * px, [0, 0, 0], { width: 1, alpha: 0.6 });
      }
    }
    const sd = seeds.find((s) => s.id === d.id);
    if (sd) text(out, `${d.name} (${d.rings.length})`, sd.at[0] * sc, sd.at[1] * sc + 14, { scale: 2, align: 'center' });
  }
  return out;
}

if (isMain(import.meta.url)) {
  const a = parseArgs();
  const image = a.image || path.join(APP_DIR, 'data', 'assets', 'foundry', 'scenes', 'DqT4928.jpeg');
  const outFile = a.out || path.join(APP_DIR, 'data', 'city', 'seattle.json');
  const gridPx = Number(a.grid || 25);
  const img = readJpeg(image);
  const districts = traceDistricts(img, SEATTLE_SEEDS, SEATTLE_BG, { step: Number(a.step || 4), gridPx, minSamples: Number(a.min || 150), tol: Number(a.tol || 1.2) });
  const shapes: CityShapes = {
    id: 'seattle',
    name: 'Seattle',
    background: '/assets/foundry/scenes/DqT4928.jpeg',
    width: Math.round(img.width / gridPx),
    height: Math.round(img.height / gridPx),
    traced: `tools/city-districts.ts from DqT4928.jpeg (${img.width} × ${img.height} px, ${gridPx} px per cell)`,
    districts,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(shapes, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1,$2]') + '\n');
  for (const d of districts) console.log(d.id.padEnd(15), 'rings', d.rings.length, 'points', d.rings.reduce((n, r) => n + r.length, 0));
  console.log('→', outFile, fs.statSync(outFile).size, 'bytes');
  if (a.qa) {
    writeJpeg(qaImage(img, districts, SEATTLE_SEEDS, gridPx), a.qa);
    console.log('QA →', a.qa);
  }
}
