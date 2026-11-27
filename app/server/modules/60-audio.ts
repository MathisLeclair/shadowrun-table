// Audio: synced ambience + music channels, sound effects broadcast, GM scenes (one-click presets).
// Built-in tracks are procedurally synthesized in the browser (client/modules/audio/*); the GM can add
// uploaded files (source 'url'). See ARCHITECTURE.md > Audio.
import { builtinTracks, SFX_IDS, TRACK_KINDS } from '../../client/modules/audio/catalog.ts';
import type { ActionContext, AudioChannel, AudioScene, AudioState, AudioTrack, ServerEvents, ServerModule, TableState, TrackKind } from '../../shared/types.ts';

type ChannelName = 'ambient' | 'music';
/** `state.audio` after ensureSlice(): scenes and autoScenes always exist on the server. */
type AudioSlice = AudioState & { scenes: AudioScene[]; autoScenes: boolean };

const CHANNELS: ChannelName[] = ['ambient', 'music'];
const DEFAULTS = { master: 0.8, ambient: 0.5, music: 0.4 };
const MAX_TRACKS = 400;
const MAX_SCENES = 200;

const str = (v: unknown, max = 80): string => String(v ?? '').trim().slice(0, max);
const vol = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

function ensureSlice(state: TableState): AudioSlice {
  const a = (state.audio = state.audio && typeof state.audio === 'object' ? state.audio : ({} as AudioState)) as AudioSlice;
  a.master = vol(a.master, DEFAULTS.master);
  for (const ch of CHANNELS) {
    const c = (a[ch] = a[ch] && typeof a[ch] === 'object' ? a[ch] : ({} as AudioChannel));
    c.trackId = typeof c.trackId === 'string' ? c.trackId : null;
    c.volume = vol(c.volume, DEFAULTS[ch]);
    c.startedAt = Number(c.startedAt) || 0;
  }
  a.tracks = Array.isArray(a.tracks) ? a.tracks.filter((t) => t && typeof t.id === 'string') : [];
  a.scenes = Array.isArray(a.scenes) ? a.scenes.filter((s) => s && typeof s.id === 'string') : [];
  if (typeof a.autoScenes !== 'boolean') a.autoScenes = true;
  return a;
}

function findTrack(audio: AudioState, id: unknown): AudioTrack | null {
  if (!id) return null;
  return audio.tracks.find((t) => t.id === id) || null;
}

/** Track usable on a looping channel: by id, or a built-in preset id ('rain' -> 'amb-rain'). */
function resolveLoopTrack(ctx: ActionContext, audio: AudioState, id: unknown, channel: ChannelName): AudioTrack | null {
  if (id === null || id === undefined || id === '') return null;
  const key = String(id);
  let t = findTrack(audio, key);
  if (!t) {
    const prefer: TrackKind[] = channel === 'music' ? ['music', 'ambient'] : ['ambient', 'music'];
    for (const kind of prefer) {
      t = audio.tracks.find((x) => x.source === 'synth' && x.kind === kind && x.preset === key) ?? null;
      if (t) break;
    }
  }
  if (!t) return ctx.fail('Track not found');
  if (t.kind === 'sfx') ctx.fail('A sound effect cannot loop');
  return t;
}

function setChannel(ctx: ActionContext, audio: AudioState, channel: ChannelName, id: unknown): string | null {
  const t = resolveLoopTrack(ctx, audio, id, channel);
  const c = audio[channel];
  const next = t ? t.id : null;
  if (c.trackId !== next) {
    c.trackId = next;
    c.startedAt = next ? ctx.now : 0;
  }
  return next;
}

function cleanUrl(ctx: ActionContext, url: unknown): string {
  const u = str(url, 500);
  if (!/^\/uploads\/[^\s?#]+$/.test(u) && !/^https?:\/\/[^\s]+$/i.test(u)) ctx.fail('Invalid file address');
  return u;
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => str(t, 30)).filter(Boolean))].slice(0, 12);
}

/** Scene channel value: 'keep' (don't touch), null (silence) or a track id. */
function sceneValue(ctx: ActionContext, audio: AudioState, v: unknown, channel: ChannelName): string | null {
  if (v === 'keep') return 'keep';
  if (v === null || v === undefined || v === '') return null;
  return resolveLoopTrack(ctx, audio, v, channel)!.id;
}

function findScene(ctx: ActionContext, audio: AudioSlice, id: unknown): AudioScene {
  const s = audio.scenes.find((x) => x.id === id);
  if (!s) return ctx.fail('Scene not found');
  return s;
}

