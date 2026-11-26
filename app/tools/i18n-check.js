#!/usr/bin/env node
// i18n checker for translators (see ARCHITECTURE.md « i18n »).
//
//   node tools/i18n-check.js                    whole app: missing English entries + suspicious French literals
//   node tools/i18n-check.js --area sheet       one area (client/modules/sheet, its server module and shared files)
//   node tools/i18n-check.js client/app.js …    only these files / folders
// Options:
//   --add-missing=<file>.json   append the missing keys (value "") to client/i18n/en/<file>.json, ready to translate
//   --no-literals               skip the untranslated-French heuristic
//   --unused                    also list dictionary keys found nowhere in the code (whole-app scan only)
//   --json                      machine-readable output
//   --strict                    exit code 1 when keys are missing or a dictionary is invalid (default: only invalid dictionaries)
//
// What it reads:
//   keys      t('…'), tn(n, '…', '…') / tn(n, { zero, one, other }), tk('…'), { t: '…' } params,
//             server ctx.fail('…') / fail('…'), errorBody('…'), i18n: { key: '…' }
//   literals  French-looking text in html`` templates (text nodes, title= placeholder= label= hint= alt= aria-label=),
//             and string literals given to toast( confirmAction( promptText( setErr( Error( or to label:/title:/hint:/placeholder: props.
//   A line containing « i18n-ignore » is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholders } from '../client/i18n/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICT_DIR = path.join(ROOT, 'client', 'i18n', 'en');

// Area → files (relative to app/). Every area also gets its client folder client/modules/<area>/.
const AREA_EXTRA = {
  core: ['client/app.js', 'client/lib', 'client/modules/registry.js', 'client/modules/core', 'client/modules/admin', 'server/index.js', 'server/modules/00-core.js', 'server/lib/admin.js', 'server/lib/tables.js', 'server/lib/zip.js'],
  map: ['server/modules/20-maps.js', 'shared/vision.js'],
  sheet: ['server/modules/10-characters.js', 'shared/sr5.js', 'server/lib/augment.js'],
  combat: ['server/modules/30-combat.js'],
  shop: ['server/modules/40-shop.js'],
  matrix: ['server/modules/45-matrix.js', 'shared/matrix.js'],
  chargen: ['server/modules/15-chargen.js', 'shared/chargen.js', 'shared/npcgen.js'],
  training: ['server/modules/50-training.js', 'shared/advancement.js'],
  audio: ['server/modules/60-audio.js'],
  campaign: ['server/modules/70-campaign.js'],
  foundry: ['server/modules/80-foundry.js', 'server/lib/foundry'],
  chummer: ['server/modules/85-chummer.js', 'server/lib/chummer'],
};
const DEFAULT_ROOTS = ['client', 'shared', 'server'];
const SKIP = [/[\\/]node_modules[\\/]/, /[\\/]client[\\/]i18n[\\/]/, /[\\/]server[\\/]lib[\\/]foundry[\\/]dump-child\.js$/];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name) => args.includes(`--${name}`);
const optVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const area = optVal('area');
const addMissing = optVal('add-missing');
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--area', '--add-missing'].includes(args[i - 1])));

