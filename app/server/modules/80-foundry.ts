// Foundry VTT import: reads the GM's Foundry world (LevelDB, from a temp copy) and syncs PCs, NPC templates,
// scenes (→ maps with segment walls), journals (→ markdown docs) and playlists (→ audio tracks) into the app.
// Slice owned: state.foundry = { worldPath, lastScan, lastImport } (GM only).
// See ARCHITECTURE.md « Foundry import ». Converters live in server/lib/foundry/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { currentTable, currentTableId, currentDocsDir, TMP_DIR } from '../store.ts';
import { readWorldSync, detectWorldPath, listWorlds, worldFingerprint, checkWorld, COLLECTIONS, dataRootOf, type FoundryWorld } from '../lib/foundry/world.ts';
import { buildBundle, scanBundle, applyImport, type Bundle as FoundryBundle } from '../lib/foundry/importer.ts';
import { createAssets, formatBytes } from '../lib/foundry/assets.ts';
import { uploadedWorlds, isInsideUploads, installWorldZip, installDataZip, uploadsSize, removeUploads } from '../lib/foundry/upload.ts';
import { ZipError, receiveToFile } from '../lib/zip.ts';
import { errorBody } from '../lib/i18n.ts';
import { i18nError, errorParam, plural, bytesParam } from '../lib/foundry/messages.ts';
import type { ActionContext, FoundryState, GameView, I18nParams, RouteHelpers, ServerEvents, ServerModule, TableState, Template } from '../../shared/types.ts';

// No Express types in the app yet (@types/express arrives with the server-core conversion): loose local aliases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Express app / request / response
type HttpApp = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = any;

/** An error thrown by the Foundry readers / zip code: may carry an i18n key and an HTTP status. */
type FoundryError = Error & { i18nKey?: string; i18nParams?: I18nParams; status?: number };
/** Progress of the async audio copy of one table. */
interface AudioJob {
  total: number;
  done: number;
  bytes: number;
}

const tk = (s: string): string => s; // marks French keys returned as values (tools/i18n-check.ts)
/** HTTP error body for an error that may carry an i18n key (Foundry/zip errors). */
const errBody = (err: FoundryError | undefined, fallback: string) => (err?.i18nKey ? errorBody(err.i18nKey, err.i18nParams) : err?.message ? { error: err.message } : errorBody(fallback));

const combat = await import('./30-combat.ts').catch(() => null);
const sanitizeTemplate = typeof combat?.sanitizeTemplate === 'function' ? (t: Template) => combat.sanitizeTemplate(t, { id: t.id }) : undefined;

// Journals go to the table's docs folder (…/foundry), unless SR_FOUNDRY_DOCS_DIR overrides it (tests, offline tool).
const docsOut = () => (process.env.SR_FOUNDRY_DOCS_DIR ? path.resolve(process.env.SR_FOUNDRY_DOCS_DIR) : path.join(currentDocsDir(), 'foundry'));
// On a shared server (SR_FOUNDRY_LOCAL_PATHS=0) a GM may only read worlds uploaded to their own table.
const localPathsAllowed = () => process.env.SR_FOUNDRY_LOCAL_PATHS !== '0';
const MAX_UPLOAD = Number(process.env.SR_MAX_UPLOAD_BYTES) || 1.5e9;

let helpers: RouteHelpers | null = null; // routes() helpers: addLog, scheduleBroadcast, saveSoon, emitTo (for the async audio copy)
let cache: { key: string; world: FoundryWorld } | null = null; // { key, world } — keyed by world path + fingerprint, so tables never share a wrong world
const audioJobs = new Map<string | null, AudioJob>(); // tableId -> { total, done, bytes } while audio files are being copied
const uploadBusy = new Set<string>(); // tableIds with a zip being received/extracted

function ensureSlice(state: TableState): FoundryState {
  if (!state.foundry || typeof state.foundry !== 'object') state.foundry = {} as FoundryState;
  const f = state.foundry;
  if (typeof f.worldPath !== 'string') f.worldPath = '';
  return f;
}

/** Read the world, reusing the last read while Foundry has not written anything since. */
function loadWorld(worldPath: string): FoundryWorld {
  checkWorld(worldPath);
  const key = `${path.resolve(worldPath).toLowerCase()}|${worldFingerprint(worldPath, COLLECTIONS)}`;
  if (cache?.key === key) return cache.world;
  const world = readWorldSync(worldPath);
  if (world.meta?.system && world.meta.system !== 'shadowrun5e') throw i18nError({ t: 'This world uses the “{system}” system, not shadowrun5e', params: { system: world.meta.system } });
  cache = { key, world };
  return world;
}

