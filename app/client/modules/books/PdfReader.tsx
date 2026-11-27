// In-app rulebook reader (React shell around PdfView): opens the book through pdfdoc.ts (browser cache first, else
// one download with a progress bar), then scrolls / zooms / highlights inside the same document for every page jump.
import { useEffect, useRef } from 'react';
import { Button } from '../../lib/ui.tsx';
import { t, fmtNumber } from '../../lib/i18n.js';
import { ensureDoc, useDocState, loadPdfjs, type DocState } from './pdfdoc.ts';
import { PdfView, type Highlight } from './pdfview.ts';
import { queryTerms } from './readerlib.js';
import { cacheKey } from './cachepolicy.js';
import { getViewer, reportPdfPage } from './store.ts';
import type { LibBook, ViewerState, Zoom } from './types.ts';

/** « 12,5 Mo » */
export const fmtMB = (bytes: unknown): string => t('{n} Mo', { n: fmtNumber((Number(bytes) || 0) / 1048576, { maximumFractionDigits: 1 }) });

const hlFor = (v: ViewerState): Highlight | null => (v.hl && v.hl.pdfPage === v.pdfPage ? { terms: queryTerms(v.hl.q), scroll: true } : null);

function Progress({ ds }: { ds: Pick<DocState, 'stage'> & Partial<DocState> }) {
  let label = t('Ouverture du livre…');
  if (ds.stage === 'lib') label = t('Chargement du lecteur…');
  else if (ds.stage === 'cache') label = t('Lecture du cache…');
  else if (ds.stage === 'download') label = t('Téléchargement du livre (une seule fois, il reste ensuite dans ce navigateur)…');
  const total = ds.total || 0;
  const loaded = ds.loaded || 0;
  const pct = ds.stage === 'download' && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  return (
    <div className="books-loading">
      <div>{label}</div>
      {ds.stage === 'download' && (
        <>
          <div className="books-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <div className="books-progress-bar" style={{ width: pct === null ? '30%' : `${pct}%` }}></div>
          </div>
          <div className="muted small mono">{total ? t('{loaded} / {total}', { loaded: fmtMB(loaded), total: fmtMB(total) }) : fmtMB(loaded)}</div>
        </>
      )}
    </div>
  );
}

interface PdfReaderProps {
  book: LibBook;
  v: ViewerState;
  zoom: Zoom;
  onScale: (scale: number) => void;
  onTextMode: () => void;
}

/**
 * book = library entry ({ code, version, url, size }); v = viewer state (pdfPage, nav, hl); zoom = 'width'|'page'|number;
 * onScale(scale) = actual scale (for the « 120 % » label); onTextMode() = switch the drawer to the page text.
 */
export function PdfReader({ book, v, zoom, onScale, onTextMode }: PdfReaderProps) {
  const ds = useDocState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<PdfView | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const key = cacheKey(book) || book.code;

  useEffect(() => {
    ensureDoc(book);
  }, [key]);

  const mine = ds.code === book.code && ds.status === 'ready' ? ds.doc : null;
  useEffect(() => {
    if (!mine || !scrollRef.current) return undefined;
    const el = scrollRef.current;
    let view: PdfView | null = null;
    let cancelled = false;
    loadPdfjs().then(({ lib }) => {
      if (cancelled) return;
      const created = new PdfView(el, { lib, onPage: reportPdfPage, onScale });
      view = created;
      viewRef.current = created;
      created.zoom = typeof zoomRef.current === 'number' ? zoomRef.current : zoomRef.current === 'page' ? 'page' : 'width';
      const cur = getViewer();
      created.goto(cur.pdfPage || 1, hlFor(cur)); // queued until the document is laid out
      created.setDocument(mine, cur.pdfPage || 1);
    });
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [mine]);

  // Navigation requests (BookRef chip, prev/next, page field, search hit): scroll inside the open document.
  useEffect(() => {
    const view = viewRef.current;
    if (view && v.pdfPage) view.goto(v.pdfPage, hlFor(v));
  }, [v.nav]);

  useEffect(() => {
    viewRef.current?.setZoom(zoom);
  }, [zoom]);

  const loading = ds.code !== book.code || ds.status === 'loading' || ds.status === 'idle';
  return (
    <div className="books-reader">
      <div className="books-scroll" ref={scrollRef} tabIndex={0} aria-label={t('Pages du livre')}></div>
      {loading && <Progress ds={ds.code === book.code ? ds : { stage: 'lib' }} />}
      {ds.code === book.code && ds.status === 'error' && (
        <div className="books-loading">
          <div className="error">{t('Impossible d’ouvrir ce livre : {error}', { error: ds.error })}</div>
          <div className="row gap-s wrap">
            <Button small onClick={() => ensureDoc(book)}>
              {t('Réessayer')}
            </Button>
            <Button small onClick={onTextMode}>
              {t('Afficher le texte de la page')}
            </Button>
            <a className="btn btn-default btn-sm" href={`${book.url}#page=${v.pdfPage || 1}`} target="_blank" rel="noopener">
              {t('Ouvrir dans un nouvel onglet')}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
