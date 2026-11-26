// Audio: synced ambience + music channels, sound effects broadcast, GM scenes (one-click presets).
// Built-in tracks are procedurally synthesized in the browser (client/modules/audio/*); the GM can add
// uploaded files (source 'url'). See ARCHITECTURE.md > Audio.
import { builtinTracks, SFX_IDS, TRACK_KINDS } from '../../client/modules/audio/catalog.js';

const CHANNELS = ['ambient', 'music'];
const DEFAULTS = { master: 0.8, ambient: 0.5, music: 0.4 };
const MAX_TRACKS = 400;
const MAX_SCENES = 200;

const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const vol = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

function ensureSlice(state) {
  const a = (state.audio = state.audio && typeof state.audio === 'object' ? state.audio : {});
  a.master = vol(a.master, DEFAULTS.master);
  for (const ch of CHANNELS) {
    const c = (a[ch] = a[ch] && typeof a[ch] === 'object' ? a[ch] : {});
    c.trackId = typeof c.trackId === 'string' ? c.trackId : null;
    c.volume = vol(c.volume, DEFAULTS[ch]);
    c.startedAt = Number(c.startedAt) || 0;
  }
  a.tracks = Array.isArray(a.tracks) ? a.tracks.filter((t) => t && typeof t.id === 'string') : [];
  a.scenes = Array.isArray(a.scenes) ? a.scenes.filter((s) => s && typeof s.id === 'string') : [];
  if (typeof a.autoScenes !== 'boolean') a.autoScenes = true;
  return a;
}

function findTrack(audio, id) {
  if (!id) return null;
  return audio.tracks.find((t) => t.id === id) || null;
}

/** Track usable on a looping channel: by id, or a built-in preset id ('rain' -> 'amb-rain'). */
function resolveLoopTrack(ctx, audio, id, channel) {
  if (id === null || id === undefined || id === '') return null;
  const key = String(id);
  let t = findTrack(audio, key);
  if (!t) {
    const prefer = channel === 'music' ? ['music', 'ambient'] : ['ambient', 'music'];
    for (const kind of prefer) {
      t = audio.tracks.find((x) => x.source === 'synth' && x.kind === kind && x.preset === key);
      if (t) break;
    }
  }
  if (!t) ctx.fail('Piste introuvable');
  if (t.kind === 'sfx') ctx.fail('Un bruitage ne peut pas tourner en boucle');
  return t;
}

function setChannel(ctx, audio, channel, id) {
  const t = resolveLoopTrack(ctx, audio, id, channel);
  const c = audio[channel];
  const next = t ? t.id : null;
  if (c.trackId !== next) {
    c.trackId = next;
    c.startedAt = next ? ctx.now : 0;
  }
  return next;
}

function cleanUrl(ctx, url) {
  const u = str(url, 500);
  if (!/^\/uploads\/[^\s?#]+$/.test(u) && !/^https?:\/\/[^\s]+$/i.test(u)) ctx.fail('Adresse de fichier invalide');
  return u;
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => str(t, 30)).filter(Boolean))].slice(0, 12);
}

/** Scene channel value: 'keep' (don't touch), null (silence) or a track id. */
function sceneValue(ctx, audio, v, channel) {
  if (v === 'keep') return 'keep';
  if (v === null || v === undefined || v === '') return null;
  return resolveLoopTrack(ctx, audio, v, channel).id;
}

function findScene(ctx, audio, id) {
  const s = audio.scenes.find((x) => x.id === id);
  if (!s) ctx.fail('Scène introuvable');
  return s;
}

