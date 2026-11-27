// Notes: a private note space per user and a collaborative party space (players + GM), markdown pages.
// See ARCHITECTURE.md « Notes ».
//
// Privacy rules (enforced here, in filter() / gmFilter() and in every action):
//   private page  → only its owner reads/writes it; the GM reads it (read-only, may comment) while shareWithGM is on;
//                   other players never receive it (view, events, log). Unknown/unreadable ids all answer « Note introuvable ».
//   party page    → every user of the table reads it; players write it; the GM writes it only with settings.gmCanEditParty.
// Concurrency: `version` counts BODY changes; notes/save carries baseVersion and returns { conflict, server } when stale.
// Titles, folders and pins are last-write-wins. Soft edit lock on party pages (60 s, renewed by the client).
import type { ActionContext, GameView, NoteComment, NotePage, NotesState, NotesView, SessionUser, ServerModule, TableState, UserId } from '../../shared/types.ts';

/** The user fields the permission checks read. */
type NoteUser = Pick<SessionUser, 'id' | 'role'>;

export const MAX_BODY = 100_000; // characters per page
export const MAX_TITLE = 120;
export const MAX_FOLDER = 60;
export const MAX_COMMENT = 2000;
export const MAX_COMMENTS = 300; // per page
export const MAX_USER_COMMENTS = 1000; // per author, whole table
export const MAX_PRIVATE_PAGES = 300; // per owner (trash included)
export const MAX_PARTY_PAGES = 500; // per table (trash included)
// Size budgets. Every view carries the bodies a user can read, so they stay modest (see ARCHITECTURE « Notes »).
export const MAX_OWNER_TOTAL = 1_000_000; // characters of private bodies per owner (trash included): one user can never fill the table
export const MAX_TOTAL = 5_000_000; // characters of bodies + comments per table
export const LOCK_MS = 60_000;
export const TRASH_MS = 7 * 24 * 3600 * 1000;

