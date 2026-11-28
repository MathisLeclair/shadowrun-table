// Homes: the apartment behind a lifestyle, drawn with the map tile kit (shared/vision.js tile legend).
// Pure module shared by the server (validation) and the browser (viewer, chooser previews, GM « play map »).
//
// lifestyle.home = { layout: HOME_LAYOUTS id, since: ts, moves: n }   — the layout the player picked for that lifestyle.
// A layout belongs to lifestyle levels (`bases`); when the lifestyle's level changes, the old layout no longer applies
// and the player picks a new one for free. Changing layout on the same level is a move: one month of the level's rent
// (house rule, SR5 has no moving cost — GM moves are free).
//
// Layout templates are ASCII: every tile char of the map legend, plus
//   E entrance door (closed) · d interior door (open) · L locked door · % secret door · G garage shutter
//   0-9 room markers: floor of the room named in `rooms` (flood fill up to walls / doors → the region rectangle).
//   Room `out: true` (corridor, street, shared kitchen) is not part of the home: no add-on is glued onto it.
// Add-ons (garage, workshop, yard…) are modules from lifestyle options (catalog `name`). The top row of a module is
// the wall it shares with the home: the generator tries every free wall (4 rotations) and opens a door there.
//
// i18n: names / descriptions are English UI keys (tk), translated by the caller (buildHome `tr`).
import type { DoorKind, DoorState, LifestyleHome, LifestyleQuality, Lighting, MapDoor, MapLight, MapNote, MapRegion, MapTheme, MapWall, Token } from './types.ts';

const tk = (s: string): string => s;

