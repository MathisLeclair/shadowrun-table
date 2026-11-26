// Foundry VTT import: reads the GM's Foundry world (LevelDB, from a temp copy) and syncs PCs, NPC templates,
// scenes (→ maps with segment walls), journals (→ markdown docs) and playlists (→ audio tracks) into the app.
// Slice owned: state.foundry = { worldPath, lastScan, lastImport } (GM only).
// See ARCHITECTURE.md « Foundry import ». Converters live in server/lib/foundry/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { currentTable, currentTableId, currentDocsDir, TMP_DIR } from '../store.js';
import { readWorldSync, detectWorldPath, listWorlds, worldFingerprint, checkWorld, COLLECTIONS, dataRootOf } from '../lib/foundry/world.js';
import { buildBundle, scanBundle, applyImport } from '../lib/foundry/importer.js';
import { createAssets, formatBytes } from '../lib/foundry/assets.js';
import { uploadedWorlds, isInsideUploads, installWorldZip, installDataZip, uploadsSize, removeUploads } from '../lib/foundry/upload.js';
import { ZipError, receiveToFile } from '../lib/zip.js';
import { errorBody } from '../lib/i18n.js';
import { i18nError, errorParam, plural, bytesParam } from '../lib/foundry/messages.js';

const tk = (s) => s; // marks French keys returned as values (tools/i18n-check.js)
/** HTTP error body for an error that may carry an i18n key (Foundry/zip errors). */
const errBody = (err, fallback) => (err?.i18nKey ? errorBody(err.i18nKey, err.i18nParams) : err?.message ? { error: err.message } : errorBody(fallback));

const combat = await import('./30-combat.js').catch(() => null);
const sanitizeTemplate = typeof combat?.sanitizeTemplate === 'function' ? (t) => combat.sanitizeTemplate(t, { id: t.id }) : null;

// Journals go to the table's docs folder (…/foundry), unless SR_FOUNDRY_DOCS_DIR overrides it (tests, offline tool).
const docsOut = () => (process.env.SR_FOUNDRY_DOCS_DIR ? path.resolve(process.env.SR_FOUNDRY_DOCS_DIR) : path.join(currentDocsDir(), 'foundry'));
// On a shared server (SR_FOUNDRY_LOCAL_PATHS=0) a GM may only read worlds uploaded to their own table.
const localPathsAllowed = () => process.env.SR_FOUNDRY_LOCAL_PATHS !== '0';
const MAX_UPLOAD = Number(process.env.SR_MAX_UPLOAD_BYTES) || 1.5e9;

let helpers = null; // routes() helpers: addLog, scheduleBroadcast, saveSoon, emitTo (for the async audio copy)
let cache = null; // { key, world } — keyed by world path + fingerprint, so tables never share a wrong world
const audioJobs = new Map(); // tableId -> { total, done, bytes } while audio files are being copied
const uploadBusy = new Set(); // tableIds with a zip being received/extracted

function ensureSlice(state) {
  if (!state.foundry || typeof state.foundry !== 'object') state.foundry = {};
  const f = state.foundry;
  if (typeof f.worldPath !== 'string') f.worldPath = '';
  return f;
}

/** Read the world, reusing the last read while Foundry has not written anything since. */
function loadWorld(worldPath) {
  checkWorld(worldPath);
  const key = `${path.resolve(worldPath).toLowerCase()}|${worldFingerprint(worldPath, COLLECTIONS)}`;
  if (cache?.key === key) return cache.world;
  const world = readWorldSync(worldPath);
  if (world.meta?.system && world.meta.system !== 'shadowrun5e') throw i18nError({ t: 'Ce monde utilise le système « {system} », pas shadowrun5e', params: { system: world.meta.system } });
  cache = { key, world };
  return world;
}

