// Tests for client/lib/layout.ts (multi-view layout moves, pure, no server): node tools/test-layout.ts
import {
  DEFAULT_LAYOUT,
  sanitizeLayout,
  pruneLayout,
  showInMain,
  openSplit,
  closeSplit,
  swapSplit,
  splitCandidate,
  openFloat,
  canFloat,
  raiseFloat,
  moveFloat,
  clampFloat,
  clampDock,
  removeTab,
  whereIs,
  FLOAT_MIN,
  FLOAT_KEEP,
  DOCK_W,
  type Layout,
} from '../client/lib/layout.ts';

let ok = 0;
let ko = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    ok++;
    console.log('  ok ', name);
  } catch (err) {
    ko++;
    console.log('  FAIL', name, '—', (err as Error).message);
  }
};
const eq = (a: unknown, b: unknown, m = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const area = { w: 1200, h: 800 };
const L0: Layout = { ...DEFAULT_LAYOUT };

t('sanitize: garbage gives the defaults', () => {
  eq(sanitizeLayout(null), DEFAULT_LAYOUT);
  eq(sanitizeLayout('x'), DEFAULT_LAYOUT);
  eq(sanitizeLayout({ splitRatio: 'a', dockW: -5, floats: 'no' }).dockW, DOCK_W.min);
});
t('sanitize: duplicate floats dropped, split cannot also float', () => {
  const l = sanitizeLayout({ split: 'map', floats: [{ tab: 'map' }, { tab: 'map' }, { tab: 'matrix', w: 10, h: 10 }, { tab: 7 }] });
  eq(l.floats.map((f) => f.tab), ['map', 'matrix']);
  eq(l.split, null);
  eq([l.floats[1].w, l.floats[1].h], [FLOAT_MIN.w, FLOAT_MIN.h]);
});
t('split: open, main tab refused, close remembers the tab', () => {
  const l = openSplit(L0, 'map', 'sheet');
  eq([l.split, l.lastSplit], ['sheet', 'sheet']);
  eq(openSplit(L0, 'map', 'map'), L0);
  const c = closeSplit(l);
  eq([c.split, c.lastSplit], [null, 'sheet']);
  eq(splitCandidate(c, 'map', ['map', 'matrix', 'sheet']), 'sheet');
  eq(splitCandidate(L0, 'map', ['map', 'matrix', 'sheet']), 'matrix');
  eq(splitCandidate(L0, 'map', ['map']), null);
});
t('top tab click on the split tab swaps the panes', () => {
  const l = openSplit(L0, 'map', 'sheet');
  const p = showInMain(l, 'map', 'sheet');
  eq([p.main, p.layout.split], ['sheet', 'map']);
  const s = swapSplit(l, 'map');
  eq([s.main, s.layout.split], ['sheet', 'map']);
});
t('top tab click on a floating tab docks it back in the main pane', () => {
  const f = openFloat(L0, 'map', 'matrix', area);
  eq(f.main, 'map');
  eq(whereIs(f.layout, 'map', 'matrix'), 'float');
  const p = showInMain(f.layout, 'map', 'matrix');
  eq([p.main, p.layout.floats.length], ['matrix', 0]);
});
t('a tab shows once: opening it in the split takes it out of the floats', () => {
  const f = openFloat(L0, 'map', 'matrix', area).layout;
  const s = openSplit(f, 'map', 'matrix');
  eq([s.split, s.floats.length], ['matrix', 0]);
  const back = openFloat(s, 'map', 'matrix', area).layout;
  eq([back.split, back.floats.length], [null, 1]);
});
t('floating the main tab needs a split pane, whose tab takes the main pane', () => {
  eq(canFloat(L0, 'map', 'map'), false);
  eq(openFloat(L0, 'map', 'map', area).layout, L0);
  const s = openSplit(L0, 'map', 'sheet');
  const p = openFloat(s, 'map', 'map', area);
  eq([p.main, p.layout.split, p.layout.floats[0].tab], ['sheet', null, 'map']);
});
t('new floats fit the area and stack on top', () => {
  const a = openFloat(L0, 'map', 'matrix', area).layout;
  const b = openFloat(a, 'map', 'notes', area).layout;
  const [fa, fb] = b.floats;
  eq(fb.z > fa.z, true, 'z');
  eq(fa.x + fa.w <= area.w && fa.y >= 0, true, 'inside');
  const r = raiseFloat(b, 'matrix');
  eq(r.floats[0].z > r.floats[1].z, true, 'raised');
  eq(raiseFloat(r, 'matrix'), r, 'already on top: unchanged');
});
t('floats stay grabbable: clamped size and position', () => {
  const f = clampFloat({ tab: 'x', x: 5000, y: -50, w: 50, h: 5000, z: 1 }, area);
  eq([f.w, f.h, f.y], [FLOAT_MIN.w, area.h, 0]);
  eq(f.x, area.w - FLOAT_KEEP.x);
  const g = clampFloat({ tab: 'x', x: -5000, y: 5000, w: 400, h: 300, z: 1 }, area);
  eq([g.x, g.y], [FLOAT_KEEP.x - 400, area.h - FLOAT_KEEP.bar]);
  const m = moveFloat(openFloat(L0, 'map', 'notes', area).layout, 'notes', { x: 10, y: 20, w: 600, h: 400 }, area);
  eq([m.floats[0].x, m.floats[0].y, m.floats[0].w, m.floats[0].h], [10, 20, 600, 400]);
});
t('prune: hidden tabs and the main tab are dropped from the view', () => {
  const l = openFloat(openSplit(L0, 'map', 'sheet'), 'map', 'audio', area).layout;
  eq(pruneLayout(l, 'map', ['map', 'sheet', 'audio']), l, 'unchanged when all visible');
  const p = pruneLayout(l, 'map', ['map', 'sheet']);
  eq([p.split, p.floats.length], ['sheet', 0]);
  const q = pruneLayout(l, 'sheet', ['map', 'sheet', 'audio']);
  eq(q.split, null);
});
t('the main tab is remembered', () => {
  eq(sanitizeLayout({ main: 'matrix' }).main, 'matrix');
  eq(sanitizeLayout({ main: 3 }).main, null);
});
t('removeTab (pop-out) and dock width', () => {
  const l = openSplit(L0, 'map', 'sheet');
  eq(removeTab(l, 'sheet').split, null);
  eq(removeTab(l, 'other'), l);
  eq(clampDock(100), DOCK_W.min);
  eq(clampDock(5000), DOCK_W.max);
  eq(clampDock(700, 1000), 600);
});

console.log(`\n${ok} ok, ${ko} failed`);
process.exit(ko ? 1 : 0);