export default {
  name: 'audio',

  init(state, { readSeed }) {
    const a = ensureSlice(state);
    // Built-in synth tracks: add missing ones, keep GM renames/tags, enforce kind/source/preset.
    const builtins = builtinTracks();
    const builtinIds = new Set(builtins.map((b) => b.id));
    for (const b of builtins) {
      const cur = a.tracks.find((t) => t.id === b.id);
      if (!cur) a.tracks.push(b);
      else Object.assign(cur, { kind: b.kind, source: 'synth', preset: b.preset, name: cur.name || b.name, tags: Array.isArray(cur.tags) ? cur.tags : b.tags });
    }
    // Drop synth tracks whose preset disappeared from the catalog.
    a.tracks = a.tracks.filter((t) => t.source !== 'synth' || builtinIds.has(t.id));
    // Seeds (extra tracks, scenes) merged by id, never overwriting.
    const seed = readSeed('audio.json', {}) || {};
    for (const t of Array.isArray(seed.tracks) ? seed.tracks : []) {
      if (!t?.id || a.tracks.some((x) => x.id === t.id)) continue;
      if (!TRACK_KINDS.includes(t.kind) || t.source !== 'url' || !t.url) continue;
      const track = { id: t.id, name: str(t.name) || t.id, kind: t.kind, source: 'url', url: String(t.url), tags: cleanTags(t.tags) };
      if (Number.isFinite(Number(t.volume))) track.volume = Math.max(0, Math.min(2, Number(t.volume)));
      if (typeof t.loop === 'boolean') track.loop = t.loop;
      if (t.foundry) track.foundry = t.foundry;
      if (t.credit) track.credit = str(t.credit, 120);
      a.tracks.push(track);
    }
    for (const s of Array.isArray(seed.scenes) ? seed.scenes : []) {
      if (!s?.id) continue;
      const { replaces, ...scene } = s;
      const cur = a.scenes.find((x) => x.id === s.id);
      if (!cur) {
        a.scenes.push({ ...scene, name: str(s.name) || s.id });
        continue;
      }
      // Seed upgrade: `replaces: { music: oldValue }` swaps a channel the GM never changed.
      for (const ch of CHANNELS) {
        if (replaces && ch in replaces && cur[ch] === replaces[ch] && findTrack(a, scene[ch])) cur[ch] = scene[ch];
      }
    }
    // Channels pointing at removed tracks fall silent.
    for (const ch of CHANNELS) {
      const t = findTrack(a, a[ch].trackId);
      if (!t || t.kind === 'sfx') a[ch].trackId = null;
    }
  },

  actions: {
    // { trackId | null } — also accepts a built-in preset id ('rain').
    'audio/setAmbient': {
      handler(ctx, { trackId = null } = {}) {
        return setChannel(ctx, ensureSlice(ctx.state), 'ambient', trackId);
      },
    },
    'audio/setMusic': {
      handler(ctx, { trackId = null } = {}) {
        return setChannel(ctx, ensureSlice(ctx.state), 'music', trackId);
      },
    },
    // { channel: 'master'|'ambient'|'music', volume: 0..1 }
    'audio/setVolume': {
      handler(ctx, { channel, volume } = {}) {
        const a = ensureSlice(ctx.state);
        const v = vol(volume, NaN);
        if (Number.isNaN(v)) ctx.fail('Volume invalide');
        if (channel === 'master') a.master = v;
        else if (CHANNELS.includes(channel)) a[channel].volume = v;
        else ctx.fail('Canal inconnu');
        return v;
      },
    },
    // { id, volume? } — built-in sfx id or an uploaded sfx track id. Plays on every connected device.
    'audio/sfx': {
      handler(ctx, { id, volume } = {}) {
        const a = ensureSlice(ctx.state);
        const key = str(id, 120);
        const payload = { id: key, volume: vol(volume, 1) };
        if (!SFX_IDS.includes(key)) {
          const t = findTrack(a, key);
          if (!t || t.kind !== 'sfx') ctx.fail('Bruitage inconnu');
          if (t.source === 'url') payload.url = t.url;
          else if (t.preset) payload.id = t.preset;
        }
        ctx.emitTo('all', 'sfx', payload);
        return payload.id;
      },
    },
    // { name, kind, url, tags? } — after upload() on the client.
    'audio/addTrack': {
      handler(ctx, { name, kind, url, tags } = {}) {
        const a = ensureSlice(ctx.state);
        if (!TRACK_KINDS.includes(kind)) ctx.fail('Type de piste invalide');
        if (a.tracks.length >= MAX_TRACKS) ctx.fail('Trop de pistes');
        const track = { id: ctx.uid('trk'), name: str(name) || 'Sans titre', kind, source: 'url', url: cleanUrl(ctx, url), tags: cleanTags(tags) };
        a.tracks.push(track);
        return track.id;
      },
    },
    // { id, name?, kind? (uploads only), tags?, volume? (0..2, level trim) }
    'audio/updateTrack': {
      handler(ctx, { id, name, kind, tags, volume } = {}) {
        const a = ensureSlice(ctx.state);
        const t = findTrack(a, id);
        if (!t) ctx.fail('Piste introuvable');
        if (name !== undefined) t.name = str(name) || t.name;
        if (tags !== undefined) t.tags = cleanTags(tags);
        if (volume !== undefined) {
          const n = Number(volume);
          if (!Number.isFinite(n)) ctx.fail('Niveau invalide');
          t.volume = Math.max(0, Math.min(2, n));
        }
        if (kind !== undefined && kind !== t.kind) {
          if (t.source !== 'url') ctx.fail('Le type d’une piste intégrée ne peut pas changer');
          if (!TRACK_KINDS.includes(kind)) ctx.fail('Type de piste invalide');
          t.kind = kind;
          if (kind === 'sfx') for (const ch of CHANNELS) if (a[ch].trackId === t.id) a[ch].trackId = null;
        }
        return t.id;
      },
    },
    // { id } — uploaded tracks only (the file stays in uploads/).
    'audio/removeTrack': {
      handler(ctx, { id } = {}) {
        const a = ensureSlice(ctx.state);
        const t = findTrack(a, id);
        if (!t) ctx.fail('Piste introuvable');
        if (t.source !== 'url') ctx.fail('Les pistes intégrées ne peuvent pas être supprimées');
        a.tracks = a.tracks.filter((x) => x.id !== id);
        for (const ch of CHANNELS) if (a[ch].trackId === id) a[ch].trackId = null;
        for (const s of a.scenes) for (const ch of CHANNELS) if (s[ch] === id) s[ch] = null;
      },
    },
    // { id? (update), name, ambient?, music?, mapId?, ambientVolume?, musicVolume? }
    // ambient/music: track id | null (silence) | 'keep' (leave unchanged). Omitted on create = current.
    'audio/saveScene': {
      handler(ctx, p = {}) {
        const a = ensureSlice(ctx.state);
        let scene = p.id ? a.scenes.find((s) => s.id === p.id) : null;
        if (p.id && !scene) ctx.fail('Scène introuvable');
        if (!scene) {
          if (a.scenes.length >= MAX_SCENES) ctx.fail('Trop de scènes');
          scene = { id: ctx.uid('scn'), name: '', ambient: a.ambient.trackId, music: a.music.trackId };
          a.scenes.push(scene);
          if (!str(p.name)) p = { ...p, name: 'Nouvelle scène' };
        }
        if (p.name !== undefined) scene.name = str(p.name) || scene.name || 'Scène';
        for (const ch of CHANNELS) if (p[ch] !== undefined) scene[ch] = sceneValue(ctx, a, p[ch], ch);
        if (p.mapId !== undefined) {
          if (p.mapId) scene.mapId = str(p.mapId, 120);
          else delete scene.mapId;
        }
        for (const k of ['ambientVolume', 'musicVolume']) {
          if (p[k] === undefined) continue;
          if (p[k] === null) delete scene[k];
          else scene[k] = vol(p[k], 0.5);
        }
        return scene.id;
      },
    },
    // { sceneId }
    'audio/applyScene': {
      handler(ctx, { sceneId } = {}) {
        const a = ensureSlice(ctx.state);
        const s = findScene(ctx, a, sceneId);
        for (const ch of CHANNELS) {
          if (s[ch] === 'keep' || s[ch] === undefined) continue;
          const exists = s[ch] === null || findTrack(a, s[ch]);
          setChannel(ctx, a, ch, exists ? s[ch] : null);
        }
        if (Number.isFinite(s.ambientVolume)) a.ambient.volume = vol(s.ambientVolume, a.ambient.volume);
        if (Number.isFinite(s.musicVolume)) a.music.volume = vol(s.musicVolume, a.music.volume);
        return s.id;
      },
    },
    'audio/deleteScene': {
      handler(ctx, { sceneId } = {}) {
        const a = ensureSlice(ctx.state);
        findScene(ctx, a, sceneId);
        a.scenes = a.scenes.filter((s) => s.id !== sceneId);
      },
    },
    // Silence everything (loops + ringing effects on every device).
    'audio/stopAll': {
      handler(ctx) {
        const a = ensureSlice(ctx.state);
        for (const ch of CHANNELS) {
          a[ch].trackId = null;
          a[ch].startedAt = 0;
        }
        ctx.emitTo('all', 'audio-stop', {});
      },
    },
    // { autoScenes: bool } — apply the scene linked to a map when it becomes the active map (GM client).
    'audio/setOptions': {
      handler(ctx, { autoScenes } = {}) {
        const a = ensureSlice(ctx.state);
        if (autoScenes !== undefined) a.autoScenes = !!autoScenes;
      },
    },
  },

  // Players only get what their engine needs: volumes, the two playing tracks and uploaded sfx files.
  filter(view) {
    const a = view.audio;
    if (!a) return;
    const playing = new Set([a.ambient?.trackId, a.music?.trackId].filter(Boolean));
    view.audio = {
      master: a.master,
      ambient: a.ambient,
      music: a.music,
      tracks: (a.tracks || [])
        .filter((t) => playing.has(t.id) || (t.kind === 'sfx' && t.source === 'url'))
        .map(({ id, name, kind, source, preset, url, volume }) => ({ id, name, kind, source, preset, url, volume })),
    };
  },
};
