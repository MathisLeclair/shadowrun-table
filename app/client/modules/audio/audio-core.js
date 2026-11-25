// Audio engine singleton: one AudioContext for the whole app.
//   graph: channel items -> ambient/music gains -> master (server volume) -> local (device volume, mute)
//          -> limiter -> speakers.   sfx -> sfx bus (+ shared reverb) -> master.   preview -> local.
// Everything here must fail soft: if Web Audio is missing or throws, the app keeps working silently.
import { useEffect, useState } from 'preact/hooks';
import { toGain, localGain, cleanVolume, clamp, syncOffset } from './theory.js';
import { impulse } from './synth.js';
import { AMBIENCES } from './ambiences.js';
import { MUSIC } from './music.js';
import { SFX } from './sfx.js';

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
const XFADE = 2;
const LS_VOL = 'sr.audio.volume';
const LS_MUTE = 'sr.audio.muted';

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

let ctx = null;
let nodes = null; // { master, local, limiter, sfx, sfxVerb, preview, ambient, music }
const desired = { master: 0.8, ambient: null, music: null }; // channel spec: { track, volume, startedAt }
const playing = { ambient: null, music: null }; // { key, handle, gain, trackVolume }
let tracksById = new Map();
let preview = null; // { key, handle, out }
const activeSfx = new Set(); // per-call gain nodes, for stopAllSfx()
const lastSfx = new Map(); // id -> timestamp (dedupe double emissions)
const bufferCache = new Map(); // url -> Promise<AudioBuffer>
const warned = new Set();

const ui = {
  supported: !!AC,
  unlocked: false,
  local: (() => {
    const n = Number(lsGet(LS_VOL, 0.8));
    return Number.isFinite(n) ? clamp(n, 0, 1) : 0.8;
  })(),
  muted: lsGet(LS_MUTE, '0') === '1',
  previewKey: null,
};
const listeners = new Set();
function notify() {
  ui.unlocked = !!ctx && ctx.state === 'running';
  const snap = { ...ui };
  for (const l of listeners) {
    try {
      l(snap);
    } catch {}
  }
}

function warnOnce(key, ...args) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[audio]', ...args);
}

/** Smoothly move a gain param (no clicks, interrupts any running ramp). */
function rampTo(param, value, seconds = 0.3) {
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
function createContext() {
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
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    const local = ctx.createGain();
    local.gain.value = localGain(ui.local, ui.muted);
    local.connect(limiter);
    const master = ctx.createGain();
    master.gain.value = toGain(desired.master);
    master.connect(local);
    const mk = (dest) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(dest);
      return g;
    };
    const sfx = ctx.createGain();
    sfx.connect(master);
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, 1.8, 3);
    const sfxVerb = ctx.createGain();
    sfxVerb.gain.value = 0.6;
    conv.connect(sfxVerb);
    sfxVerb.connect(sfx);
    const preview = ctx.createGain();
    preview.connect(local);
    nodes = { limiter, local, master, sfx, sfxVerbIn: conv, preview, ambient: mk(master), music: mk(master) };
  } catch (err) {
    warnOnce('graph', 'graphe audio impossible', err);
    nodes = null;
  }
  ctx.onstatechange = () => {
    notify();
    if (ctx.state === 'running') applyAll();
  };
  return ctx;
}

