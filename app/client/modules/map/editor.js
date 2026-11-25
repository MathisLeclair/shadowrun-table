// GM map editor: tiles (brush, line, rectangles, rooms, flood fill, eraser), segment walls & doors, doors, lights,
// regions, notes, tokens, background image.
// Tile and segment-wall edits are local (shared undo/redo) and saved with a debounce through maps/setTiles and
// maps/setWalls; other objects are sent immediately.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, Select, Toggle, Badge, Field, TextInput, NumberInput, confirmAction, promptText } from '../../lib/ui.js';
import { send, upload } from '../../lib/net.js';
import { setUI, toast, openSheet } from '../../lib/ui-store.js';
import { TILE_INFO } from '/shared/vision.js';
import { MapCanvas } from './MapCanvas.js';
import { THEME_OPTIONS, LIGHTING_OPTIONS, DISPO, tileSwatch, getImage, wallKind } from './renderer.js';

const WALL_TOOLS = new Set(['wall', 'wdoor']);
const WALL_TYPES = [
  { value: 'wall', label: 'Mur (bloque tout)' },
  { value: 'window', label: 'Fenêtre (bloque le passage)' },
  { value: 'curtain', label: 'Rideau (bloque la vue)' },
  { value: 'ethereal', label: 'Repère (ne bloque rien)' },
  { value: 'door', label: 'Porte' },
  { value: 'secret', label: 'Porte secrète' },
];
const WDOOR_KINDS = [
  { value: 'door', label: 'Porte' },
  { value: 'secret', label: 'Porte secrète' },
  { value: 'window', label: 'Fenêtre' },
];
const BG_MODES = [
  { value: 'image', label: 'Image = sol (carte illustrée)' },
  { value: 'underlay', label: 'Calque sous les tuiles' },
];
const newWallId = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/** Wall type of a segment, including doors. */
const wallType = (w) => (w.door ? (w.door.kind === 'secret' ? 'secret' : 'door') : wallKind(w));
/** Apply a type to a wall (keeps the door state/name when it stays a door). */
function withType(w, type) {
  const base = { ...w };
  if (type === 'door' || type === 'secret') return { ...base, move: true, sight: true, door: { state: w.door?.state || 'closed', kind: type, ...(w.door?.name ? { name: w.door.name } : {}) } };
  return { ...base, move: type !== 'curtain' && type !== 'ethereal', sight: type !== 'window' && type !== 'ethereal', door: null };
}
/** Compact signature of walls (server sync / dirty checks). */
function wallsSig(walls) {
  let s = '';
  for (const w of walls || []) s += `${w.id}:${w.x1},${w.y1},${w.x2},${w.y2},${w.move === false ? 0 : 1}${w.sight === false ? 0 : 1}${w.door ? w.door.state + w.door.kind + (w.door.name || '') : ''};`;
  return s;
}

const TOOLS = [
  { id: 'brush', icon: '✎', label: 'Pinceau', key: 'b' },
  { id: 'line', icon: '╱', label: 'Ligne', key: 'l' },
  { id: 'rect', icon: '■', label: 'Rect.', key: 'r' },
  { id: 'outline', icon: '□', label: 'Contour', key: 'o' },
  { id: 'room', icon: '⌂', label: 'Pièce', key: 'p' },
  { id: 'fill', icon: '◍', label: 'Remplir', key: 'f' },
  { id: 'eraser', icon: '⌫', label: 'Gomme', key: 'e' },
  { id: 'pan', icon: '✥', label: 'Main', key: 'h' },
  { id: 'wall', icon: '┃', label: 'Mur', key: 'w' },
  { id: 'wdoor', icon: '⊓', label: 'Porte-mur', key: 'k' },
  { id: 'door', icon: '▯', label: 'Porte', key: 'd' },
  { id: 'light', icon: '✺', label: 'Lumière', key: 'i' },
  { id: 'region', icon: '⬚', label: 'Zone', key: 'z' },
  { id: 'note', icon: '!', label: 'Note', key: 'n' },
  { id: 'token', icon: '●', label: 'Pion', key: 't' },
  { id: 'select', icon: '➚', label: 'Choisir', key: 's' },
];
const PAINT = new Set(['brush', 'line', 'rect', 'outline', 'room', 'fill', 'eraser']);
const PALETTE = ['.', ',', '#', 'D', 'W', '=', 'T', 'c', 'o', 'm', 'v', 'b', 's', 'e', '~', 'g', 'r', 'x', 't', '_', ' '];
const TOOL_HELP = {
  brush: 'Clic-glisser pour peindre. Alt+clic ou clic droit : pipette.',
  line: 'Glisse du point de départ au point d’arrivée.',
  rect: 'Glisse pour remplir un rectangle avec la tuile choisie.',
  outline: 'Glisse pour tracer le contour d’un rectangle.',
  room: 'Glisse pour créer une pièce : murs autour, sol (tuile choisie) dedans.',
  fill: 'Clic : remplit la zone contiguë de même tuile.',
  eraser: 'Efface (vide) sous le pinceau.',
  pan: 'Glisse pour déplacer la vue. Astuce : Espace + glisser, clic molette ou clic droit glissé marchent avec tous les outils.',
  wall: 'Glisse pour tracer un mur (aimanté aux coins / demi-cases et aux extrémités des murs ; Alt : placement libre ; Maj : repartir du dernier point). Clic : sélectionner (Maj+clic : ajouter). Ctrl+glisser : sélection par cadre. Suppr : effacer.',
  wdoor: 'Glisse pour tracer une porte sur un mur. Clic sur un mur existant : le convertir selon le type choisi (porte, secrète, fenêtre).',
  door: 'Clic sur une case : pose une porte. Clic sur une porte : la sélectionner.',
  light: 'Clic : ajoute une lumière. Glisse une lumière pour la déplacer.',
  region: 'Glisse pour délimiter une zone nommée (pièce, secteur…).',
  note: 'Clic : épingle une note MJ (jamais visible des joueurs).',
  token: 'Clic : pose un pion. Glisse un pion pour le déplacer.',
  select: 'Clic sur un objet (pion, lumière, porte, mur, note, zone) pour le modifier.',
};
const ANCHORS = [
  { value: 'nw', label: '↖ Haut-gauche' }, { value: 'n', label: '↑ Haut' }, { value: 'ne', label: '↗ Haut-droite' },
  { value: 'w', label: '← Gauche' }, { value: 'c', label: '• Centre' }, { value: 'e', label: '→ Droite' },
  { value: 'sw', label: '↙ Bas-gauche' }, { value: 's', label: '↓ Bas' }, { value: 'se', label: '↘ Bas-droite' },
];
const DOOR_STATES = [{ value: 'closed', label: 'Fermée' }, { value: 'open', label: 'Ouverte' }, { value: 'locked', label: 'Verrouillée' }];
const DOOR_KINDS = [{ value: 'door', label: 'Porte' }, { value: 'gate', label: 'Grille' }, { value: 'shutter', label: 'Rideau métallique' }, { value: 'secret', label: 'Secrète' }];
const DISPO_OPTIONS = Object.entries(DISPO).map(([value, d]) => ({ value, label: d.label }));
const quiet = () => {};
/** Like Field but a <div>: a <label> would forward clicks on its text to the stepper buttons. */
const NumField = ({ label, children }) => html`<div class="field"><span class="field-label">${label}</span>${children}</div>`;

