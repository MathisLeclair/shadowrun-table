// Minimal, loss-less XML DOM for Chummer5a files (.chum5) and Chummer data files.
// - parse() keeps element order, attributes, comments, CDATA and the exact text of text-only elements;
// - serialize() writes the same layout as Chummer's .NET XmlWriter (2-space indent, CRLF, `<x />` for empty
//   elements), so an untouched file round-trips byte-for-byte (minus the BOM, see serialize()).
// No dependencies: Chummer XML is plain (no namespaces, no DTD), a hand-written scanner is enough and fast.

import { i18nError } from './messages.js';

export class XmlError extends Error {}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Element node. children: Element | { type: 'text'|'cdata'|'comment', value } */
export class Element {
  constructor(name, attrs = [], children = []) {
    this.type = 'el';
    this.name = name;
    this.attrs = attrs; // [[key, value]]
    this.children = children;
  }
  /** Element children only. */
  get elements() {
    return this.children.filter((c) => c.type === 'el');
  }
  /** First child element with this name (or null). */
  child(name) {
    for (const c of this.children) if (c.type === 'el' && c.name === name) return c;
    return null;
  }
  /** All child elements with this name. */
  all(name) {
    return this.children.filter((c) => c.type === 'el' && c.name === name);
  }
  /** Path lookup: 'newskills/skills' → element or null. */
  get(path) {
    let cur = this;
    for (const part of path.split('/')) {
      cur = cur?.child(part);
      if (!cur) return null;
    }
    return cur;
  }
  /** Decoded text content (direct text/cdata children only). */
  get text() {
    let s = '';
    for (const c of this.children) if (c.type === 'text' || c.type === 'cdata') s += c.value;
    return s;
  }
  set text(v) {
    const s = v === undefined || v === null ? '' : String(v);
    this.children = s === '' ? [] : [{ type: 'text', value: s }];
  }
  /** Text of a child element ('' if missing). */
  val(name) {
    const c = this.child(name);
    return c ? c.text : '';
  }
  /** Has a child element with that name. */
  has(name) {
    return !!this.child(name);
  }
  /**
   * Set the text of child `name`; creates it (appended, or after `after` if given) when missing.
   * Returns the child.
   */
  set(name, value, after) {
    let c = this.child(name);
    if (!c) {
      c = new Element(name);
      if (after) this.insertAfter(c, typeof after === 'string' ? this.child(after) : after);
      else this.children.push(c);
    }
    c.text = value;
    return c;
  }
  append(...nodes) {
    for (const n of nodes) if (n) this.children.push(n);
    return this;
  }
  insertAfter(node, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i + 1, 0, node);
    return node;
  }
  remove(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    return i >= 0;
  }
  attr(name) {
    const a = this.attrs.find(([k]) => k === name);
    return a ? a[1] : undefined;
  }
  clone() {
    return new Element(
      this.name,
      this.attrs.map(([k, v]) => [k, v]),
      this.children.map((c) => (c.type === 'el' ? c.clone() : { ...c }))
    );
  }
  /** Depth-first walk over descendant elements (and self). Return false from fn to skip a subtree. */
  walk(fn, parent = null) {
    if (fn(this, parent) === false) return;
    for (const c of this.children) if (c.type === 'el') c.walk(fn, this);
  }
}

/** Build an element: el('name', 'text') / el('name', [children]) / el('name', {attr: v}, [children]). */
export function el(name, a, b) {
  let attrs = [];
  let content = a;
  if (a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Element)) {
    attrs = Object.entries(a).map(([k, v]) => [k, String(v)]);
    content = b;
  }
  const e = new Element(name, attrs);
  if (Array.isArray(content)) e.children = content.filter(Boolean);
  else if (content instanceof Element) e.children = [content];
  else if (content !== undefined && content !== null && content !== '') e.children = [{ type: 'text', value: String(content) }];
  return e;
}

