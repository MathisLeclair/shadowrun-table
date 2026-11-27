// Where the library lives on the server, and the signed links that let an <iframe> (which cannot send our
// Authorization header) fetch a PDF: ?k=<payload>.<hmac>, payload = { t: tableId, u: userId, s: session tag, c: code, e: expiry (s) }.
// s = sessionTag(token) ties the link to the session that asked for it: logout, kick or GM password change kill it.
// The HMAC key is random and per install, kept in <runtime>/books-sign.key (SR_BOOKS_KEY_FILE) so links survive a
// restart. It is deliberately NOT in the books folder: that folder is copied from the GM's PC to the VPS, and a shared
// key would let a GM of one server sign links valid on the other (same table ids, same 'gm' user id).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RUNTIME_DIR } from '../../store.ts';

/** Content of a signed link key. */
export interface LinkData {
  /** Table id. */
  t: string;
  /** User id. */
  u: string;
  /** Session tag (sessionTag(token)). */
  s: string;
  /** Book code. */
  c: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}
export type LinkCheck = ({ ok: true } & LinkData) | { ok: false; reason: 'missing' | 'bad' | 'expired' };

export const BOOKS_DIR = process.env.SR_BOOKS_DIR ? path.resolve(process.env.SR_BOOKS_DIR) : path.join(RUNTIME_DIR, 'books');
export const LINK_TTL = 86400; // seconds
// Expiries are rounded up to this step: a link stays the SAME URL for a whole day (UTC), valid 24 h to 48 h. A stable URL
// lets the browser's HTTP cache (Cache-Control: private, max-age=86400 + ETag) and the reader's own cache hit; the link
// still dies with its session (logout, kick, GM password change), which is what really bounds it.
const STEP = 86400;

/** File holding the HMAC key (outside the books folder, see above). */
export const keyFile = (): string => (process.env.SR_BOOKS_KEY_FILE ? path.resolve(process.env.SR_BOOKS_KEY_FILE) : path.join(RUNTIME_DIR, 'books-sign.key'));

const keys = new Map<string, Buffer>(); // key file -> Buffer
const legacyChecked = new Set<string>();
function signKey(dir: string | null | undefined): Buffer {
  // A key left in the books folder by an older version may have been copied along with the PDFs: never use it.
  if (dir && !legacyChecked.has(dir)) {
    legacyChecked.add(dir);
    try {
      fs.rmSync(path.join(dir, '.sign-key'), { force: true });
    } catch {}
  }
  const file = keyFile();
  let k = keys.get(file);
  if (k) return k;
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) k = Buffer.from(hex, 'hex');
  } catch {}
  if (!k) {
    k = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, k.toString('hex'), { mode: 0o600 });
    } catch (err) {
      console.error('[books] signing key not saved (links valid until restart)', (err as Error).message);
    }
  }
  keys.set(file, k);
  return k;
}

/** Short tag of a session token (never the token itself: links end up in browser history). */
const tagCache = new Map<string, string>(); // token -> tag (a PDF viewer sends many Range requests)
export function sessionTag(token: unknown): string {
  const key = String(token || '');
  let tag = tagCache.get(key);
  if (!tag) {
    tag = crypto.createHash('sha256').update('sr-books:' + key).digest('base64url').slice(0, 16);
    if (tagCache.size > 5000) tagCache.clear();
    tagCache.set(key, tag);
  }
  return tag;
}

/** True when the user still has the session the link was made for (sessions = a table's state.sessions). */
export function sessionAlive(sessions: Record<string, string> | null | undefined, userId: string, tag: unknown): boolean {
  if (!tag || typeof tag !== 'string') return false;
  for (const [tok, uid] of Object.entries(sessions || {})) if (uid === userId && sessionTag(tok) === tag) return true;
  return false;
}

const b64 = (buf: string | Buffer): string => Buffer.from(buf).toString('base64url');
const mac = (dir: string | null | undefined, payload: string): string => b64(crypto.createHmac('sha256', signKey(dir)).update(payload).digest());

/** Signed key for one book, one session of one user of one table. Returns { k, exp } (exp in seconds since the epoch). */
export function signLink(
  dir: string | null | undefined,
  { tableId, userId, session, code }: { tableId: string; userId: string; session: string; code: string },
  { now = Date.now(), ttl = LINK_TTL }: { now?: number; ttl?: number } = {},
): { k: string; exp: number } {
  const exp = Math.ceil(now / 1000 / STEP) * STEP + ttl;
  const payload = b64(JSON.stringify({ t: tableId, u: userId, s: session, c: code, e: exp }));
  return { k: `${payload}.${mac(dir, payload)}`, exp };
}

/** Low-level signer for tests (any expiry). */
export function signRaw(dir: string | null | undefined, data: unknown): string {
  const payload = b64(JSON.stringify(data));
  return `${payload}.${mac(dir, payload)}`;
}

/** { ok: true, t, u, c, e } or { ok: false, reason: 'missing'|'bad'|'expired' }. */
export function verifyLink(dir: string | null | undefined, k: unknown, { now = Date.now() }: { now?: number } = {}): LinkCheck {
  if (!k || typeof k !== 'string') return { ok: false, reason: 'missing' };
  const [payload, sig] = k.split('.');
  if (!payload || !sig || k.length > 600) return { ok: false, reason: 'bad' };
  const want = Buffer.from(mac(dir, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad' };
  let data: any; // parsed from the (signed) link
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad' };
  }
  if (!data || typeof data.e !== 'number' || data.e * 1000 < now) return { ok: false, reason: 'expired' };
  return { ok: true, ...data };
}
