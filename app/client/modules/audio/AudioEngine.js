// Global audio player, mounted once for every user (GM and players).
// Follows game.audio (ambient + music loops, volumes), plays 'sfx' events, and shows:
//  - « 🔊 Activer le son » until the browser lets us play audio (autoplay policy),
//  - for players, a tiny collapsible per-device volume / mute control (bottom-left).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, loadCss } from '../../lib/ui.js';
import { send, useServerEvent } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { syncAudio, playSfx, stopAllSfx, unlock, useAudioState, tryEarlyUnlock } from './audio-core.js';
import { LocalVolume, trackLabel, lsGet, lsSet } from './widgets.js';
import { t } from '../../lib/i18n.js';

loadCss('/modules/audio/audio.css');

/** GM only: when the active map changes, apply the audio scene linked to it (if enabled). */
function useAutoScene(game) {
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

function PlayerControl({ game, st }) {
  const [open, setOpen] = useState(() => lsGet('sr.audio.panelOpen', '0') === '1');
  const toggle = () => {
    setOpen(!open);
    lsSet('sr.audio.panelOpen', open ? '0' : '1');
  };
  const amb = trackLabel(game, game.audio?.ambient?.trackId);
  const mus = trackLabel(game, game.audio?.music?.trackId);
  const silent = st.muted || st.local === 0;
  return html`<div class=${'audio-float' + (open ? ' open' : '')}>
    <button class=${'audio-float-btn' + ((amb || mus) && !silent ? ' playing' : '')} onClick=${toggle}
      title=${open ? t('Masquer le réglage du son') : t('Réglage du son')} aria-label=${t('Réglage du son')} aria-expanded=${open}>
      ${silent ? '🔇' : amb || mus ? '🔊' : '🔈'}
    </button>
    ${open &&
    html`<div class="audio-float-panel">
      <div class="audio-float-now">
        <span>${t('Ambiance :')} <b>${amb || '—'}</b></span>
        <span>${t('Musique :')} <b>${mus || '—'}</b></span>
      </div>
      <${LocalVolume} label=${t('Volume')} />
    </div>`}
  </div>`;
}

export default function AudioEngine({ game }) {
  const st = useAudioState();
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
    (e) => {
      if (e && typeof e.id === 'string') playSfx(e.id, e.volume ?? 1, typeof e.url === 'string' ? e.url : undefined);
    },
    []
  );
  useServerEvent('audio-stop', () => stopAllSfx(), []);
  useAutoScene(game);

  if (!st.supported || !game) return null;
  if (!st.unlocked) {
    return html`<button class="audio-unlock" onClick=${unlock} title=${t('Le navigateur bloque le son tant qu’on n’a pas interagi avec la page')}>🔊 ${t('Activer le son')}</button>`;
  }
  if (game.me?.role === 'gm') return null; // the GM has full controls in the Ambiance tab and Sons dock
  return html`<${PlayerControl} game=${game} st=${st} />`;
}