/** Create/resume the AudioContext. Must be called from a user gesture the first time. */
export function unlock() {
  if (!AC) return;
  try {
    if (!ctx) {
      createContext();
      // A context created after a past gesture may start "running" right away: no statechange then.
      if (ctx && ctx.state === 'running') {
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

function running() {
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
function trackKey(track) {
  return track ? `${track.id}|${track.source === 'url' ? track.url : track.preset}` : null;
}

/** Loop an uploaded file through a media element (streams, no full decode). */
function playUrlLoop(url, dest, { startedAt = 0, fadeIn = XFADE } = {}) {
  const el = new Audio();
  el.preload = 'auto';
  el.loop = true;
  el.src = url;
  const src = ctx.createMediaElementSource(el);
  const g = ctx.createGain();
  g.gain.value = 0;
  src.connect(g);
  g.connect(dest);
  const now = ctx.currentTime;
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
  el.play().catch((err) => {
    if (!stopped) warnOnce('play:' + url, 'lecture impossible :', url, err?.message || err);
  });
  return {
    stop(fade = XFADE) {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
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
function startTrack(track, dest, { startedAt = 0, fadeIn = XFADE } = {}) {
  if (!track || !ctx) return null;
  try {
    if (track.source === 'url') {
      if (!track.url) return null;
      return playUrlLoop(track.url, dest, { startedAt, fadeIn });
    }
    const gen = (track.kind === 'music' ? MUSIC : AMBIENCES)[track.preset] || AMBIENCES[track.preset] || MUSIC[track.preset];
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

function trackGain(track) {
  const v = Number(track?.volume);
  return Number.isFinite(v) ? clamp(v, 0, 2) : 1;
}

function applyChannel(name) {
  if (!running()) return;
  const spec = desired[name];
  const chGain = nodes[name];
  rampTo(chGain.gain, spec ? toGain(spec.volume) : 0, 0.4);
  const key = trackKey(spec?.track);
  const cur = playing[name];
  if (cur && cur.key === key) {
    const tv = trackGain(spec.track);
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
  const g = ctx.createGain();
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

function applyAll() {
  if (!running()) return;
  rampTo(nodes.master.gain, toGain(desired.master), 0.3);
  rampTo(nodes.local.gain, localGain(ui.local, ui.muted), 0.1);
  applyChannel('ambient');
  applyChannel('music');
}

/**
 * Follow the server's audio slice (called by AudioEngine on every state sync; idempotent).
 * audio = game.audio ({ master, ambient: { trackId, volume, startedAt }, music: {...}, tracks })
 */
export function syncAudio(audio) {
  const list = Array.isArray(audio?.tracks) ? audio.tracks : [];
  tracksById = new Map(list.filter((t) => t && typeof t.id === 'string').map((t) => [t.id, t]));
  desired.master = cleanVolume(audio?.master, 0.8);
  for (const name of ['ambient', 'music']) {
    const ch = audio?.[name];
    const track = ch?.trackId ? tracksById.get(ch.trackId) : null;
    desired[name] = track ? { track, volume: cleanVolume(ch.volume, 0.5), startedAt: Number(ch.startedAt) || 0 } : null;
  }
  applyAll();
}

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------
function loadBuffer(url) {
  if (!bufferCache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.arrayBuffer();
      })
      .then(
        (data) =>
          new Promise((resolve, reject) => {
            // Callback form for old Safari; promise form elsewhere.
            const ret = ctx.decodeAudioData(data, resolve, reject);
            if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
          })
      );
    p.catch(() => bufferCache.delete(url));
    bufferCache.set(url, p);
  }
  return bufferCache.get(url);
}

/** Per-call output (volume-scaled dry + reverb send) for one effect, auto-disconnected after `seconds`. */
function sfxOutput(dest, volume) {
  const out = ctx.createGain();
  out.gain.value = volume;
  out.connect(dest);
  const verb = ctx.createGain();
  verb.gain.value = volume;
  verb.connect(nodes.sfxVerbIn);
  const entry = { out, verb };
  activeSfx.add(entry);
  entry.release = (seconds) => {
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

function playSfxInto(dest, id, volume = 1, url) {
  if (!running()) return false;
  const vol = cleanVolume(volume, 1);
  if (vol <= 0) return false;
  try {
    if (SFX[id]) {
      const o = sfxOutput(dest, vol);
      const t = ctx.currentTime + 0.02;
      const end = SFX[id](ctx, o, t);
      o.release((Number.isFinite(end) ? end : t + 3) - ctx.currentTime);
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
        const s = ctx.createBufferSource();
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
      (err) => warnOnce('sfxurl:' + src, 'bruitage illisible :', src, err?.message || err)
    );
    return true;
  } catch (err) {
    warnOnce('sfxerr:' + id, 'bruitage en erreur', id, err);
    return false;
  }
}

/** Play an effect for this device only (also used for server 'sfx' events). */
export function playSfx(id, volume = 1, url) {
  if (!id || typeof id !== 'string' || !running()) return false;
  const now = Date.now();
  if (now - (lastSfx.get(id) || 0) < 60) return false; // same sound emitted twice in a row
  lastSfx.set(id, now);
  return playSfxInto(nodes?.sfx, id, volume, url);
}

/** Fade out every effect currently ringing (server 'audio-stop'). */
export function stopAllSfx() {
  if (!ctx) return;
  for (const e of activeSfx) {
    rampTo(e.out.gain, 0, 0.15);
    rampTo(e.verb.gain, 0, 0.15);
  }
}

// ---------------------------------------------------------------------------
// Private preview (GM): plays on this device only, bypassing the shared master volume.
// ---------------------------------------------------------------------------
export function stopPreview() {
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
export function togglePreview(track) {
  if (!track) return;
  unlock();
  const key = 'p:' + track.id;
  if (ui.previewKey === key) return stopPreview();
  stopPreview();
  const go = () => {
    if (!running()) return;
    if (track.kind === 'sfx') {
      playSfxInto(nodes.preview, track.source === 'synth' ? track.preset : track.id, 1, track.url);
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
export function setLocalVolume(v) {
  ui.local = cleanVolume(v, ui.local);
  lsSet(LS_VOL, ui.local);
  if (ui.local > 0 && ui.muted) {
    ui.muted = false;
    lsSet(LS_MUTE, '0');
  }
  if (running()) rampTo(nodes.local.gain, localGain(ui.local, ui.muted), 0.08);
  notify();
}

export function setMuted(m) {
  ui.muted = !!m;
  lsSet(LS_MUTE, ui.muted ? '1' : '0');
  if (running()) rampTo(nodes.local.gain, localGain(ui.local, ui.muted), 0.08);
  notify();
}

export function getAudioState() {
  return { ...ui, unlocked: !!ctx && ctx.state === 'running' };
}

/** Hook: { supported, unlocked, local, muted, previewKey } */
export function useAudioState() {
  const [s, set] = useState(getAudioState);
  useEffect(() => {
    listeners.add(set);
    set(getAudioState());
    return () => listeners.delete(set);
  }, []);
  return s;
}

/** True if the browser had a user gesture already (we may create the context without waiting). */
export function tryEarlyUnlock() {
  try {
    if (navigator.userActivation?.hasBeenActive) unlock();
  } catch {}
}
