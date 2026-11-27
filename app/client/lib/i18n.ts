// Translation layer (browser). English is the source text: t('English text {name}', { name }) returns the French
// dictionary entry when the language is 'fr', else the English string — both interpolated.
// Dictionaries: client/i18n/fr/<area>.json, flat { "English": "French" }, all loaded at startup (index served by the
// server), plus client/i18n/legacy-fr-keys.json (old French keys still stored in saved data → English keys).
// Missing French entries fall back to English and are collected (window.__i18nMissing, counter in Settings).
// See docs/i18n.md.
//
// No framework import here (pure module, also unit-tested in Node): the re-render hook is useLang() in ui-store.js.
//
// Rule: never call t() at module top level (dictionaries are not loaded yet and the language can change):
// translate at render time, and mark constant tables with tk('…') then render t(value).
import { LANGS, DEFAULT_LANG, SOURCE_LANG, isLang, interpolate, lookup, pluralKey, currentKey } from '../i18n/format.ts';
import type { Dictionary, PluralForms, TParams } from '../i18n/format.ts';
import type { Lang } from '../../shared/types.ts';
// Relative path on purpose: resolves to /shared/sr5.js in the browser (same module instance) and works in Node.
import { ATTR_LABELS, ATTR_SHORT, SKILL_BY_ID, SKILL_GROUPS, SKILL_CATEGORIES } from '../../shared/sr5.ts';

export { LANGS, isLang };
export type { Dictionary, PluralForms, TParams };

// sr5.js tables, indexed by any string here (unknown keys fall back to the key itself).
const ATTR_LABEL_MAP: Record<string, string> = ATTR_LABELS;
const ATTR_SHORT_MAP: Record<string, string> = ATTR_SHORT;
const SKILL_GROUP_MAP: Record<string, string> = SKILL_GROUPS;
const SKILL_CATEGORY_MAP: Record<string, string> = SKILL_CATEGORIES;

/** A server error reply / API error body (errorText). */
export interface ErrorReply {
  error?: unknown;
  errorKey?: string;
  params?: TParams;
}
/** What logText() reads of a log entry (LogEntry, or a shorter stored entry). */
export interface LogTextEntry {
  kind?: string;
  text?: string;
  i18n?: { key?: string; params?: TParams } | null;
}
/** An active skill for skillLabel(): a SKILLS id, a SKILLS entry ({ id, fr }) or an actor skill ({ id?, name }). */
export type SkillRef = string | { id?: string; name?: string; fr?: string } | null | undefined;
/** Catalog item names (itemName): English `name`, French `nameFr`. */
export interface NamedItem {
  name?: string;
  nameFr?: string;
}
type LangListener = (lang: Lang) => void;

const LS_KEY = 'sr.lang';
let lang: Lang = DEFAULT_LANG;
let dict: Dictionary = Object.create(null); // merged French dictionary { English key: French }
let legacy: Dictionary = Object.create(null); // old French key → English key (saved data from before the switch)
let loaded = false; // missing keys are only collected once the dictionaries are in
let pendingUserLang: { lang: Lang; until: number } | null = null; // { lang, until }: the user just switched, ignore stale state broadcasts for a moment
const missing: Record<string, number> = Object.create(null); // key -> number of lookups
const listeners = new Set<LangListener>();

// Exposed for translators (browser console): the keys looked up without a French entry.
declare global {
  interface Window {
    __i18nMissing?: Record<string, number>;
  }
}
if (typeof window !== 'undefined') window.__i18nMissing = missing;

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
export function getLang(): Lang {
  return lang;
}