/** audio.json of a content pack: extra uploaded tracks and scenes (merged by id). */
interface AudioSeed {
  tracks?: Array<Partial<AudioTrack>>;
  scenes?: Array<AudioScene & { replaces?: Partial<Record<ChannelName, string | null>> }>;
}

interface TrackIdPayload {
  trackId?: string | null;
}
interface VolumePayload {
  channel?: string;
  volume?: number;
}
interface SfxPayload {
  id?: string;
  volume?: number;
}
interface AddTrackPayload {
  name?: string;
  kind?: TrackKind;
  url?: string;
  tags?: string[];
}
interface UpdateTrackPayload {
  id?: string;
  name?: string;
  kind?: TrackKind;
  tags?: string[];
  volume?: number;
}
interface IdPayload {
  id?: string;
}
/** ambient/music: track id | null (silence) | 'keep'; ambientVolume/musicVolume: null removes. */
interface SaveScenePayload {
  id?: string;
  name?: string;
  ambient?: string | null;
  music?: string | null;
  mapId?: string | null;
  ambientVolume?: number | null;
  musicVolume?: number | null;
}
interface ScenePayload {
  sceneId?: string;
}
interface OptionsPayload {
  autoScenes?: boolean;
}

const mod: ServerModule = {
  name: 'audio',

  init(state, { readSeed }) {
    const a = ensureSlice(state);
    // Built-in synth tracks: add missing ones, keep GM renames/tags, enforce kind/source/preset.
    const builtins = builtinTracks() as AudioTrack[];
    const builtinIds = new Set(builtins.map((b) => b.id));
    for (const b of builtins) {
      const cur = a.tracks.find((t) => t.id === b.id);
      if (!cur) a.tracks.push(b);
      else Object.assign(cur, { kind: b.kind, source: 'synth', preset: b.preset, name: cur.name || b.name, tags: Array.isArray(cur.tags) ? cur.tags : b.tags });
    }
    // Drop synth tracks whose preset disappeared from the catalog.
    a.tracks = a.tracks.filter((t) => t.source !== 'synth' || builtinIds.has(t.id));
    // Seeds (extra tracks, scenes) merged by id, never overwriting.
    const seed = readSeed<AudioSeed>('audio.json', {}) || {};
    for (const t of Array.isArray(seed.tracks) ? seed.tracks : []) {
      if (!t?.id || a.tracks.some((x) => x.id === t.id)) continue;
      if (!TRACK_KINDS.includes(t.kind as TrackKind) || t.source !== 'url' || !t.url) continue;
      const track: AudioTrack = { id: t.id, name: str(t.name) || t.id, kind: t.kind as TrackKind, source: 'url', url: String(t.url), tags: cleanTags(t.tags) };
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
      handler(ctx: ActionContext, { trackId = null }: TrackIdPayload = {}) {
        return setChannel(ctx, ensureSlice(ctx.state), 'ambient', trackId);
      },
    },
    'audio/setMusic': {
      handler(ctx: ActionContext, { trackId = null }: TrackIdPayload = {}) {
        return setChannel(ctx, ensureSlice(ctx.state), 'music', trackId);
      },
    },
    // { channel: 'master'|'ambient'|'music', volume: 0..1 }
    'audio/setVolume': {
      handler(ctx: ActionContext, { channel, volume }: VolumePayload = {}) {
        const a = ensureSlice(ctx.state);
        const v = vol(volume, NaN);
        if (Number.isNaN(v)) ctx.fail('Invalid volume');
        if (channel === 'master') a.master = v;
        else if (CHANNELS.includes(channel as ChannelName)) a[channel as ChannelName].volume = v;
        else ctx.fail('Unknown channel');
        return v;
      },
    },
    // { id, volume? } — built-in sfx id or an uploaded sfx track id. Plays on every connected device.
    'audio/sfx': {
      handler(ctx: ActionContext, { id, volume }: SfxPayload = {}) {
        const a = ensureSlice(ctx.state);
        const key = str(id, 120);
        const payload: ServerEvents['sfx'] & { url?: string } = { id: key, volume: vol(volume, 1) };
        if (!SFX_IDS.includes(key)) {
          const t = findTrack(a, key);
          if (!t || t.kind !== 'sfx') return ctx.fail('Unknown sound effect');
          if (t.source === 'url') payload.url = t.url;
          else if (t.preset) payload.id = t.preset;
        }
        ctx.emitTo('all', 'sfx', payload);
        return payload.id;
      },
    },
    // { name, kind, url, tags? } — after upload() on the client.
    'audio/addTrack': {
      handler(ctx: ActionContext, { name, kind, url, tags }: AddTrackPayload = {}) {
        const a = ensureSlice(ctx.state);
        if (!kind || !TRACK_KINDS.includes(kind)) ctx.fail('Invalid track type');
        if (a.tracks.length >= MAX_TRACKS) ctx.fail('Too many tracks');
        const track: AudioTrack = { id: ctx.uid('trk'), name: str(name) || ctx.t('Untitled'), kind: kind as TrackKind, source: 'url', url: cleanUrl(ctx, url), tags: cleanTags(tags) };
        a.tracks.push(track);
        return track.id;
      },
    },
    // { id, name?, kind? (uploads only), tags?, volume? (0..2, level trim) }
    'audio/updateTrack': {
      handler(ctx: ActionContext, { id, name, kind, tags, volume }: UpdateTrackPayload = {}) {
        const a = ensureSlice(ctx.state);
        const t = findTrack(a, id);
        if (!t) return ctx.fail('Track not found');
        if (name !== undefined) t.name = str(name) || t.name;
        if (tags !== undefined) t.tags = cleanTags(tags);
        if (volume !== undefined) {
          const n = Number(volume);
          if (!Number.isFinite(n)) ctx.fail('Invalid level');
          t.volume = Math.max(0, Math.min(2, n));
        }
        if (kind !== undefined && kind !== t.kind) {
          if (t.source !== 'url') ctx.fail('A built-in track’s type cannot change');
          if (!TRACK_KINDS.includes(kind)) ctx.fail('Invalid track type');
          t.kind = kind;
          if (kind === 'sfx') for (const ch of CHANNELS) if (a[ch].trackId === t.id) a[ch].trackId = null;
        }
        return t.id;
      },
    },
    // { id } — uploaded tracks only (the file stays in uploads/).
    'audio/removeTrack': {
      handler(ctx: ActionContext, { id }: IdPayload = {}) {
        const a = ensureSlice(ctx.state);
        const t = findTrack(a, id);
        if (!t) return ctx.fail('Track not found');
        if (t.source !== 'url') ctx.fail('Built-in tracks cannot be deleted');
        a.tracks = a.tracks.filter((x) => x.id !== id);
        for (const ch of CHANNELS) if (a[ch].trackId === id) a[ch].trackId = null;
        for (const s of a.scenes) for (const ch of CHANNELS) if (s[ch] === id) s[ch] = null;
      },
    },
    // { id? (update), name, ambient?, music?, mapId?, ambientVolume?, musicVolume? }
    // ambient/music: track id | null (silence) | 'keep' (leave unchanged). Omitted on create = current.
    'audio/saveScene': {
      handler(ctx: ActionContext, p: SaveScenePayload = {}) {
        const a = ensureSlice(ctx.state);
        let scene: AudioScene | null | undefined = p.id ? a.scenes.find((s) => s.id === p.id) : null;
        if (p.id && !scene) ctx.fail('Scene not found');
        if (!scene) {
          if (a.scenes.length >= MAX_SCENES) ctx.fail('Too many scenes');
          scene = { id: ctx.uid('scn'), name: '', ambient: a.ambient.trackId, music: a.music.trackId };
          a.scenes.push(scene);
          if (!str(p.name)) p = { ...p, name: ctx.t('New scene') }; // stored in the table language
        }
        if (p.name !== undefined) scene.name = str(p.name) || scene.name || ctx.t('Scene');
        for (const ch of CHANNELS) if (p[ch] !== undefined) scene[ch] = sceneValue(ctx, a, p[ch], ch);
        if (p.mapId !== undefined) {
          if (p.mapId) scene.mapId = str(p.mapId, 120);
          else delete scene.mapId;
        }
        for (const k of ['ambientVolume', 'musicVolume'] as const) {
          if (p[k] === undefined) continue;
          if (p[k] === null) delete scene[k];
          else scene[k] = vol(p[k], 0.5);
        }
        return scene.id;
      },
    },
    // { sceneId }
    'audio/applyScene': {
      handler(ctx: ActionContext, { sceneId }: ScenePayload = {}) {
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
      handler(ctx: ActionContext, { sceneId }: ScenePayload = {}) {
        const a = ensureSlice(ctx.state);
        findScene(ctx, a, sceneId);
        a.scenes = a.scenes.filter((s) => s.id !== sceneId);
      },
    },
    // Silence everything (loops + ringing effects on every device).
    'audio/stopAll': {
      handler(ctx: ActionContext) {
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
      handler(ctx: ActionContext, { autoScenes }: OptionsPayload = {}) {
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

export default mod;
