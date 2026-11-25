// Live battle map for the GM and the players: movement, doors, fog of war, pings, GM tools.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, Select, Toggle, Badge, Empty, SearchBox, NumberInput, loadCss, confirmAction, promptText } from '../../lib/ui.js';
import { send, useServerEvent } from '../../lib/net.js';
import { useUI, setUI, openSheet, toast } from '../../lib/ui-store.js';
import { derive } from '/shared/sr5.js';
import {
  buildGrid, findPath, pathLength, computeVisibility, createVisionContext, viewersForUser, decodeBits, orBits, isPcToken,
} from '/shared/vision.js';
import { MapCanvas } from './MapCanvas.js';
import { DISPO, LIGHTING_OPTIONS, STATUS_GLYPHS, isImageMap } from './renderer.js';

loadCss('/modules/map/map.css');

const STATUSES = ['à terre', 'inconscient', 'mort', 'étourdi', 'en feu', 'à couvert', 'caché', 'saignement'];
const DOOR_LABEL = { open: 'Ouverte', closed: 'Fermée', locked: 'Verrouillée' };
const NEXT_DOOR_STATE = { open: 'closed', closed: 'locked', locked: 'open' };
const TORCH = { radius: 6, color: '#fff1cc' };

/** Per-browser display preference (localStorage may be unavailable). */
function usePref(key, def) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? def : raw === '1';
    } catch {
      return def;
    }
  });
  const set = (next) => {
    setV(next);
    try { localStorage.setItem(key, next ? '1' : '0'); } catch {}
  };
  return [v, set];
}

/** Cells a player knows (explored ∪ visible) or null when fog is off. */
function decodeFog(map, userId) {
  const n = map.width * map.height;
  if (map.fog === false) return null;
  const visible = decodeBits(map.visible, n);
  const explored = decodeBits(map.explored?.[userId], n);
  orBits(explored, visible);
  return { visible, explored };
}

/** GM preview: the map as players see it (secret doors as walls, no GM data). */
function playerSideMap(map) {
  const secret = new Set((map.doors || []).filter((d) => d.kind === 'secret' && d.state !== 'open').map((d) => d.y * map.width + d.x));
  return {
    ...map,
    tiles: secret.size ? map.tiles.map((row, y) => row.replace(/./g, (ch, x) => (secret.has(y * map.width + x) ? '#' : ch))) : map.tiles,
    doors: (map.doors || []).filter((d) => !secret.has(d.y * map.width + d.x)).map((d) => (d.state === 'locked' ? { ...d, state: 'closed' } : d)),
    // segment doors: closed secret ones become plain walls, locked shows as closed (same as the server filter)
    walls: (map.walls || []).map((w) => {
      if (!w.door) return w;
      if (w.door.kind === 'secret' && w.door.state !== 'open') return { ...w, door: null };
      return { ...w, door: { ...w.door, kind: 'door', state: w.door.state === 'locked' ? 'closed' : w.door.state } };
    }),
    notes: [],
    regions: (map.regions || []).filter((r) => !r.gmOnly),
    lights: (map.lights || []).filter((l) => l.on !== false),
  };
}

export default function MapView({ game }) {
  const ui = useUI();
  const isGM = game.me.role === 'gm';
  const maps = game.maps || {};
  const activeId = game.scene?.activeMapId || null;
  const mapId = isGM
    ? ui.viewMapId && maps[ui.viewMapId]
      ? ui.viewMapId
      : activeId && maps[activeId]
        ? activeId
        : Object.keys(maps)[0] || null
    : activeId && maps[activeId]
      ? activeId
      : null;
  const map = mapId ? maps[mapId] : null;
  if (!map) {
    return html`<div class="map-root map-empty">
      <div class="map-empty-card">
        <div class="map-empty-glyph">⌖</div>
        ${isGM
          ? html`<h3>Aucune carte</h3><p class="muted">Crée ou importe une carte pour commencer.</p>
              <${Button} variant="primary" onClick=${() => setUI({ mainTab: 'maps' })}>Ouvrir les cartes</${Button}>`
          : html`<h3>Le MJ n'a pas encore affiché de carte</h3><p class="muted">Reste branché, chummer : la carte apparaîtra ici dès que le MJ l'affichera.</p>`}
      </div>
    </div>`;
  }
  return html`<${LiveMap} game=${game} map=${map} ui=${ui} isGM=${isGM} />`;
}

