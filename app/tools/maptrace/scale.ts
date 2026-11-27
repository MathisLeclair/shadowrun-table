#!/usr/bin/env node
// Grid pitch (px per 1.5 m cell) of a fragmap image.
//   node tools/maptrace/scale.ts <image|name> [--twin <grid image>] [--json]
// - With a « … grid.jpg » twin (found automatically next to the image, or --twin): the grid lines are isolated as
//   |grid − clean| and their pitch + origin are measured by autocorrelation and a fractional comb fit (exact).
// - Otherwise: candidates from the image size (the Fragmaps convention: width and height are whole numbers of cells)
//   ranked with the periodicity of the image itself (floor tiles, furniture, wall rhythm). See README « Scale ».
import fs from 'node:fs';
import path from 'node:path';
import { readJpeg, jpegSize, findImage, args, isMain } from './lib.ts';
import type { Img } from './lib.ts';

/** Grid measured on one axis of a twin pair (pitch/phase null when no period was found). */
export interface AxisMeasure {
  lag: number | null;
  corr: number;
  pitch: number | undefined;
  phase: number | undefined;
}
export interface TwinMeasure {
  width: number;
  height: number;
  x: AxisMeasure;
  y: AxisMeasure;
}
/** A grid pitch candidate of estimate(). */
export interface PitchCandidate {
  gridPx: number;
  score: number;
  why: string[];
  confidence: number;
}
export interface PitchEstimate {
  width: number;
  height: number;
  candidates: PitchCandidate[];
  texture: Array<{ lag: number; corr: number }>;
}

const gray = (img: Img): Float32Array => {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  return g;
};
function profiles(field: ArrayLike<number>, w: number, h: number): { col: Float64Array; row: Float64Array } {
  const col = new Float64Array(w), row = new Float64Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = field[y * w + x];
      col[x] += v;
      row[y] += v;
    }
  return { col, row };
}
/** Remove the slow trend (moving average) so only sharp periodic peaks remain. */
function detrend(p: Float64Array, win = 31): Float64Array {
  const out = new Float64Array(p.length);
  const half = win >> 1;
  let s = 0, n = 0;
  const pre = new Float64Array(p.length + 1);
  for (let i = 0; i < p.length; i++) pre[i + 1] = pre[i] + p[i];
  for (let i = 0; i < p.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(p.length, i + half + 1);
    out[i] = p[i] - (pre[b] - pre[a]) / (b - a);
  }
  void s, n;
  return out;
}
function autocorr(p: Float64Array, minLag: number, maxLag: number): Map<number, number> {
  let mean = 0;
  for (const v of p) mean += v;
  mean /= p.length;
  let v0 = 0;
  for (const v of p) v0 += (v - mean) ** 2;
  const out = new Map<number, number>();
  for (let lag = minLag; lag <= Math.min(maxLag, p.length >> 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < p.length; i++) s += (p[i] - mean) * (p[i + lag] - mean);
    out.set(lag, v0 ? (s / v0) * (p.length / (p.length - lag)) : 0);
  }
  return out;
}
/** Fractional pitch + phase that maximise the comb sum of a (positive) peak profile. */
function combFit(p: Float64Array, approx: number): { pitch: number; phase: number } {
  let best = { score: -Infinity, pitch: approx, phase: 0 };
  const pos = p.map((v) => Math.max(0, v));
  const sample = (x: number): number => {
    const i = Math.floor(x), f = x - i;
    if (i < 0 || i + 1 >= pos.length) return 0;
    return pos[i] * (1 - f) + pos[i + 1] * f;
  };
  for (let pitch = approx - 1.5; pitch <= approx + 1.5; pitch += 0.01) {
    for (let phase = 0; phase < pitch; phase += 0.25) {
      let s = 0, n = 0;
      for (let x = phase; x < pos.length; x += pitch, n++) s += Math.max(sample(x - 0.5), sample(x), sample(x + 0.5));
      s /= n || 1;
      if (s > best.score) best = { score: s, pitch, phase };
    }
  }
  return { pitch: Math.round(best.pitch * 100) / 100, phase: Math.round(best.phase * 100) / 100 };
}
function pickLag(ac: Map<number, number>): { lag: number | null; value: number; max: number } {
  let max = -Infinity;
  for (const v of ac.values()) max = Math.max(max, v);
  // smallest lag that is a local maximum and close to the best value (avoids picking a multiple of the pitch)
  for (const [lag, v] of ac) {
    if (v < 0.75 * max) continue;
    const a = ac.get(lag - 1) ?? -Infinity, b = ac.get(lag + 1) ?? -Infinity;
    if (v >= a && v >= b) return { lag, value: v, max };
  }
  return { lag: null, value: 0, max };
}

