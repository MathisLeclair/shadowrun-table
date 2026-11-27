// /api/admin/maplib/* — « Bibliothèque de cartes » panel of /admin (server admin only): list with usage per table,
// rename / tags, rollback, revert to the git / Foundry original, delete, upload an image + create an entry,
// publish a table's corrections, setting « publication réservée à l'administrateur ». See ARCHITECTURE.md « Map library ».
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express, Request, Response, RequestHandler } from 'express';
import { receiveToFile } from './zip.ts';
import * as L from './maplib.ts';
import { makeThumb } from './maplib-thumb.ts';
import { versionFromMap, libGeometry } from '../../shared/maplib.ts';
import type { I18nParams } from '../../shared/types.ts';
import type { StoredMeta, Table } from './tables.ts';

const MAX_IMAGE = Number(process.env.SR_MAX_MAPLIB_IMAGE_BYTES) || 60e6;
const MAX_THUMB_MP = 40; // bigger JPEGs get no automatic thumbnail (make it with tools/maplib-build.js)
const bearer = (req: Request): string => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

/** Error reply of the admin routes (server/lib/admin.ts): `key` = French message with {placeholders}. */
export type AdminFail = (res: Response, status: number, key: string, extra?: Record<string, unknown>, params?: I18nParams) => unknown;

/** What registerAdminRoutes (server/lib/admin.ts) passes to registerMaplibAdminRoutes. */
export interface MaplibAdminOptions {
  requireAdmin: RequestHandler;
  fail: AdminFail;
  listMetas(): StoredMeta[];
  /** Open tables (id -> Table). */
  tables: Map<string, Table>;
  /** Admin session tag -> still logged in? */
  adminSessionAlive(tag: string): boolean;
  scheduleTableBroadcast?(table: Table): void;
}

interface UsageTable {
  tableId: string;
  tableName: string;
  maps: { id: string; name: string; version: number }[];
}

/**
 * Called by registerAdminRoutes (server/lib/admin.ts):
 * { requireAdmin, fail(res, status, key, extra, params), listMetas(), tables (Map id → open Table), adminSessionAlive(tag) → bool,
 *   scheduleTableBroadcast(table) }.
 */
