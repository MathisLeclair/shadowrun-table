// Regression tests for client/lib/markdown.js (pure module, importable in Node): node tools/test-markdown.ts
import { renderMarkdown } from '../client/lib/markdown.ts';

let ok = 0;
let ko = 0;
const t = (name, fn) => {
  try {
    fn();
    ok++;
    console.log('  ok ', name);
  } catch (err) {
    ko++;
    console.log('  FAIL', name, '—', err.message);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

// Every tag must be well-formed: attributes are only name="value" pairs, never event handlers,
// and no "<" may appear inside a quoted attribute value.
function checkSafe(html) {
  const tagRe = /<([a-z0-9]+)((?:\s+[a-z-]+="[^"<]*")*)\s*\/?>|<\/[a-z0-9]+>/gi;
  const stripped = html.replace(tagRe, (m, name, attrs) => {
    if (attrs && /\son\w+=/i.test(attrs)) throw new Error('event handler attribute: ' + m);
    if (attrs && /(href|src)="\s*javascript:/i.test(attrs)) throw new Error('javascript: url: ' + m);
    return '';
  });
  assert(!/[<>]/.test(stripped), 'raw < or > outside a well-formed tag: ' + html);
  assert(!/\u0000/.test(html), 'placeholder leaked: ' + JSON.stringify(html));
}

const nasty = [
  '![a](/u[t)](/x/onerror=location=/javascript:alert%281%29/.source//)',
  '![a](/u[t)](/x/onerror=alert)',
  '[a](/x"onmouseover=1)',
  '![a](/_b_/)',
  '[x](javascript:alert(1))',
  '![x](//evil.example/a.png)',
  '<img src=x onerror=alert(1)>',
  '[`a"`](/x)',
  '![`a"b`](/x.png)',
  '_[a](/x_y_)_',
  '**[a](/x**y)**',
  '[a](/x\u0000y)',
  'a \u00000\u0000 b',
];
t('payloads never produce attribute breakouts or handlers', () => {
  for (const p of nasty) checkSafe(renderMarkdown(p));
});
t('image src cannot contain a nested link', () => {
  const h = renderMarkdown('![a](/u[t)](/x/onerror=alert)');
  assert(!/src="[^"]*<a/.test(h), h);
});
t('underscores inside a URL are not turned into <em>', () => {
  const h = renderMarkdown('![a](/_b_/)');
  assert(h.includes('src="/_b_/"'), h);
});
t('ordinary markdown still renders', () => {
  const h = renderMarkdown('# Titre\n\n**gras** *ital* _ital_ `code` [lien](https://example.com) ![img](/uploads/a.png)');
  assert(h.includes('<h1>Titre</h1>'), h);
  assert(h.includes('<strong>gras</strong>'), h);
  assert(h.includes('<em>ital</em>'), h);
  assert(h.includes('<code>code</code>'), h);
  assert(h.includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">lien</a>'), h);
  assert(h.includes('<img alt="img" src="/uploads/a.png">'), h);
  checkSafe(h);
});
t('code spans keep their content literal', () => {
  const h = renderMarkdown('`**pas gras** [x](/y)`');
  assert(h.includes('<code>**pas gras** [x](/y)</code>'), h);
});
t('link text may contain a code span', () => {
  const h = renderMarkdown('[`cmd`](/x)');
  assert(h.includes('<a href="/x" target="_blank" rel="noopener noreferrer"><code>cmd</code></a>'), h);
});

console.log(`\n${ok} ok, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
