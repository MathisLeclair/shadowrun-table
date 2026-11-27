// Audio engine singleton: one AudioContext for the whole app.
//   graph: channel items -> ambient/music gains -> master (server volume) -> local (device volume, mute)
//          -> limiter -> speakers.   sfx -> sfx bus (+ shared reverb) -> master.   preview -> local.
// Everything here must fail soft: if Web Audio is missing or throws, the app keeps working silently.
import { useEffect, useState } from 'react';
import { toGain, localGain, cleanVolume, clamp, syncOffset } from './theory.ts';
import { impulse } from './synth.ts';
import { AMBIENCES } from './ambiences.ts';
import { MUSIC } from './music.ts';
import { SFX } from './sfx.ts';
import type { Handle } from './synth.ts';
import type { AudioChannel, AudioTrack } from '../../../shared/types.ts';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type ChannelName = 'ambient' | 'music';
interface AudioNodes {
  limiter: DynamicsCompressorNode;
  local: GainNode;
  master: GainNode;
  sfx: GainNode;
  sfxVerbIn: ConvolverNode;
  preview: GainNode;
  ambient: GainNode;
  music: GainNode;
}
interface ChannelSpec {
  track: AudioTrack;
  volume: number;
  startedAt: number;
}
interface PlayingTrack {
  key: string | null;
  handle: Handle | null;
  gain: GainNode | null;
  trackVolume: number;
}
interface SfxOutput {
  out: GainNode;
  verb: GainNode;
  release: (seconds: number) => void;
}
/** This device's audio state (useAudioState). */
export interface AudioUiState {
  supported: boolean;
  unlocked: boolean;
  local: number;
  muted: boolean;
  previewKey: string | null;
}
/** What syncAudio reads of game.audio (anything else is tolerated). */
export interface AudioSync {
  master?: unknown;
  ambient?: Partial<AudioChannel> | null;
  music?: Partial<AudioChannel> | null;
  tracks?: unknown;
}

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
const XFADE = 2;
const LS_VOL = 'sr.audio.volume';
const LS_MUTE = 'sr.audio.muted';

function lsGet(key: string, fallback: string | number): string | number {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

let ctx: AudioContext | null = null;
let nodes: AudioNodes | null = null; // { master, local, limiter, sfx, sfxVerb, preview, ambient, music }
const desired: { master: number; ambient: ChannelSpec | null; music: ChannelSpec | null } = { master: 0.8, ambient: null, music: null }; // channel spec: { track, volume, startedAt }
const playing: Record<ChannelName, PlayingTrack | null> = { ambient: null, music: null }; // { key, handle, gain, trackVolume }
let tracksById = new Map<string, AudioTrack>();
let preview: { key: string; handle: Handle; out: GainNode } | null = null; // { key, handle, out }
const activeSfx = new Set<SfxOutput>(); // per-call gain nodes, for stopAllSfx()
const lastSfx = new Map<string, number>(); // id -> timestamp (dedupe double emissions)
const bufferCache = new Map<string, Promise<AudioBuffer>>(); // url -> Promise<AudioBuffer>
const warned = new Set<string>();

const ui: AudioUiState = {
  supported: !!AC,
  unlocked: false,
  local: (() => {
    const n = Number(lsGet(LS_VOL, 0.8));
    return Number.isFinite(n) ? clamp(n, 0, 1) : 0.8;
  })(),
  muted: lsGet(LS_MUTE, '0') === '1',
  previewKey: null,
};
const listeners = new Set<(s: AudioUiState) => void>();
function notify(): void {
  ui.unlocked = !!ctx && ctx.state === 'running';
  const snap = { ...ui };
  for (const l of listeners) {
    try {
      l(snap);
    } catch {}
  }
}

function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[audio]', ...args);
}

/** Smoothly move a gain param (no clicks, interrupts any running ramp). */
function rampTo(param: AudioParam, value: number, seconds = 0.3): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(value, now, Math.max(0.01, seconds / 3));
  } catch {}
}

