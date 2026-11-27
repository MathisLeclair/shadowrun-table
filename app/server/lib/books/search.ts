// Full-text search over extracted page texts: accent/case-insensitive, "quoted phrases", every term required,
// matches must start at a word boundary (« reflex » finds « Reflexes », not « … »), headings in capitals rank first.

/** A parsed query term (parseQuery); phrases carry their matching regex. */
export interface QueryTerm {
  text: string;
  phrase: boolean;
  re?: RegExp;
}
/** Extracted text of one book: original and folded page texts (same lengths). */
export interface BookDoc {
  texts: string[];
  folded: string[];
}
/** One search hit on a page. */
export interface PageHit {
  pdfPage: number;
  score: number;
  snippet: string;
  marks: Array<[number, number]>;
}

const foldCache = new Map<string, string>();
/** One char → one folded char (keeps positions aligned with the original text). */
function foldChar(c: string): string {
  let f = foldCache.get(c);
  if (f === undefined) {
    f = c.normalize('NFD')[0].toLowerCase()[0] || c;
    if (/[‐‑‒–—\-_’'`´]/.test(f)) f = f === '’' || f === "'" || f === '`' || f === '´' ? "'" : ' ';
    if (foldCache.size < 5000) foldCache.set(c, f);
  }
  return f;
}

/** Fold a text for matching: same length as the input (char-by-char), lowercase, no accents, dashes → spaces. */
// Plain lowercase ASCII letters, digits and spaces fold to themselves: only the other UTF-16 code units go through
// foldChar. Building the result with one regex replace (not `out += …` per char) matters: indexing a whole library
// char by char made a rope of millions of one-char strings (≈ 300 MB of heap for 9 M chars on the first search).
const FOLD_RE = /[^a-z0-9 ]/g;
export function fold(s: unknown): string {
  return String(s || '').replace(FOLD_RE, foldChar);
}

/** Normalized query terms: [{ text, phrase }], longest first. Words of one letter are ignored (except digits). */
export function parseQuery(q: unknown): QueryTerm[] {
  const raw = String(q || '').slice(0, 200);
  const terms: QueryTerm[] = [];
  const rest = raw.replace(/"([^"]+)"|«\s*([^»]+?)\s*»/g, (_, a: string | undefined, b: string | undefined) => {
    const p = fold(a || b).replace(/\s+/g, ' ').trim();
    if (p) terms.push({ text: p, phrase: true });
    return ' ';
  });
  for (const w of fold(rest).split(/[^\p{L}\p{N}']+/u)) {
    const t = w.replace(/^'+|'+$/g, '');
    if (t.length >= 2 || /^\d$/.test(t)) terms.push({ text: t, phrase: false });
  }
  const seen = new Set<string>();
  return terms
    .filter((t) => !seen.has(t.text) && seen.add(t.text))
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 8)
    .map((t) => (t.phrase ? { ...t, re: phraseRe(t.text) } : t));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase matches across punctuation and line breaks: « zoe heritage » finds « Zoé: Heritage ». */
function phraseRe(text: string): RegExp {
  return new RegExp(text.split(/[^\p{L}\p{N}']+/u).filter(Boolean).map(escapeRe).join("[^\\p{L}\\p{N}']+"), 'gu');
}

/** The whole query as one folded phrase (« hack on the fly »): pages containing it, above all as a heading, rank first. */
export function queryHeadline(q: unknown): string {
  return fold(String(q || '').replace(/["«»]/g, ' ')).split(/[^\p{L}\p{N}']+/u).filter(Boolean).join(' ').slice(0, 120);
}

const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);

/** Positions where `term` (string, or { text, re? }) occurs in `hay` starting at a word boundary (max `limit`). */
export function findAll(hay: string, term: string | QueryTerm, limit = 50): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (typeof term === 'object' && term.re) {
    term.re.lastIndex = 0;
    for (const m of hay.matchAll(term.re)) {
      if (!isWordChar(hay[m.index! - 1])) out.push([m.index!, m[0].length]);
      if (out.length >= limit) break;
    }
    return out;
  }
  const text = typeof term === 'object' ? term.text : term;
  let i = hay.indexOf(text);
  while (i >= 0 && out.length < limit) {
    if (!isWordChar(hay[i - 1])) out.push([i, text.length]);
    i = hay.indexOf(text, i + 1);
  }
  return out;
}

/** Snippet of `orig` around `pos` (± radius chars, cut on spaces) + highlighted ranges relative to the snippet. */
export function makeSnippet(orig: string, folded: string, terms: QueryTerm[], pos: number, radius = 90): { snippet: string; marks: Array<[number, number]> } {
  let start = Math.max(0, pos - radius);
  let end = Math.min(orig.length, pos + radius + 40);
  if (start > 0) {
    const sp = orig.indexOf(' ', start);
    if (sp >= 0 && sp < pos) start = sp + 1;
  }
  if (end < orig.length) {
    const sp = orig.lastIndexOf(' ', end);
    if (sp > pos) end = sp;
  }
  const marks: Array<[number, number]> = [];
  const window = folded.slice(start, end);
  for (const t of terms) for (const [p, len] of findAll(window, t, 20)) marks.push([p, p + len]);
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < orig.length ? '…' : '';
  return { snippet: prefix + orig.slice(start, end) + suffix, marks: merged.map(([a, b]): [number, number] => [a + prefix.length, b + prefix.length]) };
}

/**
 * Search the pages of one book. doc = { texts: [orig], folded: [folded] }.
 * Returns [{ pdfPage, score, snippet, marks }] (unsorted).
 */
export function searchPages(doc: BookDoc, terms: QueryTerm[], { limit = 200, headline = '' }: { limit?: number; headline?: string } = {}): PageHit[] {
  const hits: PageHit[] = [];
  if (!terms.length) return hits;
  const upperHeads = terms.map((t) => t.text.toUpperCase());
  const multi: QueryTerm | null = headline && headline.includes(' ') ? { text: headline, phrase: true, re: phraseRe(headline) } : null;
  const upperLine = multi ? headline.toUpperCase() : '';
  for (let i = 0; i < doc.folded.length && hits.length < limit; i++) {
    const hay = doc.folded[i];
    if (!hay) continue;
    let score = 0;
    let firstPos = -1;
    let ok = true;
    for (const t of terms) {
      const pos = findAll(hay, t, 30);
      if (!pos.length) {
        ok = false;
        break;
      }
      score += Math.min(pos.length, 10) * (t.phrase ? 3 : 1);
      if (firstPos < 0) firstPos = pos[0][0];
    }
    if (!ok) continue;
    const orig = doc.texts[i];
    // Bonus: the whole query as a phrase (« hack on the fly »), more as a heading in capitals (« HACK ON THE FLY »).
    if (multi) {
      const whole = findAll(hay, multi, 5);
      if (whole.length) {
        score += 15;
        firstPos = whole[0][0];
        const hp = orig.indexOf(upperLine);
        if (hp >= 0) {
          score += 40;
          firstPos = hp;
        }
      }
    }
    // Bonus: the (longest) term appears as a heading in capitals in the original text (« IMPROVED REFLEXES »).
    const headPos = orig.indexOf(upperHeads[0]);
    if (upperHeads[0].length >= 3 && headPos >= 0) {
      score += multi ? 10 : 25;
      if (!multi) firstPos = headPos;
    }
    hits.push({ pdfPage: i + 1, score, ...makeSnippet(orig, hay, terms, firstPos) });
  }
  return hits;
}
