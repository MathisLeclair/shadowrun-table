// Server-wide map library (« Bibliothèque de cartes »): raw fragmaps shared by every table — image + walls/doors/
// lights/regions, no tokens, no fog. Tables make their own copies (instances, server/modules/22-maplib.js).
// See ARCHITECTURE.md « Map library ».
//
// <maplib> = SR_MAPLIB_DIR, else <runtime>/maplib
//   library.json          { version: 1, settings: { publishAdminOnly }, maps: { [slug]: Meta } }   (index, small)
//   entries/<slug>.json   { slug, versions: { [n]: Version } }  current version + the 5 previous ones (rollback)
//   images/<file>         the artwork (copied by tools/maplib-build.js or uploaded from /admin) — never in git
//   thumbs/<slug>.jpg     small JPEG previews (tools/maplib-build.js, or made from an /admin upload)
// <runtime>/maplib-sign.key  HMAC key of the image links (SR_MAPLIB_KEY_FILE; outside <maplib>, which is copied PC → VPS)
// Sources: git data/maplib/<slug>.json (SR_MAPLIB_SOURCE) and the Foundry fragmaps-free scenes of the Lazarus pack
// (data/seed/maps/foundry-*.json, SR_MAPLIB_SEED_MAPS) — both applied at boot, see syncSources().
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RUNTIME_DIR, DATA_DIR, SEED_DIR, GLOBAL_ASSETS_DIR, readJson, writeJsonAtomic } from '../store.ts';
import { sessionTag, sessionAlive } from './books/access.ts';
import { slug as slugify } from '../../shared/util.js';
import { LIB_THEMES, LIB_LIGHTINGS, LIB_SOURCES, libGeometry, libThumbUrl, versionCounts, publicRegions } from '../../shared/maplib.js';
import type { GameMap, Lighting, MapLight, MapRegion, MapTheme, MapWall, Point } from '../../shared/types.ts';

// ---------------------------------------------------------------------------
// Types (library files on disk: library.json, entries/<slug>.json)
// ---------------------------------------------------------------------------
/** Version content: walls / lights / regions in cell units (origin = grid origin of the image), optional entry point. */
export interface LibVersionContent {
  walls: MapWall[];
  lights: MapLight[];
  regions: MapRegion[];
  entry?: Point;
}
/** Grid geometry of an entry over its image (px). */
export interface LibGeometry {
  gridPx: number;
  imageW: number;
  imageH: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}
/** A stored version (entries/<slug>.json -> versions[n]). */
export interface LibVersion extends LibVersionContent {
  geometry: LibGeometry;
}
export interface LibTraced {
  by: string;
  at: string;
  quality: 'good' | 'rough';
  notes: string;
}
/** Descriptive fields of an entry. */
export interface LibInfo {
  name: string;
  nameFr: string;
  source: string;
  metersPerCell: number;
  theme: MapTheme;
  lighting: Lighting;
  tags: string[];
  description: string;
  traced: LibTraced | null;
}
/** Where an entry comes from: git file, Foundry seed scene, upload. */
export interface LibOriginRef {
  kind: string;
  file?: string;
  hash?: string;
  version?: number;
}
/** Who made a version: { kind: 'git'|'seed'|'admin'|'gm'|'migration', ... }. */
export interface LibBy {
  kind: string;
  [extra: string]: unknown;
}
export type LibCounts = { walls: number; doors: number; lights: number; regions: number };
export interface LibHistoryItem {
  version: number;
  at: string;
  by: LibBy | null;
  origin: string;
  counts: LibCounts;
}
export interface LibVersionInfo {
  at: string;
  by: LibBy | null;
  origin: string;
  note?: string;
}
export type LibOverrides = Partial<Pick<LibInfo, 'name' | 'nameFr' | 'tags' | 'description' | 'theme' | 'lighting'>>;
/** One entry of library.json (`maps[slug]`). */
export interface LibMeta extends LibInfo, LibGeometry {
  id: string;
  slug: string;
  image: string | null;
  imagePath: string | null;
  thumbPath: string | null;
  version: number;
  origin: string;
  originRef: LibOriginRef | null;
  createdAt: string;
  updatedAt?: string;
  history: LibHistoryItem[];
  counts?: LibCounts;
  versionInfo?: LibVersionInfo;
  overrides?: LibOverrides;
  gitNewer?: { file: string; hash: string; version: number };
  /** Tombstone. */
  deleted?: { at: string };
}
export interface LibSettings {
  publishAdminOnly: boolean;
}
/** library.json */
export interface LibIndex {
  version: number;
  settings: LibSettings;
  maps: Record<string, LibMeta>;
}
interface VersionsFile {
  slug: string;
  versions: Record<string, LibVersion>;
}
/** One git library file (gitFiles()). `raw` is the parsed file (written by people and tools). */
export interface GitFile {
  file: string;
  slug: string;
  raw: any;
  hash: string;
}
/** Error carrying a translatable key (libError()). */
export interface LibError extends Error {
  libKey: string;
  libParams?: Record<string, string | number>;
  code?: string;
}
/** Signed link payload: table session { t, u, s, e } or admin session { a: 1, s, e }. */
export interface LinkPayload {
  t?: string;
  u?: string;
  a?: number;
  s?: string;
  e: number;
}
export type VerifyResult = ({ ok: true } & LinkPayload) | { ok: false; reason: 'missing' | 'bad' | 'expired' };

