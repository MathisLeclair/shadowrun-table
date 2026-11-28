// « Seattle » tab: the city map (table map image + traced districts, game.city) with the homes of the user's runners.
// Level 2: the whole city, hover a district to see its name, pins on homes. Level 3: click a district to zoom in; the rest
// of the city is dimmed and the side panel lists its security rating (only when SR5 gives one) and the homes there.
// A pin opens the home plan (sheet/home.tsx). Placing / moving a home: click « Place on the map » then a spot, then pick
// the flat — one paid move for both (shop/move). GM: every runner's home, invitations, city map and district names.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Select, TextInput, Empty, confirmAction } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { setUI, useUI } from '../../lib/ui-store.ts';
import { t, fmtNuyen } from '../../lib/i18n.ts';
import { MapCanvas, type MapPointerInfo } from '../map/MapCanvas.tsx';
import { initials, type MapRenderer, type MapScene, type ViewTransform } from '../map/renderer.ts';
import { HomeModal, Chooser, PlaceInfo, hasHomes } from '../sheet/home.tsx';
import { lifestyleBaseLabel } from '../sheet/sublists.tsx';
import { BookRef } from '../books/BookRef.tsx';
import { districtAt, districtBBox, guessDistrict, HTR_RESPONSE } from '/shared/city.ts';
import { homeLayout, homeMoveCost } from '/shared/home.ts';
import type { Actor, CityDistrict, CityPin, GameMap, GameView, Lifestyle } from '../../../shared/types.ts';
import './city.css';

const PIN_R = 13;

/** SVG path of a district's rings (cells). */
const ringsPath = (d: Pick<CityDistrict, 'rings'>): string =>
  d.rings.map((r) => 'M' + r.map(([x, y]) => `${x} ${y}`).join('L') + 'Z').join('');

/** A runner's lifestyles the user may place / move (own runners; GM: every PC). */
function placeableLifestyles(game: GameView): Array<{ actor: Actor; lifestyle: Lifestyle }> {
  const gm = game.me.role === 'gm';
  const ids = gm ? Object.keys(game.actors).filter((id) => (game.actors[id] as Actor).type === 'pc' && !(game.actors[id] as Actor).retired) : game.me.characterIds || [];
  const out: Array<{ actor: Actor; lifestyle: Lifestyle }> = [];
  for (const id of ids) {
    const a = game.actors[id] as Actor | undefined;
    for (const l of a?.lifestyles || []) out.push({ actor: a!, lifestyle: l });
  }
  return out;
}

interface Placing {
  actorId: string;
  lifestyleId: string;
}
interface Spot extends Placing {
  x: number;
  y: number;
  district: string | null;
}

export default function CityPage({ game }: GameProps) {
  const city = game.city;
  const gm = game.me.role === 'gm';
  if (!city?.map) {
    return <div className="city-page city-empty">
      <Empty>{gm ? t('No city map on this table: pick the map that shows the city.') : t('There is no city map on this table yet.')}</Empty>
      {gm && <CitySettings game={game} />}
    </div>;
  }
  return <CityView game={game} />;
}

