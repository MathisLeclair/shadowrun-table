// GM campaign documents reader: list of the table's docs/*.md, table of contents, in-doc search, refresh.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Empty } from '../../lib/ui.tsx';
import { api } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { renderMarkdown } from '../../lib/markdown.ts';
import { useDocs, reloadDocs, docTitle, cx, fmtDate, type SetPersistent } from './common.tsx';
import type { DocTarget } from './types.ts';

// Accent/case-insensitive folding that keeps a 1:1 index mapping with the source string.
const foldChar = (ch: string): string => {
  const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return f.length === 1 ? f : ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch;
};
const fold = (s: string): string => Array.from(s, foldChar).join('');

/** Wrap every match of `query` in text nodes of `root` with <mark class="camp-hit">. Returns the count. */
function highlight(root: HTMLElement, query: string): number {
  const needle = fold(query.trim());
  if (needle.length < 2) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue || '';
    // Folding per UTF-16 unit keeps indices aligned for BMP text (all of our French docs).
    const folded = text.split('').map(foldChar).join('');
    const hits: number[] = [];
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
      after.parentNode!.replaceChild(mark, after);
      mark.appendChild(after);
    }
    count += hits.length;
  }
  return count;
}

interface TocEntry {
  i: number;
  level: number;
  text: string;
}

interface DocsViewProps {
  target: DocTarget | null;
  setTarget: SetPersistent<DocTarget | null>;
}

export default function DocsView({ target, setTarget }: DocsViewProps) {
  const docs = useDocs();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [cur, setCur] = useState(0);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
    api<unknown>(`/api/docs/${encodeURIComponent(name)}`)
      .then((body) => {
        if (alive) setText(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
      })
      .catch((err) => {
        if (!alive) return;
        setText(null);
        setError(err.message || t('Document not found'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [name, reloadKey]);

  const html_ = useMemo(() => (text == null ? '' : renderMarkdown(text)), [text]);

  // Render markdown ourselves so search marks can be applied to the DOM without fighting React.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.innerHTML = html_;
    const heads = [...el.querySelectorAll('h1, h2, h3, h4')];
    heads.forEach((hd, i) => hd.setAttribute('data-toc', String(i)));
    setToc(heads.map((hd, i) => ({ i, level: Number(hd.tagName[1]), text: hd.textContent || '' })));
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
    const hd = [...el.querySelectorAll('h1, h2, h3, h4')].find((x) => fold(x.textContent || '').includes(want));
    if (hd) {
      hd.scrollIntoView({ block: 'start' });
      hd.classList.add('camp-flash-head');
      setTimeout(() => hd.classList.remove('camp-flash-head'), 1800);
    }
  }, [html_, target?.anchor, target?.nonce]);

  const jump = (i: number) => {
    const hd = contentRef.current?.querySelector(`[data-toc="${i}"]`);
    if (hd) hd.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setListOpen(false);
  };
  const select = (n: string) => {
    setTarget({ name: n, anchor: '', nonce: Date.now() });
    setListOpen(false);
    if (contentRef.current?.parentElement) contentRef.current.parentElement.scrollTop = 0;
  };
  const refresh = () => {
    reloadDocs().catch(() => {});
    setReloadKey((k) => k + 1);
  };
  const minLevel = toc.length ? Math.min(...toc.map((x) => x.level)) : 1;
  const meta = docs.list.find((d) => d.name === name);

  return (
    <div className={cx('camp-docs', listOpen && 'list-open')}>
      <aside className="camp-docs-side">
        <div className="camp-docs-sidehead">
          <span className="camp-docs-label">{t('Documents')}</span>
          <IconButton icon="⟳" title={t('Refresh the list and the document')} onClick={refresh} />
        </div>
        {docs.error && <div className="error small">{docs.error}</div>}
        {!docs.loading && !docs.list.length && !docs.error && <div className="muted small">{t('No .md file in the documents folder.')}</div>}
        <ul className="camp-docs-list">
          {docs.list.map((d) => (
            <li key={d.name}>
              <button className={cx('camp-docs-item', d.name === name && 'active')} title={d.name} onClick={() => select(d.name)}>
                <span>{docTitle(d.name)}</span>
                <span className="faint small">{t('{kb} KB · {date}', { kb: Math.max(1, Math.round(d.size / 1024)), date: fmtDate(d.mtime) })}</span>
              </button>
            </li>
          ))}
        </ul>
        {toc.length > 0 && (
          <>
            <div className="camp-docs-sidehead camp-mt">
              <span className="camp-docs-label">{t('Contents')}</span>
            </div>
            <nav className="camp-toc">
              {toc.map((x) => (
                <button key={x.i} className={`camp-toc-item lvl-${Math.min(4, x.level - minLevel + 1)}`} title={x.text} onClick={() => jump(x.i)}>
                  {x.text}
                </button>
              ))}
            </nav>
          </>
        )}
      </aside>
      <section className="camp-docs-main">
        <div className="camp-docs-bar">
          <button className="btn btn-sm btn-ghost camp-docs-toggle" onClick={() => setListOpen(!listOpen)}>
            ☰ {t('Documents & contents')}
          </button>
          <div className="camp-docs-title">
            <strong>{name ? docTitle(name) : t('No document')}</strong>
            {meta && <span className="faint small mono">{name}</span>}
          </div>
          <div className="camp-docs-search">
            <input
              ref={searchRef}
              className="input search"
              type="search"
              placeholder={t('Search in the document…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setCur((c) => c + (e.shiftKey ? -1 : 1));
                }
                if (e.key === 'Escape') setQuery('');
              }}
            />
            <span className="mono small muted camp-hitcount">{query.trim().length >= 2 ? (count ? `${(((cur % count) + count) % count) + 1}/${count}` : '0') : ''}</span>
            <IconButton icon="↑" title={t('Previous match (Shift+Enter)')} disabled={!count} onClick={() => setCur((c) => c - 1)} />
            <IconButton icon="↓" title={t('Next match (Enter)')} disabled={!count} onClick={() => setCur((c) => c + 1)} />
          </div>
          <Button small variant="ghost" title={t('Reload the file from disk')} onClick={refresh}>
            ⟳ {t('Refresh')}
          </Button>
        </div>
        <div className="camp-docs-scroll">
          {loading && text == null && <div className="muted">{t('Loading…')}</div>}
          {error && <div className="error">{error}</div>}
          {!name && !docs.loading && <Empty>{t('Pick a document from the list.')}</Empty>}
          <div ref={contentRef} className="md camp-doc-md"></div>
        </div>
      </section>
    </div>
  );
}
