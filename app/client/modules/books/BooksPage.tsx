// « Règles » tab (GM + players): the rulebooks available on this server, full-text search across them, and quick
// links to the most used rules. Every result opens the global viewer drawer (BookViewer) at the right page.
import { useEffect, useState } from 'react';
import { Panel, Empty, Badge, Button, confirmAction } from '../../lib/ui.tsx';
import { t, tn } from '../../lib/i18n.ts';
import type { GameProps } from '../../lib/net.ts';
import { useBooks, booksError, findBook, openBookPdf, openBook, searchBooks, getMissingBooks, loadBooks } from './store.ts';
import { bookName } from './BookRef.tsx';
import { HitList } from './BookViewer.tsx';
import { QUICK_LINKS } from './quicklinks.ts';
import { useBookCache, clearBookCache } from './bookcache.ts';
import { cachedByCode } from './cachepolicy.ts';
import { fmtMB } from './PdfReader.tsx';
import { toast } from '../../lib/ui-store.ts';
import type { CacheSnapshot, LibBook, MissingBook, SearchResult } from './types.ts';
import './books.css';

function Search({ books }: { books: LibBook[] }) {
  const [q, setQ] = useState('');
  const [code, setCode] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setRes(null);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      searchBooks(query, code)
        .then((r) => alive && setRes(r))
        .catch((err: Error) => alive && setRes({ hits: [], total: 0, error: err.message }))
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, code]);
  return (
    <div className="col">
      <div className="row gap-s wrap">
        <input className="input search grow" type="search" value={q} placeholder={t('Search the rules… ("exact phrase")')} onChange={(e) => setQ(e.target.value)} />
        <select className="input books-scope" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('Where to search')}>
          <option value="">{t('All books')}</option>
          {books
            .filter((b) => b.indexed)
            .map((b) => (
              <option key={b.code} value={b.code}>
                {b.code} — {bookName(b)}
              </option>
            ))}
        </select>
      </div>
      <span className="field-hint">
        {t('Case and accents don’t matter. Every word must be on the page; put an expression in quotes to search it as is. The books’ text is in English.')}
      </span>
      {busy && <div className="muted small">{t('Searching…')}</div>}
      {res?.error && <div className="error small">{res.error}</div>}
      {res && !res.error && (
        <div className="muted small">
          {res.total ? tn(res.total, '{n} result', '{n} results') : t('No results')}
          {res.total > res.hits.length ? ` · ${t('first {n} shown', { n: res.hits.length })}` : ''}
        </div>
      )}
      {res && res.hits?.length > 0 && <HitList hits={res.hits} onPick={(h) => openBookPdf(h.code, h.pdfPage, { q: q.trim() })} />}
    </div>
  );
}

interface QuickGroup {
  group: string;
  items: { label: string; code: string; page: number }[];
}

