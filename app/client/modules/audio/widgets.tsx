// Small UI pieces shared by AudioEngine, AudioPage and SoundDock.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { IconButton, Select, cx } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { throttle } from './theory.js';
import { AMBIENT_PRESETS, MUSIC_PRESETS, SFX_PRESETS, trackIcon, presetMeta } from './catalog.js';
import { useAudioState, setLocalVolume, setMuted, unlock } from './audio-core.js';
import { t, tIfKnown, compare } from '../../lib/i18n.js';
import type { AudioChannel, AudioScene, AudioState, AudioTrack, GameView, TrackKind } from '../../../shared/types.ts';

/** A channel of game.audio that plays loops. */
export type Channel = 'ambient' | 'music';

export function lsGet<T>(key: string, fallback: T): string | T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
export function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
const ORDER: Record<string, number> = {};
[AMBIENT_PRESETS, MUSIC_PRESETS, SFX_PRESETS].forEach((list: Array<{ id: string }>) => list.forEach((p, i) => (ORDER[p.id] = i)));

/** Tracks of a kind: built-ins in catalog order, then uploads by name. */
export function tracksOf(game: GameView | null | undefined, kind: TrackKind): AudioTrack[] {
  return (game?.audio?.tracks || [])
    .filter((tr) => tr.kind === kind)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'synth' ? -1 : 1;
      if (a.source === 'synth') return (ORDER[a.preset ?? ''] ?? 99) - (ORDER[b.preset ?? ''] ?? 99);
      return compare(a.name, b.name);
    });
}

/**
 * Display name of a track: built-in presets still carrying their catalog (French) name are translated;
 * names given by the GM (renamed presets, uploads) are shown as typed.
 */
export function trackName(track: AudioTrack | null | undefined): string {
  if (!track) return '';
  const m = presetMeta(track);
  return m && track.name === m.name ? t(m.label || m.name) : String(track.name ?? '');
}

/** Translated catalog description of a built-in track ('' for uploads). */
export function presetDesc(track: AudioTrack): string {
  const m = presetMeta(track);
  return m?.desc ? t(m.desc) : '';
}

/** Tag label: built-in tags are dictionary keys, tags typed by the GM stay as typed. */
export const tagLabel = (tag: unknown): string => tIfKnown(String(tag ?? ''));

export function findTrack(game: GameView | null | undefined, id: string | null | undefined): AudioTrack | null {
  return id ? (game?.audio?.tracks || []).find((t) => t.id === id) || null : null;
}

export function trackLabel(game: GameView | null | undefined, id: string | null | undefined): string | null {
  const tr = findTrack(game, id);
  return tr ? `${trackIcon(tr)} ${trackName(tr)}` : null;
}

/** Human label of a scene channel value ('keep' | null | trackId). */
export function sceneValueLabel(game: GameView, v: string | null | undefined): string {
  if (v === 'keep' || v === undefined) return t('inchangée');
  if (!v) return t('silence');
  return trackLabel(game, v) || t('piste supprimée');
}

/** True if the scene's channels match what is playing now. */
export function sceneIsActive(scene: AudioScene, audio: AudioState | null | undefined): boolean {
  if (!audio) return false;
  let touched = 0;
  for (const ch of ['ambient', 'music'] as const) {
    const v = scene[ch];
    if (v === 'keep' || v === undefined) continue;
    touched++;
    if ((v || null) !== (audio[ch]?.trackId || null)) return false;
  }
  return touched > 0;
}

/** Options for a channel <Select>: silence + tracks of that kind (+ the current one if of another kind). */
export function channelOptions(game: GameView, channel: Channel) {
  const kind = channel === 'music' ? 'music' : 'ambient';
  const list = tracksOf(game, kind);
  const cur = findTrack(game, game?.audio?.[channel]?.trackId);
  if (cur && !list.includes(cur)) list.unshift(cur);
  return [{ value: '', label: t('— Silence —') }, ...list.map((tr) => ({ value: tr.id, label: `${trackIcon(tr)} ${trackName(tr)}` }))];
}

export function setChannelTrack(channel: Channel, trackId: string | null | undefined) {
  return send(channel === 'music' ? 'audio/setMusic' : 'audio/setAmbient', { trackId: trackId || null }).catch(() => {});
}

