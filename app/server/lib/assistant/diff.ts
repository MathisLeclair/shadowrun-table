// GM assistant — text edits and their preview: exact find/replace on a text, and a line diff (hunks with a little
// context) for the proposal card. Pure functions, no I/O.

/** One find/replace step. `all` replaces every occurrence; otherwise the text must appear exactly once. */
export interface TextEdit {
  find: string;
  replace: string;
  all?: boolean;
}
/** A line of a diff hunk: ' ' kept (context), '-' removed, '+' added. */
export interface DiffLine {
  op: ' ' | '-' | '+';
  s: string;
}
/** Consecutive changed lines with their context. `skip` = unchanged lines left out before this hunk. */
export interface DiffHunk {
  skip: number;
  lines: DiffLine[];
}
/** Diff of one field (or one document) for the card. `cut` = lines left out because the diff is too long. */
export interface FieldDiff {
  field: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  cut?: number;
}

export const toLF = (s: unknown): string => String(s ?? '').replace(/\r\n?/g, '\n');
const clipOne = (s: string, n = 80): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

function count(text: string, find: string): number {
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

/**
 * Apply find/replace edits in order (line endings normalized to \n). Errors are written for the model (French),
 * like the other tool errors: it can fix its input and try again.
 */
export function applyEdits(text: string, edits: TextEdit[], where: string): { text: string } | { error: string } {
  let out = toLF(text);
  for (const e of edits) {
    const find = toLF(e.find);
    const replace = toLF(e.replace);
    if (!find) return { error: `${where} : « find » est vide (copie le passage exact à remplacer).` };
    const n = count(out, find);
    if (!n) return { error: `${where} : texte introuvable (il a peut-être changé ; relis-le) : « ${clipOne(find)} »` };
    if (n > 1 && !e.all) return { error: `${where} : le texte apparaît ${n} fois : « ${clipOne(find)} ». Ajoute du contexte pour qu'il soit unique, ou all: true.` };
    out = e.all ? out.split(find).join(replace) : out.replace(find, () => replace);
  }
  return { text: out };
}

/** Edit list from the model's input (foreign data): keeps well-formed entries only. */
export function cleanEdits(list: unknown, max = 50): TextEdit[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === 'object' && typeof e.find === 'string')
    .slice(0, max)
    .map((e) => ({ find: e.find, replace: typeof e.replace === 'string' ? e.replace : '', all: e.all === true }));
}

const MAX_CELLS = 4_000_000; // LCS table size limit; beyond it the middle is shown as one block
const CONTEXT = 2;

/** Line diff of two texts as hunks. Long diffs are cut after `maxLines` shown lines. */
export function diffLines(beforeText: string, afterText: string, field = '', maxLines = 400): FieldDiff {
  const a = toLF(beforeText).split('\n');
  const b = toLF(afterText).split('\n');
  if (beforeText === '') a.length = 0;
  if (afterText === '') b.length = 0;
  // Common prefix / suffix first: most edits touch a small part of a long text.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: DiffLine[] = a.slice(0, pre).map((s) => ({ op: ' ', s }));
  if (am.length * bm.length > MAX_CELLS) {
    for (const s of am) ops.push({ op: '-', s });
    for (const s of bm) ops.push({ op: '+', s });
  } else {
    // LCS lengths, from the end, then walk forward.
    const n = am.length, m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ op: ' ', s: am[i++] });
        j++;
      } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) ops.push({ op: '-', s: am[i++] }); // removed lines first
      else ops.push({ op: '+', s: bm[j++] });
    }
  }
  for (const s of a.slice(a.length - suf)) ops.push({ op: ' ', s });

  const hunks: DiffHunk[] = [];
  let added = 0, removed = 0, shown = 0, cut = 0;
  let k = 0, lastEnd = 0;
  while (k < ops.length) {
    if (ops[k].op === ' ') {
      k++;
      continue;
    }
    const start = Math.max(lastEnd, k - CONTEXT);
    let end = k;
    // Extend while changes are closer than 2×CONTEXT lines apart.
    while (end < ops.length) {
      if (ops[end].op !== ' ') {
        end++;
        continue;
      }
      let next = end;
      while (next < ops.length && ops[next].op === ' ') next++;
      if (next < ops.length && next - end <= CONTEXT * 2) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    const lines = ops.slice(start, stop);
    for (const l of lines) {
      if (l.op === '+') added++;
      else if (l.op === '-') removed++;
    }
    if (shown < maxLines) {
      const room = maxLines - shown;
      hunks.push({ skip: start - lastEnd, lines: lines.slice(0, room) });
      shown += Math.min(room, lines.length);
      cut += Math.max(0, lines.length - room);
    } else cut += lines.length;
    lastEnd = stop;
    k = stop;
  }
  return { field, hunks, added, removed, ...(cut ? { cut } : {}) };
}
