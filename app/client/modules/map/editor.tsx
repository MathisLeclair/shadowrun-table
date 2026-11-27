// GM map editor: tiles (brush, line, rectangles, rooms, flood fill, eraser), segment walls & doors, doors, lights,
// regions, notes, tokens, background image.
// Tile and segment-wall edits are local (shared undo/redo) and saved with a debounce through maps/setTiles and
// maps/setWalls; other objects are sent immediately.
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, IconButton, Select, Toggle, Badge, Field, TextInput, NumberInput, confirmAction, promptText } from '../../lib/ui.tsx';
import { send, upload } from '../../lib/net.ts';
import { setUI, toast, openSheet } from '../../lib/ui-store.ts';
import { TILE_INFO } from '/shared/vision.ts';
import { MapCanvas, type MapHandlers, type MapPointerInfo } from './MapCanvas.tsx';
import { themeOptions, lightingOptions, DISPO, tileSwatch, getImage, wallKind, type MapRenderer, type MapOverlay, type MapScene, type Point, type Rect } from './renderer.ts';
import { t, tk, compare } from '../../lib/i18n.ts';
import { LibraryLinkModal } from './LibraryBrowser.tsx';
import type { GameMap, GameView, MapBackground, MapDoor, MapLight, MapNote, MapRegion, MapWall, Token, DoorState, WallDoor } from '../../../shared/types.ts';

type Opt = { value: string; label: string };
// Labels of the module-level tables below are French keys (tk), translated at render time.
/** Select options with translated labels. */
const tr = (list: Opt[]): Opt[] => list.map((o) => ({ value: o.value, label: t(o.label) }));
/** Tile names (same French text as TILE_INFO[ch].fr in shared/vision.js). */
const TILE_LABELS: Record<string, string> = {
  ' ': tk('Void (outside the map)'), '.': tk('Interior floor'), ',': tk('Exterior ground / street'), '#': tk('Wall'), D: tk('Door / doorway'), W: tk('Window'),
  '=': tk('Counter / low wall / railing'), T: tk('Table / furniture'), c: tk('Crates / cover'), o: tk('Pillar / column'), m: tk('Machinery / servers / shelves'),
  v: tk('Vehicle'), b: tk('Bed / couch'), s: tk('Stairs / ramp'), e: tk('Elevator'), '~': tk('Water'), g: tk('Grass / vegetation'), r: tk('Rubble (difficult terrain)'),
  x: tk('Hazard (fire, chemicals, electricity)'), t: tk('Trees / dense bushes'), _: tk('Carpet / stage / dance floor'),
};
type TileInfo = { fr: string; blockMove: boolean; blockSight: boolean };
const TILES = TILE_INFO as Record<string, TileInfo>;
const tileLabel = (ch: string): string => (TILE_LABELS[ch] ? t(TILE_LABELS[ch]) : TILES[ch]?.fr || ch);

type WallType = 'wall' | 'window' | 'curtain' | 'ethereal' | 'door' | 'secret';
const WALL_TOOLS = new Set(['wall', 'wdoor']);
const WALL_TYPES: Opt[] = [
  { value: 'wall', label: tk('Wall (blocks everything)') },
  { value: 'window', label: tk('Window (blocks movement)') },
  { value: 'curtain', label: tk('Curtain (blocks sight)') },
  { value: 'ethereal', label: tk('Marker (blocks nothing)') },
  { value: 'door', label: tk('Door') },
  { value: 'secret', label: tk('Secret door') },
];
const WDOOR_KINDS: Opt[] = [
  { value: 'door', label: tk('Door') },
  { value: 'secret', label: tk('Secret door') },
  { value: 'window', label: tk('Window') },
];
const BG_MODES: Opt[] = [
  { value: 'image', label: tk('Image = floor (illustrated map)') },
  { value: 'underlay', label: tk('Layer under the tiles') },
];
const newWallId = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/** Wall type of a segment, including doors. */
const wallType = (w: MapWall): WallType => (w.door ? (w.door.kind === 'secret' ? 'secret' : 'door') : wallKind(w));
/** Apply a type to a wall (keeps the door state/name when it stays a door). */
function withType(w: MapWall, type: string): MapWall {
  const base = { ...w };
  if (type === 'door' || type === 'secret') return { ...base, move: true, sight: true, door: { state: w.door?.state || 'closed', kind: type, ...(w.door?.name ? { name: w.door.name } : {}) } };
  return { ...base, move: type !== 'curtain' && type !== 'ethereal', sight: type !== 'window' && type !== 'ethereal', door: null };
}
/** Compact signature of walls (server sync / dirty checks). */
function wallsSig(walls: MapWall[] | undefined) {
  let s = '';
  for (const w of walls || []) s += `${w.id}:${w.x1},${w.y1},${w.x2},${w.y2},${w.move === false ? 0 : 1}${w.sight === false ? 0 : 1}${w.door ? w.door.state + w.door.kind + (w.door.name || '') : ''};`;
  return s;
}

type ToolId =
  | 'brush' | 'line' | 'rect' | 'outline' | 'room' | 'fill' | 'eraser' | 'pan'
  | 'wall' | 'wdoor' | 'door' | 'light' | 'region' | 'note' | 'token' | 'select';
const TOOLS: Array<{ id: ToolId; icon: string; label: string; key: string }> = [
  { id: 'brush', icon: '✎', label: tk('Brush'), key: 'b' },
  { id: 'line', icon: '╱', label: tk('Line'), key: 'l' },
  { id: 'rect', icon: '■', label: tk('Rect.'), key: 'r' },
  { id: 'outline', icon: '□', label: tk('Outline'), key: 'o' },
  { id: 'room', icon: '⌂', label: tk('Room'), key: 'p' },
  { id: 'fill', icon: '◍', label: tk('Fill'), key: 'f' },
  { id: 'eraser', icon: '⌫', label: tk('Eraser'), key: 'e' },
  { id: 'pan', icon: '✥', label: tk('Hand'), key: 'h' },
  { id: 'wall', icon: '┃', label: tk('Wall'), key: 'w' },
  { id: 'wdoor', icon: '⊓', label: tk('Wall door'), key: 'k' },
  { id: 'door', icon: '▯', label: tk('Door'), key: 'd' },
  { id: 'light', icon: '✺', label: tk('Light'), key: 'i' },
  { id: 'region', icon: '⬚', label: tk('Area'), key: 'z' },
  { id: 'note', icon: '!', label: tk('Note'), key: 'n' },
  { id: 'token', icon: '●', label: tk('Token'), key: 't' },
  { id: 'select', icon: '➚', label: tk('tool::Select'), key: 's' },
];
const PAINT = new Set<ToolId>(['brush', 'line', 'rect', 'outline', 'room', 'fill', 'eraser']);
const PALETTE = ['.', ',', '#', 'D', 'W', '=', 'T', 'c', 'o', 'm', 'v', 'b', 's', 'e', '~', 'g', 'r', 'x', 't', '_', ' '];
const TOOL_HELP: Partial<Record<ToolId, string>> = {
  brush: tk('Click and drag to paint. Alt+click or right-click: eyedropper.'),
  line: tk('Drag from the start point to the end point.'),
  rect: tk('Drag to fill a rectangle with the chosen tile.'),
  outline: tk('Drag to draw the outline of a rectangle.'),
  room: tk('Drag to create a room: walls around, floor (chosen tile) inside.'),
  fill: tk('Click: fills the connected area of the same tile.'),
  eraser: tk('Erases (void) under the brush.'),
  pan: tk('Drag to move the view. Tip: Space + drag, middle-click or right-drag work with every tool.'),
  wall: tk('Drag to draw a wall (snaps to corners / half cells and to wall ends; Alt: free placement; Shift: continue from the last point). Click: select (Shift+click: add). Ctrl+drag: box selection. Del: delete.'),
  wdoor: tk('Drag to draw a door on a wall. Click an existing wall: convert it to the chosen type (door, secret, window).'),
  door: tk('Click a cell: place a door. Click a door: select it.'),
  light: tk('Click: add a light. Drag a light to move it.'),
  region: tk('Drag to mark out a named area (room, sector…).'),
  note: tk('Click: pin a GM note (never visible to players).'),
  token: tk('Click: place a token. Drag a token to move it.'),
  select: tk('Click an object (token, light, door, wall, note, area) to edit it.'),
};
const ANCHORS: Opt[] = [
  { value: 'nw', label: tk('↖ Top left') }, { value: 'n', label: tk('↑ Top') }, { value: 'ne', label: tk('↗ Top right') },
  { value: 'w', label: tk('← Left') }, { value: 'c', label: tk('• Center') }, { value: 'e', label: tk('→ Right') },
  { value: 'sw', label: tk('↙ Bottom left') }, { value: 's', label: tk('↓ Bottom') }, { value: 'se', label: tk('↘ Bottom right') },
];
const DOOR_STATES: Opt[] = [{ value: 'closed', label: tk('Closed') }, { value: 'open', label: tk('fem::Open') }, { value: 'locked', label: tk('Locked') }];
const DOOR_KINDS: Opt[] = [{ value: 'door', label: tk('Door') }, { value: 'gate', label: tk('door::Gate') }, { value: 'shutter', label: tk('Shutter') }, { value: 'secret', label: tk('fem::Secret') }];
const DISPO_OPTIONS: Opt[] = Object.entries(DISPO).map(([value, d]) => ({ value, label: d.label })); // d.label: French key
const quiet = () => {};
/** Like Field but a <div>: a <label> would forward clicks on its text to the stepper buttons. */
const NumField = ({ label, children }: { label: ReactNode; children?: ReactNode }) => (
  <div className="field">
    <span className="field-label">{label}</span>
    {children}
  </div>
);