function CityView({ game }: GameProps) {
  const city = game.city;
  const cm = city.map!;
  const gm = game.me.role === 'gm';
  const rRef = useRef<MapRenderer | null>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<{ district: string | null; pin: CityPin | null; fx: number; fy: number } | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [openHome, setOpenHome] = useState<Placing | null>(null);
  const [invite, setInvite] = useState<CityPin | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const ui = useUI();

  // A plain image map for the renderer: no tiles drawn, no fog, no grid.
  const map = useMemo(
    () => ({
      id: `city:${cm.id}`, name: cm.name, width: cm.width, height: cm.height, metersPerCell: 1000,
      tiles: Array.from({ length: cm.height }, () => '.'.repeat(cm.width)), doors: [], lights: [], walls: [], regions: [], notes: [], tokens: [],
      explored: {}, fog: false, sharedVision: false, movementLocked: true, lighting: 'bright', theme: 'street', background: cm.background,
    }) as GameMap,
    [cm.id, cm.width, cm.height, cm.background?.url],
  );
  const scene = useMemo((): MapScene => ({ map, actors: {}, role: game.me.role, me: game.me, selected: new Set(), gmLayer: false, editor: false, fog: null, unseen: null, showGrid: false }), [map, game.me]);

  // Follow the renderer's view (pan included) to place the SVG overlay.
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const v = rRef.current?.view;
      if (v) {
        const k = `${v.scale.toFixed(4)}|${v.x.toFixed(1)}|${v.y.toFixed(1)}`;
        if (k !== last) {
          last = k;
          setView({ ...v });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const districts = city.districts;
  const byId = useMemo(() => new Map(districts.map((d) => [d.id, d])), [districts]);
  const paths = useMemo(() => new Map(districts.map((d) => [d.id, ringsPath(d)])), [districts]);
  const focused = focus ? byId.get(focus) || null : null;

  const zoomTo = (id: string | null) => {
    const r = rRef.current;
    const d = id ? byId.get(id) : null;
    setFocus(d ? d.id : null);
    if (!r) return;
    if (d) {
      const bb = districtBBox(d);
      r.fitRect(bb.x, bb.y, bb.w, bb.h, 450, 40);
    } else r.fitRect(0, 0, cm.width, cm.height, 450, 20);
  };

  const lifestyleOf = (p: Placing) => {
    const a = game.actors[p.actorId] as Actor | undefined;
    const l = a?.lifestyles?.find((x) => x.id === p.lifestyleId);
    return a && l ? { actor: a, lifestyle: l } : null;
  };

  const startPlacing = (p: Placing) => {
    const found = lifestyleOf(p);
    setPlacing(p);
    setSpot(null);
    // zoom on the current spot's district, else on the district named in the lifestyle
    const d = found?.lifestyle.place?.district || guessDistrict(`${found?.lifestyle.name || ''} ${found?.lifestyle.notes || ''}`, districts);
    if (d && d !== focus) zoomTo(d);
  };

  // Sheet → « 📍 » button: focus a home or start placing it.
  useEffect(() => {
    const req = ui.cityFocus as (Placing & { place?: boolean }) | null | undefined;
    if (!req) return;
    setUI({ cityFocus: null });
    const found = lifestyleOf(req);
    if (!found) return;
    if (req.place || !found.lifestyle.place) startPlacing(req);
    else {
      const p = found.lifestyle.place!;
      setFocus(p.district);
      setTimeout(() => rRef.current?.fitRect(p.x - 8, p.y - 6, 16, 12, 450), 50);
    }
  }, [ui.cityFocus]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal')) return;
      if (placing) setPlacing(null);
      else if (focus) zoomTo(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const toScreen = (x: number, y: number) => ({ x: view.x + x * view.scale, y: view.y + y * view.scale });
  const pinAt = (sx: number, sy: number): CityPin | null => {
    let best: CityPin | null = null, bd = PIN_R + 3;
    for (const p of city.pins) {
      const s = toScreen(p.x, p.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  const handlers = {
    onHover: (info: MapPointerInfo | null) => {
      if (!info) return setHover(null);
      setHover({ district: districtAt(districts, info.fx, info.fy)?.id || null, pin: pinAt(info.sx, info.sy), fx: info.fx, fy: info.fy });
    },
    onClick: (info: MapPointerInfo) => {
      if (placing) {
        if (info.fx < 0 || info.fy < 0 || info.fx > cm.width || info.fy > cm.height) return;
        setSpot({ ...placing, x: Math.round(info.fx * 100) / 100, y: Math.round(info.fy * 100) / 100, district: districtAt(districts, info.fx, info.fy)?.id || null });
        return;
      }
      const pin = pinAt(info.sx, info.sy);
      if (pin) return openPin(pin);
      const d = districtAt(districts, info.fx, info.fy);
      if (d && d.id !== focus) zoomTo(d.id);
      else if (!d && focus) zoomTo(null);
    },
  };

  const openPin = (pin: CityPin) => {
    if (pin.layout || (gm || pin.own)) setOpenHome({ actorId: pin.actorId, lifestyleId: pin.lifestyleId });
  };

  const hovered = hover?.district ? byId.get(hover.district) : null;
  const W = cm.width, H = cm.height;
  const homeOpen = openHome ? lifestyleOf(openHome) : null;
  const spotFor = spot ? lifestyleOf(spot) : null;
  const placingFor = placing ? lifestyleOf(placing) : null;
  const pinsIn = (id: string) => city.pins.filter((p) => p.district === id);

  return <div className="city-page">
    <div className={'city-map' + (placing ? ' placing' : '')}>
      <MapCanvas rendererRef={rRef} scene={scene} handlers={handlers} />
      <svg className="city-overlay" width="100%" height="100%">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {focused && <path className="city-dim" fillRule="evenodd" d={`M-1000 -1000H${W + 1000}V${H + 1000}H-1000Z${paths.get(focused.id)}`} />}
          {hovered && hovered.id !== focus && <path className="city-hover" fillRule="evenodd" d={paths.get(hovered.id)} />}
          {focused && <path className="city-focus" fillRule="evenodd" d={paths.get(focused.id)} />}
        </g>
        {city.pins.map((p) => {
          const s = toScreen(p.x, p.y);
          const a = game.actors[p.actorId] as Actor | undefined;
          return <g key={`${p.actorId}:${p.lifestyleId}`} className={'city-pin' + (p.own ? '' : ' guest') + (hover?.pin === p ? ' hot' : '')} transform={`translate(${s.x} ${s.y})`}>
            <path d={`M0 0 L-6 -${PIN_R + 2} A${PIN_R} ${PIN_R} 0 1 1 6 -${PIN_R + 2} Z`} style={{ fill: a?.color || undefined }} />
            <text y={-PIN_R - 8} textAnchor="middle">{initials(p.actor)}</text>
          </g>;
        })}
        {placing && hover && <g className="city-pin ghost" transform={`translate(${toScreen(hover.fx, hover.fy).x} ${toScreen(hover.fx, hover.fy).y})`}>
          <path d={`M0 0 L-6 -${PIN_R + 2} A${PIN_R} ${PIN_R} 0 1 1 6 -${PIN_R + 2} Z`} />
        </g>}
      </svg>
      {hover && !placing && (hover.pin || hovered) && <div className="city-tip" style={{ left: toScreen(hover.fx, hover.fy).x + 14, top: toScreen(hover.fx, hover.fy).y + 10 }}>
        {hover.pin ? <><b>{hover.pin.actor}</b> · {hover.pin.lifestyle}</> : hovered!.name}
      </div>}
      {placing && <div className="city-banner">
        {t('Click the map where « {name} » lives.', { name: placingFor?.lifestyle.name || '' })}
        <Button small variant="ghost" onClick={() => setPlacing(null)}>{t('Cancel')}</Button>
      </div>}
      <div className="city-tools">
        {focus && <Button small onClick={() => zoomTo(null)}>← {t('Whole city')}</Button>}
        <button className="city-fit" title={t('Re-center')} onClick={() => (focused ? zoomTo(focused.id) : zoomTo(null))}>⤢</button>
      </div>
    </div>

    <aside className="city-side">
      {focused ? <DistrictPanel game={game} district={focused} pins={pinsIn(focused.id)} onPin={openPin} onBack={() => zoomTo(null)} />
        : <div className="city-block">
          <h3>{cm.name}</h3>
          <div className="small muted">{t('Click a district to zoom in. Drag to pan, scroll to zoom.')}</div>
        </div>}

      <HomesList game={game} onPlace={startPlacing} onOpen={(p) => setOpenHome(p)} onInvite={setInvite} onShow={(p) => {
        const f = lifestyleOf(p);
        const pl = f?.lifestyle.place;
        if (!pl) return;
        setFocus(pl.district);
        rRef.current?.fitRect(pl.x - 8, pl.y - 6, 16, 12, 450);
      }} />

      {gm && <div className="city-block">
        <Button small variant="ghost" onClick={() => setShowSettings(!showSettings)}>⚙ {t('City map settings')}</Button>
        {showSettings && <CitySettings game={game} />}
      </div>}
    </aside>

    {homeOpen && <HomeModal game={game} actor={homeOpen.actor} lifestyle={homeOpen.lifestyle} canMove={gm || (game.me.characterIds || []).includes(homeOpen.actor.id)} onClose={() => setOpenHome(null)} />}
    {spot && spotFor && <SpotModal game={game} spot={spot} actor={spotFor.actor} lifestyle={spotFor.lifestyle} onClose={() => setSpot(null)} onDone={() => {
      setSpot(null);
      setPlacing(null);
      if (spot.district && spot.district !== focus) zoomTo(spot.district);
    }} />}
    {invite && <InviteModal game={game} pin={invite} onClose={() => setInvite(null)} />}
  </div>;
}

/** Level 3 side panel: district name, ratings the source gives, homes there. */
function DistrictPanel({ game, district, pins, onPin, onBack }: { game: GameView; district: CityDistrict; pins: CityPin[]; onPin: (p: CityPin) => void; onBack: () => void }) {
  return <div className="city-block">
    <div className="row spread">
      <h3 className="city-dname"><span className="city-swatch" style={{ background: district.color }} />{district.name}</h3>
      <Button small variant="ghost" onClick={onBack}>{t('Whole city')}</Button>
    </div>
    {(district.security || []).map((s) => <div className="small city-sec" key={s.area}>
      {t('{area}: security {rating}, response in {time}', { area: s.area, rating: s.rating, time: HTR_RESPONSE[s.rating] })}{' '}
      <BookRef source={s.source} page={s.page} />
    </div>)}
    {!district.security?.length && <div className="small faint">{t('The rulebooks give no security rating for this district.')}</div>}
    <div className="city-sub">{t('Homes here')}</div>
    {pins.length ? pins.map((p) => <button key={`${p.actorId}:${p.lifestyleId}`} className="city-home-link" onClick={() => onPin(p)}>
      <b>{p.actor}</b> · {p.lifestyle} <span className="faint">{lifestyleBaseLabel(p.base)}</span>
    </button>) : <div className="small faint">{t('No home you know of.')}</div>}
  </div>;
}

/** « My homes » (GM: every runner): place / move, plan, invitations; then the homes the user was invited to. */
function HomesList({ game, onPlace, onOpen, onInvite, onShow }: { game: GameView; onPlace: (p: Placing) => void; onOpen: (p: Placing) => void; onInvite: (p: CityPin) => void; onShow: (p: Placing) => void }) {
  const gm = game.me.role === 'gm';
  const rows = placeableLifestyles(game);
  const guestPins = game.city.pins.filter((p) => !p.own);
  const dName = (id: string | null | undefined) => (id ? game.city.districts.find((d) => d.id === id)?.name || id : null);
  const unplace = async (p: Placing, name: string) => {
    if (await confirmAction(t('Take « {name} » off the map? The player places it again for free.', { name }))) send('city/unplace', p).catch(() => {});
  };
  return <div className="city-block">
    <div className="city-sub">{gm ? t('Runners’ homes') : t('My homes')}</div>
    {!rows.length && <div className="small faint">{t('No lifestyle yet.')}</div>}
    {rows.map(({ actor, lifestyle: l }) => {
      const p = { actorId: actor.id, lifestyleId: l.id };
      const pin = game.city.pins.find((x) => x.actorId === actor.id && x.lifestyleId === l.id);
      const lay = homeLayout(l);
      return <div className="city-home" key={`${actor.id}:${l.id}`}>
        <div className="city-home-head">
          {gm && <b>{actor.name}</b>} <span>{l.name}</span> <span className="faint small">{lifestyleBaseLabel(l.base)}</span>
        </div>
        <div className="small">
          {l.place ? <button className="city-link" onClick={() => onShow(p)}>📍 {dName(l.place.district) || t('Outside the districts')}</button> : <span className="faint">{t('Not on the map yet')}</span>}
          {lay && <span className="faint"> · 🏠 {t(lay.name)}</span>}
        </div>
        <div className="row wrap gap-s">
          <Button small variant={l.place ? 'ghost' : 'primary'} onClick={() => onPlace(p)}>{l.place ? t('Move…') : t('Place on the map')}</Button>
          {hasHomes(l) && <Button small variant="ghost" onClick={() => onOpen(p)}>🏠 {lay ? t('Plan') : t('Choose a home')}</Button>}
          {gm && pin && <Button small variant="ghost" onClick={() => onInvite(pin)}>{t('Invite…')}{pin.guests.length ? ` (${pin.guests.length})` : ''}</Button>}
          {gm && l.place && <Button small variant="ghost" onClick={() => unplace(p, l.name)}>{t('Remove from the map')}</Button>}
        </div>
      </div>;
    })}
    {!gm && guestPins.length > 0 && <>
      <div className="city-sub">{t('Invited to')}</div>
      {guestPins.map((pin) => <div className="city-home" key={`${pin.actorId}:${pin.lifestyleId}`}>
        <button className="city-link" onClick={() => onShow({ actorId: pin.actorId, lifestyleId: pin.lifestyleId })}>📍 {t('At {name}’s', { name: pin.actor })} · {dName(pin.district) || t('Outside the districts')}</button>
        {pin.layout && <Button small variant="ghost" onClick={() => onOpen({ actorId: pin.actorId, lifestyleId: pin.lifestyleId })}>🏠 {t('Plan')}</Button>}
      </div>)}
    </>}
  </div>;
}

/** After a click on the map: keep or pick the flat, one confirm, one fee (shop/move). */
function SpotModal({ game, spot, actor, lifestyle, onClose, onDone }: { game: GameView; spot: Spot; actor: Actor; lifestyle: Lifestyle; onClose: () => void; onDone: () => void }) {
  const gm = game.me.role === 'gm';
  const [busy, setBusy] = useState(false);
  const current = homeLayout(lifestyle);
  const cost = gm ? 0 : homeMoveCost(lifestyle);
  const dName = spot.district ? game.city.districts.find((d) => d.id === spot.district)?.name || spot.district : t('Outside the districts');
  // fee when keeping the flat: only if the spot was already set; when changing the flat: if either was set
  const feeKeep = lifestyle.place ? cost : 0;
  const feeChange = lifestyle.place || current ? cost : 0;

  const go = async (layout: string | null, fee: number, label: string) => {
    const moving = !!lifestyle.place || (!!layout && !!current);
    const msg = fee
      ? t('Move « {name} » to {district} for {cost}? The money is taken from {actor}.', { name: label, district: dName, cost: fmtNuyen(fee), actor: actor.name })
      : moving ? t('Move « {name} » to {district}?', { name: label, district: dName }) : t('Settle « {name} » in {district}? Changing it later will be a paid move.', { name: label, district: dName });
    if (!(await confirmAction(msg))) return;
    setBusy(true);
    try {
      await send('shop/move', { actorId: actor.id, lifestyleId: lifestyle.id, x: spot.x, y: spot.y, ...(layout ? { layout } : {}) });
      onDone();
    } catch {
      setBusy(false);
    }
  };

  const keep = current || !hasHomes(lifestyle)
    ? <div className="city-keep">
      <Button variant="primary" disabled={busy} onClick={() => go(null, feeKeep, lifestyle.name)}>
        {current ? t('Keep « {name} » here', { name: t(current.name) }) : t('Settle here')}{feeKeep ? ` (${fmtNuyen(feeKeep)})` : ''}
      </Button>
      {current && <div className="small faint">{t('Or pick another home:')}</div>}
    </div>
    : null;

  return <Modal title={<>📍 {dName} <span className="muted small">{lifestyle.name}</span></>} onClose={onClose} width={hasHomes(lifestyle) ? 1100 : 520}>
    <PlaceInfo game={game} lifestyle={{ ...lifestyle, place: { x: spot.x, y: spot.y, district: spot.district, at: 0 } }} />
    {hasHomes(lifestyle)
      ? <Chooser lifestyle={lifestyle} current={current} canMove={!busy} gm={gm} fee={feeChange} extra={keep} onPick={(lay) => go(lay.id, feeChange, t(lay.name))} />
      : keep}
  </Modal>;
}

/** GM: which runners' players see this home. */
function InviteModal({ game, pin, onClose }: { game: GameView; pin: CityPin; onClose: () => void }) {
  const pcs = Object.values(game.actors).filter((a) => (a as Actor).type === 'pc' && a.id !== pin.actorId && !(a as Actor).retired) as Actor[];
  const [sel, setSel] = useState<Set<string>>(new Set(pin.guests));
  const save = async () => {
    try {
      await send('city/invite', { actorId: pin.actorId, lifestyleId: pin.lifestyleId, guests: [...sel] });
      onClose();
    } catch {}
  };
  return <Modal title={t('Who knows where {name} lives?', { name: pin.actor })} onClose={onClose} width={440} actions={<Button variant="primary" onClick={save}>{t('Save')}</Button>}>
    <p className="small muted">{t('The players of these runners see this home on their map and can open its plan (for instance after a scene there).')}</p>
    <div className="col gap-s">
      {pcs.map((a) => <label className="row gap-s" key={a.id}>
        <input type="checkbox" checked={sel.has(a.id)} onChange={(e) => {
          const n = new Set(sel);
          if (e.target.checked) n.add(a.id);
          else n.delete(a.id);
          setSel(n);
        }} />
        {a.name}
      </label>)}
    </div>
  </Modal>;
}

/** GM: which table map is the city, district names. */
function CitySettings({ game }: { game: GameView }) {
  const maps = Object.values(game.maps || {}).filter((m) => m.background?.url && m.background.mode === 'image');
  const value = game.city.map?.id || '';
  return <div className="city-settings col gap-s">
    <label className="small">{t('City map')}</label>
    <Select value={value} onChange={(v) => send('city/settings', { mapId: v || null }).catch(() => {})}
      options={[{ value: '', label: t('— Guess from the image —') }, ...maps.map((m) => ({ value: m.id, label: m.name }))]} />
    {game.city.map && !game.city.districts.length && <div className="small warn-text">{t('No districts were traced for this image (tools/city-districts.ts).')}</div>}
    {game.city.districts.length > 0 && <>
      <label className="small">{t('District names')}</label>
      {game.city.districts.map((d) => <div className="row gap-s city-rename" key={d.id}>
        <span className="city-swatch" style={{ background: d.color }} />
        <TextInput value={d.name} onChange={(v) => send('city/settings', { names: { [d.id]: v } }).catch(() => {})} />
      </div>)}
    </>}
  </div>;
}
