// Shared helpers of the map tracing toolkit (tools/maptrace/*): JPEG I/O (jpeg-js), raw RGBA image ops, drawing
// primitives (anti-aliased thick lines, dashes, circles, rectangles) and a tiny built-in 5×7 pixel font.
// Images are { width, height, data: Uint8Array RGBA }. Nothing here touches the server or the network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = path.resolve(APP_DIR, '..');
export const MAPLIB_SRC = path.join(APP_DIR, 'data', 'maplib');
export const FOUNDRY_FREE_DIR = 'C:\\Users\\mathi\\Documents\\Foundry\\Data\\modules\\fragmaps-free\\images';

/** Folders searched for a library image (`image` field = path relative to one of them). SR_FRAGMAP_DIRS overrides. */
export function sourceDirs() {
  if (process.env.SR_FRAGMAP_DIRS) return process.env.SR_FRAGMAP_DIRS.split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  return [path.join(REPO_DIR, 'fragmap'), FOUNDRY_FREE_DIR, path.join(APP_DIR, 'data', 'assets', 'foundry', 'scenes')];
}
/** Absolute path of an image: an existing path as given, else `rel` inside the source folders. Null when not found. */
export function findImage(rel) {
  if (!rel) return null;
  if (fs.existsSync(rel) && fs.statSync(rel).isFile()) return path.resolve(rel);
  for (const d of sourceDirs()) {
    const p = path.join(d, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/** Width/height of a JPEG from its SOF header (no decode). */
export function jpegSize(file) {
  const b = fs.readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}
export const readJpeg = (file) => {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxResolutionInMP: 120, maxMemoryUsageInMB: 1500, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
};
export function writeJpeg(img, file, quality = 85) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const enc = jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, enc.data);
  fs.renameSync(tmp, file);
  return enc.data.length;
}
export function newImage(width, height, fill = [24, 24, 28]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}
/** Copy of a rectangle (px); parts outside the image are filled with a dark grey. */
export function crop(img, x0, y0, w, h) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const out = newImage(w, h, [40, 40, 46]);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= img.height) continue;
    const xa = Math.max(0, -x0), xb = Math.min(w, img.width - x0);
    if (xb <= xa) continue;
    out.data.set(img.data.subarray((sy * img.width + x0 + xa) * 4, (sy * img.width + x0 + xb) * 4), (y * w + xa) * 4);
  }
  return out;
}
/** Resize: box filter when shrinking, bilinear when enlarging. */
export function resize(img, tw, th) {
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));
  const { width: w, height: h, data: src } = img;
  const out = newImage(tw, th);
  const d = out.data;
  if (tw <= w && th <= h) {
    for (let ty = 0; ty < th; ty++) {
      const y0 = Math.floor((ty * h) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor((tx * w) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          let i = (y * w + x0) * 4;
          for (let x = x0; x < x1; x++, i += 4) {
            r += src[i];
            g += src[i + 1];
            b += src[i + 2];
            n++;
          }
        }
        const o = (ty * tw + tx) * 4;
        d[o] = r / n;
        d[o + 1] = g / n;
        d[o + 2] = b / n;
      }
    }
    return out;
  }
  for (let ty = 0; ty < th; ty++) {
    const fy = Math.min(h - 1, Math.max(0, ((ty + 0.5) * h) / th - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let tx = 0; tx < tw; tx++) {
      const fx = Math.min(w - 1, Math.max(0, ((tx + 0.5) * w) / tw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      const o = (ty * tw + tx) * 4;
      for (let c = 0; c < 3; c++) {
        const a = src[(y0 * w + x0) * 4 + c] * (1 - wx) + src[(y0 * w + x1) * 4 + c] * wx;
        const b = src[(y1 * w + x0) * 4 + c] * (1 - wx) + src[(y1 * w + x1) * 4 + c] * wx;
        d[o + c] = a * (1 - wy) + b * wy;
      }
    }
  }
  return out;
}
/** Paste `src` into `dst` at (x, y). */
export function paste(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4, o = (dy * dst.width + dx) * 4;
      dst.data[o] = src.data[s];
      dst.data[o + 1] = src.data[s + 1];
      dst.data[o + 2] = src.data[s + 2];
    }
  }
}
/** Darken / desaturate the whole image a bit so overlays stand out. */
export function dim(img, k = 0.75) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    d[i] = (d[i] * 0.6 + l * 0.4) * k;
    d[i + 1] = (d[i + 1] * 0.6 + l * 0.4) * k;
    d[i + 2] = (d[i + 2] * 0.6 + l * 0.4) * k;
  }
  return img;
}

