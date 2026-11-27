// Pure i18n core shared by the browser (client/lib/i18n.js), the server (server/lib/i18n.js) and the tools.
// No imports (types only), no DOM/Node APIs. See ARCHITECTURE.md « i18n ».
//
// Keys are the French source strings. A key may carry a disambiguation context before '::'
// ('magie::Force') — the French output drops it, the dictionary is looked up with the full key.

import type { BiName, I18nMessage, I18nParams, I18nParamValue, Lang } from '../../shared/types.ts';

/**
 * Params of a translated string: named values (string, number, { fr, en } name, nested { t, params } message, arrays of those).
 * Loose on purpose: callers pass their own objects (interfaces included); unknown values render as ''.
 */
export type TParams = object;
/** A translate function (t of client/lib/i18n.ts, tr of server/lib/i18n.js). */
export type Translator = (key: string, params?: TParams | null) => string;
/** Plural forms: French keys. `zero`, when given, wins for n === 0 in every language. */
export interface PluralForms {
  zero?: string;
  one: string;
  other: string;
}
/** Flat dictionary { French key: English text }. */
export type Dictionary = Record<string, string>;

export const LANGS: Lang[] = ['fr', 'en'];
export const DEFAULT_LANG: Lang = 'fr';
export const CONTEXT_SEP = '::';

export const isLang = (l: unknown): l is Lang => LANGS.includes(l as Lang);

/** 'magie::Force' → 'Force' (French text of a key). */
export function stripContext(key: unknown): string {
  const s = String(key ?? '');
  const i = s.indexOf(CONTEXT_SEP);
  return i >= 0 ? s.slice(i + CONTEXT_SEP.length) : s;
}

/** Placeholder names used in a string: 'Salut {name}, {n} PJ' → ['name', 'n']. */
export function placeholders(str: unknown): string[] {
  const out = new Set<string>();
  String(str ?? '').replace(/\{(\w+)\}/g, (_, n: string) => {
    out.add(n);
    return '';
  });
  return [...out];
}

/**
 * Replace {name} by params.name. Unknown names are left as-is. A param value may itself be translatable:
 * { t: 'key', params } (translated with `tr`, or formatted in French when no `tr` is given); { fr, en } (a name stored in both
 * languages — item names —: the one of `lang`, French when no `lang` is given, the other one when empty); arrays are joined with ', '.
 */
export function interpolate(str: string, params?: TParams | null, tr?: Translator, lang?: string): string {
  if (typeof str !== 'string' || !params || typeof params !== 'object' || str.indexOf('{') < 0) return str;
  return str.replace(/\{(\w+)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? paramText((params as Record<string, unknown>)[name], tr, lang) : m));
}

function paramText(v: unknown, tr: Translator | undefined, lang: string | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => paramText(x, tr, lang)).join(', ');
  if (typeof v === 'object') {
    const o = v as { t?: unknown; params?: TParams; fr?: unknown; en?: unknown };
    if (typeof o.t === 'string') return tr ? tr(o.t, o.params) : interpolate(stripContext(o.t), o.params, undefined, lang);
    if (typeof o.fr === 'string' || typeof o.en === 'string') return String((lang === 'en' ? o.en || o.fr : o.fr || o.en) || '');
    return '';
  }
  return String(v);
}

/** Plural category of n in a language: 'one' | 'other' (French: 0 and 1 are singular; English: only 1). */
export function pluralCategory(lang: string, n: unknown): 'one' | 'other' {
  const v = Math.abs(Number(n) || 0);
  if (lang === 'en') return v === 1 ? 'one' : 'other';
  return v < 2 ? 'one' : 'other';
}

/**
 * Pick the French form for n. `forms` = { zero?, one, other } (zero, when given, wins for n === 0 in every language).
 * Returns the French key to translate.
 */
export function pluralKey(lang: string, n: unknown, forms: PluralForms): string {
  if (Number(n) === 0 && forms.zero) return forms.zero;
  return pluralCategory(lang, n) === 'one' ? forms.one : forms.other;
}

/**
 * Translate `key` with a flat dictionary { French: English } for `lang`.
 * Returns { text, missing } — missing = the dictionary has no (non-empty) entry for the key.
 */
export function lookup(dict: Dictionary | null | undefined, lang: string, key: unknown): { text: string; missing: boolean } {
  const k = String(key ?? '');
  const hit = dict ? dict[k] : undefined;
  const has = typeof hit === 'string' && hit !== '';
  return { text: lang !== 'fr' && has ? (hit as string) : stripContext(k), missing: !has };
}

/** French text of a key, interpolated (what the server stores / sends as the readable `error`). */
export function formatFr(key: unknown, params?: TParams | null): string {
  return interpolate(stripContext(key), params);
}

/** Keep only JSON-safe, small params (server → client: error params, log params). */
export function cleanParams(params: unknown): I18nParams | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const out: I18nParams = {};
  for (const [k, v] of Object.entries(params).slice(0, 30)) {
    if (!/^\w{1,40}$/.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
    // Array items are kept as they are when not objects (same as before the TypeScript conversion: not re-validated).
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => (x === null || typeof x !== 'object' ? x : cleanNested(x))).filter((x) => x !== undefined) as I18nParamValue;
    else if (typeof v === 'object') {
      const n = cleanNested(v);
      if (n) out[k] = n;
    }
  }
  return out;
}
function cleanNested(raw: unknown): BiName | I18nMessage | undefined {
  const v = raw as { t?: unknown; params?: unknown; fr?: unknown; en?: unknown } | null | undefined;
  if (v && typeof v.t !== 'string' && (typeof v.fr === 'string' || typeof v.en === 'string')) {
    // A name in both languages ({ fr, en }: item names in log / error params).
    const n: BiName = {};
    if (typeof v.fr === 'string') n.fr = v.fr.slice(0, 200);
    if (typeof v.en === 'string') n.en = v.en.slice(0, 200);
    return n;
  }
  if (!v || typeof v.t !== 'string') return undefined;
  const n: I18nMessage = { t: v.t.slice(0, 500) };
  const p = v.params ? cleanParams(v.params) : undefined;
  if (p && Object.keys(p).length) n.params = p;
  return n;
}
