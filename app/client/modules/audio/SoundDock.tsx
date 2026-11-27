// GM quick soundboard (right dock): channels, scenes, big effect buttons.
import { useState } from 'react';
import { Button } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { goTab } from '../../lib/ui-store.ts';
import { trackIcon } from './catalog.js';
import { ChannelControl, UnlockNotice, LocalVolume, VolumeSlider, tracksOf, sceneIsActive, broadcastSfx, sendVolume, trackName } from './widgets.tsx';
import { t } from '../../lib/i18n.js';
import type { AudioTrack } from '../../../shared/types.ts';
import './audio.css';

interface SfxButtonProps {
  track: AudioTrack;
  onFire: (track: AudioTrack) => void;
  onPreview?: (track: AudioTrack) => void;
}
/** Big effect button; flashes when fired. */
export function SfxButton({ track, onFire, onPreview }: SfxButtonProps) {
  const [fired, setFired] = useState(false);
  const fire = () => {
    onFire(track);
    setFired(true);
    setTimeout(() => setFired(false), 180);
  };
  return (
    <div
      className={'audio-sfx' + (fired ? ' fired' : '')}
      role="button"
      tabIndex={0}
      title={t('Jouer « {name} » pour tout le monde', { name: trackName(track) })}
      onClick={fire}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          fire();
        }
      }}
    >
      <span className="audio-sfx-icon">{trackIcon(track)}</span>
      <span className="audio-sfx-label">{trackName(track)}</span>
      {onPreview && (
        <button
          className="audio-sfx-preview"
          title={t('Écouter en privé (vous seul)')}
          onClick={(e) => {
            e.stopPropagation();
            onPreview(track);
          }}
        >
          🎧
        </button>
      )}
    </div>
  );
}

export default function SoundDock({ game }: GameProps) {
  const audio = game.audio;
  if (!audio)
    return (
      <div className="audio-dock">
        <div className="muted small">{t('Module audio indisponible.')}</div>
      </div>
    );
  const scenes = audio.scenes || [];
  const sfx = tracksOf(game, 'sfx');
  const playing = audio.ambient?.trackId || audio.music?.trackId;

  return (
    <div className="audio-dock">
      <UnlockNotice />
      <ChannelControl game={game} channel="ambient" label={t('Ambiance')} compact />
      <ChannelControl game={game} channel="music" label={t('Musique')} compact />

      {scenes.length > 0 && (
        <>
          <div className="audio-dock-title">
            <span>{t('Scènes')}</span>
            <Button small variant="ghost" onClick={() => goTab('audio')}>
              {t('Gérer')}
            </Button>
          </div>
          <div className="audio-dock-scenes">
            {scenes.map((s) => (
              <button
                key={s.id}
                className={'audio-chip' + (sceneIsActive(s, audio) ? ' active' : '')}
                title={t('Appliquer la scène « {name} »', { name: s.name })}
                onClick={() => send('audio/applyScene', { sceneId: s.id }).catch(() => {})}
              >
                {s.name}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="audio-dock-title">
        <span>{t('Bruitages')}</span>
      </div>
      <div className="audio-sfx-grid">
        {sfx.map((tr) => (
          <SfxButton key={tr.id} track={tr} onFire={(x) => broadcastSfx(x.id)} />
        ))}
      </div>

      <div className="audio-dock-foot">
        <VolumeSlider value={audio.master ?? 0.8} onChange={(v) => sendVolume('master', v)} label={t('volume::Général')} title={t('Volume général (pour tout le monde)')} />
        <LocalVolume label={t('Ce poste')} />
        <Button variant={playing ? 'danger' : 'default'} small title={t('Coupe ambiance, musique et bruitages en cours, chez tout le monde')} onClick={() => send('audio/stopAll').catch(() => {})}>
          ⏹ {t('Tout couper')}
        </Button>
      </div>
    </div>
  );
}
