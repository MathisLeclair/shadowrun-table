// Live battle map for the GM and the players: movement, doors, fog of war, pings, GM tools.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, IconButton, Select, Toggle, Badge, SearchBox, NumberInput, confirmAction, promptText } from '../../lib/ui.tsx';
import { send, useServerEvent, type GameProps } from '../../lib/net.ts';
import { useUI, setUI, openSheet, toast, type UIState } from '../../lib/ui-store.ts';
import { derive } from '/shared/sr5.ts';
import {
  buildGrid, findPath, pathLength, computeVisibility, createVisionContext, viewersForUser, decodeBits, orBits, isPcToken,
} from '/shared/vision.ts';
import { MapCanvas, type MapHandlers, type MapPointerInfo } from './MapCanvas.tsx';
import { DISPO, STATUS_GLYPHS, isImageMap, lightingOptions, dispoLabel, statusText, getTileStyle, setTileStyle, type MapRenderer, type MapScene, type FogMasks, type CombatMarks, type CombatLineMark, type Point } from './renderer.ts';
import { t, tk, compare } from '../../lib/i18n.ts';
import { tRich } from '../sheet/common.tsx';
import { RollDialog } from '../sheet/RollDialog.tsx';
import { setTarget, setAimPoint, PENDING } from '../combat/attack-common.ts';
import { cellDistance, rangeFor, rangeClass, isAreaWeapon, blastOf, blastReach, activeBlasts, TOXIN_BY_ID } from '/shared/combat.ts';
import { isUnarmed, isLauncherProfile, launcherRounds } from '../sheet/inventory.ts';
import type { Actor, Blast, GameMap, GameView, MapDoor, Template, Token, ViewActor, Weapon, WallDoor, DoorState } from '../../../shared/types.ts';
import './map.css';

void rangeFor; // imported by the original module (kept for parity), unused

// Stored status values (French, shown with statusText()).
const STATUSES = ['à terre', 'inconscient', 'mort', 'étourdi', 'en feu', 'à couvert', 'caché', 'saignement'];
const DOOR_LABEL: Record<string, string> = { open: tk('Ouverte'), closed: tk('Fermée'), locked: tk('Verrouillée') };
const doorLabel = (s: string | undefined) => (s && DOOR_LABEL[s] ? t(DOOR_LABEL[s]) : '');
const NEXT_DOOR_STATE: Record<string, DoorState> = { open: 'closed', closed: 'locked', locked: 'open' };
const TORCH = { radius: 6, color: '#fff1cc' };
// shared/vision.js is untyped JS: its `ctx = null` default makes TS infer a null-only parameter. Real signature:
type VisionContext = ReturnType<typeof createVisionContext>;
const visibility = computeVisibility as unknown as (map: GameMap, viewers: Token[], actors: Record<string, ViewActor>, ctx?: VisionContext | null) => Uint8Array;

/** Full sheet (not an NPC stub). */
const hasSheet = (a: ViewActor | undefined | null): a is Actor => !!a && 'attributes' in a && !!a.attributes;

/** Per-browser display preference (localStorage may be unavailable). */
function usePref(key: string, def: boolean): [boolean, (next: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? def : raw === '1';
    } catch {
      return def;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try { localStorage.setItem(key, next ? '1' : '0'); } catch {}
  };
  return [v, set];
}

/** Cells a player knows (explored ∪ visible) or null when fog is off. */
function decodeFog(map: GameMap, userId: string): FogMasks | null {
  const n = map.width * map.height;
  if (map.fog === false) return null;
  const visible = decodeBits(map.visible, n);
  const explored = decodeBits(map.explored?.[userId], n);
  orBits(explored, visible);
  return { visible, explored };
}

