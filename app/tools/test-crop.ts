// Tests for client/lib/crop.ts (portrait crop geometry, pure, no server): node tools/test-crop.ts
import { clampView, coverScale, cropRect, initialView, outputSize, panView, zoomView, MAX_ZOOM, OUTPUT_SIZE } from '../client/lib/crop.ts';
import assert from 'node:assert/strict';

let ok = 0;
let ko = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    ok++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    ko++;
    console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
};
const F = 300;
const wide = { w: 1200, h: 600 };
const tall = { w: 400, h: 1000 };

t('zoom 1 centred: the short side fills the frame, the middle square is kept', () => {
  assert.equal(coverScale(wide, F), 0.5);
  const v = initialView(wide, F);
  assert.deepEqual(v, { zoom: 1, ox: -150, oy: 0 });
  assert.deepEqual(cropRect(wide, F, v), { sx: 300, sy: 0, size: 600 });
  assert.deepEqual(cropRect(tall, F, initialView(tall, F)), { sx: 0, sy: 300, size: 400 });
});

t('drag: moves the image, never uncovers the frame', () => {
  const v = initialView(wide, F);
  assert.deepEqual(panView(wide, F, v, 100, 0), { zoom: 1, ox: -50, oy: 0 });
  assert.deepEqual(panView(wide, F, v, 400, 0), { zoom: 1, ox: 0, oy: 0 }, 'left edge stops at the frame');
  assert.deepEqual(panView(wide, F, v, -1000, 50), { zoom: 1, ox: -300, oy: 0 }, 'right edge stops too; no vertical room at zoom 1');
  assert.deepEqual(cropRect(wide, F, panView(wide, F, v, -1000, 0)), { sx: 600, sy: 0, size: 600 });
});

t('zoom: keeps the point under the cursor, the crop shrinks', () => {
  const v = initialView(wide, F);
  const z = zoomView(wide, F, v, 2, 0, 0); // zoom on the frame's top-left corner
  assert.deepEqual(z, { zoom: 2, ox: -300, oy: 0 });
  assert.deepEqual(cropRect(wide, F, z), { sx: 300, sy: 0, size: 300 });
  const c = zoomView(wide, F, v, 2); // centre
  assert.deepEqual(cropRect(wide, F, c), { sx: 450, sy: 150, size: 300 });
  assert.equal(zoomView(wide, F, v, 100).zoom, MAX_ZOOM);
  assert.deepEqual(zoomView(wide, F, c, 0.2), initialView(wide, F), 'zooming out past 1 recentres within bounds');
});

t('clamp: bad values come back valid', () => {
  assert.deepEqual(clampView(wide, F, { zoom: NaN, ox: Infinity, oy: -Infinity }), { zoom: 1, ox: 0, oy: 0 });
  const r = cropRect({ w: 10, h: 10 }, F, { zoom: 8, ox: 5, oy: 5 });
  assert.ok(r.size >= 1 && r.sx >= 0 && r.sy >= 0 && r.sx + r.size <= 10 && r.sy + r.size <= 10, JSON.stringify(r));
});

t('output: 512 px, small crops are not upscaled', () => {
  assert.equal(outputSize({ sx: 0, sy: 0, size: 600 }), OUTPUT_SIZE);
  assert.equal(outputSize({ sx: 0, sy: 0, size: 200 }), 200);
});

console.log(`\n${ok} ok, ${ko} failed`);
process.exit(ko ? 1 : 0);
