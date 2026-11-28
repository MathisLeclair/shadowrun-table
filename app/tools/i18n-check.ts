#!/usr/bin/env node
// i18n checker for translators (see docs/i18n.md « Checker »). The code is written in English; the French lives in
// client/i18n/fr/<area>.json as { "English key": "French" }.
//
//   node tools/i18n-check.ts                    whole app: missing French entries + user-facing text not wrapped in t()
//   node tools/i18n-check.ts --area sheet       one area (client/modules/sheet, its server module and shared files)
//   node tools/i18n-check.ts client/app.tsx …   only these files / folders
// Options:
//   --add-missing=<file>.json   append the missing keys (value "") to client/i18n/fr/<file>.json, ready to translate
//   --no-literals               skip the « text not wrapped in t() » heuristic
//   --unused                    also list dictionary keys found nowhere in the code (whole-app scan only)
//   --json                      machine-readable output
//   --dict-dir <folder>         French dictionaries to check instead of client/i18n/fr (tests)
//   --strict                    exit code 1 when keys are missing or a dictionary is invalid (default: only invalid dictionaries)
//
// What it reads:
//   keys      t('…'), tn(n, '…', '…') / tn(n, { zero, one, other }), tk('…'), { t: '…' } params,
//             server ctx.fail('…') / fail('…'), errorBody('…'), i18n: { key: '…' }
//   literals  user-facing text not wrapped in t(), in any language: alphabetic JSX text nodes and
//             title= placeholder= aria-label= label= alt= hint= string props in .tsx files, and string literals given to
//             toast( confirmAction( promptText( setErr(. Proper names, symbols and single all-caps tokens ('SR5', 'PIN')
//             are not flagged.
//   A line containing « i18n-ignore » is skipped.
//   dictionaries  invalid JSON, non-string values, placeholders differing between the key and the French, the same key
//             translated two ways (same file or two files: use a context key 'ctx::text'), and an invalid
//             client/i18n/legacy-fr-keys.json (old French keys → English keys).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholders } from '../client/i18n/format.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --dict-dir <folder> (relative to app/) reads other French dictionaries: the tests use it with scratch files.
const dictArg = process.argv.find((a, i, all) => all[i - 1] === '--dict-dir') || process.argv.find((a) => a.startsWith('--dict-dir='))?.slice(11);
const DICT_REL = (dictArg || 'client/i18n/fr').split(path.sep).join('/');
const DICT_DIR = path.resolve(ROOT, DICT_REL);
const LEGACY_REL = 'client/i18n/legacy-fr-keys.json';