export function measureTwin(cleanFile: string, gridFile: string): TwinMeasure {
  const a = readJpeg(cleanFile), b = readJpeg(gridFile);
  if (a.width !== b.width || a.height !== b.height) throw new Error('twin sizes differ');
  const ga = gray(a), gb = gray(b);
  const d = new Float32Array(ga.length);
  for (let i = 0; i < d.length; i++) d[i] = Math.abs(ga[i] - gb[i]);
  const { col, row } = profiles(d, a.width, a.height);
  const res = {} as Record<'x' | 'y', AxisMeasure>;
  for (const [axis, p] of [['x', col], ['y', row]] as const) {
    const dp = detrend(p);
    const ac = autocorr(dp, 20, 400);
    const pk = pickLag(ac);
    const fit = pk.lag ? combFit(dp, pk.lag) : null;
    res[axis] = { lag: pk.lag, corr: Math.round(pk.value * 1000) / 1000, pitch: fit?.pitch, phase: fit?.phase };
  }
  return { width: a.width, height: a.height, ...res };
}

/** Pitches seen in Fragmaps exports (px per 5 ft square), largest first. */
export const STANDARD = [200, 140, 120, 100, 80, 70];
const fits = (W: number, H: number, p: number): boolean => {
  const ex = Math.abs(W / p - Math.round(W / p)) * p, ey = Math.abs(H / p - Math.round(H / p)) * p;
  return ex <= 2.5 && ey <= 2.5 && Math.round(W / p) >= 3 && Math.round(H / p) >= 3;
};
/** The convention's answer (null when no standard pitch fits). */
export function conventionPitch(W: number, H: number): number | null {
  return STANDARD.find((p) => fits(W, H, p)) || null;
}

/** Candidates without a twin. */
export function estimate(file: string, { decode = true }: { decode?: boolean } = {}): PitchEstimate {
  const sz = jpegSize(file);
  if (!sz) throw new Error(`not a JPEG: ${file}`);
  const W = sz.width, H = sz.height;
  const cands = new Map<number, PitchCandidate>();
  const add = (p: number, why: string, score: number) => {
    const c = cands.get(p) || { gridPx: p, score: 0, why: [], confidence: 0 };
    c.score += score;
    c.why.push(why);
    cands.set(p, c);
  };
  // 1) size: both sides a whole number of cells (allow ±2 px: some exports are off by 1-2 px, e.g. 2401×2999, 3202×4200).
  // Fragmaps convention (measured on the 4 grid twins): the LARGEST standard pitch that divides the image wins.
  let rank = 0;
  for (const p of STANDARD) {
    if (fits(W, H, p)) add(p, `standard pitch, size ${Math.round(W / p)}×${Math.round(H / p)} cells${rank === 0 ? ' (largest standard divisor → convention)' : ''}`, rank++ === 0 ? 10 : 2 / rank);
  }
  for (let p = 50; p <= 220; p++) if (!STANDARD.includes(p) && fits(W, H, p)) add(p, `size ${Math.round(W / p)}×${Math.round(H / p)} cells (non-standard)`, 0.3);
  // 2) image periodicity (gradient profile autocorrelation)
  let tex: PitchEstimate['texture'] = [];
  if (decode) {
    const img = readJpeg(file);
    const g = gray(img);
    const gx = new Float32Array(g.length), gy = new Float32Array(g.length);
    for (let y = 1; y < img.height; y++)
      for (let x = 1; x < img.width; x++) {
        const i = y * img.width + x;
        gx[i] = Math.abs(g[i] - g[i - 1]);
        gy[i] = Math.abs(g[i] - g[i - img.width]);
      }
    const col = profiles(gx, img.width, img.height).col, row = profiles(gy, img.width, img.height).row;
    const acx = autocorr(detrend(col), 30, 300), acy = autocorr(detrend(row), 30, 300);
    const both: Array<{ lag: number; v: number }> = [];
    for (const [lag, v] of acx) both.push({ lag, v: (v + (acy.get(lag) ?? 0)) / 2 });
    const peaks = both.filter((e, i) => i > 0 && i < both.length - 1 && e.v >= both[i - 1].v && e.v >= both[i + 1].v && e.v > 0.05).sort((a, b) => b.v - a.v).slice(0, 6);
    tex = peaks.map((p) => ({ lag: p.lag, corr: Math.round(p.v * 1000) / 1000 }));
    for (const p of peaks as Array<{ lag: number; v: number; corr?: number }>) {
      for (const c of cands.values()) {
        // texture period = the cell, half a cell or two cells
        for (const k of [1, 0.5, 2]) if (Math.abs(p.lag - c.gridPx * k) <= Math.max(1.5, c.gridPx * k * 0.02)) c.score += p.v * (k === 1 ? 4 : 2), c.why.push(`texture period ${p.lag}px (${k === 1 ? '1 cell' : k === 0.5 ? '½ cell' : '2 cells'}, r=${p.corr ?? p.v.toFixed(2)})`);
      }
    }
  }
  const list = [...cands.values()].sort((a, b) => b.score - a.score);
  const total = list.reduce((s, c) => s + c.score, 0) || 1;
  for (const c of list) c.confidence = Math.round((c.score / total) * 100) / 100;
  return { width: W, height: H, candidates: list.slice(0, 6), texture: tex };
}

