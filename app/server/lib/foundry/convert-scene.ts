// Foundry scene → app Map with segment walls and an image background (ARCHITECTURE.md "Segment walls & image backgrounds").
// Canvas coordinates: the scene rectangle starts at (ceil(width*padding/size)*size, ceil(height*padding/size)*size);
// the background image is drawn at that origin minus (shiftX, shiftY). Map cell (0,0) = that origin.
import { slug } from '../../../shared/util.js';
import type { FoundryDoc } from './world.ts';
import type { AssetFn } from './assets.ts';
import type { GameMap, Lighting, MapLight, MapNote, MapTheme, MapWall } from '../../../shared/types.ts';

/** Context of convertScene() (see its doc). */
export interface SceneContext {
  folderPath?: (id: string | null | undefined) => string;
  asset?: AssetFn;
  actorNames?: Record<string, string>;
  templateFor?: (actorId: string) => string | null;
  worldId?: string;
  journalNames?: Record<string, string>;
  allScenes?: FoundryDoc[];
  now?: number;
}

const MAX_DIM = 160;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Background image path of a scene (v14: levels[].background.src; older: background.src / img). */
export function sceneBackground(scene: FoundryDoc): string {
  const lv = (scene.levels || []).find((l: FoundryDoc | null) => l && l.background?.src) || null;
  return lv?.background?.src || scene.background?.src || scene.img || '';
}

/** Thumbnail path (relative to the Foundry Data folder). */
export function sceneThumb(scene: FoundryDoc): string {
  return scene.thumb || '';
}

/** Stable map id for a scene. Duplicate names get a short id suffix. */
export function mapIdFor(scene: FoundryDoc, allScenes: FoundryDoc[] = []): string {
  const base = slug(scene.name || scene._id) || scene._id.toLowerCase();
  const dupes = allScenes.filter((s) => (slug(s.name || s._id) || s._id.toLowerCase()) === base);
  if (dupes.length > 1) {
    dupes.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    if (dupes[0]._id !== scene._id) return `map_fvtt_${base}-${scene._id.slice(0, 5).toLowerCase()}`;
  }
  return `map_fvtt_${base}`;
}

/** Liang–Barsky clip of a segment to [0,w]×[0,h]; returns null when fully outside. */
function clip(x1: number, y1: number, x2: number, y2: number, w: number, h: number): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1, w - x1, y1, h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function themeFor(name: string, folder: string): MapTheme {
  const n = `${name} ${folder}`.toLowerCase();
  if (/bar|club|diner|lounge/.test(n)) return 'bar';
  if (/lab/.test(n)) return 'lab';
  if (/server|hacker|matrix/.test(n)) return 'matrix';
  if (/corp|office|lobby|penthouse|mall|terminus/.test(n)) return 'corp';
  if (/warehouse|hang[ae]r|garage|bunker|construction|carpark|industrial/.test(n)) return 'industrial';
  if (/appart|apartment|mansion|house|ward/.test(n)) return 'residential';
  return 'street';
}

/**
 * Convert a scene. ctx: { folderPath(id) → 'A/B', asset(src, kind) → url, actorNames: {id: name},
 * templateFor(actorId) → templateId|null, worldId, journalNames: {id: name}, allScenes }
 * Returns null when the scene has no background image.
 */