function LiveMap({ game, map, ui, isGM }) {
  const me = game.me;
  const actors = game.actors || {};
  const rRef = useRef(null);
  const dragRef = useRef(null);
  const tipRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const [preview, setPreview] = useState('');
  const [tintUnseen, setTintUnseen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [placing, setPlacing] = useState(null);
  const [spawnOpts, setSpawnOpts] = useState({ count: 1, hidden: false });
  const [toolsOpen, setToolsOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 700);
  const [tip, setTip] = useState(null);
  const [showWalls, setShowWalls] = usePref('sr.map.showWalls', true);
  const [showGrid, setShowGrid] = usePref('sr.map.showGrid', true);
  const hoverWallRef = useRef(null);
  const selected = useMemo(() => new Set(ui.selectedTokenIds || []), [ui.selectedTokenIds]);
  const own = useMemo(() => new Set(me.characterIds || []), [me.characterIds]);
  const ownsToken = (t) => !!t?.actorId && own.has(t.actorId);
  const mapRef = useRef(map);
  mapRef.current = map;
  const gameRef = useRef(game);
  gameRef.current = game;

  // Clear selection / transient UI when the displayed map changes.
  useEffect(() => {
    setMenu(null);
    setPlacing(null);
    dragRef.current = null;
    rRef.current?.setOverlay({});
    if ((ui.selectedTokenIds || []).length) setUI({ selectedTokenIds: [] });
  }, [map.id]);

  // ---------------- vision ----------------
  const view = useMemo(() => {
    const n = map.width * map.height;
    if (!isGM) {
      const fog = decodeFog(map, me.id);
      return { map, fog, known: fog ? fog.explored : null, tokenMask: null, unseen: null };
    }
    const needParty = preview || tintUnseen;
    let party = null;
    let vctx = null;
    if (needParty) {
      vctx = createVisionContext(map);
      party = computeVisibility(map, (map.tokens || []).filter((t) => isPcToken(t, actors)), actors, vctx);
    }
    if (preview) {
      const shown = playerSideMap(map);
      if (map.fog === false) return { map: shown, fog: null, known: null, tokenMask: null, unseen: null, preview: true };
      let visible, explored;
      if (preview === 'party') {
        visible = party;
        explored = new Uint8Array(n);
        for (const enc of Object.values(map.explored || {})) orBits(explored, decodeBits(enc, n));
      } else {
        const u = game.users?.[preview];
        visible = computeVisibility(map, viewersForUser(map, { characterIds: u?.characterIds || [] }, actors), actors, vctx);
        explored = decodeBits(map.explored?.[preview], n);
      }
      orBits(explored, visible);
      return { map: shown, fog: { visible, explored }, known: explored, tokenMask: visible, unseen: null, preview: true };
    }
    return { map, fog: null, known: null, tokenMask: null, unseen: tintUnseen ? party : null };
  }, [map, preview, tintUnseen, actors, isGM]);

  const grid = useMemo(() => buildGrid(map), [map]);
  const combat = game.combat;
  const turnTokenId = combat?.active ? (combat.entries || []).find((e) => e.id === combat.currentId)?.tokenId || null : null;
  const inCombat = !!combat?.active && (!combat.mapId || combat.mapId === map.id);

  const scene = useMemo(
    () => ({
      map: view.map,
      actors,
      role: me.role,
      me,
      selected,
      turnTokenId,
      gmLayer: isGM && !view.preview,
      editor: false,
      fog: view.fog,
      unseen: view.unseen,
      tokenMask: view.tokenMask,
      hideHidden: !!view.preview,
      darkFactor: isGM && !view.preview ? 0.55 : 1,
      showWalls: isGM && !view.preview && showWalls,
      showGrid,
      barsFor: (tok, actor) => isGM || ownsToken(tok) || ((tok.disposition === 'pc' || tok.disposition === 'ally') && !!actor),
    }),
    [view, actors, selected, turnTokenId, isGM, showWalls, showGrid]
  );

  // ---------------- server events ----------------
  useServerEvent(
    'ping',
    (p) => {
      if (!p || p.mapId !== mapRef.current.id) return;
      const g = gameRef.current;
      const actor = p.userId === 'gm' ? null : Object.values(g?.actors || {}).find((a) => (g?.users?.[p.userId]?.characterIds || []).includes(a.id));
      rRef.current?.addPing({ x: p.x, y: p.y, name: p.name, color: p.userId === 'gm' ? '#e0468f' : actor?.color || '#3fd6d0' });
    },
    []
  );

  // ---------------- focus convention: setUI({ focusTokenId }) ----------------
  useEffect(() => {
    const id = ui.focusTokenId;
    if (!id) return;
    const here = (map.tokens || []).find((t) => t.id === id);
    if (here) {
      const timer = setTimeout(() => {
        rRef.current?.centerOn(here.x, here.y, 36);
        setUI({ focusTokenId: null, ...(isGM ? { selectedTokenIds: [id] } : {}) });
      }, 40);
      return () => clearTimeout(timer);
    }
    if (isGM) {
      const other = Object.values(game.maps || {}).find((m) => (m.tokens || []).some((t) => t.id === id));
      if (other && other.id !== map.id) {
        setUI({ viewMapId: other.id });
        return;
      }
    }
    setUI({ focusTokenId: null });
  }, [ui.focusTokenId, map]);

  useEffect(() => {
    if (!placing) rRef.current?.setOverlay({});
  }, [placing]);

  // ---------------- keyboard ----------------
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target?.isContentEditable) return;
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === 'Escape') {
        setMenu(null);
        setPlacing(null);
        if (dragRef.current) {
          dragRef.current = null;
          rRef.current?.setOverlay({});
        } else if (isGM && selected.size) setUI({ selectedTokenIds: [] });
      } else if (isGM && (e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        removeTokens([...selected]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGM, selected, map.id]);

  // ---------------- actions ----------------
  const mapId = map.id;
  const quiet = () => {};
  const removeTokens = async (ids) => {
    const n = ids.length;
    const names = ids.map((id) => map.tokens.find((t) => t.id === id)?.name).filter(Boolean);
    if (!(await confirmAction(n === 1 ? `Retirer « ${names[0] || 'ce pion'} » de la carte ?` : `Retirer ${n} pions de la carte ?`))) return;
    send('maps/removeToken', { mapId, tokenIds: ids }).then(() => setUI({ selectedTokenIds: [] }), quiet);
  };
  const ping = (info) => send('ui/ping', { mapId, x: info.fx, y: info.fy }, { silent: true }).catch(quiet);
  const spawnAt = (templateId, x, y) => {
    send('bestiary/spawn', { templateId, mapId, x, y, count: spawnOpts.count, hidden: spawnOpts.hidden }).then(
      (res) => {
        const placed = Array.isArray(res) ? res.length : res?.tokenIds?.length ?? spawnOpts.count;
        toast(`${placed} PNJ placé(s)${res?.unplaced ? ` · ${res.unplaced} sans place libre` : ''}`, placed ? 'success' : 'warn');
      },
      quiet
    );
  };
  const doorAt = (x, y) => (map.doors || []).find((d) => d.x === x && d.y === y);
  const updateTokens = (ids, patch) => Promise.all(ids.map((tokenId) => send('maps/updateToken', { mapId, tokenId, patch }).catch(quiet)));
  const targetsFor = (tok) => (selected.has(tok.id) && selected.size > 1 ? map.tokens.filter((t) => selected.has(t.id)) : [tok]);

  // Movement already spent this combat turn (server-side budget on the token, see 20-maps doMove).
  const moveKey = inCombat ? `${combat.startedAt || 0}:${combat.round || 1}` : null;
  const movementInfo = (tok, path) => {
    const step = pathLength(path, map.metersPerCell || 1);
    const used = moveKey && tok.moveBudget?.key === moveKey ? Number(tok.moveBudget.meters) || 0 : 0;
    const meters = Math.round((used + step) * 10) / 10;
    const actor = tok.actorId ? actors[tok.actorId] : null;
    let walk = null, run = null;
    if (actor) {
      try {
        const mv = derive(actor).movement;
        walk = mv.walk;
        run = mv.run;
      } catch {}
    }
    const spent = used ? ` (dont ${Math.round(used * 10) / 10} m déjà parcourus)` : '';
    if (walk == null) return { meters, step, used, color: '#3fd6d0', label: `${step} m` };
    const left = Math.round((run - meters) * 10) / 10;
    if (meters <= walk) return { meters, step, used, walk, run, color: '#3fd6d0', label: `${meters} m · marche${moveKey ? ` · reste ${left} m` : ''}${spent}` };
    if (meters <= run) return { meters, step, used, walk, run, color: '#e0a63f', label: `${meters} m · course${moveKey ? ` · reste ${left} m` : ''}${spent}` };
    return { meters, step, used, walk, run, color: '#e05c5c', label: `${meters} m · trop loin${spent}`, tooFar: true };
  };

  const playerPath = (tok, to) => {
    const blockers = [], occupied = [];
    for (const t of map.tokens || []) {
      if (t.id === tok.id || t.hidden) continue;
      (t.disposition === 'pc' || t.disposition === 'ally' ? occupied : blockers).push(t);
    }
    return findPath(map, tok, to, { grid, blockers, occupied, allowed: view.known });
  };

  // ---------------- pointer handlers ----------------
  const handlers = {
    onDown(info) {
      setMenu(null);
      const r = rRef.current;
      if (!r || placing) return false;
      if (info.alt && !isGM) return false;
      const tok = r.tokenAt(info.fx, info.fy);
      if (isGM && !view.preview) {
        if (!tok) {
          if (info.shift && !r.wallDoorAt(info.sx, info.sy)) {
            dragRef.current = { kind: 'box', sx: info.sx, sy: info.sy, fx: info.fx, fy: info.fy };
            return true;
          }
          return false;
        }
        let sel = new Set(selected);
        if (info.shift) {
          if (sel.has(tok.id)) sel.delete(tok.id);
          else sel.add(tok.id);
        } else if (!sel.has(tok.id)) sel = new Set([tok.id]);
        setUI({ selectedTokenIds: [...sel] });
        if (!sel.has(tok.id)) {
          dragRef.current = null;
          return true;
        }
        dragRef.current = { kind: 'tokens', lead: tok, group: map.tokens.filter((t) => sel.has(t.id)), target: null };
        return true;
      }
      if (!isGM && tok && ownsToken(tok)) {
        dragRef.current = { kind: 'tokens', lead: tok, group: [tok], target: null };
        return true;
      }
      return false;
    },
    onMove(info) {
      const d = dragRef.current;
      const r = rRef.current;
      if (!d || !r) return;
      if (d.kind === 'box') {
        r.setOverlay({ box: { x: Math.min(d.sx, info.sx), y: Math.min(d.sy, info.sy), w: Math.abs(info.sx - d.sx), h: Math.abs(info.sy - d.sy) } });
        return;
      }
      const tx = Math.max(0, Math.min(map.width - 1, info.cx)), ty = Math.max(0, Math.min(map.height - 1, info.cy));
      if (d.target && d.target.x === tx && d.target.y === ty && d.alt === info.alt) return;
      d.target = { x: tx, y: ty };
      d.alt = info.alt;
      const lead = d.lead;
      const dx = tx - lead.x, dy = ty - lead.y;
      let path;
      if (isGM) path = info.alt ? [{ x: lead.x, y: lead.y }, { x: tx, y: ty }] : findPath(map, lead, d.target, { grid });
      else path = playerPath(lead, d.target);
      d.path = path;
      const ghosts = d.group.map((t) => ({ token: t, x: t.x + dx, y: t.y + dy }));
      if (!path) {
        d.mv = null;
        r.setOverlay({ ghosts, pathLabel: isGM ? 'Pas de chemin — Alt pour ignorer les murs' : 'Inaccessible', pathColor: '#e05c5c', labelAt: { x: tx + 0.5, y: ty - 0.45 } });
        return;
      }
      const mv = movementInfo(lead, path);
      d.mv = mv;
      r.setOverlay({ ghosts, path: dx || dy ? path : null, pathColor: mv.color, pathLabel: dx || dy ? mv.label + (isGM && info.alt ? ' · murs ignorés' : '') : null, labelAt: { x: tx + 0.5, y: ty - 0.45 } });
    },
    onUp(info, moved) {
      const d = dragRef.current;
      dragRef.current = null;
      const r = rRef.current;
      r?.setOverlay({});
      hoverWallRef.current = null;
      if (!d || !moved) return;
      if (d.kind === 'box') {
        const a = r.toWorld(Math.min(d.sx, info.sx), Math.min(d.sy, info.sy));
        const b = r.toWorld(Math.max(d.sx, info.sx), Math.max(d.sy, info.sy));
        const hits = map.tokens.filter((t) => t.x + 1 > a.x && t.x < b.x && t.y + 1 > a.y && t.y < b.y).map((t) => t.id);
        setUI({ selectedTokenIds: [...new Set([...selected, ...hits])] });
        return;
      }
      const t = d.target;
      if (!t || (t.x === d.lead.x && t.y === d.lead.y)) return;
      if (!isGM) {
        if (map.movementLocked) return toast('Le MJ a verrouillé les déplacements', 'warn');
        if (!d.path) return toast('Destination inaccessible', 'warn');
        if (inCombat && d.mv?.tooFar) return toast(`Trop loin pour ce tour : ${d.mv.step} m demandés, il reste ${Math.max(0, Math.round((d.mv.run - d.mv.used) * 10) / 10)} m (course max ${d.mv.run} m)`, 'warn');
        send('maps/moveToken', { mapId, tokenId: d.lead.id, x: t.x, y: t.y }).catch(quiet);
        return;
      }
      const dx = t.x - d.lead.x, dy = t.y - d.lead.y;
      if (d.group.length === 1) send('maps/moveToken', { mapId, tokenId: d.lead.id, x: t.x, y: t.y, ignoreWalls: !!info.alt }).catch(quiet);
      else {
        const moves = d.group.map((g) => ({ tokenId: g.id, x: Math.max(0, Math.min(map.width - 1, g.x + dx)), y: Math.max(0, Math.min(map.height - 1, g.y + dy)) }));
        send('maps/moveTokens', { mapId, moves, ignoreWalls: !!info.alt }).catch(quiet);
      }
    },
    onCancel() {
      dragRef.current = null;
      rRef.current?.setOverlay({});
    },
    onClick(info) {
      setMenu(null);
      if (info.alt) return ping(info);
      if (placing) {
        if (info.cx < 0 || info.cy < 0 || info.cx >= map.width || info.cy >= map.height) return;
        spawnAt(placing.templateId, info.cx, info.cy);
        if (!info.shift) setPlacing(null);
        return;
      }
      // segment doors (icon or the door line) first, then tile doors
      const wd = rRef.current?.wallDoorAt(info.sx, info.sy) || null;
      const target = wd ? { id: wd.id, state: wd.door.state, kind: wd.door.kind } : doorAt(info.cx, info.cy);
      if (target) {
        if (isGM && !view.preview) {
          if (info.shift) {
            const secret = target.kind !== 'secret';
            send('maps/setDoor', { mapId, doorId: target.id, kind: secret ? 'secret' : 'door' }).then(() => toast(secret ? 'Porte secrète (invisible des joueurs fermée)' : 'Porte normale'), quiet);
          } else {
            const next = NEXT_DOOR_STATE[target.state] || 'closed';
            send('maps/setDoor', { mapId, doorId: target.id, state: next }).then(() => toast(`Porte : ${DOOR_LABEL[next].toLowerCase()}`), quiet);
          }
        } else if (!isGM) {
          send('maps/toggleDoor', { mapId, doorId: target.id }).catch(quiet);
        }
        return;
      }
      if (isGM && selected.size) setUI({ selectedTokenIds: [] });
    },
    onDblClick(info) {
      const tok = rRef.current?.tokenAt(info.fx, info.fy);
      if (tok?.actorId && actors[tok.actorId] && (isGM || ownsToken(tok) || tok.disposition === 'pc')) openSheet(tok.actorId);
    },
    onContext(info) {
      const tok = rRef.current?.tokenAt(info.fx, info.fy);
      if (info.cx < 0 || info.cy < 0 || info.cx >= map.width || info.cy >= map.height) {
        if (!tok) return;
      }
      if (isGM && tok && !selected.has(tok.id)) setUI({ selectedTokenIds: [tok.id] });
      const wd = !tok && isGM && !view.preview ? rRef.current?.wallDoorAt(info.sx, info.sy) : null;
      setMenu({ x: info.sx, y: info.sy, tokenId: tok?.id || null, wallDoorId: wd?.id || null, cell: { x: info.cx, y: info.cy }, fx: info.fx, fy: info.fy });
    },
    onLongPress(info) {
      const tok = rRef.current?.tokenAt(info.fx, info.fy);
      if (tok && ((isGM && !view.preview) || ownsToken(tok))) return handlers.onContext(info);
      ping(info);
      if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
    },
    onHover(info) {
      const r = rRef.current;
      if (!r) return;
      if (!info) {
        if (tipRef.current) setTip((tipRef.current = null));
        if (hoverWallRef.current && !placing) {
          hoverWallRef.current = null;
          r.setOverlay({});
        }
        return;
      }
      const tok = r.tokenAt(info.fx, info.fy);
      const wd = tok ? null : r.wallDoorAt(info.sx, info.sy);
      const door = wd ? { ...wd.door, id: wd.id } : doorAt(info.cx, info.cy);
      r.canvas.style.cursor = placing ? 'crosshair' : tok && (isGM || ownsToken(tok)) ? 'grab' : door ? 'pointer' : '';
      const hoverWallId = wd?.id || null;
      if (hoverWallId !== hoverWallRef.current && !placing) {
        hoverWallRef.current = hoverWallId;
        r.setOverlay(hoverWallId ? { hoverWallId } : {});
      }
      if (isGM && !view.preview) {
        const note = (map.notes || []).find((n) => n.x === info.cx && n.y === info.cy);
        const doorTip = door ? `${door.name ? door.name + ' — ' : ''}${door.kind === 'secret' ? 'porte secrète, ' : ''}${DOOR_LABEL[door.state]?.toLowerCase()} · clic : changer · Maj+clic : secrète` : null;
        const text = note?.text || doorTip || (tok?.hidden ? `${tok.name} (caché aux joueurs)` : null);
        const key = text ? text + info.cx + ',' + info.cy : null;
        if (key !== tipRef.current) {
          tipRef.current = key;
          setTip(text ? { x: info.sx, y: info.sy, text } : null);
        }
      }
      if (placing) r.setOverlay({ hoverCell: { x: info.cx, y: info.cy }, hoverColor: '#e05c5c' });
    },
    onDropData(info, dt) {
      if (!isGM) return;
      const templateId = dt.getData('text/sr-template');
      if (templateId && info.cx >= 0 && info.cy >= 0 && info.cx < map.width && info.cy < map.height) spawnAt(templateId, info.cx, info.cy);
    },
  };

  // ---------------- toolbars ----------------
  const shownToPlayers = game.scene?.activeMapId === map.id;
  const mapOptions = Object.values(game.maps || {})
    .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name))
    .map((m) => ({ value: m.id, label: `${m.id === game.scene?.activeMapId ? '● ' : ''}${m.folder ? m.folder + ' › ' : ''}${m.name}` }));
  const previewOptions = [
    { value: '', label: 'Vue MJ' },
    { value: 'party', label: 'Vue du groupe' },
    ...Object.values(game.users || {})
      .filter((u) => (u.characterIds || []).length)
      .map((u) => ({ value: u.id, label: `Vue de ${u.name}` })),
  ];
  const myTokens = (map.tokens || []).filter(ownsToken);
  const turnEntry = combat?.active ? (combat.entries || []).find((e) => e.id === combat.currentId) || null : null;

  const gmToolbar = html`<div class=${'map-toolbar' + (toolsOpen ? '' : ' collapsed')}>
    <${IconButton} icon=${toolsOpen ? '◂' : '☰'} title=${toolsOpen ? 'Replier la barre' : 'Outils de la carte'} onClick=${() => setToolsOpen(!toolsOpen)} />
    ${toolsOpen &&
    html`
      <${Select} class="map-tb-select" value=${map.id} options=${mapOptions} onChange=${(id) => setUI({ viewMapId: id })} title="Carte affichée sur ton écran" />
      ${shownToPlayers
        ? html`<${Badge} color="green" title="Les joueurs voient cette carte">● Affichée aux joueurs</${Badge}>`
        : html`<${Button} small variant="accent" onClick=${() => send('maps/setActive', { mapId }).then(() => toast('Carte affichée aux joueurs', 'success'), quiet)} title=${`Les joueurs voient : ${game.maps?.[game.scene?.activeMapId]?.name || 'aucune carte'}`}>Montrer aux joueurs</${Button}>`}
      <span class="map-tb-sep"></span>
      <${Toggle} label="Verrou" title="Bloquer les déplacements des joueurs" value=${map.movementLocked} onChange=${(v) => send('maps/update', { mapId, patch: { movementLocked: v } }).catch(quiet)} />
      <${Toggle} label="Brouillard" title="Brouillard de guerre pour les joueurs" value=${map.fog !== false} onChange=${(v) => send('maps/update', { mapId, patch: { fog: v } }).catch(quiet)} />
      <${Select} class="map-tb-select small" value=${map.lighting || 'bright'} options=${LIGHTING_OPTIONS} onChange=${(v) => send('maps/update', { mapId, patch: { lighting: v } }).catch(quiet)} title="Éclairage ambiant" />
      ${(map.walls || []).length > 0 && html`<${Toggle} label="Afficher les murs" title="Tracer les murs (segments) par-dessus la carte — visible par toi seul" value=${showWalls} onChange=${setShowWalls} />`}
      ${isImageMap(map) && html`<${Toggle} label="Grille" title="Quadrillage discret par-dessus l'image" value=${showGrid} onChange=${setShowGrid} />`}
      <span class="map-tb-sep"></span>
      <${Button} small onClick=${() => send('maps/placePCs', { mapId }).then((ids) => toast(ids?.length ? `${ids.length} PJ placé(s)` : 'Tous les PJ sont déjà sur la carte'), quiet)} title="Poser un pion pour chaque PJ absent de la carte">Placer les PJ</${Button}>
      <${Select} class="map-tb-select small" value=${preview} options=${previewOptions} onChange=${setPreview} title="Prévisualiser ce que voient les joueurs" />
      <${Toggle} label="Zones non vues" title="Teinter les cases qu'aucun PJ ne voit" value=${tintUnseen} onChange=${setTintUnseen} />
      <span class="map-tb-sep"></span>
      <${Button} small variant=${drawer ? 'primary' : 'default'} onClick=${() => setDrawer(!drawer)} title="Glisser des PNJ du bestiaire sur la carte">☠ Bestiaire</${Button}>
      <${Button} small variant="ghost" onClick=${() => setUI({ mapsEditId: map.id, mainTab: 'maps' })} title="Ouvrir l'éditeur de carte">✎ Éditer</${Button}>
    `}
    <${IconButton} icon="⌖" title="Recentrer la carte" onClick=${() => rRef.current?.fit()} />
  </div>`;

  const playerToolbar = html`<div class="map-toolbar">
    <span class="map-title">${map.name}</span>
    ${myTokens.map((t) => html`<${Button} small variant="ghost" onClick=${() => rRef.current?.centerOn(t.x, t.y, 32)} title="Centrer sur ${t.name}">◎ ${t.name}</${Button}>`)}
    ${isImageMap(map) && html`<${Toggle} label="Grille" title="Quadrillage discret par-dessus l'image" value=${showGrid} onChange=${setShowGrid} />`}
    <${IconButton} icon="⌖" title="Recentrer la carte" onClick=${() => rRef.current?.fit()} />
  </div>`;

  return html`<div class="map-root" onContextMenu=${(e) => e.preventDefault()}>
    <${MapCanvas} rendererRef=${rRef} scene=${scene} handlers=${handlers} class=${placing ? 'placing' : ''} />
    ${isGM ? gmToolbar : playerToolbar}
    <div class="map-banners">
      ${map.movementLocked && html`<div class="map-banner warn">⊘ Déplacements verrouillés par le MJ</div>`}
      ${view.preview && html`<div class="map-banner info">Aperçu : ${previewOptions.find((o) => o.value === preview)?.label} <button class="map-banner-x" onClick=${() => setPreview('')}>✕</button></div>`}
      ${isGM && !shownToPlayers && html`<div class="map-banner dim">Les joueurs voient : ${game.maps?.[game.scene?.activeMapId]?.name || 'aucune carte'}</div>`}
      ${turnEntry && inCombat && html`<div class="map-banner combat">Round ${combat.round} · Tour de <strong>${turnEntry.hidden && !isGM ? '???' : turnEntry.name}</strong></div>`}
      ${placing && html`<div class="map-banner info">Clique une case pour placer « ${placing.name} » ×${spawnOpts.count} · Maj+clic : en placer plusieurs · Échap : annuler</div>`}
    </div>
    ${!isGM && html`<div class="map-hint">Glisse ton pion pour te déplacer · clic sur une porte proche : ouvrir/fermer · double-clic : fiche · Alt+clic ou appui long : ping</div>`}
    ${isGM && drawer && html`<${BestiaryDrawer} game=${game} opts=${spawnOpts} setOpts=${setSpawnOpts} placing=${placing} setPlacing=${setPlacing} onClose=${() => setDrawer(false)} />`}
    ${tip && html`<div class="map-tip" style=${{ left: tip.x + 14 + 'px', top: tip.y + 14 + 'px' }}>${tip.text}</div>`}
    ${menu && html`<${ContextMenu} menu=${menu} onClose=${() => setMenu(null)}>${menuContent()}</${ContextMenu}>`}
  </div>`;

  // ---------------- context menu content ----------------
  function menuContent() {
    const close = () => setMenu(null);
    const act = (fn) => () => {
      close();
      fn();
    };
    const tok = menu.tokenId ? map.tokens.find((t) => t.id === menu.tokenId) : null;
    const { x, y } = menu.cell;
    if (tok) {
      const targets = isGM ? targetsFor(tok) : [tok];
      const ids = targets.map((t) => t.id);
      const multi = targets.length > 1;
      const hasTorch = !!tok.light?.radius;
      const st = tok.status || [];
      if (!isGM) {
        if (!ownsToken(tok)) {
          return html`<div class="map-menu-head">${tok.name}</div>
            ${tok.actorId && actors[tok.actorId] && html`<button class="map-menu-item" onClick=${act(() => openSheet(tok.actorId))}>Ouvrir la fiche</button>`}
            <button class="map-menu-item" onClick=${act(() => ping({ fx: menu.fx, fy: menu.fy }))}>Pinger ici</button>`;
        }
        return html`<div class="map-menu-head">${tok.name}</div>
          <button class="map-menu-item" onClick=${act(() => openSheet(tok.actorId))}>Ouvrir la fiche</button>
          <button class="map-menu-item" onClick=${act(() => send('maps/updateToken', { mapId, tokenId: tok.id, patch: { light: hasTorch ? null : TORCH } }).catch(quiet))}>${hasTorch ? 'Éteindre la lampe' : 'Allumer une lampe torche'}</button>
          <div class="map-menu-row">${['à terre', 'à couvert'].map(
            (s) => html`<button class=${'chip' + (st.includes(s) ? ' on' : '')} onClick=${() => send('maps/updateToken', { mapId, tokenId: tok.id, patch: { status: st.includes(s) ? st.filter((v) => v !== s) : [...st, s] } }).catch(quiet)}>${STATUS_GLYPHS[s] || ''} ${s}</button>`
          )}</div>
          <button class="map-menu-item" onClick=${act(() => ping({ fx: menu.fx, fy: menu.fy }))}>Pinger ici</button>`;
      }
      const allHidden = targets.every((t) => t.hidden);
      return html`<div class="map-menu-head">${multi ? `${targets.length} pions sélectionnés` : tok.name}
          ${!multi && html`<${Badge} color=${{ pc: 'cyan', ally: 'green', neutral: 'amber', hostile: 'red' }[tok.disposition] || 'dim'}>${DISPO[tok.disposition]?.label || ''}</${Badge}>`}</div>
        ${!multi && tok.actorId && actors[tok.actorId] && html`<button class="map-menu-item" onClick=${act(() => openSheet(tok.actorId))}>Ouvrir la fiche</button>`}
        <button class="map-menu-item" onClick=${act(() => updateTokens(ids, { hidden: !allHidden }))}>${allHidden ? 'Montrer aux joueurs' : 'Cacher aux joueurs'}</button>
        <div class="map-menu-label">Disposition</div>
        <div class="map-menu-row">${Object.entries(DISPO).map(
          ([k, d]) => html`<button class=${'chip' + (targets.every((t) => t.disposition === k) ? ' on' : '')} style=${{ '--chip': d.color }} onClick=${() => updateTokens(ids, { disposition: k })}>${d.label}</button>`
        )}</div>
        <div class="map-menu-label">Statut</div>
        <div class="map-menu-row">${STATUSES.map((s) => {
          const on = targets.every((t) => (t.status || []).includes(s));
          return html`<button class=${'chip' + (on ? ' on' : '')} onClick=${() => Promise.all(targets.map((t) => send('maps/updateToken', { mapId, tokenId: t.id, patch: { status: on ? (t.status || []).filter((v) => v !== s) : [...new Set([...(t.status || []), s])] } }).catch(quiet)))}>${STATUS_GLYPHS[s] || ''} ${s}</button>`;
        })}</div>
        <button class="map-menu-item" onClick=${act(() => updateTokens(ids, { light: hasTorch ? null : TORCH }))}>${hasTorch ? 'Éteindre la lampe torche' : 'Lampe torche (6 m)'}</button>
        <button class="map-menu-item" onClick=${act(() => send('combat/add', { tokenIds: ids }).then(() => toast('Ajouté au combat', 'success'), quiet))}>Ajouter au combat</button>
        ${!multi && html`<button class="map-menu-item" onClick=${act(async () => {
          const name = await promptText('Nom du pion', tok.name);
          if (name && name.trim()) send('maps/updateToken', { mapId, tokenId: tok.id, patch: { name: name.trim() } }).catch(quiet);
        })}>Renommer…</button>`}
        <button class="map-menu-item danger" onClick=${act(() => removeTokens(ids))}>Retirer de la carte</button>`;
    }
    // empty cell
    const inside = x >= 0 && y >= 0 && x < map.width && y < map.height;
    if (!isGM || view.preview) {
      return html`<button class="map-menu-item" onClick=${act(() => ping({ fx: menu.fx, fy: menu.fy }))}>Pinger ici</button>`;
    }
    const wallDoor = menu.wallDoorId ? (map.walls || []).find((w) => w.id === menu.wallDoorId && w.door) : null;
    const door = wallDoor ? { ...wallDoor.door, id: wallDoor.id } : doorAt(x, y);
    const lightsHere = (map.lights || []).filter((l) => l.x === x && l.y === y);
    const notesHere = (map.notes || []).filter((n) => n.x === x && n.y === y);
    return html`<div class="map-menu-head">Case ${x}, ${y}</div>
      <button class="map-menu-item" onClick=${act(() => ping({ fx: menu.fx, fy: menu.fy }))}>Pinger ici</button>
      ${inside &&
      html`
        <button class="map-menu-item" onClick=${act(() => send('maps/placePCs', { mapId, x, y }).then((ids) => toast(ids?.length ? `${ids.length} PJ placé(s)` : 'Tous les PJ sont déjà sur la carte'), quiet))}>Placer les PJ ici</button>
        <button class="map-menu-item" onClick=${act(() => send('maps/addLight', { mapId, light: { x, y, radius: 6, color: '#ffcc88', on: true } }).catch(quiet))}>Ajouter une lumière ici</button>
        <button class="map-menu-item" onClick=${act(async () => {
          const text = await promptText('Note MJ (visible par toi seul)');
          if (text && text.trim()) send('maps/addNote', { mapId, note: { x, y, text: text.trim() } }).catch(quiet);
        })}>Ajouter une note ici</button>
        <button class="map-menu-item" onClick=${act(() => setDrawer(true))}>Placer un PNJ…</button>`}
      ${door &&
      html`<div class="map-menu-label">Porte${door.name ? ` — ${door.name}` : ''}</div>
        <div class="map-menu-row">${['open', 'closed', 'locked'].map(
          (s) => html`<button class=${'chip' + (door.state === s ? ' on' : '')} onClick=${() => send('maps/setDoor', { mapId, doorId: door.id, state: s }).catch(quiet)}>${DOOR_LABEL[s]}</button>`
        )}
        <button class=${'chip' + (door.kind === 'secret' ? ' on' : '')} style=${{ '--chip': '#e0468f' }} onClick=${() => send('maps/setDoor', { mapId, doorId: door.id, kind: door.kind === 'secret' ? 'door' : 'secret' }).catch(quiet)}>Secrète</button></div>`}
      ${lightsHere.map(
        (l) => html`<div class="map-menu-label">Lumière</div>
          <div class="map-menu-row">
            <button class=${'chip' + (l.on !== false ? ' on' : '')} onClick=${() => send('maps/toggleLight', { mapId, lightId: l.id }).catch(quiet)}>${l.on !== false ? 'Allumée' : 'Éteinte'}</button>
            <button class="chip" onClick=${act(() => send('maps/removeLight', { mapId, lightId: l.id }).catch(quiet))}>Supprimer</button>
          </div>`
      )}
      ${notesHere.map(
        (n) => html`<div class="map-menu-label">Note</div>
          <div class="map-menu-note">${n.text}</div>
          <div class="map-menu-row">
            <button class="chip" onClick=${act(async () => {
              const text = await promptText('Note MJ', n.text);
              if (text != null) send('maps/updateNote', { mapId, noteId: n.id, patch: { text } }).catch(quiet);
            })}>Modifier</button>
            <button class="chip" onClick=${act(() => send('maps/removeNote', { mapId, noteId: n.id }).catch(quiet))}>Supprimer</button>
          </div>`
      )}`;
  }
}

