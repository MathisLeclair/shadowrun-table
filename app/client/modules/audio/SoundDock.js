// GM quick soundboard (right dock): channels, scenes, big effect buttons.
import { useState } from 'preact/hooks';
import { html, Button, loadCss } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { goTab } from '../../lib/ui-store.js';
import { trackIcon } from './catalog.js';
import { ChannelControl, UnlockNotice, LocalVolume, VolumeSlider, tracksOf, sceneIsActive, broadcastSfx, sendVolume, trackName } from './widgets.js';
import { t } from '../../lib/i18n.js';

loadCss('/modules/audio/audio.css');

/** Big effect button; flashes when fired. */
export function SfxButton({ track, onFire, onPreview }) {
  const [fired, setFired] = useState(false);
  const fire = () => {
    onFire(track);
    setFired(true);
    setTimeout(() => setFired(false), 180);
  };
  return html`<div class=${'audio-sfx' + (fired ? ' fired' : '')} role="button" tabindex="0" title=${t('Jouer « {name} » pour tout le monde', { name: trackName(track) })}
    onClick=${fire} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fire())}>
    <span class="audio-sfx-icon">${trackIcon(track)}</span>
    <span class="audio-sfx-label">${trackName(track)}</span>
    ${onPreview &&
    html`<button class="audio-sfx-preview" title=${t('Écouter en privé (vous seul)')} onClick=${(e) => {
      e.stopPropagation();
      onPreview(track);
    }}>🎧</button>`}
  </div>`;
}

export default function SoundDock({ game }) {
  const audio = game.audio;
  if (!audio) return html`<div class="audio-dock"><div class="muted small">${t('Module audio indisponible.')}</div></div>`;
  const scenes = audio.scenes || [];
  const sfx = tracksOf(game, 'sfx');
  const playing = audio.ambient?.trackId || audio.music?.trackId;

  return html`<div class="audio-dock">
    <${UnlockNotice} />
    <${ChannelControl} game=${game} channel="ambient" label=${t('Ambiance')} compact />
    <${ChannelControl} game=${game} channel="music" label=${t('Musique')} compact />

    ${scenes.length > 0 &&
    html`<div class="audio-dock-title"><span>${t('Scènes')}</span><${Button} small variant="ghost" onClick=${() => goTab('audio')}>${t('Gérer')}</${Button}></div>
      <div class="audio-dock-scenes">
        ${scenes.map(
          (s) => html`<button class=${'audio-chip' + (sceneIsActive(s, audio) ? ' active' : '')} title=${t('Appliquer la scène « {name} »', { name: s.name })}
            onClick=${() => send('audio/applyScene', { sceneId: s.id }).catch(() => {})}>${s.name}</button>`
        )}
      </div>`}

    <div class="audio-dock-title"><span>${t('Bruitages')}</span></div>
    <div class="audio-sfx-grid">
      ${sfx.map((tr) => html`<${SfxButton} key=${tr.id} track=${tr} onFire=${(x) => broadcastSfx(x.id)} />`)}
    </div>

    <div class="audio-dock-foot">
      <${VolumeSlider} value=${audio.master ?? 0.8} onChange=${(v) => sendVolume('master', v)} label=${t('volume::Général')} title=${t('Volume général (pour tout le monde)')} />
      <${LocalVolume} label=${t('Ce poste')} />
      <${Button} variant=${playing ? 'danger' : 'default'} small title=${t('Coupe ambiance, musique et bruitages en cours, chez tout le monde')}
        onClick=${() => send('audio/stopAll').catch(() => {})}>⏹ ${t('Tout couper')}</${Button}>
    </div>
  </div>`;
}
