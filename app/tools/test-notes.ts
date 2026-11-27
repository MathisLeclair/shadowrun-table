// Notes module tests: node tools/test-notes.ts  (exit code != 0 on failure). Ports 3150-3199.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import notesModule, {
  ensureNotes, housekeep, canRead, canWrite, canComment, totalSize, ownerSize,
  MAX_BODY, TRASH_MS, MAX_OWNER_TOTAL, MAX_TOTAL, MAX_USER_COMMENTS,
} from '../server/modules/75-notes.ts';
import { renderNote, toggleCheckbox, toggleCheckboxAt, countCheckboxes, applyFormat, wikiTitles, encodeRef, decodeRef } from '../client/modules/notes/notes-md.ts';
import { missingSelection, errorGate, storedName } from '../client/modules/notes/common.ts';
import { startServer, login, client, settle } from './test-client.ts';
import type { TestClient } from './test-client.ts';
import type { ActionContext, ActionPayload, GameView, I18nParams, NotePage, NotesState, SessionUser, TableState } from '../shared/types.ts';

type NoteUser = Pick<SessionUser, 'id' | 'role'>;
type RunUser = NoteUser & { name: string };
/** Error thrown by run()'s ctx.fail: the French key and its params. */
type FailError = Error & { key: string; params?: I18nParams };
// filter / gmFilter tolerate a missing fullState (filterView) although the ServerModule signature requires it.
type ViewFilter = (view: GameView, user: NoteUser, fullState?: TableState) => void;