function ContextMenu({ menu, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const pw = parent.clientWidth, ph = parent.clientHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ left: Math.max(6, Math.min(menu.x, pw - w - 6)), top: Math.max(6, Math.min(menu.y, ph - h - 6)) });
  }, [menu.x, menu.y]);
  useEffect(() => {
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away);
    };
  }, [onClose]);
  return html`<div class="map-menu" ref=${ref} style=${{ left: pos.left + 'px', top: pos.top + 'px' }} onContextMenu=${(e) => e.preventDefault()}>${children}</div>`;
}

function BestiaryDrawer({ game, opts, setOpts, placing, setPlacing, onClose }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return Object.values(game.bestiary || {})
      .filter((t) => !needle || `${t.name} ${t.folder || ''} ${t.metatype || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || String(a.name).localeCompare(String(b.name)));
  }, [game.bestiary, q]);
  const groups = [];
  for (const t of list) {
    const f = t.folder || 'Divers';
    if (!groups.length || groups[groups.length - 1].folder !== f) groups.push({ folder: f, items: [] });
    groups[groups.length - 1].items.push(t);
  }
  return html`<aside class="map-drawer">
    <header class="map-drawer-head">
      <strong>Bestiaire</strong>
      <${IconButton} icon="✕" title="Fermer" onClick=${onClose} />
    </header>
    <div class="map-drawer-opts">
      <${SearchBox} value=${q} onChange=${setQ} placeholder="Rechercher un PNJ…" />
      <div class="row spread">
        <span class="small muted">Nombre</span>
        <${NumberInput} small value=${opts.count} min=${1} max=${12} onChange=${(v) => setOpts({ ...opts, count: v })} />
      </div>
      <${Toggle} label="Placer caché" value=${opts.hidden} onChange=${(v) => setOpts({ ...opts, hidden: v })} />
    </div>
    <div class="map-drawer-list">
      ${!list.length && html`<div class="empty small">${Object.keys(game.bestiary || {}).length ? 'Aucun résultat' : 'Bestiaire vide'}</div>`}
      ${groups.map(
        (g) => html`<div class="map-drawer-group">${g.folder}</div>
          ${g.items.map(
            (t) => html`<div class=${'map-drawer-item' + (placing?.templateId === t.id ? ' active' : '')} draggable="true"
                title="Glisse sur la carte, ou clique puis clique une case"
                onDragStart=${(e) => {
                  e.dataTransfer.setData('text/sr-template', t.id);
                  e.dataTransfer.setData('text/plain', t.name);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick=${() => setPlacing(placing?.templateId === t.id ? null : { templateId: t.id, name: t.name })}>
              <span class="map-drawer-dot" style=${{ background: t.color || '#e05c5c' }}></span>
              <span class="grow">${t.name}</span>
              ${t.npc?.professionalRating != null && html`<span class="small muted">PR ${t.npc.professionalRating}</span>`}
            </div>`
          )}`
      )}
    </div>
  </aside>`;
}
