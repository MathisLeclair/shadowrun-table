// Local types of the map folder that shared/types.ts does not cover (yet): the map library API shapes
// (server/lib/maplib.js publicEntry, server/modules/22-maplib.js maps/libraryDiff, shared/maplib.js libraryDiff).
import type { Lighting, MapTheme, MapWall, MapLight, MapRegion } from '../../../shared/types.ts';

export type LibSource = 'fragmap' | 'fragmaps-free';
export type LibQuality = 'good' | 'rough';

export interface LibCounts {
  walls: number;
  doors: number;
  lights: number;
  regions: number;
}

/** GET /api/maplib → maps[] (publicEntry). */
export interface LibEntry {
  id: string;
  slug: string;
  name: string;
  nameFr?: string;
  source: LibSource | string;
  tags: string[];
  description: string;
  theme: MapTheme;
  lighting: Lighting;
  width: number;
  height: number;
  metersPerCell: number;
  gridPx?: number;
  quality: LibQuality | string;
  traced: { by?: string; at?: string; quality?: string; notes?: string } | null;
  version: number;
  counts: LibCounts | null;
  origin?: string;
  updatedAt: string | null;
  thumb: string;
  hasImage: boolean;
  hasThumb: boolean;
}

/** GET /api/maplib */
export interface LibList {
  maps: LibEntry[];
  settings?: Record<string, unknown>;
}

/** GET /api/maplib/<slug>: the entry plus its latest version content (cells). */
export interface LibFull extends LibEntry {
  walls?: MapWall[];
  lights?: MapLight[];
  regions?: MapRegion[];
  entry?: { x: number; y: number } | null;
  geometry?: { gridPx?: number; imageW?: number; imageH?: number; offsetX?: number; offsetY?: number };
}

export interface LibAddRemove {
  add: number;
  remove: number;
}

/** shared/maplib.js libraryDiff() */
export interface LibDiff {
  walls: LibAddRemove;
  doors: LibAddRemove;
  lights: LibAddRemove;
  regions: LibAddRemove;
  resized: boolean;
  width: number;
  height: number;
  keptDoorStates: number;
  same: boolean;
}

/** maps/libraryDiff reply */
export interface LibLinkInfo {
  slug: string;
  name: string;
  nameFr?: string;
  current: number;
  latest: number;
  diff: LibDiff;
  publishAllowed: boolean;
  migrated: boolean;
}

/** GET /api/maplib/key */
export interface LibKeyReply {
  k?: string;
  exp?: number;
  now?: number;
}
