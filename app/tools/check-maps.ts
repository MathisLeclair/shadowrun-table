#!/usr/bin/env node
// Validate battle-map seeds (data/seed/maps/*.json) against the Map schema in ARCHITECTURE.md.
//
//   node tools/check-maps.ts                    validate every map, print a summary
//   node tools/check-maps.ts --preview <id>     also print an ASCII preview of one map (id, file name, or "all")
//   node tools/check-maps.ts --strict           warnings also make the exit code non-zero
//   node tools/check-maps.ts --dir <path>       validate another directory
//   node tools/check-maps.ts --no-color         plain output (colors are off automatically when piped)
//
// Exit code: 0 = all good, 1 = errors (or warnings with --strict), 2 = bad usage.
// Standalone on purpose: no server, no other module needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '..', 'data', 'seed', 'maps');

// ---------------------------------------------------------------- legend
// char -> [blocksMove, blocksSight, label]
export const LEGEND = {
  ' ': [true, true, 'vide'],
  '.': [false, false, 'sol intérieur'],
  ',': [false, false, 'sol extérieur'],
  '#': [true, true, 'mur'],
  D: [false, false, 'porte'], // dynamic: closed/locked doors block (treated as passable for reachability)
  W: [true, false, 'fenêtre'],
  '=': [true, false, 'comptoir / muret / rambarde'],
  T: [true, false, 'table / mobilier'],
  c: [true, false, 'caisses / couvert'],
  o: [true, true, 'pilier'],
  m: [true, true, 'machines / racks / étagères'],
  v: [true, false, 'véhicule'],
  b: [true, false, 'lit / canapé'],
  s: [false, false, 'escalier'],
  e: [false, false, 'ascenseur'],
  '~': [true, false, 'eau'],
  g: [false, false, 'herbe / végétation'],
  r: [false, false, 'gravats (terrain difficile)'],
  x: [false, false, 'danger'],
  t: [false, true, 'arbres / buissons denses'],
  _: [false, false, 'tapis / sol spécial'],
};
const DOOR_STATES = ['open', 'closed', 'locked'];
const DOOR_KINDS = ['door', 'gate', 'shutter', 'secret'];
const LIGHTING = ['bright', 'dim', 'dark'];
const THEMES = ['street', 'bar', 'corp', 'lab', 'industrial', 'residential', 'matrix', 'club'];
const DISPOSITIONS = ['pc', 'ally', 'neutral', 'hostile'];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const isInt = (n) => Number.isInteger(n);
const isStr = (s) => typeof s === 'string';
const isBool = (b) => typeof b === 'boolean';
const blocksMove = (ch) => (LEGEND[ch] ? LEGEND[ch][0] : true);
const blocksSight = (ch) => (LEGEND[ch] ? LEGEND[ch][1] : true);

// ---------------------------------------------------------------- validation
/**
 * Validate one parsed map. Returns { errors: string[], warnings: string[], stats }.
 * Pure function (exported so other tools/tests can reuse it).
 */