interface CommitInputProps {
  type: 'color' | 'range';
  value: string | number;
  onCommit: (value: string) => void;
  className?: string;
  min?: string;
  max?: string;
  step?: string;
}
/**
 * Color / range input that reports the native « change » event only (picker closed, slider released), like the
 * Preact version did: React's onChange would fire (and send a server action) on every intermediate value.
 */
function CommitInput({ type, value, onCommit, ...rest }: CommitInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onCommit);
  cb.current = onCommit;
  useEffect(() => {
    const el = ref.current!;
    const h = () => cb.current(el.value);
    el.addEventListener('change', h);
    return () => el.removeEventListener('change', h);
  }, []);
  useEffect(() => {
    if (ref.current && ref.current.value !== String(value)) ref.current.value = String(value);
  }, [value]);
  return <input type={type} ref={ref} defaultValue={String(value)} {...rest} />;
}

type Cell = { x: number; y: number };
type ShapeCell = Cell & { edge?: boolean };

function lineCells(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
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
function rectOf(a: Cell, b: Cell): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}
function brushCells(c: Cell, size: number): Cell[] {
  const out: Cell[] = [];
  const o = -Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push({ x: c.x + o + dx, y: c.y + o + dy });
  return out;
}

type ObjType = 'door' | 'light' | 'region' | 'note' | 'token';
type HitType = ObjType | 'wall';
interface Hit {
  type: HitType;
  id: string;
}
interface Sel {
  type: ObjType;
  id: string;
}
type MapObject = MapDoor | MapLight | MapRegion | MapNote | Token;
interface Snapshot {
  rows: string[];
  walls: MapWall[];
  doorIds?: string[];
}
/** Current pointer gesture (one shape per kind of stroke, all fields optional). */
interface Stroke {
  before?: Snapshot;
  start?: Cell;
  last?: Cell;
  wallBox?: boolean;
  sx?: number;
  sy?: number;
  additive?: boolean;
  seg?: boolean;
  a?: Point;
  b?: Point;
  down?: MapPointerInfo;
  drag?: Hit;
  target?: Cell;
  region?: boolean;
}
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
interface TokenOpts {
  actorId: string;
  name: string;
  disposition: string;
  hidden: boolean;
}

interface MapEditorProps {
  game: GameView;
  map: GameMap;
  onBack: () => void;
}

