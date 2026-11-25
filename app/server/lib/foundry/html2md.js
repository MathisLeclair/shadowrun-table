// Small HTML → Markdown converter for Foundry journal pages and actor descriptions.
// Handles headings, paragraphs, line breaks, bold/italic, links, lists (nested), tables, quotes, images, rules.
// Foundry enrichers: @Actor[id]{Name} → **Name**, @Item[id]{Name} → Name, @JournalEntry[id]{Name} → *Name*,
// @UUID[…]{Name} → **Name**, [[/r 2d6]] → `2d6`.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', icirc: 'î', ucirc: 'û', euro: '€', yen: '¥', deg: '°', times: '×', middot: '·', copy: '©', reg: '®' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Replace Foundry enrichers in raw text (works on HTML or markdown). */
export function enrichers(s, { links } = {}) {
  return String(s || '')
    .replace(/@Actor\[([^\]]*)\](?:\{([^}]*)\})?/g, (m, id, name) => `**${name || links?.actors?.[id] || id}**`)
    .replace(/@Item\[([^\]]*)\](?:\{([^}]*)\})?/g, (m, id, name) => name || links?.items?.[id] || id)
    .replace(/@JournalEntry\[([^\]]*)\](?:\{([^}]*)\})?/g, (m, id, name) => `*${name || links?.journals?.[id] || id}*`)
    .replace(/@(?:UUID|Scene|RollTable|Macro|Compendium|PlaylistSound|Playlist)\[([^\]]*)\](?:\{([^}]*)\})?/g, (m, id, name) => `**${name || String(id).split('.').pop()}**`)
    .replace(/\[\[\/(?:r|roll|gmr|br)\s+([^\]]+)\]\]/g, (m, f) => `\`${f.trim()}\``);
}

/** Tokenize HTML into a light tree: { tag, attrs, children } / text strings. Tolerant to bad markup. */
function parse(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'source', 'wbr']);
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[3] !== undefined) {
      stack[stack.length - 1].children.push(m[3]);
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') {
      // Close the nearest matching tag.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    for (const a of (m[2] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { tag, attrs, children: [] };
    // Implicit close of <p>/<li> when a new block starts.
    if (['p', 'li', 'tr', 'td', 'th'].includes(tag)) {
      const top = stack[stack.length - 1];
      if (top.tag === tag || (tag === 'p' && top.tag === 'p')) stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !m[0].endsWith('/>')) stack.push(node);
  }
  return root;
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'hr', 'section', 'article', 'header', 'footer', 'pre', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'aside']);

