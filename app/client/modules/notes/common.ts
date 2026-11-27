// Notes UI helpers: permissions (mirror of server/modules/75-notes.js), names, sorting.
import { t, compare } from '../../lib/i18n.ts';
import type { GameView, NotePage, UserId } from '../../../shared/types.ts';

/** A page's soft edit lock (party pages). */
export type NoteLock = NonNullable<NotePage['lock']>;

export const cx = (...c: unknown[]): string => c.filter(Boolean).join(' ');
export const LOCK_MS = 60_000;
export const TRASH_MS = 7 * 24 * 3600 * 1000;
export const MAX_BODY = 100_000;

export const isGM = (game: GameView): boolean => game.me.role === 'gm';

export function canWrite(game: GameView, page: NotePage | null | undefined): boolean {
  if (!page || page.deleted) return false;
  if (page.scope === 'private') return page.ownerId === game.me.id;
  if (isGM(game)) return !!game.notes?.settings?.gmCanEditParty;
  return true;
}

export function canComment(game: GameView, page: NotePage | null | undefined): boolean {
  if (!page || page.deleted) return false;
  if (page.scope === 'party') return true;
  return !!page.shareWithGM && (page.ownerId === game.me.id || isGM(game));
}

/** Display name of a user id: the GM, the user's main character, else the user's name. */
export function userLabel(game: GameView, userId: UserId | null | undefined): string {
  if (!userId) return '';
  if (userId === 'gm') return t('GM');
  const u = game.users?.[userId];
  if (!u) return t('Former player');
  const a = game.actors?.[(u.characterIds || [])[0]];
  return a?.name || u.name;
}

/** Is this user id still known to the table (the GM always is)? */
export const knownUser = (game: GameView, userId: UserId | null | undefined): boolean => userId === 'gm' || !!(userId && game.users?.[userId]);

/** Name shown for a comment / lock: the live label, else the name stored when it was written (removed player). */
export function storedName(game: GameView, userId: UserId | null | undefined, stored: string | null | undefined): string {
  return knownUser(game, userId) || !stored ? userLabel(game, userId) : stored;
}

/**
 * What to do with a selected page id that is missing from the view.
 *   pending = { id, until } for a page we just created (the action reply comes before the state broadcast).
 * → 'keep' (it is there), { wait: ms } (just created, not broadcast yet), 'clear' (gone: back to the list).
 */
export function missingSelection(
  selId: string | null | undefined,
  present: unknown,
  pending: { id: string; until: number } | null | undefined,
  now = Date.now()
): 'keep' | 'clear' | { wait: number } {
  if (!selId || present) return 'keep';
  if (pending?.id === selId && pending.until > now) return { wait: pending.until - now };
  return 'clear';
}

/** Toast a save error only when it differs from the last one shown (autosave retries on every pause). */
export function errorGate(): { shouldToast(message: string): boolean; reset(): void; readonly last: string } {
  let last = '';
  return {
    shouldToast(message: string) {
      if (message === last) return false;
      last = message;
      return true;
    },
    reset() {
      last = '';
    },
    get last() {
      return last;
    },
  };
}

/** Names offered as @mentions: PCs (full name and first word), player names. */
export function mentionNames(game: GameView): string[] {
  const out = new Set<string>();
  for (const a of Object.values(game.actors || {})) {
    if (!a || a.type !== 'pc' || !a.name) continue;
    out.add(a.name);
    const first = a.name.split(/\s+/)[0];
    if (first && first.length >= 3) out.add(first);
  }
  for (const u of Object.values(game.users || {})) if (u?.name) out.add(u.name);
  out.add('MJ');
  out.add('GM');
  return [...out];
}

/** A live lock held by someone else, or null. skew = server clock − browser clock (locks carry server timestamps). */
export function foreignLock(game: GameView, page: NotePage | null | undefined, skew = 0): NoteLock | null {
  const l = page?.lock;
  if (!l || l.userId === game.me.id) return null;
  return l.until > Date.now() + skew ? l : null;
}

export const sortPages = (list: NotePage[]): NotePage[] =>
  [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || compare(a.folder || '', b.folder || '') || compare(a.title, b.title));

export function excerpt(body: string | null | undefined, q: string | null | undefined): string {
  const text = String(body || '').replace(/\s+/g, ' ');
  if (!q) return text.slice(0, 90);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 90);
  const from = Math.max(0, i - 30);
  return (from ? '…' : '') + text.slice(from, i + q.length + 50);
}

/** Find a readable, not deleted page by title (case-insensitive), preferring one of the given scope. */
export function findByTitle(pages: NotePage[], title: string | null | undefined, scope?: NotePage['scope']): NotePage | null {
  const key = String(title || '').trim().toLowerCase();
  const hits = pages.filter((p) => !p.deleted && p.title.trim().toLowerCase() === key);
  return hits.find((p) => p.scope === scope) || hits[0] || null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