const NAME_RE = /[A-Za-z_:][\w.:\-]*/y;

/**
 * Parse an XML string. Returns { bom, declaration, prolog: [nodes], root: Element, newline }.
 * Throws XmlError with a French message on malformed input.
 */
export function parseXml(input) {
  let s = String(input ?? '');
  const bom = s.charCodeAt(0) === 0xfeff;
  if (bom) s = s.slice(1);
  const newline = s.includes('\r\n') ? '\r\n' : '\n';
  let i = 0;
  const n = s.length;
  // fail('French key {x}', { x }) — the message stays French; the key travels to the client (see messages.js).
  const fail = (msg, params) => {
    const line = s.slice(0, i).split('\n').length;
    throw i18nError({ t: 'XML invalide (ligne {line}) : {error}', params: { line, error: params ? { t: msg, params } : { t: msg } } }, XmlError);
  };
  let declaration = null;
  const prolog = [];
  let root = null;
  const stack = [];

  const readName = () => {
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(s);
    if (!m) fail('nom de balise attendu');
    i += m[0].length;
    return m[0];
  };
  const skipWs = () => {
    while (i < n && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++;
  };
  const pushNode = (node) => {
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (node.type === 'el') {
      if (root) fail('plusieurs éléments racine');
      root = node;
    } else if (node.type !== 'text' || node.value.trim()) {
      if (node.type === 'text') fail('texte hors de l’élément racine');
      prolog.push(node);
    }
  };

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      const rest = s.slice(i);
      if (stack.length) fail('fin de fichier inattendue');
      if (rest.trim()) fail('texte après l’élément racine');
      break;
    }
    if (lt > i) {
      const raw = s.slice(i, lt);
      if (stack.length) pushNode({ type: 'text', value: decodeEntities(raw) });
      else if (raw.trim()) fail('texte hors de l’élément racine');
      i = lt;
    }
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i);
      if (end < 0) fail('instruction de traitement non fermée');
      const body = s.slice(i + 2, end);
      if (/^xml\s/i.test(body) && !root && !stack.length && !declaration) declaration = body;
      else pushNode({ type: 'pi', value: body });
      i = end + 2;
    } else if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) fail('commentaire non fermé');
      pushNode({ type: 'comment', value: s.slice(i + 4, end) });
      i = end + 3;
    } else if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end < 0) fail('section CDATA non fermée');
      if (!stack.length) fail('CDATA hors de l’élément racine');
      pushNode({ type: 'cdata', value: s.slice(i + 9, end) });
      i = end + 3;
    } else if (s.startsWith('<!', i)) {
      // DOCTYPE (never used by Chummer): keep it verbatim in the prolog.
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        else if (s[j] === '>' && depth <= 0) break;
      }
      if (j >= n) fail('déclaration non fermée');
      prolog.push({ type: 'doctype', value: s.slice(i, j + 1) });
      i = j + 1;
    } else if (s[i + 1] === '/') {
      i += 2;
      const name = readName();
      skipWs();
      if (s[i] !== '>') fail('« > » attendu après </{tag}', { tag: name });
      i++;
      const open = stack.pop();
      if (!open) fail('balise fermante </{tag}> sans ouverture', { tag: name });
      if (open.name !== name) fail('</{tag}> ferme <{open}>', { tag: name, open: open.name });
      if (!stack.length) pushNode(open);
    } else {
      i++;
      const name = readName();
      const attrs = [];
      for (;;) {
        skipWs();
        if (s[i] === '/' && s[i + 1] === '>') {
          i += 2;
          const e = new Element(name, attrs);
          e.selfClosed = true;
          pushNode(e);
          break;
        }
        if (s[i] === '>') {
          i++;
          const e = new Element(name, attrs);
          if (stack.length) stack[stack.length - 1].children.push(e);
          stack.push(e);
          break;
        }
        if (i >= n) fail('balise <{tag}> non fermée', { tag: name });
        const key = readName();
        skipWs();
        if (s[i] !== '=') fail('« = » attendu pour l’attribut {attr}', { attr: key });
        i++;
        skipWs();
        const q = s[i];
        if (q !== '"' && q !== "'") fail('valeur d’attribut {attr} sans guillemets', { attr: key });
        const end = s.indexOf(q, i + 1);
        if (end < 0) fail('attribut {attr} non fermé', { attr: key });
        attrs.push([key, decodeEntities(s.slice(i + 1, end))]);
        i = end + 1;
      }
    }
  }
  if (stack.length) fail('<{tag}> n’est jamais fermée', { tag: stack[stack.length - 1].name });
  if (!root) fail('aucun élément racine');
  return { bom, declaration, prolog, root, newline };
}

