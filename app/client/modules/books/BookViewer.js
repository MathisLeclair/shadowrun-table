// Global rulebook viewer: a resizable drawer on the right (mounted once by the registry, above the sheet modal).
// Desktop: the browser's own PDF viewer in an <iframe> at the right page. Mobile / no built-in viewer: « Ouvrir le
// PDF » link + the page's extracted text. Prev/next page, book switcher, full-text search. Esc closes it.
// A modal opened while the drawer is open (confirm dialog, item editor…) goes in front of it: the drawer steps behind
// (.behind) and leaves Esc to that modal until it closes or a book reference is opened again.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, IconButton, loadCss } from '../../lib/ui.js';
import { api } from '../../lib/net.js';
import { t, tn } from '../../lib/i18n.js';
import { toast } from '../../lib/ui-store.js';
import { useViewer, useBooks, findBook, closeBook, gotoPdfPage, openBookPdf, printedToPdf, pdfToPrinted, searchBooks, setViewerSearch, loadBooks } from './store.js';
import { bookName } from './BookRef.js';

loadCss('/modules/books/books.css');

const WIDTH_KEY = 'sr.books.width';
const readWidth = () => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || 0;
  } catch {
    return 0;
  }
};
const saveWidth = (w) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {}
};
const clampWidth = (w) => Math.max(320, Math.min(window.innerWidth - 40, w));
const inlinePdf = () => {
  try {
    return navigator.pdfViewerEnabled !== false && !window.matchMedia('(max-width: 760px)').matches;
  } catch {
    return true;
  }
};

/** Snippet with highlighted ranges ([[start, end]] from the server). */
export function Snippet({ text, marks }) {
  const parts = [];
  let i = 0;
  for (const [a, b] of marks || []) {
    if (a > i) parts.push(text.slice(i, a));
    parts.push(html`<mark>${text.slice(a, b)}</mark>`);
    i = b;
  }
  if (i < text.length) parts.push(text.slice(i));
  return html`<span class="books-snippet">${parts}</span>`;
}

/** Search hits list (viewer + Règles tab). onPick(hit). */
export function HitList({ hits, onPick, showBook = true }) {
  return html`<ul class="books-hits">
    ${hits.map(
      (h) => html`<li><button type="button" class="books-hit" onClick=${() => onPick(h)}>
        <span class="books-hit-ref">${showBook ? html`<strong>${h.code}</strong> ` : null}${h.page ? t('p. {page}', { page: h.page }) : t('PDF {page}', { page: h.pdfPage })}${showBook && findBook(h.code) ? html` <span class="muted">· ${bookName(findBook(h.code))}</span>` : null}</span>
        <${Snippet} text=${h.snippet} marks=${h.marks} />
      </button></li>`
    )}
  </ul>`;
}

function PageText({ code, pdfPage }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api(`/api/books/${encodeURIComponent(code)}/page/${pdfPage}?pdf=1`)
      .then((r) => alive && setState({ text: r.text }))
      .catch((err) => alive && setState({ error: err.message }));
    return () => (alive = false);
  }, [code, pdfPage]);
  if (state.loading) return html`<div class="muted small">${t('Chargement…')}</div>`;
  if (state.error) return html`<div class="error">${state.error}</div>`;
  return html`<div class="books-pagetext">${state.text || html`<span class="muted">${t('Pas de texte sur cette page (image).')}</span>`}</div>`;
}

function ViewerSearch({ code, onClose }) {
  const v = useViewer();
  const [q, setQ] = useState(v.searchQ || '');
  const [scope, setScope] = useState('book'); // 'book' | 'all'
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const query = q.trim();
    setViewerSearch(q);
    if (query.length < 2) return setRes(null);
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      searchBooks(query, scope === 'book' ? code : '')
        .then((r) => alive && setRes(r))
        .catch((err) => alive && setRes({ hits: [], total: 0, error: err.message }))
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, scope, code]);
  return html`<div class="books-search">
    <div class="row gap-s">
      <input ref=${inputRef} class="input grow" type="search" value=${q} placeholder=${t('Rechercher dans les règles… ("phrase exacte")')}
        onInput=${(e) => setQ(e.target.value)} />
      <select class="input books-scope" value=${scope} onChange=${(e) => setScope(e.target.value)} aria-label=${t('Où chercher')}>
        <option value="book">${t('Ce livre')}</option>
        <option value="all">${t('Tous les livres')}</option>
      </select>
      <${IconButton} icon="✕" title=${t('Fermer la recherche')} onClick=${onClose} />
    </div>
    ${busy && html`<div class="muted small">${t('Recherche…')}</div>`}
    ${res?.error && html`<div class="error small">${res.error}</div>`}
    ${res && !res.error && html`<div class="muted small">${res.total ? tn(res.total, '{n} résultat', '{n} résultats') : t('Aucun résultat')}${res.total > res.hits.length ? ` · ${t('{n} premiers affichés', { n: res.hits.length })}` : ''}</div>`}
    ${res?.hits?.length > 0 && html`<${HitList} hits=${res.hits} showBook=${scope === 'all'} onPick=${(h) => openBookPdf(h.code, h.pdfPage)} />`}
  </div>`;
}