function QuickLinks() {
  return (
    <div className="books-quick">
      {(QUICK_LINKS as QuickGroup[]).map((g) => (
        <div className="books-quick-group" key={g.group}>
          <div className="section-title">{t(g.group)}</div>
          {g.items.map((it) => {
            const b = findBook(it.code);
            return (
              <button
                type="button"
                key={`${it.code}-${it.page}-${it.label}`}
                className={'books-quick-link' + (b ? '' : ' missing')}
                onClick={() => openBook(it.code, it.page)}
                title={b ? t('{book}, p. {page}', { book: bookName(b), page: it.page }) : t('Book not available on this server ({code} p. {page})', { code: it.code, page: it.page })}
              >
                <span>{t(it.label)}</span>
                <span className="mono small muted">
                  {it.code} {it.page}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** « 3 livres gardés par ce navigateur (85 Mo) — Vider » under the library. */
function CacheLine({ cache, books }: { cache: CacheSnapshot; books: LibBook[] }) {
  if (!cache.ready || cache.backend === 'none' || !cache.entries.length) return null;
  const clear = async () => {
    if (!(await confirmAction(t('Delete the books kept by this browser? They will be downloaded again the next time they are opened.')))) return;
    await clearBookCache();
    toast(t('Book cache cleared'));
  };
  const n = cachedByCode(cache.entries, books).size;
  return (
    <div className="books-cacheline muted small">
      <span>{tn(n, '{n} book kept by this browser ({size})', '{n} books kept by this browser ({size})', { size: fmtMB(cache.bytes) })}</span>
      <Button small variant="ghost" onClick={clear}>
        {t('Clear the book cache')}
      </Button>
    </div>
  );
}

/** One greyed-out book of the library that this table cannot read yet (uploads happen on the /admin page only). */
function MissingCard({ book }: { book: MissingBook }) {
  return (
    <div className="books-card missing">
      <Badge color="dim">{book.code}</Badge>
      <div className="grow books-card-name">{bookName(book)}</div>
    </div>
  );
}

/** Every SR5 book Chummer knows that is not on this server (or not open to this table): German-only books folded apart. */
function MissingBooks({ list, isGM }: { list: MissingBook[]; isGM: boolean }) {
  if (!list.length) return null;
  // Sorted by the name shown in the current language (the server sorts by the English one), core rules first.
  const byName = (a: MissingBook, b: MissingBook) => Number(b.code === 'SR5') - Number(a.code === 'SR5') || bookName(a).localeCompare(bookName(b));
  const main = list.filter((b) => !b.de).sort(byName);
  const de = list.filter((b) => b.de).sort(byName);
  return (
    <div className="books-missing">
      <div className="section-title">{t('Not on this server ({n})', { n: list.length })}</div>
      <span className="field-hint">
        {isGM
          ? t('The server administrator can add their PDFs from the Administration page (Rulebooks).')
          : t('The game master can ask the server administrator to add these books.')}
      </span>
      <div className="books-list">
        {main.map((b) => (
          <MissingCard key={b.code} book={b} />
        ))}
      </div>
      {de.length > 0 && (
        <details className="books-missing-de">
          <summary className="muted small">{t('German-only books ({n})', { n: de.length })}</summary>
          <div className="books-list">
            {de.map((b) => (
              <MissingCard key={b.code} book={b} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Books of this server readable from the table, then the known SR5 books it lacks (greyed out). */
function Library({ books, missing, cache, isGM }: { books: LibBook[]; missing: MissingBook[]; cache: CacheSnapshot; isGM: boolean }) {
  const cached = cachedByCode(cache.entries, books);
  return (
    <>
      {!books.length && <Empty>{t('No rulebook on this server.')}</Empty>}
      <div className="books-list">
        {books.map((b) => {
          const hit = cached.get(b.code);
          return (
            <div className="books-card" key={b.code}>
              <Badge color={b.extra ? 'dim' : 'cyan'}>{b.code}</Badge>
              <div className="grow">
                <div className="books-card-name">
                  {bookName(b)}
                  {hit && (
                    <>
                      {' '}
                      <Badge color="green" title={t('Already downloaded: opens instantly ({size})', { size: fmtMB(hit.size) })}>
                        {t('cached')}
                      </Badge>
                    </>
                  )}
                </div>
                <div className="muted small">
                  {b.indexed ? tn(b.pages, '{n} page', '{n} pages') : t('Indexing… (search and page numbers come once it is done)')}
                </div>
              </div>
              <Button small onClick={() => openBookPdf(b.code, 1)}>
                {t('Open')}
              </Button>
            </div>
          );
        })}
      </div>
      <CacheLine cache={cache} books={books} />
      <MissingBooks list={missing} isGM={isGM} />
    </>
  );
}

export default function BooksPage({ game }: GameProps) {
  const books = useBooks();
  const cache = useBookCache();
  const isGM = game?.me?.role === 'gm';
  const err = booksError();
  const missing = books ? getMissingBooks() : [];
  // A book just uploaded on /admin is indexed in the background: refresh the list until it is done (30 tries at most).
  const indexing = !!books?.some((b) => !b.indexed);
  useEffect(() => {
    if (!indexing) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 30) clearInterval(timer);
      else loadBooks(true);
    }, 10000);
    return () => clearInterval(timer);
  }, [indexing]);
  const library = <Library books={books || []} missing={missing} cache={cache} isGM={isGM} />;
  return (
    <div className="page books-tab">
      <div className="page-title">
        <h2>{t('Rules')}</h2>
      </div>
      {books === null ? (
        <Empty>{t('Loading…')}</Empty>
      ) : !books.length ? (
        <Panel title={t('Library')}>
          {err ? <Empty>{err.message}</Empty> : library}
        </Panel>
      ) : (
        <>
          <Panel title={t('Search the books')}>
            <Search books={books} />
          </Panel>
          <div className="books-grid">
            <Panel title={t('Common rules')}>
              <QuickLinks />
            </Panel>
            <Panel title={t('Library')}>{library}</Panel>
          </div>
        </>
      )}
    </div>
  );
}