export { sessionTag, sessionAlive };
export const MAPLIB_DIR = process.env.SR_MAPLIB_DIR ? path.resolve(process.env.SR_MAPLIB_DIR) : path.join(RUNTIME_DIR, 'maplib');
export const GIT_DIR = process.env.SR_MAPLIB_SOURCE ? path.resolve(process.env.SR_MAPLIB_SOURCE) : path.join(DATA_DIR, 'maplib');
export const SEED_MAPS_DIR = process.env.SR_MAPLIB_SEED_MAPS ? path.resolve(process.env.SR_MAPLIB_SEED_MAPS) : path.join(SEED_DIR, 'maps');
export const IMAGES_DIR = path.join(MAPLIB_DIR, 'images');
export const THUMBS_DIR = path.join(MAPLIB_DIR, 'thumbs');
const ENTRIES_DIR = path.join(MAPLIB_DIR, 'entries');
const INDEX_FILE = path.join(MAPLIB_DIR, 'library.json');
export const HISTORY_MAX = 5;
const MAX_DIM = 160; // same limit as table maps (20-maps.js)
const MAX_WALLS = 6000;
export const IMAGE_EXTS: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** Images of the free « Fragmaps » Foundry module (fragmaps-free): table maps showing one of them are library maps. */
export const FRAGMAPS_FREE: Record<string, [nameFr: string, tags: string, description: string]> = {
  'ammo-bunker.jpg': ['Bunker à munitions', 'bunker militaire armurerie munitions military armory', 'Petit bunker en béton rempli de caisses de munitions : planque d’armes, dépôt de contrebande ou dernier carré d’un gang.'],
  'backalley.jpg': ['Ruelle', 'ruelle rue extérieur alley street outdoor', 'Ruelle étroite entre deux immeubles, bennes et escaliers de secours : rendez-vous discret, embuscade ou fuite à pied.'],
  'bio-lab.jpg': ['Laboratoire biologique', 'laboratoire biotech corpo lab biotech corp', 'Laboratoire de biotechnologie aux paillasses et cuves de culture : extraction de chercheur ou vol de données sur un projet corpo.'],
  'construction-site.jpg': ['Chantier de construction', 'chantier extérieur industriel construction site outdoor industrial', 'Chantier à ciel ouvert, échafaudages et engins : échange sous tension, poursuite ou combat avec beaucoup de couvert.'],
  'corp-lobby.jpg': ['Hall corporatiste', 'hall accueil corpo sécurité lobby corp security', 'Hall d’accueil d’une tour corporatiste avec comptoir de sécurité : infiltration par la grande porte ou rencontre avec un M. Johnson.'],
  'crash-site-day.jpg': ['Site du crash (jour)', 'crash épave extérieur crash site wreck outdoor', 'Épave fumante au milieu de nulle part : récupérer une cargaison avant les équipes de récupération corpo.'],
  'cyber-mansion.jpg': ['Manoir cyberpunk', 'manoir villa luxe résidence mansion luxury residential', 'Villa de luxe sous haute sécurité : cambriolage, extraction d’un cadre ou soirée mondaine qui tourne mal.'],
  'cyber-slums-night.jpg': ['Bidonville (nuit)', 'bidonville barrens nuit rue slums night street', 'Taudis et passerelles de fortune dans les Barrens, de nuit : planque, rencontre avec un contact de rue ou guerre de gangs.'],
  'cyber-warehouse.jpg': ['Entrepôt', 'entrepôt docks industriel warehouse industrial', 'Grand entrepôt aux rayonnages et caisses empilées : échange de marchandise, planque de gang ou fusillade à couvert.'],
  'cyberpunk-carpark-night.jpg': ['Parking (nuit)', 'parking voitures nuit extérieur car park night outdoor', 'Parking sous les néons, de nuit : rendez-vous avec un Johnson, échange de véhicule ou embuscade.'],
  'cyberpunk-diner.jpg': ['Diner', 'diner restaurant bar soykaf', 'Petit diner ouvert toute la nuit : point de rencontre neutre avec un fixer, ou braquage qui dégénère.'],
  'hackers-lair-day.jpg': ['Repaire de hacker', 'repaire decker hacker matrice planque lair matrix safehouse', 'Planque encombrée d’un decker, câbles et écrans partout : base des runners ou cible d’une descente.'],
  'hangar.jpg': ['Hangar', 'hangar aéroport avion véhicules hangar airport aircraft', 'Hangar d’aviation avec appareils et ateliers : vol de véhicule, départ précipité ou fusillade entre les carlingues.'],
  'horizon-shopping-mall.jpg': ['Centre commercial Horizon', 'centre commercial boutiques foule mall shops crowd', 'Galerie marchande corpo sur plusieurs boutiques : filature dans la foule, rencontre publique ou prise d’otages.'],
  'mansionlibrary.jpg': ['Bibliothèque du manoir', 'bibliothèque manoir luxe library mansion luxury', 'Bibliothèque boisée d’une riche demeure : coffre caché, rencontre feutrée ou vol d’un objet rare.'],
  'market-street-night.jpg': ['Rue marchande (nuit)', 'marché rue nuit étals market street night', 'Rue commerçante aux étals illuminés, de nuit : contact de rue, filature ou course-poursuite dans la foule.'],
  'nomad-camp.jpg': ['Camp de nomades', 'camp nomades caravanes extérieur nomad camp outdoor', 'Campement de nomades et de caravanes en périphérie : contrebandiers, passeurs ou refuge temporaire.'],
  'old-rooftop-night.jpg': ['Vieux toit (nuit)', 'toit immeuble nuit extérieur rooftop night outdoor', 'Toit d’un vieil immeuble, de nuit : poste de tireur, rendez-vous discret ou extraction par drone.'],
  'penthouse-office.jpg': ['Bureau en penthouse', 'bureau penthouse corpo luxe office corp luxury', 'Bureau de dirigeant au sommet d’une tour : vol de données, chantage ou confrontation finale avec un cadre.'],
  'prison-courtyard.jpg': ['Cour de prison', 'prison cour sécurité extérieur prison courtyard security', 'Cour d’un pénitencier sous miradors : évasion, extraction d’un détenu ou rencontre en parloir.'],
  'secret-facility.jpg': ['Installation secrète', 'installation secrète laboratoire corpo secret facility lab corp', 'Site corporatiste caché aux accès contrôlés : infiltration de haut niveau et secrets dangereux.'],
  'security-checkpoint.jpg': ['Poste de contrôle', 'poste de contrôle sécurité frontière checkpoint security border', 'Barrage de sécurité avec guérites et barrières : passage en force, faux SIN ou contrebande.'],
  'server-room.jpg': ['Salle des serveurs', 'serveurs matrice données corpo server room matrix data', 'Salle de serveurs climatisée : accès physique à un nœud, vol de données ou sabotage.'],
  'skytower-helipad-day.jpg': ['Héliport de la tour (jour)', 'héliport toit tour corpo helipad rooftop tower', 'Héliport au sommet d’une tour corpo : extraction par les airs, fuite ou rencontre à haut risque.'],
  'terminus.jpg': ['Terminus', 'gare terminus transports station transit', 'Terminus de transports en commun : filature, échange dans la foule ou attente d’un contact.'],
  'trauma-ward.jpg': ['Service des urgences', 'hôpital urgences clinique hospital trauma ward clinic', 'Service des urgences d’un hôpital : soigner un runner, récupérer un patient ou effacer des dossiers médicaux.'],
};

