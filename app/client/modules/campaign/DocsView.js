// GM campaign documents reader: list of the table's docs/*.md, table of contents, in-doc search, refresh.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, Empty } from '../../lib/ui.js';
import { api } from '../../lib/net.js';
import { t } from '../../lib/i18n.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { useDocs, reloadDocs, docTitle, cx, fmtDate } from './common.js';

// Accent/case-insensitive folding that keeps a 1:1 index mapping with the source string.
const foldChar = (ch) => {
  const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return f.length === 1 ? f : ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch;
};
const fold = (s) => Array.from(s, foldChar).join('');

/** Wrap every match of `query` in text nodes of `root` with <mark class="camp-hit">. Returns the count. */
function highlight(root, query) {
  const needle = fold(query.trim());
  if (needle.length < 2) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue;
    // Folding per UTF-16 unit keeps indices aligned for BMP text (all of our French docs).
    const folded = text.split('').map(foldChar).join('');
    const hits = [];
    let i = folded.indexOf(needle);
    while (i >= 0) {
      hits.push(i);
      i = folded.indexOf(needle, i + needle.length);
    }
    for (let h = hits.length - 1; h >= 0; h--) {
      const start = hits[h];
      const after = node.splitText(start);
      after.splitText(needle.length);
      const mark = document.createElement('mark');
      mark.className = 'camp-hit';
      after.parentNode.replaceChild(mark, after);
      mark.appendChild(after);
    }
    count += hits.length;
  }
  return count;
}

