// Minimal, safe markdown -> HTML (escapes all raw HTML first).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Links/images and code spans are pulled out into placeholders FIRST, so no later regex can ever run over
// generated HTML (an earlier version let a link start inside a just-generated img src → attribute breakout).
const SAFE_URL = /^(https?:|\/|#)/;
const BAD_URL = /[\u0000\[\]<>"'`\\]|&lt;|&gt;|&quot;|&#|^\/\//;
const HOLE = /\u0000(\d+)\u0000/g;
function inline(s) {
  const tags = [];
  const hold = (html) => `\u0000${tags.push(html) - 1}\u0000`;
  s = String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/`([^`]+)`/g, (m, code) => hold(`<code>${code}</code>`))
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (m, bang, text, url) => {
      if (!SAFE_URL.test(url) || BAD_URL.test(url)) return bang ? text.replace(HOLE, '') : text;
      if (bang) return hold(`<img alt="${text.replace(HOLE, '')}" src="${url}">`);
      if (!text) return m;
      return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
    })
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  // Restore placeholders (link text may itself contain a held code span, hence the loop).
  for (let k = 0; k < 3 && s.includes('\u0000'); k++) s = s.replace(HOLE, (m, i) => tags[Number(i)] ?? '');
  return s;
}

export function renderMarkdown(src) {
  const lines = esc(String(src).replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${renderMarkdownEscaped(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        let text = m[3];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) text += ' ' + lines[i++].trim();
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

// Blockquote content is already escaped.
function renderMarkdownEscaped(s) {
  return renderMarkdown(s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}