let failures = 0;
let passed = 0;
async function test(name: string, fn: () => unknown) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${(err as Error).stack || err}`);
  }
}
async function rejects(p: Promise<unknown>, re: RegExp, what = '') {
  try {
    await p;
  } catch (err) {
    assert.match((err as Error).message, re, `${what}: unexpected error “${(err as Error).message}”`);
    return;
  }
  assert.fail(`${what}: should have been refused`);
}
const pagesOf = (c: TestClient) => Object.values(c.state.notes?.pages || {});
const leaks = (c: TestClient, marker: string) => JSON.stringify(c.state).includes(marker);

// ---------------------------------------------------------------------------
console.log('Pure helpers');
await test('ensureNotes repairs a broken slice; housekeep purges old trash and expired locks', () => {
  const now = Date.now();
  const state = {
    notes: {
      pages: {
        a: { scope: 'party', title: 'A', body: 'x', version: 3, lock: { userId: 'u1', name: 'J', until: now - 1 } },
        b: { scope: 'private', title: 'B', body: 'y', ownerId: 'u1', deleted: { at: now - TRASH_MS - 1000, by: 'u1' } },
        c: { scope: 'private', title: 'no owner' },
        d: { scope: 'weird' },
        e: { scope: 'party', title: 'E', body: '', deleted: { at: now - 1000, by: 'u2' }, lock: { userId: 'u2', until: now + 30000 } },
      },
      comments: { a: [{ id: 'c1', text: 'hi' }], zz: [{ id: 'c2' }], b: [] },
    },
  };
  const n = ensureNotes(state as unknown as TableState); // partial / broken fixture on purpose
  assert.deepEqual(Object.keys(n.pages).sort(), ['a', 'b', 'e']);
  assert.equal(n.settings.gmCanEditParty, false);
  assert.ok(!n.comments.zz, 'comments of unknown pages dropped');
  housekeep(n, now);
  assert.deepEqual(Object.keys(n.pages).sort(), ['a', 'e'], 'trash older than 7 days purged');
  assert.ok(!n.pages.a.lock, 'expired lock removed');
  assert.ok(n.pages.e.lock, 'live lock kept');
  assert.equal(n.pages.a.version, 3);
  const evil = { notes: JSON.parse('{"pages":{"__proto__":{"scope":"party","title":"x"},"bad id!":{"scope":"party"}}}') };
  ensureNotes(evil as unknown as TableState);
  assert.deepEqual(Object.keys(evil.notes.pages), [], 'reserved / malformed ids dropped');
});

await test('permission helpers', () => {
  const p1: NoteUser = { id: 'u1', role: 'player' };
  const p2: NoteUser = { id: 'u2', role: 'player' };
  const gm: NoteUser = { id: 'gm', role: 'gm' };
  const priv = { scope: 'private', ownerId: 'u1', shareWithGM: false } as NotePage;
  const party = { scope: 'party' } as NotePage;
  const notes = { settings: { gmCanEditParty: false } } as NotesState;
  assert.ok(canRead(priv, p1) && !canRead(priv, p2) && !canRead(priv, gm));
  assert.ok(canRead({ ...priv, shareWithGM: true }, gm) && !canRead({ ...priv, shareWithGM: true }, p2));
  assert.ok(canWrite(priv, p1, notes) && !canWrite({ ...priv, shareWithGM: true }, gm, notes));
  assert.ok(canWrite(party, p2, notes) && !canWrite(party, gm, notes) && canWrite(party, gm, { settings: { gmCanEditParty: true } } as NotesState));
  assert.ok(canComment(party, gm) && !canComment(priv, p1) && canComment({ ...priv, shareWithGM: true }, gm));
});

await test('filter keeps only readable pages (player and GM)', () => {
  const view = {
    notes: {
      pages: {
        mine: { id: 'mine', scope: 'private', ownerId: 'u1', title: 'm', body: '' },
        other: { id: 'other', scope: 'private', ownerId: 'u2', title: 'o', body: 'SECRET', shareWithGM: true },
        party: { id: 'party', scope: 'party', title: 'p', body: '', lock: { userId: 'u2', name: 'X', until: Date.now() - 5 } },
      },
      comments: { other: [{ id: 'c', text: 'gm says' }], party: [{ id: 'd', text: 'hello' }] },
      settings: { gmCanEditParty: true },
    },
  };
  const pv = structuredClone(view) as unknown as GameView;
  (notesModule.filter as ViewFilter)(pv, { id: 'u1', role: 'player' });
  assert.deepEqual(Object.keys(pv.notes.pages).sort(), ['mine', 'party']);
  assert.ok(!JSON.stringify(pv).includes('SECRET') && !JSON.stringify(pv).includes('gm says'));
  assert.ok(!pv.notes.pages.party.lock, 'expired lock not sent');
  assert.equal(typeof pv.notes.now, 'number');
  const gv = structuredClone(view) as unknown as GameView;
  (notesModule.gmFilter as ViewFilter)(gv, { id: 'gm', role: 'gm' });
  assert.deepEqual(Object.keys(gv.notes.pages).sort(), ['other', 'party']);
  assert.equal(gv.notes.comments.other.length, 1);
});

await test('renderNote: wiki links, mentions, checkboxes, escaping', () => {
  const body = '- [ ] Voir @Jane\n- [x] Fait\nLien [[Contacts]] / [[Inconnu (bis)]] `[[code]] @Jane`\n```\n- [ ] dans du code\n```\n<b>@Jane</b>';
  const r = renderNote(body, { resolve: (t) => (t === 'Contacts' ? 'note_1' : null), mentions: ['Jane'], editable: true });
  assert.equal(r.checkboxes, 2);
  assert.equal(countCheckboxes(body), 2);
  assert.match(r.html, /<a href="#note:note_1"[^>]*>Contacts<\/a>/);
  assert.match(r.html, /href="#new:Inconnu%20%28bis%29"/);
  assert.match(r.html, /<span class="notes-mention">@Jane<\/span>/);
  assert.match(r.html, /<code>\[\[code\]\] @Jane<\/code>/, 'nothing inside inline code');
  assert.ok(!r.html.includes('<b>'), 'raw HTML escaped');
  assert.match(r.html, /data-cb="1" data-line="1" checked>/);
  assert.ok(!renderNote(body).html.includes('notes-cb" data-cb="0">') || renderNote(body).html.includes('disabled'), 'read-only checkboxes are disabled');
  assert.equal(decodeRef(encodeRef("l'ami (x)")), "l'ami (x)");
  assert.deepEqual(wikiTitles(body), ['Contacts', 'Inconnu (bis)', 'code']);
});

await test('toggleCheckbox and applyFormat', () => {
  const body = '- [ ] a\n```\n- [ ] code\n```\n> - [x] b';
  assert.equal(toggleCheckbox(body, 0), body.replace('- [ ] a', '- [x] a'));
  assert.equal(toggleCheckbox(body, 1), body.replace('> - [x] b', '> - [ ] b'));
  assert.equal(toggleCheckbox(body, 5), body);
  assert.deepEqual(applyFormat('hello world', 6, 11, 'bold'), { value: 'hello **world**', start: 8, end: 13 });
  assert.equal(applyFormat('hello **world**', 8, 13, 'bold').value, 'hello world');
  assert.equal(applyFormat('a\nb', 0, 3, 'check').value, '- [ ] a\n- [ ] b');
  assert.equal(applyFormat('- [ ] a\n- [ ] b', 0, 15, 'check').value, 'a\nb');
  assert.equal(applyFormat('- a', 2, 2, 'check').value, '- [ ] a');
  assert.equal(applyFormat('x', 0, 1, 'link').value, '[[x]]');
  assert.equal(applyFormat('titre', 0, 0, 'heading').value, '## titre');
});

// ---------------------------------------------------------------------------
console.log('Review regressions (pure)');

// Run an action handler directly on a state (no sockets): big quota scenarios stay fast.
let seq = 0;
// Action results have many shapes: `any`, like client.send().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(state: TableState, user: RunUser, type: string, payload: ActionPayload): any {
  const ctx = {
    state, user, isGM: user.role === 'gm', now: Date.now(), tableId: 't', lang: 'fr',
    fail: (key: string, params?: I18nParams) => {
      throw Object.assign(new Error(key), { key, params });
    },
    uid: (p: string) => `${p}_${++seq}`,
    log: () => {},
    emitTo: () => {},
    displayName: () => user.name,
    t: (k: string) => k,
  };
  return notesModule.actions![type].handler(ctx as unknown as ActionContext, payload); // no table / owns: unused by notes
}
const throwsKey = (fn: () => unknown, re: RegExp, what: string) => assert.throws(fn, (e) => re.test((e as FailError).key), what);

await test('[1] a just-created page stays selected until the state broadcast brings it', () => {
  const now = 1000;
  const pending = { id: 'note_new', until: now + 3000 };
  assert.deepEqual(missingSelection('note_new', false, pending, now), { wait: 3000 }, 'reply came before the broadcast: wait, do not clear');
  assert.equal(missingSelection('note_new', true, pending, now + 30), 'keep');
  assert.equal(missingSelection('note_new', false, pending, now + 3001), 'clear', 'never arrived: give up');
  assert.equal(missingSelection('note_old', false, pending, now), 'clear', 'another vanished page is still cleared');
  assert.equal(missingSelection('note_old', false, null, now), 'clear');
  assert.equal(missingSelection(null, false, pending, now), 'keep');
});

await test('[2] one player cannot fill the table; a removed player frees their space; comments count', () => {
  const state = { users: { bob: { id: 'bob' }, alice: { id: 'alice' } }, log: [] } as unknown as TableState; // minimal fixture
  const bob: RunUser = { id: 'bob', role: 'player', name: 'Bob' };
  const alice: RunUser = { id: 'alice', role: 'player', name: 'Alice' };
  const big = 'x'.repeat(MAX_BODY);
  let made = 0;
  let refused: FailError | null = null;
  for (let i = 0; i < 300 && !refused; i++) {
    try {
      run(state, bob, 'notes/create', { scope: 'private', title: `B${i}`, body: big });
      made++;
    } catch (e) {
      refused = e as FailError;
    }
  }
  assert.ok(refused && /Your personal notes are full/.test(refused.key), `per-owner budget enforced (got ${refused?.key})`);
  assert.equal(made, Math.floor(MAX_OWNER_TOTAL / MAX_BODY));
  assert.ok(ownerSize(state.notes, 'bob') <= MAX_OWNER_TOTAL && MAX_OWNER_TOTAL < MAX_TOTAL);
  // growing an existing page past the budget is refused too, shrinking is always allowed
  const bobPage = Object.values(state.notes.pages).find((p) => p.ownerId === 'bob')!;
  bobPage.body = bobPage.body.slice(10); // 10 characters of room left
  run(state, bob, 'notes/create', { scope: 'private', title: 'petite', body: 'abcde' }); // 5 left
  throwsKey(() => run(state, bob, 'notes/save', { id: bobPage.id, body: big, baseVersion: bobPage.version }), /Your personal notes are full/, 'growth past the budget');
  run(state, bob, 'notes/save', { id: bobPage.id, body: 'court', baseVersion: bobPage.version });
  // Alice still has room
  const a = run(state, alice, 'notes/create', { scope: 'private', title: 'A', body: 'y'.repeat(1000) });
  assert.ok(state.notes.pages[a.id]);
  // comments are part of the table budget
  const party = run(state, alice, 'notes/create', { scope: 'party', title: 'P' });
  const before = totalSize(state.notes);
  run(state, alice, 'notes/comment', { id: party.id, text: 'c'.repeat(500) });
  assert.equal(totalSize(state.notes), before + 500, 'comment text counted');
  // users/remove: Bob's private pages become unreachable → dropped at the next notes action
  delete state.users.bob;
  run(state, alice, 'notes/rename', { id: a.id, pinned: true });
  assert.equal(ownerSize(state.notes, 'bob'), 0, 'orphan private pages dropped');
  assert.ok(!Object.values(state.notes.pages).some((p) => p.ownerId === 'bob'));
  // GM private pages never count as orphans
  const gmUser: RunUser = { id: 'gm', role: 'gm', name: 'MJ' };
  const g = run(state, gmUser, 'notes/create', { scope: 'private', title: 'MJ' });
  run(state, alice, 'notes/rename', { id: a.id, pinned: false });
  assert.ok(state.notes.pages[g.id], 'GM page kept');
  // malformed users slice: nothing is dropped
  const keep = { notes: { pages: { p1: { scope: 'private', ownerId: 'zz', title: 't', body: '' } } } };
  ensureNotes(keep as unknown as TableState);
  assert.ok(keep.notes.pages.p1);
});

await test('[2] comments per author are capped across the table', () => {
  const state = { users: { u: { id: 'u' } }, log: [] } as unknown as TableState; // minimal fixture
  const u: RunUser = { id: 'u', role: 'player', name: 'U' };
  const pages: string[] = [];
  for (let i = 0; i < Math.ceil(MAX_USER_COMMENTS / 300) + 1; i++) pages.push(run(state, u, 'notes/create', { scope: 'party', title: `P${i}` }).id);
  let n = 0;
  let refused: FailError | null = null;
  outer: for (const id of pages)
    for (let k = 0; k < 300; k++) {
      try {
        run(state, u, 'notes/comment', { id, text: 'ok' });
        n++;
      } catch (e) {
        refused = e as FailError;
        if (/Trop de commentaires sur cette note/.test((e as FailError).key)) continue outer;
        break outer;
      }
    }
  assert.equal(n, MAX_USER_COMMENTS);
  assert.match(refused!.key, /You have too many comments/);
});

await test('[3] filter builds view.notes from the full state when the core did not clone it', () => {
  const now = Date.now();
  const full = {
    notes: {
      pages: {
        mine: { id: 'mine', scope: 'private', ownerId: 'u1', title: 'm', body: 'MINE' },
        other: { id: 'other', scope: 'private', ownerId: 'u2', title: 'o', body: 'SECRET-U2' },
        party: { id: 'party', scope: 'party', title: 'p', body: 'P', lock: { userId: 'u2', name: 'X', until: now - 5 } },
      },
      comments: { party: [{ id: 'c', text: 'hi' }], other: [{ id: 'd', text: 'SECRET-COMMENT' }] },
      settings: { gmCanEditParty: false },
    },
  };
  const view = {} as GameView; // a core that left `notes` out of its per-user deep clone
  (notesModule.filter as ViewFilter)(view, { id: 'u1', role: 'player' }, full as unknown as TableState);
  assert.deepEqual(Object.keys(view.notes.pages).sort(), ['mine', 'party']);
  assert.ok(!JSON.stringify(view).includes('SECRET'));
  assert.ok(!view.notes.pages.party.lock, 'expired lock not sent');
  assert.ok(full.notes.pages.party.lock, 'the live state is never mutated by a view');
  view.notes.pages.mine.body = 'changed';
  assert.equal(full.notes.pages.mine.body, 'MINE', 'readable pages are copies');
  const gv = {} as GameView;
  (notesModule.gmFilter as ViewFilter)(gv, { id: 'gm', role: 'gm' }, full as unknown as TableState);
  assert.deepEqual(Object.keys(gv.notes.pages), ['party'], 'unshared private pages never reach the GM');
});

await test('[4] the privacy copy no longer promises “only you” (« toi seul » in French)', () => {
  const dir = new URL('../client/modules/notes/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|jsx|ts|tsx)$/.test(f)) continue;
    assert.ok(!/only you\b|toi seul/i.test(fs.readFileSync(new URL(f, dir), 'utf8')), `${f} still says “only you”`);
  }
  const fr = fs.readFileSync(new URL('../client/i18n/fr/notes.json', import.meta.url), 'utf8');
  assert.ok(!/toi seul/.test(fr), 'fr/notes.json still says « toi seul »');
});

await test('[6] a repeated save error is toasted once, a new one again, and again after a success', () => {
  const g = errorGate();
  assert.equal(g.shouldToast('Espace plein'), true);
  assert.equal(g.shouldToast('Espace plein'), false, 'autosave retry: no second toast');
  assert.equal(g.shouldToast('Espace plein'), false);
  assert.equal(g.shouldToast('Note trop longue'), true, 'a different error is shown');
  g.reset();
  assert.equal(g.shouldToast('Note trop longue'), true, 'after a successful save the error is news again');
  assert.equal(g.last, 'Note trop longue');
});

await test('[7] a removed player keeps the name stored on their comment / lock', () => {
  const game = { users: { u1: { id: 'u1', name: 'Baptiste', characterIds: [] } }, actors: {} } as unknown as GameView; // minimal view
  assert.equal(storedName(game, 'u9', 'Ancien Joueur'), 'Ancien Joueur', 'stored author shown for an unknown id');
  assert.equal(storedName(game, 'u1', 'old'), 'Baptiste', 'live label for a known user');
  assert.equal(storedName(game, 'gm', 'x'), 'GM');
  assert.equal(storedName(game, 'u9', ''), 'Former player', 'no stored name: generic label');
});

await test('[7] checkboxes map to their own source line (quoted / indented fences)', () => {
  // renderMarkdown sees the fence inside the quote and ignores the indented « ``` »: the old scanner did the opposite,
  // the counts matched and checkbox 0 toggled the line hidden in the quoted code block.
  const body = '> ```\n> - [ ] hidden in quoted code\n> ```\n  ```\n- [ ] real\n  ```';
  const r = renderNote(body, { editable: true });
  assert.equal(r.checkboxes, 1);
  assert.equal(countCheckboxes(body), 1);
  assert.match(r.html, /<pre><code>- \[ \] hidden in quoted code<\/code><\/pre>/);
  const line = Number(/data-line="(\d+)"/.exec(r.html)![1]);
  assert.equal(line, 4);
  const toggled = toggleCheckboxAt(body, line);
  assert.equal(toggled, body.replace('- [ ] real', '- [x] real'));
  assert.equal(toggleCheckbox(body, 0), toggled, 'index-based toggle agrees');
  assert.equal(toggleCheckboxAt(body, 1), body, 'a line inside code is never toggled');
  assert.equal(toggleCheckboxAt(body, 0), body, 'a non-task line is never toggled');
  assert.equal(toggleCheckboxAt(body, 99), body);
  assert.ok(!/[]/.test(r.html), 'no marker leaks into the HTML');
  // a task rendered as plain text (indented quote) gets no checkbox; forged markers are ignored
  const odd = '  > - [ ] not a list\n- [ ] 0 ok';
  const r2 = renderNote(odd, { editable: true });
  assert.equal(r2.checkboxes, 1);
  assert.match(r2.html, /data-line="1"/);
  assert.ok(!/[]/.test(r2.html));
  // wiki links inside a quoted code block stay literal
  assert.deepEqual(wikiTitles('> ```\n> [[Code]]\n> ```\n[[Vrai]]'), ['Vrai']);
});

