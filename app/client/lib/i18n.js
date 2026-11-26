// Translation layer (browser). French is the source text: t('Texte français {name}', { name }) returns the
// English dictionary entry when the language is 'en', else the French string — both interpolated.
// Dictionaries: client/i18n/en/<area>.json, flat { "French": "English" }, all loaded at startup (index served
// by the server). Missing English entries fall back to French and are collected (window.__i18nMissing,
// counter in Réglages). See ARCHITECTURE.md « i18n ».
//
// No framework import here (pure module, also unit-tested in Node): the re-render hook is useLang() in ui-store.js.
//
// Rule: never call t() at module top level (dictionaries are not loaded yet and the language can change):
// translate at render time, and mark constant tables with tk('…') then render t(value).
import { LANGS, DEFAULT_LANG, isLang, stripContext, interpolate, lookup, pluralKey } from '../i18n/format.js';
// Relative path on purpose: resolves to /shared/sr5.js in the browser (same module instance) and works in Node.
import { ATTR_LABELS, ATTR_SHORT, SKILL_BY_ID, SKILL_GROUPS, SKILL_CATEGORIES } from '../../shared/sr5.js';

export { LANGS, isLang };

const LS_KEY = 'sr.lang';
let lang = DEFAULT_LANG;
let dict = Object.create(null); // merged English dictionary
let loaded = false; // missing keys are only collected once the dictionaries are in
let pendingUserLang = null; // { lang, until }: the user just switched, ignore stale state broadcasts for a moment
const missing = Object.create(null); // key -> number of lookups
const listeners = new Set();

// Exposed for translators (browser console): the keys looked up without an English entry.
if (typeof window !== 'undefined') window.__i18nMissing = missing;

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
export function getLang() {
  return lang;
}

/** Switch the UI language (re-renders through useLang()). Does not persist anything. */
export function setLang(next) {
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
export function onLangChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Language explicitly chosen in this browser (language switcher), or null. */
export function storedLang() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}
export function storeLang(l) {
  try {
    if (isLang(l)) localStorage.setItem(LS_KEY, l);
  } catch {}
}

/** Browser preference, used only when nothing else is known (table picker, admin page). */
export function browserLang() {
  try {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^fr\b/i.test(nav) || !nav ? 'fr' : 'en';
  } catch {
    return DEFAULT_LANG;
  }
}

/** The user switched language while logged in: keep it even if a state built before the switch arrives. */
export function expectUserLang(l) {
  pendingUserLang = isLang(l) ? { lang: l, until: Date.now() + 4000 } : null;
}

/**
 * Effective language for a game view: the user's own choice (game.me.lang), else the choice made in this browser
 * (not yet saved on the account), else the table's language (game.config.lang).
 */
export function langFromGame(game) {
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
/** Replace the dictionary (tests) — `entries` = { French: English }. */
export function setDictionary(entries, { markLoaded = true } = {}) {
  dict = Object.assign(Object.create(null), entries || {});
  loaded = markLoaded;
}

/**
 * Fetch every /i18n/en/*.json listed by /i18n/en/index.json and merge them (glossary first, so an area file
 * can override a glossary term). Never rejects: on failure the UI simply stays in French.
 */
export async function loadDictionaries({ base = '/i18n/en', timeoutMs = 5000 } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const idx = await fetch(`${base}/index.json`, { signal: ctl?.signal }).then((r) => (r.ok ? r.json() : { files: [] }));
    const files = (idx.files || []).slice().sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)));
    const parts = await Promise.all(
      files.map((f) =>
        fetch(`${base}/${encodeURIComponent(f)}`, { signal: ctl?.signal })
          .then((r) => (r.ok ? r.json() : {}))
          .catch((err) => {
            console.warn(`[i18n] ${f} illisible :`, err.message);
            return {};
          })
      )
    );
    const merged = Object.create(null);
    for (const p of parts) if (p && typeof p === 'object' && !Array.isArray(p)) for (const [k, v] of Object.entries(p)) if (typeof v === 'string') merged[k] = v;
    dict = merged;
    loaded = true;
    return Object.keys(merged).length;
  } catch (err) {
    console.warn('[i18n] dictionnaires non chargés :', err.message || err);
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function noteMissing(key) {
  if (!loaded || !key || !/\p{L}/u.test(key)) return;
  missing[key] = (missing[key] || 0) + 1;
}

/** Keys looked up without an English entry, sorted: { key: count }. */
export function missingKeys() {
  return Object.fromEntries(Object.keys(missing).sort((a, b) => a.localeCompare(b, 'fr')).map((k) => [k, missing[k]]));
}
export function missingCount() {
  return Object.keys(missing).length;
}
export function clearMissing() {
  for (const k of Object.keys(missing)) delete missing[k];
}

// ---------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------
/** Translate a French source string; {placeholders} are filled from params (named values, never fragments). */
export function t(key, params) {
  const k = String(key ?? '');
  const r = lookup(dict, lang, k);
  if (r.missing) noteMissing(k);
  return interpolate(r.text, params, t);
}

/**
 * Plural: tn(n, '{n} objet', '{n} objets', params) or tn(n, { zero: 'Aucun objet', one: '{n} objet', other: '{n} objets' }, params).
 * {n} is always available. Each form is its own dictionary key. French: 0 and 1 use `one`; English: only 1.
 */
export function tn(n, one, other, params) {
  let forms = one;
  let p = other;
  if (typeof one === 'string') {
    forms = { one, other };
    p = params;
  }
  return t(pluralKey(lang, n, forms), { n, ...(p || {}) });
}

/** Marker for constant tables: returns its argument untouched (the checker extracts it). Render with t(value). */
export const tk = (s) => s;

/**
 * Translate a text that MAY be a dictionary key (French text received from the server or stored in data):
 * known → translated, unknown → returned as-is, never counted as missing.
 */
export function tIfKnown(text, params) {
  if (typeof text !== 'string' || !text) return text;
  if (!(text in dict)) return interpolate(text, params, t);
  return t(text, params);
}

/** Readable message of a server error reply / API error body: { error, errorKey?, params? }. */
export function errorText(res, fallback = tk('Erreur')) {
  if (res?.errorKey) return t(res.errorKey, res.params);
  if (res?.error) return tIfKnown(String(res.error));
  return t(fallback);
}

/** Text of a log entry: its i18n key when present, else its stored text (translated when it is a known key). */
export function logText(entry) {
  if (!entry) return '';
  if (entry.i18n?.key) return t(entry.i18n.key, entry.i18n.params);
  if (entry.kind === 'chat' || entry.kind === 'whisper') return entry.text || '';
  return tIfKnown(entry.text || '');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export const locale = () => (lang === 'en' ? 'en-US' : 'fr-FR');

export function fmtNumber(n, opts) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return v.toLocaleString(locale(), opts).replace(/[  ]/g, ' ');
}

/** 12500 → '12 500¥' (fr) / '12,500¥' (en). */
export function fmtNuyen(n) {
  return fmtNumber(Math.round(Number(n) || 0)) + '¥';
}

/** Date/time in the UI language. opts default: short date + time. */
export function fmtDate(ts, opts = { dateStyle: 'short', timeStyle: 'short' }) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(locale(), opts);
  } catch {
    return String(ts);
  }
}

