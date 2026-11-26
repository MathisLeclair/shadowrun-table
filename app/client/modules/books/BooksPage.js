// « Règles » tab (GM + players): the rulebooks available on this server, full-text search across them, and quick
// links to the most used rules. Every result opens the global viewer drawer (BookViewer) at the right page.
import { useEffect, useState } from 'preact/hooks';
import { html, Panel, Empty, Badge, Button, loadCss, confirmAction } from '../../lib/ui.js';
import { t, tn } from '../../lib/i18n.js';
import { useBooks, booksError, findBook, openBookPdf, openBook, searchBooks } from './store.js';
import { bookName } from './BookRef.js';
import { HitList } from './BookViewer.js';
import { QUICK_LINKS } from './quicklinks.js';
import { useBookCache, clearBookCache } from './bookcache.js';
import { cachedByCode } from './cachepolicy.js';
import { fmtMB } from './PdfReader.js';
import { toast } from '../../lib/ui-store.js';

loadCss('/modules/books/books.css');

function Search({ books }) {
  const [q, setQ] = useState('');
  const [code, setCode] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return setRes(null);
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      searchBooks(query, code)
        .then((r) => alive && setRes(r))
        .catch((err) => alive && setRes({ hits: [], total: 0, error: err.message }))
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, code]);
  return html`<div class="col">
    <div class="row gap-s wrap">
      <input class="input search grow" type="search" value=${q} placeholder=${t('Rechercher dans les règles… ("phrase exacte")')} onInput=${(e) => setQ(e.target.value)} />
      <select class="input books-scope" value=${code} onChange=${(e) => setCode(e.target.value)} aria-label=${t('Où chercher')}>
        <option value="">${t('Tous les livres')}</option>
        ${books.filter((b) => b.indexed).map((b) => html`<option value=${b.code}>${b.code} — ${bookName(b)}</option>`)}
      </select>
    </div>
    <span class="field-hint">${t('Sans accents ni majuscules. Tous les mots doivent être sur la page ; mets une expression entre guillemets pour la chercher telle quelle. Le texte des livres est en anglais.')}</span>
    ${busy && html`<div class="muted small">${t('Recherche…')}</div>`}
    ${res?.error && html`<div class="error small">${res.error}</div>`}
    ${res && !res.error && html`<div class="muted small">${res.total ? tn(res.total, '{n} résultat', '{n} résultats') : t('Aucun résultat')}${res.total > res.hits.length ? ` · ${t('{n} premiers affichés', { n: res.hits.length })}` : ''}</div>`}
    ${res?.hits?.length > 0 && html`<${HitList} hits=${res.hits} onPick=${(h) => openBookPdf(h.code, h.pdfPage, { q: q.trim() })} />`}
  </div>`;
}

function QuickLinks() {
  return html`<div class="books-quick">
    ${QUICK_LINKS.map(
      (g) => html`<div class="books-quick-group">
        <div class="section-title">${t(g.group)}</div>
        ${g.items.map((it) => {
          const b = findBook(it.code);
          return html`<button type="button" class=${'books-quick-link' + (b ? '' : ' missing')} onClick=${() => openBook(it.code, it.page)}
            title=${b ? t('{book}, p. {page}', { book: bookName(b), page: it.page }) : t('Livre non disponible sur ce serveur ({code} p. {page})', { code: it.code, page: it.page })}>
            <span>${t(it.label)}</span><span class="mono small muted">${it.code} ${it.page}</span>
          </button>`;
        })}
      </div>`
    )}
  </div>`;
}

/** « 3 livres gardés par ce navigateur (85 Mo) — Vider » under the library. */
function CacheLine({ cache, books }) {
  if (!cache.ready || cache.backend === 'none' || !cache.entries.length) return null;
  const clear = async () => {
    if (!(await confirmAction(t('Supprimer les livres gardés par ce navigateur ? Ils seront retéléchargés à la prochaine ouverture.')))) return;
    await clearBookCache();
    toast(t('Cache des livres vidé'));
  };
  const n = cachedByCode(cache.entries, books).size;
  return html`<div class="books-cacheline muted small">
    <span>${tn(n, '{n} livre gardé par ce navigateur ({size})', '{n} livres gardés par ce navigateur ({size})', { size: fmtMB(cache.bytes) })}</span>
    <${Button} small variant="ghost" onClick=${clear}>${t('Vider le cache des livres')}</${Button}>
  </div>`;
}

export default function BooksPage({ game }) {
  const books = useBooks();
  const cache = useBookCache();
  const cached = cachedByCode(cache.entries, books || []);
  const isGM = game?.me?.role === 'gm';
  const err = booksError();
  return html`<div class="page books-page">
    <div class="page-title"><h2>${t('Règles')}</h2></div>
    ${books === null
      ? html`<${Empty}>${t('Chargement…')}</${Empty}>`
      : !books.length
        ? html`<${Panel}>
            <${Empty}>${err ? err.message : t('Aucun livre de règles sur ce serveur.')}</${Empty}>
            ${isGM && html`<p class="muted small books-center">${t('L’administrateur du serveur peut ajouter ses PDF depuis la page Administration (Livres de règles).')}</p>`}
          </${Panel}>`
        : html`
          <${Panel} title=${t('Recherche dans les livres')}><${Search} books=${books} /></${Panel}>
          <div class="books-grid">
            <${Panel} title=${t('Règles courantes')}><${QuickLinks} /></${Panel}>
            <${Panel} title=${t('Bibliothèque')}>
              <div class="books-list">
                ${books.map(
                  (b) => html`<div class="books-card">
                    <${Badge} color=${b.extra ? 'dim' : 'cyan'}>${b.code}</${Badge}>
                    <div class="grow">
                      <div class="books-card-name">${bookName(b)}${cached.has(b.code) && html` <${Badge} color="green" title=${t('Déjà téléchargé : s’ouvre sans attendre ({size})', { size: fmtMB(cached.get(b.code).size) })}>${t('en cache')}</${Badge}>`}</div>
                      <div class="muted small">${tn(b.pages, '{n} page', '{n} pages')}${b.indexed ? '' : ` · ${t('pas encore indexé')}`}</div>
                    </div>
                    <${Button} small onClick=${() => openBookPdf(b.code, 1)}>${t('Ouvrir')}</${Button}>
                  </div>`
                )}
              </div>
              <${CacheLine} cache=${cache} books=${books} />
            </${Panel}>
          </div>`}
  </div>`;
}
