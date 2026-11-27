import type { I18nParams } from '../shared/types.ts';

// Throw from an action handler to send a readable error back to the client (no stack trace logged).
export class ActionError extends Error {
  /** French source text of the message (dictionary key), set by ctx.fail(). */
  declare i18nKey?: string;
  declare i18nParams?: I18nParams;
}
