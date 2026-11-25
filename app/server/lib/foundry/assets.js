// Asset plan for a Foundry import: converters ask for a URL (asset(src, kind)), the plan remembers which
// file must be copied where; copying happens later (sync for small files, async for audio).
// Files land in data/assets/foundry/<kind dir>/… and are served at /assets/foundry/….
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'assets', 'foundry');
export const URL_BASE = '/assets/foundry';
const KIND_DIR = { img: 'img', scene: 'scenes', thumb: 'thumbs', audio: 'audio', journal: 'img/journal' };

function safeName(s) {
  return (
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(-120) || 'fichier'
  );
}

function decode(src) {
  let s = String(src || '').trim();
  try {
    s = decodeURIComponent(s);
  } catch {}
  return s.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * createAssets({ dataRoot, outDir }) → { asset(src, kind, hint?, sub?), entries(), missing, copySync(kinds), copyAsync(kinds, onProgress) }
 * asset() returns '' for missing files, and the original URL for http(s) sources (no copy).
 */
export function createAssets({ dataRoot, outDir = process.env.SR_FOUNDRY_ASSET_DIR || DEFAULT_ASSET_DIR } = {}) {
  const plan = new Map(); // rel dest -> { from, kind, size, mtimeMs }
  const bySource = new Map(); // `${kind}|${from}` -> rel
  const missing = [];

  function asset(src, kind = 'img', hint = '', sub = '') {
    const raw = String(src || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/assets/') || raw.startsWith('/uploads/')) return raw;
    if (/^icons\//.test(raw)) return ''; // Foundry core icons are not in the Data folder
    const rel = decode(raw);
    const from = path.resolve(dataRoot, rel);
    if (!from.toLowerCase().startsWith(path.resolve(dataRoot).toLowerCase())) return '';
    const key = `${kind}|${from}|${sub}`;
    if (bySource.has(key)) return toUrl(bySource.get(key));
    let st;
    try {
      st = fs.statSync(from);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      missing.push(rel);
      return '';
    }
    const ext = path.extname(rel).toLowerCase();
    const base = hint ? safeName(hint) + ext : safeName(path.basename(rel));
    const dir = [KIND_DIR[kind] || kind, sub ? safeName(sub) : ''].filter(Boolean).join('/');
    let dest = `${dir}/${base}`;
    if (plan.has(dest) && plan.get(dest).from !== from) {
      const h = crypto.createHash('sha1').update(from).digest('hex').slice(0, 6);
      dest = `${dir}/${path.basename(base, ext)}-${h}${ext}`;
    }
    plan.set(dest, { from, kind, size: st.size, mtimeMs: st.mtimeMs });
    bySource.set(key, dest);
    return toUrl(dest);
  }

  function toUrl(rel) {
    return `${URL_BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }

  function needsCopy(dest, e) {
    try {
      const st = fs.statSync(dest);
      return !(st.size === e.size && st.mtimeMs >= e.mtimeMs - 1);
    } catch {
      return true;
    }
  }

  /** Filter: array of kinds, or { kinds?, urls? } (urls = Set/array of URLs returned by asset()). */
  function list(filter) {
    const f = Array.isArray(filter) ? { kinds: filter } : filter || {};
    const urls = f.urls ? new Set([...f.urls].filter(Boolean)) : null;
    return [...plan.entries()].filter(([rel, e]) => (!f.kinds || f.kinds.includes(e.kind)) && (!urls || urls.has(toUrl(rel))));
  }

  /** Copy (if changed) synchronously. Returns { copied, skipped, bytes, errors }. */
  function copySync(kinds) {
    const out = { copied: 0, skipped: 0, bytes: 0, errors: [] };
    for (const [rel, e] of list(kinds)) {
      const dest = path.join(outDir, ...rel.split('/'));
      out.bytes += e.size;
      if (!needsCopy(dest, e)) {
        out.skipped++;
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(e.from, dest);
        fs.utimesSync(dest, new Date(), new Date(e.mtimeMs));
        out.copied++;
      } catch (err) {
        out.errors.push(`${rel} : ${err.message}`);
      }
    }
    return out;
  }

  /** Same, asynchronously (big audio files) — onProgress({ done, total, bytes }). */
  async function copyAsync(kinds, onProgress) {
    const items = list(kinds);
    const out = { copied: 0, skipped: 0, bytes: 0, errors: [] };
    let done = 0;
    for (const [rel, e] of items) {
      const dest = path.join(outDir, ...rel.split('/'));
      out.bytes += e.size;
      if (!needsCopy(dest, e)) out.skipped++;
      else {
        try {
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(e.from, dest);
          await fs.promises.utimes(dest, new Date(), new Date(e.mtimeMs));
          out.copied++;
        } catch (err) {
          out.errors.push(`${rel} : ${err.message}`);
        }
      }
      done++;
      onProgress?.({ done, total: items.length, bytes: out.bytes });
    }
    return out;
  }

  function totals(kinds) {
    const l = list(kinds);
    return { files: l.length, bytes: l.reduce((s, [, e]) => s + e.size, 0) };
  }

  return { asset, missing, copySync, copyAsync, totals, entries: () => [...plan.entries()], outDir };
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace('.', ',')} Go`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace('.', ',')} Mo`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} ko`;
  return `${v} o`;
}
