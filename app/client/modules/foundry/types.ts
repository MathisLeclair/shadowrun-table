// Replies of the Foundry actions (server/modules/80-foundry.js, server/lib/foundry/importer.js).
// Action results, not game state, so they are not in shared/types.ts.

export type ScanStatus = 'new' | 'update' | 'unchanged';

/** Translatable server text. */
export interface I18nText {
  t: string;
  params?: Record<string, unknown>;
}

/** foundry/worlds */
export interface WorldsReply {
  worlds?: Array<{ path: string; title: string; system: string }>;
  /** World path found in Foundry's options.json. */
  detected?: string;
}

export interface ScanPc {
  fid: string;
  name: string;
  status: ScanStatus;
  portrait?: string;
  retired?: boolean;
  /** Foundry owner name. */
  player?: string;
  karma: number;
  nuyen: number;
  vehicles: string[];
  /** French lines (older servers / tools). */
  diff: string[];
  diffI18n?: Array<I18nText | string>;
}

export interface ScanNpc {
  fid: string;
  name: string;
  status: ScanStatus;
  foundryFolder: string;
  templateId: string;
  templateName?: string;
  hasStats: boolean;
  /** Bestiary folder. */
  folder: string;
}

export interface ScanScene {
  fid: string;
  name: string;
  status: ScanStatus;
  thumb?: string;
  size: string;
  walls: number;
  doors: number;
  lights: number;
  folder: string;
  linkedTo?: unknown;
}

export interface ScanJournalDoc {
  file: string;
  folder?: string;
  title: string;
  status: ScanStatus;
}

export interface ScanPlaylist {
  name: string;
  kind: string;
  tracks: number;
  newTracks: number;
  bytes?: number;
  /** French size text. */
  size?: string;
}

/** Progress of the background copy of the audio files (also the 'foundry/audio' event). */
export interface AudioJob {
  total?: number;
  done?: number;
  bytes?: number;
  running?: boolean;
  error?: string;
}

/** foundry/scan */
export interface ScanResult {
  world?: { id?: string; path?: string; title?: string; system?: string; systemVersion?: string; coreVersion?: string };
  missingAssets?: string[];
  pcs: ScanPc[];
  npcs: ScanNpc[];
  scenes: ScanScene[];
  skippedScenes?: Array<{ name: string; reason: string }>;
  journals: { docs: ScanJournalDoc[]; pdfs?: number };
  playlists: ScanPlaylist[];
  audio?: { bytes?: number; size?: string };
  audioJob?: AudioJob;
}

/** What the GM picked in the scan view. */
export interface Selection {
  pcs: Set<string>;
  npcs: Set<string>;
  scenes: Set<string>;
  journals: boolean;
  playlists: boolean;
}
export type SetKey = 'pcs' | 'npcs' | 'scenes';

/** foundry/import */
export interface ImportResult {
  text?: string;
  textI18n?: { key: string; params?: Record<string, unknown> };
  pcs?: Array<{ status: string }>;
  npcs?: Array<{ status: string }>;
  maps?: Array<{ status: string }>;
  journals?: unknown[];
  docsDir?: string;
  tracks?: number;
  questLinks?: number;
  users?: string[];
  audio?: { queued?: boolean; files?: number; bytes?: number; size?: string };
  assets: { copied: number; skipped: number; bytes?: number; size?: string };
  missing?: string[];
}