// Area → files (relative to app/). Every area also gets its client folder client/modules/<area>/.
const AREA_EXTRA: Record<string, string[]> = {
  core: ['client/app.tsx', 'client/lib', 'client/modules/registry.ts', 'client/modules/core', 'client/modules/admin', 'server/index.ts', 'server/errors.ts', 'server/modules/00-core.ts', 'server/lib/admin.ts', 'server/lib/tables.ts', 'server/lib/zip.ts'],
  map: ['server/modules/20-maps.ts', 'server/modules/22-maplib.ts', 'server/lib/maplib.ts', 'shared/vision.ts', 'shared/maplib.ts'],
  sheet: ['server/modules/10-characters.ts', 'shared/sr5.ts', 'shared/modifiers.ts', 'server/lib/augment.ts', 'server/lib/modifiers.ts'],
  combat: ['server/modules/30-combat.ts', 'server/modules/33-attacks.ts', 'server/modules/34-vehicles.ts', 'server/lib/vehicles.ts', 'shared/combat.ts', 'shared/vehicles.ts'],
  shop: ['server/modules/40-shop.ts'],
  matrix: ['server/modules/45-matrix.ts', 'shared/matrix.ts'],
  magic: ['server/modules/47-magic.ts', 'shared/magic.ts', 'server/lib/traditions.ts'],
  notes: ['server/modules/75-notes.ts'],
  chargen: ['server/modules/15-chargen.ts', 'shared/chargen.ts', 'shared/npcgen.ts'],
  training: ['server/modules/50-training.ts', 'shared/advancement.ts'],
  audio: ['server/modules/60-audio.ts'],
  campaign: ['server/modules/70-campaign.ts'],
  foundry: ['server/modules/80-foundry.ts', 'server/lib/foundry'],
  chummer: ['server/modules/85-chummer.ts', 'server/lib/chummer'],
  books: ['server/modules/90-books.ts', 'server/lib/books', 'server/lib/bookrefs.ts', 'shared/bookrefs.ts', 'client/modules/admin/BooksAdmin.tsx'],
  city: ['server/modules/72-city.ts', 'server/lib/city.ts', 'shared/city.ts'],
  assistant: ['server/modules/95-assistant.ts', 'server/lib/assistant', 'client/modules/admin/AssistantAdmin.tsx'],
  display: ['server/modules/96-display.ts', 'shared/display.ts'],
};
const DEFAULT_ROOTS = ['client', 'shared', 'server'];
const SKIP = [/[\\/]node_modules[\\/]/, /[\\/]client[\\/]i18n[\\/]/, /[\\/]client[\\/]vendor[\\/]/, /[\\/]server[\\/]lib[\\/]foundry[\\/]dump-child\.ts$/];
/** Scanned sources: JavaScript and TypeScript (JSX included), not declaration files. */
const isSource = (f: string): boolean => /\.(js|ts|tsx)$/.test(f) && !f.endsWith('.d.ts');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name: string): boolean => args.includes(`--${name}`);
const optVal = (name: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const area = optVal('area');
const addMissing = optVal('add-missing');
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--area', '--add-missing', '--dict-dir'].includes(args[i - 1])));

function listSources(p: string): string[] {
  const abs = path.resolve(ROOT, p);
  if (!fs.existsSync(abs)) {
    console.error(`Not found: ${p}`);
    return [];
  }
  const st = fs.statSync(abs);
  if (st.isFile()) return isSource(abs) ? [abs] : [];
  const out: string[] = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const f = path.join(abs, e.name);
    if (SKIP.some((r) => r.test(f + (e.isDirectory() ? path.sep : '')))) continue;
    if (e.isDirectory()) out.push(...listSources(f));
    else if (isSource(e.name)) out.push(f);
  }
  return out;
}

let targets: string[];
if (positional.length) targets = positional;
else if (area) {
  if (!AREA_EXTRA[area] && !fs.existsSync(path.join(ROOT, 'client', 'modules', area))) {
    console.error(`Unknown area: ${area} (areas: ${Object.keys(AREA_EXTRA).join(', ')})`);
    process.exit(2);
  }
  targets = [...(area === 'core' ? [] : [`client/modules/${area}`]), ...(AREA_EXTRA[area] || [])];
} else targets = DEFAULT_ROOTS;
const files = [...new Set(targets.flatMap(listSources))].filter((f) => !SKIP.some((r) => r.test(f)) || positional.length).sort();
const fullScan = !positional.length && !area;

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------
interface Problem { file: string; msg: string; fatal?: boolean }
const problems: Problem[] = [];
const dict = new Map<string, { value: string; file: string }>(); // English key -> French value and its dictionary
const dictFiles = fs.existsSync(DICT_DIR) ? fs.readdirSync(DICT_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort() : [];

/** Keys written more than once in a dictionary file (JSON.parse keeps the last one silently): key → values in order. */
function duplicateKeys(text: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const m of text.matchAll(/^\s*("(?:[^"\\\n]|\\.)*")\s*:\s*("(?:[^"\\\n]|\\.)*")/gm)) {
    let k: string;
    let v: string;
    try {
      k = JSON.parse(m[1]);
      v = JSON.parse(m[2]);
    } catch {
      continue;
    }
    const list = seen.get(k);
    if (list) list.push(v);
    else seen.set(k, [v]);
  }
  return new Map([...seen].filter(([, vals]) => vals.length > 1));
}

