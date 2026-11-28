// Home of a lifestyle (shared/home.js): map viewer, first pick among a few layouts, moving (paid), GM « play map ».
// Opened from the lifestyle cards of the sheet (« Contacts & SIN »), for the GM and the runner's owner.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Modal, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { setUI, goTab, toast } from '../../lib/ui-store.ts';
import { t, fmtNuyen } from '../../lib/i18n.ts';
import { homeLayoutsFor, homeLayout, homeMoveCost, buildHome, homeArea, homeAddons, type HomeBuild, type HomeLayout, type HomeMap } from '/shared/home.ts';
import { drawStaticMap, type MapRenderer, type MapScene } from '../map/renderer.ts';
import { lifestyleBaseLabel } from './sublists.tsx';
import { fmtDate } from './common.tsx';
import { HTR_REF, HTR_RESPONSE, homeSecurity } from '/shared/city.ts';
import { BookRef } from '../books/BookRef.tsx';

import type { Actor, GameMap, GameView, Lifestyle } from '../../../shared/types.ts';
import './home.css';
import { MapCanvas } from '../map/MapCanvas.tsx';

type HomeLayoutDef = HomeLayout;
type BuiltHome = HomeBuild;
const layoutsFor = homeLayoutsFor;
const layoutOf = homeLayout;
/** buildHome() of a known layout id (never null). */
const build = (l: Lifestyle, layoutId: string, opts: { tr: (s: string) => string }): BuiltHome => buildHome(l, layoutId, opts)!;

/** Does this lifestyle level have homes to draw (Street: no)? */
export const hasHomes = (l: Lifestyle | null | undefined): boolean => layoutsFor(l?.base).length > 0;

/** Button on a lifestyle card: « 🏠 Logement » (name of the layout once chosen). */
interface HomeProps {
  game: GameView;
  actor: Actor;
  lifestyle: Lifestyle;
  canMove: boolean;
}
export function HomeButton({ game, actor, lifestyle, canMove }: HomeProps) {
  const [open, setOpen] = useState(false);
  if (!hasHomes(lifestyle)) return null;
  const lay = layoutOf(lifestyle);
  return <span className="hm-btn-wrap">
    <Button small variant={lay ? 'ghost' : 'primary'} className="hm-btn" onClick={() => setOpen(true)} title={lay ? t('Show the floor plan') : t('Choose the home of this lifestyle')}>
      🏠 {lay ? t(lay.name) : t('Choose a home')}
    </Button>
    {open && <HomeModal game={game} actor={actor} lifestyle={lifestyle} canMove={canMove} onClose={() => setOpen(false)} />}
  </span>;
}