function attrString(e) {
  return e.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
}

function writeNode(node, depth, out, nl, indent) {
  const pad = indent.repeat(depth);
  if (node.type === 'comment') return out.push(`${pad}<!--${node.value}-->`);
  if (node.type === 'pi') return out.push(`${pad}<?${node.value}?>`);
  if (node.type === 'cdata') return out.push(`${pad}<![CDATA[${node.value}]]>`);
  if (node.type === 'text') return out.push(pad + escapeText(node.value));
  const open = `<${node.name}${attrString(node)}`;
  const kids = node.children;
  if (!kids.length) return out.push(`${pad}${open} />`);
  const hasEl = kids.some((c) => c.type === 'el' || c.type === 'comment' || c.type === 'pi');
  if (!hasEl) {
    // Text-only: written inline, exactly as stored.
    const inner = kids.map((c) => (c.type === 'cdata' ? `<![CDATA[${c.value}]]>` : escapeText(c.value))).join('');
    return out.push(`${pad}${open}>${inner}</${node.name}>`);
  }
  const meaningfulText = kids.some((c) => (c.type === 'text' && c.value.trim()) || c.type === 'cdata');
  if (meaningfulText) {
    // Mixed content: no pretty-printing inside (like XmlWriter once text has been written).
    return out.push(`${pad}${open}>${kids.map((c) => inline(c)).join('')}</${node.name}>`);
  }
  out.push(`${pad}${open}>`);
  for (const c of kids) if (c.type !== 'text') writeNode(c, depth + 1, out, nl, indent);
  out.push(`${pad}</${node.name}>`);
}

function inline(node) {
  if (node.type === 'text') return escapeText(node.value);
  if (node.type === 'cdata') return `<![CDATA[${node.value}]]>`;
  if (node.type === 'comment') return `<!--${node.value}-->`;
  if (node.type === 'pi') return `<?${node.value}?>`;
  const open = `<${node.name}${attrString(node)}`;
  if (!node.children.length) return `${open} />`;
  return `${open}>${node.children.map(inline).join('')}</${node.name}>`;
}

/**
 * Serialize a parsed document (or a bare Element) the way Chummer writes files.
 * opts: { bom: false (Chummer writes a UTF-8 BOM; we leave it to the caller), newline: '\r\n', indent: '  ' }
 */
export function serializeXml(doc, opts = {}) {
  const isDoc = !(doc instanceof Element);
  const root = isDoc ? doc.root : doc;
  const nl = opts.newline || (isDoc && doc.newline) || '\r\n';
  const indent = opts.indent ?? '  ';
  const out = [];
  if (isDoc || opts.declaration) out.push(`<?${(isDoc && doc.declaration) || 'xml version="1.0" encoding="utf-8"'}?>`);
  if (isDoc) for (const p of doc.prolog || []) out.push(p.type === 'doctype' ? p.value : p.type === 'comment' ? `<!--${p.value}-->` : `<?${p.value}?>`);
  writeNode(root, 0, out, nl, indent);
  const body = out.join(nl);
  return (opts.bom ? '﻿' : '') + body;
}