for (const f of dictFiles) {
  const rel = `${DICT_REL}/${f}`;
  const text = fs.readFileSync(path.join(DICT_DIR, f), 'utf8');
  let data: unknown; // a translator-edited file: validated below
  try {
    data = JSON.parse(text);
  } catch (err) {
    problems.push({ file: rel, msg: `invalid JSON: ${(err as Error).message}`, fatal: true });
    continue;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    problems.push({ file: rel, msg: 'must be a flat object { "English": "French" }', fatal: true });
    continue;
  }
  for (const [k, vals] of duplicateKeys(text)) {
    const distinct = [...new Set(vals)];
    problems.push({ file: rel, msg: distinct.length > 1 ? `“${k}” is written ${vals.length} times, translated two ways (${distinct.map((v) => `“${v}”`).join(' / ')}): only the last one counts` : `“${k}” is written ${vals.length} times` });
  }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') {
      problems.push({ file: rel, msg: `non-string value for “${k}”`, fatal: true });
      continue;
    }
    if (v) {
      const a = placeholders(k).sort().join(',');
      const b = placeholders(v).sort().join(',');
      if (a !== b) problems.push({ file: rel, msg: `placeholders differ: “${k}” {${a}} → “${v}” {${b}}` });
    }
    const prev = dict.get(k);
    if (prev && prev.value && v && prev.value !== v) problems.push({ file: rel, msg: `“${k}” already translated differently in ${prev.file} (“${prev.value}” / “${v}”): use a context key 'ctx::text'` });
    if (!prev || (v && !prev.value)) dict.set(k, { value: v, file: f });
  }
}
const hasFrench = (k: string): boolean => !!dict.get(k)?.value;

// Legacy map: old French keys (still in saved data) → English keys.
let legacyCount = 0;
{
  const file = path.join(ROOT, ...LEGACY_REL.split('/'));
  if (fs.existsSync(file)) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) problems.push({ file: LEGACY_REL, msg: 'must be a flat object { "old French key": "English key" }', fatal: true });
      else
        for (const [k, v] of Object.entries(data)) {
          if (typeof v !== 'string' || !v) problems.push({ file: LEGACY_REL, msg: `“${k}” must map to a non-empty English key`, fatal: true });
          else {
            legacyCount++;
            if (placeholders(k).sort().join(',') !== placeholders(v).sort().join(',')) problems.push({ file: LEGACY_REL, msg: `placeholders differ: “${k}” → “${v}”` });
            // t() maps legacy keys first: an old French key that is also an English key hijacks it.
            if (k !== v && dict.has(k)) problems.push({ file: LEGACY_REL, msg: `“${k}” is also an English key (${dict.get(k)!.file}): t('${k}') is read as the old French key and renders the text of “${v}” instead` });
          }
        }
    } catch (err) {
      problems.push({ file: LEGACY_REL, msg: `invalid JSON: ${(err as Error).message}`, fatal: true });
    }
  }
}

// ---------------------------------------------------------------------------
// JS scanning helpers
// ---------------------------------------------------------------------------
interface StrLit { value: string; end: number; dynamic: boolean }

/** Read a JS string literal starting at src[i] (quote char). Returns { value, end, dynamic } or null. */
function readString(src: string, i: number): StrLit | null {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let out = '';
  let dynamic = false;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (n === 'u') {
        const m = /^u\{([0-9a-fA-F]+)\}|^u([0-9a-fA-F]{4})/.exec(src.slice(j + 1, j + 12));
        if (m) {
          out += String.fromCodePoint(parseInt(m[1] || m[2], 16));
          j += 1 + m[0].length;
          continue;
        }
      }
      if (n === 'x') {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
        j += 4;
        continue;
      }
      if (n === '\r' || n === '\n') {
        j += n === '\r' && src[j + 2] === '\n' ? 3 : 2;
        continue;
      }
      out += map[n] ?? n;
      j += 2;
      continue;
    }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      dynamic = true;
      j = skipBalanced(src, j + 1);
      out += '${…}';
      continue;
    }
    if (c === q) return { value: out, end: j + 1, dynamic };
    if (q !== '`' && c === '\n') return null;
    out += c;
    j++;
  }
  return null;
}

/** From an opening bracket at src[i] ('{', '(' or '['), return the index just after its match (strings/templates aware). */
function skipBalanced(src: string, i: number): number {
  const open = src[i];
  const close = ({ '{': '}', '(': ')', '[': ']' } as Record<string, string>)[open];
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(src, j);
      j = s ? s.end : j + 1;
      continue;
    }
    if (c === '/' && src[j + 1] === '/') {
      const nl = src.indexOf('\n', j);
      j = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[j + 1] === '*') {
      const e = src.indexOf('*/', j + 2);
      j = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return src.length;
}

const skipWs = (src: string, i: number): number => {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
};