// ---------------------------------------------------------------------------
// Sanitizers (git files are written by people and tools: trust nothing)
// ---------------------------------------------------------------------------
// Inputs of the sanitizers are foreign data (git files, seed scenes, admin requests): typed `any` on purpose.
const str = (v: unknown, max = 200): string => (v == null ? '' : String(v)).slice(0, max);
const num = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);
const color = (v: unknown, def: string): string => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : def);
export const cleanSlug = (s: unknown): string => {
  const v = String(s ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(v) ? v : '';
};
const cleanFileName = (s: unknown): string => {
  const v = String(s ?? '').trim();
  return v && !/[\\/]|^\.|\.\./.test(v) && v.length < 200 ? v : '';
};
const cleanRel = (s: unknown): string => {
  const v = String(s ?? '').trim().replace(/\\/g, '/');
  return v && !v.split('/').some((p) => !p || p === '..' || p.startsWith('.')) && !/^[a-z]:/i.test(v) && v.length < 300 ? v : '';
};
const cleanTags = (list: unknown): string[] => [...new Set((Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[,;]/) : []).map((t: unknown) => str(t, 40).trim()).filter(Boolean))].slice(0, 40);

function cleanWall(w: any, i: number): MapWall | null {
  if (!w || typeof w !== 'object') return null;
  const c = (v: unknown): number => (v !== null && v !== '' && Number.isFinite(Number(v)) ? r3(Math.max(-MAX_DIM * 4, Math.min(MAX_DIM * 4, Number(v)))) : NaN);
  const x1 = c(w.x1), y1 = c(w.y1), x2 = c(w.x2), y2 = c(w.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || (x1 === x2 && y1 === y2)) return null;
  let door: MapWall['door'] = null;
  if (w.door) {
    const d = typeof w.door === 'object' ? w.door : {};
    door = { state: oneOf(d.state, ['open', 'closed', 'locked'], 'closed'), kind: d.kind === 'secret' ? 'secret' : 'door' };
  }
  return { id: str(w.id, 40) || `w${i + 1}`, x1, y1, x2, y2, move: w.move !== false, sight: w.sight !== false, door };
}
function cleanLight(l: any, i: number): MapLight | null {
  if (!l || typeof l !== 'object' || !Number.isFinite(Number(l.x)) || !Number.isFinite(Number(l.y))) return null;
  return { id: str(l.id, 40) || `l${i + 1}`, x: r3(num(l.x, 0, MAX_DIM, 0)), y: r3(num(l.y, 0, MAX_DIM, 0)), radius: num(l.radius, 0.5, 60, 5), color: color(l.color, '#ffcc88'), on: l.on !== false };
}
function cleanRegion(r: any, i: number): MapRegion | null {
  if (!r || typeof r !== 'object' || !Number.isFinite(Number(r.x)) || !Number.isFinite(Number(r.y))) return null;
  return { id: str(r.id, 40) || `r${i + 1}`, name: str(r.name || 'Zone', 80), x: Math.round(num(r.x, 0, MAX_DIM - 1, 0)), y: Math.round(num(r.y, 0, MAX_DIM - 1, 0)), w: Math.round(num(r.w, 1, MAX_DIM, 1)), h: Math.round(num(r.h, 1, MAX_DIM, 1)), gmOnly: false };
}
const list = <T>(v: unknown, cleaner: (x: any, i: number) => T | null, max: number): T[] => (Array.isArray(v) ? v : []).map(cleaner).filter((x): x is T => !!x).slice(0, max);

/** Version content: { walls, lights, regions, entry? }. */
export function cleanVersion(src: any = {}): LibVersionContent {
  const v: LibVersionContent = {
    walls: list(src.walls, cleanWall, MAX_WALLS),
    lights: list(src.lights, cleanLight, 500),
    regions: list(src.regions, cleanRegion, 300),
  };
  if (src.entry && Number.isFinite(Number(src.entry.x)) && Number.isFinite(Number(src.entry.y))) v.entry = { x: r3(num(src.entry.x, 0, MAX_DIM, 0)), y: r3(num(src.entry.y, 0, MAX_DIM, 0)) };
  return v;
}
/** Geometry of the grid over the image (px). */
function cleanGeometry(src: any = {}): LibGeometry {
  const gridPx = num(src.gridPx, 4, 2000, 100);
  const imageW = Math.round(num(src.imageW, 1, 100000, 0)) || null;
  const imageH = Math.round(num(src.imageH, 1, 100000, 0)) || null;
  const offsetX = num(src.offsetX, -100000, 100000, 0);
  const offsetY = num(src.offsetY, -100000, 100000, 0);
  const g = libGeometry({ gridPx, imageW, imageH, offsetX, offsetY, width: src.width, height: src.height });
  return { gridPx, imageW: imageW || g.imageW, imageH: imageH || g.imageH, offsetX, offsetY, width: Math.min(MAX_DIM, g.width), height: Math.min(MAX_DIM, g.height) };
}
/** Descriptive fields (no geometry, no walls). */
function cleanInfo(src: any = {}, fallbackName = ''): LibInfo {
  const traced: LibTraced | null = src.traced && typeof src.traced === 'object'
    ? { by: str(src.traced.by, 40), at: str(src.traced.at, 40), quality: src.traced.quality === 'good' ? 'good' : 'rough', notes: str(src.traced.notes, 2000) }
    : null;
  return {
    name: str(src.name || fallbackName, 100),
    nameFr: str(src.nameFr || src.name || fallbackName, 100),
    source: oneOf(src.source, LIB_SOURCES as string[], 'fragmap'),
    metersPerCell: num(src.metersPerCell, 0.25, 50, 1.5),
    theme: oneOf(src.theme, LIB_THEMES as MapTheme[], 'street'),
    lighting: oneOf(src.lighting, LIB_LIGHTINGS as Lighting[], 'bright'),
    tags: cleanTags(src.tags),
    description: str(src.description, 4000),
    traced,
  };
}
const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
let index: LibIndex | null = null; // in memory, server-wide (not per table)
let synced = false;

