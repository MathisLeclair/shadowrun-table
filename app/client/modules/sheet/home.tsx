// Home of a lifestyle (shared/home.js): map viewer, first pick among a few layouts, moving (paid), GM « play map ».
// Opened from the lifestyle cards of the sheet (« Contacts & SIN »), for the GM and the runner's owner.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { setUI, goTab, toast } from '../../lib/ui-store.ts';
import { t, fmtNuyen } from '../../lib/i18n.ts';
import { homeLayoutsFor, homeLayout, homeMoveCost, buildHome, homeArea, type HomeBuild, type HomeLayout, type HomeMap } from '/shared/home.ts';
import { drawStaticMap, type MapRenderer, type MapScene } from '../map/renderer.ts';
import { lifestyleBaseLabel } from './sublists.tsx';
import { fmtDate } from './common.tsx';

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
    <Button small variant={lay ? 'ghost' : 'primary'} className="hm-btn" onClick={() => setOpen(true)} title={lay ? t('Voir le plan du logement') : t('Choisir le logement de ce train de vie')}>
      🏠 {lay ? t(lay.name) : t('Choisir un logement')}
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
function HomeViewer({ game, map }: { game: GameView; map: HomeMap }) {
  const rRef = useRef<MapRenderer | null>(null);
  // A drawn home has every field of a table map the renderer reads.
  const scene = useMemo((): MapScene => ({ map: map as GameMap, actors: {}, role: 'player', me: game.me, selected: new Set(), gmLayer: false, editor: false, fog: null, unseen: null }), [map, game.me]);
  return <div className="hm-viewer">
    <MapCanvas rendererRef={rRef} scene={scene} handlers={{}} />
    <button className="hm-fit" title={t('Recentrer')} onClick={() => rRef.current?.fit()}>⤢</button>
  </div>;
}

/** Rooms of a built home, add-ons first marked. */
function RoomList({ built }: { built: Omit<BuiltHome, 'layout'> }) {
  const { map, placed, skipped } = built;
  const addonNames = new Set(placed.map((p) => p.name));
  return <div className="hm-rooms">
    <div className="small muted">{t('{n} m² · {rooms} pièces', { n: homeArea(map), rooms: map.regions.length })}</div>
    <div className="hm-chips">
      {map.regions.map((r) => <span className={'hm-chip' + (addonNames.has(r.name) ? ' addon' : '')} key={r.id}>{r.name}</span>)}
    </div>
    {skipped.length > 0 && <div className="small warn-text">{t('Pas de place pour : {list}', { list: skipped.map((s) => s.name).join(', ') })}</div>}
  </div>;
}

interface ChooserProps {
  lifestyle: Lifestyle;
  current: HomeLayoutDef | null;
  canMove: boolean;
  gm: boolean;
  onPick: (lay: HomeLayoutDef, fee: number) => void;
}
function Chooser({ lifestyle, current, canMove, gm, onPick }: ChooserProps) {
  const layouts = layoutsFor(lifestyle.base);
  const fee: number = current && !gm ? homeMoveCost(lifestyle) : 0;
  const builds = useMemo(() => layouts.map((lay) => build(lifestyle, lay.id, { tr: t })), [lifestyle, layouts.length]);
  return <div className="hm-choose">
    <p className="small muted">
      {current
        ? fee ? t('Déménager coûte un mois de loyer de base : {cost}. Le nouveau logement est ensuite fixé jusqu’au prochain déménagement.', { cost: fmtNuyen(fee) }) : t('Le MJ déménage gratuitement.')
        : t('Choisis où vit ton personnage. Ce choix est gratuit, puis fixé : en changer plus tard est un déménagement payant.')}
      {' '}{t('Les options du train de vie (garage, atelier, cour…) sont ajoutées au plan.')}
    </p>
    <div className="hm-options">
      {builds.map(({ layout: lay, map, ...rest }) => <div className={'hm-option' + (current?.id === lay.id ? ' current' : '')} key={lay.id}>
      <div className="hm-option-head"><b>{t(lay.name)}</b>{current?.id === lay.id && <span className="badge badge-cyan">{t('actuel')}</span>}</div>
      <div className="hm-preview-box"><HomePreview map={map} /></div>
      <div className="small">{t(lay.desc)}</div>
      <RoomList built={{ map, ...rest }} />
      {canMove && current?.id !== lay.id && <Button small variant="primary" onClick={() => onPick(lay, fee)}>
        {current ? (fee ? t('Déménager ici ({cost})', { cost: fmtNuyen(fee) }) : t('Déménager ici')) : t('Emménager ici')}
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

  const pick = async (lay: HomeLayoutDef, fee: number) => {
    if (current) {
      const msg = fee
        ? t('Déménager vers « {name} » pour {cost} ? L’argent est retiré de {actor} et l’ancien logement est perdu.', { name: t(lay.name), cost: fmtNuyen(fee), actor: actor.name })
        : t('Déménager vers « {name} » ?', { name: t(lay.name) });
      if (!(await confirmAction(msg))) return;
    } else if (!(await confirmAction(t('Emménager dans « {name} » ? Ensuite, changer de logement sera un déménagement payant.', { name: t(lay.name) })))) return;
    setBusy(true);
    try {
      await send('shop/chooseHome', { actorId: actor.id, lifestyleId: lifestyle.id, layout: lay.id });
      setChoosing(false);
    } catch {
      // error toast shown by send()
    } finally {
      setBusy(false);
    }
  };

  const toPlayMap = async () => {
    if (!built || !current) return;
    const map = { ...built.map, id: undefined, name: t('Logement de {actor} — {name}', { actor: actor.name, name: t(current.name) }), folder: t('Logements'), fog: true };
    try {
      const id = await send<string>('maps/import', { map });
      toast(t('Carte « {name} » créée', { name: map.name }), 'success');
      setUI({ mapsEditId: id });
      goTab('maps');
      onClose();
    } catch {}
  };

  const title = <>🏠 {lifestyle.name || lifestyleBaseLabel(lifestyle.base)}{' '}<span className="muted small">{lifestyleBaseLabel(lifestyle.base)}</span></>;
  const actions = <>
    {current && canMove && <Button small variant={choosing ? 'ghost' : 'default'} disabled={busy} onClick={() => setChoosing(!choosing)}>
      {choosing ? t('Retour au plan') : t('Déménager…')}
    </Button>}
    {gm && built && !choosing && <Button small variant="accent" onClick={toPlayMap} title={t('Copie ce plan dans les cartes de la table, pour y jouer une scène')}>
      {t('Créer une carte de jeu')}
    </Button>}
  </>;

  return <Modal title={title} onClose={onClose} width={choosing ? 1100 : 980} actions={actions}>
    {choosing || !current || !built
      ? <Chooser lifestyle={lifestyle} current={current} canMove={canMove && !busy} gm={gm} onPick={pick} />
      : <div className="hm-main">
        <HomeViewer key={`${built.map.width}x${built.map.height}`} game={game} map={built.map} />
        <div className="hm-side">
          <div><b>{t(current.name)}</b></div>
          <div className="small">{t(current.desc)}</div>
          <RoomList built={built} />
          {lifestyle.home?.since ? <div className="small faint">{t('Depuis le {date}', { date: fmtDate(lifestyle.home.since) })}</div> : null}
          <div className="small faint">{t('Glisser pour déplacer, molette pour zoomer.')}</div>
        </div>
      </div>}
  </Modal>;
}