export function validateMap(map) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const stats = {};

  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    err('le fichier ne contient pas un objet Map');
    return { errors, warnings, stats };
  }

  // --- scalar fields
  if (!isStr(map.id) || !map.id.trim()) err('id manquant');
  else if (!/^[a-z0-9_-]+$/i.test(map.id)) warn(`id « ${map.id} » : préférez [a-z0-9_-]`);
  if (!isStr(map.name) || !map.name.trim()) err('name manquant');
  else if (map.name.length > 80) warn('name > 80 caractères (tronqué par le serveur)');
  if (map.folder !== undefined && !isStr(map.folder)) err('folder doit être une chaîne');
  if (map.description !== undefined && !isStr(map.description)) err('description doit être une chaîne (markdown)');
  if (map.description === undefined || !String(map.description).trim()) warn('pas de description MJ');
  if (!isInt(map.width) || map.width < 1 || map.width > 400) err(`width invalide (${map.width})`);
  if (!isInt(map.height) || map.height < 1 || map.height > 400) err(`height invalide (${map.height})`);
  if (map.metersPerCell !== undefined && !(typeof map.metersPerCell === 'number' && map.metersPerCell > 0))
    err('metersPerCell doit être un nombre > 0');
  if (map.metersPerCell === undefined) warn('metersPerCell absent (1 par défaut)');
  if (!LIGHTING.includes(map.lighting)) err(`lighting invalide (${map.lighting}) — attendu ${LIGHTING.join('|')}`);
  if (map.theme !== undefined && !THEMES.includes(map.theme)) err(`theme invalide (${map.theme}) — attendu ${THEMES.join('|')}`);
  for (const k of ['fog', 'sharedVision']) if (!isBool(map[k])) err(`${k} doit être un booléen`);
  if (map.movementLocked !== undefined && !isBool(map.movementLocked)) err('movementLocked doit être un booléen');
  if (map.explored !== undefined && (typeof map.explored !== 'object' || map.explored === null || Array.isArray(map.explored)))
    err('explored doit être un objet { userId: string }');
  if (map.background !== undefined && map.background !== null) {
    if (typeof map.background !== 'object' || !isStr(map.background.url)) err('background doit être { url, opacity }');
  }
  for (const k of ['tiles', 'doors', 'lights', 'regions', 'notes', 'tokens'])
    if (!Array.isArray(map[k])) err(`${k} doit être un tableau`);
  // Without a usable size and arrays nothing else can be checked; other scalar errors don't stop the rest.
  if (!isInt(map.width) || !isInt(map.height) || ['tiles', 'doors', 'lights', 'regions', 'notes', 'tokens'].some((k) => !Array.isArray(map[k])))
    return { errors, warnings, stats };

  const W = map.width;
  const H = map.height;
  const inside = (x, y) => isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < W && y < H;

  // --- tiles
  const errorsBeforeTiles = errors.length;
  if (map.tiles.length !== H) err(`tiles : ${map.tiles.length} lignes au lieu de ${H}`);
  const bad = new Map();
  map.tiles.forEach((row, y) => {
    if (!isStr(row)) return err(`tiles[${y}] n'est pas une chaîne`);
    if (row.length !== W) err(`tiles[${y}] : ${row.length} caractères au lieu de ${W}`);
    [...row].forEach((ch, x) => {
      if (!(ch in LEGEND)) {
        if (!bad.has(ch)) bad.set(ch, `${x},${y}`);
      }
    });
  });
  for (const [ch, at] of bad) err(`caractère hors légende ${JSON.stringify(ch)} (premier en ${at})`);
  const gridOk = errors.length === errorsBeforeTiles;
  // Safe accessor even on a malformed grid (short rows / non-strings read as void).
  const tile = (x, y) => (inside(x, y) && isStr(map.tiles[y]) && x < map.tiles[y].length ? map.tiles[y][x] : ' ');

  // --- sub-entity ids unique across the whole map
  const ids = new Map();
  const seeId = (kind, i, id) => {
    if (!isStr(id) || !id) return err(`${kind}[${i}] : id manquant`);
    if (ids.has(id)) err(`id dupliqué « ${id} » (${ids.get(id)} et ${kind}[${i}])`);
    else ids.set(id, `${kind}[${i}]`);
  };

  // --- doors
  const doorAt = new Map();
  map.doors.forEach((d, i) => {
    const tag = `doors[${i}]${d && d.id ? ` (${d.id})` : ''}`;
    seeId('doors', i, d && d.id);
    if (!d || !inside(d.x, d.y)) return err(`${tag} : position hors carte (${d && d.x},${d && d.y})`);
    if (tile(d.x, d.y) !== 'D') err(`${tag} : la case ${d.x},${d.y} n'est pas un « D » (${JSON.stringify(tile(d.x, d.y))})`);
    if (!DOOR_STATES.includes(d.state)) err(`${tag} : state invalide (${d.state})`);
    if (!DOOR_KINDS.includes(d.kind)) err(`${tag} : kind invalide (${d.kind})`);
    if (d.name !== undefined && !isStr(d.name)) err(`${tag} : name doit être une chaîne`);
    if (isStr(d.name) && d.name.length > 60) warn(`${tag} : name > 60 caractères (tronqué par le serveur)`);
    const k = `${d.x},${d.y}`;
    if (doorAt.has(k)) err(`${tag} : deux portes sur la même case ${k}`);
    doorAt.set(k, d);
    // A door should sit in a wall line: blocked on both sides along one axis.
    const wallish = (x, y) => blocksMove(tile(x, y)) || tile(x, y) === 'D';
    const horiz = wallish(d.x - 1, d.y) && wallish(d.x + 1, d.y);
    const vert = wallish(d.x, d.y - 1) && wallish(d.x, d.y + 1);
    if (!horiz && !vert) warn(`${tag} en ${k} n'est encadrée par aucun mur (porte « en plein champ »)`);
    if (d.kind === 'secret' && d.state === 'open') warn(`${tag} : porte secrète déjà ouverte (visible des joueurs)`);
  });
  let looseD = 0;
  map.tiles.forEach((row, y) => [...row].forEach((ch, x) => ch === 'D' && !doorAt.has(`${x},${y}`) && looseD++));

  // --- lights
  map.lights.forEach((l, i) => {
    const tag = `lights[${i}]${l && l.id ? ` (${l.id})` : ''}`;
    seeId('lights', i, l && l.id);
    if (!l || !inside(l.x, l.y)) return err(`${tag} : position hors carte`);
    if (!(typeof l.radius === 'number' && l.radius > 0 && l.radius <= 60)) err(`${tag} : radius invalide (${l.radius})`);
    if (!isStr(l.color) || !HEX.test(l.color)) err(`${tag} : color doit être #rrggbb (${l.color})`);
    if (!isBool(l.on)) err(`${tag} : on doit être un booléen`);
    if (l.name !== undefined && !isStr(l.name)) err(`${tag} : name doit être une chaîne`);
    if (isStr(l.name) && l.name.length > 60) warn(`${tag} : name > 60 caractères (tronqué par le serveur)`);
    if (blocksSight(tile(l.x, l.y))) warn(`${tag} posée sur une case opaque ${JSON.stringify(tile(l.x, l.y))} en ${l.x},${l.y} (n'éclairera rien)`);
  });

  // --- regions
  map.regions.forEach((r, i) => {
    const tag = `regions[${i}]${r && r.name ? ` « ${r.name} »` : ''}`;
    seeId('regions', i, r && r.id);
    if (!r) return err(`${tag} : vide`);
    if (!isStr(r.name) || !r.name.trim()) err(`${tag} : name manquant`);
    else if (r.name.length > 80) warn(`${tag} : name > 80 caractères (tronqué par le serveur)`);
    if (![r.x, r.y, r.w, r.h].every(isInt) || r.w < 1 || r.h < 1) return err(`${tag} : x/y/w/h invalides`);
    if (!inside(r.x, r.y) || !inside(r.x + r.w - 1, r.y + r.h - 1)) err(`${tag} : dépasse de la carte`);
    if (r.color !== undefined && (!isStr(r.color) || !HEX.test(r.color))) err(`${tag} : color doit être #rrggbb`);
    if (r.gmOnly !== undefined && !isBool(r.gmOnly)) err(`${tag} : gmOnly doit être un booléen`);
  });

  // --- notes
  map.notes.forEach((n, i) => {
    const tag = `notes[${i}]${n && n.id ? ` (${n.id})` : ''}`;
    seeId('notes', i, n && n.id);
    if (!n || !inside(n.x, n.y)) return err(`${tag} : position hors carte`);
    if (!isStr(n.text) || !n.text.trim()) err(`${tag} : text manquant`);
    if (n.gmOnly !== true) warn(`${tag} : gmOnly n'est pas true (les notes sont réservées au MJ)`);
  });

  // --- tokens (seeds usually have none, but validate if present)
  map.tokens.forEach((t, i) => {
    const tag = `tokens[${i}]${t && t.id ? ` (${t.id})` : ''}`;
    seeId('tokens', i, t && t.id);
    if (!t || !inside(t.x, t.y)) return err(`${tag} : position hors carte`);
    if (!DISPOSITIONS.includes(t.disposition)) err(`${tag} : disposition invalide (${t.disposition})`);
    if (blocksMove(tile(t.x, t.y)) && tile(t.x, t.y) !== 'D') warn(`${tag} sur une case bloquante`);
  });

  // --- reachability: flood from every entry point, doors (even locked/secret) count as passable
  if (!gridOk) return { errors, warnings, stats };
  const walk = (x, y) => !blocksMove(tile(x, y));
  const seen = new Uint8Array(W * H);
  const queue = [];
  const push = (x, y) => {
    const k = y * W + x;
    if (!seen[k] && walk(x, y)) {
      seen[k] = 1;
      queue.push(k);
    }
  };
  let walkable = 0;
  let entries = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = tile(x, y);
      if (!walk(x, y)) continue;
      walkable++;
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      const vertical = ch === 's' || ch === 'e';
      const outerDoor = ch === 'D' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tile(x + dx, y + dy) === ' ');
      if (border || vertical || outerDoor) {
        entries++;
        push(x, y);
      }
    }
  }
  if (!entries && walkable) warn('aucun point d\'entrée (bord de carte, escalier, ascenseur ou porte extérieure)');
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    const x = k % W;
    const y = (k - x) / W;
    push(x + 1, y);
    push(x - 1, y);
    if (y + 1 < H) push(x, y + 1);
    if (y > 0) push(x, y - 1);
  }
  // group unreached cells into pockets
  const pockets = [];
  const pseen = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (seen[k] || pseen[k] || !walk(x, y)) continue;
      const cells = [k];
      pseen[k] = 1;
      for (let i = 0; i < cells.length; i++) {
        const cx = cells[i] % W;
        const cy = (cells[i] - cx) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          const nk = ny * W + nx;
          if (inside(nx, ny) && !seen[nk] && !pseen[nk] && walk(nx, ny)) {
            pseen[nk] = 1;
            cells.push(nk);
          }
        }
      }
      pockets.push({ x, y, size: cells.length });
    }
  }
  for (const p of pockets) warn(`poche isolée de ${p.size} case(s) praticable(s) en ${p.x},${p.y} (inaccessible depuis les entrées)`);

  Object.assign(stats, {
    size: `${W}×${H}`,
    walkable,
    entries,
    doors: map.doors.length,
    locked: map.doors.filter((d) => d.state === 'locked').length,
    secret: map.doors.filter((d) => d.kind === 'secret').length,
    looseDoorways: looseD,
    lights: map.lights.length,
    regions: map.regions.length,
    notes: map.notes.length,
  });
  return { errors, warnings, stats };
}

