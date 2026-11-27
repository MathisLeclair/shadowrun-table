// Global rulebook viewer: a resizable drawer on the right (mounted once by the registry, above the sheet modal).
// The PDF is drawn by the app's own pdf.js reader (PdfReader.tsx: downloaded once per browser and cached, continuous
// scroll, zoom, text selection, search highlights), on desktop and mobile; « Texte » shows the page's extracted text.
// Prev/next page, printed-page field, zoom, book switcher, full-text search, settings (zoom, browser cache). Esc closes it.
// A modal opened while the drawer is open (confirm dialog, item editor…) goes in front of it: the drawer steps behind
// (.behind) and leaves Esc to that modal until it closes or a book reference is opened again.
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { IconButton, Button, confirmAction } from '../../lib/ui.tsx';
import { api } from '../../lib/net.ts';
import { t, tn, fmtNumber } from '../../lib/i18n.ts';
import { toast } from '../../lib/ui-store.ts';
import { useViewer, useBooks, findBook, closeBook, gotoPdfPage, openBookPdf, printedToPdf, pdfToPrinted, searchBooks, setViewerSearch, loadBooks } from './store.ts';
import { bookName } from './BookRef.tsx';
import { PdfReader, fmtMB } from './PdfReader.tsx';
import { useBookCache, clearBookCache } from './bookcache.ts';
import { cachedByCode, MAX_BOOKS, MAX_BYTES } from './cachepolicy.ts';
import { releaseDocSoon } from './pdfdoc.ts';
import { zoomStep } from './readerlib.ts';
import type { LibBook, SearchHit, SearchResult, Zoom } from './types.ts';
import './books.css';

const WIDTH_KEY = 'sr.books.width';
const readWidth = () => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || 0;
  } catch {
    return 0;
  }
};
const saveWidth = (w: number) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {}
};
const clampWidth = (w: number) => Math.max(320, Math.min(window.innerWidth - 40, w));
const ZOOM_KEY = 'sr.books.zoom'; // 'width' | 'page' | number
const readZoom = (): Zoom => {
  try {
    const z = localStorage.getItem(ZOOM_KEY);
    return z === 'page' ? 'page' : Number(z) > 0 ? Number(z) : 'width';
  } catch {
    return 'width';
  }
};
const saveZoom = (z: Zoom) => {
  try {
    localStorage.setItem(ZOOM_KEY, String(z));
  } catch {}
};
const BACKENDS: Record<string, string> = { cache: 'Cache Storage', idb: 'IndexedDB' };

/** Snippet with highlighted ranges ([[start, end]] from the server). */
export function Snippet({ text, marks }: { text: string; marks?: [number, number][] }) {
  const parts: ReactNode[] = [];
  let i = 0;
  for (const [a, b] of marks || []) {
    if (a > i) parts.push(text.slice(i, a));
    parts.push(<mark key={a}>{text.slice(a, b)}</mark>);
    i = b;
  }
  if (i < text.length) parts.push(text.slice(i));
  return <span className="books-snippet">{parts}</span>;
}