export default function DocsView({ target, setTarget }) {
  const docs = useDocs();
  const [text, setText] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [cur, setCur] = useState(0);
  const [toc, setToc] = useState([]);
  const [listOpen, setListOpen] = useState(false);
  const contentRef = useRef(null);
  const searchRef = useRef(null);

  // Default to the first document once the list is known.
  const name = target?.name || '';
  useEffect(() => {
    if (!name && docs.list.length) setTarget({ name: docs.list[0].name, anchor: '', nonce: Date.now() });
  }, [name, docs.list.length]);

  useEffect(() => {
    if (!name) return;
    let alive = true;
    setLoading(true);
    setError('');
    api(`/api/docs/${encodeURIComponent(name)}`)
      .then((body) => alive && setText(typeof body === 'string' ? body : JSON.stringify(body, null, 2)))
      .catch((err) => {
        if (!alive) return;
        setText(null);
        setError(err.message || t('Document introuvable'));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [name, reloadKey]);

  const html_ = useMemo(() => (text == null ? '' : renderMarkdown(text)), [text]);

  // Render markdown ourselves so search marks can be applied to the DOM without fighting Preact.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.innerHTML = html_;
    const heads = [...el.querySelectorAll('h1, h2, h3, h4')];
    heads.forEach((hd, i) => hd.setAttribute('data-toc', String(i)));
    setToc(heads.map((hd, i) => ({ i, level: Number(hd.tagName[1]), text: hd.textContent })));
    const n = highlight(el, query);
    setCount(n);
    setCur(0);
  }, [html_, query]);

  // Current search hit.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !count) return;
    const marks = el.querySelectorAll('mark.camp-hit');
    marks.forEach((m) => m.classList.remove('current'));
    const m = marks[((cur % count) + count) % count];
    if (m) {
      m.classList.add('current');
      m.scrollIntoView({ block: 'center' });
    }
  }, [cur, count, html_, query]);

  // Jump to the anchor requested by a quest/session link.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !text || !target?.anchor) return;
    const want = fold(target.anchor.trim());
    const hd = [...el.querySelectorAll('h1, h2, h3, h4')].find((x) => fold(x.textContent).includes(want));
    if (hd) {
      hd.scrollIntoView({ block: 'start' });
      hd.classList.add('camp-flash-head');
      setTimeout(() => hd.classList.remove('camp-flash-head'), 1800);
    }
  }, [html_, target?.anchor, target?.nonce]);

  const jump = (i) => {
    const hd = contentRef.current?.querySelector(`[data-toc="${i}"]`);
    if (hd) hd.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setListOpen(false);
  };
  const select = (n) => {
    setTarget({ name: n, anchor: '', nonce: Date.now() });
    setListOpen(false);
    if (contentRef.current) contentRef.current.parentElement.scrollTop = 0;
  };
  const refresh = () => {
    reloadDocs().catch(() => {});
    setReloadKey((k) => k + 1);
  };
  const minLevel = toc.length ? Math.min(...toc.map((x) => x.level)) : 1;
  const meta = docs.list.find((d) => d.name === name);

  return html`<div class=${cx('camp-docs', listOpen && 'list-open')}>
    <aside class="camp-docs-side">
      <div class="camp-docs-sidehead">
        <span class="camp-docs-label">${t('Documents')}</span>
        <${IconButton} icon="⟳" title=${t('Rafraîchir la liste et le document')} onClick=${refresh} />
      </div>
      ${docs.error && html`<div class="error small">${docs.error}</div>`}
      ${!docs.loading && !docs.list.length && !docs.error && html`<div class="muted small">${t('Aucun fichier .md dans le dossier Shadowrun.')}</div>`}
      <ul class="camp-docs-list">
        ${docs.list.map(
          (d) => html`<li><button class=${cx('camp-docs-item', d.name === name && 'active')} title=${d.name} onClick=${() => select(d.name)}>
            <span>${docTitle(d.name)}</span>
            <span class="faint small">${t('{kb} Ko · {date}', { kb: Math.max(1, Math.round(d.size / 1024)), date: fmtDate(d.mtime) })}</span>
          </button></li>`
        )}
      </ul>
      ${toc.length > 0 &&
      html`<div class="camp-docs-sidehead camp-mt"><span class="camp-docs-label">${t('Sommaire')}</span></div>
        <nav class="camp-toc">
          ${toc.map(
            (x) => html`<button class=${`camp-toc-item lvl-${Math.min(4, x.level - minLevel + 1)}`} title=${x.text} onClick=${() => jump(x.i)}>${x.text}</button>`
          )}
        </nav>`}
    </aside>
    <section class="camp-docs-main">
      <div class="camp-docs-bar">
        <button class="btn btn-sm btn-ghost camp-docs-toggle" onClick=${() => setListOpen(!listOpen)}>☰ ${t('Documents & sommaire')}</button>
        <div class="camp-docs-title">
          <strong>${name ? docTitle(name) : t('Aucun document')}</strong>
          ${meta && html`<span class="faint small mono">${name}</span>`}
        </div>
        <div class="camp-docs-search">
          <input ref=${searchRef} class="input search" type="search" placeholder=${t('Chercher dans le document…')} value=${query}
            onInput=${(e) => setQuery(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setCur((c) => c + (e.shiftKey ? -1 : 1));
              }
              if (e.key === 'Escape') setQuery('');
            }} />
          <span class="mono small muted camp-hitcount">${query.trim().length >= 2 ? (count ? `${(((cur % count) + count) % count) + 1}/${count}` : '0') : ''}</span>
          <${IconButton} icon="↑" title=${t('Résultat précédent (Maj+Entrée)')} disabled=${!count} onClick=${() => setCur((c) => c - 1)} />
          <${IconButton} icon="↓" title=${t('Résultat suivant (Entrée)')} disabled=${!count} onClick=${() => setCur((c) => c + 1)} />
        </div>
        <${Button} small variant="ghost" title=${t('Recharger le fichier depuis le disque')} onClick=${refresh}>⟳ ${t('Rafraîchir')}</${Button}>
      </div>
      <div class="camp-docs-scroll">
        ${loading && text == null && html`<div class="muted">${t('Chargement…')}</div>`}
        ${error && html`<div class="error">${error}</div>`}
        ${!name && !docs.loading && html`<${Empty}>${t('Choisis un document dans la liste.')}</${Empty}>`}
        <div ref=${contentRef} class="md camp-doc-md"></div>
      </div>
    </section>
  </div>`;
}
