// <BookRef source="RG" page="62" label? /> — small « 📖 RG 62 » chip that opens the rulebook viewer at that page.
// Also: <BookRef source="SR5 p. 240" />, <BookRef source=${{ source: 'RG', page: 62 }} />.
// <ItemRef item /> = the chip of an actor item / catalog entry (item.source + item.page), <RuleRef rule="limits" />,
// <SkillRef id="pistols" /> (shared/bookrefs.js tables). Nothing is rendered without a reference.
// Other modules: import { BookRef, ItemRef, RuleRef, SkillRef, openBook, parseSourceRef } from '../books/BookRef.js';
import { html, loadCss } from '../../lib/ui.js';
import { t, getLang } from '../../lib/i18n.js';
import { itemRef, ruleRef, skillRef } from '/shared/bookrefs.js';
import { useBooks, findBook, openBook, parseSourceRef, openBookPdf, closeBook } from './store.js';

loadCss('/modules/books/books.css');

export { openBook, openBookPdf, closeBook, parseSourceRef };

/** Display name of a library book in the UI language. */
export const bookName = (b) => (b ? (getLang() === 'fr' ? b.nameFr || b.name : b.name || b.nameFr) : '');

export function BookRef({ source, page, label, title, class: klass }) {
  const list = useBooks();
  const ref = parseSourceRef(source, page);
  if (!ref) return null;
  const b = list ? findBook(ref.code) : null;
  const missing = list !== null && !b;
  const text = label || (ref.page ? `${ref.code} ${ref.page}` : ref.code);
  // « Ouvrir Run & Gun p. 62 » (accessible name); a book absent from the server keeps a dashed chip that says so.
  const tip = title || (missing
    ? ref.page ? t('Livre non disponible sur ce serveur ({code} p. {page})', { code: ref.code, page: ref.page }) : t('Livre non disponible sur ce serveur ({code})', { code: ref.code })
    : ref.page ? t('Ouvrir {book} p. {page}', { book: bookName(b) || ref.code, page: ref.page }) : t('Ouvrir {book}', { book: bookName(b) || ref.code }));
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openBook(ref.code, ref.page);
  };
  return html`<button type="button" class=${'bookref' + (missing ? ' missing' : '') + (klass ? ` ${klass}` : '')} title=${tip} aria-label=${tip} onClick=${onClick}>
    <span class="bookref-icon" aria-hidden="true">📖</span><span>${text}</span>
  </button>`;
}

/** 📖 chip of an actor item or a catalog entry ({ source, page }); nothing when it has no reference. */
export function ItemRef({ item, class: klass }) {
  const r = itemRef(item);
  return r ? html`<${BookRef} source=${r.source} page=${r.page} class=${klass} />` : null;
}

/** 📖 chip of a rule of shared/bookrefs.js RULE_REFS (« limits », « initiative », « conditionMonitor »…). */
export function RuleRef({ rule, class: klass }) {
  const r = ruleRef(rule);
  return r ? html`<${BookRef} source=${r.source} page=${r.page} class=${klass} />` : null;
}

/** 📖 chip of an active skill (SR5 page of its description); nothing for custom / knowledge skills. */
export function SkillRef({ id, class: klass }) {
  const r = skillRef(id);
  return r ? html`<${BookRef} source=${r.source} page=${r.page} class=${klass} />` : null;
}

export default BookRef;