export function MapEditor({ game, map, onBack }: MapEditorProps) {
  const mapId = map.id;
  const rRef = useRef<MapRenderer | null>(null);
  const rowsRef = useRef<string[]>(map.tiles.slice());
  const wallsRef = useRef<MapWall[]>(map.walls || []);
  const savedRef = useRef<Snapshot>({ rows: rowsRef.current, walls: wallsRef.current }); // last state known to the server
  const lastEndRef = useRef<Point | null>(null); // last wall end point (Shift: chain walls)
  const [wallSel, setWallSel] = useState<string[]>([]); // selected wall ids
  const [wallOpts, setWallOpts] = useState({ type: 'wall' });
  const [wdoorOpts, setWdoorOpts] = useState<{ kind: string; state: string }>({ kind: 'door', state: 'closed' });
  const dimsRef = useRef(`${map.width}x${map.height}`);
  const [ver, setVer] = useState(0);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  // Segment-door states: players toggle doors live while the editor is open. A save sends the whole walls
  // array, so for every door the GM did not change on purpose here (door panel, new door, undo/redo of such
  // an edit) the CURRENT server state is sent instead of the editor's possibly stale copy.
  const serverWallsRef = useRef<MapWall[]>(map.walls || []);
  serverWallsRef.current = map.walls || [];
  const gmDoorEditsRef = useRef(new Set<string>());
  const strokeRef = useRef<Stroke | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [tool, setTool] = useState<ToolId>('brush');
  const [tile, setTile] = useState('#');
  const [size, setSize] = useState(1);
  const [doorOpts, setDoorOpts] = useState({ state: 'closed', kind: 'door' });
  const [lightOpts, setLightOpts] = useState({ radius: 6, color: '#ffcc88', on: true });
  const [regionOpts, setRegionOpts] = useState({ color: '#e0468f', gmOnly: false });
  const [tokenOpts, setTokenOpts] = useState<TokenOpts>(() => ({ actorId: '', name: t('NPC'), disposition: 'hostile', hidden: false }));
  const [sel, setSel] = useState<Sel | null>(null); // { type: 'door'|'light'|'region'|'note'|'token', id }
  const [panel, setPanel] = useState({ tools: false, props: false });
  const [libOpen, setLibOpen] = useState(false); // « Bibliothèque » dialog (library-linked maps)
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

  const wallsForSave = (walls: MapWall[]): MapWall[] => {
    const live = new Map((serverWallsRef.current || []).filter((w) => w.door).map((w) => [w.id, w.door!.state]));
    return walls.map((w) => (w.door && !gmDoorEditsRef.current.has(w.id) && live.has(w.id) && live.get(w.id) !== w.door.state ? { ...w, door: { ...w.door, state: live.get(w.id)! } } : w));
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
      toast(t('Could not save the map: {error}', { error: (e as Error).message }), 'error');
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
    const beforeUnload = (e: BeforeUnloadEvent) => {
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

  const T = (x: number, y: number): string | null => (x < 0 || y < 0 || x >= map.width || y >= map.height ? null : rowsRef.current[y][x]);
  const applyCells = (cells: ShapeCell[], chOrFn: string | ((c: ShapeCell) => string)) => {
    const rows = rowsRef.current.slice();
    const byRow = new Map<number, string[]>();
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
  const snapshot = (): Snapshot => ({ rows: rowsRef.current, walls: wallsRef.current });
  /** Ids of walls whose door state differs between two walls arrays (or that became / stopped being doors). */
  const doorDiff = (a: MapWall[] = [], b: MapWall[] = []) => {
    const m = new Map(a.filter((w) => w.door).map((w) => [w.id, w.door!.state]));
    const ids: string[] = [];
    for (const w of b) {
      if (w.door ? m.get(w.id) !== w.door.state : m.has(w.id)) ids.push(w.id);
      m.delete(w.id);
    }
    return ids;
  };
  const restore = (snap: Snapshot) => {
    rowsRef.current = snap.rows;
    wallsRef.current = snap.walls;
    for (const id of snap.doorIds || []) gmDoorEditsRef.current.add(id);
    bump();
    markDirty();
  };
  const beginStroke = (extra: Partial<Stroke> = {}) => {
    strokeRef.current = { before: snapshot(), ...extra };
  };
  const endStroke = () => {
    const s = strokeRef.current;
    strokeRef.current = null;
    if (s?.before && (s.before.rows !== rowsRef.current || s.before.walls !== wallsRef.current)) {
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
    const e = undoRef.current.pop()!;
    redoRef.current.push({ ...snapshot(), doorIds: e.doorIds || [] });
    restore(e);
  };
  const redo = () => {
    if (!redoRef.current.length) return;
    const e = redoRef.current.pop()!;
    undoRef.current.push({ ...snapshot(), doorIds: e.doorIds || [] });
    restore(e);
  };
  /** One undoable wall edit: fn(walls) → new walls array. */
  const editWalls = (fn: (walls: MapWall[]) => MapWall[]) => {
    beginStroke();
    const next = fn(wallsRef.current);
    if (next !== wallsRef.current) {
      wallsRef.current = next;
      bump();
    }
    endStroke();
  };
  const patchWalls = (ids: string[], fn: (w: MapWall) => MapWall) => {
    const set = new Set(ids);
    editWalls((walls) => walls.map((w) => (set.has(w.id) ? fn(w) : w)));
  };
  const deleteWalls = (ids: string[]) => {
    const set = new Set(ids);
    const n = wallsRef.current.filter((w) => set.has(w.id)).length;
    if (!n) return;
    editWalls((walls) => walls.filter((w) => !set.has(w.id)));
    setWallSel([]);
    toast(n > 1 ? t('{n} walls deleted (Ctrl+Z to undo)', { n }) : t('Wall deleted (Ctrl+Z to undo)'));
  };

  const floodFill = (start: Cell, ch: string) => {
    const from = T(start.x, start.y);
    if (from == null || from === ch) return;
    const w = map.width, h = map.height;
    const seen = new Uint8Array(w * h);
    const cells: Cell[] = [];
    const q: Cell[] = [start];
    seen[start.y * w + start.x] = 1;
    while (q.length) {
      const c = q.pop()!;
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

  const shapeCells = (kind: ToolId, a: Cell, b: Cell): { cells: ShapeCell[]; rect?: Rect; room?: boolean } => {
    if (kind === 'line') return { cells: lineCells(a, b) };
    const r = rectOf(a, b);
    const all: ShapeCell[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) all.push({ x, y, edge: x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1 });
    if (kind === 'rect') return { cells: all, rect: r };
    if (kind === 'outline') return { cells: all.filter((c) => c.edge), rect: r };
    return { cells: all, rect: r, room: true };
  };
  const paintChar = tool === 'eraser' ? ' ' : tile;

  // ---------------- objects ----------------
  const objectAt = (fx: number, fy: number, types: HitType[] = ['token', 'light', 'door', 'note', 'wall', 'region'], sx: number | null = null, sy: number | null = null): Hit | null => {
    const cx = Math.floor(fx), cy = Math.floor(fy);
    for (const tt of types) {
      if (tt === 'wall') {
        if (sx == null || sy == null) continue;
        const w = rRef.current?.wallAtScreen(sx, sy, 8);
        if (w) return { type: 'wall', id: w.id };
      } else if (tt === 'token') {
        const tok = rRef.current?.tokenAt(fx, fy);
        if (tok) return { type: 'token', id: tok.id };
      } else if (tt === 'light') {
        const l = (map.lights || []).find((o) => o.x === cx && o.y === cy);
        if (l) return { type: 'light', id: l.id };
      } else if (tt === 'door') {
        const d = (map.doors || []).find((o) => o.x === cx && o.y === cy);
        if (d) return { type: 'door', id: d.id };
      } else if (tt === 'note') {
        const n = (map.notes || []).find((o) => o.x === cx && o.y === cy);
        if (n) return { type: 'note', id: n.id };
      } else if (tt === 'region') {
        const r = [...(map.regions || [])].reverse().find((o) => cx >= o.x && cy >= o.y && cx < o.x + o.w && cy < o.y + o.h);
        if (r) return { type: 'region', id: r.id };
      }
    }
    return null;
  };
  const listOf = (type: ObjType): MapObject[] => (map[type === 'door' ? 'doors' : (`${type}s` as 'lights' | 'regions' | 'notes' | 'tokens')] || []) as MapObject[];
  const selected = sel ? listOf(sel.type).find((o) => o.id === sel.id) || null : null;
  // Drop a selection whose object disappeared from the map. Only when the map itself changed: an object just
  // created is selected from the action's reply, which arrives before the state broadcast that contains it.
  const selMapRef = useRef(map);
  useEffect(() => {
    const mapChanged = selMapRef.current !== map;
    selMapRef.current = map;
    if (sel && !selected && mapChanged) setSel(null);
  }, [map, sel]);
  // drop selected wall ids that no longer exist (undo, server sync)
  const selWalls = wallSel.length ? wallsRef.current.filter((w) => wallSel.includes(w.id)) : [];
  useEffect(() => {
    if (wallSel.length && selWalls.length !== wallSel.length) setWallSel(selWalls.map((w) => w.id));
  }, [ver, map, wallSel]);
  /** Select objects (clears the wall selection) / walls (clears the object selection). */
  const pick = (hit: Hit | null, additive = false) => {
    if (hit?.type === 'wall') {
      setSel(null);
      setWallSel((cur) => (additive ? (cur.includes(hit.id) ? cur.filter((x) => x !== hit.id) : [...cur, hit.id]) : [hit.id]));
    } else {
      setWallSel([]);
      setSel(hit as Sel | null);
    }
  };

  // ---------------- segment walls ----------------
  /** Snap a world point: wall end points within 10 px, else half-cells; Alt (free) → 1/100 cell. */
  const snapPoint = (info: MapPointerInfo, free?: boolean): Point => {
    if (free) return { x: Math.round(info.fx * 100) / 100, y: Math.round(info.fy * 100) / 100 };
    const r = rRef.current;
    if (r) {
      let best: Point | null = null, bestD = 10;
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
  const makeWall = (a: Point, b: Point): MapWall => {
    const base: MapWall = { id: newWallId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y, move: true, sight: true, door: null };
    if (tool === 'wdoor')
      return wdoorOpts.kind === 'window' ? withType(base, 'window') : { ...base, door: { state: wdoorOpts.state as DoorState, kind: wdoorOpts.kind as WallDoor['kind'] } };
    return withType(base, wallOpts.type);
  };
  /** wdoor tool click on a wall: convert it to the chosen kind. */
  const convertWall = (id: string) => {
    const type = wdoorOpts.kind === 'window' ? 'window' : wdoorOpts.kind;
    patchWalls([id], (w) => {
      const next = withType(w, type);
      return next.door ? { ...next, door: { ...next.door, state: w.door ? w.door.state : (wdoorOpts.state as DoorState) } } : next;
    });
    pick({ type: 'wall', id });
    toast(t('Wall converted: {kind}', { kind: t(WDOOR_KINDS.find((k) => k.value === wdoorOpts.kind)?.label || '').toLowerCase() }));
  };

  const addDoorAt = (x: number, y: number) => {
    // local tile becomes a door cell too, so a pending tile save keeps it
    beginStroke();
    applyCells([{ x, y }], 'D');
    endStroke();
    send<string>('maps/addDoor', { mapId, door: { x, y, ...doorOpts } }).then((id) => setSel({ type: 'door', id }), quiet);
  };
  const addToken = (x: number, y: number) => {
    const a = tokenOpts.actorId ? game.actors?.[tokenOpts.actorId] : null;
    const token: Record<string, unknown> = a ? { actorId: a.id, x, y, hidden: tokenOpts.hidden } : { name: tokenOpts.name || t('Token'), disposition: tokenOpts.disposition, hidden: tokenOpts.hidden, x, y };
    if (a && tokenOpts.disposition && a.type !== 'pc') token.disposition = tokenOpts.disposition;
    send<string>('maps/addToken', { mapId, token }).then((id) => setSel({ type: 'token', id }), quiet);
  };

  // ---------------- pointer handlers ----------------
  const overlayFor = (extra: MapOverlay = {}): MapOverlay => {
    const out = { ...extra };
    if (selected && sel?.type === 'light') out.selectedLightId = sel.id;
    if (wallSel.length) out.selectedWallIds = new Set(wallSel);
    return out;
  };
  const handlers: MapHandlers & { onCancel: () => void } = {
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
        if (hit) setSel(hit as Sel);
        else addDoorAt(c.x, c.y);
        return true;
      }
      if (tool === 'light' || tool === 'token' || tool === 'select') {
        const types: HitType[] | undefined = tool === 'light' ? ['light'] : tool === 'token' ? ['token'] : undefined;
        const hit = objectAt(info.fx, info.fy, types, info.sx, info.sy);
        if (hit) {
          pick(hit, info.shift);
          if (hit.type === 'token' || hit.type === 'light') strokeRef.current = { drag: hit, start: c, target: c };
          return true;
        }
        if (tool === 'light') {
          send<string>('maps/addLight', { mapId, light: { x: c.x, y: c.y, ...lightOpts } }).then((id) => setSel({ type: 'light', id }), quiet);
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
        if (hit) setSel(hit as Sel);
        else
          promptText(t('GM note (never visible to players)')).then((text) => {
            if (text && text.trim()) send<string>('maps/addNote', { mapId, note: { x: c.x, y: c.y, text: text.trim() } }).then((id) => setSel({ type: 'note', id }), quiet);
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
        rRef.current?.setOverlay(overlayFor({ box: { x: Math.min(s.sx!, info.sx), y: Math.min(s.sy!, info.sy), w: Math.abs(info.sx - s.sx!), h: Math.abs(info.sy - s.sy!) } }));
        return;
      }
      if (s.seg) {
        const a = s.a!;
        const b = (s.b = snapPoint(info, info.alt));
        const preview = makeWall(a, b);
        const color = preview.door
          ? preview.door.kind === 'secret' ? '#e0468f' : '#e0a63f'
          : ({ wall: '#3fd6d0', window: '#5cc8ff', curtain: '#9d7ce0' } as Record<string, string>)[wallKind(preview)] || '#3fd6d0';
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        rRef.current?.setOverlay(
          overlayFor({
            segment: { x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, dashed: wallKind(preview) !== 'wall' && !preview.door },
            snap: b,
            pathLabel: `${Math.round(len * (map.metersPerCell || 1) * 10) / 10} m`,
            labelAt: { x: b.x, y: b.y - 0.6 },
          })
        );
        return;
      }
      const c = { x: Math.max(0, Math.min(map.width - 1, info.cx)), y: Math.max(0, Math.min(map.height - 1, info.cy)) };
      if (s.drag) {
        if (s.target && s.target.x === c.x && s.target.y === c.y) return;
        s.target = c;
        if (s.drag.type === 'token') {
          const tok = map.tokens.find((tt) => tt.id === s.drag!.id);
          if (tok) rRef.current?.setOverlay(overlayFor({ ghosts: [{ token: tok, x: c.x, y: c.y }] }));
        } else rRef.current?.setOverlay(overlayFor({ hoverCell: c, hoverColor: '#ffcc88' }));
        return;
      }
      if (s.region) {
        s.last = c;
        const r = rectOf(s.start!, c);
        rRef.current?.setOverlay(overlayFor({ rect: r, rectColor: regionOpts.color }));
        return;
      }
      if (tool === 'brush' || tool === 'eraser') {
        const raw = { x: info.cx, y: info.cy };
        const cells: Cell[] = [];
        for (const p of lineCells(s.last!, raw)) cells.push(...brushCells(p, size));
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
        const a = r.toWorld(Math.min(s.sx!, info.sx), Math.min(s.sy!, info.sy));
        const b = r.toWorld(Math.max(s.sx!, info.sx), Math.max(s.sy!, info.sy));
        const inBox = (x: number, y: number) => x >= a.x && x <= b.x && y >= a.y && y <= b.y;
        const hits = wallsRef.current.filter((w) => inBox(w.x1, w.y1) && inBox(w.x2, w.y2)).map((w) => w.id);
        const next = s.additive ? [...new Set([...wallSel, ...hits])] : hits;
        setSel(null);
        setWallSel(next);
        r.setOverlay(overlayFor({ selectedWallIds: new Set(next) }));
        if (hits.length) toast(t('{n} wall(s) selected', { n: hits.length }));
        return;
      }
      if (s.seg) {
        strokeRef.current = null;
        const a = s.a!;
        const b = moved ? snapPoint(info, info.alt) : a;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!moved || len < 0.05) {
          // click: select / convert the wall under the pointer
          const hit = rRef.current?.wallAtScreen(info.sx, info.sy, 8);
          if (hit && tool === 'wdoor') convertWall(hit.id);
          else if (hit) pick({ type: 'wall', id: hit.id }, info.shift);
          else if (!info.shift) setWallSel([]);
          rRef.current?.setOverlay(overlayFor({ selectedWallIds: hit ? new Set(info.shift ? wallSel.concat(hit.id) : [hit.id]) : undefined }));
          return;
        }
        const w = makeWall(a, b);
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
        if (!moved || (s.start!.x === c.x && s.start!.y === c.y)) return;
        if (s.drag.type === 'token') send('maps/moveToken', { mapId, tokenId: s.drag.id, x: c.x, y: c.y, ignoreWalls: true }).catch(quiet);
        else send('maps/updateLight', { mapId, lightId: s.drag.id, patch: { x: c.x, y: c.y } }).catch(quiet);
        return;
      }
      if (s.region) {
        strokeRef.current = null;
        rRef.current?.setOverlay(overlayFor());
        const r = rectOf(s.start!, c);
        if (!moved || (r.w === 1 && r.h === 1)) {
          const hit = objectAt(info.fx, info.fy, ['region']);
          if (hit) setSel(hit as Sel);
          return;
        }
        promptText(t('Area name'), t('Area')).then((name) => {
          if (name && name.trim()) send<string>('maps/addRegion', { mapId, region: { ...r, name: name.trim(), ...regionOpts } }).then((id) => setSel({ type: 'region', id }), quiet);
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
          toast(t('Eyedropper: {tile}', { tile: tileLabel(ch) }));
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
      } else if (PAINT.has(tool) && tool !== 'fill')
        r.setOverlay(
          overlayFor({
            cells: brushCells({ x: info.cx, y: info.cy }, tool === 'brush' || tool === 'eraser' ? size : 1),
            cellsColor: tool === 'eraser' ? 'rgba(224,92,92,0.25)' : 'rgba(63,214,208,0.22)',
          })
        );
      else r.setOverlay(overlayFor({ hoverCell: { x: info.cx, y: info.cy } }));
    },
  };
  function updateShapePreview(c: Cell) {
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
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || target?.isContentEditable) return;
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
      const tt = TOOLS.find((x) => x.key === k);
      if (tt) setTool(tt.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const deleteSelected = async () => {
    if (!sel || !selected) return;
    const name = 'name' in selected ? selected.name : '';
    const question = {
      door: () => t('Delete this door?'),
      light: () => t('Delete this light?'),
      region: () => t('Delete the area “{name}”?', { name }),
      note: () => t('Delete this note?'),
      token: () => t('Delete the token “{name}”?', { name }),
    }[sel.type];
    if (!question || !(await confirmAction(question()))) return;
    const action = { door: 'maps/removeDoor', light: 'maps/removeLight', region: 'maps/removeRegion', note: 'maps/removeNote', token: 'maps/removeToken' }[sel.type];
    const idKey = { door: 'doorId', light: 'lightId', region: 'regionId', note: 'noteId', token: 'tokenId' }[sel.type];
    send(action, { mapId, [idKey]: sel.id }).then(() => setSel(null), quiet);
  };

  // ---------------- scene ----------------
  const editMap = useMemo(() => ({ ...map, tiles: rowsRef.current, walls: wallsRef.current }), [map, ver]);
  const scene = useMemo<MapScene>(
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
  const upd = (patch: Record<string, unknown>) => send('maps/update', { mapId, patch }).catch(quiet);
  const bg = map.background || null;
  /** Background defaults: an empty / all-floor map becomes an image map, a painted one keeps its tiles on top. */
  const bgDefaults = (): Omit<MapBackground, 'url'> => {
    const tileArt = rowsRef.current.some((r) => /[^.,\s]/.test(r));
    return tileArt ? { mode: 'underlay', opacity: 0.6, x: 0, y: 0, w: map.width, h: map.height } : { mode: 'image', opacity: 1, x: 0, y: 0, w: map.width, h: map.height };
  };
  const setBg = (patch: Partial<MapBackground> | null) => upd({ background: patch === null ? null : { ...(bg || bgDefaults()), ...patch } });
  const onBg = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const res = await upload(f);
      await send('maps/update', { mapId, patch: { background: { ...(bg || bgDefaults()), url: res.url } } });
      toast(t('Background image added'), 'success');
    } catch (err) {
      toast(t('Upload failed: {error}', { error: (err as Error).message }), 'error');
    }
  };
  const fitBg = () => setBg({ x: 0, y: 0, w: map.width, h: map.height });
  const bgAspect = () => {
    const img = bg?.url ? getImage(bg.url) : null;
    if (!bg || !img || !img.naturalWidth) return toast(t('Image not loaded yet — try again in a moment'), 'warn');
    setBg({ h: Math.round(((bg.w || map.width) * img.naturalHeight * 100) / img.naturalWidth) / 100 });
  };
  const fillInterior = async () => {
    if (!(await confirmAction(t('Replace every tile with interior floor “.”? Tile walls/doors disappear (segment walls stay). Can be undone with Ctrl+Z.')))) return;
    beginStroke();
    const cells: Cell[] = [];
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) cells.push({ x, y });
    applyCells(cells, '.');
    endStroke();
    toast(t('The whole map is now floor'), 'success');
  };
  const wallStats = useMemo(() => {
    const s: Record<WallType, number> = { wall: 0, window: 0, curtain: 0, ethereal: 0, door: 0, secret: 0 };
    for (const w of wallsRef.current) s[wallType(w)]++;
    return s;
  }, [ver, map]);
  const doResize = async () => {
    const { width, height, anchor } = resize;
    if (width === map.width && height === map.height) return;
    if ((width < map.width || height < map.height) && !(await confirmAction(t('Shrinking the map deletes whatever sticks out. Continue?')))) return;
    await flush();
    send('maps/resize', { mapId, width, height, anchor }).then(() => toast(t('Map resized'), 'success'), quiet);
  };
  const actorOptions = useMemo(() => {
    const list = Object.values(game.actors || {}).filter((a) => !('retired' in a && a.retired));
    return [
      { value: '', label: t('Free token (no sheet)') },
      ...list.filter((a) => a.type === 'pc').map((a) => ({ value: a.id, label: t('PC — {name}', { name: a.name }) })),
      ...list
        .filter((a) => a.type !== 'pc')
        .sort((a, b) => compare(a.name, b.name))
        .map((a) => ({ value: a.id, label: t('NPC — {name}', { name: a.name }) })),
    ];
  }, [game.actors]);
  const centerOn = (o: { x: number; y: number; w?: number; h?: number }) => rRef.current?.centerOn(o.x + (o.w ? o.w / 2 - 0.5 : 0), o.y + (o.h ? o.h / 2 - 0.5 : 0), 28);
  const shown = game.scene?.activeMapId === mapId;
  const saveLabel =
    { saved: () => '✓ ' + t('Saved'), dirty: () => '● ' + t('Modified'), saving: () => '… ' + t('Saving'), error: () => '⚠ ' + t('Error — retrying') }[saveState]?.() || '';

  const toolOptions = () => {
    if (PAINT.has(tool) && tool !== 'eraser') {
      return (
        <div className="mapedit-opts">
          <div className="row">
            <img src={tileSwatch(tile, map.theme, 30)} width="24" height="24" alt="" />
            <strong className="small">{tileLabel(tile)}</strong>
          </div>
          {tool === 'brush' && (
            <div className="row spread">
              <span className="small muted">{t('Size')}</span>
              <NumberInput small value={size} min={1} max={3} onChange={setSize} />
            </div>
          )}
          {tool === 'room' && (
            <span className="small muted">{t('Walls “#” around, {floor} inside.', { floor: tile === '#' || tile === ' ' ? t('interior floor') : tileLabel(tile).toLowerCase() })}</span>
          )}
        </div>
      );
    }
    if (tool === 'eraser')
      return (
        <div className="mapedit-opts">
          <div className="row spread">
            <span className="small muted">{t('Size')}</span>
            <NumberInput small value={size} min={1} max={3} onChange={setSize} />
          </div>
        </div>
      );
    if (tool === 'wall')
      return (
        <div className="mapedit-opts">
          <Field label={t('Wall type')}>
            <Select value={wallOpts.type} options={tr(WALL_TYPES)} onChange={(v) => setWallOpts({ ...wallOpts, type: v })} />
          </Field>
          <span className="small muted">
            {t('{walls} wall(s) · {doors} door(s)', { walls: wallStats.wall + wallStats.window + wallStats.curtain + wallStats.ethereal, doors: wallStats.door + wallStats.secret })}
          </span>
        </div>
      );
    if (tool === 'wdoor')
      return (
        <div className="mapedit-opts">
          <Field label={t('Type')}>
            <Select value={wdoorOpts.kind} options={tr(WDOOR_KINDS)} onChange={(v) => setWdoorOpts({ ...wdoorOpts, kind: v })} />
          </Field>
          {wdoorOpts.kind !== 'window' && (
            <Field label={t('Status')}>
              <Select value={wdoorOpts.state} options={tr(DOOR_STATES)} onChange={(v) => setWdoorOpts({ ...wdoorOpts, state: v })} />
            </Field>
          )}
        </div>
      );
    if (tool === 'door')
      return (
        <div className="mapedit-opts">
          <Field label={t('Type')}>
            <Select value={doorOpts.kind} options={tr(DOOR_KINDS)} onChange={(v) => setDoorOpts({ ...doorOpts, kind: v })} />
          </Field>
          <Field label={t('Status')}>
            <Select value={doorOpts.state} options={tr(DOOR_STATES)} onChange={(v) => setDoorOpts({ ...doorOpts, state: v })} />
          </Field>
        </div>
      );
    if (tool === 'light')
      return (
        <div className="mapedit-opts">
          <div className="row spread">
            <span className="small muted">{t('Radius (cells)')}</span>
            <NumberInput small value={lightOpts.radius} min={1} max={40} onChange={(v) => setLightOpts({ ...lightOpts, radius: v })} />
          </div>
          <div className="row spread">
            <span className="small muted">{t('Color')}</span>
            <input type="color" className="mapedit-color" value={lightOpts.color} onChange={(e) => setLightOpts({ ...lightOpts, color: e.target.value })} />
          </div>
          <div className="row wrap gap-s">
            {['#ffcc88', '#fff1cc', '#3fd6d0', '#e0468f', '#9d7ce0', '#e05c5c', '#4fd17a'].map((c) => (
              <button
                key={c}
                className="mapedit-swatch"
                style={{ background: c, width: '18px', height: '18px', cursor: 'pointer' }}
                title={c}
                onClick={() => setLightOpts({ ...lightOpts, color: c })}
              ></button>
            ))}
          </div>
        </div>
      );
    if (tool === 'region')
      return (
        <div className="mapedit-opts">
          <div className="row spread">
            <span className="small muted">{t('Color')}</span>
            <input type="color" className="mapedit-color" value={regionOpts.color} onChange={(e) => setRegionOpts({ ...regionOpts, color: e.target.value })} />
          </div>
          <Toggle label={t('fem::GM only')} value={regionOpts.gmOnly} onChange={(v) => setRegionOpts({ ...regionOpts, gmOnly: v })} />
        </div>
      );
    if (tool === 'token')
      return (
        <div className="mapedit-opts">
          <Field label={t('Linked sheet')}>
            <Select value={tokenOpts.actorId} options={actorOptions} onChange={(v) => setTokenOpts({ ...tokenOpts, actorId: v })} />
          </Field>
          {!tokenOpts.actorId && (
            <Field label={t('Name')}>
              <input className="input" value={tokenOpts.name} onChange={(e) => setTokenOpts({ ...tokenOpts, name: e.target.value })} />
            </Field>
          )}
          <Field label={t('Disposition')}>
            <Select value={tokenOpts.disposition} options={tr(DISPO_OPTIONS)} onChange={(v) => setTokenOpts({ ...tokenOpts, disposition: v })} />
          </Field>
          <Toggle label={t('Hidden from players')} value={tokenOpts.hidden} onChange={(v) => setTokenOpts({ ...tokenOpts, hidden: v })} />
          <Button
            small
            onClick={() =>
              send<string[]>('maps/placePCs', { mapId }).then((ids) => toast(ids?.length ? t('{n} PC(s) placed', { n: ids.length }) : t('All PCs are already on the map')), quiet)
            }
          >
            {t('Place all PCs')}
          </Button>
        </div>
      );
    return null;
  };

  const wallInspector = () => {
    if (!selWalls.length) return null;
    const ids = selWalls.map((w) => w.id);
    const head = (title: string) => (
      <div className="row spread">
        <h5>{title}</h5>
        <IconButton icon="✕" title={t('Deselect')} onClick={() => setWallSel([])} />
      </div>
    );
    const types = new Set(selWalls.map(wallType));
    const typeValue = types.size === 1 ? [...types][0] : '';
    const typeSelect = (
      <Field label={t('Type')}>
        <Select
          value={typeValue}
          options={typeValue ? tr(WALL_TYPES) : [{ value: '', label: t('(several types)') }, ...tr(WALL_TYPES)]}
          onChange={(v) => v && patchWalls(ids, (w) => withType(w, v))}
        />
      </Field>
    );
    const del = (
      <Button small variant="danger" onClick={() => deleteWalls(ids)}>
        {ids.length > 1 ? t('Delete ({n})', { n: ids.length }) : t('Delete')}
      </Button>
    );
    if (selWalls.length > 1) {
      return (
        <div className="mapedit-inspector">
          {head(t('{n} walls', { n: selWalls.length }))}
          {typeSelect}
          <span className="small muted">{t('Del: delete · Ctrl+Z: undo')}</span>
          {del}
        </div>
      );
    }
    const w = selWalls[0];
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const setCoord = (k: 'x1' | 'y1' | 'x2' | 'y2') => (v: number) => patchWalls(ids, (x) => ({ ...x, [k]: v }));
    return (
      <div className="mapedit-inspector">
        {head(w.door ? (w.door.kind === 'secret' ? t('Secret door (wall)') : t('Door (wall)')) : t('Wall'))}
        {typeSelect}
        {w.door && (
          <>
            <Field label={t('Status')}>
              <Select value={w.door.state} options={tr(DOOR_STATES)} onChange={(v) => patchWalls(ids, (x) => ({ ...x, door: { ...x.door!, state: v as DoorState } }))} />
            </Field>
            <Field label={t('Name (optional)')}>
              <TextInput
                value={w.door.name || ''}
                placeholder={t('e.g. Lab door')}
                onChange={(v) =>
                  patchWalls(ids, (x) => {
                    const door = { ...x.door! };
                    if (v.trim()) door.name = v.trim();
                    else delete door.name;
                    return { ...x, door };
                  })
                }
              />
            </Field>
          </>
        )}
        <div className="grid-2">
          {(['x1', 'y1', 'x2', 'y2'] as const).map((k) => (
            <NumField key={k} label={k.toUpperCase()}>
              <NumberInput small value={w[k]} step={0.5} min={-10} max={(k[0] === 'x' ? map.width : map.height) + 10} onChange={setCoord(k)} />
            </NumField>
          ))}
        </div>
        <span className="small muted">
          {t('Length {m} m', { m: Math.round(len * (map.metersPerCell || 1) * 10) / 10 })}
          {w.foundry ? ' · ' + t('imported from Foundry') : ''}
        </span>
        {del}
      </div>
    );
  };

  const inspector = () => {
    if (wallSel.length) return wallInspector();
    if (!sel || !selected) return null;
    const del = (
      <Button small variant="danger" onClick={deleteSelected}>
        {t('Delete')}
      </Button>
    );
    const head = (title: string) => (
      <div className="row spread">
        <h5>{title}</h5>
        <IconButton icon="✕" title={t('Deselect')} onClick={() => setSel(null)} />
      </div>
    );
    if (sel.type === 'door') {
      const o = selected as MapDoor;
      return (
        <div className="mapedit-inspector">
          {head(t('Door ({x}, {y})', { x: o.x, y: o.y }))}
          <Field label={t('Name (optional)')}>
            <TextInput value={o.name || ''} placeholder={t('e.g. Lab door')} onChange={(v) => send('maps/setDoor', { mapId, doorId: o.id, name: v }).catch(quiet)} />
          </Field>
          <Field label={t('Type')}>
            <Select value={o.kind} options={tr(DOOR_KINDS)} onChange={(v) => send('maps/setDoor', { mapId, doorId: o.id, kind: v }).catch(quiet)} />
          </Field>
          <Field label={t('Status')}>
            <Select value={o.state} options={tr(DOOR_STATES)} onChange={(v) => send('maps/setDoor', { mapId, doorId: o.id, state: v }).catch(quiet)} />
          </Field>
          {del}
        </div>
      );
    }
    if (sel.type === 'light') {
      const o = selected as MapLight;
      return (
        <div className="mapedit-inspector">
          {head(t('Light ({x}, {y})', { x: o.x, y: o.y }))}
          <Toggle label={o.on !== false ? t('On') : t('light::Off')} value={o.on !== false} onChange={() => send('maps/toggleLight', { mapId, lightId: o.id }).catch(quiet)} />
          <div className="row spread">
            <span className="small muted">{t('Radius (cells)')}</span>
            <NumberInput small value={o.radius} min={1} max={40} onChange={(v) => send('maps/updateLight', { mapId, lightId: o.id, patch: { radius: v } }).catch(quiet)} />
          </div>
          <div className="row spread">
            <span className="small muted">{t('Color')}</span>
            <CommitInput
              type="color"
              className="mapedit-color"
              value={o.color}
              onCommit={(v) => send('maps/updateLight', { mapId, lightId: o.id, patch: { color: v } }).catch(quiet)}
            />
          </div>
          {del}
        </div>
      );
    }
    if (sel.type === 'region') {
      const o = selected as MapRegion;
      const labels: Record<string, string> = { x: 'X', y: 'Y', w: t('Width'), h: t('Height') };
      return (
        <div className="mapedit-inspector">
          {head(t('Area'))}
          <Field label={t('Name')}>
            <TextInput value={o.name} onChange={(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { name: v } }).catch(quiet)} />
          </Field>
          <div className="row spread">
            <span className="small muted">{t('Color')}</span>
            <CommitInput
              type="color"
              className="mapedit-color"
              value={o.color || '#e0468f'}
              onCommit={(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { color: v } }).catch(quiet)}
            />
          </div>
          <Toggle label={t('fem::GM only')} value={o.gmOnly} onChange={(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { gmOnly: v } }).catch(quiet)} />
          <div className="grid-2">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <NumField key={k} label={labels[k]}>
                <NumberInput
                  small
                  value={o[k]}
                  min={k === 'w' || k === 'h' ? 1 : 0}
                  max={k === 'x' || k === 'w' ? map.width : map.height}
                  onChange={(v) => send('maps/updateRegion', { mapId, regionId: o.id, patch: { [k]: v } }).catch(quiet)}
                />
              </NumField>
            ))}
          </div>
          {del}
        </div>
      );
    }
    if (sel.type === 'note') {
      const o = selected as MapNote;
      return (
        <div className="mapedit-inspector">
          {head(t('GM note ({x}, {y})', { x: o.x, y: o.y }))}
          <TextInput multiline rows={5} value={o.text} onChange={(v) => send('maps/updateNote', { mapId, noteId: o.id, patch: { text: v } }).catch(quiet)} />
          {del}
        </div>
      );
    }
    if (sel.type === 'token') {
      const o = selected as Token;
      const actor = o.actorId ? game.actors?.[o.actorId] : null;
      const tp = (patch: Record<string, unknown>) => send('maps/updateToken', { mapId, tokenId: o.id, patch }).catch(quiet);
      return (
        <div className="mapedit-inspector">
          {head(t('Token'))}
          <Field label={t('Name')}>
            <TextInput value={o.name} onChange={(v) => tp({ name: v })} />
          </Field>
          {actor && (
            <div className="row spread">
              <span className="small muted">{t('Sheet: {name}', { name: actor.name })}</span>
              <Button small variant="ghost" onClick={() => openSheet(actor.id)}>
                {t('Open')}
              </Button>
            </div>
          )}
          <Field label={t('Disposition')}>
            <Select value={o.disposition} options={tr(DISPO_OPTIONS)} onChange={(v) => tp({ disposition: v })} />
          </Field>
          <Toggle label={t('Hidden from players')} value={o.hidden} onChange={(v) => tp({ hidden: v })} />
          <div className="row spread">
            <span className="small muted">{t('Color')}</span>
            <CommitInput type="color" className="mapedit-color" value={o.color || actor?.color || '#2a3340'} onCommit={(v) => tp({ color: v })} />
          </div>
          <div className="row spread">
            <span className="small muted">{t('Size (cells)')}</span>
            <NumberInput small value={o.size || 1} min={1} max={4} onChange={(v) => tp({ size: v })} />
          </div>
          <div className="row spread">
            <span className="small muted">{t('Light (radius)')}</span>
            <NumberInput small value={o.light?.radius || 0} min={0} max={30} onChange={(v) => tp({ light: v ? { radius: v, color: o.light?.color || '#fff1cc' } : null })} />
          </div>
          <div className="row spread">
            <span className="small muted">{t('Darkvision range')}</span>
            <NumberInput small value={o.vision?.darkRange ?? 0} min={0} max={40} onChange={(v) => tp({ vision: { ...(o.vision || {}), darkRange: v } })} />
          </div>
          <div className="row wrap">
            <Toggle label={t('Low-Light Vision')} value={!!o.vision?.lowLight} onChange={(v) => tp({ vision: { ...(o.vision || {}), lowLight: v } })} />
            <Toggle label={t('Thermo')} value={!!o.vision?.thermo} onChange={(v) => tp({ vision: { ...(o.vision || {}), thermo: v } })} />
          </div>
          {del}
        </div>
      );
    }
    return null;
  };

  const objectList = <O extends { id: string; x: number; y: number; w?: number; h?: number }>(label: string, list: O[], type: ObjType, render: (o: O) => ReactNode) =>
    list.length ? (
      <div className="mapedit-section">
        <h5>{t('{label} ({n})', { label, n: list.length })}</h5>
        <div className="mapedit-list">
          {list.map((o) => (
            <button
              key={o.id}
              className={sel?.id === o.id ? 'on' : ''}
              onClick={() => {
                setSel({ type, id: o.id });
                centerOn(o);
              }}
            >
              {render(o)}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <div className={'mapedit' + (panel.tools ? ' tools-open' : '') + (panel.props ? ' props-open' : '')}>
      <header className="mapedit-head">
        <Button
          small
          variant="ghost"
          onClick={async () => {
            await flush();
            onBack();
          }}
        >
          ← {t('Maps')}
        </Button>
        <h2 title={map.name}>{map.name}</h2>
        <span className={'mapedit-save ' + saveState} title={t('Tiles and walls are saved automatically (Ctrl+S to force)')}>
          {saveLabel}
        </span>
        <IconButton icon="↶" title={t('Undo (Ctrl+Z)')} disabled={!undoRef.current.length} onClick={undo} />
        <IconButton icon="↷" title={t('Redo (Ctrl+Y)')} disabled={!redoRef.current.length} onClick={redo} />
        <span className="grow"></span>
        {map.library && (
          <Button small variant="ghost" title={t('Update from the library or publish your fixes to it')} onClick={() => setLibOpen(true)}>
            {t('Library…')}
          </Button>
        )}
        {shown ? (
          <Badge color="green">● {t('Shown to players')}</Badge>
        ) : (
          <Button small variant="accent" onClick={() => send('maps/setActive', { mapId }).then(() => toast(t('Map shown to players'), 'success'), quiet)}>
            {t('Show to players')}
          </Button>
        )}
        <Button
          small
          onClick={async () => {
            await flush();
            setUI({ viewMapId: mapId, mainTab: 'map' });
          }}
        >
          {t('View in play')}
        </Button>
        <IconButton icon="⌖" title={t('Re-center')} onClick={() => rRef.current?.fit()} />
        <Button small className="mapedit-mobile-tabs" onClick={() => setPanel({ tools: !panel.tools, props: false })}>
          {t('Tools')}
        </Button>
        <Button small className="mapedit-mobile-tabs" onClick={() => setPanel({ props: !panel.props, tools: false })}>
          {t('Properties')}
        </Button>
      </header>
      {libOpen && map.library && <LibraryLinkModal map={map} beforeAction={flush} onClose={() => setLibOpen(false)} />}

      <aside className="mapedit-tools">
        <div className="mapedit-section">
          <h5>{t('Tools')}</h5>
          <div className="mapedit-toolgrid">
            {TOOLS.map((tt) => (
              <button key={tt.id} className={'mapedit-tool' + (tool === tt.id ? ' active' : '')} title={`${t(tt.label)} (${tt.key.toUpperCase()})`} onClick={() => setTool(tt.id)}>
                <span>{tt.icon}</span>
                <span>{t(tt.label)}</span>
              </button>
            ))}
          </div>
          <div className="mapedit-help">{TOOL_HELP[tool] ? t(TOOL_HELP[tool]) : ''}</div>
        </div>
        {toolOptions()}
        <div className="mapedit-section">
          <h5>{t('Tiles')}</h5>
          <div className="mapedit-palette">
            {PALETTE.map((ch) => (
              <button
                key={ch}
                className={'mapedit-tile' + (tile === ch && PAINT.has(tool) && tool !== 'eraser' ? ' active' : '')}
                title={`${tileLabel(ch)}${TILES[ch].blockMove ? ' · ' + t('blocks movement') : ''}${TILES[ch].blockSight ? ' · ' + t('blocks sight') : ''}`}
                onClick={() => {
                  setTile(ch);
                  if (!PAINT.has(tool) || tool === 'eraser') setTool('brush');
                }}
              >
                <img src={tileSwatch(ch, map.theme, 30)} alt="" />
                <span>{tileLabel(ch)}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <div className="mapedit-canvas">
        <MapCanvas rendererRef={rRef} scene={scene} handlers={handlers} />
      </div>

      <aside className="mapedit-props">
        {inspector()}
        <div className="mapedit-section">
          <h5>{t('Map')}</h5>
          <Field label={t('Name')}>
            <TextInput value={map.name} onChange={(v) => upd({ name: v })} />
          </Field>
          <Field label={t('Folder')}>
            <TextInput value={map.folder || ''} placeholder={t('e.g. Act 2')} onChange={(v) => upd({ folder: v })} />
          </Field>
          <div className="grid-2">
            <Field label={t('map::Theme')}>
              <Select value={map.theme || 'street'} options={themeOptions()} onChange={(v) => upd({ theme: v })} />
            </Field>
            <Field label={t('Lighting')}>
              <Select value={map.lighting || 'bright'} options={lightingOptions()} onChange={(v) => upd({ lighting: v })} />
            </Field>
          </div>
          <Toggle label={t('Fog of war')} value={map.fog !== false} onChange={(v) => upd({ fog: v })} />
          <Toggle label={t('Shared party vision')} value={map.sharedVision !== false} onChange={(v) => upd({ sharedVision: v })} />
          <div className="row spread">
            <span className="small muted">{t('Meters per cell')}</span>
            <NumberInput small value={map.metersPerCell || 1} min={0.5} max={20} step={0.5} onChange={(v) => upd({ metersPerCell: v })} />
          </div>
          <Field label={t('Description (GM)')}>
            <TextInput multiline rows={3} value={map.description || ''} placeholder={t('Scene notes, NPCs present, traps…')} onChange={(v) => upd({ description: v })} />
          </Field>
        </div>
        <div className="mapedit-section">
          <h5>{t('Background image')}</h5>
          <Field label={t("Image URL")}>
            <TextInput value={bg?.url || ''} placeholder={t('/assets/… or https://…')} onChange={(v) => (v.trim() ? setBg({ url: v.trim() }) : upd({ background: null }))} />
          </Field>
          <div className="row wrap">
            <label className="btn btn-sm">
              {bg?.url ? t('Replace…') : t('Import an image…')}
              <input type="file" accept="image/*" hidden onChange={onBg} />
            </label>
            {bg?.url && (
              <Button small variant="danger" onClick={() => upd({ background: null })}>
                {t('Remove')}
              </Button>
            )}
          </div>
          {bg?.url && (
            <div className="col">
              <Field label={t('Mode')}>
                <Select
                  value={bg.mode || 'underlay'}
                  options={tr(BG_MODES)}
                  onChange={(v) => setBg({ mode: v as MapBackground['mode'], ...(v === 'image' && (bg.opacity ?? 0.6) < 1 ? { opacity: 1 } : {}) })}
                />
              </Field>
              <span className="small muted">
                {bg.mode === 'image'
                  ? t('The image is the floor: tiles are no longer drawn (they still drive movement and vision). Draw the walls as segments.')
                  : t('Tiles are drawn and the image is blended according to its opacity.')}
              </span>
              <span className="small muted">{t('Opacity {n}%', { n: Math.round((bg.opacity ?? 0.6) * 100) })}</span>
              <CommitInput type="range" className="mapedit-range" min="0" max="1" step="0.05" value={bg.opacity ?? 0.6} onCommit={(v) => setBg({ opacity: Number(v) })} />
              <div className="grid-2">
                {(
                  [
                    ['x', tk('X (cells)')],
                    ['y', tk('Y (cells)')],
                    ['w', tk('Width')],
                    ['h', tk('Height')],
                  ] as const
                ).map(([k, label]) => (
                  <NumField key={k} label={t(label)}>
                    <NumberInput
                      small
                      value={bg[k] ?? (k === 'w' ? map.width : k === 'h' ? map.height : 0)}
                      step={0.5}
                      min={k === 'w' || k === 'h' ? 0.5 : -640}
                      max={640}
                      onChange={(v) => setBg({ [k]: v })}
                    />
                  </NumField>
                ))}
              </div>
              <div className="row wrap">
                <Button small onClick={fitBg} title={t("Stretch the image over the whole map")}>
                  {t('Fit to map')}
                </Button>
                <Button small variant="ghost" onClick={bgAspect} title={t("Recompute the height to keep the image's proportions")}>
                  {t("Image proportions")}
                </Button>
              </div>
              {bg.mode === 'image' && (
                <Button small variant="ghost" onClick={fillInterior} title={t("Every cell becomes floor “.” (illustrated maps only use segment walls)")}>
                  {t("Fill the interior")}
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="mapedit-section">
          <h5>{t('Segment walls ({n})', { n: wallsRef.current.length })}</h5>
          <span className="small muted">
            {t('{walls} wall(s) · {windows} window(s) · {curtains} curtain(s) · {doors} door(s) · {secrets} secret', {
              walls: wallStats.wall,
              windows: wallStats.window,
              curtains: wallStats.curtain,
              doors: wallStats.door,
              secrets: wallStats.secret,
            })}
          </span>
          <div className="row wrap">
            <Button small onClick={() => setTool('wall')}>
              {t('Draw walls')}
            </Button>
            {wallsRef.current.length > 0 && (
              <Button small variant="ghost" onClick={() => setWallSel(wallsRef.current.filter((w) => w.door).map((w) => w.id))}>
                {t('Select the doors')}
              </Button>
            )}
            {wallsRef.current.length > 0 && (
              <Button
                small
                variant="ghost"
                onClick={async () => {
                  if (await confirmAction(t('Delete the {n} segment walls? (Ctrl+Z to undo)', { n: wallsRef.current.length }))) deleteWalls(wallsRef.current.map((w) => w.id));
                }}
              >
                {t('Delete all')}
              </Button>
            )}
          </div>
        </div>
        <div className="mapedit-section">
          <h5>{t('Size ({w} × {h})', { w: map.width, h: map.height })}</h5>
          <div className="grid-2">
            <NumField label={t('Width')}>
              <NumberInput small value={resize.width} min={4} max={160} onChange={(v) => setResize({ ...resize, width: v })} />
            </NumField>
            <NumField label={t('Height')}>
              <NumberInput small value={resize.height} min={4} max={160} onChange={(v) => setResize({ ...resize, height: v })} />
            </NumField>
          </div>
          <Field label={t('Content anchor')}>
            <Select value={resize.anchor} options={tr(ANCHORS)} onChange={(v) => setResize({ ...resize, anchor: v })} />
          </Field>
          <Button small disabled={resize.width === map.width && resize.height === map.height} onClick={doResize}>
            {t('Resize')}
          </Button>
        </div>
        {objectList(t('Tokens'), map.tokens || [], 'token', (o) => (
          <>
            <span className="mapedit-swatch" style={{ background: DISPO[o.disposition]?.color }}></span>
            {o.hidden ? t('{name} (hidden)', { name: o.name }) : o.name}
          </>
        ))}
        {objectList(t('Doors'), map.doors || [], 'door', (o) => (
          <>
            <span className="mapedit-swatch" style={{ background: o.kind === 'secret' ? '#e0468f' : o.state === 'open' ? '#4fd17a' : '#e0a63f' }}></span>
            {o.name || t(DOOR_KINDS.find((k) => k.value === o.kind)?.label || '')} · {t(DOOR_STATES.find((s) => s.value === o.state)?.label || '').toLowerCase()}
          </>
        ))}
        {objectList(t('Lights'), map.lights || [], 'light', (o) => (
          <>
            <span className="mapedit-swatch" style={{ background: o.on !== false ? o.color : 'transparent' }}></span>
            {t('Radius {r} · ({x}, {y})', { r: o.radius, x: o.x, y: o.y })}
          </>
        ))}
        {objectList(t('Areas'), map.regions || [], 'region', (o) => (
          <>
            <span className="mapedit-swatch" style={{ background: o.gmOnly ? '#e0468f' : o.color || '#e0468f' }}></span>
            {o.gmOnly ? t('{name} (GM)', { name: o.name }) : o.name}
          </>
        ))}
        {objectList(t('GM notes'), map.notes || [], 'note', (o) => (
          <>
            <span className="mapedit-swatch" style={{ background: '#e0a63f' }}></span>
            {o.text.slice(0, 40)}
          </>
        ))}
        <div className="mapedit-section">
          <h5>{t('Fog')}</h5>
          <Button
            small
            variant="ghost"
            onClick={async () => {
              if (await confirmAction(t('Clear the fog memory for every player?'))) send('maps/resetFog', { mapId }).then(() => toast(t('Fog reset')), quiet);
            }}
          >
            {t('Reset the fog')}
          </Button>
        </div>
      </aside>
    </div>
  );
}
