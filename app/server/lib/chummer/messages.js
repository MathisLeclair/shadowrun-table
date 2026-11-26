// Translatable messages of the Chummer interop (see ARCHITECTURE.md « i18n »): same helpers as the Foundry import.
//   i18nError({ t: 'Texte {x}', params }, ErrorClass?)  → error whose message is French, carrying i18nKey/i18nParams
//   errorParam(err)                                      → an error as a translatable param of another message
export { i18nError, errorParam } from '../foundry/messages.js';
import { formatFr } from '../../../client/i18n/format.js';

/**
 * Warning list kept in two forms: `list` = French strings (stored/sent as before, e.g. toasts of older pages),
 * `i18n` = [{ t, params }] the Chummer UI translates. add({ t: '…', params }).
 */
export function warningList() {
  const list = [];
  const i18n = [];
  return {
    list,
    i18n,
    add(m) {
      i18n.push(m.params ? { t: m.t, params: m.params } : { t: m.t });
      list.push(formatFr(m.t, m.params));
    },
  };
}