// ---------------------------------------------------------------- preview
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  amber: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  white: '\x1b[97m',
  grey: '\x1b[90m',
};
const TILE_COLOR = {
  '#': 'white', W: 'cyan', '=': 'amber', T: 'amber', c: 'amber', o: 'white', m: 'magenta', v: 'blue', b: 'amber',
  s: 'green', e: 'green', '~': 'blue', g: 'green', t: 'green', r: 'grey', x: 'red', _: 'magenta', '.': 'grey', ',': 'dim',
};

/** Render an ASCII preview. Doors are overlaid by state: / open, + closed, L locked, S secret; lights '*', notes '!'. */
export function renderPreview(map, { color = false, overlay = true } = {}) {
  const W = map.width;
  const grid = map.tiles.map((r) => [...r]);
  const over = new Map();
  if (overlay) {
    for (const l of map.lights || []) over.set(`${l.x},${l.y}`, ['*', l.on ? 'amber' : 'grey']);
    for (const n of map.notes || []) over.set(`${n.x},${n.y}`, ['!', 'red']);
    for (const d of map.doors || []) {
      const ch = d.kind === 'secret' ? 'S' : d.state === 'open' ? '/' : d.state === 'locked' ? 'L' : '+';
      over.set(`${d.x},${d.y}`, [ch, d.kind === 'secret' ? 'magenta' : d.state === 'locked' ? 'red' : 'cyan']);
    }
  }
  const paint = (ch, c) => (color && c ? ANSI[c] + ch + ANSI.reset : ch);
  const tens = '    ' + Array.from({ length: W }, (_, x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ')).join('');
  const ones = '    ' + Array.from({ length: W }, (_, x) => String(x % 10)).join('');
  const lines = [tens, ones];
  grid.forEach((row, y) => {
    const cells = row.map((ch, x) => {
      const o = over.get(`${x},${y}`);
      if (o) return paint(o[0], o[1]);
      return paint(ch, TILE_COLOR[ch]);
    });
    lines.push(String(y).padStart(3) + ' ' + cells.join('') + ' ' + String(y));
  });
  lines.push(ones);
  return lines.join('\n');
}

function describe(map) {
  const out = [];
  out.push(`  Portes : / ouverte  + fermée  L verrouillée  S secrète  (D sans entrée = passage libre)   * lumière   ! note MJ`);
  for (const r of map.regions || []) out.push(`  [zone] ${r.name}${r.gmOnly ? ' (MJ)' : ''} — ${r.x},${r.y} ${r.w}×${r.h}`);
  for (const d of map.doors || []) out.push(`  [porte] ${d.id} ${d.x},${d.y} ${d.kind}/${d.state}${d.name ? ` « ${d.name} »` : ''}`);
  for (const l of map.lights || []) out.push(`  [lumière] ${l.id} ${l.x},${l.y} r${l.radius} ${l.color}${l.on ? '' : ' (éteinte)'}`);
  for (const n of map.notes || []) out.push(`  [note] ${n.x},${n.y} ${n.text}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI
function main(argv) {
  const args = argv.slice(2);
  let dir = DEFAULT_DIR;
  let preview = null;
  let strict = false;
  let color = process.stdout.isTTY && !process.env.NO_COLOR;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--preview') preview = args[++i];
    else if (a === '--dir') dir = path.resolve(args[++i] || '.');
    else if (a === '--strict') strict = true;
    else if (a === '--no-color') color = false;
    else if (a === '--color') color = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage : node tools/check-maps.ts [--preview <id|fichier|all>] [--strict] [--dir <dossier>] [--no-color]');
      return 0;
    } else {
      console.error(`Argument inconnu : ${a}`);
      return 2;
    }
  }
  if (args.includes('--preview') && !preview) {
    console.error('--preview attend un id de carte (ou « all »)');
    return 2;
  }
  if (!fs.existsSync(dir)) {
    console.error(`Dossier introuvable : ${dir}`);
    return 1;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) console.log(`Aucune carte dans ${dir}`);

  let nErr = 0;
  let nWarn = 0;
  const byId = new Map();
  const loaded = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let map;
    try {
      map = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.log(`✗ ${f}\n    ERREUR JSON illisible : ${e.message}`);
      nErr++;
      continue;
    }
    const { errors, warnings, stats } = validateMap(map);
    if (map && isStr(map.id)) {
      if (byId.has(map.id)) errors.push(`id de carte « ${map.id} » déjà utilisé par ${byId.get(map.id)}`);
      else byId.set(map.id, f);
    }
    nErr += errors.length;
    nWarn += warnings.length;
    const mark = errors.length ? '✗' : warnings.length ? '!' : '✓';
    const s = stats.size
      ? `${stats.size}  portes ${stats.doors} (${stats.locked} verr., ${stats.secret} secr.)  lumières ${stats.lights}  zones ${stats.regions}  notes ${stats.notes}  entrées ${stats.entries}`
      : '';
    console.log(`${mark} ${f}  ${map && map.id ? `[${map.id}]` : ''}  ${s}`);
    for (const e of errors) console.log(`    ERREUR  ${e}`);
    for (const w of warnings) console.log(`    alerte  ${w}`);
    loaded.push({ file: f, map, ok: !errors.length });
  }

  if (preview) {
    const targets = preview === 'all'
      ? loaded
      : loaded.filter((l) => l.map && (l.map.id === preview || l.file === preview || l.file === `${preview}.json`));
    if (!targets.length) {
      console.error(`\nCarte introuvable pour --preview ${preview}`);
      return 1;
    }
    for (const t of targets) {
      console.log(`\n=== ${t.map.name} [${t.map.id}] — ${t.map.width}×${t.map.height}, ${t.map.lighting}, thème ${t.map.theme || '—'} ===`);
      if (!t.ok) {
        console.log('  (aperçu impossible : la carte a des erreurs)');
        continue;
      }
      console.log(renderPreview(t.map, { color }));
      console.log(describe(t.map));
    }
  }

  console.log(`\n${files.length} carte(s), ${nErr} erreur(s), ${nWarn} alerte(s)`);
  return nErr || (strict && nWarn) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