const ID_RE = /^[\w-]{1,64}$/;
const validId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
const has = (o: object | null | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
// Control characters (except tab/newline/CR) never belong in a note.
const clean = (s: unknown): string => str(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const oneLine = (s: unknown, max: number): string => clean(s).replace(/\s+/g, ' ').trim().slice(0, max);

export function ensureNotes(state: TableState): NotesState {
  const n = state.notes && typeof state.notes === 'object' && !Array.isArray(state.notes) ? state.notes : ({} as NotesState);
  state.notes = n;
  if (!n.pages || typeof n.pages !== 'object' || Array.isArray(n.pages)) n.pages = {};
  if (!n.comments || typeof n.comments !== 'object' || Array.isArray(n.comments)) n.comments = {};
  if (!n.settings || typeof n.settings !== 'object') n.settings = {} as NotesState['settings'];
  n.settings.gmCanEditParty = !!n.settings.gmCanEditParty;
  for (const [id, p] of Object.entries(n.pages)) {
    if (!validId(id) || !p || typeof p !== 'object' || (p.scope !== 'private' && p.scope !== 'party') || (p.scope === 'private' && !p.ownerId)) {
      delete n.pages[id];
      delete n.comments[id];
      continue;
    }
    p.id = id;
    p.title = typeof p.title === 'string' ? p.title : '';
    p.body = typeof p.body === 'string' ? p.body : '';
    p.version = Number.isInteger(p.version) && p.version > 0 ? p.version : 1;
    if (p.scope === 'party') delete p.shareWithGM;
    else p.shareWithGM = !!p.shareWithGM;
  }
  for (const id of Object.keys(n.comments)) if (!has(n.pages, id) || !Array.isArray(n.comments[id])) delete n.comments[id];
  dropOrphans(state, n);
  return n;
}

/**
 * Private pages of a removed player (users/remove) can never be read or freed again by anyone: drop them with
 * their comments so they stop counting against the table budget. The GM's own pages (ownerId 'gm') always stay.
 */
export function dropOrphans(state: Pick<TableState, 'users'> | null | undefined, notes: NotesState): void {
  const users = state?.users;
  if (!users || typeof users !== 'object' || Array.isArray(users)) return; // never guess on a malformed slice
  for (const [id, p] of Object.entries(notes.pages)) {
    if (p.scope !== 'private' || p.ownerId === 'gm' || has(users, p.ownerId as string)) continue;
    delete notes.pages[id];
    delete notes.comments[id];
  }
}

/** Remove trash older than 7 days and expired locks (mutates). */
export function housekeep(notes: NotesState, now = Date.now()): void {
  for (const [id, p] of Object.entries(notes.pages)) {
    if (p.deleted && now - (p.deleted.at || 0) > TRASH_MS) {
      delete notes.pages[id];
      delete notes.comments[id];
      continue;
    }
    if (p.lock && !(p.lock.until > now)) delete p.lock;
  }
}

/** Can this user see the page at all? */
export function canRead(page: NotePage | null | undefined, user: NoteUser): boolean {
  if (!page) return false;
  if (page.scope === 'party') return true;
  if (page.ownerId === user.id) return true;
  return user.role === 'gm' && !!page.shareWithGM;
}

/** Can this user change title/body/folder/pin of the page? */
export function canWrite(page: NotePage | null | undefined, user: NoteUser, notes?: NotesState | null): boolean {
  if (!page) return false;
  if (page.scope === 'private') return page.ownerId === user.id;
  if (user.role === 'gm') return !!notes?.settings?.gmCanEditParty;
  return true;
}

/** Comments: party pages (everyone), private pages shared with the GM (owner + GM). */
export function canComment(page: NotePage | null | undefined, user: NoteUser): boolean {
  if (!page) return false;
  if (page.scope === 'party') return true;
  return !!page.shareWithGM && (page.ownerId === user.id || user.role === 'gm');
}

/** Who may receive transient events about a page (user ids, 'gm' included when allowed). */
function audience(state: TableState, page: NotePage): UserId[] {
  if (page.scope === 'party') return [...Object.keys(state.users || {}), 'gm'];
  const ids = [page.ownerId as UserId];
  if (page.shareWithGM) ids.push('gm');
  return ids;
}

/** Characters stored for the table: every body plus every comment. */
export function totalSize(notes: NotesState): number {
  let n = 0;
  for (const p of Object.values(notes.pages)) n += (p.body || '').length;
  for (const list of Object.values(notes.comments)) if (Array.isArray(list)) for (const c of list) n += (c?.text || '').length;
  return n;
}

/** Characters of private bodies owned by one user (trash included). */
export function ownerSize(notes: NotesState, ownerId: UserId | undefined): number {
  let n = 0;
  for (const p of Object.values(notes.pages)) if (p.scope === 'private' && p.ownerId === ownerId) n += (p.body || '').length;
  return n;
}

/**
 * Build `view.notes` with only what `user` may read. Uses `view.notes` when the core already cloned the slice,
 * else reads `fullState.notes` and clones only the readable pages (so a core that leaves `notes` out of its
 * per-user deep clone pays for each user's readable pages only).
 */
function filterView(view: GameView, user: NoteUser, fullState?: TableState | null): void {
  const cloned = !!view.notes && typeof view.notes === 'object';
  const src: NotesState | undefined = cloned ? view.notes : fullState?.notes;
  if (!src || typeof src !== 'object') {
    delete (view as Partial<GameView>).notes;
    return;
  }
  const copy = cloned ? <T>(v: T): T => v : <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const now = Date.now();
  const pages: Record<string, NotePage> = {};
  const comments: Record<string, NoteComment[]> = {};
  for (const [id, p] of Object.entries(src.pages || {})) {
    if (!p || !canRead(p, user)) continue;
    if (p.deleted && now - (p.deleted.at || 0) > TRASH_MS) continue;
    const page = copy(p);
    if (page.lock && !(page.lock.until > now)) delete page.lock;
    pages[id] = page;
    if (Array.isArray(src.comments?.[id])) comments[id] = copy(src.comments[id]);
  }
  view.notes = { pages, comments, settings: { gmCanEditParty: !!src.settings?.gmCanEditParty }, now } satisfies NotesView;
}

const FULL = 'Note storage full: delete some notes before creating more';
const OWNER_FULL = 'Your personal notes are full ({max} characters): delete some before writing more';

// Action payloads (players send them: every field is checked by the handlers).
interface CreatePayload {
  scope?: 'private' | 'party';
  title?: string;
  folder?: string;
  body?: string;
}
interface SavePayload {
  id?: string;
  body?: string;
  title?: string;
  baseVersion?: number;
}
interface RenamePayload {
  id?: string;
  title?: string;
  folder?: string;
  pinned?: boolean;
}
interface PagePayload {
  id?: string;
  /** delete / lock: take over someone else's live lock. */
  force?: boolean;
}
interface SharePayload {
  id?: string;
  shareWithGM?: boolean;
}
interface CommentPayload {
  id?: string;
  text?: string;
}
interface DeleteCommentPayload {
  id?: string;
  commentId?: string;
}
interface SettingsPayload {
  gmCanEditParty?: boolean;
}

const mod: ServerModule = {
  name: 'notes',

  init(state) {
    housekeep(ensureNotes(state));
  },

  actions: {
    // { scope: 'private'|'party', title, folder?, body? } → { id }
    'notes/create': {
      role: 'any',
      handler(ctx: ActionContext, payload: CreatePayload) {
        const notes = start(ctx);
        const scope = payload?.scope;
        if (scope !== 'private' && scope !== 'party') ctx.fail('Unknown note type');
        const pages = Object.values(notes.pages);
        if (scope === 'private' && pages.filter((p) => p.scope === 'private' && p.ownerId === ctx.user.id).length >= MAX_PRIVATE_PAGES)
          ctx.fail('Too many personal notes ({max} maximum)', { max: MAX_PRIVATE_PAGES });
        if (scope === 'party' && pages.filter((p) => p.scope === 'party').length >= MAX_PARTY_PAGES) ctx.fail('Too many party notes ({max} maximum)', { max: MAX_PARTY_PAGES });
        if (scope === 'party' && ctx.isGM && !notes.settings.gmCanEditParty) ctx.fail('The GM cannot edit party notes');
        const body = checkBody(ctx, payload?.body ?? '');
        if (scope === 'private' && ownerSize(notes, ctx.user.id) + body.length > MAX_OWNER_TOTAL) ctx.fail(OWNER_FULL, { max: MAX_OWNER_TOTAL });
        if (totalSize(notes) + body.length > MAX_TOTAL) ctx.fail(FULL);
        const title = oneLine(payload?.title, MAX_TITLE) || ctx.t('New note');
        const id = ctx.uid('note');
        const page: NotePage = {
          id, scope: scope as NotePage['scope'], title, body, folder: oneLine(payload?.folder, MAX_FOLDER), pinned: false,
          createdBy: ctx.user.id, updatedBy: ctx.user.id, createdAt: ctx.now, updatedAt: ctx.now, version: 1,
        };
        if (scope === 'private') Object.assign(page, { ownerId: ctx.user.id, shareWithGM: false });
        notes.pages[id] = page;
        if (scope === 'party') ctx.log({ kind: 'system', userId: ctx.user.id, author: ctx.displayName(), i18n: { key: 'New party note: {title}', params: { title } } });
        return { id };
      },
    },

    // { id, body?, title?, baseVersion } → { version, updatedAt } | { conflict: true, server: { title, body, version, updatedBy, updatedAt } }
    'notes/save': {
      role: 'any',
      handler(ctx: ActionContext, payload: SavePayload) {
        const notes = start(ctx);
        const page = writable(ctx, notes, payload?.id);
        const body = payload?.body === undefined ? page.body : checkBody(ctx, payload.body);
        const title = payload?.title === undefined ? page.title : oneLine(payload.title, MAX_TITLE) || page.title;
        let changed = false;
        if (body !== page.body) {
          if (!Number.isInteger(payload?.baseVersion)) ctx.fail('Missing base version');
          if (payload.baseVersion !== page.version) {
            return { conflict: true, server: { title: page.title, body: page.body, version: page.version, updatedBy: page.updatedBy, updatedAt: page.updatedAt } };
          }
          const delta = body.length - page.body.length;
          if (delta > 0 && page.scope === 'private' && ownerSize(notes, page.ownerId) + delta > MAX_OWNER_TOTAL) ctx.fail(OWNER_FULL, { max: MAX_OWNER_TOTAL });
          if (delta > 0 && totalSize(notes) + delta > MAX_TOTAL) ctx.fail(FULL);
          page.body = body;
          page.version += 1;
          changed = true;
        }
        if (title !== page.title) {
          page.title = title;
          changed = true;
        }
        if (page.lock?.userId === ctx.user.id) page.lock.until = ctx.now + LOCK_MS;
        if (changed) {
          page.updatedBy = ctx.user.id;
          page.updatedAt = ctx.now;
        }
        return { version: page.version, updatedAt: page.updatedAt };
      },
    },

    // { id, title?, folder?, pinned? } — last write wins, version unchanged.
    'notes/rename': {
      role: 'any',
      handler(ctx: ActionContext, payload: RenamePayload) {
        const notes = start(ctx);
        const page = writable(ctx, notes, payload?.id);
        if (payload?.title !== undefined) {
          const title = oneLine(payload.title, MAX_TITLE);
          if (!title) ctx.fail('The title cannot be empty');
          page.title = title;
        }
        if (payload?.folder !== undefined) page.folder = oneLine(payload.folder, MAX_FOLDER);
        if (payload?.pinned !== undefined) page.pinned = !!payload.pinned;
        page.updatedAt = ctx.now;
        return { ok: true };
      },
    },

    // { id, force? } → soft delete (trash, restorable 7 days). Private: owner. Party: any player, or the GM.
    // A party page someone else is typing in (live lock) needs force: their unsaved text would be cut off.
    'notes/delete': {
      role: 'any',
      handler(ctx: ActionContext, payload: PagePayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id);
        if (!canDelete(page, ctx.user)) ctx.fail('You cannot delete this note');
        const lk = page.lock;
        if (lk && lk.userId !== ctx.user.id && lk.until > ctx.now && !payload.force) ctx.fail('{name} is typing in this note', { name: String(lk.name || '') });
        if (!page.deleted) page.deleted = { at: ctx.now, by: ctx.user.id };
        delete page.lock;
        return { ok: true };
      },
    },

    // { id } → back from the trash.
    'notes/restore': {
      role: 'any',
      handler(ctx: ActionContext, payload: PagePayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id, { trash: true });
        if (!canDelete(page, ctx.user)) ctx.fail('You cannot restore this note');
        delete page.deleted;
        page.updatedAt = ctx.now;
        return { ok: true };
      },
    },

    // { id } → permanent removal of a page already in the trash. Private: owner. Party: its creator or the GM.
    'notes/purge': {
      role: 'any',
      handler(ctx: ActionContext, payload: PagePayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id, { trash: true });
        if (!page.deleted) ctx.fail('Move the note to the trash first');
        const ok = page.scope === 'private' ? page.ownerId === ctx.user.id : ctx.isGM || page.createdBy === ctx.user.id;
        if (!ok) ctx.fail('Only the note’s author or the GM can delete it permanently');
        delete notes.pages[page.id];
        delete notes.comments[page.id];
        return { ok: true };
      },
    },

    // { id, shareWithGM } — owner of a private page only.
    'notes/setShare': {
      role: 'any',
      handler(ctx: ActionContext, payload: SharePayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id, { trash: true });
        if (page.scope !== 'private' || page.ownerId !== ctx.user.id) ctx.fail('Only the author of a personal note can share it');
        page.shareWithGM = !!payload.shareWithGM;
        return { shareWithGM: page.shareWithGM };
      },
    },

    // { id, force? } → { locked: false, until } (lock is mine) | { locked: true, lock } (held by someone else; force takes it over).
    'notes/lock': {
      role: 'any',
      handler(ctx: ActionContext, payload: PagePayload) {
        const notes = start(ctx);
        const page = writable(ctx, notes, payload?.id);
        if (page.scope !== 'party') return { locked: false, until: null };
        const cur = page.lock;
        if (cur && cur.userId !== ctx.user.id && cur.until > ctx.now && !payload.force) return { locked: true, lock: { ...cur } };
        page.lock = { userId: ctx.user.id, name: ctx.displayName(), until: ctx.now + LOCK_MS };
        return { locked: false, until: page.lock.until };
      },
    },

    // { id } → release my lock (an expired lock is cleared by anyone).
    'notes/unlock': {
      role: 'any',
      handler(ctx: ActionContext, payload: PagePayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id, { trash: true });
        if (page.lock && (page.lock.userId === ctx.user.id || !(page.lock.until > ctx.now))) delete page.lock;
        return { ok: true };
      },
    },

    // { id, text } → { commentId }
    'notes/comment': {
      role: 'any',
      handler(ctx: ActionContext, payload: CommentPayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id);
        if (!canComment(page, ctx.user)) ctx.fail('You cannot comment on this note');
        const text = clean(payload?.text).trim().slice(0, MAX_COMMENT);
        if (!text) ctx.fail('Empty comment');
        const list = Array.isArray(notes.comments[page.id]) ? notes.comments[page.id] : [];
        if (list.length >= MAX_COMMENTS) ctx.fail('Too many comments on this note ({max} maximum)', { max: MAX_COMMENTS });
        let mineCount = 0;
        for (const l of Object.values(notes.comments)) if (Array.isArray(l)) for (const x of l) if (x?.userId === ctx.user.id) mineCount++;
        if (mineCount >= MAX_USER_COMMENTS) ctx.fail('You have too many comments ({max} maximum): delete some before writing more', { max: MAX_USER_COMMENTS });
        if (totalSize(notes) + text.length > MAX_TOTAL) ctx.fail(FULL);
        notes.comments[page.id] = list;
        const c: NoteComment = { id: ctx.uid('ncom'), userId: ctx.user.id, author: ctx.displayName(), text, ts: ctx.now };
        list.push(c);
        // Transient heads-up for the other readers (never to someone who cannot read the page).
        const others = audience(ctx.state, page).filter((id) => id !== ctx.user.id);
        if (others.length) ctx.emitTo(others, 'notes:comment', { pageId: page.id, title: page.title, author: c.author });
        return { commentId: c.id };
      },
    },

    // { id, commentId } — the comment's author, the GM, or the owner of the (private) page.
    'notes/deleteComment': {
      role: 'any',
      handler(ctx: ActionContext, payload: DeleteCommentPayload) {
        const notes = start(ctx);
        const page = readable(ctx, notes, payload?.id, { trash: true });
        const list = Array.isArray(notes.comments[page.id]) ? notes.comments[page.id] : [];
        const i = typeof payload?.commentId === 'string' ? list.findIndex((c) => c.id === payload.commentId) : -1;
        if (i < 0) ctx.fail('Comment not found');
        const c = list[i];
        if (!(c.userId === ctx.user.id || ctx.isGM || (page.scope === 'private' && page.ownerId === ctx.user.id))) ctx.fail('You cannot delete this comment');
        list.splice(i, 1);
        if (!list.length) delete notes.comments[page.id];
        return { ok: true };
      },
    },

    // GM: { gmCanEditParty }
    'notes/settings': {
      role: 'gm',
      handler(ctx: ActionContext, payload: SettingsPayload) {
        const notes = start(ctx);
        if (payload?.gmCanEditParty !== undefined) notes.settings.gmCanEditParty = !!payload.gmCanEditParty;
        return { ...notes.settings };
      },
    },
  },

  filter(view, user, fullState) {
    filterView(view, user, fullState);
  },

  gmFilter(view, user, fullState) {
    filterView(view, user, fullState);
  },
};