/** GM preview: the map as players see it (secret doors as walls, no GM data). */
function playerSideMap(map: GameMap): GameMap {
  const secret = new Set((map.doors || []).filter((d) => d.kind === 'secret' && d.state !== 'open').map((d) => d.y * map.width + d.x));
  return {
    ...map,
    tiles: secret.size ? map.tiles.map((row, y) => row.replace(/./g, (ch, x: number) => (secret.has(y * map.width + x) ? '#' : ch))) : map.tiles,
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

/** Weapon offered by the target banner: a grenade for an aimed point, melee within 2 m, else the first ready ranged weapon. */
function defaultWeapon(actor: ViewActor | undefined | null, meters: number | null, grenade: boolean): Weapon | null {
  const ready = ((hasSheet(actor) && actor.weapons) || []).filter((w) => w && (w.equipped !== false || isUnarmed(w)));
  if (grenade) {
    const g = ready.find((w) => isAreaWeapon(w) && !isLauncherProfile(w));
    if (g) return g;
  }
  const melee = ready.filter((w) => w.kind === 'melee');
  const ranged = ready.filter((w) => w.kind !== 'melee' && !isAreaWeapon(w));
  if (meters !== null && meters <= 2 && melee.length) return melee.find((w) => !isUnarmed(w)) || melee[0];
  return ranged[0] || melee[0] || null;
}

/** Label under a blast marker: the cloud kind (smoke, gas + toxin, flash-pak) and the scatter. */
function blastLabel(b: Pick<Blast, 'effect' | 'toxinId' | 'scattered' | 'meters'>): string | null {
  const kind = b.effect === 'smoke' ? t('fumée') : b.effect === 'thermalSmoke' ? t('fumée thermique') : b.effect === 'flashpak' ? t('flash-pak')
    : b.effect === 'gas' ? t('gaz : {toxin}', { toxin: t(TOXIN_BY_ID[b.toxinId as string]?.name || 'Gaz lacrymogène (CS)') }) : null;
  const drift = b.scattered ? t('dévie de {m} m', { m: b.meters }) : null;
  return [kind, drift].filter(Boolean).join(' · ') || null;
}

/** Blast reach (meters) of the grenade the banner would throw — preview ring around the aimed point. */
function grenadeReach(actor: ViewActor | undefined): number {
  const w = defaultWeapon(actor, null, true);
  if (!w || !isAreaWeapon(w)) return 0;
  const round = rangeClass(w) === 'grenadeLauncher' ? launcherRounds(actor, w)[0]?.w : null; // launcher: its first round (as the roll dialog)
  return blastReach(blastOf(round || w, actor));
}

export default function MapView({ game }: GameProps) {
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
    return (
      <div className="map-root map-empty">
        <div className="map-empty-card">
          <div className="map-empty-glyph">⌖</div>
          {isGM ? (
            <>
              <h3>{t('Aucune carte')}</h3>
              <p className="muted">{t('Crée ou importe une carte pour commencer.')}</p>
              <Button variant="primary" onClick={() => setUI({ mainTab: 'maps' })}>
                {t('Ouvrir les cartes')}
              </Button>
            </>
          ) : (
            <>
              <h3>{t("Le MJ n'a pas encore affiché de carte")}</h3>
              <p className="muted">{t("Reste branché, chummer : la carte apparaîtra ici dès que le MJ l'affichera.")}</p>
            </>
          )}
        </div>
      </div>
    );
  }
  return <LiveMap game={game} map={map} ui={ui} isGM={isGM} />;
}

type Cell = { x: number; y: number };
interface MoveInfo {
  meters: number;
  step: number;
  used: number;
  walk?: number;
  run?: number;
  color: string;
  label: string;
  tooFar?: boolean;
}
interface BoxDrag {
  kind: 'box';
  sx: number;
  sy: number;
  fx: number;
  fy: number;
}
interface TokenDrag {
  kind: 'tokens';
  lead: Token;
  group: Token[];
  target: Cell | null;
  alt?: boolean;
  path?: Cell[] | null;
  mv?: MoveInfo | null;
}
interface MenuState {
  x: number;
  y: number;
  tokenId: string | null;
  wallDoorId: string | null;
  cell: Cell;
  fx: number;
  fy: number;
}
interface MapViewState {
  map: GameMap;
  fog: FogMasks | null;
  known: Uint8Array | null;
  tokenMask: Uint8Array | null;
  unseen: Uint8Array | null;
  preview?: boolean;
}
/** A door the pointer is on: tile door, or segment door (wall id + its door). */
type DoorTarget = (MapDoor | (WallDoor & { id: string })) & { id: string };

interface LiveMapProps {
  game: GameView;
  map: GameMap;
  ui: UIState;
  isGM: boolean;
}

function LiveMap({ game, map, ui, isGM }: LiveMapProps) {
  const me = game.me;
  const actors = game.actors || {};
  const rRef = useRef<MapRenderer | null>(null);
  const dragRef = useRef<BoxDrag | TokenDrag | null>(null);
  const tipRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [preview, setPreview] = useState('');
  const [tintUnseen, setTintUnseen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [placing, setPlacing] = useState<{ templateId: string; name: string } | null>(null);
  const [spawnOpts, setSpawnOpts] = useState({ count: 1, hidden: false });
  const [toolsOpen, setToolsOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 700);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [attacking, setAttacking] = useState<{ actorId: string; weaponId: string | null } | null>(null); // { actorId, weaponId } roll dialog opened from the target banner
  const [showWalls, setShowWalls] = usePref('sr.map.showWalls', true);
  const [showGrid, setShowGrid] = usePref('sr.map.showGrid', true);
  const [detailedTiles, setDetailedTiles] = useState(() => getTileStyle() === 'detailed');
  const toggleTileStyle = (v: boolean) => {
    setTileStyle(v ? 'detailed' : 'classic');
    setDetailedTiles(v);
  };
  const tileStyleToggle = !isImageMap(map) && (
    <Toggle label={t('Décor détaillé')} title={t('Sols texturés et mobilier dessiné (voitures, lits, canapés…) — réglage de ce navigateur')} value={detailedTiles} onChange={toggleTileStyle} />
  );
  const hoverWallRef = useRef<string | null>(null);
  const selected = useMemo(() => new Set<string>(ui.selectedTokenIds || []), [ui.selectedTokenIds]);
  const own = useMemo(() => new Set(me.characterIds || []), [me.characterIds]);
  const ownsToken = (tt: Token | null | undefined) => !!tt?.actorId && own.has(tt.actorId);
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
  const view = useMemo<MapViewState>(() => {
    const n = map.width * map.height;
    if (!isGM) {
      const fog = decodeFog(map, me.id);
      return { map, fog, known: fog ? fog.explored : null, tokenMask: null, unseen: null };
    }
    const needParty = preview || tintUnseen;
    let party: Uint8Array | null = null;
    let vctx: VisionContext | null = null;
    if (needParty) {
      vctx = createVisionContext(map);
      party = visibility(map, (map.tokens || []).filter((tt) => isPcToken(tt, actors)), actors, vctx);
    }
    if (preview) {
      const shown = playerSideMap(map);
      if (map.fog === false) return { map: shown, fog: null, known: null, tokenMask: null, unseen: null, preview: true };
      let visible: Uint8Array, explored: Uint8Array;
      if (preview === 'party') {
        visible = party!;
        explored = new Uint8Array(n);
        for (const enc of Object.values(map.explored || {})) orBits(explored, decodeBits(enc, n));
      } else {
        const u = game.users?.[preview];
        visible = visibility(map, viewersForUser(map, { characterIds: u?.characterIds || [] }, actors), actors, vctx);
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

  // Combat marks: my target, my aimed point, blasts and pending attacks of this map (attacks module).
  const targetTok = ui.targetTokenId ? (map.tokens || []).find((tt) => tt.id === ui.targetTokenId) || null : null;
  const attackerTok = isGM
    ? (map.tokens || []).find((tt) => selected.has(tt.id) && tt.id !== targetTok?.id && tt.actorId && hasSheet(actors[tt.actorId])) || null
    : (map.tokens || []).find((tt) => ownsToken(tt)) || null;
  const mpc = Number(map.metersPerCell) || 1;
  const targetMeters: number | null = targetTok && attackerTok ? cellDistance(attackerTok, targetTok, mpc) : null;
  const aimHere = ui.aimPoint && ui.aimPoint.mapId === map.id ? ui.aimPoint : null;
  const attacksSlice = game.attacks;
  // Explosion markers fade at the end of their Combat Turn (1 min outside combat); clouds stay until the end of the fight.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);
  const mapBlasts = useMemo<Blast[]>(() => activeBlasts((attacksSlice?.blasts || []).filter((b) => b.mapId === map.id), combat, clock), [attacksSlice, map.id, combat, clock]);
  const combatMarks = useMemo<CombatMarks | null>(() => {
    const blasts = mapBlasts.slice(0, 8);
    const lines: CombatLineMark[] = [];
    for (const a of attacksSlice?.list || []) {
      if (a.mapId !== map.id || !PENDING.has(a.status) || a.kind === 'blast' || a.kind === 'toxin') continue;
      const from = (map.tokens || []).find((tt) => tt.actorId && tt.actorId === a.attackerId);
      if (!from || !a.targetTokenId) continue;
      lines.push({ from: from.id, to: a.targetTokenId, color: a.status === 'soak' ? '#e0663f' : '#e05c5c', dashed: a.status === 'defense', label: a.status === 'soak' ? `${a.modifiedDv}${a.type}` : null });
    }
    if (!targetTok && !aimHere && !blasts.length && !lines.length) return null;
    return {
      targetTokenId: targetTok?.id || null,
      targetLabel: targetTok ? (targetMeters !== null ? `${targetTok.name} · ${targetMeters} m` : targetTok.name) : null,
      aim: aimHere ? { x: aimHere.x, y: aimHere.y } : null,
      aimLabel: aimHere && attackerTok ? `${cellDistance(attackerTok, aimHere, mpc)} m` : null,
      aimReach: aimHere && attackerTok ? grenadeReach(actors[attackerTok.actorId!]) : 0,
      blasts: blasts.map((b) => ({ ...b, label: blastLabel(b) })),
      lines,
    };
  }, [attacksSlice, mapBlasts, map.id, map.tokens, targetTok, aimHere, attackerTok, targetMeters, actors]);

  const scene = useMemo<MapScene>(
    () => ({
      combatMarks,
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
    [view, actors, selected, turnTokenId, isGM, showWalls, showGrid, combatMarks]
  );

  // ---------------- server events ----------------
  useServerEvent(
    'ping',
    (p: { mapId: string; x: number; y: number; name?: string; userId: string } | null) => {
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
    const here = (map.tokens || []).find((tt) => tt.id === id);
    if (here) {
      const timer = setTimeout(() => {
        rRef.current?.centerOn(here.x, here.y, 36);
        setUI({ focusTokenId: null, ...(isGM ? { selectedTokenIds: [id] } : {}) });
      }, 40);
      return () => clearTimeout(timer);
    }
    if (isGM) {
      const other = Object.values(game.maps || {}).find((m) => (m.tokens || []).some((tt) => tt.id === id));
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
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || target?.isContentEditable) return;
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
  const removeTokens = async (ids: string[]) => {
    const n = ids.length;
    const names = ids.map((id) => map.tokens.find((tt) => tt.id === id)?.name).filter(Boolean);
    if (!(await confirmAction(n === 1 ? t('Retirer « {name} » de la carte ?', { name: names[0] || t('ce pion') }) : t('Retirer {n} pions de la carte ?', { n })))) return;
    send('maps/removeToken', { mapId, tokenIds: ids }).then(() => setUI({ selectedTokenIds: [] }), quiet);
  };
  const ping = (info: { fx: number; fy: number }) => send('ui/ping', { mapId, x: info.fx, y: info.fy }, { silent: true }).catch(quiet);
  const spawnAt = (templateId: string, x: number, y: number) => {
    send<string[] | { tokenIds?: string[]; unplaced?: number } | null>('bestiary/spawn', { templateId, mapId, x, y, count: spawnOpts.count, hidden: spawnOpts.hidden }).then(
      (res) => {
        const placed = Array.isArray(res) ? res.length : res?.tokenIds?.length ?? spawnOpts.count;
        const unplaced = Array.isArray(res) ? 0 : res?.unplaced;
        toast(t('{n} PNJ placé(s)', { n: placed }) + (unplaced ? ' · ' + t('{n} sans place libre', { n: unplaced }) : ''), placed ? 'success' : 'warn');
      },
      quiet
    );
  };
  const doorAt = (x: number, y: number) => (map.doors || []).find((d) => d.x === x && d.y === y);
  const updateTokens = (ids: string[], patch: Record<string, unknown>) => Promise.all(ids.map((tokenId) => send('maps/updateToken', { mapId, tokenId, patch }).catch(quiet)));
  const targetsFor = (tok: Token) => (selected.has(tok.id) && selected.size > 1 ? map.tokens.filter((tt) => selected.has(tt.id)) : [tok]);

  // Movement already spent this combat turn (server-side budget on the token, see 20-maps doMove).
  const moveKey = inCombat ? `${combat.startedAt || 0}:${combat.round || 1}` : null;
  const movementInfo = (tok: Token, path: Cell[]): MoveInfo => {
    const step: number = pathLength(path, map.metersPerCell || 1);
    const used = moveKey && tok.moveBudget?.key === moveKey ? Number(tok.moveBudget.meters) || 0 : 0;
    const meters = Math.round((used + step) * 10) / 10;
    const actor = tok.actorId ? actors[tok.actorId] : null;
    let walk: number | null = null, run: number | null = null;
    if (actor) {
      try {
        const mv = derive(actor).movement;
        walk = mv.walk;
        run = mv.run;
      } catch {}
    }
    const spent = used ? ' ' + t('(dont {m} m déjà parcourus)', { m: Math.round(used * 10) / 10 }) : '';
    if (walk == null || run == null) return { meters, step, used, color: '#3fd6d0', label: `${step} m` };
    const left = Math.round((run - meters) * 10) / 10;
    const rest = moveKey ? ' · ' + t('reste {m} m', { m: left }) : '';
    if (meters <= walk) return { meters, step, used, walk, run, color: '#3fd6d0', label: `${meters} m · ${t('marche')}${rest}${spent}` };
    if (meters <= run) return { meters, step, used, walk, run, color: '#e0a63f', label: `${meters} m · ${t('course')}${rest}${spent}` };
    return { meters, step, used, walk, run, color: '#e05c5c', label: `${meters} m · ${t('trop loin')}${spent}`, tooFar: true };
  };

  const playerPath = (tok: Token, to: Cell): Cell[] | null => {
    const blockers: Token[] = [], occupied: Token[] = [];
    for (const tt of map.tokens || []) {
      if (tt.id === tok.id || tt.hidden) continue;
      (tt.disposition === 'pc' || tt.disposition === 'ally' ? occupied : blockers).push(tt);
    }
    return findPath(map, tok, to, { grid, blockers, occupied, allowed: view.known });
  };

  // ---------------- pointer handlers ----------------
  const handlers: MapHandlers & { onContext: (info: MapPointerInfo) => void } = {
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
        dragRef.current = { kind: 'tokens', lead: tok, group: map.tokens.filter((tt) => sel.has(tt.id)), target: null };
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
      let path: Cell[] | null;
      if (isGM) path = info.alt ? [{ x: lead.x, y: lead.y }, { x: tx, y: ty }] : findPath(map, lead, d.target, { grid });
      else path = playerPath(lead, d.target);
      d.path = path;
      const ghosts = d.group.map((tt) => ({ token: tt, x: tt.x + dx, y: tt.y + dy }));
      if (!path) {
        d.mv = null;
        r.setOverlay({ ghosts, pathLabel: isGM ? t('Pas de chemin — Alt pour ignorer les murs') : t('Inaccessible'), pathColor: '#e05c5c', labelAt: { x: tx + 0.5, y: ty - 0.45 } });
        return;
      }
      const mv = movementInfo(lead, path);
      d.mv = mv;
      r.setOverlay({ ghosts, path: dx || dy ? path : null, pathColor: mv.color, pathLabel: dx || dy ? mv.label + (isGM && info.alt ? ' · ' + t('murs ignorés') : '') : null, labelAt: { x: tx + 0.5, y: ty - 0.45 } });
    },
    onUp(info, moved) {
      const d = dragRef.current;
      dragRef.current = null;
      const r = rRef.current;
      r?.setOverlay({});
      hoverWallRef.current = null;
      if (!d || !moved) return;
      if (d.kind === 'box') {
        if (!r) return;
        const a = r.toWorld(Math.min(d.sx, info.sx), Math.min(d.sy, info.sy));
        const b = r.toWorld(Math.max(d.sx, info.sx), Math.max(d.sy, info.sy));
        const hits = map.tokens.filter((tt) => tt.x + 1 > a.x && tt.x < b.x && tt.y + 1 > a.y && tt.y < b.y).map((tt) => tt.id);
        setUI({ selectedTokenIds: [...new Set([...selected, ...hits])] });
        return;
      }
      const tt = d.target;
      if (!tt || (tt.x === d.lead.x && tt.y === d.lead.y)) return;
      if (!isGM) {
        if (map.movementLocked) return toast(t('Le MJ a verrouillé les déplacements'), 'warn');
        if (!d.path) return toast(t('Destination inaccessible'), 'warn');
        if (inCombat && d.mv?.tooFar)
          return toast(
            t('Trop loin pour ce tour : {step} m demandés, il reste {left} m (course max {run} m)', { step: d.mv.step, left: Math.max(0, Math.round((d.mv.run! - d.mv.used) * 10) / 10), run: d.mv.run }),
            'warn'
          );
        send('maps/moveToken', { mapId, tokenId: d.lead.id, x: tt.x, y: tt.y }).catch(quiet);
        return;
      }
      const dx = tt.x - d.lead.x, dy = tt.y - d.lead.y;
      if (d.group.length === 1) send('maps/moveToken', { mapId, tokenId: d.lead.id, x: tt.x, y: tt.y, ignoreWalls: !!info.alt }).catch(quiet);
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
      if (info.alt) {
        ping(info);
        return;
      }
      // Players: a click on another character's token targets it (again: clears the target).
      if (!isGM && !placing) {
        const tok = rRef.current?.tokenAt(info.fx, info.fy);
        if (tok && !ownsToken(tok) && tok.actorId) return setTarget(tok.id);
      }
      if (placing) {
        if (info.cx < 0 || info.cy < 0 || info.cx >= map.width || info.cy >= map.height) return;
        spawnAt(placing.templateId, info.cx, info.cy);
        if (!info.shift) setPlacing(null);
        return;
      }
      // segment doors (icon or the door line) first, then tile doors
      const wd = rRef.current?.wallDoorAt(info.sx, info.sy) || null;
      const target = wd ? { id: wd.id, state: wd.door!.state, kind: wd.door!.kind } : doorAt(info.cx, info.cy);
      if (target) {
        if (isGM && !view.preview) {
          if (info.shift) {
            const secret = target.kind !== 'secret';
            send('maps/setDoor', { mapId, doorId: target.id, kind: secret ? 'secret' : 'door' }).then(
              () => toast(secret ? t('Porte secrète (invisible des joueurs fermée)') : t('Porte normale')),
              quiet
            );
          } else {
            const next = NEXT_DOOR_STATE[target.state] || 'closed';
            send('maps/setDoor', { mapId, doorId: target.id, state: next }).then(() => toast(t('Porte : {state}', { state: doorLabel(next).toLowerCase() })), quiet);
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
      const door: DoorTarget | undefined = wd ? { ...wd.door!, id: wd.id } : doorAt(info.cx, info.cy);
      r.canvas.style.cursor = placing ? 'crosshair' : tok && (isGM || ownsToken(tok)) ? 'grab' : door ? 'pointer' : '';
      const hoverWallId = wd?.id || null;
      if (hoverWallId !== hoverWallRef.current && !placing) {
        hoverWallRef.current = hoverWallId;
        r.setOverlay(hoverWallId ? { hoverWallId } : {});
      }
      if (isGM && !view.preview) {
        const note = (map.notes || []).find((n) => n.x === info.cx && n.y === info.cy);
        const doorState = doorLabel(door?.state).toLowerCase();
        const doorTip = door
          ? `${door.name ? door.name + ' — ' : ''}${door.kind === 'secret' ? t('porte secrète, {state}', { state: doorState }) : doorState} · ${t('clic : changer · Maj+clic : secrète')}`
          : null;
        const text = note?.text || doorTip || (tok?.hidden ? t('{name} (caché aux joueurs)', { name: tok.name }) : null);
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
  const activeName = (game.scene?.activeMapId && game.maps?.[game.scene.activeMapId]?.name) || t('aucune carte');
  const mapOptions = Object.values(game.maps || {})
    .sort((a, b) => compare(a.folder || '', b.folder || '') || compare(a.name, b.name))
    .map((m) => ({ value: m.id, label: `${m.id === game.scene?.activeMapId ? '● ' : ''}${m.folder ? m.folder + ' › ' : ''}${m.name}` }));
  const previewOptions = [
    { value: '', label: t('Vue MJ') },
    { value: 'party', label: t('Vue du groupe') },
    ...Object.values(game.users || {})
      .filter((u) => (u.characterIds || []).length)
      .map((u) => ({ value: u.id, label: t('Vue de {name}', { name: u.name }) })),
  ];
  const myTokens = (map.tokens || []).filter(ownsToken);
  const turnEntry = combat?.active ? (combat.entries || []).find((e) => e.id === combat.currentId) || null : null;

  const gmToolbar = (
    <div className={'map-toolbar' + (toolsOpen ? '' : ' collapsed')}>
      <IconButton icon={toolsOpen ? '◂' : '☰'} title={toolsOpen ? t('Replier la barre') : t('Outils de la carte')} onClick={() => setToolsOpen(!toolsOpen)} />
      {toolsOpen && (
        <>
          <Select className="map-tb-select" value={map.id} options={mapOptions} onChange={(id) => setUI({ viewMapId: id })} title={t('Carte affichée sur ton écran')} />
          {shownToPlayers ? (
            <Badge color="green" title={t('Les joueurs voient cette carte')}>
              ● {t('Affichée aux joueurs')}
            </Badge>
          ) : (
            <Button
              small
              variant="accent"
              onClick={() => send('maps/setActive', { mapId }).then(() => toast(t('Carte affichée aux joueurs'), 'success'), quiet)}
              title={t('Les joueurs voient : {name}', { name: activeName })}
            >
              {t('Montrer aux joueurs')}
            </Button>
          )}
          <span className="map-tb-sep"></span>
          <Toggle label={t('Verrou')} title={t('Bloquer les déplacements des joueurs')} value={map.movementLocked} onChange={(v) => send('maps/update', { mapId, patch: { movementLocked: v } }).catch(quiet)} />
          <Toggle label={t('Brouillard')} title={t('Brouillard de guerre pour les joueurs')} value={map.fog !== false} onChange={(v) => send('maps/update', { mapId, patch: { fog: v } }).catch(quiet)} />
          <Select
            className="map-tb-select small"
            value={map.lighting || 'bright'}
            options={lightingOptions()}
            onChange={(v) => send('maps/update', { mapId, patch: { lighting: v } }).catch(quiet)}
            title={t('Éclairage ambiant')}
          />
          <Select
            className="map-tb-select small"
            value={String(map.weather?.visibility || 0)}
            options={[t('Temps clair'), t('Pluie / brouillard légers'), t('Pluie / brouillard modérés'), t('Pluie / brouillard denses')].map((label, i) => ({ value: String(i), label }))}
            onChange={(v) => send('maps/update', { mapId, patch: { weather: { visibility: Number(v) } } }).catch(quiet)}
            title={t('Visibilité (modificateur d’environnement des attaques à distance)')}
          />
          <Select
            className="map-tb-select small"
            value={String(map.weather?.wind || 0)}
            options={[t('Pas de vent'), t('Vent léger'), t('Vent modéré'), t('Vent fort')].map((label, i) => ({ value: String(i), label }))}
            onChange={(v) => send('maps/update', { mapId, patch: { weather: { wind: Number(v) } } }).catch(quiet)}
            title={t('Vent (modificateur d’environnement des attaques à distance)')}
          />
          {(map.walls || []).length > 0 && (
            <Toggle label={t('Afficher les murs')} title={t('Tracer les murs (segments) par-dessus la carte — visible par toi seul')} value={showWalls} onChange={setShowWalls} />
          )}
          {isImageMap(map) && <Toggle label={t('Grille')} title={t("Quadrillage discret par-dessus l'image")} value={showGrid} onChange={setShowGrid} />}
          {tileStyleToggle}
          <span className="map-tb-sep"></span>
          <Button
            small
            onClick={() =>
              send<string[]>('maps/placePCs', { mapId }).then((ids) => toast(ids?.length ? t('{n} PJ placé(s)', { n: ids.length }) : t('Tous les PJ sont déjà sur la carte')), quiet)
            }
            title={t('Poser un pion pour chaque PJ absent de la carte')}
          >
            {t('Placer les PJ')}
          </Button>
          <Select className="map-tb-select small" value={preview} options={previewOptions} onChange={setPreview} title={t('Prévisualiser ce que voient les joueurs')} />
          <Toggle label={t('Zones non vues')} title={t("Teinter les cases qu'aucun PJ ne voit")} value={tintUnseen} onChange={setTintUnseen} />
          <span className="map-tb-sep"></span>
          <Button small variant={drawer ? 'primary' : 'default'} onClick={() => setDrawer(!drawer)} title={t('Glisser des PNJ du bestiaire sur la carte')}>
            ☠ {t('Bestiaire')}
          </Button>
          <Button small variant="ghost" onClick={() => setUI({ mapsEditId: map.id, mainTab: 'maps' })} title={t("Ouvrir l'éditeur de carte")}>
            ✎ {t('Éditer')}
          </Button>
        </>
      )}
      <IconButton icon="⌖" title={t('Recentrer la carte')} onClick={() => rRef.current?.fit()} />
    </div>
  );

  const playerToolbar = (
    <div className="map-toolbar">
      <span className="map-title">{map.name}</span>
      {myTokens.map((tt) => (
        <Button key={tt.id} small variant="ghost" onClick={() => rRef.current?.centerOn(tt.x, tt.y, 32)} title={t('Centrer sur {name}', { name: tt.name })}>
          ◎ {tt.name}
        </Button>
      ))}
      {isImageMap(map) && <Toggle label={t('Grille')} title={t("Quadrillage discret par-dessus l'image")} value={showGrid} onChange={setShowGrid} />}
      {tileStyleToggle}
      <IconButton icon="⌖" title={t('Recentrer la carte')} onClick={() => rRef.current?.fit()} />
    </div>
  );

  const attackPreset = () => {
    if (!attacking) return null;
    if (!attacking.weaponId) return { label: 'Attaque', targetTokenId: targetTok?.id };
    const a = actors[attacking.actorId];
    const w = (hasSheet(a) ? a.weapons : []).find((x) => x.id === attacking.weaponId);
    return { skillId: w?.skill || 'exotic_weapon', weaponId: attacking.weaponId, label: `Attaque — ${w?.nameFr || w?.name || ''}`, targetTokenId: targetTok?.id };
  };

  return (
    <div className="map-root" onContextMenu={(e) => e.preventDefault()}>
      <MapCanvas rendererRef={rRef} scene={scene} handlers={handlers} className={placing ? 'placing' : ''} />
      {isGM ? gmToolbar : playerToolbar}
      <div className="map-banners">
        {map.movementLocked && <div className="map-banner warn">⊘ {t('Déplacements verrouillés par le MJ')}</div>}
        {view.preview && (
          <div className="map-banner info">
            {t('Aperçu : {view}', { view: previewOptions.find((o) => o.value === preview)?.label || '' })}{' '}
            <button className="map-banner-x" onClick={() => setPreview('')}>
              ✕
            </button>
          </div>
        )}
        {isGM && !shownToPlayers && <div className="map-banner dim">{t('Les joueurs voient : {name}', { name: activeName })}</div>}
        {turnEntry && inCombat && (
          <div className="map-banner combat">
            {tRich(t('Round {round} · Tour de {name}'), { round: combat.round, name: <strong key="name">{turnEntry.hidden && !isGM ? '???' : turnEntry.name}</strong> })}
          </div>
        )}
        {placing && (
          <div className="map-banner info">
            {t('Clique une case pour placer « {name} » ×{n} · Maj+clic : en placer plusieurs · Échap : annuler', { name: placing.name, n: spawnOpts.count })}
          </div>
        )}
        {(targetTok || aimHere) && (
          <div className="map-banner target">
            {targetTok ? (
              <>
                🎯 {tRich(t('Cible : {name}'), { name: <strong key="name">{targetTok.name}</strong> })}
                {targetMeters !== null ? ` · ${targetMeters} m` : ''}
              </>
            ) : null}
            {aimHere ? (
              <>
                {targetTok ? ' · ' : ''}💣 {t('Point visé ({x}, {y})', { x: aimHere.x, y: aimHere.y })}
              </>
            ) : null}
            {attackerTok && (
              <button
                className="map-banner-btn"
                onClick={() =>
                  setAttacking({ actorId: attackerTok.actorId!, weaponId: defaultWeapon(actors[attackerTok.actorId!], targetMeters, !!aimHere && !targetTok)?.id || null })
                }
                title={t('Jet d’attaque de {name}', { name: attackerTok.name })}
              >
                ⚔ {isGM ? t('Attaquer avec {name}', { name: attackerTok.name }) : t('Attaquer')}
              </button>
            )}
            {isGM && !attackerTok && targetTok && <span className="faint small">{t('sélectionne l’attaquant')}</span>}
            <button
              className="map-banner-x"
              onClick={() => {
                setTarget(null);
                setAimPoint(null);
              }}
              title={t('Effacer la cible')}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {attacking && hasSheet(actors[attacking.actorId]) && (
        <RollDialog game={game} actor={actors[attacking.actorId]} onClose={() => setAttacking(null)} preset={attackPreset() ?? undefined} />
      )}
      {!isGM && (
        <div className="map-hint">
          {t('Glisse ton pion pour te déplacer · clic sur un autre pion : le cibler · clic sur une porte proche : ouvrir/fermer · double-clic : fiche · Alt+clic ou appui long : ping')}
        </div>
      )}
      {isGM && drawer && <BestiaryDrawer game={game} opts={spawnOpts} setOpts={setSpawnOpts} placing={placing} setPlacing={setPlacing} onClose={() => setDrawer(false)} />}
      {tip && (
        <div className="map-tip" style={{ left: tip.x + 14 + 'px', top: tip.y + 14 + 'px' }}>
          {tip.text}
        </div>
      )}
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          {menuContent(menu)}
        </ContextMenu>
      )}
    </div>
  );

  // ---------------- context menu content ----------------
  function menuContent(menu: MenuState): ReactNode {
    const close = () => setMenu(null);
    const act = (fn: () => unknown) => () => {
      close();
      fn();
    };
    const tok = menu.tokenId ? map.tokens.find((tt) => tt.id === menu.tokenId) : null;
    const { x, y } = menu.cell;
    if (tok) {
      const targets = isGM ? targetsFor(tok) : [tok];
      const ids = targets.map((tt) => tt.id);
      const multi = targets.length > 1;
      const hasTorch = !!tok.light?.radius;
      const st = tok.status || [];
      if (!isGM) {
        if (!ownsToken(tok)) {
          return (
            <>
              <div className="map-menu-head">{tok.name}</div>
              {tok.actorId && (
                <button className="map-menu-item" onClick={act(() => setTarget(tok.id))}>
                  {ui.targetTokenId === tok.id ? t('Ne plus cibler') : '🎯 ' + t('Cibler')}
                </button>
              )}
              {tok.actorId && actors[tok.actorId] && (
                <button className="map-menu-item" onClick={act(() => openSheet(tok.actorId))}>
                  {t('Ouvrir la fiche')}
                </button>
              )}
              <button className="map-menu-item" onClick={act(() => setAimPoint(mapId, tok.x, tok.y))}>
                💣 {t('Viser ce point (grenade)')}
              </button>
              <button className="map-menu-item" onClick={act(() => ping({ fx: menu.fx, fy: menu.fy }))}>
                {t('Pinger ici')}
              </button>
            </>
          );
        }
        return (
          <>
            <div className="map-menu-head">{tok.name}</div>
            <button className="map-menu-item" onClick={act(() => openSheet(tok.actorId))}>
              {t('Ouvrir la fiche')}
            </button>
            <button className="map-menu-item" onClick={act(() => send('maps/updateToken', { mapId, tokenId: tok.id, patch: { light: hasTorch ? null : TORCH } }).catch(quiet))}>
              {hasTorch ? t('Éteindre la lampe') : t('Allumer une lampe torche')}
            </button>
            <div className="map-menu-row">
              {['à terre', 'à couvert'].map((s) => (
                <button
                  key={s}
                  className={'chip' + (st.includes(s) ? ' on' : '')}
                  onClick={() => send('maps/updateToken', { mapId, tokenId: tok.id, patch: { status: st.includes(s) ? st.filter((v) => v !== s) : [...st, s] } }).catch(quiet)}
                >
                  {STATUS_GLYPHS[s] || ''} {statusText(s)}
                </button>
              ))}
            </div>
            <button className="map-menu-item" onClick={act(() => ping({ fx: menu.fx, fy: menu.fy }))}>
              {t('Pinger ici')}
            </button>
          </>
        );
      }
      const allHidden = targets.every((tt) => tt.hidden);
      const dispoColors: Record<string, string> = { pc: 'cyan', ally: 'green', neutral: 'amber', hostile: 'red' };
      return (
        <>
          <div className="map-menu-head">
            {multi ? t('{n} pions sélectionnés', { n: targets.length }) : tok.name}
            {!multi && <Badge color={dispoColors[tok.disposition] || 'dim'}>{dispoLabel(tok.disposition)}</Badge>}
          </div>
          {!multi && tok.actorId && actors[tok.actorId] && (
            <button className="map-menu-item" onClick={act(() => openSheet(tok.actorId))}>
              {t('Ouvrir la fiche')}
            </button>
          )}
          {!multi && tok.actorId && (
            <button className="map-menu-item" onClick={act(() => setTarget(tok.id))} title={t('Cible des attaques du pion sélectionné')}>
              {ui.targetTokenId === tok.id ? t('Ne plus cibler') : '🎯 ' + t('Cibler')}
            </button>
          )}
          <button className="map-menu-item" onClick={act(() => updateTokens(ids, { hidden: !allHidden }))}>
            {allHidden ? t('Montrer aux joueurs') : t('Cacher aux joueurs')}
          </button>
          <div className="map-menu-label">{t('Disposition')}</div>
          <div className="map-menu-row">
            {Object.entries(DISPO).map(([k, d]) => (
              <button
                key={k}
                className={'chip' + (targets.every((tt) => tt.disposition === k) ? ' on' : '')}
                style={{ '--chip': d.color } as CSSProperties}
                onClick={() => updateTokens(ids, { disposition: k })}
              >
                {t(d.label)}
              </button>
            ))}
          </div>
          <div className="map-menu-label">{t('Statut')}</div>
          <div className="map-menu-row">
            {STATUSES.map((s) => {
              const on = targets.every((tt) => (tt.status || []).includes(s));
              return (
                <button
                  key={s}
                  className={'chip' + (on ? ' on' : '')}
                  onClick={() =>
                    Promise.all(
                      targets.map((tt) =>
                        send('maps/updateToken', { mapId, tokenId: tt.id, patch: { status: on ? (tt.status || []).filter((v) => v !== s) : [...new Set([...(tt.status || []), s])] } }).catch(quiet)
                      )
                    )
                  }
                >
                  {STATUS_GLYPHS[s] || ''} {statusText(s)}
                </button>
              );
            })}
          </div>
          <button className="map-menu-item" onClick={act(() => updateTokens(ids, { light: hasTorch ? null : TORCH }))}>
            {hasTorch ? t('Éteindre la lampe torche') : t('Lampe torche (6 m)')}
          </button>
          <button className="map-menu-item" onClick={act(() => send('combat/add', { tokenIds: ids }).then(() => toast(t('Ajouté au combat'), 'success'), quiet))}>
            {t('Ajouter au combat')}
          </button>
          {!multi && (
            <button
              className="map-menu-item"
              onClick={act(async () => {
                const name = await promptText(t('Nom du pion'), tok.name);
                if (name && name.trim()) send('maps/updateToken', { mapId, tokenId: tok.id, patch: { name: name.trim() } }).catch(quiet);
              })}
            >
              {t('Renommer…')}
            </button>
          )}
          <button className="map-menu-item danger" onClick={act(() => removeTokens(ids))}>
            {t('Retirer de la carte')}
          </button>
        </>
      );
    }
    // empty cell
    const inside = x >= 0 && y >= 0 && x < map.width && y < map.height;
    // Blast markers covering this cell (GM: remove one — a cloud blown away, a marker no longer needed).
    const blastsHere = isGM ? mapBlasts.filter((b) => Math.hypot(b.x - x, b.y - y) <= Math.max(1, (Number(b.radius ?? b.reach) || 0) / (Number(map.metersPerCell) || 1) + 0.5)) : [];
    const aimItems = inside && (
      <>
        <button className="map-menu-item" onClick={act(() => setAimPoint(mapId, x, y))}>
          💣 {t('Viser ce point (grenade)')}
        </button>
        {aimHere && (
          <button className="map-menu-item" onClick={act(() => setAimPoint(null))}>
            {t('Effacer le point visé')}
          </button>
        )}
        {blastsHere.map((b) => (
          <button className="map-menu-item" key={b.id} onClick={act(() => send('attack/removeBlast', { blastId: b.id }).catch(quiet))}>
            ✕ {t('Retirer : {what}', { what: blastLabel({ ...b, scattered: false }) || (typeof b.weaponName === 'string' ? b.weaponName : b.weaponName?.fr) || t('souffle') })}
          </button>
        ))}
      </>
    );
    if (!isGM || view.preview) {
      return (
        <>
          <button className="map-menu-item" onClick={act(() => ping({ fx: menu.fx, fy: menu.fy }))}>
            {t('Pinger ici')}
          </button>
          {aimItems}
        </>
      );
    }
    const wallDoor = menu.wallDoorId ? (map.walls || []).find((w) => w.id === menu.wallDoorId && w.door) : null;
    const door: DoorTarget | undefined = wallDoor ? { ...wallDoor.door!, id: wallDoor.id } : doorAt(x, y);
    const lightsHere = (map.lights || []).filter((l) => l.x === x && l.y === y);
    const pcList = Object.values(actors)
      .filter((a): a is Actor => !!a && a.type === 'pc' && !('retired' in a && a.retired))
      .sort((a, b) => a.name.localeCompare(b.name));
    const notesHere = (map.notes || []).filter((n) => n.x === x && n.y === y);
    return (
      <>
        <div className="map-menu-head">{t('Case {x}, {y}', { x, y })}</div>
        <button className="map-menu-item" onClick={act(() => ping({ fx: menu.fx, fy: menu.fy }))}>
          {t('Pinger ici')}
        </button>
        {aimItems}
        {inside && (
          <>
            <button
              className="map-menu-item"
              onClick={act(() =>
                send<string[]>('maps/placePCs', { mapId, x, y }).then((ids) => toast(ids?.length ? t('{n} PJ placé(s)', { n: ids.length }) : t('Tous les PJ sont déjà sur la carte')), quiet)
              )}
            >
              {t('Placer les PJ ici')}
            </button>
            {pcList.length > 0 && (
              <>
                <div className="map-menu-label">{t('Placer un PJ ici')}</div>
                <div className="map-menu-row">
                  {pcList.map((a) => {
                    const onMap = (map.tokens || []).some((tk) => tk.actorId === a.id);
                    return (
                      <button
                        key={a.id}
                        className="chip"
                        style={a.color ? ({ '--chip': a.color } as CSSProperties) : undefined}
                        title={onMap ? t('Déplacer {name} ici', { name: a.name }) : t('Placer {name} ici', { name: a.name })}
                        onClick={act(() => send('maps/placePCs', { mapId, x, y, actorIds: [a.id], move: true }).catch(quiet))}
                      >
                        {onMap ? '↦ ' : '＋ '}
                        {a.name}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <button className="map-menu-item" onClick={act(() => send('maps/addLight', { mapId, light: { x, y, radius: 6, color: '#ffcc88', on: true } }).catch(quiet))}>
              {t('Ajouter une lumière ici')}
            </button>
            <button
              className="map-menu-item"
              onClick={act(async () => {
                const text = await promptText(t('Note MJ (visible par toi seul)'));
                if (text && text.trim()) send('maps/addNote', { mapId, note: { x, y, text: text.trim() } }).catch(quiet);
              })}
            >
              {t('Ajouter une note ici')}
            </button>
            <button className="map-menu-item" onClick={act(() => setDrawer(true))}>
              {t('Placer un PNJ…')}
            </button>
          </>
        )}
        {door && (
          <>
            <div className="map-menu-label">{door.name ? t('Porte — {name}', { name: door.name }) : t('Porte')}</div>
            <div className="map-menu-row">
              {(['open', 'closed', 'locked'] as const).map((s) => (
                <button key={s} className={'chip' + (door.state === s ? ' on' : '')} onClick={() => send('maps/setDoor', { mapId, doorId: door.id, state: s }).catch(quiet)}>
                  {doorLabel(s)}
                </button>
              ))}
              <button
                className={'chip' + (door.kind === 'secret' ? ' on' : '')}
                style={{ '--chip': '#e0468f' } as CSSProperties}
                onClick={() => send('maps/setDoor', { mapId, doorId: door.id, kind: door.kind === 'secret' ? 'door' : 'secret' }).catch(quiet)}
              >
                {t('Secrète')}
              </button>
            </div>
          </>
        )}
        {lightsHere.map((l) => (
          <Fragment key={l.id}>
            <div className="map-menu-label">{t('Lumière')}</div>
            <div className="map-menu-row">
              <button className={'chip' + (l.on !== false ? ' on' : '')} onClick={() => send('maps/toggleLight', { mapId, lightId: l.id }).catch(quiet)}>
                {l.on !== false ? t('Allumée') : t('Éteinte')}
              </button>
              <button className="chip" onClick={act(() => send('maps/removeLight', { mapId, lightId: l.id }).catch(quiet))}>
                {t('Supprimer')}
              </button>
            </div>
          </Fragment>
        ))}
        {notesHere.map((n) => (
          <Fragment key={n.id}>
            <div className="map-menu-label">{t('Note')}</div>
            <div className="map-menu-note">{n.text}</div>
            <div className="map-menu-row">
              <button
                className="chip"
                onClick={act(async () => {
                  const text = await promptText(t('Note MJ'), n.text);
                  if (text != null) send('maps/updateNote', { mapId, noteId: n.id, patch: { text } }).catch(quiet);
                })}
              >
                {t('Modifier')}
              </button>
              <button className="chip" onClick={act(() => send('maps/removeNote', { mapId, noteId: n.id }).catch(quiet))}>
                {t('Supprimer')}
              </button>
            </div>
          </Fragment>
        ))}
      </>
    );
  }
}

interface ContextMenuProps {
  menu: MenuState;
  onClose: () => void;
  children?: ReactNode;
}

function ContextMenu({ menu, onClose, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
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
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const tt = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    return () => {
      clearTimeout(tt);
      window.removeEventListener('pointerdown', away);
    };
  }, [onClose]);
  return (
    <div className="map-menu" ref={ref} style={{ left: pos.left + 'px', top: pos.top + 'px' }} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}

interface BestiaryDrawerProps {
  game: GameView;
  opts: { count: number; hidden: boolean };
  setOpts: (o: { count: number; hidden: boolean }) => void;
  placing: { templateId: string; name: string } | null;
  setPlacing: (p: { templateId: string; name: string } | null) => void;
  onClose: () => void;
}

function BestiaryDrawer({ game, opts, setOpts, placing, setPlacing, onClose }: BestiaryDrawerProps) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return Object.values(game.bestiary || {})
      .filter((tt) => !needle || `${tt.name} ${tt.folder || ''} ${tt.metatype || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => compare(a.folder || '', b.folder || '') || compare(a.name, b.name));
  }, [game.bestiary, q]);
  const groups: Array<{ folder: string; items: Template[] }> = [];
  for (const tt of list) {
    const f = tt.folder || '';
    if (!groups.length || groups[groups.length - 1].folder !== f) groups.push({ folder: f, items: [] });
    groups[groups.length - 1].items.push(tt);
  }
  return (
    <aside className="map-drawer">
      <header className="map-drawer-head">
        <strong>{t('Bestiaire')}</strong>
        <IconButton icon="✕" title={t('Fermer')} onClick={onClose} />
      </header>
      <div className="map-drawer-opts">
        <SearchBox value={q} onChange={setQ} placeholder={t('Rechercher un PNJ…')} />
        <div className="row spread">
          <span className="small muted">{t('Nombre')}</span>
          <NumberInput small value={opts.count} min={1} max={12} onChange={(v) => setOpts({ ...opts, count: v })} />
        </div>
        <Toggle label={t('Placer caché')} value={opts.hidden} onChange={(v) => setOpts({ ...opts, hidden: v })} />
      </div>
      <div className="map-drawer-list">
        {!list.length && <div className="empty small">{Object.keys(game.bestiary || {}).length ? t('Aucun résultat') : t('Bestiaire vide')}</div>}
        {groups.map((g, gi) => (
          <Fragment key={gi + ':' + g.folder}>
            <div className="map-drawer-group">{g.folder || t('Divers')}</div>
            {g.items.map((tt) => (
              <div
                key={tt.id}
                className={'map-drawer-item' + (placing?.templateId === tt.id ? ' active' : '')}
                draggable="true"
                title={t('Glisse sur la carte, ou clique puis clique une case')}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/sr-template', tt.id);
                  e.dataTransfer.setData('text/plain', tt.name);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => setPlacing(placing?.templateId === tt.id ? null : { templateId: tt.id, name: tt.name })}
              >
                <span className="map-drawer-dot" style={{ background: tt.color || '#e05c5c' }}></span>
                <span className="grow">{tt.name}</span>
                {tt.npc?.professionalRating != null && <span className="small muted">{t('PR {n}', { n: tt.npc.professionalRating })}</span>}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </aside>
  );
}