/** A room of a layout template (marker digit → room). */
export interface HomeRoomSpec {
  /** UI key. */
  name: string;
  /** Floor tile of the room. */
  floor: string;
  /** Not part of the home (corridor, street, shared kitchen): no add-on is glued onto it. */
  out: boolean;
}
/** An apartment layout (HOME_LAYOUTS). */
export interface HomeLayout {
  id: string;
  /** Lifestyle levels it belongs to. */
  bases: string[];
  theme: MapTheme;
  /** UI keys. */
  name: string;
  desc: string;
  /** ASCII template. */
  rows: string[];
  rooms: Record<string, HomeRoomSpec>;
}
/** An add-on module (lifestyle option → room glued onto the home). */
export interface HomeModule {
  key: string;
  /** UI key. */
  name: string;
  /** Template; the top row is the shared wall. */
  rows: string[];
  /** Floor tile of the room. */
  room: string;
  /** State of the door opened in the shared wall. */
  door: 'open' | 'closed' | 'locked' | 'secret';
}
/** Lifestyle fields the home rules read (a Lifestyle, or part of one). */
export interface HomeLifestyleLike {
  id?: string;
  name?: string;
  base?: string | null;
  baseCost?: number | null;
  home?: Partial<LifestyleHome> | null;
  qualities?: Array<Partial<LifestyleQuality>> | null;
}
/** An add-on of a built home (placed or skipped). */
export interface HomePlacement {
  key: string;
  /** Translated name. */
  name: string;
  quality: Partial<LifestyleQuality>;
}
/** The map of a built home (a table-map-shaped object; regions have no gmOnly flag). */
export interface HomeMap {
  id: string;
  name: string;
  folder: string;
  width: number;
  height: number;
  metersPerCell: number;
  tiles: string[];
  doors: MapDoor[];
  walls: MapWall[];
  lights: MapLight[];
  lighting: Lighting;
  regions: Array<Pick<MapRegion, 'id' | 'name' | 'x' | 'y' | 'w' | 'h' | 'color'>>;
  notes: MapNote[];
  tokens: Token[];
  explored: Record<string, string>;
  fog: boolean;
  sharedVision: boolean;
  theme: MapTheme;
}
/** buildHome() result. */
export interface HomeBuild {
  map: HomeMap;
  layout: HomeLayout;
  placed: HomePlacement[];
  skipped: HomePlacement[];
}
/** A parsed template cell. */
interface Cell {
  ch: string;
  attach?: boolean;
  door?: { state: DoorState; kind: DoorKind };
  room?: string;
  out?: boolean;
  addon?: boolean;
}
interface ParsedRegion {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  out: boolean;
}
interface Parsed {
  cells: Map<string, Cell>;
  regions: ParsedRegion[];
  leaks: string[];
  /** Cells of the attach row (set by buildHome before tryPlace). */
  attachLen?: number;
}
interface DoorSpot {
  x: number;
  y: number;
  main: boolean;
  living: boolean;
}
interface Fit {
  overlap: number;
  attachOverlap: number;
  windows: number;
  doors: DoorSpot[];
  main: boolean;
  living: boolean;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------
const L = (id: string, bases: string[], theme: MapTheme, name: string, desc: string, rows: string[], rooms: Record<string, HomeRoomSpec>): HomeLayout => ({ id, bases, theme, name, desc, rows, rooms });
const R = (name: string, floor = '.', out = false): HomeRoomSpec => ({ name, floor, out });

export const HOME_LAYOUTS: Record<string, HomeLayout> = Object.fromEntries([
  // ---- Squatter
  L('squat-floor', ['Squatter'], 'industrial', tk('Abandoned floor'), tk('A squatted room in a condemned building: mattress, crates, rubble.'), [
    '###########',
    '#0........#',
    '#####E#####',
    '#1..r..cc.#',
    '#.........W',
    '#bb...T...#',
    '#bb..r..c.#',
    '#####W#####',
  ], { 0: R(tk('Corridor'), '.', true), 1: R(tk('Squat')) }),
  L('squat-container', ['Squatter'], 'industrial', tk('Converted container'), tk('A shipping container on a vacant lot, a window cut out with a torch.'), [
    '############',
    'E1....T..bb#',
    '#........bb#',
    '###W####W###',
  ], { 1: R(tk('Container')) }),
  L('squat-shared', ['Squatter'], 'industrial', tk('Room in a shared flat'), tk('A room in an overcrowded flat, kitchen shared with the other squatters.'), [
    '###############',
    '#1...m#0..==m=#',
    '#.....d.......#',
    '#bb...#...TT..#',
    '#bb...#...TT..E',
    '###W###########',
  ], { 0: R(tk('Shared kitchen'), '.', true), 1: R(tk('Bedroom')) }),

  // ---- Low
  L('low-studio', ['Low'], 'residential', tk('Studio'), tk('One living room, a kitchenette and a tiny shower room.'), [
    '###W###W###',
    '#1......#~#',
    '#bb.....#=#',
    '#bb..T..d2#',
    '#==m..__#.#',
    '######E####',
  ], { 1: R(tk('Studio')), 2: R(tk('Shower room')) }),
  L('low-two-rooms', ['Low'], 'residential', tk('Narrow one-bedroom'), tk('Separate bedroom, kitchen open onto the living room, windowless bathroom.'), [
    '####W####W####',
    '#2...m#1....=#',
    '#bb...#.....=#',
    '#bb...d.TT..m#',
    '#######.TT...#',
    '#=~~3d.......E',
    '##############',
  ], { 1: R(tk('Living room and kitchen')), 2: R(tk('Bedroom')), 3: R(tk('Bathroom')) }),
  L('low-trailer', ['Low'], 'residential', tk('Mobile home'), tk('A mobile home in a trailer park: long and narrow, but a real door.'), [
    '###W#####W#####',
    '#2bb#1.T..=m#~#',
    '#.bb#.......d3#',
    '#...d...bb..###',
    '#######E#######',
  ], { 1: R(tk('Living area')), 2: R(tk('Bedroom')), 3: R(tk('Shower')) }),

  // ---- Medium
  L('medium-classic', ['Medium'], 'residential', tk('Classic one-bedroom'), tk('Living room with an open kitchen, one bedroom, a bathroom with a tub.'), [
    '###W####W####W###',
    '#2...m#1........#',
    '#bb...#..bbb....W',
    '#bb...d...__....#',
    '#....m#.........#',
    '#######.........#',
    '#~~.3.d.........#',
    '#~~.=.#..T...==m#',
    '########E########',
  ], { 1: R(tk('Living room and kitchen')), 2: R(tk('Bedroom')), 3: R(tk('Bathroom')) }),
  L('medium-family', ['Medium'], 'residential', tk('Two-bedroom'), tk('Two bedrooms at the back, a large living area and a bathroom.'), [
    '###W#####W#####W##',
    '#2...m#3...m#4~~=#',
    '#bb...#...bb#....#',
    '#bb...#...bb#....#',
    '###d#####d####d###',
    '#1...............W',
    '#.bbb..__.TT...==#',
    '#......__.TT....m#',
    'W..........=====m#',
    '#####E############',
  ], { 1: R(tk('Living room')), 2: R(tk('Bedroom')), 3: R(tk('Second bedroom')), 4: R(tk('Bathroom')) }),
  L('medium-loft', ['Medium'], 'residential', tk('Loft'), tk('A former open-plan workshop: pillars, big windows, the bathroom is the only closed room.'), [
    '##WWW####WWW####',
    '#1.....o.......#',
    '#.bbb.......bb.#',
    '#..__.......bb.W',
    '#..__..o.....m.#',
    '#..............#',
    '#==m..TT...#d###',
    '#=....TT...#2.~#',
    '#=.........#=.~#',
    '######E#########',
  ], { 1: R(tk('Loft')), 2: R(tk('Bathroom')) }),

  // ---- High
  L('high-condo', ['High'], 'residential', tk('Condo'), tk('Master suite with bathroom, guest room, study, separate kitchen and a large living room.'), [
    '####WW#####W####WW###',
    '#2......#~~=#3......#',
    '#.bbb...#..4#.bb..m.#',
    '#.bbb..m#...#.bb....#',
    '#.bbb...d...#.......#',
    '#......m#####.......#',
    '####d###########d####',
    '#1...........#5...==#',
    '#..bbbb......d......#',
    'W...___......#.TT..=#',
    '#...___......#.TT..m#',
    '#............####d###',
    '#####d###E###6......W',
    '    #7=~#   #.==..m.#',
    '    #####   #########',
  ], { 1: R(tk('Living room')), 2: R(tk('Master suite')), 3: R(tk('Guest room')), 4: R(tk('Bathroom')), 5: R(tk('Kitchen')), 6: R(tk('Study')), 7: R(tk('Toilet')) }),
  L('high-corner', ['High'], 'residential', tk('Corner apartment'), tk('Glass walls on two sides and a private terrace.'), [
    '#WWWWW#WWWWW#======',
    'W1..........W8,,,,=',
    'W..bbb..__..d,g,,g=',
    'W.......__..W,,,,,=',
    'W.TT.......mW,g,,g=',
    'W.TT.....===#,,,,,=',
    '#####d#############',
    '#5..........E',
    '##d####d###d#',
    '#2...#m3..#4#',
    '#.bb.#..bb#=#',
    '#.bb.#..bb#~#',
    '##W###W######',
  ], { 1: R(tk('Living room')), 2: R(tk('Bedroom')), 3: R(tk('Second bedroom')), 4: R(tk('Bathroom')), 5: R(tk('Hallway')), 8: R(tk('Terrace'), ',') }),
  L('high-townhouse', ['High'], 'residential', tk('Townhouse'), tk('A terraced house: through living room, two bedrooms, a study and an entry airlock.'), [
    '###W####W####W###',
    '#2...m#3...#6..m#',
    '#bb...#..bb#.TT.#',
    '#bb...#..bb#....W',
    '###d####d####d###',
    '#1..............#',
    '#.bbb...__.TT.==#',
    'W.......__.TT..m#',
    '#..........##d####',
    '#####d######=4~~#',
    '    #..E    #####',
    '    ####',
  ], { 1: R(tk('Living room and kitchen')), 2: R(tk('Bedroom')), 3: R(tk('Second bedroom')), 4: R(tk('Bathroom')), 6: R(tk('Study')) }),

  // ---- Luxury
  L('lux-penthouse', ['Luxury'], 'corp', tk('Penthouse'), tk('The top floor of a tower: master suite, home cinema, bar, terrace with a pool.'), [
    '#WWWWWW#WWWWWWWWW#WWWWW#',
    'W2.....#1...........#3.W',
    'W.bbb..#..bbbb....=.#..W',
    'W.bbb..d...__....m=.d..W',
    'W.bbb..#...__.....=.#bbW',
    'W......#..........o.#bbW',
    '##d#####d##d############',
    '#~4=#....#5..==m#7....m#',
    '#~..#....d......d.bbbb.#',
    '#####..e.#..TT..#.____.#',
    '    E....#..TT..#.____.#',
    '    ######......#......#',
    '         #########dd####',
    '         =8,~~~~~,,,,,,=',
    '         =g,~~~~~,,,,g,=',
    '         =,,,,,,,,,,,,,=',
    '         ===============',
  ], { 1: R(tk('Grand lounge')), 2: R(tk('Master suite')), 3: R(tk('Guest room')), 4: R(tk('Bathroom')), 5: R(tk('Kitchen')), 7: R(tk('Home cinema')), 8: R(tk('Terrace'), ',') }),
  L('lux-villa', ['Luxury'], 'residential', tk('Villa'), tk('A secured villa in a corporate enclave: patio, garden, en-suite bedrooms.'), [
    '#####WW#####WW#####WW####',
    '#2.....#4~=#3.....#9....#',
    '#.bbb..#...#..bb..#.TT..W',
    '#.bbb..d...#..bb..#.TT.m#',
    '#.bbb..#####......#....m#',
    '#......#   #.....m#....m#',
    '###d####   ###d######d###',
    '#1......................#',
    '#..bbbb.....____........W',
    'W..........o____o.......#',
    '#..TTT......____....==m=#',
    '#..TTT..................#',
    '##########dd#######E#####',
    ' ggg8gggggggggggggg,,,,,',
    ' gtggggg~~~~~ggggtg,,,,,',
    ' ggggggg~~~~~gggggg,,,,,',
    ' ggggggggggggggggggg,,,,',
  ], { 1: R(tk('Living room and kitchen')), 2: R(tk('Master suite')), 3: R(tk('Guest room')), 4: R(tk('Bathroom')), 8: R(tk('Garden'), 'g'), 9: R(tk('Study')) }),

  // ---- Bolt Hole
  L('bolt-backroom', ['Bolt Hole'], 'industrial', tk('Back room'), tk('Behind a laundromat: a service door, a camp bed, an emergency exit.'), [
    '##############',
    '#0.mmmm.mmmm.#',
    '#............E',
    '#.mmmm..mmmm.#',
    '######%#######',
    '#1.bb...cc.=.#',
    '#..bb......=.#',
    '#.......T....E',
    '##############',
  ], { 0: R(tk('Laundromat'), '.', true), 1: R(tk('Bolt Hole')) }),
  L('bolt-basement', ['Bolt Hole'], 'industrial', tk('Basement'), tk('A cellar under a building: pipes, boiler, a mattress and a generator.'), [
    '############',
    '#1..mm..ss.#',
    '#.......ss.#',
    '#bb..c.....#',
    '#bb..cc..=.#',
    '#...T....=.#',
    '######L#####',
  ], { 1: R(tk('Cellar')) }),

  // ---- Traveler
  L('travel-motel', ['Traveler'], 'residential', tk('Motel room'), tk('A roadside room rented by the month, with the parking spot in front of the door.'), [
    '##########',
    '#1..m#~=2#',
    'W....d...#',
    '#bb..#####',
    '#bb.TW',
    '###E##',
    ',,,,,,,',
    ',0,,,,,',
  ], { 0: R(tk('Parking lot'), ',', true), 1: R(tk('Bedroom')), 2: R(tk('Shower room')) }),
  L('travel-rv', ['Traveler'], 'residential', tk('VR'), tk('A home on wheels: bunk at the back, kitchenette, shower, and the open road ahead.'), [
    '##W###W###W##',
    '#bb.=m.T.#2~#',
    '#bb.1....d..#',
    '#####E#######',
  ], { 1: R(tk('Cabin')), 2: R(tk('Shower')) }),

  // ---- Commercial
  L('com-shop', ['Commercial'], 'street', tk('Shop'), tk('A shopfront on the street, a counter, the stockroom and an office at the back.'), [
    '#################',
    '#2.mm.mm#3..=m..#',
    '#.......d..TT...#',
    '#cc..c.c#.......#',
    '####d#######d####',
    '#1..............#',
    '#.mm..mm..mm..=.#',
    '#.mm..mm..mm..=.#',
    '#.............=.#',
    'WWWWWWEEWWWWWWWWW',
    ',,,,,,,,,,,,,,,,,',
    ',0,,,,,,,,,,,,,,,',
  ], { 0: R(tk('Street'), ',', true), 1: R(tk('Shop')), 2: R(tk('Pool')), 3: R(tk('Study')) }),
  L('com-office', ['Commercial'], 'corp', tk('Offices'), tk('An office floor: reception, open space, meeting room and a private office.'), [
    '###WW###WW###WW###',
    '#1...=...#2..TT..#',
    '#....=...d...TT..#',
    '#.bb.....#.......W',
    '####d#####d#######',
    '#3.TT..TT..TT.#4.#',
    '#..TT..TT..TT.d.m#',
    '#.............#..#',
    '#######E##########',
  ], { 1: R(tk('Home')), 2: R(tk('Meeting room')), 3: R(tk('Open space')), 4: R(tk('Study')) }),

  // ---- Hospitalized
  L('hospital-room', ['Hospitalized'], 'lab', tk('Hospital room'), tk('A private room: hospital bed, monitors, shower room.'), [
    '###########',
    '#1.m.bb.mm#',
    '#....bb...W',
    '#T........#',
    '##d####E###',
    '#=2#0.....#',
    '#~.#......#',
    '###########',
  ], { 0: R(tk('Hospital corridor'), '.', true), 1: R(tk('Bedroom')), 2: R(tk('Shower room')) }),
].map((x) => [x.id, x]));

/** Layouts available for a lifestyle level (Street: none — no home to draw). */
export function homeLayoutsFor(base: unknown): HomeLayout[] {
  const b = String(base || '');
  return Object.values(HOME_LAYOUTS).filter((x) => x.bases.includes(b));
}

/** The layout the lifestyle lives in, or null (none chosen yet / chosen for another level). */
export function homeLayout(l: HomeLifestyleLike | null | undefined): HomeLayout | null {
  const id = l?.home?.layout;
  const x = id && Object.prototype.hasOwnProperty.call(HOME_LAYOUTS, id) ? HOME_LAYOUTS[id] : null;
  return x && x.bases.includes(String(l?.base || '')) ? x : null;
}

/** Moving fee (house rule): one month of the level's rent, without options or contracts. */
export const HOME_MOVE_COST: Record<string, number> = { Squatter: 500, Low: 2000, Medium: 5000, High: 10000, Luxury: 100000, 'Bolt Hole': 1000, Traveler: 3000, Commercial: 8000, Hospitalized: 500 };
export function homeMoveCost(l: HomeLifestyleLike | null | undefined): number {
  return HOME_MOVE_COST[String(l?.base || '')] ?? Math.max(0, Math.round(Number(l?.baseCost) || 0));
}

/** Stored `home` from untrusted input (GM edits): { layout, since, moves, mapId?, addons? } or null. */
export function sanitizeHome(input: unknown): LifestyleHome | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const h = input as Record<string, unknown>;
  const layout = String(h.layout || '').slice(0, 40);
  if (!Object.prototype.hasOwnProperty.call(HOME_LAYOUTS, layout)) return null;
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const out: LifestyleHome = { layout, since: n(h.since), moves: Math.min(999, n(h.moves)) };
  if (typeof h.mapId === 'string' && h.mapId) out.mapId = h.mapId.slice(0, 80);
  if (typeof h.addons === 'string') out.addons = h.addons.slice(0, 400);
  return out;
}

