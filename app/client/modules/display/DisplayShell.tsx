// Table display (/t/<slug>/?display=<token>): a read-only, full-screen view of the table for a shared screen or a
// projector at in-person games. No login, no tabs, no dock: the GM sets everything from Settings → Table displays
// (panes, vision, rotation, blank screen, handout, sound) and it is pushed live. See docs/modules/display.md.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { connect, useGame, useConnected } from '../../lib/net.ts';
import { useLang } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { layoutPanes } from '/shared/display.ts';
import AudioEngine from '../audio/AudioEngine.tsx';
import DisplayMap from './DisplayMap.tsx';
import { InitiativePane, InitiativeStrip, RollsPane, HandoutView, shownHandout } from './panes.tsx';
import type { DisplayPane, DisplayView, GameView } from '../../../shared/types.ts';
import './display.css';

/** Keep the screen awake while the display is visible (Screen Wake Lock API, where the browser has it). */
function useWakeLock() {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (!nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let alive = true;
    const take = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock!.request('screen').then(
        (l) => {
          if (alive) lock = l;
          else l.release().catch(() => {});
        },
        () => {}
      );
    };
    take();
    document.addEventListener('visibilitychange', take); // the lock is dropped when the tab is hidden
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', take);
      lock?.release().catch(() => {});
    };
  }, []);
}

/** Small corner buttons (full screen) that show while the mouse moves, then fade. */
function CornerTools() {
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const poke = () => {
      setShown(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), 3000);
    };
    poke();
    window.addEventListener('pointermove', poke);
    return () => {
      window.removeEventListener('pointermove', poke);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  return (
    <div className={'dsp-tools' + (shown ? '' : ' faded')}>
      <button type="button" className="dsp-tool" onClick={toggle} title={t('Full screen')}>
        ⛶
      </button>
    </div>
  );
}

function Pane({ pane, game, display }: { pane: DisplayPane; game: GameView; display: DisplayView }) {
  if (pane === 'map') return <DisplayMap game={game} rotation={display.rotation} />;
  if (pane === 'initiative') return <InitiativePane game={game} />;
  if (pane === 'rolls') return <RollsPane game={game} />;
  return <HandoutView handout={shownHandout(game)} />;
}

function Panes({ game, display }: { game: GameView; display: DisplayView }) {
  const L = display.layout;
  const panes = layoutPanes(L);
  const basis = (r: number) => `calc(${(r * 100).toFixed(2)}% - 2px)`;
  return (
    <div className={'dsp-panes ' + (L.splitDir === 'col' ? 'dsp-stacked' : 'dsp-side')}>
      {panes.map((p, i) => (
        <div key={p} className="dsp-slot" style={panes.length > 1 ? ({ flexBasis: basis(i === 0 ? L.splitRatio : 1 - L.splitRatio) } as CSSProperties) : undefined}>
          <Pane pane={p} game={game} display={display} />
        </div>
      ))}
    </div>
  );
}

function DisplayScreen() {
  const game = useGame();
  const online = useConnected();
  const lang = useLang();
  useWakeLock();
  const tableName = game?.config?.campaignName;
  const name = game?.display?.name;
  useEffect(() => {
    if (tableName) document.title = name ? `${name} — ${tableName}` : tableName;
  }, [tableName, name, lang]);
  if (!game) return <div className="dsp-root dsp-wait">{t('Connecting to the Matrix…')}</div>;
  const d = game.display;
  if (!d) return <div className="dsp-root dsp-wait">{t('Connecting to the Matrix…')}</div>;
  // A handout the GM shows goes full screen, unless a pane is already showing handouts.
  const overlay = d.handoutId && !layoutPanes(d.layout).includes('handout') ? shownHandout(game) : null;
  return (
    <div className="dsp-root" key={lang}>
      {game.ui?.announcement && <div className="dsp-announce">{game.ui.announcement}</div>}
      <Panes game={game} display={d} />
      {d.initiative && <InitiativeStrip game={game} />}
      {overlay && (
        <div className="dsp-overlay">
          <HandoutView handout={overlay} />
        </div>
      )}
      {d.blank && <div className="dsp-blank"></div>}
      {!online && <div className="dsp-offline">{t('Disconnected — reconnecting…')}</div>}
      {d.audio && <AudioEngine game={game} />}
      <CornerTools />
    </div>
  );
}

/** Entry point of a display page: connects with the link token; a revoked link shows a notice (no login screen). */
export default function DisplayApp() {
  useLang(); // re-render the whole tree on a language switch
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    const s = connect(() => setRevoked(true));
    return () => {
      s.disconnect();
    };
  }, []);
  if (revoked) {
    return (
      <div className="dsp-root dsp-wait">
        <div className="dsp-revoked">
          <h2>{t('This display link is no longer valid')}</h2>
          <p className="muted">{t('Ask the GM for the new link (Settings → Table displays).')}</p>
          <button type="button" className="btn" onClick={() => location.reload()}>
            {t('Try again')}
          </button>
        </div>
      </div>
    );
  }
  return <DisplayScreen />;
}
