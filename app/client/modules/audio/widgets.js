// Small UI pieces shared by AudioEngine, AudioPage and SoundDock.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, IconButton, Select } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { throttle } from './theory.js';
import { AMBIENT_PRESETS, MUSIC_PRESETS, SFX_PRESETS, trackIcon, presetMeta } from './catalog.js';
import { useAudioState, setLocalVolume, setMuted, unlock } from './audio-core.js';
import { t, tIfKnown, compare } from '../../lib/i18n.js';

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
export function lsSet(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
const ORDER = {};
[AMBIENT_PRESETS, MUSIC_PRESETS, SFX_PRESETS].forEach((list) => list.forEach((p, i) => (ORDER[p.id] = i)));

/** Tracks of a kind: built-ins in catalog order, then uploads by name. */
export function tracksOf(game, kind) {
  return (game?.audio?.tracks || [])
    .filter((tr) => tr.kind === kind)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'synth' ? -1 : 1;
      if (a.source === 'synth') return (ORDER[a.preset] ?? 99) - (ORDER[b.preset] ?? 99);
      return compare(a.name, b.name);
    });
}

/**
 * Display name of a track: built-in presets still carrying their catalog (French) name are translated;
 * names given by the GM (renamed presets, uploads) are shown as typed.
 */
export function trackName(track) {
  if (!track) return '';
  const m = presetMeta(track);
  return m && track.name === m.name ? t(m.label || m.name) : String(track.name ?? '');
}

/** Translated catalog description of a built-in track ('' for uploads). */
export function presetDesc(track) {
  const m = presetMeta(track);
  return m?.desc ? t(m.desc) : '';
}

/** Tag label: built-in tags are dictionary keys, tags typed by the GM stay as typed. */
export const tagLabel = (tag) => tIfKnown(String(tag ?? ''));

export function findTrack(game, id) {
  return id ? (game?.audio?.tracks || []).find((t) => t.id === id) || null : null;
}

export function trackLabel(game, id) {
  const tr = findTrack(game, id);
  return tr ? `${trackIcon(tr)} ${trackName(tr)}` : null;
}

/** Human label of a scene channel value ('keep' | null | trackId). */
export function sceneValueLabel(game, v) {
  if (v === 'keep' || v === undefined) return t('inchangée');
  if (!v) return t('silence');
  return trackLabel(game, v) || t('piste supprimée');
}

/** True if the scene's channels match what is playing now. */
export function sceneIsActive(scene, audio) {
  if (!audio) return false;
  let touched = 0;
  for (const ch of ['ambient', 'music']) {
    const v = scene[ch];
    if (v === 'keep' || v === undefined) continue;
    touched++;
    if ((v || null) !== (audio[ch]?.trackId || null)) return false;
  }
  return touched > 0;
}

/** Options for a channel <Select>: silence + tracks of that kind (+ the current one if of another kind). */
export function channelOptions(game, channel) {
  const kind = channel === 'music' ? 'music' : 'ambient';
  const list = tracksOf(game, kind);
  const cur = findTrack(game, game?.audio?.[channel]?.trackId);
  if (cur && !list.includes(cur)) list.unshift(cur);
  return [{ value: '', label: t('— Silence —') }, ...list.map((tr) => ({ value: tr.id, label: `${trackIcon(tr)} ${trackName(tr)}` }))];
}

export function setChannelTrack(channel, trackId) {
  return send(channel === 'music' ? 'audio/setMusic' : 'audio/setAmbient', { trackId: trackId || null }).catch(() => {});
}