// ---------------------------------------------------------------------------
// Context & graph
// ---------------------------------------------------------------------------
function createContext(): AudioContext | null {
  if (ctx || !AC) return ctx;
  try {
    ctx = new AC();
  } catch (err) {
    warnOnce('ctx', 'AudioContext indisponible', err);
    ui.supported = false;
    notify();
    return null;
  }
  try {
    const c = ctx; // non-null from here on
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(c.destination);
    const local = c.createGain();
    local.gain.value = localGain(ui.local, ui.muted);
    local.connect(limiter);
    const master = c.createGain();
    master.gain.value = toGain(desired.master);
    master.connect(local);
    const mk = (dest: AudioNode): GainNode => {
      const g = c.createGain();
      g.gain.value = 0;
      g.connect(dest);
      return g;
    };
    const sfx = c.createGain();
    sfx.connect(master);
    const conv = c.createConvolver();
    conv.buffer = impulse(c, 1.8, 3);
    const sfxVerb = c.createGain();
    sfxVerb.gain.value = 0.6;
    conv.connect(sfxVerb);
    sfxVerb.connect(sfx);
    const preview = c.createGain();
    preview.connect(local);
    nodes = { limiter, local, master, sfx, sfxVerbIn: conv, preview, ambient: mk(master), music: mk(master) };
  } catch (err) {
    warnOnce('graph', 'graphe audio impossible', err);
    nodes = null;
  }
  const created = ctx;
  created.onstatechange = () => {
    notify();
    if (created.state === 'running') applyAll();
  };
  return ctx;
}

/** Create/resume the AudioContext. Must be called from a user gesture the first time. */
export function unlock(): void {
  if (!AC) return;
  try {
    if (!ctx) {
      createContext();
      // A context created after a past gesture may start "running" right away: no statechange then.
      if (ctx && (ctx as AudioContext).state === 'running') {
        notify();
        applyAll();
        return;
      }
    }
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
      ctx.resume().then(
        () => {
          notify();
          applyAll();
        },
        () => {}
      );
    }
  } catch (err) {
    warnOnce('resume', 'reprise audio impossible', err);
  }
}

function running(): boolean {
  return !!ctx && !!nodes && ctx.state === 'running';
}

// Unlock on the first interaction anywhere (autoplay policy). Listeners stay: iOS may suspend later.
if (typeof document !== 'undefined' && AC) {
  const onGesture = () => {
    if (!ctx || ctx.state !== 'running') unlock();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) document.addEventListener(ev, onGesture, { capture: true, passive: true });
}

// ---------------------------------------------------------------------------
// Track playback
// ---------------------------------------------------------------------------
function trackKey(track: AudioTrack | null | undefined): string | null {
  return track ? `${track.id}|${track.source === 'url' ? track.url : track.preset}` : null;
}

/** Loop an uploaded file through a media element (streams, no full decode). */
function playUrlLoop(url: string, dest: AudioNode, { startedAt = 0, fadeIn = XFADE }: { startedAt?: number; fadeIn?: number } = {}): Handle {
  const ac = ctx as AudioContext; // callers check ctx
  const el = new Audio();
  el.preload = 'auto';
  el.loop = true;
  el.src = url;
  const src = ac.createMediaElementSource(el);
  const g = ac.createGain();
  g.gain.value = 0;
  src.connect(g);
  g.connect(dest);
  const now = ac.currentTime;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(1, now + Math.max(0.02, fadeIn));
  let stopped = false;
  el.addEventListener(
    'loadedmetadata',
    () => {
      const off = syncOffset(startedAt, Date.now(), el.duration);
      if (off > 0.5) {
        try {
          el.currentTime = off;
        } catch {}
      }
    },
    { once: true }
  );
  el.addEventListener('error', () => warnOnce('url:' + url, 'fichier audio illisible :', url));
  el.play().catch((err: Error) => {
    if (!stopped) warnOnce('play:' + url, 'lecture impossible :', url, err?.message || err);
  });
  return {
    stop(fade = XFADE) {
      if (stopped) return;
      stopped = true;
      const t = ac.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + Math.max(0.03, fade));
      } catch {}
      setTimeout(() => {
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } catch {}
        try {
          src.disconnect();
          g.disconnect();
        } catch {}
      }, Math.max(0.03, fade) * 1000 + 150);
    },
  };
}

/** Start a looping track (synth preset or file) into `dest`. Returns a handle { stop(fade) } or null. */
function startTrack(track: AudioTrack | null | undefined, dest: AudioNode, { startedAt = 0, fadeIn = XFADE }: { startedAt?: number; fadeIn?: number } = {}): Handle | null {
  if (!track || !ctx) return null;
  try {
    if (track.source === 'url') {
      if (!track.url) return null;
      return playUrlLoop(track.url, dest, { startedAt, fadeIn });
    }
    const preset = track.preset as string; // undefined → no generator (warned below)
    const gen = (track.kind === 'music' ? MUSIC : AMBIENCES)[preset] || AMBIENCES[preset] || MUSIC[preset];
    if (!gen) {
      warnOnce('preset:' + track.preset, 'préréglage inconnu :', track.preset);
      return null;
    }
    return gen(ctx, dest, { fadeIn });
  } catch (err) {
    warnOnce('start:' + track.id, 'impossible de lancer', track.id, err);
    return null;
  }
}