export function convertScene(scene: FoundryDoc, ctx: SceneContext = {}): GameMap | null {
  const bg = sceneBackground(scene);
  if (!bg) return null;
  const g = scene.grid || {};
  const size = Math.max(10, num(g.size, 100));
  const W = Math.max(1, num(scene.width, size));
  const H = Math.max(1, num(scene.height, size));
  const pad = num(scene.padding, 0);
  const px = Math.ceil((W * pad) / size) * size;
  const py = Math.ceil((H * pad) / size) * size;
  const width = Math.min(MAX_DIM, Math.ceil(W / size));
  const height = Math.min(MAX_DIM, Math.ceil(H / size));
  const shiftX = num(scene.shiftX ?? scene.background?.offsetX, 0);
  const shiftY = num(scene.shiftY ?? scene.background?.offsetY, 0);
  const toCell = (x: number, y: number): [number, number] => [(x - px) / size, (y - py) / size];
  const folder = ctx.folderPath ? ctx.folderPath(scene.folder) : '';
  const id = mapIdFor(scene, ctx.allScenes || []);

  // Walls
  const walls: MapWall[] = [];
  let doors = 0;
  let secret = 0;
  let clipped = 0;
  for (const w of scene.walls || []) {
    const c = w.c || [];
    if (c.length < 4) continue;
    const isDoor = num(w.door) > 0;
    const move = num(w.move) > 0;
    const sight = num(w.sight) > 0;
    if (!isDoor && !move && !sight) continue;
    const [ax, ay] = toCell(c[0], c[1]);
    const [bx, by] = toCell(c[2], c[3]);
    const cl = clip(ax, ay, bx, by, width, height);
    if (!cl) {
      clipped++;
      continue;
    }
    if (Math.hypot(cl[2] - cl[0], cl[3] - cl[1]) < 0.01) continue;
    const wall: MapWall = { id: `w${walls.length + 1}`, x1: r3(cl[0]), y1: r3(cl[1]), x2: r3(cl[2]), y2: r3(cl[3]), move: isDoor || move, sight: isDoor || sight, door: null };
    if (num(w.dir)) wall.foundry = { dir: num(w.dir) }; // one-way wall in Foundry (blocks from one side only)
    if (isDoor) {
      const kind = num(w.door) === 2 ? 'secret' : 'door';
      const ds = num(w.ds);
      wall.door = { state: ds === 1 ? 'open' : ds === 2 ? 'locked' : 'closed', kind };
      doors++;
      if (kind === 'secret') secret++;
    }
    walls.push(wall);
  }

  // Lights
  const dist = Math.max(0.0001, num(g.distance, 1));
  const lights: MapLight[] = [];
  for (const l of scene.lights || []) {
    const [cx, cy] = toCell(num(l.x), num(l.y));
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const dim = num(l.config?.dim, 0) || num(l.config?.bright, 0);
    if (dim <= 0) continue;
    lights.push({ id: `l${lights.length + 1}`, x, y, radius: Math.max(0.5, Math.min(60, Math.round((dim / dist) * 10) / 10)), color: /^#[0-9a-f]{6}$/i.test(l.config?.color || '') ? l.config.color : '#ffcc88', on: !l.hidden });
  }

  // Ambient light
  const env = scene.environment || {};
  const darkness = num(env.darknessLevel ?? scene.darkness, 0);
  let lighting: Lighting = darkness > 0.5 ? 'dark' : darkness > 0.2 ? 'dim' : 'bright';
  if (env.globalLight?.enabled && darkness <= 0.2) lighting = 'bright';

  // Journal pins → GM notes
  const notes: MapNote[] = [];
  for (const n of scene.notes || []) {
    const [cx, cy] = toCell(num(n.x), num(n.y));
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const label = n.text || ctx.journalNames?.[n.entryId] || 'Note Foundry';
    notes.push({ id: `n_${n._id}`, x, y, text: String(label).slice(0, 400), gmOnly: true });
  }

  // Tokens: listed only (they are per-scene placements)
  const tokCount = new Map<string, number>();
  for (const t of scene.tokens || []) {
    const actorName = ctx.actorNames?.[t.actorId] || t.name || '?';
    const tpl = ctx.templateFor ? ctx.templateFor(t.actorId) : null;
    const key = `${t.name || actorName}${tpl ? ` (\`${tpl}\`)` : ''}${t.hidden ? ' [caché]' : ''}`;
    tokCount.set(key, (tokCount.get(key) || 0) + 1);
  }
  const tokenText = [...tokCount.entries()].map(([k, n]) => `${n}× ${k}`).join(', ');

  const bgUrl = ctx.asset ? ctx.asset(bg, 'scene') : bg;
  const desc = [
    `Importée de **Foundry VTT** (monde \`${ctx.worldId || ''}\`, scène « ${scene.name} »${folder ? `, dossier ${folder}` : ''}).`,
    `Image ${W}×${H} px, grille ${size} px = ${g.distance ?? 1} ${g.units || 'm'}${num(g.type) > 1 ? ' (grille hexagonale dans Foundry, ici carrée)' : ''}.`,
    `Murs : ${walls.length}${doors ? ` (dont ${doors} porte${doors > 1 ? 's' : ''}${secret ? `, ${secret} secrète${secret > 1 ? 's' : ''}` : ''})` : ''}${clipped ? ` — ${clipped} hors cadre ignoré${clipped > 1 ? 's' : ''}` : ''}. Lumières : ${lights.length}.`,
    tokenText ? `Jetons dans Foundry : ${tokenText}.` : '',
    width * size < W || height * size < H ? `Attention : carte tronquée à ${MAX_DIM} cases.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    id,
    name: String(scene.navName || scene.name || 'Scène Foundry').slice(0, 80),
    folder: (folder ? `Foundry / ${folder}` : 'Foundry').slice(0, 60),
    description: desc,
    width,
    height,
    metersPerCell: Math.max(0.25, Math.min(50, num(g.distance, 1))),
    tiles: Array.from({ length: height }, () => '.'.repeat(width)),
    walls,
    doors: [],
    lights,
    lighting,
    regions: [],
    notes,
    tokens: [],
    explored: {},
    fog: true,
    sharedVision: true,
    movementLocked: false,
    background: { url: bgUrl, opacity: 1, mode: 'image', x: r3(-shiftX / size), y: r3(-shiftY / size), w: r3(W / size), h: r3(H / size) },
    theme: themeFor(scene.name || '', folder),
    thumb: scene.thumb && ctx.asset ? ctx.asset(scene.thumb, 'thumb', `${scene._id}`) : '',
    foundry: { id: scene._id, world: ctx.worldId || '', importedAt: ctx.now || Date.now() },
  };
}