/** Switch the UI language (re-renders through useLang()). Does not persist anything. */
export function setLang(next: unknown): void {
  if (!isLang(next) || next === lang) return;
  lang = next;
  try {
    document.documentElement.lang = next;
  } catch {}
  for (const l of [...listeners]) {
    try {
      l(next);
    } catch (err) {
      console.error('[i18n] listener', err);
    }
  }
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLangChange(cb: LangListener): () => boolean {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Language explicitly chosen in this browser (language switcher), or null. */
export function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}
export function storeLang(l: unknown): void {
  try {
    if (isLang(l)) localStorage.setItem(LS_KEY, l);
  } catch {}
}

/** Browser preference, used only when nothing else is known (table picker, admin page). */
export function browserLang(): Lang {
  try {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^fr\b/i.test(nav) || !nav ? 'fr' : 'en';
  } catch {
    return DEFAULT_LANG;
  }
}

/** The user switched language while logged in: keep it even if a state built before the switch arrives. */
export function expectUserLang(l: unknown): void {
  pendingUserLang = isLang(l) ? { lang: l, until: Date.now() + 4000 } : null;
}

/**
 * Effective language for a game view: the user's own choice (game.me.lang), else the choice made in this browser
 * (not yet saved on the account), else the table's language (game.config.lang).
 */
export function langFromGame(game: { me?: { lang?: unknown } | null; config?: { lang?: unknown } | null } | null | undefined): Lang {
  const own = game?.me?.lang;
  const table = game?.config?.lang;
  const fromState = isLang(own) ? own : storedLang() || (isLang(table) ? table : DEFAULT_LANG);
  if (pendingUserLang) {
    if (fromState === pendingUserLang.lang || Date.now() > pendingUserLang.until) pendingUserLang = null;
    else return pendingUserLang.lang;
  }
  return fromState;
}

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------
/** Replace the dictionary (tests) — `entries` = { English: French }, `legacyKeys` = { old French key: English key }. */
export function setDictionary(entries: Dictionary | null | undefined, { markLoaded = true, legacyKeys }: { markLoaded?: boolean; legacyKeys?: Dictionary | null } = {}): void {
  dict = Object.assign(Object.create(null), entries || {});
  if (legacyKeys !== undefined) legacy = Object.assign(Object.create(null), legacyKeys || {});
  loaded = markLoaded;
}

/**
 * Fetch every /i18n/fr/*.json listed by /i18n/fr/index.json and merge them (glossary first, so an area file
 * can override a glossary term), plus the legacy key map. Never rejects: on failure the UI simply stays in English.
 */
export async function loadDictionaries({ base = '/i18n/fr', timeoutMs = 5000 }: { base?: string; timeoutMs?: number } = {}): Promise<number> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const legacyLoad = fetch(`${base.replace(/\/[^/]+$/, '')}/legacy-fr-keys.json`, { signal: ctl?.signal })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    const idx: { files?: string[] } = await fetch(`${base}/index.json`, { signal: ctl?.signal }).then((r) => (r.ok ? r.json() : { files: [] }));
    const files = (idx.files || []).slice().sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)));
    const parts = await Promise.all(
      files.map((f) =>
        fetch(`${base}/${encodeURIComponent(f)}`, { signal: ctl?.signal })
          .then((r): Promise<unknown> | unknown => (r.ok ? r.json() : {}))
          .catch((err: Error) => {
            console.warn(`[i18n] ${f} unreadable:`, err.message);
            return {};
          })
      )
    );
    const merged: Dictionary = Object.create(null);
    for (const p of parts) if (p && typeof p === 'object' && !Array.isArray(p)) for (const [k, v] of Object.entries(p as Record<string, unknown>)) if (typeof v === 'string') merged[k] = v;
    dict = merged;
    const lk = await legacyLoad;
    if (lk && typeof lk === 'object' && !Array.isArray(lk)) legacy = Object.assign(Object.create(null), lk);
    loaded = true;
    return Object.keys(merged).length;
  } catch (err) {
    console.warn('[i18n] dictionaries not loaded:', (err as Error)?.message || err);
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function noteMissing(key: string): void {
  if (!loaded || lang === SOURCE_LANG || !key || !/\p{L}/u.test(key)) return;
  missing[key] = (missing[key] || 0) + 1;
}

/** Keys looked up without a French entry, sorted: { key: count }. */
export function missingKeys(): Record<string, number> {
  return Object.fromEntries(Object.keys(missing).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, missing[k]]));
}
export function missingCount(): number {
  return Object.keys(missing).length;
}
export function clearMissing(): void {
  for (const k of Object.keys(missing)) delete missing[k];
}

// ---------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------
/** Translate an English source string; {placeholders} are filled from params (named values, never fragments). */
export function t(key: string | null | undefined, params?: TParams | null): string {
  const k = currentKey(legacy, key);
  const r = lookup(dict, lang, k);
  if (r.missing) noteMissing(k);
  return interpolate(r.text, params, t, lang);
}

/**
 * Plural: tn(n, '{n} item', '{n} items', params) or tn(n, { zero: 'No item', one: '{n} item', other: '{n} items' }, params).
 * {n} is always available. Each form is its own dictionary key. French: 0 and 1 use `one`; English: only 1.
 */
export function tn(n: number | null | undefined, forms: PluralForms, params?: TParams | null): string;
export function tn(n: number | null | undefined, one: string, other: string, params?: TParams | null): string;
export function tn(n: number | null | undefined, one: string | PluralForms, other?: string | TParams | null, params?: TParams | null): string {
  let forms: PluralForms;
  let p: TParams | null | undefined;
  if (typeof one === 'string') {
    forms = { one, other: other as string };
    p = params;
  } else {
    forms = one;
    p = other as TParams | null | undefined;
  }
  return t(pluralKey(lang, n, forms), { n, ...(p || {}) });
}

/** Marker for constant tables: returns its argument untouched (the checker extracts it). Render with t(value). */
export const tk = (s: string): string => s;

/**
 * Translate a text that MAY be a dictionary key (text received from the server or stored in data, including old
 * French keys): known → translated, unknown → returned as-is, never counted as missing.
 */