function resolveWorldPath(state: TableState, payloadPath: unknown): string {
  const table = currentTable();
  const uploaded = table ? uploadedWorlds(table) : [];
  const p = String(payloadPath || '').trim() || state.foundry?.worldPath || uploaded[0]?.path || (localPathsAllowed() ? detectWorldPath() : '');
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Error message when this table may not read that folder (another table's upload, or any local path on a shared server). */
function worldPathError(worldPath: string): string | null {
  const table = currentTable();
  if (!worldPath) return tk('No Foundry world: upload the world folder (.zip) above');
  if (table && isInsideUploads(table, worldPath)) return null;
  if (!localPathsAllowed()) return tk('On this server, only worlds uploaded for this table can be read');
  const tablesRoot = path.resolve(table ? path.dirname(table.dir) : '.').toLowerCase();
  if (path.resolve(worldPath).toLowerCase().startsWith(tablesRoot + path.sep)) return tk('This folder belongs to another table');
  return null;
}

function bundleFor(ctx: ActionContext, worldPath: string): FoundryBundle {
  const denied = worldPathError(worldPath);
  if (denied) ctx.fail(denied);
  let world: FoundryWorld;
  try {
    world = loadWorld(worldPath);
  } catch (e) {
    const err = e as FoundryError;
    ctx.fail(err.i18nKey || err.message, err.i18nParams);
  }
  const table = currentTable();
  const assets = createAssets({ dataRoot: world.dataRoot || dataRootOf(worldPath), ...(table ? { outDir: table.assetsDir, urlBase: table.assetsUrl } : {}) });
  return buildBundle(world, { now: ctx.now, assets, lang: ctx.lang });
}

function startAudioCopy(ctx: ActionContext, bundle: FoundryBundle, urls: Set<string | undefined>) {
  if (!urls.size) return null;
  const tid = ctx.tableId || currentTableId();
  const { files, bytes } = bundle.assets.totals({ kinds: ['audio'], urls });
  if (audioJobs.has(tid)) return { files, bytes, size: formatBytes(bytes), queued: false, busy: true };
  audioJobs.set(tid, { total: files, done: 0, bytes });
  const job = () => audioJobs.get(tid)!;
  // The copy outlives the action: it keeps the table scope (AsyncLocalStorage) and uses ctx for this table's events.
  const emit = (ev: 'foundry/audio', data: ServerEvents['foundry/audio']) => ctx.emitTo('gm', ev, data);
  emit('foundry/audio', { ...job(), running: true });
  bundle.assets
    .copyAsync({ kinds: ['audio'], urls }, (p: { done: number; total: number }) => {
      audioJobs.set(tid, { ...job(), done: p.done });
      if (p.done === p.total || p.done % 3 === 0) emit('foundry/audio', { ...job(), running: p.done < p.total });
    })
    .then((r: { copied: number; skipped: number; bytes: number; errors: unknown[] }) => {
      const copied = plural(r.copied, { t: 'zero::{n} files copied' }, { t: '{n} file copied' }, { t: '{n} files copied' });
      const params = { copied, skipped: r.skipped, size: bytesParam(r.bytes), errors: r.errors.length };
      const i18n = r.errors.length
        ? { key: tk('Foundry import: audio ready — {copied}, {skipped} already up to date ({size}), {errors} error(s)'), params }
        : { key: tk('Foundry import: audio ready — {copied}, {skipped} already up to date ({size})'), params };
      ctx.log({ kind: 'system', gmOnly: true, author: 'Foundry', i18n });
      emit('foundry/audio', { ...job(), done: job().total, running: false, errors: r.errors.slice(0, 10) });
      helpers?.saveSoon?.();
      helpers?.scheduleBroadcast?.();
    })
    .catch((err: Error) => emit('foundry/audio', { running: false, error: err.message }))
    .finally(() => {
      audioJobs.delete(tid);
    });
  return { files, bytes, size: formatBytes(bytes), queued: true };
}

function normSelect(sel: unknown) {
  const s = (sel && typeof sel === 'object' ? sel : {}) as Record<string, unknown>;
  const ids = (v: unknown): 'all' | string[] => (v === 'all' || v === true ? 'all' : Array.isArray(v) ? v.map(String).slice(0, 500) : []);
  return { pcs: ids(s.pcs), npcs: ids(s.npcs), scenes: ids(s.scenes), journals: !!s.journals, playlists: !!s.playlists };
}

interface ScanPayload {
  worldPath?: string;
}
interface ImportPayload {
  worldPath?: string;
  /** { pcs, npcs, scenes: [foundryIds] | 'all', journals, playlists } */
  select?: unknown;
  pcMode?: 'replace' | 'merge';
  assignPlayers?: boolean;
}

const mod: ServerModule<HttpApp> = {
  name: 'foundry',

  init(state) {
    ensureSlice(state);
  },

  actions: {
    // → { detected, worlds: [{ id, title, path, system }] }
    'foundry/worlds': {
      role: 'gm',
      handler(ctx: ActionContext) {
        const table = currentTable();
        const uploaded = table ? uploadedWorlds(table) : [];
        return { detected: resolveWorldPath(ctx.state, ''), worlds: [...uploaded, ...(localPathsAllowed() ? listWorlds() : [])], localPaths: localPathsAllowed() };
      },
    },

    // { worldPath? } → summary of what can be imported (PCs with diffs, NPCs, scenes, journals, playlists).
    'foundry/scan': {
      role: 'gm',
      handler(ctx: ActionContext, { worldPath }: ScanPayload = {}) {
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
      handler(ctx: ActionContext, { worldPath, select, pcMode = 'merge', assignPlayers = false }: ImportPayload = {}) {
        const wp = resolveWorldPath(ctx.state, worldPath);
        const bundle = bundleFor(ctx, wp);
        const sel = normSelect(select);
        let res: ReturnType<typeof applyImport>;
        try {
          res = applyImport(ctx.state, bundle, { select: sel, pcMode, now: ctx.now, docsDir: docsOut(), sanitizeTemplate, assignPlayers: !!assignPlayers });
        } catch (err) {
          console.error('[foundry] import', err);
          ctx.fail('Import aborted: {error}', { error: errorParam(err) });
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
    delete (view as Partial<GameView>).foundry;
  },

  routes(app, h) {
    helpers = h;
    // Current audio copy progress (the panel also listens to the 'foundry/audio' event).
    app.get('/api/foundry/status', h.requireGM, (req: Req, res: Res) => res.json({ audioJob: audioJobs.get(currentTableId()) || null, cached: !!cache }));

    // Worlds uploaded as zips for this table (VPS: the server can't read the GM's PC).
    app.get('/api/foundry/uploads', h.requireGM, (req: Req, res: Res) => {
      const table = currentTable()!;
      res.json({ worlds: uploadedWorlds(table), bytes: uploadsSize(table), maxBytes: MAX_UPLOAD, localPaths: localPathsAllowed(), busy: uploadBusy.has(table.id) });
    });

    // POST /api/foundry/upload?kind=world|data — body = the zip, streamed to disk (never buffered), then extracted.
    app.post('/api/foundry/upload', h.requireGM, async (req: Req, res: Res) => {
      const table = currentTable()!;
      const kind = req.query.kind === 'data' ? 'data' : 'world';
      if (uploadBusy.has(table.id)) return res.status(409).json(errorBody('An upload is already in progress for this table'));
      uploadBusy.add(table.id);
      const tmp = path.join(TMP_DIR, `foundry-${table.id}-${crypto.randomBytes(4).toString('hex')}.zip`);
      try {
        await receiveToFile(req, tmp, { maxBytes: MAX_UPLOAD });
        if (kind === 'data') {
          const r = await installDataZip(table, tmp);
          h.addLog({ kind: 'system', gmOnly: true, author: 'Foundry', i18n: { key: 'Foundry files added on the server: {n} file(s), {size}.', params: { n: r.files, size: bytesParam(r.bytes) } } });
          h.saveSoon();
          h.scheduleBroadcast();
          return res.json({ kind, ...r, size: formatBytes(r.bytes) });
        }
        const world = await installWorldZip(table, tmp);
        cache = null;
        ensureSlice(table.state).worldPath = world.path;
        h.addLog({ kind: 'system', gmOnly: true, author: 'Foundry', i18n: { key: 'Foundry world uploaded: {world}. Click “Scan” to import it.', params: { world: world.title } } });
        h.saveSoon();
        h.scheduleBroadcast();
        res.json({ kind, world });
      } catch (e) {
        const err = e as FoundryError;
        if (!(err instanceof ZipError)) console.error('[foundry] upload', err);
        if (!res.headersSent) res.status(err.status || 500).json(errBody(err, tk('Upload failed')));
      } finally {
        uploadBusy.delete(table.id);
        fs.rm(tmp, { force: true }, () => {});
      }
    });

    // Remove every uploaded world / asset of this table (imported maps & portraits stay: they were copied).
    app.delete('/api/foundry/uploads', h.requireGM, (req: Req, res: Res) => {
      const table = currentTable()!;
      if (uploadBusy.has(table.id)) return res.status(409).json(errorBody('An upload is in progress for this table'));
      try {
        removeUploads(table);
      } catch (err) {
        return res.status(500).json(errorBody('Could not delete: {error}', { error: errorParam(err) }));
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

export default mod;