/** Index just after the first top-level argument starting at i (stops at ',' or ')'). */
function skipArg(src: string, i: number): number {
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === ',' || c === ')') return j;
    if (c === '(' || c === '[' || c === '{') {
      j = skipBalanced(src, j);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(src, j);
      j = s ? s.end : j + 1;
      continue;
    }
    j++;
  }
  return j;
}

/**
 * Same text with comments replaced by spaces (offsets and line numbers kept), so examples in comments are not
 * read as keys. Strings, template literals (with nested ${}) and regex literals are left untouched.
 */
function blankComments(src: string): string {
  const out = src.split('');
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prevSig = ''; // last significant char, to tell a regex literal from a division
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(src, i);
      i = s ? s.end : i + 1;
      prevSig = 'a';
      continue;
    }
    if (c === '/' && (!prevSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig))) {
      // regex literal: skip to its closing slash (outside a character class)
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') (inClass = true), j++;
        else if (src[j] === ']') (inClass = false), j++;
        else if (src[j] === '/' && !inClass) break;
        else j++;
      }
      i = j + 1;
      prevSig = 'a';
      continue;
    }
    if (!/\s/.test(c)) prevSig = /[\w$)\]]/.test(c) ? 'a' : c;
    i++;
  }
  return out.join('');
}

