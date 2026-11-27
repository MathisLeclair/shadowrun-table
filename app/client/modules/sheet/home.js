// Home of a lifestyle (shared/home.js): map viewer, first pick among a few layouts, moving (paid), GM « play map ».
// Opened from the lifestyle cards of the sheet (« Contacts & SIN »), for the GM and the runner's owner.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, Modal, confirmAction, loadCss } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { setUI, goTab, toast } from '../../lib/ui-store.js';
import { t, fmtNuyen } from '../../lib/i18n.js';
import { homeLayoutsFor, homeLayout, homeMoveCost, buildHome, homeArea } from '/shared/home.js';
import { MapCanvas } from '../map/MapCanvas.js';
import { drawStaticMap } from '../map/renderer.js';
import { lifestyleBaseLabel } from './sublists.js';
import { fmtDate } from './common.js';

loadCss('/modules/sheet/home.css');

/** Does this lifestyle level have homes to draw (Street: no)? */
export const hasHomes = (l) => homeLayoutsFor(l?.base).length > 0;

/** Button on a lifestyle card: « 🏠 Logement » (name of the layout once chosen). */
export function HomeButton({ game, actor, lifestyle, canMove }) {
  const [open, setOpen] = useState(false);
  if (!hasHomes(lifestyle)) return null;
  const lay = homeLayout(lifestyle);
  return html`<span class="hm-btn-wrap">
    <${Button} small variant=${lay ? 'ghost' : 'primary'} class="hm-btn" onClick=${() => setOpen(true)}
      title=${lay ? t('Voir le plan du logement') : t('Choisir le logement de ce train de vie')}>
      🏠 ${lay ? t(lay.name) : t('Choisir un logement')}
    </${Button}>
    ${open && html`<${HomeModal} game=${game} actor=${actor} lifestyle=${lifestyle} canMove=${canMove} onClose=${() => setOpen(false)} />`}
  </span>`;
}

/** Flat drawing of a home (chooser cards). */
function HomePreview({ map, max = 280 }) {
  const ref = useRef(null);
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, map.width * S, map.height * S);
    try {
      drawStaticMap(ctx, map, S);
    } catch (err) {
      console.error('[home] preview failed', err);
    }
  }, [map, max]);
  return html`<canvas class="hm-preview" ref=${ref}></canvas>`;
}

/** Pan / zoom view of a home with the map renderer (no tokens, no fog). */
function HomeViewer({ game, map }) {
  const rRef = useRef(null);
  const scene = useMemo(() => ({ map, actors: {}, role: 'player', me: game.me, selected: new Set(), gmLayer: false, editor: false, fog: null, unseen: null }), [map, game.me]);
  return html`<div class="hm-viewer">
    <${MapCanvas} rendererRef=${rRef} scene=${scene} handlers=${{}} />
    <button class="hm-fit" title=${t('Recentrer')} onClick=${() => rRef.current?.fit()}>⤢</button>
  </div>`;
}

/** Rooms of a built home, add-ons first marked. */
function RoomList({ built }) {
  const { map, placed, skipped } = built;
  const addonNames = new Set(placed.map((p) => p.name));
  return html`<div class="hm-rooms">
    <div class="small muted">${t('{n} m² · {rooms} pièces', { n: homeArea(map), rooms: map.regions.length })}</div>
    <div class="hm-chips">${map.regions.map((r) => html`<span class=${'hm-chip' + (addonNames.has(r.name) ? ' addon' : '')} key=${r.id}>${r.name}</span>`)}</div>
    ${skipped.length > 0 && html`<div class="small warn-text">${t('Pas de place pour : {list}', { list: skipped.map((s) => s.name).join(', ') })}</div>`}
  </div>`;
}