export default function BookViewer() {
  const v = useViewer();
  const list = useBooks();
  const [width, setWidth] = useState(() => clampWidth(readWidth() || Math.min(760, window.innerWidth * 0.5)));
  const [dragging, setDragging] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mode, setMode] = useState(() => (inlinePdf() ? 'pdf' : 'text'));
  const [pageInput, setPageInput] = useState('');
  const [behind, setBehind] = useState(false);
  const frame = useRef({ key: null, url: null });

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
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), check()));
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
    const k = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (searchOpen) setSearchOpen(false);
      else closeBook();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [v.open, searchOpen, behind]);

  // Renew signed links when the drawer opens (they last at least an hour).
  useEffect(() => {
    if (v.open) loadBooks();
  }, [v.open, v.code]);

  const book = list ? findBook(v.code) : null;
  const printed = book && v.pdfPage ? pdfToPrinted(book, v.pdfPage) : null;
  useEffect(() => setPageInput(printed ? String(printed) : ''), [printed, v.code]);

  // The frame keeps the URL it was mounted with: renewing the links (timer) must not reload a PDF being read.
  // A new page / book / mode / reopening takes the current (fresh) link.
  const frameKey = v.open && book && v.pdfPage ? `${mode}-${book.code}-${v.pdfPage}` : null;
  if (frameKey !== frame.current.key) frame.current = { key: frameKey, url: frameKey ? `${book.url}#page=${v.pdfPage}` : null };

  if (!v.open) return null;

  const startDrag = (e) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = (ev) => {
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
  const pdfUrl = book ? `${book.url}#page=${v.pdfPage || 1}` : null;

  let body;
  if (!list) body = html`<div class="books-empty muted">${t('Chargement…')}</div>`;
  else if (!book)
    body = html`<div class="books-empty">
      <p>${v.printed ? t('Livre non disponible sur ce serveur ({code} p. {page})', { code: v.code, page: v.printed }) : t('Livre non disponible sur ce serveur ({code})', { code: v.code })}</p>
      <p class="muted small">${t('L’administrateur du serveur peut ajouter ses PDF depuis la page Administration (Livres de règles).')}</p>
    </div>`;
  else if (v.badPage)
    body = html`<div class="books-empty">
      <p>${t('Page {page} introuvable dans ce livre', { page: v.printed })}</p>
      <p class="muted small">${t('La référence ne correspond à aucune page de ce PDF : vérifie le décalage du livre (page Administration).')}</p>
    </div>`;
  else if (!v.pdfPage) body = html`<div class="books-empty muted">${t('Chargement…')}</div>`;
  else if (mode === 'pdf')
    body = html`<iframe key=${`${book.code}-${v.pdfPage}`} class=${'books-frame' + (dragging ? ' dragging' : '')} src=${frame.current.url} title=${bookName(book)}></iframe>`;
  else
    body = html`<div class="books-textmode">
      <a class="btn btn-primary" href=${pdfUrl} target="_blank" rel="noopener">${t('Ouvrir le PDF')}</a>
      <${PageText} code=${book.code} pdfPage=${v.pdfPage || 1} />
    </div>`;

  return html`<aside class=${'books-drawer' + (dragging ? ' dragging' : '') + (behind ? ' behind' : '')} style=${{ width: `${width}px` }} role="dialog" aria-label=${t('Livre de règles')}>
    <div class="books-resize" onPointerDown=${startDrag} title=${t('Glisser pour redimensionner')}></div>
    <header class="books-head">
      <select class="input books-switch" value=${v.code || ''} aria-label=${t('Livre')} onChange=${(e) => openBookPdf(e.target.value, 1)}>
        ${!book && v.code && html`<option value=${v.code}>${v.code}</option>`}
        ${(list || []).map((b) => html`<option value=${b.code} selected=${b.code === v.code}>${b.code} — ${bookName(b)}</option>`)}
      </select>
      ${book &&
      html`<div class="books-nav">
        <${IconButton} icon="◀" title=${t('Page précédente')} disabled=${(v.pdfPage || 1) <= 1} onClick=${() => gotoPdfPage((v.pdfPage || 1) - 1)} />
        <label class="books-pageinput" title=${t('Page imprimée (PDF {pdf} / {pages})', { pdf: v.pdfPage || 1, pages: book.pages })}>
          <span class="muted small">${t('p.')}</span>
          <input class="input" inputmode="numeric" value=${pageInput} onInput=${(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown=${(e) => e.key === 'Enter' && goPrinted()} onBlur=${goPrinted} />
        </label>
        <${IconButton} icon="▶" title=${t('Page suivante')} disabled=${(v.pdfPage || 1) >= book.pages} onClick=${() => gotoPdfPage((v.pdfPage || 1) + 1)} />
      </div>`}
      <div class="books-tools">
        ${book && html`<button type="button" class=${'books-mode' + (mode === 'text' ? ' active' : '')} title=${mode === 'pdf' ? t('Afficher le texte de la page') : t('Afficher le PDF')}
          onClick=${() => setMode(mode === 'pdf' ? 'text' : 'pdf')}>${mode === 'pdf' ? t('Texte') : t('PDF')}</button>`}
        ${book && html`<a class="icon-btn" href=${pdfUrl} target="_blank" rel="noopener" title=${t('Ouvrir dans un nouvel onglet')}>↗</a>`}
        <${IconButton} icon="⌕" title=${t('Rechercher dans les règles')} onClick=${() => setSearchOpen(!searchOpen)} />
        <${IconButton} icon="✕" title=${t('Fermer (Échap)')} onClick=${closeBook} />
      </div>
    </header>
    ${searchOpen && html`<${ViewerSearch} code=${v.code} onClose=${() => setSearchOpen(false)} />`}
    <div class="books-body">${body}</div>
  </aside>`;
}
