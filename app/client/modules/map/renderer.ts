// Canvas 2D map renderer (neon cyberpunk style). One instance per <canvas>, never recreated on state updates.
// World unit = 1 cell. view = { scale (CSS px per cell), x, y (CSS px offset of cell 0,0) }.
// Static tiles are pre-rendered once into an offscreen canvas; lights / fog are small low-res layers
// upscaled with smoothing (soft edges for free). Tokens, doors, overlays are drawn every frame.
// Image maps (background.mode === 'image', e.g. Foundry imports): the artwork is the floor, no tile art;
// segment walls are drawn for the GM only (toggle), segment doors for everyone as clickable icons.
import { buildGrid, lineOfSightMask, mapLights, wallIsDoor, wallMidpoint, pointSegmentDistance } from '/shared/vision.ts';
import { derive } from '/shared/sr5.ts';
import { t, tk, tIfKnown } from '../../lib/i18n.ts';
import { isLibUrl, ensureLibKey, signedUrl } from './maplib-client.ts';
import { drawDetailedMap } from './tileart.ts';
import type { GameMap, Token, MapWall, MapDoor, MapBackground, Lighting, ViewActor, ViewMe, Role } from '../../../shared/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** [x, y] cell. */
export type Cell = [number, number];
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Colours of a map theme (THEMES). */
export interface ThemeColors {
  label: string;
  floor: string;
  ext: string;
  wall: string;
  wallTop: string;
  glow: string;
  accent: string;
  wood: string;
  metal: string;
  carpet: string;
  fabric: string;
  grid?: string;
}
/** What the tile painters need of a map (drawStaticMap also gets small synthetic maps: swatches, home plans). */
export interface TileMap {
  width: number;
  height: number;
  tiles: string[];
  theme?: string;
}
export type TileStyle = 'detailed' | 'classic';
/** 'wall' (blocks both) | 'window' (move only) | 'curtain' (sight only) | 'ethereal' (nothing) */
export type WallKind = 'wall' | 'window' | 'curtain' | 'ethereal';
/** Pan / zoom: CSS px per cell and CSS px offset of cell 0,0. */
export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}
/** Fog of war bit masks (one byte per cell). */
export interface FogMasks {
  visible: Uint8Array | null;
  explored: Uint8Array | null;
}
/** Blast marker of scene.combatMarks (attacks module): landing cell, reach in metres, tokens caught. */
export interface CombatBlastMark {
  x: number;
  y: number;
  reach?: number;
  effect?: string | null;
  dv?: number | null;
  type?: string;
  radius?: number | null;
  falloff?: number | null;
  aim?: Point | null;
  hits?: Array<{ tokenId: string; dv: number }>;
  label?: string | null;
}
/** Attack line (attacker token → target token). */
export interface CombatLineMark {
  from: string;
  to: string;
  color?: string;
  dashed?: boolean;
  label?: string | null;
}
export interface CombatMarks {
  blasts?: CombatBlastMark[];
  lines?: CombatLineMark[];
  targetTokenId?: string | null;
  targetLabel?: string | null;
  aim?: Point | null;
  aimLabel?: string | null;
  /** Metres. */
  aimReach?: number;
}
/** Everything the renderer draws (MapRenderer.setScene). */
export interface MapScene {
  map: GameMap | null;
  actors?: Record<string, ViewActor>;
  role?: Role;
  me?: ViewMe | null;
  selected?: Set<string>;
  turnTokenId?: string | null;
  /** GM overlay: lights, notes, secret doors, segment walls. */
  gmLayer?: boolean;
  editor?: boolean;
  fog?: FogMasks | null;
  /** GM: cells no PC sees (tinted). */
  unseen?: Uint8Array | null;
  /** Hide tokens outside these cells. */
  tokenMask?: Uint8Array | null;
  hideHidden?: boolean;
  darkFactor?: number;
  showWalls?: boolean;
  showGrid?: boolean;
  barsFor?: (tok: Token, actor: ViewActor) => boolean;
  combatMarks?: CombatMarks | null;
}
/** Transient drawing on top of the scene (editor previews, drag ghosts, path…). Cells in world units, box in screen px. */
export interface MapOverlay {
  cells?: Point[];
  cellsColor?: string;
  rect?: Rect;
  rectColor?: string;
  hoverCell?: Point | null;
  hoverColor?: string;
  path?: Point[] | null;
  pathColor?: string;
  pathLabel?: string | null;
  labelAt?: Point;
  ghosts?: Array<{ token: Token; x: number; y: number }>;
  hideTokenIds?: Set<string>;
  box?: Rect;
  selectedLightId?: string;
  selectedWallIds?: Set<string>;
  hoverWallId?: string | null;
  segment?: { x1: number; y1: number; x2: number; y2: number; color?: string; dashed?: boolean };
  snap?: Point | null;
  animate?: boolean;
}
export interface MapPing {
  x: number;
  y: number;
  name?: string;
  color?: string;
}
interface ImageEntry {
  img: HTMLImageElement;
  ok: boolean;
  failed: boolean;
  waiters: Set<(img: HTMLImageElement) => void>;
}
interface TokenAnim {
  pts: number[][];
  len: number;
  start: number;
  dur: number;
}
/** Cache keys of the layers below. */
interface RendererKeys {
  static?: string | null;
  ver?: number | null;
  light?: string | null;
  fogObj?: FogMasks | null;
  unseenObj?: Uint8Array | null;
  tileHint?: string;
}
interface RendererLayers {
  static?: HTMLCanvasElement | null;
  glow?: HTMLCanvasElement | null;
  dark?: HTMLCanvasElement | null;
  fogSat?: HTMLCanvasElement | null;
  fogDark?: HTMLCanvasElement | null;
  unseen?: HTMLCanvasElement | null;
  tileHint?: HTMLCanvasElement | null;
}

// ---------------------------------------------------------------------------
// Shared image cache (backgrounds, portraits): each url loads once for every renderer / thumbnail.
// ---------------------------------------------------------------------------
const IMAGE_CACHE = new Map<string, ImageEntry>(); // url -> { img, ok, failed, waiters: Set<fn> }
const LIVE_RENDERERS = new Set<MapRenderer>();
/** Cached HTMLImageElement once loaded (null while loading / failed). onLoad is called once when it arrives. */
export function getImage(url: string | null | undefined, onLoad: ((img: HTMLImageElement) => void) | null = null): HTMLImageElement | null {
  if (!url) return null;
  let e = IMAGE_CACHE.get(url);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, failed: false, waiters: new Set<(img: HTMLImageElement) => void>() };
    const entry = e;
    img.decoding = 'async';
    img.onload = () => {
      entry.ok = true;
      for (const r of LIVE_RENDERERS) r.dirty = true;
      for (const f of entry.waiters) {
        try { f(img); } catch {}
      }
      entry.waiters.clear();
    };
    const fail = () => {
      entry.failed = true;
      for (const r of LIVE_RENDERERS) r.dirty = true;
      entry.waiters.clear();
    };
    img.onerror = fail;
    // Library images (/api/maplib/image/<slug>) need the signed key: cached under the bare URL, loaded once the key is known.
    if (isLibUrl(url)) ensureLibKey().then((k: string | null) => (k ? (img.src = signedUrl(url, k)!) : fail()));
    else img.src = url;
    IMAGE_CACHE.set(url, e);
  }
  if (!e.ok && !e.failed && onLoad) e.waiters.add(onLoad);
  return e.ok ? e.img : null;
}
/** 'ok' | 'loading' | 'failed' | null */
export function imageStatus(url: string | null | undefined): 'ok' | 'loading' | 'failed' | null {
  const e = url ? IMAGE_CACHE.get(url) : null;
  return !e ? null : e.ok ? 'ok' : e.failed ? 'failed' : 'loading';
}
export const isImageMap = (map: { background?: MapBackground } | null | undefined): boolean => !!(map?.background?.url && map.background.mode === 'image');

/** Segment door colours by state (secret = GM only). */
export const DOOR_SEG_COLORS: Record<string, string> = { open: '#4fd17a', closed: '#e0a63f', locked: '#e05c5c', secret: '#e0468f' };
const WALL_COLORS: Record<string, string> = { wall: '#3fd6d0', window: '#5cc8ff', curtain: '#9d7ce0', ethereal: '#8a96a6' };
/** 'wall' (blocks both) | 'window' (move only) | 'curtain' (sight only) | 'ethereal' (nothing) */
export function wallKind(w: { move?: boolean; sight?: boolean }): WallKind {
  const m = w.move !== false, s = w.sight !== false;
  return m && s ? 'wall' : m ? 'window' : s ? 'curtain' : 'ethereal';
}
/** Signature of everything in walls that affects light / sight (cache keys). */
export function wallsKey(map: { walls?: MapWall[] }): string {
  let s = '';
  for (const w of map.walls || []) s += `${w.x1},${w.y1},${w.x2},${w.y2},${w.move === false ? 0 : 1}${w.sight === false ? 0 : 1}${w.door ? w.door.state[0] : ''};`;
  return s;
}