function inline(node, ctx) {
  if (typeof node === 'string') return decodeEntities(node).replace(/\s+/g, ' ');
  const kids = () => node.children.map((c) => inline(c, ctx)).join('');
  switch (node.tag) {
    case 'br':
      return '  \n';
    case 'strong':
    case 'b': {
      const t = kids();
      return t.trim() ? `**${t.trim()}**${/\s$/.test(t) ? ' ' : ''}` : t;
    }
    case 'em':
    case 'i': {
      const t = kids();
      return t.trim() ? `*${t.trim()}*${/\s$/.test(t) ? ' ' : ''}` : t;
    }
    case 'u':
    case 'span':
    case 'font':
    case 'small':
    case 'big':
    case 'mark':
    case 'abbr':
    case 'cite':
    case 'label':
      return kids();
    case 's':
    case 'del':
    case 'strike':
      return `~~${kids()}~~`;
    case 'sup':
      return `^${kids()}`;
    case 'sub':
      return kids();
    case 'code':
      return '`' + kids() + '`';
    case 'a': {
      const t = kids().trim();
      const href = node.attrs.href || '';
      if (!t) return '';
      if (ctx.keepLinks && /^https?:\/\//.test(href)) return `[${t}](${href})`;
      return t;
    }
    case 'img': {
      const src = ctx.mapImage ? ctx.mapImage(node.attrs.src || '') : node.attrs.src;
      return src ? `![${node.attrs.alt || ''}](${src})` : '';
    }
    default:
      return BLOCK.has(node.tag) ? block(node, ctx) : kids();
  }
}

function inlineChildren(node, ctx) {
  return node.children.map((c) => inline(c, ctx)).join('').replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n')).trim();
}

function list(node, ctx, depth) {
  const ordered = node.tag === 'ol';
  let i = 0;
  const lines = [];
  for (const c of node.children) {
    if (typeof c === 'string') {
      if (c.trim()) lines.push(`${'  '.repeat(depth)}- ${decodeEntities(c).trim()}`);
      continue;
    }
    if (c.tag !== 'li') {
      if (c.tag === 'ul' || c.tag === 'ol') lines.push(list(c, ctx, depth + 1));
      continue;
    }
    i++;
    const inl = [];
    const nested = [];
    for (const cc of c.children) {
      if (typeof cc !== 'string' && (cc.tag === 'ul' || cc.tag === 'ol')) nested.push(list(cc, ctx, depth + 1));
      else if (typeof cc !== 'string' && cc.tag === 'p') inl.push(inlineChildren(cc, ctx));
      else inl.push(inline(cc, ctx));
    }
    const text = inl.join(' ').replace(/\s+/g, ' ').trim();
    lines.push(`${'  '.repeat(depth)}${ordered ? `${i}.` : '-'} ${text}`);
    lines.push(...nested);
  }
  return lines.join('\n');
}

function table(node, ctx) {
  const rows = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (c.tag === 'tr') rows.push(c.children.filter((x) => typeof x !== 'string' && (x.tag === 'td' || x.tag === 'th')).map((td) => inlineChildren(td, ctx).replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
      else walk(c);
    }
  };
  walk(node);
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(w - r.length).fill('')];
  const out = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(w).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
  return out.join('\n');
}

function block(node, ctx) {
  switch (node.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const t = inlineChildren(node, ctx).replace(/\n+/g, ' ');
      return t ? `\n\n${'#'.repeat(Math.min(6, Number(node.tag[1]) + (ctx.shiftHeadings || 0)))} ${t}\n\n` : '';
    }
    case 'p':
    case 'figcaption':
    case 'dt':
    case 'dd': {
      const t = blocks(node, ctx);
      return t.trim() ? `\n\n${t.trim()}\n\n` : '';
    }
    case 'ul':
    case 'ol':
      return `\n\n${list(node, ctx, 0)}\n\n`;
    case 'li':
      return `\n- ${inlineChildren(node, ctx)}\n`;
    case 'table':
      return `\n\n${table(node, ctx)}\n\n`;
    case 'blockquote': {
      const t = blocks(node, ctx).trim();
      return t ? `\n\n${t.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : '';
    }
    case 'hr':
      return '\n\n---\n\n';
    case 'pre':
      return `\n\n\`\`\`\n${decodeEntities(textOf(node))}\n\`\`\`\n\n`;
    default:
      return blocks(node, ctx);
  }
}

function textOf(n) {
  return typeof n === 'string' ? n : n.children.map(textOf).join('');
}

/** Children of a block: consecutive inline nodes are joined, block children rendered separately. */
function blocks(node, ctx) {
  let out = '';
  let buf = '';
  const flush = () => {
    if (buf.trim()) out += `\n\n${buf.trim()}\n\n`;
    buf = '';
  };
  for (const c of node.children) {
    if (typeof c !== 'string' && BLOCK.has(c.tag)) {
      flush();
      out += block(c, ctx);
    } else buf += inline(c, ctx);
  }
  if (out) {
    flush();
    return out;
  }
  return buf;
}

/**
 * Convert HTML to markdown.
 * opts: { keepLinks: true, links: { actors: {id: name} }, mapImage(src) → url|'' , shiftHeadings: 0 }
 */
export function htmlToMarkdown(html, opts = {}) {
  const ctx = { keepLinks: opts.keepLinks !== false, mapImage: opts.mapImage, shiftHeadings: opts.shiftHeadings || 0 };
  const src = enrichers(String(html || ''), opts);
  if (!/<[a-z!/]/i.test(src)) return decodeEntities(src).trim();
  const md = blocks(parse(src), ctx);
  return md
    .replace(/[ \t]+$/gm, (m) => (m === '  ' ? m : ''))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}
