#!/usr/bin/env node
// Copies the artwork of the library maps (data/maplib/*.json → `image`) into <maplib>/images/ and makes their
// thumbnails (<maplib>/thumbs/<slug>.jpg, ≤ 480 px, jpeg-js) — the files the server serves behind the signed links.
//   node tools/maplib-build.js [--only slug,slug] [--force] [--dry]
// <maplib> = SR_MAPLIB_DIR, else <runtime>/maplib (runtime = SR_RUNTIME_DIR, else data/) — same rule as server/lib/maplib.js.
// Sources: SR_FRAGMAP_DIRS (path-list), else ../fragmap, the Foundry fragmaps-free module images, data/assets/foundry/scenes.
// Idempotent: an image is copied again only when its size or mtime changed, a thumbnail is rebuilt only when older
// than its image (or --force). The images are the owner's paid content: never commit them, never serve them unsigned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thumbSync, THUMB_MAX } from '../server/lib/maplib-thumb.js';
import { findImage, sourceDirs, args } from './maptrace/lib.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_DIR = process.env.SR_MAPLIB_SOURCE ? path.resolve(process.env.SR_MAPLIB_SOURCE) : path.join(APP, 'data', 'maplib');
const RUNTIME = process.env.SR_RUNTIME_DIR ? path.resolve(process.env.SR_RUNTIME_DIR) : path.join(APP, 'data');
const MAPLIB = process.env.SR_MAPLIB_DIR ? path.resolve(process.env.SR_MAPLIB_DIR) : path.join(RUNTIME, 'maplib');
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const kb = (n) => `${Math.round(n / 1024)} KB`;

export function build({ only = null, force = false, dry = false, log = console.log } = {}) {
  const images = path.join(MAPLIB, 'images'), thumbs = path.join(MAPLIB, 'thumbs');
  const files = fs.existsSync(GIT_DIR) ? fs.readdirSync(GIT_DIR).filter((f) => f.endsWith('.json') && f !== 'library.json').sort() : [];
  const res = { copied: 0, kept: 0, thumbs: 0, missing: [], bytes: 0, thumbBytes: 0 };
  for (const f of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(GIT_DIR, f), 'utf8'));
    } catch (err) {
      log(`  ✗ ${f}: invalid JSON (${err.message})`);
      continue;
    }
    const slug = raw.slug || f.slice(0, -5);
    if (only && !only.includes(slug)) continue;
    if (!raw.image) continue; // entries pointing at data/assets (imagePath) need no copy
    const rel = String(raw.image).replace(/\\/g, '/');
    if (rel.split('/').some((p) => !p || p === '..' || p.startsWith('.'))) {
      log(`  ✗ ${slug}: unsafe image path « ${rel} »`);
      continue;
    }
    const src = findImage(rel);
    if (!src) {
      res.missing.push(`${slug} (${rel})`);
      log(`  ✗ ${slug}: image « ${rel} » not found`);
      continue;
    }
    const dst = path.join(images, ...rel.split('/'));
    const s = fs.statSync(src);
    const d = fs.existsSync(dst) ? fs.statSync(dst) : null;
    const same = d && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000;
    if (!same || force) {
      if (!dry) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, `${dst}.tmp`);
        fs.renameSync(`${dst}.tmp`, dst);
        fs.utimesSync(dst, s.atime, s.mtime);
      }
      res.copied++;
    } else res.kept++;
    res.bytes += s.size;
    const th = path.join(thumbs, `${slug}.jpg`);
    const thStat = fs.existsSync(th) ? fs.statSync(th) : null;
    let thumbNote = 'thumb ok';
    if (force || !thStat || thStat.mtimeMs < s.mtimeMs) {
      if (/\.jpe?g$/i.test(rel)) {
        if (!dry) {
          const t = thumbSync(src, th, { maxW: THUMB_MAX, maxH: THUMB_MAX });
          thumbNote = `thumb ${t.width}×${t.height}`;
        } else thumbNote = 'thumb (dry)';
        res.thumbs++;
      } else thumbNote = 'no thumb (not a JPEG)';
    }
    const tsz = fs.existsSync(th) ? fs.statSync(th).size : 0;
    res.thumbBytes += tsz;
    log(`  ${same && !force ? '=' : '+'} ${slug.padEnd(32)} ${mb(s.size).padStart(9)}  ${thumbNote}${tsz ? ` (${kb(tsz)})` : ''}`);
  }
  return res;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = args();
  console.log(`maplib-build: ${GIT_DIR} → ${MAPLIB}${a.dry ? '  (dry run)' : ''}`);
  console.log(`  image sources: ${sourceDirs().join(' | ')}`);
  const r = build({ only: a.only ? String(a.only).split(',') : null, force: !!a.force, dry: !!a.dry });
  console.log(`done: ${r.copied} copied, ${r.kept} unchanged, ${r.thumbs} thumbnail(s) made, images ${mb(r.bytes)}, thumbnails ${mb(r.thumbBytes)}${r.missing.length ? `, ${r.missing.length} MISSING: ${r.missing.join(', ')}` : ''}`);
  if (r.missing.length) process.exitCode = 1;
}
