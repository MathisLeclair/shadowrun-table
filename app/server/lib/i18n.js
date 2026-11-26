// Server-side i18n: the same dictionaries as the browser (client/i18n/<lang>/*.json), for the rare texts the
// server must store pre-rendered in a given language, plus helpers that carry translation keys to the client:
//   ctx.fail('Texte {x}', { x })        → reply { error: French text, errorKey, params }   (server/index.js)
//   ctx.log({ i18n: { key, params } })  → entry.text filled with the French text            (normalizeLogEntry)
//   res.status(400).json(errorBody('Texte {x}', { x }))  for HTTP routes
// See ARCHITECTURE.md « i18n ».
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../store.js';
import { LANGS, DEFAULT_LANG, isLang, lookup, interpolate, formatFr, cleanParams, pluralKey } from '../../client/i18n/format.js';

export { LANGS, DEFAULT_LANG, isLang, formatFr, cleanParams };

export const I18N_DIR = path.join(ROOT, 'client', 'i18n');
const cache = new Map(); // lang -> { dict, sig, checkedAt }

/** Dictionary files of a language (sorted, glossary first) — also served as /i18n/<lang>/index.json. */
export function dictionaryFiles(lang) {
  if (!isLang(lang)) return [];
  const dir = path.join(I18N_DIR, lang);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    return [];
  }
  return files.sort((a, b) => (a === 'glossary.json' ? -1 : b === 'glossary.json' ? 1 : a.localeCompare(b)));
}

function signature(lang) {
  const dir = path.join(I18N_DIR, lang);
  return dictionaryFiles(lang)
    .map((f) => {
      try {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return f;
      }
    })
    .join('|');
}

/** Merged dictionary of a language (re-read when a file changes; checked at most every 3 s). */
export function dictionary(lang) {
  if (!isLang(lang) || lang === 'fr') return {};
  const now = Date.now();
  let c = cache.get(lang);
  if (c && now - c.checkedAt < 3000) return c.dict;
  const sig = signature(lang);
  if (c && c.sig === sig) {
    c.checkedAt = now;
    return c.dict;
  }
  const dict = Object.create(null);
  for (const f of dictionaryFiles(lang)) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, lang, f), 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) for (const [k, v] of Object.entries(data)) if (typeof v === 'string') dict[k] = v;
    } catch (err) {
      console.warn(`[i18n] ${lang}/${f} illisible : ${err.message}`);
    }
  }
  c = { dict, sig, checkedAt: now };
  cache.set(lang, c);
  return dict;
}

/** Translate a French key into `lang` (falls back to French), interpolated. */
export function t(lang, key, params) {
  const d = dictionary(lang);
  const tr = (k, p) => interpolate(lookup(d, lang, k).text, p, tr, lang);
  return tr(key, params);
}

/** Plural, same forms as the client: tn(lang, n, '{n} objet', '{n} objets', params) or tn(lang, n, { zero?, one, other }, params). */
export function tn(lang, n, one, other, params) {
  let forms = one;
  let p = other;
  if (typeof one === 'string') {
    forms = { one, other };
    p = params;
  }
  return t(lang, pluralKey(lang, n, forms), { n, ...(p || {}) });
}

/** JSON body of an HTTP error the client can translate: { error: French, errorKey, params? }. */
export function errorBody(key, params, extra) {
  const p = cleanParams(params);
  return { error: formatFr(key, p), errorKey: String(key), ...(p && Object.keys(p).length ? { params: p } : {}), ...(extra || {}) };
}

/**
 * Normalize a log entry before it is stored: `i18n: { key, params }` is validated and `text` is filled with
 * the French rendering when missing (old clients, exports and the server console keep a readable text).
 */
export function normalizeLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const i = entry.i18n;
  if (i === undefined) return entry;
  if (!i || typeof i.key !== 'string' || !i.key) {
    delete entry.i18n;
    return entry;
  }
  const params = cleanParams(i.params);
  entry.i18n = params && Object.keys(params).length ? { key: i.key.slice(0, 1000), params } : { key: i.key.slice(0, 1000) };
  if (typeof entry.text !== 'string' || !entry.text) entry.text = formatFr(entry.i18n.key, entry.i18n.params);
  return entry;
}