// Volume used when the GM broadcasts an effect (remembered per device).
const SFX_VOL_KEY = 'sr.audio.sfxVolume';
export function getSfxVolume(): number {
  const n = Number(lsGet(SFX_VOL_KEY, 1));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
export function useSfxVolume(): [number, (n: number) => void] {
  const [v, setV] = useState(getSfxVolume);
  return [
    v,
    (n) => {
      setV(n);
      lsSet(SFX_VOL_KEY, n);
    },
  ];
}
export function broadcastSfx(id: string, volume = getSfxVolume()) {
  return send('audio/sfx', { id, volume }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
interface VolumeSliderProps {
  value?: number;
  onChange?: (value: number) => void;
  label?: ReactNode;
  title?: string;
  disabled?: boolean;
  className?: string;
}
/**
 * Range slider 0..1. onChange is throttled while dragging and flushed on release, so it can send
 * server actions directly. Ignores external value updates while the user is dragging.
 */
export function VolumeSlider({ value = 0, onChange, label, title, disabled, className }: VolumeSliderProps) {
  const [v, setV] = useState(Number(value) || 0);
  const active = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const thr = useMemo(() => throttle((n: number) => cb.current?.(n), 140), []);
  useEffect(() => {
    if (!active.current) setV(Number(value) || 0);
  }, [value]);
  useEffect(
    () => () => {
      thr.flush();
    },
    []
  );
  const read = (el: HTMLInputElement) => Math.max(0, Math.min(100, Number(el.value) || 0)) / 100;
  const end = () => {
    active.current = false;
  };
  // Release (native « change »: end of the drag, or a keyboard step): flush the last value. React's onChange
  // fires on every move instead, so the native event is listened to directly.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const release = () => {
      const n = read(el);
      setV(n);
      thr.flush(n);
      end();
    };
    el.addEventListener('change', release);
    return () => el.removeEventListener('change', release);
  }, []);
  const pct = Math.round(v * 100);
  return (
    <label className={cx('audio-vol', className)} title={title}>
      {label && <span className="audio-vol-label">{label}</span>}
      <input
        ref={input}
        type="range"
        min="0"
        max="100"
        step="1"
        value={pct}
        disabled={disabled}
        style={{ '--pct': pct + '%' } as CSSProperties}
        onChange={(e) => {
          active.current = true;
          const n = read(e.currentTarget);
          setV(n);
          thr(n);
        }}
        onPointerUp={end}
        onBlur={end}
      />
      <span className="audio-vol-val">{pct}</span>
    </label>
  );
}

/** Throttled server volume setter for a channel ('master' | 'ambient' | 'music'). */
export function sendVolume(channel: 'master' | Channel, volume: number) {
  return send('audio/setVolume', { channel, volume }, { silent: true }).catch(() => {});
}

/** This device's volume + mute (not shared). */
export function LocalVolume({ label }: { label?: ReactNode }) {
  const st = useAudioState();
  const silent = st.muted || st.local === 0;
  return (
    <div className="audio-local">
      <IconButton icon={silent ? '🔇' : '🔊'} title={st.muted ? t('Réactiver le son sur cet appareil') : t('Couper le son sur cet appareil')} onClick={() => setMuted(!st.muted)} />
      <VolumeSlider value={st.muted ? 0 : st.local} onChange={setLocalVolume} label={label ?? t('Cet appareil')} title={t('Volume de cet appareil uniquement')} />
    </div>
  );
}

/** Warning strip shown in GM screens while the browser still blocks audio. */
export function UnlockNotice() {
  const st = useAudioState();
  if (!st.supported) return <div className="audio-notice">{t('Ce navigateur ne gère pas le son (Web Audio indisponible).')}</div>;
  if (st.unlocked) return null;
  return (
    <button className="audio-notice clickable" onClick={unlock}>
      🔇 {t('Le navigateur bloque le son sur ce poste — cliquer pour l’activer')}
    </button>
  );
}

interface ChannelControlProps {
  game: GameView;
  channel: Channel;
  label: ReactNode;
  compact?: boolean;
}
/** Channel row: select + stop + volume. */
export function ChannelControl({ game, channel, label, compact }: ChannelControlProps) {
  const ch: Partial<AudioChannel> = game.audio?.[channel] || {};
  const current = ch.trackId || '';
  return (
    <div className={'audio-channel' + (compact ? ' compact' : '') + (current ? ' on' : '')}>
      <div className="audio-channel-head">
        <span className="audio-channel-label">{label}</span>
        {current ? (
          <span className="audio-eq" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        ) : null}
      </div>
      <div className="audio-channel-row">
        <Select className="audio-channel-select" value={current} options={channelOptions(game, channel)} onChange={(v) => setChannelTrack(channel, v)} />
        <IconButton icon="■" title={t('Arrêter')} disabled={!current} onClick={() => setChannelTrack(channel, null)} />
      </div>
      <VolumeSlider value={ch.volume ?? 0.5} onChange={(v) => sendVolume(channel, v)} title={channel === 'music' ? t('Volume musique (pour tout le monde)') : t('Volume ambiance (pour tout le monde)')} />
    </div>
  );
}
