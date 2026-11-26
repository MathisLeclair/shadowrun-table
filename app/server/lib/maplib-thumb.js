// Thumbnail of a JPEG library image (pure JS: jpeg-js), made in a worker thread so decoding a big map never blocks
// the game server. Used for images uploaded from /admin; tools/maplib-build.js makes the others offline.
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import jpeg from 'jpeg-js';

export const THUMB_MAX = 480;

/** Box-filter downscale of RGBA pixels. */
function downscale(src, w, h, maxW, maxH) {
  const k = Math.max(1, w / maxW, h / maxH);
  const tw = Math.max(1, Math.round(w / k)), th = Math.max(1, Math.round(h / k));
  const out = Buffer.alloc(tw * th * 4);
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
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: tw, height: th };
}

/** Synchronous thumbnail (worker side, tools). Throws on an unreadable JPEG. */
export function thumbSync(src, dst, { maxW = THUMB_MAX, maxH = THUMB_MAX, quality = 78 } = {}) {
  const img = jpeg.decode(fs.readFileSync(src), { useTArray: true, maxResolutionInMP: 80, maxMemoryUsageInMB: 700 });
  const small = downscale(img.data, img.width, img.height, maxW, maxH);
  const enc = jpeg.encode(small, quality);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, enc.data);
  fs.renameSync(tmp, dst);
  return { width: small.width, height: small.height };
}

/** Thumbnail in a worker thread. Resolves true when written, false otherwise (never rejects). */
export function makeThumb(src, dst, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let w;
    try {
      w = new Worker(new URL(import.meta.url), { workerData: { src, dst, opts } });
    } catch {
      return end(false);
    }
    w.once('message', (m) => end(!!m?.ok));
    w.once('error', () => end(false));
    w.once('exit', () => end(false));
  });
}

if (!isMainThread && workerData?.src) {
  try {
    thumbSync(workerData.src, workerData.dst, workerData.opts || {});
    parentPort.postMessage({ ok: true });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}