function lineIndex(src: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---------------------------------------------------------------------------
// « Text not wrapped in t() » heuristic
// ---------------------------------------------------------------------------
// Single words that are proper names, brands or language-neutral abbreviations: not text to translate.
const PROPER_NAMES = new Set(
  ('Shadowrun Chummer Chummer5 Chummer5a Foundry FoundryVTT Fragmaps Markdown Discord GitHub Docker Lazarus Seattle ' +
    'Ares Renraku Saeder Krupp Aztechnology Horizon Mitsuhama Evo Wuxing Lone Star Knight Errant ' +
    'Socket Express React Vite Node OpenAI Anthropic Claude Ollama YouTube Spotify ' +
    // abbreviations written the same way in French and English
    'min max ok etc')
    .split(/\s+/)
);
/**
 * Does this static text look like something a user reads (so it should go through t())? Any language. Not flagged:
 * symbols / numbers only, URLs and paths, single all-caps tokens or codes ('SR5', 'PIN', 'GM'), identifiers
 * (camelCase, snake_case, kebab-case), proper names.
 */
function looksLikeUserText(text: string): boolean {
  const s = String(text || '')
    .replace(/\$\{…\}/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^(https?:|mailto:|data:|\/|#|\.\.?\/)/.test(s)) return false;
  const words = s.match(/[\p{L}][\p{L}’'-]*/gu) || [];
  // at least one real word: 2+ letters with a lowercase letter
  const real = words.filter((w) => /\p{Ll}/u.test(w) && w.replace(/[^\p{L}]/gu, '').length >= 2);
  if (!real.length) return false;
  const tokens = s.split(' ');
  if (tokens.length === 1) {
    const w = s.replace(/[.,:;!?…)(\]["“”«»]+/g, '');
    if (!/^\p{Lu}?\p{Ll}+(?:[-’']\p{L}+)*$/u.test(w)) return false; // code, identifier, mixed case, digits
    if (w.length < 3 || PROPER_NAMES.has(w)) return false;
    if (/^[a-z]+(?:-[a-z]+)+$/.test(w)) return false; // css class / id (kebab-case)
    return true;
  }
  // several tokens: skip lists of identifiers / classes ('btn small', 'a.b c_d')
  if (tokens.every((tk) => /^[a-z0-9_.-]+$/.test(tk)) && tokens.some((tk) => /[_.-]/.test(tk))) return false;
  if (tokens.every((tk) => PROPER_NAMES.has(tk.replace(/[^\p{L}\d]/gu, '')) || !/\p{Ll}/u.test(tk))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
interface FoundKey { file: string; line: number; key: string; kind: string }
interface FoundText { file: string; line: number; text: string; kind: string }
const found: FoundKey[] = [];
const dynamicKeys: FoundText[] = []; // keys built with ${…}
const literals: FoundText[] = []; // user-facing text not wrapped in t()
const usedKeys = new Set<string>();

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const raw = fs.readFileSync(abs, 'utf8');
  const src = blankComments(raw);
  const lineOf = lineIndex(src);
  const lines = raw.split('\n');
  const ignored = (pos: number): boolean => /i18n-ignore/.test(lines[lineOf(pos) - 1] || '');
  const isServer = rel.startsWith('server/');
  const isClient = !isServer && !rel.startsWith('shared/'); // UI code (client/, or a file named on the command line)

  const addKey = (s: StrLit | null, pos: number, kind: string) => {
    if (!s || ignored(pos)) return;
    if (s.dynamic) {
      dynamicKeys.push({ file: rel, line: lineOf(pos), text: s.value, kind });
      return;
    }
    if (!s.value.trim()) return;
    usedKeys.add(s.value);
    found.push({ file: rel, line: lineOf(pos), key: s.value, kind });
  };

  // t('…') tk('…')  (not obj.t( / tIfKnown( / foo_t( )
  // (a preceding '.' is only a method call when it follows an identifier: `...t(` / `...errorBody(` are spreads)
  for (const m of src.matchAll(/(?<![\w$]|[\w$)\]]\.)(t|tk)\(\s*/g)) {
    const at = m.index + m[0].length;
    const s = readString(src, at);
    if (s) addKey(s, at, m[1]);
  }
  // tn(n, '…', '…') / tn(n, { zero, one, other })
  for (const m of src.matchAll(/(?<![\w$]|[\w$)\]]\.)tn\(\s*/g)) {
    let j = skipArg(src, m.index + m[0].length);
    if (src[j] !== ',') continue;
    j = skipWs(src, j + 1);
    if (src[j] === '{') {
      const end = skipBalanced(src, j);
      const obj = src.slice(j, end);
      for (const mm of obj.matchAll(/(zero|one|other)\s*:\s*/g)) {
        const s = readString(obj, mm.index + mm[0].length);
        if (s) addKey(s, j + mm.index, 'tn');
      }
      continue;
    }
    for (let k = 0; k < 2; k++) {
      const s = readString(src, j);
      if (!s) break;
      addKey(s, j, 'tn');
      j = skipWs(src, s.end);
      if (src[j] !== ',') break;
      j = skipWs(src, j + 1);
    }
  }
  // { t: '…', params } (translatable param values)
  for (const m of src.matchAll(/\{\s*t\s*:\s*/g)) {
    const s = readString(src, m.index + m[0].length);
    if (s) addKey(s, m.index, 'param');
  }
  if (isServer || rel.startsWith('shared/')) {
    // ctx.fail('…', params) / fail('…') — admin.ts style fail(res, status, '…') too
    for (const m of src.matchAll(/(?<![\w$])(?:ctx\.)?fail\(\s*/g)) {
      let j = m.index + m[0].length;
      let s = readString(src, j);
      if (!s && src.startsWith('res', j)) {
        j = skipArg(src, j);
        if (src[j] !== ',') continue;
        j = skipArg(src, skipWs(src, j + 1));
        if (src[j] !== ',') continue;
        j = skipWs(src, j + 1);
        s = readString(src, j);
      }
      if (s) addKey(s, j, 'fail');
    }
    for (const m of src.matchAll(/(?<![\w$]|[\w$)\]]\.)errorBody\(\s*/g)) {
      const s = readString(src, m.index + m[0].length);
      if (s) addKey(s, m.index, 'errorBody');
    }
    for (const m of src.matchAll(/i18n\s*:\s*\{\s*key\s*:\s*/g)) {
      const s = readString(src, m.index + m[0].length);
      if (s) addKey(s, m.index, 'log');
    }
  }

  if (!isClient || opt('no-literals')) continue;
  // ----- user-facing text not wrapped in t() (heuristic) -----
  const flag = (text: string, pos: number, kind: string) => {
    const v = String(text).replace(/\s+/g, ' ').trim();
    if (!ignored(pos) && looksLikeUserText(v)) literals.push({ file: rel, line: lineOf(pos), text: v.length > 90 ? v.slice(0, 87) + '…' : v, kind });
  };
  if (rel.endsWith('.tsx')) {
    // JSX string props: <input placeholder="…">  (expressions like title={t('…')} are keys, read above)
    for (const m of src.matchAll(/(?<=[\s<])(title|placeholder|label|hint|alt|aria-label)="([^"]*)"/g)) flag(m[2], m.index, m[1] + '=');
    // JSX text nodes: the static text between a tag's closing '>' and the next '<' or '{'. The '>' must end a tag
    // (follows a name, a quote, '}' or '/'; not '=>' nor a spaced comparison) and the text must not look like code.
    for (const m of src.matchAll(/(?<=[\w"'}/])>([^<>{}]+)(?=[<{])/g)) {
      const text = m[1];
      if (!text.trim() || /[;=]|&&|\|\||\?\./.test(text)) continue;
      if (/^\s*[(),:?.\]]/.test(text)) continue; // `send<T>(…`, `</b> : other ? …`: code between elements, not text
      if (/^\s*(?:\||&(?![a-z]+;|#\d+;))/i.test(text)) continue; // `Foo<Bar> | null`, `Pick<…> & …`: TypeScript types
      if (/<(code|kbd|pre|samp)\b[^<>]*$/.test(src.slice(Math.max(0, m.index - 80), m.index))) continue; // <code>npm run x</code>
      flag(text, m.index + 1, 'text');
    }
  }
  // JS literals given to user-facing calls
  for (const m of src.matchAll(/(?<![\w$.])(toast|confirmAction|promptText|setErr)\(\s*/g)) {
    const s = readString(src, m.index + m[0].length);
    if (s) flag(s.value, m.index, m[1] + '(');
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const missing = found.filter((f) => !hasFrench(f.key));
const missingUnique = [...new Set(missing.map((m) => m.key))];
const unused = opt('unused') && fullScan ? [...dict.keys()].filter((k) => !usedKeys.has(k)) : null;

if (addMissing) {
  const name = addMissing.endsWith('.json') ? addMissing : `${addMissing}.json`;
  if (!/^[\w-]+\.json$/.test(name)) {
    console.error(`Invalid dictionary name: ${name}`);
    process.exit(2);
  }
  const file = path.join(DICT_DIR, name);
  let data: Record<string, string> = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`${name} unreadable, nothing written: ${(err as Error).message}`);
      process.exit(2);
    }
  }
  let added = 0;
  for (const k of missingUnique) if (!(k in data) && !dict.has(k)) (data[k] = ''), added++;
  fs.mkdirSync(DICT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  if (!opt('json')) console.log(`${added} key(s) added to ${DICT_REL}/${name} (empty values, to translate).`);
}

const fatal = problems.some((p) => p.fatal);
if (opt('json')) {
  console.log(JSON.stringify({ files: files.length, dictionaries: dictFiles, entries: dict.size, legacy: legacyCount, keys: usedKeys.size, missing, dynamic: dynamicKeys, literals, problems, unused }, null, 2));
} else {
  const where = (x: { file: string; line: number }) => `${x.file}:${x.line}`;
  console.log(`i18n-check — ${files.length} file(s), ${dictFiles.length} French dictionar${dictFiles.length === 1 ? 'y' : 'ies'}, ${dict.size} entr${dict.size === 1 ? 'y' : 'ies'}, ${legacyCount} legacy key(s), ${usedKeys.size} key(s) used`);
  if (problems.length) {
    console.log(`\nDictionaries (${problems.length}):`);
    for (const p of problems) console.log(`  ${p.fatal ? 'ERROR' : 'warning'}  ${p.file}  ${p.msg}`);
  }
  console.log(`\nMissing French translations: ${missingUnique.length}`);
  const seen = new Set<string>();
  for (const m of missing) {
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    console.log(`  ${where(m)}  ${JSON.stringify(m.key)}`);
  }
  if (dynamicKeys.length) {
    console.log(`\nDynamic keys (\${…} in the key: use named params): ${dynamicKeys.length}`);
    for (const d of dynamicKeys) console.log(`  ${where(d)}  ${d.kind}  ${JSON.stringify(d.text)}`);
  }
  if (!opt('no-literals')) {
    console.log(`\nUser-facing text not wrapped in t(): ${literals.length}`);
    for (const l of literals) console.log(`  ${where(l)}  [${l.kind}]  ${JSON.stringify(l.text)}`);
  }
  if (unused) {
    console.log(`\nDictionary entries never used in the code: ${unused.length} (expected for the glossary and texts coming from data)`);
    for (const k of unused) console.log(`  ${dict.get(k)!.file}  ${JSON.stringify(k)}`);
  }
}
process.exit(fatal || (opt('strict') && missingUnique.length) ? 1 : 0);