// ---------------------------------------------------------------------------
// Add-on modules (lifestyle options → rooms glued onto the home)
// ---------------------------------------------------------------------------
// door: state of the door opened in the shared wall. Top row = the shared wall.
const M = (key: string, name: string, rows: string[], room = '.', door: HomeModule['door'] = 'open'): HomeModule => ({ key, name, rows, room, door });
const MODULES: Record<string, HomeModule> = {
  garageSmall: M('garageSmall', tk('Garage'), [
    '#######',
    '#1....#',
    '#.vv.=#',
    '#.vv.=#',
    '#.vv.m#',
    '#.vv..#',
    '#.....#',
    '##GG###',
  ], ',', 'closed'),
  garageSmallCramped: M('garageSmallCramped', tk('Garage'), [
    '######',
    '#1.vv#',
    '#..vv#',
    '#..vv#',
    '#=.vv#',
    '###GG#',
  ], ',', 'closed'),
  garageLarge: M('garageLarge', tk('Large garage'), [
    '#########',
    '#1......#',
    '#.vvv..=#',
    '#.vvv..=#',
    '#.vvv..m#',
    '#.vvv..m#',
    '#.vvv...#',
    '#.......#',
    '##GGG####',
  ], ',', 'closed'),
  garageLargeCramped: M('garageLargeCramped', tk('Large garage'), [
    '#######',
    '#1vvv.#',
    '#.vvv.#',
    '#.vvv.#',
    '#.vvv.#',
    '#.....#',
    '##GGG##',
  ], ',', 'closed'),
  stable: M('stable', tk('Stable'), [
    '#########',
    '#1......#',
    '#.......#',
    '#.=.=.=.#',
    '#g=g=g=g#',
    '#g=g=g=g#',
    '###GG####',
  ], '.', 'closed'),
  boat: M('boat', tk('Boathouse'), [
    '#########',
    '#1......#',
    '#.~~~~~.#',
    '#.~~~~~.#',
    '#.~~~~~.#',
    '#.~~~~~.#',
    '##GGGGG##',
  ], '.', 'closed'),
  heli: M('heli', tk('Helipad'), [
    '==========',
    '=1,,,,,,,=',
    '=,,,,,,,,=',
    '=,,,xx,,,=',
    '=,,,xx,,,=',
    '=,,,,,,,,=',
    '=,,,,,,,,=',
    '==========',
  ], ',', 'closed'),
  plane: M('plane', tk('Aircraft hangar'), [
    '#############',
    '#1..........#',
    '#...........#',
    '#..vvvvvvv..#',
    '#..vvvvvvv..#',
    '#..vvvvvvv.m#',
    '#..........m#',
    '#..........c#',
    '##GGGGGGGGG##',
  ], ',', 'closed'),
  workshop: M('workshop', tk('Workshop'), [
    '#########',
    '#1......#',
    '#==...mm#',
    '#.......#',
    '#.TT..c.#',
    '#.TT..cc#',
    '#==..===#',
    '#########',
  ]),
  workshopCramped: M('workshopCramped', tk('Workshop'), [
    '#######',
    '#1....#',
    '#==.mm#',
    '#.....#',
    '#=..cc#',
    '#######',
  ]),
  armory: M('armory', tk('Armorer'), [
    '#######',
    '#1....#',
    '#m...m#',
    '#m.T.m#',
    '#m...m#',
    '#######',
  ], '.', 'locked'),
  panic: M('panic', tk('Panic room'), [
    '######',
    '#1..m#',
    '#b..m#',
    '#b...#',
    '######',
  ], '.', 'locked'),
  gym: M('gym', tk('Gym'), [
    '#########',
    '#1......#',
    '#._____.#',
    '#._____m#',
    '#._____m#',
    '#.......W',
    '#########',
  ]),
  pool: M('pool', tk('Swimming pool'), [
    '###########',
    '#1........#',
    '#.~~~~~~~.W',
    '#.~~~~~~~.#',
    '#.~~~~~~~.W',
    '#.........#',
    '#bb.....T.#',
    '###########',
  ]),
  arboretum: M('arboretum', tk('Arboretum'), [
    '#########',
    '#1......#',
    '#.gtg.g.#',
    '#.ggg.gt#',
    '#.......#',
    '#.tg.ggg#',
    '#WWWWWWW#',
  ], 'g'),
  greenhouse: M('greenhouse', tk('Greenhouse'), [
    '#########',
    '#1......#',
    'W.==.==.W',
    'W.gg.gg.W',
    'W.gg.gg.W',
    'W.......W',
    '#WWWWWWW#',
  ]),
  yard: M('yard', tk('Yard'), [
    '=========',
    '=1,,,,,,=',
    '=gggg,gg=',
    '=ggtgggg=',
    '=gggggg,=',
    '=========',
  ], ','),
  range: M('range', tk('Shooting range'), [
    '##############',
    '#1..=.......m#',
    '#...=.......m#',
    '#...........m#',
    '##############',
  ], '.', 'closed'),
  court: M('court', tk('Sports court'), [
    '############',
    '#1.........#',
    '#.________.#',
    '#.________.#',
    '#.________.#',
    '#.________.#',
    '#.________.#',
    '#..........#',
    '############',
  ]),
  privateRoom: M('privateRoom', tk('Private room'), [
    '######',
    '#1..m#',
    '#....W',
    '#bb..#',
    '#bb..#',
    '######',
  ], '.', 'closed'),
  batcave: M('batcave', tk('Bat cave'), [
    '########',
    '#1.....#',
    '#m....=#',
    '#..TT..#',
    '#..TT.c#',
    '########',
  ], '.', 'secret'),
  zen: M('zen', tk('Zen den'), [
    '######',
    '#1.g.#',
    '#.__.#',
    '#.__.#',
    '#g..g#',
    '######',
  ], '.', 'closed'),
  freezer: M('freezer', tk('Walk-in freezer'), [
    '#####',
    '#1mm#',
    '#...#',
    '#mmm#',
    '#####',
  ], '.', 'closed'),
  tunnel: M('tunnel', tk('Escape tunnel'), [
    '#####',
    '#1..#',
    '#.ss#',
    '#.ss#',
    '#####',
  ], '.', 'secret'),
  hole: M('hole', tk('Secret hideout'), [
    '####',
    '#1c#',
    '#..#',
    '####',
  ], '.', 'secret'),
};