export const THEMES: Record<string, ThemeColors> = {
  street: { label: tk('Street'), floor: '#1b2027', ext: '#15181d', wall: '#2a303a', wallTop: '#343b47', glow: '#3fd6d0', accent: '#e0468f', wood: '#4a3a2c', metal: '#3b4451', carpet: '#33203a', fabric: '#3a3550' },
  bar: { label: tk('Bar'), floor: '#231a19', ext: '#17171a', wall: '#33262a', wallTop: '#3e2e33', glow: '#e0a63f', accent: '#e0468f', wood: '#5b3d25', metal: '#463a3a', carpet: '#4a1830', fabric: '#4a2430' },
  corp: { label: tk('Corp'), floor: '#1c232c', ext: '#161a20', wall: '#2c3846', wallTop: '#374657', glow: '#5c9be0', accent: '#3fd6d0', wood: '#3e4754', metal: '#47535f', carpet: '#1f3048', fabric: '#2b3a55' },
  lab: { label: tk('Lab'), floor: '#1d2527', ext: '#151a1b', wall: '#2c3b3e', wallTop: '#36494c', glow: '#4fd17a', accent: '#3fd6d0', wood: '#3a4949', metal: '#4b5b5d', carpet: '#1d3a33', fabric: '#2c4a44' },
  industrial: { label: tk('Industrial'), floor: '#201e1a', ext: '#181715', wall: '#36322b', wallTop: '#423d34', glow: '#e0a63f', accent: '#e05c5c', wood: '#4d3b25', metal: '#4a463e', carpet: '#3a2a18', fabric: '#44382a' },
  residential: { label: tk('Residential'), floor: '#221d1b', ext: '#171615', wall: '#362e2a', wallTop: '#433832', glow: '#e0a63f', accent: '#9d7ce0', wood: '#5a4030', metal: '#4a4440', carpet: '#3a2440', fabric: '#4a3a5a' },
  matrix: { label: tk('Matrix'), floor: '#08151a', ext: '#061014', wall: '#0f2b33', wallTop: '#14404a', glow: '#3fd6d0', accent: '#4fd17a', wood: '#123a40', metal: '#14404a', carpet: '#0a2a2a', fabric: '#0f3a3a', grid: 'rgba(63,214,208,0.16)' },
  club: { label: tk('Club'), floor: '#170f1d', ext: '#120d16', wall: '#2a1832', wallTop: '#35203f', glow: '#e0468f', accent: '#9d7ce0', wood: '#3a2040', metal: '#3a2a48', carpet: '#3a1040', fabric: '#4a1e52' },
};
// Labels below are French keys: render them with t() (or use the *Options() / *Label() helpers).
export const THEME_OPTIONS = Object.entries(THEMES).map(([value, th]) => ({ value, label: th.label }));
export const LIGHTING_OPTIONS: Array<{ value: Lighting; label: string }> = [
  { value: 'bright', label: tk('Daylight') },
  { value: 'dim', label: tk('Dim') },
  { value: 'dark', label: tk('Darkness') },
];
/** Select options in the UI language (call at render time). */
export const themeOptions = () => THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }));
export const lightingOptions = () => LIGHTING_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }));
export const themeLabel = (k: string | null | undefined): string => (k && THEMES[k] ? t(THEMES[k].label) : k || '');
export const lightingLabel = (k: string | null | undefined): string => {
  const o = LIGHTING_OPTIONS.find((x) => x.value === k);
  return o ? t(o.label) : k || '';
};
export const DISPO: Record<string, { color: string; label: string }> = {
  pc: { color: '#3fd6d0', label: tk('PC') },
  ally: { color: '#4fd17a', label: tk('Ally') },
  neutral: { color: '#e0a63f', label: tk('Neutral') },
  hostile: { color: '#e05c5c', label: tk('Hostile') },
};
/** Token disposition label in the UI language. */
export const dispoLabel = (k: string | null | undefined): string => (k && DISPO[k] ? t(DISPO[k].label) : '');
/** Flat colours per tile (thumbnails, palette fallback). */
export const TILE_FLAT: Record<string, string> = {
  ' ': '#05070a', '.': '#2a323c', ',': '#20242b', '#': '#56606e', D: '#3fd6d0', W: '#5cc8ff', '=': '#7a5a3a', T: '#6b5038',
  c: '#7a5f35', o: '#6a7482', m: '#2f3a48', v: '#4a5a70', b: '#5a4a72', s: '#4a5560', e: '#5a6778', '~': '#1d4f6a',
  g: '#24452c', r: '#4a4f57', x: '#b0702a', t: '#1f4a28', _: '#5a2a5a',
};
export const STATUS_GLYPHS: Record<string, string> = { 'à terre': '↧', inconscient: 'z', mort: '✝', étourdi: '✶', 'en feu': '♨', aveuglé: '◌', 'à couvert': '▣', caché: '◐', paniqué: '!', saignement: '♦', entravé: '⛓' };
// Token statuses are stored in French (keys above); these markers give the checker their dictionary keys.
export const STATUS_KEYS = [tk('prone'), tk('unconscious'), tk('dead'), tk('stunned'), tk('on fire'), tk('blinded'), tk('in cover'), tk('hidden'), tk('panicked'), tk('bleeding'), tk('restrained')];
/** Stored token status ('à terre'…) in the UI language (custom statuses unchanged). */
export const statusText = (s: unknown): string => tIfKnown(String(s ?? ''));

const EMPTY = new Set([' ']);
const OPEN_FOR_GLOW = (ch: string) => ch !== '#' && ch !== ' ';

function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function hexToRgb(hex: string | null | undefined): number[] {
  let h = String(hex || '#ffffff').replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').slice(0, 3).map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** Rounded rect path with per-corner radii [tl, tr, br, bl]. */
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]): void {
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export function initials(name: string | null | undefined): string {
  const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1];
  return (parts[0][0] + (/^\d+$/.test(last) ? last : last[0])).toUpperCase().slice(0, 3);
}

// ---------------------------------------------------------------------------
// Static tile layer
// ---------------------------------------------------------------------------
export function staticCellPx(w: number, h: number): number {
  return Math.max(8, Math.min(48, Math.floor(2880 / Math.max(w, h, 1))));
}

/** Door orientation: true = slab runs horizontally (walls on left & right). */
function doorHorizontal(T: (x: number, y: number) => string, x: number, y: number): boolean {
  const solid = (ch: string) => ch === '#' || ch === 'W' || ch === 'D' || ch === 'o' || ch === 'm';
  const lr = (solid(T(x - 1, y)) ? 1 : 0) + (solid(T(x + 1, y)) ? 1 : 0);
  const ud = (solid(T(x, y - 1)) ? 1 : 0) + (solid(T(x, y + 1)) ? 1 : 0);
  return lr >= ud;
}

// Tile art style, per browser: 'detailed' (textured floors, furniture as objects — tileart.js) or 'classic'.
const TILE_STYLE_KEY = 'sr.map.tileStyle';
export function getTileStyle(): TileStyle {
  try {
    return localStorage.getItem(TILE_STYLE_KEY) === 'classic' ? 'classic' : 'detailed';
  } catch {
    return 'detailed';
  }
}
export function setTileStyle(style: string): void {
  try {
    localStorage.setItem(TILE_STYLE_KEY, style === 'classic' ? 'classic' : 'detailed');
  } catch {}
  tileSwatchCache.clear();
  for (const r of LIVE_RENDERERS) {
    r.keys.static = null;
    r.keys.ver = null;
    r.dirty = true;
  }
}

/**
 * Draw every tile of the map into ctx (current transform = pixels; S = pixels per cell).
 * Returns the list of machinery cells (for animated LEDs).
 */