function twinOf(file: string): string | null {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  const cand = path.join(dir, `${base} grid${path.extname(file)}`);
  return fs.existsSync(cand) ? cand : null;
}

if (isMain(import.meta.url)) {
  const a = args();
  const file = findImage(a._[0]);
  if (!file) {
    console.error('usage: node tools/maptrace/scale.ts <image> [--twin <grid image>] [--json]   (image not found)');
    process.exit(2);
  }
  const twin = a.twin ? findImage(a.twin) : twinOf(file);
  const out: { image: string; twin?: TwinMeasure & { file: string }; estimate?: PitchEstimate } = { image: file };
  if (twin) out.twin = { file: twin, ...measureTwin(file, twin) };
  const est = (out.estimate = estimate(file));
  if (a.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${path.basename(file)}  ${est.width}×${est.height} px`);
    if (out.twin) {
      const t = out.twin;
      console.log(`  grid twin: pitch x=${t.x.pitch}px (r=${t.x.corr}) y=${t.y.pitch}px (r=${t.y.corr})  origin phase x=${t.x.phase} y=${t.y.phase}`);
      const px = Number(t.x.pitch), py = Number(t.y.pitch);
      console.log(`  → gridPx ${(((px + py) / 2)).toFixed(2)}  = ${(t.width / px).toFixed(2)} × ${(t.height / py).toFixed(2)} cells`);
    }
    console.log('  candidates (size + texture):');
    for (const c of est.candidates)
      console.log(`    ${String(c.gridPx).padStart(4)} px  conf ${c.confidence.toFixed(2)}  ${Math.round(est.width / c.gridPx)}×${Math.round(est.height / c.gridPx)} cells  — ${[...new Set(c.why)].join('; ')}`);
    const conv = conventionPitch(est.width, est.height);
    if (conv) {
      console.log(`  CONVENTION → gridPx ${conv}  (${Math.round(est.width / conv)}×${Math.round(est.height / conv)} cells, offset 0,0)`);
      console.log(`  sanity check at ${conv}px: door leaf ≈ ${Math.round(conv * 0.6)}px, pool table ≈ ${Math.round(conv * 0.85)}×${Math.round(conv * 1.7)}px, car ≈ ${Math.round(conv * 1.3)}×${Math.round(conv * 3)}px, 3-seat sofa ≈ ${Math.round(conv * 1.4)}px long`);
    } else console.log('  CONVENTION → no standard pitch fits: measure a door / car / pool table and use the candidates');
    if (est.texture.length) console.log('  texture periods: ' + est.texture.map((t) => `${t.lag}px r=${t.corr}`).join(', '));
  }
}