// ---------------------------------------------------------------------------
console.log('Server');
const srv = await startServer({ port: 3150 + Math.floor(Math.random() * 50) });
const clients: TestClient[] = [];
const track = (c: TestClient) => (clients.push(c), c);
try {
  const gm = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' })));
  const p1 = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur Un', characterId: 'pc_anthony' })));
  const p2 = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur Deux', characterId: 'pc_jane' })));
  // A second table created through the admin API, as tools/test-tables.ts does.
  const adm = await srv.admin();
  const cr = await fetch(srv.url + '/api/admin/tables', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adm}` },
    body: JSON.stringify({ name: 'Table Notes Deux', pack: 'vierge', lang: 'fr', gmPassword: 'deux-pass' }),
  });
  const crj = await cr.json();
  assert.equal(cr.status, 200, crj.error);
  const T2 = crj.table.id;
  const gmB = track(await client(srv.url, await login(srv.url, { role: 'gm', password: 'deux-pass', table: T2 }), { table: T2 }));
  const pB = track(await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur Un', table: T2 }), { table: T2 }));
  await settle();

  let privId: string;
  await test('private note: only the owner sees it (not the other player, not the GM, not the log)', async () => {
    const r = await p1.send('notes/create', { scope: 'private', title: 'Plan secret ZQX', body: 'SECRET-BODY-ZQX' });
    privId = r.id;
    await settle();
    const mine = p1.state.notes.pages[privId];
    assert.ok(mine && mine.ownerId === p1.state.me.id && mine.shareWithGM === false && mine.version === 1);
    for (const c of [p2, gm, gmB, pB]) assert.ok(!leaks(c, 'ZQX'), 'private note leaked');
    assert.ok(!p1.state.log.some((e) => JSON.stringify(e).includes('ZQX')), 'private actions never log');
  });

  await test('another player and the GM cannot touch a private note (answer “Note not found”)', async () => {
    await rejects(p2.send('notes/save', { id: privId, body: 'pwned', baseVersion: 1 }), /Note not found/, 'p2 save');
    await rejects(p2.send('notes/rename', { id: privId, title: 'x' }), /Note not found/, 'p2 rename');
    await rejects(p2.send('notes/setShare', { id: privId, shareWithGM: true }), /Note not found/, 'p2 share');
    await rejects(p2.send('notes/delete', { id: privId }), /Note not found/, 'p2 delete');
    await rejects(p2.send('notes/comment', { id: privId, text: 'coucou' }), /Note not found/, 'p2 comment');
    await rejects(p2.send('notes/lock', { id: privId }), /Note not found/, 'p2 lock');
    await rejects(gm.send('notes/save', { id: privId, body: 'gm', baseVersion: 1 }), /Note not found/, 'gm save unshared');
    await rejects(pB.send('notes/save', { id: privId, body: 'x', baseVersion: 1 }), /Note not found/, 'other table');
    await rejects(p1.send('notes/comment', { id: privId, text: 'moi' }), /You cannot comment on this note/, 'no comments while not shared');
  });

  await test('shareWithGM: the GM sees it read-only and may comment; unshare hides it again', async () => {
    await rejects(gm.send('notes/setShare', { id: privId, shareWithGM: true }), /Note not found/, 'gm cannot share');
    await p1.send('notes/setShare', { id: privId, shareWithGM: true });
    await settle();
    assert.equal(gm.state.notes.pages[privId]?.body, 'SECRET-BODY-ZQX');
    assert.ok(!leaks(p2, 'ZQX'), 'still hidden from p2');
    await rejects(gm.send('notes/save', { id: privId, body: 'gm edit', baseVersion: 1 }), /read-only/, 'gm read-only');
    await rejects(gm.send('notes/setShare', { id: privId, shareWithGM: false }), /Only the author/, 'gm cannot unshare');
    await gm.send('notes/comment', { id: privId, text: 'Commentaire MJ KWP' });
    await settle();
    assert.equal(p1.state.notes.comments[privId].length, 1);
    assert.ok(p1.events.some((e) => e.ev === 'notes:comment' && e.data.pageId === privId), 'owner notified');
    assert.ok(!leaks(p2, 'KWP') && !p2.events.some((e) => e.ev === 'notes:comment'), 'comment hidden from p2');
    await p1.send('notes/setShare', { id: privId, shareWithGM: false });
    await settle();
    assert.ok(!leaks(gm, 'ZQX') && !leaks(gm, 'KWP'), 'GM no longer sees it');
    assert.equal(p1.state.notes.comments[privId].length, 1, 'owner keeps the comments');
    await p1.send('notes/deleteComment', { id: privId, commentId: p1.state.notes.comments[privId][0].id });
  });

  let partyId: string;
  await test('party note: every player and the GM of the table see it, the other table does not; creation is logged', async () => {
    const r = await p1.send('notes/create', { scope: 'party', title: 'Pistes du groupe PLM', folder: 'Enquête' });
    partyId = r.id;
    await settle();
    for (const c of [p1, p2, gm]) assert.equal(c.state.notes.pages[partyId]?.title, 'Pistes du groupe PLM');
    for (const c of [gmB, pB]) assert.ok(!leaks(c, 'PLM') && pagesOf(c).length === 0, 'cross-table leak');
    const log = p2.state.log.find((e) => e.i18n?.key === 'New party note: {title}');
    assert.ok(log && log.i18n!.params!.title === 'Pistes du groupe PLM' && log.kind === 'system');
    assert.equal(p2.state.notes.pages[partyId].folder, 'Enquête');
    // and the other way round
    const rb = await pB.send('notes/create', { scope: 'party', title: 'Autre table VVB' });
    await settle();
    assert.ok(gmB.state.notes.pages[rb.id] && !leaks(p1, 'VVB') && !leaks(gm, 'VVB'));
  });

  await test('GM is a reader of party notes unless the setting allows editing', async () => {
    await rejects(gm.send('notes/save', { id: partyId, body: 'MJ', baseVersion: 1 }), /The GM cannot edit party notes/, 'gm save');
    await rejects(gm.send('notes/create', { scope: 'party', title: 'x' }), /The GM cannot edit party notes/, 'gm create party');
    await rejects(p1.send('notes/settings', { gmCanEditParty: true }), /GM-only action/, 'player settings');
    await gm.send('notes/settings', { gmCanEditParty: true });
    const r = await gm.send('notes/save', { id: partyId, body: 'Le MJ ajoute une piste', baseVersion: 1 });
    assert.equal(r.version, 2);
    await gm.send('notes/settings', { gmCanEditParty: false });
    await settle();
    assert.equal(p2.state.notes.pages[partyId].body, 'Le MJ ajoute une piste');
    assert.equal(p2.state.notes.settings.gmCanEditParty, false);
  });

  await test('optimistic version check: stale save returns the server copy', async () => {
    const a = await p1.send('notes/save', { id: partyId, body: 'version de p1', baseVersion: 2 });
    assert.equal(a.version, 3);
    const b = await p2.send('notes/save', { id: partyId, body: 'version de p2', baseVersion: 2 });
    assert.equal(b.conflict, true);
    assert.equal(b.server.body, 'version de p1');
    assert.equal(b.server.version, 3);
    assert.equal(b.server.updatedBy, p1.state.me.id);
    const t = await p2.send('notes/save', { id: partyId, title: 'Pistes (titre p2)', body: 'version de p1', baseVersion: 2 });
    assert.ok(!t.conflict && t.version === 3, 'title-only save with an old base is not a conflict');
    const c = await p2.send('notes/save', { id: partyId, body: 'version de p2', baseVersion: 3 });
    assert.equal(c.version, 4);
    await rejects(p2.send('notes/save', { id: partyId, body: 'sans base' }), /Missing base version/, 'baseVersion required');
    await settle();
    assert.equal(p1.state.notes.pages[partyId].title, 'Pistes (titre p2)');
  });

  await test('soft lock lifecycle', async () => {
    const l1 = await p1.send('notes/lock', { id: partyId });
    assert.equal(l1.locked, false);
    await settle();
    const seen = p2.state.notes.pages[partyId].lock;
    assert.ok(seen && seen.userId === p1.state.me.id && seen.name === 'Anthony Von Schloss' && seen.until > Date.now());
    const l2 = await p2.send('notes/lock', { id: partyId });
    assert.equal(l2.locked, true);
    assert.equal(l2.lock.name, 'Anthony Von Schloss');
    const l3 = await p2.send('notes/lock', { id: partyId, force: true });
    assert.equal(l3.locked, false);
    await p1.send('notes/unlock', { id: partyId }); // not the holder any more: no effect
    await settle();
    assert.equal(p1.state.notes.pages[partyId].lock!.userId, p2.state.me.id);
    await p2.send('notes/unlock', { id: partyId });
    await settle();
    assert.ok(!p1.state.notes.pages[partyId].lock);
    assert.deepEqual(await p1.send('notes/lock', { id: privId }), { locked: false, until: null }, 'no lock on private notes');
    await rejects(gm.send('notes/lock', { id: partyId }), /The GM cannot edit party notes/, 'GM reader cannot lock');
  });

  await test('delete goes to the trash, restore, purge permissions', async () => {
    await p2.send('notes/delete', { id: partyId });
    await settle();
    assert.ok(p1.state.notes.pages[partyId].deleted?.by === p2.state.me.id);
    await rejects(p1.send('notes/save', { id: partyId, body: 'x', baseVersion: 4 }), /in the trash/, 'no edit in trash');
    await rejects(p1.send('notes/comment', { id: partyId, text: 'x' }), /in the trash/, 'no comment in trash');
    await p1.send('notes/restore', { id: partyId });
    await settle();
    assert.ok(!p2.state.notes.pages[partyId].deleted);
    await rejects(gm.send('notes/purge', { id: partyId }), /Move the note to the trash first/, 'purge needs the trash');
    await p2.send('notes/delete', { id: partyId });
    await rejects(p2.send('notes/purge', { id: partyId }), /Only the note’s author or the GM/, 'purge by a non-creator player');
    await gm.send('notes/restore', { id: partyId });
    // private: only the owner
    await p1.send('notes/delete', { id: privId });
    await settle();
    assert.ok(!leaks(p2, 'ZQX') && !leaks(gm, 'ZQX'), 'private trash stays private');
    await rejects(p2.send('notes/restore', { id: privId }), /Note not found/, 'p2 restore private');
    await p1.send('notes/restore', { id: privId });
    // creator purge
    const tmp = await p2.send('notes/create', { scope: 'party', title: 'Brouillon' });
    await p1.send('notes/delete', { id: tmp.id });
    await p2.send('notes/purge', { id: tmp.id });
    await settle();
    assert.ok(!p1.state.notes.pages[tmp.id]);
  });

  await test('comments on party notes', async () => {
    const before = p1.events.length;
    const c = await p2.send('notes/comment', { id: partyId, text: '  Bonne idée  ' });
    await settle();
    const list = gm.state.notes.comments[partyId];
    assert.equal(list.length, 1);
    assert.equal(list[0].text, 'Bonne idée');
    assert.equal(list[0].author, 'Jane');
    assert.ok(p1.events.slice(before).some((e) => e.ev === 'notes:comment'), 'other reader notified');
    assert.ok(!pB.events.some((e) => e.ev === 'notes:comment') && !gmB.events.some((e) => e.ev === 'notes:comment'), 'no event to the other table');
    await rejects(p1.send('notes/comment', { id: partyId, text: '   ' }), /Empty comment/, 'empty comment');
    await rejects(p1.send('notes/deleteComment', { id: partyId, commentId: c.commentId }), /You cannot delete this comment/, 'not the author');
    await rejects(p1.send('notes/deleteComment', { id: partyId, commentId: 'nope' }), /Comment not found/, 'unknown comment');
    const long = await p1.send('notes/comment', { id: partyId, text: 'y'.repeat(5000) });
    await settle();
    assert.equal(p1.state.notes.comments[partyId].find((x) => x.id === long.commentId)!.text.length, 2000);
    await gm.send('notes/deleteComment', { id: partyId, commentId: c.commentId });
    await p1.send('notes/deleteComment', { id: partyId, commentId: long.commentId });
    await settle();
    assert.ok(!p2.state.notes.comments[partyId]);
  });

  await test('payload validation', async () => {
    await rejects(p1.send('notes/save', { id: partyId, body: 'x'.repeat(MAX_BODY + 1), baseVersion: 4 }), /Note too long/, 'huge body');
    await rejects(p1.send('notes/create', { scope: 'private', title: 'x', body: 'x'.repeat(MAX_BODY + 1) }), /Note too long/, 'huge body on create');
    await rejects(p1.send('notes/save', { id: partyId, body: { evil: true }, baseVersion: 4 }), /Invalid note content/, 'object body');
    await rejects(p1.send('notes/create', { scope: 'public', title: 'x' }), /Unknown note type/, 'bad scope');
    await rejects(p1.send('notes/create', {}), /Unknown note type/, 'no scope');
    for (const id of ['__proto__', 'constructor', 'toString', 123, null, '../x', 'x'.repeat(200), { a: 1 }, ['note']]) {
      await rejects(p1.send('notes/save', { id, body: 'x', baseVersion: 1 }), /Note not found/, `bad id ${JSON.stringify(id)}`);
      await rejects(p1.send('notes/delete', { id }), /Note not found/, `bad id ${JSON.stringify(id)} (delete)`);
    }
    await rejects(p1.send('notes/rename', { id: partyId, title: '   ' }), /title cannot be empty/, 'empty title');
    const r = await p1.send('notes/create', { scope: 'private', title: 'T'.repeat(500), folder: 'F'.repeat(500), body: 'a\u0000b\u0007c\nd' });
    await settle();
    const page = p1.state.notes.pages[r.id];
    assert.equal(page.title.length, 120);
    assert.equal(page.folder.length, 60);
    assert.equal(page.body, 'abc\nd', 'control characters stripped');
    const blank = await p1.send('notes/create', { scope: 'private', title: '' });
    await settle();
    assert.equal(p1.state.notes.pages[blank.id].title, 'Nouvelle note', 'default title stored in the table language (French table)');
    await p1.send('notes/rename', { id: r.id, pinned: true, folder: 'Contacts' });
    await settle();
    assert.ok(p1.state.notes.pages[r.id].pinned && p1.state.notes.pages[r.id].folder === 'Contacts');
  });

  await test('[5] a party page someone else is typing in is not trashed without force', async () => {
    const r = await p1.send('notes/create', { scope: 'party', title: 'En cours de frappe' });
    await settle();
    await p1.send('notes/lock', { id: r.id });
    await rejects(p2.send('notes/delete', { id: r.id }), /Anthony Von Schloss is typing in this note/, 'delete under a live foreign lock');
    await rejects(gm.send('notes/delete', { id: r.id }), /is typing in this note/, 'GM moderation too');
    await settle();
    assert.ok(!p1.state.notes.pages[r.id].deleted, 'still live');
    await p1.send('notes/delete', { id: r.id }); // my own lock never blocks me
    await p1.send('notes/restore', { id: r.id });
    await p1.send('notes/lock', { id: r.id });
    await p2.send('notes/delete', { id: r.id, force: true });
    await settle();
    assert.equal(p1.state.notes.pages[r.id].deleted?.by, p2.state.me.id, 'force trashes it');
    assert.ok(!p1.state.notes.pages[r.id].lock, 'and drops the lock');
  });

  await test('GM private notes stay private to the GM', async () => {
    const r = await gm.send('notes/create', { scope: 'private', title: 'Notes MJ HHG' });
    await settle();
    assert.ok(gm.state.notes.pages[r.id]);
    assert.ok(!leaks(p1, 'HHG') && !leaks(p2, 'HHG'));
  });
} finally {
  for (const c of clients) c.close();
  srv.stop();
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