function Chooser({ lifestyle, current, canMove, gm, onPick }) {
  const layouts = homeLayoutsFor(lifestyle.base);
  const fee = current && !gm ? homeMoveCost(lifestyle) : 0;
  const builds = useMemo(() => layouts.map((lay) => buildHome(lifestyle, lay.id, { tr: t })), [lifestyle, layouts.length]);
  return html`<div class="hm-choose">
    <p class="small muted">
      ${current
        ? fee ? t('Déménager coûte un mois de loyer de base : {cost}. Le nouveau logement est ensuite fixé jusqu’au prochain déménagement.', { cost: fmtNuyen(fee) }) : t('Le MJ déménage gratuitement.')
        : t('Choisis où vit ton personnage. Ce choix est gratuit, puis fixé : en changer plus tard est un déménagement payant.')}
      ${' '}${t('Les options du train de vie (garage, atelier, cour…) sont ajoutées au plan.')}
    </p>
    <div class="hm-options">${builds.map(({ layout: lay, map, ...rest }) => html`<div class=${'hm-option' + (current?.id === lay.id ? ' current' : '')} key=${lay.id}>
      <div class="hm-option-head"><b>${t(lay.name)}</b>${current?.id === lay.id && html`<span class="badge badge-cyan">${t('actuel')}</span>`}</div>
      <div class="hm-preview-box"><${HomePreview} map=${map} /></div>
      <div class="small">${t(lay.desc)}</div>
      <${RoomList} built=${{ map, ...rest }} />
      ${canMove && current?.id !== lay.id && html`<${Button} small variant="primary" onClick=${() => onPick(lay, fee)}>
        ${current ? (fee ? t('Déménager ici ({cost})', { cost: fmtNuyen(fee) }) : t('Déménager ici')) : t('Emménager ici')}</${Button}>`}
    </div>`)}</div>
  </div>`;
}

export function HomeModal({ game, actor, lifestyle, canMove, onClose }) {
  const gm = game.me?.role === 'gm';
  const current = homeLayout(lifestyle);
  const [choosing, setChoosing] = useState(!current);
  const [busy, setBusy] = useState(false);
  const built = useMemo(() => (current ? buildHome(lifestyle, current.id, { tr: t }) : null), [lifestyle, current?.id]);

  const pick = async (lay, fee) => {
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
    if (!built) return;
    const map = { ...built.map, id: undefined, name: t('Logement de {actor} — {name}', { actor: actor.name, name: t(current.name) }), folder: t('Logements'), fog: true };
    try {
      const id = await send('maps/import', { map });
      toast(t('Carte « {name} » créée', { name: map.name }), 'success');
      setUI({ mapsEditId: id });
      goTab('maps');
      onClose();
    } catch {}
  };

  const title = html`🏠 ${lifestyle.name || lifestyleBaseLabel(lifestyle.base)} <span class="muted small">${lifestyleBaseLabel(lifestyle.base)}</span>`;
  const actions = html`${current && canMove && html`<${Button} small variant=${choosing ? 'ghost' : 'default'} disabled=${busy} onClick=${() => setChoosing(!choosing)}>
      ${choosing ? t('Retour au plan') : t('Déménager…')}</${Button}>`}
    ${gm && built && !choosing && html`<${Button} small variant="accent" onClick=${toPlayMap} title=${t('Copie ce plan dans les cartes de la table, pour y jouer une scène')}>${t('Créer une carte de jeu')}</${Button}>`}`;

  return html`<${Modal} title=${title} onClose=${onClose} width=${choosing ? 1100 : 980} actions=${actions}>
    ${choosing || !current
      ? html`<${Chooser} lifestyle=${lifestyle} current=${current} canMove=${canMove && !busy} gm=${gm} onPick=${pick} />`
      : html`<div class="hm-main">
          <${HomeViewer} key=${`${built.map.width}x${built.map.height}`} game=${game} map=${built.map} />
          <div class="hm-side">
            <div><b>${t(current.name)}</b></div>
            <div class="small">${t(current.desc)}</div>
            <${RoomList} built=${built} />
            ${lifestyle.home?.since ? html`<div class="small faint">${t('Depuis le {date}', { date: fmtDate(lifestyle.home.since) })}</div>` : null}
            <div class="small faint">${t('Glisser pour déplacer, molette pour zoomer.')}</div>
          </div>
        </div>`}
  </${Modal}>`;
}