/** Module key for a lifestyle option (catalog English `name`), or null (contracts, services, negatives…). */
export function homeModuleKey(q: { name?: string } | null | undefined): string | null {
  const n = String(q?.name || '');
  const cramped = /^Cramped /i.test(n);
  if (/Garage \(Car \(Body 4/i.test(n)) return cramped ? 'garageSmallCramped' : 'garageSmall';
  if (/Garage \(Car \(Body 5/i.test(n)) return cramped ? 'garageLargeCramped' : 'garageLarge';
  if (/Garage \(Stable\)/i.test(n)) return 'stable';
  if (/Garage \(Boat\)/i.test(n)) return 'boat';
  if (/Garage \(Helicopter\)/i.test(n)) return 'heli';
  if (/Garage \(Airplane\)/i.test(n)) return 'plane';
  if (/Workshop\/Facility/i.test(n)) return cramped ? 'workshopCramped' : 'workshop';
  if (/^Special Work Area/i.test(n)) return 'workshop';
  if (/^Armory/i.test(n)) return 'armory';
  if (/^Panic Room/i.test(n)) return 'panic';
  if (/^Gym/i.test(n)) return 'gym';
  if (/^Swimming Pool/i.test(n)) return 'pool';
  if (/^Indoor Arboretum/i.test(n)) return 'arboretum';
  if (/^Greenhouse/i.test(n)) return 'greenhouse';
  if (/^Yard/i.test(n)) return 'yard';
  if (/^Shooting Range/i.test(n)) return 'range';
  if (/^Sports Court/i.test(n)) return 'court';
  if (/^Private Room/i.test(n)) return 'privateRoom';
  if (/^Bat Cave/i.test(n)) return 'batcave';
  if (/^Zen Den/i.test(n)) return 'zen';
  if (/^Walk-In Freezer/i.test(n)) return 'freezer';
  if (/^Escape Tunnel/i.test(n)) return 'tunnel';
  if (/^Dug a Hole/i.test(n)) return 'hole';
  return null;
}

/** Options of the lifestyle that become rooms: [{ key, quality }]. */
export function homeAddons(l: HomeLifestyleLike | null | undefined): Array<{ key: string; quality: Partial<LifestyleQuality> }> {
  const out: Array<{ key: string; quality: Partial<LifestyleQuality> }> = [];
  for (const q of Array.isArray(l?.qualities) ? l!.qualities! : []) {
    const key = homeModuleKey(q);
    if (key) out.push({ key, quality: q });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
const DOOR_CHARS: Record<string, { state: DoorState; kind: DoorKind }> = { E: { state: 'closed', kind: 'door' }, d: { state: 'open', kind: 'door' }, L: { state: 'locked', kind: 'door' }, '%': { state: 'closed', kind: 'secret' }, G: { state: 'closed', kind: 'shutter' } };
const WALLISH = new Set(['#', 'W', '=']);
const WALL_RANK: Record<string, number> = { '=': 1, W: 2, '#': 3 };
const WALKABLE = new Set(['.', ',', '_', 'g', 's', 'e', 'r', 'x']);
const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Parse a template into cells: Map key → { ch (tile), door?, room? (marker digit), out?, attach? }.
 * Room markers become the room's floor; rooms are flood-filled (through furniture, not through walls / doors).
 */
function parse(rows: string[], rooms: Record<string, HomeRoomSpec>, { attachRow = false, rot = 0 }: { attachRow?: boolean; rot?: number } = {}): Parsed {
  // Mark the attach row (top row) before rotating: corners excluded.
  const marked: Array<Array<{ c: string; attach?: boolean }>> = rows.map((s, y) => [...s].map((c, x) => ({ c, attach: attachRow && y === 0 && x > 0 && x < s.length - 1 })));
  let g = marked;
  for (let k = 0; k < (rot & 3); k++) {
    const h = g.length, w = Math.max(...g.map((row) => row.length));
    const n = Array.from({ length: w }, () => Array.from({ length: h }, () => ({ c: ' ' })));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) n[x][h - 1 - y] = g[y][x] ?? { c: ' ' };
    g = n;
  }
  const cells = new Map<string, Cell>();
  const markers: Array<{ x: number; y: number; id: string }> = [];
  g.forEach((row, y) => row.forEach((cell, x) => {
    const c = cell.c;
    if (c === ' ' || c === undefined) return;
    const out: Cell = { ch: c, attach: !!cell.attach };
    if (DOOR_CHARS[c]) {
      out.ch = 'D';
      out.door = DOOR_CHARS[c];
    } else if (c >= '0' && c <= '9') {
      const spec = rooms[c] || R('');
      out.ch = spec.floor || '.';
      markers.push({ x, y, id: c });
    } else if (c === ';') out.ch = ',';
    cells.set(key(x, y), out);
  }));
  // Rooms: flood fill from each marker.
  const regions: ParsedRegion[] = [];
  const leaks: string[] = [];
  for (const m of markers) {
    const spec = rooms[m.id] || R('');
    const seen = new Set([key(m.x, m.y)]);
    const stack: Array<[number, number]> = [[m.x, m.y]];
    let x0 = m.x, y0 = m.y, x1 = m.x, y1 = m.y;
    while (stack.length) {
      const [x, y] = stack.pop()!;
      const c = cells.get(key(x, y))!;
      if (c.room && c.room !== m.id) leaks.push(`${c.room}/${m.id}`);
      c.room = m.id;
      if (spec.out) c.out = true;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k2 = key(x + dx, y + dy);
        if (seen.has(k2)) continue;
        const n = cells.get(k2);
        if (!n || n.door || WALLISH.has(n.ch)) continue;
        seen.add(k2);
        stack.push([x + dx, y + dy]);
      }
    }
    regions.push({ id: m.id, name: spec.name, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, out: !!spec.out });
  }
  return { cells, regions, leaks };
}

/** Template problems of a layout (tests): rooms flooding into each other through a wall gap. */
export function layoutIssues(id: string): string[] {
  const lay = HOME_LAYOUTS[id];
  return lay ? parse(lay.rows, lay.rooms).leaks.map((x) => `rooms ${x} touch`) : ['unknown layout'];
}

/** Where `mod` (parsed, rotated) can sit with offset (ox, oy) against the existing cells; null when it can't. */
function tryPlace(world: Map<string, Cell>, reserved: Set<string>, mod: Parsed, ox: number, oy: number): Fit | null {
  let overlap = 0, attachOverlap = 0, windows = 0;
  const doors: DoorSpot[] = [];
  for (const [k, c] of mod.cells) {
    const [lx, ly] = k.split(',').map(Number);
    const x = lx + ox, y = ly + oy;
    const e = world.get(key(x, y));
    if (!e) {
      if (reserved.has(key(x, y))) return null;
      continue;
    }
    if (!WALLISH.has(e.ch) || !WALLISH.has(c.ch) || e.door) return null;
    overlap++;
    if (e.ch === 'W') windows++;
    if (!c.attach) continue;
    attachOverlap++;
    // Door: home floor on one side, module floor on the other (perpendicular to the shared wall).
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const inner = mod.cells.get(key(lx + dx, ly + dy));
      const outer = world.get(key(x - dx, y - dy));
      if (inner && WALKABLE.has(inner.ch) && !mod.cells.has(key(lx - dx, ly - dy)) && outer && WALKABLE.has(outer.ch) && !outer.out && !outer.door) {
        doors.push({ x, y, main: !outer.addon, living: !outer.addon && outer.room === '1' });
        break;
      }
    }
  }
  const attachLen = mod.attachLen as number;
  if (!doors.length || attachOverlap < Math.min(3, attachLen)) return null;
  // A door onto the home itself beats one through another add-on (no maze of rooms opening into each other).
  const onMain = doors.filter((d) => d.main);
  const onLiving = onMain.filter((d) => d.living);
  return { overlap, attachOverlap, windows, doors: onLiving.length ? onLiving : onMain.length ? onMain : doors, main: onMain.length > 0, living: onLiving.length > 0 };
}

function bounds(world: Map<string, unknown>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of world.keys()) {
    const [x, y] = k.split(',').map(Number);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Build the map of a lifestyle's home. layoutId defaults to the chosen one.
 * → { map, layout, placed: [{ key, name, quality }], skipped: [{ key, name, quality }] } or null (no layout).
 * `tr` translates the French names (rooms, add-ons, layout) — identity by default.
 */
export function buildHome(
  l: HomeLifestyleLike | null | undefined,
  layoutId: string | null = null,
  { tr = (s: string) => s, id = null }: { tr?: (s: string) => string; id?: string | null } = {},
): HomeBuild | null {
  const layout = layoutId ? HOME_LAYOUTS[layoutId] : homeLayout(l);
  if (!layout) return null;
  const main = parse(layout.rows, layout.rooms);
  const world = new Map(main.cells);
  const regions: Array<{ id: string; name: string; x: number; y: number; w: number; h: number; out?: boolean; addon?: boolean }> =
    main.regions.map((r) => ({ ...r, name: tr(r.name) }));
  const doors: MapDoor[] = [];
  // Keep the outside of every entrance free (2 cells), so no add-on walls it in.
  const reserved = new Set<string>();
  for (const [k, c] of world) {
    if (!c.door || c.door.kind === 'secret') continue;
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (world.has(key(x + dx, y + dy))) continue;
      reserved.add(key(x + dx, y + dy));
      reserved.add(key(x + 2 * dx, y + 2 * dy));
      reserved.add(key(x + dx + (dy ? 1 : 0), y + dy + (dx ? 1 : 0)));
      reserved.add(key(x + dx - (dy ? 1 : 0), y + dy - (dx ? 1 : 0)));
    }
  }
  const placed: HomePlacement[] = [], skipped: HomePlacement[] = [];
  const addons = homeAddons(l).map((a, i) => ({ ...a, i, mod: MODULES[a.key] }));
  const area = (m: HomeModule): number => m.rows.length * Math.max(...m.rows.map((r) => r.length));
  addons.sort((a, b) => area(b.mod) - area(a.mod) || a.i - b.i);
  for (const a of addons) {
    const name = tr(a.mod.name);
    let best: { score: number; rot: number; ox: number; oy: number; parsed: Parsed; fit: Fit } | null = null;
    const b = bounds(world);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    for (let rot = 0; rot < 4; rot++) {
      const parsed = parse(a.mod.rows, { 1: R(a.mod.name, a.mod.room) }, { attachRow: true, rot });
      const mb = bounds(parsed.cells);
      const mw = mb.x1 + 1, mh = mb.y1 + 1;
      parsed.attachLen = [...parsed.cells.values()].filter((c) => c.attach).length;
      for (let oy = b.y0 - mh + 1; oy <= b.y1; oy++)
        for (let ox = b.x0 - mw + 1; ox <= b.x1; ox++) {
          const fit = tryPlace(world, reserved, parsed, ox, oy);
          if (!fit) continue;
          const nx0 = Math.min(b.x0, ox), ny0 = Math.min(b.y0, oy), nx1 = Math.max(b.x1, ox + mw - 1), ny1 = Math.max(b.y1, oy + mh - 1);
          const grow = (nx1 - nx0 + 1) * (ny1 - ny0 + 1) - (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
          const dist = Math.abs(ox + mw / 2 - cx) + Math.abs(oy + mh / 2 - cy);
          const score = (fit.main ? 40 : 0) + (fit.living ? 12 : 0) + fit.attachOverlap * 4 + fit.overlap - grow * 0.05 - fit.windows * 3 - dist * 0.1;
          if (!best || score > best.score + 1e-9) best = { score, rot, ox, oy, parsed, fit };
        }
    }
    if (!best) {
      skipped.push({ key: a.key, name, quality: a.quality });
      continue;
    }
    const { parsed, ox, oy, fit } = best;
    for (const [k, c] of parsed.cells) {
      const [lx, ly] = k.split(',').map(Number);
      const wk = key(lx + ox, ly + oy);
      const e = world.get(wk);
      if (e) {
        const ch = (WALL_RANK[c.ch] || 0) > (WALL_RANK[e.ch] || 0) ? c.ch : e.ch;
        world.set(wk, { ...e, ch: ch === 'W' ? '#' : ch });
      } else world.set(wk, { ...c, attach: false, addon: true });
    }
    // The door nearest the middle of the shared wall.
    const mid = fit.doors.reduce((s, d) => ({ x: s.x + d.x / fit.doors.length, y: s.y + d.y / fit.doors.length }), { x: 0, y: 0 });
    const d = fit.doors.slice().sort((p, q) => Math.hypot(p.x - mid.x, p.y - mid.y) - Math.hypot(q.x - mid.x, q.y - mid.y))[0];
    const kind = a.mod.door === 'secret' ? 'secret' : 'door';
    world.set(key(d.x, d.y), { ch: 'D', door: { state: a.mod.door === 'secret' ? 'closed' : a.mod.door, kind } });
    for (const r of parsed.regions) regions.push({ id: `${a.key}${a.i}`, name, x: r.x + ox, y: r.y + oy, w: r.w, h: r.h, addon: true });
    placed.push({ key: a.key, name, quality: a.quality });
  }

  // To a 0-based tile map.
  const b = bounds(world);
  const width = b.x1 - b.x0 + 1, height = b.y1 - b.y0 + 1;
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '));
  let n = 0;
  for (const [k, c] of world) {
    const [x, y] = k.split(',').map(Number);
    const X = x - b.x0, Y = y - b.y0;
    grid[Y][X] = c.ch;
    if (c.door) doors.push({ id: `hd${++n}`, x: X, y: Y, state: c.door.state, kind: c.door.kind });
  }
  doors.sort((p, q) => p.y - q.y || p.x - q.x);
  const map: HomeMap = {
    id: id || `home_${l?.id || 'x'}`,
    name: `${l?.name || ''}${l?.name ? ' — ' : ''}${tr(layout.name)}`,
    folder: '',
    width,
    height,
    metersPerCell: 1,
    tiles: grid.map((r) => r.join('')),
    doors,
    walls: [],
    lights: [],
    lighting: 'bright',
    regions: regions.map((r, i) => ({ id: `hr${i + 1}`, name: r.name, x: r.x - b.x0, y: r.y - b.y0, w: r.w, h: r.h, ...(r.addon ? { color: '#e0a63f' } : {}) })),
    notes: [],
    tokens: [],
    explored: {},
    fog: false,
    sharedVision: true,
    theme: layout.theme,
  };
  return { map, layout, placed, skipped };
}

/** Living surface of a built home (walkable or furnished cells of the home, outside rooms excluded), in m². */
export function homeArea(map: { tiles: string[]; metersPerCell?: number | null }): number {
  let n = 0;
  for (const row of map.tiles) for (const ch of row) if (ch !== ' ' && ch !== '#' && ch !== 'W' && ch !== 'D') n++;
  return Math.round(n * (map.metersPerCell || 1) ** 2);
}