export function tIfKnown(text: string, params?: TParams | null): string;
export function tIfKnown<T>(text: T, params?: TParams | null): T | string;
export function tIfKnown(text: unknown, params?: TParams | null): unknown {
  if (typeof text !== 'string' || !text) return text;
  const k = currentKey(legacy, text);
  if (k === text && !(text in dict)) return interpolate(text, params, t, lang);
  return t(k, params);
}

/** Readable message of a server error reply / API error body: { error, errorKey?, params? }. */
export function errorText(res: ErrorReply | null | undefined, fallback: string = tk('Error')): string {
  if (res?.errorKey) return t(res.errorKey, res.params);
  if (res?.error) return tIfKnown(String(res.error));
  return t(fallback);
}

/** Text of a log entry: its i18n key when present, else its stored text (translated when it is a known key). */
export function logText(entry: LogTextEntry | null | undefined): string {
  if (!entry) return '';
  if (entry.i18n?.key) return t(entry.i18n.key, entry.i18n.params);
  if (entry.kind === 'chat' || entry.kind === 'whisper') return entry.text || '';
  return tIfKnown(entry.text || '');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export const locale = (): string => (lang === 'en' ? 'en-US' : 'fr-FR');

export function fmtNumber(n: unknown, opts?: Intl.NumberFormatOptions): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return v.toLocaleString(locale(), opts).replace(/[  ]/g, ' ');
}

/** 12500 → '12 500¥' (fr) / '12,500¥' (en). */
export function fmtNuyen(n: unknown): string {
  return fmtNumber(Math.round(Number(n) || 0)) + '¥';
}

/** Date/time in the UI language. opts default: short date + time. */
export function fmtDate(ts: number | string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(locale(), opts);
  } catch {
    return String(ts);
  }
}

/** Locale-aware string comparison for sorting lists. */
export const compare = (a: unknown, b: unknown): number => String(a ?? '').localeCompare(String(b ?? ''), lang);

// ---------------------------------------------------------------------------
// Game vocabulary (SR5) and catalog data
// ---------------------------------------------------------------------------
/** 'AGI' → 'Agilité' / 'Agility'. */
export const attrLabel = (key: string | null | undefined): string => (key && ATTR_LABEL_MAP[key] ? t(ATTR_LABEL_MAP[key]) : String(key ?? ''));

/** 'AGI' → 'AGI', 'BOD' → 'CON' (fr) / 'BOD' (en). */
export const attrShort = (key: string | null | undefined): string => (lang === 'en' ? String(key ?? '') : (key && ATTR_SHORT_MAP[key]) || String(key ?? ''));

const titleCase = (id: string): string => String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const SKILL_EN_EXCEPTIONS: Record<string, string> = { free_fall: 'Free-Fall', exotic_weapon: 'Exotic Weapon' };

/**
 * Label of an active skill: accepts a SKILLS id, a SKILLS entry or an actor skill { id, name }.
 * Known SR5 skills use the official English name (from their id); custom skills keep their name (translated when it is a known key).
 */
export function skillLabel(skill: SkillRef): string {
  const id = typeof skill === 'string' ? skill : skill?.id;
  const def = id ? SKILL_BY_ID[id] : undefined;
  if (def && id) return lang === 'en' ? SKILL_EN_EXCEPTIONS[id] || titleCase(id) : def.fr;
  const name = typeof skill === 'string' ? skill : skill?.name || skill?.fr || id || '';
  return tIfKnown(name);
}

/** Skill group id ('firearms') → 'Firearms' / 'Armes à feu'. */
export const skillGroupLabel = (id: string | null | undefined): string => (id && SKILL_GROUP_MAP[id] ? t(SKILL_GROUP_MAP[id]) : String(id ?? ''));

/** Skill category id ('technical') → 'Technical' / 'Techniques'. */
export const skillCategoryLabel = (cat: string | null | undefined): string => (cat && SKILL_CATEGORY_MAP[cat] ? t(SKILL_CATEGORY_MAP[cat]) : String(cat ?? ''));

/** Limit kind ('physical'|'mental'|'social'|'astral') → 'Limite physique' / 'Physical Limit'. */
const LIMIT_FR: Record<string, string> = { physical: tk('Physical Limit'), mental: tk('Mental Limit'), social: tk('Social Limit'), astral: tk('Astral Limit') };
export const limitLabel = (kind: string | null | undefined): string => (kind && LIMIT_FR[kind] ? t(LIMIT_FR[kind]) : String(kind ?? ''));

/** Stored metatype ('Humain', 'Elfe'…) → label in the UI language. */
export const metatypeLabel = (m: unknown): string => tIfKnown(String(m ?? ''));

/** Catalog item display name: English `name`, French `nameFr` when present. */
export function itemName(item: NamedItem | null | undefined): string {
  if (!item) return '';
  return lang === 'fr' ? item.nameFr || item.name || '' : item.name || item.nameFr || '';
}
