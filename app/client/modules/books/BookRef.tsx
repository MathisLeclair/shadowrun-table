// <BookRef source="RG" page="62" label? /> — small « 📖 RG 62 » chip that opens the rulebook viewer at that page.
// Also: <BookRef source="SR5 p. 240" />, <BookRef source={{ source: 'RG', page: 62 }} />.
// <ItemRef item /> = the chip of an actor item / catalog entry (item.source + item.page), <RuleRef rule="limits" />,
// <SkillRef id="pistols" /> (shared/bookrefs.js tables). Nothing is rendered without a reference.
// Other modules: import { BookRef, ItemRef, RuleRef, SkillRef, openBook, parseSourceRef } from '../books/BookRef.tsx';
import type { MouseEvent } from 'react';
import { t, getLang } from '../../lib/i18n.js';
import { itemRef, ruleRef, skillRef } from '/shared/bookrefs.js';
import { useBooks, findBook, openBook, parseSourceRef, openBookPdf, closeBook } from './store.ts';
import type { LibBook } from './types.ts';
import './books.css';

export { openBook, openBookPdf, closeBook, parseSourceRef };

/** Display name of a library book in the UI language. */
export const bookName = (b: Pick<LibBook, 'name' | 'nameFr'> | null | undefined): string => (b ? (getLang() === 'fr' ? b.nameFr || b.name : b.name || b.nameFr) : '');

/** A reference: 'RG 62', 'SR5 p. 240', { source, page } or { code, page }. */
export type SourceRef = string | { source?: string | null; code?: string | null; page?: number | string | null } | null | undefined;

interface BookRefProps {
  source: SourceRef;
  page?: number | string | null;
  label?: string;
  title?: string;
  className?: string;
}

export function BookRef({ source, page, label, title, className }: BookRefProps) {
  const list = useBooks();
  const ref = parseSourceRef(source, page);
  if (!ref) return null;
  const b = list ? findBook(ref.code) : null;
  const missing = list !== null && !b;
  const text = label || (ref.page ? `${ref.code} ${ref.page}` : ref.code);
  // « Ouvrir Run & Gun p. 62 » (accessible name); a book absent from the server keeps a dashed chip that says so.
  const tip =
    title ||
    (missing
      ? ref.page
        ? t('Livre non disponible sur ce serveur ({code} p. {page})', { code: ref.code, page: ref.page })
        : t('Livre non disponible sur ce serveur ({code})', { code: ref.code })
      : ref.page
        ? t('Ouvrir {book} p. {page}', { book: bookName(b) || ref.code, page: ref.page })
        : t('Ouvrir {book}', { book: bookName(b) || ref.code }));
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openBook(ref.code, ref.page);
  };
  return (
    <button type="button" className={'bookref' + (missing ? ' missing' : '') + (className ? ` ${className}` : '')} title={tip} aria-label={tip} onClick={onClick}>
      <span className="bookref-icon" aria-hidden="true">
        📖
      </span>
      <span>{text}</span>
    </button>
  );
}

/** 📖 chip of an actor item or a catalog entry ({ source, page }); nothing when it has no reference. */
export function ItemRef({ item, className }: { item: unknown; className?: string }) {
  const r = itemRef(item);
  return r ? <BookRef source={r.source} page={r.page} className={className} /> : null;
}

/** 📖 chip of a rule of shared/bookrefs.js RULE_REFS (« limits », « initiative », « conditionMonitor »…). */
export function RuleRef({ rule, className }: { rule: string; className?: string }) {
  const r = ruleRef(rule);
  return r ? <BookRef source={r.source} page={r.page} className={className} /> : null;
}

/** 📖 chip of an active skill (SR5 page of its description); nothing for custom / knowledge skills. */
export function SkillRef({ id, className }: { id: string | null | undefined; className?: string }) {
  const r = skillRef(id);
  return r ? <BookRef source={r.source} page={r.page} className={className} /> : null;
}

export default BookRef;
