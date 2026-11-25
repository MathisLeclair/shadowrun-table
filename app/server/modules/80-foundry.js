// Foundry VTT import: reads the GM's Foundry world (LevelDB, from a temp copy) and syncs PCs, NPC templates,
// scenes (→ maps with segment walls), journals (→ markdown docs) and playlists (→ audio tracks) into the app.
// Slice owned: state.foundry = { worldPath, lastScan, lastImport } (GM only).
// See ARCHITECTURE.md « Foundry import ». Converters live in server/lib/foundry/.
import path from 'node:path';
import { DOCS_DIR } from '../store.js';
import { readWorldSync, detectWorldPath, listWorlds, worldFingerprint, checkWorld, COLLECTIONS, dataRootOf } from '../lib/foundry/world.js';
import { buildBundle, scanBundle, applyImport } from '../lib/foundry/importer.js';
import { createAssets, formatBytes } from '../lib/foundry/assets.js';

const combat = await import('./30-combat.js').catch(() => null);
const sanitizeTemplate = typeof combat?.sanitizeTemplate === 'function' ? (t) => combat.sanitizeTemplate(t, { id: t.id }) : null;

const DOCS_OUT = process.env.SR_FOUNDRY_DOCS_DIR ? path.resolve(process.env.SR_FOUNDRY_DOCS_DIR) : path.join(DOCS_DIR, 'foundry');

let helpers = null; // routes() helpers: addLog, scheduleBroadcast, saveSoon, emitTo (for the async audio copy)
let cache = null; // { key, world }
let audioJob = null; // { total, done, bytes } while audio files are being copied

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
  if (world.meta?.system && world.meta.system !== 'shadowrun5e') throw new Error(`Ce monde utilise le système « ${world.meta.system} », pas shadowrun5e`);
  cache = { key, world };
  return world;
}

function resolveWorldPath(state, payloadPath) {
  const p = String(payloadPath || '').trim() || state.foundry?.worldPath || detectWorldPath();
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function bundleFor(ctx, worldPath) {
  let world;
  try {
    world = loadWorld(worldPath);
  } catch (err) {
    ctx.fail(err.message);
  }
  const assets = createAssets({ dataRoot: world.dataRoot || dataRootOf(worldPath) });
  return buildBundle(world, { now: ctx.now, assets });
}

function startAudioCopy(bundle, urls) {
  if (!urls.size) return null;
  const { files, bytes } = bundle.assets.totals({ kinds: ['audio'], urls });
  if (audioJob) return { files, bytes, size: formatBytes(bytes), queued: false, busy: true };
  audioJob = { total: files, done: 0, bytes };
  const emit = (ev, data) => helpers?.emitTo?.('gm', ev, data);
  emit('foundry/audio', { ...audioJob, running: true });
  bundle.assets
    .copyAsync({ kinds: ['audio'], urls }, (p) => {
      audioJob = { ...audioJob, done: p.done };
      if (p.done === p.total || p.done % 3 === 0) emit('foundry/audio', { ...audioJob, running: p.done < p.total });
    })
    .then((r) => {
      const text = `Import Foundry : audio prêt — ${r.copied} fichier${r.copied > 1 ? 's' : ''} copié${r.copied > 1 ? 's' : ''}, ${r.skipped} déjà à jour (${formatBytes(r.bytes)})${r.errors.length ? `, ${r.errors.length} erreur(s)` : ''}`;
      helpers?.addLog?.({ kind: 'system', gmOnly: true, author: 'Foundry', text });
      emit('foundry/audio', { ...audioJob, done: audioJob.total, running: false, errors: r.errors.slice(0, 10) });
      helpers?.saveSoon?.();
      helpers?.scheduleBroadcast?.();
    })
    .catch((err) => emit('foundry/audio', { running: false, error: err.message }))
    .finally(() => {
      audioJob = null;
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
        return { detected: resolveWorldPath(ctx.state, ''), worlds: listWorlds() };
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
        return { ...scanBundle(ctx.state, bundle, { docsDir: DOCS_OUT }), docsDir: DOCS_OUT, lastImport: f.lastImport || null, audioJob };
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
          res = applyImport(ctx.state, bundle, { select: sel, pcMode, now: ctx.now, docsDir: DOCS_OUT, sanitizeTemplate, assignPlayers: !!assignPlayers });
        } catch (err) {
          console.error('[foundry] import', err);
          ctx.fail(`Import interrompu : ${err.message}`);
        }
        const copied = bundle.assets.copySync({ kinds: ['img', 'scene', 'thumb', 'journal'], urls: res.urls.sync });
        const audio = startAudioCopy(bundle, res.urls.audio);
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
        ctx.log({ kind: 'system', gmOnly: true, author: 'Foundry', text: res.logText });
        return {
          ...res.summary,
          assets: { copied: copied.copied, skipped: copied.skipped, size: formatBytes(copied.bytes), errors: copied.errors.slice(0, 10) },
          audio,
          missing: [...new Set(bundle.assets.missing)].slice(0, 20),
          docsDir: DOCS_OUT,
          text: res.logText,
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
    app.get('/api/foundry/status', h.requireGM, (req, res) => res.json({ audioJob, cached: !!cache }));
  },
};