export function drawStaticMap(ctx: CanvasRenderingContext2D, map: TileMap, S: number, style: string = getTileStyle()): Cell[] {
  const th = THEMES[map.theme ?? ''] || THEMES.street;
  if (style !== 'classic') return drawDetailedMap(ctx, map, S, th, map.theme && THEMES[map.theme] ? map.theme : 'street');
  const w = map.width, h = map.height;
  const T = (x: number, y: number): string => (x < 0 || y < 0 || x >= w || y >= h ? ' ' : (map.tiles[y] || '')[x] ?? ' ');
  const machinery: Cell[] = [];
  ctx.save();
  ctx.scale(S, S);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const px = 1 / S;
  const outdoorish = (ch: string) => ch === ',' || ch === 'g' || ch === 't' || ch === '~';
  const groundOf = (x: number, y: number) => {
    let o = 0, i = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = T(x + dx, y + dy);
      if (outdoorish(c)) o++;
      else if (c === '.' || c === '_') i++;
    }
    return o > i ? th.ext : th.floor;
  };

  // Pass 1: ground
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (EMPTY.has(ch)) continue;
      let base;
      if (ch === '#') base = th.wall;
      else if (ch === '.') base = th.floor;
      else if (ch === ',') base = th.ext;
      else if (ch === 'g' || ch === 't') base = '#132619';
      else if (ch === '~') base = '#0a2130';
      else if (ch === '_') base = th.carpet;
      else base = groundOf(x, y);
      ctx.fillStyle = base;
      ctx.fillRect(x, y, 1 + px, 1 + px);
      const n = hash(x, y) - 0.5;
      if (ch !== '#') {
        ctx.fillStyle = n > 0 ? `rgba(255,255,255,${n * 0.045})` : `rgba(0,0,0,${-n * 0.12})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // Pass 2: features
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      const same = (dx: number, dy: number) => T(x + dx, y + dy) === ch;
      const conn = (inset: number, rad: number) => {
        const l = same(-1, 0) ? 0 : inset, r = same(1, 0) ? 0 : inset, t = same(0, -1) ? 0 : inset, b = same(0, 1) ? 0 : inset;
        const R = [!l || !t ? 0 : rad, !r || !t ? 0 : rad, !r || !b ? 0 : rad, !l || !b ? 0 : rad];
        return { l, r, t, b, R, x0: x + l, y0: y + t, w: 1 - l - r, h: 1 - t - b };
      };
      switch (ch) {
        case ',': {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          for (let k = 0; k < 3; k++) ctx.fillRect(x + hash(x, y, k) * 0.9, y + hash(x, y, k + 7) * 0.9, 0.05, 0.05);
          if (hash(x, y, 99) > 0.93) {
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.beginPath();
            ctx.ellipse(x + 0.5, y + 0.5, 0.3, 0.18, hash(x, y, 3) * 3, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case '_': {
          ctx.strokeStyle = rgba(th.accent, 0.45);
          ctx.lineWidth = 0.06;
          ctx.beginPath();
          if (!same(0, -1)) { ctx.moveTo(x, y + 0.1); ctx.lineTo(x + 1, y + 0.1); }
          if (!same(0, 1)) { ctx.moveTo(x, y + 0.9); ctx.lineTo(x + 1, y + 0.9); }
          if (!same(-1, 0)) { ctx.moveTo(x + 0.1, y); ctx.lineTo(x + 0.1, y + 1); }
          if (!same(1, 0)) { ctx.moveTo(x + 0.9, y); ctx.lineTo(x + 0.9, y + 1); }
          ctx.stroke();
          ctx.fillStyle = rgba(th.accent, 0.12);
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y + 0.3); ctx.lineTo(x + 0.7, y + 0.5); ctx.lineTo(x + 0.5, y + 0.7); ctx.lineTo(x + 0.3, y + 0.5);
          ctx.fill();
          break;
        }
        case 'g': {
          ctx.strokeStyle = '#2a5534';
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            const gx = x + 0.15 + hash(x, y, k) * 0.7, gy = y + 0.25 + hash(x, y, k + 9) * 0.65;
            ctx.moveTo(gx, gy); ctx.lineTo(gx - 0.06, gy - 0.16);
            ctx.moveTo(gx, gy); ctx.lineTo(gx + 0.06, gy - 0.15);
          }
          ctx.stroke();
          break;
        }
        case '~': {
          ctx.strokeStyle = 'rgba(92,200,255,0.22)';
          ctx.lineWidth = 0.045;
          ctx.beginPath();
          for (let k = 0; k < 2; k++) {
            const wy = y + 0.3 + k * 0.4 + (hash(x, y, k) - 0.5) * 0.1;
            ctx.moveTo(x + 0.1, wy);
            ctx.quadraticCurveTo(x + 0.3, wy - 0.1, x + 0.5, wy);
            ctx.quadraticCurveTo(x + 0.7, wy + 0.1, x + 0.9, wy);
          }
          ctx.stroke();
          break;
        }
        case 'r': {
          for (let k = 0; k < 4; k++) {
            const rx = x + 0.12 + hash(x, y, k) * 0.7, ry = y + 0.12 + hash(x, y, k + 5) * 0.7, s = 0.1 + hash(x, y, k + 11) * 0.14;
            ctx.fillStyle = k % 2 ? '#4a5059' : '#363b43';
            ctx.beginPath();
            ctx.moveTo(rx, ry); ctx.lineTo(rx + s, ry + s * 0.3); ctx.lineTo(rx + s * 0.7, ry + s); ctx.lineTo(rx - s * 0.2, ry + s * 0.7);
            ctx.closePath();
            ctx.fill();
          }
          break;
        }
        case 'x': {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, 1, 1);
          ctx.clip();
          ctx.fillStyle = '#2a1608';
          ctx.fillRect(x, y, 1, 1);
          ctx.strokeStyle = 'rgba(224,166,63,0.6)';
          ctx.lineWidth = 0.13;
          ctx.beginPath();
          for (let k = -1; k < 4; k++) { ctx.moveTo(x + k * 0.33, y + 1); ctx.lineTo(x + k * 0.33 + 1, y); }
          ctx.stroke();
          ctx.restore();
          ctx.strokeStyle = 'rgba(224,92,92,0.55)';
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          if (!same(0, -1)) { ctx.moveTo(x, y + 0.03); ctx.lineTo(x + 1, y + 0.03); }
          if (!same(0, 1)) { ctx.moveTo(x, y + 0.97); ctx.lineTo(x + 1, y + 0.97); }
          if (!same(-1, 0)) { ctx.moveTo(x + 0.03, y); ctx.lineTo(x + 0.03, y + 1); }
          if (!same(1, 0)) { ctx.moveTo(x + 0.97, y); ctx.lineTo(x + 0.97, y + 1); }
          ctx.stroke();
          break;
        }
        case 's': {
          const horiz = (same(-1, 0) ? 1 : 0) + (same(1, 0) ? 1 : 0) >= (same(0, -1) ? 1 : 0) + (same(0, 1) ? 1 : 0);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x, y, 1, 1);
          ctx.strokeStyle = 'rgba(200,215,230,0.28)';
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          for (let k = 1; k < 5; k++) {
            if (horiz) { ctx.moveTo(x + k * 0.2, y + 0.06); ctx.lineTo(x + k * 0.2, y + 0.94); }
            else { ctx.moveTo(x + 0.06, y + k * 0.2); ctx.lineTo(x + 0.94, y + k * 0.2); }
          }
          ctx.stroke();
          break;
        }
        case 'e': {
          ctx.fillStyle = '#28303b';
          ctx.fillRect(x, y, 1, 1);
          ctx.strokeStyle = 'rgba(160,180,200,0.35)';
          ctx.lineWidth = 0.04;
          ctx.strokeRect(x + 0.08, y + 0.08, 0.84, 0.84);
          ctx.beginPath();
          ctx.moveTo(x + 0.08, y + 0.08); ctx.lineTo(x + 0.92, y + 0.92);
          ctx.moveTo(x + 0.92, y + 0.08); ctx.lineTo(x + 0.08, y + 0.92);
          ctx.strokeStyle = 'rgba(160,180,200,0.12)';
          ctx.stroke();
          break;
        }
        case '=': {
          const c = conn(0.22, 0.08);
          ctx.fillStyle = th.wood;
          ctx.beginPath(); rrect(ctx, c.x0, c.y0, c.w, c.h, c.R); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.04; ctx.stroke();
          ctx.strokeStyle = rgba(th.glow, 0.35); ctx.lineWidth = 0.035;
          ctx.beginPath(); rrect(ctx, c.x0 + 0.06, c.y0 + 0.06, c.w - 0.12, c.h - 0.12, 0.03); ctx.stroke();
          break;
        }
        case 'T': {
          const c = conn(0.14, 0.12);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath(); rrect(ctx, c.x0 + 0.05, c.y0 + 0.07, c.w, c.h, c.R); ctx.fill();
          ctx.fillStyle = th.wood;
          ctx.beginPath(); rrect(ctx, c.x0, c.y0, c.w, c.h, c.R); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.beginPath(); rrect(ctx, c.x0 + 0.05, c.y0 + 0.05, c.w - 0.1, c.h * 0.4, 0.05); ctx.fill();
          break;
        }
        case 'c': {
          const metal = hash(x, y, 4) > 0.65;
          const ins = 0.08 + hash(x, y, 6) * 0.06;
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x + ins + 0.05, y + ins + 0.06, 1 - ins * 2, 1 - ins * 2);
          ctx.fillStyle = metal ? th.metal : '#5a4528';
          ctx.fillRect(x + ins, y + ins, 1 - ins * 2, 1 - ins * 2);
          ctx.strokeStyle = metal ? 'rgba(200,220,240,0.25)' : 'rgba(30,20,10,0.8)';
          ctx.lineWidth = 0.05;
          ctx.strokeRect(x + ins, y + ins, 1 - ins * 2, 1 - ins * 2);
          ctx.beginPath();
          if (metal) { ctx.moveTo(x + ins, y + 0.5); ctx.lineTo(x + 1 - ins, y + 0.5); }
          else { ctx.moveTo(x + ins, y + ins); ctx.lineTo(x + 1 - ins, y + 1 - ins); ctx.moveTo(x + 1 - ins, y + ins); ctx.lineTo(x + ins, y + 1 - ins); }
          ctx.stroke();
          break;
        }
        case 'o': {
          ctx.fillStyle = 'rgba(0,0,0,0.4)';
          ctx.beginPath(); ctx.arc(x + 0.55, y + 0.57, 0.38, 0, Math.PI * 2); ctx.fill();
          const g = ctx.createRadialGradient(x + 0.4, y + 0.38, 0.05, x + 0.5, y + 0.5, 0.4);
          g.addColorStop(0, '#8a96a6'); g.addColorStop(1, th.wall);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.38, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = rgba(th.glow, 0.5); ctx.lineWidth = 0.04; ctx.stroke();
          break;
        }
        case 'm': {
          machinery.push([x, y]);
          const c = conn(0.05, 0.05);
          ctx.fillStyle = '#141a21';
          ctx.beginPath(); rrect(ctx, c.x0, c.y0, c.w, c.h, c.R); ctx.fill();
          ctx.strokeStyle = '#3a4656'; ctx.lineWidth = 0.04; ctx.stroke();
          ctx.strokeStyle = 'rgba(120,140,160,0.18)'; ctx.lineWidth = 0.03;
          ctx.beginPath();
          for (let k = 1; k < 5; k++) { ctx.moveTo(x + 0.15, y + k * 0.2); ctx.lineTo(x + 0.85, y + k * 0.2); }
          ctx.stroke();
          break;
        }
        case 'v': {
          const c = conn(0.07, 0.22);
          const palette = ['#5a6b82', '#7a3a4a', '#3a5a4a', '#5a5a5a', '#6a5a30', '#2a3a5a'];
          // colour by the top-left cell of the vehicle run, so a car keeps one colour
          let ox = x, oy = y;
          while (T(ox - 1, oy) === 'v') ox--;
          while (T(ox, oy - 1) === 'v') oy--;
          ctx.fillStyle = 'rgba(0,0,0,0.4)';
          ctx.beginPath(); rrect(ctx, c.x0 + 0.04, c.y0 + 0.06, c.w, c.h, c.R); ctx.fill();
          ctx.fillStyle = palette[Math.floor(hash(ox, oy, 2) * palette.length)];
          ctx.beginPath(); rrect(ctx, c.x0, c.y0, c.w, c.h, c.R); ctx.fill();
          ctx.fillStyle = 'rgba(120,200,255,0.18)';
          ctx.beginPath(); rrect(ctx, c.x0 + 0.14, c.y0 + 0.14, Math.max(0, c.w - 0.28), Math.max(0, c.h - 0.28), 0.06); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 0.03;
          ctx.beginPath(); rrect(ctx, c.x0, c.y0, c.w, c.h, c.R); ctx.stroke();
          break;
        }
        case 'b': {
          const c = conn(0.1, 0.14);
          ctx.fillStyle = th.fabric;
          ctx.beginPath(); rrect(ctx, c.x0, c.y0, c.w, c.h, c.R); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.08)';
          ctx.beginPath(); rrect(ctx, c.x0 + 0.08, c.y0 + 0.08, Math.max(0, c.w - 0.16), Math.max(0, c.h - 0.16), 0.1); ctx.fill();
          if (!same(-1, 0) && !same(0, -1)) {
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.beginPath(); rrect(ctx, x + 0.18, y + 0.18, 0.3, 0.22, 0.06); ctx.fill();
          }
          break;
        }
        case 'W': {
          const hz = doorHorizontal(T, x, y);
          ctx.fillStyle = '#0e1318';
          if (hz) ctx.fillRect(x, y + 0.32, 1, 0.36);
          else ctx.fillRect(x + 0.32, y, 0.36, 1);
          ctx.save();
          ctx.shadowColor = '#5cc8ff';
          ctx.shadowBlur = S * 0.25;
          ctx.strokeStyle = '#7fd8ff';
          ctx.lineWidth = 0.07;
          ctx.beginPath();
          if (hz) { ctx.moveTo(x, y + 0.5); ctx.lineTo(x + 1, y + 0.5); }
          else { ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + 1); }
          ctx.stroke();
          ctx.restore();
          break;
        }
        default:
          break;
      }
    }
  }

  // Trees on top of their neighbours
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== 't') continue;
      const ox = (hash(x, y, 1) - 0.5) * 0.2, oy = (hash(x, y, 2) - 0.5) * 0.2;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(x + 0.58 + ox, y + 0.62 + oy, 0.58, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#183a20';
      ctx.beginPath(); ctx.arc(x + 0.5 + ox, y + 0.5 + oy, 0.58, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#22512c';
      ctx.beginPath(); ctx.arc(x + 0.42 + ox, y + 0.42 + oy, 0.36, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(79,209,122,0.18)';
      ctx.beginPath(); ctx.arc(x + 0.36 + ox, y + 0.34 + oy, 0.14, 0, Math.PI * 2); ctx.fill();
    }

  // Walls: top bevel + glowing faces toward open cells
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== '#') continue;
      ctx.fillStyle = th.wall;
      ctx.fillRect(x, y, 1 + px, 1 + px);
      ctx.fillStyle = th.wallTop;
      const l = T(x - 1, y) === '#' ? 0 : 0.12, r = T(x + 1, y) === '#' ? 0 : 0.12, t = T(x, y - 1) === '#' ? 0 : 0.12, b = T(x, y + 1) === '#' ? 0 : 0.12;
      ctx.fillRect(x + l, y + t, 1 - l - r + px, 1 - t - b + px);
      if (hash(x, y, 8) > 0.6) {
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.lineWidth = 0.04;
        ctx.beginPath(); ctx.moveTo(x + 0.2, y + 0.8); ctx.lineTo(x + 0.8, y + 0.2); ctx.stroke();
      }
    }
  const faces = new Path2D();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== '#') continue;
      if (OPEN_FOR_GLOW(T(x, y - 1))) { faces.moveTo(x, y); faces.lineTo(x + 1, y); }
      if (OPEN_FOR_GLOW(T(x, y + 1))) { faces.moveTo(x, y + 1); faces.lineTo(x + 1, y + 1); }
      if (OPEN_FOR_GLOW(T(x - 1, y))) { faces.moveTo(x, y); faces.lineTo(x, y + 1); }
      if (OPEN_FOR_GLOW(T(x + 1, y))) { faces.moveTo(x + 1, y); faces.lineTo(x + 1, y + 1); }
    }
  ctx.save();
  ctx.lineCap = 'square';
  ctx.shadowColor = th.glow;
  ctx.shadowBlur = Math.max(2, S * 0.35);
  ctx.strokeStyle = rgba(th.glow, 0.55);
  ctx.lineWidth = 0.08;
  ctx.stroke(faces);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rgba(th.glow, 0.9);
  ctx.lineWidth = Math.max(px, 0.03);
  ctx.stroke(faces);
  ctx.restore();

  // Grid over walkable-ish cells
  const grid = new Path2D();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (ch !== '#' && ch !== ' ') grid.rect(x, y, 1, 1);
    }
  ctx.strokeStyle = th.grid || 'rgba(170,200,220,0.07)';
  ctx.lineWidth = px;
  ctx.stroke(grid);
  ctx.restore();
  return machinery;
}

/** Segment walls / doors on a thumbnail (s = px per cell). Image maps: only doors (the art shows the walls). */
function thumbWalls(ctx: CanvasRenderingContext2D, map: GameMap, s: number, doorsOnly: boolean): void {
  if (!map.walls?.length) return;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, s * 0.25);
  for (const w of map.walls) {
    if (doorsOnly && !w.door) continue;
    ctx.strokeStyle = w.door ? (w.door.kind === 'secret' ? DOOR_SEG_COLORS.secret : DOOR_SEG_COLORS[w.door.state] || DOOR_SEG_COLORS.closed) : rgba(WALL_COLORS[wallKind(w)], 0.75);
    ctx.beginPath();
    ctx.moveTo(w.x1 * s, w.y1 * s);
    ctx.lineTo(w.x2 * s, w.y2 * s);
    ctx.stroke();
  }
}

/** Small flat-colour preview of a map (lists). */
export function renderThumbnail(canvas: HTMLCanvasElement, map: GameMap, maxPx = 220): void {
  const w = map.width | 0, h = map.height | 0;
  if (!w || !h) return;
  const s = Math.max(1, Math.min(10, Math.floor(maxPx / Math.max(w, h))));
  canvas.width = w * s;
  canvas.height = h * s;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const th = THEMES[map.theme] || THEMES.street;
  if (isImageMap(map)) {
    const bg = map.background!;
    const img = getImage(bg.url, () => {
      if (canvas.isConnected) renderThumbnail(canvas, map, maxPx);
    });
    ctx.fillStyle = '#141a21';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * s, h * s);
      ctx.clip();
      ctx.globalAlpha = bg.opacity ?? 1;
      ctx.drawImage(img, (bg.x || 0) * s, (bg.y || 0) * s, (bg.w || w) * s, (bg.h || h) * s);
      ctx.restore();
    }
    thumbWalls(ctx, map, s, true);
    for (const t of map.tokens || []) {
      ctx.fillStyle = (DISPO[t.disposition] || DISPO.neutral).color;
      ctx.beginPath();
      ctx.arc((t.x + 0.5) * s, (t.y + 0.5) * s, Math.max(1.5, s * 0.45), 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  for (let y = 0; y < h; y++) {
    const row = map.tiles[y] || '';
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? ' ';
      if (ch === ' ') continue;
      ctx.fillStyle = ch === '.' ? th.floor : ch === ',' ? th.ext : ch === '#' ? th.glow : TILE_FLAT[ch] || '#333';
      if (ch === '#') ctx.globalAlpha = 0.55;
      ctx.fillRect(x * s, y * s, s, s);
      ctx.globalAlpha = 1;
    }
  }
  for (const d of map.doors || []) {
    ctx.fillStyle = d.kind === 'secret' ? '#e0468f' : d.state === 'open' ? '#4fd17a' : '#e0a63f';
    ctx.fillRect(d.x * s, d.y * s, s, s);
  }
  thumbWalls(ctx, map, s, false);
  for (const t of map.tokens || []) {
    ctx.fillStyle = (DISPO[t.disposition] || DISPO.neutral).color;
    ctx.beginPath();
    ctx.arc((t.x + 0.5) * s, (t.y + 0.5) * s, Math.max(1.5, s * 0.45), 0, Math.PI * 2);
    ctx.fill();
  }
}

const tileSwatchCache = new Map<string, string>();
/** Data URL preview of a single tile (editor palette). */
export function tileSwatch(ch: string, theme: string = 'street', size = 30): string {
  const key = ch + theme + size + getTileStyle();
  if (tileSwatchCache.has(key)) return tileSwatchCache.get(key)!;
  let url = '';
  try {
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, size, size);
    const th = THEMES[theme] || THEMES.street;
    // 3×3 neighbourhood: the tile in the middle, floor around (so walls show their glow, doors their frame)
    const around = ch === '#' ? '.' : ch === ',' || ch === 'g' || ch === 't' || ch === '~' ? ',' : '.';
    const S = size;
    const mini: TileMap = {
      width: 3, height: 3, theme,
      tiles: ch === 'D' || ch === 'W' ? [around.repeat(3), '#' + ch + '#', around.repeat(3)] : [around.repeat(3), around + ch + around, around.repeat(3)],
    };
    ctx.save();
    if (ch === 'v' && getTileStyle() === 'detailed') {
      // a lone vehicle cell draws a motorbike: show a whole car, scaled down
      drawStaticMap(ctx, { width: 4, height: 4, theme, tiles: [',,,,', 'vvvv', 'vvvv', ',,,,'] }, S / 4);
    } else {
      ctx.translate(-S, -S);
      drawStaticMap(ctx, mini, S);
    }
    ctx.restore();
    if (ch === 'D') {
      ctx.fillStyle = th.glow;
      ctx.fillRect(0, S * 0.38, S, S * 0.24);
    }
    if (ch === ' ') {
      ctx.strokeStyle = '#2e3843';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(S, S); ctx.stroke();
    }
    url = c.toDataURL();
  } catch {
    url = '';
  }
  tileSwatchCache.set(key, url);
  return url;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const LIGHT_F = 4; // light sub-samples per cell
const FOG_F = 2;

export class MapRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  view: ViewTransform;
  cssW: number;
  cssH: number;
  dpr: number;
  scene: MapScene | null;
  sceneVer?: number;
  overlay: MapOverlay;
  pings: Array<MapPing & { start: number }>;
  images: Map<string, HTMLImageElement>;
  anims: Map<string, TokenAnim>;
  lastPos: Map<string, Point>;
  mapId: string | null;
  fitPending: boolean;
  dirty: boolean;
  lastAmbient: number;
  keys: RendererKeys;
  layers: RendererLayers;
  machinery: Cell[];
  destroyed: boolean;
  /** Called after fit / zoom / centerOn (not on pan). */
  onViewChange: (() => void) | null;
  raf: number;
  gridPath?: Path2D;
  gridPathKey?: string;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.view = { scale: 32, x: 0, y: 0 };
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.scene = null;
    this.overlay = {};
    this.pings = [];
    this.images = new Map();
    this.anims = new Map(); // tokenId -> { pts: [[x,y]], start, dur }
    this.lastPos = new Map(); // tokenId -> {x,y}
    this.mapId = null;
    this.fitPending = true;
    this.dirty = true;
    this.lastAmbient = 0;
    this.keys = {};
    this.layers = {};
    this.machinery = [];
    this.destroyed = false;
    this.onViewChange = null;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    LIVE_RENDERERS.add(this);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    LIVE_RENDERERS.delete(this);
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    if (this.fitPending && this.scene?.map) this.fit();
    this.dirty = true;
  }

  // ---- view ----
  toWorld(sx: number, sy: number): Point {
    return { x: (sx - this.view.x) / this.view.scale, y: (sy - this.view.y) / this.view.scale };
  }
  toScreen(x: number, y: number): Point {
    return { x: this.view.x + x * this.view.scale, y: this.view.y + y * this.view.scale };
  }
  fit() {
    const map = this.scene?.map;
    if (!map || this.cssW < 10 || this.cssH < 10) return;
    const m = Math.min(40, Math.min(this.cssW, this.cssH) * 0.06);
    const scale = Math.max(4, Math.min(64, Math.min((this.cssW - 2 * m) / map.width, (this.cssH - 2 * m) / map.height)));
    this.view.scale = scale;
    this.view.x = (this.cssW - map.width * scale) / 2;
    this.view.y = (this.cssH - map.height * scale) / 2;
    this.fitPending = false;
    this.dirty = true;
    this.onViewChange?.();
  }
  centerOn(x: number, y: number, minScale = 0): void {
    if (minScale && this.view.scale < minScale) this.view.scale = minScale;
    this.view.x = this.cssW / 2 - (x + 0.5) * this.view.scale;
    this.view.y = this.cssH / 2 - (y + 0.5) * this.view.scale;
    this.fitPending = false;
    this.dirty = true;
    this.onViewChange?.();
  }
  zoomAt(sx: number, sy: number, factor: number): void {
    const s = Math.max(4, Math.min(160, this.view.scale * factor));
    const k = s / this.view.scale;
    this.view.x = sx - (sx - this.view.x) * k;
    this.view.y = sy - (sy - this.view.y) * k;
    this.view.scale = s;
    this.fitPending = false;
    this.dirty = true;
    this.onViewChange?.();
  }
  pan(dx: number, dy: number): void {
    this.view.x += dx;
    this.view.y += dy;
    this.fitPending = false;
    this.dirty = true;
  }

  // ---- data ----
  /**
   * scene = { map, actors, role, me, selected: Set, turnTokenId, gmLayer: bool, editor: bool,
   *           fog: { visible: Uint8Array, explored: Uint8Array } | null, unseen: Uint8Array | null,
   *           tokenMask: Uint8Array | null (hide tokens outside), barsFor(token) → bool, darkFactor }
   */
  setScene(scene: MapScene | null): void {
    const prevMap = this.scene?.map;
    this.scene = scene;
    this.sceneVer = (this.sceneVer || 0) + 1;
    const map = scene?.map;
    if (!map) {
      this.dirty = true;
      return;
    }
    if (map.id !== this.mapId) {
      this.mapId = map.id;
      this.fitPending = true;
      this.anims.clear();
      this.lastPos.clear();
      for (const t of map.tokens || []) this.lastPos.set(t.id, { x: t.x, y: t.y });
      if (this.cssW > 10) this.fit();
    } else if (prevMap !== map) {
      this.trackMoves(map);
    }
    this.dirty = true;
  }

  trackMoves(map: GameMap): void {
    const now = performance.now();
    const seen = new Set<string>();
    for (const t of map.tokens || []) {
      seen.add(t.id);
      const prev = this.lastPos.get(t.id);
      if (prev && (prev.x !== t.x || prev.y !== t.y)) {
        const from = this.tokenDrawPos(t.id, prev, now);
        let pts: number[][] | null = null;
        const lp = t.lastMove?.path;
        if (Array.isArray(lp) && lp.length >= 2) {
          const last = lp[lp.length - 1];
          if (last[0] === t.x && last[1] === t.y) pts = lp.map((p) => [p[0], p[1]]);
        }
        if (!pts) pts = [[t.x, t.y]];
        pts.unshift([from.x, from.y]);
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (len > 0.01) this.anims.set(t.id, { pts, len, start: now, dur: Math.min(1400, 70 + len * 85) });
      }
      this.lastPos.set(t.id, { x: t.x, y: t.y });
    }
    for (const id of [...this.lastPos.keys()]) if (!seen.has(id)) this.lastPos.delete(id);
  }

  tokenDrawPos(id: string, fallback: Point, now = performance.now()): Point {
    const a = this.anims.get(id);
    if (!a) return fallback;
    const k = Math.min(1, (now - a.start) / a.dur);
    if (k >= 1) {
      this.anims.delete(id);
      return fallback;
    }
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    let d = e * a.len;
    for (let i = 1; i < a.pts.length; i++) {
      const [x0, y0] = a.pts[i - 1], [x1, y1] = a.pts[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (d <= seg || i === a.pts.length - 1) {
        const f = seg ? Math.min(1, d / seg) : 1;
        return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
      }
      d -= seg;
    }
    return fallback;
  }

  setOverlay(o: MapOverlay | null | undefined): void {
    this.overlay = o || {};
    this.dirty = true;
  }
  addPing(p: MapPing): void {
    this.pings.push({ ...p, start: performance.now() });
    this.dirty = true;
  }

  image(url: string | null | undefined): HTMLImageElement | null {
    return getImage(url);
  }

  // ---- segment doors ----
  /** Screen radius of a door icon. */
  doorIconR() {
    return Math.max(7, Math.min(13, this.view.scale * 0.24));
  }
  /** Door segments shown to this viewer (players: server-filtered; GM preview: fog-aware). */
  doorWalls(): MapWall[] {
    const sc = this.scene!;
    const map = sc?.map;
    if (!map?.walls?.length) return [];
    const explored = sc.fog?.explored || null;
    const out: MapWall[] = [];
    for (const w of map.walls) {
      if (!wallIsDoor(w)) continue;
      if (w.door!.kind === 'secret' && w.door!.state !== 'open' && !sc.gmLayer) continue;
      if (explored && !this.knownNear(map, explored, w)) continue;
      out.push(w);
    }
    return out;
  }
  knownNear(map: GameMap, mask: Uint8Array, w: MapWall): boolean {
    const m = wallMidpoint(w);
    for (let y = Math.floor(m.y - 0.5); y <= Math.floor(m.y + 0.5); y++)
      for (let x = Math.floor(m.x - 0.5); x <= Math.floor(m.x + 0.5); x++) if (x >= 0 && y >= 0 && x < map.width && y < map.height && mask[y * map.width + x]) return true;
    return false;
  }
  /** Door segment under a screen point (icon or the segment itself), closest first. */
  wallDoorAt(sx: number, sy: number): MapWall | null {
    const R = this.doorIconR() + 4;
    let best: MapWall | null = null, bestD = Infinity;
    for (const w of this.doorWalls()) {
      const m = wallMidpoint(w);
      const p = this.toScreen(m.x, m.y);
      let d = Math.hypot(sx - p.x, sy - p.y);
      if (d > R) {
        const a = this.toScreen(w.x1, w.y1), b = this.toScreen(w.x2, w.y2);
        const ds = pointSegmentDistance(sx, sy, a.x, a.y, b.x, b.y);
        d = ds <= Math.max(6, this.view.scale * 0.15) ? R + ds : Infinity;
      }
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }
  /** Any wall (GM / editor) within maxPx of a screen point. */
  wallAtScreen(sx: number, sy: number, maxPx = 8, filter: ((w: MapWall) => boolean) | null = null): MapWall | null {
    const map = this.scene?.map;
    let best: MapWall | null = null, bestD = maxPx;
    for (const w of map?.walls || []) {
      if (filter && !filter(w)) continue;
      const a = this.toScreen(w.x1, w.y1), b = this.toScreen(w.x2, w.y2);
      const d = pointSegmentDistance(sx, sy, a.x, a.y, b.x, b.y);
      if (d <= bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  /** Token under a world point (topmost first). */
  tokenAt(fx: number, fy: number, filter: ((t: Token) => boolean) | null = null): Token | null {
    const toks = this.visibleTokens();
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i];
      if (filter && !filter(t)) continue;
      const s = t.size || 1;
      const p = this.tokenDrawPos(t.id, t);
      const dx = fx - (p.x + s / 2), dy = fy - (p.y + s / 2);
      if (dx * dx + dy * dy <= (s * 0.5) * (s * 0.5)) return t;
    }
    return null;
  }

  visibleTokens(): Token[] {
    const sc = this.scene!;
    const map = sc?.map;
    if (!map) return [];
    const mask = sc.tokenMask;
    const own = new Set(sc.me?.characterIds || []);
    const list = (map.tokens || []).filter((t) => {
      if (sc.hideHidden && t.hidden) return false;
      if (!mask) return true;
      if (t.actorId && own.has(t.actorId)) return true;
      const s = t.size || 1;
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) if (mask[(t.y + dy) * map.width + t.x + dx]) return true;
      return false;
    });
    // draw order: hidden first, then others, selected last
    const sel = sc.selected || new Set();
    return list.sort((a, b) => (a.hidden ? 0 : 1) - (b.hidden ? 0 : 1) || (sel.has(a.id) ? 1 : 0) - (sel.has(b.id) ? 1 : 0));
  }

  // ---- layers ----
  ensureLayers(): void {
    if (this.keys.ver === this.sceneVer && (this.layers.static || this.keys.static?.startsWith('image|'))) return;
    this.keys.ver = this.sceneVer;
    const sc = this.scene!;
    const map = sc.map!;
    const imageMode = isImageMap(map);
    const staticKey = imageMode ? `image|${map.width}x${map.height}` : `${getTileStyle()}|${map.width}x${map.height}|${map.theme}|${map.tiles.join('\n')}`;
    if (staticKey !== this.keys.static) {
      this.keys.static = staticKey;
      if (imageMode) {
        // the artwork is the floor: no tile art at all
        this.layers.static = null;
        this.machinery = [];
      } else {
        const S = staticCellPx(map.width, map.height);
        const c = makeCanvas(map.width * S, map.height * S);
        this.machinery = drawStaticMap(c.getContext('2d')!, map, S);
        this.layers.static = c;
      }
      this.keys.light = null;
    }
    const tokLights = (map.tokens || []).filter((t) => (t.light?.radius ?? 0) > 0).map((t) => [t.x, t.y, t.light!.radius, t.light!.color]);
    const lightKey = JSON.stringify([map.lighting, sc.darkFactor ?? 1, map.lights, tokLights, (map.doors || []).map((d) => d.x + ',' + d.y + d.state), map.tiles.join(''), wallsKey(map)]);
    if (lightKey !== this.keys.light) {
      this.keys.light = lightKey;
      this.buildLightLayers(map, sc.darkFactor ?? 1);
    }
    const fog = sc.fog;
    if (fog !== this.keys.fogObj) {
      this.keys.fogObj = fog;
      this.layers.fogSat = this.layers.fogDark = null;
      if (fog) this.buildFogLayers(map, fog);
    }
    if (sc.unseen !== this.keys.unseenObj) {
      this.keys.unseenObj = sc.unseen;
      this.layers.unseen = sc.unseen ? this.buildMaskLayer(map, sc.unseen, [40, 10, 70, 95], true) : null;
    }
  }

  buildLightLayers(map: GameMap, darkFactor: number): void {
    const w = map.width, h = map.height, F = LIGHT_F, W = w * F, H = h * F;
    const lights = mapLights(map);
    const lighting = map.lighting || 'bright';
    this.layers.glow = null;
    this.layers.dark = null;
    if (!lights.length && lighting === 'bright') return;
    const grid = buildGrid(map);
    const acc = new Float32Array(W * H * 3);
    const lum = new Float32Array(W * H);
    const los = new Uint8Array(w * h);
    for (const l of lights) {
      if (l.x < 0 || l.y < 0 || l.x >= w || l.y >= h) continue;
      const r = l.radius + 0.5;
      const reach = Math.ceil(r);
      los.fill(0);
      lineOfSightMask(grid, l.x, l.y, reach, los);
      const [cr, cg, cb] = hexToRgb(l.color);
      const lx = l.x + 0.5, ly = l.y + 0.5;
      for (let cy = Math.max(0, l.y - reach); cy <= Math.min(h - 1, l.y + reach); cy++)
        for (let cx = Math.max(0, l.x - reach); cx <= Math.min(w - 1, l.x + reach); cx++) {
          if (!los[cy * w + cx]) continue;
          for (let sy = 0; sy < F; sy++)
            for (let sx = 0; sx < F; sx++) {
              const px = cx * F + sx, py = cy * F + sy;
              const d = Math.hypot((px + 0.5) / F - lx, (py + 0.5) / F - ly);
              if (d >= r) continue;
              let k = 1 - d / r;
              k = k * k * (3 - 2 * k);
              const i = py * W + px;
              acc[i * 3] += cr * k;
              acc[i * 3 + 1] += cg * k;
              acc[i * 3 + 2] += cb * k;
              lum[i] += k;
            }
        }
    }
    if (lights.length) {
      const glow = makeCanvas(W, H);
      const gctx = glow.getContext('2d')!;
      const img = gctx.createImageData(W, H);
      const d = img.data;
      for (let i = 0; i < W * H; i++) {
        if (lum[i] <= 0) continue;
        d[i * 4] = Math.min(255, acc[i * 3]);
        d[i * 4 + 1] = Math.min(255, acc[i * 3 + 1]);
        d[i * 4 + 2] = Math.min(255, acc[i * 3 + 2]);
        d[i * 4 + 3] = 255;
      }
      gctx.putImageData(img, 0, 0);
      this.layers.glow = glow;
    }
    if (lighting !== 'bright') {
      const base = (lighting === 'dim' ? 0.42 : 0.8) * darkFactor;
      const dark = makeCanvas(W, H);
      const dctx = dark.getContext('2d')!;
      const img = dctx.createImageData(W, H);
      const d = img.data;
      for (let i = 0; i < W * H; i++) {
        d[i * 4] = 2;
        d[i * 4 + 1] = 4;
        d[i * 4 + 2] = 12;
        d[i * 4 + 3] = Math.round(255 * base * (1 - Math.min(1, lum[i] * 1.15)));
      }
      dctx.putImageData(img, 0, 0);
      this.layers.dark = dark;
    }
  }

  buildFogLayers(map: GameMap, fog: FogMasks): void {
    const w = map.width, h = map.height, F = FOG_F;
    const { visible, explored } = fog;
    const sat = makeCanvas(w * F, h * F);
    const dark = makeCanvas(w * F, h * F);
    const sctx = sat.getContext('2d')!, dctx = dark.getContext('2d')!;
    const si = sctx.createImageData(w * F, h * F), di = dctx.createImageData(w * F, h * F);
    let anyMemory = false;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const vis = visible?.[i], exp = explored?.[i] || vis;
        for (let sy = 0; sy < F; sy++)
          for (let sx = 0; sx < F; sx++) {
            const p = ((y * F + sy) * w * F + x * F + sx) * 4;
            if (!exp) {
              di.data[p] = 3; di.data[p + 1] = 5; di.data[p + 2] = 8; di.data[p + 3] = 255;
            } else if (!vis) {
              anyMemory = true;
              di.data[p] = 4; di.data[p + 1] = 8; di.data[p + 2] = 16; di.data[p + 3] = 150;
              si.data[p] = si.data[p + 1] = si.data[p + 2] = 128; si.data[p + 3] = 255;
            }
          }
      }
    sctx.putImageData(si, 0, 0);
    dctx.putImageData(di, 0, 0);
    this.layers.fogSat = anyMemory ? sat : null;
    this.layers.fogDark = dark;
  }

  buildMaskLayer(map: GameMap, mask: Uint8Array, [r, g, b, a]: number[], invert: boolean): HTMLCanvasElement {
    const w = map.width, h = map.height;
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const on = invert ? !mask[i] : mask[i];
      if (!on) continue;
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---- loop ----
  needsAnimation(now: number): 'fast' | 'slow' | false {
    if (this.anims.size || this.pings.length) return 'fast';
    const sc = this.scene!;
    if (!sc?.map) return false;
    if (sc.turnTokenId || this.machinery.length || this.overlay?.animate || sc.combatMarks?.targetTokenId || sc.combatMarks?.aim) return 'slow';
    return false;
  }

  loop(now: number): void {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const anim = this.needsAnimation(now);
    if (this.dirty || anim === 'fast' || (anim === 'slow' && now - this.lastAmbient > 66)) {
      this.dirty = false;
      this.lastAmbient = now;
      try {
        this.draw(now);
      } catch (err) {
        console.error('[map] draw failed', err);
      }
    }
  }

  draw(now: number): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const sc = this.scene!;
    const map = sc?.map;
    if (!map || !map.width || !map.height) return;
    if (this.fitPending && this.cssW > 10) this.fit();
    this.ensureLayers();
    const { scale, x: vx, y: vy } = this.view;
    const th = THEMES[map.theme] || THEMES.street;
    const time = now / 1000;

    // ---------- world space ----------
    ctx.save();
    ctx.translate(vx, vy);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // backdrop glow around the map
    ctx.fillStyle = '#080b10';
    ctx.fillRect(-0.5, -0.5, map.width + 1, map.height + 1);
    const bg = map.background;
    const imageMode = isImageMap(map);
    if (imageMode) {
      ctx.fillStyle = '#11161c';
      ctx.fillRect(0, 0, map.width, map.height);
      const img = this.image(bg!.url);
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, map.width, map.height);
        ctx.clip();
        ctx.globalAlpha = Math.max(0, Math.min(1, bg!.opacity ?? 1));
        ctx.drawImage(img, bg!.x ?? 0, bg!.y ?? 0, bg!.w || map.width, bg!.h || map.height);
        ctx.restore();
      }
      if (sc.showGrid !== false) this.drawGridLines(ctx, map);
      // editor: tiles are not drawn on image maps, show the non-floor ones as a translucent hint
      if (sc.editor) {
        const hint = this.tileHintLayer(map);
        if (hint) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(hint, 0, 0, map.width, map.height);
          ctx.imageSmoothingEnabled = true;
        }
      }
    } else {
      if (this.layers.static) ctx.drawImage(this.layers.static, 0, 0, map.width, map.height);
      if (bg?.url) {
        const img = this.image(bg.url);
        if (img) {
          ctx.globalAlpha = Math.max(0, Math.min(1, bg.opacity ?? 0.6));
          ctx.drawImage(img, bg.x ?? 0, bg.y ?? 0, bg.w || map.width, bg.h || map.height);
          ctx.globalAlpha = 1;
        }
      }
    }
    if (this.layers.dark) ctx.drawImage(this.layers.dark, 0, 0, map.width, map.height);
    if (this.layers.glow) {
      // on artwork the glow tints instead of washing out ('screen', low alpha)
      ctx.globalCompositeOperation = imageMode ? 'screen' : 'lighter';
      ctx.globalAlpha = imageMode ? (map.lighting === 'bright' ? 0.14 : 0.26) : map.lighting === 'bright' ? 0.22 : 0.38;
      ctx.drawImage(this.layers.glow, 0, 0, map.width, map.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // visible cell range (culling)
    const x0 = Math.max(0, Math.floor(-vx / scale) - 1), y0 = Math.max(0, Math.floor(-vy / scale) - 1);
    const x1 = Math.min(map.width - 1, Math.ceil((this.cssW - vx) / scale) + 1), y1 = Math.min(map.height - 1, Math.ceil((this.cssH - vy) / scale) + 1);
    const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    // machinery LEDs
    if (this.machinery.length && scale >= 10) {
      for (const [mx, my] of this.machinery) {
        if (!inView(mx, my)) continue;
        for (let k = 0; k < 2; k++) {
          const ph = hash(mx, my, 20 + k);
          const on = Math.sin(time * (1.5 + ph * 3) + ph * 10) > 0.1;
          if (!on) continue;
          ctx.fillStyle = k === 0 ? th.glow : ph > 0.7 ? '#e05c5c' : '#4fd17a';
          ctx.beginPath();
          ctx.arc(mx + 0.25 + k * 0.5, my + 0.2 + ph * 0.6, 0.05, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // doors
    const T = (x: number, y: number): string => (x < 0 || y < 0 || x >= map.width || y >= map.height ? ' ' : map.tiles[y]?.[x] ?? ' ');
    for (const d of map.doors || []) {
      if (!inView(d.x, d.y)) continue;
      this.drawDoor(ctx, d, doorHorizontal(T, d.x, d.y), th, !!sc.gmLayer);
    }
    // segment walls (GM overlay / editor) and segment doors (everyone)
    this.drawWallSegments(ctx, map, sc);

    // regions (outline in world space)
    for (const r of map.regions || []) {
      const col = r.gmOnly ? '#e0468f' : r.color || th.accent;
      ctx.strokeStyle = rgba(col, sc.editor ? 0.75 : 0.4);
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.strokeRect(r.x + 0.06, r.y + 0.06, r.w - 0.12, r.h - 0.12);
      ctx.setLineDash([]);
      if (sc.editor) {
        ctx.fillStyle = rgba(col, 0.06);
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }

    // light bulbs (GM)
    if (sc.gmLayer) {
      for (const l of map.lights || []) {
        if (!inView(l.x, l.y)) continue;
        ctx.beginPath();
        ctx.arc(l.x + 0.5, l.y + 0.5, 0.16, 0, Math.PI * 2);
        if (l.on !== false) {
          ctx.fillStyle = l.color || '#ffcc88';
          ctx.shadowColor = l.color || '#ffcc88';
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.strokeStyle = 'rgba(200,200,200,0.6)';
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
        }
        if (sc.editor || this.overlay.selectedLightId === l.id) {
          ctx.strokeStyle = rgba(l.color || '#ffcc88', this.overlay.selectedLightId === l.id ? 0.8 : 0.25);
          ctx.setLineDash([4 / scale, 4 / scale]);
          ctx.lineWidth = 1.5 / scale;
          ctx.beginPath();
          ctx.arc(l.x + 0.5, l.y + 0.5, l.radius + 0.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // fog of war
    if (this.layers.fogSat) {
      ctx.globalCompositeOperation = 'saturation';
      ctx.drawImage(this.layers.fogSat, 0, 0, map.width, map.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.layers.fogDark) ctx.drawImage(this.layers.fogDark, 0, 0, map.width, map.height);
    if (this.layers.unseen) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.layers.unseen, 0, 0, map.width, map.height);
      ctx.imageSmoothingEnabled = true;
    }

    // editor / hover highlights (world space)
    const ov = this.overlay || {};
    if (ov.cells?.length) {
      ctx.fillStyle = ov.cellsColor || 'rgba(63,214,208,0.28)';
      for (const c of ov.cells) ctx.fillRect(c.x, c.y, 1, 1);
    }
    if (ov.rect) {
      const r = ov.rect;
      ctx.strokeStyle = ov.rectColor || '#3fd6d0';
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([5 / scale, 3 / scale]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(ov.rectColor || '#3fd6d0', 0.08);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (ov.hoverCell) {
      ctx.strokeStyle = ov.hoverColor || 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeRect(ov.hoverCell.x + 0.03, ov.hoverCell.y + 0.03, 0.94, 0.94);
    }
    ctx.restore();

    // ---------- screen space ----------
    // region labels
    if (scale >= 12) {
      ctx.font = `600 ${Math.max(10, Math.min(14, scale * 0.38))}px Segoe UI, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      for (const r of map.regions || []) {
        const p = this.toScreen(r.x + 0.15, r.y + 0.12);
        const col = r.gmOnly ? '#e0468f' : r.color || th.accent;
        const base = r.gmOnly ? t('{name} (GM)', { name: r.name }) : r.name;
        // Camera zone driven by a host device (matrix module): 📷 filmed, 📷✕ feed cut by a decker.
        const label = r.cams === 'off' ? t('📷✕ {name}', { name: base }) : r.cams === 'on' ? t('📷 {name}', { name: base }) : base;
        ctx.fillStyle = 'rgba(5,7,10,0.6)';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(p.x - 3, p.y - 2, tw + 6, Math.max(10, Math.min(14, scale * 0.38)) + 4);
        ctx.fillStyle = rgba(col, 0.95);
        ctx.fillText(label, p.x, p.y);
      }
    }

    // GM notes pins
    if (sc.gmLayer) {
      for (const n of map.notes || []) {
        if (!inView(n.x, n.y)) continue;
        const p = this.toScreen(n.x + 0.5, n.y + 0.5);
        const s = Math.max(6, Math.min(12, scale * 0.28));
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#e0a63f';
        ctx.shadowColor = '#e0a63f';
        ctx.shadowBlur = 8;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.fillStyle = '#1a1206';
        ctx.font = `700 ${s * 0.9}px Segoe UI, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', p.x, p.y + 0.5);
        ctx.textAlign = 'left';
      }
    }

    // segment door icons (clickable)
    this.drawDoorIcons(ctx);
    if (imageMode && sc.gmLayer && imageStatus(bg!.url) === 'failed') {
      this.drawLabel(ctx, { x: map.width / 2, y: map.height / 2 }, t('Background image not found: {url}', { url: String(bg!.url).slice(-60) }), '#e05c5c');
    }

    // path preview (under tokens)
    if (ov.path && ov.path.length > 1) this.drawPath(ctx, ov.path, ov.pathColor || '#3fd6d0');

    // tokens
    for (const tok of this.visibleTokens()) {
      if (ov.hideTokenIds?.has?.(tok.id)) continue;
      const p = this.tokenDrawPos(tok.id, tok, now);
      this.drawToken(ctx, tok, p, { now, alpha: 1 });
    }
    // ghost tokens (drag)
    for (const g of ov.ghosts || []) this.drawToken(ctx, g.token, { x: g.x, y: g.y }, { now, alpha: 0.6, ghost: true });
    if (sc.combatMarks) this.drawCombatMarks(ctx, sc.combatMarks, now);
    if (ov.pathLabel && ov.labelAt) this.drawLabel(ctx, ov.labelAt, ov.pathLabel, ov.pathColor || '#3fd6d0');
    if (ov.box) {
      ctx.strokeStyle = '#3fd6d0';
      ctx.fillStyle = 'rgba(63,214,208,0.1)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(ov.box.x, ov.box.y, ov.box.w, ov.box.h);
      ctx.strokeRect(ov.box.x + 0.5, ov.box.y + 0.5, ov.box.w, ov.box.h);
      ctx.setLineDash([]);
    }

    // pings
    if (this.pings.length) {
      this.pings = this.pings.filter((pg) => now - pg.start < 2200);
      for (const pg of this.pings) {
        const k = (now - pg.start) / 2200;
        const p = this.toScreen(pg.x, pg.y);
        const col = pg.color || '#e0468f';
        for (let ring = 0; ring < 2; ring++) {
          const kk = (k * 1.6 + ring * 0.35) % 1;
          ctx.strokeStyle = rgba(col, (1 - kk) * (1 - k * 0.6));
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6 + kk * scale * 1.6, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = rgba(col, 1 - k);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        if (pg.name) {
          ctx.globalAlpha = Math.min(1, (1 - k) * 2);
          this.drawLabel(ctx, { x: pg.x, y: pg.y - 0.9 }, pg.name, col);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  drawDoor(ctx: CanvasRenderingContext2D, d: MapDoor, horiz: boolean, th: ThemeColors, gm: boolean): void {
    const { x, y } = d;
    const secret = d.kind === 'secret';
    if (secret && !gm && d.state !== 'open') return;
    const color = secret ? '#e0468f' : d.kind === 'shutter' ? '#e0a63f' : d.kind === 'gate' ? '#9aa8b6' : th.glow;
    ctx.save();
    ctx.translate(x + 0.5, y + 0.5);
    if (!horiz) ctx.rotate(Math.PI / 2);
    // frame jambs
    ctx.fillStyle = th.wall;
    ctx.fillRect(-0.5, -0.2, 0.1, 0.4);
    ctx.fillRect(0.4, -0.2, 0.1, 0.4);
    const scale = this.view.scale;
    if (d.state === 'open') {
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([3 / scale, 3 / scale]);
      ctx.strokeRect(-0.4, -0.09, 0.8, 0.18);
      ctx.setLineDash([]);
      if (d.kind === 'shutter') {
        ctx.fillStyle = rgba(color, 0.35);
        ctx.fillRect(-0.4, -0.05, 0.8, 0.1);
      } else {
        // swung leaf
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.09;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-0.38, 0.02);
        ctx.lineTo(-0.38 + 0.78 * Math.cos(1.25), 0.02 + 0.78 * Math.sin(1.25));
        ctx.stroke();
        ctx.strokeStyle = rgba(color, 0.18);
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.arc(-0.38, 0.02, 0.78, 0, 1.25);
        ctx.stroke();
      }
    } else {
      ctx.shadowColor = color;
      ctx.shadowBlur = secret ? 0 : 8;
      if (secret) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / scale;
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.strokeRect(-0.42, -0.14, 0.84, 0.28);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = d.kind === 'gate' ? 'rgba(20,26,32,0.9)' : rgba(color, 0.85);
        ctx.fillRect(-0.42, -0.12, 0.84, 0.24);
        ctx.shadowBlur = 0;
        if (d.kind === 'gate') {
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.04;
          ctx.beginPath();
          for (let k = -3; k <= 3; k++) { ctx.moveTo(k * 0.12, -0.12); ctx.lineTo(k * 0.12, 0.12); }
          ctx.stroke();
        } else if (d.kind === 'shutter') {
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 0.03;
          ctx.beginPath();
          for (let k = -3; k <= 3; k++) { ctx.moveTo(k * 0.12, -0.12); ctx.lineTo(k * 0.12, 0.12); }
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(-0.42, -0.02, 0.84, 0.04);
        }
      }
      ctx.shadowBlur = 0;
      if (d.state === 'locked') {
        if (!horiz) ctx.rotate(-Math.PI / 2);
        // padlock glyph
        ctx.fillStyle = '#e0a63f';
        ctx.strokeStyle = '#e0a63f';
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.arc(0, -0.08, 0.09, Math.PI, 0);
        ctx.stroke();
        ctx.fillRect(-0.13, -0.08, 0.26, 0.2);
        ctx.fillStyle = '#1a1206';
        ctx.fillRect(-0.02, -0.02, 0.04, 0.08);
      }
    }
    ctx.restore();
  }

  /** 1 px per cell: non-floor tiles of an image map, tinted (editor only). null when every cell is floor. */
  tileHintLayer(map: GameMap): HTMLCanvasElement | null {
    const key = `${map.width}x${map.height}|${map.tiles.join('')}`;
    if (this.keys.tileHint === key) return this.layers.tileHint ?? null;
    this.keys.tileHint = key;
    const FLOORS = '.,_sgre';
    let any = false;
    const c = makeCanvas(map.width, map.height);
    const cctx = c.getContext('2d')!;
    const img = cctx.createImageData(map.width, map.height);
    for (let y = 0; y < map.height; y++) {
      const row = map.tiles[y] || '';
      for (let x = 0; x < map.width; x++) {
        const ch = row[x] ?? ' ';
        if (FLOORS.includes(ch)) continue;
        any = true;
        const [r, g, b] = ch === ' ' ? [5, 7, 10] : hexToRgb(TILE_FLAT[ch] || '#e05c5c');
        const p = (y * map.width + x) * 4;
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = ch === ' ' ? 150 : 115;
      }
    }
    cctx.putImageData(img, 0, 0);
    this.layers.tileHint = any ? c : null;
    return this.layers.tileHint;
  }

  /** Faint grid over image maps (Foundry art is usually gridded already). World transform active. */
  drawGridLines(ctx: CanvasRenderingContext2D, map: GameMap): void {
    const key = `${map.width}x${map.height}`;
    if (this.gridPathKey !== key) {
      const p = new Path2D();
      for (let x = 0; x <= map.width; x++) { p.moveTo(x, 0); p.lineTo(x, map.height); }
      for (let y = 0; y <= map.height; y++) { p.moveTo(0, y); p.lineTo(map.width, y); }
      this.gridPath = p;
      this.gridPathKey = key;
    }
    if (this.view.scale < 7) return;
    ctx.strokeStyle = 'rgba(220,235,245,0.09)';
    ctx.lineWidth = 1 / this.view.scale;
    ctx.stroke(this.gridPath!);
  }

  /** Segment walls (GM: sc.showWalls or editor) + door segments (everyone) + editor previews. World transform active. */
  drawWallSegments(ctx: CanvasRenderingContext2D, map: GameMap, sc: MapScene): void {
    const walls = map.walls || [];
    const ov = this.overlay || {};
    const scale = this.view.scale;
    const px = 1 / scale;
    ctx.save();
    ctx.lineCap = 'round';
    if (walls.length && sc.gmLayer && (sc.showWalls || sc.editor)) {
      const paths: Record<string, Path2D> = {};
      for (const w of walls) {
        if (w.door) continue;
        const k = wallKind(w);
        const p = (paths[k] ||= new Path2D());
        p.moveTo(w.x1, w.y1);
        p.lineTo(w.x2, w.y2);
      }
      for (const [k, p] of Object.entries(paths)) {
        ctx.strokeStyle = rgba(WALL_COLORS[k], k === 'wall' ? 0.9 : 0.85);
        ctx.lineWidth = Math.max(1.5, Math.min(3.5, scale * 0.07)) * px;
        ctx.setLineDash(k === 'wall' ? [] : [5 * px, 4 * px]);
        ctx.shadowColor = WALL_COLORS[k];
        ctx.shadowBlur = 4;
        ctx.stroke(p);
      }
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      if (sc.editor && scale >= 14) {
        ctx.fillStyle = 'rgba(230,240,245,0.75)';
        const r = 2 * px;
        for (const w of walls) {
          ctx.fillRect(w.x1 - r, w.y1 - r, 2 * r, 2 * r);
          ctx.fillRect(w.x2 - r, w.y2 - r, 2 * r, 2 * r);
        }
      }
    }
    // door segments
    for (const w of this.doorWalls()) {
      const st = w.door!.state;
      const col = w.door!.kind === 'secret' && sc.gmLayer ? DOOR_SEG_COLORS.secret : DOOR_SEG_COLORS[st] || DOOR_SEG_COLORS.closed;
      ctx.strokeStyle = col;
      if (st === 'open') {
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = Math.max(1.5, scale * 0.04) * px;
        ctx.setLineDash([4 * px, 4 * px]);
      } else {
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = Math.max(3, Math.min(7, scale * 0.13)) * px;
        ctx.setLineDash(w.door!.kind === 'secret' ? [6 * px, 4 * px] : []);
        ctx.shadowColor = col;
        ctx.shadowBlur = 6;
      }
      ctx.beginPath();
      ctx.moveTo(w.x1, w.y1);
      ctx.lineTo(w.x2, w.y2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // editor: selection, preview, snap point
    const sel = ov.selectedWallIds;
    if (sel?.size) {
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#e0468f';
      ctx.shadowBlur = 10;
      ctx.lineWidth = Math.max(3, scale * 0.09) * px;
      ctx.beginPath();
      for (const w of walls) {
        if (!sel.has(w.id)) continue;
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (ov.segment) {
      const s = ov.segment;
      ctx.strokeStyle = s.color || '#3fd6d0';
      ctx.lineWidth = Math.max(2, scale * 0.08) * px;
      ctx.setLineDash(s.dashed ? [5 * px, 4 * px] : []);
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ov.snap) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.arc(ov.snap.x, ov.snap.y, 5 * px, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Clickable icons at door-segment midpoints (screen space). */
  drawDoorIcons(ctx: CanvasRenderingContext2D): void {
    const doors = this.doorWalls();
    if (!doors.length) return;
    const sc = this.scene!;
    const R = this.doorIconR();
    const hover = this.overlay?.hoverWallId;
    for (const w of doors) {
      const m = wallMidpoint(w);
      const p = this.toScreen(m.x, m.y);
      if (p.x < -R || p.y < -R || p.x > this.cssW + R || p.y > this.cssH + R) continue;
      const st = w.door!.state;
      const secret = w.door!.kind === 'secret' && sc.gmLayer;
      const col = DOOR_SEG_COLORS[st] || DOOR_SEG_COLORS.closed;
      const ring = secret ? DOOR_SEG_COLORS.secret : col;
      const r = hover === w.id ? R * 1.15 : R;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = 'rgba(8,11,16,0.9)';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ring;
      ctx.lineWidth = hover === w.id ? 2.4 : 1.6;
      ctx.shadowColor = ring;
      ctx.shadowBlur = 8;
      if (secret) ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      if (st === 'open') {
        // empty frame + swung leaf
        ctx.lineWidth = 1.3;
        ctx.strokeRect(-r * 0.36, -r * 0.5, r * 0.72, r * 1.0);
        ctx.beginPath();
        ctx.moveTo(-r * 0.36, -r * 0.5);
        ctx.lineTo(r * 0.12, -r * 0.3);
        ctx.lineTo(r * 0.12, r * 0.62);
        ctx.lineTo(-r * 0.36, r * 0.5);
        ctx.closePath();
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (st === 'locked') {
        ctx.lineWidth = Math.max(1.4, r * 0.14);
        ctx.beginPath();
        ctx.arc(0, -r * 0.12, r * 0.27, Math.PI, 0);
        ctx.stroke();
        ctx.fillRect(-r * 0.4, -r * 0.12, r * 0.8, r * 0.62);
        ctx.fillStyle = '#1a0a0a';
        ctx.fillRect(-r * 0.06, r * 0.05, r * 0.12, r * 0.26);
      } else {
        ctx.fillRect(-r * 0.32, -r * 0.52, r * 0.64, r * 1.04);
        ctx.fillStyle = 'rgba(8,11,16,0.85)';
        ctx.beginPath();
        ctx.arc(r * 0.16, r * 0.04, Math.max(1.2, r * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawPath(ctx: CanvasRenderingContext2D, path: Point[], color: string): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, this.view.scale * 0.1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([Math.max(4, this.view.scale * 0.2), Math.max(3, this.view.scale * 0.15)]);
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    path.forEach((c, i) => {
      const p = this.toScreen(c.x + 0.5, c.y + 0.5);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    const end = path[path.length - 1];
    const p = this.toScreen(end.x + 0.5, end.y + 0.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(3, this.view.scale * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Combat marks (scene.combatMarks, attacks module): blasts (aimed point → landing point, falloff rings, tokens caught), attack lines
   * (attacker → target of pending attacks), the user's target (reticle) and aimed point. Coordinates = cells (top-left), centre = +0.5.
   */
  drawCombatMarks(ctx: CanvasRenderingContext2D, cm: CombatMarks, now: number): void {
    const scale = this.view.scale;
    const C = (x: number, y: number) => this.toScreen(x + 0.5, y + 0.5);
    const tokPos = (id: string) => {
      const tok = (this.scene!.map!.tokens || []).find((tt) => tt.id === id);
      if (!tok) return null;
      const p = this.tokenDrawPos(tok.id, tok, now);
      const size = tok.size || 1;
      return { x: this.view.x + (p.x + size / 2) * scale, y: this.view.y + (p.y + size / 2) * scale, r: Math.max(5, size * scale * 0.42) };
    };
    const mpc = Number(this.scene!.map!.metersPerCell) || 1;
    ctx.save();
    for (const b of cm.blasts || []) {
      const c = C(b.x, b.y);
      const reach = (Number(b.reach) || 0) / mpc;
      // Colour: explosion (orange, stun blue), smoke grey, thermal smoke purple-grey, gas green, flash-pak white.
      const col = b.effect === 'gas' ? '#7fd36b' : b.effect === 'flashpak' ? '#fff3b0' : b.effect === 'thermalSmoke' ? '#a59bb8'
        : b.effect === 'smoke' ? '#b8c2cc' : b.dv ? (b.type === 'S' ? '#3fa9e0' : '#e0663f') : '#b8c2cc';
      if (reach > 0) {
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, (reach + 0.5) * scale);
        g.addColorStop(0, rgba(col, b.radius ? 0.28 : 0.42));
        g.addColorStop(b.radius ? 0.92 : 0.15, rgba(col, b.radius ? 0.22 : 0.25));
        g.addColorStop(1, rgba(col, 0.02));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, (reach + 0.5) * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba(col, 0.8);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, (reach + 0.5) * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        // falloff rings every few meters (DV labels)
        if (b.falloff && b.dv && scale >= 10) {
          const step = Math.max(1, Math.ceil(reach / 4));
          ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
          ctx.textAlign = 'center';
          for (let m = step; m < reach; m += step) {
            ctx.strokeStyle = rgba(col, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(c.x, c.y, m * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = rgba(col, 0.9);
            ctx.fillText(`${Math.max(0, b.dv - b.falloff * Math.round(m * mpc))}${b.type}`, c.x, c.y - m * scale - 3);
          }
          ctx.textAlign = 'left';
        }
      }
      if (b.aim && (b.aim.x !== b.x || b.aim.y !== b.y)) {
        const a = C(b.aim.x, b.aim.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const s = Math.max(4, scale * 0.22);
        ctx.beginPath();
        ctx.moveTo(a.x - s, a.y - s);
        ctx.lineTo(a.x + s, a.y + s);
        ctx.moveTo(a.x + s, a.y - s);
        ctx.lineTo(a.x - s, a.y + s);
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.strokeStyle = '#05070a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(4, scale * 0.18), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (const h of b.hits || []) {
        const p = tokPos(h.tokenId);
        if (!p) continue;
        ctx.strokeStyle = rgba(col, 0.95);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2);
        ctx.stroke();
        this.drawLabel(ctx, this.toWorld(p.x, p.y - p.r - 14), `${h.dv}${b.type}`, col);
      }
      if (b.label) this.drawLabel(ctx, { x: b.x + 0.5, y: b.y + 0.5 + Math.max(0.9, reach * 0.15 + 0.9) }, b.label, col);
    }
    for (const l of cm.lines || []) {
      const a = tokPos(l.from);
      const z = tokPos(l.to);
      if (!a || !z) continue;
      const ang = Math.atan2(z.y - a.y, z.x - a.x);
      const ax = a.x + Math.cos(ang) * a.r, ay = a.y + Math.sin(ang) * a.r;
      const zx = z.x - Math.cos(ang) * (z.r + 4), zy = z.y - Math.sin(ang) * (z.r + 4);
      ctx.strokeStyle = rgba(l.color || '#e05c5c', 0.85);
      ctx.lineWidth = 2;
      ctx.setLineDash(l.dashed ? [6, 5] : []);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(zx, zy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(l.color || '#e05c5c', 0.95);
      ctx.beginPath();
      ctx.moveTo(zx, zy);
      ctx.lineTo(zx - Math.cos(ang - 0.4) * 10, zy - Math.sin(ang - 0.4) * 10);
      ctx.lineTo(zx - Math.cos(ang + 0.4) * 10, zy - Math.sin(ang + 0.4) * 10);
      ctx.closePath();
      ctx.fill();
      if (l.label) this.drawLabel(ctx, this.toWorld((ax + zx) / 2, (ay + zy) / 2 - 12), l.label, l.color || '#e05c5c');
    }
    const k = (Math.sin(now / 300) + 1) / 2;
    if (cm.targetTokenId) {
      const p = tokPos(cm.targetTokenId);
      if (p) {
        const r = p.r + 6 + k * 2;
        ctx.strokeStyle = rgba('#ff4d4d', 0.85 + k * 0.15);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          ctx.moveTo(p.x + Math.cos(a) * (r - 5), p.y + Math.sin(a) * (r - 5));
          ctx.lineTo(p.x + Math.cos(a) * (r + 7), p.y + Math.sin(a) * (r + 7));
        }
        ctx.stroke();
        if (cm.targetLabel) this.drawLabel(ctx, this.toWorld(p.x, p.y + r + 14), cm.targetLabel, '#ff4d4d');
      }
    }
    if (cm.aim) {
      const c = C(cm.aim.x, cm.aim.y);
      const r = Math.max(8, scale * 0.45) + k * 2;
      ctx.strokeStyle = rgba('#ffb347', 0.95);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.moveTo(c.x - r - 6, c.y);
      ctx.lineTo(c.x + r + 6, c.y);
      ctx.moveTo(c.x, c.y - r - 6);
      ctx.lineTo(c.x, c.y + r + 6);
      ctx.stroke();
      if (cm.aimReach) {
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = rgba('#ffb347', 0.5);
        ctx.beginPath();
        ctx.arc(c.x, c.y, (cm.aimReach / mpc + 0.5) * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (cm.aimLabel) this.drawLabel(ctx, { x: cm.aim.x + 0.5, y: cm.aim.y - 0.6 }, cm.aimLabel, '#ffb347');
    }
    ctx.restore();
  }

  drawLabel(ctx: CanvasRenderingContext2D, at: Point, text: string, color = '#3fd6d0'): void {
    const p = this.toScreen(at.x, at.y);
    ctx.font = '600 12px Segoe UI, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(8,11,16,0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    rrect(ctx, p.x - w / 2, p.y - 10, w, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y + 0.5);
    ctx.textAlign = 'left';
  }

  drawToken(ctx: CanvasRenderingContext2D, tok: Token, pos: Point, { now, alpha = 1, ghost = false }: { now: number; alpha?: number; ghost?: boolean }): void {
    const sc = this.scene!;
    const scale = this.view.scale;
    const size = tok.size || 1;
    const cx = this.view.x + (pos.x + size / 2) * scale;
    const cy = this.view.y + (pos.y + size / 2) * scale;
    const R = Math.max(5, size * scale * 0.42);
    if (cx < -R * 3 || cy < -R * 3 || cx > this.cssW + R * 3 || cy > this.cssH + R * 3) return;
    const actor = tok.actorId ? sc.actors?.[tok.actorId] : null;
    const dispo = DISPO[tok.disposition] || DISPO.neutral;
    const status = tok.status || [];
    const dead = status.includes('mort');
    const selected = !ghost && sc.selected?.has(tok.id);
    ctx.save();
    ctx.globalAlpha = alpha * (tok.hidden ? 0.5 : 1) * (dead ? 0.7 : 1);

    // current combat turn: pulsing ring
    if (!ghost && sc.turnTokenId === tok.id) {
      const k = (Math.sin(now / 260) + 1) / 2;
      ctx.strokeStyle = rgba('#e0468f', 0.5 + k * 0.5);
      ctx.lineWidth = 2 + k * 2;
      ctx.shadowColor = '#e0468f';
      ctx.shadowBlur = 12 + k * 10;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 5 + k * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#3fd6d0';
      ctx.shadowBlur = 14;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }
    // body
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(cx + R * 0.08, cy + R * 0.14, R, 0, Math.PI * 2);
    ctx.fill();
    const fill = tok.color || actor?.color || '#2a3340';
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    const img = this.image(tok.img || actor?.portrait);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2);
      ctx.clip();
      const s = Math.max((R * 2) / img.width, (R * 2) / img.height);
      ctx.drawImage(img, cx - (img.width * s) / 2, cy - (img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(cx - R * 0.25, cy - R * 0.3, R * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f2f7fa';
      ctx.font = `700 ${Math.max(8, R * 0.72)}px Segoe UI, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials(tok.name || actor?.name), cx, cy + 1);
      ctx.textAlign = 'left';
    }
    // disposition ring
    ctx.strokeStyle = dispo.color;
    ctx.lineWidth = Math.max(2, R * 0.16);
    ctx.shadowColor = dispo.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (dead) {
      ctx.strokeStyle = 'rgba(224,92,92,0.9)';
      ctx.lineWidth = Math.max(2, R * 0.14);
      ctx.beginPath();
      ctx.moveTo(cx - R * 0.6, cy - R * 0.6); ctx.lineTo(cx + R * 0.6, cy + R * 0.6);
      ctx.moveTo(cx + R * 0.6, cy - R * 0.6); ctx.lineTo(cx - R * 0.6, cy + R * 0.6);
      ctx.stroke();
    }
    // hidden: eye-slash badge
    if (tok.hidden) {
      ctx.globalAlpha = alpha;
      const bx = cx - R * 0.75, by = cy - R * 0.75, br = Math.max(6, R * 0.32);
      ctx.fillStyle = '#12171d';
      ctx.strokeStyle = '#e0468f';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(bx, by, br * 0.6, br * 0.35, 0, 0, Math.PI * 2);
      ctx.moveTo(bx - br * 0.6, by + br * 0.6); ctx.lineTo(bx + br * 0.6, by - br * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha * (dead ? 0.8 : 1);

    // status chips
    if (status.length && R >= 8) {
      const cr = Math.max(6, R * 0.3);
      status.slice(0, 3).forEach((s, i) => {
        const sx = cx + R * 0.8, sy = cy - R * 0.7 + i * cr * 1.9;
        ctx.fillStyle = '#12171d';
        ctx.strokeStyle = '#e0a63f';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(sx, sy, cr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e0a63f';
        ctx.font = `700 ${cr * 1.15}px Segoe UI, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(STATUS_GLYPHS[s] || s[0]?.toUpperCase() || '•', sx, sy + 0.5);
        ctx.textAlign = 'left';
      });
    }

    // condition bars
    if (!ghost && actor && sc.barsFor?.(tok, actor)) {
      let dv = null;
      try { dv = derive(actor); } catch { dv = null; }
      if (dv) {
        const bw = Math.max(18, R * 1.7), bh = Math.max(3, R * 0.13);
        const bx = cx - bw / 2;
        let by = cy - R - bh * 2 - 5;
        const bar = (cur: number, max: number, color: string) => {
          const k = max > 0 ? Math.max(0, Math.min(1, (max - cur) / max)) : 0;
          ctx.fillStyle = 'rgba(5,7,10,0.85)';
          ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
          ctx.fillStyle = color;
          ctx.fillRect(bx, by, bw * k, bh);
          by += bh + 2;
        };
        // NPC stubs (players' view) have no condition monitor: empty bars, as before.
        const cond = 'condition' in actor ? actor.condition : undefined;
        bar(cond?.physical || 0, dv.physicalMonitor, '#e05c5c');
        bar(cond?.stun || 0, dv.stunMonitor, '#5c9be0');
      }
    }

    // name label
    if (scale >= 20 && !ghost) {
      let name = tok.name || actor?.name || '';
      if (name) {
        ctx.font = `600 ${Math.max(10, Math.min(13, scale * 0.3))}px Segoe UI, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        // Labels of adjacent tokens must not run into each other: unless the token is selected or acting,
        // keep the label within its cells (first word, then ellipsis).
        if (!selected && sc.turnTokenId !== tok.id) {
          const maxW = Math.max(28, scale * (tok.size || 1) - 6);
          if (ctx.measureText(name).width + 8 > maxW) {
            const first = name.split(/\s+/)[0] || name;
            name = first;
            while (name.length > 2 && ctx.measureText(name + '…').width + 8 > maxW) name = name.slice(0, -1);
            if (name !== first) name += '…';
          }
        }
        const tw = ctx.measureText(name).width + 8;
        const ly = cy + R + 3;
        ctx.fillStyle = 'rgba(5,7,10,0.75)';
        ctx.beginPath();
        rrect(ctx, cx - tw / 2, ly - 1, tw, Math.max(10, Math.min(13, scale * 0.3)) + 4, 4);
        ctx.fill();
        ctx.fillStyle = tok.hidden ? '#e0468f' : '#e6eef2';
        ctx.fillText(name, cx, ly + 1);
        ctx.textAlign = 'left';
      }
    }
    ctx.restore();
  }
}
