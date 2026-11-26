// Pure i18n core shared by the browser (client/lib/i18n.js), the server (server/lib/i18n.js) and the tools.
// No imports, no DOM/Node APIs. See ARCHITECTURE.md « i18n ».
//
// Keys are the French source strings. A key may carry a disambiguation context before '::'
// ('magie::Force') — the French output drops it, the dictionary is looked up with the full key.

export const LANGS = ['fr', 'en'];
export const DEFAULT_LANG = 'fr';
export const CONTEXT_SEP = '::';

export const isLang = (l) => LANGS.includes(l);

/** 'magie::Force' → 'Force' (French text of a key). */
export function stripContext(key) {
  const s = String(key ?? '');
  const i = s.indexOf(CONTEXT_SEP);
  return i >= 0 ? s.slice(i + CONTEXT_SEP.length) : s;
}

/** Placeholder names used in a string: 'Salut {name}, {n} PJ' → ['name', 'n']. */
export function placeholders(str) {
  const out = new Set();
  String(str ?? '').replace(/\{(\w+)\}/g, (_, n) => out.add(n));
  return [...out];
}

/**
 * Replace {name} by params.name. Unknown names are left as-is. A param value may itself be translatable:
 * { t: 'key', params } (translated with `tr`, or formatted in French when no `tr` is given); arrays are joined with ', '.
 */
export function interpolate(str, params, tr) {
  if (typeof str !== 'string' || !params || typeof params !== 'object' || str.indexOf('{') < 0) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name) ? paramText(params[name], tr) : m));
}

function paramText(v, tr) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => paramText(x, tr)).join(', ');
  if (typeof v === 'object') {
    if (typeof v.t === 'string') return tr ? tr(v.t, v.params) : interpolate(stripContext(v.t), v.params);
    return '';
  }
  return String(v);
}

/** Plural category of n in a language: 'one' | 'other' (French: 0 and 1 are singular; English: only 1). */
export function pluralCategory(lang, n) {
  const v = Math.abs(Number(n) || 0);
  if (lang === 'en') return v === 1 ? 'one' : 'other';
  return v < 2 ? 'one' : 'other';
}

/**
 * Pick the French form for n. `forms` = { zero?, one, other } (zero, when given, wins for n === 0 in every language).
 * Returns the French key to translate.
 */
export function pluralKey(lang, n, forms) {
  if (Number(n) === 0 && forms.zero) return forms.zero;
  return pluralCategory(lang, n) === 'one' ? forms.one : forms.other;
}

/**
 * Translate `key` with a flat dictionary { French: English } for `lang`.
 * Returns { text, missing } — missing = the dictionary has no (non-empty) entry for the key.
 */
export function lookup(dict, lang, key) {
  const k = String(key ?? '');
  const hit = dict ? dict[k] : undefined;
  const has = typeof hit === 'string' && hit !== '';
  return { text: lang !== 'fr' && has ? hit : stripContext(k), missing: !has };
}

/** French text of a key, interpolated (what the server stores / sends as the readable `error`). */
export function formatFr(key, params) {
  return interpolate(stripContext(key), params);
}

/** Keep only JSON-safe, small params (server → client: error params, log params). */
export function cleanParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(params).slice(0, 30)) {
    if (!/^\w{1,40}$/.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => (x === null || typeof x !== 'object' ? x : cleanNested(x))).filter((x) => x !== undefined);
    else if (typeof v === 'object') {
      const n = cleanNested(v);
      if (n) out[k] = n;
    }
  }
  return out;
}
function cleanNested(v) {
  if (!v || typeof v.t !== 'string') return undefined;
  const n = { t: v.t.slice(0, 500) };
  const p = v.params ? cleanParams(v.params) : undefined;
  if (p && Object.keys(p).length) n.params = p;
  return n;
}
