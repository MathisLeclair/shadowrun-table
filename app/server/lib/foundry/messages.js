// Translatable messages of the Foundry import (see ARCHITECTURE.md « i18n »): errors thrown deep in the
// converters/uploader carry their French key + params, so the action (ctx.fail) or route (errorBody) can
// send them to the browser, which shows them in the user's language.
import { formatFr, cleanParams } from '../../../client/i18n/format.js';

/**
 * Error carrying an i18n key: i18nError({ t: 'Texte {x}', params: { x } }, ErrorClass?, ...extra ctor args).
 * `err.message` is the French text (logs, old clients); `err.i18nKey` / `err.i18nParams` travel to the client.
 * The `{ t: '…' }` literal form lets tools/i18n-check.js find the key.
 */
export function i18nError(msg, Cls = Error, ...rest) {
  const key = String(msg?.t ?? msg ?? '');
  const params = cleanParams(msg?.params);
  const err = new Cls(formatFr(key, params), ...rest);
  err.i18nKey = key;
  if (params && Object.keys(params).length) err.i18nParams = params;
  return err;
}

/** Translatable value of an error, for use as a param of another message ({ t, params } or its plain text). */
export const errorParam = (err) => (err?.i18nKey ? { t: err.i18nKey, ...(err.i18nParams ? { params: err.i18nParams } : {}) } : String(err?.message || err || ''));

/**
 * Plural as a translatable param when the count is known server-side: pick the French form like the client's tn()
 * would (0 and 1 singular). `zero` is the singular key with a 'zero::' context, so French renders the same text
 * while English can say « 0 files ». Each argument is a { t: '…' } literal (found by the checker).
 */
export function plural(n, zero, one, other) {
  const v = Number(n) || 0;
  const form = v === 0 ? zero : v === 1 ? one : other;
  return { t: form.t, params: { ...(form.params || {}), n: v } };
}

/** Size in French units ('12,3 Mo') as a translatable param ('12,3 MB' in English). */
export function bytesParam(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return { t: '{v} Go', params: { v: (v / 1e9).toFixed(1).replace('.', ',') } };
  if (v >= 1e6) return { t: '{v} Mo', params: { v: (v / 1e6).toFixed(1).replace('.', ',') } };
  if (v >= 1e3) return { t: '{v} ko', params: { v: Math.round(v / 1e3) } };
  return { t: '{v} o', params: { v } };
}
