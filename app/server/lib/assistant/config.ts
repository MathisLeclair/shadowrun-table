// GM assistant — server-wide settings (runtime/assistant/settings.json) and paths.
// Settings are the admin's: which tables may use the assistant, model, effort, monthly spend cap.
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR, readJson, writeJsonAtomic } from '../../store.ts';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
export interface ModelInfo extends Price {
  label: string;
  /** The model may answer through a server-side refusal fallback (beta). */
  fallbacks: boolean;
}
export type Effort = 'low' | 'medium' | 'high';
/** runtime/assistant/settings.json */
export interface AssistantSettings {
  enabledTables: string[];
  model: string;
  effort: Effort;
  monthlyCapUsd: number;
}

export const ASSISTANT_DIR = process.env.SR_ASSISTANT_DIR ? path.resolve(process.env.SR_ASSISTANT_DIR) : path.join(RUNTIME_DIR, 'assistant');
const SETTINGS_FILE = () => path.join(ASSISTANT_DIR, 'settings.json');

/** Models the admin may pick. Prices in USD per million tokens (cache write = 1-hour TTL, the one we use). */
export const MODELS: Record<string, ModelInfo> = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, fallbacks: true },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4, fallbacks: true },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, fallbacks: false },
};
/** Prices for models that may answer through a server-side refusal fallback, and a conservative default. */
export const OTHER_PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 },
};
export const UNKNOWN_PRICE: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }; // never under-count
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];

export const DEFAULT_SETTINGS: AssistantSettings = { enabledTables: [], model: 'claude-opus-5-5', effort: 'medium', monthlyCapUsd: 80 };
export const MAX_CAP = 1000;

let cache: AssistantSettings | null = null;
export function getSettings(): AssistantSettings {
  if (cache) return cache;
  const raw = readJson(SETTINGS_FILE(), {}) || {};
  cache = normalizeSettings(raw);
  return cache;
}

// `raw` is foreign data (settings.json, admin input).
export function normalizeSettings(raw: any = {}): AssistantSettings {
  const s: AssistantSettings = { ...DEFAULT_SETTINGS };
  if (Array.isArray(raw.enabledTables)) s.enabledTables = [...new Set<string>(raw.enabledTables.filter((x: unknown): x is string => typeof x === 'string' && x.length <= 80))];
  if (MODELS[raw.model]) s.model = raw.model;
  if (EFFORTS.includes(raw.effort)) s.effort = raw.effort;
  const cap = Number(raw.monthlyCapUsd);
  if (Number.isFinite(cap) && cap >= 0) s.monthlyCapUsd = Math.min(MAX_CAP, Math.round(cap * 100) / 100);
  return s;
}

export function updateSettings(patch: Partial<AssistantSettings> = {}): AssistantSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch });
  fs.mkdirSync(ASSISTANT_DIR, { recursive: true });
  writeJsonAtomic(SETTINGS_FILE(), next);
  cache = next;
  return next;
}

export const isTableEnabled = (tableId: string): boolean => getSettings().enabledTables.includes(tableId);

/** Test hook: forget cached settings (the tests point SR_ASSISTANT_DIR at a temp dir). */
export function _resetSettingsCache(): void {
  cache = null;
}