function listJs(p) {
  const abs = path.resolve(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return abs.endsWith('.js') ? [abs] : [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const f = path.join(abs, e.name);
    if (SKIP.some((r) => r.test(f + (e.isDirectory() ? path.sep : '')))) continue;
    if (e.isDirectory()) out.push(...listJs(f));
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

let targets;
if (positional.length) targets = positional;
else if (area) {
  if (!AREA_EXTRA[area] && !fs.existsSync(path.join(ROOT, 'client', 'modules', area))) {
    console.error(`Zone inconnue : ${area} (zones : ${Object.keys(AREA_EXTRA).join(', ')})`);
    process.exit(2);
  }
  targets = [...(area === 'core' ? [] : [`client/modules/${area}`]), ...(AREA_EXTRA[area] || [])];
} else targets = DEFAULT_ROOTS;
const files = [...new Set(targets.flatMap(listJs))].filter((f) => !SKIP.some((r) => r.test(f)) || positional.length).sort();
const fullScan = !positional.length && !area;

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------
const problems = []; // { file, msg, fatal }
const dict = new Map(); // key -> { value, file }
const dictFiles = fs.existsSync(DICT_DIR) ? fs.readdirSync(DICT_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort() : [];
for (const f of dictFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8'));
  } catch (err) {
    problems.push({ file: `client/i18n/en/${f}`, msg: `JSON invalide : ${err.message}`, fatal: true });
    continue;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    problems.push({ file: `client/i18n/en/${f}`, msg: 'doit être un objet plat { "français": "english" }', fatal: true });
    continue;
  }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') {
      problems.push({ file: `client/i18n/en/${f}`, msg: `valeur non textuelle pour « ${k} »`, fatal: true });
      continue;
    }
    if (v) {
      const a = placeholders(k).sort().join(',');
      const b = placeholders(v).sort().join(',');
      if (a !== b) problems.push({ file: `client/i18n/en/${f}`, msg: `placeholders différents : « ${k} » {${a}} → « ${v} » {${b}}` });
    }
    const prev = dict.get(k);
    if (prev && prev.value && v && prev.value !== v) problems.push({ file: `client/i18n/en/${f}`, msg: `« ${k} » déjà traduit autrement dans ${prev.file} (« ${prev.value} » / « ${v} ») — utilise une clé à contexte 'ctx::texte'` });
    if (!prev || (v && !prev.value)) dict.set(k, { value: v, file: f });
  }
}
const hasEnglish = (k) => !!dict.get(k)?.value;

// ---------------------------------------------------------------------------
// JS scanning helpers
// ---------------------------------------------------------------------------
/** Read a JS string literal starting at src[i] (quote char). Returns { value, end, dynamic } or null. */
function readString(src, i) {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let out = '';
  let dynamic = false;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
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
function skipBalanced(src, i) {
  const open = src[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
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

const skipWs = (src, i) => {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
};

/** Index just after the first top-level argument starting at i (stops at ',' or ')'). */
function skipArg(src, i) {
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
function blankComments(src) {
  const out = src.split('');
  const blank = (a, b) => {
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

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (pos) => {
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

// French-looking text: accented letters / guillemets, or common French words.
const FR_CHARS = /[àâäéèêëîïôöùûüçœæÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒÆ«»’]/;
const FR_WORDS = new Set(
  ('le la les un une des du de et ou pour avec sans dans sur est sont pas aucun aucune tous toutes tout nouveau nouvelle ajouter supprimer fermer annuler ' +
    'enregistrer valider joueur joueurs personnage personnages carte cartes mj oui non choisir choisis effacer modifier retirer afficher masquer envoyer ' +
    'ton ta tes votre vos ce cette ces au aux jet dés lancer rien encore déjà ici chargement erreur introuvable impossible actif active inactif ' +
    'niveau objet objets arme armes armure sort sorts nom notes acheter vendre prix quantité dégâts blessure blessures combat initiative tour round')
    .split(/\s+/)
);
function looksFrench(text) {
  const s = String(text || '').trim();
  if (!s || !/\p{L}{2,}/u.test(s)) return false;
  if (/^[\w.-]+$/.test(s) && !FR_CHARS.test(s) && !/\s/.test(s) && /[-_.]/.test(s)) return false; // css class / id
  if (/^(https?:|\/|#|\.)/.test(s)) return false;
  if (FR_CHARS.test(s)) return true;
  const words = s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.some((w) => FR_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
const found = []; // { file, line, key, kind }
const dynamicKeys = []; // { file, line, text, kind }
const literals = []; // { file, line, text, kind }
const usedKeys = new Set();

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const raw = fs.readFileSync(abs, 'utf8');
  const src = blankComments(raw);
  const lineOf = lineIndex(src);
  const lines = raw.split('\n');
  const ignored = (pos) => /i18n-ignore/.test(lines[lineOf(pos) - 1] || '');
  const isServer = rel.startsWith('server/');
  const isClient = !isServer && !rel.startsWith('shared/'); // UI code (client/, or a file named on the command line)

  const addKey = (s, pos, kind) => {
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
    // ctx.fail('…', params) / fail('…') — admin.js style fail(res, status, '…') too
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
  // ----- untranslated French literals (heuristic) -----
  const flag = (text, pos, kind) => {
    const v = String(text).replace(/\s+/g, ' ').trim();
    if (!ignored(pos) && looksFrench(v)) literals.push({ file: rel, line: lineOf(pos), text: v.length > 90 ? v.slice(0, 87) + '…' : v, kind });
  };
  // html`…` static parts: text nodes and display attributes
  for (const m of src.matchAll(/(?<![\w$])html`/g)) {
    let j = m.index + m[0].length;
    let inTag = false;
    let quote = null;
    let text = '';
    let textStart = j;
    let tag = '';
    let tagStart = j;
    const flushText = () => {
      if (text.trim()) flag(text, textStart, 'texte');
      text = '';
    };
    const flushTag = () => {
      for (const am of tag.matchAll(/(?:^|\s)(title|placeholder|label|hint|alt|aria-label|serverLabel)\s*=\s*"([^"]*)"/g)) flag(am[2], tagStart, am[1] + '=');
      tag = '';
    };
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') {
        (inTag ? (tag += src.slice(j, j + 2)) : (text += src[j + 1]));
        j += 2;
        continue;
      }
      if (c === '`') break;
      if (c === '$' && src[j + 1] === '{') {
        if (!inTag) {
          flushText();
          textStart = skipBalanced(src, j + 1);
        } else tag += '${}';
        j = skipBalanced(src, j + 1);
        continue;
      }
      if (inTag) {
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') {
          inTag = false;
          flushTag();
          j++;
          textStart = j;
          continue;
        }
        tag += c;
      } else if (c === '<') {
        flushText();
        inTag = true;
        tagStart = j;
      } else text += c;
      j++;
    }
    flushText();
  }
  // JS literals given to user-facing calls / props
  for (const m of src.matchAll(/(?<![\w$.])(toast|confirmAction|promptText|setErr|Error|alert)\(\s*/g)) {
    const s = readString(src, m.index + m[0].length);
    if (s) flag(s.value, m.index, m[1] + '(');
  }
  for (const m of src.matchAll(/(?<![\w$])(label|title|hint|placeholder|empty|description)\s*:\s*/g)) {
    const s = readString(src, m.index + m[0].length);
    if (s) flag(s.value, m.index, m[1] + ':');
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const missing = found.filter((f) => !hasEnglish(f.key));
const missingUnique = [...new Set(missing.map((m) => m.key))];
const unused = opt('unused') && fullScan ? [...dict.keys()].filter((k) => !usedKeys.has(k)) : null;

if (addMissing) {
  const name = addMissing.endsWith('.json') ? addMissing : `${addMissing}.json`;
  if (!/^[\w-]+\.json$/.test(name)) {
    console.error(`Nom de dictionnaire invalide : ${name}`);
    process.exit(2);
  }
  const file = path.join(DICT_DIR, name);
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`${name} illisible, rien n'est écrit : ${err.message}`);
      process.exit(2);
    }
  }
  let added = 0;
  for (const k of missingUnique) if (!(k in data) && !dict.has(k)) (data[k] = ''), added++;
  fs.mkdirSync(DICT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  if (!opt('json')) console.log(`${added} clé(s) ajoutée(s) à client/i18n/en/${name} (valeurs vides à traduire).`);
}

const fatal = problems.some((p) => p.fatal);
if (opt('json')) {
  console.log(JSON.stringify({ files: files.length, dictionaries: dictFiles, entries: dict.size, keys: usedKeys.size, missing, dynamic: dynamicKeys, literals, problems, unused }, null, 2));
} else {
  const where = (x) => `${x.file}:${x.line}`;
  console.log(`i18n-check — ${files.length} fichier(s), ${dictFiles.length} dictionnaire(s), ${dict.size} entrée(s), ${usedKeys.size} clé(s) utilisée(s)`);
  if (problems.length) {
    console.log(`\nDictionnaires (${problems.length}) :`);
    for (const p of problems) console.log(`  ${p.fatal ? 'ERREUR' : 'attention'}  ${p.file}  ${p.msg}`);
  }
  console.log(`\nTraductions anglaises manquantes : ${missingUnique.length}`);
  const seen = new Set();
  for (const m of missing) {
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    console.log(`  ${where(m)}  ${JSON.stringify(m.key)}`);
  }
  if (dynamicKeys.length) {
    console.log(`\nClés dynamiques (\${…} dans la clé : passer par des paramètres nommés) : ${dynamicKeys.length}`);
    for (const d of dynamicKeys) console.log(`  ${where(d)}  ${d.kind}  ${JSON.stringify(d.text)}`);
  }
  if (!opt('no-literals')) {
    console.log(`\nTextes français probablement non traduits : ${literals.length}`);
    for (const l of literals) console.log(`  ${where(l)}  [${l.kind}]  ${JSON.stringify(l.text)}`);
  }
  if (unused) {
    console.log(`\nEntrées de dictionnaire jamais utilisées dans le code : ${unused.length} (normal pour le glossaire et les textes venant des données)`);
    for (const k of unused) console.log(`  ${dict.get(k).file}  ${JSON.stringify(k)}`);
  }
}
process.exit(fatal || (opt('strict') && missingUnique.length) ? 1 : 0);
