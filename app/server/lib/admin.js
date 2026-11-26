// Server administration (/admin page): create / rename / archive / delete tables, reset a GM password,
// download a table backup (zip), restore a table from a zip or a state JSON, disk usage.
// Admin auth is separate from table sessions: POST /api/admin/login { password } → bearer token (in memory, 12 h).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TABLES_DIR, DELETED_DIR, TMP_DIR, RUNTIME_DIR, GLOBAL_ASSETS_DIR, readJson, writeJsonAtomic } from '../store.js';
import {
  PACKS, LANGS, slugify, slugError, getRegistry, listMetas, getMeta, addMeta, updateMeta, removeMeta,
  createTableFiles, verifyPassword, setAdminPassword,
} from './tables.js';
import { ZipError, listZip, safeEntryPath, extractZip, writeZip, writeZipFile, walkFiles, dirSize, receiveToFile } from './zip.js';
import { errorBody } from './i18n.js';
import { registerBookAdminRoutes } from './books/admin-routes.js';
import { registerAssistantAdminRoutes } from './assistant/admin-routes.js';

const MAX_RESTORE = Number(process.env.SR_MAX_UPLOAD_BYTES) || 1.5e9;

/** Tiny in-memory failure counter (brute-force throttle). */
export function createRateLimiter({ max = 10, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map(); // key -> { n, first }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.first > windowMs) hits.delete(k);
  }, windowMs).unref();
  const live = (key) => {
    const v = hits.get(key);
    if (v && Date.now() - v.first > windowMs) {
      hits.delete(key);
      return null;
    }
    return v;
  };
  return {
    blocked: (key) => (live(key)?.n || 0) >= max,
    fail(key) {
      const v = live(key);
      if (v) v.n++;
      else hits.set(key, { n: 1, first: Date.now() });
    },
    reset: (key) => hits.delete(key),
  };
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
/** Error reply: `key` = French message with {placeholders} (translated client-side from errorKey + params). */
const fail = (res, status, key, extra = {}, params) => res.status(status).json(errorBody(key, params, extra));

/** Files of a table to put in a backup zip (state, uploads, docs, imported assets; optional backups). */
function tableZipItems(t, meta, { withBackups = false } = {}) {
  const ext = externalDocs(t);
  const under = (rel, dir) => rel === dir || rel.startsWith(dir + '/');
  const exclude = (rel) =>
    under(rel, 'foundry') || // uploaded Foundry world sources (re-uploadable, huge)
    (!withBackups && under(rel, 'backups')) ||
    (!!ext && under(rel, 'docs')) ||
    rel === 'table.json' || rel.endsWith('.tmp') || rel.endsWith('.part') || /^state\.corrupt-/.test(rel);
  const items = walkFiles(t.dir, { exclude }).map((f) => ({ name: f.rel, file: f.file }));
  if (ext) {
    // Legacy table on the GM's PC: docs live in ../Shadowrun — ship the markdown files as docs/.
    for (const f of walkFiles(ext, { exclude: (rel, d) => rel.startsWith('.') || (d.isDirectory() && rel.split('/').length > 1) })) {
      if (f.rel.endsWith('.md') && f.rel.split('/').length <= 2) items.push({ name: `docs/${f.rel}`, file: f.file });
    }
  }
  items.push({ name: 'table.json', data: JSON.stringify(meta, null, 2) });
  return items;
}
function externalDocs(t) {
  const d = t.docsDir();
  return path.resolve(d) === path.resolve(t.dir, 'docs') ? null : d;
}