function emptyIndex(): LibIndex {
  return { version: 1, settings: { publishAdminOnly: false }, maps: {} };
}
function loadIndex(): LibIndex {
  if (index) return index;
  const raw = readJson(INDEX_FILE, null);
  const idx: LibIndex = raw && typeof raw === 'object' && raw.maps && typeof raw.maps === 'object' ? raw : emptyIndex();
  idx.settings = { publishAdminOnly: !!idx.settings?.publishAdminOnly };
  index = idx;
  return idx;
}
function saveIndex(): void {
  try {
    fs.mkdirSync(MAPLIB_DIR, { recursive: true });
    writeJsonAtomic(INDEX_FILE, index);
  } catch (err) {
    console.error('[maplib] library.json non enregistré :', (err as Error).message);
  }
}
const entriesFile = (slug: string): string => path.join(ENTRIES_DIR, `${slug}.json`);
function readVersions(slug: string): VersionsFile {
  const raw = readJson<VersionsFile>(entriesFile(slug), null);
  return raw && raw.versions && typeof raw.versions === 'object' ? raw : { slug, versions: {} };
}
function writeVersions(slug: string, data: VersionsFile): void {
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  writeJsonAtomic(entriesFile(slug), data);
}

/** Persist the index after changes made outside this file's own helpers (table map migration). */
export const saveLibrary = (): void => saveIndex();

/** For tests: forget the in-memory index (the next call reloads it from disk). */
export function _reset(): void {
  index = null;
  synced = false;
}

/** Load the library and apply git / seed sources once per process. Returns the index. */
export function ensureLibrary(): LibIndex {
  const idx = loadIndex();
  if (!synced) {
    synced = true;
    try {
      if (syncSources()) saveIndex();
    } catch (err) {
      console.error('[maplib] synchronisation des sources impossible :', err);
    }
  }
  return idx;
}
export const getSettings = (): LibSettings => ensureLibrary().settings;
export function setSettings(patch: Partial<LibSettings> = {}): LibSettings {
  const idx = ensureLibrary();
  if ('publishAdminOnly' in patch) idx.settings.publishAdminOnly = !!patch.publishAdminOnly;
  saveIndex();
  return idx.settings;
}

/** Meta with the admin's overrides applied (names, tags, description…). */
export function effective(m: LibMeta): LibMeta;
export function effective(m: LibMeta | null | undefined): LibMeta | null;
export function effective(m: LibMeta | null | undefined): LibMeta | null {
  return m ? { ...m, ...(m.overrides || {}) } : null;
}
/** Live (not deleted) entry meta, or null. */
export function getMeta(slug: unknown, { withDeleted = false }: { withDeleted?: boolean } = {}): LibMeta | null {
  const m = ensureLibrary().maps[cleanSlug(slug)];
  return m && (withDeleted || !m.deleted) ? m : null;
}
/** Version content ({ walls, lights, regions, entry?, geometry }) — the current one by default. */
export function getVersion(slug: unknown, version?: number | string | null): (LibVersion & { version: number }) | null {
  const m = getMeta(slug, { withDeleted: true });
  if (!m) return null;
  const n = version == null ? m.version : Number(version);
  const v = readVersions(m.slug).versions[n];
  return v ? { ...v, version: n } : null;
}

/**
 * Add a new version (the previous current one goes to the history, 5 kept). `by` = { kind: 'git'|'seed'|'admin'|'gm', … }.
 * `geometry` (optional) replaces the entry's grid geometry for this version.
 */
function pushVersion(m: LibMeta, content: unknown, { by, origin, geometry, note }: { by?: LibBy | null; origin?: string; geometry?: LibGeometry; note?: string } = {}): number {
  const data = readVersions(m.slug);
  const at = new Date().toISOString();
  if (m.version && data.versions[m.version]) {
    m.history = [{ version: m.version, at: m.versionInfo?.at || at, by: m.versionInfo?.by || null, origin: m.versionInfo?.origin || m.origin, counts: m.counts || versionCounts(data.versions[m.version]) }, ...(m.history || [])].slice(0, HISTORY_MAX);
  }
  const n = Math.max(m.version || 0, ...Object.keys(data.versions).map(Number).filter(Number.isFinite)) + 1;
  const geo = geometry || pickGeometry(m);
  data.versions[n] = { ...cleanVersion(content), geometry: geo };
  const keep = new Set([n, ...(m.history || []).map((h) => h.version)]);
  for (const k of Object.keys(data.versions)) if (!keep.has(Number(k))) delete data.versions[k];
  writeVersions(m.slug, data);
  Object.assign(m, geo);
  m.version = n;
  m.counts = versionCounts(data.versions[n]);
  m.versionInfo = { at, by: by || null, origin: origin || m.origin, ...(note ? { note } : {}) };
  m.updatedAt = at;
  return n;
}
const pickGeometry = (m: LibMeta): LibGeometry => ({ gridPx: m.gridPx, imageW: m.imageW, imageH: m.imageH, offsetX: m.offsetX || 0, offsetY: m.offsetY || 0, width: m.width, height: m.height });

function createEntry(
  slug: string,
  info: LibInfo,
  geometry: LibGeometry,
  content: unknown,
  { origin, originRef, image = null, imagePath = null, thumbPath = null, by }: {
    origin: string; originRef?: LibOriginRef | null; image?: string | null; imagePath?: string | null; thumbPath?: string | null; by: LibBy;
  },
): LibMeta {
  const m: LibMeta = {
    id: `lib_${slug}`, slug, ...info, image, imagePath, thumbPath, ...geometry,
    version: 0, origin, originRef: originRef || null, createdAt: new Date().toISOString(), history: [],
  };
  index!.maps[slug] = m;
  pushVersion(m, content, { by, origin, geometry });
  return m;
}