export function registerMaplibAdminRoutes(app: Express, { requireAdmin, fail, listMetas, tables, adminSessionAlive, scheduleTableBroadcast = () => {} }: MaplibAdminOptions): void {
  L.setAdminSessionCheck(adminSessionAlive);
  // err: whatever was thrown (a LibError from maplib.ts, or an unexpected error).
  const libFail = (res: Response, err: any) => {
    if (err?.libKey) return fail(res, err.code === 'stale' ? 409 : 400, err.libKey, err.code ? { code: err.code } : {}, err.libParams);
    console.error('[maplib admin]', err);
    return fail(res, 500, 'Erreur du serveur');
  };
  const entryOr404 = (req: Request, res: Response) => {
    const m = L.getMeta(req.params.slug);
    if (!m) fail(res, 404, 'Carte de bibliothèque introuvable');
    return m;
  };
  /** slug → [{ tableId, tableName, maps: [{ id, name, version }] }] over the open tables. */
  function usage(): Map<string, Map<string, UsageTable>> {
    const out = new Map<string, Map<string, UsageTable>>();
    for (const t of tables.values()) {
      if (t.error || !t.state?.maps) continue;
      for (const map of Object.values(t.state.maps)) {
        const slug = map?.library?.slug;
        if (!slug) continue;
        if (!out.has(slug)) out.set(slug, new Map());
        const per = out.get(slug)!;
        if (!per.has(t.id)) per.set(t.id, { tableId: t.id, tableName: t.state.config?.campaignName || t.meta?.name || t.id, maps: [] });
        per.get(t.id)!.maps.push({ id: map.id, name: map.name, version: map.library?.version || 0 });
      }
    }
    return out;
  }

  app.get('/api/admin/maplib', requireAdmin, (req, res) => {
    const used = usage();
    const git = L.gitSlugs();
    const maps = L.listEntries().map((m) => ({ ...L.adminEntry(m, git), usedBy: [...(used.get(m.slug)?.values() || [])] }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      maps,
      settings: L.getSettings(),
      tables: listMetas().map((m) => ({ id: m.id, name: m.name, archived: !!m.archived })),
      dirs: { maplib: L.MAPLIB_DIR, git: L.GIT_DIR },
      maxBytes: MAX_IMAGE,
    });
  });

  /** Signed key so the admin page can show thumbnails (tied to this admin session). */
  app.get('/api/admin/maplib/key', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { k, exp } = L.signKey({ admin: true, session: L.sessionTag(bearer(req)) as string });
    res.json({ k, exp, now: Date.now() });
  });

  app.patch('/api/admin/maplib/settings', requireAdmin, (req, res) => {
    res.json({ settings: L.setSettings({ publishAdminOnly: !!req.body?.publishAdminOnly }) });
  });

  // Body = the image (jpg / png / webp), streamed. ?slug=&name=&nameFr=&gridPx=&offsetX=&offsetY=&source=&theme=&lighting=&tags=&replace=1
  app.post('/api/admin/maplib/upload', requireAdmin, async (req, res) => {
    const q = req.query;
    const slug = L.cleanSlug(q.slug);
    const ext = String(req.headers['x-filename'] ? decodeURIComponent(String(req.headers['x-filename'])) : '').toLowerCase().match(/\.(jpe?g|png|webp)$/)?.[0];
    if (!slug) {
      req.resume();
      return fail(res, 400, 'Identifiant invalide (lettres minuscules, chiffres et tirets)');
    }
    if (!ext) {
      req.resume();
      return fail(res, 400, 'Image attendue (JPEG, PNG ou WebP)');
    }
    const exists = !!L.getMeta(slug);
    if (exists && q.replace !== '1') {
      req.resume();
      return fail(res, 409, 'La carte {slug} existe déjà : coche « Remplacer l’image »', { code: 'exists' }, { slug });
    }
    const gridPx = Number(q.gridPx);
    if (!(gridPx >= 4 && gridPx <= 2000) && !exists) {
      req.resume();
      return fail(res, 400, 'Taille de case invalide (pixels par case, ex. 70)');
    }
    fs.mkdirSync(L.IMAGES_DIR, { recursive: true });
    const tmp = path.join(L.IMAGES_DIR, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      await receiveToFile(req, tmp, { maxBytes: MAX_IMAGE });
      const size = L.imageSize(tmp);
      const want = ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg';
      if (!size || size.type !== want || !size.width || !size.height) {
        fs.rmSync(tmp, { force: true });
        return fail(res, 400, 'Image attendue (JPEG, PNG ou WebP)');
      }
      const g = libGeometry({ gridPx: gridPx || L.getMeta(slug)?.gridPx, imageW: size.width, imageH: size.height, offsetX: Number(q.offsetX) || 0, offsetY: Number(q.offsetY) || 0 });
      if (g.width > 160 || g.height > 160) {
        fs.rmSync(tmp, { force: true });
        return fail(res, 400, 'Carte trop grande ({w} × {h} cases, {max} max)', {}, { w: g.width, h: g.height, max: 160 });
      }
      const image = `${slug}${ext === '.jpeg' ? '.jpg' : ext}`;
      const dest = path.join(L.IMAGES_DIR, image);
      // An older image of the same entry with another extension is replaced.
      for (const e of ['.jpg', '.png', '.webp']) if (e !== path.extname(image)) fs.rmSync(path.join(L.IMAGES_DIR, slug + e), { force: true });
      fs.renameSync(tmp, dest);
      const m = L.createUploaded({
        slug, name: q.name, nameFr: q.nameFr, source: q.source, gridPx: gridPx || undefined, offsetX: q.offsetX != null ? Number(q.offsetX) || 0 : undefined, offsetY: q.offsetY != null ? Number(q.offsetY) || 0 : undefined,
        image, imageW: size.width, imageH: size.height, theme: q.theme, lighting: q.lighting, tags: q.tags, description: q.description, metersPerCell: q.metersPerCell,
      });
      for (const e of ['.jpg', '.webp', '.png']) fs.rmSync(path.join(L.THUMBS_DIR, slug + e), { force: true });
      let thumb = false;
      if (size.type === 'jpeg' && size.width * size.height <= MAX_THUMB_MP * 1e6) thumb = await makeThumb(dest, path.join(L.THUMBS_DIR, `${slug}.jpg`));
      res.json({ ok: true, entry: L.adminEntry(m), thumb });
    } catch (e) {
      const err = e as { libKey?: string; status?: number };
      fs.rmSync(tmp, { force: true });
      if (err?.libKey) return libFail(res, err);
      return fail(res, err.status || 500, err.status === 413 ? 'Fichier trop volumineux' : 'Envoi interrompu');
    }
  });

  app.patch('/api/admin/maplib/:slug', requireAdmin, (req, res) => {
    if (!entryOr404(req, res)) return;
    try {
      res.json({ entry: L.adminEntry(L.patchEntry(req.params.slug, req.body || {})) });
    } catch (err) {
      libFail(res, err);
    }
  });

  app.delete('/api/admin/maplib/:slug', requireAdmin, (req, res) => {
    const m = entryOr404(req, res);
    if (!m) return;
    if (req.body?.confirm !== m.slug) return fail(res, 400, 'Confirmation manquante');
    L.deleteEntry(m.slug);
    res.json({ ok: true });
  });

  app.post('/api/admin/maplib/:slug/rollback', requireAdmin, (req, res) => {
    const m = entryOr404(req, res);
    if (!m) return;
    try {
      const version = L.rollback(m.slug, Number(req.body?.version), { kind: 'admin' });
      res.json({ version, entry: L.adminEntry(m) });
    } catch (err) {
      libFail(res, err);
    }
  });

  app.post('/api/admin/maplib/:slug/revert', requireAdmin, (req, res) => {
    const m = entryOr404(req, res);
    if (!m) return;
    try {
      const version = L.revertToOrigin(m.slug, { kind: 'admin' });
      res.json({ version, entry: L.adminEntry(m) });
    } catch (err) {
      libFail(res, err);
    }
  });

  /** « Publier depuis une table »: { tableId, mapId, force? } — that table map's walls become the new version. */
  app.post('/api/admin/maplib/:slug/publish', requireAdmin, (req, res) => {
    const m = entryOr404(req, res);
    if (!m) return;
    const t = tables.get(String(req.body?.tableId || ''));
    const map = t && !t.error ? t.state?.maps?.[String(req.body?.mapId || '')] : null;
    if (!map) return fail(res, 404, 'Carte introuvable');
    if (map.library?.slug !== m.slug) return fail(res, 400, 'Seules les cartes venant de la bibliothèque peuvent y être publiées');
    try {
      const cur = L.getVersion(m.slug);
      const g = libGeometry({ ...L.effective(m), ...(cur?.geometry || {}) });
      const bg: Partial<NonNullable<typeof map.background>> = map.background || {};
      const content = { ...versionFromMap(map, { shift: { x: (Number(bg.x) || 0) - g.bgX, y: (Number(bg.y) || 0) - g.bgY } }), ...(cur?.entry ? { entry: cur.entry } : {}) };
      const version = L.publish(m.slug, content, { kind: 'admin', tableId: t!.id, table: t!.state.config?.campaignName || t!.id, mapId: map.id }, { baseVersion: map.library.version ?? 0, force: !!req.body?.force });
      map.library = { ...map.library, version, syncedAt: Date.now() };
      delete map.library.migrated;
      t!.store.saveSoon();
      scheduleTableBroadcast(t!);
      res.json({ version, entry: L.adminEntry(m) });
    } catch (err) {
      libFail(res, err);
    }
  });
}