// Volume used when the GM broadcasts an effect (remembered per device).
const SFX_VOL_KEY = 'sr.audio.sfxVolume';
export function getSfxVolume() {
  const n = Number(lsGet(SFX_VOL_KEY, 1));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
export function useSfxVolume() {
  const [v, setV] = useState(getSfxVolume);
  return [
    v,
    (n) => {
      setV(n);
      lsSet(SFX_VOL_KEY, n);
    },
  ];
}
export function broadcastSfx(id, volume = getSfxVolume()) {
  return send('audio/sfx', { id, volume }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
/**
 * Range slider 0..1. onChange is throttled while dragging and flushed on release, so it can send
 * server actions directly. Ignores external value updates while the user is dragging.
 */
export function VolumeSlider({ value = 0, onChange, label, title, disabled, class: klass }) {
  const [v, setV] = useState(Number(value) || 0);
  const active = useRef(false);
  const cb = useRef(onChange);
  cb.current = onChange;
  const thr = useMemo(() => throttle((n) => cb.current?.(n), 140), []);
  useEffect(() => {
    if (!active.current) setV(Number(value) || 0);
  }, [value]);
  useEffect(() => () => thr.flush(), []);
  const pct = Math.round(v * 100);
  const read = (e) => Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)) / 100;
  const end = () => {
    active.current = false;
  };
  return html`<label class=${'audio-vol' + (klass ? ' ' + klass : '')} title=${title}>
    ${label && html`<span class="audio-vol-label">${label}</span>`}
    <input
      type="range"
      min="0"
      max="100"
      step="1"
      value=${pct}
      disabled=${disabled}
      style=${{ '--pct': pct + '%' }}
      onInput=${(e) => {
        active.current = true;
        const n = read(e);
        setV(n);
        thr(n);
      }}
      onChange=${(e) => {
        const n = read(e);
        setV(n);
        thr.flush(n);
        end();
      }}
      onPointerUp=${end}
      onBlur=${end}
    />
    <span class="audio-vol-val">${pct}</span>
  </label>`;
}

/** Throttled server volume setter for a channel ('master' | 'ambient' | 'music'). */
export function sendVolume(channel, volume) {
  return send('audio/setVolume', { channel, volume }, { silent: true }).catch(() => {});
}

/** This device's volume + mute (not shared). */
export function LocalVolume({ label }) {
  const st = useAudioState();
  const silent = st.muted || st.local === 0;
  return html`<div class="audio-local">
    <${IconButton} icon=${silent ? '🔇' : '🔊'} title=${st.muted ? t('Réactiver le son sur cet appareil') : t('Couper le son sur cet appareil')} onClick=${() => setMuted(!st.muted)} />
    <${VolumeSlider} value=${st.muted ? 0 : st.local} onChange=${setLocalVolume} label=${label ?? t('Cet appareil')} title=${t('Volume de cet appareil uniquement')} />
  </div>`;
}

/** Warning strip shown in GM screens while the browser still blocks audio. */
export function UnlockNotice() {
  const st = useAudioState();
  if (!st.supported) return html`<div class="audio-notice">${t('Ce navigateur ne gère pas le son (Web Audio indisponible).')}</div>`;
  if (st.unlocked) return null;
  return html`<button class="audio-notice clickable" onClick=${unlock}>🔇 ${t('Le navigateur bloque le son sur ce poste — cliquer pour l’activer')}</button>`;
}

/** Channel row: select + stop + volume. */
export function ChannelControl({ game, channel, label, compact }) {
  const ch = game.audio?.[channel] || {};
  const current = ch.trackId || '';
  return html`<div class=${'audio-channel' + (compact ? ' compact' : '') + (current ? ' on' : '')}>
    <div class="audio-channel-head">
      <span class="audio-channel-label">${label}</span>
      ${current ? html`<span class="audio-eq" aria-hidden="true"><i></i><i></i><i></i></span>` : null}
    </div>
    <div class="audio-channel-row">
      <${Select} class="audio-channel-select" value=${current} options=${channelOptions(game, channel)} onChange=${(v) => setChannelTrack(channel, v)} />
      <${IconButton} icon="■" title=${t('Arrêter')} disabled=${!current} onClick=${() => setChannelTrack(channel, null)} />
    </div>
    <${VolumeSlider} value=${ch.volume ?? 0.5} onChange=${(v) => sendVolume(channel, v)} title=${channel === 'music' ? t('Volume musique (pour tout le monde)') : t('Volume ambiance (pour tout le monde)')} />
  </div>`;
}
