// « Règles » tab (GM + players): the rulebooks available on this server, full-text search across them, and quick
// links to the most used rules. Every result opens the global viewer drawer (BookViewer) at the right page.
import { useEffect, useState } from 'react';
import { Panel, Empty, Badge, Button, confirmAction } from '../../lib/ui.tsx';
import { t, tn } from '../../lib/i18n.ts';
import type { GameProps } from '../../lib/net.ts';
import { useBooks, booksError, findBook, openBookPdf, openBook, searchBooks } from './store.ts';
import { bookName } from './BookRef.tsx';
import { HitList } from './BookViewer.tsx';
import { QUICK_LINKS } from './quicklinks.ts';
import { useBookCache, clearBookCache } from './bookcache.ts';
import { cachedByCode } from './cachepolicy.ts';
import { fmtMB } from './PdfReader.tsx';
import { toast } from '../../lib/ui-store.ts';
import type { CacheSnapshot, LibBook, SearchResult } from './types.ts';
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
        <input className="input search grow" type="search" value={q} placeholder={t('Rechercher dans les règles… ("phrase exacte")')} onChange={(e) => setQ(e.target.value)} />
        <select className="input books-scope" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('Où chercher')}>
          <option value="">{t('Tous les livres')}</option>
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
        {t('Sans accents ni majuscules. Tous les mots doivent être sur la page ; mets une expression entre guillemets pour la chercher telle quelle. Le texte des livres est en anglais.')}
      </span>
      {busy && <div className="muted small">{t('Recherche…')}</div>}
      {res?.error && <div className="error small">{res.error}</div>}
      {res && !res.error && (
        <div className="muted small">
          {res.total ? tn(res.total, '{n} résultat', '{n} résultats') : t('Aucun résultat')}
          {res.total > res.hits.length ? ` · ${t('{n} premiers affichés', { n: res.hits.length })}` : ''}
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
                title={b ? t('{book}, p. {page}', { book: bookName(b), page: it.page }) : t('Livre non disponible sur ce serveur ({code} p. {page})', { code: it.code, page: it.page })}
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
    if (!(await confirmAction(t('Supprimer les livres gardés par ce navigateur ? Ils seront retéléchargés à la prochaine ouverture.')))) return;
    await clearBookCache();
    toast(t('Cache des livres vidé'));
  };
  const n = cachedByCode(cache.entries, books).size;
  return (
    <div className="books-cacheline muted small">
      <span>{tn(n, '{n} livre gardé par ce navigateur ({size})', '{n} livres gardés par ce navigateur ({size})', { size: fmtMB(cache.bytes) })}</span>
      <Button small variant="ghost" onClick={clear}>
        {t('Vider le cache des livres')}
      </Button>
    </div>
  );
}

export default function BooksPage({ game }: GameProps) {
  const books = useBooks();
  const cache = useBookCache();
  const cached = cachedByCode(cache.entries, books || []);
  const isGM = game?.me?.role === 'gm';
  const err = booksError();
  return (
    <div className="page books-tab">
      <div className="page-title">
        <h2>{t('Règles')}</h2>
      </div>
      {books === null ? (
        <Empty>{t('Chargement…')}</Empty>
      ) : !books.length ? (
        <Panel>
          <Empty>{err ? err.message : t('Aucun livre de règles sur ce serveur.')}</Empty>
          {isGM && <p className="muted small books-center">{t('L’administrateur du serveur peut ajouter ses PDF depuis la page Administration (Livres de règles).')}</p>}
        </Panel>
      ) : (
        <>
          <Panel title={t('Recherche dans les livres')}>
            <Search books={books} />
          </Panel>
          <div className="books-grid">
            <Panel title={t('Règles courantes')}>
              <QuickLinks />
            </Panel>
            <Panel title={t('Bibliothèque')}>
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
                              <Badge color="green" title={t('Déjà téléchargé : s’ouvre sans attendre ({size})', { size: fmtMB(hit.size) })}>
                                {t('en cache')}
                              </Badge>
                            </>
                          )}
                        </div>
                        <div className="muted small">
                          {tn(b.pages, '{n} page', '{n} pages')}
                          {b.indexed ? '' : ` · ${t('pas encore indexé')}`}
                        </div>
                      </div>
                      <Button small onClick={() => openBookPdf(b.code, 1)}>
                        {t('Ouvrir')}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <CacheLine cache={cache} books={books} />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
