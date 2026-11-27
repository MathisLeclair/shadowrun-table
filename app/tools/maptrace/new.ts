#!/usr/bin/env node
// Scaffold a library map file with the geometry already right.
//   node tools/maptrace/new.ts "<image relative to the source folder>" [--slug s] [--name "English"] [--nameFr "Français"]
//        [--grid px] [--source fragmap|fragmaps-free] [--theme t] [--lighting dim] [--force]
// Writes data/maplib/<slug>.json (refuses to overwrite without --force) with id, image size, gridPx (Fragmaps
// convention unless --grid), width/height, empty walls/lights/regions and a traced block to complete.
import fs from 'node:fs';
import path from 'node:path';
import { args, isMain, findImage, jpegSize, slugOf, MAPLIB_SRC } from './lib.ts';
import { conventionPitch } from './scale.ts';
import { formatMaplib } from './check.ts';

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function scaffold(image, a = {}) {
  const file = findImage(image);
  if (!file) throw new Error(`image « ${image} » not found (see SR_FRAGMAP_DIRS)`);
  const { width: W, height: H } = jpegSize(file);
  const gridPx = Number(a.grid) || conventionPitch(W, H);
  if (!gridPx) throw new Error('no standard pitch fits this image: pass --grid (see scale.js)');
  const base = path.basename(image).replace(/\.[^.]+$/, '');
  const slug = a.slug || slugOf(base);
  return {
    id: `lib_${slug}`, slug, name: a.name || titleCase(base), nameFr: a.nameFr || '', source: a.source || 'fragmap',
    image: image.replace(/\\/g, '/'), imageW: W, imageH: H, gridPx, offsetX: 0, offsetY: 0,
    width: Math.ceil(W / gridPx - 1e-6), height: Math.ceil(H / gridPx - 1e-6), metersPerCell: 1.5,
    theme: a.theme || 'street', lighting: a.lighting || 'dim', tags: [], description: '',
    entry: null, walls: [], lights: [], regions: [],
    traced: { by: 'agent', at: new Date().toISOString(), quality: 'rough', notes: '' }, version: 1,
  };
}

if (isMain(import.meta.url)) {
  const a = args();
  if (!a._[0]) {
    console.error('usage: node tools/maptrace/new.ts "<image>" [--slug s] [--name EN] [--nameFr FR] [--grid px] [--source fragmap] [--theme t] [--lighting l] [--force]');
    process.exit(2);
  }
  try {
    const raw = scaffold(a._[0], a);
    const out = path.join(MAPLIB_SRC, `${raw.slug}.json`);
    if (fs.existsSync(out) && !a.force) throw new Error(`${out} exists (use --force to overwrite)`);
    if (!raw.entry) delete raw.entry;
    fs.mkdirSync(MAPLIB_SRC, { recursive: true });
    fs.writeFileSync(out, formatMaplib(raw));
    console.log(`${out}  ${raw.width}×${raw.height} cells @ ${raw.gridPx}px — fill nameFr, theme, lighting, tags, description, entry, walls, lights, regions, traced`);
  } catch (err) {
    console.error('new: ' + err.message);
    process.exit(1);
  }
}
