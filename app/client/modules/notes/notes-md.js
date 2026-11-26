// Pure helpers for the Notes editor (no DOM, no framework: unit-tested in Node by tools/test-notes.js).
// - renderNote(): shared renderMarkdown() + [[Titre]] links, @mentions badges and task-list checkboxes.
// - toggleCheckbox(): flip the n-th « - [ ] » of a body.
// - applyFormat(): toolbar edits on a textarea value/selection.
import { renderMarkdown } from '../../lib/markdown.js';

const WIKI = /\[\[([^\[\]\n]{1,120})\]\]/g;
const TASK_SRC = /^((?:\s*>\s?)*\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s|$)/;
// Source-line marker carried through renderMarkdown() (private-use characters: it keeps them, users never type them).
const MARK_OPEN = '';
const MARK_CLOSE = '';
const MARK_RE = /(\d+)/g;
const MARK_CHARS = /[]/g;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitLines = (body) => String(body || '').replace(/\r\n?/g, '\n').split('\n');

/**
 * Which lines renderMarkdown() shows as fenced code (fence lines included). Mirrors its block rules exactly:
 * a fence is « ``` » at column 0 and runs to the next one (or the end); « > » lines form a blockquote whose
 * content (prefix stripped) is rendered again, so fences inside quotes count, and an unclosed one stops at the quote's end.
 */
export function codeLines(lines) {
  const mask = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (/^```/.test(lines[i])) {
      mask[i++] = true;
      while (i < lines.length && !/^```/.test(lines[i])) mask[i++] = true;
      if (i < lines.length) mask[i++] = true;
      continue;
    }
    if (/^>\s?/.test(lines[i])) {
      const from = i;
      const inner = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) inner.push(lines[i++].replace(/^>\s?/, ''));
      codeLines(inner).forEach((c, k) => (mask[from + k] = c));
      continue;
    }
    i++;
  }
  return mask;
}

/** Source line indexes of the task checkboxes (outside code), in order. */
function taskLines(lines) {
  const code = codeLines(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) if (!code[i] && TASK_SRC.test(lines[i])) out.push(i);
  return out;
}