function resolveWorldPath(state, payloadPath) {
  const table = currentTable();
  const uploaded = table ? uploadedWorlds(table) : [];
  const p = String(payloadPath || '').trim() || state.foundry?.worldPath || uploaded[0]?.path || (localPathsAllowed() ? detectWorldPath() : '');
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Error message when this table may not read that folder (another table's upload, or any local path on a shared server). */
function worldPathError(worldPath) {
  const table = currentTable();
  if (!worldPath) return tk('Aucun monde Foundry : téléverse le dossier du monde (.zip) ci-dessus');
  if (table && isInsideUploads(table, worldPath)) return null;
  if (!localPathsAllowed()) return tk('Sur ce serveur, seuls les mondes téléversés pour cette table sont lisibles');
  const tablesRoot = path.resolve(table ? path.dirname(table.dir) : '.').toLowerCase();
  if (path.resolve(worldPath).toLowerCase().startsWith(tablesRoot + path.sep)) return tk('Ce dossier appartient à une autre table');
  return null;
}

function bundleFor(ctx, worldPath) {
  const denied = worldPathError(worldPath);
  if (denied) ctx.fail(denied);
  let world;
  try {
    world = loadWorld(worldPath);
  } catch (err) {
    ctx.fail(err.i18nKey || err.message, err.i18nParams);
  }
  const table = currentTable();
  const assets = createAssets({ dataRoot: world.dataRoot || dataRootOf(worldPath), ...(table ? { outDir: table.assetsDir, urlBase: table.assetsUrl } : {}) });
  return buildBundle(world, { now: ctx.now, assets });
}

function startAudioCopy(ctx, bundle, urls) {
  if (!urls.size) return null;
  const tid = ctx.tableId || currentTableId();
  const { files, bytes } = bundle.assets.totals({ kinds: ['audio'], urls });
  if (audioJobs.has(tid)) return { files, bytes, size: formatBytes(bytes), queued: false, busy: true };
  audioJobs.set(tid, { total: files, done: 0, bytes });
  const job = () => audioJobs.get(tid);
  // The copy outlives the action: it keeps the table scope (AsyncLocalStorage) and uses ctx for this table's events.
  const emit = (ev, data) => ctx.emitTo('gm', ev, data);
  emit('foundry/audio', { ...job(), running: true });
  bundle.assets
    .copyAsync({ kinds: ['audio'], urls }, (p) => {
      audioJobs.set(tid, { ...job(), done: p.done });
      if (p.done === p.total || p.done % 3 === 0) emit('foundry/audio', { ...job(), running: p.done < p.total });
    })
    .then((r) => {
      const copied = plural(r.copied, { t: 'zero::{n} fichier copié' }, { t: '{n} fichier copié' }, { t: '{n} fichiers copiés' });
      const params = { copied, skipped: r.skipped, size: bytesParam(r.bytes), errors: r.errors.length };
      const i18n = r.errors.length
        ? { key: tk('Import Foundry : audio prêt — {copied}, {skipped} déjà à jour ({size}), {errors} erreur(s)'), params }
        : { key: tk('Import Foundry : audio prêt — {copied}, {skipped} déjà à jour ({size})'), params };
      ctx.log({ kind: 'system', gmOnly: true, author: 'Foundry', i18n });
      emit('foundry/audio', { ...job(), done: job().total, running: false, errors: r.errors.slice(0, 10) });
      helpers?.saveSoon?.();
      helpers?.scheduleBroadcast?.();
    })
    .catch((err) => emit('foundry/audio', { running: false, error: err.message }))
    .finally(() => {
      audioJobs.delete(tid);
    });
  return { files, bytes, size: formatBytes(bytes), queued: true };
}

function normSelect(sel) {
  const s = sel && typeof sel === 'object' ? sel : {};
  const ids = (v) => (v === 'all' || v === true ? 'all' : Array.isArray(v) ? v.map(String).slice(0, 500) : []);
  return { pcs: ids(s.pcs), npcs: ids(s.npcs), scenes: ids(s.scenes), journals: !!s.journals, playlists: !!s.playlists };
}

export default {
  name: 'foundry',

  init(state) {
    ensureSlice(state);
  },

  actions: {
    // → { detected, worlds: [{ id, title, path, system }] }
    'foundry/worlds': {
      role: 'gm',
      handler(ctx) {
        const table = currentTable();
        const uploaded = table ? uploadedWorlds(table) : [];
        return { detected: resolveWorldPath(ctx.state, ''), worlds: [...uploaded, ...(localPathsAllowed() ? listWorlds() : [])], localPaths: localPathsAllowed() };
      },
    },

    // { worldPath? } → summary of what can be imported (PCs with diffs, NPCs, scenes, journals, playlists).
    'foundry/scan': {
      role: 'gm',
      handler(ctx, { worldPath } = {}) {
        const wp = resolveWorldPath(ctx.state, worldPath);
        const bundle = bundleFor(ctx, wp);
        // Scene thumbnails are small: copy them now so the panel can show them.
        bundle.assets.copySync({ kinds: ['thumb'] });
        const f = ensureSlice(ctx.state);
        f.worldPath = wp;
        f.lastScan = { ts: ctx.now, worldId: bundle.worldId, fingerprint: bundle.fingerprint };
        const docsDir = docsOut();
        return { ...scanBundle(ctx.state, bundle, { docsDir }), docsDir, lastImport: f.lastImport || null, audioJob: audioJobs.get(ctx.tableId) || null };
      },
    },

    // { worldPath?, select: { pcs, npcs, scenes: [foundryIds]|'all', journals, playlists }, pcMode: 'replace'|'merge', assignPlayers? }
    'foundry/import': {
      role: 'gm',
      handler(ctx, { worldPath, select, pcMode = 'merge', assignPlayers = false } = {}) {
        const wp = resolveWorldPath(ctx.state, worldPath);
        const bundle = bundleFor(ctx, wp);
        const sel = normSelect(select);
        let res;
        try {
          res = applyImport(ctx.state, bundle, { select: sel, pcMode, now: ctx.now, docsDir: docsOut(), sanitizeTemplate, assignPlayers: !!assignPlayers });
        } catch (err) {
          console.error('[foundry] import', err);
          ctx.fail('Import interrompu : {error}', { error: errorParam(err) });
        }
        const copied = bundle.assets.copySync({ kinds: ['img', 'scene', 'thumb', 'journal'], urls: res.urls.sync });
        const audio = startAudioCopy(ctx, bundle, res.urls.audio);
        const f = ensureSlice(ctx.state);
        f.worldPath = wp;
        f.lastImport = {
          ts: ctx.now,
          worldId: bundle.worldId,
          worldTitle: bundle.worldTitle,
          fingerprint: bundle.fingerprint,
          pcMode: pcMode === 'merge' ? 'merge' : 'replace',
          counts: { pcs: res.summary.pcs.length, npcs: res.summary.npcs.length, maps: res.summary.maps.length, journals: res.summary.journals.length, tracks: res.summary.tracks },
        };
        ctx.log({ kind: 'system', gmOnly: true, author: 'Foundry', i18n: res.logI18n });
        return {
          ...res.summary,
          assets: { copied: copied.copied, skipped: copied.skipped, bytes: copied.bytes, size: formatBytes(copied.bytes), errors: copied.errors.slice(0, 10) },
          audio,
          missing: [...new Set(bundle.assets.missing)].slice(0, 20),
          docsDir: docsOut(),
          text: res.logText,
          textI18n: res.logI18n,
        };
      },
    },
  },

  // Players never see the import bookkeeping.
  filter(view) {
    delete view.foundry;
  },

  routes(app, h) {
    helpers = h;
    // Current audio copy progress (the panel also listens to the 'foundry/audio' event).
    app.get('/api/foundry/status', h.requireGM, (req, res) => res.json({ audioJob: audioJobs.get(currentTableId()) || null, cached: !!cache }));

    // Worlds uploaded as zips for this table (VPS: the server can't read the GM's PC).
    app.get('/api/foundry/uploads', h.requireGM, (req, res) => {
      const table = currentTable();
      res.json({ worlds: uploadedWorlds(table), bytes: uploadsSize(table), maxBytes: MAX_UPLOAD, localPaths: localPathsAllowed(), busy: uploadBusy.has(table.id) });
    });

    // POST /api/foundry/upload?kind=world|data — body = the zip, streamed to disk (never buffered), then extracted.
    app.post('/api/foundry/upload', h.requireGM, async (req, res) => {
      const table = currentTable();
      const kind = req.query.kind === 'data' ? 'data' : 'world';
      if (uploadBusy.has(table.id)) return res.status(409).json(errorBody('Un envoi est déjà en cours pour cette table'));
      uploadBusy.add(table.id);
      const tmp = path.join(TMP_DIR, `foundry-${table.id}-${crypto.randomBytes(4).toString('hex')}.zip`);
      try {
        await receiveToFile(req, tmp, { maxBytes: MAX_UPLOAD });
        if (kind === 'data') {
          const r = await installDataZip(table, tmp);
          h.addLog({ kind: 'system', gmOnly: true, author: 'Foundry', i18n: { key: 'Fichiers Foundry ajoutés sur le serveur : {n} fichier(s), {size}.', params: { n: r.files, size: bytesParam(r.bytes) } } });
          h.saveSoon();
          h.scheduleBroadcast();
          return res.json({ kind, ...r, size: formatBytes(r.bytes) });
        }
        const world = await installWorldZip(table, tmp);
        cache = null;
        ensureSlice(table.state).worldPath = world.path;
        h.addLog({ kind: 'system', gmOnly: true, author: 'Foundry', i18n: { key: 'Monde Foundry téléversé : {world}. Lance « Analyser » pour l’importer.', params: { world: world.title } } });
        h.saveSoon();
        h.scheduleBroadcast();
        res.json({ kind, world });
      } catch (err) {
        if (!(err instanceof ZipError)) console.error('[foundry] upload', err);
        if (!res.headersSent) res.status(err.status || 500).json(errBody(err, tk('Envoi impossible')));
      } finally {
        uploadBusy.delete(table.id);
        fs.rm(tmp, { force: true }, () => {});
      }
    });

    // Remove every uploaded world / asset of this table (imported maps & portraits stay: they were copied).
    app.delete('/api/foundry/uploads', h.requireGM, (req, res) => {
      const table = currentTable();
      if (uploadBusy.has(table.id)) return res.status(409).json(errorBody('Un envoi est en cours pour cette table'));
      try {
        removeUploads(table);
      } catch (err) {
        return res.status(500).json(errorBody('Suppression impossible : {error}', { error: errorParam(err) }));
      }
      const f = ensureSlice(table.state);
      if (isInsideUploads(table, f.worldPath)) f.worldPath = '';
      cache = null;
      h.saveSoon();
      h.scheduleBroadcast();
      res.json({ ok: true });
    });
  },
};