// ---------------------------------------------------------------------------
// Helpers bound to an action context
// ---------------------------------------------------------------------------
function start(ctx: ActionContext): NotesState {
  const notes = ensureNotes(ctx.state);
  housekeep(notes, ctx.now);
  return notes;
}

function checkBody(ctx: ActionContext, body: unknown): string {
  if (typeof body !== 'string') return ctx.fail('Invalid note content');
  if (body.length > MAX_BODY) ctx.fail('Note too long ({max} characters maximum)', { max: MAX_BODY });
  return clean(body);
}

/** The page if this user may read it (not in the trash unless opts.trash), else « Note introuvable » (never reveals existence). */
function readable(ctx: ActionContext, notes: NotesState, id: unknown, { trash = false }: { trash?: boolean } = {}): NotePage {
  if (!validId(id) || !has(notes.pages, id)) return ctx.fail('Note not found');
  const page = notes.pages[id];
  if (!canRead(page, ctx.user)) ctx.fail('Note not found');
  if (page.deleted && !trash) ctx.fail('This note is in the trash');
  return page;
}

function writable(ctx: ActionContext, notes: NotesState, id: unknown): NotePage {
  const page = readable(ctx, notes, id);
  if (!canWrite(page, ctx.user, notes)) {
    if (page.scope === 'party') ctx.fail('The GM cannot edit party notes');
    ctx.fail('This note is read-only');
  }
  return page;
}

function canDelete(page: NotePage, user: NoteUser): boolean {
  if (page.scope === 'private') return page.ownerId === user.id;
  return true; // party: any player, and the GM (moderation)
}

export default mod;