/** Search hits list (viewer + Règles tab). onPick(hit). */
export function HitList({ hits, onPick, showBook = true }: { hits: SearchHit[]; onPick: (hit: SearchHit) => void; showBook?: boolean }) {
  return (
    <ul className="books-hits">
      {hits.map((h, i) => (
        <li key={`${h.code}:${h.pdfPage}:${i}`}>
          <button type="button" className="books-hit" onClick={() => onPick(h)}>
            <span className="books-hit-ref">
              {showBook ? (
                <>
                  <strong>{h.code}</strong>{' '}
                </>
              ) : null}
              {h.page ? t('p. {page}', { page: h.page }) : t('PDF {page}', { page: h.pdfPage })}
              {showBook && findBook(h.code) ? <span className="muted"> · {bookName(findBook(h.code))}</span> : null}
            </span>
            <Snippet text={h.snippet} marks={h.marks} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function PageText({ code, pdfPage }: { code: string; pdfPage: number }) {
  const [state, setState] = useState<{ loading?: boolean; text?: string; error?: string }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api<{ text: string }>(`/api/books/${encodeURIComponent(code)}/page/${pdfPage}?pdf=1`)
      .then((r) => alive && setState({ text: r.text }))
      .catch((err: Error) => alive && setState({ error: err.message }));
    return () => {
      alive = false;
    };
  }, [code, pdfPage]);
  if (state.loading) return <div className="muted small">{t('Chargement…')}</div>;
  if (state.error) return <div className="error">{state.error}</div>;
  return <div className="books-pagetext">{state.text || <span className="muted">{t('Pas de texte sur cette page (image).')}</span>}</div>;
}

function ViewerSearch({ code, onClose }: { code: string | null; onClose: () => void }) {
  const v = useViewer();
  const [q, setQ] = useState(v.searchQ || '');
  const [scope, setScope] = useState<'book' | 'all'>('book');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const query = q.trim();
    setViewerSearch(q);
    if (query.length < 2) {
      setRes(null);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      searchBooks(query, scope === 'book' ? code : '')
        .then((r) => alive && setRes(r))
        .catch((err: Error) => alive && setRes({ hits: [], total: 0, error: err.message }))
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, scope, code]);
  return (
    <div className="books-search">
      <div className="row gap-s">
        <input ref={inputRef} className="input grow" type="search" value={q} placeholder={t('Rechercher dans les règles… ("phrase exacte")')} onChange={(e) => setQ(e.target.value)} />
        <select className="input books-scope" value={scope} onChange={(e) => setScope(e.target.value as 'book' | 'all')} aria-label={t('Où chercher')}>
          <option value="book">{t('Ce livre')}</option>
          <option value="all">{t('Tous les livres')}</option>
        </select>
        <IconButton icon="✕" title={t('Fermer la recherche')} onClick={onClose} />
      </div>
      {busy && <div className="muted small">{t('Recherche…')}</div>}
      {res?.error && <div className="error small">{res.error}</div>}
      {res && !res.error && (
        <div className="muted small">
          {res.total ? tn(res.total, '{n} résultat', '{n} résultats') : t('Aucun résultat')}
          {res.total > res.hits.length ? ` · ${t('{n} premiers affichés', { n: res.hits.length })}` : ''}
        </div>
      )}
      {res && res.hits?.length > 0 && <HitList hits={res.hits} showBook={scope === 'all'} onPick={(h) => openBookPdf(h.code, h.pdfPage, { q: q.trim() })} />}
    </div>
  );
}

interface ViewerSettingsProps {
  book: LibBook | null;
  list: LibBook[] | null;
  zoom: Zoom;
  setZoom: (z: Zoom) => void;
  mode: 'pdf' | 'text';
  setMode: (m: 'pdf' | 'text') => void;
}

/** Viewer settings: zoom presets, display mode, and this browser's book cache (« Vider le cache des livres »). */
function ViewerSettings({ book, list, zoom, setZoom, mode, setMode }: ViewerSettingsProps) {
  const cache = useBookCache();
  const cached = cachedByCode(cache.entries, list || []);
  const mine = book ? cached.get(book.code) : null;
  const clear = async () => {
    if (!(await confirmAction(t('Supprimer les livres gardés par ce navigateur ? Ils seront retéléchargés à la prochaine ouverture.')))) return;
    await clearBookCache();
    toast(t('Cache des livres vidé'));
  };
  const opt = (active: boolean, label: string, onClick: () => void) => (
    <button type="button" className={'books-mode' + (active ? ' active' : '')} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div className="books-settings" role="group" aria-label={t('Réglages du lecteur')}>
      <div className="books-settings-row">
        <span className="muted small books-settings-label">{t('Zoom')}</span>
        {opt(zoom === 'width', t('Largeur de page'), () => setZoom('width'))}
        {opt(zoom === 'page', t('Page entière'), () => setZoom('page'))}
        {opt(zoom === 1, '100 %', () => setZoom(1))}
      </div>
      <div className="books-settings-row">
        <span className="muted small books-settings-label">{t('Affichage')}</span>
        {opt(mode === 'pdf', t('PDF'), () => setMode('pdf'))}
        {opt(mode === 'text', t('Texte'), () => setMode('text'))}
      </div>
      <div className="books-settings-row books-settings-cache">
        <span className="muted small books-settings-label">{t('Cache')}</span>
        <div className="grow col">
          {!cache.ready ? (
            <span className="muted small">{t('Chargement…')}</span>
          ) : cache.backend === 'none' ? (
            <span className="muted small">{t('Ce navigateur ne garde pas les livres (navigation privée ?) : chaque ouverture les retélécharge.')}</span>
          ) : (
            <>
              <span className="small">{tn(cache.entries.length, '{n} livre gardé par ce navigateur ({size})', '{n} livres gardés par ce navigateur ({size})', { size: fmtMB(cache.bytes) })}</span>
              <span className="muted small">
                {t('Au plus {n} livres / {size}, les moins lus sont retirés d’abord', { n: MAX_BOOKS, size: fmtMB(MAX_BYTES) })} · <span className="mono">{BACKENDS[cache.backend || ''] || cache.backend}</span>
              </span>
              {book && <span className="muted small">{mine ? t('{code} : en cache ({size})', { code: book.code, size: fmtMB(mine.size) }) : t('{code} : pas encore en cache', { code: book.code })}</span>}
            </>
          )}
        </div>
        <Button small variant="danger" disabled={!cache.entries.length} onClick={clear}>
          {t('Vider le cache des livres')}
        </Button>
      </div>
    </div>
  );
}

export default function BookViewer() {
  const v = useViewer();
  const list = useBooks();
  const [width, setWidth] = useState(() => clampWidth(readWidth() || Math.min(760, window.innerWidth * 0.5)));
  const [dragging, setDragging] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<'pdf' | 'text'>('pdf');
  const [zoom, setZoomState] = useState<Zoom>(readZoom);
  const [scale, setScale] = useState<number | null>(null);
  const [pageInput, setPageInput] = useState('');
  const [behind, setBehind] = useState(false);
  const setZoom = (z: Zoom) => {
    setZoomState(z);
    saveZoom(z);
  };

  // Modals opened after the drawer (or after the last openBook) go in front of it.
  useEffect(() => {
    if (!v.open) {
      setBehind(false);
      return undefined;
    }
    const baseline = new Set(document.querySelectorAll('.modal-backdrop'));
    const check = () => setBehind([...document.querySelectorAll('.modal-backdrop')].some((el) => !baseline.has(el)));
    let raf = 0;
    const mo = new MutationObserver(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          check();
        });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    check();
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [v.open, v.raise]);

  // Esc closes the drawer first (capture phase: before the sheet modal's own Esc handler), unless a newer modal is in front.
  useEffect(() => {
    if (!v.open || behind) return undefined;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else if (searchOpen) setSearchOpen(false);
      else closeBook();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [v.open, searchOpen, settingsOpen, behind]);

  // Renew signed links when the drawer opens (valid a day; only used for downloads and the new-tab link).
  useEffect(() => {
    if (v.open) loadBooks();
  }, [v.open, v.code]);

  // Closed drawer: the open document is kept 10 min (reopening / another reference is instant), then freed.
  useEffect(() => {
    if (!v.open) releaseDocSoon();
  }, [v.open]);

  const book = list ? findBook(v.code) : null;
  const printed: number | null = book && v.pdfPage ? pdfToPrinted(book, v.pdfPage) : null;
  useEffect(() => setPageInput(printed ? String(printed) : ''), [printed, v.code]);

  if (!v.open) return null;

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = (ev: PointerEvent) => {
      setDragging(false);
      const w = clampWidth(window.innerWidth - ev.clientX);
      setWidth(w);
      saveWidth(w);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const goPrinted = () => {
    const n = parseInt(pageInput, 10);
    if (!book || !(n > 0) || n === printed) return;
    const p = printedToPdf(book, n);
    if (p) gotoPdfPage(p);
    else {
      toast(t('Page {page} introuvable dans ce livre', { page: n }), 'error');
      setPageInput(printed ? String(printed) : '');
    }
  };
  const pdfUrl = book ? `${book.url}#page=${v.pdfPage || 1}` : undefined;

  let body: ReactNode;
  if (!list) body = <div className="books-empty muted">{t('Chargement…')}</div>;
  else if (!book)
    body = (
      <div className="books-empty">
        <p>{v.printed ? t('Livre non disponible sur ce serveur ({code} p. {page})', { code: v.code, page: v.printed }) : t('Livre non disponible sur ce serveur ({code})', { code: v.code })}</p>
        <p className="muted small">{t('L’administrateur du serveur peut ajouter ses PDF depuis la page Administration (Livres de règles).')}</p>
      </div>
    );
  else if (v.badPage)
    body = (
      <div className="books-empty">
        <p>{t('Page {page} introuvable dans ce livre', { page: v.printed })}</p>
        <p className="muted small">{t('La référence ne correspond à aucune page de ce PDF : vérifie le décalage du livre (page Administration).')}</p>
      </div>
    );
  else if (!v.pdfPage) body = <div className="books-empty muted">{t('Chargement…')}</div>;
  else if (mode === 'pdf') body = <PdfReader key={book.code} book={book} v={v} zoom={zoom} onScale={setScale} onTextMode={() => setMode('text')} />;
  else
    body = (
      <div className="books-textmode">
        <a className="btn btn-primary" href={pdfUrl} target="_blank" rel="noopener">
          {t('Ouvrir le PDF')}
        </a>
        <PageText code={book.code} pdfPage={v.pdfPage || 1} />
      </div>
    );

  return (
    <aside className={'books-drawer' + (dragging ? ' dragging' : '') + (behind ? ' behind' : '')} style={{ width: `${width}px` }} role="dialog" aria-label={t('Livre de règles')}>
      <div className="books-resize" onPointerDown={startDrag} title={t('Glisser pour redimensionner')}></div>
      <header className="books-head">
        <select className="input books-switch" value={v.code || ''} aria-label={t('Livre')} onChange={(e) => openBookPdf(e.target.value, 1)}>
          {!book && v.code && <option value={v.code}>{v.code}</option>}
          {(list || []).map((b) => (
            <option key={b.code} value={b.code}>
              {b.code} — {bookName(b)}
            </option>
          ))}
        </select>
        {book && (
          <div className="books-nav">
            <IconButton icon="◀" title={t('Page précédente')} disabled={(v.pdfPage || 1) <= 1} onClick={() => gotoPdfPage((v.pdfPage || 1) - 1)} />
            <label className="books-pageinput" title={t('Page imprimée (PDF {pdf} / {pages})', { pdf: v.pdfPage || 1, pages: book.pages })}>
              <span className="muted small">{t('p.')}</span>
              <input
                className="input"
                inputMode="numeric"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && goPrinted()}
                onBlur={goPrinted}
              />
            </label>
            <IconButton icon="▶" title={t('Page suivante')} disabled={(v.pdfPage || 1) >= book.pages} onClick={() => gotoPdfPage((v.pdfPage || 1) + 1)} />
          </div>
        )}
        {book && mode === 'pdf' && (
          <div className="books-zoom">
            <IconButton icon="−" title={t('Zoom arrière')} onClick={() => setZoom(zoomStep(scale || 1, -1))} />
            <button
              type="button"
              className="books-zoom-label"
              onClick={() => setZoom(zoom === 'width' ? 'page' : 'width')}
              title={zoom === 'width' ? t('Largeur de page (cliquer : page entière)') : t('Cliquer : largeur de page')}
            >
              {scale ? `${fmtNumber(Math.round(scale * 100))} %` : '…'}
            </button>
            <IconButton icon="+" title={t('Zoom avant')} onClick={() => setZoom(zoomStep(scale || 1, 1))} />
          </div>
        )}
        <div className="books-tools">
          {book && (
            <button
              type="button"
              className={'books-mode' + (mode === 'text' ? ' active' : '')}
              title={mode === 'pdf' ? t('Afficher le texte de la page') : t('Afficher le PDF')}
              onClick={() => setMode(mode === 'pdf' ? 'text' : 'pdf')}
            >
              {mode === 'pdf' ? t('Texte') : t('PDF')}
            </button>
          )}
          {book && (
            <a className="icon-btn" href={pdfUrl} target="_blank" rel="noopener" title={t('Ouvrir dans un nouvel onglet')}>
              ↗
            </a>
          )}
          <IconButton icon="⌕" title={t('Rechercher dans les règles')} onClick={() => setSearchOpen(!searchOpen)} />
          <IconButton icon="⚙" className={settingsOpen ? 'books-on' : ''} title={t('Réglages du lecteur')} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)} />
          <IconButton icon="✕" title={t('Fermer (Échap)')} onClick={closeBook} />
        </div>
      </header>
      {settingsOpen && <ViewerSettings book={book} list={list} zoom={zoom} setZoom={setZoom} mode={mode} setMode={setMode} />}
      {searchOpen && <ViewerSearch code={v.code} onClose={() => setSearchOpen(false)} />}
      <div className="books-body">{body}</div>
    </aside>
  );
}
