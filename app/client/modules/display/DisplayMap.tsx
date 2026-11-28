// Map pane of a table display: the shown map as the party sees it (the server already masked it, see 20-maps), no
// input but local pan / zoom, GM « look here » (display/focus) and pings, optional rotation for a screen laid flat.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MapCanvas } from '../map/MapCanvas.tsx';
import { useServerEvent } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { decodeBits, orBits } from '/shared/vision.ts';
import type { MapRenderer, MapScene } from '../map/renderer.ts';
import type { DisplayFocus, DisplayRotation, GameMap, GameView } from '../../../shared/types.ts';
import '../map/map.css';

/** Cells the display knows (explored ∪ visible), as the server sent them under its own user id. */
function fogOf(map: GameMap, userId: string) {
  if (map.fog === false) return null;
  const n = map.width * map.height;
  const visible = decodeBits(map.visible, n);
  const explored = decodeBits(map.explored?.[userId], n);
  orBits(explored, visible);
  return { visible, explored };
}

/** Size of an element, kept up to date (panes resize without a window resize). */
function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return size;
}

export default function DisplayMap({ game, rotation }: { game: GameView; rotation: DisplayRotation }) {
  const mapId = game.scene?.activeMapId;
  const map = mapId ? game.maps?.[mapId] : null;
  if (!map) {
    return (
      <div className="dsp-empty">
        <div className="dsp-empty-glyph">⌖</div>
        <div>{t('No map shown yet')}</div>
      </div>
    );
  }
  return <RotatedMap game={game} map={map} rotation={rotation} />;
}

function RotatedMap({ game, map, rotation }: { game: GameView; map: GameMap; rotation: DisplayRotation }) {
  const outer = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(outer);
  const rRef = useRef<MapRenderer | null>(null);
  const mapRef = useRef(map);
  mapRef.current = map;
  const gameRef = useRef(game);
  gameRef.current = game;
  const actors = game.actors || {};
  const fog = useMemo(() => fogOf(map, game.me.id), [map, game.me.id]);
  const combat = game.combat;
  const turnTokenId = combat?.active ? (combat.entries || []).find((e) => e.id === combat.currentId)?.tokenId || null : null;
  const selected = useMemo(() => new Set<string>(), []);

  const scene = useMemo<MapScene>(
    () => ({
      map,
      actors,
      role: game.me.role,
      me: game.me,
      selected,
      turnTokenId,
      gmLayer: false,
      editor: false,
      fog,
      unseen: null,
      tokenMask: null,
      hideHidden: true,
      darkFactor: 1,
      showWalls: false,
      showGrid: true,
      // Same bars a player sees on the party's tokens.
      barsFor: (tok, actor) => (tok.disposition === 'pc' || tok.disposition === 'ally') && !!actor,
      combatMarks: null,
    }),
    [map, actors, fog, turnTokenId, game.me]
  );

  // A new map: fit it on screen.
  useEffect(() => {
    const id = setTimeout(() => rRef.current?.fit(), 60);
    return () => clearTimeout(id);
  }, [map.id, rotation]);

  useServerEvent(
    'display/focus',
    (f: DisplayFocus | null) => {
      if (!f || f.mapId !== mapRef.current.id) return;
      rRef.current?.centerOn(f.x - 0.5, f.y - 0.5, f.zoom || 0);
      rRef.current?.addPing({ x: f.x, y: f.y, color: '#e0468f' });
    },
    []
  );
  useServerEvent(
    'ping',
    (p: { mapId: string; x: number; y: number; name?: string; userId: string } | null) => {
      if (!p || p.mapId !== mapRef.current.id) return;
      const g = gameRef.current;
      const owner = g.users?.[p.userId];
      const actor = owner ? g.actors?.[(owner.characterIds || [])[0]] : null;
      rRef.current?.addPing({ x: p.x, y: p.y, name: p.name, color: p.userId === 'gm' ? '#e0468f' : actor?.color || '#3fd6d0' });
    },
    []
  );

  // A quarter turn swaps the inner box's sides; the canvas measures its layout size, so it stays sharp. Gestures follow
  // the unrotated axes, hence no local pan / zoom on a rotated display.
  const quarter = rotation === 90 || rotation === 270;
  const style = rotation
    ? { width: quarter ? h : w, height: quarter ? w : h, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }
    : undefined;
  return (
    <div className="dsp-map" ref={outer}>
      <div className={'dsp-map-inner' + (rotation ? ' rotated' : '')} style={style}>
        <MapCanvas rendererRef={rRef} scene={scene} />
      </div>
    </div>
  );
}