export function registerAdminRoutes(app, api) {
  const { tables, openTable, closeTable, scheduleTableBroadcast, onlineUsers, issueToken } = api;
  const sessions = new Map(); // admin token -> expiresAt
  const TTL = 12 * 3600 * 1000;
  const tickets = new Map(); // one-time download id -> { kind, id, exp, opts }
  const limiter = createRateLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
  const sizeCache = new Map(); // dir -> { at, bytes }
  const sizeOf = (dir, ttl = 60000) => {
    const c = sizeCache.get(dir);
    if (c && Date.now() - c.at < ttl) return c.bytes;
    const bytes = dirSize(dir);
    sizeCache.set(dir, { at: Date.now(), bytes });
    return bytes;
  };

  function requireAdmin(req, res, next) {
    const tok = bearer(req);
    const exp = tok && sessions.get(tok);
    if (!exp || exp < Date.now()) {
      if (tok) sessions.delete(tok);
      return fail(res, 401, 'Session administrateur expirée', { code: 'admin-auth' });
    }
    sessions.set(tok, Date.now() + TTL);
    next();
  }
  const metaOr404 = (req, res) => {
    const m = getMeta(req.params.id);
    if (!m) fail(res, 404, 'Table introuvable');
    return m;
  };

  /** Backup zip of a table folder into deleted/ (before delete / replace). Returns the file name. */
  async function archiveToDeleted(meta, label) {
    fs.mkdirSync(DELETED_DIR, { recursive: true });
    const t = tables.get(meta.id);
    if (t && !t.error) t.store.flush();
    const fakeTable = t || { dir: path.join(TABLES_DIR, meta.id), docsDir: () => path.join(TABLES_DIR, meta.id, 'docs') };
    const name = `${meta.id}-${stamp()}-${label}.zip`;
    await writeZipFile(path.join(DELETED_DIR, name), tableZipItems(fakeTable, meta, { withBackups: true }));
    return name;
  }

  // ----- session -----
  app.post('/api/admin/login', (req, res) => {
    const key = `admin|${req.ip}`;
    if (limiter.blocked(key)) return fail(res, 429, 'Trop de tentatives : réessaie dans quelques minutes');
    if (!verifyPassword(String(req.body?.password || ''), getRegistry().adminPasswordHash)) {
      limiter.fail(key);
      return fail(res, 403, 'Mot de passe administrateur incorrect');
    }
    limiter.reset(key);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + TTL);
    res.json({ token });
  });
  app.post('/api/admin/logout', (req, res) => {
    sessions.delete(bearer(req));
    res.json({ ok: true });
  });
  app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ ok: true }));
  app.post('/api/admin/password', requireAdmin, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), getRegistry().adminPasswordHash)) return fail(res, 403, 'Mot de passe actuel incorrect');
    if (String(next || '').length < 8) return fail(res, 400, 'Le nouveau mot de passe doit faire au moins 8 caractères');
    setAdminPassword(String(next));
    res.json({ ok: true });
  });

  // ----- list -----
  app.get('/api/admin/tables', requireAdmin, (req, res) => {
    const list = listMetas().map((m) => {
      const t = tables.get(m.id);
      const st = t && !t.error ? t.state : null;
      const lastTs = st?.log?.length ? st.log[st.log.length - 1].ts : null;
      return {
        ...m,
        url: `/t/${m.slug}/`,
        status: m.archived ? 'archived' : t?.error ? 'broken' : 'open',
        error: t?.error || null,
        players: st ? Object.keys(st.users || {}).length : null,
        pcs: st ? Object.values(st.actors || {}).filter((a) => a.type === 'pc' && !a.retired).length : null,
        online: t ? onlineUsers(t).length : 0,
        lastActivity: lastTs,
        sizeBytes: sizeOf(path.join(TABLES_DIR, m.id)),
      };
    });
    let disk = null;
    try {
      const s = fs.statfsSync(RUNTIME_DIR);
      disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {}
    let deleted = [];
    try {
      deleted = fs.readdirSync(DELETED_DIR).filter((f) => f.endsWith('.zip')).sort().reverse().slice(0, 30)
        .map((f) => ({ file: f, size: fs.statSync(path.join(DELETED_DIR, f)).size }));
    } catch {}
    res.json({
      tables: list,
      packs: Object.entries(PACKS).map(([id, p]) => ({ id, label: p.label })),
      langs: LANGS,
      disk,
      sharedAssetsBytes: sizeOf(GLOBAL_ASSETS_DIR, 10 * 60000),
      deleted,
      maxUploadBytes: MAX_RESTORE,
    });
  });

  // ----- create -----
  app.post('/api/admin/tables', requireAdmin, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return fail(res, 400, 'Donne un nom à la table');
    const id = String(b.slug || '').trim().toLowerCase() || slugify(name);
    const bad = slugError(id);
    if (bad) return fail(res, 400, bad);
    if (getMeta(id) || fs.existsSync(path.join(TABLES_DIR, id))) return fail(res, 409, 'L’identifiant « {id} » est déjà utilisé', {}, { id });
    const pack = PACKS[b.pack] ? b.pack : null;
    if (!pack) return fail(res, 400, 'Contenu de départ inconnu');
    const lang = LANGS.includes(b.lang) ? b.lang : 'fr';
    const pw = String(b.gmPassword || '');
    if (pw.length < 6) return fail(res, 400, 'Le mot de passe MJ doit faire au moins 6 caractères');
    let meta;
    try {
      meta = createTableFiles({ id, name, pack, lang, gmPassword: pw.slice(0, 80), hidden: !!b.hidden });
    } catch (err) {
      return fail(res, 500, 'Création impossible : {error}', {}, { error: err.message });
    }
    const t = openTable(meta);
    if (t.error) return fail(res, 500, 'Table créée mais illisible : {error}', {}, { error: t.error });
    console.log(`[admin] table créée : ${id} (${pack}, ${lang})`);
    res.json({ table: { ...meta, url: `/t/${id}/` } });
  });

  // ----- update: name, hidden, lang, archived -----
  app.patch('/api/admin/tables/:id', requireAdmin, (req, res) => {
    const m = metaOr404(req, res);
    if (!m) return;
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 80);
      if (!name) return fail(res, 400, 'Le nom ne peut pas être vide');
      patch.name = name;
    }
    if (b.hidden !== undefined) patch.hidden = !!b.hidden;
    if (b.lang !== undefined) {
      if (!LANGS.includes(b.lang)) return fail(res, 400, 'Langue inconnue');
      patch.lang = b.lang;
    }
    if (b.archived !== undefined) patch.archived = !!b.archived;
    const wasArchived = m.archived;
    updateMeta(m.id, patch);
    const t = tables.get(m.id);
    if (t && !t.error && (patch.name || patch.lang)) {
      if (patch.name) t.state.config.campaignName = patch.name;
      if (patch.lang) t.state.config.lang = patch.lang;
      t.store.saveSoon();
      scheduleTableBroadcast(t);
    } else if (!t && (patch.name || patch.lang)) {
      // Closed (archived) table: write the change into its state file, or reopening would bring the old name back.
      const file = path.join(TABLES_DIR, m.id, 'state.json');
      const st = readJson(file, null);
      if (st && typeof st === 'object') {
        st.config = st.config || {};
        if (patch.name) st.config.campaignName = patch.name;
        if (patch.lang) st.config.lang = patch.lang;
        try {
          writeJsonAtomic(file, st);
        } catch (err) {
          console.error('[admin] cannot update a closed table state', err);
        }
      }
    }
    if (patch.archived === true && !wasArchived) closeTable(m.id, { reason: 'archived' });
    if (patch.archived === false && wasArchived) {
      const ot = openTable(getMeta(m.id));
      if (ot.error) return fail(res, 500, 'Table désarchivée mais illisible : {error}', {}, { error: ot.error });
      if (patch.name || patch.lang) {
        if (patch.name) ot.state.config.campaignName = patch.name;
        if (patch.lang) ot.state.config.lang = patch.lang;
        ot.store.saveSoon();
      }
    }
    res.json({ table: getMeta(m.id) });
  });

  app.post('/api/admin/tables/:id/gm-password', requireAdmin, (req, res) => {
    const m = metaOr404(req, res);
    if (!m) return;
    const t = tables.get(m.id);
    if (!t || t.error) return fail(res, 409, 'Table archivée ou indisponible : désarchive-la d’abord');
    const pw = String(req.body?.password || '');
    if (pw.length < 6) return fail(res, 400, 'Le mot de passe MJ doit faire au moins 6 caractères');
    t.state.config.gmPassword = pw.slice(0, 80);
    // Log out existing GM sessions of that table (the old password may have leaked).
    for (const [tok, uid] of Object.entries(t.state.sessions || {})) if (uid === 'gm') delete t.state.sessions[tok];
    t.store.saveNow();
    scheduleTableBroadcast(t);
    res.json({ ok: true });
  });

  /** Open a table as its GM from the admin page (the client stores the token for that table). */
  app.post('/api/admin/tables/:id/gm-session', requireAdmin, (req, res) => {
    const m = metaOr404(req, res);
    if (!m) return;
    const t = tables.get(m.id);
    if (!t || t.error) return fail(res, 409, 'Table archivée ou indisponible');
    res.json({ token: issueToken(t, 'gm'), slug: m.slug, url: `/t/${m.slug}/` });
  });

  // ----- downloads (one-time tickets so a plain link can download without a token in the URL) -----
  app.post('/api/admin/tables/:id/download', requireAdmin, (req, res) => {
    const m = metaOr404(req, res);
    if (!m) return;
    const id = crypto.randomBytes(16).toString('hex');
    tickets.set(id, { kind: 'table', id: m.id, exp: Date.now() + 120000, withBackups: !!req.body?.withBackups });
    res.json({ url: `/api/admin/download/${id}` });
  });
  app.post('/api/admin/deleted/:file/download', requireAdmin, (req, res) => {
    const file = path.basename(String(req.params.file || ''));
    if (!file.endsWith('.zip') || !fs.existsSync(path.join(DELETED_DIR, file))) return fail(res, 404, 'Archive introuvable');
    const id = crypto.randomBytes(16).toString('hex');
    tickets.set(id, { kind: 'deleted', file, exp: Date.now() + 120000 });
    res.json({ url: `/api/admin/download/${id}` });
  });
  app.get('/api/admin/download/:ticket', async (req, res) => {
    const tk = tickets.get(req.params.ticket);
    tickets.delete(req.params.ticket);
    if (!tk || tk.exp < Date.now()) return fail(res, 404, 'Lien de téléchargement expiré : recommence depuis la page Administration');
    if (tk.kind === 'deleted') {
      res.setHeader('Content-Type', 'application/zip');
      return res.download(path.join(DELETED_DIR, tk.file), tk.file);
    }
    const meta = getMeta(tk.id);
    if (!meta) return fail(res, 404, 'Table introuvable');
    const t = tables.get(meta.id);
    if (t && !t.error) t.store.flush();
    const target = t || { dir: path.join(TABLES_DIR, meta.id), docsDir: () => path.join(TABLES_DIR, meta.id, 'docs') };
    const items = tableZipItems(target, meta, { withBackups: tk.withBackups });
    const fileName = `table-${meta.id}-${stamp().slice(0, 19)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeZip(res, items);
      res.end();
    } catch (err) {
      console.error('[admin] backup zip failed', err);
      if (!res.headersSent) fail(res, err.status || 500, err.message);
      else res.destroy(err);
    }
  });

  // ----- delete (a backup zip is kept in deleted/) -----
  app.delete('/api/admin/tables/:id', requireAdmin, async (req, res) => {
    const m = metaOr404(req, res);
    if (!m) return;
    if (String(req.body?.confirm || '') !== m.id) return fail(res, 400, 'Confirmation manquante : tape l’identifiant « {id} »', {}, { id: m.id });
    let backup;
    try {
      backup = await archiveToDeleted(m, 'deleted');
    } catch (err) {
      console.error('[admin] delete backup failed', err);
      return fail(res, 500, 'Sauvegarde préalable impossible, suppression annulée : {error}', {}, { error: err.message });
    }
    closeTable(m.id, { reason: 'deleted' });
    try {
      fs.rmSync(path.join(TABLES_DIR, m.id), { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.error('[admin] rm failed', err);
    }
    removeMeta(m.id);
    console.log(`[admin] table supprimée : ${m.id} (archive : deleted/${backup})`);
    res.json({ ok: true, backup });
  });

  // ----- restore: body = table backup zip (or a state JSON export); ?slug=&name=&replace=1 -----
  app.post('/api/admin/restore', requireAdmin, async (req, res) => {
    const rnd = crypto.randomBytes(6).toString('hex');
    const upload = path.join(TMP_DIR, `restore-${rnd}.upload`);
    const staging = path.join(TMP_DIR, `restore-${rnd}`);
    const cleanup = () => {
      for (const p of [upload, staging]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {}
      }
    };
    try {
      await receiveToFile(req, upload, { maxBytes: MAX_RESTORE });
      const head = Buffer.alloc(4);
      const fd = fs.openSync(upload, 'r');
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      fs.mkdirSync(staging, { recursive: true });
      if (head[0] === 0x50 && head[1] === 0x4b) {
        const entries = listZip(upload);
        const states = entries
          .map((e) => safeEntryPath(e.name))
          .filter((p) => p && (p === 'state.json' || p.endsWith('/state.json')) && !p.split('/').includes('backups'))
          .sort((a, b) => a.split('/').length - b.split('/').length);
        if (!states.length) throw new ZipError('Cette archive ne contient pas de state.json : ce n’est pas une sauvegarde de table');
        const prefix = states[0].slice(0, -'state.json'.length);
        await extractZip(upload, staging, { map: (rel) => (rel.startsWith(prefix) && !rel.slice(prefix.length).startsWith('foundry/') ? rel.slice(prefix.length) : null) });
      } else {
        if (fs.statSync(upload).size > 300e6) throw new ZipError('Fichier JSON trop volumineux');
        const json = readJson(upload, null);
        if (!json) throw new ZipError('Fichier non reconnu : envoie le .zip d’une table ou un export JSON de partie');
        writeJsonAtomic(path.join(staging, 'state.json'), json);
      }
      const state = readJson(path.join(staging, 'state.json'), null);
      if (!state || typeof state !== 'object' || !state.actors || typeof state.actors !== 'object') throw new ZipError('state.json invalide (pas de personnages)');
      const tj = readJson(path.join(staging, 'table.json'), {}) || {};
      const id = String(req.query.slug || tj.id || slugify(req.query.name || state.config?.campaignName || '')).toLowerCase();
      const bad = slugError(id);
      if (bad) throw new ZipError(bad);
      const existing = getMeta(id);
      let replaced = null;
      if (existing || fs.existsSync(path.join(TABLES_DIR, id))) {
        if (req.query.replace !== '1') return cleanup(), fail(res, 409, 'Une table « {id} » existe déjà : choisis un autre identifiant ou coche « Remplacer »', { code: 'exists' }, { id });
        if (existing) replaced = await archiveToDeleted(existing, 'replaced');
        closeTable(id, { reason: 'replaced' });
        fs.rmSync(path.join(TABLES_DIR, id), { recursive: true, force: true, maxRetries: 3 });
        if (existing) removeMeta(id);
      }
      fs.rmSync(path.join(staging, 'table.json'), { force: true });
      fs.renameSync(staging, path.join(TABLES_DIR, id));
      const otherLegacy = listMetas().some((m) => m.legacy && m.id !== id);
      const name = String(req.query.name || tj.name || state.config?.campaignName || id).trim().slice(0, 80);
      const meta = addMeta({
        id, name, pack: PACKS[tj.pack] ? tj.pack : 'vierge', lang: LANGS.includes(tj.lang) ? tj.lang : state.config?.lang === 'en' ? 'en' : 'fr',
        createdAt: Number(tj.createdAt) || Date.now(), hidden: !!tj.hidden, archived: false,
        ...(tj.legacy && !otherLegacy ? { legacy: true, docsDir: '../Shadowrun' } : {}),
      });
      if (state.config && name !== state.config.campaignName) {
        state.config.campaignName = name;
        writeJsonAtomic(path.join(TABLES_DIR, id, 'state.json'), state);
      }
      const t = openTable(meta);
      cleanup();
      if (t.error) return fail(res, 500, 'Table restaurée mais illisible : {error}', {}, { error: t.error });
      console.log(`[admin] table restaurée : ${id}${replaced ? ` (ancienne version : deleted/${replaced})` : ''}`);
      res.json({ table: { ...meta, url: `/t/${id}/` }, replaced });
    } catch (err) {
      cleanup();
      if (!(err instanceof ZipError)) console.error('[admin] restore failed', err);
      if (!res.headersSent) fail(res, err.status || 500, err.message || 'Restauration impossible');
    }
  });

  // ----- rulebook library (server-wide PDFs, see ARCHITECTURE.md « Rulebooks ») -----
  registerBookAdminRoutes(app, { requireAdmin, fail, listMetas });
  // ----- GM assistant (server-wide settings, see ARCHITECTURE.md « Assistant MJ ») -----
  registerAssistantAdminRoutes(app, { requireAdmin, fail, listMetas });
}