/** Locale-aware string comparison for sorting lists. */
export const compare = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), lang);

// ---------------------------------------------------------------------------
// Game vocabulary (SR5) and catalog data
// ---------------------------------------------------------------------------
/** 'AGI' → 'Agilité' / 'Agility'. */
export const attrLabel = (key) => (ATTR_LABELS[key] ? t(ATTR_LABELS[key]) : String(key ?? ''));

/** 'AGI' → 'AGI', 'BOD' → 'CON' (fr) / 'BOD' (en). */
export const attrShort = (key) => (lang === 'en' ? String(key ?? '') : ATTR_SHORT[key] || String(key ?? ''));

const titleCase = (id) => String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const SKILL_EN_EXCEPTIONS = { free_fall: 'Free-Fall', exotic_weapon: 'Exotic Weapon' };

/**
 * Label of an active skill: accepts a SKILLS id, a SKILLS entry or an actor skill { id, name }.
 * Known SR5 skills use the official English name (from their id); custom skills keep their name (translated when it is a known key).
 */
export function skillLabel(skill) {
  const id = typeof skill === 'string' ? skill : skill?.id;
  const def = SKILL_BY_ID[id];
  if (def) return lang === 'en' ? SKILL_EN_EXCEPTIONS[id] || titleCase(id) : def.fr;
  const name = typeof skill === 'string' ? skill : skill?.name || skill?.fr || id || '';
  return tIfKnown(name);
}

/** Skill group id ('firearms') → 'Armes à feu' / 'Firearms'. */
export const skillGroupLabel = (id) => (SKILL_GROUPS[id] ? (lang === 'en' ? titleCase(id) : SKILL_GROUPS[id]) : String(id ?? ''));

const CATEGORY_EN = { combat: 'Combat', physical: 'Physical', social: 'Social', magic: 'Magical', resonance: 'Resonance', technical: 'Technical', vehicle: 'Vehicle' };
/** Skill category id ('technical') → 'Techniques' / 'Technical'. */
export const skillCategoryLabel = (cat) => (lang === 'en' ? CATEGORY_EN[cat] || String(cat ?? '') : SKILL_CATEGORIES[cat] || String(cat ?? ''));

/** Limit kind ('physical'|'mental'|'social'|'astral') → 'Limite physique' / 'Physical Limit'. */
const LIMIT_FR = { physical: tk('Limite physique'), mental: tk('Limite mentale'), social: tk('Limite sociale'), astral: tk('Limite astrale') };
export const limitLabel = (kind) => (LIMIT_FR[kind] ? t(LIMIT_FR[kind]) : String(kind ?? ''));

/** Stored metatype ('Humain', 'Elfe'…) → label in the UI language. */
export const metatypeLabel = (m) => tIfKnown(String(m ?? ''));

/** Catalog item display name: English `name`, French `nameFr` when present. */
export function itemName(item) {
  if (!item) return '';
  return lang === 'fr' ? item.nameFr || item.name || '' : item.name || item.nameFr || '';
}