/** URL-safe for renderMarkdown links (it refuses quotes, brackets, parentheses…). */
export function encodeRef(s) {
  return encodeURIComponent(s).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
export function decodeRef(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Titles referenced with [[…]] (outside fenced code). */
export function wikiTitles(body) {
  const out = [];
  const lines = splitLines(body);
  const code = codeLines(lines);
  lines.forEach((line, i) => {
    if (!code[i]) for (const m of line.matchAll(WIKI)) out.push(m[1].trim());
  });
  return out;
}

/** Number of task-list checkboxes in a body (outside code, same rules as the renderer). */
export function countCheckboxes(body) {
  return taskLines(splitLines(body)).length;
}

/**
 * Flip the checkbox written on source line `line` (0-based, as given by renderNote's data-line).
 * Returns the new body, unchanged when that line is not a task outside code (never touches another line).
 */
export function toggleCheckboxAt(body, line) {
  const lines = splitLines(body);
  if (!Number.isInteger(line) || line < 0 || line >= lines.length || codeLines(lines)[line]) return String(body || '');
  const m = TASK_SRC.exec(lines[line]);
  if (!m) return String(body || '');
  lines[line] = m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + lines[line].slice(m[0].length);
  return lines.join('\n');
}

/** Flip the n-th checkbox (0-based, outside code). Returns the new body (unchanged when out of range). */
export function toggleCheckbox(body, n) {
  const at = taskLines(splitLines(body))[n];
  return at === undefined ? String(body || '') : toggleCheckboxAt(body, at);
}

/**
 * Markdown → safe HTML for a note.
 *   resolve(title) → page id | null: [[Titre]] becomes <a href="#note:id"> (or "#new:<title>" when unknown, to create it)
 *   mentions: names (« Jane », « Bricks ») rendered as badges when written @Jane
 *   editable: checkboxes clickable (else disabled)
 * Each checkbox carries data-line = its source line (toggle with toggleCheckboxAt); one whose line cannot be
 * traced is rendered disabled, so a click can never flip another line.
 * Returns { html, checkboxes } (number of checkboxes rendered).
 */
export function renderNote(body, { resolve = () => null, mentions = [], editable = false } = {}) {
  const lines = splitLines(String(body || '').replace(MARK_CHARS, ''));
  const code = codeLines(lines);
  const src = lines
    .map((line, idx) => {
      if (code[idx]) return line;
      // Tag task lines with their source index; the marker lands right after « [ ] » in the rendered <li>.
      const task = TASK_SRC.exec(line);
      if (task) line = task[0] + MARK_OPEN + idx + MARK_CLOSE + line.slice(task[0].length);
      // Not inside inline code spans.
      return line
        .split(/(`[^`]*`)/)
        .map((seg, k) =>
          k % 2
            ? seg
            : seg.replace(WIKI, (m, raw) => {
                const title = raw.trim();
                if (!title) return m;
                const id = resolve(title);
                return id && /^[\w-]+$/.test(id) ? `[${title}](#note:${id})` : `[${title}](#new:${encodeRef(title)})`;
              })
        )
        .join('');
    })
    .join('\n');
  const html = renderMarkdown(src);

  const names = [...new Set(mentions.map((n) => String(n || '').trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  const mentionRe = names.length ? new RegExp(`(^|[^\\p{L}\\p{N}_@])@(${names.map((n) => reEsc(esc(n))).join('|')})(?![\\p{L}\\p{N}_])`, 'gu') : null;

  // Walk text segments only (never inside a tag), skipping code/pre/links.
  const parts = html.split(/(<[^>]*>)/);
  let skip = 0;
  let prevTag = '';
  let cb = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p[0] === '<') {
      const m = /^<(\/?)(\w+)/.exec(p);
      if (m && ['code', 'pre', 'a'].includes(m[2].toLowerCase())) skip += m[1] ? -1 : 1;
      if (skip < 0) skip = 0;
      prevTag = p.replace(MARK_RE, '');
      parts[i] = prevTag;
      continue;
    }
    let head = '';
    let text = p;
    if (prevTag === '<li>' && !skip) {
      const t = /^\[( |x|X)\](?:(\d+))?(\s+|$)/.exec(text);
      if (t) {
        const line = t[2] !== undefined ? ` data-line="${t[2]}"` : '';
        head = `<input type="checkbox" class="notes-cb" data-cb="${cb++}"${line}${t[1] !== ' ' ? ' checked' : ''}${editable && line ? '' : ' disabled'}>${t[3] ? ' ' : ''}`;
        text = text.slice(t[0].length);
      }
    }
    // Markers that did not open a checkbox (task line rendered as code or plain text) vanish.
    text = text.replace(MARK_RE, '');
    if (mentionRe && !skip) text = text.replace(mentionRe, '$1<span class="notes-mention">@$2</span>');
    text = head + text;
    parts[i] = text;
    prevTag = '';
  }
  return { html: parts.join(''), checkboxes: cb };
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
const WRAP = { bold: '**', italic: '*', link: ['[[', ']]'] };
const PREFIX = { list: '- ', check: '- [ ] ', heading: '## ', quote: '> ' };

/**
 * Apply a toolbar format to (value, selection). kind: bold | italic | link | list | check | heading | quote.
 * Returns { value, start, end } (new selection).
 */
export function applyFormat(value, start, end, kind) {
  value = String(value ?? '');
  start = Math.max(0, Math.min(start ?? 0, value.length));
  end = Math.max(start, Math.min(end ?? start, value.length));
  if (WRAP[kind]) {
    const [open, close] = Array.isArray(WRAP[kind]) ? WRAP[kind] : [WRAP[kind], WRAP[kind]];
    const sel = value.slice(start, end);
    const before = value.slice(Math.max(0, start - open.length), start);
    const after = value.slice(end, end + close.length);
    // Already wrapped (markers just outside the selection): unwrap. Bold vs italic: « **x** » is not italic.
    const outside = before === open && after === close && !(kind === 'italic' && value.slice(start - 2, start) === '**' && value.slice(end, end + 2) === '**');
    if (outside) {
      return { value: value.slice(0, start - open.length) + sel + value.slice(end + close.length), start: start - open.length, end: end - open.length };
    }
    if (sel.startsWith(open) && sel.endsWith(close) && sel.length >= open.length + close.length) {
      const inner = sel.slice(open.length, sel.length - close.length);
      return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
    }
    return { value: value.slice(0, start) + open + sel + close + value.slice(end), start: start + open.length, end: end + open.length };
  }
  const prefix = PREFIX[kind];
  if (!prefix) return { value, start, end };
  const ls = value.lastIndexOf('\n', start - 1) + 1;
  let le = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  if (le < 0) le = value.length;
  const block = value.slice(ls, le);
  const lines = block.split('\n');
  const strip = kind === 'check' ? /^(\s*)[-*+]\s+\[( |x|X)\]\s?/ : kind === 'list' ? /^(\s*)[-*+]\s+(?!\[( |x|X)\])/ : kind === 'heading' ? /^(\s*)#{1,6}\s+/ : /^(\s*)>\s?/;
  const all = lines.filter((l) => l.trim()).length > 0 && lines.every((l) => !l.trim() || strip.test(l));
  const next = lines.map((l) => {
    if (all) return l.replace(strip, '$1');
    if (!l.trim() && lines.length > 1) return l;
    // list → checkbox: replace the bullet instead of stacking « - - [ ] ».
    const bare = kind === 'check' ? l.replace(/^(\s*)[-*+]\s+/, '$1') : kind === 'heading' ? l.replace(/^(\s*)#{1,6}\s+/, '$1') : l;
    const ind = /^\s*/.exec(bare)[0];
    return ind + prefix + bare.slice(ind.length);
  });
  const out = next.join('\n');
  const delta = out.length - block.length;
  const firstDelta = next[0].length - lines[0].length;
  return { value: value.slice(0, ls) + out + value.slice(le), start: Math.max(ls, start + firstDelta), end: Math.max(ls, end + delta) };
}
