// Global audio player, mounted once for every user (GM and players).
// Follows game.audio (ambient + music loops, volumes), plays 'sfx' events, and shows:
//  - « 🔊 Activer le son » until the browser lets us play audio (autoplay policy),
//  - for players, a tiny collapsible per-device volume / mute control (bottom-left).
import { useEffect, useRef, useState } from 'react';
import { send, useServerEvent, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { syncAudio, playSfx, stopAllSfx, unlock, useAudioState, tryEarlyUnlock } from './audio-core.js';
import { LocalVolume, trackLabel, lsGet, lsSet } from './widgets.tsx';
import { t } from '../../lib/i18n.js';
import type { GameView } from '../../../shared/types.ts';
import './audio.css';

/** What useAudioState() returns (audio-core.js). */
interface AudioUiState {
  supported: boolean;
  unlocked: boolean;
  local: number;
  muted: boolean;
  previewKey: string | null;
}

/** GM only: when the active map changes, apply the audio scene linked to it (if enabled). */
function useAutoScene(game: GameView | null | undefined) {
  const isGM = game?.me?.role === 'gm';
  const mapId = game?.scene?.activeMapId ?? null;
  const prev = useRef(mapId);
  useEffect(() => {
    if (prev.current === mapId) return;
    prev.current = mapId;
    const audio = game?.audio;
    if (!isGM || !mapId || !audio?.autoScenes) return;
    const scene = (audio.scenes || []).find((s) => s.mapId === mapId);
    if (!scene) return;
    send('audio/applyScene', { sceneId: scene.id }, { silent: true }).then(
      () => toast(t('Ambiance : {name}', { name: scene.name }), 'info', 2500),
      () => {}
    );
  }, [mapId]);
}

function PlayerControl({ game, st }: { game: GameView; st: AudioUiState }) {
  const [open, setOpen] = useState(() => lsGet('sr.audio.panelOpen', '0') === '1');
  const toggle = () => {
    setOpen(!open);
    lsSet('sr.audio.panelOpen', open ? '0' : '1');
  };
  const amb = trackLabel(game, game.audio?.ambient?.trackId);
  const mus = trackLabel(game, game.audio?.music?.trackId);
  const silent = st.muted || st.local === 0;
  return (
    <div className={'audio-float' + (open ? ' open' : '')}>
      <button
        className={'audio-float-btn' + ((amb || mus) && !silent ? ' playing' : '')}
        onClick={toggle}
        title={open ? t('Masquer le réglage du son') : t('Réglage du son')}
        aria-label={t('Réglage du son')}
        aria-expanded={open}
      >
        {silent ? '🔇' : amb || mus ? '🔊' : '🔈'}
      </button>
      {open && (
        <div className="audio-float-panel">
          <div className="audio-float-now">
            <span>
              {t('Ambiance :')} <b>{amb || '—'}</b>
            </span>
            <span>
              {t('Musique :')} <b>{mus || '—'}</b>
            </span>
          </div>
          <LocalVolume label={t('Volume')} />
        </div>
      )}
    </div>
  );
}

export default function AudioEngine({ game }: GameProps) {
  const st: AudioUiState = useAudioState();
  const audio = game?.audio;

  useEffect(() => {
    tryEarlyUnlock();
    return () => {
      try {
        syncAudio(null);
      } catch {}
    };
  }, []);

  useEffect(() => {
    try {
      syncAudio(audio);
    } catch (err) {
      console.warn('[audio] sync', err);
    }
  }, [audio]);

  useServerEvent(
    'sfx',
    (e: { id?: unknown; volume?: number; url?: unknown } | null) => {
      if (e && typeof e.id === 'string') playSfx(e.id, e.volume ?? 1, typeof e.url === 'string' ? e.url : undefined);
    },
    []
  );
  useServerEvent('audio-stop', () => stopAllSfx(), []);
  useAutoScene(game);

  if (!st.supported || !game) return null;
  if (!st.unlocked) {
    return (
      <button className="audio-unlock" onClick={unlock} title={t('Le navigateur bloque le son tant qu’on n’a pas interagi avec la page')}>
        🔊 {t('Activer le son')}
      </button>
    );
  }
  if (game.me?.role === 'gm') return null; // the GM has full controls in the Ambiance tab and Sons dock
  return <PlayerControl game={game} st={st} />;
}