// ---------------------------------------------------------------------------
// Sources: git data/maplib/*.json and the Foundry fragmaps-free seed scenes
// ---------------------------------------------------------------------------
/** Library files of the git folder: [{ file, slug, raw, hash }]. library.json and sub-folders are not entries. */
export function gitFiles(dir: string = GIT_DIR): GitFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: GitFile[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f === 'library.json' || f.startsWith('.')) continue;
    const file = path.join(dir, f);
    let text: string;
    try {
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let raw: any; // written by people and tools
    try {
      raw = JSON.parse(text);
    } catch (err) {
      console.warn(`[maplib] ${f} : JSON invalide (${(err as Error).message}), ignoré`);
      continue;
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.walls)) continue;
    const slug = cleanSlug(raw.slug) || cleanSlug(f.slice(0, -5));
    if (!slug) {
      console.warn(`[maplib] ${f} : slug invalide, ignoré`);
      continue;
    }
    out.push({ file: f, slug, raw, hash: sha(text) });
  }
  return out;
}

function applyGit({ file, slug, raw, hash }: GitFile): boolean {
  const info = cleanInfo(raw, slug);
  const geometry = cleanGeometry(raw);
  const content = cleanVersion(raw);
  const image = cleanFileName(raw.image) || null;
  const imagePath = cleanRel(raw.imagePath) || null;
  const ref = { kind: 'git', file, hash, version: Number(raw.version) || 1 };
  const m = index!.maps[slug];
  if (!m) {
    createEntry(slug, info, geometry, content, { origin: 'git', originRef: ref, image, imagePath, by: { kind: 'git' } });
    return true;
  }
  if (m.deleted) return false;
  if (m.origin === 'git' || m.origin === 'seed') {
    if (m.originRef?.kind === ref.kind && m.originRef?.hash === hash) return false;
    Object.assign(m, info, { image: image || m.image, imagePath: imagePath || (image ? null : m.imagePath) });
    m.origin = 'git';
    m.originRef = ref;
    delete m.gitNewer;
    pushVersion(m, content, { by: { kind: 'git' }, origin: 'git', geometry });
    return true;
  }
  // Edited (published from a table / rolled back) or uploaded: git never overwrites the walls. Descriptive fields follow git.
  const newer = !(m.originRef?.kind === 'git' && m.originRef.hash === hash);
  const before = JSON.stringify([m.gitNewer, m.name, m.nameFr, m.tags, m.description, m.theme, m.lighting, m.traced, m.source]);
  Object.assign(m, info);
  if (newer) m.gitNewer = { file, hash, version: ref.version };
  else delete m.gitNewer;
  return JSON.stringify([m.gitNewer, m.name, m.nameFr, m.tags, m.description, m.theme, m.lighting, m.traced, m.source]) !== before;
}