function lineCells(a, b) {
  const out = [];
  let x0 = a.x, y0 = a.y;
  const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0), sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 10000; i++) {
    out.push({ x: x0, y: y0 });
    if (x0 === b.x && y0 === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}
function rectOf(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}
function brushCells(c, size) {
  const out = [];
  const o = -Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push({ x: c.x + o + dx, y: c.y + o + dy });
  return out;
}

export function MapEditor({ game, map, onBack }) {
  const mapId = map.id;
  const rRef = useRef(null);
  const rowsRef = useRef(map.tiles.slice());
  const wallsRef = useRef(map.walls || []);
  const savedRef = useRef({ rows: rowsRef.current, walls: wallsRef.current }); // last state known to the server
  const lastEndRef = useRef(null); // last wall end point (Shift: chain walls)
  const [wallSel, setWallSel] = useState([]); // selected wall ids
  const [wallOpts, setWallOpts] = useState({ type: 'wall' });
  const [wdoorOpts, setWdoorOpts] = useState({ kind: 'door', state: 'closed' });
  const dimsRef = useRef(`${map.width}x${map.height}`);
  const [ver, setVer] = useState(0);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  // Segment-door states: players toggle doors live while the editor is open. A save sends the whole walls
  // array, so for every door the GM did not change on purpose here (door panel, new door, undo/redo of such
  // an edit) the CURRENT server state is sent instead of the editor's possibly stale copy.
  const serverWallsRef = useRef(map.walls || []);
  serverWallsRef.current = map.walls || [];
  const gmDoorEditsRef = useRef(new Set());
  const strokeRef = useRef(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef(null);
  const [saveState, setSaveState] = useState('saved');
  const [tool, setTool] = useState('brush');
  const [tile, setTile] = useState('#');
  const [size, setSize] = useState(1);
  const [doorOpts, setDoorOpts] = useState({ state: 'closed', kind: 'door' });
  const [lightOpts, setLightOpts] = useState({ radius: 6, color: '#ffcc88', on: true });
  const [regionOpts, setRegionOpts] = useState({ color: '#e0468f', gmOnly: false });
  const [tokenOpts, setTokenOpts] = useState({ actorId: '', name: 'PNJ', disposition: 'hostile', hidden: false });
  const [sel, setSel] = useState(null); // { type: 'door'|'light'|'region'|'note'|'token', id }
  const [panel, setPanel] = useState({ tools: false, props: false });
  const [resize, setResize] = useState({ width: map.width, height: map.height, anchor: 'c' });
  const [, forceTick] = useState(0);
  const bump = () => setVer((v) => v + 1);

  // ---------------- tiles & walls sync & save ----------------
  const serverWallsSig = wallsSig(map.walls);
  const serverKey = `${map.width}x${map.height}|${map.tiles.join('\n')}|${serverWallsSig}`;
  useEffect(() => {
    const dims = `${map.width}x${map.height}`;
    if (dims !== dimsRef.current) {
      dimsRef.current = dims;
      rowsRef.current = map.tiles.slice();
      wallsRef.current = map.walls || [];
      savedRef.current = { rows: rowsRef.current, walls: wallsRef.current };
      undoRef.current = [];
      redoRef.current = [];
      dirtyRef.current = false;
      setSaveState('saved');
      setResize((r) => ({ ...r, width: map.width, height: map.height }));
      bump();
      return;
    }
    if (dirtyRef.current || savingRef.current || strokeRef.current) return;
    let changed = false;
    if (rowsRef.current.join('\n') !== map.tiles.join('\n')) {
      rowsRef.current = map.tiles.slice();
      savedRef.current = { ...savedRef.current, rows: rowsRef.current };
      changed = true;
    }
    if (wallsSig(wallsRef.current) !== serverWallsSig) {
      wallsRef.current = map.walls || [];
      savedRef.current = { ...savedRef.current, walls: wallsRef.current };
      changed = true;
    }
    if (changed) bump();
  }, [serverKey]);

  const wallsForSave = (walls) => {
    const live = new Map((serverWallsRef.current || []).filter((w) => w.door).map((w) => [w.id, w.door.state]));
    return walls.map((w) => (w.door && !gmDoorEditsRef.current.has(w.id) && live.has(w.id) && live.get(w.id) !== w.door.state ? { ...w, door: { ...w.door, state: live.get(w.id) } } : w));
  };
  const flush = async () => {
    clearTimeout(timerRef.current);
    if (!dirtyRef.current || savingRef.current) return;
    dirtyRef.current = false;
    savingRef.current = true;
    setSaveState('saving');
    try {
      const rows = rowsRef.current, walls = wallsRef.current;
      if (rows !== savedRef.current.rows) await send('maps/setTiles', { mapId, tiles: rows }, { silent: true });
      savedRef.current = { ...savedRef.current, rows };
      if (walls !== savedRef.current.walls) {
        await send('maps/setWalls', { mapId, walls: wallsForSave(walls) }, { silent: true });
        gmDoorEditsRef.current.clear();
      }
      savedRef.current = { ...savedRef.current, walls };
      setSaveState(dirtyRef.current ? 'dirty' : 'saved');
    } catch (e) {
      dirtyRef.current = true;
      setSaveState('error');
      toast(`Sauvegarde de la carte impossible : ${e.message}`, 'error');
    } finally {
      savingRef.current = false;
      if (dirtyRef.current) timerRef.current = setTimeout(flush, 1500);
    }
  };
  const markDirty = () => {
    dirtyRef.current = true;
    setSaveState('dirty');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 650);
  };
  useEffect(() => {
    const beforeUnload = (e) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      clearTimeout(timerRef.current);
      if (dirtyRef.current) {
        if (rowsRef.current !== savedRef.current.rows) send('maps/setTiles', { mapId, tiles: rowsRef.current }).catch(quiet);
        if (wallsRef.current !== savedRef.current.walls) send('maps/setWalls', { mapId, walls: wallsForSave(wallsRef.current) }).catch(quiet);
      }
    };
  }, []);

  const T = (x, y) => (x < 0 || y < 0 || x >= map.width || y >= map.height ? null : rowsRef.current[y][x]);
  const applyCells = (cells, chOrFn) => {
    const rows = rowsRef.current.slice();
    const byRow = new Map();
    for (const c of cells) {
      if (c.x < 0 || c.y < 0 || c.x >= map.width || c.y >= map.height) continue;
      let arr = byRow.get(c.y);
      if (!arr) {
        arr = rows[c.y].split('');
        byRow.set(c.y, arr);
      }
      arr[c.x] = typeof chOrFn === 'function' ? chOrFn(c) : chOrFn;
    }
    let changed = false;
    for (const [y, arr] of byRow) {
      const s = arr.join('');
      if (s !== rows[y]) {
        rows[y] = s;
        changed = true;
      }
    }
    if (changed) {
      rowsRef.current = rows;
      bump();
    }
    return changed;
  };
  // Undo entries are snapshots { rows, walls } (arrays are never mutated in place, so snapshots are cheap).
  const snapshot = () => ({ rows: rowsRef.current, walls: wallsRef.current });
  /** Ids of walls whose door state differs between two walls arrays (or that became / stopped being doors). */
  const doorDiff = (a = [], b = []) => {
    const m = new Map(a.filter((w) => w.door).map((w) => [w.id, w.door.state]));
    const ids = [];
    for (const w of b) {
      if (w.door ? m.get(w.id) !== w.door.state : m.has(w.id)) ids.push(w.id);
      m.delete(w.id);
    }
    return ids;
  };
  const restore = (snap) => {
    rowsRef.current = snap.rows;
    wallsRef.current = snap.walls;
    for (const id of snap.doorIds || []) gmDoorEditsRef.current.add(id);
    bump();
    markDirty();
  };
  const beginStroke = (extra = {}) => {
    strokeRef.current = { before: snapshot(), ...extra };
  };
  const endStroke = () => {
    const s = strokeRef.current;
    strokeRef.current = null;
    if (s && (s.before.rows !== rowsRef.current || s.before.walls !== wallsRef.current)) {
      const doorIds = s.before.walls !== wallsRef.current ? doorDiff(s.before.walls, wallsRef.current) : [];
      for (const id of doorIds) gmDoorEditsRef.current.add(id);
      undoRef.current.push({ ...s.before, doorIds });
      if (undoRef.current.length > 120) undoRef.current.shift();
      redoRef.current = [];
      markDirty();
      forceTick((n) => n + 1);
    }
  };
  const undo = () => {
    if (!undoRef.current.length) return;
    const e = undoRef.current.pop();
    redoRef.current.push({ ...snapshot(), doorIds: e.doorIds || [] });
    restore(e);
  };
  const redo = () => {
    if (!redoRef.current.length) return;
    const e = redoRef.current.pop();
    undoRef.current.push({ ...snapshot(), doorIds: e.doorIds || [] });
    restore(e);
  };
  /** One undoable wall edit: fn(walls) → new walls array. */
  const editWalls = (fn) => {
    beginStroke();
    const next = fn(wallsRef.current);
    if (next !== wallsRef.current) {
      wallsRef.current = next;
      bump();
    }
    endStroke();
  };
  const patchWalls = (ids, fn) => {
    const set = new Set(ids);
    editWalls((walls) => walls.map((w) => (set.has(w.id) ? fn(w) : w)));
  };
  const deleteWalls = (ids) => {
    const set = new Set(ids);
    const n = wallsRef.current.filter((w) => set.has(w.id)).length;
    if (!n) return;
    editWalls((walls) => walls.filter((w) => !set.has(w.id)));
    setWallSel([]);
    toast(n > 1 ? `${n} murs supprimés (Ctrl+Z pour annuler)` : 'Mur supprimé (Ctrl+Z pour annuler)');
  };

  const floodFill = (start, ch) => {
    const from = T(start.x, start.y);
    if (from == null || from === ch) return;
    const w = map.width, h = map.height;
    const seen = new Uint8Array(w * h);
    const cells = [];
    const q = [start];
    seen[start.y * w + start.x] = 1;
    while (q.length) {
      const c = q.pop();
      cells.push(c);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx]) continue;
        if (rowsRef.current[ny][nx] !== from) continue;
        seen[ny * w + nx] = 1;
        q.push({ x: nx, y: ny });
      }
    }
    applyCells(cells, ch);
  };

  const shapeCells = (kind, a, b) => {
    if (kind === 'line') return { cells: lineCells(a, b) };
    const r = rectOf(a, b);
    const all = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) all.push({ x, y, edge: x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1 });
    if (kind === 'rect') return { cells: all, rect: r };
    if (kind === 'outline') return { cells: all.filter((c) => c.edge), rect: r };
    return { cells: all, rect: r, room: true };
  };
  const paintChar = tool === 'eraser' ? ' ' : tile;

  // ---------------- objects ----------------
  const objectAt = (fx, fy, types = ['token', 'light', 'door', 'note', 'wall', 'region'], sx = null, sy = null) => {
    const cx = Math.floor(fx), cy = Math.floor(fy);
    for (const t of types) {
      if (t === 'wall') {
        if (sx == null) continue;
        const w = rRef.current?.wallAtScreen(sx, sy, 8);
        if (w) return { type: 'wall', id: w.id };
      } else if (t === 'token') {
        const tok = rRef.current?.tokenAt(fx, fy);
        if (tok) return { type: 'token', id: tok.id };
      } else if (t === 'light') {
        const l = (map.lights || []).find((o) => o.x === cx && o.y === cy);
        if (l) return { type: 'light', id: l.id };
      } else if (t === 'door') {
        const d = (map.doors || []).find((o) => o.x === cx && o.y === cy);
        if (d) return { type: 'door', id: d.id };
      } else if (t === 'note') {
        const n = (map.notes || []).find((o) => o.x === cx && o.y === cy);
        if (n) return { type: 'note', id: n.id };
      } else if (t === 'region') {
        const r = [...(map.regions || [])].reverse().find((o) => cx >= o.x && cy >= o.y && cx < o.x + o.w && cy < o.y + o.h);
        if (r) return { type: 'region', id: r.id };
      }
    }
    return null;
  };
  const selected = sel ? (map[sel.type === 'door' ? 'doors' : sel.type + 's'] || []).find((o) => o.id === sel.id) : null;
  useEffect(() => {
    if (sel && !selected) setSel(null);
  }, [map, sel]);
  // drop selected wall ids that no longer exist (undo, server sync)
  const selWalls = wallSel.length ? wallsRef.current.filter((w) => wallSel.includes(w.id)) : [];
  useEffect(() => {
    if (wallSel.length && selWalls.length !== wallSel.length) setWallSel(selWalls.map((w) => w.id));
  }, [ver, map, wallSel]);
  /** Select objects (clears the wall selection) / walls (clears the object selection). */
  const pick = (hit, additive = false) => {
    if (hit?.type === 'wall') {
      setSel(null);
      setWallSel((cur) => (additive ? (cur.includes(hit.id) ? cur.filter((x) => x !== hit.id) : [...cur, hit.id]) : [hit.id]));
    } else {
      setWallSel([]);
      setSel(hit);
    }
  };

  // ---------------- segment walls ----------------
  /** Snap a world point: wall end points within 10 px, else half-cells; Alt (free) → 1/100 cell. */
  const snapPoint = (info, free) => {
    if (free) return { x: Math.round(info.fx * 100) / 100, y: Math.round(info.fy * 100) / 100 };
    const r = rRef.current;
    if (r) {
      let best = null, bestD = 10;
      for (const w of wallsRef.current) {
        for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
          const p = r.toScreen(x, y);
          const d = Math.hypot(p.x - info.sx, p.y - info.sy);
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
      if (best) return best;
    }
    return { x: Math.round(info.fx * 2) / 2, y: Math.round(info.fy * 2) / 2 };
  };
  /** New segment from the tool options. */
  const makeWall = (a, b) => {
    const base = { id: newWallId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y, move: true, sight: true, door: null };
    if (tool === 'wdoor') return wdoorOpts.kind === 'window' ? withType(base, 'window') : { ...base, door: { state: wdoorOpts.state, kind: wdoorOpts.kind } };
    return withType(base, wallOpts.type);
  };
  /** wdoor tool click on a wall: convert it to the chosen kind. */
  const convertWall = (id) => {
    const type = wdoorOpts.kind === 'window' ? 'window' : wdoorOpts.kind;
    patchWalls([id], (w) => {
      const next = withType(w, type);
      return next.door ? { ...next, door: { ...next.door, state: w.door ? w.door.state : wdoorOpts.state } } : next;
    });
    pick({ type: 'wall', id });
    toast(`Mur converti : ${WDOOR_KINDS.find((k) => k.value === wdoorOpts.kind)?.label.toLowerCase()}`);
  };

  const addDoorAt = (x, y) => {
    // local tile becomes a door cell too, so a pending tile save keeps it
    beginStroke();
    applyCells([{ x, y }], 'D');
    endStroke();
    send('maps/addDoor', { mapId, door: { x, y, ...doorOpts } }).then((id) => setSel({ type: 'door', id }), quiet);
  };
  const addToken = (x, y) => {
    const a = tokenOpts.actorId ? game.actors?.[tokenOpts.actorId] : null;
    const token = a ? { actorId: a.id, x, y, hidden: tokenOpts.hidden } : { name: tokenOpts.name || 'Pion', disposition: tokenOpts.disposition, hidden: tokenOpts.hidden, x, y };
    if (a && tokenOpts.disposition && a.type !== 'pc') token.disposition = tokenOpts.disposition;
    send('maps/addToken', { mapId, token }).then((id) => setSel({ type: 'token', id }), quiet);
  };

  // ---------------- pointer handlers ----------------
  const overlayFor = (extra = {}) => {
    const out = { ...extra };
    if (selected && sel?.type === 'light') out.selectedLightId = sel.id;
    if (wallSel.length) out.selectedWallIds = new Set(wallSel);
    return out;
  };
  const handlers = {
    panOnly: () => tool === 'pan',
    onDown(info) {
      const c = { x: info.cx, y: info.cy };
      const inside = c.x >= 0 && c.y >= 0 && c.x < map.width && c.y < map.height;
      if (WALL_TOOLS.has(tool)) {
        if (info.ctrl) {
          strokeRef.current = { wallBox: true, sx: info.sx, sy: info.sy, additive: info.shift };
          return true;
        }
        const a = info.shift && lastEndRef.current ? lastEndRef.current : snapPoint(info, info.alt);
        strokeRef.current = { seg: true, a, b: a, down: info };
        rRef.current?.setOverlay(overlayFor({ snap: a }));
        return true;
      }
      if (PAINT.has(tool)) {
        if (info.alt) {
          const ch = T(c.x, c.y);
          if (ch != null) {
            setTile(ch);
            if (tool === 'eraser') setTool('brush');
          }
          return true;
        }
        if (!inside && tool !== 'line' && tool !== 'rect' && tool !== 'outline' && tool !== 'room') return true;
        beginStroke({ start: c, last: c });
        if (tool === 'brush' || tool === 'eraser') applyCells(brushCells(c, size), paintChar);
        else if (tool === 'fill') floodFill(c, tile);
        else updateShapePreview(c);
        return true;
      }
      if (!inside) return false;
      if (tool === 'door') {
        const hit = objectAt(info.fx, info.fy, ['door']);
        if (hit) setSel(hit);
        else addDoorAt(c.x, c.y);
        return true;
      }
      if (tool === 'light' || tool === 'token' || tool === 'select') {
        const types = tool === 'light' ? ['light'] : tool === 'token' ? ['token'] : undefined;
        const hit = objectAt(info.fx, info.fy, types, info.sx, info.sy);
        if (hit) {
          pick(hit, info.shift);
          if (hit.type === 'token' || hit.type === 'light') strokeRef.current = { drag: hit, start: c, target: c };
          return true;
        }
        if (tool === 'light') {
          send('maps/addLight', { mapId, light: { x: c.x, y: c.y, ...lightOpts } }).then((id) => setSel({ type: 'light', id }), quiet);
          return true;
        }
        if (tool === 'token') {
          addToken(c.x, c.y);
          return true;
        }
        pick(null);
        return false;
      }
      if (tool === 'note') {
        const hit = objectAt(info.fx, info.fy, ['note']);
        if (hit) setSel(hit);
        else
          promptText('Note MJ (jamais visible des joueurs)').then((text) => {
            if (text && text.trim()) send('maps/addNote', { mapId, note: { x: c.x, y: c.y, text: text.trim() } }).then((id) => setSel({ type: 'note', id }), quiet);
          });
        return true;
      }
      if (tool === 'region') {
        strokeRef.current = { region: true, start: c, last: c };
        rRef.current?.setOverlay(overlayFor({ rect: { x: c.x, y: c.y, w: 1, h: 1 }, rectColor: regionOpts.color }));
        return true;
      }
      return false;
    },
    onMove(info) {
      const s = strokeRef.current;
      if (!s) return;
      if (s.wallBox) {
        rRef.current?.setOverlay(overlayFor({ box: { x: Math.min(s.sx, info.sx), y: Math.min(s.sy, info.sy), w: Math.abs(info.sx - s.sx), h: Math.abs(info.sy - s.sy) } }));
        return;
      }
      if (s.seg) {
        s.b = snapPoint(info, info.alt);
        const preview = makeWall(s.a, s.b);
        const color = preview.door ? (preview.door.kind === 'secret' ? '#e0468f' : '#e0a63f') : { wall: '#3fd6d0', window: '#5cc8ff', curtain: '#9d7ce0' }[wallKind(preview)] || '#3fd6d0';
        const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
        rRef.current?.setOverlay(overlayFor({ segment: { x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, color, dashed: wallKind(preview) !== 'wall' && !preview.door }, snap: s.b, pathLabel: `${Math.round(len * (map.metersPerCell || 1) * 10) / 10} m`, labelAt: { x: s.b.x, y: s.b.y - 0.6 } }));
        return;
      }
      const c = { x: Math.max(0, Math.min(map.width - 1, info.cx)), y: Math.max(0, Math.min(map.height - 1, info.cy)) };
      if (s.drag) {
        if (s.target && s.target.x === c.x && s.target.y === c.y) return;
        s.target = c;
        if (s.drag.type === 'token') {
          const tok = map.tokens.find((t) => t.id === s.drag.id);
          if (tok) rRef.current?.setOverlay(overlayFor({ ghosts: [{ token: tok, x: c.x, y: c.y }] }));
        } else rRef.current?.setOverlay(overlayFor({ hoverCell: c, hoverColor: '#ffcc88' }));
        return;
      }
      if (s.region) {
        s.last = c;
        const r = rectOf(s.start, c);
        rRef.current?.setOverlay(overlayFor({ rect: r, rectColor: regionOpts.color }));
        return;
      }
      if (tool === 'brush' || tool === 'eraser') {
        const raw = { x: info.cx, y: info.cy };
        const cells = [];
        for (const p of lineCells(s.last, raw)) cells.push(...brushCells(p, size));
        s.last = raw;
        applyCells(cells, paintChar);
        rRef.current?.setOverlay(overlayFor({ cells: brushCells(raw, size), cellsColor: 'rgba(63,214,208,0.25)' }));
      } else if (tool !== 'fill') updateShapePreview(c);
    },
    onUp(info, moved) {
      const s = strokeRef.current;
      if (!s) return;
      if (s.wallBox) {
        strokeRef.current = null;
        const r = rRef.current;
        if (!r) return;
        const a = r.toWorld(Math.min(s.sx, info.sx), Math.min(s.sy, info.sy));
        const b = r.toWorld(Math.max(s.sx, info.sx), Math.max(s.sy, info.sy));
        const inBox = (x, y) => x >= a.x && x <= b.x && y >= a.y && y <= b.y;
        const hits = wallsRef.current.filter((w) => inBox(w.x1, w.y1) && inBox(w.x2, w.y2)).map((w) => w.id);
        const next = s.additive ? [...new Set([...wallSel, ...hits])] : hits;
        setSel(null);
        setWallSel(next);
        r.setOverlay(overlayFor({ selectedWallIds: new Set(next) }));
        if (hits.length) toast(`${hits.length} mur(s) sélectionné(s)`);
        return;
      }
      if (s.seg) {
        strokeRef.current = null;
        const b = moved ? snapPoint(info, info.alt) : s.a;
        const len = Math.hypot(b.x - s.a.x, b.y - s.a.y);
        if (!moved || len < 0.05) {
          // click: select / convert the wall under the pointer
          const hit = rRef.current?.wallAtScreen(info.sx, info.sy, 8);
          if (hit && tool === 'wdoor') convertWall(hit.id);
          else if (hit) pick({ type: 'wall', id: hit.id }, info.shift);
          else if (!info.shift) setWallSel([]);
          rRef.current?.setOverlay(overlayFor({ selectedWallIds: hit ? new Set(info.shift ? wallSel.concat(hit.id) : [hit.id]) : undefined }));
          return;
        }
        const w = makeWall(s.a, b);
        editWalls((walls) => [...walls, w]);
        lastEndRef.current = b;
        setSel(null);
        setWallSel([w.id]);
        rRef.current?.setOverlay(overlayFor({ selectedWallIds: new Set([w.id]) }));
        return;
      }
      const c = { x: Math.max(0, Math.min(map.width - 1, info.cx)), y: Math.max(0, Math.min(map.height - 1, info.cy)) };
      if (s.drag) {
        strokeRef.current = null;
        rRef.current?.setOverlay(overlayFor());
        if (!moved || (s.start.x === c.x && s.start.y === c.y)) return;
        if (s.drag.type === 'token') send('maps/moveToken', { mapId, tokenId: s.drag.id, x: c.x, y: c.y, ignoreWalls: true }).catch(quiet);
        else send('maps/updateLight', { mapId, lightId: s.drag.id, patch: { x: c.x, y: c.y } }).catch(quiet);
        return;
      }
      if (s.region) {
        strokeRef.current = null;
        rRef.current?.setOverlay(overlayFor());
        const r = rectOf(s.start, c);
        if (!moved || (r.w === 1 && r.h === 1)) {
          const hit = objectAt(info.fx, info.fy, ['region']);
          if (hit) setSel(hit);
          return;
        }
        promptText('Nom de la zone', 'Zone').then((name) => {
          if (name && name.trim()) send('maps/addRegion', { mapId, region: { ...r, name: name.trim(), ...regionOpts } }).then((id) => setSel({ type: 'region', id }), quiet);
        });
        return;
      }
      if (['line', 'rect', 'outline', 'room'].includes(tool) && s.start) {
        const { cells, room } = shapeCells(tool, s.start, c);
        if (room) {
          const floor = tile === '#' || tile === ' ' ? '.' : tile;
          applyCells(cells, (cell) => (cell.edge ? '#' : floor));
        } else applyCells(cells, paintChar);
      }
      rRef.current?.setOverlay(overlayFor());
      endStroke();
    },
    onCancel() {
      const s = strokeRef.current;
      if (s?.before) {
        rowsRef.current = s.before.rows;
        wallsRef.current = s.before.walls;
        bump();
      }
      strokeRef.current = null;
      rRef.current?.setOverlay(overlayFor());
    },
    onContext(info) {
      if (PAINT.has(tool)) {
        const ch = T(info.cx, info.cy);
        if (ch != null) {
          setTile(ch);
          if (tool === 'eraser') setTool('brush');
          toast(`Pipette : ${TILE_INFO[ch]?.fr || ch}`);
        }
        return;
      }
      const hit = objectAt(info.fx, info.fy, undefined, info.sx, info.sy);
      pick(hit);
    },
    onHover(info) {
      if (!info || strokeRef.current) return;
      const r = rRef.current;
      if (!r) return;
      if (WALL_TOOLS.has(tool)) {
        const hit = r.wallAtScreen(info.sx, info.sy, 8);
        r.canvas.style.cursor = hit ? 'pointer' : 'crosshair';
        r.setOverlay(overlayFor({ snap: info.shift && lastEndRef.current ? lastEndRef.current : snapPoint(info, info.alt), hoverWallId: hit?.id }));
      } else if (PAINT.has(tool) && tool !== 'fill') r.setOverlay(overlayFor({ cells: brushCells({ x: info.cx, y: info.cy }, tool === 'brush' || tool === 'eraser' ? size : 1), cellsColor: tool === 'eraser' ? 'rgba(224,92,92,0.25)' : 'rgba(63,214,208,0.22)' }));
      else r.setOverlay(overlayFor({ hoverCell: { x: info.cx, y: info.cy } }));
    },
  };
  function updateShapePreview(c) {
    const s = strokeRef.current;
    if (!s?.start) return;
    s.last = c;
    const { cells, rect } = shapeCells(tool, s.start, c);
    rRef.current?.setOverlay(overlayFor({ cells, cellsColor: tool === 'room' ? 'rgba(224,166,63,0.25)' : 'rgba(63,214,208,0.25)', rect }));
  }

  // keep the selected-light ring in sync
  useEffect(() => {
    rRef.current?.setOverlay(overlayFor());
  }, [sel?.id, tool, wallSel]);

  // ---------------- keyboard ----------------
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target?.isContentEditable) return;
      if (document.querySelector('.modal-backdrop')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === 's') {
        e.preventDefault();
        flush();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (strokeRef.current) handlers.onCancel();
        else {
          setSel(null);
          setWallSel([]);
          lastEndRef.current = null;
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && wallSel.length) {
        e.preventDefault();
        deleteWalls(wallSel);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === '[') return setSize((s) => Math.max(1, s - 1));
      if (e.key === ']') return setSize((s) => Math.min(3, s + 1));
      const t = TOOLS.find((x) => x.key === k);
      if (t) setTool(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const deleteSelected = async () => {
    if (!sel || !selected) return;
    const labels = { door: 'cette porte', light: 'cette lumière', region: `la zone « ${selected.name} »`, note: 'cette note', token: `le pion « ${selected.name} »` };
    if (!(await confirmAction(`Supprimer ${labels[sel.type]} ?`))) return;
    const action = { door: 'maps/removeDoor', light: 'maps/removeLight', region: 'maps/removeRegion', note: 'maps/removeNote', token: 'maps/removeToken' }[sel.type];
    const idKey = { door: 'doorId', light: 'lightId', region: 'regionId', note: 'noteId', token: 'tokenId' }[sel.type];
    send(action, { mapId, [idKey]: sel.id }).then(() => setSel(null), quiet);
  };

  // ---------------- scene ----------------
  const editMap = useMemo(() => ({ ...map, tiles: rowsRef.current, walls: wallsRef.current }), [map, ver]);
  const scene = useMemo(
    () => ({
      map: editMap,
      actors: game.actors || {},
      role: 'gm',
      me: game.me,
      selected: new Set(sel?.type === 'token' ? [sel.id] : []),
      turnTokenId: null,
      gmLayer: true,
      editor: true,
      fog: null,
      unseen: null,
      tokenMask: null,
      darkFactor: 0.45,
      barsFor: () => false,
      showWalls: true,
      showGrid: true,
    }),
    [editMap, game.actors, sel?.id, sel?.type]
  );

  // ---------------- panels ----------------
  const upd = (patch) => send('maps/update', { mapId, patch }).catch(quiet);
  const bg = map.background || null;
  /** Background defaults: an empty / all-floor map becomes an image map, a painted one keeps its tiles on top. */
  const bgDefaults = () => {
    const tileArt = rowsRef.current.some((r) => /[^.,\s]/.test(r));
    return tileArt ? { mode: 'underlay', opacity: 0.6, x: 0, y: 0, w: map.width, h: map.height } : { mode: 'image', opacity: 1, x: 0, y: 0, w: map.width, h: map.height };
  };
  const setBg = (patch) => upd({ background: patch === null ? null : { ...(bg || bgDefaults()), ...patch } });
  const onBg = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const res = await upload(f);
      await send('maps/update', { mapId, patch: { background: { ...(bg || bgDefaults()), url: res.url } } });
      toast('Image de fond ajoutée', 'success');
    } catch (err) {
      toast(`Envoi impossible : ${err.message}`, 'error');
    }
  };
  const fitBg = () => setBg({ x: 0, y: 0, w: map.width, h: map.height });
  const bgAspect = () => {
    const img = bg?.url ? getImage(bg.url) : null;
    if (!img || !img.naturalWidth) return toast('Image pas encore chargée — réessaie dans un instant', 'warn');
    setBg({ h: Math.round(((bg.w || map.width) * img.naturalHeight * 100) / img.naturalWidth) / 100 });
  };
  const fillInterior = async () => {
    if (!(await confirmAction('Remplacer toutes les tuiles par du sol intérieur « . » ? Les murs/portes en tuiles disparaissent (les murs en segments restent). Annulable avec Ctrl+Z.'))) return;
    beginStroke();
    const cells = [];
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) cells.push({ x, y });
    applyCells(cells, '.');
    endStroke();
    toast('Toute la carte est maintenant du sol', 'success');
  };
  const wallStats = useMemo(() => {
    const s = { wall: 0, window: 0, curtain: 0, ethereal: 0, door: 0, secret: 0 };
    for (const w of wallsRef.current) s[wallType(w)]++;
    return s;
  }, [ver, map]);
  const doResize = async () => {
    const { width, height, anchor } = resize;
    if (width === map.width && height === map.height) return;
    if ((width < map.width || height < map.height) && !(await confirmAction('Réduire la carte supprime ce qui dépasse. Continuer ?'))) return;
    await flush();
    send('maps/resize', { mapId, width, height, anchor }).then(() => toast('Carte redimensionnée', 'success'), quiet);
  };
  const actorOptions = useMemo(() => {
    const list = Object.values(game.actors || {}).filter((a) => !a.retired);
    return [
      { value: '', label: 'Pion libre (sans fiche)' },
      ...list.filter((a) => a.type === 'pc').map((a) => ({ value: a.id, label: `PJ — ${a.name}` })),
      ...list.filter((a) => a.type !== 'pc').sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: `PNJ — ${a.name}` })),
    ];
  }, [game.actors]);
  const centerOn = (o) => rRef.current?.centerOn(o.x + (o.w ? o.w / 2 - 0.5 : 0), o.y + (o.h ? o.h / 2 - 0.5 : 0), 28);
  const shown = game.scene?.activeMapId === mapId;
  const saveLabel = { saved: '✓ Enregistré', dirty: '● Modifié', saving: '… Enregistrement', error: '⚠ Erreur — nouvel essai' }[saveState];

  const toolOptions = () => {
    if (PAINT.has(tool) && tool !== 'eraser') {
      return html`<div class="mapedit-opts">
        <div class="row"><img src=${tileSwatch(tile, map.theme, 30)} width="24" height="24" alt="" /><strong class="small">${TILE_INFO[tile]?.fr || tile}</strong></div>
        ${(tool === 'brush') && html`<div class="row spread"><span class="small muted">Taille</span><${NumberInput} small value=${size} min=${1} max=${3} onChange=${setSize} /></div>`}
        ${tool === 'room' && html`<span class="small muted">Murs « # » autour, ${tile === '#' || tile === ' ' ? 'sol intérieur' : (TILE_INFO[tile]?.fr || tile).toLowerCase()} dedans.</span>`}
      </div>`;
    }
    if (tool === 'eraser') return html`<div class="mapedit-opts"><div class="row spread"><span class="small muted">Taille</span><${NumberInput} small value=${size} min=${1} max=${3} onChange=${setSize} /></div></div>`;
    if (tool === 'wall')
      return html`<div class="mapedit-opts">
        <${Field} label="Type de mur"><${Select} value=${wallOpts.type} options=${WALL_TYPES} onChange=${(v) => setWallOpts({ ...wallOpts, type: v })} /></${Field}>
        <span class="small muted">${wallStats.wall + wallStats.window + wallStats.curtain + wallStats.ethereal} mur(s) · ${wallStats.door + wallStats.secret} porte(s)</span>
      </div>`;
    if (tool === 'wdoor')
      return html`<div class="mapedit-opts">
        <${Field} label="Type"><${Select} value=${wdoorOpts.kind} options=${WDOOR_KINDS} onChange=${(v) => setWdoorOpts({ ...wdoorOpts, kind: v })} /></${Field}>
        ${wdoorOpts.kind !== 'window' && html`<${Field} label="État"><${Select} value=${wdoorOpts.state} options=${DOOR_STATES} onChange=${(v) => setWdoorOpts({ ...wdoorOpts, state: v })} /></${Field}>`}
      </div>`;
    if (tool === 'door')
      return html`<div class="mapedit-opts">
        <${Field} label="Type"><${Select} value=${doorOpts.kind} options=${DOOR_KINDS} onChange=${(v) => setDoorOpts({ ...doorOpts, kind: v })} /></${Field}>
        <${Field} label="État"><${Select} value=${doorOpts.state} options=${DOOR_STATES} onChange=${(v) => setDoorOpts({ ...doorOpts, state: v })} /></${Field}>
      </div>`;
    if (tool === 'light')
      return html`<div class="mapedit-opts">
        <div class="row spread"><span class="small muted">Rayon (cases)</span><${NumberInput} small value=${lightOpts.radius} min=${1} max=${40} onChange=${(v) => setLightOpts({ ...lightOpts, radius: v })} /></div>
        <div class="row spread"><span class="small muted">Couleur</span><input type="color" class="mapedit-color" value=${lightOpts.color} onInput=${(e) => setLightOpts({ ...lightOpts, color: e.target.value })} /></div>
        <div class="row wrap gap-s">${['#ffcc88', '#fff1cc', '#3fd6d0', '#e0468f', '#9d7ce0', '#e05c5c', '#4fd17a'].map(
          (c) => html`<button class="mapedit-swatch" style=${{ background: c, width: '18px', height: '18px', cursor: 'pointer' }} title=${c} onClick=${() => setLightOpts({ ...lightOpts, color: c })}></button>`
        )}</div>
      </div>`;
    if (tool === 'region')
      return html`<div class="mapedit-opts">
        <div class="row spread"><span class="small muted">Couleur</span><input type="color" class="mapedit-color" value=${regionOpts.color} onInput=${(e) => setRegionOpts({ ...regionOpts, color: e.target.value })} /></div>
        <${Toggle} label="Réservée au MJ" value=${regionOpts.gmOnly} onChange=${(v) => setRegionOpts({ ...regionOpts, gmOnly: v })} />
      </div>`;
    if (tool === 'token')
      return html`<div class="mapedit-opts">
        <${Field} label="Fiche liée"><${Select} value=${tokenOpts.actorId} options=${actorOptions} onChange=${(v) => setTokenOpts({ ...tokenOpts, actorId: v })} /></${Field}>
        ${!tokenOpts.actorId && html`<${Field} label="Nom"><input class="input" value=${tokenOpts.name} onInput=${(e) => setTokenOpts({ ...tokenOpts, name: e.target.value })} /></${Field}>`}
        <${Field} label="Disposition"><${Select} value=${tokenOpts.disposition} options=${DISPO_OPTIONS} onChange=${(v) => setTokenOpts({ ...tokenOpts, disposition: v })} /></${Field}>
        <${Toggle} label="Caché aux joueurs" value=${tokenOpts.hidden} onChange=${(v) => setTokenOpts({ ...tokenOpts, hidden: v })} />
        <${Button} small onClick=${() => send('maps/placePCs', { mapId }).then((ids) => toast(ids?.length ? `${ids.length} PJ placé(s)` : 'Tous les PJ sont déjà sur la carte'), quiet)}>Placer tous les PJ</${Button}>
      </div>`;
    return null;
  };

  const wallInspector = () => {
    if (!selWalls.length) return null;
    const ids = selWalls.map((w) => w.id);
    const head = (title) => html`<div class="row spread"><h5>${title}</h5><${IconButton} icon="✕" title="Désélectionner" onClick=${() => setWallSel([])} /></div>`;
    const types = new Set(selWalls.map(wallType));
    const typeValue = types.size === 1 ? [...types][0] : '';
    const typeSelect = html`<${Field} label="Type"><${Select} value=${typeValue}
        options=${typeValue ? WALL_TYPES : [{ value: '', label: '(plusieurs types)' }, ...WALL_TYPES]}
        onChange=${(v) => v && patchWalls(ids, (w) => withType(w, v))} /></${Field}>`;
    const del = html`<${Button} small variant="danger" onClick=${() => deleteWalls(ids)}>Supprimer${ids.length > 1 ? ` (${ids.length})` : ''}</${Button}>`;
    if (selWalls.length > 1) {
      return html`<div class="mapedit-inspector">${head(`${selWalls.length} murs`)}${typeSelect}
        <span class="small muted">Suppr : effacer · Ctrl+Z : annuler</span>${del}</div>`;
    }
    const w = selWalls[0];
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const setCoord = (k) => (v) => patchWalls(ids, (x) => ({ ...x, [k]: v }));
    return html`<div class="mapedit-inspector">${head(w.door ? (w.door.kind === 'secret' ? 'Porte secrète (mur)' : 'Porte (mur)') : 'Mur')}
      ${typeSelect}
      ${w.door && html`
        <${Field} label="État"><${Select} value=${w.door.state} options=${DOOR_STATES} onChange=${(v) => patchWalls(ids, (x) => ({ ...x, door: { ...x.door, state: v } }))} /></${Field}>
        <${Field} label="Nom (optionnel)"><${TextInput} value=${w.door.name || ''} placeholder="ex. Porte du labo" onChange=${(v) => patchWalls(ids, (x) => {
          const door = { ...x.door };
          if (v.trim()) door.name = v.trim();
          else delete door.name;
          return { ...x, door };
        })} /></${Field}>`}
      <div class="grid-2">
        ${['x1', 'y1', 'x2', 'y2'].map((k) => html`<${NumField} label=${k.toUpperCase()}><${NumberInput} small value=${w[k]} step=${0.5} min=${-10} max=${(k[0] === 'x' ? map.width : map.height) + 10} onChange=${setCoord(k)} /></${NumField}>`)}
      </div>
      <span class="small muted">Longueur ${Math.round(len * (map.metersPerCell || 1) * 10) / 10} m${w.foundry ? ' · importé de Foundry' : ''}</span>
      ${del}</div>`;
  };

  const inspector = () => {
    if (wallSel.length) return wallInspector();
    if (!sel || !selected) return null;
    const o = selected;
    const del = html`<${Button} small variant="danger" onClick=${deleteSelected}>Supprimer</${Button}>`;
    const head = (title) => html`<div class="row spread"><h5>${title}</h5><${IconButton} icon="✕" title="Désélectionner" onClick=${() => setSel(null)} /></div>`;
    if (sel.type === 'door')
      return html`<div class="mapedit-inspector">${head(`Porte (${o.x}, ${o.y})`)}
        <${Field} label="Nom (optionnel)"><${TextInput} value=${o.name || ''} placeholder="ex. Porte du labo" onChange=${(v) => send('maps/setDoor', { mapId, doorId: o.id, name: v }).catch(quiet)} /></${Field}>
        <${Field} label="Type"><${Select} value=${o.kind} options=${DOOR_KINDS} onChange=${(v) => send('maps/setDoor', { mapId, doorId: o.id, kind: v }).catch(quiet)} /></${Field}>
        <${Field} label="État"><${Select} value=${o.state} options=${DOOR_STATES} onChange=${(v) => send('maps/setDoor', { mapId, doorId: o.id, state: v }).catch(quiet)} /></${Field}>
        ${del}</div>`;
    if (sel.type === 'light')
      return html`<div class="mapedit-inspector">${head(`Lumière (${o.x}, ${o.y})`)}
        <${Toggle} label=${o.on !== false ? 'Allumée' : 'Éteinte'} value=${o.on !== false} onChange=${() => send('maps/toggleLight', { mapId, lightId: o.id }).catch(quiet)} />
        <div class="row spread"><span class="small muted">Rayon (cases)</span><${NumberInput} small value=${o.radius} min=${1} max=${40} onChange=${(v) => send('maps/updateLight', { mapId, lightId: o.id, patch: { radius: v } }).catch(quiet)} /></div>
        <div class="row spread"><span class="small muted">Couleur</span><input type="color" class="mapedit-color" value=${o.color} onChange=${(e) => send('maps/updateLight', { mapId, lightId: o.id, patch: { color: e.target.value } }).catch(quiet)} /></div>
        ${del}</div>`;
    if (sel.type === 'region')
      return html`<div class="mapedit-inspector">${head('Zone')}
        <${Field} label="Nom"><${TextInput} value=${o.name} onChange=${(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { name: v } }).catch(quiet)} /></${Field}>
        <div class="row spread"><span class="small muted">Couleur</span><input type="color" class="mapedit-color" value=${o.color || '#e0468f'} onChange=${(e) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { color: e.target.value } }).catch(quiet)} /></div>
        <${Toggle} label="Réservée au MJ" value=${o.gmOnly} onChange=${(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { gmOnly: v } }).catch(quiet)} />
        <div class="grid-2">
          ${['x', 'y', 'w', 'h'].map((k) => html`<${NumField} label=${{ x: 'X', y: 'Y', w: 'Largeur', h: 'Hauteur' }[k]}><${NumberInput} small value=${o[k]} min=${k === 'w' || k === 'h' ? 1 : 0} max=${k === 'x' || k === 'w' ? map.width : map.height} onChange=${(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { [k]: v } }).catch(quiet)} /></${NumField}>`)}
        </div>
        ${del}</div>`;
    if (sel.type === 'note')
      return html`<div class="mapedit-inspector">${head(`Note MJ (${o.x}, ${o.y})`)}
        <${TextInput} multiline rows=${5} value=${o.text} onChange=${(v) => send('maps/updateNote', { mapId, noteId: o.id, patch: { text: v } }).catch(quiet)} />
        ${del}</div>`;
    if (sel.type === 'token') {
      const actor = o.actorId ? game.actors?.[o.actorId] : null;
      const tp = (patch) => send('maps/updateToken', { mapId, tokenId: o.id, patch }).catch(quiet);
      return html`<div class="mapedit-inspector">${head('Pion')}
        <${Field} label="Nom"><${TextInput} value=${o.name} onChange=${(v) => tp({ name: v })} /></${Field}>
        ${actor && html`<div class="row spread"><span class="small muted">Fiche : ${actor.name}</span><${Button} small variant="ghost" onClick=${() => openSheet(actor.id)}>Ouvrir</${Button}></div>`}
        <${Field} label="Disposition"><${Select} value=${o.disposition} options=${DISPO_OPTIONS} onChange=${(v) => tp({ disposition: v })} /></${Field}>
        <${Toggle} label="Caché aux joueurs" value=${o.hidden} onChange=${(v) => tp({ hidden: v })} />
        <div class="row spread"><span class="small muted">Couleur</span><input type="color" class="mapedit-color" value=${o.color || actor?.color || '#2a3340'} onChange=${(e) => tp({ color: e.target.value })} /></div>
        <div class="row spread"><span class="small muted">Taille (cases)</span><${NumberInput} small value=${o.size || 1} min=${1} max=${4} onChange=${(v) => tp({ size: v })} /></div>
        <div class="row spread"><span class="small muted">Lampe (rayon)</span><${NumberInput} small value=${o.light?.radius || 0} min=${0} max=${30} onChange=${(v) => tp({ light: v ? { radius: v, color: o.light?.color || '#fff1cc' } : null })} /></div>
        <div class="row spread"><span class="small muted">Vision dans le noir</span><${NumberInput} small value=${o.vision?.darkRange ?? 0} min=${0} max=${40} onChange=${(v) => tp({ vision: { ...(o.vision || {}), darkRange: v } })} /></div>
        <div class="row wrap">
          <${Toggle} label="Vision nocturne" value=${!!o.vision?.lowLight} onChange=${(v) => tp({ vision: { ...(o.vision || {}), lowLight: v } })} />
          <${Toggle} label="Thermo" value=${!!o.vision?.thermo} onChange=${(v) => tp({ vision: { ...(o.vision || {}), thermo: v } })} />
        </div>
        ${del}</div>`;
    }
    return null;
  };

  const objectList = (label, list, type, render) =>
    list.length
      ? html`<div class="mapedit-section"><h5>${label} (${list.length})</h5><div class="mapedit-list">
          ${list.map((o) => html`<button class=${sel?.id === o.id ? 'on' : ''} onClick=${() => { setSel({ type, id: o.id }); centerOn(o); }}>${render(o)}</button>`)}
        </div></div>`
      : null;

  return html`<div class=${'mapedit' + (panel.tools ? ' tools-open' : '') + (panel.props ? ' props-open' : '')}>
    <header class="mapedit-head">
      <${Button} small variant="ghost" onClick=${async () => { await flush(); onBack(); }}>← Cartes</${Button}>
      <h2 title=${map.name}>${map.name}</h2>
      <span class=${'mapedit-save ' + saveState} title="Les tuiles et les murs sont enregistrés automatiquement (Ctrl+S pour forcer)">${saveLabel}</span>
      <${IconButton} icon="↶" title="Annuler (Ctrl+Z)" disabled=${!undoRef.current.length} onClick=${undo} />
      <${IconButton} icon="↷" title="Rétablir (Ctrl+Y)" disabled=${!redoRef.current.length} onClick=${redo} />
      <span class="grow"></span>
      ${shown ? html`<${Badge} color="green">● Affichée aux joueurs</${Badge}>` : html`<${Button} small variant="accent" onClick=${() => send('maps/setActive', { mapId }).then(() => toast('Carte affichée aux joueurs', 'success'), quiet)}>Montrer aux joueurs</${Button}>`}
      <${Button} small onClick=${async () => { await flush(); setUI({ viewMapId: mapId, mainTab: 'map' }); }}>Voir en jeu</${Button}>
      <${IconButton} icon="⌖" title="Recentrer" onClick=${() => rRef.current?.fit()} />
      <${Button} small class="mapedit-mobile-tabs" onClick=${() => setPanel({ tools: !panel.tools, props: false })}>Outils</${Button}>
      <${Button} small class="mapedit-mobile-tabs" onClick=${() => setPanel({ props: !panel.props, tools: false })}>Propriétés</${Button}>
    </header>

    <aside class="mapedit-tools">
      <div class="mapedit-section">
        <h5>Outils</h5>
        <div class="mapedit-toolgrid">
          ${TOOLS.map((t) => html`<button class=${'mapedit-tool' + (tool === t.id ? ' active' : '')} title=${`${t.label} (${t.key.toUpperCase()})`} onClick=${() => setTool(t.id)}><span>${t.icon}</span><span>${t.label}</span></button>`)}
        </div>
        <div class="mapedit-help">${TOOL_HELP[tool]}</div>
      </div>
      ${toolOptions()}
      <div class="mapedit-section">
        <h5>Tuiles</h5>
        <div class="mapedit-palette">
          ${PALETTE.map((ch) => html`<button class=${'mapedit-tile' + (tile === ch && PAINT.has(tool) && tool !== 'eraser' ? ' active' : '')} title=${`${TILE_INFO[ch].fr}${TILE_INFO[ch].blockMove ? ' · bloque le passage' : ''}${TILE_INFO[ch].blockSight ? ' · bloque la vue' : ''}`}
              onClick=${() => { setTile(ch); if (!PAINT.has(tool) || tool === 'eraser') setTool('brush'); }}>
            <img src=${tileSwatch(ch, map.theme, 30)} alt="" />
            <span>${TILE_INFO[ch].fr}</span>
          </button>`)}
        </div>
      </div>
    </aside>

    <div class="mapedit-canvas">
      <${MapCanvas} rendererRef=${rRef} scene=${scene} handlers=${handlers} />
    </div>

    <aside class="mapedit-props">
      ${inspector()}
      <div class="mapedit-section">
        <h5>Carte</h5>
        <${Field} label="Nom"><${TextInput} value=${map.name} onChange=${(v) => upd({ name: v })} /></${Field}>
        <${Field} label="Dossier"><${TextInput} value=${map.folder || ''} placeholder="ex. Acte 2" onChange=${(v) => upd({ folder: v })} /></${Field}>
        <div class="grid-2">
          <${Field} label="Ambiance"><${Select} value=${map.theme || 'street'} options=${THEME_OPTIONS} onChange=${(v) => upd({ theme: v })} /></${Field}>
          <${Field} label="Éclairage"><${Select} value=${map.lighting || 'bright'} options=${LIGHTING_OPTIONS} onChange=${(v) => upd({ lighting: v })} /></${Field}>
        </div>
        <${Toggle} label="Brouillard de guerre" value=${map.fog !== false} onChange=${(v) => upd({ fog: v })} />
        <${Toggle} label="Vision partagée du groupe" value=${map.sharedVision !== false} onChange=${(v) => upd({ sharedVision: v })} />
        <div class="row spread"><span class="small muted">Mètres par case</span><${NumberInput} small value=${map.metersPerCell || 1} min=${0.5} max=${20} step=${0.5} onChange=${(v) => upd({ metersPerCell: v })} /></div>
        <${Field} label="Description (MJ)"><${TextInput} multiline rows=${3} value=${map.description || ''} placeholder="Notes de scène, PNJ présents, pièges…" onChange=${(v) => upd({ description: v })} /></${Field}>
      </div>
      <div class="mapedit-section">
        <h5>Image de fond</h5>
        <${Field} label="Adresse de l'image"><${TextInput} value=${bg?.url || ''} placeholder="/assets/… ou https://…" onChange=${(v) => (v.trim() ? setBg({ url: v.trim() }) : upd({ background: null }))} /></${Field}>
        <div class="row wrap">
          <label class="btn btn-sm">${bg?.url ? 'Remplacer…' : 'Importer une image…'}<input type="file" accept="image/*" hidden onChange=${onBg} /></label>
          ${bg?.url && html`<${Button} small variant="danger" onClick=${() => upd({ background: null })}>Retirer</${Button}>`}
        </div>
        ${bg?.url &&
        html`<div class="col">
          <${Field} label="Mode"><${Select} value=${bg.mode || 'underlay'} options=${BG_MODES} onChange=${(v) => setBg({ mode: v, ...(v === 'image' && (bg.opacity ?? 0.6) < 1 ? { opacity: 1 } : {}) })} /></${Field}>
          <span class="small muted">${bg.mode === 'image'
            ? 'L’image est le sol : les tuiles ne sont plus dessinées (elles servent encore aux déplacements et à la vision). Trace les murs en segments.'
            : 'Les tuiles sont dessinées et l’image se superpose selon l’opacité.'}</span>
          <span class="small muted">Opacité ${Math.round((bg.opacity ?? 0.6) * 100)} %</span>
          <input type="range" class="mapedit-range" min="0" max="1" step="0.05" value=${bg.opacity ?? 0.6} onChange=${(e) => setBg({ opacity: Number(e.target.value) })} />
          <div class="grid-2">
            ${[['x', 'X (cases)'], ['y', 'Y (cases)'], ['w', 'Largeur'], ['h', 'Hauteur']].map(
              ([k, label]) => html`<${NumField} label=${label}><${NumberInput} small value=${bg[k] ?? (k === 'w' ? map.width : k === 'h' ? map.height : 0)} step=${0.5} min=${k === 'w' || k === 'h' ? 0.5 : -640} max=${640} onChange=${(v) => setBg({ [k]: v })} /></${NumField}>`
            )}
          </div>
          <div class="row wrap">
            <${Button} small onClick=${fitBg} title="Étirer l'image sur toute la carte">Ajuster à la carte</${Button}>
            <${Button} small variant="ghost" onClick=${bgAspect} title="Recalculer la hauteur pour garder les proportions de l'image">Proportions de l'image</${Button}>
          </div>
          ${bg.mode === 'image' && html`<${Button} small variant="ghost" onClick=${fillInterior} title="Toutes les cases deviennent du sol « . » (les cartes illustrées n'ont que des murs en segments)">Remplir l'intérieur</${Button}>`}
        </div>`}
      </div>
      <div class="mapedit-section">
        <h5>Murs en segments (${wallsRef.current.length})</h5>
        <span class="small muted">${wallStats.wall} mur(s) · ${wallStats.window} fenêtre(s) · ${wallStats.curtain} rideau(x) · ${wallStats.door} porte(s) · ${wallStats.secret} secrète(s)</span>
        <div class="row wrap">
          <${Button} small onClick=${() => setTool('wall')}>Tracer des murs</${Button}>
          ${wallsRef.current.length > 0 && html`<${Button} small variant="ghost" onClick=${() => setWallSel(wallsRef.current.filter((w) => w.door).map((w) => w.id))}>Sélectionner les portes</${Button}>`}
          ${wallsRef.current.length > 0 && html`<${Button} small variant="ghost" onClick=${async () => {
            if (await confirmAction(`Supprimer les ${wallsRef.current.length} murs en segments ? (Ctrl+Z pour annuler)`)) deleteWalls(wallsRef.current.map((w) => w.id));
          }}>Tout supprimer</${Button}>`}
        </div>
      </div>
      <div class="mapedit-section">
        <h5>Taille (${map.width} × ${map.height})</h5>
        <div class="grid-2">
          <${NumField} label="Largeur"><${NumberInput} small value=${resize.width} min=${4} max=${160} onChange=${(v) => setResize({ ...resize, width: v })} /></${NumField}>
          <${NumField} label="Hauteur"><${NumberInput} small value=${resize.height} min=${4} max=${160} onChange=${(v) => setResize({ ...resize, height: v })} /></${NumField}>
        </div>
        <${Field} label="Ancrage du contenu"><${Select} value=${resize.anchor} options=${ANCHORS} onChange=${(v) => setResize({ ...resize, anchor: v })} /></${Field}>
        <${Button} small disabled=${resize.width === map.width && resize.height === map.height} onClick=${doResize}>Redimensionner</${Button}>
      </div>
      ${objectList('Pions', map.tokens || [], 'token', (o) => html`<span class="mapedit-swatch" style=${{ background: DISPO[o.disposition]?.color }}></span>${o.name}${o.hidden ? ' (caché)' : ''}`)}
      ${objectList('Portes', map.doors || [], 'door', (o) => html`<span class="mapedit-swatch" style=${{ background: o.kind === 'secret' ? '#e0468f' : o.state === 'open' ? '#4fd17a' : '#e0a63f' }}></span>${o.name || DOOR_KINDS.find((k) => k.value === o.kind)?.label} · ${DOOR_STATES.find((s) => s.value === o.state)?.label.toLowerCase()}`)}
      ${objectList('Lumières', map.lights || [], 'light', (o) => html`<span class="mapedit-swatch" style=${{ background: o.on !== false ? o.color : 'transparent' }}></span>Rayon ${o.radius} · (${o.x}, ${o.y})`)}
      ${objectList('Zones', map.regions || [], 'region', (o) => html`<span class="mapedit-swatch" style=${{ background: o.gmOnly ? '#e0468f' : o.color || '#e0468f' }}></span>${o.name}${o.gmOnly ? ' (MJ)' : ''}`)}
      ${objectList('Notes MJ', map.notes || [], 'note', (o) => html`<span class="mapedit-swatch" style=${{ background: '#e0a63f' }}></span>${o.text.slice(0, 40)}`)}
      <div class="mapedit-section">
        <h5>Brouillard</h5>
        <${Button} small variant="ghost" onClick=${async () => { if (await confirmAction('Effacer la mémoire du brouillard pour tous les joueurs ?')) send('maps/resetFog', { mapId }).then(() => toast('Brouillard réinitialisé'), quiet); }}>Réinitialiser le brouillard</${Button}>
      </div>
    </aside>
  </div>`;
}