function trackGain(track: AudioTrack | null | undefined): number {
  const v = Number(track?.volume);
  return Number.isFinite(v) ? clamp(v, 0, 2) : 1;
}

function applyChannel(name: ChannelName): void {
  if (!running()) return;
  const ac = ctx as AudioContext; // running() checked ctx and nodes
  const spec = desired[name];
  const chGain = (nodes as AudioNodes)[name];
  rampTo(chGain.gain, spec ? toGain(spec.volume) : 0, 0.4);
  const key = trackKey(spec?.track);
  const cur = playing[name];
  if (cur && cur.key === key) {
    const tv = trackGain(spec?.track);
    if (cur.gain && tv !== cur.trackVolume) {
      cur.trackVolume = tv;
      rampTo(cur.gain.gain, tv, 0.4);
    }
    return;
  }
  if (cur) {
    try {
      cur.handle?.stop(XFADE);
    } catch {}
    const g = cur.gain;
    if (g) {
      setTimeout(() => {
        try {
          g.disconnect();
        } catch {}
      }, XFADE * 1000 + 600);
    }
    playing[name] = null;
  }
  if (!spec?.track) return;
  const g = ac.createGain();
  const tv = trackGain(spec.track);
  g.gain.value = tv;
  g.connect(chGain);
  const handle = startTrack(spec.track, g, { startedAt: spec.startedAt, fadeIn: cur?.handle ? XFADE : 1.2 });
  if (!handle) {
    g.disconnect();
    // Remember the failure so the next state sync doesn't retry it over and over.
    playing[name] = { key, handle: null, gain: null, trackVolume: tv };
    return;
  }
  playing[name] = { key, handle, gain: g, trackVolume: tv };
}

function applyAll(): void {
  if (!running() || !nodes) return;
  rampTo(nodes.master.gain, toGain(desired.master), 0.3);
  rampTo(nodes.local.gain, localGain(ui.local, ui.muted), 0.1);
  applyChannel('ambient');
  applyChannel('music');
}

/**
 * Follow the server's audio slice (called by AudioEngine on every state sync; idempotent).
 * audio = game.audio ({ master, ambient: { trackId, volume, startedAt }, music: {...}, tracks })
 */
export function syncAudio(audio: AudioSync | null | undefined): void {
  const list: AudioTrack[] = Array.isArray(audio?.tracks) ? audio.tracks : [];
  tracksById = new Map(list.filter((t) => t && typeof t.id === 'string').map((t) => [t.id, t]));
  desired.master = cleanVolume(audio?.master, 0.8);
  for (const name of ['ambient', 'music'] as const) {
    const ch = audio?.[name];
    const track = ch?.trackId ? tracksById.get(ch.trackId) : null;
    desired[name] = track && ch ? { track, volume: cleanVolume(ch.volume, 0.5), startedAt: Number(ch.startedAt) || 0 } : null;
  }
  applyAll();
}

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------
function loadBuffer(url: string): Promise<AudioBuffer> {
  if (!bufferCache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.arrayBuffer();
      })
      .then(
        (data) =>
          new Promise<AudioBuffer>((resolve, reject) => {
            // Callback form for old Safari; promise form elsewhere.
            const ret = (ctx as AudioContext).decodeAudioData(data, resolve, reject);
            if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
          })
      );
    p.catch(() => bufferCache.delete(url));
    bufferCache.set(url, p);
  }
  return bufferCache.get(url) as Promise<AudioBuffer>;
}

/** Per-call output (volume-scaled dry + reverb send) for one effect, auto-disconnected after `seconds`. */
function sfxOutput(dest: AudioNode, volume: number): SfxOutput {
  const ac = ctx as AudioContext; // callers check running()
  const out = ac.createGain();
  out.gain.value = volume;
  out.connect(dest);
  const verb = ac.createGain();
  verb.gain.value = volume;
  verb.connect((nodes as AudioNodes).sfxVerbIn);
  const entry = { out, verb } as SfxOutput;
  activeSfx.add(entry);
  entry.release = (seconds: number) => {
    setTimeout(() => {
      activeSfx.delete(entry);
      try {
        out.disconnect();
        verb.disconnect();
      } catch {}
    }, Math.max(0.2, seconds) * 1000 + 2500); // + reverb tail
  };
  return entry;
}

