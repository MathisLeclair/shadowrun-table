// Translatable messages of the Foundry import (see ARCHITECTURE.md « i18n »): errors thrown deep in the
// converters/uploader carry their French key + params, so the action (ctx.fail) or route (errorBody) can
// send them to the browser, which shows them in the user's language.
import { formatFr, cleanParams } from '../../../client/i18n/format.ts';
import type { I18nMessage, I18nParams } from '../../../shared/types.ts';

/** Error carrying its French i18n key (and params) for the client. */
export interface I18nError extends Error {
  i18nKey?: string;
  i18nParams?: I18nParams;
}

/** Error class accepted by i18nError(): message first, then any extra constructor arguments (ZipError's status…). */
export type ErrorClass<E extends Error = Error> = new (message: string, ...rest: never[]) => E;

/**
 * Error carrying an i18n key: i18nError({ t: 'Texte {x}', params: { x } }, ErrorClass?, ...extra ctor args).
 * `err.message` is the French text (logs, old clients); `err.i18nKey` / `err.i18nParams` travel to the client.
 * The `{ t: '…' }` literal form lets tools/i18n-check.ts find the key.
 */
export function i18nError<E extends Error = Error>(msg: I18nMessage | string, Cls: ErrorClass<E> = Error as unknown as ErrorClass<E>, ...rest: unknown[]): E & I18nError {
  const m = msg as Partial<I18nMessage> | string | null | undefined;
  const key = String((typeof m === 'object' ? m?.t : undefined) ?? m ?? '');
  const params = cleanParams(typeof m === 'object' ? m?.params : undefined) as I18nParams | undefined;
  const err = new (Cls as new (message: string, ...rest: unknown[]) => E)(formatFr(key, params), ...rest) as E & I18nError;
  err.i18nKey = key;
  if (params && Object.keys(params).length) err.i18nParams = params;
  return err;
}

/** Translatable value of an error, for use as a param of another message ({ t, params } or its plain text). */
export const errorParam = (err: unknown): I18nMessage | string => {
  const e = err as (I18nError & { message?: unknown }) | null | undefined;
  return e?.i18nKey ? { t: e.i18nKey, ...(e.i18nParams ? { params: e.i18nParams } : {}) } : String(e?.message || err || '');
};

/**
 * Plural as a translatable param when the count is known server-side: pick the French form like the client's tn()
 * would (0 and 1 singular). `zero` is the singular key with a 'zero::' context, so French renders the same text
 * while English can say « 0 files ». Each argument is a { t: '…' } literal (found by the checker).
 */
export function plural(n: unknown, zero: I18nMessage, one: I18nMessage, other: I18nMessage): I18nMessage & { params: I18nParams } {
  const v = Number(n) || 0;
  const form = v === 0 ? zero : v === 1 ? one : other;
  return { t: form.t, params: { ...(form.params || {}), n: v } };
}

/** Size in French units ('12,3 Mo') as a translatable param ('12,3 MB' in English). */
export function bytesParam(n: unknown): I18nMessage {
  const v = Number(n) || 0;
  if (v >= 1e9) return { t: '{v} Go', params: { v: (v / 1e9).toFixed(1).replace('.', ',') } };
  if (v >= 1e6) return { t: '{v} Mo', params: { v: (v / 1e6).toFixed(1).replace('.', ',') } };
  if (v >= 1e3) return { t: '{v} ko', params: { v: Math.round(v / 1e3) } };
  return { t: '{v} o', params: { v } };
}