/** Flat drawing of a home (chooser cards). */
function HomePreview({ map, max = 280 }: { map: HomeMap; max?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !map) return;
    const S = Math.max(4, Math.min(20, Math.floor(max / Math.max(map.width, map.height, 1))));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(map.width * S * dpr);
    c.height = Math.round(map.height * S * dpr);
    c.style.width = `${map.width * S}px`;
    c.style.height = `${map.height * S}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, map.width * S, map.height * S);
    try {
      drawStaticMap(ctx, map, S);
    } catch (err) {
      console.error('[home] preview failed', err);
    }
  }, [map, max]);
  return <canvas className="hm-preview" ref={ref} />;
}

/** Pan / zoom view of a home with the map renderer (no tokens, no fog). */
function HomeViewer({ game, map }: { game: GameView; map: HomeMap | GameMap }) {
  const rRef = useRef<MapRenderer | null>(null);
  // A drawn home has every field of a table map the renderer reads; the real (table) map also has its tokens.
  const scene = useMemo((): MapScene => ({ map: map as GameMap, actors: game.actors, role: 'player', me: game.me, selected: new Set(), gmLayer: false, editor: false, fog: null, unseen: null }), [map, game.me, game.actors]);
  return <div className="hm-viewer">
    <MapCanvas rendererRef={rRef} scene={scene} handlers={{}} />
    <button className="hm-fit" title={t('Re-center')} onClick={() => rRef.current?.fit()}>⤢</button>
  </div>;
}

/** Rooms of a built home, add-ons first marked. */
function RoomList({ built }: { built: Omit<BuiltHome, 'layout'> }) {
  const { map, placed, skipped } = built;
  const addonNames = new Set(placed.map((p) => p.name));
  return <div className="hm-rooms">
    <div className="small muted">{t('{n} m² · {rooms} rooms', { n: homeArea(map), rooms: map.regions.length })}</div>
    <div className="hm-chips">
      {map.regions.map((r) => <span className={'hm-chip' + (addonNames.has(r.name) ? ' addon' : '')} key={r.id}>{r.name}</span>)}
    </div>
    {skipped.length > 0 && <div className="small warn-text">{t('No room left for: {list}', { list: skipped.map((s) => s.name).join(', ') })}</div>}
  </div>;
}

interface ChooserProps {
  lifestyle: Lifestyle;
  current: HomeLayoutDef | null;
  canMove: boolean;
  gm: boolean;
  onPick: (lay: HomeLayoutDef, fee: number) => void;
  /** Fee of a pick (default: a move when a flat is already chosen). The city map passes it: a new spot is a move too. */
  fee?: number;
  /** Shown before the options (city map: « Garder le logement actuel »). */
  extra?: ReactNode;
  /** The current flat can be picked again (the move is about the spot). */
  allowCurrent?: boolean;
}
/** Option cards of the lifestyle level's layouts. Exported for the city map (pick the flat after the spot). */
export function Chooser({ lifestyle, current, canMove, gm, onPick, fee: feeIn, extra, allowCurrent }: ChooserProps) {
  const layouts = layoutsFor(lifestyle.base);
  const fee: number = feeIn ?? (current && !gm ? homeMoveCost(lifestyle) : 0);
  const moving = feeIn !== undefined ? feeIn > 0 || !!current || !!lifestyle.place : !!current;
  const builds = useMemo(() => layouts.map((lay) => build(lifestyle, lay.id, { tr: t })), [lifestyle, layouts.length]);
  return <div className="hm-choose">
    <p className="small muted">
      {moving
        ? fee ? t('Moving costs one month of base rent: {cost}. The new home is then fixed until the next move.', { cost: fmtNuyen(fee) }) : gm ? t('The GM moves runners for free.') : ''
        : t('Choose where your runner lives. This first pick is free, then fixed: changing later is a paid move.')}
      {' '}{t('Lifestyle options (garage, workshop, yard…) are added to the plan.')}
    </p>
    {extra}
    <div className="hm-options">
      {builds.map(({ layout: lay, map, ...rest }) => <div className={'hm-option' + (current?.id === lay.id ? ' current' : '')} key={lay.id}>
      <div className="hm-option-head"><b>{t(lay.name)}</b>{current?.id === lay.id && <span className="badge badge-cyan">{t('current')}</span>}</div>
      <div className="hm-preview-box"><HomePreview map={map} /></div>
      <div className="small">{t(lay.desc)}</div>
      <RoomList built={{ map, ...rest }} />
      {canMove && (allowCurrent || current?.id !== lay.id) && <Button small variant="primary" onClick={() => onPick(lay, fee)}>
        {moving ? (fee ? t('Move here ({cost})', { cost: fmtNuyen(fee) }) : t('Move here')) : t('Move in here')}
      </Button>}
    </div>)}
    </div>
  </div>;
}

export function HomeModal({ game, actor, lifestyle, canMove, onClose }: HomeProps & { onClose: () => void }) {
  const gm = game.me?.role === 'gm';
  const current = layoutOf(lifestyle);
  const [choosing, setChoosing] = useState(!current);
  const [busy, setBusy] = useState(false);
  const built = useMemo(() => (current ? build(lifestyle, current.id, { tr: t }) : null), [lifestyle, current?.id]);
  // The flat's table map (created by the server when the flat was picked): GM in `maps`, players in `homeMaps`.
  const mapId = lifestyle.home?.mapId;
  const realMap = mapId ? (gm ? game.maps?.[mapId] : game.homeMaps?.[mapId]) || null : null;
  const addons = homeAddons(lifestyle).map((a) => a.key).sort().join(',');
  const stale = !!realMap && (lifestyle.home?.addons ?? '') !== addons;
  const missing = !!current && !realMap && (gm || canMove);

  const pick = async (lay: HomeLayoutDef, fee: number) => {
    if (current) {
      const msg = fee
        ? t('Move to “{name}” for {cost}? The money is taken from {actor}; the old home’s map is kept as a former home.', { name: t(lay.name), cost: fmtNuyen(fee), actor: actor.name })
        : t('Move to “{name}”?', { name: t(lay.name) });
      if (!(await confirmAction(msg))) return;
    } else if (!(await confirmAction(t('Move into “{name}”? Changing homes later will be a paid move.', { name: t(lay.name) })))) return;
    setBusy(true);
    try {
      await send('shop/move', { actorId: actor.id, lifestyleId: lifestyle.id, layout: lay.id });
      setChoosing(false);
    } catch {
      // error toast shown by send()
    } finally {
      setBusy(false);
    }
  };

  /** Create the flat's map (GM deleted it) or rebuild it after the options changed. */
  const remakeMap = async () => {
    setBusy(true);
    try {
      await send('shop/homeMap', { actorId: actor.id, lifestyleId: lifestyle.id });
      toast(stale ? t('Home map updated') : t('Home map created'), 'success');
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const openInMaps = () => {
    if (!realMap) return;
    setUI({ mapsEditId: realMap.id });
    goTab('maps');
    onClose();
  };

  const title = <>🏠 {lifestyle.name || lifestyleBaseLabel(lifestyle.base)}{' '}<span className="muted small">{lifestyleBaseLabel(lifestyle.base)}</span></>;
  const actions = <>
    {current && canMove && <Button small variant={choosing ? 'ghost' : 'default'} disabled={busy} onClick={() => setChoosing(!choosing)}>
      {choosing ? t('Back to the plan') : t('Move…')}
    </Button>}
    {!choosing && (missing || (stale && (gm || canMove))) && <Button small variant="accent" disabled={busy} onClick={remakeMap}
      title={stale ? t('The lifestyle options changed: rebuild the walls and rooms of the map (tokens and notes are kept)') : t('Create this home’s table map')}>
      {stale ? t('Update the map') : t('Create the map')}
    </Button>}
    {gm && realMap && !choosing && <Button small variant="ghost" onClick={openInMaps} title={t('Edit this home’s map or show it to the players from the Maps tab')}>
      {t('Open in Maps')}
    </Button>}
  </>;

  return <Modal title={title} onClose={onClose} width={choosing ? 1100 : 980} actions={actions}>
    {choosing || !current || !built
      ? <Chooser lifestyle={lifestyle} current={current} canMove={canMove && !busy} gm={gm} onPick={pick} />
      : <div className="hm-main">
        <HomeViewer key={realMap ? `${realMap.id}:${realMap.width}x${realMap.height}` : `${built.map.width}x${built.map.height}`} game={game} map={realMap || built.map} />
        <div className="hm-side">
          <div><b>{t(current.name)}</b></div>
          <div className="small">{t(current.desc)}</div>
          <RoomList built={built} />
          {stale && <div className="small warn-text">{t('The options changed since the map was made: update it to see them.')}</div>}
          <PlaceInfo game={game} lifestyle={lifestyle} />
          {lifestyle.home?.since ? <div className="small faint">{t('Since {date}', { date: fmtDate(lifestyle.home.since) })}</div> : null}
          <div className="small faint">{t('Drag to pan, scroll to zoom.')}</div>
        </div>
      </div>}
  </Modal>;
}

/** District of the home (city map) and the security rating of its housing type (SR5 p. 352). */
export function PlaceInfo({ game, lifestyle }: { game: GameView; lifestyle: Lifestyle }) {
  const district = lifestyle.place?.district ? game.city?.districts.find((d) => d.id === lifestyle.place!.district) : null;
  const rating = homeSecurity(lifestyle.base);
  return <>
    {lifestyle.place && <div className="small">📍 {district ? district.name : t('Outside the districts')}</div>}
    {rating && <div className="small hm-security">
      {t('Neighborhood security: {rating} — security response in {time}', { rating, time: HTR_RESPONSE[rating] })}{' '}
      <BookRef source={HTR_REF.source} page={HTR_REF.page} />
    </div>}
  </>;
}

/** Lifestyle card: « 📍 Renton » (or « Placer sur la carte ») → Seattle tab, focused on that home or placing it. */
export function CityPlaceButton({ game, actor, lifestyle }: { game: GameView; actor: Actor; lifestyle: Lifestyle }) {
  if (!game.city?.map) return null;
  const d = lifestyle.place ? game.city.districts.find((x) => x.id === lifestyle.place!.district)?.name || t('Outside the districts') : null;
  const go = () => {
    setUI({ cityFocus: { actorId: actor.id, lifestyleId: lifestyle.id, place: !lifestyle.place }, sheetActorId: null });
    goTab('city');
  };
  return <Button small variant="ghost" className="hm-btn" onClick={go} title={t('Show on the city map')}>📍 {d || t('Place on the map')}</Button>;
}
