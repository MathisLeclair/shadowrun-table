// In-app rulebook reader (Preact shell around PdfView): opens the book through pdfdoc.js (browser cache first, else
// one download with a progress bar), then scrolls / zooms / highlights inside the same document for every page jump.
import { useEffect, useRef } from 'preact/hooks';
import { html, Button } from '../../lib/ui.js';
import { t, fmtNumber } from '../../lib/i18n.js';
import { ensureDoc, useDocState, loadPdfjs } from './pdfdoc.js';
import { PdfView } from './pdfview.js';
import { queryTerms } from './readerlib.js';
import { cacheKey } from './cachepolicy.js';
import { getViewer, reportPdfPage } from './store.js';

/** « 12,5 Mo » */
export const fmtMB = (bytes) => t('{n} Mo', { n: fmtNumber((Number(bytes) || 0) / 1048576, { maximumFractionDigits: 1 }) });

const hlFor = (v) => (v.hl && v.hl.pdfPage === v.pdfPage ? { terms: queryTerms(v.hl.q), scroll: true } : null);

function Progress({ ds }) {
  let label = t('Ouverture du livre…');
  if (ds.stage === 'lib') label = t('Chargement du lecteur…');
  else if (ds.stage === 'cache') label = t('Lecture du cache…');
  else if (ds.stage === 'download') label = t('Téléchargement du livre (une seule fois, il reste ensuite dans ce navigateur)…');
  const pct = ds.stage === 'download' && ds.total > 0 ? Math.min(100, Math.round((ds.loaded / ds.total) * 100)) : null;
  return html`<div class="books-loading">
    <div>${label}</div>
    ${ds.stage === 'download' &&
    html`<div class="books-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct ?? undefined}>
        <div class="books-progress-bar" style=${{ width: pct === null ? '30%' : `${pct}%` }}></div>
      </div>
      <div class="muted small mono">${ds.total ? t('{loaded} / {total}', { loaded: fmtMB(ds.loaded), total: fmtMB(ds.total) }) : fmtMB(ds.loaded)}</div>`}
  </div>`;
}

/**
 * book = library entry ({ code, version, url, size }); v = viewer state (pdfPage, nav, hl); zoom = 'width'|'page'|number;
 * onScale(scale) = actual scale (for the « 120 % » label); onTextMode() = switch the drawer to the page text.
 */
export function PdfReader({ book, v, zoom, onScale, onTextMode }) {
  const ds = useDocState();
  const scrollRef = useRef(null);
  const viewRef = useRef(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const key = cacheKey(book) || book.code;

  useEffect(() => ensureDoc(book), [key]);

  const mine = ds.code === book.code && ds.status === 'ready' ? ds.doc : null;
  useEffect(() => {
    if (!mine || !scrollRef.current) return undefined;
    let view = null;
    let cancelled = false;
    loadPdfjs().then(({ lib }) => {
      if (cancelled) return;
      view = new PdfView(scrollRef.current, { lib, onPage: reportPdfPage, onScale });
      viewRef.current = view;
      view.zoom = typeof zoomRef.current === 'number' ? zoomRef.current : zoomRef.current === 'page' ? 'page' : 'width';
      const cur = getViewer();
      view.goto(cur.pdfPage || 1, hlFor(cur)); // queued until the document is laid out
      view.setDocument(mine, cur.pdfPage || 1);
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

  useEffect(() => viewRef.current?.setZoom(zoom), [zoom]);

  const loading = ds.code !== book.code || ds.status === 'loading' || ds.status === 'idle';
  return html`<div class="books-reader">
    <div class="books-scroll" ref=${scrollRef} tabindex="0" aria-label=${t('Pages du livre')}></div>
    ${loading && html`<${Progress} ds=${ds.code === book.code ? ds : { stage: 'lib' }} />`}
    ${ds.code === book.code && ds.status === 'error' &&
    html`<div class="books-loading">
      <div class="error">${t('Impossible d’ouvrir ce livre : {error}', { error: ds.error })}</div>
      <div class="row gap-s wrap">
        <${Button} small onClick=${() => ensureDoc(book)}>${t('Réessayer')}</${Button}>
        <${Button} small onClick=${onTextMode}>${t('Afficher le texte de la page')}</${Button}>
        <a class="btn btn-default btn-sm" href=${`${book.url}#page=${v.pdfPage || 1}`} target="_blank" rel="noopener">${t('Ouvrir dans un nouvel onglet')}</a>
      </div>
    </div>`}
  </div>`;
}