/** Basename (lower case) of a Foundry scene image URL /assets/foundry/scenes/<file> or /t/<slug>/assets/foundry/scenes/<file>. */
export function foundrySceneImage(url: unknown): string | null {
  const m = /^(?:\/t\/[a-z0-9-]+)?\/assets\/foundry\/scenes\/([^/?#]+)$/i.exec(String(url || ''));
  if (!m) return null;
  let base = m[1];
  try {
    base = decodeURIComponent(base);
  } catch {}
  return base.toLowerCase();
}
const imageBase = (m: LibMeta): string => String(m.image || m.imagePath || '').split('/').pop()!.toLowerCase();
/** Live fragmaps-free entry showing this image (by file name), or null. */
export function findByImage(base: unknown): LibMeta | null {
  const b = String(base || '').toLowerCase();
  if (!b) return null;
  const all = Object.values(ensureLibrary().maps).filter((m) => !m.deleted && imageBase(m) === b);
  return all.find((m) => m.source === 'fragmaps-free') || all[0] || null;
}

/** Library entry content made from a table map (Foundry import): walls/lights/public regions, no ids from Foundry. */
function contentFromTableMap(map: GameMap): LibVersionContent {
  let n = 0;
  return cleanVersion({
    walls: (map.walls || []).map((w) => ({ ...w, id: `w${++n}`, door: w.door ? { state: 'closed', kind: w.door.kind } : null })),
    lights: (map.lights || []).map((l, i) => ({ ...l, id: `l${i + 1}` })),
    regions: (publicRegions(map.regions) as MapRegion[]).map((r, i) => ({ ...r, id: `r${i + 1}` })),
  });
}
/** Grid geometry of a Foundry-imported table map (image px from its description, else the image file, else 100 px/cell). */
function geometryFromTableMap(map: GameMap, imageFile: string | null): LibGeometry {
  const bg: Partial<NonNullable<GameMap['background']>> = map.background || {};
  const bw = Number(bg.w) || map.width, bh = Number(bg.h) || map.height;
  let imageW = 0, imageH = 0;
  const d = /Image (\d+)×(\d+) px/.exec(String(map.description || ''));
  if (d) [imageW, imageH] = [Number(d[1]), Number(d[2])];
  if ((!imageW || !imageH) && imageFile) {
    const s = imageSize(imageFile);
    if (s) [imageW, imageH] = [s.width, s.height];
  }
  if (!imageW || !imageH) [imageW, imageH] = [Math.round(bw * 100), Math.round(bh * 100)];
  const gridPx = r3(imageW / bw);
  return { gridPx, imageW, imageH, offsetX: r3(-(Number(bg.x) || 0) * gridPx), offsetY: r3(-(Number(bg.y) || 0) * gridPx), width: map.width, height: map.height };
}
/** Library entry created from a Foundry fragmaps-free table map (seed file or a table's own import). Returns the meta. */
export function entryFromFoundryMap(map: GameMap, { origin = 'seed', originRef = null }: { origin?: string; originRef?: LibOriginRef | null } = {}): LibMeta | null {
  const index = ensureLibrary();
  const base = foundrySceneImage(map.background?.url);
  if (!base || !FRAGMAPS_FREE[base]) return null;
  const [nameFr, tags, description] = FRAGMAPS_FREE[base];
  let slug = cleanSlug(slugify(map.name || base.replace(/\.[^.]+$/, ''))) || cleanSlug(base.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-'));
  if (index.maps[slug] && imageBase(index.maps[slug]) !== base) slug = `${slug}-fvtt`;
  if (index.maps[slug]) return index.maps[slug];
  const rel = `foundry/scenes/${String(map.background!.url).split('/').pop()}`;
  const imgFile = safeJoin(GLOBAL_ASSETS_DIR, rel);
  const thumbRel = typeof map.thumb === 'string' && map.thumb.startsWith('/assets/') ? cleanRel(map.thumb.slice('/assets/'.length)) : '';
  const info = cleanInfo({
    name: map.name, nameFr, source: 'fragmaps-free', metersPerCell: map.metersPerCell, theme: map.theme, lighting: map.lighting,
    tags: [...tags.split(' '), 'fragmaps', 'foundry'], description,
    traced: { by: 'foundry', at: '', quality: (map.walls || []).length ? 'good' : 'rough', notes: 'Murs du module Foundry « Fragmaps (free) » importés dans la table.' },
  }, slug);
  return createEntry(slug, info, geometryFromTableMap(map, imgFile), contentFromTableMap(map), {
    origin, originRef, imagePath: rel, thumbPath: thumbRel || null, by: { kind: origin === 'seed' ? 'seed' : 'migration' },
  });
}

function applySeedMap(file: string, map: GameMap, hash: string): boolean {
  const base = foundrySceneImage(map?.background?.url);
  if (!base || !FRAGMAPS_FREE[base]) return false;
  const ref = { kind: 'seed', file, hash };
  const existing = Object.values(index!.maps).find((m) => m.originRef?.kind === 'seed' && m.originRef.file === file) || findByImage(base);
  if (!existing) return !!entryFromFoundryMap(map, { origin: 'seed', originRef: ref });
  if (existing.origin === 'seed' && existing.originRef?.file === file && existing.originRef.hash !== hash && !existing.deleted) {
    existing.originRef = ref;
    pushVersion(existing, contentFromTableMap(map), { by: { kind: 'seed' }, origin: 'seed', geometry: geometryFromTableMap(map, safeJoin(GLOBAL_ASSETS_DIR, existing.imagePath || '')) });
    return true;
  }
  return false;
}

/** Apply git entries then the Foundry seed scenes. Returns true when the index changed. */
export function syncSources(): boolean {
  let changed = false;
  for (const g of gitFiles()) {
    try {
      if (applyGit(g)) changed = true;
    } catch (err) {
      console.error(`[maplib] ${g.file} :`, (err as Error).message);
    }
  }
  if (fs.existsSync(SEED_MAPS_DIR)) {
    for (const f of fs.readdirSync(SEED_MAPS_DIR).filter((x) => /^foundry-.*\.json$/.test(x)).sort()) {
      try {
        const text = fs.readFileSync(path.join(SEED_MAPS_DIR, f), 'utf8');
        if (applySeedMap(f, JSON.parse(text), sha(text))) changed = true;
      } catch (err) {
        console.warn(`[maplib] seed ${f} :`, (err as Error).message);
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Changes (publish, rollback, revert, edit, delete, upload)
// ---------------------------------------------------------------------------
/** New version from a table (« Publier mes corrections »). Throws { key, params } errors. */
export function publish(slug: unknown, content: unknown, by: LibBy, { baseVersion = null, force = false }: { baseVersion?: number | null; force?: boolean } = {}): number {
  const m = getMeta(slug);
  if (!m) throw libError('Carte de bibliothèque introuvable');
  if (!force && baseVersion != null && Number(baseVersion) < m.version) throw libError('La bibliothèque a changé depuis ta dernière synchronisation (v{lib}, ta carte : v{mine})', { lib: m.version, mine: Number(baseVersion) }, 'stale');
  m.origin = 'edited';
  const n = pushVersion(m, content, { by, origin: 'edited' });
  saveIndex();
  return n;
}
/** Make an old version current again (as a new version: the history keeps the replaced one). */
export function rollback(slug: unknown, version: number, by: LibBy): number {
  const m = getMeta(slug);
  if (!m) throw libError('Carte de bibliothèque introuvable');
  const v = getVersion(slug, version);
  if (!v || Number(version) === m.version) throw libError('Version introuvable');
  m.origin = 'edited';
  const n = pushVersion(m, v, { by, origin: 'edited', geometry: v.geometry || pickGeometry(m), note: `rollback v${version}` });
  saveIndex();
  return n;
}
/** « Revenir à la version d'origine »: re-apply the git file (or the Foundry seed scene) and follow it again. */
export function revertToOrigin(slug: unknown, by: LibBy): number {
  const m = getMeta(slug);
  if (!m) throw libError('Carte de bibliothèque introuvable');
  const g = gitFiles().find((x) => x.slug === m.slug);
  if (g) {
    m.origin = 'git';
    m.originRef = { kind: 'git', file: g.file, hash: g.hash, version: Number(g.raw.version) || 1 };
    delete m.gitNewer;
    Object.assign(m, cleanInfo(g.raw, m.slug));
    const n = pushVersion(m, cleanVersion(g.raw), { by, origin: 'git', geometry: cleanGeometry(g.raw), note: 'origin' });
    saveIndex();
    return n;
  }
  if (m.originRef?.kind === 'seed' && m.originRef.file) {
    const file = path.join(SEED_MAPS_DIR, path.basename(m.originRef.file));
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (text) {
      const map: GameMap = JSON.parse(text); // seed scene file
      m.origin = 'seed';
      m.originRef = { kind: 'seed', file: m.originRef.file, hash: sha(text) };
      const n = pushVersion(m, contentFromTableMap(map), { by, origin: 'seed', geometry: geometryFromTableMap(map, safeJoin(GLOBAL_ASSETS_DIR, m.imagePath || '')), note: 'origin' });
      saveIndex();
      return n;
    }
  }
  throw libError('Pas de version d’origine pour cette carte');
}
const PATCH_FIELDS = ['name', 'nameFr', 'tags', 'description', 'theme', 'lighting'] as const;
/** Admin edit of the descriptive fields (kept over later git updates). */
export function patchEntry(slug: unknown, patch: Record<string, unknown> = {}): LibMeta {
  const m = getMeta(slug);
  if (!m) throw libError('Carte de bibliothèque introuvable');
  const o: LibOverrides = { ...(m.overrides || {}) };
  for (const k of PATCH_FIELDS) {
    if (!(k in patch)) continue;
    if (k === 'tags') o.tags = cleanTags(patch.tags);
    else if (k === 'theme') o.theme = oneOf(patch.theme, LIB_THEMES as MapTheme[], m.theme);
    else if (k === 'lighting') o.lighting = oneOf(patch.lighting, LIB_LIGHTINGS as Lighting[], m.lighting);
    else if (k === 'description') o.description = str(patch.description, 4000);
    else if (String(patch[k] || '').trim()) o[k] = str(patch[k], 100).trim();
    else delete o[k];
  }
  m.overrides = o;
  m.updatedAt = new Date().toISOString();
  saveIndex();
  return effective(m);
}
/** Hide an entry (tombstone: git does not bring it back; table maps already made from it keep their image). */
export function deleteEntry(slug: unknown): void {
  const m = getMeta(slug);
  if (!m) throw libError('Carte de bibliothèque introuvable');
  m.deleted = { at: new Date().toISOString() };
  saveIndex();
}
/** New entry for an uploaded image (empty walls: trace them in a table, then publish). */
export function createUploaded({ slug, name, nameFr, source, gridPx, offsetX, offsetY, image, imageW, imageH, metersPerCell, theme, lighting, tags, description }: UploadedEntry): LibMeta {
  const index = ensureLibrary();
  const s = cleanSlug(slug);
  if (!s) throw libError('Identifiant invalide (lettres minuscules, chiffres et tirets)');
  const prev = index.maps[s];
  if (prev && !prev.deleted) {
    // Same slug: new image for an existing entry — a new version with the new grid geometry, same walls.
    const cur = getVersion(s) || { walls: [], lights: [], regions: [] };
    Object.assign(prev, { image, imagePath: null });
    const geometry = cleanGeometry({ gridPx: gridPx || prev.gridPx, imageW, imageH, offsetX: offsetX ?? prev.offsetX, offsetY: offsetY ?? prev.offsetY });
    pushVersion(prev, cur, { by: { kind: 'admin' }, origin: prev.origin, geometry, note: 'image' });
    saveIndex();
    return prev;
  }
  if (prev?.deleted) delete index.maps[s];
  const info = cleanInfo({ name: name || s, nameFr, source: source || 'fragmap', metersPerCell, theme, lighting, tags, description, traced: { by: 'admin', at: new Date().toISOString(), quality: 'rough', notes: 'Image téléversée, murs à tracer.' } }, s);
  const m = createEntry(s, info, cleanGeometry({ gridPx, imageW, imageH, offsetX, offsetY }), { walls: [], lights: [], regions: [] }, { origin: 'upload', originRef: { kind: 'upload' }, image, by: { kind: 'admin' } });
  saveIndex();
  return m;
}
/** Fields of an /admin upload (query strings: foreign values, sanitized here). */
export interface UploadedEntry {
  slug: unknown;
  name?: unknown;
  nameFr?: unknown;
  source?: unknown;
  gridPx?: number;
  offsetX?: number;
  offsetY?: number;
  image: string;
  imageW: number;
  imageH: number;
  metersPerCell?: unknown;
  theme?: unknown;
  lighting?: unknown;
  tags?: unknown;
  description?: unknown;
}
/** Error carrying a translatable key. */
export function libError(key: string, params?: Record<string, string | number>, code?: string): LibError {
  const e = new Error(key) as LibError;
  e.libKey = key;
  e.libParams = params;
  if (code) e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------
/** Public fields of an entry for the GM library browser (no walls, no files on disk). */
export function publicEntry(m: LibMeta) {
  const e = effective(m);
  return {
    id: e.id, slug: e.slug, name: e.name, nameFr: e.nameFr, source: e.source, tags: e.tags || [], description: e.description || '',
    theme: e.theme, lighting: e.lighting, width: e.width, height: e.height, metersPerCell: e.metersPerCell, gridPx: e.gridPx,
    quality: e.traced?.quality || 'rough', traced: e.traced || null, version: e.version, counts: e.counts || null,
    origin: e.origin, updatedAt: e.updatedAt || e.createdAt || null, thumb: libThumbUrl(e.slug),
    hasImage: !!imageFile(e), hasThumb: !!thumbFile(e),
  };
}
/** Admin view: + history, overrides, files, git state. */
/** Slugs that have a git file (one directory read; pass it to adminEntry for a whole list). */
export const gitSlugs = (): Set<string> => new Set(gitFiles().map((g) => g.slug));
export function adminEntry(m: LibMeta, git: Set<string> = gitSlugs()) {
  return {
    ...publicEntry(m), image: m.image || null, imagePath: m.imagePath || null, history: m.history || [], versionInfo: m.versionInfo || null,
    overrides: m.overrides || {}, gitNewer: m.gitNewer || null, originRef: m.originRef || null, imageW: m.imageW, imageH: m.imageH,
    offsetX: m.offsetX || 0, offsetY: m.offsetY || 0,
    canRevert: !!(git.has(m.slug) || (m.originRef?.kind === 'seed' && m.originRef.file)),
  };
}
export function listEntries(): LibMeta[] {
  return Object.values(ensureLibrary().maps).filter((m) => !m.deleted);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function safeJoin(root: string, rel: string | null | undefined): string | null {
  if (!rel) return null;
  const p = path.resolve(root, rel);
  const r = path.resolve(root);
  return p === r || !p.startsWith(r + path.sep) ? null : p;
}
const isFile = (p: string | null): p is string => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
/** Absolute path of the entry's image when it exists, else null. */
export function imageFile(m: LibMeta | null | undefined): string | null {
  if (!m) return null;
  const p = m.image ? safeJoin(IMAGES_DIR, m.image) : m.imagePath ? safeJoin(GLOBAL_ASSETS_DIR, m.imagePath) : null;
  return isFile(p) ? p : null;
}
/** Absolute path of the entry's thumbnail: thumbs/<slug>.jpg|.webp|.png, thumbs/<image name>(.jpg), then thumbPath. */
export function thumbFile(m: LibMeta | null | undefined): string | null {
  if (!m) return null;
  const base = String(m.image || m.imagePath || '').split('/').pop()!;
  const stem = base.replace(/\.[^.]+$/, '');
  const cands = [`${m.slug}.jpg`, `${m.slug}.webp`, `${m.slug}.png`, ...(base ? [base, `${stem}.jpg`, `${base}.jpg`] : [])];
  for (const c of cands) {
    const p = safeJoin(THUMBS_DIR, c);
    if (isFile(p)) return p;
  }
  const tp = m.thumbPath ? safeJoin(GLOBAL_ASSETS_DIR, m.thumbPath) : null;
  return isFile(tp) ? tp : null;
}
/** Grey SVG shown instead of a missing image / thumbnail (sized like the map). */
export function placeholderSvg(m: Partial<LibGeometry> | null | undefined, label: string): string {
  const g = libGeometry(m || {});
  const w = Math.round(Math.min(4000, g.bgW * 20)), h = Math.round(Math.min(4000, g.bgH * 20));
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  const fs2 = Math.max(10, Math.round(Math.min(w, h) / 12));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#1a2129"/>`
    + `<path d="M0 0L${w} ${h}M${w} 0L0 ${h}" stroke="#2c3742" stroke-width="${Math.max(2, fs2 / 6)}"/>`
    + `<text x="50%" y="50%" fill="#7d8b99" font-family="sans-serif" font-size="${fs2}" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text></svg>`;
}

/** Width/height of a JPEG / PNG / WebP / GIF file (header only), or null. */
export function imageSize(file: string): { width: number; height: number; type: 'png' | 'gif' | 'webp' | 'jpeg' } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    if (head.readUInt32BE(0) === 0x89504e47) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), type: 'png' };
    if (head.toString('latin1', 0, 4) === 'GIF8') return { width: head.readUInt16LE(6), height: head.readUInt16LE(8), type: 'gif' };
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      const kind = head.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3), type: 'webp' };
      if (kind === 'VP8 ') return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff, type: 'webp' };
      if (kind === 'VP8L') {
        const b = head.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff), type: 'webp' };
      }
      return null;
    }
    if (head[0] !== 0xff || head[1] !== 0xd8) return null;
    // JPEG: walk the segments up to a SOFn marker.
    let pos = 2;
    const seg = Buffer.alloc(9);
    const size = fs.fstatSync(fd).size;
    for (let i = 0; i < 2000 && pos + 9 <= size; i++) {
      fs.readSync(fd, seg, 0, 9, pos);
      if (seg[0] !== 0xff) return null;
      const marker = seg[1];
      if (marker === 0xff) {
        pos++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      const len = seg.readUInt16BE(2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: seg.readUInt16BE(7), height: seg.readUInt16BE(5), type: 'jpeg' };
      pos += 2 + len;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try {
      fs.closeSync(fd);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Signed image links: ?k=<payload>.<hmac>, payload = { t: tableId, u: userId, s: session tag, e: expiry } or
// { a: 1, s: admin session tag, e } (/admin page). One key covers every library image (they are server-wide).
// ---------------------------------------------------------------------------
export const LINK_TTL = 3600;
const STEP = 1800; // expiries rounded up: the same key for 30 min
export const keyFile = (): string => (process.env.SR_MAPLIB_KEY_FILE ? path.resolve(process.env.SR_MAPLIB_KEY_FILE) : path.join(RUNTIME_DIR, 'maplib-sign.key'));
const keys = new Map<string, Buffer>();
function signingKey(): Buffer {
  const file = keyFile();
  let k = keys.get(file);
  if (k) return k;
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) k = Buffer.from(hex, 'hex');
  } catch {}
  if (!k) {
    k = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, k.toString('hex'), { mode: 0o600 });
    } catch (err) {
      console.error('[maplib] clé de signature non enregistrée (liens valables jusqu’au redémarrage)', (err as Error).message);
    }
  }
  keys.set(file, k);
  return k;
}
const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');
const mac = (payload: string): string => b64(crypto.createHmac('sha256', signingKey()).update('maplib:' + payload).digest());
/** Low-level signer (tests: any payload / expiry). */
export function signRaw(data: unknown): string {
  const payload = b64(JSON.stringify(data));
  return `${payload}.${mac(payload)}`;
}
/** { k, exp } for a table session ({ tableId, userId, session }) or an admin session ({ admin: true, session }). */
export function signKey(
  { tableId, userId, session, admin = false }: { tableId?: string; userId?: string; session: string; admin?: boolean },
  { now = Date.now(), ttl = LINK_TTL }: { now?: number; ttl?: number } = {},
): { k: string; exp: number } {
  const exp = Math.ceil(now / 1000 / STEP) * STEP + ttl;
  return { k: signRaw(admin ? { a: 1, s: session, e: exp } : { t: tableId, u: userId, s: session, e: exp }), exp };
}
/** { ok: true, …payload } | { ok: false, reason: 'missing'|'bad'|'expired' } */
export function verifyKey(k: unknown, { now = Date.now() }: { now?: number } = {}): VerifyResult {
  if (!k || typeof k !== 'string') return { ok: false, reason: 'missing' };
  const [payload, sig] = k.split('.');
  if (!payload || !sig || k.length > 600) return { ok: false, reason: 'bad' };
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad' };
  let data: LinkPayload | null;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad' };
  }
  if (!data || typeof data.e !== 'number' || data.e * 1000 < now) return { ok: false, reason: 'expired' };
  return { ok: true, ...data };
}
// Admin sessions live in server/lib/admin.js: it registers a checker (tag → still logged in?).
let adminAlive: (tag: string) => boolean = () => false;
export function setAdminSessionCheck(fn: unknown): void {
  adminAlive = typeof fn === 'function' ? (fn as (tag: string) => boolean) : () => false;
}
export const isAdminSessionAlive = (tag: unknown): boolean => !!tag && adminAlive(tag as string);