export const hex = (s, fb = [255, 204, 136]) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s || ''));
  if (!m) return fb;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export function blend(img, x, y, c, a) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const o = (y * img.width + x) * 4, d = img.data;
  if (a >= 1) {
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
    return;
  }
  d[o] += (c[0] - d[o]) * a;
  d[o + 1] += (c[1] - d[o + 1]) * a;
  d[o + 2] += (c[2] - d[o + 2]) * a;
}
/** Anti-aliased thick segment. `dash` = [on, off] in px. */
export function line(img, x1, y1, x2, y2, c, { width = 1, alpha = 1, dash = null } = {}) {
  const hw = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - hw - 1)), maxX = Math.min(img.width - 1, Math.ceil(Math.max(x1, x2) + hw + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - hw - 1)), maxY = Math.min(img.height - 1, Math.ceil(Math.max(y1, y2) + hw + 1));
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      if (dash && L > 0) {
        const s = (t * L) % (dash[0] + dash[1]);
        if (s > dash[0]) continue;
      }
      const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
      const d = Math.sqrt(ex * ex + ey * ey);
      const cov = Math.max(0, Math.min(1, hw + 0.5 - d));
      if (cov > 0) blend(img, x, y, c, cov * alpha);
    }
  }
}
export function circle(img, cx, cy, r, c, { width = 2, alpha = 1, fill = 0 } = {}) {
  const minX = Math.max(0, Math.floor(cx - r - width)), maxX = Math.min(img.width - 1, Math.ceil(cx + r + width));
  const minY = Math.max(0, Math.floor(cy - r - width)), maxY = Math.min(img.height - 1, Math.ceil(cy + r + width));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ring = Math.max(0, Math.min(1, width / 2 + 0.5 - Math.abs(d - r)));
      const inside = fill > 0 ? Math.max(0, Math.min(1, r - d + 0.5)) * fill : 0;
      const a = Math.max(ring * alpha, inside);
      if (a > 0) blend(img, x, y, c, a);
    }
  }
}
export function rect(img, x, y, w, h, c, { alpha = 1, fill = false, width = 1 } = {}) {
  if (fill) {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(img.height, Math.ceil(y + h)); yy++)
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(img.width, Math.ceil(x + w)); xx++) blend(img, xx, yy, c, alpha);
    return;
  }
  line(img, x, y, x + w, y, c, { width, alpha });
  line(img, x + w, y, x + w, y + h, c, { width, alpha });
  line(img, x + w, y + h, x, y + h, c, { width, alpha });
  line(img, x, y + h, x, y, c, { width, alpha });
}

// ---- 5×7 pixel font (rows top → bottom, 5 bits each, MSB = left column) ----
const G = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '+': [0, 4, 4, 31, 4, 4, 0],
  '=': [0, 0, 31, 0, 31, 0, 0], '?': [14, 17, 1, 2, 4, 0, 4], '#': [10, 10, 31, 10, 31, 10, 10], "'": [4, 4, 8, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4], '_': [0, 0, 0, 0, 0, 0, 31], '%': [24, 25, 2, 4, 8, 19, 3], ' ': [0, 0, 0, 0, 0, 0, 0],
};
export const FONT = G;
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
/** Pixel width of a text at `scale` (each glyph 5 px + 1 px spacing, × scale). */
export const textWidth = (s, scale = 2) => Math.max(0, fold(s).length * 6 - 1) * scale;
/**
 * Draw text with the 5×7 font. (x, y) = top-left, or centre with align:'center'. `bg` = colour of a padded box behind
 * the text (null = none).
 */
export function text(img, s, x, y, { scale = 2, color = [255, 255, 255], bg = [0, 0, 0], bgAlpha = 0.75, align = 'left', valign = 'top' } = {}) {
  const str = fold(s);
  const w = textWidth(str, scale), h = 7 * scale;
  let x0 = Math.round(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x);
  let y0 = Math.round(valign === 'middle' ? y - h / 2 : valign === 'bottom' ? y - h : y);
  if (bg) rect(img, x0 - scale - 1, y0 - scale - 1, w + 2 * scale + 2, h + 2 * scale + 2, bg, { fill: true, alpha: bgAlpha });
  for (let k = 0; k < str.length; k++) {
    const g = G[str[k]] || G['?'];
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++)
        if (g[r] & (16 >> c))
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) blend(img, x0 + k * 6 * scale + c * scale + dx, y0 + r * scale + dy, color, 1);
  }
  return { x: x0, y: y0, w, h };
}

/** Load a maplib JSON (path or slug in data/maplib). */
export function loadMaplib(arg) {
  let file = arg;
  if (!fs.existsSync(file)) file = path.join(MAPLIB_SRC, arg.endsWith('.json') ? arg : `${arg}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, raw };
}
/** Tiny argv parser: positional args + --key value / --flag. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) {
        out[k] = n;
        i++;
      } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
export const slugOf = (name) =>
  String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
/** True when the module at `metaUrl` is the script being run. */
export const isMain = (metaUrl) => !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