function playSfxInto(dest: AudioNode, id: string, volume: unknown = 1, url?: string | null): boolean {
  if (!running()) return false;
  const ac = ctx as AudioContext;
  const vol = cleanVolume(volume, 1);
  if (vol <= 0) return false;
  try {
    if (SFX[id]) {
      const o = sfxOutput(dest, vol);
      const t = ac.currentTime + 0.02;
      const end = SFX[id](ac, o, t);
      o.release((Number.isFinite(end) ? end : t + 3) - ac.currentTime);
      return true;
    }
    const track = tracksById.get(id);
    const src = url || (track?.source === 'url' ? track.url : null);
    if (!src) {
      warnOnce('sfx:' + id, 'bruitage inconnu :', id);
      return false;
    }
    const tv = trackGain(track);
    loadBuffer(src).then(
      (buf) => {
        if (!running()) return;
        const o = sfxOutput(dest, vol * tv);
        o.verb.disconnect(); // files carry their own space
        const s = ac.createBufferSource();
        s.buffer = buf;
        s.connect(o.out);
        s.onended = () => {
          try {
            s.disconnect();
          } catch {}
        };
        s.start();
        o.release(buf.duration);
      },
      (err: Error) => warnOnce('sfxurl:' + src, 'bruitage illisible :', src, err?.message || err)
    );
    return true;
  } catch (err) {
    warnOnce('sfxerr:' + id, 'bruitage en erreur', id, err);
    return false;
  }
}

/** Play an effect for this device only (also used for server 'sfx' events). */
export function playSfx(id: string, volume: unknown = 1, url?: string | null): boolean {
  if (!id || typeof id !== 'string' || !running()) return false;
  const now = Date.now();
  if (now - (lastSfx.get(id) || 0) < 60) return false; // same sound emitted twice in a row
  lastSfx.set(id, now);
  return playSfxInto(nodes?.sfx as GainNode, id, volume, url);
}

/** Fade out every effect currently ringing (server 'audio-stop'). */
export function stopAllSfx(): void {
  if (!ctx) return;
  for (const e of activeSfx) {
    rampTo(e.out.gain, 0, 0.15);
    rampTo(e.verb.gain, 0, 0.15);
  }
}

// ---------------------------------------------------------------------------
// Private preview (GM): plays on this device only, bypassing the shared master volume.
// ---------------------------------------------------------------------------
export function stopPreview(): void {
  if (preview) {
    try {
      preview.handle?.stop(0.6);
    } catch {}
    const out = preview.out;
    setTimeout(() => {
      try {
        out?.disconnect();
      } catch {}
    }, 1200);
    preview = null;
  }
  if (ui.previewKey !== null) {
    ui.previewKey = null;
    notify();
  }
}

/** Toggle a private preview of a track (ambient/music loop, or a one-shot effect). */
export function togglePreview(track: AudioTrack | null | undefined): void {
  if (!track) return;
  unlock();
  const key = 'p:' + track.id;
  if (ui.previewKey === key) return stopPreview();
  stopPreview();
  const go = () => {
    if (!running() || !ctx || !nodes) return;
    if (track.kind === 'sfx') {
      playSfxInto(nodes.preview, track.source === 'synth' ? (track.preset as string) : track.id, 1, track.url);
      return;
    }
    const out = ctx.createGain();
    out.gain.value = 0.6 * trackGain(track);
    out.connect(nodes.preview);
    const handle = startTrack(track, out, { fadeIn: 0.6 });
    if (!handle) return out.disconnect();
    preview = { key, handle, out };
    ui.previewKey = key;
    notify();
  };
  if (running()) go();
  else if (ctx) ctx.resume().then(go, () => {});
}

// ---------------------------------------------------------------------------
// Local (per-device) volume & mute
// ---------------------------------------------------------------------------
export function setLocalVolume(v: unknown): void {
  ui.local = cleanVolume(v, ui.local);
  lsSet(LS_VOL, ui.local);
  if (ui.local > 0 && ui.muted) {
    ui.muted = false;
    lsSet(LS_MUTE, '0');
  }
  if (running()) rampTo((nodes as AudioNodes).local.gain, localGain(ui.local, ui.muted), 0.08);
  notify();
}

export function setMuted(m: unknown): void {
  ui.muted = !!m;
  lsSet(LS_MUTE, ui.muted ? '1' : '0');
  if (running()) rampTo((nodes as AudioNodes).local.gain, localGain(ui.local, ui.muted), 0.08);
  notify();
}

export function getAudioState(): AudioUiState {
  return { ...ui, unlocked: !!ctx && ctx.state === 'running' };
}

/** Hook: { supported, unlocked, local, muted, previewKey } */
export function useAudioState(): AudioUiState {
  const [s, set] = useState(getAudioState);
  useEffect(() => {
    listeners.add(set);
    set(getAudioState());
    return () => {
      listeners.delete(set);
    };
  }, []);
  return s;
}

/** True if the browser had a user gesture already (we may create the context without waiting). */
export function tryEarlyUnlock(): void {
  try {
    if (navigator.userActivation?.hasBeenActive) unlock();
  } catch {}
}
